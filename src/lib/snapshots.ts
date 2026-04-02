// Platform config snapshots — capture and restore config state.
// Lets users try augments risk-free with guaranteed rollback.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { atomicWriteFileSync } from "./fs";
import { acquireLock } from "./fs";
import { PLATFORM_REGISTRY, type DetectedPlatform } from "./platforms";
import { resolvePackageVersion } from "./fs";

// ─── Types ──────────────────────────────────────────────────

export interface Snapshot {
  id: string;
  platform: string;
  label: string;
  createdAt: string;
  trigger: "first-detection" | "manual" | "pre-install" | "pre-restore";
  configPath: string;
  configFormat: string;
  rulesPath: string | null;
  configContent: string | null;
  rulesContent: string | null;
  equipVersion: string;
}

export interface SnapshotSummary {
  id: string;
  platform: string;
  label: string;
  createdAt: string;
  trigger: string;
  configExists: boolean;
  rulesExists: boolean;
}

export interface RestoreResult {
  restored: boolean;
  snapshot: SnapshotSummary;
  configRestored: boolean;
  rulesRestored: boolean;
  preRestoreId: string | null;
  warnings: string[];
}

// ─── Paths ──────────────────────────────────────────────────

function snapshotsDir(): string {
  return path.join(os.homedir(), ".equip", "snapshots");
}

function platformSnapshotsDir(platformId: string): string {
  return path.join(snapshotsDir(), platformId);
}

function snapshotFilePath(platformId: string, snapshotId: string): string {
  return path.join(platformSnapshotsDir(platformId), `${snapshotId}.json`);
}

// ─── ID Generation ──────────────────────────────────────────

function generateSnapshotId(platformId: string): string {
  const now = new Date();
  const base = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  // e.g., "20260401T143022Z"

  if (!fs.existsSync(snapshotFilePath(platformId, base))) {
    return base;
  }

  // Same-second collision — append suffix
  for (let i = 1; i <= 999; i++) {
    const suffixed = `${base}-${String(i).padStart(3, "0")}`;
    if (!fs.existsSync(snapshotFilePath(platformId, suffixed))) {
      return suffixed;
    }
  }

  // Extremely unlikely fallback
  return `${base}-${Date.now()}`;
}

// ─── Create ─────────────────────────────────────────────────

/**
 * Capture a snapshot of a platform's current config state.
 * Stores the raw file contents (config + rules) with metadata.
 */
export function createSnapshot(
  platform: DetectedPlatform,
  options: { label?: string; trigger?: Snapshot["trigger"] } = {},
): Snapshot {
  const id = generateSnapshotId(platform.platform);
  const trigger = options.trigger || "manual";
  const label = options.label || trigger;

  // Read raw config content
  let configContent: string | null = null;
  try {
    configContent = fs.readFileSync(platform.configPath, "utf-8");
  } catch { /* file may not exist yet */ }

  // Read raw rules content
  let rulesContent: string | null = null;
  if (platform.rulesPath) {
    try {
      const stat = fs.statSync(platform.rulesPath);
      if (stat.isFile()) {
        rulesContent = fs.readFileSync(platform.rulesPath, "utf-8");
      }
      // If rulesPath is a directory (e.g., Roo Code), skip — we don't snapshot directories
    } catch { /* file may not exist */ }
  }

  const snapshot: Snapshot = {
    id,
    platform: platform.platform,
    label,
    createdAt: new Date().toISOString(),
    trigger,
    configPath: platform.configPath,
    configFormat: platform.configFormat,
    rulesPath: platform.rulesPath,
    configContent,
    rulesContent,
    equipVersion: resolvePackageVersion(__dirname),
  };

  // Write snapshot file
  const dir = platformSnapshotsDir(platform.platform);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(snapshotFilePath(platform.platform, id), JSON.stringify(snapshot, null, 2) + "\n");

  // Write sentinel marker for first-detection snapshots (fast lookup)
  if (trigger === "first-detection") {
    try { fs.writeFileSync(path.join(dir, ".initial-taken"), id); } catch {}
  }

  // Prune old snapshots (best effort)
  try { pruneSnapshots(platform.platform); } catch {}

  return snapshot;
}

// ─── List ───────────────────────────────────────────────────

function snapshotToSummary(snap: Snapshot): SnapshotSummary {
  return {
    id: snap.id,
    platform: snap.platform,
    label: snap.label,
    createdAt: snap.createdAt,
    trigger: snap.trigger,
    configExists: snap.configContent !== null,
    rulesExists: snap.rulesContent !== null,
  };
}

/**
 * List snapshots, optionally filtered to a single platform.
 * Returns summaries (without content) sorted newest-first.
 */
export function listSnapshots(platformId?: string): SnapshotSummary[] {
  const baseDir = snapshotsDir();
  if (!fs.existsSync(baseDir)) return [];

  const platformIds = platformId
    ? [platformId]
    : (() => {
        try { return fs.readdirSync(baseDir).filter(f => {
          try { return fs.statSync(path.join(baseDir, f)).isDirectory(); } catch { return false; }
        }); } catch { return []; }
      })();

  const summaries: SnapshotSummary[] = [];

  for (const pid of platformIds) {
    const dir = platformSnapshotsDir(pid);
    let files: string[];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")); }
    catch { continue; }

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf-8");
        const snap = JSON.parse(raw) as Snapshot;
        summaries.push(snapshotToSummary(snap));
      } catch { /* skip corrupt files */ }
    }
  }

  summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return summaries;
}

// ─── Read ───────────────────────────────────────────────────

/**
 * Read a full snapshot including content. Returns null if not found.
 */
export function readSnapshot(platformId: string, snapshotId: string): Snapshot | null {
  try {
    const raw = fs.readFileSync(snapshotFilePath(platformId, snapshotId), "utf-8");
    return JSON.parse(raw) as Snapshot;
  } catch {
    return null;
  }
}

// ─── Restore ────────────────────────────────────────────────

/**
 * Restore a platform's config to a snapshot.
 * If no snapshotId, restores to the initial (first-detection) snapshot.
 * Auto-creates a pre-restore snapshot of current state before restoring.
 */
export function restoreSnapshot(platformId: string, snapshotId?: string): RestoreResult {
  const releaseLock = acquireLock();
  try {
    return restoreSnapshotInner(platformId, snapshotId);
  } finally {
    releaseLock();
  }
}

function restoreSnapshotInner(platformId: string, snapshotId?: string): RestoreResult {
  // Find target snapshot
  let targetId = snapshotId;
  if (!targetId) {
    const initial = getInitialSnapshot(platformId);
    if (!initial) {
      throw new Error(`No initial snapshot found for ${platformId}`);
    }
    targetId = initial.id;
  }

  const snapshot = readSnapshot(platformId, targetId);
  if (!snapshot) {
    throw new Error(`Snapshot "${targetId}" not found for ${platformId}`);
  }

  const warnings: string[] = [];
  let configRestored = false;
  let rulesRestored = false;

  // Build a DetectedPlatform for the pre-restore snapshot.
  // Use the snapshot's recorded paths — these are the actual paths that were snapshotted.
  const def = PLATFORM_REGISTRY.get(platformId);
  const currentPlatform: DetectedPlatform = {
    platform: platformId,
    configPath: snapshot.configPath,
    rulesPath: snapshot.rulesPath,
    skillsPath: null,
    existingMcp: null,
    rootKey: def?.rootKey || "mcpServers",
    configFormat: (snapshot.configFormat as "json" | "toml") || "json",
  };

  // Create pre-restore snapshot of current state
  let preRestoreId: string | null = null;
  try {
    const preRestore = createSnapshot(currentPlatform, {
      label: "pre-restore",
      trigger: "pre-restore",
    });
    preRestoreId = preRestore.id;
  } catch {
    warnings.push("Failed to create pre-restore snapshot");
  }

  // Restore config file
  if (snapshot.configContent !== null) {
    try {
      const dir = path.dirname(snapshot.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      atomicWriteFileSync(snapshot.configPath, snapshot.configContent);
      configRestored = true;
    } catch (e: unknown) {
      warnings.push(`Failed to restore config: ${(e as Error).message}`);
    }
  } else {
    warnings.push("Config file did not exist at snapshot time — skipping config restore");
  }

  // Restore rules file (only if rulesPath is a file, not a directory)
  if (snapshot.rulesPath && snapshot.rulesContent !== null) {
    try {
      // Don't restore if rulesPath is now a directory (e.g., Roo Code migration)
      let isDir = false;
      try { isDir = fs.statSync(snapshot.rulesPath).isDirectory(); } catch {}

      if (!isDir) {
        const dir = path.dirname(snapshot.rulesPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        atomicWriteFileSync(snapshot.rulesPath, snapshot.rulesContent);
        rulesRestored = true;
      } else {
        warnings.push("Rules path is now a directory — skipping rules restore");
      }
    } catch (e: unknown) {
      warnings.push(`Failed to restore rules: ${(e as Error).message}`);
    }
  }

  return {
    restored: configRestored || rulesRestored,
    snapshot: snapshotToSummary(snapshot),
    configRestored,
    rulesRestored,
    preRestoreId,
    warnings,
  };
}

// ─── Delete ─────────────────────────────────────────────────

/**
 * Delete a single snapshot. Returns false if not found.
 */
export function deleteSnapshot(platformId: string, snapshotId: string): boolean {
  try {
    fs.unlinkSync(snapshotFilePath(platformId, snapshotId));
    return true;
  } catch {
    return false;
  }
}

// ─── Initial Snapshot Queries ────────────────────────────────

/**
 * Find the initial (first-detection) snapshot for a platform.
 */
export function getInitialSnapshot(platformId: string): SnapshotSummary | null {
  const all = listSnapshots(platformId);
  const initial = all.filter(s => s.trigger === "first-detection");
  if (initial.length === 0) return null;
  // Return the oldest first-detection snapshot
  return initial[initial.length - 1];
}

/**
 * Check if an initial snapshot exists for a platform.
 * Uses a sentinel marker file (.initial-taken) for O(1) lookup.
 */
export function hasInitialSnapshot(platformId: string): boolean {
  try {
    return fs.existsSync(path.join(platformSnapshotsDir(platformId), ".initial-taken"));
  } catch {
    return false;
  }
}

// ─── Ensure Initial Snapshots ────────────────────────────────

/**
 * Ensure all detected platforms have an initial snapshot.
 * Call this BEFORE any config modifications to capture pristine state.
 * Best-effort — failures are logged but don't prevent installation.
 */
export function ensureInitialSnapshots(platforms: DetectedPlatform[]): void {
  for (const p of platforms) {
    try {
      if (!hasInitialSnapshot(p.platform)) {
        createSnapshot(p, { label: "initial", trigger: "first-detection" });
      }
    } catch { /* best effort */ }
  }
}

// ─── Prune ──────────────────────────────────────────────────

/**
 * Keep the N most recent snapshots plus the first-detection snapshot.
 * Returns the number of pruned snapshots.
 */
export function pruneSnapshots(platformId: string, keepCount: number = 20): number {
  const all = listSnapshots(platformId);
  if (all.length <= keepCount) return 0;

  // Separate first-detection (always keep) from the rest
  const initial = all.filter(s => s.trigger === "first-detection");
  const others = all.filter(s => s.trigger !== "first-detection");

  // others is already sorted newest-first — keep the first `keepCount` minus initial count
  const keepOthers = Math.max(0, keepCount - initial.length);
  const toDelete = others.slice(keepOthers);

  let pruned = 0;
  for (const snap of toDelete) {
    if (deleteSnapshot(snap.platform, snap.id)) pruned++;
  }
  return pruned;
}
