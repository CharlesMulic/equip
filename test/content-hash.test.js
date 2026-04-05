// Content hash tests — shared test vectors that must produce identical results
// in both TypeScript (this file) and Kotlin (ContentHashServiceTest).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeContentHash, extractManifest } = require("../dist/lib/content-hash");

// ─── Shared test vectors ────────────────────────────────────
// These MUST match the Kotlin ContentHashServiceTest exactly.
// If you change a vector here, change it there too.

const VECTORS = [
  {
    name: "all null fields",
    manifest: {
      rulesContent: null, rulesMarker: null, skills: null, hooks: null,
      serverUrl: null, stdioCommand: null, stdioArgs: null, transport: null,
    },
  },
  {
    name: "rules only",
    manifest: {
      rulesContent: "Always write tests.", rulesMarker: "my-tool",
      skills: null, hooks: null,
      serverUrl: null, stdioCommand: null, stdioArgs: null, transport: null,
    },
  },
  {
    name: "http MCP only",
    manifest: {
      rulesContent: null, rulesMarker: null, skills: null, hooks: null,
      serverUrl: "https://api.example.com/mcp", stdioCommand: null,
      stdioArgs: null, transport: "http",
    },
  },
  {
    name: "stdio MCP only",
    manifest: {
      rulesContent: null, rulesMarker: null, skills: null, hooks: null,
      serverUrl: null, stdioCommand: "npx",
      stdioArgs: JSON.stringify(["-y", "@scope/package"]), transport: "stdio",
    },
  },
  {
    name: "rules + skills",
    manifest: {
      rulesContent: "Be helpful.", rulesMarker: "helper",
      skills: JSON.stringify([
        { name: "search", files: [{ path: "SKILL.md", content: "# Search" }] },
      ]),
      hooks: null,
      serverUrl: null, stdioCommand: null, stdioArgs: null, transport: null,
    },
  },
  {
    name: "full augment",
    manifest: {
      rulesContent: "<!-- prior:v1.0.0 -->\n## Rules\nDo things.\n<!-- /prior -->",
      rulesMarker: "prior",
      skills: JSON.stringify([
        { name: "contribute", files: [{ path: "SKILL.md", content: "# Contribute" }] },
        { name: "search", files: [{ path: "SKILL.md", content: "# Search" }] },
      ]),
      hooks: JSON.stringify([{ event: "PostToolUse", name: "handler" }]),
      serverUrl: "https://api.cg3.io/mcp",
      stdioCommand: null, stdioArgs: null, transport: "http",
    },
  },
  {
    name: "skills sort order matters",
    manifest: {
      rulesContent: null, rulesMarker: null,
      skills: JSON.stringify([
        { name: "zebra", files: [{ path: "SKILL.md", content: "Z" }] },
        { name: "alpha", files: [{ path: "SKILL.md", content: "A" }] },
      ]),
      hooks: null,
      serverUrl: null, stdioCommand: null, stdioArgs: null, transport: null,
    },
  },
  {
    name: "unicode in rules",
    manifest: {
      rulesContent: "Use emojis \u2764\uFE0F and special chars: \u00E9\u00E8\u00EA",
      rulesMarker: "unicode-test",
      skills: null, hooks: null,
      serverUrl: null, stdioCommand: null, stdioArgs: null, transport: null,
    },
  },
];

// ─── Tests ──────────────────────────────────────────────────

describe("computeContentHash", () => {
  it("produces 64-char hex string", () => {
    const hash = computeContentHash(VECTORS[0].manifest);
    assert.equal(hash.length, 64);
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  it("is deterministic (same input = same hash)", () => {
    const h1 = computeContentHash(VECTORS[1].manifest);
    const h2 = computeContentHash(VECTORS[1].manifest);
    assert.equal(h1, h2);
  });

  it("different inputs produce different hashes", () => {
    const hashes = VECTORS.map(v => computeContentHash(v.manifest));
    const unique = new Set(hashes);
    assert.equal(unique.size, hashes.length, "all vectors should produce unique hashes");
  });

  it("skills are sorted by name before hashing", () => {
    // Same skills in different order should produce the same hash
    const sorted = {
      ...VECTORS[6].manifest,
      skills: JSON.stringify([
        { name: "alpha", files: [{ path: "SKILL.md", content: "A" }] },
        { name: "zebra", files: [{ path: "SKILL.md", content: "Z" }] },
      ]),
    };
    const h1 = computeContentHash(VECTORS[6].manifest);
    const h2 = computeContentHash(sorted);
    assert.equal(h1, h2, "sort order should not affect hash");
  });

  it("null vs empty string produce different hashes", () => {
    const withNull = computeContentHash({
      rulesContent: null, rulesMarker: null, skills: null, hooks: null,
      serverUrl: null, stdioCommand: null, stdioArgs: null, transport: null,
    });
    const withEmpty = computeContentHash({
      rulesContent: "", rulesMarker: null, skills: null, hooks: null,
      serverUrl: null, stdioCommand: null, stdioArgs: null, transport: null,
    });
    assert.notEqual(withNull, withEmpty);
  });
});

describe("extractManifest", () => {
  it("extracts from a RegistryDef-like object", () => {
    const def = {
      rules: { content: "Be helpful.", marker: "test" },
      skills: [{ name: "search", files: [{ path: "SKILL.md", content: "# Search" }] }],
      hooks: null,
      serverUrl: "https://example.com/mcp",
      transport: "http",
    };
    const manifest = extractManifest(def);
    assert.equal(manifest.rulesContent, "Be helpful.");
    assert.equal(manifest.rulesMarker, "test");
    assert.ok(manifest.skills?.includes("search"));
    assert.equal(manifest.hooks, null);
    assert.equal(manifest.serverUrl, "https://example.com/mcp");
    assert.equal(manifest.transport, "http");
  });

  it("handles missing optional fields", () => {
    const manifest = extractManifest({});
    assert.equal(manifest.rulesContent, null);
    assert.equal(manifest.skills, null);
    assert.equal(manifest.serverUrl, null);
    assert.equal(manifest.transport, null);
  });
});

// Export vectors for cross-language testing
// The Kotlin tests should use these same inputs and verify identical hashes.
describe("shared test vectors", () => {
  for (const vector of VECTORS) {
    it(`vector: ${vector.name}`, () => {
      const hash = computeContentHash(vector.manifest);
      // Log for cross-language verification during development
      // console.log(`  ${vector.name}: ${hash}`);
      assert.ok(hash, `hash should not be empty for: ${vector.name}`);
      assert.equal(hash.length, 64);
    });
  }
});
