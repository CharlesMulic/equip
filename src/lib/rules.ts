// Behavioral rules installation — marker-based versioned blocks.
// Handles appending, updating, and removing rules from shared files.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { DetectedPlatform } from "./platforms";
import { atomicWriteFileSync } from "./fs";
import type { ArtifactResult, EquipLogger } from "./types";
import { makeResult, NOOP_LOGGER } from "./types";

// ─── Constants ──────────────────────────────────────────────

/**
 * Create regex patterns for a given marker name.
 */
export function markerPatterns(marker: string): { MARKER_RE: RegExp; BLOCK_RE: RegExp } {
  return {
    MARKER_RE: new RegExp(`<!-- ${marker}:v[\\w.]+ -->`),
    BLOCK_RE: new RegExp(`<!-- ${marker}:v[\\w.]+ -->[\\s\\S]*?<!-- \\/${marker} -->\\n?`),
  };
}

/**
 * Parse version from marker in content.
 */
export function parseRulesVersion(content: string, marker: string): string | null {
  const m = content.match(new RegExp(`<!-- ${marker}:v([\\w.]+) -->`));
  return m ? m[1] : null;
}

/**
 * Wrap raw rules text in marker comments for safe install/uninstall.
 * If already wrapped with this marker, returns as-is.
 * Rejects content containing other augments' marker patterns (cross-augment injection).
 */
export function wrapRulesContent(rawContent: string, marker: string, version: string): string {
  if (rawContent.includes(`<!-- ${marker}:`)) return rawContent;

  // Reject content that contains ANY other augment's marker pattern
  const foreignMarkerRe = /<!-- [\w-]+:v[\w.]+ -->/;
  const closingMarkerRe = /<!-- \/[\w-]+ -->/;
  if (foreignMarkerRe.test(rawContent) || closingMarkerRe.test(rawContent)) {
    throw new Error("Rules content contains marker comments from another augment — potential injection attack");
  }

  return `<!-- ${marker}:v${version} -->\n${rawContent}\n<!-- /${marker} -->`;
}

/**
 * Strip marker comments from rules content (for editing/display).
 */
export function stripRulesMarkers(content: string): string {
  return content
    .replace(/^<!-- [\w-]+:v[\w.]+ -->\n?/, '')
    .replace(/\n?<!-- \/[\w-]+ -->$/, '')
    .trim();
}

/**
 * Compute a content hash for rules version tracking.
 * Returns first 8 hex chars of SHA-256 of the stripped (markerless) content.
 * Deterministic: same content always produces the same hash.
 */
export function rulesContentHash(content: string): string {
  const stripped = stripRulesMarkers(content);
  return crypto.createHash("sha256").update(stripped).digest("hex").slice(0, 8);
}

// ─── Install ─────────────────────────────────────────────────

export interface InstallRulesOptions {
  content: string;
  version: string;
  marker: string;
  fileName?: string;
  dryRun?: boolean;
  logger?: EquipLogger;
}

/**
 * Install behavioral rules to a platform's rules file.
 */
export function installRules(platform: DetectedPlatform, options: InstallRulesOptions): ArtifactResult {
  const {
    content,
    version,
    marker,
    fileName,
    dryRun = false,
    logger = NOOP_LOGGER,
  } = options;

  // Ensure content is wrapped in markers before any write
  const wrappedContent = wrapRulesContent(content, marker, version);

  if (!platform.rulesPath) {
    return makeResult("rules", { attempted: false, success: true, action: "skipped" });
  }

  const rulesPath = resolveRulesPath(platform.rulesPath, marker, fileName);

  const { BLOCK_RE } = markerPatterns(marker);

  let existing = "";
  try { existing = fs.readFileSync(rulesPath, "utf-8"); } catch {}

  const existingVersion = parseRulesVersion(existing, marker);

  if (existingVersion === version) {
    logger.debug("Rules already at current version", { platform: platform.platform, version });
    return makeResult("rules", { attempted: true, success: true, action: "skipped" });
  }

  if (!dryRun) {
    if (existingVersion) {
      const updated = existing.replace(BLOCK_RE, wrappedContent + "\n");
      atomicWriteFileSync(rulesPath, updated);
      logger.info("Rules updated", { platform: platform.platform, from: existingVersion, to: version });
      return makeResult("rules", { attempted: true, success: true, action: "updated" });
    }

    const sep = existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
    atomicWriteFileSync(rulesPath, existing + sep + wrappedContent + "\n");
    logger.info("Rules created", { platform: platform.platform, version });
    return makeResult("rules", { attempted: true, success: true, action: "created" });
  }

  return makeResult("rules", { attempted: true, success: true, action: existingVersion ? "updated" : "created" });
}

/**
 * Remove rules from a platform's rules file.
 */
export function uninstallRules(platform: DetectedPlatform, options: { marker: string; fileName?: string; dryRun?: boolean }): boolean {
  const { marker, fileName, dryRun = false } = options;

  if (!platform.rulesPath) return false;

  const rulesPath = resolveRulesPath(platform.rulesPath, marker, fileName);

  try {
    if (!fs.statSync(rulesPath).isFile()) return false;
  } catch { return false; }

  try {
    const content = fs.readFileSync(rulesPath, "utf-8");
    const { MARKER_RE, BLOCK_RE } = markerPatterns(marker);
    if (!MARKER_RE.test(content)) return false;
    if (!dryRun) {
      const cleaned = content.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
      if (cleaned) {
        atomicWriteFileSync(rulesPath, cleaned + "\n");
      } else {
        fs.unlinkSync(rulesPath);
      }
    }
    return true;
  } catch { return false; }
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Resolve the actual file path for rules, handling both file and directory rulesPath.
 * Some platforms (e.g., Roo Code) use a directory of per-augment .md files rather
 * than a single shared rules file. When rulesPath is a directory:
 *   - If fileName is provided, use it
 *   - Otherwise, default to <marker>.md
 */
function resolveRulesPath(basePath: string, marker: string, fileName?: string): string {
  try {
    if (fs.statSync(basePath).isDirectory()) {
      return path.join(basePath, fileName || `${marker}.md`);
    }
  } catch {
    // Path doesn't exist yet — if it has no extension and fileName is given,
    // treat it as a directory path
    if (fileName && !path.extname(basePath)) {
      return path.join(basePath, fileName);
    }
  }
  return basePath;
}
