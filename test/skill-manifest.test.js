// Tests for skill-manifest module: read, write, build, hash entries, schema invariants.
// Node 18+ built-in test runner, zero dependencies.

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");

const {
  MANIFEST_FILENAME,
  manifestPath,
  readManifest,
  writeManifest,
  buildManifestForInstall,
  computeFileEntries,
  manifestSoleOwner,
  findOwner,
} = require("../dist/lib/skill-manifest");

function tmpDir(prefix = "manifest-test") {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}

const SAMPLE_SKILL = {
  name: "search",
  files: [
    { path: "SKILL.md", content: "---\nname: search\ndescription: Find things\n---\n# Search\n" },
    { path: "scripts/run.sh", content: "#!/bin/bash\necho hi\n" },
  ],
};

describe("skill-manifest constants", () => {
  it("filename is the dot-prefixed sentinel", () => {
    assert.equal(MANIFEST_FILENAME, ".equip-meta.json");
  });

  it("manifestPath joins skill dir with filename", () => {
    assert.equal(manifestPath("/tmp/foo"), path.join("/tmp/foo", ".equip-meta.json"));
  });
});

describe("computeFileEntries", () => {
  it("hashes file contents with sha256", () => {
    const entries = computeFileEntries(SAMPLE_SKILL);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].path, "SKILL.md");
    assert.equal(entries[0].hash.algorithm, "sha256");
    assert.equal(entries[0].hash.value, sha256(SAMPLE_SKILL.files[0].content));
    assert.equal(entries[0].size, Buffer.byteLength(SAMPLE_SKILL.files[0].content, "utf-8"));
  });

  it("preserves input file order for stable diffs", () => {
    const entries = computeFileEntries(SAMPLE_SKILL);
    assert.deepEqual(entries.map(e => e.path), ["SKILL.md", "scripts/run.sh"]);

    const reversed = { ...SAMPLE_SKILL, files: [...SAMPLE_SKILL.files].reverse() };
    const reversedEntries = computeFileEntries(reversed);
    assert.deepEqual(reversedEntries.map(e => e.path), ["scripts/run.sh", "SKILL.md"]);
  });

  it("produces identical output for identical inputs (deterministic)", () => {
    const a = computeFileEntries(SAMPLE_SKILL);
    const b = computeFileEntries(SAMPLE_SKILL);
    assert.deepEqual(a, b);
  });
});

describe("buildManifestForInstall", () => {
  it("produces a v1 manifest with required fields", () => {
    const m = buildManifestForInstall({
      skill: SAMPLE_SKILL,
      toolName: "prior",
      augmentVersion: 7,
      source: "registry",
      package: "@cg3/prior-node",
      platformId: "claude-code",
      skillsRoot: "/home/x/.claude/skills",
      equipVersion: "0.18.0",
      installedAt: "2026-04-25T12:00:00Z",
    });
    assert.equal(m.manifestVersion, 1);
    assert.equal(m.skill, "search");
    assert.equal(m.owners.length, 1);
    assert.equal(m.owners[0].augment, "prior");
    assert.equal(m.owners[0].augmentVersion, 7);
    assert.equal(m.owners[0].platform, "claude-code");
    assert.equal(m.owners[0].source, "registry");
    assert.equal(m.owners[0].package, "@cg3/prior-node");
    assert.equal(m.owners[0].installedAt, "2026-04-25T12:00:00Z");
    assert.equal(m.install.skillsRoot, "/home/x/.claude/skills");
    assert.equal(m.install.equipVersion, "0.18.0");
    assert.equal(m.files.length, 2);
  });

  it("defaults augmentVersion to 0 and omits package when not provided", () => {
    const m = buildManifestForInstall({
      skill: SAMPLE_SKILL,
      toolName: "local-aug",
      source: "local",
      platformId: "cursor",
      skillsRoot: "/tmp/skills",
      equipVersion: "0.18.0",
    });
    assert.equal(m.owners[0].augmentVersion, 0);
    assert.equal(m.owners[0].package, undefined);
    assert.equal(m.owners[0].source, "local");
  });

  it("uses now() for installedAt by default (ISO 8601)", () => {
    const m = buildManifestForInstall({
      skill: SAMPLE_SKILL,
      toolName: "x",
      source: "local",
      platformId: "claude-code",
      skillsRoot: "/tmp",
      equipVersion: "1.0.0",
    });
    assert.match(m.owners[0].installedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("readManifest / writeManifest", () => {
  it("returns null when manifest is missing", () => {
    const dir = tmpDir();
    assert.equal(readManifest(dir), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("write then read round-trips", () => {
    const dir = tmpDir();
    const m = buildManifestForInstall({
      skill: SAMPLE_SKILL,
      toolName: "prior",
      source: "registry",
      platformId: "claude-code",
      skillsRoot: "/home/x/.claude/skills",
      equipVersion: "0.18.0",
    });
    writeManifest(dir, m);
    const read = readManifest(dir);
    assert.deepEqual(read, m);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves unknown top-level fields on round-trip (forward-compat)", () => {
    const dir = tmpDir();
    const m = buildManifestForInstall({
      skill: SAMPLE_SKILL,
      toolName: "prior",
      source: "registry",
      platformId: "claude-code",
      skillsRoot: "/home/x/.claude/skills",
      equipVersion: "0.18.0",
    });
    // Future schema extension fields land here.
    const extended = { ...m, tombstone: { uninstalledAt: "2026-05-01T00:00:00Z" }, loadout: { name: "work" } };
    writeManifest(dir, extended);
    const read = readManifest(dir);
    assert.deepEqual(read.tombstone, { uninstalledAt: "2026-05-01T00:00:00Z" });
    assert.deepEqual(read.loadout, { name: "work" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws on missing manifestVersion (corrupt schema)", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".equip-meta.json"), JSON.stringify({ skill: "search" }));
    assert.throws(() => readManifest(dir), /missing manifestVersion/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws on unparseable JSON", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".equip-meta.json"), "{not valid json");
    assert.throws(() => readManifest(dir), /corrupt|unreadable/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writeManifest does not touch sibling files", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# original");
    const m = buildManifestForInstall({
      skill: SAMPLE_SKILL,
      toolName: "prior",
      source: "local",
      platformId: "claude-code",
      skillsRoot: "/tmp",
      equipVersion: "1.0.0",
    });
    writeManifest(dir, m);
    assert.equal(fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8"), "# original");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("manifestSoleOwner / findOwner", () => {
  function makeManifest(owners) {
    return {
      manifestVersion: 1,
      skill: "search",
      owners,
      files: [],
      install: { skillsRoot: "/tmp", equipVersion: "1.0.0" },
    };
  }

  it("manifestSoleOwner returns the owner when there's exactly one", () => {
    const m = makeManifest([{ augment: "prior", augmentVersion: 1, platform: "claude-code", source: "local", installedAt: "x" }]);
    const owner = manifestSoleOwner(m);
    assert.equal(owner.augment, "prior");
  });

  it("manifestSoleOwner returns null for multi-owner (refcount case)", () => {
    const m = makeManifest([
      { augment: "prior", augmentVersion: 1, platform: "cursor", source: "local", installedAt: "x" },
      { augment: "prior", augmentVersion: 1, platform: "codex", source: "local", installedAt: "x" },
    ]);
    assert.equal(manifestSoleOwner(m), null);
  });

  it("findOwner returns the matching (augment, platform) entry", () => {
    const m = makeManifest([
      { augment: "prior", augmentVersion: 1, platform: "cursor", source: "local", installedAt: "x" },
      { augment: "prior", augmentVersion: 1, platform: "codex", source: "local", installedAt: "x" },
    ]);
    assert.equal(findOwner(m, "prior", "cursor").platform, "cursor");
    assert.equal(findOwner(m, "prior", "codex").platform, "codex");
    assert.equal(findOwner(m, "prior", "claude-code"), null);
    assert.equal(findOwner(m, "other-aug", "cursor"), null);
  });
});
