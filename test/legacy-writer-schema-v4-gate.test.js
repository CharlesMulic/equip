// Defensive schema-v4 gate on the legacy writers (architect condition 2b).
//
// Pre-cutover (`.schema_version` < 4): legacy writers behave normally —
// write the file, mirror to new stores.
//
// Post-cutover (`.schema_version` >= 4): legacy writers REFUSE to write.
// Logs a warning. Delete operations still mirror to new stores so legacy
// callers don't leave orphan defs/cache entries.
//
// **Why this exists** (per architect condition 2b, 2026-04-29): an old
// equip-app sidecar binary (with the legacy modules still active) running
// concurrently with a new CLI that ran `cleanupBLegacyFiles` would
// recreate the deleted legacy files via dual-write. Until the sidecar
// restarts and runs the v4 migration, the user-visible state is split —
// new stores authoritative for reads, legacy files re-emerged for writes.
// This gate prevents the recreation. Disappears entirely when Pkg 06
// batch 2 deletes the legacy modules.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let augmentDefsMod;
let installationsMod;
let defsStoreMod;
let installsStoreMod;
let migrationTriggerMod;

async function freshHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v4-gate-"));
  process.env.EQUIP_HOME = tmp;
  if (!augmentDefsMod) augmentDefsMod = await import("../dist/lib/augment-defs.js");
  if (!installationsMod) installationsMod = await import("../dist/lib/installations.js");
  if (!defsStoreMod) defsStoreMod = await import("../dist/lib/defs-store.js");
  if (!installsStoreMod) installsStoreMod = await import("../dist/lib/installs-store.js");
  if (!migrationTriggerMod) migrationTriggerMod = await import("../dist/lib/migration-trigger.js");
  migrationTriggerMod._resetMigrationTriggerForTests();
  return tmp;
}

function localFixture(name) {
  return {
    name,
    source: "local",
    title: name,
    description: "v4-gate-test",
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    createdAt: "2026-04-29T00:00:00.000Z",
    updatedAt: "2026-04-29T00:00:00.000Z",
  };
}

function captureWarn() {
  const calls = [];
  const original = console.warn;
  console.warn = (...args) => calls.push(args.map(String).join(" "));
  return {
    calls,
    restore() { console.warn = original; },
  };
}

test("writeAugmentDef pre-v4 (schema_version=3): writes normally + mirrors to defs/", async () => {
  const home = await freshHome();
  // Default schema_version is 1; writeAugmentDef triggers migration → 3.
  augmentDefsMod.writeAugmentDef(localFixture("pre-v4"));

  // Legacy file written.
  assert.equal(fs.existsSync(path.join(home, "augments", "pre-v4.json")), true);
  // New store mirrored.
  assert.equal(defsStoreMod.readDef("pre-v4")?.kind, "local");
});

test("writeAugmentDef post-v4 (schema_version=4): refuses write + logs warn + does NOT mirror", async () => {
  const home = await freshHome();
  // Manually advance schema marker to v4 — simulates post-Cleanup-B state.
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, ".schema_version"), "4", "utf-8");

  const warn = captureWarn();
  try {
    augmentDefsMod.writeAugmentDef(localFixture("post-v4"));
  } finally {
    warn.restore();
  }

  // Legacy file NOT written.
  assert.equal(fs.existsSync(path.join(home, "augments", "post-v4.json")), false);
  // New store NOT mirrored either (the entire write is refused).
  assert.equal(defsStoreMod.readDef("post-v4"), null);
  // Warning emitted with the augment name + reason.
  assert.equal(warn.calls.length, 1);
  assert.match(warn.calls[0], /writeAugmentDef\("post-v4"\)/);
  assert.match(warn.calls[0], /schema_version >= 4/);
  assert.match(warn.calls[0], /post-Cleanup-B/);
});

test("deleteAugmentDef post-v4: returns false (no legacy file to delete) + still mirrors deletion to new stores", async () => {
  const home = await freshHome();
  // Pre-populate: write at v3, then advance schema to v4.
  augmentDefsMod.writeAugmentDef(localFixture("delete-post-v4"));
  assert.equal(defsStoreMod.readDef("delete-post-v4")?.kind, "local");
  fs.writeFileSync(path.join(home, ".schema_version"), "4", "utf-8");

  const result = augmentDefsMod.deleteAugmentDef("delete-post-v4");
  assert.equal(result, false, "post-v4 delete returns false (no legacy file to remove)");

  // New store deletion DID fire — caller intent honored.
  assert.equal(defsStoreMod.readDef("delete-post-v4"), null,
    "deleteAugmentDef post-v4 still mirrors deletion to new stores so callers don't leave orphans");
});

test("writeInstallations post-v4: refuses write + logs warn + still mirrors per-augment to installs/", async () => {
  const home = await freshHome();
  // Pre-populate: write a baseline installations.json at v3 (so the file exists),
  // then advance schema to v4 + try to write again.
  installationsMod.writeInstallations({
    lastUpdated: "2026-04-29T00:00:00.000Z",
    augments: {},
  });
  assert.equal(fs.existsSync(path.join(home, "installations.json")), true);

  fs.writeFileSync(path.join(home, ".schema_version"), "4", "utf-8");

  const warn = captureWarn();
  try {
    installationsMod.writeInstallations({
      lastUpdated: "2026-04-29T00:00:00.001Z",
      augments: {
        "post-v4-install": {
          source: "local",
          title: "post-v4-install",
          transport: "http",
          installedAt: "2026-04-29T00:00:00.000Z",
          updatedAt: "2026-04-29T00:00:00.000Z",
          platforms: [],
          artifacts: {},
        },
      },
    });
  } finally {
    warn.restore();
  }

  // Warn emitted.
  assert.equal(warn.calls.length, 1);
  assert.match(warn.calls[0], /writeInstallations/);
  assert.match(warn.calls[0], /schema_version >= 4/);

  // Legacy installations.json NOT updated — still has the v3-era empty content.
  const raw = JSON.parse(fs.readFileSync(path.join(home, "installations.json"), "utf-8"));
  assert.deepEqual(raw.augments, {}, "legacy installations.json untouched by post-v4 write");

  // BUT the new installs/ store DID get the per-augment mirror — caller intent honored.
  assert.equal(installsStoreMod.readInstall("post-v4-install")?.platforms.length, 0,
    "writeInstallations post-v4 still mirrors per-augment to installs/ so callers don't lose updates");
});

test("gate is reactive to schema_version changes (no caching across calls)", async () => {
  const home = await freshHome();
  // First write at v3 succeeds.
  augmentDefsMod.writeAugmentDef(localFixture("first-v3"));
  assert.equal(fs.existsSync(path.join(home, "augments", "first-v3.json")), true);

  // Advance to v4.
  fs.writeFileSync(path.join(home, ".schema_version"), "4", "utf-8");

  // Second write same process — refused.
  const warn = captureWarn();
  try {
    augmentDefsMod.writeAugmentDef(localFixture("second-v4"));
  } finally {
    warn.restore();
  }
  assert.equal(fs.existsSync(path.join(home, "augments", "second-v4.json")), false);

  // Drop schema back to v3 (simulates `equip --restore-pre-cleanup-b`).
  fs.writeFileSync(path.join(home, ".schema_version"), "3", "utf-8");

  // Third write succeeds — gate is reactive, not cached.
  augmentDefsMod.writeAugmentDef(localFixture("third-v3-again"));
  assert.equal(fs.existsSync(path.join(home, "augments", "third-v3-again.json")), true,
    "gate re-evaluates schema version on each call — restore CLI reactivates legacy writes");
});

test("gate is symmetric: schema_version=5 (hypothetical future cutover) also refuses", async () => {
  const home = await freshHome();
  fs.writeFileSync(path.join(home, ".schema_version"), "5", "utf-8");

  const warn = captureWarn();
  try {
    augmentDefsMod.writeAugmentDef(localFixture("future-v5"));
  } finally {
    warn.restore();
  }
  assert.equal(fs.existsSync(path.join(home, "augments", "future-v5.json")), false);
  assert.equal(warn.calls.length, 1);
});
