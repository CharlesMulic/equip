// DataStore — single seam between equip's domain logic and the
// canonical on-disk format (`~/.equip/storage/intents.jsonl` + content
// blobs at `storage/content/<hash>.json`).
//
// Zero npm deps. Single shipped impl: `JsonStore`. The interface exists
// for one reason — testability (mockable in unit tests). Anything beyond
// JsonStore is out of scope for this module.
//
// Concurrency: writes are single-line atomic appends (POSIX O_APPEND for
// ≤4KB intents); reads fold the journal in clock order.

import { appendIntent as appendIntentToJournal, readIntents, getNodeId, nextSeq } from "./intent-journal";
import { putContent, getContent, hasContent, type AugmentContent } from "./content-store";
import { resolve, listResolved, type ResolvedAugment } from "./materializer";
import type { Intent, ContentHash } from "./intent";

/**
 * The single storage API. Three flavors of method:
 *   - **Write**: `appendIntent`, `putContent` — the only durable mutation surface
 *   - **Read (canonical)**: `getContent`, `readIntents` — raw access for tools
 *     (doctor, restore, etc.)
 *   - **Read (resolved)**: `resolve`, `listResolved` — the materialized view
 *     domain code actually wants
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
 * JsonStore — the shipped implementation. Zero deps; composes the
 * intent-journal, content-store, and materializer sub-modules.
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
