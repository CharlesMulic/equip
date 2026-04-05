#!/usr/bin/env node
// @cg3/equip CLI — augment your AI agents.
// Usage: equip <command> [args...]
//
// This is a thin dispatcher. Command logic lives in src/lib/commands/ (TypeScript).

import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

import { ParsedArgs, parseArgs, isLocalPath, YELLOW, DIM, RESET, BOLD, GREEN, createConsoleLogger } from "../lib/cli.js";
import * as cli from "../lib/cli.js";
import { readEquipMeta } from "../lib/equip-meta.js";
import { fetchRegistryDef, RegistryDef } from "../lib/registry.js";
import { validateCredential, readStoredCredential } from "../lib/auth-engine.js";
import { runStatus } from "../lib/commands/status.js";
import { runDoctor } from "../lib/commands/doctor.js";
import { runUpdate } from "../lib/commands/update.js";
import { runInstall } from "../lib/commands/install.js";
import { runReauth } from "../lib/commands/reauth.js";
import { runRefresh, autoRefreshExpired } from "../lib/commands/refresh.js";
import { runSnapshot, runSnapshots, runRestore } from "../lib/commands/snapshot.js";
import { detectPlatforms } from "../lib/detect.js";
import { ensureInitialSnapshots } from "../lib/snapshots.js";
import { reconcileState } from "../lib/reconcile.js";

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8"));
const EQUIP_VERSION: string = PKG.version;

// parseArgs and isLocalPath imported from ../lib/cli.js

// ─── Stale Version Nudge ────────────────────────────────────

function checkStaleVersion(): void {
  try {
    const meta = readEquipMeta();
    const lastUpdated = meta.lastUpdated;
    if (lastUpdated) {
      const daysSince = (Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 14) {
        process.stderr.write(`  ${YELLOW}equip v${EQUIP_VERSION} is ${Math.floor(daysSince)} days old${RESET} ${DIM}— run "equip update" for platform fixes${RESET}\n\n`);
      }
    }
  } catch {}
}

// ─── Simple Commands ────────────────────────────────────────

function cmdVersion(): void {
  console.log(`equip v${EQUIP_VERSION}`);
}

function cmdHelp(): void {
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

function cmdDemo(extraArgs: string[]): void {
  const demoPath = path.join(__dirname, "..", "..", "demo", "setup.js");
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

function cmdUninstall(args: string[]): void {
  // Re-invoke unequip with the correct argv shape
  process.argv = [process.argv[0], process.argv[1], ...args];
  require("./unequip.js");
}

async function cmdUpdate(parsedArgs: ParsedArgs): Promise<void> {
  const toolName = parsedArgs._[0];

  if (toolName) {
    const logger = parsedArgs.verbose ? createConsoleLogger() : undefined;

    cli.log(`\n${BOLD}equip update${RESET} ${toolName}\n`);

    // Clear cache to get fresh definition
    try { fs.unlinkSync(path.join(os.homedir(), ".equip", "cache", `${toolName}.json`)); } catch {}

    const toolDef = await fetchRegistryDef(toolName, { logger });
    if (!toolDef) {
      cli.fail(`Augment "${toolName}" not found in registry`);
      process.exit(1);
    }

    if (toolDef.installMode !== "direct") {
      cli.log(`  ${DIM}${toolName} is package-mode — use: npx @cg3/${toolName} setup --update${RESET}\n`);
      return;
    }

    // Validate stored credential
    const authConfig = toolDef.auth || { type: "none" as const };
    const cred = readStoredCredential(toolName);
    if (cred?.credential && authConfig.validationUrl) {
      const v = await validateCredential(cred.credential, authConfig, logger);
      if (v.valid === false) {
        cli.warn("Stored credential is invalid — re-authenticating...");
      } else if (v.valid === true) {
        cli.ok("Credential valid");
      }
    }

    // Re-run install (idempotent)
    await runInstall(toolDef, parsedArgs, EQUIP_VERSION);
    return;
  }

  // No augment name: legacy equip self-update
  runUpdate();
}

// ─── Package-Mode Dispatch ──────────────────────────────────

function runLocal(localPath: string, extraArgs: string[]): void {
  let scriptPath: string;
  let toolName: string | null = null;

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
    const binScript = Object.values(binEntries)[0] as string;
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
    ensureInitialSnapshots(detectPlatforms());
  } catch {}

  const child = spawn(process.execPath, [scriptPath, ...extraArgs], {
    stdio: "inherit",
    env: { ...process.env, EQUIP_VERSION },
  });
  child.on("close", (code) => {
    if (toolName) {
      try {
        const changed = reconcileState({ toolName, package: toolName, marker: toolName });
        if (changed > 0) {
          process.stderr.write(`\n  equip: tracked ${toolName} on ${changed} platform${changed === 1 ? "" : "s"}\n`);
        }
      } catch (e) {
        process.stderr.write(`\n[equip] state reconciliation failed: ${(e as Error).message}\n`);
      }
    }
    process.exit(code || 0);
  });
  child.on("error", (err) => {
    console.error(`Failed to run ${scriptPath}: ${err.message}`);
    process.exit(1);
  });
}

function spawnPackage(pkg: string, command: string, extraArgs: string[], augmentName: string): void {
  // Capture initial snapshots before the package modifies configs
  try {
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
        const changed = reconcileState({ toolName: augmentName, package: pkg, marker: augmentName });
        if (changed > 0) {
          process.stderr.write(`\n  equip: tracked ${augmentName} on ${changed} platform${changed === 1 ? "" : "s"}\n`);
        }
      } catch (e) {
        process.stderr.write(`\n[equip] state reconciliation failed: ${(e as Error).message}\n`);
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

async function dispatchAugment(alias: string, parsedArgs: ParsedArgs): Promise<void> {
  const extraArgs = parsedArgs._;

  // Local path: run directly with node
  if (isLocalPath(alias)) {
    runLocal(alias, extraArgs);
    return;
  }

  // Fetch augment definition from registry API (with cache fallback)
  const logger = parsedArgs.verbose ? createConsoleLogger() : undefined;
  const toolDef = await fetchRegistryDef(alias, { logger });

  if (toolDef && toolDef.installMode === "direct") {
    await runInstall(toolDef, parsedArgs, EQUIP_VERSION);
    return;
  }

  if (toolDef && toolDef.installMode === "package") {
    spawnPackage(toolDef.npmPackage!, toolDef.setupCommand || "setup", extraArgs, alias);
    return;
  }

  // Unknown augment — treat as npm package name
  if (!toolDef) {
    const pkg = alias;
    const command = extraArgs.length > 0 ? extraArgs.shift()! : "setup";
    const inferredName = pkg.includes("/") ? pkg.split("/").pop()! : pkg;
    spawnPackage(pkg, command, extraArgs, inferredName);
    return;
  }

  console.error(`equip: unknown install mode "${toolDef.installMode}" for "${alias}"`);
  process.exit(1);
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const cmd = rawArgs[0];

  if (cmd === "--help" || cmd === "-h") {
    cmdHelp();
    process.exit(0);
  }

  if (!cmd) {
    checkStaleVersion();
    runStatus();
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
    await autoRefreshExpired(parsedArgs.verbose);
  }

  switch (cmd) {
    case "status":    runStatus(); break;
    case "doctor":    runDoctor(); break;
    case "update":    await cmdUpdate(parsedArgs); break;
    case "demo":      cmdDemo(parsedArgs._); break;
    case "snapshot":  runSnapshot(parsedArgs); break;
    case "snapshots": runSnapshots(parsedArgs); break;
    case "restore":   await runRestore(parsedArgs); break;
    case "uninstall": cmdUninstall(parsedArgs._); break;
    case "reauth":    await runReauth(parsedArgs); break;
    case "refresh":   await runRefresh(parsedArgs); break;
    default:          await dispatchAugment(cmd, parsedArgs); break;
  }
}

main().catch(err => {
  console.error(`equip: ${(err as Error).message}`);
  process.exit(1);
});
