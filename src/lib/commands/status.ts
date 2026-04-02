// equip status — show all MCP servers across all platforms.
// Reads config files directly and cross-references with installations.json.

import * as fs from "fs";
import { PLATFORM_REGISTRY } from "../platforms";
import { dirExists, fileExists } from "../detect";
import { getManagedAugmentNames } from "../installations";
import * as cli from "../cli";

interface ServerInfo {
  name: string;
  platforms: string[];
  tracked: boolean;
}

export function runStatus(): void {
  const managedNames = getManagedAugmentNames();
  const servers = new Map<string, ServerInfo>();
  const platformResults: { id: string; name: string; count: number }[] = [];

  cli.log(`\n${cli.BOLD}equip status${cli.RESET}\n`);

  // Scan all platforms
  for (const [id, def] of PLATFORM_REGISTRY) {
    const configPath = def.configPath();

    // Check if platform is present
    const dirFound = def.detection.dirs.some(fn => dirExists(fn()));
    const fileFound = def.detection.files.some(fn => fileExists(fn()));
    if (!dirFound && !fileFound && !fileExists(configPath)) continue;

    // Read all MCP entries from config
    const entries = readAllEntries(configPath, def.rootKey, def.configFormat);
    if (!entries) {
      platformResults.push({ id, name: def.name, count: 0 });
      continue;
    }

    const entryNames = Object.keys(entries);
    platformResults.push({ id, name: def.name, count: entryNames.length });

    for (const name of entryNames) {
      if (!servers.has(name)) {
        const tracked = managedNames.has(name);
        servers.set(name, { name, platforms: [], tracked });
      }
      servers.get(name)!.platforms.push(def.name);
    }
  }

  // Print platforms
  if (platformResults.length === 0) {
    cli.warn("No AI coding platforms detected.");
    cli.log("");
    return;
  }

  cli.log(`${cli.BOLD}Detected platforms${cli.RESET}`);
  for (const p of platformResults) {
    const countStr = p.count === 0
      ? `${cli.DIM}no MCP servers${cli.RESET}`
      : `${cli.GREEN}${p.count} MCP server${p.count === 1 ? "" : "s"}${cli.RESET}`;
    cli.log(`  ${p.name.padEnd(22)} ${countStr}`);
  }

  // Print servers
  if (servers.size === 0) {
    cli.log(`\n${cli.DIM}No MCP servers configured on any platform.${cli.RESET}\n`);
    return;
  }

  cli.log(`\n${cli.BOLD}MCP servers${cli.RESET}`);
  const sorted = [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const srv of sorted) {
    const badge = srv.tracked ? `${cli.GREEN}equip${cli.RESET}` : `${cli.DIM}manual${cli.RESET}`;
    const plats = srv.platforms.join(", ");
    cli.log(`  ${srv.name.padEnd(20)} ${plats.padEnd(35)} [${badge}]`);
  }

  // Summary
  const trackedCount = sorted.filter(s => s.tracked).length;
  const manualCount = sorted.length - trackedCount;
  cli.log(`\n  ${cli.DIM}${sorted.length} server${sorted.length === 1 ? "" : "s"} total (${trackedCount} via equip, ${manualCount} manual)${cli.RESET}\n`);
}

// ─── Helpers ────────────────────────────────────────────────

function readAllEntries(configPath: string, rootKey: string, configFormat: string): Record<string, unknown> | null {
  try {
    let raw = fs.readFileSync(configPath, "utf-8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

    if (configFormat === "toml") {
      return readAllTomlEntries(raw, rootKey);
    }

    const data = JSON.parse(raw);
    return data?.[rootKey] || null;
  } catch {
    return null;
  }
}

function readAllTomlEntries(content: string, rootKey: string): Record<string, unknown> | null {
  const prefix = `[${rootKey}.`;
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix) && !trimmed.includes(".", prefix.length)) {
      const name = trimmed.slice(prefix.length, -1);
      if (name && !name.includes(".")) {
        result[name] = {};
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}
