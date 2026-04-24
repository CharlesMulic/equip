import fs from "node:fs";
import path from "node:path";
import {
  appendChangesetsReleaseSummary,
  buildChangesetsReleaseResult,
  buildChangesetsReleaseSummaryMarkdown,
} from "./changesets-release-result-lib.mjs";

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
const appendStepSummary =
  (process.env.CHANGESETS_RELEASE_APPEND_STEP_SUMMARY || "true").toLowerCase() !== "false";

const resultArtifact = fs.existsSync(resultPath)
  ? JSON.parse(fs.readFileSync(resultPath, "utf8"))
  : null;
const result =
  resultArtifact ||
  buildChangesetsReleaseResult({
    stepOutcome: "missing",
    published: false,
    publishedPackages: [],
  });
const assertionArtifact = fs.existsSync(assertionPath)
  ? JSON.parse(fs.readFileSync(assertionPath, "utf8"))
  : null;
const inputs = {
  hasResultArtifact: !!resultArtifact,
  hasAssertionArtifact: !!assertionArtifact,
  hasReleaseVerificationReport: !!result?.inputs?.hasReleaseVerificationReport,
};
const artifactNames = {
  result: resultArtifactName,
  assertion: assertionArtifactName,
  summary: summaryArtifactName,
  report: reportArtifactName,
};

const markdown = buildChangesetsReleaseSummaryMarkdown({
  result,
  assertionArtifact,
  artifactNames,
  inputs,
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, markdown, "utf8");

appendChangesetsReleaseSummary({
  summaryPath: appendStepSummary ? process.env.GITHUB_STEP_SUMMARY || "" : "",
  result,
  assertionArtifact,
  artifactNames,
  inputs,
});

console.log(`[changesets-release] wrote summary ${outputPath}`);
