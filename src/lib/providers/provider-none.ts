// NoneProvider — for augments that declare auth.type="none".
//
// Trivial passthrough: acquire returns a placeholder credential, refresh
// is a no-op, validate always succeeds, invalidate always succeeds.
// Exists so the Provider dispatch path can handle `auth.type="none"`
// uniformly without a special case in the registry lookup or daemon
// glue code.

import type {
  Provider,
  ProviderAcquireOptions,
  ProviderRefreshOptions,
  ProviderValidateOptions,
  ProviderResult,
  ProviderDescription,
} from "../auth-broker-types";
import type { StoredCredential } from "../auth-engine";

const PROVIDER_ID = "none";

export class NoneProvider implements Provider {
  describe(): ProviderDescription {
    return {
      id: PROVIDER_ID,
      name: "No-auth Provider",
      authTypes: ["none"],
    };
  }

  async acquire(opts: ProviderAcquireOptions): Promise<ProviderResult<StoredCredential>> {
    const now = new Date().toISOString();
    return {
      ok: true,
      value: {
        authType: "none",
        credential: "",
        toolName: opts.augmentName,
        storedAt: now,
        updatedAt: now,
      },
    };
  }

  async refresh(opts: ProviderRefreshOptions): Promise<ProviderResult<StoredCredential>> {
    // No refresh semantics; return current as-is with bumped updatedAt.
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
}
