// Spike test 3: multi-augment scaling.
//
// Validates that the per-augment fold + listResolved() produce correct
// results when many augments coexist with different histories. Per-augment
// state must not leak (mod on A doesn't affect B's resolved view).

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let datastoreMod, journalMod, registryMod;

async function freshHome(prefix = "v2-multi-") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.EQUIP_HOME = tmp;
  if (!datastoreMod) datastoreMod = await import("../../dist/lib/v2/datastore.js");
  if (!journalMod) journalMod = await import("../../dist/lib/v2/intent-journal.js");
  if (!registryMod) registryMod = await import("../../dist/lib/v2/mock-registry.js");
  journalMod._resetSeqForTests();
  return tmp;
}

function publish(registry, name, version) {
  registry.publish(name, version, {
    name,
    title: `${name} v${version}`,
    description: `${name} description v${version}`,
    transport: "http",
    serverUrl: `https://${name}.example/v${version}`,
    requiresAuth: false,
    rules: { content: `${name} v${version} rules`, version: `${version}.0.0`, marker: name },
    skills: [],
    hooks: [],
  });
}

function installLatest(JsonStore, registry, name, platforms = ["claude-code"]) {
  const fetched = registry.fetchLatest(name);
  const hash = JsonStore.putContent(fetched.content);
  JsonStore.appendIntent({
    type: "install-augment", clock: JsonStore.newClock(), name,
    contentHash: hash, contentSource: { kind: "registry", version: fetched.version, etag: fetched.etag, fetchedAt: fetched.fetchedAt },
    platforms,
  });
  return hash;
}

test("install 5 augments + mod 2 + refresh 1 + uninstall 1: each resolves independently", async () => {
  await freshHome();
  const { JsonStore } = datastoreMod;
  const registry = new registryMod.MockRegistry();

  // Publish + install five augments.
  for (const name of ["aug-a", "aug-b", "aug-c", "aug-d", "aug-e"]) {
    publish(registry, name, 1);
    installLatest(JsonStore, registry, name);
  }

  // Mod aug-a (rules) and aug-c (hooks).
  JsonStore.appendIntent({
    type: "mod-augment", clock: JsonStore.newClock(), name: "aug-a",
    overrides: { rules: { content: "MODDED A rules", version: "1.0.0", marker: "aug-a" } },
  });
  JsonStore.appendIntent({
    type: "mod-augment", clock: JsonStore.newClock(), name: "aug-c",
    overrides: { hooks: [{ type: "PostToolUse", command: "modded-hook" }] },
  });

  // Publisher releases aug-b v2; user refreshes.
  publish(registry, "aug-b", 2);
  const fetchedB2 = registry.fetchLatest("aug-b");
  const b2Hash = JsonStore.putContent(fetchedB2.content);
  JsonStore.appendIntent({
    type: "refresh-augment", clock: JsonStore.newClock(), name: "aug-b",
    newContentHash: b2Hash, contentSource: { kind: "registry", version: 2, etag: fetchedB2.etag, fetchedAt: fetchedB2.fetchedAt },
  });

  // Uninstall aug-e.
  JsonStore.appendIntent({
    type: "uninstall-augment", clock: JsonStore.newClock(), name: "aug-e",
  });

  // === Verify each augment's resolved state independently ===

  const a = JsonStore.resolve("aug-a");
  assert.equal(a.modded, true, "aug-a is modded");
  assert.deepEqual(a.moddedFields, ["rules"]);
  assert.equal(a.rules.content, "MODDED A rules");
  assert.equal(a.installed, true);

  const b = JsonStore.resolve("aug-b");
  assert.equal(b.modded, false, "aug-b is NOT modded");
  assert.equal(b.title, "aug-b v2", "aug-b refreshed to v2");
  assert.equal(b.contentSource.version, 2);

  const c = JsonStore.resolve("aug-c");
  assert.equal(c.modded, true, "aug-c is modded (hooks)");
  assert.deepEqual(c.moddedFields, ["hooks"]);
  assert.equal(c.hooks[0].command, "modded-hook");
  assert.equal(c.title, "aug-c v1", "aug-c not refreshed, still v1");

  const d = JsonStore.resolve("aug-d");
  assert.equal(d.modded, false, "aug-d untouched after install");
  assert.equal(d.installed, true);
  assert.equal(d.title, "aug-d v1");

  const e = JsonStore.resolve("aug-e");
  assert.equal(e.installed, false, "aug-e uninstalled");
  assert.deepEqual(e.installedPlatforms, []);

  // listResolved returns all five.
  const all = JsonStore.listResolved();
  assert.equal(all.length, 5, "all 5 augments still in resolved view");
  const names = all.map((r) => r.name).sort();
  assert.deepEqual(names, ["aug-a", "aug-b", "aug-c", "aug-d", "aug-e"]);
});

test("content store dedup: two augments with identical content collapse to one blob", async () => {
  await freshHome();
  const { JsonStore } = datastoreMod;

  const sharedContent = {
    name: "first",
    title: "Shared",
    description: "Same content for both",
    transport: "http",
    serverUrl: "https://shared.example/mcp",
    requiresAuth: false,
    rules: { content: "shared rules", version: "1.0.0", marker: "first" },
    skills: [],
    hooks: [],
  };

  const firstHash = JsonStore.putContent(sharedContent);
  // Same content (just renamed) → MUST hash differently because name is part of content.
  const secondHash = JsonStore.putContent({ ...sharedContent, name: "second", rules: { ...sharedContent.rules, marker: "second" } });
  assert.notEqual(firstHash, secondHash, "different names + markers → different hashes");

  // But truly-identical content (same name, same fields) → same hash → idempotent put.
  const dupHash = JsonStore.putContent(sharedContent);
  assert.equal(dupHash, firstHash, "putting identical content is idempotent");

  // Content blobs persist independently.
  assert.ok(JsonStore.hasContent(firstHash));
  assert.ok(JsonStore.hasContent(secondHash));
});

test("clock seq is monotonic and survives across reads (intents folded in append order)", async () => {
  await freshHome();
  const { JsonStore } = datastoreMod;
  const registry = new registryMod.MockRegistry();

  // Three install intents in quick succession on same augment.
  publish(registry, "seq-test", 1);
  for (let i = 0; i < 3; i++) {
    const fetched = registry.fetchLatest("seq-test");
    const hash = JsonStore.putContent(fetched.content);
    JsonStore.appendIntent({
      type: "install-augment", clock: JsonStore.newClock(), name: "seq-test",
      contentHash: hash, contentSource: { kind: "registry", version: 1, etag: fetched.etag, fetchedAt: fetched.fetchedAt },
      platforms: [`platform-${i}`],
    });
  }

  // Latest install wins → installedPlatforms reflects only the last intent.
  const resolved = JsonStore.resolve("seq-test");
  assert.deepEqual(resolved.installedPlatforms, ["platform-2"], "latest install supersedes");

  // Verify journal seq numbers are monotonic.
  const intents = JsonStore.readIntents();
  const seqs = intents.map((i) => i.clock.seq);
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i] > seqs[i - 1], `seq monotonic: ${seqs[i - 1]} → ${seqs[i]}`);
  }
});

test("fold determinism: same journal produces same resolved state across reads", async () => {
  await freshHome();
  const { JsonStore } = datastoreMod;
  const registry = new registryMod.MockRegistry();

  publish(registry, "deterministic", 1);
  installLatest(JsonStore, registry, "deterministic", ["claude-code", "cursor"]);
  JsonStore.appendIntent({
    type: "mod-augment", clock: JsonStore.newClock(), name: "deterministic",
    overrides: { rules: { content: "M", version: "1.0.0", marker: "deterministic" } },
  });

  const a = JsonStore.resolve("deterministic");
  const b = JsonStore.resolve("deterministic");
  // Resolved views are pure functions of the journal — should be deeply equal.
  assert.deepEqual(a, b);
});
