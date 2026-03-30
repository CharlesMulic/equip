// Registry — fetch tool definitions from the equip registry API.
// Handles API fetch, local cache, and registry.json fallback.
// Zero dependencies (uses native fetch).

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { EquipConfig } from "../index";
import type { HookDefinition } from "./hooks";
import type { SkillConfig, SkillFile } from "./skills";
import type { EquipLogger } from "./types";
import { NOOP_LOGGER } from "./types";
import type { AuthConfig } from "./auth-engine";

// ─── API Configuration ─────────────────────────────────────

const REGISTRY_API = "https://api.cg3.io/equip";
const FETCH_TIMEOUT_MS = 3000;

// ─── Paths ─────────────────────────────────────────────────

const EQUIP_DIR = path.join(os.homedir(), ".equip");
const CACHE_DIR = path.join(EQUIP_DIR, "cache");

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

  // Auth configuration — declares what auth flow the tool needs
  auth?: AuthConfig;

  // Post-install behavior
  postInstallUrl?: string;
  dashboardUrl?: string;
  platformHints?: Record<string, string>;
}

// ─── Local Registry Entry ──────────────────────────────────
// Shape of entries in registry.json (the local fallback).

export interface LocalRegistryEntry {
  package: string;
  command: string;
  description?: string;
  marker?: string;
  hookDir?: string;
  skillName?: string;
  installMode?: "direct" | "package";
}

// ─── Fetch ─────────────────────────────────────────────────

/**
 * Fetch a tool definition. Resolution order:
 * 1. Registry API (with timeout)
 * 2. Local cache (~/.equip/cache/<name>.json)
 * 3. Local registry.json (bundled with equip)
 *
 * Returns null if the tool is not found anywhere.
 */
export async function fetchToolDef(
  name: string,
  options: { logger?: EquipLogger; registryPath?: string } = {},
): Promise<ToolDefinition | null> {
  const logger = options.logger || NOOP_LOGGER;

  // 1. Try the registry API
  try {
    const url = `${REGISTRY_API}/tools/${encodeURIComponent(name)}`;
    logger.debug("Fetching tool definition from API", { url });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const def = await res.json() as ToolDefinition;
      logger.info("Tool definition fetched from API", { name, installMode: def.installMode });
      cacheToolDef(name, def, logger);
      return def;
    }

    if (res.status === 404) {
      logger.debug("Tool not found in API registry", { name });
      // Don't fall through to cache for explicit 404 — tool doesn't exist
      // But still check local registry.json (it may be a local-only tool)
      return readLocalRegistry(name, options.registryPath, logger);
    }

    logger.warn("API returned unexpected status", { name, status: res.status });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug("API fetch failed, falling back to cache", { name, error: msg });
  }

  // 2. Try local cache
  const cached = readCachedToolDef(name, logger);
  if (cached) return cached;

  // 3. Try local registry.json
  return readLocalRegistry(name, options.registryPath, logger);
}

// ─── Cache ─────────────────────────────────────────────────

function cacheToolDef(name: string, def: ToolDefinition, logger: EquipLogger): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const cachePath = path.join(CACHE_DIR, `${name}.json`);
    fs.writeFileSync(cachePath, JSON.stringify(def, null, 2));
    logger.debug("Tool definition cached", { name, path: cachePath });
  } catch (err: unknown) {
    logger.debug("Failed to cache tool definition", { name, error: (err as Error).message });
  }
}

function readCachedToolDef(name: string, logger: EquipLogger): ToolDefinition | null {
  try {
    const cachePath = path.join(CACHE_DIR, `${name}.json`);
    const raw = fs.readFileSync(cachePath, "utf-8");
    const def = JSON.parse(raw) as ToolDefinition;
    logger.info("Tool definition loaded from cache", { name });
    return def;
  } catch {
    return null;
  }
}

// ─── Local Registry ────────────────────────────────────────

/**
 * Read a tool from the local registry.json bundled with equip.
 * Converts the local format to ToolDefinition.
 */
function readLocalRegistry(
  name: string,
  registryPath: string | undefined,
  logger: EquipLogger,
): ToolDefinition | null {
  try {
    const regPath = registryPath || path.join(__dirname, "..", "..", "registry.json");
    const raw = fs.readFileSync(regPath, "utf-8");
    const registry = JSON.parse(raw) as Record<string, LocalRegistryEntry>;
    const entry = registry[name];
    if (!entry || name.startsWith("$")) return null;

    logger.info("Tool found in local registry.json", { name });
    return localEntryToToolDef(name, entry);
  } catch {
    return null;
  }
}

function localEntryToToolDef(name: string, entry: LocalRegistryEntry): ToolDefinition {
  return {
    name,
    displayName: entry.description || name,
    description: entry.description || "",
    installMode: entry.installMode || "package",
    npmPackage: entry.package,
    setupCommand: entry.command,
  };
}

// ─── Conversion ────────────────────────────────────────────

/**
 * Convert a ToolDefinition (from API/cache) to an EquipConfig (for the Equip class).
 * Only meaningful for direct-mode tools. Package-mode tools are dispatched via npx.
 */
export function toolDefToEquipConfig(def: ToolDefinition, options?: { logger?: EquipLogger }): EquipConfig {
  const config: EquipConfig = {
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

  // Skills: API returns an array, EquipConfig expects a single skill.
  // Use the first skill if present.
  if (def.skills && def.skills.length > 0) {
    config.skill = def.skills[0];
  }

  return config;
}
