// Materializer — folds intents + content blobs into the resolved view.
//
// This is the single read path for v2. Every consumer that wants to know
// "what's the current state of augment X" calls `resolve(name)`. The
// materializer:
//   1. Reads all intents for that augment from the journal
//   2. Folds them by clock order into per-augment state
//   3. Looks up the referenced content blob
//   4. Applies any active mod overrides
//   5. Returns a `ResolvedAugment` view
//
// Pure-ish: no writes; no side effects beyond filesystem reads. Stateless —
// can be called concurrently. The materializer doesn't cache; production
// would memoize per-name with invalidation on append, or use the
// SqliteIndexedStore accelerator.
//
// **The fold rules** (the heart of the architecture):
//   - InstallAugment supersedes prior InstallAugment for same name
//   - RefreshAugment swaps the contentHash but preserves all other state
//   - ModAugment supersedes prior ModAugment for same name
//   - PinAugment holds; subsequent RefreshAugment intents on a pinned augment
//     no-op when materializing
//   - UninstallAugment clears install state but preserves mod (in case user
//     reinstalls — mod follows the augment by name)
//
// **The composition rule** (mod over content):
//   - For each modded field (rules/skills/hooks): mod's value if present,
//     else content's value
//   - All other content fields (transport, serverUrl, title, etc.) come
//     from the content blob unchanged
//   - This means a refresh that changes serverUrl picks up the new value;
//     a refresh that changes rules has its rules overridden by an active mod

import { readIntentsFor } from "./intent-journal";
import { getContent, type AugmentContent } from "./content-store";
import type {
  Intent,
  ContentHash,
  ContentSource,
  ModOverrides,
} from "./intent";

/**
 * The materialized view of an augment. Single shape across all provenances —
 * no "kind" discriminator, no per-source field-name variations. Consumers
 * (UI, install machinery, doctor, etc.) read this.
 */
export interface ResolvedAugment {
  name: string;

  // ── Effective content (mod-composed) ──
  title: string;
  description: string;
  transport?: "http" | "stdio";
  serverUrl?: string;
  stdio?: { command: string; args: string[] };
  requiresAuth: boolean;
  rules?: { content: string; version: string; marker: string };
  skills: { name: string; files: { path: string; content: string }[] }[];
  hooks: { type: string; command: string }[];

  // ── Provenance ──
  contentHash: ContentHash;
  contentSource: ContentSource;
  /** True iff a non-empty mod is currently applied. */
  modded: boolean;
  /** What fields the mod actually overrides (empty if not modded). */
  moddedFields: ("rules" | "skills" | "hooks")[];

  // ── Install state ──
  installed: boolean;
  installedPlatforms: string[];

  // ── Pin state ──
  pinnedTo: ContentHash | null;
}

/**
 * Internal per-augment fold state. Built up by replaying intents in order.
 */
interface FoldState {
  name: string;
  contentHash: ContentHash | null;
  contentSource: ContentSource | null;
  installedPlatforms: string[];
  installed: boolean;
  mod: ModOverrides | null;
  pinnedTo: ContentHash | null;
}

/**
 * Resolve a single augment by name. Returns null if no intents exist for it
 * OR if the resolved state has no content (e.g., uninstalled before any
 * install ever landed).
 */
export function resolve(name: string): ResolvedAugment | null {
  const intents = readIntentsFor(name);
  if (intents.length === 0) return null;
  return resolveFromIntents(name, intents);
}

/**
 * Internal — fold pre-fetched intents into a ResolvedAugment. Exposed for
 * tests + the SqliteIndexedStore (Phase 3) which provides its own intent
 * stream.
 */
export function resolveFromIntents(
  name: string,
  intents: Intent[],
): ResolvedAugment | null {
  // Sort by clock seq to get a deterministic fold order. (For single-writer
  // append order = seq order, but defensive sort handles future multi-writer.)
  const ordered = [...intents].sort((a, b) => a.clock.seq - b.clock.seq);

  const state: FoldState = {
    name,
    contentHash: null,
    contentSource: null,
    installedPlatforms: [],
    installed: false,
    mod: null,
    pinnedTo: null,
  };

  for (const intent of ordered) {
    foldIntent(state, intent);
  }

  // No content ever assigned — the augment was never installed (or all
  // install intents preceded an uninstall + no content reference survives).
  if (!state.contentHash || !state.contentSource) return null;

  const content = getContent(state.contentHash);
  if (!content) {
    // Content blob missing — could indicate GC ran prematurely or a journal
    // referencing a deleted blob. Defensive: surface as null + log.
    // eslint-disable-next-line no-console
    console.warn(`[equip v2 materializer] content blob missing for ${name} (hash=${state.contentHash})`);
    return null;
  }

  return composeView(state, content);
}

function foldIntent(state: FoldState, intent: Intent): void {
  switch (intent.type) {
    case "install-augment":
      // Install intent is the canonical "this augment is now active with
      // this content on these platforms" — supersedes prior install.
      // PinAugment can override the contentHash though: if pinned, subsequent
      // installs that aren't to the pin no-op the contentHash swap.
      if (state.pinnedTo === null || state.pinnedTo === intent.contentHash) {
        state.contentHash = intent.contentHash;
        state.contentSource = intent.contentSource;
      }
      state.installed = true;
      state.installedPlatforms = [...intent.platforms];
      return;

    case "uninstall-augment":
      // Uninstall preserves contentHash + mod (so reinstall reuses prior
      // state) but flips installed=false and clears platforms (or removes
      // the specified subset).
      if (intent.platforms === undefined) {
        state.installed = false;
        state.installedPlatforms = [];
      } else {
        const removed = new Set(intent.platforms);
        state.installedPlatforms = state.installedPlatforms.filter((p) => !removed.has(p));
        state.installed = state.installedPlatforms.length > 0;
      }
      return;

    case "mod-augment":
      // Mod supersedes prior mod. To clear a mod entirely, append a
      // ModAugmentIntent with all overrides explicitly null.
      state.mod = intent.overrides;
      return;

    case "refresh-augment":
      // Refresh swaps the content reference. Pinned augments ignore refresh.
      if (state.pinnedTo === null) {
        state.contentHash = intent.newContentHash;
        state.contentSource = intent.contentSource;
      }
      return;

    case "pin-augment":
      // Pin sets or clears the pin. Setting pin doesn't change the current
      // contentHash (the install/refresh that established it was the actor);
      // pinning just freezes future swaps.
      state.pinnedTo = intent.contentHash;
      return;

    default: {
      // Exhaustive check — TypeScript will complain at compile time if a new
      // Intent variant is added without a handler here. This is the primary
      // reason the Intent union is closed.
      const _exhaust: never = intent;
      void _exhaust;
      return;
    }
  }
}

function composeView(state: FoldState, content: AugmentContent): ResolvedAugment {
  const mod = state.mod;
  const moddedFields: ("rules" | "skills" | "hooks")[] = [];

  // For each typed-allowlist field: mod wins if present (including explicit
  // null which means "explicit reset to publisher version" — for the spike,
  // null collapses to "use content"; production may differ).
  const rules = mod?.rules !== undefined
    ? (mod.rules ?? content.rules)
    : content.rules;
  if (mod?.rules !== undefined && mod.rules !== null) moddedFields.push("rules");

  const skills = mod?.skills !== undefined
    ? (mod.skills ?? (content.skills ?? []))
    : (content.skills ?? []);
  if (mod?.skills !== undefined && mod.skills !== null) moddedFields.push("skills");

  const hooks = mod?.hooks !== undefined
    ? (mod.hooks ?? (content.hooks ?? []))
    : (content.hooks ?? []);
  if (mod?.hooks !== undefined && mod.hooks !== null) moddedFields.push("hooks");

  return {
    name: state.name,
    title: content.title,
    description: content.description,
    transport: content.transport,
    serverUrl: content.serverUrl,
    stdio: content.stdio,
    requiresAuth: content.requiresAuth ?? false,
    rules,
    skills,
    hooks,
    contentHash: state.contentHash!,
    contentSource: state.contentSource!,
    modded: moddedFields.length > 0,
    moddedFields,
    installed: state.installed,
    installedPlatforms: [...state.installedPlatforms],
    pinnedTo: state.pinnedTo,
  };
}

/**
 * List all augments with any non-empty resolved state. Useful for the UI
 * library view + the doctor's "what's installed" check.
 *
 * Implementation reads the full journal, groups by name, and resolves each
 * group. Spike-grade — production needs an index.
 */
export function listResolved(): ResolvedAugment[] {
  // Inline a one-time full-journal read; group by name; resolve each.
  // (Mirror of resolve() but batched.)
  const allIntents = require("./intent-journal").readIntents() as Intent[];
  const byName = new Map<string, Intent[]>();
  for (const intent of allIntents) {
    const existing = byName.get(intent.name);
    if (existing) existing.push(intent);
    else byName.set(intent.name, [intent]);
  }
  const out: ResolvedAugment[] = [];
  for (const [name, intents] of byName) {
    const resolved = resolveFromIntents(name, intents);
    if (resolved) out.push(resolved);
  }
  return out;
}
