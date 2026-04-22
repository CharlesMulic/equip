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

function buildOverallStatus(releaseVerificationReport, changesetsReleaseReport) {
  if (!releaseVerificationReport || !changesetsReleaseReport) {
    return "failed";
  }

  const releaseVerificationStatus = releaseVerificationReport.overallStatus || "unknown";
  const changesetsStatus = changesetsReleaseReport.status || "unknown";

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
  releaseVerificationReport = null,
  changesetsReleaseReport = null,
  artifacts = {},
  artifactNames = {},
  generatedAt = new Date().toISOString(),
}) {
  return {
    kind: "equip-release-workflow-report",
    generatedAt,
    overallStatus: buildOverallStatus(releaseVerificationReport, changesetsReleaseReport),
    releaseVerification: buildReleaseVerificationStatus(releaseVerificationReport),
    changesetsRelease: buildChangesetsStatus(changesetsReleaseReport),
    inputs: {
      hasReleaseVerificationReport: !!releaseVerificationReport,
      hasChangesetsReleaseReport: !!changesetsReleaseReport,
    },
    reports: {
      releaseVerification: releaseVerificationReport,
      changesetsRelease: changesetsReleaseReport,
    },
    artifacts: normalizeArtifacts(artifacts),
    artifactNames: normalizeArtifactNames(artifactNames),
  };
}

export function buildReleaseWorkflowSummaryMarkdown({ report }) {
  const lines = [
    "# Release Workflow Summary",
    "",
    `- Overall status: \`${report.overallStatus || "unknown"}\``,
    `- Release verification: \`${report.releaseVerification?.status || "unknown"}\``,
    `- Changesets release: \`${report.changesetsRelease?.status || "unknown"}\``,
  ];

  if (report.releaseVerification?.summary) {
    lines.push(`- Release verification summary: ${report.releaseVerification.summary}`);
  }

  if (report.changesetsRelease?.summary) {
    lines.push(`- Changesets summary: ${report.changesetsRelease.summary}`);
  }

  if (!report.inputs?.hasReleaseVerificationReport || !report.inputs?.hasChangesetsReleaseReport) {
    lines.push("", "## Missing inputs", "");

    if (!report.inputs?.hasReleaseVerificationReport) {
      lines.push("- Release verification report was missing.");
    }

    if (!report.inputs?.hasChangesetsReleaseReport) {
      lines.push("- Changesets release report was missing.");
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
