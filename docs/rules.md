# Behavioral Rules

Behavioral rules are markdown instructions injected into platform-specific rules files. They tell AI agents when and how to use your augment. Without rules, agents may have your augment available but never use it — or use it incorrectly.

**Note:** Rules are installed only on platforms with writable rules paths. Platforms like Cursor and VS Code that lack global rules files are skipped (rules installation returns `{ action: "skipped" }`).

## Why Rules Matter

An MCP server entry makes an augment _available_. Rules make the agent _use_ it. In practice:

- Agents don't reliably discover new tools on their own
- Even when they discover an augment, they may not know the right context to use it
- Rules ensure consistent behavior across sessions and platforms
- Rules are the single most effective way to improve augment adoption

Example: an MCP tool called `acme-docs` that provides API documentation. Without rules, the agent might never call it. With rules:

```markdown
When working with Acme APIs or libraries:
1. Use the acme-docs tool to look up current API signatures before guessing
2. Check for deprecation notices -- Acme ships breaking changes quarterly
3. Prefer the code examples from acme-docs over generic web search results
```

## The Marker System

Equip uses HTML comment markers to manage versioned blocks within shared rules files. This allows multiple augments to coexist in the same file without interfering with each other.

### Format

```markdown
<!-- my-tool:v1.0.0 -->
## My Tool -- Agent Instructions

Your rules content here.

<!-- /my-tool -->
```

The opening marker contains the augment name and version: `<!-- {marker}:v{version} -->`. The closing marker is `<!-- /{marker} -->`. Everything between them is your rules content.

### How Markers Work

1. **First install** -- the entire block (including markers) is appended to the rules file
2. **Version bump** -- equip finds the existing block by its markers and replaces it in-place
3. **Same version** -- equip skips the write (idempotent)
4. **Uninstall** -- equip removes the block, preserving all other content

The marker name is typically your augment name. It must be unique within the file.

### Version Tracking

Equip compares the version in the marker against your configured version. It's a simple string comparison -- equip doesn't parse semver. Bump the version string whenever your rules content changes to trigger an update on the next run.

Internally, `parseRulesVersion(content, marker)` extracts the installed version from a rules file. This is used by `augment.verify()` to check installed rules versions.

## Append vs Standalone File

Platforms handle rules in two ways:

### Single-file platforms (append mode)

Claude Code (`CLAUDE.md`), Windsurf (`global_rules.md`), Codex (`AGENTS.md`), and Gemini CLI (`GEMINI.md`) use a single rules file. Equip appends your marker block to the existing file content, preserving anything else in the file.

### Directory-based platforms (standalone file)

Cline (`~/Documents/Cline/Rules/`) and Roo Code (`~/.roo/rules/`) use a rules directory where each file is loaded independently. Equip writes a standalone file using the `fileName` option:

```typescript
const equip = new Augment({
  name: "my-tool",
  serverUrl: "https://...",
  rules: {
    content: rulesContent,
    version: "1.0.0",
    marker: "my-tool",
    fileName: "my-tool.md",  // Written to the rules directory
  },
});
```

When `fileName` is set and the platform's `rulesPath` is a directory, equip writes `{rulesPath}/{fileName}`. When `rulesPath` is a regular file (single-file platforms), `fileName` is ignored and equip appends to the file.

This auto-detection means you can set `fileName` for all platforms and equip does the right thing.

## Platforms Without Rules Support

Cursor and VS Code don't have a writable global rules file. On these platforms, `installRules` returns `{ action: "skipped" }`. These are MCP-only platforms -- use skills for knowledge delivery on these platforms.

## API Reference

### `equip.installRules(platform, options?)`

Install behavioral rules to a platform.

```typescript
const result = equip.installRules(platform, { dryRun: false });
```

**Returns:** `ArtifactResult` where `action` is one of:
- `"created"` -- rules block was appended (first install)
- `"updated"` -- existing block was replaced (version bump)
- `"skipped"` -- already at this version, or platform has no rules path

### `equip.uninstallRules(platform, dryRun?)`

Remove the rules marker block from a platform's rules file.

```typescript
const removed = equip.uninstallRules(platform);
// true if the block was found and removed, false otherwise
```

If removing the block leaves the file empty, the file is deleted. If other content remains, equip preserves it and cleans up any excess blank lines.

### Version Checking

Use `augment.verify(platform)` to check the installed rules version. The verify method returns a structured result with per-artifact status, including whether the rules version matches what's expected.

## Writing Effective Rules Content

### Structure

```markdown
<!-- my-tool:v1.0.0 -->
## My Tool -- Agent Instructions

[When to use the augment -- be specific about triggers]
[How to use it -- concrete steps]
[What NOT to do -- common mistakes]

<!-- /my-tool -->
```

### Guidelines

1. **Be specific about triggers.** "Use my-tool when you encounter an error" is better than "my-tool is available for use."

2. **Use numbered steps.** Agents follow sequential instructions more reliably than prose.

3. **Include negative instructions.** "Do NOT guess API signatures -- look them up with my-tool first" is more effective than only positive instructions.

4. **Keep it short.** Rules are loaded into the agent's context every session. Long rules waste tokens and may be skimmed. Aim for 5-15 lines.

5. **Version your rules.** Bump the version whenever you change the content. This ensures all users get the update on their next run.

6. **Combine with skills.** Rules tell the agent _when_ to use the augment. Skills tell it _how_. Together they cover the full loop. See [skills.md](./skills.md) for details.
