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

import { writeDef, deleteDef, type LocalDef, type OverlayDef, type WrappedDef } from "./defs-store";
import { writeCache, deleteCache, type CachedDef } from "./cache-store";
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
