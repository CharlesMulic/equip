import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildReleaseBootstrapResult, writeReleaseBootstrapArtifacts } from "./release-bootstrap-lib.mjs";

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

function runInstallStep({ executable, args, logPath }) {
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
      summary: "dependency install failed to start",
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
        ? "dependency install completed successfully"
        : `dependency install failed${typeof exitCode === "number" ? ` with exit code ${exitCode}` : ""}`,
    error: "",
    logPath: path.resolve(logPath),
  };
}

const resultPath =
  process.env.RELEASE_BOOTSTRAP_RESULT_PATH ||
  path.join(".generated", "release", "release-bootstrap-result.json");
const summaryPath =
  process.env.RELEASE_BOOTSTRAP_SUMMARY_PATH ||
  path.join(".generated", "release", "release-bootstrap-summary.md");
const logPath =
  process.env.RELEASE_BOOTSTRAP_LOG_PATH ||
  path.join(".generated", "release", "release-bootstrap.log");
const executable = process.env.RELEASE_BOOTSTRAP_EXECUTABLE || "npm";
const args = parseArgs(process.env.RELEASE_BOOTSTRAP_ARGS_JSON, ["ci"]);

const installStep = runInstallStep({
  executable,
  args,
  logPath,
});

const result = buildReleaseBootstrapResult({
  installStep,
  artifacts: {
    resultPath: path.resolve(resultPath),
    summaryPath: path.resolve(summaryPath),
    logPath: path.resolve(logPath),
  },
});

writeReleaseBootstrapArtifacts({
  result,
  resultPath,
  summaryPath,
});

console.log(`[release-bootstrap] wrote result ${resultPath}`);
console.log(`[release-bootstrap] wrote summary ${summaryPath}`);

if (result.overallStatus !== "passed") {
  process.exit(1);
}
