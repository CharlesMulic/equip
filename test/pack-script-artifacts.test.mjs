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
  const logPath = path.join(root, "pack-verification.log");
  const emptyPathDir = path.join(root, "empty-path");
  fs.mkdirSync(emptyPathDir, { recursive: true });

  const result = runScript("scripts/ci/verify-pack.mjs", {
    PACK_VERIFICATION_OUTPUT_PATH: outputPath,
    PACK_VERIFICATION_LOG_PATH: logPath,
    PATH: emptyPathDir,
    GITHUB_REPOSITORY: "CharlesMulic/equip",
    GITHUB_WORKFLOW: "Release",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "abcdef123456",
    GITHUB_EVENT_NAME: "push",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
  });

  assert.notEqual(result.status, 0);
  assert.ok(fs.existsSync(outputPath));
  assert.ok(fs.existsSync(logPath));

  const artifact = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const log = fs.readFileSync(logPath, "utf8");
  assert.equal(artifact.kind, "equip-pack-verification");
  assert.equal(artifact.status, "failed");
  assert.equal(artifact.hasFailures, true);
  assert.ok(Array.isArray(artifact.problems));
  assert.ok(artifact.problems.length > 0);
  assert.equal(typeof artifact.failureMessage, "string");
  assert.ok(artifact.failureMessage.length > 0);
  assert.equal(artifact.artifacts.logPath, path.resolve(logPath));
  assert.equal(artifact.artifactNames.bundle, "pack-verification");
  assert.equal(artifact.artifactNames.tarball, "");
  assert.equal(artifact.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(artifact.workflowContext.workflow, "Release");
  assert.equal(
    artifact.workflowContext.runUrl,
    "https://github.com/CharlesMulic/equip/actions/runs/123",
  );
  assert.match(log, /\$ npm pack/i);
});

test("smoke-pack-install writes a failure artifact when the tarball path is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-pack-script-artifacts-"));
  const outputPath = path.join(root, "pack-install-smoke.json");
  const logPath = path.join(root, "pack-install-smoke.log");
  const missingTarballPath = path.join(root, "missing.tgz");

  const result = runScript("scripts/ci/smoke-pack-install.mjs", {
    PACK_TARBALL_PATH: missingTarballPath,
    PACK_INSTALL_SMOKE_OUTPUT_PATH: outputPath,
    PACK_INSTALL_SMOKE_LOG_PATH: logPath,
    GITHUB_REPOSITORY: "CharlesMulic/equip",
    GITHUB_WORKFLOW: "Release",
    GITHUB_RUN_ID: "456",
    GITHUB_RUN_ATTEMPT: "3",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "fedcba654321",
    GITHUB_EVENT_NAME: "push",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
  });

  assert.notEqual(result.status, 0);
  assert.ok(fs.existsSync(outputPath));
  assert.ok(fs.existsSync(logPath));

  const artifact = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const log = fs.readFileSync(logPath, "utf8");
  assert.equal(artifact.kind, "equip-pack-install-smoke");
  assert.equal(artifact.status, "failed");
  assert.equal(artifact.tarballPath, "");
  assert.match(artifact.failureMessage, /PACK_TARBALL_PATH does not exist or is not a file/i);
  assert.equal(artifact.artifacts.logPath, path.resolve(logPath));
  assert.equal(artifact.artifactNames.bundle, "pack-install-smoke");
  assert.equal(artifact.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(artifact.workflowContext.runAttempt, "3");
  assert.equal(
    artifact.workflowContext.commitUrl,
    "https://github.com/CharlesMulic/equip/commit/fedcba654321",
  );
  assert.deepEqual(artifact.steps, []);
  assert.match(log, /PACK_TARBALL_PATH does not exist or is not a file/i);
});
