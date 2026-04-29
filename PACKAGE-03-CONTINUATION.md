# Package 03 Continuation Guide — equip-lib migration to resolver

This file lives on the `feat/dual-write-retirement` branch. Read it before resuming Package 03 (lib migration) work.

## Status (updated 2026-04-29 — case-by-case migration done)

**9 pure-read sites migrated** across 8 files. **20 read-modify-write sites deferred to Package 06** (when legacy modules are deleted entirely + the migration is forced + well-bounded).

Migration commits on `feat/dual-write-retirement`:
- `35b8361` — 7 pure-read sites (skills.ts, mcp.ts, reconcile.ts × 2, migrate.ts, update.ts, doctor.ts)
- `d5d88ff` — 2 pure-read sites (platform-state.ts, install.ts:321 platform-list lookup)
- `f4cd7aa` — 8-test safety net pinning the dual-write mirror's registry-state-field routing (protects the deferred RMW sites)

Tests at this point: 854 pass / 0 fail / 2 skipped on equip suite.

**Remaining 20 sites (all RMW-coupled, deferred to Package 06):**
- `src/lib/registry-refresh.ts` — 16 sites in `refreshAugmentFromRegistry` + `applyRegistryRetraction`. Each function reads the legacy `existingDef`, mutates several fields (mix of sovereign + registry-cached), then writes back. Splitting reads alone forces awkward read-twice patterns; splitting writes requires careful per-field routing between defs/cache stores. The dual-write mirror's `legacyRegistryToCache` correctly routes registry-tracking field mutations into the new cache/ store (verified by `test/dual-write-registry-state-routing.test.js`), so deferring these sites until Package 06 is safe.
- `src/lib/commands/install.ts` — 4 sites (lines 251 + 260 = baseWeight/loadedWeight RMW; lines 308 + 313 = `writeAugmentDefAndApply` boundary which writes def + immediately re-reads). Same RMW-coupling rationale.

## Original handoff content (from 2026-04-29 earlier overnight run) follows ─────

**Done:**
- `Phase A` (plan polish + ENG-0063 ledger + test-isolation prepass) — landed to `main`
- `Phase B` Spike Package 01 (resolver write-API design + prototype) — landed to `main`. New modules: `src/lib/store-writers.ts`, `src/lib/store-orchestrator.ts`. Prototype migrated `applyRegistryRetraction`'s NEW-store side from `mirrorRetractFromRegistry` → `retractRegistryAugment`. Single-writer scope test extended.
- `Phase C` Package 02 (cache-freshness wiring) — landed to `main`. New module `src/lib/install-cache-gate.ts`; wired into bridge equipAugment + 2 CLI install entry points; `EQUIP_CACHE_INSTALL_GATE_DISABLED` kill switch.
- `feat/dual-write-retirement` branch created (this commit) — ready for Package 03 incremental migration commits.

**Not done (Package 03 scope):**
- ~60 call sites across `equip/src/lib/` + `equip/src/cli/` still use legacy `readAugmentDef` / `writeAugmentDef` / `readInstallations` / `writeInstallations`
- ENG-0044 + ENG-0030 audit-as-side-effect work
- All Packages 04-06 (bridge migration, test migration, final retirement)

## Migration pattern (WORKED EXAMPLE: applyRegistryRetraction's NEW-store side, already shipped in spike)

The spike already migrated ONE site as a working pattern. See `equip/src/lib/registry-refresh.ts:applyRegistryRetraction` after the spike commit (`fafe1b8`):

```ts
// BEFORE (calls dual-write mirror directly):
const retractionAction = mirrorRetractFromRegistry(name, now);

// AFTER (uses store-orchestrator):
const retractionAction = await retractRegistryAugment(name, { retractedAt: now });
```

This is the cleanest case: replace a mirror call with an orchestrator call. The legacy `writeAugmentDef(existingDef)` and `writeInstallations(installations)` calls in the same function STAY — they're the "during-window" dual-write that keeps legacy files in sync until Package 06.

## Migration patterns by call shape

The 60 sites break down by shape. Each shape has a defined migration recipe:

### Pattern 1 — Pure-existence read (`readAugmentDef(name) != null`)

Most common in early-return checks like `if (!readAugmentDef(name)) throw new Error(...)`.

```ts
// BEFORE:
const def = readAugmentDef(name);
if (!def) throw new Error(`...`);

// AFTER:
const aug = augmentResolver.resolve(name);
if (!aug) throw new Error(`...`);
// (may still need readAugmentDef for fields not on ResolvedAugment — see Pattern 4)
```

**Trapdoor:** `ResolvedAugment` doesn't expose every field of `AugmentDef`. If the consumer also reads `def.workingDraftEdit` or other Pkg-04-Cleanup-A-removed fields, those are GONE in the new architecture (publisher state is server-side). Audit each site.

### Pattern 2 — Read-mutate-write of sovereign fields

```ts
// BEFORE:
const def = readAugmentDef(name);
def.lastUserActionAt = now;
def.someLocalField = newValue;
writeAugmentDef(def);

// AFTER:
mutateDef(name, def => {
  def.lastUserActionAt = now;
  def.someLocalField = newValue;
});
```

`mutateDef` is in `src/lib/store-writers.ts`. It throws if the mutator changes `name` or `kind` (identity is immutable).

**Trapdoor:** the LEGACY writeAugmentDef triggered the dual-write mirror, which routed registry-source defs to BOTH cache + (overlay if modded). The new `mutateDef` only writes the specific def kind — it doesn't fan out. If the legacy code was relying on the mirror's fan-out behavior (e.g., updating registryStatus on a registry-source def, which the mirror routed to the cache store), the new code needs to call `mutateCache` instead OR alongside.

### Pattern 3 — Read-mutate-write of registry-cached fields

```ts
// BEFORE:
const def = readAugmentDef(name);
def.registryStatus = "active";
def.registryContentHash = newHash;
def.lastValidatedAt = now;
writeAugmentDef(def);
// ↑ The mirror routes this to ~/.equip/cache/<name>.json because source=registry

// AFTER:
mutateCache(name, c => {
  c.registryStatus = "active";
  c.contentHash = newHash;
  c.fetchedAt = now;
});
```

**Field name remapping (legacy → new cache):**
- `def.registryStatus` → `cached.registryStatus`
- `def.registryContentHash` → `cached.contentHash`
- `def.registryEtag` → `cached.etag`
- `def.registryVersionNumber` → `cached.version`
- `def.lastValidatedAt` → `cached.fetchedAt`
- `def.registryLatestContentHash` → `cached.registryLatestContentHash`
- `def.registryLatestSecurityAdvisory` → `cached.registryLatestSecurityAdvisory`

This is the trickiest pattern — get the field routing wrong and you've broken the cache freshness logic. Run `equip/test/registry-refresh.test.js` after every site migration to catch regressions.

### Pattern 4 — Mixed sovereign + registry-cached field write

```ts
// BEFORE (mixes def fields + cache fields in one write):
const def = readAugmentDef(name);
def.title = newTitle;            // sovereign-ish (def.title is the content)
def.registryStatus = "active";   // cache-side (registry-state)
def.registryContentHash = hash;  // cache-side
writeAugmentDef(def);

// AFTER (split routing):
mutateDef(name, d => { d.title = newTitle; });
mutateCache(name, c => {
  c.registryStatus = "active";
  c.contentHash = hash;
});
```

**Trapdoor:** ordering matters during the migration window. The dual-write mirror reads the legacy file when fired; if `mutateDef` runs first, the legacy file still has stale registry fields, so the mirror's next call (from another site that uses writeAugmentDef) might overwrite cache with stale data. Audit each split-write for upstream `writeAugmentDef` callers that haven't migrated yet.

### Pattern 5 — Cross-store ordered write (use orchestrator)

```ts
// BEFORE:
removeInstalledArtifacts(name, ...);   // platform side effects
delete installations.augments[name];
writeInstallations(installations);
const def = readAugmentDef(name);
def.registryStatus = "retracted";
writeAugmentDef(def);
mirrorRetractFromRegistry(name, now);

// AFTER (mostly already done in the spike):
await retractRegistryAugment(name, {
  retractedAt: now,
  removePlatformArtifacts: () => removeInstalledArtifacts(name, ...),
});
// + keep the legacy installations + def writes for the dual-write window
```

**Existing orchestrators (in `src/lib/store-orchestrator.ts`):**
- `retractRegistryAugment(name, { retractedAt, removePlatformArtifacts? })`

**Future orchestrators to add as Package 03 / 04 needs them:**
- `promoteWrappedToLocal(name)` — when wrapped→local promotion happens (used in commands/install.ts auto-wrap upgrade path + bridge.ts's promoteAugment handler)
- `applyInstall(name, { platforms, artifacts })` — when an install record + def updates happen together
- `removeInstall(name, platforms?)` — partial uninstall (some platforms only)

Add each new orchestrator to `store-orchestrator.ts` + add it to the test file `store-orchestrator.test.js`.

### Pattern 6 — Reading via `installations.augments` map

```ts
// BEFORE:
const installations = readInstallations();
const names = Object.keys(installations.augments);
const record = installations.augments[name];

// AFTER:
import { listInstalls, readInstall } from "../installs-store";
const installRecords = listInstalls();
const names = installRecords.map(r => r.name);
const record = readInstall(name);
```

**Trapdoor:** `installations.lastUpdated` (the global timestamp on the installations.json file) does NOT exist in the new per-file store. Consumers that check `installations.lastUpdated` need to derive equivalent meaning — usually "have we ever installed anything?" → `listInstalls().length > 0`. This is `equip/src/lib/commands/doctor.ts:37`.

**Trapdoor:** `record.title` on the legacy install record is the augment title denormalized at install time. The new `InstallRecord` doesn't carry title — title is content, not install state. Consumers needing title alongside install info: `augmentResolver.resolve(name)?.title || name`.

## File-by-file migration order (recommended)

Order is by call-site count — biggest first. After each file, run the relevant test file + `npm test`. Commit per file.

1. **`src/lib/registry-refresh.ts`** (19 sites). Split into 3-5 commits — one per function (refreshAugmentFromRegistry, applyRegistryRetraction, helpers). Run `test/registry-refresh.test.js` + `test/retraction-promotion.test.js` after each.
2. **`src/lib/commands/install.ts`** (13 sites). The `apply()` orchestrator + `runInstall`. Run `test/equip-install-mcp-broker.test.js` + `test/cli.test.js`.
3. **`src/lib/installations.ts`** (11 sites — module itself). Most deletable — the module's exports become thin wrappers over installs-store + the legacy `installations.json` file write. Audit which exports are still consumed; delete unused ones.
4. **`src/lib/reconcile.ts`** (5 sites).
5. **`src/lib/commands/doctor.ts`** (~3 sites). See Pattern 6 trapdoors.
6. **`src/lib/commands/update.ts`** (~3 sites).
7. **`src/lib/mcp.ts`**, **`src/lib/skills.ts`**, **`src/lib/platform-state.ts`** — small, audit each.
8. **`src/cli/equip.ts`**, **`src/cli/unequip.ts`** — CLI tools. CLI tests at `test/cli.test.js`.

## Per-commit hygiene

- Each commit's message: `chore(equip): migrate <file> reads/writes to resolver (Cleanup B Pkg 03 N/M)` where N/M tracks progress
- Run `npx tsc` before commit (TypeScript catches most field-routing errors)
- Run the file's most-relevant test suite before commit
- Run the full equip suite at the end of each file's migration (`npm test`)
- Push to `feat/dual-write-retirement` after each commit (don't push to `main` until Package 03 is fully done + reviewed)

## End-of-Package-03 checklist

Before merging `feat/dual-write-retirement` → `main`:

- [ ] `grep -rln "readAugmentDef\|writeAugmentDef\|readInstallations\|writeInstallations" equip/src/lib/ equip/src/cli/` returns ONLY `installations.ts` + `augment-defs.ts` (the modules themselves)
- [ ] `npm test` in equip: 847+ tests pass (no regression from current baseline)
- [ ] `npm run sidecar:bundle` in equip-app: bundle builds cleanly (the bridge consumes equip lib via `../../equip/src/`)
- [ ] ENG-0044 verified resolved (the OR-condition in registry-refresh.ts:91 should be structurally impossible after migration — both reads now route through the resolver)
- [ ] ENG-0030 audited: did `rewriteInstalledArtifacts`/`apply` duplication dissolve? If yes, delete the function. If no, document why in `operations/ENGINEERING_LEDGER.md` ENG-0030 entry
- [ ] No `// @cleanup-b TODO` comments survive in `equip/src/`
- [ ] Self-review (engineering-review skill) before merge

## Risks (from architect review, see ENGINEERING_PLAN.md)

- **Lock-domain interaction.** `registry-refresh.ts` uses `acquireMutationLock` (process-wide L3 lock from `fs.ts`); the new `mutateDef` / `mutateCache` / `mutateInstall` also acquire the same L3 lock. The lock is **re-entrant** — nested calls within the same process bump a counter. Should not deadlock. Verify by running `test/registry-refresh.test.js` after the registry-refresh.ts migration.
- **Mid-migration legacy file divergence.** During Package 03's window, the lib code writes via the new write API (which doesn't trigger the dual-write mirror). The legacy `~/.equip/augments/<name>.json` files go stale. The bridge (Package 04) still reads legacy. Mitigation: keep BOTH the new write AND the legacy `writeAugmentDef` call alongside each other during Package 03 — call them a dual-write of our own. Drop the legacy call as part of Package 04 (when bridge migrates to resolver reads).

## Done definition for Package 03

Per `operations/initiatives/equip-dual-write-retirement/work/03-migrate-equip-lib-consumers.md`. Don't change scope without ENGINEERING_PLAN amendment.
