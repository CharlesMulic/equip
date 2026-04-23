import fs from "node:fs";
import path from "node:path";

function formatStatusMap(statusMap) {
  return Object.entries(statusMap)
    .map(([name, status]) => `${name}=${status}`)
    .join(", ");
}

function normalizeArtifacts(artifacts) {
  if (!artifacts || typeof artifacts !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(artifacts).map(([key, value]) => [key, typeof value === "string" ? value : ""]),
  );
}

function buildFailureDetails(report) {
  const details = [];
  const formatArtifactDetails = (prefix, artifacts) => {
    const entries = artifacts && typeof artifacts === "object"
      ? Object.entries(artifacts).filter(([, value]) => typeof value === "string" && value)
      : [];

    if (entries.length > 0) {
      details.push(
        `${prefix} artifacts: ${entries.map(([key, value]) => `${key}=${value}`).join(", ")}`,
      );
    }
  };

  if (report?.package?.status === "failed") {
    const problems = Array.isArray(report?.package?.problems) ? report.package.problems : [];
    if (problems.length > 0) {
      details.push(`package problems: ${problems.join("; ")}`);
    }
    if (report?.package?.failureMessage) {
      details.push(`package failure: ${report.package.failureMessage}`);
    }
    formatArtifactDetails("package", report?.package?.artifacts);
  }
  if (report?.package?.status === "missing" && report?.package?.missingReason) {
    details.push(`package missing: ${report.package.missingReason}`);
  }
  if (report?.package?.status === "skipped" && report?.package?.skippedReason) {
    details.push(`package skipped: ${report.package.skippedReason}`);
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
    formatArtifactDetails("tarball smoke", report?.tarballSmoke?.artifacts);
  }
  if (report?.tarballSmoke?.status === "missing" && report?.tarballSmoke?.missingReason) {
    details.push(`tarball smoke missing: ${report.tarballSmoke.missingReason}`);
  }
  if (report?.tarballSmoke?.status === "skipped" && report?.tarballSmoke?.skippedReason) {
    details.push(`tarball smoke skipped: ${report.tarballSmoke.skippedReason}`);
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
    formatArtifactDetails("docker acceptance", report?.dockerAcceptance?.artifacts);
  }
  if (report?.dockerAcceptance?.status === "missing" && report?.dockerAcceptance?.missingReason) {
    details.push(`docker acceptance missing: ${report.dockerAcceptance.missingReason}`);
  }
  if (report?.dockerAcceptance?.status === "skipped" && report?.dockerAcceptance?.skippedReason) {
    details.push(`docker acceptance skipped: ${report.dockerAcceptance.skippedReason}`);
  }

  return details;
}

function writeAssertionArtifact(outputPath, result) {
  if (!outputPath) {
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function appendAssertionSummary(summaryPath, result) {
  if (!summaryPath) {
    return;
  }

  const lines = [
    "## Release verification assertion",
    "",
    `- Outcome: \`${result.outcome || "unknown"}\``,
    `- Overall status: \`${result.overallStatus || "unknown"}\``,
  ];

  const components = result.components && typeof result.components === "object"
    ? result.components
    : {};
  const componentEntries = Object.entries(components);
  if (componentEntries.length > 0) {
    for (const [name, status] of componentEntries) {
      lines.push(`- ${name}: \`${status}\``);
    }
  }

  if (result.reportPath) {
    lines.push(`- Report: \`${result.reportPath}\``);
  }

  if (result.assertionPath) {
    lines.push(`- Assertion artifact: \`${result.assertionPath}\``);
  }

  const failureDetails = Array.isArray(result.failureDetails) ? result.failureDetails : [];
  if (failureDetails.length > 0) {
    lines.push("- Failure details:");
    for (const detail of failureDetails) {
      lines.push(`  - ${detail}`);
    }
  }

  if (result.error) {
    lines.push(`- Error: ${result.error}`);
  }

  lines.push("");
  fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
}

function buildAssertionResult({
  reportPath,
  assertionPath,
  report,
  outcome,
  failureDetails = [],
  error = "",
}) {
  const componentStatuses = {
    package: report?.package?.status || "unknown",
    tarballSmoke: report?.tarballSmoke?.status || "unknown",
    dockerAcceptance: report?.dockerAcceptance?.status || "unknown",
  };

  return {
    kind: "equip-release-verification-assertion",
    evaluatedAt: new Date().toISOString(),
    outcome,
    reportPath: path.resolve(reportPath),
    assertionPath: path.resolve(assertionPath),
    overallStatus: report?.overallStatus || "unknown",
    components: componentStatuses,
    releaseBootstrap: report?.releaseBootstrap || null,
    releasePreflight: report?.releasePreflight || null,
    package: report?.package
      ? {
          status: report.package.status || "",
          tarballFileName: report.package.tarballFileName || "",
          tarballPath: report.package.tarballPath || "",
          failureMessage: report.package.failureMessage || "",
          missingReason: report.package.missingReason || "",
          skippedReason: report.package.skippedReason || "",
          artifacts: normalizeArtifacts(report.package.artifacts),
        }
      : null,
    tarballSmoke: report?.tarballSmoke
      ? {
          status: report.tarballSmoke.status || "",
          tarballFileName: report.tarballSmoke.tarballFileName || "",
          tarballPath: report.tarballSmoke.tarballPath || "",
          failureMessage: report.tarballSmoke.failureMessage || "",
          missingReason: report.tarballSmoke.missingReason || "",
          skippedReason: report.tarballSmoke.skippedReason || "",
          artifacts: normalizeArtifacts(report.tarballSmoke.artifacts),
        }
      : null,
    dockerAcceptance: report?.dockerAcceptance
      ? {
          status: report.dockerAcceptance.status || "",
          totalDurationMs: report.dockerAcceptance.totalDurationMs ?? 0,
          failureMessage: report.dockerAcceptance.failureMessage || "",
          missingReason: report.dockerAcceptance.missingReason || "",
          skippedReason: report.dockerAcceptance.skippedReason || "",
          artifacts: normalizeArtifacts(report.dockerAcceptance.artifacts),
        }
      : null,
    artifacts: normalizeArtifacts(report?.artifacts),
    artifactNames: normalizeArtifacts(report?.artifactNames),
    failureDetails,
    error,
  };
}

function main() {
  const reportPath =
    process.env.RELEASE_VERIFICATION_REPORT_PATH ||
    path.join(".generated", "release", "release-verification-report.json");
  const assertionPath =
    process.env.RELEASE_VERIFICATION_ASSERTION_PATH ||
    path.join(".generated", "release", "release-verification-assertion.json");
  const summaryPath = process.env.GITHUB_STEP_SUMMARY || "";
  const appendStepSummary =
    (process.env.RELEASE_VERIFICATION_APPEND_STEP_SUMMARY || "true").toLowerCase() !== "false";
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

  const assertionResult = buildAssertionResult({
    reportPath,
    assertionPath,
    report,
    outcome: "passed",
  });
  writeAssertionArtifact(assertionPath, assertionResult);
  if (appendStepSummary) {
    appendAssertionSummary(summaryPath, assertionResult);
  }

  console.log(`[release-verification] status passed for ${reportPath}`);
  console.log(`[release-verification] components: ${componentSummary || "none"}`);
}

try {
  main();
} catch (error) {
  const reportPath =
    process.env.RELEASE_VERIFICATION_REPORT_PATH ||
    path.join(".generated", "release", "release-verification-report.json");
  const assertionPath =
    process.env.RELEASE_VERIFICATION_ASSERTION_PATH ||
    path.join(".generated", "release", "release-verification-assertion.json");
  const report = fs.existsSync(reportPath)
    ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
    : null;
  const appendStepSummary =
    (process.env.RELEASE_VERIFICATION_APPEND_STEP_SUMMARY || "true").toLowerCase() !== "false";
  const failureDetails = report ? buildFailureDetails(report) : [];
  const assertionResult = buildAssertionResult({
    reportPath,
    assertionPath,
    report,
    outcome: "failed",
    failureDetails,
    error: error.message,
  });
  writeAssertionArtifact(assertionPath, assertionResult);
  if (appendStepSummary) {
    appendAssertionSummary(process.env.GITHUB_STEP_SUMMARY || "", assertionResult);
  }
  console.error(`[release-verification] assertion failed: ${error.message}`);
  process.exit(1);
}
