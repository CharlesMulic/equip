// Test-suite-wide isolation. `require("./_isolation")` MUST be the first
// statement in any equip test file that does not already set up its own
// per-test EQUIP_HOME (e.g., via `withTempHome` or `setupTempHome`).
//
// Sets `process.env.EQUIP_HOME` to a fresh temp dir at module load time so
// every subsequent `require()` of equip lib code consults the temp seam, not
// the user's real ~/.equip. See ENG-0031 in operations/ENGINEERING_LEDGER.md.
//
// Idempotent — if EQUIP_HOME is already set (e.g., by a parent harness or by
// a prior `_isolation` require), this is a no-op.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

if (!process.env.EQUIP_HOME) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "equip-test-"));
  process.env.EQUIP_HOME = path.join(tempRoot, ".equip");
  fs.mkdirSync(process.env.EQUIP_HOME, { recursive: true });
}
