// MCP config read/write/merge/uninstall.
// Handles all platform-specific config format differences.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import { PLATFORM_REGISTRY, type DetectedPlatform } from "./platforms";

// ─── TOML Helpers (minimal, zero-dep) ───────────────────────

/**
 * Parse a TOML table entry for [mcp_servers.<name>].
 * Returns key-value pairs as a plain object. Supports string, number, boolean, arrays.
 * This is NOT a full TOML parser — only handles flat tables needed for MCP config.
 */
export function parseTomlServerEntry(tomlContent: string, rootKey: string, serverName: string): Record<string, unknown> | null {
  const tableHeader = `[${rootKey}.${serverName}]`;
  const idx = tomlContent.indexOf(tableHeader);
  if (idx === -1) return null;

  const afterHeader = tomlContent.slice(idx + tableHeader.length);
  const nextTable = afterHeader.search(/\n\[(?!\[)/);
  const block = nextTable === -1 ? afterHeader : afterHeader.slice(0, nextTable);

  const result: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      result[key] = val.slice(1, -1);
    } else if (val === "true") {
      result[key] = true;
    } else if (val === "false") {
      result[key] = false;
    } else if (!isNaN(Number(val)) && val !== "") {
      result[key] = Number(val);
    } else {
      result[key] = val;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse nested TOML sub-tables (e.g., [mcp_servers.prior.env]).
 */
export function parseTomlSubTables(tomlContent: string, rootKey: string, serverName: string): Record<string, Record<string, string>> {
  const prefix = `[${rootKey}.${serverName}.`;
  const result: Record<string, Record<string, string>> = {};
  let idx = 0;
  while ((idx = tomlContent.indexOf(prefix, idx)) !== -1) {
    const lineEnd = tomlContent.indexOf("\n", idx);
    const header = tomlContent.slice(idx, lineEnd === -1 ? undefined : lineEnd).trim();
    const subName = header.slice(prefix.length, -1);
    if (!subName || subName.includes(".")) { idx++; continue; }

    const afterHeader = tomlContent.slice(lineEnd === -1 ? tomlContent.length : lineEnd);
    const nextTable = afterHeader.search(/\n\[(?!\[)/);
    const block = nextTable === -1 ? afterHeader : afterHeader.slice(0, nextTable);

    const sub: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("[")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) sub[k] = v.slice(1, -1);
      else sub[k] = v;
    }
    if (Object.keys(sub).length > 0) result[subName] = sub;
    idx++;
  }
  return result;
}

/**
 * Build TOML text for a server entry.
 */
export function buildTomlEntry(rootKey: string, serverName: string, config: Record<string, unknown>): string {
  const lines = [`[${rootKey}.${serverName}]`];
  const subTables: Record<string, Record<string, unknown>> = {};

  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      subTables[k] = v as Record<string, unknown>;
    } else if (typeof v === "string") {
      lines.push(`${k} = "${v}"`);
    } else if (typeof v === "boolean" || typeof v === "number") {
      lines.push(`${k} = ${v}`);
    } else if (Array.isArray(v)) {
      lines.push(`${k} = [${v.map(x => typeof x === "string" ? `"${x}"` : x).join(", ")}]`);
    }
  }

  for (const [subName, subObj] of Object.entries(subTables)) {
    lines.push("", `[${rootKey}.${serverName}.${subName}]`);
    for (const [k, v] of Object.entries(subObj)) {
      if (typeof v === "string") lines.push(`${k} = "${v}"`);
      else lines.push(`${k} = ${v}`);
    }
  }

  return lines.join("\n");
}

/**
 * Remove a TOML server entry block from content.
 */
export function removeTomlEntry(tomlContent: string, rootKey: string, serverName: string): string {
  const mainHeader = `[${rootKey}.${serverName}]`;
  const subPrefix = `[${rootKey}.${serverName}.`;

  const lines = tomlContent.split("\n");
  const result: string[] = [];
  let inEntry = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === mainHeader || trimmed.startsWith(subPrefix)) {
      inEntry = true;
      continue;
    }
    if (inEntry && trimmed.startsWith("[") && !trimmed.startsWith(subPrefix)) {
      inEntry = false;
    }
    if (!inEntry) {
      result.push(line);
    }
  }

  return result.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ─── Read ────────────────────────────────────────────────────

/**
 * Read an MCP server entry from a config file (JSON or TOML).
 */
export function readMcpEntry(configPath: string, rootKey: string, serverName: string, configFormat: string = "json"): Record<string, unknown> | null {
  try {
    let raw = fs.readFileSync(configPath, "utf-8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

    if (configFormat === "toml") {
      const entry = parseTomlServerEntry(raw, rootKey, serverName);
      if (!entry) return null;
      const subs = parseTomlSubTables(raw, rootKey, serverName);
      return { ...entry, ...subs };
    }

    const data = JSON.parse(raw);
    return data?.[rootKey]?.[serverName] || null;
  } catch { return null; }
}

// ─── Config Builders ─────────────────────────────────────────

function _fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Build HTTP MCP config for a platform.
 * Uses the platform registry to determine field names.
 */
export function buildHttpConfig(serverUrl: string, platform: string): Record<string, unknown> {
  const def = PLATFORM_REGISTRY.get(platform);
  if (!def) return { url: serverUrl };

  const result: Record<string, unknown> = { [def.httpShape.urlField]: serverUrl };
  if (def.httpShape.typeField) result.type = def.httpShape.typeField;
  return result;
}

/**
 * Build HTTP MCP config with auth headers.
 */
export function buildHttpConfigWithAuth(serverUrl: string, apiKey: string, platform: string, extraHeaders?: Record<string, string>): Record<string, unknown> {
  const base = buildHttpConfig(serverUrl, platform);
  const def = PLATFORM_REGISTRY.get(platform);
  const headersField = def?.httpShape.headersField ?? "headers";

  return {
    ...base,
    [headersField]: {
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
  };
}

/**
 * Build stdio MCP config.
 */
export function buildStdioConfig(command: string, args: string[], env: Record<string, string>): Record<string, unknown> {
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", command, ...args], env };
  }
  return { command, args, env };
}

// ─── Install ─────────────────────────────────────────────────

/**
 * Install MCP config for a platform.
 * Writes directly to the platform's config file (JSON or TOML).
 */
export function installMcp(platform: DetectedPlatform, serverName: string, mcpEntry: Record<string, unknown>, options: { dryRun?: boolean; serverUrl?: string } = {}): { success: boolean; method: string } {
  const { dryRun = false } = options;
  if (platform.configFormat === "toml") {
    return installMcpToml(platform, serverName, mcpEntry, dryRun);
  }
  return installMcpJson(platform, serverName, mcpEntry, dryRun);
}

/**
 * Write MCP config directly to JSON file.
 */
export function installMcpJson(platform: DetectedPlatform, serverName: string, mcpEntry: Record<string, unknown>, dryRun: boolean): { success: boolean; method: string } {
  const { configPath, rootKey } = platform;

  let existing: Record<string, unknown> = {};
  try {
    let raw = fs.readFileSync(configPath, "utf-8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    existing = JSON.parse(raw);
    if (typeof existing !== "object" || existing === null) existing = {};
  } catch { /* start fresh */ }

  if (!existing[rootKey]) existing[rootKey] = {};
  (existing[rootKey] as Record<string, unknown>)[serverName] = mcpEntry;

  if (!dryRun) {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (_fileExists(configPath)) {
      try { fs.copyFileSync(configPath, configPath + ".bak"); } catch {}
    }
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
  }

  return { success: true, method: "json" };
}

/**
 * Write MCP config to TOML file (Codex).
 */
export function installMcpToml(platform: DetectedPlatform, serverName: string, mcpEntry: Record<string, unknown>, dryRun: boolean): { success: boolean; method: string } {
  const { configPath, rootKey } = platform;

  let existing = "";
  try { existing = fs.readFileSync(configPath, "utf-8"); } catch { /* start fresh */ }

  const tableHeader = `[${rootKey}.${serverName}]`;
  if (existing.includes(tableHeader)) {
    existing = removeTomlEntry(existing, rootKey, serverName);
  }

  const newBlock = buildTomlEntry(rootKey, serverName, mcpEntry);

  if (!dryRun) {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (_fileExists(configPath)) {
      try { fs.copyFileSync(configPath, configPath + ".bak"); } catch {}
    }
    const sep = existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
    fs.writeFileSync(configPath, existing + sep + newBlock + "\n");
  }

  return { success: true, method: "toml" };
}

/**
 * Remove an MCP server entry from a platform config.
 */
export function uninstallMcp(platform: DetectedPlatform, serverName: string, dryRun: boolean = false): boolean {
  const { configPath, rootKey } = platform;
  if (!_fileExists(configPath)) return false;

  if (platform.configFormat === "toml") {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      const tableHeader = `[${rootKey}.${serverName}]`;
      if (!content.includes(tableHeader)) return false;
      if (!dryRun) {
        fs.copyFileSync(configPath, configPath + ".bak");
        const cleaned = removeTomlEntry(content, rootKey, serverName);
        if (cleaned.trim()) {
          fs.writeFileSync(configPath, cleaned);
        } else {
          fs.unlinkSync(configPath);
        }
      }
      return true;
    } catch { return false; }
  }

  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!data?.[rootKey]?.[serverName]) return false;
    delete data[rootKey][serverName];
    if (Object.keys(data[rootKey]).length === 0) delete data[rootKey];
    if (!dryRun) {
      fs.copyFileSync(configPath, configPath + ".bak");
      if (Object.keys(data).length === 0) {
        fs.unlinkSync(configPath);
      } else {
        fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
      }
    }
    return true;
  } catch { return false; }
}

/**
 * Update API key in existing MCP config.
 */
export function updateMcpKey(platform: DetectedPlatform, serverName: string, mcpEntry: Record<string, unknown>): { success: boolean; method: string } {
  if (platform.configFormat === "toml") {
    return installMcpToml(platform, serverName, mcpEntry, false);
  }
  return installMcpJson(platform, serverName, mcpEntry, false);
}
