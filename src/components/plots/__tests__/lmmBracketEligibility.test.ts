/**
 * isLmmEditSignificanceEligible — unit tests
 *
 * Verifies the single eligibility source used by all four guard sites:
 * UI row, toggle handler, mergeRebuiltLayout hovermode lock, PlotCanvas cursor.
 */
import { describe, it, expect } from 'vitest'
import { isLmmEditSignificanceEligible } from '../lmmBracketEligibility'
import type { PlotLayoutMeta } from '@/utils/plotBuilders/types'

const BASE_SHAPE_PARAMS = { halfWidth: 0.15, tickHeightRatio: 0.001, lineWidth: 0.5, ySpan: 10 }

const validPlot = {
  sourceType: 'test_result' as const,
  type: 'line',
  testType: 'lmm_anova',
  lmmMode: 'trajectory' as const,
}

const validMeta: PlotLayoutMeta = {
  bracketShapeParams: BASE_SHAPE_PARAMS,
}

describe('isLmmEditSignificanceEligible', () => {
  it('returns true for a valid LMM trajectory plot with bracketShapeParams', () => {
    expect(isLmmEditSignificanceEligible(validPlot, validMeta)).toBe(true)
  })

  it('returns true for lmm_anova_stratified via normalizeTestId alias (not direct set membership)', () => {
    // normalizeTestId('lmm_anova_stratified') → 'lmm_anova'
    // LMM_TEST_IDS only contains 'lmm_anova'; stratified passes through normalisation.
    expect(isLmmEditSignificanceEligible(
      { ...validPlot, testType: 'lmm_anova_stratified' },
      validMeta,
    )).toBe(true)
  })

  it('returns false when plot is null', () => {
    expect(isLmmEditSignificanceEligible(null, validMeta)).toBe(false)
  })

  it('returns false when sourceType is not test_result', () => {
    expect(isLmmEditSignificanceEligible(
      { ...validPlot, sourceType: 'user_derived' },
      validMeta,
    )).toBe(false)
  })

  it('returns false when type is not "line" (bar, violin, box, grouped_bar, etc.)', () => {
    for (const type of ['bar', 'violin', 'box', 'grouped_bar', 'column_scatter', 'histogram']) {
      expect(isLmmEditSignificanceEligible(
        { ...validPlot, type },
        validMeta,
      )).toBe(false)
    }
  })

  it('returns false for non-LMM test types (anova, t-test, etc.)', () => {
    for (const testType of ['one_way_anova', 't_test', 'two_way_anova', 'kruskal_wallis', 'mixed_anova']) {
      expect(isLmmEditSignificanceEligible(
        { ...validPlot, testType },
        validMeta,
      )).toBe(false)
    }
  })

  it('returns false when lmmMode is not trajectory', () => {
    expect(isLmmEditSignificanceEligible(
      { ...validPlot, lmmMode: 'contrast' },
      validMeta,
    )).toBe(false)

    expect(isLmmEditSignificanceEligible(
      { ...validPlot, lmmMode: null },
      validMeta,
    )).toBe(false)
  })

  it('returns false when bracketShapeParams is missing (shapes not in custom path format)', () => {
    expect(isLmmEditSignificanceEligible(validPlot, {})).toBe(false)
  })
})
