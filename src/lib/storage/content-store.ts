// Content-addressed blob store.
//
// Stores immutable augment content (rules, skills, hooks, mcp config, etc.)
// keyed by SHA-256 hash of the canonical JSON serialization. Two augments
// with identical content collapse to the same blob — desirable for
// deduplication of registry-fetched + locally-authored content.
//
// File layout: ~/.equip/storage/content/<hash>.json
// Writes are atomic (temp + rename). Reads parse JSON directly.
// Hashing is content-only (the contentHash field, if present on input, is
// stripped before hashing to keep hashes idempotent under round-trip).
//
// GC: references from non-superseded intents keep blobs alive. Sweeper
// lands when telemetry shows blob-store growth needs reclaiming.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getEquipHome } from "../equip-home";
import type { ContentHash } from "./intent";

/**
 * Augment content — the immutable shape of an augment at a point in time
 * (one version's worth of publisher content, OR a locally-authored draft
 * that's been promoted to a content blob). All publisher-authored fields
 * + behavioral content (rules/skills/hooks) live here. User mods + install
 * state + freshness metadata live elsewhere (in intents).
 */
export interface AugmentContent {
  /** Augment name (denormalized for convenience; primary key is contentHash). */
  name: string;
  /** Display title. */
  title: string;
  /** Free-form description. */
  description: string;
  /** Optional subtitle shown under the title (publisher-declared). */
  subtitle?: string;
  /** Flavor text for the catalog detail page (publisher-declared). */
  flavorText?: string;
  /** Category slugs the augment belongs to. Primary category is the first
   *  in this list when `primaryCategory` isn't set. */
  categories?: string[];
  /** Primary category slug for catalog grouping. Falls back to categories[0]. */
  primaryCategory?: string;
  /** Free-form discovery tags. */
  tags?: string[];
  /** Publisher's homepage URL (informational; for catalog display). */
  homepage?: string;
  /** Source repository URL. */
  repository?: string;
  /** License identifier (SPDX or free-form). */
  license?: string;
  /** MCP transport. */
  transport?: "http" | "stdio";
  /** HTTP endpoint (if transport=http). */
  serverUrl?: string;
  /** stdio invocation (if transport=stdio). `envKey` is the env-var
   *  name the platform should populate with the user's credential when
   *  invoking the command — publisher-declared, immutable per version. */
  stdio?: { command: string; args: string[]; envKey?: string };
  /** Whether this augment requires user-provided auth. */
  requiresAuth?: boolean;
  /**
   * Auth flow declaration (publisher-declared, immutable per version).
   * Mirrors legacy `RegistryDef.auth`. Consumed by broker-mode dispatch
   * to decide direct-vs-broker per (augment × platform). Kept opaque
   * here (`Record<string, unknown>`) because the structural shape lives
   * in `auth-engine.ts` — content-store deliberately doesn't know about
   * specific auth types.
   */
  auth?: Record<string, unknown>;
  /** Behavioral rules (markdown). */
  rules?: { content: string; version: string; marker: string };
  /** Named skill bundles. */
  skills?: { name: string; files: { path: string; content: string }[] }[];
  /** Event hooks. Shape matches the legacy HookDefinition (event/matcher/script/name). */
  hooks?: { event: string; matcher?: string; script: string; name: string }[];
}

const STORAGE_CONTENT_DIRNAME = "storage/content";

function getContentDir(): string {
  return path.join(getEquipHome(), STORAGE_CONTENT_DIRNAME);
}

function ensureContentDir(): void {
  const dir = getContentDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function contentPath(hash: ContentHash): string {
  // Defensive: hash is hex-encoded SHA-256, so it's safe as a filename.
  // Reject anything that doesn't look like one to prevent path traversal.
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`invalid contentHash format: ${hash}`);
  }
  return path.join(getContentDir(), `${hash}.json`);
}

/**
 * Compute the canonical content-hash for a blob. Idempotent under round-trip:
 * `computeContentHash(JSON.parse(JSON.stringify(blob)))` === `computeContentHash(blob)`.
 *
 * Hashing is over the JSON serialization with sorted keys for stability.
 */
export function computeContentHash(blob: AugmentContent): ContentHash {
  const canonical = canonicalize(blob);
  return crypto.createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/**
 * Canonical JSON serialization with sorted object keys. Required so that
 * `{a: 1, b: 2}` and `{b: 2, a: 1}` hash to the same value.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]));
  return "{" + entries.join(",") + "}";
}

/**
 * Write a content blob. Returns the contentHash. Idempotent — writing the
 * same blob twice is a no-op (rename onto existing file is harmless on POSIX
 * + Windows here because we check existence first).
 */
export function putContent(blob: AugmentContent): ContentHash {
  ensureContentDir();
  const hash = computeContentHash(blob);
  const finalPath = contentPath(hash);
  if (fs.existsSync(finalPath)) {
    // Idempotent — content with this hash already on disk.
    return hash;
  }
  // Atomic write: temp + rename.
  const tempPath = finalPath + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tempPath, JSON.stringify(blob, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tempPath, finalPath);
  return hash;
}

/**
 * Read a content blob by hash. Returns null if missing.
 */
export function getContent(hash: ContentHash): AugmentContent | null {
  const p = contentPath(hash);
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as AugmentContent;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Check existence without parsing.
 */
export function hasContent(hash: ContentHash): boolean {
  return fs.existsSync(contentPath(hash));
}

/**
 * List all content hashes currently stored. Used by GC sweeper (out-of-scope
 * for the spike, but exposed so the test harness can verify that "no orphan
 * blobs after operation X" assertions are checkable).
 */
export function listContentHashes(): ContentHash[] {
  ensureContentDir();
  try {
    return fs.readdirSync(getContentDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
