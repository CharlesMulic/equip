// @cg3/equip — Universal MCP + behavioral rules installer for AI coding agents.
// Zero dependencies. Works with Claude Code, Cursor, Windsurf, VS Code, Cline, Roo Code, Codex, Gemini CLI.

"use strict";

const path = require("path");
const os = require("os");

const { detectPlatforms, whichSync, dirExists, fileExists } = require("./lib/detect");
const { readMcpEntry, buildHttpConfig, buildHttpConfigWithAuth, buildStdioConfig, installMcp, installMcpJson, installMcpToml, uninstallMcp, updateMcpKey, parseTomlServerEntry, parseTomlSubTables, buildTomlEntry, removeTomlEntry } = require("./lib/mcp");
const { parseRulesVersion, installRules, uninstallRules, markerPatterns } = require("./lib/rules");
const { getHookCapabilities, installHooks, uninstallHooks, hasHooks, buildHooksConfig } = require("./lib/hooks");
const { createManualPlatform, platformName, KNOWN_PLATFORMS } = require("./lib/platforms");
const cli = require("./lib/cli");

/**
 * Equip — configure AI coding tools with your MCP server and behavioral rules.
 *
 * @example
 * const equip = new Equip({
 *   name: "prior",
 *   serverUrl: "https://api.cg3.io/mcp",
 *   rules: { content: "...", version: "0.5.3", marker: "prior" },
 * });
 * const platforms = equip.detect();
 * await equip.install(platforms, { apiKey: "ask_xxx" });
 */
class Equip {
  /**
   * @param {object} config
   * @param {string} config.name - Server name in MCP configs (e.g., "prior")
   * @param {string} config.serverUrl - Remote MCP server URL
   * @param {object} [config.rules] - Behavioral rules config
   * @param {string} config.rules.content - Rules markdown content (with markers)
   * @param {string} config.rules.version - Version string for marker tracking
   * @param {string} config.rules.marker - Marker name (e.g., "prior")
   * @param {string} [config.rules.fileName] - Standalone file name for file-based platforms (e.g., "prior.md")
   * @param {string[]} [config.rules.clipboardPlatforms] - Platforms using clipboard (default: ["cursor", "vscode"])
   * @param {object} [config.stdio] - Stdio transport config (alternative to HTTP)
   * @param {string} config.stdio.command - Command to run
   * @param {string[]} config.stdio.args - Command arguments
   * @param {string} config.stdio.envKey - Env var name for API key
   * @param {Array} [config.hooks] - Lifecycle hook definitions
   * @param {string} config.hooks[].event - Hook event name (e.g., "PostToolUseFailure")
   * @param {string} [config.hooks[].matcher] - Regex matcher for event filtering (e.g., "Bash")
   * @param {string} config.hooks[].script - Hook script content (Node.js)
   * @param {string} config.hooks[].name - Script filename (without .js extension)
   * @param {string} [config.hookDir] - Directory for hook scripts (default: ~/.${name}/hooks)
   */
  constructor(config) {
    if (!config.name) throw new Error("Equip: name is required");
    if (!config.serverUrl && !config.stdio) throw new Error("Equip: serverUrl or stdio is required");

    this.name = config.name;
    this.serverUrl = config.serverUrl;
    this.rules = config.rules || null;
    this.stdio = config.stdio || null;
    this.hookDefs = config.hooks || null;
    this.hookDir = config.hookDir || path.join(os.homedir(), `.${config.name}`, "hooks");
  }

  /**
   * Detect installed AI coding platforms.
   * @returns {Array<object>} Platform objects
   */
  detect() {
    return detectPlatforms(this.name);
  }

  /**
   * Build MCP config for a platform.
   * @param {string} platformId - Platform id
   * @param {string} apiKey - API key
   * @param {string} [transport="http"] - "http" or "stdio"
   * @returns {object} MCP config object
   */
  buildConfig(platformId, apiKey, transport = "http") {
    if (transport === "stdio" && this.stdio) {
      const env = { [this.stdio.envKey]: apiKey };
      return buildStdioConfig(this.stdio.command, this.stdio.args, env);
    }
    return buildHttpConfigWithAuth(this.serverUrl, apiKey, platformId);
  }

  /**
   * Install MCP config on a platform.
   * @param {object} platform - Platform object from detect()
   * @param {string} apiKey - API key
   * @param {object} [options] - { transport, dryRun }
   * @returns {{ success: boolean, method: string }}
   */
  installMcp(platform, apiKey, options = {}) {
    const { transport = "http", dryRun = false } = options;
    const config = this.buildConfig(platform.platform, apiKey, transport);
    return installMcp(platform, this.name, config, { dryRun, serverUrl: this.serverUrl });
  }

  /**
   * Uninstall MCP config from a platform.
   * @param {object} platform - Platform object
   * @param {boolean} [dryRun=false]
   * @returns {boolean}
   */
  uninstallMcp(platform, dryRun = false) {
    return uninstallMcp(platform, this.name, dryRun);
  }

  /**
   * Update API key in MCP config.
   * @param {object} platform - Platform object
   * @param {string} apiKey - New API key
   * @param {string} [transport="http"]
   * @returns {{ success: boolean, method: string }}
   */
  updateMcpKey(platform, apiKey, transport = "http") {
    const config = this.buildConfig(platform.platform, apiKey, transport);
    return updateMcpKey(platform, this.name, config);
  }

  /**
   * Install behavioral rules on a platform.
   * @param {object} platform - Platform object
   * @param {object} [options] - { dryRun }
   * @returns {{ action: string }}
   */
  installRules(platform, options = {}) {
    if (!this.rules) return { action: "skipped" };
    return installRules(platform, {
      content: this.rules.content,
      version: this.rules.version,
      marker: this.rules.marker,
      fileName: this.rules.fileName,
      clipboardPlatforms: this.rules.clipboardPlatforms,
      dryRun: options.dryRun || false,
      copyToClipboard: cli.copyToClipboard,
    });
  }

  /**
   * Uninstall behavioral rules from a platform.
   * @param {object} platform - Platform object
   * @param {boolean} [dryRun=false]
   * @returns {boolean}
   */
  uninstallRules(platform, dryRun = false) {
    if (!this.rules) return false;
    return uninstallRules(platform, {
      marker: this.rules.marker,
      fileName: this.rules.fileName,
      dryRun,
    });
  }

  /**
   * Check if MCP is configured on a platform.
   * @param {object} platform - Platform object
   * @returns {object|null} Existing MCP config or null
   */
  readMcp(platform) {
    return readMcpEntry(platform.configPath, platform.rootKey, this.name, platform.configFormat || "json");
  }

  /**
   * Install lifecycle hooks on a platform (if supported).
   * Uses hook definitions from constructor config.
   * @param {object} platform - Platform object from detect()
   * @param {object} [options] - { hookDir, dryRun }
   * @returns {{ installed: boolean, scripts: string[], hookDir: string } | null}
   */
  installHooks(platform, options = {}) {
    if (!this.hookDefs) return null;
    const opts = { ...options };
    if (this.hookDir && !opts.hookDir) opts.hookDir = this.hookDir;
    return installHooks(platform, this.hookDefs, opts);
  }

  /**
   * Uninstall hooks from a platform.
   * @param {object} platform - Platform object
   * @param {object} [options] - { hookDir, dryRun }
   * @returns {boolean}
   */
  uninstallHooks(platform, options = {}) {
    if (!this.hookDefs) return false;
    const opts = { ...options };
    if (this.hookDir && !opts.hookDir) opts.hookDir = this.hookDir;
    return uninstallHooks(platform, this.hookDefs, opts);
  }

  /**
   * Check if hooks are installed on a platform.
   * @param {object} platform - Platform object
   * @param {object} [options] - { hookDir }
   * @returns {boolean}
   */
  hasHooks(platform, options = {}) {
    if (!this.hookDefs) return false;
    const opts = { ...options };
    if (this.hookDir && !opts.hookDir) opts.hookDir = this.hookDir;
    return hasHooks(platform, this.hookDefs, opts);
  }

  /**
   * Check if a platform supports hooks and this instance has hook definitions.
   * @param {object} platform - Platform object
   * @returns {boolean}
   */
  supportsHooks(platform) {
    return !!this.hookDefs && this.hookDefs.length > 0 && !!getHookCapabilities(platform.platform);
  }
}

module.exports = {
  Equip,
  // Re-export primitives for advanced usage
  detectPlatforms,
  readMcpEntry,
  buildHttpConfig,
  buildHttpConfigWithAuth,
  buildStdioConfig,
  installMcp,
  installMcpJson,
  installMcpToml,
  uninstallMcp,
  updateMcpKey,
  parseTomlServerEntry,
  parseTomlSubTables,
  buildTomlEntry,
  removeTomlEntry,
  installRules,
  uninstallRules,
  parseRulesVersion,
  markerPatterns,
  createManualPlatform,
  platformName,
  KNOWN_PLATFORMS,
  // Hooks
  getHookCapabilities,
  installHooks,
  uninstallHooks,
  hasHooks,
  buildHooksConfig,
  cli,
};
