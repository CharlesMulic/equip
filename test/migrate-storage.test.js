// migrate-storage tests — the most data-loss-sensitive code in Pkg 01.
//
// Covers every (source × modded × installations.json-presence × publisher-state)
// combination from existing user state shapes, plus idempotency, escape
// hatches, backup creation, and orphaned install entries.
//
// Each test creates a fresh EQUIP_HOME so migration runs against an
// isolated synthetic legacy directory.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Lazy import the modules with the per-test EQUIP_HOME applied.
let migrateMod;
let defsStoreMod;
let cacheStoreMod;
let installsStoreMod;

async function freshHome(prefix = "migrate-test-") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.EQUIP_HOME = tmp;
  // Clear escape-hatch envs that earlier tests might have set.
  delete process.env.EQUIP_STORAGE_LEGACY_MODE;
  delete process.env.EQUIP_STORAGE_MIGRATION_DRY_RUN;
  // Re-import (Node caches by URL; module already cached so we just call
  // through; but env-dependent function-call reads see the new EQUIP_HOME).
  if (!migrateMod) migrateMod = await import("../dist/lib/migrate-storage.js");
  if (!defsStoreMod) defsStoreMod = await import("../dist/lib/defs-store.js");
  if (!cacheStoreMod) cacheStoreMod = await import("../dist/lib/cache-store.js");
  if (!installsStoreMod) installsStoreMod = await import("../dist/lib/installs-store.js");
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

function legacyLocalAugment(name, overrides = {}) {
  const now = "2026-04-28T00:00:00.000Z";
  return {
    name,
    source: "local",
    title: name,
    description: "Local",
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function legacyWrappedAugment(name, overrides = {}) {
  const now = "2026-04-28T00:00:00.000Z";
  return {
    name,
    source: "wrapped",
    title: name,
    description: "Wrapped",
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    wrappedFrom: { type: "mcp", platform: "cursor" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function legacyRegistryAugment(name, overrides = {}) {
  const now = "2026-04-28T00:00:00.000Z";
  return {
    name,
    source: "registry",
    title: name,
    description: "Registry",
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    transport: "http",
    serverUrl: `https://registry.example/${name}`,
    registryContentHash: `hash-${name}`,
    registryVersionNumber: 1,
    registryStatus: "active",
    lastValidatedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Routing per legacy source
// ─────────────────────────────────────────────────────────────

test("local augment migrates to defs/ kind=local; no cache, no install (no installation entry)", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "local-only", legacyLocalAugment("local-only", { rules: { content: "rules", version: "1.0.0", marker: "local-only" } }));

  const result = migrateMod.migrateStorageIfNeeded();
  assert.equal(result.status, "complete");
  assert.equal(result.augmentsMigrated, 1);

  const def = defsStoreMod.readDef("local-only");
  assert.equal(def?.kind, "local");
  assert.equal(def?.title, "local-only");
  assert.deepEqual(def?.rules, { content: "rules", version: "1.0.0", marker: "local-only" });

  assert.equal(cacheStoreMod.readCache("local-only"), null, "local augment has no cache entry");
  assert.equal(installsStoreMod.readInstall("local-only"), null, "no installations.json → no install entry");
});

test("wrapped augment migrates to defs/ kind=wrapped with wrappedFrom provenance", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "my-wrapped", legacyWrappedAugment("my-wrapped", {
    wrappedFrom: { type: "mcp", platform: "claude-code", path: "/some/path", originalName: "orig" },
  }));

  const result = migrateMod.migrateStorageIfNeeded();
  assert.equal(result.status, "complete");

  const def = defsStoreMod.readDef("my-wrapped");
  assert.equal(def?.kind, "wrapped");
  assert.deepEqual(def?.wrappedFrom, { type: "mcp", platform: "claude-code", path: "/some/path", originalName: "orig" });
});

test("wrapped augment with legacy string wrappedFrom migrates to structured WrappedFromMeta", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "old-wrapped", legacyWrappedAugment("old-wrapped", { wrappedFrom: "vscode" }));

  migrateMod.migrateStorageIfNeeded();
  const def = defsStoreMod.readDef("old-wrapped");
  assert.deepEqual(def?.wrappedFrom, { type: "mcp", platform: "vscode" });
});

test("registry augment NOT modded migrates to cache/ only; NO defs entry", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "pure-registry", legacyRegistryAugment("pure-registry"));

  migrateMod.migrateStorageIfNeeded();
  assert.equal(defsStoreMod.readDef("pure-registry"), null, "no defs entry for unmodded registry");
  const cache = cacheStoreMod.readCache("pure-registry");
  assert.equal(cache?.title, "pure-registry");
  assert.equal(cache?.contentHash, "hash-pure-registry");
  assert.equal(cache?.version, 1);
  assert.equal(cache?.transport, "http");
});

test("registry augment WITH modded=true migrates to cache/ + defs/ kind=overlay", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "modded-aug", legacyRegistryAugment("modded-aug", {
    modded: true,
    moddedFields: ["rules", "skills"],
    rules: { content: "MY MODDED RULES", version: "1.0.0", marker: "modded-aug" },
    rulesUpstream: { content: "ORIGINAL UPSTREAM RULES", version: "1.0.0", marker: "modded-aug" },
    skills: [{ name: "my-skill", files: [{ path: "SKILL.md", content: "modded skill" }] }],
  }));

  migrateMod.migrateStorageIfNeeded();

  // Cache holds upstream content (rulesUpstream → cache.rules).
  const cache = cacheStoreMod.readCache("modded-aug");
  assert.equal(cache?.rules?.content, "ORIGINAL UPSTREAM RULES");

  // Overlay holds the user's mods (rules + skills since both in moddedFields).
  const def = defsStoreMod.readDef("modded-aug");
  assert.equal(def?.kind, "overlay");
  assert.equal(def?.overlay_of, "modded-aug");
  assert.equal(def?.rules?.content, "MY MODDED RULES");
  assert.equal(def?.skills?.[0]?.name, "my-skill");
});

test("modded augment without rulesUpstream falls back to current rules for cache", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "no-upstream", legacyRegistryAugment("no-upstream", {
    modded: true,
    moddedFields: ["rules"],
    rules: { content: "modded rules but no upstream snapshot", version: "1.0.0", marker: "no-upstream" },
    // Note: no rulesUpstream field
  }));

  migrateMod.migrateStorageIfNeeded();
  const cache = cacheStoreMod.readCache("no-upstream");
  assert.equal(cache?.rules?.content, "modded rules but no upstream snapshot",
    "fallback: when no rulesUpstream, current rules become the cache content");
});

test("hooks-only modding includes hooks in overlay but not rules/skills", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "hooks-only-mod", legacyRegistryAugment("hooks-only-mod", {
    modded: true,
    moddedFields: ["hooks"],
    hooks: [{ type: "PostToolUse", command: "echo modded" }],
  }));
  migrateMod.migrateStorageIfNeeded();
  const def = defsStoreMod.readDef("hooks-only-mod");
  assert.equal(def?.kind, "overlay");
  assert.deepEqual(def?.hooks, [{ type: "PostToolUse", command: "echo modded" }]);
});

// ─────────────────────────────────────────────────────────────
// Installations.json conversion
// ─────────────────────────────────────────────────────────────

test("installations.json entries migrate to per-augment installs/ records", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "with-install", legacyRegistryAugment("with-install"));
  writeLegacyInstallations(home, {
    lastUpdated: "2026-04-28T10:00:00.000Z",
    augments: {
      "with-install": {
        source: "registry",
        title: "with-install",
        transport: "http",
        serverUrl: "https://registry.example/with-install",
        installedAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-28T00:00:00.000Z",
        platforms: ["claude-code", "cursor"],
        artifacts: {
          "claude-code": { mcp: true, installMode: "broker" },
          "cursor": { mcp: true, rules: "1.0.0", installMode: "direct" },
        },
      },
    },
  });

  migrateMod.migrateStorageIfNeeded();
  const inst = installsStoreMod.readInstall("with-install");
  assert.deepEqual(inst?.platforms, ["claude-code", "cursor"]);
  assert.equal(inst?.artifacts["claude-code"]?.installMode, "broker");
  assert.equal(inst?.artifacts["cursor"]?.installMode, "direct");
});

test("orphaned installations.json entry (no augment file) creates installs entry only", async () => {
  const home = await freshHome();
  writeLegacyInstallations(home, {
    lastUpdated: "2026-04-28T10:00:00.000Z",
    augments: {
      "orphan": {
        source: "registry",
        title: "orphan",
        transport: "http",
        installedAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-28T00:00:00.000Z",
        platforms: ["claude-code"],
        artifacts: { "claude-code": { mcp: true } },
      },
    },
  });

  const result = migrateMod.migrateStorageIfNeeded();
  assert.equal(result.augmentsMigrated, 1);
  assert.equal(installsStoreMod.readInstall("orphan")?.platforms[0], "claude-code");
  assert.equal(defsStoreMod.readDef("orphan"), null);
  assert.equal(cacheStoreMod.readCache("orphan"), null);
});

// ─────────────────────────────────────────────────────────────
// Publisher state DROPPED locally
// ─────────────────────────────────────────────────────────────

test("publisher state on legacy augment is DROPPED locally + reported in result + stripped from legacy file (Cleanup A schema v3)", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "with-publisher-state", legacyRegistryAugment("with-publisher-state", {
    submittedRevisionId: "version:5",
    submittedStatus: "pending-review",
    submittedAt: "2026-04-27T20:00:00.000Z",
    workingDraftEdit: { description: "in-flight edits" },
    submittedEdit: { description: "submitted snapshot" },
    submittedRejectionReason: "WAS_REJECTED",
    pendingEdit: { description: "legacy compat" },
    pendingReviewId: "review-7",
    pendingRejectionReason: "WAS_REJECTED",
  }));

  const result = migrateMod.migrateStorageIfNeeded();
  assert.equal(result.publisherStateDropped.includes("with-publisher-state"), true);

  // None of the publisher fields appear anywhere in the new stores.
  const cache = cacheStoreMod.readCache("with-publisher-state");
  assert.equal("submittedRevisionId" in (cache ?? {}), false);
  assert.equal("submittedStatus" in (cache ?? {}), false);
  assert.equal("workingDraftEdit" in (cache ?? {}), false);

  // Cleanup A schema v3: legacy ~/.equip/augments/<name>.json is rewritten
  // to drop publisher-state fields too (server-side equip_publisher_drafts is
  // now the single source of truth). All 9 fields must be gone.
  const legacyOnDisk = JSON.parse(
    fs.readFileSync(path.join(home, "augments", "with-publisher-state.json"), "utf-8"),
  );
  for (const field of [
    "workingDraftEdit", "submittedEdit", "submittedRevisionId", "submittedStatus",
    "submittedRejectionReason", "submittedAt", "pendingEdit", "pendingReviewId",
    "pendingRejectionReason",
  ]) {
    assert.equal(field in legacyOnDisk, false, `legacy file must not contain ${field} after schema v3 migration`);
  }
});

test("schema v2 → v3 bump strips publisher state from legacy files even when v2 already ran", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "v2-already", legacyRegistryAugment("v2-already", {
    workingDraftEdit: { description: "ancient draft" },
    pendingReviewId: "review-stuck",
  }));
  // Simulate a previously-migrated v2 install — schema marker present + new
  // stores already populated, legacy file still has publisher fields.
  fs.writeFileSync(path.join(home, ".schema_version"), "2", "utf-8");

  const result = migrateMod.migrateStorageIfNeeded();
  assert.equal(result.status, "complete");

  const legacyOnDisk = JSON.parse(
    fs.readFileSync(path.join(home, "augments", "v2-already.json"), "utf-8"),
  );
  assert.equal("workingDraftEdit" in legacyOnDisk, false, "v2→v3 bump strips workingDraftEdit");
  assert.equal("pendingReviewId" in legacyOnDisk, false, "v2→v3 bump strips pendingReviewId");

  // Schema marker is now at v3.
  assert.equal(fs.readFileSync(path.join(home, ".schema_version"), "utf-8").trim(), "3");

  // Re-running is a no-op.
  const second = migrateMod.migrateStorageIfNeeded();
  assert.equal(second.status, "skipped");
});

// ─────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────

test("re-running migration with .schema_version=2 is a skipped no-op", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "idempotent", legacyLocalAugment("idempotent"));

  const first = migrateMod.migrateStorageIfNeeded();
  assert.equal(first.status, "complete");

  const second = migrateMod.migrateStorageIfNeeded();
  assert.equal(second.status, "skipped");
  assert.equal(second.augmentsMigrated, 0);
});

// ─────────────────────────────────────────────────────────────
// Escape hatches
// ─────────────────────────────────────────────────────────────

test("EQUIP_STORAGE_LEGACY_MODE=true skips migration entirely", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "legacy-mode-aug", legacyLocalAugment("legacy-mode-aug"));
  process.env.EQUIP_STORAGE_LEGACY_MODE = "true";
  try {
    const result = migrateMod.migrateStorageIfNeeded();
    assert.equal(result.status, "legacy-mode");
    // Legacy file untouched
    assert.equal(fs.existsSync(path.join(home, "augments", "legacy-mode-aug.json")), true);
    // No new stores created
    assert.equal(defsStoreMod.readDef("legacy-mode-aug"), null);
  } finally {
    delete process.env.EQUIP_STORAGE_LEGACY_MODE;
  }
});

test("EQUIP_STORAGE_MIGRATION_DRY_RUN=true emits plan + writes nothing", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "dry-aug", legacyLocalAugment("dry-aug"));
  process.env.EQUIP_STORAGE_MIGRATION_DRY_RUN = "true";
  try {
    const result = migrateMod.migrateStorageIfNeeded();
    assert.equal(result.status, "dry-run");
    assert.equal(result.augmentsMigrated, 1);
    assert.equal(result.plan?.["dry-aug"]?.defs?.kind, "local");
    // Legacy untouched + no new stores written
    assert.equal(fs.existsSync(path.join(home, "augments", "dry-aug.json")), true);
    assert.equal(defsStoreMod.readDef("dry-aug"), null);
    assert.equal(fs.existsSync(path.join(home, ".schema_version")), false);
  } finally {
    delete process.env.EQUIP_STORAGE_MIGRATION_DRY_RUN;
  }
});

// ─────────────────────────────────────────────────────────────
// Backup + cleanup
// ─────────────────────────────────────────────────────────────

test("backup directory created with original augments + installations.json before migration writes", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "backup-test", legacyLocalAugment("backup-test"));
  writeLegacyInstallations(home, { lastUpdated: "x", augments: {} });

  const result = migrateMod.migrateStorageIfNeeded();
  assert.equal(typeof result.backupPath, "string");
  assert.equal(fs.existsSync(path.join(result.backupPath, "augments", "backup-test.json")), true);
  assert.equal(fs.existsSync(path.join(result.backupPath, "installations.json")), true);
});

test("legacy ~/.equip/augments/ and installations.json PRESERVED after migration (Pkg 01 dual-write)", async () => {
  // Pkg 01 dual-write strategy: legacy files stay authoritative for reads
  // until Pkgs 02-04 switch consumers to the resolver. Legacy cleanup is a
  // final commit after all consumers migrate.
  const home = await freshHome();
  writeLegacyAugment(home, "cleanup-test", legacyLocalAugment("cleanup-test"));
  writeLegacyInstallations(home, { lastUpdated: "x", augments: {} });

  migrateMod.migrateStorageIfNeeded();
  assert.equal(fs.existsSync(path.join(home, "augments", "cleanup-test.json")), true, "legacy augments preserved for dual-write reads");
  assert.equal(fs.existsSync(path.join(home, "installations.json")), true, "legacy installations.json preserved for dual-write reads");
  // New stores ARE populated (Pkg 01 architectural commitment).
  assert.equal(defsStoreMod.readDef("cleanup-test")?.kind, "local");
});

// ─────────────────────────────────────────────────────────────
// Fresh install + schema marker
// ─────────────────────────────────────────────────────────────

test("fresh install (no legacy data) just stamps schema version", async () => {
  const home = await freshHome();
  // No legacy files at all.
  const result = migrateMod.migrateStorageIfNeeded();
  assert.equal(result.status, "no-legacy-data");
  assert.equal(fs.existsSync(path.join(home, ".schema_version")), true);
  assert.equal(fs.readFileSync(path.join(home, ".schema_version"), "utf-8").trim(), "3");
});

test("currentSchemaVersion returns 1 when marker missing (legacy install)", async () => {
  await freshHome();
  assert.equal(migrateMod.currentSchemaVersion(), 1);
});

test("currentSchemaVersion returns 3 after migration completes", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "schema-test", legacyLocalAugment("schema-test"));
  migrateMod.migrateStorageIfNeeded();
  assert.equal(migrateMod.currentSchemaVersion(), 3);
});

// ─────────────────────────────────────────────────────────────
// Cleanup B (schema v4) — legacy file deletion + backup
// ─────────────────────────────────────────────────────────────
//
// `cleanupBLegacyFiles()` is invokable but not auto-fired from
// `migrateStorageIfNeeded()` yet (Pkg 06 batch 1 — landing the helper
// without breaking dual-write writers that still recreate legacy files).
// These tests pin the migration semantics that Pkg 06 batch 2 will rely on
// when the legacy modules + auto-firing land together.

test("cleanupBLegacyFiles snapshots augments + installations into .backup-pre-cleanup-b/ before deletion", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "aug1", legacyLocalAugment("aug1"));
  writeLegacyAugment(home, "aug2", legacyRegistryAugment("aug2"));
  writeLegacyInstallations(home, {
    lastUpdated: "2026-04-29T10:00:00.000Z",
    augments: { "aug1": { source: "local", title: "aug1", transport: "http",
      installedAt: "x", updatedAt: "y", platforms: ["claude-code"], artifacts: { "claude-code": { mcp: true } } } },
  });

  const result = migrateMod.cleanupBLegacyFiles();
  assert.equal(result.status, "complete");
  assert.equal(result.legacyAugmentsRemoved, 2);
  assert.equal(result.legacyInstallationsRemoved, true);
  assert.deepEqual(result.errors, []);

  // Backup snapshot exists with both augments + installations.json.
  assert.equal(typeof result.backupPath, "string");
  assert.equal(fs.existsSync(path.join(result.backupPath, "augments", "aug1.json")), true);
  assert.equal(fs.existsSync(path.join(result.backupPath, "augments", "aug2.json")), true);
  assert.equal(fs.existsSync(path.join(result.backupPath, "installations.json")), true);

  // Legacy files are gone.
  assert.equal(fs.existsSync(path.join(home, "augments")), false);
  assert.equal(fs.existsSync(path.join(home, "installations.json")), false);

  // Schema marker bumped to 4.
  assert.equal(fs.readFileSync(path.join(home, ".schema_version"), "utf-8").trim(), "4");
});

test("cleanupBLegacyFiles is idempotent — re-running on schema_version=4 is a skipped no-op", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "once", legacyLocalAugment("once"));

  const first = migrateMod.cleanupBLegacyFiles();
  assert.equal(first.status, "complete");

  // Re-run: legacy files are already gone, schema marker is at 4 → skipped.
  const second = migrateMod.cleanupBLegacyFiles();
  assert.equal(second.status, "skipped");
  assert.equal(second.legacyAugmentsRemoved, 0);
  assert.equal(second.legacyInstallationsRemoved, false);
  assert.equal(second.backupPath, null);
});

test("cleanupBLegacyFiles on fresh install (no legacy data) just stamps schema v4", async () => {
  const home = await freshHome();
  // No legacy files at all. Schema version not set yet.
  const result = migrateMod.cleanupBLegacyFiles();
  assert.equal(result.status, "no-legacy-data");
  assert.equal(result.legacyAugmentsRemoved, 0);
  assert.equal(result.legacyInstallationsRemoved, false);
  assert.equal(result.backupPath, null);
  assert.equal(fs.readFileSync(path.join(home, ".schema_version"), "utf-8").trim(), "4");
});

test("cleanupBLegacyFiles handles partial legacy state — augments only, no installations.json", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "lone", legacyLocalAugment("lone"));
  // No installations.json.

  const result = migrateMod.cleanupBLegacyFiles();
  assert.equal(result.status, "complete");
  assert.equal(result.legacyAugmentsRemoved, 1);
  assert.equal(result.legacyInstallationsRemoved, false);
  assert.deepEqual(result.errors, []);
  assert.equal(fs.existsSync(path.join(home, "augments")), false);
  assert.equal(fs.existsSync(path.join(result.backupPath, "augments", "lone.json")), true);
});

test("cleanupBLegacyFiles handles partial legacy state — installations.json only, no augments dir", async () => {
  const home = await freshHome();
  writeLegacyInstallations(home, {
    lastUpdated: "2026-04-29T10:00:00.000Z",
    augments: { "ghost": { source: "registry", title: "ghost", transport: "http",
      installedAt: "x", updatedAt: "y", platforms: [], artifacts: {} } },
  });

  const result = migrateMod.cleanupBLegacyFiles();
  assert.equal(result.status, "complete");
  assert.equal(result.legacyAugmentsRemoved, 0);
  assert.equal(result.legacyInstallationsRemoved, true);
  assert.equal(fs.existsSync(path.join(home, "installations.json")), false);
  assert.equal(fs.existsSync(path.join(result.backupPath, "installations.json")), true);
});

test("cleanupBLegacyFiles backup snapshot preserves byte-for-byte content of legacy files", async () => {
  const home = await freshHome();
  const augContent = legacyLocalAugment("byte-test", { description: "exact-content-test" });
  writeLegacyAugment(home, "byte-test", augContent);

  const originalBytes = fs.readFileSync(path.join(home, "augments", "byte-test.json"));
  const result = migrateMod.cleanupBLegacyFiles();
  assert.equal(result.status, "complete");

  const backupBytes = fs.readFileSync(path.join(result.backupPath, "augments", "byte-test.json"));
  assert.equal(backupBytes.equals(originalBytes), true, "snapshot must be byte-identical to source");
});

test("cleanupBLegacyFiles re-snapshot overwrites partial prior backup (recovery from previous failure)", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "fresh", legacyLocalAugment("fresh"));

  // Simulate a previous failed attempt: a backup dir exists with a stale file
  // that ISN'T in the current legacy state.
  const backupDir = path.join(home, ".backup-pre-cleanup-b");
  fs.mkdirSync(path.join(backupDir, "augments"), { recursive: true });
  fs.writeFileSync(path.join(backupDir, "augments", "stale.json"), '{"name":"stale-from-prior-attempt"}', "utf-8");

  const result = migrateMod.cleanupBLegacyFiles();
  assert.equal(result.status, "complete");

  // Backup now reflects current legacy state, not the stale prior attempt.
  assert.equal(fs.existsSync(path.join(backupDir, "augments", "fresh.json")), true);
  assert.equal(fs.existsSync(path.join(backupDir, "augments", "stale.json")), false,
    "stale prior-attempt file must not survive a re-snapshot — backup reflects current state");
});

test("cleanupBLegacyFiles does NOT touch new defs/cache/installs stores", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "preserved", legacyLocalAugment("preserved"));

  // Run the v1→v3 migration first to populate the new stores.
  migrateMod.migrateStorageIfNeeded();
  assert.equal(defsStoreMod.readDef("preserved")?.kind, "local");

  // Now run Cleanup B.
  const result = migrateMod.cleanupBLegacyFiles({ force: true });
  assert.equal(result.status, "complete");

  // New stores still intact — Cleanup B only touches legacy.
  assert.equal(defsStoreMod.readDef("preserved")?.kind, "local",
    "new defs/ store must survive cleanupBLegacyFiles untouched");
});

test("cleanupBLegacyFiles force=true overrides idempotency for redo scenarios", async () => {
  const home = await freshHome();
  writeLegacyAugment(home, "redo", legacyLocalAugment("redo"));
  // Manually set schema_version=4 so the default path would skip.
  fs.writeFileSync(path.join(home, ".schema_version"), "4", "utf-8");

  // Without force: skipped.
  const skipped = migrateMod.cleanupBLegacyFiles();
  assert.equal(skipped.status, "skipped");
  assert.equal(fs.existsSync(path.join(home, "augments", "redo.json")), true,
    "default-path skipped run leaves legacy files in place");

  // With force: runs the cleanup.
  const forced = migrateMod.cleanupBLegacyFiles({ force: true });
  assert.equal(forced.status, "complete");
  assert.equal(forced.legacyAugmentsRemoved, 1);
  assert.equal(fs.existsSync(path.join(home, "augments")), false);
});

test("cleanupBLegacyFiles requireNewStoresPopulated=true: aborts when legacy populated but new stores empty", async () => {
  const home = await freshHome();
  // Write legacy augment WITHOUT triggering the v1→v2 migration. To bypass
  // the dual-write mirror that runs on writeAugmentDef, write the JSON file
  // directly.
  fs.mkdirSync(path.join(home, "augments"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "augments", "lonely.json"),
    JSON.stringify(legacyLocalAugment("lonely"), null, 2),
    "utf-8",
  );
  // Confirm new stores are NOT populated.
  assert.equal(fs.existsSync(path.join(home, "defs")), false);
  assert.equal(fs.existsSync(path.join(home, "cache")), false);

  const result = migrateMod.cleanupBLegacyFiles({ requireNewStoresPopulated: true });
  assert.equal(result.status, "precondition-failed");
  assert.equal(result.legacyAugmentsRemoved, 0);
  assert.equal(result.legacyInstallationsRemoved, false);
  assert.equal(result.backupPath, null, "no snapshot taken on precondition failure");
  assert.match(result.errors[0], /precondition failed/);
  assert.match(result.errors[0], /1 augment file/);
  assert.match(result.errors[0], /Run migrateStorageIfNeeded/);

  // Legacy file still on disk — protective.
  assert.equal(fs.existsSync(path.join(home, "augments", "lonely.json")), true);
  // .schema_version NOT bumped.
  assert.equal(fs.existsSync(path.join(home, ".schema_version")), false);
});

test("cleanupBLegacyFiles requireNewStoresPopulated=true: proceeds when new stores populated (after migration)", async () => {
  const home = await freshHome();
  // Write legacy augment as raw JSON.
  writeLegacyAugment(home, "happy-path", legacyLocalAugment("happy-path"));
  // Run the v1→v2 migration to populate new stores from legacy.
  migrateMod.migrateStorageIfNeeded();
  // Now new stores have content.
  assert.equal(defsStoreMod.readDef("happy-path")?.kind, "local");

  // Force-bump back the schema marker so cleanup-B doesn't skip on idempotency.
  fs.writeFileSync(path.join(home, ".schema_version"), "3", "utf-8");

  const result = migrateMod.cleanupBLegacyFiles({ requireNewStoresPopulated: true });
  assert.equal(result.status, "complete");
  assert.equal(result.legacyAugmentsRemoved, 1);
});

test("cleanupBLegacyFiles requireNewStoresPopulated=true with NO legacy data: precondition skipped (no-legacy-data path)", async () => {
  const home = await freshHome();
  // No legacy files at all → the precondition isn't reached; takes the
  // "no-legacy-data" path and stamps the schema marker.
  const result = migrateMod.cleanupBLegacyFiles({ requireNewStoresPopulated: true });
  assert.equal(result.status, "no-legacy-data");
  assert.equal(fs.readFileSync(path.join(home, ".schema_version"), "utf-8").trim(), "4");
});

test("cleanupBLegacyFiles requireNewStoresPopulated default behavior unchanged (false by default)", async () => {
  const home = await freshHome();
  // Write legacy augment directly without dual-write — would fail precondition.
  fs.mkdirSync(path.join(home, "augments"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "augments", "no-precond.json"),
    JSON.stringify(legacyLocalAugment("no-precond"), null, 2),
    "utf-8",
  );

  // Without the precondition flag: cleanup runs even though new stores are empty.
  const result = migrateMod.cleanupBLegacyFiles();
  assert.equal(result.status, "complete",
    "default behavior (no precondition check) — cleanup runs regardless of new-store state");
  assert.equal(fs.existsSync(path.join(home, "augments")), false);
});
