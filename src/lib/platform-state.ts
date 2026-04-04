// Platform state management — metadata, preferences, and per-platform scan results.
//
// Two files:
//   ~/.equip/platforms.json          — platform metadata + user preferences (enabled/disabled)
//   ~/.equip/platforms/<id>.json     — per-platform scan results (what's configured there)
//
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { atomicWriteFileSync, safeReadJsonSync } from "./fs";
import type { DetectedPlatform } from "./platforms";
import { PLATFORM_REGISTRY, platformName } from "./platforms";
import { readMcpEntry } from "./mcp";
import { wrapUnmanaged, hasAugmentDef } from "./augment-defs";
import { trackInstallation } from "./installations";

// ─── Types ──────────────────────────────────────────────────

export interface PlatformMeta {
  detected: boolean;
  enabled: boolean;
  disabledAt?: string;
  name: string;
  configPath: string;
  configPathShort: string;
  configFormat: string;
  capabilities: string[];
}

export interface PlatformsMeta {
  lastScanned: string;
  platforms: Record<string, PlatformMeta>;
}

export interface PlatformAugmentEntry {
  transport: "http" | "stdio" | "unknown";
  url?: string;
  command?: string;
  args?: string[];
  managed: boolean;
  artifacts?: {
    mcp: boolean;
    rules?: string;       // version if installed
    hooks?: string[];     // hook script names
    skills?: string[];    // skill names
  };
}

export interface PlatformScan {
  lastScanned: string;
  augments: Record<string, PlatformAugmentEntry>;
  augmentCount: number;
  managedCount: number;
}

// ─── Paths ──────────────────────────────────────────────────

function equipDir(): string { return path.join(os.homedir(), ".equip"); }
function platformsMetaPath(): string { return path.join(equipDir(), "platforms.json"); }
function platformsDir(): string { return path.join(equipDir(), "platforms"); }
function platformScanPath(id: string): string { return path.join(platformsDir(), `${id}.json`); }

export function getPlatformsDir(): string { return platformsDir(); }

function ensurePlatformsDir(): void {
  const dir = platformsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Platforms Metadata (platforms.json) ─────────────────────

function shortenPath(fullPath: string): string {
  const home = os.homedir();
  if (fullPath.startsWith(home)) {
    return "~" + fullPath.slice(home.length).replace(/\\/g, "/");
  }
  return fullPath.replace(/\\/g, "/");
}

function getPlatformCapabilities(id: string): string[] {
  const def = PLATFORM_REGISTRY.get(id);
  if (!def) return ["MCP"];
  const caps = ["MCP"];
  if (def.rulesPath) caps.push("Rules");
  if (def.hooks) caps.push("Hooks");
  if (def.skillsPath) caps.push("Skills");
  return caps;
}

/** Read platforms.json. Returns empty metadata if file doesn't exist. */
export function readPlatformsMeta(): PlatformsMeta {
  const { data, status } = safeReadJsonSync(platformsMetaPath());
  if (status !== "ok" || !data) {
    return { lastScanned: "", platforms: {} };
  }
  return data as unknown as PlatformsMeta;
}

/** Write platforms.json atomically. */
export function writePlatformsMeta(meta: PlatformsMeta): void {
  const dir = equipDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(platformsMetaPath(), JSON.stringify(meta, null, 2) + "\n");
}

/**
 * Update platforms metadata from detection results.
 * Preserves user preferences (enabled/disabled) for existing platforms.
 * New platforms default to enabled.
 */
export function updatePlatformsMeta(detected: DetectedPlatform[]): PlatformsMeta {
  const existing = readPlatformsMeta();
  const now = new Date().toISOString();

  const updated: PlatformsMeta = {
    lastScanned: now,
    platforms: { ...existing.platforms },
  };

  // Mark all existing platforms as not-detected first
  for (const id of Object.keys(updated.platforms)) {
    updated.platforms[id].detected = false;
  }

  // Update from detection results
  for (const p of detected) {
    const prev = existing.platforms[p.platform];
    updated.platforms[p.platform] = {
      detected: true,
      enabled: prev?.enabled ?? true,   // preserve existing preference, default true
      disabledAt: prev?.disabledAt,
      name: platformName(p.platform),
      configPath: p.configPath,
      configPathShort: shortenPath(p.configPath),
      configFormat: p.configFormat,
      capabilities: getPlatformCapabilities(p.platform),
    };
  }

  writePlatformsMeta(updated);
  return updated;
}

/** Toggle a platform's enabled state. */
export function setPlatformEnabled(id: string, enabled: boolean): void {
  const meta = readPlatformsMeta();
  if (!meta.platforms[id]) return;

  meta.platforms[id].enabled = enabled;
  if (!enabled) {
    meta.platforms[id].disabledAt = new Date().toISOString();
  } else {
    delete meta.platforms[id].disabledAt;
  }

  writePlatformsMeta(meta);
}

/** Get the set of platform IDs that are currently enabled. */
export function getEnabledPlatformIds(): Set<string> {
  const meta = readPlatformsMeta();
  const enabled = new Set<string>();
  for (const [id, platform] of Object.entries(meta.platforms)) {
    if (platform.enabled) enabled.add(id);
  }
  return enabled;
}

/** Check if a specific platform is enabled. Returns true if platform is unknown (not yet in metadata). */
export function isPlatformEnabled(id: string): boolean {
  const meta = readPlatformsMeta();
  const platform = meta.platforms[id];
  return platform ? platform.enabled : true; // unknown platforms default to enabled
}

// ─── Per-Platform Scan (platforms/<id>.json) ────────────────

/** Read a per-platform scan file. Returns null if not found. */
export function readPlatformScan(id: string): PlatformScan | null {
  const { data, status } = safeReadJsonSync(platformScanPath(id));
  if (status !== "ok" || !data) return null;
  return data as unknown as PlatformScan;
}

/** Write a per-platform scan file. */
export function writePlatformScan(id: string, scan: PlatformScan): void {
  ensurePlatformsDir();
  atomicWriteFileSync(platformScanPath(id), JSON.stringify(scan, null, 2) + "\n");
}

/**
 * Scan a single platform's config file and build the augment inventory.
 * Cross-references with managedNames to determine the `managed` flag.
 *
 * @param platform - Detected platform to scan
 * @param managedNames - Set of augment names that equip has installed (from installations.json)
 * @param toolName - Optional: if provided, also check rules/hooks/skills for this specific tool
 */
export function scanPlatform(
  platform: DetectedPlatform,
  managedNames: Set<string> = new Set(),
): PlatformScan {
  const now = new Date().toISOString();
  const augments: Record<string, PlatformAugmentEntry> = {};

  // Read all MCP server entries from the platform's config file
  const allServers = readAllMcpServers(platform.configPath, platform.rootKey, platform.configFormat);

  for (const server of allServers) {
    augments[server.name] = {
      transport: server.transport,
      url: server.url,
      command: server.command,
      args: server.args,
      managed: managedNames.has(server.name),
    };
  }

  // For managed augments, check for additional artifacts (rules, hooks, skills)
  const def = PLATFORM_REGISTRY.get(platform.platform);
  if (def) {
    for (const [name, entry] of Object.entries(augments)) {
      if (!entry.managed) continue;

      const artifacts: PlatformAugmentEntry["artifacts"] = { mcp: true };

      // Check rules
      if (def.rulesPath) {
        try {
          const rulesPath = def.rulesPath();
          const content = fs.readFileSync(rulesPath, "utf-8");
          const versionMatch = content.match(new RegExp(`<!-- ${name}:v([0-9.]+) -->`));
          if (versionMatch) {
            artifacts.rules = versionMatch[1];
          }
        } catch { /* no rules file */ }
      }

      // Check hooks
      if (def.hooks) {
        const hookDir = path.join(os.homedir(), `.${name}`, "hooks");
        try {
          const hookFiles = fs.readdirSync(hookDir).filter(f => f.endsWith(".js"));
          if (hookFiles.length > 0) {
            artifacts.hooks = hookFiles;
          }
        } catch { /* no hooks */ }
      }

      // Check skills
      if (def.skillsPath) {
        try {
          const skillsBase = def.skillsPath();
          const toolSkillDir = path.join(skillsBase, name);
          const skillDirs = fs.readdirSync(toolSkillDir).filter(s => {
            try { return fs.statSync(path.join(toolSkillDir, s, "SKILL.md")).isFile(); }
            catch { return false; }
          });
          if (skillDirs.length > 0) {
            artifacts.skills = skillDirs;
          }
        } catch { /* no skills */ }
      }

      entry.artifacts = artifacts;
    }
  }

  const augmentCount = Object.keys(augments).length;
  const managedCount = Object.values(augments).filter(a => a.managed).length;

  return { lastScanned: now, augments, augmentCount, managedCount };
}

/**
 * Scan all detected platforms and write per-platform scan files.
 * Also updates platforms.json metadata.
 */
export function scanAllPlatforms(
  detected: DetectedPlatform[],
  managedNames: Set<string> = new Set(),
): { meta: PlatformsMeta; scans: Record<string, PlatformScan> } {
  // Update metadata
  const meta = updatePlatformsMeta(detected);

  // Scan each platform
  const scans: Record<string, PlatformScan> = {};
  for (const p of detected) {
    const scan = scanPlatform(p, managedNames);
    writePlatformScan(p.platform, scan);
    scans[p.platform] = scan;

    // Auto-wrap unmanaged MCP servers as local augments
    for (const [name, entry] of Object.entries(scan.augments)) {
      if (entry.managed) continue;
      if (hasAugmentDef(name)) continue; // already exists (registry, local, or previously wrapped)

      try {
        const transport = entry.transport === "http" || entry.transport === "stdio" ? entry.transport : "stdio";
        wrapUnmanaged({
          name,
          displayName: name,
          transport,
          url: entry.url,
          command: entry.command,
          args: entry.args,
          fromPlatform: p.platform,
          wrappedFromMeta: {
            type: "mcp",
            platform: p.platform,
            path: p.configPath,
            originalName: name,
          },
        });

        // Create InstallationRecord so it's recognized as managed on next scan
        trackInstallation(name, {
          source: "wrapped",
          displayName: name,
          transport,
          platforms: [p.platform],
          artifacts: { [p.platform]: { mcp: true } },
        });

        // Mark as managed in current scan results
        entry.managed = true;
        scan.managedCount = (scan.managedCount || 0) + 1;
      } catch { /* best effort — don't break scan for wrapping failures */ }
    }

    // Auto-wrap orphan skill files
    const platformDef = PLATFORM_REGISTRY.get(p.platform);
    if (platformDef?.skillsPath) {
      try {
        const skillsBase = platformDef.skillsPath();
        if (fs.existsSync(skillsBase)) {
          const topDirs = fs.readdirSync(skillsBase).filter((d: string) => {
            try { return fs.statSync(path.join(skillsBase, d)).isDirectory(); }
            catch { return false; }
          });

          for (const toolDir of topDirs) {
            // Skip if this tool dir is owned by a managed augment
            if (managedNames.has(toolDir)) continue;
            if (hasAugmentDef(toolDir)) continue;

            // Check for SKILL.md files inside subdirectories
            const toolSkillPath = path.join(skillsBase, toolDir);
            const skillSubDirs = fs.readdirSync(toolSkillPath).filter((s: string) => {
              try { return fs.statSync(path.join(toolSkillPath, s, "SKILL.md")).isFile(); }
              catch { return false; }
            });

            if (skillSubDirs.length === 0) continue;

            // Read all skill files into SkillConfig entries
            const skills: { name: string; files: { path: string; content: string }[] }[] = [];
            let description = "";

            for (const skillName of skillSubDirs) {
              const skillDir = path.join(toolSkillPath, skillName);
              try {
                const skillMd = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
                const files: { path: string; content: string }[] = [
                  { path: "SKILL.md", content: skillMd },
                ];

                // Read any additional files in the skill directory
                try {
                  for (const f of fs.readdirSync(skillDir)) {
                    if (f === "SKILL.md") continue;
                    try {
                      const fp = path.join(skillDir, f);
                      if (fs.statSync(fp).isFile()) {
                        files.push({ path: f, content: fs.readFileSync(fp, "utf-8") });
                      }
                    } catch {}
                  }
                } catch {}

                skills.push({ name: skillName, files });

                // Extract description from first skill's SKILL.md (skip frontmatter)
                if (!description) {
                  const lines = skillMd.split("\n");
                  let inFrontmatter = false;
                  for (const line of lines) {
                    if (line.trim() === "---") {
                      inFrontmatter = !inFrontmatter;
                      continue;
                    }
                    if (inFrontmatter) continue;
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    description = trimmed.replace(/^#\s*/, "");
                    break;
                  }
                }
              } catch {}
            }

            try {
              wrapUnmanaged({
                name: toolDir,
                displayName: toolDir,
                description,
                // No transport — skill-only augments don't have an MCP server
                skills,
                fromPlatform: p.platform,
                wrappedFromMeta: {
                  type: "skill",
                  platform: p.platform,
                  path: toolSkillPath,
                  originalName: toolDir,
                },
              });

              trackInstallation(toolDir, {
                source: "wrapped",
                displayName: toolDir,
                transport: "stdio",
                platforms: [p.platform],
                artifacts: { [p.platform]: { mcp: false, skills: skillSubDirs } },
              });
            } catch { /* best effort */ }
          }
        }
      } catch { /* skills directory may not exist */ }
    }
  }

  return { meta, scans };
}

// ─── Helpers ────────────────────────────────────────────────

interface McpServerEntry {
  name: string;
  transport: "http" | "stdio" | "unknown";
  url?: string;
  command?: string;
  args?: string[];
}

function readAllMcpServers(
  configPath: string,
  rootKey: string,
  configFormat: string,
): McpServerEntry[] {
  if (configFormat === "toml") {
    return readTomlServers(configPath, rootKey);
  }

  const { data, status } = safeReadJsonSync(configPath);
  if (status !== "ok" || !data) return [];

  const root = (data as Record<string, unknown>)[rootKey];
  if (!root || typeof root !== "object") return [];

  const servers: McpServerEntry[] = [];
  for (const [name, entry] of Object.entries(root as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;

    let transport: "http" | "stdio" | "unknown" = "unknown";
    let url: string | undefined;
    let command: string | undefined;

    let args: string[] | undefined;

    if (e.command) {
      transport = "stdio";
      command = String(e.command);
      if (Array.isArray(e.args)) args = e.args.map(String);
    } else if (e.url || e.serverUrl || e.httpUrl) {
      transport = "http";
      url = String(e.url || e.serverUrl || e.httpUrl);
    }

    servers.push({ name, transport, url, command, args });
  }

  return servers;
}

function readTomlServers(configPath: string, rootKey: string): McpServerEntry[] {
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const servers: McpServerEntry[] = [];
    const tableRe = new RegExp(`^\\[${rootKey}\\.([^\\].]+)\\]`, "gm");
    let match;
    while ((match = tableRe.exec(content)) !== null) {
      servers.push({ name: match[1], transport: "unknown" });
    }
    return servers;
  } catch {
    return [];
  }
}
