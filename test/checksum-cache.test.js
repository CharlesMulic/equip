// Tests for Package 04 of equip-skill-ownership: mtime-keyed checksum cache
// + lazy verification.
//
// Coverage:
//  - cache hit/miss semantics (mtime mismatch, size mismatch, missing file)
//  - cache file corruption + recovery
//  - install seeds the cache; uninstall prunes
//  - verifyFileAgainstManifest uses the cache fast path
//  - cache is independent of the manifest (works without one)

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");

const {
  getCachedHash,
  setCachedHash,
  setCachedHashes,
  pruneCacheEntries,
  pruneStaleEntries,
  _clearCacheFileForTesting,
} = require("../dist/lib/checksum-cache");
const { verifyFileAgainstManifest } = require("../dist/lib/skill-manifest");
const { installSkill, uninstallSkill } = require("../dist/lib/skills");

let tempHome;
const origHomedir = os.homedir;

function setupTempHome() {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-cache-"));
  os.homedir = () => tempHome;
  process.env.EQUIP_HOME = require("path").join(tempHome, ".equip");
  require("fs").mkdirSync(process.env.EQUIP_HOME, { recursive: true });
}

function teardownTempHome() {
  os.homedir = origHomedir;
  delete process.env.EQUIP_HOME;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-file-"));
  const filePath = path.join(dir, "file.txt");
  fs.writeFileSync(filePath, content);
  return { filePath, dir, sha256: sha256OfString(content) };
}

function sha256OfString(s) {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
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
  name: "lookup",
  files: [
    { path: "SKILL.md", content: "---\nname: lookup\ndescription: x\n---\n# Lookup\n" },
    { path: "scripts/run.sh", content: "#!/bin/bash\necho hi\n" },
  ],
};

describe("checksum-cache — getCachedHash / setCachedHash", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("returns null when no entry is cached", () => {
    const { filePath, dir } = tmpFile("hello");
    assert.equal(getCachedHash(filePath), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the cached hash on hit (mtime + size match)", () => {
    const { filePath, dir, sha256 } = tmpFile("hello world");
    setCachedHash(filePath, sha256);
    assert.equal(getCachedHash(filePath), sha256);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when mtime changes (file rewritten)", () => {
    const { filePath, dir, sha256 } = tmpFile("abc");
    setCachedHash(filePath, sha256);
    // Rewrite the file with new content (changes mtime).
    // Wait briefly to ensure mtime resolution captures the change on systems
    // with low precision (FAT, some macOS configs).
    const start = Date.now();
    while (Date.now() - start < 20) { /* spin */ }
    fs.writeFileSync(filePath, "different");
    assert.equal(getCachedHash(filePath), null, "mtime drift should invalidate cache");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when size changes but mtime accidentally matches", () => {
    const { filePath, dir, sha256 } = tmpFile("abc");
    setCachedHash(filePath, sha256);
    // Restore stat to the cached mtime/size, then rewrite with different content
    // and a different size, then forcibly reset mtime back. Size mismatch alone
    // must invalidate.
    const cached = fs.statSync(filePath);
    fs.writeFileSync(filePath, "completely different content here");
    fs.utimesSync(filePath, cached.atime, cached.mtime);
    assert.equal(getCachedHash(filePath), null, "size drift should invalidate cache");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the file no longer exists", () => {
    const { filePath, dir, sha256 } = tmpFile("x");
    setCachedHash(filePath, sha256);
    fs.unlinkSync(filePath);
    assert.equal(getCachedHash(filePath), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("setCachedHash on a missing file is a silent no-op", () => {
    const ghostPath = path.join(tempHome, "ghost.txt");
    setCachedHash(ghostPath, "deadbeef");
    assert.equal(getCachedHash(ghostPath), null);
  });
});

describe("checksum-cache — batched + prune", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("setCachedHashes writes multiple entries in one read/write cycle", () => {
    const a = tmpFile("a content");
    const b = tmpFile("b content");
    setCachedHashes([
      { filePath: a.filePath, sha256: a.sha256 },
      { filePath: b.filePath, sha256: b.sha256 },
    ]);
    assert.equal(getCachedHash(a.filePath), a.sha256);
    assert.equal(getCachedHash(b.filePath), b.sha256);
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(b.dir, { recursive: true, force: true });
  });

  it("pruneCacheEntries removes named entries; leaves others intact", () => {
    const a = tmpFile("aa");
    const b = tmpFile("bb");
    setCachedHashes([
      { filePath: a.filePath, sha256: a.sha256 },
      { filePath: b.filePath, sha256: b.sha256 },
    ]);
    pruneCacheEntries([a.filePath]);
    assert.equal(getCachedHash(a.filePath), null);
    assert.equal(getCachedHash(b.filePath), b.sha256);
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(b.dir, { recursive: true, force: true });
  });

  it("pruneStaleEntries drops entries whose files are gone", () => {
    const a = tmpFile("aa");
    const b = tmpFile("bb");
    setCachedHashes([
      { filePath: a.filePath, sha256: a.sha256 },
      { filePath: b.filePath, sha256: b.sha256 },
    ]);
    fs.unlinkSync(a.filePath);
    const pruned = pruneStaleEntries();
    assert.equal(pruned, 1);
    assert.equal(getCachedHash(b.filePath), b.sha256);
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(b.dir, { recursive: true, force: true });
  });
});

describe("checksum-cache — corruption recovery", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("treats corrupt cache file as empty (graceful fallback)", () => {
    fs.mkdirSync(path.join(tempHome, ".equip"), { recursive: true });
    fs.writeFileSync(path.join(tempHome, ".equip", "checksum-cache.json"), "{not json");
    const { filePath, dir } = tmpFile("recovery");
    // First read: cache corrupt → null. setCachedHash should rewrite a clean file.
    assert.equal(getCachedHash(filePath), null);
    setCachedHash(filePath, "feedface");
    assert.equal(getCachedHash(filePath), "feedface");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats missing cache file as empty (no error)", () => {
    _clearCacheFileForTesting();
    const { filePath, dir, sha256 } = tmpFile("hello");
    assert.equal(getCachedHash(filePath), null);
    setCachedHash(filePath, sha256);
    assert.equal(getCachedHash(filePath), sha256);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("verifyFileAgainstManifest — cache fast path", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("uses cached hash when (mtime, size) match — no re-read", () => {
    const { filePath, dir, sha256 } = tmpFile("verify-me");
    setCachedHash(filePath, sha256);

    // Spy on fs.readFileSync so we can detect a re-read.
    const origReadFileSync = fs.readFileSync;
    let readCount = 0;
    fs.readFileSync = function (...args) {
      if (typeof args[0] === "string" && args[0] === filePath) readCount++;
      return origReadFileSync.apply(fs, args);
    };
    try {
      const status = verifyFileAgainstManifest(filePath, { algorithm: "sha256", value: sha256 });
      assert.equal(status, "match");
      assert.equal(readCount, 0, "cache hit should NOT read the file");
    } finally {
      fs.readFileSync = origReadFileSync;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns 'drift' when cached hash exists but expected value differs", () => {
    const { filePath, dir, sha256 } = tmpFile("content");
    setCachedHash(filePath, sha256);
    const status = verifyFileAgainstManifest(filePath, { algorithm: "sha256", value: "ffffffff" });
    assert.equal(status, "drift");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("populates cache lazily when there is no cached entry", () => {
    const { filePath, dir, sha256 } = tmpFile("populate-me");
    assert.equal(getCachedHash(filePath), null);
    const status = verifyFileAgainstManifest(filePath, { algorithm: "sha256", value: sha256 });
    assert.equal(status, "match");
    // After a successful verify the cache should be populated.
    assert.equal(getCachedHash(filePath), sha256);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns 'missing' when file doesn't exist", () => {
    const ghostPath = path.join(tempHome, "ghost-skill", "SKILL.md");
    const status = verifyFileAgainstManifest(ghostPath, { algorithm: "sha256", value: "x" });
    assert.equal(status, "missing");
  });
});

describe("installSkill seeds cache; uninstallSkill prunes", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("install populates cache for every file it writes", () => {
    const p = mockPlatform();
    installSkill(p, "prior", SKILL, { source: "registry" });

    const skillMd = path.join(p.skillsPath, "lookup", "SKILL.md");
    const runSh = path.join(p.skillsPath, "lookup", "scripts", "run.sh");

    const expectedSkillMd = sha256OfString(SKILL.files[0].content);
    const expectedRunSh = sha256OfString(SKILL.files[1].content);

    assert.equal(getCachedHash(skillMd), expectedSkillMd, "SKILL.md hash must be cached after install");
    assert.equal(getCachedHash(runSh), expectedRunSh, "scripts/run.sh hash must be cached after install");
  });

  it("uninstall prunes cache entries for unlinked files", () => {
    const p = mockPlatform();
    installSkill(p, "prior", SKILL, { source: "registry" });

    const skillMd = path.join(p.skillsPath, "lookup", "SKILL.md");
    const runSh = path.join(p.skillsPath, "lookup", "scripts", "run.sh");

    // Sanity: cache entries exist.
    assert.notEqual(getCachedHash(skillMd), null);
    assert.notEqual(getCachedHash(runSh), null);

    uninstallSkill(p, "prior", "lookup");

    // Cache entries should be pruned.
    assert.equal(getCachedHash(skillMd), null, "SKILL.md cache entry must be pruned");
    assert.equal(getCachedHash(runSh), null, "scripts/run.sh cache entry must be pruned");
  });

  it("uninstall preserves cache entries for files left behind (drifted/foreign)", () => {
    const p = mockPlatform();
    installSkill(p, "prior", SKILL, { source: "registry" });
    const skillDir = path.join(p.skillsPath, "lookup");
    const skillMd = path.join(skillDir, "SKILL.md");
    const runSh = path.join(skillDir, "scripts", "run.sh");

    // User edits SKILL.md → drift → preserved on uninstall.
    fs.writeFileSync(skillMd, "USER EDIT");

    const r = uninstallSkill(p, "prior", "lookup");
    assert.deepEqual(r.preservedFiles, ["SKILL.md"]);

    // run.sh was unlinked (matched cache) → entry pruned.
    assert.equal(getCachedHash(runSh), null);

    // SKILL.md was preserved (drifted, not unlinked). The verify path populated
    // the cache lazily with the NEW hash on its read pass — so the cache now
    // reflects current on-disk content (the "USER EDIT" hash), NOT the old one.
    // Future verifies on this preserved file will hit the cache fast path with
    // an accurate hash.
    const userEditHash = sha256OfString("USER EDIT");
    assert.equal(getCachedHash(skillMd), userEditHash, "preserved file's cache entry reflects its current content");
  });
});
