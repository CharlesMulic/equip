import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPackMetadata,
  verifyPackMetadata,
} from "../scripts/ci/pack-verification-lib.mjs";

function createPackEntry(overrides = {}) {
  return [{
    name: "@cg3/equip",
    version: "0.17.7",
    unpackedSize: 1000,
    entryCount: 7,
    files: [
      { path: "LICENSE" },
      { path: "README.md" },
      { path: "package.json" },
      { path: "bin/equip.js" },
      { path: "bin/unequip.js" },
      { path: "dist/index.js" },
      { path: "dist/index.d.ts" },
    ],
    ...overrides,
  }];
}

test("verifyPackMetadata passes for expected published files", () => {
  const verification = verifyPackMetadata(createPackEntry());
  assert.equal(verification.hasFailures, false);
  assert.deepEqual(verification.missingRequiredFiles, []);
  assert.deepEqual(verification.forbiddenFiles, []);
});

test("verifyPackMetadata flags missing required files", () => {
  const verification = verifyPackMetadata(createPackEntry({
    files: [
      { path: "LICENSE" },
      { path: "README.md" },
      { path: "package.json" },
    ],
  }));

  assert.equal(verification.hasFailures, true);
  assert.match(verification.problems[0], /missing required files/);
});

test("verifyPackMetadata flags forbidden source files", () => {
  const verification = verifyPackMetadata(createPackEntry({
    files: [
      { path: "LICENSE" },
      { path: "README.md" },
      { path: "package.json" },
      { path: "bin/equip.js" },
      { path: "bin/unequip.js" },
      { path: "dist/index.js" },
      { path: "dist/index.d.ts" },
      { path: "src/index.ts" },
    ],
  }));

  assert.equal(verification.hasFailures, true);
  assert.match(verification.problems[0] + verification.problems[1], /forbidden files included/);
});

test("assertPackMetadata throws a helpful error for oversized packages", () => {
  assert.throws(
    () =>
      assertPackMetadata(createPackEntry({
        unpackedSize: 5 * 1024 * 1024,
      })),
    /unpacked package is too large/,
  );
});
