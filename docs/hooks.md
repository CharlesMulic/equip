# Lifecycle Hooks

Hooks are scripts that run at specific lifecycle events in an AI coding platform. They provide structural enforcement -- rather than relying on the agent to remember instructions, hooks inject reminders and checks at precisely the right moments.

Currently, **Claude Code is the only platform that supports hooks**. The Augment class supports hooks via the library API, but **hooks are not installed by direct-mode** (`equip <augment>`). They are available for augments using the library directly (local setup scripts). This will be revisited as more platforms add hook support.

## What Hooks Are

A hook is a JavaScript file that runs when a specific event occurs during an agent session. For example:

- After the agent uses a tool (`PostToolUse`)
- When a session starts (`SessionStart`)
- Before the agent compacts its context (`PreCompact`)
- When a task completes (`TaskCompleted`)

Hook scripts receive event context via stdin as JSON and can output text that the agent sees.

## Supported Events

Claude Code supports 12 lifecycle events:

| Event | When It Fires |
|---|---|
| `PreToolUse` | Before a tool call executes |
| `PostToolUse` | After a tool call completes successfully |
| `PostToolUseFailure` | After a tool call fails |
| `Stop` | When the agent stops generating |
| `SessionStart` | When a new session begins |
| `SessionEnd` | When a session ends |
| `UserPromptSubmit` | When the user submits a prompt |
| `Notification` | When a notification is sent |
| `SubagentStart` | When a sub-agent is spawned |
| `SubagentStop` | When a sub-agent finishes |
| `PreCompact` | Before context compaction |
| `TaskCompleted` | When a task completes |

## How Hooks Are Installed

Equip installs hooks in two steps:

### 1. Script Files

Hook scripts are written to a configurable directory (default: `~/.{toolName}/hooks/`):

```
~/.my-tool/hooks/
  check-api-version.js
  remind-search.js
```

Each file is a self-contained Node.js script. Equip writes the `script` field from your `HookDefinition` to `{hookDir}/{name}.js`.

### 2. Settings Registration

Equip registers the hooks in Claude Code's `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/home/user/.my-tool/hooks/check-api-version.js\""
          }
        ]
      }
    ]
  }
}
```

The registration is additive -- equip merges into existing hook settings without removing hooks from other augments. When the same augment's hooks already exist (identified by the `hookDir` path), they are replaced.

## Hook Definition Format

```typescript
interface HookDefinition {
  /** Claude Code lifecycle event name */
  event: string;
  /** Optional regex pattern to match tool names (for tool-related events) */
  matcher?: string;
  /** JavaScript source code for the hook script */
  script: string;
  /** Filename (without .js extension) */
  name: string;
}
```

Example:

```typescript
const hooks: HookDefinition[] = [
  {
    event: "PostToolUse",
    matcher: "Write|Edit",
    name: "check-api-version",
    script: `
      // Runs after Write or Edit tool calls.
      // Hook scripts receive context via stdin (JSON).
      const input = require("fs").readFileSync("/dev/stdin", "utf-8");
      const { tool_input } = JSON.parse(input);
      if (tool_input?.file_path?.endsWith(".ts")) {
        console.log("Reminder: verify API versions with my-tool after code changes.");
      }
    `,
  },
  {
    event: "SessionStart",
    name: "session-greeting",
    script: `
      console.log("my-tool is available. Use it to look up API docs.");
    `,
  },
];
```

## API Reference

### `equip.installHooks(platform, options?)`

Install hook scripts and register them in platform settings.

```typescript
const equip = new Augment({
  name: "my-tool",
  serverUrl: "https://...",
  hooks: hookDefs,
  hookDir: "/home/user/.my-tool/hooks",  // Optional, defaults to ~/.{name}/hooks
});

const result = equip.installHooks(platform, { dryRun: false });
```

**Returns:** `{ installed: boolean, scripts: string[], hookDir: string } | null`

- `installed` -- true if hooks were written
- `scripts` -- list of installed script filenames (e.g., `["check-api-version.js"]`)
- `hookDir` -- directory where scripts were written
- Returns `null` if the platform doesn't support hooks or no valid hooks were defined

**Options:**
- `hookDir` -- override the default hook directory
- `dryRun` -- true to skip file writes

### `equip.uninstallHooks(platform, options?)`

Remove hook scripts and deregister them from platform settings.

```typescript
const removed = equip.uninstallHooks(platform);
// true if any hooks were removed, false otherwise
```

Removes the script files, attempts to clean up the hook directory, and removes the matching entries from `settings.json`. Other augments' hooks are preserved.

### `equip.hasHooks(platform, options?)`

Check if hooks are fully installed on a platform.

```typescript
const installed = equip.hasHooks(platform);
// true if all script files exist AND hooks are registered in settings.json
```

Both conditions must be true -- script files on disk AND entries in the settings file.

### `equip.supportsHooks(platform)`

Check if a platform supports hooks at all.

```typescript
const supported = equip.supportsHooks(platform);
// true for claude-code, false for all others (currently)
```

## The Three-Layer Enforcement Model

Hooks are one layer of a three-part approach to ensuring agents use your augment:

| Layer | What It Does | Coverage |
|---|---|---|
| **Rules** | Tell the agent when and how to use the augment | All platforms with rules support |
| **Skills** | Provide structured knowledge for on-demand loading | All platforms with skills support |
| **Hooks** | Structurally remind the agent at lifecycle moments | Claude Code only |

Each layer reinforces the others:

1. **Rules** are loaded at session start and provide persistent instructions
2. **Skills** are loaded on-demand when the agent encounters a matching task
3. **Hooks** fire at specific moments (after edits, on errors, etc.) to remind the agent about the augment

For platforms that support all three (currently Claude Code), the combination provides the strongest guarantee that the agent will use your augment at the right times. For other platforms, rules + skills cover most cases. See [rules.md](./rules.md) and [skills.md](./skills.md) for details on those layers.
