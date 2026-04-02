// Behavioral rules installation — marker-based versioned blocks.
// Handles appending, updating, and removing rules from shared files.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import type { DetectedPlatform } from "./platforms";
import { copyToClipboard } from "./cli";
import { atomicWriteFileSync } from "./fs";
import type { ArtifactResult, EquipLogger } from "./types";
import { makeResult, NOOP_LOGGER } from "./types";

// ─── Constants ──────────────────────────────────────────────

/**
 * Create regex patterns for a given marker name.
 */
export function markerPatterns(marker: string): { MARKER_RE: RegExp; BLOCK_RE: RegExp } {
  return {
    MARKER_RE: new RegExp(`<!-- ${marker}:v[\\d.]+ -->`),
    BLOCK_RE: new RegExp(`<!-- ${marker}:v[\\d.]+ -->[\\s\\S]*?<!-- \\/${marker} -->\\n?`),
  };
}

/**
 * Parse version from marker in content.
 */
export function parseRulesVersion(content: string, marker: string): string | null {
  const m = content.match(new RegExp(`<!-- ${marker}:v([\\d.]+) -->`));
  return m ? m[1] : null;
}

// ─── Install ─────────────────────────────────────────────────

export interface InstallRulesOptions {
  content: string;
  version: string;
  marker: string;
  fileName?: string;
  clipboardPlatforms?: string[];
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
    clipboardPlatforms = ["cursor", "vscode"],
    dryRun = false,
    logger = NOOP_LOGGER,
  } = options;

  if (clipboardPlatforms.includes(platform.platform)) {
    const result = makeResult("rules", { attempted: true, success: true, action: "clipboard" });
    if (!dryRun) {
      const copied = copyToClipboard(content);
      if (!copied) {
        logger.warn("Clipboard copy failed", { platform: platform.platform });
        result.warnings.push({ code: "WARN_CLIPBOARD_FAILED", message: "Clipboard copy failed — user may need to copy rules manually" });
      }
    }
    return result;
  }

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
      const updated = existing.replace(BLOCK_RE, content + "\n");
      atomicWriteFileSync(rulesPath, updated);
      logger.info("Rules updated", { platform: platform.platform, from: existingVersion, to: version });
      return makeResult("rules", { attempted: true, success: true, action: "updated" });
    }

    const sep = existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
    atomicWriteFileSync(rulesPath, existing + sep + content + "\n");
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
