# equip/ — agent guide

Cross-platform divergence (capability flags vs. strategy hooks on `PLATFORM_REGISTRY`) follows the pattern documented in [`../equip-app/planning/ADR-cross-platform-strategy-pattern.md`](../equip-app/planning/ADR-cross-platform-strategy-pattern.md). Read that ADR before adding a new capability flag, a new strategy hook, or a new platform to `src/lib/platforms.ts`.

The 1207-line `src/lib/auth-engine.ts` is direct-mode code; broker-mode abstractions live in the sibling `src/lib/auth-broker-types.ts`. Comprehensive refactor of `auth-engine.ts` is broker plan Phase 1 — out of scope for the broker MVP initiative.
