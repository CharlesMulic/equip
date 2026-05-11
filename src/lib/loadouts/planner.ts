import * as crypto from "crypto";
import { detectPlatforms } from "../detect";
import { isCredentialExpired, readStoredCredential } from "../auth-engine";
import {
  getEnabledPlatformIds,
  isPlatformEnabled,
  readPlatformScan,
  type PlatformScan,
} from "../platform-state";
import { JsonStore, type EquipDataStore } from "../storage/datastore";
import type { ResolvedAugment } from "../storage/materializer";
import { getLoadout, LoadoutStoreError } from "./store";
import {
  LOADOUT_PLAN_SCHEMA_VERSION,
  type LoadoutComponentSummary,
  type LoadoutCredentialReader,
  type LoadoutDesiredEntry,
  type LoadoutEntry,
  type LoadoutIgnoredInventory,
  type LoadoutManifest,
  type LoadoutPlanAction,
  type LoadoutPlanCode,
  type LoadoutPlanDiagnostic,
  type LoadoutPlanDiagnosticSeverity,
  type LoadoutPlanEntry,
  type LoadoutPlanEntrySnapshot,
  type LoadoutPlanStatus,
  type LoadoutPreviewPlan,
  type LoadoutTargetResolution,
  type LoadoutTargetResolver,
} from "./types";

export interface PreviewLoadoutOptions {
  store?: EquipDataStore;
  enabledPlatformIds?: Iterable<string>;
  targetResolver?: LoadoutTargetResolver;
  credentialReader?: LoadoutCredentialReader;
  platformScanReader?: (platformId: string) => PlatformScan | null;
  now?: string;
}

const EMPTY_COMPONENT_SUMMARY: LoadoutComponentSummary = {
  mcp: false,
  rules: false,
  skills: 0,
  hooks: 0,
};

export function previewLoadout(
  target: string | LoadoutManifest,
  options: PreviewLoadoutOptions = {},
): LoadoutPreviewPlan {
  const store = options.store ?? JsonStore;
  const loadout = typeof target === "string"
    ? getLoadout(target, { migrateLegacy: false })
    : target;
  if (!loadout) {
    throw new LoadoutStoreError("loadout_not_found", `Loadout not found: ${target}`);
  }

  const now = options.now ?? new Date().toISOString();
  const enabledPlatforms = normalizeSorted(options.enabledPlatformIds ?? defaultEnabledPlatformIds());
  const currentResolved = store.listResolved();
  const currentInstalled = currentResolved.filter((augment) => isInstalledOnEnabledPlatform(augment, enabledPlatforms));
  const currentByName = new Map(currentInstalled.map((augment) => [augment.name, augment]));
  const targetEntries = loadout.entries.filter((entry) => entry.enabled);
  const targetByName = new Map(targetEntries.map((entry) => [entry.augmentName, entry]));
  const resolveTarget = options.targetResolver ?? createDefaultTargetResolver(store, currentByName);
  const hasCredential = options.credentialReader ?? defaultCredentialReader;
  const readScan = options.platformScanReader ?? readPlatformScan;

  const entries: LoadoutPlanEntry[] = [];
  const affectedPlatformSet = new Set<string>();

  for (const entry of targetEntries) {
    const current = currentByName.get(entry.augmentName) ?? null;
    const resolved = resolveTarget(entry);
    const planned = planTargetEntry(entry, current, resolved, enabledPlatforms, hasCredential);
    entries.push(planned);
    for (const platform of planned.platforms) affectedPlatformSet.add(platform);
  }

  for (const current of currentInstalled) {
    if (targetByName.has(current.name)) continue;
    const platforms = intersectEnabled(current.installedPlatforms, enabledPlatforms);
    if (platforms.length === 0 && enabledPlatforms.length > 0) continue;
    const diagnostics = enabledPlatforms.length === 0
      ? [diagnostic("no_enabled_platforms", "blocked")]
      : [];
    const status = diagnostics.some((d) => d.severity === "blocked") ? "blocked" : "ready";
    const snapshot = snapshotFromResolved(current);
    const planEntry: LoadoutPlanEntry = {
      augmentName: current.name,
      action: "uninstall",
      status,
      required: true,
      sourceKind: snapshot.sourceKind,
      shareBehavior: snapshot.sourceKind === "registry" ? "public-ref" : "local-private",
      platforms,
      codes: status === "blocked" ? ["uninstall", "no_enabled_platforms"] : ["uninstall"],
      diagnostics,
      current: snapshot,
      componentSummary: snapshot.componentSummary,
    };
    entries.push(planEntry);
    for (const platform of platforms) affectedPlatformSet.add(platform);
  }

  const ignoredInventory = collectIgnoredInventory(enabledPlatforms, readScan);
  for (const item of ignoredInventory) {
    affectedPlatformSet.add(item.platformId);
  }

  const desiredEntries = buildDesiredEntries(entries);
  const desiredComponentSummary = sumComponentSummaries(desiredEntries.map((entry) => entry.componentSummary));
  const status = planStatus(entries);
  const summary = summarizePlan(currentInstalled, targetEntries, entries, ignoredInventory, desiredComponentSummary);
  const desiredState = {
    loadoutId: loadout.id,
    mode: loadout.mode,
    platforms: enabledPlatforms,
    entries: desiredEntries.sort((a, b) => a.augmentName.localeCompare(b.augmentName)),
    componentSummary: desiredComponentSummary,
  };
  const affectedPlatforms = normalizeSorted(affectedPlatformSet);
  const planHash = computePlanHash({
    schemaVersion: LOADOUT_PLAN_SCHEMA_VERSION,
    loadout: {
      id: loadout.id,
      mode: loadout.mode,
      entries: targetEntries.map(hashableTargetEntry).sort((a, b) => a.augmentName.localeCompare(b.augmentName)),
    },
    enabledPlatforms,
    affectedPlatforms,
    entries: entries.map(hashablePlanEntry).sort((a, b) => a.augmentName.localeCompare(b.augmentName)),
    ignoredInventory: ignoredInventory.map(hashableIgnoredInventory),
    desiredState,
  });

  return {
    schemaVersion: LOADOUT_PLAN_SCHEMA_VERSION,
    generatedAt: now,
    planHash,
    status,
    canApply: status !== "blocked",
    loadout: {
      id: loadout.id,
      name: loadout.name,
      updatedAt: loadout.updatedAt,
    },
    enabledPlatforms,
    affectedPlatforms,
    entries: entries.sort((a, b) => a.augmentName.localeCompare(b.augmentName)),
    ignoredInventory,
    desiredState,
    summary,
  };
}

function planTargetEntry(
  entry: LoadoutEntry,
  current: ResolvedAugment | null,
  resolved: LoadoutTargetResolution | null,
  enabledPlatforms: string[],
  hasCredential: LoadoutCredentialReader,
): LoadoutPlanEntry {
  const diagnostics: LoadoutPlanDiagnostic[] = [];
  const codes: LoadoutPlanCode[] = [];

  const savedPlatformTargets = normalizeSorted(entry.platformTargets ?? []);
  let platforms = savedPlatformTargets.length > 0
    ? intersectEnabled(savedPlatformTargets, enabledPlatforms)
    : [...enabledPlatforms];

  if (enabledPlatforms.length === 0) {
    diagnostics.push(diagnostic("no_enabled_platforms", "blocked"));
  } else if (platforms.length === 0) {
    diagnostics.push(diagnostic("platform_unsupported", "blocked", savedPlatformTargets));
  }

  const targetResolution = resolved ?? missingResolutionFor(entry);
  const targetSnapshot = snapshotFromResolution(entry, targetResolution);
  const currentSnapshot = current ? snapshotFromResolved(current) : undefined;

  if (targetResolution.supportedPlatforms) {
    const supported = normalizeSorted(targetResolution.supportedPlatforms);
    const nextPlatforms = platforms.filter((platform) => supported.includes(platform));
    if (nextPlatforms.length !== platforms.length) {
      diagnostics.push(diagnostic("platform_unsupported", nextPlatforms.length === 0 ? "blocked" : "warning", supported));
    }
    platforms = nextPlatforms;
  }

  addResolutionDiagnostics(entry, targetResolution, diagnostics);

  const action = actionFor(entry, current, targetResolution);

  if (targetResolution.requiresAuth) {
    diagnostics.push(diagnostic("auth_required", "info"));
    if ((action === "install" || action === "update") && !hasCredential(entry.augmentName)) {
      diagnostics.push(diagnostic("credential_needed", "blocked"));
    }
  }

  if (entry.sourceKind === "local-authored" || entry.sourceKind === "wrapped") {
    const available = targetResolution.status === "available";
    diagnostics.push(diagnostic(available ? "local_private_available" : "local_private_unavailable", available ? "info" : "blocked"));
  } else if (entry.shareBehavior === "unavailable-placeholder" && targetResolution.status !== "available") {
    diagnostics.push(diagnostic("unavailable_placeholder", "blocked"));
  }
  codes.push(action);
  if (isHashOrVersionMismatch(entry, targetResolution)) {
    diagnostics.push(diagnostic("hash_version_mismatch", "warning"));
  }

  for (const item of diagnostics) {
    if (!codes.includes(item.code)) codes.push(item.code);
  }

  const status = diagnostics.some((d) => d.severity === "blocked")
    ? "blocked"
    : diagnostics.some((d) => d.severity === "warning")
      ? "warning"
      : "ready";

  return {
    augmentName: entry.augmentName,
    action,
    status,
    required: entry.required !== false,
    sourceKind: entry.sourceKind,
    shareBehavior: entry.shareBehavior,
    platforms,
    ...(savedPlatformTargets.length > 0 ? { savedPlatformTargets } : {}),
    codes,
    diagnostics,
    ...(currentSnapshot ? { current: currentSnapshot } : {}),
    ...(targetSnapshot ? { target: targetSnapshot } : {}),
    componentSummary: targetSnapshot?.componentSummary ?? currentSnapshot?.componentSummary ?? EMPTY_COMPONENT_SUMMARY,
  };
}

function createDefaultTargetResolver(
  store: EquipDataStore,
  currentByName: Map<string, ResolvedAugment>,
): LoadoutTargetResolver {
  return (entry) => {
    if (entry.contentHash) {
      const content = store.getContent(entry.contentHash);
      if (content) {
        return {
          status: "available",
          sourceKind: entry.sourceKind,
          contentHash: entry.contentHash,
          registryVersion: entry.registryVersion,
          requiresAuth: content.requiresAuth ?? false,
          componentSummary: componentSummaryFromContent(content),
        };
      }
    }

    const current = currentByName.get(entry.augmentName);
    if (current && currentSatisfiesTargetEntry(entry, current)) {
      return {
        status: "available",
        sourceKind: entry.sourceKind,
        contentHash: current.contentHash,
        registryVersion: current.contentSource.kind === "registry" ? current.contentSource.version : entry.registryVersion,
        requiresAuth: current.requiresAuth,
        componentSummary: componentSummaryFromResolved(current),
      };
    }

    return missingResolutionFor(entry);
  };
}

function currentSatisfiesTargetEntry(entry: LoadoutEntry, current: ResolvedAugment): boolean {
  if (entry.shareBehavior === "unavailable-placeholder") return false;
  if (entry.contentHash && current.contentHash !== entry.contentHash) return false;
  if (entry.registryVersion !== undefined) {
    if (current.contentSource.kind !== "registry") return false;
    if (current.contentSource.version !== entry.registryVersion) return false;
  }
  if (entry.sourceKind !== "unknown" && current.contentSource.kind !== entry.sourceKind) return false;
  if (entry.shareBehavior === "public-ref" && current.contentSource.kind !== "registry") return false;
  if (entry.shareBehavior === "local-private" && current.contentSource.kind === "registry") return false;
  return true;
}

function missingResolutionFor(entry: LoadoutEntry): LoadoutTargetResolution {
  return {
    status: "missing",
    sourceKind: entry.sourceKind,
    contentHash: entry.contentHash,
    registryVersion: entry.registryVersion,
  };
}

function addResolutionDiagnostics(
  entry: LoadoutEntry,
  resolution: LoadoutTargetResolution,
  diagnostics: LoadoutPlanDiagnostic[],
): void {
  switch (resolution.status) {
    case "available":
      return;
    case "missing":
      if (entry.sourceKind === "registry") diagnostics.push(diagnostic("missing_registry_entry", "blocked"));
      return;
    case "unavailable":
      diagnostics.push(diagnostic("unavailable_registry_entry", "blocked"));
      return;
    case "retracted":
      diagnostics.push(diagnostic("retracted_entry", "blocked"));
      return;
    case "unapproved":
      diagnostics.push(diagnostic("unapproved_entry", "blocked"));
      return;
    default: {
      const _exhaustive: never = resolution.status;
      void _exhaustive;
    }
  }
}

function actionFor(
  entry: LoadoutEntry,
  current: ResolvedAugment | null,
  resolution: LoadoutTargetResolution,
): LoadoutPlanAction {
  if (resolution.status !== "available") return current ? "noop" : "install";
  if (!current) return "install";
  if (entry.contentHash && resolution.contentHash && current.contentHash !== resolution.contentHash) return "update";
  if (entry.registryVersion !== undefined && resolution.registryVersion !== undefined && current.contentSource.kind === "registry" && current.contentSource.version !== resolution.registryVersion) return "update";
  return "noop";
}

function isHashOrVersionMismatch(entry: LoadoutEntry, resolution: LoadoutTargetResolution): boolean {
  if (resolution.status !== "available") return false;
  if (entry.contentHash && resolution.contentHash && entry.contentHash !== resolution.contentHash) return true;
  return entry.registryVersion !== undefined
    && resolution.registryVersion !== undefined
    && entry.registryVersion !== resolution.registryVersion;
}

function defaultEnabledPlatformIds(): string[] {
  const detected = detectPlatforms()
    .map((platform) => platform.platform)
    .filter((id) => isPlatformEnabled(id));
  if (detected.length > 0) return normalizeSorted(detected);
  return normalizeSorted(getEnabledPlatformIds());
}

function defaultCredentialReader(augmentName: string): boolean {
  const credential = readStoredCredential(augmentName);
  return !!credential?.credential && !isCredentialExpired(credential);
}

function collectIgnoredInventory(
  enabledPlatforms: string[],
  readScan: (platformId: string) => PlatformScan | null,
): LoadoutIgnoredInventory[] {
  const ignored: LoadoutIgnoredInventory[] = [];
  for (const platformId of enabledPlatforms) {
    const scan = readScan(platformId);
    if (!scan) continue;
    for (const [name, entry] of Object.entries(scan.augments ?? {})) {
      if (entry.managed) continue;
      ignored.push({
        name,
        platformId,
        kind: "mcp",
        code: "unmanaged_inventory_ignored",
      });
    }
    for (const [name, entry] of Object.entries(scan.skillBundles ?? {})) {
      if (entry.managed) continue;
      ignored.push({
        name,
        platformId,
        kind: "skill-bundle",
        code: "unmanaged_inventory_ignored",
      });
    }
  }
  return ignored.sort((a, b) => `${a.platformId}:${a.kind}:${a.name}`.localeCompare(`${b.platformId}:${b.kind}:${b.name}`));
}

function buildDesiredEntries(entries: LoadoutPlanEntry[]): LoadoutDesiredEntry[] {
  return entries
    .filter((entry) => entry.action !== "uninstall" && entry.target)
    .map((entry) => ({
      augmentName: entry.augmentName,
      sourceKind: entry.sourceKind,
      shareBehavior: entry.shareBehavior,
      required: entry.required,
      platforms: entry.platforms,
      contentHash: entry.target?.contentHash,
      registryVersion: entry.target?.registryVersion,
      requiresAuth: entry.target?.requiresAuth ?? false,
      ...(entry.codes.includes("auth_required")
        ? { credentialAvailable: !entry.codes.includes("credential_needed") }
        : {}),
      canRenderTemporaryInputs: entry.status !== "blocked"
        && entry.platforms.length > 0
        && hasRenderableComponents(entry.componentSummary),
      componentSummary: entry.componentSummary,
    }))
    .sort((a, b) => a.augmentName.localeCompare(b.augmentName));
}

function summarizePlan(
  currentInstalled: ResolvedAugment[],
  targetEntries: LoadoutEntry[],
  entries: LoadoutPlanEntry[],
  ignoredInventory: LoadoutIgnoredInventory[],
  componentSummary: LoadoutComponentSummary,
) {
  const baseWeights = entries.map((entry) => entry.target?.baseWeight).filter((value): value is number => typeof value === "number");
  const loadedWeights = entries.map((entry) => entry.target?.loadedWeight).filter((value): value is number => typeof value === "number");
  return {
    beforeCount: currentInstalled.length,
    afterCount: targetEntries.length,
    installCount: entries.filter((entry) => entry.action === "install").length,
    uninstallCount: entries.filter((entry) => entry.action === "uninstall").length,
    updateCount: entries.filter((entry) => entry.action === "update").length,
    noopCount: entries.filter((entry) => entry.action === "noop").length,
    ignoredCount: ignoredInventory.length,
    blockedCount: entries.filter((entry) => entry.status === "blocked").length,
    warningCount: entries.filter((entry) => entry.status === "warning").length,
    componentSummary,
    ...(baseWeights.length > 0 ? { baseWeight: sumNumbers(baseWeights) } : {}),
    ...(loadedWeights.length > 0 ? { loadedWeight: sumNumbers(loadedWeights) } : {}),
  };
}

function planStatus(entries: LoadoutPlanEntry[]): LoadoutPlanStatus {
  if (entries.some((entry) => entry.status === "blocked")) return "blocked";
  if (entries.every((entry) => entry.action === "noop")) return "noop";
  return "ready";
}

function diagnostic(
  code: LoadoutPlanCode,
  severity: LoadoutPlanDiagnosticSeverity,
  platforms?: string[],
): LoadoutPlanDiagnostic {
  return {
    code,
    severity,
    ...(platforms && platforms.length > 0 ? { platforms: normalizeSorted(platforms) } : {}),
  };
}

function snapshotFromResolved(augment: ResolvedAugment): LoadoutPlanEntrySnapshot {
  return {
    augmentName: augment.name,
    sourceKind: augment.contentSource.kind,
    contentHash: augment.contentHash,
    registryVersion: augment.contentSource.kind === "registry" ? augment.contentSource.version : undefined,
    installed: augment.installed,
    platforms: normalizeSorted(augment.installedPlatforms),
    requiresAuth: augment.requiresAuth,
    componentSummary: componentSummaryFromResolved(augment),
  };
}

function snapshotFromResolution(
  entry: LoadoutEntry,
  resolution: LoadoutTargetResolution,
): LoadoutPlanEntrySnapshot | undefined {
  if (resolution.status !== "available") {
    return {
      augmentName: entry.augmentName,
      sourceKind: resolution.sourceKind ?? entry.sourceKind,
      contentHash: resolution.contentHash ?? entry.contentHash,
      registryVersion: resolution.registryVersion ?? entry.registryVersion,
      componentSummary: resolution.componentSummary ?? EMPTY_COMPONENT_SUMMARY,
      ...(resolution.requiresAuth !== undefined ? { requiresAuth: resolution.requiresAuth } : {}),
      ...(resolution.baseWeight !== undefined ? { baseWeight: resolution.baseWeight } : {}),
      ...(resolution.loadedWeight !== undefined ? { loadedWeight: resolution.loadedWeight } : {}),
    };
  }
  return {
    augmentName: entry.augmentName,
    sourceKind: resolution.sourceKind ?? entry.sourceKind,
    contentHash: resolution.contentHash ?? entry.contentHash,
    registryVersion: resolution.registryVersion ?? entry.registryVersion,
    requiresAuth: resolution.requiresAuth ?? false,
    componentSummary: resolution.componentSummary ?? EMPTY_COMPONENT_SUMMARY,
    ...(resolution.baseWeight !== undefined ? { baseWeight: resolution.baseWeight } : {}),
    ...(resolution.loadedWeight !== undefined ? { loadedWeight: resolution.loadedWeight } : {}),
  };
}

function componentSummaryFromResolved(augment: ResolvedAugment): LoadoutComponentSummary {
  return {
    mcp: !!(augment.transport || augment.serverUrl || augment.stdio),
    rules: !!augment.rules,
    skills: augment.skills.length,
    hooks: augment.hooks.length,
  };
}

function componentSummaryFromContent(content: {
  transport?: string;
  serverUrl?: string;
  stdio?: unknown;
  rules?: unknown;
  skills?: unknown[];
  hooks?: unknown[];
}): LoadoutComponentSummary {
  return {
    mcp: !!(content.transport || content.serverUrl || content.stdio),
    rules: !!content.rules,
    skills: Array.isArray(content.skills) ? content.skills.length : 0,
    hooks: Array.isArray(content.hooks) ? content.hooks.length : 0,
  };
}

function sumComponentSummaries(items: LoadoutComponentSummary[]): LoadoutComponentSummary {
  return items.reduce((acc, item) => ({
    mcp: acc.mcp || item.mcp,
    rules: acc.rules || item.rules,
    skills: acc.skills + item.skills,
    hooks: acc.hooks + item.hooks,
  }), { ...EMPTY_COMPONENT_SUMMARY });
}

function hasRenderableComponents(summary: LoadoutComponentSummary): boolean {
  return summary.mcp || summary.rules || summary.skills > 0 || summary.hooks > 0;
}

function intersectEnabled(platforms: string[], enabledPlatforms: string[]): string[] {
  const enabled = new Set(enabledPlatforms);
  return normalizeSorted(platforms.filter((platform) => enabled.has(platform)));
}

function isInstalledOnEnabledPlatform(augment: ResolvedAugment, enabledPlatforms: string[]): boolean {
  if (!augment.installed) return false;
  if (enabledPlatforms.length === 0) return false;
  return augment.installedPlatforms.some((platform) => enabledPlatforms.includes(platform));
}

function normalizeSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function sumNumbers(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function computePlanHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function hashableTargetEntry(entry: LoadoutEntry) {
  return {
    augmentName: entry.augmentName,
    enabled: entry.enabled,
    required: entry.required,
    sourceKind: entry.sourceKind,
    contentHash: entry.contentHash,
    registryVersion: entry.registryVersion,
    platformTargets: normalizeSorted(entry.platformTargets ?? []),
    installMode: entry.installMode,
    shareBehavior: entry.shareBehavior,
  };
}

function hashablePlanEntry(entry: LoadoutPlanEntry) {
  return {
    augmentName: entry.augmentName,
    action: entry.action,
    status: entry.status,
    platforms: entry.platforms,
    codes: normalizeSorted(entry.codes),
    diagnostics: hashableDiagnostics(entry.diagnostics),
    current: entry.current,
    target: entry.target,
    componentSummary: entry.componentSummary,
  };
}

function hashableDiagnostics(diagnostics: LoadoutPlanDiagnostic[]) {
  return diagnostics
    .map((item) => ({
      code: item.code,
      severity: item.severity,
      platforms: item.platforms ? normalizeSorted(item.platforms) : undefined,
    }))
    .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

function hashableIgnoredInventory(item: LoadoutIgnoredInventory) {
  return {
    name: item.name,
    platformId: item.platformId,
    kind: item.kind,
    code: item.code,
  };
}
