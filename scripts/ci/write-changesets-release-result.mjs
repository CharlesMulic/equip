import path from "node:path";
import {
  appendChangesetsReleaseSummary,
  buildChangesetsReleaseResult,
  writeChangesetsReleaseResultArtifact,
} from "./changesets-release-result-lib.mjs";

const outputPath =
  process.env.CHANGESETS_RELEASE_RESULT_PATH ||
  path.join(".generated", "release", "changesets-release-result.json");

const result = buildChangesetsReleaseResult({
  stepOutcome: process.env.CHANGESETS_STEP_OUTCOME || "",
  published: process.env.CHANGESETS_PUBLISHED || "",
  publishedPackages: process.env.CHANGESETS_PUBLISHED_PACKAGES || "",
});

writeChangesetsReleaseResultArtifact({
  result,
  outPath: outputPath,
});

appendChangesetsReleaseSummary({
  summaryPath: process.env.GITHUB_STEP_SUMMARY || "",
  result,
});

console.log(`[changesets-release] wrote ${outputPath}`);
