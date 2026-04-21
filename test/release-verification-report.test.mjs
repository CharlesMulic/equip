import test from "node:test";
import assert from "node:assert/strict";
import { buildReleaseVerificationReport } from "../scripts/ci/release-verification-report-lib.mjs";

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
    },
    packInstallSmoke: {
      tarballFileName: "cg3-equip-0.17.7.tgz",
      tarballPath: "/tmp/cg3-equip-0.17.7.tgz",
      installedVersion: "0.17.7",
      equipVersion: "0.17.7",
      unequipVersion: "0.17.7",
      helpIncludesUsage: true,
      exportsCheck: "exports-ok",
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
  assert.equal(report.dockerAcceptance.steps[1].name, "docker-run");
});

test("buildReleaseVerificationReport marks the rollup failed when any component gate fails", () => {
  const report = buildReleaseVerificationReport({
    packVerification: {
      status: "failed",
      hasFailures: true,
      problems: ["missing required files"],
      failureMessage: "npm pack verification failed",
    },
    packInstallSmoke: {
      status: "failed",
      helpIncludesUsage: false,
      exportsCheck: "exports-ok",
      failureMessage: "installed equip --help output did not include the expected usage header",
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
  assert.equal(report.tarballSmoke.status, "passed");
  assert.equal(report.dockerAcceptance.status, "missing");
  assert.equal(report.dockerAcceptance.missingReason, "docker acceptance artifact missing");
});
