import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildReleasePreflightResult,
  buildReleasePreflightSummaryMarkdown,
} from "../scripts/ci/release-preflight-lib.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..");

function runScript(env) {
  return spawnSync(process.execPath, [path.join(workspaceRoot, "scripts/ci/run-release-preflight.mjs")], {
    cwd: workspaceRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("buildReleasePreflightResult marks passing phases as passed", () => {
  const result = buildReleasePreflightResult({
    buildPhase: {
      status: "passed",
      exitCode: 0,
      command: "npm run build",
      summary: "build completed successfully",
    },
    testPhase: {
      status: "passed",
      exitCode: 0,
      command: "npm test",
      summary: "test completed successfully",
    },
    artifacts: {
      resultPath: "/tmp/release-preflight-result.json",
      summaryPath: "/tmp/release-preflight-summary.md",
    },
    artifactNames: {
      bundle: "release-preflight",
    },
    workflowContext: {
      repository: "CharlesMulic/equip",
      workflow: "Release",
      runId: "456",
      sha: "fedcba654321",
      serverUrl: "https://github.com",
    },
  });

  assert.equal(result.kind, "equip-release-preflight-result");
  assert.equal(result.overallStatus, "passed");
  assert.equal(result.phases.build.status, "passed");
  assert.equal(result.phases.test.status, "passed");
  assert.match(result.summary, /build passed; test passed/i);
  assert.equal(result.evidenceFileNames.resultPath, "release-preflight-result.json");
  assert.equal(result.evidenceFileNames.summaryPath, "release-preflight-summary.md");
  assert.equal(result.artifactNames.bundle, "release-preflight");
  assert.equal(result.evidenceArtifactNames.bundle, "release-preflight");
  assert.equal(result.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(result.workflowContext.commitUrl, "https://github.com/CharlesMulic/equip/commit/fedcba654321");
});

test("buildReleasePreflightSummaryMarkdown includes phase details", () => {
  const markdown = buildReleasePreflightSummaryMarkdown({
    result: buildReleasePreflightResult({
      buildPhase: {
        status: "failed",
        exitCode: 2,
        command: "npm run build",
        summary: "build failed with exit code 2",
      },
      testPhase: {
        status: "skipped",
        exitCode: null,
        command: "npm test",
        summary: "test skipped because build preflight failed",
      },
      artifacts: {
        buildLogPath: "/tmp/release-preflight-build.log",
        testLogPath: "/tmp/release-preflight-test.log",
      },
      artifactNames: {
        bundle: "release-preflight",
      },
      workflowContext: {
        repository: "CharlesMulic/equip",
        workflow: "Release",
        runId: "456",
        sha: "fedcba654321",
        serverUrl: "https://github.com",
      },
    }),
  });

  assert.match(markdown, /Overall status: `failed`/i);
  assert.match(markdown, /## Build/i);
  assert.match(markdown, /Exit code: `2`/i);
  assert.match(markdown, /## Test/i);
  assert.match(markdown, /test skipped because build preflight failed/i);
  assert.match(markdown, /buildLogPath:/i);
  assert.match(markdown, /## Evidence file names/i);
  assert.match(markdown, /buildLogPath: `release-preflight-build\.log`/i);
  assert.match(markdown, /## Evidence artifacts/i);
  assert.match(markdown, /## Evidence artifact names/i);
  assert.match(markdown, /bundle: `release-preflight`/i);
  assert.match(markdown, /## GitHub workflow context/i);
  assert.match(markdown, /Commit URL: `https:\/\/github.com\/CharlesMulic\/equip\/commit\/fedcba654321`/i);
});

test("run-release-preflight writes passing artifacts for synthetic success commands", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-preflight-"));
  const buildScriptPath = path.join(root, "build-success.mjs");
  const testScriptPath = path.join(root, "test-success.mjs");
  const resultPath = path.join(root, "release-preflight-result.json");
  const summaryPath = path.join(root, "release-preflight-summary.md");
  const buildLogPath = path.join(root, "release-preflight-build.log");
  const testLogPath = path.join(root, "release-preflight-test.log");

  fs.writeFileSync(buildScriptPath, "console.log('synthetic build ok');\n", "utf8");
  fs.writeFileSync(testScriptPath, "console.log('synthetic test ok');\n", "utf8");

  const result = runScript({
    RELEASE_PREFLIGHT_RESULT_PATH: resultPath,
    RELEASE_PREFLIGHT_SUMMARY_PATH: summaryPath,
    RELEASE_PREFLIGHT_BUILD_LOG_PATH: buildLogPath,
    RELEASE_PREFLIGHT_TEST_LOG_PATH: testLogPath,
    RELEASE_PREFLIGHT_BUILD_EXECUTABLE: process.execPath,
    RELEASE_PREFLIGHT_BUILD_ARGS_JSON: JSON.stringify([buildScriptPath]),
    RELEASE_PREFLIGHT_TEST_EXECUTABLE: process.execPath,
    RELEASE_PREFLIGHT_TEST_ARGS_JSON: JSON.stringify([testScriptPath]),
    RELEASE_PREFLIGHT_ARTIFACT_NAME: "release-preflight",
    GITHUB_REPOSITORY: "CharlesMulic/equip",
    GITHUB_WORKFLOW: "Release",
    GITHUB_RUN_ID: "456",
    GITHUB_SHA: "fedcba654321",
    GITHUB_SERVER_URL: "https://github.com",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const artifact = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const summary = fs.readFileSync(summaryPath, "utf8");
  const buildLog = fs.readFileSync(buildLogPath, "utf8");
  const testLog = fs.readFileSync(testLogPath, "utf8");

  assert.equal(artifact.overallStatus, "passed");
  assert.equal(artifact.phases.build.status, "passed");
  assert.equal(artifact.phases.test.status, "passed");
  assert.equal(artifact.evidenceFileNames.resultPath, "release-preflight-result.json");
  assert.equal(artifact.evidenceFileNames.summaryPath, "release-preflight-summary.md");
  assert.equal(artifact.evidenceFileNames.buildLogPath, "release-preflight-build.log");
  assert.equal(artifact.evidenceFileNames.testLogPath, "release-preflight-test.log");
  assert.equal(artifact.artifactNames.bundle, "release-preflight");
  assert.equal(artifact.evidenceArtifactNames.bundle, "release-preflight");
  assert.equal(artifact.workflowContext.runUrl, "https://github.com/CharlesMulic/equip/actions/runs/456");
  assert.match(summary, /Overall status: `passed`/i);
  assert.match(summary, /## Evidence file names/i);
  assert.match(summary, /resultPath: `release-preflight-result\.json`/i);
  assert.match(summary, /summaryPath: `release-preflight-summary\.md`/i);
  assert.match(summary, /buildLogPath: `release-preflight-build\.log`/i);
  assert.match(summary, /testLogPath: `release-preflight-test\.log`/i);
  assert.match(summary, /## Evidence artifacts/i);
  assert.match(summary, /bundle: `release-preflight`/i);
  assert.match(summary, /## Evidence artifact names/i);
  assert.match(summary, /bundle: `release-preflight`/i);
  assert.match(summary, /## GitHub workflow context/i);
  assert.match(summary, /Run URL: `https:\/\/github.com\/CharlesMulic\/equip\/actions\/runs\/456`/i);
  assert.match(summary, /Commit URL: `https:\/\/github.com\/CharlesMulic\/equip\/commit\/fedcba654321`/i);
  assert.match(buildLog, /synthetic build ok/i);
  assert.match(testLog, /synthetic test ok/i);
});

test("run-release-preflight preserves failure artifacts and skips tests after build failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-preflight-"));
  const buildScriptPath = path.join(root, "build-fail.mjs");
  const testScriptPath = path.join(root, "test-should-not-run.mjs");
  const resultPath = path.join(root, "release-preflight-result.json");
  const summaryPath = path.join(root, "release-preflight-summary.md");
  const buildLogPath = path.join(root, "release-preflight-build.log");
  const testLogPath = path.join(root, "release-preflight-test.log");

  fs.writeFileSync(
    buildScriptPath,
    "console.error('synthetic build failed');\nprocess.exit(2);\n",
    "utf8",
  );
  fs.writeFileSync(
    testScriptPath,
    "console.error('synthetic test should not run');\nprocess.exit(3);\n",
    "utf8",
  );

  const result = runScript({
    RELEASE_PREFLIGHT_RESULT_PATH: resultPath,
    RELEASE_PREFLIGHT_SUMMARY_PATH: summaryPath,
    RELEASE_PREFLIGHT_BUILD_LOG_PATH: buildLogPath,
    RELEASE_PREFLIGHT_TEST_LOG_PATH: testLogPath,
    RELEASE_PREFLIGHT_BUILD_EXECUTABLE: process.execPath,
    RELEASE_PREFLIGHT_BUILD_ARGS_JSON: JSON.stringify([buildScriptPath]),
    RELEASE_PREFLIGHT_TEST_EXECUTABLE: process.execPath,
    RELEASE_PREFLIGHT_TEST_ARGS_JSON: JSON.stringify([testScriptPath]),
  });

  assert.notEqual(result.status, 0);
  const artifact = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const summary = fs.readFileSync(summaryPath, "utf8");
  const buildLog = fs.readFileSync(buildLogPath, "utf8");
  const testLog = fs.readFileSync(testLogPath, "utf8");

  assert.equal(artifact.overallStatus, "failed");
  assert.equal(artifact.phases.build.status, "failed");
  assert.equal(artifact.phases.build.exitCode, 2);
  assert.equal(artifact.phases.test.status, "skipped");
  assert.equal(artifact.evidenceFileNames.resultPath, "release-preflight-result.json");
  assert.equal(artifact.evidenceFileNames.summaryPath, "release-preflight-summary.md");
  assert.equal(artifact.evidenceFileNames.buildLogPath, "release-preflight-build.log");
  assert.equal(artifact.evidenceFileNames.testLogPath, "release-preflight-test.log");
  assert.equal(artifact.artifactNames.bundle, "");
  assert.equal(artifact.evidenceArtifactNames.bundle, "");
  assert.match(summary, /Overall status: `failed`/i);
  assert.match(summary, /## Evidence file names/i);
  assert.match(summary, /resultPath: `release-preflight-result\.json`/i);
  assert.match(summary, /summaryPath: `release-preflight-summary\.md`/i);
  assert.match(summary, /buildLogPath: `release-preflight-build\.log`/i);
  assert.match(summary, /testLogPath: `release-preflight-test\.log`/i);
  assert.match(buildLog, /synthetic build failed/i);
  assert.match(testLog, /test skipped because build preflight failed/i);
});
