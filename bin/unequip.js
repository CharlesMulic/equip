#!/usr/bin/env node
// unequip — remove MCP tools installed by equip.
// Usage: unequip <tool> [--dry-run]

"use strict";

const path = require("path");
const fs = require("fs");

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));

const { PLATFORM_REGISTRY, createManualPlatform, platformName, cli } = require("../dist/index");
const { readState, trackUninstall } = require("../dist/lib/state");
const { uninstallMcp } = require("../dist/lib/mcp");
const { uninstallRules } = require("../dist/lib/rules");
const { uninstallHooks } = require("../dist/lib/hooks");
const { isPlatformEnabled } = require("../dist/lib/platform-state");
const { trackUninstallation } = require("../dist/lib/installations");

const toolName = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!toolName || toolName === "--help" || toolName === "-h") {
  console.log(`unequip v${PKG.version} — remove MCP tools installed by equip`);
  console.log("");
  console.log("Usage: unequip <tool> [--dry-run]");
  console.log("");
  console.log("Removes MCP config, behavioral rules, and hooks for <tool>");
  console.log("from all platforms where it was installed.");
  console.log("");

  const state = readState();
  const tools = Object.keys(state.tools);
  if (tools.length > 0) {
    console.log("Installed tools:");
    for (const name of tools) {
      const tool = state.tools[name];
      const plats = Object.keys(tool.platforms).map(id => platformName(id)).join(", ");
      console.log(`  ${name}  →  ${plats}`);
    }
  } else {
    console.log("No tools tracked. Run 'equip <tool>' to install one first.");
  }
  console.log("");
  process.exit(0);
}

if (toolName === "--version" || toolName === "-v") {
  console.log(`unequip v${PKG.version}`);
  process.exit(0);
}

// ─── Uninstall ──────────────────────────────────────────────

const state = readState();
const tool = state.tools[toolName];

if (!tool) {
  cli.log(`\n${cli.BOLD}unequip ${toolName}${cli.RESET}\n`);
  cli.fail(`"${toolName}" is not tracked by equip.`);
  cli.log("");

  const tools = Object.keys(state.tools);
  if (tools.length > 0) {
    cli.log(`  Tracked tools: ${tools.join(", ")}`);
  } else {
    cli.log(`  No tools are currently tracked.`);
  }
  cli.log("");
  process.exit(1);
}

cli.log(`\n${cli.BOLD}unequip ${toolName}${cli.RESET}`);
if (dryRun) cli.warn("Dry run — no files will be modified");
cli.log("");

let removed = 0;

const removedPlatforms = [];

for (const [platformId, record] of Object.entries(tool.platforms)) {
  // Skip disabled platforms
  if (!isPlatformEnabled(platformId)) {
    cli.info(`${platformName(platformId)}: disabled, skipping`);
    continue;
  }

  const def = PLATFORM_REGISTRY.get(platformId);
  if (!def) {
    cli.warn(`${platformId}: unknown platform, skipping`);
    continue;
  }

  const platform = createManualPlatform(platformId);
  const results = [];

  // Remove MCP config
  const mcpRemoved = uninstallMcp(platform, toolName, dryRun);
  if (mcpRemoved) results.push("config");

  // Remove rules
  if (record.rulesPath) {
    const rulesRemoved = uninstallRules(platform, {
      marker: toolName,
      fileName: (platformId === "cline" || platformId === "roo-code") ? `${toolName}.md` : undefined,
      dryRun,
    });
    if (rulesRemoved) results.push("rules");
  }

  // Remove hooks
  if (record.hookDir && record.hookScripts && record.hookScripts.length > 0) {
    const hooksRemoved = uninstallHooks(platform,
      record.hookScripts.map(s => ({ event: "", name: s.replace(/\.js$/, ""), script: "", matcher: "" })),
      { hookDir: record.hookDir, dryRun }
    );
    if (hooksRemoved) results.push("hooks");
  }

  if (results.length > 0) {
    cli.ok(`${def.name}: removed ${results.join(" + ")}`);
    removed++;
    removedPlatforms.push(platformId);
  } else {
    cli.info(`${def.name}: nothing to remove`);
  }
}

// Update state (both old and new — dual-write bridge)
if (!dryRun && removed > 0) {
  trackUninstall(toolName);  // old state.json
  try { trackUninstallation(toolName, removedPlatforms); } catch {} // new installations.json
}

cli.log("");
if (dryRun) {
  cli.warn("Dry run — nothing was actually removed\n");
} else if (removed > 0) {
  cli.log(`  ${cli.GREEN}${cli.BOLD}${toolName} removed from ${removed} platform${removed === 1 ? "" : "s"}${cli.RESET}\n`);
} else {
  cli.log(`  Nothing to remove.\n`);
}
