// @cg3/equip — Augment your AI agents with MCP servers, behavioral rules, and skills.
// Zero dependencies. Works across Claude Code, Cursor, Windsurf, VS Code, Cline, Roo Code, Codex, Gemini CLI, and more.

import * as path from "path";
import * as os from "os";

import { detectPlatforms } from "./lib/detect";
import { readMcpEntry, readMcpEntryDetailed, buildHttpConfigWithAuth, buildStdioConfig, installMcp, uninstallMcp, updateMcpKey } from "./lib/mcp";
import { parseRulesVersion, installRules, uninstallRules, markerPatterns } from "./lib/rules";
import * as fs from "fs";
import { getHookCapabilities, installHooks, uninstallHooks, hasHooks, type HookDefinition } from "./lib/hooks";
import { createManualPlatform, platformName, resolvePlatformId, KNOWN_PLATFORMS, PLATFORM_REGISTRY, getPlatform, type DetectedPlatform, type PlatformDefinition, type PlatformHttpShape, type PlatformHookCapabilities } from "./lib/platforms";
import * as cli from "./lib/cli";
import { installSkill, uninstallSkill, hasSkill, type SkillConfig, type SkillFile } from "./lib/skills";
import { NOOP_LOGGER, InstallReportBuilder, makeResult, type ArtifactResult, type EquipWarning, type EquipLogger, type EquipErrorCode, type EquipWarningCode, type ArtifactType, type ArtifactAction } from "./lib/types";
import type { ReadMcpResult } from "./lib/mcp";
import { fetchToolDef, toolDefToEquipConfig, type ToolDefinition, type LocalRegistryEntry, type PostInstallAction } from "./lib/registry";
import { resolveAuth, validateCredential, readStoredCredential, writeStoredCredential, deleteStoredCredential, listStoredCredentials, isCredentialExpired, refreshCredential, refreshAllExpired, type AuthConfig, type StoredCredential, type AuthResult, type RefreshResult } from "./lib/auth-engine";
import { readAugmentDef, writeAugmentDef, listAugmentDefs, deleteAugmentDef, hasAugmentDef, syncFromRegistry, createLocalAugment, wrapUnmanaged, modAugmentRules, resetAugmentRules, getAugmentsDir, type AugmentDef, type AugmentSource, type AugmentRules, type LocalAugmentConfig, type WrapConfig } from "./lib/augment-defs";
import { readPlatformsMeta, writePlatformsMeta, updatePlatformsMeta, setPlatformEnabled, readPlatformScan, writePlatformScan, scanPlatform, scanAllPlatforms, getPlatformsDir, type PlatformsMeta, type PlatformMeta, type PlatformScan, type PlatformAugmentEntry } from "./lib/platform-state";
import { readInstallations, writeInstallations, trackInstallation, trackUninstallation, getAugmentsForPlatform, getManagedAugmentNames, type Installations, type InstallationRecord, type ArtifactRecord } from "./lib/installations";
import { readEquipMeta, writeEquipMeta, markEquipUpdated, markScanCompleted, updatePreferences, type EquipMeta, type EquipPreferences } from "./lib/equip-meta";
import { migrateState, type MigrationResult } from "./lib/migration";

// ─── Equip Class ────────────────────────────────────────────

export interface AugmentConfig {
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
  /** Multiple skills — each gets its own directory under {skillsPath}/{toolName}/{skillName}/ */
  skills?: SkillConfig[];
  /** @deprecated Use `skills` instead. Single skill, kept for backward compatibility. */
  skill?: SkillConfig;
  logger?: EquipLogger;
}

/**
 * Augment — defines and installs an augment (MCP server, behavioral rules, skills) across AI platforms.
 */
class Augment {
  name: string;
  serverUrl?: string;
  rules: AugmentConfig["rules"] | null;
  stdio: AugmentConfig["stdio"] | null;
  hookDefs: HookDefinition[] | null;
  hookDir: string;
  skills: SkillConfig[];
  logger: EquipLogger;

  constructor(config: AugmentConfig) {
    if (!config.name) throw new Error("Augment: name is required");

    this.name = config.name;
    this.serverUrl = config.serverUrl;
    this.rules = config.rules || null;
    this.stdio = config.stdio || null;
    this.hookDefs = config.hooks || null;
    this.hookDir = config.hookDir || path.join(os.homedir(), `.${config.name}`, "hooks");
    // Support both `skills` (array) and deprecated `skill` (singular)
    this.skills = config.skills || (config.skill ? [config.skill] : []);
    this.logger = config.logger || NOOP_LOGGER;
  }

  /** @deprecated Use `skills` instead */
  get skill(): SkillConfig | null {
    return this.skills.length > 0 ? this.skills[0] : null;
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

  installMcp(platform: DetectedPlatform, apiKey: string, options: { transport?: string; dryRun?: boolean } = {}): ArtifactResult {
    const { transport = "http", dryRun = false } = options;
    const config = this.buildConfig(platform.platform, apiKey, transport);
    return installMcp(platform, this.name, config, { dryRun, serverUrl: this.serverUrl, logger: this.logger });
  }

  uninstallMcp(platform: DetectedPlatform, dryRun: boolean = false): boolean {
    return uninstallMcp(platform, this.name, dryRun);
  }

  updateMcpKey(platform: DetectedPlatform, apiKey: string, transport: string = "http"): ArtifactResult {
    const config = this.buildConfig(platform.platform, apiKey, transport);
    return updateMcpKey(platform, this.name, config, { logger: this.logger });
  }

  installRules(platform: DetectedPlatform, options: { dryRun?: boolean } = {}): ArtifactResult {
    if (!this.rules) return makeResult("rules", { attempted: false, success: true, action: "skipped" });
    return installRules(platform, { ...this.rules, dryRun: options.dryRun || false, logger: this.logger });
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

  readMcpDetailed(platform: DetectedPlatform): ReadMcpResult {
    return readMcpEntryDetailed(platform.configPath, platform.rootKey, this.name, platform.configFormat || "json");
  }

  installHooks(platform: DetectedPlatform, options: { hookDir?: string; dryRun?: boolean } = {}): ArtifactResult {
    if (!this.hookDefs) return makeResult("hooks", { attempted: false, success: true, action: "skipped" });
    const opts = { ...options, logger: this.logger };
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

  installSkill(platform: DetectedPlatform, options: { dryRun?: boolean } = {}): ArtifactResult {
    if (this.skills.length === 0) return makeResult("skills", { attempted: false, success: true, action: "skipped" });
    let anyCreated = false;
    let lastResult: ArtifactResult = makeResult("skills", { attempted: false, success: true, action: "skipped" });
    for (const sk of this.skills) {
      const result = installSkill(platform, this.name, sk, { ...options, logger: this.logger });
      lastResult = result;
      if (result.action === "created") anyCreated = true;
      if (!result.success) return result; // fail fast on error
    }
    // If any skill was newly created, report "created"; otherwise report last result
    if (anyCreated) return makeResult("skills", { attempted: true, success: true, action: "created" });
    return lastResult;
  }

  uninstallSkill(platform: DetectedPlatform, dryRun: boolean = false): boolean {
    if (this.skills.length === 0) return false;
    let anyRemoved = false;
    for (const sk of this.skills) {
      if (uninstallSkill(platform, this.name, sk.name, dryRun)) anyRemoved = true;
    }
    return anyRemoved;
  }

  hasSkill(platform: DetectedPlatform): boolean {
    if (this.skills.length === 0) return false;
    return this.skills.every(sk => hasSkill(platform, this.name, sk.name));
  }

  /** Check which skills are installed (returns names of installed skills) */
  installedSkills(platform: DetectedPlatform): string[] {
    return this.skills.filter(sk => hasSkill(platform, this.name, sk.name)).map(sk => sk.name);
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
    if (this.skills.length > 0 && platform.skillsPath) {
      const installed = this.installedSkills(platform);
      const missing = this.skills.filter(sk => !installed.includes(sk.name)).map(sk => sk.name);
      const allOk = missing.length === 0;
      checks.push({
        name: "skills",
        ok: allOk,
        detail: allOk
          ? `${installed.length} skill${installed.length === 1 ? "" : "s"} installed (${installed.join(", ")})`
          : `Missing skills: ${missing.join(", ")}`,
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
  Augment,
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
  // Observability
  NOOP_LOGGER,
  InstallReportBuilder,
  makeResult,
  // Registry
  fetchToolDef,
  toolDefToEquipConfig,
  // Auth
  resolveAuth,
  readStoredCredential,
  writeStoredCredential,
  deleteStoredCredential,
  listStoredCredentials,
  isCredentialExpired,
  refreshCredential,
  refreshAllExpired,
  validateCredential,
  // Augment Definitions
  readAugmentDef,
  writeAugmentDef,
  listAugmentDefs,
  deleteAugmentDef,
  hasAugmentDef,
  syncFromRegistry,
  createLocalAugment,
  wrapUnmanaged,
  modAugmentRules,
  resetAugmentRules,
  getAugmentsDir,
  // Platform State
  readPlatformsMeta,
  writePlatformsMeta,
  updatePlatformsMeta,
  setPlatformEnabled,
  readPlatformScan,
  writePlatformScan,
  scanPlatform,
  scanAllPlatforms,
  getPlatformsDir,
  // Installations
  readInstallations,
  writeInstallations,
  trackInstallation,
  trackUninstallation,
  getAugmentsForPlatform,
  getManagedAugmentNames,
  // Equip Meta
  readEquipMeta,
  writeEquipMeta,
  markEquipUpdated,
  markScanCompleted,
  updatePreferences,
  // Migration
  migrateState,
};

// Types
export type {
  DetectedPlatform,
  PlatformDefinition,
  PlatformHttpShape,
  PlatformHookCapabilities,
  HookDefinition,
  SkillConfig,
  SkillFile,
  ArtifactResult,
  EquipWarning,
  EquipLogger,
  EquipErrorCode,
  EquipWarningCode,
  ArtifactType,
  ArtifactAction,
  ReadMcpResult,
  ToolDefinition,
  LocalRegistryEntry,
  PostInstallAction,
  AuthConfig,
  StoredCredential,
  AuthResult,
  RefreshResult,
  AugmentDef,
  AugmentSource,
  AugmentRules,
  PlatformsMeta,
  PlatformMeta,
  PlatformScan,
  PlatformAugmentEntry,
  Installations,
  InstallationRecord,
  ArtifactRecord,
  EquipMeta,
  EquipPreferences,
  MigrationResult,
  LocalAugmentConfig,
  WrapConfig,
};
