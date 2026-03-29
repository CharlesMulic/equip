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

// ─── Helpers ─────────────────────────────────────────────────

function tmpPath(prefix = "equip-test") {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function mockPlatform(overrides = {}) {
  return {
    platform: "claude-code",
    version: "1.0.0",
    configPath: tmpPath("config") + ".json",
    rulesPath: tmpPath("rules") + ".md",
    hasCli: false,
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

  it("requires serverUrl or stdio", () => {
    assert.throws(() => new Equip({ name: "test" }), /serverUrl or stdio/);
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

  it("errors on unknown tool without command", () => {
    const { execSync } = require("child_process");
    try {
      execSync("node bin/equip.js nonexistent", { encoding: "utf-8", cwd: path.join(__dirname, ".."), stdio: "pipe" });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e.stderr.includes("Unknown command:"));
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
