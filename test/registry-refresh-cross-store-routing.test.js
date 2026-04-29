"use strict";

// Cache-state assertions for refreshAugmentFromRegistry per branch.
//
// **Pkg 06 batch 2a rewrite (2026-04-29):** previously these tests asserted
// the dual-write mirror routed legacy → cache correctly. After the
// migration, refreshAugmentFromRegistry writes directly to cache via
// mutateCache — the mirror is no longer the path. Tests now assert the
// post-refresh cache state per branch (which is what users + the resolver
// actually see).
//
// Companion to registry-refresh.test.js (per-branch return-value
// assertions). This file focuses on cache state mutations.
//
// Test isolation via EQUIP_HOME (ENG-0031).

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { computeContentHash, extractManifest } = require("../dist/lib/content-hash");
// Setup helpers below still call writeAugmentDef + writeInstallations during
// the dual-write era (pre-batch-2g). Once batch 2g deletes those modules,
// this file's setup helpers will be migrated to writeCache + writeInstall.
const { writeAugmentDef } = require("../dist/lib/augment-defs");
const { writeInstallations } = require("../dist/lib/installations");
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
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-refresh-cross-"));
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
    name: "demo-tool",
    title: "Demo Tool",
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
  const registryBody = makeRegistryResponse();
  writeAugmentDef({
    name: "demo-tool",
    source: "registry",
    title: "Demo Tool",
    description: "demo",
    transport: "http",
    serverUrl: "https://example.com/mcp",
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    registryContentHash: registryBody.contentHash,
    registryEtag: "registry-etag-v1",
    registryVersionNumber: 1,
    registryStatus: "active",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  });
}

function writeRegistryInstall(overrides = {}) {
  writeInstallations({
    lastUpdated: "2026-04-01T00:00:00Z",
    augments: {
      "demo-tool": {
        source: "registry",
        title: "Demo Tool",
        transport: "http",
        serverUrl: "https://example.com/mcp",
        installedAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
        platforms: [],
        artifacts: {},
        ...overrides,
      },
    },
  });
}

function okResponse(body) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
}

function notModifiedResponse(etag) {
  return {
    ok: false,
    status: 304,
    headers: { get: (name) => (name.toLowerCase() === "etag" ? etag : null) },
  };
}

describe("refreshAugmentFromRegistry — cross-store routing characterization", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("304 not-modified branch: cache.fetchedAt advances + registryStatus stays active", async () => {
    writeRegistryDef();
    const initialCache = readCache("demo-tool");
    global.fetch = async () => notModifiedResponse(`"${initialCache.etag}"`);

    const beforeFetchedAt = initialCache?.fetchedAt;

    await refreshAugmentFromRegistry("demo-tool");

    const updatedCache = readCache("demo-tool");

    assert.ok(updatedCache?.fetchedAt, "cache.fetchedAt must be present after 304");
    assert.notEqual(updatedCache.fetchedAt, beforeFetchedAt,
      "cache.fetchedAt must advance on each refresh");
    assert.equal(updatedCache.registryStatus, "active");
  });

  it("304 not-modified: cache.etag, cache.contentHash, cache.version preserved (not overwritten with undefined)", async () => {
    writeRegistryDef();
    const initialCache = readCache("demo-tool");
    global.fetch = async () => notModifiedResponse(`"${initialCache.etag}"`);

    const before = readCache("demo-tool");

    await refreshAugmentFromRegistry("demo-tool");

    const after = readCache("demo-tool");

    // All registry-tracking fields preserved across the 304 round-trip.
    assert.equal(after.etag, before.etag, "cache.etag preserved on 304");
    assert.equal(after.contentHash, before.contentHash, "cache.contentHash preserved on 304");
    assert.equal(after.version, before.version, "cache.version preserved on 304");
  });

  it("200 with changed content: cache reflects new contentHash, version, etag", async () => {
    // contentHash depends on serverUrl/stdio/rules/skills/hooks/transport per
    // extractManifest in src/lib/content-hash.ts — NOT on title/description/version.
    // Change serverUrl so contentHash actually differs and the full mutation path runs.
    writeRegistryDef({ title: "Old Title" });
    writeRegistryInstall({ title: "Old Title" });
    const newBody = makeRegistryResponse({
      title: "New Title", description: "updated", version: 2,
      serverUrl: "https://example.com/updated-mcp",
    });
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "etag" ? '"new-etag-v2"' : null) },
      json: async () => newBody,
    });

    const before = readCache("demo-tool");
    const beforeContentHash = before?.contentHash;

    await refreshAugmentFromRegistry("demo-tool");

    const updatedCache = readCache("demo-tool");

    assert.notEqual(updatedCache.contentHash, beforeContentHash,
      "cache.contentHash must advance on content change");
    assert.equal(updatedCache.contentHash, newBody.contentHash,
      "cache.contentHash matches new registry hash");
    assert.equal(updatedCache.version, 2);
    // validateAgainstRegistry strips the surrounding quotes from the ETag header.
    assert.equal(updatedCache.etag, "new-etag-v2", "cache.etag stored without surrounding quotes");
  });

  it("missing-content-hash skip branch: cache.etag cleared (so next refresh forces a body fetch)", async () => {
    // Publisher returns content without a hash — skipped path; etag is reset
    // so the next refresh sends without If-None-Match (forces a fresh body).
    writeRegistryDef();
    const newBody = makeRegistryResponse();
    delete newBody.contentHash; // NB: makeRegistryResponse fills it; explicitly clear.
    global.fetch = async () => okResponse(newBody);

    await refreshAugmentFromRegistry("demo-tool");

    const updatedCache = readCache("demo-tool");

    assert.equal(updatedCache?.etag, undefined,
      "cache.etag cleared on missing-content-hash so next refresh sends without If-None-Match");
  });

  it("short-circuit branch: cache.fetchedAt advances even though no network call happened", async () => {
    writeRegistryDef();
    const initialCache = readCache("demo-tool");
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount += 1;
      return notModifiedResponse(`"${initialCache.etag}"`);
    };

    // First call hits the network, primes the short-circuit cache.
    await refreshAugmentFromRegistry("demo-tool");
    const afterFirst = readCache("demo-tool");

    // Wait a beat so timestamps are different.
    await new Promise((r) => setTimeout(r, 10));

    // Second call short-circuits — but cache.fetchedAt still advances
    // (the freshness signal updates regardless of whether network was hit).
    await refreshAugmentFromRegistry("demo-tool");
    const afterSecond = readCache("demo-tool");

    assert.equal(fetchCount, 1, "second call short-circuited (no network)");
    assert.notEqual(afterSecond.fetchedAt, afterFirst.fetchedAt,
      "cache.fetchedAt advances even on short-circuit");
  });

  it("non-public registry status branch: cache.fetchedAt updates on skipped path; registryStatus preserved", async () => {
    // pending-review augments still touch fetchedAt to keep the doctor's
    // freshness signal accurate, even though the registry isn't queried.
    writeRegistryDef({ registryStatus: "pending-review" });
    let fetchCount = 0;
    global.fetch = async () => { fetchCount += 1; return okResponse(makeRegistryResponse()); };

    await refreshAugmentFromRegistry("demo-tool");

    assert.equal(fetchCount, 0, "non-public status skips the network");

    const updatedCache = readCache("demo-tool");

    assert.ok(updatedCache?.fetchedAt, "cache.fetchedAt updates on non-public skip");
    // registryStatus preserved (was "pending-review").
    assert.equal(updatedCache.registryStatus, "pending-review",
      "non-public status preserved through skipped refresh");
  });
});
