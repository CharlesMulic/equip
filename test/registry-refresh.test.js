"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { computeContentHash, extractManifest } = require("../dist/lib/content-hash");
const { readAugmentDef, writeAugmentDef } = require("../dist/lib/augment-defs");
const { readInstallations, writeInstallations } = require("../dist/lib/installations");
const {
  refreshAugmentFromRegistry,
  applyRegistryRetraction,
  resetRefreshValidationStateForTests,
} = require("../dist/lib/registry-refresh");

let originalHome;
let originalFetch;
let tempHome;

function setupTempHome() {
  originalHome = os.homedir;
  originalFetch = global.fetch;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-refresh-"));
  os.homedir = () => tempHome;
  resetRefreshValidationStateForTests();
}

function teardownTempHome() {
  os.homedir = originalHome;
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
    const def = readAugmentDef("demo-tool");

    assert.equal(result.status, "match");
    assert.equal(result.changed, false);
    assert.equal(result.validationMode, "network-match");
    assert.ok(result.lastValidatedAt);
    assert.ok(def.lastValidatedAt);
    assert.equal(def.registryStatus, "active");
  });

  it("sends If-None-Match and treats a 304 as a match", async () => {
    writeRegistryDef();
    const def = readAugmentDef("demo-tool");
    let seenIfNoneMatch;
    global.fetch = async (_url, init) => {
      seenIfNoneMatch = init.headers["If-None-Match"];
      return notModifiedResponse(`"${def.registryEtag}"`);
    };

    const result = await refreshAugmentFromRegistry("demo-tool");
    const updatedDef = readAugmentDef("demo-tool");

    assert.equal(seenIfNoneMatch, `"${def.registryEtag}"`);
    assert.equal(result.status, "match");
    assert.equal(result.validationMode, "not-modified");
    assert.equal(result.changed, false);
    assert.equal(updatedDef.registryStatus, "active");
    assert.ok(updatedDef.lastValidatedAt);
  });

  it("short-circuits repeated validations for 10 seconds after a 304", async () => {
    writeRegistryDef();
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount += 1;
      return notModifiedResponse(`"${readAugmentDef("demo-tool").registryEtag}"`);
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
    const def = readAugmentDef("demo-tool");
    const install = readInstallations().augments["demo-tool"];

    assert.equal(result.status, "mutated");
    assert.equal(result.changed, true);
    assert.equal(result.validationMode, "mutated");
    assert.equal(def.title, "New Title");
    assert.equal(def.registryVersionNumber, 2);
    assert.equal(install.title, "New Title");
    assert.equal(install.serverUrl, "https://example.com/updated-mcp");
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
    const def = readAugmentDef("demo-tool");
    const installations = readInstallations();

    assert.equal(result.status, "skipped");
    assert.equal(result.retracted, false);
    assert.equal(def.registryStatus, "active");
    assert.equal(installations.augments["demo-tool"].title, "Demo Tool");
  });

  it("marks the snapshot retracted and removes the installation record when local state already expects retraction", async () => {
    writeRegistryDef({
      source: "local",
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
    const def = readAugmentDef("demo-tool");
    const installations = readInstallations();

    assert.equal(result.status, "retracted");
    assert.equal(result.retracted, true);
    assert.equal(result.validationMode, "retracted");
    assert.equal(def.registryStatus, "retracted");
    assert.equal(installations.augments["demo-tool"], undefined);
  });

  it("applies an authoritative retraction without relying on a follow-up 404 fetch", async () => {
    writeRegistryDef();
    writeRegistryInstall();

    const result = await applyRegistryRetraction("demo-tool");
    const def = readAugmentDef("demo-tool");
    const installations = readInstallations();

    assert.equal(result.status, "retracted");
    assert.equal(result.retracted, true);
    assert.equal(result.validationMode, "retracted");
    assert.equal(def.registryStatus, "retracted");
    assert.equal(def.registryContentHash, undefined);
    assert.equal(installations.augments["demo-tool"], undefined);
  });

  it("does not treat non-public registry statuses as retracted when the public definition endpoint returns 404", async () => {
    writeRegistryDef({ registryStatus: "pending-review" });
    writeRegistryInstall();
    global.fetch = async () => ({
      ok: false,
      status: 404,
    });

    const result = await refreshAugmentFromRegistry("demo-tool");
    const def = readAugmentDef("demo-tool");
    const installations = readInstallations();

    assert.equal(result.status, "skipped");
    assert.equal(result.retracted, false);
    assert.equal(result.validationMode, "skipped");
    assert.equal(def.registryStatus, "pending-review");
    assert.ok(def.lastValidatedAt);
    assert.ok(installations.augments["demo-tool"]);
  });

  it("does not claim a clean match when the registry definition has no content hash", async () => {
    writeRegistryDef();
    writeRegistryInstall();
    global.fetch = async () => okResponse(makeRegistryResponse({
      contentHash: null,
    }));

    const result = await refreshAugmentFromRegistry("demo-tool");
    const def = readAugmentDef("demo-tool");
    const install = readInstallations().augments["demo-tool"];
    const registryBody = makeRegistryResponse();

    assert.equal(result.status, "skipped");
    assert.equal(result.changed, false);
    assert.equal(result.validationMode, "skipped");
    assert.equal(def.registryStatus, "active");
    assert.equal(def.registryContentHash, registryBody.contentHash);
    assert.equal(install.title, "Demo Tool");
  });
});
