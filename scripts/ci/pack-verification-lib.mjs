const REQUIRED_PACK_FILES = [
  "LICENSE",
  "README.md",
  "package.json",
  "bin/equip.js",
  "bin/unequip.js",
  "dist/index.js",
  "dist/index.d.ts",
];

const FORBIDDEN_PACK_PREFIXES = [
  "src/",
  "test/",
  "scripts/",
  "node_modules/",
  ".github/",
  ".changeset/",
];

const MAX_UNPACKED_SIZE_BYTES = 1024 * 1024;

export function verifyPackMetadata(packEntries) {
  if (!Array.isArray(packEntries) || packEntries.length === 0) {
    throw new Error("npm pack --json returned no package metadata to verify.");
  }

  const packEntry = packEntries[0];
  const filePaths = new Set((packEntry.files || []).map((file) => file.path));

  const missingRequiredFiles = REQUIRED_PACK_FILES.filter((file) => !filePaths.has(file));
  const forbiddenFiles = [...filePaths].filter((filePath) =>
    FORBIDDEN_PACK_PREFIXES.some((prefix) => filePath.startsWith(prefix)),
  );

  const problems = [];

  if (missingRequiredFiles.length > 0) {
    problems.push(`missing required files: ${missingRequiredFiles.join(", ")}`);
  }

  if (forbiddenFiles.length > 0) {
    problems.push(`forbidden files included: ${forbiddenFiles.join(", ")}`);
  }

  if ((packEntry.unpackedSize || 0) > MAX_UNPACKED_SIZE_BYTES) {
    problems.push(
      `unpacked package is too large: ${packEntry.unpackedSize} bytes exceeds ${MAX_UNPACKED_SIZE_BYTES}`,
    );
  }

  return {
    kind: "equip-pack-verification",
    packageName: packEntry.name,
    version: packEntry.version,
    entryCount: packEntry.entryCount || filePaths.size,
    unpackedSize: packEntry.unpackedSize || 0,
    requiredFilesChecked: REQUIRED_PACK_FILES,
    forbiddenPrefixesChecked: FORBIDDEN_PACK_PREFIXES,
    missingRequiredFiles,
    forbiddenFiles,
    hasFailures: problems.length > 0,
    problems,
  };
}

export function assertPackMetadata(packEntries) {
  const verification = verifyPackMetadata(packEntries);
  if (verification.hasFailures) {
    throw new Error(`npm pack verification failed:\n- ${verification.problems.join("\n- ")}`);
  }
  return verification;
}
