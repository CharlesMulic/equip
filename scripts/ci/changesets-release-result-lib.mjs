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
  if (stepOutcome === "missing") {
    return "changesets release result artifact missing; inspect earlier release workflow steps";
  }

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

function buildSkipSummary({ releaseVerificationReport }) {
  if (releaseVerificationReport?.overallStatus) {
    return `changesets release step skipped because release verification was ${releaseVerificationReport.overallStatus}`;
  }

  return "changesets release step skipped before execution";
}

function normalizeChangesetsReleaseInputs(inputs, { result = null, assertionArtifact = null } = {}) {
  return {
    hasResultArtifact:
      typeof inputs?.hasResultArtifact === "boolean" ? inputs.hasResultArtifact : !!result,
    hasAssertionArtifact:
      typeof inputs?.hasAssertionArtifact === "boolean"
        ? inputs.hasAssertionArtifact
        : !!assertionArtifact,
    hasReleaseVerificationReport:
      typeof inputs?.hasReleaseVerificationReport === "boolean"
        ? inputs.hasReleaseVerificationReport
        : !!result?.inputs?.hasReleaseVerificationReport,
  };
}

export function buildChangesetsReleaseResult({
  stepOutcome = "",
  published = false,
  publishedPackages = [],
  releaseVerificationReport = null,
}) {
  const normalizedPublished = parseBoolean(published) === true;
  const normalizedPackages = parsePublishedPackages(publishedPackages);
  const normalizedOutcome = typeof stepOutcome === "string" ? stepOutcome : "";
  const normalizedVerificationStatus = releaseVerificationReport?.overallStatus || "";
  const isSkipped = normalizedOutcome === "skipped";
  const isMissing = normalizedOutcome === "missing";
  const status =
    normalizedOutcome === "success"
      ? normalizedPublished
        ? "published"
        : "completed"
      : isSkipped
        ? "skipped"
      : isMissing
        ? "missing"
        : "failed";
  const summary =
    isSkipped
      ? buildSkipSummary({ releaseVerificationReport })
      : buildSummary({
        stepOutcome: normalizedOutcome,
        published: normalizedPublished,
        publishedPackages: normalizedPackages,
      });

  return {
    kind: "equip-changesets-release-result",
    generatedAt: new Date().toISOString(),
    stepOutcome: normalizedOutcome || "unknown",
    status,
    published: normalizedPublished,
    publishedPackages: normalizedPackages.map((pkg) => ({
      name: pkg?.name || "",
      version: pkg?.version || "",
    })),
    summary,
    skipReason: status === "skipped" ? summary : "",
    inputs: {
      hasReleaseVerificationReport: !!releaseVerificationReport,
    },
    prerequisites: {
      releaseVerificationStatus: normalizedVerificationStatus,
    },
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

export function buildChangesetsReleaseSummaryMarkdown({
  result,
  assertionArtifact = null,
  artifactNames = {},
  inputs = {},
}) {
  const normalizedResult =
    result ||
    buildChangesetsReleaseResult({
      stepOutcome: "missing",
      published: false,
      publishedPackages: [],
    });
  const normalizedInputs = normalizeChangesetsReleaseInputs(inputs, {
    result,
    assertionArtifact,
  });
  const lines = [
    "## Changesets release result",
    "",
    `- Outcome: \`${normalizedResult.stepOutcome}\``,
    `- Status: \`${normalizedResult.status}\``,
    `- Published: \`${normalizedResult.published ? "yes" : "no"}\``,
    `- Summary: ${normalizedResult.summary}`,
  ];

  if (normalizedResult.publishedPackages.length > 0) {
    lines.push("", "| Package | Version |", "| --- | --- |");
    for (const pkg of normalizedResult.publishedPackages) {
      lines.push(`| \`${pkg.name}\` | \`${pkg.version}\` |`);
    }
  }

  if (Object.values(normalizedInputs).some((value) => !value)) {
    lines.push("", "## Input presence", "");
    lines.push(`- Result artifact: \`${normalizedInputs.hasResultArtifact ? "present" : "missing"}\``);
    lines.push(
      `- Assertion artifact: \`${normalizedInputs.hasAssertionArtifact ? "present" : "missing"}\``,
    );
    lines.push(
      `- Release verification report: \`${normalizedInputs.hasReleaseVerificationReport ? "present" : "missing"}\``,
    );
  }

  lines.push(...buildAssertionSummaryLines(assertionArtifact));

  const normalizedArtifactNames = normalizeArtifactNames(artifactNames);
  const artifactEntries = Object.entries(normalizedArtifactNames).filter(([, value]) => value);
  if (artifactEntries.length > 0) {
    lines.push("", "## Evidence artifacts", "");

    for (const [key, value] of artifactEntries) {
      const label = key
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/^./, (char) => char.toUpperCase());
      lines.push(`- ${label}: \`${value}\``);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function buildChangesetsReleaseReport({
  result,
  assertionArtifact = null,
  artifacts = {},
  artifactNames = {},
  inputs = {},
  generatedAt = new Date().toISOString(),
}) {
  const normalizedResult =
    result ||
    buildChangesetsReleaseResult({
      stepOutcome: "missing",
      published: false,
      publishedPackages: [],
    });
  const normalizedInputs = normalizeChangesetsReleaseInputs(inputs, {
    result,
    assertionArtifact,
  });
  const resultStatus = normalizedResult?.status || "unknown";
  const assertionStatus = assertionArtifact?.assertion?.status || "";

  return {
    kind: "equip-changesets-release-report",
    generatedAt,
    status: resultStatus,
    effectiveStatus: assertionArtifact?.assertion?.outcome === "failed"
      ? "failed"
      : (assertionStatus || resultStatus),
    result: {
      stepOutcome: normalizedResult?.stepOutcome || "",
      status: resultStatus,
      published: !!normalizedResult?.published,
      summary: normalizedResult?.summary || "",
      skipReason: normalizedResult?.skipReason || "",
      inputs:
        normalizedResult?.inputs && typeof normalizedResult.inputs === "object"
          ? {
              hasReleaseVerificationReport: !!normalizedResult.inputs.hasReleaseVerificationReport,
            }
          : {
              hasReleaseVerificationReport: false,
            },
      prerequisites:
        normalizedResult?.prerequisites && typeof normalizedResult.prerequisites === "object"
          ? normalizedResult.prerequisites
          : {},
      publishedPackages: Array.isArray(normalizedResult?.publishedPackages)
        ? normalizedResult.publishedPackages.map((pkg) => ({
            name: pkg?.name || "",
            version: pkg?.version || "",
          }))
        : [],
    },
    assertion: assertionArtifact?.assertion
      ? {
          outcome: assertionArtifact.assertion.outcome || "",
          status: assertionStatus,
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
    inputs: normalizedInputs,
    artifacts: normalizeArtifactPaths(artifacts),
    artifactNames: normalizeArtifactNames(artifactNames),
  };
}

export function appendChangesetsReleaseSummary({
  summaryPath,
  result,
  assertionArtifact = null,
  artifactNames = {},
  inputs = {},
}) {
  if (!summaryPath) {
    return;
  }

  fs.appendFileSync(
    summaryPath,
    buildChangesetsReleaseSummaryMarkdown({ result, assertionArtifact, artifactNames, inputs }),
    "utf8",
  );
}

export function writeChangesetsReleaseAssertionArtifact({
  result,
  assertion,
  artifacts = {},
  artifactNames = {},
  inputs = {},
  outPath,
}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const normalizedResult =
    result ||
    buildChangesetsReleaseResult({
      stepOutcome: "missing",
      published: false,
      publishedPackages: [],
    });
  const normalizedInputs = normalizeChangesetsReleaseInputs(inputs, { result });
  const artifact = {
    kind: "equip-changesets-release-assertion",
    generatedAt: new Date().toISOString(),
    status: normalizedResult?.status || "",
    effectiveStatus:
      assertion?.outcome === "failed"
        ? "failed"
        : (assertion?.status || normalizedResult?.status || ""),
    result: {
      stepOutcome: normalizedResult?.stepOutcome || "",
      status: normalizedResult?.status || "",
      published: !!normalizedResult?.published,
      summary: normalizedResult?.summary || "",
      skipReason: normalizedResult?.skipReason || "",
      inputs:
        normalizedResult?.inputs && typeof normalizedResult.inputs === "object"
          ? {
              hasReleaseVerificationReport: !!normalizedResult.inputs.hasReleaseVerificationReport,
            }
          : {
              hasReleaseVerificationReport: false,
            },
      prerequisites:
        normalizedResult?.prerequisites && typeof normalizedResult.prerequisites === "object"
          ? normalizedResult.prerequisites
          : {},
      publishedPackages: Array.isArray(normalizedResult?.publishedPackages)
        ? normalizedResult.publishedPackages
        : [],
    },
    inputs: normalizedInputs,
    artifacts: normalizeArtifactPaths(artifacts),
    artifactNames: normalizeArtifactNames(artifactNames),
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
