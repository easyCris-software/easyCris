import { describe, expect, it } from 'vitest'
import { buildLmmPlots } from '@/services/plotResult/lmm/buildLmmPlots'
import type { TestResult } from '@/store/results-store'

function makeResult(rawOutput: unknown): TestResult {
  return {
    id: 'mode-policy-result',
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
        dependent_name: 'Value',
        value_column: 'Value',
      },
    },
  }
}

describe('LMM mode policy (RED)', () => {
  it('emits trajectory line as primary when trajectory payload exists', () => {
    const raw = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [{ source: 'Treatment x Day_num', significant: true }],
      estimated_means: [{ factors: { Treatment: 'A' }, emmean: 1.0, se: 0.1, ci_lower: 0.8, ci_upper: 1.2, n: 6 }],
      per_group_means_over_time: [
        {
          group_factor: 'Treatment',
          group_value: 'A',
          time_factor: 'Day_num',
          time_value: 0,
          mean: 1.0,
          se: 0.1,
          ci_lower: 0.8,
          ci_upper: 1.2,
          n: 6,
        },
      ],
      continuous_effects: null,
    }
    const specs = buildLmmPlots(makeResult(raw))
    expect(specs.length).toBeGreaterThan(0)
    expect(specs[0]!.plot.type).toBe('line')
  })

  it('emits unavailable placeholder line when neither trajectory nor contrast payload exists', () => {
    const raw = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [{ factors: { Treatment: 'A' }, emmean: 1.0, se: 0.1, ci_lower: 0.8, ci_upper: 1.2, n: 6 }],
      continuous_effects: null,
      per_group_means_over_time: null,
    }
    const specs = buildLmmPlots(makeResult(raw))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.plot.type).toBe('line')
    expect(specs[0]!.plot.lmmMode).toBe('line_unavailable')
  })

  it('emits both line modes (trajectory + contrast) when both payloads exist', () => {
    const raw = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [{ source: 'Treatment x Day_num', significant: true }],
      estimated_means: [{ factors: { Treatment: 'A' }, emmean: 1.0, se: 0.1, ci_lower: 0.8, ci_upper: 1.2, n: 6 }],
      per_group_means_over_time: [
        {
          group_factor: 'Treatment',
          group_value: 'A',
          time_factor: 'Day_num',
          time_value: 0,
          mean: 1.0,
          se: 0.1,
          ci_lower: 0.8,
          ci_upper: 1.2,
          n: 6,
        },
      ],
      continuous_effects: [
        { time_value: 0, estimate: 0.2, se: 0.05, p: 0.04, label: 'A vs B|Treatment|Day_num=0' },
      ],
    }
    const specs = buildLmmPlots(makeResult(raw))
    const lines = specs.filter(s => s.plot.type === 'line')
    expect(lines).toHaveLength(2)
    expect(lines.every(s => typeof (s.plot as { lmmMode?: unknown }).lmmMode === 'string')).toBe(true)
  })

  it('does not emit grouped_bar fallback under line-only policy', () => {
    const raw = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [
        { factors: { Treatment: 'A' }, emmean: 1.0, se: 0.1, ci_lower: 0.8, ci_upper: 1.2, n: 6 },
        { factors: { Treatment: 'B' }, emmean: 1.5, se: 0.1, ci_lower: 1.3, ci_upper: 1.7, n: 6 },
      ],
      pairwise_comparisons: [{ group1: 'A', group2: 'B', p_adjusted: 0.01, significant: true }],
      continuous_effects: null,
      per_group_means_over_time: null,
    }
    const specs = buildLmmPlots(makeResult(raw))
    expect(specs.some(s => s.plot.type === 'grouped_bar')).toBe(false)
  })

  it('line significance renders stars and ns labels', () => {
    const raw = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [{ source: 'Treatment x Day_num', significant: true }],
      estimated_means: [{ factors: { Treatment: 'A' }, emmean: 1.0, se: 0.1, ci_lower: 0.8, ci_upper: 1.2, n: 6 }],
      simple_effects: [{ factor: 'Treatment', within: 'Day_num' }],
      continuous_effects: [
        { time_value: 1, estimate: 0.1, se: 0.05, p: 0.20, label: 'A vs B|Treatment|Day_num=1' },
        { time_value: 2, estimate: 0.3, se: 0.05, p: 0.01, label: 'A vs B|Treatment|Day_num=2' },
      ],
    }
    const specs = buildLmmPlots(makeResult(raw))
    const line = specs.find(s => s.plot.type === 'line')
    expect(line).toBeDefined()
    const traces = line!.plot.plotlyData as Array<{ text?: string[] }>
    const text = traces.flatMap(t => t.text ?? [])
    expect(text).toContain('*')
    expect(text).toContain('ns')
  })
})
