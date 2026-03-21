import { describe, expect, it } from 'vitest'

import { parseTestResults } from '@/lib/analysis/resultParser'

describe('resultParser lmm_anova', () => {
  it('surfaces fixed effects, model fit, and post-hoc summaries for LMM results', () => {
    const parsed = parseTestResults(
      {
        test_type: 'lmm_anova',
        rows_used: 72,
        subject_count: 24,
        df_method: 'satterthwaite',
        requested_df_method: 'satterthwaite',
        applied_df_method: 'satterthwaite',
        finite_df_available: true,
        finite_df_applied: true,
        finite_df_boundary_warning: false,
        omnibus_method: 'satterthwaite_f',
        diagnostics: {
          converged: true,
          singular_fit: false,
        },
        fit_metrics: {
          log_likelihood: -42.1234,
          aic: 108.2468,
          bic: 129.1357,
          residual_variance: 0.2388,
          converged: true,
        },
        fixed_effects: [
          {
            source: 'treatment',
            statistic_type: 'F',
            f_value: 12.3456,
            df: 2,
            num_df: 2,
            den_df: 48.1254,
            p_value: 0.0021,
          },
          {
            source: 'treatment x day_num',
            statistic_type: 'F',
            f_value: 8.7654,
            df: 2,
            num_df: 2,
            den_df: 48.1254,
            p_value: 0.0123,
          },
        ],
        pairwise_comparisons: [
          {
            factor: 'treatment',
            contrast: 'Control vs Drug',
            estimate: -2.75,
            p_value: 0.0004,
            p_raw: 0.0002,
            p_adjusted: 0.0004,
            significant: true,
          },
        ],
      },
      'parametric',
      'lmm_anova'
    )

    expect(parsed.statistics).toEqual({
      treatment: {
        statistic: 12.3456,
        pValue: 0.0021,
        degreesOfFreedom: 48.1254,
      },
      'treatment x day_num': {
        statistic: 8.7654,
        pValue: 0.0123,
        degreesOfFreedom: 48.1254,
      },
    })
    expect(parsed.modelFit).toEqual({
      logLikelihood: -42.1234,
      aic: 108.2468,
      bic: 129.1357,
      residualVariance: 0.2388,
      converged: true,
    })
    expect(parsed.summary).toEqual({
      Subjects: 24,
      'Rows Used': 72,
      'DF Method Requested': 'satterthwaite',
      'DF Method Applied': 'satterthwaite',
      'Finite DF Applied': 'Yes',
      Converged: 'Yes',
      'Singular Fit': 'No',
      'Primary Effect': 'treatment',
      'Primary Statistic': 'F = 12.3456',
      'Primary NumDF': '2.00',
      'Primary DenDF': '48.13',
      'Primary p-value': '0.0021',
    })
    expect(parsed.postHoc).toEqual([
      {
        comparison: 'Control vs Drug',
        statistic: -2.75,
        pValue: 0.0002,
        pValueAdjusted: 0.0004,
        significant: true,
      },
    ])
  })

  it('normalizes nullable LMM fit metrics to undefined', () => {
    const parsed = parseTestResults(
      {
        test_type: 'lmm_anova',
        rows_used: 72,
        subject_count: 24,
        requested_df_method: 'satterthwaite',
        applied_df_method: 'asymptotic',
        finite_df_applied: false,
        diagnostics: {
          converged: true,
          singular_fit: true,
        },
        fit_metrics: {
          log_likelihood: null,
          aic: null,
          bic: null,
          residual_variance: null,
          converged: true,
        },
        fixed_effects: [],
      },
      'parametric',
      'lmm_anova'
    )

    expect(parsed.modelFit).toEqual({
      logLikelihood: undefined,
      aic: undefined,
      bic: undefined,
      residualVariance: undefined,
      converged: true,
    })
  })

  it('surfaces a compact summary for stratified LMM runs', () => {
    const parsed = parseTestResults(
      {
        test_type: 'lmm_anova_stratified',
        stratified: true,
        stratify_by: ['strain', 'sex'],
        requested_reml: false,
        inference_fit_reml: true,
        kr_reml_refit: true,
        warnings: ['D2 / M: finite-df fallback'],
        strata_results: [
          {
            success: true,
            stratum_label: 'strain=D2 | sex=F',
            rows_used: 120,
            subject_count: 18,
            diagnostics: {
              converged: true,
              singular_fit: false,
            },
          },
          {
            success: true,
            stratum_label: 'strain=D2 | sex=M',
            rows_used: 118,
            subject_count: 17,
            diagnostics: {
              converged: true,
              singular_fit: true,
            },
            finite_df_fallback_reason: 'non-positive-definite finite-df varpar covariance',
          },
        ],
      },
      'parametric',
      'lmm_anova'
    )

    expect(parsed.statistics).toEqual({})
    expect(parsed.summary).toEqual({
      Mode: 'Stratified subgroup mixed models',
      'Stratified By': 'strain, sex',
      Strata: 2,
      'Successful Strata': 2,
      'Singular Strata': 1,
      'Rows Used': 238,
      Subjects: 35,
      'Requested REML': 'No',
      'Inference Fit REML': 'Yes',
      'KR REML Refit': 'Yes',
      Warning: 'D2 / M: finite-df fallback',
    })
  })

  it('renders mixed stratified inference-fit REML state accurately', () => {
    const parsed = parseTestResults(
      {
        test_type: 'lmm_anova_stratified',
        stratified: true,
        stratify_by: ['strain', 'sex'],
        requested_reml: false,
        inference_fit_reml: null,
        kr_reml_refit: true,
        strata_results: [
          {
            success: true,
            stratum_label: 'strain=D2 | sex=F',
            rows_used: 120,
            subject_count: 18,
            diagnostics: {
              converged: true,
              singular_fit: false,
            },
          },
          {
            success: true,
            stratum_label: 'strain=D2 | sex=M',
            rows_used: 118,
            subject_count: 17,
            diagnostics: {
              converged: true,
              singular_fit: false,
            },
          },
        ],
      },
      'parametric',
      'lmm_anova'
    )

    expect(parsed.summary).toBeDefined()
    expect(parsed.summary!['Requested REML']).toBe('No')
    expect(parsed.summary!['Inference Fit REML']).toBe('Varies by stratum')
    expect(parsed.summary!['KR REML Refit']).toBe('Yes')
  })
})
