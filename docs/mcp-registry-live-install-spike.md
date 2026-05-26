# Live MCP Registry Install Spike

**Status:** complete as a repeatable live canary harness  
**Created:** 2026-05-26  
**Command:** `npm run test:docker:mcp-registry-live`

## Question

Can the current Equip CLI install representative live official MCP registry servers into real platform config files when we bypass Equip's own registry/review pipeline and project official registry metadata directly into Equip's direct-mode install shape?

## Why This Matters

Content ingestion can expose official MCP registry entries as augments, but discovery is only useful if Equip can actually write a runnable platform config for the selected target. The official MCP registry describes `packages` and `remotes`; the Equip CLI currently consumes CG3 `RegistryDef` fields such as `serverUrl`, `stdioCommand`, `stdioArgs`, `envKey`, and `auth`.

## Harness

The harness:

1. Fetches retained cases from `https://registry.modelcontextprotocol.io`.
2. Projects installable targets into a local CG3-style registry response.
3. Starts a local registry stub.
4. Runs `bin/equip.js` against fake platform homes in Docker.
5. Verifies config files for Claude Code, Codex, Cursor, VS Code, and Roo Code.

Retained live cases live in `test/docker/fixtures/live-mcp-registry-cases.json`. The fixture intentionally uses `latest` registry versions so it acts as a live canary/discovery harness. It is not deterministic regression evidence; when upstream metadata changes, the case list or support expectations should be reviewed intentionally.

## Current Results

Installed successfully:

| Case | Official server | Target | Equip projection |
|---|---|---|---|
| `remote-streamable-public` | `ac.tandem/docs-mcp` | remote `streamable-http` | `serverUrl=https://tandem.ac/mcp` |
| `remote-streamable-authorization` | `io.github.github/github-mcp-server` | remote `streamable-http` with `Authorization` | HTTP config with bearer auth |
| `stdio-npm-public` | `io.github.ChromeDevTools/chrome-devtools-mcp` | npm stdio | `npx -y chrome-devtools-mcp@1.1.0` |
| `stdio-npm-secret-env` | `io.github.upstash/context7` | npm stdio with secret env | `npx -y @upstash/context7-mcp@1.0.31`, `CONTEXT7_API_KEY` |
| `stdio-pypi-public` | `com.mcparmory/github` | PyPI stdio | `uvx mcparmory-github==1.0.6` |
| `stdio-oci-secret-env` | `io.github.github/github-mcp-server` | OCI stdio | `docker run --rm -i -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server:1.0.4` |

Classified unsupported:

| Case | Official server | Gap |
|---|---|---|
| `stdio-npm-required-non-secret-env` | `io.github.Digital-Defiance/mcp-filesystem` | Required non-secret env/config input cannot be represented by current `RegistryDef`/CLI prompt model. |
| `remote-sse` | `ai.waystation/postgres` | SSE cannot be encoded distinctly by direct-mode install today. |
| `package-streamable-http` | `ai.com.mcp/hapi-mcp` | Package-launched HTTP servers need lifecycle/port/runtime management, not just an MCP config entry. |

## Findings

- Remote streamable HTTP is effectively handled by the current HTTP writer, although Equip collapses the official transport into legacy `http`.
- Remote `Authorization` can be approximated with current API-key auth because the writer emits `Authorization: Bearer <key>`.
- Simple npm stdio packages are installable.
- PyPI stdio can be projected to `uvx`, but this is a convention in the spike, not a productized runtime capability with dependency checks.
- OCI stdio can be projected to `docker run`, including the common "secret env var is forwarded with `-e NAME`" shape.
- Current production `RegistryDef` is too narrow for arbitrary official registry inputs because it only has one `envKey` and no general variable/value collection model.
- The spike installs and verifies exact platform config projections only. It does not prove that the platform can spawn the process successfully, that `npx`/`uvx`/`docker` exists on the user machine, or that the MCP server functions.

## Recommendation

Create a dedicated Equip install compatibility initiative for official MCP registry content. Keep it separate from review/trust work.

The next production shape should add:

- a normalized MCP install target model that preserves official registry source fields;
- a variable collection model for required env vars, package arguments, runtime arguments, and custom headers;
- explicit transport support for `streamable-http`, `sse`, `stdio`, and package-launched local HTTP as separate cases;
- runtime preflight for `npx`, `uvx`, `docker`, and eventually other registry types;
- end-to-end "write config, spawn server, initialize MCP" smoke for safe selected fixtures.

## Verification

- `npm run test:docker:mcp-registry-live:internal` passed locally on Windows.
- `npm run test:docker:mcp-registry-live` passed in Docker.
