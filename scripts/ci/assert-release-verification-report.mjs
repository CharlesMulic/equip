import fs from "node:fs";
import path from "node:path";

function formatStatusMap(statusMap) {
  return Object.entries(statusMap)
    .map(([name, status]) => `${name}=${status}`)
    .join(", ");
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

    throw new Error(
      `Release verification report '${reportPath}' has overallStatus '${report?.overallStatus || "unknown"}'.${failureSummary} Components: ${componentSummary || "none"}.`,
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
