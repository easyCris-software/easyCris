/**
 * applyLmmTrajectoryOverride — unit tests
 *
 * Verifies the shared helper that:
 *   1. Calls buildLmmPlots with the effective overrides
 *   2. Finds the trajectory plot matching the given facetKey
 *   3. Calls updatePlot with plotlyData + plotlyLayout from the match
 *
 * Finding 6: this logic was duplicated in ActivePlotView.handleSwapStyles
 * and PlotSidebar.applyLmmStyleOverride — extracted here.
 */
import { describe, it, expect, vi } from 'vitest'
import { applyLmmTrajectoryOverride } from '../applyLmmTrajectoryOverride'
import type { LmmTraceRoleOverride } from '../resolveTraceRoles'
import type { TestResult } from '@/store/results-store'

// ---------------------------------------------------------------------------
// Fixtures — must include per_group_means_over_time so buildLmmPlots emits
// at least one trajectory spec.
// ---------------------------------------------------------------------------

function makeResult(id = 'r1'): TestResult {
  return {
    id,
    testId: 'lmm_anova',
    testName: 'Linear Mixed Model',
    family: 'parametric',
    statisticsFamilyId: 'statistics-1',
    executedAt: new Date('2026-01-01'),
    statistics: {},
    rawOutput: {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
      per_group_means_over_time: [
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
      ],
    },
    plotPayload: {
      test: 'lmm_anova',
      data: { dependent_name: 'Body Weight', value_column: 'Body Weight' },
    },
  } as unknown as TestResult
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyLmmTrajectoryOverride', () => {
  it('calls updatePlot with data from the matching trajectory spec', () => {
    const result = makeResult()
    const overrides: Record<string, LmmTraceRoleOverride> = {}
    const updatePlot = vi.fn()

    // The function must call buildLmmPlots and pass plotlyData/plotlyLayout to updatePlot
    applyLmmTrajectoryOverride({
      result,
      effectiveOverrides: overrides,
      facetKey: null,
      plotId: 'plot-1',
      updatePlot,
    })

    // Should have called updatePlot once (assuming buildLmmPlots returns ≥1 trajectory spec)
    expect(updatePlot).toHaveBeenCalledTimes(1)
    const [calledId, calledUpdates] = updatePlot.mock.calls[0]!
    expect(calledId).toBe('plot-1')
    expect(calledUpdates).toHaveProperty('plotlyData')
    expect(calledUpdates).toHaveProperty('plotlyLayout')
  })

  it('uses facetKey to match the correct spec when multiple specs exist', () => {
    const result = makeResult()
    const updatePlot = vi.fn()

    // facetKey=null selects the pooled trajectory
    applyLmmTrajectoryOverride({
      result,
      effectiveOverrides: {},
      facetKey: null,
      plotId: 'plot-pooled',
      updatePlot,
    })

    expect(updatePlot).toHaveBeenCalledTimes(1)
  })

  it('does not call updatePlot when no trajectory spec matches', () => {
    const result = makeResult()
    const updatePlot = vi.fn()

    // A facetKey that won't match any spec
    applyLmmTrajectoryOverride({
      result,
      effectiveOverrides: {},
      facetKey: 'nonexistent=xyz',
      plotId: 'plot-1',
      updatePlot,
    })

    expect(updatePlot).not.toHaveBeenCalled()
  })

  it('effectiveOverrides are forwarded to buildLmmPlots — a swapStyles override changes plotlyData', () => {
    // Override key for result 'r1', pooled, trajectory
    const overrideKey = 'r1|pooled|trajectory'
    const result = makeResult('r1')

    const updatePlotBase = vi.fn()
    const updatePlotSwapped = vi.fn()

    applyLmmTrajectoryOverride({
      result,
      effectiveOverrides: {},
      facetKey: null,
      plotId: 'plot-1',
      updatePlot: updatePlotBase,
    })

    applyLmmTrajectoryOverride({
      result,
      effectiveOverrides: { [overrideKey]: { swapStyles: true } },
      facetKey: null,
      plotId: 'plot-1',
      updatePlot: updatePlotSwapped,
    })

    // Both calls should have fired
    expect(updatePlotBase).toHaveBeenCalledTimes(1)
    expect(updatePlotSwapped).toHaveBeenCalledTimes(1)

    // The plotlyData must differ — if effectiveOverrides were ignored,
    // both would produce identical data and this assertion would fail.
    const baseData = updatePlotBase.mock.calls[0]![1].plotlyData
    const swappedData = updatePlotSwapped.mock.calls[0]![1].plotlyData
    expect(baseData).not.toEqual(swappedData)
  })
})
