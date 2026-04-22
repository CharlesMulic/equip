import fs from "node:fs";
import path from "node:path";
import {
  appendChangesetsReleaseSummary,
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

if (!fs.existsSync(resultPath)) {
  throw new Error(`Changesets release result artifact not found: ${resultPath}`);
}

const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
const assertionArtifact = fs.existsSync(assertionPath)
  ? JSON.parse(fs.readFileSync(assertionPath, "utf8"))
  : null;
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
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, markdown, "utf8");

appendChangesetsReleaseSummary({
  summaryPath: process.env.GITHUB_STEP_SUMMARY || "",
  result,
  assertionArtifact,
  artifactNames,
});

console.log(`[changesets-release] wrote summary ${outputPath}`);
