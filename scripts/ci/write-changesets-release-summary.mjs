import fs from "node:fs";
import path from "node:path";
import {
  appendChangesetsReleaseSummary,
  buildChangesetsReleaseSummaryMarkdown,
} from "./changesets-release-result-lib.mjs";

const resultPath =
  process.env.CHANGESETS_RELEASE_RESULT_PATH ||
  path.join(".generated", "release", "changesets-release-result.json");
const outputPath =
  process.env.CHANGESETS_RELEASE_SUMMARY_PATH ||
  path.join(".generated", "release", "changesets-release-summary.md");

if (!fs.existsSync(resultPath)) {
  throw new Error(`Changesets release result artifact not found: ${resultPath}`);
}

const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
const markdown = buildChangesetsReleaseSummaryMarkdown({ result });

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, markdown, "utf8");

appendChangesetsReleaseSummary({
  summaryPath: process.env.GITHUB_STEP_SUMMARY || "",
  result,
});

console.log(`[changesets-release] wrote summary ${outputPath}`);
