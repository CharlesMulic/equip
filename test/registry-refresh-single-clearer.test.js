// Single-clearer assertion: registry-refresh.ts is forbidden from touching
// `def.submitted*` fields. Those fields are owned by the publisher loop:
//   - SETTERS: equip-app/sidecar/bridge.ts publish/publishUpdate handlers.
//   - CLEARER: equip-app/sidecar/bridge.ts reconcileSubmissionState (which
//     calls clearSubmittedDraftState and writeSubmittedDraftState here).
//
// If a future change to registry-refresh.ts ever mutates a `submitted*` field,
// the publisher loop bug class returns in a new shape — the registry refresh
// path could clobber a fresh pending submission with stale state. This test
// pins the rule by running refreshAugmentFromRegistry on a def with
// `submitted*` populated and asserting those fields are byte-identical after.
//
// Added by publisher-loop-foundation 2026-04-28.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { refreshAugmentFromRegistry } from "../dist/lib/registry-refresh.js";
import { writeAugmentDef, readAugmentDef } from "../dist/lib/augment-defs.js";
import { writeInstallations } from "../dist/lib/installations.js";

// Set up isolated EQUIP_HOME per test run (mirrors the convention used in
// other equip tests post-ENG-0031 — see equip/CLAUDE.md).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-single-clearer-"));
process.env.EQUIP_HOME = tmpHome;

test("refreshAugmentFromRegistry does not mutate def.submitted* fields", async () => {
  // Setup: a registry-source augment with submitted* fields populated (the
  // shape the bridge writes on publish/publishUpdate when reviewStatus=pending).
  const submittedAt = "2026-04-28T10:00:00.000Z";
  const def = {
    name: "single-clearer-fixture",
    source: "registry",
    title: "Fixture",
    description: "Test fixture for the single-clearer rule.",
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-28T10:00:00.000Z",
    registryStatus: "pending-review", // non-public — refresh skips network
    registryContentHash: "hash-fixture-v1",
    registryVersionNumber: 1,
    publishedVersion: 1,
    workingDraftEdit: { description: "local edits in flight" },
    submittedEdit: { description: "what was submitted" },
    submittedRevisionId: "version:1",
    submittedStatus: "pending-review",
    submittedRejectionReason: undefined,
    submittedAt,
  };
  writeAugmentDef(def);
  writeInstallations({ version: 1, augments: {}, lastUpdated: new Date().toISOString() });

  // Snapshot the submitted* fields before refresh.
  const before = readAugmentDef("single-clearer-fixture");
  assert.equal(before.submittedRevisionId, "version:1");
  assert.equal(before.submittedStatus, "pending-review");
  assert.equal(before.submittedAt, submittedAt);

  // Refresh against the registry. The non-public registryStatus short-circuits
  // the network call but the function still walks the def — and that walk must
  // not mutate any submitted* field.
  const result = await refreshAugmentFromRegistry("single-clearer-fixture");
  assert.equal(result.status, "skipped"); // confirms we hit the non-public branch

  const after = readAugmentDef("single-clearer-fixture");
  assert.equal(after.submittedRevisionId, before.submittedRevisionId, "submittedRevisionId must be unchanged");
  assert.equal(after.submittedStatus, before.submittedStatus, "submittedStatus must be unchanged");
  assert.equal(after.submittedRejectionReason, before.submittedRejectionReason, "submittedRejectionReason must be unchanged");
  assert.equal(after.submittedAt, before.submittedAt, "submittedAt must be unchanged");
  assert.deepEqual(after.submittedEdit, before.submittedEdit, "submittedEdit must be unchanged");
  assert.deepEqual(after.workingDraftEdit, before.workingDraftEdit, "workingDraftEdit must be unchanged");
});
