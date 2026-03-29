// State reconciliation — scans platform configs after tool dispatch
// and records what's actually on disk in ~/.equip/state.json.
//
// Called by the global CLI after a tool's setup completes.
// This is the single source of truth for state writes.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PLATFORM_REGISTRY } from "./platforms";
import { readMcpEntry } from "./mcp";
import { trackInstall, type ToolPlatformRecord } from "./state";
import { dirExists, fileExists } from "./detect";

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
}

// ─── Reconcile ──────────────────────────────────────────────

/**
 * Scan all platform configs and update state based on what's on disk.
 * Returns the number of platforms where the tool was found.
 */
export function reconcileState(options: ReconcileOptions): number {
  const { toolName, package: pkg, marker = toolName, hookDir: customHookDir } = options;
  const defaultHookDir = path.join(os.homedir(), `.${toolName}`, "hooks");
  const hookDir = customHookDir || defaultHookDir;

  let count = 0;

  for (const [id, def] of PLATFORM_REGISTRY) {
    // Quick presence check (fast fs stat)
    const dirFound = def.detection.dirs.some(fn => dirExists(fn()));
    const fileFound = def.detection.files.some(fn => fileExists(fn()));
    const configPath = def.configPath();
    if (!dirFound && !fileFound && !fileExists(configPath)) continue;

    // Check if tool has an MCP entry on this platform
    const entry = readMcpEntry(configPath, def.rootKey, toolName, def.configFormat);
    if (!entry) continue;

    // Build state record from what's on disk
    const record: Partial<ToolPlatformRecord> = {
      configPath,
      transport: (entry as Record<string, unknown>).command ? "stdio" : "http",
    };

    // Check for rules (only on platforms that have a writable rules path)
    if (def.rulesPath) {
      const rulesPath = def.rulesPath();
      try {
        const content = fs.readFileSync(rulesPath, "utf-8");
        const versionMatch = content.match(new RegExp(`<!-- ${marker}:v([0-9.]+) -->`));
        if (versionMatch) {
          record.rulesPath = rulesPath;
          record.rulesVersion = versionMatch[1];
        }
      } catch { /* rules file may not exist */ }
    }

    // Check for hooks (only on platforms that support hooks)
    if (def.hooks) {
      try {
        const hookFiles = fs.readdirSync(hookDir).filter(f => f.endsWith(".js"));
        if (hookFiles.length > 0) {
          record.hookDir = hookDir;
          record.hookScripts = hookFiles;
        }
      } catch { /* hook dir may not exist */ }
    }

    trackInstall(toolName, pkg, id, record);
    count++;
  }

  return count;
}
