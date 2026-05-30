// equip <augment> — direct-mode install.
// Handles auth, platform detection, MCP/rules/skills install, verification,
// state reconciliation, telemetry, and post-install actions.

import * as os from "os";
import { spawn } from "child_process";
import { Augment, type AugmentConfig } from "../../index";
import {
  registryDefToConfig,
  registryDefHasMcp,
  REGISTRY_API,
  missingAcceptedWarningReasonCodes,
  resolveRegistryInstallReviewGate,
  writeRegistryInstallGateAcceptanceReceipt,
  type RegistryDef,
  type RegistryInstallReviewGate,
} from "../registry";
import { createManualPlatform } from "../platforms";
import { platformName, platformSupportsRemoteTransport, resolvePlatformId } from "../platforms";
import { InstallReportBuilder, makeResult } from "../types";
import { resolveAuth, validateCredential, type AuthConfig } from "../auth-engine";
import { reconcileState } from "../reconcile";
import { isPlatformEnabled } from "../platform-state";
import { acquireLock } from "../fs";
import { JsonStore } from "../storage/datastore";
import { readEquipMeta, getInstallId } from "../equip-meta";
import { ensureInitialSnapshots } from "../snapshots";
import { validateUrlScheme, isTrustedCredentialHost } from "../validation";
import type { SkillManifestOwnerSource } from "../skill-manifest";
import type { SkillConfig } from "../skills";
import type { HookDefinition } from "../hooks";
import {
  assessMcpInstallability,
  assessMcpRuntimeReadiness,
  type McpInstallTarget,
  type McpRuntimeReadinessCheck,
  type McpRuntimeReadinessReport,
} from "../mcp-readiness";

/**
 * The minimal augment-shaped input writeAugmentDefAndApply consumes.
 * Defined locally so install.ts has no dependency on legacy modules.
 * AugmentDef and RegistryDef both structurally satisfy this contract,
 * so existing callers keep working without code changes.
 */
export interface AugmentInput {
  name: string;
  source: SkillManifestOwnerSource;
  title?: string;
  description?: string;
  transport?: "http" | "streamable-http" | "sse" | "stdio";
  serverUrl?: string;
  stdio?: { command: string; args: string[]; envKey?: string };
  envKey?: string;
  installTargets?: unknown;
  npmPackage?: string;
  setupCommand?: string;
  requiresAuth?: boolean;
  rules?: { content: string; version: string; marker: string; fileName?: string };
  skills?: SkillConfig[];
  hooks?: HookDefinition[];
  hookDir?: string;
}
import { createConsoleLogger, type ParsedArgs } from "../cli";
import * as cli from "../cli";
import { noopCounter, COUNTER_NAMES, type Counter } from "../telemetry";

// ─── apply: put a def on platforms ─────────────────────────────────────────
//
// "Apply" is the second half of the equip refresh+apply pipeline:
//   - refresh: network or local-author edit produces a def
//   - apply: that def → installed platform copies (this function)
//
// Callers are runInstall (first-time install with auth resolution + platform
// discovery upstream of apply) and update-propagation paths (registry refresh,
// authoring save, platform-enable backfill, equip apply CLI).
//
// Each caller is responsible for:
//   - Constructing the Augment instance from a def (typically via
//     `new Augment(registryDefToConfig(def))`).
//   - Resolving auth (apiKey) when needed. Update flows can typically pass null —
//     installMcp updates the MCP config in-place and existing credentials persist
//     in the platform-specific config — but first-time install via runInstall
//     always resolves auth before calling apply.
//   - Filtering disabled platforms out of `platforms`. Apply trusts the
//     caller — never writes to a platform not in the list.
//
// Contract for future contributors: when adding a new resource type to
// AugmentDef (skills, rules, hooks, MCP servers today), you MUST:
//   1. Add an installXxx method following the existing per-type pattern.
//   2. Add its integration here in apply().
//   3. Add a test verifying apply() correctly writes that resource type.
//
// If you add a resource type to the AugmentDef schema without wiring it
// into apply, installed copies will silently miss the new resource —
// exactly the silent-staleness bug class these integration tests are meant to
// catch.

export interface ApplyOptions {
  dryRun?: boolean;
  takeover?: boolean;
  adopt?: boolean;
  logger?: import("../types").EquipLogger;
  /** Optional caller-provided report builder; otherwise apply creates one. */
  report?: InstallReportBuilder;
  /**
   * Optional counter port for telemetry. Defaults to no-op when absent.
   * Callers that need observability supply their own counter; the CLI
   * runs without one.
   */
  counter?: Counter;
}

interface McpConfigPreflightFailure {
  platformId: string;
  error: string;
}

function preflightMcpConfigCompatibility(
  equip: Augment,
  platforms: ReturnType<Augment["detect"]>,
  apiKey: string | null,
  transport: string,
): McpConfigPreflightFailure[] {
  const failures: McpConfigPreflightFailure[] = [];
  for (const p of platforms) {
    try {
      equip.buildConfig(p.platform, apiKey, transport);
    } catch (e: unknown) {
      failures.push({
        platformId: p.platform,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return failures;
}

function logMcpConfigPreflightFailures(failures: McpConfigPreflightFailure[]): void {
  cli.fail("MCP config cannot be written for the selected platform set.");
  for (const failure of failures) {
    cli.log(`  ${platformName(failure.platformId)}: ${failure.error}`);
  }
}

function filterDetectedPlatforms(
  platforms: ReturnType<Augment["detect"]>,
  parsedArgs: ParsedArgs,
  options: { logDisabled?: boolean } = {},
): ReturnType<Augment["detect"]> {
  let selected = platforms;

  const beforeFilter = selected.length;
  selected = selected.filter(p => isPlatformEnabled(p.platform));
  if (options.logDisabled && selected.length < beforeFilter) {
    const skipped = beforeFilter - selected.length;
    cli.log(`  ${cli.DIM}${skipped} disabled platform${skipped === 1 ? "" : "s"} skipped${cli.RESET}`);
  }

  if (parsedArgs.platform) {
    const requested = parsedArgs.platform.split(",").map(s => resolvePlatformId(s.trim()));
    selected = selected.filter(p => requested.includes(p.platform));
  }

  return selected;
}

function enforceDetectedPlatforms(platforms: ReturnType<Augment["detect"]>, parsedArgs: ParsedArgs): void {
  if (parsedArgs.platform && platforms.length === 0) {
    cli.fail(`None of the specified platforms detected: ${parsedArgs.platform}`);
    process.exit(1);
  }

  if (platforms.length === 0) {
    cli.fail("No supported AI coding tools detected.");
    cli.log(`\n  Install one of: Claude Code, Cursor, Windsurf, VS Code, Cline, Roo Code`);
    process.exit(1);
  }
}

function preflightMcpTransportCompatibility(
  equip: Augment,
  platforms: ReturnType<Augment["detect"]>,
  transport: string,
): McpConfigPreflightFailure[] {
  const target = equip.mcpInstallTarget;
  const remoteTransport = target?.kind === "remote"
    ? target.transport
    : equip.serverUrl
      ? (transport === "sse" ? "sse" : "streamable-http")
      : null;
  if (!remoteTransport) return [];

  const failures: McpConfigPreflightFailure[] = [];
  for (const platform of platforms) {
    if (!platformSupportsRemoteTransport(platform.platform, remoteTransport)) {
      failures.push({
        platformId: platform.platform,
        error: target
          ? `Equip: MCP target ${target.targetKey} is not installable: Remote MCP transport "${remoteTransport}" cannot be written for ${platform.platform}.`
          : `Equip: Remote MCP transport "${remoteTransport}" cannot be written for ${platform.platform}.`,
      });
    }
  }
  return failures;
}

/**
 * Apply an augment def to the named platforms. Writes MCP server config,
 * behavioral rules, skills, runs verification, reconciles state, and
 * re-estimates token weight from the persisted def.
 *
 * Acquires the equip-wide lock for the duration.
 * Safe to call from any caller; the lock is re-entrant via reconcileState.
 *
 * Caller MUST have already filtered disabled platforms out of `platforms`.
 *
 * Returns the populated InstallReportBuilder for the caller to inspect or
 * surface.
 */
export function apply(
  equip: Augment,
  toolDef: RegistryDef | AugmentInput,
  platforms: ReturnType<Augment["detect"]>,
  apiKey: string | null,
  opts: ApplyOptions = {},
): InstallReportBuilder {
  const { dryRun = false, takeover, adopt, logger } = opts;
  const transport = equip.mcpInstallTarget?.transport
    || (equip.stdio ? "stdio" : toolDef.transport || "http");
  const report = opts.report ?? new InstallReportBuilder();
  const counter = opts.counter ?? noopCounter;

  // Plan progress steps for CLI output. We read fields directly off `toolDef`
  // (rather than building an AugmentConfig adapter inside apply) so apply works
  // for both RegistryDef inputs (registry-fetched flow via runInstall) and
  // AugmentInput flows (local-author edits and registry refreshes). The
  // Augment instance — which actually drives per-resource
  // writes — is the caller's responsibility.
  //
  // hasMcpServer mirrors the gate used by bridge.ts install paths: an augment
  // is allowed to be rules-only or skills-only with no MCP server. Without
  // this gate, equip.installMcp → buildConfig() throws "serverUrl is required
  // for MCP installation" on the user-save propagation path.
  const hasMcpServer = !!(equip.serverUrl || equip.stdio || equip.mcpInstallTarget);
  const stepList: string[] = [];
  if (hasMcpServer) stepList.push("MCP Server");
  if (toolDef.rules) stepList.push("Behavioral Rules");
  const hasSkills = !!(toolDef.skills && toolDef.skills.length > 0);
  if (hasSkills) stepList.push("Skills");
  stepList.push("Verification");
  const totalSteps = stepList.length;
  let stepNum = 0;

  // Take the equip-wide lock for the whole apply. Re-entrant — reconcileState
  // below acquires the same lock and just bumps the depth counter. Closes a
  // TOCTOU window on the per-skill "is current" check and prevents concurrent
  // equip processes from stomping each other's skill writes.
  const releaseLock = acquireLock();

  try {
      // MCP Server (skipped when augment has no server — rules/skills-only
      // augments are valid; matches bridge.ts install-path gating).
      if (hasMcpServer) {
        cli.step(++stepNum, totalSteps, "MCP Server");
        cli.log(`  Transport  ${transport}`);

        const configFailures = preflightMcpConfigCompatibility(equip, platforms, apiKey, transport);
        if (configFailures.length > 0) {
          for (const failure of configFailures) {
            report.addResult(failure.platformId, makeResult("mcp", {
              errorCode: "MCP_TRANSPORT_UNSUPPORTED",
              error: failure.error,
            }));
            cli.fail(`${platformName(failure.platformId)}   ${failure.error}`);
          }
          report.complete();
          return report;
        }

        for (const p of platforms) {
          const result = equip.installMcp(p, apiKey, { transport, dryRun });
          report.addResult(p.platform, result);
          if (result.success) {
            cli.ok(`${platformName(p.platform)}   MCP server "${toolDef.name}" ${dryRun ? "would be " : ""}added ${cli.DIM}(${transport}, ${result.method})${cli.RESET}`);
            // Telemetry: this install path is direct-mode by definition
            // (apply doesn't dispatch to installMcpBroker). Broker-mode
            // installs go through their own paths and emit independently.
            if (!dryRun) counter(COUNTER_NAMES.INSTALL_MODE_TOTAL, { mode: "direct", platform: p.platform });
          } else {
            cli.fail(`${platformName(p.platform)}   ${result.error || result.errorCode}`);
          }
        }
      }

      // Rules
      if (toolDef.rules) {
        cli.step(++stepNum, totalSteps, "Behavioral Rules");
        for (const p of platforms) {
          if (!p.rulesPath) {
            if (logger) logger.debug("Skipping rules — no writable rules path", { platform: p.platform });
            continue;
          }
          const result = equip.installRules(p, { dryRun });
          report.addResult(p.platform, result);
          if (result.action === "created" || result.action === "updated") {
            cli.ok(`${platformName(p.platform)}   Rules v${toolDef.rules.version} ${result.action}`);
          } else if (result.action === "skipped" && result.attempted) {
            cli.ok(`${platformName(p.platform)}   Rules already current`);
          }
        }
      }

      // Skills
      if (hasSkills) {
        cli.step(++stepNum, totalSteps, "Skills");
        const skillNames = (toolDef.skills || []).map(s => s.name);
        for (const p of platforms) {
          const result = equip.installSkill(p, {
            dryRun,
            takeover,
            adopt,
          });
          report.addResult(p.platform, result);
          if (result.errorCode && (
            result.errorCode === "SKILL_COLLISION_OTHER_AUGMENT" ||
            result.errorCode === "SKILL_COLLISION_USER_AUTHORED" ||
            result.errorCode === "SKILL_COLLISION_FORGED_MANIFEST"
          )) {
            // Partial augment install: some skills landed, some refused.
            cli.warn(`${platformName(p.platform)}   ${result.error}`);
            const hint = result.errorCode === "SKILL_COLLISION_USER_AUTHORED"
              ? "Re-run with --adopt to take ownership."
              : "Re-run with --takeover to overwrite the existing skill.";
            cli.log(`  ${cli.DIM}${hint}${cli.RESET}`);
          } else if (result.action === "created") {
            cli.ok(`${platformName(p.platform)}   ${skillNames.length} skill${skillNames.length === 1 ? "" : "s"} installed (${skillNames.join(", ")})`);
          } else if (result.action === "skipped" && result.attempted) {
            cli.ok(`${platformName(p.platform)}   Skills already current`);
          }
        }
      }

      // Verification
      cli.step(++stepNum, totalSteps, "Verification");
      if (!dryRun) {
        for (const p of platforms) {
          const v = equip.verify(p);
          if (v.ok) {
            cli.ok(`${platformName(p.platform)}   All checks passed`);
          } else {
            const failed = v.checks.filter(c => !c.ok).map(c => c.detail).join(", ");
            cli.warn(`${platformName(p.platform)}   ${failed}`);
          }
        }
      }

      report.complete();

      // ── State Reconciliation ──
      if (!dryRun) {
        try {
          // npmPackage only exists on RegistryDef; AugmentDef lacks it. Falls
          // back to name for both. Cast toolDef to RegistryDef for reconcile —
          // reconcile only reads `toolDef.skills`, which both shapes have.
          const npmPackage = "npmPackage" in toolDef ? toolDef.npmPackage : undefined;
          const changed = reconcileState({
            toolName: toolDef.name,
            package: npmPackage || toolDef.name,
            marker: toolDef.rules?.marker || toolDef.name,
            toolDef: toolDef as RegistryDef,
            logger,
          });
          if (changed > 0 && logger) {
            logger.debug("State reconciled", { platforms: changed });
          }
        } catch (e: unknown) {
          if (logger) logger.warn("State reconciliation failed", { error: (e as Error).message });
        }
      }

  } finally {
    releaseLock();
  }

  return report;
}

// ─── writeAugmentDefAndApply: explicit "user save" boundary ────────────────
//
// User-driven edits land a new def state that should propagate immediately
// to installed platform copies. Examples:
//   - authoring "Save" flows
//   - future publisher draft commit-to-live flows
//   - CLI `equip apply <augment>` (falls through to apply directly)
//
// Journal-canonical: the act of applying produces an InstallAugmentIntent
// (via apply → reconcile) that records the new content. There is no
// separate "save the def" step — content is implicit in the install intent.
//
// If the augment isn't equipped to any platform, this is a no-op (drafts
// without an active install are out of scope for this surface; they live
// in whatever authoring state store the caller maintains).
//
// Returns the input def unchanged + apply report. Apply report is null
// when apply was skipped (no platforms to write to).

export interface WriteAugmentDefAndApplyOptions extends ApplyOptions {
  /**
   * Override platform list. Default: every platform the augment is
   * currently equipped to (read from the journal). Pass an explicit
   * list to apply to only specific platforms (e.g. platform-enable
   * backfill: "apply this augment to only the newly-enabled platform").
   *
   * Apply NEVER writes to a disabled platform — caller must filter.
   */
  platforms?: string[];
}

/**
 * AugmentInput → AugmentConfig adapter.
 */
function defToAugmentConfig(def: AugmentInput): AugmentConfig {
  const config: AugmentConfig = {
    name: def.name,
    source: def.source,
  };
  if (def.serverUrl) config.serverUrl = def.serverUrl;
  if (def.rules) {
    config.rules = {
      content: def.rules.content,
      version: def.rules.version,
      marker: def.rules.marker,
      ...(def.rules.fileName && { fileName: def.rules.fileName }),
    };
  }
  if (def.stdio) {
    config.stdio = {
      command: def.stdio.command,
      args: def.stdio.args,
      envKey: def.stdio.envKey ?? def.envKey ?? "",
    };
  }
  if (def.hooks && def.hooks.length > 0) config.hooks = def.hooks;
  if (def.hookDir) config.hookDir = def.hookDir;
  if (def.skills && def.skills.length > 0) config.skills = def.skills;
  return config;
}

export function writeAugmentDefAndApply(
  def: AugmentInput,
  opts: WriteAugmentDefAndApplyOptions = {},
): { def: AugmentInput; applyReport: InstallReportBuilder | null } {
  // Resolve target platforms from the journal (or caller override).
  let platformIds = opts.platforms;
  if (platformIds === undefined) {
    const resolved = JsonStore.resolve(def.name);
    platformIds = resolved?.installedPlatforms ?? [];
  }

  // No platforms equipped → nothing to propagate. Drafts that have
  // never been installed are not represented in the journal.
  if (platformIds.length === 0) {
    return { def, applyReport: null };
  }

  // Construct Augment from def, run apply. apply→reconcile puts the
  // content blob and appends the install intent; the journal's view of
  // this augment is updated atomically.
  //
  // apiKey is null on the update path — installMcp updates the MCP
  // config in-place and existing credentials persist in the platform-
  // specific config. First-time install via runInstall resolves auth
  // before apply.
  const config = defToAugmentConfig(def);
  const equip = new Augment(config);
  const platforms = platformIds.map((id) => createManualPlatform(id));

  const applyReport = apply(equip, def, platforms, null, {
    dryRun: opts.dryRun,
    takeover: opts.takeover,
    adopt: opts.adopt,
    logger: opts.logger,
    report: opts.report,
  });

  return { def, applyReport };
}

/**
 * Run a direct-mode install for an augment fetched from the registry.
 */
async function resolveRequiredMcpInstallInputs(
  toolName: string,
  target: McpInstallTarget,
  parsedArgs: ParsedArgs,
  providedInputs: Record<string, string | undefined>,
  apiKey: string | null,
): Promise<Record<string, string | undefined>> {
  const inputs = { ...providedInputs };
  const effectiveInputs = effectiveMcpInputsForInstall(target, inputs, apiKey);
  const report = assessMcpInstallability(target, { inputs: effectiveInputs });

  if (report.status === "unsupported") {
    cli.fail(report.findings.find((finding) => finding.severity === "blocked")?.message || report.summary);
    for (const finding of report.findings.filter((entry) => entry.remediation)) {
      cli.log(`  ${cli.DIM}${finding.remediation}${cli.RESET}`);
    }
    process.exit(1);
  }

  const missing = report.requiredInputs.filter((input) => !effectiveInputs[input.key]?.trim());
  if (missing.length === 0) return inputs;

  if (parsedArgs.nonInteractive || !process.stdin.isTTY) {
    cli.fail(`${toolName} requires MCP install input${missing.length === 1 ? "" : "s"}: ${missing.map((input) => input.key).join(", ")}`);
    cli.log(`  ${cli.DIM}Use --mcp-input KEY=VALUE for non-secret values or --mcp-input-file KEY=path for secrets.${cli.RESET}`);
    process.exit(1);
  }

  for (const input of missing) {
    const label = input.label || input.key;
    const value = input.secret
      ? await cli.promptSecret(`  ${label}: `)
      : await cli.prompt(`  ${label}: `);
    if (!value.trim()) {
      cli.fail(`${label} is required to install ${toolName}`);
      process.exit(1);
    }
    inputs[input.key] = value.trim();
  }

  cli.ok(`Collected ${missing.length} MCP install value${missing.length === 1 ? "" : "s"}`);
  return inputs;
}

function effectiveMcpInputsForInstall(
  target: McpInstallTarget,
  inputs: Record<string, string | undefined>,
  apiKey: string | null,
): Record<string, string | undefined> {
  const effective = { ...inputs };
  if (!apiKey) return effective;

  const requiredSecrets = target.inputs.filter((input) => input.required && input.secret);
  if (requiredSecrets.length !== 1) return effective;

  const secret = requiredSecrets[0];
  if (!effective[secret.key]?.trim()) effective[secret.key] = apiKey;
  if (target.kind === "stdio" && target.envKey && !effective[target.envKey]?.trim()) {
    effective[target.envKey] = apiKey;
  }
  return effective;
}

async function enforceMcpRuntimePreflight(
  toolName: string,
  target: McpInstallTarget,
  parsedArgs: ParsedArgs,
  inputs: Record<string, string | undefined>,
  apiKey: string | null,
): Promise<void> {
  const effectiveInputs = effectiveMcpInputsForInstall(target, inputs, apiKey);
  const report = await assessMcpRuntimeReadiness(target, {
    inputs: effectiveInputs,
    allowDockerDaemonProbe: true,
  });

  if (report.status === "not-needed") return;
  if (report.status === "ready") {
    cli.ok(`Local runtime ready for ${toolName}`);
    return;
  }

  if (report.status === "not-checked") {
    cli.warn(report.summary);
    logRuntimeReadinessDetails(report);
    return;
  }

  if (parsedArgs.dryRun) {
    cli.warn(`${toolName} runtime is not ready: ${report.summary}`);
    logRuntimeReadinessDetails(report);
    return;
  }

  if (parsedArgs.force) {
    cli.warn(`${toolName} runtime is not ready; continuing because --force was supplied.`);
    logRuntimeReadinessDetails(report);
    return;
  }

  cli.fail(`${toolName} runtime is not ready: ${report.summary}`);
  logRuntimeReadinessDetails(report);
  cli.log(`  ${cli.DIM}Install the missing runtime or re-run with --force to write config anyway.${cli.RESET}`);
  process.exit(1);
}

function logRuntimeReadinessDetails(report: McpRuntimeReadinessReport): void {
  const actionable = report.checks.filter((check) =>
    check.status !== "ready" && check.status !== "not-applicable"
  );
  const checks = actionable.length > 0 ? actionable : report.checks;
  for (const check of checks) {
    const prefix = runtimeCheckPrefix(check);
    cli.log(`  ${prefix}${check.requirement.label}: ${check.detail}${cli.RESET}`);
    if (check.remediation) {
      cli.log(`  ${cli.DIM}${check.remediation}${cli.RESET}`);
    }
  }
}

function runtimeCheckPrefix(check: McpRuntimeReadinessCheck): string {
  if (check.status === "ready") return cli.GREEN;
  if (check.status === "missing" || check.status === "unreachable" || check.status === "needs-input") return cli.RED;
  return cli.YELLOW;
}

export async function runInstall(toolDef: RegistryDef, parsedArgs: ParsedArgs, equipVersion: string): Promise<void> {
  const logger = parsedArgs.verbose ? createConsoleLogger() : undefined;
  const dryRun = parsedArgs.dryRun;

  cli.log(`\n${cli.BOLD}equip${cli.RESET} v${equipVersion} — installing ${toolDef.title || toolDef.name}`);
  if (dryRun) cli.warn("DRY RUN — no changes will be made");
  const installGate = enforceRegistryInstallReviewGate(toolDef, parsedArgs);

  const preAuthEquip = new Augment(registryDefToConfig(toolDef, {
    logger,
    mcpInstallInputs: { ...parsedArgs.mcpInputs },
    apiKey: null,
  }));
  const preAuthPlatforms = filterDetectedPlatforms(preAuthEquip.detect(), parsedArgs);
  enforceDetectedPlatforms(preAuthPlatforms, parsedArgs);
  const earlyConfigFailures = preflightMcpTransportCompatibility(preAuthEquip, preAuthPlatforms, toolDef.transport || "http");
  if (earlyConfigFailures.length > 0) {
    logMcpConfigPreflightFailures(earlyConfigFailures);
    process.exit(1);
  }

  // ── Auth Resolution ──
  let apiKey: string | null = null;
  const authConfig = toolDef.auth || (toolDef.requiresAuth ? { type: "oidc" as const } : { type: "none" as const });
  enforceCredentialEligibility(toolDef, authConfig, parsedArgs);

  // OIDC delegated access tokens are bearer credentials — require HTTPS on the augment's server URL.
  if (authConfig.type === "oidc" && toolDef.serverUrl) {
    const isLocal = toolDef.serverUrl.startsWith("http://localhost") || toolDef.serverUrl.startsWith("http://127.0.0.1");
    if (!toolDef.serverUrl.startsWith("https://") && !isLocal) {
      cli.fail("OIDC delegated-auth augments require HTTPS server URLs for security");
      process.exit(1);
    }
  }

  if (authConfig.type !== "none") {
    const authResult = await resolveAuth({
      toolName: toolDef.name,
      auth: authConfig,
      logger,
      apiKey: parsedArgs.apiKey,
      nonInteractive: parsedArgs.nonInteractive,
      dryRun,
    });

    if (!authResult.credential) {
      cli.fail(authResult.error || `${toolDef.name} requires authentication`);
      process.exit(1);
    }

    apiKey = authResult.credential;

    // Validate credential
    if (authConfig.validationUrl && !dryRun) {
      const validation = await validateCredential(apiKey, authConfig, logger);
      if (validation.valid === false) {
        cli.fail(`Credential invalid: ${validation.detail}`);
        cli.log(`  ${cli.DIM}Try: equip reauth ${toolDef.name}${cli.RESET}`);
        process.exit(1);
      }
      if (validation.valid === true) {
        cli.ok(`Authenticated ${cli.DIM}(${authResult.method}, validated)${cli.RESET}`);
      } else {
        cli.ok(`Authenticated ${cli.DIM}(${authResult.method})${cli.RESET}`);
      }
    } else {
      cli.ok(`Authenticated ${cli.DIM}(${authResult.method})${cli.RESET}`);
    }
  }

  // ── Platform Detection ──
  let mcpInstallInputs: Record<string, string | undefined> = { ...parsedArgs.mcpInputs };
  let config = registryDefToConfig(toolDef, { logger, mcpInstallInputs, apiKey });
  if (config.mcpInstallTarget) {
    mcpInstallInputs = await resolveRequiredMcpInstallInputs(
      toolDef.name,
      config.mcpInstallTarget,
      parsedArgs,
      mcpInstallInputs,
      apiKey,
    );
    config = registryDefToConfig(toolDef, { logger, mcpInstallInputs, apiKey });
    if (config.mcpInstallTarget) {
      await enforceMcpRuntimePreflight(
        toolDef.name,
        config.mcpInstallTarget,
        parsedArgs,
        mcpInstallInputs,
        apiKey,
      );
    }
  }
  config.equipVersion = equipVersion;
  const equip = new Augment(config);
  const platforms = filterDetectedPlatforms(equip.detect(), parsedArgs, { logDisabled: true });
  enforceDetectedPlatforms(platforms, parsedArgs);

  const names = platforms.map(p => platformName(p.platform)).join(", ");
  cli.log(`\n  Detected   ${names}`);

  if (equip.serverUrl || equip.stdio || equip.mcpInstallTarget) {
    const configFailures = preflightMcpConfigCompatibility(equip, platforms, apiKey, toolDef.transport || "http");
    if (configFailures.length > 0) {
      logMcpConfigPreflightFailures(configFailures);
      process.exit(1);
    }
  }

  // ── Capture initial snapshots before any modifications ──
  if (!dryRun) {
    ensureInitialSnapshots(platforms);
  }

  // ── Apply ──
  // The install-loop and state-reconciliation half lives in `apply()` so
  // it can be reused by registry refreshes, authoring save, platform-enable
  // backfill, and the equip apply CLI command.
  const report = apply(equip, toolDef, platforms, apiKey, {
    dryRun,
    takeover: parsedArgs.takeover,
    adopt: parsedArgs.adopt,
    logger,
  });
  if (!dryRun && installGate.bypassable && (parsedArgs.acceptRisk || parsedArgs.allowUnreviewed)) {
    try {
      writeRegistryInstallGateAcceptanceReceipt(toolDef, installGate, {
        surface: "equip-cli",
        actorLocalProfile: getInstallId(),
        acceptedReasonCodes: acceptedRiskReasonCodes(installGate, parsedArgs),
        installResult: report.overallSuccess ? "succeeded" : "failed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cli.warn(`Could not write install warning receipt: ${message}`);
    }
  }

  // ── Telemetry ──
  if (!dryRun) {
    try {
      const meta = readEquipMeta();
      if (meta.preferences.telemetry !== false) {
        const payload = {
          tool: toolDef.name,
          action: "install",
          ...report.toJSON(),
          os: process.platform,
          arch: process.arch,
          equipVersion,
          nodeVersion: process.version,
          installId: getInstallId(),
        };
        fetch(`${REGISTRY_API}/telemetry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      }
    } catch { /* fire and forget */ }
  }

  // ── Summary ──
  cli.log("");
  const succeeded = platforms.length;
  cli.log(`${cli.GREEN}${cli.BOLD}  Done.${cli.RESET} ${succeeded} platform${succeeded === 1 ? "" : "s"} configured.`);
  if (report.warningCount > 0) {
    cli.log(`  ${cli.DIM}${report.warningCount} warning${report.warningCount === 1 ? "" : "s"}${cli.RESET}`);
  }

  // Platform hints
  if (toolDef.platformHints) {
    for (const p of platforms) {
      const hint = toolDef.platformHints[p.platform];
      if (hint) {
        cli.log(`\n  ${cli.DIM}${platformName(p.platform)}: ${hint}${cli.RESET}`);
      }
    }
  }

  // ── Post-Install Actions ──
  if (!dryRun && toolDef.postInstall && toolDef.postInstall.length > 0) {
    const isInteractive = !parsedArgs.nonInteractive;
    for (const action of toolDef.postInstall) {
      const cond = action.condition || "interactive";
      if (cond === "interactive" && !isInteractive) continue;
      if (cond === "non_interactive" && isInteractive) continue;

      await executePostInstallAction(action, { apiKey, logger });
    }
  }

  cli.log("");
}

// ─── Post-Install Action Executor ───────────────────────────

export function enforceRegistryInstallReviewGate(toolDef: RegistryDef, parsedArgs: ParsedArgs): RegistryInstallReviewGate {
  const gate = resolveRegistryInstallReviewGate(toolDef);
  if (gate.allowed) return gate;

  cli.warn(gate.title);
  cli.log(`  ${cli.DIM}${gate.detail}${cli.RESET}`);
  for (const reason of gate.unsuppressedWarningReasons || gate.warningReasons || []) {
    cli.log(`  ${cli.YELLOW}${reason.code}${cli.RESET} ${reason.message || reason.details || ""}`.trimEnd());
    if (reason.details) cli.log(`  ${cli.DIM}${reason.details}${cli.RESET}`);
  }

  if (gate.bypassable && (parsedArgs.acceptRisk || parsedArgs.allowUnreviewed)) {
    if (parsedArgs.acceptedRiskReasons.length > 0) {
      const missing = missingAcceptedRiskReasons(gate, parsedArgs.acceptedRiskReasons);
      if (missing.length > 0) {
        cli.fail(`--accept-risk did not include all current warning reasons: ${missing.join(", ")}`);
        cli.log(`  ${cli.DIM}Use --accept-risk with no value to accept all current warning reasons for this install attempt.${cli.RESET}`);
        process.exit(1);
      }
    }
    if (parsedArgs.allowUnreviewed && !parsedArgs.acceptRisk) {
      cli.warn("--allow-unreviewed is deprecated; use --accept-risk for registry MCP install warnings.");
    } else {
      cli.warn("Explicit --accept-risk supplied; continuing after MCP install warnings.");
    }
    return gate;
  }

  if (gate.bypassable) {
    cli.log(`  ${cli.DIM}Install only if you personally trust the publisher, source, and local runtime requirements. Re-run with --accept-risk to proceed.${cli.RESET}`);
  }

  process.exit(1);
}

function missingAcceptedRiskReasons(gate: RegistryInstallReviewGate, accepted: string[]): string[] {
  return missingAcceptedWarningReasonCodes(gate, accepted);
}

function acceptedRiskReasonCodes(gate: RegistryInstallReviewGate, parsedArgs: ParsedArgs): string[] {
  if (parsedArgs.acceptedRiskReasons.length > 0) return parsedArgs.acceptedRiskReasons;
  return (gate.unsuppressedWarningReasons || gate.warningReasons || []).map((reason) => reason.code);
}

function enforceCredentialEligibility(toolDef: RegistryDef, authConfig: AuthConfig, parsedArgs: ParsedArgs): void {
  if (authConfig.type === "none") return;
  if (!registryDefHasMcp(toolDef)) return;
  const eligibility = (toolDef.trustState?.credentialEligibility || "").trim().toLowerCase();
  if (eligibility === "eligible") return;

  if (eligibility === "user-supplied-only" && authConfig.type === "api_key" && parsedArgs.apiKey) {
    return;
  }

  const detail = !eligibility
    ? "This MCP augment did not include credential eligibility metadata, so Equip will not inject credentials."
    : eligibility === "user-supplied-only"
    ? "This MCP augment can only use credentials you explicitly provide for this install; Equip will not use stored, brokered, or session-derived credentials."
    : "This MCP augment is not eligible for Equip-managed credential injection.";
  cli.fail(detail);
  process.exit(1);
}

interface PostInstallContext {
  apiKey: string | null;
  logger?: import("../types").EquipLogger;
}

async function executePostInstallAction(
  action: NonNullable<RegistryDef["postInstall"]>[number],
  ctx: PostInstallContext,
): Promise<void> {
  if (action.type === "open_with_code") {
    cli.log("");
    const open = await cli.promptEnterOrEsc(`  Press ${cli.BOLD}Enter${cli.RESET} to open your dashboard, or ${cli.BOLD}Esc${cli.RESET} to exit: `);
    if (!open) return;

    let targetUrl = action.targetUrl;

    // Validate target URL scheme
    try { validateUrlScheme(targetUrl, "post-install action URL"); } catch {
      if (ctx.logger) ctx.logger.warn("Refusing to open unsafe URL scheme", { url: targetUrl });
      return;
    }

    // Fetch one-time code
    if (action.url && action.codePath) {
      try {
        validateUrlScheme(action.url, "post-install action fetch URL");
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (action.auth && ctx.apiKey) {
          if (isTrustedCredentialHost(action.url)) {
            headers.Authorization = `Bearer ${ctx.apiKey}`;
          } else if (ctx.logger) {
            ctx.logger.warn("Refusing to send credentials to untrusted host", { url: action.url });
          }
        }

        const res = await fetch(action.url, {
          method: "POST",
          headers,
          body: "{}",
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json() as Record<string, unknown>;

        // Navigate codePath (e.g., "data.code")
        const code = action.codePath.split(".").reduce((obj: unknown, key: string) => (obj as Record<string, unknown>)?.[key], data);
        if (code) {
          const separator = targetUrl.includes("?") ? "&" : "?";
          targetUrl = `${targetUrl}${separator}${action.codeParam}=${encodeURIComponent(String(code))}`;
        }
      } catch (e: unknown) {
        if (ctx.logger) ctx.logger.debug("Post-install code fetch failed, opening plain URL", { error: (e as Error).message });
      }
    }

    try {
      cli.log(`  ${cli.DIM}Opening ${targetUrl}${cli.RESET}`);
      // Must wait for the child process to hand off the URL before the parent exits.
      // The security fix in 288313f switched from execSync to spawn().unref(), which
      // allowed the Node process to exit before cmd/start finished launching the browser.
      await new Promise<void>((resolve) => {
        let child: ReturnType<typeof spawn>;
        if (process.platform === "win32") {
          child = spawn("cmd", ["/c", "start", "", targetUrl], { stdio: "ignore", shell: false });
        } else if (process.platform === "darwin") {
          child = spawn("open", [targetUrl], { stdio: "ignore" });
        } else {
          child = spawn("xdg-open", [targetUrl], { stdio: "ignore" });
        }
        child.on("error", () => resolve());
        child.on("close", () => resolve());
      });
    } catch (e: unknown) {
      cli.warn(`Could not open browser: ${(e as Error).message}`);
      cli.log(`  ${cli.DIM}Open manually: ${targetUrl}${cli.RESET}`);
    }
  }
}
