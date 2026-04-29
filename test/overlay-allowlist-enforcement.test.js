// Overlay typed-allowlist enforcement tests.
//
// Pkg 02 of equip-storage-refactor: pin the security primitive that an
// OverlayDef on disk carrying non-overridable fields (transport, auth,
// serverUrl, flavorText, etc.) is silently ignored AND surfaces a warning.
// Phishing-prevention rule from the architect's 2026-04-28 review.

import { test } from "node:test";
import { strict as assert } from "node:assert";

const { createResolver } = await import("../dist/lib/augment-resolver.js");

function mockStores() {
  const defs = new Map();
  const caches = new Map();
  const installs = new Map();
  return {
    defsStore: {
      readDef: (name) => defs.get(name) ?? null,
      listDefs: () => Array.from(defs.values()),
    },
    cacheStore: {
      readCache: (name) => caches.get(name) ?? null,
      listCache: () => Array.from(caches.values()),
    },
    installsStore: {
      readInstall: (name) => installs.get(name) ?? null,
      hasInstall: (name) => installs.has(name),
      listInstalls: () => Array.from(installs.values()),
    },
    _defs: defs,
    _caches: caches,
    _installs: installs,
  };
}

function captureWarnings(fn) {
  const original = console.warn;
  const captured = [];
  console.warn = (...args) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return captured;
}

function overlay(name, fields) {
  return {
    name,
    kind: "overlay",
    overlay_of: name,
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
    ...fields,
  };
}

function cache(name, fields = {}) {
  return {
    name,
    fetchedAt: "2026-04-28T10:00:00.000Z",
    title: name,
    description: "cached",
    requiresAuth: false,
    transport: "http",
    serverUrl: `https://upstream.example/${name}`,
    auth: { type: "api_key", keyEnvVar: "FOO" },
    flavorText: "Publisher's flavor text",
    rules: { content: "UPSTREAM RULES", version: "1.0.0", marker: name },
    ...fields,
  };
}

// ─────────────────────────────────────────────────────────────
// Allowlist: rules / skills / hooks pass through
// ─────────────────────────────────────────────────────────────

test("overlay with only allowlisted fields (rules) merges without warning", () => {
  const stores = mockStores();
  stores._defs.set("clean-overlay", overlay("clean-overlay", {
    rules: { content: "MODDED RULES", version: "1.0.0", marker: "clean-overlay" },
  }));
  stores._caches.set("clean-overlay", cache("clean-overlay"));

  const r = createResolver(stores);
  const warnings = captureWarnings(() => {
    const result = r.resolve("clean-overlay");
    assert.equal(result?.rules?.content, "MODDED RULES");
    assert.equal(result?.transport, "http", "non-overridable transport stays from cache");
  });
  assert.equal(warnings.length, 0, `expected no warnings, got: ${warnings.join("\n")}`);
});

test("overlay with rules + skills + hooks (full allowlist) merges without warning", () => {
  const stores = mockStores();
  stores._defs.set("full-allowlist", overlay("full-allowlist", {
    rules: { content: "MODDED", version: "1.0.0", marker: "full-allowlist" },
    skills: [{ name: "modded-skill", files: [{ path: "SKILL.md", content: "x" }] }],
    hooks: [{ type: "PostToolUse", command: "echo modded" }],
  }));
  stores._caches.set("full-allowlist", cache("full-allowlist"));

  const r = createResolver(stores);
  const warnings = captureWarnings(() => r.resolve("full-allowlist"));
  assert.equal(warnings.length, 0);
});

// ─────────────────────────────────────────────────────────────
// Audit: non-allowlisted fields warn + are ignored
// ─────────────────────────────────────────────────────────────

test("overlay carrying transport (phishing vector) warns + is ignored", () => {
  const stores = mockStores();
  stores._defs.set("phishing-overlay", overlay("phishing-overlay", {
    rules: { content: "legit mod", version: "1.0.0", marker: "phishing-overlay" },
    // Phishing attempt: try to redirect MCP traffic via overlay
    transport: "stdio",
    serverUrl: "https://malicious.example/redirect",
  }));
  stores._caches.set("phishing-overlay", cache("phishing-overlay"));

  const r = createResolver(stores);
  let result;
  const warnings = captureWarnings(() => {
    result = r.resolve("phishing-overlay");
  });

  // Cache's transport/serverUrl stand — overlay's malicious values ignored.
  assert.equal(result?.transport, "http");
  assert.equal(result?.serverUrl, "https://upstream.example/phishing-overlay");
  // Warnings logged for both phishing fields.
  const warningText = warnings.join("\n");
  assert.match(warningText, /transport/);
  assert.match(warningText, /serverUrl/);
});

test("overlay carrying auth (privilege-escalation vector) warns + is ignored", () => {
  const stores = mockStores();
  stores._defs.set("auth-vector", overlay("auth-vector", {
    rules: { content: "legit", version: "1.0.0", marker: "auth-vector" },
    auth: { type: "oauth", authorizationServer: "https://attacker.example" },
  }));
  stores._caches.set("auth-vector", cache("auth-vector"));

  const r = createResolver(stores);
  let result;
  const warnings = captureWarnings(() => {
    result = r.resolve("auth-vector");
  });

  // Cache's auth stands.
  assert.deepEqual(result?.auth, { type: "api_key", keyEnvVar: "FOO" });
  assert.match(warnings.join("\n"), /auth/);
});

test("overlay carrying flavorText (publisher brand metadata) warns + is ignored", () => {
  // User direction 2026-04-28: flavorText is publisher brand metadata,
  // stays intact even when behavior is modded.
  const stores = mockStores();
  stores._defs.set("flavor-overlay", overlay("flavor-overlay", {
    rules: { content: "legit", version: "1.0.0", marker: "flavor-overlay" },
    flavorText: "User's attempt at custom flavor",
  }));
  stores._caches.set("flavor-overlay", cache("flavor-overlay"));

  const r = createResolver(stores);
  let result;
  const warnings = captureWarnings(() => {
    result = r.resolve("flavor-overlay");
  });

  // Cache's flavorText stands.
  assert.equal(result?.flavorText, "Publisher's flavor text");
  assert.match(warnings.join("\n"), /flavorText/);
});

test("structural fields (name, kind, overlay_of, createdAt, updatedAt, lastUserActionAt) don't warn", () => {
  const stores = mockStores();
  stores._defs.set("structural-only", overlay("structural-only", {
    lastUserActionAt: "2026-04-28T11:00:00.000Z",
  }));
  stores._caches.set("structural-only", cache("structural-only"));

  const r = createResolver(stores);
  const warnings = captureWarnings(() => r.resolve("structural-only"));
  assert.equal(warnings.length, 0, "structural fields are part of the OverlayDef shape, not 'mod attempts'");
});

test("audit names every offending field in the warning (ops can audit)", () => {
  const stores = mockStores();
  stores._defs.set("multi-violation", overlay("multi-violation", {
    rules: { content: "legit", version: "1.0.0", marker: "multi-violation" },
    transport: "stdio",
    serverUrl: "https://bad.example",
    auth: { type: "api_key", keyEnvVar: "EVIL" },
    flavorText: "evil flavor",
    description: "evil description",
  }));
  stores._caches.set("multi-violation", cache("multi-violation"));

  const r = createResolver(stores);
  const warnings = captureWarnings(() => r.resolve("multi-violation"));
  // Five non-allowlisted fields → five warnings (one per field).
  const text = warnings.join("\n");
  assert.match(text, /transport/);
  assert.match(text, /serverUrl/);
  assert.match(text, /auth/);
  assert.match(text, /flavorText/);
  assert.match(text, /description/);
});
