// Defs store — sovereign user content for augments.
//
// One of three storage primitives in the equip-storage-refactor architecture:
//   - defs-store    (THIS FILE)  — sovereign user content (local/overlay/wrapped)
//   - cache-store   (sibling)    — registry snapshot + freshness metadata
//   - installs-store (sibling)   — install metadata only (no content)
//
// **Single-writer rule (CI-pinned):** writes to ~/.equip/defs/<name>.json
// happen only from migrate-storage.ts, the bridge's publish/retract paths,
// and (Pkg 02) the overlay-write + retraction-promotion paths. The CI grep
// test in equip-product enforces this scope; if a future change needs a new
// writer, audit the storage contract first.
//
// File layout: ~/.equip/defs/<name>.json. One file per augment.
//
// Architectural backstory: the legacy ~/.equip/augments/<name>.json schema
// conflated 6 different concerns (sovereign local / cached registry /
// publisher state / mods on registry / wrapped detection / registry tracking)
// in one file. Stale-cache bugs followed naturally from that conflation. The
// three-store split makes sovereign-vs-cached-vs-installed self-documenting
// on disk; resolver enforces the read order so every consumer sees a single
// authoritative answer.
//
// See operations/initiatives/equip-storage-refactor/work/01-... for the full
// architecture context.

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync, safeReadJsonSync } from "./fs";
import { getEquipHome } from "./equip-home";
import { validateToolName } from "./validation";
import type { AugmentRules } from "./augment-defs";
import type { SkillConfig } from "./skills";
import type { HookDefinition } from "./hooks";
import type { WrappedFromMeta } from "./augment-defs";
import type { AuthConfig } from "./auth-engine";

// ─── Types ──────────────────────────────────────────────────

/**
 * Discriminator for the three sovereign-content kinds. (Note: `installed` is
 * NOT a kind — pure-registry-installed augments have no defs/ entry; their
 * content lives in cache/, install metadata in installs/.)
 */
export type DefKind = "local" | "overlay" | "wrapped";

export interface DefBase {
  /** Augment name — must match the filename (without .json). */
  name: string;
  /** Discriminator. See DefKind for semantics. */
  kind: DefKind;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
}

/**
 * Local augment — sovereign user-authored content. The file IS the augment.
 * No upstream registry entity.
 */
export interface LocalDef extends DefBase {
  kind: "local";

  // ── Identity / display ──
  title: string;
  subtitle?: string;
  description: string;
  rarity?: "common" | "uncommon" | "rare" | "epic" | "legendary";
  flavorText?: string;

  // ── Infrastructure ──
  transport?: "http" | "stdio";
  serverUrl?: string;
  stdio?: { command: string; args: string[]; envKey?: string };
  requiresAuth: boolean;
  auth?: AuthConfig;
  envKey?: string;

  // ── Behavior ──
  rules?: AugmentRules;
  skills: SkillConfig[];
  hooks?: HookDefinition[];
  hookDir?: string;

  // ── Display weight / metadata ──
  baseWeight: number;
  loadedWeight: number;
  /** @deprecated kept for back-compat with legacy reads via the shim. */
  weight?: number;

  // ── Categories ──
  primaryCategory?: string;
  categories?: string[];
  tags?: string[];

  // ── Authoring lifecycle ──
  publishIntent?: boolean;
  /** Set after first publish. Tracks "this local augment is now published as version N." */
  publishedVersion?: number;
  /** Local edits not yet pushed to registry. */
  hasUnpublishedChanges?: boolean;

  // ── Optional augment metadata ──
  homepage?: string;
  repository?: string;
  license?: string;
  authConfig?: Record<string, unknown>;
  postInstallActions?: Record<string, unknown>[];
  platformHints?: Record<string, string>;
  /** Cached MCP server introspection results (opaque). */
  introspection?: Record<string, unknown> | null;

  /**
   * Set when an upstream registry retraction promoted an overlay to a frozen
   * local def (Pkg 02). Preserved so doctor/UI can surface the situation.
   */
  frozen_from_retraction?: {
    name: string;
    retractedAt: string;
    lastSeenContentHash: string;
  };

  /**
   * Sidecar-only timestamp of the most recent explicit user interaction
   * (equip / unequip / save-draft etc.). Strictly local — never serialized
   * into backend-facing payloads. Preserved from the legacy AugmentDef
   * shape via shim synthesis.
   */
  lastUserActionAt?: string;
}

/**
 * Overlay — user-authored modification of a registry augment. Resolver merges
 * overlay-only fields on top of the cached registry content.
 *
 * **Allowlist (per architect 2026-04-28 + user direction same day):**
 *   Overridable: rules, skills, hooks
 *   NON-overridable: everything else (transport/auth → phishing-vector;
 *   flavorText/subtitle/description/categories/tags → publisher brand
 *   metadata stays intact).
 *
 * Pkg 02 implements the typed merge + enforcement; Pkg 01 just defines the
 * schema slot. The `OVERLAY_ALLOWED_FIELDS` const lives in augment-resolver.
 */
export interface OverlayDef extends DefBase {
  kind: "overlay";
  /** Parent augment name — references the registry augment being modded. */
  overlay_of: string;

  // Overridable fields (allowlist per architect + user 2026-04-28):
  rules?: AugmentRules;
  skills?: SkillConfig[];
  hooks?: HookDefinition[];

  /**
   * Sidecar-only timestamp of the most recent explicit user interaction.
   * Same semantics as on LocalDef.
   */
  lastUserActionAt?: string;
}

/**
 * Wrapped — auto-detected from existing platform config (e.g., user already
 * had a Cursor MCP entry for X; equip detects it on first scan and creates a
 * wrapped def). Promotes to local on first user touch (legacy behavior).
 *
 * Same content shape as LocalDef plus `wrappedFrom` provenance.
 */
export interface WrappedDef extends DefBase {
  kind: "wrapped";

  // Same content surface as LocalDef:
  title: string;
  subtitle?: string;
  description: string;
  rarity?: "common" | "uncommon" | "rare" | "epic" | "legendary";
  flavorText?: string;
  transport?: "http" | "stdio";
  serverUrl?: string;
  stdio?: { command: string; args: string[]; envKey?: string };
  requiresAuth: boolean;
  auth?: AuthConfig;
  envKey?: string;
  rules?: AugmentRules;
  skills: SkillConfig[];
  hooks?: HookDefinition[];
  hookDir?: string;
  baseWeight: number;
  loadedWeight: number;
  primaryCategory?: string;
  categories?: string[];
  tags?: string[];
  homepage?: string;
  repository?: string;
  license?: string;

  /** Provenance — required for wrapped kind. */
  wrappedFrom: WrappedFromMeta;

  lastUserActionAt?: string;
}

export type Def = LocalDef | OverlayDef | WrappedDef;

// ─── Paths ──────────────────────────────────────────────────

export function getDefsDir(): string {
  return path.join(getEquipHome(), "defs");
}

function defPath(name: string): string {
  validateToolName(name);
  return path.join(getDefsDir(), `${name}.json`);
}

function ensureDefsDir(): void {
  const dir = getDefsDir();
  if (!fs.existsSync(dir)) {
    // 0700 because overlays can carry user mods to behavioral fields the user
    // considers private. Mirrors the discipline on the legacy augments/ dir.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort; no-op on Windows */ }
  }
}

// ─── CRUD ───────────────────────────────────────────────────

/**
 * Read a def by name. Returns null if the file is missing, corrupt, or
 * unreadable (matching the existing readAugmentDef semantics).
 *
 * Corrupt files are backed up to `<name>.json.corrupt.bak` before the read
 * returns null — same defensive pattern as readAugmentDef.
 */
export function readDef(name: string): Def | null {
  const p = defPath(name);
  const { data, status } = safeReadJsonSync(p);

  if (status === "missing") return null;
  if (status === "corrupt") {
    try { fs.copyFileSync(p, p + ".corrupt.bak"); } catch { /* best effort */ }
    return null;
  }
  if (status === "unreadable" || !data) return null;

  return data as unknown as Def;
}

/**
 * Write a def. Creates the defs directory if needed, writes atomically.
 *
 * **Single-writer rule** — see file header. Production-code callsites for
 * this function are restricted by CI grep test to migrate-storage.ts +
 * bridge publish/retract handlers + (Pkg 02) overlay-write paths.
 */
export function writeDef(def: Def): void {
  ensureDefsDir();
  atomicWriteFileSync(defPath(def.name), JSON.stringify(def, null, 2) + "\n");
}

/**
 * Delete a def. Returns true if the file existed.
 */
export function deleteDef(name: string): boolean {
  const p = defPath(name);
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check existence without parsing.
 */
export function hasDef(name: string): boolean {
  return fs.existsSync(defPath(name));
}

/**
 * List all defs in the store. Skips corrupt files (with .corrupt.bak
 * side-effect from readDef on the bad ones).
 */
export function listDefs(): Def[] {
  ensureDefsDir();
  let files: string[];
  try {
    files = fs.readdirSync(getDefsDir()).filter((f) => f.endsWith(".json") && !f.endsWith(".corrupt.bak"));
  } catch {
    return [];
  }
  const out: Def[] = [];
  for (const file of files) {
    const name = file.replace(/\.json$/, "");
    const def = readDef(name);
    if (def) out.push(def);
  }
  return out;
}
