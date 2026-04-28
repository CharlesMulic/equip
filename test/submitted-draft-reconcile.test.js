import { test } from "node:test";
import { strict as assert } from "node:assert";
import { reconcileSubmittedDraftState } from "../dist/lib/submitted-draft-reconcile.js";

// Test fixtures: construct minimal AugmentDef shapes (only the fields the
// reconciler actually reads). Cast to satisfy the dist .d.ts shape — the
// reconciler is pure logic over a narrow read surface.

function defWithSubmission(version, overrides = {}) {
  return {
    name: "test-augment",
    source: "registry",
    title: "Test",
    description: "Test",
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    createdAt: "2026-04-28T00:00:00Z",
    updatedAt: "2026-04-28T00:00:00Z",
    submittedRevisionId: `version:${version}`,
    submittedStatus: "pending-review",
    ...overrides,
  };
}

function defWithoutSubmission() {
  return {
    name: "test-augment",
    source: "registry",
    title: "Test",
    description: "Test",
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    createdAt: "2026-04-28T00:00:00Z",
    updatedAt: "2026-04-28T00:00:00Z",
  };
}

function view(overrides = {}) {
  return {
    liveVersion: null,
    pendingVersion: null,
    reviewStatus: null,
    submittedStatusFromServer: null,
    submittedRejectionReason: null,
    submittedAt: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Rule 1: no-op when local has no submission
// ─────────────────────────────────────────────────────────────────────

test("rule 1: no-op when def has no submittedRevisionId", () => {
  const result = reconcileSubmittedDraftState(
    defWithoutSubmission(),
    view({ liveVersion: 5, reviewStatus: "approved" }),
  );
  assert.deepEqual(result, { cleared: false, reason: null });
});

test("rule 1: no-op when submittedRevisionId is malformed", () => {
  const def = defWithSubmission(1);
  def.submittedRevisionId = "garbage-not-a-version";
  const result = reconcileSubmittedDraftState(
    def,
    view({ liveVersion: 5, reviewStatus: "approved" }),
  );
  assert.deepEqual(result, { cleared: false, reason: null });
});

// ─────────────────────────────────────────────────────────────────────
// Rule 2: approved — server live >= submitted
// ─────────────────────────────────────────────────────────────────────

test("rule 2: cleared when liveVersion equals submittedVersion (first publish approved)", () => {
  const result = reconcileSubmittedDraftState(
    defWithSubmission(1),
    view({ liveVersion: 1, pendingVersion: null, reviewStatus: "approved" }),
  );
  assert.equal(result.cleared, true);
  assert.equal(result.reason, "approved");
});

test("rule 2: cleared when liveVersion exceeds submittedVersion (older submission)", () => {
  const result = reconcileSubmittedDraftState(
    defWithSubmission(2),
    view({ liveVersion: 5, pendingVersion: null, reviewStatus: "approved" }),
  );
  assert.equal(result.cleared, true);
  assert.equal(result.reason, "approved");
});

test("rule 2: NOT triggered when liveVersion >= submitted but reviewStatus is rejected", () => {
  // Defensive: if the live version exists but the augment is currently in
  // a rejected state somehow, prefer rule 3 over rule 2 to surface the rejection.
  const result = reconcileSubmittedDraftState(
    defWithSubmission(1),
    view({ liveVersion: 1, pendingVersion: 1, reviewStatus: "rejected" }),
  );
  assert.notEqual(result.reason, "approved");
});

// ─────────────────────────────────────────────────────────────────────
// Rule 3: rejected — same version submitted, server says rejected
// ─────────────────────────────────────────────────────────────────────

test("rule 3: rejected — keeps local state, surfaces rejection reason", () => {
  const result = reconcileSubmittedDraftState(
    defWithSubmission(1),
    view({
      liveVersion: null,
      pendingVersion: 1,
      reviewStatus: "rejected",
      submittedRejectionReason: "Content unsafe",
    }),
  );
  assert.equal(result.cleared, false);
  assert.equal(result.reason, "rejected");
  assert.equal(result.nextSubmittedStatus, "rejected");
  assert.equal(result.nextRejectionReason, "Content unsafe");
});

// ─────────────────────────────────────────────────────────────────────
// Rule 4: superseded — server has newer pending than ours
// ─────────────────────────────────────────────────────────────────────

test("rule 4: superseded when pendingVersion > submittedVersion (multi-machine republish)", () => {
  const result = reconcileSubmittedDraftState(
    defWithSubmission(2),
    view({ liveVersion: 1, pendingVersion: 3, reviewStatus: "pending" }),
  );
  assert.equal(result.cleared, true);
  assert.equal(result.reason, "superseded");
});

// ─────────────────────────────────────────────────────────────────────
// Rule 5: needs-attention — Option B terminal failure
// ─────────────────────────────────────────────────────────────────────

test("rule 5: needs-attention — keeps local state, surfaces reason", () => {
  const result = reconcileSubmittedDraftState(
    defWithSubmission(2),
    view({
      liveVersion: 1,
      pendingVersion: 2,
      reviewStatus: "needs-attention",
      submittedStatusFromServer: "needs-attention",
      submittedRejectionReason: "JOB_EXHAUSTED",
    }),
  );
  assert.equal(result.cleared, false);
  assert.equal(result.reason, "needs-attention");
  assert.equal(result.nextSubmittedStatus, "needs-attention");
  assert.equal(result.nextRejectionReason, "JOB_EXHAUSTED");
});

// ─────────────────────────────────────────────────────────────────────
// Edge: still under review — no-op
// ─────────────────────────────────────────────────────────────────────

test("no-op when server says still pending and versions match", () => {
  const result = reconcileSubmittedDraftState(
    defWithSubmission(2),
    view({
      liveVersion: 1,
      pendingVersion: 2,
      reviewStatus: "pending",
      submittedStatusFromServer: "pending-review",
    }),
  );
  assert.equal(result.cleared, false);
  assert.equal(result.reason, null);
});

// ─────────────────────────────────────────────────────────────────────
// Edge: rule precedence
// ─────────────────────────────────────────────────────────────────────

test("rule precedence: approved beats needs-attention when live version exists", () => {
  // If a publisher's submission was approved AND a later submission is in
  // needs-attention, the approved rule fires first (by precedence) — local
  // submission state is cleared because their version is live.
  const result = reconcileSubmittedDraftState(
    defWithSubmission(1),
    view({
      liveVersion: 1,
      pendingVersion: 2,
      reviewStatus: "needs-attention",
      submittedStatusFromServer: "needs-attention",
    }),
  );
  assert.equal(result.cleared, true);
  assert.equal(result.reason, "approved");
});

test("rule precedence: superseded beats needs-attention for newer pending", () => {
  const result = reconcileSubmittedDraftState(
    defWithSubmission(2),
    view({
      liveVersion: null,
      pendingVersion: 3,
      reviewStatus: "needs-attention",
      submittedStatusFromServer: "needs-attention",
    }),
  );
  assert.equal(result.cleared, true);
  assert.equal(result.reason, "superseded");
});

// ─────────────────────────────────────────────────────────────────────
// Schema evolution: pre-revision local def loads cleanly
// ─────────────────────────────────────────────────────────────────────

test("schema evolution: def written before submittedAt existed reconciles cleanly", () => {
  // Synthetic pre-Option-B local def — has submittedRevisionId/Status but no
  // submittedAt. Reconciler must not throw or produce a different decision.
  const def = defWithSubmission(1);
  delete def.submittedAt; // not defined on this fixture by default; explicit
  const result = reconcileSubmittedDraftState(
    def,
    view({ liveVersion: 1, reviewStatus: "approved" }),
  );
  assert.equal(result.cleared, true);
  assert.equal(result.reason, "approved");
});

test("schema evolution: server submittedAt missing is tolerated (display-only)", () => {
  // Server response lacks submittedAt (older backend or new endpoint not yet
  // wired). Reconciler doesn't depend on it for decisions.
  const result = reconcileSubmittedDraftState(
    defWithSubmission(2),
    view({
      liveVersion: 1,
      pendingVersion: 2,
      reviewStatus: "pending",
      submittedAt: null,
    }),
  );
  assert.equal(result.cleared, false);
  assert.equal(result.reason, null);
});
