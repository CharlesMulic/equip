import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getEquipHome } from "../equip-home";
import { acquireLock, atomicWriteFileSync, safeReadJsonSync } from "../fs";
import { JsonStore, type EquipDataStore } from "../storage/datastore";
import type { ResolvedAugment } from "../storage/materializer";
import type { ContentSource } from "../storage/intent";
import { validateToolName } from "../validation";
import { readPlatformsMeta } from "../platform-state";
import {
  LOADOUT_SCHEMA_VERSION,
  LOADOUT_STATE_SCHEMA_VERSION,
  type CreateLoadoutCommand,
  type DeleteLoadoutResult,
  type LegacySet,
  type LegacySetsData,
  type LoadoutEntry,
  type LoadoutInstallModeHint,
  type LoadoutManifest,
  type LoadoutProjection,
  type LoadoutShareBehavior,
  type LoadoutSourceKind,
  type LoadoutState,
  type LoadoutSummary,
  type SaveCurrentLoadoutCommand,
  type UpdateLoadoutMetadataCommand,
} from "./types";

export class LoadoutStoreError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LoadoutStoreError";
    this.code = code;
  }
}

interface StoreOptions {
  migrateLegacy?: boolean;
  store?: EquipDataStore;
  enabledPlatformIds?: Iterable<string>;
}

function loadoutsRoot(): string {
  return path.join(getEquipHome(), "loadouts");
}

function manifestsDir(): string {
  return path.join(loadoutsRoot(), "loadouts");
}

function statePath(): string {
  return path.join(loadoutsRoot(), "state.json");
}

function manifestPath(id: string): string {
  return path.join(manifestsDir(), `${id}.json`);
}

function legacySetsPath(): string {
  return path.join(getEquipHome(), "app", "sets.json");
}

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function withLoadoutLock<T>(fn: () => T): T {
  const release = acquireLock();
  try {
    return fn();
  } finally {
    release();
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createLoadoutId(seed?: string): string {
  if (seed) return `legacy_${sha256(seed).slice(0, 16)}`;
  return `ld_${crypto.randomUUID()}`;
}

function assertValidId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(id)) {
    throw new LoadoutStoreError("invalid_loadout_id", `Invalid loadout id: ${id}`);
  }
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new LoadoutStoreError("invalid_loadout_name", "Loadout name is required");
  if (trimmed.length > 120) throw new LoadoutStoreError("invalid_loadout_name", "Loadout name must be 120 characters or fewer");
  return trimmed;
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return undefined;
  const normalized = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function sortEntries(entries: LoadoutEntry[]): LoadoutEntry[] {
  return [...entries].sort((a, b) => a.augmentName.localeCompare(b.augmentName));
}

function normalizeEntry(entry: LoadoutEntry): LoadoutEntry {
  const augmentName = typeof entry.augmentName === "string" ? entry.augmentName.trim() : "";
  if (!augmentName) throw new LoadoutStoreError("invalid_loadout_entry", "Loadout entry augmentName is required");
  try {
    validateToolName(augmentName);
  } catch (error) {
    throw new LoadoutStoreError("invalid_loadout_entry", (error as Error).message);
  }

  const sourceKind = normalizeSourceKind(entry.sourceKind);
  const platformTargets = Array.isArray(entry.platformTargets)
    ? [...new Set(entry.platformTargets.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean))].sort()
    : undefined;

  return {
    augmentName,
    enabled: entry.enabled !== false,
    required: entry.required !== false,
    sourceKind,
    contentHash: typeof entry.contentHash === "string" ? entry.contentHash : undefined,
    registryVersion: typeof entry.registryVersion === "number" ? entry.registryVersion : undefined,
    platformTargets: platformTargets && platformTargets.length > 0 ? platformTargets : undefined,
    installMode: normalizeInstallMode(entry.installMode),
    shareBehavior: normalizeShareBehavior(entry.shareBehavior, sourceKind),
  };
}

function normalizeEntries(entries: LoadoutEntry[]): LoadoutEntry[] {
  const byName = new Map<string, LoadoutEntry>();
  for (const raw of entries) {
    const entry = normalizeEntry(raw);
    if (byName.has(entry.augmentName)) {
      throw new LoadoutStoreError("duplicate_loadout_entry", `Duplicate loadout entry: ${entry.augmentName}`);
    }
    byName.set(entry.augmentName, entry);
  }
  return sortEntries([...byName.values()]);
}

function normalizeSourceKind(kind: unknown): LoadoutSourceKind {
  if (kind === undefined || kind === null) return "unknown";
  if (kind === "registry" || kind === "local-authored" || kind === "wrapped" || kind === "unknown") return kind;
  throw new LoadoutStoreError("invalid_loadout_entry", `Unsupported loadout sourceKind: ${String(kind)}`);
}

function normalizeShareBehavior(behavior: unknown, sourceKind: unknown): LoadoutShareBehavior {
  if (behavior === "public-ref" || behavior === "local-private" || behavior === "unavailable-placeholder") {
    return behavior;
  }
  if (behavior !== undefined && behavior !== null) {
    throw new LoadoutStoreError("invalid_loadout_entry", `Unsupported loadout shareBehavior: ${String(behavior)}`);
  }
  return sourceKind === "registry" ? "public-ref"
    : sourceKind === "local-authored" || sourceKind === "wrapped" ? "local-private"
      : "unavailable-placeholder";
}

function normalizeInstallMode(mode: unknown): LoadoutInstallModeHint | undefined {
  if (mode !== undefined && mode !== null && mode !== "direct" && mode !== "broker" && mode !== "mixed") {
    throw new LoadoutStoreError("invalid_loadout_entry", `Unsupported loadout installMode: ${String(mode)}`);
  }
  return mode === "direct" || mode === "broker" || mode === "mixed" ? mode : undefined;
}

function defaultState(now?: string): LoadoutState {
  return {
    schemaVersion: LOADOUT_STATE_SCHEMA_VERSION,
    activeLoadoutId: null,
    activeMembershipHash: null,
    updatedAt: nowIso(now),
  };
}

function normalizeState(raw: Record<string, unknown>): LoadoutState {
  const version = raw.schemaVersion;
  if (version !== LOADOUT_STATE_SCHEMA_VERSION) {
    throw new LoadoutStoreError(
      "unsupported_loadout_state_schema",
      `Unsupported loadout state schemaVersion: ${String(version)}`,
    );
  }
  return {
    schemaVersion: LOADOUT_STATE_SCHEMA_VERSION,
    activeLoadoutId: typeof raw.activeLoadoutId === "string" ? raw.activeLoadoutId : null,
    activeMembershipHash: typeof raw.activeMembershipHash === "string" ? raw.activeMembershipHash : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
  };
}

function normalizeManifest(raw: Record<string, unknown>): LoadoutManifest {
  const version = raw.schemaVersion;
  if (version !== LOADOUT_SCHEMA_VERSION) {
    throw new LoadoutStoreError(
      "unsupported_loadout_schema",
      `Unsupported loadout schemaVersion: ${String(version)}`,
    );
  }

  if (typeof raw.id !== "string") throw new LoadoutStoreError("invalid_loadout_manifest", "Loadout id is required");
  assertValidId(raw.id);
  if (raw.mode !== "replace") {
    throw new LoadoutStoreError("invalid_loadout_manifest", `Unsupported loadout mode: ${String(raw.mode)}`);
  }

  const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
  const legacySource = raw.legacySource && typeof raw.legacySource === "object"
    ? raw.legacySource as Record<string, unknown>
    : null;
  const platformPolicy = raw.platformPolicy && typeof raw.platformPolicy === "object"
    ? raw.platformPolicy as Record<string, unknown>
    : null;
  const resolutionPolicy = raw.resolutionPolicy && typeof raw.resolutionPolicy === "object"
    ? raw.resolutionPolicy as Record<string, unknown>
    : null;

  if (!platformPolicy) {
    throw new LoadoutStoreError("invalid_loadout_manifest", "Loadout platformPolicy is required");
  }
  if (platformPolicy.kind !== "enabled-platforms") {
    throw new LoadoutStoreError("invalid_loadout_manifest", `Unsupported loadout platformPolicy: ${String(platformPolicy.kind)}`);
  }
  if (!resolutionPolicy) {
    throw new LoadoutStoreError("invalid_loadout_manifest", "Loadout resolutionPolicy is required");
  }
  if (resolutionPolicy.kind !== "latest-approved") {
    throw new LoadoutStoreError("invalid_loadout_manifest", `Unsupported loadout resolutionPolicy: ${String(resolutionPolicy.kind)}`);
  }
  if (resolutionPolicy.expectedHashBehavior !== "warn") {
    throw new LoadoutStoreError("invalid_loadout_manifest", `Unsupported loadout expectedHashBehavior: ${String(resolutionPolicy.expectedHashBehavior)}`);
  }

  return {
    schemaVersion: LOADOUT_SCHEMA_VERSION,
    id: raw.id,
    name: normalizeName(typeof raw.name === "string" ? raw.name : ""),
    description: typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : undefined,
    tags: normalizeTags(Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : undefined),
    notes: typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim() : undefined,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
    lastAppliedAt: typeof raw.lastAppliedAt === "string" ? raw.lastAppliedAt : undefined,
    mode: "replace",
    platformPolicy: { kind: "enabled-platforms" },
    resolutionPolicy: { kind: "latest-approved", expectedHashBehavior: "warn" },
    entries: normalizeEntries(rawEntries as LoadoutEntry[]),
    legacySource: legacySource?.kind === "app-set" && typeof legacySource.name === "string"
      ? { kind: "app-set", name: legacySource.name }
      : undefined,
  };
}

function writeManifest(manifest: LoadoutManifest): void {
  atomicWriteFileSync(manifestPath(manifest.id), JSON.stringify(manifest, null, 2) + "\n");
}

function writeState(state: LoadoutState): void {
  atomicWriteFileSync(statePath(), JSON.stringify(state, null, 2) + "\n");
}

function readManifestFile(filePath: string): LoadoutManifest {
  const result = safeReadJsonSync(filePath);
  if (result.status !== "ok" || !result.data) {
    throw new LoadoutStoreError(`loadout_manifest_${result.status}`, `Cannot read loadout manifest ${filePath}: ${result.error ?? result.status}`);
  }
  return normalizeManifest(result.data);
}

function readAllManifestsUnsafe(): LoadoutManifest[] {
  if (!fs.existsSync(manifestsDir())) return [];
  return fs.readdirSync(manifestsDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => readManifestFile(path.join(manifestsDir(), name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function ensureLegacy(options: StoreOptions = {}): void {
  if (options.migrateLegacy === false) return;
  migrateLegacySets({ now: undefined });
}

export function readLoadoutState(): LoadoutState {
  const result = safeReadJsonSync(statePath());
  if (result.status === "missing") return defaultState();
  if (result.status !== "ok" || !result.data) {
    throw new LoadoutStoreError(`loadout_state_${result.status}`, `Cannot read loadout state: ${result.error ?? result.status}`);
  }
  return normalizeState(result.data);
}

export function listLoadoutManifests(options: StoreOptions = {}): LoadoutManifest[] {
  ensureLegacy(options);
  return readAllManifestsUnsafe();
}

export function listLoadouts(options: StoreOptions = {}): LoadoutSummary[] {
  const projection = getLoadoutProjection(options);
  return projection.loadouts;
}

export function getLoadout(ref: string, options: StoreOptions = {}): LoadoutManifest | null {
  ensureLegacy(options);
  const normalized = ref.trim();
  if (!normalized) return null;
  const manifests = readAllManifestsUnsafe();
  return manifests.find((manifest) => manifest.id === normalized)
    ?? manifests.find((manifest) => manifest.name === normalized)
    ?? null;
}

function assertUniqueLoadoutName(name: string, exceptId?: string): void {
  if (readAllManifestsUnsafe().some((existing) => existing.id !== exceptId && existing.name === name)) {
    throw new LoadoutStoreError("loadout_name_exists", `Loadout name already exists: ${name}`);
  }
}

export function createLoadout(command: CreateLoadoutCommand): LoadoutManifest {
  return withLoadoutLock(() => {
    const now = nowIso(command.updatedAt ?? command.createdAt);
    const id = command.id ?? createLoadoutId();
    assertValidId(id);
    const manifest: LoadoutManifest = {
      schemaVersion: LOADOUT_SCHEMA_VERSION,
      id,
      name: normalizeName(command.name),
      description: command.description?.trim() || undefined,
      tags: normalizeTags(command.tags),
      notes: command.notes?.trim() || undefined,
      createdAt: command.createdAt ?? now,
      updatedAt: command.updatedAt ?? now,
      lastAppliedAt: command.lastAppliedAt,
      mode: "replace",
      platformPolicy: { kind: "enabled-platforms" },
      resolutionPolicy: { kind: "latest-approved", expectedHashBehavior: "warn" },
      entries: normalizeEntries(command.entries),
      legacySource: command.legacySource,
    };

    if (getLoadout(manifest.id, { migrateLegacy: false })) {
      throw new LoadoutStoreError("loadout_exists", `Loadout id already exists: ${manifest.id}`);
    }
    assertUniqueLoadoutName(manifest.name);

    writeManifest(manifest);
    return manifest;
  });
}

export function saveCurrentLoadout(command: SaveCurrentLoadoutCommand, options: StoreOptions = {}): LoadoutManifest {
  return withLoadoutLock(() => {
    ensureLegacy(options);
    const now = nowIso(command.now);
    const entries = entriesFromResolved((options.store ?? JsonStore).listResolved(), {
      platformFilter: currentPlatformFilter(options),
    });
    const existing = command.id ? getLoadout(command.id, { migrateLegacy: false }) : getLoadout(command.name, { migrateLegacy: false });

    let manifest: LoadoutManifest;
    if (existing) {
      const name = normalizeName(command.name || existing.name);
      assertUniqueLoadoutName(name, existing.id);
      manifest = {
        ...existing,
        name,
        description: command.description?.trim() || existing.description,
        tags: command.tags ? normalizeTags(command.tags) : existing.tags,
        notes: command.notes?.trim() || existing.notes,
        updatedAt: now,
        entries,
      };
      writeManifest(manifest);
    } else {
      manifest = createLoadout({
        id: command.id,
        name: command.name,
        description: command.description,
        tags: command.tags,
        notes: command.notes,
        createdAt: now,
        updatedAt: now,
        entries,
      });
    }

    setActiveLoadout(manifest.id, { now });
    return manifest;
  });
}

export function renameLoadout(ref: string, newName: string): LoadoutManifest {
  return withLoadoutLock(() => {
    const manifest = requireLoadout(ref);
    const name = normalizeName(newName);
    assertUniqueLoadoutName(name, manifest.id);
    const updated = { ...manifest, name, updatedAt: nowIso() };
    writeManifest(updated);
    return updated;
  });
}

export function updateLoadoutMetadata(ref: string, command: UpdateLoadoutMetadataCommand): LoadoutManifest {
  return withLoadoutLock(() => {
    const manifest = requireLoadout(ref);
    const updated: LoadoutManifest = {
      ...manifest,
      description: command.description !== undefined ? command.description.trim() || undefined : manifest.description,
      tags: command.tags !== undefined ? normalizeTags(command.tags) : manifest.tags,
      notes: command.notes !== undefined ? command.notes.trim() || undefined : manifest.notes,
      updatedAt: nowIso(),
    };
    writeManifest(updated);
    return updated;
  });
}

export function duplicateLoadout(ref: string, newName: string): LoadoutManifest {
  return withLoadoutLock(() => {
    const source = requireLoadout(ref);
    return createLoadout({
      name: newName,
      description: source.description,
      tags: source.tags,
      notes: source.notes,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      entries: source.entries,
    });
  });
}

export function deleteLoadout(ref: string): DeleteLoadoutResult {
  return withLoadoutLock(() => {
    const manifest = getLoadout(ref);
    if (!manifest) return { deleted: false, activeCleared: false };
    try {
      fs.unlinkSync(manifestPath(manifest.id));
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }

    let activeCleared = false;
    const state = readLoadoutState();
    if (state.activeLoadoutId === manifest.id) {
      writeState({ ...state, activeLoadoutId: null, activeMembershipHash: null, updatedAt: nowIso() });
      activeCleared = true;
    }
    return { deleted: true, activeCleared };
  });
}

export function setActiveLoadout(ref: string | null, options: { now?: string } = {}): LoadoutState {
  return withLoadoutLock(() => {
    if (ref === null) {
      const state = { ...readLoadoutState(), activeLoadoutId: null, activeMembershipHash: null, updatedAt: nowIso(options.now) };
      writeState(state);
      return state;
    }
    const manifest = requireLoadout(ref);
    const state: LoadoutState = {
      schemaVersion: LOADOUT_STATE_SCHEMA_VERSION,
      activeLoadoutId: manifest.id,
      activeMembershipHash: computeLoadoutMembershipHash(manifest),
      updatedAt: nowIso(options.now),
    };
    writeState(state);
    return state;
  });
}

export function markLoadoutApplied(ref: string, options: { now?: string } = {}): LoadoutManifest {
  return withLoadoutLock(() => {
    const manifest = requireLoadout(ref);
    const updated = { ...manifest, lastAppliedAt: nowIso(options.now) };
    writeManifest(updated);
    return updated;
  });
}

export function clearActiveLoadout(options: { now?: string } = {}): LoadoutState {
  return setActiveLoadout(null, options);
}

export function getLoadoutProjection(options: StoreOptions = {}): LoadoutProjection {
  ensureLegacy(options);
  const manifests = readAllManifestsUnsafe();
  const state = readLoadoutState();
  const activeLoadout = state.activeLoadoutId
    ? manifests.find((manifest) => manifest.id === state.activeLoadoutId) ?? null
    : null;
  const currentMembershipHash = computeCurrentMembershipHash((options.store ?? JsonStore).listResolved(), {
    platformFilter: currentPlatformFilter(options),
  });
  const activeModified = !!activeLoadout && currentMembershipHash !== computeLoadoutMembershipHash(activeLoadout);

  return {
    loadouts: manifests.map((manifest) => ({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      tags: manifest.tags,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      lastAppliedAt: manifest.lastAppliedAt,
      entryCount: manifest.entries.filter((entry) => entry.enabled).length,
      active: manifest.id === activeLoadout?.id,
      modified: manifest.id === activeLoadout?.id ? activeModified : false,
    })),
    activeLoadoutId: activeLoadout?.id ?? null,
    activeLoadout,
    activeModified,
    currentMembershipHash,
  };
}

function requireLoadout(ref: string): LoadoutManifest {
  const manifest = getLoadout(ref);
  if (!manifest) throw new LoadoutStoreError("loadout_not_found", `Loadout not found: ${ref}`);
  return manifest;
}

export function computeLoadoutMembershipHash(manifest: LoadoutManifest): string {
  const entries = manifest.entries
    .filter((entry) => entry.enabled)
    .map((entry) => ({ augmentName: entry.augmentName, enabled: true, required: entry.required !== false }))
    .sort((a, b) => a.augmentName.localeCompare(b.augmentName));
  return sha256(stableStringify({ mode: manifest.mode, entries }));
}

export function computeCurrentMembershipHash(
  resolved: ResolvedAugment[],
  options: { platformFilter?: Set<string> | null } = {},
): string {
  const entries = resolved
    .filter((augment) => isCurrentEquipped(augment, options.platformFilter ?? null))
    .map((augment) => ({ augmentName: augment.name, enabled: true, required: true }))
    .sort((a, b) => a.augmentName.localeCompare(b.augmentName));
  return sha256(stableStringify({ mode: "replace", entries }));
}

export function entriesFromResolved(
  resolved: ResolvedAugment[],
  options: { platformFilter?: Set<string> | null } = {},
): LoadoutEntry[] {
  return normalizeEntries(resolved
    .filter((augment) => isCurrentEquipped(augment, options.platformFilter ?? null))
    .map((augment) => {
      const platformTargets = currentInstalledPlatforms(augment, options.platformFilter ?? null);
      return {
        augmentName: augment.name,
        enabled: true,
        required: true,
        sourceKind: sourceKindFromContentSource(augment.contentSource),
        contentHash: augment.contentHash,
        registryVersion: registryVersionFromContentSource(augment.contentSource),
        platformTargets,
        installMode: installModeHint(augment.installModes, platformTargets),
        shareBehavior: shareBehaviorFromContentSource(augment.contentSource),
      };
    }));
}

function currentPlatformFilter(options: StoreOptions): Set<string> | null {
  if (options.enabledPlatformIds !== undefined) {
    return new Set([...options.enabledPlatformIds].filter(Boolean));
  }
  const meta = readPlatformsMeta();
  const platformIds = Object.keys(meta.platforms ?? {});
  if (platformIds.length === 0) return null;
  return new Set(platformIds.filter((id) => meta.platforms[id]?.enabled));
}

function isCurrentEquipped(augment: ResolvedAugment, platformFilter: Set<string> | null): boolean {
  if (!augment.installed) return false;
  if (platformFilter === null) return true;
  return augment.installedPlatforms.some((platform) => platformFilter.has(platform));
}

function currentInstalledPlatforms(augment: ResolvedAugment, platformFilter: Set<string> | null): string[] {
  if (platformFilter === null) return augment.installedPlatforms;
  return augment.installedPlatforms.filter((platform) => platformFilter.has(platform));
}

function sourceKindFromContentSource(source: ContentSource): LoadoutSourceKind {
  return source.kind;
}

function registryVersionFromContentSource(source: ContentSource): number | undefined {
  return source.kind === "registry" ? source.version : undefined;
}

function shareBehaviorFromContentSource(source: ContentSource): LoadoutShareBehavior {
  return source.kind === "registry" ? "public-ref" : "local-private";
}

function installModeHint(
  modes: Record<string, "direct" | "broker">,
  platforms: string[],
): LoadoutInstallModeHint | undefined {
  if (platforms.length === 0) return undefined;
  const values = platforms.map((platform) => modes[platform] ?? "direct");
  const unique = new Set(values);
  if (unique.size === 1) return values[0];
  return "mixed";
}

export function migrateLegacySets(options: { now?: string } = {}): { migrated: number; activeLoadoutId: string | null } {
  return withLoadoutLock(() => {
    const legacy = readLegacySets();
    if (!legacy || legacy.sets.length === 0) return { migrated: 0, activeLoadoutId: readLoadoutState().activeLoadoutId };

    const existing = readAllManifestsUnsafe();
    const existingNames = new Set(existing.map((manifest) => manifest.name));
    const existingLegacyNames = new Set(existing.map((manifest) => manifest.legacySource?.name).filter(Boolean));
    let migrated = 0;
    let activeLoadoutId = readLoadoutState().activeLoadoutId;

    for (const set of legacy.sets) {
      const name = normalizeName(set.name);
      if (existingNames.has(name) || existingLegacyNames.has(name)) {
        const matching = existing.find((manifest) => manifest.name === name || manifest.legacySource?.name === name);
        if (legacy.activeSet === name && matching) activeLoadoutId = matching.id;
        continue;
      }

      const createdAt = set.createdAt ?? nowIso(options.now);
      const updatedAt = set.lastUsed ?? set.createdAt ?? nowIso(options.now);
      const entries = set.augments.map((augmentName) => legacyEntry(name, augmentName));
      const manifest = createLoadout({
        id: createLoadoutId(name),
        name,
        createdAt,
        updatedAt,
        entries,
        legacySource: { kind: "app-set", name },
      });
      migrated++;
      existing.push(manifest);
      existingNames.add(name);
      existingLegacyNames.add(name);
      if (legacy.activeSet === name) activeLoadoutId = manifest.id;
    }

    if (activeLoadoutId) {
      const active = readAllManifestsUnsafe().find((manifest) => manifest.id === activeLoadoutId);
      if (active) {
        writeState({
          schemaVersion: LOADOUT_STATE_SCHEMA_VERSION,
          activeLoadoutId: active.id,
          activeMembershipHash: computeLoadoutMembershipHash(active),
          updatedAt: nowIso(options.now),
        });
      }
    }

    return { migrated, activeLoadoutId };
  });
}

function legacyEntry(setName: string, augmentName: string): LoadoutEntry {
  try {
    return normalizeEntry({
      augmentName,
      enabled: true,
      required: true,
      sourceKind: "unknown",
      shareBehavior: "unavailable-placeholder",
    });
  } catch (error) {
    throw new LoadoutStoreError(
      "invalid_legacy_set_entry",
      `Legacy set "${setName}" contains invalid augment name "${augmentName}": ${(error as Error).message}`,
    );
  }
}

function readLegacySets(): LegacySetsData | null {
  const result = safeReadJsonSync(legacySetsPath());
  if (result.status === "missing") return null;
  if (result.status !== "ok" || !result.data) {
    throw new LoadoutStoreError(`legacy_sets_${result.status}`, `Cannot read legacy sets: ${result.error ?? result.status}`);
  }

  const sets = Array.isArray(result.data.sets) ? result.data.sets : [];
  return {
    sets: sets
      .map((raw): LegacySet | null => {
        if (!raw || typeof raw !== "object") return null;
        const value = raw as Record<string, unknown>;
        if (typeof value.name !== "string" || !Array.isArray(value.augments)) return null;
        return {
          name: value.name,
          augments: value.augments.filter((a): a is string => typeof a === "string"),
          createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
          lastUsed: typeof value.lastUsed === "string" ? value.lastUsed : undefined,
        };
      })
      .filter((set): set is LegacySet => set != null),
    activeSet: typeof result.data.activeSet === "string" ? result.data.activeSet : null,
  };
}
