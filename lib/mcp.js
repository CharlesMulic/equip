// MCP config read/write/merge/uninstall.
// Handles all platform-specific config format differences.
// Zero dependencies.

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ─── TOML Helpers (minimal, zero-dep) ───────────────────────

/**
 * Parse a TOML table entry for [mcp_servers.<name>].
 * Returns key-value pairs as a plain object. Supports string, number, boolean, arrays.
 * This is NOT a full TOML parser — only handles flat tables needed for MCP config.
 */
function parseTomlServerEntry(tomlContent, rootKey, serverName) {
  const tableHeader = `[${rootKey}.${serverName}]`;
  const idx = tomlContent.indexOf(tableHeader);
  if (idx === -1) return null;

  const afterHeader = tomlContent.slice(idx + tableHeader.length);
  const nextTable = afterHeader.search(/\n\[(?!\[)/); // next top-level table
  const block = nextTable === -1 ? afterHeader : afterHeader.slice(0, nextTable);

  const result = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Parse value
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
 * Parse a nested TOML sub-table (e.g., [mcp_servers.prior.env] or [mcp_servers.prior.http_headers]).
 */
function parseTomlSubTables(tomlContent, rootKey, serverName) {
  const prefix = `[${rootKey}.${serverName}.`;
  const result = {};
  let idx = 0;
  while ((idx = tomlContent.indexOf(prefix, idx)) !== -1) {
    const lineStart = tomlContent.lastIndexOf("\n", idx) + 1;
    const lineEnd = tomlContent.indexOf("\n", idx);
    const header = tomlContent.slice(idx, lineEnd === -1 ? undefined : lineEnd).trim();
    // Extract sub-table name from [mcp_servers.prior.env]
    const subName = header.slice(prefix.length, -1); // remove trailing ]
    if (!subName || subName.includes(".")) { idx++; continue; }

    const afterHeader = tomlContent.slice(lineEnd === -1 ? tomlContent.length : lineEnd);
    const nextTable = afterHeader.search(/\n\[(?!\[)/);
    const block = nextTable === -1 ? afterHeader : afterHeader.slice(0, nextTable);

    const sub = {};
    for (const line of block.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("[")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
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
 * @param {string} rootKey - e.g., "mcp_servers"
 * @param {string} serverName - e.g., "prior"
 * @param {object} config - { url, bearer_token_env_var, http_headers, ... }
 * @returns {string} TOML text block
 */
function buildTomlEntry(rootKey, serverName, config) {
  const lines = [`[${rootKey}.${serverName}]`];
  const subTables = {};

  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      subTables[k] = v;
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
 * Removes [rootKey.serverName] and any [rootKey.serverName.*] sub-tables.
 */
function removeTomlEntry(tomlContent, rootKey, serverName) {
  const mainHeader = `[${rootKey}.${serverName}]`;
  const subPrefix = `[${rootKey}.${serverName}.`;

  // Find all lines belonging to this entry
  const lines = tomlContent.split("\n");
  const result = [];
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

  // Clean up extra blank lines
  return result.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ─── Read ────────────────────────────────────────────────────

/**
 * Read an MCP server entry from a config file (JSON or TOML).
 * @param {string} configPath - Path to config file
 * @param {string} rootKey - Root key ("mcpServers", "servers", or "mcp_servers")
 * @param {string} serverName - Server name to read
 * @param {string} [configFormat="json"] - "json" or "toml"
 * @returns {object|null} Server config or null
 */
function readMcpEntry(configPath, rootKey, serverName, configFormat = "json") {
  try {
    let raw = fs.readFileSync(configPath, "utf-8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // Strip BOM

    if (configFormat === "toml") {
      const entry = parseTomlServerEntry(raw, rootKey, serverName);
      if (!entry) return null;
      // Merge sub-tables
      const subs = parseTomlSubTables(raw, rootKey, serverName);
      return { ...entry, ...subs };
    }

    const data = JSON.parse(raw);
    return data?.[rootKey]?.[serverName] || null;
  } catch { return null; }
}

// ─── Config Builders ─────────────────────────────────────────

/**
 * Build HTTP MCP config for a platform.
 * Handles platform-specific field names (url vs serverUrl, type field).
 * @param {string} serverUrl - MCP server URL
 * @param {string} platform - Platform id
 * @returns {object} MCP config object
 */
function buildHttpConfig(serverUrl, platform) {
  if (platform === "windsurf") return { serverUrl };
  if (platform === "vscode") return { type: "http", url: serverUrl };
  if (platform === "cursor") return { type: "streamable-http", url: serverUrl };
  if (platform === "gemini-cli") return { httpUrl: serverUrl };
  // codex, claude-code, cline, roo-code all use { url }
  return { url: serverUrl };
}

/**
 * Build HTTP MCP config with auth headers.
 * @param {string} serverUrl - MCP server URL
 * @param {string} apiKey - API key for auth
 * @param {string} platform - Platform id
 * @param {object} [extraHeaders] - Additional headers
 * @returns {object} MCP config with headers
 */
function buildHttpConfigWithAuth(serverUrl, apiKey, platform, extraHeaders) {
  const base = buildHttpConfig(serverUrl, platform);

  if (platform === "codex") {
    // Codex TOML uses http_headers for static headers
    return {
      ...base,
      http_headers: {
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
    };
  }

  if (platform === "gemini-cli") {
    // Gemini CLI uses headers object
    return {
      ...base,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
    };
  }

  return {
    ...base,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
  };
}

/**
 * Build stdio MCP config.
 * @param {string} command - Command to run
 * @param {string[]} args - Command arguments
 * @param {object} env - Environment variables
 * @returns {object} MCP stdio config
 */
function buildStdioConfig(command, args, env) {
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", command, ...args], env };
  }
  return { command, args, env };
}

// ─── Install ─────────────────────────────────────────────────

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Install MCP config for a platform.
 * Tries platform CLI first (if available), falls back to JSON write.
 * @param {object} platform - Platform object from detect
 * @param {string} serverName - Server name (e.g., "prior")
 * @param {object} mcpEntry - MCP config object
 * @param {object} [options] - { dryRun, serverUrl }
 * @returns {{ success: boolean, method: string }}
 */
function installMcp(platform, serverName, mcpEntry, options = {}) {
  const { dryRun = false, serverUrl } = options;

  // Claude Code: try CLI first
  if (platform.platform === "claude-code" && platform.hasCli && mcpEntry.url) {
    try {
      if (!dryRun) {
        const headerArgs = mcpEntry.headers
          ? Object.entries(mcpEntry.headers).map(([k, v]) => `--header "${k}: ${v}"`).join(" ")
          : "";
        execSync(`claude mcp add --transport http -s user ${headerArgs} ${serverName} ${mcpEntry.url}`, {
          encoding: "utf-8", timeout: 15000, stdio: "pipe",
        });
        const check = readMcpEntry(platform.configPath, platform.rootKey, serverName);
        if (check) return { success: true, method: "cli" };
      } else {
        return { success: true, method: "cli" };
      }
    } catch { /* fall through */ }
  }

  // Cursor: try CLI first
  if (platform.platform === "cursor" && platform.hasCli) {
    try {
      const mcpJson = JSON.stringify({ name: serverName, ...mcpEntry });
      if (!dryRun) {
        execSync(`cursor --add-mcp '${mcpJson.replace(/'/g, "'\\''")}'`, {
          encoding: "utf-8", timeout: 15000, stdio: "pipe",
        });
        const check = readMcpEntry(platform.configPath, platform.rootKey, serverName);
        if (check) return { success: true, method: "cli" };
      } else {
        return { success: true, method: "cli" };
      }
    } catch { /* fall through */ }
  }

  // VS Code: try CLI first
  if (platform.platform === "vscode" && platform.hasCli) {
    try {
      const mcpJson = JSON.stringify({ name: serverName, ...mcpEntry });
      if (!dryRun) {
        execSync(`code --add-mcp '${mcpJson.replace(/'/g, "'\\''")}'`, {
          encoding: "utf-8", timeout: 15000, stdio: "pipe",
        });
        const check = readMcpEntry(platform.configPath, platform.rootKey, serverName);
        if (check) return { success: true, method: "cli" };
      } else {
        return { success: true, method: "cli" };
      }
    } catch { /* fall through */ }
  }

  // Codex: try CLI first (codex mcp add <name> <url>)
  if (platform.platform === "codex" && platform.hasCli && mcpEntry.url) {
    try {
      if (!dryRun) {
        execSync(`codex mcp add ${serverName} ${mcpEntry.url}`, {
          encoding: "utf-8", timeout: 15000, stdio: "pipe",
        });
        const check = readMcpEntry(platform.configPath, platform.rootKey, serverName, "toml");
        if (check) return { success: true, method: "cli" };
      } else {
        return { success: true, method: "cli" };
      }
    } catch { /* fall through to TOML write */ }
  }

  // Gemini CLI: try CLI first (gemini mcp add <name> -- or manual JSON)
  // Gemini's `gemini mcp add` is for stdio primarily; HTTP goes through settings.json
  // Fall through to JSON write for HTTP

  // TOML write for Codex, JSON write for all others
  if (platform.configFormat === "toml") {
    return installMcpToml(platform, serverName, mcpEntry, dryRun);
  }
  return installMcpJson(platform, serverName, mcpEntry, dryRun);
}

/**
 * Write MCP config directly to JSON file.
 * Merges with existing config, creates backup.
 * @param {object} platform - Platform object
 * @param {string} serverName - Server name
 * @param {object} mcpEntry - MCP config
 * @param {boolean} dryRun
 * @returns {{ success: boolean, method: string }}
 */
function installMcpJson(platform, serverName, mcpEntry, dryRun) {
  const { configPath, rootKey } = platform;

  let existing = {};
  try {
    let raw = fs.readFileSync(configPath, "utf-8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    existing = JSON.parse(raw);
    if (typeof existing !== "object" || existing === null) existing = {};
  } catch { /* start fresh */ }

  if (!existing[rootKey]) existing[rootKey] = {};
  existing[rootKey][serverName] = mcpEntry;

  if (!dryRun) {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fileExists(configPath)) {
      try { fs.copyFileSync(configPath, configPath + ".bak"); } catch {}
    }

    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
  }

  return { success: true, method: "json" };
}

/**
 * Write MCP config to TOML file (Codex).
 * Appends or replaces a [mcp_servers.<name>] table.
 * @param {object} platform - Platform object
 * @param {string} serverName - Server name
 * @param {object} mcpEntry - MCP config
 * @param {boolean} dryRun
 * @returns {{ success: boolean, method: string }}
 */
function installMcpToml(platform, serverName, mcpEntry, dryRun) {
  const { configPath, rootKey } = platform;

  let existing = "";
  try { existing = fs.readFileSync(configPath, "utf-8"); } catch { /* start fresh */ }

  // Remove existing entry if present
  const tableHeader = `[${rootKey}.${serverName}]`;
  if (existing.includes(tableHeader)) {
    existing = removeTomlEntry(existing, rootKey, serverName);
  }

  const newBlock = buildTomlEntry(rootKey, serverName, mcpEntry);

  if (!dryRun) {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fileExists(configPath)) {
      try { fs.copyFileSync(configPath, configPath + ".bak"); } catch {}
    }

    const sep = existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
    fs.writeFileSync(configPath, existing + sep + newBlock + "\n");
  }

  return { success: true, method: "toml" };
}

/**
 * Remove an MCP server entry from a platform config.
 * @param {object} platform - Platform object
 * @param {string} serverName - Server name to remove
 * @param {boolean} dryRun
 * @returns {boolean} Whether anything was removed
 */
function uninstallMcp(platform, serverName, dryRun) {
  const { configPath, rootKey } = platform;
  if (!fileExists(configPath)) return false;

  // TOML path (Codex)
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

  // JSON path
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
 * @param {object} platform - Platform object
 * @param {string} serverName - Server name
 * @param {object} mcpEntry - New MCP config
 * @returns {{ success: boolean, method: string }}
 */
function updateMcpKey(platform, serverName, mcpEntry) {
  if (platform.configFormat === "toml") {
    return installMcpToml(platform, serverName, mcpEntry, false);
  }
  return installMcpJson(platform, serverName, mcpEntry, false);
}

module.exports = {
  readMcpEntry,
  buildHttpConfig,
  buildHttpConfigWithAuth,
  buildStdioConfig,
  installMcp,
  installMcpJson,
  installMcpToml,
  uninstallMcp,
  updateMcpKey,
  // TOML helpers (exported for testing)
  parseTomlServerEntry,
  parseTomlSubTables,
  buildTomlEntry,
  removeTomlEntry,
};
