// Migration: legacy single-store layout → three-store architecture.
//
// One-time migration that runs at most once per equip-lib initialization
// (gated by ~/.equip/.schema_version marker). Converts:
//
//   ~/.equip/augments/<name>.json  (legacy single-file mixed-concern shape)
//   ~/.equip/installations.json    (legacy single-file install tracking)
//
// into the new three-store layout:
//
//   ~/.equip/defs/<name>.json      (sovereign content: local / overlay / wrapped)
//   ~/.equip/cache/<name>.json     (registry snapshot + freshness)
//   ~/.equip/installs/<name>.json  (per-augment install metadata)
//
// **Lossless + idempotent.** Re-running with .schema_version >= 2 is a no-op.
// **Backed up.** Original directory + installations.json copied to
// ~/.equip/.backup-pre-storage-refactor/ before writes (one release cycle
// of backup retention).
//
// **Publisher state DROPPED locally** — the legacy `submitted*` fields on
// AugmentDef are not migrated to any new store. The server-side
// PublisherDraftService is canonical; the equip-app reconciler re-fetches
// from server on next page load. Migration logs which augments had publisher
// state for transparency.
//
// **Escape hatches:**
//   - EQUIP_STORAGE_LEGACY_MODE=true → skip migration, run on legacy schema
//     (one release cycle only — removed in a follow-up commit).
//   - EQUIP_STORAGE_MIGRATION_DRY_RUN=true → emit migration plan, write nothing.

import * as fs from "fs";
import * as path from "path";
import { getEquipHome } from "./equip-home";
import { writeDef, type LocalDef, type OverlayDef, type WrappedDef } from "./defs-store";
import { writeCache, type CachedDef } from "./cache-store";
import { writeInstall, type InstallRecord } from "./installs-store";

// SCHEMA_VERSION history:
//   1 — pre-storage-refactor legacy single-store layout.
//   2 — Pkg 01 of equip-storage-refactor: defs/cache/installs/ stores
//       populated from legacy ~/.equip/augments/<name>.json + installations.json
//       via dual-write. Legacy files retained.
//   3 — Cleanup A (post-Pkg-04): legacy augment files rewritten to strip
//       removed publisher-state fields (workingDraftEdit, submittedEdit,
//       submittedRevisionId, submittedStatus, submittedRejectionReason,
//       submittedAt, pendingEdit, pendingReviewId, pendingRejectionReason).
//       Server-side `equip_publisher_drafts` is the single source of truth
//       for those concepts now.
//   4 — Cleanup B (dual-write retirement): legacy ~/.equip/augments/ +
//       installations.json deleted from disk after backup snapshot to
//       ~/.equip/.backup-pre-cleanup-b/. The new defs/cache/installs three-
//       store layout is the only thing on disk. SCHEMA_VERSION constant
//       remains 3 here until Pkg 06 batch 2 (alongside legacy module
//       deletion) — `cleanupBLegacyFiles()` is invokable but doesn't auto-
//       fire from `migrateStorageIfNeeded()` yet, so this batch can land
//       without breaking the dual-write writers that still exist.
const SCHEMA_VERSION = 3;
const CLEANUP_B_SCHEMA_VERSION = 4;
const SCHEMA_VERSION_FILE = ".schema_version";
const LEGACY_AUGMENTS_DIRNAME = "augments";
const LEGACY_INSTALLATIONS_FILENAME = "installations.json";
const BACKUP_DIRNAME = ".backup-pre-storage-refactor";
const CLEANUP_B_BACKUP_DIRNAME = ".backup-pre-cleanup-b";

// Subset of legacy AugmentDef relevant for migration. We declare it locally
// rather than importing because augment-defs.ts will be reimplemented as a
// shim AFTER this migration runs — at migration time we read raw JSON.
interface LegacyAugmentDef {
  name: string;
  source: "registry" | "local" | "wrapped";
  title: string;
  subtitle?: string;
  description: string;
  rarity?: string;
  flavorText?: string;
  installCount?: number;
  transport?: "http" | "stdio";
  serverUrl?: string;
  stdio?: { command: string; args: string[]; envKey?: string };
  requiresAuth: boolean;
  auth?: import("./auth-engine").AuthConfig;
  envKey?: string;
  rules?: import("./augment-defs").AugmentRules;
  rulesUpstream?: import("./augment-defs").AugmentRules;
  skills: import("./skills").SkillConfig[];
  hooks?: import("./hooks").HookDefinition[];
  hookDir?: string;
  baseWeight: number;
  loadedWeight: number;
  weight?: number;
  introspection?: Record<string, unknown> | null;
  modded?: boolean;
  moddedAt?: string;
  moddedFields?: string[];
  registryContentHash?: string;
  registryEtag?: string;
  registryVersionNumber?: number;
  lastValidatedAt?: string;
  registryStatus?: "active" | "retracted" | "pending-review" | "rejected" | "synced-unreviewed";
  registryLatestContentHash?: string;
  registryLatestSecurityAdvisory?: boolean;
  syncedAt?: string;
  publishIntent?: boolean;
  publishedVersion?: number;
  hasUnpublishedChanges?: boolean;
  authConfig?: Record<string, unknown>;
  postInstallActions?: Record<string, unknown>[];
  platformHints?: Record<string, string>;
  wrappedFrom?: import("./augment-defs").WrappedFromMeta | string;
  primaryCategory?: string;
  categories?: string[];
  tags?: string[];
  homepage?: string;
  repository?: string;
  license?: string;
  publisher?: { name: string; slug: string; verified: boolean; avatarUrl?: string | null };
  createdAt: string;
  updatedAt: string;
  // Publisher state — DROPPED LOCALLY by migration:
  workingDraftEdit?: unknown;
  submittedEdit?: unknown;
  submittedRevisionId?: string;
  submittedStatus?: string;
  submittedRejectionReason?: string;
  submittedAt?: string;
  pendingEdit?: unknown;
  pendingReviewId?: string;
  pendingRejectionReason?: string;
  // Sidecar-only:
  lastUserActionAt?: string;
}

interface LegacyInstallationRecord {
  source: "registry" | "local" | "wrapped";
  package?: string;
  title: string;
  transport: "http" | "stdio";
  serverUrl?: string;
  installedAt: string;
  updatedAt: string;
  platforms: string[];
  artifacts: Record<string, import("./installs-store").ArtifactRecord>;
}

interface LegacyInstallations {
  lastUpdated: string;
  augments: Record<string, LegacyInstallationRecord>;
}

export type MigrationStatus =
  | "skipped"           // already at SCHEMA_VERSION
  | "complete"          // migration ran successfully
  | "dry-run"           // EQUIP_STORAGE_MIGRATION_DRY_RUN=true
  | "legacy-mode"       // EQUIP_STORAGE_LEGACY_MODE=true
  | "no-legacy-data";   // fresh install — nothing to migrate

export interface MigrationResult {
  status: MigrationStatus;
  /** Number of augments processed (non-zero only on "complete" or "dry-run"). */
  augmentsMigrated: number;
  /** Augment names that had publisher state in their legacy file (dropped locally). */
  publisherStateDropped: string[];
  /** Path where the backup was written (only on "complete"). */
  backupPath: string | null;
  /** Plan summary keyed by augment name (only on "dry-run" or "complete"). */
  plan?: Record<string, MigrationAction>;
}

export interface MigrationAction {
  /** What gets written to defs/ (if anything) — discriminator + brief content summary. */
  defs?: { kind: "local" | "overlay" | "wrapped"; reason: string };
  /** Whether a cache/ entry gets written. */
  cache?: { reason: string };
  /** Whether an installs/ entry gets written. */
  installs?: { reason: string; platforms: string[] };
  /** True if the legacy file had publisher state we're dropping. */
  publisherStateDropped: boolean;
}

// ─── Public API ────────────────────────────────────────────

export function migrateStorageIfNeeded(opts?: { force?: boolean }): MigrationResult {
  // Escape hatch: EQUIP_STORAGE_LEGACY_MODE=true skips migration entirely.
  if (process.env.EQUIP_STORAGE_LEGACY_MODE === "true") {
    return {
      status: "legacy-mode",
      augmentsMigrated: 0,
      publisherStateDropped: [],
      backupPath: null,
    };
  }

  // Idempotency: skip if .schema_version is already at or above current.
  if (!opts?.force && currentSchemaVersion() >= SCHEMA_VERSION) {
    return {
      status: "skipped",
      augmentsMigrated: 0,
      publisherStateDropped: [],
      backupPath: null,
    };
  }

  const home = getEquipHome();
  const legacyAugmentsDir = path.join(home, LEGACY_AUGMENTS_DIRNAME);
  const legacyInstallationsFile = path.join(home, LEGACY_INSTALLATIONS_FILENAME);

  // Fresh-install case: no legacy data → just stamp the version marker.
  const hasLegacyAugments = fs.existsSync(legacyAugmentsDir);
  const hasLegacyInstallations = fs.existsSync(legacyInstallationsFile);
  if (!hasLegacyAugments && !hasLegacyInstallations) {
    if (!isDryRun()) writeSchemaVersion(SCHEMA_VERSION);
    return {
      status: isDryRun() ? "dry-run" : "no-legacy-data",
      augmentsMigrated: 0,
      publisherStateDropped: [],
      backupPath: null,
    };
  }

  // Build the migration plan (no writes yet).
  const plan = planMigration(legacyAugmentsDir, legacyInstallationsFile);

  // Dry-run: emit plan + bail before any side effects.
  if (isDryRun()) {
    return {
      status: "dry-run",
      augmentsMigrated: Object.keys(plan.actions).length,
      publisherStateDropped: plan.publisherStateDropped,
      backupPath: null,
      plan: plan.actions,
    };
  }

  // Pkg 01 dual-write strategy: populate new stores from legacy data, but
  // KEEP the legacy files in place — they remain authoritative for reads
  // until Pkgs 02-04 migrate consumers to the resolver. Backup is still
  // written for safety + revert capability.
  const previousVersion = currentSchemaVersion();
  const backupPath = (previousVersion < 2)
    ? backupLegacyData(home, hasLegacyAugments, hasLegacyInstallations)
    : null;
  if (previousVersion < 2) {
    applyMigration(plan, legacyAugmentsDir);
  }
  // Schema 3 (Cleanup A): strip removed publisher-state fields from any
  // pre-existing legacy file. Idempotent — running on already-stripped files
  // is a no-op. Runs whether we just did the v1→v2 conversion above OR are
  // bumping a previously-migrated v2 install up to v3.
  if (previousVersion < 3 && hasLegacyAugments) {
    stripPublisherStateFromLegacyFiles(legacyAugmentsDir);
  }
  writeSchemaVersion(SCHEMA_VERSION);

  // NOTE: legacy ~/.equip/augments/ and ~/.equip/installations.json are
  // NOT deleted here. Ongoing dual-write hooks (in augment-defs.ts +
  // installations.ts) keep both stores in sync. Legacy file deletion lands
  // in the dual-write-retirement initiative (Cleanup B), after every reader
  // migrates to the resolver.

  return {
    status: "complete",
    augmentsMigrated: Object.keys(plan.actions).length,
    publisherStateDropped: plan.publisherStateDropped,
    backupPath,
    plan: plan.actions,
  };
}

/**
 * Cleanup A (schema v3): rewrite each legacy `~/.equip/augments/<name>.json`
 * to drop the removed publisher-state fields. Pure on-disk maintenance —
 * the in-memory AugmentDef type already excludes these fields, so subsequent
 * `JSON.stringify(def)` writes wouldn't carry them, but pre-existing files
 * still contain them. This step normalizes them out in one pass.
 *
 * **Data note:** if a user had unsaved working drafts in `def.workingDraftEdit`
 * that were never opened on the publisher edit page since Pkg 04 shipped
 * (which auto-syncs to server-side `equip_publisher_drafts`), those drafts
 * are dropped without a server-side migration. Acceptable trade — the user
 * is the only consumer at this stage and the drafts are recoverable by
 * re-editing.
 */
function stripPublisherStateFromLegacyFiles(legacyAugmentsDir: string): void {
  if (!fs.existsSync(legacyAugmentsDir)) return;
  const files = fs.readdirSync(legacyAugmentsDir).filter((f) => f.endsWith(".json"));
  const PUBLISHER_FIELDS = [
    "workingDraftEdit",
    "submittedEdit",
    "submittedRevisionId",
    "submittedStatus",
    "submittedRejectionReason",
    "submittedAt",
    "pendingEdit",
    "pendingReviewId",
    "pendingRejectionReason",
  ];
  for (const file of files) {
    const filePath = path.join(legacyAugmentsDir, file);
    const raw = readJsonSilent<Record<string, unknown>>(filePath);
    if (!raw) continue;
    let mutated = false;
    for (const field of PUBLISHER_FIELDS) {
      if (field in raw) {
        delete raw[field];
        mutated = true;
      }
    }
    if (mutated) {
      try {
        fs.writeFileSync(filePath, JSON.stringify(raw, null, 2) + "\n");
      } catch {
        // Best effort — failure leaves the field on disk; next sidecar
        // boot retries (currentSchemaVersion stays < 3 because we'll skip
        // writeSchemaVersion if any individual file fails... actually we
        // don't, we still bump the marker. Trade: getting stuck retrying
        // forever on one corrupt file is worse than leaving extra JSON
        // fields on disk that the type system already ignores.).
      }
    }
  }
}

/**
 * Returns true once Cleanup B has retired the legacy stores
 * (`.schema_version` >= 4). Used by the legacy writers in
 * `augment-defs.ts` + `installations.ts` to defensively no-op when the
 * cutover has happened — prevents the recreate-after-deletion failure
 * mode where an old equip-app sidecar binary writes legacy files after
 * the new CLI has run `cleanupBLegacyFiles`. Disappears with the legacy
 * modules in Pkg 06 batch 2.
 */
export function isLegacyStorageRetired(): boolean {
  return currentSchemaVersion() >= CLEANUP_B_SCHEMA_VERSION;
}

/**
 * Read the current on-disk schema version. Returns 1 if marker missing
 * (legacy single-store layout = schema version 1 by definition).
 */
export function currentSchemaVersion(): number {
  const p = path.join(getEquipHome(), SCHEMA_VERSION_FILE);
  try {
    const raw = fs.readFileSync(p, "utf-8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 1;
  } catch {
    return 1;
  }
}

// ─── Planning ──────────────────────────────────────────────

interface MigrationPlan {
  actions: Record<string, MigrationAction>;
  publisherStateDropped: string[];
  /** Defs to write (keyed by augment name). */
  defs: Record<string, LocalDef | OverlayDef | WrappedDef>;
  /** Cache entries to write (keyed by augment name). */
  caches: Record<string, CachedDef>;
  /** Install records to write (keyed by augment name). */
  installs: Record<string, InstallRecord>;
}

function planMigration(legacyAugmentsDir: string, legacyInstallationsFile: string): MigrationPlan {
  const plan: MigrationPlan = {
    actions: {},
    publisherStateDropped: [],
    defs: {},
    caches: {},
    installs: {},
  };

  // Load legacy installations.json once for cross-reference during augment migration.
  const legacyInstalls: LegacyInstallations = readJsonSilent(legacyInstallationsFile) ?? {
    lastUpdated: "",
    augments: {},
  };

  // Walk legacy augments directory.
  const augmentFiles = fs.existsSync(legacyAugmentsDir)
    ? fs.readdirSync(legacyAugmentsDir).filter((f) => f.endsWith(".json"))
    : [];

  for (const file of augmentFiles) {
    const name = file.replace(/\.json$/, "");
    const def = readJsonSilent<LegacyAugmentDef>(path.join(legacyAugmentsDir, file));
    if (!def || !def.name) continue;

    const installEntry = legacyInstalls.augments[def.name];
    const action = planOne(def, installEntry, plan);
    plan.actions[def.name] = action;
    if (action.publisherStateDropped) plan.publisherStateDropped.push(def.name);
  }

  // Catch installations entries with no corresponding legacy augment file
  // (rare — install records normally have a paired augment file). Convert
  // them to install entries; resolver will return null until a refresh
  // populates content.
  for (const [augName, inst] of Object.entries(legacyInstalls.augments)) {
    if (!plan.actions[augName]) {
      plan.installs[augName] = installFromLegacy(augName, inst);
      plan.actions[augName] = {
        installs: { reason: "orphaned-install-entry-no-augment-file", platforms: inst.platforms },
        publisherStateDropped: false,
      };
    }
  }

  return plan;
}

function planOne(
  def: LegacyAugmentDef,
  installEntry: LegacyInstallationRecord | undefined,
  plan: MigrationPlan,
): MigrationAction {
  const action: MigrationAction = { publisherStateDropped: hasPublisherState(def) };

  // Route content based on legacy `source` field.
  if (def.source === "local") {
    const local = legacyToLocalDef(def);
    plan.defs[def.name] = local;
    action.defs = { kind: "local", reason: "legacy source=local" };
  } else if (def.source === "wrapped") {
    const wrapped = legacyToWrappedDef(def);
    plan.defs[def.name] = wrapped;
    action.defs = { kind: "wrapped", reason: "legacy source=wrapped" };
  } else if (def.source === "registry") {
    // Cache always gets the upstream content (rulesUpstream if present, else current rules).
    const cache = legacyRegistryToCache(def);
    plan.caches[def.name] = cache;
    action.cache = { reason: def.modded ? "legacy source=registry, modded → cache=upstream" : "legacy source=registry" };

    // If modded, ALSO write an overlay def with the user's mods.
    if (def.modded === true) {
      const overlay = legacyToOverlayDef(def);
      plan.defs[def.name] = overlay;
      action.defs = { kind: "overlay", reason: "legacy modded=true → overlay with user mods" };
    }
  }

  // installs/ entry from installations.json if present.
  if (installEntry) {
    plan.installs[def.name] = installFromLegacy(def.name, installEntry);
    action.installs = { reason: "from legacy installations.json", platforms: installEntry.platforms };
  }

  return action;
}

// ─── Field-level conversions ───────────────────────────────

function legacyToLocalDef(d: LegacyAugmentDef): LocalDef {
  return {
    name: d.name,
    kind: "local",
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    title: d.title,
    subtitle: d.subtitle,
    description: d.description,
    rarity: d.rarity as LocalDef["rarity"],
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
    primaryCategory: d.primaryCategory,
    categories: d.categories,
    tags: d.tags,
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

function legacyToWrappedDef(d: LegacyAugmentDef): WrappedDef {
  // Migrate legacy string `wrappedFrom` to structured WrappedFromMeta if needed.
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
    rarity: d.rarity as WrappedDef["rarity"],
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
    primaryCategory: d.primaryCategory,
    categories: d.categories,
    tags: d.tags,
    homepage: d.homepage,
    repository: d.repository,
    license: d.license,
    wrappedFrom,
    lastUserActionAt: d.lastUserActionAt,
  };
}

function legacyToOverlayDef(d: LegacyAugmentDef): OverlayDef {
  // Modded registry augment: overlay holds the user's edits, cache holds the upstream.
  // Allowlist: only rules / skills / hooks are modded into the overlay.
  // (flavorText and other non-overridable fields stay on cache, not overlay.)
  const overlay: OverlayDef = {
    name: d.name,
    kind: "overlay",
    overlay_of: d.name,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    lastUserActionAt: d.lastUserActionAt,
  };
  // Always carry the user's current rules (modded or not) — the cache will
  // hold the rulesUpstream for diff/reset later.
  if (d.rules) overlay.rules = d.rules;
  // Skills/hooks: include only if explicitly listed as modded (mirrors the
  // legacy moddedFields semantics).
  if (d.moddedFields?.includes("skills") && d.skills) overlay.skills = d.skills;
  if (d.moddedFields?.includes("hooks") && d.hooks) overlay.hooks = d.hooks;
  return overlay;
}

function legacyRegistryToCache(d: LegacyAugmentDef): CachedDef {
  // For modded registry augments, prefer rulesUpstream (upstream snapshot)
  // for the cache's rules; for unmodded, current d.rules IS the upstream.
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
    rarity: d.rarity as CachedDef["rarity"],
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

function installFromLegacy(name: string, inst: LegacyInstallationRecord): InstallRecord {
  return {
    name,
    installedAt: inst.installedAt,
    updatedAt: inst.updatedAt,
    platforms: inst.platforms,
    artifacts: inst.artifacts,
  };
}

function hasPublisherState(d: LegacyAugmentDef): boolean {
  return d.workingDraftEdit !== undefined
    || d.submittedEdit !== undefined
    || d.submittedRevisionId !== undefined
    || d.submittedStatus !== undefined
    || d.submittedRejectionReason !== undefined
    || d.submittedAt !== undefined
    || d.pendingEdit !== undefined
    || d.pendingReviewId !== undefined
    || d.pendingRejectionReason !== undefined;
}

// ─── Apply ─────────────────────────────────────────────────

function applyMigration(plan: MigrationPlan, _legacyAugmentsDir: string): void {
  for (const def of Object.values(plan.defs)) writeDef(def);
  for (const cache of Object.values(plan.caches)) writeCache(cache);
  for (const install of Object.values(plan.installs)) writeInstall(install);
}

// ─── Backup / cleanup helpers ──────────────────────────────

function backupLegacyData(home: string, hasAugments: boolean, hasInstallations: boolean): string {
  const backupDir = path.join(home, BACKUP_DIRNAME);
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  if (hasAugments) {
    const src = path.join(home, LEGACY_AUGMENTS_DIRNAME);
    const dst = path.join(backupDir, LEGACY_AUGMENTS_DIRNAME);
    copyDirRecursive(src, dst);
  }
  if (hasInstallations) {
    fs.copyFileSync(
      path.join(home, LEGACY_INSTALLATIONS_FILENAME),
      path.join(backupDir, LEGACY_INSTALLATIONS_FILENAME),
    );
  }
  return backupDir;
}

function copyDirRecursive(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function removeDirRecursive(dir: string): void {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeSchemaVersion(version: number): void {
  const home = getEquipHome();
  if (!fs.existsSync(home)) fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, SCHEMA_VERSION_FILE), String(version), "utf-8");
}

function readJsonSilent<T = unknown>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

function isDryRun(): boolean {
  return process.env.EQUIP_STORAGE_MIGRATION_DRY_RUN === "true";
}

// ─── Cleanup B (schema v4): retire legacy on-disk files ────────
//
// Pre-state: ~/.equip/augments/<name>.json + ~/.equip/installations.json
// exist (legacy layout, populated by dual-write or migration). New stores
// (defs/cache/installs) are also populated.
//
// Post-state: legacy augments/ directory + installations.json removed,
// snapshot in .backup-pre-cleanup-b/, .schema_version=4. Idempotent —
// re-running on already-cleaned state is a no-op.
//
// **Safety guarantees:**
//   1. Backup snapshot is written + integrity-verified BEFORE any deletion.
//      File count and per-file byte counts must match between source +
//      backup. On mismatch, the helper aborts WITHOUT deleting (errors[]
//      populated, schema marker not bumped).
//   2. Per-file deletion errors are tolerated (logged into errors[]) but
//      block the schema marker bump — partial cleanup leaves the helper
//      ready to retry on next invocation.
//   3. Windows EBUSY/EPERM/EACCES retry with backoff (12 × 250ms) — handles
//      Tauri sidecar holding handles open during shutdown. Same pattern as
//      `replaceWithRetry` in equip-app/scripts/build-sidecar.mjs.
//
// **Not auto-fired yet:** `migrateStorageIfNeeded()` does NOT call this
// helper. The dual-write writers in augment-defs.ts / installations.ts
// would re-create the legacy files immediately. This helper is intended
// to be wired into `migrateStorageIfNeeded()` ONLY when Pkg 06 batch 2
// deletes the legacy modules entirely. Until then, callers (currently:
// the test suite) invoke it explicitly.
//
// The companion recovery CLI `equip --restore-pre-cleanup-b` (Pkg 06)
// reads from `.backup-pre-cleanup-b/` to reverse the deletion.

export type CleanupBStatus = "no-op" | "complete" | "no-legacy-data" | "skipped" | "precondition-failed";

export interface CleanupBResult {
  status: CleanupBStatus;
  /** Where the snapshot was written (null on no-op / no-legacy-data / precondition-failed). */
  backupPath: string | null;
  /** Number of legacy augment files removed. */
  legacyAugmentsRemoved: number;
  /** True if installations.json was removed. */
  legacyInstallationsRemoved: boolean;
  /** Per-file errors encountered during deletion (non-fatal; blocks schema bump). */
  errors: string[];
}

export interface CleanupBOptions {
  /** Override idempotency check + skip-on-already-bumped behavior. */
  force?: boolean;
  /**
   * When true, refuse to delete legacy if the new stores look empty
   * (defs + cache combined contain zero entries despite legacy having
   * augments). Defense against running cleanup before the v1→v2 migration
   * has populated the new stores.
   *
   * Default false — the test suite invokes the helper in isolation
   * (legacy populated, but the test author knows what they're doing).
   * Production wiring in Pkg 06 batch 2 (auto-firing from
   * `migrateStorageIfNeeded()`) will set this true.
   *
   * On precondition failure, returns status "precondition-failed" with
   * an explanatory error message; nothing is deleted, no snapshot taken.
   */
  requireNewStoresPopulated?: boolean;
}

export function cleanupBLegacyFiles(opts?: CleanupBOptions): CleanupBResult {
  const home = getEquipHome();
  const legacyAugmentsDir = path.join(home, LEGACY_AUGMENTS_DIRNAME);
  const legacyInstallationsFile = path.join(home, LEGACY_INSTALLATIONS_FILENAME);

  // Idempotency: if .schema_version >= 4, this already ran (force overrides).
  if (!opts?.force && currentSchemaVersion() >= CLEANUP_B_SCHEMA_VERSION) {
    return {
      status: "skipped",
      backupPath: null,
      legacyAugmentsRemoved: 0,
      legacyInstallationsRemoved: false,
      errors: [],
    };
  }

  const hasLegacyAugments = fs.existsSync(legacyAugmentsDir);
  const hasLegacyInstallations = fs.existsSync(legacyInstallationsFile);

  // Fresh-install case: no legacy data → just stamp the version marker.
  if (!hasLegacyAugments && !hasLegacyInstallations) {
    writeSchemaVersion(CLEANUP_B_SCHEMA_VERSION);
    return {
      status: "no-legacy-data",
      backupPath: null,
      legacyAugmentsRemoved: 0,
      legacyInstallationsRemoved: false,
      errors: [],
    };
  }

  // Optional precondition: when opts.requireNewStoresPopulated is true,
  // verify the new stores have content before deleting legacy. Catches the
  // failure mode where someone invokes cleanupBLegacyFiles on a fresh
  // install that has legacy files but never ran the v1→v2 migration.
  if (opts?.requireNewStoresPopulated && hasLegacyAugments) {
    const legacyAugmentCount = listJsonFiles(legacyAugmentsDir).length;
    if (legacyAugmentCount > 0) {
      const newStoreEntryCount = countNewStoreEntries(home);
      if (newStoreEntryCount === 0) {
        return {
          status: "precondition-failed",
          backupPath: null,
          legacyAugmentsRemoved: 0,
          legacyInstallationsRemoved: false,
          errors: [
            `precondition failed: legacy has ${legacyAugmentCount} augment file(s) but new stores ` +
            `(defs/ + cache/) are empty. Run migrateStorageIfNeeded() first to populate the new ` +
            `stores via dual-write before retiring legacy.`,
          ],
        };
      }
    }
  }

  // Step 1: snapshot legacy data into .backup-pre-cleanup-b/.
  const backupPath = backupLegacyDataForCleanupB(home, hasLegacyAugments, hasLegacyInstallations);

  // Step 2: verify backup integrity (per-file byte counts + file count).
  const integrityErrors = verifyBackupIntegrity(home, backupPath, hasLegacyAugments, hasLegacyInstallations);
  if (integrityErrors.length > 0) {
    return {
      status: "no-op",
      backupPath,
      legacyAugmentsRemoved: 0,
      legacyInstallationsRemoved: false,
      errors: integrityErrors,
    };
  }

  // Step 3: delete legacy files. Per-file errors collected; one bad file
  // doesn't block the rest.
  const errors: string[] = [];
  let augmentsRemoved = 0;
  if (hasLegacyAugments) {
    const removeResult = removeDirRecursiveWithRetry(legacyAugmentsDir);
    augmentsRemoved = removeResult.removed;
    errors.push(...removeResult.errors);
  }

  let installationsRemoved = false;
  if (hasLegacyInstallations) {
    try {
      unlinkSyncWithRetry(legacyInstallationsFile);
      installationsRemoved = true;
    } catch (e) {
      errors.push(`installations.json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Step 4: bump schema marker only if everything deleted cleanly. Partial
  // state leaves the helper ready to retry next invocation.
  if (errors.length === 0) {
    writeSchemaVersion(CLEANUP_B_SCHEMA_VERSION);
  }

  return {
    status: "complete",
    backupPath,
    legacyAugmentsRemoved: augmentsRemoved,
    legacyInstallationsRemoved: installationsRemoved,
    errors,
  };
}

function backupLegacyDataForCleanupB(home: string, hasAugments: boolean, hasInstallations: boolean): string {
  const backupDir = path.join(home, CLEANUP_B_BACKUP_DIRNAME);
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  if (hasAugments) {
    const src = path.join(home, LEGACY_AUGMENTS_DIRNAME);
    const dst = path.join(backupDir, LEGACY_AUGMENTS_DIRNAME);
    // Re-copy is intentional — if a previous attempt left a partial backup,
    // overwrite with the current legacy state (the source of truth).
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    copyDirRecursive(src, dst);
  }
  if (hasInstallations) {
    fs.copyFileSync(
      path.join(home, LEGACY_INSTALLATIONS_FILENAME),
      path.join(backupDir, LEGACY_INSTALLATIONS_FILENAME),
    );
  }
  return backupDir;
}

function verifyBackupIntegrity(
  home: string,
  backupPath: string,
  hasAugments: boolean,
  hasInstallations: boolean,
): string[] {
  const errors: string[] = [];

  if (hasAugments) {
    const src = path.join(home, LEGACY_AUGMENTS_DIRNAME);
    const dst = path.join(backupPath, LEGACY_AUGMENTS_DIRNAME);
    const srcFiles = listJsonFiles(src);
    const dstFiles = listJsonFiles(dst);
    if (srcFiles.length !== dstFiles.length) {
      errors.push(`augments file count mismatch: source=${srcFiles.length} backup=${dstFiles.length}`);
    } else {
      for (const file of srcFiles) {
        const srcSize = safeStatSize(path.join(src, file));
        const dstSize = safeStatSize(path.join(dst, file));
        if (srcSize !== dstSize) {
          errors.push(`augments/${file}: byte count mismatch (source=${srcSize} backup=${dstSize})`);
        }
      }
    }
  }

  if (hasInstallations) {
    const srcSize = safeStatSize(path.join(home, LEGACY_INSTALLATIONS_FILENAME));
    const dstSize = safeStatSize(path.join(backupPath, LEGACY_INSTALLATIONS_FILENAME));
    if (srcSize !== dstSize) {
      errors.push(`installations.json: byte count mismatch (source=${srcSize} backup=${dstSize})`);
    }
  }

  return errors;
}

function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

/**
 * Count entries across the new stores' directories. Used by the optional
 * `requireNewStoresPopulated` precondition. Combines defs/ + cache/ —
 * either alone is sufficient evidence the v1→v2 migration ran (every
 * legacy augment routes to AT LEAST one of these via the dual-write
 * mirror, regardless of source/modded state).
 */
function countNewStoreEntries(home: string): number {
  const defsDir = path.join(home, "defs");
  const cacheDir = path.join(home, "cache");
  return listJsonFiles(defsDir).length + listJsonFiles(cacheDir).length;
}

function safeStatSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return -1; }
}

function unlinkSyncWithRetry(filePath: string): void {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      fs.unlinkSync(filePath);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return;
      if (!["EBUSY", "EPERM", "EACCES"].includes(code ?? "") || attempt === 12) break;
      sleepMs(250);
    }
  }
  throw lastError;
}

function removeDirRecursiveWithRetry(dir: string): { removed: number; errors: string[] } {
  const errors: string[] = [];
  if (!fs.existsSync(dir)) return { removed: 0, errors };

  // Count files BEFORE deletion for the result.
  const filesBefore = listJsonFiles(dir).length;

  // Try the recursive nuke first (fast path, succeeds in tests + most cases).
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return { removed: filesBefore, errors };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return { removed: filesBefore, errors };
      if (!["EBUSY", "EPERM", "EACCES"].includes(code ?? "") || attempt === 12) {
        errors.push(`augments/: ${error instanceof Error ? error.message : String(error)}`);
        return { removed: 0, errors };
      }
      sleepMs(250);
    }
  }
  return { removed: 0, errors };
}

function sleepMs(ms: number): void {
  // Synchronous sleep using Atomics.wait — matches the pattern used in
  // equip-app/scripts/build-sidecar.mjs's replaceWithRetry. Acceptable
  // here because cleanupBLegacyFiles runs at startup, not in the hot path.
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer can be unavailable in some sandboxed contexts —
    // fall back to a busy-wait loop. Cleanup B is a once-per-install flow,
    // so the inefficiency is acceptable for the rare fallback case.
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}
