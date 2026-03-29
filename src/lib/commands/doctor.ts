// equip doctor — validate config integrity and detect drift.

import * as fs from "fs";
import { PLATFORM_REGISTRY } from "../platforms";
import { readMcpEntry } from "../mcp";
import { readState } from "../state";
import { dirExists, fileExists } from "../detect";
import * as cli from "../cli";

export function runDoctor(): void {
  cli.log(`\n${cli.BOLD}equip doctor${cli.RESET}\n`);

  const state = readState();
  let issues = 0;
  let checks = 0;

  // Check 1: State file exists
  checks++;
  if (!state.lastUpdated && Object.keys(state.tools).length === 0) {
    cli.warn("No equip state found — run 'equip update' to initialize");
    issues++;
  } else {
    cli.ok("State file present");
  }

  // Check 2: For each tracked tool × platform, verify config exists
  const toolNames = Object.keys(state.tools);
  if (toolNames.length === 0) {
    cli.log(`\n  ${cli.DIM}No tracked tools to check.${cli.RESET}`);
    cli.log(`  ${cli.DIM}Install a tool (e.g. 'equip prior') to start tracking.${cli.RESET}\n`);
    return;
  }

  cli.log(`\n${cli.BOLD}Checking tracked tools${cli.RESET}`);

  for (const toolName of toolNames) {
    const tool = state.tools[toolName];
    cli.log(`\n  ${cli.BOLD}${toolName}${cli.RESET} ${cli.DIM}(${tool.package})${cli.RESET}`);

    for (const [platformId, record] of Object.entries(tool.platforms)) {
      checks++;
      const def = PLATFORM_REGISTRY.get(platformId);
      if (!def) {
        cli.fail(`  ${platformId}: unknown platform (may have been removed)`);
        issues++;
        continue;
      }

      const configPath = record.configPath || def.configPath();

      // Check config file exists
      if (!fileExists(configPath)) {
        cli.fail(`  ${def.name}: config file missing (${sanitizePath(configPath)})`);
        issues++;
        continue;
      }

      // Check tool entry is present in config
      const entry = readMcpEntry(configPath, def.rootKey, toolName, def.configFormat);
      if (!entry) {
        cli.fail(`  ${def.name}: "${toolName}" entry missing from config (drift detected)`);
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

      // Check rules if tracked
      let rulesOk = true;
      if (record.rulesVersion) {
        checks++;
        const rulesPath = record.rulesPath || (def.rulesPath ? def.rulesPath() : null);
        if (!rulesPath) {
          cli.ok(`  ${def.name}: config present (no rules path)`);
          rulesOk = false;
        } else {
          try {
            const rulesContent = fs.readFileSync(rulesPath, "utf-8");
            const versionMatch = rulesContent.match(new RegExp(`<!-- ${toolName}:v([0-9.]+) -->`));
            if (!versionMatch) {
              cli.warn(`  ${def.name}: rules block not found in ${sanitizePath(rulesPath)}`);
              issues++;
              rulesOk = false;
            } else if (versionMatch[1] !== record.rulesVersion) {
              cli.warn(`  ${def.name}: rules version mismatch (installed: v${versionMatch[1]}, expected: v${record.rulesVersion})`);
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
      if (record.hookDir && record.hookScripts && record.hookScripts.length > 0) {
        checks++;
        for (const script of record.hookScripts) {
          const scriptPath = require("path").join(record.hookDir, script);
          if (!fileExists(scriptPath)) {
            cli.warn(`  ${def.name}: hook script missing (${sanitizePath(scriptPath)})`);
            issues++;
            hooksOk = false;
          }
        }
      }

      // Summary line for this platform
      const parts: string[] = ["config"];
      if (record.rulesVersion && rulesOk) parts.push(`rules v${record.rulesVersion}`);
      if (record.hookScripts && record.hookScripts.length > 0 && hooksOk) parts.push(`${record.hookScripts.length} hook${record.hookScripts.length === 1 ? "" : "s"}`);
      if (rulesOk && hooksOk) {
        cli.ok(`  ${def.name}: ${parts.join(" + ")}`);
      }
    }
  }

  // Check 3: Config file parse health for all detected platforms
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
