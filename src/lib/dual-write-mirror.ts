// Dual-write mirror — keeps the new three-store layout in sync with legacy
// writes during Pkg 01.
//
// Strategy: legacy `~/.equip/augments/<name>.json` and `~/.equip/installations.json`
// remain authoritative for reads in Pkg 01. Every legacy write is mirrored
// here into the appropriate new store(s). Pkgs 02-04 switch reads to the
// resolver organically; once all consumers migrate, the legacy stores can
// be deleted in a final cleanup commit and these mirror calls become
// vestigial (and themselves get deleted alongside the legacy modules).
//
// **Single-writer rule scope:** the mirror functions are the ONLY writers
// to defs-store / cache-store / installs-store called from the legacy
// `augment-defs.ts` + `installations.ts` modules. Direct writes from
// elsewhere are forbidden by the CI grep test.

import { readDef, writeDef, deleteDef, type LocalDef, type OverlayDef, type WrappedDef } from "./defs-store";
import { readCache, writeCache, deleteCache, type CachedDef } from "./cache-store";
import { writeInstall, deleteInstall, type InstallRecord, type ArtifactRecord } from "./installs-store";
import type { AugmentDef } from "./augment-defs";
import type { InstallationRecord } from "./installations";

/**
 * Mirror a legacy `writeAugmentDef(def)` write into the appropriate new
 * store(s). Routes by the legacy `source` + `modded` discriminator:
 *
 *   - source=local            → defs/<name>.json (kind=local)
 *   - source=wrapped          → defs/<name>.json (kind=wrapped)
 *   - source=registry, !modded → cache/<name>.json
 *   - source=registry, modded  → defs/<name>.json (kind=overlay) + cache/<name>.json (upstream)
 *
 * Failures are logged but not thrown (legacy write already succeeded by
 * the time mirror is called; new stores are best-effort sync until Pkgs
 * 02-04 make them authoritative).
 */
export function mirrorWriteAugmentDef(def: AugmentDef): void {
  try {
    if (def.source === "local") {
      writeDef(legacyToLocalDef(def));
    } else if (def.source === "wrapped") {
      writeDef(legacyToWrappedDef(def));
    } else if (def.source === "registry") {
      writeCache(legacyRegistryToCache(def));
      if (def.modded === true) {
        writeDef(legacyToOverlayDef(def));
      } else {
        // If a previous overlay existed but the augment is now unmodded,
        // remove the stale overlay entry. Best-effort.
        try { deleteDef(def.name); } catch { /* no-op */ }
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[equip-storage] dual-write mirror failed for "${def.name}":`, e instanceof Error ? e.message : e);
  }
}

/**
 * Mirror a legacy `deleteAugmentDef(name)` into the new stores. Removes
 * defs entry + cache entry. Install records survive — they're independent
 * of content.
 */
export function mirrorDeleteAugmentDef(name: string): void {
  try {
    deleteDef(name);
    deleteCache(name);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[equip-storage] dual-write delete-mirror failed for "${name}":`, e instanceof Error ? e.message : e);
  }
}

/**
 * Mirror writes to `~/.equip/installations.json` into per-augment installs/
 * entries. The legacy `installations.json` file holds many augments under
 * one `augments` map; we fan that out into one file per augment.
 */
export function mirrorWriteInstallations(installations: { augments: Record<string, InstallationRecord> }): void {
  try {
    for (const [name, inst] of Object.entries(installations.augments)) {
      writeInstall(installFromLegacy(name, inst));
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[equip-storage] dual-write installations-mirror failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Mirror an installation removal — deletes the per-augment install record.
 */
export function mirrorRemoveInstallation(name: string): void {
  try {
    deleteInstall(name);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[equip-storage] dual-write install-delete-mirror failed for "${name}":`, e instanceof Error ? e.message : e);
  }
}

/**
 * Pkg 02: handle a registry retraction in the new three-store layout.
 *
 * When the registry signals an augment is retracted (404/410 from
 * `validateAgainstRegistry`), this routes the deletion based on whether the
 * user has an active overlay (their personal mod):
 *
 *   - **Overlay exists** → silent promotion to a frozen `kind: "local"` def.
 *     Cache content + overlay's overridable fields (rules/skills/hooks) are
 *     merged into a sovereign LocalDef with a `frozen_from_retraction`
 *     marker. Cache + overlay entries deleted. The user's mods survive
 *     upstream retraction; doctor / UI surface the situation via the marker.
 *
 *   - **No overlay** → cache deleted (the augment is gone — there's no user
 *     content to preserve). Existing legacy retraction flow handles the
 *     installation cleanup separately.
 *
 * Idempotent — re-firing this on an already-frozen / already-deleted state
 * is a no-op. Returns the action taken for ops + telemetry.
 */
export type RetractionAction = "frozen-from-overlay" | "cache-deleted" | "no-op";

export function mirrorRetractFromRegistry(
  name: string,
  retractedAt: string = new Date().toISOString(),
): RetractionAction {
  try {
    const overlay = readDef(name);
    const cache = readCache(name);

    // No-op: nothing in the new stores to retract.
    if (!cache && (!overlay || overlay.kind !== "overlay")) {
      return "no-op";
    }

    if (overlay && overlay.kind === "overlay" && cache) {
      // Promotion: merge cache content with overlay's overridable fields,
      // write as a frozen LocalDef, then delete cache + overlay.
      const frozen = freezeFromRetraction(overlay, cache, retractedAt);
      writeDef(frozen);
      deleteCache(name);
      // Overlay entry is superseded by the frozen LocalDef (same path
      // ~/.equip/defs/<name>.json). The writeDef above overwrites it.
      return "frozen-from-overlay";
    }

    if (overlay && overlay.kind === "overlay" && !cache) {
      // Edge case: overlay exists but cache was already gone (sweeper race?
      // partial state from a previous run?). Best-effort: write a frozen
      // LocalDef from overlay-only content with whatever defaults we can
      // synthesize, so the user's mods aren't silently dropped.
      const frozen = freezeFromOverlayOnly(overlay, retractedAt);
      writeDef(frozen);
      return "frozen-from-overlay";
    }

    // Cache exists, no overlay → just delete cache. The augment was pure
    // registry, the user has no personal content to preserve.
    if (cache && (!overlay || overlay.kind !== "overlay")) {
      deleteCache(name);
      return "cache-deleted";
    }

    return "no-op";
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[equip-storage] retraction-mirror failed for "${name}":`, e instanceof Error ? e.message : e);
    return "no-op";
  }
}

/**
 * Build a frozen LocalDef from an active overlay + last-known cache. Cache
 * provides identity + infrastructure (publisher's brand metadata + transport
 * the user trusted at install time); overlay provides the user's mods on
 * the typed allowlist (rules/skills/hooks).
 */
function freezeFromRetraction(
  overlay: OverlayDef,
  cache: CachedDef,
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
    // Overlay's mods take precedence on the allowlist; fall back to cache.
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

/**
 * Edge-case freezer when cache is already gone. Synthesizes a minimal
 * LocalDef from overlay-only content. UI/doctor surfaces this with extra
 * caveats since we don't have the original publisher's transport/auth/etc.
 */
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

// ─── Legacy → new shape conversions ───────────────────────
// (Mirrors the migrate-storage adapters; intentionally duplicated rather
//  than imported because the two modules have different lifecycles —
//  migrate runs once at startup; mirror runs on every legacy write.)

function legacyToLocalDef(d: AugmentDef): LocalDef {
  return {
    name: d.name,
    kind: "local",
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    title: d.title,
    subtitle: d.subtitle,
    description: d.description,
    rarity: d.rarity,
    flavorText: d.flavorText,
    transport: d.transport,
    serverUrl: d.serverUrl,
    stdio: d.stdio,
    requiresAuth: d.requiresAuth,
    auth: d.auth,
    envKey: d.envKey,
    rules: d.rules,
    skills: d.skills,
    hooks: d.hooks,
    hookDir: d.hookDir,
    baseWeight: d.baseWeight,
    loadedWeight: d.loadedWeight,
    weight: d.weight,
    primaryCategory: (d as AugmentDef & { primaryCategory?: string }).primaryCategory,
    categories: d.categories,
    tags: (d as AugmentDef & { tags?: string[] }).tags,
    publishIntent: d.publishIntent,
    publishedVersion: d.publishedVersion,
    hasUnpublishedChanges: d.hasUnpublishedChanges,
    homepage: d.homepage,
    repository: d.repository,
    license: d.license,
    authConfig: d.authConfig,
    postInstallActions: d.postInstallActions,
    platformHints: d.platformHints,
    introspection: d.introspection,
    lastUserActionAt: d.lastUserActionAt,
  };
}

function legacyToWrappedDef(d: AugmentDef): WrappedDef {
  const wrappedFrom = typeof d.wrappedFrom === "string"
    ? { type: "mcp" as const, platform: d.wrappedFrom }
    : (d.wrappedFrom ?? { type: "mcp" as const, platform: "unknown" });

  return {
    name: d.name,
    kind: "wrapped",
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    title: d.title,
    subtitle: d.subtitle,
    description: d.description,
    rarity: d.rarity,
    flavorText: d.flavorText,
    transport: d.transport,
    serverUrl: d.serverUrl,
    stdio: d.stdio,
    requiresAuth: d.requiresAuth,
    auth: d.auth,
    envKey: d.envKey,
    rules: d.rules,
    skills: d.skills,
    hooks: d.hooks,
    hookDir: d.hookDir,
    baseWeight: d.baseWeight,
    loadedWeight: d.loadedWeight,
    primaryCategory: (d as AugmentDef & { primaryCategory?: string }).primaryCategory,
    categories: d.categories,
    tags: (d as AugmentDef & { tags?: string[] }).tags,
    homepage: d.homepage,
    repository: d.repository,
    license: d.license,
    wrappedFrom,
    lastUserActionAt: d.lastUserActionAt,
  };
}

function legacyToOverlayDef(d: AugmentDef): OverlayDef {
  // Modded registry augment: overlay holds the user's edits per the typed
  // allowlist (rules / skills / hooks). flavorText + display fields stay on
  // cache (publisher brand metadata, not overridable).
  const overlay: OverlayDef = {
    name: d.name,
    kind: "overlay",
    overlay_of: d.name,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    lastUserActionAt: d.lastUserActionAt,
  };
  if (d.rules) overlay.rules = d.rules;
  if (d.moddedFields?.includes("skills") && d.skills) overlay.skills = d.skills;
  if (d.moddedFields?.includes("hooks") && d.hooks) overlay.hooks = d.hooks;
  return overlay;
}

function legacyRegistryToCache(d: AugmentDef): CachedDef {
  // For modded augments, prefer rulesUpstream as cache content; for unmodded,
  // current d.rules IS the upstream snapshot.
  const cacheRules = d.modded ? (d.rulesUpstream ?? d.rules) : d.rules;
  return {
    name: d.name,
    fetchedAt: d.lastValidatedAt ?? d.syncedAt ?? d.updatedAt,
    etag: d.registryEtag,
    contentHash: d.registryContentHash,
    version: d.registryVersionNumber,
    registryStatus: d.registryStatus,
    registryLatestContentHash: d.registryLatestContentHash,
    registryLatestSecurityAdvisory: d.registryLatestSecurityAdvisory,
    title: d.title,
    subtitle: d.subtitle,
    description: d.description,
    rarity: d.rarity,
    flavorText: d.flavorText,
    installCount: d.installCount,
    transport: d.transport,
    serverUrl: d.serverUrl,
    envKey: d.envKey,
    requiresAuth: d.requiresAuth,
    stdioCommand: d.stdio?.command,
    stdioArgs: d.stdio?.args,
    rules: cacheRules,
    hooks: d.hooks,
    hookDir: d.hookDir,
    skills: d.skills,
    auth: d.auth,
    homepage: d.homepage,
    repository: d.repository,
    license: d.license,
    categories: d.categories,
    publisher: d.publisher
      ? { name: d.publisher.name, slug: d.publisher.slug, verified: d.publisher.verified, avatarUrl: d.publisher.avatarUrl ?? undefined }
      : undefined,
  };
}

function installFromLegacy(name: string, inst: InstallationRecord): InstallRecord {
  return {
    name,
    installedAt: inst.installedAt,
    updatedAt: inst.updatedAt,
    platforms: inst.platforms,
    artifacts: inst.artifacts as Record<string, ArtifactRecord>,
  };
}
