// Test-only mock registry for v2 spike tests.
//
// Stands in for the real registry HTTP API. Tests construct one with a
// preloaded set of (name, version) → AugmentContent mappings; the install
// + refresh flows fetch from this in-memory registry instead of hitting
// the network.

import type { AugmentContent } from "./content-store";

export interface RegistryFetchResult {
  content: AugmentContent;
  version: number;
  etag: string;
  fetchedAt: string;
}

export class MockRegistry {
  private contents = new Map<string, RegistryFetchResult[]>(); // name → versions
  private fetchCount = 0;

  publish(name: string, version: number, content: AugmentContent, opts?: { etag?: string }): void {
    if (!this.contents.has(name)) this.contents.set(name, []);
    this.contents.get(name)!.push({
      content: { ...content, name },
      version,
      etag: opts?.etag ?? `etag-${name}-v${version}`,
      fetchedAt: new Date().toISOString(),
    });
  }

  fetchLatest(name: string): RegistryFetchResult | null {
    const versions = this.contents.get(name);
    if (!versions || versions.length === 0) return null;
    this.fetchCount++;
    const latest = versions[versions.length - 1];
    return { ...latest, fetchedAt: new Date().toISOString() };
  }

  fetchVersion(name: string, version: number): RegistryFetchResult | null {
    const versions = this.contents.get(name);
    if (!versions) return null;
    const found = versions.find((v) => v.version === version);
    if (!found) return null;
    this.fetchCount++;
    return { ...found, fetchedAt: new Date().toISOString() };
  }

  totalFetches(): number {
    return this.fetchCount;
  }

  resetFetchCount(): void {
    this.fetchCount = 0;
  }
}
