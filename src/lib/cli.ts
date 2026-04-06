// CLI output helpers, prompts, and clipboard.
// Zero dependencies.

import * as fs from "fs";
import * as os from "os";
import * as readline from "readline";

// ─── Colors ──────────────────────────────────────────────────

export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";

// ─── Output ──────────────────────────────────────────────────

export function log(msg = ""): void { process.stderr.write(msg + "\n"); }
export function ok(msg: string): void { log(`  ${GREEN}✓${RESET} ${msg}`); }
export function fail(msg: string): void { log(`  ${RED}✗${RESET} ${msg}`); }
export function warn(msg: string): void { log(`  ${YELLOW}⚠${RESET} ${msg}`); }
export function info(msg: string): void { log(`  ${CYAN}ⓘ${RESET} ${msg}`); }
export function step(n: number, total: number, title: string): void { log(`\n${BOLD}[${n}/${total}] ${title}${RESET}`); }

// ─── Prompts ─────────────────────────────────────────────────

export function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

/** Prompt for sensitive input — suppresses echo so the value isn't visible on screen. */
export function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY && stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    let input = "";
    const onData = (chunk: Buffer) => {
      const ch = chunk.toString();
      if (ch === "\r" || ch === "\n") {
        stdin.removeListener("data", onData);
        if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
        process.stderr.write("\n");
        resolve(input.trim());
      } else if (ch === "\u0003") { // Ctrl+C
        stdin.removeListener("data", onData);
        if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") { // backspace
        input = input.slice(0, -1);
      } else {
        input += ch;
      }
    };
    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * Prompt that resolves on Enter (true) or Esc (false).
 * Falls back to readline if stdin isn't a TTY.
 */
export function promptEnterOrEsc(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      rl.question("", (answer) => { rl.close(); resolve(answer.toLowerCase() !== "n"); });
      return;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    const cleanup = (): void => {
      process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener("data", onData);
    };
    const onData = (key: string): void => {
      // On Windows, Enter may arrive as "\r\n" in a single chunk — use includes() not ===
      if (key.includes("\x1b")) {
        cleanup(); process.stderr.write("\n"); resolve(false);
      } else if (key.includes("\r") || key.includes("\n")) {
        cleanup(); process.stderr.write("\n"); resolve(true);
      } else if (key.includes("\x03")) {
        cleanup(); process.stderr.write("\n"); process.exit(0);
      }
      // else: ignore unrecognized keys, keep listening
    };
    process.stdin.on("data", onData);
  });
}

// ─── Logger ─────────────────────────────────────────────────

import type { EquipLogger } from "./types";

/**
 * Create a console logger that writes to stderr with color coding.
 * Used by CLI commands when --verbose is passed.
 */
export function createConsoleLogger(): EquipLogger {
  return {
    debug(msg: string, ctx?: Record<string, unknown>) { process.stderr.write(`  ${DIM}[debug] ${msg}${ctx ? " " + JSON.stringify(ctx) : ""}${RESET}\n`); },
    info(msg: string, ctx?: Record<string, unknown>) { process.stderr.write(`  [info] ${msg}${ctx ? " " + JSON.stringify(ctx) : ""}\n`); },
    warn(msg: string, ctx?: Record<string, unknown>) { process.stderr.write(`  ${YELLOW}[warn] ${msg}${ctx ? " " + JSON.stringify(ctx) : ""}${RESET}\n`); },
    error(msg: string, ctx?: Record<string, unknown>) { process.stderr.write(`  ${RED}[error] ${msg}${ctx ? " " + JSON.stringify(ctx) : ""}${RESET}\n`); },
  };
}

// ─── Utilities ───────────────────────────────────────────────

export function sanitizeError(msg: string): string {
  return msg.replace(os.homedir(), "~");
}

// ─── Parsed CLI Args ────────────────────────────────────────

export interface ParsedArgs {
  _: string[];
  verbose: boolean;
  dryRun: boolean;
  apiKey: string | null;
  nonInteractive: boolean;
  platform: string | null;
}

/** Parse CLI argv into structured args. Flags are consumed; positional args go to `_`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { _: [], verbose: false, dryRun: false, apiKey: null, nonInteractive: false, platform: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verbose") { args.verbose = true; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--non-interactive") { args.nonInteractive = true; }
    else if (a === "--api-key" && i + 1 < argv.length) { args.apiKey = argv[++i]; }
    else if (a === "--api-key-file" && i + 1 < argv.length) {
      try { args.apiKey = fs.readFileSync(argv[++i], "utf-8").trim(); }
      catch (e) { process.stderr.write(`Error reading API key file: ${(e as Error).message}\n`); process.exit(1); }
    }
    else if (a === "--platform" && i + 1 < argv.length) { args.platform = argv[++i]; }
    else { args._.push(a); }
  }
  return args;
}

/** Check if argument looks like a local file/directory path rather than a registry name. */
export function isLocalPath(arg: string): boolean {
  return arg.startsWith("./") || arg.startsWith("../") || arg.startsWith("/")
    || arg.startsWith(".\\") || arg.startsWith("..\\")
    || arg === "."
    || arg.endsWith(".js");
}
