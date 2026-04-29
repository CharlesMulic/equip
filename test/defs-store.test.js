// defs-store unit tests.
//
// Pkg 01 of equip-storage-refactor: pin the sovereign-content storage
// primitive against its single-public-API contract.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// EQUIP_HOME isolation per ENG-0031 — set before importing the module so
// getEquipHome() resolves to our temp directory.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "defs-store-test-"));
process.env.EQUIP_HOME = tmpHome;

const { readDef, writeDef, deleteDef, hasDef, listDefs, getDefsDir } = await import(
  "../dist/lib/defs-store.js"
);

// Each test uses a unique name to avoid cross-test interference inside the
// shared tmpHome — keeps tests independent without per-test EQUIP_HOME
// rotation overhead.

function localFixture(name, overrides = {}) {
  const now = "2026-04-28T00:00:00.000Z";
  return {
    name,
    kind: "local",
    createdAt: now,
    updatedAt: now,
    title: "Test",
    description: "Test fixture",
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    ...overrides,
  };
}

function overlayFixture(name, overrides = {}) {
  const now = "2026-04-28T00:00:00.000Z";
  return {
    name,
    kind: "overlay",
    overlay_of: name,
    createdAt: now,
    updatedAt: now,
    rules: { content: "modded rules", version: "1.0.0", marker: name },
    ...overrides,
  };
}

function wrappedFixture(name, overrides = {}) {
  const now = "2026-04-28T00:00:00.000Z";
  return {
    name,
    kind: "wrapped",
    createdAt: now,
    updatedAt: now,
    title: "Wrapped",
    description: "Auto-detected",
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    wrappedFrom: { type: "mcp", platform: "cursor" },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Round-trip per kind
// ─────────────────────────────────────────────────────────────

test("write + read round-trip for kind=local", () => {
  const def = localFixture("rt-local-1", { title: "Round Trip Local" });
  writeDef(def);
  const back = readDef("rt-local-1");
  assert.deepEqual(back, def);
});

test("write + read round-trip for kind=overlay", () => {
  const def = overlayFixture("rt-overlay-1", { hooks: [{ type: "PostToolUse", command: "echo done" }] });
  writeDef(def);
  const back = readDef("rt-overlay-1");
  assert.deepEqual(back, def);
});

test("write + read round-trip for kind=wrapped preserves wrappedFrom", () => {
  const def = wrappedFixture("rt-wrapped-1", { wrappedFrom: { type: "skill", platform: "claude-code", path: "/some/path" } });
  writeDef(def);
  const back = readDef("rt-wrapped-1");
  assert.deepEqual(back, def);
});

// ─────────────────────────────────────────────────────────────
// Missing / corrupt / unreadable
// ─────────────────────────────────────────────────────────────

test("readDef returns null for missing augment", () => {
  assert.equal(readDef("does-not-exist"), null);
});

test("readDef returns null for corrupt JSON and writes .corrupt.bak", () => {
  const dir = getDefsDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "corrupt-aug.json");
  fs.writeFileSync(p, "{ this is not valid json", "utf-8");
  assert.equal(readDef("corrupt-aug"), null);
  assert.equal(fs.existsSync(p + ".corrupt.bak"), true);
});

// ─────────────────────────────────────────────────────────────
// Delete + hasDef
// ─────────────────────────────────────────────────────────────

test("deleteDef returns true on existing, false on missing", () => {
  writeDef(localFixture("del-target"));
  assert.equal(deleteDef("del-target"), true);
  assert.equal(deleteDef("del-target"), false);
  assert.equal(readDef("del-target"), null);
});

test("hasDef matches readDef truthiness", () => {
  assert.equal(hasDef("never-existed"), false);
  writeDef(localFixture("has-test"));
  assert.equal(hasDef("has-test"), true);
  deleteDef("has-test");
  assert.equal(hasDef("has-test"), false);
});

// ─────────────────────────────────────────────────────────────
// List
// ─────────────────────────────────────────────────────────────

test("listDefs returns all written defs and skips .corrupt.bak files", () => {
  // Write a fresh batch into an isolated subdir prefix so other tests don't
  // pollute the count assertion.
  writeDef(localFixture("list-a"));
  writeDef(localFixture("list-b"));
  writeDef(overlayFixture("list-c"));

  const all = listDefs();
  const names = all.map((d) => d.name);
  assert.equal(names.includes("list-a"), true);
  assert.equal(names.includes("list-b"), true);
  assert.equal(names.includes("list-c"), true);

  // Plant a .corrupt.bak file directly + ensure list ignores it.
  const dir = getDefsDir();
  fs.writeFileSync(path.join(dir, "list-c.json.corrupt.bak"), "garbage", "utf-8");
  const after = listDefs();
  assert.equal(after.find((d) => d.name === "list-c.json.corrupt") ?? null, null);
});

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

test("writeDef rejects invalid augment names via validateToolName", () => {
  assert.throws(() => {
    writeDef(localFixture("../escape-attempt"));
  });
});

test("readDef rejects invalid augment names via validateToolName", () => {
  assert.throws(() => {
    readDef("../escape-attempt");
  });
});

// ─────────────────────────────────────────────────────────────
// Atomicity
// ─────────────────────────────────────────────────────────────

test("writeDef writes atomically — no partial file visible mid-write", () => {
  // We can't deterministically observe the atomic-rename window, but we can
  // assert that after a write, the file is either fully present or absent —
  // there's never a half-written-JSON state. atomicWriteFileSync uses a
  // temp + rename under the hood; this test pins that the write-after-read
  // pattern produces a fully-parseable file.
  for (let i = 0; i < 50; i++) {
    writeDef(localFixture(`atom-${i}`, { title: `Atom Test ${i}` }));
    const back = readDef(`atom-${i}`);
    assert.equal(back?.title, `Atom Test ${i}`);
  }
});

// ─────────────────────────────────────────────────────────────
// Update semantics — write replaces existing
// ─────────────────────────────────────────────────────────────

test("writeDef replaces existing entry by name", () => {
  writeDef(localFixture("update-test", { title: "Original" }));
  writeDef(localFixture("update-test", { title: "Updated" }));
  const back = readDef("update-test");
  assert.equal(back?.title, "Updated");
});
