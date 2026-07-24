/**
 * LMM E2E smoke test
 *
 * Verifies that buildPlotSpecsFromResult (the real recipe dispatcher) produces
 * the correct set of PlotSpecWithStats for lmm_anova and lmm_anova_stratified.
 *
 * This is an integration-level test: it exercises the full path from
 * TestResult → recipe lookup → customBuilder → PlotSpecWithStats[].
 */

import { describe, it, expect } from 'vitest'
import { buildPlotSpecsFromResult } from '@/services/plotResultService'
import type { TestResult } from '@/store/results-store'

// ---------------------------------------------------------------------------
// Shared fixture builder
// ---------------------------------------------------------------------------

function makeLmmResult(rawOutput: unknown, testId = 'lmm_anova'): TestResult {
  return {
    id: 'e2e-lmm-1',
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

const LMM_RAW_WITH_LINE = {
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
  per_group_means_over_time: [
    { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 25.1, se: 0.5, ci_lower: 24.1, ci_upper: 26.1, n: 10 },
    { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 25.4, se: 0.5, ci_lower: 24.4, ci_upper: 26.4, n: 10 },
    { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 27.8, se: 0.4, ci_lower: 27.0, ci_upper: 28.6, n: 10 },
    { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 28.6, se: 0.4, ci_lower: 27.8, ci_upper: 29.4, n: 10 },
  ],
  continuous_effects: [
    { time_value: 1, estimate: -0.5, se: 0.1, p: 0.04, label: 'VEH vs THC|treatment|Week=1' },
    { time_value: 2, estimate: -1.1, se: 0.15, p: 0.01, label: 'VEH vs THC|treatment|Week=2' },
  ],
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
      continuous_effects: null,
    },
  ],
}

// ---------------------------------------------------------------------------
// lmm_anova — pooled with line
// ---------------------------------------------------------------------------

describe('buildPlotSpecsFromResult — lmm_anova end-to-end', () => {
  it('produces exactly 2 line specs when trajectory + contrast payloads both exist', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_RAW_WITH_LINE))
    expect(specs).toHaveLength(2)
  })

  it('first spec is line (trajectory mode)', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_RAW_WITH_LINE))
    expect(specs[0]!.plot.type).toBe('line')
    expect(specs[0]!.plot.lmmMode).toBe('trajectory')
  })

  it('second spec is line (contrast mode)', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_RAW_WITH_LINE))
    expect(specs[1]!.plot.type).toBe('line')
    expect(specs[1]!.plot.lmmMode).toBe('contrast')
  })

  it('both specs carry testType lmm_anova', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_RAW_WITH_LINE))
    for (const s of specs) {
      expect(s.plot.testType).toBe('lmm_anova')
    }
  })

  it('both specs carry the input resultId', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_RAW_WITH_LINE))
    for (const s of specs) {
      expect(s.plot.resultId).toBe('e2e-lmm-1')
    }
  })

  it('produces 1 unavailable placeholder line when both line payloads are absent', () => {
    const raw = { ...LMM_RAW_WITH_LINE, continuous_effects: null, per_group_means_over_time: null }
    const specs = buildPlotSpecsFromResult(makeLmmResult(raw))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.plot.type).toBe('line')
    expect(specs[0]!.plot.lmmMode).toBe('line_unavailable')
  })

  it('produces 0 specs when rawOutput is null', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(null))
    expect(specs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// lmm_anova_stratified — alias routes through same builder
// ---------------------------------------------------------------------------

// LMM_STRATIFIED_RAW has 1 successful stratum with no line payload
// → unavailable placeholder emitted for that stratum
describe('buildPlotSpecsFromResult — lmm_anova_stratified end-to-end', () => {
  it('produces 1 placeholder spec for a stratified result with no line payload', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_STRATIFIED_RAW, 'lmm_anova_stratified'))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.plot.type).toBe('line')
    expect(specs[0]!.plot.lmmMode).toBe('line_unavailable')
  })

  it('does not emit grouped_bar fallback in stratified line-only mode', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_STRATIFIED_RAW, 'lmm_anova_stratified'))
    expect(specs.some(s => s.plot.type === 'grouped_bar')).toBe(false)
  })

  it('preserves stratified test id semantics when line specs exist', () => {
    const withLines = {
      ...LMM_STRATIFIED_RAW,
      strata_results: [
        {
          ...LMM_STRATIFIED_RAW.strata_results[0],
          per_group_means_over_time: [
            { group_factor: 'treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 26.0, se: 0.6, ci_lower: 24.8, ci_upper: 27.2, n: 5 },
            { group_factor: 'treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 29.0, se: 0.5, ci_lower: 28.0, ci_upper: 30.0, n: 5 },
          ],
        },
      ],
    }
    const specs = buildPlotSpecsFromResult(makeLmmResult(withLines, 'lmm_anova_stratified'))
    expect(specs.length).toBeGreaterThan(0)
    expect(specs[0]!.plot.testType).toBe('lmm_anova_stratified')
  })
})

// ---------------------------------------------------------------------------
// RED tests: trajectory significance shape contract — e2e path
// These FAIL until Task 2 implementation migrates trace-text to shapes.
// ---------------------------------------------------------------------------

const LMM_TRAJ_WITH_SE = {
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

// ---------------------------------------------------------------------------
// Task 3: Sidebar/control parity verification — service-level contract checks
// ---------------------------------------------------------------------------

describe('buildPlotSpecsFromResult — lmm trajectory sidebar parity (Task 3)', () => {
  // Shared trajectory spec helper
  function getTraj() {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_TRAJ_WITH_SE))
    return specs.find(s => s.plot.lmmMode === 'trajectory')!
  }

  // --- toggleEffectVisibility path ---
  it('bracketEffectMap entries have label and group fields required by sidebar effect-list renderer', () => {
    const traj = getTraj()
    const effectMap = ((traj.plot.plotlyLayout as any).meta?.bracketEffectMap ?? {}) as Record<string, unknown>
    expect(Object.keys(effectMap).length).toBeGreaterThan(0)
    for (const entry of Object.values(effectMap) as any[]) {
      expect(typeof entry.label).toBe('string')
      expect(entry.label.length).toBeGreaterThan(0)
      expect(['main', 'simple', 'comparison']).toContain(entry.group)
    }
  })

  it('bracketEffectShapes values only reference shape names that exist in layout.shapes', () => {
    const traj = getTraj()
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const effectShapes = meta.bracketEffectShapes as Record<string, string[]>
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as Array<{ name?: string }>
    const shapeNames = new Set(shapes.map(s => s.name).filter(Boolean))
    for (const names of Object.values(effectShapes)) {
      for (const name of names) {
        expect(shapeNames.has(name)).toBe(true)
      }
    }
  })

  // --- updateBracketLabelMode path ---
  // Sidebar uses index fallback: sig_bracket_N → catalog.brackets[N]
  it('bracketCatalog.brackets[N] corresponds to sig_bracket_N (label mode index alignment)', () => {
    const traj = getTraj()
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const catalog = meta.bracketCatalog as { brackets: Array<{ label: string; pValue: number }> }
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as Array<{ name?: string }>
    const sigShapes = shapes.filter(s => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    // Every sig_bracket_N must have a corresponding catalog.brackets[N]
    for (const shape of sigShapes) {
      const idx = Number((shape.name as string).replace('sig_bracket_', ''))
      expect(catalog.brackets[idx]).toBeDefined()
      expect(typeof catalog.brackets[idx]!.label).toBe('string')
      expect(typeof catalog.brackets[idx]!.pValue).toBe('number')
    }
  })

  it('bracketCatalog brackets have effectId matching a key in bracketEffectShapes', () => {
    const traj = getTraj()
    const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
    const catalog = meta.bracketCatalog as { brackets: Array<{ effectId?: string }> }
    const effectShapes = meta.bracketEffectShapes as Record<string, string[]>
    for (const bracket of catalog.brackets) {
      if (bracket.effectId) {
        expect(effectShapes[bracket.effectId]).toBeDefined()
      }
    }
  })

  // --- parsePathPoints / lockBracketPathX / getBracketYBounds path ---
  it('all sig_bracket_* shapes have type path with ≥8 numeric tokens (PlotCanvas parsePathPoints compat)', () => {
    const traj = getTraj()
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as Array<{ name?: string; type?: string; path?: string }>
    const sigShapes = shapes.filter(s => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    expect(sigShapes.length).toBeGreaterThan(0)
    for (const shape of sigShapes) {
      expect(shape.type).toBe('path')
      const nums = (shape.path ?? '').match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
      expect(nums.length).toBeGreaterThanOrEqual(8)
    }
  })

  it('sig_bracket_* path center x is a non-negative category index (lockBracketPathX preserves position)', () => {
    const traj = getTraj()
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as Array<{ name?: string; path?: string }>
    const sigShapes = shapes.filter(s => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
    for (const shape of sigShapes) {
      const nums = (shape.path ?? '').match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)!.map(Number)
      // Real-width bracket: M xL,tipY L xL,baseY L xR,baseY L xR,tipY
      const xLeft  = nums[0]!
      const xRight = nums[4]!
      // xLeft < xRight (real width, not degenerate)
      expect(xLeft).toBeLessThan(xRight)
      // center must be a non-negative integer (category index)
      const centerX = (xLeft + xRight) / 2
      expect(centerX).toBeGreaterThanOrEqual(0)
      expect(centerX).toBeCloseTo(Math.round(centerX), 5)
    }
  })

  // --- bracketSettings path ---
  it('bracketSettings.showNs is true so ns labels render via sidebar label mode', () => {
    const traj = getTraj()
    const settings = (traj.plot.plotlyLayout as any).meta?.bracketSettings
    expect(settings?.showNs).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// M3: Stratified trajectory with simpleEffectsRequested=true — bracket shapes per facet
// ---------------------------------------------------------------------------

const LMM_STRATIFIED_WITH_SE = {
  success: true,
  test_type: 'lmm_anova_stratified',
  stratified: true,
  stratify_by: ['sex'],
  strata_results: [
    {
      success: true,
      stratum: { sex: 'M' },
      fixed_effects: [
        { source: 'Treatment x Week', f_value: 9.0, p_value: 0.003, num_df: 1, den_df: 15, significant: true },
      ],
      estimated_means: [
        { factors: { Treatment: 'VEH' }, emmean: 26.0, se: 0.6, ci_lower: 24.8, ci_upper: 27.2, n: 5 },
        { factors: { Treatment: 'THC' }, emmean: 29.0, se: 0.5, ci_lower: 28.0, ci_upper: 30.0, n: 5 },
      ],
      per_group_means_over_time: [
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 26.0, se: 0.6, ci_lower: 24.8, ci_upper: 27.2, n: 5 },
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 27.0, se: 0.6, ci_lower: 25.8, ci_upper: 28.2, n: 5 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 29.0, se: 0.5, ci_lower: 28.0, ci_upper: 30.0, n: 5 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 30.5, se: 0.5, ci_lower: 29.5, ci_upper: 31.5, n: 5 },
      ],
      simple_effects: [{ factor: 'Treatment', within: 'Week' }],
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.03, significant: true,  factor_scope: 'Treatment|Week=1' },
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.001, significant: true, factor_scope: 'Treatment|Week=2' },
      ],
      continuous_effects: null,
    },
    {
      success: true,
      stratum: { sex: 'F' },
      fixed_effects: [
        { source: 'Treatment x Week', f_value: 2.1, p_value: 0.15, num_df: 1, den_df: 15, significant: false },
      ],
      estimated_means: [
        { factors: { Treatment: 'VEH' }, emmean: 22.0, se: 0.4, ci_lower: 21.2, ci_upper: 22.8, n: 5 },
        { factors: { Treatment: 'THC' }, emmean: 24.0, se: 0.4, ci_lower: 23.2, ci_upper: 24.8, n: 5 },
      ],
      per_group_means_over_time: [
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 1, mean: 22.0, se: 0.4, ci_lower: 21.2, ci_upper: 22.8, n: 5 },
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Week', time_value: 2, mean: 23.0, se: 0.4, ci_lower: 22.2, ci_upper: 23.8, n: 5 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 1, mean: 24.0, se: 0.4, ci_lower: 23.2, ci_upper: 24.8, n: 5 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Week', time_value: 2, mean: 25.0, se: 0.4, ci_lower: 24.2, ci_upper: 25.8, n: 5 },
      ],
      simple_effects: [{ factor: 'Treatment', within: 'Week' }],
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.20, significant: false, factor_scope: 'Treatment|Week=1' },
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.30, significant: false, factor_scope: 'Treatment|Week=2' },
      ],
      continuous_effects: null,
    },
  ],
}

describe('buildPlotSpecsFromResult — lmm_anova_stratified trajectory bracket shapes (M3)', () => {
  it('emits sig_bracket_* shapes for each successful stratum with simple effects', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_STRATIFIED_WITH_SE, 'lmm_anova_stratified'))
    const trajSpecs = specs.filter(s => s.plot.lmmMode === 'trajectory')
    expect(trajSpecs.length).toBeGreaterThan(0)
    for (const traj of trajSpecs) {
      const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
      const sigShapes = shapes.filter((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))
      expect(sigShapes.length).toBeGreaterThan(0)
    }
  })

  it('each stratum trajectory spec has full bracket metadata contract', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_STRATIFIED_WITH_SE, 'lmm_anova_stratified'))
    const trajSpecs = specs.filter(s => s.plot.lmmMode === 'trajectory')
    for (const traj of trajSpecs) {
      const meta = (traj.plot.plotlyLayout as any).meta as Record<string, unknown>
      expect(meta.bracketCatalog).toBeDefined()
      expect(meta.bracketEffectMap).toBeDefined()
      expect(meta.bracketEffectShapes).toBeDefined()
      expect(meta.bracketVisibility).toBeDefined()
      expect(meta.bracketSettings).toBeDefined()
    }
  })

  it('stratum effectIds are facet-scoped (contain sex=M or sex=F segment)', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_STRATIFIED_WITH_SE, 'lmm_anova_stratified'))
    const trajSpecs = specs.filter(s => s.plot.lmmMode === 'trajectory')
    for (const traj of trajSpecs) {
      const effectMap = (traj.plot.plotlyLayout as any).meta?.bracketEffectMap as Record<string, unknown>
      const keys = Object.keys(effectMap)
      // lmm_se| per-timepoint keys and lmm_cmp| master key — all must be facet-scoped
      expect(keys.every(k => k.startsWith('lmm_se|sex=') || k.startsWith('lmm_cmp|sex='))).toBe(true)
    }
  })
})

describe('buildPlotSpecsFromResult — lmm trajectory significance shapes [RED → Task 2]', () => {
  it('trajectory spec layout.shapes has sig_bracket_* shapes', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_TRAJ_WITH_SE))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const shapes = ((traj.plot.plotlyLayout as any).shapes ?? []) as any[]
    expect(shapes.some((s: any) => typeof s.name === 'string' && s.name.startsWith('sig_bracket_'))).toBe(true)
  })

  it('trajectory layout.meta has all bracket metadata contract fields', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_TRAJ_WITH_SE))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const meta = ((traj.plot.plotlyLayout as any).meta ?? {}) as Record<string, unknown>
    expect(meta.bracketCatalog).toBeDefined()
    expect(meta.bracketEffectMap).toBeDefined()
    expect(meta.bracketEffectShapes).toBeDefined()
    expect(meta.bracketVisibility).toBeDefined()
    expect(meta.bracketSettings).toBeDefined()
  })

  it('trajectory traces carry no significance text after migration', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_TRAJ_WITH_SE))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    const traces = traj.plot.plotlyData as Array<{ text?: unknown }>
    expect(traces.every(t => t.text === undefined)).toBe(true)
  })

  it('trajectory plotlyConfig enables shape drag', () => {
    const specs = buildPlotSpecsFromResult(makeLmmResult(LMM_TRAJ_WITH_SE))
    const traj = specs.find(s => s.plot.lmmMode === 'trajectory')!
    expect((traj.plot.plotlyConfig as any)?.edits?.shapePosition).toBe(true)
  })
})
