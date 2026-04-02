// equip snapshot / snapshots / restore — platform config snapshot management.

import { detectPlatforms } from "../detect";
import { platformName, resolvePlatformId } from "../platforms";
import { createSnapshot, listSnapshots, restoreSnapshot, type SnapshotSummary } from "../snapshots";
import { createConsoleLogger, type ParsedArgs } from "../cli";
import * as cli from "../cli";

/**
 * equip snapshot [platform] — create a manual snapshot of platform config state.
 */
export function runSnapshot(parsedArgs: ParsedArgs): void {
  const detected = detectPlatforms();

  let targets = detected;
  if (parsedArgs.platform) {
    const requested = parsedArgs.platform.split(",").map(s => resolvePlatformId(s.trim()));
    targets = detected.filter(p => requested.includes(p.platform));
    if (targets.length === 0) {
      cli.fail(`None of the specified platforms detected: ${parsedArgs.platform}`);
      process.exit(1);
    }
  } else if (parsedArgs._.length > 0) {
    const requested = parsedArgs._.map(s => resolvePlatformId(s.trim()));
    targets = detected.filter(p => requested.includes(p.platform));
    if (targets.length === 0) {
      cli.fail(`Platform not detected: ${parsedArgs._[0]}`);
      process.exit(1);
    }
  }

  cli.log(`\n${cli.BOLD}equip snapshot${cli.RESET}\n`);

  for (const p of targets) {
    try {
      const label = parsedArgs._.length > 1 ? parsedArgs._[1] : "manual";
      const snap = createSnapshot(p, { label, trigger: "manual" });
      cli.ok(`${platformName(p.platform)}   ${snap.id}`);
    } catch (e: unknown) {
      cli.fail(`${platformName(p.platform)}   ${(e as Error).message}`);
    }
  }
  cli.log("");
}

/**
 * equip snapshots [platform] — list available config snapshots.
 */
export function runSnapshots(parsedArgs: ParsedArgs): void {
  let platformId: string | undefined;
  if (parsedArgs._.length > 0) {
    platformId = resolvePlatformId(parsedArgs._[0]);
  } else if (parsedArgs.platform) {
    platformId = resolvePlatformId(parsedArgs.platform);
  }

  const snapshots = listSnapshots(platformId);

  cli.log(`\n${cli.BOLD}equip snapshots${cli.RESET}\n`);

  if (snapshots.length === 0) {
    cli.log(`  ${cli.DIM}No snapshots found.${cli.RESET}`);
    cli.log(`  ${cli.DIM}Snapshots are created automatically on first platform detection,${cli.RESET}`);
    cli.log(`  ${cli.DIM}or manually with: equip snapshot [platform]${cli.RESET}`);
    cli.log("");
    return;
  }

  // Group by platform
  const byPlatform = new Map<string, SnapshotSummary[]>();
  for (const s of snapshots) {
    const list = byPlatform.get(s.platform) || [];
    list.push(s);
    byPlatform.set(s.platform, list);
  }

  for (const [pid, snaps] of byPlatform) {
    cli.log(`  ${cli.BOLD}${platformName(pid)}${cli.RESET}`);
    for (const s of snaps) {
      const date = new Date(s.createdAt);
      const dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const labelStr = s.trigger === "first-detection" ? `${cli.GREEN}initial${cli.RESET}` : s.label;
      const contents = [
        s.configExists ? "config" : null,
        s.rulesExists ? "rules" : null,
      ].filter(Boolean).join(", ");
      cli.log(`    ${s.id}  ${labelStr}  ${cli.DIM}${dateStr}  (${contents})${cli.RESET}`);
    }
    cli.log("");
  }
}

/**
 * equip restore <platform> [snapshot-id] — restore platform config from a snapshot.
 */
export async function runRestore(parsedArgs: ParsedArgs): Promise<void> {
  const platformArg = parsedArgs._[0];
  if (!platformArg) {
    process.stderr.write("Usage: equip restore <platform> [snapshot-id]\n");
    process.exit(1);
  }

  const platformId = resolvePlatformId(platformArg);
  const snapshotId = parsedArgs._[1] || undefined;

  cli.log(`\n${cli.BOLD}equip restore${cli.RESET} ${platformName(platformId)}\n`);

  // Show what will be restored
  const snapshots = listSnapshots(platformId);
  if (snapshots.length === 0) {
    cli.fail(`No snapshots found for ${platformName(platformId)}`);
    process.exit(1);
  }

  const target = snapshotId
    ? snapshots.find(s => s.id === snapshotId)
    : snapshots.find(s => s.trigger === "first-detection") || snapshots[snapshots.length - 1];

  if (!target) {
    cli.fail(`Snapshot "${snapshotId}" not found`);
    process.exit(1);
  }

  const date = new Date(target.createdAt).toLocaleString();
  cli.log(`  Snapshot  ${target.id} (${target.label})`);
  cli.log(`  Created   ${date}`);
  cli.log(`  Contains  ${[target.configExists ? "config" : null, target.rulesExists ? "rules" : null].filter(Boolean).join(", ") || "empty"}`);

  if (!parsedArgs.nonInteractive) {
    cli.log("");
    const proceed = await cli.promptEnterOrEsc(`  Press ${cli.BOLD}Enter${cli.RESET} to restore, or ${cli.BOLD}Esc${cli.RESET} to cancel: `);
    if (!proceed) {
      cli.log("  Cancelled.\n");
      return;
    }
  }

  try {
    const result = restoreSnapshot(platformId, target.id);

    if (result.restored) {
      if (result.configRestored) cli.ok("Config file restored");
      if (result.rulesRestored) cli.ok("Rules file restored");
      if (result.preRestoreId) {
        cli.log(`  ${cli.DIM}Pre-restore snapshot saved: ${result.preRestoreId}${cli.RESET}`);
      }
    } else {
      cli.warn("Nothing was restored");
    }

    for (const w of result.warnings) {
      cli.warn(w);
    }
  } catch (e: unknown) {
    cli.fail((e as Error).message);
    process.exit(1);
  }

  cli.log("");
}
