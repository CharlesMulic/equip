// Cache store — registry snapshot + freshness metadata.
//
// One of three storage primitives in the equip-storage-refactor architecture:
//   - defs-store     (sibling)   — sovereign user content (local/overlay/wrapped)
//   - cache-store    (THIS FILE) — registry snapshot + freshness metadata
//   - installs-store (sibling)   — install metadata only (no content)
//
// **Single-writer rule (CI-pinned):** writes to ~/.equip/cache/<name>.json
// happen only from registry-refresh.ts. The CI grep test in equip-product
// enforces this scope.
//
// File layout: ~/.equip/cache/<name>.json. One file per registry augment
// the user has touched (installed, browsed-to-detail, etc.).
//
// Freshness discipline (TTL gates + ETag conditional refresh) lands in
// Pkg 03. This package (Pkg 01) ships the storage primitive without freshness
// gates — reads are unconditional, writes happen on registry-refresh.

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync, safeReadJsonSync } from "./fs";
import { getEquipHome } from "./equip-home";
import { validateToolName } from "./validation";
import type { RegistryDef } from "./registry";

// ─── Types ──────────────────────────────────────────────────

/**
 * Cached registry content + freshness metadata.
 *
 * Content fields mirror RegistryDef. Freshness metadata fields are local-only
 * (never sent back to the registry).
 */
export interface CachedDef {
  // ── Identity ──
  name: string;

  // ── Freshness metadata (local-only) ──
  /** ISO-8601 timestamp of the last successful fetch. */
  fetchedAt: string;
  /** Server-issued ETag for conditional refresh (Pkg 03). */
  etag?: string;
  /** Server-known content hash for the cached content. */
  contentHash?: string;
  /** Server-known version number. */
  version?: number;
  /**
   * Registry lifecycle status as of the last fetch. One of:
   *   "active" | "retracted" | "pending-review" | "rejected" | "synced-unreviewed"
   * Used by registry-refresh to short-circuit reads on non-public-status augments.
   */
  registryStatus?: "active" | "retracted" | "pending-review" | "rejected" | "synced-unreviewed";
  /** Manual-update signal — server's latest approved hash if newer than `contentHash`. */
  registryLatestContentHash?: string;
  /** Companion to registryLatestContentHash — security advisory bit. */
  registryLatestSecurityAdvisory?: boolean;
  /** Hash algorithm name (defensive — currently always "sha256-v1" or "sha256-v2"). */
  hashAlgorithm?: string;

  // ── Cached registry content (mirrors RegistryDef) ──
  title: string;
  subtitle?: string;
  description: string;
  rarity?: "common" | "uncommon" | "rare" | "epic" | "legendary";
  flavorText?: string;

  installMode?: "direct" | "package";
  installCount?: number;
  verifiedInstallCount?: number;
  activeInstallCount?: number;

  transport?: string;
  serverUrl?: string;
  envKey?: string;
  requiresAuth?: boolean;
  stdioCommand?: string;
  stdioArgs?: string[];
  npmPackage?: string;
  setupCommand?: string;

  rules?: {
    content: string;
    version: string;
    marker: string;
    fileName?: string;
  };
  hooks?: import("./hooks").HookDefinition[];
  hookDir?: string;
  skills?: import("./skills").SkillConfig[];

  platforms?: Record<string, unknown>;
  auth?: import("./auth-engine").AuthConfig;
  postInstall?: import("./registry").PostInstallAction[];
  platformHints?: Record<string, string>;

  baseWeight?: number;
  loadedWeight?: number;

  publisher?: { name: string; slug: string; verified: boolean; avatarUrl?: string };

  homepage?: string;
  repository?: string;
  license?: string;
  categories?: string[];
}

/**
 * Adapter: build a CachedDef from a RegistryDef + freshness metadata. Used
 * by registry-refresh on every successful fetch.
 */
export function cachedFromRegistry(
  reg: RegistryDef,
  freshness: {
    fetchedAt: string;
    etag?: string;
    registryStatus?: CachedDef["registryStatus"];
  },
): CachedDef {
  return {
    name: reg.name,
    fetchedAt: freshness.fetchedAt,
    etag: freshness.etag,
    contentHash: reg.contentHash,
    version: reg.version,
    hashAlgorithm: reg.hashAlgorithm,
    registryStatus: freshness.registryStatus,
    title: reg.title,
    subtitle: reg.subtitle,
    description: reg.description,
    rarity: reg.rarity,
    flavorText: reg.flavorText,
    installMode: reg.installMode,
    installCount: reg.installCount,
    verifiedInstallCount: reg.verifiedInstallCount,
    activeInstallCount: reg.activeInstallCount,
    transport: reg.transport,
    serverUrl: reg.serverUrl,
    envKey: reg.envKey,
    requiresAuth: reg.requiresAuth,
    stdioCommand: reg.stdioCommand,
    stdioArgs: reg.stdioArgs,
    npmPackage: reg.npmPackage,
    setupCommand: reg.setupCommand,
    rules: reg.rules ? { ...reg.rules } : undefined,
    hooks: reg.hooks,
    hookDir: reg.hookDir,
    skills: reg.skills,
    platforms: reg.platforms,
    auth: reg.auth,
    postInstall: reg.postInstall,
    platformHints: reg.platformHints,
    baseWeight: reg.baseWeight,
    loadedWeight: reg.loadedWeight,
    publisher: reg.publisher,
    homepage: reg.homepage,
    repository: reg.repository,
    license: reg.license,
    categories: reg.categories,
  };
}

// ─── Paths ──────────────────────────────────────────────────

export function getCacheDir(): string {
  return path.join(getEquipHome(), "cache");
}

function cachePath(name: string): string {
  validateToolName(name);
  return path.join(getCacheDir(), `${name}.json`);
}

function ensureCacheDir(): void {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
}

// ─── CRUD ───────────────────────────────────────────────────

/** Read a cached registry def by name. Returns null if missing/corrupt. */
export function readCache(name: string): CachedDef | null {
  const p = cachePath(name);
  const { data, status } = safeReadJsonSync(p);

  if (status === "missing") return null;
  if (status === "corrupt") {
    try { fs.copyFileSync(p, p + ".corrupt.bak"); } catch { /* best effort */ }
    return null;
  }
  if (status === "unreadable" || !data) return null;

  return data as unknown as CachedDef;
}

/**
 * Write a cached entry. Creates the cache directory if needed, writes atomically.
 *
 * **Single-writer rule** — see file header. Production-code callsites for
 * this function are restricted by CI grep test to registry-refresh.ts only.
 */
export function writeCache(cached: CachedDef): void {
  ensureCacheDir();
  atomicWriteFileSync(cachePath(cached.name), JSON.stringify(cached, null, 2) + "\n");
}

/**
 * Delete a cached entry. Returns true if the file existed.
 *
 * Used by retraction handling (Pkg 02) when a registry augment is retracted
 * upstream and the cache should be cleared.
 */
export function deleteCache(name: string): boolean {
  const p = cachePath(name);
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Existence check without parsing. */
export function hasCache(name: string): boolean {
  return fs.existsSync(cachePath(name));
}

/** List all cached entries. Skips corrupt files. */
export function listCache(): CachedDef[] {
  ensureCacheDir();
  let files: string[];
  try {
    files = fs.readdirSync(getCacheDir()).filter((f) => f.endsWith(".json") && !f.endsWith(".corrupt.bak"));
  } catch {
    return [];
  }
  const out: CachedDef[] = [];
  for (const file of files) {
    const name = file.replace(/\.json$/, "");
    const cached = readCache(name);
    if (cached) out.push(cached);
  }
  return out;
}
