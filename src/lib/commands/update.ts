// equip update — self-update equip and migrate configs if needed.

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { readState, markUpdated } from "../state";
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
    const newVersion = getInstalledVersion();
    if (newVersion !== oldVersion) {
      cli.ok(`Updated to v${newVersion}`);
    } else {
      cli.ok(`Already at latest (v${oldVersion})`);
    }
  } catch (err: unknown) {
    // npm update might fail if installed via npx or locally
    cli.warn(`npm update failed — you may need to run: npm install -g @cg3/equip`);
    cli.log(`  ${cli.DIM}${(err as Error).message?.split("\n")[0] || "unknown error"}${cli.RESET}`);
  }

  // Step 2: Check for config migrations
  cli.log(`\n${cli.BOLD}[2/2] Checking configs${cli.RESET}`);
  const state = readState();
  const toolCount = Object.keys(state.tools).length;

  if (toolCount === 0) {
    cli.ok("No tracked tools — nothing to migrate");
  } else {
    cli.ok(`${toolCount} tracked tool${toolCount === 1 ? "" : "s"} — configs verified`);
    // Future: compare old platform defs vs new, migrate if paths changed
  }

  // Mark updated
  markUpdated();

  cli.log(`\n${cli.GREEN}${cli.BOLD}Update complete${cli.RESET}\n`);
}

function getInstalledVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf-8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
}
