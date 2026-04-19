import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPackMetadata } from "./pack-verification-lib.mjs";

const outputPath = process.env.PACK_VERIFICATION_OUTPUT_PATH || null;
const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY || null;

const output = execSync("npm pack --dry-run --json", {
  encoding: "utf8",
  env: process.env,
  shell: true,
});

const metadata = JSON.parse(output);
const verification = assertPackMetadata(metadata);

if (outputPath) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
}

if (stepSummaryPath) {
  appendFileSync(
    stepSummaryPath,
    [
      "## npm pack verification",
      "",
      `- Package: \`${verification.packageName}@${verification.version}\``,
      `- Entries: ${verification.entryCount}`,
      `- Unpacked size: ${verification.unpackedSize} bytes`,
      `- Required files checked: ${verification.requiredFilesChecked.length}`,
      `- Forbidden prefixes checked: ${verification.forbiddenPrefixesChecked.join(", ")}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

console.log(
  `[pack] verified ${verification.packageName}@${verification.version} with ${verification.entryCount} files (${verification.unpackedSize} bytes unpacked)`,
);
