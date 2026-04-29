// Tests for storage/migrate-from-legacy.ts — the one-shot disk migration
// from any prior on-disk format into the journal-canonical layout.
//
// Three scenarios mapped to test files (by-test-case in this single file
// because the migration helper is one entry point):
//   1. Pre-storage-refactor format (legacy ~/.equip/augments/ + installations.json)
//   2. Post-storage-refactor format (defs/ + cache/ + installs/)
//   3. Both eras present (the dual-write-era reality on most users' machines)
//
// Plus: idempotency, fresh-install (no legacy data), and lossy-but-best-effort
// handling of edge cases.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let migrateMod, datastoreMod, journalMod;

async function freshHome(prefix = "storage-migrate-") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.EQUIP_HOME = tmp;
  if (!migrateMod) migrateMod = await import("../../dist/lib/storage/migrate-from-legacy.js");
  if (!datastoreMod) datastoreMod = await import("../../dist/lib/storage/datastore.js");
  if (!journalMod) journalMod = await import("../../dist/lib/storage/intent-journal.js");
  journalMod._resetSeqForTests();
  return tmp;
}

// ─── Pre-refactor fixtures ────────────────────────────────

function writePreRefactorAugment(home, name, def) {
  const dir = path.join(home, "augments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(def, null, 2));
}

function writePreRefactorInstallations(home, augments) {
  fs.writeFileSync(
    path.join(home, "installations.json"),
    JSON.stringify({ lastUpdated: "x", augments }, null, 2),
  );
}

// ─── Post-refactor fixtures ───────────────────────────────

function writePostRefactorDef(home, name, def) {
  const dir = path.join(home, "defs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ name, ...def }, null, 2));
}

function writePostRefactorCache(home, name, cache) {
  const dir = path.join(home, "cache");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ name, ...cache }, null, 2));
}

function writePostRefactorInstall(home, name, install) {
  const dir = path.join(home, "installs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ name, ...install }, null, 2));
}

// ─── Tests ────────────────────────────────────────────────

test("fresh install (no legacy data): stamps schema_version=5; emits no intents", async () => {
  const home = await freshHome();
  const result = migrateMod.migrateFromLegacy();
  assert.equal(result.status, "no-legacy-data");
  assert.equal(result.augmentsMigrated, 0);
  assert.equal(result.intentsAppended, 0);
  assert.equal(result.contentBlobsWritten, 0);
  assert.equal(fs.readFileSync(path.join(home, ".schema_version"), "utf-8").trim(), "5");
});

test("idempotent: re-running on already-migrated state is skipped", async () => {
  const home = await freshHome();
  fs.writeFileSync(path.join(home, ".schema_version"), "5");
  const result = migrateMod.migrateFromLegacy();
  assert.equal(result.status, "skipped-already-migrated");
});

test("force=true overrides idempotency for redo scenarios", async () => {
  const home = await freshHome();
  fs.writeFileSync(path.join(home, ".schema_version"), "5");
  const result = migrateMod.migrateFromLegacy({ force: true });
  assert.equal(result.status, "no-legacy-data"); // no legacy → no-legacy-data still
});

test("pre-refactor format: local augment migrates to install intent + content blob", async () => {
  const home = await freshHome();
  writePreRefactorAugment(home, "my-local", {
    name: "my-local",
    source: "local",
    title: "My Local",
    description: "test",
    transport: "http",
    serverUrl: "https://example.com/local",
    requiresAuth: false,
    skills: [],
    rules: { content: "be helpful", version: "1.0.0", marker: "my-local" },
  });
  writePreRefactorInstallations(home, {
    "my-local": { platforms: ["claude-code"], artifacts: {} },
  });

  const result = migrateMod.migrateFromLegacy();
  assert.equal(result.status, "complete");
  assert.equal(result.augmentsMigrated, 1);
  assert.equal(result.intentsAppended, 1);
  assert.equal(result.contentBlobsWritten, 1);
  assert.match(result.backupPath ?? "", /backup-pre-storage-redesign/);

  const resolved = datastoreMod.JsonStore.resolve("my-local");
  assert.ok(resolved);
  assert.equal(resolved.title, "My Local");
  assert.equal(resolved.serverUrl, "https://example.com/local");
  assert.equal(resolved.installed, true);
  assert.deepEqual(resolved.installedPlatforms, ["claude-code"]);
  assert.equal(resolved.modded, false);
  assert.equal(resolved.contentSource.kind, "local-authored");
});

test("pre-refactor format: registry augment migrates with registry contentSource", async () => {
  const home = await freshHome();
  writePreRefactorAugment(home, "my-registry", {
    name: "my-registry",
    source: "registry",
    title: "Registry Augment",
    description: "x",
    transport: "http",
    serverUrl: "https://reg.example/mcp",
    requiresAuth: false,
    skills: [],
    rules: { content: "registry rules", version: "1.0.0", marker: "my-registry" },
    registryContentHash: "h1",
    registryEtag: "e1",
    registryVersionNumber: 3,
    registryStatus: "active",
    lastValidatedAt: "2026-04-29T10:00:00.000Z",
  });
  writePreRefactorInstallations(home, {
    "my-registry": { platforms: ["claude-code", "cursor"], artifacts: {} },
  });

  migrateMod.migrateFromLegacy();
  const resolved = datastoreMod.JsonStore.resolve("my-registry");
  assert.ok(resolved);
  assert.equal(resolved.contentSource.kind, "registry");
  assert.equal(resolved.contentSource.version, 3);
  assert.equal(resolved.contentSource.etag, "e1");
  assert.equal(resolved.installedPlatforms.length, 2);
});

test("pre-refactor format: modded registry augment generates install + mod intents", async () => {
  const home = await freshHome();
  writePreRefactorAugment(home, "modded", {
    name: "modded",
    source: "registry",
    title: "Modded",
    description: "x",
    transport: "http",
    serverUrl: "https://reg.example/mcp",
    requiresAuth: false,
    skills: [],
    rules: { content: "USER MODDED rules", version: "1.0.0", marker: "modded" },
    rulesUpstream: { content: "PUBLISHER rules", version: "1.0.0", marker: "modded" },
    modded: true,
    moddedFields: ["rules"],
    registryContentHash: "h1",
    registryVersionNumber: 1,
    registryStatus: "active",
  });
  writePreRefactorInstallations(home, {
    "modded": { platforms: ["claude-code"], artifacts: {} },
  });

  const result = migrateMod.migrateFromLegacy();
  assert.equal(result.intentsAppended, 2, "install intent + mod intent");

  const resolved = datastoreMod.JsonStore.resolve("modded");
  assert.equal(resolved.modded, true);
  assert.deepEqual(resolved.moddedFields, ["rules"]);
  // The mod intent overrides; user's rules win in the resolved view.
  assert.equal(resolved.rules.content, "USER MODDED rules");
});

test("post-refactor format: 3-store layout migrates to journal", async () => {
  const home = await freshHome();
  writePostRefactorDef(home, "post-local", {
    kind: "local",
    title: "Post Local",
    description: "x",
    transport: "http",
    serverUrl: "https://x",
    requiresAuth: false,
    skills: [],
    rules: { content: "post local rules", version: "1.0.0", marker: "post-local" },
  });
  writePostRefactorInstall(home, "post-local", {
    platforms: ["cursor"],
    artifacts: {},
  });

  migrateMod.migrateFromLegacy();
  const resolved = datastoreMod.JsonStore.resolve("post-local");
  assert.ok(resolved);
  assert.equal(resolved.title, "Post Local");
  assert.equal(resolved.contentSource.kind, "local-authored");
  assert.deepEqual(resolved.installedPlatforms, ["cursor"]);
});

test("post-refactor format: cache-only registry augment migrates", async () => {
  const home = await freshHome();
  writePostRefactorCache(home, "registry-only", {
    title: "Registry Only",
    description: "x",
    transport: "http",
    serverUrl: "https://reg.example/x",
    requiresAuth: false,
    skills: [],
    rules: { content: "reg rules", version: "1.0.0", marker: "registry-only" },
    registryContentHash: "abc",
    registryVersionNumber: 2,
    registryStatus: "active",
  });
  writePostRefactorInstall(home, "registry-only", {
    platforms: ["claude-code"],
    artifacts: {},
  });

  migrateMod.migrateFromLegacy();
  const resolved = datastoreMod.JsonStore.resolve("registry-only");
  assert.ok(resolved);
  assert.equal(resolved.contentSource.kind, "registry");
  assert.equal(resolved.installed, true);
});

test("post-refactor format: overlay defs + cache merges into modded augment", async () => {
  const home = await freshHome();
  writePostRefactorCache(home, "overlay-aug", {
    title: "Overlay Aug",
    description: "x",
    transport: "http",
    serverUrl: "https://x",
    requiresAuth: false,
    rules: { content: "PUBLISHER content", version: "1.0.0", marker: "overlay-aug" },
    skills: [],
    registryContentHash: "h",
    registryVersionNumber: 1,
    registryStatus: "active",
  });
  writePostRefactorDef(home, "overlay-aug", {
    kind: "overlay",
    overlay_of: "overlay-aug",
    rules: { content: "USER MOD content", version: "1.0.0", marker: "overlay-aug" },
  });
  writePostRefactorInstall(home, "overlay-aug", {
    platforms: ["claude-code"],
    artifacts: {},
  });

  migrateMod.migrateFromLegacy();
  const resolved = datastoreMod.JsonStore.resolve("overlay-aug");
  assert.ok(resolved);
  assert.equal(resolved.modded, true);
  assert.equal(resolved.rules.content, "USER MOD content", "user's overlay rules win in resolved view");
});

test("backup contents: legacy files copied to .backup-pre-storage-redesign/", async () => {
  const home = await freshHome();
  writePreRefactorAugment(home, "backed-up", {
    name: "backed-up", source: "local", title: "x", description: "x",
    requiresAuth: false, skills: [],
    rules: { content: "x", version: "1.0.0", marker: "backed-up" },
  });

  const result = migrateMod.migrateFromLegacy();
  assert.equal(result.status, "complete");
  assert.ok(fs.existsSync(path.join(result.backupPath, "augments", "backed-up.json")));
});

test("legacy files preserved on disk after migration (Phase A safety; not yet deleted)", async () => {
  // Phase A's migration BACKS UP but does not DELETE legacy files.
  // Deletion happens in Phase C cutover after equip-app is also migrated.
  // For Phase A, test that legacy files remain on disk for safety.
  const home = await freshHome();
  writePreRefactorAugment(home, "preserved", {
    name: "preserved", source: "local", title: "x", description: "x",
    requiresAuth: false, skills: [],
    rules: { content: "x", version: "1.0.0", marker: "preserved" },
  });

  migrateMod.migrateFromLegacy();
  assert.ok(fs.existsSync(path.join(home, "augments", "preserved.json")),
    "legacy file still on disk after Phase A migration");
});

test("multiple augments migrate in one pass; per-augment state independent", async () => {
  const home = await freshHome();
  writePreRefactorAugment(home, "a", {
    name: "a", source: "local", title: "A", description: "x",
    requiresAuth: false, skills: [],
    rules: { content: "a rules", version: "1.0.0", marker: "a" },
  });
  writePreRefactorAugment(home, "b", {
    name: "b", source: "registry", title: "B", description: "x",
    transport: "http", serverUrl: "https://b", requiresAuth: false, skills: [],
    rules: { content: "b rules", version: "1.0.0", marker: "b" },
    registryContentHash: "hb", registryVersionNumber: 1, registryStatus: "active",
  });
  writePreRefactorAugment(home, "c", {
    name: "c", source: "registry", title: "C", description: "x",
    transport: "http", serverUrl: "https://c", requiresAuth: false, skills: [],
    rules: { content: "MODDED c", version: "1.0.0", marker: "c" },
    rulesUpstream: { content: "PUBLISHER c", version: "1.0.0", marker: "c" },
    modded: true, moddedFields: ["rules"],
    registryContentHash: "hc", registryVersionNumber: 1, registryStatus: "active",
  });
  writePreRefactorInstallations(home, {
    "a": { platforms: ["claude-code"], artifacts: {} },
    "b": { platforms: ["cursor"], artifacts: {} },
  });

  const result = migrateMod.migrateFromLegacy();
  assert.equal(result.status, "complete");
  assert.equal(result.augmentsMigrated, 3);

  const a = datastoreMod.JsonStore.resolve("a");
  assert.equal(a.contentSource.kind, "local-authored");
  assert.deepEqual(a.installedPlatforms, ["claude-code"]);
  assert.equal(a.modded, false);

  const b = datastoreMod.JsonStore.resolve("b");
  assert.equal(b.contentSource.kind, "registry");
  assert.deepEqual(b.installedPlatforms, ["cursor"]);
  assert.equal(b.modded, false);

  const c = datastoreMod.JsonStore.resolve("c");
  assert.equal(c.contentSource.kind, "registry");
  assert.deepEqual(c.installedPlatforms, [], "c was not in installations.json — empty platforms");
  assert.equal(c.modded, true);
  assert.equal(c.rules.content, "MODDED c");
});
