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
  - `~/.equip/installations.json`
  - platform metadata and scan files
  - `equip status` and `equip doctor` still run cleanly afterward

## Why This Exists

This fills the gap between fast host-side unit/integration tests and broader cross-repo ephemeral-stack testing:

- use `equip` host tests for library behavior and small CLI surfaces
- use Docker acceptance here for hermetic CLI installation behavior
- use a specialized stack later for full publish/fetch/install flows against the Kotlin monolith routes

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
- later, a cross-repo flow where the monolith creates or serves an augment definition and `equip` installs it inside a specialized stack
