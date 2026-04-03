// Tests for weight computation module.

"use strict";

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  getEncumbrance,
  estimateBaseWeight,
  estimateLoadedWeight,
  applyIntrospectionWeights,
  DEFAULT_THRESHOLDS,
} = require("../dist/lib/weight");

// ─── Temp Home Isolation ────────────────────────────────────

let originalHome;
let tempHome;

function setupTempHome() {
  originalHome = os.homedir;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "weight-test-"));
  os.homedir = () => tempHome;
}

function teardownTempHome() {
  os.homedir = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}

// ─── getEncumbrance ─────────────────────────────────────────

describe("getEncumbrance", () => {
  it("returns light for low weight", () => {
    assert.equal(getEncumbrance(0, 30000), "light");
    assert.equal(getEncumbrance(5000, 30000), "light");
    assert.equal(getEncumbrance(5999, 30000), "light");
  });

  it("returns moderate at 20% of budget", () => {
    assert.equal(getEncumbrance(6000, 30000), "moderate");
    assert.equal(getEncumbrance(10000, 30000), "moderate");
  });

  it("returns heavy at 50% of budget", () => {
    assert.equal(getEncumbrance(15000, 30000), "heavy");
    assert.equal(getEncumbrance(20000, 30000), "heavy");
  });

  it("returns encumbered at 80% of budget", () => {
    assert.equal(getEncumbrance(24000, 30000), "encumbered");
    assert.equal(getEncumbrance(30000, 30000), "encumbered");
    assert.equal(getEncumbrance(50000, 30000), "encumbered");
  });

  it("scales with different budgets", () => {
    // 10k budget: 20% = 2000, 50% = 5000, 80% = 8000
    assert.equal(getEncumbrance(1000, 10000), "light");
    assert.equal(getEncumbrance(3000, 10000), "moderate");
    assert.equal(getEncumbrance(6000, 10000), "heavy");
    assert.equal(getEncumbrance(9000, 10000), "encumbered");
  });

  it("returns light for zero or negative budget", () => {
    assert.equal(getEncumbrance(1000, 0), "light");
    assert.equal(getEncumbrance(1000, -1), "light");
  });

  it("uses default budget of 30000", () => {
    assert.equal(getEncumbrance(0), "light");
    assert.equal(getEncumbrance(6000), "moderate");
  });
});

// ─── estimateBaseWeight ─────────────────────────────────────

describe("estimateBaseWeight", () => {
  it("estimates weight from rules content", () => {
    const def = {
      name: "test",
      rules: { content: "A".repeat(400), version: "1.0.0", marker: "test" },
      skills: [],
      baseWeight: 0,
      loadedWeight: 0,
    };
    const weight = estimateBaseWeight(def);
    assert.equal(weight, 100); // 400 bytes / 4
  });

  it("adds MCP server overhead for HTTP", () => {
    const def = {
      name: "test",
      serverUrl: "https://example.com/mcp",
      skills: [],
      baseWeight: 0,
      loadedWeight: 0,
    };
    const weight = estimateBaseWeight(def);
    assert.equal(weight, 50); // 200 bytes / 4
  });

  it("adds MCP server overhead for stdio", () => {
    const def = {
      name: "test",
      stdio: { command: "node", args: ["server.js"] },
      skills: [],
      baseWeight: 0,
      loadedWeight: 0,
    };
    const weight = estimateBaseWeight(def);
    assert.ok(weight > 0);
  });

  it("returns 0 for empty augment", () => {
    const def = { name: "empty", skills: [], baseWeight: 0, loadedWeight: 0 };
    assert.equal(estimateBaseWeight(def), 0);
  });
});

// ─── estimateLoadedWeight ───────────────────────────────────

describe("estimateLoadedWeight", () => {
  it("estimates from skill file content", () => {
    const def = {
      name: "test",
      skills: [{
        name: "search",
        files: [{ path: "SKILL.md", content: "B".repeat(800) }],
      }],
      baseWeight: 0,
      loadedWeight: 0,
    };
    const weight = estimateLoadedWeight(def);
    assert.equal(weight, 200); // 800 bytes / 4
  });

  it("sums multiple skills", () => {
    const def = {
      name: "test",
      skills: [
        { name: "a", files: [{ path: "SKILL.md", content: "X".repeat(400) }] },
        { name: "b", files: [{ path: "SKILL.md", content: "Y".repeat(400) }] },
      ],
      baseWeight: 0,
      loadedWeight: 0,
    };
    assert.equal(estimateLoadedWeight(def), 200); // (400+400) / 4
  });

  it("returns 0 for no skills", () => {
    const def = { name: "test", skills: [], baseWeight: 0, loadedWeight: 0 };
    assert.equal(estimateLoadedWeight(def), 0);
  });
});

// ─── applyIntrospectionWeights ──────────────────────────────

describe("applyIntrospectionWeights", () => {
  it("applies tool tokens + rules tokens as base weight", () => {
    const def = {
      name: "test",
      rules: { content: "C".repeat(400), version: "1.0.0", marker: "test" },
      skills: [],
      baseWeight: 0,
      loadedWeight: 0,
    };
    applyIntrospectionWeights(def, { toolTokens: 1000, resourceTokens: 500 });
    assert.equal(def.baseWeight, 1100); // 1000 + 400/4
  });

  it("applies resource tokens + skill tokens as loaded weight", () => {
    const def = {
      name: "test",
      skills: [{ name: "s", files: [{ path: "SKILL.md", content: "D".repeat(800) }] }],
      baseWeight: 0,
      loadedWeight: 0,
    };
    applyIntrospectionWeights(def, { toolTokens: 500, resourceTokens: 300 });
    assert.equal(def.loadedWeight, 500); // 300 + 800/4
  });

  it("handles missing introspection fields gracefully", () => {
    const def = { name: "test", skills: [], baseWeight: 0, loadedWeight: 0 };
    applyIntrospectionWeights(def, {});
    assert.equal(def.baseWeight, 0);
    assert.equal(def.loadedWeight, 0);
  });
});
