#!/usr/bin/env node
// unequip — remove augments installed by equip.
// Usage: unequip <augment> [--dry-run]

"use strict";

const path = require("path");
const fs = require("fs");

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));

const { PLATFORM_REGISTRY, createManualPlatform, platformName, cli } = require("../dist/index");
const { readInstallations, trackUninstallation } = require("../dist/lib/installations");
const { isPlatformEnabled } = require("../dist/lib/platform-state");
const { uninstallMcp } = require("../dist/lib/mcp");
const { uninstallRules } = require("../dist/lib/rules");
const { uninstallHooks } = require("../dist/lib/hooks");
const { uninstallSkill } = require("../dist/lib/skills");
const { deleteAugmentDef } = require("../dist/lib/augment-defs");

const toolName = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!toolName || toolName === "--help" || toolName === "-h") {
  console.log(`unequip v${PKG.version} — remove augments installed by equip`);
  console.log("");
  console.log("Usage: unequip <augment> [--dry-run]");
  console.log("");
  console.log("Removes MCP config, behavioral rules, hooks, and skills for <augment>");
  console.log("from all enabled platforms where it was installed.");
  console.log("");

  const installations = readInstallations();
  const augmentNames = Object.keys(installations.augments);
  if (augmentNames.length > 0) {
    console.log("Installed augments:");
    for (const name of augmentNames) {
      const record = installations.augments[name];
      const plats = record.platforms.map(id => platformName(id)).join(", ");
      console.log(`  ${name}  →  ${plats}`);
    }
  } else {
    console.log("No augments tracked. Run 'equip <tool>' to install one first.");
  }
  console.log("");
  process.exit(0);
}

if (toolName === "--version" || toolName === "-v") {
  console.log(`unequip v${PKG.version}`);
  process.exit(0);
}

// ─── Uninstall ──────────────────────────────────────────────

const installations = readInstallations();
const record = installations.augments[toolName];

if (!record) {
  cli.log(`\n${cli.BOLD}unequip ${toolName}${cli.RESET}\n`);
  cli.fail(`"${toolName}" is not tracked by equip.`);
  cli.log("");

  const augmentNames = Object.keys(installations.augments);
  if (augmentNames.length > 0) {
    cli.log(`  Tracked augments: ${augmentNames.join(", ")}`);
  } else {
    cli.log(`  No augments are currently tracked.`);
  }
  cli.log("");
  process.exit(1);
}

cli.log(`\n${cli.BOLD}unequip ${toolName}${cli.RESET}`);
if (dryRun) cli.warn("Dry run — no files will be modified");
cli.log("");

let removed = 0;
const removedPlatforms = [];

for (const platformId of record.platforms) {
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
  const artifacts = record.artifacts[platformId] || {};
  const results = [];

  // Remove MCP config
  if (artifacts.mcp) {
    const mcpRemoved = uninstallMcp(platform, toolName, dryRun);
    if (mcpRemoved) results.push("config");
  }

  // Remove rules
  if (artifacts.rules) {
    const rulesRemoved = uninstallRules(platform, {
      marker: toolName,
      fileName: (platformId === "cline" || platformId === "roo-code") ? `${toolName}.md` : undefined,
      dryRun,
    });
    if (rulesRemoved) results.push("rules");
  }

  // Remove hooks
  if (artifacts.hooks && artifacts.hooks.length > 0) {
    const hookDir = path.join(require("os").homedir(), `.${toolName}`, "hooks");
    const hooksRemoved = uninstallHooks(platform,
      artifacts.hooks.map(s => ({ event: "", name: s.replace(/\.js$/, ""), script: "", matcher: "" })),
      { hookDir, dryRun }
    );
    if (hooksRemoved) results.push("hooks");
  }

  // Remove skills
  if (artifacts.skills && artifacts.skills.length > 0) {
    for (const skillName of artifacts.skills) {
      uninstallSkill(platform, toolName, skillName, dryRun);
    }
    results.push(`${artifacts.skills.length} skill${artifacts.skills.length === 1 ? "" : "s"}`);
  }

  if (results.length > 0) {
    cli.ok(`${def.name}: removed ${results.join(" + ")}`);
    removed++;
    removedPlatforms.push(platformId);
  } else {
    cli.info(`${def.name}: nothing to remove`);
  }
}

// Update state
if (!dryRun && removed > 0) {
  trackUninstallation(toolName, removedPlatforms);
}

cli.log("");
if (dryRun) {
  cli.warn("Dry run — nothing was actually removed\n");
} else if (removed > 0) {
  cli.log(`  ${cli.GREEN}${cli.BOLD}${toolName} removed from ${removed} platform${removed === 1 ? "" : "s"}${cli.RESET}\n`);
} else {
  cli.log(`  Nothing to remove.\n`);
}
