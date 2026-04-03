// Observability types — structured results, logging, error codes, telemetry reporting.
// Used across all install methods and by consumers for telemetry collection.
// Zero dependencies.

import * as os from "os";

// ─── Artifact Types ─────────────────────────────────────────

export type ArtifactType = "mcp" | "rules" | "skills" | "hooks";

export type ArtifactAction =
  | "created"
  | "updated"
  | "skipped"
  | "clipboard"
  | "failed";

// ─── Error Codes ────────────────────────────────────────────
// Fixed strings for telemetry aggregation. Do not use free-text.

export type EquipErrorCode =
  | "CONFIG_CORRUPT"
  | "CONFIG_UNREADABLE"
  | "CONFIG_WRITE_FAILED"
  | "SETTINGS_CORRUPT"
  | "SETTINGS_WRITE_FAILED"
  | "TOML_READ_FAILED"
  | "STATE_CORRUPT"
  | "CLIPBOARD_FAILED"
  | "MCP_ENTRY_UNREADABLE"
  | "SKILL_WRITE_FAILED"
  | "HOOK_SCRIPT_FAILED"
  | "BACKUP_FAILED";

// ─── Warning Codes ──────────────────────────────────────────

export type EquipWarningCode =
  | "WARN_CLIPBOARD_FAILED"
  | "WARN_STATE_RESET"
  | "WARN_BACKUP_SKIPPED"
  | "WARN_SETTINGS_CREATED"
  | "WARN_BOM_STRIPPED";

// ─── Warning ────────────────────────────────────────────────

export interface EquipWarning {
  code: EquipWarningCode;
  message: string;
}

// ─── ArtifactResult ─────────────────────────────────────────
// Unified return type from all install methods.

export interface ArtifactResult {
  artifact: ArtifactType;
  attempted: boolean;
  success: boolean;
  action: ArtifactAction;
  errorCode?: EquipErrorCode;
  error?: string;
  warnings: EquipWarning[];
  // Artifact-specific metadata (backward compat)
  method?: string;       // "json" | "toml" for mcp
  scripts?: string[];    // installed script filenames for hooks
  hookDir?: string;      // hook directory for hooks
}

// ─── Logger ─────────────────────────────────────────────────

export interface EquipLogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export const NOOP_LOGGER: EquipLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// ─── Helpers ────────────────────────────────────────────────

/** Create an ArtifactResult with safe defaults. Override any field. */
export function makeResult(artifact: ArtifactType, overrides: Partial<ArtifactResult> = {}): ArtifactResult {
  return {
    artifact,
    attempted: true,
    success: false,
    action: "failed",
    warnings: [],
    ...overrides,
  };
}

// ─── InstallReportBuilder ───────────────────────────────────
// Accumulates per-platform, per-artifact results during an install session.
// Call toJSON() at the end to get telemetry-ready payload.

interface PlatformReport {
  platform: string;
  results: ArtifactResult[];
}

export class InstallReportBuilder {
  private startedAt: number;
  private completedAt: number | null = null;
  private platformMap: Map<string, ArtifactResult[]> = new Map();

  constructor() {
    this.startedAt = Date.now();
  }

  addResult(platform: string, result: ArtifactResult): void {
    let list = this.platformMap.get(platform);
    if (!list) {
      list = [];
      this.platformMap.set(platform, list);
    }
    list.push(result);
  }

  complete(): void {
    this.completedAt = Date.now();
  }

  get durationMs(): number {
    return (this.completedAt ?? Date.now()) - this.startedAt;
  }

  get overallSuccess(): boolean {
    for (const results of this.platformMap.values()) {
      for (const r of results) {
        if (r.attempted && !r.success) return false;
      }
    }
    return true;
  }

  get partial(): boolean {
    let hasSuccess = false;
    let hasFailure = false;
    for (const results of this.platformMap.values()) {
      for (const r of results) {
        if (!r.attempted) continue;
        if (r.success) hasSuccess = true;
        else hasFailure = true;
      }
    }
    return hasSuccess && hasFailure;
  }

  get warningCount(): number {
    let count = 0;
    for (const results of this.platformMap.values()) {
      for (const r of results) {
        count += r.warnings.length;
      }
    }
    return count;
  }

  get errorCount(): number {
    let count = 0;
    for (const results of this.platformMap.values()) {
      for (const r of results) {
        if (r.attempted && !r.success) count++;
      }
    }
    return count;
  }

  get platforms(): PlatformReport[] {
    const reports: PlatformReport[] = [];
    for (const [platform, results] of this.platformMap) {
      reports.push({ platform, results });
    }
    return reports;
  }

  toJSON(): Record<string, unknown> {
    return {
      durationMs: this.durationMs,
      overallSuccess: this.overallSuccess,
      partial: this.partial,
      warningCount: this.warningCount,
      errorCount: this.errorCount,
      platforms: this.platforms.map(p => ({
        platform: p.platform,
        success: p.results.every(r => !r.attempted || r.success),
        artifacts: Object.fromEntries(
          p.results.map(r => [r.artifact, {
            attempted: r.attempted,
            success: r.success,
            action: r.action,
            errorCode: r.errorCode,
            error: r.error?.replace(os.homedir(), "~"),
            warnings: r.warnings.length > 0 ? r.warnings : undefined,
          }])
        ),
      })),
    };
  }
}
