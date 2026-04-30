// Adoption snapshot — capture the existing MCP config entry before
// equip overwrites it with broker-mode wiring.
//
// When a user accepts adoption (regardless of where the prompt came
// from), the caller invokes this helper to snapshot the existing entry
// to `~/.equip/adopted-entries/`. Two file shapes:
//
// 1. Per-entry snapshots: `<platform>-<augment>-<timestamp>.json`. Just
//    the existing MCP entry (the value at `mcpServers[name]` for JSON
//    or the parsed `[mcp_servers.name]` for TOML), bearer-redacted.
// 2. Per-platform baseline: `<platform>-baseline-<timestamp>.json`. The
//    whole platform config file at the moment of the FIRST adoption per
//    platform, bearer-redacted. Lets a future caller offer "Restore
//    pre-broker-mode setup" if a release later needs to be backed out.
//
// Posture (sec-pen requirement): both file types written at mode 0o600,
// directory at 0o700. Bearer fields redacted to ***REDACTED***. The
// snapshot is *config-shape* recovery, not credential recovery — the
// adopted bearer is NOT revoked at the upstream provider (that's beyond
// equip's authority), so the snapshot stores enough to restore the
// surrounding shape but never the secret itself.

import * as fs from "fs";
import * as path from "path";
import { getEquipHome } from "./equip-home";

const ADOPTION_DIR_NAME = "adopted-entries";

const ADOPTION_README = `# Adopted entries

This directory holds **structural snapshots of MCP config entries that
were adopted into equip's management** when the user accepted the
adoption modal during equip install.

Two file shapes:

- \`<platform>-<augment>-<timestamp>.json\` — the existing entry that was
  replaced by equip's broker-mode wiring.
- \`<platform>-baseline-<timestamp>.json\` — the whole platform config
  file at the moment of the FIRST adoption per platform, kept for
  emergency rollback.

**Bearer tokens / API keys are redacted to \`***REDACTED***\`.** These
snapshots are config-shape recovery only — they're safe to delete if
you're confident you won't need to restore your pre-equip setup.

Files are written at mode 0o600; this directory is 0o700.
`;

export interface AdoptionSnapshot {
  /** Augment name being adopted. */
  augmentName: string;
  /** Platform id (e.g., "claude-code"). */
  platform: string;
  /** The existing MCP entry as parsed from the platform's config file. */
  existingEntry: Record<string, unknown>;
  /**
   * Whole-platform-config baseline at adoption time. Captured only on
   * the FIRST adoption per (platform, equip-home) tuple. null when a
   * baseline already exists for this platform.
   */
  platformConfigBaseline?: string;
}

/**
 * Bearer-redact an MCP entry for at-rest snapshot storage. Replaces:
 *   - any field whose name matches /authorization|api[_-]?key|bearer|token/i
 *     at any depth with ***REDACTED***
 *   - common header-bag patterns (`headers.Authorization`, etc.)
 *
 * The redaction is lossy by design — the snapshot is for config shape
 * restoration, NOT for credential recovery (adopted bearers are not
 * revoked at the upstream, so re-using them after a long gap is unsafe).
 */
export function redactSecrets<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (looksLikeSecretKey(k)) {
        // For string values, redact the value entirely. For object
        // values (e.g., a `headers` map), recurse so nested secrets
        // get found too.
        if (typeof v === "string") {
          out[k] = "***REDACTED***";
        } else {
          out[k] = redactSecrets(v);
        }
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out as T;
  }
  return value;
}

function looksLikeSecretKey(key: string): boolean {
  // Case-insensitive match on common credential field names. Conservative
  // overcoverage: if it matches, redact. Field names that match these
  // patterns at any depth get their string values replaced.
  return /^(authorization|api[_-]?key|bearer[_-]?token|access[_-]?token|secret|token)$/i.test(key);
}

/**
 * Write a snapshot of an existing MCP entry being adopted, plus
 * (on first adoption per platform) a whole-config baseline. Returns
 * the paths written so callers can include them in their "adoption
 * succeeded" log + UI surface.
 */
export function writeAdoptionSnapshot(snapshot: AdoptionSnapshot): {
  perEntryPath: string;
  baselinePath: string | null;
} {
  const dir = path.join(getEquipHome(), ADOPTION_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Best-effort chmod (mkdirSync mode is OS-specific on existing dirs).
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }

  // Drop a README on first write so users / agents who stumble in
  // know what this is.
  const readmePath = path.join(dir, "README.md");
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, ADOPTION_README, { encoding: "utf-8", mode: 0o600 });
  }

  const ts = isoStamp();
  const safeName = sanitize(snapshot.augmentName);
  const safePlat = sanitize(snapshot.platform);

  // Per-entry snapshot.
  const perEntryPath = path.join(dir, `${safePlat}-${safeName}-${ts}.json`);
  const perEntryPayload = JSON.stringify({
    augmentName: snapshot.augmentName,
    platform: snapshot.platform,
    capturedAt: new Date().toISOString(),
    existingEntry: redactSecrets(snapshot.existingEntry),
    note: "Bearer / API key fields are redacted. This snapshot is structural config recovery, not credential recovery.",
  }, null, 2);
  writeMode0o600(perEntryPath, perEntryPayload);

  // Per-platform baseline (first-adoption-per-platform only).
  let baselinePath: string | null = null;
  if (snapshot.platformConfigBaseline !== undefined) {
    const baseGlob = `${safePlat}-baseline-`;
    const alreadyHasBaseline = fs.readdirSync(dir).some((entry) => entry.startsWith(baseGlob));
    if (!alreadyHasBaseline) {
      baselinePath = path.join(dir, `${safePlat}-baseline-${ts}.txt`);
      writeMode0o600(baselinePath, redactBaselineConfig(snapshot.platformConfigBaseline));
    }
  }

  return { perEntryPath, baselinePath };
}

/**
 * Best-effort secret redaction on a whole-file platform config string.
 * For JSON configs, parses + redacts + serializes; preserves shape for
 * downgrade restoration. For TOML / unknown formats, applies a regex
 * pass over likely-bearer lines.
 */
function redactBaselineConfig(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(redactSecrets(parsed), null, 2);
    } catch { /* fall through to text redaction */ }
  }
  // Text-form fallback: redact bearer-shaped values.
  // Patterns: Authorization = "Bearer xxx", token = "xxx", api_key = "xxx", etc.
  return content
    .replace(/("(?:authorization|api[_-]?key|bearer[_-]?token|access[_-]?token|secret|token)"\s*[:=]\s*")[^"]*(")/gi, '$1***REDACTED***$2')
    .replace(/((?:authorization|api[_-]?key|bearer[_-]?token|access[_-]?token|secret|token)\s*=\s*")[^"]*(")/gi, '$1***REDACTED***$2');
}

function writeMode0o600(filePath: string, contents: string): void {
  // Atomic write via tempfile + rename — same pattern as
  // credential-store-file. Chmod after rename in case the tempfile
  // had a different mode.
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, contents, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
}

function isoStamp(): string {
  // YYYYMMDDTHHMMSS — filename-safe (no colons / dots).
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9_-]/gi, "_");
}
