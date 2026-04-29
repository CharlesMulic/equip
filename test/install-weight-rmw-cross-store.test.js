"use strict";

// Cross-store routing tests for the baseWeight/loadedWeight RMW pattern
// in src/lib/commands/install.ts (lines 251-264 post-migration).
//
// **Pkg 06 batch 2b update (2026-04-29):** previously these tests
// characterized a routing gap (legacyRegistryToCache + legacyToOverlayDef
// both omitted weight fields). Per architect condition 1, the gap is
// fixed in batch 2b — weight writes route to the correct store:
//
//   - Local augment   → defs/<name>.json (mutateDef)
//   - Wrapped augment → defs/<name>.json (mutateDef)
//   - Registry-unmodded → cache/<name>.json (mutateCache)
//   - Registry-modded   → cache/<name>.json (mutateCache)
//                         (overlay's allowlist is rules/skills/hooks only —
//                         weights are install-time derived data, not user
//                         content overrides; cache is the right home)
//
// Tests assert the new contract: weights land where the resolver reads them.

const { test } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { writeAugmentDef, readAugmentDef } = require("../dist/lib/augment-defs");
const { readDef } = require("../dist/lib/defs-store");
const { readCache } = require("../dist/lib/cache-store");

let originalEquipHome;
let tempHome;

function setupTempHome() {
  originalEquipHome = process.env.EQUIP_HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-weight-rmw-"));
  process.env.EQUIP_HOME = tempHome;
}

function teardownTempHome() {
  if (originalEquipHome === undefined) delete process.env.EQUIP_HOME;
  else process.env.EQUIP_HOME = originalEquipHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
}

function writeLocal(name, overrides = {}) {
  writeAugmentDef({
    name,
    source: "local",
    title: name,
    description: "test-local",
    transport: "http",
    serverUrl: `https://example.com/${name}`,
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    rules: { content: "Local rules content for token estimation".repeat(20),
      version: "1.0.0", marker: name },
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  });
}

function writeRegistry(name, overrides = {}) {
  writeAugmentDef({
    name,
    source: "registry",
    title: name,
    description: "test-registry",
    transport: "http",
    serverUrl: `https://example.com/${name}`,
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    registryContentHash: `h-${name}`,
    registryEtag: `e-${name}`,
    registryVersionNumber: 1,
    registryStatus: "active",
    rules: { content: "Registry rules content for token estimation".repeat(20),
      version: "1.0.0", marker: name },
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  });
}

function writeRegistryModded(name, overrides = {}) {
  writeAugmentDef({
    name,
    source: "registry",
    title: name,
    description: "test-modded",
    transport: "http",
    serverUrl: `https://example.com/${name}`,
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    modded: true,
    moddedFields: ["rules"],
    registryContentHash: `h-${name}`,
    registryEtag: `e-${name}`,
    registryVersionNumber: 1,
    registryStatus: "active",
    rules: { content: "MODDED rules content".repeat(15), version: "1.0.0", marker: name },
    rulesUpstream: { content: "ORIGINAL upstream rules", version: "1.0.0", marker: name },
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────
// The post-migration install.ts pattern. Mirrors lines 251-281
// of src/lib/commands/install.ts (post-Pkg-06-batch-2b).
// ─────────────────────────────────────────────────────────────
const { augmentResolver } = require("../dist/lib/augment-resolver");
const { mutateDef, mutateCache } = require("../dist/lib/store-writers");
const { hasCache } = require("../dist/lib/cache-store");

function runWeightRecomputeRmw(name) {
  const resolved = augmentResolver.resolve(name);
  if (!resolved) return { mutated: false, reason: "no-def" };
  const rulesTokens = resolved.rules?.content ? Math.round(resolved.rules.content.length / 4) : 0;
  const skillTokens = (resolved.skills || []).reduce((sum, s) =>
    sum + (s.files || []).reduce((fsum, f) =>
      fsum + (f.content ? Math.round(f.content.length / 4) : 0), 0), 0);
  if (resolved.baseWeight === 0 && rulesTokens > 0) {
    if (resolved.source === "local" || resolved.source === "wrapped") {
      mutateDef(name, (d) => {
        if (d.kind === "local" || d.kind === "wrapped") {
          d.baseWeight = rulesTokens;
          d.loadedWeight = skillTokens;
        }
      });
    } else if (hasCache(name)) {
      mutateCache(name, (c) => {
        c.baseWeight = rulesTokens;
        c.loadedWeight = skillTokens;
      });
    }
    return { mutated: true, baseWeight: rulesTokens, loadedWeight: skillTokens };
  }
  return { mutated: false, reason: "predicate-not-met", baseWeight: resolved.baseWeight };
}

test("weight RMW on local augment: defs/<name>.json reflects updated baseWeight via mutateDef", (t) => {
  setupTempHome();
  t.after(teardownTempHome);

  writeLocal("local-aug");
  const before = readDef("local-aug");
  assert.equal(before?.baseWeight, 0, "starting baseWeight is 0");

  const result = runWeightRecomputeRmw("local-aug");
  assert.equal(result.mutated, true);
  assert.ok(result.baseWeight > 0, "rulesTokens computed from rules content");

  // defs/<name>.json reflects the new weight (mutateDef wrote it).
  const after = readDef("local-aug");
  assert.equal(after?.baseWeight, result.baseWeight,
    "weight RMW routes to defs/ for local augments via mutateDef");
  assert.equal(after?.kind, "local");
});

test("weight RMW on registry-unmodded augment: cache.baseWeight updated via mutateCache (gap fixed)", (t) => {
  setupTempHome();
  t.after(teardownTempHome);

  writeRegistry("reg-aug");
  const before = readCache("reg-aug");

  const result = runWeightRecomputeRmw("reg-aug");
  assert.equal(result.mutated, true, "predicate met — weight recomputed");
  assert.ok(result.baseWeight > 0);

  // Cache.baseWeight reflects the new weight — the routing-gap fix.
  const afterCache = readCache("reg-aug");
  assert.equal(afterCache?.baseWeight, result.baseWeight,
    "Pkg 06 batch 2b routing-gap fix: weight RMW on registry augment routes to cache via mutateCache");
  assert.equal(afterCache?.loadedWeight, result.loadedWeight);
});

test("weight RMW on registry-modded augment: cache.baseWeight updated; overlay defs/ untouched", (t) => {
  setupTempHome();
  t.after(teardownTempHome);

  writeRegistryModded("modded-aug");
  const overlayBefore = readDef("modded-aug");
  assert.equal(overlayBefore?.kind, "overlay", "modded routes to overlay defs/");
  // OverlayDef has no baseWeight by design — overlay only carries the
  // rules/skills/hooks allowlist per the security review.
  assert.equal(overlayBefore?.baseWeight, undefined);

  const result = runWeightRecomputeRmw("modded-aug");
  assert.equal(result.mutated, true);

  // Cache.baseWeight reflects the new weight — modded routes to cache (not overlay).
  const cacheAfter = readCache("modded-aug");
  assert.equal(cacheAfter?.baseWeight, result.baseWeight,
    "Pkg 06 batch 2b: modded registry augments also route weight to cache (overlay allowlist excludes weight)");
  assert.equal(cacheAfter?.loadedWeight, result.loadedWeight);

  // Overlay defs/ stays untouched.
  const overlayAfter = readDef("modded-aug");
  assert.equal(overlayAfter?.baseWeight, undefined,
    "overlay defs/ doesn't carry baseWeight — security allowlist excludes it");
});

test("weight RMW predicate: skipped when baseWeight already non-zero (idempotency)", (t) => {
  setupTempHome();
  t.after(teardownTempHome);

  writeLocal("preset", { baseWeight: 999, loadedWeight: 777 });

  const result = runWeightRecomputeRmw("preset");
  assert.equal(result.mutated, false, "predicate baseWeight===0 not met → skip");
  assert.equal(result.reason, "predicate-not-met");
  assert.equal(result.baseWeight, 999, "preset weight preserved");

  // No mutation — defs/ still has the original weights.
  const after = readDef("preset");
  assert.equal(after?.baseWeight, 999);
  assert.equal(after?.loadedWeight, 777);
});

test("weight RMW predicate: skipped when no rules content (rulesTokens === 0)", (t) => {
  setupTempHome();
  t.after(teardownTempHome);

  writeLocal("no-rules", { rules: undefined });

  const result = runWeightRecomputeRmw("no-rules");
  assert.equal(result.mutated, false, "predicate rulesTokens>0 not met → skip");

  const after = readDef("no-rules");
  assert.equal(after?.baseWeight, 0, "no recompute → baseWeight stays 0");
});

test("weight RMW: skill content tokens land in loadedWeight", (t) => {
  setupTempHome();
  t.after(teardownTempHome);

  writeLocal("with-skills", {
    skills: [
      { name: "skill-a", files: [{ path: "SKILL.md", content: "Skill A content".repeat(40) }] },
      { name: "skill-b", files: [
        { path: "SKILL.md", content: "Skill B body".repeat(30) },
        { path: "helper.md", content: "Helper".repeat(20) },
      ]},
    ],
  });

  const result = runWeightRecomputeRmw("with-skills");
  assert.equal(result.mutated, true);
  assert.ok(result.loadedWeight > 0, "loadedWeight computed from skill file content");
  assert.ok(result.loadedWeight > result.baseWeight, "skill content > rules content in this fixture");

  const after = readDef("with-skills");
  assert.equal(after?.loadedWeight, result.loadedWeight);
});
