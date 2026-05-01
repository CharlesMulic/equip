"use strict";

// Tests for broker capability flags + accessors on
// PlatformDefinition. See ADR:
// The concrete per-platform cases below are the public contract.
//
// Coverage:
//   - getBrokerCapabilities returns safe defaults for unknown platforms
//   - getBrokerCapabilities returns safe defaults for known platforms
//     that haven't declared capabilities (additive guarantee)
//   - The three broker-target platforms (Codex, Claude Code, Cursor)
//     declare the flags their platform-specific behavior requires
//   - platformSupportsBroker is the canonical gate
//   - getBrokerStrategy returns undefined for platforms without overrides

const { describe, it } = require("node:test");
const assert = require("assert/strict");

const {
  getBrokerCapabilities,
  platformSupportsBroker,
  getBrokerStrategy,
  PLATFORM_REGISTRY,
} = require("../dist/lib/platforms");

describe("broker capability accessors", () => {
  it("returns all-false baseline for unknown platforms (no throw)", () => {
    const caps = getBrokerCapabilities("does-not-exist");
    assert.equal(caps.supportsBroker, false);
    assert.equal(caps.supportsStdioShim, false);
    assert.equal(caps.supportsLoopbackHttp, false);
    assert.equal(caps.oauthDiscoveryProbing, false);
    assert.equal(caps.mcpNeedsAuthRecovery, false);
  });

  it("returns all-false baseline for platforms without declared capabilities", () => {
    // Pick a platform we know hasn't been opted into broker mode yet
    // (additive guarantee: existing PlatformDefinition consumers keep working).
    const caps = getBrokerCapabilities("vscode");
    assert.equal(caps.supportsBroker, false, "vscode should default to broker-unsupported until explicitly opted in");
  });

  it("platformSupportsBroker is false for platforms without declarations", () => {
    assert.equal(platformSupportsBroker("vscode"), false);
    assert.equal(platformSupportsBroker("windsurf"), false);
    assert.equal(platformSupportsBroker("does-not-exist"), false);
  });

  it("getBrokerStrategy returns undefined for platforms without overrides", () => {
    // Platforms without brokerStrategy hooks fall back to baseline behavior.
    // Packages 04 (Codex) and 05 (Claude Code, Cursor). Verify the
    // accessor honors the absent-baseline contract.
    assert.equal(getBrokerStrategy("vscode"), undefined);
    assert.equal(getBrokerStrategy("does-not-exist"), undefined);
  });
});

describe("broker-target platforms", () => {
  // The three targets the broker MVP must demo against. Capability flags
  // must match the platform capability analysis so broker code
  // (Packages 02-05) makes correct decisions.

  it("Codex declares broker-target capabilities", () => {
    const caps = getBrokerCapabilities("codex");
    assert.equal(caps.supportsBroker, true);
    assert.equal(caps.supportsStdioShim, true, "stdio shim is the strongest path on Codex");
    assert.equal(caps.supportsLoopbackHttp, true);
    assert.equal(caps.oauthDiscoveryProbing, false, "Codex's OAuth login is opt-in, not auto-probed");
    assert.equal(caps.mcpNeedsAuthRecovery, false);
  });

  it("Claude Code declares broker-target capabilities including needs-auth recovery", () => {
    const caps = getBrokerCapabilities("claude-code");
    assert.equal(caps.supportsBroker, true);
    assert.equal(caps.supportsStdioShim, true);
    assert.equal(caps.supportsLoopbackHttp, true);
    assert.equal(caps.oauthDiscoveryProbing, false);
    assert.equal(
      caps.mcpNeedsAuthRecovery, true,
      "Claude Code's 15-min mcp-needs-auth-cache.json TTL is a real recovery hazard",
    );
  });

  it("Cursor declares broker-target capabilities including OAuth discovery probing", () => {
    const caps = getBrokerCapabilities("cursor");
    assert.equal(caps.supportsBroker, true);
    assert.equal(caps.supportsStdioShim, true, "mcp-remote is exact prior art on Cursor today");
    assert.equal(caps.supportsLoopbackHttp, true);
    assert.equal(
      caps.oauthDiscoveryProbing, true,
      "Cursor probes /.well-known/oauth-* and ignores headers when present — load-bearing flag",
    );
    assert.equal(caps.mcpNeedsAuthRecovery, false);
  });

  it("platformSupportsBroker matches supportsBroker for the broker-target platforms", () => {
    assert.equal(platformSupportsBroker("codex"), true);
    assert.equal(platformSupportsBroker("claude-code"), true);
    assert.equal(platformSupportsBroker("cursor"), true);
  });
});

describe("broker capability additive contract", () => {
  it("PLATFORM_REGISTRY entries without brokerCapabilities still resolve", () => {
    // Iterate every registry entry; getBrokerCapabilities must return a
    // fully-populated baseline regardless of whether the entry declares
    // brokerCapabilities. This is the test that breaks if anyone removes
    // the ?? false defaults from getBrokerCapabilities.
    for (const id of PLATFORM_REGISTRY.keys()) {
      const caps = getBrokerCapabilities(id);
      assert.equal(typeof caps.supportsBroker, "boolean", `${id}: supportsBroker must be boolean`);
      assert.equal(typeof caps.supportsStdioShim, "boolean", `${id}: supportsStdioShim must be boolean`);
      assert.equal(typeof caps.supportsLoopbackHttp, "boolean", `${id}: supportsLoopbackHttp must be boolean`);
      assert.equal(typeof caps.oauthDiscoveryProbing, "boolean", `${id}: oauthDiscoveryProbing must be boolean`);
      assert.equal(typeof caps.mcpNeedsAuthRecovery, "boolean", `${id}: mcpNeedsAuthRecovery must be boolean`);
    }
  });
});
