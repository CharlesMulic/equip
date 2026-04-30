// Broker-mode auth abstractions: Provider interface + DeliveryDecision.
// Sibling to auth-engine.ts; deliberately NOT inside it so the
// 1207-line direct-mode file stays untouched (Package 01 scope rule).
//
// Comprehensive refactor of auth-engine.ts to use these types is broker
// plan Phase 1 — explicitly out of scope for this initiative.
//
// See ADR: equip-app/planning/ADR-cross-platform-strategy-pattern.md
//
// Zero non-Node dependencies; pure types + minimal runtime helpers.

import type { AuthConfig, StoredCredential } from "./auth-engine";

// ─── Provider ───────────────────────────────────────────────
//
// A Provider owns the lifecycle of credentials for one auth mode
// (api_key, oauth, oauth_to_api_key, oidc, ...). Broker code routes
// per-augment refresh / validate / invalidate calls to the right
// Provider implementation, instead of branching on auth.type strings
// across 1000+ lines like the current direct-mode auth-engine does.
//
// Implementations land in Package 02 (broker daemon). Intentionally
// minimal here — we add methods only when broker code needs them, not
// preemptively.

export interface ProviderDescription {
  /** Stable id for telemetry + doctor surface (e.g., "oauth-pkce", "oauth-to-api-key"). */
  id: string;
  /** Human-readable name for doctor / log output. */
  name: string;
  /** Auth modes this provider handles (matches AuthConfig.type values). */
  authTypes: AuthConfig["type"][];
}

export interface ProviderAcquireOptions {
  augmentName: string;
  auth: AuthConfig;
  /** Browser opener for first-time interactive auth, if needed. */
  openBrowser?: (url: string) => (() => void) | void;
  /** Allow non-interactive failure when no UI is available. */
  nonInteractive?: boolean;
}

export interface ProviderRefreshOptions {
  augmentName: string;
  current: StoredCredential;
}

export interface ProviderValidateOptions {
  augmentName: string;
  current: StoredCredential;
}

export type ProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string };

/**
 * Minimal Provider contract — covers what broker daemon code needs to
 * call uniformly across auth modes. Intentionally narrower than the
 * current auth-engine.resolveAuth surface; expand only when broker code
 * has a real callsite.
 */
export interface Provider {
  /** Identity for telemetry, doctor surface, and dispatch. */
  describe(): ProviderDescription;

  /** First-time credential acquisition (may open a browser). */
  acquire(opts: ProviderAcquireOptions): Promise<ProviderResult<StoredCredential>>;

  /** Refresh existing credentials before/after expiry. */
  refresh(opts: ProviderRefreshOptions): Promise<ProviderResult<StoredCredential>>;

  /**
   * Probe upstream that current credentials still work. Returns ok=true
   * with no value on success. Called by whatever runtime owns the
   * provider's lifecycle — `equip doctor` deliberately does not invoke
   * it, since that would require an IPC client and re-cross the boundary.
   */
  validate(opts: ProviderValidateOptions): Promise<ProviderResult<void>>;

  /**
   * Tear down credentials (revoke upstream when supported, delete locally).
   * Used by `equip uninstall` and consent-revocation handling.
   */
  invalidate(augmentName: string): Promise<ProviderResult<void>>;
}

// ─── DeliveryDecision ───────────────────────────────────────
//
// At install time, broker code decides how an augment's credentials
// should be delivered to the platform's MCP runtime. The choice is
// per-augment per-platform per-auth-mode and is the load-bearing branch
// for "broker mode vs direct mode vs unsupported."
//
// Discriminated union so callers must handle every case at the type
// level. Adding a new delivery mode (e.g., per-platform variants of
// broker) means adding a new union member, not a new boolean flag.

export interface DirectDelivery {
  kind: "direct";
  /** AuthConfig the platform will see (same shape it sees today). */
  auth: AuthConfig;
  /** Why broker wasn't selected — for telemetry + doctor surface. */
  reason: DirectDeliveryReason;
}

export type DirectDeliveryReason =
  | "platform_does_not_support_broker"
  | "auth_mode_does_not_support_broker"
  | "user_opted_out"
  | "broker_disabled_by_kill_switch"
  | "existing_direct_install_preserved";

export interface BrokerDelivery {
  kind: "broker";
  /** Which transport the platform-specific writer used. */
  transport: "stdio" | "loopback-http";
  /** Provider id that owns this credential. */
  providerId: string;
}

export interface UnsupportedDelivery {
  kind: "unsupported";
  /** Why no delivery is possible — surfaces as a doctor finding. */
  reason: UnsupportedDeliveryReason;
}

export type UnsupportedDeliveryReason =
  | "platform_unknown"
  | "auth_mode_unsupported"
  | "broker_required_but_disabled"
  | "platform_version_too_old";

/**
 * Discriminated union of how an augment's credentials reach the
 * platform's MCP runtime. Switch on `kind`; the type system enforces
 * exhaustive handling.
 */
export type DeliveryDecision =
  | DirectDelivery
  | BrokerDelivery
  | UnsupportedDelivery;

// ─── Helpers ────────────────────────────────────────────────

/**
 * Compile-time exhaustiveness check for switch statements on
 * DeliveryDecision. Throws at runtime if a case is missed.
 *
 * Usage:
 *   switch (decision.kind) {
 *     case "direct": ...
 *     case "broker": ...
 *     case "unsupported": ...
 *     default: assertNeverDelivery(decision);
 *   }
 */
export function assertNeverDelivery(d: never): never {
  throw new Error(`unhandled DeliveryDecision: ${JSON.stringify(d)}`);
}
