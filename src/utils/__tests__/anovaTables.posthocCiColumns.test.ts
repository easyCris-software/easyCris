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

  it('renders detailed group-wise normality assumption tests when provided', () => {
    const result = buildANOVATables(
      {
        success: true,
        test_type: 'one_way_anova',
        f_statistic: 124.8476,
        p_value: 2.199e-12,
        df_between: 2,
        df_within: 21,
        ss_between: 360.1258,
        ss_within: 30.2875,
        ss_total: 390.4133,
        ms_between: 180.0629,
        ms_within: 1.4423,
        eta_squared: 0.9224,
        omega_squared: 0.9117,
        effect_size_interpretation: 'large',
        total_n: 24,
        num_groups: 3,
        levene_statistic: 0.0643,
        levene_p_value: 0.9379,
        equal_variances: true,
        all_groups_normal: true,
        assumptions: {
          normality: {
            groups_by_label: {
              Control: {
                label: 'Control',
                n: 8,
                tests: [
                  { test_name: 'shapiro_wilk', statistic: 0.9556, p_value: 0.7677, is_normal: true },
                  { test_name: 'kolmogorov_smirnov', statistic: 0.1812, p_value: 0.9321, is_normal: true },
                  { test_name: 'anderson_darling', statistic: 0.2411, p_value: 0.8423, is_normal: true },
                  { test_name: 'cramer_von_mises', statistic: 0.0314, p_value: 0.9137, is_normal: true },
                  { test_name: 'jarque_bera', statistic: 0.7075, p_value: 0.702, is_normal: true },
                ],
              },
              Treatment1: {
                label: 'Treatment1',
                n: 8,
                tests: [
                  { test_name: 'shapiro_wilk', statistic: 0.9621, p_value: 0.8192, is_normal: true },
                  { test_name: 'kolmogorov_smirnov', statistic: 0.1742, p_value: 0.9511, is_normal: true },
                  { test_name: 'anderson_darling', statistic: 0.2201, p_value: 0.8842, is_normal: true },
                  { test_name: 'cramer_von_mises', statistic: 0.0291, p_value: 0.9295, is_normal: true },
                  { test_name: 'jarque_bera', statistic: 0.6024, p_value: 0.7399, is_normal: true },
                ],
              },
            },
          },
        },
      },
      DEFAULT_TABLE_OPTIONS,
    )

    const normality = result.tables.find(table => table.testName === 'anova_normality_by_group')
    expect(normality).toBeDefined()
    expect(normality?.title).toBe('Normality Tests by Group')
    expect(normality?.columns.map(column => column.header)).toEqual([
      'Group',
      'Test',
      'Statistic',
      'N',
      'Pr > Statistic',
      'Result',
    ])

    const dataRows = normality?.rows.filter(row => !row.isHeader && !row.isSeparator && row.cells.length > 0) ?? []
    expect(dataRows).toHaveLength(10)
    expect(dataRows[0]?.cells.map(cell => cell.value)).toEqual([
      'Control',
      'Shapiro-Wilk',
      '0.9556',
      8,
      '0.7677',
      'Normal',
    ])
    expect(dataRows[0]?.cells[2]?.attrs?.['data-stat']).toBe('normality_control_shapiro_w')
    expect(dataRows[0]?.cells[4]?.attrs?.['data-stat']).toBe('normality_control_shapiro_p')
    expect(dataRows[4]?.cells[1]?.value).toBe('Jarque-Bera')
    expect(dataRows[5]?.cells[0]?.value).toBe('Treatment1')
    expect(dataRows[5]?.cells[2]?.attrs?.['data-stat']).toBe('normality_treatment1_shapiro_w')
  })

  it('adds a normality footnote for unstable group sample sizes', () => {
    const result = buildANOVATables(
      {
        success: true,
        test_type: 'one_way_anova',
        f_statistic: 4.21,
        p_value: 0.048,
        df_between: 1,
        df_within: 6,
        ss_between: 2,
        ss_within: 3,
        ss_total: 5,
        ms_between: 2,
        ms_within: 0.5,
        eta_squared: 0.4,
        omega_squared: 0.25,
        effect_size_interpretation: 'large',
        total_n: 8,
        num_groups: 2,
        levene_statistic: 0.4,
        levene_p_value: 0.6,
        equal_variances: true,
        assumptions: {
          normality: {
            groups_by_label: {
              Control: {
                label: 'Control',
                n: 4,
                warning: 'Normality tests are unstable for group sizes below 5',
                tests: [
                  { test_name: 'shapiro_wilk', statistic: 0.91, p_value: 0.42, is_normal: true },
                ],
              },
              Treatment: {
                label: 'Treatment',
                n: 4,
                tests: [
                  { test_name: 'shapiro_wilk', statistic: 0.9, p_value: 0.38, is_normal: true },
                ],
              },
            },
          },
        },
      },
      DEFAULT_TABLE_OPTIONS,
    )

    const normality = result.tables.find(table => table.testName === 'anova_normality_by_group')
    expect(normality?.footnotes).toContain('Caution: Normality tests are unstable for group sizes below 5 (Control, Treatment).')
  })
})
