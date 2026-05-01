// Skill file installation: copies SKILL.md and supporting files to platform skill directories.
// Skills use a universal format (Agent Skills spec); no per-platform translation needed.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import { type DetectedPlatform } from "./platforms";
import { atomicWriteFileSync } from "./fs";
import { validateRelativePath, validatePathWithinDir, validateToolName, validateSkillName } from "./validation";
import { JsonStore } from "./storage/datastore";

// "Augments owning skill X on platform P" = augments with X in their
// content.skills AND P in their installedPlatforms.
function findAugmentsOwningSkill(platformId: string, skillName: string, excludeAugment?: string): string[] {
  return JsonStore.listResolved()
    .filter((r) =>
      r.installed
      && r.installedPlatforms.includes(platformId)
      && r.skills.some((s) => s.name === skillName)
      && r.name !== excludeAugment,
    )
    .map((r) => r.name);
}
import {
  MANIFEST_FILENAME,
  buildManifestForInstall,
  buildTombstoneManifest,
  findOwner,
  isTombstone,
  manifestPath,
  manifestSoleOwner,
  readManifest,
  verifyFileAgainstManifest,
  writeManifest,
  type SkillManifestOwnerSource,
} from "./skill-manifest";
import { setCachedHashes, pruneCacheEntries } from "./checksum-cache";
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
 * Options accepted by installSkill / Augment.installSkill.
 *
 * Identity / provenance fields populate the per-skill manifest. They're
 * optional — local installs and unit tests pass nothing and get sensible
 * defaults — but the registry-install path should populate them so the
 * manifest reflects accurate ownership.
 */
export interface InstallSkillOptions {
  dryRun?: boolean;
  logger?: EquipLogger;
  /** Bypass cross-augment collision refusal (manifest names a different augment). */
  takeover?: boolean;
  /** Bypass user-authored refusal (skill dir exists with no manifest and no journal record for us). */
  adopt?: boolean;
  /** Augment registry version recorded in the manifest. Defaults to 0 for local installs. */
  augmentVersion?: number;
  /** Where the augment def came from. Defaults to "local". */
  source?: SkillManifestOwnerSource;
  /** npm package name when applicable (registry installs). */
  package?: string;
  /** Equip CLI version recorded in the manifest. Defaults to "unknown". */
  equipVersion?: string;
}

/**
 * Reasons installSkill can refuse a write. Returned via ArtifactResult.errorCode
 * so callers can branch on the conflict type for tailored messaging or
 * partial augment install handling.
 */
export const SKILL_COLLISION_OTHER_AUGMENT = "SKILL_COLLISION_OTHER_AUGMENT" as const;
export const SKILL_COLLISION_USER_AUTHORED = "SKILL_COLLISION_USER_AUTHORED" as const;
export const SKILL_COLLISION_FORGED_MANIFEST = "SKILL_COLLISION_FORGED_MANIFEST" as const;

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
 * Per-skill ownership is recorded in {skillDir}/.equip-meta.json (the manifest),
 * which is the on-disk hygiene control for cross-augment collision detection.
 * The journal is the authoritative cross-platform index — the manifest is
 * advisory and forgeable, so collision decisions cross-check both.
 *
 * @param platform - Detected platform with skillsPath
 * @param toolName - Owning augment name; used for ownership + legacy-layout cleanup
 * @param skill - Skill config with name and files
 * @param options - See {@link InstallSkillOptions}
 */
export function installSkill(
  platform: DetectedPlatform,
  toolName: string,
  skill: SkillConfig,
  options: InstallSkillOptions = {},
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
  const normalizedSkill: SkillConfig = { name: skill.name, files };

  const skillDir = path.join(platform.skillsPath, skill.name);
  const skillDirExists = fs.existsSync(skillDir);

  // ── Collision-check decision tree ──
  // Read the existing manifest; tolerate a corrupt one by treating it as absent
  // and warning. We never want a corrupt manifest to brick install.
  let existingManifest;
  try {
    existingManifest = readManifest(skillDir);
  } catch (e) {
    logger.warn("Skill manifest unreadable; treating as absent", {
      skillDir, error: (e as Error).message,
    });
    existingManifest = null;
  }

  if (skillDirExists) {
    const collisionRefusal = decideCollision({
      platform: platform.platform,
      toolName,
      skillName: skill.name,
      existingManifest,
      options,
      logger,
    });
    if (collisionRefusal) return collisionRefusal;
  }

  // ── Files: skip-current OR write ──
  let filesAction: "created" | "updated" | "skipped";
  if (declaredSkillFilesAreCurrent(skillDir, files)) {
    logger.debug("Skill already current", { platform: platform.platform, skill: skill.name });
    cleanupLegacySkillSubtree(platform.skillsPath, toolName, skill.name, logger, options.dryRun);
    filesAction = "skipped";
  } else {
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
    filesAction = skillDirExists ? "updated" : "created";
  }

  // ── Manifest write (last step, atomic) ──
  // Skip the rewrite when files were skipped AND the existing manifest already
  // names us correctly with matching file count AND no shared-root owners need to
  // be added. Otherwise write a fresh manifest so it tracks current ownership +
      // content. Under the shared-root case, preserve other-platform
  // owners on rewrite so their claims survive our re-install.
  if (!options.dryRun) {
    // The existing-manifest-already-current shortcut: skip the manifest write
    // when files were unchanged AND the manifest's record of OUR (augment, platform)
    // entry matches the version we'd write now. If augmentVersion changed (or
    // anything else about our owner record drifts), force a rewrite so the manifest
    // reflects current intent.
    const ourExistingOwner = existingManifest
      ? findOwner(existingManifest, toolName, platform.platform)
      : null;
    const manifestStillCurrent =
      filesAction === "skipped" &&
      existingManifest !== null &&
      ourExistingOwner !== null &&
      existingManifest.files.length === files.length &&
      ourExistingOwner.augmentVersion === (options.augmentVersion ?? 0);

    if (!manifestStillCurrent) {
      const baseManifest = buildManifestForInstall({
        skill: normalizedSkill,
        toolName,
        augmentVersion: options.augmentVersion,
        source: options.source ?? "local",
        package: options.package,
        platformId: platform.platform,
        skillsRoot: platform.skillsPath,
        equipVersion: options.equipVersion ?? "unknown",
      });

      // Preserve shared-root co-owners — entries from the existing manifest whose
      // (augment, platform) tuple is NOT the one we're about to write. --takeover
      // explicitly discards everyone else's claims, so skip preservation in that mode.
      const finalManifest = (() => {
        if (options.takeover || !existingManifest) return baseManifest;
        const otherOwners = existingManifest.owners.filter(
          o => !(o.augment === toolName && o.platform === platform.platform),
        );
        if (otherOwners.length === 0) return baseManifest;
        return { ...baseManifest, owners: [...baseManifest.owners, ...otherOwners] };
      })();

      try {
        writeManifest(skillDir, finalManifest);
      } catch (e) {
        logger.warn("Skill manifest write failed; install proceeds without manifest", {
          skillDir, error: (e as Error).message,
        });
      }

      // Seed the checksum cache from the freshly-computed manifest hashes so
      // future verifies (uninstall, equip verify) hit the fast path. We already
      // know the hashes (computed in buildManifestForInstall) and the files are
      // freshly on disk — no extra read or hash needed. Best-effort: cache write
      // failures don't affect install outcome.
      const seeds = finalManifest.files.map(f => ({
        filePath: path.join(skillDir, ...f.path.split("/")),
        sha256: f.hash.value,
      }));
      setCachedHashes(seeds, logger);
    }
  }

  return makeResult("skills", {
    attempted: true,
    success: true,
    action: filesAction,
  });
}

interface CollisionDecisionInput {
  platform: string;
  toolName: string;
  skillName: string;
  existingManifest: ReturnType<typeof readManifest>;
  options: InstallSkillOptions;
  logger: EquipLogger;
}

/**
 * Returns an ArtifactResult representing a refusal, or null if install may proceed.
 * Implements the manifest/journal ownership decision tree.
 */
function decideCollision(input: CollisionDecisionInput): ArtifactResult | null {
  const { platform, toolName, skillName, existingManifest, options, logger } = input;

  // Manifest owner cross-checks: if a manifest exists and names us, we own this dir.
  const weOwnByManifest =
    existingManifest !== null &&
    findOwner(existingManifest, toolName, platform) !== null;
  if (weOwnByManifest) return null;

  // Shared-root case: the manifest names US as owner for a DIFFERENT
  // platform. This happens when an augment installs to multiple platforms whose
  // skillsPath() resolves to the same directory (e.g., codex + windsurf + vscode
  // all share `~/.agents/skills/`). The dir is ours; we just haven't registered
  // ourselves for THIS platform yet. Install proceeds without refusal; the
  // manifest write at the end of installSkill appends our new owner entry.
  if (existingManifest !== null) {
    const ourOtherPlatformOwnership = existingManifest.owners.find(o => o.augment === toolName);
    if (ourOtherPlatformOwnership) {
      logger.debug("Shared-root install — appending owner for new platform", {
        platform, skill: skillName, augment: toolName,
        existingPlatform: ourOtherPlatformOwnership.platform,
      });
      return null;
    }
  }

  // Find OTHER augments the journal believes own this skill on this platform.
  const otherInstalled = findAugmentsOwningSkill(platform, skillName, toolName);

  // Manifest names a DIFFERENT augment.
  if (existingManifest !== null) {
    const sole = manifestSoleOwner(existingManifest);
    const claimedAugment =
      sole?.augment ??
      existingManifest.owners.find(o => o.platform === platform)?.augment ??
      existingManifest.owners[0]?.augment;
    if (claimedAugment && claimedAugment !== toolName) {
      const confirmedByJournal = otherInstalled.includes(claimedAugment);
      if (confirmedByJournal) {
        // True cross-augment collision (D)
        if (!options.takeover) {
          return refuse(SKILL_COLLISION_OTHER_AUGMENT,
            `Skill "${skillName}" on ${platform} is owned by augment "${claimedAugment}". ` +
            `Pass --takeover to overwrite.`,
            logger);
        }
        logger.warn("Takeover overrides cross-augment collision", {
          platform, skill: skillName, formerOwner: claimedAugment, newOwner: toolName,
        });
        return null;
      }
      // Manifest names an augment that the journal doesn't confirm — forged advisory (E)
      logger.warn("Forged manifest detected; ignoring claimed owner", {
        platform, skill: skillName, claimedAugment,
      });
      // Fall through to the "no manifest" handling below.
    }
  }

  // No (trusted) manifest. Decide based on the journal.
  if (otherInstalled.length > 0) {
    // Journal says someone else owns this — refuse without --takeover (B3).
    if (!options.takeover) {
      return refuse(SKILL_COLLISION_OTHER_AUGMENT,
        `Skill "${skillName}" on ${platform} is recorded as owned by ${otherInstalled.join(", ")}. ` +
        `Pass --takeover to overwrite.`,
        logger);
    }
    logger.warn("Takeover overrides journal collision", {
      platform, skill: skillName, formerOwners: otherInstalled, newOwner: toolName,
    });
    return null;
  }

  // No one else claims it. Did WE install it previously per the storage layer?
  // Phase A migration: derive from the resolved augment view. The resolver
  // returns the current effective skills (mod overrides applied); if our
  // augment's resolved view includes this skill name, we expect to own it.
  const ourResolved = JsonStore.resolve(toolName);
  const ourSkillNames = ourResolved?.skills.map((s) => s.name) ?? [];
  const weExpectThis = ourSkillNames.includes(skillName);
  if (weExpectThis) {
    // Recovery case — files were installed by us in a prior run, just no manifest yet.
    logger.debug("Recovering manifest for previously-installed skill", { platform, skill: skillName });
    return null;
  }

  // Skill dir exists, no manifest, no one claims it. Likely user-authored. (B1)
  if (!options.adopt) {
    const code = existingManifest ? SKILL_COLLISION_FORGED_MANIFEST : SKILL_COLLISION_USER_AUTHORED;
    return refuse(code,
      `Skill directory "${skillName}" on ${platform} exists but is not tracked by Equip. ` +
      `Pass --adopt to take ownership.`,
      logger);
  }
  logger.warn("Adopt overrides user-authored skill", { platform, skill: skillName, augment: toolName });
  return null;
}

function refuse(
  code: typeof SKILL_COLLISION_OTHER_AUGMENT
      | typeof SKILL_COLLISION_USER_AUTHORED
      | typeof SKILL_COLLISION_FORGED_MANIFEST,
  message: string,
  logger: EquipLogger,
): ArtifactResult {
  logger.info("Skill install refused", { code, message });
  return makeResult("skills", {
    attempted: true,
    success: false,
    action: "skipped",
    errorCode: code,
    error: message,
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
 * Result of an uninstallSkill call. Replaces the historical boolean return so
 * callers can surface preserved files (user-modified or user-added content
 * that survived the uninstall) and tombstone outcomes to the user.
 */
export interface UninstallSkillResult {
  /** True if any Equip-owned content was removed (or would be in dry-run). */
  removed: boolean;
  /**
   * Files Equip wrote that were preserved on uninstall because their content
   * drifted from the manifest hash (user-modified). Paths are relative to the
   * skill dir. Empty array on the legacy / no-manifest path even if foreign
   * content survived (we can't tell what's foreign without a manifest).
   */
  preservedFiles: string[];
  /**
   * True if a tombstone manifest was written — the skill dir survived because
   * preserved or foreign content remained, and the manifest now records the
   * dir as "Equip once owned this; do not auto-wrap."
   */
  tombstone: boolean;
  /**
   * True when removal followed the manifest path (preferred). False = legacy
   * fallback recursive delete (manifest absent or unreadable).
   */
  viaManifest: boolean;
}

export interface UninstallSkillOptions {
  logger?: EquipLogger;
}

/**
 * Remove a skill installed by `toolName` on `platform`. Behavior depends on
 * whether a per-skill manifest is present:
 *
 * - Manifest present + names us as owner → walk manifest.files[] and unlink
 *   only files whose current SHA-256 matches the manifest. User-modified files
 *   are preserved. If the dir is empty after unlink, it's removed entirely;
 *   otherwise a tombstone manifest is written.
 * - Manifest present + names a different augment → refuse and log a warning.
 *   We do not touch what we don't own.
 * - Manifest absent → log a warning and fall back to recursive delete (today's
 *   legacy behavior). User-added files in this dir are lost — same
 *   as before this package shipped, no regression.
 *
 * Legacy `{skillsPath}/{toolName}/{skillName}/` wrapper subtrees from older
 * equip versions are also cleaned up here. Recursive delete on the legacy
 * path is still safe because that path is unreadable by every platform's
 * loader (the very reason Fix A flat-layout exists).
 *
 * `toolName` is retained for both ownership semantics (manifest cross-check)
 * and legacy-layout cleanup.
 */
export function uninstallSkill(
  platform: DetectedPlatform,
  toolName: string,
  skillName: string,
  dryRun: boolean = false,
  options: UninstallSkillOptions = {},
): UninstallSkillResult {
  const logger = options.logger || NOOP_LOGGER;
  const result: UninstallSkillResult = {
    removed: false,
    preservedFiles: [],
    tombstone: false,
    viaManifest: false,
  };

  if (!platform.skillsPath) return result;
  validateToolName(toolName);
  validateSkillName(skillName);

  const skillDir = path.join(platform.skillsPath, skillName);
  const skillDirExists = (() => {
    try { return fs.statSync(skillDir).isDirectory(); }
    catch { return false; }
  })();

  if (skillDirExists) {
    // Read the manifest. Corrupt → treat as absent and fall through to
    // legacy recursive delete (same UX as older releases; non-regression).
    let manifest;
    try {
      manifest = readManifest(skillDir);
    } catch (e) {
      logger.warn("Skill manifest unreadable; falling back to recursive delete", {
        skillDir, error: (e as Error).message,
      });
      manifest = null;
    }

    if (manifest && !isTombstone(manifest)) {
      const ourEntry = findOwner(manifest, toolName, platform.platform);
      if (!ourEntry) {
        // We're not in the owners list. Refuse — don't touch what we don't own.
        const claimedAugments = manifest.owners.map(o => o.augment).join(", ") || "(none)";
        logger.warn("Skill not owned by this augment; refusing to uninstall", {
          skillDir, requestedBy: toolName, claimedOwners: claimedAugments,
        });
        // Still attempt legacy cleanup below.
      } else {
        // Refcount check: if other (augment, platform) owners remain,
        // this is a shared-root install. Remove only OUR owner entry; leave files
        // and the dir intact for the surviving owners.
        const otherOwners = manifest.owners.filter(
          o => !(o.augment === toolName && o.platform === platform.platform),
        );
        if (otherOwners.length > 0) {
          if (!dryRun) {
            const updatedManifest = { ...manifest, owners: otherOwners };
            try {
              writeManifest(skillDir, updatedManifest);
            } catch (e) {
              logger.warn("Manifest rewrite failed during refcount removal", {
                skillDir, error: (e as Error).message,
              });
            }
          }
          logger.debug("Shared-root uninstall — owner entry removed; files preserved for co-owners", {
            skillDir, removed: `${toolName}@${platform.platform}`,
            remainingOwners: otherOwners.map(o => `${o.augment}@${o.platform}`),
          });
          result.removed = true;
          result.viaManifest = true;
          // Skip file deletion and legacy cleanup — files are still owned.
          return result;
        }

        // Last-owner removal: fall through to full cleanup.
        result.viaManifest = true;
        const { removed, preservedFiles, foreignFiles } = unlinkOwnedFiles(skillDir, manifest.files, dryRun);
        result.preservedFiles = preservedFiles;
        result.removed = removed || preservedFiles.length === 0;

        if (!dryRun) {
          // Decide: full removal vs tombstone.
          // "Full removal" condition: nothing preserved AND no foreign content.
          // Anything else → tombstone.
          if (preservedFiles.length === 0 && foreignFiles.length === 0) {
            try { fs.unlinkSync(manifestPath(skillDir)); } catch { /* may already be gone */ }
            try { fs.rmSync(skillDir, { recursive: true, force: true }); } catch (e) {
              logger.debug("Skill dir removal failed", { skillDir, error: (e as Error).message });
            }
          } else {
            // Tombstone: dir survives, manifest records the uninstall.
            const tombstone = buildTombstoneManifest({
              previous: manifest,
              uninstalledBy: toolName,
              preservedFiles: [...preservedFiles, ...foreignFiles],
            });
            try {
              writeManifest(skillDir, tombstone);
              result.tombstone = true;
              logger.info("Tombstone written; preserved user content", {
                skillDir, preservedFiles: tombstone.tombstone ? (tombstone.tombstone as { preservedFiles: string[] }).preservedFiles : [],
              });
            } catch (e) {
              logger.warn("Tombstone write failed; manifest may be in inconsistent state", {
                skillDir, error: (e as Error).message,
              });
            }
          }
        }
      }
    } else if (manifest && isTombstone(manifest)) {
      // Already a tombstone — nothing to remove. Treat as no-op success.
      logger.debug("Skill is already a tombstone; nothing to uninstall", { skillDir });
    } else {
      // Manifest-absent fallback: legacy recursive delete with warning.
      logger.warn("No skill manifest; falling back to recursive delete (user-modified files in this dir will be lost)", {
        skillDir, augment: toolName,
      });
      if (!dryRun) {
        try { fs.rmSync(skillDir, { recursive: true, force: true }); }
        catch (e) {
          logger.debug("Legacy skill dir removal failed", { skillDir, error: (e as Error).message });
        }
      }
      result.removed = true;
    }
  }

  // Legacy nested-layout cleanup ({skillsPath}/{toolName}/{skillName}/).
  // Unchanged: that layout is unreadable by every platform loader, so recursive
  // delete is safe. Only happens for users who never re-installed since Fix A.
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
      result.removed = true;
    }
  } catch { /* nothing to remove at legacy path */ }

  return result;
}

/**
 * Walk the manifest's files[] entries and unlink the ones whose on-disk
 * SHA-256 still matches. Drifted (user-modified) and unreadable files are
 * preserved. Foreign content (files in the dir not listed in the manifest)
 * is reported separately so the caller can decide tombstone vs full removal.
 *
 * In dry-run mode, returns what would be unlinked vs preserved without
 * touching disk.
 */
function unlinkOwnedFiles(
  skillDir: string,
  files: ReturnType<typeof buildManifestForInstall>["files"],
  dryRun: boolean,
): { removed: boolean; preservedFiles: string[]; foreignFiles: string[] } {
  const preservedFiles: string[] = [];
  const unlinkedAbsPaths: string[] = [];
  let removed = false;

  // Build a Set of manifest paths for fast foreign-content detection later.
  const ownedRelPaths = new Set(files.map(f => f.path));

  for (const file of files) {
    const filePath = path.join(skillDir, ...file.path.split("/"));
    const status = verifyFileAgainstManifest(filePath, file.hash);
    if (status === "match") {
      removed = true;
      if (!dryRun) {
        try { fs.unlinkSync(filePath); } catch { /* may already be gone */ }
        unlinkedAbsPaths.push(filePath);
        // Try to remove now-empty parent dirs (e.g., scripts/, references/).
        // Stop at skillDir — we'll decide its fate at the caller level.
        let parent = path.dirname(filePath);
        while (parent !== skillDir && parent.startsWith(skillDir)) {
          try { fs.rmdirSync(parent); } catch { break; /* not empty */ }
          parent = path.dirname(parent);
        }
      }
    } else if (status === "drift") {
      preservedFiles.push(file.path);
    }
    // missing | unreadable → no preservation, no error (already gone or inaccessible).
  }

  // Drop cache entries for unlinked files. The cache wouldn't be wrong if left
  // alone (a future stat would miss because the file is gone), but pruning
  // keeps cache size bounded over many install/uninstall cycles.
  if (!dryRun && unlinkedAbsPaths.length > 0) {
    pruneCacheEntries(unlinkedAbsPaths);
  }

  // Foreign content: anything in skillDir (recursive) that's neither owned nor the manifest itself.
  const foreignFiles = listForeignFiles(skillDir, ownedRelPaths);

  return { removed, preservedFiles, foreignFiles };
}

function listForeignFiles(skillDir: string, ownedRelPaths: Set<string>): string[] {
  const foreign: string[] = [];
  function walk(currentDir: string, relPrefix: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (relPath === MANIFEST_FILENAME) continue; // manifest itself isn't foreign
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name), relPath);
      } else if (entry.isFile()) {
        if (!ownedRelPaths.has(relPath)) foreign.push(relPath);
      }
    }
  }
  walk(skillDir, "");
  return foreign;
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
