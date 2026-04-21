import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = path.resolve(import.meta.dirname, "..");

function runScript(scriptRelativePath, env) {
  return spawnSync(
    process.execPath,
    [path.join(workspaceRoot, scriptRelativePath)],
    {
      cwd: workspaceRoot,
      env: { ...process.env, ...env },
      encoding: "utf8",
    },
  );
}

test("verify-pack writes a failure artifact when npm pack cannot run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-pack-script-artifacts-"));
  const outputPath = path.join(root, "pack-verification.json");
  const emptyPathDir = path.join(root, "empty-path");
  fs.mkdirSync(emptyPathDir, { recursive: true });

  const result = runScript("scripts/ci/verify-pack.mjs", {
    PACK_VERIFICATION_OUTPUT_PATH: outputPath,
    PATH: emptyPathDir,
  });

  assert.notEqual(result.status, 0);
  assert.ok(fs.existsSync(outputPath));

  const artifact = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(artifact.kind, "equip-pack-verification");
  assert.equal(artifact.status, "failed");
  assert.equal(artifact.hasFailures, true);
  assert.ok(Array.isArray(artifact.problems));
  assert.ok(artifact.problems.length > 0);
  assert.equal(typeof artifact.failureMessage, "string");
  assert.ok(artifact.failureMessage.length > 0);
});

test("smoke-pack-install writes a failure artifact when the tarball path is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-pack-script-artifacts-"));
  const outputPath = path.join(root, "pack-install-smoke.json");
  const missingTarballPath = path.join(root, "missing.tgz");

  const result = runScript("scripts/ci/smoke-pack-install.mjs", {
    PACK_TARBALL_PATH: missingTarballPath,
    PACK_INSTALL_SMOKE_OUTPUT_PATH: outputPath,
  });

  assert.notEqual(result.status, 0);
  assert.ok(fs.existsSync(outputPath));

  const artifact = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(artifact.kind, "equip-pack-install-smoke");
  assert.equal(artifact.status, "failed");
  assert.equal(artifact.tarballPath, "");
  assert.match(artifact.failureMessage, /PACK_TARBALL_PATH does not exist or is not a file/i);
});
