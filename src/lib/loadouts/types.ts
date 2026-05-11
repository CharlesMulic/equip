import type { PlatformInstallMode } from "../storage/intent";

export const LOADOUT_SCHEMA_VERSION = 1 as const;
export const LOADOUT_STATE_SCHEMA_VERSION = 1 as const;
export const LOADOUT_PLAN_SCHEMA_VERSION = 1 as const;

export type LoadoutSchemaVersion = typeof LOADOUT_SCHEMA_VERSION;
export type LoadoutStateSchemaVersion = typeof LOADOUT_STATE_SCHEMA_VERSION;
export type LoadoutPlanSchemaVersion = typeof LOADOUT_PLAN_SCHEMA_VERSION;

export type LoadoutSourceKind = "registry" | "local-authored" | "wrapped" | "unknown";
export type LoadoutShareBehavior = "public-ref" | "local-private" | "unavailable-placeholder";
export type LoadoutMode = "replace";
export type LoadoutInstallModeHint = PlatformInstallMode | "mixed";

export interface LoadoutPlatformPolicy {
  kind: "enabled-platforms";
}

export interface LoadoutResolutionPolicy {
  kind: "latest-approved";
  expectedHashBehavior: "warn";
}

export interface LoadoutEntry {
  augmentName: string;
  enabled: boolean;
  required: boolean;
  sourceKind: LoadoutSourceKind;
  contentHash?: string;
  registryVersion?: number;
  platformTargets?: string[];
  installMode?: LoadoutInstallModeHint;
  shareBehavior: LoadoutShareBehavior;
}

export interface LoadoutManifest {
  schemaVersion: LoadoutSchemaVersion;
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
  lastAppliedAt?: string;
  mode: LoadoutMode;
  platformPolicy: LoadoutPlatformPolicy;
  resolutionPolicy: LoadoutResolutionPolicy;
  entries: LoadoutEntry[];
  legacySource?: {
    kind: "app-set";
    name: string;
  };
}

export interface LoadoutState {
  schemaVersion: LoadoutStateSchemaVersion;
  activeLoadoutId: string | null;
  activeMembershipHash: string | null;
  updatedAt: string;
}

export interface LoadoutSummary {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  lastAppliedAt?: string;
  entryCount: number;
  active: boolean;
  modified: boolean;
}

export interface LoadoutProjection {
  loadouts: LoadoutSummary[];
  activeLoadoutId: string | null;
  activeLoadout: LoadoutManifest | null;
  activeModified: boolean;
  currentMembershipHash: string;
}

export interface SaveCurrentLoadoutCommand {
  name: string;
  id?: string;
  description?: string;
  tags?: string[];
  notes?: string;
  now?: string;
}

export interface CreateLoadoutCommand {
  name: string;
  entries: LoadoutEntry[];
  id?: string;
  description?: string;
  tags?: string[];
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
  lastAppliedAt?: string;
  legacySource?: LoadoutManifest["legacySource"];
}

export interface UpdateLoadoutMetadataCommand {
  description?: string;
  tags?: string[];
  notes?: string;
}

export interface DeleteLoadoutResult {
  deleted: boolean;
  activeCleared: boolean;
}

export interface LegacySet {
  name: string;
  augments: string[];
  createdAt?: string;
  lastUsed?: string;
}

export interface LegacySetsData {
  sets: LegacySet[];
  activeSet: string | null;
}

export type LoadoutPlanStatus = "ready" | "blocked" | "noop";
export type LoadoutPlanEntryStatus = "ready" | "blocked" | "warning";
export type LoadoutPlanAction = "install" | "uninstall" | "noop" | "update";
export type LoadoutPlanDiagnosticSeverity = "info" | "warning" | "blocked";

// `action` is the canonical operation field. `codes` intentionally repeats
// that action code alongside diagnostics so UI/sidecar callers can filter a
// single stable code array without parsing display strings.
export type LoadoutPlanCode =
  | "install"
  | "uninstall"
  | "noop"
  | "update"
  | "hash_version_mismatch"
  | "missing_registry_entry"
  | "unavailable_registry_entry"
  | "retracted_entry"
  | "unapproved_entry"
  | "auth_required"
  | "credential_needed"
  | "local_private_available"
  | "local_private_unavailable"
  | "unavailable_placeholder"
  | "platform_unsupported"
  | "no_enabled_platforms"
  | "unmanaged_inventory_ignored";

export interface LoadoutComponentSummary {
  mcp: boolean;
  rules: boolean;
  skills: number;
  hooks: number;
}

export interface LoadoutPlanDiagnostic {
  code: LoadoutPlanCode;
  severity: LoadoutPlanDiagnosticSeverity;
  platforms?: string[];
}

export interface LoadoutPlanEntrySnapshot {
  augmentName: string;
  sourceKind: LoadoutSourceKind;
  contentHash?: string;
  registryVersion?: number;
  installed?: boolean;
  platforms?: string[];
  requiresAuth?: boolean;
  componentSummary: LoadoutComponentSummary;
  baseWeight?: number;
  loadedWeight?: number;
}

export interface LoadoutPlanEntry {
  augmentName: string;
  action: LoadoutPlanAction;
  status: LoadoutPlanEntryStatus;
  required: boolean;
  sourceKind: LoadoutSourceKind;
  shareBehavior: LoadoutShareBehavior;
  platforms: string[];
  savedPlatformTargets?: string[];
  codes: LoadoutPlanCode[];
  diagnostics: LoadoutPlanDiagnostic[];
  current?: LoadoutPlanEntrySnapshot;
  target?: LoadoutPlanEntrySnapshot;
  componentSummary: LoadoutComponentSummary;
}

export interface LoadoutIgnoredInventory {
  name: string;
  platformId: string;
  kind: "mcp" | "skill-bundle";
  code: "unmanaged_inventory_ignored";
}

export interface LoadoutDesiredEntry {
  augmentName: string;
  sourceKind: LoadoutSourceKind;
  shareBehavior: LoadoutShareBehavior;
  required: boolean;
  platforms: string[];
  contentHash?: string;
  registryVersion?: number;
  requiresAuth: boolean;
  credentialAvailable?: boolean;
  canRenderTemporaryInputs: boolean;
  componentSummary: LoadoutComponentSummary;
}

export interface LoadoutDesiredStateProjection {
  loadoutId: string;
  mode: LoadoutMode;
  platforms: string[];
  entries: LoadoutDesiredEntry[];
  componentSummary: LoadoutComponentSummary;
}

export interface LoadoutPlanSummary {
  beforeCount: number;
  afterCount: number;
  installCount: number;
  uninstallCount: number;
  updateCount: number;
  noopCount: number;
  ignoredCount: number;
  blockedCount: number;
  warningCount: number;
  componentSummary: LoadoutComponentSummary;
  baseWeight?: number;
  loadedWeight?: number;
}

export interface LoadoutPreviewPlan {
  schemaVersion: LoadoutPlanSchemaVersion;
  generatedAt: string;
  planHash: string;
  status: LoadoutPlanStatus;
  canApply: boolean;
  loadout: {
    id: string;
    name: string;
    updatedAt: string;
  };
  enabledPlatforms: string[];
  affectedPlatforms: string[];
  entries: LoadoutPlanEntry[];
  ignoredInventory: LoadoutIgnoredInventory[];
  desiredState: LoadoutDesiredStateProjection;
  summary: LoadoutPlanSummary;
}

export interface LoadoutBulkPreviewError {
  code: string;
  message: string;
}

export interface LoadoutBulkPreviewEntry {
  requestIndex: number;
  requestedRef: string;
  loadoutId?: string;
  loadoutUpdatedAt?: string;
  plan?: LoadoutPreviewPlan;
  error?: LoadoutBulkPreviewError;
}

export interface LoadoutBulkPreviewResult {
  schemaVersion: LoadoutPlanSchemaVersion;
  generatedAt: string;
  context: {
    enabledPlatforms: string[];
    currentMembershipHash: string;
  };
  previews: LoadoutBulkPreviewEntry[];
}

export type LoadoutTargetResolutionStatus =
  | "available"
  | "missing"
  | "unavailable"
  | "retracted"
  | "unapproved";

export interface LoadoutTargetResolution {
  status: LoadoutTargetResolutionStatus;
  sourceKind?: LoadoutSourceKind;
  contentHash?: string;
  registryVersion?: number;
  requiresAuth?: boolean;
  supportedPlatforms?: string[];
  componentSummary?: LoadoutComponentSummary;
  baseWeight?: number;
  loadedWeight?: number;
}

export type LoadoutTargetResolver = (entry: LoadoutEntry) => LoadoutTargetResolution | null;
export type LoadoutCredentialReader = (augmentName: string) => boolean;

export type LoadoutApplyStatus =
  | "success"
  | "partial"
  | "blocked"
  | "failed"
  | "in_progress"
  | "replayed"
  | "recovery_required";

export type LoadoutApplyStepAction = "install" | "uninstall" | "noop" | "update";
export type LoadoutApplyStepStatus = "success" | "skipped" | "failed";

export interface ApplyLoadoutCommand {
  operationId: string;
  loadout: string;
  expectedPlanHash?: string;
  mode?: LoadoutMode;
}

export interface LoadoutApplyDiagnostic {
  code: string;
  message: string;
  augmentName?: string;
  platforms?: string[];
}

export interface LoadoutApplyStep {
  augmentName: string;
  action: LoadoutApplyStepAction;
  status: LoadoutApplyStepStatus;
  platforms: string[];
  startedAt: string;
  completedAt?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface LoadoutApplyReceipt {
  schemaVersion: 1;
  operationId: string;
  status: LoadoutApplyStatus;
  replayed: boolean;
  loadout: {
    id: string;
    name: string;
  };
  requestedAt: string;
  completedAt?: string;
  planHash: string;
  expectedPlanHash?: string;
  affectedPlatforms: string[];
  steps: LoadoutApplyStep[];
  diagnostics: LoadoutApplyDiagnostic[];
  summary: {
    installCount: number;
    uninstallCount: number;
    updateCount: number;
    noopCount: number;
    skippedCount: number;
    failedCount: number;
  };
}

export type LoadoutCredentialValueReader = (augmentName: string) => string | null;
