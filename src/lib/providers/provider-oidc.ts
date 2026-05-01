// OidcProvider — RFC 8693 token exchange for delegated augment auth.
//
// Augments can use auth.type="oidc" when the signed-in Equip session can
// mint an audience-scoped token for the publisher's MCP server.
//
// Flow on acquire / refresh:
//   1. Read user's CG3 session from `~/.equip/app/session.json`.
//      Session format: { accessToken, refreshToken, expiresAt, tokenUrl, clientId }.
//   2. POST to ${tokenUrl} with grant_type=urn:ietf:params:oauth:grant-type:token-exchange,
//      subject_token=session.accessToken, audience=augmentName, scope="identity:read".
//   3. On acquire (interactive install): include consent_action=accept so the platform
//      records consent atomically with token issuance.
//   4. On refresh (background): NEVER include consent_action — refresh must not be a
//      consent-write path.
//   5. Store the issued delegated access token. Validation at the publisher's MCP
//      server verifies the issued token against the platform's JWKS.
//
// This provider doesn't refresh `session.json` itself — that's whoever
// owns the session lifecycle. If the session is stale at refresh time,
// OidcProvider returns { ok: false, code: "session_stale" } and the
// next tick retries after the session has been refreshed externally.
//
// Ported from equip/src/lib/auth-engine.ts:resolveOidc + refreshOidcTokens.

import * as fs from "node:fs/promises";
import type {
  Provider,
  ProviderAcquireOptions,
  ProviderRefreshOptions,
  ProviderValidateOptions,
  ProviderResult,
  ProviderDescription,
} from "../auth-broker-types";
import type { StoredCredential } from "../auth-engine";

const PROVIDER_ID = "oidc";
const DEFAULT_TOKEN_URL = "https://api.cg3.io/token";
const DEFAULT_CLIENT_ID = "equip-desktop";

export interface EquipSessionFileShape {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenUrl?: string;
  clientId?: string;
}

export interface OidcProviderOptions {
  /** Function to read the current Equip session. Production reads `~/.equip/app/session.json`. */
  readSession: () => Promise<EquipSessionFileShape | null>;
  /** Override for test harnesses; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class OidcProvider implements Provider {
  private readonly readSession: OidcProviderOptions["readSession"];
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OidcProviderOptions) {
    this.readSession = opts.readSession;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  describe(): ProviderDescription {
    return { id: PROVIDER_ID, name: "CG3 OIDC delegated", authTypes: ["oidc"] };
  }

  async acquire(opts: ProviderAcquireOptions): Promise<ProviderResult<StoredCredential>> {
    return this.tokenExchange(opts.augmentName, /* consent= */ true, {
      audience: opts.auth.audience,
      scopes: opts.auth.scopes,
    });
  }

  async refresh(opts: ProviderRefreshOptions): Promise<ProviderResult<StoredCredential>> {
    return this.tokenExchange(opts.augmentName, /* consent= */ false, {
      audience: opts.current.audience,
      scopes: opts.current.scopes,
    });
  }

  async validate(_opts: ProviderValidateOptions): Promise<ProviderResult<void>> {
    // The credential's freshness is the JWT's exp claim (decoded by the
    // CredentialManager). The Provider's validate() doesn't add value
    // beyond what offline JWT validation already gives the publisher.
    return { ok: true, value: undefined };
  }

  async invalidate(_augmentName: string): Promise<ProviderResult<void>> {
    // No upstream revoke here — the issued delegated access token has a
    // short TTL and is bound to the augment audience. Consent revocation is
    // handled outside this provider; local-only delete is the manager's job.
    return { ok: true, value: undefined };
  }

  /**
   * Core RFC 8693 token-exchange flow. Used for both acquire (with
   * consent_action=accept) and refresh (without).
   *
   * Audience + scopes are supplied from auth-config (acquire) or stored
   * credential (refresh).
   * Falls back to legacy values (audience=augmentName, scope=identity:read)
   * for older registry rows that do not carry the uniform shape yet.
   */
  private async tokenExchange(
    augmentName: string,
    includeConsent: boolean,
    overrides: { audience?: string; scopes?: string[] } = {},
  ): Promise<ProviderResult<StoredCredential>> {
    const session = await this.readSession();
    if (!session?.accessToken) {
      return {
        ok: false,
        error: "no Equip session — sign in to Equip before installing this augment",
        code: "session_missing",
      };
    }
    if (isJwtExpired(session.accessToken)) {
      return {
        ok: false,
        error: "Equip session expired — refresh required before delegated tokens can be issued",
        code: "session_stale",
      };
    }

    const tokenUrl = session.tokenUrl ?? DEFAULT_TOKEN_URL;
    const clientId = session.clientId ?? DEFAULT_CLIENT_ID;

    // Backward-compatible fallbacks for registry definitions that do not
    // yet carry explicit audience/scopes.
    const audience = overrides.audience ?? augmentName;
    const scopeStr = overrides.scopes && overrides.scopes.length > 0
      ? overrides.scopes.join(" ")
      : "identity:read";

    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: clientId,
      audience,
      subject_token: session.accessToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: scopeStr,
    });
    if (includeConsent) form.set("consent_action", "accept");

    let response: Response;
    try {
      response = await this.fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return {
        ok: false,
        error: `token-exchange request failed: ${(err as Error).message}`,
        code: "network_error",
      };
    }

    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      return { ok: false, error: `token-exchange returned non-JSON (HTTP ${response.status})`, code: "protocol_error" };
    }

    if (!response.ok || !body.access_token) {
      // Coerce description to string defensively. The token endpoint can return
      // either RFC-6749 flat `{error, error_description}` (the spec shape
      // /token is supposed to use) OR the wrapped `{ok: false, error: {code,
      // message, ...}}` envelope used by other routes when an exception
      // bubbles past the route handler. The latter has `error` as an
      // object, which broke `description.includes(...)` with TypeError
      // "undefined is not a function" on the broker hot path.
      const rawDescription =
        (typeof body.error_description === "string" && body.error_description) ||
        (typeof body.error === "string" && body.error) ||
        (body.error && typeof (body.error as { message?: unknown }).message === "string"
          ? (body.error as { message: string }).message
          : null) ||
        `HTTP ${response.status}`;
      const description = String(rawDescription);
      // Map common server-side errors to actionable codes.
      let code = "refresh_failed";
      if (description === "consent_required" || description === "grant_acceptance_required") {
        code = "consent_required";
      } else if (description === "invalid_grant" || description.includes("subject_token")) {
        code = "session_stale";
      }
      return { ok: false, error: description, code };
    }

    const accessToken = body.access_token as string;
    const now = new Date().toISOString();
    // Persist the audience + scopes the credential was issued with so
    // refresh can re-mint with consistent claims. Reading
    // response-side "scope" (RFC 8693 §2.2) when the AS narrows what
    // it issued vs. what was requested.
    const issuedScopeStr = typeof body.scope === "string" ? body.scope : scopeStr;
    const issuedScopes = issuedScopeStr.split(" ").filter((s) => s.length > 0);
    return {
      ok: true,
      value: {
        authType: "oidc",
        credential: accessToken,
        toolName: augmentName,
        audience,
        scopes: issuedScopes,
        storedAt: now,
        updatedAt: now,
      },
    };
  }
}

function isJwtExpired(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
    if (typeof payload.exp === "number") {
      return payload.exp < Math.floor(Date.now() / 1000);
    }
  } catch { /* unparseable — treat as not-expired and let upstream reject */ }
  return false;
}

/**
 * Production session reader. Reads `~/.equip/app/session.json`. The path
 * is injected via `appDir` so tests can use a tempdir.
 */
export function createDefaultSessionReader(appDir: string): OidcProviderOptions["readSession"] {
  return async () => {
    try {
      const raw = await fs.readFile(`${appDir}/session.json`, "utf-8");
      const parsed = JSON.parse(raw) as Partial<EquipSessionFileShape>;
      if (typeof parsed.accessToken === "string") {
        return parsed as EquipSessionFileShape;
      }
      return null;
    } catch {
      return null;
    }
  };
}
