// Hook installation for platforms that support lifecycle hooks.
// Reads capabilities from the platform registry.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import { PLATFORM_REGISTRY, type DetectedPlatform, type PlatformHookCapabilities } from "./platforms";
import { safeReadJsonSync, atomicWriteFileSync } from "./fs";
import { validateHookName } from "./validation";
import { posixMode } from "./posix-mode";
import type { ArtifactResult, EquipLogger } from "./types";
import { makeResult, NOOP_LOGGER } from "./types";

// ─── Types ──────────────────────────────────────────────────

export interface HookDefinition {
  event: string;
  matcher?: string;
  script: string;
  name: string;
}

// ─── Capabilities ───────────────────────────────────────────

/**
 * Get hook capabilities for a platform (from registry).
 */
export function getHookCapabilities(platformId: string): PlatformHookCapabilities | null {
  return PLATFORM_REGISTRY.get(platformId)?.hooks ?? null;
}

// ─── Hook Config Generation ─────────────────────────────────

/**
 * Build platform-specific hooks config from consumer-defined hook definitions.
 */
export function buildHooksConfig(hookDefs: HookDefinition[], hookDir: string, platformId: string): Record<string, unknown[]> | null {
  const caps = getHookCapabilities(platformId);
  if (!caps || !hookDefs || hookDefs.length === 0) return null;

  if (caps.format === "claude-code") {
    const config: Record<string, unknown[]> = {};

    for (const def of hookDefs) {
      if (!caps.events.includes(def.event)) continue;

      const entry: Record<string, unknown> = {
        hooks: [{
          type: "command",
          command: `node "${path.join(hookDir, def.name + ".js")}"`,
        }],
      };
      if (def.matcher) entry.matcher = def.matcher;

      if (!config[def.event]) config[def.event] = [];
      config[def.event].push(entry);
    }

    return Object.keys(config).length > 0 ? config : null;
  }

  return null;
}

// ─── Installation ────────────────────────────────────────────

/**
 * Install hook scripts to disk and register them in platform settings.
 *
 * `settingsPath` overrides the platform registry's settings location. Tests
 * pass this to avoid writing to the real user-global settings file; production
 * callers omit it and the registry path is used.
 */
export function installHooks(platform: DetectedPlatform, hookDefs: HookDefinition[], options: { hookDir?: string; dryRun?: boolean; logger?: EquipLogger; settingsPath?: string } = {}): ArtifactResult {
  const logger = options.logger || NOOP_LOGGER;
  const caps = getHookCapabilities(platform.platform);
  if (!caps || !hookDefs || hookDefs.length === 0) {
    return makeResult("hooks", { attempted: false, success: true, action: "skipped" });
  }

  if (!options.hookDir) throw new Error("hookDir is required");
  const hookDir = options.hookDir;
  const dryRun = options.dryRun || false;

  const installedScripts: string[] = [];

  if (!dryRun) {
    fs.mkdirSync(hookDir, { recursive: true });
  }

  for (const def of hookDefs) {
    if (!caps.events.includes(def.event)) continue;
    validateHookName(def.name);
    const filePath = path.join(hookDir, def.name + ".js");
    if (!dryRun) {
      fs.writeFileSync(filePath, def.script, { mode: posixMode(0o755) });
    }
    installedScripts.push(def.name + ".js");
  }

  if (installedScripts.length === 0) {
    return makeResult("hooks", { attempted: true, success: true, action: "skipped" });
  }

  const hooksConfig = buildHooksConfig(hookDefs, hookDir, platform.platform);
  if (!hooksConfig) {
    return makeResult("hooks", { attempted: true, success: true, action: "skipped" });
  }

  const result = makeResult("hooks", { success: true, action: "created", scripts: installedScripts, hookDir });

  if (!dryRun) {
    const settingsPath = options.settingsPath ?? caps.settingsPath();
    const { data: settingsData, status, error } = safeReadJsonSync(settingsPath);

    if (status === "corrupt") {
      logger.error("Settings file corrupt — refusing to overwrite", { settingsPath, error });
      return makeResult("hooks", { errorCode: "SETTINGS_CORRUPT", error: `Cannot install hooks: ${settingsPath} is corrupt. Fix it manually.`, scripts: installedScripts, hookDir });
    }
    if (status === "unreadable") {
      logger.error("Settings file unreadable", { settingsPath, error });
      return makeResult("hooks", { errorCode: "SETTINGS_CORRUPT", error: `Cannot read ${settingsPath}: ${error}`, scripts: installedScripts, hookDir });
    }

    const settings: Record<string, unknown> = settingsData || {};
    if (status === "missing") {
      result.warnings.push({ code: "WARN_SETTINGS_CREATED", message: "Settings file did not exist — created new" });
      logger.info("Creating new settings file", { settingsPath });
    }

    if (!settings.hooks) settings.hooks = {};
    const hooks = settings.hooks as Record<string, unknown[]>;

    for (const [event, hookGroups] of Object.entries(hooksConfig)) {
      if (!hooks[event]) {
        hooks[event] = hookGroups;
      } else {
        const hookDirNorm = hookDir.replace(/\\/g, "/");
        hooks[event] = (hooks[event] as Array<Record<string, unknown>>).filter(
          group => !(group.hooks as Array<Record<string, string>>)?.some(h => h.command && h.command.replace(/\\/g, "/").includes(hookDirNorm))
        );
        hooks[event].push(...hookGroups);
      }
    }

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2));
    logger.info("Hooks registered in settings", { settingsPath, scripts: installedScripts });
  }

  return result;
}

/**
 * Uninstall hook scripts and remove from platform settings.
 *
 * `settingsPath` overrides the platform registry's settings location. Tests
 * pass this to avoid touching the real user-global settings file.
 */
export function uninstallHooks(platform: DetectedPlatform, hookDefs: HookDefinition[], options: { hookDir?: string; dryRun?: boolean; settingsPath?: string } = {}): boolean {
  const caps = getHookCapabilities(platform.platform);
  if (!caps || !hookDefs || hookDefs.length === 0) return false;

  if (!options.hookDir) throw new Error("hookDir is required");
  const hookDir = options.hookDir;
  const dryRun = options.dryRun || false;
  let removed = false;

  for (const def of hookDefs) {
    validateHookName(def.name);
    const filePath = path.join(hookDir, def.name + ".js");
    try {
      if (fs.statSync(filePath).isFile()) {
        if (!dryRun) fs.unlinkSync(filePath);
        removed = true;
      }
    } catch { /* doesn't exist */ }
  }

  if (!dryRun) {
    try { fs.rmdirSync(hookDir); } catch { /* not empty or doesn't exist */ }
  }

  if (!dryRun) {
    const settingsPath = options.settingsPath ?? caps.settingsPath();
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings.hooks) {
        let changed = false;
        const hookDirNorm = hookDir.replace(/\\/g, "/");
        for (const event of Object.keys(settings.hooks)) {
          const before = settings.hooks[event].length;
          settings.hooks[event] = settings.hooks[event].filter(
            (group: Record<string, unknown>) => !(group.hooks as Array<Record<string, string>>)?.some(h => h.command && h.command.replace(/\\/g, "/").includes(hookDirNorm))
          );
          if (settings.hooks[event].length === 0) {
            delete settings.hooks[event];
          }
          if (settings.hooks[event]?.length !== before) changed = true;
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
        if (changed) {
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
          removed = true;
        }
      }
    } catch { /* file doesn't exist */ }
  }

  return removed;
}

/**
 * Check if hooks are installed for a platform.
 *
 * `settingsPath` overrides the platform registry's settings location.
 */
export function hasHooks(platform: DetectedPlatform, hookDefs: HookDefinition[], options: { hookDir?: string; settingsPath?: string } = {}): boolean {
  const caps = getHookCapabilities(platform.platform);
  if (!caps || !hookDefs || hookDefs.length === 0) return false;

  if (!options.hookDir) throw new Error("hookDir is required");
  const hookDir = options.hookDir;

  for (const def of hookDefs) {
    validateHookName(def.name);
    try {
      if (!fs.statSync(path.join(hookDir, def.name + ".js")).isFile()) return false;
    } catch { return false; }
  }

  try {
    const settings = JSON.parse(fs.readFileSync(options.settingsPath ?? caps.settingsPath(), "utf-8"));
    if (!settings.hooks) return false;
    const hookDirNorm = hookDir.replace(/\\/g, "/");
    const hasRegistered = Object.values(settings.hooks as Record<string, Array<Record<string, unknown>>>).some(groups =>
      groups.some(g => (g.hooks as Array<Record<string, string>>)?.some(h => h.command && h.command.replace(/\\/g, "/").includes(hookDirNorm)))
    );
    return hasRegistered;
  } catch { return false; }
}

// ─── Orphan-entry sweep ─────────────────────────────────────

export interface OrphanHookEntry {
  event: string;
  command: string;
  scriptPath: string | null;
  reason: "script-missing";
}

/**
 * Pull node-script paths out of a hook command. Tolerant of variations like
 * `node "path"`, `node path`, and Windows backslash paths. Returns null if
 * the command shape isn't recognized — caller treats that as "leave alone."
 */
function extractScriptPath(command: string): string | null {
  const trimmed = command.trim();
  // Match: node "..."  |  node '...'  |  node <unquoted>
  const m = trimmed.match(/^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  if (!m) return null;
  return m[1] || m[2] || m[3] || null;
}

/**
 * Scan a platform's settings file for hook entries whose script files do not
 * exist on disk. These are typically left behind when an augment that shipped
 * hooks is uninstalled (or transitions to `hooks: null`) without the orphan
 * settings entries being reconciled. Test-suite leaks (writes into the real
 * user settings) end up here too once the OS clears the temp dir they pointed
 * at.
 *
 * `prune: true` removes the orphan entries (and any hook events / hooks block
 * that becomes empty). `prune: false` (default) is a dry scan — returns the
 * list of orphans without touching the file.
 */
export function findOrphanHookEntries(platformId: string, options: { settingsPath?: string; prune?: boolean } = {}): OrphanHookEntry[] {
  const caps = getHookCapabilities(platformId);
  if (!caps) return [];

  const settingsPath = options.settingsPath ?? caps.settingsPath();
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    return [];
  }
  const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>> | undefined;
  if (!hooks || typeof hooks !== "object") return [];

  const orphans: OrphanHookEntry[] = [];
  // Track which (event, groupIndex) pairs to remove if pruning.
  const toRemove: Map<string, Set<number>> = new Map();

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const groupHooks = (group?.hooks as Array<Record<string, string>>) || [];
      if (groupHooks.length === 0) continue;
      // A group is orphaned only if EVERY contained hook is a node-script command
      // and EVERY referenced script is missing. Any unparseable command, any
      // existing file, any non-file stat result -> leave the group alone.
      const candidates: OrphanHookEntry[] = [];
      let safeToRemove = true;
      for (const h of groupHooks) {
        if (!h?.command || typeof h.command !== "string") { safeToRemove = false; break; }
        const scriptPath = extractScriptPath(h.command);
        if (!scriptPath) { safeToRemove = false; break; }
        let exists = false;
        try { exists = fs.statSync(scriptPath).isFile(); } catch { exists = false; }
        if (exists) { safeToRemove = false; break; }
        candidates.push({ event, command: h.command, scriptPath, reason: "script-missing" });
      }
      if (safeToRemove && candidates.length > 0) {
        orphans.push(...candidates);
        if (!toRemove.has(event)) toRemove.set(event, new Set());
        toRemove.get(event)!.add(i);
      }
    }
  }

  if (options.prune && orphans.length > 0) {
    for (const [event, indices] of toRemove) {
      hooks[event] = (hooks[event] as Array<Record<string, unknown>>).filter((_, i) => !indices.has(i));
      if (hooks[event].length === 0) delete hooks[event];
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  return orphans;
}
