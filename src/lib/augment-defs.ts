// Augment Definitions — persistent local source of truth for what each augment IS.
//
// Each augment gets a definition file at ~/.equip/augments/<name>.json.
// Registry augments are synced from the API. Local augments are user-created.
// Modded augments preserve the user's behavioral customizations (rules, hooks, skills)
// while tracking the upstream version for diff/reset.
//
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { atomicWriteFileSync, safeReadJsonSync } from "./fs";
import { validateToolName } from "./validation";
import type { SkillConfig } from "./skills";
import type { HookDefinition } from "./hooks";
import type { RegistryDef } from "./registry";

// ─── Types ──────────────────────────────────────────────────

export type AugmentSource = "registry" | "local" | "wrapped";

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

  /** Human-readable name */
  displayName: string;

  /** One-line description */
  description: string;

  /** Rarity tier */
  rarity?: "common" | "uncommon" | "rare" | "epic" | "legendary";

  /** Short title for compact display (e.g., "Prior") */
  title?: string;

  /** Subtitle shown below title (e.g., "Agent Knowledge Base") */
  subtitle?: string;

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

  /** Registry version this definition was synced from */
  registryVersion?: string;

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
  displayName?: string;
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
  displayName?: string;
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
function getEquipDir(): string { return path.join(os.homedir(), ".equip"); }
export function getAugmentsDir(): string { return path.join(getEquipDir(), "augments"); }

function augmentPath(name: string): string {
  validateToolName(name);
  return path.join(getAugmentsDir(), `${name}.json`);
}

function ensureAugmentsDir(): void {
  const dir = getAugmentsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── CRUD ───────────────────────────────────────────────────

/** Read an augment definition by name. Returns null if not found. */
export function readAugmentDef(name: string): AugmentDef | null {
  const filePath = augmentPath(name);
  const { data, status } = safeReadJsonSync(filePath);

  if (status === "missing") return null;
  if (status === "corrupt") {
    // Back up corrupt file, return null
    try { fs.copyFileSync(filePath, filePath + ".corrupt.bak"); } catch {}
    return null;
  }

  const def = data as unknown as AugmentDef;

  // Lazy migration: old single `weight` → baseWeight + loadedWeight
  if (def.baseWeight === undefined && (def as any).weight !== undefined) {
    def.baseWeight = (def as any).weight;
    def.loadedWeight = 0;
  }
  // Ensure defaults
  if (def.baseWeight === undefined) def.baseWeight = 0;
  if (def.loadedWeight === undefined) def.loadedWeight = 0;

  // Lazy migration: old wrappedFrom string → structured WrappedFromMeta
  if (typeof def.wrappedFrom === "string") {
    def.wrappedFrom = { type: "mcp", platform: def.wrappedFrom };
  }

  // Lazy migration: clear phantom transport on skill-only augments
  // (Before transport was made optional, skill-only augments got transport: "stdio" as a placeholder)
  if (def.transport && !def.serverUrl && !def.stdio) {
    def.transport = undefined;
  }

  return def;
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
  ensureAugmentsDir();
  atomicWriteFileSync(augmentPath(def.name), JSON.stringify(def, null, 2) + "\n");
}

/** List all augment definitions. */
export function listAugmentDefs(): AugmentDef[] {
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
  const filePath = augmentPath(name);
  try {
    fs.unlinkSync(filePath);
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

  if (existing) {
    // Local or wrapped augment with this name already exists — don't overwrite.
    // User's local content is sovereign over registry definitions.
    return existing;
  }

  // Create new definition from registry
  const def: AugmentDef = {
    name: registryDef.name,
    source: "registry",
    displayName: registryDef.displayName || registryDef.name,
    description: registryDef.description || "",
    transport: (registryDef.transport as "http" | "stdio") || "http",
    serverUrl: registryDef.serverUrl,
    stdio: registryDef.stdioCommand
      ? { command: registryDef.stdioCommand, args: registryDef.stdioArgs || [], envKey: registryDef.envKey }
      : undefined,
    requiresAuth: registryDef.requiresAuth || false,
    envKey: registryDef.envKey,
    rules: registryDef.rules ? { ...registryDef.rules } : undefined,
    skills: registryDef.skills || [],
    hooks: registryDef.hooks,
    hookDir: registryDef.hookDir,
    rarity: registryDef.rarity || "common",
    title: registryDef.title,
    subtitle: registryDef.subtitle,
    flavorText: registryDef.flavorText,
    baseWeight: registryDef.baseWeight || 0,
    loadedWeight: registryDef.loadedWeight || 0,
    installCount: registryDef.installCount || 0,
    modded: false,
    registryVersion: registryDef.rules?.version || "1.0.0",
    syncedAt: now,
    homepage: registryDef.homepage,
    repository: registryDef.repository,
    license: registryDef.license,
    categories: registryDef.categories,
    publisher: registryDef.publisher,
    createdAt: now,
    updatedAt: now,
  };

  writeAugmentDef(def);
  return def;
}

/** Update an existing registry definition, preserving mods. */
function updateFromRegistry(existing: AugmentDef, registryDef: RegistryDef, now: string): AugmentDef {
  const newVersion = registryDef.rules?.version || "1.0.0";
  const oldVersion = existing.registryVersion || "";
  const versionChanged = newVersion !== oldVersion;

  const updated: AugmentDef = {
    ...existing,
    // Always update infrastructure fields from registry
    displayName: registryDef.displayName || existing.displayName,
    description: registryDef.description || existing.description,
    transport: (registryDef.transport as "http" | "stdio") || existing.transport,
    serverUrl: registryDef.serverUrl || existing.serverUrl,
    stdio: registryDef.stdioCommand
      ? { command: registryDef.stdioCommand, args: registryDef.stdioArgs || [], envKey: registryDef.envKey }
      : existing.stdio,
    requiresAuth: registryDef.requiresAuth ?? existing.requiresAuth,
    envKey: registryDef.envKey || existing.envKey,
    homepage: registryDef.homepage || existing.homepage,
    repository: registryDef.repository || existing.repository,
    license: registryDef.license || existing.license,
    categories: registryDef.categories || existing.categories,
    publisher: registryDef.publisher || existing.publisher,
    // Display metadata — always sync from registry (authoritative source)
    rarity: registryDef.rarity || existing.rarity,
    title: registryDef.title || existing.title,
    subtitle: registryDef.subtitle || existing.subtitle,
    flavorText: registryDef.flavorText || existing.flavorText,
    installCount: registryDef.installCount ?? existing.installCount,
    registryVersion: newVersion,
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

// ─── Local Augments ─────────────────────────────────────────

/** Create a new local augment definition. */
export function createLocalAugment(config: LocalAugmentConfig): AugmentDef {
  const now = new Date().toISOString();

  const def: AugmentDef = {
    name: config.name,
    source: "local",
    displayName: config.displayName || config.name,
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
    displayName: config.displayName || config.name,
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
