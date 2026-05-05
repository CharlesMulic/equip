"use strict";

// Tests for Claude Code's writeBrokerConfig strategy hook.
//
// The hook produces a `mcpServers["<name>"]` JSON entry pointing at
// equip-broker-fd-bridge. Bypass discipline:
//   - command + args ONLY
//   - NEVER include `auth` (would trigger /mcp authenticate)
//   - NEVER include `url` or `headers` (broker is stdio-only)

const { describe, it } = require("node:test");
const assert = require("assert/strict");

const { getBrokerStrategy } = require("../dist/lib/platforms");

function callHook(opts) {
  const strat = getBrokerStrategy("claude-code");
  assert.ok(strat, "Claude Code must declare a brokerStrategy");
  assert.ok(typeof strat.writeBrokerConfig === "function");
  return strat.writeBrokerConfig(opts.augmentName, {
    augmentName: opts.augmentName,
    bridgeBinaryPath: opts.bridgeBinaryPath ?? "/opt/equip/bin/equip-broker-fd-bridge",
    bridgeExtraArgs: opts.bridgeExtraArgs,
    loopbackUrl: opts.loopbackUrl,
  });
}

describe("Claude Code writeBrokerConfig: shape", () => {
  it("returns a stdio-transport result", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(result.transport, "stdio");
  });

  it("entry.command points at the injected shim binary path", () => {
    const result = callHook({
      augmentName: "notion-mcp",
      bridgeBinaryPath: "/Users/test/Library/equip/bin/equip-broker-fd-bridge",
    });
    assert.equal(result.entry.command, "/Users/test/Library/equip/bin/equip-broker-fd-bridge");
  });

  it("entry.args includes --augment <name>", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.ok(Array.isArray(result.entry.args));
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

  it("returns a human-readable note", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(typeof result.note, "string");
    assert.ok(result.note.length > 0);
  });
});

describe("Claude Code writeBrokerConfig: OAuth-bypass contract", () => {
  // The auth field is the load-bearing absence here — its presence on
  // a managed entry causes Claude Code to launch /mcp authenticate.

  it("entry MUST NOT include `auth`", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(
      result.entry.auth,
      undefined,
      "presence of `auth` would cause Claude Code to launch /mcp authenticate",
    );
  });

  it("entry MUST NOT include `url` (broker is stdio-only)", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(result.entry.url, undefined);
  });

  it("entry MUST NOT include `headers`", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(result.entry.headers, undefined);
  });

  it("entry MUST NOT include `type` (broker entries are not http-typed)", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(result.entry.type, undefined);
  });

  it("entry has only command + args (canonical broker-mode shape)", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.deepEqual(Object.keys(result.entry).sort(), ["args", "command"]);
  });
});

describe("Claude Code writeBrokerConfig: augment-name allowlist", () => {
  // Argv-injection defense. The writer hook must refuse to embed an
  // unsafe name in bridge argv. Mirrored at the bridge's argv parser too.

  const REJECT_CASES = [
    ["leading-dash",       "--evil"],
    ["uppercase",          "Notion"],
    ["space",              "no tion"],
    ["newline",            "notion\nrm"],
    ["double-quote",       'notion"'],
    ["semicolon",          "notion;rm"],
    ["empty",              ""],
    ["single-char",        "a"],
    ["over-64-chars",      "a".repeat(65)],
    ["dot-in-name",        "notion.mcp"],
    ["slash-path-traversal", "notion/../evil"],
  ];

  for (const [label, name] of REJECT_CASES) {
    it(`rejects ${label} (${JSON.stringify(name)})`, () => {
      assert.throws(() => callHook({ augmentName: name }), /not safe for broker bridge argv/);
    });
  }

  const ACCEPT_CASES = [
    "notion-mcp",
    "prior",
    "publisher_internal-tool",
    "x42",
    "a".repeat(64),
  ];

  for (const name of ACCEPT_CASES) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      const result = callHook({ augmentName: name });
      assert.equal(result.entry.args[result.entry.args.indexOf("--augment") + 1], name);
    });
  }
});
