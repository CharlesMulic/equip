#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// @cg3/equip Demo — Minimal setup script for a fictional MCP tool.
//
// This file is a working reference for building your own setup
// script on top of @cg3/equip. Run it with:
//
//   npx @cg3/equip demo                    # dry-run by default (safe)
//   npx @cg3/equip demo --live             # actually write files
//   npx @cg3/equip demo --uninstall        # remove demo config
//   npx @cg3/equip demo --platform codex   # target a specific platform
//
// It demonstrates:
//   1. Platform detection (which AI tools are installed?)
//   2. MCP server configuration (HTTP or stdio transport)
//   3. Behavioral rules installation (versioned, marker-based)
//   4. Skills installation (SKILL.md files for agent discovery)
//   5. Lifecycle hooks (optional, platform-dependent)
//   6. Uninstallation (clean removal of everything it installed)
//   7. CLI output helpers (colors, prompts, clipboard)
//
// Everything is inline-documented. Copy this file as a starting
// point for your own tool's setup script.
// ─────────────────────────────────────────────────────────────

"use strict";

// ─── 1. Import equip ────────────────────────────────────────
//
// The Equip class is the high-level API. It wraps detection,
// config building, installation, and uninstallation into a
// single object. You can also import individual primitives
// (detectPlatforms, installMcp, etc.) for lower-level control.

const { Equip, createManualPlatform, platformName, cli } = require("@cg3/equip");

// ─── 2. Parse CLI flags ─────────────────────────────────────
//
// Keep it simple — equip doesn't ship an arg parser on purpose.
// Your setup script owns its own CLI interface.

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const liveMode = args.includes("--live");
const dryRun = !liveMode && !uninstall;  // Demo defaults to dry-run for safety
const platformOverride = args.includes("--platform")
  ? args[args.indexOf("--platform") + 1]
  : null;

// ─── 3. Define your tool ────────────────────────────────────
//
// This is the core configuration. Replace these values with
// your actual MCP server details.

const TOOL_NAME = "acme-docs";       // Name in MCP config files
const SERVER_URL = "https://api.example.com/mcp";  // Your MCP endpoint
const RULES_VERSION = "0.1.0";      // Bump when rules content changes

// Behavioral rules use HTML comment markers for versioned,
// non-destructive updates. The marker lets equip find and
// replace your block without touching the rest of the file.
//
// Format:
//   <!-- marker:vX.Y.Z -->
//   ... your rules content ...
//   <!-- /marker -->

const RULES_CONTENT = `<!-- ${TOOL_NAME}:v${RULES_VERSION} -->
## Acme Docs — Agent Instructions

When working with Acme APIs or libraries:
1. Use the acme-docs tool to look up current API signatures before guessing
2. Check for deprecation notices — Acme ships breaking changes quarterly
3. Prefer the code examples from acme-docs over generic web search results

The tool returns versioned docs matching your project's dependency version.
<!-- /${TOOL_NAME} -->`;

// ─── 4. Create the Equip instance ───────────────────────────
//
// The constructor validates config and stores it. No side
// effects — detection and installation happen in separate calls.

const equip = new Equip({
  name: TOOL_NAME,
  serverUrl: SERVER_URL,

  // Rules are optional. Omit this block if your tool doesn't
  // need behavioral instructions injected into agent configs.
  rules: {
    content: RULES_CONTENT,
    version: RULES_VERSION,
    marker: TOOL_NAME,
    // fileName: "my-tool.md",       // Use for platforms with rules directories
    // clipboardPlatforms: ["cursor", "vscode"],  // These get clipboard instead
  },

  // Stdio transport (alternative to HTTP). Uncomment to use:
  // stdio: {
  //   command: "npx",
  //   args: ["-y", "@example/my-tool-mcp@latest"],
  //   envKey: "MY_TOOL_API_KEY",    // Env var name for the API key
  // },

  // Hooks are optional. They run code at specific lifecycle
  // events in supported platforms (currently Claude Code only).
  // hooks: [
  //   {
  //     event: "PostToolUse",
  //     matcher: "Write|Edit",
  //     name: "check-api-version",
  //     script: `
  //       // This runs after a Write or Edit tool call completes.
  //       // Hook scripts receive context via stdin (JSON).
  //       const input = require("fs").readFileSync("/dev/stdin", "utf-8");
  //       const { tool_input } = JSON.parse(input);
  //       // Remind the agent to verify API versions after editing code
  //       if (tool_input?.file_path?.endsWith(".ts") || tool_input?.file_path?.endsWith(".js")) {
  //         console.log("Reminder: verify API versions with acme-docs after code changes.");
  //       }
  //     `,
  //   },
  // ],

  // Skills are optional. A skill is a SKILL.md file (Agent Skills
  // spec) that agents auto-discover. Unlike MCP config and rules,
  // the skill format is universal — same file works on all platforms.
  skill: {
    name: "lookup",
    files: [
      {
        path: "SKILL.md",
        content: `---
name: lookup
description: Look up Acme API docs for the current project's dependency version.
metadata:
  author: acme-docs-demo
  version: "${RULES_VERSION}"
---

# Acme Docs Lookup

Use this skill when working with Acme APIs or libraries.

## When to Use
- Before writing code that calls an Acme API
- When you see a deprecation warning from Acme
- When the user asks about Acme API signatures

## How to Use
1. Call the acme-docs MCP tool with the function name
2. The tool returns versioned docs matching the project's dependency
3. Use the returned signatures, not training data
`,
      },
    ],
  },
});

// ─── 5. Detect platforms (shared by install and uninstall) ───

function detectTargetPlatforms() {
  if (platformOverride) {
    const p = createManualPlatform(platformOverride);
    cli.info(`Forced platform: ${platformName(platformOverride)}`);
    return [p];
  }

  const platforms = equip.detect();
  if (platforms.length === 0) {
    cli.fail("No AI coding tools detected. Install one of:");
    cli.log("  Claude Code, Cursor, VS Code, Windsurf, Codex, Gemini CLI");
    cli.log("  Or use --platform <id> to specify manually.\n");
    process.exit(1);
  }
  return platforms;
}

// ─── 6. Uninstall flow ──────────────────────────────────────
//
// equip provides uninstallMcp() and uninstallRules() that
// cleanly remove everything the install wrote:
//   - MCP config: removes the server entry (restores .bak if available)
//   - Rules: removes the marker block, preserving other content
//   - Hooks: removes scripts and settings entries
//
// This is important for demos — and equally important for real
// tools that want a clean "uninstall" command.

async function runUninstall() {
  cli.log(`\n${cli.BOLD}@cg3/equip demo — uninstall${cli.RESET}\n`);

  cli.step(1, 4, "Detecting platforms");
  const platforms = detectTargetPlatforms();

  for (const p of platforms) {
    cli.ok(platformName(p.platform));
  }

  // ── Remove MCP config ────────────────────────────────────
  cli.step(2, 4, "Removing MCP config");

  for (const p of platforms) {
    const removed = equip.uninstallMcp(p);
    if (removed) {
      cli.ok(`${platformName(p.platform)} → removed`);
    } else {
      cli.info(`${platformName(p.platform)} → not configured (nothing to remove)`);
    }
  }

  // ── Remove behavioral rules ──────────────────────────────
  cli.step(3, 4, "Removing behavioral rules");

  for (const p of platforms) {
    const removed = equip.uninstallRules(p);
    if (removed) {
      cli.ok(`${platformName(p.platform)} → rules removed`);
    } else {
      cli.info(`${platformName(p.platform)} → no rules found`);
    }
  }

  // ── Remove skills ──────────────────────────────────────
  cli.step(4, 4, "Removing skills");

  for (const p of platforms) {
    const removed = equip.uninstallSkill(p);
    if (removed) {
      cli.ok(`${platformName(p.platform)} → skill removed`);
    } else {
      cli.info(`${platformName(p.platform)} → no skill found`);
    }
  }

  cli.log(`\n${cli.GREEN}${cli.BOLD}✓ Uninstall complete${cli.RESET}`);
  cli.log(`  Demo config for "${TOOL_NAME}" has been cleaned up.\n`);
}

// ─── 7. Install flow ────────────────────────────────────────

async function runInstall() {
  cli.log(`\n${cli.BOLD}@cg3/equip demo — setup walkthrough${cli.RESET}\n`);

  if (dryRun) {
    cli.warn("Dry run mode (default for demo) — no files will be modified");
    cli.info(`Use ${cli.BOLD}--live${cli.RESET} to actually write files\n`);
  }

  // ── Step 1: Detect platforms ──────────────────────────────
  //
  // detectPlatforms() scans the system for installed AI coding
  // tools: Claude Code, Cursor, VS Code, Windsurf, Codex, etc.
  //
  // Each result includes:
  //   - platform: id string ("claude-code", "cursor", etc.)
  //   - configPath: where MCP config lives
  //   - rulesPath: where behavioral rules go (or null)
  //   - existingMcp: current config for this server name (or null)
  //   - rootKey: JSON key for MCP servers ("mcpServers", "servers", etc.)
  //   - configFormat: "json" or "toml"
  //
  // You can also force a specific platform with createManualPlatform().

  cli.step(1, 5, "Detecting platforms");

  const platforms = detectTargetPlatforms();

  for (const p of platforms) {
    const status = p.existingMcp ? `${cli.YELLOW}configured${cli.RESET}` : `${cli.DIM}not configured${cli.RESET}`;
    cli.ok(`${platformName(p.platform)} [${status}]`);
  }

  // ── Step 2: Get API key ───────────────────────────────────
  //
  // In a real setup script, you'd prompt for or generate an
  // API key here. For the demo, we use a placeholder.

  cli.step(2, 5, "API key");

  // Real example:
  // const apiKey = await cli.prompt("  Enter your API key: ");
  // if (!apiKey) { cli.fail("API key required"); process.exit(1); }

  const apiKey = "demo_key_xxx";  // Placeholder for demo
  cli.info(`Using demo API key (${apiKey.slice(0, 8)}...)`);

  // ── Step 3: Install MCP config ────────────────────────────
  //
  // installMcp() handles all platform differences:
  //   - JSON vs TOML config formats
  //   - Different root keys (mcpServers vs servers vs mcp_servers)
  //   - Different URL fields (url vs serverUrl vs httpUrl)
  //   - Atomic file writes with crash safety
  //   - Windows path handling (cmd /c wrapper for stdio)

  cli.step(3, 5, "Installing MCP config");

  for (const p of platforms) {
    const result = equip.installMcp(p, apiKey, { dryRun });
    if (result.success) {
      cli.ok(`${platformName(p.platform)} → ${result.method}`);
    } else {
      cli.fail(`${platformName(p.platform)}`);
    }
  }

  // ── Step 4: Install behavioral rules ──────────────────────
  //
  // Rules are versioned markdown blocks injected into each
  // platform's rules file (CLAUDE.md, GEMINI.md, etc.).
  //
  // The marker system means:
  //   - First install: appends the block
  //   - Version bump: replaces the old block in-place
  //   - Same version: skips (idempotent)
  //   - Uninstall: removes the block cleanly
  //
  // Platforms without a rules file (Cursor, VS Code) get the
  // content copied to clipboard instead.

  cli.step(4, 5, "Installing behavioral rules");

  for (const p of platforms) {
    const result = equip.installRules(p, { dryRun });
    switch (result.action) {
      case "created":
        cli.ok(`${platformName(p.platform)} → rules installed`);
        break;
      case "updated":
        cli.ok(`${platformName(p.platform)} → rules updated`);
        break;
      case "skipped":
        // "skipped" can mean two things:
        //   1. Rules already at this version (rulesPath exists, marker version matches)
        //   2. Platform has no writable rules path (rulesPath is null)
        // Distinguish them so the output isn't misleading.
        if (p.rulesPath) {
          cli.info(`${platformName(p.platform)} → already current`);
        } else {
          cli.info(`${platformName(p.platform)} → no rules path (MCP-only platform)`);
        }
        break;
      case "clipboard":
        cli.info(`${platformName(p.platform)} → copied to clipboard (paste into settings)`);
        break;
    }
  }

  // ── Step 5: Install skills ──────────────────────────────
  //
  // Skills are SKILL.md files (Agent Skills spec) that agents
  // auto-discover from standard directories. Unlike MCP config,
  // the skill format is universal — same file works on all
  // platforms. Equip installs to each platform's native skill
  // directory, or ~/.agents/skills/ for platforms without one.

  cli.step(5, 5, "Installing skills");

  for (const p of platforms) {
    const result = equip.installSkill(p, { dryRun });
    switch (result.action) {
      case "created":
        cli.ok(`${platformName(p.platform)} → skill installed`);
        break;
      case "skipped":
        if (p.skillsPath) {
          cli.info(`${platformName(p.platform)} → skill already current`);
        } else {
          cli.info(`${platformName(p.platform)} → no skills support`);
        }
        break;
    }
  }

  // ── Done ──────────────────────────────────────────────────

  cli.log(`\n${cli.GREEN}${cli.BOLD}✓ Setup complete${cli.RESET}`);
  if (dryRun) {
    cli.warn("(dry run — nothing was actually written)\n");
  } else {
    // When files were actually written, remind user how to clean up
    cli.log(`  MCP server "${TOOL_NAME}" is now configured on ${platforms.length} platform(s).`);
    cli.log("");
    cli.warn(`This was a demo — run ${cli.BOLD}npx @cg3/equip demo --uninstall${cli.RESET} to remove demo files\n`);
  }
}

// ─── 8. Entry point ─────────────────────────────────────────
//
// Route to install or uninstall based on flags.
// Wrap in error handler for clean output.

const run = uninstall ? runUninstall : runInstall;

run().catch((err) => {
  cli.fail(cli.sanitizeError(err.message));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
