# MCP Server Configuration

Equip translates a single MCP server definition into the correct format for each platform. You provide the server URL and API key once; equip handles the per-platform differences in field names, root keys, config formats, and file locations.

## What Equip Does

Given an MCP server URL and an API key, equip:

1. Looks up the target platform's config shape (URL field, type field, headers field, root key)
2. Builds the config entry in the platform's native format
3. Reads the existing config file (preserving other entries)
4. Merges the new entry and writes the file atomically

This means you never need to know that Windsurf uses `serverUrl` while Gemini CLI uses `httpUrl`, or that Codex uses TOML while everyone else uses JSON. Equip handles all of it.

## Format Differences

### Root Keys

Platforms use different top-level keys to hold MCP server definitions:

| Root Key | Platforms |
|---|---|
| `mcpServers` | Claude Code, Cursor, Windsurf, Cline, Roo Code, Gemini CLI, Junie, Copilot JetBrains, Copilot CLI, Amazon Q, Tabnine |
| `servers` | VS Code |
| `mcp_servers` | Codex |

### URL Fields

| Field | Platforms |
|---|---|
| `url` | Claude Code, Cursor, VS Code, Cline, Roo Code, Codex, Junie, Copilot JetBrains, Copilot CLI, Amazon Q, Tabnine |
| `serverUrl` | Windsurf |
| `httpUrl` | Gemini CLI |

### Type Fields

Some platforms require an explicit transport type field:

| Value | Platforms |
|---|---|
| `"http"` | Claude Code and VS Code for streamable HTTP; Copilot CLI, Amazon Q |
| `"sse"` | Claude Code and VS Code for SSE |
| `"streamable-http"` | Roo Code |
| *(none)* | All others |

### Headers Fields

| Field | Platforms |
|---|---|
| `headers` | All except Codex and Tabnine |
| `http_headers` | Codex |
| `requestInit.headers` | Tabnine |

### Config Format

| Format | Platforms |
|---|---|
| JSON | All except Codex |
| TOML | Codex |

See [platforms.md](./platforms.md) for the complete matrix.

## Remote vs Stdio Transport

Equip supports remote and stdio MCP transports.

### Remote Transport (default)

The server runs remotely. Equip writes the platform-specific URL, transport type, and auth headers. Legacy `transport: "http"` is treated as remote streamable HTTP for compatibility. Structured install targets should prefer `transport: "streamable-http"` or `transport: "sse"`:

```json
{
  "mcpServers": {
    "my-tool": {
      "url": "https://api.example.com/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer sk-xxx"
      }
    }
  }
}
```

### Stdio Transport

The server runs as a local subprocess. Equip writes the command, args, and environment variables:

```json
{
  "mcpServers": {
    "my-tool": {
      "command": "npx",
      "args": ["-y", "@example/my-mcp@latest"],
      "env": {
        "MY_API_KEY": "sk-xxx"
      }
    }
  }
}
```

On Windows, stdio commands are automatically wrapped with `cmd /c`:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@example/my-mcp@latest"],
  "env": { "MY_API_KEY": "sk-xxx" }
}
```

## Structured Install Targets

Registry definitions can provide `installTargets` when one augment has richer MCP install metadata than the legacy flat fields can express. Equip prefers `installTargets` when present and falls back to `serverUrl`, `stdioCommand`, `stdioArgs`, and `envKey` for older definitions.

```json
{
  "name": "example-mcp",
  "installTargets": [
    {
      "targetKey": "npm-stdio",
      "targetKind": "stdio",
      "transport": "stdio",
      "registryType": "npm",
      "identifier": "@example/my-mcp",
      "version": "1.2.3",
      "runtimeHint": "npx",
      "runtimeArguments": [
        { "type": "positional", "value": "--quiet" }
      ],
      "packageArguments": [
        { "type": "positional", "value": "serve" }
      ],
      "environmentVariables": [
        { "key": "MY_API_KEY", "name": "MY_API_KEY", "kind": "env", "required": true, "secret": true },
        { "key": "REGION", "name": "REGION", "kind": "env", "required": false, "secret": false, "default": "us" }
      ]
    }
  ]
}
```

For package stdio targets, Equip can project:

- `registryType: "npm"` to `npx -y <identifier>@<version>`
- `registryType: "pypi"` to `uvx <identifier>==<version>`
- `registryType: "oci"` or `"docker"` to `docker run --rm -i <identifier>`

Use `runtimeArguments` for arguments to the runtime command and `packageArguments` for arguments to the MCP server package/binary. Literal `value` and non-secret `default` values are projected into the generated command. Arguments with variables or required values without defaults are recognized but blocked until structured substitution is available.

Remote targets use `targetKind: "remote"`, `transport: "streamable-http"` or `transport: "sse"`, and `url`. A single required secret credential input is supported for standard Authorization bearer configuration:

```json
{
  "targetKey": "remote-auth",
  "targetKind": "remote",
  "transport": "streamable-http",
  "url": "https://api.example.com/mcp",
  "inputs": [
    { "key": "Authorization", "kind": "credential", "label": "API token", "required": true, "secret": true }
  ]
}
```

Values for required inputs come from prompts, `--mcp-input KEY=VALUE`, `--mcp-input-file KEY=path`, or a caller-provided `mcpInstallInputs` map. Definition files should describe required values, not contain raw user secrets.

SSE is platform-dependent. Equip currently writes direct SSE config for Claude Code and VS Code, which both use `type: "sse"`. Platforms without an explicit SSE shape block with `remote-sse-unsupported` instead of silently installing a streamable HTTP-shaped entry.

## Runtime Preflight

Equip separates "can this target be represented in platform config?" from "can this machine run the local process later?"

Remote MCP targets normally need no local runtime, so install can proceed once URL/auth config is representable. Stdio MCP targets run as local subprocesses managed by the agent platform, so Equip checks the inferred runtime before writing config:

- npm stdio: Node plus `npx`
- PyPI stdio: `uvx`
- OCI/Docker stdio: Docker CLI plus Docker daemon reachability when the check is explicitly requested
- direct command stdio: the command must be visible on `PATH`

Runtime checks are preflight checks only. They do not initialize the MCP server, call tools, read resources, or execute arbitrary package code. The CLI blocks normal installs when required runtimes are missing, allows `--dry-run` reporting, and allows a deliberate `--force` install. Desktop callers should run the readiness API before install and pass collected values through `mcpInstallInputs`; the sidecar also rejects installs when the selected stdio runtime is not ready.

On Windows, passive readiness checks resolve shim commands such as `npx.cmd`, `npm.cmd`, `uvx.cmd`, and `docker.cmd` to the exact PATH entry before running version checks, including when the resolved path contains spaces. This avoids accidentally executing a current-directory shadow command.

## Functional Smoke Testing

Equip keeps functional MCP execution separate from normal install. The Docker initialize smoke (`npm run test:docker:mcp-initialize-smoke`) launches only local allowlisted registry-shaped npm/PyPI fixtures, sends MCP `initialize`, redacts diagnostics, and kills the process group afterward. It proves that the package target plumbing can produce launchable stdio MCP configs, but it is not a publisher safety review and does not execute arbitrary live registry packages.

## How `installMcp` Works

### Atomic Writes

Every config file write uses atomic operations:

1. Write content to `<path>.tmp`
2. Rename `<path>.tmp` to `<path>` (atomic on most filesystems)
3. Parent directories are created if they don't exist

This prevents partial writes from corrupting config files if the process is interrupted.

### Backup Management

Before modifying an existing config file:

1. The current file is copied to `<path>.bak`
2. The new content is written atomically
3. On success, the `.bak` file is cleaned up

If something goes wrong, the `.bak` file remains as a recovery point.

### Config Merging

Equip never overwrites the entire config file. It:

1. Reads the existing file (or starts with `{}` if the file doesn't exist)
2. Ensures the root key exists (e.g., `mcpServers`)
3. Sets or replaces the specific server entry
4. Writes back the full config with all other entries preserved

For JSON files:

```typescript
const config = existing || {};
if (!config[rootKey]) config[rootKey] = {};
config[rootKey][serverName] = mcpEntry;
```

For TOML files (Codex), if the server entry already exists, it is removed first, then the new block is appended.

### Corrupt Config Handling

Equip distinguishes between missing and corrupt config files:

- **Missing file** -- creates a new file with just the server entry
- **Corrupt file** (exists but cannot be parsed as JSON) -- throws an error with guidance:

```
Cannot install to ~/.cursor/mcp.json: Invalid JSON: Unexpected token ...
Fix the file manually or restore from ~/.cursor/mcp.json.bak if available.
```

Equip will never silently overwrite a corrupt file. This protects against data loss if a config file was hand-edited with a syntax error.

## API Reference

### `equip.buildConfig(platformId, apiKey, transport?)`

Build a config entry without writing it. Useful for previewing what equip would write.

```typescript
const equip = new Augment({ name: "my-tool", serverUrl: "https://api.example.com/mcp" });

// HTTP config for Claude Code
equip.buildConfig("claude-code", "sk-xxx");
// { url: "https://api.example.com/mcp", type: "http", headers: { Authorization: "Bearer sk-xxx" } }

// HTTP config for Windsurf
equip.buildConfig("windsurf", "sk-xxx");
// { serverUrl: "https://api.example.com/mcp", headers: { Authorization: "Bearer sk-xxx" } }

// Stdio config (requires stdio in AugmentConfig)
equip.buildConfig("claude-code", "sk-xxx", "stdio");
// { command: "npx", args: ["-y", "@example/my-mcp@latest"], env: { MY_API_KEY: "sk-xxx" } }

// SSE config for platforms with direct SSE support
equip.buildConfig("vscode", null, "sse");
// { url: "https://api.example.com/mcp", type: "sse" }
```

### `equip.installMcp(platform, apiKey, options?)`

Write the MCP config entry to a platform's config file.

```typescript
const platforms = equip.detect();
const apiKey = process.env.MY_AUGMENT_API_KEY || null;
for (const p of platforms) {
  const result = equip.installMcp(p, apiKey, { transport: "http", dryRun: false });
  // result: { artifact: "mcp", success: true, action: "created", method: "json" }
}
```

**Options:**
- `transport` -- `"http"` / `"streamable-http"` (default remote), `"sse"`, or `"stdio"`
- `dryRun` -- `true` to skip file writes

**Returns:** `ArtifactResult` with MCP-specific `method` set to `"json"` or `"toml"`.

### `equip.uninstallMcp(platform, dryRun?)`

Remove the server entry from a platform's config file.

```typescript
const removed = equip.uninstallMcp(platform);
// true if the entry was found and removed, false otherwise
```

If removing the entry leaves the config file empty, the file is deleted entirely rather than leaving an empty `{}`.

### `equip.readMcp(platform)`

Read the current MCP config entry for this augment on a platform.

```typescript
const entry = equip.readMcp(platform);
// { url: "https://...", headers: { Authorization: "Bearer ..." } }
// or null if not configured
```

### `equip.updateMcpKey(platform, apiKey, transport?)`

Update the API key in an existing config entry. Functionally equivalent to `installMcp` but semantically signals a key rotation.
When `transport` is omitted, Equip reads the existing platform entry and preserves `type: "sse"` for SSE remotes instead of rewriting the server as streamable HTTP.

```typescript
const result = equip.updateMcpKey(platform, newApiKey);
// { artifact: "mcp", success: true, action: "updated", method: "json" }
```

### Low-Level Functions

For advanced use, the `Augment` class methods call internal functions from `src/lib/mcp.ts`. These are not part of the public API — use the `Augment` class methods (`buildConfig`, `installMcp`, `uninstallMcp`, `updateMcpKey`) instead.

## TOML Support

Codex uses TOML config files. Equip includes a minimal zero-dependency TOML handler that supports the flat table structure used by MCP config:

```toml
[mcp_servers.my-tool]
url = "https://api.example.com/mcp"

[mcp_servers.my-tool.http_headers]
Authorization = "Bearer sk-xxx"
```

The TOML handler supports strings, numbers, booleans, arrays, and nested sub-tables. Values containing Windows backslashes are emitted as TOML literal strings so paths like `C:\dev\my-server.cmd` remain valid TOML, and the reader recognizes those literal strings on round-trip. It is not a full TOML parser -- it covers exactly the subset needed for MCP configuration.
