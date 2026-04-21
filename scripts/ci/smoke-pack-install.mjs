import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const outputPath = process.env.PACK_INSTALL_SMOKE_OUTPUT_PATH || null;
const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY || null;
const explicitTarballPath = process.env.PACK_TARBALL_PATH || "";
const tarballOutputDir = process.env.PACK_TARBALL_OUTPUT_DIR || "";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = {
  kind: "equip-pack-install-smoke",
  generatedAt: new Date().toISOString(),
  status: "failed",
  failureMessage: "",
  tarballPath: "",
  tarballFileName: "",
  installedVersion: "",
  installRoot: "",
  equipVersion: "",
  unequipVersion: "",
  helpIncludesUsage: false,
  exportsCheck: "",
};

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    shell: options.shell ?? (process.platform === "win32" && command.toLowerCase().endsWith(".cmd")),
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env || process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}\n${result.stderr || result.stdout || ""}`.trim(),
    );
  }

  return (result.stdout || "").trim();
}

function resolveTarballFromDirectory(dir) {
  const absoluteDir = path.resolve(dir);
  if (!existsSync(absoluteDir) || !statSync(absoluteDir).isDirectory()) {
    throw new Error(`PACK_TARBALL_OUTPUT_DIR does not exist or is not a directory: ${absoluteDir}`);
  }

  const tarballs = readdirSync(absoluteDir)
    .filter((entry) => entry.toLowerCase().endsWith(".tgz"))
    .sort((a, b) => a.localeCompare(b));

  if (tarballs.length !== 1) {
    throw new Error(
      `Expected exactly one .tgz in ${absoluteDir}, found ${tarballs.length}: ${tarballs.join(", ") || "(none)"}`,
    );
  }

  return path.join(absoluteDir, tarballs[0]);
}

function createTarballInTempDir() {
  const packDir = mkdtempSync(path.join(os.tmpdir(), "equip-pack-smoke-tarball-"));
  const output = runOrThrow(npmCommand, ["pack", "--json", "--pack-destination", packDir], {
    cwd: repoRoot,
  });
  const packEntries = JSON.parse(output);
  const tarballFileName = packEntries?.[0]?.filename;
  if (!tarballFileName) {
    throw new Error("npm pack did not return a tarball filename.");
  }
  return path.join(packDir, tarballFileName);
}

function resolveTarballPath() {
  if (explicitTarballPath) {
    const absolutePath = path.resolve(explicitTarballPath);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new Error(`PACK_TARBALL_PATH does not exist or is not a file: ${absolutePath}`);
    }
    return absolutePath;
  }

  if (tarballOutputDir) {
    return resolveTarballFromDirectory(tarballOutputDir);
  }

  return createTarballInTempDir();
}

function writeResultArtifact() {
  if (!outputPath) {
    return;
  }

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function appendSummary() {
  if (!stepSummaryPath) {
    return;
  }

  appendFileSync(
    stepSummaryPath,
    [
      "## npm tarball install smoke",
      "",
      `- Status: \`${result.status}\``,
      `- Tarball: \`${result.tarballFileName || "unavailable"}\``,
      `- Installed version: \`${result.installedVersion || "unknown"}\``,
      `- equip --version: \`${result.equipVersion || "unknown"}\``,
      `- unequip --version: \`${result.unequipVersion || "unknown"}\``,
      `- Help check: ${result.helpIncludesUsage ? "passed" : "failed"}`,
      result.failureMessage ? `- Failure: ${result.failureMessage}` : null,
      "",
    ].filter(Boolean).join("\n"),
    "utf8",
  );
}

try {
  const tarballPath = resolveTarballPath();
  const installRoot = mkdtempSync(path.join(os.tmpdir(), "equip-pack-install-smoke-"));
  const packageJsonPath = path.join(installRoot, "package.json");

  result.tarballPath = tarballPath;
  result.tarballFileName = path.basename(tarballPath);
  result.installRoot = installRoot;

  mkdirSync(installRoot, { recursive: true });
  writeFileSync(
    packageJsonPath,
    `${JSON.stringify({ name: "equip-pack-smoke", private: true }, null, 2)}\n`,
    "utf8",
  );

  runOrThrow(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-fund",
      "--no-audit",
      tarballPath,
    ],
    { cwd: installRoot },
  );

  const installedPackageDir = path.join(installRoot, "node_modules", "@cg3", "equip");
  const installedPackageJson = JSON.parse(
    readFileSync(path.join(installedPackageDir, "package.json"), "utf8"),
  );

  result.installedVersion = installedPackageJson.version;
  result.equipVersion = runOrThrow(
    process.execPath,
    [path.join(installedPackageDir, "bin", "equip.js"), "--version"],
    { cwd: installRoot },
  );

  const equipHelp = runOrThrow(
    process.execPath,
    [path.join(installedPackageDir, "bin", "equip.js"), "--help"],
    { cwd: installRoot },
  );

  result.unequipVersion = runOrThrow(
    process.execPath,
    [path.join(installedPackageDir, "bin", "unequip.js"), "--version"],
    { cwd: installRoot },
  );

  result.exportsCheck = runOrThrow(
    process.execPath,
    [
      "-e",
      [
        "const lib = require('@cg3/equip');",
        "if (typeof lib.Augment !== 'function') throw new Error('Augment export missing');",
        "if (typeof lib.createManualPlatform !== 'function') throw new Error('createManualPlatform export missing');",
        "console.log('exports-ok');",
      ].join(" "),
    ],
    { cwd: installRoot },
  );

  result.helpIncludesUsage = /Usage: equip/.test(equipHelp);
  if (!result.helpIncludesUsage) {
    throw new Error("Installed equip --help output did not include the expected usage header.");
  }

  if (result.exportsCheck !== "exports-ok") {
    throw new Error(`Unexpected export smoke output: ${result.exportsCheck}`);
  }

  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failureMessage = error instanceof Error ? error.message : String(error);
}

writeResultArtifact();
appendSummary();

if (result.status !== "passed") {
  throw new Error(result.failureMessage || "npm tarball install smoke failed.");
}

console.log(
  `[pack-smoke] installed @cg3/equip@${result.installedVersion} from ${result.tarballFileName}`,
);
