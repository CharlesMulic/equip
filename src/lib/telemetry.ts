// Counter port for broker-mode telemetry.
//
// Boundary discipline:
//   - This file owns the *contract* (counter names + valid label keys).
//   - Counter storage is whoever wires the port. Standalone CLI gets
//     `noopCounter` (no telemetry). Other callers can pass their own
//     implementation through the install/apply opts.
//   - Emit sites are inside this lib only; callers supply any collection.
//
// Why a port and not an exported counter object: equip lib has no
// awareness of who collects metrics. The port is the ergonomic mirror
// of the existing EquipLogger pattern.

/**
 * Bump a named counter by 1, optionally tagged with labels.
 *
 * Implementations MUST tolerate unknown counter names (treat as no-op or
 * register on first emit) and labels (record as-is). The contract caller
 * sees is "fire and forget" — no return value, no exceptions.
 */
export type Counter = (name: string, labels?: Record<string, string>) => void;

/**
 * No-op default. Equivalent to NOOP_LOGGER for the logging surface; used by
 * standalone equip CLI invocations and any other context where counters
 * have no destination.
 */
export const noopCounter: Counter = () => { /* no-op */ };

/**
 * Stable contract: counter names + their valid label keys + valid label
 * values. Consumers reference these constants to keep emit sites aligned
 * with the broker-side store and the future Prometheus exposition layer.
 *
 * **Cardinality discipline**: every label is a closed enum. No free-form
 * strings. The architect's load-bearing rule: tests assert only known
 * label values appear in snapshots. Adding a new value = explicit edit
 * here = explicit code review.
 */
export const COUNTER_NAMES = {
  /** Broker daemon refresh attempts. Emitted from credential-manager.ts. */
  BROKER_REFRESH_TOTAL: "equip_broker_refresh_total",
  /** Broker IPC server requests, by method. Emitted from ipc-server.ts. */
  BROKER_REQUEST_TOTAL: "equip_broker_request_total",
  /** Equip MCP installs, by mode + platform. Emitted from install.ts via the port. */
  INSTALL_MODE_TOTAL: "equip_install_mode_total",
  /** Cache-store reads, by freshness outcome. Emitted from cache-store.ts. */
  CACHE_READ_TOTAL: "equip_cache_read_total",
  /** Cache refresh outcomes (200/304/error). Emitted from the registry cache refresh path. */
  CACHE_REFRESH_TOTAL: "equip_cache_refresh_total",
  /** Install-time hard-TTL block events. Emitted from cache-store.ts ensureCacheFresh. */
  CACHE_INSTALL_BLOCK_TOTAL: "equip_cache_install_block_total",
} as const;

/** Valid label values per counter — closed enums, no free-form strings. */
export const COUNTER_LABELS = {
  [COUNTER_NAMES.BROKER_REFRESH_TOTAL]: {
    result: ["success", "failed", "invalid_grant"] as const,
  },
  [COUNTER_NAMES.BROKER_REQUEST_TOTAL]: {
    path: ["getStatus", "getCredential", "triggerRefresh", "listManagedAugments"] as const,
  },
  [COUNTER_NAMES.INSTALL_MODE_TOTAL]: {
    mode: ["direct", "broker"] as const,
    // platform values are the platform IDs in PLATFORM_REGISTRY; not enumerated
    // here because the registry is the source of truth and grows additively.
    // Tests assert against the registry's keys, not a hardcoded list.
  },
  [COUNTER_NAMES.CACHE_READ_TOTAL]: {
    result: ["hit", "miss", "stale_revalidating"] as const,
  },
  [COUNTER_NAMES.CACHE_REFRESH_TOTAL]: {
    // 200=content updated; 304=not modified (etag round-trip succeeded);
    // error=network or service failure during refresh.
    result: ["200", "304", "error"] as const,
  },
  [COUNTER_NAMES.CACHE_INSTALL_BLOCK_TOTAL]: {
    reason: ["hard_ttl_expired", "fetch_failed"] as const,
  },
} as const;
