/**
 * applyLmmTrajectoryOverride
 *
 * Shared helper for applying a per-plot LMM style override and pushing the
 * result into the plots store.
 *
 * Used by:
 *   - PlotSidebar.applyLmmStyleOverride (Colors-tab baseline select + swap switch)
 */

import { buildLmmPlots } from './buildLmmPlots'
import type { LmmTraceRoleOverride } from './resolveTraceRoles'
import type { TestResult } from '@/store/results-store'

interface ApplyLmmTrajectoryOverrideArgs {
  result: TestResult
  effectiveOverrides: Record<string, LmmTraceRoleOverride>
  /** Facet key of the active plot panel (null = pooled) */
  facetKey: string | null
  plotId: string
  updatePlot: (
    plotId: string,
    updates: { plotlyData: unknown[]; plotlyLayout: unknown },
  ) => void
}

/**
 * Rebuild LMM trajectory plots with the effective overrides and push the
 * matching panel's data into the store via `updatePlot`.
 *
 * Does nothing when no trajectory spec matching `facetKey` is found.
 */
export function applyLmmTrajectoryOverride({
  result,
  effectiveOverrides,
  facetKey,
  plotId,
  updatePlot,
}: ApplyLmmTrajectoryOverrideArgs): void {
  const allSpecs = buildLmmPlots(result, effectiveOverrides)
  const match = allSpecs.find(
    (s) => s.plot.lmmMode === 'trajectory' && s.plot.facetKey === facetKey,
  )
  if (match) {
    updatePlot(plotId, {
      plotlyData: match.plot.plotlyData,
      plotlyLayout: match.plot.plotlyLayout,
    })
  }
}
