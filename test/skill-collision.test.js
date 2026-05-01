// Tests for the install-time collision-check decision tree
// Exercises every skill collision branch:
// - Target absent
// - Present with our manifest (update path)
// - Present with no manifest, no installations.json claim (user-authored)
// - Present with no manifest, installations.json claims us (recovery)
// - Present with manifest naming different augment + installations.json confirms (real collision)
// - Present with manifest naming different augment + installations.json doesn't confirm (forged advisory)
// - --takeover overrides cross-augment collision
// - --adopt overrides user-authored
// - Multi-skill augment with one collision continues installing the rest

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { installSkill } = require("../dist/lib/skills");
const { readManifest, writeManifest, buildManifestForInstall } = require("../dist/lib/skill-manifest");
const { setupInstalledAugment } = require("./storage/_test-helpers");
// Phase A: trackInstallation/trackUninstallation are gone. Tests use the
// storage-layer test helper to set up "augment is installed with these skills".
// trackUninstallation calls become no-ops (test isolation handles cleanup).
const trackUninstallation = () => {};
const { Augment } = require("..");
const { setupFullHome } = require("./_isolation");

let isolation, tempHome;

function setupTempHome() {
  isolation = setupFullHome("equip-collision");
  tempHome = isolation.home;
}

function teardownTempHome() {
  isolation.dispose();
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

const SKILL = {
  name: "search",
  files: [{ path: "SKILL.md", content: "---\nname: search\ndescription: x\n---\n# Search\n" }],
};

describe("installSkill collision-check decision tree", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("(A) target absent — installs and writes manifest", () => {
    const p = mockPlatform();
    const r = installSkill(p, "prior", SKILL, { source: "registry" });
    assert.equal(r.success, true);
    assert.equal(r.action, "created");

    const skillDir = path.join(p.skillsPath, "search");
    assert.ok(fs.existsSync(path.join(skillDir, "SKILL.md")));
    const m = readManifest(skillDir);
    assert.equal(m.skill, "search");
    assert.equal(m.owners[0].augment, "prior");
    assert.equal(m.owners[0].source, "registry");
  });

  it("(C) re-install same augment — succeeds, manifest rewritten", () => {
    const p = mockPlatform();
    installSkill(p, "prior", SKILL, { source: "registry", augmentVersion: 1 });
    const r = installSkill(p, "prior", {
      ...SKILL,
      files: [{ path: "SKILL.md", content: "---\nname: search\ndescription: updated\n---\n# v2\n" }],
    }, { source: "registry", augmentVersion: 2 });
    assert.equal(r.success, true);
    assert.equal(r.action, "updated");

    const m = readManifest(path.join(p.skillsPath, "search"));
    assert.equal(m.owners[0].augment, "prior");
    assert.equal(m.owners[0].augmentVersion, 2);
  });

  it("(B1) skill dir exists, no manifest, untracked — refuses without --adopt", () => {
    const p = mockPlatform();
    const skillDir = path.join(p.skillsPath, "search");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "user-authored");
    fs.writeFileSync(path.join(skillDir, "personal.md"), "my notes");

    const r = installSkill(p, "prior", SKILL, { source: "registry" });
    assert.equal(r.success, false);
    assert.equal(r.errorCode, "SKILL_COLLISION_USER_AUTHORED");
    assert.match(r.error, /not tracked by Equip/);

    // User-authored content untouched.
    assert.equal(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8"), "user-authored");
    assert.ok(fs.existsSync(path.join(skillDir, "personal.md")));
  });

  it("(B1 + --adopt) overrides user-authored refusal", () => {
    const p = mockPlatform();
    const skillDir = path.join(p.skillsPath, "search");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "user-authored");

    const r = installSkill(p, "prior", SKILL, { source: "registry", adopt: true });
    assert.equal(r.success, true);
    // SKILL.md was overwritten with our content.
    assert.match(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8"), /name: search/);
    // Manifest now names us.
    const m = readManifest(skillDir);
    assert.equal(m.owners[0].augment, "prior");
  });

  it("(B2) installations.json claims this skill for us — recovery, install proceeds", () => {
    const p = mockPlatform();
    const skillDir = path.join(p.skillsPath, "search");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "stale content");

    // Pretend a prior install crashed before manifest was written.
    setupInstalledAugment("prior", {
      source: "registry",
      title: "Prior",
      transport: "http",
      platforms: ["claude-code"],
      skills: [SKILL],
    });

    const r = installSkill(p, "prior", SKILL, { source: "registry" });
    assert.equal(r.success, true);
    assert.match(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8"), /name: search/);
    assert.ok(readManifest(skillDir));

    trackUninstallation("prior");
  });

  it("(D) cross-augment collision (manifest + installations.json agree on different owner) — refuses", () => {
    const p = mockPlatform();
    // Augment A installed first.
    installSkill(p, "augment-a", SKILL, { source: "registry" });
    setupInstalledAugment("augment-a", {
      source: "registry",
      title: "A",
      transport: "http",
      platforms: ["claude-code"],
      skills: [SKILL],
    });

    // Augment B tries to install same skill name.
    const r = installSkill(p, "augment-b", SKILL, { source: "registry" });
    assert.equal(r.success, false);
    assert.equal(r.errorCode, "SKILL_COLLISION_OTHER_AUGMENT");
    assert.match(r.error, /augment-a/);
    assert.match(r.error, /takeover/);

    // Augment A's manifest still names augment-a.
    const m = readManifest(path.join(p.skillsPath, "search"));
    assert.equal(m.owners[0].augment, "augment-a");

    trackUninstallation("augment-a");
  });

  it("(D + --takeover) overrides cross-augment collision", () => {
    const p = mockPlatform();
    installSkill(p, "augment-a", SKILL, { source: "registry" });
    setupInstalledAugment("augment-a", {
      source: "registry",
      title: "A",
      transport: "http",
      platforms: ["claude-code"],
      skills: [SKILL],
    });

    const newSkill = {
      ...SKILL,
      files: [{ path: "SKILL.md", content: "---\nname: search\ndescription: B\n---\n# B\n" }],
    };
    const r = installSkill(p, "augment-b", newSkill, { source: "registry", takeover: true });
    assert.equal(r.success, true);

    // Manifest now names augment-b.
    const m = readManifest(path.join(p.skillsPath, "search"));
    assert.equal(m.owners[0].augment, "augment-b");
    assert.match(fs.readFileSync(path.join(p.skillsPath, "search", "SKILL.md"), "utf-8"), /description: B/);

    trackUninstallation("augment-a");
    trackUninstallation("augment-b");
  });

  it("(E) forged manifest names augment installations.json doesn't know — falls through to user-authored handling", () => {
    const p = mockPlatform();
    const skillDir = path.join(p.skillsPath, "search");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "user-authored");

    // Plant a forged manifest claiming ownership by a non-existent augment.
    const forged = buildManifestForInstall({
      skill: SKILL,
      toolName: "ghost-augment",
      source: "registry",
      platformId: "claude-code",
      skillsRoot: p.skillsPath,
      equipVersion: "1.0.0",
    });
    writeManifest(skillDir, forged);

    // installations.json knows nothing of "ghost-augment". Forged advisory should
    // be ignored; behavior collapses to user-authored — refuse without --adopt.
    const r = installSkill(p, "prior", SKILL, { source: "registry" });
    assert.equal(r.success, false);
    // Collapses to user-authored bucket since forged manifest isn't trusted.
    assert.ok(
      r.errorCode === "SKILL_COLLISION_USER_AUTHORED"
        || r.errorCode === "SKILL_COLLISION_FORGED_MANIFEST",
      `expected user-authored or forged code, got ${r.errorCode}`,
    );
  });

  it("(E + --adopt) overrides forged-manifest path", () => {
    const p = mockPlatform();
    const skillDir = path.join(p.skillsPath, "search");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "user-authored");

    const forged = buildManifestForInstall({
      skill: SKILL,
      toolName: "ghost-augment",
      source: "registry",
      platformId: "claude-code",
      skillsRoot: p.skillsPath,
      equipVersion: "1.0.0",
    });
    writeManifest(skillDir, forged);

    const r = installSkill(p, "prior", SKILL, { source: "registry", adopt: true });
    assert.equal(r.success, true);

    const m = readManifest(skillDir);
    assert.equal(m.owners[0].augment, "prior");
  });

  it("manifest write is the LAST step (atomic) — failed file write leaves no manifest claiming success", () => {
    // Indirect test: install a skill, verify manifest exists ONLY after files exist.
    // The atomic-write order guarantee is enforced by code structure, not run-time check.
    const p = mockPlatform();
    installSkill(p, "prior", SKILL, { source: "registry" });
    const skillDir = path.join(p.skillsPath, "search");
    assert.ok(fs.existsSync(path.join(skillDir, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(skillDir, ".equip-meta.json")));
  });

  it("dry-run does not write manifest", () => {
    const p = mockPlatform();
    installSkill(p, "prior", SKILL, { source: "registry", dryRun: true });
    assert.ok(!fs.existsSync(path.join(p.skillsPath, "search")));
  });

  it("manifest is current → manifest write skipped (no-op idempotent install)", () => {
    const p = mockPlatform();
    installSkill(p, "prior", SKILL, { source: "registry" });
    const firstMtime = fs.statSync(path.join(p.skillsPath, "search", ".equip-meta.json")).mtimeMs;

    // Sleep briefly to ensure mtime would change if rewritten.
    const start = Date.now();
    while (Date.now() - start < 20) { /* spin */ }

    const r = installSkill(p, "prior", SKILL, { source: "registry" });
    assert.equal(r.action, "skipped");
    const secondMtime = fs.statSync(path.join(p.skillsPath, "search", ".equip-meta.json")).mtimeMs;
    assert.equal(firstMtime, secondMtime, "manifest should not be rewritten when no-op");
  });
});

// ─── Augment class: partial augment install ──────────

describe("Augment.installSkill — partial install when one of N skills collides", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("continues installing other skills when one collides; surfaces collision in result", () => {
    const p = mockPlatform();

    // Augment A pre-installs `search`.
    installSkill(p, "augment-a", SKILL, { source: "registry" });
    setupInstalledAugment("augment-a", {
      source: "registry",
      title: "A",
      transport: "http",
      platforms: ["claude-code"],
      skills: [SKILL],
    });

    // Augment B ships [search, contribute, feedback] — only `search` collides.
    const augmentB = new Augment({
      name: "augment-b",
      serverUrl: "https://example.com",
      source: "registry",
      skills: [
        { name: "search", files: [{ path: "SKILL.md", content: "---\nname: search\ndescription: B\n---" }] },
        { name: "contribute", files: [{ path: "SKILL.md", content: "---\nname: contribute\ndescription: x\n---" }] },
        { name: "feedback", files: [{ path: "SKILL.md", content: "---\nname: feedback\ndescription: x\n---" }] },
      ],
    });

    const r = augmentB.installSkill(p);

    // Partial success — some installed, some refused.
    assert.equal(r.success, true, "partial-install treated as success since 2/3 landed");
    assert.equal(r.errorCode, "SKILL_COLLISION_OTHER_AUGMENT");
    assert.match(r.error, /1\/3 skill refused/);

    // Non-colliding skills landed.
    assert.ok(fs.existsSync(path.join(p.skillsPath, "contribute", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(p.skillsPath, "feedback", "SKILL.md")));

    // Colliding skill still owned by augment-a.
    const searchManifest = readManifest(path.join(p.skillsPath, "search"));
    assert.equal(searchManifest.owners[0].augment, "augment-a");

    trackUninstallation("augment-a");
  });

  it("treats all-skills-colliding as a full failure", () => {
    const p = mockPlatform();

    installSkill(p, "augment-a", SKILL, { source: "registry" });
    setupInstalledAugment("augment-a", {
      source: "registry",
      title: "A",
      transport: "http",
      platforms: ["claude-code"],
      skills: [SKILL],
    });

    const augmentB = new Augment({
      name: "augment-b",
      serverUrl: "https://example.com",
      source: "registry",
      skills: [
        { name: "search", files: [{ path: "SKILL.md", content: "x" }] },
      ],
    });

    const r = augmentB.installSkill(p);
    assert.equal(r.success, false, "single colliding skill = full failure (no partial)");
    assert.equal(r.errorCode, "SKILL_COLLISION_OTHER_AUGMENT");

    trackUninstallation("augment-a");
  });
});
