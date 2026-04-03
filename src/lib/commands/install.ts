// equip <augment> — direct-mode install.
// Handles auth, platform detection, MCP/rules/skills/hooks install, verification,
// state reconciliation, telemetry, and post-install actions.

import * as os from "os";
import { spawn } from "child_process";
import { Augment, type AugmentConfig } from "../../index";
import { toolDefToEquipConfig, REGISTRY_API, type ToolDefinition } from "../registry";
import { platformName, resolvePlatformId } from "../platforms";
import { InstallReportBuilder } from "../types";
import { resolveAuth, validateCredential } from "../auth-engine";
import { reconcileState } from "../reconcile";
import { isPlatformEnabled } from "../platform-state";
import { readEquipMeta } from "../equip-meta";
import { ensureInitialSnapshots } from "../snapshots";
import { createConsoleLogger, type ParsedArgs } from "../cli";
import * as cli from "../cli";

/**
 * Run a direct-mode install for an augment fetched from the registry.
 */
export async function runInstall(toolDef: ToolDefinition, parsedArgs: ParsedArgs, equipVersion: string): Promise<void> {
  const logger = parsedArgs.verbose ? createConsoleLogger() : undefined;
  const dryRun = parsedArgs.dryRun;

  cli.log(`\n${cli.BOLD}equip${cli.RESET} v${equipVersion} — installing ${toolDef.displayName || toolDef.name}`);
  if (dryRun) cli.warn("DRY RUN — no changes will be made");

  // ── Auth Resolution ──
  let apiKey: string | null = null;
  const authConfig = toolDef.auth || (toolDef.requiresAuth ? { type: "api_key" as const } : { type: "none" as const });

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
  const config = toolDefToEquipConfig(toolDef, { logger });
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

  // ── Install Loop ──
  const report = new InstallReportBuilder();
  const stepList = ["MCP Server"];
  if (config.rules) stepList.push("Behavioral Rules");
  const hasSkills = (config.skills && config.skills.length > 0) || (config as AugmentConfig & { skill?: unknown }).skill;
  if (hasSkills) stepList.push("Skills");
  stepList.push("Verification");
  const totalSteps = stepList.length;
  let stepNum = 0;

  // MCP Server
  cli.step(++stepNum, totalSteps, "MCP Server");
  const transport = toolDef.transport || "http";
  cli.log(`  Transport  ${transport}`);

  for (const p of platforms) {
    const result = equip.installMcp(p, apiKey as string, { transport, dryRun });
    report.addResult(p.platform, result);
    if (result.success) {
      cli.ok(`${platformName(p.platform)}   MCP server "${toolDef.name}" ${dryRun ? "would be " : ""}added ${cli.DIM}(${transport}, ${result.method})${cli.RESET}`);
    } else {
      cli.fail(`${platformName(p.platform)}   ${result.error || result.errorCode}`);
    }
  }

  // Rules
  if (config.rules) {
    cli.step(++stepNum, totalSteps, "Behavioral Rules");
    for (const p of platforms) {
      if (!p.rulesPath) {
        if (logger) logger.debug("Skipping rules — no writable rules path", { platform: p.platform });
        continue;
      }
      const result = equip.installRules(p, { dryRun });
      report.addResult(p.platform, result);
      if (result.action === "created" || result.action === "updated") {
        cli.ok(`${platformName(p.platform)}   Rules v${config.rules.version} ${result.action}`);
      } else if (result.action === "skipped" && result.attempted) {
        cli.ok(`${platformName(p.platform)}   Rules already current`);
      }
    }
  }

  // Skills
  if (hasSkills) {
    cli.step(++stepNum, totalSteps, "Skills");
    const skillNames = (config.skills || []).map(s => s.name);
    for (const p of platforms) {
      const result = equip.installSkill(p, { dryRun });
      report.addResult(p.platform, result);
      if (result.action === "created") {
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
      const changed = reconcileState({
        toolName: toolDef.name,
        package: toolDef.npmPackage || toolDef.name,
        marker: toolDef.rules?.marker || toolDef.name,
        toolDef,
        logger,
      });
      if (changed > 0 && logger) {
        logger.debug("State reconciled", { platforms: changed });
      }
    } catch (e: unknown) {
      if (logger) logger.warn("State reconciliation failed", { error: (e as Error).message });
    }
  }

  // ── Introspect MCP server for accurate weight ──
  if (!dryRun) {
    try {
      const { introspect } = await import("../mcp-introspect.js");
      const { readAugmentDef, writeAugmentDef } = await import("../augment-defs.js");

      let introAuth: string | undefined;
      if (apiKey) introAuth = `Bearer ${apiKey}`;

      let introResult;
      if (toolDef.serverUrl) {
        introResult = await introspect({ serverUrl: toolDef.serverUrl, auth: introAuth, timeout: 10000 });
      } else if (toolDef.stdioCommand) {
        introResult = await introspect({ stdio: { command: toolDef.stdioCommand, args: toolDef.stdioArgs || [] }, timeout: 10000 });
      }

      if (introResult) {
        const { applyIntrospectionWeights } = await import("../weight.js");
        const def = readAugmentDef(toolDef.name);
        if (def) {
          def.introspection = introResult;
          applyIntrospectionWeights(def, introResult);
          writeAugmentDef(def);
        }
      }
    } catch { /* best effort */ }
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
  action: NonNullable<ToolDefinition["postInstall"]>[number],
  ctx: PostInstallContext,
): Promise<void> {
  if (action.type === "open_with_code") {
    cli.log("");
    const open = await cli.promptEnterOrEsc(`  Press ${cli.BOLD}Enter${cli.RESET} to open your dashboard, or ${cli.BOLD}Esc${cli.RESET} to exit: `);
    if (!open) return;

    let targetUrl = action.targetUrl;

    // Fetch one-time code
    if (action.url && action.codePath) {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (action.auth && ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;

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
      if (process.platform === "win32") {
        const { execSync } = require("child_process") as typeof import("child_process");
        execSync(`start "" "${targetUrl}"`, { shell: "cmd.exe" as string, stdio: "ignore" });
      } else if (process.platform === "darwin") {
        spawn("open", [targetUrl], { detached: true, stdio: "ignore" }).unref();
      } else {
        spawn("xdg-open", [targetUrl], { detached: true, stdio: "ignore" }).unref();
      }
    } catch { /* best effort */ }
  }
}
