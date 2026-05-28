#!/usr/bin/env node

import readline from "node:readline";

const token = process.env.EQUIP_SMOKE_TOKEN || "";
if (token) {
  console.error(`fixture token=${token}`);
  console.error(`fixture Authorization: Bearer ${token}`);
}
console.error(`fixture cwd=${process.cwd()}`);

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message?.method !== "initialize") return;

  const response = {
    jsonrpc: "2.0",
    id: message.id,
    result: {
      protocolVersion: message.params?.protocolVersion || "2025-06-18",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "equip-mcp-smoke-npm",
        version: "0.1.0",
      },
    },
  };

  process.stdout.write(`${JSON.stringify(response)}\n`);
});
