#!/usr/bin/env node
// @cg3/equip CLI — universal entry point for AI tool setup.
// Usage: npx @cg3/equip <tool> [args...]
//   e.g. npx @cg3/equip prior --dry-run

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const EQUIP_VERSION = JSON.parse(
  require("fs").readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
).version;

// ─── Tool Registry ──────────────────────────────────────────

const TOOLS = {
  prior: { package: "@cg3/prior-node", command: "setup" },
};

// ─── CLI ─────────────────────────────────────────────────────

const alias = process.argv[2];
const extraArgs = process.argv.slice(3);

if (!alias || alias === "--help" || alias === "-h") {
  console.log("Usage: npx @cg3/equip <tool> [options]");
  console.log("");
  console.log("Available tools:");
  for (const [name, info] of Object.entries(TOOLS)) {
    console.log(`  ${name}  →  ${info.package} ${info.command}`);
  }
  console.log("");
  console.log("Options are forwarded to the tool (e.g. --dry-run, --platform codex)");
  process.exit(0);
}

const entry = TOOLS[alias];
if (!entry) {
  console.error(`Unknown tool: ${alias}`);
  console.error(`Available: ${Object.keys(TOOLS).join(", ")}`);
  process.exit(1);
}

// Spawn: npx -y <package> <command> [...extraArgs]
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(npxCmd, ["-y", entry.package, entry.command, ...extraArgs], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, EQUIP_VERSION },
});

child.on("close", (code) => process.exit(code || 0));
child.on("error", (err) => {
  console.error(`Failed to run ${entry.package}: ${err.message}`);
  process.exit(1);
});
