// State migration — converts legacy state.json to the new multi-file architecture.
//
// Called on first run with new code. Idempotent — skips if new files already exist.
//
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { readInstallations, writeInstallations, type Installations, type InstallationRecord, type ArtifactRecord } from "./installations";

// Legacy types inlined from the deleted state.ts module — only used for reading old state.json
interface LegacyToolPlatformRecord {
  configPath: string;
  transport: string;
  rulesPath?: string;
  rulesVersion?: string;
  hookDir?: string;
  hookScripts?: string[];
  skillsPath?: string;
  skillName?: string;
  skillNames?: string[];
  equipVersion?: string;
}

interface LegacyToolRecord {
  package: string;
  installedAt: string;
  updatedAt?: string;
  platforms: Record<string, LegacyToolPlatformRecord>;
}

interface LegacyEquipState {
  equipVersion: string;
  lastUpdated: string;
  tools: Record<string, LegacyToolRecord>;
}
import { readAugmentDef, writeAugmentDef, syncFromRegistry, type AugmentDef } from "./augment-defs";
import { writeEquipMeta, type EquipMeta } from "./equip-meta";
import { safeReadJsonSync } from "./fs";
import type { ToolDefinition } from "./registry";

// ─── Types ──────────────────────────────────────────────────

export interface MigrationResult {
  migrated: boolean;
  augmentsCreated: number;
  installationsCreated: number;
  equipMetaCreated: boolean;
  stateRenamed: boolean;
  errors: string[];
}

// ─── Paths ──────────────────────────────────────────────────

function equipDir(): string { return path.join(os.homedir(), ".equip"); }
function statePath(): string { return path.join(equipDir(), "state.json"); }
function installationsPath(): string { return path.join(equipDir(), "installations.json"); }
function equipMetaPath(): string { return path.join(equipDir(), "equip.json"); }
function cachePath(name: string): string { return path.join(equipDir(), "cache", `${name}.json`); }
function augmentPath(name: string): string { return path.join(equipDir(), "augments", `${name}.json`); }

// ─── Migration ──────────────────────────────────────────────

/**
 * Migrate from legacy state.json to the new multi-file architecture.
 * Idempotent — skips if installations.json already exists.
 *
 * Steps:
 * 1. Read state.json
 * 2. For each tool: create augment definition from cache (if available) or minimal stub
 * 3. Create installations.json from state's tool→platform records
 * 4. Create equip.json from state metadata
 * 5. Rename state.json → state.json.migrated
 *
 * Note: platforms.json and platforms/<id>.json are NOT created here.
 * They're populated by the next scan (which happens on app launch or CLI run).
 */
export function migrateState(): MigrationResult {
  const result: MigrationResult = {
    migrated: false,
    augmentsCreated: 0,
    installationsCreated: 0,
    equipMetaCreated: false,
    stateRenamed: false,
    errors: [],
  };

  // Check if migration is needed
  if (!fs.existsSync(statePath())) {
    return result; // nothing to migrate
  }
  if (fs.existsSync(installationsPath())) {
    return result; // already migrated
  }

  const state = readStateFromPath(statePath());
  if (!state || Object.keys(state.tools).length === 0) {
    return result; // empty state, nothing to migrate
  }

  result.migrated = true;

  // 1. Create augment definitions from cache + state
  for (const [toolName, toolRecord] of Object.entries(state.tools)) {
    try {
      if (!fs.existsSync(augmentPath(toolName))) {
        createAugmentFromState(toolName, toolRecord);
        result.augmentsCreated++;
      }
    } catch (e: any) {
      result.errors.push(`augment ${toolName}: ${e.message}`);
    }
  }

  // 2. Create installations.json
  try {
    const installations = buildInstallations(state);
    writeInstallations(installations);
    result.installationsCreated = Object.keys(installations.augments).length;
  } catch (e: any) {
    result.errors.push(`installations: ${e.message}`);
  }

  // 3. Create equip.json
  try {
    const meta: EquipMeta = {
      version: state.equipVersion || "",
      lastUpdated: state.lastUpdated || new Date().toISOString(),
      lastScan: "",
      preferences: {
        telemetry: true,
        autoScan: true,
        scanIntervalMinutes: 60,
      },
    };
    writeEquipMeta(meta);
    result.equipMetaCreated = true;
  } catch (e: any) {
    result.errors.push(`equip.json: ${e.message}`);
  }

  // 4. Rename state.json (keep for safety, don't delete)
  try {
    fs.renameSync(statePath(), statePath() + ".migrated");
    result.stateRenamed = true;
  } catch (e: any) {
    result.errors.push(`rename state.json: ${e.message}`);
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────────────

function createAugmentFromState(toolName: string, toolRecord: any): void {
  // Try to read cached tool definition from ~/.equip/cache/<name>.json
  const cached = readCachedToolDef(toolName);

  if (cached) {
    // Full definition from cache — use syncFromRegistry
    syncFromRegistry(cached);
  } else {
    // No cache — create a minimal definition from what state knows
    const firstPlatform = Object.values(toolRecord.platforms || {})[0] as LegacyToolPlatformRecord | undefined;

    const def: AugmentDef = {
      name: toolName,
      source: "registry",
      displayName: toolName,
      description: "",
      transport: (firstPlatform?.transport as "http" | "stdio") || "http",
      requiresAuth: false,
      skills: [],
      weight: 0,
      modded: false,
      createdAt: toolRecord.installedAt || new Date().toISOString(),
      updatedAt: toolRecord.updatedAt || new Date().toISOString(),
    };

    writeAugmentDef(def);
  }
}

function readCachedToolDef(name: string): ToolDefinition | null {
  const cPath = cachePath(name);
  const { data, status } = safeReadJsonSync(cPath);
  if (status !== "ok" || !data) return null;
  return data as unknown as ToolDefinition;
}

function buildInstallations(state: LegacyEquipState): Installations {
  const installations: Installations = {
    lastUpdated: state.lastUpdated || new Date().toISOString(),
    augments: {},
  };

  for (const [toolName, toolRecord] of Object.entries(state.tools)) {
    const platforms = Object.keys(toolRecord.platforms || {});
    const artifacts: Record<string, ArtifactRecord> = {};

    for (const [platId, platRecord] of Object.entries(toolRecord.platforms || {})) {
      const pr = platRecord as LegacyToolPlatformRecord;
      artifacts[platId] = {
        mcp: true,
        rules: pr.rulesVersion,
        hooks: pr.hookScripts,
        skills: pr.skillNames || (pr.skillName ? [pr.skillName] : undefined),
      };
    }

    const firstPlatform = Object.values(toolRecord.platforms || {})[0] as LegacyToolPlatformRecord | undefined;

    installations.augments[toolName] = {
      source: "registry",
      package: toolRecord.package,
      displayName: toolName,
      transport: (firstPlatform?.transport as "http" | "stdio") || "http",
      installedAt: toolRecord.installedAt || new Date().toISOString(),
      updatedAt: toolRecord.updatedAt || new Date().toISOString(),
      platforms,
      artifacts,
    };
  }

  return installations;
}

/** Read state.json from a specific path (bypasses the hardcoded path in state.ts). */
function readStateFromPath(filePath: string): LegacyEquipState | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
