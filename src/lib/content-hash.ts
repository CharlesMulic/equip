// Content hash computation for augment integrity verification.
// Must produce identical output to the Kotlin implementation in ContentHashService.kt.
// Uses a positional JSON array to eliminate key-ordering ambiguity across languages.

import * as crypto from "crypto";

export interface ContentManifest {
  rulesContent: string | null;
  rulesMarker: string | null;
  skills: string | null;    // JSON string of skills array (normalized)
  hooks: string | null;     // JSON string of hooks array
  serverUrl: string | null;
  stdioCommand: string | null;
  stdioArgs: string | null; // JSON string of args array
  transport: string | null;
}

/**
 * Compute the content hash for an augment definition.
 * SHA-256 of a canonical JSON array of security-relevant fields.
 */
export function computeContentHash(manifest: ContentManifest): string {
  const canonical = JSON.stringify([
    manifest.rulesContent,
    manifest.rulesMarker,
    manifest.skills ? normalizeSkills(manifest.skills) : null,
    manifest.hooks,
    manifest.serverUrl,
    manifest.stdioCommand,
    manifest.stdioArgs,
    manifest.transport,
  ]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Extract a ContentManifest from a ToolDefinition-like object.
 * Works with both the registry API response and the local AugmentDef.
 */
export function extractManifest(def: {
  rules?: { content: string; marker: string } | null;
  skills?: { name: string; files: { path: string; content: string }[] }[] | null;
  hooks?: unknown[] | null;
  serverUrl?: string | null;
  stdioCommand?: string | null;
  stdioArgs?: string[] | null;
  transport?: string | null;
}): ContentManifest {
  return {
    rulesContent: def.rules?.content ?? null,
    rulesMarker: def.rules?.marker ?? null,
    skills: def.skills && def.skills.length > 0
      ? JSON.stringify(def.skills)
      : null,
    hooks: def.hooks && (def.hooks as unknown[]).length > 0
      ? JSON.stringify(def.hooks)
      : null,
    serverUrl: def.serverUrl ?? null,
    stdioCommand: def.stdioCommand ?? null,
    stdioArgs: def.stdioArgs && def.stdioArgs.length > 0
      ? JSON.stringify(def.stdioArgs)
      : null,
    transport: def.transport ?? null,
  };
}

/**
 * Normalize skills JSON for deterministic hashing.
 * Sorts skills by name, files within each skill by path.
 */
function normalizeSkills(skillsJson: string): string {
  try {
    const skills = JSON.parse(skillsJson) as { name: string; files: { path: string; content: string }[] }[];
    const sorted = [...skills]
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .map(s => ({
        ...s,
        files: s.files
          ? [...s.files].sort((a, b) => (a.path || "").localeCompare(b.path || ""))
          : s.files,
      }));
    return JSON.stringify(sorted);
  } catch {
    return skillsJson;
  }
}
