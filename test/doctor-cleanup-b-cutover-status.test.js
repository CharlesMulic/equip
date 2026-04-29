// Doctor's cleanup-B cutover status check (architect condition 5).
//
// Doctor surfaces three states based on what's on disk:
//   1. No backup exists → no cleanup-B section (pre-cutover normal state)
//   2. Backup exists, legacy gone → informational "Pre-Cleanup-B snapshot"
//      with discard hint (post-cutover normal state — user can clean up
//      the snapshot when they're satisfied)
//   3. Backup exists, legacy still on disk → ISSUE: "Cleanup B migration
//      appears incomplete" with retry/restore instructions (the failure
//      case the precondition + per-file-error tolerance design handles
//      silently — silent isn't enough at the user-facing surface)

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { runDoctor } = require("../dist/lib/commands/doctor");

let tempHome;
const origHomedir = os.homedir;

function setupTempHome() {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-cleanup-b-"));
  os.homedir = () => tempHome;
  process.env.EQUIP_HOME = path.join(tempHome, ".equip");
  fs.mkdirSync(process.env.EQUIP_HOME, { recursive: true });
}

function teardownTempHome() {
  os.homedir = origHomedir;
  delete process.env.EQUIP_HOME;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

function captureDoctorOutput(fn) {
  const origWrite = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = (chunk) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    return true;
  };
  try { fn(); } finally { process.stderr.write = origWrite; }
  return buf;
}

function writeBackupSnapshot(equipHome, augments) {
  const backupDir = path.join(equipHome, ".backup-pre-cleanup-b");
  fs.mkdirSync(path.join(backupDir, "augments"), { recursive: true });
  for (const [name, content] of Object.entries(augments)) {
    fs.writeFileSync(path.join(backupDir, "augments", `${name}.json`), JSON.stringify(content));
  }
}

function writeLegacyAugment(equipHome, name, content) {
  const dir = path.join(equipHome, "augments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(content));
}

describe("doctor — Cleanup B cutover status", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("no backup exists → no cleanup-B section in doctor output (pre-cutover normal)", () => {
    const output = captureDoctorOutput(() => runDoctor());
    assert.doesNotMatch(output, /Pre-Cleanup-B snapshot/);
    assert.doesNotMatch(output, /Cleanup B migration appears incomplete/);
  });

  it("backup exists + legacy gone → informational snapshot section (post-cutover normal)", () => {
    writeBackupSnapshot(process.env.EQUIP_HOME, { "snap-1": { name: "snap-1", title: "ok" } });

    const output = captureDoctorOutput(() => runDoctor());
    assert.match(output, /Pre-Cleanup-B snapshot/);
    assert.match(output, /equip --restore-pre-cleanup-b/);
    assert.match(output, /equip --discard-pre-cleanup-b-backup/);
    // Not the failure variant.
    assert.doesNotMatch(output, /Cleanup B migration appears incomplete/);
  });

  it("backup exists + legacy augments dir present → fires as ISSUE (cutover-incomplete)", () => {
    writeBackupSnapshot(process.env.EQUIP_HOME, { "incomplete-1": { name: "incomplete-1" } });
    writeLegacyAugment(process.env.EQUIP_HOME, "lingering", { name: "lingering" });

    const output = captureDoctorOutput(() => runDoctor());
    assert.match(output, /Cleanup B migration appears incomplete/);
    assert.match(output, /Legacy files present on disk/);
    assert.match(output, /Re-run the sidecar/);
    assert.match(output, /equip --restore-pre-cleanup-b/);
    // The doctor's summary line includes the issue count — verify at least 1 issue.
    // (Avoid \b — preceding ANSI escape ends in `m` which is a word char,
    // suppresses the boundary against the digit.)
    assert.match(output, /\d+ issues? found/, `expected issue counter; got:\n${output}`);
  });

  it("backup exists + legacy installations.json present (no augments dir) → fires as ISSUE", () => {
    writeBackupSnapshot(process.env.EQUIP_HOME, { "x": { name: "x" } });
    fs.writeFileSync(
      path.join(process.env.EQUIP_HOME, "installations.json"),
      JSON.stringify({ lastUpdated: "x", augments: {} }),
    );

    const output = captureDoctorOutput(() => runDoctor());
    assert.match(output, /Cleanup B migration appears incomplete/,
      "either legacy file alone is sufficient to fire the warning");
  });

  it("issue counter increments — cutover-incomplete is reflected in the summary", () => {
    writeBackupSnapshot(process.env.EQUIP_HOME, { "x": { name: "x" } });
    writeLegacyAugment(process.env.EQUIP_HOME, "stuck", { name: "stuck" });

    const output = captureDoctorOutput(() => runDoctor());
    // Doctor's summary line says "N issue(s) found" or "All N checks passed".
    // With cutover-incomplete tripped, must say "issue".
    assert.doesNotMatch(output, /All \d+ checks passed/);
    assert.match(output, /\d+ issues? found/);
  });
});
