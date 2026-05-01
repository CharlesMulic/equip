// Spike test 1: install one augment from a mock registry to a mock platform.
//
// Validates the core data flow: user clicks install → registry fetched →
// content stored in content-store → install intent appended to journal →
// materializer produces correct ResolvedAugment view → platform writer
// produces fingerprinted output.
//
// Acceptance criteria for storage install flow: this test passes cleanly with no
// rough edges in the v2 module surface area.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let datastoreMod, journalMod, registryMod, platformMod;

async function freshHome(prefix = "storage-install-") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.EQUIP_HOME = tmp;
  // Lazy-load v2 modules — they read EQUIP_HOME at call time.
  if (!datastoreMod) datastoreMod = await import("../../dist/lib/storage/datastore.js");
  if (!journalMod) journalMod = await import("../../dist/lib/storage/intent-journal.js");
  if (!registryMod) registryMod = await import("../../dist/lib/storage/mock-registry.js");
  if (!platformMod) platformMod = await import("../../dist/lib/storage/mock-platform.js");
  // Reset the in-memory seq counter so tests don't see stale state.
  journalMod._resetSeqForTests();
  return tmp;
}

test("install flow: fetch from registry → store content → append intent → materialize → write platform config", async () => {
  const home = await freshHome();
  const { JsonStore } = datastoreMod;
  const registry = new registryMod.MockRegistry();
  const platform = new platformMod.MockPlatform();

  // Publisher publishes augment "demo-tool" v1 to the registry.
  registry.publish("demo-tool", 1, {
    name: "demo-tool",
    title: "Demo Tool",
    description: "A demo tool",
    transport: "http",
    serverUrl: "https://demo.example/mcp",
    requiresAuth: false,
    rules: { content: "Be helpful", version: "1.0.0", marker: "demo-tool" },
    skills: [],
    hooks: [],
  });

  // === User installs ===
  // Step 1: fetch from registry.
  const fetched = registry.fetchLatest("demo-tool");
  assert.ok(fetched, "registry returns content");

  // Step 2: store content blob (content-addressed).
  const contentHash = JsonStore.putContent(fetched.content);
  assert.match(contentHash, /^[a-f0-9]{64}$/, "contentHash is SHA-256 hex");
  assert.ok(JsonStore.hasContent(contentHash), "content blob written to store");

  // Step 3: append install intent to journal.
  JsonStore.appendIntent({
    type: "install-augment",
    clock: JsonStore.newClock(),
    name: "demo-tool",
    contentHash,
    contentSource: { kind: "registry", version: 1, etag: fetched.etag, fetchedAt: fetched.fetchedAt },
    platforms: ["claude-code"],
  });

  // === Verify materialized state ===
  const resolved = JsonStore.resolve("demo-tool");
  assert.ok(resolved, "augment resolves");
  assert.equal(resolved.name, "demo-tool");
  assert.equal(resolved.title, "Demo Tool");
  assert.equal(resolved.serverUrl, "https://demo.example/mcp");
  assert.deepEqual(resolved.rules, { content: "Be helpful", version: "1.0.0", marker: "demo-tool" });
  assert.equal(resolved.installed, true);
  assert.deepEqual(resolved.installedPlatforms, ["claude-code"]);
  assert.equal(resolved.modded, false);
  assert.deepEqual(resolved.moddedFields, []);
  assert.equal(resolved.contentHash, contentHash);
  assert.equal(resolved.pinnedTo, null);
  assert.equal(resolved.contentSource.kind, "registry");

  // === Verify platform write (downstream consumer) ===
  const write = platform.applyAugmentToPlatform(resolved, "claude-code");
  assert.equal(write.platformId, "claude-code");
  assert.equal(write.augmentName, "demo-tool");
  assert.match(write.fingerprint, /^[a-f0-9]{64}$/);

  // === Verify on-disk shape ===
  const journalPath = path.join(home, "storage", "intents.jsonl");
  assert.ok(fs.existsSync(journalPath), "intents.jsonl created");
  const lines = fs.readFileSync(journalPath, "utf-8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "exactly one intent appended");
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.type, "install-augment");
  assert.equal(parsed.name, "demo-tool");

  const contentPath = path.join(home, "storage", "content", `${contentHash}.json`);
  assert.ok(fs.existsSync(contentPath), "content blob created at hash-keyed path");
});

test("multi-platform install: one intent records all target platforms", async () => {
  await freshHome();
  const { JsonStore } = datastoreMod;
  const registry = new registryMod.MockRegistry();

  registry.publish("multi-platform", 1, {
    name: "multi-platform",
    title: "Multi Platform",
    description: "Installs everywhere",
    transport: "http",
    serverUrl: "https://mp.example/mcp",
    requiresAuth: false,
    rules: { content: "x", version: "1.0.0", marker: "multi-platform" },
    skills: [],
    hooks: [],
  });

  const fetched = registry.fetchLatest("multi-platform");
  const contentHash = JsonStore.putContent(fetched.content);
  JsonStore.appendIntent({
    type: "install-augment",
    clock: JsonStore.newClock(),
    name: "multi-platform",
    contentHash,
    contentSource: { kind: "registry", version: 1, etag: fetched.etag, fetchedAt: fetched.fetchedAt },
    platforms: ["claude-code", "cursor", "codex"],
  });

  const resolved = JsonStore.resolve("multi-platform");
  assert.deepEqual(resolved.installedPlatforms, ["claude-code", "cursor", "codex"]);
  assert.equal(resolved.installed, true);
});

test("partial uninstall: remove from one platform leaves others installed", async () => {
  await freshHome();
  const { JsonStore } = datastoreMod;
  const registry = new registryMod.MockRegistry();

  registry.publish("partial-uninstall", 1, {
    name: "partial-uninstall",
    title: "Partial",
    description: "x",
    transport: "http",
    serverUrl: "https://x",
    requiresAuth: false,
    rules: { content: "x", version: "1.0.0", marker: "partial-uninstall" },
    skills: [],
    hooks: [],
  });
  const fetched = registry.fetchLatest("partial-uninstall");
  const contentHash = JsonStore.putContent(fetched.content);
  JsonStore.appendIntent({
    type: "install-augment", clock: JsonStore.newClock(), name: "partial-uninstall",
    contentHash, contentSource: { kind: "registry", version: 1, etag: fetched.etag, fetchedAt: fetched.fetchedAt },
    platforms: ["claude-code", "cursor", "codex"],
  });

  // Uninstall from one platform.
  JsonStore.appendIntent({
    type: "uninstall-augment", clock: JsonStore.newClock(), name: "partial-uninstall",
    platforms: ["cursor"],
  });

  const resolved = JsonStore.resolve("partial-uninstall");
  assert.equal(resolved.installed, true, "still installed somewhere");
  assert.deepEqual(resolved.installedPlatforms, ["claude-code", "codex"]);
});

test("full uninstall: clears all platforms; resolved still exists with installed=false", async () => {
  await freshHome();
  const { JsonStore } = datastoreMod;
  const registry = new registryMod.MockRegistry();

  registry.publish("full-uninstall", 1, {
    name: "full-uninstall", title: "Full", description: "x", transport: "http",
    serverUrl: "https://x", requiresAuth: false,
    rules: { content: "x", version: "1.0.0", marker: "full-uninstall" }, skills: [], hooks: [],
  });
  const fetched = registry.fetchLatest("full-uninstall");
  const contentHash = JsonStore.putContent(fetched.content);
  JsonStore.appendIntent({
    type: "install-augment", clock: JsonStore.newClock(), name: "full-uninstall",
    contentHash, contentSource: { kind: "registry", version: 1, etag: fetched.etag, fetchedAt: fetched.fetchedAt },
    platforms: ["claude-code"],
  });

  // Full uninstall (no platforms specified = all).
  JsonStore.appendIntent({
    type: "uninstall-augment", clock: JsonStore.newClock(), name: "full-uninstall",
  });

  const resolved = JsonStore.resolve("full-uninstall");
  assert.ok(resolved, "still resolves (content + history preserved for reinstall)");
  assert.equal(resolved.installed, false);
  assert.deepEqual(resolved.installedPlatforms, []);
});
