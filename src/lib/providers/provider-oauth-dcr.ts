// OAuthDcrProvider — third-party MCP servers with their own authorization
// server (Path C in the BRIEF). The augment-def declares its publisher's
// AS metadata; broker handles Dynamic Client Registration (RFC 7591),
// auth-code + PKCE browser flow at the publisher's AS, and refresh.
//
// **Schema-only stub for mcp-resource-server-cutover Pkg 03.**
//
// The runtime implementation is deferred until a real third-party-with-own-
// AS publisher integrates (ENG-0019 / first-publisher onboarding). The
// schema shape (`auth.type === "oauth-dcr"` is accepted by the
// augment-def parser) lands now so the database migration at Pkg 05 can
// rewrite legacy `auth_to_api_key` rows into the uniform shape without
// per-row schema mismatches.
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
// All gated by tri-binding on the backend (audience-host ∈ publisher's
// verified_domains; pub:<slug>/<scope> slug must match the resolved
// publisher).

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
        "oauth-dcr runtime not implemented — schema accepted but acquisition deferred to first third-party-with-own-AS publisher integration (ENG-0019).",
      code: "not_implemented",
    };
  }

  async refresh(_opts: ProviderRefreshOptions): Promise<ProviderResult<StoredCredential>> {
    return {
      ok: false,
      error:
        "oauth-dcr runtime not implemented — schema accepted but refresh deferred to first third-party-with-own-AS publisher integration (ENG-0019).",
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
