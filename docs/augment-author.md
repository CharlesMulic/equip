# Building Augments

This guide walks through building an augment — a package of MCP config, behavioral rules, and skills that enhances AI agents across platforms.

## What's in an Augment

An augment can include any combination of:

| Layer | Purpose | Always loaded? |
|-------|---------|---------------|
| **MCP Server** | Tools the agent can call | Yes (tool definitions) |
| **Behavioral Rules** | When and how to use the tools | Yes |
| **Skills** | Detailed knowledge loaded on demand | Frontmatter: yes, body: on-demand |

Equip installs all layers across every detected platform in a single command: `equip <your-augment>`.

## Quick Start: The Pirate Hat

Let's build a simple augment that makes agents talk like pirates. No MCP server needed — just rules and a skill.

### 1. Create a setup script

```js
// piratehat.js
const { Augment, platformName, cli } = require("@cg3/equip");

const augment = new Augment({
  name: "piratehat",
  rules: {
    content: `<!-- piratehat:v1.0.0 -->
## Pirate Mode
Respond to every message in full pirate speak. Use "arr", "matey", "ye", and nautical metaphors.
<!-- /piratehat -->`,
    version: "1.0.0",
    marker: "piratehat",
  },
});

const platforms = augment.detect();
for (const p of platforms) {
  const result = augment.installRules(p);
  if (result.success) cli.ok(`${platformName(p.platform)} — rules installed`);
}
```

### 2. Test locally

```bash
equip ./piratehat.js
```

Equip runs your script, then reconciles state — tracking what was installed on which platforms.

### 3. Verify

```bash
equip status    # Shows piratehat across platforms
equip doctor    # Validates config integrity
```

### 4. Publish

Publish your augment to Equip's registry to make it discoverable and installable by anyone:

```bash
# Via the desktop app: use the Publish button on the edit form
# Via API: POST to https://api.cg3.io/equip/augments (requires publisher profile + auth)
```

Once published, anyone can install it with:

```bash
equip piratehat
```

## Adding an MCP Server

If your augment has a live API, add a server URL:

```js
const augment = new Augment({
  name: "my-augment",
  serverUrl: "https://mcp.example.com",
  rules: {
    content: `<!-- my-augment:v1.0.0 -->\nUse my-augment for X.\n<!-- /my-augment -->`,
    version: "1.0.0",
    marker: "my-augment",
  },
});

const platforms = augment.detect();
for (const p of platforms) {
  augment.installMcp(p, apiKey);   // MCP config with auth header
  augment.installRules(p);          // Behavioral rules
}
```

Equip translates the config for each platform — different root keys, URL field names, header formats, and type fields are handled automatically.

## Adding a Skill

Skills give agents detailed knowledge that loads on demand:

```js
const augment = new Augment({
  name: "my-augment",
  serverUrl: "https://mcp.example.com",
  skills: [{
    name: "lookup",
    files: [{
      path: "SKILL.md",
      content: `---
name: lookup
description: Look up documentation from the my-augment knowledge base
---

# Lookup Skill

Use this when the user asks about...`,
    }],
  }],
});

const platforms = augment.detect();
for (const p of platforms) {
  augment.installMcp(p, apiKey);
  augment.installSkill(p);
}
```

The skill's `description` in the YAML frontmatter is always loaded (agents see it at startup). The full body loads on demand when the description matches the task.

## The Registry

The registry at `api.cg3.io/equip` hosts published augment definitions. When a user runs `equip <name>`, equip fetches the definition from the registry and installs everything automatically.

A registry definition includes everything equip needs to install the augment:

```json
{
  "name": "my-augment",
  "displayName": "My Augment",
  "description": "Does X for AI agents",
  "installMode": "direct",
  "transport": "http",
  "serverUrl": "https://mcp.example.com",

  "auth": {
    "type": "api_key",
    "keyPrompt": "Enter your My Augment API key",
    "keyHelpUrl": "https://example.com/keys",
    "keyEnvVar": "MY_AUGMENT_KEY"
  },

  "rules": {
    "content": "<!-- my-augment:v1.0.0 -->\nUse my-augment...\n<!-- /my-augment -->",
    "version": "1.0.0",
    "marker": "my-augment",
    "fileName": "my-augment.md"
  },

  "skills": [{
    "name": "lookup",
    "files": [{ "path": "SKILL.md", "content": "---\nname: lookup\n..." }]
  }],

  "dashboardUrl": "https://example.com/dashboard",
  "platformHints": {
    "cursor": "Restart Cursor to pick up the new MCP configuration."
  }
}
```

When a user runs `equip my-augment`, equip fetches this definition from the API and installs everything in-process — MCP config, auth (prompting for API key), rules, and skills across all detected platforms.

## Auth Types

The `auth` block in your registry definition declares what authentication your augment needs:

| Type | Use case | What happens |
|------|----------|-------------|
| `"none"` | Public servers | No auth prompt |
| `"api_key"` | User has a key | Prompt or `--api-key` flag |
| `"oauth"` | OAuth 2.1 browser flow | PKCE flow, token in config |
| `"oauth_to_api_key"` | OAuth + key exchange | Browser flow, exchange for long-lived key |

For `api_key`:
```json
{
  "auth": {
    "type": "api_key",
    "keyPrompt": "Enter your API key",
    "keyEnvVar": "MY_KEY",
    "keyHelpUrl": "https://example.com/keys",
    "validationUrl": "https://example.com/api/me"
  }
}
```

For `oauth_to_api_key` (like Prior):
```json
{
  "auth": {
    "type": "oauth_to_api_key",
    "oauth": {
      "authorizeUrl": "https://example.com/authorize",
      "tokenUrl": "https://example.com/token",
      "clientId": "my-cli"
    },
    "keyExchange": {
      "url": "https://example.com/api/cli-key",
      "method": "POST",
      "tokenHeader": "Authorization",
      "keyPath": "data.apiKey"
    }
  }
}
```

Equip handles the full OAuth PKCE flow, key exchange, credential storage (`~/.equip/credentials/`), and automatic token refresh.

## Local Development

During development, use `equip ./script.js` to test your augment locally:

```bash
equip ./piratehat.js              # Run a local script
equip .                           # Run current directory's package bin
equip piratehat --dry-run         # Preview without writing (registry augment)
equip piratehat --verbose         # Show detailed logging
equip piratehat --platform claude # Target specific platform
```

Equip provides the same state tracking and management for locally-developed augments as for registry augments:

```bash
equip status                      # See what's installed
equip doctor                      # Validate config integrity
equip uninstall piratehat         # Clean removal
```

## AugmentConfig Reference

```typescript
interface AugmentConfig {
  name: string;                    // Augment name (used in MCP configs and state)
  serverUrl?: string;              // MCP server endpoint (required for installMcp)
  rules?: {
    content: string;               // Markdown with marker tags
    version: string;               // Semantic version
    marker: string;                // Marker name for <!-- marker:vX.X.X --> tags
    fileName?: string;             // Custom filename for directory platforms
  };
  stdio?: {
    command: string;               // Command to run (e.g., "node")
    args: string[];                // Arguments (e.g., ["server.js"])
    envKey: string;                // Environment variable for API key
  };
  hooks?: HookDefinition[];        // Lifecycle hooks (Claude Code only)
  hookDir?: string;                // Hook script directory (default: ~/.{name}/hooks)
  skills?: SkillConfig[];          // Skills — SKILL.md files for agent discovery
  logger?: EquipLogger;            // Optional structured logging
}
```

## Instance Methods

All install methods return `ArtifactResult`:

```typescript
interface ArtifactResult {
  artifact: "mcp" | "rules" | "skills" | "hooks";
  attempted: boolean;
  success: boolean;
  action: "created" | "updated" | "skipped" | "failed";
  errorCode?: string;              // Structured code for telemetry
  error?: string;                  // Human-readable message
  warnings: EquipWarning[];
  method?: string;                 // "json" | "toml" for mcp
}
```

| Method | What it does |
|--------|-------------|
| `detect()` | Returns detected platforms |
| `buildConfig(platformId, apiKey, transport?)` | Build config entry without writing |
| `installMcp(platform, apiKey, options?)` | Write MCP config to platform |
| `installRules(platform, options?)` | Write behavioral rules |
| `installSkill(platform, options?)` | Write skill files |
| `installHooks(platform, options?)` | Install lifecycle hooks (Claude Code) |
| `uninstallMcp(platform, dryRun?)` | Remove MCP config entry |
| `uninstallRules(platform, dryRun?)` | Remove rules marker block |
| `uninstallSkill(platform, dryRun?)` | Remove skill directory |
| `uninstallHooks(platform, options?)` | Remove hooks and deregister |
| `readMcp(platform)` | Read existing MCP config entry |
| `readMcpDetailed(platform)` | Read MCP entry with metadata |
| `updateMcpKey(platform, apiKey, transport?)` | Update API key in existing config |
| `hasHooks(platform, options?)` | Check if hooks are installed |
| `hasSkill(platform)` | Check if all skills are installed |
| `installedSkills(platform)` | List names of installed skills |
| `supportsHooks(platform)` | Check if platform supports hooks |
| `verify(platform)` | Check all artifacts are correctly installed |
