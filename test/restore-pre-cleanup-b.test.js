// restore-pre-cleanup-b tests — symmetric inverse of cleanupBLegacyFiles.
//
// Round-trip pattern: write legacy → cleanupBLegacyFiles → restorePreCleanupB
// → verify state matches original. This is the load-bearing safety net for
// the schema-v4 cutover (Pkg 06 batch 2).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let restoreMod;
let migrateMod;

async function freshHome(prefix = "restore-test-") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.EQUIP_HOME = tmp;
  if (!restoreMod) restoreMod = await import("../dist/lib/commands/restore-pre-cleanup-b.js");
  if (!migrateMod) migrateMod = await import("../dist/lib/migrate-storage.js");
  return tmp;
}

function writeLegacyAugment(home, name, def) {
  const dir = path.join(home, "augments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(def, null, 2), "utf-8");
}

function writeLegacyInstallations(home, installs) {
  fs.writeFileSync(path.join(home, "installations.json"), JSON.stringify(installs, null, 2), "utf-8");
}

test("restorePreCleanupB on missing snapshot returns no-snapshot status", async () => {
  await freshHome();
  const result = restoreMod.restorePreCleanupB();
  assert.equal(result.status, "no-snapshot");
  assert.equal(result.augmentsRestored, 0);
  assert.equal(result.installationsRestored, false);
  assert.equal(result.backupPath, null);
  assert.match(result.message, /No snapshot found/);
});

test("restorePreCleanupB completes the symmetric round-trip — legacy state recovered byte-for-byte", async () => {
  const home = await freshHome();
  // Write rich legacy state.
  const aug1 = { name: "rt-aug1", source: "local", title: "Round Trip 1", description: "x",
    requiresAuth: false, skills: [], baseWeight: 0, loadedWeight: 0, modded: false,
    createdAt: "2026-04-29T00:00:00.000Z", updatedAt: "2026-04-29T00:00:00.000Z" };
  const aug2 = { name: "rt-aug2", source: "registry", title: "Round Trip 2", description: "y",
    requiresAuth: true, skills: [], baseWeight: 1, loadedWeight: 2, modded: false,
    transport: "http", serverUrl: "https://x.example/y", registryContentHash: "h2", registryVersionNumber: 5,
    registryStatus: "active", lastValidatedAt: "2026-04-29T00:00:00.000Z",
    createdAt: "2026-04-29T00:00:00.000Z", updatedAt: "2026-04-29T00:00:00.000Z" };
  const installs = { lastUpdated: "2026-04-29T10:00:00.000Z",
    augments: { "rt-aug1": { source: "local", title: "Round Trip 1", transport: "http",
      installedAt: "2026-04-28T00:00:00.000Z", updatedAt: "2026-04-29T00:00:00.000Z",
      platforms: ["claude-code"], artifacts: { "claude-code": { mcp: true, installMode: "broker" } } } } };
  writeLegacyAugment(home, "rt-aug1", aug1);
  writeLegacyAugment(home, "rt-aug2", aug2);
  writeLegacyInstallations(home, installs);

  // Capture original bytes for byte-for-byte comparison after round-trip.
  const aug1Bytes = fs.readFileSync(path.join(home, "augments", "rt-aug1.json"));
  const aug2Bytes = fs.readFileSync(path.join(home, "augments", "rt-aug2.json"));
  const instBytes = fs.readFileSync(path.join(home, "installations.json"));

  // cleanup → restore.
  const cleanupResult = migrateMod.cleanupBLegacyFiles();
  assert.equal(cleanupResult.status, "complete");
  assert.equal(fs.existsSync(path.join(home, "augments")), false);
  assert.equal(fs.existsSync(path.join(home, "installations.json")), false);

  const restoreResult = restoreMod.restorePreCleanupB();
  assert.equal(restoreResult.status, "complete");
  assert.equal(restoreResult.augmentsRestored, 2);
  assert.equal(restoreResult.installationsRestored, true);

  // Byte-for-byte equality check.
  assert.equal(fs.readFileSync(path.join(home, "augments", "rt-aug1.json")).equals(aug1Bytes), true,
    "round-trip restore must produce byte-identical aug1");
  assert.equal(fs.readFileSync(path.join(home, "augments", "rt-aug2.json")).equals(aug2Bytes), true,
    "round-trip restore must produce byte-identical aug2");
  assert.equal(fs.readFileSync(path.join(home, "installations.json")).equals(instBytes), true,
    "round-trip restore must produce byte-identical installations.json");

  // Schema marker reset to 3 — fresh sidecar will resume dual-write.
  assert.equal(fs.readFileSync(path.join(home, ".schema_version"), "utf-8").trim(), "3");
});

test("restorePreCleanupB aborts WITHOUT writing when augments/ already exists (default conflict policy)", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "conflict-aug", { name: "conflict-aug", source: "local", title: "x", description: "x",
    requiresAuth: false, skills: [], baseWeight: 0, loadedWeight: 0, modded: false,
    createdAt: "x", updatedAt: "x" });

  // Cleanup + then re-create a new augments dir to simulate state where
  // user has done some work since the cleanup ran.
  migrateMod.cleanupBLegacyFiles();
  fs.mkdirSync(path.join(home, "augments"), { recursive: true });
  fs.writeFileSync(path.join(home, "augments", "post-cleanup-work.json"), '{"name":"post-cleanup-work"}', "utf-8");

  const result = restoreMod.restorePreCleanupB();
  assert.equal(result.status, "conflict-augments");
  assert.equal(result.augmentsRestored, 0);
  assert.match(result.message, /already exists/);

  // The user's post-cleanup work survives untouched.
  assert.equal(fs.existsSync(path.join(home, "augments", "post-cleanup-work.json")), true);
  assert.equal(fs.existsSync(path.join(home, "augments", "conflict-aug.json")), false,
    "conflict-aborted restore must NOT have written any backup files");
});

test("restorePreCleanupB --force overrides conflict policy + clobbers existing state", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "forced-aug", { name: "forced-aug", source: "local", title: "x", description: "x",
    requiresAuth: false, skills: [], baseWeight: 0, loadedWeight: 0, modded: false,
    createdAt: "x", updatedAt: "x" });

  migrateMod.cleanupBLegacyFiles();
  fs.mkdirSync(path.join(home, "augments"), { recursive: true });
  fs.writeFileSync(path.join(home, "augments", "to-be-clobbered.json"), '{"name":"to-be-clobbered"}', "utf-8");

  const result = restoreMod.restorePreCleanupB({ force: true });
  assert.equal(result.status, "complete");
  assert.equal(result.augmentsRestored, 1);

  // Backup contents present, post-cleanup work gone.
  assert.equal(fs.existsSync(path.join(home, "augments", "forced-aug.json")), true);
  assert.equal(fs.existsSync(path.join(home, "augments", "to-be-clobbered.json")), false,
    "--force restore overwrites the augments/ directory entirely");
});

test("restorePreCleanupB aborts on installations.json conflict separately from augments/", async () => {
  const home = await freshHome();
  writeLegacyInstallations(home, { lastUpdated: "x", augments: {} });

  migrateMod.cleanupBLegacyFiles();
  fs.writeFileSync(path.join(home, "installations.json"), '{"lastUpdated":"new","augments":{}}', "utf-8");

  const result = restoreMod.restorePreCleanupB();
  assert.equal(result.status, "conflict-installations");
  assert.match(result.message, /installations\.json/);
});

test("restorePreCleanupB leaves the .backup-pre-cleanup-b/ snapshot in place after restore", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "preserved-snapshot", { name: "preserved-snapshot", source: "local", title: "x", description: "x",
    requiresAuth: false, skills: [], baseWeight: 0, loadedWeight: 0, modded: false,
    createdAt: "x", updatedAt: "x" });

  migrateMod.cleanupBLegacyFiles();
  restoreMod.restorePreCleanupB();

  // Snapshot dir + backup contents survive — user can re-restore later if needed.
  assert.equal(fs.existsSync(path.join(home, ".backup-pre-cleanup-b")), true);
  assert.equal(fs.existsSync(path.join(home, ".backup-pre-cleanup-b", "augments", "preserved-snapshot.json")), true);
});

test("restorePreCleanupB handles partial snapshots — augments-only", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "augments-only", { name: "augments-only", source: "local", title: "x", description: "x",
    requiresAuth: false, skills: [], baseWeight: 0, loadedWeight: 0, modded: false,
    createdAt: "x", updatedAt: "x" });
  // No installations.json.

  migrateMod.cleanupBLegacyFiles();
  const result = restoreMod.restorePreCleanupB();
  assert.equal(result.status, "complete");
  assert.equal(result.augmentsRestored, 1);
  assert.equal(result.installationsRestored, false);
});

test("restorePreCleanupB handles partial snapshots — installations-only", async () => {
  const home = await freshHome();
  writeLegacyInstallations(home, { lastUpdated: "x", augments: {} });

  migrateMod.cleanupBLegacyFiles();
  const result = restoreMod.restorePreCleanupB();
  assert.equal(result.status, "complete");
  assert.equal(result.augmentsRestored, 0);
  assert.equal(result.installationsRestored, true);
});

test("restorePreCleanupB followed by cleanupBLegacyFiles round-trips multiple times", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "cycle-aug", { name: "cycle-aug", source: "local", title: "x", description: "x",
    requiresAuth: false, skills: [], baseWeight: 0, loadedWeight: 0, modded: false,
    createdAt: "x", updatedAt: "x" });

  // Three full cycles. Each cycle: cleanup → assert gone → restore → assert back.
  for (let i = 0; i < 3; i++) {
    const cleanup = migrateMod.cleanupBLegacyFiles({ force: true });
    assert.equal(cleanup.status, "complete", `cycle ${i}: cleanup must complete`);
    assert.equal(fs.existsSync(path.join(home, "augments", "cycle-aug.json")), false, `cycle ${i}: legacy gone after cleanup`);

    const restore = restoreMod.restorePreCleanupB();
    assert.equal(restore.status, "complete", `cycle ${i}: restore must complete`);
    assert.equal(fs.existsSync(path.join(home, "augments", "cycle-aug.json")), true, `cycle ${i}: legacy back after restore`);
  }
});
