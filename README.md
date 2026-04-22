# Equip

Equip your AI agents with augments — packages of MCP servers, behavioral rules, and agent skills that work across every platform.

[![npm](https://img.shields.io/npm/v/@cg3/equip)](https://www.npmjs.com/package/@cg3/equip)
[![license](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@cg3/equip)](https://nodejs.org)

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
equip restore claude-code      # Restore a platform to its pre-equip state
unequip prior                  # Remove an augment
```

## Development and CI

```bash
npm test                       # Unit + integration coverage on the host
npm run test:docker:acceptance # Hermetic Docker acceptance for fake Claude/Codex homes
npm run test:pack             # Verify the actual npm tarball contents before publish
npm run test:pack:smoke       # Install the produced tarball into a clean temp project
```

The Docker acceptance lane is intentionally narrow: it boots a clean Node container, serves a local fixture registry, installs direct-mode and package-mode augments into fake Claude Code and Codex homes, and verifies the written MCP config, auth headers, rules, skills, and `~/.equip` state. It now also proves package-mode `npx` dispatch plus reconciliation, uninstall, restore, and cached offline reinstall behavior inside the same hermetic flow. This is the right place for CLI-level install flows that should stay hermetic and CI-friendly without depending on live registry data. CI now uploads a machine-readable Docker acceptance report plus raw build/run logs so failures point at the exact container step that regressed.
The pack verification lane now also emits a machine-readable JSON report in CI, preserves a raw `pack-verification.log`, and uploads the actual packed `.tgz`, so release/publish failures point at the exact tarball contract that broke and leave behind both the inspected artifact and the raw `npm pack` output. That verification script now preserves those failure artifacts too, even when `npm pack` itself fails before it can produce normal metadata. A second tarball smoke lane now installs that exact `.tgz` into a clean temp project and proves the packaged `equip` / `unequip` CLIs plus the exported library entrypoint still work from the npm package boundary; it now also preserves both a machine-readable failure artifact and a raw `pack-install-smoke.log` when the install smoke dies early. CI and release then generate a single `release-verification-report.json` rollup that ties together the pack contract, tarball smoke, and Docker acceptance results, even when one of those upstream artifacts is missing because a prior verification lane failed early, and that rollup now rewrites its per-lane log/report/tarball pointers to the current verification workspace so the combined gate points straight at the downloaded evidence you can actually inspect from that job. The workflow then fails explicitly if that rollup is not healthy, preserves a final `release-verification-assertion.json` artifact so the gate verdict and component-level failure details survive outside the job log, rewrites the final rollup so it points at the assertion and Markdown summary artifacts too, appends that final assertion verdict back into the GitHub job summary, and uploads a final `release-verification-summary.md` artifact so the same state is preserved in one human-readable Markdown file.

## Release Model

Stable npm releases now use Changesets plus a dedicated GitHub Actions release workflow.

Contributor workflow:

```bash
npm run changeset
```

Maintainer workflow:

- merge changesets to `main`
- let the release workflow open or update the `Version packages` PR
- merge that PR to publish `@cg3/equip`

The release workflow now also verifies the actual packed npm tarball before publish, smoke-installs that same tarball into a clean temp project, uploads Docker acceptance artifacts, preserves the resulting reports as workflow artifacts, and asserts the combined release-verification rollup before publish. That means public-package mistakes like missing CLI entrypoints or accidentally included source/test files fail before npm publish and leave behind the exact package plus hermetic acceptance evidence that was inspected.
It now also preserves a machine-readable `changesets-release-result.json` artifact, a human-readable `changesets-release-summary.md` artifact, and a final `changesets-release-assertion.json` gate verdict after the Changesets step, so release-PR/publish failures leave behind both structured and quick-scan evidence instead of living only in workflow logs.

The committed `package.json` version on `main` is the canonical release version. Tags and GitHub releases are outputs of that flow, not the mechanism that decides the version.

See [Release Management](./docs/release-management.md) for the full release and publishing contract.

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
| `equip snapshot [platform]` | Capture current platform config state |
| `equip snapshots [platform]` | List available config snapshots |
| `equip restore <platform>` | Restore platform config to a previous snapshot |
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
- **OAuth + key exchange** — browser flow → API key (for augments like Prior)

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
| [Release Management](./docs/release-management.md) | Changesets, CI publish flow, npm auth |

## State Management

Equip tracks everything in `~/.equip/`:

- **`augments/`** — Augment definitions: what each augment IS (synced from registry, locally editable)
- **`installations.json`** — What equip installed and on which platforms
- **`platforms.json`** — Detected platforms with capabilities and enabled/disabled preferences
- **`platforms/`** — Per-platform scan results (all MCP servers, managed and unmanaged)
- **`credentials/`** — Stored auth credentials per augment
- **`snapshots/`** — Platform config snapshots for rollback (initial state captured automatically)

State is reconciled from disk after every install/uninstall — equip scans actual platform config files rather than relying solely on its records. Initial snapshots are captured before any modifications, guaranteeing you can always restore to your pre-equip state.

## Design Principles

- **Zero runtime dependencies** — fast installs, no supply chain risk
- **Registry service as source of truth** — augment definitions served from `api.cg3.io/equip`
- **Single-process installs** — no secondary npm/npx for direct-mode augments
- **Atomic file writes** — crash-safe config modifications
- **Structured observability** — every install returns typed results with error codes and warnings
- **Credential lifecycle** — store, validate, refresh, and rotate automatically

## Telemetry

Equip sends anonymous install metrics (augment name, platform, OS, equip version) to help improve equip. **No credentials, file paths, or personal data are included.**

Telemetry is on by default. To disable, edit `~/.equip/equip.json` and set `preferences.telemetry` to `false`.

## License

FSL-1.1-ALv2 — Charles Mulic / [CG3, Inc.](https://cg3.io)
