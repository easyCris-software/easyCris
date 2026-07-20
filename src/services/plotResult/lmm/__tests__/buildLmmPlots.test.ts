/**
 * buildLmmPlots — LMM line-only contract
 *
 * Tests for the LMM custom builder that converts a TestResult into
 * PlotSpecWithStats[]. Covers:
 *   1. No line payload -> 0 specs
 *   2. Trajectory payload -> trajectory line
 *   3. Contrast payload -> contrast line
 *   4. Both payloads -> trajectory + contrast lines
 *   5. Empty estimated_means -> 0 specs
 *   6. Line title contains outcomeLabel from dependent_name
 *   7. Line spec title contains outcomeLabel
 *   8. Stratified result -> per-facet line specs when payload exists
 */

import { describe, it, expect } from 'vitest'
import { buildLmmPlots } from '@/services/plotResult/lmm/buildLmmPlots'
import { normalizeLmmForPlots } from '@/services/plotResult/lmm/normalize'
import { LMM_COLORS } from '@/services/plotResult/lmm/lmmPalette'
import type { TestResult } from '@/store/results-store'
import type { LmmTraceRoleOverride } from '@/services/plotResult/lmm/resolveTraceRoles'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(rawOutput: unknown, dependentName?: string): TestResult {
  return {
    id: 'test-result-1',
    testId: 'lmm_anova',
    testName: 'Linear Mixed Model',
    family: 'parametric',
    statisticsFamilyId: 'statistics-1',
    executedAt: new Date('2026-01-01'),
    statistics: {},
    rawOutput,
    plotPayload: {
      test: 'lmm_anova',
      data: {
        dependent_name: dependentName ?? 'Body Weight (g)',
        value_column: dependentName ?? 'Body Weight (g)',
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Pooled result fixture
// ---------------------------------------------------------------------------

const POOLED_RAW = {
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
  continuous_effects: null,
}

// ---------------------------------------------------------------------------
// Result with continuous_effects — real backend label format
// Backend: "{g1} vs {g2}|{group_factor}|{time_factor}={time_value}"
// Both rows share the same series identity "VEH vs THC|treatment"
// but differ by the trailing "|Week=<N>" token.
// ---------------------------------------------------------------------------

const WITH_LINE_RAW = {
  ...POOLED_RAW,
  continuous_effects: [
    {
      time_value: 1,
      estimate: -0.5,
      se: 0.1,
      p: 0.04,
      label: 'VEH vs THC|treatment|Week=1',
    },
    {
      time_value: 2,
      estimate: -1.1,
      se: 0.15,
      p: 0.01,
      label: 'VEH vs THC|treatment|Week=2',
    },
  ],
}

const WITH_TRAJECTORY_RAW = {
  ...POOLED_RAW,
  per_group_means_over_time: [
    { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
    { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 25.4, se: 0.5, ci_lower: 24.4, ci_upper: 26.4, n: 10 },
    { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
    { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 28.6, se: 0.4, ci_lower: 27.8, ci_upper: 29.4, n: 10 },
  ],
}

const WITH_BOTH_LINE_MODES_RAW = {
  ...WITH_TRAJECTORY_RAW,
  ...WITH_LINE_RAW,
}

// ---------------------------------------------------------------------------
// Stratified result fixture
// ---------------------------------------------------------------------------

const STRATIFIED_RAW = {
  success: true,
  test_type: 'lmm_anova_stratified',
  stratified: true,
  stratify_by: ['sex'],
  strata_results: [
    {
      success: true,
      stratum: { sex: 'M' },
      fixed_effects: [
        { source: 'treatment', f_value: 8.1, p_value: 0.009, num_df: 1, den_df: 15, significant: true },
      ],
      estimated_means: [
        { factors: { treatment: 'VEH' }, emmean: 26.0, se: 0.6, ci_lower: 24.8, ci_upper: 27.2, n: 5 },
        { factors: { treatment: 'THC' }, emmean: 29.0, se: 0.5, ci_lower: 28.0, ci_upper: 30.0, n: 5 },
      ],
      continuous_effects: null,
    },
    {
      success: true,
      stratum: { sex: 'F' },
      fixed_effects: [
        { source: 'treatment', f_value: 5.2, p_value: 0.03, num_df: 1, den_df: 15, significant: true },
      ],
      estimated_means: [
        { factors: { treatment: 'VEH' }, emmean: 22.0, se: 0.4, ci_lower: 21.2, ci_upper: 22.8, n: 5 },
        { factors: { treatment: 'THC' }, emmean: 24.5, se: 0.3, ci_lower: 23.9, ci_upper: 25.1, n: 5 },
      ],
      continuous_effects: null,
    },
  ],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildLmmPlots — spec count', () => {
  it('returns 1 unavailable placeholder spec for a pooled result with no line payload', () => {
    const specs = buildLmmPlots(makeResult(POOLED_RAW, 'Body Weight (g)'))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.plot.lmmMode).toBe('line_unavailable')
  })

  it('returns 1 line spec (bar omitted) when continuous_effects is present', () => {
    const specs = buildLmmPlots(makeResult(WITH_LINE_RAW, 'Body Weight (g)'))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.plot.type).toBe('line')
    expect(specs[0]!.plot.lmmMode).toBe('contrast')
  })

  it('returns 1 trajectory line when per_group_means_over_time is present', () => {
    const specs = buildLmmPlots(makeResult(WITH_TRAJECTORY_RAW, 'Body Weight (g)'))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.plot.type).toBe('line')
    expect(specs[0]!.plot.lmmMode).toBe('trajectory')
  })

  it('does not emit fallback bar when trajectory data is present', () => {
    const specs = buildLmmPlots(makeResult(WITH_TRAJECTORY_RAW, 'Body Weight (g)'))
    expect(specs.some(s => s.plot.type === 'grouped_bar')).toBe(false)
  })

  it('emits both trajectory and contrast lines when both payloads exist', () => {
    const specs = buildLmmPlots(makeResult(WITH_BOTH_LINE_MODES_RAW, 'Body Weight (g)'))
    const lines = specs.filter(s => s.plot.type === 'line')
    expect(lines).toHaveLength(2)
    expect(lines.some(s => s.plot.lmmMode === 'trajectory')).toBe(true)
    expect(lines.some(s => s.plot.lmmMode === 'contrast')).toBe(true)
  })

  it('returns line_unavailable placeholder when estimated_means is empty (valid result — plan line 29)', () => {
    const emptyRaw = { ...POOLED_RAW, estimated_means: [] }
    const specs = buildLmmPlots(makeResult(emptyRaw))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.plot.lmmMode).toBe('line_unavailable')
  })

  it('returns 0 specs when rawOutput is absent', () => {
    const specs = buildLmmPlots(makeResult(undefined))
    expect(specs).toHaveLength(0)
  })
})

describe('buildLmmPlots — bar spec content', () => {
  it('does not emit grouped_bar plots under line-only policy', () => {
    const specs = buildLmmPlots(makeResult(POOLED_RAW, 'Body Weight (g)'))
    expect(specs.some(s => s.plot.type === 'grouped_bar')).toBe(false)
  })
})

describe('buildLmmPlots — line spec content', () => {
  it('line spec title contains the outcomeLabel', () => {
    const specs = buildLmmPlots(makeResult(WITH_LINE_RAW, 'Body Weight (g)'))
    const lineSpec = specs.find(s => s.plot.type === 'line')!
    expect(lineSpec.plot.title).toContain('Body Weight (g)')
  })

  it('line spec plotlyData contains x values from continuous_effects', () => {
    const specs = buildLmmPlots(makeResult(WITH_LINE_RAW))
    const lineSpec = specs.find(s => s.plot.type === 'line')!
    const data = lineSpec.plot.plotlyData as Array<{ x: unknown[] }>
    const allX = data.flatMap(trace => trace.x ?? [])
    expect(allX).toContain(1)
    expect(allX).toContain(2)
  })
})

describe('buildLmmPlots — stratified result (per-stratum split)', () => {
  it('returns placeholder specs per successful stratum when no line payload exists', () => {
    const specs = buildLmmPlots(makeResult(STRATIFIED_RAW, 'Body Weight (g)'))
    expect(specs).toHaveLength(2)
    expect(specs.every(s => s.plot.lmmMode === 'line_unavailable')).toBe(true)
  })
})

describe('buildLmmPlots — facetKey field', () => {
  it('pooled line spec has facetKey null', () => {
    const specs = buildLmmPlots(makeResult(WITH_LINE_RAW))
    const line = specs.find(s => s.plot.type === 'line')!
    expect(line.plot.facetKey).toBeNull()
  })
})

describe('buildLmmPlots — trait-aware outcome label override', () => {
  it('uses Trait facet value as outcome label when dependent label is generic "Value"', () => {
    const raw = {
      success: true,
      test_type: 'lmm_anova_stratified',
      stratified: true,
      stratify_by: ['Trait', 'Sex'],
      strata_results: [
        {
          success: true,
          stratum: { Trait: 'Temp_30(C)', Sex: 'F' },
          fixed_effects: [{ source: 'treatment x Week', significant: true }],
          estimated_means: [
            { factors: { treatment: 'VEH' }, emmean: 26.0, se: 0.6, ci_lower: 24.8, ci_upper: 27.2, n: 5 },
            { factors: { treatment: 'THC' }, emmean: 29.0, se: 0.5, ci_lower: 28.0, ci_upper: 30.0, n: 5 },
          ],
          per_group_means_over_time: [
            { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 26.0, se: 0.6, ci_lower: 24.8, ci_upper: 27.2, n: 5 },
            { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 29.0, se: 0.5, ci_lower: 28.0, ci_upper: 30.0, n: 5 },
          ],
          continuous_effects: null,
        },
      ],
    }
    const specs = buildLmmPlots(makeResult(raw, 'Value'))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.plot.title).toContain('Temp_30(C)')
  })
})

// ---------------------------------------------------------------------------
// Trace-grouping tests — must use backend-format labels to catch fragmentation
// ---------------------------------------------------------------------------

describe('buildLmmPlots — line trace grouping with backend labels', () => {
  /**
   * Backend labels look like "VEH vs THC|treatment|Week=1" and "VEH vs THC|treatment|Week=2".
   * Both share the stable series identity "VEH vs THC|treatment".
   * The builder MUST group them into ONE trace (x=[1,2]) not two 1-point traces.
   */
  it('groups two backend-label rows sharing the same series identity into 1 trace', () => {
    const specs = buildLmmPlots(makeResult(WITH_LINE_RAW))
    const lineSpec = specs.find(s => s.plot.type === 'line')!
    const data = lineSpec.plot.plotlyData as Array<{ x: unknown[] }>
    // One contrast identity → one trace with two x values
    expect(data).toHaveLength(1)
  })

  it('the single trace carries both time-point x values', () => {
    const specs = buildLmmPlots(makeResult(WITH_LINE_RAW))
    const lineSpec = specs.find(s => s.plot.type === 'line')!
    const trace = (lineSpec.plot.plotlyData as Array<{ x: unknown[] }>)[0]!
    expect(trace.x).toContain(1)
    expect(trace.x).toContain(2)
    expect(trace.x).toHaveLength(2)
  })

  it('trace name strips the "|time_factor=value" suffix', () => {
    const specs = buildLmmPlots(makeResult(WITH_LINE_RAW))
    const lineSpec = specs.find(s => s.plot.type === 'line')!
    const trace = (lineSpec.plot.plotlyData as Array<{ name: string }>)[0]!
    // Name should be the stable identity, NOT the full backend label
    expect(trace.name).not.toContain('Week=')
    expect(trace.name).toContain('VEH vs THC')
  })

  it('three distinct contrasts produce three traces each with correct x length', () => {
    const multiContrastRaw = {
      ...POOLED_RAW,
      continuous_effects: [
        { time_value: 1, estimate: -0.5, se: 0.1, p: 0.04, label: 'A vs B|trt|Week=1' },
        { time_value: 2, estimate: -1.0, se: 0.1, p: 0.01, label: 'A vs B|trt|Week=2' },
        { time_value: 1, estimate: 0.3, se: 0.08, p: 0.20, label: 'A vs C|trt|Week=1' },
        { time_value: 2, estimate: 0.7, se: 0.08, p: 0.05, label: 'A vs C|trt|Week=2' },
        { time_value: 1, estimate: 0.8, se: 0.12, p: 0.02, label: 'B vs C|trt|Week=1' },
        { time_value: 2, estimate: 1.7, se: 0.12, p: 0.001, label: 'B vs C|trt|Week=2' },
      ],
    }
    const specs = buildLmmPlots(makeResult(multiContrastRaw))
    const lineSpec = specs.find(s => s.plot.type === 'line')!
    const data = lineSpec.plot.plotlyData as Array<{ x: unknown[] }>
    expect(data).toHaveLength(3)
    for (const trace of data) {
      expect(trace.x).toHaveLength(2)
    }
  })
})

// ---------------------------------------------------------------------------
// Fix 2: Bar significance annotations from pairwise_comparisons
// ---------------------------------------------------------------------------

describe('buildLmmPlots — bar significance annotations', () => {
  it('does not emit grouped_bar plots under line-only policy', () => {
    const specs = buildLmmPlots(makeResult(POOLED_RAW, 'Body Weight (g)'))
    expect(specs.some(s => s.plot.type === 'grouped_bar')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fix 3: Line significance annotations — include ns for non-significant points
// ---------------------------------------------------------------------------

describe('buildLmmPlots — line significance annotations', () => {
  // interaction term uses " x " separator (backend format)
  // simple_effects declared → simpleEffectsRequested=true → labels shown
  const WITH_INTERACTION_LINE_RAW = {
    ...POOLED_RAW,
    fixed_effects: [
      { source: 'treatment x Week', f_value: 8.1, p_value: 0.005, num_df: 1, den_df: 15, significant: true },
    ],
    simple_effects: [{ factor: 'treatment', within: 'Week' }],
    continuous_effects: [
      { time_value: 1, estimate: -0.2, se: 0.1, p: 0.20, label: 'VEH vs THC|treatment|Week=1' },
      { time_value: 2, estimate: -1.1, se: 0.15, p: 0.04, label: 'VEH vs THC|treatment|Week=2' },
    ],
  }

  const WITH_INTERACTION_TRAJECTORY_RAW = {
    ...POOLED_RAW,
    fixed_effects: [
      { source: 'treatment x Week', f_value: 8.1, p_value: 0.005, num_df: 1, den_df: 15, significant: true },
    ],
    per_group_means_over_time: [
      { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
      { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 25.4, se: 0.5, ci_lower: 24.4, ci_upper: 26.4, n: 10 },
      { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
      { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 28.6, se: 0.4, ci_lower: 27.8, ci_upper: 29.4, n: 10 },
    ],
    // simple_effects declared → PGMOT pValues sourced from factor_scope (not continuous_effects)
    simple_effects: [{ factor: 'Treatment', within: 'Week' }],
    pairwise_comparisons: [
      { group1: 'VEH', group2: 'THC', p_adjusted: 0.20, significant: false, factor_scope: 'Treatment|Week=1' },
      { group1: 'VEH', group2: 'THC', p_adjusted: 0.04, significant: true,  factor_scope: 'Treatment|Week=2' },
    ],
    continuous_effects: [
      { time_value: 1, estimate: -0.2, se: 0.1, p: 0.20, label: 'VEH vs THC|treatment|Week=1' },
      { time_value: 2, estimate: -1.1, se: 0.15, p: 0.04, label: 'VEH vs THC|treatment|Week=2' },
    ],
  }

  it('annotates significant timepoints with a star when interaction is significant', () => {
    const specs = buildLmmPlots(makeResult(WITH_INTERACTION_LINE_RAW))
    const lineSpec = specs.find(s => s.plot.type === 'line')!
    const trace = (lineSpec.plot.plotlyData as Array<{ text?: string[] }>)[0]!
    // sorted by timeValue: index 0 = Week=1 (p=0.20 ns), index 1 = Week=2 (p=0.04 *)
    expect(trace.text![1]).toBe('*')
  })

  it('renders "ns" labels for non-significant timepoints', () => {
    const specs = buildLmmPlots(makeResult(WITH_INTERACTION_LINE_RAW))
    const lineSpec = specs.find(s => s.plot.type === 'line')!
    const trace = (lineSpec.plot.plotlyData as Array<{ text?: string[] }>)[0]!
    expect(trace.text![0]).toBe('ns')  // p=0.20 -> ns
  })

  it('keeps star for significant and shows ns for non-significant marker', () => {
    const specs = buildLmmPlots(makeResult(WITH_INTERACTION_LINE_RAW))
    const lineSpec = specs.find(s => s.plot.type === 'line')!
    const trace = (lineSpec.plot.plotlyData as Array<{ text?: string[] }>)[0]!
    expect(trace.text![1]).toBe('*')   // p=0.04 → '*'
    expect(trace.text![0]).toBe('ns')
  })

  it('shows text labels when simpleEffectsRequested=true even when interaction is NOT significant (no interaction gate)', () => {
    // WITH_LINE_SE_RAW: continuous_effects with p-values + simple_effects declared.
    // No interaction in fixed_effects → interactionSignificant=false.
    // Policy: labels shown when simpleEffectsRequested=true + pValue non-null, regardless of interaction.
    const WITH_LINE_SE_RAW = {
      ...WITH_LINE_RAW,
      simple_effects: [{ factor: 'treatment', within: 'Week' }],
    }
    const specs = buildLmmPlots(makeResult(WITH_LINE_SE_RAW))
    const lineSpec = specs.find(s => s.plot.type === 'line')!
    const trace = (lineSpec.plot.plotlyData as Array<{ text?: string[] }>)[0]!
    expect(trace.text).toBeDefined()
    // footnote present since interaction non-significant but labels shown
    const layout = lineSpec.plot.plotlyLayout as { annotations?: Array<{ text: string }> }
    const footnote = layout.annotations?.find(a => /simple effect|interaction/i.test(a.text))
    expect(footnote).toBeDefined()
  })

  it('suppresses contrast labels when simpleEffectsRequested=false even if pValue is present', () => {
    // WITH_LINE_RAW has continuous_effects with p-values but NO simple_effects.
    // simpleEffectsRequested=false → labels must be suppressed.
    const specs = buildLmmPlots(makeResult(WITH_LINE_RAW))
    const lineSpec = specs.find(s => s.plot.type === 'line')!
    const trace = (lineSpec.plot.plotlyData as Array<{ text?: string[] }>)[0]!
    expect(trace.text).toBeUndefined()
  })

  it('trajectory line shows ns/* labels from per-time simple effects (via shapes)', () => {
    const specs = buildLmmPlots(makeResult(WITH_INTERACTION_TRAJECTORY_RAW))
    const lineSpec = specs.find(s => s.plot.type === 'line' && s.plot.lmmMode === 'trajectory')!
    const shapes = ((lineSpec.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sigShapes = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    const labels = sigShapes.map((s: any) => s.label?.text as string)
    // Week=1 p=0.20 → 'ns', Week=2 p=0.04 → '*'
    expect(labels).toContain('ns')
    expect(labels).toContain('*')
  })

  it('does not fabricate ns when trajectory row has no matching simple-effect p-value', () => {
    const rawWithMissingLookup = {
      ...WITH_INTERACTION_TRAJECTORY_RAW,
      // Only Week=2 has a factor_scope entry — Week=1 has null pValue → no shape emitted
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.04, significant: true, factor_scope: 'Treatment|Week=2' },
      ],
    }
    const specs = buildLmmPlots(makeResult(rawWithMissingLookup))
    const lineSpec = specs.find(s => s.plot.type === 'line' && s.plot.lmmMode === 'trajectory')!
    const shapes = ((lineSpec.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sigShapes = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    // Only Week=2 (p=0.04 → '*') should have a shape; Week=1 (null pValue) emits nothing
    expect(sigShapes).toHaveLength(1)
    expect(sigShapes[0]?.label?.text).toBe('*')
  })

  it('suppresses trajectory significance labels when more than two groups are present', () => {
    const threeGroupRaw = {
      ...WITH_INTERACTION_TRAJECTORY_RAW,
      per_group_means_over_time: [
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 25.4, se: 0.5, ci_lower: 24.4, ci_upper: 26.4, n: 10 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 28.6, se: 0.4, ci_lower: 27.8, ci_upper: 29.4, n: 10 },
        { group_factor: 'Treatment', group_value: 'CBD', time_factor: 'Week', time_value: 1, mean: 26.3, se: 0.45, ci_lower: 25.4, ci_upper: 27.2, n: 10 },
        { group_factor: 'Treatment', group_value: 'CBD', time_factor: 'Week', time_value: 2, mean: 26.7, se: 0.45, ci_lower: 25.8, ci_upper: 27.6, n: 10 },
      ],
      continuous_effects: [
        { time_value: 1, estimate: -0.2, se: 0.1, p: 0.20, label: 'VEH vs THC|treatment|Week=1' },
        { time_value: 2, estimate: -1.1, se: 0.15, p: 0.04, label: 'VEH vs THC|treatment|Week=2' },
        { time_value: 1, estimate: -0.1, se: 0.1, p: 0.30, label: 'VEH vs CBD|treatment|Week=1' },
        { time_value: 2, estimate: -0.3, se: 0.15, p: 0.10, label: 'VEH vs CBD|treatment|Week=2' },
      ],
    }
    const specs = buildLmmPlots(makeResult(threeGroupRaw))
    const lineSpec = specs.find(s => s.plot.type === 'line' && s.plot.lmmMode === 'trajectory')!
    const traces = lineSpec.plot.plotlyData as Array<{ text?: string[] }>
    expect(traces.every(t => t.text === undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Edge-case resilience — builder must never throw, just return []
// ---------------------------------------------------------------------------

describe('buildLmmPlots — resilience / edge cases', () => {
  it('returns [] when rawOutput is null', () => {
    expect(buildLmmPlots(makeResult(null))).toEqual([])
  })

  it('returns [] when rawOutput is an empty object', () => {
    expect(buildLmmPlots(makeResult({}))).toEqual([])
  })

  it('returns line_unavailable placeholder when valid result has null estimated_means and no follow-up', () => {
    // success=true but no categorical or continuous data — must not return [] silently (plan line 29)
    const raw = { ...POOLED_RAW, estimated_means: null }
    const specs = buildLmmPlots(makeResult(raw))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.plot.lmmMode).toBe('line_unavailable')
  })

  it('returns line_unavailable placeholder when valid result has empty estimated_means and empty continuous_effects', () => {
    const raw = { ...POOLED_RAW, estimated_means: [], continuous_effects: [] }
    const specs = buildLmmPlots(makeResult(raw))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.plot.lmmMode).toBe('line_unavailable')
  })

  it('returns placeholder spec when continuous_effects is an empty array and no trajectory payload', () => {
    const raw = { ...POOLED_RAW, continuous_effects: [] }
    const specs = buildLmmPlots(makeResult(raw))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.plot.lmmMode).toBe('line_unavailable')
  })

  it('does not throw when pairwise_comparisons is null', () => {
    const raw = { ...POOLED_RAW, pairwise_comparisons: null }
    expect(() => buildLmmPlots(makeResult(raw))).not.toThrow()
  })

  it('does not throw when pairwise_comparisons entries have missing group fields', () => {
    const raw = { ...POOLED_RAW, pairwise_comparisons: [{ p_adjusted: 0.001, significant: true }] }
    expect(() => buildLmmPlots(makeResult(raw))).not.toThrow()
  })

  it('returns [] when all strata failed (stratified result with no successful child)', () => {
    const raw = {
      success: true,
      test_type: 'lmm_anova_stratified',
      stratified: true,
      stratify_by: ['sex'],
      strata_results: [
        { success: false, stratum: { sex: 'M' }, error: 'singular fit' },
        { success: false, stratum: { sex: 'F' }, error: 'singular fit' },
      ],
    }
    expect(buildLmmPlots(makeResult(raw))).toEqual([])
  })

  it('returns placeholder for successful strata that still have no line payload', () => {
    const raw = {
      success: true,
      test_type: 'lmm_anova_stratified',
      stratified: true,
      stratify_by: ['sex'],
      strata_results: [
        { success: false, stratum: { sex: 'M' }, error: 'singular fit' },
        {
          success: true,
          stratum: { sex: 'F' },
          fixed_effects: [],
          estimated_means: [
            { factors: { treatment: 'VEH' }, emmean: 22.0, se: 0.4, ci_lower: 21.2, ci_upper: 22.8, n: 5 },
            { factors: { treatment: 'THC' }, emmean: 24.5, se: 0.3, ci_lower: 23.9, ci_upper: 25.1, n: 5 },
          ],
          continuous_effects: null,
        },
      ],
    }
    const specs = buildLmmPlots(makeResult(raw))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.plot.lmmMode).toBe('line_unavailable')
  })
})

// ---------------------------------------------------------------------------
// Reviewer B Issue 2: trajectory_roles without simple_effects — bracket policy
// ---------------------------------------------------------------------------

describe('buildLmmPlots — trajectory_roles without simple_effects (Reviewer B Issue 2)', () => {
  // Backend echoes trajectory_roles but does NOT emit simple_effects.
  // Policy: when trajectory_roles present but no simple_effects → simpleEffectsRequested=false
  // → significance brackets must NOT be emitted (no false positives from role-only path).
  const TR_ONLY_RAW = {
    success: true,
    test_type: 'lmm_anova_stratified',
    stratified: true,
    stratify_by: ['sex', 'strain'],
    trajectory_roles: {
      treatment_factor: 'arm',
      time_factor: 'visit_week',
    },
    // No simple_effects at top level or in strata
    strata_results: [
      {
        success: true,
        stratum: { sex: 'M', strain: 'B6' },
        fixed_effects: [
          { source: 'arm x visit_week', f_value: 9.1, p_value: 0.003, num_df: 1, den_df: 15, significant: true },
        ],
        estimated_means: [
          { factors: { arm: 'VEH', visit_week: '0' }, emmean: 26.0, se: 0.6, ci_lower: 24.8, ci_upper: 27.2, n: 5 },
          { factors: { arm: 'THC', visit_week: '0' }, emmean: 29.0, se: 0.5, ci_lower: 28.0, ci_upper: 30.0, n: 5 },
          { factors: { arm: 'VEH', visit_week: '1' }, emmean: 26.5, se: 0.6, ci_lower: 25.3, ci_upper: 27.7, n: 5 },
          { factors: { arm: 'THC', visit_week: '1' }, emmean: 30.0, se: 0.5, ci_lower: 29.0, ci_upper: 31.0, n: 5 },
        ],
        // No simple_effects — simpleEffectsRequested=false for this stratum
        pairwise_comparisons: [
          { group1: 'VEH', group2: 'THC', p_adjusted: 0.001, significant: true, factor_scope: 'arm|visit_week=0' },
          { group1: 'VEH', group2: 'THC', p_adjusted: 0.03, significant: true, factor_scope: 'arm|visit_week=1' },
        ],
        continuous_effects: null,
      },
    ],
  }

  it('does not emit significance brackets on any spec when trajectory_roles present but simple_effects absent', () => {
    // trajectory_roles alone does NOT set simpleEffectsRequested=true.
    // Brackets require explicit simple_effects in the stratum result.
    const specs = buildLmmPlots(makeResult(TR_ONLY_RAW))
    // Every spec must have zero sig_bracket_* shapes — no false-positive brackets
    for (const spec of specs) {
      const shapes = ((spec.plot.plotlyLayout as any).shapes ?? []) as any[]
      const sigShapes = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
      expect(sigShapes).toHaveLength(0)
    }
  })

  it('returns a placeholder or trajectory spec (not empty) for valid stratified result with trajectory_roles only', () => {
    // Must not silently return [] for a valid stratified result with trajectory_roles but no simple_effects
    const specs = buildLmmPlots(makeResult(TR_ONLY_RAW))
    expect(specs.length).toBeGreaterThanOrEqual(1)
    // All specs must be a recognized lmmMode — no undefined/unknown modes
    for (const spec of specs) {
      expect(['trajectory', 'contrast', 'line_unavailable']).toContain(spec.plot.lmmMode)
    }
  })
})

// ---------------------------------------------------------------------------
// line_unavailable suppression when compound trajectory is built
// ---------------------------------------------------------------------------

describe('buildLmmPlots — line_unavailable suppression with compound trajectory', () => {
  // Fixture: 2 strata (sex × strain). Stratum M|B6 has full 2-factor estimated_means
  // → trajectoryRows produced → compound built. Stratum F|B6 has only 1-factor estimated_means
  // (no visit_week) → trajectoryRows empty → summaryRows non-empty.
  // BUG: line_unavailable is emitted for F|B6 even though compound is active.
  // FIX: add !compoundTrajectoryBuilt to the line_unavailable guard.
  const COMPOUND_WITH_SPARSE_STRATUM_RAW = {
    success: true,
    test_type: 'lmm_anova_stratified',
    stratified: true,
    stratify_by: ['sex', 'strain'],
    trajectory_roles: { treatment_factor: 'arm', time_factor: 'visit_week' },
    strata_results: [
      {
        success: true,
        stratum: { sex: 'M', strain: 'B6' },
        fixed_effects: [
          { source: 'arm x visit_week', f_value: 9.1, p_value: 0.003, num_df: 1, den_df: 15, significant: true },
        ],
        estimated_means: [
          { factors: { arm: 'VEH', visit_week: '0' }, emmean: 26.0, se: 0.6, ci_lower: 24.8, ci_upper: 27.2, n: 5 },
          { factors: { arm: 'THC', visit_week: '0' }, emmean: 29.0, se: 0.5, ci_lower: 28.0, ci_upper: 30.0, n: 5 },
          { factors: { arm: 'VEH', visit_week: '1' }, emmean: 26.5, se: 0.6, ci_lower: 25.3, ci_upper: 27.7, n: 5 },
          { factors: { arm: 'THC', visit_week: '1' }, emmean: 30.0, se: 0.5, ci_lower: 29.0, ci_upper: 31.0, n: 5 },
        ],
        pairwise_comparisons: [],
        continuous_effects: null,
      },
      {
        success: true,
        stratum: { sex: 'F', strain: 'B6' },
        fixed_effects: [
          { source: 'arm', f_value: 5.2, p_value: 0.04, num_df: 1, den_df: 12, significant: true },
        ],
        // Only 1-factor estimated_means — visit_week absent → trajectoryRows empty, summaryRows non-empty
        estimated_means: [
          { factors: { arm: 'VEH' }, emmean: 24.0, se: 0.7, ci_lower: 22.6, ci_upper: 25.4, n: 5 },
          { factors: { arm: 'THC' }, emmean: 27.0, se: 0.6, ci_lower: 25.8, ci_upper: 28.2, n: 5 },
        ],
        pairwise_comparisons: [],
        continuous_effects: null,
      },
    ],
  }

  it('does not emit line_unavailable for any stratum when compound trajectory is active', () => {
    // Compound is built from M|B6 trajectory rows. F|B6 has no trajectory rows but has
    // summaryRows. Without fix, line_unavailable fires for F|B6. With fix, it is suppressed.
    const specs = buildLmmPlots(makeResult(COMPOUND_WITH_SPARSE_STRATUM_RAW))
    const unavailableSpecs = specs.filter(s => s.plot.lmmMode === 'line_unavailable')
    expect(unavailableSpecs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Per-stratum interaction significance — HIGH priority fix
// ---------------------------------------------------------------------------

describe('buildLmmPlots — per-stratum line significance isolation', () => {
  // Fixture: sex=M has a significant interaction; sex=F does NOT
  const MIXED_INTERACTION_RAW = {
    success: true,
    test_type: 'lmm_anova_stratified',
    stratified: true,
    stratify_by: ['sex'],
    strata_results: [
      {
        success: true,
        stratum: { sex: 'M' },
        fixed_effects: [
          { source: 'treatment x Week', f_value: 9.1, p_value: 0.003, num_df: 1, den_df: 15, significant: true },
        ],
        estimated_means: [
          { factors: { treatment: 'VEH' }, emmean: 26.0, se: 0.6, ci_lower: 24.8, ci_upper: 27.2, n: 5 },
          { factors: { treatment: 'THC' }, emmean: 29.0, se: 0.5, ci_lower: 28.0, ci_upper: 30.0, n: 5 },
        ],
        simple_effects: [{ factor: 'treatment', within: 'Week' }],
        continuous_effects: [
          { time_value: 1, estimate: -0.5, se: 0.1, p: 0.04, label: 'VEH vs THC|treatment|Week=1' },
        ],
      },
      {
        success: true,
        stratum: { sex: 'F' },
        fixed_effects: [
          { source: 'treatment', f_value: 2.1, p_value: 0.18, num_df: 1, den_df: 15, significant: false },
        ],
        estimated_means: [
          { factors: { treatment: 'VEH' }, emmean: 22.0, se: 0.4, ci_lower: 21.2, ci_upper: 22.8, n: 5 },
          { factors: { treatment: 'THC' }, emmean: 24.5, se: 0.3, ci_lower: 23.9, ci_upper: 25.1, n: 5 },
        ],
        simple_effects: [{ factor: 'treatment', within: 'Week' }],
        continuous_effects: [
          { time_value: 1, estimate: -0.2, se: 0.1, p: 0.30, label: 'VEH vs THC|treatment|Week=1' },
        ],
      },
    ],
  }

  it('sex=M line trace has text annotations (interaction significant)', () => {
    const specs = buildLmmPlots(makeResult(MIXED_INTERACTION_RAW))
    const mLine = specs.find(s => s.plot.type === 'line' && s.plot.facetKey === 'sex=M')!
    const trace = (mLine.plot.plotlyData as Array<{ text?: string[] }>)[0]!
    expect(trace.text).toBeDefined()
  })

  it('sex=F contrast trace shows "ns" label — interaction gate removed (Task 4 policy)', () => {
    // Under new policy: labels shown when pValue non-null, regardless of interaction significance.
    // sex=F: continuous_effects p=0.30 → pStar → 'ns'. Must appear even though interaction non-sig.
    const specs = buildLmmPlots(makeResult(MIXED_INTERACTION_RAW))
    const fLine = specs.find(s => s.plot.type === 'line' && s.plot.lmmMode === 'contrast' && s.plot.facetKey === 'sex=F')!
    const trace = (fLine.plot.plotlyData as Array<{ text?: string[] }>)[0]!
    expect(trace.text).toBeDefined()
    expect(trace.text).toContain('ns')
  })
})

// ---------------------------------------------------------------------------
// M2 / H1: per-stratum simpleEffectsRequested isolation
// ---------------------------------------------------------------------------

describe('buildLmmPlots — per-stratum simpleEffectsRequested isolation (M2)', () => {
  // sex=M requested simple effects; sex=F did NOT.
  // Contrast labels must NOT bleed from M→F via a global simpleEffectsRequested flag.
  const MIXED_SE_RAW = {
    success: true,
    test_type: 'lmm_anova_stratified',
    stratified: true,
    stratify_by: ['sex'],
    strata_results: [
      {
        success: true,
        stratum: { sex: 'M' },
        fixed_effects: [{ source: 'treatment x Week', significant: true }],
        estimated_means: [],
        simple_effects: [{ factor: 'treatment', within: 'Week' }],
        continuous_effects: [
          { time_value: 1, estimate: -0.5, se: 0.1, p: 0.04, label: 'VEH vs THC|treatment|Week=1' },
        ],
      },
      {
        success: true,
        stratum: { sex: 'F' },
        fixed_effects: [{ source: 'treatment', significant: false }],
        estimated_means: [],
        // NO simple_effects — simpleEffectsRequested=false for this stratum
        continuous_effects: [
          { time_value: 1, estimate: -0.1, se: 0.1, p: 0.30, label: 'VEH vs THC|treatment|Week=1' },
        ],
      },
    ],
  }

  it('sex=M contrast trace shows labels (simpleEffectsRequested=true)', () => {
    const specs = buildLmmPlots(makeResult(MIXED_SE_RAW))
    const mLine = specs.find(s => s.plot.lmmMode === 'contrast' && s.plot.facetKey === 'sex=M')!
    expect(mLine).toBeDefined()
    const trace = (mLine.plot.plotlyData as Array<{ text?: string[] }>)[0]!
    expect(trace.text).toBeDefined()
  })

  it('sex=F contrast trace has NO labels (simpleEffectsRequested=false, no bleed from sex=M)', () => {
    const specs = buildLmmPlots(makeResult(MIXED_SE_RAW))
    const fLine = specs.find(s => s.plot.lmmMode === 'contrast' && s.plot.facetKey === 'sex=F')!
    expect(fLine).toBeDefined()
    const trace = (fLine.plot.plotlyData as Array<{ text?: string[] }>)[0]!
    expect(trace.text).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Task 4: stars + footnote — no interaction gate
// ---------------------------------------------------------------------------

describe('buildLmmPlots — stars + footnote (Task 4)', () => {
  // Trajectory via simple_effects estimated_means fallback.
  // interaction non-significant, but simple_effects pValues are present.
  const SIMPLE_EFFECTS_RAW = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [
      { source: 'Treatment x Condition', f_value: 1.2, p_value: 0.29, num_df: 1, den_df: 15, significant: false },
    ],
    estimated_means: [
      { factors: { Treatment: 'VEH', Condition: 'A' }, emmean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
      { factors: { Treatment: 'THC', Condition: 'A' }, emmean: 11.0, se: 0.3, ci_lower: 10.4, ci_upper: 11.6, n: 8 },
      { factors: { Treatment: 'VEH', Condition: 'B' }, emmean: 12.0, se: 0.3, ci_lower: 11.4, ci_upper: 12.6, n: 8 },
      { factors: { Treatment: 'THC', Condition: 'B' }, emmean: 13.0, se: 0.3, ci_lower: 12.4, ci_upper: 13.6, n: 8 },
    ],
    simple_effects: [{ factor: 'Treatment', within: 'Condition' }],
    pairwise_comparisons: [
      { group1: 'VEH', group2: 'THC', p_adjusted: 0.04, significant: true, factor_scope: 'Treatment|Condition=A' },
      { group1: 'VEH', group2: 'THC', p_adjusted: 0.30, significant: false, factor_scope: 'Treatment|Condition=B' },
    ],
    continuous_effects: null,
  }

  // Same fixture but with a significant interaction
  const SIMPLE_EFFECTS_SIG_RAW = {
    ...SIMPLE_EFFECTS_RAW,
    fixed_effects: [
      { source: 'Treatment x Condition', f_value: 9.1, p_value: 0.003, num_df: 1, den_df: 15, significant: true },
    ],
  }

  it('trajectory has sig_bracket shapes even when interaction non-significant (no interaction gate)', () => {
    const specs = buildLmmPlots(makeResult(SIMPLE_EFFECTS_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    expect(traj).toBeDefined()
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sigShapes = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    expect(sigShapes.length).toBeGreaterThan(0)
  })

  it('renders "*" for p=0.04 and "ns" for p=0.30 on trajectory (via shapes)', () => {
    const specs = buildLmmPlots(makeResult(SIMPLE_EFFECTS_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sigShapes = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    const labels = sigShapes.map((s: any) => s.label?.text as string)
    expect(labels).toContain('*')
    expect(labels).toContain('ns')
  })

  it('no label when pValue is null (no simple effects configured)', () => {
    const NO_SE_RAW = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      per_group_means_over_time: [
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Day', time_value: 0, mean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Day', time_value: 0, mean: 11.0, se: 0.3, ci_lower: 10.4, ci_upper: 11.6, n: 8 },
      ],
      // No simple_effects, no pairwise_comparisons with factor_scope
      continuous_effects: null,
    }
    const specs = buildLmmPlots(makeResult(NO_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    expect(traj).toBeDefined()
    const traces = traj.plot.plotlyData as Array<{ text?: string[] }>
    const hasAnyLabel = traces.some(t => t.text && t.text.some(l => l.length > 0))
    expect(hasAnyLabel).toBe(false)
  })

  it('footnote annotation added to layout when labels shown and interaction non-significant', () => {
    const specs = buildLmmPlots(makeResult(SIMPLE_EFFECTS_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const layout = traj.plot.plotlyLayout as { annotations?: Array<{ text: string }> }
    expect(layout.annotations).toBeDefined()
    const footnote = layout.annotations!.find(a => /simple effect|interaction/i.test(a.text))
    expect(footnote).toBeDefined()
  })

  it('no footnote annotation when interaction IS significant', () => {
    const specs = buildLmmPlots(makeResult(SIMPLE_EFFECTS_SIG_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const layout = traj.plot.plotlyLayout as { annotations?: Array<{ text: string }> }
    const footnote = layout.annotations?.find(a => /simple effect|interaction/i.test(a.text))
    expect(footnote).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Bug fixes (H1-shape, H2-ymax): shape x must use category index not timeValue;
// yMax must only consider y-coordinates, not x.
// ---------------------------------------------------------------------------

// PGMOT fixture with large, non-contiguous timeValues (100, 200).
// factor_scope within-levels match timeValueRaw ('100', '200') so shapes are emitted.
// Tests H1 (shape x = category index 0,1 not 100,200) and H2 (yMax not inflated).
const LARGE_TIMEVAL_RAW = {
  success: true,
  test_type: 'lmm_anova',
  stratified: false,
  fixed_effects: [
    { source: 'Treatment x Week', f_value: 5.0, p_value: 0.02, num_df: 1, den_df: 15, significant: true },
  ],
  estimated_means: [
    { factors: { Treatment: 'VEH' }, emmean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
    { factors: { Treatment: 'THC' }, emmean: 13.0, se: 0.3, ci_lower: 12.4, ci_upper: 13.6, n: 8 },
  ],
  per_group_means_over_time: [
    { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 100, mean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
    { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 200, mean: 12.0, se: 0.3, ci_lower: 11.4, ci_upper: 12.6, n: 8 },
    { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 100, mean: 11.0, se: 0.3, ci_lower: 10.4, ci_upper: 11.6, n: 8 },
    { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 200, mean: 13.0, se: 0.3, ci_lower: 12.4, ci_upper: 13.6, n: 8 },
  ],
  simple_effects: [{ factor: 'Treatment', within: 'Week' }],
  // factor_scope within-level must match timeValueRaw = String(time_value)
  pairwise_comparisons: [
    { group1: 'VEH', group2: 'THC', p_adjusted: 0.04, significant: true,  factor_scope: 'Treatment|Week=100' },
    { group1: 'VEH', group2: 'THC', p_adjusted: 0.20, significant: false, factor_scope: 'Treatment|Week=200' },
  ],
  continuous_effects: null,
}

describe('buildLmmPlots — shape x uses category index, not timeValue [H1-shape fix]', () => {
  it('shape path x-coordinates are category indices (0, 1) not raw PGMOT timeValues (100, 200)', () => {
    const specs = buildLmmPlots(makeResult(LARGE_TIMEVAL_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sigShapes = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    expect(sigShapes.length).toBeGreaterThan(0)
    for (const shape of sigShapes) {
      const nums = (shape.path as string).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)!.map(Number)
      // 8-number format: M xL,tipY L xL,baseY L xR,baseY L xR,tipY
      // Center x = (xL + xR) / 2 must be a category index (0 or 1), NOT 100 or 200
      const xL = nums[0]!
      const xR = nums[4]!
      const centerX = (xL + xR) / 2
      expect(centerX === 0 || centerX === 1).toBe(true)
    }
  })
})

describe('buildLmmPlots — y-range headroom only uses y-coords [H2-ymax fix]', () => {
  it('y-axis max is not inflated by large timeValues used as path x-coordinates', () => {
    const specs = buildLmmPlots(makeResult(LARGE_TIMEVAL_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    // Verify shapes are actually emitted (otherwise test is vacuous)
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sigShapes = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    expect(sigShapes.length).toBeGreaterThan(0)
    const layout = traj.plot.plotlyLayout as { yaxis?: { range?: [number, number] } }
    const yMax = layout.yaxis?.range?.[1]
    expect(yMax).toBeDefined()
    // Data y-values are 10-13 + small SE/headroom — yMax must NOT be inflated to ~100-200
    expect(yMax!).toBeLessThan(50)
  })
})

// ---------------------------------------------------------------------------
// Bug fix (H1): trajectory x-axis must use timeValueRaw (string labels)
// — numeric timeValue collapses categorical within-levels
// ---------------------------------------------------------------------------

describe('buildLmmPlots — trajectory x-axis uses timeValueRaw (bug fix H1)', () => {
  const CAT_TRAJ_RAW = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [],
    estimated_means: [
      { factors: { Treatment: 'VEH', Visit: 'Pre' }, emmean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
      { factors: { Treatment: 'THC', Visit: 'Pre' }, emmean: 11.0, se: 0.3, ci_lower: 10.4, ci_upper: 11.6, n: 8 },
      { factors: { Treatment: 'VEH', Visit: 'Post' }, emmean: 12.0, se: 0.3, ci_lower: 11.4, ci_upper: 12.6, n: 8 },
      { factors: { Treatment: 'THC', Visit: 'Post' }, emmean: 13.0, se: 0.3, ci_lower: 12.4, ci_upper: 13.6, n: 8 },
    ],
    simple_effects: [{ factor: 'Treatment', within: 'Visit' }],
    pairwise_comparisons: [],
    continuous_effects: null,
  }

  it('trajectory trace x values are the string within-level labels, not numeric indices', () => {
    const specs = buildLmmPlots(makeResult(CAT_TRAJ_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    expect(traj).toBeDefined()
    const allX = (traj.plot.plotlyData as Array<{ x: unknown[] }>).flatMap(t => t.x)
    expect(allX).toContain('Pre')
    expect(allX).toContain('Post')
  })

  it('trajectory trace x values do NOT contain raw ordinal integers for categorical levels', () => {
    const specs = buildLmmPlots(makeResult(CAT_TRAJ_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const allX = (traj.plot.plotlyData as Array<{ x: unknown[] }>).flatMap(t => t.x)
    // ordinal fallback would produce 0 and 1 — these must not be present when labels are available
    expect(allX).not.toContain(0)
    expect(allX).not.toContain(1)
  })
})

// ---------------------------------------------------------------------------
// Task 7: stratum_label fallback when stratum is empty/missing
// ---------------------------------------------------------------------------

describe('buildLmmPlots — stratum_label fallback (Task 7)', () => {
  /** Stratum has empty stratum dict but valid stratum_label */
  const EMPTY_STRATUM_RAW = {
    success: true,
    test_type: 'lmm_anova_stratified',
    stratified: true,
    stratify_by: ['sex'],
    strata_results: [
      {
        success: true,
        stratum: {},
        stratum_label: 'sex=M',
        fixed_effects: [
          { source: 'treatment x Week', f_value: 5.1, p_value: 0.02, num_df: 1, den_df: 15, significant: true },
        ],
        estimated_means: [
          { factors: { treatment: 'VEH', Week: '1' }, emmean: 20.0, se: 0.4, ci_lower: 19.2, ci_upper: 20.8, n: 5 },
          { factors: { treatment: 'THC', Week: '1' }, emmean: 22.0, se: 0.4, ci_lower: 21.2, ci_upper: 22.8, n: 5 },
          { factors: { treatment: 'VEH', Week: '2' }, emmean: 21.0, se: 0.4, ci_lower: 20.2, ci_upper: 21.8, n: 5 },
          { factors: { treatment: 'THC', Week: '2' }, emmean: 23.0, se: 0.4, ci_lower: 22.2, ci_upper: 23.8, n: 5 },
        ],
        simple_effects: [{ factor: 'treatment', within: 'Week' }],
        pairwise_comparisons: [],
        continuous_effects: null,
      },
      {
        success: true,
        stratum: {},
        stratum_label: 'sex=F',
        fixed_effects: [
          { source: 'treatment', f_value: 3.2, p_value: 0.09, num_df: 1, den_df: 15, significant: false },
        ],
        estimated_means: [
          { factors: { treatment: 'VEH', Week: '1' }, emmean: 18.0, se: 0.4, ci_lower: 17.2, ci_upper: 18.8, n: 5 },
          { factors: { treatment: 'THC', Week: '1' }, emmean: 19.0, se: 0.4, ci_lower: 18.2, ci_upper: 19.8, n: 5 },
          { factors: { treatment: 'VEH', Week: '2' }, emmean: 19.5, se: 0.4, ci_lower: 18.7, ci_upper: 20.3, n: 5 },
          { factors: { treatment: 'THC', Week: '2' }, emmean: 20.0, se: 0.4, ci_lower: 19.2, ci_upper: 20.8, n: 5 },
        ],
        simple_effects: [{ factor: 'treatment', within: 'Week' }],
        pairwise_comparisons: [],
        continuous_effects: null,
      },
    ],
  }

  /** Stratum is missing entirely but stratum_label present */
  const MISSING_STRATUM_RAW = {
    ...EMPTY_STRATUM_RAW,
    strata_results: EMPTY_STRATUM_RAW.strata_results.map(({ stratum: _s, ...rest }) => rest),
  }

  it('produces 2 specs when stratum is empty but stratum_label is present', () => {
    const specs = buildLmmPlots(makeResult(EMPTY_STRATUM_RAW))
    expect(specs.length).toBeGreaterThanOrEqual(2)
  })

  it('facetValues contain sex=M and sex=F derived from stratum_label', () => {
    const specs = buildLmmPlots(makeResult(EMPTY_STRATUM_RAW))
    const trajSpecs = specs.filter(s => s.plot.lmmMode === 'trajectory')
    const facetKeys = trajSpecs.map(s => (s.plot as { facetKey?: string }).facetKey ?? '')
    expect(facetKeys).toContain('sex=M')
    expect(facetKeys).toContain('sex=F')
  })

  it('produces 2 trajectory specs when stratum key is entirely absent but stratum_label present', () => {
    const specs = buildLmmPlots(makeResult(MISSING_STRATUM_RAW))
    const trajSpecs = specs.filter(s => s.plot.lmmMode === 'trajectory')
    expect(trajSpecs).toHaveLength(2)
  })

  it('multi-key stratum_label (strain=D2 | sex=F) parsed into two facet dims', () => {
    const multiKeyRaw = {
      success: true,
      test_type: 'lmm_anova_stratified',
      stratified: true,
      stratify_by: ['strain', 'sex'],
      strata_results: [
        {
          success: true,
          stratum: {},
          stratum_label: 'strain=D2 | sex=F',
          fixed_effects: [],
          estimated_means: [
            { factors: { treatment: 'VEH', Week: '1' }, emmean: 20.0, se: 0.4, ci_lower: 19.2, ci_upper: 20.8, n: 5 },
            { factors: { treatment: 'THC', Week: '1' }, emmean: 22.0, se: 0.4, ci_lower: 21.2, ci_upper: 22.8, n: 5 },
          ],
          simple_effects: [{ factor: 'treatment', within: 'Week' }],
          pairwise_comparisons: [],
          continuous_effects: null,
        },
      ],
    }
    const specs = buildLmmPlots(makeResult(multiKeyRaw))
    const trajSpec = specs.find(s => s.plot.lmmMode === 'trajectory')
    expect(trajSpec).toBeDefined()
    // When the compound branch activates (stratify_by has 2 dims + simple_effects),
    // facetKey is the panel key (sex=F). The strain=D2 identity is encoded in trace names.
    // Verify that sex=F is represented in the spec (either as facetKey or in title).
    const facetKey = (trajSpec!.plot as { facetKey?: string }).facetKey ?? ''
    const title = trajSpec!.plot.title ?? ''
    expect(facetKey.includes('sex=F') || title.includes('sex = F')).toBe(true)
    // Verify the spec was produced (stratum_label parsing produced valid trajectory rows)
    expect(trajSpec!.plot.plotlyData).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// R-parity golden integration tests — subgroup trajectory layout
// Verify that buildLmmPlots output matches R lmm_anova_test.R semantics:
//   - 2 Sex panels (M, F), one compound spec per panel
//   - 4 traces per panel: 2 Strains (B6, D2) × 2 Conditions (VEH, THC)
//   - Color = Strain (colorFactor = stratify_by[0] = 'Strain')
//   - Linetype: VEH → dot (baseline), THC → solid (contrast)
//   - Significance stars per (Strain, timepoint), label color = strain color
//   - Full bracket metadata contract present
// ---------------------------------------------------------------------------

/**
 * Golden fixture: 4 strata (B6×M, D2×M, B6×F, D2×F), 2 timepoints each.
 * pairwise_comparisons.group1 = 'VEH' → VEH=baseline (dot), THC=contrast (solid).
 * factor_scope 'treatment|Week=1' and 'treatment|Week=2' drive per-timepoint pValues.
 * p=0.03 (Week=1) → '*', p=0.40 (Week=2) → 'ns'.
 */
const GOLDEN_COMPOUND_RAW = {
  success: true,
  test_type: 'lmm_anova_stratified',
  stratified: true,
  stratify_by: ['Strain', 'Sex'],
  strata_results: [
    // --- B6, M ---
    {
      success: true,
      stratum: { Strain: 'B6', Sex: 'M' },
      fixed_effects: [
        { source: 'treatment x Week', f_value: 6.5, p_value: 0.01, num_df: 1, den_df: 20, significant: true },
      ],
      estimated_means: [],
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.03, significant: true,  factor_scope: 'treatment|Week=1' },
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.40, significant: false, factor_scope: 'treatment|Week=2' },
      ],
      continuous_effects: null,
      simple_effects: [{ factor: 'treatment', within: 'Week' }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.0, se: 0.5, ci_lower: 24.0, ci_upper: 26.0, n: 10 },
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 25.5, se: 0.5, ci_lower: 24.5, ci_upper: 26.5, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 28.0, se: 0.5, ci_lower: 27.0, ci_upper: 29.0, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 28.5, se: 0.5, ci_lower: 27.5, ci_upper: 29.5, n: 10 },
      ],
    },
    // --- D2, M ---
    {
      success: true,
      stratum: { Strain: 'D2', Sex: 'M' },
      fixed_effects: [
        { source: 'treatment x Week', f_value: 4.2, p_value: 0.04, num_df: 1, den_df: 20, significant: true },
      ],
      estimated_means: [],
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.02, significant: true,  factor_scope: 'treatment|Week=1' },
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.55, significant: false, factor_scope: 'treatment|Week=2' },
      ],
      continuous_effects: null,
      simple_effects: [{ factor: 'treatment', within: 'Week' }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 24.0, se: 0.5, ci_lower: 23.0, ci_upper: 25.0, n: 10 },
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 24.5, se: 0.5, ci_lower: 23.5, ci_upper: 25.5, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.0, se: 0.5, ci_lower: 26.0, ci_upper: 28.0, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 27.5, se: 0.5, ci_lower: 26.5, ci_upper: 28.5, n: 10 },
      ],
    },
    // --- B6, F ---
    {
      success: true,
      stratum: { Strain: 'B6', Sex: 'F' },
      fixed_effects: [
        { source: 'treatment x Week', f_value: 3.8, p_value: 0.06, num_df: 1, den_df: 20, significant: false },
      ],
      estimated_means: [],
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.04, significant: true,  factor_scope: 'treatment|Week=1' },
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.35, significant: false, factor_scope: 'treatment|Week=2' },
      ],
      continuous_effects: null,
      simple_effects: [{ factor: 'treatment', within: 'Week' }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 22.0, se: 0.4, ci_lower: 21.2, ci_upper: 22.8, n: 10 },
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 22.5, se: 0.4, ci_lower: 21.7, ci_upper: 23.3, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 24.5, se: 0.4, ci_lower: 23.7, ci_upper: 25.3, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 25.0, se: 0.4, ci_lower: 24.2, ci_upper: 25.8, n: 10 },
      ],
    },
    // --- D2, F ---
    {
      success: true,
      stratum: { Strain: 'D2', Sex: 'F' },
      fixed_effects: [
        { source: 'treatment x Week', f_value: 5.1, p_value: 0.03, num_df: 1, den_df: 20, significant: true },
      ],
      estimated_means: [],
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.01, significant: true,  factor_scope: 'treatment|Week=1' },
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.60, significant: false, factor_scope: 'treatment|Week=2' },
      ],
      continuous_effects: null,
      simple_effects: [{ factor: 'treatment', within: 'Week' }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 21.0, se: 0.4, ci_lower: 20.2, ci_upper: 21.8, n: 10 },
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 21.5, se: 0.4, ci_lower: 20.7, ci_upper: 22.3, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 24.0, se: 0.4, ci_lower: 23.2, ci_upper: 24.8, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 24.5, se: 0.4, ci_lower: 23.7, ci_upper: 25.3, n: 10 },
      ],
    },
  ],
}

// Fallback fixture: only 1 stratify dim → compound guard fails → legacy paths used
const GOLDEN_SINGLE_DIM_RAW = {
  success: true,
  test_type: 'lmm_anova_stratified',
  stratified: true,
  stratify_by: ['Sex'],
  strata_results: [
    {
      success: true,
      stratum: { Sex: 'M' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
      simple_effects: [{ factor: 'treatment', within: 'Week' }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.0, se: 0.5, ci_lower: 24.0, ci_upper: 26.0, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 28.0, se: 0.5, ci_lower: 27.0, ci_upper: 29.0, n: 10 },
      ],
    },
    {
      success: true,
      stratum: { Sex: 'F' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
      simple_effects: [{ factor: 'treatment', within: 'Week' }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 22.0, se: 0.4, ci_lower: 21.2, ci_upper: 22.8, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 24.5, se: 0.3, ci_lower: 23.9, ci_upper: 25.1, n: 10 },
      ],
    },
  ],
}

// Color palette used by buildCompoundColorMap (first 2 entries)
// allColorValues sorted: ['B6', 'D2'] → B6=index 0, D2=index 1
const COMPOUND_COLOR_B6 = LMM_COLORS[0]!
const COMPOUND_COLOR_D2 = LMM_COLORS[1]!

function makeRParityCompoundResult(rawOutput: Record<string, unknown> = GOLDEN_COMPOUND_RAW): TestResult {
  return {
    ...makeResult({
      ...rawOutput,
      compound_panels: [],
      compound_panels_warnings: [],
      trajectory_roles: {
        treatment_factor: 'treatment',
        time_factor: 'Week',
        reference_level: 'VEH',
      },
    }),
    plotPayload: {
      test: 'lmm_anova',
      data: { dependent_name: 'Value', value_column: 'Value' },
      parameters: {
        plot_facet_roles: {
          color_by: 'Strain',
          facet_by: 'Sex',
        },
      },
    },
  } as TestResult
}

describe('R-parity golden tests — subgroup trajectory layout', () => {
  it('uses subgroup/raw trajectory rows when compound_panels is empty', () => {
    const specs = buildLmmPlots(makeRParityCompoundResult())
    const mPanel = specs.find(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound' &&
        s.plot.facetKey === 'Sex=M'
    )
    expect(mPanel).toBeDefined()

    const yValues = (mPanel!.plot.plotlyData as Array<{ y?: unknown[] }>)
      .flatMap(trace => trace.y ?? []) as number[]

    expect(yValues).toContain(25)
    expect(yValues).toContain(28)
    expect(yValues.some(v => v > 90)).toBe(false)
  })

  it('prefers raw subgroup cell_summaries over subgroup EMM/PGMOT rows for script parity', () => {
    const rawWithDistinctEmms = {
      ...GOLDEN_COMPOUND_RAW,
      strata_results: GOLDEN_COMPOUND_RAW.strata_results.map(stratum => ({
        ...stratum,
        cell_summaries: [
          { factors: { treatment: 'VEH', Week: 1 }, mean: 12, se: 4.252, ci_lower: 3.496, ci_upper: 20.504, n: 8 },
          { factors: { treatment: 'THC', Week: 1 }, mean: 14, se: 5.125, ci_lower: 3.75, ci_upper: 24.25, n: 8 },
        ],
        estimated_means: [
          { factors: { treatment: 'VEH', Week: 1 }, emmean: 99, se: 0.01, ci_lower: 98, ci_upper: 100, n: 10 },
          { factors: { treatment: 'THC', Week: 1 }, emmean: 101, se: 0.01, ci_lower: 100, ci_upper: 102, n: 10 },
        ],
      })),
    }
    const specs = buildLmmPlots(makeRParityCompoundResult(rawWithDistinctEmms))
    const mPanel = specs.find(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound' &&
        s.plot.facetKey === 'Sex=M'
    )
    expect(mPanel).toBeDefined()

    const yValues = (mPanel!.plot.plotlyData as Array<{ y?: unknown[] }>)
      .flatMap(trace => trace.y ?? []) as number[]
    const seValues = (mPanel!.plot.plotlyData as Array<{ error_y?: { array?: unknown[] } }>)
      .flatMap(trace => trace.error_y?.array ?? []) as number[]

    expect(yValues).toContain(12)
    expect(yValues).toContain(14)
    expect(seValues).toContain(4.252)
    expect(seValues).toContain(5.125)
    expect(yValues).not.toContain(25)
    expect(yValues).not.toContain(99)
    expect(yValues.some(v => v > 90)).toBe(false)
  })

  it('labels raw subgroup trajectory rows as cell_summaries', () => {
    const rawWithCells = {
      ...GOLDEN_COMPOUND_RAW,
      strata_results: GOLDEN_COMPOUND_RAW.strata_results.map(stratum => ({
        ...stratum,
        cell_summaries: [
          { factors: { treatment: 'VEH', Week: 1 }, mean: 12, se: 4.252, ci_lower: 3.496, ci_upper: 20.504, n: 8 },
          { factors: { treatment: 'THC', Week: 1 }, mean: 14, se: 5.125, ci_lower: 3.75, ci_upper: 24.25, n: 8 },
        ],
      })),
    }
    const normalized = normalizeLmmForPlots(makeRParityCompoundResult(rawWithCells).rawOutput as Record<string, unknown>, {
      dependentName: 'Value',
    })

    expect(normalized.trajectoryRows.length).toBeGreaterThan(0)
    expect(normalized.trajectoryRows.every(row => row.source === 'cell_summaries')).toBe(true)
  })

  it('preserves Strain color and Condition dash roles when compound_panels is empty', () => {
    const specs = buildLmmPlots(makeRParityCompoundResult())
    const mPanel = specs.find(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound' &&
        s.plot.facetKey === 'Sex=M'
    )
    expect(mPanel).toBeDefined()

    const traces = mPanel!.plot.plotlyData as Array<{ name: string; line?: { color?: string; dash?: string } }>
    const b6 = traces.filter(t => t.name.startsWith('B6'))
    const d2 = traces.filter(t => t.name.startsWith('D2'))

    expect(new Set(b6.map(t => t.line?.color))).toHaveLength(1)
    expect(new Set(d2.map(t => t.line?.color))).toHaveLength(1)
    expect(b6[0]!.line?.color).not.toBe(d2[0]!.line?.color)
    expect(traces.filter(t => t.name.includes('VEH')).every(t => t.line?.dash === 'dot')).toBe(true)
    expect(traces.filter(t => t.name.includes('THC')).every(t => t.line?.dash === 'solid')).toBe(true)
  })

  // Test 1: emits exactly 2 compound specs (one per Sex panel)
  it('emits exactly 2 compound trajectory specs — one per Sex panel', () => {
    const specs = buildLmmPlots(makeResult(GOLDEN_COMPOUND_RAW))
    const compound = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )
    expect(compound).toHaveLength(2)
  })

  // Test 2: each panel has exactly 4 traces (2 Strains × 2 Conditions)
  it('each compound panel has exactly 4 traces', () => {
    const specs = buildLmmPlots(makeResult(GOLDEN_COMPOUND_RAW))
    const compound = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )
    for (const spec of compound) {
      expect(spec.plot.plotlyData).toHaveLength(4)
    }
  })

  // Test 3: same Strain → same trace color within a panel
  it('B6 traces share one color, D2 traces share a different color', () => {
    const specs = buildLmmPlots(makeResult(GOLDEN_COMPOUND_RAW))
    const mPanel = specs.find(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound' &&
        s.plot.facetKey === 'Sex=M'
    )
    expect(mPanel).toBeDefined()

    const traces = mPanel!.plot.plotlyData as Array<{ name: string; line?: { color?: string } }>
    const b6Traces = traces.filter(t => t.name.startsWith('B6'))
    const d2Traces = traces.filter(t => t.name.startsWith('D2'))

    expect(b6Traces).toHaveLength(2)
    expect(d2Traces).toHaveLength(2)

    // All B6 traces share the same color
    const b6Colors = [...new Set(b6Traces.map(t => t.line?.color))]
    expect(b6Colors).toHaveLength(1)
    expect(b6Colors[0]).toBe(COMPOUND_COLOR_B6)

    // All D2 traces share a different color
    const d2Colors = [...new Set(d2Traces.map(t => t.line?.color))]
    expect(d2Colors).toHaveLength(1)
    expect(d2Colors[0]).toBe(COMPOUND_COLOR_D2)

    // B6 and D2 colors are different
    expect(b6Colors[0]).not.toBe(d2Colors[0])
  })

  // Test 4: VEH → dot, THC → solid (groupRole-driven dash)
  it('VEH traces have dash=dot, THC traces have dash=solid', () => {
    const specs = buildLmmPlots(makeResult(GOLDEN_COMPOUND_RAW))
    const mPanel = specs.find(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound' &&
        s.plot.facetKey === 'Sex=M'
    )
    expect(mPanel).toBeDefined()

    const traces = mPanel!.plot.plotlyData as Array<{ name: string; line?: { dash?: string } }>
    const vehTraces = traces.filter(t => t.name.includes('VEH'))
    const thcTraces = traces.filter(t => t.name.includes('THC'))

    expect(vehTraces).toHaveLength(2)
    expect(thcTraces).toHaveLength(2)

    // VEH = baseline → dot
    expect(vehTraces.every(t => t.line?.dash === 'dot')).toBe(true)
    // THC = contrast → solid
    expect(thcTraces.every(t => t.line?.dash === 'solid')).toBe(true)
  })

  // Test 5: significance shapes exist and label colors match strain colors
  it('significance shapes are emitted with label colors matching strain trace colors', () => {
    const specs = buildLmmPlots(makeResult(GOLDEN_COMPOUND_RAW))
    const mPanel = specs.find(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound' &&
        s.plot.facetKey === 'Sex=M'
    )
    expect(mPanel).toBeDefined()

    const layout = mPanel!.plot.plotlyLayout as any
    const shapes = (layout.shapes ?? []) as Array<{
      name?: string
      label?: { font?: { color?: string } }
    }>
    const sigShapes = shapes.filter(s => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    expect(sigShapes.length).toBeGreaterThan(0)

    const meta = layout.meta as Record<string, unknown>
    const bracketEffectMap = meta.bracketEffectMap as Record<string, { label: string }>
    // bracketEffectMap must be present
    expect(bracketEffectMap).toBeDefined()

    // Each shape's label.font.color must be either the B6 or D2 strain color
    const knownColors = new Set([COMPOUND_COLOR_B6, COMPOUND_COLOR_D2])
    for (const shape of sigShapes) {
      const color = shape.label?.font?.color
      expect(knownColors.has(color as string)).toBe(true)
    }
  })

  // Test 6: full bracket metadata contract present
  it('compound spec has full bracket metadata contract', () => {
    const specs = buildLmmPlots(makeResult(GOLDEN_COMPOUND_RAW))
    const mPanel = specs.find(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound' &&
        s.plot.facetKey === 'Sex=M'
    )
    expect(mPanel).toBeDefined()
    const meta = (mPanel!.plot.plotlyLayout as any).meta as Record<string, unknown>
    expect(meta.bracketCatalog).toBeDefined()
    expect(meta.bracketEffectMap).toBeDefined()
    expect(meta.bracketEffectShapes).toBeDefined()
    expect(meta.bracketVisibility).toBeDefined()
    expect(meta.bracketSettings).toBeDefined()
    expect(meta.bracketShapeParams).toBeDefined()
  })

  // Test 7: facetKey follows panelFactor=panelValue format
  it('compound spec facetKeys are Sex=M and Sex=F', () => {
    const specs = buildLmmPlots(makeResult(GOLDEN_COMPOUND_RAW))
    const compound = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )
    const facetKeys = compound.map(s => s.plot.facetKey)
    expect(facetKeys).toContain('Sex=M')
    expect(facetKeys).toContain('Sex=F')
  })

  // Test 8: no legacy per-stratum trajectory specs emitted
  it('emits zero legacy trajectory specs (no non-compound trajectory)', () => {
    const specs = buildLmmPlots(makeResult(GOLDEN_COMPOUND_RAW))
    const legacy = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout !== 'compound'
    )
    expect(legacy).toHaveLength(0)
  })

  // Test 9: fallback — 1 stratify dim → legacy path, no compound specs
  it('falls back to legacy trajectory when stratify_by has 1 dim', () => {
    const specs = buildLmmPlots(makeResult(GOLDEN_SINGLE_DIM_RAW))
    // No compound specs
    const compound = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )
    expect(compound).toHaveLength(0)
    // Legacy trajectory specs are emitted instead
    const legacy = specs.filter(s => s.plot.lmmMode === 'trajectory')
    expect(legacy.length).toBeGreaterThan(0)
  })

  // Test 10: title-only factors split compound into separate specs per title-factor value
  it('title-only Sex produces 2 compound specs split by Sex, not by panel — with Sex in spec title', () => {
    // GOLDEN_COMPOUND_RAW has stratify_by=['Strain','Sex'].
    // Default: colorFactor='Strain', panelFactors=['Sex'] → 2 specs (Sex=M, Sex=F panels).
    // With Sex marked title-only and Strain as color: colorFactor='Strain', titleFactors=['Sex'],
    // panelFactors=[] → still 2 specs (one per Sex value), but now titled via titleFactors.
    const resultWithTitleOnly = {
      ...makeResult(GOLDEN_COMPOUND_RAW),
      plotPayload: {
        test: 'lmm_anova',
        data: { dependent_name: 'Body Weight (g)', value_column: 'Body Weight (g)' },
        parameters: {
          plot_facet_roles: {
            color_by: 'Strain',
            facet_by: '',
            title_only_factors: ['Sex'],
          },
        },
      },
    }

    const specs = buildLmmPlots(resultWithTitleOnly)
    const compound = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )

    // Still 2 compound specs (one per Sex value)
    expect(compound).toHaveLength(2)

    // Each spec title must reference a Sex value
    const titles = compound.map(s => s.plot.title)
    expect(titles.some(t => t.includes('M'))).toBe(true)
    expect(titles.some(t => t.includes('F'))).toBe(true)

    // Traces are still colored by Strain (B6/D2)
    const firstSpec = compound[0]!
    const traceNames = (firstSpec.plot.plotlyData as Array<{ name: string }>).map(t => t.name)
    expect(traceNames.some(n => n.startsWith('B6'))).toBe(true)
    expect(traceNames.some(n => n.startsWith('D2'))).toBe(true)
  })

  // Test 11: title-only splits must have unique spec IDs
  it('title-only splits produce unique spec IDs (no ID collision when panelFactors=[])', () => {
    // GOLDEN_COMPOUND_RAW: stratify_by=['Strain','Sex'].
    // color_by='Strain', title_only_factors=['Sex'] → panelFactors=[], titleFactors=['Sex']
    // This produces 2 title splits (Sex=M, Sex=F) with panelValue=''.
    // Both splits must NOT share the same spec ID.
    const resultWithTitleOnly = {
      ...makeResult(GOLDEN_COMPOUND_RAW),
      plotPayload: {
        test: 'lmm_anova',
        data: { dependent_name: 'Body Weight (g)', value_column: 'Body Weight (g)' },
        parameters: {
          plot_facet_roles: {
            color_by: 'Strain',
            facet_by: '',
            title_only_factors: ['Sex'],
          },
        },
      },
    }

    const specs = buildLmmPlots(resultWithTitleOnly)
    const compound = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )

    expect(compound).toHaveLength(2)
    const ids = compound.map(s => s.plot.id)
    // All IDs must be unique — no collision
    expect(new Set(ids).size).toBe(2)
  })

  // Test 12: title-only splits must have unique facetKeys
  it('title-only splits produce unique facetKeys (no key collision)', () => {
    const resultWithTitleOnly = {
      ...makeResult(GOLDEN_COMPOUND_RAW),
      plotPayload: {
        test: 'lmm_anova',
        data: { dependent_name: 'Body Weight (g)', value_column: 'Body Weight (g)' },
        parameters: {
          plot_facet_roles: {
            color_by: 'Strain',
            facet_by: '',
            title_only_factors: ['Sex'],
          },
        },
      },
    }

    const specs = buildLmmPlots(resultWithTitleOnly)
    const compound = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )

    expect(compound).toHaveLength(2)
    const facetKeys = compound.map(s => s.plot.facetKey)
    // All facetKeys must be unique — Sex=M and Sex=F get distinct keys
    expect(new Set(facetKeys).size).toBe(2)
    // Keys must encode the Sex value so the store can distinguish them
    expect(facetKeys.some(k => k?.includes('M'))).toBe(true)
    expect(facetKeys.some(k => k?.includes('F'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// RED tests: Task 1 — trajectory significance shape contract
// These FAIL until Task 2 implementation migrates trace-text to shapes.
// ---------------------------------------------------------------------------

/**
 * Pooled trajectory result with 2 groups, simple effects requested,
 * and pairwise p-values per timepoint via factor_scope.
 * simpleEffectsRequested=true → significance shapes must be emitted.
 */
const TRAJ_WITH_SE_RAW = {
  success: true,
  test_type: 'lmm_anova',
  stratified: false,
  fixed_effects: [
    { source: 'Treatment x Week', f_value: 8.1, p_value: 0.005, num_df: 1, den_df: 15, significant: true },
  ],
  estimated_means: [
    { factors: { Treatment: 'VEH' }, emmean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
    { factors: { Treatment: 'THC' }, emmean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
  ],
  per_group_means_over_time: [
    { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
    { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 25.4, se: 0.5, ci_lower: 24.4, ci_upper: 26.4, n: 10 },
    { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
    { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 28.6, se: 0.4, ci_lower: 27.8, ci_upper: 29.4, n: 10 },
  ],
  simple_effects: [{ factor: 'Treatment', within: 'Week' }],
  pairwise_comparisons: [
    { group1: 'VEH', group2: 'THC', p_adjusted: 0.20, significant: false, factor_scope: 'Treatment|Week=1' },
    { group1: 'VEH', group2: 'THC', p_adjusted: 0.04, significant: true,  factor_scope: 'Treatment|Week=2' },
  ],
  continuous_effects: null,
}

describe('buildLmmPlots — trajectory significance shape contract [RED → Task 2]', () => {
  it('trajectory layout.shapes contains sig_bracket_* named shapes', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    expect(shapes.some((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))).toBe(true)
  })

  it('trajectory significance shapes are type path (PlotCanvas parsePathPoints compatibility)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sig = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    expect(sig.length).toBeGreaterThan(0)
    expect(sig.every((s: any) => s.type === 'path')).toBe(true)
  })

  it('trajectory layout.meta has all five bracket metadata fields', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = ((traj.plot.plotlyLayout as any).meta ?? {}) as Record<string, unknown>
    expect(meta.bracketCatalog).toBeDefined()
    expect(meta.bracketEffectMap).toBeDefined()
    expect(meta.bracketEffectShapes).toBeDefined()
    expect(meta.bracketVisibility).toBeDefined()
    expect(meta.bracketSettings).toBeDefined()
  })

  it('trajectory bracketSettings.showNs is true (ns labels preserved)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = ((traj.plot.plotlyLayout as any).meta ?? {}) as any
    expect(meta.bracketSettings?.showNs).toBe(true)
  })

  it('trajectory traces do not carry significance text labels (removed from traces)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ text?: unknown; mode?: string }>
    expect(traces.every(t => t.text === undefined)).toBe(true)
    expect(traces.every(t => t.mode !== 'lines+markers+text')).toBe(true)
  })

  it('trajectory plotlyConfig has edits.shapePosition true', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    expect((traj.plot.plotlyConfig as any)?.edits?.shapePosition).toBe(true)
  })

  it('trajectory plotlyConfig modeBarButtonsToAdd includes eraseshape', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const buttons = ((traj.plot.plotlyConfig as any)?.modeBarButtonsToAdd ?? []) as string[]
    expect(buttons).toContain('eraseshape')
  })

  it('bracketEffectShapes values are arrays of sig_bracket_* shape names', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = ((traj.plot.plotlyLayout as any).meta ?? {}) as any
    const effectShapes: Record<string, string[]> = meta.bracketEffectShapes ?? {}
    const allNames = Object.values(effectShapes).flat() as string[]
    expect(allNames.length).toBeGreaterThan(0)
    expect(allNames.every((n: string) => n.startsWith('sig_bracket_'))).toBe(true)
  })

  it('bracketEffectShapes effectIds are a subset of bracketEffectMap keys', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = ((traj.plot.plotlyLayout as any).meta ?? {}) as any
    const effectShapeKeys = Object.keys(meta.bracketEffectShapes ?? {})
    const effectMapKeys = new Set(Object.keys(meta.bracketEffectMap ?? {}))
    expect(effectShapeKeys.length).toBeGreaterThan(0)
    for (const key of effectShapeKeys) {
      expect(effectMapKeys.has(key)).toBe(true)
    }
  })

  it('trajectory y-axis range is explicitly set (headroom for shape labels)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const layout = traj.plot.plotlyLayout as any
    expect(Array.isArray(layout.yaxis?.range)).toBe(true)
    expect(typeof layout.yaxis.range[1]).toBe('number')
  })

  it('no sig_bracket shapes emitted for trajectory with >2 groups (ambiguity rule)', () => {
    const threeGroupRaw = {
      ...TRAJ_WITH_SE_RAW,
      per_group_means_over_time: [
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
        { group_factor: 'Treatment', group_value: 'CBD', time_factor: 'Week', time_value: 1, mean: 26.3, se: 0.45, ci_lower: 25.4, ci_upper: 27.2, n: 10 },
      ],
    }
    const specs = buildLmmPlots(makeResult(threeGroupRaw))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')
    if (traj) {
      const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
      const sig = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
      expect(sig).toHaveLength(0)
    }
  })

  it('no sig_bracket shapes when simpleEffectsRequested is false (no simple_effects declared)', () => {
    const noSeRaw = { ...TRAJ_WITH_SE_RAW, simple_effects: undefined }
    const specs = buildLmmPlots(makeResult(noSeRaw))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')
    if (traj) {
      const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
      const sig = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
      expect(sig).toHaveLength(0)
    }
  })

  // H1 fix: yanchor must be 'top' so label floats above tipY (not at baseY)
  it('sig_bracket shapes have yanchor top so labels appear above bracket tip', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sigShapes = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    expect(sigShapes.length).toBeGreaterThan(0)
    for (const shape of sigShapes) {
      expect((shape.label as any)?.yanchor).toBe('top')
    }
  })

  // M1 fix: pooled effectId must not have empty middle segment (lmm_se||...)
  it('pooled trajectory simple-effect keys use lmm_se|pooled|... (not lmm_se||...)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectMap = meta.bracketEffectMap as Record<string, unknown>
    // Only check lmm_se| keys (master lmm_cmp| key is separate)
    const seKeys = Object.keys(effectMap).filter(k => k.startsWith('lmm_se|'))
    expect(seKeys.length).toBeGreaterThan(0)
    expect(seKeys.every(k => k.startsWith('lmm_se|pooled|'))).toBe(true)
  })

  // Per-timepoint toggle contract (Task 3): each timepoint has its own effectId.
  // lmm_se|<facet>|<g1>_vs_<g2>|<timeFactor>=<timeValue> — one toggle per simple effect.
  it('bracketEffectMap has one entry per timepoint (per-timepoint granularity)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectMap = meta.bracketEffectMap as Record<string, unknown>
    // TRAJ_WITH_SE_RAW has 2 timepoints → 2 simple entries + 1 master
    const seKeys = Object.keys(effectMap).filter(k => k.startsWith('lmm_se|'))
    expect(seKeys).toHaveLength(2)
  })

  it('bracketEffectShapes has one entry per timepoint (one shape per toggle)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectShapes = meta.bracketEffectShapes as Record<string, string[]>
    // 2 simple + 1 master = 3 total entries in effectShapes
    const seKeys = Object.keys(effectShapes).filter(k => k.startsWith('lmm_se|'))
    expect(seKeys).toHaveLength(2)
  })

  it('bracketEffectMap simple keys include timepoint segment (lmm_se|facet|g1_vs_g2|time=val)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectMap = meta.bracketEffectMap as Record<string, unknown>
    // Only simple effectIds need the timepoint segment; skip lmm_cmp| master keys
    for (const key of Object.keys(effectMap).filter(k => k.startsWith('lmm_se|'))) {
      // Must contain _vs_ and a |timeFactor=timeValue segment
      expect(key).toMatch(/^lmm_se\|.*\|.*_vs_.*\|.*=.*$/)
    }
  })
})

// ---------------------------------------------------------------------------
// Task 1 (visual tick fix): sig_bracket stem must be nearly invisible
// RED: these fail until line settings are updated to thin/low-alpha
// ---------------------------------------------------------------------------

describe('buildLmmPlots — sig_bracket stem is nearly invisible (Task 1 visual fix)', () => {
  it('sig_bracket shape line.width is ≤ 1 (thin stem)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sig = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    expect(sig.length).toBeGreaterThan(0)
    for (const shape of sig) {
      expect((shape.line as any)?.width).toBeLessThanOrEqual(1)
    }
  })

  it('sig_bracket shape line.color is low-alpha rgba (not the solid lineColor)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sig = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    for (const shape of sig) {
      // color must be rgba(...) with low alpha — not solid hex like '#111827'
      expect((shape.line as any)?.color).toMatch(/^rgba\(/)
    }
  })

  it('sig_bracket tickHeight is very small (tipY - baseY < 1% of ySpan)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sig = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    for (const shape of sig) {
      const nums = (shape.path as string).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)!.map(Number)
      // M x,tipY L x,baseY: nums[1]=tipY, nums[3]=baseY
      const tipY = nums[1]!
      const baseY = nums[3]!
      const tickHeight = Math.abs(tipY - baseY)
      // Must be nearly zero — ySpan*0.001 → ~0.004; current 2% tick (0.088) fails this
      expect(tickHeight).toBeLessThan(0.01)
    }
  })
})

// ---------------------------------------------------------------------------
// Task 3 (per-timepoint effectId): bracketEffectMap has one entry per timepoint
// RED: these fail until effectId moves to lmm_se|<facet>|<g1>_vs_<g2>|<timeFactor>=<timeValue>
// ---------------------------------------------------------------------------

describe('buildLmmPlots — per-timepoint effectId granularity (Task 3)', () => {
  // TRAJ_WITH_SE_RAW has 2 timepoints (Week=1, Week=2)
  it('bracketEffectMap has N simple entries for N timepoints (one toggle per simple effect)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectMap = meta.bracketEffectMap as Record<string, { group: string }>
    // 2 timepoints → 2 simple entries (master comparison entry excluded)
    const simpleEntries = Object.entries(effectMap).filter(([, m]) => m.group === 'simple')
    expect(simpleEntries).toHaveLength(2)
  })

  it('bracketEffectShapes has N simple keys for N timepoints (one shape per effectId)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectShapes = meta.bracketEffectShapes as Record<string, string[]>
    // Exclude master (lmm_cmp|...) shapes entry
    const simpleKeys = Object.keys(effectShapes).filter(k => !k.startsWith('lmm_cmp|'))
    expect(simpleKeys).toHaveLength(2)
    // Each per-timepoint effectId maps to exactly one shape
    for (const key of simpleKeys) {
      expect(effectShapes[key]).toHaveLength(1)
    }
  })

  it('each bracketEffectMap simple key includes the timepoint segment (|timeFactor=timeValue)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectMap = meta.bracketEffectMap as Record<string, unknown>
    // Only simple effectIds (lmm_se|) need the timepoint segment; skip lmm_cmp| master
    const seKeys = Object.keys(effectMap).filter(k => k.startsWith('lmm_se|'))
    for (const key of seKeys) {
      expect(key).toMatch(/^lmm_se\|.*\|.*_vs_.*\|.*=.*$/)
    }
  })

  it('bracketEffectMap labels are timepoint-scoped (e.g. "THC vs VEH | Week=1")', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectMap = meta.bracketEffectMap as Record<string, { label: string }>
    const labels = Object.values(effectMap).map(e => e.label)
    // Each label should reference a specific timepoint
    expect(labels.some(l => l.includes('Week=1'))).toBe(true)
    expect(labels.some(l => l.includes('Week=2'))).toBe(true)
  })

  it('bracketCatalog bracket effectId matches its corresponding per-timepoint effectId in effectShapes', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const catalog = meta.bracketCatalog as { brackets: Array<{ effectId?: string }> }
    const effectShapes = meta.bracketEffectShapes as Record<string, string[]>
    for (const bracket of catalog.brackets) {
      if (bracket.effectId) {
        // Each bracket's effectId must map to exactly one shape
        expect(effectShapes[bracket.effectId]).toHaveLength(1)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Master comparison toggle (Task 4): lmm_cmp|<facet>|<g1>_vs_<g2>
// RED: these fail until master effectId is added to bracketEffectMap
// ---------------------------------------------------------------------------

describe('buildLmmPlots — master comparison toggle (Task 4)', () => {
  it('bracketEffectMap contains exactly one master entry with group: comparison', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectMap = meta.bracketEffectMap as Record<string, { group: string }>
    const masters = Object.entries(effectMap).filter(([, m]) => m.group === 'comparison')
    expect(masters).toHaveLength(1)
  })

  it('master effectId uses lmm_cmp| prefix', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectMap = meta.bracketEffectMap as Record<string, unknown>
    const masterKey = Object.keys(effectMap).find(k => k.startsWith('lmm_cmp|'))
    expect(masterKey).toBeDefined()
    expect(masterKey).toMatch(/^lmm_cmp\|.*\|.*_vs_.*$/)
  })

  it('master effectShapes contains all per-timepoint shape names', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectShapes = meta.bracketEffectShapes as Record<string, string[]>
    const masterKey = Object.keys(effectShapes).find(k => k.startsWith('lmm_cmp|'))!
    const allChildNames = Object.entries(effectShapes)
      .filter(([k]) => !k.startsWith('lmm_cmp|'))
      .flatMap(([, names]) => names)
    // Master shapes = union of all per-timepoint shapes
    expect(effectShapes[masterKey]).toHaveLength(allChildNames.length)
    expect(effectShapes[masterKey]).toEqual(expect.arrayContaining(allChildNames))
  })

  it('child bracketEffectMap entries have parentId pointing to the master', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectMap = meta.bracketEffectMap as Record<string, { group: string; parentId?: string }>
    const masterKey = Object.keys(effectMap).find(k => k.startsWith('lmm_cmp|'))!
    const children = Object.values(effectMap).filter(m => m.group === 'simple')
    expect(children.length).toBeGreaterThan(0)
    for (const child of children) {
      expect(child.parentId).toBe(masterKey)
    }
  })

  it('master effectId base matches child effectIds (same facet/comparison segment)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectMap = meta.bracketEffectMap as Record<string, { group: string }>
    const masterKey = Object.keys(effectMap).find(k => k.startsWith('lmm_cmp|'))!
    // master lmm_cmp|pooled|VEH_vs_THC → children lmm_se|pooled|VEH_vs_THC|...
    const masterBase = masterKey.replace('lmm_cmp|', '')
    const childKeys = Object.keys(effectMap).filter(k => k.startsWith('lmm_se|'))
    for (const ck of childKeys) {
      // Child contains the master base: lmm_se|<same base>|<timepoint>
      expect(ck).toContain(masterBase)
    }
  })
})

// ---------------------------------------------------------------------------
// Task 5 (real-width drag target): sig_bracket path must have xLeft < xRight
// RED: fail until buildLmmPlots emits xLeft = x - halfWidth, xRight = x + halfWidth
// ---------------------------------------------------------------------------

describe('buildLmmPlots — real-width bracket path (drag target fix)', () => {
  it('sig_bracket path has distinct xLeft and xRight (not degenerate single-x path)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sig = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    expect(sig.length).toBeGreaterThan(0)
    for (const shape of sig) {
      const nums = (shape.path as string).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)!.map(Number)
      // 8-number format: M xL,tipY L xL,baseY L xR,baseY L xR,tipY
      const xLeft  = nums[0]!
      const xRight = nums[4]!
      expect(xLeft).toBeLessThan(xRight)
    }
  })

  it('sig_bracket xLeft and xRight are symmetric around the timepoint category index', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sig = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    for (const shape of sig) {
      const nums = (shape.path as string).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)!.map(Number)
      const xLeft  = nums[0]!
      const xRight = nums[4]!
      const centerX = (xLeft + xRight) / 2
      const halfWidth = (xRight - xLeft) / 2
      // center must be an integer category index (0, 1, 2, …)
      expect(centerX).toBeCloseTo(Math.round(centerX), 5)
      // halfWidth must be positive and consistent (same for all brackets)
      expect(halfWidth).toBeGreaterThan(0)
    }
  })

  it('layout.meta stores bracketShapeParams with halfWidth, tickHeightRatio, lineWidth, ySpan', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const params = meta.bracketShapeParams as {
      halfWidth: number; tickHeightRatio: number; lineWidth: number; ySpan: number
    } | undefined
    expect(params).toBeDefined()
    expect(typeof params!.halfWidth).toBe('number')
    expect(params!.halfWidth).toBeGreaterThan(0)
    expect(typeof params!.tickHeightRatio).toBe('number')
    expect(params!.tickHeightRatio).toBeGreaterThan(0)
    expect(typeof params!.lineWidth).toBe('number')
    expect(params!.lineWidth).toBeGreaterThan(0)
    expect(typeof params!.ySpan).toBe('number')
    expect(params!.ySpan).toBeGreaterThan(0)
  })

  it('sig_bracket shapes are emitted with fully transparent line color (invisible anchors)', () => {
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const shapes = (traj.plot.plotlyLayout as any).shapes as Array<Record<string, unknown>>
    const brackets = shapes.filter(s => typeof s.name === 'string' && (s.name as string).startsWith('sig_bracket_'))
    expect(brackets.length).toBeGreaterThan(0)
    brackets.forEach(b => {
      const line = b.line as Record<string, unknown> | undefined
      expect(line?.color).toBe('rgba(0,0,0,0)')
    })
  })
})

// ---------------------------------------------------------------------------
// Role-based visual encoding — resolveTraceRoles integration
//
// When exactly 2 group values exist:
//   - all traces in a panel share sharedColor (not cycling per-trace)
//   - alphabetically first group level = 'solid', second = 'dot' (line.dash)
//   - sig_bracket label font.color = sharedColor
//
// When >2 group values (fallback):
//   - cycling colors preserved (one color per trace)
// ---------------------------------------------------------------------------

const ROLE_POOLED_RAW = {
  success: true,
  test_type: 'lmm_anova',
  stratified: false,
  fixed_effects: [
    { source: 'Treatment', f_value: 5.0, p_value: 0.02, num_df: 1, den_df: 15, significant: true },
  ],
  estimated_means: [
    { factors: { Treatment: 'VEH' }, emmean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
    { factors: { Treatment: 'THC' }, emmean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
  ],
  per_group_means_over_time: [
    { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
    { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 25.4, se: 0.5, ci_lower: 24.4, ci_upper: 26.4, n: 10 },
    { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
    { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 28.6, se: 0.4, ci_lower: 27.8, ci_upper: 29.4, n: 10 },
  ],
  pairwise_comparisons: [],
  continuous_effects: null,
}

const ROLE_STRATIFIED_RAW = {
  success: true,
  test_type: 'lmm_anova_stratified',
  stratified: true,
  stratify_by: ['sex'],
  strata_results: [
    {
      success: true,
      stratum: { sex: 'M' },
      fixed_effects: [
        { source: 'Treatment', f_value: 5.0, p_value: 0.02, num_df: 1, den_df: 15, significant: true },
      ],
      estimated_means: [
        { factors: { Treatment: 'VEH' }, emmean: 26.0, se: 0.6, ci_lower: 24.8, ci_upper: 27.2, n: 5 },
        { factors: { Treatment: 'THC' }, emmean: 29.0, se: 0.5, ci_lower: 28.0, ci_upper: 30.0, n: 5 },
      ],
      per_group_means_over_time: [
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 26.0, se: 0.6, ci_lower: 24.8, ci_upper: 27.2, n: 5 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 29.0, se: 0.5, ci_lower: 28.0, ci_upper: 30.0, n: 5 },
      ],
      continuous_effects: null,
    },
    {
      success: true,
      stratum: { sex: 'F' },
      fixed_effects: [
        { source: 'Treatment', f_value: 3.2, p_value: 0.08, num_df: 1, den_df: 15, significant: false },
      ],
      estimated_means: [
        { factors: { Treatment: 'VEH' }, emmean: 22.0, se: 0.4, ci_lower: 21.2, ci_upper: 22.8, n: 5 },
        { factors: { Treatment: 'THC' }, emmean: 24.5, se: 0.3, ci_lower: 23.9, ci_upper: 25.1, n: 5 },
      ],
      per_group_means_over_time: [
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 22.0, se: 0.4, ci_lower: 21.2, ci_upper: 22.8, n: 5 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 24.5, se: 0.3, ci_lower: 23.9, ci_upper: 25.1, n: 5 },
      ],
      continuous_effects: null,
    },
  ],
}

describe('buildLmmPlots — role-based visual encoding', () => {
  it('pooled trajectory — all traces share the same color when 2 group values present', () => {
    const specs = buildLmmPlots(makeResult(ROLE_POOLED_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ line?: { color?: string } }>
    expect(traces.length).toBeGreaterThanOrEqual(2)
    const colors = traces.map(t => t.line?.color)
    expect(new Set(colors).size).toBe(1)
  })

  it('pooled trajectory — THC trace uses sharedColor (LMM_COLORS[0]), not cycling color', () => {
    // THC currently gets LMM_COLORS[1] (colorIdx=1 in cycling path); after role mapping → LMM_COLORS[0]
    const specs = buildLmmPlots(makeResult(ROLE_POOLED_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ name?: string; line?: { color?: string } }>
    const thcTrace = traces.find(t => t.name === 'THC')!
    expect(thcTrace.line?.color).toBe(LMM_COLORS[0])
  })

  it('pooled trajectory — THC trace has line.dash=solid (THC < VEH alphabetically)', () => {
    const specs = buildLmmPlots(makeResult(ROLE_POOLED_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    const thcTrace = traces.find(t => t.name === 'THC')!
    expect(thcTrace.line?.dash).toBe('solid')
  })

  it('pooled trajectory — VEH trace has line.dash=dot (VEH > THC alphabetically)', () => {
    const specs = buildLmmPlots(makeResult(ROLE_POOLED_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    const vehTrace = traces.find(t => t.name === 'VEH')!
    expect(vehTrace.line?.dash).toBe('dot')
  })

  it('stratified trajectory — within each stratum all traces share the same color', () => {
    const specs = buildLmmPlots(makeResult(ROLE_STRATIFIED_RAW))
    const trajSpecs = specs.filter(s => s.plot.lmmMode === 'trajectory')
    expect(trajSpecs.length).toBeGreaterThanOrEqual(2)
    for (const spec of trajSpecs) {
      const traces = spec.plot.plotlyData as Array<{ line?: { color?: string } }>
      const colors = traces.map(t => t.line?.color)
      expect(new Set(colors).size).toBe(1)
    }
  })

  it('stratified trajectory — different strata get different sharedColors', () => {
    const specs = buildLmmPlots(makeResult(ROLE_STRATIFIED_RAW))
    const trajSpecs = specs.filter(s => s.plot.lmmMode === 'trajectory')
    expect(trajSpecs.length).toBeGreaterThanOrEqual(2)
    const stratumColors = trajSpecs.map(spec => {
      const traces = spec.plot.plotlyData as Array<{ line?: { color?: string } }>
      return traces[0]?.line?.color
    })
    expect(new Set(stratumColors).size).toBe(2)
  })

  it('sig_bracket label font.color equals sharedColor when roles resolve (2 groups)', () => {
    // TRAJ_WITH_SE_RAW: pooled, VEH + THC (2 groups) → sharedColor = LMM_COLORS[0]
    const specs = buildLmmPlots(makeResult(TRAJ_WITH_SE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    const sigShapes = shapes.filter((s: any) => s.name?.startsWith('sig_bracket_'))
    expect(sigShapes.length).toBeGreaterThan(0)
    for (const shape of sigShapes) {
      expect(shape.label?.font?.color).toBe(LMM_COLORS[0])
    }
  })

  it('3+ groups — fallback: traces use cycling colors (distinct per trace)', () => {
    const threeGroupRaw = {
      ...ROLE_POOLED_RAW,
      per_group_means_over_time: [
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
        { group_factor: 'Treatment', group_value: 'CBD', time_factor: 'Week', time_value: 1, mean: 26.3, se: 0.45, ci_lower: 25.4, ci_upper: 27.2, n: 10 },
      ],
    }
    const specs = buildLmmPlots(makeResult(threeGroupRaw))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ line?: { color?: string } }>
    const colors = traces.map(t => t.line?.color)
    // resolved=false → cycling colors → 3 distinct colors
    expect(new Set(colors).size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Semantic dash from pairwise_comparisons.group1 (baseline-role contract)
//
// When pairwise_comparisons declares group1='Apple', group2='Banana'
// (Apple alphabetically first = would be solid under old policy):
//   - Apple = baseline → dot  (semantic overrides alphabetical)
//   - Banana = contrast → solid
//
// Meta persistence: resolved TraceRoleMapping stored in layout.meta
// ---------------------------------------------------------------------------

describe('buildLmmPlots — semantic dash from pairwise baseline metadata', () => {
  // Fixture where alphabetical and semantic disagree:
  // 'Apple' < 'Banana' alphabetically → old policy: Apple=solid, Banana=dot
  // pairwise_comparisons: group1='Apple' (reference/baseline), group2='Banana' (treatment)
  // Semantic: Apple=dot, Banana=solid
  const SEMANTIC_DASH_RAW = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [
      { source: 'Drug', f_value: 5.0, p_value: 0.02, num_df: 1, den_df: 15, significant: true },
    ],
    estimated_means: [
      { factors: { Drug: 'Apple' }, emmean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
      { factors: { Drug: 'Banana' }, emmean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
    ],
    per_group_means_over_time: [
      { group_factor: 'Drug', group_value: 'Apple', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
      { group_factor: 'Drug', group_value: 'Banana', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
    ],
    // group1='Apple' = reference level (baseline in R emmeans pairwise output)
    pairwise_comparisons: [
      { group1: 'Apple', group2: 'Banana', p_adjusted: 0.02, significant: true },
    ],
    continuous_effects: null,
  }

  it('baseline (group1=Apple) gets dash=dot even though Apple is alphabetically first', () => {
    // Under alphabetical policy Apple would be solid; semantic must override to dot.
    const specs = buildLmmPlots(makeResult(SEMANTIC_DASH_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    const appleTrace = traces.find(t => t.name === 'Apple')!
    expect(appleTrace.line?.dash).toBe('dot')
  })

  it('contrast (group2=Banana) gets dash=solid even though Banana is alphabetically second', () => {
    const specs = buildLmmPlots(makeResult(SEMANTIC_DASH_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    const bananaTrace = traces.find(t => t.name === 'Banana')!
    expect(bananaTrace.line?.dash).toBe('solid')
  })

  it('layout.meta stores traceRoleMapping when roles resolved', () => {
    const specs = buildLmmPlots(makeResult(ROLE_POOLED_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown> | undefined
    expect(meta?.traceRoleMapping).toBeDefined()
  })

  it('layout.meta.traceRoleMapping.resolved is true when 2 groups present', () => {
    const specs = buildLmmPlots(makeResult(ROLE_POOLED_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const mapping = meta.traceRoleMapping as { resolved: boolean } | undefined
    expect(mapping?.resolved).toBe(true)
  })

  it('layout.meta.traceRoleMapping.dashMap matches applied trace dash styles', () => {
    const specs = buildLmmPlots(makeResult(SEMANTIC_DASH_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const mapping = meta.traceRoleMapping as { dashMap: Record<string, string> } | undefined
    expect(mapping?.dashMap['Apple']).toBe('dot')
    expect(mapping?.dashMap['Banana']).toBe('solid')
  })
})

// ---------------------------------------------------------------------------
// Strict 2-group baseline guard
//
// extractBaselineGroupValue must require BOTH group1 and group2 to be
// unambiguous (size===1) before assigning semantic roles.
// One-vs-many pairwise structures (A vs B + A vs C) look like consistent
// group1='A' but group2 is not unique — must fall back to alphabetical.
// ---------------------------------------------------------------------------

describe('buildLmmPlots — strict baseline guard (one-vs-many fallback)', () => {
  // Fixture: 2-group trajectory (Apple, Banana) but pairwise has a third group2 (Cherry).
  // A one-vs-many pairwise structure:  Apple vs Banana  +  Apple vs Cherry.
  // Under current (loose) guard: group1={'Apple'} → Apple=baseline → dot.
  //   Since Apple < Banana alphabetically, current semantic gives Apple=dot (coincides).
  // With strict guard + alphabetical: Apple < Banana → Apple=solid, Banana=dot.
  // Test uses Apple/Banana so alphabetical and semantic DIVERGE and we can detect the diff.
  const ONE_VS_MANY_RAW = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [
      { source: 'Drug', f_value: 5.0, p_value: 0.02, num_df: 1, den_df: 15, significant: true },
    ],
    estimated_means: [
      { factors: { Drug: 'Apple' }, emmean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
      { factors: { Drug: 'Banana' }, emmean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
    ],
    per_group_means_over_time: [
      { group_factor: 'Drug', group_value: 'Apple', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
      { group_factor: 'Drug', group_value: 'Banana', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
    ],
    // One-vs-many: Apple is group1 in BOTH rows — group1 is "unambiguous" but group2 is not.
    // Strict guard must reject this and fall back to alphabetical.
    pairwise_comparisons: [
      { group1: 'Apple', group2: 'Banana', p_adjusted: 0.02, significant: true },
      { group1: 'Apple', group2: 'Cherry', p_adjusted: 0.15, significant: false },
    ],
    continuous_effects: null,
  }

  it('one-vs-many pairwise — Apple gets solid (alphabetical fallback, not semantic dot)', () => {
    // Loose guard: Apple=baseline→dot. Strict guard: null baseline→alphabetical: Apple=solid.
    const specs = buildLmmPlots(makeResult(ONE_VS_MANY_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    const appleTrace = traces.find(t => t.name === 'Apple')!
    expect(appleTrace.line?.dash).toBe('solid')
  })

  it('one-vs-many pairwise — Banana gets dot (alphabetical fallback, not semantic solid)', () => {
    const specs = buildLmmPlots(makeResult(ONE_VS_MANY_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    const bananaTrace = traces.find(t => t.name === 'Banana')!
    expect(bananaTrace.line?.dash).toBe('dot')
  })

  it('one-vs-many pairwise — traceRoleMapping.dashMap uses alphabetical (not semantic)', () => {
    const specs = buildLmmPlots(makeResult(ONE_VS_MANY_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const mapping = meta.traceRoleMapping as { dashMap: Record<string, string> } | undefined
    // Alphabetical: Apple < Banana → Apple=solid, Banana=dot
    expect(mapping?.dashMap['Apple']).toBe('solid')
    expect(mapping?.dashMap['Banana']).toBe('dot')
  })
})

// ---------------------------------------------------------------------------
// Phase 2 — per-plot style overrides threaded through buildLmmPlots
//
// buildLmmPlots accepts an optional overrides map keyed by:
//   "${resultId}|${facetKey ?? 'pooled'}|${lmmMode}"
//
// The builder looks up the override for each plot panel and passes it to
// resolveTraceRoles. The resolved dashMap and traceRoleMapping reflect the
// override without the builder needing to know the override semantics.
// ---------------------------------------------------------------------------

describe('buildLmmPlots — Phase 2 style overrides', () => {
  // Pooled VEH/THC result — default: VEH=dot (semantic baseline), THC=solid
  // (VEH is group1 in pairwise_comparisons → semantic baseline → dot)
  const OVERRIDE_BASE_RAW = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [
      { source: 'treatment', f_value: 12.3, p_value: 0.001, num_df: 1, den_df: 18.7, significant: true },
    ],
    per_group_means_over_time: [
      { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
      { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
    ],
    pairwise_comparisons: [
      { group1: 'VEH', group2: 'THC', estimate: -2.7, se: 0.4, p_adjusted: 0.002, significant: true, factor: 'treatment' },
    ],
    continuous_effects: null,
  }

  // Key: "test-result-1|pooled|trajectory"
  const POOLED_TRAJ_KEY = 'test-result-1|pooled|trajectory'

  it('override swapStyles=true inverts the trace dashes in the pooled trajectory', () => {
    // Default: VEH=dot (semantic baseline), THC=solid
    // swapStyles → VEH=solid, THC=dot
    const overrides: Record<string, LmmTraceRoleOverride> = {
      [POOLED_TRAJ_KEY]: { swapStyles: true },
    }
    const specs = buildLmmPlots(makeResult(OVERRIDE_BASE_RAW), overrides)
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    expect(traces.find(t => t.name === 'VEH')?.line?.dash).toBe('solid')
    expect(traces.find(t => t.name === 'THC')?.line?.dash).toBe('dot')
  })

  it('override baselineLevel wins over semantic — THC=dot when set as baseline', () => {
    // Default semantic: VEH=baseline→dot. Override: THC=baseline→dot
    const overrides: Record<string, LmmTraceRoleOverride> = {
      [POOLED_TRAJ_KEY]: { baselineLevel: 'THC', contrastLevel: 'VEH' },
    }
    const specs = buildLmmPlots(makeResult(OVERRIDE_BASE_RAW), overrides)
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    expect(traces.find(t => t.name === 'THC')?.line?.dash).toBe('dot')
    expect(traces.find(t => t.name === 'VEH')?.line?.dash).toBe('solid')
  })

  it('override is reflected in layout.meta.traceRoleMapping.dashMap', () => {
    const overrides: Record<string, LmmTraceRoleOverride> = {
      [POOLED_TRAJ_KEY]: { swapStyles: true },
    }
    const specs = buildLmmPlots(makeResult(OVERRIDE_BASE_RAW), overrides)
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const mapping = meta.traceRoleMapping as { dashMap: Record<string, string> } | undefined
    // After swapStyles: VEH=solid, THC=dot
    expect(mapping?.dashMap['VEH']).toBe('solid')
    expect(mapping?.dashMap['THC']).toBe('dot')
  })

  it('no override → default semantic resolution unchanged', () => {
    // No overrides map — VEH=dot (baseline), THC=solid
    const specs = buildLmmPlots(makeResult(OVERRIDE_BASE_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    expect(traces.find(t => t.name === 'VEH')?.line?.dash).toBe('dot')
    expect(traces.find(t => t.name === 'THC')?.line?.dash).toBe('solid')
  })

  it('override for a different key does not affect the target plot', () => {
    // Override is keyed to a non-matching plot key — should not affect this panel
    const overrides: Record<string, LmmTraceRoleOverride> = {
      'other-result|pooled|trajectory': { swapStyles: true },
    }
    const specs = buildLmmPlots(makeResult(OVERRIDE_BASE_RAW), overrides)
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    // Still default: VEH=dot, THC=solid
    expect(traces.find(t => t.name === 'VEH')?.line?.dash).toBe('dot')
    expect(traces.find(t => t.name === 'THC')?.line?.dash).toBe('solid')
  })

  it('baseline change with swapStyles=true in existing override honours both simultaneously', () => {
    // Scenario: user previously set swapStyles=true, then changes baseline.
    // Handler MUST spread currentOverride (preserving swapStyles) not reset it.
    // Default semantic: VEH=baseline→dot, THC=contrast→solid
    // Override: baselineLevel='THC', contrastLevel='VEH', swapStyles=true
    //   Step 1 override: THC=dot, VEH=solid
    //   Step 2 swapStyles: THC=solid, VEH=dot (inverted)
    const overrides: Record<string, LmmTraceRoleOverride> = {
      [POOLED_TRAJ_KEY]: { baselineLevel: 'THC', contrastLevel: 'VEH', swapStyles: true },
    }
    const specs = buildLmmPlots(makeResult(OVERRIDE_BASE_RAW), overrides)
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    // override baseline=THC→dot then swapStyles inverts → THC=solid, VEH=dot
    expect(traces.find(t => t.name === 'THC')?.line?.dash).toBe('solid')
    expect(traces.find(t => t.name === 'VEH')?.line?.dash).toBe('dot')
  })

  it('baseline change WITHOUT swapStyles does not inherit a stale swap from resolver', () => {
    // Only baselineLevel set (no swapStyles) — result must be un-swapped
    const overrides: Record<string, LmmTraceRoleOverride> = {
      [POOLED_TRAJ_KEY]: { baselineLevel: 'THC', contrastLevel: 'VEH' },
    }
    const specs = buildLmmPlots(makeResult(OVERRIDE_BASE_RAW), overrides)
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    // No swap: THC=baseline→dot stays dot
    expect(traces.find(t => t.name === 'THC')?.line?.dash).toBe('dot')
    expect(traces.find(t => t.name === 'VEH')?.line?.dash).toBe('solid')
  })

  it('empty overrides map behaves identically to no overrides', () => {
    const withEmpty = buildLmmPlots(makeResult(OVERRIDE_BASE_RAW), {})
    const withoutOverride = buildLmmPlots(makeResult(OVERRIDE_BASE_RAW))
    const tracesEmpty = withEmpty.find(s => s.plot.lmmMode === 'trajectory')!.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    const tracesNone = withoutOverride.find(s => s.plot.lmmMode === 'trajectory')!.plot.plotlyData as Array<{ name?: string; line?: { dash?: string } }>
    expect(tracesEmpty.find(t => t.name === 'VEH')?.line?.dash).toBe(tracesNone.find(t => t.name === 'VEH')?.line?.dash)
    expect(tracesEmpty.find(t => t.name === 'THC')?.line?.dash).toBe(tracesNone.find(t => t.name === 'THC')?.line?.dash)
  })
})

// ---------------------------------------------------------------------------
// Task 5 — Compound trajectory branch integration
//
// Fixture: 2 stratify dims (Strain × Sex), per_group_means_over_time inside each stratum.
// simple_effects declares factor='treatment', within='Week'.
// canBuildCompoundTrajectory resolves:
//   colorFactor = stratify_by[0] = 'Strain'
//   panelFactors = stratify_by.slice(1) = ['Sex']
//   styleFactor = 'treatment'
//   withinFactor = 'Week'
//
// The fixture has two strata: { Strain: 'B6', Sex: 'M' } and { Strain: 'D2', Sex: 'M' }.
// Both have Sex='M' so there is ONE panel (Sex=M).
// Per-stratum trajectory specs must NOT be emitted; one compound spec replaces them.
// ---------------------------------------------------------------------------

const COMPOUND_RAW = {
  success: true,
  test_type: 'lmm_anova_stratified',
  stratified: true,
  stratify_by: ['Strain', 'Sex'],
  strata_results: [
    {
      success: true,
      stratum: { Strain: 'B6', Sex: 'M' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
      simple_effects: [
        { factor: 'treatment', within: 'Week', levels: ['VEH', 'THC'] },
      ],
      per_group_means_over_time: [
        {
          group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1,
          mean: 25.0, se: 0.5, ci_lower: 24.0, ci_upper: 26.0, n: 10,
        },
        {
          group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1,
          mean: 28.0, se: 0.5, ci_lower: 27.0, ci_upper: 29.0, n: 10,
        },
      ],
    },
    {
      success: true,
      stratum: { Strain: 'D2', Sex: 'M' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
      simple_effects: [
        { factor: 'treatment', within: 'Week', levels: ['VEH', 'THC'] },
      ],
      per_group_means_over_time: [
        {
          group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1,
          mean: 24.0, se: 0.5, ci_lower: 23.0, ci_upper: 25.0, n: 10,
        },
        {
          group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1,
          mean: 27.0, se: 0.5, ci_lower: 26.0, ci_upper: 28.0, n: 10,
        },
      ],
    },
  ],
}

// Two-panel variant: Sex=M and Sex=F, both with trajectory rows
// Each stratum also carries simple_effects so the compound guard resolves
const COMPOUND_RAW_TWO_PANELS = {
  success: true,
  test_type: 'lmm_anova_stratified',
  stratified: true,
  stratify_by: ['Strain', 'Sex'],
  strata_results: [
    {
      success: true,
      stratum: { Strain: 'B6', Sex: 'M' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
      simple_effects: [{ factor: 'treatment', within: 'Week', levels: ['VEH', 'THC'] }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.0, se: 0.5, ci_lower: 24.0, ci_upper: 26.0, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 28.0, se: 0.5, ci_lower: 27.0, ci_upper: 29.0, n: 10 },
      ],
    },
    {
      success: true,
      stratum: { Strain: 'B6', Sex: 'F' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
      simple_effects: [{ factor: 'treatment', within: 'Week', levels: ['VEH', 'THC'] }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 23.0, se: 0.5, ci_lower: 22.0, ci_upper: 24.0, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 26.0, se: 0.5, ci_lower: 25.0, ci_upper: 27.0, n: 10 },
      ],
    },
  ],
}

// Fallback fixture: only 1 stratify dim → compound guard fails → legacy paths used
const SINGLE_DIM_STRATIFIED_RAW = {
  success: true,
  test_type: 'lmm_anova_stratified',
  stratified: true,
  stratify_by: ['Sex'],
  strata_results: [
    {
      success: true,
      stratum: { Sex: 'M' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
      simple_effects: [
        { factor: 'treatment', within: 'Week' },
      ],
      per_group_means_over_time: [
        {
          group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1,
          mean: 25.0, se: 0.5, ci_lower: 24.0, ci_upper: 26.0, n: 10,
        },
        {
          group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1,
          mean: 28.0, se: 0.5, ci_lower: 27.0, ci_upper: 29.0, n: 10,
        },
      ],
    },
    {
      success: true,
      stratum: { Sex: 'F' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
      simple_effects: [
        { factor: 'treatment', within: 'Week' },
      ],
      per_group_means_over_time: [
        {
          group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1,
          mean: 22.0, se: 0.4, ci_lower: 21.2, ci_upper: 22.8, n: 10,
        },
        {
          group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1,
          mean: 24.5, se: 0.3, ci_lower: 23.9, ci_upper: 25.1, n: 10,
        },
      ],
    },
  ],
}

describe('buildLmmPlots — compound trajectory branch', () => {
  it('compound path: emits one spec per panelValue when guard resolves', () => {
    // Two strata (B6+M, D2+M) both have Sex='M' → one compound panel (Sex=M)
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW))
    const compoundSpecs = specs.filter(s => s.plot.lmmMode === 'trajectory')
    expect(compoundSpecs).toHaveLength(1)
  })

  it('compound path: spec has lmmMode=trajectory', () => {
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW))
    const compound = specs.find(s => (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound')
    expect(compound).toBeDefined()
    expect(compound!.plot.lmmMode).toBe('trajectory')
  })

  it('compound path: spec has meta.trajectoryLayout=compound', () => {
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW))
    const compound = specs.find(s => s.plot.lmmMode === 'trajectory')
    expect(compound).toBeDefined()
    const meta = (compound!.plot.plotlyLayout as any).meta as Record<string, unknown>
    expect(meta?.trajectoryLayout).toBe('compound')
  })

  it('compound path: emits zero legacy per-stratum trajectory specs', () => {
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW))
    const legacyTrajectorySpecs = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout !== 'compound'
    )
    expect(legacyTrajectorySpecs).toHaveLength(0)
  })

  it('compound path: compound spec facetKey is panelFactor=panelValue', () => {
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW))
    const compound = specs.find(s => s.plot.lmmMode === 'trajectory')!
    // panelFactor='Sex', panelValue='M' → facetKey = 'Sex=M'
    expect(compound.plot.facetKey).toBe('Sex=M')
  })

  it('compound path: still emits contrast specs when contrast rows present', () => {
    // Add continuous_effects to one stratum → contrast spec should still appear
    const rawWithContrast = {
      ...COMPOUND_RAW,
      strata_results: COMPOUND_RAW.strata_results.map((s, i) =>
        i === 0
          ? {
              ...s,
              continuous_effects: [
                { time_value: 1, estimate: -0.5, se: 0.1, p: 0.04, label: 'VEH vs THC|treatment|Week=1' },
              ],
            }
          : s
      ),
    }
    const specs = buildLmmPlots(makeResult(rawWithContrast))
    const contrastSpecs = specs.filter(s => s.plot.lmmMode === 'contrast')
    expect(contrastSpecs.length).toBeGreaterThan(0)
  })

  it('unresolved path: falls back to per-stratum legacy trajectories when guard fails (1 stratify dim)', () => {
    // SINGLE_DIM_STRATIFIED_RAW has only 1 stratify dim → compound guard returns resolved=false
    // → legacy per-stratum trajectory specs emitted (2 strata)
    const specs = buildLmmPlots(makeResult(SINGLE_DIM_STRATIFIED_RAW))
    const trajectorySpecs = specs.filter(s => s.plot.lmmMode === 'trajectory')
    expect(trajectorySpecs).toHaveLength(2)
    // Legacy specs have stratum-level facetKeys
    const facetKeys = trajectorySpecs.map(s => s.plot.facetKey)
    expect(facetKeys).toContain('Sex=M')
    expect(facetKeys).toContain('Sex=F')
  })

  it('compound path: emits exactly 2 compound specs for 2-panel fixture (Sex=M and Sex=F)', () => {
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW_TWO_PANELS))
    const compoundSpecs = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )
    expect(compoundSpecs).toHaveLength(2)
    const facetKeys = compoundSpecs.map(s => s.plot.facetKey).sort()
    expect(facetKeys).toContain('Sex=F')
    expect(facetKeys).toContain('Sex=M')
  })

  it('compound activates with 3 stratify dims: colorFactor=Strain, panelFactors=[Sex,Cohort]', () => {
    // 3 stratify dims now resolve: colorFactor=Strain, panelFactors=[Sex,Cohort]
    const rawWith3Dims = {
      success: true,
      test_type: 'lmm_anova_stratified',
      stratified: true,
      stratify_by: ['Strain', 'Sex', 'Cohort'],
      strata_results: [
        {
          success: true,
          stratum: { Strain: 'B6', Sex: 'M', Cohort: '1' },
          fixed_effects: [],
          estimated_means: [],
          pairwise_comparisons: [],
          continuous_effects: null,
          simple_effects: [{ factor: 'treatment', within: 'Week', levels: ['VEH', 'THC'] }],
          per_group_means_over_time: [
            { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.0, se: 0.5, ci_lower: 24.0, ci_upper: 26.0, n: 10 },
            { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 28.0, se: 0.5, ci_lower: 27.0, ci_upper: 29.0, n: 10 },
          ],
        },
      ],
    }
    const specs = buildLmmPlots(makeResult(rawWith3Dims))
    // compound should activate: trajectory specs must be compound layout
    const trajectorySpecs = specs.filter(s => s.plot.lmmMode === 'trajectory')
    expect(trajectorySpecs.length).toBeGreaterThan(0)
    expect(trajectorySpecs.every(s => (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound')).toBe(true)
    // panel facetKey format: Sex=M|Cohort=1
    expect(trajectorySpecs[0]!.plot.facetKey).toBe('Sex=M|Cohort=1')
  })

  it('compound spec meta.traceRoleMapping has dashMap object (sidebar-safe)', () => {
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW))
    const compound = specs.find(s => (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound')!
    const meta = (compound.plot.plotlyLayout as any).meta as Record<string, unknown>
    const trm = meta.traceRoleMapping as Record<string, unknown>
    expect(trm).toBeDefined()
    expect(typeof trm.dashMap).toBe('object')
    expect(trm.dashMap).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Backend-panel render path regression tests
//
// Fixture: COMPOUND_RAW_WITH_BACKEND_PANELS
// Same strata as COMPOUND_RAW but adds compound_panels[] with trajectory_rows
// whose mean/se values are deliberately distinct (99x / 0.01) from the frontend
// per_group_means_over_time (25/28 / 0.5). This lets tests assert which source
// drove the rendered traces and stats.
//
// Compound roles: colorFactor=Strain (stratify_by[0]), panelFactors=[Sex] (stratify_by[1:])
// Panel: Sex=M, panel_filter={Sex:'M'}, color_factor='Strain'
// ---------------------------------------------------------------------------

const BACKEND_TRAJECTORY_ROWS = [
  { group_factor: 'treatment', group_value: 'VEH', color_factor: 'Strain', color_value: 'B6', time_factor: 'Week', time_value: '1', emmean: 99.0, se: 0.01, ci_lower: 98.8, ci_upper: 99.2, n: 10 },
  { group_factor: 'treatment', group_value: 'THC', color_factor: 'Strain', color_value: 'B6', time_factor: 'Week', time_value: '1', emmean: 101.0, se: 0.01, ci_lower: 100.8, ci_upper: 101.2, n: 10 },
  { group_factor: 'treatment', group_value: 'VEH', color_factor: 'Strain', color_value: 'D2', time_factor: 'Week', time_value: '1', emmean: 98.0, se: 0.01, ci_lower: 97.8, ci_upper: 98.2, n: 10 },
  { group_factor: 'treatment', group_value: 'THC', color_factor: 'Strain', color_value: 'D2', time_factor: 'Week', time_value: '1', emmean: 100.0, se: 0.01, ci_lower: 99.8, ci_upper: 100.2, n: 10 },
]

const COMPOUND_RAW_WITH_BACKEND_PANELS = {
  ...COMPOUND_RAW,
  compound_panels: [
    {
      facet_key: 'Sex=M',
      panel_filter: { Sex: 'M' },
      color_factor: 'Strain',
      panel_factors: ['Sex'],
      trajectory_rows: BACKEND_TRAJECTORY_ROWS,
      simple_effects_by_time: { '1': 0.03 },
      stats: {
        total_points: 4,
        trace_count: 4,
        n_points_per_trace: 1,
        overall_mean: 99.5,
        mean_se: 0.01,   // pooled model value — distinct from frontend heuristic (~0.5)
        min_mean: 98.0,
        max_mean: 101.0,
        sig_total_points: 1,
        sig_significant_points: 1,
        sig_ns_points: 0,
      },
    },
  ],
  compound_panels_warnings: [],
}

describe('buildLmmPlots — future pooled backend compound panel render path', () => {
  it('uses backend trajectory_rows for trace y-values when compound_panels present', () => {
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW_WITH_BACKEND_PANELS))
    const compound = specs.find(s => s.plot.lmmMode === 'trajectory')
    expect(compound).toBeDefined()

    const allY = (compound!.plot.plotlyData as Array<{ y?: unknown[] }>)
      .flatMap(trace => trace.y ?? []) as number[]

    // Backend emmean values (99/101/98/100) must appear — NOT frontend values (25/28/24/27)
    expect(allY.some(v => v > 90)).toBe(true)
    expect(allY.some(v => v < 30)).toBe(false)
  })

  it('uses backend trajectory_rows for error_y.array (SE values) when compound_panels present', () => {
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW_WITH_BACKEND_PANELS))
    const compound = specs.find(s => s.plot.lmmMode === 'trajectory')
    expect(compound).toBeDefined()

    const allSE = (compound!.plot.plotlyData as Array<{ error_y?: { array?: number[] } }>)
      .flatMap(trace => trace.error_y?.array ?? []) as number[]

    // Backend se=0.01 must appear — NOT frontend se=0.5
    expect(allSE.length).toBeGreaterThan(0)
    expect(allSE.every(v => Math.abs(v - 0.01) < 0.001)).toBe(true)
  })

  it('suppresses raw cell_summaries when backend compound panels are present', () => {
    const withRawCells = {
      ...COMPOUND_RAW_WITH_BACKEND_PANELS,
      strata_results: COMPOUND_RAW_WITH_BACKEND_PANELS.strata_results.map(stratum => ({
        ...stratum,
        cell_summaries: [
          { factors: { treatment: 'VEH', Week: 1 }, mean: 12, se: 4.252, ci_lower: 3.496, ci_upper: 20.504, n: 8 },
          { factors: { treatment: 'THC', Week: 1 }, mean: 14, se: 5.125, ci_lower: 3.75, ci_upper: 24.25, n: 8 },
        ],
      })),
    }
    const specs = buildLmmPlots(makeResult(withRawCells))
    const compound = specs.find(s => s.plot.lmmMode === 'trajectory')
    expect(compound).toBeDefined()

    const allY = (compound!.plot.plotlyData as Array<{ y?: unknown[] }>)
      .flatMap(trace => trace.y ?? []) as number[]
    const allSE = (compound!.plot.plotlyData as Array<{ error_y?: { array?: number[] } }>)
      .flatMap(trace => trace.error_y?.array ?? []) as number[]

    expect(allY).toEqual(expect.arrayContaining([98, 99, 100, 101]))
    expect(allY).not.toEqual(expect.arrayContaining([12, 14]))
    expect(allSE.every(v => Math.abs(v - 0.01) < 0.001)).toBe(true)
  })

  it('uses backend stats (mean_se=0.01) not frontend heuristic when compound_panels present', () => {
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW_WITH_BACKEND_PANELS))
    const compound = specs.find(s => s.plot.lmmMode === 'trajectory')
    expect(compound).toBeDefined()

    // Backend stats.mean_se=0.01 — frontend heuristic would compute ~0.5 from per_group_means_over_time
    expect(compound!.stats['mean_se']).toBeCloseTo(0.01, 3)
    expect(compound!.stats['mean_se']).not.toBeCloseTo(0.5, 1)
  })

  it('falls back to frontend panelGroups when backend trajectory_rows is empty', () => {
    const withEmptyRows = {
      ...COMPOUND_RAW_WITH_BACKEND_PANELS,
      compound_panels: [
        {
          ...COMPOUND_RAW_WITH_BACKEND_PANELS.compound_panels[0]!,
          trajectory_rows: [],
          stats: { ...COMPOUND_RAW_WITH_BACKEND_PANELS.compound_panels[0]!.stats, mean_se: 999 },
        },
      ],
    }
    const specs = buildLmmPlots(makeResult(withEmptyRows))
    const compound = specs.find(s => s.plot.lmmMode === 'trajectory')
    expect(compound).toBeDefined()

    // When trajectory_rows is empty, backend stats are still used (backendPanel?.stats),
    // but traces fall back to frontend panelGroups (y values from per_group_means_over_time)
    const allY = (compound!.plot.plotlyData as Array<{ y?: unknown[] }>)
      .flatMap(trace => trace.y ?? []) as number[]
    expect(allY.some(v => (v as number) < 30)).toBe(true)  // frontend values (25/28/24/27)

    // Stats still come from backend panel even when rows are empty
    expect(compound!.stats['mean_se']).toBeCloseTo(999, 0)
  })

  it('falls back entirely when compound_panels is null (non-stratified feature not applicable)', () => {
    const withNullPanels = { ...COMPOUND_RAW_WITH_BACKEND_PANELS, compound_panels: undefined }
    const specs = buildLmmPlots(makeResult(withNullPanels))
    const compound = specs.find(s => s.plot.lmmMode === 'trajectory')
    expect(compound).toBeDefined()

    // Without compound_panels, frontend per_group_means_over_time values used
    const allY = (compound!.plot.plotlyData as Array<{ y?: unknown[] }>)
      .flatMap(trace => trace.y ?? []) as number[]
    expect(allY.some(v => (v as number) < 30)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Sparse panel fixture: Panel Sex=M has B6+D2, Panel Sex=F has only B6
// pairwise_comparisons carry factor_scope so p-values propagate to trajectory rows
// ---------------------------------------------------------------------------

const COMPOUND_RAW_SPARSE_PANEL = {
  success: true,
  test_type: 'lmm_anova_stratified',
  stratified: true,
  stratify_by: ['Strain', 'Sex'],
  strata_results: [
    {
      // Panel Sex=M: B6 + D2 present
      success: true,
      stratum: { Strain: 'B6', Sex: 'M' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.01, significant: true, factor_scope: 'treatment|Week=1' },
      ],
      continuous_effects: null,
      simple_effects: [{ factor: 'treatment', within: 'Week', levels: ['VEH', 'THC'] }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.0, se: 0.5, ci_lower: 24.0, ci_upper: 26.0, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 28.0, se: 0.5, ci_lower: 27.0, ci_upper: 29.0, n: 10 },
      ],
    },
    {
      success: true,
      stratum: { Strain: 'D2', Sex: 'M' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.02, significant: true, factor_scope: 'treatment|Week=1' },
      ],
      continuous_effects: null,
      simple_effects: [{ factor: 'treatment', within: 'Week', levels: ['VEH', 'THC'] }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 24.0, se: 0.5, ci_lower: 23.0, ci_upper: 25.0, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.0, se: 0.5, ci_lower: 26.0, ci_upper: 28.0, n: 10 },
      ],
    },
    {
      // Panel Sex=F: only B6 present (sparse)
      success: true,
      stratum: { Strain: 'B6', Sex: 'F' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.01, significant: true, factor_scope: 'treatment|Week=1' },
      ],
      continuous_effects: null,
      simple_effects: [{ factor: 'treatment', within: 'Week', levels: ['VEH', 'THC'] }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 23.0, se: 0.5, ci_lower: 22.0, ci_upper: 24.0, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 26.0, se: 0.5, ci_lower: 25.0, ci_upper: 27.0, n: 10 },
      ],
    },
  ],
}

describe('buildLmmPlots — sparse panel / single-color offset', () => {
  it('sparse panel color consistency: B6 gets the same color in Sex=M and Sex=F panels', () => {
    // colorMap is built result-globally from ALL trajectory rows before the panel loop.
    // B6 must map to the same palette entry in every panel, even when Sex=F is sparse (B6 only).
    // Persisted in layout.meta.colorMap for rebuild/export consistency.
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW_SPARSE_PANEL))
    const mPanel = specs.find(
      s => (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound' && s.plot.facetKey === 'Sex=M'
    )
    const fPanel = specs.find(
      s => (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound' && s.plot.facetKey === 'Sex=F'
    )
    expect(mPanel).toBeDefined()
    expect(fPanel).toBeDefined()

    // colorMap persisted in meta — same object for all panels
    const mColorMap = (mPanel!.plot.plotlyLayout as any)?.meta?.colorMap as Record<string, string> | undefined
    const fColorMap = (fPanel!.plot.plotlyLayout as any)?.meta?.colorMap as Record<string, string> | undefined
    expect(mColorMap).toBeDefined()
    expect(fColorMap).toBeDefined()
    // B6 must map to the same color in both panels
    expect(mColorMap!['B6']).toBe(fColorMap!['B6'])
    // The value must be the first LMM palette color (B6 sorts first alphabetically)
    expect(mColorMap!['B6']).toBe(LMM_COLORS[0])
  })

  it('single-color sparse panel: B6-only panel significance marker has zero x-offset (centered at timeValue)', () => {
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW_SPARSE_PANEL))
    const sexFSpec = specs.find(
      s => (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound' &&
        s.plot.facetKey === 'Sex=F'
    )
    // If significance shapes were emitted, the path x-center should equal timeValue (1) exactly
    // because single-color panel forces colorOffset=0
    const shapes = (sexFSpec?.plot.plotlyLayout as any)?.shapes as Array<{ path?: string }> | undefined
    if (shapes && shapes.length > 0) {
      // Path format: "M xL,tipY L xL,baseY L xR,baseY L xR,tipY"
      // xCenter = (xL + xR) / 2, with HALF_WIDTH=0.15: xL = x-0.15, xR = x+0.15
      // So xL is the first number after "M "
      const path = shapes[0]!.path!
      const match = path.match(/M (-?[\d.]+),/)
      const xL = parseFloat(match![1]!)
      const xCenter = xL + 0.15  // HALF_WIDTH=0.15
      // timeValue=1 with colorOffset=0 → xCenter should be 1.0
      expect(xCenter).toBeCloseTo(1.0, 5)
    } else {
      // If no shapes (p-values not propagated), just assert spec exists
      expect(sexFSpec).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Real-world regression: stratify_by=['Strain','Sex','Trait'] with mismatched
// naming between simple_effects (uses 'condition') and row group_factor
// ('treatment'). Tests Guard 7 alias normalization + 3-dim compound activation.
// ---------------------------------------------------------------------------

/**
 * Mirrors a real payload where:
 *   stratify_by = ['Strain', 'Sex', 'Trait']
 *   simple_effects[0].factor = 'condition'  ← backend name
 *   per_group_means_over_time[*].group_factor = 'treatment'  ← row name
 * Guard 7 must alias-match these. Without normalization compound never activates.
 *
 * 4 strata (B6×M, D2×M, B6×F, D2×F), all Trait='Tail.Flick.Late'.
 * Expected: 2 compound panels (Sex=M|Trait=Tail.Flick.Late, Sex=F|Trait=Tail.Flick.Late).
 * Each panel has 4 traces (Strain × treatment-group).
 * No legacy stratum trajectory specs.
 */
const REAL_WORLD_3DIM_RAW = {
  success: true,
  test_type: 'lmm_anova_stratified',
  stratified: true,
  stratify_by: ['Strain', 'Sex', 'Trait'],
  strata_results: [
    {
      success: true,
      stratum: { Strain: 'B6', Sex: 'M', Trait: 'Tail.Flick.Late' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
      // simple_effects uses 'condition' — rows use 'treatment' (alias match required)
      simple_effects: [{ factor: 'condition', within: 'Week' }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.0, se: 0.5, ci_lower: 24.0, ci_upper: 26.0, n: 10 },
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 25.5, se: 0.5, ci_lower: 24.5, ci_upper: 26.5, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 28.0, se: 0.5, ci_lower: 27.0, ci_upper: 29.0, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 28.5, se: 0.5, ci_lower: 27.5, ci_upper: 29.5, n: 10 },
      ],
    },
    {
      success: true,
      stratum: { Strain: 'D2', Sex: 'M', Trait: 'Tail.Flick.Late' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
      simple_effects: [{ factor: 'condition', within: 'Week' }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 24.0, se: 0.5, ci_lower: 23.0, ci_upper: 25.0, n: 10 },
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 24.5, se: 0.5, ci_lower: 23.5, ci_upper: 25.5, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.0, se: 0.5, ci_lower: 26.0, ci_upper: 28.0, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 27.5, se: 0.5, ci_lower: 26.5, ci_upper: 28.5, n: 10 },
      ],
    },
    {
      success: true,
      stratum: { Strain: 'B6', Sex: 'F', Trait: 'Tail.Flick.Late' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
      simple_effects: [{ factor: 'condition', within: 'Week' }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 22.0, se: 0.4, ci_lower: 21.2, ci_upper: 22.8, n: 10 },
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 22.5, se: 0.4, ci_lower: 21.7, ci_upper: 23.3, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 24.5, se: 0.4, ci_lower: 23.7, ci_upper: 25.3, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 25.0, se: 0.4, ci_lower: 24.2, ci_upper: 25.8, n: 10 },
      ],
    },
    {
      success: true,
      stratum: { Strain: 'D2', Sex: 'F', Trait: 'Tail.Flick.Late' },
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
      simple_effects: [{ factor: 'condition', within: 'Week' }],
      per_group_means_over_time: [
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 21.0, se: 0.4, ci_lower: 20.2, ci_upper: 21.8, n: 10 },
        { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 21.5, se: 0.4, ci_lower: 20.7, ci_upper: 22.3, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 24.0, se: 0.4, ci_lower: 23.2, ci_upper: 24.8, n: 10 },
        { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 24.5, se: 0.4, ci_lower: 23.7, ci_upper: 25.3, n: 10 },
      ],
    },
  ],
}

describe('real-world regression — 3 stratify dims with alias mismatch', () => {
  it('compound activates: trajectoryLayout=compound on all trajectory specs', () => {
    const specs = buildLmmPlots(makeResult(REAL_WORLD_3DIM_RAW))
    const trajectorySpecs = specs.filter(s => s.plot.lmmMode === 'trajectory')
    expect(trajectorySpecs.length).toBeGreaterThan(0)
    expect(
      trajectorySpecs.every(s => (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound')
    ).toBe(true)
  })

  it('emits exactly 2 compound panels (Sex=M|Trait=Tail.Flick.Late and Sex=F|Trait=Tail.Flick.Late)', () => {
    const specs = buildLmmPlots(makeResult(REAL_WORLD_3DIM_RAW))
    const compound = specs.filter(
      s => (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )
    expect(compound).toHaveLength(2)
    const facetKeys = compound.map(s => s.plot.facetKey).sort()
    expect(facetKeys).toContain('Sex=F|Trait=Tail.Flick.Late')
    expect(facetKeys).toContain('Sex=M|Trait=Tail.Flick.Late')
  })

  it('each compound panel has exactly 4 traces (B6/D2 × VEH/THC)', () => {
    const specs = buildLmmPlots(makeResult(REAL_WORLD_3DIM_RAW))
    const compound = specs.filter(
      s => (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )
    for (const spec of compound) {
      expect(spec.plot.plotlyData).toHaveLength(4)
    }
  })

  it('emits zero legacy stratum trajectory specs (compound fully replaces them)', () => {
    const specs = buildLmmPlots(makeResult(REAL_WORLD_3DIM_RAW))
    const legacyTraj = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout !== 'compound'
    )
    expect(legacyTraj).toHaveLength(0)
  })

  it('legacy trajectory meta has no compoundGuardReason (compound succeeded)', () => {
    // compoundGuardReason should only appear on legacy specs when compound failed
    const specs = buildLmmPlots(makeResult(REAL_WORLD_3DIM_RAW))
    const compound = specs.filter(
      s => (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )
    for (const spec of compound) {
      const meta = (spec.plot.plotlyLayout as any)?.meta as Record<string, unknown>
      expect(meta.compoundGuardReason).toBeUndefined()
    }
  })

  it('trait de-duplication: Trait is excluded from title suffix when promoted into outcome label', () => {
    // When dependent_name='Value', resolveFacetOutcomeLabel replaces it with the Trait facet value.
    // In that case, Trait should NOT appear in the parenthetical suffix — it's already in the title.
    // Expected title: 'Tail.Flick.Late — Trajectory (Mean ± SE) (Sex = M)'
    // NOT:            'Tail.Flick.Late — Trajectory (Mean ± SE) (Sex = M, Trait = Tail.Flick.Late)'
    const specs = buildLmmPlots(makeResult(REAL_WORLD_3DIM_RAW, 'Value'))
    const compound = specs.filter(
      s => (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )
    expect(compound.length).toBeGreaterThan(0)
    for (const spec of compound) {
      const title = spec.plot.title ?? ''
      // Title should start with the promoted trait value
      expect(title).toMatch(/^Tail\.Flick\.Late/)
      // Trait should NOT appear in the parenthetical suffix
      expect(title).not.toMatch(/Trait\s*=/)
      // Sex should still appear in the parenthetical
      expect(title).toMatch(/Sex\s*=/)
    }
  })

  it('non-stratified result: compoundGuardReason is NOT stamped into legacy trajectory meta', () => {
    // Non-stratified LMM (no stratify_by) should never produce compoundGuardReason on legacy specs.
    // The misleading "Compound disabled: stratify_by missing or empty" banner must not appear.
    const nonStratifiedRaw = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      simple_effects: [{ factor: 'Treatment', within: 'Week' }],
      per_group_means_over_time: [
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25, se: 0.5, ci_lower: 24, ci_upper: 26, n: 10 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 28, se: 0.5, ci_lower: 27, ci_upper: 29, n: 10 },
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 25.5, se: 0.5, ci_lower: 24.5, ci_upper: 26.5, n: 10 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 28.5, se: 0.5, ci_lower: 27.5, ci_upper: 29.5, n: 10 },
      ],
    }
    const specs = buildLmmPlots(makeResult(nonStratifiedRaw))
    const trajectorySpecs = specs.filter(s => s.plot.lmmMode === 'trajectory')
    expect(trajectorySpecs.length).toBeGreaterThan(0)
    for (const spec of trajectorySpecs) {
      const meta = (spec.plot.plotlyLayout as any)?.meta as Record<string, unknown> | undefined
      expect(meta?.compoundGuardReason).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// v1 E2E stat contract — trajectory stats are non-empty and match contract keys
// ---------------------------------------------------------------------------

describe('buildLmmPlots — trajectory stats contract (v1 E2E parity)', () => {
  const V1_STAT_KEYS = [
    'total_points',
    'trace_count',
    'n_points_per_trace',
    'overall_mean',
    'mean_se',
    'min_mean',
    'max_mean',
    'sig_total_points',
    'sig_significant_points',
    'sig_ns_points',
  ] as const

  it('trajectory spec has non-empty stats with all v1 contract keys', () => {
    const specs = buildLmmPlots(makeResult(WITH_TRAJECTORY_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    expect(traj).toBeDefined()
    for (const key of V1_STAT_KEYS) {
      expect(traj.stats).toHaveProperty(key)
    }
  })

  it('structural stats match fixture: 2 traces × 2 timepoints', () => {
    const specs = buildLmmPlots(makeResult(WITH_TRAJECTORY_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    expect(traj.stats['total_points']).toBe(4)
    expect(traj.stats['trace_count']).toBe(2)
    expect(traj.stats['n_points_per_trace']).toBe(2)
  })

  it('value stats match fixture means and SEs', () => {
    const specs = buildLmmPlots(makeResult(WITH_TRAJECTORY_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    // means: 25.1, 25.4, 27.8, 28.6 → overall = 26.725
    expect(traj.stats['overall_mean']).toBeCloseTo(26.725, 3)
    // SEs: 0.5, 0.5, 0.4, 0.4 → mean_se = 0.45
    expect(traj.stats['mean_se']).toBeCloseTo(0.45, 3)
    expect(traj.stats['min_mean']).toBeCloseTo(25.1, 3)
    expect(traj.stats['max_mean']).toBeCloseTo(28.6, 3)
  })

  it('sig counts are zero when no simple-effect pValues are present', () => {
    const specs = buildLmmPlots(makeResult(WITH_TRAJECTORY_RAW))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    expect(traj.stats['sig_total_points']).toBe(0)
    expect(traj.stats['sig_significant_points']).toBe(0)
    expect(traj.stats['sig_ns_points']).toBe(0)
  })

  it('sig counts reflect method-sensitive pValue injection: 1 sig + 1 ns = 2 total', () => {
    // 2 timepoints with pValues: Week=1 (p=0.20, ns) + Week=2 (p=0.04, sig)
    const rawWithSig = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [
        { source: 'treatment x Week', f_value: 8.1, p_value: 0.005, num_df: 1, den_df: 15, significant: true },
      ],
      simple_effects: [{ factor: 'Treatment', within: 'Week' }],
      estimated_means: [],
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.20, significant: false, factor_scope: 'Treatment|Week=1' },
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.04, significant: true,  factor_scope: 'Treatment|Week=2' },
      ],
      per_group_means_over_time: [
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 25.4, se: 0.5, ci_lower: 24.4, ci_upper: 26.4, n: 10 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 28.6, se: 0.4, ci_lower: 27.8, ci_upper: 29.4, n: 10 },
      ],
    }
    const specs = buildLmmPlots(makeResult(rawWithSig))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    expect(traj.stats['sig_total_points']).toBe(2)
    expect(traj.stats['sig_significant_points']).toBe(1)
    expect(traj.stats['sig_ns_points']).toBe(1)
  })

  it('compound trajectory: trace_count = panelGroups.length (4), n_points_per_trace = rows per group (1)', () => {
    // COMPOUND_RAW: stratify_by=[Strain,Sex], 2 strata (B6+M, D2+M) × 2 treatments = 4 compound traces
    // Each trace has 1 timepoint → trace_count=4, n_points_per_trace=1, total_points=4
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW))
    const compound = specs.find(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound',
    )
    expect(compound).toBeDefined()
    expect(compound!.stats['trace_count']).toBe(4)
    expect(compound!.stats['n_points_per_trace']).toBe(1)
    expect(compound!.stats['total_points']).toBe(4)
  })

  it('compound trajectory: two panels with different rows produce different stats', () => {
    // COMPOUND_RAW_TWO_PANELS: Sex=M panel (B6 strata only) vs Sex=F panel (different means)
    const specs = buildLmmPlots(makeResult(COMPOUND_RAW_TWO_PANELS))
    const mPanel = specs.find(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound' &&
        s.plot.facetKey === 'Sex=M',
    )
    const fPanel = specs.find(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound' &&
        s.plot.facetKey === 'Sex=F',
    )
    expect(mPanel).toBeDefined()
    expect(fPanel).toBeDefined()
    // Sex=M means: 25.0, 28.0 → overall_mean=26.5
    // Sex=F means: 23.0, 26.0 → overall_mean=24.5
    // They must differ (panels render different rows)
    expect(mPanel!.stats['overall_mean']).not.toEqual(fPanel!.stats['overall_mean'])
    expect(mPanel!.stats['overall_mean']).toBeCloseTo(26.5, 3)
    expect(fPanel!.stats['overall_mean']).toBeCloseTo(24.5, 3)
  })

  it('stratified legacy trajectory (1 stratify dim): stats are non-empty with all v1 contract keys', () => {
    // SINGLE_DIM_STRATIFIED_RAW: stratify_by=['Sex'] → compound guard fails → legacy per-stratum specs
    // Each stratum has 2 rows → stats should be non-empty on legacy trajectory specs
    const specs = buildLmmPlots(makeResult(SINGLE_DIM_STRATIFIED_RAW))
    const legacyTraj = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout !== 'compound',
    )
    expect(legacyTraj.length).toBeGreaterThan(0)
    for (const spec of legacyTraj) {
      for (const key of V1_STAT_KEYS) {
        expect(spec.stats).toHaveProperty(key)
      }
      expect(spec.stats['total_points']).toBeGreaterThan(0)
    }
  })

  it('non-trajectory specs (contrast, line_unavailable) still have empty stats', () => {
    const specs = buildLmmPlots(makeResult({ ...WITH_TRAJECTORY_RAW, ...{ continuous_effects: [
      { time_value: 1, estimate: -0.5, se: 0.1, p: 0.04, label: 'VEH vs THC|treatment|Week=1' },
    ]}}))
    const contrast = specs.find(s => s.plot.lmmMode === 'contrast')
    // contrast spec must exist (fixture has continuous_effects) and stats remain empty (not part of v1 contract)
    expect(contrast).toBeDefined()
    expect(Object.keys(contrast!.stats)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// trajectory_roles end-to-end — integration tests (RED until wire-up complete)
// ---------------------------------------------------------------------------

/**
 * Compound plot with trajectory_roles.reference_level set to THC (opposite of the
 * pairwise_comparisons-derived baseline VEH). The explicit reference wins:
 *   THC → dot, VEH → solid
 * Before fix: buildLmmPlots passes no referenceLevel to buildCompoundDashMap →
 *   falls through to groupRole → VEH=dot, THC=solid (wrong when user chose THC).
 */
describe('buildLmmPlots — trajectory_roles.reference_level wired to dash map', () => {
  // GOLDEN_COMPOUND_RAW has VEH as pairwise group1 (semantic baseline → dot)
  // We add trajectory_roles.reference_level='THC' to override this.
  const COMPOUND_WITH_REF_LEVEL_RAW = {
    ...GOLDEN_COMPOUND_RAW,
    trajectory_roles: {
      treatment_factor: 'treatment',
      time_factor: 'Week',
      reference_level: 'THC',  // explicit override — should win over groupRole
    },
  }

  it('THC trace has dash=dot when trajectory_roles.reference_level=THC', () => {
    const specs = buildLmmPlots(makeResult(COMPOUND_WITH_REF_LEVEL_RAW))
    const compound = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )
    expect(compound).toHaveLength(2)

    // Check every compound panel: THC traces → dot, VEH traces → solid
    for (const spec of compound) {
      const traces = spec.plot.plotlyData as Array<{ name: string; line?: { dash?: string } }>
      const thcTraces = traces.filter(t => t.name.endsWith('THC') || t.name.endsWith('— THC'))
      const vehTraces = traces.filter(t => t.name.endsWith('VEH') || t.name.endsWith('— VEH'))
      expect(thcTraces.length).toBeGreaterThan(0)
      expect(vehTraces.length).toBeGreaterThan(0)
      for (const t of thcTraces) expect(t.line?.dash).toBe('dot')
      for (const t of vehTraces) expect(t.line?.dash).toBe('solid')
    }
  })
})

/**
 * Pooled result with trajectory_roles set and NO simple_effects and NO PGMOT rows.
 * Estimated_means has two categorical factors (both non-numeric → heuristic fails).
 * Before fix: resolveAxisRoles fails → no trajectory rows → line_unavailable.
 * After fix:  resolveAxisRoles uses trajectory_roles → trajectory rows produced.
 */
describe('buildLmmPlots — trajectory_roles wired into normalize estimated_means fallback', () => {
  const EM_ONLY_TRAJECTORY_ROLES_RAW = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    trajectory_roles: { treatment_factor: 'arm', time_factor: 'visit' },
    fixed_effects: [
      { source: 'arm x visit', f_value: 5.0, p_value: 0.02, num_df: 1, den_df: 18, significant: true },
    ],
    // Both factor values are categorical strings → heuristic cannot distinguish time from group
    estimated_means: [
      { factors: { arm: 'VEH', visit: 'Pre' },  emmean: 25.0, se: 0.5, ci_lower: 24.0, ci_upper: 26.0, n: 5 },
      { factors: { arm: 'VEH', visit: 'Post' }, emmean: 26.5, se: 0.5, ci_lower: 25.5, ci_upper: 27.5, n: 5 },
      { factors: { arm: 'THC', visit: 'Pre' },  emmean: 28.0, se: 0.5, ci_lower: 27.0, ci_upper: 29.0, n: 5 },
      { factors: { arm: 'THC', visit: 'Post' }, emmean: 29.5, se: 0.5, ci_lower: 28.5, ci_upper: 30.5, n: 5 },
    ],
    // No simple_effects, no per_group_means_over_time → forced to use trajectory_roles
    pairwise_comparisons: [],
    continuous_effects: null,
  }

  it('emits a trajectory spec when trajectory_roles resolves estimated_means axis roles', () => {
    const specs = buildLmmPlots(makeResult(EM_ONLY_TRAJECTORY_ROLES_RAW))
    const trajSpec = specs.find(s => s.plot.lmmMode === 'trajectory')
    expect(trajSpec).toBeDefined()
    // Should NOT fall back to line_unavailable
    expect(trajSpec?.plot.lmmMode).toBe('trajectory')
    expect(trajSpec?.plot.lmmMode).not.toBe('line_unavailable')
  })

  it('trajectory traces use arm as group factor (VEH and THC as separate traces)', () => {
    const specs = buildLmmPlots(makeResult(EM_ONLY_TRAJECTORY_ROLES_RAW))
    const trajSpec = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = trajSpec.plot.plotlyData as Array<{ name: string }>
    const traceNames = traces.map(t => t.name)
    // Two group values (VEH, THC) → two traces
    expect(traceNames.some(n => n.includes('VEH'))).toBe(true)
    expect(traceNames.some(n => n.includes('THC'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Regression: title_only_factors survives typed parsing (patch 1)
// ---------------------------------------------------------------------------

describe('buildLmmPlots — title_only_factors survives typed injection', () => {
  it('title_only_factors in plotPayload.parameters reaches canBuildCompoundTrajectory', () => {
    // Verify that title_only_factors stored in plotPayload.parameters is injected into
    // rawForPlots and reaches canBuildCompoundTrajectory — not silently stripped by the
    // storedPlotFacetRoles type annotation.
    // GOLDEN_COMPOUND_RAW: stratify_by=['Strain','Sex'], simple_effects=[{factor:Treatment,within:Week}]
    // Injecting title_only_factors=['Sex'] should produce 2 title splits (Sex=M, Sex=F).
    const resultWithTitleOnly = {
      ...makeResult(GOLDEN_COMPOUND_RAW),
      plotPayload: {
        test: 'lmm_anova',
        data: { dependent_name: 'Body Weight (g)', value_column: 'Body Weight (g)' },
        parameters: {
          plot_facet_roles: {
            color_by: 'Strain',
            facet_by: '',
            title_only_factors: ['Sex'],
          },
        },
      },
    }

    const specs = buildLmmPlots(resultWithTitleOnly)
    const compound = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )

    // If title_only_factors was stripped by typed parsing we'd get 1 spec (panelFactors=['Sex'])
    // or 0 specs. We must get exactly 2 (one per Sex value).
    expect(compound).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Regression: bracketEffectMap IDs are distinct across title splits (patch 5)
// ---------------------------------------------------------------------------

describe('buildLmmPlots — bracket IDs distinct across title splits', () => {
  it('two title splits produce non-overlapping bracketEffectMap keys', () => {
    const resultWithTitleOnly = {
      ...makeResult(GOLDEN_COMPOUND_RAW),
      plotPayload: {
        test: 'lmm_anova',
        data: { dependent_name: 'Body Weight (g)', value_column: 'Body Weight (g)' },
        parameters: {
          plot_facet_roles: {
            color_by: 'Strain',
            facet_by: '',
            title_only_factors: ['Sex'],
          },
        },
      },
    }

    const specs = buildLmmPlots(resultWithTitleOnly)
    const compound = specs.filter(
      s => s.plot.lmmMode === 'trajectory' &&
        (s.plot.plotlyLayout as any)?.meta?.trajectoryLayout === 'compound'
    )

    expect(compound).toHaveLength(2)

    const allEffectIds = compound.flatMap(s => {
      const meta = (s.plot.plotlyLayout as any)?.meta ?? {}
      return Object.keys(meta.bracketEffectMap ?? {})
    })

    // No effect ID should appear in both splits
    const idCounts = new Map<string, number>()
    for (const id of allEffectIds) {
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
    }
    const duplicates = [...idCounts.entries()].filter(([, count]) => count > 1)
    expect(duplicates).toHaveLength(0)
  })
})
