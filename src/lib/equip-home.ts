// equip-home.ts — single seam for resolving ~/.equip.
//
// Every caller across the equip lib that needs to read/write something inside
// ~/.equip must go through `getEquipHome()`. This is the only place that
// consults `os.homedir()` and the only place that reads the `EQUIP_HOME` env
// var. Don't add ad-hoc `path.join(os.homedir(), ".equip")` elsewhere — it
// breaks the test-isolation seam.
//
// Precedence:
//   1. process.env.EQUIP_HOME (set explicitly)
//   2. path.join(os.homedir(), ".equip")  (user default)
//
// `EQUIP_HOME` is a TEST/CI SEAM, not a user-facing "profile" feature.
// Platform-side state (e.g., ~/.claude/skills/, ~/.codex/skills/) is not
// redirected through Equip, so changing only ~/.equip would not isolate a
// full user profile.
//
// Tests should set `process.env.EQUIP_HOME = mkdtempSync(...)` in
// beforeEach + restore in afterEach. Don't monkey-patch `os.homedir` —
// that's process-global and survives a thrown test, leaking state.
//
// This resolver keeps tests from mutating a contributor's real ~/.equip.

import * as os from "os";
import * as path from "path";

/**
 * Returns the absolute path to the equip home directory.
 *
 * Re-evaluated on every call so test-time `process.env.EQUIP_HOME` overrides
 * take effect without restarting the process or invalidating module caches.
 */
export function getEquipHome(): string {
  return process.env.EQUIP_HOME ?? path.join(os.homedir(), ".equip");
}
