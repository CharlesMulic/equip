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
import type { EquipLogger } from "./types";
import { NOOP_LOGGER } from "./types";
import * as cli from "./cli";

// ─── Types ─────────────────────────────────────────────────

export interface AuthConfig {
  type: "none" | "api_key" | "oauth" | "oauth_to_api_key";
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
}

export interface AuthResult {
  credential: string | null;
  method: string;
  error?: string;
}

// ─── Paths ─────────────────────────────────────────────────

// Resolve dynamically so tests can override os.homedir()
function getEquipDir(): string { return path.join(os.homedir(), ".equip"); }
function getCredentialsDir(): string { return path.join(getEquipDir(), "credentials"); }

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
  // On Unix: chmod 600 for files, 700 for directories — standard practice.
  // On Windows: rely on default user directory ACLs (user profile dirs already
  // restrict access to the user + SYSTEM + Administrators). Attempting to modify
  // ACLs via icacls from Node is fragile and has caused files to become inaccessible.
  if (process.platform !== "win32") {
    try { fs.chmodSync(filePath, 0o600); } catch {}
    try { fs.chmodSync(getCredentialsDir(), 0o700); } catch {}
  }
}

/** Create a .gitignore in ~/.equip/ to prevent accidental credential commits. */
function ensureEquipGitignore(): void {
  const gitignorePath = path.join(getEquipDir(), ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    try {
      fs.writeFileSync(gitignorePath, "# Prevent accidental credential commits\ncredentials/\ncache/\n*.tmp\n");
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
    logger.info("Using stored credential", { toolName });
    return { credential: stored.credential, method: "stored" };
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
    default:
      return { credential: null, method: "unknown", error: `Unknown auth type: ${auth.type}` };
  }
}

// ─── API Key Flow ──────────────────────────────────────────

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

interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

async function oauthBrowserFlow(
  oauthConfig: NonNullable<AuthConfig["oauth"]>,
  logger: EquipLogger,
): Promise<OAuthTokens | null> {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

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
        const tokenData = await tokenRes.json() as Record<string, unknown>;

        if (tokenData.access_token) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(callbackPageHtml("success", "Authenticated successfully. You can close this window."));
          logger.info("OAuth tokens received");
          cleanup();
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
      try { server.closeAllConnections(); } catch {}
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
      });
      if (oauthConfig.scopes) params.set("scope", oauthConfig.scopes.join(" "));

      const authorizeUrl = `${oauthConfig.authorizeUrl}?${params.toString()}`;

      cli.log("  Opening browser for authentication...");
      cli.log(`  If the browser doesn't open, visit:\n  ${authorizeUrl}`);

      openBrowser(authorizeUrl);
    });

    // 3-minute timeout
    timeout = setTimeout(() => {
      logger.warn("OAuth flow timed out");
      cli.warn("Authentication timed out after 3 minutes");
      cleanup();
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
    authType: auth.type,
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

function openBrowser(url: string): void {
  const cp = require("child_process");
  try {
    if (process.platform === "win32") {
      cp.execSync(`start "" "${url}"`, { shell: "cmd.exe", stdio: "ignore" });
    } else if (process.platform === "darwin") {
      cp.spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      cp.spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
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
</div></body></html>`;
}
