// Spike test 2: mod survives refresh.
//
// THE load-bearing test for the architecture. The whole reason for the
// intent-journal model is that "mod" and "content" are independent: mod is
// a function applied to current content, NOT a content fork. Therefore a
// refresh that swaps the content blob doesn't lose the mod.
//
// Pre-Pkg-06 architecture had this property too (overlay defs/ + cache/),
// but it required complex routing logic. This test verifies the v2 design
// gets it for free from the journal model.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let datastoreMod, journalMod, registryMod;

async function freshHome(prefix = "v2-modrefresh-") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.EQUIP_HOME = tmp;
  if (!datastoreMod) datastoreMod = await import("../../dist/lib/v2/datastore.js");
  if (!journalMod) journalMod = await import("../../dist/lib/v2/intent-journal.js");
  if (!registryMod) registryMod = await import("../../dist/lib/v2/mock-registry.js");
  journalMod._resetSeqForTests();
  return tmp;
}

test("mod survives refresh: registry pushes v2; mod's overrides still win in materialized view", async () => {
  await freshHome();
  const { JsonStore } = datastoreMod;
  const registry = new registryMod.MockRegistry();

  // === Setup: publish v1, install, mod the rules ===
  registry.publish("modded-aug", 1, {
    name: "modded-aug",
    title: "Modded Aug",
    description: "v1 description",
    transport: "http",
    serverUrl: "https://v1.example/mcp",
    requiresAuth: false,
    rules: { content: "v1 PUBLISHER rules", version: "1.0.0", marker: "modded-aug" },
    skills: [],
    hooks: [],
  });

  const v1Fetch = registry.fetchLatest("modded-aug");
  const v1Hash = JsonStore.putContent(v1Fetch.content);
  JsonStore.appendIntent({
    type: "install-augment", clock: JsonStore.newClock(), name: "modded-aug",
    contentHash: v1Hash, contentSource: { kind: "registry", version: 1, etag: v1Fetch.etag, fetchedAt: v1Fetch.fetchedAt },
    platforms: ["claude-code"],
  });

  // User mods the rules.
  JsonStore.appendIntent({
    type: "mod-augment", clock: JsonStore.newClock(), name: "modded-aug",
    overrides: {
      rules: { content: "USER MODDED rules", version: "1.0.0-custom", marker: "modded-aug" },
    },
  });

  // Verify post-mod state.
  const afterMod = JsonStore.resolve("modded-aug");
  assert.equal(afterMod.modded, true);
  assert.deepEqual(afterMod.moddedFields, ["rules"]);
  assert.equal(afterMod.rules.content, "USER MODDED rules");
  assert.equal(afterMod.title, "Modded Aug", "publisher's title still authoritative");
  assert.equal(afterMod.serverUrl, "https://v1.example/mcp");

  // === Publisher releases v2 with NEW rules + NEW serverUrl ===
  registry.publish("modded-aug", 2, {
    name: "modded-aug",
    title: "Modded Aug v2",
    description: "v2 description",
    transport: "http",
    serverUrl: "https://v2.example/mcp",
    requiresAuth: false,
    rules: { content: "v2 PUBLISHER rules (DIFFERENT)", version: "2.0.0", marker: "modded-aug" },
    skills: [],
    hooks: [],
  });

  // === User refreshes ===
  const v2Fetch = registry.fetchLatest("modded-aug");
  const v2Hash = JsonStore.putContent(v2Fetch.content);
  JsonStore.appendIntent({
    type: "refresh-augment", clock: JsonStore.newClock(), name: "modded-aug",
    newContentHash: v2Hash, contentSource: { kind: "registry", version: 2, etag: v2Fetch.etag, fetchedAt: v2Fetch.fetchedAt },
  });

  // === The load-bearing assertions ===
  const afterRefresh = JsonStore.resolve("modded-aug");

  // Content reference swapped to v2.
  assert.equal(afterRefresh.contentHash, v2Hash, "contentHash swapped to v2");
  assert.equal(afterRefresh.contentSource.kind, "registry");
  assert.equal(afterRefresh.contentSource.version, 2);

  // Publisher's NON-MODDED fields updated to v2.
  assert.equal(afterRefresh.title, "Modded Aug v2", "title from v2 (not modded)");
  assert.equal(afterRefresh.description, "v2 description", "description from v2 (not modded)");
  assert.equal(afterRefresh.serverUrl, "https://v2.example/mcp", "serverUrl from v2 (not modded)");

  // **THE KEY ASSERTION**: rules still reflect the user's mod, NOT v2's publisher rules.
  assert.equal(afterRefresh.rules.content, "USER MODDED rules",
    "MOD SURVIVED REFRESH: user's modded rules win over publisher's v2 rules");
  assert.equal(afterRefresh.modded, true);
  assert.deepEqual(afterRefresh.moddedFields, ["rules"]);

  // Both content blobs still on disk (content-addressed; v1 not deleted).
  assert.ok(JsonStore.hasContent(v1Hash), "v1 content still in store (no GC ran)");
  assert.ok(JsonStore.hasContent(v2Hash), "v2 content in store");
});

test("mod cleared via empty mod intent: refresh now picks up publisher's rules", async () => {
  await freshHome();
  const { JsonStore } = datastoreMod;
  const registry = new registryMod.MockRegistry();

  registry.publish("clear-mod", 1, {
    name: "clear-mod", title: "Clear Mod", description: "v1", transport: "http",
    serverUrl: "https://v1", requiresAuth: false,
    rules: { content: "PUBLISHER v1", version: "1.0.0", marker: "clear-mod" },
    skills: [], hooks: [],
  });
  const v1Fetch = registry.fetchLatest("clear-mod");
  const v1Hash = JsonStore.putContent(v1Fetch.content);
  JsonStore.appendIntent({
    type: "install-augment", clock: JsonStore.newClock(), name: "clear-mod",
    contentHash: v1Hash, contentSource: { kind: "registry", version: 1, etag: v1Fetch.etag, fetchedAt: v1Fetch.fetchedAt },
    platforms: ["claude-code"],
  });
  JsonStore.appendIntent({
    type: "mod-augment", clock: JsonStore.newClock(), name: "clear-mod",
    overrides: { rules: { content: "MOD", version: "1.0.0", marker: "clear-mod" } },
  });

  // Clear the mod (empty overrides intent).
  JsonStore.appendIntent({
    type: "mod-augment", clock: JsonStore.newClock(), name: "clear-mod",
    overrides: {},
  });

  const resolved = JsonStore.resolve("clear-mod");
  assert.equal(resolved.modded, false);
  assert.deepEqual(resolved.moddedFields, []);
  assert.equal(resolved.rules.content, "PUBLISHER v1", "mod cleared → publisher rules win");
});

test("pin holds across refresh: pinned content stays even when registry has newer version", async () => {
  await freshHome();
  const { JsonStore } = datastoreMod;
  const registry = new registryMod.MockRegistry();

  registry.publish("pinned-aug", 1, {
    name: "pinned-aug", title: "Pinned", description: "v1", transport: "http",
    serverUrl: "https://v1", requiresAuth: false,
    rules: { content: "v1 rules", version: "1.0.0", marker: "pinned-aug" }, skills: [], hooks: [],
  });
  const v1Fetch = registry.fetchLatest("pinned-aug");
  const v1Hash = JsonStore.putContent(v1Fetch.content);
  JsonStore.appendIntent({
    type: "install-augment", clock: JsonStore.newClock(), name: "pinned-aug",
    contentHash: v1Hash, contentSource: { kind: "registry", version: 1, etag: v1Fetch.etag, fetchedAt: v1Fetch.fetchedAt },
    platforms: ["claude-code"],
  });

  // User pins to v1's hash.
  JsonStore.appendIntent({
    type: "pin-augment", clock: JsonStore.newClock(), name: "pinned-aug",
    contentHash: v1Hash,
  });

  // Publisher releases v2.
  registry.publish("pinned-aug", 2, {
    name: "pinned-aug", title: "Pinned v2", description: "v2", transport: "http",
    serverUrl: "https://v2", requiresAuth: false,
    rules: { content: "v2 rules", version: "2.0.0", marker: "pinned-aug" }, skills: [], hooks: [],
  });
  const v2Fetch = registry.fetchLatest("pinned-aug");
  const v2Hash = JsonStore.putContent(v2Fetch.content);

  // Refresh attempt — should be ignored due to pin.
  JsonStore.appendIntent({
    type: "refresh-augment", clock: JsonStore.newClock(), name: "pinned-aug",
    newContentHash: v2Hash, contentSource: { kind: "registry", version: 2, etag: v2Fetch.etag, fetchedAt: v2Fetch.fetchedAt },
  });

  const resolved = JsonStore.resolve("pinned-aug");
  assert.equal(resolved.contentHash, v1Hash, "pin held; refresh ignored");
  assert.equal(resolved.title, "Pinned", "still showing v1 title");
  assert.equal(resolved.pinnedTo, v1Hash);
});
