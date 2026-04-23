import fs from "node:fs";
import path from "node:path";

function normalizeArtifacts(artifacts) {
  if (!artifacts || typeof artifacts !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(artifacts).map(([key, value]) => [key, typeof value === "string" ? value : ""]),
  );
}

function normalizeArtifactNames(artifactNames) {
  if (!artifactNames || typeof artifactNames !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(artifactNames).map(([key, value]) => [key, typeof value === "string" ? value : ""]),
  );
}

function buildReleaseVerificationStatus(report) {
  if (!report) {
    return {
      status: "missing",
      summary: "release verification report missing",
    };
  }

  return {
    status: report.overallStatus || "unknown",
    summary: report.summary || "",
  };
}

function buildReleaseBootstrapStatus(result) {
  if (!result) {
    return {
      status: "missing",
      summary: "release bootstrap result missing",
    };
  }

  return {
    status: result.overallStatus || "unknown",
    summary: result.summary || "",
  };
}

function buildReleasePreflightStatus(result, releaseBootstrapResult) {
  if (!result) {
    if (releaseBootstrapResult && releaseBootstrapResult.overallStatus !== "passed") {
      return {
        status: "skipped",
        summary: "release preflight skipped because release bootstrap did not pass",
      };
    }

    return {
      status: "missing",
      summary: "release preflight result missing",
    };
  }

  return {
    status: result.overallStatus || "unknown",
    summary: result.summary || "",
  };
}

function buildChangesetsStatus(report) {
  if (!report) {
    return {
      status: "missing",
      summary: "changesets release report missing",
    };
  }

  return {
    status: report.status || "unknown",
    summary: report.result?.summary || "",
  };
}

function buildOverallStatus(
  releaseBootstrapResult,
  releasePreflightResult,
  releaseVerificationReport,
  changesetsReleaseReport,
) {
  if (!releaseBootstrapResult || !releasePreflightResult || !releaseVerificationReport || !changesetsReleaseReport) {
    return "failed";
  }

  const releaseBootstrapStatus = releaseBootstrapResult.overallStatus || "unknown";
  const releasePreflightStatus = releasePreflightResult.overallStatus || "unknown";
  const releaseVerificationStatus = releaseVerificationReport.overallStatus || "unknown";
  const changesetsStatus = changesetsReleaseReport.status || "unknown";

  if (releaseBootstrapStatus !== "passed") {
    return "failed";
  }

  if (releasePreflightStatus !== "passed") {
    return "failed";
  }

  if (releaseVerificationStatus !== "passed") {
    return "failed";
  }

  if (changesetsStatus === "failed") {
    return "failed";
  }

  if (changesetsStatus === "published") {
    return "published";
  }

  if (changesetsStatus === "completed") {
    return "completed";
  }

  return "unknown";
}

export function buildReleaseWorkflowReport({
  releaseBootstrapResult = null,
  releasePreflightResult = null,
  releaseVerificationReport = null,
  changesetsReleaseReport = null,
  assertionArtifact = null,
  artifacts = {},
  artifactNames = {},
  generatedAt = new Date().toISOString(),
}) {
  return {
    kind: "equip-release-workflow-report",
    generatedAt,
    overallStatus:
      assertionArtifact?.assertion?.outcome === "failed"
        ? "failed"
        : buildOverallStatus(
            releaseBootstrapResult,
            releasePreflightResult,
            releaseVerificationReport,
            changesetsReleaseReport,
          ),
    releaseBootstrap: buildReleaseBootstrapStatus(releaseBootstrapResult),
    releasePreflight: buildReleasePreflightStatus(releasePreflightResult, releaseBootstrapResult),
    releaseVerification: buildReleaseVerificationStatus(releaseVerificationReport),
    changesetsRelease: buildChangesetsStatus(changesetsReleaseReport),
    inputs: {
      hasReleaseBootstrapResult: !!releaseBootstrapResult,
      hasReleasePreflightResult: !!releasePreflightResult,
      hasReleaseVerificationReport: !!releaseVerificationReport,
      hasChangesetsReleaseReport: !!changesetsReleaseReport,
    },
    reports: {
      releaseBootstrap: releaseBootstrapResult,
      releasePreflight: releasePreflightResult,
      releaseVerification: releaseVerificationReport,
      changesetsRelease: changesetsReleaseReport,
    },
    assertion: assertionArtifact?.assertion
      ? {
          outcome: assertionArtifact.assertion.outcome || "",
          actualStatus: assertionArtifact.assertion.actualStatus || "",
          allowedStatuses: Array.isArray(assertionArtifact.assertion.allowedStatuses)
            ? assertionArtifact.assertion.allowedStatuses
            : [],
          error: assertionArtifact.assertion.error || "",
          failureDetails: Array.isArray(assertionArtifact.assertion.failureDetails)
            ? assertionArtifact.assertion.failureDetails
            : [],
        }
      : null,
    artifacts: normalizeArtifacts(artifacts),
    artifactNames: normalizeArtifactNames(artifactNames),
  };
}

export function buildReleaseWorkflowSummaryMarkdown({ report }) {
  const lines = [
    "# Release Workflow Summary",
    "",
    `- Overall status: \`${report.overallStatus || "unknown"}\``,
    `- Release bootstrap: \`${report.releaseBootstrap?.status || "unknown"}\``,
    `- Release preflight: \`${report.releasePreflight?.status || "unknown"}\``,
    `- Release verification: \`${report.releaseVerification?.status || "unknown"}\``,
    `- Changesets release: \`${report.changesetsRelease?.status || "unknown"}\``,
  ];

  if (report.releaseBootstrap?.summary) {
    lines.push(`- Release bootstrap summary: ${report.releaseBootstrap.summary}`);
  }

  if (report.releasePreflight?.summary) {
    lines.push(`- Release preflight summary: ${report.releasePreflight.summary}`);
  }

  if (report.releaseVerification?.summary) {
    lines.push(`- Release verification summary: ${report.releaseVerification.summary}`);
  }

  if (report.changesetsRelease?.summary) {
    lines.push(`- Changesets summary: ${report.changesetsRelease.summary}`);
  }

  if (
    !report.inputs?.hasReleaseBootstrapResult ||
    !report.inputs?.hasReleasePreflightResult ||
    !report.inputs?.hasReleaseVerificationReport ||
    !report.inputs?.hasChangesetsReleaseReport
  ) {
    lines.push("", "## Missing inputs", "");

    if (!report.inputs?.hasReleaseBootstrapResult) {
      lines.push("- Release bootstrap result was missing.");
    }

    if (!report.inputs?.hasReleasePreflightResult && report.releasePreflight?.status !== "skipped") {
      lines.push("- Release preflight result was missing.");
    }

    if (!report.inputs?.hasReleaseVerificationReport) {
      lines.push("- Release verification report was missing.");
    }

    if (!report.inputs?.hasChangesetsReleaseReport) {
      lines.push("- Changesets release report was missing.");
    }
  }

  if (report.assertion) {
    lines.push("", "## Final assertion", "");
    lines.push(`- Outcome: \`${report.assertion.outcome || "unknown"}\``);
    lines.push(`- Actual status: \`${report.assertion.actualStatus || "unknown"}\``);

    if (Array.isArray(report.assertion.allowedStatuses) && report.assertion.allowedStatuses.length > 0) {
      lines.push(`- Allowed statuses: \`${report.assertion.allowedStatuses.join(", ")}\``);
    }

    if (report.assertion.error) {
      lines.push(`- Error: ${report.assertion.error}`);
    }

    if (Array.isArray(report.assertion.failureDetails) && report.assertion.failureDetails.length > 0) {
      lines.push("- Failure details:");
      for (const detail of report.assertion.failureDetails) {
        lines.push(`  - ${detail}`);
      }
    }
  }

  const artifactEntries = Object.entries(report.artifactNames || {}).filter(([, value]) => value);
  if (artifactEntries.length > 0) {
    lines.push("", "## Evidence artifacts", "");
    for (const [key, value] of artifactEntries) {
      const label = key
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/^./, (char) => char.toUpperCase());
      lines.push(`- ${label}: \`${value}\``);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function writeReleaseWorkflowReportArtifact({ report, outPath }) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
