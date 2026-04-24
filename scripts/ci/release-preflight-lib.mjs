import fs from "node:fs";
import path from "node:path";
import {
  appendGitHubWorkflowContextSection,
  normalizeWorkflowContext,
} from "./workflow-context-lib.mjs";

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

function summarizePhase(label, phase) {
  if (!phase) {
    return `${label} phase result missing`;
  }

  if (phase.status === "passed") {
    return `${label} passed`;
  }

  if (phase.status === "skipped") {
    return `${label} skipped`;
  }

  return `${label} failed${typeof phase.exitCode === "number" ? ` (exit ${phase.exitCode})` : ""}`;
}

export function buildReleasePreflightResult({
  buildPhase = null,
  testPhase = null,
  artifacts = {},
  artifactNames = {},
  workflowContext = {},
  generatedAt = new Date().toISOString(),
}) {
  const normalizedBuild = buildPhase || {
    status: "missing",
    exitCode: null,
    command: "",
    summary: "build phase result missing",
  };
  const normalizedTest = testPhase || {
    status: "missing",
    exitCode: null,
    command: "",
    summary: "test phase result missing",
  };
  const overallStatus =
    normalizedBuild.status === "passed" && normalizedTest.status === "passed" ? "passed" : "failed";

  return {
    kind: "equip-release-preflight-result",
    generatedAt,
    overallStatus,
    summary: `${summarizePhase("build", normalizedBuild)}; ${summarizePhase("test", normalizedTest)}`,
    phases: {
      build: normalizedBuild,
      test: normalizedTest,
    },
    artifacts: normalizeArtifacts(artifacts),
    artifactNames: normalizeArtifactNames(artifactNames),
    workflowContext: normalizeWorkflowContext(workflowContext),
  };
}

export function buildReleasePreflightSummaryMarkdown({ result }) {
  const lines = [
    "# Release Preflight Summary",
    "",
    `- Overall status: \`${result.overallStatus || "unknown"}\``,
    `- Build: \`${result.phases?.build?.status || "unknown"}\``,
    `- Test: \`${result.phases?.test?.status || "unknown"}\``,
  ];

  if (result.summary) {
    lines.push(`- Summary: ${result.summary}`);
  }

  for (const [name, phase] of Object.entries(result.phases || {})) {
    lines.push("", `## ${name[0].toUpperCase()}${name.slice(1)}`, "");
    lines.push(`- Status: \`${phase?.status || "unknown"}\``);
    if (phase?.command) {
      lines.push(`- Command: \`${phase.command}\``);
    }
    if (typeof phase?.exitCode === "number") {
      lines.push(`- Exit code: \`${phase.exitCode}\``);
    }
    if (phase?.summary) {
      lines.push(`- Summary: ${phase.summary}`);
    }
    if (phase?.error) {
      lines.push(`- Error: ${phase.error}`);
    }
  }

  const artifactEntries = Object.entries(result.artifacts || {}).filter(([, value]) => value);
  if (artifactEntries.length > 0) {
    lines.push("", "## Evidence files", "");
    for (const [name, artifactPath] of artifactEntries) {
      lines.push(`- ${name}: ${artifactPath}`);
    }
  }

  const artifactNameEntries = Object.entries(result.artifactNames || {}).filter(([, value]) => value);
  if (artifactNameEntries.length > 0) {
    lines.push("", "## Evidence artifacts", "");
    for (const [name, artifactName] of artifactNameEntries) {
      lines.push(`- ${name}: \`${artifactName}\``);
    }
  }

  appendGitHubWorkflowContextSection(lines, result.workflowContext);

  return `${lines.join("\n")}\n`;
}

export function writeReleasePreflightArtifacts({
  result,
  resultPath,
  summaryPath,
}) {
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  if (summaryPath) {
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, buildReleasePreflightSummaryMarkdown({ result }), "utf8");
  }

  return result;
}
