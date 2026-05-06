// Standalone hook coverage for hermetic settings merge behavior.
// Uses built output so it can run after `npm run build` and in `npm test`.

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { setupHermeticHome } = require("./helpers/hermetic-home");

const {
  getHookCapabilities,
  buildHooksConfig,
  installHooks,
  uninstallHooks,
  hasHooks,
} = require("../dist/lib/hooks");
const { Augment } = require("..");

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

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "equip-hooks-test-"));
}

function withHermeticHome() {
  const hermeticHome = setupHermeticHome("equip-hooks-test-");
  const home = hermeticHome.homeDir;

  for (const dir of [
    path.join(home, ".claude"),
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    process.env.CODEX_HOME,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return {
    home,
    restore() {
      hermeticHome.restore();
    },
  };
}

describe("hooks capabilities", () => {
  it("returns capabilities for claude-code", () => {
    const caps = getHookCapabilities("claude-code");
    assert.ok(caps);
    assert.ok(caps.events.includes("PostToolUse"));
    assert.ok(caps.events.includes("PostToolUseFailure"));
    assert.ok(caps.events.includes("Stop"));
    assert.equal(caps.format, "claude-code");
    assert.ok(typeof caps.settingsPath === "function");
  });

  it("returns null for unsupported platforms", () => {
    assert.equal(getHookCapabilities("cursor"), null);
    assert.equal(getHookCapabilities("codex"), null);
    assert.equal(getHookCapabilities("nonexistent"), null);
  });
});

describe("buildHooksConfig", () => {
  it("builds claude-code format config", () => {
    const hookDir = "/tmp/test-hooks";
    const config = buildHooksConfig(SAMPLE_HOOKS, hookDir, "claude-code");

    assert.ok(config);
    assert.ok(config.PostToolUse);
    assert.ok(config.PostToolUseFailure);
    assert.ok(config.Stop);
    assert.equal(config.PostToolUse.length, 1);
    assert.equal(config.PostToolUse[0].hooks[0].type, "command");
    assert.ok(config.PostToolUse[0].hooks[0].command.includes("test-handler.js"));
    assert.equal(config.PostToolUseFailure[0].matcher, "Bash");
    assert.equal(config.Stop[0].matcher, undefined);
  });

  it("returns null for unsupported platform or empty hooks", () => {
    assert.equal(buildHooksConfig(SAMPLE_HOOKS, "/tmp", "cursor"), null);
    assert.equal(buildHooksConfig([], "/tmp", "claude-code"), null);
    assert.equal(buildHooksConfig(null, "/tmp", "claude-code"), null);
  });
});

describe("hooks install lifecycle", () => {
  let env;
  let tmpDir;
  let hookDir;
  let settingsPath;
  const platform = { platform: "claude-code" };

  beforeEach(() => {
    env = withHermeticHome();
    tmpDir = makeTempDir();
    hookDir = path.join(tmpDir, "hooks");
    settingsPath = path.join(env.home, ".claude", "settings.json");
  });

  afterEach(() => {
    try { uninstallHooks(platform, SAMPLE_HOOKS, { hookDir, dryRun: false }); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
    env.restore();
  });

  it("creates hook scripts, writes settings, and reports presence", () => {
    const result = installHooks(platform, SAMPLE_HOOKS, { hookDir });
    assert.equal(result.success, true);
    assert.equal(result.action, "created");
    assert.deepEqual(result.scripts, ["test-handler.js", "test-handler.js", "test-handler.js"]);
    assert.equal(result.hookDir, hookDir);

    const scriptPath = path.join(hookDir, "test-handler.js");
    assert.ok(fs.existsSync(scriptPath));
    assert.ok(fs.readFileSync(scriptPath, "utf-8").includes("test Stop"));
    assert.ok(hasHooks(platform, SAMPLE_HOOKS, { hookDir }));

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(settings.hooks.PostToolUse.length, 1);
    assert.equal(settings.hooks.PostToolUseFailure.length, 1);
    assert.equal(settings.hooks.Stop.length, 1);
  });

  it("returns skipped for unsupported platform and empty hook defs", () => {
    const unsupported = installHooks({ platform: "cursor" }, SAMPLE_HOOKS, { hookDir });
    assert.equal(unsupported.attempted, false);
    assert.equal(unsupported.action, "skipped");

    const empty = installHooks(platform, [], { hookDir });
    assert.equal(empty.attempted, false);
    assert.equal(empty.action, "skipped");
  });

  it("uninstall removes scripts and hook registrations", () => {
    installHooks(platform, SAMPLE_HOOKS, { hookDir });
    const removed = uninstallHooks(platform, SAMPLE_HOOKS, { hookDir });
    assert.equal(removed, true);
    assert.ok(!fs.existsSync(path.join(hookDir, "test-handler.js")));

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(settings.hooks, undefined);
    assert.equal(hasHooks(platform, SAMPLE_HOOKS, { hookDir }), false);
  });
});

describe("settings.json non-destructive behavior", () => {
  let env;
  let tmpDir;
  let hookDir;
  let settingsPath;
  const platform = { platform: "claude-code" };

  beforeEach(() => {
    env = withHermeticHome();
    tmpDir = makeTempDir();
    hookDir = path.join(tmpDir, "hooks");
    settingsPath = path.join(env.home, ".claude", "settings.json");
  });

  afterEach(() => {
    try { uninstallHooks(platform, SAMPLE_HOOKS, { hookDir, dryRun: false }); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
    env.restore();
  });

  it("preserves existing non-hook settings after install", () => {
    const existing = {
      model: "sonnet",
      enabledPlugins: { "some-plugin": true },
      autoUpdatesChannel: "latest",
      skipDangerousModePermissionPrompt: true,
      customField: "preserve-me",
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    installHooks(platform, SAMPLE_HOOKS, { hookDir });

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(after.model, "sonnet");
    assert.deepEqual(after.enabledPlugins, { "some-plugin": true });
    assert.equal(after.autoUpdatesChannel, "latest");
    assert.equal(after.skipDangerousModePermissionPrompt, true);
    assert.equal(after.customField, "preserve-me");
    assert.ok(after.hooks.PostToolUse);
    assert.ok(after.hooks.PostToolUseFailure);
    assert.ok(after.hooks.Stop);
  });

  it("preserves existing hooks from other tools across install and uninstall", () => {
    const otherHookDir = path.join(tmpDir, "other-tool-hooks");
    fs.mkdirSync(otherHookDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PostToolUse: [
          { hooks: [{ type: "command", command: `node "${path.join(otherHookDir, "audit.js")}"` }] },
        ],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: `node "${path.join(otherHookDir, "guard.js")}"` }] },
        ],
      },
    }, null, 2));

    installHooks(platform, SAMPLE_HOOKS, { hookDir });
    let after = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.ok(after.hooks.PostToolUse.length >= 2);
    assert.ok(after.hooks.PostToolUse.some(
      g => g.hooks?.some(h => h.command.includes(otherHookDir.replace(/\\/g, "/"))) ||
        g.hooks?.some(h => h.command.includes(otherHookDir)),
    ));
    assert.equal(after.hooks.PreToolUse.length, 1);

    uninstallHooks(platform, SAMPLE_HOOKS, { hookDir });
    after = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(after.hooks.PostToolUse.length, 1);
    assert.ok(after.hooks.PostToolUse[0].hooks[0].command.includes("audit.js"));
    assert.equal(after.hooks.PreToolUse.length, 1);
  });

  it("install then uninstall restores original state and reinstall is idempotent", () => {
    const initial = {
      model: "sonnet",
      enabledPlugins: {},
      autoUpdatesChannel: "latest",
    };
    fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2));

    installHooks(platform, SAMPLE_HOOKS, { hookDir });
    installHooks(platform, SAMPLE_HOOKS, { hookDir });
    installHooks(platform, SAMPLE_HOOKS, { hookDir });

    let after = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(after.hooks.PostToolUse.length, 1);
    assert.equal(after.hooks.PostToolUseFailure.length, 1);
    assert.equal(after.hooks.Stop.length, 1);

    uninstallHooks(platform, SAMPLE_HOOKS, { hookDir });
    after = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(after.model, "sonnet");
    assert.deepEqual(after.enabledPlugins, {});
    assert.equal(after.autoUpdatesChannel, "latest");
    assert.equal(after.hooks, undefined);
  });

  it("handles missing settings file gracefully", () => {
    const result = installHooks(platform, SAMPLE_HOOKS, { hookDir });
    assert.equal(result.success, true);
    assert.ok(result.warnings.some(w => w.code === "WARN_SETTINGS_CREATED"));
    assert.ok(fs.existsSync(settingsPath));
    assert.ok(JSON.parse(fs.readFileSync(settingsPath, "utf-8")).hooks);

    fs.unlinkSync(settingsPath);
    const removed = uninstallHooks(platform, SAMPLE_HOOKS, { hookDir });
    assert.ok(typeof removed === "boolean");
  });
});

describe("Augment class hooks integration", () => {
  let env;
  let tmpDir;
  let hookDir;
  const platform = { platform: "claude-code" };

  beforeEach(() => {
    env = withHermeticHome();
    tmpDir = makeTempDir();
    hookDir = path.join(tmpDir, "hooks");
  });

  afterEach(() => {
    try { uninstallHooks(platform, SAMPLE_HOOKS, { hookDir, dryRun: false }); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
    env.restore();
  });

  it("supportsHooks reflects config and platform support", () => {
    const withoutHooks = new Augment({ name: "test", serverUrl: "http://test" });
    assert.equal(withoutHooks.supportsHooks(platform), false);

    const withHooks = new Augment({ name: "test", serverUrl: "http://test", hooks: SAMPLE_HOOKS });
    assert.equal(withHooks.supportsHooks(platform), true);
    assert.equal(withHooks.supportsHooks({ platform: "windsurf" }), false);
  });

  it("installHooks uses constructor hookDir and uninstalls cleanly", () => {
    const equip = new Augment({
      name: "test",
      serverUrl: "http://test",
      hooks: SAMPLE_HOOKS,
      hookDir,
    });

    const result = equip.installHooks(platform);
    assert.ok(result.success);
    assert.equal(result.hookDir, hookDir);
    assert.ok(fs.existsSync(path.join(hookDir, "test-handler.js")));
    assert.equal(equip.hasHooks(platform), true);

    assert.equal(equip.uninstallHooks(platform), true);
    assert.equal(equip.hasHooks(platform), false);
  });
});
