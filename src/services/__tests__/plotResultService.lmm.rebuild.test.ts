/**
 * LMM rebuild path — TDD Red Phase
 *
 * Verifies that rebuildTestResultPlot routes lmm_anova results through
 * buildLmmPlots (LMM-specific semantics) and NOT through generic
 * buildGroupedBarFromResult / null.
 *
 * Also verifies the private normalizeTestId copy has the lmm_anova_stratified
 * alias so stratified results can rebuild correctly.
 */

import { describe, it, expect } from 'vitest'
import { rebuildTestResultPlot, buildPlotSpecsFromResult } from '@/services/plotResultService'
import type { TestResult } from '@/store/results-store'
import type { LmmTraceRoleOverride } from '@/services/plotResult/lmm/resolveTraceRoles'

// ---------------------------------------------------------------------------
// Shared LMM raw output fixture
// ---------------------------------------------------------------------------

const LMM_RAW = {
  success: true,
  test_type: 'lmm_anova',
  stratified: false,
  fixed_effects: [
    { source: 'treatment', f_value: 12.3, p_value: 0.001, num_df: 1, den_df: 18.7, significant: true },
  ],
  estimated_means: [
    { factors: { treatment: 'VEH' }, emmean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
    { factors: { treatment: 'THC' }, emmean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
  ],
  pairwise_comparisons: [
    { group1: 'VEH', group2: 'THC', estimate: -2.7, se: 0.4, p_adjusted: 0.002, significant: true, factor: 'treatment' },
  ],
  continuous_effects: [
    { time_value: 1, estimate: -0.5, se: 0.1, p: 0.04, label: 'VEH vs THC|treatment|Week=1' },
    { time_value: 2, estimate: -1.1, se: 0.15, p: 0.01, label: 'VEH vs THC|treatment|Week=2' },
  ],
}

const LMM_RAW_WITH_BOTH_LINE_MODES = {
  ...LMM_RAW,
  per_group_means_over_time: [
    { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
    { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 25.4, se: 0.5, ci_lower: 24.4, ci_upper: 26.4, n: 10 },
    { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
    { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 28.6, se: 0.4, ci_lower: 27.8, ci_upper: 29.4, n: 10 },
  ],
}

const LMM_RAW_BAR_FALLBACK = {
  ...LMM_RAW,
  continuous_effects: null,
  per_group_means_over_time: null,
}

const LMM_STRATIFIED_RAW = {
  success: true,
  test_type: 'lmm_anova_stratified',
  stratified: true,
  stratify_by: ['sex'],
  strata_results: [
    {
      success: true,
      stratum: { sex: 'M' },
      fixed_effects: [],
      estimated_means: [
        { factors: { treatment: 'VEH' }, emmean: 26.0, se: 0.6, ci_lower: 24.8, ci_upper: 27.2, n: 5 },
        { factors: { treatment: 'THC' }, emmean: 29.0, se: 0.5, ci_lower: 28.0, ci_upper: 30.0, n: 5 },
      ],
      pairwise_comparisons: [],
      continuous_effects: null,
    },
  ],
}

function makeLmmResult(rawOutput: unknown, testId = 'lmm_anova'): TestResult {
  return {
    id: 'lmm-rebuild-1',
    testId,
    testName: 'Linear Mixed Model',
    family: 'parametric',
    statisticsFamilyId: 'statistics-1',
    executedAt: new Date('2026-01-01'),
    statistics: {},
    rawOutput,
    plotPayload: {
      test: testId,
      data: { dependent_name: 'Body Weight (g)', value_column: 'Body Weight (g)' },
    },
  }
}

describe('rebuildTestResultPlot — lmm_anova grouped_bar', () => {
  it('returns null for grouped_bar in line-only policy', () => {
    const result = makeLmmResult(LMM_RAW_BAR_FALLBACK)
    const spec = rebuildTestResultPlot(result, 'grouped_bar')
    expect(spec).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Rebuild path — line
// ---------------------------------------------------------------------------

describe('rebuildTestResultPlot — lmm_anova line', () => {
  it('returns a non-null spec for lmm_anova + line when continuous_effects present', () => {
    const result = makeLmmResult(LMM_RAW)
    const spec = rebuildTestResultPlot(result, 'line')
    expect(spec).not.toBeNull()
  })

  it('line spec type is line', () => {
    const result = makeLmmResult(LMM_RAW)
    const spec = rebuildTestResultPlot(result, 'line')
    expect(spec!.plot.type).toBe('line')
  })

  it('line spec title uses LMM semantics (contains "Time Contrast")', () => {
    const result = makeLmmResult(LMM_RAW)
    const spec = rebuildTestResultPlot(result, 'line')
    expect(spec!.plot.title).toContain('Time Contrast')
  })

  it('returns unavailable placeholder for lmm_anova + line when no line payload exists', () => {
    const noLineRaw = { ...LMM_RAW, continuous_effects: null }
    const result = makeLmmResult(noLineRaw)
    const spec = rebuildTestResultPlot(result, 'line')
    expect(spec).not.toBeNull()
    expect(spec!.plot.lmmMode).toBe('line_unavailable')
    expect(spec!.plot.title).toContain('Plot Unavailable')
  })

  it('selects requested lmmMode=contrast when both trajectory and contrast lines exist', () => {
    const result = makeLmmResult(LMM_RAW_WITH_BOTH_LINE_MODES)
    const spec = rebuildTestResultPlot(result, 'line', { lmmMode: 'contrast' })
    expect(spec).not.toBeNull()
    expect(spec!.plot.lmmMode).toBe('contrast')
    expect(spec!.plot.title).toContain('Time Contrast')
  })

  it('selects requested lmmMode=trajectory when both trajectory and contrast lines exist', () => {
    const result = makeLmmResult(LMM_RAW_WITH_BOTH_LINE_MODES)
    const spec = rebuildTestResultPlot(result, 'line', { lmmMode: 'trajectory' })
    expect(spec).not.toBeNull()
    expect(spec!.plot.lmmMode).toBe('trajectory')
    expect(spec!.plot.title).toContain('Trajectory')
  })
})

// ---------------------------------------------------------------------------
// normalizeTestId private alias — lmm_anova_stratified → lmm_anova
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Finding 1: lmmStyleOverrides must be threaded through rebuildTestResultPlot
// ---------------------------------------------------------------------------

const LMM_RAW_FOR_OVERRIDE = {
  success: true,
  test_type: 'lmm_anova',
  stratified: false,
  fixed_effects: [
    { source: 'treatment', f_value: 4.5, p_value: 0.04, num_df: 1, den_df: 20, significant: true },
  ],
  per_group_means_over_time: [
    { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.0, se: 0.5, ci_lower: 24.0, ci_upper: 26.0, n: 10 },
    { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 28.0, se: 0.5, ci_lower: 27.0, ci_upper: 29.0, n: 10 },
  ],
  pairwise_comparisons: [
    { group1: 'VEH', group2: 'THC', estimate: -3.0, se: 0.5, p_adjusted: 0.04, significant: true, factor: 'treatment' },
  ],
  continuous_effects: null,
}

describe('rebuildTestResultPlot — lmmStyleOverrides threading', () => {
  // Default semantic: VEH=baseline(dot) from pairwise group1='VEH'
  // Override with swapStyles=true → VEH=solid, THC=dot

  it('swapStyles override is reflected in rebuilt trajectory trace dashes', () => {
    const result = makeLmmResult(LMM_RAW_FOR_OVERRIDE)
    const key = `${result.id}|pooled|trajectory`
    const lmmStyleOverrides: Record<string, LmmTraceRoleOverride> = {
      [key]: { swapStyles: true },
    }
    const spec = rebuildTestResultPlot(result, 'line', { lmmMode: 'trajectory', lmmStyleOverrides })
    expect(spec).not.toBeNull()
    const traces = spec!.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    // swapStyles inverts semantic: VEH (baseline=dot) becomes solid
    expect(traces.find(t => t.name === 'VEH')?.line?.dash).toBe('solid')
    expect(traces.find(t => t.name === 'THC')?.line?.dash).toBe('dot')
  })

  it('baselineLevel override is reflected in rebuilt trajectory trace dashes', () => {
    const result = makeLmmResult(LMM_RAW_FOR_OVERRIDE)
    const key = `${result.id}|pooled|trajectory`
    const lmmStyleOverrides: Record<string, LmmTraceRoleOverride> = {
      [key]: { baselineLevel: 'THC', contrastLevel: 'VEH' },
    }
    const spec = rebuildTestResultPlot(result, 'line', { lmmMode: 'trajectory', lmmStyleOverrides })
    expect(spec).not.toBeNull()
    const traces = spec!.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    // THC=baseline→dot, VEH=contrast→solid
    expect(traces.find(t => t.name === 'THC')?.line?.dash).toBe('dot')
    expect(traces.find(t => t.name === 'VEH')?.line?.dash).toBe('solid')
  })

  it('no override → default semantic resolution (VEH=dot as baseline)', () => {
    const result = makeLmmResult(LMM_RAW_FOR_OVERRIDE)
    const spec = rebuildTestResultPlot(result, 'line', { lmmMode: 'trajectory' })
    expect(spec).not.toBeNull()
    const traces = spec!.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    expect(traces.find(t => t.name === 'VEH')?.line?.dash).toBe('dot')
    expect(traces.find(t => t.name === 'THC')?.line?.dash).toBe('solid')
  })

  it('override keyed to different result id does not affect this rebuild', () => {
    const result = makeLmmResult(LMM_RAW_FOR_OVERRIDE)
    const lmmStyleOverrides: Record<string, LmmTraceRoleOverride> = {
      'other-result|pooled|trajectory': { swapStyles: true },
    }
    const spec = rebuildTestResultPlot(result, 'line', { lmmMode: 'trajectory', lmmStyleOverrides })
    expect(spec).not.toBeNull()
    const traces = spec!.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    // Default: VEH=dot
    expect(traces.find(t => t.name === 'VEH')?.line?.dash).toBe('dot')
  })
})

describe('rebuildTestResultPlot — lmm_anova_stratified alias', () => {
  it('routes lmm_anova_stratified through LMM rebuild path and returns null for grouped_bar', () => {
    const result = makeLmmResult(LMM_STRATIFIED_RAW, 'lmm_anova_stratified')
    const spec = rebuildTestResultPlot(result, 'grouped_bar')
    expect(spec).toBeNull()
  })

  it('matches alias-safe testType filter when opts.testType uses opposite alias form', () => {
    const result = makeLmmResult(LMM_RAW_WITH_BOTH_LINE_MODES, 'lmm_anova')
    const spec = rebuildTestResultPlot(result, 'line', {
      lmmMode: 'contrast',
      testType: 'lmm_anova_stratified',
    })
    expect(spec).not.toBeNull()
    expect(spec!.plot.lmmMode).toBe('contrast')
  })
})


// ---------------------------------------------------------------------------
// Design invariant: overrides apply only in the rebuild/apply paths,
// not during initial plot generation (buildPlotSpecsFromResult).
//
// buildPlotSpecsFromResult is the customBuilder path — called once when a
// result arrives. No user overrides exist at that point. If this ever changes
// (e.g. a "regenerate" button), this test documents the gap to fix.
// ---------------------------------------------------------------------------

const LMM_RAW_INVARIANT = {
  success: true,
  test_type: 'lmm_anova',
  stratified: false,
  fixed_effects: [],
  estimated_means: [],
  pairwise_comparisons: [],
  continuous_effects: null,
  per_group_means_over_time: [
    { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.0, se: 0.5, ci_lower: 24.0, ci_upper: 26.0, n: 10 },
    { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 28.0, se: 0.5, ci_lower: 27.0, ci_upper: 29.0, n: 10 },
  ],
}

describe('design invariant — overrides apply only in rebuild/apply flows, not initial generation', () => {
  it('buildPlotSpecsFromResult produces default output regardless of what a rebuild with swapStyles would produce', () => {
    const result = makeLmmResult(LMM_RAW_INVARIANT)
    const overrideKey = `${result.id}|pooled|trajectory`
    const overrides: Record<string, LmmTraceRoleOverride> = {
      [overrideKey]: { swapStyles: true },
    }

    // Initial generation — no overrides accepted
    const initialSpecs = buildPlotSpecsFromResult(result)
    const initialTraj = initialSpecs.find(s => s.plot.lmmMode === 'trajectory')

    // Rebuild with override
    const rebuiltSpec = rebuildTestResultPlot(result, 'line', {
      lmmMode: 'trajectory',
      lmmStyleOverrides: overrides,
    })

    expect(initialTraj).toBeDefined()
    expect(rebuiltSpec).not.toBeNull()

    // Initial gen must NOT reflect the override — traces differ
    const initialTraces = initialTraj!.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    const rebuiltTraces = rebuiltSpec!.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>

    const initialVeh = initialTraces.find(t => t.name === 'VEH')?.line?.dash
    const rebuiltVeh = rebuiltTraces.find(t => t.name === 'VEH')?.line?.dash

    // swapStyles inverts VEH: initial=dot (no override), rebuilt=solid (swapStyles override)
    expect(initialVeh).toBe('dot')
    expect(rebuiltVeh).toBe('solid')
    expect(initialVeh).not.toBe(rebuiltVeh)
  })
})
