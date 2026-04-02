// State reconciliation — scans platform configs after tool dispatch
// and records what's actually on disk in the new state files.
//
// Called by the global CLI after a tool's setup completes.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PLATFORM_REGISTRY } from "./platforms";
import { detectPlatforms } from "./detect";
import { readMcpEntry } from "./mcp";
import { dirExists, fileExists } from "./detect";
import { trackInstallation, getManagedAugmentNames, type ArtifactRecord } from "./installations";
import { scanAllPlatforms, isPlatformEnabled } from "./platform-state";
import { syncFromRegistry } from "./augment-defs";
import { markEquipUpdated } from "./equip-meta";
import type { ToolDefinition } from "./registry";

// ─── Types ──────────────────────────────────────────────────

export interface ReconcileOptions {
  /** Tool name (used as key in state and to find MCP entries) */
  toolName: string;
  /** npm package name (e.g. "@cg3/prior-node") */
  package: string;
  /** Rules marker name. Defaults to toolName if not provided. */
  marker?: string;
  /** Hook directory path. Defaults to ~/.{toolName}/hooks if not provided. */
  hookDir?: string;
  /** Tool definition from registry (if available, used to sync augment definition) */
  toolDef?: ToolDefinition;
}

// ─── Reconcile ──────────────────────────────────────────────

/**
 * Scan all platform configs and update state based on what's on disk.
 * Returns the number of platforms where the tool was found.
 */
export function reconcileState(options: ReconcileOptions): number {
  const { toolName, package: pkg, marker = toolName, hookDir: customHookDir, toolDef } = options;
  const defaultHookDir = path.join(os.homedir(), `.${toolName}`, "hooks");
  const hookDir = customHookDir || defaultHookDir;

  // Sync augment definition from registry if available
  if (toolDef) {
    try { syncFromRegistry(toolDef); } catch { /* best effort */ }
  }

  let count = 0;
  const installedPlatforms: string[] = [];
  const artifacts: Record<string, ArtifactRecord> = {};

  for (const [id, def] of PLATFORM_REGISTRY) {
    // Quick presence check (fast fs stat)
    const dirFound = def.detection.dirs.some(fn => dirExists(fn()));
    const fileFound = def.detection.files.some(fn => fileExists(fn()));
    const configPath = def.configPath();
    if (!dirFound && !fileFound && !fileExists(configPath)) continue;

    // Build artifact record from what's on disk.
    const artifactRecord: ArtifactRecord = { mcp: false };
    let hasAnyArtifact = false;

    // Check MCP config
    const entry = readMcpEntry(configPath, def.rootKey, toolName, def.configFormat);
    if (entry) {
      artifactRecord.mcp = true;
      hasAnyArtifact = true;
    }

    // Check for rules
    if (def.rulesPath) {
      const rulesPath = def.rulesPath();
      try {
        const content = fs.readFileSync(rulesPath, "utf-8");
        const versionMatch = content.match(new RegExp(`<!-- ${marker}:v([0-9.]+) -->`));
        if (versionMatch) {
          artifactRecord.rules = versionMatch[1];
          hasAnyArtifact = true;
        }
      } catch { /* rules file may not exist */ }
    }

    // Check for hooks
    if (def.hooks) {
      try {
        const hookFiles = fs.readdirSync(hookDir).filter(f => f.endsWith(".js"));
        if (hookFiles.length > 0) {
          artifactRecord.hooks = hookFiles;
          hasAnyArtifact = true;
        }
      } catch { /* hook dir may not exist */ }
    }

    // Check for skills
    if (def.skillsPath) {
      const skillsBasePath = def.skillsPath();
      const toolSkillDir = path.join(skillsBasePath, toolName);
      try {
        const skillDirs = fs.readdirSync(toolSkillDir);
        const skillsWithMd = skillDirs.filter(s => {
          try { return fs.statSync(path.join(toolSkillDir, s, "SKILL.md")).isFile(); }
          catch { return false; }
        });
        if (skillsWithMd.length > 0) {
          artifactRecord.skills = skillsWithMd;
          hasAnyArtifact = true;
        }
      } catch { /* skill dir may not exist */ }
    }

    if (!hasAnyArtifact) continue;

    installedPlatforms.push(id);
    artifacts[id] = artifactRecord;
    count++;
  }

  // Write to installations.json
  if (installedPlatforms.length > 0) {
    try {
      const firstArtifact = artifacts[installedPlatforms[0]];
      const transport = firstArtifact?.mcp ? "http" : "stdio";
      trackInstallation(toolName, {
        source: "registry",
        package: pkg,
        displayName: toolDef?.displayName || toolName,
        transport: (transport as "http" | "stdio"),
        serverUrl: toolDef?.serverUrl,
        platforms: installedPlatforms,
        artifacts,
      });
    } catch { /* best effort */ }
  }

  // Update platform scan files and metadata
  try {
    const detected = detectPlatforms();
    const managedNames = getManagedAugmentNames();
    scanAllPlatforms(detected, managedNames);
    markEquipUpdated();
  } catch { /* best effort */ }

  return count;
}
