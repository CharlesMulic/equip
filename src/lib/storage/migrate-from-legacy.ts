// One-shot disk migration: any prior on-disk format → journal-canonical.
//
// Triggers: invoked from `migrateStorageToJournal()`, gated by
// `.schema_version < 5`. Reads whatever's on disk in the prior formats:
//
//   - Pre-storage-refactor era: ~/.equip/augments/<name>.json + ~/.equip/installations.json
//   - Post-storage-refactor era (defs/cache/installs split): ~/.equip/defs/<name>.json +
//     ~/.equip/cache/<name>.json + ~/.equip/installs/<name>.json
//
// Either, both, or neither may be present. The migration unifies them into:
//   ~/.equip/storage/intents.jsonl + ~/.equip/storage/content/<hash>.json
//
// Backs up everything to ~/.equip/.backup-pre-storage-redesign/ before
// deletion. Idempotent: re-running on schema_version=5 is a no-op.
// Per-file failures are tolerated + logged; the migration completes with
// best-effort coverage.
//
// **No imports from the legacy modules.** This file reads raw JSON via fs
// because the legacy modules are deleted in Phase A.4. The legacy on-disk
// schemas are stable (frozen by prior shipped releases); we hand-decode them.

import * as fs from "fs";
import * as path from "path";
import { getEquipHome } from "../equip-home";
import { posixMode } from "../posix-mode";
import { JsonStore } from "./datastore";
import { type AugmentContent } from "./content-store";
import { type Intent, type ContentSource, type ModOverrides } from "./intent";

const TARGET_SCHEMA_VERSION = 5;
const SCHEMA_VERSION_FILE = ".schema_version";
const BACKUP_DIRNAME = ".backup-pre-storage-redesign";

// Legacy paths (frozen schema; we hand-decode the JSON)
const LEGACY_AUGMENTS_DIRNAME = "augments";              // pre-refactor
const LEGACY_INSTALLATIONS_FILENAME = "installations.json"; // pre-refactor
const POST_REFACTOR_DEFS_DIRNAME = "defs";               // 3-store era
const POST_REFACTOR_CACHE_DIRNAME = "cache";             // 3-store era
const POST_REFACTOR_INSTALLS_DIRNAME = "installs";       // 3-store era

// ─── Result type ──────────────────────────────────────────

export type MigrationStatus = "complete" | "skipped-already-migrated" | "no-legacy-data" | "errors";

export interface MigrationResult {
  status: MigrationStatus;
  augmentsMigrated: number;
  intentsAppended: number;
  contentBlobsWritten: number;
  backupPath: string | null;
  /** Per-augment errors (best-effort; doesn't abort the migration). */
  errors: string[];
}

// ─── Public API ───────────────────────────────────────────

/**
 * Run the migration. Idempotent: skipped if schema_version >= 5.
 * Caller should invoke once on first boot OR via
 * `equip --migrate-to-storage` for testing during Phase A.
 */
export function migrateFromLegacy(opts: { force?: boolean } = {}): MigrationResult {
  const home = getEquipHome();
  if (!opts.force && currentSchemaVersion(home) >= TARGET_SCHEMA_VERSION) {
    return {
      status: "skipped-already-migrated",
      augmentsMigrated: 0,
      intentsAppended: 0,
      contentBlobsWritten: 0,
      backupPath: null,
      errors: [],
    };
  }

  // Detect what's present.
  const hasPreRefactor = fs.existsSync(path.join(home, LEGACY_AUGMENTS_DIRNAME))
    || fs.existsSync(path.join(home, LEGACY_INSTALLATIONS_FILENAME));
  const hasPostRefactor = fs.existsSync(path.join(home, POST_REFACTOR_DEFS_DIRNAME))
    || fs.existsSync(path.join(home, POST_REFACTOR_CACHE_DIRNAME))
    || fs.existsSync(path.join(home, POST_REFACTOR_INSTALLS_DIRNAME));

  if (!hasPreRefactor && !hasPostRefactor) {
    // Fresh install — nothing to migrate; just stamp the version marker.
    writeSchemaVersion(home, TARGET_SCHEMA_VERSION);
    return {
      status: "no-legacy-data",
      augmentsMigrated: 0,
      intentsAppended: 0,
      contentBlobsWritten: 0,
      backupPath: null,
      errors: [],
    };
  }

  // Backup first (atomic enough — rsync-style copy before any deletion).
  const backupPath = backupLegacyFiles(home, hasPreRefactor, hasPostRefactor);

  // Build the unified augment view by merging both eras.
  // Post-refactor wins where both are present (it's more recent).
  const unified = unifyLegacyEras(home, hasPreRefactor, hasPostRefactor);

  // Convert each augment to intents + content blobs.
  let intentsAppended = 0;
  let contentBlobsWritten = 0;
  const errors: string[] = [];

  for (const [name, view] of unified) {
    try {
      const result = migrateOneAugment(name, view);
      intentsAppended += result.intentsAppended;
      contentBlobsWritten += result.contentBlobsWritten;
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Stamp the marker only if no errors. Per-file errors are tolerated; whole-
  // migration failures (e.g., backup creation failed) would have thrown above.
  if (errors.length === 0) {
    writeSchemaVersion(home, TARGET_SCHEMA_VERSION);
  }

  return {
    status: errors.length === 0 ? "complete" : "errors",
    augmentsMigrated: unified.size,
    intentsAppended,
    contentBlobsWritten,
    backupPath,
    errors,
  };
}

export function currentSchemaVersion(home: string): number {
  const p = path.join(home, SCHEMA_VERSION_FILE);
  try {
    const raw = fs.readFileSync(p, "utf-8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 1;
  } catch {
    return 1;
  }
}

function writeSchemaVersion(home: string, version: number): void {
  if (!fs.existsSync(home)) fs.mkdirSync(home, { recursive: true, mode: posixMode(0o700) });
  fs.writeFileSync(path.join(home, SCHEMA_VERSION_FILE), String(version), "utf-8");
}

// ─── Backup ───────────────────────────────────────────────

function backupLegacyFiles(home: string, hasPreRefactor: boolean, hasPostRefactor: boolean): string {
  const backupDir = path.join(home, BACKUP_DIRNAME);
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true, mode: posixMode(0o700) });

  if (hasPreRefactor) {
    const augSrc = path.join(home, LEGACY_AUGMENTS_DIRNAME);
    if (fs.existsSync(augSrc)) copyDirRecursive(augSrc, path.join(backupDir, LEGACY_AUGMENTS_DIRNAME));
    const instSrc = path.join(home, LEGACY_INSTALLATIONS_FILENAME);
    if (fs.existsSync(instSrc)) fs.copyFileSync(instSrc, path.join(backupDir, LEGACY_INSTALLATIONS_FILENAME));
  }
  if (hasPostRefactor) {
    for (const dirname of [POST_REFACTOR_DEFS_DIRNAME, POST_REFACTOR_CACHE_DIRNAME, POST_REFACTOR_INSTALLS_DIRNAME]) {
      const src = path.join(home, dirname);
      if (fs.existsSync(src)) copyDirRecursive(src, path.join(backupDir, dirname));
    }
  }

  return backupDir;
}

function copyDirRecursive(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true, mode: posixMode(0o700) });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ─── Unified per-augment view ─────────────────────────────

/**
 * The merged view of one augment, drawn from whatever legacy formats are on
 * disk. Field semantics:
 *   - `name` — augment name
 *   - `defShape` — sovereign content shape (registry pub fields + user mods).
 *     Sourced from the most-authoritative legacy file present.
 *   - `installRecord` — install metadata (which platforms, artifacts).
 *   - `isModded` — true iff `defShape` carries a non-empty modded= flag with mods.
 */
interface UnifiedAugmentView {
  name: string;
  defShape: LegacyDefShape | null;
  installRecord: LegacyInstallRecord | null;
  isModded: boolean;
}

interface LegacyDefShape {
  name: string;
  source?: "registry" | "local" | "wrapped";
  kind?: "local" | "wrapped" | "overlay";
  title?: string;
  description?: string;
  transport?: "http" | "streamable-http" | "sse" | "stdio";
  serverUrl?: string;
  stdio?: { command: string; args: string[]; envKey?: string };
  requiresAuth?: boolean;
  rules?: { content: string; version: string; marker: string };
  rulesUpstream?: { content: string; version: string; marker: string };
  skills?: { name: string; files: { path: string; content: string }[] }[];
  hooks?: { event: string; matcher?: string; script: string; name: string }[];
  modded?: boolean;
  moddedFields?: ("rules" | "skills" | "hooks")[];
  registryContentHash?: string;
  registryEtag?: string;
  registryVersionNumber?: number;
  registryStatus?: string;
  lastValidatedAt?: string;
}

interface LegacyInstallRecord {
  platforms?: string[];
  artifacts?: Record<string, unknown>;
  installedAt?: string;
  updatedAt?: string;
}

function unifyLegacyEras(home: string, hasPreRefactor: boolean, hasPostRefactor: boolean): Map<string, UnifiedAugmentView> {
  const out = new Map<string, UnifiedAugmentView>();

  // Pre-refactor pass
  if (hasPreRefactor) {
    const augDir = path.join(home, LEGACY_AUGMENTS_DIRNAME);
    if (fs.existsSync(augDir)) {
      for (const file of fs.readdirSync(augDir).filter((f) => f.endsWith(".json"))) {
        const name = file.replace(/\.json$/, "");
        const def = readJsonSilent<LegacyDefShape>(path.join(augDir, file));
        if (def) {
          out.set(name, {
            name,
            defShape: def,
            installRecord: null,
            isModded: !!def.modded && (def.moddedFields ?? []).length > 0,
          });
        }
      }
    }
    const instData = readJsonSilent<{ augments?: Record<string, LegacyInstallRecord> }>(
      path.join(home, LEGACY_INSTALLATIONS_FILENAME),
    );
    for (const [name, rec] of Object.entries(instData?.augments ?? {})) {
      const existing = out.get(name);
      if (existing) {
        existing.installRecord = rec;
      } else {
        out.set(name, { name, defShape: null, installRecord: rec, isModded: false });
      }
    }
  }

  // Post-refactor pass — wins where both eras present (more recent)
  if (hasPostRefactor) {
    const defsDir = path.join(home, POST_REFACTOR_DEFS_DIRNAME);
    const cacheDir = path.join(home, POST_REFACTOR_CACHE_DIRNAME);
    const installsDir = path.join(home, POST_REFACTOR_INSTALLS_DIRNAME);

    // Collect names from all three new-store dirs
    const allNames = new Set<string>();
    for (const d of [defsDir, cacheDir, installsDir]) {
      if (fs.existsSync(d)) {
        for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".json"))) {
          allNames.add(f.replace(/\.json$/, ""));
        }
      }
    }

    for (const name of allNames) {
      const defs = readJsonSilent<LegacyDefShape>(path.join(defsDir, `${name}.json`));
      const cache = readJsonSilent<LegacyDefShape>(path.join(cacheDir, `${name}.json`));
      const install = readJsonSilent<LegacyInstallRecord>(path.join(installsDir, `${name}.json`));

      // Merge defs + cache: defs is sovereign for kind+overlay fields,
      // cache provides registry-published content + freshness.
      let defShape: LegacyDefShape | null = null;
      if (defs && cache) {
        // Modded registry case (overlay over cache): cache has the publisher
        // content, defs has the user's overlay fields. Merge with defs winning
        // for the typed-allowlist fields, cache providing the rest.
        defShape = {
          ...cache,
          name,
          source: defs.kind === "local" ? "local" : defs.kind === "wrapped" ? "wrapped" : "registry",
          rules: defs.rules ?? cache.rules,
          skills: defs.skills ?? cache.skills,
          hooks: defs.hooks ?? cache.hooks,
          modded: defs.kind === "overlay",
          moddedFields: defs.kind === "overlay"
            ? (["rules", "skills", "hooks"] as const).filter(
              (f) => (defs as unknown as Record<string, unknown>)[f] !== undefined,
            )
            : undefined,
          rulesUpstream: cache.rules,
        };
      } else if (defs) {
        defShape = {
          ...defs,
          source: defs.kind === "local" ? "local" : defs.kind === "wrapped" ? "wrapped" : "registry",
        };
      } else if (cache) {
        defShape = { ...cache, name, source: "registry" };
      }

      // Post-refactor data wins
      out.set(name, {
        name,
        defShape,
        installRecord: install,
        isModded: !!defShape?.modded && (defShape.moddedFields ?? []).length > 0,
      });
    }
  }

  return out;
}

// ─── Per-augment migration ────────────────────────────────

interface PerAugmentResult {
  intentsAppended: number;
  contentBlobsWritten: number;
}

function migrateOneAugment(name: string, view: UnifiedAugmentView): PerAugmentResult {
  const def = view.defShape;
  if (!def) {
    // Install record exists but no def — orphan; emit a minimal intent so
    // the record isn't lost. Resolver will return null until content lands.
    if (view.installRecord) {
      JsonStore.appendIntent({
        type: "install-augment",
        clock: JsonStore.newClock(),
        name,
        contentHash: "0".repeat(64), // placeholder; resolver handles missing-content gracefully
        contentSource: { kind: "local-authored", createdAt: new Date().toISOString() },
        platforms: view.installRecord.platforms ?? [],
      });
      return { intentsAppended: 1, contentBlobsWritten: 0 };
    }
    return { intentsAppended: 0, contentBlobsWritten: 0 };
  }

  // Build the content blob — publisher's view of the augment.
  // For modded registry augments: use rulesUpstream as the publisher rules
  // (so the mod intent below can carry the user's overrides).
  // For everything else: use the augment's current rules as content.
  const publisherContent: AugmentContent = {
    name: def.name,
    title: def.title ?? def.name,
    description: def.description ?? "",
    transport: def.transport,
    serverUrl: def.serverUrl,
    stdio: def.stdio ? { command: def.stdio.command, args: def.stdio.args } : undefined,
    requiresAuth: def.requiresAuth ?? false,
    rules: view.isModded && def.rulesUpstream ? def.rulesUpstream : def.rules,
    skills: view.isModded && (def.moddedFields ?? []).includes("skills") ? undefined : def.skills,
    hooks: view.isModded && (def.moddedFields ?? []).includes("hooks") ? undefined : def.hooks,
  };

  const contentHash = JsonStore.putContent(publisherContent);

  const contentSource: ContentSource = def.source === "local" || def.source === "wrapped"
    ? { kind: "local-authored", createdAt: def.lastValidatedAt ?? new Date().toISOString() }
    : {
      kind: "registry",
      version: def.registryVersionNumber ?? 1,
      etag: def.registryEtag,
      fetchedAt: def.lastValidatedAt ?? new Date().toISOString(),
    };

  // Append install intent reflecting current install state.
  JsonStore.appendIntent({
    type: "install-augment",
    clock: JsonStore.newClock(),
    name,
    contentHash,
    contentSource,
    platforms: view.installRecord?.platforms ?? [],
  });
  let intentsAppended = 1;

  // If modded, append a mod intent with the user's overrides.
  if (view.isModded) {
    const overrides: ModOverrides = {};
    const moddedFields = def.moddedFields ?? [];
    if (moddedFields.includes("rules") && def.rules) overrides.rules = def.rules;
    if (moddedFields.includes("skills") && def.skills) overrides.skills = def.skills;
    if (moddedFields.includes("hooks") && def.hooks) overrides.hooks = def.hooks;
    if (Object.keys(overrides).length > 0) {
      JsonStore.appendIntent({
        type: "mod-augment",
        clock: JsonStore.newClock(),
        name,
        overrides,
      });
      intentsAppended++;
    }
  }

  return { intentsAppended, contentBlobsWritten: 1 };
}

// ─── Helpers ──────────────────────────────────────────────

function readJsonSilent<T = unknown>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}
