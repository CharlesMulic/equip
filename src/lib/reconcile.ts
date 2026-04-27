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
import { acquireLock } from "./fs";
import { trackInstallation, getManagedAugmentNames, type ArtifactRecord } from "./installations";
import { scanAllPlatforms, isPlatformEnabled } from "./platform-state";
import { readAugmentDef, syncFromRegistry } from "./augment-defs";
import { markEquipUpdated } from "./equip-meta";
import { createSnapshot, hasInitialSnapshot } from "./snapshots";
import type { RegistryDef } from "./registry";
import type { DetectedPlatform } from "./platforms";
import type { EquipLogger } from "./types";
import { NOOP_LOGGER } from "./types";

// ─── Types ──────────────────────────────────────────────────

export interface ReconcileOptions {
  /** Augment name (used as key in state and to find MCP entries) */
  toolName: string;
  /** npm package name (e.g. "@cg3/prior-node") */
  package: string;
  /** Rules marker name. Defaults to toolName if not provided. */
  marker?: string;
  /** Hook directory path. Defaults to ~/.{toolName}/hooks if not provided. */
  hookDir?: string;
  /** Registry definition (if available, used to sync augment definition) */
  toolDef?: RegistryDef;
  /** Logger for debug/warning output (silent by default) */
  logger?: EquipLogger;
}

// ─── Reconcile ──────────────────────────────────────────────

/**
 * Scan all platform configs and update state based on what's on disk.
 * Returns the number of platforms where the augment was found.
 */
export function reconcileState(options: ReconcileOptions): number {
  const { toolName, package: pkg, marker = toolName, hookDir: customHookDir, toolDef, logger = NOOP_LOGGER } = options;
  const defaultHookDir = path.join(os.homedir(), `.${toolName}`, "hooks");
  const hookDir = customHookDir || defaultHookDir;

  const releaseLock = acquireLock();
  try {
    return reconcileStateInner(toolName, pkg, marker, hookDir, toolDef, logger);
  } finally {
    releaseLock();
  }
}

/**
 * Resolve the set of skill names declared by an augment, consulting the
 * registry def first (freshest) and falling back to the persisted augment
 * def file written by syncFromRegistry / local authoring.
 */
function collectDeclaredSkillNames(toolName: string, toolDef: RegistryDef | undefined): string[] {
  const names = new Set<string>();
  if (toolDef?.skills) {
    for (const s of toolDef.skills) if (s?.name) names.add(s.name);
  }
  try {
    const persisted = readAugmentDef(toolName);
    if (persisted?.skills) {
      for (const s of persisted.skills) if (s?.name) names.add(s.name);
    }
  } catch { /* persisted def may not exist */ }
  return [...names];
}

function reconcileStateInner(
  toolName: string,
  pkg: string,
  marker: string,
  hookDir: string,
  toolDef: RegistryDef | undefined,
  logger: EquipLogger,
): number {
  // Sync augment definition from registry if available
  if (toolDef) {
    try { syncFromRegistry(toolDef); } catch (e: unknown) {
      logger.debug("Failed to sync augment definition", { error: (e as Error).message });
    }
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

    // Check for skills.
    // Skills now live flat at {skillsPath}/{skillName}/SKILL.md, so we can't infer
    // which skills belong to this augment by listing a directory. Cross-reference
    // the augment's declared skill names (from registry def or persisted def file)
    // and look each one up at the flat path. Also accept legacy nested installs
    // from older equip versions so reconcile reflects what's still on disk.
    if (def.skillsPath) {
      const skillsBasePath = def.skillsPath();
      const declaredSkills = collectDeclaredSkillNames(toolName, toolDef);
      const found: string[] = [];
      for (const skillName of declaredSkills) {
        const flat = path.join(skillsBasePath, skillName, "SKILL.md");
        const legacy = path.join(skillsBasePath, toolName, skillName, "SKILL.md");
        try {
          if (fs.statSync(flat).isFile()) { found.push(skillName); continue; }
        } catch { /* fall through */ }
        try {
          if (fs.statSync(legacy).isFile()) found.push(skillName);
        } catch { /* not installed on this platform */ }
      }
      if (found.length > 0) {
        artifactRecord.skills = found;
        hasAnyArtifact = true;
      }
    }

    if (!hasAnyArtifact) continue;

    installedPlatforms.push(id);
    artifacts[id] = artifactRecord;
    count++;
  }

  // Write to installations.json
  if (installedPlatforms.length > 0) {
    try {
      const transport = toolDef?.transport || (artifacts[installedPlatforms[0]]?.mcp ? "http" : "stdio");
      // Source determination: AugmentDef carries an explicit `source` field
      // ("local" | "registry" | "wrapped"); RegistryDef does not (registry-
      // fetched defs are always "registry" by construction). Read from toolDef
      // when present so a local user-save flow (writeAugmentDefAndApply ->
      // apply -> reconcileState) preserves source="local" in installations.json
      // instead of overwriting it. Default to "registry" when toolDef lacks
      // the field, matching the historical behavior for runInstall callers.
      type DefWithSource = { source?: "registry" | "local" | "wrapped" };
      const augmentSource = (toolDef as DefWithSource | undefined)?.source ?? "registry";
      trackInstallation(toolName, {
        source: augmentSource,
        package: pkg,
        title: toolDef?.title || toolName,
        transport: (transport as "http" | "stdio"),
        serverUrl: toolDef?.serverUrl,
        platforms: installedPlatforms,
        artifacts,
      });
    } catch (e: unknown) {
      logger.debug("Failed to track installation", { error: (e as Error).message });
    }
  }

  // Update platform scan files and metadata
  try {
    const detected = detectPlatforms();

    // First-detection snapshots (best effort)
    for (const p of detected) {
      try {
        if (!hasInitialSnapshot(p.platform)) {
          createSnapshot(p, { label: "initial", trigger: "first-detection" });
          logger.debug("Initial snapshot created", { platform: p.platform });
        }
      } catch (e: unknown) {
        logger.debug("Failed to create initial snapshot", { platform: p.platform, error: (e as Error).message });
      }
    }

    const managedNames = getManagedAugmentNames();
    scanAllPlatforms(detected, managedNames);
    markEquipUpdated();
  } catch (e: unknown) {
    logger.debug("Failed to update platform state", { error: (e as Error).message });
  }

  return count;
}
