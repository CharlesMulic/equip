// Tests for @cg3/equip library
// Node 18+ built-in test runner, zero dependencies

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

// Public API
const {
  Augment,
  createManualPlatform,
  platformName,
  KNOWN_PLATFORMS,
  cli,
} = require("..");

// Internal modules (for low-level tests)
const { buildHttpConfig, buildHttpConfigWithAuth, installMcpJson, installMcpToml, uninstallMcp } = require("../dist/lib/mcp");
const { installRules, uninstallRules: uninstallRulesFn, wrapRulesContent, stripRulesMarkers, parseRulesVersion, markerPatterns } = require("../dist/lib/rules");
const { parseTomlServerEntry, parseTomlSubTables, buildTomlEntry, removeTomlEntry } = require("../dist/lib/mcp");
const { atomicWriteFileSync, safeReadJsonSync, createBackup, cleanupBackup, resolvePackageVersion } = require("../dist/lib/fs");
const { reconcileState } = require("../dist/lib/reconcile");
const { getHookCapabilities, buildHooksConfig, installHooks, uninstallHooks, hasHooks } = require("../dist/lib/hooks");
const { installSkill, uninstallSkill, hasSkill } = require("../dist/lib/skills");
const { buildStdioConfig } = require("../dist/lib/mcp");
const { migrateConfigs } = require("../dist/lib/migrate");
const { trackInstallation, trackUninstallation } = require("../dist/lib/installations");
const { checkAuth, extractAuthHeader } = require("../dist/lib/auth");

// ─── Helpers ─────────────────────────────────────────────────

function tmpPath(prefix = "equip-test") {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function mockPlatform(overrides = {}) {
  return {
    platform: "claude-code",
    configPath: tmpPath("config") + ".json",
    rulesPath: tmpPath("rules") + ".md",
    existingMcp: null,
    rootKey: "mcpServers",
    configFormat: "json",
    ...overrides,
  };
}

function cleanup(...paths) {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(p + ".bak"); } catch {}
  }
}

const RULES_CONTENT = `<!-- test:v1.0.0 -->
## Test Rules
Always do the thing.
<!-- /test -->`;

// ─── Augment Class ─────────────────────────────────────────────

describe("Augment class", () => {
  it("requires name", () => {
    assert.throws(() => new Augment({}), /name is required/);
  });

  it("works without serverUrl (rules/skills only)", () => {
    const e = new Augment({ name: "test" });
    assert.equal(e.name, "test");
    assert.equal(e.serverUrl, undefined);
  });

  it("throws on installMcp without serverUrl", () => {
    const e = new Augment({ name: "test" });
    const p = mockPlatform();
    assert.throws(() => e.installMcp(p, "key"), /serverUrl is required/);
  });

  it("creates instance with serverUrl", () => {
    const e = new Augment({ name: "test", serverUrl: "https://example.com/mcp" });
    assert.equal(e.name, "test");
    assert.equal(e.serverUrl, "https://example.com/mcp");
  });

  it("detect returns platforms array", () => {
    const e = new Augment({ name: "test", serverUrl: "https://example.com/mcp" });
    const platforms = e.detect();
    assert.ok(Array.isArray(platforms));
  });

  it("buildConfig returns HTTP config", () => {
    const e = new Augment({ name: "test", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("claude-code", "key123");
    assert.equal(config.url, "https://example.com/mcp");
    assert.equal(config.headers.Authorization, "Bearer key123");
  });

  it("buildConfig returns VS Code config with type", () => {
    const e = new Augment({ name: "test", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("vscode", "key123");
    assert.equal(config.type, "http");
    assert.equal(config.url, "https://example.com/mcp");
  });

  it("buildConfig returns Windsurf config with serverUrl", () => {
    const e = new Augment({ name: "test", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("windsurf", "key123");
    assert.equal(config.serverUrl, "https://example.com/mcp");
    assert.ok(!config.url);
  });

  it("buildConfig returns stdio config", () => {
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      stdio: { command: "npx", args: ["-y", "test-mcp"], envKey: "TEST_KEY" },
    });
    const config = e.buildConfig("claude-code", "key123", "stdio");
    assert.ok(config.env.TEST_KEY === "key123");
  });

  it("installMcp and uninstallMcp roundtrip", () => {
    const e = new Augment({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform();
    cleanup(p.configPath);
    e.installMcp(p, "key123");
    const entry = e.readMcp(p);
    assert.ok(entry);
    assert.equal(entry.url, "https://example.com/mcp");

    e.uninstallMcp(p);
    assert.equal(e.readMcp(p), null);
    cleanup(p.configPath);
  });

  it("installRules and uninstallRules roundtrip", () => {
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      rules: { content: RULES_CONTENT, version: "1.0.0", marker: "test" },
    });
    const p = mockPlatform();
    cleanup(p.rulesPath);

    const r1 = e.installRules(p);
    assert.equal(r1.action, "created");
    const content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes("test:v1.0.0"));

    e.uninstallRules(p);
    assert.ok(!fs.existsSync(p.rulesPath) || !fs.readFileSync(p.rulesPath, "utf-8").includes("test:v"));
    cleanup(p.rulesPath);
  });

  it("installRules skips without rules config", () => {
    const e = new Augment({ name: "test", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform();
    const r = e.installRules(p);
    assert.equal(r.action, "skipped");
  });

  it("buildConfig uses http_headers for codex", () => {
    const e = new Augment({ name: "test", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("codex", "key123");
    assert.equal(config.url, "https://example.com/mcp");
    assert.equal(config.http_headers.Authorization, "Bearer key123");
    assert.ok(!config.headers);
  });

  it("buildConfig uses httpUrl for gemini-cli", () => {
    const e = new Augment({ name: "test", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("gemini-cli", "key123");
    assert.equal(config.httpUrl, "https://example.com/mcp");
    assert.equal(config.headers.Authorization, "Bearer key123");
  });

  it("buildConfig uses url and headers for junie", () => {
    const e = new Augment({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("junie", "key123");
    assert.equal(config.url, "https://example.com/mcp");
    assert.equal(config.headers.Authorization, "Bearer key123");
  });

  it("installMcp and readMcp roundtrip with TOML (Codex)", () => {
    const configPath = tmpPath("codex-equip") + ".toml";
    const e = new Augment({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform({ platform: "codex", configPath, rootKey: "mcp_servers", configFormat: "toml" });
    cleanup(configPath);
    e.installMcp(p, "key123");
    const entry = e.readMcp(p);
    assert.ok(entry);
    assert.equal(entry.url, "https://example.com/mcp");
    assert.equal(entry.http_headers.Authorization, "Bearer key123");
    e.uninstallMcp(p);
    assert.equal(e.readMcp(p), null);
    cleanup(configPath);
  });

  it("installMcp and readMcp roundtrip (Gemini CLI)", () => {
    const configPath = tmpPath("gemini-equip") + ".json";
    const e = new Augment({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform({ platform: "gemini-cli", configPath, rootKey: "mcpServers", configFormat: "json" });
    cleanup(configPath);
    e.installMcp(p, "key123");
    const entry = e.readMcp(p);
    assert.ok(entry);
    assert.equal(entry.httpUrl, "https://example.com/mcp");
    e.uninstallMcp(p);
    assert.equal(e.readMcp(p), null);
    cleanup(configPath);
  });

  it("installMcp and readMcp roundtrip (Junie)", () => {
    const configPath = tmpPath("junie-equip") + ".json";
    const e = new Augment({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform({ platform: "junie", configPath, rootKey: "mcpServers", configFormat: "json" });
    cleanup(configPath);
    e.installMcp(p, "key123");
    const entry = e.readMcp(p);
    assert.ok(entry);
    assert.equal(entry.url, "https://example.com/mcp");
    e.uninstallMcp(p);
    assert.equal(e.readMcp(p), null);
    cleanup(configPath);
  });

  it("installMcp and readMcp roundtrip (Copilot JetBrains)", () => {
    const dir = tmpPath("copilot-jb-equip");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "mcp.json");
    const e = new Augment({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform({ platform: "copilot-jetbrains", configPath, rootKey: "mcpServers", configFormat: "json" });
    e.installMcp(p, "key123");
    const entry = e.readMcp(p);
    assert.ok(entry);
    assert.equal(entry.url, "https://example.com/mcp");
    e.uninstallMcp(p);
    assert.equal(e.readMcp(p), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("installMcp and readMcp roundtrip (Copilot CLI)", () => {
    const dir = tmpPath("copilot-cli-equip");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "mcp-config.json");
    const e = new Augment({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform({ platform: "copilot-cli", configPath, rootKey: "mcpServers", configFormat: "json" });
    e.installMcp(p, "key123");
    const entry = e.readMcp(p);
    assert.ok(entry);
    assert.equal(entry.url, "https://example.com/mcp");
    e.uninstallMcp(p);
    assert.equal(e.readMcp(p), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─── HTTP Config (internal) ─────────────────────────────────

describe("buildHttpConfig", () => {
  it("returns url for standard platforms", () => {
    const c = buildHttpConfig("https://x.com/mcp", "cline");
    assert.equal(c.url, "https://x.com/mcp");
    assert.ok(!c.serverUrl);
    assert.ok(!c.type);
  });

  it("returns type:http for claude-code", () => {
    const c = buildHttpConfig("https://x.com/mcp", "claude-code");
    assert.equal(c.url, "https://x.com/mcp");
    assert.equal(c.type, "http");
  });

  it("returns serverUrl for windsurf", () => {
    const c = buildHttpConfig("https://x.com/mcp", "windsurf");
    assert.equal(c.serverUrl, "https://x.com/mcp");
    assert.ok(!c.url);
  });

  it("returns type + url for vscode", () => {
    const c = buildHttpConfig("https://x.com/mcp", "vscode");
    assert.equal(c.type, "http");
    assert.equal(c.url, "https://x.com/mcp");
  });

  it("returns httpUrl for gemini-cli", () => {
    const c = buildHttpConfig("https://x.com/mcp", "gemini-cli");
    assert.equal(c.httpUrl, "https://x.com/mcp");
    assert.ok(!c.url);
  });

  it("returns url for codex", () => {
    const c = buildHttpConfig("https://x.com/mcp", "codex");
    assert.equal(c.url, "https://x.com/mcp");
    assert.ok(!c.type);
  });
});

describe("buildHttpConfigWithAuth", () => {
  it("uses http_headers for codex", () => {
    const c = buildHttpConfigWithAuth("https://x.com/mcp", "ask_123", "codex");
    assert.equal(c.url, "https://x.com/mcp");
    assert.equal(c.http_headers.Authorization, "Bearer ask_123");
    assert.ok(!c.headers);
  });

  it("uses headers for gemini-cli", () => {
    const c = buildHttpConfigWithAuth("https://x.com/mcp", "ask_123", "gemini-cli");
    assert.equal(c.httpUrl, "https://x.com/mcp");
    assert.equal(c.headers.Authorization, "Bearer ask_123");
  });

  it("uses headers for junie", () => {
    const config = buildHttpConfigWithAuth("https://x.com/mcp", "key123", "junie");
    assert.equal(config.url, "https://x.com/mcp");
    assert.equal(config.headers.Authorization, "Bearer key123");
  });
});

// ─── MCP JSON (internal) ────────────────────────────────────

describe("installMcpJson", () => {
  it("creates config with correct server name", () => {
    const p = mockPlatform();
    cleanup(p.configPath);
    installMcpJson(p, "myserver", { url: "https://example.com" }, false);
    const data = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(data.mcpServers.myserver);
    assert.equal(data.mcpServers.myserver.url, "https://example.com");
    cleanup(p.configPath);
  });

  it("uses servers root key for vscode", () => {
    const p = mockPlatform({ platform: "vscode", rootKey: "servers" });
    cleanup(p.configPath);
    installMcpJson(p, "myserver", { type: "http", url: "https://example.com" }, false);
    const data = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(data.servers.myserver);
    assert.ok(!data.mcpServers);
    cleanup(p.configPath);
  });

  it("preserves existing entries", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.configPath, JSON.stringify({ mcpServers: { other: { url: "https://other.com" } } }));
    installMcpJson(p, "myserver", { url: "https://example.com" }, false);
    const data = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(data.mcpServers.myserver);
    assert.ok(data.mcpServers.other);
    cleanup(p.configPath);
  });
});

// ─── Rules (internal) ───────────────────────────────────────

describe("installRules (function)", () => {
  it("creates rules file", () => {
    const p = mockPlatform();
    cleanup(p.rulesPath);
    const r = installRules(p, { content: RULES_CONTENT, version: "1.0.0", marker: "test" });
    assert.equal(r.action, "created");
    assert.ok(fs.readFileSync(p.rulesPath, "utf-8").includes("test:v1.0.0"));
    cleanup(p.rulesPath);
  });

  it("uses fileName for standalone file", () => {
    const dir = tmpPath("rules-dir");
    const p = mockPlatform({ platform: "cline", rulesPath: dir });
    const r = installRules(p, { content: RULES_CONTENT, version: "1.0.0", marker: "test", fileName: "test.md" });
    assert.equal(r.action, "created");
    assert.ok(fs.readFileSync(path.join(dir, "test.md"), "utf-8").includes("test:v1.0.0"));
    cleanup(path.join(dir, "test.md"));
    try { fs.rmdirSync(dir); } catch {}
  });

  it("idempotent — skips if same version", () => {
    const p = mockPlatform();
    cleanup(p.rulesPath);
    installRules(p, { content: RULES_CONTENT, version: "1.0.0", marker: "test" });
    const r2 = installRules(p, { content: RULES_CONTENT, version: "1.0.0", marker: "test" });
    assert.equal(r2.action, "skipped");
    cleanup(p.rulesPath);
  });

  it("updates when version changes", () => {
    const p = mockPlatform();
    cleanup(p.rulesPath);
    installRules(p, { content: RULES_CONTENT, version: "1.0.0", marker: "test" });
    const newContent = RULES_CONTENT.replace("v1.0.0", "v2.0.0");
    const r2 = installRules(p, { content: newContent, version: "2.0.0", marker: "test" });
    assert.equal(r2.action, "updated");
    const final = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(final.includes("v2.0.0"));
    assert.ok(!final.includes("v1.0.0"));
    cleanup(p.rulesPath);
  });
});

describe("rules: multi-augment scenarios", () => {
  it("multiple augments coexist in same file", () => {
    const p = mockPlatform();
    cleanup(p.rulesPath);

    installRules(p, { content: "Rules for alpha", version: "1.0.0", marker: "alpha" });
    installRules(p, { content: "Rules for beta", version: "1.0.0", marker: "beta" });
    installRules(p, { content: "Rules for gamma", version: "2.0.0", marker: "gamma" });

    const content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes("alpha:v1.0.0"), "alpha present");
    assert.ok(content.includes("beta:v1.0.0"), "beta present");
    assert.ok(content.includes("gamma:v2.0.0"), "gamma present");
    assert.ok(content.includes("Rules for alpha"), "alpha content present");
    assert.ok(content.includes("Rules for beta"), "beta content present");
    assert.ok(content.includes("Rules for gamma"), "gamma content present");
    cleanup(p.rulesPath);
  });

  it("uninstall one augment preserves others", () => {
    const p = mockPlatform();
    cleanup(p.rulesPath);

    installRules(p, { content: "Rules for alpha", version: "1.0.0", marker: "alpha" });
    installRules(p, { content: "Rules for beta", version: "1.0.0", marker: "beta" });
    installRules(p, { content: "Rules for gamma", version: "1.0.0", marker: "gamma" });

    // Remove beta (middle one)
    uninstallRulesFn(p, { marker: "beta" });

    const content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes("alpha:v1.0.0"), "alpha preserved");
    assert.ok(content.includes("Rules for alpha"), "alpha content preserved");
    assert.ok(!content.includes("beta"), "beta fully removed");
    assert.ok(content.includes("gamma:v1.0.0"), "gamma preserved");
    assert.ok(content.includes("Rules for gamma"), "gamma content preserved");
    cleanup(p.rulesPath);
  });

  it("uninstall first augment preserves rest", () => {
    const p = mockPlatform();
    cleanup(p.rulesPath);

    installRules(p, { content: "Rules for alpha", version: "1.0.0", marker: "alpha" });
    installRules(p, { content: "Rules for beta", version: "1.0.0", marker: "beta" });

    uninstallRulesFn(p, { marker: "alpha" });

    const content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(!content.includes("alpha"), "alpha removed");
    assert.ok(content.includes("beta:v1.0.0"), "beta preserved");
    assert.ok(content.includes("Rules for beta"), "beta content preserved");
    cleanup(p.rulesPath);
  });

  it("uninstall last augment removes file", () => {
    const p = mockPlatform();
    cleanup(p.rulesPath);

    installRules(p, { content: "Rules for alpha", version: "1.0.0", marker: "alpha" });
    uninstallRulesFn(p, { marker: "alpha" });

    // File should be deleted when empty
    assert.ok(!fs.existsSync(p.rulesPath) || fs.readFileSync(p.rulesPath, "utf-8").trim() === "", "file removed or empty");
    cleanup(p.rulesPath);
  });

  it("existing user content is preserved through install and uninstall", () => {
    const p = mockPlatform();
    const userContent = "# My Custom Rules\n\nAlways write tests.\nNever skip error handling.\n";
    fs.writeFileSync(p.rulesPath, userContent);

    // Install an augment
    installRules(p, { content: "Augment rules here", version: "1.0.0", marker: "my-augment" });

    let content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes("My Custom Rules"), "user content preserved after install");
    assert.ok(content.includes("Always write tests"), "user content preserved after install");
    assert.ok(content.includes("my-augment:v1.0.0"), "augment installed");

    // Uninstall the augment
    uninstallRulesFn(p, { marker: "my-augment" });

    content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes("My Custom Rules"), "user content preserved after uninstall");
    assert.ok(content.includes("Always write tests"), "user content preserved after uninstall");
    assert.ok(!content.includes("my-augment"), "augment fully removed");
    assert.ok(!content.includes("Augment rules here"), "augment content removed");
    cleanup(p.rulesPath);
  });

  it("install/uninstall order independence with three augments", () => {
    const p = mockPlatform();
    cleanup(p.rulesPath);

    // Install A, B, C
    installRules(p, { content: "Alpha content", version: "1.0.0", marker: "alpha" });
    installRules(p, { content: "Beta content", version: "1.0.0", marker: "beta" });
    installRules(p, { content: "Gamma content", version: "1.0.0", marker: "gamma" });

    // Uninstall B (middle)
    uninstallRulesFn(p, { marker: "beta" });
    let content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes("Alpha content"), "A intact after removing B");
    assert.ok(content.includes("Gamma content"), "C intact after removing B");

    // Uninstall A (now first)
    uninstallRulesFn(p, { marker: "alpha" });
    content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes("Gamma content"), "C intact after removing A");
    assert.ok(!content.includes("Alpha"), "A removed");

    // Uninstall C (last remaining)
    uninstallRulesFn(p, { marker: "gamma" });
    assert.ok(!fs.existsSync(p.rulesPath) || fs.readFileSync(p.rulesPath, "utf-8").trim() === "", "file cleaned up");
    cleanup(p.rulesPath);
  });

  it("no excessive blank lines after uninstall", () => {
    const p = mockPlatform();
    cleanup(p.rulesPath);

    installRules(p, { content: "Alpha content", version: "1.0.0", marker: "alpha" });
    installRules(p, { content: "Beta content", version: "1.0.0", marker: "beta" });

    uninstallRulesFn(p, { marker: "alpha" });

    const content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(!content.includes("\n\n\n"), "no triple newlines after uninstall");
    cleanup(p.rulesPath);
  });
});

describe("wrapRulesContent and stripRulesMarkers", () => {
  it("wraps raw content in markers", () => {
    const raw = "Always write tests.";
    const wrapped = wrapRulesContent(raw, "my-tool", "1.0.0");
    assert.ok(wrapped.startsWith("<!-- my-tool:v1.0.0 -->"));
    assert.ok(wrapped.includes("Always write tests."));
    assert.ok(wrapped.endsWith("<!-- /my-tool -->"));
  });

  it("does not double-wrap already-wrapped content", () => {
    const already = "<!-- my-tool:v1.0.0 -->\nContent\n<!-- /my-tool -->";
    const result = wrapRulesContent(already, "my-tool", "1.0.0");
    assert.equal(result, already, "should return unchanged");
  });

  it("stripRulesMarkers extracts raw content", () => {
    const wrapped = "<!-- test:v1.0.0 -->\nTalk like a pirate\n<!-- /test -->";
    const stripped = stripRulesMarkers(wrapped);
    assert.equal(stripped, "Talk like a pirate");
  });

  it("stripRulesMarkers handles multiline content", () => {
    const wrapped = "<!-- test:v2.0.0 -->\n# Rules\n\nDo this.\nDo that.\n<!-- /test -->";
    const stripped = stripRulesMarkers(wrapped);
    assert.equal(stripped, "# Rules\n\nDo this.\nDo that.");
  });

  it("stripRulesMarkers returns raw content unchanged if no markers", () => {
    const raw = "Just some content";
    assert.equal(stripRulesMarkers(raw), raw);
  });

  it("installRules auto-wraps raw content", () => {
    const p = mockPlatform();
    cleanup(p.rulesPath);

    // Pass raw content WITHOUT markers
    installRules(p, { content: "Be helpful and concise", version: "1.0.0", marker: "my-aug" });

    const content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes("<!-- my-aug:v1.0.0 -->"), "auto-wrapped with opening marker");
    assert.ok(content.includes("Be helpful and concise"), "content present");
    assert.ok(content.includes("<!-- /my-aug -->"), "auto-wrapped with closing marker");

    // And it should be uninstallable
    uninstallRulesFn(p, { marker: "my-aug" });
    assert.ok(!fs.existsSync(p.rulesPath) || !fs.readFileSync(p.rulesPath, "utf-8").includes("my-aug"), "cleanly uninstalled");
    cleanup(p.rulesPath);
  });

  it("auto-wrap + manual wrap roundtrip with existing content", () => {
    const p = mockPlatform();
    const userContent = "# My Rules\n\nBe excellent.\n";
    fs.writeFileSync(p.rulesPath, userContent);

    // Install with raw (unwrapped) content
    installRules(p, { content: "Talk like a pirate", version: "1.0.0", marker: "pirate" });

    let content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes("My Rules"), "user content preserved");
    assert.ok(content.includes("pirate:v1.0.0"), "markers added");

    // Uninstall
    uninstallRulesFn(p, { marker: "pirate" });
    content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes("My Rules"), "user content still preserved");
    assert.ok(content.includes("Be excellent"), "user content intact");
    assert.ok(!content.includes("pirate"), "augment fully removed");
    assert.ok(!content.includes("Talk like"), "augment content removed");
    cleanup(p.rulesPath);
  });
});

// ─── Platforms ───────────────────────────────────────────────

describe("platformName", () => {
  it("returns display names", () => {
    assert.equal(platformName("claude-code"), "Claude Code");
    assert.equal(platformName("vscode"), "VS Code");
    assert.equal(platformName("roo-code"), "Roo Code");
    assert.equal(platformName("codex"), "Codex");
    assert.equal(platformName("gemini-cli"), "Gemini CLI");
    assert.equal(platformName("junie"), "Junie");
    assert.equal(platformName("copilot-jetbrains"), "Copilot (JetBrains)");
    assert.equal(platformName("copilot-cli"), "Copilot CLI");
    assert.equal(platformName("unknown"), "unknown");
  });
});

describe("KNOWN_PLATFORMS", () => {
  it("includes expected platforms", () => {
    assert.ok(KNOWN_PLATFORMS.length >= 13, `should have at least 13 platforms, got ${KNOWN_PLATFORMS.length}`);
    assert.ok(KNOWN_PLATFORMS.includes("claude-code"));
    assert.ok(KNOWN_PLATFORMS.includes("cursor"));
    assert.ok(KNOWN_PLATFORMS.includes("vscode"));
    assert.ok(KNOWN_PLATFORMS.includes("cline"));
    assert.ok(KNOWN_PLATFORMS.includes("roo-code"));
    assert.ok(KNOWN_PLATFORMS.includes("codex"));
    assert.ok(KNOWN_PLATFORMS.includes("gemini-cli"));
    assert.ok(KNOWN_PLATFORMS.includes("junie"));
    assert.ok(KNOWN_PLATFORMS.includes("copilot-jetbrains"));
    assert.ok(KNOWN_PLATFORMS.includes("copilot-cli"));
    assert.ok(KNOWN_PLATFORMS.includes("amazon-q"));
    assert.ok(KNOWN_PLATFORMS.includes("tabnine"));
  });
});

describe("createManualPlatform", () => {
  it("throws for unknown platform", () => {
    assert.throws(() => createManualPlatform("unknown"), /Unknown platform/);
  });

  it("returns correct config for each platform", () => {
    for (const id of KNOWN_PLATFORMS) {
      const p = createManualPlatform(id);
      assert.equal(p.platform, id);
      assert.ok(p.configPath);
      assert.ok(p.rootKey);
    }
  });
});

// ─── Marker Patterns ────────────────────────────────────────

describe("markerPatterns", () => {
  it("creates correct regex for custom marker", () => {
    const { MARKER_RE, BLOCK_RE } = markerPatterns("myapp");
    assert.ok(MARKER_RE.test("<!-- myapp:v1.0.0 -->"));
    assert.ok(!MARKER_RE.test("<!-- other:v1.0.0 -->"));
  });
});

describe("parseRulesVersion", () => {
  it("parses version from marker", () => {
    assert.equal(parseRulesVersion("<!-- test:v1.2.3 -->", "test"), "1.2.3");
    assert.equal(parseRulesVersion("no marker here", "test"), null);
  });
});

// ─── TOML Helpers (internal) ────────────────────────────────

describe("parseTomlServerEntry", () => {
  it("parses a server entry", () => {
    const toml = `[mcp_servers.prior]\nurl = "https://api.cg3.io/mcp"\nenabled = true\n`;
    const entry = parseTomlServerEntry(toml, "mcp_servers", "prior");
    assert.equal(entry.url, "https://api.cg3.io/mcp");
    assert.equal(entry.enabled, true);
  });

  it("returns null for missing server", () => {
    const toml = `[mcp_servers.other]\nurl = "https://example.com"\n`;
    assert.equal(parseTomlServerEntry(toml, "mcp_servers", "prior"), null);
  });

  it("handles multiple tables", () => {
    const toml = `[mcp_servers.first]\nurl = "https://first.com"\n\n[mcp_servers.second]\nurl = "https://second.com"\n`;
    const first = parseTomlServerEntry(toml, "mcp_servers", "first");
    const second = parseTomlServerEntry(toml, "mcp_servers", "second");
    assert.equal(first.url, "https://first.com");
    assert.equal(second.url, "https://second.com");
  });

  it("parses numbers and booleans", () => {
    const toml = `[mcp_servers.test]\nurl = "https://x.com"\ntimeout = 30\nenabled = false\n`;
    const entry = parseTomlServerEntry(toml, "mcp_servers", "test");
    assert.equal(entry.timeout, 30);
    assert.equal(entry.enabled, false);
  });
});

describe("parseTomlSubTables", () => {
  it("parses sub-tables like env and http_headers", () => {
    const toml = `[mcp_servers.prior]\nurl = "https://api.cg3.io/mcp"\n\n[mcp_servers.prior.http_headers]\nAuthorization = "Bearer ask_123"\n\n[mcp_servers.prior.env]\nDEBUG = "true"\n`;
    const subs = parseTomlSubTables(toml, "mcp_servers", "prior");
    assert.equal(subs.http_headers.Authorization, "Bearer ask_123");
    assert.equal(subs.env.DEBUG, "true");
  });
});

describe("buildTomlEntry", () => {
  it("builds valid TOML for HTTP server", () => {
    const toml = buildTomlEntry("mcp_servers", "prior", { url: "https://api.cg3.io/mcp", http_headers: { Authorization: "Bearer key" } });
    assert.ok(toml.includes("[mcp_servers.prior]"));
    assert.ok(toml.includes('url = "https://api.cg3.io/mcp"'));
    assert.ok(toml.includes("[mcp_servers.prior.http_headers]"));
    assert.ok(toml.includes('Authorization = "Bearer key"'));
  });

  it("handles boolean and number values", () => {
    const toml = buildTomlEntry("mcp_servers", "test", { url: "https://x.com", enabled: true, startup_timeout_sec: 15 });
    assert.ok(toml.includes("enabled = true"));
    assert.ok(toml.includes("startup_timeout_sec = 15"));
  });
});

describe("removeTomlEntry", () => {
  it("removes entry and sub-tables", () => {
    const toml = `[other]\nfoo = "bar"\n\n[mcp_servers.prior]\nurl = "https://api.cg3.io/mcp"\n\n[mcp_servers.prior.http_headers]\nAuthorization = "Bearer key"\n\n[mcp_servers.second]\nurl = "https://second.com"\n`;
    const result = removeTomlEntry(toml, "mcp_servers", "prior");
    assert.ok(!result.includes("[mcp_servers.prior]"));
    assert.ok(!result.includes("api.cg3.io"));
    assert.ok(result.includes("[mcp_servers.second]"));
    assert.ok(result.includes("[other]"));
  });

  it("handles entry at end of file", () => {
    const toml = `[other]\nfoo = "bar"\n\n[mcp_servers.prior]\nurl = "https://api.cg3.io/mcp"\n`;
    const result = removeTomlEntry(toml, "mcp_servers", "prior");
    assert.ok(!result.includes("[mcp_servers.prior]"));
    assert.ok(result.includes("[other]"));
  });
});

// ─── TOML Install/Uninstall (internal) ──────────────────────

describe("installMcpToml", () => {
  it("creates TOML config file", () => {
    const configPath = tmpPath("codex-config") + ".toml";
    const p = mockPlatform({ platform: "codex", configPath, rootKey: "mcp_servers", configFormat: "toml" });
    cleanup(configPath);
    installMcpToml(p, "prior", { url: "https://api.cg3.io/mcp", http_headers: { Authorization: "Bearer key" } }, false);
    const content = fs.readFileSync(configPath, "utf-8");
    assert.ok(content.includes("[mcp_servers.prior]"));
    assert.ok(content.includes('url = "https://api.cg3.io/mcp"'));
    assert.ok(content.includes("[mcp_servers.prior.http_headers]"));
    cleanup(configPath);
  });

  it("preserves existing TOML content", () => {
    const configPath = tmpPath("codex-config") + ".toml";
    fs.writeFileSync(configPath, '[mcp_servers.existing]\nurl = "https://example.com"\n');
    const p = mockPlatform({ platform: "codex", configPath, rootKey: "mcp_servers", configFormat: "toml" });
    installMcpToml(p, "prior", { url: "https://api.cg3.io/mcp" }, false);
    const content = fs.readFileSync(configPath, "utf-8");
    assert.ok(content.includes("[mcp_servers.existing]"));
    assert.ok(content.includes("[mcp_servers.prior]"));
    cleanup(configPath);
  });

  it("replaces existing entry on re-install", () => {
    const configPath = tmpPath("codex-config") + ".toml";
    const p = mockPlatform({ platform: "codex", configPath, rootKey: "mcp_servers", configFormat: "toml" });
    cleanup(configPath);
    installMcpToml(p, "prior", { url: "https://old.com" }, false);
    installMcpToml(p, "prior", { url: "https://new.com" }, false);
    const content = fs.readFileSync(configPath, "utf-8");
    assert.ok(content.includes("https://new.com"));
    assert.ok(!content.includes("https://old.com"));
    const count = (content.match(/\[mcp_servers\.prior\]/g) || []).length;
    assert.equal(count, 1);
    cleanup(configPath);
  });
});

describe("Codex uninstallMcp (TOML)", () => {
  it("removes entry from TOML", () => {
    const configPath = tmpPath("codex-config") + ".toml";
    fs.writeFileSync(configPath, '[mcp_servers.prior]\nurl = "https://api.cg3.io/mcp"\n\n[mcp_servers.other]\nurl = "https://other.com"\n');
    const p = mockPlatform({ platform: "codex", configPath, rootKey: "mcp_servers", configFormat: "toml" });
    const removed = uninstallMcp(p, "prior", false);
    assert.ok(removed);
    const content = fs.readFileSync(configPath, "utf-8");
    assert.ok(!content.includes("[mcp_servers.prior]"));
    assert.ok(content.includes("[mcp_servers.other]"));
    cleanup(configPath);
  });
});

// ─── CLI Dispatcher ─────────────────────────────────────────

describe("equip CLI", () => {
  it("shows help with --help", () => {
    const { execSync } = require("child_process");
    const out = execSync("node bin/equip.js --help", { encoding: "utf-8", cwd: path.join(__dirname, "..") });
    assert.ok(out.includes("Commands:"));
    assert.ok(out.includes("status"));
    assert.ok(out.includes("doctor"));
    assert.ok(out.includes("update"));
    assert.ok(out.includes("--verbose"));
  });

  it("shows version", () => {
    const { execSync } = require("child_process");
    const out = execSync("node bin/equip.js --version", { encoding: "utf-8", cwd: path.join(__dirname, "..") });
    assert.ok(out.includes("equip v"));
  });

  it("unregistered package defaults command to setup", () => {
    const { execSync } = require("child_process");
    // equip nonexistent-pkg-xyz → tries npx -y nonexistent-pkg-xyz@latest setup
    // This fails with a 404 since the package doesn't exist, which is expected.
    try {
      execSync("node bin/equip.js nonexistent-pkg-xyz-12345", { encoding: "utf-8", cwd: path.join(__dirname, ".."), stdio: "pipe", timeout: 15000 });
    } catch (e) {
      // Should fail with npm 404, NOT with "Unknown command"
      assert.ok(!e.stderr.includes("Unknown command"), "should attempt npx dispatch, not error on missing command");
    }
  });

  it("help shows all dispatch paths", () => {
    const { execSync } = require("child_process");
    const out = execSync("node bin/equip.js --help", { encoding: "utf-8", cwd: path.join(__dirname, "..") });
    assert.ok(out.includes("<augment>"), "should show augment install path");
    assert.ok(out.includes("./script.js"), "should show local script path");
    assert.ok(out.includes("uninstall"), "should show uninstall command");
    assert.ok(out.includes("--api-key"), "should show api-key option");
  });

  it("default command (no args) runs status without error", () => {
    const { execSync } = require("child_process");
    // Running with no args should show status, not error.
    // Status and the help hint both write to stderr.
    // Just verify the process exits cleanly (exit code 0).
    execSync("node bin/equip.js", { encoding: "utf-8", cwd: path.join(__dirname, ".."), timeout: 15000 });
  });

  it("local script path detection", () => {
    // Verify isLocalPath logic by checking which args trigger local dispatch
    const { execSync } = require("child_process");

    // ./script.js should be treated as local (will fail — file doesn't exist — but NOT as unknown command)
    try {
      execSync("node bin/equip.js ./nonexistent.js", { encoding: "utf-8", cwd: path.join(__dirname, ".."), stdio: "pipe", timeout: 5000 });
    } catch (e) {
      assert.ok(e.stderr.includes("Script not found") || e.stderr.includes("not found"), "should try local dispatch, not npm");
    }
  });

  it("status runs without error", () => {
    const { execSync } = require("child_process");
    // status writes to stderr (cli.log uses stderr), capture both
    const out = execSync("node bin/equip.js status", { encoding: "utf-8", cwd: path.join(__dirname, ".."), timeout: 15000 });
    // status outputs to stderr via cli.log, stdout may be empty — just verify no crash
  });

});

// ─── State Module (REMOVED — covered by platform-state.test.js + installations tests) ───

// ─── Atomic Write ───────────────────────────────────────────

describe("atomicWriteFileSync", () => {
  it("writes file that is readable", () => {
    const p = tmpPath("atomic") + ".json";
    atomicWriteFileSync(p, '{"hello":"world"}\n');
    assert.equal(fs.readFileSync(p, "utf-8"), '{"hello":"world"}\n');
    cleanup(p);
  });

  it("creates parent directories", () => {
    const dir = tmpPath("atomic-dir");
    const p = path.join(dir, "sub", "file.json");
    atomicWriteFileSync(p, "test\n");
    assert.equal(fs.readFileSync(p, "utf-8"), "test\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("overwrites existing file atomically", () => {
    const p = tmpPath("atomic") + ".json";
    fs.writeFileSync(p, "original");
    atomicWriteFileSync(p, "replaced");
    assert.equal(fs.readFileSync(p, "utf-8"), "replaced");
    // No .tmp file should remain
    assert.ok(!fs.existsSync(p + ".tmp"), ".tmp file should be cleaned up");
    cleanup(p);
  });
});

// ─── Safe JSON Read ─────────────────────────────────────────

describe("safeReadJsonSync", () => {
  it("returns ok for valid JSON", () => {
    const p = tmpPath("safe-json") + ".json";
    fs.writeFileSync(p, '{"mcpServers":{"prior":{"url":"https://example.com"}}}');
    const result = safeReadJsonSync(p);
    assert.equal(result.status, "ok");
    assert.ok(result.data);
    assert.ok(result.data.mcpServers);
    cleanup(p);
  });

  it("returns missing for nonexistent file", () => {
    const result = safeReadJsonSync("/tmp/does-not-exist-" + Date.now() + ".json");
    assert.equal(result.status, "missing");
    assert.equal(result.data, null);
  });

  it("returns corrupt for invalid JSON", () => {
    const p = tmpPath("corrupt-json") + ".json";
    fs.writeFileSync(p, "this is not json {{{");
    const result = safeReadJsonSync(p);
    assert.equal(result.status, "corrupt");
    assert.equal(result.data, null);
    assert.ok(result.error);
    assert.ok(result.error.includes("Invalid JSON"));
    cleanup(p);
  });

  it("returns corrupt for non-object JSON", () => {
    const p = tmpPath("non-obj") + ".json";
    fs.writeFileSync(p, '"just a string"');
    const result = safeReadJsonSync(p);
    assert.equal(result.status, "corrupt");
    assert.ok(result.error.includes("not an object"));
    cleanup(p);
  });

  it("handles BOM-prefixed files", () => {
    const p = tmpPath("bom-json") + ".json";
    fs.writeFileSync(p, "\uFEFF" + '{"key":"value"}');
    const result = safeReadJsonSync(p);
    assert.equal(result.status, "ok");
    assert.equal(result.data.key, "value");
    cleanup(p);
  });
});

// ─── Corrupt Config Detection ───────────────────────────────

describe("installMcpJson with corrupt config", () => {
  it("returns error result on corrupt existing config instead of silently overwriting", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.configPath, "this is corrupt json {{{");
    const result = installMcpJson(p, "myserver", { url: "https://example.com" }, false);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, "CONFIG_CORRUPT");
    assert.ok(result.error.includes("Invalid JSON"));
    // Verify the corrupt file was NOT overwritten
    assert.equal(fs.readFileSync(p.configPath, "utf-8"), "this is corrupt json {{{");
    cleanup(p.configPath);
  });

  it("starts fresh when config file doesn't exist (not corrupt)", () => {
    const p = mockPlatform();
    cleanup(p.configPath);
    // Should succeed — missing file is fine, corrupt is not
    const result = installMcpJson(p, "myserver", { url: "https://example.com" }, false);
    assert.ok(result.success);
    const data = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.equal(data.mcpServers.myserver.url, "https://example.com");
    cleanup(p.configPath);
  });
});

// ─── Backup Cleanup ────────────────────────────────────────

describe("backup lifecycle", () => {
  it("createBackup creates .bak file", () => {
    const p = tmpPath("bak-test") + ".json";
    fs.writeFileSync(p, '{"original":true}');
    const created = createBackup(p);
    assert.ok(created);
    assert.ok(fs.existsSync(p + ".bak"));
    assert.equal(fs.readFileSync(p + ".bak", "utf-8"), '{"original":true}');
    cleanup(p);
  });

  it("cleanupBackup removes .bak file", () => {
    const p = tmpPath("bak-cleanup") + ".json";
    fs.writeFileSync(p, "content");
    fs.writeFileSync(p + ".bak", "backup");
    cleanupBackup(p);
    assert.ok(!fs.existsSync(p + ".bak"));
    cleanup(p);
  });

  it("installMcpJson does not leave .bak after success", () => {
    const p = mockPlatform();
    // Create initial config so backup is created
    fs.writeFileSync(p.configPath, '{"mcpServers":{"other":{"url":"https://other.com"}}}');
    installMcpJson(p, "myserver", { url: "https://example.com" }, false);
    // .bak should be cleaned up
    assert.ok(!fs.existsSync(p.configPath + ".bak"), ".bak should not exist after successful write");
    // Original data should be preserved
    const data = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(data.mcpServers.other, "other server should be preserved");
    assert.ok(data.mcpServers.myserver, "new server should be present");
    cleanup(p.configPath);
  });

  it("installMcpToml does not leave .bak after success", () => {
    const configPath = tmpPath("toml-bak") + ".toml";
    const p = mockPlatform({ platform: "codex", configPath, rootKey: "mcp_servers", configFormat: "toml" });
    fs.writeFileSync(configPath, '[mcp_servers.existing]\nurl = "https://example.com"\n');
    installMcpToml(p, "prior", { url: "https://api.cg3.io/mcp" }, false);
    assert.ok(!fs.existsSync(configPath + ".bak"), ".bak should not exist after successful write");
    cleanup(configPath);
  });

  it("uninstallMcp does not leave .bak after success", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.configPath, JSON.stringify({ mcpServers: { prior: { url: "x" }, other: { url: "y" } } }));
    uninstallMcp(p, "prior", false);
    assert.ok(!fs.existsSync(p.configPath + ".bak"), ".bak should not exist after successful uninstall");
    cleanup(p.configPath);
  });
});

// ─── Package Version Resolution ─────────────────────────────

describe("resolvePackageVersion", () => {
  it("finds equip version from dist/lib directory", () => {
    const distLib = path.join(__dirname, "..", "dist", "lib");
    const version = resolvePackageVersion(distLib);
    assert.match(version, /^\d+\.\d+\.\d+/);
  });

  it("returns unknown for unresolvable directory", () => {
    const version = resolvePackageVersion("/tmp");
    assert.equal(version, "unknown");
  });
});

// ─── Verify Method ──────────────────────────────────────────

describe("Augment.verify()", () => {
  it("returns ok when MCP is installed", () => {
    const e = new Augment({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform();
    cleanup(p.configPath);
    e.installMcp(p, "key123");
    const result = e.verify(p);
    assert.ok(result.ok);
    assert.equal(result.checks.find(c => c.name === "mcp").ok, true);
    cleanup(p.configPath);
  });

  it("returns not ok when MCP is missing", () => {
    const e = new Augment({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform();
    cleanup(p.configPath);
    // Don't install — verify should fail
    const result = e.verify(p);
    assert.ok(!result.ok);
    assert.equal(result.checks.find(c => c.name === "mcp").ok, false);
  });

  it("checks rules when configured", () => {
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      rules: { content: "<!-- test:v1.0.0 -->\nTest\n<!-- /test -->", version: "1.0.0", marker: "test" },
    });
    const p = mockPlatform();
    cleanup(p.configPath, p.rulesPath);
    e.installMcp(p, "key123");
    e.installRules(p);
    const result = e.verify(p);
    assert.ok(result.ok);
    const rulesCheck = result.checks.find(c => c.name === "rules");
    assert.ok(rulesCheck);
    assert.ok(rulesCheck.ok);
    assert.ok(rulesCheck.detail.includes("v1.0.0"));
    cleanup(p.configPath, p.rulesPath);
  });

  it("detects rules version mismatch", () => {
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      rules: { content: "<!-- test:v2.0.0 -->\nTest\n<!-- /test -->", version: "2.0.0", marker: "test" },
    });
    const p = mockPlatform();
    cleanup(p.configPath, p.rulesPath);
    e.installMcp(p, "key123");
    // Write an older version of rules
    fs.writeFileSync(p.rulesPath, "<!-- test:v1.0.0 -->\nOld\n<!-- /test -->\n");
    const result = e.verify(p);
    assert.ok(!result.ok);
    const rulesCheck = result.checks.find(c => c.name === "rules");
    assert.ok(!rulesCheck.ok);
    assert.ok(rulesCheck.detail.includes("mismatch"));
    cleanup(p.configPath, p.rulesPath);
  });

  it("returns structured result with platform id", () => {
    const e = new Augment({ name: "test", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform({ platform: "cursor" });
    const result = e.verify(p);
    assert.equal(result.platform, "cursor");
    assert.ok(Array.isArray(result.checks));
  });
});

// ─── Reconcile State ────────────────────────────────────────

describe("reconcileState", () => {
  it("finds installed tools across platforms", () => {
    // Set up a mock config file with a tool entry
    const p = mockPlatform();
    fs.writeFileSync(p.configPath, JSON.stringify({ mcpServers: { "test-reconcile": { url: "https://example.com" } } }));

    // Reconcile won't find it because it scans real platform paths, not tmp paths
    // This test verifies the function runs without error and returns a count
    const count = reconcileState({
      toolName: "test-reconcile",
      package: "@test/pkg",
      marker: "test-reconcile",
    });
    assert.equal(typeof count, "number");

    // Clean up any state artifacts
    trackUninstallation("test-reconcile");
    cleanup(p.configPath);
  });

  it("accepts custom marker and hookDir", () => {
    // Verify the function accepts options without throwing
    const count = reconcileState({
      toolName: "nonexistent-tool",
      package: "@test/pkg",
      marker: "custom-marker",
      hookDir: "/tmp/custom-hooks",
    });
    assert.equal(count, 0); // tool not installed anywhere
  });

  it("uses toolName as default marker", () => {
    const count = reconcileState({
      toolName: "nonexistent",
      package: "@test/pkg",
      // no marker — should default to toolName
    });
    assert.equal(count, 0);
  });
});

// ─── equipVersionAtInstall ──────────────────────────────────

// ─── equipVersionAtInstall (REMOVED — version tracking is in equip-meta now) ───

// ─── Hooks Subsystem ────────────────────────────────────────

describe("getHookCapabilities", () => {
  it("returns capabilities for claude-code", () => {
    const caps = getHookCapabilities("claude-code");
    assert.ok(caps);
    assert.equal(caps.format, "claude-code");
    assert.ok(Array.isArray(caps.events));
    assert.ok(caps.events.includes("PostToolUse"));
    assert.ok(caps.events.includes("Stop"));
    assert.ok(typeof caps.settingsPath === "function");
  });

  it("returns null for platforms without hooks", () => {
    assert.equal(getHookCapabilities("cursor"), null);
    assert.equal(getHookCapabilities("vscode"), null);
    assert.equal(getHookCapabilities("codex"), null);
    assert.equal(getHookCapabilities("nonexistent"), null);
  });
});

describe("buildHooksConfig", () => {
  const hookDefs = [
    { event: "PostToolUse", matcher: "Bash", script: "console.log('hi')", name: "test-hook" },
    { event: "Stop", script: "console.log('bye')", name: "stop-hook" },
  ];

  it("builds claude-code format config", () => {
    const hookDir = "/tmp/hooks";
    const config = buildHooksConfig(hookDefs, hookDir, "claude-code");
    assert.ok(config);
    assert.ok(config.PostToolUse);
    assert.ok(config.Stop);
    assert.equal(config.PostToolUse.length, 1);
    assert.equal(config.PostToolUse[0].matcher, "Bash");
    assert.ok(config.PostToolUse[0].hooks[0].command.includes("test-hook.js"));
  });

  it("filters out unsupported events", () => {
    const defs = [{ event: "FakeEvent", script: "x", name: "fake" }];
    const config = buildHooksConfig(defs, "/tmp", "claude-code");
    assert.equal(config, null);
  });

  it("returns null for platforms without hooks", () => {
    assert.equal(buildHooksConfig(hookDefs, "/tmp", "cursor"), null);
  });

  it("returns null for empty hook defs", () => {
    assert.equal(buildHooksConfig([], "/tmp", "claude-code"), null);
  });
});

describe("installHooks / uninstallHooks / hasHooks", () => {
  const hookDefs = [
    { event: "PostToolUse", script: "// test hook\nconsole.log('hook ran');", name: "test-hook" },
  ];

  it("installs hook scripts and registers in settings", () => {
    const hookDir = tmpPath("hooks-install");

    const p = mockPlatform({ platform: "claude-code" });

    const result = installHooks(p, hookDefs, { hookDir });
    assert.ok(result.success);
    assert.equal(result.attempted, true);
    assert.deepEqual(result.scripts, ["test-hook.js"]);
    assert.equal(result.hookDir, hookDir);

    // Verify script was written
    const scriptPath = path.join(hookDir, "test-hook.js");
    assert.ok(fs.existsSync(scriptPath));
    assert.ok(fs.readFileSync(scriptPath, "utf-8").includes("hook ran"));

    // IMPORTANT: uninstall hooks from real settings.json to avoid polluting
    // the user's Claude Code config. installHooks writes to the real
    // ~/.claude/settings.json because the platform registry returns it.
    uninstallHooks(p, hookDefs, { hookDir });
    fs.rmSync(hookDir, { recursive: true, force: true });
  });

  it("returns skipped for platforms without hook support", () => {
    const p = mockPlatform({ platform: "cursor" });
    const result = installHooks(p, hookDefs, { hookDir: "/tmp/hooks" });
    assert.equal(result.attempted, false);
    assert.equal(result.action, "skipped");
  });

  it("returns skipped with empty hook defs", () => {
    const p = mockPlatform({ platform: "claude-code" });
    const result = installHooks(p, [], { hookDir: "/tmp/hooks" });
    assert.equal(result.attempted, false);
    assert.equal(result.action, "skipped");
  });

  it("uninstallHooks removes scripts", () => {
    const hookDir = tmpPath("hooks-uninstall");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, "test-hook.js"), "// hook");

    const p = mockPlatform({ platform: "claude-code" });
    const removed = uninstallHooks(p, hookDefs, { hookDir });
    assert.ok(removed);
    assert.ok(!fs.existsSync(path.join(hookDir, "test-hook.js")));
  });

  it("uninstallHooks returns false for unsupported platform", () => {
    const p = mockPlatform({ platform: "cursor" });
    assert.equal(uninstallHooks(p, hookDefs, { hookDir: "/tmp" }), false);
  });
});

// ─── buildStdioConfig ───────────────────────────────────────

describe("buildStdioConfig", () => {
  it("builds stdio config with command and args", () => {
    const config = buildStdioConfig("npx", ["-y", "my-tool"], { API_KEY: "secret" });
    if (process.platform === "win32") {
      assert.equal(config.command, "cmd");
      assert.ok(config.args.includes("/c"));
      assert.ok(config.args.includes("npx"));
    } else {
      assert.equal(config.command, "npx");
      assert.deepEqual(config.args, ["-y", "my-tool"]);
    }
    assert.equal(config.env.API_KEY, "secret");
  });
});

// ─── updateMcpKey ───────────────────────────────────────────

describe("Augment.updateMcpKey()", () => {
  it("updates API key in existing JSON config", () => {
    const e = new Augment({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform();
    cleanup(p.configPath);
    e.installMcp(p, "old-key");
    let entry = e.readMcp(p);
    assert.equal(entry.headers.Authorization, "Bearer old-key");

    e.updateMcpKey(p, "new-key");
    entry = e.readMcp(p);
    assert.equal(entry.headers.Authorization, "Bearer new-key");
    cleanup(p.configPath);
  });

  it("updates API key in TOML config", () => {
    const configPath = tmpPath("toml-rekey") + ".toml";
    const e = new Augment({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform({ platform: "codex", configPath, rootKey: "mcp_servers", configFormat: "toml" });
    cleanup(configPath);
    e.installMcp(p, "old-key");
    e.updateMcpKey(p, "new-key");
    const entry = e.readMcp(p);
    assert.equal(entry.http_headers.Authorization, "Bearer new-key");
    cleanup(configPath);
  });
});

// ─── resolvePlatformId ──────────────────────────────────────

describe("resolvePlatformId", () => {
  const { resolvePlatformId } = require("..");

  it("resolves exact platform IDs", () => {
    assert.equal(resolvePlatformId("claude-code"), "claude-code");
    assert.equal(resolvePlatformId("cursor"), "cursor");
    assert.equal(resolvePlatformId("codex"), "codex");
  });

  it("resolves aliases", () => {
    assert.equal(resolvePlatformId("claude"), "claude-code");
    assert.equal(resolvePlatformId("claudecode"), "claude-code");
    assert.equal(resolvePlatformId("roo"), "roo-code");
    assert.equal(resolvePlatformId("roocode"), "roo-code");
    assert.equal(resolvePlatformId("gemini"), "gemini-cli");
    assert.equal(resolvePlatformId("copilot"), "copilot-cli");
    assert.equal(resolvePlatformId("copilot-jb"), "copilot-jetbrains");
    assert.equal(resolvePlatformId("vs-code"), "vscode");
    assert.equal(resolvePlatformId("code"), "vscode");
  });

  it("is case-insensitive", () => {
    assert.equal(resolvePlatformId("Claude-Code"), "claude-code");
    assert.equal(resolvePlatformId("CURSOR"), "cursor");
  });

  it("returns input unchanged for unknown platforms", () => {
    assert.equal(resolvePlatformId("unknown"), "unknown");
  });
});

// ─── Unequip CLI ────────────────────────────────────────────

describe("unequip CLI", () => {
  it("shows help with no args", () => {
    const { execSync } = require("child_process");
    const out = execSync("node bin/unequip.js --help", { encoding: "utf-8", cwd: path.join(__dirname, "..") });
    assert.ok(out.includes("unequip"));
    assert.ok(out.includes("Usage:"));
  });

  it("shows version", () => {
    const { execSync } = require("child_process");
    const out = execSync("node bin/unequip.js --version", { encoding: "utf-8", cwd: path.join(__dirname, "..") });
    assert.ok(out.includes("unequip v"));
  });

  it("errors on untracked tool", () => {
    const { execSync } = require("child_process");
    try {
      execSync("node bin/unequip.js nonexistent-tool-xyz", {
        encoding: "utf-8", cwd: path.join(__dirname, ".."), stdio: "pipe"
      });
      assert.fail("should have exited non-zero");
    } catch (e) {
      assert.ok(e.stderr.includes("not tracked"));
    }
  });
});

// ─── Edge Cases ─────────────────────────────────────────────

describe("edge cases", () => {
  it("installMcpJson preserves non-MCP fields in config", () => {
    const p = mockPlatform({ platform: "gemini-cli", rootKey: "mcpServers" });
    fs.writeFileSync(p.configPath, JSON.stringify({
      selectedAuthType: "gemini-api-key",
      theme: "Dracula",
      mcpServers: { existing: { command: "uvx", args: ["mcp-server-git"] } }
    }));
    installMcpJson(p, "prior", { httpUrl: "https://api.cg3.io/mcp" }, false);
    const data = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.equal(data.selectedAuthType, "gemini-api-key", "non-MCP fields preserved");
    assert.equal(data.theme, "Dracula", "theme preserved");
    assert.ok(data.mcpServers.existing, "existing server preserved");
    assert.ok(data.mcpServers.prior, "new server added");
    cleanup(p.configPath);
  });

  it("uninstallMcp deletes file when last entry removed", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.configPath, JSON.stringify({ mcpServers: { only: { url: "x" } } }));
    uninstallMcp(p, "only", false);
    assert.ok(!fs.existsSync(p.configPath), "file should be deleted when empty");
  });

  it("uninstallMcp TOML deletes file when last entry removed", () => {
    const configPath = tmpPath("toml-empty") + ".toml";
    const p = mockPlatform({ platform: "codex", configPath, rootKey: "mcp_servers", configFormat: "toml" });
    fs.writeFileSync(configPath, '[mcp_servers.only]\nurl = "https://example.com"\n');
    const removed = uninstallMcp(p, "only", false);
    assert.ok(removed);
    assert.ok(!fs.existsSync(configPath), "TOML file should be deleted when empty");
  });

  it("installRules handles file with no trailing newline", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.rulesPath, "existing content without newline");
    const result = installRules(p, {
      content: "<!-- edge:v1.0.0 -->\ntest\n<!-- /edge -->",
      version: "1.0.0",
      marker: "edge",
    });
    assert.equal(result.action, "created");
    const content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes("existing content"), "original preserved");
    assert.ok(content.includes("edge:v1.0.0"), "new content added");
    // Should have proper separation
    assert.ok(!content.includes("newline<!-- edge"), "should have separator");
    cleanup(p.rulesPath);
  });

  it("uninstallMcp returns false for nonexistent file", () => {
    const p = mockPlatform();
    cleanup(p.configPath);
    assert.equal(uninstallMcp(p, "anything", false), false);
  });

  it("createManualPlatform works for all platforms", () => {
    for (const id of KNOWN_PLATFORMS) {
      const p = createManualPlatform(id);
      assert.equal(p.platform, id);
      assert.ok(p.configPath, `${id} should have configPath`);
      assert.ok(p.rootKey, `${id} should have rootKey`);
      assert.ok(["json", "toml"].includes(p.configFormat), `${id} configFormat should be json or toml`);
    }
  });

  it("buildHttpConfig works for all platforms", () => {
    for (const id of KNOWN_PLATFORMS) {
      const config = buildHttpConfig("https://test.com/mcp", id);
      // Every platform should produce a config with some URL field
      const hasUrl = config.url || config.serverUrl || config.httpUrl;
      assert.ok(hasUrl, `${id} should have a URL field in HTTP config`);
    }
  });

  it("createManualPlatform includes skillsPath for supported platforms", () => {
    const cc = createManualPlatform("claude-code");
    assert.ok(cc.skillsPath, "claude-code should have skillsPath");
    assert.ok(cc.skillsPath.includes(".claude"), "claude-code skillsPath should be under .claude");

    const cursor = createManualPlatform("cursor");
    assert.ok(cursor.skillsPath, "cursor should have skillsPath");

    const junie = createManualPlatform("junie");
    assert.equal(junie.skillsPath, null, "junie should have null skillsPath");
  });
});

// ─── Skills Module ──────────────────────────────────────────

describe("skills.ts", () => {
  const DEMO_SKILL = {
    name: "test-skill",
    files: [
      { path: "SKILL.md", content: "---\nname: test-skill\ndescription: A test skill\n---\n\n# Test Skill\nDo the thing.\n" },
    ],
  };

  it("installSkill creates skill directory and SKILL.md", () => {
    const skillsDir = tmpPath("skills-test");
    const p = mockPlatform({ skillsPath: skillsDir });
    const result = installSkill(p, "myserver", DEMO_SKILL);
    assert.equal(result.action, "created");
    const skillMd = path.join(skillsDir, "myserver", "test-skill", "SKILL.md");
    assert.ok(fs.existsSync(skillMd));
    assert.ok(fs.readFileSync(skillMd, "utf-8").includes("test-skill"));
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("installSkill is idempotent (skips when content matches)", () => {
    const skillsDir = tmpPath("skills-idem");
    const p = mockPlatform({ skillsPath: skillsDir });
    installSkill(p, "myserver", DEMO_SKILL);
    const result = installSkill(p, "myserver", DEMO_SKILL);
    assert.equal(result.action, "skipped");
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("installSkill updates when content changes", () => {
    const skillsDir = tmpPath("skills-update");
    const p = mockPlatform({ skillsPath: skillsDir });
    installSkill(p, "myserver", DEMO_SKILL);
    const updatedSkill = {
      name: "test-skill",
      files: [{ path: "SKILL.md", content: "---\nname: test-skill\ndescription: Updated\n---\n\n# Updated\n" }],
    };
    const result = installSkill(p, "myserver", updatedSkill);
    assert.equal(result.action, "created");
    const content = fs.readFileSync(path.join(skillsDir, "myserver", "test-skill", "SKILL.md"), "utf-8");
    assert.ok(content.includes("Updated"));
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("installSkill handles multi-file skills", () => {
    const skillsDir = tmpPath("skills-multi");
    const p = mockPlatform({ skillsPath: skillsDir });
    const multiSkill = {
      name: "multi",
      files: [
        { path: "SKILL.md", content: "# Multi\n" },
        { path: "scripts/helper.sh", content: "#!/bin/bash\necho hi\n" },
        { path: "references/API.md", content: "# API\n" },
      ],
    };
    installSkill(p, "myserver", multiSkill);
    assert.ok(fs.existsSync(path.join(skillsDir, "myserver", "multi", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(skillsDir, "myserver", "multi", "scripts", "helper.sh")));
    assert.ok(fs.existsSync(path.join(skillsDir, "myserver", "multi", "references", "API.md")));
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("installSkill returns skipped when skillsPath is null", () => {
    const p = mockPlatform({ skillsPath: null });
    const result = installSkill(p, "myserver", DEMO_SKILL);
    assert.equal(result.action, "skipped");
  });

  it("uninstallSkill removes skill directory", () => {
    const skillsDir = tmpPath("skills-uninst");
    const p = mockPlatform({ skillsPath: skillsDir });
    installSkill(p, "myserver", DEMO_SKILL);
    assert.ok(hasSkill(p, "myserver", "test-skill"));
    const removed = uninstallSkill(p, "myserver", "test-skill");
    assert.ok(removed);
    assert.ok(!hasSkill(p, "myserver", "test-skill"));
    // Parent tool dir should be cleaned up too
    assert.ok(!fs.existsSync(path.join(skillsDir, "myserver")));
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("uninstallSkill returns false when skill doesn't exist", () => {
    const p = mockPlatform({ skillsPath: "/tmp/nonexistent-" + Date.now() });
    assert.equal(uninstallSkill(p, "myserver", "nope"), false);
  });

  it("uninstallSkill returns false when skillsPath is null", () => {
    const p = mockPlatform({ skillsPath: null });
    assert.equal(uninstallSkill(p, "myserver", "nope"), false);
  });

  it("hasSkill returns true when SKILL.md exists", () => {
    const skillsDir = tmpPath("skills-has");
    const p = mockPlatform({ skillsPath: skillsDir });
    installSkill(p, "myserver", DEMO_SKILL);
    assert.ok(hasSkill(p, "myserver", "test-skill"));
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("hasSkill returns false when SKILL.md missing", () => {
    const p = mockPlatform({ skillsPath: "/tmp/nonexistent-" + Date.now() });
    assert.ok(!hasSkill(p, "myserver", "test-skill"));
  });
});

// ─── Augment Class Skills Integration ─────────────────────────

describe("Augment class (skills)", () => {
  const SKILL_CONFIG = {
    name: "lookup",
    files: [{ path: "SKILL.md", content: "---\nname: lookup\ndescription: Look up docs\n---\n\n# Lookup\n" }],
  };

  it("installSkill and uninstallSkill roundtrip", () => {
    const skillsDir = tmpPath("equip-skill");
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      skills: [SKILL_CONFIG],
    });
    const p = mockPlatform({ skillsPath: skillsDir });

    const r1 = e.installSkill(p);
    assert.equal(r1.action, "created");
    assert.ok(e.hasSkill(p));

    e.uninstallSkill(p);
    assert.ok(!e.hasSkill(p));
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("installSkill skips without skill config", () => {
    const e = new Augment({ name: "test", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform({ skillsPath: tmpPath("no-skill") });
    assert.equal(e.installSkill(p).action, "skipped");
  });

  it("verify includes skills check", () => {
    const skillsDir = tmpPath("equip-verify-skill");
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      skills: [SKILL_CONFIG],
    });
    const p = mockPlatform({ skillsPath: skillsDir });
    cleanup(p.configPath);

    // Install MCP + skill
    e.installMcp(p, "key");
    e.installSkill(p);

    const result = e.verify(p);
    assert.ok(result.ok);
    const skillCheck = result.checks.find(c => c.name === "skills");
    assert.ok(skillCheck);
    assert.ok(skillCheck.ok);
    assert.ok(skillCheck.detail.includes("lookup"));

    cleanup(p.configPath);
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("verify detects missing skill", () => {
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      skills: [SKILL_CONFIG],
    });
    const p = mockPlatform({ skillsPath: tmpPath("empty-skills") });
    cleanup(p.configPath);
    e.installMcp(p, "key");
    // Don't install skill

    const result = e.verify(p);
    assert.ok(!result.ok);
    const skillCheck = result.checks.find(c => c.name === "skills");
    assert.ok(skillCheck);
    assert.ok(!skillCheck.ok);
    assert.ok(skillCheck.detail.includes("Missing skills") || skillCheck.detail.includes("not found"));

    cleanup(p.configPath);
  });
});

// ─── Multi-Skill Support ────────────────────────────────────

describe("multi-skill support", () => {
  const SKILL_A = {
    name: "search",
    files: [{ path: "SKILL.md", content: "---\nname: search\n---\n\n# Search\n" }],
  };
  const SKILL_B = {
    name: "contribute",
    files: [{ path: "SKILL.md", content: "---\nname: contribute\n---\n\n# Contribute\n" }],
  };
  const SKILL_C = {
    name: "feedback",
    files: [{ path: "SKILL.md", content: "---\nname: feedback\n---\n\n# Feedback\n" }],
  };

  it("installs multiple skills to correct directories", () => {
    const skillsDir = tmpPath("multi-skill-install");
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      skills: [SKILL_A, SKILL_B, SKILL_C],
    });
    const p = mockPlatform({ skillsPath: skillsDir });

    const result = e.installSkill(p);
    assert.equal(result.action, "created");

    // All three skill directories should exist
    assert.ok(fs.existsSync(path.join(skillsDir, "test", "search", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(skillsDir, "test", "contribute", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(skillsDir, "test", "feedback", "SKILL.md")));

    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("uninstalls all skills for a tool", () => {
    const skillsDir = tmpPath("multi-skill-uninstall");
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      skills: [SKILL_A, SKILL_B],
    });
    const p = mockPlatform({ skillsPath: skillsDir });

    e.installSkill(p);
    assert.ok(e.hasSkill(p));

    const removed = e.uninstallSkill(p);
    assert.ok(removed);
    assert.ok(!fs.existsSync(path.join(skillsDir, "test", "search")));
    assert.ok(!fs.existsSync(path.join(skillsDir, "test", "contribute")));

    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("hasSkill returns false if any skill is missing", () => {
    const skillsDir = tmpPath("multi-skill-partial");
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      skills: [SKILL_A, SKILL_B],
    });
    const p = mockPlatform({ skillsPath: skillsDir });

    // Install only the first skill manually
    installSkill(p, "test", SKILL_A);
    assert.ok(!e.hasSkill(p), "hasSkill should be false when not all skills are installed");

    // Install the second too
    installSkill(p, "test", SKILL_B);
    assert.ok(e.hasSkill(p), "hasSkill should be true when all skills are installed");

    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("installedSkills returns names of installed skills", () => {
    const skillsDir = tmpPath("multi-skill-installed");
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      skills: [SKILL_A, SKILL_B, SKILL_C],
    });
    const p = mockPlatform({ skillsPath: skillsDir });

    // Install only two of three
    installSkill(p, "test", SKILL_A);
    installSkill(p, "test", SKILL_C);

    const installed = e.installedSkills(p);
    assert.equal(installed.length, 2);
    assert.ok(installed.includes("search"));
    assert.ok(installed.includes("feedback"));
    assert.ok(!installed.includes("contribute"));

    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("verify reports per-skill status for multi-skill augment", () => {
    const skillsDir = tmpPath("multi-skill-verify");
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      skills: [SKILL_A, SKILL_B],
    });
    const p = mockPlatform({ skillsPath: skillsDir });
    cleanup(p.configPath);
    e.installMcp(p, "key");
    e.installSkill(p);

    const result = e.verify(p);
    assert.ok(result.ok);
    const skillCheck = result.checks.find(c => c.name === "skills");
    assert.ok(skillCheck.ok);
    assert.ok(skillCheck.detail.includes("search"));
    assert.ok(skillCheck.detail.includes("contribute"));

    cleanup(p.configPath);
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("verify detects partially missing skills", () => {
    const skillsDir = tmpPath("multi-skill-verify-missing");
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      skills: [SKILL_A, SKILL_B],
    });
    const p = mockPlatform({ skillsPath: skillsDir });
    cleanup(p.configPath);
    e.installMcp(p, "key");
    // Only install first skill
    installSkill(p, "test", SKILL_A);

    const result = e.verify(p);
    assert.ok(!result.ok);
    const skillCheck = result.checks.find(c => c.name === "skills");
    assert.ok(!skillCheck.ok);
    assert.ok(skillCheck.detail.includes("contribute"), "should report missing skill name");

    cleanup(p.configPath);
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("single skill in array works", () => {
    const skillsDir = tmpPath("single-skill-array");
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
      skills: [SKILL_A],
    });
    const p = mockPlatform({ skillsPath: skillsDir });

    assert.equal(e.skills.length, 1);
    assert.equal(e.skills[0].name, "search");

    const result = e.installSkill(p);
    assert.equal(result.action, "created");
    assert.ok(fs.existsSync(path.join(skillsDir, "test", "search", "SKILL.md")));

    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("no skills config means empty array", () => {
    const e = new Augment({
      name: "test",
      serverUrl: "https://example.com/mcp",
    });
    assert.equal(e.skills.length, 0);
  });
});

// ─── Amazon Q Platform ──────────────────────────────────────

describe("Amazon Q", () => {
  it("buildHttpConfig returns url with type http", () => {
    const config = buildHttpConfig("https://api.example.com/mcp", "amazon-q");
    assert.equal(config.url, "https://api.example.com/mcp");
    assert.equal(config.type, "http");
  });

  it("buildHttpConfigWithAuth uses standard top-level headers", () => {
    const config = buildHttpConfigWithAuth("https://api.example.com/mcp", "ask_test", "amazon-q");
    assert.equal(config.url, "https://api.example.com/mcp");
    assert.equal(config.type, "http");
    assert.equal(config.headers.Authorization, "Bearer ask_test");
    assert.equal(config.requestInit, undefined, "should not have requestInit wrapper");
  });

  it("installMcpJson writes correct format", () => {
    const p = mockPlatform({ platform: "amazon-q", rootKey: "mcpServers" });
    cleanup(p.configPath);
    const config = buildHttpConfigWithAuth("https://api.example.com/mcp", "ask_q", "amazon-q");
    installMcpJson(p, "prior", config, false);
    const data = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(data.mcpServers.prior);
    assert.equal(data.mcpServers.prior.url, "https://api.example.com/mcp");
    assert.equal(data.mcpServers.prior.type, "http");
    assert.equal(data.mcpServers.prior.headers.Authorization, "Bearer ask_q");
    cleanup(p.configPath);
  });

  it("Augment class roundtrip", () => {
    const configPath = tmpPath("amazonq-equip") + ".json";
    const e = new Augment({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform({ platform: "amazon-q", configPath, rootKey: "mcpServers" });
    cleanup(configPath);
    e.installMcp(p, "ask_roundtrip");
    const entry = e.readMcp(p);
    assert.ok(entry);
    assert.equal(entry.url, "https://example.com/mcp");
    assert.equal(entry.type, "http");
    e.uninstallMcp(p);
    assert.equal(e.readMcp(p), null);
    cleanup(configPath);
  });

  it("createManualPlatform returns correct config", () => {
    const p = createManualPlatform("amazon-q");
    assert.equal(p.platform, "amazon-q");
    assert.ok(p.configPath.includes(".aws"), "configPath should reference .aws");
    assert.ok(p.configPath.includes("amazonq"), "configPath should reference amazonq");
    assert.equal(p.rootKey, "mcpServers");
    assert.equal(p.rulesPath, null, "no rules support");
    assert.equal(p.skillsPath, null, "no skills support");
  });

  it("resolvePlatformId handles aliases", () => {
    const { resolvePlatformId } = require("..");
    assert.equal(resolvePlatformId("q"), "amazon-q");
    assert.equal(resolvePlatformId("amazonq"), "amazon-q");
    assert.equal(resolvePlatformId("amazon-q"), "amazon-q");
  });

  it("platformName returns Amazon Q", () => {
    assert.equal(platformName("amazon-q"), "Amazon Q");
  });
});

// ─── Tabnine Platform ───────────────────────────────────────
// Tabnine uses a unique nested headers format: { requestInit: { headers: {...} } }
// These tests verify the headersWrapper mechanism works correctly.

describe("Tabnine (headersWrapper)", () => {
  it("buildHttpConfig returns url without type for tabnine", () => {
    const config = buildHttpConfig("https://api.example.com/mcp", "tabnine");
    assert.equal(config.url, "https://api.example.com/mcp");
    assert.equal(config.type, undefined, "tabnine should have no type field");
  });

  it("buildHttpConfigWithAuth nests headers in requestInit", () => {
    const config = buildHttpConfigWithAuth("https://api.example.com/mcp", "ask_test123", "tabnine");
    assert.equal(config.url, "https://api.example.com/mcp");
    // Headers should be nested: { requestInit: { headers: { Authorization: "..." } } }
    assert.ok(config.requestInit, "should have requestInit wrapper");
    assert.ok(config.requestInit.headers, "should have headers inside requestInit");
    assert.equal(config.requestInit.headers.Authorization, "Bearer ask_test123");
    // Should NOT have top-level headers
    assert.equal(config.headers, undefined, "should not have top-level headers");
  });

  it("buildHttpConfigWithAuth includes extra headers in requestInit", () => {
    const config = buildHttpConfigWithAuth("https://api.example.com/mcp", "ask_test", "tabnine", { "X-Custom": "value" });
    assert.equal(config.requestInit.headers.Authorization, "Bearer ask_test");
    assert.equal(config.requestInit.headers["X-Custom"], "value");
  });

  it("installMcpJson writes tabnine format correctly", () => {
    const p = mockPlatform({ platform: "tabnine", rootKey: "mcpServers" });
    cleanup(p.configPath);
    const config = buildHttpConfigWithAuth("https://api.example.com/mcp", "ask_tabnine", "tabnine");
    installMcpJson(p, "prior", config, false);
    const data = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(data.mcpServers.prior, "should have prior entry");
    assert.equal(data.mcpServers.prior.url, "https://api.example.com/mcp");
    assert.ok(data.mcpServers.prior.requestInit, "should have requestInit");
    assert.ok(data.mcpServers.prior.requestInit.headers, "should have nested headers");
    assert.equal(data.mcpServers.prior.requestInit.headers.Authorization, "Bearer ask_tabnine");
    cleanup(p.configPath);
  });

  it("installMcpJson preserves existing tabnine entries", () => {
    const p = mockPlatform({ platform: "tabnine", rootKey: "mcpServers" });
    fs.writeFileSync(p.configPath, JSON.stringify({
      mcpServers: {
        existing: {
          url: "https://other.com/mcp",
          requestInit: { headers: { "X-Key": "abc" } }
        }
      }
    }));
    const config = buildHttpConfigWithAuth("https://api.example.com/mcp", "ask_new", "tabnine");
    installMcpJson(p, "prior", config, false);
    const data = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(data.mcpServers.existing, "existing server should be preserved");
    assert.ok(data.mcpServers.prior, "new server should be added");
    assert.equal(data.mcpServers.existing.requestInit.headers["X-Key"], "abc", "existing headers preserved");
    cleanup(p.configPath);
  });

  it("Augment class full roundtrip for tabnine", () => {
    const configPath = tmpPath("tabnine-equip") + ".json";
    const e = new Augment({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform({ platform: "tabnine", configPath, rootKey: "mcpServers" });
    cleanup(configPath);
    e.installMcp(p, "ask_roundtrip");
    const entry = e.readMcp(p);
    assert.ok(entry, "should read back entry");
    assert.equal(entry.url, "https://example.com/mcp");
    assert.ok(entry.requestInit, "should have requestInit in stored config");
    e.uninstallMcp(p);
    assert.equal(e.readMcp(p), null, "should be removed");
    cleanup(configPath);
  });

  it("createManualPlatform returns correct tabnine config", () => {
    const p = createManualPlatform("tabnine");
    assert.equal(p.platform, "tabnine");
    assert.ok(p.configPath.includes(".tabnine"), "configPath should reference .tabnine");
    assert.equal(p.rootKey, "mcpServers");
    assert.equal(p.configFormat, "json");
    assert.ok(p.rulesPath, "tabnine should have rulesPath (guidelines)");
    assert.ok(p.rulesPath.includes("guidelines"), "rulesPath should reference guidelines");
    assert.equal(p.skillsPath, null, "tabnine should not have skillsPath");
  });

  it("platformName returns Tabnine", () => {
    assert.equal(platformName("tabnine"), "Tabnine");
  });

  it("non-tabnine platforms still use top-level headers", () => {
    const claude = buildHttpConfigWithAuth("https://x.com/mcp", "key", "claude-code");
    assert.ok(claude.headers, "claude-code should have top-level headers");
    assert.equal(claude.requestInit, undefined, "claude-code should not have requestInit");

    const codex = buildHttpConfigWithAuth("https://x.com/mcp", "key", "codex");
    assert.ok(codex.http_headers, "codex should have top-level http_headers");
    assert.equal(codex.requestInit, undefined, "codex should not have requestInit");
  });
});

// ─── Auth Checking ──────────────────────────────────────────

describe("auth checking", () => {
  it("detects missing auth header", () => {
    const result = checkAuth({ url: "https://example.com/mcp" });
    assert.equal(result.status, "missing");
  });

  it("detects present static API key (top-level headers)", () => {
    const result = checkAuth({ url: "https://x.com/mcp", headers: { Authorization: "Bearer ask_abc123" } });
    assert.equal(result.status, "present");
  });

  it("detects present API key in http_headers (Codex)", () => {
    const result = checkAuth({ url: "https://x.com/mcp", http_headers: { Authorization: "Bearer key" } });
    assert.equal(result.status, "present");
  });

  it("detects present API key in requestInit.headers (Tabnine)", () => {
    const result = checkAuth({ url: "https://x.com/mcp", requestInit: { headers: { Authorization: "Bearer key" } } });
    assert.equal(result.status, "present");
  });

  it("detects expired JWT", () => {
    // Create a JWT with exp in the past
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "test", exp: Math.floor(Date.now() / 1000) - 3600 })).toString("base64url");
    const sig = "fakesignature";
    const jwt = `${header}.${payload}.${sig}`;

    const result = checkAuth({ url: "https://x.com/mcp", headers: { Authorization: `Bearer ${jwt}` } });
    assert.equal(result.status, "expired");
    assert.ok(result.detail.includes("expired"));
  });

  it("detects valid JWT (future exp)", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "test", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    const sig = "fakesignature";
    const jwt = `${header}.${payload}.${sig}`;

    const result = checkAuth({ url: "https://x.com/mcp", headers: { Authorization: `Bearer ${jwt}` } });
    assert.equal(result.status, "ok");
  });

  it("treats JWT without exp as present", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "test" })).toString("base64url");
    const jwt = `${header}.${payload}.fakesig`;

    const result = checkAuth({ url: "https://x.com/mcp", headers: { Authorization: `Bearer ${jwt}` } });
    assert.equal(result.status, "present");
  });

  it("handles malformed JWT gracefully", () => {
    const result = checkAuth({ url: "https://x.com/mcp", headers: { Authorization: "Bearer not.a.jwt!!!" } });
    assert.equal(result.status, "present");
  });

  it("extractAuthHeader finds headers across all platform formats", () => {
    assert.equal(extractAuthHeader({ headers: { Authorization: "Bearer a" } }), "Bearer a");
    assert.equal(extractAuthHeader({ http_headers: { Authorization: "Bearer b" } }), "Bearer b");
    assert.equal(extractAuthHeader({ requestInit: { headers: { Authorization: "Bearer c" } } }), "Bearer c");
    assert.equal(extractAuthHeader({ url: "https://x.com" }), null);
  });
});

// ─── Config Migration ───────────────────────────────────────
// Tests simulate real migration scenarios: configs written by older equip
// versions with different platform definitions, then migrated by current version.

describe("config migration", () => {
  const { trackInstallation, trackUninstallation } = require("../dist/lib/installations");
  const { getPlatform } = require("../dist/lib/platforms");

  // Helper: write a config file to the platform's canonical path and track it,
  // then run migration. Backs up and restores the original config.
  function setupAndMigrate(platformId, toolName, configContent) {
    const def = getPlatform(platformId);
    const configPath = def.configPath();
    const configDir = path.dirname(configPath);

    // Ensure config directory exists
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    // Backup existing config (if any)
    let backup = null;
    try { backup = fs.readFileSync(configPath, "utf-8"); } catch {}

    fs.writeFileSync(configPath, JSON.stringify(configContent, null, 2));
    trackInstallation(toolName, {
      source: "registry", displayName: toolName, transport: "http",
      platforms: [platformId],
      artifacts: { [platformId]: { mcp: true } },
    });
    const results = migrateConfigs();
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    // Restore original config
    if (backup !== null) {
      fs.writeFileSync(configPath, backup);
    } else {
      try { fs.unlinkSync(configPath); } catch {}
    }
    trackUninstallation(toolName);
    return { results, content };
  }

  it("adds missing type field (Roo Code scenario)", () => {
    // Simulate: old equip wrote Roo Code config without type field
    // Current equip requires type: "streamable-http" for Roo Code
    const { results, content } = setupAndMigrate("roo-code", "test-migrate", {
      mcpServers: {
        "test-migrate": {
          url: "https://api.example.com/mcp",
          headers: { Authorization: "Bearer ask_old" }
        }
      }
    });

    const migration = results.find(r => r.toolName === "test-migrate" && r.platform === "roo-code");
    assert.equal(migration.action, "migrated", "should have migrated");
    assert.ok(migration.detail.includes("type field"), "should mention type field");

    // Verify the config was rewritten correctly
    const entry = content.mcpServers["test-migrate"];
    assert.equal(entry.type, "streamable-http", "should have added type field");
    assert.equal(entry.url, "https://api.example.com/mcp", "should preserve URL");
    assert.equal(entry.headers.Authorization, "Bearer ask_old", "should preserve auth");
  });

  it("removes stale type field (Cursor scenario)", () => {
    // Simulate: old equip wrote Cursor config with type: "streamable-http"
    // Current equip has no type field for Cursor
    const { results, content } = setupAndMigrate("cursor", "test-migrate", {
      mcpServers: {
        "test-migrate": {
          url: "https://api.example.com/mcp",
          type: "streamable-http",
          headers: { Authorization: "Bearer ask_old" }
        }
      }
    });

    const migration = results.find(r => r.toolName === "test-migrate" && r.platform === "cursor");
    assert.equal(migration.action, "migrated");
    assert.ok(migration.detail.includes("type field should not be present"));

    const entry = content.mcpServers["test-migrate"];
    assert.equal(entry.type, undefined, "type field should be removed");
    assert.equal(entry.url, "https://api.example.com/mcp", "should preserve URL");
    assert.equal(entry.headers.Authorization, "Bearer ask_old", "should preserve auth");
  });

  it("adds type field when wrong value (hypothetical)", { skip: "Flaky on Windows — Roo Code rules file lock (EPERM)" }, () => {
    // Simulate: config has type: "http" but platform now requires "streamable-http"
    const { results, content } = setupAndMigrate("roo-code", "test-migrate", {
      mcpServers: {
        "test-migrate": {
          url: "https://api.example.com/mcp",
          type: "http",
          headers: { Authorization: "Bearer ask_old" }
        }
      }
    });

    const migration = results.find(r => r.platform === "roo-code");
    assert.equal(migration.action, "migrated");

    const entry = content.mcpServers["test-migrate"];
    assert.equal(entry.type, "streamable-http", "type should be corrected");
  });

  it("skips config that already matches current definitions", () => {
    // Config already has the correct shape — no migration needed
    const { results } = setupAndMigrate("claude-code", "test-migrate", {
      mcpServers: {
        "test-migrate": {
          url: "https://api.example.com/mcp",
          type: "http",
          headers: { Authorization: "Bearer ask_current" }
        }
      }
    });

    const migration = results.find(r => r.toolName === "test-migrate" && r.platform === "claude-code");
    assert.ok(migration, "should have result for test-migrate on claude-code");
    assert.equal(migration.action, "skipped", `expected skipped but got ${migration.action}: ${migration.detail}`);
  });

  it("skips platforms with no MCP entry", () => {
    // Tool is tracked on platform but has no MCP config (rules-only install)
    const def = getPlatform("claude-code");
    const configPath = def.configPath();
    const backup = (() => { try { return fs.readFileSync(configPath, "utf-8"); } catch { return null; } })();

    // Write config WITHOUT the tool entry (empty mcpServers)
    const origContent = backup ? JSON.parse(backup) : {};
    const testContent = { ...origContent, mcpServers: { ...(origContent.mcpServers || {}) } };
    // Don't add test-migrate — that's the point
    delete testContent.mcpServers["test-migrate"];
    fs.writeFileSync(configPath, JSON.stringify(testContent, null, 2));

    trackInstallation("test-migrate", {
      source: "registry", displayName: "test-migrate", transport: "http",
      platforms: ["claude-code"], artifacts: { "claude-code": { mcp: true } },
    });
    const results = migrateConfigs();
    trackUninstallation("test-migrate");
    if (backup) fs.writeFileSync(configPath, backup); // restore

    const migration = results.find(r => r.toolName === "test-migrate" && r.platform === "claude-code");
    assert.ok(migration, "should have result for test-migrate on claude-code");
    assert.equal(migration.action, "skipped");
    assert.ok(migration.detail.includes("no MCP entry"));
  });

  it("preserves other servers during migration", () => {
    const { results, content } = setupAndMigrate("cursor", "test-migrate", {
      mcpServers: {
        "other-tool": { url: "https://other.com/mcp", type: "http", headers: { "X-Key": "keep" } },
        "test-migrate": { url: "https://api.example.com/mcp", type: "streamable-http", headers: { Authorization: "Bearer old" } }
      }
    });
    // Other tool should be completely untouched
    assert.equal(content.mcpServers["other-tool"].type, "http", "other tool should not be modified");
    assert.equal(content.mcpServers["other-tool"].headers["X-Key"], "keep");
    // Migrated tool should have type removed (Cursor)
    assert.equal(content.mcpServers["test-migrate"].type, undefined, "cursor should lose type");
    assert.equal(content.mcpServers["test-migrate"].url, "https://api.example.com/mcp");
  });

  it("preserves extra fields like alwaysAllow and disabled", () => {
    const { content } = setupAndMigrate("roo-code", "test-migrate", {
      mcpServers: {
        "test-migrate": {
          url: "https://api.example.com/mcp",
          headers: { Authorization: "Bearer ask_old" },
          alwaysAllow: ["tool1", "tool2"],
          disabled: false,
          timeout: 30000
        }
      }
    });

    const entry = content.mcpServers["test-migrate"];
    assert.equal(entry.type, "streamable-http", "should add type");
    assert.deepEqual(entry.alwaysAllow, ["tool1", "tool2"], "should preserve alwaysAllow");
    assert.equal(entry.disabled, false, "should preserve disabled");
    assert.equal(entry.timeout, 30000, "should preserve timeout");
  });

  it("handles Copilot CLI type addition", () => {
    // Copilot CLI now requires type: "http"
    const { results, content } = setupAndMigrate("copilot-cli", "test-migrate", {
      mcpServers: {
        "test-migrate": {
          url: "https://api.example.com/mcp",
          headers: { Authorization: "Bearer ask_old" }
        }
      }
    });

    const migration = results.find(r => r.toolName === "test-migrate" && r.platform === "copilot-cli");
    assert.equal(migration.action, "migrated");
    assert.equal(content.mcpServers["test-migrate"].type, "http");
  });

  it("handles migration of multiple tools at once", () => {
    const def = getPlatform("cursor");
    const configPath = def.configPath();
    const backup = (() => { try { return fs.readFileSync(configPath, "utf-8"); } catch { return null; } })();

    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        "tool-a": { url: "https://a.com/mcp", type: "streamable-http", headers: { Authorization: "Bearer a" } },
        "tool-b": { url: "https://b.com/mcp", type: "streamable-http", headers: { Authorization: "Bearer b" } }
      }
    }));

    trackInstallation("tool-a", {
      source: "registry", displayName: "tool-a", transport: "http",
      platforms: ["cursor"], artifacts: { "cursor": { mcp: true } },
    });
    trackInstallation("tool-b", {
      source: "registry", displayName: "tool-b", transport: "http",
      platforms: ["cursor"], artifacts: { "cursor": { mcp: true } },
    });

    const results = migrateConfigs();
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    assert.equal(results.filter(r => r.action === "migrated").length, 2, "both should be migrated");
    assert.equal(content.mcpServers["tool-a"].type, undefined, "tool-a type removed");
    assert.equal(content.mcpServers["tool-b"].type, undefined, "tool-b type removed");

    trackUninstallation("tool-a");
    trackUninstallation("tool-b");
    if (backup) fs.writeFileSync(configPath, backup); else try { fs.unlinkSync(configPath); } catch {}
  });
});
