// Phase A.3b.1 coverage — journal-bridge in legacy trackInstallation.
//
// The bridge propagates writes from un-migrated tier-3 callers
// (platform-state auto-wrap, install.ts user-save, registry-refresh)
// into the canonical journal so journal-canonical readers (doctor,
// skills, status) see them. Removed in A4 along with installations.ts.
//
// What we lock here:
//   1. trackInstallation appends an InstallAugmentIntent when a legacy
//      def is resolvable.
//   2. trackInstallation skips appending when no legacy def exists (the
//      journal is presumably already authoritative — over-appending
//      would wipe the journal's richer content).
//   3. Broker installMode is preserved across consecutive trackInstallation
//      calls (latest-install-intent-wins on installModes — would silently
//      downgrade without explicit carry-forward).
//   4. trackUninstallation appends an UninstallAugmentIntent.

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { trackInstallation, trackUninstallation } = require("../dist/lib/installations");
const { writeAugmentDef } = require("../dist/lib/augment-defs");
const { JsonStore } = require("../dist/lib/storage/datastore.js");
const { setupFullHome } = require("./_isolation");

let isolation;

function setupTempHome() { isolation = setupFullHome("bridge"); }
function teardownTempHome() { isolation.dispose(); }

describe("Phase A.3b.1 — installations.ts journal-bridge", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("trackInstallation appends an install intent when a legacy def is resolvable", () => {
    // Seed the legacy def store so the bridge's resolver call returns content.
    writeAugmentDef({
      name: "bridge-aug",
      source: "registry",
      title: "Bridge Augment",
      description: "for bridge coverage",
      transport: "http",
      serverUrl: "https://bridge.example/mcp",
      requiresAuth: false,
      skills: [],
      modded: false,
      baseWeight: 0,
      loadedWeight: 0,
    });

    trackInstallation("bridge-aug", {
      source: "registry",
      title: "Bridge Augment",
      transport: "http",
      serverUrl: "https://bridge.example/mcp",
      platforms: ["claude-code"],
      artifacts: { "claude-code": { mcp: true } },
    });

    const resolved = JsonStore.resolve("bridge-aug");
    assert.ok(resolved, "journal should reflect the install");
    assert.equal(resolved.installed, true);
    assert.deepEqual(resolved.installedPlatforms, ["claude-code"]);
    assert.equal(resolved.serverUrl, "https://bridge.example/mcp");
  });

  it("trackInstallation does NOT append when no legacy def exists (journal stays authoritative)", () => {
    // No def seeded → bridge resolver returns null → bridge skips appendIntent.
    const before = JsonStore.readIntents().length;

    trackInstallation("no-def-aug", {
      source: "registry",
      title: "No Def",
      transport: "http",
      serverUrl: "https://nodef.example/mcp",
      platforms: ["claude-code"],
      artifacts: { "claude-code": { mcp: true } },
    });

    const after = JsonStore.readIntents().length;
    assert.equal(after, before, "bridge must not append a sparse intent that would clobber the journal");
  });

  it("preserves broker installMode across consecutive trackInstallation calls", () => {
    // Seed the legacy def so the bridge can resolve content.
    writeAugmentDef({
      name: "broker-bridge",
      source: "registry",
      title: "Broker Bridge",
      description: "broker mode preservation",
      transport: "stdio",
      stdio: { command: "/bin/shim", args: [], envKey: "" },
      requiresAuth: false,
      skills: [],
      modded: false,
      baseWeight: 0,
      loadedWeight: 0,
    });

    // First call: broker mode on codex.
    trackInstallation("broker-bridge", {
      source: "registry",
      title: "Broker Bridge",
      transport: "stdio",
      platforms: ["codex"],
      artifacts: { codex: { mcp: true, installMode: "broker" } },
    });

    // Second call: same install (e.g., re-reconcile) but without
    // installMode in artifacts — typical of legacy callers that don't
    // know about broker mode. Bridge must carry broker forward.
    trackInstallation("broker-bridge", {
      source: "registry",
      title: "Broker Bridge",
      transport: "stdio",
      platforms: ["codex"],
      artifacts: { codex: { mcp: true } }, // installMode absent
    });

    const resolved = JsonStore.resolve("broker-bridge");
    assert.ok(resolved);
    assert.equal(
      resolved.installModes.codex,
      "broker",
      "broker mode must persist across consecutive trackInstallation calls",
    );
  });

  it("trackUninstallation appends an UninstallAugmentIntent", () => {
    // Seed an install in the journal so we can verify the uninstall.
    writeAugmentDef({
      name: "uninstall-bridge",
      source: "registry",
      title: "Uninstall Bridge",
      description: "uninstall coverage",
      transport: "http",
      serverUrl: "https://un.example/mcp",
      requiresAuth: false,
      skills: [],
      modded: false,
      baseWeight: 0,
      loadedWeight: 0,
    });
    trackInstallation("uninstall-bridge", {
      source: "registry",
      title: "Uninstall Bridge",
      transport: "http",
      serverUrl: "https://un.example/mcp",
      platforms: ["claude-code"],
      artifacts: { "claude-code": { mcp: true } },
    });

    let resolved = JsonStore.resolve("uninstall-bridge");
    assert.equal(resolved.installed, true, "should be installed before uninstall");

    trackUninstallation("uninstall-bridge");

    resolved = JsonStore.resolve("uninstall-bridge");
    assert.equal(resolved.installed, false, "uninstall intent should clear installed flag");
    assert.deepEqual(resolved.installedPlatforms, []);
  });
});
