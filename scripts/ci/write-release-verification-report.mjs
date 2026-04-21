import fs from "node:fs";
import path from "node:path";
import {
  appendReleaseVerificationSummary,
  buildReleaseVerificationReport,
} from "./release-verification-report-lib.mjs";

const packVerificationPath = process.env.PACK_VERIFICATION_PATH;
const packInstallSmokePath = process.env.PACK_INSTALL_SMOKE_PATH;
const dockerAcceptanceReportPath = process.env.DOCKER_ACCEPTANCE_REPORT_PATH;
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

const report = buildReleaseVerificationReport({
  packVerification,
  packInstallSmoke,
  dockerAcceptance,
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

appendReleaseVerificationSummary({
  summaryPath: process.env.GITHUB_STEP_SUMMARY || "",
  report,
});

console.log(`[release-verification] wrote ${outputPath}`);
