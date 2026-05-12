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

test("assert-release-verification-report passes healthy rollups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-verification-"));
  const reportPath = path.join(root, "release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");
  const summaryPath = path.join(root, "step-summary.md");

  writeJson(reportPath, {
    overallStatus: "passed",
    inputs: {
      hasReleaseBootstrapResult: true,
      hasReleasePreflightResult: true,
      hasPackVerification: true,
      hasTarballSmoke: true,
      hasDockerAcceptance: true,
    },
    releaseBootstrap: {
      status: "passed",
      summary: "dependency install passed",
    },
    releasePreflight: {
      status: "passed",
      summary: "build and tests passed",
    },
    package: {
      status: "passed",
      tarballFileName: "cg3-equip-0.17.7.tgz",
      tarballPath: "/tmp/cg3-equip-0.17.7.tgz",
      artifacts: {
        logPath: ".generated/release/pack-verification.log",
      },
    },
    tarballSmoke: {
      status: "passed",
      tarballFileName: "cg3-equip-0.17.7.tgz",
      tarballPath: "/tmp/cg3-equip-0.17.7.tgz",
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
    artifacts: {
      reportPath,
      assertionPath,
      summaryPath,
    },
    artifactNames: {
      packVerification: "pack-verification",
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
      runAttempt: "2",
      ref: "refs/heads/main",
      serverUrl: "https://github.com",
      eventName: "push",
      sha: "abcdef1234567890",
      runUrl: "https://github.com/CharlesMulic/equip/actions/runs/1234567890",
      commitUrl: "https://github.com/CharlesMulic/equip/commit/abcdef1234567890",
    },
  });

  const result = runScript("scripts/ci/assert-release-verification-report.mjs", {
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_ASSERTION_PATH: assertionPath,
    GITHUB_STEP_SUMMARY: summaryPath,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  const summary = fs.readFileSync(summaryPath, "utf8");
  assert.match(result.stdout, /status passed/i);
  assert.match(result.stdout, /package=passed, tarballSmoke=passed, dockerAcceptance=passed/i);
  assert.equal(assertion.kind, "equip-release-verification-assertion");
  assert.equal(assertion.outcome, "passed");
  assert.equal(assertion.overallStatus, "passed");
  assert.deepEqual(assertion.components, {
    package: "passed",
    tarballSmoke: "passed",
    dockerAcceptance: "passed",
  });
  assert.deepEqual(assertion.inputs, {
    hasReleaseBootstrapResult: true,
    hasReleasePreflightResult: true,
    hasPackVerification: true,
    hasTarballSmoke: true,
    hasDockerAcceptance: true,
  });
  assert.equal(assertion.releaseBootstrap.status, "passed");
  assert.equal(assertion.releasePreflight.status, "passed");
  assert.equal(assertion.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(assertion.workflowContext.workflow, "Release");
  assert.equal(assertion.workflowContext.runId, "1234567890");
  assert.equal(assertion.workflowContext.runAttempt, "2");
  assert.equal(assertion.workflowContext.ref, "refs/heads/main");
  assert.equal(assertion.workflowContext.sha, "abcdef1234567890");
  assert.equal(assertion.workflowContext.eventName, "push");
  assert.equal(
    assertion.workflowContext.runUrl,
    "https://github.com/CharlesMulic/equip/actions/runs/1234567890",
  );
  assert.equal(assertion.package.tarballFileName, "cg3-equip-0.17.7.tgz");
  assert.equal(assertion.package.artifacts.logPath, ".generated/release/pack-verification.log");
  assert.equal(assertion.tarballSmoke.artifacts.logPath, ".generated/release/pack-install-smoke.log");
  assert.equal(
    assertion.dockerAcceptance.artifacts.reportPath,
    ".generated/docker-acceptance/docker-acceptance-report.json",
  );
  assert.equal(assertion.artifacts.summaryPath, summaryPath);
  assert.equal(assertion.artifactNames.report, "release-verification-report");
  assert.equal(assertion.evidenceFileNames.packageLogPath, "pack-verification.log");
  assert.equal(assertion.evidenceFileNames.tarballSmokeLogPath, "pack-install-smoke.log");
  assert.equal(assertion.evidenceFileNames.releaseVerificationReportPath, "release-verification-report.json");
  assert.equal(
    assertion.evidenceFileNames.releaseVerificationAssertionPath,
    "release-verification-assertion.json",
  );
  assert.equal(
    assertion.evidenceFileNames.releaseVerificationSummaryPath,
    "release-verification-summary.md",
  );
  assert.equal(assertion.evidenceArtifactNames.releaseVerificationPackVerification, "pack-verification");
  assert.equal(assertion.evidenceArtifactNames.releaseVerificationSummary, "release-verification-summary");
  assert.deepEqual(assertion.failureDetails, []);
  assert.match(summary, /## Release verification assertion/i);
  assert.match(summary, /Outcome: `passed`/i);
  assert.match(summary, /package: `passed`/i);
  assert.match(summary, /dockerAcceptance: `passed`/i);
  assert.match(summary, /## GitHub workflow context/i);
  assert.match(summary, /Repository: `CharlesMulic\/equip`/i);
  assert.match(summary, /Workflow: `Release`/i);
  assert.match(summary, /Run ID: `1234567890`/i);
  assert.match(summary, /Run URL: `https:\/\/github\.com\/CharlesMulic\/equip\/actions\/runs\/1234567890`/i);
  assert.match(summary, /Commit URL: `https:\/\/github\.com\/CharlesMulic\/equip\/commit\/abcdef1234567890`/i);
});

test("assert-release-verification-report preserves workflow context when the report is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-verification-"));
  const reportPath = path.join(root, "missing-release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");
  const summaryPath = path.join(root, "step-summary.md");

  const result = runScript("scripts/ci/assert-release-verification-report.mjs", {
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_ASSERTION_PATH: assertionPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    ...createWorkflowEnv(),
  });

  assert.notEqual(result.status, 0);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  const summary = fs.readFileSync(summaryPath, "utf8");
  assert.equal(assertion.outcome, "failed");
  assert.equal(assertion.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(assertion.workflowContext.workflow, "Release");
  assert.equal(assertion.workflowContext.runId, "1234567890");
  assert.equal(assertion.workflowContext.runAttempt, "2");
  assert.equal(assertion.workflowContext.ref, "refs/heads/main");
  assert.equal(assertion.workflowContext.sha, "abcdef1234567890");
  assert.equal(assertion.workflowContext.eventName, "push");
  assert.equal(
    assertion.workflowContext.runUrl,
    "https://github.com/CharlesMulic/equip/actions/runs/1234567890",
  );
  assert.equal(assertion.artifacts.reportPath, path.resolve(reportPath));
  assert.equal(assertion.artifacts.assertionPath, path.resolve(assertionPath));
  assert.equal(assertion.evidenceFileNames.reportPath, "missing-release-verification-report.json");
  assert.equal(assertion.evidenceFileNames.assertionPath, "release-verification-assertion.json");
  assert.match(summary, /## GitHub workflow context/i);
  assert.match(summary, /Repository: `CharlesMulic\/equip`/i);
  assert.match(summary, /Workflow: `Release`/i);
  assert.match(summary, /Run ID: `1234567890`/i);
  assert.match(summary, /Run URL: `https:\/\/github\.com\/CharlesMulic\/equip\/actions\/runs\/1234567890`/i);
  assert.match(summary, /Commit URL: `https:\/\/github\.com\/CharlesMulic\/equip\/commit\/abcdef1234567890`/i);
});

test("assert-release-verification-report can skip step summary output when requested", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-verification-"));
  const reportPath = path.join(root, "release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");
  const summaryPath = path.join(root, "step-summary.md");

  writeJson(reportPath, {
    overallStatus: "passed",
    package: { status: "passed" },
    tarballSmoke: { status: "passed" },
    dockerAcceptance: { status: "passed" },
  });

  const result = runScript("scripts/ci/assert-release-verification-report.mjs", {
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_ASSERTION_PATH: assertionPath,
    RELEASE_VERIFICATION_APPEND_STEP_SUMMARY: "false",
    GITHUB_STEP_SUMMARY: summaryPath,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(summaryPath), false);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  assert.equal(assertion.outcome, "passed");
});

test("assert-release-verification-report fails unhealthy rollups with helpful detail", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-verification-"));
  const reportPath = path.join(root, "release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");
  const summaryPath = path.join(root, "step-summary.md");

  writeJson(reportPath, {
    overallStatus: "failed",
    inputs: {
      hasReleaseBootstrapResult: false,
      hasReleasePreflightResult: false,
      hasPackVerification: false,
      hasTarballSmoke: true,
      hasDockerAcceptance: false,
    },
    package: {
      status: "failed",
      problems: ["missing bin/equip.js", "unexpected src/ fixture"],
      failureMessage: "npm pack verification failed",
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
      status: "failed",
      failureMessage: "docker run failed",
      steps: [
        { name: "docker-build", exitCode: 0 },
        { name: "docker-run", exitCode: 1 },
      ],
      artifacts: {
        reportPath: ".generated/docker-acceptance/docker-acceptance-report.json",
        buildLogPath: ".generated/docker-acceptance/docker-build.log",
        runLogPath: ".generated/docker-acceptance/docker-run.log",
      },
    },
  });

  const result = runScript("scripts/ci/assert-release-verification-report.mjs", {
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_ASSERTION_PATH: assertionPath,
    GITHUB_STEP_SUMMARY: summaryPath,
  });

  assert.notEqual(result.status, 0);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  const summary = fs.readFileSync(summaryPath, "utf8");
  assert.match(result.stderr, /assertion failed/i);
  assert.match(result.stderr, /Failed components: package, tarballSmoke, dockerAcceptance\./i);
  assert.match(result.stderr, /Components: package=failed, tarballSmoke=failed, dockerAcceptance=failed\./i);
  assert.match(result.stderr, /package problems: missing bin\/equip\.js; unexpected src\/ fixture/i);
  assert.match(result.stderr, /package failure: npm pack verification failed/i);
  assert.match(result.stderr, /package artifacts: logPath=\.generated\/release\/pack-verification\.log/i);
  assert.match(result.stderr, /tarball smoke failure: Installed equip --help output did not include the expected usage header\./i);
  assert.match(result.stderr, /tarball smoke artifacts: logPath=\.generated\/release\/pack-install-smoke\.log/i);
  assert.match(result.stderr, /docker acceptance details: docker run failed; failing steps: docker-run\(exit=1\)/i);
  assert.match(
    result.stderr,
    /docker acceptance artifacts: reportPath=\.generated\/docker-acceptance\/docker-acceptance-report\.json, buildLogPath=\.generated\/docker-acceptance\/docker-build\.log, runLogPath=\.generated\/docker-acceptance\/docker-run\.log/i,
  );
  assert.equal(assertion.kind, "equip-release-verification-assertion");
  assert.equal(assertion.outcome, "failed");
  assert.equal(assertion.overallStatus, "failed");
  assert.deepEqual(assertion.inputs, {
    hasReleaseBootstrapResult: false,
    hasReleasePreflightResult: false,
    hasPackVerification: false,
    hasTarballSmoke: true,
    hasDockerAcceptance: false,
  });
  assert.equal(assertion.package.failureMessage, "npm pack verification failed");
  assert.equal(assertion.package.artifacts.logPath, ".generated/release/pack-verification.log");
  assert.equal(
    assertion.tarballSmoke.artifacts.logPath,
    ".generated/release/pack-install-smoke.log",
  );
  assert.equal(
    assertion.dockerAcceptance.artifacts.reportPath,
    ".generated/docker-acceptance/docker-acceptance-report.json",
  );
  assert.match(assertion.error, /Failed components: package, tarballSmoke, dockerAcceptance\./i);
  assert.deepEqual(assertion.components, {
    package: "failed",
    tarballSmoke: "failed",
    dockerAcceptance: "failed",
  });
  assert.ok(assertion.failureDetails.some((detail) => /package problems:/i.test(detail)));
  assert.ok(assertion.failureDetails.some((detail) => /package artifacts:/i.test(detail)));
  assert.ok(assertion.failureDetails.some((detail) => /tarball smoke failure:/i.test(detail)));
  assert.ok(assertion.failureDetails.some((detail) => /tarball smoke artifacts:/i.test(detail)));
  assert.ok(assertion.failureDetails.some((detail) => /docker acceptance details:/i.test(detail)));
  assert.ok(assertion.failureDetails.some((detail) => /docker acceptance artifacts:/i.test(detail)));
  assert.deepEqual(assertion.evidenceFileNames, {
    reportPath: "release-verification-report.json",
    assertionPath: "release-verification-assertion.json",
  });
  assert.match(summary, /Outcome: `failed`/i);
  assert.match(summary, /Failure details:/i);
  assert.match(summary, /package problems: missing bin\/equip\.js; unexpected src\/ fixture/i);
  assert.match(summary, /tarball smoke failure: Installed equip --help output did not include the expected usage header\./i);
});

test("assert-release-verification-report reports missing component artifacts clearly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-verification-"));
  const reportPath = path.join(root, "release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");

  writeJson(reportPath, {
    overallStatus: "failed",
    package: {
      status: "missing",
      missingReason: "pack verification artifact missing",
    },
    tarballSmoke: {
      status: "passed",
    },
    dockerAcceptance: {
      status: "missing",
      missingReason: "docker acceptance artifact missing",
    },
  });

  const result = runScript("scripts/ci/assert-release-verification-report.mjs", {
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_ASSERTION_PATH: assertionPath,
  });

  assert.notEqual(result.status, 0);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  assert.match(result.stderr, /Components: package=missing, tarballSmoke=passed, dockerAcceptance=missing\./i);
  assert.match(result.stderr, /package missing: pack verification artifact missing/i);
  assert.match(result.stderr, /docker acceptance missing: docker acceptance artifact missing/i);
  assert.equal(assertion.outcome, "failed");
  assert.deepEqual(assertion.components, {
    package: "missing",
    tarballSmoke: "passed",
    dockerAcceptance: "missing",
  });
  assert.deepEqual(assertion.inputs, {
    hasReleaseBootstrapResult: false,
    hasReleasePreflightResult: false,
    hasPackVerification: false,
    hasTarballSmoke: false,
    hasDockerAcceptance: false,
  });
  assert.equal(assertion.package.missingReason, "pack verification artifact missing");
  assert.equal(assertion.dockerAcceptance.missingReason, "docker acceptance artifact missing");
  assert.deepEqual(assertion.evidenceFileNames, {
    reportPath: "release-verification-report.json",
    assertionPath: "release-verification-assertion.json",
  });
  assert.ok(assertion.failureDetails.some((detail) => /package missing:/i.test(detail)));
  assert.ok(assertion.failureDetails.some((detail) => /docker acceptance missing:/i.test(detail)));
});

test("assert-release-verification-report preserves synthetic artifact metadata when the report is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-verification-"));
  const reportPath = path.join(root, "missing-release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");

  const result = runScript("scripts/ci/assert-release-verification-report.mjs", {
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_ASSERTION_PATH: assertionPath,
    RELEASE_BOOTSTRAP_RESULT_ARTIFACT_NAME: "release-bootstrap",
    RELEASE_PREFLIGHT_RESULT_ARTIFACT_NAME: "release-preflight",
    PACK_VERIFICATION_ARTIFACT_NAME: "pack-verification",
    PACK_TARBALL_ARTIFACT_NAME: "pack-tarball",
    PACK_INSTALL_SMOKE_ARTIFACT_NAME: "pack-install-smoke",
    DOCKER_ACCEPTANCE_ARTIFACT_NAME: "docker-acceptance",
    RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME: "release-verification-report",
    RELEASE_VERIFICATION_ASSERTION_ARTIFACT_NAME: "release-verification-assertion",
    RELEASE_VERIFICATION_SUMMARY_ARTIFACT_NAME: "release-verification-summary",
    ...createWorkflowEnv(),
  });

  assert.notEqual(result.status, 0);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  assert.equal(assertion.artifactNames.releaseBootstrap, "release-bootstrap");
  assert.equal(assertion.artifactNames.releasePreflight, "release-preflight");
  assert.equal(assertion.artifactNames.packVerification, "pack-verification");
  assert.equal(assertion.artifactNames.packTarball, "pack-tarball");
  assert.equal(assertion.artifactNames.packInstallSmoke, "pack-install-smoke");
  assert.equal(assertion.artifactNames.dockerAcceptance, "docker-acceptance");
  assert.equal(assertion.artifactNames.report, "release-verification-report");
  assert.equal(assertion.artifactNames.assertion, "release-verification-assertion");
  assert.equal(assertion.artifactNames.summary, "release-verification-summary");
  assert.deepEqual(assertion.evidenceArtifactNames, {
    releaseVerificationReleaseBootstrap: "release-bootstrap",
    releaseVerificationReleasePreflight: "release-preflight",
    releaseVerificationPackVerification: "pack-verification",
    releaseVerificationPackTarball: "pack-tarball",
    releaseVerificationPackInstallSmoke: "pack-install-smoke",
    releaseVerificationDockerAcceptance: "docker-acceptance",
    releaseVerificationReport: "release-verification-report",
    releaseVerificationAssertion: "release-verification-assertion",
    releaseVerificationSummary: "release-verification-summary",
  });
  assert.equal(assertion.evidenceFileNames.reportPath, "missing-release-verification-report.json");
  assert.equal(assertion.evidenceFileNames.assertionPath, "release-verification-assertion.json");
});

test("assert-release-verification-report reports skipped component artifacts clearly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-verification-"));
  const reportPath = path.join(root, "release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");

  writeJson(reportPath, {
    overallStatus: "failed",
    package: {
      status: "skipped",
      skippedReason: "pack verification skipped because release preflight did not pass",
    },
    tarballSmoke: {
      status: "skipped",
      skippedReason: "tarball smoke skipped because release preflight did not pass",
    },
    dockerAcceptance: {
      status: "skipped",
      skippedReason: "docker acceptance skipped because release preflight did not pass",
    },
  });

  const result = runScript("scripts/ci/assert-release-verification-report.mjs", {
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_ASSERTION_PATH: assertionPath,
  });

  assert.notEqual(result.status, 0);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  assert.match(result.stderr, /Components: package=skipped, tarballSmoke=skipped, dockerAcceptance=skipped\./i);
  assert.match(result.stderr, /package skipped: pack verification skipped because release preflight did not pass/i);
  assert.match(result.stderr, /tarball smoke skipped: tarball smoke skipped because release preflight did not pass/i);
  assert.match(result.stderr, /docker acceptance skipped: docker acceptance skipped because release preflight did not pass/i);
  assert.equal(assertion.outcome, "failed");
  assert.deepEqual(assertion.components, {
    package: "skipped",
    tarballSmoke: "skipped",
    dockerAcceptance: "skipped",
  });
  assert.deepEqual(assertion.inputs, {
    hasReleaseBootstrapResult: false,
    hasReleasePreflightResult: false,
    hasPackVerification: false,
    hasTarballSmoke: false,
    hasDockerAcceptance: false,
  });
  assert.match(assertion.package.skippedReason, /release preflight did not pass/i);
  assert.match(assertion.tarballSmoke.skippedReason, /release preflight did not pass/i);
  assert.match(assertion.dockerAcceptance.skippedReason, /release preflight did not pass/i);
  assert.deepEqual(assertion.evidenceFileNames, {
    reportPath: "release-verification-report.json",
    assertionPath: "release-verification-assertion.json",
  });
  assert.ok(assertion.failureDetails.some((detail) => /package skipped:/i.test(detail)));
  assert.ok(assertion.failureDetails.some((detail) => /docker acceptance skipped:/i.test(detail)));
});

test("assert-release-verification-report defaults missing input state to false", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-verification-"));
  const reportPath = path.join(root, "release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");

  writeJson(reportPath, {
    overallStatus: "passed",
    package: {
      status: "passed",
    },
    tarballSmoke: {
      status: "passed",
    },
    dockerAcceptance: {
      status: "passed",
    },
  });

  const result = runScript("scripts/ci/assert-release-verification-report.mjs", {
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_ASSERTION_PATH: assertionPath,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  assert.deepEqual(assertion.inputs, {
    hasReleaseBootstrapResult: false,
    hasReleasePreflightResult: false,
    hasPackVerification: false,
    hasTarballSmoke: false,
    hasDockerAcceptance: false,
  });
  assert.deepEqual(assertion.evidenceFileNames, {
    reportPath: "release-verification-report.json",
    assertionPath: "release-verification-assertion.json",
  });
});
