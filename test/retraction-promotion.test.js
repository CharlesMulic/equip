// Retraction promotion tests — cache 404/410 with active overlay → frozen
// `kind: "local"` def + `frozen_from_retraction` marker.
//
// Pkg 02 of equip-storage-refactor: pin the data-loss prevention rule that
// a user's mods on a retracted-upstream registry augment are silently
// promoted to sovereign-local content with a marker, never lost.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let dualWriteMod;
let defsStoreMod;
let cacheStoreMod;
let migrationTriggerMod;

async function freshHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retraction-test-"));
  process.env.EQUIP_HOME = tmp;
  if (!dualWriteMod) dualWriteMod = await import("../dist/lib/dual-write-mirror.js");
  if (!defsStoreMod) defsStoreMod = await import("../dist/lib/defs-store.js");
  if (!cacheStoreMod) cacheStoreMod = await import("../dist/lib/cache-store.js");
  if (!migrationTriggerMod) migrationTriggerMod = await import("../dist/lib/migration-trigger.js");
  migrationTriggerMod._resetMigrationTriggerForTests();
  return tmp;
}

function planCache(name, overrides = {}) {
  return {
    name,
    fetchedAt: "2026-04-28T10:00:00.000Z",
    title: "Upstream Title",
    description: "Upstream description",
    requiresAuth: false,
    transport: "http",
    serverUrl: `https://upstream.example/${name}`,
    contentHash: `hash-${name}-v3`,
    version: 3,
    rules: { content: "UPSTREAM RULES", version: "1.0.0", marker: name },
    publisher: { name: "Pub", slug: "pub", verified: true },
    ...overrides,
  };
}

function planOverlay(name, overrides = {}) {
  return {
    name,
    kind: "overlay",
    overlay_of: name,
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
    rules: { content: "MY MOD", version: "1.0.0", marker: name },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Promotion: overlay + cache → frozen LocalDef
// ─────────────────────────────────────────────────────────────

test("retraction with active overlay promotes to frozen kind=local with overlay's mods preserved", async () => {
  await freshHome();
  cacheStoreMod.writeCache(planCache("retract-with-mod"));
  defsStoreMod.writeDef(planOverlay("retract-with-mod", {
    rules: { content: "MY MOD RULES", version: "1.0.0", marker: "retract-with-mod" },
    skills: [{ name: "my-mod-skill", files: [{ path: "SKILL.md", content: "modded" }] }],
  }));

  const action = dualWriteMod.mirrorRetractFromRegistry("retract-with-mod", "2026-04-28T12:00:00.000Z");
  assert.equal(action, "frozen-from-overlay");

  const frozen = defsStoreMod.readDef("retract-with-mod");
  assert.equal(frozen?.kind, "local", "overlay promoted to frozen LocalDef");
  // Identity from cache
  assert.equal(frozen?.title, "Upstream Title");
  assert.equal(frozen?.publisher, undefined, "publisher field doesn't transfer to LocalDef shape");
  // Infrastructure from cache
  assert.equal(frozen?.transport, "http");
  assert.equal(frozen?.serverUrl, "https://upstream.example/retract-with-mod");
  // Overlay's mods preserved
  assert.equal(frozen?.rules?.content, "MY MOD RULES");
  assert.equal(frozen?.skills?.[0]?.name, "my-mod-skill");
  // Marker present
  assert.equal(frozen?.frozen_from_retraction?.name, "retract-with-mod");
  assert.equal(frozen?.frozen_from_retraction?.retractedAt, "2026-04-28T12:00:00.000Z");
  assert.equal(frozen?.frozen_from_retraction?.lastSeenContentHash, "hash-retract-with-mod-v3");

  // Cache deleted
  assert.equal(cacheStoreMod.readCache("retract-with-mod"), null);
});

test("retraction with no overlay just deletes cache (no defs entry created)", async () => {
  await freshHome();
  cacheStoreMod.writeCache(planCache("pure-registry-retract"));

  const action = dualWriteMod.mirrorRetractFromRegistry("pure-registry-retract");
  assert.equal(action, "cache-deleted");

  assert.equal(cacheStoreMod.readCache("pure-registry-retract"), null);
  assert.equal(defsStoreMod.readDef("pure-registry-retract"), null,
    "no overlay → no frozen LocalDef created");
});

test("retraction is idempotent — re-firing on already-frozen state is a no-op", async () => {
  await freshHome();
  cacheStoreMod.writeCache(planCache("idem-retract"));
  defsStoreMod.writeDef(planOverlay("idem-retract"));

  const first = dualWriteMod.mirrorRetractFromRegistry("idem-retract");
  assert.equal(first, "frozen-from-overlay");

  const second = dualWriteMod.mirrorRetractFromRegistry("idem-retract");
  assert.equal(second, "no-op", "re-firing on already-frozen state is a no-op");

  // Frozen LocalDef is unchanged.
  const frozen = defsStoreMod.readDef("idem-retract");
  assert.equal(frozen?.kind, "local");
  assert.equal(frozen?.frozen_from_retraction?.name, "idem-retract");
});

test("retraction on augment that doesn't exist anywhere returns no-op", async () => {
  await freshHome();
  const action = dualWriteMod.mirrorRetractFromRegistry("never-existed");
  assert.equal(action, "no-op");
});

// ─────────────────────────────────────────────────────────────
// Edge case: overlay exists but cache already gone
// ─────────────────────────────────────────────────────────────

test("retraction with overlay-only (cache already gone) freezes from overlay-only content", async () => {
  await freshHome();
  defsStoreMod.writeDef(planOverlay("orphan-overlay", {
    rules: { content: "saved mod content", version: "1.0.0", marker: "orphan-overlay" },
  }));

  const action = dualWriteMod.mirrorRetractFromRegistry("orphan-overlay");
  assert.equal(action, "frozen-from-overlay");

  const frozen = defsStoreMod.readDef("orphan-overlay");
  assert.equal(frozen?.kind, "local");
  assert.equal(frozen?.title, "orphan-overlay", "best-effort title fallback when cache missing");
  // Overlay's mods still preserved.
  assert.equal(frozen?.rules?.content, "saved mod content");
  assert.equal(frozen?.frozen_from_retraction?.name, "orphan-overlay");
});

// ─────────────────────────────────────────────────────────────
// Field selection: cache provides identity + infrastructure; overlay provides allowlist mods
// ─────────────────────────────────────────────────────────────

test("frozen LocalDef takes infrastructure (auth/transport/serverUrl) from cache (NEVER overlay)", async () => {
  await freshHome();
  cacheStoreMod.writeCache(planCache("infra-from-cache", {
    auth: { type: "api_key", keyEnvVar: "UPSTREAM_KEY" },
    transport: "stdio",
    stdioCommand: "node",
    stdioArgs: ["/path/to/server.js"],
  }));
  defsStoreMod.writeDef(planOverlay("infra-from-cache"));

  dualWriteMod.mirrorRetractFromRegistry("infra-from-cache");
  const frozen = defsStoreMod.readDef("infra-from-cache");
  assert.deepEqual(frozen?.auth, { type: "api_key", keyEnvVar: "UPSTREAM_KEY" });
  assert.equal(frozen?.transport, "stdio");
  assert.deepEqual(frozen?.stdio, { command: "node", args: ["/path/to/server.js"] });
});

test("frozen LocalDef preserves cache.flavorText (publisher brand) and other metadata", async () => {
  await freshHome();
  cacheStoreMod.writeCache(planCache("metadata-preserve", {
    flavorText: "Original publisher's flavor",
    rarity: "epic",
    homepage: "https://publisher.example",
    license: "MIT",
  }));
  defsStoreMod.writeDef(planOverlay("metadata-preserve"));

  dualWriteMod.mirrorRetractFromRegistry("metadata-preserve");
  const frozen = defsStoreMod.readDef("metadata-preserve");
  assert.equal(frozen?.flavorText, "Original publisher's flavor");
  assert.equal(frozen?.rarity, "epic");
  assert.equal(frozen?.homepage, "https://publisher.example");
  assert.equal(frozen?.license, "MIT");
});
