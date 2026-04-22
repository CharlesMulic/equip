import fs from "node:fs";
import path from "node:path";
import {
  buildReleaseWorkflowSummaryMarkdown,
} from "./release-workflow-report-lib.mjs";

const reportPath =
  process.env.RELEASE_WORKFLOW_REPORT_PATH ||
  path.join(".generated", "release", "release-workflow-report.json");
const summaryPath =
  process.env.RELEASE_WORKFLOW_SUMMARY_PATH ||
  path.join(".generated", "release", "release-workflow-summary.md");
const appendStepSummary =
  (process.env.RELEASE_WORKFLOW_APPEND_STEP_SUMMARY || "true").toLowerCase() !== "false";

if (!fs.existsSync(reportPath)) {
  throw new Error(`Release workflow report artifact not found: ${reportPath}`);
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const markdown = buildReleaseWorkflowSummaryMarkdown({ report });

fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
fs.writeFileSync(summaryPath, markdown, "utf8");

if (appendStepSummary && process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
}

console.log(`[release-workflow] wrote summary ${summaryPath}`);
