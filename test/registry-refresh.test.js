"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { computeContentHash, extractManifest } = require("../dist/lib/content-hash");
// Cleanup B Pkg 06 batch 2 phase 1 (test rewrite, 2026-04-29): assertions
// migrated from legacy AugmentDef + installations.json reads to new
// cache-store + installs-store reads. Setup helpers below still call
// writeAugmentDef + writeInstallations, which dual-write to both stores
// during phase 1; once batch 2g deletes the legacy modules, the setup
// helpers will be migrated to writeCache + writeInstall directly.
const { writeAugmentDef } = require("../dist/lib/augment-defs");
const { writeInstallations } = require("../dist/lib/installations");
const { readCache } = require("../dist/lib/cache-store");
const { readInstall } = require("../dist/lib/installs-store");
const {
  refreshAugmentFromRegistry,
  applyRegistryRetraction,
  resetRefreshValidationStateForTests,
} = require("../dist/lib/registry-refresh");

let originalEquipHome;
let originalFetch;
let tempHome;

// Test isolation via EQUIP_HOME env var (ENG-0031). Pre-ENG-0031 this used
// `os.homedir = () => tempHome` monkey-patching, which is process-global and
// survives a thrown test before teardown — a real source of cross-test
// contamination that contributed to the 2026-04-26 incident where a user's
// real ~/.equip/installations.json got wiped during a test run.
function setupTempHome() {
  originalEquipHome = process.env.EQUIP_HOME;
  originalFetch = global.fetch;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-refresh-"));
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
  return {
    ok: true,
    status: 200,
    headers: {
      get: () => null,
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

describe("refreshAugmentFromRegistry", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("returns match and records lastValidatedAt when the version is unchanged", async () => {
    writeRegistryDef();
    global.fetch = async () => okResponse(makeRegistryResponse());

    const result = await refreshAugmentFromRegistry("demo-tool");
    const cache = readCache("demo-tool");

    assert.equal(result.status, "match");
    assert.equal(result.changed, false);
    assert.equal(result.validationMode, "network-match");
    assert.ok(result.lastValidatedAt);
    assert.ok(cache.fetchedAt);
    assert.equal(cache.registryStatus, "active");
  });

  it("sends If-None-Match and treats a 304 as a match", async () => {
    writeRegistryDef();
    const initialCache = readCache("demo-tool");
    let seenIfNoneMatch;
    global.fetch = async (_url, init) => {
      seenIfNoneMatch = init.headers["If-None-Match"];
      return notModifiedResponse(`"${initialCache.etag}"`);
    };

    const result = await refreshAugmentFromRegistry("demo-tool");
    const updatedCache = readCache("demo-tool");

    assert.equal(seenIfNoneMatch, `"${initialCache.etag}"`);
    assert.equal(result.status, "match");
    assert.equal(result.validationMode, "not-modified");
    assert.equal(result.changed, false);
    assert.equal(updatedCache.registryStatus, "active");
    assert.ok(updatedCache.fetchedAt);
  });

  it("short-circuits repeated validations for 10 seconds after a 304", async () => {
    writeRegistryDef();
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount += 1;
      return notModifiedResponse(`"${readCache("demo-tool").etag}"`);
    };

    const first = await refreshAugmentFromRegistry("demo-tool");
    const second = await refreshAugmentFromRegistry("demo-tool");

    assert.equal(first.validationMode, "not-modified");
    assert.equal(second.validationMode, "short-circuit");
    assert.equal(fetchCount, 1);
  });

  it("updates the local snapshot and installation metadata when the registry changes", async () => {
    writeRegistryDef({ title: "Old Title" });
    writeRegistryInstall({ title: "Old Title" });
    global.fetch = async () => okResponse(makeRegistryResponse({
      title: "New Title",
      description: "updated",
      version: 2,
      serverUrl: "https://example.com/updated-mcp",
    }));

    const result = await refreshAugmentFromRegistry("demo-tool");
    const cache = readCache("demo-tool");
    const install = readInstall("demo-tool");

    assert.equal(result.status, "mutated");
    assert.equal(result.changed, true);
    assert.equal(result.validationMode, "mutated");
    // Title + serverUrl come from cache (publisher metadata + transport),
    // not from the install record (post-Pkg-06: install record holds only
    // installedAt + updatedAt + platforms + artifacts).
    assert.equal(cache.title, "New Title");
    assert.equal(cache.version, 2);
    assert.equal(cache.serverUrl, "https://example.com/updated-mcp");
    assert.ok(install.updatedAt);
  });

  it("preserves active local state on an ambiguous 404 from the public definition endpoint", async () => {
    writeRegistryDef();
    writeRegistryInstall();
    global.fetch = async () => ({
      ok: false,
      status: 404,
    });

    const result = await refreshAugmentFromRegistry("demo-tool");
    const cache = readCache("demo-tool");
    const install = readInstall("demo-tool");

    assert.equal(result.status, "skipped");
    assert.equal(result.retracted, false);
    assert.equal(cache.registryStatus, "active");
    // Augment still tracked + content (title) preserved on cache.
    assert.ok(install);
    assert.equal(cache.title, "Demo Tool");
  });

  it("marks the snapshot retracted and removes the installation record when local state already expects retraction", async () => {
    // Setup: cache already in retracted state (e.g., a previous refresh
    // round-trip retracted it but kept the cache as a tombstone-equivalent).
    // Pre-Pkg-06: this scenario was expressed via source=local + registryStatus
    // =retracted on the legacy AugmentDef. Post-Pkg-06: the registry-tracking
    // fields live on cache; the same logical state is `cache.registryStatus =
    // "retracted"` with cleared hash/version.
    writeRegistryDef({
      registryStatus: "retracted",
      registryContentHash: undefined,
      registryVersionNumber: undefined,
    });
    writeRegistryInstall();
    global.fetch = async () => ({
      ok: false,
      status: 404,
    });

    const result = await refreshAugmentFromRegistry("demo-tool");
    // Pure-registry retraction: cache deleted by the orchestrator; install record gone.
    // (For modded augments, defs/<name>.json would have been promoted to a
    // frozen-LocalDef instead — see registry-retraction-cross-store-routing.test.js.)
    const cache = readCache("demo-tool");
    const install = readInstall("demo-tool");

    assert.equal(result.status, "retracted");
    assert.equal(result.retracted, true);
    assert.equal(result.validationMode, "retracted");
    // Cache deleted as part of the orchestrator's pure-registry retraction outcome.
    assert.equal(cache, null);
    assert.equal(install, null);
  });

  it("applies an authoritative retraction without relying on a follow-up 404 fetch", async () => {
    writeRegistryDef();
    writeRegistryInstall();

    const result = await applyRegistryRetraction("demo-tool");
    const cache = readCache("demo-tool");
    const install = readInstall("demo-tool");

    assert.equal(result.status, "retracted");
    assert.equal(result.retracted, true);
    assert.equal(result.validationMode, "retracted");
    // Pure-registry retraction outcome: cache deleted, install removed.
    assert.equal(cache, null);
    assert.equal(install, null);
  });

  it("does not treat non-public registry statuses as retracted when the public definition endpoint returns 404", async () => {
    writeRegistryDef({ registryStatus: "pending-review" });
    writeRegistryInstall();
    global.fetch = async () => ({
      ok: false,
      status: 404,
    });

    const result = await refreshAugmentFromRegistry("demo-tool");
    const cache = readCache("demo-tool");
    const install = readInstall("demo-tool");

    assert.equal(result.status, "skipped");
    assert.equal(result.retracted, false);
    assert.equal(result.validationMode, "skipped");
    assert.equal(cache.registryStatus, "pending-review");
    assert.ok(cache.fetchedAt);
    assert.ok(install);
  });

  it("does not claim a clean match when the registry definition has no content hash", async () => {
    writeRegistryDef();
    writeRegistryInstall();
    global.fetch = async () => okResponse(makeRegistryResponse({
      contentHash: null,
    }));

    const result = await refreshAugmentFromRegistry("demo-tool");
    const cache = readCache("demo-tool");
    const install = readInstall("demo-tool");
    const registryBody = makeRegistryResponse();

    assert.equal(result.status, "skipped");
    assert.equal(result.changed, false);
    assert.equal(result.validationMode, "skipped");
    assert.equal(cache.registryStatus, "active");
    assert.equal(cache.contentHash, registryBody.contentHash);
    assert.ok(install);
    assert.equal(cache.title, "Demo Tool");
  });
});
