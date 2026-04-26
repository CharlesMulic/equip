#!/usr/bin/env node
// unequip — remove augments installed by equip.
// Usage: unequip <augment> [--dry-run]

import * as path from "path";
import * as fs from "fs";
import * as os from "os";

import { PLATFORM_REGISTRY, createManualPlatform, platformName } from "../lib/platforms.js";
import * as cli from "../lib/cli.js";
import { readInstallations, trackUninstallation } from "../lib/installations.js";
import { isPlatformEnabled } from "../lib/platform-state.js";
import { uninstallMcp } from "../lib/mcp.js";
import { uninstallRules } from "../lib/rules.js";
import { uninstallHooks } from "../lib/hooks.js";
import { uninstallSkill } from "../lib/skills.js";
import { acquireLock } from "../lib/fs.js";

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8"));

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
    console.log("No augments tracked. Run 'equip <augment>' to install one first.");
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

// Take the equip-wide lock for the whole uninstall. Without this, a concurrent
// `equip <other>` (or sidecar reconcile) can race against our deletes, and an
// adversarial process could swap files between our ownership check and unlink.
const releaseLock = acquireLock();

let removed = 0;
const removedPlatforms: string[] = [];

try {

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
  const results: string[] = [];

  // Remove MCP config
  if (artifacts.mcp) {
    const mcpRemoved = uninstallMcp(platform, toolName, dryRun);
    if (mcpRemoved) results.push("config");
  }

  // Remove rules
  if (artifacts.rules) {
    const rulesRemoved = uninstallRules(platform, {
      marker: toolName,
      dryRun,
    });
    if (rulesRemoved) results.push("rules");
  }

  // Remove hooks
  if (artifacts.hooks && artifacts.hooks.length > 0) {
    const hookDir = path.join(os.homedir(), `.${toolName}`, "hooks");
    const hooksRemoved = uninstallHooks(platform,
      artifacts.hooks.map((s: string) => ({ event: "", name: s.replace(/\.js$/, ""), script: "", matcher: "" })),
      { hookDir, dryRun }
    );
    if (hooksRemoved) results.push("hooks");
  }

  // Remove skills
  const preservedAcrossSkills: string[] = [];
  let anyTombstone = false;
  if (artifacts.skills && artifacts.skills.length > 0) {
    for (const skillName of artifacts.skills) {
      const r = uninstallSkill(platform, toolName, skillName, dryRun);
      for (const f of r.preservedFiles) preservedAcrossSkills.push(`${skillName}/${f}`);
      if (r.tombstone) anyTombstone = true;
    }
    results.push(`${artifacts.skills.length} skill${artifacts.skills.length === 1 ? "" : "s"}`);
  }

  if (results.length > 0) {
    cli.ok(`${def.name}: removed ${results.join(" + ")}`);
    removed++;
    removedPlatforms.push(platformId);

    if (preservedAcrossSkills.length > 0) {
      cli.log(`  ${cli.DIM}Preserved user-modified files:${cli.RESET}`);
      for (const f of preservedAcrossSkills) {
        cli.log(`    ${cli.DIM}- ${f}${cli.RESET}`);
      }
    }
    if (anyTombstone && !dryRun) {
      cli.log(`  ${cli.DIM}Skill directory kept (tombstone manifest left behind because user content survived).${cli.RESET}`);
    }
  } else {
    cli.info(`${def.name}: nothing to remove`);
  }
}

// Update state
if (!dryRun && removed > 0) {
  trackUninstallation(toolName, removedPlatforms);
}

} finally {
  releaseLock();
}

cli.log("");
if (dryRun) {
  cli.warn("Dry run — nothing was actually removed\n");
} else if (removed > 0) {
  cli.log(`  ${cli.GREEN}${cli.BOLD}${toolName} removed from ${removed} platform${removed === 1 ? "" : "s"}${cli.RESET}\n`);
} else {
  cli.log(`  Nothing to remove.\n`);
}
