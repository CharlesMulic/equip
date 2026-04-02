// Tests for platform config snapshot/restore.

"use strict";

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  createSnapshot,
  listSnapshots,
  readSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  hasInitialSnapshot,
  ensureInitialSnapshots,
  pruneSnapshots,
} = require("../dist/lib/snapshots");

// ─── Temp Home Isolation ────────────────────────────────────

let originalHome;
let tempHome;

function setupTempHome() {
  originalHome = os.homedir;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  os.homedir = () => tempHome;
}

function teardownTempHome() {
  os.homedir = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}

// ─── Test Helpers ───────────────────────────────────────────

function makePlatform(id = "claude-code", configContent = '{"mcpServers":{}}') {
  const configPath = path.join(tempHome, `.${id}-config.json`);
  const rulesPath = path.join(tempHome, `.${id}-rules.md`);

  // Write a fake config file
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (configContent !== null) {
    fs.writeFileSync(configPath, configContent);
  }

  return {
    platform: id,
    configPath,
    rulesPath,
    skillsPath: null,
    existingMcp: null,
    rootKey: "mcpServers",
    configFormat: "json",
  };
}

function makePlatformWithRules(id = "claude-code") {
  const p = makePlatform(id, '{"mcpServers":{"prior":{"url":"https://api.cg3.io/mcp"}}}');
  fs.writeFileSync(p.rulesPath, "# My custom rules\n\nDo great things.\n");
  return p;
}

// ─── Tests ──────────────────────────────────────────────────

describe("createSnapshot", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("creates a snapshot file with config content", () => {
    const p = makePlatform("claude-code");
    const snap = createSnapshot(p, { label: "test", trigger: "manual" });

    assert.ok(snap.id, "should have an ID");
    assert.equal(snap.platform, "claude-code");
    assert.equal(snap.label, "test");
    assert.equal(snap.trigger, "manual");
    assert.equal(snap.configContent, '{"mcpServers":{}}');
    assert.equal(snap.rulesContent, null);
    assert.ok(snap.createdAt);
    assert.ok(snap.equipVersion);

    // File should exist on disk
    const filePath = path.join(tempHome, ".equip", "snapshots", "claude-code", `${snap.id}.json`);
    assert.ok(fs.existsSync(filePath), "snapshot file should exist");
  });

  it("captures rules content when present", () => {
    const p = makePlatformWithRules("test-plat");
    const snap = createSnapshot(p);

    assert.equal(snap.configContent, '{"mcpServers":{"prior":{"url":"https://api.cg3.io/mcp"}}}');
    assert.equal(snap.rulesContent, "# My custom rules\n\nDo great things.\n");
  });

  it("handles missing config file gracefully", () => {
    const p = makePlatform("missing-plat", null);
    // Don't write the config file
    try { fs.unlinkSync(p.configPath); } catch {}

    const snap = createSnapshot(p);
    assert.equal(snap.configContent, null, "configContent should be null for missing file");
  });

  it("generates unique IDs for same-second snapshots", () => {
    const p = makePlatform("cursor");
    const snap1 = createSnapshot(p, { label: "first" });
    const snap2 = createSnapshot(p, { label: "second" });
    assert.notEqual(snap1.id, snap2.id, "IDs should be unique");
  });
});

describe("listSnapshots", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("returns empty array when no snapshots exist", () => {
    const result = listSnapshots("claude-code");
    assert.deepEqual(result, []);
  });

  it("lists snapshots for a specific platform", () => {
    const p = makePlatform("claude-code");
    createSnapshot(p, { label: "first" });
    createSnapshot(p, { label: "second" });

    const result = listSnapshots("claude-code");
    assert.equal(result.length, 2);
    // Newest first
    assert.equal(result[0].label, "second");
    assert.equal(result[1].label, "first");
  });

  it("lists snapshots across all platforms", () => {
    const p1 = makePlatform("claude-code");
    const p2 = makePlatform("cursor");
    createSnapshot(p1, { label: "cc" });
    createSnapshot(p2, { label: "cur" });

    const result = listSnapshots();
    assert.equal(result.length, 2);
  });

  it("returns summaries without content", () => {
    const p = makePlatformWithRules("claude-code");
    createSnapshot(p);

    const result = listSnapshots("claude-code");
    assert.equal(result.length, 1);
    assert.ok(result[0].configExists);
    assert.ok(result[0].rulesExists);
    // Summary should NOT have content fields
    assert.equal(result[0].configContent, undefined);
    assert.equal(result[0].rulesContent, undefined);
  });
});

describe("readSnapshot", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("returns full snapshot with content", () => {
    const p = makePlatformWithRules("claude-code");
    const created = createSnapshot(p, { label: "full" });

    const snap = readSnapshot("claude-code", created.id);
    assert.ok(snap);
    assert.equal(snap.id, created.id);
    assert.ok(snap.configContent, "should have config content");
    assert.ok(snap.rulesContent, "should have rules content");
  });

  it("returns null for nonexistent snapshot", () => {
    const snap = readSnapshot("claude-code", "nonexistent");
    assert.equal(snap, null);
  });
});

describe("restoreSnapshot", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("restores config file content", () => {
    const p = makePlatform("claude-code", '{"mcpServers":{"original":{}}}');
    const snap = createSnapshot(p, { label: "initial", trigger: "first-detection" });

    // Modify the config
    fs.writeFileSync(p.configPath, '{"mcpServers":{"modified":{}}}');
    assert.equal(fs.readFileSync(p.configPath, "utf-8"), '{"mcpServers":{"modified":{}}}');

    // Restore
    const result = restoreSnapshot("claude-code", snap.id);
    assert.ok(result.restored);
    assert.ok(result.configRestored);
    assert.equal(fs.readFileSync(p.configPath, "utf-8"), '{"mcpServers":{"original":{}}}');
  });

  it("restores rules file content", () => {
    const p = makePlatformWithRules("claude-code");
    const originalRules = fs.readFileSync(p.rulesPath, "utf-8");
    const snap = createSnapshot(p, { label: "initial", trigger: "first-detection" });

    // Modify rules
    fs.writeFileSync(p.rulesPath, "# Modified rules\n");

    const result = restoreSnapshot("claude-code", snap.id);
    assert.ok(result.rulesRestored);
    assert.equal(fs.readFileSync(p.rulesPath, "utf-8"), originalRules);
  });

  it("defaults to initial snapshot when no ID given", () => {
    const p = makePlatform("claude-code", '{"initial":true}');
    createSnapshot(p, { label: "initial", trigger: "first-detection" });

    // Modify
    fs.writeFileSync(p.configPath, '{"modified":true}');

    const result = restoreSnapshot("claude-code");
    assert.ok(result.restored);
    assert.equal(fs.readFileSync(p.configPath, "utf-8"), '{"initial":true}');
  });

  it("creates pre-restore snapshot before restoring", () => {
    const p = makePlatform("claude-code", '{"original":true}');
    createSnapshot(p, { label: "initial", trigger: "first-detection" });

    fs.writeFileSync(p.configPath, '{"current":true}');
    const result = restoreSnapshot("claude-code");

    assert.ok(result.preRestoreId, "should create pre-restore snapshot");

    // The pre-restore snapshot should have the modified content
    const preRestore = readSnapshot("claude-code", result.preRestoreId);
    assert.ok(preRestore);
    assert.equal(preRestore.configContent, '{"current":true}');
    assert.equal(preRestore.trigger, "pre-restore");
  });

  it("warns when config content is null", () => {
    const p = makePlatform("test-plat", null);
    try { fs.unlinkSync(p.configPath); } catch {}
    const snap = createSnapshot(p, { label: "empty", trigger: "first-detection" });

    // Now create a config file
    fs.writeFileSync(p.configPath, '{"new":true}');

    const result = restoreSnapshot("test-plat", snap.id);
    assert.ok(result.warnings.length > 0, "should have warnings");
    assert.ok(result.warnings.some(w => w.includes("did not exist")));
    assert.equal(result.configRestored, false);
    // File should NOT be deleted
    assert.ok(fs.existsSync(p.configPath), "should not delete existing file");
  });

  it("throws when no initial snapshot exists and no ID given", () => {
    assert.throws(() => restoreSnapshot("nonexistent"), /No initial snapshot/);
  });

  it("throws when snapshot ID not found", () => {
    assert.throws(() => restoreSnapshot("claude-code", "bad-id"), /not found/);
  });
});

describe("hasInitialSnapshot", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("returns false when no snapshots exist", () => {
    assert.equal(hasInitialSnapshot("claude-code"), false);
  });

  it("returns true after first-detection snapshot", () => {
    const p = makePlatform("claude-code");
    createSnapshot(p, { trigger: "first-detection" });
    assert.equal(hasInitialSnapshot("claude-code"), true);
  });

  it("returns false for manual-only snapshots", () => {
    const p = makePlatform("claude-code");
    createSnapshot(p, { trigger: "manual" });
    assert.equal(hasInitialSnapshot("claude-code"), false);
  });
});

describe("deleteSnapshot", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("deletes an existing snapshot", () => {
    const p = makePlatform("claude-code");
    const snap = createSnapshot(p);

    assert.equal(deleteSnapshot("claude-code", snap.id), true);
    assert.equal(readSnapshot("claude-code", snap.id), null);
  });

  it("returns false for nonexistent snapshot", () => {
    assert.equal(deleteSnapshot("claude-code", "nope"), false);
  });
});

describe("pruneSnapshots", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("keeps initial and most recent snapshots", () => {
    const p = makePlatform("claude-code");
    createSnapshot(p, { label: "initial", trigger: "first-detection" });
    for (let i = 0; i < 5; i++) {
      createSnapshot(p, { label: `manual-${i}`, trigger: "manual" });
    }

    const before = listSnapshots("claude-code");
    assert.equal(before.length, 6);

    const pruned = pruneSnapshots("claude-code", 3);
    assert.equal(pruned, 3, "should prune 3 snapshots (6 total - 1 initial - 2 kept = 3 pruned)");

    const after = listSnapshots("claude-code");
    assert.equal(after.length, 3, "should have 3 remaining (initial + 2 newest)");

    // Initial should still be there
    assert.ok(after.some(s => s.trigger === "first-detection"), "initial should survive pruning");
  });

  it("does nothing when under limit", () => {
    const p = makePlatform("claude-code");
    createSnapshot(p);
    createSnapshot(p);

    const pruned = pruneSnapshots("claude-code", 5);
    assert.equal(pruned, 0);
  });
});

// ─── Real-World Scenario Tests ──────────────────────────────

describe("ensureInitialSnapshots", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("creates initial snapshots for platforms without one", () => {
    const p1 = makePlatform("claude-code", '{"mcpServers":{}}');
    const p2 = makePlatform("cursor", '{"mcpServers":{}}');

    assert.equal(hasInitialSnapshot("claude-code"), false);
    assert.equal(hasInitialSnapshot("cursor"), false);

    ensureInitialSnapshots([p1, p2]);

    assert.equal(hasInitialSnapshot("claude-code"), true);
    assert.equal(hasInitialSnapshot("cursor"), true);
  });

  it("skips platforms that already have an initial snapshot", () => {
    const p = makePlatform("claude-code", '{"pristine":true}');
    ensureInitialSnapshots([p]);

    // Modify the config
    fs.writeFileSync(p.configPath, '{"modified":true}');

    // Call again — should NOT create a new initial snapshot
    ensureInitialSnapshots([p]);

    // The initial snapshot should still have pristine content
    const initial = listSnapshots("claude-code").find(s => s.trigger === "first-detection");
    assert.ok(initial);
    const full = readSnapshot("claude-code", initial.id);
    assert.equal(full.configContent, '{"pristine":true}', "initial snapshot should preserve pristine state");
  });

  it("is idempotent — multiple calls create only one initial snapshot", () => {
    const p = makePlatform("claude-code");
    ensureInitialSnapshots([p]);
    ensureInitialSnapshots([p]);
    ensureInitialSnapshots([p]);

    const all = listSnapshots("claude-code").filter(s => s.trigger === "first-detection");
    assert.equal(all.length, 1, "should only have one first-detection snapshot");
  });
});

describe("snapshot timing — captures pre-install state", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("initial snapshot captures config BEFORE augment is installed", () => {
    // Simulate the install flow: ensureInitialSnapshots → modify config
    const originalContent = '{"mcpServers":{}}';
    const p = makePlatform("claude-code", originalContent);

    // Step 1: ensure snapshots (called before install loop)
    ensureInitialSnapshots([p]);

    // Step 2: simulate augment install by modifying config
    const modifiedContent = '{"mcpServers":{"prior":{"url":"https://api.cg3.io/mcp","headers":{"Authorization":"Bearer key"}}}}';
    fs.writeFileSync(p.configPath, modifiedContent);

    // Verify: initial snapshot has the ORIGINAL content, not the modified content
    const initial = listSnapshots("claude-code").find(s => s.trigger === "first-detection");
    assert.ok(initial, "initial snapshot should exist");
    const full = readSnapshot("claude-code", initial.id);
    assert.equal(full.configContent, originalContent, "initial snapshot must capture pre-install state");
    assert.notEqual(full.configContent, modifiedContent, "initial snapshot must NOT contain post-install state");
  });

  it("second augment install does not overwrite initial snapshot", () => {
    const originalContent = '{"mcpServers":{}}';
    const p = makePlatform("claude-code", originalContent);

    // First augment install
    ensureInitialSnapshots([p]);
    fs.writeFileSync(p.configPath, '{"mcpServers":{"augment1":{}}}');

    // Second augment install — ensure still has original
    ensureInitialSnapshots([p]);
    fs.writeFileSync(p.configPath, '{"mcpServers":{"augment1":{},"augment2":{}}}');

    const full = readSnapshot("claude-code",
      listSnapshots("claude-code").find(s => s.trigger === "first-detection").id);
    assert.equal(full.configContent, originalContent, "initial must still be the pristine state");
  });
});

describe("full restore round-trip", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("install → restore returns platform to pristine state", () => {
    // Pristine state
    const pristineConfig = '{"mcpServers":{}}';
    const pristineRules = "# My Claude rules\n\nBe helpful.\n";
    const p = makePlatform("claude-code", pristineConfig);
    fs.writeFileSync(p.rulesPath, pristineRules);

    // Capture initial snapshot
    ensureInitialSnapshots([p]);

    // Simulate augment install — modify both config and rules
    fs.writeFileSync(p.configPath, '{"mcpServers":{"prior":{"url":"https://api.cg3.io/mcp"}}}');
    fs.writeFileSync(p.rulesPath, pristineRules + "\n<!-- prior:v1.0.0 -->\nUse Prior.\n<!-- /prior -->\n");

    // Verify files are modified
    assert.ok(fs.readFileSync(p.configPath, "utf-8").includes("prior"));
    assert.ok(fs.readFileSync(p.rulesPath, "utf-8").includes("prior:v1.0.0"));

    // Restore to initial
    const result = restoreSnapshot("claude-code");
    assert.ok(result.restored);
    assert.ok(result.configRestored);
    assert.ok(result.rulesRestored);

    // Verify both files are back to pristine
    assert.equal(fs.readFileSync(p.configPath, "utf-8"), pristineConfig);
    assert.equal(fs.readFileSync(p.rulesPath, "utf-8"), pristineRules);
  });

  it("restore creates safety net — can undo the undo", () => {
    const p = makePlatform("claude-code", '{"pristine":true}');
    ensureInitialSnapshots([p]);

    // Install augment
    fs.writeFileSync(p.configPath, '{"augmented":true}');

    // Restore to initial
    const result1 = restoreSnapshot("claude-code");
    assert.equal(fs.readFileSync(p.configPath, "utf-8"), '{"pristine":true}');

    // Oops, we wanted the augmented state! Restore to pre-restore snapshot
    const result2 = restoreSnapshot("claude-code", result1.preRestoreId);
    assert.equal(fs.readFileSync(p.configPath, "utf-8"), '{"augmented":true}');
  });

  it("multiple installs → restore to initial skips all changes", () => {
    const pristine = '{"mcpServers":{}}';
    const p = makePlatform("claude-code", pristine);
    ensureInitialSnapshots([p]);

    // Install 3 augments sequentially
    fs.writeFileSync(p.configPath, '{"mcpServers":{"a":{}}}');
    fs.writeFileSync(p.configPath, '{"mcpServers":{"a":{},"b":{}}}');
    fs.writeFileSync(p.configPath, '{"mcpServers":{"a":{},"b":{},"c":{}}}');

    // Restore to initial — should skip all 3
    restoreSnapshot("claude-code");
    assert.equal(fs.readFileSync(p.configPath, "utf-8"), pristine);
  });
});

describe("sentinel marker file", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("first-detection snapshot writes .initial-taken marker", () => {
    const p = makePlatform("claude-code");
    createSnapshot(p, { trigger: "first-detection" });

    const markerPath = path.join(tempHome, ".equip", "snapshots", "claude-code", ".initial-taken");
    assert.ok(fs.existsSync(markerPath), ".initial-taken marker should exist");
  });

  it("manual snapshot does NOT write .initial-taken marker", () => {
    const p = makePlatform("claude-code");
    createSnapshot(p, { trigger: "manual" });

    const markerPath = path.join(tempHome, ".equip", "snapshots", "claude-code", ".initial-taken");
    assert.ok(!fs.existsSync(markerPath), ".initial-taken should not exist for manual snapshots");
  });

  it("hasInitialSnapshot uses marker for O(1) lookup", () => {
    const p = makePlatform("claude-code");

    // No marker → false
    assert.equal(hasInitialSnapshot("claude-code"), false);

    // Create first-detection snapshot → marker written → true
    createSnapshot(p, { trigger: "first-detection" });
    assert.equal(hasInitialSnapshot("claude-code"), true);

    // Delete the snapshot file but leave the marker — still true (fast path)
    const snaps = listSnapshots("claude-code");
    for (const s of snaps) deleteSnapshot("claude-code", s.id);
    assert.equal(hasInitialSnapshot("claude-code"), true, "marker survives snapshot deletion");
  });
});
