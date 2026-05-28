// State reconciliation — scans platform configs after tool dispatch
// and writes an InstallAugmentIntent to the journal reflecting what's
// actually on disk.
//
// Called by the global CLI after a tool's setup completes, and by the
// apply() pipeline after platform writes.
//
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PLATFORM_REGISTRY } from "./platforms";
import { detectPlatforms } from "./detect";
import { readMcpEntry } from "./mcp";
import { dirExists, fileExists } from "./detect";
import { acquireLock } from "./fs";
import { JsonStore } from "./storage/datastore";
import type { AugmentContent } from "./storage/content-store";
import type { ContentHash, ContentSource, PlatformInstallMode } from "./storage/intent";
import { scanAllPlatforms } from "./platform-state";
import { markEquipUpdated } from "./equip-meta";
import { createSnapshot, hasInitialSnapshot } from "./snapshots";
import type { RegistryDef } from "./registry";
import type { EquipLogger } from "./types";
import { NOOP_LOGGER } from "./types";

// ─── Types ──────────────────────────────────────────────────

export interface ReconcileOptions {
  /** Augment name (used as key in state and to find MCP entries) */
  toolName: string;
  /** npm package name (e.g. "@cg3/prior-node") — kept for back-compat; unused post-A */
  package: string;
  /** Rules marker name. Defaults to toolName if not provided. */
  marker?: string;
  /** Hook directory path. Defaults to ~/.{toolName}/hooks if not provided. */
  hookDir?: string;
  /** Registry definition (if available, used to build the content blob) */
  toolDef?: RegistryDef;
  /** Logger for debug/warning output (silent by default) */
  logger?: EquipLogger;
}

// ─── Reconcile ──────────────────────────────────────────────

/**
 * Scan all platform configs and update state based on what's on disk.
 * Returns the number of platforms where the augment was found.
 */
export function reconcileState(options: ReconcileOptions): number {
  const { toolName, marker = toolName, hookDir: customHookDir, toolDef, logger = NOOP_LOGGER } = options;
  const defaultHookDir = path.join(os.homedir(), `.${toolName}`, "hooks");
  const hookDir = customHookDir || defaultHookDir;

  const releaseLock = acquireLock();
  try {
    return reconcileStateInner(toolName, marker, hookDir, toolDef, logger);
  } finally {
    releaseLock();
  }
}

/**
 * Resolve the set of skill names declared by an augment, consulting the
 * registry def first (freshest) and falling back to the journal-resolved
 * augment view.
 */
function collectDeclaredSkillNames(toolName: string, toolDef: RegistryDef | undefined): string[] {
  const names = new Set<string>();
  if (toolDef?.skills) {
    for (const s of toolDef.skills) if (s?.name) names.add(s.name);
  }
  const resolved = JsonStore.resolve(toolName);
  if (resolved?.skills) {
    for (const s of resolved.skills) if (s?.name) names.add(s.name);
  }
  return [...names];
}

/**
 * Convert a RegistryDef into the AugmentContent shape stored in the
 * content-addressed blob store.
 */
function registryDefToContent(def: RegistryDef): AugmentContent {
  const rawTransport = def.transport || (def.stdioCommand ? "stdio" : "http");
  const transport: AugmentContent["transport"] =
    rawTransport === "stdio" || rawTransport === "sse" || rawTransport === "streamable-http"
      ? rawTransport
      : "http";
  return {
    name: def.name,
    title: def.title || def.name,
    description: def.description || "",
    transport,
    serverUrl: transport === "http" || transport === "streamable-http" || transport === "sse" ? def.serverUrl : undefined,
    stdio: def.stdioCommand
      ? { command: def.stdioCommand, args: def.stdioArgs || [], ...(def.envKey ? { envKey: def.envKey } : {}) }
      : undefined,
    npmPackage: def.npmPackage,
    setupCommand: def.setupCommand,
    installTargets: def.installTargets,
    requiresAuth: def.requiresAuth || false,
    auth: def.auth as Record<string, unknown> | undefined,
    subtitle: def.subtitle,
    flavorText: def.flavorText,
    categories: def.categories,
    homepage: def.homepage,
    repository: def.repository,
    license: def.license,
    rules: def.rules
      ? { content: def.rules.content, version: def.rules.version, marker: def.rules.marker }
      : undefined,
    skills: def.skills?.map((s) => ({ name: s.name, files: s.files || [] })),
    hooks: def.hooks,
  };
}

function reconcileStateInner(
  toolName: string,
  marker: string,
  hookDir: string,
  toolDef: RegistryDef | undefined,
  logger: EquipLogger,
): number {
  // Build content blob from the registry def (when present). We do this
  // before scanning so the content hash is available when appending the
  // install intent.
  let contentHash: ContentHash | null = null;
  let contentSource: ContentSource | null = null;
  if (toolDef) {
    try {
      const content = registryDefToContent(toolDef);
      contentHash = JsonStore.putContent(content);
      contentSource = {
        kind: "registry",
        version: toolDef.version || 1,
        etag: toolDef.contentHash,
        fetchedAt: new Date().toISOString(),
      };
    } catch (e: unknown) {
      logger.debug("Failed to write content blob from registry def", { error: (e as Error).message });
    }
  }

  // Read existing journal state so we can preserve per-platform installMode.
  // Broker-managed installs look identical on disk to direct-mode (just a
  // command+args pointing at the broker shim), so without this preservation
  // step every reconcile would silently downgrade installMode "broker" back
  // to "direct".
  const existing = JsonStore.resolve(toolName);

  let count = 0;
  const installedPlatforms: string[] = [];

  for (const [id, def] of PLATFORM_REGISTRY) {
    // Quick presence check (fast fs stat)
    const dirFound = def.detection.dirs.some((fn) => dirExists(fn()));
    const fileFound = def.detection.files.some((fn) => fileExists(fn()));
    const configPath = def.configPath();
    if (!dirFound && !fileFound && !fileExists(configPath)) continue;

    let hasAnyArtifact = false;

    // Check MCP config
    const entry = readMcpEntry(configPath, def.rootKey, toolName, def.configFormat);
    if (entry) hasAnyArtifact = true;

    // Check for rules
    if (def.rulesPath) {
      try {
        const rulesContent = fs.readFileSync(def.rulesPath(), "utf-8");
        if (new RegExp(`<!-- ${marker}:v([0-9.]+) -->`).test(rulesContent)) {
          hasAnyArtifact = true;
        }
      } catch { /* rules file may not exist */ }
    }

    // Check for hooks
    if (def.hooks) {
      try {
        const hookFiles = fs.readdirSync(hookDir).filter((f) => f.endsWith(".js"));
        if (hookFiles.length > 0) hasAnyArtifact = true;
      } catch { /* hook dir may not exist */ }
    }

    // Check for skills.
    // Skills now live flat at {skillsPath}/{skillName}/SKILL.md, so we can't infer
    // which skills belong to this augment by listing a directory. Cross-reference
    // the augment's declared skill names (from registry def or resolved augment)
    // and look each one up at the flat path. Also accept legacy nested installs
    // from older equip versions so reconcile reflects what's still on disk.
    if (def.skillsPath) {
      const skillsBasePath = def.skillsPath();
      const declaredSkills = collectDeclaredSkillNames(toolName, toolDef);
      for (const skillName of declaredSkills) {
        const flat = path.join(skillsBasePath, skillName, "SKILL.md");
        const legacy = path.join(skillsBasePath, toolName, skillName, "SKILL.md");
        try { if (fs.statSync(flat).isFile()) { hasAnyArtifact = true; break; } } catch { /* fall through */ }
        try { if (fs.statSync(legacy).isFile()) { hasAnyArtifact = true; break; } } catch { /* not installed on this platform */ }
      }
    }

    if (!hasAnyArtifact) continue;

    installedPlatforms.push(id);
    count++;
  }

  // Append InstallAugmentIntent to the journal. Requires content (we can't
  // record an install without knowing what content was applied). When
  // toolDef is absent (CLI discovery flow), we skip — the augment was
  // presumably installed via a prior intent that already carries the
  // content reference, so the journal state is already correct.
  if (installedPlatforms.length > 0 && contentHash && contentSource) {
    // Preserve broker mode for platforms that previously had it. Default
    // direct mode is implicit (omitted from installModes).
    const installModes: Record<string, PlatformInstallMode> = {};
    if (existing) {
      for (const platformId of installedPlatforms) {
        if (existing.installModes[platformId] === "broker") {
          installModes[platformId] = "broker";
        }
      }
    }
    try {
      JsonStore.appendIntent({
        type: "install-augment",
        clock: JsonStore.newClock(),
        name: toolName,
        contentHash,
        contentSource,
        platforms: installedPlatforms,
        ...(Object.keys(installModes).length > 0 ? { installModes } : {}),
      });
    } catch (e: unknown) {
      logger.debug("Failed to append install intent", { error: (e as Error).message });
    }
  }

  // Update platform scan files and metadata
  try {
    const detected = detectPlatforms();

    // First-detection snapshots (best effort)
    for (const p of detected) {
      try {
        if (!hasInitialSnapshot(p.platform)) {
          createSnapshot(p, { label: "initial", trigger: "first-detection" });
          logger.debug("Initial snapshot created", { platform: p.platform });
        }
      } catch (e: unknown) {
        logger.debug("Failed to create initial snapshot", { platform: p.platform, error: (e as Error).message });
      }
    }

    const managedNames = new Set(
      JsonStore.listResolved().filter((r) => r.installed).map((r) => r.name),
    );
    scanAllPlatforms(detected, managedNames);
    markEquipUpdated();
  } catch (e: unknown) {
    logger.debug("Failed to update platform state", { error: (e as Error).message });
  }

  return count;
}
