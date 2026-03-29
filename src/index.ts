// @cg3/equip — Universal MCP + behavioral rules installer for AI coding agents.
// Zero dependencies. Works with Claude Code, Cursor, Windsurf, VS Code, Cline, Roo Code, Codex, Gemini CLI.

import * as path from "path";
import * as os from "os";

import { detectPlatforms, whichSync, dirExists, fileExists } from "./lib/detect";
import { readMcpEntry, buildHttpConfig, buildHttpConfigWithAuth, buildStdioConfig, installMcp, installMcpJson, installMcpToml, uninstallMcp, updateMcpKey, parseTomlServerEntry, parseTomlSubTables, buildTomlEntry, removeTomlEntry } from "./lib/mcp";
import { parseRulesVersion, installRules, uninstallRules, markerPatterns } from "./lib/rules";
import { getHookCapabilities, installHooks, uninstallHooks, hasHooks, buildHooksConfig, type HookDefinition } from "./lib/hooks";
import { createManualPlatform, platformName, resolvePlatformId, KNOWN_PLATFORMS, PLATFORM_REGISTRY, getPlatform, type DetectedPlatform, type PlatformDefinition, type PlatformHttpShape, type PlatformHookCapabilities } from "./lib/platforms";
import { getVsCodeUserDir, getVsCodeMcpPath, getClineConfigPath, getRooConfigPath, getCodexConfigPath, getGeminiSettingsPath, getJunieMcpPath, getCopilotJetBrainsMcpPath, getCopilotCliMcpPath } from "./lib/platforms";
import * as cli from "./lib/cli";

// ─── Equip Class ────────────────────────────────────────────

export interface EquipConfig {
  name: string;
  serverUrl?: string;
  rules?: {
    content: string;
    version: string;
    marker: string;
    fileName?: string;
    clipboardPlatforms?: string[];
  };
  stdio?: {
    command: string;
    args: string[];
    envKey: string;
  };
  hooks?: HookDefinition[];
  hookDir?: string;
}

/**
 * Equip — configure AI coding tools with your MCP server and behavioral rules.
 */
class Equip {
  name: string;
  serverUrl?: string;
  rules: EquipConfig["rules"] | null;
  stdio: EquipConfig["stdio"] | null;
  hookDefs: HookDefinition[] | null;
  hookDir: string;

  constructor(config: EquipConfig) {
    if (!config.name) throw new Error("Equip: name is required");
    if (!config.serverUrl && !config.stdio) throw new Error("Equip: serverUrl or stdio is required");

    this.name = config.name;
    this.serverUrl = config.serverUrl;
    this.rules = config.rules || null;
    this.stdio = config.stdio || null;
    this.hookDefs = config.hooks || null;
    this.hookDir = config.hookDir || path.join(os.homedir(), `.${config.name}`, "hooks");
  }

  detect(): DetectedPlatform[] {
    return detectPlatforms(this.name);
  }

  buildConfig(platformId: string, apiKey: string, transport: string = "http"): Record<string, unknown> {
    if (transport === "stdio" && this.stdio) {
      const env = { [this.stdio.envKey]: apiKey };
      return buildStdioConfig(this.stdio.command, this.stdio.args, env);
    }
    return buildHttpConfigWithAuth(this.serverUrl!, apiKey, platformId);
  }

  installMcp(platform: DetectedPlatform, apiKey: string, options: { transport?: string; dryRun?: boolean } = {}): { success: boolean; method: string } {
    const { transport = "http", dryRun = false } = options;
    const config = this.buildConfig(platform.platform, apiKey, transport);
    return installMcp(platform, this.name, config, { dryRun, serverUrl: this.serverUrl });
  }

  uninstallMcp(platform: DetectedPlatform, dryRun: boolean = false): boolean {
    return uninstallMcp(platform, this.name, dryRun);
  }

  updateMcpKey(platform: DetectedPlatform, apiKey: string, transport: string = "http"): { success: boolean; method: string } {
    const config = this.buildConfig(platform.platform, apiKey, transport);
    return updateMcpKey(platform, this.name, config);
  }

  installRules(platform: DetectedPlatform, options: { dryRun?: boolean } = {}): { action: string } {
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

  uninstallRules(platform: DetectedPlatform, dryRun: boolean = false): boolean {
    if (!this.rules) return false;
    return uninstallRules(platform, {
      marker: this.rules.marker,
      fileName: this.rules.fileName,
      dryRun,
    });
  }

  readMcp(platform: DetectedPlatform): Record<string, unknown> | null {
    return readMcpEntry(platform.configPath, platform.rootKey, this.name, platform.configFormat || "json");
  }

  installHooks(platform: DetectedPlatform, options: { hookDir?: string; dryRun?: boolean } = {}): { installed: boolean; scripts: string[]; hookDir: string } | null {
    if (!this.hookDefs) return null;
    const opts = { ...options };
    if (this.hookDir && !opts.hookDir) opts.hookDir = this.hookDir;
    return installHooks(platform, this.hookDefs, opts);
  }

  uninstallHooks(platform: DetectedPlatform, options: { hookDir?: string; dryRun?: boolean } = {}): boolean {
    if (!this.hookDefs) return false;
    const opts = { ...options };
    if (this.hookDir && !opts.hookDir) opts.hookDir = this.hookDir;
    return uninstallHooks(platform, this.hookDefs, opts);
  }

  hasHooks(platform: DetectedPlatform, options: { hookDir?: string } = {}): boolean {
    if (!this.hookDefs) return false;
    const opts = { ...options };
    if (this.hookDir && !opts.hookDir) opts.hookDir = this.hookDir;
    return hasHooks(platform, this.hookDefs, opts);
  }

  supportsHooks(platform: DetectedPlatform): boolean {
    return !!this.hookDefs && this.hookDefs.length > 0 && !!getHookCapabilities(platform.platform);
  }
}

// ─── Exports ────────────────────────────────────────────────

export {
  Equip,
  // Detection
  detectPlatforms,
  // MCP
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
  // Rules
  installRules,
  uninstallRules,
  parseRulesVersion,
  markerPatterns,
  // Platforms
  createManualPlatform,
  platformName,
  resolvePlatformId,
  KNOWN_PLATFORMS,
  PLATFORM_REGISTRY,
  getPlatform,
  // Hooks
  getHookCapabilities,
  installHooks,
  uninstallHooks,
  hasHooks,
  buildHooksConfig,
  // CLI helpers
  cli,
  // Backward-compat path helpers
  getVsCodeUserDir,
  getVsCodeMcpPath,
  getClineConfigPath,
  getRooConfigPath,
  getCodexConfigPath,
  getGeminiSettingsPath,
  getJunieMcpPath,
  getCopilotJetBrainsMcpPath,
  getCopilotCliMcpPath,
};

// Types (re-exported above via named exports; listed here for clarity)
export type { DetectedPlatform, PlatformDefinition, PlatformHttpShape, PlatformHookCapabilities, HookDefinition };
