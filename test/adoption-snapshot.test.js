"use strict";

// Tests for broker-production-wiring Pkg 03 — adoption snapshot.
//
// On adoption-modal accept, the bridge calls writeAdoptionSnapshot to
// capture (1) the existing entry being replaced, redacted, and (2) on
// FIRST adoption per platform, a whole-config baseline for downgrade
// rollback. Both files at mode 0o600 in a 0o700 directory.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { writeAdoptionSnapshot, redactSecrets } = require("../dist/lib/adoption-snapshot");

let tempHome;
const origEquipHome = process.env.EQUIP_HOME;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "equip-adoption-test-"));
  process.env.EQUIP_HOME = path.join(tempHome, ".equip");
  fs.mkdirSync(process.env.EQUIP_HOME, { recursive: true });
});

afterEach(() => {
  if (origEquipHome === undefined) delete process.env.EQUIP_HOME; else process.env.EQUIP_HOME = origEquipHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("Pkg-03 — redactSecrets()", () => {
  it("redacts top-level Authorization header value", () => {
    const input = { headers: { Authorization: "Bearer ask_secret_xyz" }, url: "https://api.example.com" };
    const out = redactSecrets(input);
    assert.equal(out.headers.Authorization, "***REDACTED***");
    assert.equal(out.url, "https://api.example.com", "non-secret fields are preserved");
  });

  it("redacts case variants (authorization, AUTHORIZATION)", () => {
    const out = redactSecrets({ headers: { authorization: "Bearer x", AUTHORIZATION: "Bearer y" } });
    assert.equal(out.headers.authorization, "***REDACTED***");
    assert.equal(out.headers.AUTHORIZATION, "***REDACTED***");
  });

  it("redacts api_key, apiKey, bearerToken, accessToken, secret, token at any depth", () => {
    const out = redactSecrets({
      api_key: "x",
      apiKey: "y",
      nested: { bearerToken: "z", deeper: { accessToken: "a", secret: "b", token: "c" } },
    });
    assert.equal(out.api_key, "***REDACTED***");
    assert.equal(out.apiKey, "***REDACTED***");
    assert.equal(out.nested.bearerToken, "***REDACTED***");
    assert.equal(out.nested.deeper.accessToken, "***REDACTED***");
    assert.equal(out.nested.deeper.secret, "***REDACTED***");
    assert.equal(out.nested.deeper.token, "***REDACTED***");
  });

  it("preserves non-secret fields", () => {
    const out = redactSecrets({ command: "node", args: ["server.js"], type: "stdio", url: "https://example.com/mcp" });
    assert.deepEqual(out, { command: "node", args: ["server.js"], type: "stdio", url: "https://example.com/mcp" });
  });

  it("handles arrays + null + primitives without throwing", () => {
    assert.equal(redactSecrets(null), null);
    assert.equal(redactSecrets(undefined), undefined);
    assert.equal(redactSecrets("string"), "string");
    assert.equal(redactSecrets(42), 42);
    assert.deepEqual(redactSecrets(["a", { token: "x" }]), ["a", { token: "***REDACTED***" }]);
  });
});

describe("Pkg-03 — writeAdoptionSnapshot()", () => {
  it("writes per-entry snapshot with bearer redaction", () => {
    const result = writeAdoptionSnapshot({
      augmentName: "prior",
      platform: "claude-code",
      existingEntry: {
        url: "https://api.cg3.io/mcp",
        type: "http",
        headers: { Authorization: "Bearer ask_kwvCjlw_dead_secret" },
      },
    });
    assert.ok(result.perEntryPath, "expected perEntryPath");
    assert.ok(fs.existsSync(result.perEntryPath));

    const parsed = JSON.parse(fs.readFileSync(result.perEntryPath, "utf-8"));
    assert.equal(parsed.augmentName, "prior");
    assert.equal(parsed.platform, "claude-code");
    assert.equal(parsed.existingEntry.url, "https://api.cg3.io/mcp", "url preserved");
    assert.equal(parsed.existingEntry.headers.Authorization, "***REDACTED***",
      "bearer MUST be redacted to defend against snapshot exfil");
  });

  it("writes README.md on first snapshot", () => {
    writeAdoptionSnapshot({ augmentName: "x", platform: "claude-code", existingEntry: {} });
    const dir = path.join(process.env.EQUIP_HOME, "adopted-entries");
    const readmePath = path.join(dir, "README.md");
    assert.ok(fs.existsSync(readmePath));
    const readme = fs.readFileSync(readmePath, "utf-8");
    assert.match(readme, /Adopted entries/);
    assert.match(readme, /redacted/);
  });

  it("file mode is 0o600, dir mode is 0o700 (POSIX); README.md also 0o600", { skip: process.platform === "win32" }, () => {
    const result = writeAdoptionSnapshot({ augmentName: "x", platform: "claude-code", existingEntry: { token: "secret" } });
    const dir = path.join(process.env.EQUIP_HOME, "adopted-entries");
    const dirStat = fs.statSync(dir);
    const fileStat = fs.statSync(result.perEntryPath);
    const readmeStat = fs.statSync(path.join(dir, "README.md"));
    assert.equal(dirStat.mode & 0o777, 0o700, "dir mode must be 0o700");
    assert.equal(fileStat.mode & 0o777, 0o600, "snapshot file mode must be 0o600");
    assert.equal(readmeStat.mode & 0o777, 0o600, "README mode must be 0o600");
  });

  it("baseline snapshot only written on FIRST adoption per platform", () => {
    const wholeConfig = JSON.stringify({
      mcpServers: {
        prior: { url: "https://api.cg3.io/mcp", headers: { Authorization: "Bearer ask_xxx" } },
        notion: { url: "https://notion.com/mcp", headers: { Authorization: "Bearer xyz" } },
      },
    }, null, 2);

    const r1 = writeAdoptionSnapshot({
      augmentName: "prior",
      platform: "claude-code",
      existingEntry: { url: "https://api.cg3.io/mcp" },
      platformConfigBaseline: wholeConfig,
    });
    assert.ok(r1.baselinePath, "first adoption per platform writes baseline");
    assert.ok(fs.existsSync(r1.baselinePath));

    // Verify baseline content has bearers redacted.
    const baselineParsed = JSON.parse(fs.readFileSync(r1.baselinePath, "utf-8"));
    assert.equal(baselineParsed.mcpServers.prior.headers.Authorization, "***REDACTED***");
    assert.equal(baselineParsed.mcpServers.notion.headers.Authorization, "***REDACTED***");

    // Second adoption on same platform should NOT write a new baseline.
    const r2 = writeAdoptionSnapshot({
      augmentName: "notion",
      platform: "claude-code",
      existingEntry: { url: "https://notion.com/mcp" },
      platformConfigBaseline: wholeConfig,
    });
    assert.equal(r2.baselinePath, null, "second adoption per platform must NOT write a baseline");
  });

  it("different platforms get their own baseline files", () => {
    const r1 = writeAdoptionSnapshot({
      augmentName: "prior",
      platform: "claude-code",
      existingEntry: {},
      platformConfigBaseline: '{"mcpServers":{}}',
    });
    const r2 = writeAdoptionSnapshot({
      augmentName: "prior",
      platform: "cursor",
      existingEntry: {},
      platformConfigBaseline: '{"mcpServers":{}}',
    });
    assert.ok(r1.baselinePath);
    assert.ok(r2.baselinePath);
    assert.notEqual(r1.baselinePath, r2.baselinePath);
  });

  it("sanitizes filename components to defend against path traversal", () => {
    const r = writeAdoptionSnapshot({
      augmentName: "../etc/passwd",
      platform: "../../home/attacker",
      existingEntry: {},
    });
    const dir = path.join(process.env.EQUIP_HOME, "adopted-entries");
    // The file must live UNDER the adopted-entries dir.
    assert.ok(r.perEntryPath.startsWith(dir + path.sep) || r.perEntryPath.startsWith(dir),
      `path traversal escaped: ${r.perEntryPath}`);
    // And the filename should not contain ".." or path separators.
    const basename = path.basename(r.perEntryPath);
    assert.equal(basename.includes(".."), false);
  });
});
