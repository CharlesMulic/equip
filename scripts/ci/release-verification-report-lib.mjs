import fs from "node:fs";
import path from "node:path";
import {
  appendGitHubWorkflowContextSection,
  normalizeWorkflowContext,
} from "./workflow-context-lib.mjs";

function normalizeArtifacts(artifacts) {
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

function prefixArtifactNameEntries(prefix, artifactNames) {
  const normalizedArtifactNames = normalizeArtifactNames(artifactNames);
  const artifactEntries = Object.entries(normalizedArtifactNames).filter(([, value]) => value);
  if (artifactEntries.length === 0) {
    return {};
  }

  return Object.fromEntries(
    artifactEntries.map(([key, value]) => [
      `${prefix}${key[0].toUpperCase()}${key.slice(1)}`,
      value,
    ]),
  );
}

function deriveEvidenceFileNamesFromArtifacts(artifacts) {
  const normalizedArtifacts = normalizeArtifacts(artifacts);
  const artifactEntries = Object.entries(normalizedArtifacts).filter(([, value]) => value);
  if (artifactEntries.length === 0) {
    return {};
  }

  return Object.fromEntries(
    artifactEntries.map(([key, value]) => [
      key,
      path.basename(value),
    ]),
  );
}

function appendArtifactNamesSection(lines, artifactNames) {
  const normalizedArtifactNames = normalizeArtifactNames(artifactNames);
  const artifactEntries = Object.entries(normalizedArtifactNames).filter(([, value]) => value);
  if (artifactEntries.length === 0) {
    return;
  }

  lines.push("");
  lines.push("## Evidence artifacts");
  lines.push("");

  for (const [key, value] of artifactEntries) {
    const label = key
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^./, (char) => char.toUpperCase());
    lines.push(`- ${label}: \`${value}\``);
  }
}

function resolveExistingPath(filePath, fallback = "") {
  if (filePath) {
    const candidate = path.resolve(filePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return typeof fallback === "string" ? fallback : "";
}

function resolveSiblingArtifact(referencePath, siblingFileName, fallback = "") {
  if (!referencePath) {
    return typeof fallback === "string" ? fallback : "";
  }

  return resolveExistingPath(path.join(path.dirname(path.resolve(referencePath)), siblingFileName), fallback);
}

function resolveTarballPath(tarballFileName, tarballDir, fallback = "") {
  if (tarballFileName && tarballDir) {
    const candidate = path.resolve(tarballDir, tarballFileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return typeof fallback === "string" ? fallback : "";
}

export function rebaseReleaseVerificationInputs({
  packVerification,
  packVerificationPath = "",
  packInstallSmoke,
  packInstallSmokePath = "",
  dockerAcceptance,
  dockerAcceptanceReportPath = "",
  packTarballDir = "",
}) {
  return {
    packVerification: packVerification
      ? {
          ...packVerification,
          tarballPath: resolveTarballPath(
            packVerification?.tarballFileName || "",
            packTarballDir,
            packVerification?.tarballPath || "",
          ),
          artifacts: {
            ...normalizeArtifacts(packVerification?.artifacts),
            reportPath: resolveExistingPath(
              packVerificationPath,
              packVerification?.artifacts?.reportPath || "",
            ),
            logPath: resolveSiblingArtifact(
              packVerificationPath,
              "pack-verification.log",
              packVerification?.artifacts?.logPath || "",
            ),
          },
        }
      : null,
    packInstallSmoke: packInstallSmoke
      ? {
          ...packInstallSmoke,
          tarballPath: resolveTarballPath(
            packInstallSmoke?.tarballFileName || "",
            packTarballDir,
            packInstallSmoke?.tarballPath || "",
          ),
          artifacts: {
            ...normalizeArtifacts(packInstallSmoke?.artifacts),
            resultPath: resolveExistingPath(
              packInstallSmokePath,
              packInstallSmoke?.artifacts?.resultPath || "",
            ),
            logPath: resolveSiblingArtifact(
              packInstallSmokePath,
              "pack-install-smoke.log",
              packInstallSmoke?.artifacts?.logPath || "",
            ),
          },
        }
      : null,
    dockerAcceptance: dockerAcceptance
      ? {
          ...dockerAcceptance,
          artifacts: {
            ...normalizeArtifacts(dockerAcceptance?.artifacts),
            reportPath: resolveExistingPath(
              dockerAcceptanceReportPath,
              dockerAcceptance?.artifacts?.reportPath || "",
            ),
            buildLogPath: resolveSiblingArtifact(
              dockerAcceptanceReportPath,
              "docker-build.log",
              dockerAcceptance?.artifacts?.buildLogPath || "",
            ),
            runLogPath: resolveSiblingArtifact(
              dockerAcceptanceReportPath,
              "docker-run.log",
              dockerAcceptance?.artifacts?.runLogPath || "",
            ),
          },
        }
      : null,
  };
}

function buildReleaseBootstrapStatus(result) {
  if (!result) {
    return {
      status: "missing",
      summary: "release bootstrap result missing",
    };
  }

  return {
    status: result.overallStatus || "unknown",
    summary: result.summary || "",
  };
}

function buildReleasePreflightStatus(result, releaseBootstrapResult) {
  if (!result) {
    if (releaseBootstrapResult && releaseBootstrapResult.overallStatus !== "passed") {
      return {
        status: "skipped",
        summary: "release preflight skipped because release bootstrap did not pass",
      };
    }

    return {
      status: "missing",
      summary: "release preflight result missing",
    };
  }

  return {
    status: result.overallStatus || "unknown",
    summary: result.summary || "",
  };
}

function deriveSkippedReason(label, releaseBootstrapResult, releasePreflightResult) {
  if (releasePreflightResult && releasePreflightResult.overallStatus !== "passed") {
    return `${label} skipped because release preflight did not pass`;
  }

  if (!releasePreflightResult && releaseBootstrapResult && releaseBootstrapResult.overallStatus !== "passed") {
    return `${label} skipped because release bootstrap did not pass`;
  }

  return "";
}

function buildPackageSection(packVerification, releaseBootstrapResult, releasePreflightResult) {
  if (!packVerification) {
    const skippedReason = deriveSkippedReason(
      "pack verification",
      releaseBootstrapResult,
      releasePreflightResult,
    );

    if (skippedReason) {
      return {
        status: "skipped",
        packageName: "",
        version: "",
        tarballFileName: "",
        tarballPath: "",
        entryCount: 0,
        unpackedSize: 0,
        packageSizeBytes: 0,
        shasum: "",
        integrity: "",
        requiredFilesChecked: [],
        forbiddenPrefixesChecked: [],
        hasFailures: false,
        problems: [],
        artifacts: {},
        failureMessage: "",
        missingReason: "",
        skippedReason,
      };
    }

    return {
      status: "missing",
      packageName: "",
      version: "",
      tarballFileName: "",
      tarballPath: "",
      entryCount: 0,
      unpackedSize: 0,
      packageSizeBytes: 0,
      shasum: "",
      integrity: "",
      requiredFilesChecked: [],
      forbiddenPrefixesChecked: [],
      hasFailures: true,
      problems: ["pack verification artifact missing"],
      artifacts: {},
      failureMessage: "pack verification artifact missing",
      missingReason: "pack verification artifact missing",
      skippedReason: "",
    };
  }

  const status = packVerification?.status || (packVerification?.hasFailures ? "failed" : "passed");
  return {
    status,
    packageName: packVerification?.packageName || "",
    version: packVerification?.version || "",
    tarballFileName: packVerification?.tarballFileName || "",
    tarballPath: packVerification?.tarballPath || "",
    entryCount: packVerification?.entryCount ?? 0,
    unpackedSize: packVerification?.unpackedSize ?? 0,
    packageSizeBytes: packVerification?.packageSizeBytes ?? 0,
    shasum: packVerification?.shasum || "",
    integrity: packVerification?.integrity || "",
    requiredFilesChecked: Array.isArray(packVerification?.requiredFilesChecked)
      ? packVerification.requiredFilesChecked
      : [],
    forbiddenPrefixesChecked: Array.isArray(packVerification?.forbiddenPrefixesChecked)
      ? packVerification.forbiddenPrefixesChecked
      : [],
    hasFailures: !!packVerification?.hasFailures,
    problems: Array.isArray(packVerification?.problems) ? packVerification.problems : [],
    artifacts: normalizeArtifacts(packVerification?.artifacts),
    failureMessage: packVerification?.failureMessage || "",
    missingReason: "",
    skippedReason: "",
  };
}

function buildTarballSmokeSection(packInstallSmoke, releaseBootstrapResult, releasePreflightResult) {
  if (!packInstallSmoke) {
    const skippedReason = deriveSkippedReason(
      "tarball smoke",
      releaseBootstrapResult,
      releasePreflightResult,
    );

    if (skippedReason) {
      return {
        status: "skipped",
        tarballFileName: "",
        tarballPath: "",
        installedVersion: "",
        equipVersion: "",
        unequipVersion: "",
        helpIncludesUsage: false,
        exportsCheck: "",
        steps: [],
        artifacts: {},
        failureMessage: "",
        missingReason: "",
        skippedReason,
      };
    }

    return {
      status: "missing",
      tarballFileName: "",
      tarballPath: "",
      installedVersion: "",
      equipVersion: "",
      unequipVersion: "",
      helpIncludesUsage: false,
      exportsCheck: "",
      steps: [],
      artifacts: {},
      failureMessage: "tarball smoke artifact missing",
      missingReason: "tarball smoke artifact missing",
      skippedReason: "",
    };
  }

  const status =
    packInstallSmoke?.status ||
    (packInstallSmoke?.helpIncludesUsage === true && packInstallSmoke?.exportsCheck === "exports-ok"
      ? "passed"
      : "failed");
  return {
    status,
    tarballFileName: packInstallSmoke?.tarballFileName || "",
    tarballPath: packInstallSmoke?.tarballPath || "",
    installedVersion: packInstallSmoke?.installedVersion || "",
    equipVersion: packInstallSmoke?.equipVersion || "",
    unequipVersion: packInstallSmoke?.unequipVersion || "",
    helpIncludesUsage: !!packInstallSmoke?.helpIncludesUsage,
    exportsCheck: packInstallSmoke?.exportsCheck || "",
    steps: Array.isArray(packInstallSmoke?.steps)
      ? packInstallSmoke.steps.map((step) => ({
          name: step.name || "",
          status: step.status || "",
          exitCode: step.exitCode ?? null,
        }))
      : [],
    artifacts: normalizeArtifacts(packInstallSmoke?.artifacts),
    failureMessage: packInstallSmoke?.failureMessage || "",
    missingReason: "",
    skippedReason: "",
  };
}

function buildDockerAcceptanceSection(dockerAcceptance, releaseBootstrapResult, releasePreflightResult) {
  if (!dockerAcceptance) {
    const skippedReason = deriveSkippedReason(
      "docker acceptance",
      releaseBootstrapResult,
      releasePreflightResult,
    );

    if (skippedReason) {
      return {
        status: "skipped",
        dockerBin: "",
        imageTag: "",
        totalDurationMs: 0,
        steps: [],
        artifacts: {},
        failureMessage: "",
        missingReason: "",
        skippedReason,
      };
    }

    return {
      status: "missing",
      dockerBin: "",
      imageTag: "",
      totalDurationMs: 0,
      steps: [],
      artifacts: {},
      failureMessage: "docker acceptance artifact missing",
      missingReason: "docker acceptance artifact missing",
      skippedReason: "",
    };
  }

  const status = dockerAcceptance?.status === "passed" ? "passed" : "failed";
  return {
    status,
    dockerBin: dockerAcceptance?.dockerBin || "",
    imageTag: dockerAcceptance?.imageTag || "",
    totalDurationMs: dockerAcceptance?.totalDurationMs ?? 0,
    steps: Array.isArray(dockerAcceptance?.steps)
      ? dockerAcceptance.steps.map((step) => ({
          name: step.name || "",
          durationMs: step.durationMs ?? 0,
          exitCode: step.exitCode ?? null,
        }))
      : [],
    artifacts: dockerAcceptance?.artifacts || {},
    failureMessage: dockerAcceptance?.failureMessage || "",
    missingReason: "",
    skippedReason: "",
  };
}

function buildEvidenceFileNames({
  releaseBootstrapResult = null,
  releasePreflightResult = null,
  packageSection,
  tarballSmokeSection,
  dockerAcceptanceSection,
  artifacts = {},
}) {
  return {
    ...prefixArtifactNameEntries("releaseBootstrap", releaseBootstrapResult?.evidenceFileNames),
    ...prefixArtifactNameEntries("releasePreflight", releasePreflightResult?.evidenceFileNames),
    ...prefixArtifactNameEntries("package", deriveEvidenceFileNamesFromArtifacts(packageSection?.artifacts)),
    ...prefixArtifactNameEntries("tarballSmoke", deriveEvidenceFileNamesFromArtifacts(tarballSmokeSection?.artifacts)),
    ...prefixArtifactNameEntries("dockerAcceptance", deriveEvidenceFileNamesFromArtifacts(dockerAcceptanceSection?.artifacts)),
    ...prefixArtifactNameEntries("releaseVerification", deriveEvidenceFileNamesFromArtifacts(artifacts)),
  };
}

export function buildReleaseVerificationReport({
  releaseBootstrapResult = null,
  releasePreflightResult = null,
  packVerification,
  packInstallSmoke,
  dockerAcceptance,
  assertion = null,
  artifacts = {},
  artifactNames = {},
  workflowContext = {},
  generatedAt = new Date().toISOString(),
}) {
  const packageSection = buildPackageSection(
    packVerification,
    releaseBootstrapResult,
    releasePreflightResult,
  );
  const tarballSmokeSection = buildTarballSmokeSection(
    packInstallSmoke,
    releaseBootstrapResult,
    releasePreflightResult,
  );
  const dockerAcceptanceSection = buildDockerAcceptanceSection(
    dockerAcceptance,
    releaseBootstrapResult,
    releasePreflightResult,
  );
  const packStatus = packageSection.status;
  const packSmokeStatus = tarballSmokeSection.status;
  const dockerStatus = dockerAcceptanceSection.status;
  const overallStatus =
    packStatus === "passed" && packSmokeStatus === "passed" && dockerStatus === "passed"
      ? "passed"
      : "failed";

  return {
    kind: "equip-release-verification-report",
    generatedAt,
    overallStatus,
    artifacts: normalizeArtifacts(artifacts),
    artifactNames: normalizeArtifactNames(artifactNames),
    evidenceFileNames: buildEvidenceFileNames({
      releaseBootstrapResult,
      releasePreflightResult,
      packageSection,
      tarballSmokeSection,
      dockerAcceptanceSection,
      artifacts,
    }),
    workflowContext: normalizeWorkflowContext(workflowContext),
    inputs: {
      hasReleaseBootstrapResult: !!releaseBootstrapResult,
      hasReleasePreflightResult: !!releasePreflightResult,
      hasPackVerification: !!packVerification,
      hasTarballSmoke: !!packInstallSmoke,
      hasDockerAcceptance: !!dockerAcceptance,
    },
    releaseBootstrap: buildReleaseBootstrapStatus(releaseBootstrapResult),
    releasePreflight: buildReleasePreflightStatus(releasePreflightResult, releaseBootstrapResult),
    package: packageSection,
    tarballSmoke: tarballSmokeSection,
    dockerAcceptance: dockerAcceptanceSection,
    assertion:
      assertion && typeof assertion === "object"
        ? {
            outcome: assertion.outcome || "",
            overallStatus: assertion.overallStatus || "",
            components:
              assertion.components && typeof assertion.components === "object"
                ? assertion.components
                : {},
            reportPath: assertion.reportPath || "",
            assertionPath: assertion.assertionPath || "",
            failureDetails: Array.isArray(assertion.failureDetails) ? assertion.failureDetails : [],
            error: assertion.error || "",
          }
        : null,
  };
}

export function appendReleaseVerificationSummary({
  summaryPath = "",
  report,
  assertion = null,
}) {
  if (!summaryPath) {
    return;
  }

  fs.appendFileSync(
    summaryPath,
    buildReleaseVerificationSummaryMarkdown({
      report,
      assertion,
    }),
    "utf8",
  );
}

export function buildReleaseVerificationSummaryMarkdown({
  report,
  assertion = null,
}) {
  const lines = [
    "## Release verification rollup",
    "",
    `- Overall status: \`${report.overallStatus}\``,
    `- Release bootstrap: \`${report.releaseBootstrap?.status || "unknown"}\``,
    `- Release preflight: \`${report.releasePreflight?.status || "unknown"}\``,
    `- Pack verification: \`${report.package.status}\``,
    `- Tarball smoke: \`${report.tarballSmoke.status}\``,
    `- Docker acceptance: \`${report.dockerAcceptance.status}\``,
  ];

  if (report.releaseBootstrap?.summary) {
    lines.push(`- Release bootstrap summary: ${report.releaseBootstrap.summary}`);
  }
  if (report.releasePreflight?.summary) {
    lines.push(`- Release preflight summary: ${report.releasePreflight.summary}`);
  }
  if (report.package.missingReason) {
    lines.push(`- Pack verification detail: ${report.package.missingReason}`);
  }
  if (report.package.skippedReason) {
    lines.push(`- Pack verification detail: ${report.package.skippedReason}`);
  }
  if (report.package.failureMessage) {
    lines.push(`- Pack verification failure: ${report.package.failureMessage}`);
  }
  if (report.package.artifacts?.logPath) {
    lines.push(`- Pack verification log: \`${report.package.artifacts.logPath}\``);
  }

  if (report.tarballSmoke.missingReason) {
    lines.push(`- Tarball smoke detail: ${report.tarballSmoke.missingReason}`);
  }
  if (report.tarballSmoke.skippedReason) {
    lines.push(`- Tarball smoke detail: ${report.tarballSmoke.skippedReason}`);
  }
  if (report.tarballSmoke.failureMessage) {
    lines.push(`- Tarball smoke failure: ${report.tarballSmoke.failureMessage}`);
  }
  if (report.tarballSmoke.artifacts?.logPath) {
    lines.push(`- Tarball smoke log: \`${report.tarballSmoke.artifacts.logPath}\``);
  }

  if (report.dockerAcceptance.missingReason) {
    lines.push(`- Docker acceptance detail: ${report.dockerAcceptance.missingReason}`);
  }
  if (report.dockerAcceptance.skippedReason) {
    lines.push(`- Docker acceptance detail: ${report.dockerAcceptance.skippedReason}`);
  }
  if (report.dockerAcceptance.failureMessage) {
    lines.push(`- Docker acceptance failure: ${report.dockerAcceptance.failureMessage}`);
  }

  if (report.package.tarballFileName) {
    lines.push(`- Tarball: \`${report.package.tarballFileName}\``);
  }

  if (report.dockerAcceptance.totalDurationMs) {
    lines.push(`- Docker duration: \`${report.dockerAcceptance.totalDurationMs} ms\``);
  }
  if (report.dockerAcceptance.artifacts?.reportPath) {
    lines.push(`- Docker report: \`${report.dockerAcceptance.artifacts.reportPath}\``);
  }
  if (report.dockerAcceptance.artifacts?.buildLogPath) {
    lines.push(`- Docker build log: \`${report.dockerAcceptance.artifacts.buildLogPath}\``);
  }
  if (report.dockerAcceptance.artifacts?.runLogPath) {
    lines.push(`- Docker run log: \`${report.dockerAcceptance.artifacts.runLogPath}\``);
  }

  appendGitHubWorkflowContextSection(lines, report.workflowContext);
  appendArtifactNamesSection(lines, report.artifactNames || {});

  const evidenceFileNameEntries = Object.entries(report.evidenceFileNames || {}).filter(([, value]) => value);
  if (evidenceFileNameEntries.length > 0) {
    lines.push("");
    lines.push("## Evidence file names");
    lines.push("");

    for (const [key, value] of evidenceFileNameEntries) {
      const label = key
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/^./, (char) => char.toUpperCase());
      lines.push(`- ${label}: \`${value}\``);
    }
  }

  if (assertion && typeof assertion === "object") {
    lines.push("");
    lines.push("## Final assertion");
    lines.push("");
    lines.push(`- Outcome: \`${assertion.outcome || "unknown"}\``);
    lines.push(`- Overall status: \`${assertion.overallStatus || "unknown"}\``);

    const components =
      assertion.components && typeof assertion.components === "object"
        ? assertion.components
        : {};
    for (const [name, status] of Object.entries(components)) {
      lines.push(`- ${name}: \`${status}\``);
    }

    if (assertion.reportPath) {
      lines.push(`- Report: \`${assertion.reportPath}\``);
    }

    if (assertion.assertionPath) {
      lines.push(`- Assertion artifact: \`${assertion.assertionPath}\``);
    }

    const failureDetails = Array.isArray(assertion.failureDetails) ? assertion.failureDetails : [];
    if (failureDetails.length > 0) {
      lines.push("- Failure details:");
      for (const detail of failureDetails) {
        lines.push(`  - ${detail}`);
      }
    }

    if (assertion.error) {
      lines.push(`- Error: ${assertion.error}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}
