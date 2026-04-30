// Test helpers for setting up storage state in tests that exercise
// non-storage production code (mcp install, skill collision, etc.).
//
// These are NOT production code. They live in test/ and exist to bridge
// legacy-style test setup (which used `trackInstallation` etc.) to the
// journal model. As tests migrate to use these helpers, the corresponding
// legacy module imports disappear from test/.

"use strict";

const path = require("node:path");

let cachedDataStoreModule = null;

function getJsonStore() {
  if (!cachedDataStoreModule) {
    // require for CJS compatibility (test files are CJS).
    cachedDataStoreModule = require(path.resolve(__dirname, "..", "..", "dist", "lib", "storage", "datastore.js"));
  }
  return cachedDataStoreModule.JsonStore;
}

/**
 * Set up an augment as installed on the given platforms, with the given
 * content. Replaces test setups that previously called:
 *   trackInstallation(name, { source, title, transport, platforms, artifacts });
 *
 * Mapping from legacy InstallationRecord to journal:
 *   - source     → contentSource.kind ("registry"|"local-authored")
 *   - title      → content.title
 *   - transport  → content.transport
 *   - platforms  → install intent platforms array
 *   - artifacts  → IGNORED (the journal model doesn't carry per-platform
 *                   artifact details on intents; per-platform skill ownership
 *                   is derived from content.skills × installedPlatforms)
 */
function setupInstalledAugment(name, opts) {
  const JsonStore = getJsonStore();
  const {
    source = "registry",
    title = name,
    transport = "http",
    serverUrl = `https://example.com/${name}/mcp`,
    stdio,
    requiresAuth = false,
    rules,
    skills = [],
    hooks = [],
    platforms = [],
    version = 1,
    etag,
  } = opts || {};

  const content = {
    name,
    title,
    description: `Test fixture for ${name}`,
    transport,
    serverUrl: transport === "http" ? serverUrl : undefined,
    stdio: transport === "stdio" ? stdio : undefined,
    requiresAuth,
    rules,
    skills,
    hooks,
  };

  const contentHash = JsonStore.putContent(content);
  const contentSource = source === "registry"
    ? {
      kind: "registry",
      version,
      etag: etag || `etag-${name}-v${version}`,
      fetchedAt: new Date().toISOString(),
    }
    : { kind: "local-authored", createdAt: new Date().toISOString() };

  // Optional installModes (per-platform broker vs direct). Test helper
  // supports either an `installModes` map directly OR derives from the
  // legacy `artifacts[platformId].installMode` shape (when callers pass
  // through the legacy shape via the equip.test.js shim).
  const installModes = (opts && opts.installModes) || (() => {
    const out = {};
    if (opts && opts.artifacts) {
      for (const platformId of Object.keys(opts.artifacts)) {
        const m = opts.artifacts[platformId]?.installMode;
        if (m === "broker") out[platformId] = "broker";
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  })();

  JsonStore.appendIntent({
    type: "install-augment",
    clock: JsonStore.newClock(),
    name,
    contentHash,
    contentSource,
    platforms,
    ...(installModes ? { installModes } : {}),
  });

  // Phase A transition: also dual-write to legacy installs-store so consumers
  // that haven't migrated yet (commands/install.ts:writeAugmentDefAndApply still
  // reads via readInstall) see the augment as managed. This dual-write lives
  // ONLY in this test helper (no production impact); A4 deletes it along with
  // the legacy modules.
  try {
    const legacyInstallationsPath = path.resolve(__dirname, "..", "..", "dist", "lib", "installations.js");
    const fs = require("node:fs");
    if (fs.existsSync(legacyInstallationsPath)) {
      const installations = require(legacyInstallationsPath);
      if (installations && typeof installations.trackInstallation === "function") {
        const artifacts = {};
        for (const platformId of platforms) {
          artifacts[platformId] = {
            mcp: !!(content.serverUrl || content.stdio),
            rules: content.rules?.version,
            skills: (content.skills || []).map((s) => s.name),
          };
        }
        installations.trackInstallation(name, {
          source: source === "registry" ? "registry" : (source === "wrapped" ? "wrapped" : "local"),
          title,
          transport,
          serverUrl: content.serverUrl,
          platforms,
          artifacts,
        });
      }
    }
  } catch { /* legacy module not present (post-A4) — fine */ }

  return { contentHash, content };
}

module.exports = { setupInstalledAugment, getJsonStore };
