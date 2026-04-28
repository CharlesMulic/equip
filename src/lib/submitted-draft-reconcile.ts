// Publisher submission state reconciler — pure logic, no I/O.
//
// Closes the publisher loop by reconciling the local `def.submitted*` state
// (written at publish/update time) against authoritative server state from
// `GET /equip/augments/{name}/draft` (PublisherDraftService → PublisherDraftView).
//
// Background: prior to this reconciler, equip-app's `getDraft` returned only
// local-file state. After backend approved/rejected/needs-attention'd a
// submission, equip-app showed stale "pending-review" forever — the bug
// observed 2026-04-28. The fix is server-authority: this reconciler reads the
// server's authoritative view and computes whether to clear or update the
// local `def.submitted*` fields.
//
// Architecture: this is the **single clearer** of `def.submitted*` (the
// reconcileSubmissionState path in equip-app/sidecar/bridge.ts is the only
// site that should write). Originating writes happen in `augmentPublish` and
// `augmentPublishUpdate` (those are the SETTERS); this module is the CLEARER.
// `registry-refresh.ts` is forbidden from touching `def.submitted*`.
//
// No TTL synthesis. No "guess from elapsed time" rules. Server is authoritative.
//
// See operations/initiatives/equip-publisher-submission-loop-closure/ for the
// foundation work.

import type { AugmentDef } from "./augment-defs";

/**
 * Server-derived view of a publisher's submission state. Mirrors the relevant
 * fields of `PublisherDraftResponse` (prior-backend) returned by
 * `GET /equip/augments/{name}/draft`.
 *
 * Only the fields the reconciler actually consumes are typed here — the bridge
 * is responsible for adapting the wire response into this shape.
 */
export interface PublisherDraftView {
  /** Live (approved) version number, if any. Null for first-publish-pending. */
  liveVersion: number | null;
  /** Pending version number, if any. */
  pendingVersion: number | null;
  /**
   * Header-level review status, one of:
   *   "unreviewed" | "pending" | "approved" | "rejected" | "needs-attention".
   * Used as a secondary signal alongside liveVersion/pendingVersion.
   */
  reviewStatus: string | null;
  /**
   * Server-derived publisher submission state, mirrors PublisherDraftResponse's
   * `submittedStatus`. Computed from version-row state on the backend. One of:
   *   "pending-review" | "rejected" | "needs-attention" | null.
   */
  submittedStatusFromServer: "pending-review" | "rejected" | "needs-attention" | null;
  /** Public-safe rejection reason (UPPER_SNAKE for needs-attention, prose for rejected). */
  submittedRejectionReason: string | null;
  /** ISO-8601 submission timestamp. Display-only — never a decision input. */
  submittedAt: string | null;
}

/**
 * Outcome of a reconciliation pass. The bridge applies the result by either
 * clearing local `submitted*` fields (cleared=true) or rewriting them to match
 * the server's terminal state (cleared=false with `nextSubmittedStatus`).
 */
export interface ReconcileResult {
  /** True if local `submitted*` fields should be cleared. */
  cleared: boolean;
  /**
   * Decision tag for telemetry / debugging. Identifies which rule fired.
   *   - "approved" — server has live ≥ submitted version (rule 2)
   *   - "rejected" — server says this submission is rejected (rule 3)
   *   - "superseded" — server has a newer pending than our submission (rule 4)
   *   - "needs-attention" — server flagged needs-attention (rule 5)
   *   - null — no-op (no local submitted state to reconcile, or still pending)
   */
  reason: "approved" | "rejected" | "superseded" | "needs-attention" | null;
  /**
   * If non-null, the bridge should overwrite `def.submittedStatus` with this
   * value (and update `submittedRejectionReason` from `nextRejectionReason`).
   * Used for the rejected and needs-attention cases where local state stays
   * but its terminal classification updates.
   */
  nextSubmittedStatus?: "pending-review" | "rejected" | "needs-attention" | null;
  /** Companion to `nextSubmittedStatus` — the rejection reason to surface. */
  nextRejectionReason?: string | null;
}

/**
 * Parse the version number out of a `submittedRevisionId` of the form
 * `"version:N"`. Returns null if the format is unrecognized — the bridge
 * shouldn't have written a revisionId in any other format, but be defensive.
 */
function parseSubmittedVersion(revisionId: string | undefined): number | null {
  if (!revisionId) return null;
  const m = /^version:(\d+)$/.exec(revisionId);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Apply the reconciler's decision rules. Order-sensitive — each rule is
 * mutually exclusive with the prior ones because of the conditions on
 * version numbers + reviewStatus.
 *
 * **Rules** (matched top-to-bottom):
 *   1. **No-op:** local has no `submittedRevisionId` → nothing to reconcile.
 *   2. **Approved:** `liveVersion >= submittedVersion` AND `reviewStatus !== "rejected"`
 *      → server has approved this submission (or a later one); clear local.
 *   3. **Rejected:** `pendingVersion === submittedVersion` AND `reviewStatus === "rejected"`
 *      → server rejected this submission; keep local (publisher can revise),
 *      surface the rejection reason.
 *   4. **Superseded:** `pendingVersion > submittedVersion` → publisher republished
 *      from another machine, our submission is now orphaned; clear local.
 *   5. **Needs-attention:** `submittedStatusFromServer === "needs-attention"`
 *      → terminal review failure on our side; keep local (publisher can retry),
 *      surface the reason.
 *
 * Otherwise (still under review): no-op. The polling loop will re-call.
 *
 * **No TTL synthesis.** Option B's worker contract guarantees that every
 * terminal job outcome produces an observable server-side state change. If
 * the server says "still pending", we trust it.
 */
export function reconcileSubmittedDraftState(
  def: AugmentDef,
  view: PublisherDraftView,
): ReconcileResult {
  // Rule 1: nothing to reconcile.
  const submittedVersion = parseSubmittedVersion(def.submittedRevisionId);
  if (def.submittedRevisionId === undefined || submittedVersion === null) {
    return { cleared: false, reason: null };
  }

  // Rule 2: approved (server has caught up to our submission, and didn't reject it).
  if (
    view.liveVersion !== null &&
    view.liveVersion >= submittedVersion &&
    view.reviewStatus !== "rejected"
  ) {
    return { cleared: true, reason: "approved", nextSubmittedStatus: null, nextRejectionReason: null };
  }

  // Rule 3: rejected — same version we submitted is now rejected on the server.
  if (
    view.pendingVersion === submittedVersion &&
    view.reviewStatus === "rejected"
  ) {
    return {
      cleared: false,
      reason: "rejected",
      nextSubmittedStatus: "rejected",
      nextRejectionReason: view.submittedRejectionReason,
    };
  }

  // Rule 4: superseded — publisher republished from another machine; our local
  // submission no longer matches what the server thinks is current.
  if (view.pendingVersion !== null && view.pendingVersion > submittedVersion) {
    return { cleared: true, reason: "superseded", nextSubmittedStatus: null, nextRejectionReason: null };
  }

  // Rule 5: needs-attention — Option B's terminal failure state. Keep local
  // submission state but flip the local status; the publisher can retry.
  if (view.submittedStatusFromServer === "needs-attention") {
    return {
      cleared: false,
      reason: "needs-attention",
      nextSubmittedStatus: "needs-attention",
      nextRejectionReason: view.submittedRejectionReason,
    };
  }

  // Otherwise: still under review. Polling loop will re-call.
  return { cleared: false, reason: null };
}
