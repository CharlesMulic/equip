// Platform path resolution and metadata.
// Zero dependencies.

"use strict";

const path = require("path");
const os = require("os");

// ─── Path Helpers ────────────────────────────────────────────

function getVsCodeUserDir() {
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Code", "User");
  return path.join(home, ".config", "Code", "User");
}

function getVsCodeMcpPath() {
  return path.join(getVsCodeUserDir(), "mcp.json");
}

function getClineConfigPath() {
  const base = getVsCodeUserDir();
  return path.join(base, "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
}

function getRooConfigPath() {
  const base = getVsCodeUserDir();
  return path.join(base, "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json");
}

function getCodexConfigPath() {
  const home = os.homedir();
  return path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
}

function getGeminiSettingsPath() {
  const home = os.homedir();
  return path.join(home, ".gemini", "settings.json");
}

function getJunieMcpPath() {
  const home = os.homedir();
  return path.join(home, ".junie", "mcp", "mcp.json");
}

function getCopilotJetBrainsMcpPath() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "github-copilot", "intellij", "mcp.json");
  }
  return path.join(home, ".config", "github-copilot", "intellij", "mcp.json");
}

function getCopilotCliMcpPath() {
  const home = os.homedir();
  return path.join(home, ".copilot", "mcp-config.json");
}

// ─── Platform Registry ──────────────────────────────────────

/**
 * Returns platform definition for manual override.
 * @param {string} platformId
 * @returns {object} Platform object with configPath, rulesPath, rootKey, etc.
 */
function createManualPlatform(platformId) {
  const home = os.homedir();
  const configs = {
    "claude-code": {
      configPath: path.join(home, ".claude", "settings.json"),
      rulesPath: path.join(home, ".claude", "CLAUDE.md"),
      rootKey: "mcpServers",
      configFormat: "json",
    },
    cursor: {
      configPath: path.join(home, ".cursor", "mcp.json"),
      rulesPath: null,
      rootKey: "mcpServers",
      configFormat: "json",
    },
    windsurf: {
      configPath: path.join(home, ".codeium", "windsurf", "mcp_config.json"),
      rulesPath: path.join(home, ".codeium", "windsurf", "memories", "global_rules.md"),
      rootKey: "mcpServers",
      configFormat: "json",
    },
    vscode: {
      configPath: getVsCodeMcpPath(),
      rulesPath: null,
      rootKey: "servers",
      configFormat: "json",
    },
    cline: {
      configPath: getClineConfigPath(),
      rulesPath: path.join(home, "Documents", "Cline", "Rules"),
      rootKey: "mcpServers",
      configFormat: "json",
    },
    "roo-code": {
      configPath: getRooConfigPath(),
      rulesPath: path.join(home, ".roo", "rules"),
      rootKey: "mcpServers",
      configFormat: "json",
    },
    codex: {
      configPath: getCodexConfigPath(),
      rulesPath: path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "AGENTS.md"),
      rootKey: "mcp_servers",
      configFormat: "toml",
    },
    "gemini-cli": {
      configPath: getGeminiSettingsPath(),
      rulesPath: path.join(home, ".gemini", "GEMINI.md"),
      rootKey: "mcpServers",
      configFormat: "json",
    },
    junie: {
      configPath: getJunieMcpPath(),
      rulesPath: null,
      rootKey: "mcpServers",
      configFormat: "json",
    },
    "copilot-jetbrains": {
      configPath: getCopilotJetBrainsMcpPath(),
      rulesPath: null,
      rootKey: "mcpServers",
      configFormat: "json",
    },
    "copilot-cli": {
      configPath: getCopilotCliMcpPath(),
      rulesPath: null,
      rootKey: "mcpServers",
      configFormat: "json",
    },
  };

  const def = configs[platformId];
  if (!def) {
    throw new Error(`Unknown platform: ${platformId}. Supported: ${Object.keys(configs).join(", ")}`);
  }

  return { platform: platformId, version: "unknown", hasCli: false, existingMcp: null, ...def };
}

/**
 * Display name for a platform id.
 */
function platformName(id) {
  const names = {
    "claude-code": "Claude Code",
    cursor: "Cursor",
    windsurf: "Windsurf",
    vscode: "VS Code",
    cline: "Cline",
    "roo-code": "Roo Code",
    codex: "Codex",
    "gemini-cli": "Gemini CLI",
    junie: "Junie",
    "copilot-jetbrains": "Copilot (JetBrains)",
    "copilot-cli": "Copilot CLI",
  };
  return names[id] || id;
}

/**
 * All known platform IDs.
 */
const KNOWN_PLATFORMS = ["claude-code", "cursor", "windsurf", "vscode", "cline", "roo-code", "codex", "gemini-cli", "junie", "copilot-jetbrains", "copilot-cli"];

module.exports = {
  getVsCodeUserDir,
  getVsCodeMcpPath,
  getClineConfigPath,
  getRooConfigPath,
  getCodexConfigPath,
  getGeminiSettingsPath,
  getJunieMcpPath,
  getCopilotJetBrainsMcpPath,
  getCopilotCliMcpPath,
  createManualPlatform,
  platformName,
  KNOWN_PLATFORMS,
};
