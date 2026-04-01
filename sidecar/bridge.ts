/**
 * Equip Sidecar Bridge — JSON-RPC interface for the Tauri desktop app.
 *
 * Uses the new state architecture:
 *   - platforms.json + platforms/<id>.json for scan results
 *   - installations.json for tracking what equip installed
 *   - augments/<name>.json for augment definitions
 *   - equip.json for metadata + preferences
 *
 * Usage: equip-sidecar '{"id":1,"method":"scan","params":{}}'
 */

import { detectPlatforms } from "../src/lib/detect";
import {
  readPlatformsMeta, updatePlatformsMeta, setPlatformEnabled,
  readPlatformScan, scanAllPlatforms,
  type PlatformsMeta, type PlatformScan,
} from "../src/lib/platform-state";
import { readInstallations, getManagedAugmentNames, type Installations } from "../src/lib/installations";
import { readAugmentDef, listAugmentDefs, type AugmentDef } from "../src/lib/augment-defs";
import { readEquipMeta, markScanCompleted, type EquipMeta } from "../src/lib/equip-meta";
import { migrateState, type MigrationResult } from "../src/lib/migration";
import * as path from "path";

// --- Types ---

interface RpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

// --- Methods ---

/**
 * Full scan: detect platforms, read all configs, write state files.
 * Returns the complete picture for the UI.
 */
function scan() {
  // Run migration if needed (first launch with new code)
  const migration = migrateState();

  // Detect all platforms
  const detected = detectPlatforms();

  // Get managed augment names for the managed flag
  const managedNames = getManagedAugmentNames();

  // Scan all platforms and write state files
  const { meta, scans } = scanAllPlatforms(detected, managedNames);

  // Update equip meta
  markScanCompleted();

  return {
    platforms: meta,
    scans,
    migration: migration.migrated ? migration : undefined,
  };
}

/**
 * Quick read: return cached state without re-scanning.
 * Falls back to a full scan if state files don't exist.
 */
function read() {
  const meta = readPlatformsMeta();

  // If no platforms data, need a scan first
  if (!meta.lastScanned) {
    return scan();
  }

  // Read per-platform scan files
  const scans: Record<string, PlatformScan> = {};
  for (const id of Object.keys(meta.platforms)) {
    const s = readPlatformScan(id);
    if (s) scans[id] = s;
  }

  return {
    platforms: meta,
    scans,
  };
}

/**
 * Get installations data.
 */
function getInstallations() {
  return readInstallations();
}

/**
 * List all augment definitions.
 */
function getAugmentDefs() {
  return listAugmentDefs();
}

/**
 * Get a single augment definition by name.
 */
function getAugmentDef(params: { name: string }) {
  const def = readAugmentDef(params.name);
  if (!def) throw new Error(`Augment definition not found: ${params.name}`);
  return def;
}

/**
 * Enable or disable a platform.
 */
function setEnabled(params: { platform: string; enabled: boolean }) {
  setPlatformEnabled(params.platform, params.enabled);
  return { ok: true };
}

/**
 * Get equip metadata.
 */
function getMeta() {
  return readEquipMeta();
}

/**
 * Check for running platform processes.
 */
function checkRunning() {
  const running: { platform: string; processName: string }[] = [];

  const processMap: Record<string, string[]> = {
    "claude-code": ["claude"],
    "cursor": ["Cursor", "cursor"],
    "vscode": ["Code", "code"],
    "windsurf": ["Windsurf", "windsurf"],
    "codex": ["codex"],
    "gemini-cli": ["gemini"],
  };

  for (const [platform, names] of Object.entries(processMap)) {
    for (const name of names) {
      if (isProcessRunning(name)) {
        running.push({ platform, processName: name });
        break;
      }
    }
  }

  return { running };
}

function isProcessRunning(name: string): boolean {
  try {
    const { execSync } = require("child_process");
    if (process.platform === "win32") {
      const output = execSync(`tasklist /FI "IMAGENAME eq ${name}.exe" /NH`, {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return output.toLowerCase().includes(name.toLowerCase());
    } else {
      execSync(`pgrep -x "${name}"`, { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Get the folder path for a config file (for "Open in Explorer").
 */
function openFolder(params: { path: string }) {
  const dir = path.dirname(params.path);
  return { path: dir };
}

// --- Main ---

async function main() {
  const input = process.argv[2];
  if (!input) {
    process.stderr.write("Usage: equip-sidecar '<json-rpc-request>'\n");
    process.exit(1);
  }

  let request: RpcRequest;
  try {
    request = JSON.parse(input);
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: null, error: { code: -32700, message: "Parse error" } }));
    process.exit(0);
  }

  try {
    let result: unknown;

    switch (request.method) {
      case "scan":
        result = scan();
        break;

      case "read":
        result = read();
        break;

      case "installations":
        result = getInstallations();
        break;

      case "augments":
        result = getAugmentDefs();
        break;

      case "augment":
        result = getAugmentDef(request.params as any);
        break;

      case "setEnabled":
        result = setEnabled(request.params as any);
        break;

      case "meta":
        result = getMeta();
        break;

      case "running":
        result = checkRunning();
        break;

      case "openFolder":
        result = openFolder(request.params as any);
        break;

      case "ping":
        result = { ok: true, version: "0.2.0" };
        break;

      default:
        process.stdout.write(JSON.stringify({
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        }));
        process.exit(0);
    }

    process.stdout.write(JSON.stringify({ id: request.id, result }));
  } catch (e: any) {
    process.stdout.write(JSON.stringify({
      id: request.id,
      error: { code: -32000, message: e.message || String(e) },
    }));
  }
}

main();
