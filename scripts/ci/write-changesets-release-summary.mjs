import fs from "node:fs";
import path from "node:path";
import {
  appendChangesetsReleaseSummary,
  buildChangesetsReleaseResult,
  buildChangesetsReleaseSummaryMarkdown,
} from "./changesets-release-result-lib.mjs";
import { readGitHubWorkflowContext } from "./workflow-context-lib.mjs";

const resultPath =
  process.env.CHANGESETS_RELEASE_RESULT_PATH ||
  path.join(".generated", "release", "changesets-release-result.json");
const assertionPath =
  process.env.CHANGESETS_RELEASE_ASSERTION_PATH ||
  path.join(".generated", "release", "changesets-release-assertion.json");
const outputPath =
  process.env.CHANGESETS_RELEASE_SUMMARY_PATH ||
  path.join(".generated", "release", "changesets-release-summary.md");
const resultArtifactName = process.env.CHANGESETS_RELEASE_RESULT_ARTIFACT_NAME || "";
const assertionArtifactName = process.env.CHANGESETS_RELEASE_ASSERTION_ARTIFACT_NAME || "";
const summaryArtifactName = process.env.CHANGESETS_RELEASE_SUMMARY_ARTIFACT_NAME || "";
const reportArtifactName = process.env.CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME || "";
const releaseVerificationReportArtifactName =
  process.env.RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME || "";
const appendStepSummary =
  (process.env.CHANGESETS_RELEASE_APPEND_STEP_SUMMARY || "true").toLowerCase() !== "false";
const reportPath =
  process.env.CHANGESETS_RELEASE_REPORT_PATH ||
  path.join(".generated", "release", "changesets-release-report.json");
const releaseVerificationReportPath =
  process.env.RELEASE_VERIFICATION_REPORT_PATH ||
  path.join(".generated", "release", "release-verification-report.json");

function readOptionalJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const resultArtifact = readOptionalJson(resultPath);
const releaseVerificationReport = readOptionalJson(releaseVerificationReportPath);
const result =
  resultArtifact ||
  buildChangesetsReleaseResult({
    stepOutcome: "missing",
    published: false,
    publishedPackages: [],
    releaseVerificationReport,
    artifacts: {
      resultPath: path.resolve(resultPath),
      assertionPath: path.resolve(assertionPath),
      summaryPath: path.resolve(outputPath),
      reportPath: path.resolve(reportPath),
      releaseVerificationReportPath: path.resolve(releaseVerificationReportPath),
    },
    artifactNames: {
      result: resultArtifactName,
      assertion: assertionArtifactName,
      summary: summaryArtifactName,
      report: reportArtifactName,
      releaseVerification: releaseVerificationReportArtifactName,
    },
    workflowContext: readGitHubWorkflowContext(process.env),
  });
const assertionArtifact = readOptionalJson(assertionPath);
const inputs = {
  hasResultArtifact: !!resultArtifact,
  hasAssertionArtifact: !!assertionArtifact,
  hasReleaseVerificationReport:
    !!releaseVerificationReport || !!result?.inputs?.hasReleaseVerificationReport,
};
const artifactNames = {
  result: resultArtifactName,
  assertion: assertionArtifactName,
  summary: summaryArtifactName,
  report: reportArtifactName,
  releaseVerification: releaseVerificationReportArtifactName,
};

const markdown = buildChangesetsReleaseSummaryMarkdown({
  result,
  assertionArtifact,
  artifactNames,
  inputs,
  workflowContext: readGitHubWorkflowContext(process.env),
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, markdown, "utf8");

appendChangesetsReleaseSummary({
  summaryPath: appendStepSummary ? process.env.GITHUB_STEP_SUMMARY || "" : "",
  result,
  assertionArtifact,
  artifactNames,
  inputs,
  workflowContext: readGitHubWorkflowContext(process.env),
});

console.log(`[changesets-release] wrote summary ${outputPath}`);
