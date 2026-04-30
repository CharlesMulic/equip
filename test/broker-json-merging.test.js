// Tests for Package 05 — installMcpBroker preserves pre-existing
// mcpServers[*] JSON entries when merging into Claude Code's
// .claude.json or Cursor's mcp.json.
//
// Mirrors the Codex broker-toml-merging.test.js shape; both platforms
// share the same JSON config format (rootKey: "mcpServers"), so the
// merge story is the same — entries other than the augment's must
// survive byte-for-byte.

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { Augment } = require("..");
const { setupInstalledAugment } = require("./storage/_test-helpers");
const { setupFullHome } = require("./_isolation");

function tmpPath(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function mockJsonPlatform(platformId, configPath) {
  return {
    platform: platformId,
    configPath,
    rulesPath: null,
    skillsPath: null,
    existingMcp: null,
    rootKey: "mcpServers",
    configFormat: "json",
  };
}

function cleanup(p) { try { fs.unlinkSync(p); } catch { /* ignore */ } }

const SHIM_BIN = "/opt/equip-app/bin/equip-broker-shim";

const PRE_EXISTING_JSON = JSON.stringify({
  mcpServers: {
    "user-github": {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_test_token_placeholder" },
    },
    "user-notes": {
      type: "http",
      url: "http://localhost:5499/mcp",
      headers: { "X-User-Api-Key": "user-secret-placeholder" },
    },
  },
}, null, 2);

// Subroutines parameterized by platform id — same JSON format means
// the same test plan applies; varying just the platformId catches a
// regression that hits one platform and not the other.
function runPreserveTest(platformId) {
  const configPath = tmpPath(`${platformId}-merge`) + ".json";
  fs.writeFileSync(configPath, PRE_EXISTING_JSON);

  const p = mockJsonPlatform(platformId, configPath);
  const augment = new Augment({ name: "stub-broker-augment", serverUrl: "https://example.com/mcp" });
  const result = augment.installMcpBroker(p, { shimBinaryPath: SHIM_BIN });

  assert.equal(result.success, true, `${platformId}: install must succeed`);

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  // Pre-existing entries must still be there, byte-equivalent.
  assert.deepEqual(config.mcpServers["user-github"], {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_test_token_placeholder" },
  }, `${platformId}: user-github entry must be byte-equivalent`);
  assert.deepEqual(config.mcpServers["user-notes"], {
    type: "http",
    url: "http://localhost:5499/mcp",
    headers: { "X-User-Api-Key": "user-secret-placeholder" },
  }, `${platformId}: user-notes entry must be byte-equivalent`);

  // The new broker entry must be there with the canonical shape.
  const ours = config.mcpServers["stub-broker-augment"];
  assert.ok(ours, `${platformId}: broker entry must be present`);
  assert.equal(ours.command, SHIM_BIN);
  assert.deepEqual(Object.keys(ours).sort(), ["args", "command"], `${platformId}: only command + args`);

  cleanup(configPath);
}

describe("Package 05 — installMcpBroker preserves pre-existing JSON entries", () => {
  it("Claude Code: user-managed entries survive byte-for-byte", () => {
    runPreserveTest("claude-code");
  });

  it("Cursor: user-managed entries survive byte-for-byte", () => {
    runPreserveTest("cursor");
  });

  it("Claude Code: re-install replaces broker entry, preserves others", () => {
    const isolation = setupFullHome("broker-cc-reinstall");

    try {
      const configPath = tmpPath("cc-reinstall") + ".json";
      fs.writeFileSync(configPath, PRE_EXISTING_JSON);

      const p = mockJsonPlatform("claude-code", configPath);
      const augment = new Augment({ name: "stub-broker-augment", serverUrl: "https://example.com/mcp" });

      augment.installMcpBroker(p, { shimBinaryPath: SHIM_BIN });
      setupInstalledAugment("stub-broker-augment", {
        source: "registry",
        title: "Stub Broker Augment",
        transport: "stdio",
        platforms: ["claude-code"],
      });

      const newShim = "/Library/equip-app/bin/equip-broker-shim";
      const r2 = augment.installMcpBroker(p, { shimBinaryPath: newShim });
      assert.equal(r2.success, true, `reinstall must succeed; got: ${r2.error}`);

      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      assert.ok(config.mcpServers["user-github"]);
      assert.ok(config.mcpServers["user-notes"]);
      assert.equal(config.mcpServers["stub-broker-augment"].command, newShim);

      cleanup(configPath);
    } finally {
      isolation.dispose();
    }
  });

  it("Cursor: install into a fresh (no file) config writes only the broker entry", () => {
    const configPath = tmpPath("cursor-fresh") + ".json";
    cleanup(configPath);

    const p = mockJsonPlatform("cursor", configPath);
    const augment = new Augment({ name: "stub-broker-augment", serverUrl: "https://example.com/mcp" });
    const result = augment.installMcpBroker(p, { shimBinaryPath: SHIM_BIN });

    assert.equal(result.success, true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(Object.keys(config.mcpServers).length, 1);
    assert.equal(config.mcpServers["stub-broker-augment"].command, SHIM_BIN);

    cleanup(configPath);
  });

  it("Claude Code: refuses to overwrite an unmanaged entry with the same name", () => {
    const configPath = tmpPath("cc-conflict") + ".json";
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        "stub-broker-augment": {
          command: "user-hand-rolled-server",
          args: ["--port", "9999"],
        },
      },
    }, null, 2));

    const p = mockJsonPlatform("claude-code", configPath);
    const augment = new Augment({ name: "stub-broker-augment", serverUrl: "https://example.com/mcp" });
    const result = augment.installMcpBroker(p, { shimBinaryPath: SHIM_BIN });

    assert.equal(result.success, false);
    assert.equal(result.errorCode, "CONFIG_CONFLICT");

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(config.mcpServers["stub-broker-augment"].command, "user-hand-rolled-server");

    cleanup(configPath);
  });

  it("Cursor: refuses to overwrite an unmanaged entry with the same name", () => {
    const configPath = tmpPath("cursor-conflict") + ".json";
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        "stub-broker-augment": {
          url: "https://hand-rolled.example/mcp",
          headers: { Authorization: "Bearer user-key" },
        },
      },
    }, null, 2));

    const p = mockJsonPlatform("cursor", configPath);
    const augment = new Augment({ name: "stub-broker-augment", serverUrl: "https://example.com/mcp" });
    const result = augment.installMcpBroker(p, { shimBinaryPath: SHIM_BIN });

    assert.equal(result.success, false);
    assert.equal(result.errorCode, "CONFIG_CONFLICT");

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(config.mcpServers["stub-broker-augment"].url, "https://hand-rolled.example/mcp");

    cleanup(configPath);
  });
});
