// Skill file installation: copies SKILL.md and supporting files to platform skill directories.
// Skills use a universal format (Agent Skills spec); no per-platform translation needed.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import { type DetectedPlatform } from "./platforms";
import { atomicWriteFileSync } from "./fs";
import { validateRelativePath, validatePathWithinDir, validateToolName, validateSkillName } from "./validation";
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
 * Layout: {skillsPath}/{skillName}/SKILL.md
 *
 * The Agent Skills spec requires the skill's `name` field to match its parent
 * directory. Wrapping skills under an extra {toolName} directory breaks
 * discovery on every platform (Claude Code, Cursor, Codex, etc.), so we install
 * skills flat. The `toolName` parameter is retained for ownership semantics
 * (uninstall) and for cleaning up legacy nested installs from earlier versions.
 *
 * Install is add/update-only: files no longer declared by the incoming skill are
 * left in place until managed-install metadata can distinguish stale files from
 * user-added local files.
 *
 * @param platform - Detected platform with skillsPath
 * @param toolName - Owning augment name; used for legacy-layout cleanup, not for path scoping
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
  validateSkillName(skill.name);
  const files = normalizeSkillFiles(skill.files);

  const skillDir = path.join(platform.skillsPath, skill.name);
  const skillDirExists = fs.existsSync(skillDir);

  if (declaredSkillFilesAreCurrent(skillDir, files)) {
    logger.debug("Skill already current", { platform: platform.platform, skill: skill.name });
    cleanupLegacySkillSubtree(platform.skillsPath, toolName, skill.name, logger, options.dryRun);
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
    cleanupLegacySkillSubtree(platform.skillsPath, toolName, skill.name, logger, false);
  }

  return makeResult("skills", {
    attempted: true,
    success: true,
    action: skillDirExists ? "updated" : "created",
  });
}

/**
 * Scoped removal of the legacy `{skillsPath}/{toolName}/{skillName}/` subtree
 * left by older equip versions. We only delete the *specific skill subtree*
 * we know we previously wrote (same toolName + same skillName), then attempt
 * an `rmdir` on the parent wrapper dir which succeeds only if it's empty.
 *
 * We deliberately do NOT recursively delete the whole `{skillsPath}/{toolName}/`
 * wrapper: other content under that path may be from a different augment, a
 * different skill from the same augment that hasn't been re-installed yet, or
 * unrelated user content. Recursive cleanup of the wrapper was a hazard
 * (security analysis F-3) — an attacker augment could trigger deletion of a
 * victim augment's legacy install simply by sharing the wrapper name.
 *
 * Failures are logged but never fatal.
 */
function cleanupLegacySkillSubtree(
  skillsPath: string,
  toolName: string,
  skillName: string,
  logger: EquipLogger,
  dryRun: boolean | undefined,
): void {
  const wrapperDir = path.join(skillsPath, toolName);
  const legacySkillDir = path.join(wrapperDir, skillName);

  // Only act on a path that looks like the legacy install of THIS skill —
  // i.e. it contains a SKILL.md. If there's no SKILL.md, this is not our
  // legacy install and we leave it alone.
  let isLegacySkillInstall = false;
  try {
    if (fs.statSync(path.join(legacySkillDir, "SKILL.md")).isFile()) {
      isLegacySkillInstall = true;
    }
  } catch { /* nothing here, nothing to clean up */ }

  if (!isLegacySkillInstall || dryRun) return;

  try {
    fs.rmSync(legacySkillDir, { recursive: true, force: true });
    logger.info("Removed legacy skill subtree", { skillsPath, toolName, skillName });
  } catch (e) {
    logger.debug("Legacy skill subtree cleanup failed", {
      skillsPath, toolName, skillName, error: (e as Error).message,
    });
    return;
  }

  // If the wrapper dir is now empty (we removed the last legacy skill in it),
  // rmdir it. Non-empty → leave alone (other augments may still own subdirs).
  try {
    const remaining = fs.readdirSync(wrapperDir);
    if (remaining.length === 0) fs.rmdirSync(wrapperDir);
  } catch { /* not empty or doesn't exist */ }
}

/**
 * Remove a skill directory from a platform.
 *
 * `toolName` is retained for API stability and legacy-layout cleanup, even
 * though skills now live flat at {skillsPath}/{skillName}/. Returns true if
 * either the current flat install OR a legacy wrapper install was removed.
 */
export function uninstallSkill(
  platform: DetectedPlatform,
  toolName: string,
  skillName: string,
  dryRun: boolean = false,
): boolean {
  if (!platform.skillsPath) return false;
  validateToolName(toolName);
  validateSkillName(skillName);

  let removed = false;

  const skillDir = path.join(platform.skillsPath, skillName);
  try {
    if (fs.statSync(skillDir).isDirectory()) {
      if (!dryRun) fs.rmSync(skillDir, { recursive: true, force: true });
      removed = true;
    }
  } catch { /* nothing to remove at flat path */ }

  // Legacy: also clean up {skillsPath}/{toolName}/{skillName}/ from older equip versions.
  const legacySkillDir = path.join(platform.skillsPath, toolName, skillName);
  try {
    if (fs.statSync(legacySkillDir).isDirectory()) {
      if (!dryRun) {
        fs.rmSync(legacySkillDir, { recursive: true, force: true });
        const legacyToolDir = path.join(platform.skillsPath, toolName);
        try {
          const remaining = fs.readdirSync(legacyToolDir);
          if (remaining.length === 0) fs.rmdirSync(legacyToolDir);
        } catch { /* not empty or doesn't exist */ }
      }
      removed = true;
    }
  } catch { /* nothing to remove at legacy path */ }

  return removed;
}

/**
 * Check if a skill is installed on a platform.
 *
 * `toolName` is retained for API stability and back-compat detection. Returns
 * true if the skill exists at the current flat layout OR at the legacy
 * wrapper layout from older equip versions.
 */
export function hasSkill(
  platform: DetectedPlatform,
  toolName: string,
  skillName: string,
): boolean {
  if (!platform.skillsPath) return false;
  validateToolName(toolName);
  validateSkillName(skillName);
  const flat = path.join(platform.skillsPath, skillName, "SKILL.md");
  try { if (fs.statSync(flat).isFile()) return true; } catch { /* fall through */ }
  const legacy = path.join(platform.skillsPath, toolName, skillName, "SKILL.md");
  try { return fs.statSync(legacy).isFile(); } catch { return false; }
}
