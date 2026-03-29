// Tests for @cg3/equip library
// Node 18+ built-in test runner, zero dependencies

"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const {
  Equip,
  detectPlatforms,
  readMcpEntry,
  buildHttpConfig,
  buildHttpConfigWithAuth,
  buildStdioConfig,
  installMcpJson,
  installMcpToml,
  uninstallMcp,
  installRules,
  uninstallRules,
  parseRulesVersion,
  markerPatterns,
  createManualPlatform,
  platformName,
  KNOWN_PLATFORMS,
  parseTomlServerEntry,
  parseTomlSubTables,
  buildTomlEntry,
  removeTomlEntry,
} = require("..");

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
});

// ─── HTTP Config ─────────────────────────────────────────────

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
});

// ─── MCP JSON ────────────────────────────────────────────────

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

// ─── Rules ───────────────────────────────────────────────────

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
    assert.equal(platformName("unknown"), "unknown");
  });
});

describe("KNOWN_PLATFORMS", () => {
  it("includes all 11 platforms", () => {
    assert.equal(KNOWN_PLATFORMS.length, 11);
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

// ─── TOML Helpers (Codex) ───────────────────────────────────

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

// ─── Codex TOML Install/Uninstall ───────────────────────────

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

// ─── Codex HTTP Config ──────────────────────────────────────

describe("buildHttpConfig (Codex)", () => {
  it("returns url for codex", () => {
    const c = buildHttpConfig("https://api.cg3.io/mcp", "codex");
    assert.equal(c.url, "https://api.cg3.io/mcp");
    assert.ok(!c.serverUrl);
    assert.ok(!c.type);
  });
});

describe("buildHttpConfigWithAuth (Codex)", () => {
  it("uses http_headers for codex", () => {
    const c = buildHttpConfigWithAuth("https://api.cg3.io/mcp", "ask_123", "codex");
    assert.equal(c.url, "https://api.cg3.io/mcp");
    assert.equal(c.http_headers.Authorization, "Bearer ask_123");
    assert.ok(!c.headers, "should not have 'headers' key for codex");
  });
});

// ─── Gemini CLI Config ──────────────────────────────────────

describe("buildHttpConfig (Gemini CLI)", () => {
  it("returns httpUrl for gemini-cli", () => {
    const c = buildHttpConfig("https://api.cg3.io/mcp", "gemini-cli");
    assert.equal(c.httpUrl, "https://api.cg3.io/mcp");
    assert.ok(!c.url);
    assert.ok(!c.serverUrl);
  });
});

describe("buildHttpConfigWithAuth (Gemini CLI)", () => {
  it("uses headers for gemini-cli", () => {
    const c = buildHttpConfigWithAuth("https://api.cg3.io/mcp", "ask_123", "gemini-cli");
    assert.equal(c.httpUrl, "https://api.cg3.io/mcp");
    assert.equal(c.headers.Authorization, "Bearer ask_123");
  });
});

describe("Gemini CLI MCP install (JSON)", () => {
  it("installs to settings.json with mcpServers", () => {
    const configPath = tmpPath("gemini-settings") + ".json";
    const p = mockPlatform({ platform: "gemini-cli", configPath, rootKey: "mcpServers", configFormat: "json" });
    cleanup(configPath);
    installMcpJson(p, "prior", { httpUrl: "https://api.cg3.io/mcp", headers: { Authorization: "Bearer key" } }, false);
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.ok(data.mcpServers.prior);
    assert.equal(data.mcpServers.prior.httpUrl, "https://api.cg3.io/mcp");
    cleanup(configPath);
  });

  it("preserves existing Gemini settings", () => {
    const configPath = tmpPath("gemini-settings") + ".json";
    fs.writeFileSync(configPath, JSON.stringify({ selectedAuthType: "gemini-api-key", theme: "Dracula", mcpServers: { git: { command: "uvx", args: ["mcp-server-git"] } } }));
    const p = mockPlatform({ platform: "gemini-cli", configPath, rootKey: "mcpServers", configFormat: "json" });
    installMcpJson(p, "prior", { httpUrl: "https://api.cg3.io/mcp" }, false);
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.ok(data.mcpServers.prior);
    assert.ok(data.mcpServers.git, "existing git server should be preserved");
    assert.equal(data.selectedAuthType, "gemini-api-key", "non-MCP settings preserved");
    assert.equal(data.theme, "Dracula", "theme preserved");
    cleanup(configPath);
  });
});

// ─── Codex & Gemini Platform Names ──────────────────────────

describe("platformName (new platforms)", () => {
  it("returns Codex", () => {
    assert.equal(platformName("codex"), "Codex");
  });
  it("returns Gemini CLI", () => {
    assert.equal(platformName("gemini-cli"), "Gemini CLI");
  });
});

// ─── Codex & Gemini Rules ───────────────────────────────────

describe("Codex rules install", () => {
  it("appends rules to AGENTS.md", () => {
    const rulesPath = tmpPath("codex-agents") + ".md";
    fs.writeFileSync(rulesPath, "# My AGENTS.md\n\nAlways run tests.\n");
    const p = mockPlatform({ platform: "codex", rulesPath });
    const r = installRules(p, { content: RULES_CONTENT, version: "1.0.0", marker: "test" });
    assert.equal(r.action, "created");
    const content = fs.readFileSync(rulesPath, "utf-8");
    assert.ok(content.includes("Always run tests"), "original content preserved");
    assert.ok(content.includes("test:v1.0.0"), "marker present");
    cleanup(rulesPath);
  });
});

describe("Gemini CLI rules install", () => {
  it("appends rules to GEMINI.md", () => {
    const rulesPath = tmpPath("gemini-rules") + ".md";
    fs.writeFileSync(rulesPath, "# My Gemini Rules\n\nPrefer TypeScript.\n");
    const p = mockPlatform({ platform: "gemini-cli", rulesPath });
    const r = installRules(p, { content: RULES_CONTENT, version: "1.0.0", marker: "test" });
    assert.equal(r.action, "created");
    const content = fs.readFileSync(rulesPath, "utf-8");
    assert.ok(content.includes("Prefer TypeScript"), "original content preserved");
    assert.ok(content.includes("test:v1.0.0"), "marker present");
    cleanup(rulesPath);
  });
});

// ─── Equip Class (Codex & Gemini) ───────────────────────────

describe("Equip class (Codex)", () => {
  it("buildConfig uses http_headers for codex", () => {
    const e = new Equip({ name: "test", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("codex", "key123");
    assert.equal(config.url, "https://example.com/mcp");
    assert.equal(config.http_headers.Authorization, "Bearer key123");
    assert.ok(!config.headers);
  });

  it("installMcp and readMcp roundtrip with TOML", () => {
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
});

// ─── CLI Dispatcher ─────────────────────────────────────────

describe("equip CLI", () => {
  it("shows help with no args", () => {
    const { execSync } = require("child_process");
    const out = execSync("node bin/equip.js --help", { encoding: "utf-8", cwd: path.join(__dirname, "..") });
    assert.ok(out.includes("Available tools:"));
    assert.ok(out.includes("prior"));
  });

  it("errors on unknown tool without command", () => {
    const { execSync } = require("child_process");
    try {
      execSync("node bin/equip.js nonexistent", { encoding: "utf-8", cwd: path.join(__dirname, ".."), stdio: "pipe" });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e.stderr.includes("Usage: npx @cg3/equip"));
    }
  });
});

describe("Equip class (Gemini CLI)", () => {
  it("buildConfig uses httpUrl for gemini-cli", () => {
    const e = new Equip({ name: "test", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("gemini-cli", "key123");
    assert.equal(config.httpUrl, "https://example.com/mcp");
    assert.equal(config.headers.Authorization, "Bearer key123");
  });

  it("installMcp and readMcp roundtrip with JSON", () => {
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
});

// --- Junie -----------------------------------------------------------

describe("platformName (Junie)", () => {
  it("returns Junie", () => {
    assert.equal(platformName("junie"), "Junie");
  });
});

describe("buildHttpConfig (Junie)", () => {
  it("returns url for junie", () => {
    const config = buildHttpConfig("https://example.com/mcp", "junie");
    assert.equal(config.url, "https://example.com/mcp");
    assert.equal(config.type, undefined);
  });
});

describe("buildHttpConfigWithAuth (Junie)", () => {
  it("uses headers for junie", () => {
    const config = buildHttpConfigWithAuth("https://example.com/mcp", "key123", "junie");
    assert.equal(config.url, "https://example.com/mcp");
    assert.equal(config.headers.Authorization, "Bearer key123");
  });
});

describe("Junie MCP install (JSON)", () => {
  it("installs to mcp.json with mcpServers", () => {
    const dir = tmpPath("junie-mcp-dir");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "mcp.json");
    const p = mockPlatform({ platform: "junie", configPath, rootKey: "mcpServers", configFormat: "json" });
    installMcpJson(p, "prior", { url: "https://api.cg3.io/mcp" }, false);
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.ok(data.mcpServers.prior);
    assert.equal(data.mcpServers.prior.url, "https://api.cg3.io/mcp");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves existing Junie MCP entries", () => {
    const dir = tmpPath("junie-mcp-existing-dir");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { url: "https://other.com" } } }));
    const p = mockPlatform({ platform: "junie", configPath, rootKey: "mcpServers", configFormat: "json" });
    installMcpJson(p, "prior", { url: "https://api.cg3.io/mcp" }, false);
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(data.mcpServers.other.url, "https://other.com");
    assert.equal(data.mcpServers.prior.url, "https://api.cg3.io/mcp");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Equip class (Junie)", () => {
  it("buildConfig uses url and headers for junie", () => {
    const e = new Equip({ name: "myserver", serverUrl: "https://example.com/mcp" });
    const config = e.buildConfig("junie", "key123");
    assert.equal(config.url, "https://example.com/mcp");
    assert.equal(config.headers.Authorization, "Bearer key123");
  });

  it("installMcp and readMcp roundtrip with JSON", () => {
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
});

describe("createManualPlatform (Junie)", () => {
  it("returns correct config for junie", () => {
    const p = createManualPlatform("junie");
    assert.equal(p.platform, "junie");
    assert.equal(p.rootKey, "mcpServers");
    assert.equal(p.configFormat, "json");
    assert.ok(p.configPath.includes(".junie"));
    assert.equal(p.rulesPath, null);
  });
});

// --- Copilot (JetBrains) ------------------------------------------------

describe("platformName (Copilot JetBrains)", () => {
  it("returns Copilot (JetBrains)", () => {
    assert.equal(platformName("copilot-jetbrains"), "Copilot (JetBrains)");
  });
});

describe("buildHttpConfig (Copilot JetBrains)", () => {
  it("returns url for copilot-jetbrains", () => {
    const config = buildHttpConfig("https://example.com/mcp", "copilot-jetbrains");
    assert.equal(config.url, "https://example.com/mcp");
    assert.equal(config.type, undefined);
  });
});

describe("Copilot JetBrains MCP install (JSON)", () => {
  it("installs and preserves entries", () => {
    const dir = tmpPath("copilot-jb-dir");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { url: "https://other.com" } } }));
    const p = mockPlatform({ platform: "copilot-jetbrains", configPath, rootKey: "mcpServers", configFormat: "json" });
    installMcpJson(p, "prior", { url: "https://api.cg3.io/mcp" }, false);
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(data.mcpServers.other.url, "https://other.com");
    assert.equal(data.mcpServers.prior.url, "https://api.cg3.io/mcp");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Equip class (Copilot JetBrains)", () => {
  it("installMcp and readMcp roundtrip", () => {
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
});

describe("createManualPlatform (Copilot JetBrains)", () => {
  it("returns correct config", () => {
    const p = createManualPlatform("copilot-jetbrains");
    assert.equal(p.platform, "copilot-jetbrains");
    assert.equal(p.rootKey, "mcpServers");
    assert.equal(p.configFormat, "json");
    assert.ok(p.configPath.includes("github-copilot"));
    assert.equal(p.rulesPath, null);
  });
});

// --- Copilot CLI ---------------------------------------------------------

describe("platformName (Copilot CLI)", () => {
  it("returns Copilot CLI", () => {
    assert.equal(platformName("copilot-cli"), "Copilot CLI");
  });
});

describe("buildHttpConfig (Copilot CLI)", () => {
  it("returns url for copilot-cli", () => {
    const config = buildHttpConfig("https://example.com/mcp", "copilot-cli");
    assert.equal(config.url, "https://example.com/mcp");
  });
});

describe("Copilot CLI MCP install (JSON)", () => {
  it("installs to mcp-config.json", () => {
    const dir = tmpPath("copilot-cli-dir");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "mcp-config.json");
    const p = mockPlatform({ platform: "copilot-cli", configPath, rootKey: "mcpServers", configFormat: "json" });
    installMcpJson(p, "prior", { url: "https://api.cg3.io/mcp" }, false);
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(data.mcpServers.prior.url, "https://api.cg3.io/mcp");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Equip class (Copilot CLI)", () => {
  it("installMcp and readMcp roundtrip", () => {
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

describe("createManualPlatform (Copilot CLI)", () => {
  it("returns correct config", () => {
    const p = createManualPlatform("copilot-cli");
    assert.equal(p.platform, "copilot-cli");
    assert.equal(p.rootKey, "mcpServers");
    assert.equal(p.configFormat, "json");
    assert.ok(p.configPath.includes(".copilot"));
    assert.equal(p.rulesPath, null);
  });
});
