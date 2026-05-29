import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const dockerfile = path.join(repoRoot, "test", "docker", "Dockerfile.mcp-init");
const imageTag = process.env.EQUIP_DOCKER_MCP_INIT_TAG || "cg3-equip-mcp-initialize-smoke:local";
const containerName = `equip-mcp-init-${process.pid}-${Date.now()}`;
const dockerTimeoutMs = Number(process.env.EQUIP_DOCKER_MCP_INIT_TIMEOUT_MS || 120_000);

function candidateExists(candidate) {
  if (path.isAbsolute(candidate)) {
    return fs.existsSync(candidate);
  }

  const probe = spawnSync(candidate, ["--version"], {
    stdio: "pipe",
    shell: false,
    encoding: "utf-8",
  });

  if (probe.error?.code === "ENOENT") return false;
  return probe.status === 0;
}

function resolveDockerBin() {
  const candidates = [];
  if (process.env.DOCKER_BIN) candidates.push(process.env.DOCKER_BIN);
  candidates.push("docker");

  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker",
    );
  }

  for (const candidate of candidates) {
    if (candidateExists(candidate)) return candidate;
  }

  throw new Error("Docker CLI not found. Set DOCKER_BIN or add docker to PATH.");
}

function runOrThrow(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function runDockerSmoke(dockerBin) {
  return new Promise((resolve, reject) => {
    const args = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--network=none",
      "--cpus=1",
      "--memory=512m",
      "--pids-limit=128",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,exec,size=256m",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user",
      "10001:10001",
      imageTag,
    ];

    const child = spawn(dockerBin, args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: false,
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      spawnSync(dockerBin, ["kill", containerName], {
        cwd: repoRoot,
        stdio: "ignore",
        shell: false,
      });
      reject(new Error(`Docker MCP initialize smoke timed out after ${dockerTimeoutMs}ms`));
    }, dockerTimeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${dockerBin} ${args.join(" ")} failed with exit code ${code}`));
      }
    });
  });
}

const dockerBin = resolveDockerBin();

runOrThrow(dockerBin, ["build", "--file", dockerfile, "--tag", imageTag, "."]);
await runDockerSmoke(dockerBin);
