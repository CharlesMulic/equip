// @cg3/equip — Augment your AI agents with MCP servers, behavioral rules, and skills.
// Zero dependencies. Works across Claude Code, Cursor, Windsurf, VS Code, Cline, Roo Code, Codex, Gemini CLI, and more.

import * as path from "path";
import * as os from "os";

import { detectPlatforms } from "./lib/detect";
import { readMcpEntry, readMcpEntryDetailed, buildHttpConfig, buildHttpConfigWithAuth, buildStdioConfig, buildMcpConfigForInstallTarget, installMcp, uninstallMcp, updateMcpKey } from "./lib/mcp";
import { parseRulesVersion, installRules, uninstallRules, markerPatterns, wrapRulesContent, stripRulesMarkers, rulesContentHash } from "./lib/rules";
import { validateToolName, validateRelativePath, validatePathWithinDir, validateHookDir, validateUrlScheme, isTrustedCredentialHost } from "./lib/validation";
import { computeContentHash, extractManifest, type ContentManifest } from "./lib/content-hash";
import * as fs from "fs";
import { getHookCapabilities, installHooks, uninstallHooks, hasHooks, findOrphanHookEntries, type HookDefinition, type OrphanHookEntry } from "./lib/hooks";
import { createManualPlatform, platformName, resolvePlatformId, KNOWN_PLATFORMS, PLATFORM_REGISTRY, getPlatform, getBrokerCapabilities, platformSupportsBroker, getBrokerStrategy, platformSupportsRemoteTransport, remoteTypeFieldForPlatform, type DetectedPlatform, type PlatformDefinition, type PlatformHttpShape, type PlatformHookCapabilities, type PlatformBrokerCapabilities, type PlatformBrokerStrategy, type PlatformRemoteTransport, type BrokerConfigWriteResult, type BrokerEndpoint, type DiscoverySuppressionRules } from "./lib/platforms";
import * as cli from "./lib/cli";
import { installSkill, uninstallSkill, hasSkill, type SkillConfig, type SkillFile, type InstallSkillOptions, type UninstallSkillResult } from "./lib/skills";
import type { SkillManifestOwnerSource } from "./lib/skill-manifest";
import { NOOP_LOGGER, InstallReportBuilder, makeResult, type ArtifactResult, type EquipWarning, type EquipLogger, type EquipErrorCode, type EquipWarningCode, type ArtifactType, type ArtifactAction } from "./lib/types";
import type { ReadMcpResult } from "./lib/mcp";
import { fetchRegistryDef, registryDefToConfig, type RegistryDef, type PostInstallAction } from "./lib/registry";
import { resolveAuth, validateCredential, readStoredCredential, writeStoredCredential, deleteStoredCredential, listStoredCredentials, isCredentialExpired, refreshCredential, refreshAllExpired, type AuthConfig, type StoredCredential, type AuthResult, type RefreshResult } from "./lib/auth-engine";
import { readPlatformsMeta, writePlatformsMeta, updatePlatformsMeta, setPlatformEnabled, getEnabledPlatformIds, isPlatformEnabled, readPlatformScan, writePlatformScan, scanPlatform, scanAllPlatforms, getPlatformsDir, type PlatformsMeta, type PlatformMeta, type PlatformScan, type PlatformAugmentEntry } from "./lib/platform-state";
import { readEquipMeta, writeEquipMeta, markEquipUpdated, markScanCompleted, updatePreferences, getInstallId, type EquipMeta, type EquipPreferences } from "./lib/equip-meta";
import { createSnapshot, listSnapshots, readSnapshot, restoreSnapshot, deleteSnapshot, hasInitialSnapshot, ensureInitialSnapshots, pruneSnapshots, type Snapshot, type SnapshotSummary, type RestoreResult } from "./lib/snapshots";
import { reconcileState } from "./lib/reconcile";
import type { BrowserOpener } from "./lib/auth-engine";
import type { McpInstallTarget } from "./lib/mcp-readiness";

// ─── Equip Class ────────────────────────────────────────────

export interface AugmentConfig {
  name: string;
  serverUrl?: string;
  rules?: {
    content: string;
    version: string;
    marker: string;
    fileName?: string;
  };
  stdio?: {
    command: string;
    args: string[];
    envKey: string;
  };
  hooks?: HookDefinition[];
  hookDir?: string;
  /** Multiple skills — each gets its own directory at {skillsPath}/{skillName}/ (flat per the Agent Skills spec). */
  skills?: SkillConfig[];
  logger?: EquipLogger;
  /** Augment registry version recorded in per-skill manifests. Defaults to 0 for local installs. */
  augmentVersion?: number;
  /** Where this augment def came from. Defaults to "local". */
  source?: SkillManifestOwnerSource;
  /** npm package name (registry installs). */
  package?: string;
  /** Normalized MCP registry install target selected for direct platform config output. */
  mcpInstallTarget?: McpInstallTarget;
  /** Caller-supplied non-auth target inputs for direct platform config output. */
  mcpInstallInputs?: Record<string, string | undefined>;
  /** Equip CLI version recorded in per-skill manifests. Defaults to "unknown". */
  equipVersion?: string;
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
  augmentVersion?: number;
  source: SkillManifestOwnerSource;
  package?: string;
  mcpInstallTarget?: McpInstallTarget;
  mcpInstallInputs: Record<string, string | undefined>;
  equipVersion?: string;

  constructor(config: AugmentConfig) {
    if (!config.name) throw new Error("Augment: name is required");

    this.name = config.name;
    this.serverUrl = config.serverUrl;
    this.rules = config.rules || null;
    this.stdio = config.stdio || null;
    this.hookDefs = config.hooks || null;
    this.hookDir = config.hookDir || path.join(os.homedir(), `.${config.name}`, "hooks");
    this.skills = config.skills || [];
    this.logger = config.logger || NOOP_LOGGER;
    this.augmentVersion = config.augmentVersion;
    this.source = config.source || "local";
    this.package = config.package;
    this.mcpInstallTarget = config.mcpInstallTarget;
    this.mcpInstallInputs = config.mcpInstallInputs || {};
    this.equipVersion = config.equipVersion;
  }

  detect(): DetectedPlatform[] {
    return detectPlatforms(this.name);
  }

  buildConfig(platformId: string, apiKey: string | null, transport: string = "http"): Record<string, unknown> {
    if (this.mcpInstallTarget) {
      const result = buildMcpConfigForInstallTarget(this.mcpInstallTarget, platformId, {
        apiKey,
        inputs: this.mcpInstallInputs,
      });
      if (!result.success) {
        throw new Error(`Equip: MCP target ${result.targetKey} is not installable: ${result.error}`);
      }
      return result.entry;
    }
    if (transport === "stdio" && this.stdio) {
      const env: Record<string, string> = {};
      if (this.stdio.envKey && apiKey) env[this.stdio.envKey] = apiKey;
      return buildStdioConfig(this.stdio.command, this.stdio.args, env);
    }
    if (!this.serverUrl) throw new Error("Equip: serverUrl is required for MCP installation");
    const remoteTransport = transport === "sse" ? "sse" : "streamable-http";
    if (!platformSupportsRemoteTransport(platformId, remoteTransport)) {
      throw new Error(`Equip: Remote MCP transport "${remoteTransport}" cannot be written for ${platformId}.`);
    }
    if (apiKey) {
      return buildHttpConfigWithAuth(this.serverUrl, apiKey, platformId, undefined, remoteTransport);
    }
    return buildHttpConfig(this.serverUrl, platformId, remoteTransport);
  }

  installMcp(platform: DetectedPlatform, apiKey: string | null, options: { transport?: string; dryRun?: boolean } = {}): ArtifactResult {
    const { transport = "http", dryRun = false } = options;
    const config = this.buildConfig(platform.platform, apiKey, transport);
    return installMcp(platform, this.name, config, { dryRun, serverUrl: this.serverUrl, logger: this.logger });
  }

  /**
   * Broker-mode install.
   *
   * Writes a platform config entry that points at `equip-broker-fd-bridge` so
   * the platform spawns the native bridge as its MCP server. The bridge talks
   * to the broker daemon for upstream MCP traffic; the broker injects fresh
   * tokens server-side. The platform never sees an OAuth-shaped config.
   *
   * The platform-specific output is provided by
   * `PlatformDefinition.brokerStrategy.writeBrokerConfig`. The caller injects
   * `bridgeBinaryPath` at call time; equip lib does not know the path.
   *
   * Returns a `mcp` ArtifactResult with `errorCode: "BROKER_NOT_SUPPORTED"`
   * when the platform doesn't declare broker support; the caller should fall
   * back to direct-mode install in that case.
   */
  installMcpBroker(
    platform: DetectedPlatform,
    options: { bridgeBinaryPath: string; dryRun?: boolean; bridgeExtraArgs?: string[] },
  ): ArtifactResult {
    const { bridgeBinaryPath, dryRun = false, bridgeExtraArgs } = options;
    if (!platformSupportsBroker(platform.platform)) {
      return makeResult("mcp", {
        errorCode: "BROKER_NOT_SUPPORTED",
        error: `Platform "${platform.platform}" does not declare broker support — caller should fall back to direct-mode install`,
      });
    }
    const strategy = getBrokerStrategy(platform.platform);
    if (!strategy?.writeBrokerConfig) {
      return makeResult("mcp", {
        errorCode: "BROKER_WRITER_MISSING",
        error: `Platform "${platform.platform}" supports broker but has no writeBrokerConfig strategy hook`,
      });
    }
    const written = strategy.writeBrokerConfig(this.name, {
      augmentName: this.name,
      bridgeBinaryPath,
      bridgeExtraArgs,
    });
    if (!written) {
      return makeResult("mcp", {
        errorCode: "BROKER_WRITE_DECLINED",
        error: `writeBrokerConfig declined for "${this.name}" on ${platform.platform}; fall back to direct-mode install`,
      });
    }
    return installMcp(platform, this.name, written.entry, { dryRun, logger: this.logger });
  }

  uninstallMcp(platform: DetectedPlatform, dryRun: boolean = false): boolean {
    return uninstallMcp(platform, this.name, dryRun);
  }

  updateMcpKey(platform: DetectedPlatform, apiKey: string | null, transport?: string): ArtifactResult {
    const existing = transport === undefined ? this.readMcp(platform) : null;
    const resolvedTransport = transport ?? (existing?.type === "sse" ? "sse" : "http");
    const config = this.buildConfig(platform.platform, apiKey, resolvedTransport);
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

  installSkill(
    platform: DetectedPlatform,
    options: { dryRun?: boolean; takeover?: boolean; adopt?: boolean } = {},
  ): ArtifactResult {
    if (this.skills.length === 0) return makeResult("skills", { attempted: false, success: true, action: "skipped" });

    const baseOpts: InstallSkillOptions = {
      ...options,
      logger: this.logger,
      augmentVersion: this.augmentVersion,
      source: this.source,
      package: this.package,
      equipVersion: this.equipVersion,
    };

    let anyCreated = false;
    let anyUpdated = false;
    const collisions: ArtifactResult[] = [];
    let lastResult: ArtifactResult = makeResult("skills", { attempted: false, success: true, action: "skipped" });

    for (const sk of this.skills) {
      const result = installSkill(platform, this.name, sk, baseOpts);
      lastResult = result;
      if (result.action === "created") anyCreated = true;
      if (result.action === "updated") anyUpdated = true;
      if (!result.success) {
        // Collision refusals don't fail fast: surface the conflict and continue
        // installing other skills so a multi-skill augment isn't blocked by a
        // single colliding name. Any non-collision failure still propagates.
        const isCollision = result.errorCode === "SKILL_COLLISION_OTHER_AUGMENT"
          || result.errorCode === "SKILL_COLLISION_USER_AUTHORED"
          || result.errorCode === "SKILL_COLLISION_FORGED_MANIFEST";
        if (isCollision) {
          collisions.push(result);
          continue;
        }
        return result; // fail fast on real errors
      }
    }

    // Aggregate telemetry: strongest action wins, but propagate first collision via
    // errorCode so callers (CLI summary printer) can detect and surface the conflict
    // list. The error string is the per-skill message of the first collision; full
    // collision detail is loggable via the logger interface above.
    const aggregateAction = anyCreated ? "created" : anyUpdated ? "updated" : lastResult.action;
    if (collisions.length > 0) {
      return makeResult("skills", {
        attempted: true,
        success: collisions.length < this.skills.length, // partial success vs full failure
        action: aggregateAction,
        errorCode: collisions[0].errorCode,
        error: `${collisions.length}/${this.skills.length} skill${collisions.length === 1 ? "" : "s"} refused: `
          + collisions.map(c => c.error).join("; "),
      });
    }
    if (anyCreated) return makeResult("skills", { attempted: true, success: true, action: "created" });
    if (anyUpdated) return makeResult("skills", { attempted: true, success: true, action: "updated" });
    return lastResult;
  }

  uninstallSkill(platform: DetectedPlatform, dryRun: boolean = false): UninstallSkillResult {
    const empty: UninstallSkillResult = {
      removed: false, preservedFiles: [], tombstone: false, viaManifest: false,
    };
    if (this.skills.length === 0) return empty;

    let anyRemoved = false;
    let anyTombstone = false;
    let allViaManifest = true;
    let anyAttempted = false;
    const allPreserved: string[] = [];

    for (const sk of this.skills) {
      const r = uninstallSkill(platform, this.name, sk.name, dryRun, { logger: this.logger });
      anyAttempted = true;
      if (r.removed) anyRemoved = true;
      if (r.tombstone) anyTombstone = true;
      if (r.removed && !r.viaManifest) allViaManifest = false;
      // Prefix preserved file paths with the skill name so callers can disambiguate
      // multi-skill augments where two skills happen to ship a file with the same path.
      for (const f of r.preservedFiles) allPreserved.push(`${sk.name}/${f}`);
    }

    return {
      removed: anyRemoved,
      preservedFiles: allPreserved,
      tombstone: anyTombstone,
      viaManifest: anyAttempted ? allViaManifest : false,
    };
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
   * Verify that an augment is correctly installed on a platform.
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
// Lean surface for augment authors and setup scripts.
// Internal modules (state management, platform scans, snapshots,
// credentials, etc.) are NOT exported here — callers that need them
// import directly from src/lib/*.

export {
  // Core
  Augment,
  // Platform
  detectPlatforms,
  createManualPlatform,
  platformName,
  resolvePlatformId,
  KNOWN_PLATFORMS,
  PLATFORM_REGISTRY,
  getPlatform,
  platformSupportsRemoteTransport,
  remoteTypeFieldForPlatform,
  // Platform broker capability accessors
  getBrokerCapabilities,
  platformSupportsBroker,
  getBrokerStrategy,
  // CLI helpers (for setup scripts)
  cli,
  // Observability
  NOOP_LOGGER,
  InstallReportBuilder,
  makeResult,
  // Reconciliation (for setup scripts that need post-install state sync)
  reconcileState,
  // Hooks orphan-entry sweep (used by `equip doctor` to surface stale hook
  // entries left behind by old installs / aborted test runs).
  findOrphanHookEntries,
};

// `installMcpForReplaceAdopt` is the single-writer adopt-mode install used by
// managed MCP adoption flows.
export { installMcpForReplaceAdopt } from "./lib/mcp";
export {
  writeAdoptionSnapshot,
  redactSecrets,
} from "./lib/adoption-snapshot";
export type { AdoptionSnapshot } from "./lib/adoption-snapshot";
export {
  LOADOUT_SCHEMA_VERSION,
  LOADOUT_STATE_SCHEMA_VERSION,
  LOADOUT_PLAN_SCHEMA_VERSION,
  LoadoutStoreError,
  applyLoadout,
  createLoadout,
  clearActiveLoadout,
  deleteLoadout,
  duplicateLoadout,
  entriesFromResolved,
  getLoadout,
  getLoadoutProjection,
  listLoadoutManifests,
  listLoadouts,
  migrateLegacySets,
  getLoadoutApplyReceipt,
  markLoadoutApplied,
  previewLoadout,
  previewLoadouts,
  readLoadoutState,
  renameLoadout,
  saveCurrentLoadout,
  setActiveLoadout,
  updateLoadoutMetadata,
} from "./lib/loadouts";
export type {
  CreateLoadoutCommand,
  ApplyLoadoutCommand,
  DeleteLoadoutResult,
  LoadoutApplyDiagnostic,
  LoadoutApplyReceipt,
  LoadoutApplyStatus,
  LoadoutApplyStep,
  LoadoutApplyStepAction,
  LoadoutApplyStepStatus,
  LoadoutBulkPreviewEntry,
  LoadoutBulkPreviewError,
  LoadoutBulkPreviewResult,
  LoadoutCredentialValueReader,
  LoadoutEntry,
  LoadoutComponentSummary,
  LoadoutCredentialReader,
  LoadoutDesiredEntry,
  LoadoutDesiredStateProjection,
  LoadoutIgnoredInventory,
  LoadoutManifest,
  LoadoutPlanAction,
  LoadoutPlanCode,
  LoadoutPlanDiagnostic,
  LoadoutPlanDiagnosticSeverity,
  LoadoutPlanEntry,
  LoadoutPlanEntrySnapshot,
  LoadoutPlanStatus,
  LoadoutProjection,
  LoadoutPreviewPlan,
  LoadoutState,
  LoadoutSummary,
  LoadoutTargetResolution,
  LoadoutTargetResolutionStatus,
  LoadoutTargetResolver,
  SaveCurrentLoadoutCommand,
  UpdateLoadoutMetadataCommand,
} from "./lib/loadouts";

export type {
  DetectedPlatform,
  PlatformDefinition,
  PlatformHttpShape,
  PlatformRemoteTransport,
  HookDefinition,
  OrphanHookEntry,
  SkillConfig,
  SkillFile,
  ArtifactResult,
  EquipLogger,
  // Broker-mode platform extensions
  PlatformBrokerCapabilities,
  PlatformBrokerStrategy,
  BrokerConfigWriteResult,
  BrokerEndpoint,
  DiscoverySuppressionRules,
};

// Broker-mode auth abstractions; see equip/src/lib/auth-broker-types.ts.
export type {
  Provider,
  ProviderDescription,
  ProviderAcquireOptions,
  ProviderRefreshOptions,
  ProviderValidateOptions,
  ProviderResult,
  DeliveryDecision,
  DirectDelivery,
  DirectDeliveryReason,
  BrokerDelivery,
  UnsupportedDelivery,
  UnsupportedDeliveryReason,
} from "./lib/auth-broker-types";

export { assertNeverDelivery } from "./lib/auth-broker-types";

// Broker-mode Provider implementations. The five auth modes (none,
// api_key, oidc, oauth, oauth_to_api_key) live here because they're
// pure auth-protocol logic; broker runtimes construct and register
// them at startup.
export { NoneProvider } from "./lib/providers/provider-none";
export {
  ApiKeyProvider,
  validateApiKeyCredential,
} from "./lib/providers/provider-api-key";
export type { ApiKeyAcquireOptions } from "./lib/providers/provider-api-key";
export {
  OidcProvider,
  createDefaultSessionReader,
} from "./lib/providers/provider-oidc";
export type {
  OidcProviderOptions,
  EquipSessionFileShape,
} from "./lib/providers/provider-oidc";
export { OAuthProvider } from "./lib/providers/provider-oauth";
export type {
  OAuthProviderOptions,
  BrowserOpener,
} from "./lib/providers/provider-oauth";
export { OAuthToApiKeyProvider } from "./lib/providers/provider-oauth-to-api-key";
export type { OAuthToApiKeyProviderOptions } from "./lib/providers/provider-oauth-to-api-key";
export { OAuthDcrProvider } from "./lib/providers/provider-oauth-dcr";

// Telemetry counter port. Counter names + valid label values are the
// stable contract here; storage is the caller's concern.
export {
  noopCounter,
  COUNTER_NAMES,
  COUNTER_LABELS,
} from "./lib/telemetry";
export type { Counter } from "./lib/telemetry";

export {
  assessMcpInstallability,
  assessMcpReadiness,
  assessMcpRuntimeReadiness,
  deriveMcpRuntimeRequirements,
  mcpDefinitionToMcpInstallTargets,
  registryDefToMcpInstallTargets,
  summarizeMcpInstallTarget,
} from "./lib/mcp-readiness";
export type {
  McpInstallabilityReport,
  McpInstallabilityStatus,
  McpInstallTarget,
  McpInstallTargetKind,
  McpInputKind,
  McpInputRequirement,
  McpProbeReadinessReport,
  McpProbeStatus,
  McpReadinessFinding,
  McpReadinessReport,
  McpReadinessTargetSummary,
  McpRemoteInstallTarget,
  McpRuntimeCheckStatus,
  McpRuntimeReadinessReport,
  McpRuntimeReadinessStatus,
  McpRuntimeRequirement,
  McpRuntimeRequirementKind,
  McpStdioInstallTarget,
  McpTargetSource,
  McpTransport,
  McpUnsupportedInstallTarget,
} from "./lib/mcp-readiness";
