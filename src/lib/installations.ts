// Installations — tracks what equip has installed and where.
//
// File: ~/.equip/installations.json
// Replaces the tool-centric state.json with a cleaner model.
//
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { atomicWriteFileSync, safeReadJsonSync } from "./fs";

// ─── Types ──────────────────────────────────────────────────

export interface ArtifactRecord {
  mcp: boolean;
  rules?: string;        // version if installed
  hooks?: string[];      // hook script names
  skills?: string[];     // skill names
}

export interface InstallationRecord {
  /** Source of the augment */
  source: "registry" | "local" | "wrapped";
  /** npm package name (for registry augments) */
  package?: string;
  /** Human-readable name */
  displayName: string;
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

function equipDir(): string { return path.join(os.homedir(), ".equip"); }
function installationsPath(): string { return path.join(equipDir(), "installations.json"); }

// ─── Read / Write ───────────────────────────────────────────

/** Read installations.json. Returns empty state if file doesn't exist. */
export function readInstallations(): Installations {
  const { data, status } = safeReadJsonSync(installationsPath());
  if (status !== "ok" || !data) {
    return { lastUpdated: "", augments: {} };
  }
  return data as unknown as Installations;
}

/** Write installations.json atomically. */
export function writeInstallations(inst: Installations): void {
  const dir = equipDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(installationsPath(), JSON.stringify(inst, null, 2) + "\n");
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
