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

test("verify-pack writes a passing artifact and step summary when a real tarball is produced", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-pack-script-artifacts-"));
  const outputPath = path.join(root, "pack-verification.json");
  const logPath = path.join(root, "pack-verification.log");
  const stepSummaryPath = path.join(root, "step-summary.md");
  const tarballOutputDir = path.join(root, "tarballs");

  const result = runScript("scripts/ci/verify-pack.mjs", {
    PACK_VERIFICATION_OUTPUT_PATH: outputPath,
    PACK_VERIFICATION_LOG_PATH: logPath,
    PACK_TARBALL_OUTPUT_DIR: tarballOutputDir,
    GITHUB_STEP_SUMMARY: stepSummaryPath,
    PACK_VERIFICATION_ARTIFACT_NAME: "pack-verification",
    PACK_TARBALL_ARTIFACT_NAME: "pack-tarball",
    GITHUB_REPOSITORY: "CharlesMulic/equip",
    GITHUB_WORKFLOW: "Release",
    GITHUB_RUN_ID: "234",
    GITHUB_RUN_ATTEMPT: "5",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "123456abcdef",
    GITHUB_EVENT_NAME: "push",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(outputPath));
  assert.ok(fs.existsSync(logPath));

  const artifact = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const stepSummary = fs.readFileSync(stepSummaryPath, "utf8");
  assert.equal(artifact.kind, "equip-pack-verification");
  assert.equal(artifact.status, "passed");
  assert.equal(artifact.hasFailures, false);
  assert.ok(artifact.tarballPath.endsWith(".tgz"));
  assert.ok(fs.existsSync(artifact.tarballPath));
  assert.equal(artifact.artifactNames.bundle, "pack-verification");
  assert.equal(artifact.artifactNames.tarball, "pack-tarball");
  assert.ok(artifact.evidenceFileNames.tarballPath.endsWith(".tgz"));
  assert.equal(artifact.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(artifact.workflowContext.workflow, "Release");
  assert.equal(artifact.workflowContext.runId, "234");
  assert.equal(artifact.workflowContext.serverUrl, "https://github.com");
  assert.equal(artifact.workflowContext.runAttempt, "5");
  assert.equal(artifact.workflowContext.ref, "refs/heads/main");
  assert.equal(artifact.workflowContext.sha, "123456abcdef");
  assert.equal(artifact.workflowContext.eventName, "push");
  assert.equal(
    artifact.workflowContext.runUrl,
    "https://github.com/CharlesMulic/equip/actions/runs/234",
  );
  assert.equal(
    artifact.workflowContext.commitUrl,
    "https://github.com/CharlesMulic/equip/commit/123456abcdef",
  );
  assert.match(stepSummary, /## npm pack verification/i);
  assert.match(stepSummary, /Status: `passed`/i);
  assert.match(stepSummary, /## Evidence artifacts/i);
  assert.match(stepSummary, /bundle: `pack-verification`/i);
  assert.match(stepSummary, /tarball: `pack-tarball`/i);
  assert.match(stepSummary, /## Evidence file names/i);
  assert.match(stepSummary, /reportPath: `pack-verification\.json`/i);
  assert.match(stepSummary, /logPath: `pack-verification\.log`/i);
  assert.match(
    stepSummary,
    new RegExp(String.raw`tarballPath: \`${artifact.evidenceFileNames.tarballPath.replace(/\./g, "\\.")}\``,"i"),
  );
  assert.match(stepSummary, /## GitHub workflow context/i);
  assert.match(stepSummary, /Repository: `CharlesMulic\/equip`/i);
  assert.match(stepSummary, /Workflow: `Release`/i);
  assert.match(stepSummary, /Run ID: `234`/i);
  assert.match(stepSummary, /Run attempt: `5`/i);
  assert.match(stepSummary, /Event: `push`/i);
  assert.match(stepSummary, /Ref: `refs\/heads\/main`/i);
  assert.match(stepSummary, /SHA: `123456abcdef`/i);
  assert.match(stepSummary, /Run URL: `https:\/\/github\.com\/CharlesMulic\/equip\/actions\/runs\/234`/i);
  assert.match(stepSummary, /Commit URL: `https:\/\/github\.com\/CharlesMulic\/equip\/commit\/123456abcdef`/i);
});

test("verify-pack writes a failure artifact when npm pack cannot run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-pack-script-artifacts-"));
  const outputPath = path.join(root, "pack-verification.json");
  const logPath = path.join(root, "pack-verification.log");
  const stepSummaryPath = path.join(root, "step-summary.md");
  const emptyPathDir = path.join(root, "empty-path");
  fs.mkdirSync(emptyPathDir, { recursive: true });

  const result = runScript("scripts/ci/verify-pack.mjs", {
    PACK_VERIFICATION_OUTPUT_PATH: outputPath,
    PACK_VERIFICATION_LOG_PATH: logPath,
    GITHUB_STEP_SUMMARY: stepSummaryPath,
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
  const stepSummary = fs.readFileSync(stepSummaryPath, "utf8");
  assert.equal(artifact.kind, "equip-pack-verification");
  assert.equal(artifact.status, "failed");
  assert.equal(artifact.hasFailures, true);
  assert.ok(Array.isArray(artifact.problems));
  assert.ok(artifact.problems.length > 0);
  assert.equal(typeof artifact.failureMessage, "string");
  assert.ok(artifact.failureMessage.length > 0);
  assert.equal(artifact.artifacts.reportPath, path.resolve(outputPath));
  assert.equal(artifact.artifacts.logPath, path.resolve(logPath));
  assert.equal(artifact.evidenceFileNames.reportPath, "pack-verification.json");
  assert.equal(artifact.evidenceFileNames.logPath, "pack-verification.log");
  assert.equal(artifact.evidenceFileNames.tarballPath, "");
  assert.equal(artifact.artifactNames.bundle, "pack-verification");
  assert.equal(artifact.artifactNames.tarball, "");
  assert.equal(artifact.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(artifact.workflowContext.workflow, "Release");
  assert.equal(artifact.workflowContext.runId, "123");
  assert.equal(artifact.workflowContext.serverUrl, "https://github.com");
  assert.equal(artifact.workflowContext.runAttempt, "2");
  assert.equal(artifact.workflowContext.ref, "refs/heads/main");
  assert.equal(artifact.workflowContext.sha, "abcdef123456");
  assert.equal(artifact.workflowContext.eventName, "push");
  assert.equal(
    artifact.workflowContext.runUrl,
    "https://github.com/CharlesMulic/equip/actions/runs/123",
  );
  assert.equal(
    artifact.workflowContext.commitUrl,
    "https://github.com/CharlesMulic/equip/commit/abcdef123456",
  );
  assert.match(log, /\$ npm pack/i);
  assert.match(stepSummary, /## npm pack verification/i);
  assert.match(stepSummary, /Status: `failed`/i);
  assert.match(stepSummary, /## Evidence artifacts/i);
  assert.match(stepSummary, /bundle: `pack-verification`/i);
  assert.match(stepSummary, /## Evidence file names/i);
  assert.match(stepSummary, /reportPath: `pack-verification\.json`/i);
  assert.match(stepSummary, /logPath: `pack-verification\.log`/i);
  assert.match(stepSummary, /## GitHub workflow context/i);
  assert.match(stepSummary, /Repository: `CharlesMulic\/equip`/i);
  assert.match(stepSummary, /Workflow: `Release`/i);
  assert.match(stepSummary, /Run ID: `123`/i);
  assert.match(stepSummary, /Run attempt: `2`/i);
  assert.match(stepSummary, /Event: `push`/i);
  assert.match(stepSummary, /Ref: `refs\/heads\/main`/i);
  assert.match(stepSummary, /SHA: `abcdef123456`/i);
  assert.match(stepSummary, /Run URL: `https:\/\/github\.com\/CharlesMulic\/equip\/actions\/runs\/123`/i);
  assert.match(stepSummary, /Commit URL: `https:\/\/github\.com\/CharlesMulic\/equip\/commit\/abcdef123456`/i);
});

test("smoke-pack-install writes a failure artifact when the tarball path is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-pack-script-artifacts-"));
  const outputPath = path.join(root, "pack-install-smoke.json");
  const logPath = path.join(root, "pack-install-smoke.log");
  const stepSummaryPath = path.join(root, "step-summary.md");
  const missingTarballPath = path.join(root, "missing.tgz");

  const result = runScript("scripts/ci/smoke-pack-install.mjs", {
    PACK_TARBALL_PATH: missingTarballPath,
    PACK_INSTALL_SMOKE_OUTPUT_PATH: outputPath,
    PACK_INSTALL_SMOKE_LOG_PATH: logPath,
    GITHUB_STEP_SUMMARY: stepSummaryPath,
    PACK_INSTALL_SMOKE_ARTIFACT_NAME: "pack-install-smoke",
    PACK_TARBALL_ARTIFACT_NAME: "pack-tarball",
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
  const stepSummary = fs.readFileSync(stepSummaryPath, "utf8");
  assert.equal(artifact.kind, "equip-pack-install-smoke");
  assert.equal(artifact.status, "failed");
  assert.equal(artifact.tarballPath, "");
  assert.match(artifact.failureMessage, /PACK_TARBALL_PATH does not exist or is not a file/i);
  assert.equal(artifact.artifacts.resultPath, path.resolve(outputPath));
  assert.equal(artifact.artifacts.logPath, path.resolve(logPath));
  assert.equal(artifact.evidenceFileNames.resultPath, "pack-install-smoke.json");
  assert.equal(artifact.evidenceFileNames.logPath, "pack-install-smoke.log");
  assert.equal(artifact.evidenceFileNames.tarballPath, "");
  assert.equal(artifact.artifactNames.bundle, "pack-install-smoke");
  assert.equal(artifact.artifactNames.tarball, "pack-tarball");
  assert.equal(artifact.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(artifact.workflowContext.workflow, "Release");
  assert.equal(artifact.workflowContext.runId, "456");
  assert.equal(artifact.workflowContext.serverUrl, "https://github.com");
  assert.equal(artifact.workflowContext.runAttempt, "3");
  assert.equal(artifact.workflowContext.ref, "refs/heads/main");
  assert.equal(artifact.workflowContext.sha, "fedcba654321");
  assert.equal(artifact.workflowContext.eventName, "push");
  assert.equal(
    artifact.workflowContext.runUrl,
    "https://github.com/CharlesMulic/equip/actions/runs/456",
  );
  assert.equal(
    artifact.workflowContext.commitUrl,
    "https://github.com/CharlesMulic/equip/commit/fedcba654321",
  );
  assert.deepEqual(artifact.steps, []);
  assert.match(log, /PACK_TARBALL_PATH does not exist or is not a file/i);
  assert.match(stepSummary, /## npm tarball install smoke/i);
  assert.match(stepSummary, /Status: `failed`/i);
  assert.match(stepSummary, /## Evidence artifacts/i);
  assert.match(stepSummary, /bundle: `pack-install-smoke`/i);
  assert.match(stepSummary, /tarball: `pack-tarball`/i);
  assert.match(stepSummary, /## Evidence file names/i);
  assert.match(stepSummary, /resultPath: `pack-install-smoke\.json`/i);
  assert.match(stepSummary, /logPath: `pack-install-smoke\.log`/i);
  assert.match(stepSummary, /## GitHub workflow context/i);
  assert.match(stepSummary, /Repository: `CharlesMulic\/equip`/i);
  assert.match(stepSummary, /Workflow: `Release`/i);
  assert.match(stepSummary, /Run ID: `456`/i);
  assert.match(stepSummary, /Run attempt: `3`/i);
  assert.match(stepSummary, /Event: `push`/i);
  assert.match(stepSummary, /Ref: `refs\/heads\/main`/i);
  assert.match(stepSummary, /SHA: `fedcba654321`/i);
  assert.match(stepSummary, /Run URL: `https:\/\/github\.com\/CharlesMulic\/equip\/actions\/runs\/456`/i);
  assert.match(stepSummary, /Commit URL: `https:\/\/github\.com\/CharlesMulic\/equip\/commit\/fedcba654321`/i);
});
