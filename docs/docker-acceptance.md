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
- SSE remote MCP for platforms with direct SSE support (Claude Code and VS Code)
- SSE remote MCP with `Authorization` for the same supported platforms
- npm stdio package
- npm stdio package with one secret env var
- npm stdio package with literal package arguments
- npm stdio package with one secret env var plus optional/default env metadata
- npm stdio package with optional/default env metadata and no credential
- PyPI stdio package via `uvx`
- PyPI stdio package with one secret env var
- PyPI stdio package with one secret env var plus extra plain env metadata
- OCI stdio package via `docker run`
- OCI stdio package with literal package arguments
- known unsupported shapes: remote URL/header variables, non-Authorization or malformed remote headers, multiple secret env vars, package argument variables, package-launched HTTP servers, required non-secret env input, and SSE installs on platforms without a direct SSE config shape

The Docker image includes `npx`, `uvx`, and the Docker CLI, and the test reports runtime-command readiness for generated stdio configs. It intentionally does not launch arbitrary third-party MCP server code. OCI stdio configs still require Docker daemon/socket access wherever the platform runs; the default canary verifies the CLI is present but does not mount a daemon, so OCI cases use the documented `--force` path to prove config projection without pretending the daemon is reachable.

Its purpose is compatibility discovery for "can an MCP registry entry become an Equip-installed augment?", not security review or functional MCP execution.

## MCP Initialize Smoke

Package-mode MCP install support also has a separate Docker smoke lane:

```bash
npm run test:docker:mcp-initialize-smoke
```

This lane proves the missing step after config projection: selected stdio MCP targets can be launched and can answer the MCP `initialize` request. It is intentionally narrower than the live registry canary.

The smoke harness:

- builds a dedicated Docker image with Node, `npx`, Python, and `uvx`
- executes only local allowlisted registry-shaped fixtures from `test/docker/fixtures/mcp-initialize-cases.json`
- covers one npm stdio package shape through `npx`
- covers one PyPI stdio package shape through `uvx`
- sends only MCP `initialize`, then kills the process group
- runs `docker run` with no network, no Docker socket, no privileged flags, dropped capabilities, read-only root filesystem, CPU/memory/pid limits, and an isolated tmpfs for runtime caches
- uses fresh temp `HOME`, npm cache, and uv cache directories per fixture
- redacts fake secrets, bearer values, workspace paths, and temp paths before writing or printing diagnostics
- includes a timeout regression test for stuck stdio servers

The fixtures are local by design. This lane is functional evidence for Equip's package target plumbing and stdio handshake mechanics; it is not a security review of third-party packages and it does not execute arbitrary live MCP registry code. The broader live registry canary remains config-only.
