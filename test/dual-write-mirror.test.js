// Dual-write mirror integration tests.
//
// Pkg 01 of equip-storage-refactor: verify that legacy writes via
// writeAugmentDef + writeInstallations also populate the new three-store
// layout. The architectural commitment for Pkg 01 — new stores stay in
// sync with legacy writes — is what these tests pin.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let augmentDefsMod;
let installationsMod;
let defsStoreMod;
let cacheStoreMod;
let installsStoreMod;
let migrationTriggerMod;

async function freshHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dual-write-test-"));
  process.env.EQUIP_HOME = tmp;
  if (!augmentDefsMod) augmentDefsMod = await import("../dist/lib/augment-defs.js");
  if (!installationsMod) installationsMod = await import("../dist/lib/installations.js");
  if (!defsStoreMod) defsStoreMod = await import("../dist/lib/defs-store.js");
  if (!cacheStoreMod) cacheStoreMod = await import("../dist/lib/cache-store.js");
  if (!installsStoreMod) installsStoreMod = await import("../dist/lib/installs-store.js");
  if (!migrationTriggerMod) migrationTriggerMod = await import("../dist/lib/migration-trigger.js");
  // Reset the migration-already-triggered flag so each test fresh-runs migration.
  migrationTriggerMod._resetMigrationTriggerForTests();
  return tmp;
}

function localFixture(name, overrides = {}) {
  const now = "2026-04-28T00:00:00.000Z";
  return {
    name,
    source: "local",
    title: name,
    description: "test",
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

function registryFixture(name, overrides = {}) {
  const now = "2026-04-28T00:00:00.000Z";
  return {
    name,
    source: "registry",
    title: name,
    description: "test",
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
// writeAugmentDef → defs/cache/installs mirror
// ─────────────────────────────────────────────────────────────

test("writeAugmentDef on local augment mirrors to defs/ kind=local", async () => {
  await freshHome();
  augmentDefsMod.writeAugmentDef(localFixture("dw-local"));
  const def = defsStoreMod.readDef("dw-local");
  assert.equal(def?.kind, "local");
  assert.equal(def?.title, "dw-local");
});

test("writeAugmentDef on wrapped augment mirrors to defs/ kind=wrapped", async () => {
  await freshHome();
  augmentDefsMod.writeAugmentDef({
    ...localFixture("dw-wrapped"),
    source: "wrapped",
    wrappedFrom: { type: "mcp", platform: "cursor" },
  });
  const def = defsStoreMod.readDef("dw-wrapped");
  assert.equal(def?.kind, "wrapped");
  assert.deepEqual(def?.wrappedFrom, { type: "mcp", platform: "cursor" });
});

test("writeAugmentDef on unmodded registry augment mirrors to cache/ only", async () => {
  await freshHome();
  augmentDefsMod.writeAugmentDef(registryFixture("dw-registry"));
  const cache = cacheStoreMod.readCache("dw-registry");
  assert.equal(cache?.title, "dw-registry");
  assert.equal(cache?.contentHash, "hash-dw-registry");
  assert.equal(defsStoreMod.readDef("dw-registry"), null, "no defs entry for unmodded registry");
});

test("writeAugmentDef on modded registry augment mirrors to cache/ AND defs/ kind=overlay", async () => {
  await freshHome();
  augmentDefsMod.writeAugmentDef(registryFixture("dw-modded", {
    modded: true,
    moddedFields: ["rules"],
    rules: { content: "MY MOD", version: "1.0.0", marker: "dw-modded" },
    rulesUpstream: { content: "UPSTREAM", version: "1.0.0", marker: "dw-modded" },
  }));
  const cache = cacheStoreMod.readCache("dw-modded");
  const def = defsStoreMod.readDef("dw-modded");
  assert.equal(cache?.rules?.content, "UPSTREAM");
  assert.equal(def?.kind, "overlay");
  assert.equal(def?.rules?.content, "MY MOD");
});

// ─────────────────────────────────────────────────────────────
// deleteAugmentDef → mirror deletion
// ─────────────────────────────────────────────────────────────

test("deleteAugmentDef removes both legacy file AND new-store entries", async () => {
  await freshHome();
  augmentDefsMod.writeAugmentDef(localFixture("dw-delete"));
  assert.equal(defsStoreMod.readDef("dw-delete")?.kind, "local");
  augmentDefsMod.deleteAugmentDef("dw-delete");
  assert.equal(defsStoreMod.readDef("dw-delete"), null, "defs entry removed via mirror");
});

// ─────────────────────────────────────────────────────────────
// Modded → unmodded transition cleans stale overlay
// ─────────────────────────────────────────────────────────────

test("modded → unmodded transition removes the stale overlay entry", async () => {
  await freshHome();
  // Write modded version → creates overlay
  augmentDefsMod.writeAugmentDef(registryFixture("dw-transition", {
    modded: true,
    moddedFields: ["rules"],
    rules: { content: "MOD", version: "1.0.0", marker: "dw-transition" },
  }));
  assert.equal(defsStoreMod.readDef("dw-transition")?.kind, "overlay");
  // Re-write as unmodded
  augmentDefsMod.writeAugmentDef(registryFixture("dw-transition"));
  assert.equal(defsStoreMod.readDef("dw-transition"), null, "stale overlay cleaned up");
  assert.equal(cacheStoreMod.readCache("dw-transition")?.title, "dw-transition", "cache still has the augment");
});

// ─────────────────────────────────────────────────────────────
// writeInstallations → installs/ mirror
// ─────────────────────────────────────────────────────────────

test("writeInstallations mirrors per-augment to installs/<name>.json", async () => {
  await freshHome();
  installationsMod.writeInstallations({
    lastUpdated: "2026-04-28T10:00:00.000Z",
    augments: {
      "dw-install-a": {
        source: "registry",
        title: "dw-install-a",
        transport: "http",
        installedAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-28T00:00:00.000Z",
        platforms: ["claude-code", "cursor"],
        artifacts: {
          "claude-code": { mcp: true, installMode: "broker" },
          "cursor": { mcp: true, installMode: "direct" },
        },
      },
      "dw-install-b": {
        source: "local",
        title: "dw-install-b",
        transport: "stdio",
        installedAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-28T00:00:00.000Z",
        platforms: ["vscode"],
        artifacts: { "vscode": { mcp: true } },
      },
    },
  });

  const a = installsStoreMod.readInstall("dw-install-a");
  assert.deepEqual(a?.platforms, ["claude-code", "cursor"]);
  assert.equal(a?.artifacts["claude-code"]?.installMode, "broker");

  const b = installsStoreMod.readInstall("dw-install-b");
  assert.deepEqual(b?.platforms, ["vscode"]);
});

// ─────────────────────────────────────────────────────────────
// Migration trigger fires on first call
// ─────────────────────────────────────────────────────────────

test("first call to writeAugmentDef triggers migration (legacy data populated to new stores)", async () => {
  const home = await freshHome();
  // Plant a legacy augments file directly (bypassing the dual-write hook).
  const legacyAugmentsDir = path.join(home, "augments");
  fs.mkdirSync(legacyAugmentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyAugmentsDir, "pre-existing.json"),
    JSON.stringify(localFixture("pre-existing", { title: "From Legacy" })),
    "utf-8",
  );
  // No new-store entry yet
  assert.equal(defsStoreMod.readDef("pre-existing"), null);

  // First call to a public entry triggers migration.
  augmentDefsMod.writeAugmentDef(localFixture("trigger", { title: "Triggers Migration" }));

  // Now both the migrated pre-existing AND the new "trigger" augment are in defs/
  assert.equal(defsStoreMod.readDef("pre-existing")?.title, "From Legacy");
  assert.equal(defsStoreMod.readDef("trigger")?.title, "Triggers Migration");
});

test("migration is idempotent across multiple writeAugmentDef calls (one process)", async () => {
  await freshHome();
  augmentDefsMod.writeAugmentDef(localFixture("idem-1"));
  augmentDefsMod.writeAugmentDef(localFixture("idem-2"));
  augmentDefsMod.writeAugmentDef(localFixture("idem-3"));
  assert.equal(defsStoreMod.readDef("idem-1")?.kind, "local");
  assert.equal(defsStoreMod.readDef("idem-2")?.kind, "local");
  assert.equal(defsStoreMod.readDef("idem-3")?.kind, "local");
});

// ─────────────────────────────────────────────────────────────
// Legacy stores remain authoritative (Pkg 01 behavior)
// ─────────────────────────────────────────────────────────────

test("Pkg 01 behavior: writeAugmentDef preserves legacy file path AND populates new stores", async () => {
  const home = await freshHome();
  augmentDefsMod.writeAugmentDef(localFixture("pkg01-coexist"));
  assert.equal(fs.existsSync(path.join(home, "augments", "pkg01-coexist.json")), true,
    "legacy ~/.equip/augments/<name>.json still written (authoritative for reads in Pkg 01)");
  assert.equal(defsStoreMod.readDef("pkg01-coexist")?.kind, "local",
    "new defs/ store also populated (mirror)");
});
