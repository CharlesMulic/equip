// equip loadout - local loadout store commands.

import {
  deleteLoadout,
  duplicateLoadout,
  getLoadout,
  getLoadoutProjection,
  migrateLegacySets,
  renameLoadout,
  saveCurrentLoadout,
  clearActiveLoadout,
  setActiveLoadout,
} from "../loadouts";
import * as cli from "../cli";
import type { ParsedArgs } from "../cli";

function usage(): void {
  process.stderr.write([
    "Usage: equip loadout <command> [args]",
    "",
    "Commands:",
    "  list                     List saved loadouts",
    "  show <id-or-name>        Show a saved loadout",
    "  save <name>              Save the current equipped augments",
    "  rename <id-or-name> <n>  Rename a loadout",
    "  duplicate <id-or-name> <n>  Duplicate a loadout",
    "  delete <id-or-name>      Delete a loadout",
    "  set-active <id-or-name>  Mark a loadout active without applying",
    "  clear-active             Clear active loadout state",
    "  migrate-legacy           Import legacy app-side sets",
    "",
  ].join("\n"));
}

export function runLoadout(parsedArgs: ParsedArgs): void {
  const subcommand = parsedArgs._[0] ?? "list";
  const args = parsedArgs._.slice(1);

  try {
    switch (subcommand) {
      case "list":
        return list(parsedArgs);
      case "show":
        return show(args[0], parsedArgs);
      case "save":
        return save(args[0], parsedArgs);
      case "rename":
        return rename(args[0], args[1], parsedArgs);
      case "duplicate":
        return duplicate(args[0], args[1], parsedArgs);
      case "delete":
        return remove(args[0], parsedArgs);
      case "set-active":
        return setActive(args[0], parsedArgs);
      case "clear-active":
        return clearActive(parsedArgs);
      case "migrate-legacy":
        return migrate(parsedArgs);
      case "--help":
      case "-h":
      case "help":
        usage();
        return;
      default:
        cli.fail(`Unknown loadout command: ${subcommand}`);
        usage();
        process.exit(1);
    }
  } catch (error) {
    cli.fail((error as Error).message);
    process.exit(1);
  }
}

function list(parsedArgs: ParsedArgs): void {
  const projection = getLoadoutProjection();
  if (parsedArgs.json) {
    process.stdout.write(JSON.stringify(projection, null, 2) + "\n");
    return;
  }

  cli.log(`\n${cli.BOLD}equip loadout list${cli.RESET}\n`);
  if (projection.loadouts.length === 0) {
    cli.log(`  ${cli.DIM}No saved loadouts.${cli.RESET}`);
    cli.log(`  ${cli.DIM}Save the current equipped augments with: equip loadout save <name>${cli.RESET}\n`);
    return;
  }

  for (const loadout of projection.loadouts) {
    const active = loadout.active
      ? loadout.modified ? ` ${cli.YELLOW}modified${cli.RESET}` : ` ${cli.GREEN}active${cli.RESET}`
      : "";
    cli.log(`  ${loadout.name.padEnd(24)} ${loadout.entryCount} augment${loadout.entryCount === 1 ? "" : "s"}${active}`);
    cli.log(`  ${cli.DIM}${loadout.id}${cli.RESET}`);
  }
  cli.log("");
}

function show(ref: string | undefined, parsedArgs: ParsedArgs): void {
  if (!ref) {
    usage();
    process.exit(1);
  }
  const loadout = getLoadout(ref);
  if (!loadout) {
    cli.fail(`Loadout not found: ${ref}`);
    process.exit(1);
  }
  if (parsedArgs.json) {
    process.stdout.write(JSON.stringify(loadout, null, 2) + "\n");
    return;
  }
  cli.log(`\n${cli.BOLD}${loadout.name}${cli.RESET}`);
  cli.log(`  ${cli.DIM}${loadout.id}${cli.RESET}`);
  cli.log("");
  for (const entry of loadout.entries) {
    const disabled = entry.enabled ? "" : ` ${cli.DIM}(disabled)${cli.RESET}`;
    cli.log(`  ${entry.augmentName}${disabled}`);
  }
  cli.log("");
}

function save(name: string | undefined, parsedArgs: ParsedArgs): void {
  if (!name) {
    usage();
    process.exit(1);
  }
  const loadout = saveCurrentLoadout({ name });
  if (parsedArgs.json) {
    process.stdout.write(JSON.stringify(loadout, null, 2) + "\n");
    return;
  }
  cli.ok(`Saved loadout "${loadout.name}" (${loadout.entries.length} augment${loadout.entries.length === 1 ? "" : "s"})`);
}

function rename(ref: string | undefined, newName: string | undefined, parsedArgs: ParsedArgs): void {
  if (!ref || !newName) {
    usage();
    process.exit(1);
  }
  const loadout = renameLoadout(ref, newName);
  if (parsedArgs.json) {
    process.stdout.write(JSON.stringify(loadout, null, 2) + "\n");
    return;
  }
  cli.ok(`Renamed loadout to "${loadout.name}"`);
}

function duplicate(ref: string | undefined, newName: string | undefined, parsedArgs: ParsedArgs): void {
  if (!ref || !newName) {
    usage();
    process.exit(1);
  }
  const loadout = duplicateLoadout(ref, newName);
  if (parsedArgs.json) {
    process.stdout.write(JSON.stringify(loadout, null, 2) + "\n");
    return;
  }
  cli.ok(`Duplicated loadout as "${loadout.name}"`);
}

function remove(ref: string | undefined, parsedArgs: ParsedArgs): void {
  if (!ref) {
    usage();
    process.exit(1);
  }
  const result = deleteLoadout(ref);
  if (parsedArgs.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (result.deleted) cli.ok(result.activeCleared ? "Loadout deleted; active loadout cleared" : "Loadout deleted");
  else cli.warn("Loadout not found");
}

function setActive(ref: string | undefined, parsedArgs: ParsedArgs): void {
  if (!ref) {
    usage();
    process.exit(1);
  }
  const state = setActiveLoadout(ref);
  if (parsedArgs.json) {
    process.stdout.write(JSON.stringify(state, null, 2) + "\n");
    return;
  }
  cli.ok("Active loadout updated");
}

function clearActive(parsedArgs: ParsedArgs): void {
  const state = clearActiveLoadout();
  if (parsedArgs.json) {
    process.stdout.write(JSON.stringify(state, null, 2) + "\n");
    return;
  }
  cli.ok("Active loadout cleared");
}

function migrate(parsedArgs: ParsedArgs): void {
  const result = migrateLegacySets();
  if (parsedArgs.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  cli.ok(`Migrated ${result.migrated} legacy set${result.migrated === 1 ? "" : "s"}`);
}
