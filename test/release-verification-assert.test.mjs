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

test("assert-release-verification-report passes healthy rollups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-verification-"));
  const reportPath = path.join(root, "release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");

  writeJson(reportPath, {
    overallStatus: "passed",
    package: { status: "passed" },
    tarballSmoke: { status: "passed" },
    dockerAcceptance: { status: "passed" },
  });

  const result = runScript("scripts/ci/assert-release-verification-report.mjs", {
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
    RELEASE_VERIFICATION_ASSERTION_PATH: assertionPath,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
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
  assert.deepEqual(assertion.failureDetails, []);
});

test("assert-release-verification-report fails unhealthy rollups with helpful detail", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-verification-"));
  const reportPath = path.join(root, "release-verification-report.json");
  const assertionPath = path.join(root, "release-verification-assertion.json");

  writeJson(reportPath, {
    overallStatus: "failed",
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
  });

  assert.notEqual(result.status, 0);
  const assertion = JSON.parse(fs.readFileSync(assertionPath, "utf8"));
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
  assert.ok(assertion.failureDetails.some((detail) => /package missing:/i.test(detail)));
  assert.ok(assertion.failureDetails.some((detail) => /docker acceptance missing:/i.test(detail)));
});
