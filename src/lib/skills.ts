// Skill file installation — copies SKILL.md and supporting files to platform skill directories.
// Skills use a universal format (Agent Skills spec) — no per-platform translation needed.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import { type DetectedPlatform, getPlatform } from "./platforms";
import { atomicWriteFileSync } from "./fs";
import { validateRelativePath, validatePathWithinDir, validateToolName } from "./validation";
import type { ArtifactResult, EquipLogger } from "./types";
import { makeResult, NOOP_LOGGER } from "./types";

// ─── Types ──────────────────────────────────────────────────

export interface SkillFile {
  /** Relative path within the skill directory (e.g., "SKILL.md", "scripts/validate.sh") */
  path: string;
  /** File content */
  content: string;
}

export interface SkillConfig {
  /** Skill directory name (e.g., "search") */
  name: string;
  /** Files to install */
  files: SkillFile[];
}

// ─── Install ────────────────────────────────────────────────

/**
 * Install skill files to a platform's skills directory.
 * Layout: {skillsPath}/{toolName}/{skillName}/SKILL.md
 *
 * @param platform - Detected platform with skillsPath
 * @param toolName - Tool name (scopes skills per tool, e.g., "prior")
 * @param skill - Skill config with name and files
 * @param options - { dryRun }
 */
export function installSkill(
  platform: DetectedPlatform,
  toolName: string,
  skill: SkillConfig,
  options: { dryRun?: boolean; logger?: EquipLogger } = {},
): ArtifactResult {
  const logger = options.logger || NOOP_LOGGER;

  if (!platform.skillsPath) {
    return makeResult("skills", { attempted: false, success: true, action: "skipped" });
  }
  if (!skill.files || skill.files.length === 0) {
    return makeResult("skills", { attempted: false, success: true, action: "skipped" });
  }

  const skillDir = path.join(platform.skillsPath, toolName, skill.name);

  // Check if already installed (idempotent — skip if SKILL.md exists and matches)
  const mainFile = skill.files.find(f => f.path === "SKILL.md");
  if (mainFile) {
    try {
      const existing = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
      if (existing === mainFile.content) {
        logger.debug("Skill already current", { platform: platform.platform, skill: skill.name });
        return makeResult("skills", { attempted: true, success: true, action: "skipped" });
      }
    } catch { /* doesn't exist yet — proceed with install */ }
  }

  if (!options.dryRun) {
    // Validate tool name and skill name before filesystem use
    validateToolName(toolName);
    validateRelativePath(skill.name, "skill name");

    for (const file of skill.files) {
      // Validate each file path to prevent directory traversal
      validateRelativePath(file.path, "skill file path");
      const filePath = path.join(skillDir, file.path);
      validatePathWithinDir(filePath, skillDir, "skill file path");

      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      atomicWriteFileSync(filePath, file.content);
    }
    logger.info("Skill installed", { platform: platform.platform, skill: skill.name });
  }

  return makeResult("skills", { attempted: true, success: true, action: "created" });
}

// ─── Uninstall ──────────────────────────────────────────────

/**
 * Remove a skill directory from a platform.
 */
export function uninstallSkill(
  platform: DetectedPlatform,
  toolName: string,
  skillName: string,
  dryRun: boolean = false,
): boolean {
  if (!platform.skillsPath) return false;

  const skillDir = path.join(platform.skillsPath, toolName, skillName);
  try {
    if (!fs.statSync(skillDir).isDirectory()) return false;
  } catch { return false; }

  if (!dryRun) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    // Clean up parent tool dir if empty
    const toolDir = path.join(platform.skillsPath, toolName);
    try {
      const remaining = fs.readdirSync(toolDir);
      if (remaining.length === 0) fs.rmdirSync(toolDir);
    } catch { /* not empty or doesn't exist */ }
  }

  return true;
}

// ─── Check ──────────────────────────────────────────────────

/**
 * Check if a skill is installed on a platform.
 */
export function hasSkill(
  platform: DetectedPlatform,
  toolName: string,
  skillName: string,
): boolean {
  if (!platform.skillsPath) return false;
  const skillMd = path.join(platform.skillsPath, toolName, skillName, "SKILL.md");
  try { return fs.statSync(skillMd).isFile(); } catch { return false; }
}
