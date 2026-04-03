// Augment sets — named groups of augments for quick switching.
// Stored in ~/.equip/sets.json as a single file (total data is small).
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { atomicWriteFileSync, safeReadJsonSync } from "./fs";

// ─── Types ──────────────────────────────────────────────────

export interface AugmentSet {
  /** Set name (unique) */
  name: string;
  /** Augment names in this set */
  augments: string[];
  /** When the set was created */
  createdAt: string;
  /** When the set was last used */
  lastUsed: string;
}

export interface SetsData {
  /** All saved sets */
  sets: AugmentSet[];
  /** Name of the currently active set (null if no set is active / unsaved state) */
  activeSet: string | null;
}

// ─── Paths ──────────────────────────────────────────────────

function setsPath(): string {
  return path.join(os.homedir(), ".equip", "sets.json");
}

// ─── Read / Write ───────────────────────────────────────────

export function readSets(): SetsData {
  const { data, status } = safeReadJsonSync(setsPath());
  if (status !== "ok" || !data) {
    return { sets: [], activeSet: null };
  }
  const raw = data as unknown as SetsData;
  return {
    sets: raw.sets || [],
    activeSet: raw.activeSet || null,
  };
}

function writeSets(data: SetsData): void {
  const dir = path.dirname(setsPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(setsPath(), JSON.stringify(data, null, 2) + "\n");
}

// ─── CRUD ───────────────────────────────────────────────────

/** List all saved sets. */
export function listSets(): AugmentSet[] {
  return readSets().sets;
}

/** Get a set by name. Returns null if not found. */
export function getSet(name: string): AugmentSet | null {
  return readSets().sets.find(s => s.name === name) || null;
}

/** Save a new set or update an existing one. */
export function saveSet(name: string, augments: string[]): AugmentSet {
  const data = readSets();
  const now = new Date().toISOString();

  const existing = data.sets.find(s => s.name === name);
  if (existing) {
    existing.augments = augments;
    existing.lastUsed = now;
  } else {
    data.sets.push({ name, augments, createdAt: now, lastUsed: now });
  }

  writeSets(data);
  return data.sets.find(s => s.name === name)!;
}

/** Delete a set by name. Returns true if deleted. */
export function deleteSet(name: string): boolean {
  const data = readSets();
  const before = data.sets.length;
  data.sets = data.sets.filter(s => s.name !== name);
  if (data.activeSet === name) data.activeSet = null;
  if (data.sets.length < before) {
    writeSets(data);
    return true;
  }
  return false;
}

/** Rename a set. Returns the updated set or null if not found. */
export function renameSet(oldName: string, newName: string): AugmentSet | null {
  const data = readSets();
  const set = data.sets.find(s => s.name === oldName);
  if (!set) return null;
  if (data.sets.some(s => s.name === newName)) {
    throw new Error(`Set "${newName}" already exists`);
  }
  set.name = newName;
  if (data.activeSet === oldName) data.activeSet = newName;
  writeSets(data);
  return set;
}

/** Duplicate a set with a new name. */
export function duplicateSet(sourceName: string, newName: string): AugmentSet | null {
  const data = readSets();
  const source = data.sets.find(s => s.name === sourceName);
  if (!source) return null;
  if (data.sets.some(s => s.name === newName)) {
    throw new Error(`Set "${newName}" already exists`);
  }
  const now = new Date().toISOString();
  const copy: AugmentSet = { name: newName, augments: [...source.augments], createdAt: now, lastUsed: now };
  data.sets.push(copy);
  writeSets(data);
  return copy;
}

// ─── Active Set ─────────────────────────────────────────────

/** Get the name of the currently active set. */
export function getActiveSet(): string | null {
  return readSets().activeSet;
}

/** Set the active set name. Pass null to clear. */
export function setActiveSet(name: string | null): void {
  const data = readSets();
  if (name && !data.sets.some(s => s.name === name)) {
    throw new Error(`Set "${name}" not found`);
  }
  data.activeSet = name;
  if (name) {
    const set = data.sets.find(s => s.name === name);
    if (set) set.lastUsed = new Date().toISOString();
  }
  writeSets(data);
}
