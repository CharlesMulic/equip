# Changelog

All notable changes to Equip are documented here.

## [0.17.3] — 2026-04-05

### Fixed
- Demo `setup.js` used singular `skill:` instead of plural `skills:[]` (ignored silently)
- Demo and docs referenced removed `"clipboard"` action and `clipboardPlatforms` option
- `unequip --help` said "Run 'equip \<tool\>'" instead of "augment"
- `mcp-servers.md` incorrectly listed Cursor as `"streamable-http"` type (Cursor has no type field)
- `platforms.md` showed old `cline_mcp_settings.json` path for Roo Code (migrated to `mcp_settings.json`)
- `rules.md` and `mcp-servers.md` documented `parseRulesVersion`, `markerPatterns`, and low-level MCP functions as public imports (they are internal)
- `README.md` showed `updatePreferences` as a public import (it is internal)
- `augment-author.md` `AugmentConfig` reference was stale (singular `skill?` instead of `skills?: SkillConfig[]`, missing `hooks` and `hookDir`)
- `CONTRIBUTING.md` referenced non-existent `src/lib/augment.ts`

### Changed
- Demo variable `TOOL_NAME` renamed to `AUGMENT_NAME`
- Remaining "tool" → "augment" terminology fixes across all docs (skills.md, hooks.md, rules.md, mcp-servers.md, demo/)
- Remaining "Augment" → "Equip" where used as product name in prose (mcp-servers.md, skills.md, hooks.md, rules.md)
- Added `"augment"` keyword to package.json
- `augment-author.md` instance methods table expanded with 10 missing methods
- `CONTRIBUTING.md` project structure updated to match current layout

## [0.17.0] — 2026-04-02

### Added
- **Platform config snapshots** — `equip snapshot`, `equip snapshots`, `equip restore` commands for capturing and restoring platform config state
- Initial snapshots captured automatically before first modification — guarantees rollback to pre-equip state
- Pre-restore safety snapshots — restoring creates a snapshot of current state first, so you can undo the undo
- Desktop app integration via sidecar bridge (listSnapshots, createSnapshot, restoreSnapshot)

### Fixed
- Lock file TOCTOU race condition — now uses exclusive file creation (`wx` flag) for atomic lock acquisition
- `hasInitialSnapshot` was O(n) per platform — now O(1) via sentinel marker file
- `reconcileState` silently swallowed all errors — now logs through optional logger parameter
- Roo Code MCP config filename migration (`cline_mcp_settings.json` → `mcp_settings.json`)
- Rules installer handles directory-style rulesPath (Roo Code `~/.roo/rules/`) when no fileName configured
- Removed bundled `registry.json` — registry API is sole source of truth, with cache fallback
- Removed `equip list` command (registry content served by backend, not bundled file)
- Transport inference bug in reconcile.ts — now uses toolDef.transport when available

### Changed
- CLI entry point reduced from 866 → 380 lines — install, reauth, refresh commands extracted to typed TypeScript modules
- "tool" → "augment" terminology standardized across all user-facing strings
- ESM import support added to package.json exports

## [0.16.2] — 2026-03-28

### Security
- Credential storage uses atomic writes (prevents partial-write exposure)
- OAuth callback HTML-escapes user-facing values (XSS prevention)
- API key prompts suppress echo (prevents shoulder-surfing)
- `~/.equip/.gitignore` auto-created to prevent accidental credential commits
- `--api-key-file` option added (avoids key exposure in process list / shell history)

### Changed
- Multi-file state architecture: `platforms.json`, `platforms/*.json`, `installations.json`, `augments/*.json`, `equip.json` replace monolithic `state.json`
- Augment definitions stored locally in `~/.equip/augments/` as single source of truth
- Per-platform scan files track all MCP servers (managed and unmanaged)
- Platform enable/disable support (for desktop app integration)
- Process-level lockfile prevents concurrent equip operations from racing
- Telemetry gated behind `preferences.telemetry` in `equip.json` (documented in README)
- Tightened `package.json` exports (removed `./dist/*` wildcard)
- Fixed type casts in platform scanning (`def.hooks` instead of `(def as any).hooks`)

### Removed
- Legacy `state.json` and migration code deleted (never published with old format)

## [0.16.0] — 2026-03-26

### Added
- Augment definition CRUD (`writeAugmentDef`, `readAugmentDef`, `syncFromRegistry`)
- Augment modding: users can customize rules and track upstream changes
- Sidecar bridge v2 with 14 methods for desktop app integration
- Per-instance process detection (PID, start time, command line)

### Changed
- Multi-skill support: `skills[]` array replaces singular `skill`

## [0.15.0] — 2026-03-22

### Changed
- `Equip` class renamed to `Augment` — reflects augment-centric model
- "Tools" rebranded to "augments" across docs, help text, and messaging
- Documentation fully rewritten for v0.15 architecture

## [0.14.0] — 2026-03-20

### Added
- Data-driven install: validation URLs, webhooks, platform hints, `--platform` filter
- `equip refresh` and `equip reauth` commands
- Auto-refresh of expired OAuth tokens on every equip command
- `equip update <augment>` re-fetches definition and re-installs
- Doctor command checks credential health

## [0.13.0] — 2026-03-18

### Added
- Direct-mode installs: single-process, no secondary npx spawn
- Auth engine: OAuth PKCE, key exchange, credential storage at `~/.equip/credentials/`
- Prior migrated to direct-mode install

## [0.12.0] — 2026-03-15

### Added
- Observability layer: `ArtifactResult`, `EquipLogger`, error codes, `InstallReportBuilder`
- Structured install results with typed success/failure reporting

## [0.11.0] — 2026-03-12

### Added
- Config migration in `equip update`
- Auth detection in `equip doctor`
- Codex, Gemini CLI, Junie, Copilot CLI, Amazon Q, Tabnine platform support
