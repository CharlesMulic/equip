import fs from "node:fs";
import path from "node:path";
import {
  buildChangesetsReleaseResult,
  buildChangesetsReleaseReport,
  writeChangesetsReleaseReportArtifact,
} from "./changesets-release-result-lib.mjs";

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
const resultArtifactName = process.env.CHANGESETS_RELEASE_RESULT_ARTIFACT_NAME || "";
const assertionArtifactName = process.env.CHANGESETS_RELEASE_ASSERTION_ARTIFACT_NAME || "";
const summaryArtifactName = process.env.CHANGESETS_RELEASE_SUMMARY_ARTIFACT_NAME || "";
const reportArtifactName = process.env.CHANGESETS_RELEASE_REPORT_ARTIFACT_NAME || "";

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

const resultArtifact = readOptionalJson(resultPath);
const result =
  resultArtifact ||
  buildChangesetsReleaseResult({
    stepOutcome: "missing",
    published: false,
    publishedPackages: [],
  });
const assertionArtifact = readOptionalJson(assertionPath);
const inputs = {
  hasResultArtifact: !!resultArtifact,
  hasAssertionArtifact: !!assertionArtifact,
  hasReleaseVerificationReport: !!result?.inputs?.hasReleaseVerificationReport,
};

const report = buildChangesetsReleaseReport({
  result,
  assertionArtifact,
  inputs,
  artifacts: {
    resultPath: resolveArtifactPath(resultPath),
    assertionPath: resolveArtifactPath(assertionPath),
    summaryPath: resolveArtifactPath(summaryPath),
    reportPath: path.resolve(reportPath),
  },
  artifactNames: {
    result: resultArtifactName,
    assertion: assertionArtifactName,
    summary: summaryArtifactName,
    report: reportArtifactName,
  },
});

writeChangesetsReleaseReportArtifact({
  report,
  outPath: reportPath,
});

console.log(`[changesets-release] wrote report ${reportPath}`);
