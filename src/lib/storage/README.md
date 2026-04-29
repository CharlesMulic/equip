# equip lib `storage/` — journal-canonical augment storage

The single canonical storage layer for equip-lib. All reads + writes for augment state go through this module.

## Architecture

```
~/.equip/storage/
  intents.jsonl                ← append-only event journal (canonical state)
  content/<contentHash>.json   ← immutable content blobs (content-addressed)
```

**Read path:** `JsonStore.resolve(name)` folds the journal + reads referenced content blobs to produce a `ResolvedAugment` view. The single read primitive — every consumer goes through it.

**Write path:** `JsonStore.appendIntent(intent)` is the single durable mutation primitive. Every user-facing action — install, mod, refresh, uninstall, pin — is one `Intent` appended to the journal.

**Platform configs are outputs.** Code outside this module (sidecar materializer, CLI install path) reads `JsonStore.resolve()` and writes platform configs based on the result. We never read platform configs back as truth — only fingerprint them to detect external drift.

## Why this design

Designed in the [`equip-storage-redesign`](../../../../operations/initiatives/equip-storage-redesign/) initiative, validated by a 4-agent first-principles spike that converged on intent-journal canonical with content-addressed blobs as the right axis (mutability) for decomposing storage. See the initiative's `BRIEF.md` + `work/00-architectural-review.md` for the full reasoning trail.

**Bug classes eliminated by construction:**
- Stale cache (journal IS the truth; no derived state to be stale)
- Source-of-truth confusion (one canonical surface)
- Cross-write atomicity (single-line append per mutation; ≤4KB)
- Reconciler complexity (one-direction materialization; nothing to reconcile)
- Wire-shape coupling (consumers bind to `ResolvedAugment` view; storage shape independent)
- Field-routing decisions (one content bucket; one mod overrides bucket per intent)

## Module map

| File | Purpose |
|---|---|
| `datastore.ts` | `EquipDataStore` interface + `JsonStore` default impl (zero deps) |
| `intent.ts` | Closed `Intent` union (Install/Uninstall/Mod/Refresh/Pin) + clock + types |
| `intent-journal.ts` | Append-only JSONL journal CRUD |
| `content-store.ts` | Content-addressed blob CRUD (SHA-256 hex keys, canonical JSON) |
| `materializer.ts` | THE single read path; folds journal + content into `ResolvedAugment` |
| `mock-registry.ts` | Test helper — stub registry returning predefined content per (name, version) |
| `mock-platform.ts` | Test helper — stub platform writer + drift fingerprinting |

## Adapter pattern

`EquipDataStore` is an interface. The default impl `JsonStore` (in `datastore.ts`) uses only Node stdlib — required for the equip CLI's zero-dep constraint.

A future opt-in `SqliteIndexedStore` (deferred follow-up) would live in `equip-app/sidecar/`, layer an in-memory SQLite index on top of the same canonical files for query acceleration. Both adapters operate on the same on-disk format; the choice is per-process.

## Usage

```ts
import { JsonStore } from "./storage/datastore";

// Read: materialize one augment by name
const resolved = JsonStore.resolve("demo-tool");

// Write: append an intent
JsonStore.appendIntent({
  type: "install-augment",
  clock: JsonStore.newClock(),
  name: "demo-tool",
  contentHash: JsonStore.putContent(content),
  contentSource: { kind: "registry", version: 1, etag: "...", fetchedAt: now },
  platforms: ["claude-code"],
});

// List all augments with any non-empty resolved state
const all = JsonStore.listResolved();
```

## What's NOT in this module

- Real registry HTTP fetching (lives in `../registry.ts`; this module accepts pre-fetched content)
- Platform-specific config writers (live in `../platforms.ts` + per-platform modules; this module produces `ResolvedAugment`, downstream code translates)
- HTTP cache (the registry layer uses fetch's `Cache-Control` + `ETag` directly)
- Migration from prior on-disk formats (lives in `migrate-from-legacy.ts` — same dir, separate concern, added in Phase A's A2 step)
