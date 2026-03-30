// Auth checking — detects missing, expired, or invalid auth in MCP config entries.
// No network calls. Checks config structure and JWT exp claims only.
// Zero dependencies.

// ─── Types ──────────────────────────────────────────────────

export interface AuthCheckResult {
  /** "ok" = valid JWT with future exp, "present" = exists but can't validate,
   *  "missing" = no auth header, "expired" = JWT with past exp */
  status: "ok" | "present" | "missing" | "expired";
  detail?: string;
}

// ─── Check ──────────────────────────────────────────────────

/**
 * Check auth headers in an MCP config entry.
 * Extracts the Authorization header from all possible locations
 * (top-level headers, http_headers, nested requestInit.headers).
 * If the token looks like a JWT, checks the exp claim.
 */
export function checkAuth(entry: Record<string, unknown>): AuthCheckResult {
  const authValue = extractAuthHeader(entry);
  if (!authValue) return { status: "missing" };

  // If it starts with "Bearer ", extract the token
  const token = authValue.startsWith("Bearer ") ? authValue.slice(7) : authValue;

  // Check if it looks like a JWT (three base64 segments separated by dots)
  const parts = token.split(".");
  if (parts.length === 3) {
    return checkJwtExpiry(parts[1]);
  }

  // Not a JWT — it's a static API key. Can't validate without a network call.
  return { status: "present" };
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Extract the Authorization header from an MCP config entry,
 * checking all known header locations across platforms.
 */
export function extractAuthHeader(entry: Record<string, unknown>): string | null {
  // Top-level headers (most platforms)
  const headers = entry.headers as Record<string, string> | undefined;
  if (headers?.Authorization) return headers.Authorization;

  // http_headers (Codex)
  const httpHeaders = entry.http_headers as Record<string, string> | undefined;
  if (httpHeaders?.Authorization) return httpHeaders.Authorization;

  // Nested in requestInit (Tabnine)
  const requestInit = entry.requestInit as Record<string, Record<string, string>> | undefined;
  if (requestInit?.headers?.Authorization) return requestInit.headers.Authorization;

  return null;
}

function checkJwtExpiry(payloadB64: string): AuthCheckResult {
  try {
    // JWT payload is base64url encoded — normalize to standard base64
    const normalized = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));

    if (typeof payload.exp === "number") {
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) {
        const expiredAgo = now - payload.exp;
        const hours = Math.floor(expiredAgo / 3600);
        const detail = hours > 0 ? `expired ${hours}h ago` : `expired ${Math.floor(expiredAgo / 60)}m ago`;
        return { status: "expired", detail };
      }
      return { status: "ok" };
    }

    // JWT but no exp claim — can't determine expiry
    return { status: "present" };
  } catch {
    // Couldn't decode — treat as opaque token
    return { status: "present" };
  }
}
