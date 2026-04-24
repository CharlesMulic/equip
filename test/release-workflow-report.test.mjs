import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildReleaseWorkflowReport,
  buildReleaseWorkflowSummaryMarkdown,
} from "../scripts/ci/release-workflow-report-lib.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..");

function runScript(scriptRelativePath, env) {
  return spawnSync(process.execPath, [path.join(workspaceRoot, scriptRelativePath)], {
    cwd: workspaceRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function createReleaseVerificationReport() {
  return {
    kind: "equip-release-verification-report",
    overallStatus: "passed",
    summary: "all release verification checks passed",
    artifacts: {
      reportPath: "/tmp/release-verification-report.json",
      assertionPath: "/tmp/release-verification-assertion.json",
      summaryPath: "/tmp/release-verification-summary.md",
    },
    package: {
      artifacts: {
        logPath: "/tmp/pack-verification.log",
      },
    },
    tarballSmoke: {
      artifacts: {
        logPath: "/tmp/pack-install-smoke.log",
      },
    },
    dockerAcceptance: {
      artifacts: {
        reportPath: "/tmp/docker-acceptance-report.json",
        buildLogPath: "/tmp/docker-build.log",
        runLogPath: "/tmp/docker-run.log",
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
  };
}

function createChangesetsReleaseReport() {
  return {
    kind: "equip-changesets-release-report",
    status: "published",
    artifacts: {
      resultPath: "/tmp/changesets-release-result.json",
      assertionPath: "/tmp/changesets-release-assertion.json",
      summaryPath: "/tmp/changesets-release-summary.md",
      reportPath: "/tmp/changesets-release-report.json",
    },
    result: {
      summary: "changesets release step published 1 package: @cg3/equip@0.17.8",
    },
    artifactNames: {
      result: "changesets-release-result",
      assertion: "changesets-release-assertion",
      report: "changesets-release-report",
      summary: "changesets-release-summary",
    },
  };
}

function createReleaseBootstrapResult() {
  return {
    kind: "equip-release-bootstrap-result",
    overallStatus: "passed",
    summary: "dependency install passed",
    steps: {
      install: {
        status: "passed",
        summary: "dependency install completed successfully",
      },
    },
    artifacts: {
      resultPath: "/tmp/release-bootstrap-result.json",
      summaryPath: "/tmp/release-bootstrap-summary.md",
    },
  };
}

function createReleasePreflightResult() {
  return {
    kind: "equip-release-preflight-result",
    overallStatus: "passed",
    summary: "build passed; test passed",
    phases: {
      build: {
        status: "passed",
        summary: "build completed successfully",
      },
      test: {
        status: "passed",
        summary: "test completed successfully",
      },
    },
    artifacts: {
      resultPath: "/tmp/release-preflight-result.json",
      summaryPath: "/tmp/release-preflight-summary.md",
    },
  };
}

test("buildReleaseWorkflowReport combines verification and changesets release status", () => {
  const report = buildReleaseWorkflowReport({
    releaseBootstrapResult: createReleaseBootstrapResult(),
    releasePreflightResult: createReleasePreflightResult(),
    releaseVerificationReport: createReleaseVerificationReport(),
    changesetsReleaseReport: createChangesetsReleaseReport(),
    assertionArtifact: {
      assertion: {
        outcome: "passed",
        actualStatus: "published",
        allowedStatuses: ["published", "completed"],
        failureDetails: [],
      },
    },
    artifacts: {
      releaseBootstrapResultPath: "/tmp/release-bootstrap-result.json",
      releasePreflightResultPath: "/tmp/release-preflight-result.json",
      releaseVerificationReportPath: "/tmp/release-verification-report.json",
      changesetsReleaseReportPath: "/tmp/changesets-release-report.json",
      assertionPath: "/tmp/release-workflow-assertion.json",
      summaryPath: "/tmp/release-workflow-summary.md",
      reportPath: "/tmp/release-workflow-report.json",
    },
    artifactNames: {
      releaseBootstrap: "release-bootstrap-result",
      releasePreflight: "release-preflight-result",
      releaseVerification: "release-verification-report",
      changesetsRelease: "changesets-release-report",
      assertion: "release-workflow-assertion",
      summary: "release-workflow-summary",
      report: "release-workflow-report",
    },
  });

  assert.equal(report.kind, "equip-release-workflow-report");
  assert.equal(report.overallStatus, "published");
  assert.equal(report.actualStatus, "published");
  assert.equal(report.effectiveStatus, "published");
  assert.equal(report.releaseBootstrap.status, "passed");
  assert.equal(report.releasePreflight.status, "passed");
  assert.equal(report.releaseVerification.status, "passed");
  assert.equal(report.changesetsRelease.status, "published");
  assert.equal(report.assertion.outcome, "passed");
  assert.equal(report.artifacts.summaryPath, "/tmp/release-workflow-summary.md");
  assert.equal(report.artifactNames.summary, "release-workflow-summary");
  assert.equal(report.evidenceFiles.releaseBootstrapResultPath, "/tmp/release-bootstrap-result.json");
  assert.equal(report.evidenceFiles.releasePreflightSummaryPath, "/tmp/release-preflight-summary.md");
  assert.equal(report.evidenceFiles.releaseVerificationReportPath, "/tmp/release-verification-report.json");
  assert.equal(report.evidenceFiles.packageLogPath, "/tmp/pack-verification.log");
  assert.equal(report.evidenceFiles.tarballSmokeLogPath, "/tmp/pack-install-smoke.log");
  assert.equal(report.evidenceFiles.dockerAcceptanceRunLogPath, "/tmp/docker-run.log");
  assert.equal(report.evidenceFiles.changesetsReleaseReportPath, "/tmp/changesets-release-report.json");
  assert.equal(report.evidenceFiles.releaseWorkflowSummaryPath, "/tmp/release-workflow-summary.md");
  assert.equal(report.evidenceArtifactNames.releaseVerificationPackVerification, "pack-verification");
  assert.equal(report.evidenceArtifactNames.releaseVerificationPackTarball, "pack-tarball");
  assert.equal(report.evidenceArtifactNames.releaseVerificationDockerAcceptance, "docker-acceptance");
  assert.equal(report.evidenceArtifactNames.changesetsReleaseResult, "changesets-release-result");
  assert.equal(report.evidenceArtifactNames.changesetsReleaseAssertion, "changesets-release-assertion");
});

test("buildReleaseWorkflowReport marks missing reports explicitly", () => {
  const report = buildReleaseWorkflowReport({
    releaseBootstrapResult: null,
    releasePreflightResult: null,
    releaseVerificationReport: null,
    changesetsReleaseReport: createChangesetsReleaseReport(),
  });

  assert.equal(report.overallStatus, "failed");
  assert.equal(report.actualStatus, "failed");
  assert.equal(report.effectiveStatus, "failed");
  assert.equal(report.inputs.hasReleaseBootstrapResult, false);
  assert.equal(report.inputs.hasReleasePreflightResult, false);
  assert.equal(report.inputs.hasReleaseVerificationReport, false);
  assert.equal(report.releaseBootstrap.status, "missing");
  assert.equal(report.releasePreflight.status, "missing");
  assert.equal(report.releaseVerification.status, "missing");
  assert.equal(report.changesetsRelease.status, "published");
});

test("buildReleaseWorkflowReport marks preflight skipped when bootstrap failed first", () => {
  const report = buildReleaseWorkflowReport({
    releaseBootstrapResult: {
      kind: "equip-release-bootstrap-result",
      overallStatus: "failed",
      summary: "dependency install failed (exit 2)",
    },
    releasePreflightResult: null,
    releaseVerificationReport: null,
    changesetsReleaseReport: null,
  });

  assert.equal(report.overallStatus, "failed");
  assert.equal(report.actualStatus, "failed");
  assert.equal(report.effectiveStatus, "failed");
  assert.equal(report.releaseBootstrap.status, "failed");
  assert.equal(report.releasePreflight.status, "skipped");
  assert.equal(report.releaseVerification.status, "skipped");
  assert.equal(report.changesetsRelease.status, "skipped");
  assert.match(report.releasePreflight.summary, /bootstrap did not pass/i);
  assert.match(report.releaseVerification.summary, /bootstrap did not pass/i);
  assert.match(report.changesetsRelease.summary, /bootstrap did not pass/i);
});

test("buildReleaseWorkflowReport marks downstream lanes skipped when preflight failed", () => {
  const report = buildReleaseWorkflowReport({
    releaseBootstrapResult: createReleaseBootstrapResult(),
    releasePreflightResult: {
      kind: "equip-release-preflight-result",
      overallStatus: "failed",
      summary: "build failed; test skipped",
    },
    releaseVerificationReport: null,
    changesetsReleaseReport: null,
  });

  assert.equal(report.overallStatus, "failed");
  assert.equal(report.actualStatus, "failed");
  assert.equal(report.effectiveStatus, "failed");
  assert.equal(report.releaseBootstrap.status, "passed");
  assert.equal(report.releasePreflight.status, "failed");
  assert.equal(report.releaseVerification.status, "skipped");
  assert.equal(report.changesetsRelease.status, "skipped");
  assert.match(report.releaseVerification.summary, /preflight did not pass/i);
  assert.match(report.changesetsRelease.summary, /preflight did not pass/i);
});

test("buildReleaseWorkflowSummaryMarkdown renders artifact names and missing inputs", () => {
  const markdown = buildReleaseWorkflowSummaryMarkdown({
    report: buildReleaseWorkflowReport({
      releaseBootstrapResult: null,
      releasePreflightResult: null,
      releaseVerificationReport: null,
      changesetsReleaseReport: createChangesetsReleaseReport(),
      assertionArtifact: {
        assertion: {
          outcome: "failed",
          actualStatus: "failed",
          allowedStatuses: ["published", "completed"],
          error: "release workflow assertion failed",
          failureDetails: ["release verification status: missing"],
        },
      },
      artifactNames: {
        releaseBootstrap: "release-bootstrap-result",
        releasePreflight: "release-preflight-result",
        releaseVerification: "release-verification-report",
        changesetsRelease: "changesets-release-report",
        assertion: "release-workflow-assertion",
        summary: "release-workflow-summary",
        report: "release-workflow-report",
      },
    }),
  });

  assert.match(markdown, /Overall status: `failed`/i);
  assert.match(markdown, /Actual status: `failed`/i);
  assert.match(markdown, /Effective status: `failed`/i);
  assert.match(markdown, /Missing inputs/i);
  assert.match(markdown, /Release bootstrap result was missing/i);
  assert.match(markdown, /Release preflight result was missing/i);
  assert.match(markdown, /Release verification report was missing/i);
  assert.match(markdown, /Release Bootstrap: `release-bootstrap-result`/i);
  assert.match(markdown, /Release Preflight: `release-preflight-result`/i);
  assert.match(markdown, /Changesets summary:/i);
  assert.match(markdown, /Final assertion/i);
  assert.match(markdown, /Outcome: `failed`/i);
  assert.match(markdown, /Release Verification: `release-verification-report`/i);
  assert.match(markdown, /## Nested evidence artifacts/i);
  assert.match(markdown, /Changesets Release Result: `changesets-release-result`/i);
  assert.match(markdown, /## Evidence files/i);
  assert.match(markdown, /Changesets Release Summary Path: `\/tmp\/changesets-release-summary\.md`/i);
  assert.match(markdown, /Changesets Release Report Path: `\/tmp\/changesets-release-report\.json`/i);
});

test("buildReleaseWorkflowSummaryMarkdown does not call skipped preflight missing", () => {
  const markdown = buildReleaseWorkflowSummaryMarkdown({
    report: buildReleaseWorkflowReport({
      releaseBootstrapResult: {
        kind: "equip-release-bootstrap-result",
        overallStatus: "failed",
        summary: "dependency install failed (exit 2)",
      },
      releasePreflightResult: null,
      releaseVerificationReport: null,
      changesetsReleaseReport: null,
    }),
  });

  assert.match(markdown, /Release bootstrap: `failed`/i);
  assert.match(markdown, /Actual status: `failed`/i);
  assert.match(markdown, /Effective status: `failed`/i);
  assert.match(markdown, /Release preflight: `skipped`/i);
  assert.match(markdown, /Release verification: `skipped`/i);
  assert.match(markdown, /Changesets release: `skipped`/i);
  assert.match(markdown, /Release preflight summary: release preflight skipped because release bootstrap did not pass/i);
  assert.match(markdown, /Release verification summary: release verification skipped because release bootstrap did not pass/i);
  assert.match(markdown, /Changesets summary: changesets release skipped because release bootstrap did not pass/i);
  assert.doesNotMatch(markdown, /Release preflight result was missing/i);
  assert.doesNotMatch(markdown, /Release verification report was missing/i);
  assert.doesNotMatch(markdown, /Changesets release report was missing/i);
});

test("workflow report and summary scripts write final rollup artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-workflow-"));
  const releaseBootstrapResultPath = path.join(root, "release-bootstrap-result.json");
  const releasePreflightResultPath = path.join(root, "release-preflight-result.json");
  const releaseVerificationReportPath = path.join(root, "release-verification-report.json");
  const changesetsReleaseReportPath = path.join(root, "changesets-release-report.json");
  const releaseWorkflowReportPath = path.join(root, "release-workflow-report.json");
  const releaseWorkflowAssertionPath = path.join(root, "release-workflow-assertion.json");
  const releaseWorkflowSummaryPath = path.join(root, "release-workflow-summary.md");

  fs.writeFileSync(
    releaseBootstrapResultPath,
    `${JSON.stringify(createReleaseBootstrapResult(), null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    releasePreflightResultPath,
    `${JSON.stringify(createReleasePreflightResult(), null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    releaseVerificationReportPath,
    `${JSON.stringify(createReleaseVerificationReport(), null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    changesetsReleaseReportPath,
    `${JSON.stringify(createChangesetsReleaseReport(), null, 2)}\n`,
    "utf8",
  );

  let result = runScript("scripts/ci/write-release-workflow-report.mjs", {
    RELEASE_BOOTSTRAP_RESULT_PATH: releaseBootstrapResultPath,
    RELEASE_PREFLIGHT_RESULT_PATH: releasePreflightResultPath,
    RELEASE_VERIFICATION_REPORT_PATH: releaseVerificationReportPath,
    CHANGESETS_RELEASE_REPORT_PATH: changesetsReleaseReportPath,
    RELEASE_WORKFLOW_REPORT_PATH: releaseWorkflowReportPath,
    RELEASE_WORKFLOW_ASSERTION_PATH: releaseWorkflowAssertionPath,
    RELEASE_WORKFLOW_SUMMARY_PATH: releaseWorkflowSummaryPath,
    RELEASE_BOOTSTRAP_RESULT_ARTIFACT_NAME: "release-bootstrap-result",
    RELEASE_PREFLIGHT_RESULT_ARTIFACT_NAME: "release-preflight-result",
    RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME: "release-verification-report",
    CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME: "changesets-release-report",
    RELEASE_WORKFLOW_ASSERTION_ARTIFACT_NAME: "release-workflow-assertion",
    RELEASE_WORKFLOW_REPORT_ARTIFACT_NAME: "release-workflow-report",
    RELEASE_WORKFLOW_SUMMARY_ARTIFACT_NAME: "release-workflow-summary",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  result = runScript("scripts/ci/assert-release-workflow-report.mjs", {
    RELEASE_WORKFLOW_REPORT_PATH: releaseWorkflowReportPath,
    RELEASE_WORKFLOW_ASSERTION_PATH: releaseWorkflowAssertionPath,
    RELEASE_WORKFLOW_ALLOWED_STATUSES: "published,completed",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  result = runScript("scripts/ci/write-release-workflow-summary.mjs", {
    RELEASE_WORKFLOW_REPORT_PATH: releaseWorkflowReportPath,
    RELEASE_WORKFLOW_SUMMARY_PATH: releaseWorkflowSummaryPath,
    RELEASE_WORKFLOW_APPEND_STEP_SUMMARY: "false",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  result = runScript("scripts/ci/write-release-workflow-report.mjs", {
    RELEASE_BOOTSTRAP_RESULT_PATH: releaseBootstrapResultPath,
    RELEASE_PREFLIGHT_RESULT_PATH: releasePreflightResultPath,
    RELEASE_VERIFICATION_REPORT_PATH: releaseVerificationReportPath,
    CHANGESETS_RELEASE_REPORT_PATH: changesetsReleaseReportPath,
    RELEASE_WORKFLOW_REPORT_PATH: releaseWorkflowReportPath,
    RELEASE_WORKFLOW_ASSERTION_PATH: releaseWorkflowAssertionPath,
    RELEASE_WORKFLOW_SUMMARY_PATH: releaseWorkflowSummaryPath,
    RELEASE_BOOTSTRAP_RESULT_ARTIFACT_NAME: "release-bootstrap-result",
    RELEASE_PREFLIGHT_RESULT_ARTIFACT_NAME: "release-preflight-result",
    RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME: "release-verification-report",
    CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME: "changesets-release-report",
    RELEASE_WORKFLOW_ASSERTION_ARTIFACT_NAME: "release-workflow-assertion",
    RELEASE_WORKFLOW_REPORT_ARTIFACT_NAME: "release-workflow-report",
    RELEASE_WORKFLOW_SUMMARY_ARTIFACT_NAME: "release-workflow-summary",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  result = runScript("scripts/ci/write-release-workflow-summary.mjs", {
    RELEASE_WORKFLOW_REPORT_PATH: releaseWorkflowReportPath,
    RELEASE_WORKFLOW_SUMMARY_PATH: releaseWorkflowSummaryPath,
    RELEASE_WORKFLOW_APPEND_STEP_SUMMARY: "false",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const report = JSON.parse(fs.readFileSync(releaseWorkflowReportPath, "utf8"));
  const assertion = JSON.parse(fs.readFileSync(releaseWorkflowAssertionPath, "utf8"));
  const summary = fs.readFileSync(releaseWorkflowSummaryPath, "utf8");
  assert.equal(report.overallStatus, "published");
  assert.equal(report.actualStatus, "published");
  assert.equal(report.effectiveStatus, "published");
  assert.equal(report.assertion.outcome, "passed");
  assert.equal(assertion.assertion.outcome, "passed");
  assert.equal(assertion.report.actualStatus, "published");
  assert.equal(assertion.report.effectiveStatus, "published");
  assert.equal(assertion.report.inputs.hasReleaseWorkflowReport, true);
  assert.equal(assertion.report.inputs.hasReleaseBootstrapResult, true);
  assert.equal(assertion.report.inputs.hasReleasePreflightResult, true);
  assert.equal(assertion.report.inputs.hasReleaseVerificationReport, true);
  assert.equal(assertion.report.inputs.hasChangesetsReleaseReport, true);
  assert.equal(assertion.report.artifactNames.report, "release-workflow-report");
  assert.equal(assertion.report.evidenceArtifactNames.releaseVerificationPackTarball, "pack-tarball");
  assert.equal(assertion.report.evidenceFiles.releaseVerificationSummaryPath, "/tmp/release-verification-summary.md");
  assert.equal(assertion.report.evidenceFiles.changesetsReleaseSummaryPath, "/tmp/changesets-release-summary.md");
  assert.equal(report.artifacts.releaseBootstrapResultPath, path.resolve(releaseBootstrapResultPath));
  assert.equal(report.artifacts.releasePreflightResultPath, path.resolve(releasePreflightResultPath));
  assert.equal(report.artifacts.releaseVerificationReportPath, path.resolve(releaseVerificationReportPath));
  assert.equal(report.artifacts.assertionPath, path.resolve(releaseWorkflowAssertionPath));
  assert.equal(report.artifactNames.releaseBootstrap, "release-bootstrap-result");
  assert.equal(report.artifactNames.releasePreflight, "release-preflight-result");
  assert.equal(report.artifactNames.report, "release-workflow-report");
  assert.equal(report.artifactNames.assertion, "release-workflow-assertion");
  assert.equal(report.evidenceArtifactNames.releaseVerificationPackTarball, "pack-tarball");
  assert.equal(report.evidenceArtifactNames.releaseVerificationAssertion, "release-verification-assertion");
  assert.equal(report.evidenceArtifactNames.changesetsReleaseSummary, "changesets-release-summary");
  assert.equal(report.evidenceFiles.releaseWorkflowReportPath, path.resolve(releaseWorkflowReportPath));
  assert.equal(report.evidenceFiles.releaseVerificationSummaryPath, "/tmp/release-verification-summary.md");
  assert.equal(report.evidenceFiles.changesetsReleaseSummaryPath, "/tmp/changesets-release-summary.md");
  assert.match(summary, /Release Workflow Summary/i);
  assert.match(summary, /Release bootstrap: `passed`/i);
  assert.match(summary, /Release preflight: `passed`/i);
  assert.match(summary, /Overall status: `published`/i);
  assert.match(summary, /Actual status: `published`/i);
  assert.match(summary, /Effective status: `published`/i);
  assert.match(summary, /Final assertion/i);
  assert.match(summary, /## Nested evidence artifacts/i);
  assert.match(summary, /Release Verification Pack Tarball: `pack-tarball`/i);
  assert.match(summary, /## Evidence files/i);
  assert.match(summary, /Release Workflow Report Path:/i);
});

test("assert-release-workflow-report writes a failure artifact before exiting nonzero", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-workflow-"));
  const releaseWorkflowReportPath = path.join(root, "release-workflow-report.json");
  const releaseWorkflowAssertionPath = path.join(root, "release-workflow-assertion.json");

  fs.writeFileSync(
    releaseWorkflowReportPath,
    `${JSON.stringify(
      buildReleaseWorkflowReport({
        releaseBootstrapResult: {
          kind: "equip-release-bootstrap-result",
          overallStatus: "failed",
          summary: "dependency install failed (exit 2)",
        },
        releasePreflightResult: {
          kind: "equip-release-preflight-result",
          overallStatus: "failed",
          summary: "build failed; test skipped",
        },
        releaseVerificationReport: {
          kind: "equip-release-verification-report",
          overallStatus: "failed",
          summary: "release verification failed",
        },
        changesetsReleaseReport: createChangesetsReleaseReport(),
      }),
      null,
      2,
    )}\n`,
    "utf8",
  );

  const result = runScript("scripts/ci/assert-release-workflow-report.mjs", {
    RELEASE_WORKFLOW_REPORT_PATH: releaseWorkflowReportPath,
    RELEASE_WORKFLOW_ASSERTION_PATH: releaseWorkflowAssertionPath,
  });

  assert.notEqual(result.status, 0);
  const assertion = JSON.parse(fs.readFileSync(releaseWorkflowAssertionPath, "utf8"));
  assert.equal(assertion.assertion.outcome, "failed");
  assert.equal(assertion.report.inputs.hasReleaseWorkflowReport, true);
  assert.equal(assertion.report.inputs.hasReleaseBootstrapResult, true);
  assert.equal(assertion.report.inputs.hasReleasePreflightResult, true);
  assert.equal(assertion.report.inputs.hasReleaseVerificationReport, true);
  assert.equal(assertion.report.inputs.hasChangesetsReleaseReport, true);
  assert.deepEqual(assertion.report.artifactNames, {});
  assert.equal(assertion.report.evidenceArtifactNames.changesetsReleaseResult, "changesets-release-result");
  assert.equal(assertion.report.evidenceArtifactNames.changesetsReleaseAssertion, "changesets-release-assertion");
  assert.equal(assertion.report.evidenceFiles.changesetsReleaseResultPath, "/tmp/changesets-release-result.json");
  assert.equal(assertion.report.evidenceFiles.changesetsReleaseReportPath, "/tmp/changesets-release-report.json");
  assert.match(assertion.assertion.failureDetails.join("\n"), /release bootstrap status: failed/i);
  assert.match(assertion.assertion.failureDetails.join("\n"), /release preflight status: failed/i);
  assert.match(assertion.assertion.failureDetails.join("\n"), /release verification status: failed/i);
  assert.match(result.stderr || result.stdout, /assertion failed/i);
});

test("assert-release-workflow-report preserves missing input state in the assertion artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-workflow-"));
  const releaseWorkflowReportPath = path.join(root, "release-workflow-report.json");
  const releaseWorkflowAssertionPath = path.join(root, "release-workflow-assertion.json");

  fs.writeFileSync(
    releaseWorkflowReportPath,
    `${JSON.stringify(
      buildReleaseWorkflowReport({
        releaseBootstrapResult: createReleaseBootstrapResult(),
        releasePreflightResult: null,
        releaseVerificationReport: null,
        changesetsReleaseReport: null,
      }),
      null,
      2,
    )}\n`,
    "utf8",
  );

  const result = runScript("scripts/ci/assert-release-workflow-report.mjs", {
    RELEASE_WORKFLOW_REPORT_PATH: releaseWorkflowReportPath,
    RELEASE_WORKFLOW_ASSERTION_PATH: releaseWorkflowAssertionPath,
  });

  assert.notEqual(result.status, 0);
  const assertion = JSON.parse(fs.readFileSync(releaseWorkflowAssertionPath, "utf8"));
  assert.equal(assertion.assertion.outcome, "failed");
  assert.equal(assertion.report.inputs.hasReleaseWorkflowReport, true);
  assert.equal(assertion.report.inputs.hasReleaseBootstrapResult, true);
  assert.equal(assertion.report.inputs.hasReleasePreflightResult, false);
  assert.equal(assertion.report.inputs.hasReleaseVerificationReport, false);
  assert.equal(assertion.report.inputs.hasChangesetsReleaseReport, false);
  assert.match(assertion.assertion.failureDetails.join("\n"), /release preflight status: missing/i);
  assert.match(assertion.assertion.failureDetails.join("\n"), /release verification status: missing/i);
  assert.match(assertion.assertion.failureDetails.join("\n"), /changesets release status: missing/i);
});

test("write-release-workflow-summary renders a truthful missing-report summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-workflow-"));
  const releaseWorkflowReportPath = path.join(root, "missing-release-workflow-report.json");
  const releaseWorkflowSummaryPath = path.join(root, "release-workflow-summary.md");

  const result = runScript("scripts/ci/write-release-workflow-summary.mjs", {
    RELEASE_WORKFLOW_REPORT_PATH: releaseWorkflowReportPath,
    RELEASE_WORKFLOW_SUMMARY_PATH: releaseWorkflowSummaryPath,
    RELEASE_WORKFLOW_APPEND_STEP_SUMMARY: "false",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = fs.readFileSync(releaseWorkflowSummaryPath, "utf8");
  assert.match(summary, /Overall status: `failed`/i);
  assert.match(summary, /## Missing inputs/i);
  assert.match(summary, /Release workflow report artifact was missing/i);
  assert.match(summary, /Release bootstrap result was missing/i);
});

test("assert-release-workflow-report writes a failure artifact when the report is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-workflow-"));
  const releaseWorkflowReportPath = path.join(root, "missing-release-workflow-report.json");
  const releaseWorkflowAssertionPath = path.join(root, "release-workflow-assertion.json");

  const result = runScript("scripts/ci/assert-release-workflow-report.mjs", {
    RELEASE_WORKFLOW_REPORT_PATH: releaseWorkflowReportPath,
    RELEASE_WORKFLOW_ASSERTION_PATH: releaseWorkflowAssertionPath,
  });

  assert.notEqual(result.status, 0);
  const assertion = JSON.parse(fs.readFileSync(releaseWorkflowAssertionPath, "utf8"));
  assert.equal(assertion.assertion.outcome, "failed");
  assert.equal(assertion.report.inputs.hasReleaseWorkflowReport, false);
  assert.equal(assertion.report.inputs.hasReleaseBootstrapResult, false);
  assert.equal(assertion.report.inputs.hasReleasePreflightResult, false);
  assert.equal(assertion.report.inputs.hasReleaseVerificationReport, false);
  assert.equal(assertion.report.inputs.hasChangesetsReleaseReport, false);
  assert.match(assertion.assertion.failureDetails.join("\n"), /release workflow report artifact not found/i);
  assert.match(result.stderr || result.stdout, /assertion failed/i);
});
