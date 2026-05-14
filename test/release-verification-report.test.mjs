import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendReleaseVerificationSummary,
  buildReleaseVerificationSummaryMarkdown,
  buildReleaseVerificationReport,
  rebaseReleaseVerificationInputs,
} from "../scripts/ci/release-verification-report-lib.mjs";

function createWorkflowContext() {
  return {
    repository: "CharlesMulic/equip",
    workflow: "Release",
    runId: "1234567890",
    runAttempt: "2",
    ref: "refs/heads/main",
    sha: "abcdef1234567890",
    eventName: "push",
    serverUrl: "https://github.com",
    apiUrl: "https://api.github.com",
  };
}

test("buildReleaseVerificationReport marks the rollup passed when all component gates pass", () => {
  const report = buildReleaseVerificationReport({
    packVerification: {
      packageName: "@cg3/equip",
      version: "0.17.7",
      tarballFileName: "cg3-equip-0.17.7.tgz",
      tarballPath: "/tmp/cg3-equip-0.17.7.tgz",
      entryCount: 12,
      unpackedSize: 45678,
      packageSizeBytes: 12345,
      shasum: "abc123",
      integrity: "sha512-abc",
      requiredFilesChecked: ["bin/equip.js"],
      forbiddenPrefixesChecked: ["src/"],
      hasFailures: false,
      problems: [],
      artifacts: {
        logPath: ".generated/release/pack-verification.log",
      },
    },
    packInstallSmoke: {
      tarballFileName: "cg3-equip-0.17.7.tgz",
      tarballPath: "/tmp/cg3-equip-0.17.7.tgz",
      installedVersion: "0.17.7",
      equipVersion: "0.17.7",
      unequipVersion: "0.17.7",
      helpIncludesUsage: true,
      exportsCheck: "exports-ok",
      steps: [
        { name: "npm-install", status: "passed", exitCode: 0 },
      ],
      artifacts: {
        logPath: ".generated/release/pack-install-smoke.log",
      },
    },
    dockerAcceptance: {
      status: "passed",
      dockerBin: "docker",
      imageTag: "cg3-equip-acceptance:test",
      totalDurationMs: 6789,
      steps: [
        { name: "docker-build", durationMs: 1234, exitCode: 0 },
        { name: "docker-run", durationMs: 5555, exitCode: 0 },
      ],
      artifacts: {
        reportPath: ".generated/docker-acceptance/docker-acceptance-report.json",
      },
      failureMessage: "",
    },
    artifacts: {
      reportPath: ".generated/release/release-verification-report.json",
      assertionPath: "",
      summaryPath: "",
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
    workflowContext: createWorkflowContext(),
  });

  assert.equal(report.overallStatus, "passed");
  assert.equal(report.package.status, "passed");
  assert.equal(report.tarballSmoke.status, "passed");
  assert.equal(report.dockerAcceptance.status, "passed");
  assert.equal(report.package.artifacts.logPath, ".generated/release/pack-verification.log");
  assert.equal(report.tarballSmoke.artifacts.logPath, ".generated/release/pack-install-smoke.log");
  assert.equal(report.tarballSmoke.steps[0].name, "npm-install");
  assert.equal(report.dockerAcceptance.steps[1].name, "docker-run");
  assert.equal(report.artifacts.reportPath, ".generated/release/release-verification-report.json");
  assert.equal(report.evidenceFileNames.packageLogPath, "pack-verification.log");
  assert.equal(report.evidenceFileNames.tarballSmokeLogPath, "pack-install-smoke.log");
  assert.equal(report.evidenceFileNames.dockerAcceptanceReportPath, "docker-acceptance-report.json");
  assert.equal(report.evidenceFileNames.releaseVerificationReportPath, "release-verification-report.json");
  assert.equal(report.evidenceArtifactNames.releaseVerificationPackVerification, "pack-verification");
  assert.equal(report.evidenceArtifactNames.releaseVerificationPackTarball, "pack-tarball");
  assert.equal(report.evidenceArtifactNames.releaseVerificationDockerAcceptance, "docker-acceptance");
  assert.equal(report.artifactNames.packVerification, "pack-verification");
  assert.equal(report.artifactNames.dockerAcceptance, "docker-acceptance");
  assert.equal(report.artifactNames.report, "release-verification-report");
  assert.equal(report.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(report.workflowContext.workflow, "Release");
  assert.equal(report.workflowContext.runId, "1234567890");
  assert.equal(report.workflowContext.serverUrl, "https://github.com");
  assert.equal(report.workflowContext.apiUrl, "https://api.github.com");
  assert.equal(report.workflowContext.runAttempt, "2");
  assert.equal(report.workflowContext.ref, "refs/heads/main");
  assert.equal(report.workflowContext.sha, "abcdef1234567890");
  assert.equal(report.workflowContext.eventName, "push");
  assert.equal(
    report.workflowContext.runUrl,
    "https://github.com/CharlesMulic/equip/actions/runs/1234567890",
  );
  assert.equal(
    report.workflowContext.commitUrl,
    "https://github.com/CharlesMulic/equip/commit/abcdef1234567890",
  );
});

test("buildReleaseVerificationReport marks the rollup failed when any component gate fails", () => {
  const report = buildReleaseVerificationReport({
    packVerification: {
      status: "failed",
      hasFailures: true,
      problems: ["missing required files"],
      failureMessage: "npm pack verification failed",
      artifacts: {
        logPath: ".generated/release/pack-verification.log",
      },
    },
    packInstallSmoke: {
      status: "failed",
      helpIncludesUsage: false,
      exportsCheck: "exports-ok",
      failureMessage: "installed equip --help output did not include the expected usage header",
      artifacts: {
        logPath: ".generated/release/pack-install-smoke.log",
      },
    },
    dockerAcceptance: {
      status: "failed",
      failureMessage: "docker run failed",
      steps: [],
    },
  });

  assert.equal(report.overallStatus, "failed");
  assert.equal(report.package.status, "failed");
  assert.equal(report.tarballSmoke.status, "failed");
  assert.equal(report.dockerAcceptance.status, "failed");
  assert.match(report.package.failureMessage, /npm pack verification failed/i);
  assert.match(report.tarballSmoke.failureMessage, /expected usage header/i);
  assert.match(report.dockerAcceptance.failureMessage, /docker run failed/i);
  assert.equal(report.package.artifacts.logPath, ".generated/release/pack-verification.log");
  assert.equal(report.tarballSmoke.artifacts.logPath, ".generated/release/pack-install-smoke.log");
});

test("buildReleaseVerificationReport marks missing component artifacts explicitly", () => {
  const report = buildReleaseVerificationReport({
    packVerification: null,
    packInstallSmoke: {
      helpIncludesUsage: true,
      exportsCheck: "exports-ok",
      equipVersion: "0.17.7",
      unequipVersion: "0.17.7",
    },
    dockerAcceptance: null,
  });

  assert.equal(report.overallStatus, "failed");
  assert.equal(report.inputs.hasPackVerification, false);
  assert.equal(report.inputs.hasTarballSmoke, true);
  assert.equal(report.inputs.hasDockerAcceptance, false);
  assert.equal(report.package.status, "missing");
  assert.equal(report.package.missingReason, "pack verification artifact missing");
  assert.deepEqual(report.package.artifacts, {});
  assert.equal(report.tarballSmoke.status, "passed");
  assert.deepEqual(report.tarballSmoke.artifacts, {});
  assert.deepEqual(report.tarballSmoke.steps, []);
  assert.equal(report.dockerAcceptance.status, "missing");
  assert.equal(report.dockerAcceptance.missingReason, "docker acceptance artifact missing");
});

test("buildReleaseVerificationReport marks downstream lanes skipped when preflight failed", () => {
  const report = buildReleaseVerificationReport({
    releaseBootstrapResult: {
      kind: "equip-release-bootstrap-result",
      overallStatus: "passed",
      summary: "dependency install passed",
      evidenceArtifactNames: {
        bundle: "release-bootstrap",
      },
    },
    releasePreflightResult: {
      kind: "equip-release-preflight-result",
      overallStatus: "failed",
      summary: "build failed (exit 2); test skipped",
      evidenceArtifactNames: {
        bundle: "release-preflight",
      },
    },
    packVerification: null,
    packInstallSmoke: null,
    dockerAcceptance: null,
    artifactNames: {
      releaseBootstrap: "release-bootstrap",
      releasePreflight: "release-preflight",
      report: "release-verification-report",
    },
  });

  assert.equal(report.overallStatus, "failed");
  assert.equal(report.releaseBootstrap.status, "passed");
  assert.equal(report.releasePreflight.status, "failed");
  assert.equal(report.package.status, "skipped");
  assert.equal(report.tarballSmoke.status, "skipped");
  assert.equal(report.dockerAcceptance.status, "skipped");
  assert.equal(report.evidenceArtifactNames.releaseBootstrapBundle, "release-bootstrap");
  assert.equal(report.evidenceArtifactNames.releasePreflightBundle, "release-preflight");
  assert.match(report.package.skippedReason, /release preflight did not pass/i);
  assert.match(report.tarballSmoke.skippedReason, /release preflight did not pass/i);
  assert.match(report.dockerAcceptance.skippedReason, /release preflight did not pass/i);
});

test("buildReleaseVerificationReport marks downstream lanes skipped when bootstrap failed first", () => {
  const report = buildReleaseVerificationReport({
    releaseBootstrapResult: {
      kind: "equip-release-bootstrap-result",
      overallStatus: "failed",
      summary: "dependency install failed (exit 2)",
    },
    releasePreflightResult: null,
    packVerification: null,
    packInstallSmoke: null,
    dockerAcceptance: null,
  });

  assert.equal(report.overallStatus, "failed");
  assert.equal(report.releaseBootstrap.status, "failed");
  assert.equal(report.releasePreflight.status, "skipped");
  assert.match(report.releasePreflight.summary, /bootstrap did not pass/i);
  assert.equal(report.package.status, "skipped");
  assert.match(report.package.skippedReason, /release bootstrap did not pass/i);
});

test("appendReleaseVerificationSummary includes artifact pointers for each verification lane", () => {
  const summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-summary-"));
  const summaryPath = path.join(summaryDir, "summary.md");
  const report = buildReleaseVerificationReport({
    packVerification: {
      status: "failed",
      hasFailures: true,
      problems: ["missing required files"],
      failureMessage: "npm pack verification failed",
      tarballFileName: "cg3-equip-0.17.7.tgz",
      artifacts: {
        logPath: ".generated/release/pack-verification.log",
      },
    },
    packInstallSmoke: {
      status: "failed",
      helpIncludesUsage: false,
      exportsCheck: "exports-ok",
      failureMessage: "installed equip --help output did not include the expected usage header",
      artifacts: {
        logPath: ".generated/release/pack-install-smoke.log",
      },
    },
    dockerAcceptance: {
      status: "failed",
      failureMessage: "docker run failed",
      totalDurationMs: 6789,
      steps: [
        { name: "docker-build", durationMs: 1234, exitCode: 0 },
        { name: "docker-run", durationMs: 5555, exitCode: 1 },
      ],
      artifacts: {
        reportPath: ".generated/docker-acceptance/docker-acceptance-report.json",
        buildLogPath: ".generated/docker-acceptance/docker-build.log",
        runLogPath: ".generated/docker-acceptance/docker-run.log",
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
    workflowContext: createWorkflowContext(),
  });

  appendReleaseVerificationSummary({
    summaryPath,
    report,
  });

  const summary = fs.readFileSync(summaryPath, "utf8");
  assert.match(summary, /Pack verification log: `\.generated\/release\/pack-verification\.log`/i);
  assert.match(summary, /Tarball smoke log: `\.generated\/release\/pack-install-smoke\.log`/i);
  assert.match(summary, /Docker report: `\.generated\/docker-acceptance\/docker-acceptance-report\.json`/i);
  assert.match(summary, /Docker build log: `\.generated\/docker-acceptance\/docker-build\.log`/i);
  assert.match(summary, /Docker run log: `\.generated\/docker-acceptance\/docker-run\.log`/i);
  assert.match(summary, /## GitHub workflow context/i);
  assert.match(summary, /Repository: `CharlesMulic\/equip`/i);
  assert.match(summary, /Workflow: `Release`/i);
  assert.match(summary, /Run ID: `1234567890`/i);
  assert.match(summary, /Run attempt: `2`/i);
  assert.match(summary, /Event: `push`/i);
  assert.match(summary, /Ref: `refs\/heads\/main`/i);
  assert.match(summary, /SHA: `abcdef1234567890`/i);
  assert.match(summary, /API URL: `https:\/\/api\.github\.com`/i);
  assert.match(summary, /Run URL: `https:\/\/github\.com\/CharlesMulic\/equip\/actions\/runs\/1234567890`/i);
  assert.match(summary, /Commit URL: `https:\/\/github\.com\/CharlesMulic\/equip\/commit\/abcdef1234567890`/i);
  assert.match(summary, /## Evidence artifacts/i);
  assert.match(summary, /## Nested evidence artifacts/i);
  assert.match(summary, /## Evidence file names/i);
  assert.match(summary, /Release Verification Pack Verification: `pack-verification`/i);
  assert.match(summary, /Release Verification Summary: `release-verification-summary`/i);
  assert.match(summary, /Package Log Path: `pack-verification\.log`/i);
  assert.match(summary, /Tarball Smoke Log Path: `pack-install-smoke\.log`/i);
  assert.match(summary, /Pack Verification: `pack-verification`/i);
  assert.match(summary, /Summary: `release-verification-summary`/i);
});

test("buildReleaseVerificationSummaryMarkdown includes skipped prerequisite details", () => {
  const report = buildReleaseVerificationReport({
    releaseBootstrapResult: {
      kind: "equip-release-bootstrap-result",
      overallStatus: "failed",
      summary: "dependency install failed (exit 2)",
    },
    releasePreflightResult: null,
    packVerification: null,
    packInstallSmoke: null,
    dockerAcceptance: null,
  });

  const markdown = buildReleaseVerificationSummaryMarkdown({ report });
  assert.match(markdown, /Release bootstrap: `failed`/i);
  assert.match(markdown, /Release preflight: `skipped`/i);
  assert.match(markdown, /Pack verification: `skipped`/i);
  assert.match(markdown, /Pack verification detail: pack verification skipped because release bootstrap did not pass/i);
  assert.match(markdown, /Tarball smoke detail: tarball smoke skipped because release bootstrap did not pass/i);
  assert.match(markdown, /Docker acceptance detail: docker acceptance skipped because release bootstrap did not pass/i);
});

test("buildReleaseVerificationSummaryMarkdown can include the final assertion section", () => {
  const report = buildReleaseVerificationReport({
    packVerification: {
      status: "passed",
      hasFailures: false,
      problems: [],
      tarballFileName: "cg3-equip-0.17.7.tgz",
      artifacts: {
        logPath: ".generated/release/pack-verification.log",
      },
    },
    packInstallSmoke: {
      status: "passed",
      helpIncludesUsage: true,
      exportsCheck: "exports-ok",
      artifacts: {
        logPath: ".generated/release/pack-install-smoke.log",
      },
    },
    dockerAcceptance: {
      status: "passed",
      totalDurationMs: 6789,
      steps: [],
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
    artifacts: {
      reportPath: ".generated/release/release-verification-report.json",
      assertionPath: ".generated/release/release-verification-assertion.json",
      summaryPath: ".generated/release/release-verification-summary.md",
    },
  });

  const markdown = buildReleaseVerificationSummaryMarkdown({
    report,
    assertion: {
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
    },
  });

  assert.match(markdown, /## Release verification rollup/i);
  assert.match(markdown, /## Final assertion/i);
  assert.match(markdown, /## Evidence artifacts/i);
  assert.match(markdown, /## Evidence file names/i);
  assert.match(markdown, /Outcome: `failed`/i);
  assert.match(markdown, /tarballSmoke: `failed`/i);
  assert.match(markdown, /Release Verification Report: `release-verification-report`/i);
  assert.match(markdown, /Assertion: `release-verification-assertion`/i);
  assert.match(markdown, /Summary: `release-verification-summary`/i);
  assert.match(markdown, /Assertion artifact: `\.generated\/release\/release-verification-assertion\.json`/i);
  assert.match(markdown, /Release Verification Report Path: `release-verification-report\.json`/i);
  assert.match(markdown, /Release Verification Assertion Path: `release-verification-assertion\.json`/i);
  assert.match(markdown, /Release Verification Summary Path: `release-verification-summary\.md`/i);
  assert.match(markdown, /Failure details:/i);
  assert.match(markdown, /release verification failed/i);
});

test("buildReleaseVerificationReport can embed final assertion details and artifact pointers", () => {
  const report = buildReleaseVerificationReport({
    packVerification: {
      status: "passed",
      hasFailures: false,
      problems: [],
    },
    packInstallSmoke: {
      status: "passed",
      helpIncludesUsage: true,
      exportsCheck: "exports-ok",
    },
    dockerAcceptance: {
      status: "passed",
      steps: [],
    },
    assertion: {
      outcome: "passed",
      overallStatus: "passed",
      components: {
        package: "passed",
        tarballSmoke: "passed",
        dockerAcceptance: "passed",
      },
      reportPath: "C:/tmp/release-verification-report.json",
      assertionPath: "C:/tmp/release-verification-assertion.json",
      failureDetails: [],
      error: "",
    },
    artifacts: {
      reportPath: "C:/tmp/release-verification-report.json",
      assertionPath: "C:/tmp/release-verification-assertion.json",
      summaryPath: "C:/tmp/release-verification-summary.md",
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
  });

  assert.equal(report.assertion?.outcome, "passed");
  assert.equal(report.assertion?.components?.dockerAcceptance, "passed");
  assert.equal(report.artifacts.reportPath, "C:/tmp/release-verification-report.json");
  assert.equal(report.artifacts.assertionPath, "C:/tmp/release-verification-assertion.json");
  assert.equal(report.artifacts.summaryPath, "C:/tmp/release-verification-summary.md");
  assert.equal(report.evidenceFileNames.releaseVerificationReportPath, "release-verification-report.json");
  assert.equal(report.evidenceFileNames.releaseVerificationAssertionPath, "release-verification-assertion.json");
  assert.equal(report.evidenceFileNames.releaseVerificationSummaryPath, "release-verification-summary.md");
  assert.equal(report.evidenceArtifactNames.releaseVerificationReport, "release-verification-report");
  assert.equal(report.evidenceArtifactNames.releaseVerificationAssertion, "release-verification-assertion");
  assert.equal(report.evidenceArtifactNames.releaseVerificationSummary, "release-verification-summary");
  assert.equal(report.artifactNames.packTarball, "pack-tarball");
  assert.equal(report.artifactNames.summary, "release-verification-summary");
});

test("appendReleaseVerificationSummary can append both rollup and assertion details", () => {
  const summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-summary-"));
  const summaryPath = path.join(summaryDir, "summary-with-assertion.md");
  const report = buildReleaseVerificationReport({
    packVerification: {
      status: "passed",
      hasFailures: false,
      problems: [],
      artifacts: {
        logPath: ".generated/release/pack-verification.log",
      },
    },
    packInstallSmoke: {
      status: "passed",
      helpIncludesUsage: true,
      exportsCheck: "exports-ok",
      artifacts: {
        logPath: ".generated/release/pack-install-smoke.log",
      },
    },
    dockerAcceptance: {
      status: "passed",
      steps: [],
      artifacts: {
        reportPath: ".generated/docker-acceptance/docker-acceptance-report.json",
      },
    },
  });

  appendReleaseVerificationSummary({
    summaryPath,
    report,
    assertion: {
      outcome: "passed",
      overallStatus: "passed",
      components: {
        package: "passed",
        tarballSmoke: "passed",
        dockerAcceptance: "passed",
      },
      reportPath: ".generated/release/release-verification-report.json",
      assertionPath: ".generated/release/release-verification-assertion.json",
      failureDetails: [],
    },
  });

  const summary = fs.readFileSync(summaryPath, "utf8");
  assert.match(summary, /## Release verification rollup/i);
  assert.match(summary, /## Final assertion/i);
  assert.match(summary, /Outcome: `passed`/i);
});

test("rebaseReleaseVerificationInputs rewrites artifact paths to the current verification workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-rebase-"));
  const packDir = path.join(root, "pack-verification");
  const smokeDir = path.join(root, "pack-install-smoke");
  const dockerDir = path.join(root, "docker-acceptance");
  const tarballDir = path.join(root, "pack-tarball");

  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(smokeDir, { recursive: true });
  fs.mkdirSync(dockerDir, { recursive: true });
  fs.mkdirSync(tarballDir, { recursive: true });

  const packVerificationPath = path.join(packDir, "pack-verification.json");
  const packLogPath = path.join(packDir, "pack-verification.log");
  const packInstallSmokePath = path.join(smokeDir, "pack-install-smoke.json");
  const packSmokeLogPath = path.join(smokeDir, "pack-install-smoke.log");
  const dockerAcceptanceReportPath = path.join(dockerDir, "docker-acceptance-report.json");
  const dockerBuildLogPath = path.join(dockerDir, "docker-build.log");
  const dockerRunLogPath = path.join(dockerDir, "docker-run.log");
  const tarballPath = path.join(tarballDir, "cg3-equip-0.17.7.tgz");

  for (const filePath of [
    packVerificationPath,
    packLogPath,
    packInstallSmokePath,
    packSmokeLogPath,
    dockerAcceptanceReportPath,
    dockerBuildLogPath,
    dockerRunLogPath,
    tarballPath,
  ]) {
    fs.writeFileSync(filePath, "stub\n", "utf8");
  }

  const rebased = rebaseReleaseVerificationInputs({
    packVerification: {
      tarballFileName: "cg3-equip-0.17.7.tgz",
      tarballPath: "/old/job/pack/cg3-equip-0.17.7.tgz",
      artifacts: {
        logPath: "/old/job/pack/pack-verification.log",
      },
    },
    packVerificationPath,
    packInstallSmoke: {
      tarballFileName: "cg3-equip-0.17.7.tgz",
      tarballPath: "/old/job/pack/cg3-equip-0.17.7.tgz",
      artifacts: {
        logPath: "/old/job/pack/pack-install-smoke.log",
      },
    },
    packInstallSmokePath,
    dockerAcceptance: {
      artifacts: {
        reportPath: "/old/job/docker/docker-acceptance-report.json",
        buildLogPath: "/old/job/docker/docker-build.log",
        runLogPath: "/old/job/docker/docker-run.log",
      },
    },
    dockerAcceptanceReportPath,
    packTarballDir: tarballDir,
  });

  assert.equal(rebased.packVerification.tarballPath, path.resolve(tarballPath));
  assert.equal(rebased.packVerification.artifacts.reportPath, path.resolve(packVerificationPath));
  assert.equal(rebased.packVerification.artifacts.logPath, path.resolve(packLogPath));
  assert.equal(rebased.packInstallSmoke.tarballPath, path.resolve(tarballPath));
  assert.equal(rebased.packInstallSmoke.artifacts.resultPath, path.resolve(packInstallSmokePath));
  assert.equal(rebased.packInstallSmoke.artifacts.logPath, path.resolve(packSmokeLogPath));
  assert.equal(rebased.dockerAcceptance.artifacts.reportPath, path.resolve(dockerAcceptanceReportPath));
  assert.equal(rebased.dockerAcceptance.artifacts.buildLogPath, path.resolve(dockerBuildLogPath));
  assert.equal(rebased.dockerAcceptance.artifacts.runLogPath, path.resolve(dockerRunLogPath));
});
