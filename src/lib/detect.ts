// Platform detection — discovers installed AI coding tools.
// Uses the platform registry as single source of truth.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { PLATFORM_REGISTRY, type DetectedPlatform } from "./platforms";
import { readMcpEntry } from "./mcp";

// ─── Helpers ─────────────────────────────────────────────────

export function whichSync(cmd: string): string | null {
  try {
    const r = execSync(process.platform === "win32" ? `where ${cmd} 2>nul` : `which ${cmd} 2>/dev/null`, { encoding: "utf-8", timeout: 5000 });
    return r.trim().split(/\r?\n/)[0] || null;
  } catch { return null; }
}

export function dirExists(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// ─── Detection ──────────────────────────────────────────────

/**
 * Detect installed AI coding platforms.
 * Checks directories and files first (fast fs stat).
 * Falls back to CLI presence check (which/where) only when
 * no filesystem evidence exists.
 * @param serverName - MCP server name to check for existing config
 */
export function detectPlatforms(serverName?: string): DetectedPlatform[] {
  const platforms: DetectedPlatform[] = [];

  for (const [, def] of PLATFORM_REGISTRY) {
    // Check dirs/files first (fast fs stat)
    const dirFound = def.detection.dirs.some(fn => dirExists(fn()));
    const fileFound = def.detection.files.some(fn => fileExists(fn()));
    const parentDirFound = def.detection.files.some(fn => dirExists(path.dirname(fn())));

    // Only shell out for `which` if no filesystem evidence found
    const fsEvidence = dirFound || fileFound || parentDirFound;
    const cliFound = !fsEvidence && def.detection.cli ? !!whichSync(def.detection.cli) : false;

    if (!fsEvidence && !cliFound) continue;

    const configPath = def.configPath();
    const rulesPath = def.rulesPath ? def.rulesPath() : null;

    platforms.push({
      platform: def.id,
      configPath,
      rulesPath,
      existingMcp: serverName ? readMcpEntry(configPath, def.rootKey, serverName, def.configFormat) : null,
      rootKey: def.rootKey,
      configFormat: def.configFormat,
    });
  }

  return platforms;
}
