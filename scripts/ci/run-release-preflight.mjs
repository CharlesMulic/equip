import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildReleasePreflightResult, writeReleasePreflightArtifacts } from "./release-preflight-lib.mjs";
import { readGitHubWorkflowContext } from "./workflow-context-lib.mjs";

function parseArgs(rawValue, fallback) {
  if (!rawValue) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new Error("expected JSON array of strings");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid command args JSON '${rawValue}': ${error.message}`);
  }
}

function runPhase({ label, executable, args, logPath }) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  fs.writeFileSync(
    logPath,
    `${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`,
    "utf8",
  );

  if (stdout) {
    process.stdout.write(stdout);
  }

  if (stderr) {
    process.stderr.write(stderr);
  }

  const command = [executable, ...args].join(" ");
  if (result.error) {
    return {
      status: "failed",
      exitCode: null,
      command,
      summary: `${label} failed to start`,
      error: result.error.message,
      logPath: path.resolve(logPath),
    };
  }

  const exitCode = typeof result.status === "number" ? result.status : null;
  return {
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
    command,
    summary:
      exitCode === 0
        ? `${label} completed successfully`
        : `${label} failed${typeof exitCode === "number" ? ` with exit code ${exitCode}` : ""}`,
    error: exitCode === 0 ? "" : "",
    logPath: path.resolve(logPath),
  };
}

const resultPath =
  process.env.RELEASE_PREFLIGHT_RESULT_PATH ||
  path.join(".generated", "release", "release-preflight-result.json");
const summaryPath =
  process.env.RELEASE_PREFLIGHT_SUMMARY_PATH ||
  path.join(".generated", "release", "release-preflight-summary.md");
const buildLogPath =
  process.env.RELEASE_PREFLIGHT_BUILD_LOG_PATH ||
  path.join(".generated", "release", "release-preflight-build.log");
const testLogPath =
  process.env.RELEASE_PREFLIGHT_TEST_LOG_PATH ||
  path.join(".generated", "release", "release-preflight-test.log");
const buildExecutable = process.env.RELEASE_PREFLIGHT_BUILD_EXECUTABLE || "npm";
const buildArgs = parseArgs(process.env.RELEASE_PREFLIGHT_BUILD_ARGS_JSON, ["run", "build"]);
const testExecutable = process.env.RELEASE_PREFLIGHT_TEST_EXECUTABLE || "npm";
const testArgs = parseArgs(process.env.RELEASE_PREFLIGHT_TEST_ARGS_JSON, ["test"]);
const artifactName = process.env.RELEASE_PREFLIGHT_ARTIFACT_NAME || "";

const buildPhase = runPhase({
  label: "build",
  executable: buildExecutable,
  args: buildArgs,
  logPath: buildLogPath,
});

let testPhase;
if (buildPhase.status === "passed") {
  testPhase = runPhase({
    label: "test",
    executable: testExecutable,
    args: testArgs,
    logPath: testLogPath,
  });
} else {
  fs.mkdirSync(path.dirname(testLogPath), { recursive: true });
  fs.writeFileSync(testLogPath, "test skipped because build preflight failed\n", "utf8");
  testPhase = {
    status: "skipped",
    exitCode: null,
    command: [testExecutable, ...testArgs].join(" "),
    summary: "test skipped because build preflight failed",
    error: "",
    logPath: path.resolve(testLogPath),
  };
}

const result = buildReleasePreflightResult({
  buildPhase,
  testPhase,
  artifacts: {
    resultPath: path.resolve(resultPath),
    summaryPath: path.resolve(summaryPath),
    buildLogPath: path.resolve(buildLogPath),
    testLogPath: path.resolve(testLogPath),
  },
  artifactNames: {
    bundle: artifactName,
  },
  workflowContext: readGitHubWorkflowContext(process.env),
});

writeReleasePreflightArtifacts({
  result,
  resultPath,
  summaryPath,
});

console.log(`[release-preflight] wrote result ${resultPath}`);
console.log(`[release-preflight] wrote summary ${summaryPath}`);

if (result.overallStatus !== "passed") {
  process.exit(1);
}
