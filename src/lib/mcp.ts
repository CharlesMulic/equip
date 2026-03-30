// MCP config read/write/merge/uninstall.
// Handles all platform-specific config format differences.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import { PLATFORM_REGISTRY, type DetectedPlatform } from "./platforms";
import { atomicWriteFileSync, safeReadJsonSync, createBackup, cleanupBackup } from "./fs";
import type { ArtifactResult, EquipLogger } from "./types";
import { makeResult, NOOP_LOGGER } from "./types";

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
 * Read an MCP server entry with detailed status.
 * Distinguishes "not installed" from "file unreadable" from "file corrupt".
 */
export interface ReadMcpResult {
  entry: Record<string, unknown> | null;
  status: "ok" | "missing" | "not_found" | "corrupt" | "unreadable";
  error?: string;
}

export function readMcpEntryDetailed(configPath: string, rootKey: string, serverName: string, configFormat: string = "json"): ReadMcpResult {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { entry: null, status: "missing" };
    return { entry: null, status: "unreadable", error: (err as Error).message };
  }

  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  if (configFormat === "toml") {
    try {
      const entry = parseTomlServerEntry(raw, rootKey, serverName);
      if (!entry) return { entry: null, status: "not_found" };
      const subs = parseTomlSubTables(raw, rootKey, serverName);
      return { entry: { ...entry, ...subs }, status: "ok" };
    } catch (err: unknown) {
      return { entry: null, status: "corrupt", error: (err as Error).message };
    }
  }

  try {
    const data = JSON.parse(raw);
    const entry = data?.[rootKey]?.[serverName] || null;
    return { entry, status: entry ? "ok" : "not_found" };
  } catch (err: unknown) {
    return { entry: null, status: "corrupt", error: (err as Error).message };
  }
}

/**
 * Read an MCP server entry from a config file (JSON or TOML).
 * Returns the entry or null. Use readMcpEntryDetailed() for error context.
 */
export function readMcpEntry(configPath: string, rootKey: string, serverName: string, configFormat: string = "json"): Record<string, unknown> | null {
  return readMcpEntryDetailed(configPath, rootKey, serverName, configFormat).entry;
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
  const headersWrapper = def?.httpShape.headersWrapper;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    ...extraHeaders,
  };

  if (headersWrapper) {
    // Nested headers: e.g., Tabnine uses { requestInit: { headers: {...} } }
    return {
      ...base,
      [headersWrapper]: { [headersField]: headers },
    };
  }

  return {
    ...base,
    [headersField]: headers,
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
export function installMcp(platform: DetectedPlatform, serverName: string, mcpEntry: Record<string, unknown>, options: { dryRun?: boolean; serverUrl?: string; logger?: EquipLogger } = {}): ArtifactResult {
  const { dryRun = false, logger = NOOP_LOGGER } = options;
  if (platform.configFormat === "toml") {
    return installMcpToml(platform, serverName, mcpEntry, dryRun, logger);
  }
  return installMcpJson(platform, serverName, mcpEntry, dryRun, logger);
}

/**
 * Write MCP config directly to JSON file.
 * Uses atomic writes and detects corrupt config files.
 */
export function installMcpJson(platform: DetectedPlatform, serverName: string, mcpEntry: Record<string, unknown>, dryRun: boolean, logger: EquipLogger = NOOP_LOGGER): ArtifactResult {
  const { configPath, rootKey } = platform;

  const { data: existing, status, error } = safeReadJsonSync(configPath);
  if (status === "corrupt") {
    logger.error("Config file corrupt", { configPath, error });
    return makeResult("mcp", { errorCode: "CONFIG_CORRUPT", error: `Cannot install to ${configPath}: ${error}. Fix the file manually or restore from ${configPath}.bak if available.`, method: "json" });
  }
  if (status === "unreadable") {
    logger.error("Config file unreadable", { configPath, error });
    return makeResult("mcp", { errorCode: "CONFIG_UNREADABLE", error: `Cannot read ${configPath}: ${error}`, method: "json" });
  }

  const config = existing || {};
  if (!config[rootKey]) config[rootKey] = {};
  (config[rootKey] as Record<string, unknown>)[serverName] = mcpEntry;

  const result = makeResult("mcp", { success: true, action: existing ? "updated" : "created", method: "json" });

  if (!dryRun) {
    const backedUp = createBackup(configPath);
    if (!backedUp && status === "ok") {
      result.warnings.push({ code: "WARN_BACKUP_SKIPPED", message: "Backup creation failed — proceeding without safety net" });
      logger.warn("Backup creation failed", { configPath });
    }
    atomicWriteFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    cleanupBackup(configPath);
    logger.info("MCP config written", { configPath, serverName, method: "json" });
  }

  return result;
}

/**
 * Write MCP config to TOML file (Codex).
 * Uses atomic writes.
 */
export function installMcpToml(platform: DetectedPlatform, serverName: string, mcpEntry: Record<string, unknown>, dryRun: boolean, logger: EquipLogger = NOOP_LOGGER): ArtifactResult {
  const { configPath, rootKey } = platform;

  let existing = "";
  try {
    existing = fs.readFileSync(configPath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // File exists but can't be read — do NOT silently overwrite
      logger.error("TOML config unreadable", { configPath, error: (err as Error).message });
      return makeResult("mcp", { errorCode: "TOML_READ_FAILED", error: `Cannot read ${configPath}: ${(err as Error).message}`, method: "toml" });
    }
    // ENOENT — file doesn't exist, start fresh
    logger.debug("TOML config does not exist, creating fresh", { configPath });
  }

  const tableHeader = `[${rootKey}.${serverName}]`;
  if (existing.includes(tableHeader)) {
    existing = removeTomlEntry(existing, rootKey, serverName);
  }

  const newBlock = buildTomlEntry(rootKey, serverName, mcpEntry);

  if (!dryRun) {
    createBackup(configPath);
    const sep = existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
    atomicWriteFileSync(configPath, existing + sep + newBlock + "\n");
    cleanupBackup(configPath);
    logger.info("MCP config written", { configPath, serverName, method: "toml" });
  }

  return makeResult("mcp", { success: true, action: "created", method: "toml" });
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
        createBackup(configPath);
        const cleaned = removeTomlEntry(content, rootKey, serverName);
        if (cleaned.trim()) {
          atomicWriteFileSync(configPath, cleaned);
        } else {
          fs.unlinkSync(configPath);
        }
        cleanupBackup(configPath);
      }
      return true;
    } catch { return false; }
  }

  const { data, status } = safeReadJsonSync(configPath);
  if (status !== "ok" || !data) return false;
  if (!data[rootKey] || !(data[rootKey] as Record<string, unknown>)[serverName]) return false;

  delete (data[rootKey] as Record<string, unknown>)[serverName];
  if (Object.keys(data[rootKey] as Record<string, unknown>).length === 0) delete data[rootKey];

  if (!dryRun) {
    createBackup(configPath);
    if (Object.keys(data).length === 0) {
      fs.unlinkSync(configPath);
    } else {
      atomicWriteFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
    }
    cleanupBackup(configPath);
  }
  return true;
}

/**
 * Update API key in existing MCP config.
 */
export function updateMcpKey(platform: DetectedPlatform, serverName: string, mcpEntry: Record<string, unknown>, options: { logger?: EquipLogger } = {}): ArtifactResult {
  const { logger = NOOP_LOGGER } = options;
  if (platform.configFormat === "toml") {
    return installMcpToml(platform, serverName, mcpEntry, false, logger);
  }
  return installMcpJson(platform, serverName, mcpEntry, false, logger);
}
