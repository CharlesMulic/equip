// Cache-store TTL discipline tests (Pkg 03 of equip-storage-refactor).
//
// Pin the architectural commitment from Pkg 01: cache-store IS a cache, with
// explicit freshness gates. Soft TTL on read (returns immediately, fires async
// revalidate); hard TTL on install (blocks until refresh completes).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let cacheStoreMod;

async function freshHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cache-ttl-test-"));
  process.env.EQUIP_HOME = tmp;
  delete process.env.EQUIP_CACHE_SOFT_TTL_MS;
  delete process.env.EQUIP_CACHE_HARD_TTL_MS;
  delete process.env.EQUIP_CACHE_DISCIPLINE_DISABLED;
  if (!cacheStoreMod) cacheStoreMod = await import("../dist/lib/cache-store.js");
  return tmp;
}

function cacheEntry(name, fetchedAt, overrides = {}) {
  return {
    name,
    fetchedAt,
    title: name,
    description: "test",
    requiresAuth: false,
    transport: "http",
    serverUrl: `https://upstream.example/${name}`,
    contentHash: `hash-${name}`,
    version: 1,
    ...overrides,
  };
}

function settle() {
  return new Promise((r) => setImmediate(r));
}

// ─────────────────────────────────────────────────────────────
// classifyFreshness — pure classifier
// ─────────────────────────────────────────────────────────────

test("classifyFreshness: fresh entry within soft TTL returns 'fresh'", async () => {
  await freshHome();
  const now = Date.now();
  const cached = cacheEntry("fresh-ent", new Date(now - 60_000).toISOString()); // 1min ago
  const f = cacheStoreMod.classifyFreshness(cached, { now, softTtlMs: 300_000, hardTtlMs: 86_400_000 });
  assert.equal(f, "fresh");
});

test("classifyFreshness: entry older than soft TTL but younger than hard TTL returns 'soft-stale'", async () => {
  await freshHome();
  const now = Date.now();
  const cached = cacheEntry("ss", new Date(now - 600_000).toISOString()); // 10min ago
  const f = cacheStoreMod.classifyFreshness(cached, { now, softTtlMs: 300_000, hardTtlMs: 86_400_000 });
  assert.equal(f, "soft-stale");
});

test("classifyFreshness: entry older than hard TTL returns 'hard-stale'", async () => {
  await freshHome();
  const now = Date.now();
  const cached = cacheEntry("hs", new Date(now - 100_000_000).toISOString()); // ~28h ago
  const f = cacheStoreMod.classifyFreshness(cached, { now, softTtlMs: 300_000, hardTtlMs: 86_400_000 });
  assert.equal(f, "hard-stale");
});

test("classifyFreshness: invalid fetchedAt returns 'missing-fetched-at' (legacy migration safety)", async () => {
  await freshHome();
  const cached = cacheEntry("legacy", "not-a-date");
  const f = cacheStoreMod.classifyFreshness(cached, { now: Date.now() });
  assert.equal(f, "missing-fetched-at");
});

// ─────────────────────────────────────────────────────────────
// readCacheWithFreshness — soft TTL behavior
// ─────────────────────────────────────────────────────────────

test("readCacheWithFreshness: missing entry returns freshness='missing', no revalidate", async () => {
  await freshHome();
  let called = false;
  const result = cacheStoreMod.readCacheWithFreshness("nope", {
    revalidate: async () => { called = true; },
  });
  assert.equal(result.cached, null);
  assert.equal(result.freshness, "missing");
  assert.equal(result.revalidating, false);
  await settle();
  assert.equal(called, false, "revalidate must NOT fire on cache miss");
});

test("readCacheWithFreshness: fresh entry returns immediately, no revalidate", async () => {
  await freshHome();
  cacheStoreMod.writeCache(cacheEntry("fr", new Date(Date.now() - 1000).toISOString()));
  let called = false;
  const result = cacheStoreMod.readCacheWithFreshness("fr", {
    revalidate: async () => { called = true; },
  });
  assert.equal(result.cached?.name, "fr");
  assert.equal(result.freshness, "fresh");
  assert.equal(result.revalidating, false);
  await settle();
  assert.equal(called, false, "fresh entry must NOT trigger revalidate");
});

test("readCacheWithFreshness: stale entry returns content immediately AND fires async revalidate", async () => {
  await freshHome();
  process.env.EQUIP_CACHE_SOFT_TTL_MS = "1000";
  cacheStoreMod.writeCache(cacheEntry("st", new Date(Date.now() - 60_000).toISOString()));

  let revalidateName = null;
  const result = cacheStoreMod.readCacheWithFreshness("st", {
    revalidate: async (n) => { revalidateName = n; },
  });

  // Synchronous: content returned immediately, revalidating flag set.
  assert.equal(result.cached?.name, "st");
  assert.equal(result.freshness, "soft-stale");
  assert.equal(result.revalidating, true);
  // Async: callback fires after microtask.
  await settle();
  assert.equal(revalidateName, "st", "stale read must trigger background revalidate");
});

test("readCacheWithFreshness: revalidate callback errors are swallowed (non-fatal)", async () => {
  await freshHome();
  process.env.EQUIP_CACHE_SOFT_TTL_MS = "1000";
  cacheStoreMod.writeCache(cacheEntry("err", new Date(Date.now() - 60_000).toISOString()));

  // Capture process.on('unhandledRejection') noise — we should NOT see one.
  let unhandled = null;
  const handler = (e) => { unhandled = e; };
  process.on("unhandledRejection", handler);
  try {
    const result = cacheStoreMod.readCacheWithFreshness("err", {
      revalidate: async () => { throw new Error("network down"); },
    });
    assert.equal(result.cached?.name, "err");
    assert.equal(result.revalidating, true);
    await settle();
    await settle();
    assert.equal(unhandled, null, "revalidate failure must NOT escape as unhandled rejection");
  } finally {
    process.off("unhandledRejection", handler);
  }
});

test("readCacheWithFreshness: legacy fetchedAt (invalid) treated as infinitely stale → revalidate fires", async () => {
  await freshHome();
  cacheStoreMod.writeCache(cacheEntry("legacy", "not-a-date"));
  let called = false;
  const result = cacheStoreMod.readCacheWithFreshness("legacy", {
    revalidate: async () => { called = true; },
  });
  assert.equal(result.cached?.name, "legacy");
  assert.equal(result.freshness, "missing-fetched-at");
  assert.equal(result.revalidating, true);
  await settle();
  assert.equal(called, true);
});

test("readCacheWithFreshness: stale + no revalidate callback → returns stale content, no error", async () => {
  await freshHome();
  process.env.EQUIP_CACHE_SOFT_TTL_MS = "1000";
  cacheStoreMod.writeCache(cacheEntry("nofn", new Date(Date.now() - 60_000).toISOString()));
  const result = cacheStoreMod.readCacheWithFreshness("nofn");
  assert.equal(result.cached?.name, "nofn");
  assert.equal(result.freshness, "soft-stale");
  assert.equal(result.revalidating, false, "no callback → no revalidation");
});

test("readCacheWithFreshness: counter receives expected labels (hit/miss/stale_revalidating)", async () => {
  await freshHome();
  process.env.EQUIP_CACHE_SOFT_TTL_MS = "1000";

  const events = [];
  const counter = (n, l) => events.push({ n, l });

  cacheStoreMod.readCacheWithFreshness("missing-aug", { counter });
  cacheStoreMod.writeCache(cacheEntry("hit-aug", new Date().toISOString()));
  cacheStoreMod.readCacheWithFreshness("hit-aug", { counter });
  cacheStoreMod.writeCache(cacheEntry("stale-aug", new Date(Date.now() - 60_000).toISOString()));
  cacheStoreMod.readCacheWithFreshness("stale-aug", { counter, revalidate: async () => {} });

  assert.deepEqual(events, [
    { n: "equip_cache_read_total", l: { result: "miss" } },
    { n: "equip_cache_read_total", l: { result: "hit" } },
    { n: "equip_cache_read_total", l: { result: "stale_revalidating" } },
  ]);
});

test("readCacheWithFreshness: EQUIP_CACHE_DISCIPLINE_DISABLED bypasses TTL (treats stale as fresh)", async () => {
  await freshHome();
  process.env.EQUIP_CACHE_DISCIPLINE_DISABLED = "true";
  cacheStoreMod.writeCache(cacheEntry("byp", new Date(Date.now() - 100_000_000).toISOString()));
  let called = false;
  const result = cacheStoreMod.readCacheWithFreshness("byp", {
    revalidate: async () => { called = true; },
  });
  assert.equal(result.freshness, "fresh");
  assert.equal(result.revalidating, false);
  await settle();
  assert.equal(called, false, "discipline-disabled must NOT trigger revalidate");
});

// ─────────────────────────────────────────────────────────────
// ensureCacheFresh — hard TTL gate for install paths
// ─────────────────────────────────────────────────────────────

test("ensureCacheFresh: fresh entry returns 'fresh' without calling refresh", async () => {
  await freshHome();
  cacheStoreMod.writeCache(cacheEntry("ef-fresh", new Date(Date.now() - 1000).toISOString()));
  let called = false;
  const out = await cacheStoreMod.ensureCacheFresh("ef-fresh", async () => { called = true; });
  assert.equal(out.status, "fresh");
  assert.equal(out.cached?.name, "ef-fresh");
  assert.equal(called, false, "fresh entry must NOT trigger refresh");
});

test("ensureCacheFresh: hard-stale entry blocks until refresh completes, then returns refreshed content", async () => {
  await freshHome();
  process.env.EQUIP_CACHE_HARD_TTL_MS = "1000";
  cacheStoreMod.writeCache(cacheEntry("ef-stale", new Date(Date.now() - 60_000).toISOString()));

  const out = await cacheStoreMod.ensureCacheFresh("ef-stale", async (name) => {
    // Simulate registry-refresh writing fresh content under our feet.
    cacheStoreMod.writeCache(cacheEntry(name, new Date().toISOString(), { contentHash: "refreshed-hash" }));
  });

  assert.equal(out.status, "refreshed");
  assert.equal(out.cached?.contentHash, "refreshed-hash");
});

test("ensureCacheFresh: refresh failure surfaces as 'refresh-failed' with the error and best-effort cached content", async () => {
  await freshHome();
  process.env.EQUIP_CACHE_HARD_TTL_MS = "1000";
  cacheStoreMod.writeCache(cacheEntry("ef-fail", new Date(Date.now() - 60_000).toISOString(), { contentHash: "stale-hash" }));

  const out = await cacheStoreMod.ensureCacheFresh("ef-fail", async () => {
    throw new Error("network down");
  });

  assert.equal(out.status, "refresh-failed");
  assert.equal(out.error?.message, "network down");
  assert.equal(out.cached?.contentHash, "stale-hash", "stale content surfaced as best-effort fallback");
});

test("ensureCacheFresh: missing entry + refresh produces nothing → status 'missing'", async () => {
  await freshHome();
  const out = await cacheStoreMod.ensureCacheFresh("ef-missing", async () => {
    // Simulate refresh succeeding but writing nothing (e.g., 404).
  });
  assert.equal(out.status, "missing");
  assert.equal(out.cached, null);
});

test("ensureCacheFresh: counter emits hard_ttl_expired then fetch_failed on refresh exception", async () => {
  await freshHome();
  process.env.EQUIP_CACHE_HARD_TTL_MS = "1000";
  cacheStoreMod.writeCache(cacheEntry("ef-counter", new Date(Date.now() - 60_000).toISOString()));

  const events = [];
  const counter = (n, l) => events.push({ n, l });
  await cacheStoreMod.ensureCacheFresh("ef-counter", async () => { throw new Error("x"); }, { counter });

  assert.deepEqual(events, [
    { n: "equip_cache_install_block_total", l: { reason: "hard_ttl_expired" } },
    { n: "equip_cache_install_block_total", l: { reason: "fetch_failed" } },
  ]);
});

test("ensureCacheFresh: legacy fetchedAt (invalid) treated as hard-stale → refresh fires", async () => {
  await freshHome();
  cacheStoreMod.writeCache(cacheEntry("ef-legacy", "not-a-date"));
  let called = false;
  const out = await cacheStoreMod.ensureCacheFresh("ef-legacy", async (name) => {
    called = true;
    cacheStoreMod.writeCache(cacheEntry(name, new Date().toISOString()));
  });
  assert.equal(called, true);
  assert.equal(out.status, "refreshed");
});

test("ensureCacheFresh: EQUIP_CACHE_DISCIPLINE_DISABLED bypasses gate (returns 'fresh' for any cached entry)", async () => {
  await freshHome();
  process.env.EQUIP_CACHE_DISCIPLINE_DISABLED = "true";
  cacheStoreMod.writeCache(cacheEntry("ef-byp", new Date(Date.now() - 100_000_000).toISOString()));
  let called = false;
  const out = await cacheStoreMod.ensureCacheFresh("ef-byp", async () => { called = true; });
  assert.equal(out.status, "fresh");
  assert.equal(called, false);
});

// ─────────────────────────────────────────────────────────────
// Config: env vars are re-read each call (test-friendly)
// ─────────────────────────────────────────────────────────────

test("getSoftTtlMs / getHardTtlMs: read env each invocation (no startup cache)", async () => {
  await freshHome();
  process.env.EQUIP_CACHE_SOFT_TTL_MS = "111";
  process.env.EQUIP_CACHE_HARD_TTL_MS = "222";
  assert.equal(cacheStoreMod.getSoftTtlMs(), 111);
  assert.equal(cacheStoreMod.getHardTtlMs(), 222);
  process.env.EQUIP_CACHE_SOFT_TTL_MS = "333";
  assert.equal(cacheStoreMod.getSoftTtlMs(), 333);
  delete process.env.EQUIP_CACHE_SOFT_TTL_MS;
  assert.equal(cacheStoreMod.getSoftTtlMs(), 300_000, "default restored when env unset");
});
