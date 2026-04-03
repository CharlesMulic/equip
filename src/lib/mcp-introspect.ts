// MCP server introspection — queries an MCP server to enumerate its capabilities.
// Supports both Streamable HTTP and stdio transports.
// Zero dependencies (uses Node built-in fetch + child_process).

import { spawn, type ChildProcess } from "child_process";
import type { EquipLogger } from "./types";
import { NOOP_LOGGER } from "./types";

// ─── Types: MCP Protocol ────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Types: Introspection Results ───────────────────────────

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  /** Content from resources/read (if fetched) */
  content?: string;
  /** Estimated tokens for this resource's content */
  tokens?: number;
}

export interface McpResourceTemplateDef {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
}

export interface McpCapabilities {
  tools?: boolean | Record<string, unknown>;
  resources?: boolean | Record<string, unknown>;
  prompts?: boolean | Record<string, unknown>;
  logging?: boolean | Record<string, unknown>;
}

export interface IntrospectionResult {
  server: McpServerInfo;
  capabilities: McpCapabilities;
  tools: McpToolDef[];
  resources: McpResourceDef[];
  resourceTemplates: McpResourceTemplateDef[];
  prompts: McpPromptDef[];
  introspectedAt: string;
  /** Total bytes of serialized tool schemas + descriptions (for weight estimation) */
  toolSchemaBytes: number;
  /** Estimated tokens for tool schemas (always in context when server connected) */
  toolTokens: number;
  /** Per-tool token breakdown */
  toolBreakdown: { name: string; tokens: number; bytes: number }[];
  /** Total estimated tokens for all resource content (on demand) */
  resourceTokens: number;
  /** Per-resource token breakdown */
  resourceBreakdown: { uri: string; name: string; tokens: number; bytes: number }[];
}

// ─── Options ────────────────────────────────────────────────

export interface IntrospectOptions {
  /** Server URL for HTTP transport */
  serverUrl?: string;
  /** Stdio command and args for stdio transport */
  stdio?: { command: string; args: string[]; env?: Record<string, string> };
  /** Authorization header value (e.g., "Bearer sk-xxx") */
  auth?: string;
  /** Timeout in ms for each JSON-RPC call (default: 15000) */
  timeout?: number;
  /** Logger */
  logger?: EquipLogger;
}

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_TIMEOUT = 15_000;
const STDIO_EXIT_TIMEOUT = 5_000;
const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "equip", version: "0.17.0" };

// ─── SSE Parser ─────────────────────────────────────────────

/**
 * Parse a Server-Sent Events response body to extract the JSON-RPC message.
 * SSE format: lines of "event: <type>\ndata: <json>\n\n"
 * We look for the first "data:" line that contains valid JSON-RPC.
 */
function parseSseResponse(text: string): JsonRpcResponse {
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const jsonStr = line.slice(6).trim();
      if (jsonStr) {
        try {
          return JSON.parse(jsonStr) as JsonRpcResponse;
        } catch { /* not valid JSON, try next data line */ }
      }
    }
  }
  throw new Error("No valid JSON-RPC message found in SSE response");
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Introspect an MCP server — enumerate its tools, resources, and prompts.
 * Supports both HTTP (Streamable HTTP) and stdio transports.
 */
export async function introspect(options: IntrospectOptions): Promise<IntrospectionResult> {
  const logger = options.logger || NOOP_LOGGER;
  const timeout = options.timeout || DEFAULT_TIMEOUT;

  if (options.serverUrl) {
    return introspectHttp(options.serverUrl, options.auth, timeout, logger);
  }

  if (options.stdio) {
    return introspectStdio(options.stdio, timeout, logger);
  }

  throw new Error("Either serverUrl or stdio must be provided");
}

// ─── HTTP Transport ─────────────────────────────────────────

async function introspectHttp(
  serverUrl: string,
  auth: string | undefined,
  timeout: number,
  logger: EquipLogger,
): Promise<IntrospectionResult> {
  let sessionId: string | undefined;

  async function rpc(method: string, params?: Record<string, unknown>, id?: number): Promise<unknown> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      ...(id !== undefined ? { id } : {}),
      ...(params ? { params } : {}),
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (auth) headers["Authorization"] = auth;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(serverUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Capture session ID if returned
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionId = sid;

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const contentType = res.headers.get("content-type") || "";
      const text = await res.text();
      if (!text.trim()) return undefined;

      // Parse response — may be plain JSON or SSE (text/event-stream)
      let response: JsonRpcResponse;
      if (contentType.includes("text/event-stream")) {
        response = parseSseResponse(text);
      } else {
        response = JSON.parse(text) as JsonRpcResponse;
      }

      if (response.error) {
        throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
      }

      return response.result;
    } catch (err: unknown) {
      clearTimeout(timer);
      throw err;
    }
  }

  return runIntrospectionSequence(rpc, logger);
}

// ─── stdio Transport ────────────────────────────────────────

async function introspectStdio(
  stdio: { command: string; args: string[]; env?: Record<string, string> },
  timeout: number,
  logger: EquipLogger,
): Promise<IntrospectionResult> {
  const env = { ...process.env, ...stdio.env };

  // Spawn on Windows needs shell wrapping for .cmd files
  const spawnOpts: { env: Record<string, string>; shell?: boolean } = { env: env as Record<string, string> };
  if (process.platform === "win32") spawnOpts.shell = true;

  const child: ChildProcess = spawn(stdio.command, stdio.args, {
    ...spawnOpts,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let idCounter = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let spawnError: Error | null = null;
  let stdoutBuffer = "";

  // Handle spawn failures (e.g., ENOENT for missing binaries)
  child.on("error", (err: Error) => {
    spawnError = err;
    for (const [id, handler] of pending) {
      pending.delete(id);
      handler.reject(err);
    }
  });

  // Read stdout line by line
  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        if (response.id !== undefined) {
          const handler = pending.get(response.id);
          if (handler) {
            pending.delete(response.id);
            if (response.error) {
              handler.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
            } else {
              handler.resolve(response.result);
            }
          }
        }
      } catch {
        // Non-JSON line (startup banner, etc.) — ignore
        logger.debug("Ignoring non-JSON stdout line", { line: line.slice(0, 100) });
      }
    }
  });

  let stderrContent = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrContent += chunk.toString();
  });

  async function rpc(method: string, params?: Record<string, unknown>, id?: number): Promise<unknown> {
    const actualId = id ?? ++idCounter;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      ...(actualId !== undefined ? { id: actualId } : {}),
      ...(params ? { params } : {}),
    };

    // Fail immediately if the process never started
    if (spawnError) return Promise.reject(spawnError);

    // For notifications (no id), just write and return
    if (id === undefined && !params && method.startsWith("notifications/")) {
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
      return undefined;
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(actualId);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, timeout);

      pending.set(actualId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      child.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  try {
    const result = await runIntrospectionSequence(rpc, logger);
    return result;
  } finally {
    // Graceful shutdown
    try {
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/exit" }) + "\n");
      child.stdin!.end();
    } catch {}

    // Wait for exit with timeout
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve();
      }, STDIO_EXIT_TIMEOUT);

      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

// ─── Introspection Sequence ─────────────────────────────────

type RpcFn = (method: string, params?: Record<string, unknown>, id?: number) => Promise<unknown>;

async function runIntrospectionSequence(rpc: RpcFn, logger: EquipLogger): Promise<IntrospectionResult> {
  // Step 1: Initialize
  logger.debug("Sending initialize");
  const initResult = await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  }, 1) as Record<string, unknown>;

  const serverInfo: McpServerInfo = {
    name: (initResult.serverInfo as any)?.name || "unknown",
    version: (initResult.serverInfo as any)?.version || "unknown",
    protocolVersion: (initResult.protocolVersion as string) || PROTOCOL_VERSION,
  };

  const rawCaps = (initResult.capabilities || {}) as Record<string, unknown>;
  const capabilities: McpCapabilities = {
    tools: !!rawCaps.tools,
    resources: !!rawCaps.resources,
    prompts: !!rawCaps.prompts,
    logging: !!rawCaps.logging,
  };

  logger.info("Server initialized", { name: serverInfo.name, version: serverInfo.version });

  // Step 2: Send initialized notification (fire-and-forget, no response expected)
  await rpc("notifications/initialized");

  // Step 3: List tools
  let tools: McpToolDef[] = [];
  if (capabilities.tools) {
    logger.debug("Listing tools");
    const toolsResult = await rpc("tools/list", {}, 2) as { tools?: McpToolDef[] };
    tools = (toolsResult?.tools || []).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || {},
    }));
    logger.info(`Found ${tools.length} tools`);
  }

  // Step 4: List resources
  let resources: McpResourceDef[] = [];
  let resourceTemplates: McpResourceTemplateDef[] = [];
  if (capabilities.resources) {
    logger.debug("Listing resources");
    try {
      const resourcesResult = await rpc("resources/list", {}, 3) as { resources?: McpResourceDef[] };
      resources = (resourcesResult?.resources || []).map(r => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
      logger.info(`Found ${resources.length} resources`);

      // Read each resource's content for token counting
      let readId = 100;
      for (const resource of resources) {
        try {
          const readResult = await rpc("resources/read", { uri: resource.uri }, ++readId) as {
            contents?: { text?: string; blob?: string; uri?: string; mimeType?: string }[];
          };
          const contents = readResult?.contents || [];
          if (contents.length > 0 && contents[0].text) {
            resource.content = contents[0].text;
            resource.tokens = Math.round(contents[0].text.length / 4);
          }
        } catch {
          // Some resources may require arguments or fail — skip silently
        }
      }
    } catch (e: unknown) {
      logger.debug("resources/list failed", { error: (e as Error).message });
    }

    try {
      const templatesResult = await rpc("resources/templates/list", {}, 4) as { resourceTemplates?: McpResourceTemplateDef[] };
      resourceTemplates = (templatesResult?.resourceTemplates || []).map(t => ({
        uriTemplate: t.uriTemplate,
        name: t.name,
        description: t.description,
        mimeType: t.mimeType,
      }));
    } catch (e: unknown) {
      logger.debug("resources/templates/list failed", { error: (e as Error).message });
    }
  }

  // Step 5: List prompts
  let prompts: McpPromptDef[] = [];
  if (capabilities.prompts) {
    logger.debug("Listing prompts");
    try {
      const promptsResult = await rpc("prompts/list", {}, 5) as { prompts?: McpPromptDef[] };
      prompts = (promptsResult?.prompts || []).map(p => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      }));
      logger.info(`Found ${prompts.length} prompts`);
    } catch (e: unknown) {
      logger.debug("prompts/list failed", { error: (e as Error).message });
    }
  }

  // Compute weight breakdown
  const toolBreakdown = tools.map(t => {
    const serialized = JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    const bytes = serialized.length;
    return { name: t.name, tokens: Math.round(bytes / 4), bytes };
  });

  const toolSchemaBytes = toolBreakdown.reduce((sum, t) => sum + t.bytes, 0);
  const toolTokens = toolBreakdown.reduce((sum, t) => sum + t.tokens, 0);

  // Resource content breakdown
  const resourceBreakdown = resources
    .filter(r => r.content)
    .map(r => ({
      uri: r.uri,
      name: r.name,
      tokens: r.tokens || 0,
      bytes: r.content!.length,
    }));
  const resourceTokens = resourceBreakdown.reduce((sum, r) => sum + r.tokens, 0);

  return {
    server: serverInfo,
    capabilities,
    tools,
    resources,
    resourceTemplates,
    prompts,
    introspectedAt: new Date().toISOString(),
    toolSchemaBytes,
    toolTokens,
    toolBreakdown,
    resourceTokens,
    resourceBreakdown,
  };
}
