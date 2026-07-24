import { describe, expect, it } from 'vitest'
import type { TestResult } from '@/store/results-store'
import { buildCoxForestPlot } from './generateSurvivalPlots'

function coxResultWithParams(parameterEstimates: Array<Record<string, unknown>>): TestResult {
  return {
    id: 'cox-result',
    testId: 'cox_regression',
    testName: 'Cox Proportional Hazards',
    family: 'survival',
    executedAt: new Date('2026-01-01T00:00:00Z'),
    statistics: {},
    rawOutput: {
      parameter_estimates: parameterEstimates,
    },
  }
}

describe('buildCoxForestPlot', () => {
  it('sets a finite log-space x range that contains wide confidence intervals', () => {
    const plot = buildCoxForestPlot(
      coxResultWithParams([
        {
          parameter: 'TreatmentGroup',
          hazard_ratio: 0.3,
          hr_ci_lower_95: 0.0173,
          hr_ci_upper_95: 18,
          std_error: 1.2,
          p_value: 0.23,
        },
      ])
    )

    expect(plot).not.toBeNull()
    const xaxis = plot!.layout.xaxis as { range?: [number, number]; autorange?: boolean; type?: string }
    const range = xaxis.range

    expect(xaxis.type).toBe('log')
    expect(xaxis.autorange).toBe(false)
    expect(range).toBeDefined()
    expect(range!.every(Number.isFinite)).toBe(true)
    expect(range![0]).toBeLessThan(Math.log10(0.0173))
    expect(range![1]).toBeGreaterThan(Math.log10(18))
    expect(plot!.stats.x_log_range_min).toBe(range![0])
    expect(plot!.stats.x_log_range_max).toBe(range![1])
  })

  it('uses the coefficient to frame separated Cox results when rounded HR is zero', () => {
    const plot = buildCoxForestPlot(
      coxResultWithParams([
        {
          parameter: 'TreatmentGroupTreatment',
          estimate: -22.3367,
          hazard_ratio: 0,
          hr_ci_lower_95: 0,
          hr_ci_upper_95: null,
          std_error: 4557.1,
          p_value: 0.9961,
        },
      ])
    )

    expect(plot).not.toBeNull()
    const xaxis = plot!.layout.xaxis as { range?: [number, number]; autorange?: boolean; type?: string }
    const range = xaxis.range

    expect(range).toBeDefined()
    expect(range!.every(Number.isFinite)).toBe(true)
    expect(range![0]).toBeGreaterThan(-4)
    expect(range![0]).toBeLessThan(-3)
    expect(range![1]).toBeGreaterThan(0)
    expect(plot!.data[0].x).toEqual([0.001])
  })
})
