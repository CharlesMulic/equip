"use strict";

// Cross-store routing characterization for applyRegistryRetraction.
//
// Companion to registry-refresh-cross-store-routing.test.js. Pins the
// post-retraction state across BOTH legacy + new stores for each branch
// of applyRegistryRetraction.
//
// Branches covered:
//   - Pure registry augment (no overlay): cache deleted, install removed,
//     legacy def marked retracted
//   - Modded registry augment (overlay): cache deleted, defs/<name>.json
//     becomes frozen-LocalDef with frozen_from_retraction marker, install removed
//   - Already-retracted (idempotent): only lastValidatedAt updates if changed
//   - Non-public registry status: skipped, only timestamp updated
//   - Missing local state: missing-local result, no writes
//
// **Pkg 06 batch 2 contract:** when applyRegistryRetraction's writes go
// directly to the new stores (instead of via legacy + dual-write mirror),
// the same end-state across cache + defs + installs must be observable.
//
// Test isolation via EQUIP_HOME (ENG-0031).

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { writeAugmentDef } = require("../dist/lib/augment-defs");
const { writeInstallations } = require("../dist/lib/installations");
const { readDef } = require("../dist/lib/defs-store");
const { readCache } = require("../dist/lib/cache-store");
const { readInstall } = require("../dist/lib/installs-store");
const {
  applyRegistryRetraction,
  resetRefreshValidationStateForTests,
} = require("../dist/lib/registry-refresh");

let originalEquipHome;
let tempHome;

function setupTempHome() {
  originalEquipHome = process.env.EQUIP_HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-retract-cross-"));
  process.env.EQUIP_HOME = tempHome;
  resetRefreshValidationStateForTests();
}

function teardownTempHome() {
  if (originalEquipHome === undefined) delete process.env.EQUIP_HOME;
  else process.env.EQUIP_HOME = originalEquipHome;
  resetRefreshValidationStateForTests();
  fs.rmSync(tempHome, { recursive: true, force: true });
}

function writeRegistryDef(name, overrides = {}) {
  writeAugmentDef({
    name,
    source: "registry",
    title: name,
    description: "test",
    transport: "http",
    serverUrl: `https://example.com/${name}`,
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    registryContentHash: `hash-${name}`,
    registryEtag: `etag-${name}`,
    registryVersionNumber: 1,
    registryStatus: "active",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  });
}

function writeInstall(name) {
  writeInstallations({
    lastUpdated: "2026-04-01T00:00:00Z",
    augments: {
      [name]: {
        source: "registry",
        title: name,
        transport: "http",
        serverUrl: `https://example.com/${name}`,
        installedAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
        platforms: [],
        artifacts: {},
      },
    },
  });
}

describe("applyRegistryRetraction — cross-store routing characterization", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("pure registry augment (no overlay): cache deleted + install record gone after retraction", async () => {
    writeRegistryDef("pure-aug");
    writeInstall("pure-aug");

    // Before: dual-write mirror should have populated the cache + install on the writes above.
    const cacheBefore = readCache("pure-aug");
    const installBefore = readInstall("pure-aug");
    assert.ok(cacheBefore, "cache populated by dual-write on writeAugmentDef");
    assert.ok(installBefore, "installs/ populated by dual-write on writeInstallations");

    const result = await applyRegistryRetraction("pure-aug");
    assert.equal(result.status, "retracted");
    assert.equal(result.retracted, true);
    assert.equal(result.changed, true);

    // Cache deleted by the new-store orchestrator.
    assert.equal(readCache("pure-aug"), null,
      "cache entry must be deleted after retraction of pure-registry augment");
    // Install record deleted.
    assert.equal(readInstall("pure-aug"), null,
      "install record must be deleted after retraction");
    // No defs entry for pure-registry — was never created (registry augments live in cache only).
    assert.equal(readDef("pure-aug"), null,
      "no defs entry for pure-registry — overlay-promote-to-frozen only fires when overlay exists");
  });

  it("modded registry augment: cache deleted + defs/ becomes frozen-LocalDef preserving user mods", async () => {
    writeRegistryDef("modded-aug", {
      modded: true,
      moddedFields: ["rules"],
      rules: { content: "MY MODDED RULES", version: "1.0.0", marker: "modded-aug" },
      rulesUpstream: { content: "ORIGINAL UPSTREAM", version: "1.0.0", marker: "modded-aug" },
    });
    writeInstall("modded-aug");

    // Before: dual-write created BOTH cache (registry state) AND overlay defs entry.
    const cacheBefore = readCache("modded-aug");
    const overlayBefore = readDef("modded-aug");
    assert.equal(overlayBefore?.kind, "overlay", "modded registry has overlay defs entry");
    assert.ok(cacheBefore, "cache populated");

    const result = await applyRegistryRetraction("modded-aug");
    assert.equal(result.status, "retracted");
    assert.equal(result.changed, true);

    // Cache deleted; overlay promoted to frozen-LocalDef.
    assert.equal(readCache("modded-aug"), null, "cache deleted after retraction");
    const frozen = readDef("modded-aug");
    assert.equal(frozen?.kind, "local", "overlay promoted to kind=local");
    assert.ok(frozen?.frozen_from_retraction, "frozen-from-retraction marker set");
    // User mods preserved on the frozen def.
    assert.equal(frozen?.rules?.content, "MY MODDED RULES",
      "user's modded rules survive retraction (the load-bearing reason for the orchestrator)");
    // Install record deleted.
    assert.equal(readInstall("modded-aug"), null, "install record deleted");
  });

  it("idempotent: re-running retraction on already-retracted augment is a no-op", async () => {
    writeRegistryDef("twice");
    writeInstall("twice");

    const first = await applyRegistryRetraction("twice");
    assert.equal(first.status, "retracted");
    assert.equal(first.changed, true);

    const cacheAfterFirst = readCache("twice");
    const installAfterFirst = readInstall("twice");
    assert.equal(cacheAfterFirst, null);
    assert.equal(installAfterFirst, null);

    const second = await applyRegistryRetraction("twice");
    assert.equal(second.status, "retracted");
    assert.equal(second.changed, false, "second retraction reports no change");
    assert.equal(second.retracted, true);
  });

  it("non-public registry status (pending-review): skipped path, only timestamp updates", async () => {
    writeRegistryDef("pending", { registryStatus: "pending-review" });
    writeInstall("pending");

    const cacheBefore = readCache("pending");
    const installBefore = readInstall("pending");

    const result = await applyRegistryRetraction("pending");
    assert.equal(result.status, "skipped");
    assert.equal(result.changed, false);
    assert.equal(result.retracted, false);

    // Cache + install still present (skipped path doesn't retract).
    const cacheAfter = readCache("pending");
    const installAfter = readInstall("pending");
    assert.ok(cacheAfter, "non-public-status retraction skipped — cache preserved");
    assert.ok(installAfter, "non-public-status retraction skipped — install preserved");
    // registryStatus preserved.
    assert.equal(cacheAfter.registryStatus, "pending-review");
    // lastValidatedAt updated on both (mirror routes def.lastValidatedAt → cache.fetchedAt).
    assert.ok(cacheAfter.fetchedAt, "cache.fetchedAt updates on skipped path");
  });

  it("missing local state: missing-local result, no writes", async () => {
    // No def, no install for this name.
    const result = await applyRegistryRetraction("nonexistent");
    assert.equal(result.status, "missing-local");
    assert.equal(result.changed, false);
    assert.equal(result.retracted, false);

    // No new-store entries created.
    assert.equal(readDef("nonexistent"), null);
    assert.equal(readCache("nonexistent"), null);
    assert.equal(readInstall("nonexistent"), null);
  });

  it("retracted-with-no-install (edge): legacy def marked retracted but no install record exists", async () => {
    // Edge case: a previously-installed augment was uninstalled but the def
    // file remained as a registry record. Then registry retracts it.
    writeRegistryDef("def-only", { registryStatus: "active" });
    // No writeInstall — the augment is known to the def store but not installed.

    const cacheBefore = readCache("def-only");
    assert.ok(cacheBefore, "cache populated even without install");

    const result = await applyRegistryRetraction("def-only");
    assert.equal(result.status, "retracted");
    // No install to remove + no overlay to preserve → cache-deleted is the orchestrator outcome.
    assert.equal(readCache("def-only"), null,
      "cache deleted when retraction fires with no install or overlay");
  });
});
