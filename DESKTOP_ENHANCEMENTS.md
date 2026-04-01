# Equip Library — Desktop App Enhancement Tracker

## How Equip Works Today

### Architecture Summary

Equip has three layers:

1. **`Augment` class** (stateless) — Reads/writes platform config files (MCP, rules, hooks, skills). Never touches state. This is the "hands" — it modifies files on disk but doesn't remember what it did.

2. **`reconcileState()`** (state writer) — Scans all platform configs after an install and records what's actually on disk into `~/.equip/state.json`. This is the "memory" — it runs after the Augment class does its work and persists what happened.

3. **CLI (`bin/equip.js`)** (orchestrator) — Parses commands, resolves auth, detects platforms, calls the Augment class per-platform, then calls reconcileState(). This is the "brain" — it decides what to do and coordinates the other two.

**Key insight for the UI:** The Augment class and reconcileState() are independently usable. The CLI is just one orchestrator — the desktop app sidecar is another.

### CLI Commands

| Command | What It Does | Reads | Writes |
|---------|-------------|-------|--------|
| `equip <tool>` | Installs tool on all detected platforms (MCP + rules + hooks + skills) | Platform configs, registry, API/cache | Platform configs, state.json, credentials |
| `equip status` | Shows all MCP servers across all platforms, tagged as "equip" or "manual" | All platform configs, state.json | Nothing |
| `equip doctor` | Validates config integrity — checks drift, auth, file health | All platform configs, state.json, credentials | Nothing |
| `equip update [tool]` | Self-updates equip or updates a specific tool | npm registry, state.json | state.json (timestamps), platform configs (if tool updated) |
| `equip uninstall <tool>` | Removes tool from all platforms | State.json, platform configs | Platform configs, state.json |
| `equip list` | Shows registered tools from registry.json | registry.json | Nothing |
| `equip reauth <tool>` | Re-authenticates and rotates credentials | Credentials, validation URL | Credentials, platform configs (new key) |
| `equip refresh [tool]` | Refreshes expired OAuth tokens | Credentials | Credentials, platform configs |
| `equip demo` | Runs interactive demo | Nothing | Demo files (cleaned up) |
| (no args) | Defaults to `equip status` | Same as status | Nothing |

### State File (`~/.equip/state.json`)

```json
{
  "equipVersion": "0.16.1",
  "lastUpdated": "2026-03-31T04:49:33.283Z",
  "tools": {
    "prior": {
      "package": "prior",
      "installedAt": "2026-03-29T20:51:09.380Z",
      "updatedAt": "2026-03-31T05:26:50.266Z",
      "platforms": {
        "claude-code": {
          "configPath": "C:\\Users\\charl\\.claude.json",
          "transport": "http",
          "rulesPath": "C:\\Users\\charl\\.claude\\CLAUDE.md",
          "rulesVersion": "0.6.0",
          "hookDir": "C:\\Users\\charl\\.prior\\hooks",
          "hookScripts": ["prior-handler.js"],
          "skillsPath": "C:\\Users\\charl\\.claude\\skills\\prior",
          "skillName": "search",
          "equipVersion": "0.16.1"
        },
        "cursor": {
          "configPath": "C:\\Users\\charl\\.cursor\\mcp.json",
          "transport": "http",
          "equipVersion": "0.16.1",
          "skillsPath": "C:\\Users\\charl\\.cursor\\skills\\prior",
          "skillName": "search"
        }
      }
    }
  }
}
```

**State is organized by tool, then by platform.** The UI often needs the inverse (by platform, then by tool). This is a structural mismatch.

**State is only written by:** `reconcileState()` (after CLI install/uninstall) and `markUpdated()` (after `equip update`). The Augment class never touches it.

**State tracks:** What equip installed. It does NOT track:
- Manually installed MCP servers (not known to equip)
- Platform capabilities (derived from PLATFORM_REGISTRY at runtime)
- Carry weight / token overhead
- Whether platforms are currently running
- Augment metadata from the registry (name, description, rarity, etc.)

### Credential Storage (`~/.equip/credentials/`)

Per-tool JSON files. Contains API keys, OAuth tokens, refresh tokens, expiry timestamps. Stored as plain JSON with chmod 600 on Unix. Not encrypted.

### Platform Detection

Filesystem-first: checks for platform directories (`~/.claude/`, `~/.cursor/`, etc.) before falling back to CLI checks (`which claude`). Returns `DetectedPlatform` with config path, rules path, skills path, root key, and config format. Does NOT persist detection results — computed fresh every time.

### Platform Registry (Hardcoded)

13 platforms with per-platform variations:
- Config paths (all different)
- Config format (12 JSON, 1 TOML)
- HTTP field names (`url` vs `serverUrl` vs `httpUrl`, `headers` vs `http_headers`)
- Rules support (8 have it, 5 don't)
- Hook support (only Claude Code)
- Skills support (9 have it, 4 don't)
- Detection strategy (dirs/files to check, CLI name)

### What the CLI Persists vs Computes

| Data | Persisted? | Where | Computed Fresh? |
|------|-----------|-------|----------------|
| Installed tools + platforms | Yes | state.json | Also via reconcile |
| Platform detection | No | — | Every time via detect() |
| Platform capabilities | No | — | Derived from PLATFORM_REGISTRY |
| MCP server list per platform | No | — | Read from config files |
| Credentials | Yes | credentials/*.json | — |
| Tool definitions | Cached | cache/*.json | Fetched from API |
| Verify results | No | — | Computed by verify() |
| Doctor results | No | — | Computed on demand |
| Carry weight | No | — | Not implemented |
| Running processes | No | — | Not implemented |

---

## Gaps for Desktop UI

### Gap 1: No Persisted Scan Results

**Current:** Platform detection and MCP config reading happen live every time. The sidecar spawns, scans the filesystem, reads configs, and returns. Nothing cached.

**Problem for UI:** Every navigation to the Agents tab triggers a full scan (~500ms including sidecar spawn). The UI can't show anything until the scan completes.

**Enhancement:** Write scan results to `~/.equip/scan.json` after every scan. The UI reads this on launch for instant rendering, then triggers a background refresh.

**Priority:** High

---

### Gap 2: Tool-Centric State vs Platform-Centric UI

**Current:** `state.json` is organized as `tools.prior.platforms.claude-code`. To answer "what's on Claude Code?" the UI must iterate all tools and check each one's platforms.

**Problem for UI:** The Equip page and Agents page both need platform-centric views. Inverting the data structure on every render is wasteful and error-prone.

**Enhancement:** Either:
- (A) Write `~/.equip/platforms.json` with the inverted view (CLI writes on install/uninstall)
- (B) The sidecar provides a `scan` method that returns platform-centric data (current approach)
- (C) The UI transforms the state client-side

**Recommendation:** Keep (B) for the sidecar response, but also consider (A) so the UI can read cold data on launch without spawning the sidecar.

**Priority:** Medium

---

### Gap 3: No Process Detection

**Current:** Equip has no concept of whether a platform is currently running. After installing an augment, there's no way to warn the user that they need to restart their editor.

**Problem for UI:** This is the #1 source of user confusion — "I equipped something but it doesn't work." The Agents tab needs running-state indicators and the Equip page needs post-equip warnings.

**Enhancement:** Add a `running` sidecar method that checks for running processes by platform. Platform-specific process names:

| Platform | Process Names (Windows) | Process Names (macOS/Linux) |
|----------|------------------------|----------------------------|
| Claude Code | `claude.exe` | `claude` |
| Cursor | `Cursor.exe` | `Cursor` |
| VS Code | `Code.exe` | `code` |
| Windsurf | `Windsurf.exe` | `windsurf` |

**Implementation:** `tasklist` on Windows, `ps` or `/proc` on Unix. Cached for 10 seconds (don't re-scan on every UI interaction).

**Priority:** High

---

### Gap 4: No Install/Uninstall via Sidecar

**Current:** The sidecar can scan and report, but can't modify anything. All mutations go through the CLI.

**Problem for UI:** The Equip page can't equip or unequip augments without this. It's the core functionality.

**Enhancement:** Add `install` and `uninstall` methods to the sidecar that use the `Augment` class + `reconcileState()`:

```
method: "install"
params: { tool, platforms, transport, serverUrl, apiKey }
→ creates Augment instance, calls installMcp + installRules + installSkill per platform
→ calls reconcileState()
→ returns per-platform results

method: "uninstall"
params: { tool, platforms }
→ calls uninstallMcp + uninstallRules + uninstallSkill per platform
→ calls reconcileState()
→ returns per-platform results
```

**Depends on:** Auth resolution. The sidecar either needs credentials passed in, or needs to read from `~/.equip/credentials/`.

**Priority:** High

---

### Gap 5: No Config Drift Detection

**Current:** `doctor` command checks for drift (state says tool is installed but config doesn't have it, or vice versa). But it's CLI-only output, not structured data.

**Problem for UI:** The Agents/Equip pages should show warnings when state diverges from disk reality. Currently the sidecar does a fresh scan which returns actual disk state, but doesn't compare against `state.json` to identify the delta.

**Enhancement:** Add a `drift` sidecar method or include drift info in the `scan` response:

```
drifts: [
  { platform: "cursor", tool: "prior", issue: "in_state_not_on_disk", detail: "MCP entry missing" },
  { platform: "claude-code", tool: "unknown-tool", issue: "on_disk_not_in_state", detail: "MCP entry exists but not tracked" }
]
```

**Priority:** Medium

---

### Gap 6: No Carry Weight Data

**Current:** Not implemented anywhere. The weight bar shows 0.

**Problem for UI:** The weight bar is a key feature of the Equip app. It needs real data.

**Enhancement:** Two approaches:

**(A) Registry-driven (accurate but requires equip-server):** Each augment in the registry has an `estimated_weight` field. The UI sums weight of equipped augments.

**(B) Heuristic (works offline):** The sidecar estimates weight by:
- Counting MCP tool definitions per server entry (each tool ≈ 200-500 tokens for definition + schema)
- Measuring rules block content length (content length / 4 ≈ tokens)
- Adding a fixed overhead per server (~100 tokens for config boilerplate)

**Recommendation:** Start with (B) — it works offline, requires no registry, and gives a reasonable estimate. Replace with (A) when the registry exists.

**Priority:** Medium

---

### Gap 7: No Augment Metadata for Equipped Items

**Current:** `state.json` tracks that "prior" is installed on "claude-code" with transport "http". It does NOT store: display name, description, rarity, author, icon, what MCP tools it provides, etc.

**Problem for UI:** The Equip page shows augment cards that need this metadata. For augments from the registry, the UI can fetch it. For manually installed MCP servers (not from registry), there's no metadata at all.

**Enhancement:** Two tiers:

1. **Registry augments:** The UI fetches metadata from equip-server. The sidecar doesn't need to provide this.
2. **Manual/unknown augments:** The sidecar reports them with basic info (server name, transport, URL/command). The UI renders them as "Unknown Augment" with a Common rarity badge.

**No library changes needed** — this is a UI-side merge of sidecar data + registry data.

**Priority:** Low (UI concern, not library concern)

---

### Gap 8: Sidecar Lifecycle (Spawn-Per-Request)

**Current:** Each sidecar call spawns a new `equip-sidecar.exe` process, which starts the Bun runtime, runs the method, and exits. ~200-500ms per call on Windows.

**Problem for UI:** For quick interactions (toggling augments, switching sets, drag-and-drop), the latency adds up. Multiple rapid calls would be noticeable.

**Enhancement:** Long-lived sidecar process:
- Starts on app launch, stays running
- Reads newline-delimited JSON-RPC from stdin, writes responses to stdout
- Rust side manages the process lifecycle (start, health check, restart on crash)
- Falls back to spawn-per-request if long-lived fails

**Priority:** Low (optimize when latency becomes a UX problem)

---

### Gap 9: Sets/Loadouts

**Current:** No concept of sets anywhere in the equip library or state.

**Problem for UI:** Sets are a planned feature for quickly switching augment configurations.

**Enhancement:** `~/.equip/sets.json` managed by the sidecar:

```json
{
  "sets": {
    "python-backend": {
      "tools": ["prior", "docs-fetcher", "db-inspector"],
      "platforms": ["claude-code", "cursor"],
      "createdAt": "2026-04-01T...",
      "lastUsed": "2026-04-01T..."
    }
  }
}
```

Sidecar methods: `sets.list`, `sets.save`, `sets.switch` (diff + install/uninstall to match), `sets.delete`.

**Depends on:** Gap 4 (install/uninstall via sidecar).

**Priority:** Low (later feature)

---

### Gap 10: All-Platform Capabilities (Static)

**Current:** Platform capabilities (MCP, Rules, Hooks, Skills) are derived from `PLATFORM_REGISTRY` at scan time, but only for *detected* platforms. The UI might want to show all 13 supported platforms with their capabilities, even those not installed.

**Enhancement:** A `capabilities` sidecar method that returns the full registry:

```
method: "capabilities"
returns: { platforms: [{ id, name, capabilities, configFormat }] }  // all 13
```

This is purely static data from the hardcoded registry. Could even be a JSON file shipped with the sidecar rather than a runtime call.

**Priority:** Low

---

## Implementation Order

Based on what the UI needs and dependencies between gaps:

1. **Gap 4: Install/Uninstall** — Core functionality, everything else is read-only without it
2. **Gap 3: Process Detection** — Needed for restart warnings after install/uninstall
3. **Gap 1: Cached Scan** — Instant UI rendering on launch
4. **Gap 6: Carry Weight** — Makes the weight bar functional
5. **Gap 5: Drift Detection** — Quality/trust signal for users
6. **Gap 2: Platform-Centric State** — Performance optimization
7. **Gap 7: Augment Metadata** — UI-side, not library-side
8. **Gap 8: Long-Lived Sidecar** — Optimization
9. **Gap 9: Sets** — Feature, not infrastructure
10. **Gap 10: Static Capabilities** — Nice to have

---

## Completed

*(Move items here as they're finished)*

- Sidecar bridge created (`equip/sidecar/bridge.ts`) with `scan`, `status`, `ping` methods
- Platform detection wired through sidecar to UI
- Capability tags derived from PLATFORM_REGISTRY and displayed in UI
- Augment count per platform from live config reads
- Shortened config paths (`~/...` format) for display
