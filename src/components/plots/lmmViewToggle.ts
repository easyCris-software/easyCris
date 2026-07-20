/**
 * LMM View Toggle — pure helpers
 *
 * Extracted from PlotSidebar to keep the toggle logic unit-testable without
 * rendering the full sidebar. No React or Zustand imports — just plain types.
 */

export interface LmmSiblingViews {
  trajectoryPlotId: string
  contrastPlotId: string
}

/** lmm_anova_stratified is aliased to lmm_anova — both produce the toggle */
const LMM_TEST_TYPES = new Set(['lmm_anova', 'lmm_anova_stratified'])

type MinimalPlot = {
  id: string
  type: string
  sourceType: string
  resultId?: string | null
  testType?: string | null
  facetKey?: string | null
  lmmMode?: 'trajectory' | 'contrast' | 'line_unavailable' | null
}

/** Normalizes lmm_anova_stratified → lmm_anova so both aliases pair correctly. */
function normalizeLmmTestType(t: string | null | undefined): string | null {
  if (!t) return null
  if (t === 'lmm_anova_stratified') return 'lmm_anova'
  return t
}

/**
 * Returns trajectory + contrast line sibling IDs when BOTH exist for the same
 * resultId/facet pair,
 * but ONLY for LMM results (lmm_anova / lmm_anova_stratified).
 * Returns null when:
 *   - No active plot
 *   - Active plot is not a test_result (user-derived plots have no siblings)
 *   - Active plot testType is not an LMM test (prevents false positives on
 *     non-LMM tests that also emit grouped_bar + line, e.g. chi_square_gof)
 *   - Active plot is not an LMM line mode plot
 *   - Only one of the two line modes exists (toggle should remain hidden)
 *   - Sibling plots belong to a different resultId
 */
export function getLmmSiblingViews(
  activePlot: MinimalPlot | undefined,
  allPlots: MinimalPlot[]
): LmmSiblingViews | null {
  if (!activePlot) return null
  if (activePlot.sourceType !== 'test_result') return null
  if (!LMM_TEST_TYPES.has(activePlot.testType ?? '')) return null
  if (activePlot.type !== 'line') return null
  if (activePlot.lmmMode !== 'trajectory' && activePlot.lmmMode !== 'contrast') return null
  if (!activePlot.resultId) return null
  const normalizedFacetKey = activePlot.facetKey ?? null

  const normalizedActiveTestType = normalizeLmmTestType(activePlot.testType)
  const siblings = allPlots.filter(
    p =>
      p.sourceType === 'test_result' &&
      p.resultId === activePlot.resultId &&
      normalizeLmmTestType(p.testType) === normalizedActiveTestType &&
      (p.facetKey ?? null) === normalizedFacetKey
  )
  const trajectoryPlot = siblings.find(p => p.type === 'line' && p.lmmMode === 'trajectory')
  const contrastPlot = siblings.find(p => p.type === 'line' && p.lmmMode === 'contrast')

  if (!trajectoryPlot || !contrastPlot) return null
  return { trajectoryPlotId: trajectoryPlot.id, contrastPlotId: contrastPlot.id }
}

/**
 * Returns the display label for the currently active LMM view.
 */
export function getActiveViewLabel(
  lmmMode: MinimalPlot['lmmMode']
): 'Trajectory' | 'Contrast' | null {
  if (lmmMode === 'trajectory') return 'Trajectory'
  if (lmmMode === 'contrast') return 'Contrast'
  return null
}
