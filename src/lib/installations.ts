// Installations — tracks what equip has installed and where.
//
// File: ~/.equip/installations.json
//
// **Pkg 01 of equip-storage-refactor (2026-04-28):** this file remains the
// LEGACY install-tracking layer for back-compat during the storage refactor.
// Every public read/write triggers `ensureStorageMigrated()` (idempotent)
// and every write mirrors per-augment to `~/.equip/installs/<name>.json`
// via `dual-write-mirror.ts`. Reads stay legacy in Pkg 01; Pkgs 02-04
// migrate consumers to read via `installsStore`. After all consumers
// migrate, this file can be deleted.

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync, safeReadJsonSync } from "./fs";
import { getEquipHome } from "./equip-home";
import { ensureStorageMigrated } from "./migration-trigger";
import { mirrorWriteInstallations } from "./dual-write-mirror";

// ─── Types ──────────────────────────────────────────────────

export interface ArtifactRecord {
  mcp: boolean;
  rules?: string;        // version if installed
  hooks?: string[];      // hook script names
  skills?: string[];     // skill names
  /**
   * How the MCP entry was installed for this augment on this platform.
   *   - "direct" or undefined: equip wrote the upstream's command/headers
   *     directly into the platform config (legacy default; also the
   *     non-OAuth path).
   *   - "broker": equip wrote a broker-shim invocation; credentials live
   *     in the broker daemon and are injected at runtime.
   *
   * Used by `equip doctor` to inspect the right path, and by uninstall
   * to also drop broker-held credentials when the install was brokered.
   *
   * Additive (Pkg 04 of equip-mcp-login-continuity-gate). Older equip
   * versions ignore the field; reading it back as undefined is safely
   * interpreted as "direct" by the dispatch path.
   */
  installMode?: "direct" | "broker";
}

export interface InstallationRecord {
  /** Source of the augment */
  source: "registry" | "local" | "wrapped";
  /** npm package name (for registry augments) */
  package?: string;
  /** Human-readable title */
  title: string;
  /** Transport type */
  transport: "http" | "stdio";
  /** Server URL (for HTTP) */
  serverUrl?: string;
  /** When first installed */
  installedAt: string;
  /** When last updated */
  updatedAt: string;
  /** Platforms where this augment is installed */
  platforms: string[];
  /** Per-platform artifact details */
  artifacts: Record<string, ArtifactRecord>;
}

export interface Installations {
  lastUpdated: string;
  augments: Record<string, InstallationRecord>;
}

// ─── Paths ──────────────────────────────────────────────────

function installationsPath(): string { return path.join(getEquipHome(), "installations.json"); }

// ─── Batched Writer (Package 05 of equip-skill-ownership) ──
//
// `installations.json` is rewritten by every trackInstallation/trackUninstallation
// call. At scale (scanAllPlatforms hitting orphan-wrap across many platforms ×
// many unmanaged augments), a single logical operation can cause dozens of
// full-file rewrites. The batch API collapses these into one write at the end
// of a logical operation.
//
// Pattern: caller wraps with `withInstallationsBatch(() => { ...do work... })`.
// Inside that block, trackInstallation/trackUninstallation mutate an in-memory
// buffer; readInstallations returns a clone of the buffer (so callers can't
// accidentally mutate batch state through a non-tracking path). The buffer is
// flushed once at the end via writeInstallations.
//
// Module-level state — a process can have at most one active batch. Nested
// begin throws; commit/abort outside a batch are no-ops (idempotent so cleanup
// in finally{} blocks is safe).

let activeBatch: Installations | null = null;

/**
 * Open a batched-write context. trackInstallation / trackUninstallation calls
 * after this point write to an in-memory buffer instead of disk.
 *
 * Throws if a batch is already active in this process.
 */
export function beginInstallationsBatch(): void {
  if (activeBatch !== null) {
    throw new Error("Installations batch already active — nested batches are not supported");
  }
  activeBatch = readFromDisk();
}

/**
 * Flush the active batch buffer to disk and clear it. Safe to call when no
 * batch is active (no-op).
 */
export function commitInstallationsBatch(): void {
  if (activeBatch === null) return;
  const toWrite = activeBatch;
  activeBatch = null;
  writeToDisk(toWrite);
}

/**
 * Discard the active batch buffer without writing. Safe to call when no batch
 * is active (no-op). Use in catch/finally blocks where commit hasn't run.
 */
export function abortInstallationsBatch(): void {
  activeBatch = null;
}

/**
 * Run `fn` inside a batched-write context. Single disk write at the end on
 * success; buffer discarded on exception (and rethrown).
 */
export function withInstallationsBatch<T>(fn: () => T): T {
  beginInstallationsBatch();
  try {
    const result = fn();
    commitInstallationsBatch();
    return result;
  } catch (e) {
    abortInstallationsBatch();
    throw e;
  }
}

/** True if a batched-write context is currently active in this process. */
export function isInstallationsBatchActive(): boolean {
  return activeBatch !== null;
}

// ─── Read / Write ───────────────────────────────────────────

function readFromDisk(): Installations {
  ensureStorageMigrated();
  const { data, status } = safeReadJsonSync(installationsPath());
  if (status !== "ok" || !data) {
    return { lastUpdated: "", augments: {} };
  }
  return data as unknown as Installations;
}

function writeToDisk(inst: Installations): void {
  ensureStorageMigrated();
  const dir = getEquipHome();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(installationsPath(), JSON.stringify(inst, null, 2) + "\n");
  // Pkg 01 dual-write: mirror per-augment to ~/.equip/installs/<name>.json.
  mirrorWriteInstallations(inst);
}

/**
 * Read installations.json. During an active batch, returns a deep clone of the
 * batch buffer so callers can read in-progress changes without being able to
 * mutate batch state through a non-tracking path. Outside a batch, reads
 * fresh from disk.
 */
export function readInstallations(): Installations {
  if (activeBatch !== null) {
    return JSON.parse(JSON.stringify(activeBatch)) as Installations;
  }
  return readFromDisk();
}

/**
 * Write installations.json atomically. During an active batch, mutates the
 * batch buffer instead — no disk write happens until commitInstallationsBatch.
 */
export function writeInstallations(inst: Installations): void {
  if (activeBatch !== null) {
    activeBatch = inst;
    return;
  }
  writeToDisk(inst);
}

// ─── Tracking ───────────────────────────────────────────────

/**
 * Record an installation. Merges with existing record if augment already tracked.
 */
export function trackInstallation(
  augmentName: string,
  record: Omit<InstallationRecord, "installedAt" | "updatedAt" | "platforms" | "artifacts"> & {
    platforms: string[];
    artifacts: Record<string, ArtifactRecord>;
  },
): void {
  const inst = readInstallations();
  const now = new Date().toISOString();

  const existing = inst.augments[augmentName];
  if (existing) {
    // Merge platforms (union)
    const allPlatforms = [...new Set([...existing.platforms, ...record.platforms])];
    inst.augments[augmentName] = {
      ...existing,
      ...record,
      installedAt: existing.installedAt,
      updatedAt: now,
      platforms: allPlatforms,
      artifacts: { ...existing.artifacts, ...record.artifacts },
    };
  } else {
    inst.augments[augmentName] = {
      ...record,
      installedAt: now,
      updatedAt: now,
    };
  }

  inst.lastUpdated = now;
  writeInstallations(inst);
}

/**
 * Remove an installation record for specific platforms, or entirely.
 * If platforms are specified, removes only those. If the augment has no
 * remaining platforms, removes the entire record.
 */
export function trackUninstallation(
  augmentName: string,
  platforms?: string[],
): void {
  const inst = readInstallations();
  if (!inst.augments[augmentName]) return;

  if (platforms) {
    // Remove specific platforms
    inst.augments[augmentName].platforms = inst.augments[augmentName].platforms
      .filter(p => !platforms.includes(p));
    for (const p of platforms) {
      delete inst.augments[augmentName].artifacts[p];
    }
    // If no platforms remain, remove the augment entirely
    if (inst.augments[augmentName].platforms.length === 0) {
      delete inst.augments[augmentName];
    } else {
      inst.augments[augmentName].updatedAt = new Date().toISOString();
    }
  } else {
    delete inst.augments[augmentName];
  }

  inst.lastUpdated = new Date().toISOString();
  writeInstallations(inst);
}

/**
 * Get all augment names installed on a specific platform.
 * Reverse lookup: platform → augment names.
 */
export function getAugmentsForPlatform(platformId: string): string[] {
  const inst = readInstallations();
  return Object.entries(inst.augments)
    .filter(([_, record]) => record.platforms.includes(platformId))
    .map(([name]) => name);
}

/**
 * Get the set of all managed augment names (across all platforms).
 * Used by platform scanning to determine the `managed` flag.
 */
export function getManagedAugmentNames(): Set<string> {
  const inst = readInstallations();
  return new Set(Object.keys(inst.augments));
}

/**
 * Find augments that installations.json records as owning a given skill name
 * on a given platform. Used by the install-time collision check to
 * cross-reference per-skill manifest claims against the authoritative
 * installation index. Returns augment names; usually 0 or 1.
 *
 * Excluding `excludeAugment` lets the caller ask "does anyone OTHER than me
 * already own this skill?"
 */
export function findAugmentsOwningSkill(
  platformId: string,
  skillName: string,
  excludeAugment?: string,
): string[] {
  const inst = readInstallations();
  const owners: string[] = [];
  for (const [augmentName, record] of Object.entries(inst.augments)) {
    if (excludeAugment && augmentName === excludeAugment) continue;
    const skills = record.artifacts?.[platformId]?.skills;
    if (Array.isArray(skills) && skills.includes(skillName)) {
      owners.push(augmentName);
    }
  }
  return owners;
}
