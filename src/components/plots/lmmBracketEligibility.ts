/**
 * isLmmEditSignificanceEligible
 *
 * Single source of truth for whether the "Edit significance" drag-edit mode
 * is available for a given plot. All four guard sites (UI row, toggle handler,
 * mergeRebuiltLayout hovermode lock, PlotCanvas cursor) import from here so
 * the criteria can never drift apart.
 *
 * Criteria (all must be true):
 *   1. sourceType === 'test_result'
 *   2. normalized testType is lmm_anova
 *      (lmm_anova_stratified normalizes to lmm_anova via normalizeTestId — no separate entry needed)
 *   3. lmmMode === 'trajectory'
 *   4. layoutMeta.bracketShapeParams exists (shapes were built with custom path format)
 */

import { normalizeTestId } from '@/services/plotResult/common/normalize'
import type { PlotLayoutMeta } from '@/utils/plotBuilders/types'

// 'lmm_anova_stratified' omitted: normalizeTestId maps it to 'lmm_anova' already.
const LMM_TEST_IDS = new Set(['lmm_anova'])

export function isLmmEditSignificanceEligible(
  plot: {
    sourceType: string
    type?: string
    testType?: string | null
    lmmMode?: string | null
  } | null | undefined,
  layoutMeta: PlotLayoutMeta,
): boolean {
  if (!plot) return false
  if (plot.sourceType !== 'test_result') return false
  if (plot.type !== 'line') return false
  if (!LMM_TEST_IDS.has(normalizeTestId(plot.testType ?? ''))) return false
  if (plot.lmmMode !== 'trajectory') return false
  if (!layoutMeta.bracketShapeParams) return false
  return true
}
