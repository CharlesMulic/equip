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

function summarizeInstallStep(step) {
  if (!step) {
    return "dependency install result missing";
  }

  if (step.status === "passed") {
    return "dependency install passed";
  }

  return `dependency install failed${typeof step.exitCode === "number" ? ` (exit ${step.exitCode})` : ""}`;
}

export function buildReleaseBootstrapResult({
  installStep = null,
  artifacts = {},
  generatedAt = new Date().toISOString(),
}) {
  const normalizedInstall = installStep || {
    status: "missing",
    exitCode: null,
    command: "",
    summary: "dependency install result missing",
  };

  return {
    kind: "equip-release-bootstrap-result",
    generatedAt,
    overallStatus: normalizedInstall.status === "passed" ? "passed" : "failed",
    summary: summarizeInstallStep(normalizedInstall),
    steps: {
      install: normalizedInstall,
    },
    artifacts: normalizeArtifacts(artifacts),
  };
}

export function buildReleaseBootstrapSummaryMarkdown({ result }) {
  const lines = [
    "# Release Bootstrap Summary",
    "",
    `- Overall status: \`${result.overallStatus || "unknown"}\``,
    `- Install: \`${result.steps?.install?.status || "unknown"}\``,
  ];

  if (result.summary) {
    lines.push(`- Summary: ${result.summary}`);
  }

  const install = result.steps?.install;
  if (install) {
    lines.push("", "## Install", "");
    lines.push(`- Status: \`${install.status || "unknown"}\``);
    if (install.command) {
      lines.push(`- Command: \`${install.command}\``);
    }
    if (typeof install.exitCode === "number") {
      lines.push(`- Exit code: \`${install.exitCode}\``);
    }
    if (install.summary) {
      lines.push(`- Summary: ${install.summary}`);
    }
    if (install.error) {
      lines.push(`- Error: ${install.error}`);
    }
  }

  const artifactEntries = Object.entries(result.artifacts || {}).filter(([, value]) => value);
  if (artifactEntries.length > 0) {
    lines.push("", "## Evidence files", "");
    for (const [name, artifactPath] of artifactEntries) {
      lines.push(`- ${name}: ${artifactPath}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function writeReleaseBootstrapArtifacts({
  result,
  resultPath,
  summaryPath,
}) {
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  if (summaryPath) {
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, buildReleaseBootstrapSummaryMarkdown({ result }), "utf8");
  }

  return result;
}
