// Installs store — install metadata only (no content).
//
// One of three storage primitives in the equip-storage-refactor architecture:
//   - defs-store     (sibling)   — sovereign user content
//   - cache-store    (sibling)   — registry snapshot + freshness metadata
//   - installs-store (THIS FILE) — install metadata only (no content)
//
// **Single-writer rule (CI-pinned):** writes to ~/.equip/installs/<name>.json
// happen only from install/uninstall paths (`installMcp`, `uninstallMcp`,
// `installRules`, `uninstallRules`, `installSkill`, `uninstallSkill`, plus
// the migration). The CI grep test in equip-product enforces this scope.
//
// File layout: ~/.equip/installs/<name>.json. One file per augment that the
// user has installed on at least one platform.
//
// Self-documenting on-disk semantics (per user direction 2026-04-28): a
// future contributor opening ~/.equip/installs/ immediately understands
// "this is install tracking, not augment content." Compare with the legacy
// ~/.equip/installations.json (single mixed-concern file) which mixed
// install metadata with title/transport/serverUrl/source — making it
// non-obvious whether installations.json was authoritative for those fields
// or just a cache.
//
// Replaces the legacy ~/.equip/installations.json single-file store. The
// migration in migrate-storage.ts converts the old file into per-augment
// entries here, then deletes the original.

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync, safeReadJsonSync } from "./fs";
import { getEquipHome } from "./equip-home";
import { validateToolName } from "./validation";

// ─── Types ──────────────────────────────────────────────────

/**
 * What was installed on a single platform for a single augment. Mirrors the
 * legacy ArtifactRecord shape so install/uninstall paths can adopt the new
 * store without rewriting their per-platform tracking logic.
 */
export interface ArtifactRecord {
  /** True if an MCP server entry was written for this augment on this platform. */
  mcp: boolean;
  /** Rules version installed (if any) — null/undefined means no rules artifact. */
  rules?: string;
  /** Hook script names installed on this platform. */
  hooks?: string[];
  /** Skill names installed on this platform. */
  skills?: string[];
  /**
   * MCP entry install mode:
   *   - "direct" or undefined: equip wrote the upstream's command/headers directly
   *   - "broker": equip wrote a broker-shim invocation; credentials in broker daemon
   * Used by `equip doctor` + uninstall to inspect/clean the right path.
   */
  installMode?: "direct" | "broker";
}

/**
 * Install metadata for one augment. Strictly tracks "I have this installed
 * on these platforms with these per-platform artifacts" — no content fields
 * (title, transport, serverUrl, etc. all live in defs-store/cache-store).
 */
export interface InstallRecord {
  /** Augment name — must match the filename (without .json). */
  name: string;
  /** ISO-8601 — when first installed (across all platforms). */
  installedAt: string;
  /** ISO-8601 — when most recently updated (re-install, propagation, etc.). */
  updatedAt: string;
  /** Platforms where this augment is currently installed. */
  platforms: string[];
  /** Per-platform artifact details — keyed by platformId. */
  artifacts: Record<string, ArtifactRecord>;
}

// ─── Paths ──────────────────────────────────────────────────

export function getInstallsDir(): string {
  return path.join(getEquipHome(), "installs");
}

function installPath(name: string): string {
  validateToolName(name);
  return path.join(getInstallsDir(), `${name}.json`);
}

function ensureInstallsDir(): void {
  const dir = getInstallsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
}

// ─── CRUD ───────────────────────────────────────────────────

/** Read an install record by name. Returns null if missing/corrupt. */
export function readInstall(name: string): InstallRecord | null {
  const p = installPath(name);
  const { data, status } = safeReadJsonSync(p);

  if (status === "missing") return null;
  if (status === "corrupt") {
    try { fs.copyFileSync(p, p + ".corrupt.bak"); } catch { /* best effort */ }
    return null;
  }
  if (status === "unreadable" || !data) return null;

  return data as unknown as InstallRecord;
}

/**
 * Write an install record. Creates the installs directory if needed, atomically.
 *
 * **Single-writer rule** — see file header. Production-code callsites for
 * this function are restricted by CI grep test to install/uninstall paths
 * + migrate-storage.ts.
 */
export function writeInstall(record: InstallRecord): void {
  ensureInstallsDir();
  atomicWriteFileSync(installPath(record.name), JSON.stringify(record, null, 2) + "\n");
}

/**
 * Delete an install record. Returns true if the file existed.
 *
 * Used by uninstall paths when an augment is uninstalled from all platforms.
 * (Partial uninstalls — removing from one platform but keeping on others —
 * call writeInstall with an updated platforms[] / artifacts map instead.)
 */
export function deleteInstall(name: string): boolean {
  const p = installPath(name);
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Existence check without parsing. */
export function hasInstall(name: string): boolean {
  return fs.existsSync(installPath(name));
}

/** List all install records. Skips corrupt files. */
export function listInstalls(): InstallRecord[] {
  ensureInstallsDir();
  let files: string[];
  try {
    files = fs.readdirSync(getInstallsDir()).filter((f) => f.endsWith(".json") && !f.endsWith(".corrupt.bak"));
  } catch {
    return [];
  }
  const out: InstallRecord[] = [];
  for (const file of files) {
    const name = file.replace(/\.json$/, "");
    const record = readInstall(name);
    if (record) out.push(record);
  }
  return out;
}
