import fs from "node:fs";
import path from "node:path";
import { buildReleaseWorkflowReport } from "./release-workflow-report-lib.mjs";

const reportPath =
  process.env.RELEASE_WORKFLOW_REPORT_PATH ||
  path.join(".generated", "release", "release-workflow-report.json");
const assertionPath =
  process.env.RELEASE_WORKFLOW_ASSERTION_PATH ||
  path.join(".generated", "release", "release-workflow-assertion.json");

function parseAllowedStatuses(rawValue) {
  const values = (rawValue || "published,completed")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : ["published", "completed"];
}

function writeAssertionArtifact({ report, assertion, outPath }) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const artifact = {
    kind: "equip-release-workflow-assertion",
    generatedAt: new Date().toISOString(),
    report: {
      overallStatus: report?.overallStatus || "",
      actualStatus: report?.actualStatus || report?.overallStatus || "",
      effectiveStatus: report?.effectiveStatus || report?.overallStatus || "",
      releaseBootstrap: report?.releaseBootstrap || null,
      releasePreflight: report?.releasePreflight || null,
      releaseVerification: report?.releaseVerification || null,
      changesetsRelease: report?.changesetsRelease || null,
      inputs:
        report?.inputs && typeof report.inputs === "object"
          ? {
              hasReleaseWorkflowReport: !!report.inputs.hasReleaseWorkflowReport,
              hasReleaseBootstrapResult: !!report.inputs.hasReleaseBootstrapResult,
              hasReleasePreflightResult: !!report.inputs.hasReleasePreflightResult,
              hasReleaseVerificationReport: !!report.inputs.hasReleaseVerificationReport,
              hasChangesetsReleaseReport: !!report.inputs.hasChangesetsReleaseReport,
            }
          : {
              hasReleaseWorkflowReport: false,
              hasReleaseBootstrapResult: false,
              hasReleasePreflightResult: false,
              hasReleaseVerificationReport: false,
              hasChangesetsReleaseReport: false,
            },
      artifactNames:
        report?.artifactNames && typeof report.artifactNames === "object" ? report.artifactNames : {},
      evidenceFileNames:
        report?.evidenceFileNames && typeof report.evidenceFileNames === "object"
          ? report.evidenceFileNames
          : {},
      evidenceArtifactNames:
        report?.evidenceArtifactNames && typeof report.evidenceArtifactNames === "object"
          ? report.evidenceArtifactNames
          : {},
      evidenceFiles:
        report?.evidenceFiles && typeof report.evidenceFiles === "object" ? report.evidenceFiles : {},
      workflowContext:
        report?.workflowContext && typeof report.workflowContext === "object" ? report.workflowContext : {},
    },
    assertion,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

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
          assertionPath: path.resolve(assertionPath),
        },
      });
      syntheticReport.inputs.hasReleaseWorkflowReport = false;
      return syntheticReport;
    })();
const allowedStatuses = parseAllowedStatuses(process.env.RELEASE_WORKFLOW_ALLOWED_STATUSES);
const actualStatus = report?.actualStatus || report?.overallStatus || "unknown";
const failureDetails = [];

if (!report.inputs?.hasReleaseWorkflowReport) {
  failureDetails.push(`release workflow report artifact not found: ${reportPath}`);
}

if (!allowedStatuses.includes(actualStatus)) {
  failureDetails.push(
    `expected release workflow status to be one of [${allowedStatuses.join(", ")}], got ${actualStatus}`,
  );
}

if (report?.releaseBootstrap?.status && report.releaseBootstrap.status !== "passed") {
  failureDetails.push(`release bootstrap status: ${report.releaseBootstrap.status}`);
}

if (report?.releasePreflight?.status && report.releasePreflight.status !== "passed") {
  failureDetails.push(`release preflight status: ${report.releasePreflight.status}`);
}

if (report?.releaseVerification?.status && report.releaseVerification.status !== "passed") {
  failureDetails.push(`release verification status: ${report.releaseVerification.status}`);
}

if (report?.changesetsRelease?.status === "failed" || report?.changesetsRelease?.status === "missing") {
  failureDetails.push(`changesets release status: ${report.changesetsRelease.status}`);
}

const assertionArtifact = writeAssertionArtifact({
  report,
  assertion: {
    outcome: failureDetails.length === 0 ? "passed" : "failed",
    actualStatus,
    allowedStatuses,
    error: failureDetails.length === 0 ? "" : `release workflow assertion failed for status ${actualStatus}`,
    failureDetails,
    reportPath: path.resolve(reportPath),
    assertionPath: path.resolve(assertionPath),
  },
  outPath: assertionPath,
});

console.log(`[release-workflow] wrote assertion ${assertionPath}`);

if (assertionArtifact.assertion.outcome !== "passed") {
  throw new Error(
    `[release-workflow] assertion failed: ${assertionArtifact.assertion.failureDetails.join("; ")}`,
  );
}
