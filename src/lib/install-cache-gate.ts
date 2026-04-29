// Hard-TTL cache-freshness gate for install paths (Cleanup B Pkg 02).
//
// Wires Pkg 03's `ensureCacheFresh` helper into install flows so that
// installing a stale-cache registry augment refreshes from the registry
// before applying. Closes a class of bugs where users equip an outdated
// version of an augment because the local cache hadn't expired.
//
// Behavior:
//   - Cache fresher than `EQUIP_CACHE_HARD_TTL_MS` (default 24h) → no-op,
//     install proceeds immediately.
//   - Cache older than the hard TTL → fires synchronous registry refresh,
//     blocks until refresh completes (or fails), then install proceeds.
//   - Cache missing → no-op (the caller's fetch path handles missing-cache
//     by hitting the registry API directly).
//   - Refresh failure → logged via the optional logger; install still
//     proceeds with whatever's on disk. Failures are recoverable; refusing
//     to install on a transient registry blip would be worse UX.
//
// Kill switch (Cleanup B Pkg 02 architectural commitment):
//   `EQUIP_CACHE_INSTALL_GATE_DISABLED=true` → bypass the gate entirely.
//   Falls back to pre-Cleanup-B behavior (install applies whatever the
//   local cache holds, no refresh attempt). Defaults to "gate enabled".
//
// Counter emissions (already wired in `cache-store.ts:ensureCacheFresh`):
//   `equip_cache_install_block_total{reason=hard_ttl_expired}` on every
//   gate firing; `{reason=fetch_failed}` on refresh failure.

import { ensureCacheFresh } from "./cache-store";
import { refreshAugmentFromRegistry } from "./registry-refresh";
import type { Counter } from "./telemetry";
import { type EquipLogger, NOOP_LOGGER } from "./types";

export interface InstallCacheGateOptions {
  logger?: EquipLogger;
  counter?: Counter;
}

/**
 * Block install paths on a stale cache by firing a synchronous registry
 * refresh first. Returns when the cache is fresh enough to apply, OR when
 * refresh failed (caller proceeds with stale cache rather than blocking
 * the whole install on a transient registry blip).
 *
 * Safe to call before `fetchRegistryDef` — the API + cache-fallback path
 * inside `fetchRegistryDef` is unchanged and uses whatever's freshest.
 *
 * Idempotent + cheap when cache is already fresh.
 */
export async function ensureCacheFreshForInstall(
  name: string,
  options: InstallCacheGateOptions = {},
): Promise<void> {
  const logger = options.logger ?? NOOP_LOGGER;

  // Architectural kill switch — preserves pre-Cleanup-B behavior for users
  // who hit a regression and need an emergency revert without a redeploy.
  if (process.env.EQUIP_CACHE_INSTALL_GATE_DISABLED === "true") {
    logger.debug("install.cache-gate.disabled", { name, reason: "EQUIP_CACHE_INSTALL_GATE_DISABLED" });
    return;
  }

  const result = await ensureCacheFresh(
    name,
    async (n) => { await refreshAugmentFromRegistry(n); },
    { counter: options.counter },
  );

  if (result.status === "refresh-failed") {
    logger.warn("install.cache-gate.refresh-failed", {
      name,
      error: result.error.message,
    });
  }
}
