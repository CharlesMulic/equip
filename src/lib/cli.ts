// CLI output helpers, prompts, and clipboard.
// Zero dependencies.

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
    const onData = (key: string): void => {
      if (key === "\x1b") {
        process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener("data", onData);
        process.stderr.write("\n"); resolve(false);
      } else if (key === "\r" || key === "\n") {
        process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener("data", onData);
        process.stderr.write("\n"); resolve(true);
      } else if (key === "\x03") {
        process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener("data", onData);
        process.stderr.write("\n"); process.exit(0);
      }
      // else: ignore unrecognized keys, keep listening
    };
    process.stdin.on("data", onData);
  });
}

// ─── Clipboard ───────────────────────────────────────────────

export function copyToClipboard(text: string): boolean {
  try {
    const cp = require("child_process");
    if (process.platform === "darwin") {
      cp.execSync("pbcopy", { input: text, timeout: 3000 });
    } else if (process.platform === "win32") {
      cp.execSync("clip", { input: text, timeout: 3000 });
    } else {
      try { cp.execSync("xclip -selection clipboard", { input: text, timeout: 3000 }); }
      catch { try { cp.execSync("xsel --clipboard --input", { input: text, timeout: 3000 }); }
      catch { cp.execSync("wl-copy", { input: text, timeout: 3000 }); } }
    }
    return true;
  } catch { return false; }
}

// ─── Utilities ───────────────────────────────────────────────

export function sanitizeError(msg: string): string {
  return msg.replace(os.homedir(), "~");
}
