// Spike-prototype tests for the store-orchestrator.ts cross-store retraction
// flow. Verifies the architect's ordering rule is preserved and the orchestrator
// produces the same end-state as the existing applyRegistryRetraction +
// mirrorRetractFromRegistry path.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let orchestratorMod;
let defsStoreMod;
let cacheStoreMod;
let installsStoreMod;

async function freshHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-orch-test-"));
  process.env.EQUIP_HOME = tmp;
  if (!orchestratorMod) orchestratorMod = await import("../dist/lib/store-orchestrator.js");
  if (!defsStoreMod) defsStoreMod = await import("../dist/lib/defs-store.js");
  if (!cacheStoreMod) cacheStoreMod = await import("../dist/lib/cache-store.js");
  if (!installsStoreMod) installsStoreMod = await import("../dist/lib/installs-store.js");
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

function planInstall(name, overrides = {}) {
  return {
    name,
    installedAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
    platforms: ["cursor"],
    artifacts: { cursor: { mcp: true, rules: "1.0.0", skills: [] } },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Ordering rule: side effects → derived state → durable marker last
// ─────────────────────────────────────────────────────────────

test("retract: ordering rule fires removePlatformArtifacts BEFORE installs/ deletion", async () => {
  await freshHome();
  cacheStoreMod.writeCache(planCache("ordered"));
  installsStoreMod.writeInstall(planInstall("ordered"));

  const callLog = [];
  await orchestratorMod.retractRegistryAugment("ordered", {
    removePlatformArtifacts: async () => {
      // At this point the install record MUST still exist — side effects
      // first, then derived state.
      const stillExists = installsStoreMod.readInstall("ordered");
      callLog.push(stillExists ? "side-effect-saw-install" : "side-effect-saw-no-install");
    },
  });

  assert.deepEqual(callLog, ["side-effect-saw-install"],
    "removePlatformArtifacts must run BEFORE installs/ deletion");
  // After orchestrator: install gone + cache gone
  assert.equal(installsStoreMod.readInstall("ordered"), null);
  assert.equal(cacheStoreMod.readCache("ordered"), null);
});

// ─────────────────────────────────────────────────────────────
// Promotion: overlay + cache → frozen LocalDef (parity with mirrorRetractFromRegistry)
// ─────────────────────────────────────────────────────────────

test("retract with active overlay: promotes to frozen kind=local with overlay's mods preserved", async () => {
  await freshHome();
  cacheStoreMod.writeCache(planCache("retract-overlay"));
  defsStoreMod.writeDef(planOverlay("retract-overlay", {
    rules: { content: "MY MOD RULES", version: "1.0.0", marker: "retract-overlay" },
    skills: [{ name: "my-mod-skill", files: [{ path: "SKILL.md", content: "modded" }] }],
  }));

  const outcome = await orchestratorMod.retractRegistryAugment("retract-overlay", {
    retractedAt: "2026-04-29T00:00:00.000Z",
  });
  assert.equal(outcome, "frozen-from-overlay");

  const frozen = defsStoreMod.readDef("retract-overlay");
  assert.equal(frozen?.kind, "local", "overlay promoted to frozen LocalDef");
  assert.equal(frozen?.title, "Upstream Title", "identity from cache");
  assert.equal(frozen?.transport, "http", "infrastructure from cache");
  assert.equal(frozen?.serverUrl, "https://upstream.example/retract-overlay");
  assert.equal(frozen?.rules?.content, "MY MOD RULES", "overlay's rules preserved");
  assert.equal(frozen?.skills?.[0]?.name, "my-mod-skill", "overlay's skills preserved");
  assert.equal(frozen?.frozen_from_retraction?.name, "retract-overlay");
  assert.equal(frozen?.frozen_from_retraction?.retractedAt, "2026-04-29T00:00:00.000Z");
  assert.equal(frozen?.frozen_from_retraction?.lastSeenContentHash, "hash-retract-overlay-v3");
  // Cache deleted as part of promotion
  assert.equal(cacheStoreMod.readCache("retract-overlay"), null);
});

// ─────────────────────────────────────────────────────────────
// Cache-only: no overlay → just delete cache (+ install if present)
// ─────────────────────────────────────────────────────────────

test("retract with no overlay: deletes cache + install (no defs entry created)", async () => {
  await freshHome();
  cacheStoreMod.writeCache(planCache("pure-registry-retract"));
  installsStoreMod.writeInstall(planInstall("pure-registry-retract"));

  const outcome = await orchestratorMod.retractRegistryAugment("pure-registry-retract");
  assert.ok(outcome === "cache-deleted" || outcome === "install-removed",
    `expected cache-deleted or install-removed, got ${outcome}`);

  assert.equal(cacheStoreMod.readCache("pure-registry-retract"), null);
  assert.equal(installsStoreMod.readInstall("pure-registry-retract"), null);
  assert.equal(defsStoreMod.readDef("pure-registry-retract"), null,
    "no overlay → no frozen LocalDef created");
});

// ─────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────

test("retract is idempotent — re-firing on already-retracted state is a no-op", async () => {
  await freshHome();
  cacheStoreMod.writeCache(planCache("idem"));
  defsStoreMod.writeDef(planOverlay("idem"));

  const first = await orchestratorMod.retractRegistryAugment("idem");
  assert.equal(first, "frozen-from-overlay");

  const second = await orchestratorMod.retractRegistryAugment("idem");
  assert.equal(second, "no-op", "re-firing on already-frozen state is a no-op");

  const frozen = defsStoreMod.readDef("idem");
  assert.equal(frozen?.kind, "local");
  assert.equal(frozen?.frozen_from_retraction?.name, "idem");
});

// ─────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────

test("retract on augment that doesn't exist anywhere returns no-op", async () => {
  await freshHome();
  const outcome = await orchestratorMod.retractRegistryAugment("never-existed");
  assert.equal(outcome, "no-op");
});

test("retract with overlay-only (cache already gone) freezes from overlay-only content", async () => {
  await freshHome();
  defsStoreMod.writeDef(planOverlay("orphan-overlay", {
    rules: { content: "saved mod content", version: "1.0.0", marker: "orphan-overlay" },
  }));

  const outcome = await orchestratorMod.retractRegistryAugment("orphan-overlay");
  assert.equal(outcome, "frozen-from-overlay");

  const frozen = defsStoreMod.readDef("orphan-overlay");
  assert.equal(frozen?.kind, "local");
  assert.equal(frozen?.title, "orphan-overlay", "best-effort title fallback when cache missing");
  assert.equal(frozen?.rules?.content, "saved mod content");
  assert.equal(frozen?.frozen_from_retraction?.name, "orphan-overlay");
});

test("removePlatformArtifacts callback is optional (no install record → no callback fired)", async () => {
  await freshHome();
  cacheStoreMod.writeCache(planCache("no-install"));

  let callbackFired = false;
  const outcome = await orchestratorMod.retractRegistryAugment("no-install", {
    removePlatformArtifacts: () => { callbackFired = true; },
  });
  assert.equal(outcome, "cache-deleted");
  assert.equal(callbackFired, false, "callback not fired when there's no install record");
});

// ─────────────────────────────────────────────────────────────
// promoteWrappedToLocal — wrapped → local kind transition
// ─────────────────────────────────────────────────────────────

function planWrapped(name, overrides = {}) {
  return {
    name,
    kind: "wrapped",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
    title: name,
    description: `Wrapped ${name}`,
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    wrappedFrom: { type: "mcp", platform: "cursor" },
    ...overrides,
  };
}

function planLocal(name, overrides = {}) {
  return {
    name,
    kind: "local",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
    title: name,
    description: `Local ${name}`,
    requiresAuth: false,
    skills: [],
    baseWeight: 0,
    loadedWeight: 0,
    ...overrides,
  };
}

test("promoteWrappedToLocal: not-found when no def exists", async () => {
  await freshHome();
  const result = orchestratorMod.promoteWrappedToLocal("nonexistent");
  assert.equal(result.outcome, "not-found");
  assert.equal(result.def, null);
});

test("promoteWrappedToLocal: already-local when def is already kind=local", async () => {
  await freshHome();
  defsStoreMod.writeDef(planLocal("already-local-aug"));
  const result = orchestratorMod.promoteWrappedToLocal("already-local-aug");
  assert.equal(result.outcome, "already-local");
  assert.equal(result.def?.kind, "local");
  assert.equal(result.def?.name, "already-local-aug");
});

test("promoteWrappedToLocal: not-found when def is overlay (cannot promote modded registry)", async () => {
  await freshHome();
  // Overlay defs are conceptually registry-augment mods, not promotable.
  defsStoreMod.writeDef({
    name: "overlay-aug",
    kind: "overlay",
    overlay_of: "overlay-aug",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
  });
  const result = orchestratorMod.promoteWrappedToLocal("overlay-aug");
  assert.equal(result.outcome, "not-found",
    "overlay → caller's responsibility to error; orchestrator treats as not-found");
});

test("promoteWrappedToLocal: wrapped def becomes local with all content preserved", async () => {
  await freshHome();
  const wrapped = planWrapped("promote-me", {
    title: "Promote Me Title",
    description: "Original description",
    transport: "http",
    serverUrl: "https://example.com/promote",
    rules: { content: "rules content", version: "1.0.0", marker: "promote-me" },
    skills: [{ name: "skill-a", files: [{ path: "SKILL.md", content: "skill body" }] }],
    baseWeight: 100,
    loadedWeight: 200,
    wrappedFrom: { type: "mcp", platform: "cursor", path: "/some/path" },
  });
  defsStoreMod.writeDef(wrapped);

  const result = orchestratorMod.promoteWrappedToLocal("promote-me");
  assert.equal(result.outcome, "promoted");
  assert.equal(result.def?.kind, "local");
  assert.equal(result.def?.name, "promote-me");
  assert.equal(result.def?.title, "Promote Me Title");
  assert.equal(result.def?.serverUrl, "https://example.com/promote");
  assert.deepEqual(result.def?.rules, { content: "rules content", version: "1.0.0", marker: "promote-me" });
  assert.equal(result.def?.skills?.[0]?.name, "skill-a");
  assert.equal(result.def?.baseWeight, 100);
  assert.equal(result.def?.loadedWeight, 200);
  // updatedAt advances on promotion.
  assert.notEqual(result.def?.updatedAt, wrapped.updatedAt);

  // Disk reflects the promotion.
  const onDisk = defsStoreMod.readDef("promote-me");
  assert.equal(onDisk?.kind, "local");
});

test("promoteWrappedToLocal: idempotent — re-running on already-promoted def is already-local", async () => {
  await freshHome();
  defsStoreMod.writeDef(planWrapped("twice"));

  const first = orchestratorMod.promoteWrappedToLocal("twice");
  assert.equal(first.outcome, "promoted");

  const second = orchestratorMod.promoteWrappedToLocal("twice");
  assert.equal(second.outcome, "already-local");
});
