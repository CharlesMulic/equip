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
equip prior --api-key-file ./.prior.key  # Read API key from a file (recommended)
equip prior --api-key ask_xxx      # Provide API key directly (may expose it locally)
equip prior --dry-run              # Preview without writing
equip prior --verbose              # Show detailed logging
equip prior --non-interactive      # No prompts (fail if info missing)
```

Equip fetches the augment definition from the registry API (`api.cg3.io/equip`), records the install in local state, and installs MCP config, rules, and skills across all detected enabled platforms.

Disabled platforms are automatically skipped.

If the API is unreachable, equip falls back to a registry-scoped local cache under `~/.equip/cache/registries/`.

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

With an augment name: fetches the current definition from the registry API, validates stored credentials when the definition provides a validation URL, and re-installs. Rules update if the registry has a newer version. If the API is unreachable, equip falls back to the registry-scoped cache.

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
equip reauth prior --api-key-file ./.prior.key  # Replace with a key from a file
equip reauth prior --api-key xxx   # Replace with a specific key directly
```

Use when credentials are revoked, you want to switch accounts, or `equip doctor` reports invalid credentials.

### `equip uninstall <augment>`

Remove an augment from all enabled platforms.

```bash
equip uninstall prior
unequip prior                      # Alias — same behavior
```

Removes MCP config entries, rules marker blocks, and skill files from all enabled platforms. Disabled platforms are left untouched. Does not remove stored credentials (use `equip reauth` to clear those).

The uninstall is recorded in Equip's local journal so status, doctor, and future installs see the current resolved state.

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

### `equip snapshot-diff <platform> [snapshot-id]`

Print a machine-readable JSON preview of what a restore would do.

```bash
equip snapshot-diff claude-code
equip snapshot-diff cursor 20260401T143022Z
equip snapshot-diff claude-code --delete-added
```

The diff reports config/rules entries with an action of `unchanged`, `create`, `modify`, `delete`, `preserve-added`, or `skip`. It includes existence, file kind, byte count, and SHA-256 hash metadata for both current state and snapshot state. It does not include file contents.

By default, files that did not exist in the snapshot but exist now are reported as `preserve-added`. Use `--delete-added` to preview true deletion of those added files.

### `equip restore <platform> [snapshot-id]`

Restore a platform's config to a previous snapshot.

```bash
equip restore claude-code          # Restore to initial (pre-equip) state
equip restore cursor 20260401T143022Z  # Restore to a specific snapshot
equip restore claude-code --dry-run     # Show the restore plan without writing
equip restore claude-code --delete-added # Delete files that were absent in the snapshot
```

If no snapshot ID is given, restores to the initial (first-detection) snapshot — the pristine state before equip ever modified anything.

Before restoring, equip automatically saves a pre-restore snapshot of the current state. If you change your mind, you can restore to that snapshot to undo the restore.

When the snapshot says a file did not exist but that file exists now, restore preserves it by default. Pass `--delete-added` only when you want the restore to remove those added regular files. Directories are never deleted by snapshot restore; they appear as `skip` in the restore diff.

### `equip demo`

Run the built-in interactive demo that walks through building an augment.

## Options

| Flag | Description |
|------|-------------|
| `--verbose` | Show detailed debug logging (API fetches, config reads/writes) |
| `--dry-run` | Preview what would happen without writing any files |
| `--api-key-file <path>` | Read API key from a file. Recommended for CI and safer than putting secrets in shell history. |
| `--api-key <key>` | Provide API key directly. Convenient, but may expose the key in shell history or process lists. |
| `--platform <name>` | Target specific platform(s), comma-separated (e.g., `claude,cursor`) |
| `--delete-added` | Snapshot restore policy: remove regular files that did not exist in the target snapshot |
| `--preserve-added` | Snapshot restore policy: preserve files that did not exist in the target snapshot (default) |
| `--json` | Emit machine-readable JSON for commands that support it |
| `--non-interactive` | No prompts — fail if information is missing |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show version |

## Auth

Equip handles authentication for augments that require it. The auth type is declared in the augment's registry definition.

**Resolution order:**
1. `--api-key-file` or `--api-key` flag (explicit; `--api-key-file` is recommended)
2. Stored credential (`~/.equip/credentials/<augment>.json`)
3. Environment variable (if `keyEnvVar` is configured)
4. Interactive flow (prompt for key, or OAuth browser flow)

**Why prefer `--api-key-file`:**

- Prefer `--api-key-file` in CI, scripts, and shared terminals.
- `--api-key` is still supported, but the key can end up visible in shell history, process lists, terminal scrollback, or copied command snippets.

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
| `storage/intents.jsonl` | Append-only install/update/uninstall journal. |
| `storage/content/<hash>.json` | Immutable content blobs referenced by the journal. |
| `platforms.json` | Detected platform metadata and user preferences (enabled/disabled). |
| `platforms/<id>.json` | Per-platform scan results — all MCP servers configured, managed vs unmanaged. |
| `equip.json` | Equip version, timestamps, preferences. |
| `credentials/<name>.json` | Stored auth credentials per augment. |
| `cache/registries/<registry-key>/<name>.json` | Cached registry API responses (fallback when offline). |
| `snapshots/<platform>/<id>.json` | Config snapshots — captured platform state for rollback. |

Install and local-script flows reconcile state from disk by scanning the platform config files after writes. Uninstall records the removal in Equip's journal, and `equip status` reads the current platform config files directly.

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

**Reconciliation from disk.** Install and local-script flows scan the actual platform config files after writes — equip doesn't rely solely on its own records. `equip status` also reads platform config files directly, so manually edited MCP entries show up on the next status run.

**Recovery steps:**

| Problem | Fix |
|---|---|
| Config file is corrupt or empty | Restore from `.bak` file in the same directory, or re-run `equip <augment>` to re-install |
| `equip status` looks stale | Run `equip status` again; it reads platform config files directly. If an augment definition is out of date, run `equip update <augment>`. |
| Lock file prevents operation | Delete `~/.equip/.lock` manually (the holding process likely crashed) |
| Credentials invalid or expired | Run `equip reauth <augment>` for a fresh auth flow |
| Augment definition out of date | Run `equip update <augment>` to re-fetch from registry |
| Platform config was manually edited | Equip picks this up automatically on next reconciliation |

## Cache

Augment definitions fetched from the API are cached under `~/.equip/cache/registries/<registry-key>/<augment>.json`. The registry key keeps local, staging, and production registries from sharing cache entries.

`equip update <augment>` tries the live registry first and uses the cache only as an offline fallback.
