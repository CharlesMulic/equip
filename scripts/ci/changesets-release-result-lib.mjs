import fs from "node:fs";
import path from "node:path";

function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "true" || normalized === "1") {
    return true;
  }

  if (normalized === "false" || normalized === "0") {
    return false;
  }

  return null;
}

function parsePublishedPackages(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildSummary({ stepOutcome, published, publishedPackages }) {
  if (stepOutcome !== "success") {
    return "changesets release step failed; inspect workflow logs for the underlying error";
  }

  if (published) {
    if (publishedPackages.length === 0) {
      return "changesets release step published packages";
    }

    const packageList = publishedPackages
      .map((pkg) => `${pkg.name || "unknown"}@${pkg.version || "unknown"}`)
      .join(", ");
    return `changesets release step published ${publishedPackages.length} package${publishedPackages.length === 1 ? "" : "s"}: ${packageList}`;
  }

  return "changesets release step completed without publishing packages";
}

export function buildChangesetsReleaseResult({
  stepOutcome = "",
  published = false,
  publishedPackages = [],
}) {
  const normalizedPublished = parseBoolean(published) === true;
  const normalizedPackages = parsePublishedPackages(publishedPackages);
  const normalizedOutcome = typeof stepOutcome === "string" ? stepOutcome : "";

  return {
    kind: "equip-changesets-release-result",
    generatedAt: new Date().toISOString(),
    stepOutcome: normalizedOutcome || "unknown",
    status: normalizedOutcome === "success"
      ? normalizedPublished
        ? "published"
        : "completed"
      : "failed",
    published: normalizedPublished,
    publishedPackages: normalizedPackages.map((pkg) => ({
      name: pkg?.name || "",
      version: pkg?.version || "",
    })),
    summary: buildSummary({
      stepOutcome: normalizedOutcome,
      published: normalizedPublished,
      publishedPackages: normalizedPackages,
    }),
  };
}

export function writeChangesetsReleaseResultArtifact({ result, outPath }) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function buildAssertionSummaryLines(assertionArtifact) {
  if (!assertionArtifact?.assertion) {
    return [];
  }

  const lines = [
    "",
    "## Final assertion",
    "",
    `- Outcome: \`${assertionArtifact.assertion.outcome || "unknown"}\``,
    `- Status: \`${assertionArtifact.assertion.status || assertionArtifact.result?.status || "unknown"}\``,
    `- Published: \`${assertionArtifact.assertion.published ? "yes" : "no"}\``,
  ];

  if (assertionArtifact.assertion.error) {
    lines.push(`- Error: ${assertionArtifact.assertion.error}`);
  }

  return lines;
}

function normalizeArtifactPaths(artifacts) {
  if (!artifacts || typeof artifacts !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(artifacts).map(([key, value]) => [key, typeof value === "string" ? value : ""]),
  );
}

function normalizeArtifactNames(artifacts) {
  if (!artifacts || typeof artifacts !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(artifacts).map(([key, value]) => [key, typeof value === "string" ? value : ""]),
  );
}

export function buildChangesetsReleaseSummaryMarkdown({ result, assertionArtifact = null }) {
  const lines = [
    "## Changesets release result",
    "",
    `- Outcome: \`${result.stepOutcome}\``,
    `- Status: \`${result.status}\``,
    `- Published: \`${result.published ? "yes" : "no"}\``,
    `- Summary: ${result.summary}`,
  ];

  if (result.publishedPackages.length > 0) {
    lines.push("", "| Package | Version |", "| --- | --- |");
    for (const pkg of result.publishedPackages) {
      lines.push(`| \`${pkg.name}\` | \`${pkg.version}\` |`);
    }
  }

  lines.push(...buildAssertionSummaryLines(assertionArtifact));

  return `${lines.join("\n")}\n`;
}

export function buildChangesetsReleaseReport({
  result,
  assertionArtifact = null,
  artifacts = {},
  artifactNames = {},
  generatedAt = new Date().toISOString(),
}) {
  return {
    kind: "equip-changesets-release-report",
    generatedAt,
    status: assertionArtifact?.assertion?.outcome === "failed"
      ? "failed"
      : (assertionArtifact?.assertion?.status || result?.status || "unknown"),
    result: {
      stepOutcome: result?.stepOutcome || "",
      status: result?.status || "",
      published: !!result?.published,
      summary: result?.summary || "",
      publishedPackages: Array.isArray(result?.publishedPackages)
        ? result.publishedPackages.map((pkg) => ({
            name: pkg?.name || "",
            version: pkg?.version || "",
          }))
        : [],
    },
    assertion: assertionArtifact?.assertion
      ? {
          outcome: assertionArtifact.assertion.outcome || "",
          status: assertionArtifact.assertion.status || "",
          published: !!assertionArtifact.assertion.published,
          error: assertionArtifact.assertion.error || "",
          publishedPackages: Array.isArray(assertionArtifact.assertion.publishedPackages)
            ? assertionArtifact.assertion.publishedPackages.map((pkg) => ({
                name: pkg?.name || "",
                version: pkg?.version || "",
              }))
            : [],
        }
      : null,
    artifacts: normalizeArtifactPaths(artifacts),
    artifactNames: normalizeArtifactNames(artifactNames),
  };
}

export function appendChangesetsReleaseSummary({ summaryPath, result, assertionArtifact = null }) {
  if (!summaryPath) {
    return;
  }

  fs.appendFileSync(summaryPath, buildChangesetsReleaseSummaryMarkdown({ result, assertionArtifact }), "utf8");
}

export function writeChangesetsReleaseAssertionArtifact({ result, assertion, outPath }) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const artifact = {
    kind: "equip-changesets-release-assertion",
    generatedAt: new Date().toISOString(),
    result: {
      stepOutcome: result?.stepOutcome || "",
      status: result?.status || "",
      published: !!result?.published,
      summary: result?.summary || "",
      publishedPackages: Array.isArray(result?.publishedPackages) ? result.publishedPackages : [],
    },
    assertion,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

export function writeChangesetsReleaseReportArtifact({ report, outPath }) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
