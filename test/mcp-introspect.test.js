// Tests for MCP server introspection — both HTTP and stdio transports.

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const { introspect } = require("../dist/lib/mcp-introspect");

// ─── Helpers ────────────────────────────────────────────────

function getStoredCredential(name) {
  try {
    const credPath = path.join(os.homedir(), ".equip", "credentials", `${name}.json`);
    return JSON.parse(fs.readFileSync(credPath, "utf-8"));
  } catch {
    return null;
  }
}

// Create a minimal MCP server script for stdio testing
function createMockMcpServer(dir) {
  const script = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }

  if (req.method === "initialize") {
    const res = {
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "mock-server", version: "1.0.0" },
      },
    };
    process.stdout.write(JSON.stringify(res) + "\\n");
  }

  if (req.method === "notifications/initialized") {
    // No response needed for notifications
  }

  if (req.method === "tools/list") {
    const res = {
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [
          {
            name: "greet",
            description: "Say hello to someone",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Name to greet" },
              },
              required: ["name"],
            },
          },
          {
            name: "add",
            description: "Add two numbers",
            inputSchema: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
              },
              required: ["a", "b"],
            },
          },
        ],
      },
    };
    process.stdout.write(JSON.stringify(res) + "\\n");
  }

  if (req.method === "resources/list") {
    const res = {
      jsonrpc: "2.0",
      id: req.id,
      result: {
        resources: [
          {
            uri: "mock://docs/readme",
            name: "readme",
            description: "The README file",
            mimeType: "text/markdown",
          },
        ],
      },
    };
    process.stdout.write(JSON.stringify(res) + "\\n");
  }

  if (req.method === "resources/templates/list") {
    const res = {
      jsonrpc: "2.0",
      id: req.id,
      result: { resourceTemplates: [] },
    };
    process.stdout.write(JSON.stringify(res) + "\\n");
  }

  if (req.method === "prompts/list") {
    const res = {
      jsonrpc: "2.0",
      id: req.id,
      result: { prompts: [] },
    };
    process.stdout.write(JSON.stringify(res) + "\\n");
  }

  if (req.method === "notifications/exit") {
    process.exit(0);
  }
});
`;
  const scriptPath = path.join(dir, "mock-mcp-server.js");
  fs.writeFileSync(scriptPath, script);
  return scriptPath;
}

// ─── stdio Transport Tests ──────────────────────────────────

describe("introspect — stdio transport", () => {
  let tmpDir;
  let serverPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
    serverPath = createMockMcpServer(tmpDir);
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("introspects a stdio MCP server", async () => {
    const result = await introspect({
      stdio: { command: process.execPath, args: [serverPath] },
      timeout: 10000,
    });

    // Server info
    assert.equal(result.server.name, "mock-server");
    assert.equal(result.server.version, "1.0.0");
    assert.equal(result.server.protocolVersion, "2025-03-26");

    // Capabilities
    assert.ok(result.capabilities.tools);
    assert.ok(result.capabilities.resources);

    // Tools
    assert.equal(result.tools.length, 2);
    assert.equal(result.tools[0].name, "greet");
    assert.equal(result.tools[1].name, "add");
    assert.ok(result.tools[0].description.includes("hello"));
    assert.ok(result.tools[0].inputSchema.properties);

    // Resources
    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0].uri, "mock://docs/readme");
    assert.equal(result.resources[0].name, "readme");
    assert.equal(result.resources[0].mimeType, "text/markdown");

    // Templates and prompts
    assert.equal(result.resourceTemplates.length, 0);
    assert.equal(result.prompts.length, 0);

    // Weight computation
    assert.ok(result.toolSchemaBytes > 0, "should compute schema bytes");
    assert.ok(result.toolTokens > 0, "should compute token estimate");
    assert.equal(result.toolBreakdown.length, 2);
    assert.equal(result.toolBreakdown[0].name, "greet");
    assert.ok(result.toolBreakdown[0].tokens > 0);
    assert.ok(result.toolBreakdown[0].bytes > 0);

    // Timestamp
    assert.ok(result.introspectedAt);
  });

  it("computes per-tool token breakdown", async () => {
    const result = await introspect({
      stdio: { command: process.execPath, args: [serverPath] },
    });

    // Greet has a simpler schema than add, but also has a description
    const greet = result.toolBreakdown.find(t => t.name === "greet");
    const add = result.toolBreakdown.find(t => t.name === "add");
    assert.ok(greet);
    assert.ok(add);

    // Total should equal sum of parts
    const totalFromBreakdown = result.toolBreakdown.reduce((sum, t) => sum + t.bytes, 0);
    assert.equal(result.toolSchemaBytes, totalFromBreakdown);

    const tokensFromBreakdown = result.toolBreakdown.reduce((sum, t) => sum + t.tokens, 0);
    assert.equal(result.toolTokens, tokensFromBreakdown);
  });

  it("handles server without optional capabilities", async () => {
    // Create a server that only supports tools (no resources, no prompts)
    const script = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: req.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "tools-only", version: "1.0.0" },
      },
    }) + "\\n");
  }
  if (req.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: req.id,
      result: { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }] },
    }) + "\\n");
  }
  if (req.method === "notifications/exit") process.exit(0);
});
`;
    const scriptPath = path.join(tmpDir, "tools-only-server.js");
    fs.writeFileSync(scriptPath, script);

    const result = await introspect({
      stdio: { command: process.execPath, args: [scriptPath] },
    });

    assert.equal(result.server.name, "tools-only");
    assert.equal(result.tools.length, 1);
    assert.equal(result.resources.length, 0, "should not attempt resources/list");
    assert.equal(result.prompts.length, 0, "should not attempt prompts/list");
  });

  it("throws on invalid stdio command", async () => {
    await assert.rejects(
      () => introspect({ stdio: { command: "nonexistent-binary-xyz", args: [] }, timeout: 3000 }),
    );
  });
});

// ─── HTTP Transport Tests ───────────────────────────────────

describe("introspect — HTTP transport (Prior remote)", () => {
  let apiKey;

  before(() => {
    const cred = getStoredCredential("prior");
    if (!cred || !cred.credential) {
      console.log("  Skipping HTTP tests — no Prior credential stored. Run 'equip prior' first.");
    }
    apiKey = cred?.credential;
  });

  it("introspects Prior's remote MCP server", async () => {
    if (!apiKey) return; // skip without credential

    const result = await introspect({
      serverUrl: "https://api.cg3.io/mcp",
      auth: `Bearer ${apiKey}`,
      timeout: 15000,
    });

    // Server info
    assert.equal(result.server.name, "prior");
    assert.ok(result.server.version);
    assert.ok(result.server.protocolVersion);

    // Capabilities
    assert.ok(result.capabilities.tools);
    assert.ok(result.capabilities.resources);

    // Tools — Prior has 5 tools
    assert.ok(result.tools.length >= 4, `Expected at least 4 tools, got ${result.tools.length}`);
    const toolNames = result.tools.map(t => t.name);
    assert.ok(toolNames.includes("prior_search"), "should have prior_search");
    assert.ok(toolNames.includes("prior_contribute"), "should have prior_contribute");
    assert.ok(toolNames.includes("prior_feedback"), "should have prior_feedback");
    assert.ok(toolNames.includes("prior_status"), "should have prior_status");

    // Each tool should have description and inputSchema
    for (const tool of result.tools) {
      assert.ok(tool.name, "tool should have name");
      assert.ok(tool.description, `${tool.name} should have description`);
      assert.ok(tool.inputSchema, `${tool.name} should have inputSchema`);
    }

    // Resources — Prior has several docs resources
    assert.ok(result.resources.length >= 1, `Expected at least 1 resource, got ${result.resources.length}`);
    const resourceUris = result.resources.map(r => r.uri);
    assert.ok(resourceUris.some(u => u.includes("prior://")), "should have prior:// URIs");

    // Weight — tool schemas are significant
    assert.ok(result.toolTokens > 1000, `Expected >1000 tool tokens, got ${result.toolTokens}`);
    assert.ok(result.toolSchemaBytes > 4000, `Expected >4000 schema bytes, got ${result.toolSchemaBytes}`);

    // Per-tool breakdown
    assert.equal(result.toolBreakdown.length, result.tools.length);
    const searchWeight = result.toolBreakdown.find(t => t.name === "prior_search");
    assert.ok(searchWeight);
    assert.ok(searchWeight.tokens > 100, "prior_search should have significant token weight");
  });

  it("returns error for invalid auth", async () => {
    await assert.rejects(
      () => introspect({
        serverUrl: "https://api.cg3.io/mcp",
        auth: "Bearer invalid-key-xyz",
        timeout: 10000,
      }),
      /401|Unauthorized|error/i,
    );
  });

  it("returns error for unreachable server", async () => {
    await assert.rejects(
      () => introspect({
        serverUrl: "https://localhost:19999/nonexistent",
        timeout: 3000,
      }),
    );
  });
});

// ─── Edge Cases ─────────────────────────────────────────────

describe("introspect — edge cases", () => {
  it("throws when neither serverUrl nor stdio provided", async () => {
    await assert.rejects(
      () => introspect({}),
      /Either serverUrl or stdio must be provided/,
    );
  });
});
