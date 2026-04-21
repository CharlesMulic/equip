import fs from "node:fs";

function buildPackageSection(packVerification) {
  if (!packVerification) {
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
      missingReason: "pack verification artifact missing",
    };
  }

  const status = packVerification?.hasFailures ? "failed" : "passed";
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
    missingReason: "",
  };
}

function buildTarballSmokeSection(packInstallSmoke) {
  if (!packInstallSmoke) {
    return {
      status: "missing",
      tarballFileName: "",
      tarballPath: "",
      installedVersion: "",
      equipVersion: "",
      unequipVersion: "",
      helpIncludesUsage: false,
      exportsCheck: "",
      missingReason: "tarball smoke artifact missing",
    };
  }

  const status =
    packInstallSmoke?.helpIncludesUsage === true && packInstallSmoke?.exportsCheck === "exports-ok"
      ? "passed"
      : "failed";
  return {
    status,
    tarballFileName: packInstallSmoke?.tarballFileName || "",
    tarballPath: packInstallSmoke?.tarballPath || "",
    installedVersion: packInstallSmoke?.installedVersion || "",
    equipVersion: packInstallSmoke?.equipVersion || "",
    unequipVersion: packInstallSmoke?.unequipVersion || "",
    helpIncludesUsage: !!packInstallSmoke?.helpIncludesUsage,
    exportsCheck: packInstallSmoke?.exportsCheck || "",
    missingReason: "",
  };
}

function buildDockerAcceptanceSection(dockerAcceptance) {
  if (!dockerAcceptance) {
    return {
      status: "missing",
      dockerBin: "",
      imageTag: "",
      totalDurationMs: 0,
      steps: [],
      artifacts: {},
      failureMessage: "docker acceptance artifact missing",
      missingReason: "docker acceptance artifact missing",
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
  };
}

export function buildReleaseVerificationReport({
  packVerification,
  packInstallSmoke,
  dockerAcceptance,
  generatedAt = new Date().toISOString(),
}) {
  const packageSection = buildPackageSection(packVerification);
  const tarballSmokeSection = buildTarballSmokeSection(packInstallSmoke);
  const dockerAcceptanceSection = buildDockerAcceptanceSection(dockerAcceptance);
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
    inputs: {
      hasPackVerification: !!packVerification,
      hasTarballSmoke: !!packInstallSmoke,
      hasDockerAcceptance: !!dockerAcceptance,
    },
    package: packageSection,
    tarballSmoke: tarballSmokeSection,
    dockerAcceptance: dockerAcceptanceSection,
  };
}

export function appendReleaseVerificationSummary({
  summaryPath = "",
  report,
}) {
  if (!summaryPath) {
    return;
  }

  const lines = [
    "## Release verification rollup",
    "",
    `- Overall status: \`${report.overallStatus}\``,
    `- Pack verification: \`${report.package.status}\``,
    `- Tarball smoke: \`${report.tarballSmoke.status}\``,
    `- Docker acceptance: \`${report.dockerAcceptance.status}\``,
  ];

  if (report.package.missingReason) {
    lines.push(`- Pack verification detail: ${report.package.missingReason}`);
  }

  if (report.tarballSmoke.missingReason) {
    lines.push(`- Tarball smoke detail: ${report.tarballSmoke.missingReason}`);
  }

  if (report.dockerAcceptance.missingReason) {
    lines.push(`- Docker acceptance detail: ${report.dockerAcceptance.missingReason}`);
  }

  if (report.package.tarballFileName) {
    lines.push(`- Tarball: \`${report.package.tarballFileName}\``);
  }

  if (report.dockerAcceptance.totalDurationMs) {
    lines.push(`- Docker duration: \`${report.dockerAcceptance.totalDurationMs} ms\``);
  }

  lines.push("");
  fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
}
