import type { PlatformInstallMode } from "../storage/intent";

export const LOADOUT_SCHEMA_VERSION = 1 as const;
export const LOADOUT_STATE_SCHEMA_VERSION = 1 as const;

export type LoadoutSchemaVersion = typeof LOADOUT_SCHEMA_VERSION;
export type LoadoutStateSchemaVersion = typeof LOADOUT_STATE_SCHEMA_VERSION;

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
