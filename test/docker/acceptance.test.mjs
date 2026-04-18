import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const fixturePath = path.join(__dirname, "fixtures", "demo-direct-install.json");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeFixture(serverUrl) {
  const raw = fs.readFileSync(fixturePath, "utf-8");
  return JSON.parse(raw.replaceAll("__SERVER_URL__", serverUrl));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
    server.on("error", reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => {
      stdout += chunk;
    });

    child.stderr.on("data", chunk => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", code => {
      resolve({
        code,
        stdout,
        stderr,
        output: `${stdout}${stderr}`,
      });
    });
  });
}

test("direct-mode registry install is hermetic in Docker for Claude Code and Codex", async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "equip-docker-acceptance-"));
  const homeDir = path.join(workspaceRoot, "home");
  const codexHome = path.join(homeDir, ".codex");

  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".agents"), { recursive: true });

  const requests = [];
  let serverUrl = "";

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method || "GET", url: req.url || "/" });

    if (req.method === "GET" && req.url === "/augments/demo-direct-install") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(makeFixture(serverUrl)));
      return;
    }

    if (req.method === "POST" && req.url === "/telemetry") {
      req.resume();
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const address = await listen(server);
  serverUrl = `http://127.0.0.1:${address.port}/mcp`;

  t.after(async () => {
    await closeServer(server);
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    HOME: homeDir,
    CODEX_HOME: codexHome,
    EQUIP_REGISTRY_URL: `http://127.0.0.1:${address.port}`,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };

  const install = await runCli([
    "bin/equip.js",
    "demo-direct-install",
    "--platform",
    "claude-code,codex",
    "--non-interactive",
  ], env);

  assert.equal(install.code, 0, install.output);
  assert.match(install.output, /Done\./);
  assert.match(install.output, /2 platforms configured/);
  assert.ok(
    requests.some(request => request.method === "GET" && request.url === "/augments/demo-direct-install"),
    "fixture registry should receive the augment definition request",
  );

  const claudeConfigPath = path.join(homeDir, ".claude.json");
  const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
  assert.equal(claudeConfig.mcpServers["demo-direct-install"].url, serverUrl);
  assert.equal(claudeConfig.mcpServers["demo-direct-install"].type, "http");

  const codexConfigPath = path.join(codexHome, "config.toml");
  const codexConfig = fs.readFileSync(codexConfigPath, "utf-8");
  assert.match(codexConfig, /\[mcp_servers\.demo-direct-install\]/);
  assert.match(codexConfig, new RegExp(`url = "${escapeRegExp(serverUrl)}"`));

  const claudeRules = fs.readFileSync(path.join(homeDir, ".claude", "CLAUDE.md"), "utf-8");
  assert.match(claudeRules, /<!-- demo-direct-install:v1\.0\.0 -->/);
  assert.match(claudeRules, /deterministic demo fixture data/);

  const codexRules = fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf-8");
  assert.match(codexRules, /<!-- demo-direct-install:v1\.0\.0 -->/);
  assert.match(codexRules, /deterministic demo fixture data/);

  const claudeSkillDir = path.join(homeDir, ".claude", "skills", "demo-direct-install", "registry-helper");
  assert.equal(
    fs.readFileSync(path.join(claudeSkillDir, "SKILL.md"), "utf-8"),
    "# Registry Helper\n\nUse this skill to inspect hermetic registry fixture responses during Docker acceptance tests.",
  );
  assert.equal(
    fs.readFileSync(path.join(claudeSkillDir, "examples", "usage.md"), "utf-8"),
    "Run `equip demo-direct-install --platform claude-code,codex --non-interactive` to exercise this fixture.",
  );

  const codexSkillDir = path.join(homeDir, ".agents", "skills", "demo-direct-install", "registry-helper");
  assert.equal(
    fs.readFileSync(path.join(codexSkillDir, "SKILL.md"), "utf-8"),
    "# Registry Helper\n\nUse this skill to inspect hermetic registry fixture responses during Docker acceptance tests.",
  );

  const installations = JSON.parse(fs.readFileSync(path.join(homeDir, ".equip", "installations.json"), "utf-8"));
  const installation = installations.augments["demo-direct-install"];
  assert.ok(installation, "installations.json should record the installed augment");
  assert.deepEqual([...installation.platforms].sort(), ["claude-code", "codex"]);
  assert.equal(installation.serverUrl, serverUrl);
  assert.deepEqual(installation.artifacts["claude-code"].skills, ["registry-helper"]);
  assert.deepEqual(installation.artifacts.codex.skills, ["registry-helper"]);
  assert.equal(installation.artifacts["claude-code"].rules, "1.0.0");
  assert.equal(installation.artifacts.codex.rules, "1.0.0");

  const platformsMeta = JSON.parse(fs.readFileSync(path.join(homeDir, ".equip", "platforms.json"), "utf-8"));
  assert.equal(platformsMeta.platforms["claude-code"].detected, true);
  assert.equal(platformsMeta.platforms.codex.detected, true);

  const claudeScan = JSON.parse(fs.readFileSync(path.join(homeDir, ".equip", "platforms", "claude-code.json"), "utf-8"));
  assert.equal(claudeScan.augments["demo-direct-install"].managed, true);
  assert.equal(claudeScan.augments["demo-direct-install"].artifacts.rules, "1.0.0");

  const status = await runCli(["bin/equip.js", "status"], env);
  assert.equal(status.code, 0, status.output);
  assert.match(status.output, /demo-direct-install/);
  assert.match(status.output, /Claude Code/);
  assert.match(status.output, /Codex/);

  const doctor = await runCli(["bin/equip.js", "doctor"], env);
  assert.equal(doctor.code, 0, doctor.output);
  assert.match(doctor.output, /claude|codex/i);
});
