// File I/O utilities — atomic writes, safe reads, package resolution.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";

// ─── Atomic Write ───────────────────────────────────────────

/**
 * Write a file atomically: write to a .tmp file, then rename over the target.
 * On most filesystems, rename is atomic — the file is never partially written.
 * Creates parent directories if they don't exist.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// ─── Safe JSON Read ─────────────────────────────────────────

export interface SafeJsonResult {
  /** The parsed data, or null if the file doesn't exist */
  data: Record<string, unknown> | null;
  /** "ok" = parsed successfully, "missing" = file doesn't exist, "corrupt" = exists but unparseable */
  status: "ok" | "missing" | "corrupt";
  /** Error message when status is "corrupt" */
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
    return { data: null, status: "corrupt", error: `Cannot read file: ${(err as Error).message}` };
  }

  // Strip BOM
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
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
