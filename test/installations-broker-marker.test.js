// Tests for Package 04 — additive installMode marker on ArtifactRecord.
//
// Contract:
//   - new field is OPTIONAL ("direct" | "broker" | undefined)
//   - undefined === "direct" semantically (legacy interpretation)
//   - read/write is round-trip preserving
//   - older installations.json files (no installMode) load and serialize
//     back without spurious mutation

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const {
  readInstallations,
  trackInstallation,
  trackUninstallation,
} = require("../dist/lib/installations");

let tempHome;
const origHomedir = os.homedir;

function setupTempHome() {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-broker-marker-"));
  os.homedir = () => tempHome;
  process.env.EQUIP_HOME = path.join(tempHome, ".equip");
  fs.mkdirSync(process.env.EQUIP_HOME, { recursive: true });
}

function teardownTempHome() {
  os.homedir = origHomedir;
  delete process.env.EQUIP_HOME;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}

describe("Package 04 — installations.json broker-managed marker", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("trackInstallation stores installMode='broker' on the artifact", () => {
    trackInstallation("notion-mcp", {
      source: "registry",
      package: "notion-mcp",
      title: "Notion MCP",
      transport: "stdio",
      platforms: ["codex"],
      artifacts: { codex: { mcp: true, installMode: "broker" } },
    });

    const inst = readInstallations();
    assert.equal(inst.augments["notion-mcp"].artifacts.codex.installMode, "broker");
    assert.equal(inst.augments["notion-mcp"].artifacts.codex.mcp, true);
  });

  it("trackInstallation tolerates undefined installMode (legacy direct path)", () => {
    trackInstallation("legacy-augment", {
      source: "registry",
      title: "Legacy Augment",
      transport: "http",
      platforms: ["claude-code"],
      artifacts: { "claude-code": { mcp: true } },
    });

    const inst = readInstallations();
    // Should NOT spuriously add an installMode field — old installs read
    // back exactly as they were written (no schema-migration drift).
    const artifact = inst.augments["legacy-augment"].artifacts["claude-code"];
    assert.equal(artifact.installMode, undefined);
    assert.equal(artifact.mcp, true);
  });

  it("loading a file without installMode keeps it undefined on round-trip", () => {
    // Simulate an installations.json from an older equip version.
    const installationsPath = path.join(process.env.EQUIP_HOME, "installations.json");
    fs.writeFileSync(installationsPath, JSON.stringify({
      lastUpdated: "2026-01-01T00:00:00.000Z",
      augments: {
        "old-augment": {
          source: "registry",
          title: "Old Augment",
          transport: "http",
          installedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          platforms: ["claude-code"],
          artifacts: { "claude-code": { mcp: true } },
        },
      },
    }, null, 2));

    const inst = readInstallations();
    assert.equal(inst.augments["old-augment"].artifacts["claude-code"].installMode, undefined);
    assert.equal(inst.augments["old-augment"].artifacts["claude-code"].mcp, true);
  });

  it("supports mixed-mode installs across platforms for the same augment", () => {
    // Realistic during migration: Codex on broker, Claude Code still on direct.
    trackInstallation("notion-mcp", {
      source: "registry",
      package: "notion-mcp",
      title: "Notion MCP",
      transport: "stdio",
      platforms: ["codex", "claude-code"],
      artifacts: {
        codex: { mcp: true, installMode: "broker" },
        "claude-code": { mcp: true, installMode: "direct" },
      },
    });

    const inst = readInstallations();
    const artifacts = inst.augments["notion-mcp"].artifacts;
    assert.equal(artifacts.codex.installMode, "broker");
    assert.equal(artifacts["claude-code"].installMode, "direct");
  });

  it("trackUninstallation removes only the targeted platform's artifact", () => {
    trackInstallation("notion-mcp", {
      source: "registry",
      title: "Notion MCP",
      transport: "stdio",
      platforms: ["codex", "claude-code"],
      artifacts: {
        codex: { mcp: true, installMode: "broker" },
        "claude-code": { mcp: true, installMode: "direct" },
      },
    });

    trackUninstallation("notion-mcp", ["codex"]);

    const inst = readInstallations();
    assert.ok(inst.augments["notion-mcp"], "augment should still exist");
    assert.deepEqual(inst.augments["notion-mcp"].platforms, ["claude-code"]);
    assert.equal(inst.augments["notion-mcp"].artifacts.codex, undefined);
    assert.equal(inst.augments["notion-mcp"].artifacts["claude-code"].installMode, "direct");
  });
});
