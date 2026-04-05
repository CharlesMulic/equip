// Input validation for augment names, file paths, and URLs.
// Guards against path traversal, injection, and credential leakage.
// Zero dependencies.

import * as path from "path";
import * as os from "os";

// ─── Name Validation ────────────────────────────────────────

/** Valid augment/tool name: lowercase alphanumeric + hyphens, 3-100 chars */
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * Validate a tool/augment name is safe for use in filesystem paths.
 * Throws on invalid names.
 */
export function validateToolName(name: string): void {
  if (!name || name.length < 2 || name.length > 100) {
    throw new Error(`Invalid augment name: must be 2-100 characters, got "${name}"`);
  }
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid augment name: "${name}" must be lowercase alphanumeric with hyphens`);
  }
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(`Invalid augment name: "${name}" contains path separators`);
  }
}

// ─── Path Validation ────────────────────────────────────────

/**
 * Validate that a file path does not escape its parent directory.
 * Used for skill file.path and similar untrusted relative paths.
 * Throws on path traversal attempts.
 */
export function validateRelativePath(filePath: string, context: string = "file path"): void {
  if (!filePath) {
    throw new Error(`Empty ${context}`);
  }

  // Reject absolute paths (check both Unix and Windows patterns for cross-platform safety)
  if (path.isAbsolute(filePath) || /^[A-Za-z]:[/\\]/.test(filePath)) {
    throw new Error(`${context} must be relative, got absolute: "${filePath}"`);
  }

  // Normalize and check for traversal
  const normalized = path.normalize(filePath);
  if (normalized.startsWith("..")) {
    throw new Error(`${context} escapes parent directory: "${filePath}"`);
  }

  // Reject hidden files (dotfiles)
  const parts = normalized.split(path.sep);
  for (const part of parts) {
    if (part.startsWith(".") && part !== ".") {
      throw new Error(`${context} targets hidden file: "${filePath}"`);
    }
  }
}

/**
 * Validate that a resolved file path is within an expected directory.
 * Call AFTER path.join() to verify the resolved path didn't escape.
 */
export function validatePathWithinDir(resolvedPath: string, parentDir: string, context: string = "path"): void {
  const resolved = path.resolve(resolvedPath);
  const parent = path.resolve(parentDir);
  if (!resolved.startsWith(parent + path.sep) && resolved !== parent) {
    throw new Error(`${context} escapes expected directory: "${resolvedPath}" is not within "${parentDir}"`);
  }
}

// ─── hookDir Validation ─────────────────────────────────────

/**
 * Validate and expand a hookDir path. Must resolve to within the user's home directory.
 * Returns the expanded, validated path.
 */
export function validateHookDir(hookDir: string): string {
  const expanded = hookDir.replace(/^~/, os.homedir());
  const resolved = path.resolve(expanded);
  const homeDir = os.homedir();

  if (!resolved.startsWith(homeDir + path.sep) && resolved !== homeDir) {
    throw new Error(`hookDir must be under home directory, got: "${hookDir}"`);
  }

  return resolved;
}

// ─── URL Validation ─────────────────────────────────────────

/** Trusted hosts that may receive credentials */
const TRUSTED_CREDENTIAL_HOSTS = new Set(["api.cg3.io"]);

/**
 * Validate a URL uses a safe scheme (https or http only).
 * Rejects file://, javascript:, and platform-specific schemes.
 */
export function validateUrlScheme(url: string, context: string = "URL"): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`${context} must use https:// or http://, got: "${parsed.protocol}"`);
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.message.startsWith(context)) throw e;
    throw new Error(`Invalid ${context}: "${url}"`);
  }
}

/**
 * Check if a URL is trusted for receiving credentials.
 */
export function isTrustedCredentialHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return TRUSTED_CREDENTIAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}
