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
      runAttempt: "2",
      ref: "refs/heads/main",
      sha: "abcdef123456",
      eventName: "push",
      serverUrl: "https://github.com",
      apiUrl: "https://api.github.com",
    },
  });

  assert.equal(result.kind, "equip-release-bootstrap-result");
  assert.equal(result.overallStatus, "passed");
  assert.equal(result.steps.install.status, "passed");
  assert.match(result.summary, /dependency install passed/i);
  assert.equal(result.evidenceFileNames.resultPath, "release-bootstrap-result.json");
  assert.equal(result.evidenceFileNames.summaryPath, "release-bootstrap-summary.md");
  assert.equal(result.artifactNames.bundle, "release-bootstrap");
  assert.equal(result.evidenceArtifactNames.bundle, "release-bootstrap");
  assert.equal(result.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(result.workflowContext.workflow, "Release");
  assert.equal(result.workflowContext.runId, "123");
  assert.equal(result.workflowContext.serverUrl, "https://github.com");
  assert.equal(result.workflowContext.runAttempt, "2");
  assert.equal(result.workflowContext.ref, "refs/heads/main");
  assert.equal(result.workflowContext.sha, "abcdef123456");
  assert.equal(result.workflowContext.eventName, "push");
  assert.equal(result.workflowContext.runUrl, "https://github.com/CharlesMulic/equip/actions/runs/123");
  assert.equal(
    result.workflowContext.commitUrl,
    "https://github.com/CharlesMulic/equip/commit/abcdef123456",
  );
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
        runAttempt: "2",
        ref: "refs/heads/main",
        sha: "abcdef123456",
        eventName: "push",
        serverUrl: "https://github.com",
        apiUrl: "https://api.github.com",
      },
    }),
  });

  assert.match(markdown, /Overall status: `failed`/i);
  assert.match(markdown, /## Install/i);
  assert.match(markdown, /Exit code: `2`/i);
  assert.match(markdown, /dependency install failed/i);
  assert.match(markdown, /logPath:/i);
  assert.match(markdown, /## Evidence file names/i);
  assert.match(markdown, /logPath: `release-bootstrap\.log`/i);
  assert.match(markdown, /## Evidence artifacts/i);
  assert.match(markdown, /## Evidence artifact names/i);
  assert.match(markdown, /bundle: `release-bootstrap`/i);
  assert.match(markdown, /## GitHub workflow context/i);
  assert.match(markdown, /Repository: `CharlesMulic\/equip`/i);
  assert.match(markdown, /Workflow: `Release`/i);
  assert.match(markdown, /Run ID: `123`/i);
  assert.match(markdown, /Run attempt: `2`/i);
  assert.match(markdown, /Event: `push`/i);
  assert.match(markdown, /Ref: `refs\/heads\/main`/i);
  assert.match(markdown, /SHA: `abcdef123456`/i);
  assert.match(markdown, /API URL: `https:\/\/api\.github\.com`/i);
  assert.match(markdown, /Run URL: `https:\/\/github.com\/CharlesMulic\/equip\/actions\/runs\/123`/i);
  assert.match(markdown, /Commit URL: `https:\/\/github.com\/CharlesMulic\/equip\/commit\/abcdef123456`/i);
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
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "abcdef123456",
    GITHUB_EVENT_NAME: "push",
    GITHUB_SERVER_URL: "https://github.com",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const artifact = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const summary = fs.readFileSync(summaryPath, "utf8");
  const log = fs.readFileSync(logPath, "utf8");

  assert.equal(artifact.overallStatus, "passed");
  assert.equal(artifact.steps.install.status, "passed");
  assert.equal(artifact.evidenceFileNames.resultPath, "release-bootstrap-result.json");
  assert.equal(artifact.evidenceFileNames.summaryPath, "release-bootstrap-summary.md");
  assert.equal(artifact.evidenceFileNames.logPath, "release-bootstrap.log");
  assert.equal(artifact.artifactNames.bundle, "release-bootstrap");
  assert.equal(artifact.evidenceArtifactNames.bundle, "release-bootstrap");
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
  assert.equal(artifact.workflowContext.commitUrl, "https://github.com/CharlesMulic/equip/commit/abcdef123456");
  assert.match(summary, /Overall status: `passed`/i);
  assert.match(summary, /## Evidence file names/i);
  assert.match(summary, /resultPath: `release-bootstrap-result\.json`/i);
  assert.match(summary, /summaryPath: `release-bootstrap-summary\.md`/i);
  assert.match(summary, /logPath: `release-bootstrap\.log`/i);
  assert.match(summary, /## Evidence artifacts/i);
  assert.match(summary, /bundle: `release-bootstrap`/i);
  assert.match(summary, /## Evidence artifact names/i);
  assert.match(summary, /bundle: `release-bootstrap`/i);
  assert.match(summary, /## GitHub workflow context/i);
  assert.match(summary, /Repository: `CharlesMulic\/equip`/i);
  assert.match(summary, /Workflow: `Release`/i);
  assert.match(summary, /Run ID: `123`/i);
  assert.match(summary, /Run attempt: `2`/i);
  assert.match(summary, /Event: `push`/i);
  assert.match(summary, /Ref: `refs\/heads\/main`/i);
  assert.match(summary, /SHA: `abcdef123456`/i);
  assert.match(summary, /Run URL: `https:\/\/github.com\/CharlesMulic\/equip\/actions\/runs\/123`/i);
  assert.match(summary, /Commit URL: `https:\/\/github.com\/CharlesMulic\/equip\/commit\/abcdef123456`/i);
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
  assert.equal(artifact.evidenceFileNames.resultPath, "release-bootstrap-result.json");
  assert.equal(artifact.evidenceFileNames.summaryPath, "release-bootstrap-summary.md");
  assert.equal(artifact.evidenceFileNames.logPath, "release-bootstrap.log");
  assert.equal(artifact.artifactNames.bundle, "");
  assert.equal(artifact.evidenceArtifactNames.bundle, "");
  assert.match(summary, /Overall status: `failed`/i);
  assert.match(summary, /## Evidence file names/i);
  assert.match(summary, /resultPath: `release-bootstrap-result\.json`/i);
  assert.match(summary, /summaryPath: `release-bootstrap-summary\.md`/i);
  assert.match(summary, /logPath: `release-bootstrap\.log`/i);
  assert.match(log, /synthetic install failed/i);
});
