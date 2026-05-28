// Config migration — detects and fixes MCP config entries that were written
// by older equip versions with different platform definitions.
//
// Migration scenarios:
// - Type field added (Roo Code v0.9.4: added "streamable-http")
// - Type field removed (Cursor v0.9.4: removed "streamable-http")
// - Type field changed (hypothetical future)
// - Headers wrapper changed (hypothetical future)
// - URL field name changed (hypothetical future)
//
// Zero dependencies.

import * as fs from "fs";
import { PLATFORM_REGISTRY, remoteTypeFieldForPlatform, type DetectedPlatform, type PlatformRemoteTransport } from "./platforms";
import { readMcpEntry, buildHttpConfig, buildHttpConfigWithAuth } from "./mcp";
import { JsonStore } from "./storage/datastore";
import { safeReadJsonSync, atomicWriteFileSync } from "./fs";

// ─── Types ──────────────────────────────────────────────────

export interface MigrationResult {
  platform: string;
  toolName: string;
  action: "migrated" | "skipped" | "error";
  detail?: string;
}

// ─── Migration ──────────────────────────────────────────────

/**
 * Check all tracked tools across all platforms for config entries
 * that don't match the current platform definitions, and fix them.
 *
 * Returns a list of migration actions taken.
 */
export function migrateConfigs(): MigrationResult[] {
  // Phase A migration: iterate via new storage layer (was readInstallations / listInstalls).
  const augments = JsonStore.listResolved().filter((r) => r.installed);
  const results: MigrationResult[] = [];

  for (const augment of augments) {
    const toolName = augment.name;
    for (const platformId of augment.installedPlatforms) {
      const def = PLATFORM_REGISTRY.get(platformId);
      if (!def) continue;

      const configPath = def.configPath();

      // Read the existing entry
      const existing = readMcpEntry(configPath, def.rootKey, toolName, def.configFormat);
      if (!existing) {
        results.push({ platform: platformId, toolName, action: "skipped", detail: "no MCP entry found" });
        continue;
      }

      // TOML migration is not supported yet — too complex for the minimal parser
      if (def.configFormat === "toml") {
        results.push({ platform: platformId, toolName, action: "skipped", detail: "TOML migration not supported" });
        continue;
      }

      // Check if migration is needed
      const issues = detectIssues(existing, def);
      if (issues.length === 0) {
        results.push({ platform: platformId, toolName, action: "skipped", detail: "config is current" });
        continue;
      }

      // Rebuild the entry with current platform shape
      try {
        const migrated = rebuildEntry(existing, def);
        writeEntry(configPath, def.rootKey, toolName, migrated);
        results.push({
          platform: platformId,
          toolName,
          action: "migrated",
          detail: issues.join("; "),
        });
      } catch (err: unknown) {
        results.push({
          platform: platformId,
          toolName,
          action: "error",
          detail: (err as Error).message,
        });
      }
    }
  }

  return results;
}

// ─── Issue Detection ────────────────────────────────────────

function detectIssues(entry: Record<string, unknown>, def: typeof PLATFORM_REGISTRY extends ReadonlyMap<string, infer V> ? V : never): string[] {
  const issues: string[] = [];
  const shape = def.httpShape;
  const transport = inferRemoteTransport(entry);
  const expectedType = remoteTypeFieldForPlatform(def.id, transport);

  // Check type field
  if (expectedType) {
    if (entry.type !== expectedType) {
      issues.push(`type field should be "${expectedType}", got "${entry.type ?? "missing"}"`);
    }
  } else {
    if (entry.type !== undefined) {
      issues.push(`type field should not be present, got "${entry.type}"`);
    }
  }

  // Check URL field name
  const hasCorrectUrl = entry[shape.urlField] !== undefined;
  if (!hasCorrectUrl) {
    // Check if URL exists under a different field name
    const altUrlFields = ["url", "serverUrl", "httpUrl"];
    const foundUrl = altUrlFields.find(f => entry[f] !== undefined);
    if (foundUrl && foundUrl !== shape.urlField) {
      issues.push(`URL in "${foundUrl}" field, should be "${shape.urlField}"`);
    }
  }

  // Check headers wrapper
  if (shape.headersWrapper) {
    // Should have nested headers (e.g., requestInit.headers)
    const wrapper = entry[shape.headersWrapper] as Record<string, unknown> | undefined;
    if (!wrapper && entry[shape.headersField]) {
      issues.push(`headers should be nested in "${shape.headersWrapper}", found at top level`);
    }
  } else {
    // Should have top-level headers
    if (entry.requestInit && !entry[shape.headersField]) {
      issues.push(`headers nested in wrapper, should be top-level "${shape.headersField}"`);
    }
  }

  return issues;
}

// ─── Entry Rebuilding ───────────────────────────────────────

function rebuildEntry(
  existing: Record<string, unknown>,
  def: typeof PLATFORM_REGISTRY extends ReadonlyMap<string, infer V> ? V : never,
): Record<string, unknown> {
  const shape = def.httpShape;
  const transport = inferRemoteTransport(existing);

  // Extract the server URL from whichever field it's in
  const serverUrl = (existing[shape.urlField] || existing.url || existing.serverUrl || existing.httpUrl) as string | undefined;
  if (!serverUrl) {
    throw new Error("Cannot migrate: no server URL found in existing entry");
  }

  // Extract auth headers from wherever they are
  let authHeaders: Record<string, string> | undefined;
  if (shape.headersWrapper) {
    const wrapper = existing[shape.headersWrapper] as Record<string, Record<string, string>> | undefined;
    authHeaders = wrapper?.[shape.headersField];
  }
  if (!authHeaders) {
    authHeaders = (existing[shape.headersField] || existing.headers || existing.http_headers) as Record<string, string> | undefined;
  }

  // Build new entry with current platform shape
  const result: Record<string, unknown> = { [shape.urlField]: serverUrl };
  const expectedType = remoteTypeFieldForPlatform(def.id, transport);
  if (expectedType) result.type = expectedType;

  if (authHeaders) {
    if (shape.headersWrapper) {
      result[shape.headersWrapper] = { [shape.headersField]: authHeaders };
    } else {
      result[shape.headersField] = authHeaders;
    }
  }

  // Preserve any extra fields that aren't part of the shape (e.g., alwaysAllow, disabled, timeout)
  const shapeKeys = new Set([shape.urlField, "url", "serverUrl", "httpUrl", "type", shape.headersField, "headers", "http_headers", "requestInit"]);
  for (const [k, v] of Object.entries(existing)) {
    if (!shapeKeys.has(k) && !(k in result)) {
      result[k] = v;
    }
  }

  return result;
}

function inferRemoteTransport(entry: Record<string, unknown>): PlatformRemoteTransport {
  return entry.type === "sse" ? "sse" : "streamable-http";
}

// ─── Write ──────────────────────────────────────────────────

function writeEntry(configPath: string, rootKey: string, serverName: string, entry: Record<string, unknown>): void {
  const { data, status, error } = safeReadJsonSync(configPath);
  if (status === "corrupt") {
    throw new Error(`Config file corrupt: ${error}`);
  }

  const config = data || {};
  if (!config[rootKey]) config[rootKey] = {};
  (config[rootKey] as Record<string, unknown>)[serverName] = entry;

  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}
