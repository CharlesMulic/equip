# equip/ — agent guide

Cross-platform divergence (capability flags vs. strategy hooks on `PLATFORM_REGISTRY`) follows the pattern documented in [`../equip-app/planning/ADR-cross-platform-strategy-pattern.md`](../equip-app/planning/ADR-cross-platform-strategy-pattern.md). Read that ADR before adding a new capability flag, a new strategy hook, or a new platform to `src/lib/platforms.ts`.

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
