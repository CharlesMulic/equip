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

function makeAuthFixture(serverUrl, registryOrigin) {
  const base = makeFixture(serverUrl);
  return {
    ...base,
    name: "demo-direct-install-auth",
    title: "Demo Direct Install Auth",
    description: "Hermetic Docker acceptance fixture for authenticated direct-mode installs",
    rules: {
      ...base.rules,
      marker: "demo-direct-install-auth",
    },
    auth: {
      type: "api_key",
      keyEnvVar: "DEMO_DIRECT_INSTALL_AUTH_KEY",
      validationUrl: `${registryOrigin}/validate`,
    },
  };
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
  const claudeConfigPath = path.join(homeDir, ".claude.json");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const claudeRulesPath = path.join(homeDir, ".claude", "CLAUDE.md");
  const codexRulesPath = path.join(codexHome, "AGENTS.md");
  const claudeBaselineRules = "# Existing Claude Rules\n\nKeep this Claude baseline.\n";
  const codexBaselineRules = "# Existing Codex Rules\n\nKeep this Codex baseline.\n";
  const claudeExistingServerUrl = "http://127.0.0.1:65535/existing-claude";
  const codexExistingServerUrl = "http://127.0.0.1:65535/existing-codex";

  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".agents"), { recursive: true });
  fs.writeFileSync(
    claudeConfigPath,
    JSON.stringify({
      theme: "baseline-theme",
      mcpServers: {
        "existing-tool": {
          url: claudeExistingServerUrl,
          type: "http",
        },
      },
    }, null, 2) + "\n",
    "utf-8",
  );
  fs.writeFileSync(
    codexConfigPath,
    [
      "[mcp_servers.existing-tool]",
      `url = "${codexExistingServerUrl}"`,
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(claudeRulesPath, claudeBaselineRules, "utf-8");
  fs.writeFileSync(codexRulesPath, codexBaselineRules, "utf-8");

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
    if (server.listening) {
      await closeServer(server);
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const homeRoot = path.parse(homeDir).root;
  const windowsHomePath = process.platform === "win32"
    ? homeDir.slice(homeRoot.length - 1)
    : undefined;

  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    HOMEDRIVE: process.platform === "win32" ? homeRoot.replace(/[\\\/]+$/, "") : process.env.HOMEDRIVE,
    HOMEPATH: windowsHomePath ?? process.env.HOMEPATH,
    APPDATA: path.join(homeDir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
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

  const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
  assert.equal(claudeConfig.mcpServers["demo-direct-install"].url, serverUrl);
  assert.equal(claudeConfig.mcpServers["demo-direct-install"].type, "http");
  assert.equal(claudeConfig.mcpServers["existing-tool"].url, claudeExistingServerUrl);
  assert.equal(claudeConfig.theme, "baseline-theme");

  const codexConfig = fs.readFileSync(codexConfigPath, "utf-8");
  assert.match(codexConfig, /\[mcp_servers\.demo-direct-install\]/);
  assert.match(codexConfig, new RegExp(`url = "${escapeRegExp(serverUrl)}"`));
  assert.match(codexConfig, /\[mcp_servers\.existing-tool\]/);
  assert.match(codexConfig, new RegExp(`url = "${escapeRegExp(codexExistingServerUrl)}"`));

  const claudeRules = fs.readFileSync(claudeRulesPath, "utf-8");
  assert.match(claudeRules, /<!-- demo-direct-install:v1\.0\.0 -->/);
  assert.match(claudeRules, /deterministic demo fixture data/);
  assert.match(claudeRules, /Keep this Claude baseline/);

  const codexRules = fs.readFileSync(codexRulesPath, "utf-8");
  assert.match(codexRules, /<!-- demo-direct-install:v1\.0\.0 -->/);
  assert.match(codexRules, /deterministic demo fixture data/);
  assert.match(codexRules, /Keep this Codex baseline/);

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
  assert.ok(fs.existsSync(path.join(homeDir, ".equip", "snapshots", "claude-code", ".initial-taken")));
  assert.ok(fs.existsSync(path.join(homeDir, ".equip", "snapshots", "codex", ".initial-taken")));

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

  const uninstall = await runCli(["bin/unequip.js", "demo-direct-install"], env);
  assert.equal(uninstall.code, 0, uninstall.output);
  assert.match(uninstall.output, /demo-direct-install removed from 2 platforms/i);

  const claudeConfigAfterUninstall = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
  assert.ok(!claudeConfigAfterUninstall.mcpServers["demo-direct-install"]);
  assert.equal(claudeConfigAfterUninstall.mcpServers["existing-tool"].url, claudeExistingServerUrl);
  assert.equal(claudeConfigAfterUninstall.theme, "baseline-theme");

  const codexConfigAfterUninstall = fs.readFileSync(codexConfigPath, "utf-8");
  assert.doesNotMatch(codexConfigAfterUninstall, /\[mcp_servers\.demo-direct-install\]/);
  assert.match(codexConfigAfterUninstall, /\[mcp_servers\.existing-tool\]/);
  assert.match(codexConfigAfterUninstall, new RegExp(`url = "${escapeRegExp(codexExistingServerUrl)}"`));

  const claudeRulesAfterUninstall = fs.readFileSync(claudeRulesPath, "utf-8");
  assert.doesNotMatch(claudeRulesAfterUninstall, /demo-direct-install/);
  assert.match(claudeRulesAfterUninstall, /Keep this Claude baseline/);

  const codexRulesAfterUninstall = fs.readFileSync(codexRulesPath, "utf-8");
  assert.doesNotMatch(codexRulesAfterUninstall, /demo-direct-install/);
  assert.match(codexRulesAfterUninstall, /Keep this Codex baseline/);

  assert.ok(!fs.existsSync(claudeSkillDir));
  assert.ok(!fs.existsSync(codexSkillDir));

  const installationsAfterUninstall = JSON.parse(
    fs.readFileSync(path.join(homeDir, ".equip", "installations.json"), "utf-8"),
  );
  assert.ok(!installationsAfterUninstall.augments["demo-direct-install"]);

  const requestsBeforeOfflineReinstall = requests.length;
  await closeServer(server);

  const reinstall = await runCli([
    "bin/equip.js",
    "demo-direct-install",
    "--verbose",
    "--platform",
    "claude-code,codex",
    "--non-interactive",
  ], env);
  assert.equal(reinstall.code, 0, reinstall.output);
  assert.match(reinstall.output, /loaded from cache/i);
  assert.equal(
    requests.length,
    requestsBeforeOfflineReinstall,
    "offline reinstall should not hit the registry after the server is closed",
  );

  const installationsAfterOfflineReinstall = JSON.parse(
    fs.readFileSync(path.join(homeDir, ".equip", "installations.json"), "utf-8"),
  );
  assert.ok(
    installationsAfterOfflineReinstall.augments["demo-direct-install"],
    "offline reinstall should restore the cached installation record",
  );

  const restoreClaude = await runCli(["bin/equip.js", "restore", "claude-code", "--non-interactive"], env);
  assert.equal(restoreClaude.code, 0, restoreClaude.output);
  assert.match(restoreClaude.output, /Config file restored/);
  assert.match(restoreClaude.output, /Rules file restored/);

  const restoreCodex = await runCli(["bin/equip.js", "restore", "codex", "--non-interactive"], env);
  assert.equal(restoreCodex.code, 0, restoreCodex.output);
  assert.match(restoreCodex.output, /Config file restored/);
  assert.match(restoreCodex.output, /Rules file restored/);

  const claudeConfigAfterRestore = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
  assert.ok(!claudeConfigAfterRestore.mcpServers["demo-direct-install"]);
  assert.equal(claudeConfigAfterRestore.mcpServers["existing-tool"].url, claudeExistingServerUrl);
  assert.equal(claudeConfigAfterRestore.theme, "baseline-theme");

  const codexConfigAfterRestore = fs.readFileSync(codexConfigPath, "utf-8");
  assert.doesNotMatch(codexConfigAfterRestore, /\[mcp_servers\.demo-direct-install\]/);
  assert.match(codexConfigAfterRestore, /\[mcp_servers\.existing-tool\]/);
  assert.match(codexConfigAfterRestore, new RegExp(`url = "${escapeRegExp(codexExistingServerUrl)}"`));

  const claudeRulesAfterRestore = fs.readFileSync(claudeRulesPath, "utf-8");
  assert.doesNotMatch(claudeRulesAfterRestore, /demo-direct-install/);
  assert.match(claudeRulesAfterRestore, /Keep this Claude baseline/);

  const codexRulesAfterRestore = fs.readFileSync(codexRulesPath, "utf-8");
  assert.doesNotMatch(codexRulesAfterRestore, /demo-direct-install/);
  assert.match(codexRulesAfterRestore, /Keep this Codex baseline/);
});

test("authenticated direct-mode registry install writes MCP auth headers in Docker", async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "equip-docker-auth-acceptance-"));
  const homeDir = path.join(workspaceRoot, "home");
  const codexHome = path.join(homeDir, ".codex");
  const claudeConfigPath = path.join(homeDir, ".claude.json");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const apiKeyPath = path.join(workspaceRoot, "demo-auth.key");
  const apiKey = "ask_demo_auth_fixture";

  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".agents"), { recursive: true });
  fs.writeFileSync(apiKeyPath, `${apiKey}\n`, "utf-8");

  const requests = [];
  let registryOrigin = "";
  let serverUrl = "";

  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method || "GET",
      url: req.url || "/",
      authorization: req.headers.authorization || "",
    });

    if (req.method === "GET" && req.url === "/augments/demo-direct-install-auth") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(makeAuthFixture(serverUrl, registryOrigin)));
      return;
    }

    if (req.method === "GET" && req.url === "/validate") {
      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing or invalid authorization header" }));
        return;
      }

      res.writeHead(204);
      res.end();
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
  registryOrigin = `http://127.0.0.1:${address.port}`;
  serverUrl = `${registryOrigin}/mcp`;

  t.after(async () => {
    if (server.listening) {
      await closeServer(server);
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const homeRoot = path.parse(homeDir).root;
  const windowsHomePath = process.platform === "win32"
    ? homeDir.slice(homeRoot.length - 1)
    : undefined;

  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    HOMEDRIVE: process.platform === "win32" ? homeRoot.replace(/[\\\/]+$/, "") : process.env.HOMEDRIVE,
    HOMEPATH: windowsHomePath ?? process.env.HOMEPATH,
    APPDATA: path.join(homeDir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
    CODEX_HOME: codexHome,
    EQUIP_REGISTRY_URL: registryOrigin,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };

  const install = await runCli([
    "bin/equip.js",
    "demo-direct-install-auth",
    "--api-key-file",
    apiKeyPath,
    "--non-interactive",
    "--verbose",
    "--platform",
    "claude-code,codex",
  ], env);

  assert.equal(install.code, 0, install.output);
  assert.match(install.output, /Authenticated/i);
  assert.match(install.output, /validated/i);
  assert.ok(
    requests.some(request => request.method === "GET" && request.url === "/augments/demo-direct-install-auth"),
    "fixture registry should receive the authenticated augment definition request",
  );
  assert.ok(
    requests.some(
      request => request.method === "GET"
        && request.url === "/validate"
        && request.authorization === `Bearer ${apiKey}`,
    ),
    "credential validation should send the Bearer token to the fixture registry",
  );

  const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
  assert.equal(claudeConfig.mcpServers["demo-direct-install-auth"].url, serverUrl);
  assert.equal(claudeConfig.mcpServers["demo-direct-install-auth"].type, "http");
  assert.equal(
    claudeConfig.mcpServers["demo-direct-install-auth"].headers.Authorization,
    `Bearer ${apiKey}`,
  );

  const codexConfig = fs.readFileSync(codexConfigPath, "utf-8");
  assert.match(codexConfig, /\[mcp_servers\.demo-direct-install-auth\]/);
  assert.match(codexConfig, new RegExp(`url = "${escapeRegExp(serverUrl)}"`));
  assert.match(codexConfig, /\[mcp_servers\.demo-direct-install-auth\.http_headers\]/);
  assert.match(codexConfig, new RegExp(`Authorization = "Bearer ${escapeRegExp(apiKey)}"`));

  const storedCredentialPath = path.join(homeDir, ".equip", "credentials", "demo-direct-install-auth.json");
  assert.ok(fs.existsSync(storedCredentialPath), "install should persist the resolved credential");
  const storedCredential = JSON.parse(fs.readFileSync(storedCredentialPath, "utf-8"));
  assert.equal(storedCredential.authType, "api_key");
  assert.equal(storedCredential.credential, apiKey);

  const installations = JSON.parse(fs.readFileSync(path.join(homeDir, ".equip", "installations.json"), "utf-8"));
  assert.ok(installations.augments["demo-direct-install-auth"], "installations.json should record the authenticated augment");
});
