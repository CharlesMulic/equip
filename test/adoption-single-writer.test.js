"use strict";

// Single-writer discipline test for broker-production-wiring Pkg 03.
//
// `installMcpForReplaceAdopt` bypasses the unmanaged-entry conflict
// guard. Sys-arch sign-off review (2026-04-28) flagged that this is a
// quiet exception to architect-rule-#9 (single-writer of installMode);
// the discipline is "only the bridge's resolveConflict handler may call
// it, never the broader Augment.installMcp(Broker) public surface."
//
// This test enforces that discipline by greppinging the codebase. Any
// new caller that isn't on the allowlist fails the test.

const { describe, it } = require("node:test");
const assert = require("assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Allowlist: files permitted to call installMcpForReplaceAdopt. Entries
// are repo-relative paths (forward slashes). If you're updating this
// list, you're either adding a new caller (does it really need to
// bypass the guard?) or moving the existing caller (update the path).
const ALLOWED_CALLERS = [
  // Bridge's resolveConflict handler — the one legitimate caller.
  "equip-app/sidecar/bridge.ts",
  // The lib's own re-export from src/index.ts (just an export
  // statement, not an actual call).
  "equip/src/index.ts",
  // The lib internal that defines + dispatches.
  "equip/src/lib/mcp.ts",
];

// Files that match these patterns are excluded from the search. Tests
// of the function itself + this enforcement test belong here.
const EXCLUDED_PATTERNS = [
  /\.test\.(js|ts|mjs|cjs)$/,
  /\.test\.tsx$/,
  /[/\\]node_modules[/\\]/,
  /[/\\]\.svelte-kit[/\\]/,
  /[/\\]dist[/\\]/,
  /[/\\]build[/\\]/,
  /[/\\]target[/\\]/,
  /[/\\]\.git[/\\]/,
  /\.bundle\.cjs$/,
  /[/\\]bundle\.cjs$/,
];

// Search root: walk up from this file to find the portfolio root
// (it's the dir that contains both `equip/` and `equip-app/`).
//
// Returns null when the sibling layout isn't present — the equip repo is
// often checked out in isolation (CI, fresh clone) and this enforcement
// test should skip rather than fail in those layouts. The discipline is
// re-enforced on portfolio-level CI / pre-merge runs from a checkout
// with both repos present.
function findPortfolioRoot() {
  let dir = path.resolve(__dirname, "..");
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "equip-app")) && fs.existsSync(path.join(dir, "equip"))) {
      return dir;
    }
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

function isExcluded(filePath) {
  for (const pat of EXCLUDED_PATTERNS) {
    if (pat.test(filePath)) return true;
  }
  return false;
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (isExcluded(full)) continue;
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

describe("Pkg-03 — single-writer discipline for installMcpForReplaceAdopt", () => {
  it("only allowlisted callsites reference the adopt-mode install", (t) => {
    const root = findPortfolioRoot();
    if (!root) {
      t.skip("equip-app sibling not present (standalone checkout) — portfolio CI re-enforces this discipline");
      return;
    }
    const offenders = [];

    // Search relevant subtrees only (equip + equip-app sidecar). The
    // function isn't visible from cg3-ui (frontend) or other repos.
    const searchDirs = [
      path.join(root, "equip", "src"),
      path.join(root, "equip-app", "sidecar"),
    ];

    for (const baseDir of searchDirs) {
      for (const file of walk(baseDir)) {
        let content;
        try { content = fs.readFileSync(file, "utf-8"); } catch { continue; }
        if (!content.includes("installMcpForReplaceAdopt")) continue;

        const rel = path.relative(root, file).replace(/\\/g, "/");
        if (ALLOWED_CALLERS.includes(rel)) continue;

        offenders.push(rel);
      }
    }

    assert.deepEqual(offenders, [],
      "installMcpForReplaceAdopt has callers outside the allowlist:\n" +
      `  ${offenders.join("\n  ")}\n` +
      "If a new caller is intentional, add it to ALLOWED_CALLERS in this test\n" +
      "AND ensure the caller routes user-consent through bridge.augmentResolveConflict\n" +
      "(architect rule #9 — single-writer of forceReplace).");
  });
});
