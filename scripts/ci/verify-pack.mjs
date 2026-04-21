import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { verifyPackMetadata } from "./pack-verification-lib.mjs";

const outputPath = process.env.PACK_VERIFICATION_OUTPUT_PATH || null;
const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY || null;
const tarballOutputDir = process.env.PACK_TARBALL_OUTPUT_DIR || "";

function writeVerificationArtifact(verification) {
  if (!outputPath) {
    return;
  }

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
}

function appendSummary(verification) {
  if (!stepSummaryPath) {
    return;
  }

  appendFileSync(
    stepSummaryPath,
    [
      "## npm pack verification",
      "",
      verification.packageName && verification.version
        ? `- Package: \`${verification.packageName}@${verification.version}\``
        : "- Package: unavailable",
      `- Status: \`${verification.hasFailures ? "failed" : "passed"}\``,
      `- Tarball: ${verification.tarballFileName || "dry-run only"}`,
      verification.packageSizeBytes
        ? `- Tarball size: ${verification.packageSizeBytes} bytes`
        : null,
      `- Entries: ${verification.entryCount}`,
      `- Unpacked size: ${verification.unpackedSize} bytes`,
      `- Required files checked: ${verification.requiredFilesChecked.length}`,
      `- Forbidden prefixes checked: ${verification.forbiddenPrefixesChecked.join(", ") || "(none)"}`,
      verification.shasum ? `- Tarball shasum: \`${verification.shasum}\`` : null,
      verification.problems.length > 0 ? `- Problems: ${verification.problems.join("; ")}` : null,
      "",
    ].filter(Boolean).join("\n"),
    "utf8",
  );
}

let verification;

try {
  if (tarballOutputDir) {
    mkdirSync(tarballOutputDir, { recursive: true });
  }

  const packCommand = tarballOutputDir
    ? `npm pack --json --pack-destination "${tarballOutputDir}"`
    : "npm pack --dry-run --json";

  const output = execSync(packCommand, {
    encoding: "utf8",
    env: process.env,
    shell: true,
  });

  const metadata = JSON.parse(output);
  verification = verifyPackMetadata(metadata);
  const tarballPath =
    tarballOutputDir && verification.tarballFileName
      ? path.resolve(tarballOutputDir, verification.tarballFileName)
      : "";
  verification = {
    ...verification,
    status: verification.hasFailures ? "failed" : "passed",
    failureMessage: verification.hasFailures ? verification.problems.join("; ") : "",
    tarballPath: tarballPath && existsSync(tarballPath) ? tarballPath : "",
  };
} catch (error) {
  verification = {
    kind: "equip-pack-verification",
    status: "failed",
    packageName: "",
    version: "",
    tarballFileName: "",
    tarballPath: "",
    packageSizeBytes: 0,
    shasum: "",
    integrity: "",
    entryCount: 0,
    unpackedSize: 0,
    requiredFilesChecked: [],
    forbiddenPrefixesChecked: [],
    missingRequiredFiles: [],
    forbiddenFiles: [],
    hasFailures: true,
    problems: [error instanceof Error ? error.message : String(error)],
    failureMessage: error instanceof Error ? error.message : String(error),
  };
}

writeVerificationArtifact(verification);
appendSummary(verification);

if (verification.hasFailures) {
  throw new Error(`npm pack verification failed:\n- ${verification.problems.join("\n- ")}`);
}

console.log(
  `[pack] verified ${verification.packageName}@${verification.version} with ${verification.entryCount} files (${verification.unpackedSize} bytes unpacked${verification.tarballFileName ? `; tarball ${verification.tarballFileName}` : ""})`,
);
