// Holistic resolver-equivalence-after-dual-write tests.
//
// **The wire-shape invariant for Pkg 06 batch 2's bridge.ts migration.**
//
// Bridge.ts handlers currently consume legacy AugmentDef shapes (read via
// readAugmentDef). After batch 2, they will consume ResolvedAugment shapes
// (read via augmentResolver.resolve). These tests pin that for every
// legacy AugmentDef shape, the post-dual-write resolver returns an
// equivalent shape that downstream code can treat as drop-in.
//
// Equivalence is checked field-by-field rather than via deepEqual because:
//   - Field names differ (legacy `source` is denormalized; resolver derives it)
//   - The resolver collapses overlay merging (cache + overlay → ResolvedAugment)
//   - Some fields are omitted by the dual-write mirror (the routing gaps
//     documented in test/install-weight-rmw-cross-store.test.js)
//
// **Scope of equivalence claim** — the resolver must return:
//   - Same `name`
//   - Same effective `source` (with overlay → registry collapse via legacySourceOf)
//   - Same `title`, `description`, `subtitle`, `flavorText`, `rarity`
//   - Same `transport`, `serverUrl`, `stdio`, `envKey`, `requiresAuth`, `auth`
//   - Same `rules` (overlay's mods take precedence per overlay merge contract)
//   - Same `skills` (overlay's mods take precedence iff `moddedFields` includes "skills")
//   - Same `hooks` (overlay's mods take precedence iff `moddedFields` includes "hooks")
//   - Same `homepage`, `repository`, `license`, `categories`
//
// **Known gaps NOT asserted** (pinned in install-weight-rmw-cross-store.test.js):
//   - baseWeight / loadedWeight on registry augments (mirror omits these
//     from cache; characterization shows they only land on legacy file)
//
// Tests intentionally do NOT use deepEqual on the full shapes — that would
// fail on irrelevant fields (resolver-only metadata like hasCache / hasDef /
// cacheFetchedAt). Field-by-field is more readable + more stable across
// resolver-shape evolution.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let augmentDefsMod;
let resolverMod;
let migrationTriggerMod;

async function freshHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-equiv-"));
  process.env.EQUIP_HOME = tmp;
  if (!augmentDefsMod) augmentDefsMod = await import("../dist/lib/augment-defs.js");
  if (!resolverMod) resolverMod = await import("../dist/lib/augment-resolver.js");
  if (!migrationTriggerMod) migrationTriggerMod = await import("../dist/lib/migration-trigger.js");
  migrationTriggerMod._resetMigrationTriggerForTests();
  return tmp;
}

function localFixture(name, overrides = {}) {
  const now = "2026-04-28T00:00:00.000Z";
  return {
    name,
    source: "local",
    title: `${name} title`,
    subtitle: `${name} subtitle`,
    description: `${name} description`,
    flavorText: "lore",
    rarity: "rare",
    transport: "http",
    serverUrl: `https://example.com/${name}`,
    requiresAuth: false,
    skills: [],
    rules: { content: "rules content", version: "1.0.0", marker: name },
    baseWeight: 100,
    loadedWeight: 200,
    homepage: "https://homepage.example",
    repository: "https://github.example/repo",
    license: "MIT",
    categories: ["cat-a", "cat-b"],
    modded: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function wrappedFixture(name, overrides = {}) {
  return {
    ...localFixture(name, overrides),
    source: "wrapped",
    wrappedFrom: { type: "mcp", platform: "cursor", path: `/path/${name}`, originalName: `orig-${name}` },
  };
}

function registryFixture(name, overrides = {}) {
  const now = "2026-04-28T00:00:00.000Z";
  return {
    name,
    source: "registry",
    title: `${name} title`,
    subtitle: `${name} subtitle`,
    description: `${name} description`,
    flavorText: "publisher lore",
    rarity: "epic",
    transport: "http",
    serverUrl: `https://registry.example/${name}`,
    requiresAuth: false,
    skills: [],
    rules: { content: "registry rules", version: "1.0.0", marker: name },
    baseWeight: 0,
    loadedWeight: 0,
    modded: false,
    registryContentHash: `hash-${name}`,
    registryVersionNumber: 1,
    registryStatus: "active",
    lastValidatedAt: now,
    homepage: "https://reg.example",
    license: "Apache-2.0",
    categories: ["registry-cat"],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function moddedRegistryFixture(name, overrides = {}) {
  return registryFixture(name, {
    modded: true,
    moddedFields: ["rules"],
    rules: { content: "MY MODDED RULES", version: "1.0.0", marker: name },
    rulesUpstream: { content: "ORIGINAL UPSTREAM", version: "1.0.0", marker: name },
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────
// Equivalence assertions — shared helper
// ─────────────────────────────────────────────────────────────

function assertContentFieldsEquivalent(legacy, resolved) {
  assert.equal(resolved.name, legacy.name, "name matches");
  assert.equal(resolved.title, legacy.title, "title matches");
  assert.equal(resolved.description, legacy.description, "description matches");
  assert.equal(resolved.subtitle, legacy.subtitle, "subtitle matches");
  assert.equal(resolved.flavorText, legacy.flavorText, "flavorText matches");
  assert.equal(resolved.rarity, legacy.rarity, "rarity matches");
  assert.equal(resolved.transport, legacy.transport, "transport matches");
  assert.equal(resolved.serverUrl, legacy.serverUrl, "serverUrl matches");
  assert.equal(resolved.requiresAuth, legacy.requiresAuth, "requiresAuth matches");
  assert.deepEqual(resolved.rules, legacy.rules, "rules match");
  assert.deepEqual(resolved.skills, legacy.skills, "skills match");
  assert.equal(resolved.homepage, legacy.homepage, "homepage matches");
  assert.equal(resolved.repository, legacy.repository, "repository matches");
  assert.equal(resolved.license, legacy.license, "license matches");
  assert.deepEqual(resolved.categories, legacy.categories, "categories match");
}

// ─────────────────────────────────────────────────────────────
// Per-source-shape equivalence tests
// ─────────────────────────────────────────────────────────────

test("local augment: writeAugmentDef + dual-write → resolver returns equivalent ResolvedAugment", async () => {
  await freshHome();
  const legacy = localFixture("equiv-local");
  augmentDefsMod.writeAugmentDef(legacy);

  const resolved = resolverMod.augmentResolver.resolve("equiv-local");
  assert.ok(resolved, "resolver finds the augment after dual-write");
  assert.equal(resolved.source, "local", "resolver derives source=local from defs/kind=local");
  assertContentFieldsEquivalent(legacy, resolved);

  // Local augments DO get their weights mirrored to defs/.
  assert.equal(resolved.baseWeight, legacy.baseWeight, "baseWeight preserved on local");
  assert.equal(resolved.loadedWeight, legacy.loadedWeight, "loadedWeight preserved on local");
});

test("wrapped augment: equivalent + wrappedFrom provenance preserved", async () => {
  await freshHome();
  const legacy = wrappedFixture("equiv-wrapped");
  augmentDefsMod.writeAugmentDef(legacy);

  const resolved = resolverMod.augmentResolver.resolve("equiv-wrapped");
  assert.ok(resolved);
  assert.equal(resolved.source, "wrapped");
  assertContentFieldsEquivalent(legacy, resolved);
  assert.deepEqual(resolved.wrappedFrom, legacy.wrappedFrom, "wrappedFrom provenance preserved");

  // Wrapped augments DO get their weights mirrored to defs/.
  assert.equal(resolved.baseWeight, legacy.baseWeight);
  assert.equal(resolved.loadedWeight, legacy.loadedWeight);
});

test("registry-unmodded: equivalent via cache-only resolution; legacySourceOf collapses to 'registry'", async () => {
  await freshHome();
  const legacy = registryFixture("equiv-registry");
  augmentDefsMod.writeAugmentDef(legacy);

  const resolved = resolverMod.augmentResolver.resolve("equiv-registry");
  assert.ok(resolved);
  assert.equal(resolved.source, "registry", "resolver source=registry for cache-only");
  // Legacy compat: legacySourceOf maps registry → "registry" for bridge checks.
  assert.equal(resolverMod.legacySourceOf(resolved), "registry");
  assertContentFieldsEquivalent(legacy, resolved);

  // Cache freshness metadata preserved on the resolver.
  assert.equal(resolved.cacheContentHash, legacy.registryContentHash);
  assert.equal(resolved.cacheVersion, legacy.registryVersionNumber);
  assert.equal(resolved.cacheRegistryStatus, legacy.registryStatus);
});

test("registry-modded: overlay merges with cache; user mods take precedence; cache holds upstream", async () => {
  await freshHome();
  const legacy = moddedRegistryFixture("equiv-modded");
  augmentDefsMod.writeAugmentDef(legacy);

  const resolved = resolverMod.augmentResolver.resolve("equiv-modded");
  assert.ok(resolved);
  assert.equal(resolved.source, "overlay", "resolver source=overlay for defs+cache merge");
  // Legacy compat: legacySourceOf maps overlay → "registry" for bridge checks.
  assert.equal(resolverMod.legacySourceOf(resolved), "registry",
    "modded overlay collapses to legacy 'registry' for bridge.ts compat");

  // User's modded rules win over cache's upstream.
  assert.equal(resolved.rules?.content, "MY MODDED RULES");
  // But other content fields (title, description, brand metadata) come from cache.
  assert.equal(resolved.title, legacy.title);
  assert.equal(resolved.description, legacy.description);
  assert.equal(resolved.flavorText, legacy.flavorText, "flavorText is publisher brand metadata, not overrideable");
  assert.equal(resolved.transport, legacy.transport);
  assert.equal(resolved.serverUrl, legacy.serverUrl);
});

test("registry-modded: overlay's allowlisted skills take precedence when in moddedFields", async () => {
  await freshHome();
  const legacy = moddedRegistryFixture("equiv-modded-skills", {
    moddedFields: ["rules", "skills"],
    skills: [{ name: "modded-skill", files: [{ path: "SKILL.md", content: "user's skill" }] }],
  });
  augmentDefsMod.writeAugmentDef(legacy);

  const resolved = resolverMod.augmentResolver.resolve("equiv-modded-skills");
  assert.ok(resolved);
  assert.equal(resolved.source, "overlay");
  assert.equal(resolved.skills?.length, 1);
  assert.equal(resolved.skills?.[0]?.name, "modded-skill");
});

test("registry-modded with hooks-only modding: hooks override but rules/skills come from cache", async () => {
  await freshHome();
  const legacy = moddedRegistryFixture("equiv-hooks-only", {
    moddedFields: ["hooks"],
    hooks: [{ type: "PostToolUse", command: "echo modded" }],
    rules: undefined, // user didn't mod rules
    rulesUpstream: { content: "UPSTREAM RULES", version: "1.0.0", marker: "equiv-hooks-only" },
  });
  augmentDefsMod.writeAugmentDef(legacy);

  const resolved = resolverMod.augmentResolver.resolve("equiv-hooks-only");
  assert.ok(resolved);
  assert.deepEqual(resolved.hooks, legacy.hooks, "user's hooks override");
  // Rules come from cache's upstream snapshot.
  assert.equal(resolved.rules?.content, "UPSTREAM RULES");
});

test("isLegacySourceMatch consistency: bridge.ts source-discriminator checks via resolver", async () => {
  // Pre-Pkg-06 bridge.ts has checks like `if (def.source === "registry") ...`.
  // After batch 2, these become `if (isLegacySourceMatch(resolved, "registry")) ...`.
  // This test pins the equivalence — both forms must behave identically across
  // all 4 source variants.
  await freshHome();
  augmentDefsMod.writeAugmentDef(localFixture("disc-local"));
  augmentDefsMod.writeAugmentDef(wrappedFixture("disc-wrapped"));
  augmentDefsMod.writeAugmentDef(registryFixture("disc-registry"));
  augmentDefsMod.writeAugmentDef(moddedRegistryFixture("disc-modded"));

  // For each augment, check that legacy `def.source === X` matches
  // `isLegacySourceMatch(resolved, X)`.
  for (const name of ["disc-local", "disc-wrapped", "disc-registry", "disc-modded"]) {
    const legacy = augmentDefsMod.readAugmentDef(name);
    const resolved = resolverMod.augmentResolver.resolve(name);
    assert.ok(resolved, `resolver finds ${name}`);

    for (const queryValue of ["local", "registry", "wrapped"]) {
      assert.equal(
        resolverMod.isLegacySourceMatch(resolved, queryValue),
        legacy.source === queryValue,
        `${name}: isLegacySourceMatch(resolved, "${queryValue}") must match legacy "def.source === '${queryValue}'"`,
      );
    }
  }
});

test("flavorText is publisher brand metadata: stays on cache for modded augments (security review)", async () => {
  // Per the augment-resolver allowlist (rules/skills/hooks only), an
  // overlay's flavorText field is silently ignored during the merge —
  // flavorText is publisher brand metadata that stays intact even when the
  // augment is modded. This is the load-bearing security invariant from the
  // 2026-04-28 architect review.
  await freshHome();
  const legacy = moddedRegistryFixture("flavor-text-test", {
    flavorText: "ORIGINAL PUBLISHER FLAVOR",
  });
  augmentDefsMod.writeAugmentDef(legacy);

  const resolved = resolverMod.augmentResolver.resolve("flavor-text-test");
  assert.equal(resolved.flavorText, "ORIGINAL PUBLISHER FLAVOR",
    "flavorText comes from cache (publisher brand) regardless of overlay state");
});
