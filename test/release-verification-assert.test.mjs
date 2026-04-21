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
    package: { status: "passed" },
    tarballSmoke: { status: "failed" },
    dockerAcceptance: { status: "failed" },
  });

  const result = runScript("scripts/ci/assert-release-verification-report.mjs", {
    RELEASE_VERIFICATION_REPORT_PATH: reportPath,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /assertion failed/i);
  assert.match(result.stderr, /Failed components: tarballSmoke, dockerAcceptance\./i);
  assert.match(result.stderr, /Components: package=passed, tarballSmoke=failed, dockerAcceptance=failed\./i);
});
