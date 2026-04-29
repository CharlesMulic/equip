# equip/ — agent guide

Cross-platform divergence (capability flags vs. strategy hooks on `PLATFORM_REGISTRY`) follows the pattern documented in [`../equip-app/planning/ADR-cross-platform-strategy-pattern.md`](../equip-app/planning/ADR-cross-platform-strategy-pattern.md). Read that ADR before adding a new capability flag, a new strategy hook, or a new platform to `src/lib/platforms.ts`.

## Write API for the three new stores (Cleanup B)

`equip/src/lib/store-writers.ts` is the **only sanctioned production write surface** for `~/.equip/defs/<name>.json` + `~/.equip/cache/<name>.json` + `~/.equip/installs/<name>.json`. All consumers go through it (or through the higher-level orchestrators in `store-orchestrator.ts`).

- **Per-store free functions:** `writeDef`, `writeCache`, `writeInstall`, `deleteDef`, `deleteCache`, `deleteInstall`. Atomic per-file writes. Wrap with `acquireLock` (process-wide L3 lock from `fs.ts`, re-entrant within same process).
- **Read-modify-write helpers:** `mutateDef(name, fn)`, `mutateCache(name, fn)`, `mutateInstall(name, fn)`. Read current → apply mutator → write back. Throw if the mutator changes `name` or `kind` (identity is immutable).
- **Cross-store orchestrators** (in `store-orchestrator.ts`): encapsulate ordered sequences across multiple stores. Initial: `retractRegistryAugment(name, options)`. Future: `promoteWrappedToLocal`, `applyInstall`, `removeInstall`. Architect's ordering rule (2026-04-29): **side effects → derived state → durable marker last**.
- **Single-writer rule:** the underlying `defs-store.ts` / `cache-store.ts` / `installs-store.ts` per-store write methods are called ONLY from `store-writers.ts` / `store-orchestrator.ts` / `dual-write-mirror.ts` / `migrate-storage.ts`. Pinned by `test/storage-store-writer-scope.test.js` (CI-grep, becomes belt-and-suspenders post-Cleanup-B).

If you need a new write site: use `mutateDef(name, fn)` for in-place field changes; `writeDef(def)` for full-shape writes (e.g., creating a new local def); a new orchestrator function in `store-orchestrator.ts` for cross-store sequences. Never call `defs-store.writeDef` etc. directly from production code.

Decision record: `operations/initiatives/equip-dual-write-retirement/work/01-spike-resolver-write-api.md`.

## Cache freshness on install paths (Cleanup B Pkg 02)

Install entry points (`equip-app/sidecar/bridge.ts:equipAugment`, `equip/src/cli/equip.ts:runInstall` + alias path) gate on cache freshness via `ensureCacheFreshForInstall(name, { logger? })` from `src/lib/install-cache-gate.ts`. Stale cache (>`EQUIP_CACHE_HARD_TTL_MS`, default 24h) triggers a synchronous `refreshAugmentFromRegistry` before the install proceeds. Bypassable via `EQUIP_CACHE_INSTALL_GATE_DISABLED=true` (kill switch, one-release-cycle escape).

The 1207-line `src/lib/auth-engine.ts` is direct-mode code; broker-mode abstractions live in the sibling `src/lib/auth-broker-types.ts`. Comprehensive refactor of `auth-engine.ts` is broker plan Phase 1 — out of scope for the broker MVP initiative.

## Publisher submission state — server-side authoritative

Publisher draft + submission state lives **server-side only** in `equip_publisher_drafts` (queryable via `PublisherDraftService.getDraft`). The local `AugmentDef` carries no draft fields — no `workingDraftEdit`, no `submittedEdit`, no `submitted*` of any kind.

**Writers:**
- `equip-app/sidecar/bridge.ts` `augmentSaveDraft` → PUT `/equip/augments/{name}/draft`
- `equip-app/sidecar/bridge.ts` `augmentDiscardDraft` → DELETE `/equip/augments/{name}/draft`
- `equip-app/sidecar/bridge.ts` `augmentPublish` / `augmentPublishUpdate` → backend's publish endpoint auto-calls `discardDraft` and records `pendingVersionId` on the augment row
- Backend `LlmReviewHandler` + `ReviewSweeper` transition the version row's `review_status` per the Option B worker contract

**Reads:**
- `equip-app/sidecar/bridge.ts` `augmentGetDraft` → GET `/equip/augments/{name}/draft`, returns the server's view verbatim
- cg3-ui's `AugmentEditPage` polls `api.getDraft` every 10s while state is non-terminal and re-derives `publishingStatus` from the response

**Forbidden:** `src/lib/registry-refresh.ts` may NOT touch publisher state. Refresh updates registry-side fields (`registryStatus`, `registryContentHash`, etc.) only.

**History:** Pre-Pkg-04 of the equip-storage-refactor initiative, publisher state mirrored locally on `~/.equip/augments/<name>.json` via a five-rule reconciler (`submitted-draft-reconcile.ts`). The reconciler + the local mirror were retired in the cleanup commit because they were a redundant cache layer over server-authoritative state. See `operations/initiatives/shipped/equip-publisher-submission-loop-closure/` for the foundation work and `operations/initiatives/shipped/equip-storage-refactor/` for the retirement.
