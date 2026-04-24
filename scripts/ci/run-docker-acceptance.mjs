import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appendDockerAcceptanceSummary,
  resolveDockerAcceptanceArtifacts,
  writeDockerAcceptanceArtifacts,
} from "./docker-acceptance-lib.mjs";
import { readGitHubWorkflowContext } from "./workflow-context-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const dockerfile = path.join(repoRoot, "test", "docker", "Dockerfile");
const imageTag = process.env.EQUIP_DOCKER_ACCEPTANCE_TAG || "cg3-equip-acceptance:local";
const workflowContext = readGitHubWorkflowContext(process.env);
const dockerAcceptanceArtifactName =
  process.env.EQUIP_DOCKER_ACCEPTANCE_ARTIFACT_NAME || "docker-acceptance";
const artifactConfig = resolveDockerAcceptanceArtifacts({
  outputDir: process.env.EQUIP_DOCKER_ACCEPTANCE_OUTPUT_DIR || "",
  reportPath: process.env.EQUIP_DOCKER_ACCEPTANCE_REPORT_PATH || "",
  buildLogPath: process.env.EQUIP_DOCKER_ACCEPTANCE_BUILD_LOG_PATH || "",
  runLogPath: process.env.EQUIP_DOCKER_ACCEPTANCE_RUN_LOG_PATH || "",
});

function candidateExists(candidate) {
  if (path.isAbsolute(candidate)) {
    return fs.existsSync(candidate);
  }

  const probe = spawnSync(candidate, ["--version"], {
    stdio: "pipe",
    shell: false,
    encoding: "utf-8",
  });

  if (probe.error?.code === "ENOENT") {
    return false;
  }

  return probe.status === 0;
}

function resolveDockerBin() {
  const candidates = [];

  if (process.env.DOCKER_BIN) {
    candidates.push(process.env.DOCKER_BIN);
  }

  candidates.push("docker");

  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker",
    );
  }

  for (const candidate of candidates) {
    if (candidateExists(candidate)) {
      return candidate;
    }
  }

  throw new Error("Docker CLI not found. Set DOCKER_BIN or add docker to PATH.");
}

function streamOutput(label, text) {
  if (!text) {
    return;
  }

  const normalized = text.endsWith("\n") ? text : `${text}\n`;
  process.stdout.write(`[docker-acceptance:${label}]\n`);
  process.stdout.write(normalized);
}

function runOrThrow(cmd, args, name) {
  const startedAt = Date.now();
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "pipe",
    shell: false,
    encoding: "utf8",
  });

  streamOutput(name, result.stdout || "");
  if (result.stderr) {
    process.stderr.write(`[docker-acceptance:${name}:stderr]\n`);
    process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  }

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${result.status}`);
  }

  return {
    name,
    command: cmd,
    args,
    durationMs: Date.now() - startedAt,
    exitCode: result.status ?? 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

const dockerBin = resolveDockerBin();
const startedAt = Date.now();
let buildStep = null;
let runStep = null;
let status = "passed";
let failureMessage = "";

try {
  buildStep = runOrThrow(dockerBin, ["build", "--file", dockerfile, "--tag", imageTag, "."], "docker-build");
  runStep = runOrThrow(dockerBin, ["run", "--rm", imageTag], "docker-run");
} catch (error) {
  status = "failed";
  failureMessage = error instanceof Error ? error.message : String(error);
} finally {
  const report = {
    kind: "equip-docker-acceptance-report",
    generatedAt: new Date().toISOString(),
    status,
    failureMessage,
    dockerBin,
    imageTag,
    dockerfile,
    workflowContext,
    artifactNames: {
      bundle: dockerAcceptanceArtifactName,
    },
    totalDurationMs: Date.now() - startedAt,
    steps: [buildStep, runStep]
      .filter(Boolean)
      .map((step) => ({
        name: step.name,
        command: step.command,
        args: step.args,
        durationMs: step.durationMs,
        exitCode: step.exitCode,
      })),
    artifacts: {
      reportPath: artifactConfig.reportPath,
      buildLogPath: artifactConfig.buildLogPath,
      runLogPath: artifactConfig.runLogPath,
    },
  };

  writeDockerAcceptanceArtifacts({
    reportPath: artifactConfig.reportPath,
    buildLogPath: artifactConfig.buildLogPath,
    runLogPath: artifactConfig.runLogPath,
    buildLog: buildStep ? `${buildStep.stdout}${buildStep.stderr}` : "",
    runLog: runStep ? `${runStep.stdout}${runStep.stderr}` : "",
    report,
  });

  appendDockerAcceptanceSummary({
    summaryPath: process.env.GITHUB_STEP_SUMMARY || "",
    report,
  });
}

if (status !== "passed") {
  throw new Error(failureMessage || "Docker acceptance failed.");
}
