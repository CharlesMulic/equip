#!/usr/bin/env node
// @cg3/equip CLI — universal MCP tool installer and configuration manager.
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
  const args = { _: [], verbose: false, dryRun: false, apiKey: null, nonInteractive: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verbose") { args.verbose = true; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--non-interactive") { args.nonInteractive = true; }
    else if (a === "--api-key" && i + 1 < argv.length) { args.apiKey = argv[++i]; }
    else { args._.push(a); }
  }
  return args;
}

// ─── Built-in Commands ──────────────────────────────────────

const BUILTIN_COMMANDS = new Set(["status", "doctor", "update", "reauth", "list", "demo", "--help", "-h", "--version", "-v"]);

function isBuiltin(cmd) {
  return BUILTIN_COMMANDS.has(cmd);
}

// ─── Stale Version Nudge ────────────────────────────────────

function checkStaleVersion() {
  try {
    const { readState } = require("../dist/lib/state");
    const state = readState();
    if (state.lastUpdated) {
      const daysSince = (Date.now() - new Date(state.lastUpdated).getTime()) / (1000 * 60 * 60 * 24);
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
  console.log(`equip v${EQUIP_VERSION} — universal MCP tool installer`);
  console.log("");
  console.log("Usage: equip <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  <tool>           Install a tool from the registry");
  console.log("  ./script.js      Run a local setup script (for development)");
  console.log("  .                Run current directory's package bin entry");
  console.log("  uninstall <tool> Remove an installed tool (alias: unequip)");
  console.log("  reauth <tool>    Re-authenticate and update credentials");
  console.log("  status           Show all MCP servers across all platforms");
  console.log("  doctor           Validate config integrity and detect drift");
  console.log("  update           Update equip and migrate configs");
  console.log("  list             Show registered tools");
  console.log("  demo             Run the built-in demo");
  console.log("");
  console.log("Options:");
  console.log("  --verbose        Show detailed logging");
  console.log("  --api-key <key>  Provide API key (skip prompt)");
  console.log("  --dry-run        Preview without writing");
  console.log("  --help, -h       Show this help");
  console.log("  --version, -v    Show version");
  console.log("");
}

// ─── Command: list ──────────────────────────────────────────

function cmdList() {
  const { GREEN, DIM, RESET, BOLD } = require("../dist/lib/cli");
  console.log(`\n${BOLD}Registered tools${RESET}\n`);
  for (const [name, info] of Object.entries(TOOLS)) {
    const desc = info.description ? `  ${DIM}${info.description}${RESET}` : "";
    console.log(`  ${GREEN}${name}${RESET}  →  ${info.package} ${info.command}${desc}`);
  }
  console.log(`\n  ${DIM}Install: equip <tool>${RESET}`);
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

function cmdUpdate() {
  const { runUpdate } = require("../dist/lib/commands/update");
  runUpdate();
}

async function cmdReauth(args) {
  const toolName = args._[0];
  if (!toolName) {
    console.error("Usage: equip reauth <tool>");
    process.exit(1);
  }

  const { fetchToolDef, resolveAuth, deleteStoredCredential, Equip, toolDefToEquipConfig, platformName, cli } = require("../dist/index");
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
    const equip = new Equip(config);
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
  const { Equip, toolDefToEquipConfig, platformName, InstallReportBuilder, resolveAuth, cli } = require("../dist/index");
  const { reconcileState } = require("../dist/lib/reconcile");
  const { log, ok, fail, warn, step, DIM, RESET, BOLD, GREEN } = cli;

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
    ok(`Authenticated ${DIM}(${authResult.method})${RESET}`);
  }

  // ── Platform Detection ──
  const config = toolDefToEquipConfig(toolDef, { logger });
  const equip = new Equip(config);
  const platforms = equip.detect();

  if (platforms.length === 0) {
    fail("No supported AI coding tools detected.");
    log(`\n  Install one of: Claude Code, Cursor, Windsurf, VS Code, Cline, Roo Code`);
    process.exit(1);
  }

  const names = platforms.map(p => platformName(p.platform)).join(", ");
  log(`\n  Detected   ${names}`);

  // ── Install Loop ──
  const report = new InstallReportBuilder();
  const totalSteps = (config.rules ? 3 : 2) + (config.skill ? 1 : 0);
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

  // Rules
  if (config.rules) {
    step(++stepNum, totalSteps, "Behavioral Rules");
    for (const p of platforms) {
      const result = equip.installRules(p, { dryRun });
      report.addResult(p.platform, result);
      if (result.action === "clipboard") {
        ok(`${platformName(p.platform)}   Rules copied to clipboard`);
        if (result.warnings.length > 0) {
          warn(`${platformName(p.platform)}   ${result.warnings[0].message}`);
        }
      } else if (result.action === "created" || result.action === "updated") {
        ok(`${platformName(p.platform)}   Rules v${config.rules.version} ${result.action}`);
      } else if (result.action === "skipped" && result.attempted) {
        ok(`${platformName(p.platform)}   Rules already current`);
      }
    }
  }

  // Skills
  if (config.skill) {
    step(++stepNum, totalSteps, "Skills");
    for (const p of platforms) {
      const result = equip.installSkill(p, { dryRun });
      report.addResult(p.platform, result);
      if (result.action === "created") {
        ok(`${platformName(p.platform)}   Skill "${config.skill.name}" installed`);
      } else if (result.action === "skipped" && result.attempted) {
        ok(`${platformName(p.platform)}   Skill already current`);
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
      });
      if (changed > 0 && logger) {
        logger.debug("State reconciled", { platforms: changed });
      }
    } catch (e) {
      if (logger) logger.warn("State reconciliation failed", { error: e.message });
    }
  }

  // ── Telemetry (fire and forget) ──
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
  log("");
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

  switch (cmd) {
    case "status":    cmdStatus(); break;
    case "doctor":    cmdDoctor(); break;
    case "update":    cmdUpdate(); break;
    case "list":      cmdList(); break;
    case "demo":      cmdDemo(parsedArgs._); break;
    case "uninstall": cmdUninstall(parsedArgs._); break;
    case "reauth":    await cmdReauth(parsedArgs); break;
    default:          await dispatchTool(cmd, parsedArgs); break;
  }
}

main().catch(err => {
  console.error(`equip: ${err.message}`);
  process.exit(1);
});
