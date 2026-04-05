# CLI Reference

Equip provides two CLI commands: `equip` and `unequip`.

## Install

```bash
npm install -g @cg3/equip
```

Or use without installing:

```bash
npx @cg3/equip <augment>
```

## Commands

### `equip <augment>`

Install an augment from the registry.

```bash
equip prior                        # Install Prior augment
equip demo-fetch                   # Install demo-fetch augment
equip prior --platform claude      # Install on Claude Code only
equip prior --api-key ask_xxx      # Provide API key (skip prompt)
equip prior --dry-run              # Preview without writing
equip prior --verbose              # Show detailed logging
equip prior --non-interactive      # No prompts (fail if info missing)
```

Equip fetches the augment definition from the registry API (`api.cg3.io/equip`), syncs it to a local augment definition (`~/.equip/augments/<name>.json`), and installs MCP config, rules, hooks, and skills across all detected enabled platforms.

Disabled platforms are automatically skipped.

If the API is unreachable, equip falls back to a locally cached definition (`~/.equip/cache/`).

### `equip` (no arguments)

Shows the status dashboard (same as `equip status`).

### `equip status`

Show all MCP servers installed across all platforms. Servers installed via equip are tagged `[equip]`; manually configured servers show as `[manual]`.

```bash
equip status
```

### `equip doctor`

Validate config integrity, detect drift, and check credential health.

```bash
equip doctor
```

Checks for each tracked augment:
- Config file exists and is parseable
- MCP entry present in config (drift detection)
- Auth headers present (JWT expiry checked)
- Rules version matches expected
- Hooks scripts exist
- Skills installed (all skills, not just first)
- Stored credentials valid (OAuth expiry, token health)

### `equip update [augment]`

```bash
equip update prior                 # Re-fetch definition, re-install augment
equip update                       # Self-update equip + migrate configs
```

With an augment name: clears the cache, re-fetches the definition from the API, validates stored credentials, and re-installs. Rules update if the registry has a newer version.

Without an augment name: updates equip itself and runs config migrations.

### `equip refresh [augment]`

Refresh expired OAuth tokens.

```bash
equip refresh                      # Check and refresh all expired tokens
equip refresh prior                # Refresh a specific augment's token
```

Uses stored refresh tokens to obtain new access tokens. For `oauth` type augments, also updates platform MCP configs with the new token.

Auto-refresh runs automatically on every equip command — this command is for explicit/manual refresh.

### `equip reauth <augment>`

Re-authenticate from scratch. Deletes stored credentials and re-runs the full auth flow.

```bash
equip reauth prior                 # Re-run OAuth + key exchange
equip reauth prior --api-key xxx   # Replace with a specific key
```

Use when credentials are revoked, you want to switch accounts, or `equip doctor` reports invalid credentials.

### `equip uninstall <augment>`

Remove an augment from all enabled platforms.

```bash
equip uninstall prior
unequip prior                      # Alias — same behavior
```

Removes MCP config entries, rules marker blocks, hook scripts, and skill files from all enabled platforms. Disabled platforms are left untouched. Does not remove stored credentials (use `equip reauth` to clear those).

When all platforms are removed, the augment definition (`~/.equip/augments/<name>.json`) is also cleaned up.

### `equip ./script.js`

Run a local setup script for development.

```bash
equip ./my-augment.js              # Run a local script
equip .                            # Run current directory's package bin entry
```

After the script exits, equip reconciles state — scanning all platform configs to track what was installed. This integrates local augments with `equip status`, `equip doctor`, and `equip uninstall`.

### `equip snapshot [platform]`

Capture the current config state for one or all detected platforms.

```bash
equip snapshot                     # Snapshot all detected platforms
equip snapshot claude-code         # Snapshot Claude Code only
```

Equip automatically creates an initial snapshot the first time it detects a platform — before any config modifications. Use this command to create additional manual snapshots before experimenting.

### `equip snapshots [platform]`

List available config snapshots.

```bash
equip snapshots                    # Show all snapshots across platforms
equip snapshots cursor             # Show snapshots for Cursor only
```

Shows snapshot ID, label, timestamp, and what was captured (config, rules).

### `equip restore <platform> [snapshot-id]`

Restore a platform's config to a previous snapshot.

```bash
equip restore claude-code          # Restore to initial (pre-equip) state
equip restore cursor 20260401T143022Z  # Restore to a specific snapshot
```

If no snapshot ID is given, restores to the initial (first-detection) snapshot — the pristine state before equip ever modified anything.

Before restoring, equip automatically saves a pre-restore snapshot of the current state. If you change your mind, you can restore to that snapshot to undo the restore.

### `equip demo`

Run the built-in interactive demo that walks through building an augment.

## Options

| Flag | Description |
|------|-------------|
| `--verbose` | Show detailed debug logging (API fetches, config reads/writes) |
| `--dry-run` | Preview what would happen without writing any files |
| `--api-key <key>` | Provide API key directly (skip auth prompt/OAuth) |
| `--platform <name>` | Target specific platform(s), comma-separated (e.g., `claude,cursor`) |
| `--non-interactive` | No prompts — fail if information is missing |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show version |

## Auth

Equip handles authentication for augments that require it. The auth type is declared in the augment's registry definition.

**Resolution order:**
1. `--api-key` flag (explicit)
2. Stored credential (`~/.equip/credentials/<augment>.json`)
3. Environment variable (if `keyEnvVar` is configured)
4. Interactive flow (prompt for key, or OAuth browser flow)

**Credential storage:**

Credentials are stored at `~/.equip/credentials/` with restrictive file permissions (0600 on Unix). Each augment has its own credential file containing the API key or OAuth tokens.

**Token lifecycle:**
- `equip refresh` — refresh expired OAuth tokens using stored refresh tokens
- `equip reauth` — re-run the full auth flow from scratch
- `equip doctor` — reports credential health and expiry
- Auto-refresh runs on every equip command

## State

Equip manages state across multiple files in `~/.equip/`:

| File | Purpose |
|------|---------|
| `augments/<name>.json` | Augment definitions — what each augment IS (server URL, rules, skills, hooks). Synced from registry on install, editable locally. |
| `installations.json` | What equip has installed and on which platforms. Used by status, doctor, uninstall. |
| `platforms.json` | Detected platform metadata and user preferences (enabled/disabled). |
| `platforms/<id>.json` | Per-platform scan results — all MCP servers configured, managed vs unmanaged. |
| `equip.json` | Equip version, timestamps, preferences. |
| `credentials/<name>.json` | Stored auth credentials per augment. |
| `cache/<name>.json` | Cached registry API responses (fallback when offline). |
| `snapshots/<platform>/<id>.json` | Config snapshots — captured platform state for rollback. |

State is reconciled from disk after every install/uninstall — equip scans what's actually in platform config files rather than relying solely on its records.

### Disabled Platforms

Platforms can be disabled in `~/.equip/platforms.json`. Disabled platforms are:
- Skipped during `equip install` and `equip uninstall`
- Still scanned and visible in status (for informational purposes)
- Preserved when re-enabled — nothing is modified while disabled

## Backup and Recovery

Equip uses several strategies to prevent data loss and recover from bad state:

**Atomic writes.** All config file modifications go through `atomicWriteFileSync` — content is written to a `.tmp` file first, then renamed over the target. On most filesystems, rename is atomic, so the config file is never partially written.

**Backups.** Before modifying a platform's config file, equip creates a `.bak` copy. If the write succeeds and verification passes, the backup is removed. If something goes wrong mid-write, the `.bak` file preserves the previous state.

**Concurrent operation safety.** A process-level lockfile (`~/.equip/.lock`) prevents multiple equip commands from racing on shared state files. The lock is advisory and auto-expires after 60 seconds.

**Reconciliation from disk.** After every install/uninstall, equip scans the actual platform config files to rebuild its state — it doesn't rely solely on its own records. This means manually editing a config file won't cause drift; the next equip command picks up the real state.

**Recovery steps:**

| Problem | Fix |
|---|---|
| Config file is corrupt or empty | Restore from `.bak` file in the same directory, or re-run `equip <augment>` to re-install |
| `equip status` shows stale data | Run `equip update` to re-scan all platforms |
| Lock file prevents operation | Delete `~/.equip/.lock` manually (the holding process likely crashed) |
| Credentials invalid or expired | Run `equip reauth <augment>` for a fresh auth flow |
| Augment definition out of date | Run `equip update <augment>` to re-fetch from registry |
| Platform config was manually edited | Equip picks this up automatically on next reconciliation |

## Cache

Augment definitions fetched from the API are cached at `~/.equip/cache/<augment>.json`. The cache is used as a fallback when the API is unreachable.

`equip update <augment>` clears the cache before re-fetching to ensure the latest definition.
