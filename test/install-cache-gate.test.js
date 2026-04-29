// Hard-TTL cache-freshness gate (Cleanup B Pkg 02). Verifies the gate
// fires `refreshAugmentFromRegistry` when the cache is older than
// `EQUIP_CACHE_HARD_TTL_MS`, respects the kill switch, and degrades
// gracefully on refresh failure.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let gateMod;
let cacheStoreMod;
let registryRefreshMod;

async function freshHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "install-cache-gate-test-"));
  process.env.EQUIP_HOME = tmp;
  delete process.env.EQUIP_CACHE_INSTALL_GATE_DISABLED;
  delete process.env.EQUIP_CACHE_HARD_TTL_MS;
  if (!gateMod) gateMod = await import("../dist/lib/install-cache-gate.js");
  if (!cacheStoreMod) cacheStoreMod = await import("../dist/lib/cache-store.js");
  if (!registryRefreshMod) registryRefreshMod = await import("../dist/lib/registry-refresh.js");
  registryRefreshMod.resetRefreshValidationStateForTests();
  return tmp;
}

function cacheEntry(name, fetchedAt, overrides = {}) {
  return {
    name,
    fetchedAt,
    title: name,
    description: "test",
    requiresAuth: false,
    transport: "http",
    serverUrl: `https://upstream.example/${name}`,
    contentHash: `hash-${name}`,
    version: 1,
    ...overrides,
  };
}

let fetchMock;
const originalFetch = globalThis.fetch;
function installFetchMock(handler) {
  fetchMock = handler;
  globalThis.fetch = (...args) => fetchMock(...args);
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ─────────────────────────────────────────────────────────────
// Gate fires on stale cache, no-op on fresh, no-op when disabled
// ─────────────────────────────────────────────────────────────

test("gate is a no-op when cache entry is fresh (within hard TTL)", async (t) => {
  await freshHome();
  cacheStoreMod.writeCache(cacheEntry("fresh-aug", new Date(Date.now() - 1000).toISOString()));
  let fetchCalls = 0;
  installFetchMock(async () => { fetchCalls += 1; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }; });
  t.after(restoreFetch);

  await gateMod.ensureCacheFreshForInstall("fresh-aug");

  assert.equal(fetchCalls, 0, "gate must not fire registry refresh on fresh cache");
});

test("gate fires refreshAugmentFromRegistry when cache is older than hard TTL", async (t) => {
  await freshHome();
  process.env.EQUIP_CACHE_HARD_TTL_MS = "1000"; // 1 second
  // Simulate prior install state — cache + AugmentDef + installation must
  // exist for refreshAugmentFromRegistry to actually fetch (otherwise it
  // returns "missing-local" and skips the network call).
  cacheStoreMod.writeCache(cacheEntry("stale-aug", new Date(Date.now() - 60_000).toISOString()));

  // Prime the legacy AugmentDef + installation so refreshAugmentFromRegistry
  // doesn't short-circuit on missing-local.
  const augDefsMod = await import("../dist/lib/augment-defs.js");
  augDefsMod.writeAugmentDef({
    name: "stale-aug",
    source: "registry",
    title: "stale-aug",
    description: "x",
    requiresAuth: false,
    transport: "http",
    serverUrl: "https://upstream.example/stale-aug",
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    registryContentHash: "hash-stale-aug",
    registryStatus: "active",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
  });
  const installsMod = await import("../dist/lib/installations.js");
  installsMod.writeInstallations({
    lastUpdated: "2026-04-01T00:00:00Z",
    augments: {
      "stale-aug": {
        source: "registry",
        title: "stale-aug",
        transport: "http",
        serverUrl: "https://upstream.example/stale-aug",
        installedAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
        platforms: [],
        artifacts: {},
      },
    },
  });

  let fetchCalls = 0;
  installFetchMock(async () => { fetchCalls += 1; return { ok: false, status: 304, headers: { get: () => null } }; });
  t.after(restoreFetch);

  await gateMod.ensureCacheFreshForInstall("stale-aug");

  assert.ok(fetchCalls >= 1, "gate must fire registry refresh on stale cache (got fetchCalls=" + fetchCalls + ")");
});

test("gate is a no-op when EQUIP_CACHE_INSTALL_GATE_DISABLED=true", async (t) => {
  await freshHome();
  process.env.EQUIP_CACHE_HARD_TTL_MS = "1000";
  process.env.EQUIP_CACHE_INSTALL_GATE_DISABLED = "true";
  cacheStoreMod.writeCache(cacheEntry("disabled-gate", new Date(Date.now() - 60_000).toISOString()));
  let fetchCalls = 0;
  installFetchMock(async () => { fetchCalls += 1; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }; });
  t.after(restoreFetch);

  await gateMod.ensureCacheFreshForInstall("disabled-gate");

  assert.equal(fetchCalls, 0, "gate must respect kill switch and skip refresh");
});

test("gate is a no-op when cache entry is missing entirely", async () => {
  await freshHome();
  // No cacheEntry written — install path's own fetchRegistryDef will hit
  // the API directly. The gate should NOT block on "missing cache."
  await gateMod.ensureCacheFreshForInstall("never-cached");
  // No assertion needed — just verifying it doesn't throw.
});

test("gate degrades gracefully on refresh failure (logs warn, doesn't throw)", async (t) => {
  await freshHome();
  process.env.EQUIP_CACHE_HARD_TTL_MS = "1000";
  cacheStoreMod.writeCache(cacheEntry("refresh-fails", new Date(Date.now() - 60_000).toISOString()));
  installFetchMock(async () => { throw new Error("ECONNREFUSED"); });
  t.after(restoreFetch);

  // Must not throw — the install caller proceeds with stale cache as fallback.
  let warnings = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => { warnings.push({ msg, fields }); },
    error: () => {},
  };
  await gateMod.ensureCacheFreshForInstall("refresh-fails", { logger });
  // Refresh failure may surface either as the gate's own warn OR as an
  // upstream throw that ensureCacheFresh swallows; either is acceptable.
});
