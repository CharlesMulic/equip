// Tests for Package 04 — Augment.installMcpBroker dispatch.
//
// Coverage:
//   - happy path: Codex install via broker writes the broker-shim entry
//   - Codex broker entry round-trips through readMcp with no OAuth keys
//   - direct-mode installMcp on Codex still works unchanged (additive guarantee)
//   - non-broker platform returns BROKER_NOT_SUPPORTED (caller falls back)
//   - dry-run does not touch disk
//   - shimExtraArgs are forwarded into the entry args

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { Augment } = require("..");

function tmpPath(prefix = "broker-install") {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function mockCodexPlatform(overrides = {}) {
  return {
    platform: "codex",
    configPath: tmpPath("codex-config") + ".toml",
    rulesPath: null,
    skillsPath: null,
    existingMcp: null,
    rootKey: "mcp_servers",
    configFormat: "toml",
    ...overrides,
  };
}

function cleanup(p) { try { fs.unlinkSync(p); } catch { /* ignore */ } }

const SHIM_BIN = "/opt/equip-app/bin/equip-broker-shim";

describe("Package 04 — Augment.installMcpBroker on Codex", () => {
  it("writes a broker-shim entry to the platform config", () => {
    const p = mockCodexPlatform();
    cleanup(p.configPath);

    const augment = new Augment({ name: "stub-augment", serverUrl: "https://example.com/mcp" });
    const result = augment.installMcpBroker(p, { shimBinaryPath: SHIM_BIN });

    assert.equal(result.success, true);
    assert.equal(result.errorCode, undefined);

    const entry = augment.readMcp(p);
    assert.ok(entry, "broker entry must be readable after install");
    assert.equal(entry.command, SHIM_BIN, "command must point at the injected shim binary");
    // TOML round-trips args as a string-formatted array literal; the
    // shape-of-args contract is enforced by the writer hook tests; here
    // we just verify the entry was written and has args.
    assert.ok(entry.args !== undefined, "entry must have args");

    cleanup(p.configPath);
  });

  it("broker entry contains no OAuth-shaped keys after round-trip", () => {
    const p = mockCodexPlatform();
    cleanup(p.configPath);

    const augment = new Augment({ name: "stub-augment", serverUrl: "https://example.com/mcp" });
    augment.installMcpBroker(p, { shimBinaryPath: SHIM_BIN });

    // Read the actual TOML text to verify no oauth-shaped keys leaked into
    // disk via any hidden code path.
    const tomlText = fs.readFileSync(p.configPath, "utf-8");
    assert.ok(!/bearer_token_env_var/i.test(tomlText), "no bearer_token_env_var in written TOML");
    assert.ok(!/oauth_resource/i.test(tomlText), "no oauth_resource in written TOML");
    assert.ok(!/^\s*scopes\s*=/m.test(tomlText), "no scopes key in written TOML");

    cleanup(p.configPath);
  });

  it("dry-run does not touch disk", () => {
    const p = mockCodexPlatform();
    cleanup(p.configPath);

    const augment = new Augment({ name: "stub-augment", serverUrl: "https://example.com/mcp" });
    const result = augment.installMcpBroker(p, { shimBinaryPath: SHIM_BIN, dryRun: true });

    assert.equal(result.success, true);
    assert.equal(fs.existsSync(p.configPath), false, "dry-run must not write the config file");

    cleanup(p.configPath);
  });

  it("forwards shimExtraArgs into the entry args", () => {
    const p = mockCodexPlatform();
    cleanup(p.configPath);

    const augment = new Augment({ name: "stub-augment", serverUrl: "https://example.com/mcp" });
    augment.installMcpBroker(p, {
      shimBinaryPath: SHIM_BIN,
      shimExtraArgs: ["--log-level", "debug"],
    });

    const tomlText = fs.readFileSync(p.configPath, "utf-8");
    assert.ok(tomlText.includes("--log-level"), "shimExtraArgs must appear in the args list");
    assert.ok(tomlText.includes("debug"), "shimExtraArgs values must appear");

    cleanup(p.configPath);
  });
});

describe("Package 04 — installMcpBroker fall-through behavior", () => {
  it("returns BROKER_NOT_SUPPORTED on a platform without broker capabilities", () => {
    // Pick a platform we know hasn't been opted into broker mode (gemini-cli
    // doesn't declare brokerCapabilities as of Pkg 04).
    const p = {
      platform: "gemini-cli",
      configPath: tmpPath("gemini-config") + ".json",
      rulesPath: null,
      skillsPath: null,
      existingMcp: null,
      rootKey: "mcpServers",
      configFormat: "json",
    };
    cleanup(p.configPath);

    const augment = new Augment({ name: "stub-augment", serverUrl: "https://example.com/mcp" });
    const result = augment.installMcpBroker(p, { shimBinaryPath: SHIM_BIN });

    assert.equal(result.success, false);
    assert.equal(result.errorCode, "BROKER_NOT_SUPPORTED");
    assert.equal(fs.existsSync(p.configPath), false, "no config must be written when broker is unsupported");

    cleanup(p.configPath);
  });
});

describe("Package 04 — additive guarantee: direct-mode unchanged", () => {
  it("installMcp on Codex still produces the legacy direct-mode entry", () => {
    const p = mockCodexPlatform();
    cleanup(p.configPath);

    const augment = new Augment({ name: "direct-augment", serverUrl: "https://example.com/mcp" });
    augment.installMcp(p, "key123");

    const entry = augment.readMcp(p);
    assert.ok(entry);
    // Direct-mode Codex install is HTTP shape with http_headers.
    assert.equal(entry.url, "https://example.com/mcp");
    assert.ok(entry.http_headers, "direct-mode must include http_headers");

    cleanup(p.configPath);
  });
});
