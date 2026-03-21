import { describe, expect, it } from 'vitest'
import { buildFactorialAnovaTables } from '@/utils/ecpTableBuilders/factorialAnovaTables'
import { DEFAULT_TABLE_OPTIONS } from '@/utils/ecpTableBuilders'

const seFootnote =
  'Std Error values are model-based. In balanced designs, repeated SE values are expected; in unbalanced designs, SE values may differ across comparisons.'

describe('factorialAnovaTables simple effects warning footnotes', () => {
  it('adds two-way simple effects warning as a simple effects table footnote', () => {
    const warning =
      'Interaction not significant (p = 0.2936 >= 0.05). Interpret simple effects with caution. Consider main effects instead.'

    const result = buildFactorialAnovaTables(
      {
        test_type: 'two_way',
        factor1_label: 'factor1',
        factor2_label: 'factor2',
        factor1_df: 1,
        factor1_f: 1.2,
        factor1_p: 0.22,
        factor2_df: 1,
        factor2_f: 2.3,
        factor2_p: 0.14,
        interaction_df: 1,
        interaction_f: 0.5,
        interaction_p: 0.2936,
        residual_df: 12,
        pairwise_comparisons: [
          {
            group1: 'A',
            group2: 'B',
            mean_diff: -2.975,
            se: 0.7404,
            t_stat: -4.0183,
            p_adjusted: 0.0017,
            factor_scope: 'factor1|factor2=X',
          },
        ],
        simple_effects_warning: warning,
      },
      DEFAULT_TABLE_OPTIONS,
      'two_way_anova'
    )

    const simpleEffectsTable = result.tables.find(table => table.testName === 'factorial_simple_effects')
    expect(simpleEffectsTable).toBeDefined()
    expect(simpleEffectsTable?.footnotes).toEqual([warning, seFootnote])
  })

  it('adds multifactorial simple effects warning as a simple effects table footnote', () => {
    const warning =
      'No significant interaction terms were detected (alpha = 0.05). Interpret simple effects with caution. Consider main effects instead.'

    const result = buildFactorialAnovaTables(
      {
        test_type: 'multifactorial',
        factor_names: ['A', 'B', 'C'],
        n_total: 24,
        main_effects: [
          { source: 'A', df: 1, SS: 10.0, MS: 10.0, F: 4.2, p_value: 0.06 },
          { source: 'B', df: 1, SS: 12.0, MS: 12.0, F: 5.1, p_value: 0.04 },
        ],
        interactions: [{ source: 'A by B', df: 1, SS: 2.0, MS: 2.0, F: 0.8, p_value: 0.39 }],
        residual_df: 18,
        pairwise_comparisons: [
          {
            group1: 'A1',
            group2: 'A2',
            mean_diff: -1.1,
            se: 0.5,
            t_stat: -2.2,
            p_adjusted: 0.04,
            factor_scope: 'A|B=B1',
          },
        ],
        simple_effects_warning: warning,
      },
      DEFAULT_TABLE_OPTIONS,
      'multifactorial_anova'
    )

    const simpleEffectsTable = result.tables.find(table => table.testName === 'factorial_simple_effects')
    expect(simpleEffectsTable).toBeDefined()
    expect(simpleEffectsTable?.footnotes).toEqual([warning, seFootnote])
  })

  it('adds the model-based SE footnote even when no interaction warning is present', () => {
    const result = buildFactorialAnovaTables(
      {
        test_type: 'two_way',
        factor1_label: 'factor1',
        factor2_label: 'factor2',
        factor1_df: 1,
        factor1_f: 6.2,
        factor1_p: 0.01,
        factor2_df: 1,
        factor2_f: 4.3,
        factor2_p: 0.03,
        interaction_df: 1,
        interaction_f: 5.1,
        interaction_p: 0.02,
        residual_df: 12,
        pairwise_comparisons: [
          {
            group1: 'A',
            group2: 'B',
            mean_diff: -2.975,
            se: 0.7404,
            t_stat: -4.0183,
            p_adjusted: 0.0017,
            factor_scope: 'factor1|factor2=X',
          },
        ],
      },
      DEFAULT_TABLE_OPTIONS,
      'two_way_anova'
    )

    const simpleEffectsTable = result.tables.find(table => table.testName === 'factorial_simple_effects')
    expect(simpleEffectsTable).toBeDefined()
    expect(simpleEffectsTable?.footnotes).toEqual([seFootnote])
  })
})
