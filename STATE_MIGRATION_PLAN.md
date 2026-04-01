# Equip State Migration — Phased Action Plan

Implementation plan for migrating equip from the current `state.json` to the new multi-file architecture described in `STATE_REDESIGN.md`.

**Current test suite:** 292 tests across 6 files (equip: 171, hooks: 34, auth: 28, registry: 18, observability: 32, docs: 9). All changes must maintain or expand test coverage.

---

## Phase 1: Multi-Skill Support (Library Fix) ✅ COMPLETE

**Completed:** 2026-04-01
**Commit:** e08f373
**Tests:** 258 → 266 (8 new multi-skill tests)
**Risk:** Low — additive change, existing single-skill behavior preserved.

### Changes

**`src/index.ts` (Augment class):**
- Change `skill: SkillConfig | null` → `skills: SkillConfig[]`
- Constructor: `this.skills = config.skills || (config.skill ? [config.skill] : [])` (backward compat)
- `installSkill()` → `installSkills()`: loop over `this.skills`, call `installSkill()` per skill
- `uninstallSkill()` → `uninstallSkills()`: loop over `this.skills`
- `hasSkill()` → `hasSkills()`: check all skills exist
- `verify()`: check all skills, report per-skill status
- Keep old singular methods as deprecated wrappers for backward compat

**`src/lib/registry.ts` (toolDefToEquipConfig):**
- Remove `config.skill = def.skills[0]` truncation
- Map `def.skills` directly → `config.skills`

**`src/lib/reconcile.ts`:**
- Scan for ALL skill directories under `{skillsPath}/{toolName}/`, not just one
- Record `skillNames: string[]` instead of singular `skillName`

**`src/lib/state.ts`:**
- `ToolPlatformRecord`: add `skillNames?: string[]` alongside deprecated `skillName?: string`

**`bin/equip.js` (CLI):**
- Update install loop to install all skills
- Update status output to list all skills

### Tests to Add

```
describe("multi-skill support", () => {
  it("installs multiple skills to correct directories")
  it("uninstalls all skills for a tool")
  it("hasSkills returns false if any skill is missing")
  it("verify reports per-skill status")
  it("reconcileState discovers all skill directories")
  it("backward compat: singular skill config still works")
  it("toolDefToEquipConfig preserves all skills from registry")
})
```

### Validation

- Run full test suite (292+ tests)
- `equip prior` on a test platform with multi-skill definition
- Verify directory layout: `~/.claude/skills/prior/search/SKILL.md`, `~/.claude/skills/prior/contribute/SKILL.md`
- Verify `equip status` shows all skills
- Verify `equip doctor` checks all skills

---

## Phase 2: Augment Definitions (`~/.equip/augments/`)

**Completed:** 2026-04-01
**Tests:** 266 → 288 (22 new tests in augment-defs.test.js)
**Risk:** Medium — new concept, but doesn't change existing install flow yet. Additive.

### Changes

**New file: `src/lib/augment-defs.ts`**
- `readAugmentDef(name: string): AugmentDef | null` — read from `~/.equip/augments/<name>.json`
- `writeAugmentDef(def: AugmentDef): void` — atomic write
- `listAugmentDefs(): AugmentDef[]` — list all definitions
- `deleteAugmentDef(name: string): boolean` — remove definition
- `syncFromRegistry(name: string, registryDef: ToolDefinition): AugmentDef` — create/update from registry, preserving mods
- `createLocalAugment(config: LocalAugmentConfig): AugmentDef` — create a local augment definition
- `wrapUnmanaged(name: string, entry: McpEntry, fromPlatform: string): AugmentDef` — wrap unmanaged entry

**Type: `AugmentDef`**
```typescript
interface AugmentDef {
  name: string;
  source: "registry" | "local" | "wrapped";
  displayName: string;
  description: string;
  transport: "http" | "stdio";
  serverUrl?: string;
  stdio?: { command: string; args: string[]; envKey?: string };
  requiresAuth: boolean;
  envKey?: string;
  rules?: { content: string; version: string; marker: string };
  rulesUpstream?: { content: string; version: string };
  skills: SkillConfig[];
  hooks?: HookDefinition[];
  weight: number;
  modded: boolean;
  moddedAt?: string;
  moddedFields?: string[];
  registryVersion?: string;
  syncedAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

**`bin/equip.js` (directInstall):**
- After fetching registry definition: call `syncFromRegistry()` to create/update `augments/<name>.json`
- Read augment definition from `augments/` for subsequent installs (instead of re-fetching)

**`src/index.ts` export:**
- Export new functions from `augment-defs.ts`

### Tests to Add

```
describe("augment-defs", () => {
  it("writeAugmentDef creates file in ~/.equip/augments/")
  it("readAugmentDef returns null for missing definition")
  it("readAugmentDef returns parsed definition")
  it("listAugmentDefs returns all definitions")
  it("deleteAugmentDef removes the file")
  it("syncFromRegistry creates new definition from registry data")
  it("syncFromRegistry preserves modded rules on update")
  it("syncFromRegistry updates rulesUpstream on upstream change")
  it("syncFromRegistry detects version change and flags for review")
  it("createLocalAugment creates definition with source: local")
  it("wrapUnmanaged extracts config from MCP entry")
  it("wrapUnmanaged sets source: wrapped and wrappedFrom field")
  it("corrupt augment file is handled gracefully")
})
```

---

## Phase 3: New Platform State Files ✅ COMPLETE

**Completed:** 2026-04-01
**Tests:** 288 → 322 (34 new tests across platform-state.test.js and migration.test.js)
**Risk:** High — changes the core state model. Must maintain backward compatibility during migration.

### Sub-phase 3a: `platforms.json` (metadata only)

**New file: `src/lib/platform-state.ts`**
- `readPlatformsMeta(): PlatformsMeta` — read platforms.json
- `writePlatformsMeta(meta: PlatformsMeta): void` — atomic write
- `setPlatformEnabled(id: string, enabled: boolean): void`
- `updatePlatformsMeta(detected: DetectedPlatform[]): void` — merge detection results into existing metadata (preserving enabled/disabled preferences)

**Integration:**
- `reconcileState()` writes `platforms.json` after scanning (in addition to old `state.json`)
- Detection results include capabilities from PLATFORM_REGISTRY

### Sub-phase 3b: `platforms/<id>.json` (per-platform scan)

**New file: `src/lib/platform-scan.ts`**
- `readPlatformScan(id: string): PlatformScan | null`
- `writePlatformScan(id: string, scan: PlatformScan): void`
- `scanPlatform(platform: DetectedPlatform, installations: Installations): PlatformScan` — read config file, extract all MCP entries, cross-reference with installations for managed flag
- `scanAllPlatforms(detected: DetectedPlatform[], installations: Installations): void` — scan all, write per-platform files

**Integration:**
- Called by `reconcileState()` after install/uninstall
- Called by sidecar's `scan` method

### Sub-phase 3c: `installations.json` (replaces tool-centric state)

**New file: `src/lib/installations.ts`**
- `readInstallations(): Installations`
- `writeInstallations(inst: Installations): void`
- `trackInstallation(augmentName: string, platforms: string[], artifacts: Record<string, ArtifactRecord>): void`
- `trackUninstallation(augmentName: string, platforms?: string[]): void`
- `getInstallationsForPlatform(id: string): Record<string, ArtifactRecord>` — reverse lookup

**Integration:**
- Called by `reconcileState()` (replaces current `trackInstall`)
- Read by platform scan for managed flag determination

### Sub-phase 3d: `equip.json` (metadata)

- Extract `equipVersion`, `lastUpdated`, preferences from state.json
- Simple read/write functions

### Sub-phase 3e: Migration

- On first run with new code: if `state.json` exists and new files don't, auto-migrate
- `migrateState()` function:
  1. Read `state.json`
  2. Create `augments/<name>.json` for each tool (from cache + state)
  3. Create `installations.json` from state's tool→platform records
  4. Run full scan → write `platforms.json` + `platforms/<id>.json`
  5. Create `equip.json` from state metadata
  6. Rename `state.json` → `state.json.migrated`
- CLI still writes `state.json` for a transition period (can be removed in a later version)

### Tests to Add

```
describe("platform-state", () => {
  it("writePlatformsMeta creates platforms.json")
  it("updatePlatformsMeta preserves enabled/disabled on re-scan")
  it("setPlatformEnabled toggles the flag")
  it("setPlatformEnabled sets disabledAt timestamp")
  it("new platform appears as enabled by default")
  it("removed platform stays in file with detected: false")
})

describe("platform-scan", () => {
  it("scanPlatform reads all MCP entries from JSON config")
  it("scanPlatform reads all MCP entries from TOML config")
  it("scanPlatform detects transport type correctly")
  it("scanPlatform marks managed vs unmanaged correctly")
  it("scanPlatform includes artifact details (rules, hooks, skills)")
  it("writePlatformScan creates per-platform file")
  it("missing config file results in empty augments list")
  it("corrupt config file is handled gracefully")
})

describe("installations", () => {
  it("trackInstallation creates new augment record")
  it("trackInstallation adds platform to existing record")
  it("trackUninstallation removes platform from record")
  it("trackUninstallation removes augment when no platforms remain")
  it("trackUninstallation with disabled platforms leaves them intact")
  it("getInstallationsForPlatform returns correct reverse lookup")
})

describe("migration", () => {
  it("migrateState converts state.json to new files")
  it("migrateState creates augment definitions from cache")
  it("migrateState preserves all platform records")
  it("migrateState renames state.json to state.json.migrated")
  it("migrateState is idempotent (doesn't re-run if new files exist)")
  it("migrateState handles missing cache gracefully")
})
```

---

## Phase 4: Sidecar Bridge Updates ✅ COMPLETE

**Completed:** 2026-04-01
**Risk:** Low — sidecar is a thin wrapper, changes follow from Phase 3.

### Changes

- `scan` method: reads `platforms.json` + `platforms/<id>.json` instead of live-scanning every time (with a `force` param to trigger re-scan)
- `augments` method: list all augment definitions from `augments/`
- `install` method: read augment definition, install via Augment class, update state files
- `uninstall` method: read installations, uninstall via Augment class, update state files
- `running` method: check for running platform processes
- `enable`/`disable` method: toggle platform enabled flag
- `wrap` method: wrap unmanaged entry as local augment
- `drift` method: compare installations.json against platform scan files

### Sidecar Recompilation

After all changes, recompile:
```bash
bun build equip/sidecar/bridge.ts --compile --outfile equip-app/src-tauri/binaries/equip-sidecar
```

---

## Phase 5: Desktop App Integration ✅ COMPLETE (Agents tab)

**Completed:** 2026-04-01
**Risk:** Low — UI changes only, no library changes.
**Note:** Agents tab fully wired. Equip tab and other pages still use placeholder content.

### Changes

- Agents tab: read from new platform state (metadata + per-platform scan files)
- Equip tab: read augment definitions, show equipped status from platform scan files
- Enable/disable platforms via sidecar
- Install/uninstall augments via sidecar
- Weight bar: compute from augment definitions + platform scan data
- Drift warnings: show when platform scan diverges from installations

---

## Implementation Order & Dependencies

```
Phase 1: Multi-Skill Support
  ↓ (no dependency, can start immediately)
Phase 2: Augment Definitions
  ↓ (Phase 1 must be done — skills array in definitions)
Phase 3a: platforms.json
Phase 3b: platforms/<id>.json
Phase 3c: installations.json
Phase 3d: equip.json
  ↓ (3a-3d can be built in parallel, but 3e depends on all of them)
Phase 3e: Migration
  ↓
Phase 4: Sidecar Updates
  ↓
Phase 5: Desktop App
```

**Phases 1 and 2 are independent and safe.** They add new capabilities without changing existing behavior. Ship and test each before moving on.

**Phase 3 is the big one.** It changes the core state model. The sub-phases can be built incrementally, with the old `state.json` still being written in parallel until the migration is proven stable.

**Phases 4 and 5 are consumers** — they read/use what the earlier phases built.

---

## Testing Strategy

- **Each phase gets its own PR** with tests passing before merge
- **Backward compatibility tests**: verify old `state.json` still works during transition
- **Integration tests**: `equip prior` end-to-end with new state files
- **Migration tests**: verify state.json → new files conversion
- **Sidecar tests**: test bridge methods independently before compiling
- **Run full test suite after every phase**: 292+ tests must stay green

**Test infrastructure note:** The existing tests use temp directories and mock platforms — this pattern works well for the new state files too. Each test creates its own `~/.equip/` equivalent in a temp dir.

---

## Technical Debt & Architectural Concerns

Track issues discovered during implementation. Each item is either resolved inline or deferred with a justification.

### Phase 1

- **Deprecated `skill` getter on Augment class.** Uses a getter to maintain backward compat. Any code accessing `augment.skill` gets the first skill. This is fine for now but should be audited when we're ready to drop backward compat — search for `.skill` usage across the codebase and external consumers (prior-node setup scripts, registry definitions, etc.).

- **`skillName` vs `skillNames` in state.json.** The state record now writes both `skillName` (first skill, deprecated) and `skillNames` (all skills). This dual-write is intentional for backward compat but means state.json has redundant data. Will be resolved when state.json is replaced by installations.json in Phase 3.

- **reconcileState uses `.find()` for backward-compat `skillName` and `.filter()` for `skillNames`.** Two passes over the same directory listing. Minor — directory listings are tiny (typically 1-3 entries). Not worth optimizing.

### Phase 2

- **augment-defs.ts paths resolve dynamically via `os.homedir()`.** This is intentional for testability (tests override `os.homedir`) but means every call resolves the path. Given the low call frequency this is fine, but if performance mattered we'd cache with invalidation.

- **`syncFromRegistry` doesn't validate the ToolDefinition input.** A malformed registry response could create a broken augment definition. The registry API is trusted for now, but if we ever accept definitions from third parties, input validation becomes important.

- **Weight field defaults to 0.** No augment definition has a real weight value yet. This needs to be populated either from the registry (preferred) or computed heuristically before the weight bar can show meaningful data.

- **CLI doesn't call `syncFromRegistry` yet.** The augment-defs module is built and tested but not wired into the CLI's install flow. Phase 3+ should integrate it: after fetching a tool definition, call `syncFromRegistry()` to persist it before installing.

- **`modAugmentRules` saves original for ALL sources** (not just registry). This is correct behavior (local augments should be resettable too) but means `rulesUpstream` is a slight misnomer for local augments — it's really "rules before modification." Consider renaming to `rulesOriginal` in a future cleanup.

### Phase 3

- **state.ts still uses hardcoded EQUIP_DIR.** The old `readState()` function uses `const EQUIP_DIR = path.join(os.homedir(), ".equip")` evaluated at import time. New modules (platform-state, installations, equip-meta, augment-defs, migration) all resolve paths dynamically via `os.homedir()` for testability. The migration module works around this by reading state.json directly with `readStateFromPath()` instead of using `readState()`. When state.json is fully deprecated, this inconsistency goes away.

- **CLI not yet integrated with new state files.** The CLI still writes to the old state.json via `reconcileState()` and `trackInstall()`. Phase 4 (sidecar) and the CLI integration should call `scanAllPlatforms()`, `trackInstallation()`, and `syncFromRegistry()` after installs. Until then, the new files are only populated by explicit calls or migration.

- **migration.ts doesn't create platforms.json or platforms/<id>.json.** By design — those are populated by the next scan. But this means after migration, the new platform state files don't exist until the first scan runs. The UI should handle this gracefully (show "scanning..." if files are missing).

- **Hook detection in platform-state.ts checks `(def as any).hooks`.** The PlatformDefinition type doesn't expose `hooks` as a public field — it's accessed via `getHookCapabilities()`. The cast is a workaround. Should be cleaned up by adding a `hasHooks()` utility to platforms.ts.

- **No integration test for full migration + scan cycle.** Unit tests cover each module in isolation. A full end-to-end test (write state.json → migrate → scan → verify all files) would be valuable but requires mock platforms with real config files. Worth adding but not blocking.

### Phase 4

- **Sidecar has no install/uninstall methods yet.** The sidecar can scan and report but can't modify platform configs. Needed for the Equip page to be functional. Requires wiring the Augment class through the sidecar with proper auth handling.

- **Process detection is platform-specific and fragile.** The `isProcessRunning` function uses `tasklist` on Windows and `pgrep` on Unix. Process names are hardcoded. If a platform renames its executable, detection breaks silently. Should be made configurable per platform in the registry.

- **Test augment files leaked into real `~/.equip/augments/`.** Some earlier test runs (before dynamic path resolution was added) created files in the real homedir. Manually cleaned up. The augment-defs tests now properly use temp dirs, but this highlights the risk of the `os.homedir` override pattern — if any module caches the path at import time, tests can pollute the real filesystem.

- **Sidecar `read` method falls back to full `scan` if no cached state.** This means the first call to `read` is slow (spawns detection + reads all configs). The UI should call `scan` explicitly on launch and use `read` for subsequent navigations.

- **`running` check is expensive on Windows.** Each `tasklist` call takes ~200ms. With 6 platforms to check, that's >1 second. Should be parallelized or cached with a short TTL.

### Phase 5

- **`@tauri-apps/*` externalized via regex in vite.config.ts.** This is a broad externalization — any `@tauri-apps/` import is externalized from the SSR build. This is correct (none of them work in SSR) but if we ever need to import Tauri types at build time, the regex would need refinement.

- **Agents page calls `scan_platforms` on every mount.** This spawns the sidecar and does a full scan on every navigation to the Agents tab. Should use `read_platforms` for cached data and only `scan_platforms` on explicit refresh or first visit.

- **Enable/disable is optimistic UI.** The toggle updates local state immediately, then calls the sidecar. If the sidecar call fails, the UI state is wrong. Should add error rollback.

- **Running process check is fire-and-forget.** Called after scan completes, result rendered when available. If the check takes >1s (Windows), the running indicators appear with a delay. Acceptable for now but could feel laggy.
