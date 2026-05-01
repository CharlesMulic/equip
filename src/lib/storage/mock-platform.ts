// Test-only mock platform writer for storage tests.
//
// In production, "writing an augment to a platform" means writing config
// files into ~/.claude/, ~/.codex/, etc. Each platform has its own format
// (JSON, TOML, etc.) and discoverable config path.
//
// The mock platform records what we would have written and exposes a
// fingerprint method for drift detection. This isolates the materializer's
// platform-writer responsibility from real platform files.

import * as crypto from "crypto";
import type { ResolvedAugment } from "./materializer";

export interface PlatformWrite {
  augmentName: string;
  platformId: string;
  serializedConfig: string;
  fingerprint: string;
  writtenAt: string;
}

export class MockPlatform {
  private writes = new Map<string, PlatformWrite>(); // key = `${platformId}:${augmentName}`

  /** Materializer calls this for each (augment, platform) pair to install. */
  applyAugmentToPlatform(resolved: ResolvedAugment, platformId: string): PlatformWrite {
    const config = this.serialize(resolved, platformId);
    const fingerprint = crypto.createHash("sha256").update(config).digest("hex");
    const write: PlatformWrite = {
      augmentName: resolved.name,
      platformId,
      serializedConfig: config,
      fingerprint,
      writtenAt: new Date().toISOString(),
    };
    this.writes.set(this.key(platformId, resolved.name), write);
    return write;
  }

  /** Materializer calls this when an augment is uninstalled from a platform. */
  removeAugmentFromPlatform(name: string, platformId: string): boolean {
    const key = this.key(platformId, name);
    const had = this.writes.has(key);
    this.writes.delete(key);
    return had;
  }

  getWrite(name: string, platformId: string): PlatformWrite | null {
    return this.writes.get(this.key(platformId, name)) ?? null;
  }

  /**
   * What would we expect to find on disk if our last write hasn't been
   * tampered with? Used by drift detection — fingerprint mismatch = external
   * actor (other tool) edited the platform config.
   */
  expectedFingerprint(name: string, platformId: string): string | null {
    return this.getWrite(name, platformId)?.fingerprint ?? null;
  }

  allWrites(): PlatformWrite[] {
    return [...this.writes.values()];
  }

  reset(): void {
    this.writes.clear();
  }

  private serialize(resolved: ResolvedAugment, platformId: string): string {
    // Test-only canonical serialization. Real platform writers produce
    // platform-specific formats (Claude's config.json, Codex's config.toml,
    // etc.). The fingerprint computation needs to be over CANONICAL form so
    // that re-serializing the same content gives the same hash.
    return JSON.stringify({
      name: resolved.name,
      transport: resolved.transport,
      serverUrl: resolved.serverUrl,
      stdio: resolved.stdio,
      requiresAuth: resolved.requiresAuth,
      rules: resolved.rules?.content ?? null,
      skillsCount: resolved.skills.length,
      hooksCount: resolved.hooks.length,
      platformId,
    });
  }

  private key(platformId: string, name: string): string {
    return `${platformId}:${name}`;
  }
}
