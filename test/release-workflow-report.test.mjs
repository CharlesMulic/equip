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
    artifactNames: {
      report: "release-verification-report",
      summary: "release-verification-summary",
    },
  };
}

function createChangesetsReleaseReport() {
  return {
    kind: "equip-changesets-release-report",
    status: "published",
    result: {
      summary: "changesets release step published 1 package: @cg3/equip@0.17.8",
    },
    artifactNames: {
      report: "changesets-release-report",
      summary: "changesets-release-summary",
    },
  };
}

test("buildReleaseWorkflowReport combines verification and changesets release status", () => {
  const report = buildReleaseWorkflowReport({
    releaseVerificationReport: createReleaseVerificationReport(),
    changesetsReleaseReport: createChangesetsReleaseReport(),
    artifacts: {
      releaseVerificationReportPath: "/tmp/release-verification-report.json",
      changesetsReleaseReportPath: "/tmp/changesets-release-report.json",
      summaryPath: "/tmp/release-workflow-summary.md",
      reportPath: "/tmp/release-workflow-report.json",
    },
    artifactNames: {
      releaseVerification: "release-verification-report",
      changesetsRelease: "changesets-release-report",
      summary: "release-workflow-summary",
      report: "release-workflow-report",
    },
  });

  assert.equal(report.kind, "equip-release-workflow-report");
  assert.equal(report.overallStatus, "published");
  assert.equal(report.releaseVerification.status, "passed");
  assert.equal(report.changesetsRelease.status, "published");
  assert.equal(report.artifacts.summaryPath, "/tmp/release-workflow-summary.md");
  assert.equal(report.artifactNames.summary, "release-workflow-summary");
});

test("buildReleaseWorkflowReport marks missing reports explicitly", () => {
  const report = buildReleaseWorkflowReport({
    releaseVerificationReport: null,
    changesetsReleaseReport: createChangesetsReleaseReport(),
  });

  assert.equal(report.overallStatus, "failed");
  assert.equal(report.inputs.hasReleaseVerificationReport, false);
  assert.equal(report.releaseVerification.status, "missing");
  assert.equal(report.changesetsRelease.status, "published");
});

test("buildReleaseWorkflowSummaryMarkdown renders artifact names and missing inputs", () => {
  const markdown = buildReleaseWorkflowSummaryMarkdown({
    report: buildReleaseWorkflowReport({
      releaseVerificationReport: null,
      changesetsReleaseReport: createChangesetsReleaseReport(),
      artifactNames: {
        releaseVerification: "release-verification-report",
        changesetsRelease: "changesets-release-report",
        summary: "release-workflow-summary",
        report: "release-workflow-report",
      },
    }),
  });

  assert.match(markdown, /Overall status: `failed`/i);
  assert.match(markdown, /Missing inputs/i);
  assert.match(markdown, /Release verification report was missing/i);
  assert.match(markdown, /Changesets summary:/i);
  assert.match(markdown, /Release Verification: `release-verification-report`/i);
});

test("workflow report and summary scripts write final rollup artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-workflow-"));
  const releaseVerificationReportPath = path.join(root, "release-verification-report.json");
  const changesetsReleaseReportPath = path.join(root, "changesets-release-report.json");
  const releaseWorkflowReportPath = path.join(root, "release-workflow-report.json");
  const releaseWorkflowSummaryPath = path.join(root, "release-workflow-summary.md");

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
    RELEASE_VERIFICATION_REPORT_PATH: releaseVerificationReportPath,
    CHANGESETS_RELEASE_REPORT_PATH: changesetsReleaseReportPath,
    RELEASE_WORKFLOW_REPORT_PATH: releaseWorkflowReportPath,
    RELEASE_WORKFLOW_SUMMARY_PATH: releaseWorkflowSummaryPath,
    RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME: "release-verification-report",
    CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME: "changesets-release-report",
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
  const summary = fs.readFileSync(releaseWorkflowSummaryPath, "utf8");
  assert.equal(report.overallStatus, "published");
  assert.equal(report.artifacts.releaseVerificationReportPath, path.resolve(releaseVerificationReportPath));
  assert.equal(report.artifactNames.report, "release-workflow-report");
  assert.match(summary, /Release Workflow Summary/i);
  assert.match(summary, /Overall status: `published`/i);
  assert.match(summary, /Release workflow summary/i);
});
