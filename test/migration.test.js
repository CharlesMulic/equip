"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { migrateState } = require("../dist/lib/migration");
const { readInstallations } = require("../dist/lib/installations");
const { readAugmentDef } = require("../dist/lib/augment-defs");
const { readEquipMeta } = require("../dist/lib/equip-meta");

// ─── Helpers ────────────────────────────────────────────────

let originalHome;
let tempHome;

function setupTempHome() {
  originalHome = os.homedir;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-migrate-"));
  os.homedir = () => tempHome;
}

function teardownTempHome() {
  os.homedir = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
}

function writeOldState(state) {
  const dir = path.join(tempHome, ".equip");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
}

function writeCachedToolDef(name, def) {
  const dir = path.join(tempHome, ".equip", "cache");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(def, null, 2));
}

// ─── Tests ──────────────────────────────────────────────────

describe("migration", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("returns migrated:false when no state.json exists", () => {
    const result = migrateState();
    assert.ok(!result.migrated);
  });

  it("returns migrated:false when installations.json already exists", () => {
    writeOldState({
      equipVersion: "0.16.1",
      lastUpdated: "2026-04-01T00:00:00Z",
      tools: { prior: { package: "prior", installedAt: "2026-04-01T00:00:00Z", platforms: {} } },
    });
    // Create installations.json to simulate already-migrated state
    const dir = path.join(tempHome, ".equip");
    fs.writeFileSync(path.join(dir, "installations.json"), "{}");

    const result = migrateState();
    assert.ok(!result.migrated);
  });

  it("migrateState converts state.json to new files", () => {
    writeOldState({
      equipVersion: "0.16.1",
      lastUpdated: "2026-04-01T00:00:00Z",
      tools: {
        prior: {
          package: "prior",
          installedAt: "2026-03-29T20:51:09Z",
          updatedAt: "2026-03-31T05:26:50Z",
          platforms: {
            "claude-code": {
              configPath: "/home/user/.claude.json",
              transport: "http",
              rulesVersion: "0.6.0",
              hookScripts: ["prior-handler.js"],
              skillNames: ["search"],
            },
            "cursor": {
              configPath: "/home/user/.cursor/mcp.json",
              transport: "http",
              skillName: "search",
            },
          },
        },
      },
    });

    const result = migrateState();

    assert.ok(result.migrated);
    assert.equal(result.errors.length, 0);
    assert.equal(result.augmentsCreated, 1);
    assert.equal(result.installationsCreated, 1);
    assert.ok(result.equipMetaCreated);
    assert.ok(result.stateRenamed);
  });

  it("migrateState creates augment definitions from cache", () => {
    writeOldState({
      equipVersion: "0.16.1",
      lastUpdated: "2026-04-01T00:00:00Z",
      tools: {
        prior: {
          package: "prior",
          installedAt: "2026-03-29T00:00:00Z",
          platforms: { "claude-code": { transport: "http" } },
        },
      },
    });

    writeCachedToolDef("prior", {
      name: "prior",
      displayName: "Prior — Agent Knowledge Base",
      description: "Search solutions other agents found.",
      installMode: "direct",
      transport: "http",
      serverUrl: "https://api.cg3.io/mcp",
      requiresAuth: true,
      rules: { content: "## Prior\n\nSearch.", version: "0.6.0", marker: "prior" },
      skills: [{ name: "search", files: [{ path: "SKILL.md", content: "# Search\n" }] }],
    });

    migrateState();

    const def = readAugmentDef("prior");
    assert.ok(def);
    assert.equal(def.displayName, "Prior — Agent Knowledge Base");
    assert.equal(def.serverUrl, "https://api.cg3.io/mcp");
    assert.equal(def.rules.version, "0.6.0");
    assert.equal(def.skills.length, 1);
  });

  it("migrateState preserves all platform records in installations.json", () => {
    writeOldState({
      equipVersion: "0.16.1",
      lastUpdated: "2026-04-01T00:00:00Z",
      tools: {
        prior: {
          package: "prior",
          installedAt: "2026-03-29T00:00:00Z",
          updatedAt: "2026-03-31T00:00:00Z",
          platforms: {
            "claude-code": {
              transport: "http",
              rulesVersion: "0.6.0",
              hookScripts: ["prior-handler.js"],
              skillNames: ["search"],
            },
            "cursor": {
              transport: "http",
              skillName: "search",
            },
            "codex": {
              transport: "http",
              rulesVersion: "0.6.0",
            },
          },
        },
      },
    });

    migrateState();

    const inst = readInstallations();
    assert.ok(inst.augments.prior);
    assert.equal(inst.augments.prior.platforms.length, 3);
    assert.ok(inst.augments.prior.platforms.includes("claude-code"));
    assert.ok(inst.augments.prior.platforms.includes("cursor"));
    assert.ok(inst.augments.prior.platforms.includes("codex"));
    assert.equal(inst.augments.prior.artifacts["claude-code"].rules, "0.6.0");
    assert.deepEqual(inst.augments.prior.artifacts["claude-code"].hooks, ["prior-handler.js"]);
    assert.deepEqual(inst.augments.prior.artifacts["claude-code"].skills, ["search"]);
    // cursor has skillName (deprecated) → should become skills array
    assert.deepEqual(inst.augments.prior.artifacts["cursor"].skills, ["search"]);
  });

  it("migrateState renames state.json to state.json.migrated", () => {
    writeOldState({
      equipVersion: "0.16.1",
      lastUpdated: "2026-04-01T00:00:00Z",
      tools: { prior: { package: "prior", installedAt: "2026-04-01T00:00:00Z", platforms: { cc: { transport: "http" } } } },
    });

    migrateState();

    assert.ok(!fs.existsSync(path.join(tempHome, ".equip", "state.json")));
    assert.ok(fs.existsSync(path.join(tempHome, ".equip", "state.json.migrated")));
  });

  it("migrateState is idempotent", () => {
    writeOldState({
      equipVersion: "0.16.1",
      lastUpdated: "2026-04-01T00:00:00Z",
      tools: { prior: { package: "prior", installedAt: "2026-04-01T00:00:00Z", platforms: { cc: { transport: "http" } } } },
    });

    const result1 = migrateState();
    assert.ok(result1.migrated);

    // Try again — should not re-migrate (installations.json exists, state.json renamed)
    const result2 = migrateState();
    assert.ok(!result2.migrated);
  });

  it("migrateState handles missing cache gracefully", () => {
    writeOldState({
      equipVersion: "0.16.1",
      lastUpdated: "2026-04-01T00:00:00Z",
      tools: {
        "unknown-tool": {
          package: "unknown-tool",
          installedAt: "2026-04-01T00:00:00Z",
          platforms: { cc: { transport: "stdio" } },
        },
      },
    });

    // No cache file — should create a minimal augment definition
    const result = migrateState();
    assert.ok(result.migrated);
    assert.equal(result.augmentsCreated, 1);

    const def = readAugmentDef("unknown-tool");
    assert.ok(def);
    assert.equal(def.name, "unknown-tool");
    assert.equal(def.transport, "stdio");
    assert.equal(def.description, ""); // no cache means no metadata
  });

  it("migrateState creates equip.json with correct metadata", () => {
    writeOldState({
      equipVersion: "0.16.1",
      lastUpdated: "2026-03-31T04:49:33Z",
      tools: { prior: { package: "prior", installedAt: "2026-04-01T00:00:00Z", platforms: { cc: { transport: "http" } } } },
    });

    migrateState();

    const meta = readEquipMeta();
    assert.equal(meta.version, "0.16.1");
    assert.equal(meta.lastUpdated, "2026-03-31T04:49:33Z");
    assert.ok(meta.preferences.telemetry);
  });
});
