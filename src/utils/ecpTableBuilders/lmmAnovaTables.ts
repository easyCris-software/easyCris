import type {
  ECPCell,
  ECPRow,
  ECPTable,
  ECPTableCollection,
  TableBuilderOptions,
} from '../../types/ecpStyleTables'
import { formatDF, formatNumber, formatPValue, formatStatistic } from './index'

const parseNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

const parseInteger = (value: unknown): number | undefined => {
  const parsed = parseNumber(value)
  return parsed === undefined ? undefined : Math.round(parsed)
}

const formatMaybeDF = (value: unknown): string => {
  const parsed = parseNumber(value)
  return parsed === undefined ? '.' : formatDF(parsed)
}

const formatMaybeNumber = (value: unknown, decimals: number): string => {
  const parsed = parseNumber(value)
  return parsed === undefined ? '.' : formatNumber(parsed, decimals)
}

const formatMaybeStatistic = (value: unknown, decimals: number): string => {
  const parsed = parseNumber(value)
  return parsed === undefined ? '.' : formatStatistic(parsed, decimals)
}

const formatMaybePValue = (
  value: unknown,
  options: Required<TableBuilderOptions>
): { text: string; isSignificant: boolean } => {
  const parsed = parseNumber(value)
  if (parsed === undefined) {
    return { text: '.', isSignificant: false }
  }
  return {
    text: formatPValue(parsed, options.pValueThreshold, options.minPValue),
    isSignificant: parsed < options.alpha,
  }
}

const significanceStars = (value: unknown): string => {
  const parsed = parseNumber(value)
  if (parsed === undefined) {
    return '-'
  }
  if (parsed <= 0.001) return '***'
  if (parsed <= 0.01) return '**'
  if (parsed <= 0.05) return '*'
  return '-'
}

const hasFiniteDfOmnibus = (result: Record<string, unknown>): boolean => {
  if (typeof result.omnibus_method === 'string' && result.omnibus_method.toLowerCase().includes('f')) {
    return true
  }
  if (result.finite_df_applied === true) {
    return true
  }
  const fixedEffects = Array.isArray(result.fixed_effects)
    ? (result.fixed_effects as Array<Record<string, unknown>>)
    : []
  return fixedEffects.some((effect) => parseNumber(effect.f_value) !== undefined)
}

const isInteractionEffect = (effect: Record<string, unknown>): boolean => {
  const raw = String(effect.source ?? effect.term ?? '').trim()
  return /\s+x\s+/i.test(raw) || raw.includes(':')
}

const inferOmnibusStatisticLabel = (
  effects: Array<Record<string, unknown>>,
  preferFiniteDf: boolean
): string => {
  const families = new Set(
    effects.map((effect) => {
      if (parseNumber(effect.f_value) !== undefined) return 'f'
      if (parseNumber(effect.chi_square) !== undefined) return 'chi_square'
      return preferFiniteDf ? 'f' : 'chi_square'
    })
  )

  if (families.size === 1) {
    return families.has('f') ? 'F statistic' : 'Chi-Square'
  }

  return 'F / Chi-Square'
}

const parseFactorScope = (
  factorScope: unknown
): { effect: string; withinFactor: string; withinLevel: string } => {
  if (typeof factorScope !== 'string' || !factorScope.trim()) {
    return { effect: '.', withinFactor: '.', withinLevel: '.' }
  }

  const [rawEffectPart, rawWithinPart] = factorScope.split('|', 2)
  const effectPart = rawEffectPart ?? ''
  const withinPart = rawWithinPart ?? ''
  if (!withinPart) {
    return { effect: effectPart.trim() || '.', withinFactor: '.', withinLevel: '.' }
  }

  const [rawWithinFactor, ...levelParts] = withinPart.split('=')
  const withinFactor = rawWithinFactor ?? ''
  return {
    effect: effectPart.trim() || '.',
    withinFactor: withinFactor.trim() || '.',
    withinLevel: levelParts.join('=').trim() || '.',
  }
}

const formatPosthocAdjustment = (
  method: unknown,
  posthocQ: unknown,
  decimals: number
): string | undefined => {
  if (typeof method !== 'string' || !method.trim()) {
    return undefined
  }
  const qValue = parseNumber(posthocQ)
  if (qValue !== undefined && /fdr|benjamini/i.test(method)) {
    return `${method} (q = ${formatNumber(qValue, Math.min(decimals, 2))})`
  }
  return method
}

const inferPairwiseDisplay = (result: Record<string, unknown>) => {
  const contrastMethod =
    typeof result.contrast_method === 'string' ? result.contrast_method.toLowerCase() : ''
  const appliedDfMethod =
    typeof result.applied_df_method === 'string' ? result.applied_df_method.toLowerCase() : ''
  const dfMethod = typeof result.df_method === 'string' ? result.df_method.toLowerCase() : 'asymptotic'

  if (appliedDfMethod === 'asymptotic' || contrastMethod.includes('_z')) {
    return { label: 'z' }
  }
  if (contrastMethod.includes('_t') || appliedDfMethod === 'satterthwaite' || dfMethod === 'residual') {
    return { label: 't' }
  }
  return { label: 'z' }
}

const makeStatAttrs = (stat: string | undefined, value: unknown): Record<string, string> | undefined => {
  if (!stat) return undefined
  return {
    'data-stat': stat,
    'data-value': value == null ? '.' : String(value),
  }
}

const toMetricToken = (value: string): string =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

const dayLikeOrder = (value: string): number => {
  const match = String(value).trim().match(/^d(\d+)$/i)
  return match ? Number(match[1]) : Number.NaN
}

const withCiAttrs = (
  baseAttrs: Record<string, string> | undefined,
  lowerStat: string | undefined,
  lowerValue: unknown,
  upperStat: string | undefined,
  upperValue: unknown
): Record<string, string> | undefined => {
  const attrs: Record<string, string> = { ...(baseAttrs ?? {}) }
  if (lowerStat) {
    attrs['data-ci-lower-stat'] = lowerStat
    attrs['data-ci-lower-value'] = lowerValue == null ? '.' : String(lowerValue)
  }
  if (upperStat) {
    attrs['data-ci-upper-stat'] = upperStat
    attrs['data-ci-upper-value'] = upperValue == null ? '.' : String(upperValue)
  }
  return Object.keys(attrs).length > 0 ? attrs : undefined
}

const getStratifyColumns = (result: Record<string, unknown>): string[] =>
  Array.isArray(result.stratify_by)
    ? (result.stratify_by as unknown[]).map((value) => String(value))
    : []

const getStrataResults = (result: Record<string, unknown>): Array<Record<string, unknown>> =>
  Array.isArray(result.strata_results)
    ? (result.strata_results as Array<Record<string, unknown>>)
    : []

const EMPTY_SIMPLE_EFFECTS_NOTE =
  'No categorical simple effects were available inside the subgroup fits. This usually means fewer than two categorical predictors remained after subgrouping or treating time as numeric.'
const NO_REQUESTED_SIMPLE_EFFECTS_NOTE =
  'No simple effects were requested for this run. Select one or more effect-within-factor pairs in the LMM dialog to compute subgroup simple effects.'

const hasRequestedSimpleEffects = (result: Record<string, unknown>): boolean => {
  if (Array.isArray(result.simple_effects) && result.simple_effects.length > 0) {
    return true
  }

  const parameters = (result.parameters as Record<string, unknown> | undefined) ?? {}
  const requested = parameters.simple_effects
  if (Array.isArray(requested)) {
    return requested.length > 0
  }
  if (requested && typeof requested === 'object') {
    return Object.values(requested as Record<string, unknown>).some(value => value === true)
  }
  return false
}

function buildModelSummaryTable(
  result: Record<string, unknown>,
  _options: Required<TableBuilderOptions>
): ECPTable {
  const randomEffects = (result.random_effects as Record<string, unknown> | undefined) ?? {}
  const slopeList = Array.isArray(randomEffects.random_slopes)
    ? (randomEffects.random_slopes as unknown[]).map((value) => String(value))
    : []
  const randomStructure = slopeList.length > 0 ? `Intercept + ${slopeList.join(', ')}` : 'Intercept only'

  const rows: ECPRow[] = [
    {
      cells: [
        { value: 'Metric', isHeader: true, align: 'left' },
        { value: 'Value', isHeader: true, align: 'left' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
    { cells: [{ value: 'Model Type', align: 'left' }, { value: String(result.model_type ?? '.'), align: 'left' }] },
    { cells: [{ value: 'Formula', align: 'left' }, { value: String(result.formula ?? '.'), align: 'left' }] },
    { cells: [{ value: 'Random Effects', align: 'left' }, { value: randomStructure, align: 'left' }] },
    {
      cells: [
        { value: 'Estimation', align: 'left' },
        { value: Boolean(result.reml) ? 'REML' : 'ML', align: 'left' },
      ],
    },
    { cells: [{ value: 'Grouping Variable', align: 'left' }, { value: String(result.grouping_variable ?? '.'), align: 'left' }] },
    { cells: [{ value: 'Subjects', align: 'left' }, { value: parseInteger(result.subject_count) ?? '.', align: 'left' }] },
    { cells: [{ value: 'Rows Used', align: 'left' }, { value: parseInteger(result.rows_used) ?? '.', align: 'left' }] },
    { cells: [{ value: 'Rows Dropped', align: 'left' }, { value: parseInteger(result.rows_dropped) ?? '.', align: 'left' }] },
    { cells: [{ value: 'DF Method', align: 'left' }, { value: String(result.df_method ?? '.'), align: 'left' }] },
    { cells: [{ value: 'DF Method Requested', align: 'left' }, { value: String(result.requested_df_method ?? '.'), align: 'left' }] },
    { cells: [{ value: 'DF Method Applied', align: 'left' }, { value: String(result.applied_df_method ?? '.'), align: 'left' }] },
    { cells: [{ value: 'Finite DF Applied', align: 'left' }, { value: result.finite_df_applied === true ? 'Yes' : result.finite_df_applied === false ? 'No' : '.', align: 'left' }] },
  ]

  if (typeof result.finite_df_fallback_reason === 'string' && result.finite_df_fallback_reason.trim()) {
    rows.push({
      cells: [
        { value: 'Finite DF Fallback Reason', align: 'left' },
        { value: result.finite_df_fallback_reason, align: 'left' },
      ],
    })
  }

  return {
    title: 'Model Summary',
    columns: [
      { key: 'metric', header: 'Metric', align: 'left', width: 22 },
      { key: 'value', header: 'Value', align: 'left', width: 48 },
    ],
    rows,
    testName: 'lmm_model_summary',
  }
}

function buildOmnibusReportTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable | null {
  const d = options.decimalPlaces
  const useFiniteDf = hasFiniteDfOmnibus(result)
  const fixedEffects = Array.isArray(result.fixed_effects)
    ? (result.fixed_effects as Array<Record<string, unknown>>)
    : []
  const statisticHeader = inferOmnibusStatisticLabel(fixedEffects, useFiniteDf)

  const rows: ECPRow[] = [
    {
      cells: [
        { value: 'Section', isHeader: true, align: 'left' },
        { value: 'Effect', isHeader: true, align: 'left' },
        { value: statisticHeader, isHeader: true, align: 'right' },
        { value: useFiniteDf ? 'NumDF' : 'DF', isHeader: true, align: 'right' },
        ...(useFiniteDf ? [{ value: 'DenDF', isHeader: true, align: 'right' } satisfies ECPCell] : []),
        { value: 'Raw p', isHeader: true, align: 'right' },
        { value: 'Sig', isHeader: true, align: 'center' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
  ]

  fixedEffects.forEach((effect, index) => {
    const effectIndex = index + 1
    const source = String(effect.source ?? '.')
    const section = isInteractionEffect(effect) ? 'Interaction' : 'Main Effect'
    const p = formatMaybePValue(effect.p_value, options)
    rows.push({
      cells: useFiniteDf
        ? [
            { value: section, align: 'left', attrs: makeStatAttrs(`fe${effectIndex}_section`, section) },
            { value: source, align: 'left', attrs: makeStatAttrs(`fe${effectIndex}_source`, effect.source) },
            {
              value: formatMaybeStatistic(effect.f_value ?? effect.chi_square ?? effect.statistic, d),
              align: 'right',
              attrs: makeStatAttrs(`fe${effectIndex}_f_value`, effect.f_value ?? effect.chi_square ?? effect.statistic),
            },
            { value: formatMaybeDF(effect.num_df), align: 'right', attrs: makeStatAttrs(`fe${effectIndex}_num_df`, effect.num_df) },
            { value: formatMaybeDF(effect.den_df), align: 'right', attrs: makeStatAttrs(`fe${effectIndex}_den_df`, effect.den_df) },
            { value: p.text, align: 'right', isSignificant: p.isSignificant, attrs: makeStatAttrs(`fe${effectIndex}_p`, effect.p_value) },
            { value: significanceStars(effect.p_value), align: 'center' },
          ]
        : [
            { value: section, align: 'left', attrs: makeStatAttrs(`fe${effectIndex}_section`, section) },
            { value: source, align: 'left', attrs: makeStatAttrs(`fe${effectIndex}_source`, effect.source) },
            {
              value: formatMaybeStatistic(effect.chi_square ?? effect.statistic, d),
              align: 'right',
              attrs: makeStatAttrs(`fe${effectIndex}_chi_square`, effect.chi_square ?? effect.statistic),
            },
            { value: formatMaybeDF(effect.df), align: 'right', attrs: makeStatAttrs(`fe${effectIndex}_df`, effect.df) },
            { value: p.text, align: 'right', isSignificant: p.isSignificant, attrs: makeStatAttrs(`fe${effectIndex}_p`, effect.p_value) },
            { value: significanceStars(effect.p_value), align: 'center' },
          ],
    })
  })

  if (rows.length <= 2) {
    return null
  }

  return {
    title: 'Inferential Report: Omnibus Effects',
    columns: [
      { key: 'section', header: 'Section', align: 'left' as const, width: 16 },
      { key: 'effect', header: 'Effect', align: 'left' as const, width: 26 },
      { key: 'statistic', header: statisticHeader, align: 'right' as const, width: 14, format: 'decimal' },
      { key: useFiniteDf ? 'num_df' : 'df', header: useFiniteDf ? 'NumDF' : 'DF', align: 'right' as const, width: 10, format: 'decimal' },
      ...(useFiniteDf ? [{ key: 'den_df', header: 'DenDF', align: 'right' as const, width: 10, format: 'decimal' as const }] : []),
      { key: 'p_raw', header: 'Raw p', align: 'right' as const, width: 12, format: 'pvalue' },
      { key: 'sig', header: 'Sig', align: 'center' as const, width: 6 },
    ],
    rows,
    footnotes: [
      useFiniteDf
        ? 'Single pooled mixed model; subgroup-style interpretation comes from the simple-effects table below.'
        : 'Single pooled mixed model; omnibus rows use asymptotic fallback while subgroup-style detail remains in the simple-effects table.',
    ],
    testName: 'lmm_omnibus_report',
  }
}

function buildSimpleEffectsReportTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable | null {
  const d = options.decimalPlaces
  const pairwiseComparisons = Array.isArray(result.pairwise_comparisons)
    ? (result.pairwise_comparisons as Array<Record<string, unknown>>)
    : []

  const simpleEffects = pairwiseComparisons
    .filter((entry) => typeof entry.factor_scope === 'string')
    .map((entry) => ({
      entry,
      scope: parseFactorScope(entry.factor_scope),
      comparison: String(entry.contrast ?? `${entry.group1 ?? '.'} vs ${entry.group2 ?? '.'}`),
    }))
    .sort((left, right) => {
      return (
        left.scope.effect.localeCompare(right.scope.effect) ||
        left.scope.withinFactor.localeCompare(right.scope.withinFactor) ||
        left.scope.withinLevel.localeCompare(right.scope.withinLevel, undefined, { numeric: true }) ||
        left.comparison.localeCompare(right.comparison)
      )
    })

  const requestedSimpleEffects = hasRequestedSimpleEffects(result)
  if (simpleEffects.length === 0 && !requestedSimpleEffects) {
    return null
  }

  const rows: ECPRow[] = [
    {
      cells: [
        { value: 'Effect', isHeader: true, align: 'left' },
        { value: 'Within Factor', isHeader: true, align: 'left' },
        { value: 'Within Level', isHeader: true, align: 'left' },
        { value: 'Comparison', isHeader: true, align: 'left' },
        { value: 'Estimate', isHeader: true, align: 'right' },
        { value: 'Std Error', isHeader: true, align: 'right' },
        { value: 'Statistic', isHeader: true, align: 'right' },
        { value: 'DF', isHeader: true, align: 'right' },
        { value: 'Raw p', isHeader: true, align: 'right' },
        { value: 'Adj. p-value', isHeader: true, align: 'right' },
        { value: 'Sig', isHeader: true, align: 'center' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
  ]

  let lastSimpleGroupKey: string | null = null
  simpleEffects.forEach(({ entry, scope, comparison }, index) => {
    const pairIndex = index + 1
    const pRaw = formatMaybePValue(entry.p_raw ?? entry.p_value, options)
    const pAdj = formatMaybePValue(entry.p_adjusted, options)
    const groupKey = [scope.effect, scope.withinFactor, scope.withinLevel].join('||')
    const repeatedContext = groupKey === lastSimpleGroupKey
    if (lastSimpleGroupKey !== null && groupKey !== lastSimpleGroupKey) {
      rows.push({ cells: [], isSeparator: true })
    }
    lastSimpleGroupKey = groupKey
    rows.push({
      cells: [
        { value: repeatedContext ? '' : scope.effect, align: 'left' },
        { value: repeatedContext ? '' : scope.withinFactor, align: 'left' },
        { value: repeatedContext ? '' : scope.withinLevel, align: 'left' },
        { value: comparison, align: 'left', attrs: makeStatAttrs(`se${pairIndex}_label`, comparison) },
        {
          value: formatMaybeNumber(entry.estimate ?? entry.difference, d),
          align: 'right',
          attrs: withCiAttrs(
            makeStatAttrs(`se${pairIndex}_estimate`, entry.estimate ?? entry.difference),
            `se${pairIndex}_ci_lower`,
            entry.ci_lower,
            `se${pairIndex}_ci_upper`,
            entry.ci_upper
          ),
        },
        { value: formatMaybeNumber(entry.se, d), align: 'right', attrs: makeStatAttrs(`se${pairIndex}_se`, entry.se) },
        { value: formatMaybeStatistic(entry.t_stat, d), align: 'right', attrs: makeStatAttrs(`se${pairIndex}_t_ratio`, entry.t_stat) },
        { value: formatMaybeDF(entry.df), align: 'right', attrs: makeStatAttrs(`se${pairIndex}_df`, entry.df) },
        { value: pRaw.text, align: 'right', isSignificant: pRaw.isSignificant, attrs: makeStatAttrs(`se${pairIndex}_p_raw`, entry.p_raw ?? entry.p_value) },
        { value: pAdj.text, align: 'right', isSignificant: pAdj.isSignificant, attrs: makeStatAttrs(`se${pairIndex}_p`, entry.p_adjusted) },
        { value: significanceStars(entry.p_adjusted ?? entry.p_raw ?? entry.p_value), align: 'center' },
      ],
    })
  })

  if (simpleEffects.length === 0) {
    rows.push({
      cells: [
        {
          value:
            'No categorical simple effects were available for this fitted model. This usually means fewer than two categorical predictors remained after subgrouping or treating time as numeric.',
          align: 'left',
          colSpan: 11,
        },
      ],
    })
  }

  return {
    title: 'Inferential Report: Simple Effects',
    columns: [
      { key: 'effect', header: 'Effect', align: 'left' as const, width: 16 },
      { key: 'within_factor', header: 'Within Factor', align: 'left' as const, width: 18 },
      { key: 'within_level', header: 'Within Level', align: 'left' as const, width: 14 },
      { key: 'comparison', header: 'Comparison', align: 'left' as const, width: 22 },
      { key: 'estimate', header: 'Estimate', align: 'right' as const, width: 12, format: 'decimal' },
      { key: 'se', header: 'Std Error', align: 'right' as const, width: 12, format: 'decimal' },
      { key: 'statistic', header: 'Statistic', align: 'right' as const, width: 12, format: 'decimal' },
      { key: 'df', header: 'DF', align: 'right' as const, width: 10, format: 'decimal' },
      { key: 'p_raw', header: 'Raw p', align: 'right' as const, width: 12, format: 'pvalue' },
      { key: 'p_adj', header: 'Adj. p-value', align: 'right' as const, width: 12, format: 'pvalue' },
      { key: 'sig', header: 'Sig', align: 'center' as const, width: 6 },
    ],
    rows,
    footnotes: [
      simpleEffects.length > 0
        ? 'Single pooled mixed model; repeated rows within a block share the same within-factor context.'
        : 'No categorical simple effects were available for this fitted model. This usually means fewer than two categorical predictors remained after subgrouping or treating time as numeric.',
    ],
    testName: 'lmm_simple_effects_report',
  }
}

function buildModelFitTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces
  const fitMetrics = (result.fit_metrics as Record<string, unknown> | undefined) ?? {}
  const rows: ECPRow[] = [
    {
      cells: [
        { value: 'Metric', isHeader: true, align: 'left' },
        { value: 'Value', isHeader: true, align: 'right' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
    { cells: [{ value: 'Optimizer', align: 'left' }, { value: String(fitMetrics.optimizer ?? '.'), align: 'right', attrs: { 'data-stat': 'fit_optimizer' } }] },
    { cells: [{ value: 'Converged', align: 'left' }, { value: fitMetrics.converged === true ? 'Yes' : fitMetrics.converged === false ? 'No' : '.', align: 'right', attrs: { 'data-stat': 'fit_converged' } }] },
    { cells: [{ value: 'Log Likelihood', align: 'left' }, { value: formatMaybeNumber(fitMetrics.log_likelihood, d), align: 'right', attrs: { 'data-stat': 'fit_log_likelihood' } }] },
    { cells: [{ value: 'AIC', align: 'left' }, { value: formatMaybeNumber(fitMetrics.aic, d), align: 'right', attrs: { 'data-stat': 'fit_aic' } }] },
    { cells: [{ value: 'BIC', align: 'left' }, { value: formatMaybeNumber(fitMetrics.bic, d), align: 'right', attrs: { 'data-stat': 'fit_bic' } }] },
    { cells: [{ value: 'Residual Variance', align: 'left' }, { value: formatMaybeNumber(fitMetrics.residual_variance, d), align: 'right', attrs: { 'data-stat': 'fit_residual_variance' } }] },
  ]

  return {
    title: 'Model Fit / Random Effects',
    columns: [
      { key: 'metric', header: 'Metric', align: 'left', width: 22 },
      { key: 'value', header: 'Value', align: 'right', width: 18 },
    ],
    rows,
    testName: 'lmm_model_fit',
  }
}

function buildDiagnosticsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces
  const diagnostics = (result.diagnostics as Record<string, unknown> | undefined) ?? {}
  const normality = (diagnostics.residual_normality as Record<string, unknown> | undefined) ?? {}
  const spread = (diagnostics.residual_spread as Record<string, unknown> | undefined) ?? {}
  const randomVariances = Array.isArray(diagnostics.random_effect_variances)
    ? (diagnostics.random_effect_variances as unknown[])
    : []
  const warningsList = Array.isArray(diagnostics.warnings)
    ? (diagnostics.warnings as unknown[]).map((value) => String(value))
    : []

  const rows: ECPRow[] = [
    {
      cells: [
        { value: 'Metric', isHeader: true, align: 'left' },
        { value: 'Value', isHeader: true, align: 'right' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
    { cells: [{ value: 'Converged', align: 'left' }, { value: diagnostics.converged === true ? 'Yes' : diagnostics.converged === false ? 'No' : '.', align: 'right', attrs: { 'data-stat': 'diag_converged' } }] },
    { cells: [{ value: 'Singular Fit', align: 'left' }, { value: diagnostics.singular_fit === true ? 'Yes' : diagnostics.singular_fit === false ? 'No' : '.', align: 'right', attrs: { 'data-stat': 'diag_singular_fit' } }] },
    { cells: [{ value: 'Near-Zero Random Variance', align: 'left' }, { value: diagnostics.near_zero_random_variance === true ? 'Yes' : diagnostics.near_zero_random_variance === false ? 'No' : '.', align: 'right', attrs: { 'data-stat': 'diag_near_zero_random_variance' } }] },
    { cells: [{ value: 'Rows Dropped', align: 'left' }, { value: parseInteger(diagnostics.rows_dropped) ?? '.', align: 'right', attrs: { 'data-stat': 'diag_rows_dropped' } }] },
    { cells: [{ value: 'Residual Normality Statistic', align: 'left' }, { value: formatMaybeStatistic(normality.statistic, d), align: 'right', attrs: { 'data-stat': 'diag_residual_normality_statistic' } }] },
    { cells: [{ value: 'Residual Normality p-value', align: 'left' }, { value: formatMaybePValue(normality.p_value, options).text, align: 'right', attrs: { 'data-stat': 'diag_residual_normality_p' } }] },
    { cells: [{ value: 'Residual Spread Statistic', align: 'left' }, { value: formatMaybeStatistic(spread.statistic, d), align: 'right', attrs: { 'data-stat': 'diag_residual_spread_statistic' } }] },
    { cells: [{ value: 'Residual Spread p-value', align: 'left' }, { value: formatMaybePValue(spread.p_value, options).text, align: 'right', attrs: { 'data-stat': 'diag_residual_spread_p' } }] },
  ]

  randomVariances.forEach((value, index) => {
    rows.push({
      cells: [
        { value: `Random Effect Variance ${index + 1}`, align: 'left' },
        { value: formatMaybeNumber(value, d), align: 'right', attrs: { 'data-stat': `diag_random_effect_variance_${index + 1}` } },
      ],
    })
  })

  return {
    title: 'Diagnostics / Warnings',
    columns: [
      { key: 'metric', header: 'Metric', align: 'left', width: 28 },
      { key: 'value', header: 'Value', align: 'right', width: 18 },
    ],
    rows,
    footnotes: warningsList.length > 0 ? warningsList : undefined,
    testName: 'lmm_diagnostics',
  }
}

function buildMarginalEffectsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable | null {
  const d = options.decimalPlaces
  const display = inferPairwiseDisplay(result)
  const pairwiseComparisons = Array.isArray(result.pairwise_comparisons)
    ? (result.pairwise_comparisons as Array<Record<string, unknown>>)
    : []
  const marginalRows = pairwiseComparisons.filter(
    (entry) => typeof entry.factor === 'string' && typeof entry.factor_scope !== 'string'
  )

  if (marginalRows.length === 0) {
    return null
  }

  const rows: ECPRow[] = [
    {
      cells: [
        { value: 'Factor', isHeader: true, align: 'left' },
        { value: 'Comparison', isHeader: true, align: 'left' },
        { value: 'Estimate', isHeader: true, align: 'right' },
        { value: 'Std Error', isHeader: true, align: 'right' },
        { value: '95% CI [lower, upper]', isHeader: true, align: 'right' },
        { value: 'DF', isHeader: true, align: 'right' },
        { value: `${display.label} Ratio`, isHeader: true, align: 'right' },
        { value: `Pr > |${display.label}|`, isHeader: true, align: 'right' },
        { value: 'Adj. p-value', isHeader: true, align: 'right' },
        { value: 'Sig', isHeader: true, align: 'center' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
  ]

  marginalRows.forEach((entry, index) => {
    const pairIndex = index + 1
    const pRaw = formatMaybePValue(entry.p_raw ?? entry.p_value, options)
    const pAdj = formatMaybePValue(entry.p_adjusted, options)
    rows.push({
      cells: [
        { value: String(entry.factor ?? '.'), align: 'left' },
        {
          value: String(entry.contrast ?? `${entry.group1 ?? '.'} vs ${entry.group2 ?? '.'}`),
          align: 'left',
          attrs: makeStatAttrs(`me${pairIndex}_label`, entry.contrast ?? `${entry.group1 ?? '.'} vs ${entry.group2 ?? '.'}`),
        },
        {
          value: formatMaybeNumber(entry.estimate ?? entry.difference, d),
          align: 'right',
          attrs: withCiAttrs(
            makeStatAttrs(`me${pairIndex}_estimate`, entry.estimate ?? entry.difference),
            `me${pairIndex}_ci_lower`,
            entry.ci_lower,
            `me${pairIndex}_ci_upper`,
            entry.ci_upper
          ),
        },
        { value: formatMaybeNumber(entry.se, d), align: 'right', attrs: makeStatAttrs(`me${pairIndex}_se`, entry.se) },
        {
          value: `[${formatMaybeNumber(entry.ci_lower, d)}, ${formatMaybeNumber(entry.ci_upper, d)}]`,
          align: 'right',
          attrs: withCiAttrs(undefined, `me${pairIndex}_ci_lower`, entry.ci_lower, `me${pairIndex}_ci_upper`, entry.ci_upper),
        },
        { value: formatMaybeDF(entry.df), align: 'right', attrs: makeStatAttrs(`me${pairIndex}_df`, entry.df) },
        { value: formatMaybeStatistic(entry.t_stat, d), align: 'right', attrs: makeStatAttrs(`me${pairIndex}_t_ratio`, entry.t_stat) },
        {
          value: pRaw.text,
          align: 'right',
          isSignificant: pRaw.isSignificant,
          attrs: makeStatAttrs(`me${pairIndex}_p_raw`, entry.p_raw ?? entry.p_value),
        },
        {
          value: pAdj.text,
          align: 'right',
          isSignificant: pAdj.isSignificant,
          attrs: makeStatAttrs(`me${pairIndex}_p`, entry.p_adjusted),
        },
        { value: significanceStars(entry.p_adjusted ?? entry.p_raw ?? entry.p_value), align: 'center' },
      ],
    })
  })

  return {
    title: 'Marginal Pairwise Comparisons',
    columns: [
      { key: 'factor', header: 'Factor', align: 'left', width: 18 },
      { key: 'comparison', header: 'Comparison', align: 'left', width: 24 },
      { key: 'estimate', header: 'Estimate', align: 'right', width: 12, format: 'decimal' },
      { key: 'se', header: 'Std Error', align: 'right', width: 12, format: 'decimal' },
      { key: 'ci', header: '95% CI [lower, upper]', align: 'right', width: 24, format: 'text' },
      { key: 'df', header: 'DF', align: 'right', width: 10, format: 'decimal' },
      { key: 'stat', header: `${display.label} Ratio`, align: 'right', width: 12, format: 'decimal' },
      { key: 'p_raw', header: `Pr > |${display.label}|`, align: 'right', width: 12, format: 'pvalue' },
      { key: 'p_adj', header: 'Adj. p-value', align: 'right', width: 12, format: 'pvalue' },
      { key: 'sig', header: 'Sig', align: 'center', width: 6 },
    ],
    rows,
    testName: 'lmm_marginal_effects',
  }
}

export function buildLmmAnovaTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  if (result.stratified === true && Array.isArray(result.strata_results)) {
    return buildStratifiedLmmAnovaTables(result, options)
  }

  const tables: ECPTable[] = []
  const counts = [
    { label: 'Subjects', value: parseInteger(result.subject_count) },
    { label: 'Observations', value: parseInteger(result.rows_used) },
  ].filter((count): count is { label: string; value: number } => count.value !== undefined)

  const omnibusReport = buildOmnibusReportTable(result, options)
  if (omnibusReport) {
    tables.push(omnibusReport)
  }

  const simpleEffectsReport = buildSimpleEffectsReportTable(result, options)
  if (simpleEffectsReport) {
    tables.push(simpleEffectsReport)
  }

  tables.push(buildModelSummaryTable(result, options))
  tables.push(buildModelFitTable(result, options))
  tables.push(buildDiagnosticsTable(result, options))

  const marginalEffects = buildMarginalEffectsTable(result, options)
  if (marginalEffects) {
    tables.push(marginalEffects)
  }

  return {
    testType: 'lmm_anova',
    testFamily: 'parametric',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      counts: counts.length > 0 ? counts : undefined,
      posthocAdjustment: formatPosthocAdjustment(
        result.adjustment_method,
        result.posthoc_q,
        options.decimalPlaces
      ),
    },
  }
}

function buildStratifiedLmmAnovaTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const stratifyColumns = getStratifyColumns(result)
  const strataResults = getStrataResults(result)
  const tables: ECPTable[] = []
  const d = options.decimalPlaces
  const omnibusRows: ECPRow[] = [
    {
      cells: [
        { value: 'Section', isHeader: true, align: 'left' },
        ...stratifyColumns.map((column) => ({ value: column, isHeader: true, align: 'left' as const })),
        { value: 'Effect', isHeader: true, align: 'left' },
        { value: 'Inference', isHeader: true, align: 'left' },
        { value: 'Statistic', isHeader: true, align: 'right' },
        { value: 'DF', isHeader: true, align: 'right' },
        { value: 'DenDF', isHeader: true, align: 'right' },
        { value: 'Raw p', isHeader: true, align: 'right' },
        { value: 'Sig', isHeader: true, align: 'center' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
  ]

  const simpleRows: ECPRow[] = [
    {
      cells: [
        ...stratifyColumns.map((column) => ({ value: column, isHeader: true, align: 'left' as const })),
        { value: 'Effect', isHeader: true, align: 'left' },
        { value: 'Within Factor', isHeader: true, align: 'left' },
        { value: 'Within Level', isHeader: true, align: 'left' },
        { value: 'Comparison', isHeader: true, align: 'left' },
        { value: 'Estimate', isHeader: true, align: 'right' },
        { value: 'Std Error', isHeader: true, align: 'right' },
        { value: 'Statistic', isHeader: true, align: 'right' },
        { value: 'DF', isHeader: true, align: 'right' },
        { value: 'Raw p', isHeader: true, align: 'right' },
        { value: 'Adj. p-value', isHeader: true, align: 'right' },
        { value: 'Sig', isHeader: true, align: 'center' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
  ]

  const diagnosticsRows: ECPRow[] = [
    {
      cells: [
        ...stratifyColumns.map((column) => ({ value: column, isHeader: true, align: 'left' as const })),
        { value: 'Converged', isHeader: true, align: 'right' },
        { value: 'Singular Fit', isHeader: true, align: 'right' },
        { value: 'Finite DF Applied', isHeader: true, align: 'right' },
        { value: 'Fallback Reason', isHeader: true, align: 'left' },
        { value: 'Error', isHeader: true, align: 'left' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
  ]

  strataResults.forEach((child, stratumIndex) => {
    const stratum = (child.stratum as Record<string, unknown> | undefined) ?? {}
    const fixedEffects = Array.isArray(child.fixed_effects)
      ? (child.fixed_effects as Array<Record<string, unknown>>)
      : []
    const pairwiseComparisons = Array.isArray(child.pairwise_comparisons)
      ? (child.pairwise_comparisons as Array<Record<string, unknown>>)
      : []
    const diagnostics = (child.diagnostics as Record<string, unknown> | undefined) ?? {}
    const childSucceeded = child.success !== false

    fixedEffects.forEach((effect, effectIndex) => {
      const source = String(effect.source ?? '.')
      const section = isInteractionEffect(effect) ? 'Interaction' : 'Main Effect'
      const inference =
        typeof effect.f_value === 'number' || typeof effect.f_value === 'string'
          ? 'F'
          : 'Chi-Square'
      const p = formatMaybePValue(effect.p_value, options)
        omnibusRows.push({
          cells: [
            { value: section, align: 'left', attrs: makeStatAttrs(`st${stratumIndex + 1}_fe${effectIndex + 1}_section`, section) },
            ...stratifyColumns.map((column) => ({
              value: String(stratum[column] ?? '.'),
              align: 'left' as const,
              attrs: makeStatAttrs(
                `st${stratumIndex + 1}_fe${effectIndex + 1}_stratum_${toMetricToken(column)}`,
                stratum[column]
              ),
            })),
            { value: source, align: 'left', attrs: makeStatAttrs(`st${stratumIndex + 1}_fe${effectIndex + 1}_source`, effect.source) },
            { value: inference, align: 'left', attrs: makeStatAttrs(`st${stratumIndex + 1}_fe${effectIndex + 1}_inference`, inference) },
            {
              value: formatMaybeStatistic(effect.f_value ?? effect.chi_square ?? effect.statistic, d),
              align: 'right',
            attrs: makeStatAttrs(
              inference === 'F'
                ? `st${stratumIndex + 1}_fe${effectIndex + 1}_f_value`
                : `st${stratumIndex + 1}_fe${effectIndex + 1}_chi_square`,
              effect.f_value ?? effect.chi_square ?? effect.statistic
            ),
          },
          {
            value: inference === 'F' ? formatMaybeDF(effect.num_df) : formatMaybeDF(effect.df),
            align: 'right',
            attrs: makeStatAttrs(
              inference === 'F'
                ? `st${stratumIndex + 1}_fe${effectIndex + 1}_num_df`
                : `st${stratumIndex + 1}_fe${effectIndex + 1}_df`,
              inference === 'F' ? effect.num_df : effect.df
            ),
          },
          {
            value: inference === 'F' ? formatMaybeDF(effect.den_df) : '.',
            align: 'right',
            attrs: inference === 'F'
              ? makeStatAttrs(`st${stratumIndex + 1}_fe${effectIndex + 1}_den_df`, effect.den_df)
              : undefined,
          },
          {
            value: p.text,
            align: 'right',
            isSignificant: p.isSignificant,
            attrs: makeStatAttrs(`st${stratumIndex + 1}_fe${effectIndex + 1}_p`, effect.p_value),
          },
          { value: significanceStars(effect.p_value), align: 'center' },
        ],
      })
    })

    const simpleEffects = pairwiseComparisons
      .filter((entry) => typeof entry.factor_scope === 'string')
      .map((entry) => ({
        entry,
        scope: parseFactorScope(entry.factor_scope),
        comparison: String(entry.contrast ?? `${entry.group1 ?? '.'} vs ${entry.group2 ?? '.'}`),
      }))
    const dayLevels = Array.from(
      new Set(
        simpleEffects
          .filter(
            ({ scope }) =>
              scope.effect.toLowerCase() === 'treatment' &&
              scope.withinFactor.toLowerCase() === 'day'
          )
          .map(({ scope }) => scope.withinLevel)
      )
    ).sort((left, right) => {
      const leftOrder = dayLikeOrder(left)
      const rightOrder = dayLikeOrder(right)
      if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder)) return leftOrder - rightOrder
      return String(left).localeCompare(String(right))
    })
    const dayRank = new Map(dayLevels.map((level, index) => [String(level), index]))
    const orderedSimpleEffects = simpleEffects.sort((left, right) => {
      const leftEffect = left.scope.effect.toLowerCase()
      const rightEffect = right.scope.effect.toLowerCase()
      const leftWithin = left.scope.withinFactor.toLowerCase()
      const rightWithin = right.scope.withinFactor.toLowerCase()
      const leftGroupRank = leftEffect === 'treatment' && leftWithin === 'day' ? 0 : 1
      const rightGroupRank = rightEffect === 'treatment' && rightWithin === 'day' ? 0 : 1
      if (leftGroupRank !== rightGroupRank) return leftGroupRank - rightGroupRank

      if (left.scope.withinLevel !== right.scope.withinLevel) {
        const leftOrder = dayLikeOrder(left.scope.withinLevel)
        const rightOrder = dayLikeOrder(right.scope.withinLevel)
        if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder)) return leftOrder - rightOrder
        return String(left.scope.withinLevel).localeCompare(String(right.scope.withinLevel))
      }

      const [leftA = '', leftB = ''] = left.comparison.split(' - ')
      const [rightA = '', rightB = ''] = right.comparison.split(' - ')
      const leftARank = dayRank.get(String(leftA)) ?? Number.MAX_SAFE_INTEGER
      const rightARank = dayRank.get(String(rightA)) ?? Number.MAX_SAFE_INTEGER
      if (leftARank !== rightARank) return leftARank - rightARank
      const leftBRank = dayRank.get(String(leftB)) ?? Number.MAX_SAFE_INTEGER
      const rightBRank = dayRank.get(String(rightB)) ?? Number.MAX_SAFE_INTEGER
      if (leftBRank !== rightBRank) return leftBRank - rightBRank
      return left.comparison.localeCompare(right.comparison)
    })

    orderedSimpleEffects.forEach(({ entry, scope, comparison }, effectIndex) => {
      const pRaw = formatMaybePValue(entry.p_raw ?? entry.p_value, options)
      const pAdj = formatMaybePValue(entry.p_adjusted, options)
      simpleRows.push({
        cells: [
          ...stratifyColumns.map((column) => ({
            value: String(stratum[column] ?? '.'),
            align: 'left' as const,
            attrs: makeStatAttrs(
              `st${stratumIndex + 1}_se${effectIndex + 1}_stratum_${toMetricToken(column)}`,
              stratum[column]
            ),
          })),
          { value: scope.effect, align: 'left' },
          { value: scope.withinFactor, align: 'left' },
          { value: scope.withinLevel, align: 'left' },
          { value: comparison, align: 'left', attrs: makeStatAttrs(`st${stratumIndex + 1}_se${effectIndex + 1}_label`, comparison) },
          {
            value: formatMaybeNumber(entry.estimate ?? entry.difference, d),
            align: 'right',
            attrs: withCiAttrs(
              makeStatAttrs(`st${stratumIndex + 1}_se${effectIndex + 1}_estimate`, entry.estimate ?? entry.difference),
              `st${stratumIndex + 1}_se${effectIndex + 1}_ci_lower`,
              entry.ci_lower,
              `st${stratumIndex + 1}_se${effectIndex + 1}_ci_upper`,
              entry.ci_upper
            ),
          },
          { value: formatMaybeNumber(entry.se, d), align: 'right', attrs: makeStatAttrs(`st${stratumIndex + 1}_se${effectIndex + 1}_se`, entry.se) },
          { value: formatMaybeStatistic(entry.t_stat, d), align: 'right', attrs: makeStatAttrs(`st${stratumIndex + 1}_se${effectIndex + 1}_t_ratio`, entry.t_stat) },
          { value: formatMaybeDF(entry.df), align: 'right', attrs: makeStatAttrs(`st${stratumIndex + 1}_se${effectIndex + 1}_df`, entry.df) },
          {
            value: pRaw.text,
            align: 'right',
            isSignificant: pRaw.isSignificant,
            attrs: makeStatAttrs(`st${stratumIndex + 1}_se${effectIndex + 1}_p_raw`, entry.p_raw ?? entry.p_value),
          },
          {
            value: pAdj.text,
            align: 'right',
            isSignificant: pAdj.isSignificant,
            attrs: makeStatAttrs(`st${stratumIndex + 1}_se${effectIndex + 1}_p`, entry.p_adjusted),
          },
          { value: significanceStars(entry.p_adjusted ?? entry.p_raw ?? entry.p_value), align: 'center' },
        ],
      })
    })

    diagnosticsRows.push({
      cells: [
        ...stratifyColumns.map((column) => ({ value: String(stratum[column] ?? '.'), align: 'left' as const })),
        { value: diagnostics.converged === true ? 'Yes' : diagnostics.converged === false ? 'No' : '.', align: 'right' },
        { value: diagnostics.singular_fit === true ? 'Yes' : diagnostics.singular_fit === false ? 'No' : '.', align: 'right' },
        { value: child.finite_df_applied === true ? 'Yes' : child.finite_df_applied === false ? 'No' : '.', align: 'right' },
        { value: String(child.finite_df_fallback_reason ?? '.'), align: 'left' },
        { value: childSucceeded ? '.' : String(child.error ?? 'Stratified fit failed.'), align: 'left' },
      ],
    })
  })

  tables.push({
    title: 'Inferential Report: Omnibus Effects',
    columns: [
      { key: 'section', header: 'Section', align: 'left', width: 16 },
      ...stratifyColumns.map((column) => ({ key: column, header: column, align: 'left' as const, width: 14 })),
      { key: 'effect', header: 'Effect', align: 'left', width: 20 },
      { key: 'inference', header: 'Inference', align: 'left', width: 14 },
      { key: 'statistic', header: 'Statistic', align: 'right', width: 12 },
      { key: 'df', header: 'DF', align: 'right', width: 10 },
      { key: 'den_df', header: 'DenDF', align: 'right', width: 10 },
      { key: 'p_raw', header: 'Raw p', align: 'right', width: 12 },
      { key: 'sig', header: 'Sig', align: 'center', width: 6 },
    ],
    rows: omnibusRows,
    footnotes: [
      'Each row comes from a separate subgroup fit, not one pooled model.',
      'Asymptotic fallback rows show chi-square inference with a single DF column and blank DenDF.',
    ],
    testName: 'lmm_omnibus_report',
  })

  const requestedSimpleEffects = hasRequestedSimpleEffects(result)
  if (simpleRows.length <= 2) {
    simpleRows.push({
      cells: [
        ...stratifyColumns.map(() => ({ value: '', align: 'left' as const })),
        {
          value: requestedSimpleEffects
            ? EMPTY_SIMPLE_EFFECTS_NOTE
            : NO_REQUESTED_SIMPLE_EFFECTS_NOTE,
          align: 'left',
          colSpan: 11,
        },
      ],
    })
  }

  tables.push({
    title: 'Inferential Report: Simple Effects',
    columns: [
      ...stratifyColumns.map((column) => ({ key: column, header: column, align: 'left' as const, width: 14 })),
      { key: 'effect', header: 'Effect', align: 'left', width: 16 },
      { key: 'within_factor', header: 'Within Factor', align: 'left', width: 16 },
      { key: 'within_level', header: 'Within Level', align: 'left', width: 14 },
      { key: 'comparison', header: 'Comparison', align: 'left', width: 18 },
      { key: 'estimate', header: 'Estimate', align: 'right', width: 12 },
      { key: 'se', header: 'Std Error', align: 'right', width: 12 },
      { key: 'statistic', header: 'Statistic', align: 'right', width: 12 },
      { key: 'df', header: 'DF', align: 'right', width: 10 },
      { key: 'p_raw', header: 'Raw p', align: 'right', width: 12 },
      { key: 'p_adj', header: 'Adj. p-value', align: 'right', width: 12 },
      { key: 'sig', header: 'Sig', align: 'center', width: 6 },
    ],
    rows: simpleRows,
    footnotes: [
      simpleRows.some(row => row.cells.some(cell => cell.value === EMPTY_SIMPLE_EFFECTS_NOTE))
        ? EMPTY_SIMPLE_EFFECTS_NOTE
        : simpleRows.some(row => row.cells.some(cell => cell.value === NO_REQUESTED_SIMPLE_EFFECTS_NOTE))
          ? NO_REQUESTED_SIMPLE_EFFECTS_NOTE
          : 'Simple effects are computed within each subgroup fit.',
    ],
    testName: 'lmm_simple_effects_report',
  })

  tables.push({
    title: 'Stratified Fit Diagnostics',
    columns: [
      ...stratifyColumns.map((column) => ({ key: column, header: column, align: 'left' as const, width: 14 })),
      { key: 'converged', header: 'Converged', align: 'right', width: 10 },
      { key: 'singular', header: 'Singular Fit', align: 'right', width: 12 },
      { key: 'finite_df', header: 'Finite DF Applied', align: 'right', width: 16 },
      { key: 'fallback', header: 'Fallback Reason', align: 'left', width: 42 },
      { key: 'error', header: 'Error', align: 'left', width: 42 },
    ],
    rows: diagnosticsRows,
    testName: 'lmm_diagnostics',
  })

  return {
    testType: 'lmm_anova',
    testFamily: 'parametric',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      posthocAdjustment: formatPosthocAdjustment(
        result.adjustment_method,
        result.posthoc_q,
        options.decimalPlaces
      ),
      counts: [{ label: 'Strata', value: strataResults.length }],
    },
  }
}
