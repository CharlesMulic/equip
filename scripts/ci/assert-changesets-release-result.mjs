import fs from "node:fs";
import path from "node:path";
import { writeChangesetsReleaseAssertionArtifact } from "./changesets-release-result-lib.mjs";

const resultPath =
  process.env.CHANGESETS_RELEASE_RESULT_PATH ||
  path.join(".generated", "release", "changesets-release-result.json");
const assertionPath =
  process.env.CHANGESETS_RELEASE_ASSERTION_PATH ||
  path.join(".generated", "release", "changesets-release-assertion.json");

if (!fs.existsSync(resultPath)) {
  throw new Error(`Changesets release result artifact not found: ${resultPath}`);
}

const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));

try {
  if (result.stepOutcome !== "success") {
    const detail =
      result.status === "skipped" && result.skipReason
        ? result.skipReason
        : (result.summary || "Inspect workflow logs for details.");
    throw new Error(
      `Changesets release step finished with outcome '${result.stepOutcome}'. ${detail}`,
    );
  }

  writeChangesetsReleaseAssertionArtifact({
    result,
    assertion: {
      outcome: "passed",
      resultPath: path.resolve(resultPath),
      assertionPath: path.resolve(assertionPath),
      status: result.status || "",
      published: !!result.published,
      publishedPackages: Array.isArray(result.publishedPackages) ? result.publishedPackages : [],
    },
    outPath: assertionPath,
  });

  console.log(`[changesets-release] result passed for ${resultPath}`);
  console.log(`[changesets-release] status=${result.status} published=${result.published ? "yes" : "no"}`);
} catch (error) {
  writeChangesetsReleaseAssertionArtifact({
    result,
    assertion: {
      outcome: "failed",
      resultPath: path.resolve(resultPath),
      assertionPath: path.resolve(assertionPath),
      status: result.status || "",
      published: !!result.published,
      publishedPackages: Array.isArray(result.publishedPackages) ? result.publishedPackages : [],
      error: error instanceof Error ? error.message : String(error),
    },
    outPath: assertionPath,
  });
  throw error;
}
