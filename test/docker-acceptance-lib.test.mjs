import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendDockerAcceptanceSummary,
  deriveDockerAcceptanceEvidenceFileNames,
  resolveDockerAcceptanceArtifacts,
  writeDockerAcceptanceArtifacts,
} from "../scripts/ci/docker-acceptance-lib.mjs";

test("resolveDockerAcceptanceArtifacts derives default artifact paths from an output directory", () => {
  const artifacts = resolveDockerAcceptanceArtifacts({
    outputDir: path.join("artifacts", "docker"),
  });

  assert.match(artifacts.outputDir, /artifacts[\\\/]docker$/);
  assert.match(artifacts.reportPath, /artifacts[\\\/]docker[\\\/]docker-acceptance-report\.json$/);
  assert.match(artifacts.buildLogPath, /artifacts[\\\/]docker[\\\/]docker-build\.log$/);
  assert.match(artifacts.runLogPath, /artifacts[\\\/]docker[\\\/]docker-run\.log$/);
});

test("writeDockerAcceptanceArtifacts persists logs and a machine-readable report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-docker-artifacts-"));
  const reportPath = path.join(root, "docker-acceptance-report.json");
  const buildLogPath = path.join(root, "docker-build.log");
  const runLogPath = path.join(root, "docker-run.log");

  writeDockerAcceptanceArtifacts({
    reportPath,
    buildLogPath,
    runLogPath,
    buildLog: "build ok\n",
    runLog: "run ok\n",
    report: {
      kind: "equip-docker-acceptance-report",
      status: "passed",
      workflowContext: {
        repository: "CharlesMulic/equip",
        workflow: "Release",
        runId: "789",
        sha: "abc123",
        serverUrl: "https://github.com",
      },
      artifactNames: {
        bundle: "docker-acceptance",
      },
      evidenceFileNames: {
        reportPath: "docker-acceptance-report.json",
        buildLogPath: "docker-build.log",
        runLogPath: "docker-run.log",
      },
      steps: [
        { name: "docker-build", durationMs: 123, exitCode: 0 },
        { name: "docker-run", durationMs: 456, exitCode: 0 },
      ],
    },
  });

  assert.equal(fs.readFileSync(buildLogPath, "utf8"), "build ok\n");
  assert.equal(fs.readFileSync(runLogPath, "utf8"), "run ok\n");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.kind, "equip-docker-acceptance-report");
  assert.equal(report.steps[1].name, "docker-run");
  assert.equal(report.artifactNames.bundle, "docker-acceptance");
  assert.equal(report.evidenceFileNames.reportPath, "docker-acceptance-report.json");
  assert.equal(report.workflowContext.repository, "CharlesMulic/equip");
});

test("deriveDockerAcceptanceEvidenceFileNames derives stable file-name breadcrumbs", () => {
  const evidenceFileNames = deriveDockerAcceptanceEvidenceFileNames({
    reportPath: path.join("artifacts", "docker", "docker-acceptance-report.json"),
    buildLogPath: path.join("artifacts", "docker", "docker-build.log"),
    runLogPath: path.join("artifacts", "docker", "docker-run.log"),
  });

  assert.equal(evidenceFileNames.reportPath, "docker-acceptance-report.json");
  assert.equal(evidenceFileNames.buildLogPath, "docker-build.log");
  assert.equal(evidenceFileNames.runLogPath, "docker-run.log");
});

test("appendDockerAcceptanceSummary writes a concise step summary block", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-docker-summary-"));
  const summaryPath = path.join(root, "summary.md");

  appendDockerAcceptanceSummary({
    summaryPath,
    report: {
      status: "passed",
      dockerBin: "docker",
      imageTag: "cg3-equip-acceptance:test",
      totalDurationMs: 579,
      steps: [
        { name: "docker-build", durationMs: 123, exitCode: 0 },
        { name: "docker-run", durationMs: 456, exitCode: 0 },
      ],
      artifacts: {
        reportPath: ".generated/docker/docker-acceptance-report.json",
        buildLogPath: ".generated/docker/docker-build.log",
        runLogPath: ".generated/docker/docker-run.log",
      },
      workflowContext: {
        repository: "CharlesMulic/equip",
        workflow: "Release",
        runId: "789",
        sha: "abc123",
        serverUrl: "https://github.com",
      },
      artifactNames: {
        bundle: "docker-acceptance",
      },
      evidenceFileNames: {
        reportPath: "docker-acceptance-report.json",
        buildLogPath: "docker-build.log",
        runLogPath: "docker-run.log",
      },
    },
  });

  const summary = fs.readFileSync(summaryPath, "utf8");
  assert.match(summary, /## Docker acceptance/);
  assert.match(summary, /Status: `passed`/);
  assert.match(summary, /Build duration: `123 ms`/);
  assert.match(summary, /Run log: `.generated\/docker\/docker-run\.log`/);
  assert.match(summary, /## GitHub workflow context/i);
  assert.match(summary, /Run URL: `https:\/\/github\.com\/CharlesMulic\/equip\/actions\/runs\/789`/i);
  assert.match(summary, /Commit URL: `https:\/\/github\.com\/CharlesMulic\/equip\/commit\/abc123`/i);
  assert.match(summary, /## Evidence artifacts/i);
  assert.match(summary, /bundle: `docker-acceptance`/i);
  assert.match(summary, /## Evidence file names/i);
  assert.match(summary, /reportPath: `docker-acceptance-report\.json`/i);
  assert.match(summary, /buildLogPath: `docker-build\.log`/i);
  assert.match(summary, /runLogPath: `docker-run\.log`/i);
});
