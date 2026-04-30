// Intent types — the canonical write surface for storage.
//
// Every user-facing mutation produces exactly one Intent appended to the
// journal. Intents are immutable once written (the journal is append-only).
// Materializer folds intents into the current world state.
//
// Why a closed Intent union: structural typechecking + exhaustive switch in
// the materializer means new intent types fail loud at the type level rather
// than silently no-oping. Adding a new intent type forces consideration of
// all consumers — exactly what we want for a foundational data layer.

/**
 * Logical clock for sync ordering. Hybrid:
 * - `ts`: ISO timestamp from the originating machine (for human display)
 * - `seq`: monotonic counter local to this machine (advances on every append)
 * - `node`: stable machine identifier (placeholder until multi-device sync)
 *
 * Multi-device sync (deferred to a follow-up initiative) will compare
 * (seq, node) for total ordering within a per-augment scope. For now,
 * single-device single-writer means seq order = append order = clock order.
 */
export interface IntentClock {
  ts: string;
  seq: number;
  node: string;
}

/**
 * Reference to a content blob by its content-hash. The content-store guarantees
 * that any contentHash referenced by a committed intent has a corresponding
 * blob on disk. (GC sweeper enforces this invariant in reverse: never delete
 * a blob still referenced by a non-superseded intent.)
 */
export type ContentHash = string;

/**
 * Provenance of content. Registry-fetched content + locally-authored content
 * both land in the content store; this tag records which it was. The
 * `wrapped` variant marks an augment that was auto-discovered from an
 * existing platform-side MCP entry or skill directory and wrapped into
 * the journal so subsequent operations treat it as managed.
 */
export type ContentSource =
  | { kind: "registry"; version: number; etag?: string; fetchedAt: string }
  | { kind: "local-authored"; createdAt: string }
  | { kind: "wrapped"; fromPlatform: string; createdAt: string };

/**
 * Typed override (the "mod" allowlist). Only these three fields are
 * user-modifiable on a registry-installed augment per the security review.
 * Each field is independently optional — `null` means "explicit reset to
 * publisher version"; `undefined` means "field not modded".
 */
export interface ModOverrides {
  rules?: { content: string; version: string; marker: string } | null;
  skills?: { name: string; files: { path: string; content: string }[] }[] | null;
  hooks?: { event: string; matcher?: string; script: string; name: string }[] | null;
}

// ─── Intent variants ──────────────────────────────────────

/**
 * Per-platform install mode. Affects how the platform writer emits the
 * MCP entry — `direct` writes the upstream HTTP/stdio shape natively;
 * `broker` writes a stdio-shim invocation whose runtime is managed
 * outside equip. Default direct.
 */
export type PlatformInstallMode = "direct" | "broker";

/**
 * "User wants augment <name> installed at content <contentHash> on <platforms>."
 * If <name> previously had an InstallAugment intent, this supersedes it
 * (materializer takes the latest by clock).
 *
 * Per-platform install mode lives in `installModes` (rare per-platform
 * variation; defaults to "direct" when unset).
 */
export interface InstallAugmentIntent {
  type: "install-augment";
  clock: IntentClock;
  name: string;
  contentHash: ContentHash;
  contentSource: ContentSource;
  platforms: string[];
  /**
   * Optional per-platform install mode. Maps platformId → mode. Platforms
   * not listed default to "direct".
   */
  installModes?: Record<string, PlatformInstallMode>;
}

/**
 * "User wants augment <name> uninstalled (from all platforms or specified subset)."
 * If platforms unspecified → uninstall from all currently-installed platforms.
 */
export interface UninstallAugmentIntent {
  type: "uninstall-augment";
  clock: IntentClock;
  name: string;
  platforms?: string[];
}

/**
 * "User mods augment <name> with these overrides." Replaces any prior mod
 * intent for this augment (latest-wins). To unset a mod entirely, append a
 * ModAugmentIntent with empty overrides.
 */
export interface ModAugmentIntent {
  type: "mod-augment";
  clock: IntentClock;
  name: string;
  overrides: ModOverrides;
}

/**
 * "User wants augment <name>'s content updated to <newContentHash>." For
 * registry augments this is the result of a registry refresh. The mod
 * (if any) is preserved — it survives the content swap because mod is a
 * separate intent on the same name.
 */
export interface RefreshAugmentIntent {
  type: "refresh-augment";
  clock: IntentClock;
  name: string;
  newContentHash: ContentHash;
  contentSource: ContentSource;
}

/**
 * "User pinned augment <name> to specific content <contentHash>." Refresh
 * intents on a pinned augment no-op (pin wins). Unpinning is a separate
 * intent (or a Pin with `unpinned: true`).
 */
export interface PinAugmentIntent {
  type: "pin-augment";
  clock: IntentClock;
  name: string;
  contentHash: ContentHash | null; // null = unpin
}

export type Intent =
  | InstallAugmentIntent
  | UninstallAugmentIntent
  | ModAugmentIntent
  | RefreshAugmentIntent
  | PinAugmentIntent;

// ─── Helpers ──────────────────────────────────────────────

/**
 * Type guard for narrowing in the materializer's exhaustive switch.
 */
export function isIntent(value: unknown): value is Intent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === "string"
    && typeof v.clock === "object"
    && typeof v.name === "string";
}
