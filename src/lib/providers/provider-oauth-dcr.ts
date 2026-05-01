// OAuthDcrProvider — third-party MCP servers with their own authorization
// server. The augment definition declares its publisher's authorization-server
// metadata; broker runtime support will handle Dynamic Client Registration
// (RFC 7591), auth-code + PKCE browser flow, and refresh.
//
// Schema-only stub: `auth.type === "oauth-dcr"` is accepted by the parser, but
// acquire/refresh return not_implemented until runtime support ships.
//
// Calling `acquire()` or `refresh()` in production today returns ok:false
// with code "not_implemented" — the broker daemon is expected to surface
// this clearly via doctor and to NOT install augments that require this
// path until the runtime ships.
//
// When the first publisher ships, this file gains:
//   1. DCR client-registration (POST to opts.auth.dcr.dcrEndpoint)
//      with our stable client_metadata + bound publisher slug
//   2. PKCE-driven browser flow at opts.auth.audience-derived AS
//   3. Token storage with refresh-token rotation
//   4. Refresh path using stored refresh_token at the same AS
//
// Runtime implementations should bind the requested audience, publisher slug,
// and granted scopes before accepting a delegated credential.

import type {
  Provider,
  ProviderAcquireOptions,
  ProviderRefreshOptions,
  ProviderValidateOptions,
  ProviderResult,
  ProviderDescription,
} from "../auth-broker-types";
import type { StoredCredential } from "../auth-engine";

const PROVIDER_ID = "oauth-dcr";

export class OAuthDcrProvider implements Provider {
  describe(): ProviderDescription {
    return {
      id: PROVIDER_ID,
      name: "Third-party OAuth via DCR (schema-only stub)",
      authTypes: ["oauth-dcr"],
    };
  }

  async acquire(_opts: ProviderAcquireOptions): Promise<ProviderResult<StoredCredential>> {
    return {
      ok: false,
      error:
        "oauth-dcr runtime not implemented — schema accepted but acquisition is unavailable in this package version.",
      code: "not_implemented",
    };
  }

  async refresh(_opts: ProviderRefreshOptions): Promise<ProviderResult<StoredCredential>> {
    return {
      ok: false,
      error:
        "oauth-dcr runtime not implemented — schema accepted but refresh is unavailable in this package version.",
      code: "not_implemented",
    };
  }

  async validate(_opts: ProviderValidateOptions): Promise<ProviderResult<void>> {
    return {
      ok: false,
      error: "oauth-dcr runtime not implemented",
      code: "not_implemented",
    };
  }

  async invalidate(_augmentName: string): Promise<ProviderResult<void>> {
    // Local-only delete is the manager's job; nothing to revoke at the
    // upstream AS until the runtime ships.
    return { ok: true, value: undefined };
  }
}
