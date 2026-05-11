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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createWorkflowEnv() {
  return {
    GITHUB_REPOSITORY: "CharlesMulic/equip",
    GITHUB_WORKFLOW: "Release",
    GITHUB_RUN_ID: "1234567890",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "abcdef1234567890",
    GITHUB_EVENT_NAME: "push",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
  };
}

test("write-release-verification-summary writes a markdown artifact with the final assertion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-summary-writer-"));
  const reportPath = path.join(root, "release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");
  const summaryPath = path.join(root, "release-verification-summary.md");
  const stepSummaryPath = path.join(root, "step-summary.md");

  writeJson(reportPath, {
    overallStatus: "failed",
    package: {
      status: "passed",
      tarballFileName: "cg3-equip-0.17.7.tgz",
      artifacts: {
        logPath: ".generated/release/pack-verification.log",
      },
    },
    tarballSmoke: {
      status: "failed",
      failureMessage: "Installed equip --help output did not include the expected usage header.",
      artifacts: {
        logPath: ".generated/release/pack-install-smoke.log",
      },
    },
    dockerAcceptance: {
      status: "passed",
      totalDurationMs: 6789,
      artifacts: {
        reportPath: ".generated/docker-acceptance/docker-acceptance-report.json",
      },
    },
    artifactNames: {
      packVerification: "pack-verification",
      packTarball: "pack-tarball",
      packInstallSmoke: "pack-install-smoke",
      dockerAcceptance: "docker-acceptance",
      report: "release-verification-report",
      assertion: "release-verification-assertion",
      summary: "release-verification-summary",
    },
    evidenceFileNames: {
      packageLogPath: "pack-verification.log",
      tarballSmokeLogPath: "pack-install-smoke.log",
      releaseVerificationReportPath: "release-verification-report.json",
      releaseVerificationAssertionPath: "release-verification-assertion.json",
      releaseVerificationSummaryPath: "release-verification-summary.md",
    },
    workflowContext: {
      repository: "CharlesMulic/equip",
      workflow: "Release",
      runId: "1234567890",
      serverUrl: "https://github.com",
      sha: "abcdef1234567890",
      runUrl: "https://github.com/CharlesMulic/equip/actions/runs/1234567890",
      commitUrl: "https://github.com/CharlesMulic/equip/commit/abcdef1234567890",
    },
  });

  writeJson(assertionPath, {
    outcome: "failed",
    overallStatus: "failed",
    components: {
      package: "passed",
      tarballSmoke: "failed",
      dockerAcceptance: "passed",
    },
    reportPath: ".generated/release/release-verification-report.json",
    assertionPath: ".generated/release/release-verification-assertion.json",
    failureDetails: [
      "tarball smoke failure: Installed equip --help output did not include the expected usage header.",
    ],
    error: "release verification failed",
  });

  const result = runScript("scripts/ci/write-release-verification-summary.mjs", {
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_ASSERTION_PATH: assertionPath,
    RELEASE_VERIFICATION_SUMMARY_PATH: summaryPath,
    GITHUB_STEP_SUMMARY: stepSummaryPath,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = fs.readFileSync(summaryPath, "utf8");
  const stepSummary = fs.readFileSync(stepSummaryPath, "utf8");
  assert.match(result.stdout, /wrote summary/i);
  assert.match(summary, /## Release verification rollup/i);
  assert.match(summary, /## GitHub workflow context/i);
  assert.match(summary, /Repository: `CharlesMulic\/equip`/i);
  assert.match(summary, /Workflow: `Release`/i);
  assert.match(summary, /Run ID: `1234567890`/i);
  assert.match(summary, /Run URL: `https:\/\/github\.com\/CharlesMulic\/equip\/actions\/runs\/1234567890`/i);
  assert.match(summary, /Commit URL: `https:\/\/github\.com\/CharlesMulic\/equip\/commit\/abcdef1234567890`/i);
  assert.match(summary, /## Evidence artifacts/i);
  assert.match(summary, /## Evidence file names/i);
  assert.match(summary, /Release Verification Report Path: `release-verification-report\.json`/i);
  assert.match(summary, /Pack Tarball: `pack-tarball`/i);
  assert.match(summary, /## Final assertion/i);
  assert.match(summary, /Tarball smoke failure: Installed equip --help output did not include the expected usage header\./i);
  assert.match(summary, /Error: release verification failed/i);
  assert.match(stepSummary, /## Release verification rollup/i);
  assert.match(stepSummary, /## GitHub workflow context/i);
  assert.match(stepSummary, /Repository: `CharlesMulic\/equip`/i);
  assert.match(stepSummary, /Workflow: `Release`/i);
  assert.match(stepSummary, /Run ID: `1234567890`/i);
  assert.match(stepSummary, /Run URL: `https:\/\/github\.com\/CharlesMulic\/equip\/actions\/runs\/1234567890`/i);
  assert.match(stepSummary, /Commit URL: `https:\/\/github\.com\/CharlesMulic\/equip\/commit\/abcdef1234567890`/i);
  assert.match(stepSummary, /Summary: `release-verification-summary`/i);
  assert.match(stepSummary, /## Final assertion/i);
});

test("write-release-verification-report can rewrite a final report without duplicating the GitHub step summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-report-writer-"));
  const reportPath = path.join(root, "release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");
  const summaryPath = path.join(root, "release-verification-summary.md");
  const stepSummaryPath = path.join(root, "step-summary.md");
  const releaseBootstrapResultPath = path.join(root, "release-bootstrap-result.json");
  const releasePreflightResultPath = path.join(root, "release-preflight-result.json");

  writeJson(path.join(root, "pack-verification.json"), {
    status: "passed",
    hasFailures: false,
    problems: [],
  });
  writeJson(path.join(root, "pack-install-smoke.json"), {
    status: "passed",
    helpIncludesUsage: true,
    exportsCheck: "exports-ok",
  });
  writeJson(path.join(root, "docker-acceptance-report.json"), {
    status: "passed",
    steps: [],
  });
  writeJson(releaseBootstrapResultPath, {
    kind: "equip-release-bootstrap-result",
    overallStatus: "passed",
    summary: "dependency install passed",
    evidenceFileNames: {
      resultPath: "release-bootstrap-result.json",
      summaryPath: "release-bootstrap-summary.md",
    },
    artifactNames: {
      bundle: "release-bootstrap",
    },
    evidenceArtifactNames: {
      bundle: "release-bootstrap",
    },
  });
  writeJson(releasePreflightResultPath, {
    kind: "equip-release-preflight-result",
    overallStatus: "passed",
    summary: "build and tests passed",
    evidenceFileNames: {
      resultPath: "release-preflight-result.json",
      summaryPath: "release-preflight-summary.md",
    },
    artifactNames: {
      bundle: "release-preflight",
    },
    evidenceArtifactNames: {
      bundle: "release-preflight",
    },
  });
  writeJson(assertionPath, {
    outcome: "passed",
    overallStatus: "passed",
    components: {
      package: "passed",
      tarballSmoke: "passed",
      dockerAcceptance: "passed",
    },
    reportPath,
    assertionPath,
    failureDetails: [],
  });
  fs.writeFileSync(summaryPath, "## Existing release verification summary\n", "utf8");
  fs.writeFileSync(stepSummaryPath, "## Existing step summary\n", "utf8");

  const result = runScript("scripts/ci/write-release-verification-report.mjs", {
    RELEASE_BOOTSTRAP_RESULT_PATH: releaseBootstrapResultPath,
    RELEASE_PREFLIGHT_RESULT_PATH: releasePreflightResultPath,
    PACK_VERIFICATION_PATH: path.join(root, "pack-verification.json"),
    PACK_INSTALL_SMOKE_PATH: path.join(root, "pack-install-smoke.json"),
    DOCKER_ACCEPTANCE_REPORT_PATH: path.join(root, "docker-acceptance-report.json"),
    RELEASE_BOOTSTRAP_RESULT_ARTIFACT_NAME: "release-bootstrap",
    RELEASE_PREFLIGHT_RESULT_ARTIFACT_NAME: "release-preflight",
    PACK_VERIFICATION_ARTIFACT_NAME: "pack-verification",
    PACK_TARBALL_ARTIFACT_NAME: "pack-tarball",
    PACK_INSTALL_SMOKE_ARTIFACT_NAME: "pack-install-smoke",
    DOCKER_ACCEPTANCE_ARTIFACT_NAME: "docker-acceptance",
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_ASSERTION_PATH: assertionPath,
    RELEASE_VERIFICATION_SUMMARY_PATH: summaryPath,
    RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME: "release-verification-report",
    RELEASE_VERIFICATION_ASSERTION_ARTIFACT_NAME: "release-verification-assertion",
    RELEASE_VERIFICATION_SUMMARY_ARTIFACT_NAME: "release-verification-summary",
    RELEASE_VERIFICATION_APPEND_STEP_SUMMARY: "false",
    GITHUB_STEP_SUMMARY: stepSummaryPath,
    ...createWorkflowEnv(),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const stepSummary = fs.readFileSync(stepSummaryPath, "utf8");
  assert.equal(report.artifacts.summaryPath, path.resolve(summaryPath));
  assert.equal(report.artifacts.assertionPath, path.resolve(assertionPath));
  assert.equal(report.artifactNames.packVerification, "pack-verification");
  assert.equal(report.artifactNames.packTarball, "pack-tarball");
  assert.equal(report.artifactNames.packInstallSmoke, "pack-install-smoke");
  assert.equal(report.artifactNames.dockerAcceptance, "docker-acceptance");
  assert.equal(report.artifactNames.report, "release-verification-report");
  assert.equal(report.artifactNames.assertion, "release-verification-assertion");
  assert.equal(report.artifactNames.summary, "release-verification-summary");
  assert.equal(report.evidenceArtifactNames.releaseBootstrapBundle, "release-bootstrap");
  assert.equal(report.evidenceArtifactNames.releasePreflightBundle, "release-preflight");
  assert.equal(report.evidenceArtifactNames.releaseVerificationPackVerification, "pack-verification");
  assert.equal(report.evidenceArtifactNames.releaseVerificationSummary, "release-verification-summary");
  assert.equal(report.evidenceFileNames.releaseBootstrapResultPath, "release-bootstrap-result.json");
  assert.equal(report.evidenceFileNames.releaseBootstrapSummaryPath, "release-bootstrap-summary.md");
  assert.equal(report.evidenceFileNames.releasePreflightResultPath, "release-preflight-result.json");
  assert.equal(report.evidenceFileNames.releasePreflightSummaryPath, "release-preflight-summary.md");
  assert.equal(report.evidenceFileNames.packageReportPath, "pack-verification.json");
  assert.equal(report.evidenceFileNames.tarballSmokeResultPath, "pack-install-smoke.json");
  assert.equal(report.evidenceFileNames.releaseVerificationReportPath, "release-verification-report.json");
  assert.equal(report.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(
    report.workflowContext.runUrl,
    "https://github.com/CharlesMulic/equip/actions/runs/1234567890",
  );
  assert.equal(report.assertion?.outcome, "passed");
  assert.equal(stepSummary, "## Existing step summary\n");
});
