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

Disabled platforms (toggled via the Equip desktop app) are automatically skipped.

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

### `equip list`

Show augments registered in the local registry.

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

State is reconciled from disk after every install/uninstall — equip scans what's actually in platform config files rather than relying solely on its records.

### Disabled Platforms

Platforms can be disabled via the Equip desktop app. Disabled platforms are:
- Skipped during `equip install` and `equip uninstall`
- Still scanned and visible in status (for informational purposes)
- Preserved when re-enabled — nothing is modified while disabled

## Cache

Tool definitions fetched from the API are cached at `~/.equip/cache/<augment>.json`. The cache is used as a fallback when the API is unreachable.

`equip update <augment>` clears the cache before re-fetching to ensure the latest definition.
