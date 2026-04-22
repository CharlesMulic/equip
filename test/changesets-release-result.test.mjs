import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildChangesetsReleaseResult,
  buildChangesetsReleaseSummaryMarkdown,
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

test("write-changesets-release-summary writes a markdown artifact and appends summary output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "changesets-release-result.json");
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

  const result = runScript("scripts/ci/write-changesets-release-summary.mjs", {
    CHANGESETS_RELEASE_RESULT_PATH: resultPath,
    CHANGESETS_RELEASE_SUMMARY_PATH: summaryPath,
    GITHUB_STEP_SUMMARY: stepSummaryPath,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summaryArtifact = fs.readFileSync(summaryPath, "utf8");
  const stepSummary = fs.readFileSync(stepSummaryPath, "utf8");
  assert.match(summaryArtifact, /## Changesets release result/i);
  assert.match(summaryArtifact, /@cg3\/equip/);
  assert.match(stepSummary, /## Changesets release result/i);
});

test("assert-changesets-release-result fails when the changesets action failed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-changesets-release-"));
  const resultPath = path.join(root, "changesets-release-result.json");

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
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr || result.stdout, /outcome 'failure'/i);
});
