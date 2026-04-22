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

if (!fs.existsSync(resultPath)) {
  throw new Error(`Changesets release result artifact not found: ${resultPath}`);
}

const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
const assertionArtifact = fs.existsSync(assertionPath)
  ? JSON.parse(fs.readFileSync(assertionPath, "utf8"))
  : null;
const markdown = buildChangesetsReleaseSummaryMarkdown({ result, assertionArtifact });

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, markdown, "utf8");

appendChangesetsReleaseSummary({
  summaryPath: process.env.GITHUB_STEP_SUMMARY || "",
  result,
  assertionArtifact,
});

console.log(`[changesets-release] wrote summary ${outputPath}`);
