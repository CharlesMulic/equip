// OAuthToApiKeyProvider — auth.type="oauth_to_api_key".
//
// Flow on acquire:
//   1. Run OAuth PKCE browser flow (delegated to OAuthProvider).
//   2. POST the OAuth access token to the publisher's `keyExchange.url`
//      with `tokenHeader: Bearer <oauth-token>`.
//   3. Extract the API key from the response per `keyExchange.keyPath`
//      (dot-separated JSON path).
//   4. Store the API key as the credential. The OAuth tokens are kept
//      in the StoredCredential's `oauth` field for the rare re-exchange
//      case but aren't actively refreshed.
//
// Flow on refresh:
//   No-op (API keys are durable). If validation surfaces the key as
//   revoked, the manager re-runs acquire which gets a fresh key via
//   the full OAuth + exchange path.
//
// Conflict handling: some publisher key-exchange endpoints reject
// re-acquire if a key already exists for the user (auth-engine handles
// this with `conflictResolution: "regenerate"` or "prompt"). The broker
// is non-interactive — we always auto-regenerate when conflictCode
// matches and `conflictResolution !== "prompt"`. If the publisher
// requires "prompt", the install command above the broker has to
// collect the existing key and pass it as preObtainedCredential
// (similar to ApiKeyProvider's pattern).
//
// Ported from equip/src/lib/auth-engine.ts:resolveOAuthToApiKey.

import type {
  Provider,
  ProviderAcquireOptions,
  ProviderRefreshOptions,
  ProviderValidateOptions,
  ProviderResult,
  ProviderDescription,
} from "../auth-broker-types";
import type { StoredCredential, AuthConfig } from "../auth-engine";
import { OAuthProvider } from "./provider-oauth";

const PROVIDER_ID = "oauth-to-api-key";

export interface OAuthToApiKeyProviderOptions {
  /** Underlying OAuth provider (composed). Allows test override. */
  oauthProvider?: OAuthProvider;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ApiKeyAcquireOptions extends ProviderAcquireOptions {
  /** When the publisher requires "prompt" conflict resolution, the install
      command above the broker collects the user's existing key and passes
      it in here. Provider stores it directly without re-running OAuth. */
  preObtainedCredential?: string;
}

export class OAuthToApiKeyProvider implements Provider {
  private readonly oauthProvider: OAuthProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OAuthToApiKeyProviderOptions = {}) {
    this.oauthProvider = opts.oauthProvider ?? new OAuthProvider();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  describe(): ProviderDescription {
    return {
      id: PROVIDER_ID,
      name: "OAuth then key-exchange",
      authTypes: ["oauth_to_api_key"],
    };
  }

  async acquire(opts: ProviderAcquireOptions): Promise<ProviderResult<StoredCredential>> {
    const auth = opts.auth;
    if (!auth.oauth || !auth.keyExchange) {
      return { ok: false, error: "auth.oauth or auth.keyExchange missing", code: "invalid_auth_config" };
    }

    // Shortcut: install command supplied an existing key (prompt-conflict path).
    const preObtained = (opts as ApiKeyAcquireOptions).preObtainedCredential;
    if (preObtained) {
      const now = new Date().toISOString();
      return {
        ok: true,
        value: {
          authType: "oauth_to_api_key",
          credential: preObtained,
          keyPrefix: auth.keyPrefix,
          toolName: opts.augmentName,
          storedAt: now,
          updatedAt: now,
        },
      };
    }

    // Step 1: OAuth flow.
    const oauthResult = await this.oauthProvider.acquire(opts);
    if (!oauthResult.ok) return oauthResult;

    // Step 2: exchange OAuth access token for API key.
    const accessToken = oauthResult.value.oauth?.accessToken;
    if (!accessToken) {
      return { ok: false, error: "OAuth flow did not return an access_token", code: "oauth_protocol_error" };
    }
    const exchangeResult = await this.exchangeForKey(accessToken, auth.keyExchange);
    if (!exchangeResult.ok) return exchangeResult;

    const now = new Date().toISOString();
    return {
      ok: true,
      value: {
        authType: "oauth_to_api_key",
        credential: exchangeResult.value,
        keyPrefix: auth.keyPrefix,
        toolName: opts.augmentName,
        // Preserve the OAuth tokens for the rare re-exchange case (e.g.,
        // user manually invalidated the API key but the OAuth grant is
        // still valid).
        oauth: oauthResult.value.oauth,
        storedAt: now,
        updatedAt: now,
      },
    };
  }

  async refresh(opts: ProviderRefreshOptions): Promise<ProviderResult<StoredCredential>> {
    // API keys don't refresh. Bump updatedAt so the scheduler doesn't
    // keep firing on stale-looking metadata; the actual credential is
    // unchanged.
    return {
      ok: true,
      value: { ...opts.current, updatedAt: new Date().toISOString() },
    };
  }

  async validate(_opts: ProviderValidateOptions): Promise<ProviderResult<void>> {
    return { ok: true, value: undefined };
  }

  async invalidate(_augmentName: string): Promise<ProviderResult<void>> {
    return { ok: true, value: undefined };
  }

  // ─── Key exchange ─────────────────────────────────────────

  private async exchangeForKey(
    oauthAccessToken: string,
    config: NonNullable<AuthConfig["keyExchange"]>,
    /** Recursion depth guard — prevents conflict-loop on misconfigured publishers. */
    depth = 0,
  ): Promise<ProviderResult<string>> {
    if (depth > 1) {
      return { ok: false, error: "key-exchange recursion exceeded", code: "key_exchange_loop" };
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      [config.tokenHeader]: `Bearer ${oauthAccessToken}`,
    };
    let response: Response;
    try {
      response = await this.fetchImpl(config.url, {
        method: config.method,
        headers,
        body: JSON.stringify(config.body ?? {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { ok: false, error: `key-exchange request failed: ${(err as Error).message}`, code: "network_error" };
    }
    let data: Record<string, unknown>;
    try {
      data = await response.json() as Record<string, unknown>;
    } catch {
      return { ok: false, error: `key-exchange returned non-JSON (HTTP ${response.status})`, code: "protocol_error" };
    }

    if (response.ok) {
      const key = getNestedValue(data, config.keyPath);
      if (typeof key === "string" && key.length > 0) {
        return { ok: true, value: key };
      }
      return {
        ok: false,
        error: `key not found at path "${config.keyPath}" in response`,
        code: "key_path_missing",
      };
    }

    // Conflict path (e.g., KEY_EXISTS) — auto-regenerate when allowed.
    const errorData = data as { error?: { code?: string } };
    if (config.conflictCode && errorData.error?.code === config.conflictCode) {
      if (config.conflictResolution === "prompt") {
        return {
          ok: false,
          error: `key already exists; publisher requires user to choose between regenerate and paste-existing — broker is non-interactive`,
          code: "interactive_required",
        };
      }
      // Default and "regenerate" both auto-regen.
      return this.exchangeForKey(
        oauthAccessToken,
        { ...config, body: config.regenerateBody ?? { regenerate: true }, conflictCode: undefined },
        depth + 1,
      );
    }

    const errMsg = (errorData.error as { message?: string } | undefined)?.message
      ?? `key-exchange returned HTTP ${response.status}`;
    return { ok: false, error: errMsg, code: "key_exchange_failed" };
  }
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
