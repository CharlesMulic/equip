# Agent Skills

Skills are structured knowledge files that AI agents auto-discover and load on demand. They follow the [Agent Skills specification](https://agentskills.io/specification) and use the SKILL.md format. Equip installs skill files to each platform's native skills directory.

## What Skills Are

A skill is a directory containing a `SKILL.md` file with YAML frontmatter and markdown instructions:

```
my-skill/
  SKILL.md          # Required: YAML frontmatter + Markdown body
  scripts/          # Optional: Executable helpers
  references/       # Optional: Additional documentation
  assets/           # Optional: Templates, data files
```

The SKILL.md format:

```yaml
---
name: my-skill
description: What the skill does and when to use it.
license: MIT
allowed-tools: Bash(git:*) Read
metadata:
  author: my-org
  version: "1.0"
---

# My Skill Instructions

Detailed instructions the agent follows when the skill is active.
```

The `name` and `description` fields are required. Everything else is optional.

## How Equip Installs Skills

Equip copies skill files to each platform's skills directory using a scoped layout:

```
{skillsPath}/{toolName}/{skillName}/SKILL.md
```

For example, a tool named `prior` with a skill named `search` installed on Claude Code:

```
~/.claude/skills/prior/search/SKILL.md
```

The `toolName` scope prevents naming collisions between different tools that might use the same skill name.

### Installation is idempotent. If the SKILL.md file already exists with identical content, equip skips the write and returns `{ action: "skipped" }`.

### Uninstallation removes the skill directory and cleans up the parent tool directory if it's empty afterward.

## Platform Skills Paths

| Platform | Skills Path |
|---|---|
| Claude Code | `~/.claude/skills/` |
| Cursor | `~/.cursor/skills/` |
| Windsurf | `~/.agents/skills/` |
| VS Code | `~/.agents/skills/` |
| Cline | `~/.cline/skills/` |
| Roo Code | `~/.roo/skills/` |
| Codex | `~/.agents/skills/` |
| Gemini CLI | `~/.gemini/skills/` |

Platforms without a confirmed skills path (Junie, Copilot JetBrains, Copilot CLI) have `skillsPath: null` and skill installation is silently skipped.

The `~/.agents/skills/` path is a cross-platform convention -- all 8 skill-supporting platforms scan this directory. Equip uses each platform's native path when one exists, falling back to `~/.agents/skills/` for platforms like Windsurf, VS Code, and Codex that don't have a tool-specific global skills directory.

## How Skills Get Loaded by Agents

All 8 platforms use the same progressive disclosure pattern:

1. **Startup** -- the agent scans skill directories and loads only `name` + `description` from YAML frontmatter (~100 tokens per skill)
2. **Matching** -- when a task arrives, the agent compares it against skill descriptions
3. **Loading** -- if the description matches, the full SKILL.md content is loaded into context
4. **Resources** -- references and scripts are loaded on-demand when the instructions reference them

This means the `description` field is the sole trigger for automatic skill invocation. The agent never reads the full SKILL.md unless the description matched first.

## The Reliability Gap

Not all platforms handle automatic skill invocation equally:

| Platform | Auto-Invocation | Reliability |
|---|---|---|
| Claude Code | Automatic | Reliable |
| Cursor | Requires `@skill-name` | Unreliable without explicit invocation |
| VS Code / Copilot | Automatic | Reliable |
| Windsurf | Requires `@skill-name` | Unreliable without explicit invocation |
| Cline | Automatic | Reliable |
| Roo Code | Automatic (3-level progressive) | Reliable |
| Codex | Automatic | Reliable |
| Gemini CLI | Automatic (with confirmation) | Reliable |

**Cursor and Windsurf have unreliable automatic skill invocation.** Both platforms recommend explicit `@skill-name` syntax for guaranteed loading. A skill file alone is not sufficient on these platforms.

## Why Skills + Rules Together

Skills and rules serve different purposes and are most effective together:

- **Skills** make knowledge _available_ for discovery
- **Rules** tell the agent _when_ to use the tool (critical for Cursor/Windsurf)
- **Hooks** structurally remind the agent at key lifecycle moments (Claude Code only)

For Cursor and Windsurf, behavioral rules that reference the skill by name bridge the reliability gap:

```markdown
<!-- my-tool:v1.0.0 -->
## My Tool

When you encounter errors, use @my-tool-skill to search for known solutions.
<!-- /my-tool -->
```

Tool authors should install BOTH a skill AND behavioral rules that reference it. The rules act as a reliability bridge on platforms where automatic skill invocation is weak. See [rules.md](./rules.md) for details on behavioral rules.

## Writing Effective SKILL.md Content

### Description Quality

The description is the most important field. It determines whether the skill gets loaded. It must:

- Clearly state WHEN the skill should be used (not just what it does)
- Use action-oriented language matching how agents process tasks
- Be specific enough to trigger on the right tasks, broad enough not to miss

Bad:
```yaml
description: Prior knowledge base integration
```

Good:
```yaml
description: Search Prior for solutions other agents already found. Use when you hit an error, stack trace, or unexpected behavior.
```

### Frontmatter

Required fields:
- `name` -- 1-64 characters, lowercase with hyphens
- `description` -- 1-1024 characters, the trigger for auto-discovery

Optional but recommended:
- `metadata.author` -- your tool or organization name
- `metadata.version` -- version string for tracking updates
- `license` -- SPDX identifier
- `allowed-tools` -- pre-approved tool patterns (e.g., `Bash(git:*) Read`)

### Body

The markdown body contains the full instructions the agent follows when the skill is active. Write it as if you're briefing a colleague:

1. What the skill does
2. When to use it (repeated from description, with more detail)
3. Step-by-step instructions
4. Common pitfalls or edge cases

## Multi-File Skills

Skills can include supporting files beyond SKILL.md:

```typescript
const equip = new Equip({
  name: "my-tool",
  serverUrl: "https://...",
  skill: {
    name: "docs-lookup",
    files: [
      { path: "SKILL.md", content: skillMdContent },
      { path: "scripts/validate.sh", content: validateScript },
      { path: "references/api-guide.md", content: apiGuide },
      { path: "assets/template.json", content: templateJson },
    ],
  },
});
```

All files are installed relative to the skill directory:

```
~/.claude/skills/my-tool/docs-lookup/
  SKILL.md
  scripts/validate.sh
  references/api-guide.md
  assets/template.json
```

Subdirectories are created automatically. The SKILL.md body can reference these files with relative paths, and agents will load them on demand.

## API Reference

### `equip.installSkill(platform, options?)`

Install skill files to a platform's skills directory.

```typescript
const result = equip.installSkill(platform, { dryRun: false });
```

**Returns:** `{ action: string }` where `action` is one of:
- `"created"` -- skill files were written
- `"skipped"` -- SKILL.md already exists with identical content, or platform has no skillsPath

### `equip.uninstallSkill(platform, dryRun?)`

Remove the skill directory from a platform.

```typescript
const removed = equip.uninstallSkill(platform);
// true if the directory was found and removed, false otherwise
```

Removes the entire skill directory (e.g., `~/.claude/skills/my-tool/docs-lookup/`). If the parent tool directory is empty afterward, it is also removed.

### `equip.hasSkill(platform)`

Check if the skill is installed on a platform.

```typescript
const installed = equip.hasSkill(platform);
// true if {skillsPath}/{toolName}/{skillName}/SKILL.md exists
```
