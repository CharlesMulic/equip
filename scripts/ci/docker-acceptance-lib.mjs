import fs from "node:fs";
import path from "node:path";
import { appendGitHubWorkflowContextSection } from "./workflow-context-lib.mjs";

export function resolveDockerAcceptanceArtifacts({
  outputDir = "",
  reportPath = "",
  buildLogPath = "",
  runLogPath = "",
}) {
  const resolvedOutputDir = outputDir ? path.resolve(outputDir) : "";
  const resolvedReportPath = reportPath
    ? path.resolve(reportPath)
    : resolvedOutputDir
      ? path.join(resolvedOutputDir, "docker-acceptance-report.json")
      : "";
  const resolvedBuildLogPath = buildLogPath
    ? path.resolve(buildLogPath)
    : resolvedOutputDir
      ? path.join(resolvedOutputDir, "docker-build.log")
      : "";
  const resolvedRunLogPath = runLogPath
    ? path.resolve(runLogPath)
    : resolvedOutputDir
      ? path.join(resolvedOutputDir, "docker-run.log")
      : "";

  return {
    outputDir: resolvedOutputDir,
    reportPath: resolvedReportPath,
    buildLogPath: resolvedBuildLogPath,
    runLogPath: resolvedRunLogPath,
  };
}

export function deriveDockerAcceptanceEvidenceFileNames({
  reportPath = "",
  buildLogPath = "",
  runLogPath = "",
}) {
  return {
    reportPath: reportPath ? path.basename(reportPath) : "",
    buildLogPath: buildLogPath ? path.basename(buildLogPath) : "",
    runLogPath: runLogPath ? path.basename(runLogPath) : "",
  };
}

export function writeDockerAcceptanceArtifacts({
  reportPath = "",
  buildLogPath = "",
  runLogPath = "",
  buildLog = "",
  runLog = "",
  report,
}) {
  if (buildLogPath) {
    fs.mkdirSync(path.dirname(buildLogPath), { recursive: true });
    fs.writeFileSync(buildLogPath, buildLog, "utf8");
  }

  if (runLogPath) {
    fs.mkdirSync(path.dirname(runLogPath), { recursive: true });
    fs.writeFileSync(runLogPath, runLog, "utf8");
  }

  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}

export function appendDockerAcceptanceSummary({
  summaryPath = "",
  report,
}) {
  if (!summaryPath) {
    return;
  }

  const buildStep = report.steps.find((step) => step.name === "docker-build") || null;
  const runStep = report.steps.find((step) => step.name === "docker-run") || null;

  const lines = [
    "## Docker acceptance",
    "",
    `- Status: \`${report.status}\``,
    `- Docker CLI: \`${report.dockerBin}\``,
    `- Image tag: \`${report.imageTag}\``,
    `- Total duration: \`${report.totalDurationMs} ms\``,
  ];

  if (buildStep) {
    lines.push(`- Build duration: \`${buildStep.durationMs} ms\``);
  }

  if (runStep) {
    lines.push(`- Run duration: \`${runStep.durationMs} ms\``);
  }

  if (report.artifacts?.reportPath) {
    lines.push(`- Report: \`${report.artifacts.reportPath}\``);
  }

  if (report.artifacts?.buildLogPath) {
    lines.push(`- Build log: \`${report.artifacts.buildLogPath}\``);
  }

  if (report.artifacts?.runLogPath) {
    lines.push(`- Run log: \`${report.artifacts.runLogPath}\``);
  }

  appendGitHubWorkflowContextSection(lines, report.workflowContext);

  const artifactNameEntries = Object.entries(report.artifactNames || {}).filter(([, value]) => value);
  if (artifactNameEntries.length > 0) {
    lines.push("", "## Evidence artifacts", "");
    for (const [name, artifactName] of artifactNameEntries) {
      lines.push(`- ${name}: \`${artifactName}\``);
    }
  }

  const evidenceFileNameEntries = Object.entries(report.evidenceFileNames || {}).filter(
    ([, value]) => value,
  );
  if (evidenceFileNameEntries.length > 0) {
    lines.push("", "## Evidence file names", "");
    for (const [name, fileName] of evidenceFileNameEntries) {
      lines.push(`- ${name}: \`${fileName}\``);
    }
  }

  lines.push("");
  fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
}
