// Tests for CLI entry points (equip, unequip)
// Covers arg parsing, local path detection, and CLI invocation.

"use strict";

require("./_isolation");

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");
const { setupFullHome } = require("./_isolation");

const { parseArgs, isLocalPath } = require("../dist/lib/cli");

// ─── parseArgs ──────────────────────────────────────────────

describe("parseArgs", () => {
  it("returns defaults for empty argv", () => {
    const result = parseArgs([]);
    assert.deepStrictEqual(result._, []);
    assert.strictEqual(result.verbose, false);
    assert.strictEqual(result.dryRun, false);
    assert.strictEqual(result.apiKey, null);
    assert.deepStrictEqual(result.mcpInputs, {});
    assert.strictEqual(result.nonInteractive, false);
    assert.strictEqual(result.platform, null);
    assert.strictEqual(result.allowUnreviewed, false);
  });

  it("collects positional args in _", () => {
    const result = parseArgs(["prior", "extra"]);
    assert.deepStrictEqual(result._, ["prior", "extra"]);
  });

  it("parses --verbose", () => {
    const result = parseArgs(["--verbose", "prior"]);
    assert.strictEqual(result.verbose, true);
    assert.deepStrictEqual(result._, ["prior"]);
  });

  it("parses --dry-run", () => {
    const result = parseArgs(["--dry-run"]);
    assert.strictEqual(result.dryRun, true);
  });

  it("parses --allow-unreviewed", () => {
    const result = parseArgs(["--allow-unreviewed"]);
    assert.strictEqual(result.allowUnreviewed, true);
  });

  it("parses --non-interactive", () => {
    const result = parseArgs(["--non-interactive"]);
    assert.strictEqual(result.nonInteractive, true);
  });

  it("parses snapshot restore preview flags", () => {
    const result = parseArgs(["claude-code", "--delete-added", "--json"]);
    assert.strictEqual(result.deleteAdded, true);
    assert.strictEqual(result.preserveAdded, false);
    assert.strictEqual(result.json, true);
    assert.deepStrictEqual(result._, ["claude-code"]);
  });

  it("parses loadout apply idempotency flags", () => {
    const result = parseArgs(["loadout", "apply", "Daily", "--operation-id", "op_123", "--plan-hash", "abc", "--json"]);
    assert.strictEqual(result.operationId, "op_123");
    assert.strictEqual(result.planHash, "abc");
    assert.strictEqual(result.json, true);
    assert.deepStrictEqual(result._, ["loadout", "apply", "Daily"]);
  });

  it("parses --api-key with value", () => {
    const result = parseArgs(["--api-key", "sk-test-123"]);
    assert.strictEqual(result.apiKey, "sk-test-123");
    assert.deepStrictEqual(result._, []);
  });

  it("parses --platform with value", () => {
    const result = parseArgs(["--platform", "claude,cursor"]);
    assert.strictEqual(result.platform, "claude,cursor");
  });

  it("parses --api-key-file", () => {
    const tmpFile = path.join(os.tmpdir(), `equip-test-key-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "  sk-from-file-abc  \n");
    try {
      const result = parseArgs(["--api-key-file", tmpFile]);
      assert.strictEqual(result.apiKey, "sk-from-file-abc");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("parses repeatable MCP install inputs", () => {
    const tmpFile = path.join(os.tmpdir(), `equip-test-mcp-input-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "  secret-from-file  \n");
    try {
      const result = parseArgs([
        "--mcp-input", "PLAIN=value",
        "--mcp-input-file", `SECRET=${tmpFile}`,
      ]);
      assert.deepStrictEqual(result.mcpInputs, {
        PLAIN: "value",
        SECRET: "secret-from-file",
      });
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("handles mixed flags and positional args", () => {
    const result = parseArgs(["--verbose", "prior", "--dry-run", "--platform", "claude"]);
    assert.strictEqual(result.verbose, true);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.platform, "claude");
    assert.deepStrictEqual(result._, ["prior"]);
  });

  it("treats --api-key as positional when no value follows", () => {
    // --api-key at the end — guard `i + 1 < argv.length` fails, falls through to positional
    const result = parseArgs(["prior", "--api-key"]);
    assert.strictEqual(result.apiKey, null);
    assert.deepStrictEqual(result._, ["prior", "--api-key"]);
  });
});

// ─── isLocalPath ────────────────────────────────────────────

describe("isLocalPath", () => {
  it("detects ./ prefix", () => {
    assert.strictEqual(isLocalPath("./setup.js"), true);
  });

  it("detects ../ prefix", () => {
    assert.strictEqual(isLocalPath("../other/setup.js"), true);
  });

  it("detects / prefix", () => {
    assert.strictEqual(isLocalPath("/absolute/path/setup.js"), true);
  });

  it("detects .\\ prefix (Windows)", () => {
    assert.strictEqual(isLocalPath(".\\setup.js"), true);
  });

  it("detects ..\\ prefix (Windows)", () => {
    assert.strictEqual(isLocalPath("..\\other\\setup.js"), true);
  });

  it("detects bare dot (.)", () => {
    assert.strictEqual(isLocalPath("."), true);
  });

  it("detects .js suffix", () => {
    assert.strictEqual(isLocalPath("setup.js"), true);
  });

  it("rejects plain augment names", () => {
    assert.strictEqual(isLocalPath("prior"), false);
    assert.strictEqual(isLocalPath("my-augment"), false);
    assert.strictEqual(isLocalPath("@cg3/prior"), false);
  });

  it("rejects names without .js extension", () => {
    assert.strictEqual(isLocalPath("setup"), false);
    assert.strictEqual(isLocalPath("prior.ts"), false);
  });
});

// ─── CLI integration (spawned process) ─────────────────────

const equipBin = path.join(__dirname, "..", "bin", "equip.js");
const unequipBin = path.join(__dirname, "..", "bin", "unequip.js");

function makeCliEnv(overrides = {}) {
  return { ...process.env, NO_COLOR: "1", ...overrides };
}

function runCli(bin, args, envOverrides = {}) {
  try {
    return execFileSync(process.execPath, [bin, ...args], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: makeCliEnv(envOverrides),
    });
  } catch (e) {
    // Some commands write to stderr and exit 0, execFileSync only throws on non-zero
    return e.stdout || e.stderr || "";
  }
}

/** Run CLI and return stdout + stderr combined (equip writes most output to stderr). */
function runCliAll(bin, args, envOverrides = {}) {
  const { execSync } = require("child_process");
  try {
    // Redirect stderr to stdout so we capture everything
    const cmd = `"${process.execPath}" "${bin}" ${args.map(a => `"${a}"`).join(" ")} 2>&1`;
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: 10000,
      shell: true,
      env: makeCliEnv(envOverrides),
    });
  } catch (e) {
    return e.stdout || e.stderr || "";
  }
}

function runCliStrict(bin, args, envOverrides = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf-8",
    timeout: 10000,
    env: makeCliEnv(envOverrides),
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assert.equal(result.status, 0, output);
  return output;
}

describe("equip CLI", () => {
  it("--version prints version", () => {
    const output = runCli(equipBin, ["--version"]);
    assert.match(output, /^equip v\d+\.\d+\.\d+/);
  });

  it("-v prints version", () => {
    const output = runCli(equipBin, ["-v"]);
    assert.match(output, /^equip v\d+\.\d+\.\d+/);
  });

  it("--help prints usage", () => {
    const output = runCli(equipBin, ["--help"]);
    assert.match(output, /Usage: equip/);
    assert.match(output, /<augment>/);
    assert.match(output, /--verbose/);
    assert.match(output, /--api-key-file <path>/);
    assert.match(output, /--mcp-input KEY=VALUE/);
    assert.match(output, /--mcp-input-file KEY=path/);
    assert.match(output, /shell history\/process lists/);
    assert.match(output, /loadout/);
    assert.match(output, /Telemetry/);
  });

  it("-h prints usage", () => {
    const output = runCli(equipBin, ["-h"]);
    assert.match(output, /Usage: equip/);
  });

  it("status command runs without error", () => {
    const output = runCliAll(equipBin, ["status"]);
    assert.match(output, /Detected platforms|equip status/i);
  });

  it("doctor command runs without error", () => {
    const output = runCliAll(equipBin, ["doctor"]);
    assert.match(output, /doctor|config/i);
  });

  it("loadout list command runs without error", () => {
    const full = setupFullHome("cli-loadout");
    try {
      const output = runCliStrict(equipBin, ["loadout", "list"], {
        EQUIP_HOME: full.equipHome,
        HOME: full.home,
        USERPROFILE: full.home,
        APPDATA: path.join(full.home, "AppData", "Roaming"),
        CODEX_HOME: full.home,
      });
      assert.match(output, /equip loadout list|No saved loadouts/i);
    } finally {
      full.dispose();
    }
  });

  it("loadout preview command emits JSON", () => {
    const full = setupFullHome("cli-loadout-preview");
    const env = {
      EQUIP_HOME: full.equipHome,
      HOME: full.home,
      USERPROFILE: full.home,
      APPDATA: path.join(full.home, "AppData", "Roaming"),
      CODEX_HOME: full.home,
    };
    try {
      runCliStrict(equipBin, ["loadout", "save", "Empty"], env);
      const output = runCliStrict(equipBin, ["loadout", "preview", "Empty", "--json"], env);
      const plan = JSON.parse(output);
      assert.equal(plan.schemaVersion, 1);
      assert.equal(plan.loadout.name, "Empty");
      assert.equal(typeof plan.planHash, "string");
    } finally {
      full.dispose();
    }
  });

  it("loadout apply command emits JSON", () => {
    const full = setupFullHome("cli-loadout-apply");
    const env = {
      EQUIP_HOME: full.equipHome,
      HOME: full.home,
      USERPROFILE: full.home,
      APPDATA: path.join(full.home, "AppData", "Roaming"),
      CODEX_HOME: full.home,
    };
    try {
      runCliStrict(equipBin, ["loadout", "save", "Empty"], env);
      const output = runCliStrict(equipBin, ["loadout", "apply", "Empty", "--operation-id", "op_cli_apply", "--json"], env);
      const receipt = JSON.parse(output);
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.status, "success");
      assert.equal(receipt.loadout.name, "Empty");
    } finally {
      full.dispose();
    }
  });
});

describe("unequip CLI", () => {
  it("--version prints version", () => {
    const output = runCli(unequipBin, ["--version"]);
    assert.match(output, /^unequip v\d+\.\d+\.\d+/);
  });

  it("-v prints version", () => {
    const output = runCli(unequipBin, ["-v"]);
    assert.match(output, /^unequip v\d+\.\d+\.\d+/);
  });

  it("--help prints usage", () => {
    const output = runCli(unequipBin, ["--help"]);
    assert.match(output, /Usage: unequip/);
    assert.match(output, /<augment>/);
  });

  it("-h prints usage", () => {
    const output = runCli(unequipBin, ["-h"]);
    assert.match(output, /Usage: unequip/);
  });
});
