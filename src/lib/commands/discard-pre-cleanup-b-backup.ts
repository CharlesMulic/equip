// `equip --discard-pre-cleanup-b-backup` — delete the .backup-pre-cleanup-b/
// snapshot after the user confirms they're satisfied with the schema-v4
// cutover.
//
// Pairs with `restore-pre-cleanup-b.ts` (recovery CLI) — together they form
// the user-facing surface for managing the snapshot's lifecycle. Doctor
// surface (commands/doctor.ts) reports snapshot existence + size + age so
// the user notices it sitting on disk.
//
// Default conservative: requires --force to actually delete. Without --force
// it dry-runs (reports what would be deleted) so the user can preview.

import * as fs from "fs";
import * as path from "path";
import { getEquipHome } from "../equip-home.js";

const CLEANUP_B_BACKUP_DIRNAME = ".backup-pre-cleanup-b";

export type DiscardStatus = "no-snapshot" | "dry-run" | "complete" | "error";

export interface DiscardResult {
  status: DiscardStatus;
  /** Size of the snapshot directory in bytes (best-effort tally before deletion). */
  bytesFreed: number;
  /** Where the snapshot was (or would have been). */
  backupPath: string | null;
  /** Human-readable explanation for CLI display. */
  message: string;
}

export interface DiscardOptions {
  /** Required to actually delete. Without --force, runs as dry-run. */
  force?: boolean;
}

export function discardPreCleanupBBackup(opts?: DiscardOptions): DiscardResult {
  const home = getEquipHome();
  const backupDir = path.join(home, CLEANUP_B_BACKUP_DIRNAME);

  if (!fs.existsSync(backupDir)) {
    return {
      status: "no-snapshot",
      bytesFreed: 0,
      backupPath: null,
      message: `No snapshot found at ${backupDir}. Nothing to discard.`,
    };
  }

  const bytes = tallyBytes(backupDir);
  const sizeMb = (bytes / 1024 / 1024).toFixed(1);

  if (!opts?.force) {
    return {
      status: "dry-run",
      bytesFreed: bytes,
      backupPath: backupDir,
      message: `Would delete ${backupDir} (${sizeMb} MB). Re-run with --force to proceed.`,
    };
  }

  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (e) {
    return {
      status: "error",
      bytesFreed: 0,
      backupPath: backupDir,
      message: `Failed to delete ${backupDir}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return {
    status: "complete",
    bytesFreed: bytes,
    backupPath: backupDir,
    message: `Deleted ${backupDir} (${sizeMb} MB freed).`,
  };
}

function tallyBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { total += tallyBytes(full); continue; }
      try { total += fs.statSync(full).size; } catch { /* skip */ }
    }
  } catch { /* skip unreadable dir */ }
  return total;
}

// CLI entry point — dispatched from src/cli/equip.ts.
export function runDiscardPreCleanupBBackup(parsed: { force?: boolean }): void {
  const result = discardPreCleanupBBackup({ force: parsed.force });
  if (result.status === "complete" || result.status === "dry-run") {
    process.stdout.write(`equip: ${result.message}\n`);
    return;
  }
  process.stderr.write(`equip: ${result.message}\n`);
  process.exit(result.status === "no-snapshot" ? 1 : 2);
}
