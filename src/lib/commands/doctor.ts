// equip doctor — validate config integrity and detect drift.

import * as fs from "fs";
import * as path from "path";
import { PLATFORM_REGISTRY } from "../platforms";
import { readMcpEntry } from "../mcp";
import { readInstallations } from "../installations";
import { dirExists, fileExists } from "../detect";
import * as cli from "../cli";
import { checkAuth } from "../auth";
import { readStoredCredential, isCredentialExpired, listStoredCredentials } from "../auth-engine";

export function runDoctor(): void {
  cli.log(`\n${cli.BOLD}equip doctor${cli.RESET}\n`);

  const installations = readInstallations();
  let issues = 0;
  let checks = 0;

  // Check 1: Installations file exists
  checks++;
  if (!installations.lastUpdated && Object.keys(installations.augments).length === 0) {
    cli.warn("No equip state found — run 'equip update' to initialize");
    issues++;
  } else {
    cli.ok("Installation records present");
  }

  // Check 2: For each tracked augment × platform, verify config exists
  const augmentNames = Object.keys(installations.augments);
  if (augmentNames.length === 0) {
    cli.log(`\n  ${cli.DIM}No tracked augments to check.${cli.RESET}`);
    cli.log(`  ${cli.DIM}Install an augment (e.g. 'equip prior') to start tracking.${cli.RESET}\n`);
    return;
  }

  cli.log(`\n${cli.BOLD}Checking tracked augments${cli.RESET}`);

  for (const augmentName of augmentNames) {
    const record = installations.augments[augmentName];
    cli.log(`\n  ${cli.BOLD}${augmentName}${cli.RESET} ${cli.DIM}(${record.displayName})${cli.RESET}`);

    for (const platformId of record.platforms) {
      checks++;
      const def = PLATFORM_REGISTRY.get(platformId);
      if (!def) {
        cli.fail(`  ${platformId}: unknown platform (may have been removed)`);
        issues++;
        continue;
      }

      const configPath = def.configPath();
      const artifacts = record.artifacts[platformId] || {};

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

        // Check URL is HTTPS
        const url = (entry as Record<string, unknown>).url || (entry as Record<string, unknown>).serverUrl || (entry as Record<string, unknown>).httpUrl;
        if (url && typeof url === "string" && !url.startsWith("https://") && !url.startsWith("http://localhost")) {
          checks++;
          cli.warn(`  ${def.name}: server URL is not HTTPS (${url})`);
          issues++;
        }

        // Check auth headers
        if (record.transport === "http") {
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
      if (artifacts.mcp) parts.push("config");
      if (artifacts.rules && rulesOk) parts.push(`rules v${artifacts.rules}`);
      if (artifacts.hooks && artifacts.hooks.length > 0 && hooksOk) parts.push(`${artifacts.hooks.length} hook${artifacts.hooks.length === 1 ? "" : "s"}`);
      if (artifacts.skills && artifacts.skills.length > 0 && skillsOk) parts.push(`${artifacts.skills.length} skill${artifacts.skills.length === 1 ? "" : "s"}`);
      if (rulesOk && hooksOk && skillsOk) {
        cli.ok(`  ${def.name}: ${parts.join(" + ") || "present"}`);
      }
    }
  }

  // Check 3: Stored credential health
  const credTools = listStoredCredentials();
  if (credTools.length > 0) {
    cli.log(`\n${cli.BOLD}Credential health${cli.RESET}`);
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

  // Summary
  cli.log("");
  if (issues === 0) {
    cli.log(`  ${cli.GREEN}${cli.BOLD}All ${checks} checks passed${cli.RESET}\n`);
  } else {
    cli.log(`  ${cli.YELLOW}${issues} issue${issues === 1 ? "" : "s"} found${cli.RESET} ${cli.DIM}(${checks} checks)${cli.RESET}\n`);
  }
}

function sanitizePath(p: string): string {
  const home = require("os").homedir();
  return p.replace(home, "~");
}
