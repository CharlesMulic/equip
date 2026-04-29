// Augment resolver — pure-logic merger over the three storage primitives.
//
// **The single read path for augment content.** Every consumer (auth-engine,
// broker, install/uninstall, doctor, bridge handlers) reads through this
// resolver. Stale-cache bugs become structurally impossible because there
// is exactly one merge order, and it's deterministic.
//
// Read order (in priority):
//   1. defs/<name>.json with kind="local"   → return as-is (sovereign)
//   2. defs/<name>.json with kind="overlay" → merge with cache/<name>.json
//      (overlay's overridable fields take precedence; non-overridable from cache)
//   3. defs/<name>.json with kind="wrapped" → return as-is
//   4. No defs entry but cache/<name>.json exists → return cache (registry-only installed)
//   5. Neither → return null
//
// installs/<name>.json is read SEPARATELY via isInstalled(name) / getInstall(name)
// — the resolver decouples "what is this augment" (defs+cache content merge)
// from "is it installed and where" (install metadata). Mixing them would
// reproduce the conflation we're fixing.
//
// Pkg 02 (2026-04-28): overlay merge enforces the typed allowlist. Only
// `rules`, `skills`, and `hooks` from an OverlayDef merge onto cache content;
// every other field on the overlay's on-disk JSON is silently ignored AND
// surfaces a logged warning at WARN level for security audit. This is the
// phishing-prevention rule from the architect's 2026-04-28 review:
//   - transport / serverUrl / stdio / envKey / auth → never overridable
//     (a malicious overlay could silently redirect MCP traffic or change
//     credentials).
//   - flavorText / subtitle / description / categories / tags / publisher →
//     publisher's brand metadata, stays intact even when behavior is modded.
//   - name / publisher / verified / featured → identity claims belong to
//     the registry.
//
// Per user direction 2026-04-28, `flavorText` is excluded from overlay
// (publisher brand metadata) — final allowlist is exactly rules/skills/hooks.
//
// **Pure function design:** the default-exported singleton uses the real
// stores. For tests, construct via `createResolver({ defsStore, cacheStore,
// installsStore })` with mock stores — no filesystem access needed.

import * as defaultDefsStore from "./defs-store";
import * as defaultCacheStore from "./cache-store";
import * as defaultInstallsStore from "./installs-store";
import type { Def, LocalDef, OverlayDef, WrappedDef } from "./defs-store";
import type { CachedDef } from "./cache-store";
import type { InstallRecord } from "./installs-store";

// ─── Types ──────────────────────────────────────────────────

/**
 * The resolved view of an augment, regardless of which combination of stores
 * contributed to it. Replaces the legacy AugmentDef shape for new consumers;
 * the shim in augment-defs.ts adapts ResolvedAugment → legacy AugmentDef for
 * back-compat with existing readers.
 */
export interface ResolvedAugment {
  // ── Identity ──
  name: string;
  /**
   * Source category — derived from which stores contributed:
   *   - "local"    → defs/ kind=local; no cache
   *   - "overlay"  → defs/ kind=overlay merged with cache/
   *   - "wrapped"  → defs/ kind=wrapped
   *   - "registry" → cache/ only (pure-registry-installed, no defs/ entry)
   * Replaces the old `def.source` denormalized field. Derived, not stored.
   */
  source: "local" | "overlay" | "wrapped" | "registry";
  /** The defs-store kind discriminator if a defs entry contributed. */
  defKind?: "local" | "overlay" | "wrapped";

  // ── Resolution metadata ──
  /** True if cache-store had an entry for this augment. */
  hasCache: boolean;
  /** True if defs-store had an entry. */
  hasDef: boolean;
  /** Pointer back to the cache entry's freshness metadata (for TTL checks in Pkg 03). */
  cacheFetchedAt?: string;
  cacheEtag?: string;
  cacheVersion?: number;
  cacheContentHash?: string;
  cacheRegistryStatus?: CachedDef["registryStatus"];
  cacheRegistryLatestContentHash?: string;
  cacheRegistryLatestSecurityAdvisory?: boolean;

  // ── Content (synthesized from defs + cache merge) ──
  title: string;
  subtitle?: string;
  description: string;
  rarity?: "common" | "uncommon" | "rare" | "epic" | "legendary";
  flavorText?: string;

  transport?: string;
  serverUrl?: string;
  stdio?: { command: string; args: string[]; envKey?: string };
  envKey?: string;
  requiresAuth: boolean;
  auth?: import("./auth-engine").AuthConfig;

  rules?: import("./augment-defs").AugmentRules;
  skills: import("./skills").SkillConfig[];
  hooks?: import("./hooks").HookDefinition[];
  hookDir?: string;

  baseWeight: number;
  loadedWeight: number;

  primaryCategory?: string;
  categories?: string[];
  tags?: string[];

  homepage?: string;
  repository?: string;
  license?: string;

  installCount?: number;
  publisher?: { name: string; slug: string; verified: boolean; avatarUrl?: string | null };

  installMode?: "direct" | "package";
  npmPackage?: string;
  setupCommand?: string;

  platformHints?: Record<string, string>;
  platforms?: Record<string, unknown>;
  postInstallActions?: Record<string, unknown>[];
  authConfig?: Record<string, unknown>;

  // ── Wrapped provenance (only when defKind="wrapped") ──
  wrappedFrom?: import("./augment-defs").WrappedFromMeta;

  // ── Frozen-from-retraction (Pkg 02) ──
  frozen_from_retraction?: {
    name: string;
    retractedAt: string;
    lastSeenContentHash: string;
  };

  // ── Authoring lifecycle (only when defKind="local" and user is publisher) ──
  publishIntent?: boolean;
  publishedVersion?: number;
  hasUnpublishedChanges?: boolean;

  // ── Sidecar-only ──
  lastUserActionAt?: string;
}

/**
 * Dependencies the resolver needs. The default-exported singleton wires the
 * real store modules; tests inject mocks for pure-logic verification.
 */
export interface ResolverDeps {
  defsStore: {
    readDef: (name: string) => Def | null;
    listDefs: () => Def[];
  };
  cacheStore: {
    readCache: (name: string) => CachedDef | null;
    listCache: () => CachedDef[];
  };
  installsStore: {
    readInstall: (name: string) => InstallRecord | null;
    hasInstall: (name: string) => boolean;
    listInstalls: () => InstallRecord[];
  };
}

// ─── Resolver ──────────────────────────────────────────────

export interface AugmentResolver {
  /**
   * Resolve a single augment's content view. Returns null if neither defs
   * nor cache has an entry for this name.
   */
  resolve(name: string): ResolvedAugment | null;
  /** True if installs-store has an entry. */
  isInstalled(name: string): boolean;
  /** Install metadata (or null). */
  getInstall(name: string): InstallRecord | null;
  /**
   * List all known augments (union across defs + cache + installs by name).
   * Each yielded augment is the result of a separate resolve() call.
   */
  list(): ResolvedAugment[];
}

export function createResolver(deps: ResolverDeps): AugmentResolver {
  function resolve(name: string): ResolvedAugment | null {
    const def = deps.defsStore.readDef(name);
    const cache = deps.cacheStore.readCache(name);

    // 1-3. defs-driven cases.
    if (def) {
      if (def.kind === "local") return resolveLocal(def, cache);
      if (def.kind === "overlay") return resolveOverlay(def, cache);
      if (def.kind === "wrapped") return resolveWrapped(def, cache);
    }

    // 4. cache-only case (pure-registry-installed).
    if (cache) {
      return resolveCacheOnly(cache);
    }

    // 5. neither.
    return null;
  }

  function isInstalled(name: string): boolean {
    return deps.installsStore.hasInstall(name);
  }

  function getInstall(name: string): InstallRecord | null {
    return deps.installsStore.readInstall(name);
  }

  function list(): ResolvedAugment[] {
    // Union of all known names across defs + cache + installs.
    const names = new Set<string>();
    for (const d of deps.defsStore.listDefs()) names.add(d.name);
    for (const c of deps.cacheStore.listCache()) names.add(c.name);
    for (const i of deps.installsStore.listInstalls()) names.add(i.name);
    const out: ResolvedAugment[] = [];
    for (const name of names) {
      const r = resolve(name);
      if (r) out.push(r);
    }
    return out;
  }

  return { resolve, isInstalled, getInstall, list };
}

// ─── Resolution shapes (one per kind) ──────────────────────

function resolveLocal(def: LocalDef, _cache: CachedDef | null): ResolvedAugment {
  // Local kind owns its content fully — cache is ignored even if present.
  // (A local augment shouldn't have a cache entry under normal flows; if
  //  one exists from a quirky migration, it's preserved on disk but not
  //  blended in here.)
  return {
    name: def.name,
    source: "local",
    defKind: "local",
    hasCache: false,
    hasDef: true,
    title: def.title,
    subtitle: def.subtitle,
    description: def.description,
    rarity: def.rarity,
    flavorText: def.flavorText,
    transport: def.transport,
    serverUrl: def.serverUrl,
    stdio: def.stdio,
    envKey: def.envKey,
    requiresAuth: def.requiresAuth,
    auth: def.auth,
    rules: def.rules,
    skills: def.skills,
    hooks: def.hooks,
    hookDir: def.hookDir,
    baseWeight: def.baseWeight,
    loadedWeight: def.loadedWeight,
    primaryCategory: def.primaryCategory,
    categories: def.categories,
    tags: def.tags,
    homepage: def.homepage,
    repository: def.repository,
    license: def.license,
    publishIntent: def.publishIntent,
    publishedVersion: def.publishedVersion,
    hasUnpublishedChanges: def.hasUnpublishedChanges,
    authConfig: def.authConfig,
    platformHints: def.platformHints,
    postInstallActions: def.postInstallActions,
    frozen_from_retraction: def.frozen_from_retraction,
    lastUserActionAt: def.lastUserActionAt,
  };
}

function resolveWrapped(def: WrappedDef, _cache: CachedDef | null): ResolvedAugment {
  // Wrapped kind owns its content fully — same as local but with `wrappedFrom`
  // provenance. Cache is ignored (a wrapped augment shouldn't have a cache
  // entry; if one exists, it's preserved but not blended).
  return {
    name: def.name,
    source: "wrapped",
    defKind: "wrapped",
    hasCache: false,
    hasDef: true,
    title: def.title,
    subtitle: def.subtitle,
    description: def.description,
    rarity: def.rarity,
    flavorText: def.flavorText,
    transport: def.transport,
    serverUrl: def.serverUrl,
    stdio: def.stdio,
    envKey: def.envKey,
    requiresAuth: def.requiresAuth,
    auth: def.auth,
    rules: def.rules,
    skills: def.skills,
    hooks: def.hooks,
    hookDir: def.hookDir,
    baseWeight: def.baseWeight,
    loadedWeight: def.loadedWeight,
    primaryCategory: def.primaryCategory,
    categories: def.categories,
    tags: def.tags,
    homepage: def.homepage,
    repository: def.repository,
    license: def.license,
    wrappedFrom: def.wrappedFrom,
    lastUserActionAt: def.lastUserActionAt,
  };
}

/**
 * Fields an overlay is allowed to override (Pkg 02 typed allowlist).
 * Anything else on the overlay's on-disk JSON is silently ignored AND
 * a warning is logged at WARN level for security audit.
 */
const OVERLAY_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "rules",
  "skills",
  "hooks",
]);

/**
 * Structural fields on an OverlayDef — required by the type system or
 * sidecar-only metadata that's not an "overlay merge" field. Allowed on
 * disk without warning.
 */
const OVERLAY_STRUCTURAL_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "kind",
  "overlay_of",
  "createdAt",
  "updatedAt",
  "lastUserActionAt",
]);

/**
 * Defensive audit: warn if an overlay's on-disk JSON carries any field
 * outside the typed allowlist + structural set. This catches:
 *   - Malicious / malformed overlay files written outside the typed write API
 *   - Future code regressions that try to overlay phishing-vector fields
 *   - Migration bugs that copy the wrong fields into an overlay shape
 *
 * Logged at WARN level. Non-fatal — the resolver still returns the cache+
 * allowed-fields merge correctly because resolveOverlay only reads the
 * allowlist fields explicitly.
 */
function auditOverlayFields(def: OverlayDef): void {
  for (const key of Object.keys(def)) {
    if (OVERLAY_STRUCTURAL_FIELDS.has(key)) continue;
    if (OVERLAY_ALLOWED_FIELDS.has(key)) continue;
    // eslint-disable-next-line no-console
    console.warn(
      `[augment-resolver] overlay "${def.name}" carries non-overridable field "${key}" — ignored. ` +
      `Only ${[...OVERLAY_ALLOWED_FIELDS].join("/")} may be overlaid; ` +
      `transport/auth/serverUrl etc. stay on cache by design (phishing prevention).`,
    );
  }
}

function resolveOverlay(def: OverlayDef, cache: CachedDef | null): ResolvedAugment {
  // Pkg 02: defensive audit catches overlay JSONs carrying fields outside
  // the typed allowlist (phishing-prevention security check). Logs warning;
  // non-fatal because the merge below only reads allowlisted fields anyway.
  auditOverlayFields(def);

  if (!cache) {
    // Cache missing for an overlay — defs has overlay but cache hasn't been
    // populated. Surface what we have; consumer should trigger a registry
    // refresh if it cares about complete content. Logged at warn.
    // eslint-disable-next-line no-console
    console.warn(`[augment-resolver] overlay for "${def.name}" has no cache; returning overlay-only fields (consumer should refresh)`);
    return {
      name: def.name,
      source: "overlay",
      defKind: "overlay",
      hasCache: false,
      hasDef: true,
      title: def.name, // best-effort fallback when cache missing
      description: "",
      requiresAuth: false,
      skills: def.skills ?? [],
      hooks: def.hooks,
      rules: def.rules,
      baseWeight: 0,
      loadedWeight: 0,
      lastUserActionAt: def.lastUserActionAt,
    };
  }
  return {
    name: def.name,
    source: "overlay",
    defKind: "overlay",
    hasCache: true,
    hasDef: true,
    cacheFetchedAt: cache.fetchedAt,
    cacheEtag: cache.etag,
    cacheVersion: cache.version,
    cacheContentHash: cache.contentHash,
    cacheRegistryStatus: cache.registryStatus,
    cacheRegistryLatestContentHash: cache.registryLatestContentHash,
    cacheRegistryLatestSecurityAdvisory: cache.registryLatestSecurityAdvisory,
    // Identity / display from cache (publisher's brand metadata).
    title: cache.title,
    subtitle: cache.subtitle,
    description: cache.description,
    rarity: cache.rarity,
    flavorText: cache.flavorText,
    // Infrastructure from cache (NEVER overridable — phishing-prevention rule).
    transport: cache.transport,
    serverUrl: cache.serverUrl,
    stdio: cache.stdioCommand
      ? { command: cache.stdioCommand, args: cache.stdioArgs ?? [], envKey: cache.envKey }
      : undefined,
    envKey: cache.envKey,
    requiresAuth: cache.requiresAuth ?? false,
    auth: cache.auth,
    // Behavioral from overlay (Pkg 01 stub: take overlay if present, else cache).
    // Pkg 02 will enforce the strict allowlist + log non-overridable violations.
    rules: def.rules ?? cache.rules,
    skills: (def.skills ?? cache.skills) ?? [],
    hooks: def.hooks ?? cache.hooks,
    hookDir: cache.hookDir,
    // Display weight + categories from cache.
    baseWeight: cache.baseWeight ?? 0,
    loadedWeight: cache.loadedWeight ?? 0,
    primaryCategory: undefined, // cache doesn't carry primaryCategory in the same shape
    categories: cache.categories,
    tags: undefined,
    // Identity / publisher from cache.
    homepage: cache.homepage,
    repository: cache.repository,
    license: cache.license,
    installCount: cache.installCount,
    publisher: cache.publisher,
    installMode: cache.installMode,
    npmPackage: cache.npmPackage,
    setupCommand: cache.setupCommand,
    platformHints: cache.platformHints,
    platforms: cache.platforms,
    lastUserActionAt: def.lastUserActionAt,
  };
}

function resolveCacheOnly(cache: CachedDef): ResolvedAugment {
  // Pure-registry-installed: no defs entry, just a cache snapshot. Returns
  // the cache's content directly with source="registry".
  return {
    name: cache.name,
    source: "registry",
    defKind: undefined,
    hasCache: true,
    hasDef: false,
    cacheFetchedAt: cache.fetchedAt,
    cacheEtag: cache.etag,
    cacheVersion: cache.version,
    cacheContentHash: cache.contentHash,
    cacheRegistryStatus: cache.registryStatus,
    cacheRegistryLatestContentHash: cache.registryLatestContentHash,
    cacheRegistryLatestSecurityAdvisory: cache.registryLatestSecurityAdvisory,
    title: cache.title,
    subtitle: cache.subtitle,
    description: cache.description,
    rarity: cache.rarity,
    flavorText: cache.flavorText,
    transport: cache.transport,
    serverUrl: cache.serverUrl,
    stdio: cache.stdioCommand
      ? { command: cache.stdioCommand, args: cache.stdioArgs ?? [], envKey: cache.envKey }
      : undefined,
    envKey: cache.envKey,
    requiresAuth: cache.requiresAuth ?? false,
    auth: cache.auth,
    rules: cache.rules,
    skills: cache.skills ?? [],
    hooks: cache.hooks,
    hookDir: cache.hookDir,
    baseWeight: cache.baseWeight ?? 0,
    loadedWeight: cache.loadedWeight ?? 0,
    categories: cache.categories,
    homepage: cache.homepage,
    repository: cache.repository,
    license: cache.license,
    installCount: cache.installCount,
    publisher: cache.publisher,
    installMode: cache.installMode,
    npmPackage: cache.npmPackage,
    setupCommand: cache.setupCommand,
    platformHints: cache.platformHints,
    platforms: cache.platforms,
  };
}

// ─── Default singleton (production-wired) ──────────────────

/**
 * Production resolver wired to the real store modules. Use this from
 * production code via the singleton; tests should use createResolver with
 * mocked stores for pure-logic verification.
 */
export const augmentResolver: AugmentResolver = createResolver({
  defsStore: defaultDefsStore,
  cacheStore: defaultCacheStore,
  installsStore: defaultInstallsStore,
});
