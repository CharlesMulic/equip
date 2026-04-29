"use strict";

// Cross-store characterization for the baseWeight/loadedWeight RMW pattern
// in src/lib/commands/install.ts (lines 251 + 260).
//
// The install path runs a "weight recompute" step after install:
//
//   const def = readAugmentDef(toolDef.name);
//   if (def) {
//     const rulesTokens = ...;
//     const skillTokens = ...;
//     if (def.baseWeight === 0 && rulesTokens > 0) {
//       def.baseWeight = rulesTokens;
//       def.loadedWeight = skillTokens;
//       writeAugmentDef(def);
//     }
//   }
//
// **Pkg 06 batch 2 contract:** when this pattern is migrated to use
// store-writers' mutateDef / mutateCache, the routing must be intentional:
//
//   - Local augment   → weights land on defs/<name>.json (mirror already does this)
//   - Wrapped augment → weights land on defs/<name>.json (mirror already does this)
//   - Registry unmodded → CURRENT BEHAVIOR: weights only on legacy file,
//                         NOT propagated to cache (legacyRegistryToCache omits them)
//   - Registry modded   → CURRENT BEHAVIOR: weights only on legacy file,
//                         NOT propagated to overlay defs/ (legacyToOverlayDef omits them)
//                         NOT propagated to cache (legacyRegistryToCache omits them)
//
// These tests characterize the CURRENT routing as observed. A routing gap
// exists for registry augments — batch 2 must explicitly preserve OR fix
// this behavior. The tests' explicit assertions force the migration author
// to make a deliberate decision rather than silently changing the gap.

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
// The install.ts pattern, run as a standalone helper for testing.
// Mirrors lines 251-261 of src/lib/commands/install.ts.
// ─────────────────────────────────────────────────────────────
function runWeightRecomputeRmw(name) {
  const def = readAugmentDef(name);
  if (!def) return { mutated: false, reason: "no-def" };
  const rulesTokens = def.rules?.content ? Math.round(def.rules.content.length / 4) : 0;
  const skillTokens = (def.skills || []).reduce((sum, s) =>
    sum + (s.files || []).reduce((fsum, f) =>
      fsum + (f.content ? Math.round(f.content.length / 4) : 0), 0), 0);
  if (def.baseWeight === 0 && rulesTokens > 0) {
    def.baseWeight = rulesTokens;
    def.loadedWeight = skillTokens;
    writeAugmentDef(def);
    return { mutated: true, baseWeight: rulesTokens, loadedWeight: skillTokens };
  }
  return { mutated: false, reason: "predicate-not-met", baseWeight: def.baseWeight };
}

test("weight RMW on local augment: defs/<name>.json reflects updated baseWeight (mirror routes weights to defs)", (t) => {
  setupTempHome();
  t.after(teardownTempHome);

  writeLocal("local-aug");
  const before = readDef("local-aug");
  assert.equal(before?.baseWeight, 0, "starting baseWeight is 0");

  const result = runWeightRecomputeRmw("local-aug");
  assert.equal(result.mutated, true);
  assert.ok(result.baseWeight > 0, "rulesTokens computed from rules content");

  // defs/<name>.json reflects the new weight (mirror copies it).
  const after = readDef("local-aug");
  assert.equal(after?.baseWeight, result.baseWeight,
    "mirror routes weight from legacy → defs/ for local augments");
  assert.equal(after?.kind, "local");
});

test("weight RMW on registry-unmodded augment: cache.baseWeight NOT updated (current routing gap)", (t) => {
  setupTempHome();
  t.after(teardownTempHome);

  writeRegistry("reg-aug");
  const before = readCache("reg-aug");
  // Cache was populated by dual-write; baseWeight on cache starts at undefined
  // (legacyRegistryToCache omits this field — see dual-write-mirror.ts).
  const beforeCacheWeight = before?.baseWeight;

  const result = runWeightRecomputeRmw("reg-aug");
  assert.equal(result.mutated, true, "predicate met — weight gets recomputed on legacy");
  assert.ok(result.baseWeight > 0);

  // Legacy file got the new weight.
  const legacy = readAugmentDef("reg-aug");
  assert.equal(legacy.baseWeight, result.baseWeight);

  // Cache did NOT get the new weight — current routing gap.
  const afterCache = readCache("reg-aug");
  assert.equal(afterCache?.baseWeight, beforeCacheWeight,
    "ROUTING GAP: legacyRegistryToCache omits baseWeight, so weight RMW on " +
    "registry augment does NOT propagate to cache. Pkg 06 batch 2 must " +
    "decide whether to preserve this gap or fix it (likely fix — cache " +
    "should reflect the install's computed weights for the resolver).");
});

test("weight RMW on registry-modded augment: overlay defs/ does NOT get weights (current routing gap)", (t) => {
  setupTempHome();
  t.after(teardownTempHome);

  writeRegistryModded("modded-aug");
  const overlayBefore = readDef("modded-aug");
  assert.equal(overlayBefore?.kind, "overlay", "modded routes to overlay defs/");
  // overlay shape doesn't include baseWeight (only allowlisted fields).
  assert.equal(overlayBefore?.baseWeight, undefined,
    "OverlayDef has no baseWeight by design — overlay only carries the " +
    "rules/skills/hooks allowlist per the security review");

  const result = runWeightRecomputeRmw("modded-aug");
  assert.equal(result.mutated, true);

  // Legacy got the weight, but overlay still has no baseWeight field.
  const overlayAfter = readDef("modded-aug");
  assert.equal(overlayAfter?.baseWeight, undefined,
    "ROUTING GAP: legacyToOverlayDef omits baseWeight (allowlist is " +
    "rules/skills/hooks only). Pkg 06 batch 2 must route weight to cache " +
    "for modded registry augments instead.");

  // Cache also doesn't get it (same gap as the unmodded test above).
  const cacheAfter = readCache("modded-aug");
  assert.equal(cacheAfter?.baseWeight, undefined,
    "ROUTING GAP: legacyRegistryToCache omits baseWeight for modded augments too");
});

test("weight RMW predicate: skipped when baseWeight already non-zero (idempotency)", (t) => {
  setupTempHome();
  t.after(teardownTempHome);

  writeLocal("preset", { baseWeight: 999, loadedWeight: 777 });

  const result = runWeightRecomputeRmw("preset");
  assert.equal(result.mutated, false, "predicate baseWeight===0 not met → skip");
  assert.equal(result.reason, "predicate-not-met");
  assert.equal(result.baseWeight, 999, "preset weight preserved");

  // No mutation — the def still has the original weights.
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
