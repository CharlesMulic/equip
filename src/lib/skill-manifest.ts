// Per-skill installation manifest: {skillDir}/.equip-meta.json
//
// Records which augment installed which skill, with per-file SHA-256 fingerprints
// so uninstall can preserve user-modified files. The manifest is the on-disk
// hygiene control for skill ownership; `~/.equip/installations.json` remains
// the authoritative cross-platform index.
//
// Manifest is NOT a security boundary — it lives in user-writable platform skill
// dirs and a determined attacker can forge one. Cross-check ownership claims
// against installations.json before acting on them.
//
// Schema invariants (v1):
// - manifestVersion === 1
// - skill === parent dir name (Agent Skills spec invariant)
// - owners[] is an array (single-element for v1; refcounted in package 03)
// - files[] preserves insertion order; rewrites must keep stable ordering
// - Unknown top-level fields are tolerated and round-tripped by readManifest +
//   writeManifest so future schema extensions (tombstone, loadout, set, ...)
//   don't break v1 readers.
//
// Zero dependencies beyond node built-ins.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync, safeReadJsonSync } from "./fs";
import { getCachedHash, setCachedHash } from "./checksum-cache";
import type { SkillConfig } from "./skills";

// ─── Types ──────────────────────────────────────────────────

export type SkillManifestOwnerSource = "registry" | "local" | "wrapped";

export interface SkillManifestHash {
  algorithm: "sha256";
  value: string;
}

export interface SkillManifestFile {
  path: string;
  hash: SkillManifestHash;
  size: number;
}

export interface SkillManifestOwner {
  augment: string;
  augmentVersion: number;
  platform: string;
  source: SkillManifestOwnerSource;
  package?: string;
  installedAt: string;
}

export interface SkillManifestInstall {
  skillsRoot: string;
  equipVersion: string;
}

/**
 * v1 skill manifest. Implementations MUST tolerate unknown top-level fields
 * for forward compatibility; readManifest preserves them and writeManifest
 * round-trips them via the catch-all index signature.
 */
export interface SkillManifest {
  manifestVersion: 1;
  skill: string;
  owners: SkillManifestOwner[];
  files: SkillManifestFile[];
  install: SkillManifestInstall;
  /** Forward-compat: unknown top-level fields land here. */
  [extra: string]: unknown;
}

// ─── Filename ───────────────────────────────────────────────

export const MANIFEST_FILENAME = ".equip-meta.json";

export function manifestPath(skillDir: string): string {
  return path.join(skillDir, MANIFEST_FILENAME);
}

// ─── Hash primitive ─────────────────────────────────────────

export function sha256OfString(s: string): string {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}

/**
 * Verify a file on disk matches a manifest hash entry.
 * Returns:
 *  - "match"   — file exists and content hash equals expected
 *  - "drift"   — file exists but content hash differs (user-modified)
 *  - "missing" — file doesn't exist (already deleted)
 *  - "unreadable" — exists but can't be read (permission/IO error)
 */
export type FileVerifyStatus = "match" | "drift" | "missing" | "unreadable";

export function verifyFileAgainstManifest(
  filePath: string,
  expected: SkillManifestHash,
): FileVerifyStatus {
  // Cache fast path: getCachedHash returns null if no entry, mtime/size
  // mismatch, or stat fails. A stat failure here looks the same as a cache
  // miss, so we still hit the read path below to disambiguate ENOENT vs
  // other I/O errors and return the right FileVerifyStatus.
  const cached = getCachedHash(filePath);
  if (cached !== null) {
    return cached === expected.value ? "match" : "drift";
  }
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "unreadable";
  }
  const hash = sha256OfString(content);
  // Populate cache lazily so subsequent verifies on this same file are fast.
  // Best-effort — failures inside setCachedHash log a debug line but don't
  // affect correctness.
  setCachedHash(filePath, hash);
  return hash === expected.value ? "match" : "drift";
}

// ─── Read / write ───────────────────────────────────────────

/**
 * Read the skill manifest. Returns null if the file doesn't exist.
 * Throws if the file exists but is unreadable or unparseable — callers must
 * decide whether to repair or refuse to proceed (a corrupt manifest in a
 * skill dir is a yellow flag, not a green one).
 */
export function readManifest(skillDir: string): SkillManifest | null {
  const { data, status, error } = safeReadJsonSync(manifestPath(skillDir));
  if (status === "missing") return null;
  if (status !== "ok" || !data) {
    throw new Error(`Skill manifest at ${manifestPath(skillDir)} is ${status}: ${error || "no data"}`);
  }
  // Minimal shape sanity. Don't strip unknown fields.
  if (typeof (data as { manifestVersion?: unknown }).manifestVersion !== "number") {
    throw new Error(`Skill manifest at ${manifestPath(skillDir)} missing manifestVersion`);
  }
  return data as unknown as SkillManifest;
}

/**
 * Write the skill manifest atomically. Caller is responsible for ensuring
 * the parent skill dir exists.
 */
export function writeManifest(skillDir: string, manifest: SkillManifest): void {
  atomicWriteFileSync(manifestPath(skillDir), JSON.stringify(manifest, null, 2) + "\n");
}

// ─── Build helpers ──────────────────────────────────────────

/**
 * Compute the file entries (path + sha256 + size) for a SkillConfig.
 * Hashes are over file CONTENT bytes (UTF-8 encoded). Order matches the
 * input skill.files[] for stable diffs.
 */
export function computeFileEntries(skill: SkillConfig): SkillManifestFile[] {
  return skill.files.map((f) => {
    const value = sha256OfString(f.content);
    const size = Buffer.byteLength(f.content, "utf-8");
    return {
      path: f.path,
      hash: { algorithm: "sha256" as const, value },
      size,
    };
  });
}

export interface BuildManifestArgs {
  skill: SkillConfig;
  toolName: string;
  augmentVersion?: number;
  source: SkillManifestOwnerSource;
  package?: string;
  platformId: string;
  skillsRoot: string;
  equipVersion: string;
  installedAt?: string;
}

/**
 * Build a fresh v1 manifest for a skill being installed by `toolName` for
 * `platformId`. `owners[]` always starts with a single element here; package
 * 03 extends this for shared-root scenarios.
 */
export function buildManifestForInstall(args: BuildManifestArgs): SkillManifest {
  return {
    manifestVersion: 1,
    skill: args.skill.name,
    owners: [
      {
        augment: args.toolName,
        augmentVersion: args.augmentVersion ?? 0,
        platform: args.platformId,
        source: args.source,
        ...(args.package ? { package: args.package } : {}),
        installedAt: args.installedAt ?? new Date().toISOString(),
      },
    ],
    files: computeFileEntries(args.skill),
    install: {
      skillsRoot: args.skillsRoot,
      equipVersion: args.equipVersion,
    },
  };
}

/**
 * Return the sole owner of a manifest if there is exactly one; null otherwise.
 * Convenience for v1 callers that don't yet care about refcounted owners.
 */
export function manifestSoleOwner(manifest: SkillManifest): SkillManifestOwner | null {
  return manifest.owners.length === 1 ? manifest.owners[0] : null;
}

/**
 * Find the owner entry for a specific (augment, platform) pair, or null.
 */
export function findOwner(
  manifest: SkillManifest,
  augment: string,
  platformId: string,
): SkillManifestOwner | null {
  return manifest.owners.find(
    (o) => o.augment === augment && o.platform === platformId,
  ) ?? null;
}

// ─── Tombstone ──────────────────────────────────────────────

/**
 * Tombstone metadata written to a manifest after uninstall preserves the dir
 * (because user-modified or user-added files survived). The empty `owners`
 * array marks the manifest as a tombstone; the `tombstone` field carries
 * forensic detail.
 *
 * Stored under the unknown-fields-tolerant catch-all of SkillManifest;
 * v1 readers preserve it on round-trip.
 */
export interface TombstoneMetadata {
  uninstalledAt: string;
  uninstalledBy: string;
  preservedFiles: string[];
}

export interface BuildTombstoneArgs {
  previous: SkillManifest;
  uninstalledBy: string;
  preservedFiles: string[];
  uninstalledAt?: string;
}

/**
 * Build a tombstone manifest from a previous (live) manifest. Preserves the
 * skill name, schema version, and install context for forensics; clears
 * owners[] and files[] (Equip no longer claims any file in this dir);
 * records what was preserved and when.
 *
 * Tombstone marker = `owners.length === 0` AND `tombstone` field present.
 * Use isTombstone() to detect.
 */
export function buildTombstoneManifest(args: BuildTombstoneArgs): SkillManifest {
  return {
    manifestVersion: 1,
    skill: args.previous.skill,
    owners: [],
    files: [],
    install: args.previous.install,
    tombstone: {
      uninstalledAt: args.uninstalledAt ?? new Date().toISOString(),
      uninstalledBy: args.uninstalledBy,
      preservedFiles: args.preservedFiles,
    } satisfies TombstoneMetadata,
  };
}

/**
 * True if the manifest is a tombstone (empty owners + tombstone metadata).
 * Used by reconcile / orphan-wrap paths so dirs Equip once owned aren't
 * re-detected as user-authored skills on subsequent scans.
 */
export function isTombstone(manifest: SkillManifest): boolean {
  return manifest.owners.length === 0 && Boolean(manifest.tombstone);
}
