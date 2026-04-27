// ApiKeyProvider — for augments that declare auth.type="api_key".
//
// Static API key flow. The broker doesn't generate or rotate the key;
// the user supplies it (via prompt, env var, or --api-key flag at
// install time, all handled at the install-command layer above the
// broker). Once supplied, the broker just persists and serves.
//
// `acquire`: the broker EXPECTS the install-command layer to have
// already collected the key from the user and to pass it via
// `opts.preObtainedCredential`. The broker is not interactive; it
// doesn't open a TTY prompt. If no pre-obtained key is provided,
// `acquire` returns `interactive_required` and the install layer is
// responsible for re-calling once the user has been prompted.
//
// `refresh`: no-op. API keys don't refresh. Returns the current
// credential with `updatedAt` bumped so the scheduler doesn't keep
// triggering on stale-looking metadata.
//
// `validate`: HEAD/GET against the augment's `auth.validationUrl` if
// declared. If not declared, returns `ok` (we have no way to probe).
//
// `invalidate`: best-effort revoke if the publisher exposes a revoke
// endpoint (today's AuthConfig has no field for this, so it's just
// a local-delete signal — caller deletes from CredentialStore).

import type {
  Provider,
  ProviderAcquireOptions,
  ProviderRefreshOptions,
  ProviderValidateOptions,
  ProviderResult,
  ProviderDescription,
} from "../auth-broker-types";
import type { StoredCredential, AuthConfig } from "../auth-engine";

const PROVIDER_ID = "api-key";

/**
 * Extension of ProviderAcquireOptions for ApiKeyProvider — the
 * install-command layer prompts the user, then passes the collected
 * key into acquire via this field. Type-cast at the dispatch layer.
 */
export interface ApiKeyAcquireOptions extends ProviderAcquireOptions {
  preObtainedCredential?: string;
}

export class ApiKeyProvider implements Provider {
  describe(): ProviderDescription {
    return {
      id: PROVIDER_ID,
      name: "Static API key Provider",
      authTypes: ["api_key"],
    };
  }

  async acquire(opts: ProviderAcquireOptions): Promise<ProviderResult<StoredCredential>> {
    const key = (opts as ApiKeyAcquireOptions).preObtainedCredential;
    if (!key) {
      return {
        ok: false,
        error: "API key required — broker does not prompt; install-command layer must collect the key from the user and re-invoke acquire with preObtainedCredential",
        code: "interactive_required",
      };
    }

    // Optional prefix sanity-check, just like auth-engine.resolveApiKey.
    // Surfaced as a warning code; we still accept the key.
    const auth = opts.auth;
    const prefixWarning =
      typeof auth.keyPrefix === "string" && auth.keyPrefix.length > 0 && !key.startsWith(auth.keyPrefix)
        ? `key does not start with expected prefix "${auth.keyPrefix}"`
        : null;

    const now = new Date().toISOString();
    const cred: StoredCredential = {
      authType: "api_key",
      credential: key,
      keyPrefix: auth.keyPrefix,
      toolName: opts.augmentName,
      storedAt: now,
      updatedAt: now,
    };
    if (prefixWarning) {
      // Surface via console for visibility; doesn't fail the acquire.
      // (Real production logging happens at the broker dispatch layer.)
      // eslint-disable-next-line no-console
      console.warn(`[api-key-provider] ${opts.augmentName}: ${prefixWarning}`);
    }
    return { ok: true, value: cred };
  }

  async refresh(opts: ProviderRefreshOptions): Promise<ProviderResult<StoredCredential>> {
    // API keys don't refresh — return current as-is with updated timestamp.
    return {
      ok: true,
      value: { ...opts.current, updatedAt: new Date().toISOString() },
    };
  }

  async validate(opts: ProviderValidateOptions): Promise<ProviderResult<void>> {
    // We don't have access to the AuthConfig in ProviderValidateOptions
    // today (it's not a parameter). Validation needs the validationUrl.
    // For MVP, return ok unconditionally — full validation happens in
    // the dispatch layer where AuthConfig is known. This is a
    // documented gap; a future Provider interface revision adds AuthConfig
    // to validate options.
    return { ok: true, value: undefined };
  }

  async invalidate(_augmentName: string): Promise<ProviderResult<void>> {
    // No upstream revoke for static API keys (the provider has no
    // standard "expire this key" endpoint). Local-only delete is the
    // caller's responsibility (CredentialStore.delete in the dispatch
    // layer). Return ok — the local delete is what matters.
    return { ok: true, value: undefined };
  }
}

/**
 * Validate an API-key credential by calling the augment's `validationUrl`.
 * Lifted here as a free function (rather than a Provider method) because
 * the Provider interface's validate() doesn't currently get AuthConfig.
 * The dispatch layer calls this directly when it has the AuthConfig in
 * scope (e.g., from the augment manifest).
 */
export async function validateApiKeyCredential(
  credential: string,
  auth: AuthConfig,
): Promise<{ valid: boolean | null; detail?: string }> {
  if (!auth.validationUrl) {
    return { valid: null, detail: "no validationUrl configured" };
  }
  try {
    const res = await fetch(auth.validationUrl, {
      headers: { Authorization: `Bearer ${credential}`, "User-Agent": "equip-broker" },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return { valid: true };
    if (res.status === 401 || res.status === 403) {
      return { valid: false, detail: `validationUrl returned ${res.status}` };
    }
    return { valid: null, detail: `validationUrl returned ${res.status}` };
  } catch (err) {
    return { valid: null, detail: (err as Error).message };
  }
}
