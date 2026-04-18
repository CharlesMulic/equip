// Tests for registry module: RegistryDef conversion, fetchRegistryDef resolution, and CLI dispatch.

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const { registryDefToConfig } = require("../dist/lib/registry");
const { Augment } = require("../dist/index");

const FIXTURE_PATH = path.join(__dirname, "docker", "fixtures", "demo-direct-install.json");
const FIXTURE_TEMPLATE = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
const HERMETIC_FIXTURE_NAME = "demo-direct-install";
const AUTH_FIXTURE_NAME = "demo-direct-install-auth";

function tmpPath(prefix = "reg-test") {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function recordingLogger() {
  const calls = [];
  return {
    calls,
    debug(msg, ctx) { calls.push({ level: "debug", msg, ctx }); },
    info(msg, ctx) { calls.push({ level: "info", msg, ctx }); },
    warn(msg, ctx) { calls.push({ level: "warn", msg, ctx }); },
    error(msg, ctx) { calls.push({ level: "error", msg, ctx }); },
  };
}

function mergeFixture(base, overrides = {}) {
  return {
    ...base,
    ...overrides,
    rules: {
      ...base.rules,
      ...(overrides.rules || {}),
    },
    skills: overrides.skills || base.skills,
    auth: overrides.auth || base.auth,
    postInstall: overrides.postInstall || base.postInstall,
    platformHints: overrides.platformHints || base.platformHints,
  };
}

function buildFixture(origin, name, overrides = {}) {
  return mergeFixture(FIXTURE_TEMPLATE, {
    name,
    serverUrl: `${origin}/mcp/${name}`,
    ...overrides,
  });
}

function startFixtureRegistry() {
  const requests = [];
  let origin = "";

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method || "GET", url: req.url || "/" });

      const match = /^\/augments\/([^/]+)$/.exec(req.url || "");
      if (req.method === "GET" && match) {
        const name = decodeURIComponent(match[1]);
        const fixtures = {
          [HERMETIC_FIXTURE_NAME]: buildFixture(origin, HERMETIC_FIXTURE_NAME),
          [AUTH_FIXTURE_NAME]: buildFixture(origin, AUTH_FIXTURE_NAME, {
            title: "Demo Direct Install Auth",
            auth: {
              type: "api_key",
              envKey: "DEMO_DIRECT_INSTALL_KEY",
            },
            rules: {
              marker: AUTH_FIXTURE_NAME,
              fileName: `${AUTH_FIXTURE_NAME}.md`,
            },
          }),
        };

        if (!fixtures[name]) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(fixtures[name]));
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

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      origin = `http://127.0.0.1:${address.port}`;
      resolve({
        origin,
        requests,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((err) => {
            if (err) closeReject(err);
            else closeResolve();
          });
        }),
      });
    });
  });
}

function setHermeticHome(prefix = "equip-registry-home") {
  const homeDir = tmpPath(prefix);
  const codexHome = path.join(homeDir, ".codex");
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    CODEX_HOME: process.env.CODEX_HOME,
  };

  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".agents"), { recursive: true });

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.CODEX_HOME = codexHome;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;

  return {
    homeDir,
    codexHome,
    restore() {
      if (previous.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = previous.HOME;
      if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previous.USERPROFILE;
      if (previous.HOMEDRIVE === undefined) delete process.env.HOMEDRIVE;
      else process.env.HOMEDRIVE = previous.HOMEDRIVE;
      if (previous.HOMEPATH === undefined) delete process.env.HOMEPATH;
      else process.env.HOMEPATH = previous.HOMEPATH;
      if (previous.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous.CODEX_HOME;
    },
  };
}

function loadRegistryModule(registryUrl) {
  const previous = process.env.EQUIP_REGISTRY_URL;
  process.env.EQUIP_REGISTRY_URL = registryUrl;

  const modulePath = require.resolve("../dist/lib/registry");
  delete require.cache[modulePath];
  const registryModule = require("../dist/lib/registry");

  if (previous === undefined) delete process.env.EQUIP_REGISTRY_URL;
  else process.env.EQUIP_REGISTRY_URL = previous;

  return registryModule;
}

function runEquip(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/equip.js", ...args], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        ...env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
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
        output: `${stdout}${stderr}`,
      });
    });
  });
}

describe("registryDefToConfig", () => {
  it("converts minimal direct-mode tool", () => {
    const def = {
      name: "test-tool",
      title: "Test Tool",
      description: "A test",
      installMode: "direct",
      transport: "http",
      serverUrl: "https://example.com/mcp",
      requiresAuth: false,
      categories: [],
    };
    const config = registryDefToConfig(def);
    assert.equal(config.name, "test-tool");
    assert.equal(config.serverUrl, "https://example.com/mcp");
    assert.equal(config.rules, undefined);
    assert.equal(config.hooks, undefined);
    assert.deepEqual(config.skills, undefined);
  });

  it("converts tool with rules", () => {
    const def = {
      name: "test",
      title: "Test",
      description: "",
      installMode: "direct",
      serverUrl: "https://example.com/mcp",
      rules: {
        content: "<!-- test:v1.0.0 -->\nRules\n<!-- /test -->",
        version: "1.0.0",
        marker: "test",
      },
    };
    const config = registryDefToConfig(def);
    assert.ok(config.rules);
    assert.equal(config.rules.content, def.rules.content);
    assert.equal(config.rules.version, "1.0.0");
    assert.equal(config.rules.marker, "test");
  });

  it("converts tool with rules.fileName", () => {
    const def = {
      name: "test",
      title: "Test",
      description: "",
      installMode: "direct",
      serverUrl: "https://example.com/mcp",
      rules: {
        content: "<!-- test:v1.0.0 -->\nRules\n<!-- /test -->",
        version: "1.0.0",
        marker: "test",
        fileName: "test.md",
      },
    };
    const config = registryDefToConfig(def);
    assert.ok(config.rules);
    assert.equal(config.rules.fileName, "test.md");
  });

  it("converts tool with skills (preserves all skills from array)", () => {
    const def = {
      name: "test",
      title: "Test",
      description: "",
      installMode: "direct",
      serverUrl: "https://example.com/mcp",
      skills: [
        { name: "search", files: [{ path: "SKILL.md", content: "skill content" }] },
        { name: "other", files: [{ path: "SKILL.md", content: "other" }] },
      ],
    };
    const config = registryDefToConfig(def);
    assert.ok(config.skills);
    assert.equal(config.skills.length, 2);
    assert.equal(config.skills[0].name, "search");
    assert.equal(config.skills[1].name, "other");
    const augment = new Augment(config);
    assert.equal(augment.skills.length, 2);
    assert.equal(augment.skills[0].name, "search");
  });

  it("converts tool with stdio config", () => {
    const def = {
      name: "test",
      title: "Test",
      description: "",
      installMode: "direct",
      stdioCommand: "node",
      stdioArgs: ["server.js"],
      envKey: "MY_API_KEY",
    };
    const config = registryDefToConfig(def);
    assert.ok(config.stdio);
    assert.equal(config.stdio.command, "node");
    assert.deepEqual(config.stdio.args, ["server.js"]);
    assert.equal(config.stdio.envKey, "MY_API_KEY");
  });

  it("converts tool with hooks", () => {
    const def = {
      name: "test",
      title: "Test",
      description: "",
      installMode: "direct",
      serverUrl: "https://example.com/mcp",
      hooks: [{ event: "PostToolUse", script: "console.log('hi')", name: "test-hook" }],
      hookDir: "~/.test/hooks",
    };
    const config = registryDefToConfig(def);
    assert.ok(config.hooks);
    assert.equal(config.hooks.length, 1);
    assert.equal(config.hooks[0].event, "PostToolUse");
    assert.ok(config.hookDir);
    assert.ok(!config.hookDir.startsWith("~"));
    assert.ok(config.hookDir.includes(".test"));
  });

  it("passes logger through", () => {
    const logger = recordingLogger();
    const def = { name: "test", title: "Test", description: "", installMode: "direct" };
    const config = registryDefToConfig(def, { logger });
    assert.equal(config.logger, logger);
  });
});

describe("fetchRegistryDef", () => {
  let registry;
  let hermeticHome;
  let fetchRegistryDef;

  before(async () => {
    registry = await startFixtureRegistry();
    hermeticHome = setHermeticHome("equip-fetch-registry-home");
    ({ fetchRegistryDef } = loadRegistryModule(registry.origin));
  });

  after(async () => {
    hermeticHome.restore();
    fs.rmSync(hermeticHome.homeDir, { recursive: true, force: true });
    await registry.close();
  });

  it("fetches the hermetic fixture from the local registry", async () => {
    const logger = recordingLogger();
    const def = await fetchRegistryDef(HERMETIC_FIXTURE_NAME, { logger });

    assert.ok(def, "Should fetch the hermetic fixture from the local registry");
    assert.equal(def.name, HERMETIC_FIXTURE_NAME);
    assert.equal(def.installMode, "direct");
    assert.equal(def.serverUrl, `${registry.origin}/mcp/${HERMETIC_FIXTURE_NAME}`);
    assert.ok(def.rules, "Should have rules");
    assert.equal(def.rules.marker, HERMETIC_FIXTURE_NAME);
    assert.ok(def.skills, "Should have skills");
    assert.ok(def.skills.length > 0);

    const infos = logger.calls.filter(c => c.level === "info");
    assert.ok(infos.some(c => c.msg.includes("fetched from API")));
  });

  it("returns null for nonexistent tool", async () => {
    const def = await fetchRegistryDef("nonexistent-tool-xyz-12345");
    assert.equal(def, null);
  });

  it("caches fetched definitions", async () => {
    await fetchRegistryDef(HERMETIC_FIXTURE_NAME);

    const cachePath = path.join(hermeticHome.homeDir, ".equip", "cache", `${HERMETIC_FIXTURE_NAME}.json`);
    assert.ok(fs.existsSync(cachePath), "Cache file should exist after fetch");

    const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    assert.equal(cached.name, HERMETIC_FIXTURE_NAME);
    assert.equal(cached.installMode, "direct");
  });
});

describe("direct-mode CLI", () => {
  let registry;
  let homeDir;
  let codexHome;
  let cliEnv;

  before(async () => {
    registry = await startFixtureRegistry();
    homeDir = tmpPath("equip-direct-cli-home");
    codexHome = path.join(homeDir, ".codex");

    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".agents"), { recursive: true });

    cliEnv = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODEX_HOME: codexHome,
      EQUIP_REGISTRY_URL: registry.origin,
    };
  });

  after(async () => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    await registry.close();
  });

  it("dry-run installs the hermetic fixture without writing platform files", async () => {
    const result = await runEquip([
      HERMETIC_FIXTURE_NAME,
      "--dry-run",
      "--platform",
      "claude-code,codex",
    ], cliEnv);

    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes("Demo Direct Install"), "Should show tool title");
    assert.ok(result.output.includes("DRY RUN"), "Should indicate dry run");
    assert.ok(result.output.includes("MCP Server"), "Should show MCP install step");
    assert.ok(result.output.includes("Done."), "Should complete successfully");
    assert.equal(fs.existsSync(path.join(homeDir, ".claude.json")), false, "Dry run should not write Claude config");
    assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false, "Dry run should not write Codex config");
  });

  it("verbose dry-run shows debug output", async () => {
    const result = await runEquip([
      HERMETIC_FIXTURE_NAME,
      "--dry-run",
      "--verbose",
      "--platform",
      "claude-code,codex",
    ], cliEnv);

    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes("[debug]"), "Should show debug-level output");
    assert.ok(result.output.includes("Fetching augment definition from API"), "Should log API fetch");
  });

  it("authenticated direct-mode fixtures route through auth flow", async () => {
    const result = await runEquip([
      AUTH_FIXTURE_NAME,
      "--api-key",
      "test-key",
      "--dry-run",
      "--verbose",
      "--platform",
      "claude-code,codex",
    ], cliEnv);

    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes("direct"), "Should fetch as direct-mode");
    assert.ok(result.output.includes("Authenticated"), "Should authenticate");
    assert.ok(result.output.includes("MCP Server"), "Should install MCP");
    assert.ok(result.output.includes("Behavioral Rules"), "Should install rules");
    assert.ok(result.output.includes("Done."), "Should complete");
  });

  it("--platform flag filters platforms", async () => {
    const result = await runEquip([
      HERMETIC_FIXTURE_NAME,
      "--platform",
      "claude-code",
      "--dry-run",
    ], cliEnv);

    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes("Claude Code"), "Should include Claude Code");
    assert.ok(!result.output.includes("Codex"), "Should filter out Codex");
    assert.ok(result.output.includes("1 platform configured"), "Should show 1 platform");
  });

  it("equip update <tool> re-fetches and re-installs", async () => {
    const result = await runEquip([
      "update",
      HERMETIC_FIXTURE_NAME,
      "--dry-run",
      "--platform",
      "claude-code,codex",
    ], cliEnv);

    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes("equip update"), "Should show update header");
    assert.ok(result.output.includes("Demo Direct Install"), "Should fetch tool definition");
    assert.ok(result.output.includes("Done."), "Should complete");
  });
});

describe("live registry contract", {
  skip: !process.env.EQUIP_LIVE_REGISTRY_TESTS && "set EQUIP_LIVE_REGISTRY_TESTS=1 to run live registry contract checks",
}, () => {
  it("prior definition includes current registry data fields", async () => {
    const { fetchRegistryDef } = loadRegistryModule("https://api.cg3.io/equip");
    const def = await fetchRegistryDef("prior");

    assert.ok(def);
    assert.ok(def.auth.validationUrl, "Should have validationUrl");
    assert.ok(def.auth.validationUrl.includes("/v1/agents/me"));
    assert.ok(def.postInstall, "Should have postInstall actions");
    assert.ok(Array.isArray(def.postInstall));
    assert.equal(def.postInstall[0].type, "open_with_code");
    assert.equal(def.postInstall[0].codePath, "data.code");
    assert.ok(def.platformHints, "Should have platformHints");
    assert.ok(def.platformHints.cursor, "Should have Cursor hint");
    assert.ok(def.rules.fileName, "Should have rules fileName");
    assert.equal(def.rules.fileName, "prior.md");
  });
});
