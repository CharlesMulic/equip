# equip/ — agent guide

Cross-platform divergence (capability flags vs. strategy hooks on `PLATFORM_REGISTRY`) follows the pattern documented in [`../equip-app/planning/ADR-cross-platform-strategy-pattern.md`](../equip-app/planning/ADR-cross-platform-strategy-pattern.md). Read that ADR before adding a new capability flag, a new strategy hook, or a new platform to `src/lib/platforms.ts`.

The 1207-line `src/lib/auth-engine.ts` is direct-mode code; broker-mode abstractions live in the sibling `src/lib/auth-broker-types.ts`. Comprehensive refactor of `auth-engine.ts` is broker plan Phase 1 — out of scope for the broker MVP initiative.

## Publisher submission state — single-clearer rule (2026-04-28)

`AugmentDef.submitted*` fields (`submittedRevisionId`, `submittedStatus`, `submittedEdit`, `submittedRejectionReason`, `submittedAt`) are governed by a strict ownership contract. Closes the bug observed 2026-04-28 where backend approval never reached equip-app and publishers stayed stuck in "Pending first publish."

**Writers (two-place pattern):**
- **SETTERS** — `equip-app/sidecar/bridge.ts` `augmentPublish` and `augmentPublishUpdate`. Write `submittedRevisionId`, `submittedStatus`, `submittedEdit`, `submittedRejectionReason`, `submittedAt` at submission time.
- **CLEARER + UPDATER** — `equip-app/sidecar/bridge.ts` `reconcileSubmissionState`. The ONLY function that clears these fields or rewrites their terminal classification. Backed by the pure-logic `src/lib/submitted-draft-reconcile.ts` reconciler.

**Forbidden:** `src/lib/registry-refresh.ts` may NOT touch `def.submitted*`. Pinned by `test/registry-refresh-single-clearer.test.js`. Refresh updates registry-side fields (`registryStatus`, `registryContentHash`, etc.) only.

**Reconciler architecture:**
- Pure logic in `src/lib/submitted-draft-reconcile.ts`. No I/O. Five decision rules (no-op / approved / rejected / superseded / needs-attention) over `(local AugmentDef, server PublisherDraftView)`. **No TTL synthesis** — server is authoritative (Option B worker contract on the backend guarantees every terminal job outcome produces an observable state change).
- Bridge wraps with the HTTP fetch (`fetchPublisherDraftView`), persists via `clearSubmittedDraftState` / `writeSubmittedDraftState`, and exposes the RPC `augment.reconcileSubmissionState`.
- `augment.getDraft` calls the reconciler as a page-open lazy refresh; cg3-ui's `AugmentEditPage` polls the explicit RPC at 10s while state is non-terminal.

If you need a new writer of `def.submitted*` (rare — most publisher state changes are read-only display work), audit the contract first: is this an originating SET (publish flow) or a CLEAR (reconciliation outcome)? Anything else is almost certainly the wrong place.

See `operations/initiatives/shipped/equip-publisher-submission-loop-closure/` for the foundation work.
