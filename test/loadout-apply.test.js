"use strict";

require("./_isolation");

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setupFullHome } = require("./_isolation");

const {
  applyLoadout,
  createLoadout,
  getLoadoutApplyReceipt,
  previewLoadout,
  readLoadoutState,
} = require("../dist/lib/loadouts");
const { JsonStore } = require("../dist/lib/storage/datastore");
const { _resetSeqForTests } = require("../dist/lib/storage/intent-journal");
const { hasInitialSnapshot } = require("../dist/lib/snapshots");

let isolation;

function setup(label = "loadout-apply") {
  isolation = setupFullHome(label);
  _resetSeqForTests();
}

function teardown() {
  isolation.dispose();
}

function content(name, options = {}) {
  return {
    name,
    title: name,
    description: `Fixture for ${name}`,
    transport: "http",
    serverUrl: `https://example.com/${name}/mcp`,
    requiresAuth: false,
    skills: [],
    hooks: [],
    ...options,
  };
}

function putContent(name, options = {}) {
  return JsonStore.putContent(content(name, options));
}

function installIntent(name, options = {}) {
  const {
    platforms = ["codex"],
    version = 1,
    contentHash = putContent(name),
  } = options;
  JsonStore.appendIntent({
    type: "install-augment",
    clock: JsonStore.newClock(),
    name,
    contentHash,
    contentSource: { kind: "registry", version, fetchedAt: "2026-05-10T00:00:00.000Z" },
    platforms,
  });
  return contentHash;
}

function loadoutEntry(name, contentHash, options = {}) {
  return {
    augmentName: name,
    enabled: true,
    required: true,
    sourceKind: "registry",
    contentHash,
    registryVersion: options.registryVersion ?? 1,
    platformTargets: options.platformTargets ?? ["codex"],
    shareBehavior: "public-ref",
    ...(options.installMode ? { installMode: options.installMode } : {}),
  };
}

function codexConfigPath() {
  return path.join(isolation.home, "config.toml");
}

function writeCodexConfig(contentText) {
  fs.mkdirSync(path.dirname(codexConfigPath()), { recursive: true });
  fs.writeFileSync(codexConfigPath(), contentText);
}

describe("loadout apply", () => {
  beforeEach(() => setup());
  afterEach(teardown);

  it("applies mixed uninstall/install, writes a receipt, snapshots first, and marks active clean", () => {
    installIntent("old-tool");
    const newHash = putContent("new-tool");
    const loadout = createLoadout({
      name: "New Set",
      entries: [loadoutEntry("new-tool", newHash)],
    });
    writeCodexConfig([
      "[mcp_servers.old-tool]",
      "url = \"https://example.com/old-tool/mcp\"",
      "",
      "[mcp_servers.manual]",
      "command = \"manual\"",
      "",
    ].join("\n"));

    const plan = previewLoadout(loadout, { enabledPlatformIds: ["codex"] });
    const receipt = applyLoadout({
      operationId: "op_apply_mixed",
      loadout: loadout.id,
      expectedPlanHash: plan.planHash,
    }, {
      enabledPlatformIds: ["codex"],
      now: "2026-05-10T00:00:00.000Z",
    });

    assert.equal(receipt.status, "success");
    assert.equal(receipt.replayed, false);
    assert.deepEqual(receipt.steps.map((step) => `${step.action}:${step.augmentName}:${step.status}`), [
      "uninstall:old-tool:success",
      "install:new-tool:success",
    ]);
    const config = fs.readFileSync(codexConfigPath(), "utf-8");
    assert.ok(!config.includes("old-tool"));
    assert.ok(config.includes("[mcp_servers.new-tool]"));
    assert.ok(config.includes("[mcp_servers.manual]"), "unmanaged/manual entry survives apply");
    assert.equal(JsonStore.resolve("old-tool").installed, false);
    assert.equal(JsonStore.resolve("new-tool").installed, true);
    assert.equal(readLoadoutState().activeLoadoutId, loadout.id);
    assert.equal(hasInitialSnapshot("codex"), true);
    assert.equal(getLoadoutApplyReceipt("op_apply_mixed").status, "success");
  });

  it("applies update entries by replacing managed config and journal state", () => {
    const oldHash = installIntent("alpha");
    const newHash = putContent("alpha", { serverUrl: "https://example.com/alpha-v2/mcp" });
    const loadout = createLoadout({
      name: "Updated Alpha",
      entries: [loadoutEntry("alpha", newHash, { registryVersion: 2 })],
    });
    writeCodexConfig([
      "[mcp_servers.alpha]",
      "url = \"https://example.com/alpha/mcp\"",
      "",
    ].join("\n"));

    const plan = previewLoadout(loadout, { enabledPlatformIds: ["codex"] });
    assert.equal(plan.entries[0].action, "update");

    const receipt = applyLoadout({
      operationId: "op_apply_update",
      loadout: loadout.id,
      expectedPlanHash: plan.planHash,
    }, {
      enabledPlatformIds: ["codex"],
      now: "2026-05-10T00:00:00.000Z",
    });

    assert.equal(receipt.status, "success");
    assert.deepEqual(receipt.steps.map((step) => `${step.action}:${step.augmentName}:${step.status}`), [
      "update:alpha:success",
    ]);
    assert.equal(receipt.summary.updateCount, 1);
    assert.equal(receipt.summary.installCount, 0);
    assert.equal(JsonStore.resolve("alpha").contentHash, newHash);
    assert.notEqual(JsonStore.resolve("alpha").contentHash, oldHash);
    const config = fs.readFileSync(codexConfigPath(), "utf-8");
    assert.match(config, /alpha-v2\/mcp/);
    assert.doesNotMatch(config, /alpha\/mcp"/);
  });

  it("replays a duplicate operation without extra journal or platform writes", () => {
    const alphaHash = putContent("alpha");
    const loadout = createLoadout({
      name: "Alpha",
      entries: [loadoutEntry("alpha", alphaHash)],
    });
    writeCodexConfig("");

    const first = applyLoadout({
      operationId: "op_replay",
      loadout: loadout.id,
    }, {
      enabledPlatformIds: ["codex"],
      now: "2026-05-10T00:00:00.000Z",
    });
    const journalCount = JsonStore.readIntents().length;
    const configAfterFirst = fs.readFileSync(codexConfigPath(), "utf-8");

    const second = applyLoadout({
      operationId: "op_replay",
      loadout: loadout.id,
    }, {
      enabledPlatformIds: ["codex"],
      now: "2026-05-10T00:01:00.000Z",
    });

    assert.equal(first.status, "success");
    assert.equal(second.status, "replayed");
    assert.equal(second.replayed, true);
    assert.equal(JsonStore.readIntents().length, journalCount);
    assert.equal(fs.readFileSync(codexConfigPath(), "utf-8"), configAfterFirst);
  });

  it("blocks stale plan hashes before writes", () => {
    installIntent("current");
    const alphaHash = putContent("alpha");
    const loadout = createLoadout({
      name: "Stale",
      entries: [loadoutEntry("alpha", alphaHash)],
    });
    writeCodexConfig("[mcp_servers.current]\nurl = \"https://example.com/current/mcp\"\n");
    const before = fs.readFileSync(codexConfigPath(), "utf-8");

    const receipt = applyLoadout({
      operationId: "op_stale",
      loadout: loadout.id,
      expectedPlanHash: "not-the-plan",
    }, {
      enabledPlatformIds: ["codex"],
      now: "2026-05-10T00:00:00.000Z",
    });

    assert.equal(receipt.status, "blocked");
    assert.equal(receipt.diagnostics[0].code, "plan_hash_mismatch");
    assert.equal(fs.readFileSync(codexConfigPath(), "utf-8"), before);
    assert.equal(JsonStore.resolve("alpha"), null);
  });

  it("records partial failure receipts and requires recovery on duplicate", () => {
    installIntent("old-tool");
    const alphaHash = putContent("alpha");
    const loadout = createLoadout({
      name: "Partial",
      entries: [loadoutEntry("alpha", alphaHash)],
    });
    let calls = 0;
    const writer = {
      uninstall() {
        calls++;
        return { simulated: "removed" };
      },
      install() {
        calls++;
        throw new Error("simulated install failure");
      },
    };

    const receipt = applyLoadout({
      operationId: "op_partial",
      loadout: loadout.id,
    }, {
      enabledPlatformIds: ["codex"],
      writer,
      now: "2026-05-10T00:00:00.000Z",
    });

    assert.equal(receipt.status, "partial");
    assert.deepEqual(receipt.steps.map((step) => step.status), ["success", "failed"]);
    assert.equal(receipt.summary.failedCount, 1);
    assert.equal(calls, 2);

    const replay = applyLoadout({
      operationId: "op_partial",
      loadout: loadout.id,
    }, {
      enabledPlatformIds: ["codex"],
      writer,
      now: "2026-05-10T00:01:00.000Z",
    });
    assert.equal(replay.status, "recovery_required");
    assert.equal(replay.replayed, true);
    assert.equal(calls, 2, "duplicate partial operation does not retry writes blindly");
  });

  it("writes an in-progress receipt before the first writer side effect", () => {
    installIntent("old-tool");
    const alphaHash = putContent("alpha");
    const loadout = createLoadout({
      name: "Durable",
      entries: [loadoutEntry("alpha", alphaHash)],
    });
    let observedDuringFirstWrite = null;
    const writer = {
      uninstall() {
        observedDuringFirstWrite = getLoadoutApplyReceipt("op_durable");
        return { simulated: "removed" };
      },
      install() {
        return { simulated: "installed" };
      },
    };

    const receipt = applyLoadout({
      operationId: "op_durable",
      loadout: loadout.id,
    }, {
      enabledPlatformIds: ["codex"],
      writer,
      now: "2026-05-10T00:00:00.000Z",
    });

    assert.equal(observedDuringFirstWrite.status, "in_progress");
    assert.deepEqual(observedDuringFirstWrite.steps, []);
    assert.equal(receipt.status, "success");
  });

  it("does not write terminal success before active state is finalized", () => {
    const alphaHash = putContent("alpha");
    const loadout = createLoadout({
      name: "Receipt Failure",
      entries: [loadoutEntry("alpha", alphaHash)],
    });
    const writer = {
      install() {
        return { simulated: "installed" };
      },
      uninstall() {
        return { simulated: "removed" };
      },
    };

    assert.throws(
      () => applyLoadout({
        operationId: "op_receipt_fail",
        loadout: loadout.id,
      }, {
        enabledPlatformIds: ["codex"],
        writer,
        onBeforeMarkActiveForTests() {
          assert.equal(getLoadoutApplyReceipt("op_receipt_fail").status, "in_progress");
          assert.equal(readLoadoutState().activeLoadoutId, null);
          throw new Error("stop before active mark");
        },
        now: "2026-05-10T00:00:00.000Z",
      }),
      /stop before active mark/,
    );
    assert.equal(readLoadoutState().activeLoadoutId, null);
  });

  it("keeps an incomplete receipt recoverable when interrupted after active state finalization", () => {
    const alphaHash = putContent("alpha");
    const loadout = createLoadout({
      name: "Receipt Recovery",
      entries: [loadoutEntry("alpha", alphaHash)],
    });
    const writer = {
      install() {
        return { simulated: "installed" };
      },
      uninstall() {
        return { simulated: "removed" };
      },
    };

    assert.throws(
      () => applyLoadout({
        operationId: "op_after_active",
        loadout: loadout.id,
      }, {
        enabledPlatformIds: ["codex"],
        writer,
        onBeforeTerminalReceiptForTests() {
          throw new Error("stop before terminal receipt");
        },
        now: "2026-05-10T00:00:00.000Z",
      }),
      /stop before terminal receipt/,
    );
    assert.equal(readLoadoutState().activeLoadoutId, loadout.id);
    assert.equal(getLoadoutApplyReceipt("op_after_active").status, "in_progress");

    const replay = applyLoadout({
      operationId: "op_after_active",
      loadout: loadout.id,
    }, {
      enabledPlatformIds: ["codex"],
      writer,
      now: "2026-05-10T00:01:00.000Z",
    });
    assert.equal(replay.status, "recovery_required");
    assert.equal(replay.replayed, true);
  });

  it("returns a receipt-shaped blocked response when another process holds the lock", () => {
    const alphaHash = putContent("alpha");
    const loadout = createLoadout({
      name: "Locked",
      entries: [loadoutEntry("alpha", alphaHash)],
    });
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      fs.writeFileSync(
        path.join(isolation.equipHome, ".lock"),
        JSON.stringify({ pid: child.pid, timestamp: Date.now() }),
      );
      const receipt = applyLoadout({
        operationId: "op_locked",
        loadout: loadout.id,
      }, {
        enabledPlatformIds: ["codex"],
        now: "2026-05-10T00:00:00.000Z",
      });
      assert.equal(receipt.status, "blocked");
      assert.equal(receipt.diagnostics[0].code, "lock_unavailable");
      assert.equal(getLoadoutApplyReceipt("op_locked"), null);
    } finally {
      child.kill();
      try { fs.unlinkSync(path.join(isolation.equipHome, ".lock")); } catch {}
    }
  });

  it("blocks broker and mixed install-mode targets before writes", () => {
    const brokerHash = putContent("broker-tool");
    const loadout = createLoadout({
      name: "Broker",
      entries: [loadoutEntry("broker-tool", brokerHash, { installMode: "broker" })],
    });

    const receipt = applyLoadout({
      operationId: "op_broker_blocked",
      loadout: loadout.id,
    }, {
      enabledPlatformIds: ["codex"],
      now: "2026-05-10T00:00:00.000Z",
    });

    assert.equal(receipt.status, "blocked");
    assert.equal(receipt.diagnostics[0].code, "broker_install_mode_unsupported");
    assert.equal(JsonStore.resolve("broker-tool"), null);
  });
});
