// ETag conditional-refresh round-trip + refresh-counter tests (Pkg 03).
//
// Existing `test/registry-refresh.test.js` covers the request-side ETag
// (If-None-Match sent, 304 handled). This file covers what Pkg 03 adds on top:
//   - The new equip_cache_refresh_total counter records 200/304/error correctly.
//   - The cache-store side captures + carries ETag through dual-write so the
//     next refresh sends it.

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { computeContentHash, extractManifest } = require("../dist/lib/content-hash");
const { readAugmentDef, writeAugmentDef } = require("../dist/lib/augment-defs");
const { readCache } = require("../dist/lib/cache-store");
const {
  refreshAugmentFromRegistry,
  resetRefreshValidationStateForTests,
} = require("../dist/lib/registry-refresh");

let originalEquipHome;
let originalFetch;
let tempHome;

function setupTempHome() {
  originalEquipHome = process.env.EQUIP_HOME;
  originalFetch = global.fetch;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-etag-"));
  process.env.EQUIP_HOME = tempHome;
  resetRefreshValidationStateForTests();
}

function teardownTempHome() {
  if (originalEquipHome === undefined) delete process.env.EQUIP_HOME;
  else process.env.EQUIP_HOME = originalEquipHome;
  global.fetch = originalFetch;
  resetRefreshValidationStateForTests();
  fs.rmSync(tempHome, { recursive: true, force: true });
}

function makeRegistryResponse(overrides = {}) {
  const body = {
    name: "etag-tool",
    title: "ETag Tool",
    description: "demo",
    installMode: "direct",
    transport: "http",
    serverUrl: "https://example.com/mcp",
    requiresAuth: false,
    skills: [],
    version: 1,
    ...overrides,
  };
  if (body.contentHash === undefined) {
    body.contentHash = computeContentHash(extractManifest(body));
  }
  return body;
}

function writeRegistryDef(overrides = {}) {
  const body = makeRegistryResponse();
  writeAugmentDef({
    name: "etag-tool",
    source: "registry",
    title: "ETag Tool",
    description: "demo",
    transport: "http",
    serverUrl: "https://example.com/mcp",
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    registryContentHash: body.contentHash,
    registryEtag: '"server-etag-v1"',
    registryVersionNumber: 1,
    registryStatus: "active",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  });
}

function okResponse(body, etag) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => (name.toLowerCase() === "etag" ? (etag ?? null) : null),
    },
    json: async () => body,
  };
}

function notModifiedResponse(etag) {
  return {
    ok: false,
    status: 304,
    headers: {
      get: (name) => (name.toLowerCase() === "etag" ? etag : null),
    },
  };
}

describe("Pkg 03 — ETag round-trip + refresh counter", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("emits equip_cache_refresh_total{result=304} when registry returns Not Modified", async () => {
    writeRegistryDef();
    global.fetch = async () => notModifiedResponse('"server-etag-v1"');

    const events = [];
    const counter = (n, l) => events.push({ n, l });
    await refreshAugmentFromRegistry("etag-tool", { counter });

    const refresh = events.filter((e) => e.n === "equip_cache_refresh_total");
    assert.deepEqual(refresh, [{ n: "equip_cache_refresh_total", l: { result: "304" } }]);
  });

  it("emits equip_cache_refresh_total{result=200} when registry returns content (mutated)", async () => {
    writeRegistryDef({ title: "Old" });
    global.fetch = async () => okResponse(makeRegistryResponse({ title: "New", version: 2 }), '"server-etag-v2"');

    const events = [];
    const counter = (n, l) => events.push({ n, l });
    await refreshAugmentFromRegistry("etag-tool", { counter });

    const refresh = events.filter((e) => e.n === "equip_cache_refresh_total");
    assert.deepEqual(refresh, [{ n: "equip_cache_refresh_total", l: { result: "200" } }]);
  });

  it("emits equip_cache_refresh_total{result=error} when fetch throws", async () => {
    writeRegistryDef();
    global.fetch = async () => { throw new Error("ECONNRESET"); };

    const events = [];
    const counter = (n, l) => events.push({ n, l });
    await assert.rejects(refreshAugmentFromRegistry("etag-tool", { counter }), /ECONNRESET/);

    const refresh = events.filter((e) => e.n === "equip_cache_refresh_total");
    assert.deepEqual(refresh, [{ n: "equip_cache_refresh_total", l: { result: "error" } }]);
  });

  it("dual-write: ETag captured by cache-store on 200 (next refresh can use it via legacy field)", async () => {
    // Registry strips quotes from the ETag header before storing — what's persisted
    // is the bare token, which the next request re-quotes for If-None-Match.
    writeRegistryDef({ registryEtag: undefined });
    global.fetch = async () => okResponse(
      makeRegistryResponse({ title: "Updated", version: 2 }),
      '"server-etag-v2"',
    );

    await refreshAugmentFromRegistry("etag-tool");
    const def = readAugmentDef("etag-tool");
    assert.equal(def.registryEtag, "server-etag-v2", "legacy AugmentDef captures ETag for round-trip");

    const cache = readCache("etag-tool");
    assert.ok(cache, "cache-store has dual-write entry");
    assert.equal(cache.etag, "server-etag-v2", "cache-store's ETag mirror matches");
  });

  it("conditional refresh round-trip: first call sends no If-None-Match, second sends ETag from prior response", async () => {
    writeRegistryDef({ registryEtag: undefined, registryContentHash: undefined });

    let firstIfNoneMatch = "__not-set__";
    let secondIfNoneMatch = "__not-set__";
    let call = 0;
    global.fetch = async (_url, init) => {
      call += 1;
      const ifNoneMatch = init?.headers?.["If-None-Match"];
      if (call === 1) {
        firstIfNoneMatch = ifNoneMatch;
        return okResponse(makeRegistryResponse({ title: "Updated", version: 2 }), '"server-etag-fresh"');
      }
      secondIfNoneMatch = ifNoneMatch;
      return notModifiedResponse('"server-etag-fresh"');
    };

    await refreshAugmentFromRegistry("etag-tool");
    // Manually expire the in-memory short-circuit so the second refresh
    // actually hits the network — registry-refresh's 10s short-circuit would
    // otherwise prevent a second fetch.
    resetRefreshValidationStateForTests();
    await refreshAugmentFromRegistry("etag-tool");

    assert.equal(call, 2, "fetch was called twice (no short-circuit)");
    assert.equal(firstIfNoneMatch, undefined, "first call sends no If-None-Match");
    // Registry stores ETag without quotes, re-quotes it for If-None-Match.
    assert.equal(secondIfNoneMatch, '"server-etag-fresh"', "second call sends ETag (re-quoted) from prior response");
  });
});
