#!/usr/bin/env node
// @cg3/equip CLI — augment your AI agents.
// Usage: equip <command> [args...]
//
// This is a thin dispatcher. Command logic lives in src/lib/commands/ (TypeScript).

"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
const EQUIP_VERSION = PKG.version;

// ─── Arg Parsing ───────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [], verbose: false, dryRun: false, apiKey: null, nonInteractive: false, platform: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verbose") { args.verbose = true; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--non-interactive") { args.nonInteractive = true; }
    else if (a === "--api-key" && i + 1 < argv.length) { args.apiKey = argv[++i]; }
    else if (a === "--api-key-file" && i + 1 < argv.length) {
      try { args.apiKey = fs.readFileSync(argv[++i], "utf-8").trim(); }
      catch (e) { process.stderr.write(`Error reading API key file: ${e.message}\n`); process.exit(1); }
    }
    else if (a === "--platform" && i + 1 < argv.length) { args.platform = argv[++i]; }
    else { args._.push(a); }
  }
  return args;
}

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

// ─── Simple Commands ────────────────────────────────────────

function cmdVersion() {
  console.log(`equip v${EQUIP_VERSION}`);
}

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
  console.log("  snapshot [plat]  Capture current platform config state");
  console.log("  snapshots [plat] List available config snapshots");
  console.log("  restore <plat>   Restore platform config from a snapshot");
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
  console.log("Telemetry:");
  console.log("  Anonymous install telemetry is enabled by default.");
  console.log("  Disable: edit ~/.equip/equip.json and set telemetry: false");
  console.log("");
}

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

// ─── Delegated Commands (logic in TypeScript modules) ───────

function cmdStatus() {
  const { runStatus } = require("../dist/lib/commands/status");
  runStatus();
}

function cmdDoctor() {
  const { runDoctor } = require("../dist/lib/commands/doctor");
  runDoctor();
}

function cmdUninstall(args) {
  process.argv = [process.argv[0], process.argv[1], ...args];
  require("./unequip.js");
}

async function cmdUpdate(parsedArgs) {
  const toolName = parsedArgs._[0];

  if (toolName) {
    const { fetchRegistryDef, validateCredential, readStoredCredential, cli } = require("../dist/index");
    const { createConsoleLogger } = require("../dist/lib/cli");
    const { log, ok, fail, warn, DIM, RESET, BOLD } = cli;
    const logger = parsedArgs.verbose ? createConsoleLogger() : undefined;

    log(`\n${BOLD}equip update${RESET} ${toolName}\n`);

    // Clear cache to get fresh definition
    try { fs.unlinkSync(path.join(os.homedir(), ".equip", "cache", `${toolName}.json`)); } catch {}

    const toolDef = await fetchRegistryDef(toolName, { logger });
    if (!toolDef) {
      fail(`Augment "${toolName}" not found in registry`);
      process.exit(1);
    }

    if (toolDef.installMode !== "direct") {
      log(`  ${DIM}${toolName} is package-mode — use: npx @cg3/${toolName} setup --update${RESET}\n`);
      return;
    }

    // Validate stored credential
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

    // Re-run install (idempotent)
    const { runInstall } = require("../dist/lib/commands/install");
    await runInstall(toolDef, parsedArgs, EQUIP_VERSION);
    return;
  }

  // No augment name: legacy equip self-update
  const { runUpdate } = require("../dist/lib/commands/update");
  runUpdate();
}

async function cmdReauth(parsedArgs) {
  const { runReauth } = require("../dist/lib/commands/reauth");
  await runReauth(parsedArgs);
}

async function cmdRefresh(parsedArgs) {
  const { runRefresh } = require("../dist/lib/commands/refresh");
  await runRefresh(parsedArgs);
}

function cmdSnapshot(parsedArgs) {
  const { runSnapshot } = require("../dist/lib/commands/snapshot");
  runSnapshot(parsedArgs);
}

function cmdSnapshots(parsedArgs) {
  const { runSnapshots } = require("../dist/lib/commands/snapshot");
  runSnapshots(parsedArgs);
}

async function cmdRestore(parsedArgs) {
  const { runRestore } = require("../dist/lib/commands/snapshot");
  await runRestore(parsedArgs);
}

// ─── Package-Mode Dispatch ──────────────────────────────────

function isLocalPath(arg) {
  return arg.startsWith("./") || arg.startsWith("../") || arg.startsWith("/")
    || arg.startsWith(".\\") || arg.startsWith("..\\")
    || arg === "."
    || arg.endsWith(".js");
}

function runLocal(localPath, extraArgs) {
  let scriptPath;
  let toolName = null;

  if (localPath === "." || (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory())) {
    const pkgPath = path.join(localPath, "package.json");
    if (!fs.existsSync(pkgPath)) {
      console.error(`No package.json found in ${localPath}`);
      process.exit(1);
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    toolName = pkg.name?.replace(/^@[^/]+\//, "") || null;
    const binEntries = pkg.bin;
    if (!binEntries || typeof binEntries !== "object") {
      console.error(`No bin field in ${pkgPath}`);
      process.exit(1);
    }
    const binScript = Object.values(binEntries)[0];
    scriptPath = path.resolve(localPath, binScript);
  } else {
    scriptPath = path.resolve(localPath);
    toolName = path.basename(scriptPath, ".js");
  }

  if (!fs.existsSync(scriptPath)) {
    console.error(`Script not found: ${scriptPath}`);
    process.exit(1);
  }

  // Capture initial snapshots before the child process modifies configs
  try {
    const { detectPlatforms } = require("../dist/lib/detect");
    const { ensureInitialSnapshots } = require("../dist/lib/snapshots");
    ensureInitialSnapshots(detectPlatforms());
  } catch {}

  const child = spawn(process.execPath, [scriptPath, ...extraArgs], {
    stdio: "inherit",
    env: { ...process.env, EQUIP_VERSION },
  });
  child.on("close", (code) => {
    if (toolName) {
      try {
        const { reconcileState } = require("../dist/lib/reconcile");
        const changed = reconcileState({ toolName, package: toolName, marker: toolName });
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

function spawnPackage(pkg, command, extraArgs, augmentName) {
  // Capture initial snapshots before the package modifies configs
  try {
    const { detectPlatforms } = require("../dist/lib/detect");
    const { ensureInitialSnapshots } = require("../dist/lib/snapshots");
    ensureInitialSnapshots(detectPlatforms());
  } catch {}

  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npxCmd, ["-y", `${pkg}@latest`, command, ...extraArgs], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, EQUIP_VERSION },
  });
  child.on("close", (code) => {
    if (augmentName) {
      try {
        const { reconcileState } = require("../dist/lib/reconcile");
        const changed = reconcileState({ toolName: augmentName, package: pkg, marker: augmentName });
        if (changed > 0) {
          process.stderr.write(`\n  equip: tracked ${augmentName} on ${changed} platform${changed === 1 ? "" : "s"}\n`);
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

// ─── Augment Dispatch ───────────────────────────────────────

async function dispatchAugment(alias, parsedArgs) {
  const extraArgs = parsedArgs._;

  // Local path: run directly with node
  if (isLocalPath(alias)) {
    runLocal(alias, extraArgs);
    return;
  }

  // Fetch augment definition from registry API (with cache fallback)
  const { fetchRegistryDef } = require("../dist/lib/registry");
  const { createConsoleLogger } = require("../dist/lib/cli");
  const logger = parsedArgs.verbose ? createConsoleLogger() : undefined;
  const toolDef = await fetchRegistryDef(alias, { logger });

  if (toolDef && toolDef.installMode === "direct") {
    const { runInstall } = require("../dist/lib/commands/install");
    await runInstall(toolDef, parsedArgs, EQUIP_VERSION);
    return;
  }

  if (toolDef && toolDef.installMode === "package") {
    spawnPackage(toolDef.npmPackage, toolDef.setupCommand || "setup", extraArgs, alias);
    return;
  }

  // Unknown augment — treat as npm package name
  if (!toolDef) {
    const pkg = alias;
    const command = extraArgs.length > 0 ? extraArgs.shift() : "setup";
    const inferredName = pkg.includes("/") ? pkg.split("/").pop() : pkg;
    spawnPackage(pkg, command, extraArgs, inferredName);
    return;
  }

  console.error(`equip: unknown install mode "${toolDef.installMode}" for "${alias}"`);
  process.exit(1);
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

  // Auto-refresh expired OAuth tokens (best effort)
  if (cmd !== "refresh" && cmd !== "reauth" && cmd !== "demo") {
    const { autoRefreshExpired } = require("../dist/lib/commands/refresh");
    await autoRefreshExpired(parsedArgs.verbose);
  }

  switch (cmd) {
    case "status":    cmdStatus(); break;
    case "doctor":    cmdDoctor(); break;
    case "update":    await cmdUpdate(parsedArgs); break;
    case "demo":      cmdDemo(parsedArgs._); break;
    case "snapshot":  cmdSnapshot(parsedArgs); break;
    case "snapshots": cmdSnapshots(parsedArgs); break;
    case "restore":   await cmdRestore(parsedArgs); break;
    case "uninstall": cmdUninstall(parsedArgs._); break;
    case "reauth":    await cmdReauth(parsedArgs); break;
    case "refresh":   await cmdRefresh(parsedArgs); break;
    default:          await dispatchAugment(cmd, parsedArgs); break;
  }
}

main().catch(err => {
  console.error(`equip: ${err.message}`);
  process.exit(1);
});
