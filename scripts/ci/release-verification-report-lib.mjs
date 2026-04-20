import fs from "node:fs";

export function buildReleaseVerificationReport({
  packVerification,
  packInstallSmoke,
  dockerAcceptance,
  generatedAt = new Date().toISOString(),
}) {
  const packStatus = packVerification?.hasFailures ? "failed" : "passed";
  const packSmokeStatus =
    packInstallSmoke?.helpIncludesUsage === true && packInstallSmoke?.exportsCheck === "exports-ok"
      ? "passed"
      : "failed";
  const dockerStatus = dockerAcceptance?.status === "passed" ? "passed" : "failed";
  const overallStatus =
    packStatus === "passed" && packSmokeStatus === "passed" && dockerStatus === "passed"
      ? "passed"
      : "failed";

  return {
    kind: "equip-release-verification-report",
    generatedAt,
    overallStatus,
    package: {
      status: packStatus,
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
    },
    tarballSmoke: {
      status: packSmokeStatus,
      tarballFileName: packInstallSmoke?.tarballFileName || "",
      tarballPath: packInstallSmoke?.tarballPath || "",
      installedVersion: packInstallSmoke?.installedVersion || "",
      equipVersion: packInstallSmoke?.equipVersion || "",
      unequipVersion: packInstallSmoke?.unequipVersion || "",
      helpIncludesUsage: !!packInstallSmoke?.helpIncludesUsage,
      exportsCheck: packInstallSmoke?.exportsCheck || "",
    },
    dockerAcceptance: {
      status: dockerStatus,
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
    },
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

  if (report.package.tarballFileName) {
    lines.push(`- Tarball: \`${report.package.tarballFileName}\``);
  }

  if (report.dockerAcceptance.totalDurationMs) {
    lines.push(`- Docker duration: \`${report.dockerAcceptance.totalDurationMs} ms\``);
  }

  lines.push("");
  fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
}
