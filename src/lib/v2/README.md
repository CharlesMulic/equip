# equip lib v2 — architectural spike (intent-journal canonical)

**Status: SPIKE** (additive code; not wired into production paths). Validates the journal-canonical architecture before committing to a multi-week migration.

## Charter

Replace the current 3-store decomposition (`defs/`, `cache/`, `installs/`) with a single canonical model:

```
~/.equip/v2/
  intents.jsonl                ← append-only event journal (canonical state)
  content/<hash>.json          ← immutable content blobs (content-addressed)
  drafts/<name>.json           ← in-progress local-authored augments (mutable WIP)
  .platform-fingerprints.json  ← what we last wrote per platform path (drift detection)
```

**Read path:** `materializer.resolve(name)` folds the journal + reads referenced content blobs to produce a `ResolvedAugment` view.

**Write path:** `dataStore.appendIntent(intent)` is the single durable mutation primitive. Every user action — install, mod, refresh, uninstall, favorite, pin — is one `Intent` appended to the journal.

**Platform configs are outputs.** The materializer reads intents and writes platform configs. We *never* read platform configs as truth — only fingerprint them to detect external drift.

## Why this exists

Read `c:\dev\CG3\operations\initiatives\equip-dual-write-retirement\DECISION-RECORD-schema-v4-cutover.md` for context.

In short: a 4-agent first-principles review (systems-architect, postgres-dba, elon-mode, blank-slate greenfield) all converged that the in-flight 3-store decomposition cuts along the wrong axis. The right axis is **mutability**: immutable content blobs + append-only intents + derived materialized views. This eliminates entire bug classes (stale cache, source-of-truth confusion, cross-write atomicity, reconciler complexity) by construction rather than discipline.

## Design constraints

- **Zero deps in equip CLI.** Default `JsonStore` impl uses only Node stdlib (fs, path, crypto for hashing). SQLite acceleration lives optionally in equip-app sidecar via the `DataStore` adapter interface.
- **Atomic writes via single-line append.** Intents fit in ≤4KB → POSIX `O_APPEND` is atomic for them. Content blob writes use temp+rename.
- **Multi-writer safe.** Both CLI and app sidecar can append intents concurrently without coordination — last-line-wins per timestamp/clock for any subsequent fold.

## Spike acceptance criteria

The spike is validated when these three end-to-end test files all pass:

1. `test/v2/spike-install-flow.test.js` — install one augment from a mock registry to a mock platform; verify journal + content + materialized view + platform fingerprint all consistent
2. `test/v2/spike-mod-and-refresh.test.js` — install + mod + refresh flow; verify mod survives refresh; verify content blob for new version is fetched + stored separately; verify materialized rules = mod (not refreshed content's rules)
3. `test/v2/spike-multi-augment.test.js` — install 5, mod 2, refresh 1, uninstall 1; verify all materialized states are correct independently

If all three pass cleanly, the design is validated and the next step is filing the new initiative brief covering the multi-phase migration:
- Phase 1: equip lib consumers migrate from old stores to `DataStore`
- Phase 2: equip-app bridge migrates to consume `DataStore`
- Phase 3: equip-app sidecar opt-in adds `SqliteIndexedStore` accelerator
- Phase 4: delete old store modules + dual-write-mirror + repurpose cleanup-B helpers for new format migration

If the spike reveals problems, we've lost ~3-5 days but learned why the journal model doesn't work for our requirements. Main is in a known-good state either way.

## What's NOT in the spike

- Real registry HTTP fetching (uses a `MockRegistry` for tests)
- Platform-specific config file writers (uses a `MockPlatform` for tests)
- The `SqliteIndexedStore` accelerator (deferred to Phase 3 of the post-spike migration)
- Snapshotting / journal compaction (deferred until needed for scale)
- Actual migration from current 3-store format (the new initiative covers it)
- Wiring into the existing `commands/install.ts`, `registry-refresh.ts`, bridge handlers (Phase 1 of post-spike migration)

## File map

```
src/lib/v2/
  README.md             ← this file
  intent.ts             ← Intent type definitions (Install, Mod, Refresh, Uninstall, etc.)
  content-store.ts      ← content-addressed blob CRUD
  intent-journal.ts     ← append-only JSONL journal
  materializer.ts       ← intents + content → ResolvedAugment view
  datastore.ts          ← DataStore interface + JsonStore default impl
  mock-registry.ts      ← test helper: stub registry that returns predefined content
  mock-platform.ts      ← test helper: stub platform writer

test/v2/
  spike-install-flow.test.js
  spike-mod-and-refresh.test.js
  spike-multi-augment.test.js
```
