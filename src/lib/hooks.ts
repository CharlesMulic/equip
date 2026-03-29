// Hook installation for platforms that support lifecycle hooks.
// Reads capabilities from the platform registry.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import { PLATFORM_REGISTRY, type DetectedPlatform, type PlatformHookCapabilities } from "./platforms";

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
 */
export function installHooks(platform: DetectedPlatform, hookDefs: HookDefinition[], options: { hookDir?: string; dryRun?: boolean } = {}): { installed: boolean; scripts: string[]; hookDir: string } | null {
  const caps = getHookCapabilities(platform.platform);
  if (!caps || !hookDefs || hookDefs.length === 0) return null;

  if (!options.hookDir) throw new Error("hookDir is required");
  const hookDir = options.hookDir;
  const dryRun = options.dryRun || false;

  const installedScripts: string[] = [];

  if (!dryRun) {
    fs.mkdirSync(hookDir, { recursive: true });
  }

  for (const def of hookDefs) {
    if (!caps.events.includes(def.event)) continue;
    const filePath = path.join(hookDir, def.name + ".js");
    if (!dryRun) {
      fs.writeFileSync(filePath, def.script, { mode: 0o755 });
    }
    installedScripts.push(def.name + ".js");
  }

  if (installedScripts.length === 0) return null;

  const hooksConfig = buildHooksConfig(hookDefs, hookDir, platform.platform);
  if (!hooksConfig) return null;

  if (!dryRun) {
    const settingsPath = caps.settingsPath();
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch { /* file doesn't exist yet */ }

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
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  return { installed: true, scripts: installedScripts, hookDir };
}

/**
 * Uninstall hook scripts and remove from platform settings.
 */
export function uninstallHooks(platform: DetectedPlatform, hookDefs: HookDefinition[], options: { hookDir?: string; dryRun?: boolean } = {}): boolean {
  const caps = getHookCapabilities(platform.platform);
  if (!caps || !hookDefs || hookDefs.length === 0) return false;

  if (!options.hookDir) throw new Error("hookDir is required");
  const hookDir = options.hookDir;
  const dryRun = options.dryRun || false;
  let removed = false;

  for (const def of hookDefs) {
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
    const settingsPath = caps.settingsPath();
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
 */
export function hasHooks(platform: DetectedPlatform, hookDefs: HookDefinition[], options: { hookDir?: string } = {}): boolean {
  const caps = getHookCapabilities(platform.platform);
  if (!caps || !hookDefs || hookDefs.length === 0) return false;

  if (!options.hookDir) throw new Error("hookDir is required");
  const hookDir = options.hookDir;

  for (const def of hookDefs) {
    try {
      if (!fs.statSync(path.join(hookDir, def.name + ".js")).isFile()) return false;
    } catch { return false; }
  }

  try {
    const settings = JSON.parse(fs.readFileSync(caps.settingsPath(), "utf-8"));
    if (!settings.hooks) return false;
    const hookDirNorm = hookDir.replace(/\\/g, "/");
    const hasRegistered = Object.values(settings.hooks as Record<string, Array<Record<string, unknown>>>).some(groups =>
      groups.some(g => (g.hooks as Array<Record<string, string>>)?.some(h => h.command && h.command.replace(/\\/g, "/").includes(hookDirNorm)))
    );
    return hasRegistered;
  } catch { return false; }
}
