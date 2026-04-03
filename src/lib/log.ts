// File-based logger for Equip.
// Writes structured log lines to ~/.equip/equip.log.
// Used by both CLI (--verbose or always-on) and sidecar (desktop app).
// Zero non-Node dependencies.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { EquipLogger } from "./types";

// ─── Constants ──────────────────────────────────────────────

const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2 MB — rotate when exceeded
const LOG_FILENAME = "equip.log";
const OLD_LOG_FILENAME = "equip.log.1";

// ─── Paths ──────────────────────────────────────────────────

function equipDir(): string { return path.join(os.homedir(), ".equip"); }
function logPath(): string { return path.join(equipDir(), LOG_FILENAME); }
function oldLogPath(): string { return path.join(equipDir(), OLD_LOG_FILENAME); }

// ─── Rotation ───────────────────────────────────────────────

function rotateIfNeeded(): void {
  try {
    const p = logPath();
    const stat = fs.statSync(p);
    if (stat.size > MAX_LOG_SIZE) {
      // Keep one old log file
      try { fs.unlinkSync(oldLogPath()); } catch {}
      fs.renameSync(p, oldLogPath());
    }
  } catch {
    // File doesn't exist yet — nothing to rotate
  }
}

// ─── Format ─────────────────────────────────────────────────

function formatLine(level: string, msg: string, ctx?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const ctxStr = ctx ? " " + JSON.stringify(ctx) : "";
  return `${ts} [${level}] ${msg}${ctxStr}\n`;
}

// ─── File Logger ────────────────────────────────────────────

/**
 * Create a logger that appends to ~/.equip/equip.log.
 * Rotates at 2 MB (keeps one backup). Best-effort — never throws.
 */
export function createFileLogger(): EquipLogger {
  // Ensure directory exists and rotate on startup
  try {
    const dir = equipDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded();
  } catch {}

  function write(level: string, msg: string, ctx?: Record<string, unknown>): void {
    try {
      fs.appendFileSync(logPath(), formatLine(level, msg, ctx));
    } catch {}
  }

  return {
    debug(msg, ctx) { write("DEBUG", msg, ctx); },
    info(msg, ctx) { write("INFO", msg, ctx); },
    warn(msg, ctx) { write("WARN", msg, ctx); },
    error(msg, ctx) { write("ERROR", msg, ctx); },
  };
}

/**
 * Create a composite logger that fans out to multiple loggers.
 * Useful for logging to both file and console simultaneously.
 */
export function createCompositeLogger(...loggers: EquipLogger[]): EquipLogger {
  return {
    debug(msg, ctx) { for (const l of loggers) l.debug(msg, ctx); },
    info(msg, ctx) { for (const l of loggers) l.info(msg, ctx); },
    warn(msg, ctx) { for (const l of loggers) l.warn(msg, ctx); },
    error(msg, ctx) { for (const l of loggers) l.error(msg, ctx); },
  };
}
