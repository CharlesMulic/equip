// Weight computation — token overhead tracking for equipped augments.
// Computes base weight (always-paid) and loaded weight (potential max) across
// all equipped augments, with encumbrance classification.
// Zero dependencies.

import { listAugmentDefs, type AugmentDef } from "./augment-defs";
import { readInstallations } from "./installations";
import { readEquipMeta } from "./equip-meta";
import { isPlatformEnabled } from "./platform-state";

// ─── Types ──────────────────────────────────────────────────

export interface WeightThresholds {
  moderate: number;
  heavy: number;
  encumbered: number;
}

export type Encumbrance = "light" | "moderate" | "heavy" | "encumbered";

export interface AugmentWeight {
  name: string;
  displayName: string;
  baseWeight: number;
  loadedWeight: number;
}

export interface WeightReport {
  /** Sum of baseWeight across all equipped augments */
  base: number;
  /** Sum of loadedWeight across all equipped augments */
  loaded: number;
  /** base + loaded */
  total: number;
  /** User's configured context budget (max tokens for augment overhead) */
  contextBudget: number;
  /** Encumbrance level based on base weight relative to budget */
  encumbrance: Encumbrance;
  /** Per-augment breakdown */
  augments: AugmentWeight[];
  /** Thresholds used for computation */
  thresholds: WeightThresholds;
}

export interface WeightPreview {
  /** Current weight before adding the augment */
  current: WeightReport;
  /** Projected weight after adding the augment */
  projected: WeightReport;
  /** The augment being previewed */
  augment: AugmentWeight;
}

// ─── Defaults ───────────────────────────────────────────────

export const DEFAULT_THRESHOLDS: WeightThresholds = {
  moderate: 5000,
  heavy: 15000,
  encumbered: 30000,
};

// ─── Encumbrance ────────────────────────────────────────────

/**
 * Compute encumbrance level. Thresholds are percentages of the context budget.
 * Default: light <20%, moderate <50%, heavy <80%, encumbered ≥80%.
 */
export function getEncumbrance(baseWeight: number, contextBudget: number = 30000): Encumbrance {
  if (contextBudget <= 0) return "light";
  const pct = baseWeight / contextBudget;
  if (pct >= 0.8) return "encumbered";
  if (pct >= 0.5) return "heavy";
  if (pct >= 0.2) return "moderate";
  return "light";
}

// ─── Weight Estimation ──────────────────────────────────────

/**
 * Estimate baseWeight from augment content when no weight is declared.
 * Uses ~4 bytes per token heuristic (conservative average for code/text).
 */
export function estimateBaseWeight(def: AugmentDef): number {
  let bytes = 0;

  // MCP server config entry (~200 bytes typical)
  if (def.serverUrl) bytes += 200;
  if (def.stdio) bytes += 150;

  // Rules content
  if (def.rules?.content) bytes += def.rules.content.length;

  return Math.round(bytes / 4);
}

/**
 * Estimate loadedWeight from skills content.
 */
export function estimateLoadedWeight(def: AugmentDef): number {
  let bytes = 0;

  // Skills content (loaded on demand)
  for (const skill of def.skills || []) {
    for (const file of skill.files || []) {
      bytes += file.content?.length || 0;
    }
  }

  return Math.round(bytes / 4);
}

/**
 * Compute and apply accurate weights from introspection data onto an AugmentDef.
 * Mutates def.baseWeight, def.loadedWeight, and def.introspection.
 */
export function applyIntrospectionWeights(def: AugmentDef, introResult: { toolTokens?: number; resourceTokens?: number }): void {
  const rulesTokens = def.rules?.content ? Math.round(def.rules.content.length / 4) : 0;
  const skillTokens = estimateLoadedWeight(def);
  def.baseWeight = (introResult.toolTokens || 0) + rulesTokens;
  def.loadedWeight = (introResult.resourceTokens || 0) + skillTokens;
}

// ─── Compute ────────────────────────────────────────────────

/**
 * Compute a full weight report for all currently equipped augments.
 * "Equipped" means installed on at least one enabled platform.
 */
export function computeWeightReport(): WeightReport {
  const installations = readInstallations();
  const allDefs = listAugmentDefs();
  const meta = readEquipMeta();
  const contextBudget = meta.preferences?.contextBudget || 30000;

  const customThresholds = (meta.preferences as unknown as Record<string, unknown>)?.encumbranceThresholds as Partial<WeightThresholds> | undefined;
  const thresholds: WeightThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...customThresholds,
  };

  const defMap = new Map<string, AugmentDef>();
  for (const d of allDefs) defMap.set(d.name, d);

  const augments: AugmentWeight[] = [];

  for (const [name, record] of Object.entries(installations.augments || {})) {
    // Only count augments installed on at least one enabled platform
    const enabledPlatforms = (record.platforms || []).filter(id => isPlatformEnabled(id));
    if (enabledPlatforms.length === 0) continue;

    const def = defMap.get(name);

    // Weight priority: introspection data > declared values > heuristic estimate
    const introspection = def?.introspection;
    let base: number;
    let loaded: number;

    if (introspection?.toolTokens) {
      // Introspection gives us real tool schema token counts
      const rulesTokens = def?.rules?.content ? Math.round(def.rules.content.length / 4) : 0;
      base = introspection.toolTokens + rulesTokens;
      const skillTokens = (def?.skills || []).reduce((sum: number, s: any) =>
        sum + (s.files || []).reduce((fsum: number, f: any) => fsum + (f.content ? Math.round(f.content.length / 4) : 0), 0), 0);
      loaded = (introspection.resourceTokens || 0) + skillTokens;
    } else if (def?.baseWeight) {
      base = def.baseWeight;
      loaded = def.loadedWeight || 0;
    } else {
      base = def ? estimateBaseWeight(def) : 0;
      loaded = def ? estimateLoadedWeight(def) : 0;
    }

    augments.push({
      name,
      displayName: def?.displayName || record.displayName || name,
      baseWeight: base,
      loadedWeight: loaded,
    });
  }

  const base = augments.reduce((sum, a) => sum + a.baseWeight, 0);
  const loaded = augments.reduce((sum, a) => sum + a.loadedWeight, 0);

  return {
    base,
    loaded,
    total: base + loaded,
    contextBudget,
    encumbrance: getEncumbrance(base, contextBudget),
    augments,
    thresholds,
  };
}

/**
 * Preview what weight would look like if an augment were added.
 * Used for the "what if?" hover preview on unequipped augments.
 */
export function previewEquipWeight(augmentName: string): WeightPreview {
  const current = computeWeightReport();

  // Find the augment definition
  const allDefs = listAugmentDefs();
  const def = allDefs.find(d => d.name === augmentName);

  const augment: AugmentWeight = {
    name: augmentName,
    displayName: def?.displayName || augmentName,
    baseWeight: def?.baseWeight || (def ? estimateBaseWeight(def) : 0),
    loadedWeight: def?.loadedWeight || (def ? estimateLoadedWeight(def) : 0),
  };

  // Build projected report
  const projectedAugments = [...current.augments, augment];
  const projectedBase = current.base + augment.baseWeight;
  const projectedLoaded = current.loaded + augment.loadedWeight;

  const projected: WeightReport = {
    base: projectedBase,
    loaded: projectedLoaded,
    total: projectedBase + projectedLoaded,
    contextBudget: current.contextBudget,
    encumbrance: getEncumbrance(projectedBase, current.contextBudget),
    augments: projectedAugments,
    thresholds: current.thresholds,
  };

  return { current, projected, augment };
}
