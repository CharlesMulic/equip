import * as os from "os";
import * as path from "path";
import { Augment, type AugmentConfig } from "../../index";
import { readStoredCredential, isCredentialExpired } from "../auth-engine";
import { registryDefToConfig, type RegistryDef } from "../registry";
import { createManualPlatform, type DetectedPlatform } from "../platforms";
import { acquireLock, atomicWriteFileSync, safeReadJsonSync } from "../fs";
import { ensureInitialSnapshots } from "../snapshots";
import { JsonStore, type EquipDataStore } from "../storage/datastore";
import type { AugmentContent } from "../storage/content-store";
import type { ContentSource, PlatformInstallMode } from "../storage/intent";
import { scanAllPlatforms } from "../platform-state";
import { markEquipUpdated } from "../equip-meta";
import { getEquipHome } from "../equip-home";
import { uninstallMcp } from "../mcp";
import { uninstallRules } from "../rules";
import { uninstallHooks } from "../hooks";
import { uninstallSkill } from "../skills";
import {
  getLoadout,
  markLoadoutApplied,
  setActiveLoadout,
  LoadoutStoreError,
} from "./store";
import { previewLoadout, type PreviewLoadoutOptions } from "./planner";
import type {
  ApplyLoadoutCommand,
  LoadoutApplyDiagnostic,
  LoadoutApplyReceipt,
  LoadoutApplyStatus,
  LoadoutApplyStep,
  LoadoutApplyStepAction,
  LoadoutCredentialValueReader,
  LoadoutEntry,
  LoadoutManifest,
  LoadoutPlanEntry,
  LoadoutPreviewPlan,
} from "./types";

export interface LoadoutApplyWriterContext {
  store: EquipDataStore;
  now: () => string;
  credentialValueReader: LoadoutCredentialValueReader;
  manifestEntry?: LoadoutEntry;
}

export interface LoadoutApplyWriter {
  install(entry: LoadoutPlanEntry, context: LoadoutApplyWriterContext): Record<string, unknown> | void;
  uninstall(entry: LoadoutPlanEntry, context: LoadoutApplyWriterContext): Record<string, unknown> | void;
}

export interface ApplyLoadoutOptions extends PreviewLoadoutOptions {
  credentialValueReader?: LoadoutCredentialValueReader;
  writer?: LoadoutApplyWriter;
  now?: string;
}

interface ApplyLoadoutRuntimeOptions extends ApplyLoadoutOptions {
  onBeforeMarkActiveForTests?: () => void;
  onBeforeTerminalReceiptForTests?: () => void;
}

const APPLY_RECEIPT_SCHEMA_VERSION = 1 as const;
const COMPLETE_STATUSES = new Set<LoadoutApplyStatus>(["success", "blocked"]);

function applyReceiptsDir(): string {
  return path.join(getEquipHome(), "loadouts", "apply-receipts");
}

function assertValidOperationId(operationId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(operationId)) {
    throw new LoadoutStoreError("invalid_loadout_operation_id", `Invalid loadout operationId: ${operationId}`);
  }
}

function receiptPath(operationId: string): string {
  assertValidOperationId(operationId);
  return path.join(applyReceiptsDir(), `${operationId}.json`);
}

function readReceipt(operationId: string): LoadoutApplyReceipt | null {
  const result = safeReadJsonSync(receiptPath(operationId));
  if (result.status === "missing") return null;
  if (result.status !== "ok" || !result.data) {
    throw new LoadoutStoreError(`loadout_apply_receipt_${result.status}`, `Cannot read loadout apply receipt: ${result.error ?? result.status}`);
  }
  return normalizeReceipt(result.data);
}

function writeReceipt(receipt: LoadoutApplyReceipt): void {
  atomicWriteFileSync(receiptPath(receipt.operationId), JSON.stringify(receipt, null, 2) + "\n");
}

function normalizeReceipt(raw: Record<string, unknown>): LoadoutApplyReceipt {
  if (raw.schemaVersion !== APPLY_RECEIPT_SCHEMA_VERSION) {
    throw new LoadoutStoreError("unsupported_loadout_apply_receipt_schema", `Unsupported loadout apply receipt schemaVersion: ${String(raw.schemaVersion)}`);
  }
  return raw as unknown as LoadoutApplyReceipt;
}

export function getLoadoutApplyReceipt(operationId: string): LoadoutApplyReceipt | null {
  return readReceipt(operationId);
}

export function applyLoadout(
  command: ApplyLoadoutCommand,
  options: ApplyLoadoutOptions = {},
): LoadoutApplyReceipt {
  const runtimeOptions = options as ApplyLoadoutRuntimeOptions;
  assertValidOperationId(command.operationId);
  if (command.mode !== undefined && command.mode !== "replace") {
    throw new LoadoutStoreError("unsupported_loadout_apply_mode", `Unsupported loadout apply mode: ${String(command.mode)}`);
  }

  const store = options.store ?? JsonStore;
  const requestedAt = options.now ?? new Date().toISOString();
  const now = () => new Date().toISOString();

  let release: (() => void) | null = null;
  try {
    release = acquireLock();
  } catch (error) {
    const existing = readReceipt(command.operationId);
    if (existing) return replayReceipt(existing);
    return createLockUnavailableReceipt(command, options, requestedAt, (error as Error).message);
  }

  try {
    const existing = readReceipt(command.operationId);
    if (existing) return replayReceipt(existing);

    const loadout = getLoadout(command.loadout, { migrateLegacy: false });
    if (!loadout) {
      throw new LoadoutStoreError("loadout_not_found", `Loadout not found: ${command.loadout}`);
    }

    const plan = previewLoadout(loadout, options);
    const preflight = preflightDiagnostics(loadout, plan, command.expectedPlanHash);
    if (preflight.length > 0 || !plan.canApply) {
      const diagnostics = [
        ...preflight,
        ...plan.entries
          .filter((entry) => entry.status === "blocked")
          .map((entry): LoadoutApplyDiagnostic => ({
            code: "plan_blocked",
            message: `Preview blocks ${entry.augmentName}: ${entry.codes.join(", ")}`,
            augmentName: entry.augmentName,
            platforms: entry.platforms,
          })),
      ];
      const receipt = createReceipt(command, loadout, plan, requestedAt, "blocked", [], diagnostics);
      writeReceipt(receipt);
      return receipt;
    }

    const steps: LoadoutApplyStep[] = [];
    const diagnostics: LoadoutApplyDiagnostic[] = [];
    let receipt = createReceipt(command, loadout, plan, requestedAt, "in_progress", steps, diagnostics);
    writeReceipt(receipt);

    const writer = options.writer ?? defaultApplyWriter;
    const manifestByName = new Map(loadout.entries.map((entry) => [entry.augmentName, entry]));
    const credentialValueReader = options.credentialValueReader ?? defaultCredentialValueReader;

    ensureInitialSnapshots(plan.affectedPlatforms.map((platformId) => createManualPlatform(platformId)));

    for (const entry of orderedApplyEntries(plan)) {
      const startedAt = now();
      const step: LoadoutApplyStep = {
        augmentName: entry.augmentName,
        action: entry.action,
        status: "skipped",
        platforms: entry.platforms,
        startedAt,
      };

      try {
        const context: LoadoutApplyWriterContext = {
          store,
          now,
          credentialValueReader,
          manifestEntry: manifestByName.get(entry.augmentName),
        };
        if (entry.action === "noop") {
          step.status = "skipped";
        } else if (entry.action === "uninstall") {
          const details = writer.uninstall(entry, context);
          step.status = "success";
          if (details) step.details = details;
        } else {
          const details = writer.install(entry, context);
          step.status = "success";
          if (details) step.details = details;
        }
        step.completedAt = now();
      } catch (error) {
        step.status = "failed";
        step.error = (error as Error).message;
        step.completedAt = now();
        diagnostics.push({
          code: "step_failed",
          message: step.error,
          augmentName: step.augmentName,
          platforms: step.platforms,
        });
        steps.push(step);
        receipt = createReceipt(command, loadout, plan, requestedAt, statusFromSteps(steps), steps, diagnostics);
        writeReceipt(receipt);
        return receipt;
      }

      steps.push(step);
      receipt = createReceipt(command, loadout, plan, requestedAt, "in_progress", steps, diagnostics);
      writeReceipt(receipt);
    }

    runtimeOptions.onBeforeMarkActiveForTests?.();
    markLoadoutApplied(loadout.id, { now: requestedAt });
    setActiveLoadout(loadout.id, { now: requestedAt });
    refreshPlatformProjection(plan.affectedPlatforms, store);
    runtimeOptions.onBeforeTerminalReceiptForTests?.();
    receipt = createReceipt(command, loadout, plan, requestedAt, "success", steps, diagnostics);
    writeReceipt(receipt);
    return receipt;
  } finally {
    release?.();
  }
}

function createLockUnavailableReceipt(
  command: ApplyLoadoutCommand,
  options: ApplyLoadoutOptions,
  requestedAt: string,
  message: string,
): LoadoutApplyReceipt {
  const loadout = getLoadout(command.loadout, { migrateLegacy: false });
  if (!loadout) {
    throw new LoadoutStoreError("loadout_not_found", `Loadout not found: ${command.loadout}`);
  }
  const plan = previewLoadout(loadout, options);
  return createReceipt(command, loadout, plan, requestedAt, "blocked", [], [{
    code: "lock_unavailable",
    message,
  }]);
}

function replayReceipt(receipt: LoadoutApplyReceipt): LoadoutApplyReceipt {
  if (COMPLETE_STATUSES.has(receipt.status)) {
    return {
      ...receipt,
      status: "replayed",
      replayed: true,
      diagnostics: [
        ...receipt.diagnostics,
        { code: "operation_replayed", message: `Operation ${receipt.operationId} already completed with status ${receipt.status}` },
      ],
    };
  }
  return {
    ...receipt,
    status: "recovery_required",
    replayed: true,
    diagnostics: [
      ...receipt.diagnostics,
      { code: "recovery_required", message: `Operation ${receipt.operationId} has incomplete status ${receipt.status}; inspect receipt before retrying` },
    ],
  };
}

function preflightDiagnostics(
  loadout: LoadoutManifest,
  plan: LoadoutPreviewPlan,
  expectedPlanHash: string | undefined,
): LoadoutApplyDiagnostic[] {
  const diagnostics: LoadoutApplyDiagnostic[] = [];
  if (expectedPlanHash && expectedPlanHash !== plan.planHash) {
    diagnostics.push({
      code: "plan_hash_mismatch",
      message: `Expected planHash ${expectedPlanHash} but current planHash is ${plan.planHash}`,
    });
  }
  for (const entry of loadout.entries) {
    if (!entry.enabled) continue;
    const planned = plan.entries.find((candidate) => candidate.augmentName === entry.augmentName);
    if (!planned || planned.action === "noop" || planned.action === "uninstall") continue;
    if (entry.installMode === "broker" || entry.installMode === "mixed") {
      diagnostics.push({
        code: "broker_install_mode_unsupported",
        message: `Loadout entry ${entry.augmentName} requests ${entry.installMode} install mode; loadout apply currently supports direct-mode writes only`,
        augmentName: entry.augmentName,
        platforms: planned.platforms,
      });
    }
  }
  return diagnostics;
}

function orderedApplyEntries(plan: LoadoutPreviewPlan): LoadoutPlanEntry[] {
  const rank: Record<LoadoutApplyStepAction, number> = {
    uninstall: 0,
    install: 1,
    update: 1,
    noop: 2,
  };
  return [...plan.entries]
    .filter((entry) => entry.action !== "noop" || entry.current || entry.target)
    .sort((a, b) => rank[a.action] - rank[b.action] || a.augmentName.localeCompare(b.augmentName));
}

function statusFromSteps(steps: LoadoutApplyStep[]): LoadoutApplyStatus {
  const succeeded = steps.some((step) => step.status === "success");
  return succeeded ? "partial" : "failed";
}

function createReceipt(
  command: ApplyLoadoutCommand,
  loadout: LoadoutManifest,
  plan: LoadoutPreviewPlan,
  requestedAt: string,
  status: LoadoutApplyStatus,
  steps: LoadoutApplyStep[],
  diagnostics: LoadoutApplyDiagnostic[],
): LoadoutApplyReceipt {
  const completedAt = new Date().toISOString();
  return {
    schemaVersion: APPLY_RECEIPT_SCHEMA_VERSION,
    operationId: command.operationId,
    status,
    replayed: false,
    loadout: {
      id: loadout.id,
      name: loadout.name,
    },
    requestedAt,
    ...(status === "in_progress" ? {} : { completedAt }),
    planHash: plan.planHash,
    expectedPlanHash: command.expectedPlanHash,
    affectedPlatforms: plan.affectedPlatforms,
    steps,
    diagnostics,
    summary: {
      installCount: steps.filter((step) => step.action === "install" && step.status === "success").length,
      uninstallCount: steps.filter((step) => step.action === "uninstall" && step.status === "success").length,
      updateCount: steps.filter((step) => step.action === "update" && step.status === "success").length,
      noopCount: steps.filter((step) => step.action === "noop").length,
      skippedCount: steps.filter((step) => step.status === "skipped").length,
      failedCount: steps.filter((step) => step.status === "failed").length,
    },
  };
}

function defaultCredentialValueReader(augmentName: string): string | null {
  const credential = readStoredCredential(augmentName);
  if (!credential?.credential || isCredentialExpired(credential)) return null;
  return credential.credential;
}

const defaultApplyWriter: LoadoutApplyWriter = {
  install(entry, context) {
    return installEntry(entry, context);
  },
  uninstall(entry, context) {
    return uninstallEntry(entry, context);
  },
};

function installEntry(entry: LoadoutPlanEntry, context: LoadoutApplyWriterContext): Record<string, unknown> {
  if (!entry.target?.contentHash) throw new Error(`Cannot apply ${entry.augmentName}: target content hash is missing`);
  const content = context.store.getContent(entry.target.contentHash);
  if (!content) throw new Error(`Cannot apply ${entry.augmentName}: target content is unavailable`);
  const manifestEntry = context.manifestEntry;
  if (!manifestEntry) throw new Error(`Cannot apply ${entry.augmentName}: manifest entry is unavailable`);

  const platforms = entry.platforms.map((platformId) => createManualPlatform(platformId));
  const apiKey = content.requiresAuth ? context.credentialValueReader(entry.augmentName) : null;
  if (content.requiresAuth && !apiKey) throw new Error(`Cannot apply ${entry.augmentName}: credential is unavailable`);
  const augment = new Augment(contentToAugmentConfig(content, manifestEntry, apiKey));

  const failures: string[] = [];
  const transport = content.transport ?? (content.stdio ? "stdio" : "http");
  const hasMcp = !!(augment.serverUrl || augment.stdio || augment.mcpInstallTarget);
  if (hasMcp) {
    for (const platform of platforms) {
      try {
        augment.buildConfig(platform.platform, apiKey, transport);
      } catch (error: unknown) {
        failures.push(`${platform.platform}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
  }
  for (const platform of platforms) {
    if (hasMcp) {
      const result = augment.installMcp(platform, apiKey, { transport });
      if (!result.success) failures.push(`${platform.platform}: ${result.error || result.errorCode || "MCP install failed"}`);
    }
    if (content.rules) {
      const result = augment.installRules(platform);
      if (!result.success) failures.push(`${platform.platform}: ${result.error || result.errorCode || "rules install failed"}`);
    }
    if (content.hooks && content.hooks.length > 0) {
      const result = augment.installHooks(platform);
      if (!result.success) failures.push(`${platform.platform}: ${result.error || result.errorCode || "hooks install failed"}`);
    }
    if (content.skills && content.skills.length > 0) {
      const result = augment.installSkill(platform);
      if (!result.success) failures.push(`${platform.platform}: ${result.error || result.errorCode || "skills install failed"}`);
    }
    const verified = augment.verify(platform);
    const failedChecks = verified.checks.filter((check) => {
      if (check.ok) return false;
      if (check.name === "mcp" && !hasMcp) return false;
      return true;
    });
    if (failedChecks.length > 0) {
      failures.push(`${platform.platform}: ${failedChecks.map((check) => check.detail).join(", ")}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));

  const installModes = installModesFor(manifestEntry, entry.platforms);
  context.store.appendIntent({
    type: "install-augment",
    clock: context.store.newClock(),
    name: entry.augmentName,
    contentHash: entry.target.contentHash,
    contentSource: contentSourceFor(manifestEntry, entry, context.now()),
    platforms: entry.platforms,
    ...(Object.keys(installModes).length > 0 ? { installModes } : {}),
  });

  return { platforms: entry.platforms, contentHash: entry.target.contentHash };
}

function uninstallEntry(entry: LoadoutPlanEntry, context: LoadoutApplyWriterContext): Record<string, unknown> {
  const resolved = context.store.resolve(entry.augmentName);
  if (!resolved || !resolved.installed) return { removedPlatforms: [] };

  const platforms = entry.platforms.length > 0
    ? entry.platforms
    : resolved.installedPlatforms;
  const failures: string[] = [];
  const hookDir = path.join(os.homedir(), `.${entry.augmentName}`, "hooks");

  for (const platformId of platforms) {
    const platform = createManualPlatform(platformId);
    if (resolved.serverUrl || resolved.stdio || resolved.installTargets) uninstallMcp(platform, entry.augmentName);
    if (resolved.rules) uninstallRules(platform, { marker: resolved.rules.marker, dryRun: false });
    if (resolved.hooks.length > 0) {
      const removed = uninstallHooks(platform, resolved.hooks, { hookDir, dryRun: false });
      if (!removed) {
        // Hook uninstalls may legitimately be no-ops when a platform has no hooks support.
      }
    }
    for (const skill of resolved.skills) {
      const result = uninstallSkill(platform, entry.augmentName, skill.name, false);
      if (result.preservedFiles.length > 0) {
        failures.push(`${platformId}: preserved modified skill files for ${skill.name}: ${result.preservedFiles.join(", ")}`);
      }
    }
  }

  if (failures.length > 0) throw new Error(failures.join("; "));
  context.store.appendIntent({
    type: "uninstall-augment",
    clock: context.store.newClock(),
    name: entry.augmentName,
    platforms,
  });
  return { removedPlatforms: platforms };
}

function contentToAugmentConfig(content: AugmentContent, entry: LoadoutEntry, apiKey: string | null): AugmentConfig {
  const source = entry.sourceKind === "registry" ? "registry"
    : entry.sourceKind === "wrapped" ? "wrapped"
      : "local";
  if (content.installTargets !== undefined) {
    const config = registryDefToConfig(contentToRegistryDef(content, entry), { apiKey });
    config.source = source;
    config.augmentVersion = entry.registryVersion;
    return config;
  }

  const config: AugmentConfig = {
    name: content.name,
    source,
    augmentVersion: entry.registryVersion,
  };
  if (content.serverUrl) config.serverUrl = content.serverUrl;
  if (content.stdio) config.stdio = {
    command: content.stdio.command,
    args: content.stdio.args,
    envKey: content.stdio.envKey ?? "",
  };
  if (content.rules) config.rules = content.rules;
  if (content.skills) config.skills = content.skills;
  if (content.hooks) config.hooks = content.hooks;
  return config;
}

function contentToRegistryDef(content: AugmentContent, entry: LoadoutEntry): RegistryDef {
  return {
    name: content.name,
    title: content.title || content.name,
    description: content.description || "",
    installMode: content.installTargets !== undefined ? "package" : "direct",
    version: entry.registryVersion,
    transport: content.transport,
    serverUrl: content.serverUrl,
    requiresAuth: content.requiresAuth,
    auth: content.auth as RegistryDef["auth"],
    envKey: content.stdio?.envKey,
    stdioCommand: content.stdio?.command,
    stdioArgs: content.stdio?.args,
    npmPackage: content.npmPackage,
    setupCommand: content.setupCommand,
    installTargets: content.installTargets,
    rules: content.rules,
    skills: content.skills,
    hooks: content.hooks,
    categories: content.categories,
    homepage: content.homepage,
    repository: content.repository,
    license: content.license,
    subtitle: content.subtitle,
    flavorText: content.flavorText,
  };
}

function contentSourceFor(entry: LoadoutEntry, planEntry: LoadoutPlanEntry, now: string): ContentSource {
  if (entry.sourceKind === "registry") {
    return {
      kind: "registry",
      version: planEntry.target?.registryVersion ?? entry.registryVersion ?? 1,
      fetchedAt: now,
    };
  }
  if (entry.sourceKind === "wrapped") {
    return {
      kind: "wrapped",
      fromPlatform: planEntry.platforms[0] ?? entry.platformTargets?.[0] ?? "unknown",
      createdAt: now,
    };
  }
  return { kind: "local-authored", createdAt: now };
}

function installModesFor(entry: LoadoutEntry, platforms: string[]): Record<string, PlatformInstallMode> {
  if (entry.installMode !== "broker") return {};
  return Object.fromEntries(platforms.map((platform) => [platform, "broker" as const]));
}

function refreshPlatformProjection(platformIds: string[], store: EquipDataStore): void {
  try {
    const platforms = platformIds.map((platformId) => createManualPlatform(platformId));
    const managedNames = new Set(store.listResolved().filter((augment) => augment.installed).map((augment) => augment.name));
    scanAllPlatforms(platforms, managedNames);
    markEquipUpdated();
  } catch {
    // Apply success should not be downgraded because the derived scan cache failed.
  }
}
