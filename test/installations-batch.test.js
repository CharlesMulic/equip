// Tests for Package 05 of equip-skill-ownership: installations.json batched writer.
//
// Coverage:
//  - begin/commit cycle writes once at end (no intermediate writes)
//  - abort discards changes
//  - withInstallationsBatch happy-path commits; exception aborts and rethrows
//  - mid-batch readInstallations sees in-progress changes (clone, not live ref)
//  - nested begin throws; commit/abort outside batch are silent no-ops
//  - per-call disk write count via fs.writeFileSync spy

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const {
  readInstallations,
  trackInstallation,
  trackUninstallation,
  beginInstallationsBatch,
  commitInstallationsBatch,
  abortInstallationsBatch,
  withInstallationsBatch,
  isInstallationsBatchActive,
} = require("../dist/lib/installations");

const { setupFullHome } = require("./_isolation");

let isolation, tempHome;

function setupTempHome() {
  isolation = setupFullHome("equip-batch");
  tempHome = isolation.home;
}

function teardownTempHome() {
  // Always abort any leaked batch so subsequent tests start clean.
  abortInstallationsBatch();
  isolation.dispose();
}

function installationsPath() {
  return path.join(tempHome, ".equip", "installations.json");
}

function recordFor(name) {
  return {
    source: "registry",
    title: name,
    transport: "http",
    platforms: ["claude-code"],
    artifacts: { "claude-code": { mcp: true } },
  };
}

describe("installations batch — begin/commit/abort", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("writes once at commit, not per trackInstallation call", () => {
    let writeCount = 0;
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = function (filePath, ...rest) {
      // atomicWriteFileSync writes to a .tmp file then renames; count both writes
      // and the rename target. Filter for installations.json + its temp twin.
      if (typeof filePath === "string" &&
          filePath.includes(`${path.sep}.equip${path.sep}installations.json`)) {
        writeCount++;
      }
      return origWrite.call(fs, filePath, ...rest);
    };

    try {
      beginInstallationsBatch();
      trackInstallation("a", recordFor("a"));
      trackInstallation("b", recordFor("b"));
      trackInstallation("c", recordFor("c"));
      assert.equal(writeCount, 0, "no disk writes during batch");
      commitInstallationsBatch();
      assert.ok(writeCount >= 1, "at least one write at commit (atomic write may write tmp + final)");
      assert.ok(writeCount <= 2, "should not exceed 2 disk operations (tmp + rename target)");
    } finally {
      fs.writeFileSync = origWrite;
    }

    // Verify final state on disk includes all three.
    const inst = readInstallations();
    assert.deepEqual(Object.keys(inst.augments).sort(), ["a", "b", "c"]);
  });

  it("abort discards in-progress changes", () => {
    beginInstallationsBatch();
    trackInstallation("a", recordFor("a"));
    abortInstallationsBatch();
    assert.equal(isInstallationsBatchActive(), false);

    const inst = readInstallations();
    assert.equal(Object.keys(inst.augments).length, 0, "no augments persisted");
    assert.ok(!fs.existsSync(installationsPath()), "no file written");
  });

  it("commit without begin is a silent no-op", () => {
    commitInstallationsBatch(); // should not throw
    assert.equal(isInstallationsBatchActive(), false);
  });

  it("abort without begin is a silent no-op", () => {
    abortInstallationsBatch();
    assert.equal(isInstallationsBatchActive(), false);
  });

  it("nested begin throws", () => {
    beginInstallationsBatch();
    try {
      assert.throws(() => beginInstallationsBatch(), /already active/);
    } finally {
      abortInstallationsBatch();
    }
  });

  it("isInstallationsBatchActive reflects state", () => {
    assert.equal(isInstallationsBatchActive(), false);
    beginInstallationsBatch();
    assert.equal(isInstallationsBatchActive(), true);
    commitInstallationsBatch();
    assert.equal(isInstallationsBatchActive(), false);
  });
});

describe("installations batch — withInstallationsBatch helper", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("commits on successful function return", () => {
    const result = withInstallationsBatch(() => {
      trackInstallation("x", recordFor("x"));
      trackInstallation("y", recordFor("y"));
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(isInstallationsBatchActive(), false);
    const inst = readInstallations();
    assert.deepEqual(Object.keys(inst.augments).sort(), ["x", "y"]);
  });

  it("aborts and rethrows on exception (no partial state persists)", () => {
    assert.throws(
      () => withInstallationsBatch(() => {
        trackInstallation("good", recordFor("good"));
        throw new Error("kaboom");
      }),
      /kaboom/,
    );
    assert.equal(isInstallationsBatchActive(), false);
    const inst = readInstallations();
    assert.equal(Object.keys(inst.augments).length, 0, "partial state not persisted");
  });

  it("nested withInstallationsBatch throws (no implicit re-entry)", () => {
    assert.throws(
      () => withInstallationsBatch(() => {
        withInstallationsBatch(() => {
          trackInstallation("a", recordFor("a"));
        });
      }),
      /already active/,
    );
  });
});

describe("installations batch — read semantics", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("readInstallations during a batch returns in-progress state", () => {
    withInstallationsBatch(() => {
      trackInstallation("a", recordFor("a"));
      const inst = readInstallations();
      assert.ok(inst.augments["a"], "augment a visible mid-batch");
    });
  });

  it("readInstallations during a batch returns a CLONE (mutating the result does not affect batch)", () => {
    withInstallationsBatch(() => {
      trackInstallation("a", recordFor("a"));
      const inst = readInstallations();
      // Mutate the returned object — should NOT affect the batch buffer.
      delete inst.augments["a"];
      inst.augments["b"] = recordFor("b");

      const inst2 = readInstallations();
      assert.ok(inst2.augments["a"], "batch state unaffected by external mutation");
      assert.ok(!inst2.augments["b"], "external mutation did not leak into batch");
    });
  });

  it("readInstallations outside a batch reads fresh from disk", () => {
    withInstallationsBatch(() => {
      trackInstallation("a", recordFor("a"));
    });
    // After commit, fresh disk read.
    const inst = readInstallations();
    assert.ok(inst.augments["a"]);
  });
});

describe("installations batch — interaction with trackUninstallation", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("trackUninstallation inside a batch buffers the removal", () => {
    // Pre-seed disk state.
    withInstallationsBatch(() => {
      trackInstallation("a", recordFor("a"));
      trackInstallation("b", recordFor("b"));
    });
    assert.equal(Object.keys(readInstallations().augments).length, 2);

    // Now remove inside a batch.
    withInstallationsBatch(() => {
      trackUninstallation("a");
      // Mid-batch read sees the removal.
      assert.equal(Object.keys(readInstallations().augments).length, 1);
      assert.ok(readInstallations().augments["b"]);
    });

    // Post-commit disk state.
    const inst = readInstallations();
    assert.equal(Object.keys(inst.augments).length, 1);
    assert.ok(inst.augments["b"]);
    assert.ok(!inst.augments["a"]);
  });

  it("mixed install + uninstall in a single batch all flush together", () => {
    let writeCount = 0;
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = function (filePath, ...rest) {
      if (typeof filePath === "string" &&
          filePath.includes(`${path.sep}.equip${path.sep}installations.json`)) {
        writeCount++;
      }
      return origWrite.call(fs, filePath, ...rest);
    };

    try {
      withInstallationsBatch(() => {
        trackInstallation("a", recordFor("a"));
        trackInstallation("b", recordFor("b"));
        trackUninstallation("a");
        trackInstallation("c", recordFor("c"));
      });
      // 1-2 writes total (atomic write may produce tmp + rename target).
      assert.ok(writeCount >= 1 && writeCount <= 2, `expected 1-2 writes, got ${writeCount}`);
    } finally {
      fs.writeFileSync = origWrite;
    }

    const inst = readInstallations();
    assert.deepEqual(Object.keys(inst.augments).sort(), ["b", "c"]);
  });
});
