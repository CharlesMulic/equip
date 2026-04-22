import fs from "node:fs";
import path from "node:path";
import {
  appendReleaseVerificationSummary,
  buildReleaseVerificationSummaryMarkdown,
} from "./release-verification-report-lib.mjs";

const reportPath =
  process.env.RELEASE_VERIFICATION_REPORT_PATH ||
  path.join(".generated", "release", "release-verification-report.json");
const assertionPath =
  process.env.RELEASE_VERIFICATION_ASSERTION_PATH ||
  path.join(".generated", "release", "release-verification-assertion.json");
const outputPath =
  process.env.RELEASE_VERIFICATION_SUMMARY_PATH ||
  path.join(".generated", "release", "release-verification-summary.md");
const appendStepSummary =
  (process.env.RELEASE_VERIFICATION_APPEND_STEP_SUMMARY || "true").toLowerCase() !== "false";

function readRequiredJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Required JSON artifact not found: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readOptionalJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const report = readRequiredJson(reportPath);
const assertion = readOptionalJson(assertionPath);
const markdown = buildReleaseVerificationSummaryMarkdown({
  report,
  assertion,
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, markdown, "utf8");

if (appendStepSummary) {
  appendReleaseVerificationSummary({
    summaryPath: process.env.GITHUB_STEP_SUMMARY || "",
    report,
    assertion,
  });
}

console.log(`[release-verification] wrote summary ${outputPath}`);
