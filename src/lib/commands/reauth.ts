// equip reauth <augment> — re-authenticate and rotate credentials.

import { Augment } from "../../index";
import { fetchToolDef, toolDefToEquipConfig } from "../registry";
import { platformName } from "../platforms";
import { resolveAuth, deleteStoredCredential } from "../auth-engine";
import { createConsoleLogger, type ParsedArgs } from "../cli";
import * as cli from "../cli";

export async function runReauth(parsedArgs: ParsedArgs): Promise<void> {
  const toolName = parsedArgs._[0];
  if (!toolName) {
    process.stderr.write("Usage: equip reauth <augment>\n");
    process.exit(1);
  }

  const logger = parsedArgs.verbose ? createConsoleLogger() : undefined;

  cli.log(`\n${cli.BOLD}equip reauth${cli.RESET} ${toolName}\n`);

  const toolDef = await fetchToolDef(toolName, { logger });
  if (!toolDef) {
    cli.fail(`Augment "${toolName}" not found in registry`);
    process.exit(1);
  }

  const authConfig = toolDef.auth || (toolDef.requiresAuth ? { type: "api_key" as const } : null);
  if (!authConfig || authConfig.type === "none") {
    cli.fail(`${toolName} does not require authentication`);
    process.exit(1);
  }

  // Delete stored credential to force fresh auth
  deleteStoredCredential(toolName);
  cli.log("  Cleared stored credentials");

  const authResult = await resolveAuth({
    toolName,
    auth: authConfig,
    logger,
    apiKey: parsedArgs.apiKey,
    nonInteractive: parsedArgs.nonInteractive,
  });

  if (!authResult.credential) {
    cli.fail(authResult.error || "Re-authentication failed");
    process.exit(1);
  }

  cli.ok(`New credential obtained ${cli.DIM}(${authResult.method})${cli.RESET}`);

  // Update all platform configs with the new credential
  if (toolDef.installMode === "direct" && toolDef.serverUrl) {
    const config = toolDefToEquipConfig(toolDef, { logger });
    const equip = new Augment(config);
    const platforms = equip.detect();
    const transport = toolDef.transport || "http";

    cli.log("\n  Updating platform configs...");
    for (const p of platforms) {
      const entry = equip.readMcp(p);
      if (entry) {
        equip.updateMcpKey(p, authResult.credential, transport);
        cli.ok(`${platformName(p.platform)} updated`);
      }
    }
  }

  cli.log(`\n${cli.BOLD}Done.${cli.RESET} Credentials rotated for ${toolName}.\n`);
}
