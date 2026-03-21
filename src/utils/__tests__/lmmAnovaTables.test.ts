import { describe, expect, it } from 'vitest'

import { buildECPTables, DEFAULT_TABLE_OPTIONS } from '@/utils/ecpTableBuilders'

const baseLmmResult = {
  success: true,
  test_type: 'lmm_anova',
  model_type: 'gaussian_lmm',
  formula: 'DV ~ C(treatment, Sum) + C(sex, Sum) + day_num + C(treatment, Sum):day_num',
  re_formula: '1 + day_num',
  reml: false,
  df_method: 'satterthwaite',
  requested_df_method: 'satterthwaite',
  applied_df_method: 'satterthwaite',
  finite_df_available: true,
  finite_df_requested: true,
  finite_df_applied: true,
  finite_df_boundary_warning: false,
  omnibus_method: 'satterthwaite_f',
  contrast_method: 'satterthwaite_t',
  alpha: 0.05,
  adjustment_method: 'Tukey HSD',
  rows_used: 72,
  rows_dropped: 0,
  subject_count: 24,
  grouping_variable: 'ID',
  random_effects: {
    group_var: 'ID',
    random_intercept: true,
    random_slopes: ['day_num'],
  },
  fit_metrics: {
    optimizer: 'lbfgs',
    converged: true,
    log_likelihood: -42.1234,
    aic: 108.2468,
    bic: 129.1357,
    residual_variance: 0.2388,
  },
  fixed_effects: [
    {
      source: 'treatment',
      statistic_type: 'F',
      f_value: 12.3456,
      statistic: 12.3456,
      df: 2,
      num_df: 2,
      den_df: 48.1254,
      p_value: 0.0021,
      significant: true,
      inference: 'satterthwaite_f',
    },
    {
      source: 'treatment x day_num',
      statistic_type: 'F',
      f_value: 8.7654,
      statistic: 8.7654,
      df: 2,
      num_df: 2,
      den_df: 48.1254,
      p_value: 0.0123,
      significant: true,
      inference: 'satterthwaite_f',
    },
  ],
  pairwise_comparisons: [
    {
      group1: 'Control',
      group2: 'Drug',
      contrast: 'Control vs Drug',
      estimate: -2.1,
      se: 0.52,
      t_stat: -4.04,
      df: 48.1254,
      p_raw: 0.0018,
      p_adjusted: 0.0036,
      ci_lower: -3.12,
      ci_upper: -1.08,
      significant: true,
      method: 'Tukey HSD',
      factor: 'treatment',
    },
    {
      group1: 'Control',
      group2: 'Drug',
      contrast: 'Control vs Drug',
      estimate: -1.95,
      se: 0.48,
      t_stat: -4.06,
      df: 48.1254,
      p_raw: 0.0015,
      p_adjusted: 0.003,
      ci_lower: -2.89,
      ci_upper: -1.01,
      significant: true,
      method: 'Tukey HSD',
      factor: 'treatment',
      factor_scope: 'treatment|day=D1',
    },
    {
      group1: 'Control',
      group2: 'Placebo',
      contrast: 'Control vs Placebo',
      estimate: -1.25,
      se: 0.41,
      t_stat: -3.05,
      df: 48.1254,
      p_raw: 0.0042,
      p_adjusted: 0.0084,
      ci_lower: -2.05,
      ci_upper: -0.45,
      significant: true,
      method: 'Tukey HSD',
      factor: 'treatment',
      factor_scope: 'treatment|day=D1',
    },
  ],
  diagnostics: {
    converged: true,
    singular_fit: false,
    near_zero_random_variance: false,
    random_effect_variances: [0.113, 0.018],
    rows_dropped: 0,
    residual_normality: {
      statistic: 0.9812,
      p_value: 0.1876,
      normal: true,
      test: 'Shapiro-Wilk',
    },
    residual_spread: {
      statistic: 0.094,
      p_value: 0.432,
      test: 'Spearman(abs(residual), fitted)',
    },
    warnings: ['Random slope variance near boundary.'],
  },
}

describe('lmmAnovaTables', () => {
  it('routes lmm_anova through the ECP factory and renders the compact report-first table set', () => {
    const collection = buildECPTables('lmm_anova', baseLmmResult, DEFAULT_TABLE_OPTIONS)

    expect(collection.testType).toBe('lmm_anova')
    expect(collection.testFamily).toBe('parametric')
    expect(collection.tables.map((table) => table.testName)).toEqual([
      'lmm_omnibus_report',
      'lmm_simple_effects_report',
      'lmm_model_summary',
      'lmm_model_fit',
      'lmm_diagnostics',
      'lmm_marginal_effects',
    ])
  })

  it('renders a compact omnibus report without placeholder comparison columns', () => {
    const collection = buildECPTables('lmm_anova', baseLmmResult, DEFAULT_TABLE_OPTIONS)
    const reportTable = collection.tables.find((table) => table.testName === 'lmm_omnibus_report')

    expect(reportTable?.title).toBe('Inferential Report: Omnibus Effects')
    expect(reportTable?.columns.map((column) => column.header)).toEqual([
      'Section',
      'Effect',
      'F statistic',
      'NumDF',
      'DenDF',
      'Raw p',
      'Sig',
    ])

    const dataRows = reportTable?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []
    expect(dataRows).toHaveLength(2)

    expect(dataRows[0]?.cells.map((cell) => cell.value)).toEqual([
      'Main Effect',
      'treatment',
      '12.3456',
      '2',
      '48.13',
      '0.0021',
      '**',
    ])
    expect(dataRows[1]?.cells.map((cell) => cell.value)).toEqual([
      'Interaction',
      'treatment x day_num',
      '8.7654',
      '2',
      '48.13',
      '0.0123',
      '*',
    ])
    expect(reportTable?.footnotes).toContain(
      'Single pooled mixed model; subgroup-style interpretation comes from the simple-effects table below.'
    )
  })

  it('renders a clean simple-effects report grouped by within-factor context', () => {
    const collection = buildECPTables('lmm_anova', baseLmmResult, DEFAULT_TABLE_OPTIONS)
    const reportTable = collection.tables.find((table) => table.testName === 'lmm_simple_effects_report')

    expect(reportTable?.title).toBe('Inferential Report: Simple Effects')
    expect(reportTable?.columns.map((column) => column.header)).toEqual([
      'Effect',
      'Within Factor',
      'Within Level',
      'Comparison',
      'Estimate',
      'Std Error',
      'Statistic',
      'DF',
      'Raw p',
      'Adj. p-value',
      'Sig',
    ])

    const dataRows = reportTable?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []
    expect(dataRows).toHaveLength(2)

    expect(dataRows[0]?.cells.map((cell) => cell.value)).toEqual([
      'treatment',
      'day',
      'D1',
      'Control vs Drug',
      '-1.9500',
      '0.4800',
      '-4.0600',
      '48.13',
      '0.0015',
      '0.0030',
      '**',
    ])
    expect(dataRows[1]?.cells.map((cell) => cell.value)).toEqual([
      '',
      '',
      '',
      'Control vs Placebo',
      '-1.2500',
      '0.4100',
      '-3.0500',
      '48.13',
      '0.0042',
      '0.0084',
      '**',
    ])
    expect(reportTable?.footnotes).toContain(
      'Single pooled mixed model; repeated rows within a block share the same within-factor context.'
    )
  })

  it('falls back to a chi-square-oriented inferential report surface when finite-df output is unavailable', () => {
    const collection = buildECPTables(
      'lmm_anova',
      {
        ...baseLmmResult,
        finite_df_available: false,
        finite_df_applied: false,
        applied_df_method: 'asymptotic',
        omnibus_method: 'wald_chi2',
        contrast_method: 'asymptotic_z',
        fixed_effects: [
          {
            source: 'treatment',
            chi_square: 12.3456,
            statistic: 12.3456,
            df: 2,
            p_value: 0.0021,
            significant: true,
            inference: 'wald_chi2',
          },
        ],
        pairwise_comparisons: [
          {
            ...baseLmmResult.pairwise_comparisons[0],
            df: undefined,
          },
        ],
      },
      DEFAULT_TABLE_OPTIONS
    )

    const reportTable = collection.tables.find((table) => table.testName === 'lmm_omnibus_report')
    const dataRows = reportTable?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []

    expect(reportTable?.columns.map((column) => column.header)).toEqual([
      'Section',
      'Effect',
      'Chi-Square',
      'DF',
      'Raw p',
      'Sig',
    ])
    expect(dataRows[0]?.cells.map((cell) => cell.value)).toEqual([
      'Main Effect',
      'treatment',
      '12.3456',
      '2',
      '0.0021',
      '**',
    ])
    expect(dataRows).toHaveLength(1)
    expect(reportTable?.footnotes).toContain(
      'Single pooled mixed model; omnibus rows use asymptotic fallback while subgroup-style detail remains in the simple-effects table.'
    )
  })

  it('renders model fit and diagnostics with stable data-stat attributes', () => {
    const collection = buildECPTables('lmm_anova', baseLmmResult, DEFAULT_TABLE_OPTIONS)
    const fitTable = collection.tables.find((table) => table.testName === 'lmm_model_fit')
    const diagnosticsTable = collection.tables.find((table) => table.testName === 'lmm_diagnostics')

    const fitDataRows = fitTable?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []
    const diagnosticsRows = diagnosticsTable?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []

    const fitKeys = fitDataRows.map((row) => row.cells[1]?.attrs?.['data-stat'])
    const diagnosticsKeys = diagnosticsRows.flatMap((row) => row.cells.map((cell) => cell.attrs?.['data-stat']))

    expect(fitKeys).toContain('fit_log_likelihood')
    expect(fitKeys).toContain('fit_aic')
    expect(fitKeys).toContain('fit_bic')
    expect(fitKeys).toContain('fit_residual_variance')
    expect(diagnosticsKeys).toContain('diag_converged')
    expect(diagnosticsKeys).toContain('diag_singular_fit')
    expect(diagnosticsKeys).toContain('diag_near_zero_random_variance')
    expect(diagnosticsKeys).toContain('diag_residual_normality_p')
  })

  it('renders a standalone marginal-effects table after diagnostics', () => {
    const collection = buildECPTables('lmm_anova', baseLmmResult, DEFAULT_TABLE_OPTIONS)
    const tableNames = collection.tables.map((table) => table.testName)
    const diagnosticsIndex = tableNames.indexOf('lmm_diagnostics')
    const marginalIndex = tableNames.indexOf('lmm_marginal_effects')
    const marginalTable = collection.tables.find((table) => table.testName === 'lmm_marginal_effects')
    const dataRows = marginalTable?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []

    expect(marginalIndex).toBeGreaterThan(diagnosticsIndex)
    expect(marginalTable?.title).toBe('Marginal Pairwise Comparisons')
    expect(marginalTable?.columns.map((column) => column.header)).toEqual([
      'Factor',
      'Comparison',
      'Estimate',
      'Std Error',
      '95% CI [lower, upper]',
      'DF',
      't Ratio',
      'Pr > |t|',
      'Adj. p-value',
      'Sig',
    ])
    expect(dataRows).toHaveLength(1)
    expect(dataRows[0]?.cells[0]?.value).toBe('treatment')
    expect(dataRows[0]?.cells[1]?.value).toBe('Control vs Drug')
    expect(dataRows[0]?.cells[7]?.attrs?.['data-stat']).toBe('me1_p_raw')
    expect(dataRows[0]?.cells[8]?.attrs?.['data-stat']).toBe('me1_p')
  })

  it('exposes inferential data-stat hooks for omnibus and simple-effect rows without duplicated source hooks', () => {
    const collection = buildECPTables('lmm_anova', baseLmmResult, DEFAULT_TABLE_OPTIONS)
    const omnibusTable = collection.tables.find((table) => table.testName === 'lmm_omnibus_report')
    const simpleTable = collection.tables.find((table) => table.testName === 'lmm_simple_effects_report')
    const omnibusRows = omnibusTable?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []
    const simpleRows = simpleTable?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []

    expect(omnibusRows[0]?.cells[0]?.attrs?.['data-stat']).toBe('fe1_section')
    expect(omnibusRows[0]?.cells[1]?.attrs?.['data-stat']).toBe('fe1_source')
    expect(omnibusRows[0]?.cells[2]?.attrs?.['data-stat']).toBe('fe1_f_value')
    expect(omnibusRows[0]?.cells[3]?.attrs?.['data-stat']).toBe('fe1_num_df')
    expect(omnibusRows[0]?.cells[4]?.attrs?.['data-stat']).toBe('fe1_den_df')
    expect(omnibusRows[0]?.cells[5]?.attrs?.['data-stat']).toBe('fe1_p')

    expect(simpleRows[0]?.cells[3]?.attrs?.['data-stat']).toBe('se1_label')
    expect(simpleRows[0]?.cells[4]?.attrs?.['data-stat']).toBe('se1_estimate')
    expect(simpleRows[0]?.cells[4]?.attrs?.['data-ci-lower-stat']).toBe('se1_ci_lower')
    expect(simpleRows[0]?.cells[4]?.attrs?.['data-ci-upper-stat']).toBe('se1_ci_upper')
    expect(simpleRows[0]?.cells[8]?.attrs?.['data-stat']).toBe('se1_p_raw')
    expect(simpleRows[0]?.cells[9]?.attrs?.['data-stat']).toBe('se1_p')
    expect(simpleRows[1]?.cells[3]?.attrs?.['data-stat']).toBe('se2_label')
    expect(simpleRows[1]?.cells[8]?.attrs?.['data-stat']).toBe('se2_p_raw')
    expect(simpleRows[1]?.cells[9]?.attrs?.['data-stat']).toBe('se2_p')
  })

  it('reports model-summary metadata and post-hoc adjustment labels with FDR q values', () => {
    const collection = buildECPTables(
      'lmm_anova',
      {
        ...baseLmmResult,
        adjustment_method: 'FDR-BH',
        posthoc_q: 0.1,
      },
      DEFAULT_TABLE_OPTIONS
    )

    expect(collection.metadata?.posthocAdjustment).toBe('FDR-BH (q = 0.10)')
  })

  it('stores LMM metadata counts as subjects and observations instead of generic sample size', () => {
    const collection = buildECPTables('lmm_anova', baseLmmResult, DEFAULT_TABLE_OPTIONS)

    expect(collection.metadata?.sampleSize).toBeUndefined()
    expect(collection.metadata?.counts).toEqual([
      { label: 'Subjects', value: 24 },
      { label: 'Observations', value: 72 },
    ])
  })

  it('stores finite-df status details in the model summary table', () => {
    const collection = buildECPTables('lmm_anova', baseLmmResult, DEFAULT_TABLE_OPTIONS)
    const summaryTable = collection.tables.find((table) => table.testName === 'lmm_model_summary')
    const dataRows = summaryTable?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []
    const valuesByLabel = new Map(dataRows.map((row) => [row.cells[0]?.value, row.cells[1]?.value]))

    expect(valuesByLabel.get('DF Method Requested')).toBe('satterthwaite')
    expect(valuesByLabel.get('DF Method Applied')).toBe('satterthwaite')
    expect(valuesByLabel.get('Finite DF Applied')).toBe('Yes')
  })

  it('omits metadata counts when subject and observation counts are missing', () => {
    const collection = buildECPTables(
      'lmm_anova',
      {
        ...baseLmmResult,
        subject_count: undefined,
        rows_used: undefined,
      },
      DEFAULT_TABLE_OPTIONS
    )

    expect(collection.metadata?.counts).toBeUndefined()
  })

  it('renders stacked subgroup reports for stratified LMM results', () => {
    const collection = buildECPTables(
      'lmm_anova',
      {
        success: true,
        test_type: 'lmm_anova_stratified',
        stratified: true,
        stratify_by: ['strain', 'sex'],
        adjustment_method: 'Tukey HSD',
        posthoc_q: 0.05,
        warnings: ['strain=D2 | sex=M: non-positive-definite finite-df varpar covariance'],
        strata_results: [
          {
            success: true,
            test_type: 'lmm_anova',
            stratum: { strain: 'D2', sex: 'F' },
            stratum_label: 'strain=D2 | sex=F',
            finite_df_applied: true,
            fixed_effects: [
              {
                source: 'treatment',
                f_value: 9.8765,
                num_df: 1,
                den_df: 22.5,
                p_value: 0.0042,
              },
            ],
            pairwise_comparisons: [
              {
                factor_scope: 'treatment|day=D1',
                contrast: 'THC vs VEH',
                estimate: -1.25,
                se: 0.31,
                t_stat: -4.03,
                df: 22.5,
                p_raw: 0.0012,
                p_adjusted: 0.0024,
              },
            ],
            diagnostics: {
              converged: true,
              singular_fit: false,
            },
          },
          {
            success: true,
            test_type: 'lmm_anova',
            stratum: { strain: 'D2', sex: 'M' },
            stratum_label: 'strain=D2 | sex=M',
            finite_df_applied: false,
            applied_df_method: 'asymptotic',
            finite_df_fallback_reason: 'non-positive-definite finite-df varpar covariance',
            fixed_effects: [
              {
                source: 'treatment x day',
                statistic_type: 'Chi-Square',
                chi_square: 7.6543,
                df: 4,
                p_value: 0.021,
              },
            ],
            pairwise_comparisons: [],
            diagnostics: {
              converged: true,
              singular_fit: true,
            },
          },
          {
            success: false,
            stratum: { strain: 'B6', sex: 'F' },
            stratum_label: 'strain=B6 | sex=F',
            error: 'Stratum has only 2 subjects; skipping fit.',
          },
        ],
      },
      DEFAULT_TABLE_OPTIONS
    )

    expect(collection.tables.map((table) => table.testName)).toEqual([
      'lmm_omnibus_report',
      'lmm_simple_effects_report',
      'lmm_diagnostics',
    ])

    const omnibus = collection.tables[0]
    expect(omnibus?.columns.map((column) => column.header)).toEqual([
      'Section',
      'strain',
      'sex',
      'Effect',
      'Inference',
      'Statistic',
      'DF',
      'DenDF',
      'Raw p',
      'Sig',
    ])
    const omnibusRows = omnibus?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []
    expect(omnibusRows[0]?.cells.map((cell) => cell.value)).toEqual([
      'Main Effect',
      'D2',
      'F',
      'treatment',
      'F',
      '9.8765',
      '1',
      '22.50',
      '0.0042',
      '**',
    ])
    expect(omnibusRows[1]?.cells.map((cell) => cell.value)).toEqual([
      'Interaction',
      'D2',
      'M',
      'treatment x day',
      'Chi-Square',
      '7.6543',
      '4',
      '.',
      '0.0210',
      '*',
    ])
    expect(omnibusRows[0]?.cells[0]?.attrs?.['data-stat']).toBe('st1_fe1_section')
    expect(omnibusRows[0]?.cells[3]?.attrs?.['data-stat']).toBe('st1_fe1_source')
    expect(omnibusRows[0]?.cells[4]?.attrs?.['data-stat']).toBe('st1_fe1_inference')
    expect(omnibusRows[0]?.cells[5]?.attrs?.['data-stat']).toBe('st1_fe1_f_value')
    expect(omnibusRows[0]?.cells[6]?.attrs?.['data-stat']).toBe('st1_fe1_num_df')
    expect(omnibusRows[0]?.cells[7]?.attrs?.['data-stat']).toBe('st1_fe1_den_df')
    expect(omnibusRows[0]?.cells[8]?.attrs?.['data-stat']).toBe('st1_fe1_p')
    expect(omnibusRows[1]?.cells[5]?.attrs?.['data-stat']).toBe('st2_fe1_chi_square')
    expect(omnibusRows[1]?.cells[6]?.attrs?.['data-stat']).toBe('st2_fe1_df')
    expect(omnibusRows[1]?.cells[8]?.attrs?.['data-stat']).toBe('st2_fe1_p')

    const simpleEffects = collection.tables[1]
    expect(simpleEffects?.columns.map((column) => column.header)).toEqual([
      'strain',
      'sex',
      'Effect',
      'Within Factor',
      'Within Level',
      'Comparison',
      'Estimate',
      'Std Error',
      'Statistic',
      'DF',
      'Raw p',
      'Adj. p-value',
      'Sig',
    ])
    const simpleRows = simpleEffects?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []
    expect(simpleRows).toHaveLength(1)
    expect(simpleRows[0]?.cells.map((cell) => cell.value)).toEqual([
      'D2',
      'F',
      'treatment',
      'day',
      'D1',
      'THC vs VEH',
      '-1.2500',
      '0.3100',
      '-4.0300',
      '22.50',
      '0.0012',
      '0.0024',
      '**',
    ])
    expect(simpleRows[0]?.cells[5]?.attrs?.['data-stat']).toBe('st1_se1_label')
    expect(simpleRows[0]?.cells[6]?.attrs?.['data-stat']).toBe('st1_se1_estimate')
    expect(simpleRows[0]?.cells[6]?.attrs?.['data-ci-lower-stat']).toBe('st1_se1_ci_lower')
    expect(simpleRows[0]?.cells[6]?.attrs?.['data-ci-upper-stat']).toBe('st1_se1_ci_upper')
    expect(simpleRows[0]?.cells[7]?.attrs?.['data-stat']).toBe('st1_se1_se')
    expect(simpleRows[0]?.cells[8]?.attrs?.['data-stat']).toBe('st1_se1_t_ratio')
    expect(simpleRows[0]?.cells[9]?.attrs?.['data-stat']).toBe('st1_se1_df')
    expect(simpleRows[0]?.cells[10]?.attrs?.['data-stat']).toBe('st1_se1_p_raw')
    expect(simpleRows[0]?.cells[11]?.attrs?.['data-stat']).toBe('st1_se1_p')

    const diagnostics = collection.tables[2]
    expect(collection.metadata?.posthocAdjustment).toBe('Tukey HSD')
    const diagnosticsRows = diagnostics?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []
    expect(diagnosticsRows[1]?.cells.map((cell) => cell.value)).toEqual([
      'D2',
      'M',
      'Yes',
      'Yes',
      'No',
      'non-positive-definite finite-df varpar covariance',
      '.',
    ])
    expect(diagnosticsRows[2]?.cells.map((cell) => cell.value)).toEqual([
      'B6',
      'F',
      '.',
      '.',
      '.',
      '.',
      'Stratum has only 2 subjects; skipping fit.',
    ])
  })

  it('classifies stratified omnibus interaction rows from the fitted term when source is not normalized', () => {
    const collection = buildECPTables(
      'lmm_anova',
      {
        success: true,
        test_type: 'lmm_anova_stratified',
        stratified: true,
        stratify_by: ['strain'],
        strata_results: [
          {
            success: true,
            stratum: { strain: 'D2' },
            fixed_effects: [
              {
                source: 'Condition:Day',
                term: 'Condition:Day',
                f_value: 4.321,
                num_df: 4,
                den_df: 32,
                p_value: 0.018,
              },
            ],
            pairwise_comparisons: [],
            diagnostics: {},
          },
        ],
      },
      DEFAULT_TABLE_OPTIONS
    )

    const omnibus = collection.tables[0]
    const omnibusRows = omnibus?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []
    expect(omnibusRows[0]?.cells[0]?.value).toBe('Interaction')
    expect(omnibusRows[0]?.cells[2]?.value).toBe('Condition:Day')
  })

  it('explains when requested stratified simple effects are unavailable after subgrouping or numeric-time fitting', () => {
    const collection = buildECPTables(
      'lmm_anova',
      {
        success: true,
        test_type: 'lmm_anova_stratified',
        stratified: true,
        stratify_by: ['strain', 'sex', 'trait'],
        parameters: {
          simple_effects: [{ factor: 'Condition', within: 'Day' }],
        },
        strata_results: [
          {
            success: true,
            stratum: { strain: 'B6', sex: 'F', trait: 'Temp_60' },
            fixed_effects: [],
            pairwise_comparisons: [],
            diagnostics: {
              converged: true,
              singular_fit: false,
            },
          },
        ],
      },
      DEFAULT_TABLE_OPTIONS
    )

    const simpleEffects = collection.tables.find((table) => table.testName === 'lmm_simple_effects_report')
    const simpleRows = simpleEffects?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []

    expect(simpleEffects).toBeDefined()
    expect(simpleRows).toHaveLength(1)
    expect(simpleRows[0]?.cells[3]?.value).toMatch(/No categorical simple effects were available inside the subgroup fits/i)
    expect(simpleEffects?.footnotes).toContain(
      'No categorical simple effects were available inside the subgroup fits. This usually means fewer than two categorical predictors remained after subgrouping or treating time as numeric.'
    )
  })

  it('shows an explicit note when no stratified simple effects were requested', () => {
    const collection = buildECPTables(
      'lmm_anova',
      {
        success: true,
        test_type: 'lmm_anova_stratified',
        stratified: true,
        stratify_by: ['strain'],
        parameters: {},
        strata_results: [
          {
            success: true,
            stratum: { strain: 'B6' },
            fixed_effects: [],
            pairwise_comparisons: [],
            diagnostics: {
              converged: true,
              singular_fit: false,
            },
          },
        ],
      },
      DEFAULT_TABLE_OPTIONS
    )

    const simpleEffects = collection.tables.find((table) => table.testName === 'lmm_simple_effects_report')
    const simpleRows = simpleEffects?.rows.filter((row) => !row.isHeader && !row.isSeparator) ?? []

    expect(simpleEffects).toBeDefined()
    expect(simpleRows).toHaveLength(1)
    expect(simpleRows[0]?.cells[1]?.value).toMatch(/No simple effects were requested/i)
    expect(simpleEffects?.footnotes).toContain(
      'No simple effects were requested for this run. Select one or more effect-within-factor pairs in the LMM dialog to compute subgroup simple effects.'
    )
  })
})
