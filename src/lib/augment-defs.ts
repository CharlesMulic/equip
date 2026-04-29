// Augment Definitions — persistent local source of truth for what each augment IS.
//
// Each augment gets a definition file at ~/.equip/augments/<name>.json.
// Registry augments are synced from the API. Local augments are user-created.
// Modded augments preserve the user's behavioral customizations (rules, hooks, skills)
// while tracking the upstream version for diff/reset.
//
// **Pkg 01 of equip-storage-refactor (2026-04-28):** this file remains the
// LEGACY storage layer for back-compat during the storage refactor. Every
// public read/write triggers `ensureStorageMigrated()` (idempotent) and every
// write mirrors to the new three-store layout (defs/cache/installs) via
// `dual-write-mirror.ts`. Reads stay legacy in Pkg 01; Pkgs 02-04 migrate
// consumers to read via `augmentResolver.resolve()` from the new stores.
// After all consumers migrate, this file can be deleted in a final cleanup.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { atomicWriteFileSync, safeReadJsonSync } from "./fs";
import { validateToolName } from "./validation";
import type { SkillConfig } from "./skills";
import type { HookDefinition } from "./hooks";
import type { RegistryDef } from "./registry";
import { ensureStorageMigrated } from "./migration-trigger";
import { mirrorWriteAugmentDef, mirrorDeleteAugmentDef } from "./dual-write-mirror";
import { isLegacyStorageRetired } from "./migrate-storage";

// ─── Types ──────────────────────────────────────────────────

export type AugmentSource = "registry" | "local" | "wrapped";
export type RegistryLifecycleStatus =
  | "active"
  | "retracted"
  | "pending-review"
  | "rejected"
  | "synced-unreviewed";

export interface AugmentRules {
  content: string;
  version: string;
  marker: string;
  fileName?: string;
}

export interface AugmentDef {
  /** Augment name — must match the filename (without .json) */
  name: string;

  /** Where this definition came from */
  source: AugmentSource;

  /** Human-readable title (e.g., "Prior"). Falls back to name. */
  title: string;

  /** Subtitle shown below title (e.g., "Agent Knowledge Base") */
  subtitle?: string;

  /** One-line description */
  description: string;

  /** Rarity tier */
  rarity?: "common" | "uncommon" | "rare" | "epic" | "legendary";

  /** Flavor text for epic/legendary tooltips */
  flavorText?: string;

  /** Install count from registry */
  installCount?: number;

  // ── Infrastructure (publisher-owned, not user-editable) ──

  /** Transport type (undefined for skill-only or rules-only augments) */
  transport?: "http" | "stdio";

  /** MCP server URL (for HTTP transport) */
  serverUrl?: string;

  /** Stdio configuration (for stdio transport) */
  stdio?: {
    command: string;
    args: string[];
    envKey?: string;
  };

  /** Whether the augment requires authentication */
  requiresAuth: boolean;

  /**
   * Auth flow declaration — propagated from RegistryDef.auth so
   * downstream broker dispatch (equip-app/sidecar/bridge.ts) can decide
   * direct vs broker mode based on auth.type without re-fetching the
   * registry def. ENG-0052: bridge install path broker dispatch.
   *
   * Kept optional for backward compat with augment defs written by older
   * equip versions; absence means "no auth flow declared."
   */
  auth?: import("./auth-engine").AuthConfig;

  /** Environment variable key for API key */
  envKey?: string;

  // ── Behavioral (user-customizable) ──

  /** Agent instructions — moddable by the user */
  rules?: AugmentRules;

  /** Upstream rules from the registry (preserved for diffing when modded) */
  rulesUpstream?: AugmentRules;

  /** Skill definitions */
  skills: SkillConfig[];

  /** Hook definitions */
  hooks?: HookDefinition[];

  /** Hook directory */
  hookDir?: string;

  /** Token weight — always-paid cost of having the augment installed */
  baseWeight: number;

  /** Token weight — additional cost when augment is fully loaded in context */
  loadedWeight: number;

  /** @deprecated Use baseWeight. Kept for backward compat during migration. */
  weight?: number;

  /** Cached MCP server introspection results (opaque — typed in desktop app) */
  introspection?: Record<string, unknown> | null;

  // ── Mod tracking ──

  /** Whether the user has modified behavioral fields */
  modded: boolean;

  /** When the modification was made */
  moddedAt?: string;

  /** Which fields were modified */
  moddedFields?: string[];

  // ── Registry tracking ──

  /** Backend content hash for the currently-synced registry snapshot */
  registryContentHash?: string;

  /** Backend ETag for the currently-synced registry representation */
  registryEtag?: string;

  /** Backend numeric version for the currently-synced registry snapshot */
  registryVersionNumber?: number;

  /** When the registry snapshot was most recently validated */
  lastValidatedAt?: string;

  /** Registry lifecycle status for this cached definition */
  registryStatus?: RegistryLifecycleStatus;

  /** When the definition was last synced from the registry */
  syncedAt?: string;

  /** Homepage URL */
  homepage?: string;

  /** Repository URL */
  repository?: string;

  /** License */
  license?: string;

  /** Categories */
  categories?: string[];

  /** Publisher identity (synced from registry) */
  publisher?: { name: string; slug: string; verified: boolean; avatarUrl?: string | null };

  // ── Authoring lifecycle ──

  /** User intends to publish this augment to the registry */
  publishIntent?: boolean;

  /** Version number in the registry (set after first publish, incremented on updates) */
  publishedVersion?: number;

  /** Whether local changes haven't been pushed to the registry yet */
  hasUnpublishedChanges?: boolean;

  /** Auth configuration for the MCP server (for registry publish) */
  authConfig?: Record<string, unknown>;

  /** Post-install actions (for registry publish) */
  postInstallActions?: Record<string, unknown>[];

  /** Platform-specific configuration hints (for registry publish) */
  platformHints?: Record<string, string>;

  // ── Wrapping provenance ──

  /** Provenance metadata for auto-wrapped augments */
  wrappedFrom?: WrappedFromMeta | string; // string is legacy format, migrated on read

  // ── Timestamps ──

  createdAt: string;
  updatedAt: string;

  /** @deprecated Legacy mixed field. Migrated to registryContentHash/registryVersionNumber. */
  registryVersion?: string;

  /** @deprecated Legacy "update available" flag written by the sidecar. */
  registryLatestVersion?: number;

  /**
   * Manual-update signal (Phase 1 of MANUAL_UPDATE_PLAN). Set by
   * `augmentCheckUpdates` when `POST /v1/equip/updates/check` reports
   * a newer approved content_hash for this augment. Consumed by the
   * UI's "Update available" badge / Discover indicator and cleared by
   * `refreshAugmentFromRegistry` after an accepted update.
   */
  registryLatestContentHash?: string;

  /**
   * Companion flag to [registryLatestContentHash]. True when the
   * server's advisory bit is set on the current approved version —
   * clients render flagged updates distinctly ("Security update —
   * recommended") and may opt into per-augment auto-apply.
   */
  registryLatestSecurityAdvisory?: boolean;

  // ── Publisher draft state — REMOVED ──
  //
  // Publisher submission state lives entirely on the backend in
  // `equip_publisher_drafts` (queryable via `PublisherDraftService.getDraft`).
  // The bridge's `augment.getDraft` RPC is the read surface; `augment.saveDraft`
  // and `augment.discardDraft` are the write surfaces. No local mirror.
  //
  // Removed during the equip-storage-refactor cleanup (post-Pkg-04 closeout):
  //   workingDraftEdit, submittedEdit, submittedRevisionId, submittedStatus,
  //   submittedRejectionReason, submittedAt, pendingEdit, pendingReviewId,
  //   pendingRejectionReason.
  //
  // The migrate-storage one-shot at SCHEMA_VERSION 3 strips these fields from
  // any pre-existing legacy file on first run.

  /**
   * Timestamp of the most recent explicit user interaction with this
   * augment (equip, unequip, add-to-set, remove-from-set, save-draft).
   * Used by the "last used" cache-visibility UI and as input to the
   * deferred Level-2 lazy-eviction policy. Strictly sidecar-local —
   * NEVER serialized into `/updates/check` body or any backend-facing
   * payload (Phase 2 security-review hard requirement).
   */
  lastUserActionAt?: string;
}

/** Provenance metadata for auto-wrapped augments */
export interface WrappedFromMeta {
  /** What kind of artifact was detected */
  type: "mcp" | "skill";
  /** Platform ID where the artifact was detected */
  platform: string;
  /** File path — config file for MCP, skill file for skills */
  path?: string;
  /** The original key/filename in the platform config */
  originalName?: string;
}

/** Options for creating a local augment */
export interface LocalAugmentConfig {
  name: string;
  title?: string;
  description?: string;
  transport?: "http" | "stdio";
  serverUrl?: string;
  stdio?: { command: string; args: string[]; envKey?: string };
  requiresAuth?: boolean;
  rules?: AugmentRules;
  skills?: SkillConfig[];
  hooks?: HookDefinition[];
  baseWeight?: number;
  loadedWeight?: number;
}

/** Options for wrapping an unmanaged platform config entry */
export interface WrapConfig {
  name: string;
  title?: string;
  description?: string;
  transport?: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  fromPlatform: string;
  /** Structured provenance metadata. If not provided, defaults to { type: "mcp", platform: fromPlatform }. */
  wrappedFromMeta?: WrappedFromMeta;
  /** Skill definitions to include in the wrapped augment */
  skills?: SkillConfig[];
  baseWeight?: number;
  loadedWeight?: number;
}

// ─── Paths ──────────────────────────────────────────────────

// Resolve dynamically so tests can override os.homedir()
import { getEquipHome } from "./equip-home";
const getEquipDir = getEquipHome;
export function getAugmentsDir(): string { return path.join(getEquipDir(), "augments"); }

function augmentPath(name: string): string {
  validateToolName(name);
  return path.join(getAugmentsDir(), `${name}.json`);
}

function ensureAugmentsDir(): void {
  const dir = getAugmentsDir();
  if (!fs.existsSync(dir)) {
    // 0700 was historically chosen to protect publisher draft content
    // (when stored locally pre-Pkg-04). Drafts now live server-side,
    // but the directory perms stay tight as defense in depth — the
    // legacy files (~/.equip/augments/<name>.json) still hold sidecar
    // state until Cleanup B retires them entirely.
    // Best-effort — on Windows `mkdir` ignores the mode and the
    // ACL-restriction happens via filesystem default (user home
    // directory inherits user-only access on typical NTFS setups).
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    // Existing dir — tighten perms if they're looser than 0700.
    // No-op on Windows; chmod on unix is idempotent + cheap.
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
}

// ─── CRUD ───────────────────────────────────────────────────

/** Read an augment definition by name. Returns null if not found. */
export function readAugmentDef(name: string): AugmentDef | null {
  ensureStorageMigrated();
  const filePath = augmentPath(name);
  const { data, status } = safeReadJsonSync(filePath);

  if (status === "missing") return null;
  if (status === "corrupt") {
    // Back up corrupt file, return null
    try { fs.copyFileSync(filePath, filePath + ".corrupt.bak"); } catch {}
    return null;
  }
  if (status === "unreadable" || !data) return null;

  return normalizeAugmentDef(data as unknown as AugmentDef).def;
}

/** Promote a wrapped augment to local. One-way transition. */
export function promoteWrappedToLocal(name: string): AugmentDef | null {
  const def = readAugmentDef(name);
  if (!def || def.source !== "wrapped") return def;
  def.source = "local";
  def.updatedAt = new Date().toISOString();
  // wrappedFrom is preserved — it is provenance, not state
  writeAugmentDef(def);
  return def;
}

/** Write an augment definition. Creates the augments directory if needed. */
export function writeAugmentDef(def: AugmentDef): void {
  // Cleanup B Pkg 06 batch 1: defensive gate on the schema-v4 cutover.
  // After the cutover, the resolver / store-writers are the only sanctioned
  // write surface. A legacy write here would recreate the file we just
  // deleted in cleanupBLegacyFiles — typically caused by an old equip-app
  // sidecar binary running concurrently with the new CLI that ran cleanup.
  // This entire function disappears with the module in Pkg 06 batch 2;
  // the gate exists only for the migration-window safety.
  if (isLegacyStorageRetired()) {
    // eslint-disable-next-line no-console
    console.warn(`[equip] writeAugmentDef("${def.name}"): refusing legacy write — schema_version >= 4 (post-Cleanup-B). The new defs/cache stores are authoritative.`);
    return;
  }
  ensureStorageMigrated();
  ensureAugmentsDir();
  atomicWriteFileSync(augmentPath(def.name), JSON.stringify(def, null, 2) + "\n");
  // Pkg 01 dual-write: mirror to the new three-store layout. Failures are
  // logged + swallowed so the legacy write isn't blocked by a new-store hiccup.
  mirrorWriteAugmentDef(def);
}

/**
 * Convert an AugmentDef (locally-stored shape with rules content inlined,
 * stdio nested) into an AugmentConfig (the shape `new Augment(config)` expects).
 *
 * Mirrors `registryDefToConfig` (in registry.ts) which converts the wire-shape
 * RegistryDef into AugmentConfig. The two shapes overlap heavily but differ in
 * stdio handling — RegistryDef has flat `stdioCommand`/`stdioArgs` fields,
 * AugmentDef has a nested `stdio: { command, args, envKey? }` object. This
 * adapter is the AugmentDef-side version.
 *
 * Used by `writeAugmentDefAndApply` (commands/install.ts) and any other call
 * site that needs to construct an `Augment` instance from a locally-stored def
 * for propagation to platforms (e.g., the equip-augment-update-propagation
 * initiative's authoring save / platform-enable backfill / CLI apply paths).
 */
export function augmentDefToConfig(def: AugmentDef): import("../index").AugmentConfig {
  const config: import("../index").AugmentConfig = {
    name: def.name,
    source: def.source as import("./skill-manifest").SkillManifestOwnerSource,
  };

  if (def.serverUrl) config.serverUrl = def.serverUrl;

  if (def.rules) {
    config.rules = {
      content: def.rules.content,
      version: def.rules.version,
      marker: def.rules.marker,
      ...(def.rules.fileName && { fileName: def.rules.fileName }),
    };
  }

  if (def.stdio) {
    config.stdio = {
      command: def.stdio.command,
      args: def.stdio.args,
      envKey: def.stdio.envKey ?? def.envKey ?? "",
    };
  }

  if (def.hooks && def.hooks.length > 0) config.hooks = def.hooks;
  if (def.hookDir) config.hookDir = def.hookDir;
  if (def.skills && def.skills.length > 0) config.skills = def.skills;

  return config;
}

/**
 * Rewrite legacy registry tracking fields to the current schema.
 * Safe to call on app startup; only dirty files are rewritten.
 */
export function migrateLegacyRegistryTrackingFields(): { migrated: number } {
  ensureAugmentsDir();

  let migrated = 0;
  let files: string[] = [];
  try {
    files = fs.readdirSync(getAugmentsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return { migrated: 0 };
  }

  for (const file of files) {
    const name = file.replace(/\.json$/, "");
    const filePath = augmentPath(name);
    const { data, status } = safeReadJsonSync(filePath);
    if (status !== "ok" || !data) continue;

    const normalized = normalizeAugmentDef(data as unknown as AugmentDef);
    if (!normalized.changed) continue;

    writeAugmentDef(normalized.def);
    migrated++;
  }

  return { migrated };
}

/** List all augment definitions. */
export function listAugmentDefs(): AugmentDef[] {
  ensureStorageMigrated();
  ensureAugmentsDir();

  const defs: AugmentDef[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(getAugmentsDir()).filter(f => f.endsWith(".json"));
  } catch {
    return [];
  }

  for (const file of files) {
    const name = file.replace(/\.json$/, "");
    const def = readAugmentDef(name);
    if (def) defs.push(def);
  }

  return defs;
}

/** Delete an augment definition. Returns true if the file existed. */
export function deleteAugmentDef(name: string): boolean {
  // Cleanup B Pkg 06 batch 1: defensive gate on the schema-v4 cutover.
  // Mirror to new stores still fires (otherwise a legacy delete would leave
  // stale defs/cache entries behind even post-cutover); we just don't touch
  // the legacy file path that no longer exists.
  if (isLegacyStorageRetired()) {
    mirrorDeleteAugmentDef(name);
    return false;
  }
  ensureStorageMigrated();
  const filePath = augmentPath(name);
  try {
    fs.unlinkSync(filePath);
    // Pkg 01 dual-write: mirror the deletion into the new stores.
    mirrorDeleteAugmentDef(name);
    return true;
  } catch {
    return false;
  }
}

/** Check if an augment definition exists. */
export function hasAugmentDef(name: string): boolean {
  return fs.existsSync(augmentPath(name));
}

// ─── Sync from Registry ─────────────────────────────────────

/**
 * Create or update an augment definition from a registry RegistryDef.
 * If the definition already exists and is modded, preserves the user's modifications
 * and updates rulesUpstream to the new registry version.
 *
 * Returns the resulting definition.
 */
export function syncFromRegistry(registryDef: RegistryDef): AugmentDef {
  validateToolName(registryDef.name);
  const now = new Date().toISOString();
  const existing = readAugmentDef(registryDef.name);

  if (existing && existing.source === "registry") {
    // Update existing registry definition
    return updateFromRegistry(existing, registryDef, now);
  }

  if (existing && existing.source === "local") {
    // Local augments with this name already exist - don't overwrite.
    // User-authored local content is sovereign over registry definitions.
    return existing;
  }

  // Create new definition from registry. Auto-wrapped definitions are upgraded
  // because they are inferred from detected platform config, not authored
  // content; if the registry now knows this augment, registry ownership should
  // win so creator/publisher flows see the published metadata.
  const def: AugmentDef = {
    name: registryDef.name,
    source: "registry",
    title: registryDef.title || registryDef.name,
    description: registryDef.description || "",
    transport: (registryDef.transport as "http" | "stdio") || "http",
    serverUrl: registryDef.serverUrl,
    stdio: registryDef.stdioCommand
      ? { command: registryDef.stdioCommand, args: registryDef.stdioArgs || [], envKey: registryDef.envKey }
      : undefined,
    requiresAuth: registryDef.requiresAuth || false,
    auth: registryDef.auth,
    envKey: registryDef.envKey,
    rules: registryDef.rules ? { ...registryDef.rules } : undefined,
    skills: registryDef.skills || [],
    hooks: registryDef.hooks,
    hookDir: registryDef.hookDir,
    rarity: registryDef.rarity || "common",
    subtitle: registryDef.subtitle,
    flavorText: registryDef.flavorText,
    baseWeight: registryDef.baseWeight || 0,
    loadedWeight: registryDef.loadedWeight || 0,
    installCount: registryDef.installCount || 0,
    modded: false,
    registryContentHash: registryDef.contentHash,
    registryVersionNumber: registryDef.version,
    lastValidatedAt: now,
    registryStatus: "active",
    syncedAt: now,
    homepage: registryDef.homepage,
    repository: registryDef.repository,
    license: registryDef.license,
    categories: registryDef.categories,
    publisher: registryDef.publisher,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  writeAugmentDef(def);
  return def;
}

/** Update an existing registry definition, preserving mods. */
function updateFromRegistry(existing: AugmentDef, registryDef: RegistryDef, now: string): AugmentDef {
  const newVersion = registryDef.rules?.version || "1.0.0";
  const oldVersion = existing.rules?.version || existing.rulesUpstream?.version || "";
  const versionChanged = newVersion !== oldVersion;

  const updated: AugmentDef = {
    ...existing,
    // Always update infrastructure fields from registry
    title: registryDef.title || existing.title,
    description: registryDef.description || existing.description,
    transport: (registryDef.transport as "http" | "stdio") || existing.transport,
    serverUrl: registryDef.serverUrl || existing.serverUrl,
    stdio: registryDef.stdioCommand
      ? { command: registryDef.stdioCommand, args: registryDef.stdioArgs || [], envKey: registryDef.envKey }
      : existing.stdio,
    requiresAuth: registryDef.requiresAuth ?? existing.requiresAuth,
    auth: registryDef.auth ?? existing.auth,
    envKey: registryDef.envKey || existing.envKey,
    homepage: registryDef.homepage || existing.homepage,
    repository: registryDef.repository || existing.repository,
    license: registryDef.license || existing.license,
    categories: registryDef.categories || existing.categories,
    publisher: registryDef.publisher || existing.publisher,
    // Display metadata — always sync from registry (authoritative source)
    rarity: registryDef.rarity || existing.rarity,
    subtitle: registryDef.subtitle || existing.subtitle,
    flavorText: registryDef.flavorText || existing.flavorText,
    installCount: registryDef.installCount ?? existing.installCount,
    registryContentHash: registryDef.contentHash,
    registryVersionNumber: registryDef.version ?? existing.registryVersionNumber,
    lastValidatedAt: now,
    registryStatus: "active",
    syncedAt: now,
    updatedAt: now,
  };

  // Handle behavioral fields based on mod status
  if (existing.modded) {
    // User has mods — DON'T overwrite their rules/skills/hooks
    // But DO update the upstream reference so they can diff later
    if (versionChanged && registryDef.rules) {
      updated.rulesUpstream = { ...registryDef.rules };
    }
    // Update skills/hooks upstream if not modded (skills modding is future)
    if (!existing.moddedFields?.includes("skills")) {
      updated.skills = registryDef.skills || existing.skills;
    }
    if (!existing.moddedFields?.includes("hooks")) {
      updated.hooks = registryDef.hooks || existing.hooks;
    }
  } else {
    // No mods — update everything from registry
    updated.rules = registryDef.rules ? { ...registryDef.rules } : existing.rules;
    updated.rulesUpstream = undefined; // no need for upstream when not modded
    updated.skills = registryDef.skills || existing.skills;
    updated.hooks = registryDef.hooks || existing.hooks;
    updated.hookDir = registryDef.hookDir || existing.hookDir;
  }

  writeAugmentDef(updated);
  return updated;
}

function normalizeAugmentDef(def: AugmentDef): { def: AugmentDef; changed: boolean } {
  let changed = false;
  const legacy = def as AugmentDef & { weight?: number; contentHash?: string; registryVersion?: string };

  // Lazy migration: old single `weight` → baseWeight + loadedWeight
  if (def.baseWeight === undefined && legacy.weight !== undefined) {
    def.baseWeight = legacy.weight;
    def.loadedWeight = 0;
    changed = true;
  }
  // Ensure defaults
  if (def.baseWeight === undefined) {
    def.baseWeight = 0;
    changed = true;
  }
  if (def.loadedWeight === undefined) {
    def.loadedWeight = 0;
    changed = true;
  }

  // Lazy migration: old wrappedFrom string → structured WrappedFromMeta
  if (typeof def.wrappedFrom === "string") {
    def.wrappedFrom = { type: "mcp", platform: def.wrappedFrom };
    changed = true;
  }

  // Lazy migration: clear phantom transport on skill-only augments
  // (Before transport was made optional, skill-only augments got transport: "stdio" as a placeholder)
  if (def.transport && !def.serverUrl && !def.stdio) {
    def.transport = undefined;
    changed = true;
  }

  // Legacy sidecar writes stored the content hash under `contentHash`.
  if (def.registryContentHash === undefined && typeof legacy.contentHash === "string" && legacy.contentHash.trim()) {
    def.registryContentHash = legacy.contentHash.trim();
    changed = true;
  }

  // Only migrate purely numeric legacy registry versions. Older sidecar builds
  // also stored rules-version strings here; the authoritative value still lives
  // under def.rules.version, so this legacy field can be dropped safely.
  if (
    def.registryVersionNumber === undefined &&
    typeof legacy.registryVersion === "string" &&
    /^\d+$/.test(legacy.registryVersion.trim())
  ) {
    def.registryVersionNumber = parseInt(legacy.registryVersion.trim(), 10);
    changed = true;
  }

  if (def.source === "registry" && def.registryStatus === undefined) {
    def.registryStatus = "active";
    changed = true;
  }

  if ("contentHash" in legacy) {
    delete legacy.contentHash;
    changed = true;
  }

  if ("registryVersion" in legacy) {
    delete legacy.registryVersion;
    changed = true;
  }

  return { def, changed };
}

// ─── Local Augments ─────────────────────────────────────────

/** Create a new local augment definition. */
export function createLocalAugment(config: LocalAugmentConfig): AugmentDef {
  const now = new Date().toISOString();

  const def: AugmentDef = {
    name: config.name,
    source: "local",
    title: config.title || config.name,
    description: config.description || "",
    transport: config.transport,
    serverUrl: config.serverUrl,
    stdio: config.stdio,
    requiresAuth: config.requiresAuth || false,
    rules: config.rules,
    skills: config.skills || [],
    hooks: config.hooks,
    baseWeight: config.baseWeight || 0,
    loadedWeight: config.loadedWeight || 0,
    modded: false,
    createdAt: now,
    updatedAt: now,
  };

  writeAugmentDef(def);
  return def;
}

// ─── Wrap Unmanaged ─────────────────────────────────────────

/** Wrap an unmanaged MCP entry as a local augment definition. */
export function wrapUnmanaged(config: WrapConfig): AugmentDef {
  const now = new Date().toISOString();

  const def: AugmentDef = {
    name: config.name,
    source: "wrapped",
    title: config.title || config.name,
    description: config.description || "",
    transport: config.transport,
    serverUrl: config.transport === "http" ? config.url : undefined,
    stdio: config.transport === "stdio" && config.command
      ? { command: config.command, args: config.args || [] }
      : undefined,
    requiresAuth: false,
    skills: config.skills || [],
    baseWeight: config.baseWeight || 0,
    loadedWeight: config.loadedWeight || 0,
    modded: false,
    wrappedFrom: config.wrappedFromMeta || { type: "mcp" as const, platform: config.fromPlatform },
    createdAt: now,
    updatedAt: now,
  };

  writeAugmentDef(def);
  return def;
}

// ─── Modding ────────────────────────────────────────────────

/**
 * Apply a user modification to a behavioral field.
 * Preserves the upstream version for diffing/resetting.
 */
export function modAugmentRules(name: string, newRules: AugmentRules): AugmentDef | null {
  const def = readAugmentDef(name);
  if (!def) return null;

  const now = new Date().toISOString();

  // If not already modded, save the current rules as the "original" for undo/diff
  // This applies to all sources — registry augments preserve the upstream version,
  // local augments preserve the original version the user set initially.
  if (!def.modded && def.rules) {
    def.rulesUpstream = { ...def.rules };
  }

  def.rules = newRules;
  def.modded = true;
  def.moddedAt = now;
  def.moddedFields = [...new Set([...(def.moddedFields || []), "rules"])];
  def.updatedAt = now;

  writeAugmentDef(def);
  return def;
}

/** Reset a modded augment's rules back to the upstream version. */
export function resetAugmentRules(name: string): AugmentDef | null {
  const def = readAugmentDef(name);
  if (!def || !def.modded || !def.rulesUpstream) return null;

  const now = new Date().toISOString();

  def.rules = { ...def.rulesUpstream };
  def.rulesUpstream = undefined;
  def.moddedFields = (def.moddedFields || []).filter(f => f !== "rules");
  def.modded = def.moddedFields.length > 0;
  if (!def.modded) {
    def.moddedAt = undefined;
  }
  def.updatedAt = now;

  writeAugmentDef(def);
  return def;
}
