// Tests for auth engine: credential storage, auth resolution, key exchange.
// NOTE: OAuth browser flow cannot be tested in automated tests — it requires
// a browser and a live OAuth server. These tests cover everything else.

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  readStoredCredential,
  writeStoredCredential,
  deleteStoredCredential,
  resolveAuth,
} = require("../dist/lib/auth-engine");

// ─── Test Helpers ───────────────────────────────────────────

// Use a unique tool name per test to avoid collisions
let testCounter = 0;
function testToolName() {
  return `auth-test-${Date.now()}-${++testCounter}`;
}

function recordingLogger() {
  const calls = [];
  return {
    calls,
    debug(msg, ctx) { calls.push({ level: "debug", msg, ctx }); },
    info(msg, ctx) { calls.push({ level: "info", msg, ctx }); },
    warn(msg, ctx) { calls.push({ level: "warn", msg, ctx }); },
    error(msg, ctx) { calls.push({ level: "error", msg, ctx }); },
  };
}

// ─── Credential Storage ────────────────────────────────────

describe("credential storage", () => {
  it("writes and reads a credential", () => {
    const name = testToolName();
    writeStoredCredential({
      authType: "api_key",
      credential: "test-key-123",
      toolName: name,
      storedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const stored = readStoredCredential(name);
    assert.ok(stored);
    assert.equal(stored.credential, "test-key-123");
    assert.equal(stored.authType, "api_key");
    assert.equal(stored.toolName, name);

    // Cleanup
    deleteStoredCredential(name);
  });

  it("returns null for nonexistent credential", () => {
    const stored = readStoredCredential("nonexistent-tool-xyz");
    assert.equal(stored, null);
  });

  it("deletes a credential", () => {
    const name = testToolName();
    writeStoredCredential({
      authType: "api_key",
      credential: "to-delete",
      toolName: name,
      storedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.ok(readStoredCredential(name));
    deleteStoredCredential(name);
    assert.equal(readStoredCredential(name), null);
  });

  it("stores oauth tokens alongside credential", () => {
    const name = testToolName();
    writeStoredCredential({
      authType: "oauth_to_api_key",
      credential: "ask_abc123",
      keyPrefix: "ask_",
      oauth: {
        accessToken: "eyJ-access",
        refreshToken: "rt_refresh",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        tokenUrl: "https://example.com/token",
        clientId: "test-client",
      },
      toolName: name,
      storedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const stored = readStoredCredential(name);
    assert.ok(stored.oauth);
    assert.equal(stored.oauth.accessToken, "eyJ-access");
    assert.equal(stored.oauth.refreshToken, "rt_refresh");
    assert.equal(stored.oauth.clientId, "test-client");

    deleteStoredCredential(name);
  });

  it("credentials directory has restrictive permissions on Unix", () => {
    if (process.platform === "win32") return; // Skip on Windows
    const name = testToolName();
    writeStoredCredential({
      authType: "api_key",
      credential: "test",
      toolName: name,
      storedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const credDir = path.join(os.homedir(), ".equip", "credentials");
    const stats = fs.statSync(credDir);
    // 0o700 = owner rwx only
    assert.equal(stats.mode & 0o777, 0o700, "Credentials dir should be 0700");

    deleteStoredCredential(name);
  });
});

// ─── resolveAuth ───────────────────────────────────────────

describe("resolveAuth", () => {
  it("returns null credential for auth type none", async () => {
    const result = await resolveAuth({
      toolName: "test",
      auth: { type: "none" },
    });
    assert.equal(result.credential, null);
    assert.equal(result.method, "none");
  });

  it("uses --api-key flag when provided", async () => {
    const name = testToolName();
    const result = await resolveAuth({
      toolName: name,
      auth: { type: "api_key" },
      apiKey: "explicit-key-456",
    });
    assert.equal(result.credential, "explicit-key-456");
    assert.equal(result.method, "flag");

    // Should also store it
    const stored = readStoredCredential(name);
    assert.ok(stored);
    assert.equal(stored.credential, "explicit-key-456");
    deleteStoredCredential(name);
  });

  it("uses stored credential when available", async () => {
    const name = testToolName();
    writeStoredCredential({
      authType: "api_key",
      credential: "stored-key-789",
      toolName: name,
      storedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await resolveAuth({
      toolName: name,
      auth: { type: "api_key" },
    });
    assert.equal(result.credential, "stored-key-789");
    assert.equal(result.method, "stored");
    deleteStoredCredential(name);
  });

  it("uses environment variable when set", async () => {
    const name = testToolName();
    const envVar = `TEST_AUTH_KEY_${testCounter}`;
    process.env[envVar] = "env-key-abc";

    const result = await resolveAuth({
      toolName: name,
      auth: { type: "api_key", keyEnvVar: envVar },
    });
    assert.equal(result.credential, "env-key-abc");
    assert.equal(result.method, "env");

    delete process.env[envVar];
    deleteStoredCredential(name);
  });

  it("prefers --api-key flag over stored credential", async () => {
    const name = testToolName();
    writeStoredCredential({
      authType: "api_key",
      credential: "stored-old",
      toolName: name,
      storedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await resolveAuth({
      toolName: name,
      auth: { type: "api_key" },
      apiKey: "flag-new",
    });
    assert.equal(result.credential, "flag-new");
    assert.equal(result.method, "flag");
    deleteStoredCredential(name);
  });

  it("returns error in non-interactive mode when no credential found", async () => {
    const result = await resolveAuth({
      toolName: "no-cred-tool",
      auth: { type: "api_key" },
      nonInteractive: true,
    });
    assert.equal(result.credential, null);
    assert.ok(result.error);
    assert.ok(result.error.includes("requires"));
  });

  it("returns error for oauth in non-interactive mode", async () => {
    const result = await resolveAuth({
      toolName: "oauth-tool",
      auth: {
        type: "oauth",
        oauth: {
          authorizeUrl: "https://example.com/auth",
          tokenUrl: "https://example.com/token",
          clientId: "test",
        },
      },
      nonInteractive: true,
    });
    assert.equal(result.credential, null);
    assert.ok(result.error.includes("browser"));
  });

  it("returns error for oauth_to_api_key in non-interactive mode without stored tokens", async () => {
    const result = await resolveAuth({
      toolName: "oauth-key-tool",
      auth: {
        type: "oauth_to_api_key",
        oauth: {
          authorizeUrl: "https://example.com/auth",
          tokenUrl: "https://example.com/token",
          clientId: "test",
        },
        keyExchange: {
          url: "https://example.com/key",
          method: "POST",
          tokenHeader: "Authorization",
          keyPath: "data.apiKey",
        },
      },
      nonInteractive: true,
    });
    assert.equal(result.credential, null);
    assert.ok(result.error.includes("browser"));
  });

  it("logs resolution steps with logger", async () => {
    const name = testToolName();
    const logger = recordingLogger();

    writeStoredCredential({
      authType: "api_key",
      credential: "logged-key",
      toolName: name,
      storedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await resolveAuth({
      toolName: name,
      auth: { type: "api_key" },
      logger,
    });

    const infos = logger.calls.filter(c => c.level === "info");
    assert.ok(infos.some(c => c.msg.includes("stored")), "Should log that stored credential was used");

    deleteStoredCredential(name);
  });

  it("does not store credential in dry-run mode", async () => {
    const name = testToolName();
    await resolveAuth({
      toolName: name,
      auth: { type: "api_key" },
      apiKey: "dry-run-key",
      dryRun: true,
    });

    const stored = readStoredCredential(name);
    assert.equal(stored, null, "Should not store credential in dry-run");
  });
});

// ─── CLI reauth command ────────────────────────────────────

describe("equip reauth", () => {
  it("shows usage when no tool name provided", () => {
    const { execSync } = require("child_process");
    try {
      execSync("node bin/equip.js reauth 2>&1", {
        encoding: "utf-8",
        cwd: path.join(__dirname, ".."),
        timeout: 10000,
        shell: true,
      });
      assert.fail("Should have exited with error");
    } catch (e) {
      assert.ok(e.stdout.includes("Usage") || e.status !== 0);
    }
  });
});
