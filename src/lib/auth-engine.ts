// Auth engine — resolves credentials for direct-mode tools.
// Handles api_key prompts, OAuth PKCE browser flow, and OAuth-to-API-key exchange.
// Async (HTTP requests, localhost server). The Equip library stays sync.
// Zero non-Node dependencies.

import * as fs from "fs";
import { atomicWriteFileSync } from "./fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import * as crypto from "crypto";
import * as child_process from "child_process";
import type { EquipLogger } from "./types";
import { NOOP_LOGGER } from "./types";
import * as cli from "./cli";

// ─── Types ─────────────────────────────────────────────────

export interface AuthConfig {
  type: "none" | "api_key" | "oauth" | "oauth_to_api_key" | "oidc";

  /**
   * Identity provider for this augment's OAuth flow.
   * - "cg3": uses the CG3 platform as the OAuth server — eligible for session-assisted auth
   * - "github", "google": recognized third-party providers (future: may support token exchange)
   * - "custom": augment runs its own OAuth server, no SSO possible
   *
   * When omitted, detected from oauth.authorizeUrl hostname.
   * Future: session-assisted auth will use this to skip browser OAuth when the user
   * is already logged into Equip with a compatible provider.
   */
  provider?: "cg3" | "github" | "google" | "custom";

  keyEnvVar?: string;
  keyPrefix?: string;
  keyPrompt?: string;
  keyHelpUrl?: string;
  validationUrl?: string;
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes?: string[];
  };
  keyExchange?: {
    url: string;
    method: "POST";
    tokenHeader: string;
    body?: Record<string, unknown>;
    keyPath: string;
    conflictCode?: string;
    conflictResolution?: "regenerate" | "prompt";
    regenerateBody?: Record<string, unknown>;

    /**
     * Whether this key exchange endpoint accepts delegated CG3 session tokens.
     * When true and the user has a valid Equip session, the auth engine will
     * attempt session-assisted auth (skip browser OAuth) by sending the Equip
     * session token directly to this endpoint.
     *
     * Only meaningful when provider is "cg3" or the OAuth server is the CG3 platform.
     * Third-party augment authors who use CG3 as their identity provider can
     * set this to true to enable automatic SSO for their users.
     *
     * Future: not yet implemented. Currently all auth goes through the full
     * browser OAuth flow regardless of this flag.
     */
    acceptsCg3Token?: boolean;
  };
}

export interface StoredCredential {
  authType: string;
  credential: string;
  keyPrefix?: string;
  oauth?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    tokenUrl: string;
    clientId: string;
  };
  toolName: string;
  storedAt: string;
  updatedAt: string;
}

export interface AuthResolveOptions {
  toolName: string;
  auth: AuthConfig;
  logger?: EquipLogger;
  apiKey?: string | null;
  nonInteractive?: boolean;
  dryRun?: boolean;
  /** Equip session for CG3 OIDC delegated auth. Provided by the sidecar bridge. */
  session?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    tokenUrl: string;
    clientId: string;
  };
}

export interface AuthResult {
  credential: string | null;
  method: string;
  error?: string;
}

// ─── Paths ─────────────────────────────────────────────────

// Resolve dynamically so tests can override via EQUIP_HOME (see ENG-0031).
import { getEquipHome } from "./equip-home";
function getCredentialsDir(): string { return path.join(getEquipHome(), "credentials"); }

function credentialPath(toolName: string): string {
  return path.join(getCredentialsDir(), `${toolName}.json`);
}

// ─── Credential Storage ────────────────────────────────────

export function readStoredCredential(toolName: string): StoredCredential | null {
  try {
    const raw = fs.readFileSync(credentialPath(toolName), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeStoredCredential(cred: StoredCredential): void {
  if (!fs.existsSync(getCredentialsDir())) {
    fs.mkdirSync(getCredentialsDir(), { recursive: true });
  }
  const p = credentialPath(cred.toolName);
  atomicWriteFileSync(p, JSON.stringify(cred, null, 2));
  hardenCredentialPermissions(p);
  ensureEquipGitignore();
}

/** Restrict file permissions to current user only. */
function hardenCredentialPermissions(filePath: string): void {
  if (process.platform === "win32") {
    // Windows: restrict to current user via icacls
    try {
      child_process.execSync(`icacls "${filePath}" /inheritance:r /grant:r "%USERNAME%:F"`, { stdio: "ignore", shell: "cmd.exe" });
    } catch {}
  } else {
    try { fs.chmodSync(filePath, 0o600); } catch {}
    try { fs.chmodSync(getCredentialsDir(), 0o700); } catch {}
  }
}

/** Create a .gitignore in ~/.equip/ to prevent accidental credential commits. */
function ensureEquipGitignore(): void {
  const gitignorePath = path.join(getEquipHome(), ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    try {
      fs.writeFileSync(gitignorePath, "# Prevent accidental credential commits\ncredentials/\nsession.json\ncache/\n*.tmp\n");
    } catch { /* best effort */ }
  } else {
    // Ensure session.json is covered in existing gitignore
    try {
      const content = fs.readFileSync(gitignorePath, "utf-8");
      if (!content.includes("session.json")) {
        fs.writeFileSync(gitignorePath, content.trimEnd() + "\nsession.json\n");
      }
    } catch { /* best effort */ }
  }
}

export function deleteStoredCredential(toolName: string): void {
  try { fs.unlinkSync(credentialPath(toolName)); } catch {}
}

/**
 * List all stored credential tool names.
 */
export function listStoredCredentials(): string[] {
  try {
    return fs.readdirSync(getCredentialsDir())
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

// ─── Credential Validation ──────────────────────────────────

/**
 * Validate a credential against a tool's validation URL.
 * Returns true if the URL returns 2xx with the credential as Bearer token.
 * Returns false on 401/403. Returns null if no validationUrl or network error.
 */
export async function validateCredential(
  credential: string,
  auth: AuthConfig,
  logger: EquipLogger = NOOP_LOGGER,
): Promise<{ valid: boolean | null; detail?: string }> {
  if (!auth.validationUrl) {
    return { valid: null, detail: "No validation URL configured" };
  }

  try {
    logger.debug("Validating credential", { url: auth.validationUrl });
    const res = await fetch(auth.validationUrl, {
      headers: {
        Authorization: `Bearer ${credential}`,
        "User-Agent": "equip",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      logger.info("Credential validated");
      return { valid: true };
    }

    if (res.status === 401 || res.status === 403) {
      logger.warn("Credential validation failed", { status: res.status });
      return { valid: false, detail: `Validation returned ${res.status}` };
    }

    // Other status codes — don't treat as auth failure
    logger.debug("Validation returned unexpected status", { status: res.status });
    return { valid: null, detail: `Validation returned ${res.status}` };
  } catch (e: unknown) {
    logger.debug("Validation request failed", { error: (e as Error).message });
    return { valid: null, detail: `Network error: ${(e as Error).message}` };
  }
}

// ─── Token Expiry ──────────────────────────────────────────

/**
 * Check if a stored credential's OAuth token is expired.
 * Returns true if:
 * - The credential has an expiresAt field and it's in the past
 * - The access token is a JWT with an expired exp claim
 * Returns false if no expiry information is available.
 */
export function isCredentialExpired(cred: StoredCredential): boolean {
  if (!cred.oauth) return false;

  // Check explicit expiresAt field
  if (cred.oauth.expiresAt) {
    const expiresAt = new Date(cred.oauth.expiresAt).getTime();
    if (expiresAt < Date.now()) return true;
  }

  // Check JWT exp claim in access token
  if (cred.oauth.accessToken) {
    const parts = cred.oauth.accessToken.split(".");
    if (parts.length === 3) {
      try {
        const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
        const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
        if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
          return true;
        }
      } catch { /* can't decode — assume not expired */ }
    }
  }

  return false;
}

// ─── Token Refresh ─────────────────────────────────────────

export interface RefreshResult {
  success: boolean;
  newAccessToken?: string;
  error?: string;
  configsUpdated?: number;
}

/**
 * Refresh an expired OAuth credential.
 * - For 'oauth' type: refreshes access token + updates platform MCP configs.
 * - For 'oauth_to_api_key': refreshes OAuth tokens (API key stays the same).
 * - For other types: returns { success: false, error }.
 */
export async function refreshCredential(
  toolName: string,
  options: { logger?: EquipLogger; updateConfigs?: boolean } = {},
): Promise<RefreshResult> {
  const logger = options.logger || NOOP_LOGGER;
  const cred = readStoredCredential(toolName);

  if (!cred) {
    return { success: false, error: `No stored credential for ${toolName}` };
  }

  if (!cred.oauth?.refreshToken) {
    return { success: false, error: `No refresh token stored for ${toolName}` };
  }

  if (!cred.oauth.tokenUrl || !cred.oauth.clientId) {
    return { success: false, error: `Missing tokenUrl or clientId for ${toolName}` };
  }

  logger.info("Refreshing OAuth token", { toolName, tokenUrl: cred.oauth.tokenUrl });

  try {
    const res = await fetch(cred.oauth.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: cred.oauth.refreshToken,
        client_id: cred.oauth.clientId,
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json() as Record<string, unknown>;

    if (!data.access_token) {
      const errMsg = (data.error_description || data.error || "No access_token in response") as string;
      logger.error("Token refresh failed", { error: errMsg });
      return { success: false, error: `Refresh failed: ${errMsg}` };
    }

    const newAccessToken = data.access_token as string;
    const newRefreshToken = (data.refresh_token as string) || cred.oauth.refreshToken;
    const expiresIn = data.expires_in as number | undefined;
    const newExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : undefined;

    // Update stored credential
    cred.oauth.accessToken = newAccessToken;
    cred.oauth.refreshToken = newRefreshToken;
    cred.oauth.expiresAt = newExpiresAt;
    cred.updatedAt = new Date().toISOString();

    // For 'oauth' type, the access token IS the credential written to configs
    if (cred.authType === "oauth") {
      cred.credential = newAccessToken;
    }

    writeStoredCredential(cred);
    logger.info("OAuth token refreshed", { toolName, expiresAt: newExpiresAt });

    // Update platform configs if this is an 'oauth' type (token directly in config)
    let configsUpdated = 0;
    if (cred.authType === "oauth" && options.updateConfigs !== false) {
      configsUpdated = updatePlatformConfigs(toolName, newAccessToken, logger);
    }

    return { success: true, newAccessToken, configsUpdated };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("Token refresh error", { toolName, error: msg });
    return { success: false, error: `Refresh error: ${msg}` };
  }
}

/**
 * Scan all stored credentials and refresh any with expired OAuth tokens.
 * Returns a map of tool name → RefreshResult for any tools that were refreshed.
 */
export async function refreshAllExpired(
  options: { logger?: EquipLogger } = {},
): Promise<Map<string, RefreshResult>> {
  const logger = options.logger || NOOP_LOGGER;
  const results = new Map<string, RefreshResult>();
  const tools = listStoredCredentials();

  for (const toolName of tools) {
    const cred = readStoredCredential(toolName);
    if (!cred || !cred.oauth?.refreshToken) continue;
    if (!isCredentialExpired(cred)) continue;

    logger.info("Auto-refreshing expired token", { toolName });
    const result = await refreshCredential(toolName, { logger, updateConfigs: true });
    results.set(toolName, result);
  }

  return results;
}

/**
 * Update MCP config entries across all detected platforms for a tool.
 * Used when the credential (access token) changes via refresh.
 */
function updatePlatformConfigs(toolName: string, newToken: string, logger: EquipLogger): number {
  try {
    // Import dynamically to avoid circular dependency
    const { detectPlatforms } = require("./detect");
    const { readMcpEntry } = require("./mcp");
    const { buildHttpConfigWithAuth } = require("./mcp");
    const { installMcp } = require("./mcp");

    const platforms = detectPlatforms(toolName);
    let updated = 0;

    for (const p of platforms) {
      const entry = readMcpEntry(p.configPath, p.rootKey, toolName, p.configFormat || "json");
      if (!entry) continue;

      // Extract server URL from existing config
      const serverUrl = (entry as Record<string, unknown>).url
        || (entry as Record<string, unknown>).serverUrl
        || (entry as Record<string, unknown>).httpUrl;
      if (!serverUrl || typeof serverUrl !== "string") continue;

      const newConfig = buildHttpConfigWithAuth(serverUrl, newToken, p.platform);
      installMcp(p, toolName, newConfig, { logger });
      updated++;
    }

    if (updated > 0) {
      logger.info("Platform configs updated with refreshed token", { toolName, platforms: updated });
    }
    return updated;
  } catch (e: unknown) {
    logger.warn("Failed to update platform configs", { toolName, error: (e as Error).message });
    return 0;
  }
}

// ─── Main Resolve Function ─────────────────────────────────

/**
 * Resolve a credential for a tool. Resolution order:
 * 1. --api-key flag (explicit)
 * 2. Stored credential (~/.equip/credentials/)
 * 3. Environment variable
 * 4. Run auth flow (prompt, OAuth, key exchange)
 */
export async function resolveAuth(options: AuthResolveOptions): Promise<AuthResult> {
  const { toolName, auth, logger = NOOP_LOGGER, nonInteractive = false, dryRun = false } = options;
  const isCg3OidcAuth = auth.type === "oidc";

  if (auth.type === "none") {
    return { credential: null, method: "none" };
  }

  // 1. Explicit --api-key flag
  if (options.apiKey) {
    logger.info("Using API key from --api-key flag");
    if (!dryRun) storeApiKey(toolName, options.apiKey, auth);
    return { credential: options.apiKey, method: "flag" };
  }

  // 2. Stored credential
  const stored = readStoredCredential(toolName);
  if (stored?.credential) {
    // For CG3 delegated auth, check if the delegated access token is expired before reusing it.
    if (isCg3OidcAuth && isJwtExpired(stored.credential)) {
      logger.info("Stored delegated access token expired, refreshing", { toolName });
      // Fall through to auth flow below
    } else {
      logger.info("Using stored credential", { toolName });
      return { credential: stored.credential, method: "stored" };
    }
  }

  // 3. Environment variable
  if (auth.keyEnvVar && process.env[auth.keyEnvVar]) {
    const key = process.env[auth.keyEnvVar]!;
    logger.info(`Using credential from $${auth.keyEnvVar}`);
    if (!dryRun) storeApiKey(toolName, key, auth);
    return { credential: key, method: "env" };
  }

  // 4. Run auth flow based on type
  switch (auth.type) {
    case "api_key":
      return resolveApiKey(toolName, auth, logger, nonInteractive, dryRun);
    case "oauth":
      return resolveOAuth(toolName, auth, logger, nonInteractive, dryRun);
    case "oauth_to_api_key":
      return resolveOAuthToApiKey(toolName, auth, logger, nonInteractive, dryRun);
    case "oidc":
      return resolveOidc(toolName, logger, nonInteractive, dryRun, options.session);
    default:
      return { credential: null, method: "unknown", error: `Unknown auth type: ${auth.type}` };
  }
}

// ─── CG3 OIDC Delegated Auth Flow ─────────────────────────

// Override only allowed in test mode to prevent credential redirect attacks in production.
// Gate mirrors equip-app/sidecar/session.ts — unified test-mode signal across both files.
// Production builds must strip these env vars at launch (tracked in Phase 1 deferred items).
const IDENTITY_TEST_MODE_OK = process.env.NODE_ENV === "development" || process.env.EQUIP_TEST_MODE === "1";
const IDENTITY_TOKEN_URL = (IDENTITY_TEST_MODE_OK && process.env.EQUIP_IDENTITY_URL)
  || "https://api.cg3.io";

/** Check if a JWT string is expired (decode payload without verification). */
function isJwtExpired(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
    if (typeof payload.exp === "number") {
      return payload.exp < Math.floor(Date.now() / 1000);
    }
  } catch { /* can't decode */ }
  return false;
}

// `isJwtExpiringSoon` removed 2026-04-27 — was only used by the
// retired `refreshOidcTokens`. Broker has its own JWT exp decoder
// in CredentialManager.expiryOf.

async function resolveOidc(
  toolName: string,
  logger: EquipLogger,
  nonInteractive: boolean,
  dryRun: boolean,
  session?: AuthResolveOptions["session"],
): Promise<AuthResult> {
  // Try reading session from disk if not provided
  if (!session) {
    try {
      const sessionPath = path.join(getEquipHome(), "app", "session.json");
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.accessToken && parsed?.refreshToken && parsed?.expiresAt) {
        session = {
          accessToken: parsed.accessToken,
          refreshToken: parsed.refreshToken,
          expiresAt: parsed.expiresAt,
          tokenUrl: parsed.tokenUrl || "https://api.cg3.io/token",
          clientId: parsed.clientId || "equip-desktop",
        };
      }
    } catch { /* no session file */ }
  }

  if (!session) {
    return { credential: null, method: "oidc", error: "Not logged into Equip. Run 'equip login' first." };
  }

  // If the session token is expired:
  // 1. Try re-reading from disk (the sidecar/bridge may have already refreshed it)
  // 2. If still expired, attempt an inline refresh (for CLI callers without a sidecar)
  if (isJwtExpired(session.accessToken)) {
    logger.info("Session token expired, re-reading from disk");
    let refreshed = false;
    try {
      const sessionPath = path.join(getEquipHome(), "app", "session.json");
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.accessToken && !isJwtExpired(parsed.accessToken)) {
        session.accessToken = parsed.accessToken;
        if (parsed.refreshToken) session.refreshToken = parsed.refreshToken;
        if (parsed.expiresAt) session.expiresAt = parsed.expiresAt;
        refreshed = true;
      }
    } catch { /* disk read failed */ }

    // Fallback: inline refresh for CLI callers (no sidecar running)
    if (!refreshed && session.refreshToken) {
      logger.info("Attempting inline session refresh");
      try {
        const refreshRes = await fetch(session.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: session.refreshToken,
            client_id: session.clientId,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json() as any;
          session.accessToken = data.access_token;
          if (data.refresh_token) session.refreshToken = data.refresh_token;
          session.expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
          // Write refreshed session to disk so other callers benefit
          try {
            const sessionPath = path.join(getEquipHome(), "app", "session.json");
            const existing = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
            existing.accessToken = session.accessToken;
            if (data.refresh_token) existing.refreshToken = session.refreshToken;
            existing.expiresAt = session.expiresAt;
            existing.updatedAt = new Date().toISOString();
            atomicWriteFileSync(sessionPath, JSON.stringify(existing, null, 2));
          } catch { /* best effort */ }
          refreshed = true;
        }
      } catch { /* refresh failed */ }
    }

    if (!refreshed) {
      return { credential: null, method: "oidc", error: "Session expired. Please log in again." };
    }
  }

  if (dryRun) {
    logger.info("[dry-run] Would request delegated OIDC access token", { toolName });
    return { credential: "dry-run-oidc-access-token", method: "oidc" };
  }

  const allowConsentAcceptance = !nonInteractive;
  const requestDelegatedToken = async (): Promise<{ token?: string; needsConsent?: boolean; error?: string }> => {
    try {
      const form = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        client_id: session!.clientId || "equip-desktop",
        audience: toolName,
        subject_token: session!.accessToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        scope: "identity:read",
      });
      if (allowConsentAcceptance) {
        form.set("consent_action", "accept");
      }
      const res = await fetch(`${IDENTITY_TOKEN_URL}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json() as any;
      if (!body.access_token) {
        const description = body.error_description || body.error || `HTTP ${res.status}`;
        return {
          needsConsent: description === "consent_required" || description === "grant_acceptance_required",
          error: description,
        };
      }
      return { token: body.access_token as string };
    } catch (e: any) {
      return { error: e.message };
    }
  };

  // Request delegated access token from CG3. Interactive equip/install may atomically
  // accept consent in the token-exchange call, but background refresh must never do so.
  try {
    const delegated = await requestDelegatedToken();
    if (!delegated.token) {
      return { credential: null, method: "oidc", error: `Failed to obtain access token: ${delegated.error || "Unknown error"}` };
    }

    const accessToken = delegated.token;

    // Store only the delegated access token — NOT the session tokens.
    // Session refresh tokens are sensitive and should only live in session.json.
    // refreshOidcTokens() reads the session from disk when it needs to refresh.
    writeStoredCredential({
      authType: "oidc",
      credential: accessToken,
      toolName,
      storedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    logger.info("Delegated OIDC access token obtained", { toolName });
    return { credential: accessToken, method: "oidc" };
  } catch (e: any) {
    return { credential: null, method: "oidc", error: `Access token request failed: ${e.message}` };
  }
}

// `refreshOidcTokens` and `updatePlatformConfigs` were retired here
// 2026-04-27 with the legacy identity-refresh-daemon. The broker is now
// the canonical refresh authority (`equip-app/sidecar/broker/`). MCP
// config rewriting moves to per-platform writers in
// equip-mcp-login-continuity-gate Pkg 04 + Pkg 05.
//
// `resolveOidc` (the immediate-acquire path used by the install command)
// still lives here — it's not refresh, it's first-time grant.

// ─── API Key Flow ─────────────────────────────────────────��

async function resolveApiKey(
  toolName: string, auth: AuthConfig, logger: EquipLogger,
  nonInteractive: boolean, dryRun: boolean,
): Promise<AuthResult> {
  if (nonInteractive) {
    return { credential: null, method: "api_key", error: `${toolName} requires an API key. Use --api-key or set ${auth.keyEnvVar || "the key"}` };
  }

  if (auth.keyHelpUrl) {
    cli.log(`  Get a key at: ${auth.keyHelpUrl}`);
  }

  const promptText = auth.keyPrompt || `Enter your ${toolName} API key`;
  const key = await cli.promptSecret(`  ${promptText}: `);

  if (!key) {
    return { credential: null, method: "api_key", error: "No API key provided" };
  }

  if (auth.keyPrefix && !key.startsWith(auth.keyPrefix)) {
    cli.warn(`Key doesn't start with expected prefix "${auth.keyPrefix}" — using it anyway`);
  }

  if (!dryRun) storeApiKey(toolName, key, auth);
  logger.info("API key obtained via prompt");
  return { credential: key, method: "prompt" };
}

// ─── OAuth Browser Flow ────────────────────────────────────

async function resolveOAuth(
  toolName: string, auth: AuthConfig, logger: EquipLogger,
  nonInteractive: boolean, dryRun: boolean,
): Promise<AuthResult> {
  if (!auth.oauth) {
    return { credential: null, method: "oauth", error: "OAuth config missing from tool definition" };
  }

  if (nonInteractive) {
    return { credential: null, method: "oauth", error: "OAuth requires a browser. Use --api-key in non-interactive mode." };
  }

  logger.info("Starting OAuth browser flow", { authorizeUrl: auth.oauth.authorizeUrl });
  const tokens = await oauthBrowserFlow(auth.oauth, logger);

  if (!tokens) {
    return { credential: null, method: "oauth", error: "OAuth flow did not complete" };
  }

  // For pure OAuth, the access token IS the credential
  if (!dryRun) {
    writeStoredCredential({
      authType: "oauth",
      credential: tokens.accessToken,
      toolName,
      oauth: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        tokenUrl: auth.oauth.tokenUrl,
        clientId: auth.oauth.clientId,
      },
      storedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  logger.info("OAuth tokens obtained");
  return { credential: tokens.accessToken, method: "oauth" };
}

// ─── OAuth-to-API-Key Flow ─────────────────────────────────

async function resolveOAuthToApiKey(
  toolName: string, auth: AuthConfig, logger: EquipLogger,
  nonInteractive: boolean, dryRun: boolean,
): Promise<AuthResult> {
  if (!auth.oauth || !auth.keyExchange) {
    return { credential: null, method: "oauth_to_api_key", error: "OAuth or keyExchange config missing from tool definition" };
  }

  // Check if we have stored OAuth tokens we can reuse for key exchange
  const stored = readStoredCredential(toolName);
  let accessToken: string | null = stored?.oauth?.accessToken || null;

  // If no stored token (or expired), run OAuth browser flow
  if (!accessToken) {
    if (nonInteractive) {
      return { credential: null, method: "oauth_to_api_key", error: "OAuth requires a browser. Use --api-key in non-interactive mode." };
    }

    logger.info("No stored OAuth token, starting browser flow");
    const tokens = await oauthBrowserFlow(auth.oauth, logger);
    if (!tokens) {
      return { credential: null, method: "oauth_to_api_key", error: "OAuth flow did not complete" };
    }
    accessToken = tokens.accessToken;

    // Store the OAuth tokens (even before key exchange, for reuse)
    if (!dryRun) {
      writeStoredCredential({
        authType: "oauth_to_api_key",
        credential: "", // Will be filled after key exchange
        toolName,
        oauth: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          tokenUrl: auth.oauth.tokenUrl,
          clientId: auth.oauth.clientId,
        },
        storedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  // Exchange OAuth token for API key
  logger.info("Exchanging OAuth token for API key", { url: auth.keyExchange.url });
  const exchangeResult = await exchangeTokenForKey(accessToken, auth.keyExchange, logger, nonInteractive);

  if (!exchangeResult.key) {
    return { credential: null, method: "oauth_to_api_key", error: exchangeResult.error || "Key exchange failed" };
  }

  // Store the final API key
  if (!dryRun) {
    const existing = readStoredCredential(toolName);
    writeStoredCredential({
      ...(existing || { storedAt: new Date().toISOString() }),
      authType: "oauth_to_api_key",
      credential: exchangeResult.key,
      keyPrefix: auth.keyPrefix,
      toolName,
      updatedAt: new Date().toISOString(),
    } as StoredCredential);
  }

  logger.info("API key obtained via OAuth + key exchange");
  return { credential: exchangeResult.key, method: "oauth_to_api_key" };
}

// ─── OAuth Browser Flow (PKCE) ─────────────────────────────

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

/**
 * Browser opener function type. Called with the authorize URL.
 * Returns an optional cleanup function to close the browser after auth completes.
 */
export type BrowserOpener = (url: string) => (() => void) | void;

export async function oauthBrowserFlow(
  oauthConfig: NonNullable<AuthConfig["oauth"]>,
  logger: EquipLogger,
  options?: { provider?: string; openBrowser?: BrowserOpener },
): Promise<OAuthTokens | null> {
  let closeBrowserFn: (() => void) | null = null;
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");
  // Sent unconditionally — backend requires it when `openid` is in scope (OIDC),
  // and tolerates it otherwise. Saves us parsing scope strings client-side.
  const nonce = crypto.randomBytes(16).toString("hex");

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://localhost");

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(callbackPageHtml("error", "OAuth state mismatch. Please try again."));
        logger.error("OAuth state mismatch");
        cleanup();
        resolve(null);
        return;
      }

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(callbackPageHtml("error", `Authentication denied: ${error}`));
        logger.error("OAuth denied", { error });
        cleanup();
        resolve(null);
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(callbackPageHtml("error", "No authorization code received."));
        cleanup();
        resolve(null);
        return;
      }

      // Exchange code for tokens
      try {
        const port = (server.address() as { port: number }).port;
        const tokenRes = await fetch(oauthConfig.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: `http://127.0.0.1:${port}/callback`,
            code_verifier: codeVerifier,
            client_id: oauthConfig.clientId,
          }).toString(),
        });
        const contentType = tokenRes.headers.get("content-type") || "";
        if (!contentType.includes("json")) {
          const body = await tokenRes.text().catch(() => "");
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(callbackPageHtml("error", `Token endpoint returned ${contentType || "unknown content-type"}`));
          logger.error("Token exchange returned non-JSON", { status: tokenRes.status, contentType, body: body.slice(0, 200) });
          cleanup();
          resolve(null);
          return;
        }
        const tokenData = await tokenRes.json() as Record<string, unknown>;

        if (tokenData.access_token) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(callbackPageHtml("success", "Authenticated successfully. You can close this window."));
          logger.info("OAuth tokens received");
          cleanup();
          if (closeBrowserFn) closeBrowserFn();
          resolve({
            accessToken: tokenData.access_token as string,
            refreshToken: tokenData.refresh_token as string | undefined,
            expiresAt: tokenData.expires_in
              ? new Date(Date.now() + (tokenData.expires_in as number) * 1000).toISOString()
              : undefined,
          });
        } else {
          const errMsg = (tokenData.error_description || tokenData.error || "Unknown error") as string;
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(callbackPageHtml("error", errMsg));
          logger.error("Token exchange failed", { error: errMsg });
          cleanup();
          resolve(null);
        }
      } catch (e: unknown) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(callbackPageHtml("error", (e as Error).message));
        logger.error("Token exchange error", { error: (e as Error).message });
        cleanup();
        resolve(null);
      }
    });

    let timeout: ReturnType<typeof setTimeout>;

    function cleanup() {
      clearTimeout(timeout);
      // server.close() stops accepting new connections but lets in-flight
      // responses finish delivering. No need for closeAllConnections().
      server.close();
    }

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const params = new URLSearchParams({
        response_type: "code",
        client_id: oauthConfig.clientId,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        nonce,
      });
      if (oauthConfig.scopes) params.set("scope", oauthConfig.scopes.join(" "));
      if (options?.provider) params.set("provider", options.provider);

      const authorizeUrl = `${oauthConfig.authorizeUrl}?${params.toString()}`;

      cli.log("  Opening browser for authentication...");
      cli.log(`  If the browser doesn't open, visit:\n  ${authorizeUrl}`);

      const opener = options?.openBrowser || defaultOpenBrowser;
      closeBrowserFn = opener(authorizeUrl) || null;
    });

    // 3-minute timeout
    timeout = setTimeout(() => {
      logger.warn("OAuth flow timed out");
      cli.warn("Authentication timed out after 3 minutes");
      cleanup();
      if (closeBrowserFn) closeBrowserFn();
      resolve(null);
    }, 3 * 60 * 1000);
    timeout.unref();
  });
}

// ─── Key Exchange ──────────────────────────────────────────

interface KeyExchangeResult {
  key: string | null;
  error?: string;
}

async function exchangeTokenForKey(
  accessToken: string,
  config: NonNullable<AuthConfig["keyExchange"]>,
  logger: EquipLogger,
  nonInteractive: boolean,
): Promise<KeyExchangeResult> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    headers[config.tokenHeader] = `Bearer ${accessToken}`;

    const res = await fetch(config.url, {
      method: config.method,
      headers,
      body: JSON.stringify(config.body || {}),
    });

    const data = await res.json() as Record<string, unknown>;

    if (res.ok) {
      const key = getNestedValue(data, config.keyPath);
      if (key && typeof key === "string") {
        return { key };
      }
      return { key: null, error: `Key not found at path "${config.keyPath}" in response` };
    }

    // Handle conflict (e.g., KEY_EXISTS)
    const errorData = data as { error?: { code?: string; message?: string } };
    if (config.conflictCode && errorData.error?.code === config.conflictCode) {
      logger.warn("Key conflict detected", { code: config.conflictCode });

      if (config.conflictResolution === "regenerate" || nonInteractive || !process.stdin.isTTY) {
        // Auto-regenerate
        return exchangeTokenForKey(accessToken, {
          ...config,
          body: config.regenerateBody || { regenerate: true },
          conflictCode: undefined, // Don't recurse on conflict again
        }, logger, nonInteractive);
      }

      if (config.conflictResolution === "prompt") {
        cli.log("\n  An API key already exists for this account.");
        cli.log("    [1] Generate a fresh key (old key will stop working)");
        cli.log("    [2] Enter your existing key");
        const choice = await cli.prompt("  Choice [1]: ");

        if (choice === "2") {
          const manual = await cli.promptSecret("  Paste your API key: ");
          if (manual) return { key: manual };
          return { key: null, error: "No key provided" };
        }

        // Regenerate
        return exchangeTokenForKey(accessToken, {
          ...config,
          body: config.regenerateBody || { regenerate: true },
          conflictCode: undefined,
        }, logger, nonInteractive);
      }
    }

    return { key: null, error: `Key exchange failed (${res.status}): ${errorData.error?.message || JSON.stringify(data)}` };
  } catch (e: unknown) {
    return { key: null, error: `Key exchange error: ${(e as Error).message}` };
  }
}

// ─── Helpers ───────────────────────────────────────────────

function storeApiKey(toolName: string, key: string, auth: AuthConfig): void {
  writeStoredCredential({
    authType: "api_key",
    credential: key,
    keyPrefix: auth.keyPrefix,
    toolName,
    storedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/** Navigate a dot-notation path into an object. "data.apiKey" → obj.data.apiKey */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce((current: unknown, key) => {
    if (current && typeof current === "object") return (current as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/** Default browser opener for CLI — opens the system default browser. */
function defaultOpenBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      // OAuth URLs contain `&` query separators which `cmd.exe` parses as
      // command separators unless the URL is quoted in the FINAL command line
      // (Node's argv-array quoting is stripped before cmd re-parses). Solution:
      // (1) build the cmd /c string ourselves with the URL wrapped in double
      // quotes (escape any literal " in the URL by doubling it per cmd rules),
      // (2) use windowsVerbatimArguments so Node passes the line through
      // unmodified to CreateProcess. The `""` first arg to `start` is the
      // window title — required, otherwise start interprets the URL as the
      // title. Using `start` (not rundll32) preserves the "new window" launch
      // semantics; rundll32 routes through Chrome IPC and opens a new tab.
      const escapedUrl = url.replace(/"/g, '""');
      child_process.spawn(
        "cmd.exe",
        ["/d", "/s", "/c", `start "" "${escapedUrl}"`],
        { stdio: "ignore", windowsVerbatimArguments: true, detached: true },
      ).unref();
    } else if (process.platform === "darwin") {
      child_process.spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      child_process.spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {}
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function callbackPageHtml(status: string, message: string): string {
  const isSuccess = status === "success";
  const title = isSuccess ? "Authentication Successful" : "Authentication Failed";
  const color = isSuccess ? "#34d399" : "#f87171";
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${safeTitle}</title>
<style>
body{font-family:system-ui,sans-serif;background:#0a0b10;color:#e8eaf0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:400px;text-align:center;padding:40px;background:#12141f;border:1px solid #1e2030;border-radius:12px}
h1{font-size:1.25rem;margin:16px 0 8px;color:${color}}
p{color:#8890a8;font-size:0.875rem;line-height:1.6}
</style></head><body>
<div class="card">
<h1>${safeTitle}</h1>
<p>${safeMessage}</p>
</div>${isSuccess ? "<script>setTimeout(function(){window.close()},1000)</script>" : ""}</body></html>`;
}
