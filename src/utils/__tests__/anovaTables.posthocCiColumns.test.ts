import { describe, expect, it } from 'vitest'
import { buildANOVATables } from '@/utils/ecpTableBuilders/anovaTables'
import { DEFAULT_TABLE_OPTIONS } from '@/utils/ecpTableBuilders'

describe('anovaTables post-hoc CI columns', () => {
  it('renders estimate, std error, and combined 95% CI for one-way post-hoc comparisons', () => {
    const result = buildANOVATables(
      {
        success: true,
        test_type: 'one_way_anova',
        f_statistic: 370.6581,
        p_value: 1.246e-22,
        df_between: 3,
        df_within: 28,
        ss_between: 299.4884,
        ss_within: 7.5412,
        ss_total: 307.0297,
        ms_between: 99.8295,
        ms_within: 0.2693,
        eta_squared: 0.9754,
        omega_squared: 0.972,
        effect_size_interpretation: 'large',
        total_n: 32,
        num_groups: 4,
        levene_statistic: 1.5438,
        levene_p_value: 0.2251,
        equal_variances: true,
        group_summaries: [],
        pairwise_comparisons: [
          {
            group1: 'Control',
            group2: 'TreatmentA',
            contrast: 'Control vs TreatmentA',
            estimate: -4.7,
            mean_difference: -4.7,
            se: 0.2595,
            df: 28,
            t_stat: -18.111,
            p_value: 0,
            p_adjusted: 0,
            ci_lower: -5.1846,
            ci_upper: -4.2154,
            significant: true,
          },
        ],
        adjustment_method: 'Tukey HSD',
      },
      DEFAULT_TABLE_OPTIONS,
    )

    const posthoc = result.tables.find(table => table.testName === 'anova_posthoc')
    expect(posthoc).toBeDefined()
    expect(posthoc?.columns.map(column => column.header)).toEqual([
      'Contrast',
      'Estimate',
      'Std Error',
      '95% CI [lower, upper]',
      'DF',
      't Ratio',
      'p',
      'Adj. p-value',
      'Sig',
    ])

    const dataRow = posthoc?.rows.find(row => !row.isHeader && !row.isSeparator && row.cells.length > 0)
    expect(dataRow?.cells).toHaveLength(9)
    expect(dataRow?.cells[1]?.value).toBe('-4.7000')
    expect(dataRow?.cells[2]?.value).toBe('0.2595')
    expect(dataRow?.cells[3]?.value).toBe('[-5.1846, -4.2154]')
    expect(dataRow?.cells[3]?.attrs?.['data-ci-lower-stat']).toBe('posthoc1_ci_lower')
    expect(dataRow?.cells[3]?.attrs?.['data-ci-upper-stat']).toBe('posthoc1_ci_upper')
    expect(dataRow?.cells[4]?.attrs?.['data-stat']).toBe('posthoc1_df')
    expect(dataRow?.cells[5]?.attrs?.['data-stat']).toBe('posthoc1_t')
  })
})
