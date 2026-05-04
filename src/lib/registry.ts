// Registry — fetch augment definitions from the equip registry API.
// Handles API fetch with local cache fallback.
// Zero dependencies (uses native fetch).

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import type { AugmentConfig } from "../index";
import type { HookDefinition } from "./hooks";
import type { SkillConfig, SkillFile } from "./skills";
import { validateToolName, validateHookDir, validateUrlScheme } from "./validation";
import type { EquipLogger } from "./types";
import { NOOP_LOGGER } from "./types";
import type { AuthConfig } from "./auth-engine";

// ─── API Configuration ─────────────────────────────────────

export const REGISTRY_API = process.env.EQUIP_REGISTRY_URL || "https://api.cg3.io/equip";
const FETCH_TIMEOUT_MS = 8000;

// ─── Paths ─────────────────────────────────────────────────

import { getEquipHome } from "./equip-home";
function cacheDir(): string { return path.join(getEquipHome(), "cache"); }

function registryCacheKey(): string {
  const normalized = (REGISTRY_API || "registry").trim().replace(/\/+$/, "") || "registry";
  let label = normalized;

  try {
    const url = new URL(normalized);
    label = `${url.protocol.replace(":", "")}-${url.host}${url.pathname}`;
  } catch {
    // Non-URL registry strings are allowed for local/test overrides; sanitize below.
  }

  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "registry";
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `${safeLabel}-${digest}`;
}

function cachePathFor(name: string): string {
  return path.join(cacheDir(), "registries", registryCacheKey(), `${name}.json`);
}

// ─── Post-Install Actions ──────────────────────────────────

export interface PostInstallAction {
  /** Action type. Currently only "open_with_code" is supported. */
  type: "open_with_code";
  /** When to execute: "always", "interactive" (default), or "non_interactive" */
  condition?: "always" | "interactive" | "non_interactive";
  /** URL to call (POST) to get a value */
  url: string;
  /** Send Authorization: Bearer <credential> with the request */
  auth?: boolean;
  /** Dot-notation path to extract from JSON response (e.g., "data.code") */
  codePath: string;
  /** Query parameter name to append to targetUrl (e.g., "cli_code") */
  codeParam: string;
  /** URL to open in browser with the extracted code appended */
  targetUrl: string;
}

// ─── RegistryDef ──────────────────────────────────────────
// Matches the shape returned by GET /equip/augments/:name from the registry API.

export interface RegistryDef {
  name: string;
  /** @deprecated Use title. Kept for backward compatibility with older registry responses. */
  displayName?: string;
  title: string;
  description: string;
  primaryCategory?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  categories?: string[];
  tags?: string[];

  installMode: "direct" | "package";
  installCount?: number;

  // Direct-mode fields
  transport?: string;
  serverUrl?: string;
  envKey?: string;
  requiresAuth?: boolean;
  stdioCommand?: string;
  stdioArgs?: string[];

  // Package-mode fields
  npmPackage?: string;
  setupCommand?: string;

  // Behavioral artifacts
  rules?: {
    content: string;
    version: string;
    marker: string;
    fileName?: string;
  };
  hooks?: HookDefinition[];
  hookDir?: string;
  skills?: SkillConfig[];

  // Platform compatibility
  platforms?: Record<string, unknown>;

  // Auth configuration — declares what auth flow the augment needs
  auth?: AuthConfig;

  // Post-install actions — ordered pipeline of typed actions
  postInstall?: PostInstallAction[];

  // Per-platform messages shown after install
  platformHints?: Record<string, string>;

  // Display metadata (from registry, authoritative)
  rarity?: "common" | "uncommon" | "rare" | "epic" | "legendary";
  subtitle?: string;
  flavorText?: string;
  iconUrl?: string;
  baseWeight?: number;
  loadedWeight?: number;
  verifiedInstallCount?: number;
  activeInstallCount?: number;

  // Publisher
  publisher?: { name: string; slug: string; verified: boolean; avatarUrl?: string };

  // Versioning and content integrity
  version?: number;
  contentHash?: string;
  hashAlgorithm?: string;
}

export type RegistryValidationResult =
  | { status: "fetched"; def: RegistryDef; etag?: string }
  | { status: "not-modified"; etag?: string }
  | { status: "missing" };

// ─── Fetch ─────────────────────────────────────────────────

/**
 * Fetch an augment definition. Resolution order:
 * 1. Registry API (with timeout)
 * 2. Registry-scoped local cache (~/.equip/cache/registries/<registry-key>/<name>.json)
 *
 * Returns null if the augment is not found.
 */
export async function fetchRegistryDef(
  name: string,
  options: { logger?: EquipLogger } = {},
): Promise<RegistryDef | null> {
  validateToolName(name);
  const logger = options.logger || NOOP_LOGGER;

  // 1. Try the registry API
  try {
    const result = await fetchRegistryDefFromApi(name, logger);
    if (result.status === "fetched") {
      cacheAugmentDef(name, result.def, logger);
      return result.def;
    }
    if (result.status === "missing") {
      return null;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug("API fetch failed, falling back to cache", { name, error: msg });
  }

  // 2. Try local cache
  return readCachedAugmentDef(name, logger);
}

/**
 * Validate an augment directly against the live registry.
 * Unlike fetchRegistryDef(), this does not fall back to local cache.
 */
export async function validateAgainstRegistry(
  name: string,
  options: { logger?: EquipLogger; ifNoneMatch?: string } = {},
): Promise<RegistryValidationResult> {
  validateToolName(name);
  const logger = options.logger || NOOP_LOGGER;
  return fetchRegistryDefFromApi(name, logger, { ifNoneMatch: options.ifNoneMatch });
}

// ─── Cache ─────────────────────────────────────────────────

function cacheAugmentDef(name: string, def: RegistryDef, logger: EquipLogger): void {
  try {
    const cachePath = cachePathFor(name);
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(def, null, 2));
    logger.debug("Augment definition cached", { name, path: cachePath });
  } catch (err: unknown) {
    logger.debug("Failed to cache augment definition", { name, error: (err as Error).message });
  }
}

function readCachedAugmentDef(name: string, logger: EquipLogger): RegistryDef | null {
  try {
    const cachePath = cachePathFor(name);
    const raw = fs.readFileSync(cachePath, "utf-8");
    const def = JSON.parse(raw) as RegistryDef;
    logger.info("Augment definition loaded from cache", { name });
    return def;
  } catch {
    return null;
  }
}

async function fetchRegistryDefFromApi(
  name: string,
  logger: EquipLogger,
  options: { ifNoneMatch?: string } = {},
): Promise<RegistryValidationResult> {
  const url = `${REGISTRY_API}/augments/${encodeURIComponent(name)}`;
  const ifNoneMatch = formatIfNoneMatch(options.ifNoneMatch);
  logger.debug("Fetching augment definition from API", { url, conditional: !!ifNoneMatch });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers = ifNoneMatch ? { "If-None-Match": ifNoneMatch } : undefined;
    const res = await fetch(url, { signal: controller.signal, headers });

    if (res.status === 304) {
      logger.info("Augment definition not modified", { name });
      return {
        status: "not-modified",
        etag: extractStrongEtag(res.headers.get("etag")) || options.ifNoneMatch,
      };
    }

    if (res.ok) {
      const raw = await res.json() as RegistryDef & { displayName?: string };
      // Normalize: title is the canonical field, displayName is deprecated
      const def: RegistryDef = { ...raw, title: raw.title || raw.displayName || raw.name };
      logger.info("Augment definition fetched from API", { name, installMode: def.installMode });

      // Compute content hash for parity diagnostics. The check is logged
      // but does not reject because older registry and client hash versions
      // can disagree; rejecting would leave users on stale cache even when
      // the fetched definition is usable. Trust HTTPS/CDN transport integrity
      // and surface the divergence as a warning. `EQUIP_TEST_SKIP_HASH_VERIFY=1`
      // suppresses the warning entirely for integration tests.
      if (def.contentHash && process.env.EQUIP_TEST_SKIP_HASH_VERIFY !== "1") {
        const {
          computeContentHash,
          computeContentHashV2,
          computeContentHashV3,
          extractManifest,
          extractManifestV2,
          extractManifestV3,
        } = await import("./content-hash.js");
        const algorithm = (def.hashAlgorithm || "sha256-v1").toLowerCase();
        const computed = algorithm === "sha256-v3"
          ? computeContentHashV3(extractManifestV3(def))
          : algorithm === "sha256-v2"
            ? computeContentHashV2(extractManifestV2(def))
            : computeContentHash(extractManifest(def));
        if (computed !== def.contentHash) {
          logger.warn("Registry content hash mismatch (non-blocking)", {
            name, expected: def.contentHash, computed, version: def.version, hashAlgorithm: def.hashAlgorithm,
          });
        }
      }

      return {
        status: "fetched",
        def,
        etag: extractStrongEtag(res.headers.get("etag")) || def.contentHash,
      };
    }

    if (res.status === 404) {
      logger.debug("Augment not found in registry", { name });
      return { status: "missing" };
    }

    throw new Error(`Registry API returned ${res.status} for ${name}`);
  } finally {
    clearTimeout(timeout);
  }
}

function formatIfNoneMatch(contentHash?: string): string | undefined {
  const trimmed = contentHash?.trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || trimmed === "*") {
    return trimmed;
  }
  return `"${trimmed}"`;
}

function extractStrongEtag(headerValue: string | null): string | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  const withoutWeakPrefix = trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
  if (withoutWeakPrefix.startsWith("\"") && withoutWeakPrefix.endsWith("\"")) {
    return withoutWeakPrefix.slice(1, -1);
  }
  return withoutWeakPrefix || undefined;
}

// ─── Conversion ────────────────────────────────────────────

/**
 * Convert a RegistryDef (from API/cache) to an AugmentConfig (for the Augment class).
 * Only meaningful for direct-mode augments. Package-mode augments are dispatched via npx.
 */
export function registryDefToConfig(def: RegistryDef, options?: { logger?: EquipLogger }): AugmentConfig {
  const config: AugmentConfig = {
    name: def.name,
    logger: options?.logger,
    augmentVersion: def.version,
    source: "registry",
    package: def.npmPackage,
  };

  if (def.serverUrl) {
    config.serverUrl = def.serverUrl;
  }

  if (def.rules) {
    config.rules = {
      content: def.rules.content,
      version: def.rules.version,
      marker: def.rules.marker,
    };
    if (def.rules.fileName) config.rules.fileName = def.rules.fileName;
  }

  if (def.stdioCommand) {
    // Preserve the historical default for OIDC stdio augments that omit
    // envKey. Registry authors should set envKey explicitly for new augments.
    const defaultEnvKeyForAuth = def.auth?.type === "oidc"
      ? "PRIOR_IDENTITY_ACCESS_TOKEN"
      : "";
    config.stdio = {
      command: def.stdioCommand,
      args: def.stdioArgs || [],
      envKey: def.envKey || defaultEnvKeyForAuth,
    };
  }

  if (def.hooks && def.hooks.length > 0) {
    config.hooks = def.hooks;
  }

  if (def.hookDir) {
    config.hookDir = validateHookDir(def.hookDir);
  }

  // Skills: pass all skills through
  if (def.skills && def.skills.length > 0) {
    config.skills = def.skills;
  }

  return config;
}
