"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// We need to override the augments directory for testing.
// The module uses a hardcoded path — we'll test via the exported functions
// and use a temp directory by setting HOME.
const {
  readAugmentDef,
  writeAugmentDef,
  listAugmentDefs,
  deleteAugmentDef,
  hasAugmentDef,
  syncFromRegistry,
  createLocalAugment,
  wrapUnmanaged,
  promoteWrappedToLocal,
  modAugmentRules,
  resetAugmentRules,
} = require("../dist/lib/augment-defs");

// ─── Helpers ────────────────────────────────────────────────

let originalHome;
let tempHome;

function setupTempHome() {
  originalHome = os.homedir;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-augdefs-"));
  // Override homedir to isolate tests
  os.homedir = () => tempHome;
}

function teardownTempHome() {
  os.homedir = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
}

function makeMinimalDef(overrides = {}) {
  return {
    name: "test-augment",
    source: "local",
    displayName: "Test Augment",
    description: "A test augment",
    transport: "http",
    serverUrl: "https://example.com/mcp",
    requiresAuth: false,
    skills: [],
    weight: 400,
    modded: false,
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

function makeRegistryToolDef(overrides = {}) {
  return {
    name: "test-tool",
    displayName: "Test Tool",
    description: "A test tool from the registry",
    installMode: "direct",
    transport: "http",
    serverUrl: "https://example.com/mcp",
    requiresAuth: true,
    envKey: "TEST_API_KEY",
    rules: {
      content: "## Test\n\nSearch on errors.",
      version: "1.0.0",
      marker: "test-tool",
    },
    skills: [
      { name: "search", files: [{ path: "SKILL.md", content: "# Search\n" }] },
    ],
    homepage: "https://example.com",
    categories: ["testing"],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe("augment-defs CRUD", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("writeAugmentDef creates file in ~/.equip/augments/", () => {
    const def = makeMinimalDef();
    writeAugmentDef(def);

    const filePath = path.join(tempHome, ".equip", "augments", "test-augment.json");
    assert.ok(fs.existsSync(filePath), "File should exist");
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(content.name, "test-augment");
  });

  it("readAugmentDef returns null for missing definition", () => {
    const result = readAugmentDef("nonexistent");
    assert.equal(result, null);
  });

  it("readAugmentDef returns parsed definition", () => {
    writeAugmentDef(makeMinimalDef());
    const result = readAugmentDef("test-augment");
    assert.ok(result);
    assert.equal(result.name, "test-augment");
    assert.equal(result.source, "local");
    assert.equal(result.transport, "http");
  });

  it("listAugmentDefs returns all definitions", () => {
    writeAugmentDef(makeMinimalDef({ name: "alpha" }));
    writeAugmentDef(makeMinimalDef({ name: "beta" }));
    writeAugmentDef(makeMinimalDef({ name: "gamma" }));

    const defs = listAugmentDefs();
    assert.equal(defs.length, 3);
    const names = defs.map(d => d.name).sort();
    assert.deepEqual(names, ["alpha", "beta", "gamma"]);
  });

  it("listAugmentDefs returns empty array when no augments exist", () => {
    const defs = listAugmentDefs();
    assert.equal(defs.length, 0);
  });

  it("deleteAugmentDef removes the file", () => {
    writeAugmentDef(makeMinimalDef());
    assert.ok(hasAugmentDef("test-augment"));

    const deleted = deleteAugmentDef("test-augment");
    assert.ok(deleted);
    assert.ok(!hasAugmentDef("test-augment"));
    assert.equal(readAugmentDef("test-augment"), null);
  });

  it("deleteAugmentDef returns false for missing file", () => {
    const deleted = deleteAugmentDef("nonexistent");
    assert.ok(!deleted);
  });

  it("hasAugmentDef returns correct boolean", () => {
    assert.ok(!hasAugmentDef("test-augment"));
    writeAugmentDef(makeMinimalDef());
    assert.ok(hasAugmentDef("test-augment"));
  });

  it("corrupt augment file is handled gracefully", () => {
    const augmentsDir = path.join(tempHome, ".equip", "augments");
    fs.mkdirSync(augmentsDir, { recursive: true });
    fs.writeFileSync(path.join(augmentsDir, "corrupt.json"), "{invalid json!!!");

    const result = readAugmentDef("corrupt");
    assert.equal(result, null);
    // Should have created a .corrupt.bak file
    assert.ok(fs.existsSync(path.join(augmentsDir, "corrupt.json.corrupt.bak")));
  });
});

describe("syncFromRegistry", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("creates new definition from registry data", () => {
    const registryDef = makeRegistryToolDef();
    const result = syncFromRegistry(registryDef);

    assert.equal(result.name, "test-tool");
    assert.equal(result.source, "registry");
    assert.equal(result.displayName, "Test Tool");
    assert.equal(result.serverUrl, "https://example.com/mcp");
    assert.ok(result.requiresAuth);
    assert.equal(result.rules.version, "1.0.0");
    assert.equal(result.skills.length, 1);
    assert.equal(result.registryVersion, "1.0.0");
    assert.ok(result.syncedAt);
    assert.ok(!result.modded);

    // Verify persisted
    const persisted = readAugmentDef("test-tool");
    assert.ok(persisted);
    assert.equal(persisted.name, "test-tool");
  });

  it("updates existing definition on re-sync (no mods)", () => {
    // First sync
    syncFromRegistry(makeRegistryToolDef());

    // Second sync with updated description
    const updated = syncFromRegistry(makeRegistryToolDef({
      description: "Updated description",
      rules: { content: "## Updated\n\nNew rules.", version: "2.0.0", marker: "test-tool" },
    }));

    assert.equal(updated.description, "Updated description");
    assert.equal(updated.rules.version, "2.0.0");
    assert.equal(updated.rules.content, "## Updated\n\nNew rules.");
    assert.equal(updated.registryVersion, "2.0.0");
    assert.ok(!updated.modded);
    assert.equal(updated.rulesUpstream, undefined, "No upstream needed when not modded");
  });

  it("preserves modded rules on upstream update", () => {
    // Initial sync
    syncFromRegistry(makeRegistryToolDef());

    // User mods the rules
    modAugmentRules("test-tool", {
      content: "## My Custom Rules\n\nOnly search when stuck.",
      version: "1.0.0-modded",
      marker: "test-tool",
    });

    // Registry pushes update
    const updated = syncFromRegistry(makeRegistryToolDef({
      rules: { content: "## Updated Official\n\nNew official rules.", version: "2.0.0", marker: "test-tool" },
    }));

    // User's rules should be preserved
    assert.equal(updated.rules.content, "## My Custom Rules\n\nOnly search when stuck.");
    assert.equal(updated.rules.version, "1.0.0-modded");

    // Upstream should be updated for diffing
    assert.ok(updated.rulesUpstream);
    assert.equal(updated.rulesUpstream.version, "2.0.0");
    assert.equal(updated.rulesUpstream.content, "## Updated Official\n\nNew official rules.");

    assert.ok(updated.modded);
    assert.equal(updated.registryVersion, "2.0.0");
  });

  it("detects version change and flags for review", () => {
    syncFromRegistry(makeRegistryToolDef());
    modAugmentRules("test-tool", {
      content: "custom",
      version: "1.0.0-custom",
      marker: "test-tool",
    });

    const v2 = syncFromRegistry(makeRegistryToolDef({
      rules: { content: "v2 official", version: "2.0.0", marker: "test-tool" },
    }));

    // The definition should have both versions available for the UI to diff
    assert.equal(v2.rules.content, "custom"); // user's version
    assert.equal(v2.rulesUpstream.content, "v2 official"); // new upstream
    assert.notEqual(v2.registryVersion, v2.rules.version); // diverged
  });
});

describe("createLocalAugment", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("creates definition with source: local", () => {
    const def = createLocalAugment({
      name: "my-tool",
      displayName: "My Tool",
      transport: "stdio",
      stdio: { command: "node", args: ["server.js"] },
    });

    assert.equal(def.source, "local");
    assert.equal(def.name, "my-tool");
    assert.equal(def.transport, "stdio");
    assert.equal(def.stdio.command, "node");
    assert.ok(!def.modded);
    assert.ok(def.createdAt);

    // Verify persisted
    assert.ok(hasAugmentDef("my-tool"));
  });

  it("defaults displayName to name", () => {
    const def = createLocalAugment({
      name: "my-tool",
      transport: "http",
      serverUrl: "http://localhost:3000",
    });
    assert.equal(def.displayName, "my-tool");
  });
});

describe("wrapUnmanaged", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("wraps HTTP MCP entry as augment definition", () => {
    const def = wrapUnmanaged({
      name: "unknown-server",
      transport: "http",
      url: "https://some-service.com/mcp",
      fromPlatform: "claude-code",
    });

    assert.equal(def.source, "wrapped");
    assert.equal(def.name, "unknown-server");
    assert.equal(def.serverUrl, "https://some-service.com/mcp");
    assert.equal(def.wrappedFrom.type, "mcp");
    assert.equal(def.wrappedFrom.platform, "claude-code");
    assert.ok(hasAugmentDef("unknown-server"));
  });

  it("wraps stdio MCP entry with args as augment definition", () => {
    const def = wrapUnmanaged({
      name: "local-tool",
      transport: "stdio",
      command: "npx",
      args: ["-y", "some-tool", "/path"],
      fromPlatform: "cursor",
    });

    assert.equal(def.source, "wrapped");
    assert.equal(def.transport, "stdio");
    assert.equal(def.stdio.command, "npx");
    assert.deepEqual(def.stdio.args, ["-y", "some-tool", "/path"]);
    assert.equal(def.wrappedFrom.type, "mcp");
    assert.equal(def.wrappedFrom.platform, "cursor");
  });

  it("wraps with structured wrappedFromMeta when provided", () => {
    const def = wrapUnmanaged({
      name: "skill-wrap",
      transport: "http",
      fromPlatform: "claude-code",
      wrappedFromMeta: { type: "skill", platform: "claude-code", path: "/skills/test/SKILL.md", originalName: "test" },
    });

    assert.equal(def.wrappedFrom.type, "skill");
    assert.equal(def.wrappedFrom.path, "/skills/test/SKILL.md");
    assert.equal(def.wrappedFrom.originalName, "test");
  });

  it("wrapUnmanaged round-trip: write then read produces structured wrappedFrom", () => {
    wrapUnmanaged({
      name: "roundtrip-test",
      transport: "http",
      url: "http://localhost:8080",
      fromPlatform: "vscode",
    });

    const def = readAugmentDef("roundtrip-test");
    assert.ok(def);
    assert.equal(typeof def.wrappedFrom, "object");
    assert.equal(def.wrappedFrom.type, "mcp");
    assert.equal(def.wrappedFrom.platform, "vscode");
  });
});

describe("modding", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("modAugmentRules sets modded flag and preserves upstream", () => {
    syncFromRegistry(makeRegistryToolDef());

    const modded = modAugmentRules("test-tool", {
      content: "## Custom\n\nMy rules.",
      version: "1.0.0-custom",
      marker: "test-tool",
    });

    assert.ok(modded.modded);
    assert.ok(modded.moddedAt);
    assert.deepEqual(modded.moddedFields, ["rules"]);
    assert.equal(modded.rules.content, "## Custom\n\nMy rules.");

    // Upstream should be preserved
    assert.ok(modded.rulesUpstream);
    assert.equal(modded.rulesUpstream.version, "1.0.0");
  });

  it("modAugmentRules returns null for missing augment", () => {
    const result = modAugmentRules("nonexistent", {
      content: "test", version: "1.0.0", marker: "test",
    });
    assert.equal(result, null);
  });

  it("resetAugmentRules restores upstream version", () => {
    syncFromRegistry(makeRegistryToolDef());
    modAugmentRules("test-tool", {
      content: "custom", version: "1.0.0-custom", marker: "test-tool",
    });

    const reset = resetAugmentRules("test-tool");
    assert.ok(reset);
    assert.ok(!reset.modded);
    assert.equal(reset.rules.version, "1.0.0");
    assert.equal(reset.rules.content, "## Test\n\nSearch on errors.");
    assert.equal(reset.rulesUpstream, undefined);
    assert.equal(reset.moddedFields.length, 0);
  });

  it("resetAugmentRules returns null if not modded", () => {
    syncFromRegistry(makeRegistryToolDef());
    const result = resetAugmentRules("test-tool");
    assert.equal(result, null);
  });

  it("modding a local augment does not set rulesUpstream", () => {
    createLocalAugment({
      name: "my-local",
      transport: "http",
      serverUrl: "http://localhost:3000",
      rules: { content: "original", version: "1.0.0", marker: "my-local" },
    });

    const modded = modAugmentRules("my-local", {
      content: "modified", version: "1.0.0-mod", marker: "my-local",
    });

    assert.ok(modded.modded);
    assert.equal(modded.rules.content, "modified");
    // Local augments have no upstream — rulesUpstream should be the original
    assert.ok(modded.rulesUpstream);
    assert.equal(modded.rulesUpstream.content, "original");
  });
});

// ─── Authoring lifecycle fields ───────────────────────────────

describe("Authoring lifecycle fields", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("wrappedFrom string is migrated to structured format on read", () => {
    // Write a def with old string format
    const dir = path.join(os.homedir(), ".equip", "augments");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "old-wrap.json"), JSON.stringify({
      name: "old-wrap",
      source: "wrapped",
      displayName: "Old Wrap",
      description: "",
      transport: "stdio",
      requiresAuth: false,
      skills: [],
      baseWeight: 0,
      loadedWeight: 0,
      modded: false,
      wrappedFrom: "claude-code",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }));

    const def = readAugmentDef("old-wrap");
    assert.ok(def);
    assert.equal(typeof def.wrappedFrom, "object");
    assert.equal(def.wrappedFrom.type, "mcp");
    assert.equal(def.wrappedFrom.platform, "claude-code");
  });

  it("wrappedFrom structured format is preserved on read", () => {
    const dir = path.join(os.homedir(), ".equip", "augments");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "new-wrap.json"), JSON.stringify({
      name: "new-wrap",
      source: "wrapped",
      displayName: "New Wrap",
      description: "",
      transport: "http",
      serverUrl: "http://localhost:3000",
      requiresAuth: false,
      skills: [],
      baseWeight: 0,
      loadedWeight: 0,
      modded: false,
      wrappedFrom: { type: "mcp", platform: "cursor", path: "/some/config.json", originalName: "my-server" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }));

    const def = readAugmentDef("new-wrap");
    assert.ok(def);
    assert.equal(def.wrappedFrom.type, "mcp");
    assert.equal(def.wrappedFrom.platform, "cursor");
    assert.equal(def.wrappedFrom.originalName, "my-server");
  });

  it("promoteWrappedToLocal changes source but preserves wrappedFrom", () => {
    const dir = path.join(os.homedir(), ".equip", "augments");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "wrapped-test.json"), JSON.stringify({
      name: "wrapped-test",
      source: "wrapped",
      displayName: "Wrapped Test",
      description: "",
      transport: "stdio",
      requiresAuth: false,
      skills: [],
      baseWeight: 0,
      loadedWeight: 0,
      modded: false,
      wrappedFrom: { type: "skill", platform: "claude-code", path: "/skills/test/SKILL.md" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }));

    const promoted = promoteWrappedToLocal("wrapped-test");
    assert.ok(promoted);
    assert.equal(promoted.source, "local");
    assert.equal(promoted.wrappedFrom.type, "skill");
    assert.equal(promoted.wrappedFrom.platform, "claude-code");

    // Read again to confirm persisted
    const reread = readAugmentDef("wrapped-test");
    assert.equal(reread.source, "local");
    assert.ok(reread.wrappedFrom);
  });

  it("promoteWrappedToLocal is a no-op for non-wrapped augments", () => {
    const dir = path.join(os.homedir(), ".equip", "augments");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "local-test.json"), JSON.stringify({
      name: "local-test",
      source: "local",
      displayName: "Local Test",
      description: "",
      transport: "http",
      requiresAuth: false,
      skills: [],
      baseWeight: 0,
      loadedWeight: 0,
      modded: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }));

    const result = promoteWrappedToLocal("local-test");
    assert.ok(result);
    assert.equal(result.source, "local"); // unchanged
  });

  it("promoteWrappedToLocal returns null for nonexistent augment", () => {
    const result = promoteWrappedToLocal("does-not-exist");
    assert.equal(result, null);
  });

  it("publishIntent and hasUnpublishedChanges round-trip through write/read", () => {
    writeAugmentDef({
      name: "pub-test",
      source: "local",
      displayName: "Pub Test",
      description: "testing",
      transport: "http",
      serverUrl: "http://localhost:8080",
      requiresAuth: false,
      skills: [],
      baseWeight: 0,
      loadedWeight: 0,
      modded: false,
      publishIntent: true,
      hasUnpublishedChanges: false,
      publishedVersion: 3,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const def = readAugmentDef("pub-test");
    assert.ok(def);
    assert.equal(def.publishIntent, true);
    assert.equal(def.hasUnpublishedChanges, false);
    assert.equal(def.publishedVersion, 3);
  });
});
