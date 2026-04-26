// Skill file installation: copies SKILL.md and supporting files to platform skill directories.
// Skills use a universal format (Agent Skills spec); no per-platform translation needed.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import { type DetectedPlatform } from "./platforms";
import { atomicWriteFileSync } from "./fs";
import { validateRelativePath, validatePathWithinDir, validateToolName } from "./validation";
import type { ArtifactResult, EquipLogger } from "./types";
import { makeResult, NOOP_LOGGER } from "./types";

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

export function normalizeSkillFilePath(filePath: string, context: string = "skill file path"): string {
  const slashPath = filePath.replace(/\\/g, "/");
  validateRelativePath(slashPath, context);
  const normalized = path.posix.normalize(slashPath);
  if (normalized === "." || normalized === "") {
    throw new Error(`Empty ${context}`);
  }
  return normalized;
}

function normalizeSkillFiles(files: SkillFile[]): SkillFile[] {
  return files.map((file) => ({
    path: normalizeSkillFilePath(file.path),
    content: file.content,
  }));
}

function skillFilePath(skillDir: string, relativePath: string): string {
  const filePath = path.join(skillDir, ...relativePath.split("/"));
  validatePathWithinDir(filePath, skillDir, "skill file path");
  return filePath;
}

function declaredSkillFilesAreCurrent(skillDir: string, files: SkillFile[]): boolean {
  for (const file of files) {
    try {
      const existing = fs.readFileSync(skillFilePath(skillDir, file.path), "utf-8");
      if (existing !== file.content) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Install skill files to a platform's skills directory.
 * Layout: {skillsPath}/{toolName}/{skillName}/SKILL.md
 *
 * Install is add/update-only: files no longer declared by the incoming skill are
 * left in place until managed-install metadata can distinguish stale files from
 * user-added local files.
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

  validateToolName(toolName);
  validateRelativePath(skill.name, "skill name");
  const files = normalizeSkillFiles(skill.files);

  const skillDir = path.join(platform.skillsPath, toolName, skill.name);
  const skillDirExists = fs.existsSync(skillDir);

  if (declaredSkillFilesAreCurrent(skillDir, files)) {
    logger.debug("Skill already current", { platform: platform.platform, skill: skill.name });
    return makeResult("skills", { attempted: true, success: true, action: "skipped" });
  }

  if (!options.dryRun) {
    for (const file of files) {
      const filePath = skillFilePath(skillDir, file.path);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      atomicWriteFileSync(filePath, file.content);
    }
    logger.info("Skill installed", { platform: platform.platform, skill: skill.name });
  }

  return makeResult("skills", {
    attempted: true,
    success: true,
    action: skillDirExists ? "updated" : "created",
  });
}

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
  validateToolName(toolName);
  validateRelativePath(skillName, "skill name");

  const skillDir = path.join(platform.skillsPath, toolName, skillName);
  try {
    if (!fs.statSync(skillDir).isDirectory()) return false;
  } catch { return false; }

  if (!dryRun) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    const toolDir = path.join(platform.skillsPath, toolName);
    try {
      const remaining = fs.readdirSync(toolDir);
      if (remaining.length === 0) fs.rmdirSync(toolDir);
    } catch { /* not empty or doesn't exist */ }
  }

  return true;
}

/**
 * Check if a skill is installed on a platform.
 */
export function hasSkill(
  platform: DetectedPlatform,
  toolName: string,
  skillName: string,
): boolean {
  if (!platform.skillsPath) return false;
  validateToolName(toolName);
  validateRelativePath(skillName, "skill name");
  const skillMd = path.join(platform.skillsPath, toolName, skillName, "SKILL.md");
  try { return fs.statSync(skillMd).isFile(); } catch { return false; }
}
