// Tests for hooks infrastructure — install, uninstall, non-destructive behavior
// Node 18+ built-in test runner, zero dependencies

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const {
  getHookCapabilities,
  buildHooksConfig,
  installHooks,
  uninstallHooks,
  hasHooks,
} = require("../lib/hooks");

// ─── Test Fixtures ───────────────────────────────────────────

const SAMPLE_HOOKS = [
  {
    event: "PostToolUse",
    name: "test-handler",
    script: '#!/usr/bin/env node\nconsole.log("test PostToolUse");',
  },
  {
    event: "PostToolUseFailure",
    matcher: "Bash",
    name: "test-handler",
    script: '#!/usr/bin/env node\nconsole.log("test PostToolUseFailure");',
  },
  {
    event: "Stop",
    name: "test-handler",
    script: '#!/usr/bin/env node\nconsole.log("test Stop");',
  },
];

const OTHER_HOOKS = [
  {
    event: "PostToolUse",
    name: "other-tool-handler",
    script: '#!/usr/bin/env node\nconsole.log("other tool");',
  },
];

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "equip-hooks-test-"));
}

function makePlatform(settingsPath) {
  // Monkey-patch getHookCapabilities for testing with custom settings path
  return { platform: "claude-code", _testSettingsPath: settingsPath };
}

// Override settingsPath for testing — we need to intercept the settings file location
// Since getHookCapabilities returns a hardcoded path, we test through installHooks/etc
// which use the capabilities internally. We'll create a wrapper approach.

// ─── Capabilities Tests ──────────────────────────────────────

describe("getHookCapabilities", () => {
  it("returns capabilities for claude-code", () => {
    const caps = getHookCapabilities("claude-code");
    assert.ok(caps);
    assert.ok(caps.events.includes("PostToolUse"));
    assert.ok(caps.events.includes("PostToolUseFailure"));
    assert.ok(caps.events.includes("Stop"));
    assert.ok(caps.events.includes("PreToolUse"));
    assert.equal(caps.format, "claude-code");
    assert.ok(typeof caps.settingsPath === "function");
  });

  it("returns null for unsupported platforms", () => {
    assert.equal(getHookCapabilities("cursor"), null);
    assert.equal(getHookCapabilities("windsurf"), null);
    assert.equal(getHookCapabilities("vscode"), null);
    assert.equal(getHookCapabilities("nonexistent"), null);
  });
});

// ─── buildHooksConfig Tests ──────────────────────────────────

describe("buildHooksConfig", () => {
  it("builds claude-code format config", () => {
    const hookDir = "/tmp/test-hooks";
    const config = buildHooksConfig(SAMPLE_HOOKS, hookDir, "claude-code");

    assert.ok(config);
    assert.ok(config.PostToolUse);
    assert.ok(config.PostToolUseFailure);
    assert.ok(config.Stop);

    // PostToolUse — no matcher
    assert.equal(config.PostToolUse.length, 1);
    assert.equal(config.PostToolUse[0].hooks[0].type, "command");
    assert.ok(config.PostToolUse[0].hooks[0].command.includes("test-handler.js"));
    assert.equal(config.PostToolUse[0].matcher, undefined);

    // PostToolUseFailure — has Bash matcher
    assert.equal(config.PostToolUseFailure[0].matcher, "Bash");

    // Stop — no matcher
    assert.equal(config.Stop[0].matcher, undefined);
  });

  it("returns null for unsupported platform", () => {
    assert.equal(buildHooksConfig(SAMPLE_HOOKS, "/tmp", "cursor"), null);
  });

  it("returns null for empty hooks", () => {
    assert.equal(buildHooksConfig([], "/tmp", "claude-code"), null);
    assert.equal(buildHooksConfig(null, "/tmp", "claude-code"), null);
  });

  it("skips events not in platform capabilities", () => {
    const hooks = [{ event: "NonexistentEvent", name: "test", script: "// test" }];
    const config = buildHooksConfig(hooks, "/tmp", "claude-code");
    assert.equal(config, null);
  });

  it("uses hookDir in command paths", () => {
    const hookDir = path.join(os.tmpdir(), "my-custom-hooks");
    const config = buildHooksConfig(SAMPLE_HOOKS, hookDir, "claude-code");
    const cmd = config.PostToolUse[0].hooks[0].command;
    assert.ok(cmd.includes(hookDir) || cmd.includes(hookDir.replace(/\\/g, "\\\\")));
  });
});

// ─── Install/Uninstall Integration Tests ─────────────────────
// These tests use real temp directories to verify file operations.

describe("installHooks", () => {
  let tmpDir, hookDir, settingsDir, settingsPath;

  beforeEach(() => {
    tmpDir = makeTempDir();
    hookDir = path.join(tmpDir, "hooks");
    settingsDir = path.join(tmpDir, "claude-settings");
    settingsPath = path.join(settingsDir, "settings.json");
  });

  afterEach(() => {
    // Clean up hooks from settings.json BEFORE deleting the temp dir
    // (uninstallHooks checks for script existence to match entries)
    try {
      const platform = { platform: "claude-code" };
      uninstallHooks(platform, SAMPLE_HOOKS, { hookDir, dryRun: false });
      uninstallHooks(platform, OTHER_HOOKS, { hookDir, dryRun: false });
    } catch { /* best effort */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: patch the settings path for testing
  function installWithTestPaths(hookDefs, opts = {}) {
    // We can't easily override settingsPath in getHookCapabilities,
    // so we'll test the file-writing behavior directly and verify settings
    // by writing a custom settings file and checking it.
    // For a proper test, we need to use the actual function with custom hookDir.
    const platform = { platform: "claude-code" };
    return installHooks(platform, hookDefs, { hookDir, ...opts });
  }

  it("creates hook scripts on disk", () => {
    installWithTestPaths(SAMPLE_HOOKS);

    const handlerPath = path.join(hookDir, "test-handler.js");
    assert.ok(fs.existsSync(handlerPath), "Handler script should exist");

    const content = fs.readFileSync(handlerPath, "utf-8");
    // All three hookDefs share the same name, so last write wins (Stop)
    assert.ok(content.includes("test Stop"), "Script content should match last write");
  });

  it("creates hookDir if it does not exist", () => {
    assert.ok(!fs.existsSync(hookDir), "hookDir should not exist before install");
    installWithTestPaths(SAMPLE_HOOKS);
    assert.ok(fs.existsSync(hookDir), "hookDir should be created");
  });

  it("returns installed status with script names", () => {
    const result = installWithTestPaths(SAMPLE_HOOKS);
    assert.ok(result);
    assert.equal(result.installed, true);
    assert.ok(result.scripts.includes("test-handler.js"));
    assert.equal(result.hookDir, hookDir);
  });

  it("returns null for unsupported platform", () => {
    const result = installHooks({ platform: "cursor" }, SAMPLE_HOOKS, { hookDir });
    assert.equal(result, null);
  });

  it("returns null for empty hookDefs", () => {
    assert.equal(installHooks({ platform: "claude-code" }, [], { hookDir }), null);
    assert.equal(installHooks({ platform: "claude-code" }, null, { hookDir }), null);
  });

  it("dryRun does not write files", () => {
    installWithTestPaths(SAMPLE_HOOKS, { dryRun: true });
    assert.ok(!fs.existsSync(hookDir), "hookDir should not be created in dry run");
  });

  it("overwrites existing scripts on reinstall", () => {
    installWithTestPaths(SAMPLE_HOOKS);
    const handlerPath = path.join(hookDir, "test-handler.js");
    const firstContent = fs.readFileSync(handlerPath, "utf-8");

    // Reinstall with different content
    const updatedHooks = SAMPLE_HOOKS.map(h => ({
      ...h, script: h.script.replace("test", "updated"),
    }));
    installWithTestPaths(updatedHooks);

    const secondContent = fs.readFileSync(handlerPath, "utf-8");
    assert.notEqual(firstContent, secondContent, "Script should be updated");
    assert.ok(secondContent.includes("updated"), "Should contain new content");
  });
});

describe("uninstallHooks", () => {
  let tmpDir, hookDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
    hookDir = path.join(tmpDir, "hooks");
  });

  afterEach(() => {
    // Clean up any hooks from settings.json
    try {
      const platform = { platform: "claude-code" };
      uninstallHooks(platform, SAMPLE_HOOKS, { hookDir, dryRun: false });
      uninstallHooks(platform, OTHER_HOOKS, { hookDir, dryRun: false });
    } catch { /* best effort */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes hook scripts from disk", () => {
    // Install first
    installHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    assert.ok(fs.existsSync(path.join(hookDir, "test-handler.js")));

    // Uninstall
    const removed = uninstallHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    assert.equal(removed, true);
    assert.ok(!fs.existsSync(path.join(hookDir, "test-handler.js")));
  });

  it("returns false when nothing to remove", () => {
    const removed = uninstallHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    assert.equal(removed, false);
  });

  it("returns false for unsupported platform", () => {
    assert.equal(uninstallHooks({ platform: "cursor" }, SAMPLE_HOOKS, { hookDir }), false);
  });

  it("cleans up empty hookDir", () => {
    installHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    uninstallHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    // hookDir should be removed if empty
    assert.ok(!fs.existsSync(hookDir) || fs.readdirSync(hookDir).length === 0);
  });

  it("does not remove hookDir if other files exist", () => {
    installHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    // Add an unrelated file
    fs.writeFileSync(path.join(hookDir, "other-file.txt"), "keep me");

    uninstallHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    assert.ok(fs.existsSync(hookDir), "hookDir should remain (has other files)");
    assert.ok(fs.existsSync(path.join(hookDir, "other-file.txt")), "Other file should survive");
    assert.ok(!fs.existsSync(path.join(hookDir, "test-handler.js")), "Hook script should be removed");
  });
});

describe("hasHooks", () => {
  let tmpDir, hookDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
    hookDir = path.join(tmpDir, "hooks");
  });

  afterEach(() => {
    try {
      const platform = { platform: "claude-code" };
      uninstallHooks(platform, SAMPLE_HOOKS, { hookDir, dryRun: false });
      uninstallHooks(platform, OTHER_HOOKS, { hookDir, dryRun: false });
    } catch { /* best effort */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false when no hooks installed", () => {
    assert.equal(hasHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir }), false);
  });

  it("returns false for unsupported platform", () => {
    assert.equal(hasHooks({ platform: "cursor" }, SAMPLE_HOOKS, { hookDir }), false);
  });

  it("returns false for null/empty hookDefs", () => {
    assert.equal(hasHooks({ platform: "claude-code" }, [], { hookDir }), false);
    assert.equal(hasHooks({ platform: "claude-code" }, null, { hookDir }), false);
  });
});

// ─── Settings File Non-Destructive Tests ─────────────────────
// These test the actual settings.json merge behavior by running
// install/uninstall against the real settingsPath (user's home).
// We simulate this by creating a temp claude settings dir.

describe("settings.json non-destructive behavior", () => {
  let tmpDir, hookDir, realSettingsPath, origSettings;

  beforeEach(() => {
    tmpDir = makeTempDir();
    hookDir = path.join(tmpDir, "hooks");

    // We need to test against the real settings path because hooks.js
    // reads it from getHookCapabilities(). Instead, we'll create a
    // focused test that verifies the merge logic directly.
    realSettingsPath = path.join(os.homedir(), ".claude", "settings.json");

    // Save original settings
    try {
      origSettings = fs.readFileSync(realSettingsPath, "utf-8");
    } catch {
      origSettings = null;
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // Restore original settings
    if (origSettings !== null) {
      fs.writeFileSync(realSettingsPath, origSettings);
    } else {
      try { fs.unlinkSync(realSettingsPath); } catch {}
    }
  });

  it("preserves existing non-hook settings after install", () => {
    // Set up existing settings with model, plugins, etc.
    const existing = {
      model: "sonnet",
      enabledPlugins: { "some-plugin": true },
      autoUpdatesChannel: "latest",
      skipDangerousModePermissionPrompt: true,
      customField: "preserve-me",
    };
    fs.mkdirSync(path.dirname(realSettingsPath), { recursive: true });
    fs.writeFileSync(realSettingsPath, JSON.stringify(existing, null, 2));

    // Install hooks
    installHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });

    // Verify existing settings preserved
    const after = JSON.parse(fs.readFileSync(realSettingsPath, "utf-8"));
    assert.equal(after.model, "sonnet");
    assert.deepEqual(after.enabledPlugins, { "some-plugin": true });
    assert.equal(after.autoUpdatesChannel, "latest");
    assert.equal(after.skipDangerousModePermissionPrompt, true);
    assert.equal(after.customField, "preserve-me");

    // Verify hooks were added
    assert.ok(after.hooks);
    assert.ok(after.hooks.PostToolUse);
    assert.ok(after.hooks.PostToolUseFailure);
    assert.ok(after.hooks.Stop);
  });

  it("preserves existing hooks from other tools after install", () => {
    // Set up existing settings with hooks from another tool
    const otherHookDir = path.join(tmpDir, "other-tool-hooks");
    fs.mkdirSync(otherHookDir, { recursive: true });

    const existing = {
      model: "sonnet",
      hooks: {
        PostToolUse: [{
          hooks: [{ type: "command", command: `node "${path.join(otherHookDir, "audit.js")}"` }],
        }],
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: `node "${path.join(otherHookDir, "guard.js")}"` }],
        }],
      },
    };
    fs.mkdirSync(path.dirname(realSettingsPath), { recursive: true });
    fs.writeFileSync(realSettingsPath, JSON.stringify(existing, null, 2));

    // Install Prior hooks
    installHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });

    // Verify other tool's hooks are preserved
    const after = JSON.parse(fs.readFileSync(realSettingsPath, "utf-8"));

    // PostToolUse should have BOTH other tool's hook AND our hook
    assert.ok(after.hooks.PostToolUse.length >= 2,
      `Should have at least 2 PostToolUse entries, got ${after.hooks.PostToolUse.length}`);

    const otherHook = after.hooks.PostToolUse.find(
      g => g.hooks?.some(h => h.command.includes(otherHookDir.replace(/\\/g, "/")))
        || g.hooks?.some(h => h.command.includes(otherHookDir))
    );
    assert.ok(otherHook, "Other tool's PostToolUse hook should be preserved");

    // PreToolUse should be untouched (we don't register for PreToolUse)
    assert.ok(after.hooks.PreToolUse, "PreToolUse should still exist");
    assert.equal(after.hooks.PreToolUse.length, 1);
  });

  it("preserves existing hooks from other tools after uninstall", () => {
    const otherHookDir = path.join(tmpDir, "other-tool-hooks");
    fs.mkdirSync(otherHookDir, { recursive: true });

    // Install other tool's hooks + Prior hooks
    const existing = {
      hooks: {
        PostToolUse: [
          { hooks: [{ type: "command", command: `node "${path.join(otherHookDir, "audit.js")}"` }] },
        ],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: `node "${path.join(otherHookDir, "guard.js")}"` }] },
        ],
      },
    };
    fs.mkdirSync(path.dirname(realSettingsPath), { recursive: true });
    fs.writeFileSync(realSettingsPath, JSON.stringify(existing, null, 2));

    // Install then uninstall Prior hooks
    installHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    uninstallHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });

    // Other tool's hooks should survive
    const after = JSON.parse(fs.readFileSync(realSettingsPath, "utf-8"));
    assert.ok(after.hooks.PostToolUse, "PostToolUse should still exist");
    assert.equal(after.hooks.PostToolUse.length, 1, "Should have only other tool's hook");
    assert.ok(after.hooks.PostToolUse[0].hooks[0].command.includes("audit.js"));

    assert.ok(after.hooks.PreToolUse, "PreToolUse should still exist");
    assert.equal(after.hooks.PreToolUse.length, 1);
  });

  it("install then uninstall restores original state", () => {
    // Set up initial settings (no hooks)
    const initial = {
      model: "sonnet",
      enabledPlugins: {},
      autoUpdatesChannel: "latest",
      skipDangerousModePermissionPrompt: true,
    };
    fs.mkdirSync(path.dirname(realSettingsPath), { recursive: true });
    fs.writeFileSync(realSettingsPath, JSON.stringify(initial, null, 2));

    // Install
    installHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    const withHooks = JSON.parse(fs.readFileSync(realSettingsPath, "utf-8"));
    assert.ok(withHooks.hooks, "Hooks should be present after install");

    // Uninstall
    uninstallHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    const afterUninstall = JSON.parse(fs.readFileSync(realSettingsPath, "utf-8"));

    // Should match initial state (hooks key removed entirely)
    assert.equal(afterUninstall.model, "sonnet");
    assert.equal(afterUninstall.hooks, undefined, "hooks key should be removed when empty");
    assert.deepEqual(afterUninstall.enabledPlugins, {});
    assert.equal(afterUninstall.autoUpdatesChannel, "latest");
  });

  it("reinstall does not duplicate hooks", () => {
    fs.mkdirSync(path.dirname(realSettingsPath), { recursive: true });
    fs.writeFileSync(realSettingsPath, JSON.stringify({ model: "sonnet" }));

    // Install three times
    installHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    installHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    installHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });

    const after = JSON.parse(fs.readFileSync(realSettingsPath, "utf-8"));

    // Each event should have exactly one entry
    assert.equal(after.hooks.PostToolUse.length, 1, "PostToolUse should not duplicate");
    assert.equal(after.hooks.PostToolUseFailure.length, 1, "PostToolUseFailure should not duplicate");
    assert.equal(after.hooks.Stop.length, 1, "Stop should not duplicate");
  });

  it("handles missing settings file gracefully", () => {
    // Remove settings file if it exists
    try { fs.unlinkSync(realSettingsPath); } catch {}

    // Should not throw
    const result = installHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    assert.ok(result.installed);

    // Settings file should be created
    assert.ok(fs.existsSync(realSettingsPath));
    const settings = JSON.parse(fs.readFileSync(realSettingsPath, "utf-8"));
    assert.ok(settings.hooks);
  });

  it("uninstall with no settings file does not throw", () => {
    try { fs.unlinkSync(realSettingsPath); } catch {}
    const removed = uninstallHooks({ platform: "claude-code" }, SAMPLE_HOOKS, { hookDir });
    // May return true or false depending on whether scripts existed, but should not throw
    assert.ok(typeof removed === "boolean");
  });
});

// ─── Augment Class Integration Tests ───────────────────────────

describe("Augment class hooks integration", () => {
  const { Augment } = require("../index");
  let tmpDir, hookDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
    hookDir = path.join(tmpDir, "hooks");
  });

  afterEach(() => {
    try {
      const platform = { platform: "claude-code" };
      uninstallHooks(platform, SAMPLE_HOOKS, { hookDir, dryRun: false });
    } catch { /* best effort */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("supportsHooks returns false without hook config", () => {
    const equip = new Augment({ name: "test", serverUrl: "http://test" });
    assert.equal(equip.supportsHooks({ platform: "claude-code" }), false);
  });

  it("supportsHooks returns true with hook config on supported platform", () => {
    const equip = new Augment({
      name: "test", serverUrl: "http://test",
      hooks: SAMPLE_HOOKS,
    });
    assert.equal(equip.supportsHooks({ platform: "claude-code" }), true);
  });

  it("supportsHooks returns false with hook config on unsupported platform", () => {
    const equip = new Augment({
      name: "test", serverUrl: "http://test",
      hooks: SAMPLE_HOOKS,
    });
    assert.equal(equip.supportsHooks({ platform: "windsurf" }), false);
  });

  it("installHooks returns null without hook config", () => {
    const equip = new Augment({ name: "test", serverUrl: "http://test" });
    assert.equal(equip.installHooks({ platform: "claude-code" }, { hookDir }), null);
  });

  it("uses hookDir from constructor config", () => {
    const equip = new Augment({
      name: "test", serverUrl: "http://test",
      hooks: SAMPLE_HOOKS,
      hookDir: hookDir,
    });
    const result = equip.installHooks({ platform: "claude-code" });
    assert.ok(result);
    assert.equal(result.hookDir, hookDir);
    assert.ok(fs.existsSync(path.join(hookDir, "test-handler.js")));
  });
});
