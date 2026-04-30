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

// ─── Full home isolation (tempHome covers BOTH equip + platform dirs) ──
//
// Some tests exercise platform discovery (claude-code, codex, cursor, etc.)
// or write into platform-side dirs like ~/.claude/skills/. These need
// `os.homedir()` itself to point at the temp dir — not just EQUIP_HOME.
//
// Pre-ENG-0031 tests did `os.homedir = () => tempHome` to fake the homedir.
// That's process-global, survives a thrown test, and was the source of a
// 2026-04-26 incident that wiped a user's real ~/.equip/installations.json.
//
// This helper redirects via env vars instead. Node's `os.homedir()` resolves
// to `$USERPROFILE` on Windows and `$HOME` on Unix at every call, so setting
// these env vars cleanly retargets the homedir without monkey-patching.
// `APPDATA` is also retargeted so platform discovery (vsCodeUserDir →
// roo-code, vscode, copilot) doesn't read the developer's real installs.
// `CODEX_HOME` is retargeted because Codex reads it directly.
//
// Pattern:
//
//   const { setupFullHome } = require("./_isolation");
//
//   describe("my suite", () => {
//     let isolation;
//     beforeEach(() => { isolation = setupFullHome("my-suite"); });
//     afterEach(() => { isolation.dispose(); });
//
//     it("…", () => { /* os.homedir() → isolation.home */ });
//   });

const HOME_ENV_VARS = ["EQUIP_HOME", "HOME", "USERPROFILE", "APPDATA", "CODEX_HOME"];

function setupFullHome(label = "equip-full") {
  const previousEnv = {};
  for (const k of HOME_ENV_VARS) previousEnv[k] = process.env[k];

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  fs.mkdirSync(path.join(tempRoot, ".equip"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, "AppData", "Roaming"), { recursive: true });

  process.env.HOME = tempRoot;
  process.env.USERPROFILE = tempRoot;
  process.env.EQUIP_HOME = path.join(tempRoot, ".equip");
  process.env.APPDATA = path.join(tempRoot, "AppData", "Roaming");
  process.env.CODEX_HOME = tempRoot;

  return {
    home: tempRoot,
    equipHome: process.env.EQUIP_HOME,
    dispose() {
      for (const k of HOME_ENV_VARS) {
        if (previousEnv[k] === undefined) delete process.env[k];
        else process.env[k] = previousEnv[k];
      }
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch { /* Windows EBUSY tolerated, see setupEquipHome */ }
    },
  };
}

module.exports = { setupEquipHome, setupFullHome };
