#!/usr/bin/env node
// unequip — remove augments installed by equip.
// Usage: unequip <augment> [--dry-run]

import * as path from "path";
import * as fs from "fs";
import * as os from "os";

import { PLATFORM_REGISTRY, createManualPlatform, platformName } from "../lib/platforms.js";
import * as cli from "../lib/cli.js";
import { JsonStore } from "../lib/storage/datastore.js";
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


  const tracked = JsonStore.listResolved().filter((r) => r.installed);
  if (tracked.length > 0) {
    console.log("Installed augments:");
    for (const aug of tracked) {
      const plats = aug.installedPlatforms.map((id) => platformName(id)).join(", ");
      console.log(`  ${aug.name}  →  ${plats}`);
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

const resolved = JsonStore.resolve(toolName);
if (!resolved || !resolved.installed) {
  cli.log(`\n${cli.BOLD}unequip ${toolName}${cli.RESET}\n`);
  cli.fail(`"${toolName}" is not tracked by equip.`);
  cli.log("");

  const trackedNames = JsonStore.listResolved().filter((r) => r.installed).map((r) => r.name);
  if (trackedNames.length > 0) {
    cli.log(`  Tracked augments: ${trackedNames.join(", ")}`);
  } else {
    cli.log(`  No augments are currently tracked.`);
  }
  cli.log("");
  process.exit(1);
}

// Derive what's installed where from the resolved view. In the journal
// model, per-platform artifact details aren't stored separately — the
// content blob describes what each platform got (mcp/rules/skills/hooks),
// and the install intent's platforms list says where.
const hasMcp = !!(resolved.serverUrl || resolved.stdio);
const hasRules = !!resolved.rules;
const skillNames = resolved.skills.map((s) => s.name);
const hookScripts = resolved.hooks.map((h) => h.script);

cli.log(`\n${cli.BOLD}unequip ${toolName}${cli.RESET}`);
if (dryRun) cli.warn("Dry run — no files will be modified");
cli.log("");

// Take the equip-wide lock for the whole uninstall. Without this, any
// concurrent equip writer can race against our deletes, and an adversarial
// process could swap files between our ownership check and unlink.
const releaseLock = acquireLock();

let removed = 0;
const removedPlatforms: string[] = [];

try {

for (const platformId of resolved.installedPlatforms) {
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
  const results: string[] = [];

  // Remove MCP config
  if (hasMcp) {
    const mcpRemoved = uninstallMcp(platform, toolName, dryRun);
    if (mcpRemoved) results.push("config");
  }

  // Remove rules
  if (hasRules) {
    const rulesRemoved = uninstallRules(platform, {
      marker: toolName,
      dryRun,
    });
    if (rulesRemoved) results.push("rules");
  }

  // Remove hooks
  if (hookScripts.length > 0) {
    const hookDir = path.join(os.homedir(), `.${toolName}`, "hooks");
    const hooksRemoved = uninstallHooks(platform,
      hookScripts.map((s) => ({ event: "", name: s.replace(/\.js$/, ""), script: s, matcher: "" })),
      { hookDir, dryRun }
    );
    if (hooksRemoved) results.push("hooks");
  }

  // Remove skills
  const preservedAcrossSkills: string[] = [];
  let anyTombstone = false;
  if (skillNames.length > 0) {
    for (const skillName of skillNames) {
      const r = uninstallSkill(platform, toolName, skillName, dryRun);
      for (const f of r.preservedFiles) preservedAcrossSkills.push(`${skillName}/${f}`);
      if (r.tombstone) anyTombstone = true;
    }
    results.push(`${skillNames.length} skill${skillNames.length === 1 ? "" : "s"}`);
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

// Update journal: append uninstall intent for the platforms we removed from.
if (!dryRun && removed > 0) {
  JsonStore.appendIntent({
    type: "uninstall-augment",
    clock: JsonStore.newClock(),
    name: toolName,
    platforms: removedPlatforms,
  });
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
