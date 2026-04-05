// Tests for CLI entry points (equip, unequip)
// Covers arg parsing, local path detection, and CLI invocation.

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const { parseArgs, isLocalPath } = require("../dist/lib/cli");

// ─── parseArgs ──────────────────────────────────────────────

describe("parseArgs", () => {
  it("returns defaults for empty argv", () => {
    const result = parseArgs([]);
    assert.deepStrictEqual(result._, []);
    assert.strictEqual(result.verbose, false);
    assert.strictEqual(result.dryRun, false);
    assert.strictEqual(result.apiKey, null);
    assert.strictEqual(result.nonInteractive, false);
    assert.strictEqual(result.platform, null);
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

  it("parses --non-interactive", () => {
    const result = parseArgs(["--non-interactive"]);
    assert.strictEqual(result.nonInteractive, true);
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

function runCli(bin, args) {
  try {
    return execFileSync(process.execPath, [bin, ...args], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (e) {
    // Some commands write to stderr and exit 0, execFileSync only throws on non-zero
    return e.stdout || e.stderr || "";
  }
}

/** Run CLI and return stdout + stderr combined (equip writes most output to stderr). */
function runCliAll(bin, args) {
  const { execSync } = require("child_process");
  try {
    // Redirect stderr to stdout so we capture everything
    const cmd = `"${process.execPath}" "${bin}" ${args.map(a => `"${a}"`).join(" ")} 2>&1`;
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: 10000,
      shell: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (e) {
    return e.stdout || e.stderr || "";
  }
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
