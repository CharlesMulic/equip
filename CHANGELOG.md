# Changelog

All notable changes to Equip are documented here.

## [Unreleased]

## [0.19.3] - 2026-05-01

### Added

- **Journal-canonical storage** under `~/.equip/storage/intents.jsonl` and `~/.equip/storage/content/`. First run migrates prior on-disk formats into the journal/content model.
- **Registry-scoped cache metadata** under `~/.equip/cache/registries/`, including ETag/content metadata for safer offline fallback.
- **Managed MCP config plumbing** for platforms that can delegate runtime credential handling, with doctor/status output that preserves the per-platform install mode.
- **OIDC auth metadata** now accepts optional `audience` and `scopes`; `"oauth-dcr"` registry metadata is accepted as a schema-only stub until runtime acquisition support ships.
- **Hook orphan detection** in `equip doctor`, plus `equip doctor --fix-orphan-hooks` to prune hook entries whose script files no longer exist.

### Fixed

- Rules-only and skills-only augments no longer attempt MCP config installation.
- State reconciliation preserves local-vs-registry source data and per-platform install mode.
- Windows OAuth browser launches correctly escape URLs containing shell-sensitive characters.
- Windows storage writes avoid POSIX file-mode calls that can create deny-all DACLs.
- Registry content-hash mismatches warn and continue instead of failing an otherwise usable live definition.
- Codex TOML output emits Windows paths as valid TOML literal strings and reads them back without self-induced drift.
- OIDC token exchange handles wrapped error responses defensively instead of throwing from the error path.
- Public repository surface no longer includes private-facing agent notes.

### Changed

- The old multi-file install/augment storage cluster was retired from the current implementation. Public docs now describe the journal/content storage layer and registry-scoped cache paths.
- Docs tests and hook tests use isolated platform homes/settings paths instead of writing into a contributor's real platform config.

### Migration notes

- Existing installs should continue to reconcile from platform config and migrate local Equip state on first use.
- If you maintain release automation, note that `0.19.3` is already the package version on `main`. Pending changesets for the 0.19 line have been folded into this changelog so the Changesets workflow can publish `0.19.3` instead of opening a `0.20.0` version PR.

## [0.18.0] — 2026-04-25

### ⚠️ Breaking Changes

- **`uninstallSkill()` and `Augment.uninstallSkill()` now return `UninstallSkillResult` (`{ removed, preservedFiles, tombstone, viaManifest }`) instead of `boolean`.** Callers doing `if (uninstallSkill(...))` will silently get always-truthy behavior (object is truthy). Update to `if (uninstallSkill(...).removed)`.
- **Skill names and hook names are now slug-validated** (lowercase alphanumeric + hyphens only, no leading/trailing/consecutive hyphens, max 64 chars per the Agent Skills spec). Previously-accepted names like `My-Skill`, `foo.bar`, `.`, or names containing `/` or `\` will throw. If you have skills authored with non-conforming names, rename them before upgrading.
- **Skills install at the flat layout `{skillsPath}/{skillName}/SKILL.md`** per the Agent Skills spec (https://agentskills.io/specification). The previous `{skillsPath}/{augmentName}/{skillName}/SKILL.md` wrapper layout was unreadable by every target platform's loader (Claude Code, Cursor, Codex, Windsurf, Gemini CLI, Cline, Roo). On install of any augment, Equip cleans up the augment's specific legacy wrapper subtree.
- **Default install behavior on cross-augment skill-name collision is now refuse + error** instead of silent overwrite. Pass `--takeover` to override an existing manifest's claim or `--adopt` to take ownership of an untracked existing skill dir.

### Added

- **Per-skill ownership manifest at `{skillDir}/.equip-meta.json`** records the installing augment, install context, and per-file SHA-256 hashes. The manifest is hygiene/correctness, NOT a security boundary — Equip's local journal remains authoritative.
- **Manifest-driven uninstall** preserves user-modified files. For each file in the manifest, current SHA-256 is compared to the install-time hash; matching files are deleted, drifted (user-modified) and user-added foreign files are preserved. If anything survives, a tombstone manifest is written so the dir is recognizable as "Equip once owned this."
- **Refcounted shared-root semantics** for `~/.agents/skills/` (read by Codex, Windsurf, VS Code; partially by Cursor). An augment installing the same skill across multiple platforms appends new owner entries to `manifest.owners[]` instead of stomping. Unequip removes only the requesting (augment, platform) tuple's owner; files survive until the last owner unequips. Closes the latent "unequip Cursor wipes a skill Codex still uses" bug.
- **mtime-keyed checksum cache at `~/.equip/checksum-cache.json`** keyed by `(mtimeMs, size)`. Verify operations hit the fast path on cache match; install seeds the cache from freshly-computed hashes; uninstall prunes pruned entries. Self-healing: drifted files get fresh cache entries on the next verify.
- **Batched state writes** collapse multiple install/uninstall bookkeeping updates in one logical operation into a single disk write. This was the 0.18 storage path; current main supersedes it with the 0.19 journal/content storage layer.
- **`--takeover` and `--adopt` CLI flags** for `equip <augment>` to override install-time skill collision refusals.
- **CLI help text now lists `--api-key-file <path>`** (the flag itself was already implemented). The README, CLI reference, and augment-author guide now surface and recommend it for CI and shell-safe usage.
- **New error codes** on `ArtifactResult.errorCode` for skill collision branches: `SKILL_COLLISION_OTHER_AUGMENT`, `SKILL_COLLISION_USER_AUTHORED`, `SKILL_COLLISION_FORGED_MANIFEST`. CLI surfaces appropriate flag suggestions per error.
- **`Augment.installSkill` aggregates partial-install results** — a multi-skill augment with one colliding skill installs the remaining skills and surfaces the conflict via the result `errorCode`/`error` fields, instead of fail-fasting on the first refusal.
- **Public API surface:** `uninstallSkill()` and `Augment.uninstallSkill()` now expose the richer `UninstallSkillResult`; `installSkill()` accepts the additive `InstallSkillOptions` fields described below. Internal manifest/checksum helpers back those flows but are not documented as root package imports.

### Fixed

- **Path-component injection via skill names.** A registry-served `skill.name = "victim/SKILL"` would previously slip through `validateRelativePath` and target the legacy wrapper layout for a different augment. The new `validateSkillName` rejects any path components, dots, or non-slug characters.
- **Skill name `"."` no longer permitted.** Previously `path.join(skillsPath, ".")` collapsed to `skillsPath`, so a skill with `name: "."` could write `SKILL.md` directly into the platform skills root.
- **Cross-augment delete via shared wrapper-name.** `cleanupLegacyToolWrapper` previously did a recursive `rmSync` on `{skillsPath}/{toolName}/` on every install — an attacker augment could trigger deletion of a victim augment's legacy install simply by sharing the wrapper name. Replaced with `cleanupLegacySkillSubtree` which only removes the specific `{wrapper}/{thisSkillName}/` subtree we know we previously wrote.
- **Hook scripts are now slug-validated** before being written to `{hookDir}/{name}.js`. Closes the same path-injection vector for hook names.
- **TOCTOU window on install/unequip closed via `acquireLock`.** Both flows now hold the equip-wide lock through the entire operation. Re-entrant: `reconcileState`'s existing acquisition just bumps the depth counter.
- **Handle unreadable local augment definition files** without crashing Equip loadout reads.
- **Repair Windows Equip JSON state files** affected by a bad inherited-ACL write path.
- **Registry installs upgrade auto-wrapped augment definitions** that were detected before registry metadata was cached.
- **Scope registry definition cache fallback by registry URL** so staging/prod/local cache entries cannot bleed into each other.
- Demo `setup.js` and assorted docs/help-text fixes (carried forward from earlier `[Unreleased]`).

### Changed

- CLI help and docs recommend `--api-key-file <path>` for safer scripted usage while keeping `--api-key <key>` available with explicit risk guidance.
- `installSkill` accepts new optional fields on `InstallSkillOptions`: `takeover`, `adopt`, `augmentVersion`, `source`, `package`, `equipVersion`. Registry installs populate these automatically; local installs get sensible defaults.
- `AugmentConfig` accepts new optional fields: `augmentVersion`, `source`, `package`, `equipVersion` — propagated to per-skill manifests.

### Migration notes

- **Re-equip your augments after upgrading.** The flat-layout cleanup runs at install time, so any augment installed under the legacy nested wrapper will only migrate when you next install/update it. Old installs at `~/.{platform}/skills/{augment}/{skill}/` are invisible to platform loaders until you re-equip.
- **External callers of `uninstallSkill`/`Augment.uninstallSkill`** must update boolean checks to read `result.removed`. The previous boolean return is replaced by the richer `UninstallSkillResult`.
- **If you author skills with non-slug names** (uppercase, dots, slashes), rename them before upgrading. Equip will reject them at install time.

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
