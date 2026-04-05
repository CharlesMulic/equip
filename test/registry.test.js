// Tests for registry module: RegistryDef conversion, fetchRegistryDef resolution, caching.

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { registryDefToConfig, fetchRegistryDef } = require("../dist/lib/registry");
const { Augment } = require("../dist/index");

// ─── Test Helpers ───────────────────────────────────────────

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

// ─── registryDefToConfig ──────────────────────────────────

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
    // ~ should be expanded
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

// ─── fetchRegistryDef ──────────────────────────────────────────

describe("fetchRegistryDef", { skip: !!process.env.CI && "requires network access" }, () => {
  it("fetches demo-fetch from live API", async () => {
    const logger = recordingLogger();
    const def = await fetchRegistryDef("demo-fetch", { logger });

    assert.ok(def, "Should fetch demo-fetch from API");
    assert.equal(def.name, "demo-fetch");
    assert.equal(def.installMode, "direct");
    assert.equal(def.serverUrl, "https://httpbin.org/anything");
    assert.ok(def.rules, "Should have rules");
    assert.equal(def.rules.marker, "demo-fetch");
    assert.ok(def.skills, "Should have skills");
    assert.ok(def.skills.length > 0);

    // Should have logged fetch and cache
    const infos = logger.calls.filter(c => c.level === "info");
    assert.ok(infos.some(c => c.msg.includes("fetched from API")));
  });

  it("fetches prior from live API as direct-mode", async () => {
    const def = await fetchRegistryDef("prior");
    assert.ok(def);
    assert.equal(def.name, "prior");
    assert.equal(def.installMode, "direct");
    assert.equal(def.serverUrl, "https://api.cg3.io/mcp");
    assert.ok(def.rules, "Should have rules");
    assert.equal(def.rules.marker, "prior");
    assert.ok(def.auth, "Should have auth config");
    assert.equal(def.auth.type, "oauth_to_api_key");
  });

  it("returns null for nonexistent tool", async () => {
    const def = await fetchRegistryDef("nonexistent-tool-xyz-12345");
    assert.equal(def, null);
  });

  it("caches fetched definitions", async () => {
    // First fetch — hits API
    await fetchRegistryDef("demo-fetch");

    // Verify cache file exists
    const cachePath = path.join(os.homedir(), ".equip", "cache", "demo-fetch.json");
    assert.ok(fs.existsSync(cachePath), "Cache file should exist after fetch");

    const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    assert.equal(cached.name, "demo-fetch");
    assert.equal(cached.installMode, "direct");
  });
});

// ─── Direct-mode CLI integration ───────────────────────────

describe("direct-mode CLI", { skip: !!process.env.CI && "requires detected platforms and network" }, () => {
  it("dry-run installs demo-fetch without writing files", () => {
    const { execSync } = require("child_process");
    // CLI writes to stderr, redirect stderr to stdout to capture
    const out = execSync("node bin/equip.js demo-fetch --dry-run 2>&1", {
      encoding: "utf-8",
      cwd: path.join(__dirname, ".."),
      timeout: 15000,
      shell: true,
    });
    assert.ok(out.includes("Demo Fetch"), "Should show tool display name");
    assert.ok(out.includes("DRY RUN"), "Should indicate dry run");
    assert.ok(out.includes("MCP Server"), "Should show MCP install step");
    assert.ok(out.includes("Done."), "Should complete successfully");
  });

  it("verbose dry-run shows debug output", () => {
    const { execSync } = require("child_process");
    const out = execSync("node bin/equip.js demo-fetch --dry-run --verbose 2>&1", {
      encoding: "utf-8",
      cwd: path.join(__dirname, ".."),
      timeout: 15000,
      shell: true,
    });
    assert.ok(out.includes("[debug]"), "Should show debug-level output");
    assert.ok(out.includes("Fetching augment definition from API"), "Should log API fetch");
  });

  it("prior routes to direct-mode with auth", () => {
    const { execSync } = require("child_process");
    // Prior is now direct-mode. With --api-key and --dry-run we can test
    // the full flow without OAuth or writing files.
    const out = execSync("node bin/equip.js prior --api-key test-key --dry-run --verbose 2>&1", {
      encoding: "utf-8",
      cwd: path.join(__dirname, ".."),
      timeout: 15000,
      shell: true,
    });
    assert.ok(out.includes("direct"), "Should fetch as direct-mode");
    assert.ok(out.includes("Authenticated"), "Should authenticate");
    assert.ok(out.includes("MCP Server"), "Should install MCP");
    assert.ok(out.includes("Behavioral Rules"), "Should install rules");
    assert.ok(out.includes("Done."), "Should complete");
  });

  it("--platform flag filters platforms", () => {
    const { execSync } = require("child_process");
    const out = execSync("node bin/equip.js demo-fetch --platform claude-code --dry-run 2>&1", {
      encoding: "utf-8",
      cwd: path.join(__dirname, ".."),
      timeout: 15000,
      shell: true,
    });
    assert.ok(out.includes("Claude Code"), "Should include Claude Code");
    assert.ok(!out.includes("Cursor"), "Should NOT include Cursor");
    assert.ok(out.includes("1 platform configured"), "Should show 1 platform");
  });

  it("equip update <tool> re-fetches and re-installs", () => {
    const { execSync } = require("child_process");
    const out = execSync("node bin/equip.js update demo-fetch --dry-run 2>&1", {
      encoding: "utf-8",
      cwd: path.join(__dirname, ".."),
      timeout: 15000,
      shell: true,
    });
    assert.ok(out.includes("equip update"), "Should show update header");
    assert.ok(out.includes("Demo Fetch"), "Should fetch tool definition");
    assert.ok(out.includes("Done."), "Should complete");
  });

  it("prior definition includes new data fields", async () => {
    const def = await fetchRegistryDef("prior");
    assert.ok(def);
    // Auth validation URL
    assert.ok(def.auth.validationUrl, "Should have validationUrl");
    assert.ok(def.auth.validationUrl.includes("/v1/agents/me"));
    // Post-install actions
    assert.ok(def.postInstall, "Should have postInstall actions");
    assert.ok(Array.isArray(def.postInstall));
    assert.equal(def.postInstall[0].type, "open_with_code");
    assert.equal(def.postInstall[0].codePath, "data.code");
    // Platform hints
    assert.ok(def.platformHints, "Should have platformHints");
    assert.ok(def.platformHints.cursor, "Should have Cursor hint");
    // Rules fileName
    assert.ok(def.rules.fileName, "Should have rules fileName");
    assert.equal(def.rules.fileName, "prior.md");
  });
});
