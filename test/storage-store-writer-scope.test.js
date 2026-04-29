// Single-writer scope enforcement for the three storage primitives.
//
// Mirrors the publisher-loop-foundation's PendingVersionIdWriterScopeTest
// pattern (Kotlin) — pin the architectural commitment that each new store
// has exactly one writer in production code, plus the migration utility.
// Direct writes from anywhere else reopen the conflation bug class this
// initiative is closing.
//
// Pkg 01 of equip-storage-refactor.
//
// As Pkgs 02-04 ship, the allowlists below grow (e.g., bridge.ts publish/
// retract paths get added to DEFS writers, registry-refresh.ts gets added
// to CACHE writers, install/uninstall paths get added to INSTALLS writers).
// Each addition is a deliberate review checkpoint.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_LIB_DIR = path.resolve(__dirname, "..", "src", "lib");

/**
 * Files allowed to call defsStore writes (writeDef / deleteDef) in production.
 * `defs-store.ts` itself is the module — appears here because we scan all .ts
 * files including the implementation.
 */
const DEFS_WRITER_ALLOWLIST = [
  "defs-store.ts",        // the module itself
  "dual-write-mirror.ts", // Pkg 01 dual-write hook (retired in Cleanup B Pkg 06)
  "migrate-storage.ts",   // one-time migration
  "store-writers.ts",     // Cleanup B (dual-write retirement) — new sanctioned write surface
  "store-orchestrator.ts", // Cleanup B — cross-store orchestrators (call store-writers, not raw store fns)
];

const CACHE_WRITER_ALLOWLIST = [
  "cache-store.ts",
  "dual-write-mirror.ts",
  "migrate-storage.ts",
  "store-writers.ts",
  "store-orchestrator.ts",
];

const INSTALLS_WRITER_ALLOWLIST = [
  "installs-store.ts",
  "dual-write-mirror.ts",
  "migrate-storage.ts",
  "store-writers.ts",
  "store-orchestrator.ts",
];

/**
 * Match writeDef / deleteDef / writeCache / deleteCache / writeInstall / deleteInstall
 * function-call patterns. Excludes import statements (which name the function
 * but don't call it).
 */
function matchPattern(content, pattern) {
  // Strip import lines so we don't false-positive on `import { writeDef } ...`.
  const noImports = content
    .split("\n")
    .filter((line) => !line.trim().startsWith("import"))
    .join("\n");
  const re = new RegExp(`\\b${pattern}\\s*\\(`, "g");
  return [...noImports.matchAll(re)];
}

function listLibFiles() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(full);
    }
  }
  walk(SRC_LIB_DIR);
  return files;
}

/**
 * Returns true if the file imports the named function from the given module.
 * Used to disambiguate name-collision cases (e.g., checksum-cache.ts has its
 * own local writeCache function — only flag if the file imports our writeCache
 * from "./cache-store").
 */
function importsFromModule(content, importedName, modulePath) {
  // Match `import { ..., importedName, ... } from "modulePath"` (with ./ prefix
  // variations).
  const re = new RegExp(
    `import\\s+\\{[^}]*\\b${importedName}\\b[^}]*\\}\\s+from\\s+["']${modulePath.replace(/[/.]/g, "\\$&")}["']`,
    "m",
  );
  return re.test(content);
}

function findUnauthorizedCalls(patterns, allowlist, sourceModule) {
  const violations = [];
  for (const file of listLibFiles()) {
    const basename = path.basename(file);
    if (allowlist.includes(basename)) continue;
    const content = fs.readFileSync(file, "utf-8");
    for (const pattern of patterns) {
      // Disambiguate name-collision: only flag if the file imports this
      // specific function from the new-store module.
      if (!importsFromModule(content, pattern, sourceModule)) continue;
      const matches = matchPattern(content, pattern);
      if (matches.length > 0) {
        violations.push(`${basename}: ${matches.length}× ${pattern}() call(s)`);
      }
    }
  }
  return violations;
}

test("defs-store: writeDef + deleteDef called only from allowlisted files", () => {
  const violations = findUnauthorizedCalls(["writeDef", "deleteDef"], DEFS_WRITER_ALLOWLIST, "./defs-store");
  assert.deepEqual(violations, [],
    `defs-store single-writer rule violation:\n  - ${violations.join("\n  - ")}\n` +
    `Allowed callers: ${DEFS_WRITER_ALLOWLIST.join(", ")}`);
});

test("cache-store: writeCache + deleteCache called only from allowlisted files", () => {
  const violations = findUnauthorizedCalls(["writeCache", "deleteCache"], CACHE_WRITER_ALLOWLIST, "./cache-store");
  assert.deepEqual(violations, [],
    `cache-store single-writer rule violation:\n  - ${violations.join("\n  - ")}\n` +
    `Allowed callers: ${CACHE_WRITER_ALLOWLIST.join(", ")}`);
});

test("installs-store: writeInstall + deleteInstall called only from allowlisted files", () => {
  const violations = findUnauthorizedCalls(["writeInstall", "deleteInstall"], INSTALLS_WRITER_ALLOWLIST, "./installs-store");
  assert.deepEqual(violations, [],
    `installs-store single-writer rule violation:\n  - ${violations.join("\n  - ")}\n` +
    `Allowed callers: ${INSTALLS_WRITER_ALLOWLIST.join(", ")}`);
});
