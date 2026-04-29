// discard-pre-cleanup-b-backup tests — companion to restorePreCleanupB.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let discardMod;
let migrateMod;

async function freshHome(prefix = "discard-test-") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.EQUIP_HOME = tmp;
  if (!discardMod) discardMod = await import("../dist/lib/commands/discard-pre-cleanup-b-backup.js");
  if (!migrateMod) migrateMod = await import("../dist/lib/migrate-storage.js");
  return tmp;
}

function writeLegacyAugment(home, name, def) {
  const dir = path.join(home, "augments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(def, null, 2), "utf-8");
}

test("discardPreCleanupBBackup with no snapshot returns no-snapshot status", async () => {
  await freshHome();
  const result = discardMod.discardPreCleanupBBackup();
  assert.equal(result.status, "no-snapshot");
  assert.equal(result.bytesFreed, 0);
  assert.equal(result.backupPath, null);
});

test("discardPreCleanupBBackup without --force runs as dry-run + leaves snapshot intact", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "dry-aug", { name: "dry-aug", source: "local", title: "x", description: "x",
    requiresAuth: false, skills: [], baseWeight: 0, loadedWeight: 0, modded: false,
    createdAt: "x", updatedAt: "x" });
  migrateMod.cleanupBLegacyFiles();
  const backupDir = path.join(home, ".backup-pre-cleanup-b");
  assert.equal(fs.existsSync(backupDir), true);

  const result = discardMod.discardPreCleanupBBackup();
  assert.equal(result.status, "dry-run");
  assert.match(result.message, /Would delete/);
  assert.match(result.message, /--force/);
  assert.equal(result.bytesFreed > 0, true, "dry-run reports the size that would be freed");

  // Snapshot still exists.
  assert.equal(fs.existsSync(backupDir), true);
});

test("discardPreCleanupBBackup with --force deletes the snapshot", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "force-aug", { name: "force-aug", source: "local", title: "x", description: "x",
    requiresAuth: false, skills: [], baseWeight: 0, loadedWeight: 0, modded: false,
    createdAt: "x", updatedAt: "x" });
  migrateMod.cleanupBLegacyFiles();
  const backupDir = path.join(home, ".backup-pre-cleanup-b");

  const result = discardMod.discardPreCleanupBBackup({ force: true });
  assert.equal(result.status, "complete");
  assert.equal(result.bytesFreed > 0, true);
  assert.match(result.message, /Deleted/);

  // Snapshot is gone.
  assert.equal(fs.existsSync(backupDir), false);
});

test("discardPreCleanupBBackup is idempotent — second --force run on already-deleted snapshot returns no-snapshot", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "twice", { name: "twice", source: "local", title: "x", description: "x",
    requiresAuth: false, skills: [], baseWeight: 0, loadedWeight: 0, modded: false,
    createdAt: "x", updatedAt: "x" });
  migrateMod.cleanupBLegacyFiles();

  const first = discardMod.discardPreCleanupBBackup({ force: true });
  assert.equal(first.status, "complete");

  const second = discardMod.discardPreCleanupBBackup({ force: true });
  assert.equal(second.status, "no-snapshot");
});

test("discardPreCleanupBBackup does NOT touch ~/.equip/augments/ or ~/.equip/installations.json", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "preserved", { name: "preserved", source: "local", title: "x", description: "x",
    requiresAuth: false, skills: [], baseWeight: 0, loadedWeight: 0, modded: false,
    createdAt: "x", updatedAt: "x" });
  migrateMod.cleanupBLegacyFiles();

  // Now restore them so they exist alongside the snapshot.
  const restoreMod = await import("../dist/lib/commands/restore-pre-cleanup-b.js");
  restoreMod.restorePreCleanupB();
  assert.equal(fs.existsSync(path.join(home, "augments", "preserved.json")), true);

  // Discard the snapshot — augments/ should survive.
  const result = discardMod.discardPreCleanupBBackup({ force: true });
  assert.equal(result.status, "complete");
  assert.equal(fs.existsSync(path.join(home, "augments", "preserved.json")), true,
    "discarding the backup must NOT touch the live augments/ directory");
});

test("discardPreCleanupBBackup tallies multi-file snapshot size correctly", async () => {
  const home = await freshHome();
  // Write a few legacy augments so the snapshot has multiple files.
  for (const name of ["a", "b", "c"]) {
    writeLegacyAugment(home, name, { name, source: "local", title: name, description: name,
      requiresAuth: false, skills: [], baseWeight: 0, loadedWeight: 0, modded: false,
      createdAt: "x", updatedAt: "x" });
  }
  migrateMod.cleanupBLegacyFiles();

  // Compute expected bytes from the snapshot directly.
  const backupAugmentsDir = path.join(home, ".backup-pre-cleanup-b", "augments");
  const expected = fs.readdirSync(backupAugmentsDir)
    .reduce((acc, f) => acc + fs.statSync(path.join(backupAugmentsDir, f)).size, 0);

  const result = discardMod.discardPreCleanupBBackup({ force: true });
  assert.equal(result.status, "complete");
  assert.equal(result.bytesFreed, expected, "bytesFreed must match summed snapshot file sizes");
});
