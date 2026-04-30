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
import { isLegacyStorageRetired } from "./migrate-storage";
// Phase A journal-bridge: every legacy trackInstallation/trackUninstallation
// call also lands in the canonical journal so journal-canonical readers
// (doctor, skills, status — all migrated in A3a/A3b) see the full picture
// during the transition. Lazy-loaded via dynamic getter to avoid load-order
// issues. The bridge is removed in A4 along with this entire module.
import { JsonStore } from "./storage/datastore";
import type { ContentSource, PlatformInstallMode } from "./storage/intent";
import type { AugmentContent } from "./storage/content-store";

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
  // Cleanup B Pkg 06 batch 1: defensive gate on the schema-v4 cutover.
  // Same rationale as augment-defs.ts:writeAugmentDef — refuse to recreate
  // ~/.equip/installations.json after Cleanup B has retired it. Mirror still
  // fires so the new installs/ store stays in sync with caller intent.
  if (isLegacyStorageRetired()) {
    // eslint-disable-next-line no-console
    console.warn(`[equip] writeInstallations: refusing legacy write — schema_version >= 4 (post-Cleanup-B). The new installs/ store is authoritative.`);
    mirrorWriteInstallations(inst);
    return;
  }
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

  // Journal-bridge: also append InstallAugmentIntent so the canonical journal
  // reflects this install. The merged record (post-write) is the source of
  // truth for platforms/installModes since trackInstallation may merge with
  // an existing record (broker preservation, multi-platform installs).
  bridgeInstallToJournal(augmentName, inst.augments[augmentName]);
}

function bridgeInstallToJournal(name: string, record: InstallationRecord): void {
  try {
    const content = buildContentBlobFor(name, record);
    if (!content) return;
    const contentHash = JsonStore.putContent(content);
    const contentSource: ContentSource = record.source === "registry"
      ? { kind: "registry", version: 1, fetchedAt: record.updatedAt }
      : { kind: "local-authored", createdAt: record.installedAt };

    // Preserve broker mode that was already in the journal — install intents
    // replace (not merge) installModes, so consecutive calls would silently
    // drop broker mode if not carried forward here.
    const existing = JsonStore.resolve(name);
    const installModes: Record<string, PlatformInstallMode> = {};
    if (existing) {
      for (const platformId of record.platforms) {
        if (existing.installModes[platformId] === "broker") {
          installModes[platformId] = "broker";
        }
      }
    }
    for (const platformId of record.platforms) {
      const mode = record.artifacts?.[platformId]?.installMode;
      if (mode === "broker") installModes[platformId] = "broker";
    }

    JsonStore.appendIntent({
      type: "install-augment",
      clock: JsonStore.newClock(),
      name,
      contentHash,
      contentSource,
      platforms: record.platforms,
      ...(Object.keys(installModes).length > 0 ? { installModes } : {}),
    });
  } catch {
    // Best effort — never let journal-bridge failure break legacy writes.
  }
}

function buildContentBlobFor(name: string, record: InstallationRecord): AugmentContent | null {
  // Resolve the augment via the legacy resolver to get its content shape.
  // Lazy require to avoid module-load cycles between installations →
  // augment-resolver → installs-store → installations.
  let resolved: { skills?: { name: string; files?: { path: string; content: string }[] }[]; rules?: { content: string; version: string; marker: string }; hooks?: { event: string; matcher?: string; script: string; name: string }[]; transport?: string; serverUrl?: string; stdio?: { command: string; args: string[] }; requiresAuth?: boolean; description?: string; title?: string } | null = null;
  try {
    const mod = require("./augment-resolver");
    resolved = mod.augmentResolver?.resolve?.(name) ?? null;
  } catch {
    return null;
  }
  if (!resolved) {
    // No legacy def available → can't build a meaningful content blob.
    // Skipping is safe: the journal-canonical writers (reconcile, the
    // sidecar bridge, future authoring flows) write content + intents
    // directly, so a missing legacy def usually means the journal is
    // already authoritative for this augment. Returning null tells the
    // bridge to skip the appendIntent.
    return null;
  }
  const transport = resolved.transport === "http" || resolved.transport === "stdio"
    ? resolved.transport
    : record.transport;
  return {
    name,
    title: resolved.title || record.title,
    description: resolved.description || "",
    transport,
    serverUrl: transport === "http" ? (resolved.serverUrl || record.serverUrl) : undefined,
    stdio: resolved.stdio
      ? { command: resolved.stdio.command, args: resolved.stdio.args }
      : undefined,
    requiresAuth: resolved.requiresAuth ?? false,
    rules: resolved.rules,
    skills: (resolved.skills || []).map((s) => ({ name: s.name, files: s.files || [] })),
    hooks: resolved.hooks || [],
  };
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

  // Journal-bridge: append UninstallAugmentIntent so the journal-canonical
  // readers see the uninstall. If platforms unspecified the uninstall is
  // total; otherwise only the named platforms are dropped.
  try {
    JsonStore.appendIntent({
      type: "uninstall-augment",
      clock: JsonStore.newClock(),
      name: augmentName,
      ...(platforms ? { platforms } : {}),
    });
  } catch { /* best effort */ }
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
