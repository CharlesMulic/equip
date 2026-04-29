// Per-store free-function write API for the new three-store architecture
// (defs/cache/installs). The exported functions are the ONLY production
// callers of `defs-store.ts` / `cache-store.ts` / `installs-store.ts`'s
// write methods after Cleanup B's migration completes.
//
// Architecture note (spike Package 01 outcome, 2026-04-29):
//   - These functions are the structural enforcement of the single-writer
//     rule (Candidate 1 fold-in). The CI grep test in
//     `test/storage-store-writer-scope.test.js` becomes belt-and-suspenders.
//   - Cross-store ordering (e.g., retractRegistryAugment) lives in
//     `store-orchestrator.ts`, which calls these per-store functions.
//   - Lock domain: L3 (existing `acquireLock` from `fs.ts`). Per-augment
//     L2 deferred until contention surfaces.
//
// During the dual-write era (Packages 02-05): each write here mirrors to
// the legacy `~/.equip/augments/<name>.json` + `~/.equip/installations.json`
// via the existing `dual-write-mirror.ts` running in REVERSE direction —
// i.e., new-store write triggers a mirror to legacy. Package 06 deletes
// the mirror + legacy modules.

import {
  writeDef as defsStoreWriteDef,
  deleteDef as defsStoreDeleteDef,
  readDef,
  type Def,
  type LocalDef,
  type OverlayDef,
  type WrappedDef,
} from "./defs-store";
import {
  writeCache as cacheStoreWriteCache,
  deleteCache as cacheStoreDeleteCache,
  readCache,
  type CachedDef,
} from "./cache-store";
import {
  writeInstall as installsStoreWriteInstall,
  deleteInstall as installsStoreDeleteInstall,
  readInstall,
  type InstallRecord,
} from "./installs-store";
import { acquireLock } from "./fs";

// ─── Lock acquisition (L3 — process-wide, re-entrant) ──────────
//
// Re-uses the existing `acquireLock` from `fs.ts:72-130`. Re-entrant within
// a single process — nested mutations within one operation share the lock.
// Cross-process safety: the lock file (`~/.equip/.lock`) prevents a
// concurrent CLI invocation from racing on the same files.

function withLock<T>(fn: () => T): T {
  const releaseLock = acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

// ─── defs/ store writes ────────────────────────────────────────

/**
 * Write a def (LocalDef | OverlayDef | WrappedDef) to `~/.equip/defs/<name>.json`.
 * Atomic per-file write. Mirrors to legacy via the dual-write-mirror until
 * Cleanup B's Package 06 deletes the mirror.
 */
export function writeDef(def: Def): void {
  withLock(() => {
    defsStoreWriteDef(def);
  });
}

/**
 * Delete a def. Returns true if the file existed before deletion.
 */
export function deleteDef(name: string): boolean {
  return withLock(() => defsStoreDeleteDef(name));
}

/**
 * Read-modify-write helper for the def store. Loads the def by name, applies
 * the mutator, writes back. Throws if the def doesn't exist OR if the mutator
 * changes def.kind / def.name (those would break downstream invariants).
 *
 * The mutator receives the def by reference and mutates in place; the
 * returned value is ignored (use early-return + the pre-mutation snapshot
 * if you need to short-circuit without writing).
 */
export function mutateDef<K extends Def["kind"]>(
  name: string,
  mutator: (def: Def & { kind: K }) => void,
): Def {
  return withLock(() => {
    const def = readDef(name);
    if (!def) throw new Error(`mutateDef: no def found for "${name}"`);
    const originalKind = def.kind;
    const originalName = def.name;
    mutator(def as Def & { kind: K });
    if (def.kind !== originalKind) {
      throw new Error(
        `mutateDef: mutator changed def.kind for "${name}" (${originalKind} → ${def.kind}); use deleteDef + writeDef for kind transitions`,
      );
    }
    if (def.name !== originalName) {
      throw new Error(
        `mutateDef: mutator changed def.name (${originalName} → ${def.name}); name is identity, do not mutate`,
      );
    }
    defsStoreWriteDef(def);
    return def;
  });
}

// ─── cache/ store writes ───────────────────────────────────────

/**
 * Write a registry-cache entry. Atomic per-file write + freshness metadata
 * is part of the entry shape (fetchedAt, etag, etc.).
 */
export function writeCache(cached: CachedDef): void {
  withLock(() => {
    cacheStoreWriteCache(cached);
  });
}

/**
 * Delete a cache entry. Returns true if the file existed before deletion.
 * Used by retraction handling (registry says the augment is gone upstream).
 */
export function deleteCache(name: string): boolean {
  return withLock(() => cacheStoreDeleteCache(name));
}

/**
 * Read-modify-write helper for cache (less common than mutateDef — cache is
 * usually replaced wholesale by a registry refresh, not mutated piecemeal).
 */
export function mutateCache(
  name: string,
  mutator: (cached: CachedDef) => void,
): CachedDef {
  return withLock(() => {
    const cached = readCache(name);
    if (!cached) throw new Error(`mutateCache: no cache entry found for "${name}"`);
    const originalName = cached.name;
    mutator(cached);
    if (cached.name !== originalName) {
      throw new Error(`mutateCache: mutator changed cached.name; identity is immutable`);
    }
    cacheStoreWriteCache(cached);
    return cached;
  });
}

// ─── installs/ store writes ────────────────────────────────────

/**
 * Write an install record (or replace if present). Atomic per-file write.
 */
export function writeInstall(record: InstallRecord): void {
  withLock(() => {
    installsStoreWriteInstall(record);
  });
}

/**
 * Delete an install record. Returns true if the file existed before deletion.
 */
export function deleteInstall(name: string): boolean {
  return withLock(() => installsStoreDeleteInstall(name));
}

/**
 * Read-modify-write helper for an install record.
 */
export function mutateInstall(
  name: string,
  mutator: (record: InstallRecord) => void,
): InstallRecord {
  return withLock(() => {
    const record = readInstall(name);
    if (!record) throw new Error(`mutateInstall: no install record found for "${name}"`);
    const originalName = record.name;
    mutator(record);
    if (record.name !== originalName) {
      throw new Error(`mutateInstall: mutator changed record.name; identity is immutable`);
    }
    installsStoreWriteInstall(record);
    return record;
  });
}

// ─── Re-exports for narrow type/shape consumption by callers ───

export type { Def, LocalDef, OverlayDef, WrappedDef, CachedDef, InstallRecord };
