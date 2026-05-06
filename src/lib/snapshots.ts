// Platform config snapshots — capture and restore config state.
// Lets users try augments risk-free with guaranteed rollback.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
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
  configDeleted: boolean;
  rulesDeleted: boolean;
  preRestoreId: string | null;
  deletedPaths: string[];
  preservedPaths: string[];
  diff: SnapshotRestoreDiff;
  warnings: string[];
}

export type SnapshotRestoreMissingPathPolicy = "preserve" | "delete";

export type SnapshotRestoreAction =
  | "unchanged"
  | "create"
  | "modify"
  | "delete"
  | "preserve-added"
  | "skip";

export type SnapshotPathKind = "config" | "rules";

export interface SnapshotFileDiff {
  kind: SnapshotPathKind;
  path: string;
  action: SnapshotRestoreAction;
  currentExists: boolean;
  snapshotExists: boolean;
  currentKind: "file" | "directory" | "missing" | "other";
  currentBytes: number | null;
  snapshotBytes: number | null;
  currentHash: string | null;
  snapshotHash: string | null;
  reason?: string;
}

export interface SnapshotRestoreDiff {
  platform: string;
  snapshotId: string;
  generatedAt: string;
  missingPathPolicy: SnapshotRestoreMissingPathPolicy;
  entries: SnapshotFileDiff[];
  summary: {
    creates: number;
    modifies: number;
    deletes: number;
    preserves: number;
    unchanged: number;
    skipped: number;
  };
  warnings: string[];
}

export interface SnapshotRestoreOptions {
  /**
   * What to do when the target snapshot recorded that a config/rules file did
   * not exist, but that file exists now. Defaults to preserve so restore never
   * deletes user-created files unless explicitly requested.
   */
  missingPathPolicy?: SnapshotRestoreMissingPathPolicy;
}

// ─── Paths ──────────────────────────────────────────────────

import { getEquipHome } from "./equip-home";
function snapshotsDir(): string {
  return path.join(getEquipHome(), "snapshots");
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
  const trigger = options.trigger || "manual";
  const label = options.label || trigger;

  if (trigger === "first-detection") {
    const existingInitial = getInitialSnapshot(platform.platform);
    if (existingInitial) {
      try { pruneSnapshots(platform.platform); } catch {}
      const existingSnapshot = readSnapshot(platform.platform, existingInitial.id);
      if (existingSnapshot) return existingSnapshot;
    }
  }

  const id = generateSnapshotId(platform.platform);

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

function normalizeRestoreOptions(options: SnapshotRestoreOptions = {}): Required<SnapshotRestoreOptions> {
  return {
    missingPathPolicy: options.missingPathPolicy === "delete" ? "delete" : "preserve",
  };
}

function contentHash(content: string | null): string | null {
  if (content === null) return null;
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function readCurrentPathState(filePath: string): {
  exists: boolean;
  kind: SnapshotFileDiff["currentKind"];
  content: string | null;
  bytes: number | null;
  hash: string | null;
} {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return { exists: true, kind: "directory", content: null, bytes: null, hash: null };
    }
    if (!stat.isFile()) {
      return { exists: true, kind: "other", content: null, bytes: null, hash: null };
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return {
      exists: true,
      kind: "file",
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      hash: contentHash(content),
    };
  } catch {
    return { exists: false, kind: "missing", content: null, bytes: null, hash: null };
  }
}

function buildFileDiff(
  kind: SnapshotPathKind,
  filePath: string,
  snapshotContent: string | null,
  missingPathPolicy: SnapshotRestoreMissingPathPolicy,
): SnapshotFileDiff {
  const current = readCurrentPathState(filePath);
  const snapshotExists = snapshotContent !== null;
  const snapshotBytes = snapshotContent === null ? null : Buffer.byteLength(snapshotContent, "utf8");
  const snapshotHash = contentHash(snapshotContent);

  if (current.kind === "directory") {
    return {
      kind,
      path: filePath,
      action: "skip",
      currentExists: true,
      snapshotExists,
      currentKind: current.kind,
      currentBytes: current.bytes,
      snapshotBytes,
      currentHash: current.hash,
      snapshotHash,
      reason: "Current path is a directory; platform snapshots only restore files.",
    };
  }

  if (current.kind === "other") {
    return {
      kind,
      path: filePath,
      action: "skip",
      currentExists: true,
      snapshotExists,
      currentKind: current.kind,
      currentBytes: current.bytes,
      snapshotBytes,
      currentHash: current.hash,
      snapshotHash,
      reason: "Current path is not a regular file; platform snapshots only restore files.",
    };
  }

  if (snapshotExists) {
    const action: SnapshotRestoreAction = !current.exists
      ? "create"
      : current.hash === snapshotHash
        ? "unchanged"
        : "modify";
    return {
      kind,
      path: filePath,
      action,
      currentExists: current.exists,
      snapshotExists: true,
      currentKind: current.kind,
      currentBytes: current.bytes,
      snapshotBytes,
      currentHash: current.hash,
      snapshotHash,
    };
  }

  if (!current.exists) {
    return {
      kind,
      path: filePath,
      action: "unchanged",
      currentExists: false,
      snapshotExists: false,
      currentKind: current.kind,
      currentBytes: null,
      snapshotBytes: null,
      currentHash: null,
      snapshotHash: null,
      reason: "Path did not exist in the snapshot and does not exist now.",
    };
  }

  if (missingPathPolicy === "delete") {
    return {
      kind,
      path: filePath,
      action: "delete",
      currentExists: true,
      snapshotExists: false,
      currentKind: current.kind,
      currentBytes: current.bytes,
      snapshotBytes: null,
      currentHash: current.hash,
      snapshotHash: null,
      reason: "Path did not exist in the snapshot; delete policy will remove the current file.",
    };
  }

  return {
    kind,
    path: filePath,
    action: "preserve-added",
    currentExists: true,
    snapshotExists: false,
    currentKind: current.kind,
    currentBytes: current.bytes,
    snapshotBytes: null,
    currentHash: current.hash,
    snapshotHash: null,
    reason: "Path did not exist in the snapshot; preserve policy will leave the current file in place.",
  };
}

function summarizeDiff(entries: SnapshotFileDiff[]): SnapshotRestoreDiff["summary"] {
  return {
    creates: entries.filter(e => e.action === "create").length,
    modifies: entries.filter(e => e.action === "modify").length,
    deletes: entries.filter(e => e.action === "delete").length,
    preserves: entries.filter(e => e.action === "preserve-added").length,
    unchanged: entries.filter(e => e.action === "unchanged").length,
    skipped: entries.filter(e => e.action === "skip").length,
  };
}

function diffWarnings(entries: SnapshotFileDiff[]): string[] {
  return entries
    .filter(e => e.reason && (e.action === "preserve-added" || e.action === "skip"))
    .map(e => `${e.kind}: ${e.reason}`);
}

function resolveSnapshotForRestore(platformId: string, snapshotId?: string): Snapshot {
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

  return snapshot;
}

/**
 * Preview the exact file operations a restore would perform.
 * The result is JSON-safe so CLI, sidecar, and UI callers can render the same
 * restore plan before any writes happen.
 */
export function diffSnapshot(
  platformId: string,
  snapshotId?: string,
  options: SnapshotRestoreOptions = {},
): SnapshotRestoreDiff {
  const { missingPathPolicy } = normalizeRestoreOptions(options);
  const snapshot = resolveSnapshotForRestore(platformId, snapshotId);
  const entries: SnapshotFileDiff[] = [
    buildFileDiff("config", snapshot.configPath, snapshot.configContent, missingPathPolicy),
  ];

  if (snapshot.rulesPath) {
    entries.push(buildFileDiff("rules", snapshot.rulesPath, snapshot.rulesContent, missingPathPolicy));
  }

  const warnings = diffWarnings(entries);
  return {
    platform: platformId,
    snapshotId: snapshot.id,
    generatedAt: new Date().toISOString(),
    missingPathPolicy,
    entries,
    summary: summarizeDiff(entries),
    warnings,
  };
}

// ─── Restore ────────────────────────────────────────────────

/**
 * Restore a platform's config to a snapshot.
 * If no snapshotId, restores to the initial (first-detection) snapshot.
 * Auto-creates a pre-restore snapshot of current state before restoring.
 */
export function restoreSnapshot(
  platformId: string,
  snapshotId?: string,
  options: SnapshotRestoreOptions = {},
): RestoreResult {
  const releaseLock = acquireLock();
  try {
    return restoreSnapshotInner(platformId, snapshotId, options);
  } finally {
    releaseLock();
  }
}

function restoreSnapshotInner(
  platformId: string,
  snapshotId?: string,
  options: SnapshotRestoreOptions = {},
): RestoreResult {
  const normalizedOptions = normalizeRestoreOptions(options);
  const snapshot = resolveSnapshotForRestore(platformId, snapshotId);
  const diff = diffSnapshot(platformId, snapshot.id, normalizedOptions);
  const warnings: string[] = [...diff.warnings];
  let configRestored = false;
  let rulesRestored = false;
  let configDeleted = false;
  let rulesDeleted = false;
  const deletedPaths: string[] = [];
  const preservedPaths = diff.entries
    .filter(e => e.action === "preserve-added")
    .map(e => e.path);

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

  const applyEntry = (entry: SnapshotFileDiff, snapshotContent: string | null): void => {
    try {
      if (entry.action === "create" || entry.action === "modify") {
        if (snapshotContent === null) {
          warnings.push(`No snapshot content available for ${entry.kind}`);
          return;
        }
        const dir = path.dirname(entry.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        atomicWriteFileSync(entry.path, snapshotContent);
        if (entry.kind === "config") configRestored = true;
        else rulesRestored = true;
        return;
      }

      if (entry.action === "delete") {
        fs.unlinkSync(entry.path);
        deletedPaths.push(entry.path);
        if (entry.kind === "config") configDeleted = true;
        else rulesDeleted = true;
      }
    } catch (e: unknown) {
      warnings.push(`Failed to apply ${entry.kind} restore action "${entry.action}": ${(e as Error).message}`);
    }
  };

  for (const entry of diff.entries) {
    const snapshotContent = entry.kind === "config" ? snapshot.configContent : snapshot.rulesContent;
    applyEntry(entry, snapshotContent);
  }

  return {
    restored: configRestored || rulesRestored || configDeleted || rulesDeleted,
    snapshot: snapshotToSummary(snapshot),
    configRestored,
    rulesRestored,
    configDeleted,
    rulesDeleted,
    preRestoreId,
    deletedPaths,
    preservedPaths,
    diff,
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
    const markerPath = path.join(platformSnapshotsDir(platformId), ".initial-taken");
    if (fs.existsSync(markerPath)) {
      const markerId = fs.readFileSync(markerPath, "utf-8").trim();
      if (markerId && fs.existsSync(snapshotFilePath(platformId, markerId))) {
        return true;
      }
    }
    return getInitialSnapshot(platformId) !== null;
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
      } else {
        pruneSnapshots(p.platform);
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

  // Keep exactly one first-detection snapshot: the oldest one is the real
  // pre-Equip baseline. Duplicate baselines can be created by older builds or
  // stale marker loops and should not be kept forever.
  const initial = all.filter(s => s.trigger === "first-detection");
  const initialToKeep = initial.length > 0 ? initial[initial.length - 1] : null;
  const duplicateInitial = initialToKeep
    ? initial.filter(s => s.id !== initialToKeep.id)
    : [];
  const others = all.filter(s => s.trigger !== "first-detection");

  // Others are already sorted newest-first; reserve one slot for the baseline.
  const keepOthers = Math.max(0, keepCount - (initialToKeep ? 1 : 0));
  const toDelete = [...duplicateInitial, ...others.slice(keepOthers)];

  let pruned = 0;
  for (const snap of toDelete) {
    if (deleteSnapshot(snap.platform, snap.id)) pruned++;
  }

  if (initialToKeep) {
    try {
      const dir = platformSnapshotsDir(platformId);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".initial-taken"), initialToKeep.id);
    } catch {}
  }

  return pruned;
}
