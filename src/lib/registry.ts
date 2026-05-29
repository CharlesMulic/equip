// Registry — fetch augment definitions from the equip registry API.
// Handles API fetch with local cache fallback.
// Zero dependencies (uses native fetch).

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import type { AugmentConfig } from "../index";
import type { HookDefinition } from "./hooks";
import type { SkillConfig, SkillFile } from "./skills";
import { validateToolName, validateHookDir, validateUrlScheme } from "./validation";
import type { EquipLogger } from "./types";
import { NOOP_LOGGER } from "./types";
import type { AuthConfig } from "./auth-engine";
import { registryDefToMcpInstallTargets, registryDefToPreferredMcpInstallTarget, type McpDefinitionInput } from "./mcp-readiness";

// ─── API Configuration ─────────────────────────────────────

export const REGISTRY_API = process.env.EQUIP_REGISTRY_URL || "https://api.cg3.io/equip";
const FETCH_TIMEOUT_MS = 8000;
const REGISTRY_CACHE_SCHEMA_VERSION = 1;

// ─── Paths ─────────────────────────────────────────────────

import { getEquipHome } from "./equip-home";
function cacheDir(): string { return path.join(getEquipHome(), "cache"); }

function registryCacheKey(): string {
  const normalized = (REGISTRY_API || "registry").trim().replace(/\/+$/, "") || "registry";
  let label = normalized;

  try {
    const url = new URL(normalized);
    label = `${url.protocol.replace(":", "")}-${url.host}${url.pathname}`;
  } catch {
    // Non-URL registry strings are allowed for local/test overrides; sanitize below.
  }

  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "registry";
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `${safeLabel}-${digest}`;
}

function cachePathFor(name: string): string {
  return path.join(cacheDir(), "registries", registryCacheKey(), `${name}.json`);
}

interface RegistryCacheEnvelope {
  schemaVersion: number;
  registryKey: string;
  registryUrl: string;
  fetchedAt: string;
  contentHash?: string;
  hashAlgorithm?: string;
  version?: number;
  def: RegistryDef;
}

// ─── Post-Install Actions ──────────────────────────────────

export interface PostInstallAction {
  /** Action type. Currently only "open_with_code" is supported. */
  type: "open_with_code";
  /** When to execute: "always", "interactive" (default), or "non_interactive" */
  condition?: "always" | "interactive" | "non_interactive";
  /** URL to call (POST) to get a value */
  url: string;
  /** Send Authorization: Bearer <credential> with the request */
  auth?: boolean;
  /** Dot-notation path to extract from JSON response (e.g., "data.code") */
  codePath: string;
  /** Query parameter name to append to targetUrl (e.g., "cli_code") */
  codeParam: string;
  /** URL to open in browser with the extracted code appended */
  targetUrl: string;
}

// ─── RegistryDef ──────────────────────────────────────────
// Matches the shape returned by GET /equip/augments/:name from the registry API.

export interface RegistryDef {
  name: string;
  /** @deprecated Use title. Kept for backward compatibility with older registry responses. */
  displayName?: string;
  title: string;
  description: string;
  primaryCategory?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  categories?: string[];
  tags?: string[];

  installMode: "direct" | "package";
  installCount?: number;
  listed?: boolean;
  status?: string;
  registryStatus?: string;
  reviewStatus?: string | null;
  trustTier?: string | null;
  trustLabel?: string | null;
  trustSignals?: Array<{ id: string; label: string; status: string; detail?: string }>;
  trustState?: RegistryTrustState | null;
  mcpReviewPaths?: unknown[];
  recommendedMcpPath?: RegistryMcpPathSummary | null;
  recommendedInstallTargetKey?: string | null;
  lastReviewedAt?: string | null;

  // Direct-mode fields
  transport?: string;
  serverUrl?: string;
  envKey?: string;
  requiresAuth?: boolean;
  stdioCommand?: string;
  stdioArgs?: string[];

  // Package-mode fields
  npmPackage?: string;
  setupCommand?: string;
  installTargets?: unknown;

  // Behavioral artifacts
  rules?: {
    content: string;
    version: string;
    marker: string;
    fileName?: string;
  };
  hooks?: HookDefinition[];
  hookDir?: string;
  skills?: SkillConfig[];

  // Platform compatibility
  platforms?: Record<string, unknown>;

  // Auth configuration — declares what auth flow the augment needs
  auth?: AuthConfig;

  // Post-install actions — ordered pipeline of typed actions
  postInstall?: PostInstallAction[];

  // Per-platform messages shown after install
  platformHints?: Record<string, string>;

  // Display metadata (from registry, authoritative)
  rarity?: "common" | "uncommon" | "rare" | "epic" | "legendary";
  subtitle?: string;
  flavorText?: string;
  iconUrl?: string;
  baseWeight?: number;
  loadedWeight?: number;
  verifiedInstallCount?: number;
  activeInstallCount?: number;
  syncSource?: string;
  syncSourceName?: string;

  // Publisher
  publisher?: { name: string; slug: string; verified: boolean; avatarUrl?: string };

  // Versioning and content integrity
  version?: number;
  contentHash?: string;
  hashAlgorithm?: string;
}

export interface RegistryTrustState {
  catalogPresence?: string;
  discoveryExposure?: string;
  claimState?: string;
  reviewState?: string;
  equipGate?: string;
  transportPath?: string;
  credentialEligibility?: string;
  reasonCodes?: string[];
  warningReasons?: RegistryInstallGateReason[];
  blockerReasons?: RegistryInstallGateReason[];
  warningTextVersion?: number;
  policyFingerprint?: string | null;
  normallyEquipable?: boolean;
}

export interface RegistryInstallGateReason {
  code: string;
  category?: string;
  severity?: string;
  scope?: string;
  message?: string;
  details?: string | null;
  copyKey?: string;
  copyVersion?: number;
  oneTimeAcceptable?: boolean;
  preferenceSuppressible?: boolean;
  suggestedPreferenceScopes?: string[];
  selectedPathKey?: string | null;
  contentHash?: string | null;
  policyFingerprint?: string | null;
}

export interface RegistryWarningPreference {
  reasonCode: string;
  scope: "reason-global" | "source" | "publisher" | "augment" | "path";
  scopeValue?: string | null;
  expiresAt?: string | null;
}

export interface RegistryMcpPathSummary {
  pathKey?: string;
  supportLevel?: string | null;
  supportSummary?: string | null;
  supportDetail?: string | null;
  unsupportedReasonDetail?: string | null;
  evidenceTier?: string | null;
  label?: string | null;
  summary?: string | null;
  recommendedAction?: string | null;
  normallyEquipable?: boolean;
}

export type RegistryInstallReviewGateCode =
  | "allowed"
  | "no-mcp"
  | "not-listed"
  | "rejected"
  | "needs-attention"
  | "pending-review"
  | "blocked"
  | "warning-gated"
  | "unreviewed";

export interface RegistryInstallReviewGate {
  allowed: boolean;
  bypassable: boolean;
  code: RegistryInstallReviewGateCode;
  title: string;
  detail: string;
  warningReasons?: RegistryInstallGateReason[];
  blockerReasons?: RegistryInstallGateReason[];
  unsuppressedWarningReasons?: RegistryInstallGateReason[];
  suppressedWarningReasons?: RegistryInstallGateReason[];
  acceptedByPreference?: boolean;
}

export interface RegistryInstallGateAcceptanceReceiptContext {
  surface: string;
  actorLocalProfile?: string | null;
  acceptedReasonCodes?: string[];
  installResult?: "started" | "succeeded" | "failed" | "dry-run";
}

export interface RegistryStoredContentSnapshot {
  name: string;
  title?: string;
  description?: string;
  transport?: "http" | "streamable-http" | "sse" | "stdio";
  serverUrl?: string;
  stdio?: { command: string; args: string[]; envKey?: string };
  npmPackage?: string;
  setupCommand?: string;
  installTargets?: unknown;
  requiresAuth?: boolean;
  auth?: Record<string, unknown>;
  registryStatus?: string;
  status?: string;
  listed?: boolean;
  reviewStatus?: string;
  trustTier?: string;
  trustState?: RegistryTrustState;
  recommendedMcpPath?: RegistryMcpPathSummary;
  syncSource?: string;
  syncSourceName?: string;
  publisher?: { name?: string; slug?: string; verified?: boolean; avatarUrl?: string };
}

const REVIEWED_TRUST_TIERS = new Set(["first-party", "verified", "reviewed"]);
const KNOWN_WARNING_GATE_REASON_CODES = new Set([
  "publisher-unverified",
  "publisher-unclaimed",
  "review-missing",
  "review-stale",
  "review-limited-auth",
  "review-inconclusive",
  "review-warning",
  "review-unsupported",
  "stdio-local-code",
  "secrets-or-env-required",
  "platform-readiness-not-tested",
]);

/**
 * Registry MCP install safety gate.
 *
 * The registry can intentionally list MCP augments before full review so they
 * remain discoverable by exact name. Low-friction install is a narrower bar:
 * reviewed/trusted entries install normally; explicit unreviewed/limited-data
 * entries need an override; rejected, pending, needs-attention, or hidden rows
 * fail closed.
 */
export function resolveRegistryInstallReviewGate(
  def: RegistryDef,
  options: { preferences?: RegistryWarningPreference[]; now?: Date } = {},
): RegistryInstallReviewGate {
  const hasMcp = registryDefHasMcp(def);
  const status = normalizeReviewGateValue(def.registryStatus ?? def.status);
  const legacyReviewStatus = normalizeReviewGateValue(def.reviewStatus);
  const trustReviewState = normalizeReviewGateValue(def.trustState?.reviewState);
  const equipGate = normalizeReviewGateValue(def.trustState?.equipGate);
  const trustTier = normalizeReviewGateValue(def.trustTier);
  const reviewStatus = trustReviewState || legacyReviewStatus;
  const blockerReasons = def.trustState?.blockerReasons || [];

  if (!hasMcp && !equipGate && blockerReasons.length === 0) {
    return allowGate("no-mcp", "No MCP install gate needed", "This augment has no MCP server entry.");
  }

  if (blockerReasons.length > 0) {
    return blockGate(
      "blocked",
      "This MCP augment has non-bypassable install blockers.",
      blockerReasons.map(reasonDisplayText).join(" "),
      def,
    );
  }
  if (equipGate === "emergency-disabled") {
    return blockGate("blocked", "This MCP augment has been disabled.", "Equip has disabled registry installation for this MCP augment.", def);
  }
  if (equipGate === "local-manual-only") {
    return blockGate("blocked", "This MCP augment requires manual local setup.", "Equip cannot automatically install this registry MCP path.", def);
  }
  if (equipGate === "blocked") {
    return blockGate(
      "blocked",
      "This MCP augment is blocked by policy.",
      pathReviewDetail(def.recommendedMcpPath) || "The registry did not mark this MCP augment as eligible for warning-gated installation.",
      def,
    );
  }
  if (equipGate === "warning-gated") {
    return warningGate(def, options);
  }
  if (equipGate === "normal") {
    return allowGate("allowed", "Review gate passed", "This registry MCP augment is eligible for normal Equip install.");
  }
  if (equipGate) {
    return blockGate(
      "blocked",
      "This MCP augment has an unknown install gate.",
      `The registry returned an install gate this client does not understand: ${equipGate}.`,
      def,
    );
  }

  if (!hasMcp) {
    return allowGate("no-mcp", "No MCP install gate needed", "This augment has no MCP server entry.");
  }

  if (def.listed === false || status === "retracted" || status === "hidden") {
    return blockGate("not-listed", "This augment is not listed for installation.", "The registry has hidden or retracted this augment.", def);
  }
  if (status === "rejected" || reviewStatus === "rejected" || reviewStatus === "failed" || reviewStatus === "blocked") {
    return blockGate("rejected", "This MCP augment did not pass review.", "Rejected or failed MCP augments cannot be installed from the registry.", def);
  }
  if (status === "needs-attention" || reviewStatus === "needs-attention") {
    return blockGate("needs-attention", "This augment needs publisher or operator attention.", "It has not cleared review for normal installation.", def);
  }
  if (status === "pending-review" || reviewStatus === "pending-review" || reviewStatus === "pending" || reviewStatus === "review-pending") {
    return blockGate("pending-review", "This augment is still under review.", "Wait for review to finish before installing from the registry.", def);
  }
  if (reviewStatus === "approved" || reviewStatus === "reviewed-pass" || REVIEWED_TRUST_TIERS.has(trustTier)) {
    return allowGate("allowed", "Review gate passed", "This registry MCP augment has reviewed or trusted status.");
  }

  return blockGate(
    "blocked",
    "This MCP augment has no install gate contract.",
    "The registry did not provide a backend warning-gated contract, so Equip cannot safely determine whether this install is user-acknowledgeable.",
    def,
  );
}

export function registryDefHasMcp(def: RegistryDef): boolean {
  if (registryDefToMcpInstallTargets(def as unknown as McpDefinitionInput).length > 0) return true;
  const transportPath = normalizeReviewGateValue(def.trustState?.transportPath);
  if (transportPath === "remote-mcp" || transportPath === "stdio-mcp") return true;
  return def.installMode === "package" && !!def.trustState?.equipGate;
}

function normalizeReviewGateValue(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function pathReviewDetail(path: RegistryMcpPathSummary | null | undefined): string | null {
  if (!path) return null;
  return path.unsupportedReasonDetail?.trim()
    || path.supportDetail?.trim()
    || path.supportSummary?.trim()
    || path.summary?.trim()
    || null;
}

function allowGate(
  code: RegistryInstallReviewGateCode,
  title: string,
  detail: string,
): RegistryInstallReviewGate {
  return { allowed: true, bypassable: false, code, title, detail };
}

function blockGate(
  code: RegistryInstallReviewGateCode,
  title: string,
  detail: string,
  def?: RegistryDef,
): RegistryInstallReviewGate {
  return {
    allowed: false,
    bypassable: false,
    code,
    title,
    detail,
    blockerReasons: def?.trustState?.blockerReasons || [],
    warningReasons: def?.trustState?.warningReasons || [],
  };
}

function warningGate(
  def: RegistryDef,
  options: { preferences?: RegistryWarningPreference[]; now?: Date },
): RegistryInstallReviewGate {
  const blockerReasons = def.trustState?.blockerReasons || [];
  if (blockerReasons.length > 0) {
    return blockGate(
      "blocked",
      "This MCP augment has non-bypassable install blockers.",
      blockerReasons.map(reasonDisplayText).join(" "),
      def,
    );
  }

  const warningReasons = def.trustState?.warningReasons || [];
  if (warningReasons.length === 0) {
    return blockGate(
      "blocked",
      "This MCP augment has an incomplete warning contract.",
      "The registry marked this augment warning-gated but did not provide concrete warning reasons.",
      def,
    );
  }

  const unknown = warningReasons.filter((reason) => !KNOWN_WARNING_GATE_REASON_CODES.has(normalizeReviewGateValue(reason.code)));
  if (unknown.length > 0) {
    return blockGate(
      "blocked",
      "This MCP augment uses an unknown warning reason.",
      `Unknown warning reason${unknown.length === 1 ? "" : "s"}: ${unknown.map((reason) => reason.code).join(", ")}.`,
      def,
    );
  }

  const now = options.now || new Date();
  const suppressedWarningReasons = warningReasons.filter((reason) =>
    reason.preferenceSuppressible === true && preferenceMatchesAny(reason, def, options.preferences || [], now)
  );
  const suppressedKeys = new Set(suppressedWarningReasons.map(reasonIdentityKey));
  const unsuppressedWarningReasons = warningReasons.filter((reason) => !suppressedKeys.has(reasonIdentityKey(reason)));

  if (unsuppressedWarningReasons.length === 0) {
    return {
      allowed: true,
      bypassable: false,
      code: "allowed",
      title: "Warning preferences applied",
      detail: "All current warning reasons were suppressed by local Equip preferences.",
      warningReasons,
      blockerReasons,
      suppressedWarningReasons,
      unsuppressedWarningReasons,
      acceptedByPreference: true,
    };
  }
  const nonAcceptableReasons = unsuppressedWarningReasons.filter((reason) => reason.oneTimeAcceptable !== true);
  if (nonAcceptableReasons.length > 0) {
    return blockGate(
      "blocked",
      "This MCP augment has warning reasons that cannot be accepted.",
      nonAcceptableReasons.map(reasonDisplayText).join(" "),
      def,
    );
  }

  const unboundReasons = unsuppressedWarningReasons.filter((reason) => !reasonHasAcceptanceBinding(def, reason));
  if (unboundReasons.length > 0) {
    return blockGate(
      "blocked",
      "This MCP augment has warning reasons without a current acceptance binding.",
      `Warning reason${unboundReasons.length === 1 ? "" : "s"} cannot be safely accepted for this content: ${unboundReasons.map((reason) => reason.code).join(", ")}.`,
      def,
    );
  }

  return {
    allowed: false,
    bypassable: true,
    code: "warning-gated",
    title: "This MCP augment requires explicit acknowledgement before install.",
    detail: unsuppressedWarningReasons.map(reasonDisplayText).join(" "),
    warningReasons,
    blockerReasons,
    suppressedWarningReasons,
    unsuppressedWarningReasons,
  };
}

function reasonDisplayText(reason: RegistryInstallGateReason): string {
  const message = reason.message?.trim() || reason.code;
  const details = reason.details?.trim();
  return details ? `${message} ${details}` : message;
}

function reasonIdentityKey(reason: RegistryInstallGateReason): string {
  return [
    normalizeReviewGateValue(reason.code),
    normalizeReviewGateValue(reason.selectedPathKey || ""),
    normalizeReviewGateValue(reason.contentHash || ""),
    normalizeReviewGateValue(reason.policyFingerprint || ""),
  ].join("|");
}

function preferenceMatchesAny(
  reason: RegistryInstallGateReason,
  def: RegistryDef,
  preferences: RegistryWarningPreference[],
  now: Date,
): boolean {
  return preferences.some((preference) => preferenceMatches(reason, def, preference, now));
}

function preferenceMatches(
  reason: RegistryInstallGateReason,
  def: RegistryDef,
  preference: RegistryWarningPreference,
  now: Date,
): boolean {
  if (normalizeReviewGateValue(preference.reasonCode) !== normalizeReviewGateValue(reason.code)) return false;
  const suggestedScopes = new Set((reason.suggestedPreferenceScopes || []).map(normalizeReviewGateValue));
  if (!suggestedScopes.has(normalizeReviewGateValue(preference.scope))) return false;
  if (preference.expiresAt) {
    const expiresAt = Date.parse(preference.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return false;
  }

  const expected = normalizeReviewGateValue(preference.scopeValue || "");
  if (preference.scope === "reason-global") return true;
  if (preference.scope === "augment") return expected === normalizeReviewGateValue(def.name);
  if (preference.scope === "path") return expected === normalizeReviewGateValue(reason.selectedPathKey || def.recommendedMcpPath?.pathKey || "");
  if (preference.scope === "publisher") return expected === normalizeReviewGateValue(def.publisher?.slug || "");
  if (preference.scope === "source") return expected === normalizeReviewGateValue(def.syncSourceName || def.syncSource || "");
  return false;
}

export function registryInstallGateReasonIdentity(
  def: Pick<RegistryDef, "name" | "syncSource" | "syncSourceName" | "contentHash" | "trustState">,
  reason: RegistryInstallGateReason,
): string {
  return [
    normalizeReviewGateValue(def.name),
    normalizeReviewGateValue(def.syncSourceName || def.syncSource || ""),
    normalizeReviewGateValue(reason.code),
    normalizeReviewGateValue(reason.selectedPathKey || ""),
    normalizeReviewGateValue(reasonContentBinding(def, reason)),
    normalizeReviewGateValue(reason.policyFingerprint || def.trustState?.policyFingerprint || ""),
    String(reason.copyVersion ?? 1),
    String(def.trustState?.warningTextVersion ?? 1),
  ].join("|");
}

function reasonContentBinding(
  def: Pick<RegistryDef, "contentHash">,
  reason: RegistryInstallGateReason,
): string {
  return reason.contentHash || def.contentHash || "";
}

function reasonHasAcceptanceBinding(
  def: Pick<RegistryDef, "contentHash" | "trustState">,
  reason: RegistryInstallGateReason,
): boolean {
  return !!normalizeReviewGateValue(reasonContentBinding(def, reason))
    || !!normalizeReviewGateValue(reason.policyFingerprint || def.trustState?.policyFingerprint || "");
}

export function missingAcceptedWarningReasonCodes(
  gate: RegistryInstallReviewGate,
  acceptedReasonCodes: string[],
): string[] {
  const acceptedSet = new Set(acceptedReasonCodes.map((code) => code.trim().toLowerCase()).filter(Boolean));
  const currentCodes = (gate.unsuppressedWarningReasons || gate.warningReasons || [])
    .map((reason) => reason.code.trim().toLowerCase())
    .filter(Boolean);
  return currentCodes.filter((code) => !acceptedSet.has(code));
}

export function missingAcceptedWarningReasonIdentities(
  def: Pick<RegistryDef, "name" | "syncSource" | "syncSourceName" | "contentHash" | "trustState">,
  gate: RegistryInstallReviewGate,
  acceptedReasonIdentities: string[],
): string[] {
  const acceptedSet = new Set(acceptedReasonIdentities.map((identity) => identity.trim()).filter(Boolean));
  return (gate.unsuppressedWarningReasons || gate.warningReasons || [])
    .filter((reason) => !acceptedSet.has(registryInstallGateReasonIdentity(def, reason)))
    .map((reason) => reason.code);
}

export function registryDefFromStoredContent(
  content: RegistryStoredContentSnapshot,
  contentHash?: string | null,
): RegistryDef | null {
  const publisher = content.publisher?.slug
    ? {
        name: content.publisher.name || content.publisher.slug,
        slug: content.publisher.slug,
        verified: content.publisher.verified === true,
        ...(content.publisher.avatarUrl ? { avatarUrl: content.publisher.avatarUrl } : {}),
      }
    : undefined;

  return {
    name: content.name,
    title: content.title || content.name,
    description: content.description || "",
    installMode: content.npmPackage ? "package" : "direct",
    transport: content.transport,
    serverUrl: content.serverUrl,
    stdioCommand: content.stdio?.command,
    stdioArgs: content.stdio?.args,
    envKey: content.stdio?.envKey,
    npmPackage: content.npmPackage,
    setupCommand: content.setupCommand,
    installTargets: content.installTargets,
    requiresAuth: content.requiresAuth === true,
    auth: content.auth as RegistryDef["auth"],
    status: content.registryStatus || content.status,
    registryStatus: content.registryStatus,
    listed: content.listed,
    reviewStatus: content.reviewStatus,
    trustTier: content.trustTier,
    trustState: content.trustState,
    recommendedMcpPath: content.recommendedMcpPath,
    syncSource: content.syncSource,
    syncSourceName: content.syncSourceName,
    publisher,
    contentHash: contentHash || undefined,
  };
}

export function writeRegistryInstallGateAcceptanceReceipt(
  def: RegistryDef,
  gate: RegistryInstallReviewGate,
  context: RegistryInstallGateAcceptanceReceiptContext,
): string {
  const dir = path.join(getEquipHome(), "install-gate-receipts");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const targetName = def.name.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "augment";
  const receiptPath = path.join(dir, `${targetName}.jsonl`);
  const warningReasons = gate.unsuppressedWarningReasons?.length
    ? gate.unsuppressedWarningReasons
    : gate.warningReasons || [];
  const selectedPathKey = warningReasons.find((reason) => reason.selectedPathKey)?.selectedPathKey
    || def.recommendedMcpPath?.pathKey
    || null;
  const policyFingerprint = warningReasons.find((reason) => reason.policyFingerprint)?.policyFingerprint
    || def.trustState?.policyFingerprint
    || null;

  const receipt = {
    schemaVersion: 1,
    acceptedAt: new Date().toISOString(),
    augmentName: def.name,
    selectedPathKey,
    contentHash: def.contentHash || warningReasons.find((reason) => reason.contentHash)?.contentHash || null,
    policyFingerprint,
    credentialEligibility: def.trustState?.credentialEligibility || null,
    surface: context.surface,
    actor: {
      localProfile: context.actorLocalProfile || null,
    },
    source: {
      syncSource: def.syncSource || null,
      syncSourceName: def.syncSourceName || null,
      publisherSlug: def.publisher?.slug || null,
    },
    installResult: context.installResult || "started",
    acceptedReasonCodes: context.acceptedReasonCodes || warningReasons.map((reason) => reason.code),
    warningReasons: warningReasons.map((reason) => ({
      code: reason.code,
      category: reason.category || null,
      severity: reason.severity || null,
      copyKey: reason.copyKey || null,
      copyVersion: reason.copyVersion || null,
      oneTimeAcceptable: reason.oneTimeAcceptable === true,
      preferenceSuppressible: reason.preferenceSuppressible === true,
      selectedPathKey: reason.selectedPathKey || selectedPathKey,
      contentHash: reason.contentHash || def.contentHash || null,
      policyFingerprint: reason.policyFingerprint || policyFingerprint,
    })),
  };

  const fd = fs.openSync(receiptPath, "a", 0o600);
  try {
    fs.appendFileSync(fd, `${JSON.stringify(receipt)}\n`, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(receiptPath, 0o600); } catch {}
  return receiptPath;
}

export type RegistryValidationResult =
  | { status: "fetched"; def: RegistryDef; etag?: string }
  | { status: "not-modified"; etag?: string }
  | { status: "missing" };

class RegistryContentHashMismatchError extends Error {
  constructor(
    name: string,
    expected: string,
    computed: string,
    hashAlgorithm: string | undefined,
    version: number | undefined,
  ) {
    super(
      `Registry content hash mismatch for ${name}: expected ${expected}, computed ${computed}` +
        ` (${hashAlgorithm || "sha256-v1"}, version ${version ?? "unknown"})`,
    );
    this.name = "RegistryContentHashMismatchError";
  }
}

// ─── Fetch ─────────────────────────────────────────────────

/**
 * Fetch an augment definition. Resolution order:
 * 1. Registry API (with timeout)
 * 2. Registry-scoped local cache (~/.equip/cache/registries/<registry-key>/<name>.json)
 *
 * Returns null if the augment is not found.
 */
export async function fetchRegistryDef(
  name: string,
  options: { logger?: EquipLogger } = {},
): Promise<RegistryDef | null> {
  validateToolName(name);
  const logger = options.logger || NOOP_LOGGER;

  // 1. Try the registry API
  try {
    const result = await fetchRegistryDefFromApi(name, logger);
    if (result.status === "fetched") {
      cacheAugmentDef(name, result.def, logger);
      return result.def;
    }
    if (result.status === "missing") {
      return null;
    }
  } catch (err: unknown) {
    if (err instanceof RegistryContentHashMismatchError) {
      logger.error(err.message, { name });
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug("API fetch failed, falling back to cache", { name, error: msg });
  }

  // 2. Try local cache
  return readCachedAugmentDef(name, logger);
}

/**
 * Fetch an augment definition for a write/install operation.
 * This path is intentionally live-only: stale cache is useful for display, but
 * it must not authorize platform writes after registry policy changes.
 */
export async function fetchRegistryDefForInstall(
  name: string,
  options: { logger?: EquipLogger } = {},
): Promise<RegistryDef | null> {
  validateToolName(name);
  const logger = options.logger || NOOP_LOGGER;
  const result = await fetchRegistryDefFromApi(name, logger, { installGate: true });
  if (result.status === "fetched") {
    cacheAugmentDef(name, result.def, logger);
    return result.def;
  }
  if (result.status === "missing") return null;
  return null;
}

/**
 * Validate an augment directly against the live registry.
 * Unlike fetchRegistryDef(), this does not fall back to local cache.
 */
export async function validateAgainstRegistry(
  name: string,
  options: { logger?: EquipLogger; ifNoneMatch?: string } = {},
): Promise<RegistryValidationResult> {
  validateToolName(name);
  const logger = options.logger || NOOP_LOGGER;
  return fetchRegistryDefFromApi(name, logger, { ifNoneMatch: options.ifNoneMatch });
}

// ─── Cache ─────────────────────────────────────────────────

function cacheAugmentDef(name: string, def: RegistryDef, logger: EquipLogger): void {
  try {
    const cachePath = cachePathFor(name);
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const envelope: RegistryCacheEnvelope = {
      schemaVersion: REGISTRY_CACHE_SCHEMA_VERSION,
      registryKey: registryCacheKey(),
      registryUrl: REGISTRY_API,
      fetchedAt: new Date().toISOString(),
      ...(def.contentHash ? { contentHash: def.contentHash } : {}),
      ...(def.hashAlgorithm ? { hashAlgorithm: def.hashAlgorithm } : {}),
      ...(def.version ? { version: def.version } : {}),
      def,
    };
    fs.writeFileSync(cachePath, JSON.stringify(envelope, null, 2));
    logger.debug("Augment definition cached", { name, path: cachePath });
  } catch (err: unknown) {
    logger.debug("Failed to cache augment definition", { name, error: (err as Error).message });
  }
}

function readCachedAugmentDef(name: string, logger: EquipLogger): RegistryDef | null {
  try {
    const cachePath = cachePathFor(name);
    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const def = registryDefFromCachePayload(name, parsed, logger);
    if (!def) return null;
    logger.info("Augment definition loaded from cache", { name });
    return def;
  } catch {
    return null;
  }
}

function registryDefFromCachePayload(
  name: string,
  parsed: unknown,
  logger: EquipLogger,
): RegistryDef | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logger.debug("Registry cache ignored", { name, reason: "not_object" });
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if ("schemaVersion" in record || "def" in record) {
    if (record.schemaVersion !== REGISTRY_CACHE_SCHEMA_VERSION) {
      logger.debug("Registry cache ignored", { name, reason: "schema_mismatch" });
      return null;
    }
    if (record.registryKey !== registryCacheKey()) {
      logger.debug("Registry cache ignored", { name, reason: "registry_key_mismatch" });
      return null;
    }
    if (!record.def || typeof record.def !== "object" || Array.isArray(record.def)) {
      logger.debug("Registry cache ignored", { name, reason: "missing_def" });
      return null;
    }
    const def = record.def as RegistryDef;
    if (def.name !== name || typeof def.title !== "string") {
      logger.debug("Registry cache ignored", { name, reason: "def_shape_mismatch" });
      return null;
    }
    return def;
  }

  const legacyDef = record as unknown as RegistryDef;
  if (legacyDef.name !== name || typeof legacyDef.title !== "string") {
    logger.debug("Registry cache ignored", { name, reason: "legacy_shape_mismatch" });
    return null;
  }

  // One-shot migration preserves offline fallback for users who upgrade while
  // already offline. Subsequent reads use the envelope path only.
  cacheAugmentDef(name, legacyDef, logger);
  logger.info("Registry cache migrated to envelope", { name });
  return legacyDef;
}

async function fetchRegistryDefFromApi(
  name: string,
  logger: EquipLogger,
  options: { ifNoneMatch?: string; installGate?: boolean } = {},
): Promise<RegistryValidationResult> {
  const url = `${REGISTRY_API}/augments/${encodeURIComponent(name)}${options.installGate ? "?installGate=1" : ""}`;
  const ifNoneMatch = formatIfNoneMatch(options.ifNoneMatch);
  logger.debug("Fetching augment definition from API", { url, conditional: !!ifNoneMatch });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
    if (options.installGate) headers["Cache-Control"] = "no-cache";
    const requestHeaders = Object.keys(headers).length > 0 ? headers : undefined;
    const res = await fetch(url, { signal: controller.signal, headers: requestHeaders });

    if (res.status === 304) {
      logger.info("Augment definition not modified", { name });
      return {
        status: "not-modified",
        etag: extractStrongEtag(res.headers.get("etag")) || options.ifNoneMatch,
      };
    }

    if (res.ok) {
      const raw = await res.json() as RegistryDef & { displayName?: string };
      // Normalize: title is the canonical field, displayName is deprecated
      const def: RegistryDef = { ...raw, title: raw.title || raw.displayName || raw.name };
      logger.info("Augment definition fetched from API", { name, installMode: def.installMode });

      // Verify transport integrity before caching or installing. Hash mismatches
      // must not fall back to stale cache because that can pin older auth/runtime
      // behavior after the registry has changed.
      if (def.contentHash && process.env.EQUIP_TEST_SKIP_HASH_VERIFY !== "1") {
        const {
          computeContentHash,
          computeContentHashV2,
          computeContentHashV3,
          extractManifest,
          extractManifestV2,
          extractManifestV3,
        } = await import("./content-hash.js");
        const algorithm = (def.hashAlgorithm || "sha256-v1").toLowerCase();
        const computed = algorithm === "sha256-v3"
          ? computeContentHashV3(extractManifestV3(def))
          : algorithm === "sha256-v2"
            ? computeContentHashV2(extractManifestV2(def))
            : computeContentHash(extractManifest(def));
        if (computed !== def.contentHash) {
          throw new RegistryContentHashMismatchError(
            name,
            def.contentHash,
            computed,
            def.hashAlgorithm,
            def.version,
          );
        }
      }

      return {
        status: "fetched",
        def,
        etag: extractStrongEtag(res.headers.get("etag")) || def.contentHash,
      };
    }

    if (res.status === 404) {
      logger.debug("Augment not found in registry", { name });
      return { status: "missing" };
    }

    throw new Error(`Registry API returned ${res.status} for ${name}`);
  } finally {
    clearTimeout(timeout);
  }
}

function formatIfNoneMatch(contentHash?: string): string | undefined {
  const trimmed = contentHash?.trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || trimmed === "*") {
    return trimmed;
  }
  return `"${trimmed}"`;
}

function extractStrongEtag(headerValue: string | null): string | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  const withoutWeakPrefix = trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
  if (withoutWeakPrefix.startsWith("\"") && withoutWeakPrefix.endsWith("\"")) {
    return withoutWeakPrefix.slice(1, -1);
  }
  return withoutWeakPrefix || undefined;
}

// ─── Conversion ────────────────────────────────────────────

/**
 * Convert a RegistryDef (from API/cache) to an AugmentConfig (for the Augment class).
 * Direct-mode definitions and structured MCP installTargets become platform config
 * entries. Legacy package-mode augments without installTargets still dispatch via
 * package setup outside this adapter.
 */
export function registryDefToConfig(
  def: RegistryDef,
  options?: { logger?: EquipLogger; mcpInstallInputs?: Record<string, string | undefined>; apiKey?: string | null },
): AugmentConfig {
  const config: AugmentConfig = {
    name: def.name,
    logger: options?.logger,
    augmentVersion: def.version,
    source: "registry",
    package: def.npmPackage,
    mcpInstallInputs: options?.mcpInstallInputs,
  };

  if (def.serverUrl) {
    config.serverUrl = def.serverUrl;
  }

  const target = registryDefToPreferredMcpInstallTarget(def as unknown as McpDefinitionInput, {
    inputs: options?.mcpInstallInputs,
    apiKey: options?.apiKey,
  });
  if (target) {
    config.mcpInstallTarget = target;
    if (target.kind === "remote") {
      config.serverUrl = target.url;
    } else if (target.kind === "stdio") {
      config.stdio = {
        command: target.command,
        args: target.args,
        envKey: target.envKey || "",
      };
    }
  }

  if (def.rules) {
    config.rules = {
      content: def.rules.content,
      version: def.rules.version,
      marker: def.rules.marker,
    };
    if (def.rules.fileName) config.rules.fileName = def.rules.fileName;
  }

  if (def.stdioCommand) {
    // Preserve the historical default for OIDC stdio augments that omit
    // envKey. Registry authors should set envKey explicitly for new augments.
    const defaultEnvKeyForAuth = def.auth?.type === "oidc"
      ? "PRIOR_IDENTITY_ACCESS_TOKEN"
      : "";
    config.stdio = {
      command: def.stdioCommand,
      args: def.stdioArgs || [],
      envKey: def.envKey || defaultEnvKeyForAuth,
    };
  }

  if (def.hooks && def.hooks.length > 0) {
    config.hooks = def.hooks;
  }

  if (def.hookDir) {
    config.hookDir = validateHookDir(def.hookDir);
  }

  // Skills: pass all skills through
  if (def.skills && def.skills.length > 0) {
    config.skills = def.skills;
  }

  return config;
}
