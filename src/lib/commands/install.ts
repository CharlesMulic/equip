// equip <augment> — direct-mode install.
// Handles auth, platform detection, MCP/rules/skills/hooks install, verification,
// state reconciliation, telemetry, and post-install actions.

import * as os from "os";
import { spawn } from "child_process";
import { Augment, type AugmentConfig } from "../../index";
import { registryDefToConfig, REGISTRY_API, type RegistryDef } from "../registry";
import { platformName, resolvePlatformId } from "../platforms";
import { InstallReportBuilder } from "../types";
import { resolveAuth, validateCredential } from "../auth-engine";
import { reconcileState } from "../reconcile";
import { isPlatformEnabled } from "../platform-state";
import { readEquipMeta } from "../equip-meta";
import { ensureInitialSnapshots } from "../snapshots";
import { validateUrlScheme, isTrustedCredentialHost } from "../validation";
import { readAugmentDef, writeAugmentDef } from "../augment-defs";
import { createConsoleLogger, type ParsedArgs } from "../cli";
import * as cli from "../cli";

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
  const config = registryDefToConfig(toolDef, { logger });
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
  const hasSkills = config.skills && config.skills.length > 0;
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

  // ── Introspect MCP server for accurate weight (optional) ──
  // mcp-introspect and weight modules are in the desktop app sidecar, not in this
  // package. If available (e.g., when run from the sidecar), introspection runs.
  // If not (pure CLI), this silently skips — install still works, just without
  // accurate weight data. The desktop app will introspect on next load.
  if (!dryRun) {
    try {
      const def = readAugmentDef(toolDef.name);
      if (def) {
        // Estimate weight from the definition (no introspection needed)
        const rulesTokens = def.rules?.content ? Math.round(def.rules.content.length / 4) : 0;
        const skillTokens = (def.skills || []).reduce((sum: number, s: { files?: { content?: string }[] }) =>
          sum + (s.files || []).reduce((fsum: number, f: { content?: string }) =>
            fsum + (f.content ? Math.round(f.content.length / 4) : 0), 0), 0);
        if (def.baseWeight === 0 && rulesTokens > 0) {
          def.baseWeight = rulesTokens;
          def.loadedWeight = skillTokens;
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
