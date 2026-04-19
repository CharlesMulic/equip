import type { ArtifactRecord, InstallationRecord } from "./installations";
import { readInstallations, writeInstallations } from "./installations";
import { buildHttpConfig, buildHttpConfigWithAuth, buildStdioConfig, installMcp, uninstallMcp } from "./mcp";
import { readStoredCredential } from "./auth-engine";
import {
  readAugmentDef,
  syncFromRegistry,
  writeAugmentDef,
  type AugmentDef,
  type RegistryLifecycleStatus,
} from "./augment-defs";
import { createManualPlatform } from "./platforms";
import { installRules, uninstallRules } from "./rules";
import { installSkill, uninstallSkill } from "./skills";
import type { RegistryDef } from "./registry";
import { validateAgainstRegistry } from "./registry";
import { acquireLock } from "./fs";
import { NOOP_LOGGER, type EquipLogger } from "./types";

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
  options: { logger?: EquipLogger } = {},
): Promise<RefreshAugmentResult> {
  const logger = options.logger || NOOP_LOGGER;
  const startedAt = Date.now();

  logger.debug("refresh.start", { name });

  let releaseLock: (() => void) | null = null;
  try {
    // Serialize daemon and one-shot sidecar mutations against the shared on-disk
    // registry/install state so we don't lose concurrent read-modify-write updates.
    releaseLock = await acquireMutationLock();

    const now = new Date().toISOString();
    const existingDef = readAugmentDef(name);
    const installations = readInstallations();
    const installRecord = installations.augments[name];
    const shouldValidateRegistry = existingDef?.source === "registry" || installRecord?.source === "registry";

    if (!existingDef && !installRecord) {
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

    if (isNonPublicRegistryStatus(existingDef?.registryStatus)) {
      clearRecentValidatedSnapshot(name);
      if (existingDef) {
        existingDef.lastValidatedAt = now;
        writeAugmentDef(existingDef);
      }

      logger.debug("refresh.skipped", {
        name,
        durationMs: Date.now() - startedAt,
        reason: "non-public-status",
        registryStatus: existingDef?.registryStatus,
      });
      return {
        name,
        status: "skipped",
        changed: false,
        retracted: false,
        registryContentHash: existingDef?.registryContentHash,
        registryVersionNumber: existingDef?.registryVersionNumber,
        lastValidatedAt: now,
        validationMode: "skipped",
      };
    }

    const shortCircuit = getRecentValidatedSnapshot(name, existingDef);
    if (shortCircuit) {
      const statusChanged = existingDef?.registryStatus !== "active";
      if (existingDef) {
        existingDef.registryStatus = "active";
        existingDef.lastValidatedAt = now;
        writeAugmentDef(existingDef);
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
        registryVersionNumber: shortCircuit.registryVersionNumber ?? existingDef?.registryVersionNumber,
        lastValidatedAt: now,
        validationMode: "short-circuit",
      };
    }

    const validation = await validateAgainstRegistry(name, {
      logger,
      ifNoneMatch: existingDef?.registryEtag,
    });
    if (validation.status === "missing") {
      clearRecentValidatedSnapshot(name);
      if (!shouldTreatNotFoundAsRetraction(existingDef)) {
        if (existingDef) {
          existingDef.lastValidatedAt = now;
          writeAugmentDef(existingDef);
        }

        logger.warn("refresh.skipped", {
          name,
          durationMs: Date.now() - startedAt,
          reason: "ambiguous-not-found",
          registryStatus: existingDef?.registryStatus,
        });
        return {
          name,
          status: "skipped",
          changed: false,
          retracted: false,
          registryContentHash: existingDef?.registryContentHash,
          registryVersionNumber: existingDef?.registryVersionNumber,
          lastValidatedAt: now,
          validationMode: "skipped",
        };
      }

      return await applyRegistryRetraction(name, { logger, now, startedAt });
    }

    if (validation.status === "not-modified") {
      const statusChanged = existingDef?.registryStatus !== "active";
      if (existingDef) {
        existingDef.registryStatus = "active";
        existingDef.lastValidatedAt = now;
        writeAugmentDef(existingDef);
      }

      rememberValidatedSnapshot(
        name,
        existingDef?.registryContentHash,
        existingDef?.registryVersionNumber,
      );
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
        registryContentHash: existingDef?.registryContentHash,
        registryVersionNumber: existingDef?.registryVersionNumber,
        lastValidatedAt: now,
        validationMode: "not-modified",
      };
    }

    const registryDef = validation.def;

    if (!registryDef.contentHash) {
      clearRecentValidatedSnapshot(name);
      const statusChanged = existingDef?.registryStatus !== "active";
      if (existingDef) {
        existingDef.registryStatus = "active";
        existingDef.registryEtag = undefined;
        existingDef.lastValidatedAt = now;
        writeAugmentDef(existingDef);
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

    if (isRegistrySnapshotUnchanged(existingDef, registryDef)) {
      const statusChanged = existingDef?.registryStatus !== "active";
      if (existingDef) {
        existingDef.registryEtag = validation.etag;
        existingDef.registryStatus = "active";
        existingDef.lastValidatedAt = now;
        writeAugmentDef(existingDef);
      }

      rememberValidatedSnapshot(name, registryDef.contentHash, registryDef.version);
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

    const nextDef = syncFromRegistry(registryDef);
    nextDef.registryEtag = validation.etag;
    nextDef.registryStatus = "active";
    nextDef.lastValidatedAt = now;
    nextDef.updatedAt = now;
    writeAugmentDef(nextDef);
    rememberValidatedSnapshot(name, nextDef.registryContentHash, nextDef.registryVersionNumber);

    if (installRecord) {
      const updatedArtifacts = rewriteInstalledArtifacts(name, installRecord, existingDef, nextDef, logger);
      installations.augments[name] = {
        ...installRecord,
        source: nextDef.source,
        title: nextDef.title || name,
        transport: nextDef.transport || installRecord.transport,
        serverUrl: nextDef.serverUrl,
        updatedAt: now,
        artifacts: updatedArtifacts,
      };
      installations.lastUpdated = now;
      writeInstallations(installations);
    }

    logger.debug("refresh.mutated", {
      name,
      durationMs: Date.now() - startedAt,
      registryContentHash: nextDef.registryContentHash,
      registryVersionNumber: nextDef.registryVersionNumber,
    });

    return {
      name,
      status: "mutated",
      changed: true,
      retracted: false,
      registryContentHash: nextDef.registryContentHash,
      registryVersionNumber: nextDef.registryVersionNumber,
      lastValidatedAt: now,
      validationMode: "mutated",
    };
  } catch (error) {
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

function isRegistrySnapshotUnchanged(existingDef: AugmentDef | null, registryDef: RegistryDef): boolean {
  return !!existingDef?.registryContentHash &&
    !!registryDef.contentHash &&
    existingDef.registryContentHash === registryDef.contentHash;
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
    const existingDef = readAugmentDef(name);
    const installations = readInstallations();
    const installRecord = installations.augments[name];

    if (!existingDef && !installRecord) {
      return {
        name,
        status: "missing-local",
        changed: false,
        retracted: false,
        lastValidatedAt: now,
        validationMode: "missing-local",
      };
    }

    if (isNonPublicRegistryStatus(existingDef?.registryStatus)) {
      if (existingDef) {
        existingDef.lastValidatedAt = now;
        writeAugmentDef(existingDef);
      }

      logger.debug("refresh.skipped", {
        name,
        durationMs: Date.now() - startedAt,
        reason: "non-public-status",
        registryStatus: existingDef?.registryStatus,
      });
      return {
        name,
        status: "skipped",
        changed: false,
        retracted: false,
        registryContentHash: existingDef?.registryContentHash,
        registryVersionNumber: existingDef?.registryVersionNumber,
        lastValidatedAt: now,
        validationMode: "skipped",
      };
    }

    if (existingDef?.registryStatus === "retracted" && !installRecord) {
      if (existingDef.lastValidatedAt !== now) {
        existingDef.lastValidatedAt = now;
        writeAugmentDef(existingDef);
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
      removeInstalledArtifacts(name, installRecord, existingDef);
      delete installations.augments[name];
      installations.lastUpdated = now;
      writeInstallations(installations);
    }

    if (existingDef) {
      existingDef.registryStatus = "retracted";
      existingDef.registryContentHash = undefined;
      existingDef.registryEtag = undefined;
      existingDef.registryVersionNumber = undefined;
      existingDef.lastValidatedAt = now;
      existingDef.updatedAt = now;
      writeAugmentDef(existingDef);
    }

    logger.debug("refresh.retracted", { name, durationMs: Date.now() - startedAt });
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

function getRecentValidatedSnapshot(name: string, existingDef: AugmentDef | null): RecentValidatedSnapshot | null {
  if (!existingDef?.registryContentHash || existingDef.registryStatus !== "active") {
    clearRecentValidatedSnapshot(name);
    return null;
  }

  const snapshot = recentValidatedSnapshots.get(name);
  if (!snapshot) {
    return null;
  }

  if (snapshot.contentHash !== existingDef.registryContentHash) {
    clearRecentValidatedSnapshot(name);
    return null;
  }

  if ((Date.now() - snapshot.validatedAtMs) > VALIDATION_SHORT_CIRCUIT_MS) {
    clearRecentValidatedSnapshot(name);
    return null;
  }

  return snapshot;
}

function shouldTreatNotFoundAsRetraction(existingDef: AugmentDef | null): boolean {
  return existingDef?.registryStatus === "retracted";
}

function removeInstalledArtifacts(name: string, installRecord: InstallationRecord, existingDef: AugmentDef | null): void {
  for (const platformId of installRecord.platforms || []) {
    const platform = createManualPlatform(platformId);
    const artifacts = installRecord.artifacts[platformId] || {};

    if (artifacts.mcp) {
      uninstallMcp(platform, name);
    }

    if (artifacts.rules) {
      uninstallRules(platform, {
        marker: existingDef?.rules?.marker || name,
        fileName: existingDef?.rules?.fileName,
      });
    }

    for (const skillName of artifacts.skills || []) {
      uninstallSkill(platform, name, skillName);
    }
  }
}

function rewriteInstalledArtifacts(
  name: string,
  installRecord: InstallationRecord,
  previousDef: AugmentDef | null,
  nextDef: AugmentDef,
  logger: EquipLogger,
): Record<string, ArtifactRecord> {
  const nextArtifactsByPlatform: Record<string, ArtifactRecord> = {};
  const credential = resolveStoredCredential(name, nextDef);
  const nextHasMcp = !!(nextDef.serverUrl || nextDef.stdio);
  const nextSkillNames = new Set((nextDef.skills || []).map((skill) => skill.name));

  for (const platformId of installRecord.platforms || []) {
    const platform = createManualPlatform(platformId);
    const currentArtifacts = installRecord.artifacts[platformId] || {};

    if (currentArtifacts.mcp && !nextHasMcp) {
      uninstallMcp(platform, name);
    }

    if (currentArtifacts.rules && !nextDef.rules) {
      uninstallRules(platform, {
        marker: previousDef?.rules?.marker || name,
        fileName: previousDef?.rules?.fileName,
      });
    }

    for (const skillName of currentArtifacts.skills || []) {
      if (!nextSkillNames.has(skillName)) {
        uninstallSkill(platform, name, skillName);
      }
    }

    if (nextHasMcp) {
      installMcp(platform, name, buildMcpEntry(nextDef, credential, platformId), {
        serverUrl: nextDef.serverUrl,
        logger,
      });
    }

    if (nextDef.rules) {
      installRules(platform, { ...nextDef.rules, logger });
    }

    for (const skill of nextDef.skills || []) {
      installSkill(platform, name, skill, { logger });
    }

    nextArtifactsByPlatform[platformId] = buildArtifactRecord(nextDef);
  }

  return nextArtifactsByPlatform;
}

function buildArtifactRecord(def: AugmentDef): ArtifactRecord {
  return {
    mcp: !!(def.serverUrl || def.stdio),
    rules: def.rules?.version,
    skills: (def.skills || []).map((skill) => skill.name),
  };
}

function resolveStoredCredential(name: string, def: AugmentDef): string | null {
  if (!def.requiresAuth) return null;
  const credential = readStoredCredential(name);
  return credential?.credential || credential?.oauth?.accessToken || null;
}

function buildMcpEntry(def: AugmentDef, apiKey: string | null, platformId: string): Record<string, unknown> {
  if (def.transport === "stdio" && def.stdio) {
    const env: Record<string, string> = {};
    if (def.stdio.envKey && apiKey) {
      env[def.stdio.envKey] = apiKey;
    }
    return buildStdioConfig(def.stdio.command, def.stdio.args, env);
  }

  if (!def.serverUrl) {
    throw new Error(`Augment "${def.name}" has no MCP server configuration to refresh`);
  }

  return apiKey
    ? buildHttpConfigWithAuth(def.serverUrl, apiKey, platformId)
    : buildHttpConfig(def.serverUrl, platformId);
}
