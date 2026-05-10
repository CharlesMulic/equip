"use strict";

require("./_isolation");

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupEquipHome, setupFullHome } = require("./_isolation");

const {
  createLoadout,
  previewLoadout,
} = require("../dist/lib/loadouts");
const { JsonStore } = require("../dist/lib/storage/datastore");
const { _resetSeqForTests } = require("../dist/lib/storage/intent-journal");

let isolation;

function setup(label = "loadout-preview") {
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
    version = 1,
    requiresAuth = false,
    rules,
    skills = [],
    hooks = [],
  } = options;

  const contentHash = JsonStore.putContent({
    name,
    title: name,
    description: `Fixture for ${name}`,
    transport: "http",
    serverUrl: `https://example.com/${name}/mcp`,
    requiresAuth,
    rules,
    skills,
    hooks,
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
  });

  return contentHash;
}

function entry(augmentName, options = {}) {
  return {
    augmentName,
    enabled: options.enabled ?? true,
    required: options.required ?? true,
    sourceKind: options.sourceKind ?? "registry",
    shareBehavior: options.shareBehavior ?? (options.sourceKind === "local-authored" || options.sourceKind === "wrapped" ? "local-private" : "public-ref"),
    ...(options.contentHash ? { contentHash: options.contentHash } : {}),
    ...(options.registryVersion !== undefined ? { registryVersion: options.registryVersion } : {}),
    ...(options.platformTargets ? { platformTargets: options.platformTargets } : {}),
  };
}

function resolver(map) {
  return (loadoutEntry) => map[loadoutEntry.augmentName] ?? null;
}

function findEntry(plan, name) {
  const planned = plan.entries.find((candidate) => candidate.augmentName === name);
  assert.ok(planned, `missing planned entry for ${name}`);
  return planned;
}

function assertEntry(plan, name, action, codes = []) {
  const planned = findEntry(plan, name);
  assert.equal(planned.action, action);
  for (const code of codes) assert.ok(planned.codes.includes(code), `${name} should include ${code}`);
  return planned;
}

describe("loadout preview planner", () => {
  beforeEach(() => setup());
  afterEach(teardown);

  const absentPrivateHash = "f".repeat(64);

  it("plans install, uninstall, noop, update, and stable hashes without writes", () => {
    const alphaHash = installAugment("alpha");
    installAugment("beta");
    installAugment("delta", { version: 1 });

    const loadout = createLoadout({
      name: "Mixed",
      entries: [
        entry("delta", { contentHash: "saved-delta", registryVersion: 1 }),
        entry("gamma", { contentHash: "saved-gamma", registryVersion: 1 }),
        entry("alpha", { contentHash: alphaHash, registryVersion: 1 }),
      ],
    });

    const targetResolver = resolver({
      alpha: {
        status: "available",
        sourceKind: "registry",
        contentHash: alphaHash,
        registryVersion: 1,
        componentSummary: { mcp: true, rules: false, skills: 0, hooks: 0 },
      },
      gamma: {
        status: "available",
        sourceKind: "registry",
        contentHash: "resolved-gamma",
        registryVersion: 1,
        componentSummary: { mcp: true, rules: true, skills: 0, hooks: 0 },
        baseWeight: 2,
        loadedWeight: 5,
      },
      delta: {
        status: "available",
        sourceKind: "registry",
        contentHash: "resolved-delta",
        registryVersion: 2,
        componentSummary: { mcp: true, rules: false, skills: 1, hooks: 0 },
      },
    });

    const plan = previewLoadout(loadout, {
      enabledPlatformIds: ["codex"],
      targetResolver,
      now: "2026-05-10T00:00:00.000Z",
    });

    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.status, "ready");
    assert.equal(plan.canApply, true);
    assertEntry(plan, "alpha", "noop", ["noop"]);
    assertEntry(plan, "beta", "uninstall", ["uninstall"]);
    assertEntry(plan, "gamma", "install", ["install", "hash_version_mismatch"]);
    assertEntry(plan, "delta", "update", ["update", "hash_version_mismatch"]);
    assert.equal(plan.summary.beforeCount, 3);
    assert.equal(plan.summary.afterCount, 3);
    assert.equal(plan.summary.installCount, 1);
    assert.equal(plan.summary.uninstallCount, 1);
    assert.equal(plan.summary.updateCount, 1);
    assert.deepEqual(plan.desiredState.entries.map((item) => item.augmentName), ["alpha", "delta", "gamma"]);
    assert.deepEqual(plan.desiredState.componentSummary, { mcp: true, rules: true, skills: 1, hooks: 0 });
    const gammaDesired = plan.desiredState.entries.find((item) => item.augmentName === "gamma");
    assert.equal(gammaDesired.requiresAuth, false);
    assert.equal(gammaDesired.canRenderTemporaryInputs, true);
    assert.equal(plan.summary.baseWeight, 2);
    assert.equal(plan.summary.loadedWeight, 5);

    const shuffled = { ...loadout, entries: [...loadout.entries].reverse() };
    const samePlan = previewLoadout(shuffled, {
      enabledPlatformIds: ["codex"],
      targetResolver,
      now: "2026-05-10T01:00:00.000Z",
    });
    assert.equal(samePlan.planHash, plan.planHash, "timestamps and entry order do not affect planHash");

    const changedPlan = previewLoadout(loadout, {
      enabledPlatformIds: ["codex"],
      targetResolver: resolver({
        ...{
          alpha: targetResolver({ augmentName: "alpha" }),
          gamma: targetResolver({ augmentName: "gamma" }),
        },
        delta: {
          status: "available",
          sourceKind: "registry",
          contentHash: "resolved-delta-v3",
          registryVersion: 3,
          componentSummary: { mcp: true, rules: false, skills: 1, hooks: 0 },
        },
      }),
      now: "2026-05-10T00:00:00.000Z",
    });
    assert.notEqual(changedPlan.planHash, plan.planHash, "meaningful target resolution changes affect planHash");

    const supportedCodexOnly = previewLoadout(loadout, {
      enabledPlatformIds: ["codex", "cursor"],
      targetResolver: resolver({
        alpha: {
          status: "available",
          sourceKind: "registry",
          contentHash: alphaHash,
          registryVersion: 1,
          supportedPlatforms: ["codex"],
          componentSummary: { mcp: true, rules: false, skills: 0, hooks: 0 },
        },
        gamma: targetResolver({ augmentName: "gamma" }),
        delta: targetResolver({ augmentName: "delta" }),
      }),
      now: "2026-05-10T00:00:00.000Z",
    });
    const supportedCodexWithOther = previewLoadout(loadout, {
      enabledPlatformIds: ["codex", "cursor"],
      targetResolver: resolver({
        alpha: {
          status: "available",
          sourceKind: "registry",
          contentHash: alphaHash,
          registryVersion: 1,
          supportedPlatforms: ["codex", "windsurf"],
          componentSummary: { mcp: true, rules: false, skills: 0, hooks: 0 },
        },
        gamma: targetResolver({ augmentName: "gamma" }),
        delta: targetResolver({ augmentName: "delta" }),
      }),
      now: "2026-05-10T00:00:00.000Z",
    });
    assert.notEqual(
      supportedCodexOnly.planHash,
      supportedCodexWithOther.planHash,
      "diagnostic platform detail affects planHash",
    );
  });

  it("emits required blocked and warning codes through read-only injected seams", () => {
    installAugment("private-tool", { source: "local-authored" });
    const loadout = createLoadout({
      name: "Codes",
      entries: [
        entry("missing-registry"),
        entry("unavailable-registry"),
        entry("retracted-tool"),
        entry("unapproved-tool"),
        entry("secure-tool"),
        entry("private-tool", { sourceKind: "local-authored" }),
        entry("lost-private", { sourceKind: "local-authored" }),
        entry("placeholder-tool", { sourceKind: "unknown", shareBehavior: "unavailable-placeholder" }),
        entry("cursor-only", { platformTargets: ["cursor"] }),
      ],
    });

    const plan = previewLoadout(loadout, {
      enabledPlatformIds: ["codex"],
      targetResolver: resolver({
        "unavailable-registry": { status: "unavailable", sourceKind: "registry" },
        "retracted-tool": { status: "retracted", sourceKind: "registry" },
        "unapproved-tool": { status: "unapproved", sourceKind: "registry" },
        "secure-tool": {
          status: "available",
          sourceKind: "registry",
          contentHash: "secure-hash",
          registryVersion: 1,
          requiresAuth: true,
          componentSummary: { mcp: true, rules: false, skills: 0, hooks: 0 },
        },
        "private-tool": {
          status: "available",
          sourceKind: "local-authored",
          contentHash: "private-hash",
          componentSummary: { mcp: true, rules: false, skills: 0, hooks: 0 },
        },
        "cursor-only": {
          status: "available",
          sourceKind: "registry",
          contentHash: "cursor-hash",
          supportedPlatforms: ["cursor"],
          componentSummary: { mcp: true, rules: false, skills: 0, hooks: 0 },
        },
      }),
      credentialReader: () => false,
    });

    assert.equal(plan.status, "blocked");
    assertEntry(plan, "missing-registry", "install", ["missing_registry_entry"]);
    assertEntry(plan, "unavailable-registry", "install", ["unavailable_registry_entry"]);
    assertEntry(plan, "retracted-tool", "install", ["retracted_entry"]);
    assertEntry(plan, "unapproved-tool", "install", ["unapproved_entry"]);
    assertEntry(plan, "secure-tool", "install", ["auth_required", "credential_needed"]);
    assertEntry(plan, "private-tool", "noop", ["local_private_available"]);
    assertEntry(plan, "lost-private", "install", ["local_private_unavailable"]);
    assertEntry(plan, "placeholder-tool", "install", ["unavailable_placeholder"]);
    assertEntry(plan, "cursor-only", "install", ["platform_unsupported"]);
    assert.equal(plan.summary.blockedCount, 8);

    const secureDesired = plan.desiredState.entries.find((item) => item.augmentName === "secure-tool");
    assert.ok(secureDesired, "blocked auth-required targets remain in desiredState");
    assert.equal(secureDesired.requiresAuth, true);
    assert.equal(secureDesired.credentialAvailable, false);
    assert.equal(secureDesired.canRenderTemporaryInputs, false);
  });

  it("uses default target identity checks before falling back to current installs", () => {
    installAugment("private-tool", { source: "local-authored" });
    installAugment("registry-tool", { source: "registry", version: 3 });
    const loadout = createLoadout({
      name: "Default Resolver",
      entries: [
        entry("private-tool", {
          sourceKind: "local-authored",
          contentHash: absentPrivateHash,
          shareBehavior: "local-private",
        }),
        entry("registry-tool", {
          sourceKind: "registry",
          registryVersion: 3,
        }),
        entry("placeholder-tool", {
          sourceKind: "unknown",
          shareBehavior: "unavailable-placeholder",
        }),
      ],
    });

    const plan = previewLoadout(loadout, {
      enabledPlatformIds: ["codex"],
      credentialReader: () => true,
    });

    const privateEntry = assertEntry(plan, "private-tool", "noop", ["local_private_unavailable"]);
    assert.ok(!privateEntry.codes.includes("local_private_available"));
    assert.equal(privateEntry.target.contentHash, absentPrivateHash);
    assert.equal(privateEntry.status, "blocked");
    assertEntry(plan, "registry-tool", "noop");
    assertEntry(plan, "placeholder-tool", "install", ["unavailable_placeholder"]);
  });

  it("emits no-enabled-platforms and unmanaged inventory ignored codes", () => {
    const noPlatforms = createLoadout({
      name: "No Platforms",
      entries: [entry("alpha")],
    });
    const blocked = previewLoadout(noPlatforms, {
      enabledPlatformIds: [],
      targetResolver: resolver({
        alpha: {
          status: "available",
          sourceKind: "registry",
          contentHash: "alpha-hash",
          componentSummary: { mcp: true, rules: false, skills: 0, hooks: 0 },
        },
      }),
    });
    assertEntry(blocked, "alpha", "install", ["no_enabled_platforms"]);
    assert.equal(blocked.status, "blocked");

    const ignored = previewLoadout(noPlatforms, {
      enabledPlatformIds: ["codex"],
      platformScanReader: () => ({
        lastScanned: "2026-05-10T00:00:00.000Z",
        augments: {
          manual: { transport: "http", url: "https://example.com/manual", managed: false },
        },
        skillBundles: {
          notes: { managed: false, skills: ["notes"], layout: "flat" },
        },
        augmentCount: 1,
        managedCount: 0,
        skillBundleCount: 1,
        managedSkillBundleCount: 0,
      }),
      targetResolver: resolver({
        alpha: {
          status: "available",
          sourceKind: "registry",
          contentHash: "alpha-hash",
          componentSummary: { mcp: true, rules: false, skills: 0, hooks: 0 },
        },
      }),
    });
    assert.deepEqual(ignored.ignoredInventory.map((item) => item.code), ["unmanaged_inventory_ignored", "unmanaged_inventory_ignored"]);
    assert.equal(ignored.summary.ignoredCount, 2);

    const sameNameUnmanaged = previewLoadout(noPlatforms, {
      enabledPlatformIds: ["codex"],
      platformScanReader: () => ({
        lastScanned: "2026-05-10T00:00:00.000Z",
        augments: {
          alpha: { transport: "http", url: "https://example.com/alpha", managed: false },
        },
        augmentCount: 1,
        managedCount: 0,
      }),
      targetResolver: resolver({
        alpha: {
          status: "available",
          sourceKind: "registry",
          contentHash: "alpha-hash",
          componentSummary: { mcp: true, rules: false, skills: 0, hooks: 0 },
        },
      }),
    });
    const alpha = assertEntry(sameNameUnmanaged, "alpha", "install");
    assert.ok(!alpha.codes.includes("unmanaged_inventory_ignored"));
    assert.deepEqual(sameNameUnmanaged.ignoredInventory.map((item) => item.code), ["unmanaged_inventory_ignored"]);
    assert.equal(sameNameUnmanaged.status, "ready");
  });

  it("does not write loadout, registry, journal, platform, or config files during preview", () => {
    const full = setupFullHome("loadout-preview-no-write");
    try {
      process.env.EQUIP_HOME = full.equipHome;
      _resetSeqForTests();
      const platformConfig = path.join(full.home, ".codex", "config.toml");
      fs.mkdirSync(path.dirname(platformConfig), { recursive: true });
      fs.writeFileSync(platformConfig, "[mcp_servers.manual]\ncommand = \"manual\"\n");

      const loadout = createLoadout({
        name: "No Writes",
        entries: [entry("alpha")],
      });
      writeJson(path.join(full.equipHome, "app", "sets.json"), {
        activeSet: "Legacy",
        sets: [{ name: "Legacy", augments: ["legacy-tool"] }],
      });
      const before = snapshotFiles(full.home);

      previewLoadout(loadout.id, {
        enabledPlatformIds: ["codex"],
        targetResolver: resolver({
          alpha: {
            status: "available",
            sourceKind: "registry",
            contentHash: "alpha-hash",
            componentSummary: { mcp: true, rules: false, skills: 0, hooks: 0 },
          },
        }),
        platformScanReader: () => ({
          lastScanned: "2026-05-10T00:00:00.000Z",
          augments: { manual: { transport: "stdio", command: "manual", managed: false } },
          augmentCount: 1,
          managedCount: 0,
        }),
        credentialReader: () => true,
      });

      const after = snapshotFiles(full.home);
      assert.deepEqual(after, before);
    } finally {
      full.dispose();
    }
  });
});

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function snapshotFiles(root) {
  const out = {};
  walk(root, "");
  return out;

  function walk(dir, prefix) {
    for (const name of fs.readdirSync(dir)) {
      const absolute = path.join(dir, name);
      const relative = path.join(prefix, name);
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) walk(absolute, relative);
      else out[relative] = fs.readFileSync(absolute, "utf-8");
    }
  }
}
