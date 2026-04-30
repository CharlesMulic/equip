// Tests for Package 03 of equip-skill-ownership: refcounted shared-root semantics.
// Closes the latent Cursor/Codex bug where ~/.agents/skills/ shared between
// platforms made "unequip cursor" wipe a skill Codex still owned.
//
// The shared-root case is detected implicitly: if two platforms' skillsPath()
// resolve to the same directory, the manifest at that path will accumulate
// multiple owner entries (one per (augment, platform) tuple). Uninstall removes
// only the requesting owner's entry; files are deleted only when the LAST
// owner unequips.

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { installSkill, uninstallSkill } = require("../dist/lib/skills");
const { readManifest, isTombstone } = require("../dist/lib/skill-manifest");

let tempHome;
const origHomedir = os.homedir;

function setupTempHome() {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-shared-root-"));
  os.homedir = () => tempHome;
  process.env.EQUIP_HOME = require("path").join(tempHome, ".equip");
  require("fs").mkdirSync(process.env.EQUIP_HOME, { recursive: true });
}

function teardownTempHome() {
  os.homedir = origHomedir;
  delete process.env.EQUIP_HOME;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}

/** Two mock platforms sharing one skillsPath — mirrors codex + windsurf both writing to ~/.agents/skills/. */
function mockSharedRoot() {
  const skillsPath = path.join(tempHome, ".agents", "skills");
  fs.mkdirSync(skillsPath, { recursive: true });
  return {
    codex: {
      platform: "codex",
      configPath: path.join(tempHome, ".codex", "config.toml"),
      rootKey: "mcp_servers",
      configFormat: "toml",
      rulesPath: path.join(tempHome, ".codex", "AGENTS.md"),
      skillsPath,
    },
    windsurf: {
      platform: "windsurf",
      configPath: path.join(tempHome, ".codeium", "windsurf", "mcp_config.json"),
      rootKey: "mcpServers",
      configFormat: "json",
      rulesPath: path.join(tempHome, ".codeium", "windsurf", "memories", "global_rules.md"),
      skillsPath, // SAME directory
    },
  };
}

const SKILL = {
  name: "search",
  files: [
    { path: "SKILL.md", content: "---\nname: search\ndescription: x\n---\n# Search\n" },
    { path: "scripts/run.sh", content: "#!/bin/bash\necho hi\n" },
  ],
};

describe("Shared-root install — same augment, multiple platforms", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("second platform install appends to owners[] instead of refusing", () => {
    const { codex, windsurf } = mockSharedRoot();

    // Augment 'prior' installs for codex first.
    const r1 = installSkill(codex, "prior", SKILL, { source: "registry" });
    assert.equal(r1.success, true);
    assert.equal(r1.action, "created");

    let m = readManifest(path.join(codex.skillsPath, "search"));
    assert.equal(m.owners.length, 1);
    assert.equal(m.owners[0].augment, "prior");
    assert.equal(m.owners[0].platform, "codex");

    // Augment 'prior' now installs for windsurf — same physical path.
    const r2 = installSkill(windsurf, "prior", SKILL, { source: "registry" });
    assert.equal(r2.success, true, `windsurf install must not refuse; got ${r2.errorCode}`);

    // Manifest now has BOTH owners.
    m = readManifest(path.join(windsurf.skillsPath, "search"));
    assert.equal(m.owners.length, 2);
    const platforms = m.owners.map(o => o.platform).sort();
    assert.deepEqual(platforms, ["codex", "windsurf"]);
    assert.ok(m.owners.every(o => o.augment === "prior"));
  });

  it("re-installing for an already-registered platform refreshes that owner's entry only", () => {
    const { codex, windsurf } = mockSharedRoot();
    installSkill(codex, "prior", SKILL, { source: "registry", augmentVersion: 1 });
    installSkill(windsurf, "prior", SKILL, { source: "registry", augmentVersion: 1 });

    // Re-install for windsurf with bumped version — windsurf entry should refresh,
    // codex entry should stay intact.
    const r = installSkill(windsurf, "prior", SKILL, { source: "registry", augmentVersion: 2 });
    assert.equal(r.success, true);

    const m = readManifest(path.join(windsurf.skillsPath, "search"));
    assert.equal(m.owners.length, 2);
    const windsurfOwner = m.owners.find(o => o.platform === "windsurf");
    const codexOwner = m.owners.find(o => o.platform === "codex");
    assert.equal(windsurfOwner.augmentVersion, 2);
    assert.equal(codexOwner.augmentVersion, 1, "codex entry must not be touched");
  });
});

describe("Shared-root uninstall — refcount semantics", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("unequipping one platform removes only its owner entry; files survive for the other", () => {
    const { codex, windsurf } = mockSharedRoot();
    installSkill(codex, "prior", SKILL, { source: "registry" });
    installSkill(windsurf, "prior", SKILL, { source: "registry" });
    const skillDir = path.join(codex.skillsPath, "search");
    assert.equal(readManifest(skillDir).owners.length, 2);

    // Unequip codex.
    const r = uninstallSkill(codex, "prior", "search");
    assert.equal(r.removed, true);
    assert.equal(r.viaManifest, true);
    assert.equal(r.tombstone, false, "tombstone NOT written — windsurf still owns");
    assert.deepEqual(r.preservedFiles, []);

    // Files still present.
    assert.ok(fs.existsSync(path.join(skillDir, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(skillDir, "scripts", "run.sh")));

    // Manifest has only windsurf owner now.
    const m = readManifest(skillDir);
    assert.ok(!isTombstone(m));
    assert.equal(m.owners.length, 1);
    assert.equal(m.owners[0].platform, "windsurf");
  });

  it("unequipping the LAST owner triggers full cleanup", () => {
    const { codex, windsurf } = mockSharedRoot();
    installSkill(codex, "prior", SKILL, { source: "registry" });
    installSkill(windsurf, "prior", SKILL, { source: "registry" });
    const skillDir = path.join(codex.skillsPath, "search");

    uninstallSkill(codex, "prior", "search");
    assert.ok(fs.existsSync(path.join(skillDir, "SKILL.md"))); // still there

    const r = uninstallSkill(windsurf, "prior", "search");
    assert.equal(r.removed, true);
    assert.equal(r.viaManifest, true);
    assert.equal(r.tombstone, false, "no preserved/foreign content → full removal");
    assert.ok(!fs.existsSync(skillDir));
  });

  it("last-owner removal preserves user-modified files (Package 02 path still fires)", () => {
    const { codex, windsurf } = mockSharedRoot();
    installSkill(codex, "prior", SKILL, { source: "registry" });
    installSkill(windsurf, "prior", SKILL, { source: "registry" });
    const skillDir = path.join(codex.skillsPath, "search");

    uninstallSkill(codex, "prior", "search");

    // User edits SKILL.md while windsurf still owns it.
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "USER EDIT");

    const r = uninstallSkill(windsurf, "prior", "search");
    assert.equal(r.tombstone, true);
    assert.deepEqual(r.preservedFiles, ["SKILL.md"]);
    assert.equal(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8"), "USER EDIT");
  });

  it("ordering doesn't matter — install codex,windsurf then unequip windsurf,codex", () => {
    const { codex, windsurf } = mockSharedRoot();
    installSkill(codex, "prior", SKILL, { source: "registry" });
    installSkill(windsurf, "prior", SKILL, { source: "registry" });
    const skillDir = path.join(codex.skillsPath, "search");

    uninstallSkill(windsurf, "prior", "search");
    let m = readManifest(skillDir);
    assert.equal(m.owners.length, 1);
    assert.equal(m.owners[0].platform, "codex");

    uninstallSkill(codex, "prior", "search");
    assert.ok(!fs.existsSync(skillDir));
  });
});

describe("Shared-root + cross-augment takeover", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("--takeover wipes ALL prior owners (single + co-owners) — explicit user override", () => {
    const { codex, windsurf } = mockSharedRoot();
    // Augment-A registers for both platforms.
    installSkill(codex, "augment-a", SKILL, { source: "registry" });
    installSkill(windsurf, "augment-a", SKILL, { source: "registry" });
    const skillDir = path.join(codex.skillsPath, "search");
    assert.equal(readManifest(skillDir).owners.length, 2);

    // Phase A migration: storage-layer setup. Augment-a owns "search" skill
    // on codex+windsurf. The new model derives ownership from
    // content.skills × installedPlatforms.
    const { setupInstalledAugment } = require("./storage/_test-helpers");
    setupInstalledAugment("augment-a", {
      source: "registry",
      title: "A",
      transport: "http",
      platforms: ["codex", "windsurf"],
      skills: [SKILL],
    });

    // Augment-B installs for codex with --takeover.
    const r = installSkill(codex, "augment-b", {
      ...SKILL,
      files: [{ path: "SKILL.md", content: "---\nname: search\ndescription: B\n---\n# B\n" }],
    }, { source: "registry", takeover: true });
    assert.equal(r.success, true);

    // Manifest now has only augment-b for codex; A's claims (both codex and windsurf) gone.
    const m = readManifest(skillDir);
    assert.equal(m.owners.length, 1);
    assert.equal(m.owners[0].augment, "augment-b");
    assert.equal(m.owners[0].platform, "codex");

    // Cleanup handled by test isolation (fresh tempHome per test); no explicit
    // trackUninstallation needed.
  });
});

describe("Single-owner manifests (Package 01/02 back-compat)", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("a v1 single-owner manifest still uninstalls correctly under Package 03 logic", () => {
    const { codex } = mockSharedRoot();
    installSkill(codex, "prior", SKILL, { source: "registry" });
    const skillDir = path.join(codex.skillsPath, "search");
    assert.equal(readManifest(skillDir).owners.length, 1);

    const r = uninstallSkill(codex, "prior", "search");
    assert.equal(r.removed, true);
    assert.equal(r.tombstone, false);
    assert.ok(!fs.existsSync(skillDir));
  });
});
