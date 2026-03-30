# Building a Setup Script with Equip

This guide walks through building a setup script that installs your MCP tool across all supported AI coding platforms. The audience is tool authors who want their MCP server to work everywhere -- Claude Code, Cursor, Windsurf, VS Code, Cline, Roo Code, Codex, Gemini CLI, and more.

## The Four Layers

Equip provides four layers of tool integration, each building on the previous:

| Layer | What It Does | Why It Matters |
|---|---|---|
| **MCP Config** | Makes the tool available to the agent | Agent can call your tool |
| **Rules** | Tells the agent when to use the tool | Agent actually uses your tool (not just has it) |
| **Skills** | Teaches the agent how to use the tool | Agent uses your tool effectively |
| **Hooks** | Reminds the agent at key moments | Structural enforcement (Claude Code only) |

MCP config is required. The other three are optional but strongly recommended -- each layer significantly improves tool adoption. See [rules.md](./rules.md), [skills.md](./skills.md), and [hooks.md](./hooks.md) for deep dives on each.

## Step-by-Step: Create a Setup Script

### 1. Define Your Configuration

```javascript
const { Equip, createManualPlatform, platformName, cli } = require("@cg3/equip");

const TOOL_NAME = "my-tool";
const SERVER_URL = "https://api.example.com/mcp";
const RULES_VERSION = "1.0.0";

const equip = new Equip({
  name: TOOL_NAME,
  serverUrl: SERVER_URL,

  // Rules (optional but recommended)
  rules: {
    content: `<!-- ${TOOL_NAME}:v${RULES_VERSION} -->
## My Tool -- Agent Instructions

When working with Widget APIs:
1. Use the my-tool MCP tool to look up current API docs
2. Check for deprecation notices before using Widget v3 APIs
3. Prefer my-tool results over web search for Widget-specific questions

<!-- /${TOOL_NAME} -->`,
    version: RULES_VERSION,
    marker: TOOL_NAME,
    fileName: `${TOOL_NAME}.md`,  // For directory-based platforms (Cline, Roo Code)
  },

  // Skills (optional but recommended)
  skill: {
    name: "lookup",
    files: [
      {
        path: "SKILL.md",
        content: `---
name: lookup
description: Look up Widget API documentation. Use when writing code that calls Widget APIs or when you encounter Widget-related errors.
metadata:
  author: my-tool
  version: "${RULES_VERSION}"
---

# Widget API Lookup

Use this skill when working with Widget APIs.

## When to Use
- Before writing code that calls a Widget API
- When you see a deprecation warning from Widget
- When the user asks about Widget API signatures

## How to Use
1. Call the my-tool MCP tool with the function or class name
2. The tool returns versioned docs matching the project's dependency
3. Use the returned signatures, not training data
`,
      },
    ],
  },

  // Hooks (optional, Claude Code only)
  hooks: [
    {
      event: "PostToolUse",
      matcher: "Write|Edit",
      name: "check-api-version",
      script: `
const input = require("fs").readFileSync("/dev/stdin", "utf-8");
const { tool_input } = JSON.parse(input);
if (tool_input?.file_path?.match(/\\.(ts|js|py)$/)) {
  console.log("Reminder: verify Widget API versions with my-tool after code changes.");
}
      `,
    },
  ],

  // Stdio transport (alternative to HTTP, uncomment to use)
  // stdio: {
  //   command: "npx",
  //   args: ["-y", "@example/my-mcp@latest"],
  //   envKey: "MY_TOOL_API_KEY",
  // },
});
```

### 2. Detect Platforms

```javascript
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const platformOverride = args.includes("--platform")
  ? args[args.indexOf("--platform") + 1]
  : null;

let platforms;
if (platformOverride) {
  platforms = [createManualPlatform(platformOverride)];
  cli.info(`Forced platform: ${platformName(platformOverride)}`);
} else {
  platforms = equip.detect();
  if (platforms.length === 0) {
    cli.fail("No AI coding tools detected.");
    cli.log("  Install Claude Code, Cursor, VS Code, or another supported platform.");
    cli.log("  Or use --platform <id> to specify manually.");
    process.exit(1);
  }
}

for (const p of platforms) {
  cli.ok(`Detected: ${platformName(p.platform)}`);
}
```

### 3. Get the API Key

Equip does not handle authentication. Your setup script must collect the API key from the user:

```javascript
// Option A: Interactive prompt
const apiKey = await cli.prompt("  Enter your API key: ");
if (!apiKey) {
  cli.fail("API key required");
  process.exit(1);
}

// Option B: Environment variable
const apiKey = process.env.MY_TOOL_API_KEY;
if (!apiKey) {
  cli.fail("Set MY_TOOL_API_KEY environment variable");
  process.exit(1);
}

// Option C: Generate via your API
const apiKey = await myApi.createKey({ source: "equip-setup" });
```

### 4. Install MCP Config

```javascript
for (const p of platforms) {
  const result = equip.installMcp(p, apiKey, { dryRun });
  if (result.success) {
    cli.ok(`${platformName(p.platform)}: MCP config installed (${result.method})`);
  }
}
```

### 5. Install Rules

```javascript
for (const p of platforms) {
  const result = equip.installRules(p, { dryRun });
  switch (result.action) {
    case "created":  cli.ok(`${platformName(p.platform)}: rules installed`); break;
    case "updated":  cli.ok(`${platformName(p.platform)}: rules updated`); break;
    case "skipped":  cli.info(`${platformName(p.platform)}: rules already current`); break;
    case "clipboard": cli.info(`${platformName(p.platform)}: rules copied to clipboard`); break;
  }
}
```

### 6. Install Skills

```javascript
for (const p of platforms) {
  const result = equip.installSkill(p, { dryRun });
  if (result.action === "created") {
    cli.ok(`${platformName(p.platform)}: skill installed`);
  } else {
    cli.info(`${platformName(p.platform)}: skill ${result.action}`);
  }
}
```

### 7. Install Hooks (Optional)

```javascript
for (const p of platforms) {
  if (!equip.supportsHooks(p)) continue;
  const result = equip.installHooks(p, { dryRun });
  if (result?.installed) {
    cli.ok(`${platformName(p.platform)}: ${result.scripts.length} hooks installed`);
  }
}
```

## Full EquipConfig Reference

```typescript
interface EquipConfig {
  /** Tool name -- used as the MCP server name in config files */
  name: string;

  /** MCP server URL (required unless stdio is provided) */
  serverUrl?: string;

  /** Stdio transport config (alternative to serverUrl) */
  stdio?: {
    /** Command to run (e.g., "npx") */
    command: string;
    /** Command arguments (e.g., ["-y", "@example/my-mcp@latest"]) */
    args: string[];
    /** Environment variable name for the API key */
    envKey: string;
  };

  /** Behavioral rules (optional) */
  rules?: {
    /** Full rules content including marker comments */
    content: string;
    /** Version string (bump to trigger updates) */
    version: string;
    /** Marker name for the HTML comment block */
    marker: string;
    /** Filename for directory-based platforms (e.g., "my-tool.md") */
    fileName?: string;
    /** Platforms that get clipboard instead of file write (default: ["cursor", "vscode"]) */
    clipboardPlatforms?: string[];
  };

  /** Lifecycle hooks (optional, Claude Code only) */
  hooks?: HookDefinition[];

  /** Hook script directory (default: ~/.{name}/hooks) */
  hookDir?: string;

  /** Agent skill (optional) */
  skill?: {
    /** Skill directory name */
    name: string;
    /** Files to install (must include SKILL.md) */
    files: Array<{
      /** Relative path within skill directory */
      path: string;
      /** File content */
      content: string;
    }>;
  };
}
```

## The `verify()` Method

After installation, use `verify()` to confirm everything was installed correctly:

```javascript
for (const p of platforms) {
  const result = equip.verify(p);
  if (result.ok) {
    cli.ok(`${platformName(p.platform)}: all checks passed`);
  } else {
    for (const check of result.checks) {
      if (!check.ok) cli.fail(`${platformName(p.platform)}: ${check.detail}`);
    }
  }
}
```

`verify()` returns:

```typescript
interface VerifyResult {
  platform: string;
  ok: boolean;           // true if ALL checks passed
  checks: VerifyCheck[];
}

interface VerifyCheck {
  name: string;          // "mcp", "rules", "hooks", "skills"
  ok: boolean;
  detail: string;        // Human-readable description
}
```

Checks performed:
- **mcp** -- the MCP config entry exists in the platform's config file
- **rules** -- the marker block exists with the expected version (only if rules configured and platform has a rules path)
- **hooks** -- hook scripts exist on disk and are registered in settings (only if hooks configured and platform supports hooks)
- **skills** -- the SKILL.md file exists in the expected location (only if skill configured and platform has a skills path)

## Handling Auth

Equip does not perform authentication. It writes whatever API key you give it into the platform's config file. Your setup script is responsible for:

1. Obtaining the API key (prompt, env var, API call, OAuth flow, etc.)
2. Validating the key works (optional but recommended)
3. Passing it to `equip.installMcp()`

Equip stores the key in the platform's config file in the standard location (`headers.Authorization` or `env.{envKey}`). It does not store keys in its own state file.

For key rotation, use `equip.updateMcpKey()`:

```javascript
const result = equip.updateMcpKey(platform, newApiKey);
```

## Registering in `registry.json`

To make your tool installable via `equip my-tool`, add an entry to `registry.json`:

```json
{
  "my-tool": {
    "package": "@example/my-tool",
    "command": "setup",
    "description": "My Tool -- Widget API documentation for agents",
    "marker": "my-tool",
    "hookDir": "~/.my-tool/hooks",
    "skillName": "lookup"
  }
}
```

Your npm package must export the `setup` command in its `bin` field:

```json
{
  "name": "@example/my-tool",
  "bin": {
    "setup": "bin/setup.js"
  }
}
```

Submit a PR to [github.com/CharlesMulic/equip](https://github.com/CharlesMulic/equip) with your registry entry.

## The Demo as a Reference Implementation

The built-in demo (`demo/setup.js`) is a complete, working reference implementation. It demonstrates:

1. Platform detection with `--platform` override
2. MCP config installation (HTTP transport)
3. Behavioral rules with marker-based versioning
4. Skills installation
5. Uninstallation flow
6. CLI output with colors, steps, and status indicators
7. Dry-run mode (default for the demo)

Run it:

```bash
npx @cg3/equip demo               # Dry run
npx @cg3/equip demo --live        # Actually write files
npx @cg3/equip demo --uninstall   # Clean up
```

Read it: the demo source is inline-documented and designed to be copied as a starting point.

## Common Patterns

### Dry-Run Support

Always support `--dry-run`. Pass it through to all equip methods:

```javascript
const dryRun = args.includes("--dry-run");

equip.installMcp(platform, apiKey, { dryRun });
equip.installRules(platform, { dryRun });
equip.installSkill(platform, { dryRun });
equip.installHooks(platform, { dryRun });
```

In dry-run mode, equip skips all file writes but returns the same result shape as a live run.

### `--platform` Override

Let users target a specific platform:

```javascript
const platformOverride = args.includes("--platform")
  ? args[args.indexOf("--platform") + 1]
  : null;

if (platformOverride) {
  const p = createManualPlatform(platformOverride);
  platforms = [p];
} else {
  platforms = equip.detect();
}
```

`createManualPlatform()` resolves aliases (`resolvePlatformId` is called internally by `getPlatform`), so `--platform claude` and `--platform claude-code` both work.

### Uninstall Flow

Support `--uninstall` for clean removal:

```javascript
if (args.includes("--uninstall")) {
  for (const p of platforms) {
    equip.uninstallMcp(p);
    equip.uninstallRules(p);
    equip.uninstallSkill(p);
    equip.uninstallHooks(p);
  }
}
```

Each method is safe to call even if the corresponding artifact wasn't installed -- it returns `false` and does nothing.

### CLI Output Helpers

Equip exports CLI helpers for consistent output:

```javascript
const { cli } = require("@cg3/equip");

cli.log("Plain message");
cli.ok("Success message");       // green checkmark
cli.fail("Error message");       // red X
cli.warn("Warning message");     // yellow warning
cli.info("Info message");        // cyan info
cli.step(1, 5, "Detecting");    // [1/5] Detecting

const answer = await cli.prompt("Enter value: ");
const confirmed = await cli.promptEnterOrEsc("Press Enter to continue, Esc to cancel: ");
```

All output goes to stderr, keeping stdout clean for programmatic use.

### Error Handling

Wrap your setup script in an error handler:

```javascript
async function main() {
  // ... your setup logic ...
}

main().catch((err) => {
  cli.fail(cli.sanitizeError(err.message));  // Replaces home dir with ~
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
```

## Testing Your Setup Script

### Manual Testing

```bash
# Dry run first
node bin/setup.js --dry-run

# Target a specific platform
node bin/setup.js --dry-run --platform codex

# Live install
node bin/setup.js

# Verify
node -e "
  const { Equip, createManualPlatform } = require('@cg3/equip');
  const equip = new Equip({ name: 'my-tool', serverUrl: 'https://...' });
  const result = equip.verify(createManualPlatform('claude-code'));
  console.log(JSON.stringify(result, null, 2));
"

# Uninstall
node bin/setup.js --uninstall
```

### Automated Testing

Use equip's `verify()` method in your test suite:

```javascript
const { Equip, createManualPlatform } = require("@cg3/equip");

// After running your setup script
const equip = new Equip({ name: "my-tool", serverUrl: "https://..." });
const result = equip.verify(createManualPlatform("claude-code"));

assert(result.ok, `Verification failed: ${result.checks.filter(c => !c.ok).map(c => c.detail).join(", ")}`);
```

### Test Across Platforms

Your setup script should work on platforms you don't personally use. Test with `--platform` to exercise each code path:

```bash
for platform in claude-code cursor windsurf vscode cline roo-code codex gemini-cli; do
  node bin/setup.js --dry-run --platform $platform
done
```

Dry-run mode exercises all the config-building logic without requiring the platforms to be installed.
