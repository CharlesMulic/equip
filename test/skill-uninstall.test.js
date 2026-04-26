// Tests for Package 02 of equip-skill-ownership: uninstall with ownership.
// Covers: clean uninstall path, user-modified file preservation, foreign-content
// preservation + tombstone manifests, manifest-absent fallback (legacy), refusal
// when manifest names a different augment, dry-run reporting, idempotent
// uninstall on tombstones.

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { installSkill, uninstallSkill } = require("../dist/lib/skills");
const {
  readManifest,
  writeManifest,
  buildManifestForInstall,
  buildTombstoneManifest,
  isTombstone,
} = require("../dist/lib/skill-manifest");

let tempHome;
const origHomedir = os.homedir;

function setupTempHome() {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-uninstall-"));
  os.homedir = () => tempHome;
}

function teardownTempHome() {
  os.homedir = origHomedir;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}

function mockPlatform() {
  const skillsPath = path.join(tempHome, ".claude", "skills");
  fs.mkdirSync(skillsPath, { recursive: true });
  return {
    platform: "claude-code",
    configPath: path.join(tempHome, ".claude", "config.json"),
    rootKey: "mcpServers",
    configFormat: "json",
    rulesPath: path.join(tempHome, ".claude", "CLAUDE.md"),
    skillsPath,
  };
}

const MULTI_FILE_SKILL = {
  name: "multi",
  files: [
    { path: "SKILL.md", content: "---\nname: multi\ndescription: x\n---\n# Multi\n" },
    { path: "scripts/run.sh", content: "#!/bin/bash\necho hi\n" },
    { path: "references/api.md", content: "# API\n" },
  ],
};

describe("uninstallSkill — manifest-driven clean uninstall", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("removes the entire skill dir when nothing is preserved", () => {
    const p = mockPlatform();
    installSkill(p, "prior", MULTI_FILE_SKILL, { source: "registry" });

    const r = uninstallSkill(p, "prior", "multi");
    assert.equal(r.removed, true);
    assert.equal(r.viaManifest, true);
    assert.equal(r.tombstone, false);
    assert.deepEqual(r.preservedFiles, []);
    assert.ok(!fs.existsSync(path.join(p.skillsPath, "multi")));
  });

  it("preserves user-modified Equip files and writes a tombstone", () => {
    const p = mockPlatform();
    installSkill(p, "prior", MULTI_FILE_SKILL, { source: "registry" });
    const skillDir = path.join(p.skillsPath, "multi");

    // User edits the SKILL.md.
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "USER EDITED THIS");

    const r = uninstallSkill(p, "prior", "multi");
    assert.equal(r.removed, true);
    assert.equal(r.viaManifest, true);
    assert.equal(r.tombstone, true);
    assert.deepEqual(r.preservedFiles, ["SKILL.md"]);

    // Untouched Equip files are gone.
    assert.ok(!fs.existsSync(path.join(skillDir, "scripts", "run.sh")));
    assert.ok(!fs.existsSync(path.join(skillDir, "references", "api.md")));
    // Modified file survives.
    assert.equal(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8"), "USER EDITED THIS");
    // Tombstone manifest exists.
    const m = readManifest(skillDir);
    assert.ok(isTombstone(m));
    assert.equal(m.tombstone.uninstalledBy, "prior");
    assert.deepEqual(m.tombstone.preservedFiles, ["SKILL.md"]);
  });

  it("preserves user-added foreign files and writes a tombstone", () => {
    const p = mockPlatform();
    installSkill(p, "prior", MULTI_FILE_SKILL, { source: "registry" });
    const skillDir = path.join(p.skillsPath, "multi");

    // User drops in their own notes file.
    fs.writeFileSync(path.join(skillDir, "personal-notes.md"), "my thoughts");

    const r = uninstallSkill(p, "prior", "multi");
    assert.equal(r.removed, true);
    assert.equal(r.tombstone, true);
    // Foreign file is not in `preservedFiles` returned (that field tracks drifted Equip files only),
    // but tombstone manifest records it for forensics.
    assert.deepEqual(r.preservedFiles, []);

    assert.ok(fs.existsSync(path.join(skillDir, "personal-notes.md")));
    assert.equal(fs.readFileSync(path.join(skillDir, "personal-notes.md"), "utf-8"), "my thoughts");

    const m = readManifest(skillDir);
    assert.ok(m.tombstone.preservedFiles.includes("personal-notes.md"));
  });

  it("removes empty subdirs (scripts/, references/) when their content is fully removed", () => {
    const p = mockPlatform();
    installSkill(p, "prior", MULTI_FILE_SKILL, { source: "registry" });
    const skillDir = path.join(p.skillsPath, "multi");
    assert.ok(fs.existsSync(path.join(skillDir, "scripts")));
    assert.ok(fs.existsSync(path.join(skillDir, "references")));

    const r = uninstallSkill(p, "prior", "multi");
    assert.equal(r.tombstone, false);
    assert.equal(r.removed, true);
    // Whole tree gone.
    assert.ok(!fs.existsSync(skillDir));
  });

  it("keeps a parent subdir if user added a foreign file inside it", () => {
    const p = mockPlatform();
    installSkill(p, "prior", MULTI_FILE_SKILL, { source: "registry" });
    const skillDir = path.join(p.skillsPath, "multi");
    fs.writeFileSync(path.join(skillDir, "scripts", "user-script.sh"), "#!/bin/bash\necho mine\n");

    const r = uninstallSkill(p, "prior", "multi");
    assert.equal(r.tombstone, true);

    assert.ok(fs.existsSync(path.join(skillDir, "scripts", "user-script.sh")));
    assert.ok(!fs.existsSync(path.join(skillDir, "scripts", "run.sh")));

    const m = readManifest(skillDir);
    assert.ok(m.tombstone.preservedFiles.includes("scripts/user-script.sh"));
  });
});

describe("uninstallSkill — refusal when not the owner", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("refuses to remove a skill whose manifest names a different augment", () => {
    const p = mockPlatform();
    // Augment-A installs the skill.
    installSkill(p, "augment-a", MULTI_FILE_SKILL, { source: "registry" });

    // Augment-B tries to uninstall it.
    const r = uninstallSkill(p, "augment-b", "multi");
    assert.equal(r.removed, false);
    assert.equal(r.tombstone, false);

    // Augment-A's content untouched.
    assert.ok(fs.existsSync(path.join(p.skillsPath, "multi", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(p.skillsPath, "multi", "scripts", "run.sh")));
    const m = readManifest(path.join(p.skillsPath, "multi"));
    assert.equal(m.owners[0].augment, "augment-a");
  });
});

describe("uninstallSkill — tombstone idempotence", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("uninstall on an already-tombstoned dir is a no-op", () => {
    const p = mockPlatform();
    installSkill(p, "prior", MULTI_FILE_SKILL, { source: "registry" });
    const skillDir = path.join(p.skillsPath, "multi");
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "USER EDIT");

    // First uninstall — leaves tombstone.
    const r1 = uninstallSkill(p, "prior", "multi");
    assert.equal(r1.tombstone, true);

    // Second uninstall — should not touch anything.
    const tombstoneMtime = fs.statSync(path.join(skillDir, ".equip-meta.json")).mtimeMs;
    const start = Date.now();
    while (Date.now() - start < 20) { /* spin */ }

    const r2 = uninstallSkill(p, "prior", "multi");
    assert.equal(r2.removed, false, "tombstone case should not report removal");
    assert.equal(r2.tombstone, false, "tombstone case should not write a NEW tombstone");
    assert.ok(fs.existsSync(path.join(skillDir, "SKILL.md")), "user content still there");
    const tombstoneMtime2 = fs.statSync(path.join(skillDir, ".equip-meta.json")).mtimeMs;
    assert.equal(tombstoneMtime, tombstoneMtime2, "tombstone manifest mtime unchanged");
  });
});

describe("uninstallSkill — manifest-absent fallback", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("falls back to recursive delete when manifest is missing (no regression vs pre-Package-02)", () => {
    const p = mockPlatform();
    // Plant a skill dir with no manifest (e.g., from older equip OR partial install crash).
    const skillDir = path.join(p.skillsPath, "legacy-flat");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "no manifest");
    fs.writeFileSync(path.join(skillDir, "extra.md"), "user content");

    const r = uninstallSkill(p, "prior", "legacy-flat");
    assert.equal(r.removed, true);
    assert.equal(r.viaManifest, false, "fallback path should report viaManifest=false");
    // Legacy fallback is recursive — user content lost (acceptable; no regression).
    assert.ok(!fs.existsSync(skillDir));
  });

  it("falls back to recursive delete when manifest is corrupt", () => {
    const p = mockPlatform();
    const skillDir = path.join(p.skillsPath, "broken");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "x");
    fs.writeFileSync(path.join(skillDir, ".equip-meta.json"), "{not json");

    const r = uninstallSkill(p, "prior", "broken");
    assert.equal(r.removed, true);
    assert.equal(r.viaManifest, false);
    assert.ok(!fs.existsSync(skillDir));
  });
});

describe("uninstallSkill — dry-run reporting", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("reports preserved files in dry-run without touching disk", () => {
    const p = mockPlatform();
    installSkill(p, "prior", MULTI_FILE_SKILL, { source: "registry" });
    const skillDir = path.join(p.skillsPath, "multi");
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "USER EDIT");

    const r = uninstallSkill(p, "prior", "multi", true /* dryRun */);
    assert.deepEqual(r.preservedFiles, ["SKILL.md"]);
    // Disk untouched.
    assert.ok(fs.existsSync(path.join(skillDir, "scripts", "run.sh")));
    assert.equal(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8"), "USER EDIT");
    assert.ok(!isTombstone(readManifest(skillDir)));
  });
});

describe("buildTombstoneManifest / isTombstone", () => {
  it("isTombstone returns false for live manifests", () => {
    const m = buildManifestForInstall({
      skill: MULTI_FILE_SKILL,
      toolName: "prior",
      source: "registry",
      platformId: "claude-code",
      skillsRoot: "/tmp",
      equipVersion: "1.0.0",
    });
    assert.equal(isTombstone(m), false);
  });

  it("isTombstone returns true for tombstone manifests", () => {
    const live = buildManifestForInstall({
      skill: MULTI_FILE_SKILL,
      toolName: "prior",
      source: "registry",
      platformId: "claude-code",
      skillsRoot: "/tmp",
      equipVersion: "1.0.0",
    });
    const t = buildTombstoneManifest({
      previous: live,
      uninstalledBy: "prior",
      preservedFiles: ["SKILL.md"],
    });
    assert.equal(isTombstone(t), true);
    assert.equal(t.owners.length, 0);
    assert.deepEqual(t.tombstone.preservedFiles, ["SKILL.md"]);
  });

  it("tombstone schema round-trips through readManifest / writeManifest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-rt-"));
    const live = buildManifestForInstall({
      skill: MULTI_FILE_SKILL,
      toolName: "prior",
      source: "registry",
      platformId: "claude-code",
      skillsRoot: "/tmp",
      equipVersion: "1.0.0",
    });
    const t = buildTombstoneManifest({
      previous: live,
      uninstalledBy: "prior",
      preservedFiles: ["SKILL.md", "personal-notes.md"],
    });
    writeManifest(dir, t);
    const read = readManifest(dir);
    assert.deepEqual(read, t);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
