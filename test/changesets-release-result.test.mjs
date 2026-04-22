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

test("buildChangesetsReleaseResult captures published packages from changesets outputs", () => {
  const result = buildChangesetsReleaseResult({
    stepOutcome: "success",
    published: "true",
    publishedPackages: JSON.stringify([
      { name: "@cg3/equip", version: "0.17.8" },
    ]),
  });

  assert.equal(result.kind, "equip-changesets-release-result");
  assert.equal(result.stepOutcome, "success");
  assert.equal(result.status, "published");
  assert.equal(result.published, true);
  assert.equal(result.publishedPackages.length, 1);
  assert.equal(result.publishedPackages[0].name, "@cg3/equip");
  assert.match(result.summary, /published 1 package/i);
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
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const artifact = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(artifact.status, "published");
  assert.equal(artifact.publishedPackages[0].version, "0.17.8");
});

test("buildChangesetsReleaseSummaryMarkdown renders published packages cleanly", () => {
  const markdown = buildChangesetsReleaseSummaryMarkdown({
    result: buildChangesetsReleaseResult({
      stepOutcome: "success",
      published: "true",
      publishedPackages: JSON.stringify([
        { name: "@cg3/equip", version: "0.17.8" },
      ]),
    }),
  });

  assert.match(markdown, /## Changesets release result/i);
  assert.match(markdown, /Outcome: `success`/i);
  assert.match(markdown, /@cg3\/equip/);
  assert.match(markdown, /0\.17\.8/);
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
  });

  assert.equal(report.kind, "equip-changesets-release-report");
  assert.equal(report.status, "published");
  assert.equal(report.result.status, "published");
  assert.equal(report.result.publishedPackages[0].name, "@cg3/equip");
  assert.equal(report.assertion.outcome, "passed");
  assert.equal(report.assertion.publishedPackages[0].version, "0.17.8");
  assert.equal(report.artifacts.summaryPath, "/tmp/changesets-release-summary.md");
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
    GITHUB_STEP_SUMMARY: stepSummaryPath,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summaryArtifact = fs.readFileSync(summaryPath, "utf8");
  const stepSummary = fs.readFileSync(stepSummaryPath, "utf8");
  assert.match(summaryArtifact, /## Changesets release result/i);
  assert.match(summaryArtifact, /@cg3\/equip/);
  assert.match(summaryArtifact, /## Final assertion/i);
  assert.match(summaryArtifact, /Outcome: `passed`/i);
  assert.match(stepSummary, /## Changesets release result/i);
  assert.match(stepSummary, /## Final assertion/i);
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
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.status, "published");
  assert.equal(report.result.summary, "changesets release step published 1 package: @cg3/equip@0.17.8");
  assert.equal(report.assertion.outcome, "passed");
  assert.equal(report.artifacts.resultPath, path.resolve(resultPath));
  assert.equal(report.artifacts.assertionPath, path.resolve(assertionPath));
  assert.equal(report.artifacts.summaryPath, path.resolve(summaryPath));
  assert.equal(report.artifacts.reportPath, path.resolve(reportPath));
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

test("writeChangesetsReleaseAssertionArtifact writes a machine-readable verdict", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const assertionPath = path.join(root, "changesets-release-assertion.json");

  const artifact = writeChangesetsReleaseAssertionArtifact({
    result: buildChangesetsReleaseResult({
      stepOutcome: "success",
      published: "false",
      publishedPackages: "[]",
    }),
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
  const persisted = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  assert.equal(persisted.assertion.outcome, "passed");
  assert.equal(persisted.result.status, "completed");
});

test("assert-changesets-release-result writes a passing assertion artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "changesets-release-result.json");
  const assertionPath = path.join(root, "changesets-release-assertion.json");

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
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
  assert.equal(assertion.assertion.outcome, "passed");
  assert.equal(assertion.assertion.published, true);
  assert.equal(assertion.assertion.publishedPackages[0].name, "@cg3/equip");
});
