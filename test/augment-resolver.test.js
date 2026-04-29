// augment-resolver unit tests.
//
// Pkg 01 of equip-storage-refactor: pin the read-order contract over the
// three storage primitives. Pure-logic — uses mock stores, no filesystem.

import { test } from "node:test";
import { strict as assert } from "node:assert";

const { createResolver } = await import("../dist/lib/augment-resolver.js");

// Mock store factory — in-memory maps backing the read interfaces the
// resolver expects.

function mockStores() {
  const defs = new Map();
  const caches = new Map();
  const installs = new Map();
  return {
    defsStore: {
      readDef: (name) => defs.get(name) ?? null,
      listDefs: () => Array.from(defs.values()),
    },
    cacheStore: {
      readCache: (name) => caches.get(name) ?? null,
      listCache: () => Array.from(caches.values()),
    },
    installsStore: {
      readInstall: (name) => installs.get(name) ?? null,
      hasInstall: (name) => installs.has(name),
      listInstalls: () => Array.from(installs.values()),
    },
    // Expose for test setup
    _defs: defs,
    _caches: caches,
    _installs: installs,
  };
}

function localDef(name, overrides = {}) {
  return {
    name,
    kind: "local",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
    title: "Local Title",
    description: "Local Description",
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    ...overrides,
  };
}

function overlayDef(name, overrides = {}) {
  return {
    name,
    kind: "overlay",
    overlay_of: name,
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
    rules: { content: "modded", version: "1.0.0", marker: name },
    ...overrides,
  };
}

function wrappedDef(name, overrides = {}) {
  return {
    name,
    kind: "wrapped",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
    title: "Wrapped",
    description: "Auto-detected",
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    wrappedFrom: { type: "mcp", platform: "cursor" },
    ...overrides,
  };
}

function cacheDef(name, overrides = {}) {
  return {
    name,
    fetchedAt: "2026-04-28T10:00:00.000Z",
    title: "Cached Title",
    description: "Cached Description",
    requiresAuth: false,
    contentHash: "abc",
    version: 1,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Read order — the load-bearing contract
// ─────────────────────────────────────────────────────────────

test("rule 1: defs/local returns sovereign content; cache ignored even if present", () => {
  const stores = mockStores();
  stores._defs.set("rule1", localDef("rule1", { title: "Local Wins" }));
  stores._caches.set("rule1", cacheDef("rule1", { title: "Cache Loses" }));
  const r = createResolver(stores);
  const result = r.resolve("rule1");
  assert.equal(result?.source, "local");
  assert.equal(result?.defKind, "local");
  assert.equal(result?.title, "Local Wins");
  assert.equal(result?.hasCache, false, "local kind ignores cache even if present");
  assert.equal(result?.hasDef, true);
});

test("rule 2: defs/overlay merges with cache — overlay rules take precedence", () => {
  const stores = mockStores();
  stores._defs.set("rule2", overlayDef("rule2", { rules: { content: "MODDED", version: "1.0.0", marker: "rule2" } }));
  stores._caches.set("rule2", cacheDef("rule2", {
    title: "From Cache",
    description: "Cached Description",
    transport: "http",
    serverUrl: "https://cache.example/mcp",
    rules: { content: "ORIGINAL", version: "1.0.0", marker: "rule2" },
  }));
  const r = createResolver(stores);
  const result = r.resolve("rule2");
  assert.equal(result?.source, "overlay");
  assert.equal(result?.defKind, "overlay");
  // Overlay's rules win
  assert.equal(result?.rules?.content, "MODDED");
  // Non-overridable infrastructure from cache
  assert.equal(result?.transport, "http");
  assert.equal(result?.serverUrl, "https://cache.example/mcp");
  // Identity / display from cache
  assert.equal(result?.title, "From Cache");
  // Both stores contributed
  assert.equal(result?.hasDef, true);
  assert.equal(result?.hasCache, true);
});

test("rule 2: defs/overlay without cache returns overlay-only with warn (best-effort fallback)", () => {
  const stores = mockStores();
  stores._defs.set("rule2-no-cache", overlayDef("rule2-no-cache"));
  // No cache entry
  const r = createResolver(stores);
  const result = r.resolve("rule2-no-cache");
  assert.equal(result?.source, "overlay");
  assert.equal(result?.hasCache, false);
  // Falls back to overlay's rules + best-effort title
  assert.equal(result?.rules?.content, "modded");
  assert.equal(result?.title, "rule2-no-cache");
});

test("rule 3: defs/wrapped returns sovereign content with wrappedFrom provenance", () => {
  const stores = mockStores();
  stores._defs.set("rule3", wrappedDef("rule3", { wrappedFrom: { type: "mcp", platform: "cursor", path: "/foo" } }));
  stores._caches.set("rule3", cacheDef("rule3", { title: "Cache Should Be Ignored" }));
  const r = createResolver(stores);
  const result = r.resolve("rule3");
  assert.equal(result?.source, "wrapped");
  assert.equal(result?.defKind, "wrapped");
  assert.equal(result?.title, "Wrapped");
  assert.equal(result?.hasCache, false, "wrapped kind ignores cache");
  assert.deepEqual(result?.wrappedFrom, { type: "mcp", platform: "cursor", path: "/foo" });
});

test("rule 4: cache-only returns registry source (pure-registry-installed)", () => {
  const stores = mockStores();
  stores._caches.set("rule4", cacheDef("rule4", {
    title: "Pure Registry",
    transport: "http",
    serverUrl: "https://reg.example/mcp",
  }));
  const r = createResolver(stores);
  const result = r.resolve("rule4");
  assert.equal(result?.source, "registry");
  assert.equal(result?.defKind, undefined);
  assert.equal(result?.title, "Pure Registry");
  assert.equal(result?.transport, "http");
  assert.equal(result?.hasDef, false);
  assert.equal(result?.hasCache, true);
});

test("rule 5: neither defs nor cache returns null", () => {
  const stores = mockStores();
  const r = createResolver(stores);
  assert.equal(r.resolve("does-not-exist"), null);
});

// ─────────────────────────────────────────────────────────────
// Cache freshness metadata is exposed for downstream TTL checks (Pkg 03)
// ─────────────────────────────────────────────────────────────

test("resolved augment exposes cache freshness metadata for downstream TTL gating", () => {
  const stores = mockStores();
  stores._caches.set("freshness", cacheDef("freshness", {
    fetchedAt: "2026-04-28T09:00:00.000Z",
    etag: "W/\"deadbeef\"",
    version: 7,
    contentHash: "hash-7",
    registryStatus: "active",
    registryLatestContentHash: "newer-hash-8",
    registryLatestSecurityAdvisory: true,
  }));
  const r = createResolver(stores);
  const result = r.resolve("freshness");
  assert.equal(result?.cacheFetchedAt, "2026-04-28T09:00:00.000Z");
  assert.equal(result?.cacheEtag, "W/\"deadbeef\"");
  assert.equal(result?.cacheVersion, 7);
  assert.equal(result?.cacheContentHash, "hash-7");
  assert.equal(result?.cacheRegistryStatus, "active");
  assert.equal(result?.cacheRegistryLatestContentHash, "newer-hash-8");
  assert.equal(result?.cacheRegistryLatestSecurityAdvisory, true);
});

// ─────────────────────────────────────────────────────────────
// installs/ is read SEPARATELY from content
// ─────────────────────────────────────────────────────────────

test("isInstalled / getInstall read installs-store independently of content resolution", () => {
  const stores = mockStores();
  stores._caches.set("installed-aug", cacheDef("installed-aug"));
  stores._installs.set("installed-aug", {
    name: "installed-aug",
    installedAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
    platforms: ["claude-code"],
    artifacts: { "claude-code": { mcp: true } },
  });
  const r = createResolver(stores);
  assert.equal(r.isInstalled("installed-aug"), true);
  assert.equal(r.isInstalled("not-installed"), false);
  const inst = r.getInstall("installed-aug");
  assert.equal(inst?.platforms[0], "claude-code");
});

test("isInstalled does not require defs or cache to exist", () => {
  // Edge case: install record exists but the augment was somehow uninstalled
  // partway through (defs + cache cleared but installs/ still has the entry).
  // resolver should faithfully report what's in installs-store.
  const stores = mockStores();
  stores._installs.set("orphan-install", {
    name: "orphan-install",
    installedAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
    platforms: [],
    artifacts: {},
  });
  const r = createResolver(stores);
  assert.equal(r.isInstalled("orphan-install"), true);
  assert.equal(r.resolve("orphan-install"), null, "no content available — resolver returns null");
});

// ─────────────────────────────────────────────────────────────
// list() — union across all three stores
// ─────────────────────────────────────────────────────────────

test("list returns union of names across defs + cache + installs", () => {
  const stores = mockStores();
  stores._defs.set("only-defs", localDef("only-defs"));
  stores._caches.set("only-cache", cacheDef("only-cache"));
  stores._installs.set("only-installs", {
    name: "only-installs",
    installedAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
    platforms: [],
    artifacts: {},
  });
  // overlap: defs + cache for "shared"
  stores._defs.set("shared", overlayDef("shared"));
  stores._caches.set("shared", cacheDef("shared"));
  const r = createResolver(stores);
  const all = r.list();
  const names = all.map((a) => a.name).sort();
  assert.deepEqual(names, ["only-cache", "only-defs", "shared"]);
  // only-installs has no content (no defs, no cache) → resolver returns null
  // → not in the list
});

// ─────────────────────────────────────────────────────────────
// Source-derivation regression test (replaces def.source field)
// ─────────────────────────────────────────────────────────────

test("source field is derived correctly across all four cases", () => {
  const stores = mockStores();
  stores._defs.set("derive-local", localDef("derive-local"));
  stores._defs.set("derive-overlay", overlayDef("derive-overlay"));
  stores._caches.set("derive-overlay", cacheDef("derive-overlay"));
  stores._defs.set("derive-wrapped", wrappedDef("derive-wrapped"));
  stores._caches.set("derive-registry", cacheDef("derive-registry"));
  const r = createResolver(stores);
  assert.equal(r.resolve("derive-local")?.source, "local");
  assert.equal(r.resolve("derive-overlay")?.source, "overlay");
  assert.equal(r.resolve("derive-wrapped")?.source, "wrapped");
  assert.equal(r.resolve("derive-registry")?.source, "registry");
});

// ─────────────────────────────────────────────────────────────
// Pure-function property — same input, same output
// ─────────────────────────────────────────────────────────────

test("resolve is referentially transparent — same input produces deeply-equal output", () => {
  const stores = mockStores();
  stores._defs.set("pure", localDef("pure", { title: "Stable" }));
  const r = createResolver(stores);
  const a = r.resolve("pure");
  const b = r.resolve("pure");
  assert.deepEqual(a, b);
});
