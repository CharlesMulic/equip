// DataStore interface — the adapter layer between equip-lib's domain logic
// and the underlying persistence mechanism.
//
// Default implementation `JsonStore` (this file) uses zero deps — just
// Node stdlib. Used by the equip CLI directly.
//
// Optional implementation `SqliteIndexedStore` (deferred follow-up
// initiative) would live in equip-app's sidecar package and layer an
// in-memory SQLite index on top of the same canonical JSON files for
// query acceleration. CLI never sees it.
//
// **Critical invariant: both adapters operate on the same canonical
// on-disk files** (`~/.equip/storage/intents.jsonl` + `content/<hash>.json`).
// Sidecar appending an intent and CLI appending an intent are both safe
// (single-line atomic appends; last-clock-wins on materialize). Reads from
// either fold the same journal.

import { appendIntent as appendIntentToJournal, readIntents, getNodeId, nextSeq } from "./intent-journal";
import { putContent, getContent, hasContent, type AugmentContent } from "./content-store";
import { resolve, listResolved, type ResolvedAugment } from "./materializer";
import type { Intent, ContentHash } from "./intent";

/**
 * The single API surface for storage. Both CLI and equip-app consume
 * augment data through this interface.
 *
 * Methods come in three flavors:
 *   - **Write**: appendIntent, putContent — the single durable mutation surface
 *   - **Read (canonical)**: getContent, readIntents — raw access for tools
 *     (doctor, restore, etc.)
 *   - **Read (resolved)**: resolve, listInstalled — the materialized view
 *     consumers actually want
 */
export interface EquipDataStore {
  // ── Write surface ─────────────────────────────────────
  /** Append an intent to the journal. Atomic. Single mutation primitive. */
  appendIntent(intent: Intent): void;

  /** Write a content blob. Returns the contentHash. Idempotent by hash. */
  putContent(blob: AugmentContent): ContentHash;

  // ── Raw read surface (for tools) ──────────────────────
  /** Read all intents in append order. */
  readIntents(): Intent[];

  /** Read a content blob by hash. Returns null if missing. */
  getContent(hash: ContentHash): AugmentContent | null;

  /** Check content blob existence without parsing. */
  hasContent(hash: ContentHash): boolean;

  // ── Resolved read surface (for consumers) ─────────────
  /** Materialize one augment by name. Returns null if no state. */
  resolve(name: string): ResolvedAugment | null;

  /** List all augments with any non-empty resolved state. */
  listResolved(): ResolvedAugment[];

  // ── Clock helpers (for callers constructing intents) ──
  /** Generate the next clock for an intent originating from this process. */
  newClock(): { ts: string; seq: number; node: string };
}

/**
 * Default JsonStore — zero-dep impl using only Node stdlib + the v2
 * sub-modules (intent-journal, content-store, materializer). This is what
 * the CLI uses.
 */
export const JsonStore: EquipDataStore = {
  appendIntent(intent: Intent): void {
    appendIntentToJournal(intent);
  },

  putContent(blob: AugmentContent): ContentHash {
    return putContent(blob);
  },

  readIntents(): Intent[] {
    return readIntents();
  },

  getContent(hash: ContentHash): AugmentContent | null {
    return getContent(hash);
  },

  hasContent(hash: ContentHash): boolean {
    return hasContent(hash);
  },

  resolve(name: string): ResolvedAugment | null {
    return resolve(name);
  },

  listResolved(): ResolvedAugment[] {
    return listResolved();
  },

  newClock() {
    return {
      ts: new Date().toISOString(),
      seq: nextSeq(),
      node: getNodeId(),
    };
  },
};
