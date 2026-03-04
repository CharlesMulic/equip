// CLI output helpers, prompts, and clipboard.
// Zero dependencies.

"use strict";

const os = require("os");
const readline = require("readline");

// ─── Colors ──────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// ─── Output ──────────────────────────────────────────────────

function log(msg = "") { process.stderr.write(msg + "\n"); }
function ok(msg) { log(`  ${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { log(`  ${RED}✗${RESET} ${msg}`); }
function warn(msg) { log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function info(msg) { log(`  ${CYAN}ⓘ${RESET} ${msg}`); }
function step(n, total, title) { log(`\n${BOLD}[${n}/${total}] ${title}${RESET}`); }

// ─── Prompts ─────────────────────────────────────────────────

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

/**
 * Prompt that resolves on Enter (true) or Esc (false).
 * Falls back to readline if stdin isn't a TTY.
 */
function promptEnterOrEsc(question) {
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
    const onData = (key) => {
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

function copyToClipboard(text) {
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

function sanitizeError(msg) {
  return msg.replace(os.homedir(), "~");
}

module.exports = {
  GREEN, RED, YELLOW, CYAN, BOLD, DIM, RESET,
  log, ok, fail, warn, info, step,
  prompt, promptEnterOrEsc,
  copyToClipboard,
  sanitizeError,
};
