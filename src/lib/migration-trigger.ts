// Migration trigger — lazy, idempotent, process-scoped.
//
// Called from the legacy public entry points (readAugmentDef, writeAugmentDef,
// readInstallations, writeInstallations, etc.) to ensure the storage migration
// has run before any read/write touches the legacy data. Migration itself is
// gated by ~/.equip/.schema_version so re-firing across processes is also a
// no-op.
//
// Pkg 01 of equip-storage-refactor.

import { migrateStorageIfNeeded } from "./migrate-storage";

let migrated = false;

/**
 * Ensure storage migration has run in this process. Idempotent — safe to
 * call from every public entry point. Failures are logged but not thrown
 * (the legacy stores keep working; new stores just stay un-populated until
 * the next process gives migration another chance).
 */
export function ensureStorageMigrated(): void {
  if (migrated) return;
  migrated = true;
  try {
    migrateStorageIfNeeded();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[equip-storage] migration failed:", e instanceof Error ? e.message : e);
  }
}

/** Test seam — reset the migration-already-attempted flag. */
export function _resetMigrationTriggerForTests(): void {
  migrated = false;
}
