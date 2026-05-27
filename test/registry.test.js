// Tests for registry module: RegistryDef conversion, fetchRegistryDef resolution, and CLI dispatch.

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const { registryDefToConfig, resolveRegistryInstallReviewGate } = require("../dist/lib/registry");
const { Augment } = require("../dist/index");
const {
  computeContentHashV2,
  extractManifestV2,
} = require("../dist/lib/content-hash");

const FIXTURE_PATH = path.join(__dirname, "docker", "fixtures", "demo-direct-install.json");
const FIXTURE_TEMPLATE = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
const HERMETIC_FIXTURE_NAME = "demo-direct-install";
const AUTH_FIXTURE_NAME = "demo-direct-install-auth";
const HASH_MATCH_FIXTURE_NAME = "demo-direct-install-hash-match";
const HASH_ALGORITHM_MISMATCH_FIXTURE_NAME = "demo-direct-install-hash-algorithm-mismatch";
const UNREVIEWED_FIXTURE_NAME = "demo-direct-install-unreviewed";

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
    status: "active",
    reviewStatus: "approved",
    trustTier: "reviewed",
    ...overrides,
  });
}

function withV2ContentHash(def, hashAlgorithm = "sha256-v2") {
  return {
    ...def,
    version: def.version || 1,
    contentHash: computeContentHashV2(extractManifestV2(def)),
    hashAlgorithm,
  };
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
          [HASH_MATCH_FIXTURE_NAME]: withV2ContentHash(
            buildFixture(origin, HASH_MATCH_FIXTURE_NAME, {
              title: "Demo Direct Install Hash Match",
            }),
          ),
          [HASH_ALGORITHM_MISMATCH_FIXTURE_NAME]: withV2ContentHash(
            buildFixture(origin, HASH_ALGORITHM_MISMATCH_FIXTURE_NAME, {
              title: "Demo Direct Install Hash Algorithm Mismatch",
            }),
            "sha256-v1",
          ),
          [UNREVIEWED_FIXTURE_NAME]: buildFixture(origin, UNREVIEWED_FIXTURE_NAME, {
            title: "Demo Direct Install Unreviewed",
            status: "synced-unreviewed",
            reviewStatus: "unreviewed",
            trustTier: "unscanned",
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

function findCachedDefinitionFiles(root, name) {
  if (!fs.existsSync(root)) return [];
  const matches = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findCachedDefinitionFiles(fullPath, name));
    } else if (entry.isFile() && entry.name === `${name}.json`) {
      matches.push(fullPath);
    }
  }

  return matches;
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

  it("selects package installTargets for Augment MCP config output", () => {
    const def = {
      name: "package-stdio",
      title: "Package Stdio",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "npm",
        identifier: "@example/package-stdio",
        environmentVariables: [{ name: "EXAMPLE_TOKEN", isRequired: true, isSecret: true }],
      }],
    };

    const config = registryDefToConfig(def);
    const augment = new Augment(config);
    const mcpConfig = augment.buildConfig("claude-code", "secret", "stdio");

    assert.equal(config.mcpInstallTarget.kind, "stdio");
    assert.equal(config.stdio.command, "npx");
    if (process.platform === "win32") {
      assert.deepEqual(mcpConfig.args.slice(0, 4), ["/c", "npx", "-y", "@example/package-stdio"]);
    } else {
      assert.equal(mcpConfig.command, "npx");
      assert.deepEqual(mcpConfig.args, ["-y", "@example/package-stdio"]);
    }
    assert.equal(mcpConfig.env.EXAMPLE_TOKEN, "secret");
  });

  it("carries caller-provided MCP install inputs into Augment config output", () => {
    const def = {
      name: "package-stdio-inputs",
      title: "Package Stdio Inputs",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "npm",
        identifier: "@example/package-stdio",
        environmentVariables: [
          { name: "TENANT_ID", isRequired: true, isSecret: false },
          { name: "API_TOKEN", isRequired: true, isSecret: true },
        ],
      }],
    };

    const config = registryDefToConfig(def, {
      mcpInstallInputs: {
        TENANT_ID: "tenant-1",
        API_TOKEN: "secret",
      },
    });
    const augment = new Augment(config);
    const mcpConfig = augment.buildConfig("claude-code", null, "stdio");

    assert.equal(mcpConfig.env.TENANT_ID, "tenant-1");
    assert.equal(mcpConfig.env.API_TOKEN, "secret");
  });

  it("keeps unsupported installTargets visible to install errors", () => {
    const def = {
      name: "sse-registry",
      title: "SSE Registry",
      description: "",
      installMode: "direct",
      installTargets: [{
        targetKind: "remote",
        transport: "sse",
        url: "https://example.com/sse",
      }],
    };

    const config = registryDefToConfig(def);
    const augment = new Augment(config);

    assert.equal(config.mcpInstallTarget.kind, "remote");
    assert.equal(config.mcpInstallTarget.transport, "sse");
    assert.throws(
      () => augment.buildConfig("claude-code", null),
      /remote-sse-unsupported|SSE MCP transport/,
    );
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

describe("resolveRegistryInstallReviewGate", () => {
  it("allows reviewed registry MCP definitions", () => {
    const gate = resolveRegistryInstallReviewGate({
      name: "reviewed",
      title: "Reviewed",
      description: "",
      installMode: "direct",
      transport: "http",
      serverUrl: "https://example.com/mcp",
      trustTier: "reviewed",
    });

    assert.equal(gate.allowed, true);
    assert.equal(gate.code, "allowed");
  });

  it("does not gate rules-only definitions", () => {
    const gate = resolveRegistryInstallReviewGate({
      name: "rules-only",
      title: "Rules Only",
      description: "",
      installMode: "direct",
      trustTier: "unscanned",
      rules: {
        content: "<!-- rules:v1 -->\nRules\n<!-- /rules -->",
        version: "1.0.0",
        marker: "rules",
      },
    });

    assert.equal(gate.allowed, true);
    assert.equal(gate.code, "no-mcp");
  });

  it("requires an explicit override for visible unreviewed MCP definitions", () => {
    const gate = resolveRegistryInstallReviewGate({
      name: "unreviewed",
      title: "Unreviewed",
      description: "",
      installMode: "direct",
      stdioCommand: "node",
      stdioArgs: ["server.js"],
      status: "synced-unreviewed",
      reviewStatus: "unreviewed",
      trustTier: "unscanned",
    });

    assert.equal(gate.allowed, false);
    assert.equal(gate.bypassable, true);
    assert.equal(gate.code, "unreviewed");
  });

  it("gates registry package installTargets as MCP definitions", () => {
    const gate = resolveRegistryInstallReviewGate({
      name: "registry-package",
      title: "Registry Package",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "npm",
        identifier: "@example/mcp-server",
      }],
      trustTier: "unscanned",
      reviewStatus: "unreviewed",
    });

    assert.equal(gate.allowed, false);
    assert.equal(gate.bypassable, true);
    assert.equal(gate.code, "unreviewed");
  });

  it("requires an explicit override when MCP review metadata is missing", () => {
    const gate = resolveRegistryInstallReviewGate({
      name: "unknown-mcp",
      title: "Unknown MCP",
      description: "",
      installMode: "direct",
      transport: "stdio",
      stdioCommand: "node",
      stdioArgs: ["server.js"],
    });

    assert.equal(gate.allowed, false);
    assert.equal(gate.bypassable, true);
    assert.equal(gate.code, "unreviewed");
  });

  it("hard-blocks rejected and needs-attention MCP definitions", () => {
    for (const reviewStatus of ["rejected", "needs-attention", "pending-review"]) {
      const gate = resolveRegistryInstallReviewGate({
        name: reviewStatus,
        title: reviewStatus,
        description: "",
        installMode: "direct",
        transport: "http",
        serverUrl: "https://example.com/mcp",
        reviewStatus,
      });

      assert.equal(gate.allowed, false);
      assert.equal(gate.bypassable, false);
    }
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

  it("accepts a registry definition whose advertised hash algorithm matches its digest", async () => {
    const def = await fetchRegistryDef(HASH_MATCH_FIXTURE_NAME);

    assert.ok(def, "Should fetch the hash-verified fixture");
    assert.equal(def.hashAlgorithm, "sha256-v2");
  });

  it("rejects a registry definition whose advertised algorithm cannot reproduce its digest", async () => {
    const logger = recordingLogger();

    await assert.rejects(
      () => fetchRegistryDef(HASH_ALGORITHM_MISMATCH_FIXTURE_NAME, { logger }),
      /Registry content hash mismatch/,
    );
    assert.ok(
      logger.calls.some(c => c.level === "error" && c.msg.includes("Registry content hash mismatch")),
      "integrity mismatch should be logged as an error",
    );
    assert.equal(
      logger.calls.some(c => c.msg.includes("loaded from cache")),
      false,
      "integrity mismatch must not fall back to cache",
    );
  });

  it("returns null for nonexistent tool", async () => {
    const def = await fetchRegistryDef("nonexistent-tool-xyz-12345");
    assert.equal(def, null);
  });

  it("caches fetched definitions", async () => {
    await fetchRegistryDef(HERMETIC_FIXTURE_NAME);

    const cacheRoot = path.join(hermeticHome.homeDir, ".equip", "cache");
    const cachePath = path.join(cacheRoot, `${HERMETIC_FIXTURE_NAME}.json`);
    assert.equal(fs.existsSync(cachePath), false, "Cache file should not be written to the legacy shared path");

    const matches = findCachedDefinitionFiles(cacheRoot, HERMETIC_FIXTURE_NAME);
    assert.equal(matches.length, 1, "Cache file should exist under one registry-scoped directory");
    assert.ok(matches[0].includes(`${path.sep}registries${path.sep}`), "Cache path should be registry-scoped");

    const cached = JSON.parse(fs.readFileSync(matches[0], "utf-8"));
    assert.equal(cached.schemaVersion, 1);
    assert.equal(cached.def.name, HERMETIC_FIXTURE_NAME);
    assert.equal(cached.def.installMode, "direct");
  });

  it("does not use cache entries written for another registry URL", async () => {
    await fetchRegistryDef(HERMETIC_FIXTURE_NAME);

    const { fetchRegistryDef: fetchFromOtherRegistry } = loadRegistryModule("http://127.0.0.1:1");
    const def = await fetchFromOtherRegistry(HERMETIC_FIXTURE_NAME);

    assert.equal(def, null);
  });

  it("uses a compatible registry cache when the API is unavailable", async () => {
    await fetchRegistryDef(HERMETIC_FIXTURE_NAME);
    const priorFetch = global.fetch;
    global.fetch = async () => {
      throw new Error("offline");
    };
    try {
      const def = await fetchRegistryDef(HERMETIC_FIXTURE_NAME);
      assert.ok(def);
      assert.equal(def.name, HERMETIC_FIXTURE_NAME);
    } finally {
      global.fetch = priorFetch;
    }
  });

  it("ignores incompatible registry cache schemas", async () => {
    await fetchRegistryDef(HERMETIC_FIXTURE_NAME);
    const cacheRoot = path.join(hermeticHome.homeDir, ".equip", "cache");
    const [cachePath] = findCachedDefinitionFiles(cacheRoot, HERMETIC_FIXTURE_NAME);
    fs.writeFileSync(cachePath, JSON.stringify({
      schemaVersion: 999,
      registryKey: "wrong",
      registryUrl: registry.origin,
      fetchedAt: new Date().toISOString(),
      def: buildFixture(registry.origin, HERMETIC_FIXTURE_NAME),
    }, null, 2));

    const priorFetch = global.fetch;
    global.fetch = async () => {
      throw new Error("offline");
    };
    try {
      const def = await fetchRegistryDef(HERMETIC_FIXTURE_NAME);
      assert.equal(def, null);
    } finally {
      global.fetch = priorFetch;
    }
  });

  it("ignores cache envelopes for the wrong registry key", async () => {
    await fetchRegistryDef(HERMETIC_FIXTURE_NAME);
    const cacheRoot = path.join(hermeticHome.homeDir, ".equip", "cache");
    const [cachePath] = findCachedDefinitionFiles(cacheRoot, HERMETIC_FIXTURE_NAME);
    fs.writeFileSync(cachePath, JSON.stringify({
      schemaVersion: 1,
      registryKey: "wrong-registry",
      registryUrl: "https://example.invalid/equip",
      fetchedAt: new Date().toISOString(),
      def: buildFixture(registry.origin, HERMETIC_FIXTURE_NAME),
    }, null, 2));

    const priorFetch = global.fetch;
    global.fetch = async () => {
      throw new Error("offline");
    };
    try {
      const def = await fetchRegistryDef(HERMETIC_FIXTURE_NAME);
      assert.equal(def, null);
    } finally {
      global.fetch = priorFetch;
    }
  });

  it("ignores cache envelopes with malformed definitions", async () => {
    await fetchRegistryDef(HERMETIC_FIXTURE_NAME);
    const cacheRoot = path.join(hermeticHome.homeDir, ".equip", "cache");
    const cachePaths = findCachedDefinitionFiles(cacheRoot, HERMETIC_FIXTURE_NAME);
    assert.ok(cachePaths.length > 0, "expected at least one cached definition");
    for (const cachePath of cachePaths) {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      const malformedDef = { ...cached.def };
      delete malformedDef.title;
      fs.writeFileSync(cachePath, JSON.stringify({
        ...cached,
        def: malformedDef,
      }, null, 2));
    }

    const priorFetch = global.fetch;
    global.fetch = async () => {
      throw new Error("offline");
    };
    try {
      const def = await fetchRegistryDef(HERMETIC_FIXTURE_NAME);
      assert.equal(def, null);
    } finally {
      global.fetch = priorFetch;
    }
  });

  it("one-shot migrates raw registry cache definitions", async () => {
    await fetchRegistryDef(HERMETIC_FIXTURE_NAME);
    const cacheRoot = path.join(hermeticHome.homeDir, ".equip", "cache");
    const [cachePath] = findCachedDefinitionFiles(cacheRoot, HERMETIC_FIXTURE_NAME);
    fs.writeFileSync(cachePath, JSON.stringify(buildFixture(registry.origin, HERMETIC_FIXTURE_NAME), null, 2));

    const priorFetch = global.fetch;
    global.fetch = async () => {
      throw new Error("offline");
    };
    try {
      const def = await fetchRegistryDef(HERMETIC_FIXTURE_NAME);
      assert.ok(def);
      assert.equal(def.name, HERMETIC_FIXTURE_NAME);
      const migrated = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      assert.equal(migrated.schemaVersion, 1);
      assert.equal(migrated.def.name, HERMETIC_FIXTURE_NAME);
    } finally {
      global.fetch = priorFetch;
    }
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

  it("blocks unreviewed registry MCP installs unless explicitly overridden", async () => {
    const blocked = await runEquip([
      UNREVIEWED_FIXTURE_NAME,
      "--dry-run",
      "--platform",
      "claude-code",
    ], cliEnv);

    assert.equal(blocked.code, 1, blocked.output);
    assert.match(blocked.output, /has not cleared CG3 review/);
    assert.match(blocked.output, /--allow-unreviewed/);

    const allowed = await runEquip([
      UNREVIEWED_FIXTURE_NAME,
      "--dry-run",
      "--allow-unreviewed",
      "--platform",
      "claude-code",
    ], cliEnv);

    assert.equal(allowed.code, 0, allowed.output);
    assert.match(allowed.output, /continuing with an unreviewed MCP augment/);
    assert.match(allowed.output, /Done\./);
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
