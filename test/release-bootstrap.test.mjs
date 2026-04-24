import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildReleaseBootstrapResult,
  buildReleaseBootstrapSummaryMarkdown,
} from "../scripts/ci/release-bootstrap-lib.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..");

function runScript(env) {
  return spawnSync(process.execPath, [path.join(workspaceRoot, "scripts/ci/run-release-bootstrap.mjs")], {
    cwd: workspaceRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("buildReleaseBootstrapResult marks passing install step as passed", () => {
  const result = buildReleaseBootstrapResult({
    installStep: {
      status: "passed",
      exitCode: 0,
      command: "npm ci",
      summary: "dependency install completed successfully",
    },
    artifacts: {
      resultPath: "/tmp/release-bootstrap-result.json",
      summaryPath: "/tmp/release-bootstrap-summary.md",
    },
    artifactNames: {
      bundle: "release-bootstrap",
    },
    workflowContext: {
      repository: "CharlesMulic/equip",
      workflow: "Release",
      runId: "123",
      sha: "abcdef123456",
      serverUrl: "https://github.com",
    },
  });

  assert.equal(result.kind, "equip-release-bootstrap-result");
  assert.equal(result.overallStatus, "passed");
  assert.equal(result.steps.install.status, "passed");
  assert.match(result.summary, /dependency install passed/i);
  assert.equal(result.artifactNames.bundle, "release-bootstrap");
  assert.equal(result.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(result.workflowContext.runUrl, "https://github.com/CharlesMulic/equip/actions/runs/123");
});

test("buildReleaseBootstrapSummaryMarkdown includes install details", () => {
  const markdown = buildReleaseBootstrapSummaryMarkdown({
    result: buildReleaseBootstrapResult({
      installStep: {
        status: "failed",
        exitCode: 2,
        command: "npm ci",
        summary: "dependency install failed with exit code 2",
      },
      artifacts: {
        logPath: "/tmp/release-bootstrap.log",
      },
      artifactNames: {
        bundle: "release-bootstrap",
      },
      workflowContext: {
        repository: "CharlesMulic/equip",
        workflow: "Release",
        runId: "123",
        sha: "abcdef123456",
        serverUrl: "https://github.com",
      },
    }),
  });

  assert.match(markdown, /Overall status: `failed`/i);
  assert.match(markdown, /## Install/i);
  assert.match(markdown, /Exit code: `2`/i);
  assert.match(markdown, /dependency install failed/i);
  assert.match(markdown, /logPath:/i);
  assert.match(markdown, /## Evidence artifacts/i);
  assert.match(markdown, /bundle: `release-bootstrap`/i);
  assert.match(markdown, /## GitHub workflow context/i);
  assert.match(markdown, /Run URL: `https:\/\/github.com\/CharlesMulic\/equip\/actions\/runs\/123`/i);
});

test("run-release-bootstrap writes passing artifacts for synthetic success commands", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-bootstrap-"));
  const installScriptPath = path.join(root, "install-success.mjs");
  const resultPath = path.join(root, "release-bootstrap-result.json");
  const summaryPath = path.join(root, "release-bootstrap-summary.md");
  const logPath = path.join(root, "release-bootstrap.log");

  fs.writeFileSync(installScriptPath, "console.log('synthetic install ok');\n", "utf8");

  const result = runScript({
    RELEASE_BOOTSTRAP_RESULT_PATH: resultPath,
    RELEASE_BOOTSTRAP_SUMMARY_PATH: summaryPath,
    RELEASE_BOOTSTRAP_LOG_PATH: logPath,
    RELEASE_BOOTSTRAP_EXECUTABLE: process.execPath,
    RELEASE_BOOTSTRAP_ARGS_JSON: JSON.stringify([installScriptPath]),
    RELEASE_BOOTSTRAP_ARTIFACT_NAME: "release-bootstrap",
    GITHUB_REPOSITORY: "CharlesMulic/equip",
    GITHUB_WORKFLOW: "Release",
    GITHUB_RUN_ID: "123",
    GITHUB_SHA: "abcdef123456",
    GITHUB_SERVER_URL: "https://github.com",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const artifact = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const summary = fs.readFileSync(summaryPath, "utf8");
  const log = fs.readFileSync(logPath, "utf8");

  assert.equal(artifact.overallStatus, "passed");
  assert.equal(artifact.steps.install.status, "passed");
  assert.equal(artifact.artifactNames.bundle, "release-bootstrap");
  assert.equal(artifact.workflowContext.workflow, "Release");
  assert.equal(artifact.workflowContext.commitUrl, "https://github.com/CharlesMulic/equip/commit/abcdef123456");
  assert.match(summary, /Overall status: `passed`/i);
  assert.match(summary, /bundle: `release-bootstrap`/i);
  assert.match(summary, /## GitHub workflow context/i);
  assert.match(log, /synthetic install ok/i);
});

test("run-release-bootstrap preserves failure artifacts before exiting nonzero", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-bootstrap-"));
  const installScriptPath = path.join(root, "install-fail.mjs");
  const resultPath = path.join(root, "release-bootstrap-result.json");
  const summaryPath = path.join(root, "release-bootstrap-summary.md");
  const logPath = path.join(root, "release-bootstrap.log");

  fs.writeFileSync(
    installScriptPath,
    "console.error('synthetic install failed');\nprocess.exit(2);\n",
    "utf8",
  );

  const result = runScript({
    RELEASE_BOOTSTRAP_RESULT_PATH: resultPath,
    RELEASE_BOOTSTRAP_SUMMARY_PATH: summaryPath,
    RELEASE_BOOTSTRAP_LOG_PATH: logPath,
    RELEASE_BOOTSTRAP_EXECUTABLE: process.execPath,
    RELEASE_BOOTSTRAP_ARGS_JSON: JSON.stringify([installScriptPath]),
  });

  assert.notEqual(result.status, 0);
  const artifact = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const summary = fs.readFileSync(summaryPath, "utf8");
  const log = fs.readFileSync(logPath, "utf8");

  assert.equal(artifact.overallStatus, "failed");
  assert.equal(artifact.steps.install.status, "failed");
  assert.equal(artifact.steps.install.exitCode, 2);
  assert.match(summary, /Overall status: `failed`/i);
  assert.match(log, /synthetic install failed/i);
});
