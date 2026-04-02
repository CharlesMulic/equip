# Equip

Equip your AI agents with augments — packages of MCP servers, behavioral rules, and agent skills that work across every platform.

[![npm](https://img.shields.io/npm/v/@cg3/equip)](https://www.npmjs.com/package/@cg3/equip)

[Discord](https://discord.gg/bBcRHT4J) · [Augment Author Guide](./docs/augment-author.md)

## What It Does

You want to add a capability to your AI coding agent — a knowledge base, a documentation fetcher, a code formatter. It should work on Claude Code, Cursor, VS Code, Windsurf, and every other platform. Each platform has its own config format, file paths, and quirks.

Equip handles all of that. One command, every platform.

```bash
equip prior           # Installs MCP server + rules + skills on all detected platforms
```

## Install

```bash
npm install -g @cg3/equip
```

Or use without installing:

```bash
npx @cg3/equip prior
```

## Quick Start

```bash
equip prior                    # Install an augment
equip status                   # See what's installed across all platforms
equip doctor                   # Validate config integrity + credential health
equip update prior             # Re-fetch and re-install latest version
equip refresh                  # Refresh expired OAuth tokens
equip reauth prior             # Re-authenticate and rotate credentials
unequip prior                  # Remove an augment
```

## How Augments Work

An augment is a bundle of up to four layers that enhance your agent:

| Layer | What It Does | Coverage |
|---|---|---|
| [MCP Server](./docs/mcp-servers.md) | Makes capabilities *available* — agent can call them | All platforms |
| [Behavioral Rules](./docs/rules.md) | Teaches the agent *when and how* to use them | Most platforms |
| [Agent Skills](./docs/skills.md) | Gives *detailed knowledge* loaded on demand | Most platforms |
| [Lifecycle Hooks](./docs/hooks.md) | *Structurally enforces* behavior at key moments | Claude Code |

Each layer compensates for the limitations of the one before it. Together, they give your agent the best coverage available.

## Supported Platforms

| Platform | MCP | Rules | Skills | Hooks |
|---|---|---|---|---|
| Claude Code | Yes | Yes | Yes | Yes |
| Cursor | Yes | — | Yes | — |
| VS Code / Copilot | Yes | — | Yes | — |
| Windsurf | Yes | Yes | Yes | — |
| Cline | Yes | Yes | Yes | — |
| Roo Code | Yes | Yes | Yes | — |
| Codex | Yes | Yes | Yes | — |
| Gemini CLI | Yes | Yes | Yes | — |
| Junie | Yes | — | — | — |
| Copilot (JetBrains) | Yes | — | — | — |
| Copilot CLI | Yes | — | — | — |
| Amazon Q | Yes | — | — | — |
| Tabnine | Yes | Yes | — | — |

See [Platforms](./docs/platforms.md) for config paths, detection, and per-platform details.

## CLI Commands

| Command | Description |
|---|---|
| `equip <augment>` | Install an augment from the registry |
| `equip status` | Cross-platform inventory of installed augments |
| `equip doctor` | Validate config integrity and credential health |
| `equip update <augment>` | Re-fetch definition and re-install |
| `equip refresh [augment]` | Refresh expired OAuth tokens |
| `equip reauth <augment>` | Re-authenticate and update credentials |
| `equip uninstall <augment>` | Remove an augment (alias: `unequip`) |
| `equip ./script.js` | Run a local setup script (for development) |

Options: `--verbose`, `--dry-run`, `--api-key <key>`, `--platform <name>`, `--non-interactive`

See [CLI Reference](./docs/cli.md) for details.

## For Augment Authors

Equip distributes your augment through the [registry service](https://cg3.io/equip). Define your MCP server URL, auth requirements, rules, and skills — equip handles platform detection, config translation, credential management, and installation across all platforms.

For local development:

```bash
equip ./my-augment.js          # Test locally on all detected platforms
equip .                        # Run current directory's package
```

See the [Augment Author Guide](./docs/augment-author.md) for the full walkthrough.

## Auth

Equip handles authentication for augments that require it:

- **API key** — prompt or `--api-key` flag
- **OAuth** — browser PKCE flow with automatic token refresh
- **OAuth + key exchange** — browser flow → API key (for tools like Prior)

Credentials stored securely at `~/.equip/credentials/`. Expired tokens are auto-refreshed on every equip command.

## Documentation

| Guide | Description |
|---|---|
| [Augment Author Guide](./docs/augment-author.md) | Build and publish augments |
| [Platforms](./docs/platforms.md) | Supported platforms, capabilities, config paths |
| [MCP Servers](./docs/mcp-servers.md) | Config format translation, API reference |
| [Behavioral Rules](./docs/rules.md) | Marker-based versioned instructions |
| [Agent Skills](./docs/skills.md) | SKILL.md format, cross-platform distribution |
| [Lifecycle Hooks](./docs/hooks.md) | Event-driven enforcement scripts |
| [CLI Reference](./docs/cli.md) | Commands, state, options |

## State Management

Equip tracks everything in `~/.equip/`:

- **`augments/`** — Augment definitions: what each augment IS (synced from registry, locally editable)
- **`installations.json`** — What equip installed and on which platforms
- **`platforms.json`** — Detected platforms with capabilities and enabled/disabled preferences
- **`platforms/`** — Per-platform scan results (all MCP servers, managed and unmanaged)
- **`credentials/`** — Stored auth credentials per augment

State is reconciled from disk after every install/uninstall — equip scans actual platform config files rather than relying solely on its records.

## Design Principles

- **Zero runtime dependencies** — fast installs, no supply chain risk
- **Registry service as source of truth** — augment definitions served from `api.cg3.io/equip`
- **Single-process installs** — no secondary npm/npx for direct-mode augments
- **Atomic file writes** — crash-safe config modifications
- **Structured observability** — every install returns typed results with error codes and warnings
- **Credential lifecycle** — store, validate, refresh, and rotate automatically

## License

MIT — Charles Mulic / [CG3 LLC](https://cg3.io)
