// Tests for CLI entry points (equip, unequip)
// Covers arg parsing, local path detection, and CLI invocation.

"use strict";

require("./_isolation");

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { execFileSync, spawn, spawnSync } = require("child_process");
const { setupFullHome } = require("./_isolation");

const { parseArgs, isLocalPath } = require("../dist/lib/cli");
const { parseTomlServerEntry } = require("../dist/lib/mcp");

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
    assert.strictEqual(result.acceptRisk, false);
    assert.deepStrictEqual(result.acceptedRiskReasons, []);
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

  it("parses --accept-risk with optional reason codes", () => {
    const bare = parseArgs(["--accept-risk"]);
    assert.strictEqual(bare.acceptRisk, true);
    assert.deepStrictEqual(bare.acceptedRiskReasons, []);

    const valued = parseArgs(["--accept-risk=review-missing,stdio-local-code"]);
    assert.strictEqual(valued.acceptRisk, true);
    assert.deepStrictEqual(valued.acceptedRiskReasons, ["review-missing", "stdio-local-code"]);

    const beforeAugment = parseArgs(["--accept-risk", "prior"]);
    assert.strictEqual(beforeAugment.acceptRisk, true);
    assert.deepStrictEqual(beforeAugment.acceptedRiskReasons, []);
    assert.deepStrictEqual(beforeAugment._, ["prior"]);
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

function runCliProcess(bin, args, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: makeCliEnv(envOverrides),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, 10000);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr, output: `${stdout}${stderr}` });
    });
  });
}

async function startRegistryServer(defsByName) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method || "GET", url: req.url || "/" });
    const parsed = new URL(req.url || "/", "http://127.0.0.1");
    const match = /^\/augments\/([^/]+)$/.exec(parsed.pathname);

    if (req.method === "GET" && match) {
      const name = decodeURIComponent(match[1]);
      const def = defsByName[name];
      if (def) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(def));
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address === "object", "registry server should listen on a TCP port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

function createFakeNpx(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "npx.cmd"), "@echo off\r\necho fake-npx %*\r\nexit /b 0\r\n");
    return;
  }

  const script = path.join(binDir, "npx");
  fs.writeFileSync(script, [
    "#!/bin/sh",
    "printf 'fake-npx'",
    "for arg in \"$@\"; do printf ' %s' \"$arg\"; done",
    "printf '\\n'",
    "exit 0",
    "",
  ].join("\n"));
  fs.chmodSync(script, 0o755);
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
    assert.match(output, /--accept-risk/);
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

  it("installs package-mode MCP installTargets through the config installer", async () => {
    const full = setupFullHome("cli-package-stdio-target");
    const augmentName = "package-stdio-config";
    const def = {
      name: augmentName,
      title: "Package Stdio Config",
      description: "Fixture package-mode stdio MCP definition.",
      installMode: "package",
      listed: true,
      status: "active",
      reviewStatus: "unsupported",
      syncSource: "mcp-registry",
      syncSourceName: "example/package-stdio-config",
      trustState: {
        equipGate: "warning-gated",
        reviewState: "unsupported",
        transportPath: "stdio-mcp",
        policyFingerprint: "cli-package-stdio-target-test",
        warningTextVersion: 1,
        warningReasons: [
          {
            code: "publisher-unclaimed",
            category: "identity",
            severity: "warning",
            message: "This content is unclaimed.",
            oneTimeAcceptable: true,
            preferenceSuppressible: true,
            suggestedPreferenceScopes: ["source", "augment", "path"],
            policyFingerprint: "cli-package-stdio-target-test",
          },
          {
            code: "review-unsupported",
            category: "review",
            severity: "warning",
            message: "Automated review does not currently support this path.",
            oneTimeAcceptable: true,
            preferenceSuppressible: true,
            suggestedPreferenceScopes: ["source", "augment", "path"],
            policyFingerprint: "cli-package-stdio-target-test",
          },
          {
            code: "stdio-local-code",
            category: "capability",
            severity: "danger",
            message: "This stdio server runs local code on your machine.",
            oneTimeAcceptable: true,
            preferenceSuppressible: false,
            suggestedPreferenceScopes: [],
            policyFingerprint: "cli-package-stdio-target-test",
          },
        ],
      },
      recommendedMcpPath: {
        pathKey: "stdio:fixture:package-stdio-config",
        supportLevel: "unsupported",
        evidenceTier: "unsupported-source-or-transport",
        label: "stdio fixture",
      },
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "fixture",
        runtimeHint: "node",
        runtimeArguments: [{ value: "-e" }, { value: "0" }],
        environmentVariables: [],
      }],
    };
    const registry = await startRegistryServer({ [augmentName]: def });
    const env = {
      EQUIP_HOME: full.equipHome,
      HOME: full.home,
      USERPROFILE: full.home,
      APPDATA: path.join(full.home, "AppData", "Roaming"),
      CODEX_HOME: full.home,
      EQUIP_REGISTRY_URL: registry.origin,
    };

    try {
      const blocked = await runCliProcess(equipBin, [augmentName, "--platform", "codex", "--non-interactive"], env);
      assert.equal(blocked.status, 1, blocked.output);
      assert.match(blocked.output, /requires explicit acknowledgement/i);
      assert.equal(fs.existsSync(path.join(full.home, "config.toml")), false, "warning gate should stop before writing Codex config");

      const accepted = await runCliProcess(equipBin, [augmentName, "--platform", "codex", "--non-interactive", "--accept-risk"], env);
      assert.equal(accepted.status, 0, accepted.output);
      const output = accepted.output;
      assert.match(output, /MCP Server/);
      assert.match(output, /Local runtime ready/);
      assert.match(output, /Transport\s+stdio/);
      assert.match(output, /stdio, toml/);
      assert.match(output, /Done\.[\s\S]*1 platform configured/);

      const codexConfigPath = path.join(full.home, "config.toml");
      const codexConfig = fs.readFileSync(codexConfigPath, "utf-8");
      const entry = parseTomlServerEntry(codexConfig, "mcp_servers", augmentName);
      assert.ok(entry, "Codex config should include the stdio MCP server");
      const entryArgs = typeof entry.args === "string" ? JSON.parse(entry.args) : entry.args;
      if (process.platform === "win32") {
        assert.equal(entry.command, "cmd");
        assert.deepEqual(entryArgs, ["/c", "node", "-e", "0"]);
      } else {
        assert.equal(entry.command, "node");
        assert.deepEqual(entryArgs, ["-e", "0"]);
      }
      assert.equal(entry.url, undefined);
      assert.equal(entry.http_headers, undefined);
    } finally {
      await registry.close();
      full.dispose();
    }
  });

  it("keeps configless package definitions on the legacy package setup path", async () => {
    const full = setupFullHome("cli-legacy-package-target");
    const augmentName = "legacy-package-configless";
    const fakeBin = path.join(full.home, "fake-bin");
    createFakeNpx(fakeBin);

    const registry = await startRegistryServer({
      [augmentName]: {
        name: augmentName,
        title: "Legacy Package Configless",
        description: "Fixture package-mode augment without MCP config targets.",
        installMode: "package",
        npmPackage: "equip-fake-package",
        setupCommand: "configure",
        listed: true,
        status: "active",
        trustState: {
          equipGate: "warning-gated",
          policyFingerprint: "cli-legacy-package-target-test",
          warningReasons: [{
            code: "publisher-unclaimed",
            category: "identity",
            severity: "warning",
            message: "This package is unclaimed.",
            oneTimeAcceptable: true,
            preferenceSuppressible: true,
            suggestedPreferenceScopes: ["source", "augment"],
            policyFingerprint: "cli-legacy-package-target-test",
          }],
        },
      },
    });
    const pathWithFakeNpx = `${fakeBin}${path.delimiter}${process.env.PATH || process.env.Path || ""}`;
    const env = {
      EQUIP_HOME: full.equipHome,
      HOME: full.home,
      USERPROFILE: full.home,
      APPDATA: path.join(full.home, "AppData", "Roaming"),
      CODEX_HOME: full.home,
      EQUIP_REGISTRY_URL: registry.origin,
      PATH: pathWithFakeNpx,
      Path: pathWithFakeNpx,
    };

    try {
      const result = await runCliProcess(equipBin, [augmentName, "--non-interactive", "--accept-risk"], env);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /requires explicit acknowledgement/i);
      assert.match(result.output, /fake-npx/);
      assert.match(result.output, /-y/);
      assert.match(result.output, /equip-fake-package@latest/);
      assert.match(result.output, /configure/);
      assert.doesNotMatch(result.output, /No supported AI coding tools/);
      assert.equal(fs.existsSync(path.join(full.home, "config.toml")), false, "legacy package setup should not write Codex config directly");
    } finally {
      await registry.close();
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
