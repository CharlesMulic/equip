import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  registryDefToMcpInstallTargets,
} from "../../dist/lib/mcp-readiness.js";
import {
  buildMcpConfigForInstallTarget,
} from "../../dist/lib/mcp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const casesPath = path.join(__dirname, "fixtures", "mcp-initialize-cases.json");
const fixture = JSON.parse(fs.readFileSync(casesPath, "utf-8"));
const MAX_CAPTURE_BYTES = 64 * 1024;

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: {
      name: "equip-mcp-initialize-smoke",
      version: "0.1.0",
    },
  },
};

function assertAllowlistedCase(item) {
  assert.equal(typeof item.id, "string", "allowlist item needs an id");
  assert.equal(typeof item.reviewedBy, "string", `${item.id} needs review attribution`);
  assert.equal(typeof item.reviewNote, "string", `${item.id} needs a review note`);
  assert.ok(item.reviewNote.length > 20, `${item.id} review note should explain why execution is safe`);
  assert.equal(typeof item.expectedCommand, "string", `${item.id} needs an expected command`);
  assert.ok(Array.isArray(item.expectedArgs), `${item.id} needs expected args`);

  const [rawTarget] = item.definition.installTargets;
  assert.ok(rawTarget, `${item.id} needs an install target`);
  assert.equal(rawTarget.targetKind, "stdio", `${item.id} must be stdio only`);
  assert.equal(rawTarget.transport?.type, "stdio", `${item.id} must use stdio transport`);
  assert.ok(["npm", "pypi"].includes(rawTarget.registryType), `${item.id} must be an npm or PyPI fixture`);
  assert.ok(["npx", "uvx"].includes(rawTarget.runtimeHint), `${item.id} must launch through npx or uvx`);
  assert.doesNotMatch(JSON.stringify(rawTarget), /\blatest\b/i, `${item.id} must not use latest`);
  assert.doesNotMatch(JSON.stringify(rawTarget), /docker\.sock|--privileged/i, `${item.id} must not request Docker host access`);
}

function targetForCase(item) {
  assertAllowlistedCase(item);
  const targets = registryDefToMcpInstallTargets(item.definition);
  assert.equal(targets.length, 1, `${item.id} should expose one target`);
  const target = targets[0];
  assert.equal(target.kind, "stdio", `${item.id} should parse as stdio`);
  assert.equal(target.command, item.expectedCommand, `${item.id} command drift`);
  assert.deepEqual(target.args, item.expectedArgs, `${item.id} args drift`);
  return target;
}

function entryForCase(item, target) {
  const result = buildMcpConfigForInstallTarget(target, "claude-code", {
    inputs: item.installInputs || {},
  });
  assert.equal(result.success, true, `${item.id} should produce a platform config: ${result.error || ""}`);
  assert.equal(result.entry.command, item.expectedCommand, `${item.id} config command drift`);
  assert.deepEqual(result.entry.args, item.expectedArgs, `${item.id} config args drift`);
  return result.entry;
}

function minimalProbeEnv(root, item) {
  return {
    PATH: process.env.PATH,
    HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"),
    npm_config_cache: path.join(root, "npm-cache"),
    NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
    UV_CACHE_DIR: path.join(root, "uv-cache"),
    UV_NO_PROGRESS: "1",
    UV_PYTHON: "python3",
    PYTHONDONTWRITEBYTECODE: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...(item.installInputs || {}),
  };
}

function makeRedactor({ root, secrets = [] }) {
  const pathReplacements = [
    [repoRoot, "[workspace]"],
    [root, "[temp]"],
    [os.tmpdir(), "[tmp]"],
  ].filter(([value]) => value);

  return (value) => {
    let out = String(value || "");
    for (const secret of secrets.filter(Boolean)) {
      out = out.replaceAll(secret, "[redacted]");
    }
    out = out
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/(token|api[_-]?key|secret|password)(\s*[=:]\s*)\S+/gi, "$1$2[redacted]");
    for (const [needle, replacement] of pathReplacements) {
      out = out.replaceAll(needle, replacement);
      out = out.replaceAll(needle.replaceAll("\\", "/"), replacement);
    }
    return out.slice(0, 4000);
  };
}

function killProcessGroup(child) {
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
    } else if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

function probeStdioInitialize({ command, args, env, timeoutMs, redactor }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let captureTruncated = false;
    let settled = false;

    const appendBounded = (current, chunk) => {
      if (current.length >= MAX_CAPTURE_BYTES) {
        captureTruncated = true;
        return current;
      }
      const next = current + String(chunk);
      if (next.length <= MAX_CAPTURE_BYTES) return next;
      captureTruncated = true;
      return next.slice(0, MAX_CAPTURE_BYTES);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessGroup(child);
      resolve({
        ...result,
        stdout: redactor(stdout),
        stderr: redactor(stderr),
        captureTruncated,
      });
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        timedOut: true,
        error: `MCP initialize timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout = appendBounded(stdout, text);
      stdoutBuffer += text;
      if (stdoutBuffer.length > MAX_CAPTURE_BYTES) {
        stdoutBuffer = stdoutBuffer.slice(-MAX_CAPTURE_BYTES);
        captureTruncated = true;
      }
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const rawLine = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!rawLine) continue;
        let message;
        try {
          message = JSON.parse(rawLine);
        } catch {
          continue;
        }
        if (message.id === INITIALIZE_REQUEST.id && message.result) {
          finish({
            ok: true,
            timedOut: false,
            response: message,
          });
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.on("error", (error) => {
      finish({
        ok: false,
        timedOut: false,
        error: error.message,
      });
    });

    child.on("close", (code) => {
      finish({
        ok: false,
        timedOut: false,
        exitCode: code,
        error: `Process exited before MCP initialize response with code ${code}`,
      });
    });

    child.stdin.write(`${JSON.stringify(INITIALIZE_REQUEST)}\n`);
  });
}

test("allowlisted registry-shaped stdio fixtures complete MCP initialize in Docker", async (t) => {
  assert.equal(fixture.schemaVersion, 1);
  assert.ok(fixture.cases.some((item) => item.definition.installTargets?.[0]?.registryType === "npm"), "smoke should include an npm fixture");
  assert.ok(fixture.cases.some((item) => item.definition.installTargets?.[0]?.registryType === "pypi"), "smoke should include a PyPI fixture");

  const summary = [];
  const tempRoots = [];
  t.after(() => {
    for (const root of tempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const item of fixture.cases) {
    const target = targetForCase(item);
    const entry = entryForCase(item, target);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `equip-mcp-init-${item.id}-`));
    tempRoots.push(root);
    for (const child of ["home", "tmp", "npm-cache", "uv-cache"]) {
      fs.mkdirSync(path.join(root, child), { recursive: true });
    }

    const redactor = makeRedactor({
      root,
      secrets: Object.values(item.installInputs || {}),
    });
    const result = await probeStdioInitialize({
      command: String(entry.command),
      args: entry.args.map(String),
      env: minimalProbeEnv(root, item),
      timeoutMs: 15_000,
      redactor,
    });

    summary.push({
      id: item.id,
      registryType: target.packageRegistry,
      packageName: target.packageName,
      command: entry.command,
      args: entry.args,
      ok: result.ok,
      timedOut: result.timedOut,
      error: result.error,
      stdout: result.stdout,
      stderr: result.stderr,
      serverInfo: result.response?.result?.serverInfo,
    });

    assert.equal(result.ok, true, `${item.id} failed:\n${JSON.stringify(summary.at(-1), null, 2)}`);
    assert.equal(result.response.result.serverInfo.name, item.expectedServerName, `${item.id} server name`);
    assert.equal(result.response.result.serverInfo.version, item.expectedServerVersion, `${item.id} server version`);
    assert.doesNotMatch(result.stderr, /fixture-secret-token-123/, `${item.id} stderr should be redacted`);
    assert.doesNotMatch(result.stderr, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${item.id} temp path should be redacted`);
  }

  const encoded = JSON.stringify(summary, null, 2);
  assert.doesNotMatch(encoded, /fixture-secret-token-123/, "summary must not contain fake secrets");
  assert.doesNotMatch(encoded, /equip-mcp-init-[^"]+/, "summary must not contain temp path fragments");

  if (process.env.EQUIP_MCP_INITIALIZE_SMOKE_RESULTS) {
    fs.mkdirSync(path.dirname(process.env.EQUIP_MCP_INITIALIZE_SMOKE_RESULTS), { recursive: true });
    fs.writeFileSync(process.env.EQUIP_MCP_INITIALIZE_SMOKE_RESULTS, `${encoded}\n`);
  }

  console.log(encoded);
});

test("MCP initialize smoke reports timeout diagnostics and kills the process group", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-mcp-init-timeout-"));
  try {
    fs.mkdirSync(path.join(root, "home"), { recursive: true });
    const redactor = makeRedactor({ root });
    const result = await probeStdioInitialize({
      command: process.execPath,
      args: [path.join(__dirname, "fixtures", "mcp-initialize", "hanging-server.mjs")],
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      timeoutMs: 250,
      redactor,
    });

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(result.error, /timed out/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
