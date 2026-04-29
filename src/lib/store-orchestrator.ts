// Cross-store orchestrators for the new three-store architecture
// (defs/cache/installs). Each orchestrator encapsulates an ordered sequence
// of writes that touch multiple stores AND/OR have side effects on
// platform configs.
//
// Architect's ordering rule (spike Package 01 outcome, 2026-04-29):
//   side effects → derived state → durable marker last
//
// This ordering ensures that failure between steps leaves the system
// recoverable: side effects are idempotent (platform config rewrites can
// re-run); derived state is regenerable from the durable marker; the
// durable marker is the source of truth for "did this operation complete?"
//
// Lock domain: L3 (existing `acquireLock` from `fs.ts`). Each orchestrator
// acquires the lock once for the whole sequence — re-entrant within nested
// calls (the per-store writes in `store-writers.ts` also acquire L3 but
// the lock is re-entrant).
//
// Initial orchestrator set (spike Package 01):
//   - retractRegistryAugment(name, options) — handles the registry-side
//     retraction flow: platform-uninstall → installs/ delete → cache/ delete
//     (or overlay-promote-to-frozen-local) → defs/ marker update.
//
// Future orchestrators (Package 02+ as needed):
//   - promoteWrappedToLocal(name)
//   - applyInstall(name, platforms, artifacts)
//   - removeInstall(name, platforms?)

import { acquireLock } from "./fs";
import { readDef, type OverlayDef } from "./defs-store";
import { readCache } from "./cache-store";
import { readInstall } from "./installs-store";
import {
  writeDef,
  deleteDef,
  writeCache,
  deleteCache,
  deleteInstall,
} from "./store-writers";
import type { LocalDef } from "./defs-store";

// ─── Retraction orchestrator ───────────────────────────────────

export type RetractionOutcome =
  | "no-op"
  | "frozen-from-overlay"
  | "cache-deleted"
  | "install-removed";

export interface RetractRegistryAugmentOptions {
  /** Timestamp to stamp on the frozen-from-retraction marker. Defaults to now. */
  retractedAt?: string;
  /**
   * Side-effect callback for platform-config cleanup. Called BEFORE any store
   * mutation. If absent, no platform side effects fire — caller is responsible
   * (e.g., the call site has its own legacy-mode platform-uninstall path
   * during the migration window).
   *
   * Signature: receives the install record (which platforms + artifacts to
   * clean up) and returns when done. Errors propagate — the caller can
   * decide to log + continue or abort the orchestrator.
   */
  removePlatformArtifacts?: (installName: string) => void | Promise<void>;
}

/**
 * Retract a registry augment. Encapsulates the cross-store ordering rule:
 *
 *   1. **Side effects:** call `removePlatformArtifacts` (if provided) to
 *      uninstall MCP/rules/skills from each platform's config files.
 *   2. **Derived state:** delete the install record from `installs/<name>.json`.
 *   3. **Durable marker:** depends on overlay presence:
 *        - **Overlay exists** → promote to frozen-local def (preserves user
 *          mods; cache + overlay deleted; new defs entry with
 *          `frozen_from_retraction` marker).
 *        - **No overlay** → delete cache entry.
 *
 * Idempotent — re-running on already-retracted state is a no-op.
 *
 * Returns the action taken so callers can log/telemetry it. Caller is
 * responsible for any legacy-store mirror writes during the dual-write
 * migration window — this orchestrator only touches the new stores.
 */
export async function retractRegistryAugment(
  name: string,
  options: RetractRegistryAugmentOptions = {},
): Promise<RetractionOutcome> {
  const retractedAt = options.retractedAt ?? new Date().toISOString();
  const releaseLock = acquireLock();
  try {
    // Read current state (read-only, no mutations yet).
    const overlay = readDef(name);
    const cache = readCache(name);
    const install = readInstall(name);

    // Early exit: nothing in the new stores to retract.
    if (!cache && (!overlay || overlay.kind !== "overlay") && !install) {
      return "no-op";
    }

    // STEP 1 — side effects: platform config cleanup. Only fires if there's
    // an install record to drive what to clean up; the callback can be a
    // no-op if the caller has already done it.
    if (install && options.removePlatformArtifacts) {
      await options.removePlatformArtifacts(name);
    }

    // STEP 2 — derived state: install record deletion. Independent of
    // overlay/cache presence; if there's an install record at all, it goes.
    if (install) {
      deleteInstall(name);
    }

    // STEP 3 — durable marker: overlay-promote OR cache-delete.
    if (overlay && overlay.kind === "overlay" && cache) {
      // Promotion: build a frozen LocalDef from cache + overlay's mods,
      // then write defs (overwrites the overlay entry at the same path)
      // and delete the now-superseded cache entry.
      const frozen = freezeFromRetraction(overlay, cache, retractedAt);
      writeDef(frozen);
      deleteCache(name);
      return "frozen-from-overlay";
    }

    if (overlay && overlay.kind === "overlay" && !cache) {
      // Edge case: overlay exists but cache already gone (sweeper race or
      // partial state from a previous run). Best-effort frozen-from-overlay-
      // only with synthesized defaults.
      const frozen = freezeFromOverlayOnly(overlay, retractedAt);
      writeDef(frozen);
      return "frozen-from-overlay";
    }

    if (cache && (!overlay || overlay.kind !== "overlay")) {
      deleteCache(name);
      return cache && install ? "install-removed" : "cache-deleted";
    }

    // Cache absent + no overlay + install was present: the install was the
    // only thing tracking this augment. Already handled in STEP 2.
    if (install && !cache && (!overlay || overlay.kind !== "overlay")) {
      return "install-removed";
    }

    return "no-op";
  } finally {
    releaseLock();
  }
}

// ─── Helpers (extracted from dual-write-mirror.ts; will move there
//     permanently once Package 06 retires the mirror) ────────────────

function freezeFromRetraction(
  overlay: OverlayDef,
  cache: import("./cache-store").CachedDef,
  retractedAt: string,
): LocalDef {
  const now = new Date().toISOString();
  return {
    name: overlay.name,
    kind: "local",
    createdAt: overlay.createdAt,
    updatedAt: now,
    title: cache.title,
    subtitle: cache.subtitle,
    description: cache.description,
    rarity: cache.rarity,
    flavorText: cache.flavorText,
    transport: cache.transport as ("http" | "stdio" | undefined),
    serverUrl: cache.serverUrl,
    stdio: cache.stdioCommand
      ? { command: cache.stdioCommand, args: cache.stdioArgs ?? [], envKey: cache.envKey }
      : undefined,
    envKey: cache.envKey,
    requiresAuth: cache.requiresAuth ?? false,
    auth: cache.auth,
    rules: overlay.rules ?? cache.rules,
    skills: (overlay.skills ?? cache.skills) ?? [],
    hooks: overlay.hooks ?? cache.hooks,
    hookDir: cache.hookDir,
    baseWeight: cache.baseWeight ?? 0,
    loadedWeight: cache.loadedWeight ?? 0,
    categories: cache.categories,
    homepage: cache.homepage,
    repository: cache.repository,
    license: cache.license,
    frozen_from_retraction: {
      name: overlay.name,
      retractedAt,
      lastSeenContentHash: cache.contentHash ?? "",
    },
    lastUserActionAt: overlay.lastUserActionAt,
  };
}

function freezeFromOverlayOnly(overlay: OverlayDef, retractedAt: string): LocalDef {
  const now = new Date().toISOString();
  return {
    name: overlay.name,
    kind: "local",
    createdAt: overlay.createdAt,
    updatedAt: now,
    title: overlay.name,
    description: "",
    requiresAuth: false,
    skills: overlay.skills ?? [],
    hooks: overlay.hooks,
    rules: overlay.rules,
    baseWeight: 0,
    loadedWeight: 0,
    frozen_from_retraction: {
      name: overlay.name,
      retractedAt,
      lastSeenContentHash: "",
    },
    lastUserActionAt: overlay.lastUserActionAt,
  };
}

// ─── Wrapped → Local promotion orchestrator ────────────────────
//
// One-way transition: a `kind: "wrapped"` def becomes `kind: "local"`.
// `mutateDef` rejects kind changes (identity invariant); the orchestrator
// pattern handles the deleteDef + writeDef sequence with proper locking.
//
// Architect note (Pkg 06 batch 2 plan): bridge.ts:augmentPromote needs
// this orchestrator post-Pkg-06-batch-2g (when augment-defs.ts's
// promoteWrappedToLocal disappears). Lands in batch 2c so the bridge
// migration has it available.
//
// Idempotent: if the def is already local (or doesn't exist), returns
// the existing state without mutation.

export type PromoteOutcome = "promoted" | "already-local" | "not-found";

export interface PromoteResult {
  outcome: PromoteOutcome;
  /** The post-operation def (LocalDef on success/already-local; null on not-found). */
  def: LocalDef | null;
}

/**
 * Promote a wrapped augment to local. Preserves all content + provenance
 * (`wrappedFrom` carries through as historical context). Sovereign content
 * is written first; the wrapped marker is removed atomically via the
 * delete-then-write sequence.
 */
export function promoteWrappedToLocal(name: string): PromoteResult {
  const releaseLock = acquireLock();
  try {
    const existing = readDef(name);
    if (!existing) {
      return { outcome: "not-found", def: null };
    }
    if (existing.kind === "local") {
      return { outcome: "already-local", def: existing };
    }
    if (existing.kind !== "wrapped") {
      // overlay → can't promote (overlay is conceptually a registry-augment
      // mod, not a wrapped one). Treat as not-found from the promotion API's
      // perspective; caller should error.
      return { outcome: "not-found", def: null };
    }
    const now = new Date().toISOString();
    const promoted: LocalDef = {
      name: existing.name,
      kind: "local",
      createdAt: existing.createdAt,
      updatedAt: now,
      title: existing.title,
      subtitle: existing.subtitle,
      description: existing.description,
      rarity: existing.rarity,
      flavorText: existing.flavorText,
      transport: existing.transport,
      serverUrl: existing.serverUrl,
      stdio: existing.stdio,
      envKey: existing.envKey,
      requiresAuth: existing.requiresAuth,
      auth: existing.auth,
      rules: existing.rules,
      skills: existing.skills,
      hooks: existing.hooks,
      hookDir: existing.hookDir,
      baseWeight: existing.baseWeight,
      loadedWeight: existing.loadedWeight,
      primaryCategory: existing.primaryCategory,
      categories: existing.categories,
      tags: existing.tags,
      homepage: existing.homepage,
      repository: existing.repository,
      license: existing.license,
      lastUserActionAt: existing.lastUserActionAt,
    };
    // delete + write — mutateDef rejects kind changes, so use the raw
    // sequence with the lock held for atomicity.
    deleteDef(name);
    writeDef(promoted);
    return { outcome: "promoted", def: promoted };
  } finally {
    releaseLock();
  }
}
