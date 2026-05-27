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

The registry API is live and slow enough that full scans should use the ingestion reconciler rather than the canary test. This harness keeps a representative retained set instead.

## Current Results

Installed successfully:

| Case | Official server | Target | Equip projection |
|---|---|---|---|
| `remote-streamable-public` | `ac.tandem/docs-mcp` | remote `streamable-http` | `serverUrl=https://tandem.ac/mcp` |
| `remote-streamable-authorization` | `io.github.github/github-mcp-server` | remote `streamable-http` with `Authorization` | HTTP config with bearer auth |
| `stdio-npm-public` | `io.github.ChromeDevTools/chrome-devtools-mcp` | npm stdio | `npx -y chrome-devtools-mcp@1.1.0` |
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
| `stdio-npm-required-non-secret-env` | `io.github.Digital-Defiance/mcp-filesystem` | Required non-secret env/config input cannot be represented by current `RegistryDef`/CLI prompt model. |
| `remote-sse` | `ai.waystation/postgres` | SSE cannot be encoded distinctly by direct-mode install today. |
| `remote-sse-headers` | `ai.fodda/mcp-server` | SSE with auth headers is still blocked by lack of SSE support. |
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

- Remote streamable HTTP is effectively handled by the current HTTP writer, although Equip collapses the official transport into legacy `http`.
- Remote `Authorization` can be approximated with current API-key auth because the writer emits `Authorization: Bearer <key>`.
- Simple npm stdio packages are installable.
- PyPI stdio can be projected to `uvx`, but this is a convention in the spike, not a productized runtime capability with dependency checks.
- OCI stdio can be projected to `docker run`, including the common "secret env var is forwarded with `-e NAME`" shape.
- Package arguments with literal/default values can be projected into stdio args.
- Optional/default environment variables are currently only reported as warnings because the direct registry shape can carry one credential env key but not a general env map.
- Current production `RegistryDef` is too narrow for arbitrary official registry inputs because it only has one `envKey` and no general variable/value collection model.
- The spike installs and verifies exact platform config projections and Docker-image runtime executables. It does not execute third-party MCP code or prove that the MCP server initializes/functions, and OCI stdio still requires a Docker daemon/socket where the platform runs.
- The desktop app uses the same core registry-to-platform writer for install config, but its current registry install UX does not provide a first-class API-key entry flow for arbitrary registry `api_key` installs. API-key installs work cleanly through the CLI and can work in the app when a credential is already available, but productized app support needs explicit credential collection rather than falling back to terminal-style prompting.
- The app-side registry journal now preserves stdio `envKey` in persisted content, matching the CLI content model.

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
