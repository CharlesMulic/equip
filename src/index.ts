// @cg3/equip — Universal MCP + behavioral rules installer for AI coding agents.
// Zero dependencies. Works with Claude Code, Cursor, Windsurf, VS Code, Cline, Roo Code, Codex, Gemini CLI.

import * as path from "path";
import * as os from "os";

import { detectPlatforms } from "./lib/detect";
import { readMcpEntry, buildHttpConfigWithAuth, buildStdioConfig, installMcp, uninstallMcp, updateMcpKey } from "./lib/mcp";
import { parseRulesVersion, installRules, uninstallRules, markerPatterns } from "./lib/rules";
import * as fs from "fs";
import { getHookCapabilities, installHooks, uninstallHooks, hasHooks, type HookDefinition } from "./lib/hooks";
import { createManualPlatform, platformName, resolvePlatformId, KNOWN_PLATFORMS, PLATFORM_REGISTRY, getPlatform, type DetectedPlatform, type PlatformDefinition, type PlatformHttpShape, type PlatformHookCapabilities } from "./lib/platforms";
import * as cli from "./lib/cli";
import { installSkill, uninstallSkill, hasSkill, type SkillConfig, type SkillFile } from "./lib/skills";

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
  skill?: SkillConfig;
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
  skill: SkillConfig | null;

  constructor(config: EquipConfig) {
    if (!config.name) throw new Error("Equip: name is required");

    this.name = config.name;
    this.serverUrl = config.serverUrl;
    this.rules = config.rules || null;
    this.stdio = config.stdio || null;
    this.hookDefs = config.hooks || null;
    this.hookDir = config.hookDir || path.join(os.homedir(), `.${config.name}`, "hooks");
    this.skill = config.skill || null;
  }

  detect(): DetectedPlatform[] {
    return detectPlatforms(this.name);
  }

  buildConfig(platformId: string, apiKey: string, transport: string = "http"): Record<string, unknown> {
    if (transport === "stdio" && this.stdio) {
      const env = { [this.stdio.envKey]: apiKey };
      return buildStdioConfig(this.stdio.command, this.stdio.args, env);
    }
    if (!this.serverUrl) throw new Error("Equip: serverUrl is required for MCP installation");
    return buildHttpConfigWithAuth(this.serverUrl, apiKey, platformId);
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
    return installRules(platform, { ...this.rules, dryRun: options.dryRun || false });
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

  installSkill(platform: DetectedPlatform, options: { dryRun?: boolean } = {}): { action: string } {
    if (!this.skill) return { action: "skipped" };
    return installSkill(platform, this.name, this.skill, options);
  }

  uninstallSkill(platform: DetectedPlatform, dryRun: boolean = false): boolean {
    if (!this.skill) return false;
    return uninstallSkill(platform, this.name, this.skill.name, dryRun);
  }

  hasSkill(platform: DetectedPlatform): boolean {
    if (!this.skill) return false;
    return hasSkill(platform, this.name, this.skill.name);
  }

  /**
   * Verify that a tool is correctly installed on a platform.
   * Returns a structured result with per-check status.
   */
  verify(platform: DetectedPlatform): VerifyResult {
    const checks: VerifyCheck[] = [];

    // Check MCP config entry
    const mcpEntry = this.readMcp(platform);
    checks.push({
      name: "mcp",
      ok: !!mcpEntry,
      detail: mcpEntry ? "MCP config entry present" : "MCP config entry missing",
    });

    // Check rules (if configured and platform supports them)
    if (this.rules && platform.rulesPath) {
      let rulesOk = false;
      let rulesDetail = "Rules file not found";
      try {
        const content = fs.readFileSync(platform.rulesPath, "utf-8");
        const version = parseRulesVersion(content, this.rules.marker);
        if (version === this.rules.version) {
          rulesOk = true;
          rulesDetail = `Rules v${version} present`;
        } else if (version) {
          rulesDetail = `Rules version mismatch: installed v${version}, expected v${this.rules.version}`;
        } else {
          rulesDetail = "Rules marker block not found";
        }
      } catch { /* file not readable */ }
      checks.push({ name: "rules", ok: rulesOk, detail: rulesDetail });
    }

    // Check hooks (if configured and platform supports them)
    if (this.hookDefs && this.hookDefs.length > 0 && this.supportsHooks(platform)) {
      const hooksInstalled = this.hasHooks(platform);
      checks.push({
        name: "hooks",
        ok: hooksInstalled,
        detail: hooksInstalled ? `${this.hookDefs.length} hook${this.hookDefs.length === 1 ? "" : "s"} registered` : "Hooks not registered",
      });
    }

    // Check skills (if configured and platform supports them)
    if (this.skill && platform.skillsPath) {
      const skillInstalled = this.hasSkill(platform);
      checks.push({
        name: "skills",
        ok: skillInstalled,
        detail: skillInstalled ? `Skill "${this.skill.name}" installed` : `Skill "${this.skill.name}" not found`,
      });
    }

    return {
      platform: platform.platform,
      ok: checks.every(c => c.ok),
      checks,
    };
  }
}

// ─── Verify Types ───────────────────────────────────────────

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  platform: string;
  ok: boolean;
  checks: VerifyCheck[];
}

// ─── Public API ─────────────────────────────────────────────

export {
  Equip,
  // Platform utilities
  createManualPlatform,
  platformName,
  resolvePlatformId,
  KNOWN_PLATFORMS,
  PLATFORM_REGISTRY,
  getPlatform,
  // Rules utilities (used by consumers for version checking)
  parseRulesVersion,
  markerPatterns,
  // CLI helpers (for consumer setup scripts)
  cli,
};

// Types
export type { DetectedPlatform, PlatformDefinition, PlatformHttpShape, PlatformHookCapabilities, HookDefinition, SkillConfig, SkillFile };
