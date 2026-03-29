# @cg3/equip Demo

A minimal, working setup script that shows how to build your own MCP tool installer on top of `@cg3/equip`.

## Run it

```bash
npx @cg3/equip demo                        # dry-run (default — safe to explore)
npx @cg3/equip demo --live                  # actually write config files
npx @cg3/equip demo --uninstall             # clean up demo files
npx @cg3/equip demo --platform claude-code  # target a specific platform
```

The demo runs in **dry-run mode by default** — it shows exactly what would happen without touching any files. Use `--live` to write real config, and `--uninstall` to clean up afterward.

## What it does

The demo installs a fictional MCP tool called `acme-docs` across all detected AI coding platforms. It walks through the core equip operations:

1. **Detect** — scan for installed AI tools (Claude Code, Cursor, VS Code, etc.)
2. **API key** — prompt for or configure authentication
3. **MCP config** — write server config to each platform's config file
4. **Behavioral rules** — inject versioned instructions into agent rule files
5. **Uninstall** — cleanly remove everything the install wrote

Every step is documented inline in [`setup.js`](./setup.js).

## Use as a template

Copy `setup.js` into your own project and replace:

- `TOOL_NAME` — your MCP server name
- `SERVER_URL` — your MCP endpoint
- `RULES_CONTENT` — behavioral instructions for agents
- API key prompt — real authentication flow
- Remove the dry-run default (real tools should install by default)

Then wire it up in your `package.json`:

```json
{
  "bin": { "setup": "./setup.js" }
}
```

And register it in equip's tool registry (or run directly with `npx your-package setup`).

## API surface

The demo uses these equip APIs:

| API | Purpose |
|-----|---------|
| `new Equip(config)` | Create installer instance |
| `equip.detect()` | Find installed platforms |
| `equip.installMcp(platform, apiKey)` | Write MCP config |
| `equip.installRules(platform)` | Install behavioral rules |
| `equip.uninstallMcp(platform)` | Remove MCP config |
| `equip.uninstallRules(platform)` | Remove behavioral rules |
| `createManualPlatform(id)` | Force a specific platform |
| `platformName(id)` | Human-readable platform name |
| `cli.*` | Output helpers (colors, prompts, clipboard) |

See the [main README](../README.md) for the full API reference.
