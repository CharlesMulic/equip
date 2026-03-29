// Platform registry — single source of truth for all platform-specific knowledge.
// Zero dependencies.

import * as path from "path";
import * as os from "os";

// ─── Types ───────────────────────────────────────────────────

export interface PlatformHttpShape {
  /** Field name for the server URL */
  urlField: "url" | "serverUrl" | "httpUrl";
  /** Optional type field value (e.g., "http", "streamable-http") */
  typeField?: string;
  /** Key name for auth headers */
  headersField: "headers" | "http_headers";
}

export interface PlatformDetection {
  /** CLI command name to check with `which` */
  cli: string | null;
  /** Directories whose existence indicates the platform is installed */
  dirs: (() => string)[];
  /** Files whose existence indicates the platform is installed */
  files: (() => string)[];
  /** Custom version detection function (overrides default `cli --version`) */
  versionFn?: () => string | null;
}

export interface PlatformHookCapabilities {
  settingsPath: () => string;
  events: string[];
  format: string;
}

export interface PlatformCliInstall {
  /** Build CLI install command args. Returns null if CLI doesn't support this transport. */
  buildArgs: (serverName: string, mcpEntry: Record<string, unknown>) => string[] | null;
}

export interface PlatformDefinition {
  id: string;
  name: string;
  aliases: string[];
  configPath: () => string;
  rulesPath: (() => string) | null;
  rootKey: string;
  configFormat: "json" | "toml";
  httpShape: PlatformHttpShape;
  detection: PlatformDetection;
  hooks: PlatformHookCapabilities | null;
  cliInstall: PlatformCliInstall | null;
}

/** The shape returned by detect() and createManualPlatform() */
export interface DetectedPlatform {
  platform: string;
  version: string;
  configPath: string;
  rulesPath: string | null;
  existingMcp: Record<string, unknown> | null;
  hasCli: boolean;
  rootKey: string;
  configFormat: "json" | "toml";
}

// ─── Path Helpers ────────────────────────────────────────────

function home(): string { return os.homedir(); }

function vsCodeUserDir(): string {
  const h = home();
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(h, "AppData", "Roaming"), "Code", "User");
  if (process.platform === "darwin") return path.join(h, "Library", "Application Support", "Code", "User");
  return path.join(h, ".config", "Code", "User");
}

function copilotJetBrainsDir(): string {
  const h = home();
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(h, "AppData", "Roaming"), "github-copilot");
  return path.join(h, ".config", "github-copilot");
}

// ─── Claude Code version detection ──────────────────────────

function getClaudeCodeVersion(): string | null {
  try {
    const { execSync } = require("child_process");
    const out = execSync("claude --version 2>&1", { encoding: "utf-8", timeout: 5000 }) as string;
    const m = out.match(/(\d+\.\d+[\.\d]*)/);
    return m ? m[1] : "unknown";
  } catch { return null; }
}

// ─── CLI Install Helpers ────────────────────────────────────

function claudeCliArgs(serverName: string, mcpEntry: Record<string, unknown>): string[] | null {
  if (!mcpEntry.url) return null;
  const args = ["mcp", "add", "--transport", "http", "-s", "user"];
  if (mcpEntry.headers && typeof mcpEntry.headers === "object") {
    for (const [k, v] of Object.entries(mcpEntry.headers as Record<string, string>)) {
      args.push("--header", `${k}: ${v}`);
    }
  }
  args.push(serverName, mcpEntry.url as string);
  return args;
}

function cursorCliArgs(serverName: string, mcpEntry: Record<string, unknown>): string[] | null {
  const json = JSON.stringify({ name: serverName, ...mcpEntry });
  return ["--add-mcp", json];
}

function vscodeCliArgs(serverName: string, mcpEntry: Record<string, unknown>): string[] | null {
  const json = JSON.stringify({ name: serverName, ...mcpEntry });
  return ["--add-mcp", json];
}

function codexCliArgs(serverName: string, mcpEntry: Record<string, unknown>): string[] | null {
  // Codex CLI only supports stdio install, not HTTP
  if (!mcpEntry.command) return null;
  return ["mcp", "add", serverName, "--", mcpEntry.command as string, ...((mcpEntry.args as string[]) || [])];
}

// ─── Registry ───────────────────────────────────────────────

const CLAUDE_CODE_HOOKS_EVENTS = [
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop",
  "SessionStart", "SessionEnd", "UserPromptSubmit", "Notification",
  "SubagentStart", "SubagentStop", "PreCompact", "TaskCompleted",
];

export const PLATFORM_REGISTRY: ReadonlyMap<string, PlatformDefinition> = new Map<string, PlatformDefinition>([
  ["claude-code", {
    id: "claude-code",
    name: "Claude Code",
    aliases: ["claude", "claudecode"],
    configPath: () => path.join(home(), ".claude.json"),
    rulesPath: () => path.join(home(), ".claude", "CLAUDE.md"),
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", typeField: "http", headersField: "headers" },
    detection: {
      cli: "claude",
      dirs: [() => path.join(home(), ".claude")],
      files: [],
      versionFn: getClaudeCodeVersion,
    },
    hooks: {
      settingsPath: () => path.join(home(), ".claude", "settings.json"),
      events: CLAUDE_CODE_HOOKS_EVENTS,
      format: "claude-code",
    },
    cliInstall: { buildArgs: claudeCliArgs },
  }],
  ["cursor", {
    id: "cursor",
    name: "Cursor",
    aliases: [],
    configPath: () => path.join(home(), ".cursor", "mcp.json"),
    rulesPath: null,
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", typeField: "streamable-http", headersField: "headers" },
    detection: {
      cli: "cursor",
      dirs: [() => path.join(home(), ".cursor")],
      files: [],
    },
    hooks: null,
    cliInstall: { buildArgs: cursorCliArgs },
  }],
  ["windsurf", {
    id: "windsurf",
    name: "Windsurf",
    aliases: [],
    configPath: () => path.join(home(), ".codeium", "windsurf", "mcp_config.json"),
    rulesPath: () => path.join(home(), ".codeium", "windsurf", "memories", "global_rules.md"),
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "serverUrl", headersField: "headers" },
    detection: {
      cli: null,
      dirs: [() => path.join(home(), ".codeium", "windsurf")],
      files: [],
    },
    hooks: null,
    cliInstall: null,
  }],
  ["vscode", {
    id: "vscode",
    name: "VS Code",
    aliases: ["vs-code", "code"],
    configPath: () => path.join(vsCodeUserDir(), "mcp.json"),
    rulesPath: null,
    rootKey: "servers",
    configFormat: "json",
    httpShape: { urlField: "url", typeField: "http", headersField: "headers" },
    detection: {
      cli: "code",
      dirs: [() => vsCodeUserDir()],
      files: [() => path.join(vsCodeUserDir(), "mcp.json")],
    },
    hooks: null,
    cliInstall: { buildArgs: vscodeCliArgs },
  }],
  ["cline", {
    id: "cline",
    name: "Cline",
    aliases: [],
    configPath: () => path.join(vsCodeUserDir(), "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
    rulesPath: () => path.join(home(), "Documents", "Cline", "Rules"),
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", headersField: "headers" },
    detection: {
      cli: null,
      dirs: [],
      files: [() => path.join(vsCodeUserDir(), "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")],
    },
    hooks: null,
    cliInstall: null,
  }],
  ["roo-code", {
    id: "roo-code",
    name: "Roo Code",
    aliases: ["roo", "roocode"],
    configPath: () => path.join(vsCodeUserDir(), "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json"),
    rulesPath: () => path.join(home(), ".roo", "rules"),
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", headersField: "headers" },
    detection: {
      cli: null,
      dirs: [],
      files: [() => path.join(vsCodeUserDir(), "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json")],
    },
    hooks: null,
    cliInstall: null,
  }],
  ["codex", {
    id: "codex",
    name: "Codex",
    aliases: [],
    configPath: () => path.join(process.env.CODEX_HOME || path.join(home(), ".codex"), "config.toml"),
    rulesPath: () => path.join(process.env.CODEX_HOME || path.join(home(), ".codex"), "AGENTS.md"),
    rootKey: "mcp_servers",
    configFormat: "toml",
    httpShape: { urlField: "url", headersField: "http_headers" },
    detection: {
      cli: "codex",
      dirs: [() => process.env.CODEX_HOME || path.join(home(), ".codex")],
      files: [],
    },
    hooks: null,
    cliInstall: { buildArgs: codexCliArgs },
  }],
  ["gemini-cli", {
    id: "gemini-cli",
    name: "Gemini CLI",
    aliases: ["gemini"],
    configPath: () => path.join(home(), ".gemini", "settings.json"),
    rulesPath: () => path.join(home(), ".gemini", "GEMINI.md"),
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "httpUrl", headersField: "headers" },
    detection: {
      cli: "gemini",
      dirs: [() => path.join(home(), ".gemini")],
      files: [],
    },
    hooks: null,
    cliInstall: null,
  }],
  ["junie", {
    id: "junie",
    name: "Junie",
    aliases: [],
    configPath: () => path.join(home(), ".junie", "mcp", "mcp.json"),
    rulesPath: null,
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", headersField: "headers" },
    detection: {
      cli: "junie",
      dirs: [() => path.join(home(), ".junie")],
      files: [],
    },
    hooks: null,
    cliInstall: null,
  }],
  ["copilot-jetbrains", {
    id: "copilot-jetbrains",
    name: "Copilot (JetBrains)",
    aliases: ["copilot-jb"],
    configPath: () => path.join(copilotJetBrainsDir(), "intellij", "mcp.json"),
    rulesPath: null,
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", headersField: "headers" },
    detection: {
      cli: null,
      dirs: [() => copilotJetBrainsDir()],
      files: [],
    },
    hooks: null,
    cliInstall: null,
  }],
  ["copilot-cli", {
    id: "copilot-cli",
    name: "Copilot CLI",
    aliases: ["copilot"],
    configPath: () => path.join(home(), ".copilot", "mcp-config.json"),
    rulesPath: null,
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", headersField: "headers" },
    detection: {
      cli: "copilot",
      dirs: [() => path.join(home(), ".copilot")],
      files: [],
    },
    hooks: null,
    cliInstall: null,
  }],
]);

// ─── Derived Helpers ────────────────────────────────────────

export const KNOWN_PLATFORMS: string[] = [...PLATFORM_REGISTRY.keys()];

export function platformName(id: string): string {
  return PLATFORM_REGISTRY.get(id)?.name ?? id;
}

export function resolvePlatformId(input: string): string {
  const s = input.trim().toLowerCase();
  if (PLATFORM_REGISTRY.has(s)) return s;
  for (const [id, def] of PLATFORM_REGISTRY) {
    if (def.aliases.includes(s)) return id;
  }
  return s;
}

export function getPlatform(id: string): PlatformDefinition {
  const def = PLATFORM_REGISTRY.get(id);
  if (!def) throw new Error(`Unknown platform: ${id}. Supported: ${KNOWN_PLATFORMS.join(", ")}`);
  return def;
}

export function createManualPlatform(platformId: string): DetectedPlatform {
  const def = getPlatform(platformId);
  return {
    platform: def.id,
    version: "unknown",
    configPath: def.configPath(),
    rulesPath: def.rulesPath ? def.rulesPath() : null,
    existingMcp: null,
    hasCli: false,
    rootKey: def.rootKey,
    configFormat: def.configFormat,
  };
}

// ─── Backward-compat path exports ───────────────────────────

export function getVsCodeUserDir(): string { return vsCodeUserDir(); }
export function getVsCodeMcpPath(): string { return PLATFORM_REGISTRY.get("vscode")!.configPath(); }
export function getClineConfigPath(): string { return PLATFORM_REGISTRY.get("cline")!.configPath(); }
export function getRooConfigPath(): string { return PLATFORM_REGISTRY.get("roo-code")!.configPath(); }
export function getCodexConfigPath(): string { return PLATFORM_REGISTRY.get("codex")!.configPath(); }
export function getGeminiSettingsPath(): string { return PLATFORM_REGISTRY.get("gemini-cli")!.configPath(); }
export function getJunieMcpPath(): string { return PLATFORM_REGISTRY.get("junie")!.configPath(); }
export function getCopilotJetBrainsMcpPath(): string { return PLATFORM_REGISTRY.get("copilot-jetbrains")!.configPath(); }
export function getCopilotCliMcpPath(): string { return PLATFORM_REGISTRY.get("copilot-cli")!.configPath(); }
