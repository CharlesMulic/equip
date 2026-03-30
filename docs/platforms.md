# Supported Platforms

Equip supports the following AI coding platforms. Each platform has its own config format, file paths, and feature set. Equip abstracts these differences behind a unified API.

## Platform List

| ID | Name | Config Format | Root Key | Aliases |
|---|---|---|---|---|
| `claude-code` | Claude Code | JSON | `mcpServers` | `claude`, `claudecode` |
| `cursor` | Cursor | JSON | `mcpServers` | -- |
| `windsurf` | Windsurf | JSON | `mcpServers` | -- |
| `vscode` | VS Code | JSON | `servers` | `vs-code`, `code` |
| `cline` | Cline | JSON | `mcpServers` | -- |
| `roo-code` | Roo Code | JSON | `mcpServers` | `roo`, `roocode` |
| `codex` | Codex | TOML | `mcp_servers` | -- |
| `gemini-cli` | Gemini CLI | JSON | `mcpServers` | `gemini` |
| `junie` | Junie | JSON | `mcpServers` | -- |
| `copilot-jetbrains` | Copilot (JetBrains) | JSON | `mcpServers` | `copilot-jb` |
| `copilot-cli` | Copilot CLI | JSON | `mcpServers` | `copilot` |
| `amazon-q` | Amazon Q | JSON | `mcpServers` | `q`, `amazonq` |
| `tabnine` | Tabnine | JSON | `mcpServers` | -- |

## Capability Matrix

Not every platform supports every feature. This table shows what equip can install on each platform.

| Platform | MCP Config | Rules | Skills | Hooks |
|---|---|---|---|---|
| Claude Code | Yes | Yes (`~/.claude/CLAUDE.md`) | Yes (`~/.claude/skills/`) | Yes (12 events) |
| Cursor | Yes | Clipboard only | Yes (`~/.cursor/skills/`) | No |
| Windsurf | Yes | Yes (`~/.codeium/windsurf/memories/global_rules.md`) | Yes (`~/.agents/skills/`) | No |
| VS Code | Yes | Clipboard only | Yes (`~/.agents/skills/`) | No |
| Cline | Yes | Yes (`~/Documents/Cline/Rules/`) | Yes (`~/.cline/skills/`) | No |
| Roo Code | Yes | Yes (`~/.roo/rules/`) | Yes (`~/.roo/skills/`) | No |
| Codex | Yes | Yes (`~/.codex/AGENTS.md`) | Yes (`~/.agents/skills/`) | No |
| Gemini CLI | Yes | Yes (`~/.gemini/GEMINI.md`) | Yes (`~/.gemini/skills/`) | No |
| Junie | Yes | No | No | No |
| Copilot (JetBrains) | Yes | No | No | No |
| Copilot CLI | Yes | No | No | No |
| Amazon Q | Yes | No | No | No |
| Tabnine | Yes | Yes (`~/.tabnine/guidelines/`) | No | No |

"Clipboard only" means equip copies rules content to the system clipboard for the user to paste manually, since the platform has no writable rules file.

## Config Paths

All paths are resolved at runtime relative to the user's home directory. On Windows, VS Code-based paths use `%APPDATA%` instead of `~`.

### MCP Config Paths

| Platform | Path |
|---|---|
| Claude Code | `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | `<VS Code User Dir>/mcp.json` |
| Cline | `<VS Code User Dir>/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Roo Code | `<VS Code User Dir>/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json` |
| Codex | `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) |
| Gemini CLI | `~/.gemini/settings.json` |
| Junie | `~/.junie/mcp/mcp.json` |
| Copilot (JetBrains) | `<github-copilot dir>/intellij/mcp.json` |
| Copilot CLI | `~/.copilot/mcp-config.json` |
| Amazon Q | `~/.aws/amazonq/agents/default.json` |
| Tabnine | `~/.tabnine/mcp_servers.json` |

The **VS Code User Dir** is OS-dependent:
- **Windows:** `%APPDATA%\Code\User`
- **macOS:** `~/Library/Application Support/Code/User`
- **Linux:** `~/.config/Code/User`

The **github-copilot dir** is:
- **Windows:** `%APPDATA%\github-copilot`
- **Linux/macOS:** `~/.config/github-copilot`

### Rules Paths

| Platform | Path | Type |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | Single file (append) |
| Windsurf | `~/.codeium/windsurf/memories/global_rules.md` | Single file (append) |
| Cline | `~/Documents/Cline/Rules/` | Directory (standalone file) |
| Roo Code | `~/.roo/rules/` | Directory (standalone file) |
| Codex | `~/.codex/AGENTS.md` | Single file (append) |
| Gemini CLI | `~/.gemini/GEMINI.md` | Single file (append) |
| Cursor | -- | Clipboard fallback |
| VS Code | -- | Clipboard fallback |

For platforms with a directory-based rules path (Cline, Roo Code), equip writes a standalone file named via the `fileName` option in your rules config. See [rules.md](./rules.md) for details.

### Skills Paths

| Platform | Global Skills Path |
|---|---|
| Claude Code | `~/.claude/skills/` |
| Cursor | `~/.cursor/skills/` |
| Windsurf | `~/.agents/skills/` |
| VS Code | `~/.agents/skills/` |
| Cline | `~/.cline/skills/` |
| Roo Code | `~/.roo/skills/` |
| Codex | `~/.agents/skills/` |
| Gemini CLI | `~/.gemini/skills/` |

Platforms without a verified skills path (Junie, Copilot JetBrains, Copilot CLI) have `skillsPath: null` and skill installation is skipped.

## Detection Mechanism

When you call `equip.detect()`, equip checks for each platform in this order:

1. **Directory existence** -- checks platform-specific directories via `fs.statSync`. For example, Claude Code checks for `~/.claude/`, Cursor checks for `~/.cursor/`.
2. **File existence** -- checks for specific files. For example, Cline checks for its `cline_mcp_settings.json` file.
3. **CLI presence** -- only if no filesystem evidence was found, falls back to `which`/`where` to find the platform's CLI command (e.g., `claude`, `cursor`, `code`, `codex`, `gemini`).

This order is intentional: filesystem checks are fast (single `stat` call), while shelling out to `which` is slower. CLI detection is a fallback for freshly installed platforms that haven't created their config directories yet.

Each platform definition declares its detection sources:

```typescript
detection: {
  cli: "claude",                                    // CLI command name (or null)
  dirs: [() => path.join(home(), ".claude")],       // Directories to check
  files: [],                                        // Files to check
  versionFn?: () => string | null,                  // Custom version detection
}
```

Claude Code has a custom `versionFn` that runs `claude --version` and parses the semver output. Other platforms rely on the default detection.

## Platform Aliases and `resolvePlatformId`

Users can refer to platforms by their ID or any registered alias. The `resolvePlatformId()` function normalizes input:

```typescript
import { resolvePlatformId } from "@cg3/equip";

resolvePlatformId("claude");       // "claude-code"
resolvePlatformId("claudecode");   // "claude-code"
resolvePlatformId("roo");          // "roo-code"
resolvePlatformId("roocode");      // "roo-code"
resolvePlatformId("vs-code");      // "vscode"
resolvePlatformId("code");         // "vscode"
resolvePlatformId("gemini");       // "gemini-cli"
resolvePlatformId("copilot-jb");   // "copilot-jetbrains"
resolvePlatformId("copilot");      // "copilot-cli"
```

If the input doesn't match any ID or alias, it is returned as-is (lowercase, trimmed).

## Manual Platform Selection

When detection isn't desired (e.g., the user passes `--platform codex`), use `createManualPlatform()`:

```typescript
import { createManualPlatform } from "@cg3/equip";

const platform = createManualPlatform("codex");
// Returns a DetectedPlatform with all paths resolved from the registry,
// but existingMcp set to null (no config read).
```

This is useful for:
- `--platform` CLI flags
- Targeting a platform that isn't installed locally (e.g., configuring for a remote machine)
- Testing

## HTTP Config Shape

Each platform has its own field names for HTTP MCP server configuration. Equip translates automatically, but here's the full matrix for reference:

| Platform | URL Field | Type Field | Headers Field |
|---|---|---|---|
| Claude Code | `url` | `"http"` | `headers` |
| Cursor | `url` | -- | `headers` |
| Windsurf | `serverUrl` | -- | `headers` |
| VS Code | `url` | `"http"` | `headers` |
| Cline | `url` | -- | `headers` |
| Roo Code | `url` | `"streamable-http"` | `headers` |
| Codex | `url` | -- | `http_headers` |
| Gemini CLI | `httpUrl` | -- | `headers` |
| Junie | `url` | -- | `headers` |
| Copilot (JetBrains) | `url` | -- | `headers` |
| Copilot CLI | `url` | `"http"` | `headers` |
| Amazon Q | `url` | `"http"` | `headers` |
| Tabnine | `url` | -- | `requestInit.headers` (nested) |

See [mcp-servers.md](./mcp-servers.md) for details on how equip builds and writes these configs.

## Accessing the Registry Programmatically

The full platform registry is exported for advanced use:

```typescript
import { PLATFORM_REGISTRY, KNOWN_PLATFORMS, getPlatform, platformName } from "@cg3/equip";

// All platform IDs
console.log(KNOWN_PLATFORMS);
// ["claude-code", "cursor", "windsurf", "vscode", "cline", "roo-code", ...]

// Get a platform definition (throws if unknown)
const def = getPlatform("codex");
console.log(def.configPath());    // Resolved path
console.log(def.configFormat);    // "toml"

// Human-readable name
platformName("roo-code");         // "Roo Code"

// Iterate all platforms
for (const [id, def] of PLATFORM_REGISTRY) {
  console.log(id, def.name, def.configFormat);
}
```
