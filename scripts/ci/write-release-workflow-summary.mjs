import fs from "node:fs";
import path from "node:path";
import {
  buildReleaseWorkflowReport,
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

const report = fs.existsSync(reportPath)
  ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
  : (() => {
      const syntheticReport = buildReleaseWorkflowReport({
        workflowContext: {
          repository: process.env.GITHUB_REPOSITORY || "",
          workflow: process.env.GITHUB_WORKFLOW || "",
          runId: process.env.GITHUB_RUN_ID || "",
          runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
          ref: process.env.GITHUB_REF || "",
          sha: process.env.GITHUB_SHA || "",
          eventName: process.env.GITHUB_EVENT_NAME || "",
          serverUrl: process.env.GITHUB_SERVER_URL || "",
          apiUrl: process.env.GITHUB_API_URL || "",
        },
        artifacts: {
          reportPath: path.resolve(reportPath),
          summaryPath: path.resolve(summaryPath),
        },
      });
      syntheticReport.inputs.hasReleaseWorkflowReport = false;
      return syntheticReport;
    })();
const markdown = buildReleaseWorkflowSummaryMarkdown({ report });

fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
fs.writeFileSync(summaryPath, markdown, "utf8");

if (appendStepSummary && process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
}

console.log(`[release-workflow] wrote summary ${summaryPath}`);
