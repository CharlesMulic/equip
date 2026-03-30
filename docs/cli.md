# CLI Reference

Equip provides two CLI commands: `equip` (install and manage) and `unequip` (remove).

## Installation

```bash
npm install -g @cg3/equip
```

Requires Node.js 18 or later.

You can also use equip without installing globally:

```bash
npx @cg3/equip <command>
```

## Commands

### `equip <tool>`

Install an MCP tool by its registered name.

```bash
equip prior
equip prior --dry-run
equip prior --platform codex
```

Equip looks up the tool in `registry.json`, then runs its setup script via `npx`:

```bash
npx -y @cg3/prior-node@latest setup
```

Extra arguments are forwarded to the tool's setup script. Common flags like `--dry-run` and `--platform` are conventions that tools typically support.

After the setup script completes, equip reconciles state: it scans all platform configs to determine what was installed and records it in `~/.equip/state.json`.

### `equip` (no arguments)

Shows the status dashboard (same as `equip status`), plus a hint to run `equip --help`.

### `equip status`

Display all MCP servers across all detected platforms. Reads config files directly -- no state file required.

```
Detected platforms
  Claude Code            3 MCP servers
  Cursor                 2 MCP servers
  Gemini CLI             1 MCP server

MCP servers
  prior                Claude Code, Cursor, Gemini CLI    [equip]
  filesystem           Claude Code                        [manual]
  github               Claude Code, Cursor                [manual]

  3 servers total (1 via equip, 2 manual)
```

Servers installed via equip are tagged `[equip]`. Others are tagged `[manual]`.

### `equip doctor`

Validate config integrity and detect drift. For each tracked tool, doctor checks:

- Config file exists and is parseable
- MCP server entry is present (detects manual removal)
- Server URL uses HTTPS
- Rules marker block is present with the expected version
- Hook scripts exist on disk
- Skill files exist in the expected location
- All platform config files are valid JSON/TOML

```
equip doctor

  State file present

Checking tracked tools

  prior (@ cg3/prior-node)
    Claude Code: config + rules v0.6.0 + 2 hooks + skill "search"
    Cursor: config
    Gemini CLI: config + rules v0.6.0

Config file health
    Claude Code: valid JSON
    Cursor: valid JSON
    Gemini CLI: valid JSON

  All 8 checks passed
```

### `equip update`

Self-update equip via `npm update -g @cg3/equip` and check for config migrations.

```bash
equip update
```

This also updates the `lastUpdated` timestamp in state, which resets the stale version nudge.

### `equip list`

Show all tools registered in `registry.json`.

```
Registered tools

  prior  ->  @cg3/prior-node setup    Prior -- agent-centric shared knowledge base

  Install: equip <tool>
  Add yours: PR to registry.json at github.com/CharlesMulic/equip
```

### `equip demo`

Run the built-in demo setup script. Demonstrates platform detection, MCP config, rules, and skills installation using a fictional tool.

```bash
equip demo                    # Dry run (safe, no files modified)
equip demo --live             # Actually write files
equip demo --uninstall        # Remove demo config
equip demo --platform codex   # Target a specific platform
```

### `equip uninstall <tool>` / `unequip <tool>`

Remove a tool from all platforms where it was installed. Uses state tracking to know what to clean up.

```bash
equip uninstall prior
equip uninstall prior --dry-run
# or equivalently:
unequip prior
unequip prior --dry-run
```

Removes:
- MCP config entries from all platform config files
- Behavioral rules marker blocks from rules files
- Hook scripts and settings registrations
- Skills directories

After removal, the tool is removed from `~/.equip/state.json`.

```
unequip prior

  Claude Code: removed config + rules + hooks
  Cursor: removed config
  Gemini CLI: removed config + rules

  prior removed from 3 platforms
```

### `equip --version` / `equip -v`

Print the installed equip version.

### `equip --help` / `equip -h`

Print usage information and list registered tools.

## Tool Registry

The tool registry (`registry.json` in the equip package) maps short names to npm packages and setup commands:

```json
{
  "prior": {
    "package": "@cg3/prior-node",
    "command": "setup",
    "description": "Prior -- agent-centric shared knowledge base",
    "marker": "prior",
    "hookDir": "~/.prior/hooks",
    "skillName": "search"
  }
}
```

### Registry Fields

| Field | Required | Description |
|---|---|---|
| `package` | Yes | npm package name (run via `npx -y {package}@latest {command}`) |
| `command` | Yes | Command exported by the package's `bin` field |
| `description` | No | Short description shown in `equip list` and `equip --help` |
| `marker` | No | Rules marker name (defaults to tool name). Used by state reconciliation. |
| `hookDir` | No | Hook script directory (e.g., `~/.prior/hooks`). `~` is expanded at runtime. |
| `skillName` | No | Skill directory name. Used by state reconciliation. |

### Adding Your Tool

To register your tool, submit a PR adding an entry to `registry.json` at [github.com/CharlesMulic/equip](https://github.com/CharlesMulic/equip). Your npm package must export a CLI command that runs your setup script.

Unregistered tools can still be installed by passing the package name and command directly:

```bash
equip @example/my-tool setup
```

## State Tracking

Equip tracks installed tools in `~/.equip/state.json`. The state file is written exclusively by the CLI (not by the Equip library class) via reconciliation after each tool dispatch.

### State Structure

```json
{
  "equipVersion": "0.9.0",
  "lastUpdated": "2026-03-29T10:00:00.000Z",
  "tools": {
    "prior": {
      "package": "@cg3/prior-node",
      "installedAt": "2026-03-28T15:00:00.000Z",
      "updatedAt": "2026-03-29T10:00:00.000Z",
      "platforms": {
        "claude-code": {
          "configPath": "/home/user/.claude.json",
          "transport": "http",
          "rulesPath": "/home/user/.claude/CLAUDE.md",
          "rulesVersion": "0.6.0",
          "hookDir": "/home/user/.prior/hooks",
          "hookScripts": ["check-search.js", "remind-search.js"],
          "skillsPath": "/home/user/.claude/skills/prior",
          "skillName": "search",
          "equipVersion": "0.9.0"
        },
        "cursor": {
          "configPath": "/home/user/.cursor/mcp.json",
          "transport": "http",
          "equipVersion": "0.9.0"
        }
      }
    }
  }
}
```

State is used by `equip doctor` (to know what to verify), `equip uninstall` (to know what to remove), and `equip status` (to tag servers as `[equip]` vs `[manual]`).

### Reconciliation

State is not written during tool setup. Instead, after a tool's setup script finishes, equip's CLI runs `reconcileState()` which scans all platform configs to determine what's actually on disk. This approach avoids version skew between the CLI's equip version and a tool's bundled equip version.

Reconciliation checks:
- MCP config entries across all platforms
- Rules marker blocks in rules files
- Hook scripts in the hook directory
- Skill files in skill directories

## Stale Version Nudge

If the `lastUpdated` timestamp in state is more than 14 days old, equip prints a reminder:

```
equip v0.9.0 is 21 days old -- run "equip update" for platform fixes
```

This nudge appears for all commands except `update`, `--version`, and `--help`. Running `equip update` resets the timer.
