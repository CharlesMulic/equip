// equip update — self-update equip and migrate configs if needed.

import { execSync } from "child_process";
import { resolvePackageVersion } from "../fs";
import { migrateConfigs } from "../migrate";
import { readInstallations } from "../installations";
import { markEquipUpdated } from "../equip-meta";
import * as cli from "../cli";

export function runUpdate(): void {
  cli.log(`\n${cli.BOLD}equip update${cli.RESET}\n`);

  const oldVersion = getInstalledVersion();
  cli.log(`  Current version: ${cli.CYAN}v${oldVersion}${cli.RESET}`);

  // Step 1: Self-update via npm
  cli.log(`\n${cli.BOLD}[1/2] Updating equip${cli.RESET}`);
  try {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    execSync(`${npmCmd} update -g @cg3/equip`, {
      encoding: "utf-8",
      timeout: 60000,
      stdio: "pipe",
    });
    const newVersion = getGlobalVersion();
    if (newVersion && newVersion !== oldVersion) {
      cli.ok(`Updated to v${newVersion}`);
    } else {
      cli.ok(`Already at latest (v${oldVersion})`);
    }
  } catch (err: unknown) {
    cli.warn(`npm update failed — you may need to run: npm install -g @cg3/equip`);
    cli.log(`  ${cli.DIM}${(err as Error).message?.split("\n")[0] || "unknown error"}${cli.RESET}`);
  }

  // Step 2: Migrate configs
  cli.log(`\n${cli.BOLD}[2/2] Migrating configs${cli.RESET}`);
  const installations = readInstallations();
  const augmentCount = Object.keys(installations.augments).length;

  if (augmentCount === 0) {
    cli.ok("No tracked augments — nothing to migrate");
  } else {
    const results = migrateConfigs();
    const migrated = results.filter(r => r.action === "migrated");
    const errors = results.filter(r => r.action === "error");

    if (migrated.length > 0) {
      for (const r of migrated) {
        cli.ok(`${r.platform}/${r.toolName}: migrated (${r.detail})`);
      }
    }
    if (errors.length > 0) {
      for (const r of errors) {
        cli.fail(`${r.platform}/${r.toolName}: ${r.detail}`);
      }
    }
    if (migrated.length === 0 && errors.length === 0) {
      cli.ok(`${augmentCount} augment${augmentCount === 1 ? "" : "s"} — all configs current`);
    }
  }

  // Mark updated
  markEquipUpdated();

  cli.log(`\n${cli.GREEN}${cli.BOLD}Update complete${cli.RESET}\n`);
}

function getInstalledVersion(): string {
  return resolvePackageVersion(__dirname);
}

function getGlobalVersion(): string | null {
  try {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const out = execSync(`${npmCmd} list -g @cg3/equip --json`, {
      encoding: "utf-8",
      timeout: 15000,
      stdio: "pipe",
    });
    const data = JSON.parse(out);
    return data?.dependencies?.["@cg3/equip"]?.version || null;
  } catch {
    return null;
  }
}
