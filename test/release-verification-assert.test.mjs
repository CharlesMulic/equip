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

  writeJson(reportPath, {
    overallStatus: "passed",
    package: { status: "passed" },
    tarballSmoke: { status: "passed" },
    dockerAcceptance: { status: "passed" },
  });

  const result = runScript("scripts/ci/assert-release-verification-report.mjs", {
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /status passed/i);
  assert.match(result.stdout, /package=passed, tarballSmoke=passed, dockerAcceptance=passed/i);
});

test("assert-release-verification-report fails unhealthy rollups with helpful detail", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-verification-"));
  const reportPath = path.join(root, "release-verification-report.json");

  writeJson(reportPath, {
    overallStatus: "failed",
    package: {
      status: "failed",
      problems: ["missing bin/equip.js", "unexpected src/ fixture"],
    },
    tarballSmoke: {
      status: "failed",
      helpIncludesUsage: false,
      exportsCheck: "exports-missing",
      equipVersion: "0.17.7",
      unequipVersion: "",
    },
    dockerAcceptance: {
      status: "failed",
      failureMessage: "docker run failed",
      steps: [
        { name: "docker-build", exitCode: 0 },
        { name: "docker-run", exitCode: 1 },
      ],
    },
  });

  const result = runScript("scripts/ci/assert-release-verification-report.mjs", {
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /assertion failed/i);
  assert.match(result.stderr, /Failed components: package, tarballSmoke, dockerAcceptance\./i);
  assert.match(result.stderr, /Components: package=failed, tarballSmoke=failed, dockerAcceptance=failed\./i);
  assert.match(result.stderr, /package problems: missing bin\/equip\.js; unexpected src\/ fixture/i);
  assert.match(result.stderr, /tarball smoke details: helpIncludesUsage=false, exportsCheck=exports-missing, equipVersion=0\.17\.7, unequipVersion=unknown/i);
  assert.match(result.stderr, /docker acceptance details: docker run failed; failing steps: docker-run\(exit=1\)/i);
});

test("assert-release-verification-report reports missing component artifacts clearly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-release-verification-"));
  const reportPath = path.join(root, "release-verification-report.json");

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
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Components: package=missing, tarballSmoke=passed, dockerAcceptance=missing\./i);
  assert.match(result.stderr, /package missing: pack verification artifact missing/i);
  assert.match(result.stderr, /docker acceptance missing: docker acceptance artifact missing/i);
});
