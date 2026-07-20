import { describe, expect, it } from 'vitest'
import { buildFactorialAnovaTables } from '@/utils/ecpTableBuilders/factorialAnovaTables'
import { DEFAULT_TABLE_OPTIONS } from '@/utils/ecpTableBuilders'

describe('factorialAnovaTables CI columns', () => {
  it('renders estimate, std error, and combined 95% CI for marginal and simple effects', () => {
    const result = buildFactorialAnovaTables(
      {
        test_type: 'two_way',
        factor1_label: 'factor1',
        factor2_label: 'factor2',
        factor1_df: 1,
        factor1_f: 45.984,
        factor1_p: 0.0000195,
        factor2_df: 1,
        factor2_f: 107.3865,
        factor2_p: 2.433e-7,
        interaction_df: 1,
        interaction_f: 1.2064,
        interaction_p: 0.2936,
        residual_df: 12,
        pairwise_comparisons: [
          {
            group1: 'A',
            group2: 'B',
            mean_diff: -3.55,
            se: 0.5235,
            t_stat: -6.7812,
            p_adjusted: 0.0000195,
            ci_lower: -4.6906,
            ci_upper: -2.4094,
            factor: 'factor1',
          },
          {
            group1: 'A',
            group2: 'B',
            mean_diff: -2.975,
            se: 0.7404,
            t_stat: -4.0183,
            p_adjusted: 0.0017,
            ci_lower: -4.5881,
            ci_upper: -1.3619,
            factor_scope: 'factor1|factor2=X',
          },
        ],
      },
      DEFAULT_TABLE_OPTIONS,
      'two_way_anova'
    )

    const marginal = result.tables.find(table => table.testName === 'factorial_marginal_effects')
    const simple = result.tables.find(table => table.testName === 'factorial_simple_effects')

    expect(marginal).toBeDefined()
    expect(simple).toBeDefined()

    expect(marginal?.columns.map(column => column.header)).toEqual([
      'Comparison',
      'Estimate',
      'Std Error',
      '95% CI [lower, upper]',
      'DF',
      't Ratio',
      'Pr > |t|',
    ])

    expect(simple?.columns.map(column => column.header)).toEqual([
      'Comparison',
      'Estimate',
      'Std Error',
      '95% CI [lower, upper]',
      'DF',
      't Ratio',
      'Pr > |t|',
    ])

    const marginalDataRow = marginal?.rows.find(
      row => !row.isHeader && !row.isSeparator && row.cells.length > 0
    )
    const simpleDataRow = simple?.rows.find(
      row => !row.isHeader && !row.isSeparator && row.cells.length > 0
    )

    expect(marginalDataRow?.cells[1]?.value).toBe('-3.5500')
    expect(marginalDataRow?.cells[2]?.value).toBe('0.5235')
    expect(marginalDataRow?.cells[3]?.value).toBe('[-4.6906, -2.4094]')
    expect(marginalDataRow?.cells).toHaveLength(7)
    expect(marginalDataRow?.cells[3]?.attrs?.['data-ci-lower-stat']).toBe('me1_ci_lower')
    expect(marginalDataRow?.cells[3]?.attrs?.['data-ci-lower-value']).toBe('-4.6906')
    expect(marginalDataRow?.cells[3]?.attrs?.['data-ci-upper-stat']).toBe('me1_ci_upper')
    expect(marginalDataRow?.cells[3]?.attrs?.['data-ci-upper-value']).toBe('-2.4094')

    expect(simpleDataRow?.cells[1]?.value).toBe('-2.9750')
    expect(simpleDataRow?.cells[2]?.value).toBe('0.7404')
    expect(simpleDataRow?.cells[3]?.value).toBe('[-4.5881, -1.3619]')
    expect(simpleDataRow?.cells).toHaveLength(7)
    expect(simpleDataRow?.cells[3]?.attrs?.['data-ci-lower-stat']).toBe('se1_ci_lower')
    expect(simpleDataRow?.cells[3]?.attrs?.['data-ci-upper-stat']).toBe('se1_ci_upper')
  })
})
