import fs from "node:fs";
import path from "node:path";
import {
  buildChangesetsReleaseResult,
  writeChangesetsReleaseAssertionArtifact,
} from "./changesets-release-result-lib.mjs";
import { readGitHubWorkflowContext } from "./workflow-context-lib.mjs";

const resultPath =
  process.env.CHANGESETS_RELEASE_RESULT_PATH ||
  path.join(".generated", "release", "changesets-release-result.json");
const assertionPath =
  process.env.CHANGESETS_RELEASE_ASSERTION_PATH ||
  path.join(".generated", "release", "changesets-release-assertion.json");
const summaryPath =
  process.env.CHANGESETS_RELEASE_SUMMARY_PATH ||
  path.join(".generated", "release", "changesets-release-summary.md");
const reportPath =
  process.env.CHANGESETS_RELEASE_REPORT_PATH ||
  path.join(".generated", "release", "changesets-release-report.json");
const releaseVerificationReportPath =
  process.env.RELEASE_VERIFICATION_REPORT_PATH ||
  path.join(".generated", "release", "release-verification-report.json");
const artifacts = {
  resultPath: path.resolve(resultPath),
  assertionPath: path.resolve(assertionPath),
  summaryPath: path.resolve(summaryPath),
  reportPath: path.resolve(reportPath),
  releaseVerificationReportPath: path.resolve(releaseVerificationReportPath),
};
const artifactNames = {
  result: process.env.CHANGESETS_RELEASE_RESULT_ARTIFACT_NAME || "",
  assertion: process.env.CHANGESETS_RELEASE_ASSERTION_ARTIFACT_NAME || "",
  summary: process.env.CHANGESETS_RELEASE_SUMMARY_ARTIFACT_NAME || "",
  report: process.env.CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME || "",
  releaseVerification: process.env.RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME || "",
};

const hasResultArtifact = fs.existsSync(resultPath);
const result = hasResultArtifact
  ? JSON.parse(fs.readFileSync(resultPath, "utf8"))
  : buildChangesetsReleaseResult({
      stepOutcome: "missing",
      published: false,
      publishedPackages: [],
      artifacts,
      artifactNames,
      workflowContext: readGitHubWorkflowContext(process.env),
    });
const inputs = {
  hasResultArtifact,
  hasAssertionArtifact: false,
  hasReleaseVerificationReport: !!result?.inputs?.hasReleaseVerificationReport,
};

try {
  if (!hasResultArtifact) {
    throw new Error(`Changesets release result artifact not found: ${resultPath}`);
  }

  if (result.stepOutcome !== "success") {
    const detail =
      result.status === "skipped" && result.skipReason
        ? result.skipReason
        : (result.summary || "Inspect workflow logs for details.");
    throw new Error(
      `Changesets release step finished with outcome '${result.stepOutcome}'. ${detail}`,
    );
  }

  writeChangesetsReleaseAssertionArtifact({
    result,
    artifacts,
    artifactNames,
    inputs,
    workflowContext: readGitHubWorkflowContext(process.env),
    assertion: {
      outcome: "passed",
      resultPath: path.resolve(resultPath),
      assertionPath: path.resolve(assertionPath),
      status: result.status || "",
      published: !!result.published,
      publishedPackages: Array.isArray(result.publishedPackages) ? result.publishedPackages : [],
    },
    outPath: assertionPath,
  });

  console.log(`[changesets-release] result passed for ${resultPath}`);
  console.log(`[changesets-release] status=${result.status} published=${result.published ? "yes" : "no"}`);
} catch (error) {
  writeChangesetsReleaseAssertionArtifact({
    result,
    artifacts,
    artifactNames,
    inputs,
    workflowContext: readGitHubWorkflowContext(process.env),
    assertion: {
      outcome: "failed",
      resultPath: path.resolve(resultPath),
      assertionPath: path.resolve(assertionPath),
      status: result.status || "",
      published: !!result.published,
      publishedPackages: Array.isArray(result.publishedPackages) ? result.publishedPackages : [],
      error: error instanceof Error ? error.message : String(error),
    },
    outPath: assertionPath,
  });
  throw error;
}
