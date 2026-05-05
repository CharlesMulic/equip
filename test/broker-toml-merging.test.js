// Tests that installMcpBroker preserves pre-existing
// [mcp_servers.*] TOML entries when merging into Codex's config.toml.
//
// Product strategist's "single most embarrassing failure mode" — a user has
// other MCP tools already configured and Equip's install corrupts or
// overwrites them. The heavy E2E version of this test lives in
// integration-tests/; this lightweight version pins the writer logic in
// pure unit-test scope so a regression fires early without a full
// Docker phase run.

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { Augment } = require("..");
const { parseTomlServerEntry } = require("../dist/lib/mcp");
const { setupInstalledAugment } = require("./storage/_test-helpers");
const { setupFullHome } = require("./_isolation");

function tmpPath(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function mockCodexPlatform(configPath) {
  return {
    platform: "codex",
    configPath,
    rulesPath: null,
    skillsPath: null,
    existingMcp: null,
    rootKey: "mcp_servers",
    configFormat: "toml",
  };
}

function cleanup(p) { try { fs.unlinkSync(p); } catch { /* ignore */ } }

const BRIDGE_BIN = "/opt/equip/bin/equip-broker-fd-bridge";

const PRE_EXISTING_TOML = `[mcp_servers.user-github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]

[mcp_servers.user-github.env]
GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_test_token_placeholder"

[mcp_servers.user-notes]
url = "http://localhost:5499/mcp"

[mcp_servers.user-notes.http_headers]
X-User-Api-Key = "user-secret-placeholder"
`;

describe("installMcpBroker preserves pre-existing TOML entries", () => {
  it("user-managed entries survive byte-for-byte after broker install", () => {
    const configPath = tmpPath("codex-merge") + ".toml";
    fs.writeFileSync(configPath, PRE_EXISTING_TOML);

    const p = mockCodexPlatform(configPath);
    const augment = new Augment({ name: "stub-broker-augment", serverUrl: "https://example.com/mcp" });
    const result = augment.installMcpBroker(p, { bridgeBinaryPath: BRIDGE_BIN });

    assert.equal(result.success, true);

    const written = fs.readFileSync(configPath, "utf-8");

    // Pre-existing entries must still be there.
    const userGithub = parseTomlServerEntry(written, "mcp_servers", "user-github");
    assert.ok(userGithub, "user-github entry must survive broker install");
    assert.equal(userGithub.command, "npx");

    const userNotes = parseTomlServerEntry(written, "mcp_servers", "user-notes");
    assert.ok(userNotes, "user-notes entry must survive broker install");
    assert.equal(userNotes.url, "http://localhost:5499/mcp");

    // The new broker entry must also be there.
    const ours = parseTomlServerEntry(written, "mcp_servers", "stub-broker-augment");
    assert.ok(ours, "broker entry must be present");
    assert.equal(ours.command, BRIDGE_BIN);

    // No OAuth-shaped keys leaked into the file via the merge path.
    assert.ok(!/bearer_token_env_var/i.test(written));
    assert.ok(!/oauth_resource/i.test(written));

    cleanup(configPath);
  });

  it("re-installing the same broker augment is idempotent (replaces the entry, preserves others)", () => {
    // Need a tempHome so installations.json doesn't leak across tests.
    const isolation = setupFullHome("broker-reinstall");

    try {
      const configPath = tmpPath("codex-reinstall") + ".toml";
      fs.writeFileSync(configPath, PRE_EXISTING_TOML);

      const p = mockCodexPlatform(configPath);
      const augment = new Augment({ name: "stub-broker-augment", serverUrl: "https://example.com/mcp" });

      // First install + register as managed (this is what install.ts does in the
      // real flow — installMcpBroker is symmetric with installMcp and doesn't
      // do its own tracking).
      const r1 = augment.installMcpBroker(p, { bridgeBinaryPath: BRIDGE_BIN });
      assert.equal(r1.success, true);
      setupInstalledAugment("stub-broker-augment", {
        source: "registry",
        title: "Stub Broker Augment",
        transport: "stdio",
        platforms: ["codex"],
      });

      // Second install with different shim path (simulating an Equip upgrade
      // that moved the binary). Now Equip recognizes its own managed entry and
      // overwrites without conflict.
      const newBridge = "/Library/equip/bin/equip-broker-fd-bridge";
      const r2 = augment.installMcpBroker(p, { bridgeBinaryPath: newBridge });
      assert.equal(r2.success, true, `reinstall must succeed, got: ${r2.error}`);

      const written = fs.readFileSync(configPath, "utf-8");

      // Old entries still there.
      assert.ok(parseTomlServerEntry(written, "mcp_servers", "user-github"));
      assert.ok(parseTomlServerEntry(written, "mcp_servers", "user-notes"));

      // Our entry was replaced, not duplicated.
      const ours = parseTomlServerEntry(written, "mcp_servers", "stub-broker-augment");
      assert.equal(ours.command, newBridge, "second install must update command to new shim path");

      // Count occurrences of the augment's table header — must be exactly one.
      const headerMatches = written.match(/\[mcp_servers\.stub-broker-augment\]/g) ?? [];
      assert.equal(headerMatches.length, 1, "must have exactly one entry for the augment after reinstall");

      cleanup(configPath);
    } finally {
      isolation.dispose();
    }
  });

  it("install into a fresh (no file) Codex config writes only the broker entry", () => {
    const configPath = tmpPath("codex-fresh") + ".toml";
    cleanup(configPath);

    const p = mockCodexPlatform(configPath);
    const augment = new Augment({ name: "stub-broker-augment", serverUrl: "https://example.com/mcp" });
    const result = augment.installMcpBroker(p, { bridgeBinaryPath: BRIDGE_BIN });

    assert.equal(result.success, true);
    const written = fs.readFileSync(configPath, "utf-8");
    const ours = parseTomlServerEntry(written, "mcp_servers", "stub-broker-augment");
    assert.ok(ours);
    assert.equal(ours.command, BRIDGE_BIN);

    cleanup(configPath);
  });

  it("conflict: refuses to overwrite an unmanaged entry with the same name", () => {
    // A user has already hand-rolled an MCP entry called "stub-broker-augment".
    // Equip must NOT silently replace it.
    const configPath = tmpPath("codex-conflict") + ".toml";
    fs.writeFileSync(configPath, `[mcp_servers.stub-broker-augment]
command = "user-hand-rolled-server"
args = ["--port", "9999"]
`);

    const p = mockCodexPlatform(configPath);
    const augment = new Augment({ name: "stub-broker-augment", serverUrl: "https://example.com/mcp" });
    const result = augment.installMcpBroker(p, { bridgeBinaryPath: BRIDGE_BIN });

    assert.equal(result.success, false);
    assert.equal(result.errorCode, "CONFIG_CONFLICT");

    // User's entry must be untouched.
    const written = fs.readFileSync(configPath, "utf-8");
    const theirs = parseTomlServerEntry(written, "mcp_servers", "stub-broker-augment");
    assert.equal(theirs.command, "user-hand-rolled-server");

    cleanup(configPath);
  });
});
