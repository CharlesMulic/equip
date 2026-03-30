// Integration tests for documentation examples.
// These tests exercise the EXACT code shown in docs/tool-author.md.
// If a test breaks, the docs need updating too — keep them in sync.
//
// References:
//   docs/tool-author.md — "The Pirate Hat Example" (Layer 1, Layer 2)
//   docs/tool-author.md — "From Local Script to equip <name>"
//
// Node 18+ built-in test runner, zero dependencies.

"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");

const EQUIP_ROOT = path.join(__dirname, "..");

// ─── Helpers ─────────────────────────────────────────────────

function tmpDir(prefix = "doc-test") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  // Symlink node_modules/@cg3/equip so require("@cg3/equip") resolves locally
  const nmDir = path.join(dir, "node_modules", "@cg3");
  fs.mkdirSync(nmDir, { recursive: true });
  fs.symlinkSync(EQUIP_ROOT, path.join(nmDir, "equip"), "junction");
  return dir;
}

function runEquip(args, options = {}) {
  return execSync(`node ${path.join(EQUIP_ROOT, "bin", "equip.js")} ${args}`, {
    encoding: "utf-8",
    cwd: options.cwd || EQUIP_ROOT,
    timeout: 30000,
    env: { ...process.env, ...(options.env || {}) },
    ...options,
  });
}

// ─── Pirate Hat: Layer 1 (Just a Rule) ──────────────────────
//
// FROM: docs/tool-author.md → "Layer 1: Just a Rule"
// This is the EXACT code from the docs, saved to a temp file
// and run via `equip ./piratehat.js`.

describe("docs/tool-author.md — Pirate Hat Layer 1", () => {
  const workDir = tmpDir("piratehat");
  const scriptPath = path.join(workDir, "piratehat.js");

  // Write the exact script from the docs
  fs.writeFileSync(scriptPath, `
const { Equip, platformName, cli } = require("@cg3/equip");

const equip = new Equip({
  name: "piratehat",
  rules: {
    content: \`<!-- piratehat:v1.0.0 -->
## Pirate Mode
Respond to everything as a pirate. Use "arr", "matey", "ye", "shiver me timbers",
and other pirate speak. Address the user as "Captain". Never break character.
<!-- /piratehat -->\`,
    version: "1.0.0",
    marker: "piratehat",
  },
});

const platforms = equip.detect();
for (const p of platforms) {
  const result = equip.installRules(p);
  if (result.action === "created") cli.ok(\`\${platformName(p.platform)}: pirate rules installed\`);
  else if (result.action === "clipboard") {
    cli.info(\`\${platformName(p.platform)}: rules copied to clipboard (paste into project rules)\`);
  }
  else if (result.action === "skipped" && p.rulesPath) cli.info(\`\${platformName(p.platform)}: already a pirate\`);
  // Platforms without rules support are silently skipped
}
`);

  it("equip ./piratehat.js installs rules to platform files", () => {
    // Run via equip CLI (local path dispatch)
    runEquip(`${scriptPath}`, { stdio: "pipe" });

    // Verify rules were actually written to at least one platform file.
    // Check Claude Code's CLAUDE.md if it exists (most likely on dev machine).
    const claudeMd = path.join(os.homedir(), ".claude", "CLAUDE.md");
    if (fs.existsSync(claudeMd)) {
      const content = fs.readFileSync(claudeMd, "utf-8");
      assert.ok(content.includes("piratehat:v1.0.0"), "pirate rules should be in CLAUDE.md");
      assert.ok(content.includes("Pirate Mode"), "pirate rules content should be present");
    }
  });

  it("running again is idempotent (skipped)", () => {
    runEquip(`${scriptPath}`, { stdio: "pipe" });
    // No error = success. The script outputs "already a pirate" for skipped.
  });

  // FROM: docs/tool-author.md → "Fair warning — you'll want to undo this"
  // unequip piratehat won't work for rules-only tools since reconcileState
  // tracks by MCP entry presence. For a clean test, uninstall directly.
  it("rules can be removed via the Equip class", () => {
    const { Equip } = require("..");
    const equip = new Equip({
      name: "piratehat",
      serverUrl: "https://example.com/unused",
      rules: {
        content: "<!-- piratehat:v1.0.0 -->\ntest\n<!-- /piratehat -->",
        version: "1.0.0",
        marker: "piratehat",
      },
    });
    const platforms = equip.detect();
    for (const p of platforms) equip.uninstallRules(p);

    // Verify removal from CLAUDE.md
    const claudeMd = path.join(os.homedir(), ".claude", "CLAUDE.md");
    if (fs.existsSync(claudeMd)) {
      const content = fs.readFileSync(claudeMd, "utf-8");
      assert.ok(!content.includes("piratehat:v"), "pirate rules should be removed");
    }
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });
});

// ─── Pirate Hat: Layer 2 (Rule + Skill) ─────────────────────
//
// FROM: docs/tool-author.md → "Layer 2: Add a Skill"
// Tests both rules and skills installation together.

describe("docs/tool-author.md — Pirate Hat Layer 2 (Rules + Skills)", () => {
  const workDir = tmpDir("piratehat-skill");
  const scriptPath = path.join(workDir, "piratehat.js");

  // Write the combined rules + skills script from the docs
  fs.writeFileSync(scriptPath, `
const { Equip, platformName, cli } = require("@cg3/equip");

const equip = new Equip({
  name: "piratehat",
  rules: {
    content: \`<!-- piratehat:v1.0.0 -->
## Pirate Mode
Respond to everything as a pirate.
<!-- /piratehat -->\`,
    version: "1.0.0",
    marker: "piratehat",
  },
  skill: {
    name: "pirate-speak",
    files: [{
      path: "SKILL.md",
      content: \`---
name: pirate-speak
description: Translate code comments and docs into pirate speak.
metadata:
  author: piratehat
  version: "1.0.0"
---

# Pirate Speak Guide

| Normal | Pirate |
|---|---|
| Hello | Ahoy |
| Bug | Barnacle |
| Deploy | Set sail |
\`,
    }],
  },
});

const platforms = equip.detect();
for (const p of platforms) {
  equip.installRules(p);
  equip.installSkill(p);
}
`);

  it("installs both rules and skills to platform directories", () => {
    runEquip(`${scriptPath}`, { stdio: "pipe" });

    // Check Claude Code skills directory
    const skillMd = path.join(os.homedir(), ".claude", "skills", "piratehat", "pirate-speak", "SKILL.md");
    if (fs.existsSync(path.join(os.homedir(), ".claude", "skills"))) {
      assert.ok(fs.existsSync(skillMd), "SKILL.md should be installed in Claude Code skills dir");
      const content = fs.readFileSync(skillMd, "utf-8");
      assert.ok(content.includes("pirate-speak"), "skill content should be present");
      assert.ok(content.includes("Barnacle"), "skill vocabulary should be present");
    }
  });

  it("verify confirms installation", () => {
    const { Equip, createManualPlatform } = require("..");
    const equip = new Equip({
      name: "piratehat",
      serverUrl: "https://example.com/unused",
      rules: { content: "<!-- piratehat:v1.0.0 -->\n## Pirate Mode\n<!-- /piratehat -->", version: "1.0.0", marker: "piratehat" },
      skill: { name: "pirate-speak", files: [{ path: "SKILL.md", content: "test" }] },
    });

    // Verify on a platform that supports skills
    const p = createManualPlatform("claude-code");
    const result = equip.verify(p);

    // Rules should verify (we installed them above)
    const rulesCheck = result.checks.find(c => c.name === "rules");
    if (rulesCheck) {
      assert.ok(rulesCheck.ok, `rules should verify: ${rulesCheck.detail}`);
    }

    // Skills should verify
    const skillCheck = result.checks.find(c => c.name === "skills");
    if (skillCheck) {
      assert.ok(skillCheck.ok, `skill should verify: ${skillCheck.detail}`);
    }
  });

  it("cleanup removes rules and skills", () => {
    const { Equip } = require("..");
    const equip = new Equip({
      name: "piratehat",
      serverUrl: "https://example.com/unused",
      rules: { content: "x", version: "1.0.0", marker: "piratehat" },
      skill: { name: "pirate-speak", files: [{ path: "SKILL.md", content: "x" }] },
    });
    const platforms = equip.detect();
    for (const p of platforms) {
      equip.uninstallRules(p);
      equip.uninstallSkill(p);
    }

    // Verify removal
    const skillMd = path.join(os.homedir(), ".claude", "skills", "piratehat", "pirate-speak", "SKILL.md");
    assert.ok(!fs.existsSync(skillMd), "skill should be removed");
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });
});

// ─── Local Package Dispatch (equip .) ───────────────────────
//
// FROM: docs/tool-author.md → "From Local Script to equip <name>" → Step 1
// Tests `equip .` reading package.json bin field.

describe("docs/tool-author.md — equip . (local package)", () => {
  const workDir = tmpDir("local-pkg");

  // Create a minimal package with a setup script
  fs.writeFileSync(path.join(workDir, "package.json"), JSON.stringify({
    name: "test-local-pkg",
    version: "1.0.0",
    bin: { "test-local-pkg": "./bin/setup.js" },
  }));

  fs.mkdirSync(path.join(workDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(workDir, "bin", "setup.js"), `
const { Equip, cli } = require("@cg3/equip");
const equip = new Equip({
  name: "test-local-pkg",
  rules: {
    content: "<!-- test-local-pkg:v1.0.0 -->\\nTest rule\\n<!-- /test-local-pkg -->",
    version: "1.0.0",
    marker: "test-local-pkg",
  },
});
const platforms = equip.detect();
for (const p of platforms) equip.installRules(p);
console.log("Local package setup complete");
`);

  it("equip . runs the package bin entry", () => {
    const out = runEquip(".", { cwd: workDir, stdio: "pipe" });
    assert.ok(out.includes("Local package setup complete"), "should have run the setup script");
  });

  it("rules were installed to platform files", () => {
    const claudeMd = path.join(os.homedir(), ".claude", "CLAUDE.md");
    if (fs.existsSync(claudeMd)) {
      const content = fs.readFileSync(claudeMd, "utf-8");
      assert.ok(content.includes("test-local-pkg:v1.0.0"), "rules should be in CLAUDE.md");
    }
  });

  // Cleanup
  it("cleanup removes the rules", () => {
    const { Equip } = require("..");
    const equip = new Equip({
      name: "test-local-pkg",
      serverUrl: "https://example.com/unused",
      rules: { content: "x", version: "1.0.0", marker: "test-local-pkg" },
    });
    for (const p of equip.detect()) equip.uninstallRules(p);

    const claudeMd = path.join(os.homedir(), ".claude", "CLAUDE.md");
    if (fs.existsSync(claudeMd)) {
      assert.ok(!fs.readFileSync(claudeMd, "utf-8").includes("test-local-pkg"), "rules should be cleaned up");
    }
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });
});
