/**
 * Result parsing helpers
 *
 * Extracts summary/statistics/coefficients from Python backend responses so that
 * AppShell and the orchestration controller can share the exact same logic.
 */

import type { TestResult } from '@/store/results-store'

type ResultsData = Record<string, unknown>

/**
 * Parse test results returned from Python backend based on test family
 */
export function parseTestResults(
  resultsData: ResultsData,
  family: string,
  testId: string
): Partial<TestResult> {
  const parsed: Partial<TestResult> = {
    statistics: {},
    summary: {},
  }

  // Helper to safely get nested values
  const get = (path: string): unknown => {
    const parts = path.split('.')
    let value: unknown = resultsData
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = (value as Record<string, unknown>)[part]
      } else {
        return undefined
      }
    }
    return value
  }

  const num = (path: string): number | undefined => {
    const v = get(path)
    if (typeof v === 'number') {
      return isNaN(v) ? undefined : v
    }
    if (typeof v === 'string') {
      const parsed = parseFloat(v)
      return isNaN(parsed) ? undefined : parsed
    }
    return undefined
  }

  const str = (path: string): string | undefined => {
    const v = get(path)
    return typeof v === 'string' ? v : undefined
  }

  const parseNullableNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined
    }
    if (typeof value === 'string') {
      const parsed = parseFloat(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    return undefined
  }

  const formatPValueText = (value?: number): string => {
    if (value === undefined) return '-'
    return value < 0.001 ? '< 0.001' : value.toFixed(4)
  }

  const replaceFactorTokens = (label: string): string =>
    label.replace(/factor\s*(\d+)/gi, 'Group $1')

  const normalizeFactorLabel = (label: string | undefined, fallback: string): string => {
    const cleaned = (label ?? fallback).trim()
    const match = cleaned.match(/^factor\s*(\d+)$/i)
    if (match) {
      return `Group ${match[1]}`
    }
    return replaceFactorTokens(cleaned)
  }

  const replaceInteractionSeparator = (label: string): string =>
    replaceFactorTokens(label).replace(/\s+[x×*]\s+/gi, ' by ')

  const formatInteractionLabel = (left: string, right: string): string =>
    replaceInteractionSeparator(`${left} by ${right}`)

  const normalizeDoseResponseModelType = (value?: string): string => {
    if (!value) return '4PL'
    const upper = value.toUpperCase()
    if (upper.startsWith('3PL')) return '3PL'
    if (upper.startsWith('4PL')) return '4PL'
    if (upper.startsWith('5PL')) return '5PL'
    if (upper.includes('DOSE_RESPONSE_3PL')) return '3PL'
    if (upper.includes('DOSE_RESPONSE_4PL')) return '4PL'
    if (upper.includes('DOSE_RESPONSE_5PL')) return '5PL'
    return value.replace(/_DRC.*$/i, '').replace(/_SCALED$/i, '')
  }

  // ===== PHARMACOLOGY (Dose-Response & Synergy) =====
  if (family === 'pharmacology') {
    if (testId.startsWith('dose_response')) {
      const modelType = normalizeDoseResponseModelType(str('model_type'))
      const params = get('parameters') as Record<string, { value?: number; stderr?: number }> | undefined

      parsed.modelFit = {
        r2: num('goodness_of_fit.r_squared'),
        adjustedR2: num('goodness_of_fit.adj_r_squared'),
        rmse: num('goodness_of_fit.rmse'),
        aic: num('goodness_of_fit.aic'),
        bic: num('goodness_of_fit.bic'),
      }

      parsed.summary = {
        Model: modelType,
        'R²': num('goodness_of_fit.r_squared')?.toFixed(4) ?? '-',
      }

      if (params?.ic50?.value !== undefined) {
        parsed.summary['IC50'] = params.ic50.value.toExponential(3)
        if (params.ic50.stderr) parsed.summary['IC50 SE'] = params.ic50.stderr.toExponential(3)
      }
      if (params?.ec50?.value !== undefined) {
        parsed.summary['EC50'] = params.ec50.value.toExponential(3)
      }
      if (params?.hill?.value !== undefined) parsed.summary['Hill Slope'] = params.hill.value.toFixed(3)
      if (params?.top?.value !== undefined) parsed.summary['Top'] = params.top.value.toFixed(3)
      if (params?.bottom?.value !== undefined) parsed.summary['Bottom'] = params.bottom.value.toFixed(3)

      // Do not emit `coefficients` for dose-response fits.
      // These are nonlinear curve parameters and the generic coefficients table
      // would misleadingly show regression-style p-values.
    } else if (testId.startsWith('synergy')) {
      const synergyScore =
        num('synergy_score') ??
        num('bliss_score') ??
        num('hsa_score') ??
        num('loewe_score') ??
        num('zip_score')
      const interpretation = str('interpretation') ?? str('synergy_interpretation')

      parsed.summary = {
        'Synergy Score': synergyScore?.toFixed(4) ?? '-',
        Interpretation: interpretation ?? '-',
      }

      if (num('ci_score') !== undefined) {
        parsed.summary['CI Score'] = num('ci_score')!.toFixed(4)
      }
    }
  }
  // ===== SURVIVAL =====
  else if (family === 'survival') {
    const medianSurvival = num('median_survival') ?? num('overall.median_survival')
    const logRankP = num('homogeneity_test.p_value') ?? num('comparison.p_value')
    const logRankStat = num('homogeneity_test.chi_square') ?? num('homogeneity_test.test_statistic')

    parsed.statistics = {
      statistic: logRankStat,
      pValue: logRankP,
    }

    parsed.summary = {
      'Median Survival': medianSurvival?.toFixed(2) ?? 'Not reached',
    }

    if (logRankP !== undefined) {
      parsed.summary['Log-Rank p-value'] = logRankP < 0.001 ? '< 0.001' : logRankP.toFixed(4)
      parsed.summary['Groups Differ'] = logRankP < 0.05 ? 'Yes' : 'No'
    }

    if (testId === 'cox_regression') {
      const hazardRatio = num('hazard_ratio') ?? num('exp_coef')
      if (hazardRatio !== undefined) parsed.summary['Hazard Ratio'] = hazardRatio.toFixed(3)
      parsed.modelFit = {
        logLikelihood: num('log_likelihood'),
        aic: num('aic'),
      }
    }
  }
  // ===== FACTORIAL ANOVA =====
  else if (family === 'parametric' && testId === 'two_way_anova') {
    const factor1Label = normalizeFactorLabel(resultsData.factor1_label as string | undefined, 'Group 1')
    const factor2Label = normalizeFactorLabel(resultsData.factor2_label as string | undefined, 'Group 2')
    const interactionLabel = formatInteractionLabel(factor1Label, factor2Label)
    const residualDF = num('residual_df')

    parsed.statistics = {
      [factor1Label]: {
        statistic: num('factor1_f'),
        pValue: num('factor1_p'),
        degreesOfFreedom: num('factor1_df'),
        residualDF,
      },
      [factor2Label]: {
        statistic: num('factor2_f'),
        pValue: num('factor2_p'),
        degreesOfFreedom: num('factor2_df'),
        residualDF,
      },
      [interactionLabel]: {
        statistic: num('interaction_f'),
        pValue: num('interaction_p'),
        degreesOfFreedom: num('interaction_df'),
        residualDF,
      },
    }

    parsed.summary = {
      [`${factor1Label} F`]: num('factor1_f')?.toFixed(3) ?? '.',
      [`${factor1Label} p-value`]: formatPValueText(num('factor1_p')),
      [`${factor2Label} F`]: num('factor2_f')?.toFixed(3) ?? '.',
      [`${factor2Label} p-value`]: formatPValueText(num('factor2_p')),
      [`${interactionLabel} F`]: num('interaction_f')?.toFixed(3) ?? '.',
      [`${interactionLabel} p-value`]: formatPValueText(num('interaction_p')),
    }
  }
  else if (family === 'parametric' && testId === 'multifactorial_anova') {
    let mainEffects = (resultsData.main_effects as Array<Record<string, unknown>>) ?? []
    let interactions = (resultsData.interactions as Array<Record<string, unknown>>) ?? []
    const stats: Record<string, { statistic?: number; pValue?: number; degreesOfFreedom?: number }> = {}
    const summary: Record<string, string> = {}

    if (!mainEffects.length) {
      const factorNames = (resultsData.factor_names as string[]) ?? []
      mainEffects = factorNames
        .map(name => ({
          source: normalizeFactorLabel(name, name),
          F: num(`${name}_F`),
          p_value: num(`${name}_p`),
          df: num(`${name}_df1`),
        }))
        .filter(effect => effect.F !== undefined || effect.p_value !== undefined)
    }

    if (!interactions.length) {
      const flattened = Object.keys(resultsData).filter(key => key.endsWith('_F') && key.includes('_x_'))
      interactions = flattened.map(key => {
        const base = key.slice(0, -2)
        return {
          source: base.replace(/_x_/g, ' by '),
          F: num(base + '_F'),
          p_value: num(base + '_p'),
          df: num(base + '_df1'),
        }
      })
    }

    for (const effect of [...mainEffects, ...interactions].slice(0, 6)) {
      const rawLabel = (effect.source as string) ?? 'Effect'
      const label = replaceInteractionSeparator(normalizeFactorLabel(rawLabel, rawLabel))
      const stat = typeof effect.F === 'string' ? parseFloat(effect.F) : (effect.F as number | undefined)
      const pValue =
        typeof effect.p_value === 'string' ? parseFloat(effect.p_value) : (effect.p_value as number | undefined)
      const df = typeof effect.df === 'string' ? parseFloat(effect.df) : (effect.df as number | undefined)

      stats[label] = {
        statistic: isNaN(stat ?? NaN) ? undefined : stat,
        pValue: isNaN(pValue ?? NaN) ? undefined : pValue,
        degreesOfFreedom: isNaN(df ?? NaN) ? undefined : df,
      }

      summary[`${label} F`] = stat !== undefined && !isNaN(stat) ? stat.toFixed(3) : '.'
      summary[`${label} p-value`] = formatPValueText(pValue)
    }

    parsed.statistics = stats
    parsed.summary = summary
  }
  else if (family === 'parametric' && testId === 'lmm_anova') {
    if (get('stratified') === true && Array.isArray(get('strata_results'))) {
      const strataResults = get('strata_results') as Array<Record<string, unknown>>
      const successfulStrata = strataResults.filter((entry) => entry.success !== false)
      const singularStrata = successfulStrata.filter((entry) => {
        const diagnostics = (entry.diagnostics as Record<string, unknown> | undefined) ?? {}
        return diagnostics.singular_fit === true
      })
      const rowsUsed = successfulStrata.reduce((sum, entry) => {
        const value =
          typeof entry.rows_used === 'number'
            ? entry.rows_used
            : typeof entry.rows_used === 'string'
              ? parseFloat(entry.rows_used)
              : 0
        return sum + (Number.isFinite(value) ? value : 0)
      }, 0)
      const subjectCount = successfulStrata.reduce((sum, entry) => {
        const value =
          typeof entry.subject_count === 'number'
            ? entry.subject_count
            : typeof entry.subject_count === 'string'
              ? parseFloat(entry.subject_count)
              : 0
        return sum + (Number.isFinite(value) ? value : 0)
      }, 0)
      const topWarnings = Array.isArray(get('warnings'))
        ? ((get('warnings') as unknown[]).map((value) => String(value)).filter(Boolean))
        : []

      parsed.statistics = {}
      parsed.summary = {
        Mode: 'Stratified subgroup mixed models',
        'Stratified By': Array.isArray(get('stratify_by'))
          ? (get('stratify_by') as unknown[]).map((value) => String(value)).join(', ')
          : '-',
        Strata: strataResults.length,
        'Successful Strata': successfulStrata.length,
        'Singular Strata': singularStrata.length,
        'Rows Used': rowsUsed || '-',
        Subjects: subjectCount || '-',
      }

      const requestedReml = get('requested_reml')
      if (typeof requestedReml === 'boolean') {
        parsed.summary['Requested REML'] = requestedReml ? 'Yes' : 'No'
      }

      const inferenceFitReml = get('inference_fit_reml')
      if (typeof inferenceFitReml === 'boolean') {
        parsed.summary['Inference Fit REML'] = inferenceFitReml ? 'Yes' : 'No'
      } else if (inferenceFitReml === null) {
        parsed.summary['Inference Fit REML'] = 'Varies by stratum'
      }

      const krRemlRefit = get('kr_reml_refit')
      if (typeof krRemlRefit === 'boolean') {
        parsed.summary['KR REML Refit'] = krRemlRefit ? 'Yes' : 'No'
      }

      if (topWarnings[0]) {
        parsed.summary.Warning = topWarnings[0]
      }

      return parsed
    }

    const fixedEffects = (resultsData.fixed_effects as Array<Record<string, unknown>>) ?? []
    const fitMetrics = (resultsData.fit_metrics as Record<string, unknown> | undefined) ?? {}
    const diagnostics = (resultsData.diagnostics as Record<string, unknown> | undefined) ?? {}

    const stats: Record<string, { statistic?: number; pValue?: number; degreesOfFreedom?: number }> = {}
    for (const effect of fixedEffects) {
      const source = typeof effect.source === 'string' ? effect.source : 'Effect'
      const statistic =
        typeof effect.f_value === 'string'
          ? parseFloat(effect.f_value)
          : (effect.f_value as number | undefined) ??
            (typeof effect.chi_square === 'string'
              ? parseFloat(effect.chi_square)
              : (effect.chi_square as number | undefined))
      const pValue =
        typeof effect.p_value === 'string'
          ? parseFloat(effect.p_value)
          : (effect.p_value as number | undefined)
      const df =
        typeof effect.den_df === 'string'
          ? parseFloat(effect.den_df)
          : (effect.den_df as number | undefined) ??
            (typeof effect.df === 'string' ? parseFloat(effect.df) : (effect.df as number | undefined))

      stats[source] = {
        statistic: isNaN(statistic ?? NaN) ? undefined : statistic,
        pValue: isNaN(pValue ?? NaN) ? undefined : pValue,
        degreesOfFreedom: isNaN(df ?? NaN) ? undefined : df,
      }
    }

    const firstEffect = fixedEffects[0] as Record<string, unknown> | undefined
    const firstEffectLabel = typeof firstEffect?.source === 'string' ? firstEffect.source : undefined
    const firstEffectP =
      typeof firstEffect?.p_value === 'string'
        ? parseFloat(firstEffect.p_value)
        : (firstEffect?.p_value as number | undefined)
    const firstEffectStatistic =
      typeof firstEffect?.f_value === 'string'
        ? parseFloat(firstEffect.f_value)
        : (firstEffect?.f_value as number | undefined) ??
          (typeof firstEffect?.chi_square === 'string'
            ? parseFloat(firstEffect.chi_square)
            : (firstEffect?.chi_square as number | undefined))
    const firstEffectStatisticType =
      typeof firstEffect?.statistic_type === 'string'
        ? firstEffect.statistic_type
        : typeof resultsData.omnibus_method === 'string' && resultsData.omnibus_method.includes('f')
          ? 'F'
          : 'Chi-Square'
    const firstEffectNumDf =
      typeof firstEffect?.num_df === 'string'
        ? parseFloat(firstEffect.num_df)
        : (firstEffect?.num_df as number | undefined)
    const firstEffectDenDf =
      typeof firstEffect?.den_df === 'string'
        ? parseFloat(firstEffect.den_df)
        : (firstEffect?.den_df as number | undefined)

    parsed.statistics = stats
    parsed.modelFit = {
      logLikelihood: parseNullableNumber(fitMetrics.log_likelihood),
      aic: parseNullableNumber(fitMetrics.aic),
      bic: parseNullableNumber(fitMetrics.bic),
      residualVariance: parseNullableNumber(fitMetrics.residual_variance),
      converged: fitMetrics.converged,
    }
    parsed.summary = {
      Subjects: num('subject_count') ?? '-',
      'Rows Used': num('rows_used') ?? '-',
      'DF Method Requested': str('requested_df_method') ?? '-',
      'DF Method Applied': str('applied_df_method') ?? '-',
      'Finite DF Applied':
        get('finite_df_applied') === true ? 'Yes' : get('finite_df_applied') === false ? 'No' : '-',
      Converged:
        diagnostics.converged === true ? 'Yes' : diagnostics.converged === false ? 'No' : '-',
      'Singular Fit':
        diagnostics.singular_fit === true ? 'Yes' : diagnostics.singular_fit === false ? 'No' : '-',
      'Primary Effect': firstEffectLabel ?? '-',
      'Primary Statistic':
        firstEffectStatistic !== undefined
          ? `${firstEffectStatisticType} = ${firstEffectStatistic.toFixed(4)}`
          : '-',
      'Primary NumDF':
        firstEffectNumDf !== undefined ? firstEffectNumDf.toFixed(2) : '-',
      'Primary DenDF':
        firstEffectDenDf !== undefined ? firstEffectDenDf.toFixed(2) : '-',
      'Primary p-value': formatPValueText(firstEffectP),
    }

    const fallbackReason = str('finite_df_fallback_reason')
    if (fallbackReason) {
      parsed.summary['Finite DF Fallback'] = fallbackReason
    }

    const pairwiseComparisons = get('pairwise_comparisons') as Array<{
      contrast?: string
      estimate?: number | string
      p_raw?: number | string
      p_value?: number | string
      p_adjusted?: number | string
      significant?: boolean
    }> | undefined

    if (Array.isArray(pairwiseComparisons) && pairwiseComparisons.length > 0) {
      parsed.postHoc = pairwiseComparisons.map((comp) => ({
        comparison: comp.contrast ?? '-',
        statistic:
          typeof comp.estimate === 'string' ? parseFloat(comp.estimate) : (comp.estimate ?? 0),
        pValue:
          typeof comp.p_raw === 'string'
            ? parseFloat(comp.p_raw)
            : comp.p_raw !== undefined
              ? comp.p_raw
              : typeof comp.p_value === 'string'
                ? parseFloat(comp.p_value)
                : (comp.p_value ?? 0),
        pValueAdjusted:
          typeof comp.p_adjusted === 'string' ? parseFloat(comp.p_adjusted) : comp.p_adjusted,
        significant: comp.significant ?? false,
      }))
    }
  }
  // ===== MEDIATION / MODERATION =====
  else if (family === 'mediation' || family === 'moderation') {
    if (testId === 'mediation_model4') {
      const indirectEffect =
        num('effects.indirect.0.effect') ??
        num('indirect_effect') ??
        num('indirect.effect')
      const directEffect =
        num('effects.direct.effect') ??
        num('direct_effect') ??
        num('direct.effect')
      const totalEffect =
        num('effects.total.effect') ??
        num('total_effect') ??
        num('total.effect')
      const indirectP =
        num('effects.indirect.0.boot_p') ??
        num('effects.indirect.0.p') ??
        num('indirect_p') ??
        num('indirect.p_value')
      const proportionMediated =
        num('proportions.indirect_over_total') ??
        num('proportions.percent_mediated') ??
        num('proportion_mediated')
      const percentMediated = num('proportions.percent_mediated')

      parsed.summary = {
        'Indirect Effect': indirectEffect?.toFixed(4) ?? '-',
        'Direct Effect': directEffect?.toFixed(4) ?? '-',
        'Total Effect': totalEffect?.toFixed(4) ?? '-',
      }

      if (indirectP !== undefined) {
        parsed.summary['Indirect p-value'] = indirectP < 0.001 ? '< 0.001' : indirectP.toFixed(4)
        parsed.summary['Mediation Significant'] = indirectP < 0.05 ? 'Yes' : 'No'
      }
      if (proportionMediated !== undefined) {
        const percent =
          percentMediated !== undefined
            ? percentMediated
            : proportionMediated * 100
        parsed.summary['Proportion Mediated'] = percent.toFixed(1) + '%'
      }
    } else if (testId.startsWith('moderation')) {
      const interactionEffect =
        num('interaction.coefficient') ??
        num('interaction_effect.coefficient') ??
        num('interaction_effect')
      const interactionP =
        num('interaction.p') ??
        num('interaction.p_value') ??
        num('interaction_effect.p_value') ??
        num('interaction_p')
      const rSquaredChange =
        num('interaction.r2_change') ??
        num('interaction.r_squared_change') ??
        num('r_squared_change')

      parsed.statistics = {
        pValue: interactionP,
      }

      parsed.summary = {
        'Interaction Effect': interactionEffect?.toFixed(4) ?? '-',
      }

      if (interactionP !== undefined) {
        parsed.summary['Interaction p-value'] = interactionP < 0.001 ? '< 0.001' : interactionP.toFixed(4)
        parsed.summary['Moderation Significant'] = interactionP < 0.05 ? 'Yes' : 'No'
      }
      if (rSquaredChange !== undefined) {
        parsed.summary['R² Change'] = rSquaredChange.toFixed(4)
      }
    } else if (testId === 'moderated_mediation_model7') {
      const indexMM =
        num('index_moderated_mediation') ??
        num('index_mm') ??
        num('index_of_moderated_mediation.index')

      parsed.summary = {
        'Index of Mod. Mediation': indexMM?.toFixed(4) ?? '-',
      }
    }
  }
  // ===== REGRESSION =====
  else if (family === 'regression') {
    parsed.statistics = {
      statistic: num('f_statistic') ?? num('f_value'),
      pValue: num('p_value') ?? num('model_p_value'),
      rSquared: num('r_squared') ?? num('r2'),
    }

    parsed.modelFit = {
      r2: num('r_squared') ?? num('r2'),
      adjustedR2: num('adjusted_r_squared') ?? num('adj_r2'),
      rmse: num('rmse') ?? num('root_mse'),
      aic: num('aic'),
      bic: num('bic'),
    }

    const r2 = num('r_squared') ?? num('r2')
    parsed.summary = {
      'R²': r2?.toFixed(4) ?? '-',
      'Adj. R²': (num('adjusted_r_squared') ?? num('adj_r2'))?.toFixed(4) ?? '-',
    }

    const coeffs = get('coefficients') as Array<{
      name?: string
      variable?: string
      term?: string
      term_display?: string
      class_label?: string
      estimate?: number
      coefficient?: number
      beta?: number
      std_error?: number
      p_value?: number
    }> | undefined

    if (Array.isArray(coeffs)) {
      parsed.coefficients = coeffs.map((c) => ({
        name:
          c.class_label && (c.term_display ?? c.term ?? c.name ?? c.variable)
            ? `${c.term_display ?? c.term ?? c.name ?? c.variable} [${c.class_label} vs Baseline]`
            : c.term_display ?? c.term ?? c.name ?? c.variable ?? 'Unknown',
        estimate: c.estimate ?? c.coefficient ?? c.beta ?? 0,
        stdError: c.std_error ?? 0,
        pValue: c.p_value ?? 0,
      }))
    }
  }
  // ===== CORRELATION =====
  else if (family === 'correlation') {
    const methodKey =
      testId.includes('spearman')
        ? 'spearman'
        : testId.includes('kendall')
          ? 'kendall'
          : testId.includes('pearson')
            ? 'pearson'
            : undefined
    const prefix = methodKey ? `${methodKey}.` : ''
    const r =
      num('correlation') ??
      num('r') ??
      num('rho') ??
      num('tau') ??
      (methodKey
        ? num(`${prefix}correlation`) ??
          num(`${prefix}r`) ??
          num(`${prefix}rho`) ??
          num(`${prefix}tau`)
        : undefined)
    const pVal = num('p_value') ?? (methodKey ? num(`${prefix}p_value`) : undefined)
    const correlationLabel =
      methodKey === 'spearman'
        ? 'Correlation (ρ)'
        : methodKey === 'kendall'
          ? 'Correlation (τ)'
          : 'Correlation (r)'

    parsed.statistics = {
      correlation: r,
      pValue: pVal,
    }

    parsed.summary = {
      [correlationLabel]: r?.toFixed(4) ?? '-',
      'p-value': pVal !== undefined ? (pVal < 0.001 ? '< 0.001' : pVal.toFixed(4)) : '-',
    }

    if (r !== undefined) {
      const strength = Math.abs(r) < 0.3 ? 'Weak' : Math.abs(r) < 0.7 ? 'Moderate' : 'Strong'
      const direction = r >= 0 ? 'Positive' : 'Negative'
      parsed.summary['Strength'] = `${strength} ${direction}`
    }
  }
  // ===== NONPARAMETRIC FACTORIAL =====
  else if (family === 'nonparametric' && testId === 'scheirer_ray_hare') {
    const factor1Label = normalizeFactorLabel(resultsData.factor1_label as string | undefined, 'Group 1')
    const factor2Label = normalizeFactorLabel(resultsData.factor2_label as string | undefined, 'Group 2')
    const interactionLabel = formatInteractionLabel(factor1Label, factor2Label)

    parsed.statistics = {
      [factor1Label]: {
        statistic: num('factor1_chi_square') ?? num('factor1_H'),
        pValue: num('factor1_p'),
        degreesOfFreedom: num('factor1_df'),
      },
      [factor2Label]: {
        statistic: num('factor2_chi_square') ?? num('factor2_H'),
        pValue: num('factor2_p'),
        degreesOfFreedom: num('factor2_df'),
      },
      [interactionLabel]: {
        statistic: num('interaction_chi_square') ?? num('interaction_H'),
        pValue: num('interaction_p'),
        degreesOfFreedom: num('interaction_df'),
      },
    }

    parsed.summary = {
      [`${factor1Label} Chi-Square`]: num('factor1_chi_square')?.toFixed(3) ?? '.',
      [`${factor1Label} p-value`]: formatPValueText(num('factor1_p')),
      [`${factor2Label} Chi-Square`]: num('factor2_chi_square')?.toFixed(3) ?? '.',
      [`${factor2Label} p-value`]: formatPValueText(num('factor2_p')),
      [`${interactionLabel} Chi-Square`]: num('interaction_chi_square')?.toFixed(3) ?? '.',
      [`${interactionLabel} p-value`]: formatPValueText(num('interaction_p')),
    }
  }
  // ===== DEFAULT =====
  else {
    parsed.statistics = {
      statistic:
        num('t_statistic') ??
        num('statistic') ??
        num('u_statistic') ??
        num('w_statistic') ??
        num('f_statistic') ??
        num('chi_square') ??
        num('h_statistic'),
      pValue: num('p_value'),
      degreesOfFreedom: num('df') ?? num('degrees_of_freedom') ?? num('df_between'),
      effectSize: num('effect_size') ?? num('cohens_d') ?? num('eta_squared') ?? num('r_squared'),
    }

    const ciLower = num('ci_lower') ?? num('confidence_interval.0')
    const ciUpper = num('ci_upper') ?? num('confidence_interval.1')
    if (ciLower !== undefined && ciUpper !== undefined) {
      parsed.statistics.confidenceInterval = [ciLower, ciUpper]
    }

    // Surface pairwise_comparisons into postHoc for one-way ANOVA and Kruskal-Wallis
    const pairwiseComparisons = get('pairwise_comparisons') as Array<{
      group1?: string
      group2?: string
      contrast?: string
      mean_difference?: number
      median_difference?: number
      statistic?: number
      p_value?: number
      p_adjusted?: number
      significant?: boolean
    }> | undefined

    if (Array.isArray(pairwiseComparisons) && pairwiseComparisons.length > 0) {
      parsed.postHoc = pairwiseComparisons.map((comp) => ({
        comparison: comp.contrast ?? `${comp.group1} vs ${comp.group2}`,
        statistic: comp.statistic ?? comp.mean_difference ?? comp.median_difference ?? 0,
        pValue: typeof comp.p_value === 'string' ? parseFloat(comp.p_value) : (comp.p_value ?? 0),
        pValueAdjusted: typeof comp.p_adjusted === 'string' ? parseFloat(comp.p_adjusted) : comp.p_adjusted,
        significant: comp.significant ?? false,
      }))
    }

    if (testId === 'descriptive_stats') {
      parsed.summary = {
        Mean: num('mean')?.toFixed(4) ?? '-',
        Median: num('median')?.toFixed(4) ?? '-',
        'Std Dev': (num('std_dev') ?? num('std'))?.toFixed(4) ?? '-',
        Min: num('min')?.toFixed(4) ?? '-',
        Max: num('max')?.toFixed(4) ?? '-',
        N: (num('n') ?? num('count'))?.toString() ?? '-',
      }
    } else if (testId === 'normality_all') {
      // Combined normality tests - show summary of all tests
      const tests = get('tests') as Array<{ test_name?: string; p_value?: number }> | undefined
      if (tests && Array.isArray(tests)) {
        const passCount = tests.filter(t => t.p_value !== undefined && t.p_value > 0.05).length
        const totalTests = tests.length
        parsed.summary = {
          'Tests Passed': `${passCount}/${totalTests}`,
          'Overall': passCount === totalTests ? 'Normal (all tests passed)' : `${passCount} of ${totalTests} tests suggest normality`,
        }
      } else {
        parsed.summary = {
          'Tests Run': '0',
        }
      }
    } else if (testId.startsWith('normality')) {
      const p = num('p_value')
      const isNormal = p !== undefined && p > 0.05
      parsed.summary = {
        'Normal Distribution': isNormal ? 'Yes (p > 0.05)' : 'No (p ≤ 0.05)',
      }
    } else if (testId === 'outlier_detection') {
      const nOutliers = num('n_outliers') ?? num('outlier_count')
      parsed.summary = {
        'Outliers Found': nOutliers?.toString() ?? '0',
      }
    }
  }

  return parsed
}
