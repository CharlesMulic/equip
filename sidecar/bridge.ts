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
import { readStoredCredential, resolveAuth, validateCredential } from "../src/lib/auth-engine";
import { fetchToolDef, toolDefToEquipConfig as toolDefToConfig } from "../src/lib/registry";
import { ensureInitialSnapshots } from "../src/lib/snapshots";
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
import { computeWeightReport, previewEquipWeight } from "../src/lib/weight";
import {
  listSets as listSetsCore, saveSet as saveSetCore, deleteSet as deleteSetCore,
  renameSet as renameSetCore, duplicateSet as duplicateSetCore,
  getActiveSet, setActiveSet,
} from "../src/lib/sets";
import {
  createSnapshot as createSnapshotCore, listSnapshots as listSnapshotsCore,
  restoreSnapshot as restoreSnapshotCore,
} from "../src/lib/snapshots";
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

function bridgeUpdatePreferences(params: Record<string, unknown>) {
  const { updatePreferences } = require("../src/lib/equip-meta") as typeof import("../src/lib/equip-meta");
  updatePreferences(params as any);
  return readEquipMeta();
}

function bridgeClearCache() {
  const fs = require("fs") as typeof import("fs");
  const cacheDir = path.join(os.homedir(), ".equip", "cache");
  let cleared = 0;
  try {
    const files = fs.readdirSync(cacheDir);
    for (const f of files) {
      try { fs.unlinkSync(path.join(cacheDir, f)); cleared++; } catch {}
    }
  } catch {}
  return { cleared };
}

function bridgeClearSnapshots() {
  const fs = require("fs") as typeof import("fs");
  const snapDir = path.join(os.homedir(), ".equip", "snapshots");
  let cleared = 0;
  try {
    const platforms = fs.readdirSync(snapDir);
    for (const pid of platforms) {
      const pdir = path.join(snapDir, pid);
      try {
        const files = fs.readdirSync(pdir);
        for (const f of files) {
          try { fs.unlinkSync(path.join(pdir, f)); cleared++; } catch {}
        }
        fs.rmdirSync(pdir);
      } catch {}
    }
  } catch {}
  return { cleared };
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
 * Full equip flow — fetch definition from registry, resolve auth (including OAuth),
 * install on all enabled platforms, reconcile state.
 * This is the desktop app equivalent of running `equip <name>` from CLI.
 */
async function equipAugment(params: { name: string; platforms?: string[] }) {
  // 1. Fetch augment definition from registry API (with cache fallback)
  const toolDef = await fetchToolDef(params.name);
  if (!toolDef) throw new Error(`Augment "${params.name}" not found in registry`);

  // 2. Resolve auth (opens browser for OAuth if needed)
  let apiKey: string | null = null;
  const authConfig = toolDef.auth || (toolDef.requiresAuth ? { type: "api_key" as const } : { type: "none" as const });

  if (authConfig.type !== "none") {
    const authResult = await resolveAuth({
      toolName: toolDef.name,
      auth: authConfig,
      // nonInteractive is false — browser OAuth flow works.
      // stdin prompts (key conflict) auto-resolve via !process.stdin.isTTY check.
    });

    if (!authResult.credential) {
      throw new Error(authResult.error || `${toolDef.name} requires authentication`);
    }
    apiKey = authResult.credential;

    // Validate if possible
    if (authConfig.validationUrl) {
      const validation = await validateCredential(apiKey, authConfig);
      if (validation.valid === false) {
        throw new Error(`Credential invalid: ${validation.detail}`);
      }
    }
  }

  // 3. Build config and detect platforms
  const config = toolDefToConfig(toolDef);
  const augment = new Augment(config);
  let platforms = augment.detect();

  // Filter disabled platforms
  platforms = platforms.filter(p => isPlatformEnabled(p.platform));
  if (params.platforms && params.platforms.length > 0) {
    platforms = platforms.filter(p => params.platforms!.includes(p.platform));
  }

  if (platforms.length === 0) {
    return { installed: 0, platforms: [], error: "No enabled platforms detected" };
  }

  // 4. Capture initial snapshots before modifying configs
  ensureInitialSnapshots(platforms);

  // 5. Install on each platform
  const transport = toolDef.transport || "http";
  const results: { platform: string; name: string; success: boolean; error?: string }[] = [];

  for (const p of platforms) {
    try {
      augment.installMcp(p, apiKey as string, { transport });
      if (config.rules) augment.installRules(p);
      augment.installSkill(p);
      results.push({ platform: p.platform, name: platformName(p.platform), success: true });
    } catch (e: any) {
      results.push({ platform: p.platform, name: platformName(p.platform), success: false, error: e.message });
    }
  }

  // 6. Reconcile state
  try {
    reconcileState({
      toolName: toolDef.name,
      package: toolDef.npmPackage || toolDef.name,
      marker: toolDef.rules?.marker || toolDef.name,
      toolDef,
    });
  } catch { /* best effort */ }

  // 7. Introspect MCP server for accurate weight (best effort)
  try {
    const { introspect } = await import("../src/lib/mcp-introspect");
    const { readAugmentDef: readDef, writeAugmentDef: writeDef } = await import("../src/lib/augment-defs");

    let introAuth: string | undefined;
    if (apiKey) introAuth = `Bearer ${apiKey}`;

    let introResult;
    if (toolDef.serverUrl) {
      introResult = await introspect({ serverUrl: toolDef.serverUrl, auth: introAuth, timeout: 10000 });
    } else if (toolDef.stdioCommand) {
      introResult = await introspect({ stdio: { command: toolDef.stdioCommand, args: toolDef.stdioArgs || [] }, timeout: 10000 });
    }

    if (introResult) {
      const def = readDef(toolDef.name);
      if (def) {
        def.introspection = introResult as unknown as Record<string, unknown>;
        const rulesTokens = def.rules?.content ? Math.round(def.rules.content.length / 4) : 0;
        const skillTokens = (def.skills || []).reduce((sum: number, s: any) =>
          sum + ((s.files || []) as any[]).reduce((fsum: number, f: any) => fsum + (f.content ? Math.round(f.content.length / 4) : 0), 0), 0);
        def.baseWeight = (introResult as any).toolTokens + rulesTokens;
        def.loadedWeight = ((introResult as any).resourceTokens || 0) + skillTokens;
        writeDef(def);
      }
    }
  } catch { /* best effort — don't fail the install */ }

  return {
    installed: results.filter(r => r.success).length,
    platforms: results,
  };
}

/**
 * Install an augment on enabled platforms.
 * Reads the augment definition for config, reads stored credential for auth.
 * Use equipAugment for the full flow including registry fetch and auth.
 */
function installAugment(params: { name: string; platforms?: string[] }) {
  const def = readAugmentDef(params.name);
  if (!def) throw new Error(`Augment definition not found: ${params.name}. Install via CLI first or create a local augment.`);

  // Resolve API key from stored credentials
  let apiKey = "";
  if (def.requiresAuth) {
    const cred = readStoredCredential(params.name);
    if (!cred) throw new Error(`No stored credential for ${params.name}. Run 'equip ${params.name}' from CLI to authenticate.`);
    apiKey = cred.credential || cred.oauth?.accessToken || "";
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

  // Update state — keep augment def so it shows as "available" for re-equipping
  if (removedPlatforms.length > 0) {
    trackUninstallation(params.name, removedPlatforms);
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

// --- Composite Endpoints (one spawn per page) ---

/**
 * Everything the Equip/Loadout page needs in a single call.
 * Replaces: scan_platforms + get_installations + get_augment_defs + read_platforms + get_weight
 */
function loadout() {
  // Read platform state (cached, no re-scan — use "scan" for fresh data)
  const platformsMeta = readPlatformsMeta();
  const installations = readInstallations();
  const allDefs = listAugmentDefs();
  const weight = computeWeightReport();

  // Build enabled platform set
  const enabledPlatforms = new Set<string>();
  for (const [id, p] of Object.entries(platformsMeta.platforms || {})) {
    if ((p as any).enabled) enabledPlatforms.add(id);
  }

  // Build editor list
  const editors = Object.entries(platformsMeta.platforms || {}).map(([id, p]: [string, any]) => ({
    id,
    name: p.name || id,
    detected: p.detected ?? true,
    enabled: p.enabled ?? true,
    configPath: p.configPath || '',
    capabilities: p.capabilities || [],
  }));

  // Build augment list (installed + available)
  const augments: any[] = [];
  const defMap = new Map(allDefs.map(d => [d.name, d]));

  for (const [name, inst] of Object.entries(installations.augments || {}) as [string, any][]) {
    const def = defMap.get(name);
    const installedPlatforms: string[] = inst.platforms || [];
    const equippedOn = installedPlatforms.filter((id: string) => enabledPlatforms.has(id));

    augments.push({
      name,
      displayName: inst.displayName || def?.displayName || name,
      title: (def as any)?.title || undefined,
      subtitle: (def as any)?.subtitle || undefined,
      description: def?.description || '',
      rarity: def?.rarity || 'common',
      baseWeight: def?.baseWeight || 0,
      loadedWeight: def?.loadedWeight || 0,
      installCount: def?.installCount || 0,
      transport: inst.transport || 'http',
      requiresAuth: def?.requiresAuth || false,
      categories: def?.categories || [],
      equipped: equippedOn.length > 0,
      installedOn: equippedOn,
      installedAt: inst.installedAt || '',
      rulesVersion: Object.values(inst.artifacts || {}).find((a: any) => a?.rules)
        ? (Object.values(inst.artifacts || {}).find((a: any) => a?.rules) as any).rules
        : undefined,
      homepage: def?.homepage,
      repository: def?.repository,
      license: def?.license,
      flavorText: (def as any)?.flavorText,
    });
  }

  // Include available (not installed) augment defs
  for (const def of allDefs) {
    if (!installations.augments?.[def.name]) {
      augments.push({
        name: def.name,
        displayName: def.displayName || def.name,
        title: (def as any).title || undefined,
        subtitle: (def as any).subtitle || undefined,
        description: def.description || '',
        rarity: (def as any).rarity || 'common',
        baseWeight: def.baseWeight || 0,
        loadedWeight: def.loadedWeight || 0,
        installCount: (def as any).installCount || 0,
        transport: def.transport || 'http',
        requiresAuth: def.requiresAuth || false,
        categories: def.categories || [],
        equipped: false,
        installedOn: [],
        installedAt: '',
      });
    }
  }

  return { editors, augments, weight };
}

/**
 * Everything the augment detail page needs in a single call.
 * Returns def + installed status + cached introspection (no live MCP call).
 */
function augmentDetail(params: { name: string }) {
  const def = readAugmentDef(params.name);
  if (!def) throw new Error(`Augment "${params.name}" not found`);

  const installations = readInstallations();
  const inst = installations.augments?.[params.name];
  const platformsMeta = readPlatformsMeta();

  const enabledPlatforms = new Set<string>();
  for (const [id, p] of Object.entries(platformsMeta.platforms || {})) {
    if ((p as any).enabled) enabledPlatforms.add(id);
  }

  const installedPlatforms: string[] = inst?.platforms || [];
  const equippedOn = installedPlatforms.filter((id: string) => enabledPlatforms.has(id));

  return {
    augment: {
      name: def.name,
      displayName: def.displayName || def.name,
      title: (def as any).title || undefined,
      subtitle: (def as any).subtitle || undefined,
      description: def.description || '',
      rarity: (def as any).rarity || 'common',
      baseWeight: def.baseWeight || 0,
      loadedWeight: def.loadedWeight || 0,
      installCount: (def as any).installCount || 0,
      transport: def.transport,
      requiresAuth: def.requiresAuth,
      categories: def.categories || [],
      equipped: equippedOn.length > 0,
      installedOn: equippedOn,
      installedAt: inst?.installedAt || '',
      source: def.source,
      rules: def.rules || null,
      skills: def.skills || [],
      hooks: def.hooks || [],
      homepage: def.homepage,
      repository: def.repository,
      license: def.license,
      flavorText: (def as any).flavorText,
    },
    introspection: def.introspection || null,
    weight: computeWeightReport(),
  };
}

// --- Introspection ---

async function bridgeIntrospect(params: { name: string }) {
  const def = readAugmentDef(params.name);
  if (!def) throw new Error(`Augment "${params.name}" not found`);

  const { introspect } = await import("../src/lib/mcp-introspect");

  // Resolve auth if needed
  let auth: string | undefined;
  if (def.requiresAuth) {
    const cred = readStoredCredential(params.name);
    if (cred?.credential) auth = `Bearer ${cred.credential}`;
  }

  let result;
  if (def.serverUrl) {
    result = await introspect({ serverUrl: def.serverUrl, auth });
  } else if (def.stdio) {
    result = await introspect({ stdio: { command: def.stdio.command, args: def.stdio.args } });
  } else {
    throw new Error(`Augment "${params.name}" has no server URL or stdio config`);
  }

  // Cache introspection and update weight fields on the augment def
  const { writeAugmentDef } = await import("../src/lib/augment-defs");
  def.introspection = result as unknown as Record<string, unknown>;

  // Compute and persist accurate weights from introspection
  const rulesTokens = def.rules?.content ? Math.round(def.rules.content.length / 4) : 0;
  const skillTokens = (def.skills || []).reduce((sum: number, s: any) =>
    sum + ((s.files || []) as any[]).reduce((fsum: number, f: any) => fsum + (f.content ? Math.round(f.content.length / 4) : 0), 0), 0);
  def.baseWeight = (result as any).toolTokens + rulesTokens;
  def.loadedWeight = ((result as any).resourceTokens || 0) + skillTokens;

  writeAugmentDef(def);

  return result;
}

// --- Weight ---

function bridgeWeight() {
  return computeWeightReport();
}

function bridgeWeightPreview(params: { name: string }) {
  return previewEquipWeight(params.name);
}

// --- Sets ---

function bridgeListSets() {
  return listSetsCore();
}

function bridgeSaveSet(params: { name: string; augments: string[] }) {
  return saveSetCore(params.name, params.augments);
}

function bridgeDeleteSet(params: { name: string }) {
  return deleteSetCore(params.name);
}

function bridgeRenameSet(params: { oldName: string; newName: string }) {
  return renameSetCore(params.oldName, params.newName);
}

function bridgeDuplicateSet(params: { sourceName: string; newName: string }) {
  return duplicateSetCore(params.sourceName, params.newName);
}

function bridgeSwitchSet(params: { name: string | null }) {
  setActiveSet(params.name);
  return { activeSet: getActiveSet() };
}

// --- Snapshots ---

function bridgeListSnapshots(params: { platform?: string }) {
  return listSnapshotsCore(params.platform);
}

function bridgeCreateSnapshot(params: { platform: string; label?: string }) {
  const platform = createManualPlatform(params.platform);
  const snap = createSnapshotCore(platform, {
    label: params.label || "manual",
    trigger: "manual",
  });
  return { id: snap.id, platform: snap.platform, label: snap.label, createdAt: snap.createdAt };
}

function bridgeRestoreSnapshot(params: { platform: string; snapshotId?: string }) {
  return restoreSnapshotCore(params.platform, params.snapshotId);
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

      case "loadout":
        result = loadout();
        break;

      case "augmentDetail":
        result = augmentDetail(request.params as any);
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

      case "updatePreferences":
        result = bridgeUpdatePreferences(request.params as any);
        break;

      case "clearCache":
        result = bridgeClearCache();
        break;

      case "clearSnapshots":
        result = bridgeClearSnapshots();
        break;

      case "running":
        result = checkRunning();
        break;

      case "equip":
        result = await equipAugment(request.params as any);
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

      case "introspect":
        result = await bridgeIntrospect(request.params as any);
        break;

      case "weight":
        result = bridgeWeight();
        break;

      case "weightPreview":
        result = bridgeWeightPreview(request.params as any);
        break;

      case "sets.list":
        result = bridgeListSets();
        break;

      case "sets.save":
        result = bridgeSaveSet(request.params as any);
        break;

      case "sets.delete":
        result = bridgeDeleteSet(request.params as any);
        break;

      case "sets.rename":
        result = bridgeRenameSet(request.params as any);
        break;

      case "sets.duplicate":
        result = bridgeDuplicateSet(request.params as any);
        break;

      case "sets.switch":
        result = bridgeSwitchSet(request.params as any);
        break;

      case "listSnapshots":
        result = bridgeListSnapshots(request.params as any);
        break;

      case "createSnapshot":
        result = bridgeCreateSnapshot(request.params as any);
        break;

      case "restoreSnapshot":
        result = bridgeRestoreSnapshot(request.params as any);
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
