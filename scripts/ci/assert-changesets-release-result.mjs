import fs from "node:fs";
import path from "node:path";

const resultPath =
  process.env.CHANGESETS_RELEASE_RESULT_PATH ||
  path.join(".generated", "release", "changesets-release-result.json");

if (!fs.existsSync(resultPath)) {
  throw new Error(`Changesets release result artifact not found: ${resultPath}`);
}

const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));

if (result.stepOutcome !== "success") {
  throw new Error(
    `Changesets release step finished with outcome '${result.stepOutcome}'. ${result.summary || "Inspect workflow logs for details."}`,
  );
}

console.log(`[changesets-release] result passed for ${resultPath}`);
console.log(`[changesets-release] status=${result.status} published=${result.published ? "yes" : "no"}`);
