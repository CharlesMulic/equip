// equip <augment> — direct-mode install.
// Handles auth, platform detection, MCP/rules/skills/hooks install, verification,
// state reconciliation, telemetry, and post-install actions.

import * as os from "os";
import { spawn } from "child_process";
import { Augment, type AugmentConfig } from "../../index";
import { registryDefToConfig, REGISTRY_API, type RegistryDef } from "../registry";
import { createManualPlatform } from "../platforms";
import { platformName, resolvePlatformId } from "../platforms";
import { InstallReportBuilder } from "../types";
import { resolveAuth, validateCredential } from "../auth-engine";
import { reconcileState } from "../reconcile";
import { isPlatformEnabled } from "../platform-state";
import { acquireLock } from "../fs";
import { withInstallationsBatch } from "../installations";
import { JsonStore } from "../storage/datastore";
import { readEquipMeta, getInstallId } from "../equip-meta";
import { ensureInitialSnapshots } from "../snapshots";
import { validateUrlScheme, isTrustedCredentialHost } from "../validation";
import { readAugmentDef, writeAugmentDef, augmentDefToConfig, type AugmentDef } from "../augment-defs";
import { createConsoleLogger, type ParsedArgs } from "../cli";
import * as cli from "../cli";
import { noopCounter, COUNTER_NAMES, type Counter } from "../telemetry";

// ─── apply: put a def on platforms ─────────────────────────────────────────
//
// "Apply" is the second half of the equip refresh+apply pipeline:
//   - refresh: network or local-author edit writes to ~/.equip/augments/<name>.json
//   - apply: that def file → installed platform copies (this function)
//
// Callers are runInstall (first-time install with auth resolution + platform
// discovery upstream of apply) and the propagation paths from
// operations/initiatives/equip-augment-update-propagation/ (registry refresh,
// equip-app authoring save, platform-enable backfill, equip apply CLI).
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
// exactly the silent-staleness bug class the equip-augment-update-propagation
// initiative was created to fix.

export interface ApplyOptions {
  dryRun?: boolean;
  takeover?: boolean;
  adopt?: boolean;
  logger?: import("../types").EquipLogger;
  /** Optional caller-provided report builder; otherwise apply creates one. */
  report?: InstallReportBuilder;
  /**
   * Optional counter port for telemetry. Defaults to no-op when absent.
   * equip-app's bridge supplies the sidecar's metrics-store counter so
   * broker-mode installs are observable; standalone CLI omits it.
   */
  counter?: Counter;
}

/**
 * Apply an augment def to the named platforms. Writes MCP server config,
 * behavioral rules, skills, runs verification, reconciles state, and
 * re-estimates token weight from the persisted def.
 *
 * Acquires the equip-wide lock and wraps writes in withInstallationsBatch.
 * Safe to call from any caller; the lock is re-entrant via reconcileState.
 *
 * Caller MUST have already filtered disabled platforms out of `platforms`.
 *
 * Returns the populated InstallReportBuilder for the caller to inspect or
 * surface. See `operations/initiatives/equip-augment-update-propagation/work/01-apply-extraction.md`
 * for architectural context.
 */
export function apply(
  equip: Augment,
  toolDef: RegistryDef | AugmentDef,
  platforms: ReturnType<Augment["detect"]>,
  apiKey: string | null,
  opts: ApplyOptions = {},
): InstallReportBuilder {
  const { dryRun = false, takeover, adopt, logger } = opts;
  const transport = toolDef.transport || "http";
  const report = opts.report ?? new InstallReportBuilder();
  const counter = opts.counter ?? noopCounter;

  // Plan progress steps for CLI output. We read fields directly off `toolDef`
  // (rather than building an AugmentConfig adapter inside apply) so apply works
  // for both RegistryDef inputs (registry-fetched flow via runInstall) and
  // AugmentDef inputs (local-author edit propagation, registry-refresh
  // propagation). The Augment instance — which actually drives per-resource
  // writes — is the caller's responsibility.
  //
  // hasMcpServer mirrors the gate used by bridge.ts install paths: an augment
  // is allowed to be rules-only or skills-only with no MCP server. Without
  // this gate, equip.installMcp → buildConfig() throws "serverUrl is required
  // for MCP installation" on the user-save propagation path.
  const hasMcpServer = !!(equip.serverUrl || equip.stdio);
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
  // equip processes from corrupting installations.json or stomping each other's
  // skill writes.
  const releaseLock = acquireLock();

  try {
    withInstallationsBatch(() => {

      // MCP Server (skipped when augment has no server — rules/skills-only
      // augments are valid; matches bridge.ts install-path gating).
      if (hasMcpServer) {
        cli.step(++stepNum, totalSteps, "MCP Server");
        cli.log(`  Transport  ${transport}`);

        for (const p of platforms) {
          const result = equip.installMcp(p, apiKey, { transport, dryRun });
          report.addResult(p.platform, result);
          if (result.success) {
            cli.ok(`${platformName(p.platform)}   MCP server "${toolDef.name}" ${dryRun ? "would be " : ""}added ${cli.DIM}(${transport}, ${result.method})${cli.RESET}`);
            // Telemetry: this install path is direct-mode by definition (apply
            // doesn't dispatch to installMcpBroker). Broker-mode installs go
            // through equip-app's bridge with its own emit site; keeping the
            // call here ensures direct-mode is also counted.
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
            // Partial-augment install (ENG-0011): some skills landed, some refused.
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

    }); // withInstallationsBatch
  } finally {
    releaseLock();
  }

  return report;
}

// ─── writeAugmentDefAndApply: explicit "user save" boundary ────────────────
//
// Use this helper instead of plain `writeAugmentDef` whenever a user-driven
// edit lands a new def state and the change should propagate immediately to
// installed platform copies. Examples:
//   - equip-app authoring save (the canonical "Save" button)
//   - future publisher draft commit-to-live flows
//   - CLI `equip apply <augment>` (Package 04 — falls through to apply directly)
//
// Internal-only writes (migrations, normalizations, registry-tracking sentinel
// stamps, draft state mutations that don't touch live resources) MUST keep
// using plain `writeAugmentDef` and skip apply. Architect's review (2026-04-26)
// rejected file-watcher-on-augments-dir as a trap because multiple internal
// code paths write to the def file; the explicit write boundary in this helper
// is the correct discipline.
//
// If the augment isn't equipped to any platform (no installations.json record
// or empty platforms array), apply is skipped — there's nowhere to propagate.
//
// Returns the persisted def + apply report. apply report is null when apply
// was skipped (no platforms to write to).

export interface WriteAugmentDefAndApplyOptions extends ApplyOptions {
  /**
   * Override platform list. Default: read from installations.json — every
   * platform the augment is currently equipped to. Pass an explicit list to
   * apply to only specific platforms (used by Package 05 platform-enable
   * backfill: `apply this augment to only the newly-enabled platform`).
   *
   * Apply NEVER writes to a disabled platform — caller must filter.
   */
  platforms?: string[];
}

export function writeAugmentDefAndApply(
  def: AugmentDef,
  opts: WriteAugmentDefAndApplyOptions = {},
): { def: AugmentDef; applyReport: InstallReportBuilder | null } {
  // 1. Write the def.
  writeAugmentDef(def);

  // 2. Read the persisted shape back. Mirrors Package 02's mod-preservation
  //    discipline — apply must operate on the persisted shape, not the input,
  //    so any normalization/merge done by writeAugmentDef is reflected.
  const persisted = readAugmentDef(def.name);
  if (!persisted) {
    // Should not happen — writeAugmentDef just succeeded — but defensive.
    return { def, applyReport: null };
  }

  // 3. Resolve target platforms.
  let platformIds = opts.platforms;
  if (platformIds === undefined) {
    // Phase A: read via journal-canonical resolver.
    const resolved = JsonStore.resolve(def.name);
    platformIds = resolved?.installedPlatforms ?? [];
  }

  // No platforms equipped → nothing to propagate.
  if (platformIds.length === 0) {
    return { def: persisted, applyReport: null };
  }

  // 4. Construct Augment instance from persisted def, run apply.
  //    apiKey is null on the update path — installMcp updates the MCP config
  //    in-place and existing credentials persist in the platform-specific
  //    config. First-time install via `runInstall` resolves auth before apply.
  const config = augmentDefToConfig(persisted);
  const equip = new Augment(config);
  const platforms = platformIds.map((id) => createManualPlatform(id));

  const applyReport = apply(equip, persisted, platforms, null, {
    dryRun: opts.dryRun,
    takeover: opts.takeover,
    adopt: opts.adopt,
    logger: opts.logger,
    report: opts.report,
  });

  return { def: persisted, applyReport };
}

/**
 * Run a direct-mode install for an augment fetched from the registry.
 */
export async function runInstall(toolDef: RegistryDef, parsedArgs: ParsedArgs, equipVersion: string): Promise<void> {
  const logger = parsedArgs.verbose ? createConsoleLogger() : undefined;
  const dryRun = parsedArgs.dryRun;

  cli.log(`\n${cli.BOLD}equip${cli.RESET} v${equipVersion} — installing ${toolDef.title || toolDef.name}`);
  if (dryRun) cli.warn("DRY RUN — no changes will be made");

  // ── Auth Resolution ──
  let apiKey: string | null = null;
  const authConfig = toolDef.auth || (toolDef.requiresAuth ? { type: "oidc" as const } : { type: "none" as const });

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
  const config = registryDefToConfig(toolDef, { logger });
  config.equipVersion = equipVersion;
  const equip = new Augment(config);
  let platforms = equip.detect();

  // Filter out disabled platforms
  const beforeFilter = platforms.length;
  platforms = platforms.filter(p => isPlatformEnabled(p.platform));
  if (platforms.length < beforeFilter) {
    const skipped = beforeFilter - platforms.length;
    cli.log(`  ${cli.DIM}${skipped} disabled platform${skipped === 1 ? "" : "s"} skipped${cli.RESET}`);
  }

  // Filter by --platform if specified
  if (parsedArgs.platform) {
    const requested = parsedArgs.platform.split(",").map(s => resolvePlatformId(s.trim()));
    platforms = platforms.filter(p => requested.includes(p.platform));
    if (platforms.length === 0) {
      cli.fail(`None of the specified platforms detected: ${parsedArgs.platform}`);
      process.exit(1);
    }
  }

  if (platforms.length === 0) {
    cli.fail("No supported AI coding tools detected.");
    cli.log(`\n  Install one of: Claude Code, Cursor, Windsurf, VS Code, Cline, Roo Code`);
    process.exit(1);
  }

  const names = platforms.map(p => platformName(p.platform)).join(", ");
  cli.log(`\n  Detected   ${names}`);

  // ── Capture initial snapshots before any modifications ──
  if (!dryRun) {
    ensureInitialSnapshots(platforms);
  }

  // ── Apply ──
  // The install-loop, state-reconciliation, and token-weight-recompute half
  // lives in `apply()` so it can be reused by registry-refresh, equip-app
  // authoring save, platform-enable backfill, and the equip apply CLI command
  // (operations/initiatives/equip-augment-update-propagation/).
  const report = apply(equip, toolDef, platforms, apiKey, {
    dryRun,
    takeover: parsedArgs.takeover,
    adopt: parsedArgs.adopt,
    logger,
  });

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
