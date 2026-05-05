"use strict";

// Tests for Cursor's writeBrokerConfig strategy hook.
//
// The hook produces a `mcpServers["<name>"]` JSON entry pointing at
// equip-broker-fd-bridge. Bypass discipline:
//   - command + args ONLY
//   - NEVER include `url` (Cursor probes /.well-known/oauth-* on URL entries)
//   - NEVER include `headers.Authorization` (would trigger OAuth)

const { describe, it } = require("node:test");
const assert = require("assert/strict");

const { getBrokerStrategy } = require("../dist/lib/platforms");

function callHook(opts) {
  const strat = getBrokerStrategy("cursor");
  assert.ok(strat, "Cursor must declare a brokerStrategy");
  assert.ok(typeof strat.writeBrokerConfig === "function");
  return strat.writeBrokerConfig(opts.augmentName, {
    augmentName: opts.augmentName,
    bridgeBinaryPath: opts.bridgeBinaryPath ?? "/opt/equip/bin/equip-broker-fd-bridge",
    bridgeExtraArgs: opts.bridgeExtraArgs,
    loopbackUrl: opts.loopbackUrl,
  });
}

describe("Cursor writeBrokerConfig: shape", () => {
  it("returns a stdio-transport result", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(result.transport, "stdio");
  });

  it("entry.command points at the injected shim binary path", () => {
    const result = callHook({
      augmentName: "notion-mcp",
      bridgeBinaryPath: "/Users/test/.cursor-app/bin/equip-broker-fd-bridge",
    });
    assert.equal(result.entry.command, "/Users/test/.cursor-app/bin/equip-broker-fd-bridge");
  });

  it("entry.args includes --augment <name>", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    const idx = result.entry.args.indexOf("--augment");
    assert.ok(idx >= 0);
    assert.equal(result.entry.args[idx + 1], "notion-mcp");
  });

  it("forwards bridgeExtraArgs after --augment <name>", () => {
    const result = callHook({
      augmentName: "notion-mcp",
      bridgeExtraArgs: ["--log-level", "debug"],
    });
    assert.deepEqual(result.entry.args, ["--augment", "notion-mcp", "--log-level", "debug"]);
  });

  it("entry.args[0] is --augment (native bridge dispatch)", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(result.entry.args[0], "--augment",
      "--augment selects the broker-managed augment for the native fd bridge");
  });
});

describe("Cursor writeBrokerConfig: OAuth-bypass contract", () => {
  // url is the load-bearing absence here — Cursor probes
  // /.well-known/oauth-authorization-server on URL entries.

  it("entry MUST NOT include `url`", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(
      result.entry.url,
      undefined,
      "presence of `url` would cause Cursor to probe /.well-known/oauth-* and hijack the entry into OAuth",
    );
  });

  it("entry MUST NOT include `headers`", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(
      result.entry.headers,
      undefined,
      "Cursor's URL probe would still trigger OAuth even with headers; broker entries are stdio-only",
    );
  });

  it("entry MUST NOT include `auth` or `oauth_resource`", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(result.entry.auth, undefined);
    assert.equal(result.entry.oauth_resource, undefined);
  });

  it("entry has only command + args (canonical broker-mode shape)", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.deepEqual(Object.keys(result.entry).sort(), ["args", "command"]);
  });
});
