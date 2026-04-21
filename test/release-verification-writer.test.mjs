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

test("write-release-verification-summary writes a markdown artifact with the final assertion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-summary-writer-"));
  const reportPath = path.join(root, "release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");
  const summaryPath = path.join(root, "release-verification-summary.md");

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
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = fs.readFileSync(summaryPath, "utf8");
  assert.match(result.stdout, /wrote summary/i);
  assert.match(summary, /## Release verification rollup/i);
  assert.match(summary, /## Final assertion/i);
  assert.match(summary, /Tarball smoke failure: Installed equip --help output did not include the expected usage header\./i);
  assert.match(summary, /Error: release verification failed/i);
});

test("write-release-verification-report can rewrite a final report without duplicating the GitHub step summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-report-writer-"));
  const reportPath = path.join(root, "release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");
  const summaryPath = path.join(root, "release-verification-summary.md");
  const stepSummaryPath = path.join(root, "step-summary.md");

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
    PACK_VERIFICATION_PATH: path.join(root, "pack-verification.json"),
    PACK_INSTALL_SMOKE_PATH: path.join(root, "pack-install-smoke.json"),
    DOCKER_ACCEPTANCE_REPORT_PATH: path.join(root, "docker-acceptance-report.json"),
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_ASSERTION_PATH: assertionPath,
    RELEASE_VERIFICATION_SUMMARY_PATH: summaryPath,
    RELEASE_VERIFICATION_APPEND_STEP_SUMMARY: "false",
    GITHUB_STEP_SUMMARY: stepSummaryPath,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const stepSummary = fs.readFileSync(stepSummaryPath, "utf8");
  assert.equal(report.artifacts.summaryPath, path.resolve(summaryPath));
  assert.equal(report.artifacts.assertionPath, path.resolve(assertionPath));
  assert.equal(report.assertion?.outcome, "passed");
  assert.equal(stepSummary, "## Existing step summary\n");
});
