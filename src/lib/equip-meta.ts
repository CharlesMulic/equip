// Equip metadata — version, timestamps, user preferences.
//
// File: ~/.equip/equip.json
// Small, rarely changes. Separated so a bad scan can't corrupt preferences.
//
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { atomicWriteFileSync, safeReadJsonSync, resolvePackageVersion } from "./fs";

// ─── Types ──────────────────────────────────────────────────

export interface EquipMeta {
  version: string;
  lastUpdated: string;
  lastScan: string;
  preferences: EquipPreferences;
}

export interface EquipPreferences {
  telemetry: boolean;
  autoScan: boolean;
  scanIntervalMinutes: number;
  /** Max tokens the user wants to dedicate to augment overhead (default 30000) */
  contextBudget: number;
}

// ─── Paths ──────────────────────────────────────────────────

function equipDir(): string { return path.join(os.homedir(), ".equip"); }
function metaPath(): string { return path.join(equipDir(), "equip.json"); }

// ─── Defaults ───────────────────────────────────────────────

const DEFAULT_PREFERENCES: EquipPreferences = {
  telemetry: true,
  autoScan: true,
  scanIntervalMinutes: 60,
  contextBudget: 30000,
};

function defaultMeta(): EquipMeta {
  return {
    version: "",
    lastUpdated: "",
    lastScan: "",
    preferences: { ...DEFAULT_PREFERENCES },
  };
}

// ─── Read / Write ───────────────────────────────────────────

export function readEquipMeta(): EquipMeta {
  const { data, status } = safeReadJsonSync(metaPath());
  if (status !== "ok" || !data) return defaultMeta();

  const raw = data as unknown as Partial<EquipMeta>;
  return {
    version: raw.version || "",
    lastUpdated: raw.lastUpdated || "",
    lastScan: raw.lastScan || "",
    preferences: { ...DEFAULT_PREFERENCES, ...(raw.preferences || {}) },
  };
}

export function writeEquipMeta(meta: EquipMeta): void {
  const dir = equipDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(metaPath(), JSON.stringify(meta, null, 2) + "\n");
}

/** Update version and lastUpdated timestamp. */
export function markEquipUpdated(): void {
  const meta = readEquipMeta();
  meta.version = resolvePackageVersion(__dirname);
  meta.lastUpdated = new Date().toISOString();
  writeEquipMeta(meta);
}

/** Update lastScan timestamp. */
export function markScanCompleted(): void {
  const meta = readEquipMeta();
  meta.lastScan = new Date().toISOString();
  writeEquipMeta(meta);
}

/** Update preferences (merges with existing). */
export function updatePreferences(prefs: Partial<EquipPreferences>): void {
  const meta = readEquipMeta();
  meta.preferences = { ...meta.preferences, ...prefs };
  writeEquipMeta(meta);
}
