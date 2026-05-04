import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildChangesetsReleaseResult,
  buildChangesetsReleaseReport,
  buildChangesetsReleaseSummaryMarkdown,
  writeChangesetsReleaseAssertionArtifact,
} from "../scripts/ci/changesets-release-result-lib.mjs";

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

test("buildChangesetsReleaseResult captures published packages from changesets outputs", () => {
  const result = buildChangesetsReleaseResult({
    stepOutcome: "success",
    published: "true",
    publishedPackages: JSON.stringify([
      { name: "@cg3/equip", version: "0.17.8" },
    ]),
    artifacts: {
      resultPath: "/tmp/changesets-release-result.json",
      releaseVerificationReportPath: "/tmp/release-verification-report.json",
    },
    artifactNames: {
      result: "changesets-release-result",
      releaseVerification: "release-verification-report",
    },
    workflowContext: createWorkflowContext(),
  });

  assert.equal(result.kind, "equip-changesets-release-result");
  assert.equal(result.stepOutcome, "success");
  assert.equal(result.status, "published");
  assert.equal(result.published, true);
  assert.equal(result.inputs.hasReleaseVerificationReport, false);
  assert.equal(result.artifacts.resultPath, "/tmp/changesets-release-result.json");
  assert.equal(
    result.artifacts.releaseVerificationReportPath,
    "/tmp/release-verification-report.json",
  );
  assert.equal(result.evidenceFileNames.resultPath, "changesets-release-result.json");
  assert.equal(
    result.evidenceFileNames.releaseVerificationReportPath,
    "release-verification-report.json",
  );
  assert.equal(result.artifactNames.result, "changesets-release-result");
  assert.equal(result.artifactNames.releaseVerification, "release-verification-report");
  assert.equal(result.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(
    result.workflowContext.runUrl,
    "https://github.com/CharlesMulic/equip/actions/runs/1234567890",
  );
  assert.equal(result.publishedPackages.length, 1);
  assert.equal(result.publishedPackages[0].name, "@cg3/equip");
  assert.match(result.summary, /published 1 package/i);
});

test("buildChangesetsReleaseResult marks skipped runs explicitly when verification blocked publish", () => {
  const result = buildChangesetsReleaseResult({
    stepOutcome: "skipped",
    published: "false",
    publishedPackages: "[]",
    releaseVerificationReport: {
      overallStatus: "failed",
      summary: "release verification failed",
    },
  });

  assert.equal(result.stepOutcome, "skipped");
  assert.equal(result.status, "skipped");
  assert.equal(result.published, false);
  assert.equal(result.inputs.hasReleaseVerificationReport, true);
  assert.equal(result.prerequisites.releaseVerificationStatus, "failed");
  assert.match(result.summary, /skipped because release verification was failed/i);
  assert.equal(result.skipReason, result.summary);
});

test("buildChangesetsReleaseResult marks missing artifacts explicitly", () => {
  const result = buildChangesetsReleaseResult({
    stepOutcome: "missing",
    published: false,
    publishedPackages: [],
  });

  assert.equal(result.stepOutcome, "missing");
  assert.equal(result.status, "missing");
  assert.equal(result.published, false);
  assert.match(result.summary, /result artifact missing/i);
});

test("write-changesets-release-result writes an artifact and appends summary output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "changesets-release-result.json");

  const result = runScript("scripts/ci/write-changesets-release-result.mjs", {
    CHANGESETS_RELEASE_RESULT_PATH: resultPath,
    CHANGESETS_STEP_OUTCOME: "success",
    CHANGESETS_PUBLISHED: "true",
    CHANGESETS_PUBLISHED_PACKAGES: JSON.stringify([
      { name: "@cg3/equip", version: "0.17.8" },
    ]),
    CHANGESETS_RELEASE_RESULT_ARTIFACT_NAME: "changesets-release-result",
    RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME: "release-verification-report",
    ...createWorkflowEnv(),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const artifact = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(artifact.status, "published");
  assert.equal(artifact.inputs.hasReleaseVerificationReport, false);
  assert.equal(artifact.artifacts.resultPath, path.resolve(resultPath));
  assert.equal(artifact.artifacts.releaseVerificationReportPath, "");
  assert.equal(artifact.evidenceFileNames.resultPath, "changesets-release-result.json");
  assert.equal(artifact.artifactNames.result, "changesets-release-result");
  assert.equal(artifact.artifactNames.releaseVerification, "release-verification-report");
  assert.equal(artifact.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(artifact.publishedPackages[0].version, "0.17.8");
});

test("write-changesets-release-result records verification-blocked skips", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "changesets-release-result.json");
  const verificationReportPath = path.join(root, "release-verification-report.json");

  fs.writeFileSync(
    verificationReportPath,
    `${JSON.stringify({
      kind: "equip-release-verification-report",
      overallStatus: "failed",
      summary: "release verification failed",
    }, null, 2)}\n`,
    "utf8",
  );

  const result = runScript("scripts/ci/write-changesets-release-result.mjs", {
    CHANGESETS_RELEASE_RESULT_PATH: resultPath,
    CHANGESETS_STEP_OUTCOME: "skipped",
    CHANGESETS_PUBLISHED: "false",
    CHANGESETS_PUBLISHED_PACKAGES: "[]",
    RELEASE_VERIFICATION_REPORT_PATH: verificationReportPath,
    CHANGESETS_RELEASE_RESULT_ARTIFACT_NAME: "changesets-release-result",
    RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME: "release-verification-report",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const artifact = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(artifact.status, "skipped");
  assert.equal(artifact.inputs.hasReleaseVerificationReport, true);
  assert.equal(artifact.artifacts.resultPath, path.resolve(resultPath));
  assert.equal(
    artifact.artifacts.releaseVerificationReportPath,
    path.resolve(verificationReportPath),
  );
  assert.equal(artifact.evidenceFileNames.resultPath, "changesets-release-result.json");
  assert.equal(
    artifact.evidenceFileNames.releaseVerificationReportPath,
    "release-verification-report.json",
  );
  assert.equal(artifact.artifactNames.result, "changesets-release-result");
  assert.equal(artifact.artifactNames.releaseVerification, "release-verification-report");
  assert.equal(artifact.prerequisites.releaseVerificationStatus, "failed");
  assert.match(artifact.summary, /skipped because release verification was failed/i);
});

test("buildChangesetsReleaseSummaryMarkdown renders published packages cleanly", () => {
  const markdown = buildChangesetsReleaseSummaryMarkdown({
    result: buildChangesetsReleaseResult({
      stepOutcome: "success",
      published: "true",
      publishedPackages: JSON.stringify([
        { name: "@cg3/equip", version: "0.17.8" },
      ]),
      artifacts: {
        resultPath: "/tmp/changesets-release-result.json",
      },
      workflowContext: createWorkflowContext(),
    }),
    artifactNames: {
      result: "changesets-release-result",
      summary: "changesets-release-summary",
    },
  });

  assert.match(markdown, /## Changesets release result/i);
  assert.match(markdown, /Outcome: `success`/i);
  assert.match(markdown, /@cg3\/equip/);
  assert.match(markdown, /0\.17\.8/);
  assert.match(markdown, /## GitHub workflow context/i);
  assert.match(markdown, /Repository: `CharlesMulic\/equip`/i);
  assert.match(markdown, /## Evidence artifacts/i);
  assert.match(markdown, /Result: `changesets-release-result`/i);
  assert.match(markdown, /Summary: `changesets-release-summary`/i);
  assert.match(markdown, /## Evidence file names/i);
  assert.match(markdown, /Result Path: `changesets-release-result\.json`/i);
});

test("buildChangesetsReleaseSummaryMarkdown includes final assertion details when present", () => {
  const markdown = buildChangesetsReleaseSummaryMarkdown({
    result: buildChangesetsReleaseResult({
      stepOutcome: "success",
      published: "false",
      publishedPackages: "[]",
    }),
    assertionArtifact: {
      kind: "equip-changesets-release-assertion",
      result: {
        status: "completed",
      },
      assertion: {
        outcome: "passed",
        status: "completed",
        published: false,
      },
    },
  });

  assert.match(markdown, /## Final assertion/i);
  assert.match(markdown, /Outcome: `passed`/i);
  assert.match(markdown, /Status: `completed`/i);
});

test("buildChangesetsReleaseSummaryMarkdown includes skipped-release detail cleanly", () => {
  const markdown = buildChangesetsReleaseSummaryMarkdown({
    result: buildChangesetsReleaseResult({
      stepOutcome: "skipped",
      published: "false",
      publishedPackages: "[]",
      releaseVerificationReport: {
        overallStatus: "failed",
        summary: "release verification failed",
      },
    }),
  });

  assert.match(markdown, /Outcome: `skipped`/i);
  assert.match(markdown, /Status: `skipped`/i);
  assert.match(markdown, /skipped because release verification was failed/i);
});

test("buildChangesetsReleaseReport combines result, assertion, and artifact paths", () => {
  const result = buildChangesetsReleaseResult({
    stepOutcome: "success",
    published: "true",
    publishedPackages: JSON.stringify([
      { name: "@cg3/equip", version: "0.17.8" },
    ]),
  });

  const report = buildChangesetsReleaseReport({
    result,
    assertionArtifact: {
      kind: "equip-changesets-release-assertion",
      result: {
        status: "published",
      },
      assertion: {
        outcome: "passed",
        status: "published",
        published: true,
        publishedPackages: [
          { name: "@cg3/equip", version: "0.17.8" },
        ],
      },
    },
    artifacts: {
      resultPath: "/tmp/changesets-release-result.json",
      assertionPath: "/tmp/changesets-release-assertion.json",
      summaryPath: "/tmp/changesets-release-summary.md",
      reportPath: "/tmp/changesets-release-report.json",
    },
    artifactNames: {
      result: "changesets-release-result",
      assertion: "changesets-release-assertion",
      summary: "changesets-release-summary",
      report: "changesets-release-report",
    },
  });

  assert.equal(report.kind, "equip-changesets-release-report");
  assert.equal(report.status, "published");
  assert.equal(report.effectiveStatus, "published");
  assert.equal(report.inputs.hasResultArtifact, true);
  assert.equal(report.inputs.hasAssertionArtifact, true);
  assert.equal(report.inputs.hasReleaseVerificationReport, false);
  assert.equal(report.result.status, "published");
  assert.equal(report.result.inputs.hasReleaseVerificationReport, false);
  assert.equal(report.result.publishedPackages[0].name, "@cg3/equip");
  assert.equal(report.assertion.outcome, "passed");
  assert.equal(report.assertion.publishedPackages[0].version, "0.17.8");
  assert.equal(report.artifacts.summaryPath, "/tmp/changesets-release-summary.md");
  assert.equal(report.evidenceFileNames.resultPath, "changesets-release-result.json");
  assert.equal(report.evidenceFileNames.assertionPath, "changesets-release-assertion.json");
  assert.equal(report.evidenceFileNames.summaryPath, "changesets-release-summary.md");
  assert.equal(report.evidenceFileNames.reportPath, "changesets-release-report.json");
  assert.equal(report.artifactNames.result, "changesets-release-result");
  assert.equal(report.artifactNames.report, "changesets-release-report");
});

test("buildChangesetsReleaseReport preserves skipped lane status when assertion fails upstream", () => {
  const result = buildChangesetsReleaseResult({
    stepOutcome: "skipped",
    status: "skipped",
    summary: "changesets release step skipped because release verification was failed",
    skipReason: "changesets release step skipped because release verification was failed",
    prerequisites: {
      releaseVerificationStatus: "failed",
    },
  });

  const report = buildChangesetsReleaseReport({
    result,
    assertionArtifact: {
      kind: "equip-changesets-release-assertion",
      result: {
        status: "skipped",
      },
      assertion: {
        outcome: "failed",
        status: "skipped",
        published: false,
        error: "Changesets release step finished with outcome 'skipped'. changesets release step skipped because release verification was failed",
        publishedPackages: [],
      },
    },
  });

  assert.equal(report.status, "skipped");
  assert.equal(report.effectiveStatus, "failed");
  assert.equal(report.inputs.hasResultArtifact, true);
  assert.equal(report.inputs.hasAssertionArtifact, true);
  assert.equal(report.result.status, "skipped");
  assert.equal(report.result.inputs.hasReleaseVerificationReport, false);
  assert.equal(report.assertion.outcome, "failed");
  assert.equal(report.assertion.status, "skipped");
});

test("write-changesets-release-summary writes a markdown artifact and appends summary output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "changesets-release-result.json");
  const assertionPath = path.join(root, "changesets-release-assertion.json");
  const summaryPath = path.join(root, "changesets-release-summary.md");
  const stepSummaryPath = path.join(root, "step-summary.md");

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(buildChangesetsReleaseResult({
    stepOutcome: "success",
    published: "true",
    publishedPackages: JSON.stringify([
      { name: "@cg3/equip", version: "0.17.8" },
    ]),
    artifacts: {
      resultPath,
    },
  }), null, 2)}\n`, "utf8");
  fs.writeFileSync(assertionPath, `${JSON.stringify({
    kind: "equip-changesets-release-assertion",
    result: {
      stepOutcome: "success",
      status: "published",
      published: true,
      summary: "changesets release step published 1 package: @cg3/equip@0.17.8",
      publishedPackages: [
        { name: "@cg3/equip", version: "0.17.8" },
      ],
    },
    assertion: {
      outcome: "passed",
      status: "published",
      published: true,
      publishedPackages: [
        { name: "@cg3/equip", version: "0.17.8" },
      ],
    },
  }, null, 2)}\n`, "utf8");

  const result = runScript("scripts/ci/write-changesets-release-summary.mjs", {
    CHANGESETS_RELEASE_RESULT_PATH: resultPath,
    CHANGESETS_RELEASE_ASSERTION_PATH: assertionPath,
    CHANGESETS_RELEASE_SUMMARY_PATH: summaryPath,
    CHANGESETS_RELEASE_RESULT_ARTIFACT_NAME: "changesets-release-result",
    CHANGESETS_RELEASE_ASSERTION_ARTIFACT_NAME: "changesets-release-assertion",
    CHANGESETS_RELEASE_SUMMARY_ARTIFACT_NAME: "changesets-release-summary",
    CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME: "changesets-release-report",
    GITHUB_STEP_SUMMARY: stepSummaryPath,
    ...createWorkflowEnv(),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summaryArtifact = fs.readFileSync(summaryPath, "utf8");
  const stepSummary = fs.readFileSync(stepSummaryPath, "utf8");
  assert.match(summaryArtifact, /## Changesets release result/i);
  assert.match(summaryArtifact, /@cg3\/equip/);
  assert.match(summaryArtifact, /## GitHub workflow context/i);
  assert.match(summaryArtifact, /Run URL: `https:\/\/github\.com\/CharlesMulic\/equip\/actions\/runs\/1234567890`/i);
  assert.match(summaryArtifact, /## Final assertion/i);
  assert.match(summaryArtifact, /## Evidence artifacts/i);
  assert.match(summaryArtifact, /## Evidence file names/i);
  assert.match(summaryArtifact, /Result Path: `changesets-release-result\.json`/i);
  assert.match(summaryArtifact, /Report: `changesets-release-report`/i);
  assert.match(summaryArtifact, /Outcome: `passed`/i);
  assert.match(stepSummary, /## Changesets release result/i);
  assert.match(stepSummary, /## Final assertion/i);
  assert.match(stepSummary, /Assertion: `changesets-release-assertion`/i);
});

test("write-changesets-release-summary can suppress GitHub step summary output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "changesets-release-result.json");
  const assertionPath = path.join(root, "changesets-release-assertion.json");
  const summaryPath = path.join(root, "changesets-release-summary.md");
  const stepSummaryPath = path.join(root, "step-summary.md");

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(buildChangesetsReleaseResult({
    stepOutcome: "success",
    published: "false",
    publishedPackages: "[]",
  }), null, 2)}\n`, "utf8");
  fs.writeFileSync(assertionPath, `${JSON.stringify({
    kind: "equip-changesets-release-assertion",
    result: {
      stepOutcome: "success",
      status: "completed",
      published: false,
      summary: "changesets release step completed without publishing packages",
      publishedPackages: [],
    },
    assertion: {
      outcome: "passed",
      status: "completed",
      published: false,
      publishedPackages: [],
    },
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(stepSummaryPath, "preexisting step summary\n", "utf8");

  const result = runScript("scripts/ci/write-changesets-release-summary.mjs", {
    CHANGESETS_RELEASE_RESULT_PATH: resultPath,
    CHANGESETS_RELEASE_ASSERTION_PATH: assertionPath,
    CHANGESETS_RELEASE_SUMMARY_PATH: summaryPath,
    CHANGESETS_RELEASE_APPEND_STEP_SUMMARY: "false",
    GITHUB_STEP_SUMMARY: stepSummaryPath,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summaryArtifact = fs.readFileSync(summaryPath, "utf8");
  const stepSummary = fs.readFileSync(stepSummaryPath, "utf8");
  assert.match(summaryArtifact, /## Changesets release result/i);
  assert.match(summaryArtifact, /## Final assertion/i);
  assert.equal(stepSummary, "preexisting step summary\n");
});

test("write-changesets-release-report writes a machine-readable rollup artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "changesets-release-result.json");
  const assertionPath = path.join(root, "changesets-release-assertion.json");
  const summaryPath = path.join(root, "changesets-release-summary.md");
  const reportPath = path.join(root, "changesets-release-report.json");

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(buildChangesetsReleaseResult({
    stepOutcome: "success",
    published: "true",
    publishedPackages: JSON.stringify([
      { name: "@cg3/equip", version: "0.17.8" },
    ]),
  }), null, 2)}\n`, "utf8");
  fs.writeFileSync(assertionPath, `${JSON.stringify({
    kind: "equip-changesets-release-assertion",
    result: {
      stepOutcome: "success",
      status: "published",
      published: true,
      summary: "changesets release step published 1 package: @cg3/equip@0.17.8",
      publishedPackages: [
        { name: "@cg3/equip", version: "0.17.8" },
      ],
    },
    assertion: {
      outcome: "passed",
      status: "published",
      published: true,
      publishedPackages: [
        { name: "@cg3/equip", version: "0.17.8" },
      ],
    },
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(summaryPath, "## Changesets release result\n", "utf8");

  const result = runScript("scripts/ci/write-changesets-release-report.mjs", {
    CHANGESETS_RELEASE_RESULT_PATH: resultPath,
    CHANGESETS_RELEASE_ASSERTION_PATH: assertionPath,
    CHANGESETS_RELEASE_SUMMARY_PATH: summaryPath,
    CHANGESETS_RELEASE_REPORT_PATH: reportPath,
    CHANGESETS_RELEASE_RESULT_ARTIFACT_NAME: "changesets-release-result",
    CHANGESETS_RELEASE_ASSERTION_ARTIFACT_NAME: "changesets-release-assertion",
    CHANGESETS_RELEASE_SUMMARY_ARTIFACT_NAME: "changesets-release-summary",
    CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME: "changesets-release-report",
    ...createWorkflowEnv(),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.status, "published");
  assert.equal(report.effectiveStatus, "published");
  assert.equal(report.result.summary, "changesets release step published 1 package: @cg3/equip@0.17.8");
  assert.equal(report.assertion.outcome, "passed");
  assert.equal(report.artifacts.resultPath, path.resolve(resultPath));
  assert.equal(report.artifacts.assertionPath, path.resolve(assertionPath));
  assert.equal(report.artifacts.summaryPath, path.resolve(summaryPath));
  assert.equal(report.artifacts.reportPath, path.resolve(reportPath));
  assert.equal(report.artifactNames.result, "changesets-release-result");
  assert.equal(report.artifactNames.assertion, "changesets-release-assertion");
  assert.equal(report.artifactNames.summary, "changesets-release-summary");
  assert.equal(report.artifactNames.report, "changesets-release-report");
  assert.equal(report.evidenceFileNames.resultPath, "changesets-release-result.json");
  assert.equal(report.evidenceFileNames.assertionPath, "changesets-release-assertion.json");
  assert.equal(report.evidenceFileNames.summaryPath, "changesets-release-summary.md");
  assert.equal(report.evidenceFileNames.reportPath, "changesets-release-report.json");
  assert.equal(report.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(
    report.workflowContext.commitUrl,
    "https://github.com/CharlesMulic/equip/commit/abcdef1234567890",
  );
});

test("assert-changesets-release-result fails when the changesets action failed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "changesets-release-result.json");
  const assertionPath = path.join(root, "changesets-release-assertion.json");

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify({
    kind: "equip-changesets-release-result",
    stepOutcome: "failure",
    status: "failed",
    published: false,
    publishedPackages: [],
    summary: "changesets release step failed; inspect workflow logs for the underlying error",
  }, null, 2)}\n`, "utf8");

  const result = runScript("scripts/ci/assert-changesets-release-result.mjs", {
    CHANGESETS_RELEASE_RESULT_PATH: resultPath,
    CHANGESETS_RELEASE_ASSERTION_PATH: assertionPath,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr || result.stdout, /outcome 'failure'/i);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  assert.equal(assertion.assertion.outcome, "failed");
  assert.match(assertion.assertion.error, /outcome 'failure'/i);
});

test("assert-changesets-release-result reports skipped runs with the upstream gate reason", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "changesets-release-result.json");
  const assertionPath = path.join(root, "changesets-release-assertion.json");

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify({
    kind: "equip-changesets-release-result",
    stepOutcome: "skipped",
    status: "skipped",
    published: false,
    publishedPackages: [],
    summary: "changesets release step skipped because release verification was failed",
    skipReason: "changesets release step skipped because release verification was failed",
    prerequisites: {
      releaseVerificationStatus: "failed",
    },
  }, null, 2)}\n`, "utf8");

  const result = runScript("scripts/ci/assert-changesets-release-result.mjs", {
    CHANGESETS_RELEASE_RESULT_PATH: resultPath,
    CHANGESETS_RELEASE_ASSERTION_PATH: assertionPath,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr || result.stdout, /outcome 'skipped'/i);
  assert.match(result.stderr || result.stdout, /release verification was failed/i);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  assert.equal(assertion.assertion.outcome, "failed");
  assert.equal(assertion.assertion.status, "skipped");
  assert.match(assertion.assertion.error, /release verification was failed/i);
});

test("writeChangesetsReleaseAssertionArtifact writes a machine-readable verdict", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const assertionPath = path.join(root, "changesets-release-assertion.json");
  const summaryPath = path.join(root, "changesets-release-summary.md");
  const reportPath = path.join(root, "changesets-release-report.json");

  const artifact = writeChangesetsReleaseAssertionArtifact({
    result: buildChangesetsReleaseResult({
      stepOutcome: "success",
      published: "false",
      publishedPackages: "[]",
    }),
    artifacts: {
      resultPath: "/tmp/changesets-release-result.json",
      assertionPath: "/tmp/changesets-release-assertion.json",
      summaryPath,
      reportPath,
    },
    artifactNames: {
      result: "changesets-release-result",
      assertion: "changesets-release-assertion",
      summary: "changesets-release-summary",
      report: "changesets-release-report",
    },
    assertion: {
      outcome: "passed",
      resultPath: "/tmp/changesets-release-result.json",
      assertionPath: "/tmp/changesets-release-assertion.json",
      status: "completed",
      published: false,
      publishedPackages: [],
    },
    outPath: assertionPath,
  });

  assert.equal(artifact.kind, "equip-changesets-release-assertion");
  assert.equal(artifact.status, "completed");
  assert.equal(artifact.effectiveStatus, "completed");
  assert.equal(artifact.inputs.hasResultArtifact, true);
  assert.equal(artifact.inputs.hasAssertionArtifact, false);
  assert.equal(artifact.result.inputs.hasReleaseVerificationReport, false);
  assert.equal(artifact.artifacts.summaryPath, summaryPath);
  assert.equal(artifact.evidenceFileNames.resultPath, "changesets-release-result.json");
  assert.equal(artifact.evidenceFileNames.assertionPath, "changesets-release-assertion.json");
  assert.equal(artifact.evidenceFileNames.summaryPath, "changesets-release-summary.md");
  assert.equal(artifact.evidenceFileNames.reportPath, "changesets-release-report.json");
  assert.equal(artifact.artifactNames.report, "changesets-release-report");
  const persisted = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  assert.equal(persisted.assertion.outcome, "passed");
  assert.equal(persisted.result.status, "completed");
  assert.equal(persisted.effectiveStatus, "completed");
  assert.equal(persisted.evidenceFileNames.resultPath, "changesets-release-result.json");
  assert.equal(persisted.artifactNames.summary, "changesets-release-summary");
});

test("assert-changesets-release-result writes a passing assertion artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "changesets-release-result.json");
  const assertionPath = path.join(root, "changesets-release-assertion.json");
  const summaryPath = path.join(root, "changesets-release-summary.md");
  const reportPath = path.join(root, "changesets-release-report.json");

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(buildChangesetsReleaseResult({
    stepOutcome: "success",
    published: "true",
    publishedPackages: JSON.stringify([
      { name: "@cg3/equip", version: "0.17.8" },
    ]),
  }), null, 2)}\n`, "utf8");

  const result = runScript("scripts/ci/assert-changesets-release-result.mjs", {
    CHANGESETS_RELEASE_RESULT_PATH: resultPath,
    CHANGESETS_RELEASE_ASSERTION_PATH: assertionPath,
    CHANGESETS_RELEASE_SUMMARY_PATH: summaryPath,
    CHANGESETS_RELEASE_REPORT_PATH: reportPath,
    CHANGESETS_RELEASE_RESULT_ARTIFACT_NAME: "changesets-release-result",
    CHANGESETS_RELEASE_ASSERTION_ARTIFACT_NAME: "changesets-release-assertion",
    CHANGESETS_RELEASE_SUMMARY_ARTIFACT_NAME: "changesets-release-summary",
    CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME: "changesets-release-report",
    ...createWorkflowEnv(),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  assert.equal(assertion.assertion.outcome, "passed");
  assert.equal(assertion.status, "published");
  assert.equal(assertion.effectiveStatus, "published");
  assert.equal(assertion.inputs.hasResultArtifact, true);
  assert.equal(assertion.inputs.hasAssertionArtifact, false);
  assert.equal(assertion.result.inputs.hasReleaseVerificationReport, false);
  assert.equal(assertion.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(
    assertion.workflowContext.runUrl,
    "https://github.com/CharlesMulic/equip/actions/runs/1234567890",
  );
  assert.equal(assertion.assertion.published, true);
  assert.equal(assertion.assertion.publishedPackages[0].name, "@cg3/equip");
  assert.equal(assertion.artifacts.summaryPath, path.resolve(summaryPath));
  assert.equal(assertion.evidenceFileNames.resultPath, "changesets-release-result.json");
  assert.equal(assertion.evidenceFileNames.assertionPath, "changesets-release-assertion.json");
  assert.equal(assertion.evidenceFileNames.summaryPath, "changesets-release-summary.md");
  assert.equal(assertion.evidenceFileNames.reportPath, "changesets-release-report.json");
  assert.equal(assertion.artifactNames.report, "changesets-release-report");
});

test("assert-changesets-release-result preserves self-contained evidence pointers when it fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "changesets-release-result.json");
  const assertionPath = path.join(root, "changesets-release-assertion.json");
  const summaryPath = path.join(root, "changesets-release-summary.md");
  const reportPath = path.join(root, "changesets-release-report.json");

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify({
    kind: "equip-changesets-release-result",
    stepOutcome: "failure",
    status: "failed",
    published: false,
    publishedPackages: [],
    summary: "changesets release step failed; inspect workflow logs for the underlying error",
  }, null, 2)}\n`, "utf8");

  const result = runScript("scripts/ci/assert-changesets-release-result.mjs", {
    CHANGESETS_RELEASE_RESULT_PATH: resultPath,
    CHANGESETS_RELEASE_ASSERTION_PATH: assertionPath,
    CHANGESETS_RELEASE_SUMMARY_PATH: summaryPath,
    CHANGESETS_RELEASE_REPORT_PATH: reportPath,
    CHANGESETS_RELEASE_RESULT_ARTIFACT_NAME: "changesets-release-result",
    CHANGESETS_RELEASE_ASSERTION_ARTIFACT_NAME: "changesets-release-assertion",
    CHANGESETS_RELEASE_SUMMARY_ARTIFACT_NAME: "changesets-release-summary",
    CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME: "changesets-release-report",
    ...createWorkflowEnv(),
  });

  assert.notEqual(result.status, 0);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  assert.equal(assertion.assertion.outcome, "failed");
  assert.equal(assertion.status, "failed");
  assert.equal(assertion.effectiveStatus, "failed");
  assert.equal(assertion.inputs.hasResultArtifact, true);
  assert.equal(assertion.inputs.hasAssertionArtifact, false);
  assert.equal(assertion.result.inputs.hasReleaseVerificationReport, false);
  assert.equal(assertion.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(assertion.artifacts.reportPath, path.resolve(reportPath));
  assert.equal(assertion.evidenceFileNames.resultPath, "changesets-release-result.json");
  assert.equal(assertion.evidenceFileNames.assertionPath, "changesets-release-assertion.json");
  assert.equal(assertion.evidenceFileNames.summaryPath, "changesets-release-summary.md");
  assert.equal(assertion.evidenceFileNames.reportPath, "changesets-release-report.json");
  assert.equal(assertion.artifactNames.summary, "changesets-release-summary");
});

test("changesets release artifacts preserve verification input presence when provided", () => {
  const result = buildChangesetsReleaseResult({
    stepOutcome: "skipped",
    published: "false",
    publishedPackages: "[]",
    releaseVerificationReport: {
      overallStatus: "failed",
      summary: "release verification failed",
    },
  });

  const report = buildChangesetsReleaseReport({
    result,
    assertionArtifact: {
      kind: "equip-changesets-release-assertion",
      result: {
        status: "skipped",
      },
      assertion: {
        outcome: "failed",
        status: "skipped",
        published: false,
        error: "Changesets release step finished with outcome 'skipped'. changesets release step skipped because release verification was failed",
        publishedPackages: [],
      },
    },
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const assertionPath = path.join(root, "changesets-release-assertion.json");

  const assertion = writeChangesetsReleaseAssertionArtifact({
    result,
    artifacts: {
      resultPath: "/tmp/changesets-release-result.json",
      assertionPath,
      summaryPath: "/tmp/changesets-release-summary.md",
      reportPath: "/tmp/changesets-release-report.json",
    },
    artifactNames: {
      result: "changesets-release-result",
      assertion: "changesets-release-assertion",
      summary: "changesets-release-summary",
      report: "changesets-release-report",
    },
    assertion: {
      outcome: "failed",
      resultPath: "/tmp/changesets-release-result.json",
      assertionPath,
      status: "skipped",
      published: false,
      publishedPackages: [],
      error: "Changesets release step finished with outcome 'skipped'. changesets release step skipped because release verification was failed",
    },
    outPath: assertionPath,
  });

  assert.equal(report.result.inputs.hasReleaseVerificationReport, true);
  assert.equal(assertion.result.inputs.hasReleaseVerificationReport, true);
});

test("assert-changesets-release-result writes a failure artifact when the result artifact is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "missing-changesets-release-result.json");
  const assertionPath = path.join(root, "changesets-release-assertion.json");
  const summaryPath = path.join(root, "changesets-release-summary.md");
  const reportPath = path.join(root, "changesets-release-report.json");
  const releaseVerificationReportPath = path.join(root, "release-verification-report.json");

  fs.writeFileSync(
    releaseVerificationReportPath,
    `${JSON.stringify({
      kind: "equip-release-verification-report",
      overallStatus: "passed",
      summary: "release verification passed",
    }, null, 2)}\n`,
    "utf8",
  );

  const result = runScript("scripts/ci/assert-changesets-release-result.mjs", {
    CHANGESETS_RELEASE_RESULT_PATH: resultPath,
    CHANGESETS_RELEASE_ASSERTION_PATH: assertionPath,
    CHANGESETS_RELEASE_SUMMARY_PATH: summaryPath,
    CHANGESETS_RELEASE_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_REPORT_PATH: releaseVerificationReportPath,
    CHANGESETS_RELEASE_RESULT_ARTIFACT_NAME: "changesets-release-result",
    CHANGESETS_RELEASE_ASSERTION_ARTIFACT_NAME: "changesets-release-assertion",
    CHANGESETS_RELEASE_SUMMARY_ARTIFACT_NAME: "changesets-release-summary",
    CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME: "changesets-release-report",
    RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME: "release-verification-report",
    ...createWorkflowEnv(),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr || result.stdout, /result artifact not found/i);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  assert.equal(assertion.assertion.outcome, "failed");
  assert.equal(assertion.status, "missing");
  assert.equal(assertion.effectiveStatus, "failed");
  assert.equal(assertion.inputs.hasResultArtifact, false);
  assert.equal(assertion.inputs.hasAssertionArtifact, false);
  assert.equal(assertion.inputs.hasReleaseVerificationReport, true);
  assert.equal(assertion.result.stepOutcome, "missing");
  assert.equal(assertion.result.inputs.hasReleaseVerificationReport, true);
  assert.equal(assertion.result.prerequisites.releaseVerificationStatus, "passed");
  assert.equal(assertion.workflowContext.repository, "CharlesMulic/equip");
  assert.equal(assertion.result.artifacts.resultPath, path.resolve(resultPath));
  assert.equal(assertion.result.artifacts.assertionPath, path.resolve(assertionPath));
  assert.equal(assertion.result.artifacts.summaryPath, path.resolve(summaryPath));
  assert.equal(assertion.result.artifacts.reportPath, path.resolve(reportPath));
  assert.equal(
    assertion.result.artifacts.releaseVerificationReportPath,
    path.resolve(releaseVerificationReportPath),
  );
  assert.equal(assertion.evidenceFileNames.resultPath, "missing-changesets-release-result.json");
  assert.equal(assertion.evidenceFileNames.assertionPath, "changesets-release-assertion.json");
  assert.equal(assertion.evidenceFileNames.summaryPath, "changesets-release-summary.md");
  assert.equal(assertion.evidenceFileNames.reportPath, "changesets-release-report.json");
  assert.equal(
    assertion.evidenceFileNames.releaseVerificationReportPath,
    "release-verification-report.json",
  );
  assert.equal(assertion.artifactNames.result, "changesets-release-result");
  assert.equal(assertion.artifactNames.assertion, "changesets-release-assertion");
  assert.equal(assertion.artifactNames.summary, "changesets-release-summary");
  assert.equal(assertion.artifactNames.report, "changesets-release-report");
  assert.equal(assertion.artifactNames.releaseVerification, "release-verification-report");
  assert.match(assertion.assertion.error, /result artifact not found/i);
});

test("write-changesets-release-summary and report still render when the result artifact is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "missing-changesets-release-result.json");
  const assertionPath = path.join(root, "changesets-release-assertion.json");
  const summaryPath = path.join(root, "changesets-release-summary.md");
  const reportPath = path.join(root, "changesets-release-report.json");
  const releaseVerificationReportPath = path.join(root, "release-verification-report.json");

  fs.writeFileSync(
    releaseVerificationReportPath,
    `${JSON.stringify({
      kind: "equip-release-verification-report",
      overallStatus: "passed",
      summary: "release verification passed",
    }, null, 2)}\n`,
    "utf8",
  );

  fs.writeFileSync(
    assertionPath,
    `${JSON.stringify({
      kind: "equip-changesets-release-assertion",
      status: "missing",
      effectiveStatus: "failed",
      assertion: {
        outcome: "failed",
        status: "missing",
        published: false,
        error: "Changesets release result artifact not found",
        publishedPackages: [],
      },
    }, null, 2)}\n`,
    "utf8",
  );

  const summaryResult = runScript("scripts/ci/write-changesets-release-summary.mjs", {
    CHANGESETS_RELEASE_RESULT_PATH: resultPath,
    CHANGESETS_RELEASE_ASSERTION_PATH: assertionPath,
    CHANGESETS_RELEASE_SUMMARY_PATH: summaryPath,
    CHANGESETS_RELEASE_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_REPORT_PATH: releaseVerificationReportPath,
    CHANGESETS_RELEASE_RESULT_ARTIFACT_NAME: "changesets-release-result",
    CHANGESETS_RELEASE_ASSERTION_ARTIFACT_NAME: "changesets-release-assertion",
    CHANGESETS_RELEASE_SUMMARY_ARTIFACT_NAME: "changesets-release-summary",
    CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME: "changesets-release-report",
    RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME: "release-verification-report",
  });

  const reportResult = runScript("scripts/ci/write-changesets-release-report.mjs", {
    CHANGESETS_RELEASE_RESULT_PATH: resultPath,
    CHANGESETS_RELEASE_ASSERTION_PATH: assertionPath,
    CHANGESETS_RELEASE_SUMMARY_PATH: summaryPath,
    CHANGESETS_RELEASE_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_REPORT_PATH: releaseVerificationReportPath,
    CHANGESETS_RELEASE_RESULT_ARTIFACT_NAME: "changesets-release-result",
    CHANGESETS_RELEASE_ASSERTION_ARTIFACT_NAME: "changesets-release-assertion",
    CHANGESETS_RELEASE_SUMMARY_ARTIFACT_NAME: "changesets-release-summary",
    CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME: "changesets-release-report",
    RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME: "release-verification-report",
  });

  assert.equal(summaryResult.status, 0, summaryResult.stderr || summaryResult.stdout);
  assert.equal(reportResult.status, 0, reportResult.stderr || reportResult.stdout);

  const summary = fs.readFileSync(summaryPath, "utf8");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.match(summary, /Outcome: `missing`/i);
  assert.match(summary, /## Input presence/i);
  assert.match(summary, /Result artifact: `missing`/i);
  assert.match(summary, /Release verification report: `present`/i);
  assert.match(summary, /Release verification: `release-verification-report`/i);
  assert.match(summary, /Report Path: `changesets-release-report\.json`/i);
  assert.match(summary, /Release Verification Report Path: `release-verification-report\.json`/i);
  assert.equal(report.status, "missing");
  assert.equal(report.effectiveStatus, "failed");
  assert.equal(report.inputs.hasResultArtifact, false);
  assert.equal(report.inputs.hasAssertionArtifact, true);
  assert.equal(report.inputs.hasReleaseVerificationReport, true);
  assert.equal(report.result.inputs.hasReleaseVerificationReport, true);
  assert.equal(report.result.prerequisites.releaseVerificationStatus, "passed");
  assert.equal(report.result.artifacts.resultPath, path.resolve(resultPath));
  assert.equal(report.result.artifacts.assertionPath, path.resolve(assertionPath));
  assert.equal(report.result.artifacts.summaryPath, path.resolve(summaryPath));
  assert.equal(report.result.artifacts.reportPath, path.resolve(reportPath));
  assert.equal(
    report.result.artifacts.releaseVerificationReportPath,
    path.resolve(releaseVerificationReportPath),
  );
  assert.equal(report.result.artifactNames.result, "changesets-release-result");
  assert.equal(report.result.artifactNames.assertion, "changesets-release-assertion");
  assert.equal(report.result.artifactNames.summary, "changesets-release-summary");
  assert.equal(report.result.artifactNames.report, "changesets-release-report");
  assert.equal(report.result.artifactNames.releaseVerification, "release-verification-report");
  assert.equal(report.artifactNames.releaseVerification, "release-verification-report");
  assert.equal(report.evidenceFileNames.resultPath, "missing-changesets-release-result.json");
  assert.equal(
    report.evidenceFileNames.releaseVerificationReportPath,
    "release-verification-report.json",
  );
});
