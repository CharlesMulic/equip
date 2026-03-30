# Building with Equip

This guide walks through making your tool equippable — distributable across AI coding platforms with a single setup script.

We'll start with the simplest thing (a behavioral rule), add a skill, then add MCP server config. Each layer works independently. Use what you need.

## Prerequisites

Install equip globally and as a local dependency:

```bash
npm install -g @cg3/equip        # CLI: equip, unequip
npm install @cg3/equip           # Library: require("@cg3/equip")
```

All examples below are plain Node.js scripts. Run them through equip for the full experience (state tracking, reconciliation):

```bash
equip ./piratehat.js
```

Equip detects that `./piratehat.js` is a local path and runs it directly — no npm publish needed. You get the same state reconciliation and tracking as a published tool, which makes development and testing seamless.

When you're ready to distribute, you'll publish to npm and register a shorthand so users can run `equip piratehat` instead.

## The Pirate Hat Example

Let's make agents talk like pirates. No MCP server needed — just rules and a skill that work across all platforms.

### Layer 1: Just a Rule

The simplest equippable tool is a behavioral rule — a text block injected into each platform's rules file.

Save this as `piratehat.js`:

```js
const { Equip, platformName, cli } = require("@cg3/equip");

const equip = new Equip({
  name: "piratehat",
  serverUrl: "https://example.com/unused",  // Required but unused when only installing rules
  rules: {
    content: `<!-- piratehat:v1.0.0 -->
## Pirate Mode
Respond to everything as a pirate. Use "arr", "matey", "ye", "shiver me timbers",
and other pirate speak. Address the user as "Captain". Never break character.
<!-- /piratehat -->`,
    version: "1.0.0",
    marker: "piratehat",
  },
});

const platforms = equip.detect();
for (const p of platforms) {
  const result = equip.installRules(p);
  if (result.action === "created") cli.ok(`${platformName(p.platform)}: pirate rules installed`);
  else if (result.action === "clipboard") {
    // Cursor and VS Code have no writable global rules file — equip copies the rules
    // to the clipboard instead. The user needs to paste them into their project's
    // rules config (e.g., .cursor/rules/ or .github/copilot-instructions.md).
    // No automatic pirates on these platforms without manual intervention.
    cli.info(`${platformName(p.platform)}: rules copied to clipboard (paste into project rules)`);
  }
  else if (result.action === "skipped") cli.info(`${platformName(p.platform)}: already a pirate`);
}
```

Run it:

```bash
equip ./piratehat.js
```

That's it. Every agent on every detected platform starts talking like a pirate. Equip runs your script, then reconciles state — `equip status` and `equip doctor` will show the installed rules.

Fair warning — you'll want to undo this before your next code review:

```bash
unequip piratehat
```

This works because `equip ./piratehat.js` inferred the tool name "piratehat" from the filename and tracked it in state. `unequip` reads that state to know what to remove — it doesn't need the original script file. The marker system means running it twice won't duplicate the block, and bumping the version will cleanly replace it.

**How rules work across platforms:**
- Claude Code: appended to `~/.claude/CLAUDE.md`
- Windsurf: appended to `~/.codeium/windsurf/memories/global_rules.md`
- Codex: appended to `~/.codex/AGENTS.md`
- Gemini CLI: appended to `~/.gemini/GEMINI.md`
- Cline: written as standalone `piratehat.md` in `~/Documents/Cline/Rules/`
- Roo Code: written as standalone `piratehat.md` in `~/.roo/rules/`
- Cursor, VS Code: copied to clipboard (no writable global rules file)

See [Behavioral Rules](./rules.md) for the full reference.

### Layer 2: Add a Skill

A skill gives agents deeper knowledge — procedural instructions they load on demand. Unlike rules (always in context), skills are discovered by description and loaded when relevant.

```js
const equip = new Equip({
  name: "piratehat",
  serverUrl: "https://example.com/unused",
  rules: {
    // ... same as above ...
  },
  skill: {
    name: "pirate-speak",
    files: [{
      path: "SKILL.md",
      content: `---
name: pirate-speak
description: Translate code comments, commit messages, and documentation into pirate speak. Use when the user asks for pirate mode or when piratehat rules are active.
metadata:
  author: piratehat
  version: "1.0.0"
---

# Pirate Speak Guide

## Vocabulary
| Normal | Pirate |
|---|---|
| Hello | Ahoy |
| Yes | Aye |
| Friend | Matey |
| Money/cost | Doubloons |
| Bug | Barnacle |
| Deploy | Set sail |
| Database | Treasure chest |
| Error | Kraken attack |
| Refactor | Swab the deck |

## Commit Messages
- "Fix login bug" -> "Vanquish the login kraken"
- "Add tests" -> "Fortify the ship's defenses"
- "Update deps" -> "Resupply the vessel"

## Code Comments
Use pirate metaphors but keep them understandable:
- "// Initialize connection pool" -> "// Ready the fleet for sail"
- "// Handle edge case" -> "// Watch for reefs, matey"
`,
    }],
  },
});

// Install both rules + skills
const platforms = equip.detect();
for (const p of platforms) {
  equip.installRules(p);
  equip.installSkill(p);
}
```

Now agents have both the behavioral rule (always active, tells them to be a pirate) and the skill (loaded on demand, gives them the vocabulary and patterns).

**Why both?** The rule drives behavior. The skill provides depth. On platforms where skill auto-discovery is unreliable (Cursor, Windsurf), the rule ensures the agent at least knows about pirate mode. On platforms with good skill discovery (Claude Code, VS Code), the skill gives the agent a reference guide it can consult.

**How skills work across platforms:**
- The SKILL.md format is universal — same file works everywhere
- Equip installs to each platform's native skills directory
- Agents load the description at startup, full content on demand
- See [Agent Skills](./skills.md) for how loading works per platform

### Layer 3: Add an MCP Server

If your tool has a live API (search, database, external service), add MCP config so agents can call it:

```js
const equip = new Equip({
  name: "piratehat",
  serverUrl: "https://api.piratehat.com/mcp",  // Your actual MCP endpoint
  rules: { /* ... */ },
  skill: { /* ... */ },
});

for (const p of platforms) {
  equip.installMcp(p, apiKey);    // Format-translated per platform
  equip.installRules(p);
  equip.installSkill(p);
}
```

This is where equip's format translation matters most. Each platform has its own opinions about MCP config — root keys, URL fields, type fields, header fields, JSON vs TOML. Equip handles all of it.

See [MCP Servers](./mcp-servers.md) for the full reference.

### Layer 4: Hooks (Optional, Claude Code Only)

Lifecycle hooks fire automatically at platform events — after a tool call, when the agent stops, on errors. They're the strongest enforcement but currently only Claude Code supports them.

```js
const equip = new Equip({
  name: "piratehat",
  serverUrl: "https://api.piratehat.com/mcp",
  rules: { /* ... */ },
  skill: { /* ... */ },
  hooks: [{
    event: "Stop",
    name: "pirate-reminder",
    script: `console.log("Arr! Don't forget to talk like a pirate, Captain!");`,
  }],
});

for (const p of platforms) {
  equip.installMcp(p, apiKey);
  equip.installRules(p);
  equip.installSkill(p);
  equip.installHooks(p);   // Silently skips non-Claude platforms
}
```

See [Lifecycle Hooks](./hooks.md) for events and patterns.

---

## Making It Real

The pirate example is fun but the pattern is the same for real tools. Here's what a production setup script typically adds:

### Authentication

Equip doesn't handle auth — your setup script does. Common patterns:

```js
// Environment variable
const apiKey = process.env.MY_TOOL_API_KEY;

// Interactive prompt
const apiKey = await cli.prompt("  Enter your API key: ");

// Generated during setup (call your API)
const { apiKey } = await registerAgent(userEmail);
```

### Platform Override

Let users target a specific platform:

```js
const platformArg = process.argv.find(a => a.startsWith("--platform="))?.split("=")[1];
const platforms = platformArg
  ? [createManualPlatform(platformArg)]
  : equip.detect();
```

### Verification

Check that everything was installed correctly:

```js
for (const p of platforms) {
  const result = equip.verify(p);
  if (result.ok) {
    cli.ok(`${platformName(p.platform)}: all checks passed`);
  } else {
    for (const check of result.checks.filter(c => !c.ok)) {
      cli.fail(`${platformName(p.platform)}: ${check.detail}`);
    }
  }
}
```

### Uninstall

```js
if (process.argv.includes("--uninstall")) {
  for (const p of platforms) {
    equip.uninstallMcp(p);
    equip.uninstallRules(p);
    equip.uninstallSkill(p);
    equip.uninstallHooks(p);
  }
}
```

### Dry Run

```js
const dryRun = process.argv.includes("--dry-run");
for (const p of platforms) {
  equip.installMcp(p, apiKey, { dryRun });
  equip.installRules(p, { dryRun });
  equip.installSkill(p, { dryRun });
  equip.installHooks(p, { dryRun });
}
```

---

## From Local Script to `equip <name>`

So far everything has been a local script you run with `equip ./piratehat.js`. Here's how to go from that to `equip piratehat`:

### Step 1: Make it an npm package

Move your script to `bin/setup.js` and add a package.json:

```
piratehat/
  bin/setup.js       # Your setup script (the code from above)
  package.json
```

You can test the package structure locally before publishing:

```bash
cd piratehat
equip .              # Reads package.json, finds bin entry, runs it
```

### Step 2: Publish to npm

```json
{
  "name": "piratehat",
  "version": "1.0.0",
  "bin": { "piratehat": "./bin/setup.js" },
  "dependencies": { "@cg3/equip": "^0.9.0" }
}
```

```bash
npm publish
```

At this point, users can install your tool with `npx piratehat` — they don't even need equip installed. But if they DO have equip, you can register a shorthand.

### Step 3: Register in equip

Open a PR to [registry.json](https://github.com/CharlesMulic/equip/blob/main/registry.json):

```json
{
  "piratehat": {
    "package": "piratehat",
    "command": "setup",
    "description": "Make your AI agents talk like pirates",
    "marker": "piratehat",
    "skillName": "pirate-speak"
  }
}
```

Now users can install with:

```bash
equip piratehat
```

---

## Reference

### EquipConfig

```js
new Equip({
  name: "my-tool",              // Required: server name in MCP configs
  serverUrl: "https://...",     // Required (unless stdio provided)
  stdio: {                      // Alternative to serverUrl
    command: "npx",
    args: ["-y", "@myorg/my-tool-mcp"],
    envKey: "MY_TOOL_API_KEY",
  },
  rules: {                      // Optional
    content: "<!-- marker:v1.0 -->...<!-- /marker -->",
    version: "1.0.0",
    marker: "my-tool",
    fileName: "my-tool.md",     // For directory-based platforms
    clipboardPlatforms: ["cursor", "vscode"],
  },
  skill: {                      // Optional
    name: "my-skill",
    files: [
      { path: "SKILL.md", content: "..." },
      { path: "scripts/helper.sh", content: "..." },
    ],
  },
  hooks: [{                     // Optional
    event: "PostToolUseFailure",
    matcher: "Bash",
    name: "error-handler",
    script: "console.log('Check my-tool for solutions');",
  }],
  hookDir: "~/.my-tool/hooks",  // Default: ~/.{name}/hooks
});
```

### Instance Methods

| Method | Returns | Description |
|---|---|---|
| `detect()` | `DetectedPlatform[]` | Detect installed platforms |
| `installMcp(platform, apiKey, options?)` | `{ success, method }` | Install MCP config |
| `uninstallMcp(platform, dryRun?)` | `boolean` | Remove MCP config |
| `updateMcpKey(platform, apiKey, transport?)` | `{ success, method }` | Update API key |
| `readMcp(platform)` | `object \| null` | Read existing MCP entry |
| `buildConfig(platformId, apiKey, transport?)` | `object` | Build config without writing |
| `installRules(platform, options?)` | `{ action }` | Install behavioral rules |
| `uninstallRules(platform, dryRun?)` | `boolean` | Remove behavioral rules |
| `installSkill(platform, options?)` | `{ action }` | Install agent skill |
| `uninstallSkill(platform, dryRun?)` | `boolean` | Remove agent skill |
| `hasSkill(platform)` | `boolean` | Check if skill is installed |
| `installHooks(platform, options?)` | `object \| null` | Install lifecycle hooks |
| `uninstallHooks(platform, options?)` | `boolean` | Remove hooks |
| `hasHooks(platform, options?)` | `boolean` | Check hooks installed |
| `supportsHooks(platform)` | `boolean` | Check platform supports hooks |
| `verify(platform)` | `VerifyResult` | Verify all installed artifacts |

### The Demo

The built-in demo is a complete, annotated setup script:

```bash
equip demo               # Dry run (safe — nothing written)
equip demo --live        # Actually write files
equip demo --uninstall   # Clean up
```

The demo source ([demo/setup.js](../demo/setup.js)) is designed to be copied and adapted.
