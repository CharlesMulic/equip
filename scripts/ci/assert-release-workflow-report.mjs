import fs from "node:fs";
import path from "node:path";

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
      releaseBootstrap: report?.releaseBootstrap || null,
      releasePreflight: report?.releasePreflight || null,
      releaseVerification: report?.releaseVerification || null,
      changesetsRelease: report?.changesetsRelease || null,
    },
    assertion,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

if (!fs.existsSync(reportPath)) {
  throw new Error(`Release workflow report artifact not found: ${reportPath}`);
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const allowedStatuses = parseAllowedStatuses(process.env.RELEASE_WORKFLOW_ALLOWED_STATUSES);
const actualStatus = report?.overallStatus || "unknown";
const failureDetails = [];

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
