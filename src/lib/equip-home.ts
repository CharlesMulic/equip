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
// The architect (2026-04-26 review) explicitly rejected building a
// profile/workspace concept on top of this — equip-only profile isolation
// would lie to the user because platform-side state (e.g.,
// ~/.claude/skills/, ~/.codex/skills/) is not redirectable through equip.
// A profile that swaps ~/.equip but not ~/.claude/skills/ is a half-truth.
//
// Tests should set `process.env.EQUIP_HOME = mkdtempSync(...)` in
// beforeEach + restore in afterEach. Don't monkey-patch `os.homedir` —
// that's process-global and survives a thrown test, leaking state.
//
// See ENG-0031 in operations/ENGINEERING_LEDGER.md for the bug class this
// resolver was extracted to fix.

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
