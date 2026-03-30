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
  Equip,
  createManualPlatform,
  platformName,
  KNOWN_PLATFORMS,
  parseRulesVersion,
  markerPatterns,
  cli,
} = require("..");

// Internal modules (for low-level tests)
const { buildHttpConfig, buildHttpConfigWithAuth, installMcpJson, installMcpToml, uninstallMcp } = require("../dist/lib/mcp");
const { installRules } = require("../dist/lib/rules");
const { parseTomlServerEntry, parseTomlSubTables, buildTomlEntry, removeTomlEntry } = require("../dist/lib/mcp");
const { atomicWriteFileSync, safeReadJsonSync, createBackup, cleanupBackup, resolvePackageVersion } = require("../dist/lib/fs");
const { reconcileState } = require("../dist/lib/reconcile");
const { getHookCapabilities, buildHooksConfig, installHooks, uninstallHooks, hasHooks } = require("../dist/lib/hooks");
const { installSkill, uninstallSkill, hasSkill } = require("../dist/lib/skills");
const { buildStdioConfig } = require("../dist/lib/mcp");

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

// ─── Equip Class ─────────────────────────────────────────────

describe("Equip class", () => {
  it("requires name", () => {
    assert.throws(() => new Equip({}), /name is required/);
  });

  it("works without serverUrl (rules/skills only)", () => {
    const e = new Equip({ name: "test" });
    assert.equal(e.name, "test");
    assert.equal(e.serverUrl, undefined);
  });

  it("throws on installMcp without serverUrl", () => {
    const e = new Equip({ name: "test" });
    const p = mockPlatform();
    assert.throws(() => e.installMcp(p, "key"), /serverUrl is required/);
  });

  it("creates instance with serverUrl", () => {
    const e = new Equip({ name: "test", serverUrl: "https://example.com/mcp" });
    assert.equal(e.name, "test");
    assert.equal(e.serverUrl, "https://example.com/mcp");
  });

  it("detect returns platforms array", () => {
    const e = new Equip({ name: "test", serverUrl: "https://example.com/mcp" });
    const platforms = e.detect();
    assert.ok(Array.isArray(platforms));
  });

  it("buildConfig returns HTTP config", () => {
    const e = new Equip({ name: "test", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("claude-code", "key123");
    assert.equal(config.url, "https://example.com/mcp");
    assert.equal(config.headers.Authorization, "Bearer key123");
  });

  it("buildConfig returns VS Code config with type", () => {
    const e = new Equip({ name: "test", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("vscode", "key123");
    assert.equal(config.type, "http");
    assert.equal(config.url, "https://example.com/mcp");
  });

  it("buildConfig returns Windsurf config with serverUrl", () => {
    const e = new Equip({ name: "test", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("windsurf", "key123");
    assert.equal(config.serverUrl, "https://example.com/mcp");
    assert.ok(!config.url);
  });

  it("buildConfig returns stdio config", () => {
    const e = new Equip({
      name: "test",
      serverUrl: "https://example.com/mcp",
      stdio: { command: "npx", args: ["-y", "test-mcp"], envKey: "TEST_KEY" },
    });
    const config = e.buildConfig("claude-code", "key123", "stdio");
    assert.ok(config.env.TEST_KEY === "key123");
  });

  it("installMcp and uninstallMcp roundtrip", () => {
    const e = new Equip({ name: "myserver", serverUrl: "https://example.com/mcp" });
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
    const e = new Equip({
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
    const e = new Equip({ name: "test", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform();
    const r = e.installRules(p);
    assert.equal(r.action, "skipped");
  });

  it("buildConfig uses http_headers for codex", () => {
    const e = new Equip({ name: "test", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("codex", "key123");
    assert.equal(config.url, "https://example.com/mcp");
    assert.equal(config.http_headers.Authorization, "Bearer key123");
    assert.ok(!config.headers);
  });

  it("buildConfig uses httpUrl for gemini-cli", () => {
    const e = new Equip({ name: "test", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("gemini-cli", "key123");
    assert.equal(config.httpUrl, "https://example.com/mcp");
    assert.equal(config.headers.Authorization, "Bearer key123");
  });

  it("buildConfig uses url and headers for junie", () => {
    const e = new Equip({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("junie", "key123");
    assert.equal(config.url, "https://example.com/mcp");
    assert.equal(config.headers.Authorization, "Bearer key123");
  });

  it("installMcp and readMcp roundtrip with TOML (Codex)", () => {
    const configPath = tmpPath("codex-equip") + ".toml";
    const e = new Equip({ name: "myserver", serverUrl: "https://example.com/mcp" });
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
    const e = new Equip({ name: "myserver", serverUrl: "https://example.com/mcp" });
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
    const e = new Equip({ name: "myserver", serverUrl: "https://example.com/mcp" });
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
    const e = new Equip({ name: "myserver", serverUrl: "https://example.com/mcp" });
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
    const e = new Equip({ name: "myserver", serverUrl: "https://example.com/mcp" });
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

  it("returns clipboard for clipboard platforms", () => {
    const p = mockPlatform({ platform: "cursor" });
    const r = installRules(p, { content: RULES_CONTENT, version: "1.0.0", marker: "test", clipboardPlatforms: ["cursor"] });
    assert.equal(r.action, "clipboard");
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
  it("includes all 11 platforms", () => {
    assert.equal(KNOWN_PLATFORMS.length, 11);
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
  it("shows help with no args", () => {
    const { execSync } = require("child_process");
    const out = execSync("node bin/equip.js --help", { encoding: "utf-8", cwd: path.join(__dirname, "..") });
    assert.ok(out.includes("Commands:"));
    assert.ok(out.includes("prior"));
    assert.ok(out.includes("status"));
    assert.ok(out.includes("doctor"));
    assert.ok(out.includes("update"));
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

  it("registered shorthand dispatches correctly", () => {
    // Can't test full npx dispatch without network, but verify the registry
    // is loaded and the shorthand resolves to the right package/command.
    const { execSync } = require("child_process");
    const out = execSync("node bin/equip.js list", { encoding: "utf-8", cwd: path.join(__dirname, "..") });
    assert.ok(out.includes("prior"), "prior should be in registry");
    assert.ok(out.includes("@cg3/prior-node"), "should show the npm package");
    assert.ok(out.includes("setup"), "should show the command");
  });

  it("help shows all dispatch paths", () => {
    const { execSync } = require("child_process");
    const out = execSync("node bin/equip.js --help", { encoding: "utf-8", cwd: path.join(__dirname, "..") });
    assert.ok(out.includes("<tool>"), "should show registered tool path");
    assert.ok(out.includes("<package>"), "should show unregistered package path");
    assert.ok(out.includes("./script.js"), "should show local script path");
    assert.ok(out.includes("."), "should show local package path");
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

  it("list shows registered tools", () => {
    const { execSync } = require("child_process");
    const out = execSync("node bin/equip.js list", { encoding: "utf-8", cwd: path.join(__dirname, "..") });
    assert.ok(out.includes("prior"));
    assert.ok(out.includes("Registered tools"));
  });
});

// ─── State Module ───────────────────────────────────────────

describe("state module", () => {
  const { readState, writeState, trackInstall, trackUninstall, getStatePath } = require("../dist/lib/state");

  // Clean up any state pollution from Equip class tests (they use name: "test", "myserver")
  function cleanupTestState() {
    const state = readState();
    let changed = false;
    for (const name of Object.keys(state.tools)) {
      const tool = state.tools[name];
      // Remove entries with tmp paths (test artifacts)
      const hasTmpPaths = Object.values(tool.platforms).some(p => p.configPath && p.configPath.includes("Temp"));
      if (hasTmpPaths || name === "test-tool") {
        delete state.tools[name];
        changed = true;
      }
    }
    if (changed) writeState(state);
  }

  it("reads state", () => {
    const state = readState();
    assert.ok(state.tools);
    assert.equal(typeof state.tools, "object");
  });

  it("trackInstall and trackUninstall roundtrip", () => {
    trackInstall("test-tool", "@test/pkg", "claude-code", {
      transport: "http",
      configPath: "/tmp/test.json",
    });
    const state = readState();
    assert.ok(state.tools["test-tool"]);
    assert.equal(state.tools["test-tool"].platforms["claude-code"].transport, "http");

    trackUninstall("test-tool", "claude-code");
    const after = readState();
    assert.ok(!after.tools["test-tool"]);
  });

  it("cleanup: remove test artifacts from state", () => {
    cleanupTestState();
    const state = readState();
    // Verify no test artifacts remain
    for (const [name, tool] of Object.entries(state.tools)) {
      for (const [, plat] of Object.entries(tool.platforms)) {
        assert.ok(!plat.configPath || !plat.configPath.includes("Temp"), `${name} has tmp configPath`);
      }
    }
  });
});

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
  it("throws on corrupt existing config instead of silently overwriting", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.configPath, "this is corrupt json {{{");
    assert.throws(
      () => installMcpJson(p, "myserver", { url: "https://example.com" }, false),
      /Cannot install.*Invalid JSON/
    );
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

describe("Equip.verify()", () => {
  it("returns ok when MCP is installed", () => {
    const e = new Equip({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform();
    cleanup(p.configPath);
    e.installMcp(p, "key123");
    const result = e.verify(p);
    assert.ok(result.ok);
    assert.equal(result.checks.find(c => c.name === "mcp").ok, true);
    cleanup(p.configPath);
  });

  it("returns not ok when MCP is missing", () => {
    const e = new Equip({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform();
    cleanup(p.configPath);
    // Don't install — verify should fail
    const result = e.verify(p);
    assert.ok(!result.ok);
    assert.equal(result.checks.find(c => c.name === "mcp").ok, false);
  });

  it("checks rules when configured", () => {
    const e = new Equip({
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
    const e = new Equip({
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
    const e = new Equip({ name: "test", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform({ platform: "cursor" });
    const result = e.verify(p);
    assert.equal(result.platform, "cursor");
    assert.ok(Array.isArray(result.checks));
  });
});

// ─── Reconcile State ────────────────────────────────────────

describe("reconcileState", () => {
  const { readState, writeState, trackUninstall } = require("../dist/lib/state");

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
    trackUninstall("test-reconcile");
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

describe("equipVersionAtInstall tracking", () => {
  const { readState, trackInstall, trackUninstall } = require("../dist/lib/state");

  it("records equipVersion on each platform record", () => {
    trackInstall("version-test", "@test/pkg", "claude-code", {
      transport: "http",
      configPath: "/tmp/test.json",
    });
    const state = readState();
    const record = state.tools["version-test"]?.platforms["claude-code"];
    assert.ok(record);
    assert.ok(record.equipVersion, "should have equipVersion");
    assert.match(record.equipVersion, /^\d+\.\d+\.\d+/);

    trackUninstall("version-test");
  });
});

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
    assert.ok(result);
    assert.ok(result.installed);
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

  it("returns null for platforms without hook support", () => {
    const p = mockPlatform({ platform: "cursor" });
    const result = installHooks(p, hookDefs, { hookDir: "/tmp/hooks" });
    assert.equal(result, null);
  });

  it("returns null with empty hook defs", () => {
    const p = mockPlatform({ platform: "claude-code" });
    const result = installHooks(p, [], { hookDir: "/tmp/hooks" });
    assert.equal(result, null);
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

describe("Equip.updateMcpKey()", () => {
  it("updates API key in existing JSON config", () => {
    const e = new Equip({ name: "myserver", serverUrl: "https://example.com/mcp" });
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
    const e = new Equip({ name: "myserver", serverUrl: "https://example.com/mcp" });
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

  it("createManualPlatform works for all 11 platforms", () => {
    for (const id of KNOWN_PLATFORMS) {
      const p = createManualPlatform(id);
      assert.equal(p.platform, id);
      assert.ok(p.configPath, `${id} should have configPath`);
      assert.ok(p.rootKey, `${id} should have rootKey`);
      assert.ok(["json", "toml"].includes(p.configFormat), `${id} configFormat should be json or toml`);
    }
  });

  it("buildHttpConfig works for all 11 platforms", () => {
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

// ─── Equip Class Skills Integration ─────────────────────────

describe("Equip class (skills)", () => {
  const SKILL_CONFIG = {
    name: "lookup",
    files: [{ path: "SKILL.md", content: "---\nname: lookup\ndescription: Look up docs\n---\n\n# Lookup\n" }],
  };

  it("installSkill and uninstallSkill roundtrip", () => {
    const skillsDir = tmpPath("equip-skill");
    const e = new Equip({
      name: "test",
      serverUrl: "https://example.com/mcp",
      skill: SKILL_CONFIG,
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
    const e = new Equip({ name: "test", serverUrl: "https://example.com/mcp" });
    const p = mockPlatform({ skillsPath: tmpPath("no-skill") });
    assert.equal(e.installSkill(p).action, "skipped");
  });

  it("verify includes skills check", () => {
    const skillsDir = tmpPath("equip-verify-skill");
    const e = new Equip({
      name: "test",
      serverUrl: "https://example.com/mcp",
      skill: SKILL_CONFIG,
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
    const e = new Equip({
      name: "test",
      serverUrl: "https://example.com/mcp",
      skill: SKILL_CONFIG,
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
    assert.ok(skillCheck.detail.includes("not found"));

    cleanup(p.configPath);
  });
});
