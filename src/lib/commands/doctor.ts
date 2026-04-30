// equip doctor — validate config integrity and detect drift.

import * as fs from "fs";
import * as path from "path";
import { PLATFORM_REGISTRY } from "../platforms";
import { readMcpEntry } from "../mcp";
import { JsonStore } from "../storage/datastore";
import { dirExists, fileExists } from "../detect";
import * as cli from "../cli";
import { checkAuth } from "../auth";
import { readStoredCredential, isCredentialExpired, listStoredCredentials } from "../auth-engine";
import { findOrphanHookEntries } from "../hooks";

/**
 * Friendly hint for broker-managed installs. Doctor (in equip lib) does not
 * call broker IPC — that's a downstream concern living in equip-app/sidecar.
 * Per architectural review (06c, 2026-04-27): the boundary is a single
 * `installMode` field on the install record; doctor reads it, the sidecar
 * `broker-health` command consumes the live IPC surface.
 */
const BROKER_HEALTH_HINT = "broker-managed — run 'equip-app sidecar broker-health' for live status";

export interface DoctorOptions {
  /** When true, prune orphan hook entries from platform settings files. */
  fixOrphanHooks?: boolean;
}

export function runDoctor(options: DoctorOptions = {}): void {
  cli.log(`\n${cli.BOLD}equip doctor${cli.RESET}\n`);

  // Phase A: doctor reads via storage layer's resolver. ResolvedAugment
  // carries content + install state in one shape; per-platform install mode
  // (broker vs direct) lives on the install intent's installModes map and
  // surfaces as resolved.installModes. Per-platform artifact details
  // (mcp/rules/skills) are derived from content × installedPlatforms.
  const resolvedAugments = JsonStore.listResolved().filter((r) => r.installed);
  let issues = 0;
  let checks = 0;

  // Check 1: Any installs tracked
  checks++;
  if (resolvedAugments.length === 0) {
    cli.warn("No equip state found — run 'equip update' to initialize");
    issues++;
  } else {
    cli.ok("Installation records present");
  }

  // Check 2: For each tracked augment × platform, verify config exists
  if (resolvedAugments.length === 0) {
    cli.log(`\n  ${cli.DIM}No tracked augments to check.${cli.RESET}`);
    cli.log(`  ${cli.DIM}Install an augment (e.g. 'equip prior') to start tracking.${cli.RESET}\n`);
    // Cleanup B Pkg 06 batch 1: still surface the cutover status even when
    // no installs are tracked — the snapshot's existence + the cutover-
    // incomplete signal are orthogonal to install state.
    const cutoverIncompleteEarly = reportCleanupBBackup();
    if (cutoverIncompleteEarly) {
      issues++;
      cli.log("");
      cli.log(`  ${cli.YELLOW}${issues} issue${issues === 1 ? "" : "s"} found${cli.RESET} ${cli.DIM}(${checks} checks)${cli.RESET}\n`);
    }
    return;
  }

  cli.log(`\n${cli.BOLD}Checking tracked augments${cli.RESET}`);

  for (const augContent of resolvedAugments) {
    const augmentName = augContent.name;
    const title = augContent.title;
    cli.log(`\n  ${cli.BOLD}${augmentName}${cli.RESET} ${cli.DIM}(${title})${cli.RESET}`);

    for (const platformId of augContent.installedPlatforms) {
      checks++;
      const def = PLATFORM_REGISTRY.get(platformId);
      if (!def) {
        cli.fail(`  ${platformId}: unknown platform (may have been removed)`);
        issues++;
        continue;
      }

      const configPath = def.configPath();
      const isBrokerManaged = augContent.installModes[platformId] === "broker";
      // Derived "artifacts" — what would be installed given current content + platform.
      const artifacts = {
        mcp: !!(augContent.serverUrl || augContent.stdio),
        rules: augContent.rules?.version,
        skills: augContent.skills.map((s) => s.name),
        hooks: augContent.hooks.map((h) => h.script),
      };

      // Check config file exists
      if (!fileExists(configPath)) {
        cli.fail(`  ${def.name}: config file missing (${sanitizePath(configPath)})`);
        issues++;
        continue;
      }

      // Check tool entry is present in config
      if (artifacts.mcp) {
        const entry = readMcpEntry(configPath, def.rootKey, augmentName, def.configFormat);
        if (!entry) {
          cli.fail(`  ${def.name}: "${augmentName}" entry missing from config (drift detected)`);
          issues++;
          continue;
        }

        if (isBrokerManaged) {
          // Broker-managed entries are stdio-shim shape (command + args, no
          // url, no auth headers). The URL-HTTPS and auth-header checks
          // below would fire false-positive warnings on these. Skip them
          // and surface the broker-health hint instead — the live status
          // (live / refreshing / consent_revoked / etc.) lives behind the
          // broker IPC and is rendered by `equip-app sidecar broker-health`.
        } else {
          // Check URL is HTTPS
          const url = (entry as Record<string, unknown>).url || (entry as Record<string, unknown>).serverUrl || (entry as Record<string, unknown>).httpUrl;
          if (url && typeof url === "string" && !url.startsWith("https://") && !url.startsWith("http://localhost")) {
            checks++;
            cli.warn(`  ${def.name}: server URL is not HTTPS (${url})`);
            issues++;
          }

          // Check auth headers
          if (augContent?.transport === "http") {
            checks++;
            const authResult = checkAuth(entry as Record<string, unknown>);
            if (authResult.status === "missing") {
              cli.warn(`  ${def.name}: no auth header found in config`);
              issues++;
            } else if (authResult.status === "expired") {
              cli.fail(`  ${def.name}: auth token expired (${authResult.detail})`);
              issues++;
            }
          }
        }
      }

      // Check rules if tracked
      let rulesOk = true;
      if (artifacts.rules) {
        checks++;
        const rulesPath = def.rulesPath ? def.rulesPath() : null;
        if (!rulesPath) {
          rulesOk = false;
        } else {
          try {
            const rulesContent = fs.readFileSync(rulesPath, "utf-8");
            const versionMatch = rulesContent.match(new RegExp(`<!-- ${augmentName}:v([0-9.]+) -->`));
            if (!versionMatch) {
              cli.warn(`  ${def.name}: rules block not found in ${sanitizePath(rulesPath)}`);
              issues++;
              rulesOk = false;
            } else if (versionMatch[1] !== artifacts.rules) {
              cli.warn(`  ${def.name}: rules version mismatch (installed: v${versionMatch[1]}, expected: v${artifacts.rules})`);
              issues++;
              rulesOk = false;
            }
          } catch {
            cli.warn(`  ${def.name}: rules file not readable (${sanitizePath(rulesPath)})`);
            issues++;
            rulesOk = false;
          }
        }
      }

      // Check hooks if tracked
      let hooksOk = true;
      if (artifacts.hooks && artifacts.hooks.length > 0) {
        checks++;
        const hookDir = path.join(require("os").homedir(), `.${augmentName}`, "hooks");
        for (const script of artifacts.hooks) {
          const scriptPath = path.join(hookDir, script);
          if (!fileExists(scriptPath)) {
            cli.warn(`  ${def.name}: hook script missing (${sanitizePath(scriptPath)})`);
            issues++;
            hooksOk = false;
          }
        }
      }

      // Check skills if tracked
      let skillsOk = true;
      if (artifacts.skills && artifacts.skills.length > 0 && def.skillsPath) {
        checks++;
        const skillsBase = def.skillsPath();
        for (const skillName of artifacts.skills) {
          const skillMd = path.join(skillsBase, augmentName, skillName, "SKILL.md");
          if (!fileExists(skillMd)) {
            cli.warn(`  ${def.name}: skill "${skillName}" missing (${sanitizePath(skillMd)})`);
            issues++;
            skillsOk = false;
          }
        }
      }

      // Summary line for this platform
      const parts: string[] = [];
      if (artifacts.mcp) parts.push(isBrokerManaged ? "broker-config" : "config");
      if (artifacts.rules && rulesOk) parts.push(`rules v${artifacts.rules}`);
      if (artifacts.hooks && artifacts.hooks.length > 0 && hooksOk) parts.push(`${artifacts.hooks.length} hook${artifacts.hooks.length === 1 ? "" : "s"}`);
      if (artifacts.skills && artifacts.skills.length > 0 && skillsOk) parts.push(`${artifacts.skills.length} skill${artifacts.skills.length === 1 ? "" : "s"}`);
      if (rulesOk && hooksOk && skillsOk) {
        cli.ok(`  ${def.name}: ${parts.join(" + ") || "present"}`);
        if (isBrokerManaged) {
          cli.log(`    ${cli.DIM}${BROKER_HEALTH_HINT}${cli.RESET}`);
        }
      }
    }
  }

  // Check 3: Stored credential health (direct-mode only).
  //
  // `listStoredCredentials()` reads from auth-engine's direct-mode store
  // (`~/.equip/credentials/` or equivalent). Broker-managed credentials
  // live in the sidecar's FileCredentialStore (`~/.equip/secrets/`) and
  // are intentionally NOT visible here — querying the broker's store from
  // equip lib would re-introduce the boundary violation Pkg 06c was
  // designed to avoid. Broker credential health is surfaced via
  // `equip-app sidecar broker-health`.
  const credTools = listStoredCredentials();
  if (credTools.length > 0) {
    cli.log(`\n${cli.BOLD}Credential health${cli.RESET} ${cli.DIM}(direct-mode)${cli.RESET}`);
    for (const credTool of credTools) {
      checks++;
      const cred = readStoredCredential(credTool);
      if (!cred) continue;

      if (cred.oauth?.refreshToken) {
        if (isCredentialExpired(cred)) {
          cli.warn(`  ${credTool}: OAuth token expired — run 'equip refresh ${credTool}'`);
          issues++;
        } else if (cred.oauth.expiresAt) {
          const remaining = new Date(cred.oauth.expiresAt).getTime() - Date.now();
          const mins = Math.floor(remaining / 60000);
          if (mins < 10) {
            cli.warn(`  ${credTool}: OAuth token expires in ${mins} minute${mins === 1 ? "" : "s"}`);
            issues++;
          } else {
            cli.ok(`  ${credTool}: OAuth token valid (${mins}m remaining)`);
          }
        } else {
          cli.ok(`  ${credTool}: credential stored (${cred.authType})`);
        }
      } else {
        cli.ok(`  ${credTool}: credential stored (${cred.authType})`);
      }
    }
  }

  // Check 4: Config file parse health for all detected platforms
  cli.log(`\n${cli.BOLD}Config file health${cli.RESET}`);
  for (const [id, def] of PLATFORM_REGISTRY) {
    const configPath = def.configPath();
    if (!fileExists(configPath)) continue;

    checks++;
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      if (def.configFormat === "json") {
        JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        cli.ok(`  ${def.name}: valid JSON`);
      } else {
        cli.ok(`  ${def.name}: readable TOML`);
      }
    } catch {
      cli.fail(`  ${def.name}: config file is corrupt or unparseable (${sanitizePath(configPath)})`);
      issues++;
    }
  }

  // Check 5: Orphan hook entries — settings hooks pointing at missing scripts.
  // These accumulate when an augment that shipped hooks is uninstalled (or
  // transitions to hooks: null) and the platform settings file isn't reconciled.
  // Aborted test runs that wrote into the user's real settings show up here too.
  let orphanHeaderShown = false;
  for (const [id, def] of PLATFORM_REGISTRY) {
    if (!def.hooks) continue;
    const orphans = findOrphanHookEntries(id, { prune: options.fixOrphanHooks });
    if (orphans.length === 0) continue;

    if (!orphanHeaderShown) {
      cli.log(`\n${cli.BOLD}Orphan hook entries${cli.RESET}`);
      orphanHeaderShown = true;
    }
    checks++;
    if (options.fixOrphanHooks) {
      cli.ok(`  ${def.name}: pruned ${orphans.length} orphan entr${orphans.length === 1 ? "y" : "ies"}`);
      for (const o of orphans) {
        cli.log(`    ${cli.DIM}- ${o.event}: ${sanitizePath(o.scriptPath ?? o.command)}${cli.RESET}`);
      }
    } else {
      cli.warn(`  ${def.name}: ${orphans.length} hook entr${orphans.length === 1 ? "y points" : "ies point"} at missing scripts`);
      for (const o of orphans) {
        cli.log(`    ${cli.DIM}- ${o.event}: ${sanitizePath(o.scriptPath ?? o.command)}${cli.RESET}`);
      }
      cli.log(`    ${cli.DIM}Run 'equip doctor --fix-orphan-hooks' to remove them.${cli.RESET}`);
      issues++;
    }
  }

  // Cleanup B Pkg 06 batch 1: surface the .backup-pre-cleanup-b/ snapshot
  // if it exists. Informational, not an issue — but helps the user notice
  // the snapshot is sitting on disk eternally if they never run
  // `equip --discard-pre-cleanup-b-backup` after confirming the cutover.
  // Also: if the backup exists AND legacy files still exist, that's a
  // mid-cutover-failure signal — escalate to issue.
  const cutoverIncomplete = reportCleanupBBackup();
  if (cutoverIncomplete) issues++;

  // Summary
  cli.log("");
  if (issues === 0) {
    cli.log(`  ${cli.GREEN}${cli.BOLD}All ${checks} checks passed${cli.RESET}\n`);
  } else {
    cli.log(`  ${cli.YELLOW}${issues} issue${issues === 1 ? "" : "s"} found${cli.RESET} ${cli.DIM}(${checks} checks)${cli.RESET}\n`);
  }
}

/**
 * Surfaces the .backup-pre-cleanup-b/ snapshot informationally + escalates
 * to an issue when the cutover appears incomplete.
 *
 * Returns true if the cutover-incomplete condition fires (so the caller
 * can increment its issue counter).
 *
 * "Cutover incomplete" definition (architect condition 5, 2026-04-29):
 *   backup snapshot exists (cleanup was attempted at least once)
 *   AND legacy files still exist on disk
 *
 * The backup-existence gate is what differentiates "post-cutover-failed"
 * from "pre-cutover normal" (today, before batch 2 wires auto-firing).
 * Pre-cutover the backup doesn't exist → check doesn't fire. After a
 * successful cutover the backup exists but legacy is gone → check
 * doesn't fire. Only the failure case (backup exists + legacy lingered)
 * trips it.
 *
 * Note: `equip --restore-pre-cleanup-b` re-creates legacy files from the
 * backup, so the warning fires after a deliberate rollback. That's
 * acceptable — the user just ran a recovery operation; a "migration
 * appears incomplete" warning is genuinely informative there.
 */
function reportCleanupBBackup(): boolean {
  const home = require("../equip-home").getEquipHome();
  const backupDir = path.join(home, ".backup-pre-cleanup-b");
  if (!fs.existsSync(backupDir)) return false;

  let totalBytes = 0;
  let oldestMtimeMs = Date.now();
  function walk(dir: string): void {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        try {
          const st = fs.statSync(full);
          totalBytes += st.size;
          if (st.mtimeMs < oldestMtimeMs) oldestMtimeMs = st.mtimeMs;
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable dir */ }
  }
  walk(backupDir);

  const ageDays = Math.floor((Date.now() - oldestMtimeMs) / (1000 * 60 * 60 * 24));
  const sizeMb = (totalBytes / 1024 / 1024).toFixed(1);

  // Cutover-incomplete check: backup exists + legacy files still on disk.
  const legacyAugmentsDir = path.join(home, "augments");
  const legacyInstallationsFile = path.join(home, "installations.json");
  const legacyStillPresent = fs.existsSync(legacyAugmentsDir) || fs.existsSync(legacyInstallationsFile);

  if (legacyStillPresent) {
    cli.log(`\n${cli.BOLD}Cleanup B migration appears incomplete${cli.RESET}`);
    cli.warn(`  Legacy files present on disk despite Cleanup B snapshot at ~/.equip/.backup-pre-cleanup-b/.`);
    cli.log(`  ${cli.DIM}Re-run the sidecar (the schema-v4 migration retries on next boot), or run 'equip --restore-pre-cleanup-b' to roll back to the snapshot.${cli.RESET}`);
    cli.log(`  ${cli.DIM}Snapshot details: ${sizeMb} MB, ${ageDays} day${ageDays === 1 ? "" : "s"} old.${cli.RESET}`);
    return true;
  }

  cli.log(`\n${cli.BOLD}Pre-Cleanup-B snapshot${cli.RESET}`);
  cli.log(`  ${cli.DIM}~/.equip/.backup-pre-cleanup-b/  (${sizeMb} MB, ${ageDays} day${ageDays === 1 ? "" : "s"} old)${cli.RESET}`);
  cli.log(`  ${cli.DIM}Run 'equip --restore-pre-cleanup-b' to recover, or 'equip --discard-pre-cleanup-b-backup' to delete.${cli.RESET}`);
  return false;
}

function sanitizePath(p: string): string {
  const home = require("os").homedir();
  return p.replace(home, "~");
}
