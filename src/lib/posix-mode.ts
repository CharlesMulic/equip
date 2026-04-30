// POSIX-mode-only helper.
//
// Background: Node.js `fs.writeFileSync({ mode: 0o600 })` on Windows creates
// a "protected" DACL with zero access entries — Windows interprets that as
// deny-all, even for the file owner. Effect: any file written this way
// becomes inaccessible to the very process that wrote it (and to the user).
//
// The fix: pass `mode: undefined` on Windows so the file inherits the
// parent directory's ACL (which on a normal user profile grants the user
// Full Control). The POSIX bit-restriction guarantees survive on Linux/macOS;
// Windows file-permission hygiene is a separate concern handled at the
// directory level by the OS.
//
// Usage: `fs.writeFileSync(p, data, { encoding: "utf-8", mode: posixMode(0o600) })`.
// On Windows the mode property becomes `undefined` and Node treats it as
// "use default."

const IS_POSIX = process.platform !== "win32";

/**
 * Returns the given POSIX mode on POSIX platforms, or `undefined` on Windows.
 * Pass through to `fs.writeFileSync` / `fs.mkdirSync` / etc. options.
 */
export function posixMode(mode: number): number | undefined {
  return IS_POSIX ? mode : undefined;
}
