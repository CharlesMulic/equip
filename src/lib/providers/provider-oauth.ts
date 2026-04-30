// OAuthProvider — generic third-party OAuth 2.1 PKCE.
//
// Acquire: open browser to authorizeUrl with PKCE; listen on
// 127.0.0.1:<random> for the redirect; exchange code at tokenUrl.
//
// Refresh: standard RFC 6749 refresh-token grant against tokenUrl.
// (The legacy identity-refresh-daemon doesn't refresh type="oauth"
// credentials; the broker adds this so OAuth-direct augments don't
// silently rot when the access token expires.)
//
// Generic and AS-agnostic: the augment manifest supplies authorizeUrl,
// tokenUrl, clientId, scopes. There's no Notion-specific code or
// Google-specific code; quirks live in the augment's declaration.
//
// Ported from equip/src/lib/auth-engine.ts:resolveOAuth +
// oauthBrowserFlow. Adaptations for broker context:
//  - `cli.log` / `cli.warn` calls removed (broker has no TTY).
//  - Default browser opener provided but injectable for tests.
//  - Refresh path added (didn't exist in legacy direct-mode daemon).

import * as http from "node:http";
import * as crypto from "node:crypto";
import * as childProcess from "node:child_process";
import type {
  Provider,
  ProviderAcquireOptions,
  ProviderRefreshOptions,
  ProviderValidateOptions,
  ProviderResult,
  ProviderDescription,
} from "../auth-broker-types";
import type { StoredCredential, AuthConfig } from "../auth-engine";

const PROVIDER_ID = "oauth";
const ACQUIRE_TIMEOUT_MS = 3 * 60 * 1000;

export type BrowserOpener = (url: string) => (() => void) | void;

export interface OAuthProviderOptions {
  /** Test seam — defaults to spawning OS default browser. */
  openBrowser?: BrowserOpener;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to listening on 127.0.0.1:0. */
  listenHost?: string;
}

export class OAuthProvider implements Provider {
  private readonly openBrowser: BrowserOpener;
  private readonly fetchImpl: typeof fetch;
  private readonly listenHost: string;

  constructor(opts: OAuthProviderOptions = {}) {
    this.openBrowser = opts.openBrowser ?? defaultOpenBrowser;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.listenHost = opts.listenHost ?? "127.0.0.1";
  }

  describe(): ProviderDescription {
    return { id: PROVIDER_ID, name: "Generic OAuth 2.1 PKCE", authTypes: ["oauth"] };
  }

  async acquire(opts: ProviderAcquireOptions): Promise<ProviderResult<StoredCredential>> {
    const auth = opts.auth;
    if (!auth.oauth) {
      return { ok: false, error: "auth.oauth config missing", code: "invalid_auth_config" };
    }
    const tokens = await this.runBrowserFlow(auth.oauth, opts.openBrowser);
    if (!tokens) {
      return { ok: false, error: "OAuth flow did not complete (timeout, denied, or aborted)", code: "oauth_aborted" };
    }
    const now = new Date().toISOString();
    return {
      ok: true,
      value: {
        authType: "oauth",
        credential: tokens.accessToken,
        toolName: opts.augmentName,
        oauth: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          tokenUrl: auth.oauth.tokenUrl,
          clientId: auth.oauth.clientId,
        },
        storedAt: now,
        updatedAt: now,
      },
    };
  }

  async refresh(opts: ProviderRefreshOptions): Promise<ProviderResult<StoredCredential>> {
    const oauth = opts.current.oauth;
    if (!oauth?.refreshToken) {
      return {
        ok: false,
        error: "no refresh_token stored — augment must be re-installed via OAuth browser flow",
        code: "refresh_token_missing",
      };
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: oauth.clientId,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(oauth.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { ok: false, error: `refresh request failed: ${(err as Error).message}`, code: "network_error" };
    }
    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      return { ok: false, error: `refresh returned non-JSON (HTTP ${response.status})`, code: "protocol_error" };
    }
    if (!response.ok || !body.access_token) {
      const description = (body.error_description || body.error || `HTTP ${response.status}`) as string;
      let code = "refresh_failed";
      // RFC 6749 §5.2: invalid_grant on refresh = upstream revoked. The
      // user has to re-OAuth via acquire() to get a fresh family.
      if (body.error === "invalid_grant") code = "consent_revoked";
      return { ok: false, error: description, code };
    }
    const accessToken = body.access_token as string;
    const newRefresh = (body.refresh_token as string | undefined) ?? oauth.refreshToken;
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
    const expiresAt = expiresIn !== null
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : oauth.expiresAt;

    return {
      ok: true,
      value: {
        ...opts.current,
        credential: accessToken,
        oauth: {
          ...oauth,
          accessToken,
          refreshToken: newRefresh,
          expiresAt,
        },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  async validate(_opts: ProviderValidateOptions): Promise<ProviderResult<void>> {
    // No generic upstream validate endpoint; the augment's validationUrl
    // (if declared) is checked at the manager / dispatch layer.
    return { ok: true, value: undefined };
  }

  async invalidate(_augmentName: string): Promise<ProviderResult<void>> {
    // No standard OAuth revoke (RFC 7009 not always implemented). Local-
    // only delete is the manager's job. Future: surface auth.oauth
    // revoke endpoint when augment manifest declares one.
    return { ok: true, value: undefined };
  }

  // ─── PKCE browser flow ────────────────────────────────────

  private runBrowserFlow(
    oauthConfig: NonNullable<AuthConfig["oauth"]>,
    overrideOpener?: BrowserOpener,
  ): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string } | null> {
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const state = crypto.randomBytes(16).toString("hex");
    const nonce = crypto.randomBytes(16).toString("hex");
    const opener = overrideOpener ?? this.openBrowser;
    const fetchImpl = this.fetchImpl;
    const listenHost = this.listenHost;

    return new Promise((resolve) => {
      let closeBrowserFn: (() => void) | null = null;
      let timeoutHandle: NodeJS.Timeout | null = null;

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://${listenHost}`);
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
          res.end(callbackPageHtml("error", "OAuth state mismatch."));
          cleanup();
          resolve(null);
          return;
        }
        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(callbackPageHtml("error", `Authentication denied: ${error}`));
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
        try {
          const port = (server.address() as { port: number }).port;
          const tokenRes = await fetchImpl(oauthConfig.tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: `http://${listenHost}:${port}/callback`,
              code_verifier: codeVerifier,
              client_id: oauthConfig.clientId,
            }).toString(),
          });
          const contentType = tokenRes.headers.get("content-type") || "";
          if (!contentType.includes("json")) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(callbackPageHtml("error", `Token endpoint returned ${contentType || "unknown content-type"}`));
            cleanup();
            resolve(null);
            return;
          }
          const tokenData = await tokenRes.json() as Record<string, unknown>;
          if (tokenData.access_token) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(callbackPageHtml("success", "Authenticated successfully. You can close this window."));
            cleanup();
            if (closeBrowserFn) closeBrowserFn();
            resolve({
              accessToken: tokenData.access_token as string,
              refreshToken: tokenData.refresh_token as string | undefined,
              expiresAt: typeof tokenData.expires_in === "number"
                ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
                : undefined,
            });
          } else {
            const errMsg = (tokenData.error_description || tokenData.error || "Unknown error") as string;
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(callbackPageHtml("error", errMsg));
            cleanup();
            resolve(null);
          }
        } catch (e) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(callbackPageHtml("error", (e as Error).message));
          cleanup();
          resolve(null);
        }
      });

      function cleanup() {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        server.close();
      }

      server.listen(0, listenHost, () => {
        const port = (server.address() as { port: number }).port;
        const params = new URLSearchParams({
          response_type: "code",
          client_id: oauthConfig.clientId,
          redirect_uri: `http://${listenHost}:${port}/callback`,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          state,
          nonce,
        });
        if (oauthConfig.scopes) params.set("scope", oauthConfig.scopes.join(" "));
        const authorizeUrl = `${oauthConfig.authorizeUrl}?${params.toString()}`;
        closeBrowserFn = opener(authorizeUrl) || null;
      });

      timeoutHandle = setTimeout(() => {
        cleanup();
        if (closeBrowserFn) closeBrowserFn();
        resolve(null);
      }, ACQUIRE_TIMEOUT_MS);
      timeoutHandle.unref();
    });
  }
}

// ─── Default browser opener ─────────────────────────────────

function defaultOpenBrowser(url: string): (() => void) | void {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      // Windows-specific: cmd.exe treats `&` as command separator. Without
      // `windowsVerbatimArguments` and explicit double-quoting around the
      // URL, OAuth URLs (which carry `&` between params) truncate at the
      // first `&` — the browser opens to a partial URL and the AS rejects
      // it with `client_id and redirect_uri required`. Mirrors the same
      // fix in equip-app/sidecar/bridge.ts:createAppModeBrowserOpener.
      const escapedUrl = url.replace(/"/g, '""');
      const child = childProcess.spawn(
        "cmd.exe",
        ["/d", "/s", "/c", `start "" "${escapedUrl}"`],
        { detached: true, stdio: "ignore", windowsVerbatimArguments: true },
      );
      child.unref();
      return () => { try { child.kill(); } catch { /* ignore */ } };
    }
    const cmd = platform === "darwin" ? "open" : "xdg-open";
    const child = childProcess.spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.unref();
    return () => { try { child.kill(); } catch { /* ignore */ } };
  } catch {
    return undefined;
  }
}

// ─── Callback page HTML ─────────────────────────────────────

function callbackPageHtml(kind: "success" | "error", message: string): string {
  const color = kind === "success" ? "#16a34a" : "#dc2626";
  const safe = message.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${kind === "success" ? "Done" : "Error"}</title>
<style>body{font-family:system-ui,sans-serif;text-align:center;padding:48px;background:#0a0a0a;color:#e0e0e0}
h1{color:${color}}p{color:#a0a0a0}</style></head><body>
<h1>${kind === "success" ? "✓" : "✗"} ${kind === "success" ? "Authentication complete" : "Authentication failed"}</h1>
<p>${safe}</p></body></html>`;
}
