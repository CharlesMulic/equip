"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");

const { atomicWriteFileSync, safeReadJsonSync } = require("../dist/lib/fs");
const { setupFullHome } = require("./_isolation");

let isolation, tempHome;

function setupTempHome() {
  isolation = setupFullHome("equip-fs");
  tempHome = isolation.home;
}

function teardownTempHome() {
  isolation.dispose();
}

function withReadFailureOnce(target, fn) {
  const originalReadFileSync = fs.readFileSync;
  const resolvedTarget = path.resolve(target);
  let failed = false;

  fs.readFileSync = function patchedReadFileSync(file, ...args) {
    if (path.resolve(String(file)) === resolvedTarget && !failed) {
      failed = true;
      const err = new Error("Access is denied");
      err.code = "EACCES";
      throw err;
    }
    return originalReadFileSync.call(this, file, ...args);
  };

  try {
    return fn();
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
}

function withSpawnMock(fn) {
  const originalSpawnSync = cp.spawnSync;
  const calls = [];

  cp.spawnSync = function patchedSpawnSync(command, args, options) {
    calls.push({ command, args, options });
    return { status: 0 };
  };

  try {
    return fn(calls);
  } finally {
    cp.spawnSync = originalSpawnSync;
  }
}

function withRenameFailureOnce(target, fn) {
  const originalRenameSync = fs.renameSync;
  const resolvedTarget = path.resolve(target);
  let failed = false;

  fs.renameSync = function patchedRenameSync(from, to) {
    if (path.resolve(String(to)) === resolvedTarget && !failed) {
      failed = true;
      const err = new Error("Access is denied");
      err.code = "EPERM";
      throw err;
    }
    return originalRenameSync.call(this, from, to);
  };

  try {
    return fn();
  } finally {
    fs.renameSync = originalRenameSync;
  }
}

describe("safeReadJsonSync", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("repairs unreadable JSON files under ~/.equip on Windows", { skip: process.platform !== "win32" }, () => {
    const dir = path.join(tempHome, ".equip");
    const file = path.join(dir, "installations.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ augments: { prior: true } }));

    withSpawnMock((calls) => {
      const result = withReadFailureOnce(file, () => safeReadJsonSync(file));

      assert.equal(result.status, "ok");
      assert.deepEqual(result.data, { augments: { prior: true } });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, "icacls");
      assert.deepEqual(calls[0].args, [path.resolve(file), "/inheritance:e"]);
    });
  });

  it("does not attempt ACL repair outside ~/.equip", () => {
    const file = path.join(tempHome, "external.json");
    fs.writeFileSync(file, JSON.stringify({ ok: true }));

    withSpawnMock((calls) => {
      const result = withReadFailureOnce(file, () => safeReadJsonSync(file));

      assert.equal(result.status, "unreadable");
      assert.equal(result.data, null);
      assert.equal(calls.length, 0);
    });
  });

  it("repairs an existing bad ~/.equip JSON target before retrying atomic replace on Windows", { skip: process.platform !== "win32" }, () => {
    const dir = path.join(tempHome, ".equip");
    const file = path.join(dir, "installations.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ old: true }));

    withSpawnMock((calls) => {
      withRenameFailureOnce(file, () => {
        atomicWriteFileSync(file, JSON.stringify({ updated: true }));
      });

      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { updated: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, "icacls");
      assert.deepEqual(calls[0].args, [path.resolve(file), "/inheritance:e"]);
    });
  });
});
