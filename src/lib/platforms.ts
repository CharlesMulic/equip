// Platform registry — single source of truth for all platform-specific knowledge.
// Zero dependencies.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Types ───────────────────────────────────────────────────

export interface PlatformHttpShape {
  /** Field name for the server URL */
  urlField: "url" | "serverUrl" | "httpUrl";
  /** Optional type field value (e.g., "http", "streamable-http") */
  typeField?: string;
  /** Key name for auth headers */
  headersField: "headers" | "http_headers";
  /** Optional wrapper key for headers (e.g., "requestInit" → { requestInit: { headers: {...} } }) */
  headersWrapper?: string;
}

export interface PlatformDetection {
  /** CLI command name to check with `which` */
  cli: string | null;
  /** Directories whose existence indicates the platform is installed */
  dirs: (() => string)[];
  /** Files whose existence indicates the platform is installed */
  files: (() => string)[];
  /** Custom version detection function (overrides default `cli --version`) */
  versionFn?: () => string | null;
}

export interface PlatformHookCapabilities {
  settingsPath: () => string;
  events: string[];
  format: string;
}

// ─── Broker capability flags + strategy hooks ──────────────
// See ADR: equip-app/planning/ADR-cross-platform-strategy-pattern.md
//
// Capability flags answer YES/NO questions about a platform.
// Strategy hooks produce behavioral outputs (config bytes, rule sets).
// All fields are optional — undefined means "use the conservative baseline":
//   capability flags default to false (assume unsupported until proven)
//   strategy hooks default to undefined (callers fall back to baseline behavior)
//
// Adding a new capability flag should answer a single yes/no question that
// directly maps to baseline-or-override routing. If a question has more than
// two answers, or its answer is bytes/rules, it belongs in a strategy hook.

/**
 * Yes/no capabilities a platform may declare for broker-mode integration.
 * Additive: new flags must default to a safe "baseline" interpretation when
 * absent so existing PlatformDefinition entries keep working unchanged.
 */
export interface PlatformBrokerCapabilities {
  /**
   * Master switch: does this platform's MCP config surface support broker
   * mode at all? Implies at least one of supportsStdioShim or
   * supportsLoopbackHttp is also true. When false, broker code should not
   * attempt to write broker config for this platform.
   */
  supportsBroker?: boolean;

  /**
   * Can the platform's MCP config accept a `command` + `args` entry that
   * we can point at the equip-broker-shim binary? This is the primary
   * broker transport (per spike: stdio shim >> loopback HTTP).
   */
  supportsStdioShim?: boolean;

  /**
   * Can the platform's MCP config accept a `url` entry pointing at a
   * loopback HTTP broker endpoint? Fallback transport. Carries discovery
   * suppression risks on platforms with oauthDiscoveryProbing=true.
   */
  supportsLoopbackHttp?: boolean;

  /**
   * Does this platform aggressively probe OAuth discovery paths
   * (`/.well-known/oauth-authorization-server`,
   *  `/.well-known/oauth-protected-resource/...`) on the configured URL?
   * When true, the loopback HTTP broker MUST return 404 for those paths
   * AND never emit `WWW-Authenticate`, or the platform will hijack the
   * request into an OAuth flow and ignore configured headers.
   * (Per spike: Cursor exhibits this; Claude Code and Codex do not.)
   */
  oauthDiscoveryProbing?: boolean;

  /**
   * Does this platform persist a "needs auth" cache (with a TTL) that can
   * block reconnection even after the broker has refreshed credentials?
   * (Per spike: Claude Code's `~/.claude/mcp-needs-auth-cache.json` has a
   * 15-minute TTL that is a real recovery hazard.) When true, broker-side
   * recovery flows must explicitly invalidate the cache after a successful
   * refresh — not rely on the platform's TTL expiring naturally.
   */
  mcpNeedsAuthRecovery?: boolean;
}

/**
 * Result of writing a platform-specific broker config. Returned by the
 * `writeBrokerConfig` strategy hook.
 *
 * The hook owns the choice of stdio-vs-HTTP transport for its platform
 * and the obligation to OMIT all OAuth-shaped fields (`auth`,
 * `bearer_token_env_var`, `scopes`, `oauth_resource`, etc.) so the
 * platform never tries OAuth against the broker.
 */
export interface BrokerConfigWriteResult {
  /**
   * The MCP config entry as a structured object (will be merged into the
   * platform's existing config under its `rootKey` by the caller). The
   * shape depends on the platform's `configFormat` and `httpShape` — for
   * stdio: `{ command, args, env? }`; for loopback HTTP: `{ url, ... }`.
   */
  entry: Record<string, unknown>;
  /**
   * Which transport this entry uses. Lets observability + doctor surface
   * the install-mode without re-parsing the entry.
   */
  transport: "stdio" | "loopback-http";
  /**
   * Optional human-readable note for `equip doctor` output (e.g. "Cursor
   * 2.5+ recommended" or "first-time auth runs in equip-app").
   */
  note?: string;
}

/**
 * Endpoint to the broker daemon, passed into `writeBrokerConfig`. The
 * shape supports both stdio shim invocations and loopback HTTP.
 */
export interface BrokerEndpoint {
  /** Augment identity the broker entry is for. Hooks may include this in args/env. */
  augmentName: string;
  /** Path to the equip-broker-shim binary (resolved at install time). */
  shimBinaryPath: string;
  /**
   * Loopback HTTP URL for the broker daemon, if loopback transport is
   * being used. Undefined when only stdio is being written.
   */
  loopbackUrl?: string;
  /**
   * Extra args the shim caller wants forwarded (e.g. log level, broker
   * socket path override). The hook decides whether and how to pass these.
   */
  shimExtraArgs?: string[];
}

/**
 * Declarative rules describing which OAuth-discovery paths the broker
 * daemon must return 404 on for a given platform's installs. Returned by
 * the `suppressOAuthDiscovery` strategy hook.
 *
 * Most platforms don't need this hook (capability flag
 * oauthDiscoveryProbing=false); the broker daemon applies a permissive
 * baseline that simply doesn't advertise OAuth. Cursor specifically needs
 * an explicit deny list.
 */
export interface DiscoverySuppressionRules {
  /**
   * Path prefixes to return 404 on. Example: ["/.well-known/oauth-"].
   * Matched against request path; broker returns 404 with no
   * `WWW-Authenticate` header.
   */
  pathPrefixes: string[];
  /**
   * If true, the broker MUST NOT emit `WWW-Authenticate` headers on any
   * 401 response for installs of this platform — the platform would
   * otherwise interpret it as an OAuth challenge and hijack the flow.
   * (Per spike: required for Cursor.)
   */
  suppressWwwAuthenticate: boolean;
}

/**
 * Strategy hooks: behavioral overrides for platforms whose divergence
 * cannot be captured by yes/no capability flags.
 *
 * Discipline rules (see ADR):
 *   - Add a hook only when the platform produces *behavioral output*
 *     (bytes, rule sets) that the baseline can't generate from flags.
 *   - Keep hook contracts typed and small — one hook = one decision.
 *   - Hooks are pure data-producers when possible (no I/O); the broker
 *     daemon applies the result.
 */
export interface PlatformBrokerStrategy {
  /**
   * Produce the platform-specific MCP config entry that points at the
   * broker for one augment. Owns OAuth-bypass discipline (omit `auth`
   * field on Claude Code; never set `bearer_token_env_var` on Codex; etc).
   *
   * Returns null when this platform doesn't currently support a broker
   * entry for the given augment (e.g. broker doesn't support the augment's
   * required transport). Caller falls back to direct-mode install.
   */
  writeBrokerConfig?: (
    augmentName: string,
    endpoint: BrokerEndpoint,
  ) => BrokerConfigWriteResult | null;

  /**
   * Produce the discovery-suppression rules the broker daemon should
   * apply for installs of this platform. Only meaningful when
   * capabilities.oauthDiscoveryProbing === true; baseline platforms can
   * leave this hook undefined.
   */
  suppressOAuthDiscovery?: () => DiscoverySuppressionRules;
}

export interface PlatformDefinition {
  id: string;
  name: string;
  aliases: string[];
  configPath: () => string;
  rulesPath: (() => string) | null;
  rootKey: string;
  configFormat: "json" | "toml";
  httpShape: PlatformHttpShape;
  detection: PlatformDetection;
  hooks: PlatformHookCapabilities | null;
  skillsPath: (() => string) | null;
  /**
   * Broker-mode capability declarations. Optional + additive; platforms
   * without this field are treated as broker-unsupported.
   * See PlatformBrokerCapabilities for per-flag semantics.
   */
  brokerCapabilities?: PlatformBrokerCapabilities;
  /**
   * Per-platform strategy overrides for behavior that capability flags
   * cannot express. Optional; leave undefined for platforms that follow
   * the baseline. See PlatformBrokerStrategy for hook contracts.
   */
  brokerStrategy?: PlatformBrokerStrategy;
}

/** The shape returned by detect() and createManualPlatform() */
export interface DetectedPlatform {
  platform: string;
  configPath: string;
  rulesPath: string | null;
  skillsPath: string | null;
  existingMcp: Record<string, unknown> | null;
  rootKey: string;
  configFormat: "json" | "toml";
}

// ─── Path Helpers ────────────────────────────────────────────

function home(): string { return os.homedir(); }

function vsCodeUserDir(): string {
  const h = home();
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(h, "AppData", "Roaming"), "Code", "User");
  if (process.platform === "darwin") return path.join(h, "Library", "Application Support", "Code", "User");
  return path.join(h, ".config", "Code", "User");
}

/** Roo Code renamed cline_mcp_settings.json → mcp_settings.json (March 2025). Prefer new name. */
function rooCodeConfigPath(): string {
  const dir = path.join(vsCodeUserDir(), "globalStorage", "rooveterinaryinc.roo-cline", "settings");
  const newPath = path.join(dir, "mcp_settings.json");
  const oldPath = path.join(dir, "cline_mcp_settings.json");
  try { if (fs.statSync(newPath).isFile()) return newPath; } catch {}
  return oldPath;
}

function copilotJetBrainsDir(): string {
  const h = home();
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(h, "AppData", "Roaming"), "github-copilot");
  return path.join(h, ".config", "github-copilot");
}

// ─── Claude Code version detection ──────────────────────────

function getClaudeCodeVersion(): string | null {
  try {
    const { execSync } = require("child_process");
    const out = execSync("claude --version 2>&1", { encoding: "utf-8", timeout: 5000 }) as string;
    const m = out.match(/(\d+\.\d+[\.\d]*)/);
    return m ? m[1] : "unknown";
  } catch { return null; }
}

// ─── Registry ───────────────────────────────────────────────

const CLAUDE_CODE_HOOKS_EVENTS = [
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop",
  "SessionStart", "SessionEnd", "UserPromptSubmit", "Notification",
  "SubagentStart", "SubagentStop", "PreCompact", "TaskCompleted",
];

export const PLATFORM_REGISTRY: ReadonlyMap<string, PlatformDefinition> = new Map<string, PlatformDefinition>([
  ["claude-code", {
    id: "claude-code",
    name: "Claude Code",
    aliases: ["claude", "claudecode"],
    configPath: () => path.join(home(), ".claude.json"),
    rulesPath: () => path.join(home(), ".claude", "CLAUDE.md"),
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", typeField: "http", headersField: "headers" },
    detection: {
      cli: "claude",
      dirs: [() => path.join(home(), ".claude")],
      files: [],
      versionFn: getClaudeCodeVersion,
    },
    hooks: {
      settingsPath: () => path.join(home(), ".claude", "settings.json"),
      events: CLAUDE_CODE_HOOKS_EVENTS,
      format: "claude-code",
    },
    skillsPath: () => path.join(home(), ".claude", "skills"),
    // Broker capabilities — stdio shim is the cleanest path. Loopback HTTP
    // works when `auth` is omitted from the .mcp.json entry (per spike).
    // mcpNeedsAuthRecovery=true: 15-min mcp-needs-auth-cache.json TTL is a
    // real recovery hazard that broker code must invalidate on refresh.
    // oauthDiscoveryProbing=false: Claude Code does not auto-probe OAuth
    // discovery against loopback URLs.
    // Strategy hook implementations land in Package 05.
    brokerCapabilities: {
      supportsBroker: true,
      supportsStdioShim: true,
      supportsLoopbackHttp: true,
      oauthDiscoveryProbing: false,
      mcpNeedsAuthRecovery: true,
    },
    // Claude Code broker writer (Package 05). Stdio-only entry into
    // ~/.claude.json's `mcpServers` map.
    //
    // OAuth-bypass discipline (per spike Claude Code section):
    //   - NEVER include the `auth` field — its presence on a managed
    //     entry triggers Claude Code's `/mcp authenticate` flow which
    //     defeats the broker.
    //   - NEVER include `url` or `headers` — broker entries are stdio
    //     command + args only; the shim mediates the upstream traffic.
    //
    // The mcp-needs-auth-cache.json hazard (15-min TTL) is recovery-
    // path-only and applies to entries that the platform thinks need
    // OAuth. Stdio-shim entries are not OAuth-shaped, so the cache
    // doesn't fire on them; broker-side cache invalidation is therefore
    // not part of this hook (it would only matter for legacy direct-
    // mode auth entries, out of scope for broker writers).
    brokerStrategy: {
      writeBrokerConfig: (augmentName, endpoint) => ({
        entry: {
          command: endpoint.shimBinaryPath,
          args: ["--augment", augmentName, ...(endpoint.shimExtraArgs ?? [])],
        },
        transport: "stdio",
        note: "broker-managed; first-time OAuth runs in equip-app",
      }),
    },
  }],
  ["cursor", {
    id: "cursor",
    name: "Cursor",
    aliases: [],
    configPath: () => path.join(home(), ".cursor", "mcp.json"),
    rulesPath: null,
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", headersField: "headers" },
    detection: {
      cli: "cursor",
      dirs: [() => path.join(home(), ".cursor")],
      files: [],
    },
    hooks: null,
    skillsPath: () => path.join(home(), ".cursor", "skills"),
    // Broker capabilities — stdio shim is the strongest path (mcp-remote is
    // exact prior art on Cursor today). Loopback HTTP is viable only with
    // strict discovery suppression: broker MUST 404 on /.well-known/oauth-*
    // AND never emit WWW-Authenticate. oauthDiscoveryProbing=true is the
    // load-bearing flag that triggers the suppressOAuthDiscovery hook in
    // broker daemon code. mcpNeedsAuthRecovery=false: no documented cache.
    // Strategy hook implementations land in Package 05.
    brokerCapabilities: {
      supportsBroker: true,
      supportsStdioShim: true,
      supportsLoopbackHttp: true,
      oauthDiscoveryProbing: true,
      mcpNeedsAuthRecovery: false,
    },
    // Cursor broker writer (Package 05). Stdio-only entry into
    // ~/.cursor/mcp.json's `mcpServers` map.
    //
    // OAuth-bypass discipline (per spike Cursor section):
    //   - NEVER include `url` — Cursor probes /.well-known/oauth-* on
    //     URL entries (see oauthDiscoveryProbing=true on capabilities).
    //     Stdio shim entries are not URL-shaped and are therefore
    //     discovery-probe-free.
    //   - NEVER include `headers.Authorization` — would trigger Cursor's
    //     OAuth flow on the discovery probe.
    //
    // Loopback HTTP transport for Cursor would need broker-side
    // suppressOAuthDiscovery (404 on /.well-known/oauth-* + suppress
    // WWW-Authenticate); deferred until loopback-HTTP is actually wanted
    // (stdio is the strongest path; mcp-remote is exact prior art).
    brokerStrategy: {
      writeBrokerConfig: (augmentName, endpoint) => ({
        entry: {
          command: endpoint.shimBinaryPath,
          args: ["--augment", augmentName, ...(endpoint.shimExtraArgs ?? [])],
        },
        transport: "stdio",
        note: "broker-managed; first-time OAuth runs in equip-app",
      }),
    },
  }],
  ["windsurf", {
    id: "windsurf",
    name: "Windsurf",
    aliases: [],
    configPath: () => path.join(home(), ".codeium", "windsurf", "mcp_config.json"),
    rulesPath: () => path.join(home(), ".codeium", "windsurf", "memories", "global_rules.md"),
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "serverUrl", headersField: "headers" },
    detection: {
      cli: null,
      dirs: [() => path.join(home(), ".codeium", "windsurf")],
      files: [],
    },
    hooks: null,
    skillsPath: () => path.join(home(), ".agents", "skills"),
  }],
  ["vscode", {
    id: "vscode",
    name: "VS Code",
    aliases: ["vs-code", "code"],
    configPath: () => path.join(vsCodeUserDir(), "mcp.json"),
    rulesPath: null,
    rootKey: "servers",
    configFormat: "json",
    httpShape: { urlField: "url", typeField: "http", headersField: "headers" },
    detection: {
      cli: "code",
      dirs: [() => vsCodeUserDir()],
      files: [() => path.join(vsCodeUserDir(), "mcp.json")],
    },
    hooks: null,
    skillsPath: () => path.join(home(), ".agents", "skills"),
  }],
  ["cline", {
    id: "cline",
    name: "Cline",
    aliases: [],
    configPath: () => path.join(vsCodeUserDir(), "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
    rulesPath: () => path.join(home(), "Documents", "Cline", "Rules"),
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", headersField: "headers" },
    detection: {
      cli: null,
      dirs: [],
      files: [() => path.join(vsCodeUserDir(), "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")],
    },
    hooks: null,
    skillsPath: () => path.join(home(), ".cline", "skills"),
  }],
  ["roo-code", {
    id: "roo-code",
    name: "Roo Code",
    aliases: ["roo", "roocode"],
    configPath: rooCodeConfigPath,
    rulesPath: () => path.join(home(), ".roo", "rules"),
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", typeField: "streamable-http", headersField: "headers" },
    detection: {
      cli: null,
      dirs: [],
      files: [
        () => path.join(vsCodeUserDir(), "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json"),
        () => path.join(vsCodeUserDir(), "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json"),
      ],
    },
    hooks: null,
    skillsPath: () => path.join(home(), ".roo", "skills"),
  }],
  ["codex", {
    id: "codex",
    name: "Codex",
    aliases: [],
    configPath: () => path.join(process.env.CODEX_HOME || path.join(home(), ".codex"), "config.toml"),
    rulesPath: () => path.join(process.env.CODEX_HOME || path.join(home(), ".codex"), "AGENTS.md"),
    rootKey: "mcp_servers",
    configFormat: "toml",
    httpShape: { urlField: "url", headersField: "http_headers" },
    detection: {
      cli: "codex",
      dirs: [() => process.env.CODEX_HOME || path.join(home(), ".codex")],
      files: [],
    },
    hooks: null,
    skillsPath: () => path.join(home(), ".agents", "skills"),
    // Broker capabilities — Codex stdio MCP entries are first-class and
    // most reliable; bypass discipline for Codex is "never run codex mcp
    // login + never set bearer_token_env_var/scopes/oauth_resource" (per
    // spike). oauthDiscoveryProbing=false: Codex's OAuth login is opt-in.
    // mcpNeedsAuthRecovery=false: no documented persistent needs-auth
    // cache. Codex is the worst-broken platform on refresh today and is
    // our first end-to-end demo target. Strategy hook implementations
    // land in Package 04.
    brokerCapabilities: {
      supportsBroker: true,
      supportsStdioShim: true,
      supportsLoopbackHttp: true,
      oauthDiscoveryProbing: false,
      mcpNeedsAuthRecovery: false,
    },
    // Codex broker writer (Package 04). The hook produces a stdio-only
    // [mcp_servers.<name>] entry that points at equip-broker-shim.
    //
    // OAuth-bypass discipline (per spike Codex section + ENGINEERING_PLAN):
    //   - NEVER set bearer_token_env_var → Codex would otherwise spawn
    //     `codex mcp login` to mint that env var, defeating the whole
    //     point of brokering.
    //   - NEVER set scopes → presence triggers OAuth discovery probe.
    //   - NEVER set oauth_resource → presence triggers OAuth metadata
    //     fetch against the upstream.
    //
    // Codex sees only `command` + `args` for a stdio MCP server. From
    // Codex's perspective there is no OAuth at all — the shim mediates
    // and the broker holds credentials.
    brokerStrategy: {
      writeBrokerConfig: (augmentName, endpoint) => ({
        entry: {
          command: endpoint.shimBinaryPath,
          args: ["--augment", augmentName, ...(endpoint.shimExtraArgs ?? [])],
        },
        transport: "stdio",
        note: "broker-managed; first-time OAuth runs in equip-app",
      }),
    },
  }],
  ["gemini-cli", {
    id: "gemini-cli",
    name: "Gemini CLI",
    aliases: ["gemini"],
    configPath: () => path.join(home(), ".gemini", "settings.json"),
    rulesPath: () => path.join(home(), ".gemini", "GEMINI.md"),
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "httpUrl", headersField: "headers" },
    detection: {
      cli: "gemini",
      dirs: [() => path.join(home(), ".gemini")],
      files: [],
    },
    hooks: null,
    skillsPath: () => path.join(home(), ".gemini", "skills"),
  }],
  ["junie", {
    id: "junie",
    name: "Junie",
    aliases: [],
    configPath: () => path.join(home(), ".junie", "mcp", "mcp.json"),
    rulesPath: null,
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", headersField: "headers" },
    detection: {
      cli: "junie",
      dirs: [() => path.join(home(), ".junie")],
      files: [],
    },
    hooks: null,
    skillsPath: null,
  }],
  ["copilot-jetbrains", {
    id: "copilot-jetbrains",
    name: "Copilot (JetBrains)",
    aliases: ["copilot-jb"],
    configPath: () => path.join(copilotJetBrainsDir(), "intellij", "mcp.json"),
    rulesPath: null,
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", headersField: "headers" },
    detection: {
      cli: null,
      dirs: [() => copilotJetBrainsDir()],
      files: [],
    },
    hooks: null,
    skillsPath: null,
  }],
  ["copilot-cli", {
    id: "copilot-cli",
    name: "Copilot CLI",
    aliases: ["copilot"],
    configPath: () => path.join(home(), ".copilot", "mcp-config.json"),
    rulesPath: null,
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", typeField: "http", headersField: "headers" },
    detection: {
      cli: "copilot",
      dirs: [() => path.join(home(), ".copilot")],
      files: [],
    },
    hooks: null,
    skillsPath: null,
  }],
  ["amazon-q", {
    id: "amazon-q",
    name: "Amazon Q",
    aliases: ["q", "amazonq"],
    configPath: () => path.join(home(), ".aws", "amazonq", "agents", "default.json"),
    rulesPath: null,
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", typeField: "http", headersField: "headers" },
    detection: {
      cli: "q",
      dirs: [() => path.join(home(), ".aws", "amazonq")],
      files: [],
    },
    hooks: null,
    skillsPath: null,
  }],
  ["tabnine", {
    id: "tabnine",
    name: "Tabnine",
    aliases: [],
    configPath: () => path.join(home(), ".tabnine", "mcp_servers.json"),
    rulesPath: () => path.join(home(), ".tabnine", "guidelines"),
    rootKey: "mcpServers",
    configFormat: "json",
    httpShape: { urlField: "url", headersField: "headers", headersWrapper: "requestInit" },
    detection: {
      cli: null,
      dirs: [() => path.join(home(), ".tabnine")],
      files: [],
    },
    hooks: null,
    skillsPath: null,
  }],
]);

// ─── Derived Helpers ────────────────────────────────────────

export const KNOWN_PLATFORMS: string[] = [...PLATFORM_REGISTRY.keys()];

export function platformName(id: string): string {
  return PLATFORM_REGISTRY.get(id)?.name ?? id;
}

export function resolvePlatformId(input: string): string {
  const s = input.trim().toLowerCase();
  if (PLATFORM_REGISTRY.has(s)) return s;
  for (const [id, def] of PLATFORM_REGISTRY) {
    if (def.aliases.includes(s)) return id;
  }
  return s;
}

export function getPlatform(id: string): PlatformDefinition {
  const def = PLATFORM_REGISTRY.get(id);
  if (!def) throw new Error(`Unknown platform: ${id}. Supported: ${KNOWN_PLATFORMS.join(", ")}`);
  return def;
}

export function createManualPlatform(platformId: string): DetectedPlatform {
  const def = getPlatform(platformId);
  return {
    platform: def.id,
    configPath: def.configPath(),
    rulesPath: def.rulesPath ? def.rulesPath() : null,
    skillsPath: def.skillsPath ? def.skillsPath() : null,
    existingMcp: null,
    rootKey: def.rootKey,
    configFormat: def.configFormat,
  };
}

// ─── Broker capability accessors ────────────────────────────
// Thin wrappers so broker code (Packages 02-05) doesn't have to reach
// into optional nested fields with `?.` ladders. All return safe baseline
// values (false / undefined) when capabilities aren't declared.

/**
 * Returns the platform's declared broker capabilities, or an
 * all-baseline (broker-unsupported) object when the platform hasn't
 * declared any. Never returns undefined — keeps callers branch-free.
 */
export function getBrokerCapabilities(id: string): Required<PlatformBrokerCapabilities> {
  const caps = PLATFORM_REGISTRY.get(id)?.brokerCapabilities ?? {};
  return {
    supportsBroker: caps.supportsBroker ?? false,
    supportsStdioShim: caps.supportsStdioShim ?? false,
    supportsLoopbackHttp: caps.supportsLoopbackHttp ?? false,
    oauthDiscoveryProbing: caps.oauthDiscoveryProbing ?? false,
    mcpNeedsAuthRecovery: caps.mcpNeedsAuthRecovery ?? false,
  };
}

/**
 * Top-level broker support check. False for any platform that hasn't
 * declared brokerCapabilities.supportsBroker. Use this as the gate before
 * attempting any broker-mode work.
 */
export function platformSupportsBroker(id: string): boolean {
  return getBrokerCapabilities(id).supportsBroker;
}

/**
 * Returns the platform's broker strategy hooks, or undefined if the
 * platform has no overrides. Callers MUST treat individual hook
 * undefined-ness as "use baseline behavior" — see PlatformBrokerStrategy.
 */
export function getBrokerStrategy(id: string): PlatformBrokerStrategy | undefined {
  return PLATFORM_REGISTRY.get(id)?.brokerStrategy;
}

// ─── Backward-compat path exports ───────────────────────────

export function getVsCodeUserDir(): string { return vsCodeUserDir(); }
export function getVsCodeMcpPath(): string { return PLATFORM_REGISTRY.get("vscode")!.configPath(); }
export function getClineConfigPath(): string { return PLATFORM_REGISTRY.get("cline")!.configPath(); }
export function getRooConfigPath(): string { return PLATFORM_REGISTRY.get("roo-code")!.configPath(); }
export function getCodexConfigPath(): string { return PLATFORM_REGISTRY.get("codex")!.configPath(); }
export function getGeminiSettingsPath(): string { return PLATFORM_REGISTRY.get("gemini-cli")!.configPath(); }
export function getJunieMcpPath(): string { return PLATFORM_REGISTRY.get("junie")!.configPath(); }
export function getCopilotJetBrainsMcpPath(): string { return PLATFORM_REGISTRY.get("copilot-jetbrains")!.configPath(); }
export function getCopilotCliMcpPath(): string { return PLATFORM_REGISTRY.get("copilot-cli")!.configPath(); }
