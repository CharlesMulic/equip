"use strict";

// Tests for Package 04 — Codex's writeBrokerConfig strategy hook.
//
// The hook produces a [mcp_servers.<name>] TOML entry that points at
// equip-broker-shim. Bypass discipline (per spike Codex section):
//   - command + args ONLY
//   - NEVER bearer_token_env_var, scopes, oauth_resource (would trigger
//     `codex mcp login` or OAuth discovery)
//
// These tests pin the hook output shape so a future edit to platforms.ts
// can't accidentally drift the bypass contract.

const { describe, it } = require("node:test");
const assert = require("assert/strict");

const { getBrokerStrategy } = require("../dist/lib/platforms");

function callHook(opts) {
  const strat = getBrokerStrategy("codex");
  assert.ok(strat, "Codex must declare a brokerStrategy by Package 04");
  assert.ok(typeof strat.writeBrokerConfig === "function", "writeBrokerConfig must be defined");
  return strat.writeBrokerConfig(opts.augmentName, {
    augmentName: opts.augmentName,
    shimBinaryPath: opts.shimBinaryPath ?? "/opt/equip-app/bin/equip-broker-shim",
    shimExtraArgs: opts.shimExtraArgs,
    loopbackUrl: opts.loopbackUrl,
  });
}

describe("Package 04 — Codex writeBrokerConfig: shape", () => {
  it("returns a stdio-transport result", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(result.transport, "stdio");
  });

  it("entry.command points at the injected shim binary path", () => {
    const result = callHook({
      augmentName: "notion-mcp",
      shimBinaryPath: "/Users/test/Library/equip-app/bin/equip-broker-shim",
    });
    assert.equal(result.entry.command, "/Users/test/Library/equip-app/bin/equip-broker-shim");
  });

  it("entry.args includes --augment <name>", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.ok(Array.isArray(result.entry.args), "args must be an array");
    const args = result.entry.args;
    const idx = args.indexOf("--augment");
    assert.ok(idx >= 0, "args must contain --augment");
    assert.equal(args[idx + 1], "notion-mcp");
  });

  it("forwards shimExtraArgs after --shim --augment <name>", () => {
    const result = callHook({
      augmentName: "notion-mcp",
      shimExtraArgs: ["--log-level", "debug"],
    });
    const args = result.entry.args;
    assert.deepEqual(args, ["--shim", "--augment", "notion-mcp", "--log-level", "debug"]);
  });

  it("entry.args[0] is --shim (single-binary subcommand dispatch)", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(result.entry.args[0], "--shim",
      "broker-production-wiring Pkg 01: --shim selects shim mode in equip-sidecar dispatcher");
  });

  it("returns a human-readable note for `equip doctor` output", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(typeof result.note, "string");
    assert.ok(result.note.length > 0);
  });
});

describe("Package 04 — Codex writeBrokerConfig: OAuth-bypass contract", () => {
  // These are the load-bearing absences. If any of them appear in entry,
  // Codex will spawn `codex mcp login` or hit OAuth discovery on the
  // upstream — both defeat the broker.

  it("entry MUST NOT include bearer_token_env_var", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(
      result.entry.bearer_token_env_var,
      undefined,
      "presence of bearer_token_env_var would cause Codex to run `codex mcp login`",
    );
  });

  it("entry MUST NOT include scopes", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(
      result.entry.scopes,
      undefined,
      "presence of scopes would trigger OAuth discovery on the upstream",
    );
  });

  it("entry MUST NOT include oauth_resource", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    assert.equal(
      result.entry.oauth_resource,
      undefined,
      "presence of oauth_resource would trigger OAuth metadata fetch",
    );
  });

  it("entry MUST NOT include any other OAuth-shaped key", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    const oauthShaped = ["auth", "oauth", "auth_type", "authType", "tokens"];
    for (const k of oauthShaped) {
      assert.equal(
        result.entry[k],
        undefined,
        `entry.${k} present — would cause Codex to attempt OAuth instead of broker-mediated stdio`,
      );
    }
  });

  it("entry has only command + args (canonical broker-mode shape)", () => {
    const result = callHook({ augmentName: "notion-mcp" });
    const keys = Object.keys(result.entry).sort();
    assert.deepEqual(keys, ["args", "command"], "entry must be exactly { command, args }");
  });
});

describe("Package 04 — Codex writeBrokerConfig: round-trip via TOML builder", () => {
  // Pin that the hook output composes cleanly with mcp.ts buildTomlEntry —
  // the entry will be merged into a real Codex config.toml at install time.

  const { buildTomlEntry, parseTomlServerEntry } = require("../dist/lib/mcp");

  it("entry round-trips through buildTomlEntry + parseTomlServerEntry", () => {
    const result = callHook({ augmentName: "stub-augment" });
    const tomlText = buildTomlEntry("mcp_servers", "stub-augment", result.entry);
    const reparsed = parseTomlServerEntry(tomlText, "mcp_servers", "stub-augment");
    assert.ok(reparsed, "TOML must round-trip back to a parseable entry");
    assert.equal(reparsed.command, result.entry.command);
    // args is an array of strings; parser preserves them as a string-formatted array
    assert.ok(typeof reparsed.args === "string" || Array.isArray(reparsed.args));
  });

  it("emitted TOML contains no oauth-shaped keys", () => {
    const result = callHook({ augmentName: "stub-augment" });
    const tomlText = buildTomlEntry("mcp_servers", "stub-augment", result.entry);
    assert.ok(!/bearer_token_env_var/i.test(tomlText), "TOML must not contain bearer_token_env_var");
    assert.ok(!/oauth_resource/i.test(tomlText), "TOML must not contain oauth_resource");
    assert.ok(!/^scopes\s*=/m.test(tomlText), "TOML must not contain a scopes key");
  });
});
