#!/usr/bin/env node
// @cg3/equip CLI — universal MCP tool installer and configuration manager.
// Usage: equip <command> [args...]

"use strict";

const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

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

// ─── Built-in Commands ──────────────────────────────────────

const BUILTIN_COMMANDS = new Set(["status", "doctor", "update", "list", "demo", "--help", "-h", "--version", "-v"]);

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
  console.log("  <tool>           Install an MCP tool (e.g. equip prior)");
  console.log("  uninstall <tool> Remove an installed tool (alias: unequip)");
  console.log("  status           Show all MCP servers across all platforms");
  console.log("  doctor           Validate config integrity and detect drift");
  console.log("  update           Update equip and migrate configs");
  console.log("  list             Show registered tools");
  console.log("  demo             Run the built-in demo");
  console.log("");
  console.log("Registered tools:");
  for (const [name, info] of Object.entries(TOOLS)) {
    const desc = info.description ? ` — ${info.description}` : "";
    console.log(`  ${name}${desc}`);
  }
  console.log("");
  console.log("Options:");
  console.log("  --help, -h       Show this help");
  console.log("  --version, -v    Show version");
  console.log("");
  console.log("Tool options are forwarded (e.g. equip prior --dry-run --platform codex)");
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
  console.log(`  ${DIM}Add yours: PR to registry.json at github.com/CharlesMulic/equip${RESET}\n`);
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
  // Reuse unequip.js by injecting the tool name into argv and requiring it
  process.argv = [process.argv[0], process.argv[1], ...args];
  require("./unequip.js");
}

function cmdUpdate() {
  const { runUpdate } = require("../dist/lib/commands/update");
  runUpdate();
}

// ─── Tool Dispatch ──────────────────────────────────────────

function dispatchTool(alias, extraArgs) {
  const entry = TOOLS[alias];

  if (!entry) {
    // No registry match — treat as a package name (e.g. "equip @scope/pkg setup")
    const pkg = alias;
    const command = extraArgs.shift();
    if (!command) {
      console.error(`Unknown command: ${alias}`);
      console.error(`Run "equip --help" for usage.`);
      process.exit(1);
    }
    spawnTool(pkg, command, extraArgs, null);
    return;
  }

  // For registered tools, the alias IS the tool name (e.g. "prior")
  spawnTool(entry.package, entry.command, extraArgs, alias);
}

function spawnTool(pkg, command, extraArgs, toolName) {
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npxCmd, ["-y", `${pkg}@latest`, command, ...extraArgs], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, EQUIP_VERSION },
  });
  child.on("close", (code) => {
    // Always reconcile state — install may have succeeded even if
    // the tool exited non-zero (e.g. user cancelled a post-install prompt)
    if (toolName) {
      try {
        const changed = reconcileState(toolName, pkg);
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

/**
 * After a tool finishes, scan platform configs and update state
 * based on what's actually on disk. This ensures state is always
 * accurate regardless of which equip version the tool used internally.
 */
function reconcileState(toolName, pkg) {
  const { PLATFORM_REGISTRY } = require("../dist/lib/platforms");
  const { readMcpEntry } = require("../dist/lib/mcp");
  const { trackInstall } = require("../dist/lib/state");
  const { dirExists, fileExists } = require("../dist/lib/detect");
  const _fs = require("fs");
  const _path = require("path");

  let count = 0;

  for (const [id, def] of PLATFORM_REGISTRY) {
    // Quick check: is this platform present?
    const dirFound = def.detection.dirs.some(fn => dirExists(fn()));
    const fileFound = def.detection.files.some(fn => fileExists(fn()));
    const configPath = def.configPath();
    if (!dirFound && !fileFound && !fileExists(configPath)) continue;

    // Check if tool has an MCP entry on this platform
    const entry = readMcpEntry(configPath, def.rootKey, toolName, def.configFormat);
    if (!entry) continue;

    // Build state record from what's on disk
    const record = {
      configPath,
      transport: entry.command ? "stdio" : "http",
    };

    // Check for rules (only on platforms that support writable rules)
    if (def.rulesPath) {
      const rulesPath = def.rulesPath();
      try {
        const content = _fs.readFileSync(rulesPath, "utf-8");
        const versionMatch = content.match(new RegExp(`<!-- ${toolName}:v([0-9.]+) -->`));
        if (versionMatch) {
          record.rulesPath = rulesPath;
          record.rulesVersion = versionMatch[1];
        }
      } catch {}
    }

    // Check for hooks (only on platforms that support hooks)
    if (def.hooks) {
      const hookDir = _path.join(require("os").homedir(), `.${toolName}`, "hooks");
      try {
        const hookFiles = _fs.readdirSync(hookDir).filter(f => f.endsWith(".js"));
        if (hookFiles.length > 0) {
          record.hookDir = hookDir;
          record.hookScripts = hookFiles;
        }
      } catch {}
    }

    trackInstall(toolName, pkg, id, record);
    count++;
  }

  return count;
}

// ─── Main ───────────────────────────────────────────────────

const cmd = process.argv[2];
const extraArgs = process.argv.slice(3);

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

switch (cmd) {
  case "status":    cmdStatus(); break;
  case "doctor":    cmdDoctor(); break;
  case "update":    cmdUpdate(); break;
  case "list":      cmdList(); break;
  case "demo":      cmdDemo(extraArgs); break;
  case "uninstall": cmdUninstall(extraArgs); break;
  default:          dispatchTool(cmd, extraArgs); break;
}
