# Equip State Architecture Redesign

**Goal:** Restructure `~/.equip/` state files to serve both the CLI and the desktop UI, with platform-centric views, disabled platform support, and clear separation of concerns.

---

## Why the Current Structure Exists

The current `state.json` is tool-centric because the CLI's primary operation is tool-centric:

```bash
equip prior    # "install this tool on all detected platforms"
```

The natural question the CLI asks after install is: *"Where is Prior installed?"* → look at `tools.prior.platforms`. The CLI never needs to ask *"What's on Claude Code?"* — it doesn't have a view for that.

The state is also written only by `reconcileState()`, which iterates by tool name (it's called with `{ toolName: "prior" }` and scans all platforms for that specific tool). So the tool-centric structure matches the write pattern.

**This was a reasonable design for a CLI tool.** But the desktop UI inverts the primary question:

| CLI asks | UI asks |
|----------|---------|
| "Where is Prior installed?" | "What's on Claude Code?" |
| "Install Prior everywhere" | "Show me my loadout" |
| (no concept) | "Is this platform running?" |
| (no concept) | "How much weight am I carrying?" |
| (no concept) | "Disable Cursor, don't touch it" |

---

## Proposed File Structure

```
~/.equip/
├── platforms.json              # Platform metadata + user preferences (enabled/disabled)
├── platforms/                  # Per-platform scan results — what's configured on each
│   ├── claude-code.json
│   ├── cursor.json
│   ├── codex.json
│   └── ...
├── installations.json          # What equip has installed, where
├── equip.json                  # Equip-level metadata (version, timestamps, preferences)
├── sets.json                   # Saved augment sets (future)
├── augments/                   # Augment definitions — the single source of truth
│   ├── prior.json              #   registry augment (synced from equip-server)
│   ├── my-custom-tool.json     #   local augment (user-created)
│   └── wrapped-unknown.json    #   local augment (wrapped from unmanaged MCP entry)
├── credentials/
│   └── prior.json              # Per-tool credentials (unchanged)
├── cache/
│   └── prior.json              # Raw registry responses (unchanged, used for offline fetch)
└── app/                        # Desktop app owns this directory exclusively
    ├── preferences.json
    └── window.json
```

### How the Pieces Relate

```
augments/           "What things exist and how to install them" (definitions)
                     ↓ (equip reads definition, generates platform-specific config)
platform configs    "What's actually written to each editor's config file" (on disk)
                     ↓ (scan reads configs)
platforms/          "What's configured on each platform" (scan results, per-platform files)

platforms.json      "What platforms exist, capabilities, enabled/disabled" (metadata)
installations.json  "What did equip put where" (action log, for uninstall + drift)
```

- `augments/` is the recipe
- `installations.json` is what you cooked
- `platforms/` is what's on each plate (including things someone else put there)
- `platforms.json` is the list of plates and what kind they are

### Why Per-Platform Files (Not One Big Inventory)

| Concern | Per-platform files | Single file |
|---------|-------------------|-------------|
| Install Prior on Claude Code | Update `platforms/claude-code.json` only | Rewrite the entire inventory |
| Corrupt write | Lose one platform's data | Lose all platform data |
| Incremental scan | Update only changed platforms | Rewrite everything |
| UI rendering | Each file maps 1:1 to an Agents tab card | Parse one file, filter by platform |
| Unmanaged augments | Naturally included — they exist on that platform | Same, but in a bigger structure |

### Migration Path

The current `state.json` continues to work during the transition. New files are written alongside it. Once the migration is complete, `state.json` becomes a legacy file that's no longer read.

---

## `platforms.json` — Platform Metadata & Preferences

This is the lightweight index of all detected platforms with their capabilities and user preferences. It does NOT contain what's installed on each platform — that lives in per-platform files under `platforms/`.

```json
{
  "lastScanned": "2026-04-01T10:00:00Z",
  "platforms": {
    "claude-code": {
      "detected": true,
      "enabled": true,
      "name": "Claude Code",
      "configPath": "C:\\Users\\charl\\.claude.json",
      "configPathShort": "~/.claude.json",
      "configFormat": "json",
      "capabilities": ["MCP", "Rules", "Hooks", "Skills"]
    },
    "cursor": {
      "detected": true,
      "enabled": true,
      "name": "Cursor",
      "configPath": "C:\\Users\\charl\\.cursor\\mcp.json",
      "configPathShort": "~/.cursor/mcp.json",
      "configFormat": "json",
      "capabilities": ["MCP", "Skills"]
    },
    "windsurf": {
      "detected": true,
      "enabled": false,
      "disabledAt": "2026-04-01T12:00:00Z",
      "name": "Windsurf",
      "configPath": "C:\\Users\\charl\\.codeium\\windsurf\\mcp_config.json",
      "configPathShort": "~/.codeium/windsurf/mcp_config.json",
      "configFormat": "json",
      "capabilities": ["MCP", "Rules", "Skills"]
    }
  }
}
```

**What belongs here:**
- Platform detection results (detected, name, config paths, format)
- Platform capabilities (derived from PLATFORM_REGISTRY)
- User preferences (enabled/disabled, disabled timestamp)
- Scan timestamp

**What does NOT belong here:**
- What augments are configured on each platform (→ `platforms/<id>.json`)
- What equip installed (→ `installations.json`)
- Augment definitions (→ `augments/<name>.json`)

This file changes rarely — only when platforms are detected/lost or the user toggles enabled/disabled.

---

## `platforms/<id>.json` — Per-Platform Scan Results

Each detected platform gets its own file containing everything that's currently configured on it. This is the result of reading the platform's actual config file.

```json
// ~/.equip/platforms/claude-code.json
{
  "lastScanned": "2026-04-01T10:00:00Z",
  "augments": {
    "prior": {
      "transport": "http",
      "url": "https://api.cg3.io/mcp",
      "managed": true,
      "artifacts": {
        "mcp": true,
        "rules": "0.6.0",
        "hooks": ["prior-handler.js"],
        "skills": ["search"]
      }
    },
    "some-unknown-server": {
      "transport": "stdio",
      "command": "npx some-random-tool",
      "managed": false
    }
  },
  "augmentCount": 2,
  "managedCount": 1
}
```

```json
// ~/.equip/platforms/cursor.json
{
  "lastScanned": "2026-04-01T10:00:00Z",
  "augments": {
    "prior": {
      "transport": "http",
      "url": "https://api.cg3.io/mcp",
      "managed": true,
      "artifacts": {
        "mcp": true,
        "skills": ["search"]
      }
    }
  },
  "augmentCount": 1,
  "managedCount": 1
}
```

### What's in Each Augment Entry

| Field | Source | Description |
|-------|--------|------------|
| `transport` | Read from config file | `"http"` or `"stdio"` (derived: has `command` field → stdio, else http) |
| `url` | Read from config file | Server URL (for HTTP transport) |
| `command` | Read from config file | Command (for stdio transport) |
| `managed` | Cross-reference with `installations.json` | Did equip install this? |
| `artifacts.mcp` | Read from config file | MCP entry exists |
| `artifacts.rules` | Read from rules file | Rules version from marker block, or absent |
| `artifacts.hooks` | Read from hook directory | List of hook script filenames, or absent |
| `artifacts.skills` | Read from skill directory | Array of installed skill names, or absent |

### How `managed` Is Determined

During a scan, for each augment entry found in a platform's config file:

1. Check `installations.json` — does it list this augment on this platform? → `managed: true`
2. Check `augments/<name>.json` — does a local/wrapped definition exist? → `managed: true`
3. Otherwise → `managed: false`

An augment can be `managed: false` and still be fully visible in the UI. It just means equip didn't put it there. The user might choose to wrap it (creating an augment definition), at which point it becomes managed.

### When Per-Platform Files Are Written

| Trigger | What Happens |
|---------|-------------|
| `equip install <tool>` | Re-scan affected platforms, update their files |
| `equip uninstall <tool>` | Re-scan affected platforms, update their files |
| Full scan (app launch, manual refresh) | Update all platform files |
| Platform not detected anymore | File remains (stale data) with platform marked `detected: false` in platforms.json |
| Platform disabled | File still updated by scans (read-only operation), but writes to the platform's config are blocked |

### Benefits of Per-Platform Files

- **Agents tab**: Read `platforms.json` for the list, read `platforms/<id>.json` for each card's augment details
- **Equip page**: Read all `platforms/*.json` files, merge augments across platforms to build the loadout view
- **Weight bar**: Sum estimated weights from all `platforms/*.json` augments on enabled platforms
- **Install/uninstall**: Only rewrite the affected platform's file
- **Drift detection**: Compare `platforms/<id>.json` (disk reality) against `installations.json` (equip's memory)

---

## `installations.json` — What Equip Installed

This is equip's record of what IT installed (vs what was manually configured). It's the source of truth for the `managed` flag in `platforms/<id>.json` scan files.

```json
{
  "lastUpdated": "2026-04-01T10:00:00Z",
  "augments": {
    "prior": {
      "source": "registry",
      "package": "prior",
      "displayName": "Prior — Agent Knowledge Base",
      "transport": "http",
      "serverUrl": "https://api.cg3.io/mcp",
      "installedAt": "2026-03-29T20:51:09Z",
      "updatedAt": "2026-03-31T05:26:50Z",
      "platforms": ["claude-code", "cursor", "vscode", "codex", "junie", "copilot-cli"],
      "artifacts": {
        "claude-code": {
          "mcp": true,
          "rules": "0.6.0",
          "hooks": ["prior-handler.js"],
          "skills": ["search"]
        },
        "cursor": {
          "mcp": true,
          "skills": ["search"]
        },
        "vscode": {
          "mcp": true,
          "skills": ["search"]
        },
        "codex": {
          "mcp": true,
          "rules": "0.6.0",
          "skills": ["search"]
        },
        "junie": {
          "mcp": true
        },
        "copilot-cli": {
          "mcp": true
        }
      }
    }
  }
}
```

### Why Keep This Separate From platforms.json

`platforms.json` is refreshed by scanning. It reflects reality on disk.

`installations.json` is equip's memory of what IT did. It's needed for:

1. **The `managed` flag** — when platforms.json scans and finds "prior" on Claude Code, it checks installations.json to determine if equip put it there.

2. **Uninstall** — `equip uninstall prior` needs to know what platforms to clean up. It reads installations.json, not platforms.json.

3. **Drift detection** — Compare installations.json (what equip thinks it installed) against platforms.json (what's actually on disk). Mismatch = drift.

4. **Augment metadata** — Display name, source package, install/update timestamps. This doesn't belong in the platform scan results.

### The Platform List in installations.json

`platforms: ["claude-code", "cursor", ...]` is the list of platforms where equip installed this augment. This is the "reverse index" — useful for quickly answering "is Prior installed anywhere?" without scanning all platforms.

The `artifacts` object breaks down what was installed per platform (MCP entry, rules version, hooks, skills). Not all platforms get all artifacts — it depends on platform capabilities.

---

## `equip.json` — Equip-Level Metadata

```json
{
  "version": "0.16.1",
  "lastUpdated": "2026-04-01T10:00:00Z",
  "lastScan": "2026-04-01T10:00:00Z",
  "preferences": {
    "telemetry": true,
    "autoScan": true,
    "scanIntervalMinutes": 60
  }
}
```

Small, simple, rarely changes. Separated from the larger state files so preferences aren't lost if a scan goes wrong.

---

## `augments/` — Augment Definitions (Single Source of Truth)

### The Problem Today

Currently there is no local source of truth for what an augment IS. When you `equip prior`, the CLI fetches the tool definition from the registry API, generates platform-specific config entries, writes them directly to each platform's config file, and caches the registry response in `~/.equip/cache/prior.json` (treated as disposable).

This means:
- **No local augments** — there's nowhere to define a custom MCP server that equip should manage
- **No editing** — you can't customize an augment's rules or behavior locally
- **No offline re-install** — if the cache is cleared and the registry is unreachable, equip can't reinstall
- **No single definition** — the "truth" is scattered across platform config files, each with platform-specific field names

### The Solution: `~/.equip/augments/<name>.json`

Each augment gets a persistent definition file. This is the single source of truth for what the augment is and how to install it on any platform.

```json
{
  "name": "prior",
  "source": "registry",
  "displayName": "Prior — Agent Knowledge Base",
  "description": "Search solutions other agents already found.",
  "transport": "http",
  "serverUrl": "https://api.cg3.io/mcp",
  "requiresAuth": true,
  "envKey": "PRIOR_API_KEY",

  "rules": {
    "content": "## Prior — Knowledge Exchange\n\nYou have access to Prior...",
    "version": "0.6.0",
    "marker": "prior"
  },

  "skills": [
    { "name": "search", "files": [{ "path": "SKILL.md", "content": "..." }] },
    { "name": "contribute", "files": [{ "path": "SKILL.md", "content": "..." }] }
  ],

  "hooks": [
    { "event": "PostToolUseFailure", "name": "prior-handler", "script": "..." }
  ],

  "weight": 1200,
  "registryVersion": "0.6.0",
  "syncedAt": "2026-04-01T10:00:00Z",
  "createdAt": "2026-04-01T10:00:00Z",
  "updatedAt": "2026-04-01T10:00:00Z"
}
```

### Three Sources of Augments

| Source | How It Gets There | Updatable? |
|--------|-------------------|-----------|
| **`registry`** | `equip install prior` syncs definition from equip-server | Yes — `equip update` re-syncs |
| **`local`** | User creates via CLI or desktop app | User edits directly |
| **`wrapped`** | User wraps an unmanaged MCP entry in the desktop app | User edits directly |

### Augment Definition Has Two Layers

An augment definition has a clear split between what's fixed and what's customizable:

**Infrastructure (from the publisher, not editable):**
- `serverUrl` — the MCP server endpoint
- `transport` — HTTP or stdio
- `requiresAuth` / `envKey` — authentication requirements
- `stdio.command` / `stdio.args` — for stdio transport

Changing these would make it a different augment. If the server URL changes, it's the publisher who changes it via a registry update, not the user.

**Behavioral (customizable by the user):**
- `rules` — instructions for the agent (when to search, how to contribute, etc.)
- `hooks` — lifecycle event handlers
- `skills` — skill definitions
- `weight` — estimated token overhead (user might have a better estimate)

Users should be able to customize the behavioral layer while keeping the infrastructure intact.

### Modding: Custom Behavioral Overrides

When a user modifies a registry augment's rules (or hooks, or skills), the definition becomes "modded":

```json
{
  "name": "prior",
  "source": "registry",
  "modded": true,
  "moddedAt": "2026-04-01T14:00:00Z",
  "moddedFields": ["rules"],

  "serverUrl": "https://api.cg3.io/mcp",
  "transport": "http",

  "rules": {
    "content": "## Prior\n\nOnly search Prior when truly stuck, not on every error...",
    "version": "0.6.0-modded",
    "marker": "prior"
  },

  "rulesUpstream": {
    "content": "## Prior\n\nSearch Prior FIRST when you hit ANY error...",
    "version": "0.6.0"
  },

  "registryVersion": "0.6.0",
  "syncedAt": "2026-04-01T10:00:00Z"
}
```

**Key fields:**
- `modded: true` — signals that this definition has local modifications
- `moddedFields` — which behavioral fields were changed
- `rulesUpstream` — the original registry version, preserved for diffing and resetting
- `rules` — the user's version (this is what gets installed on platforms)

### Update Behavior for Modded Augments

When the registry pushes an update (e.g., Prior rules go from 0.6.0 to 0.7.0):

1. Equip detects the upstream version changed (`registryVersion` < registry's version)
2. Updates `rulesUpstream` to the new registry content
3. Does NOT overwrite the user's `rules` — their modifications are preserved
4. Flags the augment for user attention in the UI

The UI shows: *"Prior rules updated upstream (0.6.0 → 0.7.0). You have local modifications."*

Options presented:
- **Keep mine** — no change, user's version stays
- **Reset to upstream** — discard modifications, adopt new version
- **Review diff** — show what changed upstream vs what the user modified (future)

### Local Augments

For user-created augments that aren't from the registry:

```json
{
  "name": "my-project-tools",
  "source": "local",
  "displayName": "My Project Tools",
  "description": "Custom MCP server for my internal tools",
  "transport": "stdio",
  "stdio": {
    "command": "node",
    "args": ["/home/user/projects/my-tools/server.js"],
    "envKey": null
  },
  "requiresAuth": false,
  "rules": null,
  "weight": 600,
  "createdAt": "2026-04-01T...",
  "updatedAt": "2026-04-01T..."
}
```

No `modded` flag (there's no upstream to differ from). No `registryVersion` or `syncedAt`. The user owns everything.

**Creation flows:**
- CLI: `equip create my-tool --transport stdio --command "node server.js"` (future)
- Desktop app: "Create Local Augment" form
- Desktop app: "Wrap as Augment" on an unmanaged MCP entry (reads existing config, creates definition)

### Wrapping Unmanaged MCP Entries

When the scan finds an MCP server that isn't in `augments/`, it shows as unmanaged. The user can wrap it:

1. Equip reads the existing entry from the platform config (URL, transport, command, etc.)
2. Creates `~/.equip/augments/<name>.json` with `source: "wrapped"`
3. The entry is now managed — trackable, weight-measurable, includable in sets
4. If it's configured on multiple platforms already, equip recognizes it across all of them

```json
{
  "name": "some-mcp-server",
  "source": "wrapped",
  "displayName": "some-mcp-server",
  "description": "",
  "transport": "http",
  "serverUrl": "http://localhost:8080",
  "requiresAuth": false,
  "wrappedFrom": "claude-code",
  "weight": 400,
  "createdAt": "2026-04-01T..."
}
```

`wrappedFrom` records which platform the definition was extracted from (informational only).

### How Install Uses Augment Definitions

Updated install flow:

```
equip install prior
  1. If augments/prior.json doesn't exist:
     a. Fetch definition from registry
     b. Write to augments/prior.json (source: "registry")
  2. Read augments/prior.json (the local source of truth)
  3. Resolve auth from credentials/
  4. Detect platforms → filter disabled
  5. For each platform:
     a. Generate platform-specific config from the definition
        (translate serverUrl to platform's urlField, format headers, etc.)
     b. Write to platform config file
     c. Install rules from definition (user's version if modded)
     d. Install hooks/skills from definition
  6. Update installations.json
  7. Re-scan → update platforms.json
```

The augment definition is the input. Platform configs are the output.

### Cache vs Augment Definition

`~/.equip/cache/prior.json` still exists as the raw registry API response cache. It's used for:
- Offline `equip install` when the API is unreachable (fallback fetch)
- Comparing local definition against latest registry version
- Metadata not stored in the augment definition (install count, rarity, publisher info)

`~/.equip/augments/prior.json` is the operational definition — what equip actually uses to install. It's derived from the cache on first install, then lives independently (especially if modded).

---

## The Disabled Platform Question

### What "Disabled" Means

A disabled platform is one where equip will not read, write, or modify anything. It's "hands off."

### Behavior Matrix

| Action | Enabled Platform | Disabled Platform |
|--------|-----------------|-------------------|
| `equip install prior` | Install on this platform | Skip silently |
| `equip uninstall prior` | Remove from this platform | **Skip — leave it alone** |
| `equip update prior` | Update on this platform | Skip |
| `equip status` | Show in status output | Show as disabled |
| `equip doctor` | Check for drift/health | Skip checks |
| Sidecar `scan` | Scan config, report augments | Still detect and report, but flag as disabled |
| UI Agents page | Show normally | Show grayed out with "Disabled" badge |
| UI Equip page | Include in augment status | Exclude from weight calculation |

### The Uninstall-While-Disabled Scenario

> "I install Prior on [Claude Code, Cursor]. I disable Cursor. I uninstall Prior. What happens?"

**Answer:** Prior is removed from Claude Code only. Cursor is untouched. Prior's config entry remains in Cursor's MCP config file.

**Why:** Disabled means "don't touch." The user disabled Cursor for a reason — maybe they're manually managing it, maybe it's in a weird state, maybe they just don't want equip modifying it right now. Respecting that boundary is more important than clean uninstall semantics.

**What the UI shows:** After the uninstall, the Equip page shows Prior as "not equipped" (removed from all enabled platforms). The Agents page shows Cursor (disabled, grayed out) still has Prior configured — visible but not actionable.

### Re-Enabling

When the user re-enables Cursor:
- The next scan picks up whatever's on disk (Prior is still there if they didn't manually remove it)
- platforms.json updates to show Cursor as enabled with Prior as a `managed: false` augment (since installations.json no longer lists Cursor under Prior's platforms)
- If they want equip to manage it again, they `equip install prior` — it installs (or recognizes it's already there and reconciles)

### Implementation

Disabled state is persisted in `platforms.json`:
```json
"cursor": {
  "detected": true,
  "enabled": false,
  "disabledAt": "2026-04-01T12:00:00Z",
  ...
}
```

The CLI and sidecar both check `enabled` before any write operation. The scan still runs (so the UI can show what's there) but install/uninstall skip disabled platforms.

---

## How Install/Uninstall Work With the New Structure

### Install Flow

```
equip install prior
  1. Resolve tool definition (API → cache → registry)
  2. Resolve auth (prompt or read from credentials/)
  3. Detect platforms (detect())
  4. Read platforms.json → filter out disabled platforms
  5. For each enabled, detected platform:
     a. Augment.installMcp() → write to config file
     b. Augment.installRules() → write rules block
     c. Augment.installSkill() → copy skill dir
  6. Write installations.json:
     - Add/update "prior" entry
     - Add platforms to the platforms list
     - Record per-platform artifacts
  7. Re-scan → write platforms.json:
     - Refresh augment lists from disk
     - Mark "prior" as managed: true on each platform
  8. Telemetry (fire-and-forget)
```

### Uninstall Flow

```
equip uninstall prior
  1. Read installations.json → get platforms list for "prior"
  2. Read platforms.json → filter out disabled platforms
  3. For each enabled platform where prior is installed:
     a. Augment.uninstallMcp() → remove from config file
     b. Augment.uninstallRules() → remove rules block
     c. Augment.uninstallSkill() → remove skill dir
  4. Update installations.json:
     - Remove uninstalled platforms from the list
     - If no platforms remain, remove the augment entry entirely
     - If disabled platforms still have it, keep the entry with only those platforms
  5. Re-scan → write platforms.json:
     - Prior no longer appears on enabled platforms
     - Prior still appears on disabled platforms (unmodified)
```

---

## What About "Augments Per Platform" Granularity?

The current CLI has `--platform` to target specific platforms:

```bash
equip prior --platform claude-code,cursor   # only these two
```

The UI will want this too — "install Prior on Claude Code but not Cursor." The data model supports it naturally:

- `installations.json.augments.prior.platforms` lists exactly where equip installed it
- `platforms.json.platforms.*.augments.prior.managed` confirms it per-platform
- The UI can present checkboxes per platform during install

The disabled flag is a separate concern from selective install. Disabled means "never touch this platform for any reason." Selective install means "install this specific tool on these specific platforms."

---

## Scan Behavior

### When Should Scanning Happen?

| Trigger | What Gets Scanned | What Gets Written |
|---------|-------------------|-------------------|
| App launch | Full scan (all platforms, all configs) | platforms.json |
| Navigate to Agents tab | Read platforms.json (cached) | Nothing (unless stale) |
| After install/uninstall | Full re-scan | platforms.json + installations.json |
| User clicks "Refresh" | Full scan | platforms.json |
| Window gains focus | Only if >60s since last scan | platforms.json |
| CLI `equip install/uninstall` | Full scan (reconcile) | platforms.json + installations.json |

### Scan vs Read

**Scan** = walk filesystem, read all config files, write results to platforms.json. Expensive (~500ms with sidecar spawn).

**Read** = read platforms.json from disk. Instant (<1ms).

The UI should read on every render, scan only on specific triggers. The `lastScanned` timestamp in platforms.json tells the UI how fresh the data is.

---

## Migration From Current state.json

### Phase 1: Write New Files Alongside

- The sidecar writes `platforms.json` after every scan (new behavior)
- The CLI continues writing `state.json` as before (no breaking changes)
- The UI reads `platforms.json` (new files only)
- `installations.json` is derived from `state.json` on first run (one-time migration)

### Phase 2: CLI Writes Both

- The CLI writes both `state.json` and `installations.json` on install/uninstall
- The CLI reads `platforms.json` for the disabled flag
- `state.json` becomes redundant but is still written for backward compatibility

### Phase 3: Drop state.json

- Remove `state.json` reads from the CLI
- Only `platforms.json`, `installations.json`, `equip.json` are used
- `state.json` left on disk but no longer modified

---

## Decisions (Resolved)

### 1. Who owns writes to `~/.equip/`?

**Decision: The equip library owns ALL writes.** The desktop app never writes to `~/.equip/` directly. All mutations flow through the sidecar, which uses the same equip library functions as the CLI.

```
UI → Tauri invoke → Rust → sidecar (equip library) → writes to ~/.equip/
CLI → equip library → writes to ~/.equip/
```

Same library, same write path, no dual-writer conflicts.

The desktop app writes app-specific state (UI preferences, dismissed notifications, view state) to `~/.equip/app/`. This is the app's private directory — the equip library never reads or writes it. Clean boundary: equip library owns `~/.equip/*.json`, the desktop app owns `~/.equip/app/`.

```
~/.equip/
├── platforms.json          # equip library owns
├── installations.json      # equip library owns
├── equip.json              # equip library owns
├── credentials/            # equip library owns
├── cache/                  # equip library owns
└── app/                    # desktop app owns
    ├── preferences.json    # UI preferences (sort, view mode, dismissed tips)
    ├── window.json         # Window position, size, last active tab
    └── ...                 # Any other app-specific state
```

New operations the UI needs (like disabling a platform) are added to the equip library and exposed through the sidecar. The library is the single authority on `~/.equip/` contents outside of `app/`.

### 2. Should unmanaged augments show in the UI?

**Decision: Yes, absolutely.** Exposing unmanaged MCP servers is a core value proposition of Equip — users need to see everything consuming their agent's context, not just things equip installed.

Unmanaged augments show as "Unknown Augment" with basic info (server name, transport, URL/command) and a default Common rarity badge. Carry weight is estimated heuristically.

**Future direction: Local Augments.** Users can "wrap" an unmanaged MCP server as a Local Augment — giving it a name, description, and explicit weight. Stored in `~/.equip/local/my-tool.json`. This makes it fully visible, manageable, and includable in sets without publishing to the registry. The data model should accommodate this (a `source` field: `"registry"` | `"local"` | `"unknown"`).

### 3. Should disabled platforms still be scanned?

**Decision: Yes.** Scanning is read-only — it doesn't modify config files. Scanning disabled platforms lets the UI show "Cursor (disabled) — 3 augments configured" which is informative. Users need to see what's there even if they've told equip not to touch it.

The disabled flag only affects write operations (install/uninstall/update). Reads are always allowed.

### 4. Per-platform granularity?

**Decision: Defer the UI, design the data model for it.** The `installations.json` schema already supports per-platform tracking (`platforms` array + per-platform `artifacts`). The CLI's `--platform` flag already works. We won't build selective-install UI yet, but the data model won't need restructuring when we do.

Filter order when implemented: detect → filter disabled → filter by user selection → install.
