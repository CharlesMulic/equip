// Tests for augment sets module.

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  listSets,
  getSet,
  saveSet,
  deleteSet,
  renameSet,
  duplicateSet,
  getActiveSet,
  setActiveSet,
} = require("../dist/lib/sets");

// ─── Temp Home Isolation ────────────────────────────────────

let originalHome;
let tempHome;

function setupTempHome() {
  originalHome = os.homedir;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "sets-test-"));
  os.homedir = () => tempHome;
}

function teardownTempHome() {
  os.homedir = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}

// ─── Tests ──────────────────────────────────────────────────

describe("listSets", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("returns empty array when no sets exist", () => {
    const sets = listSets();
    assert.deepEqual(sets, []);
  });

  it("returns saved sets", () => {
    saveSet("dev", ["prior", "context7"]);
    saveSet("review", ["prior"]);
    const sets = listSets();
    assert.equal(sets.length, 2);
    assert.ok(sets.some(s => s.name === "dev"));
    assert.ok(sets.some(s => s.name === "review"));
  });
});

describe("saveSet", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("creates a new set", () => {
    const set = saveSet("my-set", ["prior", "browser-tools"]);
    assert.equal(set.name, "my-set");
    assert.deepEqual(set.augments, ["prior", "browser-tools"]);
    assert.ok(set.createdAt);
    assert.ok(set.lastUsed);
  });

  it("updates an existing set", () => {
    saveSet("my-set", ["prior"]);
    const updated = saveSet("my-set", ["prior", "context7"]);
    assert.deepEqual(updated.augments, ["prior", "context7"]);

    // Should still be only one set
    assert.equal(listSets().length, 1);
  });
});

describe("getSet", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("returns a set by name", () => {
    saveSet("test", ["a", "b"]);
    const set = getSet("test");
    assert.ok(set);
    assert.equal(set.name, "test");
    assert.deepEqual(set.augments, ["a", "b"]);
  });

  it("returns null for nonexistent set", () => {
    assert.equal(getSet("nope"), null);
  });
});

describe("deleteSet", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("deletes a set", () => {
    saveSet("to-delete", ["prior"]);
    assert.equal(deleteSet("to-delete"), true);
    assert.equal(getSet("to-delete"), null);
    assert.equal(listSets().length, 0);
  });

  it("returns false for nonexistent set", () => {
    assert.equal(deleteSet("nope"), false);
  });

  it("clears activeSet if deleted set was active", () => {
    saveSet("active-set", ["prior"]);
    setActiveSet("active-set");
    assert.equal(getActiveSet(), "active-set");

    deleteSet("active-set");
    assert.equal(getActiveSet(), null);
  });
});

describe("renameSet", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("renames a set", () => {
    saveSet("old-name", ["prior"]);
    const renamed = renameSet("old-name", "new-name");
    assert.ok(renamed);
    assert.equal(renamed.name, "new-name");
    assert.equal(getSet("old-name"), null);
    assert.ok(getSet("new-name"));
  });

  it("returns null for nonexistent set", () => {
    assert.equal(renameSet("nope", "new"), null);
  });

  it("throws if target name already exists", () => {
    saveSet("a", ["prior"]);
    saveSet("b", ["context7"]);
    assert.throws(() => renameSet("a", "b"), /already exists/);
  });

  it("updates activeSet reference on rename", () => {
    saveSet("active", ["prior"]);
    setActiveSet("active");
    renameSet("active", "renamed");
    assert.equal(getActiveSet(), "renamed");
  });
});

describe("duplicateSet", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("duplicates a set with a new name", () => {
    saveSet("original", ["prior", "context7"]);
    const copy = duplicateSet("original", "copy");
    assert.ok(copy);
    assert.equal(copy.name, "copy");
    assert.deepEqual(copy.augments, ["prior", "context7"]);
    assert.equal(listSets().length, 2);
  });

  it("returns null for nonexistent source", () => {
    assert.equal(duplicateSet("nope", "copy"), null);
  });

  it("throws if target name exists", () => {
    saveSet("a", []);
    saveSet("b", []);
    assert.throws(() => duplicateSet("a", "b"), /already exists/);
  });
});

describe("activeSet", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("defaults to null", () => {
    assert.equal(getActiveSet(), null);
  });

  it("can be set and read", () => {
    saveSet("my-set", ["prior"]);
    setActiveSet("my-set");
    assert.equal(getActiveSet(), "my-set");
  });

  it("can be cleared with null", () => {
    saveSet("my-set", ["prior"]);
    setActiveSet("my-set");
    setActiveSet(null);
    assert.equal(getActiveSet(), null);
  });

  it("throws for nonexistent set", () => {
    assert.throws(() => setActiveSet("nope"), /not found/);
  });

  it("updates lastUsed on activation", () => {
    saveSet("my-set", ["prior"]);
    const before = getSet("my-set").lastUsed;
    // Small delay to ensure timestamp changes
    const start = Date.now();
    while (Date.now() - start < 10) {} // busy wait 10ms
    setActiveSet("my-set");
    const after = getSet("my-set").lastUsed;
    assert.ok(after >= before);
  });
});
