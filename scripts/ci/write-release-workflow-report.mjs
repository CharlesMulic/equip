import fs from "node:fs";
import path from "node:path";
import {
  buildReleaseWorkflowReport,
  writeReleaseWorkflowReportArtifact,
} from "./release-workflow-report-lib.mjs";

const releaseVerificationReportPath =
  process.env.RELEASE_VERIFICATION_REPORT_PATH ||
  path.join(".generated", "release", "release-verification-report.json");
const changesetsReleaseReportPath =
  process.env.CHANGESETS_RELEASE_REPORT_PATH ||
  path.join(".generated", "release", "changesets-release-report.json");
const outputPath =
  process.env.RELEASE_WORKFLOW_REPORT_PATH ||
  path.join(".generated", "release", "release-workflow-report.json");
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

const releaseVerificationReport = readOptionalJson(releaseVerificationReportPath);
const changesetsReleaseReport = readOptionalJson(changesetsReleaseReportPath);

const report = buildReleaseWorkflowReport({
  releaseVerificationReport,
  changesetsReleaseReport,
  artifacts: {
    releaseVerificationReportPath: resolveArtifactPath(releaseVerificationReportPath),
    changesetsReleaseReportPath: resolveArtifactPath(changesetsReleaseReportPath),
    summaryPath: resolveArtifactPath(summaryPath),
    reportPath: path.resolve(outputPath),
  },
  artifactNames: {
    releaseVerification: process.env.RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME || "",
    changesetsRelease: process.env.CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME || "",
    summary: process.env.RELEASE_WORKFLOW_SUMMARY_ARTIFACT_NAME || "",
    report: process.env.RELEASE_WORKFLOW_REPORT_ARTIFACT_NAME || "",
  },
});

writeReleaseWorkflowReportArtifact({
  report,
  outPath: outputPath,
});

console.log(`[release-workflow] wrote report ${outputPath}`);
