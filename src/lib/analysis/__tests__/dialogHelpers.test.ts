import { describe, it, expect } from 'vitest'
import { shouldShowSimpleEffects } from '../dialogHelpers'

describe('dialogHelpers.shouldShowSimpleEffects', () => {
  it('returns true for underscore-based ANOVA ids', () => {
    expect(shouldShowSimpleEffects(['two_way_anova'])).toBe(true)
    expect(shouldShowSimpleEffects(['scheirer_ray_hare'])).toBe(true)
    expect(shouldShowSimpleEffects(['multi_factorial_anova'])).toBe(true)
  })

  it('returns true for dashed ANOVA names', () => {
    expect(shouldShowSimpleEffects(['Two-Way ANOVA'])).toBe(true)
    expect(shouldShowSimpleEffects(['multi-factorial anova'])).toBe(true)
  })

  it('returns false for tests without factor contrasts', () => {
    expect(shouldShowSimpleEffects(['mann_whitney'])).toBe(false)
    expect(shouldShowSimpleEffects(['binary_logistic_regression'])).toBe(false)
  })
})
