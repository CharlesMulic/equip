# Equip

Cross-platform installer for MCP tools, behavioral rules, agent skills, and lifecycle hooks.

[![npm](https://img.shields.io/npm/v/@cg3/equip)](https://www.npmjs.com/package/@cg3/equip) | [Discord](https://discord.gg/bBcRHT4J) | [Tool Author Guide](./docs/tool-author.md)

## What It Does

You build an MCP tool. You want it to work on Claude Code, Cursor, VS Code, Windsurf, Cline, Roo Code, Codex, Gemini CLI, and more. Each platform has its own config format, file paths, root keys, URL fields, and quirks.

Equip handles all of that. One setup script, every platform.

## Install

```bash
npm install -g @cg3/equip
```

## Quick Start

```bash
equip prior                    # Install a tool
equip status                   # See what's installed across all platforms
equip doctor                   # Validate config integrity
equip update                   # Update equip + migrate configs
unequip prior                  # Remove a tool
```

## For Tool Authors

```js
const { Equip } = require("@cg3/equip");

const equip = new Equip({
  name: "my-tool",
  serverUrl: "https://mcp.example.com",
  rules: {
    content: `<!-- my-tool:v1.0.0 -->\n## My Tool\nAlways check My Tool first.\n<!-- /my-tool -->`,
    version: "1.0.0",
    marker: "my-tool",
  },
  skill: {
    name: "lookup",
    files: [{ path: "SKILL.md", content: "---\nname: lookup\ndescription: Look up docs\n---\n\n# Lookup\n" }],
  },
});

const platforms = equip.detect();
for (const p of platforms) {
  equip.installMcp(p, "api_key_here");
  equip.installRules(p);
  equip.installSkill(p);
}
```

See the [Tool Author Guide](./docs/tool-author.md) for the complete walkthrough, or run `equip demo` for an interactive example.

## The Four Layers

Equip distributes your tool through four complementary layers:

| Layer | What It Does | Reliability | Coverage |
|---|---|---|---|
| [MCP Config](./docs/mcp-servers.md) | Makes the tool *available* — agent can call it | Baseline | All platforms |
| [Behavioral Rules](./docs/rules.md) | Teaches the agent *when* to call it | Strong | Most platforms + clipboard |
| [Agent Skills](./docs/skills.md) | Gives the agent *detailed knowledge* of how to use it | Strong (varies) | Most platforms |
| [Lifecycle Hooks](./docs/hooks.md) | *Structurally enforces* behavior at key moments | Strongest | 1 platform (Claude Code) |

Each layer compensates for the limitations of the one before it. Tool descriptions alone don't reliably trigger behavior. Rules are stronger but can be compacted. Skills add depth but may not auto-invoke on all platforms. Hooks fire automatically, independent of the agent's memory.

No layer is a silver bullet. Together, they give you the best coverage available.

## Supported Platforms

| Platform | MCP | Rules | Skills | Hooks |
|---|---|---|---|---|
| Claude Code | Yes | Yes | Yes | Yes |
| Cursor | Yes | clipboard | Yes | -- |
| VS Code / Copilot | Yes | clipboard | Yes | -- |
| Windsurf | Yes | Yes | Yes | -- |
| Cline | Yes | Yes | Yes | -- |
| Roo Code | Yes | Yes | Yes | -- |
| Codex | Yes | Yes | Yes | -- |
| Gemini CLI | Yes | Yes | Yes | -- |
| Junie | Yes | -- | -- | -- |
| Copilot (JetBrains) | Yes | -- | -- | -- |
| Copilot CLI | Yes | -- | -- | -- |
| Amazon Q | Yes | -- | -- | -- |
| Tabnine | Yes | Yes | -- | -- |

See [Platforms](./docs/platforms.md) for full details — config paths, detection, and per-platform quirks.

## CLI Commands

| Command | Description |
|---|---|
| `equip <tool>` | Install an MCP tool |
| `equip status` | Cross-platform MCP server inventory |
| `equip doctor` | Validate config integrity, detect drift |
| `equip update` | Update equip and migrate configs |
| `equip list` | Show registered tools |
| `equip uninstall <tool>` | Remove a tool (alias: `unequip`) |
| `equip demo` | Run the interactive demo |

See [CLI Reference](./docs/cli.md) for details.

## Documentation

| Guide | Audience |
|---|---|
| [Tool Author Guide](./docs/tool-author.md) | Building a setup script with equip |
| [Platforms](./docs/platforms.md) | Supported platforms, capabilities, paths |
| [MCP Servers](./docs/mcp-servers.md) | Config format translation, API reference |
| [Behavioral Rules](./docs/rules.md) | Marker-based versioned instructions |
| [Agent Skills](./docs/skills.md) | SKILL.md format, cross-platform distribution |
| [Lifecycle Hooks](./docs/hooks.md) | Event-driven enforcement scripts |
| [CLI Reference](./docs/cli.md) | Commands, state tracking, tool registry |

## Key Design Decisions

- **Zero runtime dependencies** — installs fast, no supply chain risk
- **Platform registry as single source of truth** — one place for all platform knowledge
- **Atomic file writes** — crash-safe config modifications
- **State reconciliation from disk** — CLI scans what's actually installed, no stale cache
- **Corrupt config detection** — throws instead of silently overwriting

## Tool Registry

Register a shorthand for your tool so users can run `equip <name>`. Open a PR to [`registry.json`](./registry.json):

```json
{
  "my-tool": {
    "package": "@myorg/my-tool",
    "command": "setup",
    "description": "What my tool does",
    "marker": "my-tool",
    "hookDir": "~/.my-tool/hooks",
    "skillName": "my-skill"
  }
}
```

## License

MIT — Charles Mulic
