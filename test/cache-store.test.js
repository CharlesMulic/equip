// cache-store unit tests.
// Pkg 01 of equip-storage-refactor.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cache-store-test-"));
process.env.EQUIP_HOME = tmpHome;

const { readCache, writeCache, deleteCache, hasCache, listCache, cachedFromRegistry, getCacheDir } = await import(
  "../dist/lib/cache-store.js"
);

function fixture(name, overrides = {}) {
  return {
    name,
    fetchedAt: "2026-04-28T10:00:00.000Z",
    title: "Cached Title",
    description: "Cached description",
    contentHash: "abc123",
    version: 1,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Round-trip + freshness metadata preservation
// ─────────────────────────────────────────────────────────────

test("write + read round-trip preserves all freshness metadata", () => {
  const cached = fixture("rt-cached", {
    etag: "W/\"abc-123\"",
    contentHash: "def456",
    version: 5,
    registryStatus: "active",
    registryLatestContentHash: "newer-hash",
    registryLatestSecurityAdvisory: true,
    hashAlgorithm: "sha256-v2",
  });
  writeCache(cached);
  const back = readCache("rt-cached");
  assert.deepEqual(back, cached);
});

test("write + read round-trip preserves cached content fields", () => {
  const cached = fixture("rt-content", {
    transport: "http",
    serverUrl: "https://example.com/mcp",
    rules: { content: "do this", version: "1.0.0", marker: "rt-content" },
    auth: { type: "api_key", keyEnvVar: "FOO_API_KEY" },
    publisher: { name: "ACME", slug: "acme", verified: true },
    categories: ["productivity", "dev"],
  });
  writeCache(cached);
  const back = readCache("rt-content");
  assert.deepEqual(back, cached);
});

// ─────────────────────────────────────────────────────────────
// Missing / corrupt
// ─────────────────────────────────────────────────────────────

test("readCache returns null for missing entry", () => {
  assert.equal(readCache("nope"), null);
});

test("readCache returns null for corrupt JSON and writes .corrupt.bak", () => {
  const dir = getCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "broken.json");
  fs.writeFileSync(p, "{ not valid", "utf-8");
  assert.equal(readCache("broken"), null);
  assert.equal(fs.existsSync(p + ".corrupt.bak"), true);
});

// ─────────────────────────────────────────────────────────────
// Delete + has
// ─────────────────────────────────────────────────────────────

test("deleteCache returns true on existing, false on missing", () => {
  writeCache(fixture("del-c"));
  assert.equal(deleteCache("del-c"), true);
  assert.equal(deleteCache("del-c"), false);
  assert.equal(readCache("del-c"), null);
});

test("hasCache matches readCache truthiness", () => {
  assert.equal(hasCache("never"), false);
  writeCache(fixture("has-c"));
  assert.equal(hasCache("has-c"), true);
  deleteCache("has-c");
  assert.equal(hasCache("has-c"), false);
});

// ─────────────────────────────────────────────────────────────
// List
// ─────────────────────────────────────────────────────────────

test("listCache returns all written entries and skips .corrupt.bak", () => {
  writeCache(fixture("list-cache-a"));
  writeCache(fixture("list-cache-b"));
  const dir = getCacheDir();
  fs.writeFileSync(path.join(dir, "list-cache-c.json.corrupt.bak"), "bad", "utf-8");

  const all = listCache();
  const names = all.map((c) => c.name);
  assert.equal(names.includes("list-cache-a"), true);
  assert.equal(names.includes("list-cache-b"), true);
  assert.equal(names.includes("list-cache-c.json.corrupt"), false);
});

// ─────────────────────────────────────────────────────────────
// cachedFromRegistry adapter
// ─────────────────────────────────────────────────────────────

test("cachedFromRegistry maps RegistryDef + freshness into CachedDef", () => {
  const reg = {
    name: "from-registry",
    title: "Registry Title",
    description: "Registry Description",
    installMode: "direct",
    transport: "http",
    serverUrl: "https://reg.example/mcp",
    contentHash: "reg-hash",
    version: 7,
    requiresAuth: true,
    auth: { type: "oauth", authorizationServer: "https://auth.example" },
    rules: { content: "rules", version: "1.0.0", marker: "from-registry" },
    publisher: { name: "Pub", slug: "pub", verified: false },
  };
  const cached = cachedFromRegistry(reg, {
    fetchedAt: "2026-04-28T11:00:00.000Z",
    etag: "etag-1",
    registryStatus: "active",
  });
  assert.equal(cached.name, "from-registry");
  assert.equal(cached.fetchedAt, "2026-04-28T11:00:00.000Z");
  assert.equal(cached.etag, "etag-1");
  assert.equal(cached.registryStatus, "active");
  assert.equal(cached.title, "Registry Title");
  assert.equal(cached.contentHash, "reg-hash");
  assert.equal(cached.version, 7);
  assert.deepEqual(cached.auth, { type: "oauth", authorizationServer: "https://auth.example" });
});

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

test("writeCache rejects invalid names", () => {
  assert.throws(() => {
    writeCache(fixture("../bad-name"));
  });
});

// ─────────────────────────────────────────────────────────────
// Atomicity
// ─────────────────────────────────────────────────────────────

test("writeCache writes atomically — repeated read returns full content", () => {
  for (let i = 0; i < 50; i++) {
    writeCache(fixture(`atom-cache-${i}`, { title: `Atom ${i}`, version: i }));
    const back = readCache(`atom-cache-${i}`);
    assert.equal(back?.title, `Atom ${i}`);
    assert.equal(back?.version, i);
  }
});
