import fs from "node:fs";
import path from "node:path";
import {
  appendReleaseVerificationSummary,
  buildReleaseVerificationReport,
  rebaseReleaseVerificationInputs,
} from "./release-verification-report-lib.mjs";
import { readGitHubWorkflowContext } from "./workflow-context-lib.mjs";

const packVerificationPath = process.env.PACK_VERIFICATION_PATH;
const packInstallSmokePath = process.env.PACK_INSTALL_SMOKE_PATH;
const dockerAcceptanceReportPath = process.env.DOCKER_ACCEPTANCE_REPORT_PATH;
const releaseBootstrapResultPath = process.env.RELEASE_BOOTSTRAP_RESULT_PATH || "";
const releasePreflightResultPath = process.env.RELEASE_PREFLIGHT_RESULT_PATH || "";
const packTarballDir = process.env.PACK_TARBALL_DIR || "";
const outputPath =
  process.env.RELEASE_VERIFICATION_REPORT_PATH ||
  path.join(".generated", "release", "release-verification-report.json");
const assertionPath =
  process.env.RELEASE_VERIFICATION_ASSERTION_PATH ||
  path.join(".generated", "release", "release-verification-assertion.json");
const summaryArtifactPath =
  process.env.RELEASE_VERIFICATION_SUMMARY_PATH ||
  path.join(".generated", "release", "release-verification-summary.md");
const appendStepSummary =
  (process.env.RELEASE_VERIFICATION_APPEND_STEP_SUMMARY || "true").toLowerCase() !== "false";
const packVerificationArtifactName = process.env.PACK_VERIFICATION_ARTIFACT_NAME || "";
const packTarballArtifactName = process.env.PACK_TARBALL_ARTIFACT_NAME || "";
const packInstallSmokeArtifactName = process.env.PACK_INSTALL_SMOKE_ARTIFACT_NAME || "";
const dockerAcceptanceArtifactName = process.env.DOCKER_ACCEPTANCE_ARTIFACT_NAME || "";
const reportArtifactName = process.env.RELEASE_VERIFICATION_REPORT_ARTIFACT_NAME || "";
const assertionArtifactName = process.env.RELEASE_VERIFICATION_ASSERTION_ARTIFACT_NAME || "";
const summaryArtifactName = process.env.RELEASE_VERIFICATION_SUMMARY_ARTIFACT_NAME || "";

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
const releaseBootstrapResult = readOptionalJson(releaseBootstrapResultPath);
const releasePreflightResult = readOptionalJson(releasePreflightResultPath);
const assertion = readOptionalJson(assertionPath);
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
  releaseBootstrapResult,
  releasePreflightResult,
  packVerification: rebasedInputs.packVerification,
  packInstallSmoke: rebasedInputs.packInstallSmoke,
  dockerAcceptance: rebasedInputs.dockerAcceptance,
  assertion,
  workflowContext: readGitHubWorkflowContext(process.env),
  artifacts: {
    reportPath: path.resolve(outputPath),
    assertionPath: fs.existsSync(assertionPath) ? path.resolve(assertionPath) : "",
    summaryPath: fs.existsSync(summaryArtifactPath) ? path.resolve(summaryArtifactPath) : "",
  },
  artifactNames: {
    releaseBootstrap: process.env.RELEASE_BOOTSTRAP_RESULT_ARTIFACT_NAME || "",
    releasePreflight: process.env.RELEASE_PREFLIGHT_RESULT_ARTIFACT_NAME || "",
    packVerification: packVerificationArtifactName,
    packTarball: packTarballArtifactName,
    packInstallSmoke: packInstallSmokeArtifactName,
    dockerAcceptance: dockerAcceptanceArtifactName,
    report: reportArtifactName,
    assertion: assertionArtifactName,
    summary: summaryArtifactName,
  },
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (appendStepSummary) {
  appendReleaseVerificationSummary({
    summaryPath: process.env.GITHUB_STEP_SUMMARY || "",
    report,
    assertion,
  });
}

console.log(`[release-verification] wrote ${outputPath}`);
