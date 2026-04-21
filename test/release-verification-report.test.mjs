import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendReleaseVerificationSummary,
  buildReleaseVerificationReport,
} from "../scripts/ci/release-verification-report-lib.mjs";

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
  });

  assert.equal(report.overallStatus, "passed");
  assert.equal(report.package.status, "passed");
  assert.equal(report.tarballSmoke.status, "passed");
  assert.equal(report.dockerAcceptance.status, "passed");
  assert.equal(report.package.artifacts.logPath, ".generated/release/pack-verification.log");
  assert.equal(report.tarballSmoke.artifacts.logPath, ".generated/release/pack-install-smoke.log");
  assert.equal(report.tarballSmoke.steps[0].name, "npm-install");
  assert.equal(report.dockerAcceptance.steps[1].name, "docker-run");
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
});
