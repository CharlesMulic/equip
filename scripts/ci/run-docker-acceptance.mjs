import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const dockerfile = path.join(repoRoot, "test", "docker", "Dockerfile");
const imageTag = process.env.EQUIP_DOCKER_ACCEPTANCE_TAG || "cg3-equip-acceptance:local";

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

function runOrThrow(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

const dockerBin = resolveDockerBin();

runOrThrow(dockerBin, ["build", "--file", dockerfile, "--tag", imageTag, "."]);
runOrThrow(dockerBin, ["run", "--rm", imageTag]);
