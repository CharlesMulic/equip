// Registry — fetch augment definitions from the equip registry API.
// Handles API fetch with local cache fallback.
// Zero dependencies (uses native fetch).

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AugmentConfig } from "../index";
import type { HookDefinition } from "./hooks";
import type { SkillConfig, SkillFile } from "./skills";
import type { EquipLogger } from "./types";
import { NOOP_LOGGER } from "./types";
import type { AuthConfig } from "./auth-engine";

// ─── API Configuration ─────────────────────────────────────

export const REGISTRY_API = "https://api.cg3.io/equip";
const FETCH_TIMEOUT_MS = 3000;

// ─── Paths ─────────────────────────────────────────────────

function cacheDir(): string { return path.join(os.homedir(), ".equip", "cache"); }

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

// ─── ToolDefinition ────────────────────────────────────────
// Matches the shape returned by GET /tools/:name from equip-backend.

export interface ToolDefinition {
  name: string;
  displayName: string;
  description: string;
  homepage?: string;
  repository?: string;
  license?: string;
  categories?: string[];

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
}

// ─── Fetch ─────────────────────────────────────────────────

/**
 * Fetch an augment definition. Resolution order:
 * 1. Registry API (with timeout)
 * 2. Local cache (~/.equip/cache/<name>.json)
 *
 * Returns null if the augment is not found.
 */
export async function fetchToolDef(
  name: string,
  options: { logger?: EquipLogger } = {},
): Promise<ToolDefinition | null> {
  const logger = options.logger || NOOP_LOGGER;

  // 1. Try the registry API
  try {
    const url = `${REGISTRY_API}/tools/${encodeURIComponent(name)}`;
    logger.debug("Fetching augment definition from API", { url });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const def = await res.json() as ToolDefinition;
      logger.info("Augment definition fetched from API", { name, installMode: def.installMode });
      cacheToolDef(name, def, logger);
      return def;
    }

    if (res.status === 404) {
      logger.debug("Augment not found in registry", { name });
      return null;
    }

    logger.warn("API returned unexpected status", { name, status: res.status });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug("API fetch failed, falling back to cache", { name, error: msg });
  }

  // 2. Try local cache
  return readCachedToolDef(name, logger);
}

// ─── Cache ─────────────────────────────────────────────────

function cacheToolDef(name: string, def: ToolDefinition, logger: EquipLogger): void {
  try {
    const dir = cacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const cachePath = path.join(dir, `${name}.json`);
    fs.writeFileSync(cachePath, JSON.stringify(def, null, 2));
    logger.debug("Augment definition cached", { name, path: cachePath });
  } catch (err: unknown) {
    logger.debug("Failed to cache augment definition", { name, error: (err as Error).message });
  }
}

function readCachedToolDef(name: string, logger: EquipLogger): ToolDefinition | null {
  try {
    const cachePath = path.join(cacheDir(), `${name}.json`);
    const raw = fs.readFileSync(cachePath, "utf-8");
    const def = JSON.parse(raw) as ToolDefinition;
    logger.info("Augment definition loaded from cache", { name });
    return def;
  } catch {
    return null;
  }
}

// ─── Conversion ────────────────────────────────────────────

/**
 * Convert a ToolDefinition (from API/cache) to an AugmentConfig (for the Augment class).
 * Only meaningful for direct-mode augments. Package-mode augments are dispatched via npx.
 */
export function toolDefToEquipConfig(def: ToolDefinition, options?: { logger?: EquipLogger }): AugmentConfig {
  const config: AugmentConfig = {
    name: def.name,
    logger: options?.logger,
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
    config.stdio = {
      command: def.stdioCommand,
      args: def.stdioArgs || [],
      envKey: def.envKey || "",
    };
  }

  if (def.hooks && def.hooks.length > 0) {
    config.hooks = def.hooks;
  }

  if (def.hookDir) {
    config.hookDir = def.hookDir.replace(/^~/, os.homedir());
  }

  // Skills: pass all skills through
  if (def.skills && def.skills.length > 0) {
    config.skills = def.skills;
  }

  return config;
}
