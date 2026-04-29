// Pin the dual-write mirror's registry-state-field routing through
// `mirrorWriteAugmentDef` → `legacyRegistryToCache`. Cleanup B Pkg 03
// migration deferred the read-modify-write sites in `registry-refresh.ts`
// (20 sites) on the explicit assumption that the mirror correctly routes
// registry-tracking field mutations into the new cache/ store.
//
// If the mirror routing is wrong/incomplete, those deferred sites produce
// inconsistent new-store state, which is the exact bug class Cleanup B is
// trying to eliminate. This test fails loudly if the routing breaks before
// Package 06 retires the legacy modules.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let augmentDefsMod;
let cacheStoreMod;

async function freshHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "registry-state-routing-"));
  process.env.EQUIP_HOME = tmp;
  if (!augmentDefsMod) augmentDefsMod = await import("../dist/lib/augment-defs.js");
  if (!cacheStoreMod) cacheStoreMod = await import("../dist/lib/cache-store.js");
  return tmp;
}

function legacyRegistryDef(name, overrides = {}) {
  const now = "2026-04-29T00:00:00.000Z";
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
    serverUrl: `https://upstream.example/${name}`,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Field-by-field routing — each registry-tracking field on AugmentDef
// must land on the equivalent CachedDef field via the mirror.
// ─────────────────────────────────────────────────────────────

test("mirror routes def.registryStatus → cached.registryStatus", async () => {
  await freshHome();
  augmentDefsMod.writeAugmentDef(legacyRegistryDef("status-route", {
    registryStatus: "pending-review",
  }));
  const cached = cacheStoreMod.readCache("status-route");
  assert.equal(cached?.registryStatus, "pending-review");
});

test("mirror routes def.registryContentHash → cached.contentHash", async () => {
  await freshHome();
  augmentDefsMod.writeAugmentDef(legacyRegistryDef("hash-route", {
    registryContentHash: "sha256-abcdef",
  }));
  const cached = cacheStoreMod.readCache("hash-route");
  assert.equal(cached?.contentHash, "sha256-abcdef");
});

test("mirror routes def.registryEtag → cached.etag", async () => {
  await freshHome();
  augmentDefsMod.writeAugmentDef(legacyRegistryDef("etag-route", {
    registryEtag: "etag-v1",
  }));
  const cached = cacheStoreMod.readCache("etag-route");
  assert.equal(cached?.etag, "etag-v1");
});

test("mirror routes def.registryVersionNumber → cached.version", async () => {
  await freshHome();
  augmentDefsMod.writeAugmentDef(legacyRegistryDef("version-route", {
    registryVersionNumber: 7,
  }));
  const cached = cacheStoreMod.readCache("version-route");
  assert.equal(cached?.version, 7);
});

test("mirror routes def.lastValidatedAt → cached.fetchedAt", async () => {
  await freshHome();
  augmentDefsMod.writeAugmentDef(legacyRegistryDef("validated-route", {
    lastValidatedAt: "2026-04-29T11:30:00.000Z",
  }));
  const cached = cacheStoreMod.readCache("validated-route");
  assert.equal(cached?.fetchedAt, "2026-04-29T11:30:00.000Z");
});

// ─────────────────────────────────────────────────────────────
// Multi-field write — single writeAugmentDef call routes every
// registry-tracking field correctly in one pass.
// ─────────────────────────────────────────────────────────────

test("mirror routes ALL registry-tracking fields in one write", async () => {
  await freshHome();
  augmentDefsMod.writeAugmentDef(legacyRegistryDef("all-routed", {
    registryStatus: "active",
    registryContentHash: "sha256-multi",
    registryEtag: "etag-multi",
    registryVersionNumber: 11,
    lastValidatedAt: "2026-04-29T12:00:00.000Z",
    registryLatestContentHash: "sha256-newer",
    registryLatestSecurityAdvisory: true,
  }));
  const cached = cacheStoreMod.readCache("all-routed");
  assert.equal(cached?.registryStatus, "active");
  assert.equal(cached?.contentHash, "sha256-multi");
  assert.equal(cached?.etag, "etag-multi");
  assert.equal(cached?.version, 11);
  assert.equal(cached?.fetchedAt, "2026-04-29T12:00:00.000Z");
  assert.equal(cached?.registryLatestContentHash, "sha256-newer");
  assert.equal(cached?.registryLatestSecurityAdvisory, true);
});

// ─────────────────────────────────────────────────────────────
// Mutation round-trip — pin the read-modify-write pattern that
// registry-refresh.ts uses. This is the canonical scenario the
// deferred sites rely on.
// ─────────────────────────────────────────────────────────────

test("registry-refresh-pattern: mutate def.registryStatus + writeAugmentDef → cache reflects change", async () => {
  await freshHome();

  // Initial state: registry def with active status
  augmentDefsMod.writeAugmentDef(legacyRegistryDef("rmw-pattern", {
    registryStatus: "active",
    registryContentHash: "hash-v1",
    lastValidatedAt: "2026-04-29T10:00:00.000Z",
  }));

  // Verify initial cache state
  let cached = cacheStoreMod.readCache("rmw-pattern");
  assert.equal(cached?.registryStatus, "active");

  // Read-modify-write pattern that registry-refresh.ts uses
  const def = augmentDefsMod.readAugmentDef("rmw-pattern");
  assert.ok(def, "def must exist");
  def.registryStatus = "retracted";
  def.registryContentHash = undefined;
  def.lastValidatedAt = "2026-04-29T11:00:00.000Z";
  augmentDefsMod.writeAugmentDef(def);

  // Cache should reflect the mutation via the mirror
  cached = cacheStoreMod.readCache("rmw-pattern");
  assert.equal(cached?.registryStatus, "retracted",
    "mirror must propagate registryStatus mutation");
  assert.equal(cached?.contentHash, undefined,
    "mirror must propagate registryContentHash → undefined (delete)");
  assert.equal(cached?.fetchedAt, "2026-04-29T11:00:00.000Z",
    "mirror must propagate lastValidatedAt → fetchedAt");
});

// ─────────────────────────────────────────────────────────────
// Modded registry def: cache routing + overlay routing
// (verifies dual-routing for the "user has mods on a registry augment" case)
// ─────────────────────────────────────────────────────────────

test("modded registry def routes to BOTH cache (registry state) AND defs (overlay)", async () => {
  await freshHome();
  augmentDefsMod.writeAugmentDef(legacyRegistryDef("modded-route", {
    modded: true,
    registryStatus: "active",
    registryContentHash: "upstream-hash",
    rules: { content: "MY MOD", version: "1.0.0", marker: "modded-route" },
    rulesUpstream: { content: "UPSTREAM RULES", version: "1.0.0", marker: "modded-route" },
  }));

  const cached = cacheStoreMod.readCache("modded-route");
  assert.equal(cached?.registryStatus, "active");
  assert.equal(cached?.contentHash, "upstream-hash");
  // Cache rules: legacy mirror writes rulesUpstream for modded augments (so
  // cache reflects what the registry has, not the user's mod)
  assert.equal(cached?.rules?.content, "UPSTREAM RULES",
    "modded-augment cache stores upstream rules, not the mod");

  // The mod itself goes to defs/<name>.json as kind=overlay
  const defsStoreMod = await import("../dist/lib/defs-store.js");
  const overlay = defsStoreMod.readDef("modded-route");
  assert.equal(overlay?.kind, "overlay");
  assert.equal(overlay?.rules?.content, "MY MOD");
});
