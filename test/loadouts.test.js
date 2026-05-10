"use strict";

require("./_isolation");

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupEquipHome, setupFullHome } = require("./_isolation");

const {
  createLoadout,
  deleteLoadout,
  duplicateLoadout,
  getLoadout,
  getLoadoutProjection,
  listLoadoutManifests,
  migrateLegacySets,
  readLoadoutState,
  renameLoadout,
  saveCurrentLoadout,
  setActiveLoadout,
} = require("../dist/lib/loadouts");
const rootExports = require("../dist");
const { JsonStore } = require("../dist/lib/storage/datastore");
const { _resetSeqForTests } = require("../dist/lib/storage/intent-journal");

let isolation;

function setup(label = "loadouts") {
  isolation = setupEquipHome(label);
  _resetSeqForTests();
}

function teardown() {
  isolation.dispose();
}

function installAugment(name, options = {}) {
  const {
    source = "registry",
    platforms = ["codex"],
    installModes,
    version = 1,
  } = options;

  const contentHash = JsonStore.putContent({
    name,
    title: name,
    description: `Fixture for ${name}`,
    transport: "http",
    serverUrl: `https://example.com/${name}/mcp`,
    requiresAuth: false,
    skills: [],
    hooks: [],
  });

  const contentSource = source === "registry"
    ? { kind: "registry", version, etag: `etag-${name}`, fetchedAt: "2026-05-10T00:00:00.000Z" }
    : source === "wrapped"
      ? { kind: "wrapped", fromPlatform: platforms[0] || "codex", createdAt: "2026-05-10T00:00:00.000Z" }
      : { kind: "local-authored", createdAt: "2026-05-10T00:00:00.000Z" };

  JsonStore.appendIntent({
    type: "install-augment",
    clock: JsonStore.newClock(),
    name,
    contentHash,
    contentSource,
    platforms,
    ...(installModes ? { installModes } : {}),
  });

  return contentHash;
}

function uninstallAugment(name) {
  JsonStore.appendIntent({
    type: "uninstall-augment",
    clock: JsonStore.newClock(),
    name,
  });
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function manifestFile(id) {
  return path.join(process.env.EQUIP_HOME, "loadouts", "loadouts", `${id}.json`);
}

function listManifestFiles() {
  const dir = path.join(process.env.EQUIP_HOME, "loadouts", "loadouts");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
}

describe("loadout store", () => {
  beforeEach(() => setup());
  afterEach(teardown);

  it("exposes the loadout API through the package root", () => {
    assert.equal(typeof rootExports.createLoadout, "function");
    assert.equal(typeof rootExports.saveCurrentLoadout, "function");
    assert.equal(typeof rootExports.getLoadoutProjection, "function");
    assert.equal(typeof rootExports.LoadoutStoreError, "function");
  });

  it("creates and lists schema-versioned loadouts without platform writes", () => {
    const manifest = createLoadout({
      name: "Writing Mode",
      entries: [{
        augmentName: "prior",
        enabled: true,
        required: true,
        sourceKind: "registry",
        contentHash: "abc123",
        registryVersion: 3,
        shareBehavior: "public-ref",
      }],
    });

    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.mode, "replace");
    assert.deepEqual(manifest.platformPolicy, { kind: "enabled-platforms" });
    assert.deepEqual(manifest.resolutionPolicy, { kind: "latest-approved", expectedHashBehavior: "warn" });

    const summaries = getLoadoutProjection().loadouts;
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].name, "Writing Mode");
    assert.equal(summaries[0].entryCount, 1);
    assert.equal(summaries[0].active, false);
  });

  it("saves current installed journal state and marks it active clean", () => {
    const priorHash = installAugment("prior", {
      platforms: ["codex", "claude-code"],
      installModes: { codex: "broker" },
      version: 7,
    });
    const localHash = installAugment("local-helper", { source: "local-authored" });
    const wrappedHash = installAugment("wrapped-tool", { source: "wrapped", platforms: ["claude-code"] });

    const manifest = saveCurrentLoadout({ name: "Daily" });
    assert.equal(manifest.entries.length, 3);

    const prior = manifest.entries.find((entry) => entry.augmentName === "prior");
    assert.equal(prior.contentHash, priorHash);
    assert.equal(prior.registryVersion, 7);
    assert.equal(prior.installMode, "mixed");
    assert.equal(prior.shareBehavior, "public-ref");

    const local = manifest.entries.find((entry) => entry.augmentName === "local-helper");
    assert.equal(local.contentHash, localHash);
    assert.equal(local.sourceKind, "local-authored");
    assert.equal(local.shareBehavior, "local-private");

    const wrapped = manifest.entries.find((entry) => entry.augmentName === "wrapped-tool");
    assert.equal(wrapped.contentHash, wrappedHash);
    assert.equal(wrapped.sourceKind, "wrapped");
    assert.equal(wrapped.shareBehavior, "local-private");

    const projection = getLoadoutProjection();
    assert.equal(projection.activeLoadoutId, manifest.id);
    assert.equal(projection.activeModified, false);
    assert.equal(projection.loadouts[0].active, true);
    assert.equal(projection.loadouts[0].modified, false);
  });

  it("enforces unique names and prefers ID lookup over name lookup", () => {
    const byId = createLoadout({ id: "shared", name: "Primary", entries: [] });
    const byName = createLoadout({ id: "secondary", name: "shared", entries: [] });

    assert.equal(getLoadout("shared").id, byId.id);
    assert.equal(getLoadout(byName.name).id, byId.id, "ID wins when another manifest name matches the ref");
    assert.throws(
      () => createLoadout({ name: "Primary", entries: [] }),
      /Loadout name already exists/,
    );
    assert.throws(
      () => renameLoadout(byName.id, "Primary"),
      /Loadout name already exists/,
    );
    assert.throws(
      () => saveCurrentLoadout({ id: byId.id, name: "shared" }),
      /Loadout name already exists/,
    );
  });

  it("uses V1 membership-only dirty equality", () => {
    installAugment("alpha", { platforms: ["codex"], installModes: { codex: "direct" } });
    installAugment("beta");
    uninstallAugment("beta");

    const manifest = createLoadout({
      name: "Alpha",
      entries: [
        {
          augmentName: "alpha",
          enabled: true,
          required: true,
          sourceKind: "registry",
          platformTargets: ["claude-code"],
          installMode: "broker",
          shareBehavior: "public-ref",
        },
        {
          augmentName: "beta",
          enabled: false,
          required: true,
          sourceKind: "registry",
          shareBehavior: "public-ref",
        },
      ],
    });
    setActiveLoadout(manifest.id);

    assert.equal(getLoadoutProjection().activeModified, false, "platform/install-mode mismatch and disabled entries do not dirty V1");

    installAugment("gamma");
    assert.equal(getLoadoutProjection().activeModified, true, "extra installed managed augment dirties V1");
  });

  it("marks the active loadout modified when a saved augment is unequipped", () => {
    installAugment("alpha");
    installAugment("beta");

    const manifest = saveCurrentLoadout({ name: "Two Tools" });
    assert.equal(getLoadoutProjection().activeModified, false);

    uninstallAugment("beta");
    const projection = getLoadoutProjection();
    assert.equal(projection.activeLoadoutId, manifest.id);
    assert.equal(projection.activeModified, true);
    assert.equal(projection.loadouts.find((summary) => summary.id === manifest.id).modified, true);
  });

  it("renames, duplicates, and deletes active loadouts with explicit active clearing", () => {
    const manifest = createLoadout({ name: "Empty", entries: [] });
    setActiveLoadout(manifest.id);

    const renamed = renameLoadout(manifest.id, "Empty Renamed");
    assert.equal(readLoadoutState().activeLoadoutId, manifest.id);
    assert.equal(getLoadoutProjection().activeModified, false);

    const duplicate = duplicateLoadout(renamed.id, "Empty Copy");
    assert.notEqual(duplicate.id, renamed.id);
    assert.equal(readLoadoutState().activeLoadoutId, renamed.id);

    const result = deleteLoadout(renamed.id);
    assert.deepEqual(result, { deleted: true, activeCleared: true });
    assert.equal(readLoadoutState().activeLoadoutId, null);
    assert.equal(getLoadout(duplicate.id).name, "Empty Copy");
  });

  it("rejects missing/future schema versions and unsupported manifest semantics", () => {
    writeJson(path.join(process.env.EQUIP_HOME, "loadouts", "loadouts", "future.json"), {
      schemaVersion: 99,
      id: "future",
      name: "Future",
      entries: [],
    });
    assert.throws(() => listLoadoutManifests(), /Unsupported loadout schemaVersion/);

    fs.rmSync(path.join(process.env.EQUIP_HOME, "loadouts"), { recursive: true, force: true });
    const manifest = createLoadout({ name: "Strict", entries: [] });
    const raw = JSON.parse(fs.readFileSync(manifestFile(manifest.id), "utf-8"));

    const withoutSchema = { ...raw };
    delete withoutSchema.schemaVersion;
    writeJson(manifestFile(manifest.id), withoutSchema);
    assert.throws(() => getLoadout(manifest.id), /Unsupported loadout schemaVersion: undefined/);

    writeJson(manifestFile(manifest.id), { ...raw, mode: "merge" });
    assert.throws(() => getLoadout(manifest.id), /Unsupported loadout mode: merge/);

    const withoutPlatformPolicy = { ...raw };
    delete withoutPlatformPolicy.platformPolicy;
    writeJson(manifestFile(manifest.id), withoutPlatformPolicy);
    assert.throws(() => getLoadout(manifest.id), /Loadout platformPolicy is required/);

    const withoutResolutionPolicy = { ...raw };
    delete withoutResolutionPolicy.resolutionPolicy;
    writeJson(manifestFile(manifest.id), withoutResolutionPolicy);
    assert.throws(() => getLoadout(manifest.id), /Loadout resolutionPolicy is required/);

    writeJson(manifestFile(manifest.id), {
      ...raw,
      resolutionPolicy: { kind: "latest-approved", expectedHashBehavior: "fail" },
    });
    assert.throws(() => getLoadout(manifest.id), /Unsupported loadout expectedHashBehavior: fail/);

    raw.entries = [{
      augmentName: "prior",
      enabled: true,
      required: true,
      sourceKind: "registry",
      shareBehavior: "surprise",
    }];
    writeJson(manifestFile(manifest.id), raw);
    assert.throws(() => getLoadout(manifest.id), /Unsupported loadout shareBehavior/);
  });

  it("fails loudly on corrupt loadout files and unsupported state schema", () => {
    const manifest = createLoadout({ name: "Corruptible", entries: [] });
    fs.writeFileSync(manifestFile(manifest.id), "{nope");
    assert.throws(() => listLoadoutManifests(), /Cannot read loadout manifest/);

    fs.rmSync(path.join(process.env.EQUIP_HOME, "loadouts"), { recursive: true, force: true });
    writeJson(path.join(process.env.EQUIP_HOME, "loadouts", "state.json"), {
      schemaVersion: 99,
      activeLoadoutId: null,
      activeMembershipHash: null,
      updatedAt: "2026-05-10T00:00:00.000Z",
    });
    assert.throws(() => readLoadoutState(), /Unsupported loadout state schemaVersion: 99/);

    fs.writeFileSync(path.join(process.env.EQUIP_HOME, "loadouts", "state.json"), "{nope");
    assert.throws(() => readLoadoutState(), /Cannot read loadout state/);
  });
});

describe("legacy sets migration", () => {
  beforeEach(() => setup("loadouts-legacy"));
  afterEach(teardown);

  it("migrates app-side sets idempotently and imports new legacy sets on later reads", () => {
    const legacyPath = path.join(process.env.EQUIP_HOME, "app", "sets.json");
    writeJson(legacyPath, {
      activeSet: "Coding",
      sets: [
        { name: "Coding", augments: ["prior"], createdAt: "2026-05-01T00:00:00.000Z", lastUsed: "2026-05-02T00:00:00.000Z" },
      ],
    });

    let manifests = listLoadoutManifests();
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0].id, "legacy_a18b4be8e3181ff4");
    assert.equal(readLoadoutState().activeLoadoutId, manifests[0].id);

    manifests = listLoadoutManifests();
    assert.equal(manifests.length, 1, "second read does not duplicate legacy set");

    writeJson(legacyPath, {
      activeSet: "Writing",
      sets: [
        { name: "Coding", augments: ["prior"] },
        { name: "Writing", augments: ["local-helper", "wrapped-tool"] },
      ],
    });

    manifests = listLoadoutManifests();
    assert.equal(manifests.length, 2);
    const writing = manifests.find((manifest) => manifest.name === "Writing");
    assert.ok(writing);
    assert.deepEqual(writing.entries.map((entry) => entry.augmentName), ["local-helper", "wrapped-tool"]);
    assert.equal(readLoadoutState().activeLoadoutId, writing.id);
  });

  it("throws on invalid legacy augment names instead of silently dropping them", () => {
    writeJson(path.join(process.env.EQUIP_HOME, "app", "sets.json"), {
      activeSet: "Broken",
      sets: [{ name: "Broken", augments: ["valid-tool", "INVALID NAME"] }],
    });

    assert.throws(
      () => listLoadoutManifests(),
      /invalid augment name|invalid_legacy_set_entry|Legacy set "Broken"/i,
    );
    assert.equal(listManifestFiles().length, 0);
  });

  it("does not duplicate a legacy set that collides with an existing canonical name", () => {
    createLoadout({ name: "Coding", entries: [] });
    writeJson(path.join(process.env.EQUIP_HOME, "app", "sets.json"), {
      activeSet: "Coding",
      sets: [{ name: "Coding", augments: ["prior"] }],
    });

    const result = migrateLegacySets();
    assert.equal(result.migrated, 0);
    assert.equal(listLoadoutManifests().length, 1);
  });

  it("throws on corrupt legacy sets instead of silently dropping data", () => {
    const legacyPath = path.join(process.env.EQUIP_HOME, "app", "sets.json");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, "{nope");

    assert.throws(() => listLoadoutManifests(), /Cannot read legacy sets/);
  });
});

describe("loadout side effects", () => {
  it("does not write outside loadout storage for CRUD/save/projection operations", () => {
    const full = setupFullHome("loadouts-side-effects");
    try {
      process.env.EQUIP_HOME = full.equipHome;
      _resetSeqForTests();
      const platformConfig = path.join(full.home, ".codex", "config.toml");
      fs.mkdirSync(path.dirname(platformConfig), { recursive: true });
      fs.writeFileSync(platformConfig, "[mcp_servers.prior]\ncommand = \"prior\"\n");

      installAugment("prior");
      const before = snapshotFiles(full.home);

      const manifest = saveCurrentLoadout({ name: "No Side Effects" });
      getLoadoutProjection();
      renameLoadout(manifest.id, "Still No Side Effects");
      duplicateLoadout(manifest.id, "Copy No Side Effects");
      deleteLoadout(manifest.id);

      const after = snapshotFiles(full.home);
      assertNoNonLoadoutChanges(before, after);
      assert.equal(fs.readFileSync(platformConfig, "utf-8"), "[mcp_servers.prior]\ncommand = \"prior\"\n");
    } finally {
      full.dispose();
    }
  });
});

function snapshotFiles(root) {
  const out = new Map();
  walk(root, "");
  return out;

  function walk(dir, prefix) {
    for (const name of fs.readdirSync(dir)) {
      const absolute = path.join(dir, name);
      const relative = path.join(prefix, name);
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) walk(absolute, relative);
      else out.set(relative, fs.readFileSync(absolute, "utf-8"));
    }
  }
}

function assertNoNonLoadoutChanges(before, after) {
  const loadoutPrefix = path.join(".equip", "loadouts") + path.sep;
  const allKeys = new Set([...before.keys(), ...after.keys()]);
  for (const key of allKeys) {
    if (key === path.join(".equip", ".lock") || key.startsWith(loadoutPrefix)) continue;
    assert.equal(after.get(key), before.get(key), `unexpected non-loadout file change: ${key}`);
  }
}
