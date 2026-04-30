// OidcProvider — RFC 8693 token-exchange against CG3.
//
// This is the dominant production case. Every prior-identity-integrated
// augment uses auth.type="oidc"; the publisher's MCP server validates
// the issued JWT offline via the @cg3/prior-identity SDK.
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
//      server uses jose.jwtVerify against the platform's JWKS — fully offline.
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
    return this.tokenExchange(opts.augmentName, /* consent= */ true);
  }

  async refresh(opts: ProviderRefreshOptions): Promise<ProviderResult<StoredCredential>> {
    return this.tokenExchange(opts.augmentName, /* consent= */ false);
  }

  async validate(_opts: ProviderValidateOptions): Promise<ProviderResult<void>> {
    // The credential's freshness is the JWT's exp claim (decoded by the
    // CredentialManager). The Provider's validate() doesn't add value
    // beyond what offline JWT validation already gives the publisher.
    return { ok: true, value: undefined };
  }

  async invalidate(_augmentName: string): Promise<ProviderResult<void>> {
    // No upstream revoke here — the issued delegated access token has a
    // 60-min TTL and is bound to the augment audience. Revocation
    // semantics live in CG3's `/revoke` endpoint and the consent-revoke
    // path; calling them is consent-management territory, not Provider
    // territory. Local-only delete is the manager's job.
    return { ok: true, value: undefined };
  }

  /**
   * Core RFC 8693 token-exchange flow. Used for both acquire (with
   * consent_action=accept) and refresh (without).
   */
  private async tokenExchange(
    augmentName: string,
    includeConsent: boolean,
  ): Promise<ProviderResult<StoredCredential>> {
    const session = await this.readSession();
    if (!session?.accessToken) {
      return {
        ok: false,
        error: "no Equip session — user must run `equip login` first",
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
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: clientId,
      audience: augmentName,
      subject_token: session.accessToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "identity:read",
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
      const description = (body.error_description || body.error || `HTTP ${response.status}`) as string;
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
    return {
      ok: true,
      value: {
        authType: "oidc",
        credential: accessToken,
        toolName: augmentName,
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
