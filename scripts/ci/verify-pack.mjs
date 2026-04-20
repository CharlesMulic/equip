import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPackMetadata } from "./pack-verification-lib.mjs";

const outputPath = process.env.PACK_VERIFICATION_OUTPUT_PATH || null;
const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY || null;
const tarballOutputDir = process.env.PACK_TARBALL_OUTPUT_DIR || "";

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
const verification = assertPackMetadata(metadata);
const tarballPath =
  tarballOutputDir && verification.tarballFileName
    ? path.resolve(tarballOutputDir, verification.tarballFileName)
    : "";
const verificationWithArtifact = {
  ...verification,
  tarballPath: tarballPath && existsSync(tarballPath) ? tarballPath : "",
};

if (outputPath) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(verificationWithArtifact, null, 2)}\n`, "utf8");
}

if (stepSummaryPath) {
  appendFileSync(
    stepSummaryPath,
    [
      "## npm pack verification",
      "",
      `- Package: \`${verification.packageName}@${verification.version}\``,
      `- Tarball: ${verification.tarballFileName || "dry-run only"}`,
      verification.packageSizeBytes
        ? `- Tarball size: ${verification.packageSizeBytes} bytes`
        : null,
      `- Entries: ${verification.entryCount}`,
      `- Unpacked size: ${verification.unpackedSize} bytes`,
      `- Required files checked: ${verification.requiredFilesChecked.length}`,
      `- Forbidden prefixes checked: ${verification.forbiddenPrefixesChecked.join(", ")}`,
      verification.shasum ? `- Tarball shasum: \`${verification.shasum}\`` : null,
      "",
    ].filter(Boolean).join("\n"),
    "utf8",
  );
}

console.log(
  `[pack] verified ${verification.packageName}@${verification.version} with ${verification.entryCount} files (${verification.unpackedSize} bytes unpacked${verification.tarballFileName ? `; tarball ${verification.tarballFileName}` : ""})`,
);
