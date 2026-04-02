// File I/O utilities — atomic writes, safe reads, package resolution.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";

// ─── Atomic Write ───────────────────────────────────────────

/**
 * Write a file atomically: write to a .tmp file, then rename over the target.
 * On most filesystems, rename is atomic — the file is never partially written.
 * Creates parent directories if they don't exist.
 *
 * On Windows, rename can fail with EPERM when the target is held open by another
 * process (e.g., an IDE file watcher). In that case, falls back to direct write
 * with a retry — less atomic but avoids hard failures on locked files.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = filePath + ".tmp";
  // Create with restrictive permissions first, then write content.
  // This prevents a window where the .tmp file has default (world-readable) permissions.
  fs.writeFileSync(tmp, "");
  if (process.platform !== "win32") {
    try { fs.chmodSync(tmp, 0o600); } catch {}
  }
  fs.writeFileSync(tmp, content);

  try {
    fs.renameSync(tmp, filePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" && process.platform === "win32") {
      // Target file is locked by another process (e.g., IDE file watcher).
      // Fall back to direct write — less atomic but avoids hard failure.
      try { fs.unlinkSync(tmp); } catch {}
      fs.writeFileSync(filePath, content);
    } else {
      throw err;
    }
  }
}

// ─── Process Lockfile ────────────────────────────────────────

import * as os from "os";

const LOCK_STALE_MS = 60_000; // consider lock stale after 60 seconds
let lockDepth = 0; // re-entrancy counter for same-process calls

function lockPath(): string { return path.join(os.homedir(), ".equip", ".lock"); }

/**
 * Acquire a simple process-level lock. Prevents concurrent equip operations
 * from racing on shared state files. The lock is advisory — it won't block
 * a determined caller, but it prevents accidental concurrent runs.
 *
 * Re-entrant within the same process (nested calls increment a counter).
 * Returns a release function. Call it when done.
 * Throws if the lock is already held by another process.
 */
export function acquireLock(): () => void {
  // Re-entrant: if we already hold the lock, just bump the counter
  if (lockDepth > 0) {
    lockDepth++;
    return () => { lockDepth--; };
  }

  const lp = lockPath();
  const dir = path.dirname(lp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const lockContent = JSON.stringify({ pid: process.pid, timestamp: Date.now() });

  // Try atomic exclusive creation (eliminates TOCTOU race)
  try {
    fs.writeFileSync(lp, lockContent, { flag: "wx" });
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw e;

    // Lock file exists — check if it's stale or held by a dead process
    try {
      const raw = fs.readFileSync(lp, "utf-8");
      const lock = JSON.parse(raw);
      const age = Date.now() - (lock.timestamp || 0);

      if (lock.pid === process.pid) {
        // We hold it (leftover from crash) — reclaim
      } else if (age >= LOCK_STALE_MS) {
        // Lock is stale — reclaim
      } else {
        // Check if the holding process is still alive
        try {
          process.kill(lock.pid, 0);
          throw new Error(`Another equip process is running (PID ${lock.pid}). Wait for it to finish or delete ~/.equip/.lock`);
        } catch (killErr: any) {
          if (killErr.code !== "ESRCH") throw killErr;
          // Process is dead — lock is stale, reclaim
        }
      }
    } catch (readErr: any) {
      if (readErr.message?.includes("Another equip process")) throw readErr;
      // File is corrupt or disappeared — proceed to overwrite
    }

    // Overwrite the stale/dead lock
    fs.writeFileSync(lp, lockContent);
  }

  lockDepth = 1;

  // Return release function
  return () => {
    lockDepth--;
    if (lockDepth === 0) {
      try { fs.unlinkSync(lockPath()); } catch {}
    }
  };
}

// ─── Safe JSON Read ─────────────────────────────────────────

export interface SafeJsonResult {
  /** The parsed data, or null if the file doesn't exist or is unreadable */
  data: Record<string, unknown> | null;
  /** "ok" = parsed successfully, "missing" = ENOENT, "unreadable" = exists but can't read (EACCES etc), "corrupt" = read but unparseable */
  status: "ok" | "missing" | "unreadable" | "corrupt";
  /** Error message when status is "corrupt" or "unreadable" */
  error?: string;
}

/**
 * Read and parse a JSON file, distinguishing "missing" from "corrupt".
 * Handles BOM-prefixed files.
 */
export function safeReadJsonSync(filePath: string): SafeJsonResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { data: null, status: "missing" };
    }
    return { data: null, status: "unreadable", error: `Cannot read file: ${(err as Error).message}` };
  }

  // Strip BOM
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { data: null, status: "corrupt", error: "File contains valid JSON but is not an object" };
    }
    return { data: parsed as Record<string, unknown>, status: "ok" };
  } catch (err: unknown) {
    return { data: null, status: "corrupt", error: `Invalid JSON: ${(err as Error).message}` };
  }
}

// ─── Backup Management ──────────────────────────────────────

/**
 * Create a backup of a file before modifying it.
 * Returns true if backup was created, false if source doesn't exist.
 */
export function createBackup(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.copyFileSync(filePath, filePath + ".bak");
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove backup file after a successful write.
 * Call this only after verifying the new file is valid.
 */
export function cleanupBackup(filePath: string): void {
  try {
    fs.unlinkSync(filePath + ".bak");
  } catch { /* backup may not exist */ }
}

// ─── Package Version Resolution ─────────────────────────────

/**
 * Find the equip package version by walking up from the given directory
 * until a package.json with name "@cg3/equip" is found.
 * Falls back to any package.json if the name doesn't match.
 */
export function resolvePackageVersion(startDir: string): string {
  let dir = startDir;
  const root = path.parse(dir).root;

  while (dir !== root) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.name === "@cg3/equip" && pkg.version) {
        return pkg.version;
      }
    } catch { /* keep walking */ }
    dir = path.dirname(dir);
  }

  return "unknown";
}
