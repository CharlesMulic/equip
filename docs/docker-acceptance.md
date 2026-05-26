# Docker Acceptance

`equip` now has a hermetic Docker acceptance lane for CLI install flows:

```bash
npm run test:docker:acceptance
```

## What It Covers

The current acceptance scenario is intentionally small and durable:

- start from a clean Node container
- run against a local fixture registry inside the container
- seed fake Claude Code and Codex home directories
- install a direct-mode augment through the real `equip` CLI
- verify:
  - Claude JSON MCP config
  - Codex TOML MCP config
  - rules written to `CLAUDE.md` and `AGENTS.md`
  - skills copied to the expected platform skill directories
  - `~/.equip/storage/` journal/content state
  - platform metadata and scan files
  - `equip status` and `equip doctor` still run cleanly afterward

## Why This Exists

This fills the gap between fast host-side unit/integration tests and broader end-to-end registry testing:

- use `equip` host tests for library behavior and small CLI surfaces
- use Docker acceptance here for hermetic CLI installation behavior
- use a specialized stack later for full publish/fetch/install flows against live registry routes

## CI Model

GitHub Actions keeps the existing OS/Node matrix for `npm test` and adds a dedicated `docker-acceptance` job on `ubuntu-latest`. That job runs `node scripts/ci/run-docker-acceptance.mjs`, which:

- resolves a Docker CLI binary, including common Docker Desktop locations on Windows
- builds `test/docker/Dockerfile`
- runs the internal acceptance suite inside the container

## Next Good Scenarios

After the first direct-install lane is stable, the next useful additions are:

- uninstall and restore verification
- authenticated direct-mode install with header injection
- package-mode dispatch path
- cached install fallback after an initial live fetch
- later, a flow where the registry creates or serves an augment definition and `equip` installs it inside a specialized stack

## Live MCP Registry Install Spike

There is also a deliberately separate live-registry spike/canary lane:

```bash
npm run test:docker:mcp-registry-live
```

This lane is not part of the normal CI acceptance path. It fetches retained server names from the official MCP registry using `latest`, projects supported targets into Equip's current direct-mode registry shape, starts a local registry stub, then runs the real `equip` CLI inside Docker against fake platform homes for:

- Claude Code
- Codex
- Cursor
- VS Code
- Roo Code

The retained live case list lives at `test/docker/fixtures/live-mcp-registry-cases.json`. This is a canary/discovery set, not deterministic regression evidence: upstream `latest` metadata can change and should be reviewed intentionally when it does. The current representative set covers:

- streamable HTTP remote MCP
- streamable HTTP remote MCP with `Authorization`
- npm stdio package
- npm stdio package with one secret env var
- PyPI stdio package via `uvx`
- OCI stdio package via `docker run`
- known unsupported shapes: SSE remotes, package-launched HTTP servers, and required non-secret env input

The spike intentionally installs only platform config entries; it does not launch arbitrary third-party MCP server code. Its purpose is compatibility discovery for "can an MCP registry entry become an Equip-installed augment?", not security review or functional MCP execution.
