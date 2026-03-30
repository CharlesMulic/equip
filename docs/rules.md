# Behavioral Rules

Behavioral rules are markdown instructions injected into platform-specific rules files. They tell AI agents when and how to use your MCP tool. Without rules, agents may have your tool available but never use it -- or use it incorrectly.

## Why Rules Matter

An MCP server entry makes a tool _available_. Rules make the agent _use_ it. In practice:

- Agents don't reliably discover new tools on their own
- Even when they discover a tool, they may not know the right context to use it
- Rules ensure consistent behavior across sessions and platforms
- Rules are the single most effective way to improve tool adoption

Example: an MCP tool called `acme-docs` that provides API documentation. Without rules, the agent might never call it. With rules:

```markdown
When working with Acme APIs or libraries:
1. Use the acme-docs tool to look up current API signatures before guessing
2. Check for deprecation notices -- Acme ships breaking changes quarterly
3. Prefer the code examples from acme-docs over generic web search results
```

## The Marker System

Equip uses HTML comment markers to manage versioned blocks within shared rules files. This allows multiple tools to coexist in the same file without interfering with each other.

### Format

```markdown
<!-- my-tool:v1.0.0 -->
## My Tool -- Agent Instructions

Your rules content here.

<!-- /my-tool -->
```

The opening marker contains the tool name and version: `<!-- {marker}:v{version} -->`. The closing marker is `<!-- /{marker} -->`. Everything between them is your rules content.

### How Markers Work

1. **First install** -- the entire block (including markers) is appended to the rules file
2. **Version bump** -- equip finds the existing block by its markers and replaces it in-place
3. **Same version** -- equip skips the write (idempotent)
4. **Uninstall** -- equip removes the block, preserving all other content

The marker name is typically your tool name. It must be unique within the file.

### Version Tracking

Equip compares the version in the marker against your configured version:

```typescript
import { parseRulesVersion } from "@cg3/equip";

const content = fs.readFileSync(rulesPath, "utf-8");
const installed = parseRulesVersion(content, "my-tool");
// "1.0.0" or null if not found
```

The version is a simple string comparison -- equip doesn't parse semver. Bump the version string whenever your rules content changes to trigger an update on the next run.

## Append vs Standalone File

Platforms handle rules in two ways:

### Single-file platforms (append mode)

Claude Code (`CLAUDE.md`), Windsurf (`global_rules.md`), Codex (`AGENTS.md`), and Gemini CLI (`GEMINI.md`) use a single rules file. Equip appends your marker block to the existing file content, preserving anything else in the file.

### Directory-based platforms (standalone file)

Cline (`~/Documents/Cline/Rules/`) and Roo Code (`~/.roo/rules/`) use a rules directory where each file is loaded independently. Equip writes a standalone file using the `fileName` option:

```typescript
const equip = new Equip({
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

## Clipboard Fallback

Cursor and VS Code don't have a writable global rules file that equip can target. For these platforms, equip copies the rules content to the system clipboard and returns `{ action: "clipboard" }`.

```typescript
const result = equip.installRules(platform, { dryRun });
if (result.action === "clipboard") {
  console.log("Rules copied to clipboard -- paste into your settings");
}
```

You can control which platforms get the clipboard treatment:

```typescript
rules: {
  content: "...",
  version: "1.0.0",
  marker: "my-tool",
  clipboardPlatforms: ["cursor", "vscode"],  // default
}
```

The clipboard implementation uses `pbcopy` on macOS, `clip` on Windows, and `xclip`/`xsel`/`wl-copy` on Linux.

## API Reference

### `equip.installRules(platform, options?)`

Install behavioral rules to a platform.

```typescript
const result = equip.installRules(platform, { dryRun: false });
```

**Returns:** `{ action: string }` where `action` is one of:
- `"created"` -- rules block was appended (first install)
- `"updated"` -- existing block was replaced (version bump)
- `"skipped"` -- already at this version, or platform has no rules path
- `"clipboard"` -- content copied to clipboard (Cursor/VS Code)

### `equip.uninstallRules(platform, dryRun?)`

Remove the rules marker block from a platform's rules file.

```typescript
const removed = equip.uninstallRules(platform);
// true if the block was found and removed, false otherwise
```

If removing the block leaves the file empty, the file is deleted. If other content remains, equip preserves it and cleans up any excess blank lines.

### `parseRulesVersion(content, marker)`

Extract the installed version from a rules file's content.

```typescript
import { parseRulesVersion } from "@cg3/equip";

const version = parseRulesVersion(fileContent, "my-tool");
// "1.0.0" or null
```

### `markerPatterns(marker)`

Get the regex patterns used for marker detection and block extraction.

```typescript
import { markerPatterns } from "@cg3/equip";

const { MARKER_RE, BLOCK_RE } = markerPatterns("my-tool");
// MARKER_RE matches: <!-- my-tool:v1.0.0 -->
// BLOCK_RE matches the entire block from opening to closing marker
```

## Writing Effective Rules Content

### Structure

```markdown
<!-- my-tool:v1.0.0 -->
## My Tool -- Agent Instructions

[When to use the tool -- be specific about triggers]
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

6. **Combine with skills.** Rules tell the agent _when_ to use the tool. Skills tell it _how_. Together they cover the full loop. See [skills.md](./skills.md) for details.
