import type { ArtifactRecord } from "./installs-store";
import { buildHttpConfig, buildHttpConfigWithAuth, buildStdioConfig, installMcp, uninstallMcp } from "./mcp";
import { readStoredCredential } from "./auth-engine";
import { type RegistryLifecycleStatus } from "./augment-defs";
import { createManualPlatform } from "./platforms";
import { installRules, uninstallRules } from "./rules";
import { installSkill, uninstallSkill } from "./skills";
import type { RegistryDef } from "./registry";
import { validateAgainstRegistry } from "./registry";
// Cleanup B Pkg 06 batch 2a: migrate registry-refresh's RMW writes from the
// legacy writeAugmentDef + writeInstallations path to direct new-store
// writes via store-writers' mutateCache + mutateInstall. The dual-write
// mirror's reverse direction (new → legacy) was never implemented — to
// keep test invariants stable through this migration window, the test
// suite was rewritten in phase 1 (commit eb4a50f) to read from the new
// stores rather than via readAugmentDef.
import { mutateCache, deleteCache, writeCache, mutateInstall, deleteInstall } from "./store-writers";
import { cachedFromRegistry, readCache, type CachedDef } from "./cache-store";
import { readInstall } from "./installs-store";
import { retractRegistryAugment } from "./store-orchestrator";
import { acquireLock } from "./fs";
import { NOOP_LOGGER, type EquipLogger } from "./types";
import { type Counter, noopCounter } from "./telemetry";

export type RefreshAugmentStatus = "skipped" | "match" | "mutated" | "retracted" | "missing-local";
export type RefreshValidationMode =
  | "missing-local"
  | "skipped"
  | "short-circuit"
  | "not-modified"
  | "network-match"
  | "mutated"
  | "retracted";

export interface RefreshAugmentResult {
  name: string;
  status: RefreshAugmentStatus;
  changed: boolean;
  retracted: boolean;
  registryContentHash?: string;
  registryVersionNumber?: number;
  lastValidatedAt?: string;
  validationMode?: RefreshValidationMode;
}

const MUTATION_LOCK_RETRY_MS = 50;
const MUTATION_LOCK_TIMEOUT_MS = 10_000;
const VALIDATION_SHORT_CIRCUIT_MS = 10_000;

interface RecentValidatedSnapshot {
  contentHash: string;
  registryVersionNumber?: number;
  validatedAtMs: number;
}

const recentValidatedSnapshots = new Map<string, RecentValidatedSnapshot>();

function shouldRetryAcquireLock(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Another equip process is running");
}

async function acquireMutationLock(): Promise<() => void> {
  const deadline = Date.now() + MUTATION_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      return acquireLock();
    } catch (error) {
      if (!shouldRetryAcquireLock(error) || Date.now() >= deadline) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, MUTATION_LOCK_RETRY_MS));
    }
  }
}

export async function refreshAugmentFromRegistry(
  name: string,
  options: { logger?: EquipLogger; counter?: Counter } = {},
): Promise<RefreshAugmentResult> {
  const logger = options.logger || NOOP_LOGGER;
  const counter = options.counter || noopCounter;
  const startedAt = Date.now();

  logger.debug("refresh.start", { name });

  let releaseLock: (() => void) | null = null;
  try {
    // Serialize concurrent refreshes against the shared on-disk registry/install
    // state so we don't lose concurrent read-modify-write updates.
    releaseLock = await acquireMutationLock();

    const now = new Date().toISOString();
    // Cleanup B Pkg 06 batch 2a: read from new stores. The cache is the
    // registry-tracking source of truth (registry augments live in cache;
    // modded ones additionally have an overlay in defs/, but refresh only
    // touches cache fields — the overlay stays untouched and the resolver
    // merges them at read time).
    const existingCache = readCache(name);
    const installRecord = readInstall(name);
    // "shouldValidateRegistry" applied to: cache exists (= registry-known
    // augment) OR install record exists. The new InstallRecord shape doesn't
    // carry a `source` discriminator (denormalized fields lived on legacy
    // InstallationRecord); cache-existence IS the registry-known signal.
    const shouldValidateRegistry = !!existingCache || !!installRecord;

    if (!existingCache && !installRecord) {
      clearRecentValidatedSnapshot(name);
      return {
        name,
        status: "missing-local",
        changed: false,
        retracted: false,
        validationMode: "missing-local",
      };
    }

    if (!shouldValidateRegistry) {
      clearRecentValidatedSnapshot(name);
      return {
        name,
        status: "skipped",
        changed: false,
        retracted: false,
        validationMode: "skipped",
      };
    }

    if (isNonPublicRegistryStatus(existingCache?.registryStatus)) {
      clearRecentValidatedSnapshot(name);
      if (existingCache) {
        mutateCache(name, (c) => { c.fetchedAt = now; });
      }

      logger.debug("refresh.skipped", {
        name,
        durationMs: Date.now() - startedAt,
        reason: "non-public-status",
        registryStatus: existingCache?.registryStatus,
      });
      return {
        name,
        status: "skipped",
        changed: false,
        retracted: false,
        registryContentHash: existingCache?.contentHash,
        registryVersionNumber: existingCache?.version,
        lastValidatedAt: now,
        validationMode: "skipped",
      };
    }

    const shortCircuit = getRecentValidatedSnapshotFromCache(name, existingCache);
    if (shortCircuit) {
      const statusChanged = existingCache?.registryStatus !== "active";
      if (existingCache) {
        mutateCache(name, (c) => {
          c.registryStatus = "active";
          c.fetchedAt = now;
        });
      }

      logger.debug("refresh.short-circuit", {
        name,
        durationMs: Date.now() - startedAt,
        windowMs: VALIDATION_SHORT_CIRCUIT_MS,
      });
      return {
        name,
        status: "match",
        changed: statusChanged,
        retracted: false,
        registryContentHash: shortCircuit.contentHash,
        registryVersionNumber: shortCircuit.registryVersionNumber ?? existingCache?.version,
        lastValidatedAt: now,
        validationMode: "short-circuit",
      };
    }

    const validation = await validateAgainstRegistry(name, {
      logger,
      ifNoneMatch: existingCache?.etag,
    });
    if (validation.status === "missing") {
      clearRecentValidatedSnapshot(name);
      if (!shouldTreatNotFoundAsRetractionFromCache(existingCache)) {
        if (existingCache) {
          mutateCache(name, (c) => { c.fetchedAt = now; });
        }

        logger.warn("refresh.skipped", {
          name,
          durationMs: Date.now() - startedAt,
          reason: "ambiguous-not-found",
          registryStatus: existingCache?.registryStatus,
        });
        return {
          name,
          status: "skipped",
          changed: false,
          retracted: false,
          registryContentHash: existingCache?.contentHash,
          registryVersionNumber: existingCache?.version,
          lastValidatedAt: now,
          validationMode: "skipped",
        };
      }

      return await applyRegistryRetraction(name, { logger, now, startedAt });
    }

    if (validation.status === "not-modified") {
      const statusChanged = existingCache?.registryStatus !== "active";
      if (existingCache) {
        mutateCache(name, (c) => {
          c.registryStatus = "active";
          c.fetchedAt = now;
        });
      }

      rememberValidatedSnapshot(
        name,
        existingCache?.contentHash,
        existingCache?.version,
      );
      counter("equip_cache_refresh_total", { result: "304" });
      logger.debug("refresh.match", {
        name,
        durationMs: Date.now() - startedAt,
        validationMode: "not-modified",
      });
      return {
        name,
        status: "match",
        changed: statusChanged,
        retracted: false,
        registryContentHash: existingCache?.contentHash,
        registryVersionNumber: existingCache?.version,
        lastValidatedAt: now,
        validationMode: "not-modified",
      };
    }

    const registryDef = validation.def;

    if (!registryDef.contentHash) {
      clearRecentValidatedSnapshot(name);
      const statusChanged = existingCache?.registryStatus !== "active";
      if (existingCache) {
        mutateCache(name, (c) => {
          c.registryStatus = "active";
          c.etag = undefined;
          c.fetchedAt = now;
        });
      }

      logger.warn("refresh.skipped", {
        name,
        durationMs: Date.now() - startedAt,
        reason: "missing-content-hash",
        registryVersionNumber: registryDef.version,
      });
      return {
        name,
        status: "skipped",
        changed: statusChanged,
        retracted: false,
        registryVersionNumber: registryDef.version,
        lastValidatedAt: now,
        validationMode: "skipped",
      };
    }

    if (isRegistrySnapshotUnchangedFromCache(existingCache, registryDef)) {
      const statusChanged = existingCache?.registryStatus !== "active";
      if (existingCache) {
        mutateCache(name, (c) => {
          c.etag = validation.etag;
          c.registryStatus = "active";
          c.fetchedAt = now;
        });
      }

      rememberValidatedSnapshot(name, registryDef.contentHash, registryDef.version);
      // Server returned 200 + content but content hash matches what we already
      // have locally — count as 200 (network round-trip, unlike the 304 fast path).
      counter("equip_cache_refresh_total", { result: "200" });
      logger.debug("refresh.match", {
        name,
        durationMs: Date.now() - startedAt,
        validationMode: "network-match",
      });
      return {
        name,
        status: "match",
        changed: statusChanged,
        retracted: false,
        registryContentHash: registryDef.contentHash,
        registryVersionNumber: registryDef.version,
        lastValidatedAt: now,
        validationMode: "network-match",
      };
    }

    // Main mutation path: full content update from the registry.
    // Cleanup B Pkg 06 batch 2a: replace `syncFromRegistry + writeAugmentDef`
    // with a direct cache write via `cachedFromRegistry`. The overlay defs/
    // entry (if exists for modded augments) is intentionally untouched — the
    // resolver merges overlay's user mods over cache content at read time,
    // so user mods survive the registry refresh automatically.
    const newCache = cachedFromRegistry(registryDef, {
      fetchedAt: now,
      etag: validation.etag,
      registryStatus: "active",
    });
    writeCache(newCache);
    rememberValidatedSnapshot(name, newCache.contentHash, newCache.version);
    counter("equip_cache_refresh_total", { result: "200" });

    if (installRecord) {
      const updatedArtifacts = rewriteInstalledArtifactsFromCache(name, installRecord, existingCache, newCache, logger);
      mutateInstall(name, (r) => {
        r.updatedAt = now;
        r.artifacts = updatedArtifacts;
      });
    }

    logger.debug("refresh.mutated", {
      name,
      durationMs: Date.now() - startedAt,
      registryContentHash: newCache.contentHash,
      registryVersionNumber: newCache.version,
    });

    return {
      name,
      status: "mutated",
      changed: true,
      retracted: false,
      registryContentHash: newCache.contentHash,
      registryVersionNumber: newCache.version,
      lastValidatedAt: now,
      validationMode: "mutated",
    };
  } catch (error) {
    counter("equip_cache_refresh_total", { result: "error" });
    logger.warn("refresh.error", {
      name,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (releaseLock) {
      releaseLock();
    }
  }
}

export function isNonPublicRegistryStatus(status: RegistryLifecycleStatus | undefined): boolean {
  return status === "pending-review" || status === "rejected" || status === "synced-unreviewed";
}

export async function applyRegistryRetraction(
  name: string,
  options: { logger?: EquipLogger; now?: string; startedAt?: number } = {},
): Promise<RefreshAugmentResult> {
  const logger = options.logger || NOOP_LOGGER;
  const now = options.now || new Date().toISOString();
  const startedAt = options.startedAt ?? Date.now();
  const releaseLock = await acquireMutationLock();
  try {
    clearRecentValidatedSnapshot(name);
    // Cleanup B Pkg 06 batch 2a: read from new stores. Retraction operates
    // on registry-tracked content (cache) + the install record (installs/).
    // The orchestrator at the end handles overlay defs/ for modded augments
    // (frozen-from-retraction promotion).
    const existingCache = readCache(name);
    const installRecord = readInstall(name);

    if (!existingCache && !installRecord) {
      return {
        name,
        status: "missing-local",
        changed: false,
        retracted: false,
        lastValidatedAt: now,
        validationMode: "missing-local",
      };
    }

    if (isNonPublicRegistryStatus(existingCache?.registryStatus)) {
      if (existingCache) {
        mutateCache(name, (c) => { c.fetchedAt = now; });
      }

      logger.debug("refresh.skipped", {
        name,
        durationMs: Date.now() - startedAt,
        reason: "non-public-status",
        registryStatus: existingCache?.registryStatus,
      });
      return {
        name,
        status: "skipped",
        changed: false,
        retracted: false,
        registryContentHash: existingCache?.contentHash,
        registryVersionNumber: existingCache?.version,
        lastValidatedAt: now,
        validationMode: "skipped",
      };
    }

    if (existingCache?.registryStatus === "retracted" && !installRecord) {
      if (existingCache.fetchedAt !== now) {
        mutateCache(name, (c) => { c.fetchedAt = now; });
      }

      return {
        name,
        status: "retracted",
        changed: false,
        retracted: true,
        lastValidatedAt: now,
        validationMode: "retracted",
      };
    }

    if (installRecord) {
      removeInstalledArtifactsFromCache(name, installRecord, existingCache);
      // The orchestrator below also deletes the install record. Mirror it
      // here so the in-flight uninstall is committed before the orchestrator
      // runs (architect's ordering rule: side effects → derived state →
      // durable marker last).
      deleteInstall(name);
    }

    // Cache update: mark retracted with cleared registry-tracking fields
    // (matches the legacy behavior). The orchestrator below may delete the
    // cache entirely for pure-registry augments OR keep it (for modded
    // augments, where the overlay gets promoted to a frozen-LocalDef).
    if (existingCache) {
      mutateCache(name, (c) => {
        c.registryStatus = "retracted";
        c.contentHash = undefined;
        c.etag = undefined;
        c.version = undefined;
        c.fetchedAt = now;
      });
    }

    // Spike Package 01 outcome: the orchestrator handles the cross-store
    // sequence (overlay-promote-to-frozen OR cache-delete) with the
    // architect's ordering rule. Post-Pkg-06-batch-2g (legacy module
    // deletion), the orchestrator is the only retraction surface — the
    // intermediate cache write above gets superseded by the orchestrator's
    // outcome (cache-delete OR overlay-promotion).
    const retractionAction = await retractRegistryAugment(name, { retractedAt: now });
    logger.debug("refresh.retracted", {
      name,
      durationMs: Date.now() - startedAt,
      newStoreAction: retractionAction,
    });
    return {
      name,
      status: "retracted",
      changed: true,
      retracted: true,
      lastValidatedAt: now,
      validationMode: "retracted",
    };
  } finally {
    releaseLock();
  }
}

function rememberValidatedSnapshot(
  name: string,
  contentHash: string | undefined,
  registryVersionNumber?: number,
): void {
  if (!contentHash) {
    recentValidatedSnapshots.delete(name);
    return;
  }

  recentValidatedSnapshots.set(name, {
    contentHash,
    registryVersionNumber,
    validatedAtMs: Date.now(),
  });
}

function clearRecentValidatedSnapshot(name: string): void {
  recentValidatedSnapshots.delete(name);
}

export function resetRefreshValidationStateForTests(): void {
  recentValidatedSnapshots.clear();
}

// Cleanup B Pkg 06 batch 2a: cache-aware variants of the per-augment
// helpers. The legacy AugmentDef-taking variants were removed — the
// migration moves all reads to cache, and after batch 2g augment-defs.ts
// is gone entirely.

function getRecentValidatedSnapshotFromCache(name: string, existingCache: CachedDef | null): RecentValidatedSnapshot | null {
  if (!existingCache?.contentHash || existingCache.registryStatus !== "active") {
    clearRecentValidatedSnapshot(name);
    return null;
  }

  const snapshot = recentValidatedSnapshots.get(name);
  if (!snapshot) {
    return null;
  }

  if (snapshot.contentHash !== existingCache.contentHash) {
    clearRecentValidatedSnapshot(name);
    return null;
  }

  if ((Date.now() - snapshot.validatedAtMs) > VALIDATION_SHORT_CIRCUIT_MS) {
    clearRecentValidatedSnapshot(name);
    return null;
  }

  return snapshot;
}

function shouldTreatNotFoundAsRetractionFromCache(existingCache: CachedDef | null): boolean {
  return existingCache?.registryStatus === "retracted";
}

function isRegistrySnapshotUnchangedFromCache(existingCache: CachedDef | null, registryDef: RegistryDef): boolean {
  return !!existingCache?.contentHash &&
    !!registryDef.contentHash &&
    existingCache.contentHash === registryDef.contentHash;
}

function removeInstalledArtifactsFromCache(
  name: string,
  installRecord: { platforms: string[]; artifacts: Record<string, ArtifactRecord> },
  existingCache: CachedDef | null,
): void {
  for (const platformId of installRecord.platforms || []) {
    const platform = createManualPlatform(platformId);
    const artifacts = installRecord.artifacts[platformId] || {};

    if (artifacts.mcp) {
      uninstallMcp(platform, name);
    }

    if (artifacts.rules) {
      uninstallRules(platform, {
        marker: existingCache?.rules?.marker || name,
        fileName: existingCache?.rules?.fileName,
      });
    }

    for (const skillName of artifacts.skills || []) {
      uninstallSkill(platform, name, skillName);
    }
  }
}

function rewriteInstalledArtifactsFromCache(
  name: string,
  installRecord: { platforms: string[]; artifacts: Record<string, ArtifactRecord> },
  previousCache: CachedDef | null,
  nextCache: CachedDef,
  logger: EquipLogger,
): Record<string, ArtifactRecord> {
  const nextArtifactsByPlatform: Record<string, ArtifactRecord> = {};
  const credential = resolveStoredCredentialFromCache(name, nextCache);
  const nextHasMcp = !!(nextCache.serverUrl || nextCache.stdioCommand);
  const nextSkillNames = new Set((nextCache.skills || []).map((skill) => skill.name));

  for (const platformId of installRecord.platforms || []) {
    const platform = createManualPlatform(platformId);
    const currentArtifacts = installRecord.artifacts[platformId] || {};

    if (currentArtifacts.mcp && !nextHasMcp) {
      uninstallMcp(platform, name);
    }

    if (currentArtifacts.rules && !nextCache.rules) {
      uninstallRules(platform, {
        marker: previousCache?.rules?.marker || name,
        fileName: previousCache?.rules?.fileName,
      });
    }

    for (const skillName of currentArtifacts.skills || []) {
      if (!nextSkillNames.has(skillName)) {
        uninstallSkill(platform, name, skillName);
      }
    }

    if (nextHasMcp) {
      installMcp(platform, name, buildMcpEntryFromCache(nextCache, credential, platformId), {
        serverUrl: nextCache.serverUrl,
        logger,
      });
    }

    if (nextCache.rules) {
      installRules(platform, { ...nextCache.rules, logger });
    }

    for (const skill of nextCache.skills || []) {
      installSkill(platform, name, skill, { logger });
    }

    nextArtifactsByPlatform[platformId] = buildArtifactRecordFromCache(nextCache);
  }

  return nextArtifactsByPlatform;
}

function buildArtifactRecordFromCache(cache: CachedDef): ArtifactRecord {
  return {
    mcp: !!(cache.serverUrl || cache.stdioCommand),
    rules: cache.rules?.version,
    skills: (cache.skills || []).map((skill) => skill.name),
  };
}

function resolveStoredCredentialFromCache(name: string, cache: CachedDef): string | null {
  if (!cache.requiresAuth) return null;
  const credential = readStoredCredential(name);
  return credential?.credential || credential?.oauth?.accessToken || null;
}

function buildMcpEntryFromCache(cache: CachedDef, apiKey: string | null, platformId: string): Record<string, unknown> {
  if (cache.transport === "stdio" && cache.stdioCommand) {
    const env: Record<string, string> = {};
    if (cache.envKey && apiKey) {
      env[cache.envKey] = apiKey;
    }
    return buildStdioConfig(cache.stdioCommand, cache.stdioArgs ?? [], env);
  }

  if (!cache.serverUrl) {
    throw new Error(`Augment "${cache.name}" has no MCP server configuration to refresh`);
  }

  return apiKey
    ? buildHttpConfigWithAuth(cache.serverUrl, apiKey, platformId)
    : buildHttpConfig(cache.serverUrl, platformId);
}
