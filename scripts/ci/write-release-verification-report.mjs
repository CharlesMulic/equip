import fs from "node:fs";
import path from "node:path";
import {
  appendReleaseVerificationSummary,
  buildReleaseVerificationReport,
  rebaseReleaseVerificationInputs,
} from "./release-verification-report-lib.mjs";

const packVerificationPath = process.env.PACK_VERIFICATION_PATH;
const packInstallSmokePath = process.env.PACK_INSTALL_SMOKE_PATH;
const dockerAcceptanceReportPath = process.env.DOCKER_ACCEPTANCE_REPORT_PATH;
const packTarballDir = process.env.PACK_TARBALL_DIR || "";
const outputPath =
  process.env.RELEASE_VERIFICATION_REPORT_PATH ||
  path.join(".generated", "release", "release-verification-report.json");

if (!packVerificationPath) {
  throw new Error("PACK_VERIFICATION_PATH is required.");
}

if (!packInstallSmokePath) {
  throw new Error("PACK_INSTALL_SMOKE_PATH is required.");
}

if (!dockerAcceptanceReportPath) {
  throw new Error("DOCKER_ACCEPTANCE_REPORT_PATH is required.");
}

function readOptionalJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const packVerification = readOptionalJson(packVerificationPath);
const packInstallSmoke = readOptionalJson(packInstallSmokePath);
const dockerAcceptance = readOptionalJson(dockerAcceptanceReportPath);
const rebasedInputs = rebaseReleaseVerificationInputs({
  packVerification,
  packVerificationPath,
  packInstallSmoke,
  packInstallSmokePath,
  dockerAcceptance,
  dockerAcceptanceReportPath,
  packTarballDir,
});

const report = buildReleaseVerificationReport({
  packVerification: rebasedInputs.packVerification,
  packInstallSmoke: rebasedInputs.packInstallSmoke,
  dockerAcceptance: rebasedInputs.dockerAcceptance,
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

appendReleaseVerificationSummary({
  summaryPath: process.env.GITHUB_STEP_SUMMARY || "",
  report,
});

console.log(`[release-verification] wrote ${outputPath}`);
