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

function sha256OfString(s: string): string {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
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
