#!/usr/bin/env node
// @cg3/equip CLI — augment your AI agents.
// Usage: equip <command> [args...]

"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
const EQUIP_VERSION = PKG.version;

// ─── Registry ───────────────────────────────────────────────

const REGISTRY = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "registry.json"), "utf-8")
);
const TOOLS = {};
for (const [key, value] of Object.entries(REGISTRY)) {
  if (!key.startsWith("$")) TOOLS[key] = value;
}

// ─── Arg Parsing ───────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [], verbose: false, dryRun: false, apiKey: null, nonInteractive: false, platform: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verbose") { args.verbose = true; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--non-interactive") { args.nonInteractive = true; }
    else if (a === "--api-key" && i + 1 < argv.length) { args.apiKey = argv[++i]; }
    else if (a === "--platform" && i + 1 < argv.length) { args.platform = argv[++i]; }
    else { args._.push(a); }
  }
  return args;
}

// ─── Built-in Commands ──────────────────────────────────────

const BUILTIN_COMMANDS = new Set(["status", "doctor", "update", "reauth", "refresh", "list", "demo", "--help", "-h", "--version", "-v"]);

function isBuiltin(cmd) {
  return BUILTIN_COMMANDS.has(cmd);
}

// ─── One-Time State Migration ──────────────────────────────

// Migrate from legacy state.json to new multi-file architecture on first run.
// Idempotent — skips if already migrated.
try {
  const { migrateState } = require("../dist/lib/migration");
  migrateState();
} catch {}

// ─── Stale Version Nudge ────────────────────────────────────

function checkStaleVersion() {
  try {
    const { readEquipMeta } = require("../dist/lib/equip-meta");
    const meta = readEquipMeta();
    const lastUpdated = meta.lastUpdated;
    if (lastUpdated) {
      const daysSince = (Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 14) {
        const { YELLOW, RESET, DIM } = require("../dist/lib/cli");
        process.stderr.write(`  ${YELLOW}equip v${EQUIP_VERSION} is ${Math.floor(daysSince)} days old${RESET} ${DIM}— run "equip update" for platform fixes${RESET}\n\n`);
      }
    }
  } catch {}
}

// ─── Command: --version ─────────────────────────────────────

function cmdVersion() {
  console.log(`equip v${EQUIP_VERSION}`);
}

// ─── Command: --help ────────────────────────────────────────

function cmdHelp() {
  console.log(`equip v${EQUIP_VERSION} — augment your AI agents`);
  console.log("");
  console.log("Usage: equip <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  <augment>        Install an augment from the registry");
  console.log("  ./script.js      Run a local setup script (for development)");
  console.log("  .                Run current directory's package bin entry");
  console.log("  uninstall <name> Remove an augment (alias: unequip)");
  console.log("  reauth <name>    Re-authenticate and update credentials");
  console.log("  refresh [name]   Refresh expired OAuth tokens");
  console.log("  status           Show all MCP servers across all platforms");
  console.log("  doctor           Validate config integrity and detect drift");
  console.log("  update           Update equip and migrate configs");
  console.log("  list             Show registered tools");
  console.log("  demo             Run the built-in demo");
  console.log("");
  console.log("Options:");
  console.log("  --verbose        Show detailed logging");
  console.log("  --api-key <key>  Provide API key (skip prompt)");
  console.log("  --platform <p>   Target specific platform(s), comma-separated");
  console.log("  --dry-run        Preview without writing");
  console.log("  --help, -h       Show this help");
  console.log("  --version, -v    Show version");
  console.log("");
}

// ─── Command: list ──────────────────────────────────────────

function cmdList() {
  const { GREEN, DIM, RESET, BOLD } = require("../dist/lib/cli");
  console.log(`\n${BOLD}Registered augments${RESET}\n`);
  for (const [name, info] of Object.entries(TOOLS)) {
    const desc = info.description ? `  ${DIM}${info.description}${RESET}` : "";
    console.log(`  ${GREEN}${name}${RESET}  →  ${info.package} ${info.command}${desc}`);
  }
  console.log(`\n  ${DIM}Install: equip <augment>${RESET}`);
  console.log(`  ${DIM}Browse:  https://cg3.io/equip${RESET}\n`);
}

// ─── Command: demo ──────────────────────────────────────────

function cmdDemo(extraArgs) {
  const demoPath = path.join(__dirname, "..", "demo", "setup.js");
  const child = spawn(process.execPath, [demoPath, ...extraArgs], {
    stdio: "inherit",
    env: { ...process.env, EQUIP_VERSION },
  });
  child.on("close", (code) => process.exit(code || 0));
  child.on("error", (err) => {
    console.error(`Failed to run demo: ${err.message}`);
    process.exit(1);
  });
}

// ─── Command: status ────────────────────────────────────────

function cmdStatus() {
  const { runStatus } = require("../dist/lib/commands/status");
  runStatus();
}

// ─── Command: doctor ────────────────────────────────────────

function cmdDoctor() {
  const { runDoctor } = require("../dist/lib/commands/doctor");
  runDoctor();
}

// ─── Command: update ────────────────────────────────────────

function cmdUninstall(args) {
  process.argv = [process.argv[0], process.argv[1], ...args];
  require("./unequip.js");
}

async function cmdUpdate(parsedArgs) {
  const toolName = parsedArgs._[0];

  // If a tool name is given, update that tool via direct-mode
  if (toolName) {
    const { fetchToolDef, validateCredential, readStoredCredential, cli } = require("../dist/index");
    const { log, ok, fail, warn, DIM, RESET, BOLD } = cli;
    const logger = parsedArgs.verbose ? createConsoleLogger() : undefined;

    log(`\n${BOLD}equip update${RESET} ${toolName}\n`);

    // Clear cache to get fresh definition
    try { fs.unlinkSync(path.join(os.homedir(), ".equip", "cache", `${toolName}.json`)); } catch {}

    const toolDef = await fetchToolDef(toolName, { logger });
    if (!toolDef) {
      fail(`Tool "${toolName}" not found in registry`);
      process.exit(1);
    }

    if (toolDef.installMode !== "direct") {
      // Package-mode: fall through to the legacy equip update
      log(`  ${DIM}${toolName} is package-mode — use: npx @cg3/${toolName} setup --update${RESET}\n`);
      return;
    }

    // Validate stored credential if we have one
    const authConfig = toolDef.auth || { type: "none" };
    const cred = readStoredCredential(toolName);
    if (cred?.credential && authConfig.validationUrl) {
      const v = await validateCredential(cred.credential, authConfig, logger);
      if (v.valid === false) {
        warn("Stored credential is invalid — re-authenticating...");
      } else if (v.valid === true) {
        ok("Credential valid");
      }
    }

    // Re-run directInstall (idempotent — rules skip if current, MCP overwrites)
    await directInstall(toolDef, parsedArgs);
    return;
  }

  // No tool name: legacy equip self-update
  const { runUpdate } = require("../dist/lib/commands/update");
  runUpdate();
}

async function cmdReauth(args) {
  const toolName = args._[0];
  if (!toolName) {
    console.error("Usage: equip reauth <tool>");
    process.exit(1);
  }

  const { fetchToolDef, resolveAuth, deleteStoredCredential, Augment, toolDefToEquipConfig, platformName, cli } = require("../dist/index");
  const { log, ok, fail, warn, DIM, RESET, BOLD } = cli;
  const logger = args.verbose ? createConsoleLogger() : undefined;

  log(`\n${BOLD}equip reauth${RESET} ${toolName}\n`);

  const toolDef = await fetchToolDef(toolName, { logger });
  if (!toolDef) {
    fail(`Tool "${toolName}" not found in registry`);
    process.exit(1);
  }

  const authConfig = toolDef.auth || (toolDef.requiresAuth ? { type: "api_key" } : null);
  if (!authConfig || authConfig.type === "none") {
    fail(`${toolName} does not require authentication`);
    process.exit(1);
  }

  // Delete stored credential to force fresh auth
  deleteStoredCredential(toolName);
  log("  Cleared stored credentials");

  const authResult = await resolveAuth({
    toolName,
    auth: authConfig,
    logger,
    apiKey: args.apiKey,
    nonInteractive: args.nonInteractive,
  });

  if (!authResult.credential) {
    fail(authResult.error || "Re-authentication failed");
    process.exit(1);
  }

  ok(`New credential obtained ${DIM}(${authResult.method})${RESET}`);

  // Update all platform configs with the new credential
  if (toolDef.installMode === "direct" && toolDef.serverUrl) {
    const config = toolDefToEquipConfig(toolDef, { logger });
    const equip = new Augment(config);
    const platforms = equip.detect();
    const transport = toolDef.transport || "http";

    log("\n  Updating platform configs...");
    for (const p of platforms) {
      const entry = equip.readMcp(p);
      if (entry) {
        equip.updateMcpKey(p, authResult.credential, transport);
        ok(`${platformName(p.platform)} updated`);
      }
    }
  }

  log(`\n${BOLD}Done.${RESET} Credentials rotated for ${toolName}.\n`);
}

async function cmdRefresh(args) {
  const { refreshCredential, refreshAllExpired, readStoredCredential, isCredentialExpired, listStoredCredentials, cli } = require("../dist/index");
  const { log, ok, fail, warn, DIM, RESET, BOLD } = cli;
  const logger = args.verbose ? createConsoleLogger() : undefined;

  const toolName = args._[0];

  if (toolName) {
    // Refresh a specific tool
    log(`\n${BOLD}equip refresh${RESET} ${toolName}\n`);

    const cred = readStoredCredential(toolName);
    if (!cred) {
      fail(`No stored credentials for ${toolName}`);
      process.exit(1);
    }

    if (!cred.oauth || !cred.oauth.refreshToken) {
      fail(`${toolName} has no OAuth refresh token — use 'equip reauth ${toolName}' instead`);
      process.exit(1);
    }

    const expired = isCredentialExpired(cred);
    if (!expired) {
      ok(`${toolName}: OAuth token is still valid`);
      if (cred.oauth.expiresAt) {
        const remaining = new Date(cred.oauth.expiresAt).getTime() - Date.now();
        const mins = Math.floor(remaining / 60000);
        log(`  ${DIM}Expires in ${mins} minute${mins === 1 ? "" : "s"}${RESET}`);
      }
      return;
    }

    const result = await refreshCredential(toolName, { logger, updateConfigs: true });
    if (result.success) {
      ok(`${toolName}: token refreshed`);
      if (result.configsUpdated && result.configsUpdated > 0) {
        ok(`${result.configsUpdated} platform config${result.configsUpdated === 1 ? "" : "s"} updated`);
      }
    } else {
      fail(`${toolName}: ${result.error}`);
      log(`  ${DIM}Try: equip reauth ${toolName}${RESET}`);
    }
  } else {
    // Refresh all expired credentials
    log(`\n${BOLD}equip refresh${RESET}\n`);

    const tools = listStoredCredentials();
    if (tools.length === 0) {
      log(`  ${DIM}No stored credentials found.${RESET}\n`);
      return;
    }

    let anyExpired = false;
    for (const name of tools) {
      const cred = readStoredCredential(name);
      if (!cred || !cred.oauth?.refreshToken) continue;
      if (!isCredentialExpired(cred)) {
        ok(`${name}: token valid`);
        continue;
      }

      anyExpired = true;
      const result = await refreshCredential(name, { logger, updateConfigs: true });
      if (result.success) {
        ok(`${name}: token refreshed${result.configsUpdated ? ` (${result.configsUpdated} config${result.configsUpdated === 1 ? "" : "s"} updated)` : ""}`);
      } else {
        fail(`${name}: ${result.error}`);
        log(`  ${DIM}Try: equip reauth ${name}${RESET}`);
      }
    }

    if (!anyExpired) {
      log(`  ${DIM}All tokens are current.${RESET}`);
    }
  }
  log("");
}

// ─── Auto-Refresh ──────────────────────────────────────────

async function autoRefreshExpired(verbose) {
  try {
    const { refreshAllExpired } = require("../dist/index");
    const logger = verbose ? createConsoleLogger() : undefined;
    const results = await refreshAllExpired({ logger });

    if (results.size > 0 && !verbose) {
      const { cli } = require("../dist/index");
      for (const [name, result] of results) {
        if (result.success) {
          cli.ok(`Auto-refreshed token for ${name}`);
        }
      }
    }
  } catch { /* best effort — don't block the command */ }
}

// ─── Logger ─────────────────────────────────────────────────

function createConsoleLogger() {
  const { DIM, RESET, YELLOW, RED } = require("../dist/lib/cli");
  return {
    debug(msg, ctx) { process.stderr.write(`  ${DIM}[debug] ${msg}${ctx ? " " + JSON.stringify(ctx) : ""}${RESET}\n`); },
    info(msg, ctx) { process.stderr.write(`  [info] ${msg}${ctx ? " " + JSON.stringify(ctx) : ""}\n`); },
    warn(msg, ctx) { process.stderr.write(`  ${YELLOW}[warn] ${msg}${ctx ? " " + JSON.stringify(ctx) : ""}${RESET}\n`); },
    error(msg, ctx) { process.stderr.write(`  ${RED}[error] ${msg}${ctx ? " " + JSON.stringify(ctx) : ""}${RESET}\n`); },
  };
}

// ─── Direct-Mode Install ───────────────────────────────────

async function directInstall(toolDef, parsedArgs) {
  const { Augment, toolDefToEquipConfig, platformName, resolvePlatformId, InstallReportBuilder, resolveAuth, validateCredential, cli } = require("../dist/index");
  const { reconcileState } = require("../dist/lib/reconcile");
  const { log, ok, fail, warn, step, prompt, DIM, RESET, BOLD, GREEN } = cli;

  const logger = parsedArgs.verbose ? createConsoleLogger() : undefined;
  const dryRun = parsedArgs.dryRun;

  log(`\n${BOLD}equip${RESET} v${EQUIP_VERSION} — installing ${toolDef.displayName || toolDef.name}`);
  if (dryRun) warn("DRY RUN — no changes will be made");

  // ── Auth Resolution (via AuthEngine) ──
  let apiKey = null;
  const authConfig = toolDef.auth || (toolDef.requiresAuth ? { type: "api_key" } : { type: "none" });

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
      fail(authResult.error || `${toolDef.name} requires authentication`);
      process.exit(1);
    }

    apiKey = authResult.credential;

    // Validate credential against tool's validation URL
    if (authConfig.validationUrl && !dryRun) {
      const validation = await validateCredential(apiKey, authConfig, logger);
      if (validation.valid === false) {
        fail(`Credential invalid: ${validation.detail}`);
        log(`  ${DIM}Try: equip reauth ${toolDef.name}${RESET}`);
        process.exit(1);
      }
      if (validation.valid === true) {
        ok(`Authenticated ${DIM}(${authResult.method}, validated)${RESET}`);
      } else {
        ok(`Authenticated ${DIM}(${authResult.method})${RESET}`);
      }
    } else {
      ok(`Authenticated ${DIM}(${authResult.method})${RESET}`);
    }
  }

  // ── Platform Detection ──
  const config = toolDefToEquipConfig(toolDef, { logger });
  const equip = new Augment(config);
  let platforms = equip.detect();

  // Filter out disabled platforms (from Equip desktop app)
  const { isPlatformEnabled } = require("../dist/lib/platform-state");
  const beforeFilter = platforms.length;
  platforms = platforms.filter(p => isPlatformEnabled(p.platform));
  if (platforms.length < beforeFilter) {
    const skipped = beforeFilter - platforms.length;
    const { DIM, RESET } = require("../dist/lib/cli");
    log(`  ${DIM}${skipped} disabled platform${skipped === 1 ? "" : "s"} skipped${RESET}`);
  }

  // Filter by --platform if specified
  if (parsedArgs.platform) {
    const requested = parsedArgs.platform.split(",").map(s => resolvePlatformId(s.trim()));
    platforms = platforms.filter(p => requested.includes(p.platform));
    if (platforms.length === 0) {
      fail(`None of the specified platforms detected: ${parsedArgs.platform}`);
      process.exit(1);
    }
  }

  if (platforms.length === 0) {
    fail("No supported AI coding tools detected.");
    log(`\n  Install one of: Claude Code, Cursor, Windsurf, VS Code, Cline, Roo Code`);
    process.exit(1);
  }

  const names = platforms.map(p => platformName(p.platform)).join(", ");
  log(`\n  Detected   ${names}`);

  // ── Install Loop ──
  const report = new InstallReportBuilder();
  const stepList = ["MCP Server"];
  if (config.rules) stepList.push("Behavioral Rules");
  const hasSkills = (config.skills && config.skills.length > 0) || config.skill;
  if (hasSkills) stepList.push("Skills");
  stepList.push("Verification");
  const totalSteps = stepList.length;
  let stepNum = 0;

  // MCP Server
  step(++stepNum, totalSteps, "MCP Server");
  const transport = toolDef.transport || "http";
  log(`  Transport  ${transport}`);

  for (const p of platforms) {
    const result = equip.installMcp(p, apiKey, { transport, dryRun });
    report.addResult(p.platform, result);
    if (result.success) {
      ok(`${platformName(p.platform)}   MCP server "${toolDef.name}" ${dryRun ? "would be " : ""}added ${DIM}(${transport}, ${result.method})${RESET}`);
    } else {
      fail(`${platformName(p.platform)}   ${result.error || result.errorCode}`);
    }
  }

  // Rules (only platforms with writable rules paths)
  if (config.rules) {
    step(++stepNum, totalSteps, "Behavioral Rules");
    for (const p of platforms) {
      if (!p.rulesPath) {
        if (logger) logger.debug("Skipping rules — no writable rules path", { platform: p.platform });
        continue;
      }
      const result = equip.installRules(p, { dryRun });
      report.addResult(p.platform, result);
      if (result.action === "created" || result.action === "updated") {
        ok(`${platformName(p.platform)}   Rules v${config.rules.version} ${result.action}`);
      } else if (result.action === "skipped" && result.attempted) {
        ok(`${platformName(p.platform)}   Rules already current`);
      }
    }
  }

  // Skills
  if (hasSkills) {
    step(++stepNum, totalSteps, "Skills");
    const skillNames = (config.skills || (config.skill ? [config.skill] : [])).map(s => s.name);
    for (const p of platforms) {
      const result = equip.installSkill(p, { dryRun });
      report.addResult(p.platform, result);
      if (result.action === "created") {
        ok(`${platformName(p.platform)}   ${skillNames.length} skill${skillNames.length === 1 ? "" : "s"} installed (${skillNames.join(", ")})`);
      } else if (result.action === "skipped" && result.attempted) {
        ok(`${platformName(p.platform)}   Skills already current`);
      }
    }
  }

  // Verification
  step(++stepNum, totalSteps, "Verification");
  if (!dryRun) {
    for (const p of platforms) {
      const v = equip.verify(p);
      if (v.ok) {
        ok(`${platformName(p.platform)}   All checks passed`);
      } else {
        const failed = v.checks.filter(c => !c.ok).map(c => c.detail).join(", ");
        warn(`${platformName(p.platform)}   ${failed}`);
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
      });
      if (changed > 0 && logger) {
        logger.debug("State reconciled", { platforms: changed });
      }
    } catch (e) {
      if (logger) logger.warn("State reconciliation failed", { error: e.message });
    }
  }

  // ── Telemetry — equip-backend (anonymous, fire and forget) ──
  if (!dryRun) {
    try {
      const payload = {
        tool: toolDef.name,
        action: "install",
        ...report.toJSON(),
        os: process.platform,
        arch: process.arch,
        equipVersion: EQUIP_VERSION,
        nodeVersion: process.version,
      };
      fetch("https://api.cg3.io/equip/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    } catch { /* fire and forget */ }
  }

  // ── Summary ──
  log("");
  const succeeded = platforms.length;
  log(`${GREEN}${BOLD}  Done.${RESET} ${succeeded} platform${succeeded === 1 ? "" : "s"} configured.`);
  if (report.warningCount > 0) {
    log(`  ${DIM}${report.warningCount} warning${report.warningCount === 1 ? "" : "s"}${RESET}`);
  }

  // Platform hints
  if (toolDef.platformHints) {
    for (const p of platforms) {
      const hint = toolDef.platformHints[p.platform];
      if (hint) {
        log(`\n  ${DIM}${platformName(p.platform)}: ${hint}${RESET}`);
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

      await executePostInstallAction(action, { apiKey, cli, BOLD, RESET, DIM, logger });
    }
  }

  log("");
}

// ─── Post-Install Action Executor ───────────────────────────

async function executePostInstallAction(action, ctx) {
  const { apiKey, cli, BOLD, RESET, DIM, logger } = ctx;

  if (action.type === "open_with_code") {
    cli.log("");
    const open = await cli.promptEnterOrEsc(`  Press ${BOLD}Enter${RESET} to open your dashboard, or ${BOLD}Esc${RESET} to exit: `);
    if (!open) return;

    let targetUrl = action.targetUrl;

    // Fetch one-time code
    if (action.url && action.codePath) {
      try {
        const headers = { "Content-Type": "application/json" };
        if (action.auth && apiKey) headers.Authorization = `Bearer ${apiKey}`;

        const res = await fetch(action.url, {
          method: "POST",
          headers,
          body: "{}",
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json();

        // Navigate codePath (e.g., "data.code")
        const code = action.codePath.split(".").reduce((obj, key) => obj?.[key], data);
        if (code) {
          const separator = targetUrl.includes("?") ? "&" : "?";
          targetUrl = `${targetUrl}${separator}${action.codeParam}=${encodeURIComponent(code)}`;
        }
      } catch (e) {
        if (logger) logger.debug("Post-install code fetch failed, opening plain URL", { error: e.message });
      }
    }

    const cp = require("child_process");
    try {
      if (process.platform === "win32") {
        cp.execSync(`start "" "${targetUrl}"`, { shell: "cmd.exe", stdio: "ignore" });
      } else if (process.platform === "darwin") {
        cp.spawn("open", [targetUrl], { detached: true, stdio: "ignore" }).unref();
      } else {
        cp.spawn("xdg-open", [targetUrl], { detached: true, stdio: "ignore" }).unref();
      }
    } catch {}
  }
}

// ─── Package-Mode Dispatch (existing) ──────────────────────

function isLocalPath(arg) {
  return arg.startsWith("./") || arg.startsWith("../") || arg.startsWith("/")
    || arg.startsWith(".\\") || arg.startsWith("..\\")
    || arg === "."
    || arg.endsWith(".js");
}

function runLocal(localPath, extraArgs) {
  const _path = require("path");
  const _fs = require("fs");
  let scriptPath;
  let toolName = null;

  if (localPath === "." || (_fs.existsSync(localPath) && _fs.statSync(localPath).isDirectory())) {
    const pkgPath = _path.join(localPath, "package.json");
    if (!_fs.existsSync(pkgPath)) {
      console.error(`No package.json found in ${localPath}`);
      process.exit(1);
    }
    const pkg = JSON.parse(_fs.readFileSync(pkgPath, "utf-8"));
    toolName = pkg.name?.replace(/^@[^/]+\//, "") || null;
    const binEntries = pkg.bin;
    if (!binEntries || typeof binEntries !== "object") {
      console.error(`No bin field in ${pkgPath}`);
      process.exit(1);
    }
    const binScript = Object.values(binEntries)[0];
    scriptPath = _path.resolve(localPath, binScript);
  } else {
    scriptPath = _path.resolve(localPath);
    toolName = _path.basename(scriptPath, ".js");
  }

  if (!_fs.existsSync(scriptPath)) {
    console.error(`Script not found: ${scriptPath}`);
    process.exit(1);
  }

  const child = spawn(process.execPath, [scriptPath, ...extraArgs], {
    stdio: "inherit",
    env: { ...process.env, EQUIP_VERSION },
  });
  child.on("close", (code) => {
    if (toolName) {
      try {
        const { reconcileState } = require("../dist/lib/reconcile");
        const changed = reconcileState({
          toolName,
          package: toolName,
          marker: toolName,
        });
        if (changed > 0) {
          process.stderr.write(`\n  equip: tracked ${toolName} on ${changed} platform${changed === 1 ? "" : "s"}\n`);
        }
      } catch (e) {
        process.stderr.write(`\n[equip] state reconciliation failed: ${e.message}\n`);
      }
    }
    process.exit(code || 0);
  });
  child.on("error", (err) => {
    console.error(`Failed to run ${scriptPath}: ${err.message}`);
    process.exit(1);
  });
}

function spawnTool(pkg, command, extraArgs, toolName) {
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npxCmd, ["-y", `${pkg}@latest`, command, ...extraArgs], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, EQUIP_VERSION },
  });
  child.on("close", (code) => {
    if (toolName) {
      try {
        const { reconcileState } = require("../dist/lib/reconcile");
        const toolMeta = TOOLS[toolName] || {};
        const hookDir = toolMeta.hookDir
          ? toolMeta.hookDir.replace(/^~/, require("os").homedir())
          : undefined;
        const changed = reconcileState({
          toolName,
          package: pkg,
          marker: toolMeta.marker || toolName,
          hookDir,
        });
        if (changed > 0) {
          process.stderr.write(`\n  equip: tracked ${toolName} on ${changed} platform${changed === 1 ? "" : "s"}\n`);
        }
      } catch (e) {
        process.stderr.write(`\n[equip] state reconciliation failed: ${e.message}\n`);
      }
    }
    process.exit(code || 0);
  });
  child.on("error", (err) => {
    console.error(`Failed to run ${pkg}: ${err.message}`);
    process.exit(1);
  });
}

// ─── Tool Dispatch ──────────────────────────────────────────

async function dispatchTool(alias, parsedArgs) {
  const extraArgs = parsedArgs._;

  // Local path: run directly with node
  if (isLocalPath(alias)) {
    runLocal(alias, extraArgs);
    return;
  }

  // Try to fetch tool definition from registry API / cache / registry.json
  const { fetchToolDef } = require("../dist/lib/registry");
  const logger = parsedArgs.verbose ? createConsoleLogger() : undefined;
  const toolDef = await fetchToolDef(alias, {
    logger,
    registryPath: path.join(__dirname, "..", "registry.json"),
  });

  if (toolDef && toolDef.installMode === "direct") {
    // Direct-mode: in-process install
    await directInstall(toolDef, parsedArgs);
    return;
  }

  if (toolDef && toolDef.installMode === "package") {
    // Package-mode: spawn npx
    spawnTool(toolDef.npmPackage, toolDef.setupCommand || "setup", extraArgs, alias);
    return;
  }

  // Fallback: check local registry for package-mode entries
  const localEntry = TOOLS[alias];
  if (localEntry) {
    spawnTool(localEntry.package, localEntry.command, extraArgs, alias);
    return;
  }

  // Unknown tool — treat as npm package name
  const pkg = alias;
  const command = extraArgs.length > 0 ? extraArgs.shift() : "setup";
  const inferredName = pkg.includes("/") ? pkg.split("/").pop() : pkg;
  spawnTool(pkg, command, extraArgs, inferredName);
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv.slice(2);
  const cmd = rawArgs[0];

  if (cmd === "--help" || cmd === "-h") {
    cmdHelp();
    process.exit(0);
  }

  if (!cmd) {
    checkStaleVersion();
    cmdStatus();
    const { DIM, RESET } = require("../dist/lib/cli");
    process.stderr.write(`  ${DIM}Run "equip --help" for all commands${RESET}\n\n`);
    process.exit(0);
  }

  if (cmd === "--version" || cmd === "-v") {
    cmdVersion();
    process.exit(0);
  }

  // Stale version check for non-trivial commands
  if (cmd !== "update" && cmd !== "--version" && cmd !== "-v") {
    checkStaleVersion();
  }

  // Parse remaining args (after the command)
  const parsedArgs = parseArgs(rawArgs.slice(1));

  // Auto-refresh expired OAuth tokens (best effort, non-blocking for fast commands)
  if (cmd !== "refresh" && cmd !== "reauth" && cmd !== "list" && cmd !== "demo") {
    await autoRefreshExpired(parsedArgs.verbose);
  }

  switch (cmd) {
    case "status":    cmdStatus(); break;
    case "doctor":    cmdDoctor(); break;
    case "update":    await cmdUpdate(parsedArgs); break;
    case "list":      cmdList(); break;
    case "demo":      cmdDemo(parsedArgs._); break;
    case "uninstall": cmdUninstall(parsedArgs._); break;
    case "reauth":    await cmdReauth(parsedArgs); break;
    case "refresh":   await cmdRefresh(parsedArgs); break;
    default:          await dispatchTool(cmd, parsedArgs); break;
  }
}

main().catch(err => {
  console.error(`equip: ${err.message}`);
  process.exit(1);
});
