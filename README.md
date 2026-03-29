# @cg3/equip

Universal MCP server + behavioral rules installer for AI coding agents.

Equip handles the hard part of distributing your MCP tool: detecting which AI coding platforms are installed, writing the correct config format for each one, and managing versioned behavioral rules — all with zero dependencies.

## Run the Demo

```bash
npx @cg3/equip demo
```

A self-contained, inline-documented setup script that walks through every equip feature — platform detection, MCP config, behavioral rules, and uninstallation. Runs in dry-run mode by default (no files touched). See [`demo/setup.js`](./demo/setup.js) for the full source.

```bash
npx @cg3/equip demo --live        # actually write config files
npx @cg3/equip demo --uninstall   # clean up demo files
```

## Supported Platforms

Equip supports **11 platforms** across two tiers, depending on whether the platform has a writable location for behavioral rules.

### Full Support — MCP + Behavioral Rules

These platforms get both MCP server config *and* auto-installed behavioral rules. Rules teach agents *when* to use your tool (e.g., "search before debugging") and are versioned for idempotent updates.

| Platform | MCP Config | Rules |
|---|---|---|
| Claude Code | `~/.claude.json` (JSON, `mcpServers`) | `~/.claude/CLAUDE.md` (append) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` (JSON, `mcpServers`, `serverUrl`) | `~/.codeium/windsurf/memories/global_rules.md` (append) |
| Cline | `globalStorage/.../cline_mcp_settings.json` (JSON, `mcpServers`) | `~/Documents/Cline/Rules/` (standalone file) |
| Roo Code | `globalStorage/.../cline_mcp_settings.json` (JSON, `mcpServers`) | `~/.roo/rules/` (standalone file) |
| Codex | `~/.codex/config.toml` (TOML, `mcp_servers`) | `~/.codex/AGENTS.md` (append) |
| Gemini CLI | `~/.gemini/settings.json` (JSON, `mcpServers`, `httpUrl`) | `~/.gemini/GEMINI.md` (append) |

### MCP Only — No Writable Rules Path

These platforms get MCP server config but don't have a writable global rules file (`rulesPath: null`). The MCP tools work fine — but equip can't auto-install behavioral rules.

| Platform | MCP Config |
|---|---|
| Cursor | `~/.cursor/mcp.json` (JSON, `mcpServers`, `type: "streamable-http"`) |
| VS Code | `Code/User/mcp.json` (JSON, `servers`, `type: "http"`) |
| Junie (JetBrains) | `~/.junie/mcp/mcp.json` (JSON, `mcpServers`) |
| Copilot (JetBrains) | `~/.config/github-copilot/intellij/mcp.json` (JSON, `mcpServers`) |
| Copilot CLI | `~/.copilot/mcp-config.json` (JSON, `mcpServers`) |

For these platforms, `installRules()` returns `{ action: "clipboard" }` if the platform is in the configurable `clipboardPlatforms` list (default: `["cursor", "vscode"]`), or `{ action: "skipped" }` otherwise. It's up to the consumer to decide how to handle this — e.g., copying rules to the clipboard, printing instructions, or skipping silently.

### Hooks — Structural Enforcement

Some platforms support **lifecycle hooks** — scripts that run automatically at key moments (e.g., after a tool fails, when the agent finishes responding). Hooks provide structural enforcement that behavioral rules alone cannot:

| Platform | Hooks Support | Events |
|---|---|---|
| Claude Code | ✅ | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Notification`, `SubagentStart`, `SubagentStop`, `PreCompact`, `TaskCompleted` |
| All others | ❌ | — |

When hooks are supported, equip writes the consumer-provided scripts to a configurable directory (default: `~/.${name}/hooks/`) and registers them in the platform's settings. Hooks are a **silent enhancement** — if the platform doesn't support them, equip installs only MCP + rules without any error or warning.

Hook scripts and event bindings are defined by the consumer (your package), not by equip. Equip provides only the installation infrastructure — capabilities detection, file writing, settings registration, and cleanup. As more platforms add hook support, equip can enable them without consumer code changes.

## Quick Start

```bash
npx @cg3/equip prior
```

That's it. Detects your platforms, authenticates, installs MCP + rules, and verifies — all in one command. Pass `--dry-run` to preview without writing files.

## CLI Usage

You can invoke any npm package that has an equip-based setup command:

```bash
# Full package name + command
npx @cg3/equip @cg3/prior-node setup

# Shorthand (if registered)
npx @cg3/equip prior
```

The CLI runs `npx -y <package>@latest <command>` with any extra args forwarded (e.g. `--dry-run`, `--platform codex`).

### Shorthand Registry

Registered shorthands save typing. Open a PR to `bin/equip.js` to add yours:

| Shorthand | Expands to |
|---|---|
| `prior` | `@cg3/prior-node setup` |

## Programmatic Usage

```js
const { Equip } = require("@cg3/equip");

const equip = new Equip({
  name: "my-tool",
  serverUrl: "https://mcp.example.com",
  rules: {
    content: `<!-- my-tool:v1.0.0 -->\n## My Tool\nAlways check My Tool first.\n<!-- /my-tool -->`,
    version: "1.0.0",
    marker: "my-tool",
    fileName: "my-tool.md",  // For platforms with rules directories
  },
});

// Detect installed platforms
const platforms = equip.detect();

// Install MCP + rules on all detected platforms
for (const p of platforms) {
  equip.installMcp(p, "api_key_here");
  equip.installRules(p);
}

// Uninstall
for (const p of platforms) {
  equip.uninstallMcp(p);
  equip.uninstallRules(p);
}
```

## API

### `new Equip(config)`

- `config.name` — Server name in MCP configs (required)
- `config.serverUrl` — Remote MCP server URL (required unless `stdio` provided)
- `config.rules` — Behavioral rules config (optional)
  - `content` — Markdown content with version markers
  - `version` — Version string for idempotency tracking
  - `marker` — Marker name used in `<!-- marker:vX.X -->` comments
  - `fileName` — Standalone filename for directory-based platforms
  - `clipboardPlatforms` — Platform IDs that use clipboard (default: `["cursor", "vscode"]`)
- `config.stdio` — Stdio transport config (optional, alternative to HTTP)
  - `command`, `args`, `envKey`
- `config.hooks` — Lifecycle hook definitions (optional, array)
  - `event` — Hook event name (e.g., `"PostToolUseFailure"`)
  - `matcher` — Regex matcher for event filtering (optional, e.g., `"Bash"`)
  - `script` — Hook script content (Node.js)
  - `name` — Script filename (without `.js` extension)
- `config.hookDir` — Directory for hook scripts (default: `~/.${name}/hooks/`)

### Instance Methods

- `equip.detect()` — Returns array of detected platform objects
- `equip.installMcp(platform, apiKey, options?)` — Install MCP config
- `equip.uninstallMcp(platform, dryRun?)` — Remove MCP config
- `equip.updateMcpKey(platform, apiKey, transport?)` — Update API key
- `equip.installRules(platform, options?)` — Install behavioral rules
- `equip.uninstallRules(platform, dryRun?)` — Remove behavioral rules
- `equip.readMcp(platform)` — Check if MCP is configured
- `equip.buildConfig(platformId, apiKey, transport?)` — Build MCP config object
- `equip.installHooks(platform, options?)` — Install lifecycle hooks (if supported)
- `equip.uninstallHooks(platform, options?)` — Remove hooks
- `equip.hasHooks(platform, options?)` — Check if hooks are installed
- `equip.supportsHooks(platform)` — Check if platform supports hooks

### Primitives

All internal functions are also exported for advanced usage:

```js
const { detectPlatforms, installMcpJson, installRules, createManualPlatform, platformName, resolvePlatformId, cli } = require("@cg3/equip");
```

- `resolvePlatformId(input)` — Resolve a friendly name or alias to a canonical platform ID (e.g., `"claude"` → `"claude-code"`, `"roo"` → `"roo-code"`)

## Key Features

- **Zero dependencies** — Pure Node.js, works with Node 18+
- **11 platforms** — Covers ~80% of active AI coding tool users
- **Platform-aware** — Handles each platform's config quirks (JSON vs TOML, root keys, URL fields, type requirements)
- **Non-destructive** — Merges into existing configs, creates backups, preserves other servers
- **Versioned rules** — Marker-based blocks enable idempotent updates without clobbering user content
- **Dry-run support** — Preview changes without writing files
- **CLI helpers** — Colored output, prompts, clipboard utilities included

## How the Layers Work Together

Equip distributes your MCP tool through three complementary layers, each stronger than the last:

1. **MCP config** — Makes the tool available. The agent *can* call it.
2. **Behavioral rules** — Teaches the agent *when* to call it. Rules live in the agent's system prompt or project context, close to where decisions happen.
3. **Lifecycle hooks** — Structurally enforces behavior at key moments (e.g., after an error, on task completion). Hooks inject context into the agent's reasoning at exactly the right time, without relying on the agent remembering its rules.

Each layer compensates for the limitations of the one before it:

- **Tool descriptions alone** don't reliably trigger behavior. [Research on 856 MCP tools](https://arxiv.org/abs/2602.14878) found that even fully optimized descriptions only improve task success by ~6 percentage points.
- **Behavioral rules** are stronger, but can be dropped during context window compaction in long sessions, and the agent can still rationalize skipping them.
- **Lifecycle hooks** are the strongest available enforcement — they fire automatically at the platform level, independent of the agent's memory or reasoning. Not all platforms support hooks yet, but equip installs them where available and silently skips where not.

No layer is a silver bullet. Together, they give you the best coverage available today across the broadest set of platforms.

## License

MIT — Charles Mulic
