// equip refresh [augment] — refresh expired OAuth tokens.

import { refreshCredential, refreshAllExpired } from "../auth-engine";
import { readStoredCredential, isCredentialExpired, listStoredCredentials } from "../auth-engine";
import { createConsoleLogger, type ParsedArgs } from "../cli";
import * as cli from "../cli";

export async function runRefresh(parsedArgs: ParsedArgs): Promise<void> {
  const logger = parsedArgs.verbose ? createConsoleLogger() : undefined;
  const toolName = parsedArgs._[0];

  if (toolName) {
    // Refresh a specific augment
    cli.log(`\n${cli.BOLD}equip refresh${cli.RESET} ${toolName}\n`);

    const cred = readStoredCredential(toolName);
    if (!cred) {
      cli.fail(`No stored credentials for ${toolName}`);
      process.exit(1);
    }

    if (!cred.oauth || !cred.oauth.refreshToken) {
      cli.fail(`${toolName} has no OAuth refresh token — use 'equip reauth ${toolName}' instead`);
      process.exit(1);
    }

    const expired = isCredentialExpired(cred);
    if (!expired) {
      cli.ok(`${toolName}: OAuth token is still valid`);
      if (cred.oauth.expiresAt) {
        const remaining = new Date(cred.oauth.expiresAt).getTime() - Date.now();
        const mins = Math.floor(remaining / 60000);
        cli.log(`  ${cli.DIM}Expires in ${mins} minute${mins === 1 ? "" : "s"}${cli.RESET}`);
      }
      return;
    }

    const result = await refreshCredential(toolName, { logger, updateConfigs: true });
    if (result.success) {
      cli.ok(`${toolName}: token refreshed`);
      if (result.configsUpdated && result.configsUpdated > 0) {
        cli.ok(`${result.configsUpdated} platform config${result.configsUpdated === 1 ? "" : "s"} updated`);
      }
    } else {
      cli.fail(`${toolName}: ${result.error}`);
      cli.log(`  ${cli.DIM}Try: equip reauth ${toolName}${cli.RESET}`);
    }
  } else {
    // Refresh all expired credentials
    cli.log(`\n${cli.BOLD}equip refresh${cli.RESET}\n`);

    const tools = listStoredCredentials();
    if (tools.length === 0) {
      cli.log(`  ${cli.DIM}No stored credentials found.${cli.RESET}\n`);
      return;
    }

    let anyExpired = false;
    for (const name of tools) {
      const cred = readStoredCredential(name);
      if (!cred || !cred.oauth?.refreshToken) continue;
      if (!isCredentialExpired(cred)) {
        cli.ok(`${name}: token valid`);
        continue;
      }

      anyExpired = true;
      const result = await refreshCredential(name, { logger, updateConfigs: true });
      if (result.success) {
        cli.ok(`${name}: token refreshed${result.configsUpdated ? ` (${result.configsUpdated} config${result.configsUpdated === 1 ? "" : "s"} updated)` : ""}`);
      } else {
        cli.fail(`${name}: ${result.error}`);
        cli.log(`  ${cli.DIM}Try: equip reauth ${name}${cli.RESET}`);
      }
    }

    if (!anyExpired) {
      cli.log(`  ${cli.DIM}All tokens are current.${cli.RESET}`);
    }
  }
  cli.log("");
}

/**
 * Auto-refresh expired OAuth tokens. Best effort — errors are swallowed.
 * Called on every CLI invocation (except refresh/reauth themselves).
 */
export async function autoRefreshExpired(verbose: boolean): Promise<void> {
  try {
    const logger = verbose ? createConsoleLogger() : undefined;
    const results = await refreshAllExpired({ logger });

    if (results.size > 0 && !verbose) {
      for (const [name, result] of results) {
        if (result.success) {
          cli.ok(`Auto-refreshed token for ${name}`);
        }
      }
    }
  } catch { /* best effort — don't block the command */ }
}
