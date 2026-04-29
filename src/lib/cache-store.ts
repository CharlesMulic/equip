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
// **Freshness discipline (Pkg 03):**
//   - **Soft TTL (default 5min):** `readCacheWithFreshness` returns cached
//     content immediately; if older than soft TTL, fires a fire-and-forget
//     refresh callback. Content returned now may be slightly stale; the next
//     read picks up the refresh.
//   - **Hard TTL (default 24h):** `ensureCacheFresh` blocks until refresh
//     completes when fetchedAt is older than hard TTL. Used by install paths
//     to prevent applying stale registry content.
//   - **ETag round-trip (Pkg 01 + 03):** `cachedFromRegistry` captures the
//     server's ETag on every refresh; `registry-refresh.ts` echoes it via
//     `If-None-Match` on the next conditional refresh. 304 responses skip
//     content rewrite.
//   - **No SSE in v1.** TTL + ETag is the architectural baseline; SSE is
//     deferred to ENG-0058 if telemetry warrants.
//   - **Configurable via env vars:** EQUIP_CACHE_SOFT_TTL_MS (default 300_000),
//     EQUIP_CACHE_HARD_TTL_MS (default 86_400_000),
//     EQUIP_CACHE_DISCIPLINE_DISABLED=true → fresh-always (one release escape).

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync, safeReadJsonSync } from "./fs";
import { getEquipHome } from "./equip-home";
import { validateToolName } from "./validation";
import type { RegistryDef } from "./registry";
import { type Counter, noopCounter } from "./telemetry";

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

// ─── Freshness discipline (Pkg 03) ──────────────────────────

const DEFAULT_SOFT_TTL_MS = 300_000;       // 5 minutes
const DEFAULT_HARD_TTL_MS = 86_400_000;    // 24 hours

function parsePositiveInt(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Soft TTL config. Reads EQUIP_CACHE_SOFT_TTL_MS each call (test-friendly). */
export function getSoftTtlMs(): number {
  return parsePositiveInt(process.env.EQUIP_CACHE_SOFT_TTL_MS, DEFAULT_SOFT_TTL_MS);
}

/** Hard TTL config. Reads EQUIP_CACHE_HARD_TTL_MS each call (test-friendly). */
export function getHardTtlMs(): number {
  return parsePositiveInt(process.env.EQUIP_CACHE_HARD_TTL_MS, DEFAULT_HARD_TTL_MS);
}

/** One-release escape hatch — bypasses TTL discipline entirely. */
export function isDisciplineDisabled(): boolean {
  return process.env.EQUIP_CACHE_DISCIPLINE_DISABLED === "true";
}

export type CacheFreshness = "fresh" | "soft-stale" | "hard-stale" | "missing-fetched-at";

/**
 * Classify a cached entry's freshness against the configured TTLs.
 *   - fresh                 — fetchedAt within soft TTL.
 *   - soft-stale            — older than soft TTL but within hard TTL.
 *   - hard-stale            — older than hard TTL.
 *   - missing-fetched-at    — legacy/corrupt entry with no/invalid fetchedAt;
 *                              treated as infinitely stale.
 */
export function classifyFreshness(
  cached: CachedDef,
  options: { now?: number; softTtlMs?: number; hardTtlMs?: number } = {},
): CacheFreshness {
  const now = options.now ?? Date.now();
  const softTtl = options.softTtlMs ?? getSoftTtlMs();
  const hardTtl = options.hardTtlMs ?? getHardTtlMs();

  const fetchedAtMs = Date.parse(cached.fetchedAt);
  if (!Number.isFinite(fetchedAtMs) || fetchedAtMs <= 0) return "missing-fetched-at";

  const ageMs = now - fetchedAtMs;
  if (ageMs > hardTtl) return "hard-stale";
  if (ageMs > softTtl) return "soft-stale";
  return "fresh";
}

export interface ReadWithFreshnessResult {
  cached: CachedDef | null;
  freshness: CacheFreshness | "missing";
  /** True if a background revalidation was kicked off as a result of this read. */
  revalidating: boolean;
}

/**
 * Soft-TTL aware read.
 *
 * Returns the cached entry immediately (no blocking). If the entry exists
 * AND is older than the configured soft TTL, fires `revalidate(name)` as
 * a fire-and-forget background promise. The returned content may be stale
 * by up to `hardTtlMs` (caller's job to gate on hard TTL via `ensureCacheFresh`
 * before applying the content to user state — see install paths).
 *
 * `revalidate` errors are swallowed (logged via Counter). Caller must NOT
 * await this — the function returns synchronously.
 */
export function readCacheWithFreshness(
  name: string,
  options: {
    revalidate?: (name: string) => Promise<unknown>;
    counter?: Counter;
    now?: number;
    softTtlMs?: number;
    hardTtlMs?: number;
  } = {},
): ReadWithFreshnessResult {
  const counter = options.counter ?? noopCounter;
  const cached = readCache(name);

  if (!cached) {
    counter("equip_cache_read_total", { result: "miss" });
    return { cached: null, freshness: "missing", revalidating: false };
  }

  if (isDisciplineDisabled()) {
    counter("equip_cache_read_total", { result: "hit" });
    return { cached, freshness: "fresh", revalidating: false };
  }

  const freshness = classifyFreshness(cached, options);
  let revalidating = false;

  if (freshness !== "fresh" && options.revalidate) {
    revalidating = true;
    counter("equip_cache_read_total", { result: "stale_revalidating" });
    Promise.resolve()
      .then(() => options.revalidate!(name))
      .catch(() => {
        // Async revalidate failure is non-fatal — content already returned to
        // caller. Counter on registry-refresh side records the refresh outcome.
      });
  } else if (freshness === "fresh") {
    counter("equip_cache_read_total", { result: "hit" });
  } else {
    // Stale but no revalidate callback supplied — record as a hit (caller
    // accepted "stale is OK for this read").
    counter("equip_cache_read_total", { result: "hit" });
  }

  return { cached, freshness, revalidating };
}

export type EnsureFreshOutcome =
  | { status: "fresh"; cached: CachedDef }
  | { status: "refreshed"; cached: CachedDef }
  | { status: "missing"; cached: null }
  | { status: "refresh-failed"; cached: CachedDef | null; error: Error };

/**
 * Hard-TTL gate for install paths. Blocks until the cached entry is fresher
 * than the configured hard TTL.
 *
 * Behavior:
 *   - cache fresh (within hard TTL)   → returns immediately, status "fresh".
 *   - cache stale (or missing/invalid fetchedAt) → awaits `refresh(name)`,
 *     re-reads cache, returns status "refreshed" (or "refresh-failed" with
 *     the underlying error and best-effort cached content).
 *   - cache missing entirely AND no refresh callback → returns status "missing".
 *
 * `EQUIP_CACHE_DISCIPLINE_DISABLED=true` skips the gate (treats any cached
 * entry as fresh). Used to revert in an emergency without a redeploy.
 */
export async function ensureCacheFresh(
  name: string,
  refresh: (name: string) => Promise<unknown>,
  options: {
    counter?: Counter;
    now?: number;
    hardTtlMs?: number;
  } = {},
): Promise<EnsureFreshOutcome> {
  const counter = options.counter ?? noopCounter;
  const cached = readCache(name);

  if (isDisciplineDisabled()) {
    if (cached) return { status: "fresh", cached };
    return { status: "missing", cached: null };
  }

  if (cached) {
    const hardTtl = options.hardTtlMs ?? getHardTtlMs();
    const freshness = classifyFreshness(cached, { now: options.now, hardTtlMs: hardTtl, softTtlMs: 0 });
    if (freshness === "fresh" || freshness === "soft-stale") {
      return { status: "fresh", cached };
    }
  }

  counter("equip_cache_install_block_total", { reason: "hard_ttl_expired" });

  try {
    await refresh(name);
  } catch (error) {
    counter("equip_cache_install_block_total", { reason: "fetch_failed" });
    const err = error instanceof Error ? error : new Error(String(error));
    return { status: "refresh-failed", cached, error: err };
  }

  const refreshed = readCache(name);
  if (!refreshed) return { status: "missing", cached: null };
  return { status: "refreshed", cached: refreshed };
}
