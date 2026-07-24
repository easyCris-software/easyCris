import { describe, expect, it } from 'vitest'
import { compareToRBaseline } from '../../../e2e/utils/r-validation.mjs'

describe('compareToRBaseline', () => {
  it('supports explicit absolute tolerance mode for metric comparison', () => {
    const actual = { p_value: 0.1677 }
    const baseline = { p_value: 0.1743 }

    const comparison = compareToRBaseline(actual, baseline, {
      defaultTolerance: 0.02,
      defaultToleranceMode: 'absolute',
    })

    expect(comparison.passed).toBe(true)
    expect(comparison.failedMetrics).toBe(0)
  })
})
