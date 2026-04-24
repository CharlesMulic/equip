import fs from "node:fs";
import path from "node:path";
import {
  buildChangesetsReleaseResult,
  writeChangesetsReleaseResultArtifact,
} from "./changesets-release-result-lib.mjs";
import { readGitHubWorkflowContext } from "./workflow-context-lib.mjs";

const outputPath =
  process.env.CHANGESETS_RELEASE_RESULT_PATH ||
  path.join(".generated", "release", "changesets-release-result.json");
const releaseVerificationReportPath = process.env.RELEASE_VERIFICATION_REPORT_PATH || "";

function readOptionalJson(filePath) {
  if (!filePath) {
    return null;
  }

  const resolvedPath = path.resolve(filePath);
  try {
    return JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch {
    return null;
  }
}

const result = buildChangesetsReleaseResult({
  stepOutcome: process.env.CHANGESETS_STEP_OUTCOME || "",
  published: process.env.CHANGESETS_PUBLISHED || "",
  publishedPackages: process.env.CHANGESETS_PUBLISHED_PACKAGES || "",
  releaseVerificationReport: readOptionalJson(releaseVerificationReportPath),
  workflowContext: readGitHubWorkflowContext(process.env),
});

writeChangesetsReleaseResultArtifact({
  result,
  outPath: outputPath,
});

console.log(`[changesets-release] wrote ${outputPath}`);
