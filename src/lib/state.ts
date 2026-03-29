// State management — tracks what equip has installed across platforms.
// State file: ~/.equip/state.json
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Types ──────────────────────────────────────────────────

export interface ToolPlatformRecord {
  /** MCP config file path */
  configPath: string;
  /** Transport type (http, stdio) */
  transport: string;
  /** Rules file path (where marker block was written) */
  rulesPath?: string;
  /** Installed rules version string */
  rulesVersion?: string;
  /** Directory containing hook scripts */
  hookDir?: string;
  /** List of installed hook script filenames */
  hookScripts?: string[];
}

export interface ToolRecord {
  package: string;
  installedAt: string;
  updatedAt?: string;
  platforms: Record<string, ToolPlatformRecord>;
}

export interface EquipState {
  equipVersion: string;
  lastUpdated: string;
  tools: Record<string, ToolRecord>;
}

// ─── Paths ──────────────────────────────────────────────────

const EQUIP_DIR = path.join(os.homedir(), ".equip");
const STATE_PATH = path.join(EQUIP_DIR, "state.json");

export function getEquipDir(): string { return EQUIP_DIR; }
export function getStatePath(): string { return STATE_PATH; }

// ─── Read / Write ───────────────────────────────────────────

export function readState(): EquipState {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      equipVersion: "",
      lastUpdated: "",
      tools: {},
    };
  }
}

export function writeState(state: EquipState): void {
  fs.mkdirSync(EQUIP_DIR, { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, STATE_PATH);
}

// ─── Tool Tracking ──────────────────────────────────────────

/**
 * Record or update a tool's platform record.
 * Merges fields into existing record (doesn't overwrite unrelated fields).
 */
export function trackInstall(toolName: string, pkg: string, platformId: string, fields: Partial<ToolPlatformRecord>): void {
  const state = readState();
  const version = getEquipVersion();

  if (!state.tools[toolName]) {
    state.tools[toolName] = {
      package: pkg,
      installedAt: new Date().toISOString(),
      platforms: {},
    };
  }

  // Merge into existing platform record (preserves fields from prior calls)
  const existing = state.tools[toolName].platforms[platformId] || {} as ToolPlatformRecord;
  state.tools[toolName].platforms[platformId] = { ...existing, ...fields };
  state.tools[toolName].updatedAt = new Date().toISOString();
  state.tools[toolName].package = pkg;
  state.equipVersion = version;

  writeState(state);
}

/**
 * Remove a tool's platform record from state.
 */
export function trackUninstall(toolName: string, platformId?: string): void {
  const state = readState();
  if (!state.tools[toolName]) return;

  if (platformId) {
    delete state.tools[toolName].platforms[platformId];
    if (Object.keys(state.tools[toolName].platforms).length === 0) {
      delete state.tools[toolName];
    }
  } else {
    delete state.tools[toolName];
  }

  writeState(state);
}

/**
 * Mark equip as freshly updated.
 */
export function markUpdated(): void {
  const state = readState();
  state.equipVersion = getEquipVersion();
  state.lastUpdated = new Date().toISOString();
  writeState(state);
}

// ─── Helpers ────────────────────────────────────────────────

function getEquipVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
}
