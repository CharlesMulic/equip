// Hook installation for platforms that support lifecycle hooks.
// Equip provides the infrastructure; consumers provide hook definitions.
// Zero dependencies.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── Platform Hook Capabilities ──────────────────────────────

/**
 * Which platforms support hooks and what events they handle.
 * Returns null if the platform doesn't support hooks.
 */
function getHookCapabilities(platformId) {
  const caps = {
    "claude-code": {
      settingsPath: () => path.join(os.homedir(), ".claude", "settings.json"),
      events: ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop",
               "SessionStart", "SessionEnd", "UserPromptSubmit", "Notification",
               "SubagentStart", "SubagentStop", "PreCompact", "TaskCompleted"],
      format: "claude-code",
    },
    // Future: cursor, etc.
  };
  return caps[platformId] || null;
}

// ─── Hook Config Generation ─────────────────────────────────

/**
 * Build platform-specific hooks config from consumer-defined hook definitions.
 * @param {Array} hookDefs - Array of { event, matcher?, script, name }
 * @param {string} hookDir - Absolute path to directory containing hook scripts
 * @param {string} platformId - Platform id
 * @returns {object|null} Hooks config in the platform's format
 */
function buildHooksConfig(hookDefs, hookDir, platformId) {
  const caps = getHookCapabilities(platformId);
  if (!caps || !hookDefs || hookDefs.length === 0) return null;

  if (caps.format === "claude-code") {
    const config = {};

    for (const def of hookDefs) {
      if (!caps.events.includes(def.event)) continue;

      const entry = {
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
 * @param {object} platform - Platform object from detect()
 * @param {Array} hookDefs - Array of { event, matcher?, script, name }
 * @param {object} [options] - { hookDir, dryRun, marker }
 * @returns {{ installed: boolean, scripts: string[], hookDir: string } | null}
 */
function installHooks(platform, hookDefs, options = {}) {
  const caps = getHookCapabilities(platform.platform);
  if (!caps || !hookDefs || hookDefs.length === 0) return null;

  if (!options.hookDir) throw new Error("hookDir is required");
  const hookDir = options.hookDir;
  const dryRun = options.dryRun || false;

  // 1. Write hook scripts
  const installedScripts = [];

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

  // 2. Register hooks in platform settings
  const hooksConfig = buildHooksConfig(hookDefs, hookDir, platform.platform);
  if (!hooksConfig) return null;

  if (!dryRun) {
    const settingsPath = caps.settingsPath();
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch { /* file doesn't exist yet */ }

    // Merge hooks — preserve existing non-marker hooks
    if (!settings.hooks) settings.hooks = {};

    for (const [event, hookGroups] of Object.entries(hooksConfig)) {
      if (!settings.hooks[event]) {
        settings.hooks[event] = hookGroups;
      } else {
        // Remove existing hooks from this marker, then add new ones
        const hookDirNorm = hookDir.replace(/\\/g, "/");
        settings.hooks[event] = settings.hooks[event].filter(
          group => !group.hooks?.some(h => h.command && h.command.replace(/\\/g, "/").includes(hookDirNorm))
        );
        settings.hooks[event].push(...hookGroups);
      }
    }

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  return { installed: true, scripts: installedScripts, hookDir };
}

/**
 * Uninstall hook scripts and remove from platform settings.
 * @param {object} platform - Platform object
 * @param {Array} hookDefs - Array of { event, matcher?, script, name } (need names to know what to remove)
 * @param {object} [options] - { hookDir, dryRun }
 * @returns {boolean} Whether anything was removed
 */
function uninstallHooks(platform, hookDefs, options = {}) {
  const caps = getHookCapabilities(platform.platform);
  if (!caps || !hookDefs || hookDefs.length === 0) return false;

  if (!options.hookDir) throw new Error("hookDir is required");
  const hookDir = options.hookDir;
  const dryRun = options.dryRun || false;
  let removed = false;

  // 1. Remove hook scripts
  for (const def of hookDefs) {
    const filePath = path.join(hookDir, def.name + ".js");
    try {
      if (fs.statSync(filePath).isFile()) {
        if (!dryRun) fs.unlinkSync(filePath);
        removed = true;
      }
    } catch { /* doesn't exist */ }
  }

  // Clean up empty hooks dir
  if (!dryRun) {
    try { fs.rmdirSync(hookDir); } catch { /* not empty or doesn't exist */ }
  }

  // 2. Remove from platform settings
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
            group => !group.hooks?.some(h => h.command && h.command.replace(/\\/g, "/").includes(hookDirNorm))
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
 * @param {object} platform - Platform object
 * @param {Array} hookDefs - Array of { event, matcher?, script, name }
 * @param {object} [options] - { hookDir }
 * @returns {boolean}
 */
function hasHooks(platform, hookDefs, options = {}) {
  const caps = getHookCapabilities(platform.platform);
  if (!caps || !hookDefs || hookDefs.length === 0) return false;

  if (!options.hookDir) throw new Error("hookDir is required");
  const hookDir = options.hookDir;

  // Check scripts exist
  for (const def of hookDefs) {
    try {
      if (!fs.statSync(path.join(hookDir, def.name + ".js")).isFile()) return false;
    } catch { return false; }
  }

  // Check settings registration
  try {
    const settings = JSON.parse(fs.readFileSync(caps.settingsPath(), "utf-8"));
    if (!settings.hooks) return false;
    const hookDirNorm = hookDir.replace(/\\/g, "/");
    const hasRegistered = Object.values(settings.hooks).some(groups =>
      groups.some(g => g.hooks?.some(h => h.command && h.command.replace(/\\/g, "/").includes(hookDirNorm)))
    );
    return hasRegistered;
  } catch { return false; }
}

module.exports = {
  getHookCapabilities,
  buildHooksConfig,
  installHooks,
  uninstallHooks,
  hasHooks,
};
