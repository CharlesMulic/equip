"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  readPlatformsMeta, writePlatformsMeta, updatePlatformsMeta, setPlatformEnabled,
  getEnabledPlatformIds, isPlatformEnabled,
  readPlatformScan, writePlatformScan, scanPlatform, scanAllPlatforms,
} = require("../dist/lib/platform-state");

const {
  readInstallations, writeInstallations, trackInstallation, trackUninstallation,
  getAugmentsForPlatform, getManagedAugmentNames,
} = require("../dist/lib/installations");

const {
  readEquipMeta, writeEquipMeta, markScanCompleted, updatePreferences,
} = require("../dist/lib/equip-meta");

const { installMcpJson } = require("../dist/lib/mcp");

// ─── Helpers ────────────────────────────────────────────────

let originalHome;
let tempHome;

function setupTempHome() {
  originalHome = os.homedir;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-platstate-"));
  os.homedir = () => tempHome;
}

function teardownTempHome() {
  os.homedir = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
}

function mockDetectedPlatform(id, overrides = {}) {
  const configDir = path.join(tempHome, `.${id}`);
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "mcp.json");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2));
  }
  return {
    platform: id,
    configPath,
    rulesPath: null,
    skillsPath: null,
    existingMcp: null,
    rootKey: "mcpServers",
    configFormat: "json",
    ...overrides,
  };
}

// ─── Platform Metadata Tests ────────────────────────────────

describe("platform-state: platforms.json", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("readPlatformsMeta returns empty when file missing", () => {
    const meta = readPlatformsMeta();
    assert.equal(meta.lastScanned, "");
    assert.deepEqual(meta.platforms, {});
  });

  it("writePlatformsMeta creates the file", () => {
    const meta = { lastScanned: "2026-04-01T00:00:00Z", platforms: {} };
    writePlatformsMeta(meta);
    const read = readPlatformsMeta();
    assert.equal(read.lastScanned, "2026-04-01T00:00:00Z");
  });

  it("updatePlatformsMeta adds detected platforms", () => {
    const detected = [
      mockDetectedPlatform("test-a"),
      mockDetectedPlatform("test-b"),
    ];
    const meta = updatePlatformsMeta(detected);
    assert.equal(Object.keys(meta.platforms).length, 2);
    assert.ok(meta.platforms["test-a"].detected);
    assert.ok(meta.platforms["test-b"].detected);
    assert.ok(meta.platforms["test-a"].enabled);
    assert.ok(meta.lastScanned);
  });

  it("updatePlatformsMeta preserves enabled/disabled on re-scan", () => {
    const detected = [mockDetectedPlatform("test-a")];
    updatePlatformsMeta(detected);

    // Disable the platform
    setPlatformEnabled("test-a", false);

    // Re-scan — should preserve disabled state
    const meta = updatePlatformsMeta(detected);
    assert.ok(!meta.platforms["test-a"].enabled);
    assert.ok(meta.platforms["test-a"].disabledAt);
  });

  it("setPlatformEnabled toggles the flag", () => {
    updatePlatformsMeta([mockDetectedPlatform("test-a")]);

    setPlatformEnabled("test-a", false);
    let meta = readPlatformsMeta();
    assert.ok(!meta.platforms["test-a"].enabled);
    assert.ok(meta.platforms["test-a"].disabledAt);

    setPlatformEnabled("test-a", true);
    meta = readPlatformsMeta();
    assert.ok(meta.platforms["test-a"].enabled);
    assert.equal(meta.platforms["test-a"].disabledAt, undefined);
  });

  it("new platform appears as enabled by default", () => {
    const meta = updatePlatformsMeta([mockDetectedPlatform("new-platform")]);
    assert.ok(meta.platforms["new-platform"].enabled);
  });

  it("removed platform stays with detected: false", () => {
    updatePlatformsMeta([mockDetectedPlatform("test-a")]);
    // Second scan without test-a
    const meta = updatePlatformsMeta([]);
    assert.ok(!meta.platforms["test-a"].detected);
    assert.ok(meta.platforms["test-a"].enabled); // preference preserved
  });

  it("getEnabledPlatformIds returns only enabled platforms", () => {
    updatePlatformsMeta([
      mockDetectedPlatform("test-a"),
      mockDetectedPlatform("test-b"),
      mockDetectedPlatform("test-c"),
    ]);
    setPlatformEnabled("test-b", false);

    const enabled = getEnabledPlatformIds();
    assert.ok(enabled.has("test-a"));
    assert.ok(!enabled.has("test-b"));
    assert.ok(enabled.has("test-c"));
    assert.equal(enabled.size, 2);
  });

  it("isPlatformEnabled returns correct state", () => {
    updatePlatformsMeta([mockDetectedPlatform("test-a")]);
    assert.ok(isPlatformEnabled("test-a"));

    setPlatformEnabled("test-a", false);
    assert.ok(!isPlatformEnabled("test-a"));

    setPlatformEnabled("test-a", true);
    assert.ok(isPlatformEnabled("test-a"));
  });

  it("isPlatformEnabled returns true for unknown platforms", () => {
    // Unknown platforms default to enabled (don't block install on platforms
    // that haven't been scanned yet)
    assert.ok(isPlatformEnabled("never-seen-before"));
  });
});

// ─── Per-Platform Scan Tests ────────────────────────────────

describe("platform-state: platforms/<id>.json", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("readPlatformScan returns null for missing file", () => {
    const scan = readPlatformScan("nonexistent");
    assert.equal(scan, null);
  });

  it("scanPlatform reads all MCP entries from JSON config", () => {
    const p = mockDetectedPlatform("test-a");
    // Write some MCP entries to the config
    const config = {
      mcpServers: {
        prior: { url: "https://api.cg3.io/mcp", headers: { Authorization: "Bearer key" } },
        "custom-tool": { command: "node", args: ["server.js"] },
      },
    };
    fs.writeFileSync(p.configPath, JSON.stringify(config, null, 2));

    const scan = scanPlatform(p, new Set(["prior"]));
    assert.equal(scan.augmentCount, 2);
    assert.equal(scan.managedCount, 1);
    assert.ok(scan.augments.prior);
    assert.equal(scan.augments.prior.transport, "http");
    assert.equal(scan.augments.prior.managed, true);
    assert.ok(scan.augments["custom-tool"]);
    assert.equal(scan.augments["custom-tool"].transport, "stdio");
    assert.equal(scan.augments["custom-tool"].managed, false);
  });

  it("scanPlatform handles empty config", () => {
    const p = mockDetectedPlatform("test-a");
    const scan = scanPlatform(p);
    assert.equal(scan.augmentCount, 0);
    assert.equal(scan.managedCount, 0);
  });

  it("scanPlatform handles missing config file", () => {
    const p = mockDetectedPlatform("test-a");
    fs.unlinkSync(p.configPath); // remove the config
    const scan = scanPlatform(p);
    assert.equal(scan.augmentCount, 0);
  });

  it("writePlatformScan creates per-platform file", () => {
    const scan = { lastScanned: "2026-04-01T00:00:00Z", augments: {}, augmentCount: 0, managedCount: 0 };
    writePlatformScan("test-a", scan);

    const read = readPlatformScan("test-a");
    assert.ok(read);
    assert.equal(read.lastScanned, "2026-04-01T00:00:00Z");
  });

  it("scanAllPlatforms writes metadata and per-platform files", () => {
    const detected = [
      mockDetectedPlatform("test-a"),
      mockDetectedPlatform("test-b"),
    ];
    // Add an MCP entry to test-a
    const config = { mcpServers: { prior: { url: "https://example.com" } } };
    fs.writeFileSync(detected[0].configPath, JSON.stringify(config));

    const { meta, scans } = scanAllPlatforms(detected, new Set(["prior"]));

    assert.equal(Object.keys(meta.platforms).length, 2);
    assert.ok(scans["test-a"]);
    assert.ok(scans["test-b"]);
    assert.equal(scans["test-a"].augmentCount, 1);
    assert.equal(scans["test-b"].augmentCount, 0);

    // Verify files exist on disk
    assert.ok(readPlatformScan("test-a"));
    assert.ok(readPlatformScan("test-b"));
  });
});

// ─── Installations Tests ────────────────────────────────────

describe("installations.json", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("readInstallations returns empty when file missing", () => {
    const inst = readInstallations();
    assert.equal(inst.lastUpdated, "");
    assert.deepEqual(inst.augments, {});
  });

  it("trackInstallation creates new augment record", () => {
    trackInstallation("prior", {
      source: "registry",
      package: "prior",
      displayName: "Prior",
      transport: "http",
      serverUrl: "https://api.cg3.io/mcp",
      platforms: ["claude-code", "cursor"],
      artifacts: {
        "claude-code": { mcp: true, rules: "0.6.0", skills: ["search"] },
        "cursor": { mcp: true },
      },
    });

    const inst = readInstallations();
    assert.ok(inst.augments.prior);
    assert.equal(inst.augments.prior.platforms.length, 2);
    assert.equal(inst.augments.prior.artifacts["claude-code"].rules, "0.6.0");
    assert.ok(inst.augments.prior.installedAt);
  });

  it("trackInstallation adds platform to existing record", () => {
    trackInstallation("prior", {
      source: "registry", displayName: "Prior", transport: "http",
      platforms: ["claude-code"],
      artifacts: { "claude-code": { mcp: true } },
    });
    trackInstallation("prior", {
      source: "registry", displayName: "Prior", transport: "http",
      platforms: ["cursor"],
      artifacts: { "cursor": { mcp: true } },
    });

    const inst = readInstallations();
    assert.equal(inst.augments.prior.platforms.length, 2);
    assert.ok(inst.augments.prior.platforms.includes("claude-code"));
    assert.ok(inst.augments.prior.platforms.includes("cursor"));
  });

  it("trackUninstallation removes platform from record", () => {
    trackInstallation("prior", {
      source: "registry", displayName: "Prior", transport: "http",
      platforms: ["claude-code", "cursor"],
      artifacts: { "claude-code": { mcp: true }, "cursor": { mcp: true } },
    });

    trackUninstallation("prior", ["cursor"]);

    const inst = readInstallations();
    assert.ok(inst.augments.prior);
    assert.equal(inst.augments.prior.platforms.length, 1);
    assert.ok(inst.augments.prior.platforms.includes("claude-code"));
    assert.ok(!inst.augments.prior.artifacts.cursor);
  });

  it("trackUninstallation removes augment when no platforms remain", () => {
    trackInstallation("prior", {
      source: "registry", displayName: "Prior", transport: "http",
      platforms: ["claude-code"],
      artifacts: { "claude-code": { mcp: true } },
    });

    trackUninstallation("prior", ["claude-code"]);

    const inst = readInstallations();
    assert.equal(inst.augments.prior, undefined);
  });

  it("trackUninstallation without platforms removes entire record", () => {
    trackInstallation("prior", {
      source: "registry", displayName: "Prior", transport: "http",
      platforms: ["claude-code"],
      artifacts: { "claude-code": { mcp: true } },
    });

    trackUninstallation("prior");

    const inst = readInstallations();
    assert.equal(inst.augments.prior, undefined);
  });

  it("getAugmentsForPlatform returns correct reverse lookup", () => {
    trackInstallation("prior", {
      source: "registry", displayName: "Prior", transport: "http",
      platforms: ["claude-code", "cursor"],
      artifacts: { "claude-code": { mcp: true }, "cursor": { mcp: true } },
    });
    trackInstallation("docs", {
      source: "registry", displayName: "Docs", transport: "http",
      platforms: ["claude-code"],
      artifacts: { "claude-code": { mcp: true } },
    });

    const ccAugments = getAugmentsForPlatform("claude-code");
    assert.equal(ccAugments.length, 2);
    assert.ok(ccAugments.includes("prior"));
    assert.ok(ccAugments.includes("docs"));

    const cursorAugments = getAugmentsForPlatform("cursor");
    assert.equal(cursorAugments.length, 1);
    assert.ok(cursorAugments.includes("prior"));
  });

  it("getManagedAugmentNames returns all managed names", () => {
    trackInstallation("prior", {
      source: "registry", displayName: "Prior", transport: "http",
      platforms: ["claude-code"], artifacts: { "claude-code": { mcp: true } },
    });
    trackInstallation("docs", {
      source: "local", displayName: "Docs", transport: "http",
      platforms: ["claude-code"], artifacts: { "claude-code": { mcp: true } },
    });

    const names = getManagedAugmentNames();
    assert.ok(names.has("prior"));
    assert.ok(names.has("docs"));
    assert.ok(!names.has("unknown"));
  });
});

// ─── Equip Meta Tests ───────────────────────────────────────

describe("equip.json", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("readEquipMeta returns defaults when file missing", () => {
    const meta = readEquipMeta();
    assert.equal(meta.version, "");
    assert.ok(meta.preferences.telemetry);
    assert.ok(meta.preferences.autoScan);
    assert.equal(meta.preferences.scanIntervalMinutes, 60);
  });

  it("writeEquipMeta persists and reads back", () => {
    const meta = {
      version: "0.16.2",
      lastUpdated: "2026-04-01T00:00:00Z",
      lastScan: "2026-04-01T00:00:00Z",
      preferences: { telemetry: false, autoScan: true, scanIntervalMinutes: 30 },
    };
    writeEquipMeta(meta);

    const read = readEquipMeta();
    assert.equal(read.version, "0.16.2");
    assert.equal(read.preferences.telemetry, false);
    assert.equal(read.preferences.scanIntervalMinutes, 30);
  });

  it("markScanCompleted updates lastScan", () => {
    markScanCompleted();
    const meta = readEquipMeta();
    assert.ok(meta.lastScan);
    assert.notEqual(meta.lastScan, "");
  });

  it("updatePreferences merges with existing", () => {
    updatePreferences({ telemetry: false });
    let meta = readEquipMeta();
    assert.equal(meta.preferences.telemetry, false);
    assert.ok(meta.preferences.autoScan); // other prefs unchanged

    updatePreferences({ scanIntervalMinutes: 120 });
    meta = readEquipMeta();
    assert.equal(meta.preferences.scanIntervalMinutes, 120);
    assert.equal(meta.preferences.telemetry, false); // previous change preserved
  });
});

// ─── Auto-wrapping MCP servers ──────────────────────────────

const { readAugmentDef, hasAugmentDef, writeAugmentDef } = require("../dist/lib/augment-defs");

describe("Auto-wrapping MCP servers during scan", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("wraps unmanaged MCP server into an augment during scanAllPlatforms", () => {
    // Create a platform config with an unmanaged MCP server
    const configDir = path.join(tempHome, ".test-platform");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        "my-server": {
          command: "npx",
          args: ["-y", "my-mcp-server"]
        }
      }
    }));

    const detected = [{
      platform: "test-platform",
      configPath,
      rootKey: "mcpServers",
      configFormat: "json",
    }];

    const { scans } = scanAllPlatforms(detected, new Set());

    // Verify the augment was auto-wrapped
    assert.ok(hasAugmentDef("my-server"), "Augment should be created");
    const def = readAugmentDef("my-server");
    assert.equal(def.source, "wrapped");
    assert.equal(def.transport, "stdio");
    assert.equal(def.stdio.command, "npx");
    assert.deepEqual(def.stdio.args, ["-y", "my-mcp-server"]);
    assert.equal(def.wrappedFrom.type, "mcp");
    assert.equal(def.wrappedFrom.platform, "test-platform");
    assert.equal(def.wrappedFrom.originalName, "my-server");

    // Verify installation record was created
    const inst = readInstallations();
    assert.ok(inst.augments["my-server"]);
    assert.equal(inst.augments["my-server"].source, "wrapped");
    assert.deepEqual(inst.augments["my-server"].platforms, ["test-platform"]);

    // Verify scan marks it as managed
    assert.equal(scans["test-platform"].augments["my-server"].managed, true);
  });

  it("does not re-wrap an already existing augment", () => {
    // Pre-create the augment
    const augDir = path.join(tempHome, ".equip", "augments");
    fs.mkdirSync(augDir, { recursive: true });
    writeAugmentDef({
      name: "existing-server",
      source: "local",
      displayName: "Existing",
      description: "",
      transport: "http",
      serverUrl: "http://original.com",
      requiresAuth: false,
      skills: [],
      baseWeight: 0,
      loadedWeight: 0,
      modded: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    // Platform config has a server with the same name
    const configDir = path.join(tempHome, ".test-platform");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        "existing-server": { url: "http://different.com" }
      }
    }));

    scanAllPlatforms([{
      platform: "test-platform",
      configPath,
      rootKey: "mcpServers",
      configFormat: "json",
    }], new Set());

    // The original augment should be untouched
    const def = readAugmentDef("existing-server");
    assert.equal(def.source, "local");
    assert.equal(def.serverUrl, "http://original.com");
  });

  it("does not wrap already-managed servers", () => {
    const configDir = path.join(tempHome, ".test-platform");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        "managed-server": { command: "npx", args: ["managed-tool"] }
      }
    }));

    // Pass as managed
    scanAllPlatforms([{
      platform: "test-platform",
      configPath,
      rootKey: "mcpServers",
      configFormat: "json",
    }], new Set(["managed-server"]));

    // Should NOT be wrapped
    assert.ok(!hasAugmentDef("managed-server"));
  });

  it("wraps orphan skill files during scanAllPlatforms", () => {
    // Create Claude Code config with no MCP servers
    const claudeDir = path.join(tempHome, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const configPath = path.join(claudeDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));

    // Create an orphan skill directory
    const skillsDir = path.join(claudeDir, "skills", "my-custom-skill", "do-thing");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "# Do Thing\nDoes a thing.");

    const detected = [{
      platform: "claude-code",
      configPath,
      rootKey: "mcpServers",
      configFormat: "json",
    }];

    scanAllPlatforms(detected, new Set());

    // Verify the skill was auto-wrapped
    assert.ok(hasAugmentDef("my-custom-skill"), "Skill augment should be created");
    const def = readAugmentDef("my-custom-skill");
    assert.equal(def.source, "wrapped");
    assert.equal(def.wrappedFrom.type, "skill");
    assert.equal(def.wrappedFrom.platform, "claude-code");
    assert.equal(def.wrappedFrom.originalName, "my-custom-skill");

    // Verify installation record
    const inst = readInstallations();
    assert.ok(inst.augments["my-custom-skill"]);
    assert.deepEqual(inst.augments["my-custom-skill"].artifacts["claude-code"].skills, ["do-thing"]);
  });

  it("does not wrap skills owned by managed augments", () => {
    const claudeDir = path.join(tempHome, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const configPath = path.join(claudeDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));

    // Create a skill owned by "prior" (managed)
    const skillsDir = path.join(claudeDir, "skills", "prior", "search");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "# Search Prior");

    const detected = [{
      platform: "claude-code",
      configPath,
      rootKey: "mcpServers",
      configFormat: "json",
    }];

    // "prior" is managed
    scanAllPlatforms(detected, new Set(["prior"]));

    // Should NOT be wrapped
    assert.ok(!hasAugmentDef("prior") || readAugmentDef("prior")?.source !== "wrapped");
  });

  it("auto-wrap is idempotent — second scan does not duplicate", () => {
    const configDir = path.join(tempHome, ".test-platform");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        "idempotent-server": { url: "http://localhost:3000" }
      }
    }));

    const detected = [{
      platform: "test-platform",
      configPath,
      rootKey: "mcpServers",
      configFormat: "json",
    }];

    // First scan
    scanAllPlatforms(detected, new Set());
    assert.ok(hasAugmentDef("idempotent-server"));

    // Second scan — should not error or duplicate
    scanAllPlatforms(detected, new Set());
    const def = readAugmentDef("idempotent-server");
    assert.equal(def.source, "wrapped");
  });
});
