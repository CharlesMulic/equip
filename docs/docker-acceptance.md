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
- install direct-mode and package-mode augments through the real `equip` CLI
- verify:
  - Claude JSON MCP config
  - Codex TOML MCP config
  - authenticated direct-mode installs validate credentials and write Bearer auth headers into platform MCP config
  - package-mode installs and `equip update` dispatch through `npx`, forward safe CLI flags like `--platform` / `--non-interactive`, and reconcile state after the package setup completes
  - rules written to `CLAUDE.md` and `AGENTS.md`
  - skills copied to the expected platform skill directories
  - `~/.equip/installations.json`
  - `~/.equip/credentials/*.json` for stored direct-mode credentials
  - `~/.equip/augments/*.json` for reconciled registry definitions after package-mode setup
  - platform metadata and scan files
  - `equip status` and `equip doctor` still run cleanly afterward
  - uninstall preserves the pre-existing Claude/Codex baseline config and rules
  - restore returns both platforms to their initial captured state
  - a second install succeeds from the local cache after the fixture registry is offline

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
- can write `.generated/docker-acceptance/docker-acceptance-report.json` plus raw `docker-build.log` / `docker-run.log`
- appends a concise job summary when `GITHUB_STEP_SUMMARY` is available

Set `EQUIP_DOCKER_ACCEPTANCE_OUTPUT_DIR` to preserve those artifacts locally or in CI.

Those Docker artifacts now also feed the higher-level `.generated/release/release-verification-report.json` rollup in CI/release, alongside the npm pack verification and tarball-install smoke results. CI and release now upload that rollup before a dedicated assertion step turns it into an explicit gate, so failures keep the machine-readable report and raw Docker logs for inspection.

## Next Good Scenarios

After the first direct-install lane is stable, the next useful additions are:

- later, a cross-repo flow where the monolith creates or serves an augment definition and `equip` installs it inside a specialized stack
