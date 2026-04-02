# Equip State Migration Review

Architectural review of the state management migration from `state.json` to the multi-file architecture. Produced 2026-03-28.

---

## 1. Pre-Migration State (Current Behavior)

### `equip install prior` (direct-mode)

```
bin/equip.js main()
  -> dispatchTool("prior", parsedArgs)
    -> fetchToolDef("prior", ...)                   READS: API / ~/.equip/cache/prior.json / registry.json
    -> directInstall(toolDef, parsedArgs)
      -> resolveAuth(...)                            READS: ~/.equip/credentials/prior.json
                                                     WRITES: ~/.equip/credentials/prior.json (if new/refreshed)
      -> toolDefToEquipConfig(toolDef, ...)          (pure transform, no I/O)
      -> new Augment(config)
      -> equip.detect()                              READS: filesystem detection (~/.claude/, ~/.cursor/, etc.)
                                                     NO WRITE — results are ephemeral
      -> for each platform:
           equip.installMcp(p, apiKey, ...)           WRITES: platform config file (e.g., ~/.claude.json)
           equip.installRules(p, ...)                 WRITES: platform rules file (e.g., ~/.claude/CLAUDE.md)
           equip.installSkill(p, ...)                 WRITES: skill directory (e.g., ~/.claude/skills/prior/search/SKILL.md)
           equip.verify(p)                            READS: platform config, rules, skills
      -> reconcileState(...)                          READS: all platform configs, rules files, hook dirs, skill dirs
                                                     WRITES: ~/.equip/state.json (via trackInstall() per platform)
      -> fetch("https://api.cg3.io/equip/telemetry") (fire-and-forget)
```

**Files read:** registry API or `cache/prior.json`, `registry.json`, `credentials/prior.json`, all platform detection dirs, all platform config files, all rules files, all skill dirs.

**Files written:** `credentials/prior.json` (if auth changed), platform config files, platform rules files, platform skill dirs, `~/.equip/state.json`.

**New state modules touched: NONE.** No call to `syncFromRegistry()`, `trackInstallation()`, `scanAllPlatforms()`, `isPlatformEnabled()`, or `markEquipUpdated()`.

---

### `equip uninstall prior` (unequip.js)

```
bin/unequip.js
  -> readState()                                     READS: ~/.equip/state.json
  -> state.tools["prior"]                            (lookup what platforms have it)
  -> for each [platformId, record] in tool.platforms:
       createManualPlatform(platformId)
       uninstallMcp(platform, "prior", dryRun)       WRITES: platform config file (removes entry)
       uninstallRules(platform, ...)                  WRITES: platform rules file (removes marker block)
       uninstallHooks(platform, ...)                  WRITES: removes hook scripts from hookDir
  -> trackUninstall("prior")                         WRITES: ~/.equip/state.json (removes tool record)
```

**Files read:** `~/.equip/state.json`, platform config files (to remove entries).

**Files written:** platform config files, platform rules files, hook scripts, `~/.equip/state.json`.

**New state modules touched: NONE.** No call to `trackUninstallation()`, `scanAllPlatforms()`, or `isPlatformEnabled()`.

**Critical gap:** Uninstall does NOT filter by `isPlatformEnabled()`. It removes from ALL platforms listed in state, including ones the user may have disabled.

---

### `equip status`

```
src/lib/commands/status.ts runStatus()
  -> readState()                                     READS: ~/.equip/state.json
  -> for each platform in PLATFORM_REGISTRY:
       detection check (dirExists, fileExists)        READS: filesystem
       readAllEntries(configPath, ...)                READS: platform config file
       cross-reference server names with state.tools  (determines "equip" vs "manual" badge)
  -> print platform list + server list
```

**Files read:** `~/.equip/state.json`, all detected platform config files.

**Files written:** NONE.

**New state modules touched: NONE.** Could use `readInstallations()` for "managed" instead of `state.tools`.

---

### `equip doctor`

```
src/lib/commands/doctor.ts runDoctor()
  -> readState()                                     READS: ~/.equip/state.json
  -> for each tool in state.tools:
       for each [platformId, record] in tool.platforms:
         readMcpEntry(configPath, ...)                READS: platform config file
         check rules version match                    READS: platform rules file
         check hook scripts exist                     READS: hook directory
         check skill SKILL.md exists                  READS: skill directory
  -> listStoredCredentials()                          READS: ~/.equip/credentials/
  -> for each credential: check expiry               READS: credential files
  -> for each detected platform: parse config        READS: all platform config files
```

**Files read:** `~/.equip/state.json`, platform configs, rules files, hook dirs, skill dirs, credential files.

**Files written:** NONE.

**New state modules touched: NONE.**

---

### `equip update` (self-update, no tool name)

```
src/lib/commands/update.ts runUpdate()
  -> npm update -g @cg3/equip
  -> readState()                                     READS: ~/.equip/state.json
  -> migrateConfigs()                                READS: state.json, platform configs
                                                     WRITES: platform config files (if shape changed)
  -> markUpdated()                                   WRITES: ~/.equip/state.json (version + timestamp)
```

**Files read:** `~/.equip/state.json`, platform configs.

**Files written:** platform configs (if migrated), `~/.equip/state.json`.

**New state modules touched: NONE.** Does not call `markEquipUpdated()`.

---

### `equip update prior` (tool re-install)

```
bin/equip.js cmdUpdate()
  -> delete cache file                               WRITES: deletes ~/.equip/cache/prior.json
  -> fetchToolDef("prior", ...)                      READS: API (fresh fetch)
  -> directInstall(toolDef, parsedArgs)              (same as equip install — see above)
```

Same file access pattern as `equip install prior`. Does NOT call `syncFromRegistry()` to update the augment definition.

---

### Sidecar `scan`

```
sidecar/bridge.ts scan()
  -> migrateState()                                  READS: ~/.equip/state.json
                                                     WRITES: installations.json, augments/*.json, equip.json
                                                     WRITES: renames state.json -> state.json.migrated
  -> detectPlatforms()                               READS: filesystem detection
  -> getManagedAugmentNames()                        READS: ~/.equip/installations.json
  -> scanAllPlatforms(detected, managedNames)
       updatePlatformsMeta(detected)                 READS+WRITES: ~/.equip/platforms.json
       for each platform:
         scanPlatform(p, managedNames)               READS: platform config, rules, hooks, skills
         writePlatformScan(id, scan)                  WRITES: ~/.equip/platforms/<id>.json
  -> markScanCompleted()                             WRITES: ~/.equip/equip.json
```

**Files read:** `state.json` (for migration), `installations.json`, all platform configs, rules, hooks, skills.

**Files written:** `installations.json` (migration only), `augments/*.json` (migration only), `platforms.json`, `platforms/*.json`, `equip.json`.

**This is the ONLY code path that writes new state files.** And it only populates `installations.json` and `augments/` via the one-time migration, never from live installs.

---

### Sidecar `read`

```
sidecar/bridge.ts read()
  -> readPlatformsMeta()                             READS: ~/.equip/platforms.json
  -> (if no data) falls back to scan()               (full scan — see above)
  -> for each platform in meta:
       readPlatformScan(id)                          READS: ~/.equip/platforms/<id>.json
```

**Files read:** `platforms.json`, `platforms/*.json`.

**Files written:** NONE (unless fallback to scan).

---

## 2. Post-Migration State (Target Behavior)

After migration, `state.ts` is **deleted** from the source tree. `reconcile.ts` is **rewritten**. Every CLI command and sidecar method reads and writes exclusively through the new modules.

### `equip install prior` (target)

```
bin/equip.js directInstall(toolDef, parsedArgs)
  -> resolveAuth(...)                                (unchanged)
  -> syncFromRegistry(toolDef)                       WRITES: ~/.equip/augments/prior.json
  -> toolDefToEquipConfig(toolDef, ...)              (unchanged)
  -> new Augment(config)
  -> equip.detect()                                  (unchanged)
  -> readPlatformsMeta()                             READS: ~/.equip/platforms.json
  -> filter platforms by isPlatformEnabled()          (skip disabled platforms)
  -> filter by --platform flag                        (unchanged)
  -> for each enabled platform:
       equip.installMcp(p, apiKey, ...)              WRITES: platform config file
       equip.installRules(p, ...)                    WRITES: platform rules file
       equip.installSkill(p, ...)                    WRITES: skill directory
       equip.verify(p)                               READS: platform config, rules, skills
  -> trackInstallation("prior", ...)                 WRITES: ~/.equip/installations.json
  -> scanAllPlatforms(detected, managedNames)        WRITES: platforms.json + platforms/*.json
  -> markEquipUpdated()                              WRITES: ~/.equip/equip.json
  -> telemetry                                       (unchanged)
```

**state.json: NOT read, NOT written. Does not exist.**

---

### `equip uninstall prior` (target)

```
bin/unequip.js (rewritten)
  -> readInstallations()                             READS: ~/.equip/installations.json
  -> inst.augments["prior"]                          (lookup what platforms have it)
  -> readPlatformsMeta()                             READS: ~/.equip/platforms.json
  -> filter platforms by isPlatformEnabled()          (SKIP disabled platforms)
  -> for each enabled platform where prior is installed:
       createManualPlatform(platformId)
       uninstallMcp(platform, "prior", dryRun)       WRITES: platform config file
       uninstallRules(platform, ...)                  WRITES: platform rules file
       uninstallHooks(platform, ...)                  WRITES: removes hook scripts
  -> trackUninstallation("prior", enabledPlatforms)  WRITES: ~/.equip/installations.json
                                                     (keeps disabled-platform entries intact)
  -> scanAllPlatforms(detected, managedNames)        WRITES: platforms.json + platforms/*.json
```

**state.json: NOT read, NOT written.**

---

### `equip status` (target)

```
src/lib/commands/status.ts runStatus() (rewritten)
  -> readInstallations()                             READS: ~/.equip/installations.json
  -> for each platform in PLATFORM_REGISTRY:
       detection check                                READS: filesystem
       readAllEntries(configPath, ...)                READS: platform config file
       cross-reference with installations.augments    (determines "equip" vs "manual" badge)
  -> readPlatformsMeta()                             READS: ~/.equip/platforms.json
       (show enabled/disabled status)
  -> print platform list + server list
```

**state.json: NOT imported.**

---

### `equip doctor` (target)

```
src/lib/commands/doctor.ts runDoctor() (rewritten)
  -> readInstallations()                             READS: ~/.equip/installations.json
  -> for each augment in installations.augments:
       for each platform in augment.platforms:
         readMcpEntry(...)                            READS: platform config
         check rules, hooks, skills                   READS: filesystem
  -> check credentials                                (unchanged)
  -> check config parse health                        (unchanged)
  -> readPlatformsMeta()                             READS: platforms.json
       (show disabled platform warnings)
```

**state.json: NOT imported.**

---

### `equip update` (self-update, no tool name) (target)

```
src/lib/commands/update.ts runUpdate() (rewritten)
  -> npm update -g @cg3/equip
  -> readInstallations()                             READS: ~/.equip/installations.json
  -> migrateConfigs() (update.ts version)            READS: installations, platform configs
                                                     WRITES: platform configs (if shape changed)
  -> markEquipUpdated()                              WRITES: ~/.equip/equip.json
```

**state.json: NOT imported. `markUpdated()` replaced by `markEquipUpdated()`.**

---

### `equip update prior` (target)

Same as `equip install prior` target, with the addition:

```
  -> delete cache file (force fresh fetch)
  -> syncFromRegistry(toolDef)                       Updates augment def, preserving mods
```

---

### Sidecar `scan` (target)

No change from current behavior. The sidecar already uses new modules. The migration trigger (`migrateState()`) is still called for users who haven't run the CLI yet.

---

### Sidecar `read` (target)

No change from current behavior.

---

## 3. File-by-File Change Specification

### 3.1 `src/lib/state.ts` -- DELETE

**Today:** Defines `EquipState`, `ToolRecord`, `ToolPlatformRecord` types. Provides `readState()`, `writeState()`, `trackInstall()`, `trackUninstall()`, `markUpdated()`. Reads/writes `~/.equip/state.json`.

**After migration:** File is deleted entirely.

**Types to preserve:** `EquipState` and `ToolPlatformRecord` are imported by `migration.ts` for reading legacy state files. These type definitions should be moved INTO `migration.ts` as private types (they have no other consumers post-migration).

**Dependency check:**

| Consumer | Current import | Post-migration replacement |
|----------|---------------|---------------------------|
| `reconcile.ts` | `trackInstall, ToolPlatformRecord` | reconcile.ts is rewritten (see 3.2) |
| `commands/status.ts` | `readState` | `readInstallations()` from installations.ts |
| `commands/doctor.ts` | `readState` | `readInstallations()` from installations.ts |
| `commands/update.ts` | `readState, markUpdated` | `readInstallations()`, `markEquipUpdated()` |
| `migration.ts` | `EquipState, ToolPlatformRecord` (type-only) | Move types inline |
| `migrate.ts` | `readState` | `readInstallations()` |
| `bin/equip.js` | `readState` (checkStaleVersion) | `readEquipMeta()` |
| `bin/unequip.js` | `readState, trackUninstall` | `readInstallations(), trackUninstallation()` |
| `test/equip.test.js` | `readState, writeState, trackInstall, trackUninstall, getStatePath` | Replace with new module functions |
| `test/docs.test.js` | `trackUninstall` | `trackUninstallation()` |
| `test/observability.test.js` | `readState` | Update or remove corrupt-state test |

**Breaking change for external consumers:** `readState`, `writeState`, `trackInstall`, `trackUninstall`, `markUpdated` are currently exported from `src/index.ts` implicitly (they are NOT exported -- verified in index.ts). They are only imported directly via `../dist/lib/state` by internal CLI files and tests. No external breaking change.

---

### 3.2 `src/lib/reconcile.ts` -- REWRITE

**Today:** Scans all platforms for a specific tool's artifacts. Calls `trackInstall()` from state.ts per platform. Returns number of platforms found.

**After migration:** Rewritten to call new state modules. The reconciliation concept remains (scan disk and record what's there), but the output target changes.

**New signature:**

```typescript
export interface ReconcileOptions {
  toolName: string;
  package: string;
  marker?: string;
  hookDir?: string;
  /** Tool definition from registry, for syncing augment def */
  toolDef?: ToolDefinition;
  /** Specific platforms that were modified (optimization: skip full scan) */
  affectedPlatforms?: string[];
}

export interface ReconcileResult {
  platformCount: number;
  installationTracked: boolean;
  augmentSynced: boolean;
  scanCompleted: boolean;
}

export function reconcileState(options: ReconcileOptions): ReconcileResult
```

**New implementation logic:**

```
reconcileState(options):
  1. If options.toolDef provided: syncFromRegistry(options.toolDef)
  2. Scan all detected platforms for this tool's artifacts (same scan logic as today)
  3. Build artifact records per platform from scan results
  4. Call trackInstallation(toolName, { source, package, displayName, transport, platforms, artifacts })
  5. Detect all platforms -> filter by isPlatformEnabled()
  6. Call scanAllPlatforms(detected, getManagedAugmentNames())
  7. Call markEquipUpdated()
  8. Return ReconcileResult
```

**Imports change:** Remove `import { trackInstall } from "./state"`. Add imports from `installations.ts`, `augment-defs.ts`, `platform-state.ts`, `equip-meta.ts`.

---

### 3.3 `bin/equip.js` -- MODIFY

**Changes required:**

| Location | Current | Target |
|----------|---------|--------|
| Line 53: `checkStaleVersion()` | `require("../dist/lib/state").readState()` | `require("../dist/lib/equip-meta").readEquipMeta()` and check `meta.lastUpdated` |
| Line 376: `directInstall()` | `require("../dist/lib/reconcile").reconcileState(...)` | Same function, but reconcile.ts is rewritten (see 3.2) |
| Line 374: `directInstall()` post-auth | Nothing | Add `syncFromRegistry(toolDef)` call after fetching tool def |
| Line 427-437: platform filtering | Only `--platform` filter | Add `isPlatformEnabled()` filter before `--platform` filter |
| Line 525: reconcileState call | Passes `{ toolName, package, marker }` | Pass `{ toolName, package, marker, toolDef }` |
| Line 689: `runLocal()` post-child | `reconcileState(...)` | Same (reconcile.ts is rewritten internally) |
| Line 720-730: `spawnTool()` post-child | `reconcileState(...)` | Same |
| Line 17: REGISTRY read | `require("../registry.json")` | Keep (still used for package-mode fallback) |

**Specific code changes in `directInstall()`:**

```javascript
// AFTER auth resolution, BEFORE platform detection:
const { syncFromRegistry } = require("../dist/lib/augment-defs");
if (toolDef) {
  syncFromRegistry(toolDef);
}

// AFTER detect(), BEFORE --platform filter:
const { isPlatformEnabled } = require("../dist/lib/platform-state");
platforms = platforms.filter(p => isPlatformEnabled(p.platform));
if (platforms.length === 0) {
  // All detected platforms are disabled
  warn("All detected platforms are disabled. Enable platforms in the Equip app or remove ~/.equip/platforms.json.");
  process.exit(1);
}

// reconcileState call: pass toolDef
reconcileState({
  toolName: toolDef.name,
  package: toolDef.npmPackage || toolDef.name,
  marker: toolDef.rules?.marker || toolDef.name,
  toolDef,
});
```

**`checkStaleVersion()` change:**

```javascript
function checkStaleVersion() {
  try {
    const { readEquipMeta } = require("../dist/lib/equip-meta");
    const meta = readEquipMeta();
    if (meta.lastUpdated) {
      const daysSince = (Date.now() - new Date(meta.lastUpdated).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 14) {
        const { YELLOW, RESET, DIM } = require("../dist/lib/cli");
        process.stderr.write(`  ${YELLOW}equip v${EQUIP_VERSION} is ${Math.floor(daysSince)} days old${RESET} ${DIM}— run "equip update" for platform fixes${RESET}\n\n`);
      }
    }
  } catch {}
}
```

---

### 3.4 `bin/unequip.js` -- REWRITE

**Today:** Reads `state.json` to find platforms, iterates, removes artifacts, calls `trackUninstall()`.

**After migration:**

```javascript
const { readInstallations, trackUninstallation } = require("../dist/lib/installations");
const { isPlatformEnabled, readPlatformsMeta } = require("../dist/lib/platform-state");
const { scanAllPlatforms, getManagedAugmentNames } = require("../dist/lib/platform-state");
const { detectPlatforms } = require("../dist/lib/detect");

// Replace: const state = readState();
const installations = readInstallations();
const tool = installations.augments[toolName];

// Replace: for (const [platformId, record] of Object.entries(tool.platforms))
// With: iterate tool.platforms array, filter by isPlatformEnabled()
const enabledPlatforms = tool.platforms.filter(id => isPlatformEnabled(id));
const skippedPlatforms = tool.platforms.filter(id => !isPlatformEnabled(id));

if (skippedPlatforms.length > 0) {
  cli.log(`  ${cli.DIM}Skipping disabled platforms: ${skippedPlatforms.map(id => platformName(id)).join(", ")}${cli.RESET}`);
}

for (const platformId of enabledPlatforms) {
  // Get artifact details from installations.json
  const artifacts = tool.artifacts[platformId];
  // ... remove MCP, rules, hooks using artifacts record
}

// Replace: trackUninstall(toolName)
trackUninstallation(toolName, enabledPlatforms);

// Add: re-scan to update platform files
const detected = detectPlatforms();
const managedNames = getManagedAugmentNames();
scanAllPlatforms(detected, managedNames);
```

**Key difference:** The artifact details (rulesVersion, hookScripts, etc.) come from `installations.augments[toolName].artifacts[platformId]` instead of `state.tools[toolName].platforms[platformId]`.

**Mapping from old record fields to new:**

| Old (`ToolPlatformRecord`) | New (`ArtifactRecord` + `InstallationRecord`) |
|---------------------------|----------------------------------------------|
| `record.configPath` | `PLATFORM_REGISTRY.get(id).configPath()` |
| `record.transport` | `tool.transport` |
| `record.rulesPath` | Derive from `PLATFORM_REGISTRY.get(id).rulesPath()` |
| `record.rulesVersion` | `tool.artifacts[id].rules` |
| `record.hookDir` | Derive from tool name: `~/.${toolName}/hooks` or read from augment def |
| `record.hookScripts` | `tool.artifacts[id].hooks` |
| `record.skillsPath` | Derive from `PLATFORM_REGISTRY.get(id).skillsPath()` |
| `record.skillName` | `tool.artifacts[id].skills[0]` |

**Note:** `unequip.js` currently constructs hook event objects with empty fields (`event: "", name: s.replace(/\.js$/, ""), script: "", matcher: ""`). This works because `uninstallHooks` only needs the name to find the file. Post-migration, the augment definition in `augments/<name>.json` has the full hook definitions. The uninstall should read `readAugmentDef(toolName)` to get proper hook definitions.

---

### 3.5 `src/lib/commands/status.ts` -- MODIFY

**Today imports:** `readState` from `../state`.

**After migration:**

```typescript
// Remove: import { readState } from "../state";
// Add:
import { readInstallations } from "../installations";
import { readPlatformsMeta } from "../platform-state";
```

**Change in `runStatus()`:**

```typescript
// Replace: const state = readState();
const installations = readInstallations();
const platformsMeta = readPlatformsMeta();

// Replace: const tracked = !!state.tools[name];
const tracked = !!installations.augments[name];

// Add after platform list: show enabled/disabled status
for (const p of platformResults) {
  const meta = platformsMeta.platforms[p.id];
  const enabledStr = meta && !meta.enabled ? ` ${cli.YELLOW}(disabled)${cli.RESET}` : "";
  // ... include enabledStr in output
}
```

---

### 3.6 `src/lib/commands/doctor.ts` -- MODIFY

**Today imports:** `readState` from `../state`.

**After migration:**

```typescript
// Remove: import { readState } from "../state";
// Add:
import { readInstallations } from "../installations";
import { readPlatformsMeta } from "../platform-state";
import { readAugmentDef } from "../augment-defs";
import { readEquipMeta } from "../equip-meta";
```

**Changes in `runDoctor()`:**

```typescript
// Replace: const state = readState();
const installations = readInstallations();
const meta = readEquipMeta();
const platformsMeta = readPlatformsMeta();

// Replace state-exists check:
if (Object.keys(installations.augments).length === 0 && !meta.lastUpdated) {
  cli.warn("No equip state found — run 'equip update' to initialize");
  issues++;
} else {
  cli.ok("State files present");
}

// Replace tool iteration:
for (const [toolName, installRecord] of Object.entries(installations.augments)) {
  cli.log(`  ${cli.BOLD}${toolName}${cli.RESET} ${cli.DIM}(${installRecord.package || toolName})${cli.RESET}`);

  for (const platformId of installRecord.platforms) {
    const def = PLATFORM_REGISTRY.get(platformId);
    if (!def) { /* ... */ continue; }

    // Check disabled
    const platMeta = platformsMeta.platforms[platformId];
    if (platMeta && !platMeta.enabled) {
      cli.log(`  ${def.name}: ${cli.DIM}disabled — skipping checks${cli.RESET}`);
      continue;
    }

    const configPath = def.configPath();
    const artifacts = installRecord.artifacts[platformId];

    // ... check MCP entry exists (unchanged)
    // ... check rules version from artifacts.rules instead of record.rulesVersion
    // ... check hooks from artifacts.hooks instead of record.hookScripts
    // ... check skills from artifacts.skills instead of record.skillName
  }
}
```

**Skill check change:** Current code checks `record.skillName` (singular). New code should check all `artifacts.skills[]`.

---

### 3.7 `src/lib/commands/update.ts` -- MODIFY

**Today imports:** `readState, markUpdated` from `../state`.

**After migration:**

```typescript
// Remove: import { readState, markUpdated } from "../state";
// Add:
import { readInstallations } from "../installations";
import { markEquipUpdated } from "../equip-meta";
```

**Changes:**

```typescript
// Replace: const state = readState();
const installations = readInstallations();
const toolCount = Object.keys(installations.augments).length;

// Replace: markUpdated();
markEquipUpdated();
```

**`migrateConfigs()` dependency:** `migrate.ts` also imports `readState`. See 3.10.

---

### 3.8 `src/lib/migrate.ts` -- MODIFY

This is the MCP config shape migration (different from `migration.ts` which migrates state.json). It reads the list of tracked tools to know what entries to check.

**Today imports:** `readState` from `./state`.

**After migration:**

```typescript
// Remove: import { readState } from "./state";
// Add:
import { readInstallations } from "./installations";
```

**Change in `migrateConfigs()`:**

```typescript
// Replace: const state = readState();
const installations = readInstallations();

// Replace: for (const [toolName, tool] of Object.entries(state.tools))
for (const [toolName, installRecord] of Object.entries(installations.augments)) {
  // Replace: for (const [platformId, record] of Object.entries(tool.platforms))
  for (const platformId of installRecord.platforms) {
    const def = PLATFORM_REGISTRY.get(platformId);
    if (!def) continue;
    const configPath = def.configPath();
    // ... rest of migration logic unchanged
  }
}
```

Note: The current code uses `record.configPath || def.configPath()`. Since `InstallationRecord` does not store per-platform config paths (and shouldn't -- they're derived from the platform registry), this simplifies to just `def.configPath()`.

---

### 3.9 `src/lib/migration.ts` -- MODIFY (minor)

This is the one-time state.json-to-new-files migration. It MUST continue to read legacy `state.json` because that's literally its job.

**Today:** Imports `EquipState, ToolPlatformRecord` types from `./state`.

**After migration:** Move these type definitions inline into migration.ts as private types. The import path `./state` will no longer exist.

```typescript
// Remove: import type { EquipState, ToolPlatformRecord } from "./state";
// Add inline:

/** @internal Legacy state.json types — used only for migration. */
interface LegacyToolPlatformRecord {
  configPath: string;
  transport: string;
  rulesPath?: string;
  rulesVersion?: string;
  hookDir?: string;
  hookScripts?: string[];
  skillsPath?: string;
  skillName?: string;
  skillNames?: string[];
  equipVersion?: string;
}

interface LegacyToolRecord {
  package: string;
  installedAt: string;
  updatedAt?: string;
  platforms: Record<string, LegacyToolPlatformRecord>;
}

interface LegacyEquipState {
  equipVersion: string;
  lastUpdated: string;
  tools: Record<string, LegacyToolRecord>;
}
```

Then update all references from `EquipState` to `LegacyEquipState` and `ToolPlatformRecord` to `LegacyToolPlatformRecord`.

---

### 3.10 `src/index.ts` -- MODIFY

**Remove these imports/exports that reference state.ts:**

Currently `state.ts` is NOT exported from `index.ts` (verified -- the exports list does not include readState, writeState, etc.). However, `migration.ts` types `MigrationResult` are exported which reference `EquipState` transitively. After inlining the types in migration.ts (see 3.9), no changes needed to the type export.

**Verify:** The `index.ts` export list already includes all new module exports (augment-defs, platform-state, installations, equip-meta, migration). No additions needed.

---

### 3.11 `sidecar/bridge.ts` -- NO CHANGE

The sidecar already exclusively uses new state modules. No references to `state.ts`. No changes needed for this migration.

**Future work (Phase 7):** Add `install`, `uninstall`, `wrap`, `drift` methods. Not part of this migration.

---

## 4. Test Migration Plan

### 4.1 Tests That Reference Old State Functions

| Test File | Old State References | Action |
|-----------|---------------------|--------|
| `test/equip.test.js` (line ~693) | `readState, writeState, trackInstall, trackUninstall, getStatePath` | Rewrite state tests to use `readInstallations, writeInstallations, trackInstallation, trackUninstallation` |
| `test/equip.test.js` (line ~991) | `readState, writeState, trackUninstall` | Same rewrite |
| `test/equip.test.js` (line ~1036) | `readState, trackInstall, trackUninstall` | Same rewrite |
| `test/equip.test.js` (line ~1963) | `readState, writeState, trackInstall, trackUninstall` | Same rewrite |
| `test/docs.test.js` (line ~21) | `trackUninstall` | Replace with `trackUninstallation` from installations.ts |
| `test/observability.test.js` (line ~17) | `readState` | Replace corrupt state test with `readInstallations()` handling |
| `test/migration.test.js` | References `state.json` by design | **KEEP** -- these tests verify the legacy migration path |

### 4.2 Detailed Test Changes

**`test/equip.test.js` -- state tracking section (~line 690-740):**

Replace:
```javascript
const { readState, writeState, trackInstall, trackUninstall, getStatePath } = require("../dist/lib/state");
```

With:
```javascript
const { readInstallations, writeInstallations, trackInstallation, trackUninstallation } = require("../dist/lib/installations");
```

Rewrite `trackInstall`/`trackUninstall` roundtrip test:
```javascript
it("trackInstallation and trackUninstallation roundtrip", () => {
  trackInstallation("test-tool", {
    source: "registry",
    displayName: "Test Tool",
    transport: "http",
    platforms: ["claude-code"],
    artifacts: { "claude-code": { mcp: true } },
  });
  const inst = readInstallations();
  assert.ok(inst.augments["test-tool"]);
  assert.deepStrictEqual(inst.augments["test-tool"].platforms, ["claude-code"]);

  trackUninstallation("test-tool", ["claude-code"]);
  const after = readInstallations();
  assert.ok(!after.augments["test-tool"]);
});
```

**`test/docs.test.js`:** Replace `trackUninstall("piratehat")` with `trackUninstallation("piratehat")`.

**`test/observability.test.js` -- corrupt state.json test (~line 281):**

This test verifies that a corrupt state.json is handled gracefully. Post-migration, the equivalent is a corrupt `installations.json`. Rewrite:

```javascript
describe("corrupt installations.json", () => {
  it("returns empty state on corrupt file", () => {
    const installPath = path.join(os.homedir(), ".equip", "installations.json");
    fs.writeFileSync(installPath, "NOT JSON{{{");
    const { readInstallations } = require("../dist/lib/installations");
    const inst = readInstallations();
    assert.deepStrictEqual(inst.augments, {});
  });
});
```

### 4.3 New Tests Needed

**1. CLI integration with isPlatformEnabled (in equip.test.js):**

```
it("directInstall skips disabled platforms")
it("uninstall skips disabled platforms and reports them")
it("disabled platform remains in installations.json after uninstall")
```

**2. reconcileState with new modules (in equip.test.js):**

```
it("reconcileState writes installations.json")
it("reconcileState writes platforms.json")
it("reconcileState writes platforms/<id>.json")
it("reconcileState writes augments/<name>.json when toolDef provided")
it("reconcileState calls markEquipUpdated")
```

**3. End-to-end migration + CLI roundtrip (new file or in equip.test.js):**

```
it("legacy state.json users get migrated on first CLI run")
it("post-migration install writes only new files, not state.json")
it("post-migration uninstall reads from installations.json")
```

### 4.4 Verification Commands

After migration is complete, run these to confirm zero legacy references:

```bash
# No source files should import from state.ts (except migration.ts for types)
grep -rn "from.*['\"].*\/state['\"]" src/lib/ --include="*.ts" | grep -v migration.ts
# Expected: 0 results

# No source files should reference readState, writeState, trackInstall (old name), trackUninstall (old name)
grep -rn "readState\|writeState\|trackInstall[^a]\|trackUninstall[^a]\|markUpdated[^E]" src/ --include="*.ts"
# Expected: 0 results (trackInstallation/trackUninstallation won't match due to the [^a])

# No CLI files should require state module
grep -rn "require.*state" bin/ --include="*.js"
# Expected: 0 results

# state.ts should not exist
ls src/lib/state.ts
# Expected: file not found

# No test files should import from old state (except migration.test.js)
grep -rn "require.*dist/lib/state" test/ | grep -v migration
# Expected: 0 results
```

---

## 5. Migration Execution Order

Every step is independently committable and shippable. Tests must pass at each step.

### Step 1: Rewrite `reconcile.ts` to dual-write

**What:** Modify `reconcileState()` to call both old state functions AND new state functions. This is the bridge step.

**Changes:**
- `reconcile.ts`: After calling `trackInstall()` (old), also call `trackInstallation()` (new), `scanAllPlatforms()`, and `markEquipUpdated()`
- `reconcile.ts`: If `options.toolDef` is provided, call `syncFromRegistry()`
- Add `toolDef?: ToolDefinition` to `ReconcileOptions`

**Tests:** All existing tests pass. Add new tests verifying that new files are written alongside old files.

**Why dual-write:** This ensures the new state files are populated during normal CLI usage without breaking anything. Sidecar reads still work. Old reads still work.

---

### Step 2: Add `isPlatformEnabled()` filtering to `directInstall`

**What:** In `bin/equip.js`, filter detected platforms through `isPlatformEnabled()` before the install loop.

**Changes:**
- `bin/equip.js`: Add `isPlatformEnabled()` filter after `equip.detect()`, before `--platform` filter
- Add user-facing message when platforms are skipped

**Tests:** All existing tests pass. Add test for disabled platform being skipped.

**Risk:** Low. If `platforms.json` doesn't exist, `isPlatformEnabled()` returns `true` for all platforms (the default). Existing behavior preserved for users who haven't used the desktop app.

---

### Step 3: Add `syncFromRegistry()` call to `directInstall`

**What:** After fetching the tool definition, sync it to `~/.equip/augments/<name>.json`.

**Changes:**
- `bin/equip.js`: Add `syncFromRegistry(toolDef)` call after auth resolution

**Tests:** All existing tests pass. Add test verifying `augments/<name>.json` is created during install.

---

### Step 4: Add `isPlatformEnabled()` filtering to `unequip.js`

**What:** Uninstall respects disabled platforms.

**Changes:**
- `bin/unequip.js`: Read `isPlatformEnabled()` for each platform, skip disabled ones
- Report skipped platforms to user

**Tests:** All existing tests pass. Old state reads still work (unequip still reads state.json for platform list).

---

### Step 5: Update `checkStaleVersion()` to use `equip-meta`

**What:** Stop reading `state.json` in the stale version check.

**Changes:**
- `bin/equip.js`: Replace `readState()` with `readEquipMeta()` in `checkStaleVersion()`

**Tests:** All existing tests pass.

---

### Step 6: Rewrite `status.ts` to use new modules

**What:** Status command reads from `installations.json` instead of `state.json`.

**Changes:**
- `src/lib/commands/status.ts`: Replace `readState()` with `readInstallations()`, `readPlatformsMeta()`
- Show disabled platform indicator

**Tests:** All existing tests pass. Status output now shows disabled platforms.

---

### Step 7: Rewrite `doctor.ts` to use new modules

**What:** Doctor command reads from `installations.json` instead of `state.json`.

**Changes:**
- `src/lib/commands/doctor.ts`: Replace `readState()` with `readInstallations()`, `readPlatformsMeta()`, `readAugmentDef()`
- Skip checks for disabled platforms
- Check all skills (not just first)

**Tests:** All existing tests pass.

---

### Step 8: Rewrite `update.ts` and `migrate.ts` to use new modules

**What:** Update command and config migration read from `installations.json`.

**Changes:**
- `src/lib/commands/update.ts`: Replace `readState()` with `readInstallations()`, `markUpdated()` with `markEquipUpdated()`
- `src/lib/migrate.ts`: Replace `readState()` with `readInstallations()`, iterate by augment instead of by tool

**Tests:** All existing tests pass.

---

### Step 9: Rewrite `unequip.js` to use new modules entirely

**What:** Uninstall reads from `installations.json` instead of `state.json` for the platform list and artifact records.

**Changes:**
- `bin/unequip.js`: Replace `readState(), trackUninstall()` with `readInstallations(), trackUninstallation()`
- Derive artifact details from `InstallationRecord` + `AugmentDef`
- Call `scanAllPlatforms()` after uninstall

**Tests:** Update test references. All tests pass.

---

### Step 10: Remove dual-write from `reconcile.ts`

**What:** Stop writing to `state.json`. Reconcile now writes ONLY to new files.

**Changes:**
- `reconcile.ts`: Remove `import { trackInstall } from "./state"`
- `reconcile.ts`: Remove `trackInstall()` call
- `reconcile.ts`: Full rewrite to only use new modules

**Tests:** Update state-related tests. All tests pass.

---

### Step 11: Inline types and delete `state.ts`

**What:** Move `EquipState` and `ToolPlatformRecord` types into `migration.ts`. Delete `state.ts`.

**Changes:**
- `src/lib/migration.ts`: Add inline type definitions for legacy state format
- `src/lib/migration.ts`: Remove `import type { EquipState, ToolPlatformRecord } from "./state"`
- Delete `src/lib/state.ts`
- Remove any `state.ts` references from `tsconfig.json` (if explicitly listed)

**Tests:** Update all remaining test references. Run verification commands from Section 4.4. All tests pass.

---

### Step 12: Update test files

**What:** Rewrite all test references to use new modules.

**Changes:** See Section 4.1-4.3 for detailed changes per test file.

**Tests:** Full suite passes. Run verification grep commands.

---

### Step 13: Trigger one-time migration on CLI startup

**What:** The CLI should trigger `migrateState()` on first run, same as the sidecar does.

**Changes:**
- `bin/equip.js`: At the top of `main()`, before any command dispatch:

```javascript
// One-time migration from legacy state.json
try {
  const { migrateState } = require("../dist/lib/migration");
  const result = migrateState();
  if (result.migrated) {
    const { DIM, RESET } = require("../dist/lib/cli");
    process.stderr.write(`  ${DIM}Migrated state.json to new format (${result.augmentsCreated} augments, ${result.installationsCreated} installations)${RESET}\n`);
  }
} catch {}
```

**Tests:** Add test for CLI migration trigger.

---

## 6. Risk Assessment

### 6.1 Backward Compatibility: Users with existing `state.json`

**Risk:** Medium. Users who have been using equip have a `state.json` with their installation records. If we delete `state.ts` without migrating, they lose their installation tracking.

**Mitigation:** Step 13 adds `migrateState()` to CLI startup. This is already implemented and tested. It converts `state.json` to `installations.json` + `augments/*.json` + `equip.json` and renames `state.json` to `state.json.migrated`. Idempotent -- safe to run multiple times.

**Edge case:** User downgrades equip after migration. The old version expects `state.json` which has been renamed. They'd see an empty state. **Mitigation:** Leave `state.json.migrated` in place. If we wanted extra safety, we could keep `state.json` as a copy (not rename) during the transition period, but this adds complexity. Given that equip auto-updates and downgrades are rare, renaming is acceptable.

### 6.2 Mix of old and new state files

**Risk:** Low (with dual-write strategy). During Steps 1-9, both old and new files are written. The only risk is if the writes diverge (one succeeds, other fails). Since both are simple JSON writes to the same filesystem, this is unlikely.

**Edge case:** User has `installations.json` from a sidecar scan but `state.json` from CLI. They contain different data (sidecar migration may have missed something). **Mitigation:** `migrateState()` is idempotent -- if `installations.json` already exists, it skips. The sidecar's migration runs first if the user used the desktop app. The CLI's migration (Step 13) runs on next CLI invocation. Since `migrateState()` checks for `installations.json` existence, whichever runs first wins. This is correct behavior.

### 6.3 `isPlatformEnabled()` breaking existing workflows

**Risk:** Low. `isPlatformEnabled()` returns `true` if the platform is not in `platforms.json`. This means:
- Users who never used the desktop app: all platforms enabled (current behavior preserved).
- Users who used the desktop app and disabled a platform: that platform is skipped (new, intentional behavior).

**Edge case:** User disabled all platforms in the desktop app, then tries `equip install` from CLI. They get an error "no platforms available." This is correct -- they disabled everything.

### 6.4 `reconcileState()` scan performance

**Risk:** Low. Adding `scanAllPlatforms()` to the post-install path adds ~100-200ms of filesystem reads. This is acceptable given install already takes 1-2 seconds for auth + network + file writes.

### 6.5 Package-mode tools (npx spawn)

**Risk:** Low. Package-mode tools (`spawnTool()`) call `reconcileState()` after the child process exits. The rewritten `reconcileState()` will write new files alongside old files (during dual-write period), then only new files after. Package-mode tools don't interact with state directly -- they just run a child process and reconcile afterward.

### 6.6 `migration.ts` edge cases

**Scenario: Empty state.json**
```json
{ "equipVersion": "", "lastUpdated": "", "tools": {} }
```
Handled: `migrateState()` returns early with `migrated: false`.

**Scenario: Tool in state with no cached definition**
Handled: `createAugmentFromState()` creates a minimal stub definition from what state knows (transport, timestamps).

**Scenario: Tool in state with platforms that no longer exist in PLATFORM_REGISTRY**
Handled: Migration blindly copies platforms from state to installations. Doctor command will flag unknown platforms. Scan will skip them.

**Scenario: state.json is locked/unreadable**
Handled: `readStateFromPath()` catches errors and returns null. Migration returns `migrated: false`.

**Scenario: Partial migration (crash mid-write)**
Risk: Migration creates `installations.json` before renaming `state.json`. If crash happens between these steps, next run will see `installations.json` exists and skip (idempotent). But augment defs or equip.json may be missing. **Mitigation:** Acceptable -- the scan will populate platform files, and the next `equip install` will create the augment def via `syncFromRegistry()`. The only loss is some metadata (install timestamps) which is non-critical.

---

## 7. `registry.json`

### Current Purpose

`registry.json` is a static file shipped with the `@cg3/equip` npm package. It contains:

```json
{
  "$schema": "...",
  "$comment": "...",
  "prior": {
    "package": "@cg3/prior-node",
    "command": "setup",
    "description": "Prior — agent-centric shared knowledge base",
    "marker": "prior",
    "hookDir": "~/.prior/hooks",
    "skillName": "search"
  }
}
```

It serves TWO purposes:

1. **Package-mode fallback:** When a tool is not found via the registry API (`fetchToolDef`), the CLI checks `registry.json` for a package-mode entry (npm package + setup command). This is the original equip dispatch mechanism.

2. **`equip list` command:** Shows available tools from `registry.json`.

### Should it be kept, removed, or replaced?

**Decision: KEEP, but clarify its role.**

`registry.json` is NOT made redundant by `augments/*.json`. They serve different purposes:

| | `registry.json` | `augments/<name>.json` |
|---|---|---|
| Scope | Available tools (what CAN be installed) | Installed augments (what HAS been installed) |
| Source | Shipped with npm package | Created during install |
| Contains | Package name, setup command, marker | Full definition (transport, rules, skills, hooks) |
| Used by | `equip list`, package-mode dispatch fallback | Install flow, sidecar, desktop app |
| Mutability | Read-only | Read-write |

**`registry.json` is the offline tool catalog.** It's the answer to "what tools does equip know about?" without needing an API call. `augments/` is the answer to "what augments are configured locally?"

### Recommended Changes

1. **Rename `skillName` to `skillNames`** in registry.json entries (or accept array). The `skillName` field is deprecated in favor of `skillNames[]` across the codebase.

2. **Consider making it optional.** With `fetchToolDef()` checking the API first, `registry.json` is truly a fallback. If the API is comprehensive enough, `registry.json` could be removed in a future version. But for offline use and package-mode tools, it's still valuable.

3. **`equip list` should merge registry.json with augments/.** Show installed augments (from `augments/`) alongside available-but-not-installed tools (from `registry.json` + API). This is a future enhancement, not blocking for this migration.

---

## Summary: Migration Dependency Graph

```
Step 1: Dual-write in reconcile.ts
  |
  +-- Step 2: isPlatformEnabled in directInstall
  +-- Step 3: syncFromRegistry in directInstall
  +-- Step 4: isPlatformEnabled in unequip.js
  +-- Step 5: checkStaleVersion uses equip-meta
  |
  +-- Step 6: status.ts reads new modules
  +-- Step 7: doctor.ts reads new modules
  +-- Step 8: update.ts + migrate.ts read new modules
  |
  +-- Step 9: unequip.js reads new modules entirely
  |
Step 10: Remove dual-write (reconcile.ts writes only new files)
  |
Step 11: Inline types, delete state.ts
  |
Step 12: Update all tests
  |
Step 13: CLI migration trigger
```

Steps 2-5 can be done in any order (or parallel).
Steps 6-8 can be done in any order (or parallel).
Step 9 depends on Step 4.
Step 10 depends on Steps 6-9 (all reads must be migrated before dropping old writes).
Step 11 depends on Step 10.
Steps 12-13 can be done alongside or after Step 11.

**Total: 13 steps, each independently testable and committable.**
