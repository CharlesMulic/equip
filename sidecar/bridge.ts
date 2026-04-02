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
import { Augment, toolDefToEquipConfig, type AugmentConfig } from "../src/index";
import { readStoredCredential } from "../src/lib/auth-engine";
import {
  readPlatformsMeta, updatePlatformsMeta, setPlatformEnabled, isPlatformEnabled,
  readPlatformScan, scanAllPlatforms,
  type PlatformsMeta, type PlatformScan,
} from "../src/lib/platform-state";
import { readInstallations, getManagedAugmentNames, type Installations } from "../src/lib/installations";
import { readAugmentDef, listAugmentDefs, createLocalAugment, wrapUnmanaged, type AugmentDef } from "../src/lib/augment-defs";
import { readEquipMeta, markScanCompleted, type EquipMeta } from "../src/lib/equip-meta";
import { reconcileState } from "../src/lib/reconcile";
import { createManualPlatform, platformName } from "../src/lib/platforms";
import { uninstallMcp } from "../src/lib/mcp";
import { uninstallRules } from "../src/lib/rules";
import { uninstallSkill } from "../src/lib/skills";
import { trackUninstallation } from "../src/lib/installations";
import { deleteAugmentDef } from "../src/lib/augment-defs";
import * as path from "path";
import * as os from "os";

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
 * Returns per-instance details: PID, start time, command line args, parent process.
 */
function checkRunning() {
  const { execSync } = require("child_process");

  const processMap: Record<string, string[]> = {
    "claude-code": ["claude"],
    "cursor": ["Cursor", "cursor"],
    "vscode": ["Code", "code"],
    "windsurf": ["Windsurf", "windsurf"],
    "codex": ["codex"],
    "gemini-cli": ["gemini"],
  };

  interface ProcessInstance {
    pid: number;
    startTime: string;
    commandLine: string;
    executablePath: string;
    parentPid: number;
    parentName: string;
  }

  interface PlatformProcessInfo {
    platform: string;
    processName: string;
    instances: ProcessInstance[];
  }

  const running: PlatformProcessInfo[] = [];

  for (const [platform, names] of Object.entries(processMap)) {
    for (const name of names) {
      const instances = getProcessInstances(name, execSync);
      if (instances.length > 0) {
        running.push({ platform, processName: name, instances });
        break;
      }
    }
  }

  return { running };
}

function getProcessInstances(name: string, execSync: any): any[] {
  try {
    if (process.platform === "win32") {
      // Use wmic LIST format — one field per line, reliable parsing
      const output = execSync(
        `wmic process where "name='${name}.exe'" get ProcessId,CommandLine,ExecutablePath,ParentProcessId,CreationDate /FORMAT:LIST`,
        { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
      ).trim();

      if (!output) return [];

      // Split into per-process blocks (separated by double newlines)
      const blocks = output.split(/\n\s*\n/).filter((b: string) => b.trim());
      const instances: any[] = [];

      for (const block of blocks) {
        const fields: Record<string, string> = {};
        for (const line of block.split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) {
            fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          }
        }

        if (!fields.ProcessId) continue;

        // Parse wmic date: "20260326203446.123456-300" → ISO-ish
        let startTime = "";
        if (fields.CreationDate) {
          const d = fields.CreationDate;
          startTime = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${d.slice(8,10)}:${d.slice(10,12)}:${d.slice(12,14)}`;
        }

        instances.push({
          pid: parseInt(fields.ProcessId, 10) || 0,
          startTime,
          commandLine: fields.CommandLine || "",
          executablePath: fields.ExecutablePath || "",
          parentPid: parseInt(fields.ParentProcessId, 10) || 0,
          parentName: "",  // skip parent lookup for now — too expensive
        });
      }

      return instances;
    } else {
      // Unix: use ps for details
      const output = execSync(
        `ps -eo pid,lstart,comm,args | grep -i "\\b${name}\\b" | grep -v grep`,
        { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }
      ).trim();

      if (!output) return [];

      return output.split("\n").map((line: string) => {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        return {
          pid,
          startTime: "",
          commandLine: parts.slice(5).join(" "),
          executablePath: "",
          parentPid: 0,
          parentName: "",
        };
      });
    }
  } catch {
    return [];
  }
}

/**
 * Install an augment on enabled platforms.
 * Reads the augment definition for config, reads stored credential for auth.
 */
function installAugment(params: { name: string; platforms?: string[] }) {
  const def = readAugmentDef(params.name);
  if (!def) throw new Error(`Augment definition not found: ${params.name}. Install via CLI first or create a local augment.`);

  // Resolve API key from stored credentials
  let apiKey = "";
  if (def.requiresAuth) {
    const cred = readStoredCredential(params.name);
    if (!cred) throw new Error(`No stored credential for ${params.name}. Run 'equip ${params.name}' from CLI to authenticate.`);
    apiKey = cred.apiKey || cred.oauth?.accessToken || "";
    if (!apiKey) throw new Error(`Stored credential for ${params.name} has no usable key. Run 'equip reauth ${params.name}'.`);
  }

  // Build Augment config from definition
  const config: AugmentConfig = {
    name: def.name,
    serverUrl: def.serverUrl,
    rules: def.rules || undefined,
    skills: def.skills,
    hooks: def.hooks,
    hookDir: def.hookDir,
  };
  if (def.stdio) {
    config.stdio = { command: def.stdio.command, args: def.stdio.args, envKey: def.envKey || "" };
  }

  const augment = new Augment(config);
  let platforms = augment.detect();

  // Filter disabled platforms
  platforms = platforms.filter(p => isPlatformEnabled(p.platform));

  // Filter to requested platforms if specified
  if (params.platforms && params.platforms.length > 0) {
    platforms = platforms.filter(p => params.platforms!.includes(p.platform));
  }

  if (platforms.length === 0) {
    return { installed: 0, platforms: [], error: "No enabled platforms detected" };
  }

  const transport = def.transport || "http";
  const results: { platform: string; success: boolean; error?: string }[] = [];

  for (const p of platforms) {
    try {
      augment.installMcp(p, apiKey, { transport });
      if (config.rules) augment.installRules(p);
      augment.installSkill(p);
      results.push({ platform: p.platform, success: true });
    } catch (e: any) {
      results.push({ platform: p.platform, success: false, error: e.message });
    }
  }

  // Reconcile state — writes to all new state files
  try {
    reconcileState({
      toolName: def.name,
      package: def.name,
      marker: def.rules?.marker || def.name,
    });
  } catch { /* best effort */ }

  return {
    installed: results.filter(r => r.success).length,
    platforms: results,
  };
}

/**
 * Uninstall an augment from enabled platforms.
 */
function uninstallAugment(params: { name: string; platforms?: string[] }) {
  const installations = readInstallations();
  const record = installations.augments[params.name];
  if (!record) throw new Error(`${params.name} is not installed.`);

  let targetPlatforms = record.platforms;

  // Filter disabled
  targetPlatforms = targetPlatforms.filter(id => isPlatformEnabled(id));

  // Filter to requested platforms
  if (params.platforms && params.platforms.length > 0) {
    targetPlatforms = targetPlatforms.filter(id => params.platforms!.includes(id));
  }

  const results: { platform: string; removed: string[] }[] = [];
  const removedPlatforms: string[] = [];

  for (const platformId of targetPlatforms) {
    const platform = createManualPlatform(platformId);
    const artifacts = record.artifacts[platformId] || {};
    const removed: string[] = [];

    if (artifacts.mcp && uninstallMcp(platform, params.name)) removed.push("mcp");
    if (artifacts.rules) {
      uninstallRules(platform, { marker: params.name });
      removed.push("rules");
    }
    if (artifacts.skills) {
      for (const sk of artifacts.skills) uninstallSkill(platform, params.name, sk);
      removed.push("skills");
    }

    if (removed.length > 0) {
      results.push({ platform: platformId, removed });
      removedPlatforms.push(platformId);
    }
  }

  // Update state
  if (removedPlatforms.length > 0) {
    trackUninstallation(params.name, removedPlatforms);
    const updated = readInstallations();
    if (!updated.augments[params.name]) {
      deleteAugmentDef(params.name);
    }
  }

  // Re-scan to update platform files
  try {
    const detected = detectPlatforms();
    const managedNames = getManagedAugmentNames();
    scanAllPlatforms(detected, managedNames);
  } catch { /* best effort */ }

  return {
    removed: removedPlatforms.length,
    platforms: results,
  };
}

/**
 * Wrap an unmanaged MCP entry as a local augment definition.
 */
function wrapAugment(params: { name: string; platform: string; displayName?: string }) {
  // Read the MCP entry from the platform's scan file
  const scan = readPlatformScan(params.platform);
  if (!scan) throw new Error(`No scan data for platform ${params.platform}`);

  const entry = scan.augments[params.name];
  if (!entry) throw new Error(`${params.name} not found on ${params.platform}`);
  if (entry.managed) throw new Error(`${params.name} is already managed by equip`);

  const def = wrapUnmanaged({
    name: params.name,
    displayName: params.displayName || params.name,
    transport: entry.transport === "unknown" ? "http" : entry.transport,
    url: entry.url,
    command: entry.command,
    fromPlatform: params.platform,
  });

  return def;
}

/**
 * Create a new local augment definition.
 */
function createLocal(params: {
  name: string; displayName?: string; description?: string;
  transport: "http" | "stdio"; serverUrl?: string;
  command?: string; args?: string[];
}) {
  return createLocalAugment({
    name: params.name,
    displayName: params.displayName,
    description: params.description,
    transport: params.transport,
    serverUrl: params.serverUrl,
    stdio: params.transport === "stdio" && params.command
      ? { command: params.command, args: params.args || [] }
      : undefined,
  });
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

      case "install":
        result = installAugment(request.params as any);
        break;

      case "uninstall":
        result = uninstallAugment(request.params as any);
        break;

      case "wrap":
        result = wrapAugment(request.params as any);
        break;

      case "createLocal":
        result = createLocal(request.params as any);
        break;

      case "openFolder":
        result = openFolder(request.params as any);
        break;

      case "ping":
        result = { ok: true, version: "0.3.0" };
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
