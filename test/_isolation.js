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

// ─── Per-test isolation helper (prepass for equip-dual-write-retirement) ──
//
// Tests that need a FRESH ~/.equip per test (not just one for the whole suite)
// use `setupEquipHome()` in `beforeEach` / `afterEach` to mint + clean up a
// dedicated temp dir. Replaces ad-hoc `freshHome()` / inline `mkdtempSync`
// patterns scattered across migrate-storage.test.js, registry-refresh.test.js,
// retraction-promotion.test.js, etc.
//
// Usage pattern (node:test or describe/it):
//
//   const { setupEquipHome } = require("./_isolation");
//
//   test("my test", async () => {
//     const { home, dispose } = setupEquipHome("my-test");
//     try {
//       // ...code that reads/writes ~/.equip via process.env.EQUIP_HOME...
//     } finally {
//       dispose();
//     }
//   });
//
// Or for describe-blocks with beforeEach/afterEach:
//
//   describe("my suite", () => {
//     let isolation;
//     beforeEach(() => { isolation = setupEquipHome("my-suite"); });
//     afterEach(() => { isolation.dispose(); });
//   });
//
// Each call mkdtempSync's a new temp dir (process-unique prefix), sets
// process.env.EQUIP_HOME to it, and returns a `dispose()` that restores the
// previous EQUIP_HOME and rm -rf's the temp dir. dispose() is best-effort on
// rm — Windows EBUSY on file handles is swallowed (the OS reaps the temp dir
// at next reboot).
//
// Stash + restore pattern intentionally — process.env.EQUIP_HOME is global
// state, and tests in the same node process will collide otherwise. Pairs
// cleanly with the module-load-time isolation above (which sets EQUIP_HOME
// to the suite-wide temp; per-test calls override + restore that).

function setupEquipHome(label = "equip") {
  const previousEquipHome = process.env.EQUIP_HOME;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const home = path.join(tempRoot, ".equip");
  fs.mkdirSync(home, { recursive: true });
  process.env.EQUIP_HOME = home;

  return {
    home,
    dispose() {
      if (previousEquipHome === undefined) {
        delete process.env.EQUIP_HOME;
      } else {
        process.env.EQUIP_HOME = previousEquipHome;
      }
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // Best effort — Windows can EBUSY on lingering file handles. The OS
        // reaps tempdir at reboot; per-test correctness doesn't depend on
        // the rm succeeding.
      }
    },
  };
}

module.exports = { setupEquipHome };
