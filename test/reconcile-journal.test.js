// Phase A.3b coverage — reconcileState writes content + install intent to
// the journal directly when called with a toolDef. Locks the contract that
// the apply→reconcile pipeline produces journal-canonical state for
// readers such as doctor, skills, and status.
//
// This test pre-stages a Codex platform with the augment present in its
// MCP config so the platform-presence scan finds it; then asserts the
// journal reflects the install with the right contentHash + installModes.

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { reconcileState } = require("../dist/lib/reconcile");
const { JsonStore } = require("../dist/lib/storage/datastore.js");
const { setupFullHome } = require("./_isolation");

let isolation, tempHome;

function setupTempHome() {
  isolation = setupFullHome("reconcile-journal");
  tempHome = isolation.home;
}

function teardownTempHome() {
  isolation.dispose();
}

describe("Phase A.3b — reconcileState journal writes", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("appends an install intent and stores content when called with a registry toolDef", () => {
    // Pre-stage a Codex config with the augment present so the platform
    // scan finds it.
    const codexConfigPath = path.join(tempHome, "config.toml");
    fs.writeFileSync(codexConfigPath, `[mcp_servers.demo-aug]\nurl = "https://demo.example/mcp"\n`);

    const toolDef = {
      name: "demo-aug",
      title: "Demo Augment",
      description: "for journal coverage",
      transport: "http",
      serverUrl: "https://demo.example/mcp",
      requiresAuth: false,
      version: 7,
      contentHash: "etag-abc",
      skills: [],
    };

    const count = reconcileState({
      toolName: "demo-aug",
      package: "@cg3/demo-aug",
      marker: "demo-aug",
      toolDef,
    });

    assert.ok(count >= 1, `expected reconcile to find at least one platform; got ${count}`);

    // Journal: content blob + install intent must be present.
    const resolved = JsonStore.resolve("demo-aug");
    assert.ok(resolved, "journal should have a resolved view for demo-aug");
    assert.equal(resolved.installed, true, "augment should be marked installed");
    assert.ok(resolved.installedPlatforms.includes("codex"), "codex should be in installedPlatforms");
    assert.equal(resolved.title, "Demo Augment");
    assert.equal(resolved.serverUrl, "https://demo.example/mcp");
    assert.equal(resolved.contentSource.kind, "registry");
    assert.equal(resolved.contentSource.version, 7);
    assert.equal(resolved.contentSource.etag, "etag-abc");
  });

  it("preserves broker installMode across consecutive reconciles", () => {
    const codexConfigPath = path.join(tempHome, "config.toml");
    fs.writeFileSync(codexConfigPath, `[mcp_servers.broker-aug]\ncommand = "/opt/equip/bin/equip-broker-fd-bridge"\nargs = ["--augment", "broker-aug"]\n`);

    const toolDef = {
      name: "broker-aug",
      title: "Broker Augment",
      description: "broker-managed",
      transport: "stdio",
      stdioCommand: "/opt/equip/bin/equip-broker-fd-bridge",
      stdioArgs: ["--augment", "broker-aug"],
      requiresAuth: false,
      version: 1,
      skills: [],
    };

    // First, seed the journal with a broker-mode install intent. A broker
    // integration would append this when the user installs in broker mode;
    // here we synthesize it directly.
    const seedContent = {
      name: "broker-aug",
      title: "Broker Augment",
      description: "broker-managed",
      transport: "stdio",
      stdio: { command: "/opt/equip/bin/equip-broker-fd-bridge", args: ["--augment", "broker-aug"] },
      requiresAuth: false,
    };
    const seedHash = JsonStore.putContent(seedContent);
    JsonStore.appendIntent({
      type: "install-augment",
      clock: JsonStore.newClock(),
      name: "broker-aug",
      contentHash: seedHash,
      contentSource: { kind: "registry", version: 1, fetchedAt: new Date().toISOString() },
      platforms: ["codex"],
      installModes: { codex: "broker" },
    });

    // Reconcile (e.g., post-apply) should preserve the broker mode.
    reconcileState({
      toolName: "broker-aug",
      package: "broker-aug",
      marker: "broker-aug",
      toolDef,
    });

    const resolved = JsonStore.resolve("broker-aug");
    assert.ok(resolved, "journal should have a resolved view");
    assert.equal(
      resolved.installModes.codex,
      "broker",
      "broker mode must persist across reconciles (would silently downgrade to direct otherwise)",
    );
  });

  it("does not append an install intent when called without a toolDef", () => {
    // CLI `equip` discovery path — no toolDef means no new content to
    // record. Should still update platform state but not append.
    const before = JsonStore.readIntents().length;

    reconcileState({
      toolName: "discovery-only",
      package: "discovery-only",
      marker: "discovery-only",
      // no toolDef
    });

    const after = JsonStore.readIntents().length;
    assert.equal(after, before, "no install intent should be appended when toolDef is absent");
  });
});
