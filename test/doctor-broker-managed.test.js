// Tests for equip doctor's broker-managed branch.
//
// Doctor's job for broker-managed installs:
//   1. Skip the URL-HTTPS check (entry has no url)
//   2. Skip the auth-header check (entry has no headers)
//   3. Emit a one-line hint that broker runtime is managed externally
//   4. Continue checking rules/hooks/skills (orthogonal to auth)
//
// Doctor does NOT call broker IPC. Doctor does NOT read the broker's
// credential store. Architect rule: a flat `installMode` field on the
// install record is the only boundary signal.

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { runDoctor } = require("../dist/lib/commands/doctor");
// Phase A: trackInstallation is dead. Use storage-layer test helper that
// translates the legacy artifacts shape (including installMode) → install
// intent on the journal.
const { setupInstalledAugment } = require("./storage/_test-helpers");
function trackInstallation(name, opts) {
  const { artifacts, ...rest } = opts || {};
  let skills = rest.skills;
  if (!skills && artifacts) {
    const skillNames = new Set();
    for (const platformId of Object.keys(artifacts)) {
      for (const s of artifacts[platformId]?.skills ?? []) skillNames.add(s);
    }
    if (skillNames.size > 0) {
      skills = [...skillNames].map((n) => ({
        name: n,
        files: [{ path: "SKILL.md", content: `---\nname: ${n}\ndescription: x\n---\n` }],
      }));
    }
  }
  setupInstalledAugment(name, { ...rest, skills, artifacts });
}
function trackUninstallation() { /* no-op; test isolation handles cleanup */ }
function readInstallations() {
  // Compatibility shim — return legacy-shape from storage layer for any
  // tests that still assert on installations.augments[name] structure.
  const { JsonStore } = require("../dist/lib/storage/datastore.js");
  const augments = {};
  for (const r of JsonStore.listResolved()) {
    if (r.installed) {
      augments[r.name] = {
        source: r.contentSource.kind === "registry" ? "registry" : "local",
        title: r.title,
        platforms: r.installedPlatforms,
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artifacts: {},
      };
    }
  }
  return { lastUpdated: new Date().toISOString(), augments };
}

const { setupFullHome } = require("./_isolation");

let isolation, tempHome;

function setupTempHome() {
  isolation = setupFullHome("doctor-broker");
  tempHome = isolation.home;
}

function teardownTempHome() {
  isolation.dispose();
}

/**
 * Capture output emitted by runDoctor. cli.log writes to process.stderr
 * (see equip/src/lib/cli.ts:20); intercept that.
 */
function captureDoctorOutput(fn) {
  const origWrite = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = (chunk) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    return true;
  };
  try { fn(); }
  finally { process.stderr.write = origWrite; }
  return buf;
}

describe("equip doctor: broker-managed branch", () => {
  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("emits the broker-health hint for installations with installMode=broker", () => {
    // Seed installations.json with a broker-managed augment.
    // Codex's configPath() resolves to $CODEX_HOME/config.toml, so write
    // the entry there.
    process.env.CODEX_HOME = tempHome;
    const codexConfigPath = path.join(tempHome, "config.toml");
    fs.writeFileSync(codexConfigPath, `[mcp_servers.broker-augment]\ncommand = "/opt/equip/bin/equip-broker-fd-bridge"\nargs = ["--augment", "broker-augment"]\n`);

    trackInstallation("broker-augment", {
      source: "registry",
      title: "Stub Broker Augment",
      transport: "stdio",
      platforms: ["codex"],
      artifacts: { codex: { mcp: true, installMode: "broker" } },
    });

    const output = captureDoctorOutput(() => runDoctor());

    delete process.env.CODEX_HOME;

    assert.match(
      output,
      /broker-managed — runtime status is managed externally/,
      `expected broker-managed hint; got:\n${output}`,
    );
  });

  it("does NOT emit the broker-health hint for direct-mode installs", () => {
    process.env.CODEX_HOME = tempHome;
    const codexConfigPath = path.join(tempHome, "config.toml");
    fs.writeFileSync(codexConfigPath, `[mcp_servers.direct-augment]\nurl = "https://example.com/mcp"\n`);

    trackInstallation("direct-augment", {
      source: "registry",
      title: "Direct Augment",
      transport: "http",
      platforms: ["codex"],
      artifacts: { codex: { mcp: true } }, // no installMode → direct
    });

    const output = captureDoctorOutput(() => runDoctor());

    delete process.env.CODEX_HOME;

    assert.doesNotMatch(output, /broker-managed/, `direct-mode install must NOT emit broker hint; got:\n${output}`);
  });

  it("does NOT call auth-engine.readStoredCredential for broker-managed entries", () => {
    // Indirect check: broker-managed augments have credentials in the
    // sidecar's FileCredentialStore (~/.equip/secrets/), NOT in
    // auth-engine's store (~/.equip/credentials/). Doctor reads only the
    // latter; this test verifies that broker-managed augments don't
    // *cause* doctor to look anywhere it shouldn't.
    //
    // We verify this by: (a) seeding a broker-managed install, (b) NOT
    // creating any auth-engine credential file, (c) observing that doctor
    // doesn't fail/warn about the missing credential for the broker
    // augment (because it never tried to look). The hint replaces the
    // warning.
    process.env.CODEX_HOME = tempHome;
    const codexConfigPath = path.join(tempHome, "config.toml");
    fs.writeFileSync(codexConfigPath, `[mcp_servers.broker-augment]\ncommand = "shim"\nargs = []\n`);

    trackInstallation("broker-augment", {
      source: "registry",
      title: "Broker Augment",
      transport: "http", // upstream is HTTP — would trigger auth check in direct mode
      platforms: ["codex"],
      artifacts: { codex: { mcp: true, installMode: "broker" } },
    });

    const output = captureDoctorOutput(() => runDoctor());

    delete process.env.CODEX_HOME;

    // Auth header check for HTTP transport would normally warn here.
    // For broker-managed installs, that branch is skipped.
    assert.doesNotMatch(output, /no auth header found/, `auth-header warning must not fire for broker-managed; got:\n${output}`);
    assert.doesNotMatch(output, /auth token expired/, `auth-expired error must not fire for broker-managed; got:\n${output}`);
  });
});
