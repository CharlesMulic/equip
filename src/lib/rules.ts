// Behavioral rules installation — marker-based versioned blocks.
// Handles appending, updating, and removing rules from shared files.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import type { DetectedPlatform } from "./platforms";

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
  copyToClipboard?: (text: string) => boolean;
}

/**
 * Install behavioral rules to a platform's rules file.
 */
export function installRules(platform: DetectedPlatform, options: InstallRulesOptions): { action: string } {
  const {
    content,
    version,
    marker,
    fileName,
    clipboardPlatforms = ["cursor", "vscode"],
    dryRun = false,
    copyToClipboard,
  } = options;

  if (clipboardPlatforms.includes(platform.platform)) {
    if (!dryRun && copyToClipboard) {
      copyToClipboard(content);
    }
    return { action: "clipboard" };
  }

  if (!platform.rulesPath) return { action: "skipped" };

  let rulesPath: string;
  if (fileName) {
    try {
      const stat = fs.statSync(platform.rulesPath);
      rulesPath = stat.isDirectory() ? path.join(platform.rulesPath, fileName) : platform.rulesPath;
    } catch {
      rulesPath = path.extname(platform.rulesPath) ? platform.rulesPath : path.join(platform.rulesPath, fileName);
    }
  } else {
    rulesPath = platform.rulesPath;
  }

  const { BLOCK_RE } = markerPatterns(marker);

  let existing = "";
  try { existing = fs.readFileSync(rulesPath, "utf-8"); } catch {}

  const existingVersion = parseRulesVersion(existing, marker);

  if (existingVersion === version) {
    return { action: "skipped" };
  }

  if (!dryRun) {
    const dir = path.dirname(rulesPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (existingVersion) {
      const updated = existing.replace(BLOCK_RE, content + "\n");
      fs.writeFileSync(rulesPath, updated);
      return { action: "updated" };
    }

    const sep = existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
    fs.writeFileSync(rulesPath, existing + sep + content + "\n");
    return { action: "created" };
  }

  return { action: existingVersion ? "updated" : "created" };
}

/**
 * Remove rules from a platform's rules file.
 */
export function uninstallRules(platform: DetectedPlatform, options: { marker: string; fileName?: string; dryRun?: boolean }): boolean {
  const { marker, fileName, dryRun = false } = options;

  if (!platform.rulesPath) return false;

  let rulesPath: string;
  if (fileName) {
    try {
      const stat = fs.statSync(platform.rulesPath);
      rulesPath = stat.isDirectory() ? path.join(platform.rulesPath, fileName) : platform.rulesPath;
    } catch {
      rulesPath = path.extname(platform.rulesPath) ? platform.rulesPath : path.join(platform.rulesPath, fileName);
    }
  } else {
    rulesPath = platform.rulesPath;
  }

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
        fs.writeFileSync(rulesPath, cleaned + "\n");
      } else {
        fs.unlinkSync(rulesPath);
      }
    }
    return true;
  } catch { return false; }
}
