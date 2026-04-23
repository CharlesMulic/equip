import fs from "node:fs";
import path from "node:path";
import {
  buildReleaseWorkflowReport,
  writeReleaseWorkflowReportArtifact,
} from "./release-workflow-report-lib.mjs";

const releaseVerificationReportPath =
  process.env.RELEASE_VERIFICATION_REPORT_PATH ||
  path.join(".generated", "release", "release-verification-report.json");
const releaseBootstrapResultPath =
  process.env.RELEASE_BOOTSTRAP_RESULT_PATH ||
  path.join(".generated", "release", "release-bootstrap-result.json");
const releasePreflightResultPath =
  process.env.RELEASE_PREFLIGHT_RESULT_PATH ||
  path.join(".generated", "release", "release-preflight-result.json");
const changesetsReleaseReportPath =
  process.env.CHANGESETS_RELEASE_REPORT_PATH ||
  path.join(".generated", "release", "changesets-release-report.json");
const outputPath =
  process.env.RELEASE_WORKFLOW_REPORT_PATH ||
  path.join(".generated", "release", "release-workflow-report.json");
const assertionPath =
  process.env.RELEASE_WORKFLOW_ASSERTION_PATH ||
  path.join(".generated", "release", "release-workflow-assertion.json");
const summaryPath =
  process.env.RELEASE_WORKFLOW_SUMMARY_PATH ||
  path.join(".generated", "release", "release-workflow-summary.md");

function readOptionalJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveArtifactPath(filePath) {
  if (!filePath) {
    return "";
  }

  const absolutePath = path.resolve(filePath);
  return fs.existsSync(absolutePath) ? absolutePath : "";
}

const releaseBootstrapResult = readOptionalJson(releaseBootstrapResultPath);
const releasePreflightResult = readOptionalJson(releasePreflightResultPath);
const releaseVerificationReport = readOptionalJson(releaseVerificationReportPath);
const changesetsReleaseReport = readOptionalJson(changesetsReleaseReportPath);
const assertionArtifact = readOptionalJson(assertionPath);

const report = buildReleaseWorkflowReport({
  releaseBootstrapResult,
  releasePreflightResult,
  releaseVerificationReport,
  changesetsReleaseReport,
  assertionArtifact,
  artifacts: {
    releaseBootstrapResultPath: resolveArtifactPath(releaseBootstrapResultPath),
    releasePreflightResultPath: resolveArtifactPath(releasePreflightResultPath),
    releaseVerificationReportPath: resolveArtifactPath(releaseVerificationReportPath),
    changesetsReleaseReportPath: resolveArtifactPath(changesetsReleaseReportPath),
    assertionPath: resolveArtifactPath(assertionPath),
    summaryPath: resolveArtifactPath(summaryPath),
    reportPath: path.resolve(outputPath),
  },
  artifactNames: {
    releaseBootstrap: process.env.RELEASE_BOOTSTRAP_RESULT_ARTIFACT_NAME || "",
    releasePreflight: process.env.RELEASE_PREFLIGHT_RESULT_ARTIFACT_NAME || "",
    releaseVerification: process.env.RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME || "",
    changesetsRelease: process.env.CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME || "",
    assertion: process.env.RELEASE_WORKFLOW_ASSERTION_ARTIFACT_NAME || "",
    summary: process.env.RELEASE_WORKFLOW_SUMMARY_ARTIFACT_NAME || "",
    report: process.env.RELEASE_WORKFLOW_REPORT_ARTIFACT_NAME || "",
  },
});

writeReleaseWorkflowReportArtifact({
  report,
  outPath: outputPath,
});

console.log(`[release-workflow] wrote report ${outputPath}`);
