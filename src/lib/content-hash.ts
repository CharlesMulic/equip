// Content hash computation for augment integrity verification.
// Must produce identical output to the Kotlin implementation in ContentHashService.kt.
// Uses a positional JSON array to eliminate key-ordering ambiguity across languages.

import * as crypto from "crypto";

export interface ContentManifest {
  rulesContent: string | null;
  rulesMarker: string | null;
  skills: string | null;    // JSON string of skills array (normalized)
  hooks: string | null;     // JSON string of hooks array
  serverUrl: string | null;
  stdioCommand: string | null;
  stdioArgs: string | null; // JSON string of args array
  transport: string | null;
}

/**
 * Compute the **v1** content hash for an augment definition.
 * SHA-256 of a canonical JSON array of security-relevant fields.
 * Retained for backward compat during the v1→v2 backfill window —
 * new publish / update code paths should use computeContentHashV3.
 */
export function computeContentHash(manifest: ContentManifest): string {
  const canonical = JSON.stringify([
    manifest.rulesContent,
    manifest.rulesMarker,
    manifest.skills ? normalizeSkills(manifest.skills) : null,
    manifest.hooks,
    manifest.serverUrl,
    manifest.stdioCommand,
    manifest.stdioArgs,
    manifest.transport,
  ]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Phase 4 of MANUAL_UPDATE_PLAN — **v2** content hash.
 *
 * Extends v1 with publisher-editable display + metadata fields so a
 * title-only change mutates the hash. Without this, Phase 1's
 * /updates/check endpoint can't detect display-only edits; with it,
 * the client sees the hash change and the user can decide to apply
 * the update.
 *
 * **Must produce byte-identical output** to the Kotlin impl in
 * equip-product/ContentHashService.kt `computeContentHashV2`. The
 * ContentHashGoldenTest suite enforces this with a lockstep vector.
 */
export interface ContentManifestV2 extends ContentManifest {
  title: string | null;
  description: string | null;
  subtitle: string | null;
  flavorText: string | null;
  primaryCategory: string | null;
  /** Raw array; computeContentHashV2 sorts it for stable ordering. */
  categories: string[] | null;
  /** Public discoverability metadata; included so pending/live tag changes hash distinctly. */
  tags: string[] | null;
  homepage: string | null;
  repository: string | null;
  iconUrl: string | null;
}

export function computeContentHashV2(manifest: ContentManifestV2): string {
  // Categories: stable ordering — ["a","b"] and ["b","a"] must hash the
  // same, because the registry doesn't make array order semantic.
  const sortedCategories = manifest.categories
    ? [...manifest.categories].sort()
    : null;
  const sortedTags = manifest.tags
    ? [...manifest.tags].sort()
    : null;

  const canonical = JSON.stringify([
    manifest.rulesContent,
    manifest.rulesMarker,
    manifest.skills ? normalizeSkills(manifest.skills) : null,
    manifest.hooks,
    manifest.serverUrl,
    manifest.stdioCommand,
    manifest.stdioArgs,
    manifest.transport,
    manifest.title,
    manifest.description,
    manifest.subtitle,
    manifest.flavorText,
    manifest.primaryCategory,
    sortedCategories,
    sortedTags,
    manifest.homepage,
    manifest.repository,
    manifest.iconUrl,
  ]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * v3 adds the runtime auth contract to v2. Auth-only registry updates
 * must change contentHash so /updates/check can move installed clients
 * onto the right credential behavior.
 */
export interface ContentManifestV3 extends ContentManifestV2 {
  requiresAuth: boolean;
  authConfig: unknown | null;
}

export function computeContentHashV3(manifest: ContentManifestV3): string {
  const sortedCategories = manifest.categories
    ? [...manifest.categories].sort()
    : null;
  const sortedTags = manifest.tags
    ? [...manifest.tags].sort()
    : null;

  const canonical = JSON.stringify([
    manifest.rulesContent,
    manifest.rulesMarker,
    manifest.skills ? normalizeSkills(manifest.skills) : null,
    manifest.hooks,
    manifest.serverUrl,
    manifest.stdioCommand,
    manifest.stdioArgs,
    manifest.transport,
    manifest.title,
    manifest.description,
    manifest.subtitle,
    manifest.flavorText,
    manifest.primaryCategory,
    sortedCategories,
    sortedTags,
    manifest.homepage,
    manifest.repository,
    manifest.iconUrl,
    manifest.requiresAuth,
    manifest.requiresAuth ? canonicalizeJson(manifest.authConfig) : null,
  ]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Extract a ContentManifest from a RegistryDef-like object.
 * Works with both the registry API response and the local AugmentDef.
 */
export function extractManifest(def: {
  rules?: { content: string; marker: string } | null;
  skills?: { name: string; files: { path: string; content: string }[] }[] | null;
  hooks?: unknown[] | null;
  serverUrl?: string | null;
  stdioCommand?: string | null;
  stdioArgs?: string[] | null;
  transport?: string | null;
}): ContentManifest {
  return {
    rulesContent: def.rules?.content ?? null,
    rulesMarker: def.rules?.marker ?? null,
    skills: def.skills && def.skills.length > 0
      ? JSON.stringify(def.skills)
      : null,
    hooks: def.hooks && (def.hooks as unknown[]).length > 0
      ? JSON.stringify(def.hooks)
      : null,
    serverUrl: def.serverUrl ?? null,
    stdioCommand: def.stdioCommand ?? null,
    stdioArgs: def.stdioArgs && def.stdioArgs.length > 0
      ? JSON.stringify(def.stdioArgs)
      : null,
    transport: def.transport ?? null,
  };
}

export function extractManifestV2(def: {
  rules?: { content: string; marker: string } | null;
  skills?: { name: string; files: { path: string; content: string }[] }[] | null;
  hooks?: unknown[] | null;
  serverUrl?: string | null;
  stdioCommand?: string | null;
  stdioArgs?: string[] | null;
  transport?: string | null;
  title?: string | null;
  description?: string | null;
  subtitle?: string | null;
  flavorText?: string | null;
  primaryCategory?: string | null;
  categories?: string[] | null;
  tags?: string[] | null;
  homepage?: string | null;
  repository?: string | null;
  iconUrl?: string | null;
}): ContentManifestV2 {
  return {
    ...extractManifest(def),
    title: def.title ?? null,
    description: def.description ?? null,
    subtitle: def.subtitle ?? null,
    flavorText: def.flavorText ?? null,
    primaryCategory: def.primaryCategory ?? null,
    categories: def.categories && def.categories.length > 0 ? def.categories : null,
    tags: def.tags && def.tags.length > 0 ? def.tags : null,
    homepage: def.homepage ?? null,
    repository: def.repository ?? null,
    iconUrl: def.iconUrl ?? null,
  };
}

export function extractManifestV3(def: Parameters<typeof extractManifestV2>[0] & {
  requiresAuth?: boolean | null;
  auth?: unknown | null;
}): ContentManifestV3 {
  return {
    ...extractManifestV2(def),
    requiresAuth: def.requiresAuth ?? false,
    authConfig: def.auth ?? null,
  };
}

/**
 * Normalize skills JSON for deterministic hashing.
 * Sorts skills by name, files within each skill by path.
 */
function normalizeSkills(skillsJson: string): string {
  try {
    const skills = JSON.parse(skillsJson) as { name: string; files: { path: string; content: string }[] }[];
    const sorted = [...skills]
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .map(s => ({
        ...s,
        files: s.files
          ? [...s.files].sort((a, b) => (a.path || "").localeCompare(b.path || ""))
          : s.files,
      }));
    return JSON.stringify(sorted);
  } catch {
    return skillsJson;
  }
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalizeJson(record[key]);
        return acc;
      }, {});
  }
  return value ?? null;
}
