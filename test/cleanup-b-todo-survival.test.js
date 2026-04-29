// CI grep test for `@cleanup-b TODO` survival.
//
// Per architect's note in operations work-package 06 (2026-04-29): the
// `@cleanup-b TODO` comment convention was used during Pkg 03 + 04 + 06
// migration work to flag spots where a migration was non-trivial and needed
// reviewer attention. Any unresolved TODO must be addressed before Pkg 06
// batch 2 (the critical-path cutover) ships — otherwise the half-migrated
// state survives into the supposedly-retired era.
//
// This test asserts the literal string `@cleanup-b TODO` does NOT appear in
// `equip/src/` (always scanned) or `equip-app/sidecar/` (scanned when present;
// skipped with a logged note if the sibling worktree isn't accessible, as is
// the case when running tests against the published @cg3/equip npm package).
//
// Currently passes trivially — no markers in the codebase as of Pkg 06
// batch 1 close. The test load-bears in future migration batches.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EQUIP_SRC_DIR = path.resolve(__dirname, "..", "src");
const EQUIP_APP_SIDECAR_DIR = path.resolve(__dirname, "..", "..", "equip-app", "sidecar");

const MARKER = "@cleanup-b TODO";

function findMarkerHits(rootDir) {
  /** @type {string[]} */
  const hits = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip dist/ and node_modules — only scan source.
        if (entry.name === "dist" || entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // Source files only — skip .d.ts, .map, etc.
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".cjs") && !entry.name.endsWith(".mjs") && !entry.name.endsWith(".js")) continue;
      // Skip the test file itself (it contains the marker as a string literal).
      if (full === __filename) continue;
      let content;
      try { content = fs.readFileSync(full, "utf-8"); } catch { continue; }
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        if (line.includes(MARKER)) {
          hits.push(`${path.relative(rootDir, full)}:${idx + 1}`);
        }
      });
    }
  }
  walk(rootDir);
  return hits;
}

test("equip/src/ contains no surviving '@cleanup-b TODO' markers", () => {
  const hits = findMarkerHits(EQUIP_SRC_DIR);
  assert.deepEqual(hits, [],
    `Unresolved @cleanup-b TODO markers in equip/src/:\n  - ${hits.join("\n  - ")}\n` +
    `These must be resolved before the dual-write retirement initiative ships Pkg 06 batch 2.`);
});

test("equip-app/sidecar/ contains no surviving '@cleanup-b TODO' markers (when sibling worktree present)", () => {
  if (!fs.existsSync(EQUIP_APP_SIDECAR_DIR)) {
    // Acceptable — the test file ships in @cg3/equip but equip-app is a
    // separate repo. When run from the standalone published package, the
    // sidecar is not accessible and this check is skipped.
    process.stderr.write(`[cleanup-b-todo-survival] equip-app/sidecar not present at ${EQUIP_APP_SIDECAR_DIR} — skipping cross-repo scan.\n`);
    return;
  }
  const hits = findMarkerHits(EQUIP_APP_SIDECAR_DIR);
  assert.deepEqual(hits, [],
    `Unresolved @cleanup-b TODO markers in equip-app/sidecar/:\n  - ${hits.join("\n  - ")}\n` +
    `These must be resolved before the dual-write retirement initiative ships Pkg 06 batch 2.`);
});
