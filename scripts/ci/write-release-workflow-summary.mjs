import fs from "node:fs";
import path from "node:path";
import {
  buildReleaseWorkflowReport,
  buildReleaseWorkflowSummaryMarkdown,
} from "./release-workflow-report-lib.mjs";
import { readGitHubWorkflowContext } from "./workflow-context-lib.mjs";

const reportPath =
  process.env.RELEASE_WORKFLOW_REPORT_PATH ||
  path.join(".generated", "release", "release-workflow-report.json");
const summaryPath =
  process.env.RELEASE_WORKFLOW_SUMMARY_PATH ||
  path.join(".generated", "release", "release-workflow-summary.md");
const assertionPath =
  process.env.RELEASE_WORKFLOW_ASSERTION_PATH ||
  path.join(".generated", "release", "release-workflow-assertion.json");
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
const appendStepSummary =
  (process.env.RELEASE_WORKFLOW_APPEND_STEP_SUMMARY || "true").toLowerCase() !== "false";

function readSyntheticArtifactNames() {
  return {
    assertion: process.env.RELEASE_WORKFLOW_ASSERTION_ARTIFACT_NAME || "",
    summary: process.env.RELEASE_WORKFLOW_SUMMARY_ARTIFACT_NAME || "",
    report: process.env.RELEASE_WORKFLOW_REPORT_ARTIFACT_NAME || "",
    releaseVerification: process.env.RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME || "",
    changesetsRelease: process.env.CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME || "",
  };
}

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

const report = fs.existsSync(reportPath)
  ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
  : (() => {
      const releaseBootstrapResult = readOptionalJson(releaseBootstrapResultPath);
      const releasePreflightResult = readOptionalJson(releasePreflightResultPath);
      const releaseVerificationReport = readOptionalJson(releaseVerificationReportPath);
      const changesetsReleaseReport = readOptionalJson(changesetsReleaseReportPath);
      const assertionArtifact = readOptionalJson(assertionPath);
      const syntheticReport = buildReleaseWorkflowReport({
        releaseBootstrapResult,
        releasePreflightResult,
        releaseVerificationReport,
        changesetsReleaseReport,
        assertionArtifact,
        workflowContext: readGitHubWorkflowContext(process.env),
        artifacts: {
          releaseBootstrapResultPath: resolveArtifactPath(releaseBootstrapResultPath),
          releasePreflightResultPath: resolveArtifactPath(releasePreflightResultPath),
          releaseVerificationReportPath: resolveArtifactPath(releaseVerificationReportPath),
          changesetsReleaseReportPath: resolveArtifactPath(changesetsReleaseReportPath),
          assertionPath: resolveArtifactPath(assertionPath),
          summaryPath: path.resolve(summaryPath),
          reportPath: path.resolve(reportPath),
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
      syntheticReport.inputs.hasReleaseWorkflowReport = false;
      syntheticReport.artifactNames = {
        ...syntheticReport.artifactNames,
        ...readSyntheticArtifactNames(),
      };
      return syntheticReport;
    })();
const markdown = buildReleaseWorkflowSummaryMarkdown({ report });

fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
fs.writeFileSync(summaryPath, markdown, "utf8");

if (appendStepSummary && process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
}

console.log(`[release-workflow] wrote summary ${summaryPath}`);
