// installs-store unit tests.
// Pkg 01 of equip-storage-refactor.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "installs-store-test-"));
process.env.EQUIP_HOME = tmpHome;

const { readInstall, writeInstall, deleteInstall, hasInstall, listInstalls, getInstallsDir } = await import(
  "../dist/lib/installs-store.js"
);

function fixture(name, overrides = {}) {
  return {
    name,
    installedAt: "2026-04-28T10:00:00.000Z",
    updatedAt: "2026-04-28T10:00:00.000Z",
    platforms: ["claude-code"],
    artifacts: {
      "claude-code": { mcp: true, rules: "1.0.0", installMode: "direct" },
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Round-trip
// ─────────────────────────────────────────────────────────────

test("write + read round-trip preserves all fields", () => {
  const rec = fixture("rt-install", {
    platforms: ["claude-code", "cursor"],
    artifacts: {
      "claude-code": { mcp: true, rules: "1.2.0", hooks: ["post-tool-use.sh"], skills: ["debug", "refactor"], installMode: "broker" },
      "cursor": { mcp: true, installMode: "direct" },
    },
  });
  writeInstall(rec);
  const back = readInstall("rt-install");
  assert.deepEqual(back, rec);
});

test("write + read round-trip preserves installMode='broker' marker", () => {
  // Broker-managed install — installMode is the load-bearing flag for
  // doctor + uninstall to know which credential lifecycle path to use.
  const rec = fixture("broker-install", {
    artifacts: { "claude-code": { mcp: true, installMode: "broker" } },
  });
  writeInstall(rec);
  const back = readInstall("broker-install");
  assert.equal(back?.artifacts["claude-code"]?.installMode, "broker");
});

test("write + read round-trip preserves rules-only / skills-only / hooks-only artifact shapes", () => {
  const rec = fixture("partial-install", {
    artifacts: {
      "claude-code": { mcp: false, rules: "1.0.0" },
      "cursor": { mcp: false, skills: ["only-this-skill"] },
      "vscode": { mcp: false, hooks: ["only-this-hook.sh"] },
    },
  });
  writeInstall(rec);
  const back = readInstall("partial-install");
  assert.deepEqual(back, rec);
});

// ─────────────────────────────────────────────────────────────
// Missing / corrupt
// ─────────────────────────────────────────────────────────────

test("readInstall returns null for missing record", () => {
  assert.equal(readInstall("not-installed"), null);
});

test("readInstall returns null for corrupt JSON and writes .corrupt.bak", () => {
  const dir = getInstallsDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "broken-install.json");
  fs.writeFileSync(p, "{ invalid", "utf-8");
  assert.equal(readInstall("broken-install"), null);
  assert.equal(fs.existsSync(p + ".corrupt.bak"), true);
});

// ─────────────────────────────────────────────────────────────
// Delete + has
// ─────────────────────────────────────────────────────────────

test("deleteInstall returns true on existing, false on missing", () => {
  writeInstall(fixture("del-i"));
  assert.equal(deleteInstall("del-i"), true);
  assert.equal(deleteInstall("del-i"), false);
  assert.equal(readInstall("del-i"), null);
});

test("hasInstall matches readInstall truthiness", () => {
  assert.equal(hasInstall("never-i"), false);
  writeInstall(fixture("has-i"));
  assert.equal(hasInstall("has-i"), true);
});

// ─────────────────────────────────────────────────────────────
// List
// ─────────────────────────────────────────────────────────────

test("listInstalls returns all records and skips .corrupt.bak", () => {
  writeInstall(fixture("list-i-a"));
  writeInstall(fixture("list-i-b"));
  const dir = getInstallsDir();
  fs.writeFileSync(path.join(dir, "list-i-c.json.corrupt.bak"), "bad", "utf-8");

  const all = listInstalls();
  const names = all.map((r) => r.name);
  assert.equal(names.includes("list-i-a"), true);
  assert.equal(names.includes("list-i-b"), true);
});
