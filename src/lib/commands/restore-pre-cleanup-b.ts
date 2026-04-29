// `equip --restore-pre-cleanup-b` — recovery CLI for the schema-v4 cutover.
//
// Symmetric inverse of `cleanupBLegacyFiles()` in migrate-storage.ts. Reads
// the snapshot at `~/.equip/.backup-pre-cleanup-b/` and restores it to its
// original location:
//
//   ~/.equip/.backup-pre-cleanup-b/augments/  → ~/.equip/augments/
//   ~/.equip/.backup-pre-cleanup-b/installations.json → ~/.equip/installations.json
//
// Then bumps `.schema_version` back DOWN to 3 so a fresh sidecar boot will
// re-trigger the dual-write era's reads + writes against the legacy files.
//
// Conflict policy: if `~/.equip/augments/` already exists when restore runs,
// the operation aborts UNLESS `--force` is passed. This protects the user
// from accidentally clobbering their current state if they didn't actually
// intend to roll back. Same for `installations.json`.
//
// Backup directory is LEFT IN PLACE after a successful restore — the user
// can re-run the restore later if needed, or delete it manually (or via the
// `--discard-pre-cleanup-b-backup` CLI which Pkg 06 batch 2 will add).

import * as fs from "fs";
import * as path from "path";
import { getEquipHome } from "../equip-home.js";

const CLEANUP_B_BACKUP_DIRNAME = ".backup-pre-cleanup-b";
const LEGACY_AUGMENTS_DIRNAME = "augments";
const LEGACY_INSTALLATIONS_FILENAME = "installations.json";
const SCHEMA_VERSION_FILE = ".schema_version";
const PRE_CLEANUP_B_SCHEMA_VERSION = 3;

export type RestoreStatus = "complete" | "no-snapshot" | "conflict-augments" | "conflict-installations";

export interface RestoreResult {
  status: RestoreStatus;
  /** Number of augment files restored. */
  augmentsRestored: number;
  /** True if installations.json was restored. */
  installationsRestored: boolean;
  /** Where the snapshot was read from (null on no-snapshot). */
  backupPath: string | null;
  /** Human-readable explanation of the outcome (always populated for CLI display). */
  message: string;
}

export interface RestoreOptions {
  /** Override the conflict-detection guards. Required if augments/ or installations.json already exist. */
  force?: boolean;
}

export function restorePreCleanupB(opts?: RestoreOptions): RestoreResult {
  const home = getEquipHome();
  const backupDir = path.join(home, CLEANUP_B_BACKUP_DIRNAME);
  const backupAugments = path.join(backupDir, LEGACY_AUGMENTS_DIRNAME);
  const backupInstallations = path.join(backupDir, LEGACY_INSTALLATIONS_FILENAME);
  const targetAugments = path.join(home, LEGACY_AUGMENTS_DIRNAME);
  const targetInstallations = path.join(home, LEGACY_INSTALLATIONS_FILENAME);

  if (!fs.existsSync(backupDir)) {
    return {
      status: "no-snapshot",
      augmentsRestored: 0,
      installationsRestored: false,
      backupPath: null,
      message: `No snapshot found at ${backupDir}. Nothing to restore.`,
    };
  }

  const hasBackupAugments = fs.existsSync(backupAugments);
  const hasBackupInstallations = fs.existsSync(backupInstallations);

  // Conflict checks — abort BEFORE writing anything if force isn't set.
  if (hasBackupAugments && fs.existsSync(targetAugments) && !opts?.force) {
    return {
      status: "conflict-augments",
      augmentsRestored: 0,
      installationsRestored: false,
      backupPath: backupDir,
      message: `${targetAugments} already exists. Pass --force to overwrite, or remove the directory first.`,
    };
  }
  if (hasBackupInstallations && fs.existsSync(targetInstallations) && !opts?.force) {
    return {
      status: "conflict-installations",
      augmentsRestored: 0,
      installationsRestored: false,
      backupPath: backupDir,
      message: `${targetInstallations} already exists. Pass --force to overwrite, or remove the file first.`,
    };
  }

  // Restore augments dir (full overwrite — force was confirmed if target existed).
  let augmentsRestored = 0;
  if (hasBackupAugments) {
    if (fs.existsSync(targetAugments)) fs.rmSync(targetAugments, { recursive: true, force: true });
    copyDirRecursive(backupAugments, targetAugments);
    augmentsRestored = fs.readdirSync(targetAugments).filter((f) => f.endsWith(".json")).length;
  }

  let installationsRestored = false;
  if (hasBackupInstallations) {
    fs.copyFileSync(backupInstallations, targetInstallations);
    installationsRestored = true;
  }

  // Bump schema marker DOWN to 3 so a fresh sidecar will resume dual-write
  // behavior against the legacy files.
  fs.writeFileSync(path.join(home, SCHEMA_VERSION_FILE), String(PRE_CLEANUP_B_SCHEMA_VERSION), "utf-8");

  const augNote = augmentsRestored > 0 ? `${augmentsRestored} augment${augmentsRestored === 1 ? "" : "s"}` : "";
  const installNote = installationsRestored ? "installations.json" : "";
  const restored = [augNote, installNote].filter(Boolean).join(" + ");
  return {
    status: "complete",
    augmentsRestored,
    installationsRestored,
    backupPath: backupDir,
    message: `Restored ${restored || "nothing"} from ${backupDir}. Schema marker reset to v3.`,
  };
}

function copyDirRecursive(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

// CLI entry point — dispatched from src/cli/equip.ts.
export function runRestorePreCleanupB(parsed: { force?: boolean }): void {
  const result = restorePreCleanupB({ force: parsed.force });
  if (result.status === "complete") {
    process.stdout.write(`equip: ${result.message}\n`);
    return;
  }
  process.stderr.write(`equip: ${result.message}\n`);
  process.exit(result.status === "no-snapshot" ? 1 : 2);
}
