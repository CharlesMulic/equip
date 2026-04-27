// mtime-keyed checksum cache for skill files.
//
// File at ~/.equip/checksum-cache.json. Each entry maps an absolute file path
// to {mtimeMs, size, sha256}. A cache lookup is a hit only when the file's
// CURRENT (mtime, size) matches the cached tuple byte-for-byte — no rounding,
// no normalization. This protects callers from re-hashing files that haven't
// changed since the last install or verify.
//
// Cache hit tradeoff: trusts that mtime + size together don't lie. A user (or
// adversary) who restores a file from backup or deliberately resets mtime+size
// while changing content can keep the cache in stale state. This is a hygiene
// tradeoff, not a security one — the manifest itself isn't a security boundary
// (see AUGMENT_AUTHORING_ARCHITECTURE.md §21), and the cache strictly inherits
// that posture.
//
// Filesystem precision footgun: FAT32 reports mtime in 2-second resolution;
// some Windows + macOS combos truncate to 1ms. We store `stat.mtimeMs` as
// reported, never normalize. Subsequent `stat.mtimeMs` reads should produce
// the same value on the same filesystem.
//
// Cache invalidation modes (reads):
// - mtimeMs differs → miss; recompute on next access
// - size differs → miss
// - file doesn't exist → miss (and prune if reachable from caller context)
// - cache file corrupt or unreadable → treat as empty cache
//
// Cache invalidation modes (writes):
// - setCachedHash(path, sha) — fresh stat captures current mtime/size
// - pruneCacheEntries([paths]) — explicit removal after delete
// - pruneStaleEntries() — opportunistic cleanup; iterates entries, drops any
//   whose stat fails (file gone)
//
// Concurrency: read-modify-write under the existing equip lock (callers should
// already hold acquireLock — install + uninstall flows do). Failures are
// non-fatal — cache writes that fail just log a debug line.
//
// Zero dependencies beyond node built-ins.

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync, safeReadJsonSync } from "./fs";
import { getEquipHome } from "./equip-home";
import type { EquipLogger } from "./types";
import { NOOP_LOGGER } from "./types";

// ─── Types ──────────────────────────────────────────────────

export interface ChecksumCacheEntry {
  mtimeMs: number;
  size: number;
  sha256: string;
}

export interface ChecksumCache {
  /** Map<absolute file path, entry>. Keys must be canonical absolute paths. */
  entries: Record<string, ChecksumCacheEntry>;
}

// ─── Paths ──────────────────────────────────────────────────

function cachePath(): string { return path.join(getEquipHome(), "checksum-cache.json"); }

// ─── Read / write ───────────────────────────────────────────

function emptyCache(): ChecksumCache {
  return { entries: {} };
}

function readCache(logger: EquipLogger = NOOP_LOGGER): ChecksumCache {
  const { data, status, error } = safeReadJsonSync(cachePath());
  if (status === "missing") return emptyCache();
  if (status !== "ok" || !data) {
    logger.debug("Checksum cache unreadable; treating as empty", { status, error });
    return emptyCache();
  }
  // Best-effort shape sanity. Drop unrecognized data rather than throw.
  const entries = (data as { entries?: unknown }).entries;
  if (!entries || typeof entries !== "object") return emptyCache();
  return { entries: entries as Record<string, ChecksumCacheEntry> };
}

function writeCache(cache: ChecksumCache, logger: EquipLogger = NOOP_LOGGER): void {
  try {
    const dir = getEquipHome();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(cachePath(), JSON.stringify(cache, null, 2) + "\n");
  } catch (e) {
    logger.debug("Checksum cache write failed", { error: (e as Error).message });
  }
}

// ─── API ────────────────────────────────────────────────────

/**
 * Return the cached SHA-256 for a file if (mtime, size) still match disk.
 * Returns null on any of: no cache entry, mtime/size mismatch, stat error.
 *
 * Resolves the path absolutely — callers can pass relative paths if they're
 * sure the working dir matches expectations, but absolute is recommended.
 */
export function getCachedHash(filePath: string, logger: EquipLogger = NOOP_LOGGER): string | null {
  const abs = path.resolve(filePath);
  const cache = readCache(logger);
  const entry = cache.entries[abs];
  if (!entry) return null;
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); }
  catch { return null; }
  if (stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.size) return null;
  return entry.sha256;
}

/**
 * Update or insert a cache entry for a file. Reads stat once to capture
 * current mtime/size — the caller should ensure the file exists at the time
 * of this call (otherwise the entry won't be written and a debug line is
 * logged).
 */
export function setCachedHash(filePath: string, sha256: string, logger: EquipLogger = NOOP_LOGGER): void {
  const abs = path.resolve(filePath);
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); }
  catch (e) {
    logger.debug("Checksum cache set skipped: stat failed", { filePath: abs, error: (e as Error).message });
    return;
  }
  const cache = readCache(logger);
  cache.entries[abs] = { mtimeMs: stat.mtimeMs, size: stat.size, sha256 };
  writeCache(cache, logger);
}

/**
 * Set multiple cache entries in one read/write cycle. Use this after a multi-file
 * install to keep cache writes O(1) instead of O(N).
 */
export function setCachedHashes(
  hashes: { filePath: string; sha256: string }[],
  logger: EquipLogger = NOOP_LOGGER,
): void {
  if (hashes.length === 0) return;
  const cache = readCache(logger);
  for (const { filePath, sha256 } of hashes) {
    const abs = path.resolve(filePath);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); }
    catch (e) {
      logger.debug("Checksum cache set skipped: stat failed", { filePath: abs, error: (e as Error).message });
      continue;
    }
    cache.entries[abs] = { mtimeMs: stat.mtimeMs, size: stat.size, sha256 };
  }
  writeCache(cache, logger);
}

/** Remove cache entries for the given file paths. No-op if not cached. */
export function pruneCacheEntries(filePaths: string[], logger: EquipLogger = NOOP_LOGGER): void {
  if (filePaths.length === 0) return;
  const cache = readCache(logger);
  let changed = false;
  for (const filePath of filePaths) {
    const abs = path.resolve(filePath);
    if (abs in cache.entries) {
      delete cache.entries[abs];
      changed = true;
    }
  }
  if (changed) writeCache(cache, logger);
}

/**
 * Walk the cache and drop entries whose files no longer exist (or whose stat
 * fails). Returns the count of entries pruned. Cheap when most entries are
 * still valid; O(N) stat calls otherwise.
 *
 * Intended for occasional maintenance during reconcile, NOT for every status
 * call. Callers should hold the equip lock.
 */
export function pruneStaleEntries(logger: EquipLogger = NOOP_LOGGER): number {
  const cache = readCache(logger);
  let pruned = 0;
  for (const abs of Object.keys(cache.entries)) {
    try { fs.statSync(abs); }
    catch {
      delete cache.entries[abs];
      pruned++;
    }
  }
  if (pruned > 0) writeCache(cache, logger);
  return pruned;
}

/** Test helper: clear the cache file entirely. Internal use. */
export function _clearCacheFileForTesting(): void {
  try { fs.unlinkSync(cachePath()); } catch { /* not present */ }
}
