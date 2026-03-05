// Platform detection — discovers installed AI coding tools.
// Zero dependencies.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { getVsCodeMcpPath, getVsCodeUserDir, getClineConfigPath, getRooConfigPath, getCodexConfigPath, getGeminiSettingsPath, getJunieMcpPath, getCopilotJetBrainsMcpPath, getCopilotCliMcpPath } = require("./platforms");
const { readMcpEntry } = require("./mcp");

// ─── Helpers ─────────────────────────────────────────────────

function whichSync(cmd) {
  try {
    const r = execSync(process.platform === "win32" ? `where ${cmd} 2>nul` : `which ${cmd} 2>/dev/null`, { encoding: "utf-8", timeout: 5000 });
    return r.trim().split(/\r?\n/)[0] || null;
  } catch { return null; }
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function cliVersion(cmd, regex) {
  try {
    const out = execSync(`${cmd} --version 2>&1`, { encoding: "utf-8", timeout: 5000 });
    const m = out.match(regex || /(\d+\.\d+[\.\d]*)/);
    return m ? m[1] : "unknown";
  } catch { return null; }
}

function getClaudeCodeVersion() {
  try {
    const out = execSync("claude --version 2>&1", { encoding: "utf-8", timeout: 5000 });
    const m = out.match(/(\d+\.\d+[\.\d]*)/);
    return m ? m[1] : "unknown";
  } catch { return null; }
}

// ─── Detection ──────────────────────────────────────────────

/**
 * Detect installed AI coding platforms.
 * @param {string} [serverName] - MCP server name to check for existing config (default: null)
 * @returns {Array<object>} Array of platform objects
 */
function detectPlatforms(serverName) {
  const home = os.homedir();
  const platforms = [];

  // Claude Code
  const claudeVersion = whichSync("claude") ? getClaudeCodeVersion() : null;
  if (claudeVersion || dirExists(path.join(home, ".claude"))) {
    const configPath = path.join(home, ".claude", "settings.json");
    const rulesPath = path.join(home, ".claude", "CLAUDE.md");
    platforms.push({
      platform: "claude-code",
      version: claudeVersion || "unknown",
      configPath,
      rulesPath,
      existingMcp: serverName ? readMcpEntry(configPath, "mcpServers", serverName) : null,
      hasCli: !!whichSync("claude"),
      rootKey: "mcpServers",
      configFormat: "json",
    });
  }

  // Cursor
  const cursorDir = path.join(home, ".cursor");
  if (whichSync("cursor") || dirExists(cursorDir)) {
    const configPath = path.join(cursorDir, "mcp.json");
    platforms.push({
      platform: "cursor",
      version: cliVersion("cursor") || "unknown",
      configPath,
      rulesPath: null, // Cursor: clipboard only
      existingMcp: serverName ? readMcpEntry(configPath, "mcpServers", serverName) : null,
      hasCli: !!whichSync("cursor"),
      rootKey: "mcpServers",
      configFormat: "json",
    });
  }

  // Windsurf
  const windsurfDir = path.join(home, ".codeium", "windsurf");
  if (dirExists(windsurfDir)) {
    const configPath = path.join(windsurfDir, "mcp_config.json");
    const rulesPath = path.join(windsurfDir, "memories", "global_rules.md");
    platforms.push({
      platform: "windsurf",
      version: "unknown",
      configPath,
      rulesPath,
      existingMcp: serverName ? readMcpEntry(configPath, "mcpServers", serverName) : null,
      hasCli: false,
      rootKey: "mcpServers",
      configFormat: "json",
    });
  }

  // VS Code (Copilot)
  const vscodeMcpPath = getVsCodeMcpPath();
  if (whichSync("code") || fileExists(vscodeMcpPath) || dirExists(getVsCodeUserDir())) {
    platforms.push({
      platform: "vscode",
      version: cliVersion("code") || "unknown",
      configPath: vscodeMcpPath,
      rulesPath: null, // VS Code: clipboard only
      existingMcp: serverName ? readMcpEntry(vscodeMcpPath, "servers", serverName) : null,
      hasCli: !!whichSync("code"),
      rootKey: "servers",
      configFormat: "json",
    });
  }

  // Cline (VS Code extension)
  const clineConfigPath = getClineConfigPath();
  if (fileExists(clineConfigPath) || dirExists(path.dirname(clineConfigPath))) {
    const home_ = os.homedir();
    platforms.push({
      platform: "cline",
      version: "unknown",
      configPath: clineConfigPath,
      rulesPath: path.join(home_, "Documents", "Cline", "Rules"),
      existingMcp: serverName ? readMcpEntry(clineConfigPath, "mcpServers", serverName) : null,
      hasCli: false,
      rootKey: "mcpServers",
      configFormat: "json",
    });
  }

  // Roo Code (VS Code extension)
  const rooConfigPath = getRooConfigPath();
  if (fileExists(rooConfigPath) || dirExists(path.dirname(rooConfigPath))) {
    platforms.push({
      platform: "roo-code",
      version: "unknown",
      configPath: rooConfigPath,
      rulesPath: path.join(os.homedir(), ".roo", "rules"),
      existingMcp: serverName ? readMcpEntry(rooConfigPath, "mcpServers", serverName) : null,
      hasCli: false,
      rootKey: "mcpServers",
      configFormat: "json",
    });
  }

  // Codex (OpenAI CLI)
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const codexConfigPath = getCodexConfigPath();
  if (whichSync("codex") || dirExists(codexHome)) {
    platforms.push({
      platform: "codex",
      version: cliVersion("codex") || "unknown",
      configPath: codexConfigPath,
      rulesPath: path.join(codexHome, "AGENTS.md"),
      existingMcp: serverName ? readMcpEntry(codexConfigPath, "mcp_servers", serverName, "toml") : null,
      hasCli: !!whichSync("codex"),
      rootKey: "mcp_servers",
      configFormat: "toml",
    });
  }

  // Gemini CLI (Google)
  const geminiDir = path.join(home, ".gemini");
  const geminiSettingsPath = getGeminiSettingsPath();
  if (whichSync("gemini") || dirExists(geminiDir)) {
    platforms.push({
      platform: "gemini-cli",
      version: cliVersion("gemini") || "unknown",
      configPath: geminiSettingsPath,
      rulesPath: path.join(geminiDir, "GEMINI.md"),
      existingMcp: serverName ? readMcpEntry(geminiSettingsPath, "mcpServers", serverName) : null,
      hasCli: !!whichSync("gemini"),
      rootKey: "mcpServers",
      configFormat: "json",
    });
  }

  // Junie (JetBrains CLI)
  const junieDir = path.join(home, ".junie");
  const junieMcpPath = getJunieMcpPath();
  if (whichSync("junie") || dirExists(junieDir)) {
    platforms.push({
      platform: "junie",
      version: cliVersion("junie") || "unknown",
      configPath: junieMcpPath,
      rulesPath: null,
      existingMcp: serverName ? readMcpEntry(junieMcpPath, "mcpServers", serverName) : null,
      hasCli: !!whichSync("junie"),
      rootKey: "mcpServers",
      configFormat: "json",
    });
  }

  // GitHub Copilot in JetBrains IDEs
  const copilotJbPath = getCopilotJetBrainsMcpPath();
  const copilotJbDir = path.dirname(path.dirname(copilotJbPath)); // github-copilot dir
  if (dirExists(copilotJbDir)) {
    platforms.push({
      platform: "copilot-jetbrains",
      version: "unknown",
      configPath: copilotJbPath,
      rulesPath: null,
      existingMcp: serverName ? readMcpEntry(copilotJbPath, "mcpServers", serverName) : null,
      hasCli: false,
      rootKey: "mcpServers",
      configFormat: "json",
    });
  }

  // GitHub Copilot CLI
  const copilotCliDir = path.join(home, ".copilot");
  const copilotCliMcpPath = getCopilotCliMcpPath();
  if (whichSync("copilot") || dirExists(copilotCliDir)) {
    platforms.push({
      platform: "copilot-cli",
      version: cliVersion("copilot") || "unknown",
      configPath: copilotCliMcpPath,
      rulesPath: null,
      existingMcp: serverName ? readMcpEntry(copilotCliMcpPath, "mcpServers", serverName) : null,
      hasCli: !!whichSync("copilot"),
      rootKey: "mcpServers",
      configFormat: "json",
    });
  }

  return platforms;
}

module.exports = {
  detectPlatforms,
  whichSync,
  dirExists,
  fileExists,
  cliVersion,
};
