# MCP Registry Compatibility Canary

**Status:** complete as a repeatable live canary harness  
**Created:** 2026-05-26  
**Command:** `npm run test:docker:mcp-registry-live`

## Question

Can the Equip CLI project representative official MCP registry servers into real platform config files using the same install writer that registry-backed augments use?

## Why This Matters

Users expect an MCP server listed in the official registry to become an installable augment whenever its target can be represented safely in platform configuration. The official MCP registry describes `packages` and `remotes`; the Equip CLI consumes a normalized registry response with fields such as `serverUrl`, `stdioCommand`, `stdioArgs`, `envKey`, and `auth`.

This canary answers a narrow compatibility question: "can Equip write the platform config?" It does not answer whether a server is safe, trustworthy, or functionally correct.

## Harness

The harness:

1. Fetches retained cases from `https://registry.modelcontextprotocol.io`.
2. Projects installable targets into a local Equip registry-shaped response.
3. Starts a local registry stub.
4. Runs `bin/equip.js` against fake platform homes in Docker.
5. Verifies config files for Claude Code, Codex, Cursor, VS Code, and Roo Code. SSE cases are verified only on platforms with an explicit direct SSE shape: Claude Code and VS Code.
6. Probes the Docker image for runtime executables referenced by stdio configs.

Retained live cases live in `test/docker/fixtures/live-mcp-registry-cases.json`. The fixture intentionally uses `latest` registry versions so it acts as a live canary/discovery harness. It is not deterministic regression evidence; when upstream metadata changes, the case list or support expectations should be reviewed intentionally.

The Docker image includes Node/npm, `uvx`, and the Docker CLI. It does not mount a Docker daemon/socket by default, so OCI stdio entries are config-ready and CLI-ready, but not daemon-ready inside the canary container unless the caller supplies Docker access deliberately. OCI cases use the CLI's documented `--force` path in this canary so the test can still prove platform config projection without running third-party containers.

## Registry Shape Sample

On 2026-05-26, a 1,200-row live API sample across latest registry versions found these representative shapes:

| Shape | Count in sample | Example |
|---|---:|---|
| remote `streamable-http` with `Authorization` | 267 | `ai.adadvisor/mcp-server` |
| remote `streamable-http` without headers | 257 | `ac.inference.sh/mcp` |
| remote `sse` | 39 | `ai.agentrapay/agentra` |
| npm stdio without env vars | 22 | `ai.adeu/adeu` |
| npm stdio with one secret env var | 10 | `io.github.upstash/context7` |
| npm stdio with secret plus plain/default env vars | 11 | `ai.fodda/mcp-server`, `ai.ponlo/server` |
| PyPI stdio without env vars | 5 | `ai.mcpcap/mcpcap` |
| PyPI stdio with one secret env var | 8 | `ai.anomalyarmor/armor-mcp`, `ai.linkguard/linkguard-mcp` |
| remote `streamable-http` with non-Authorization or multiple headers | 12+ | `ai.reka/mcp`, `ai.com.mcp/contabo` |
| remote `streamable-http` with variables | 1+ | `co.heista/api` |
| remote `sse` with headers | 3 | `ai.fodda/mcp-server` |
| OCI stdio with env vars or package args | 4 | `io.github.github/github-mcp-server`, `ai.haymon/database` |
| package-launched streamable HTTP | 4 | `ai.haymon/database`, `ai.com.mcp/hapi-mcp` |

The registry API is live and slow enough that full scans should use a data ingestion or reconciliation process rather than this canary test. This harness keeps a representative retained set instead.

## Current Results

Installed successfully:

| Case | Official server | Target | Equip projection |
|---|---|---|---|
| `remote-streamable-public` | `ac.tandem/docs-mcp` | remote `streamable-http` | `serverUrl=https://tandem.ac/mcp` |
| `remote-streamable-authorization` | `io.github.github/github-mcp-server` | remote `streamable-http` with `Authorization` | HTTP config with bearer auth |
| `remote-sse` | `ai.waystation/postgres` | remote `sse` | Claude Code / VS Code `type=sse` config |
| `remote-sse-headers` | `ai.fodda/mcp-server` | remote `sse` with `Authorization` | Claude Code / VS Code `type=sse` config with bearer auth |
| `stdio-npm-public` | `io.github.ChromeDevTools/chrome-devtools-mcp` | npm stdio | `npx -y chrome-devtools-mcp@1.1.1` |
| `stdio-npm-secret-env` | `io.github.upstash/context7` | npm stdio with secret env | `npx -y @upstash/context7-mcp@1.0.31`, `CONTEXT7_API_KEY` |
| `stdio-pypi-public` | `com.mcparmory/github` | PyPI stdio | `uvx mcparmory-github==1.0.6` |
| `stdio-pypi-secret-env` | `ai.anomalyarmor/armor-mcp` | PyPI stdio with secret env | `uvx armor-mcp==0.6.1`, `ARMOR_API_KEY` |
| `stdio-npm-package-args` | `ai.telbase/deploy` | npm stdio with package args | `npx -y telbase@0.14.0-beta.2 mcp serve` |
| `stdio-npm-secret-plus-default-env` | `ai.fodda/mcp-server` | npm stdio with secret env and optional default env | `npx -y fodda-mcp@1.3.0`, `FODDA_API_KEY`; warns that `FODDA_API_URL` default is omitted |
| `stdio-npm-default-env-only` | `ai.autonomad/travel` | npm stdio with optional/default env metadata | `npx -y autonomad-travel@1.4.0`; warns that default env metadata is omitted |
| `stdio-pypi-secret-plus-plain-env` | `ai.linkguard/linkguard-mcp` | PyPI stdio with one secret env plus extra plain env metadata | `uvx linkguard-mcp==0.1.0`, `LINKGUARD_API_KEY` |
| `stdio-oci-secret-env` | `io.github.github/github-mcp-server` | OCI stdio | `docker run --rm -i -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server:1.0.4` |
| `stdio-oci-package-args` | `ai.haymon/database` | OCI stdio with package args | `docker run --rm -i ghcr.io/haymon-ai/database:0.7.0 stdio` |

Classified unsupported:

| Case | Official server | Gap |
|---|---|---|
| `stdio-npm-required-non-secret-env` | `io.github.Digital-Defiance/mcp-filesystem` | Required non-secret env/config input cannot be represented by the current CLI prompt model. |
| `remote-streamable-url-vars` | `ai.autorfp/mcp` | URL template variables need a value collection/substitution flow. |
| `remote-streamable-secret-url-var` | `app.cardog/mcp` | Secret URL variables need secure collection and substitution; current auth model only handles headers/env. |
| `remote-streamable-custom-header` | `ai.reka/mcp` | Non-Authorization headers need first-class header-name/value support. |
| `remote-streamable-multiple-headers` | `ai.com.mcp/contabo` | Multiple headers need structured header collection, including non-secret header values. |
| `remote-streamable-empty-header-name` | `app.aspirelearning/mcp` | Malformed or templated header metadata cannot be represented safely without validation and variable collection. |
| `remote-streamable-header-variable` | `co.heista/api` | Header value variables are currently classified with remote variables and need secure variable substitution. |
| `stdio-npm-secret-required-plain-env` | `ai.ponlo/server` | Required plain env plus secret env needs a multi-input collection model. |
| `stdio-npm-multiple-secret-env` | `ai.wild-card/deepcontext` | Multiple secret env vars need a multi-credential config surface. |
| `stdio-pypi-multiple-secret-env` | `ai.dynsoft/sac` | Multiple secret env vars need a multi-credential config surface. |
| `stdio-pypi-package-argument-variable` | `aws.api.us-east-1.ecs-mcp/server` | Package arguments with variables need user value collection/substitution. |
| `package-streamable-http` | `ai.com.mcp/hapi-mcp` | Package-launched HTTP servers need lifecycle/port/runtime management, not just an MCP config entry. |

Runtime preflight from the Docker canary:

| Command | Available in canary image | Notes |
|---|---|---|
| `npx` | yes | npm stdio configs should be spawnable by a platform in the container. |
| `uvx` | yes | PyPI stdio configs should be spawnable by a platform in the container. |
| `docker` | yes | OCI stdio configs need Docker daemon/socket access to actually start the nested server; the default canary intentionally does not mount it. |

## Findings

- Remote streamable HTTP is handled by the current HTTP writer while preserving the selected target internally. Legacy flat definitions still accept `transport: "http"` for compatibility.
- Remote SSE is installable on platforms with an explicit SSE config shape. The retained canary verifies Claude Code and VS Code entries with `type: "sse"` and blocks other platforms rather than collapsing SSE into streamable HTTP.
- Remote `Authorization` can be approximated with current API-key auth because the writer emits `Authorization: Bearer <key>`.
- Simple npm stdio packages are installable.
- PyPI stdio can be projected to `uvx` and is covered by runtime preflight.
- OCI stdio can be projected to `docker run`, including the common "secret env var is forwarded with `-e NAME`" shape.
- Package arguments with literal/default values can be projected into stdio args.
- Optional/default environment variables are currently only reported as warnings because the normalized registry response can carry one credential env key but not a general env map.
- The current normalized registry response is too narrow for arbitrary official registry inputs because it only has one `envKey` and no general variable/value collection model.
- The canary installs and verifies exact platform config projections and Docker-image runtime executables. It does not execute third-party MCP code or prove that the MCP server initializes/functions, and OCI stdio still requires a Docker daemon/socket where the platform runs.
- A separate Docker initialize smoke now proves the next runtime step for local allowlisted registry-shaped fixtures: one npm stdio target launched through `npx` and one PyPI stdio target launched through `uvx` both answer MCP `initialize` with redacted diagnostics and timeout coverage. This remains separate from the live registry canary because it executes code; the live canary still does not run arbitrary third-party registry packages.

## Open Compatibility Gaps

Future CLI compatibility work should add:

- a normalized MCP install target model that preserves official registry source fields;
- a variable collection model for required env vars, package arguments, runtime arguments, URL templates, and custom headers;
- broader platform confirmation for direct SSE support beyond Claude Code and VS Code;
- explicit transport support for package-launched local HTTP as a separate case;
- runtime preflight for future registry package types beyond `npx`, `uvx`, and Docker;
- end-to-end "write config, spawn server, initialize MCP" smoke for safe selected fixtures.

## Verification

- `npm run test:docker:mcp-registry-live:container` passed locally on Windows.
- `npm run test:docker:mcp-registry-live` passed in Docker.
