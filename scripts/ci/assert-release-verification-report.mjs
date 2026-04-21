import fs from "node:fs";
import path from "node:path";

function formatStatusMap(statusMap) {
  return Object.entries(statusMap)
    .map(([name, status]) => `${name}=${status}`)
    .join(", ");
}

function buildFailureDetails(report) {
  const details = [];

  if (report?.package?.status === "failed") {
    const problems = Array.isArray(report?.package?.problems) ? report.package.problems : [];
    if (problems.length > 0) {
      details.push(`package problems: ${problems.join("; ")}`);
    }
    if (report?.package?.failureMessage) {
      details.push(`package failure: ${report.package.failureMessage}`);
    }
  }
  if (report?.package?.status === "missing" && report?.package?.missingReason) {
    details.push(`package missing: ${report.package.missingReason}`);
  }

  if (report?.tarballSmoke?.status === "failed") {
    if (report?.tarballSmoke?.failureMessage) {
      details.push(`tarball smoke failure: ${report.tarballSmoke.failureMessage}`);
    } else {
      const tarballSmokeDetails = [
        `helpIncludesUsage=${report?.tarballSmoke?.helpIncludesUsage === true ? "true" : "false"}`,
        `exportsCheck=${report?.tarballSmoke?.exportsCheck || "unknown"}`,
        `equipVersion=${report?.tarballSmoke?.equipVersion || "unknown"}`,
        `unequipVersion=${report?.tarballSmoke?.unequipVersion || "unknown"}`,
      ];
      details.push(`tarball smoke details: ${tarballSmokeDetails.join(", ")}`);
    }
  }
  if (report?.tarballSmoke?.status === "missing" && report?.tarballSmoke?.missingReason) {
    details.push(`tarball smoke missing: ${report.tarballSmoke.missingReason}`);
  }

  if (report?.dockerAcceptance?.status === "failed") {
    const dockerDetails = [];
    if (report?.dockerAcceptance?.failureMessage) {
      dockerDetails.push(report.dockerAcceptance.failureMessage);
    }

    const failingSteps = Array.isArray(report?.dockerAcceptance?.steps)
      ? report.dockerAcceptance.steps.filter((step) => step.exitCode !== 0 && step.exitCode !== null)
      : [];
    if (failingSteps.length > 0) {
      dockerDetails.push(
        `failing steps: ${failingSteps
          .map((step) => `${step.name}(exit=${step.exitCode})`)
          .join(", ")}`,
      );
    }

    if (dockerDetails.length > 0) {
      details.push(`docker acceptance details: ${dockerDetails.join("; ")}`);
    }
  }
  if (report?.dockerAcceptance?.status === "missing" && report?.dockerAcceptance?.missingReason) {
    details.push(`docker acceptance missing: ${report.dockerAcceptance.missingReason}`);
  }

  return details;
}

function main() {
  const reportPath =
    process.env.RELEASE_VERIFICATION_REPORT_PATH ||
    path.join(".generated", "release", "release-verification-report.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const componentStatuses = {
    package: report?.package?.status || "unknown",
    tarballSmoke: report?.tarballSmoke?.status || "unknown",
    dockerAcceptance: report?.dockerAcceptance?.status || "unknown",
  };
  const componentSummary = formatStatusMap(componentStatuses);

  if (report?.overallStatus !== "passed") {
    const failingComponents = Object.entries(componentStatuses)
      .filter(([, status]) => status === "failed")
      .map(([name]) => name);
    const failureSummary = failingComponents.length
      ? ` Failed components: ${failingComponents.join(", ")}.`
      : "";
    const detailSummary = buildFailureDetails(report);
    const detailText = detailSummary.length
      ? ` Details: ${detailSummary.join(" | ")}.`
      : "";

    throw new Error(
      `Release verification report '${reportPath}' has overallStatus '${report?.overallStatus || "unknown"}'.${failureSummary} Components: ${componentSummary || "none"}.${detailText}`,
    );
  }

  console.log(`[release-verification] status passed for ${reportPath}`);
  console.log(`[release-verification] components: ${componentSummary || "none"}`);
}

try {
  main();
} catch (error) {
  console.error(`[release-verification] assertion failed: ${error.message}`);
  process.exit(1);
}
