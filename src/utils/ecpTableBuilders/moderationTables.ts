/**
 * Moderation ECP-Style Table Builder
 *
 * Maps validated Python JSON output from moderation.simple_moderation to ECP-Style tables.
 * Produces tables matching the macro-style output format (Model 1).
 *
 * JSON field mapping:
 * - model_summary: r_squared, adj_r_squared, f_statistic, f_p_value, mse, df1, df2
 * - coefficients[]: parameter, estimate, se, t, p, ci_lower, ci_upper
 * - interaction: r_squared_change, f_change, f_change_p, f_change_df1, f_change_df2
 * - conditional_effects[]: moderator_value, effect, se, t, p, ci_lower, ci_upper, label
 */

import type {
  ECPTable,
  ECPTableCollection,
  ECPRow,
  TableBuilderOptions,
} from '../../types/ecpStyleTables';
import { formatNumber, formatPValue, formatDF } from './index';

const formatStatValue = (value: unknown, decimals: number): string => {
  if (value === null || value === undefined) {
    return '.';
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return '.';
  }
  if (Math.abs(numeric) >= 1e9) {
    return numeric.toExponential(decimals);
  }
  return formatNumber(numeric, decimals);
};

const normalizeParamName = (value?: string): string =>
  (value ?? '').trim().toLowerCase();

const buildInteractionKey = (predictor: string, moderator: string): string =>
  `${predictor}x${moderator}`;

const isInteractionParam = (
  param: string,
  predictor: string,
  moderator: string
): boolean => {
  if (!param) return false;
  if (param.includes('*') || param.includes(':')) return true;
  if (param === 'interaction' || param === 'int') return true;
  if (!predictor || !moderator) return false;
  const direct = buildInteractionKey(predictor, moderator);
  const reverse = buildInteractionKey(moderator, predictor);
  return param === direct || param === reverse;
};

/**
 * Build ECP-Style tables for Moderation (Model 1) results
 */
export function buildModerationTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Table 1: Model Summary
  if (result.model_summary) {
    tables.push(buildModelSummaryTable(result, options));
  }

  // Table 2: Model Coefficients
  if (result.coefficients) {
    tables.push(buildCoefficientsTable(result, options));
  }

  // Table 3: R² Change Due to Interaction
  if (result.interaction) {
    tables.push(buildInteractionTable(result, options));
  }

  // Table 4: Conditional Effects
  if (result.conditional_effects) {
    tables.push(buildConditionalEffectsTable(result, options));
  }

  return {
    testType: 'moderation_model1',
    testFamily: 'moderation',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
    },
  };
}

/**
 * Build ECP-Style tables for Moderated Mediation (Model 7) results
 */
export function buildModeratedMediationTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  if (result.model_info) {
    tables.push(buildModel7InfoTable(result, options));
  }

  if (result.outcome_models) {
    const outcomeModels = result.outcome_models as Record<string, Record<string, unknown>>;
    const modelInfo = result.model_info as {
      predictor?: string;
      moderator?: string;
      mediator?: string;
      outcome?: string;
    } | undefined;

    const orderedKeys: string[] = [];
    if (modelInfo?.mediator && outcomeModels[modelInfo.mediator]) {
      orderedKeys.push(modelInfo.mediator);
    }
    if (modelInfo?.outcome && outcomeModels[modelInfo.outcome]) {
      orderedKeys.push(modelInfo.outcome);
    }
    if (orderedKeys.length === 0) {
      orderedKeys.push(...Object.keys(outcomeModels));
    }

    for (const key of orderedKeys) {
      const modelData = outcomeModels[key];
      if (!modelData) continue;
      tables.push(buildModel7OutcomeModelTable(key, modelData, options, modelInfo));
    }
  }

  if (result.direct_effect) {
    tables.push(buildModel7DirectEffectTable(result, options));
  }

  if (result.conditional_indirect_effects) {
    tables.push(buildModel7ConditionalIndirectEffectsTable(result, options));
  }

  if (result.total_indirect_effect) {
    tables.push(buildModel7TotalIndirectEffectTable(result, options));
  }

  if (result.pairwise_contrasts) {
    tables.push(buildModel7PairwiseContrastsTable(result, options));
  }

  if (result.index_of_moderated_mediation) {
    tables.push(buildModel7IndexTable(result, options));
  }

  const modelInfo = result.model_info as { sample_size?: number } | undefined;

  return {
    testType: 'moderated_mediation_model7',
    testFamily: 'moderation',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize: modelInfo?.sample_size,
    },
  };
}

function buildModel7InfoTable(
  result: Record<string, unknown>,
  _options: Required<TableBuilderOptions>
): ECPTable {
  const rows: ECPRow[] = [];
  const modelInfo = result.model_info as {
    outcome?: string;
    predictor?: string;
    mediator?: string;
    moderator?: string;
    controls?: string[];
    sample_size?: number;
    n_bootstrap?: number;
    confidence_level?: number;
    seed?: number;
    listwise_deleted?: number;
    outcome_link?: string;
  };

  const encodingSummary = (result.encoding_summary as Array<{
    column: string;
    levels: Array<{ label: string; code: number }>;
    reference_level?: string;
  }>) ?? [];

  rows.push({
    cells: [
      { value: 'Variable', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'left' },
    ],
    isHeader: true,
  });
  rows.push({ cells: [], isSeparator: true });
  rows.push({ cells: [{ value: 'Outcome (Y)' }, { value: modelInfo.outcome ?? 'Y' }] });
  rows.push({ cells: [{ value: 'Predictor (X)' }, { value: modelInfo.predictor ?? 'X' }] });
  rows.push({ cells: [{ value: 'Mediator (M)' }, { value: modelInfo.mediator ?? 'M' }] });
  rows.push({ cells: [{ value: 'Moderator (W)' }, { value: modelInfo.moderator ?? 'W' }] });
  rows.push({
    cells: [
      { value: 'Controls' },
      { value: modelInfo.controls && modelInfo.controls.length > 0 ? modelInfo.controls.join(', ') : 'None' },
    ],
  });
  rows.push({
    cells: [
      { value: 'Sample Size' },
      {
        value: modelInfo.sample_size ?? null,
        format: 'integer',
        attrs: modelInfo.sample_size != null ? { 'data-stat': 'n', 'data-value': String(modelInfo.sample_size) } : undefined,
      },
    ],
  });
  rows.push({
    cells: [
      { value: 'Bootstrap Samples' },
      {
        value: modelInfo.n_bootstrap ?? null,
        format: 'integer',
        attrs: modelInfo.n_bootstrap != null ? { 'data-stat': 'n_boot', 'data-value': String(modelInfo.n_bootstrap) } : undefined,
      },
    ],
  });
  rows.push({
    cells: [
      { value: 'Confidence Level' },
      { value: modelInfo.confidence_level ?? null, format: 'decimal' },
    ],
  });
  const seedValue = modelInfo.seed ?? 'NA';
  rows.push({
    cells: [
      { value: 'Seed' },
      {
        value: seedValue,
        align: 'left',
        format: typeof modelInfo.seed === 'number' ? 'integer' : undefined,
        attrs: typeof modelInfo.seed === 'number' ? { 'data-stat': 'seed', 'data-value': String(modelInfo.seed) } : undefined,
      },
    ],
  });
  if (modelInfo.listwise_deleted !== undefined) {
    rows.push({
      cells: [
        { value: 'Listwise Deleted' },
        { value: modelInfo.listwise_deleted, format: 'integer' },
      ],
    });
  }
  if (modelInfo.outcome_link) {
    rows.push({ cells: [{ value: 'Outcome Link' }, { value: modelInfo.outcome_link }] });
  }

  const footnotes: string[] = [];
  for (const encoding of encodingSummary) {
    const levels = encoding.levels
      .map((level) => `${level.label}=${level.code}`)
      .join(', ');
    const reference = encoding.reference_level ? ` (reference: ${encoding.reference_level})` : '';
    footnotes.push(`${encoding.column} encoding: ${levels}${reference}`);
  }

  return {
    title: 'Model 7 (Moderated Mediation)',
    columns: [
      { key: 'variable', header: 'Variable', align: 'left', width: 22 },
      { key: 'value', header: 'Value', align: 'left', width: 34 },
    ],
    rows,
    footnotes: footnotes.length > 0 ? footnotes : undefined,
    testName: 'moderated_mediation_model_info',
  };
}

function buildModel7OutcomeModelTable(
  modelName: string,
  modelData: Record<string, unknown>,
  options: Required<TableBuilderOptions>,
  modelInfo?: {
    predictor?: string;
    moderator?: string;
    mediator?: string;
    outcome?: string;
  }
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const coefficients = (modelData.coefficients as Array<Record<string, unknown>>) ?? [];
  const modelType = (modelData.model_type as string | undefined) ?? 'ols';
  const statLabel = modelType === 'logistic' ? 'z' : 't';

  rows.push({
    cells: [{ value: 'Model Summary', isHeader: true, colSpan: 7, align: 'left', isBold: true }],
    isSubheader: true,
  });

  const rSquared = modelData.r_squared as number | undefined;
  const adjRSquared = modelData.adj_r_squared as number | null | undefined;
  const fStat = modelData.f_statistic as number | undefined;
  const fP = modelData.f_p_value as number | undefined;
  const df1 = modelData.df1 as number | undefined;
  const df2 = modelData.df2 as number | undefined;

  rows.push({
    cells: [
      { value: `R-sq = ${rSquared !== undefined ? formatNumber(rSquared, d) : 'NA'}`, align: 'left' },
      { value: `Adj R-sq = ${adjRSquared == null ? 'NA' : formatNumber(adjRSquared, d)}`, align: 'left' },
      { value: fStat !== undefined ? `F = ${formatStatValue(fStat, d)}` : 'F = NA', align: 'left' },
      {
        value: fP !== undefined
          ? `Pr > F = ${formatPValue(fP, options.pValueThreshold, options.minPValue)}`
          : 'Pr > F = NA',
        align: 'left',
      },
    ],
  });
  if (df1 !== undefined || df2 !== undefined) {
    rows.push({
      cells: [
        { value: `df1 = ${df1 ?? 'NA'}`, align: 'left' },
        { value: `df2 = ${df2 ?? 'NA'}`, align: 'left' },
      ],
    });
  }

  rows.push({ cells: [], isSeparator: true });

  rows.push({
    cells: [
      { value: 'Parameter', isHeader: true, align: 'left' },
      { value: 'Estimate', isHeader: true, align: 'right' },
      { value: 'SE', isHeader: true, align: 'right' },
      { value: 'Stat', isHeader: true, align: 'right' },
      { value: `Pr > |${statLabel}|`, isHeader: true, align: 'right' },
      { value: 'LLCI', isHeader: true, align: 'right' },
      { value: 'ULCI', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });
  rows.push({ cells: [], isSeparator: true });

  const predictorName = normalizeParamName(modelInfo?.predictor) || 'x';
  const moderatorName = normalizeParamName(modelInfo?.moderator) || 'w';
  const mediatorName = normalizeParamName(modelInfo?.mediator) || 'm';
  const modelNameLower = normalizeParamName(modelName);
  const isMediatorModel = modelNameLower === mediatorName || modelNameLower.includes('mediator');

  for (const coef of coefficients) {
    const estimate = coef.estimate as number | undefined;
    const se = (coef.std_error ?? coef.se) as number | undefined;
    const stat = (coef.t_value ?? coef.t ?? coef.statistic) as number | undefined;
    const p = (coef.p_value ?? coef.p) as number | undefined;
    const ciLower = (coef.ci_lower ?? coef.lower_ci ?? coef.llci) as number | undefined;
    const ciUpper = (coef.ci_upper ?? coef.upper_ci ?? coef.ulci) as number | undefined;

    const paramLower = normalizeParamName(String(coef.parameter ?? ''));
    let dataStat: string | undefined;
    let pStat: string | undefined;
    const interactionTerm = isInteractionParam(paramLower, predictorName, moderatorName);

    if (isMediatorModel) {
      if (interactionTerm) {
        dataStat = 'a3_path';
        pStat = 'a3_p';
      } else if (paramLower === predictorName) {
        dataStat = 'a1_path';
      } else if (paramLower === moderatorName) {
        dataStat = 'a2_path';
      }
    } else {
      if (paramLower === mediatorName) {
        dataStat = 'b_path';
      } else if (paramLower === predictorName) {
        dataStat = 'c_prime';
      }
    }

    rows.push({
      cells: [
        { value: String(coef.parameter ?? ''), align: 'left' },
        { value: estimate !== undefined ? formatNumber(estimate, d) : 'NA', align: 'right', ...(dataStat ? { attrs: { 'data-stat': dataStat } } : {}) },
        { value: se !== undefined ? formatNumber(se, d) : 'NA', align: 'right' },
        { value: stat !== undefined ? formatStatValue(stat, d) : 'NA', align: 'right' },
        {
          value: p !== undefined ? formatPValue(p, options.pValueThreshold, options.minPValue) : 'NA',
          align: 'right',
          isSignificant: p !== undefined ? p < options.alpha : false,
          ...(pStat ? { attrs: { 'data-stat': pStat } } : {}),
        },
        { value: ciLower !== undefined ? formatNumber(ciLower, d) : 'NA', align: 'right' },
        { value: ciUpper !== undefined ? formatNumber(ciUpper, d) : 'NA', align: 'right' },
      ],
    });
  }

  return {
    title: `${modelName} Model Coefficients`,
    columns: [
      { key: 'parameter', header: 'Parameter', align: 'left', width: 18 },
      { key: 'estimate', header: 'Estimate', align: 'right', width: 12, format: 'decimal' },
      { key: 'se', header: 'SE', align: 'right', width: 10, format: 'decimal' },
      { key: 'stat', header: 'Stat', align: 'right', width: 10, format: 'decimal' },
      { key: 'p', header: `Pr > |${statLabel}|`, align: 'right', width: 12, format: 'pvalue' },
      { key: 'llci', header: 'LLCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'ulci', header: 'ULCI', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    testName: `moderated_mediation_${modelName.toLowerCase()}_coefficients`,
  };
}

function buildModel7DirectEffectTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const direct = result.direct_effect as {
    effect?: number;
    se?: number;
    statistic?: number;
    statistic_type?: string;
    p?: number;
    ci_lower?: number;
    ci_upper?: number;
  };
  const statLabel = direct.statistic_type ?? 't';

  const rows: ECPRow[] = [
    {
      cells: [
        { value: 'Effect', isHeader: true, align: 'right' },
        { value: 'SE', isHeader: true, align: 'right' },
        { value: statLabel, isHeader: true, align: 'right' },
        { value: `Pr > |${statLabel}|`, isHeader: true, align: 'right' },
        { value: 'LLCI', isHeader: true, align: 'right' },
        { value: 'ULCI', isHeader: true, align: 'right' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
    {
      cells: [
        { value: direct.effect !== undefined ? formatNumber(direct.effect, d) : 'NA', align: 'right', attrs: { 'data-stat': 'direct_effect' } },
        { value: direct.se !== undefined ? formatNumber(direct.se, d) : 'NA', align: 'right', attrs: { 'data-stat': 'direct_se' } },
        { value: direct.statistic !== undefined ? formatStatValue(direct.statistic, d) : 'NA', align: 'right', attrs: { 'data-stat': 'direct_t' } },
        {
          value: direct.p !== undefined ? formatPValue(direct.p, options.pValueThreshold, options.minPValue) : 'NA',
          align: 'right',
          isSignificant: direct.p !== undefined ? direct.p < options.alpha : false,
          attrs: { 'data-stat': 'direct_p' },
        },
        { value: direct.ci_lower !== undefined ? formatNumber(direct.ci_lower, d) : 'NA', align: 'right', attrs: { 'data-stat': 'direct_ci_lower' } },
        { value: direct.ci_upper !== undefined ? formatNumber(direct.ci_upper, d) : 'NA', align: 'right', attrs: { 'data-stat': 'direct_ci_upper' } },
      ],
    },
  ];

  return {
    title: 'Direct Effect (c\')',
    columns: [
      { key: 'effect', header: 'Effect', align: 'right', width: 12, format: 'decimal' },
      { key: 'se', header: 'SE', align: 'right', width: 10, format: 'decimal' },
      { key: 'stat', header: statLabel, align: 'right', width: 10, format: 'decimal' },
      { key: 'p', header: `Pr > |${statLabel}|`, align: 'right', width: 12, format: 'pvalue' },
      { key: 'llci', header: 'LLCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'ulci', header: 'ULCI', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    testName: 'moderated_mediation_direct_effect',
  };
}

function buildModel7ConditionalIndirectEffectsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const effects = result.conditional_indirect_effects as Array<{
    label?: string;
    moderator_value?: number;
    effect?: number;
    boot_se?: number;
    boot_ci_lower?: number;
    boot_ci_upper?: number;
    p_value?: number;
    significant?: boolean;
  }>;
  const probeInfo = (result.preprocessing as { probe_strategy?: { mean?: number; sd?: number } } | undefined)?.probe_strategy;

  const normalizedLabel = (value?: string): string =>
    (value ?? '').trim().toLowerCase();

  const rows: ECPRow[] = [
    {
      cells: [
        { value: 'W Value', isHeader: true, align: 'left' },
        { value: 'Effect', isHeader: true, align: 'right' },
        { value: 'Boot SE', isHeader: true, align: 'right' },
        { value: 'LLCI', isHeader: true, align: 'right' },
        { value: 'ULCI', isHeader: true, align: 'right' },
        { value: 'Pr > |z|', isHeader: true, align: 'right' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
  ];

  for (let i = 0; i < effects.length; i++) {
    const effect = effects[i]!;
    const label = effect.label
      ? `${effect.label} (${formatNumber(effect.moderator_value ?? 0, 2)})`
      : effect.moderator_value !== undefined
        ? formatNumber(effect.moderator_value, d)
        : 'NA';

    const labelKey = normalizedLabel(effect.label);
    let wLevel: 'low' | 'mean' | 'high' | undefined;
    if (labelKey.includes('mean')) {
      wLevel = 'mean';
    } else if (labelKey.includes('-1') || labelKey.includes('low')) {
      wLevel = 'low';
    } else if (labelKey.includes('+1') || labelKey.includes('high')) {
      wLevel = 'high';
    } else if (effects.length === 2) {
      wLevel = i === 0 ? 'low' : 'high';
    } else if (effects.length >= 3) {
      if (i === 0) {
        wLevel = 'low';
      } else if (i === effects.length - 1) {
        wLevel = 'high';
      } else {
        wLevel = 'mean';
      }
    }

    const effectStat = wLevel === 'low' || wLevel === 'high'
      ? `indirect_${wLevel}_w`
      : undefined;
    const ciPrefix = wLevel === 'low' || wLevel === 'high'
      ? `indirect_${wLevel}`
      : undefined;
    const pStat = wLevel === 'low' || wLevel === 'high'
      ? `indirect_${wLevel}_p`
      : undefined;

    const wStat = wLevel === 'low' ? 'w_low' : wLevel === 'high' ? 'w_high' : undefined;
    const wAttrs = effect.moderator_value !== undefined && wStat
      ? { 'data-stat': wStat, 'data-value': String(effect.moderator_value) }
      : undefined;

    rows.push({
      cells: [
        { value: label, align: 'left', attrs: wAttrs },
        {
          value: effect.effect !== undefined ? formatNumber(effect.effect, d) : 'NA',
          align: 'right',
          ...(effectStat ? { attrs: { 'data-stat': effectStat } } : {}),
        },
        { value: effect.boot_se !== undefined ? formatNumber(effect.boot_se, d) : 'NA', align: 'right' },
        {
          value: effect.boot_ci_lower !== undefined ? formatNumber(effect.boot_ci_lower, d) : 'NA',
          align: 'right',
          ...(ciPrefix ? { attrs: { 'data-stat': `${ciPrefix}_ci_lower` } } : {}),
        },
        {
          value: effect.boot_ci_upper !== undefined ? formatNumber(effect.boot_ci_upper, d) : 'NA',
          align: 'right',
          ...(ciPrefix ? { attrs: { 'data-stat': `${ciPrefix}_ci_upper` } } : {}),
        },
        {
          value: effect.p_value !== undefined ? formatPValue(effect.p_value, options.pValueThreshold, options.minPValue) : 'NA',
          align: 'right',
          isSignificant: effect.p_value !== undefined ? effect.p_value < options.alpha : false,
          ...(pStat ? { attrs: { 'data-stat': pStat } } : {}),
        },
      ],
    });
  }

  if (probeInfo?.mean !== undefined && Number.isFinite(probeInfo.mean)) {
    rows.push({
      cells: [
        { value: 'W Mean', align: 'left' },
        {
          value: formatNumber(probeInfo.mean, d),
          align: 'right',
          colSpan: 5,
          attrs: { 'data-stat': 'w_mean', 'data-value': String(probeInfo.mean) },
        },
      ],
    });
  }

  if (probeInfo?.sd !== undefined && Number.isFinite(probeInfo.sd)) {
    rows.push({
      cells: [
        { value: 'W SD', align: 'left' },
        {
          value: formatNumber(probeInfo.sd, d),
          align: 'right',
          colSpan: 5,
          attrs: { 'data-stat': 'w_sd', 'data-value': String(probeInfo.sd) },
        },
      ],
    });
  }

  // Build footnotes with bootstrap, probe values, and CI info
  const modelInfo = result.model_info as {
    n_bootstrap?: number;
    confidence_level?: number;
    seed?: number;
  };
  const probeValues = effects.map(e => e.moderator_value).filter(v => v !== undefined);
  const footnotes: string[] = [];

  if (modelInfo?.n_bootstrap) {
    footnotes.push(`Bootstrap samples: ${modelInfo.n_bootstrap}`);
  }

  if (probeValues.length > 0) {
    const probeStr = probeValues.map(v => formatNumber(v!, 2)).join(', ');
    footnotes.push(`Probe values: ${probeStr}`);
  }

  if (modelInfo?.confidence_level) {
    const ciPercent = (modelInfo.confidence_level * 100).toFixed(0);
    footnotes.push(`Confidence interval: ${ciPercent}%`);
  }

  if (modelInfo?.seed !== undefined && modelInfo.seed !== null) {
    footnotes.push(`Random seed: ${modelInfo.seed}`);
  }

  return {
    title: 'Conditional Indirect Effects',
    columns: [
      { key: 'w_value', header: 'W Value', align: 'left', width: 20 },
      { key: 'effect', header: 'Effect', align: 'right', width: 12, format: 'decimal' },
      { key: 'boot_se', header: 'Boot SE', align: 'right', width: 12, format: 'decimal' },
      { key: 'llci', header: 'LLCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'ulci', header: 'ULCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'p', header: 'Pr > |z|', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    footnotes: footnotes.length > 0 ? footnotes : undefined,
    testName: 'moderated_mediation_conditional_indirect',
  };
}

function buildModel7TotalIndirectEffectTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const total = result.total_indirect_effect as {
    effect?: number;
    boot_se?: number;
    boot_ci_lower?: number;
    boot_ci_upper?: number;
    significant?: boolean;
  };

  const rows: ECPRow[] = [
    {
      cells: [
        { value: 'Effect', isHeader: true, align: 'right' },
        { value: 'Boot SE', isHeader: true, align: 'right' },
        { value: 'LLCI', isHeader: true, align: 'right' },
        { value: 'ULCI', isHeader: true, align: 'right' },
        { value: 'Sig', isHeader: true, align: 'center' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
    {
      cells: [
        { value: total.effect !== undefined ? formatNumber(total.effect, d) : 'NA', align: 'right' },
        { value: total.boot_se !== undefined ? formatNumber(total.boot_se, d) : 'NA', align: 'right' },
        { value: total.boot_ci_lower !== undefined ? formatNumber(total.boot_ci_lower, d) : 'NA', align: 'right' },
        { value: total.boot_ci_upper !== undefined ? formatNumber(total.boot_ci_upper, d) : 'NA', align: 'right' },
        { value: total.significant ? 'Yes' : 'No', align: 'center' },
      ],
    },
  ];

  // Build footnotes with bootstrap and CI info
  const modelInfo = result.model_info as {
    n_bootstrap?: number;
    confidence_level?: number;
    seed?: number;
  };
  const footnotes: string[] = [];

  if (modelInfo?.n_bootstrap) {
    footnotes.push(`Bootstrap samples: ${modelInfo.n_bootstrap}`);
  }

  if (modelInfo?.confidence_level) {
    const ciPercent = (modelInfo.confidence_level * 100).toFixed(0);
    footnotes.push(`Confidence interval: ${ciPercent}%`);
  }

  if (modelInfo?.seed !== undefined && modelInfo.seed !== null) {
    footnotes.push(`Random seed: ${modelInfo.seed}`);
  }

  return {
    title: 'Total Indirect Effect',
    columns: [
      { key: 'effect', header: 'Effect', align: 'right', width: 12, format: 'decimal' },
      { key: 'boot_se', header: 'Boot SE', align: 'right', width: 12, format: 'decimal' },
      { key: 'llci', header: 'LLCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'ulci', header: 'ULCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'sig', header: 'Sig', align: 'center', width: 6 },
    ],
    rows,
    footnotes: footnotes.length > 0 ? footnotes : undefined,
    testName: 'moderated_mediation_total_indirect',
  };
}

function buildModel7PairwiseContrastsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const contrasts = result.pairwise_contrasts as Array<{
    comparison?: string;
    effect?: number;
    boot_se?: number;
    boot_ci_lower?: number;
    boot_ci_upper?: number;
    significant?: boolean;
  }>;

  const rows: ECPRow[] = [
    {
      cells: [
        { value: 'Comparison', isHeader: true, align: 'left' },
        { value: 'Effect', isHeader: true, align: 'right' },
        { value: 'Boot SE', isHeader: true, align: 'right' },
        { value: 'LLCI', isHeader: true, align: 'right' },
        { value: 'ULCI', isHeader: true, align: 'right' },
        { value: 'Sig', isHeader: true, align: 'center' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
  ];

  for (const contrast of contrasts) {
    rows.push({
      cells: [
        { value: contrast.comparison ?? 'NA', align: 'left' },
        { value: contrast.effect !== undefined ? formatNumber(contrast.effect, d) : 'NA', align: 'right' },
        { value: contrast.boot_se !== undefined ? formatNumber(contrast.boot_se, d) : 'NA', align: 'right' },
        { value: contrast.boot_ci_lower !== undefined ? formatNumber(contrast.boot_ci_lower, d) : 'NA', align: 'right' },
        { value: contrast.boot_ci_upper !== undefined ? formatNumber(contrast.boot_ci_upper, d) : 'NA', align: 'right' },
        { value: contrast.significant ? 'Yes' : 'No', align: 'center' },
      ],
    });
  }

  // Build footnotes with bootstrap and CI info
  const modelInfo = result.model_info as {
    n_bootstrap?: number;
    confidence_level?: number;
    seed?: number;
  };
  const footnotes: string[] = [];

  if (modelInfo?.n_bootstrap) {
    footnotes.push(`Bootstrap samples: ${modelInfo.n_bootstrap}`);
  }

  if (modelInfo?.confidence_level) {
    const ciPercent = (modelInfo.confidence_level * 100).toFixed(0);
    footnotes.push(`Confidence interval: ${ciPercent}%`);
  }

  if (modelInfo?.seed !== undefined && modelInfo.seed !== null) {
    footnotes.push(`Random seed: ${modelInfo.seed}`);
  }

  return {
    title: 'Pairwise Contrasts (Conditional Indirect Effects)',
    columns: [
      { key: 'comparison', header: 'Comparison', align: 'left', width: 26 },
      { key: 'effect', header: 'Effect', align: 'right', width: 12, format: 'decimal' },
      { key: 'boot_se', header: 'Boot SE', align: 'right', width: 12, format: 'decimal' },
      { key: 'llci', header: 'LLCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'ulci', header: 'ULCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'sig', header: 'Sig', align: 'center', width: 6 },
    ],
    rows,
    footnotes: footnotes.length > 0 ? footnotes : undefined,
    testName: 'moderated_mediation_pairwise_contrasts',
  };
}

function buildModel7IndexTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const index = result.index_of_moderated_mediation as {
    index?: number;
    boot_se?: number;
    boot_ci_lower?: number;
    boot_ci_upper?: number;
    significant?: boolean;
  };

  const rows: ECPRow[] = [
    {
      cells: [
        { value: 'Index', isHeader: true, align: 'right' },
        { value: 'Boot SE', isHeader: true, align: 'right' },
        { value: 'LLCI', isHeader: true, align: 'right' },
        { value: 'ULCI', isHeader: true, align: 'right' },
        { value: 'Sig', isHeader: true, align: 'center' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
    {
      cells: [
        { value: index.index !== undefined ? formatNumber(index.index, d) : 'NA', align: 'right', attrs: { 'data-stat': 'index_mod_med' } },
        { value: index.boot_se !== undefined ? formatNumber(index.boot_se, d) : 'NA', align: 'right' },
        { value: index.boot_ci_lower !== undefined ? formatNumber(index.boot_ci_lower, d) : 'NA', align: 'right' },
        { value: index.boot_ci_upper !== undefined ? formatNumber(index.boot_ci_upper, d) : 'NA', align: 'right' },
        { value: index.significant ? 'Yes' : 'No', align: 'center' },
      ],
    },
  ];

  // Build footnotes with bootstrap and CI info
  const modelInfo = result.model_info as {
    n_bootstrap?: number;
    confidence_level?: number;
    seed?: number;
  };
  const footnotes: string[] = [];

  if (modelInfo?.n_bootstrap) {
    footnotes.push(`Bootstrap samples: ${modelInfo.n_bootstrap}`);
  }

  if (modelInfo?.confidence_level) {
    const ciPercent = (modelInfo.confidence_level * 100).toFixed(0);
    footnotes.push(`Confidence interval: ${ciPercent}%`);
  }

  if (modelInfo?.seed !== undefined && modelInfo.seed !== null) {
    footnotes.push(`Random seed: ${modelInfo.seed}`);
  }

  return {
    title: 'Index of Moderated Mediation',
    columns: [
      { key: 'index', header: 'Index', align: 'right', width: 12, format: 'decimal' },
      { key: 'boot_se', header: 'Boot SE', align: 'right', width: 12, format: 'decimal' },
      { key: 'llci', header: 'LLCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'ulci', header: 'ULCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'sig', header: 'Sig', align: 'center', width: 6 },
    ],
    rows,
    footnotes: footnotes.length > 0 ? footnotes : undefined,
    testName: 'moderated_mediation_index',
  };
}

/**
 * Model Summary Table
 */
function buildModelSummaryTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const modelInfo = result.model_info as { sample_size?: number; seed?: number } | undefined;
  const modelSummary = result.model_summary as {
    n?: number;
    r_squared: number;
    adj_r_squared: number | null;
    f_statistic: number;
    f_p_value: number;
    mse: number | null;
    df1?: number;
    df2?: number;
    df_model?: number;
    df_resid?: number;
  };

  // Title row
  rows.push({
    cells: [
      { value: 'Model Summary', isHeader: true, colSpan: 7, align: 'left', isBold: true },
    ],
    isSubheader: true,
  });

  const nValue = modelInfo?.sample_size ?? modelSummary?.n ?? (result as any).n ?? (result as any).sample_size;
  // Always add N row for E2E validation
  rows.push({
    cells: [
      {
        value: nValue !== undefined ? `N = ${nValue}` : 'N = (unknown)',
        align: 'left',
        colSpan: 7,
        attrs: { 'data-stat': 'n', 'data-value': String(nValue ?? 'NaN') },
      },
    ],
    isSubheader: true,
  });

  const seedValue = modelInfo?.seed ?? (result as any).seed ?? (result as any).model_info?.seed;
  // Always add Seed row for E2E validation
  rows.push({
    cells: [
      {
        value: seedValue !== undefined && seedValue !== null ? `Seed = ${seedValue}` : 'Seed = (unknown)',
        align: 'left',
        colSpan: 7,
        attrs: { 'data-stat': 'seed', 'data-value': String(seedValue ?? 'NaN') },
      },
    ],
    isSubheader: true,
  });

  // Stats row format for moderation output
  rows.push({
    cells: [
      { value: 'R', isHeader: true, align: 'right' },
      { value: 'R-sq', isHeader: true, align: 'right' },
      { value: 'MSE', isHeader: true, align: 'right' },
      { value: 'F', isHeader: true, align: 'right' },
      { value: 'df1', isHeader: true, align: 'right' },
      { value: 'df2', isHeader: true, align: 'right' },
      { value: 'Pr > F', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Values row
  const r = Math.sqrt(modelSummary.r_squared);
  const df1 = modelSummary.df1 ?? modelSummary.df_model;
  const df2 = modelSummary.df2 ?? modelSummary.df_resid;
  const mseValue = modelSummary.mse == null ? 'NA' : formatNumber(modelSummary.mse, d);
  rows.push({
    cells: [
      { value: formatNumber(r, d), align: 'right' },
      { value: formatNumber(modelSummary.r_squared, d), align: 'right', attrs: { 'data-stat': 'r_squared' } },
      { value: mseValue, align: 'right' },
      { value: formatStatValue(modelSummary.f_statistic, d), align: 'right', attrs: { 'data-stat': 'f_statistic' } },
      { value: formatDF(df1 ?? null), align: 'right', attrs: { 'data-stat': 'df1' } },
      { value: formatDF(df2 ?? null), align: 'right', attrs: { 'data-stat': 'df2' } },
      { value: formatPValue(modelSummary.f_p_value, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: modelSummary.f_p_value < options.alpha, attrs: { 'data-stat': 'f_pvalue' } },
    ],
  });

  if (modelSummary.adj_r_squared !== null && modelSummary.adj_r_squared !== undefined) {
    rows.push({
      cells: [
        { value: 'Adj R-sq', align: 'left' },
        {
          value: formatNumber(modelSummary.adj_r_squared, d),
          align: 'right',
          colSpan: 6,
          attrs: { 'data-stat': 'adj_r_squared', 'data-value': String(modelSummary.adj_r_squared) },
        },
      ],
    });
  }

  return {
    title: 'Model 1 (Moderation)',
    dependentVar: options.variableName,
    columns: [
      { key: 'r', header: 'R', align: 'right', width: 10, format: 'decimal' },
      { key: 'r_sq', header: 'R-sq', align: 'right', width: 10, format: 'decimal' },
      { key: 'mse', header: 'MSE', align: 'right', width: 12, format: 'decimal' },
      { key: 'f', header: 'F', align: 'right', width: 10, format: 'decimal' },
      { key: 'df1', header: 'df1', align: 'right', width: 6 },
      { key: 'df2', header: 'df2', align: 'right', width: 8 },
      { key: 'p', header: 'Pr > F', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    testName: 'moderation_model_summary',
  };
}

/**
 * Model Coefficients Table
 */
function buildCoefficientsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const modelSummary = result.model_summary as { model_type?: string } | undefined;
  const modelInfo = result.model_info as { predictor?: string; moderator?: string } | undefined;
  const predictorName = normalizeParamName(modelInfo?.predictor) || 'x';
  const moderatorName = normalizeParamName(modelInfo?.moderator) || 'w';
  const coefficients = result.coefficients as Array<{
    parameter: string;
    estimate: number;
    se?: number;
    std_error?: number;
    t?: number;
    t_value?: number;
    p?: number;
    p_value?: number;
    ci_lower: number;
    ci_upper: number;
  }>;

  const modelType = modelSummary?.model_type ?? 'ols';
  const statLabel = modelType === 'logistic' ? 'z' : 't';

  // Header row
  rows.push({
    cells: [
      { value: 'Parameter', isHeader: true, align: 'left' },
      { value: 'Coeff', isHeader: true, align: 'right' },
      { value: 'SE', isHeader: true, align: 'right' },
      { value: statLabel, isHeader: true, align: 'right' },
      { value: `Pr > |${statLabel}|`, isHeader: true, align: 'right' },
      { value: 'LLCI', isHeader: true, align: 'right' },
      { value: 'ULCI', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Coefficient rows
  for (const coef of coefficients) {
    const paramLower = normalizeParamName(coef.parameter);
    const isInteraction = isInteractionParam(paramLower, predictorName, moderatorName);
    const isIntercept = paramLower === 'intercept' || paramLower === 'const';
    const isPredictor = paramLower === predictorName || paramLower === 'x' || paramLower === 'predictor';
    const isModerator = paramLower === moderatorName || paramLower === 'w' || paramLower === 'moderator';
    const se = coef.std_error ?? coef.se;
    const t = coef.t_value ?? coef.t;
    const p = coef.p_value ?? coef.p;

    // Determine data-stat prefix based on parameter type
    let prefix: string | undefined;
    if (isInteraction) {
      prefix = 'interaction';
    } else if (isIntercept) {
      prefix = 'intercept';
    } else if (isPredictor) {
      prefix = 'x';
    } else if (isModerator) {
      prefix = 'w';
    }

    const estimateStat = prefix
      ? (prefix === 'intercept' ? 'intercept' : `${prefix}_coef`)
      : undefined;

    rows.push({
      cells: [
        { value: coef.parameter, align: 'left', isBold: isInteraction },
        { value: formatNumber(coef.estimate, d), align: 'right', ...(estimateStat ? { attrs: { 'data-stat': estimateStat } } : {}) },
        { value: se !== undefined ? formatNumber(se, d) : 'NA', align: 'right', ...(prefix ? { attrs: { 'data-stat': `${prefix}_se` } } : {}) },
        { value: t !== undefined ? formatStatValue(t, d) : 'NA', align: 'right', ...(prefix ? { attrs: { 'data-stat': `${prefix}_t` } } : {}) },
        {
          value: p !== undefined ? formatPValue(p, options.pValueThreshold, options.minPValue) : 'NA',
          align: 'right',
          isSignificant: p !== undefined ? p < options.alpha : false,
          ...(prefix ? { attrs: { 'data-stat': `${prefix}_p` } } : {}),
        },
        { value: formatNumber(coef.ci_lower, d), align: 'right', ...(prefix ? { attrs: { 'data-stat': `${prefix}_ci_lower` } } : {}) },
        { value: formatNumber(coef.ci_upper, d), align: 'right', ...(prefix ? { attrs: { 'data-stat': `${prefix}_ci_upper` } } : {}) },
      ],
    });
  }

  return {
    title: 'Model Coefficients',
    columns: [
      { key: 'parameter', header: 'Parameter', align: 'left', width: 16 },
      { key: 'coeff', header: 'Coeff', align: 'right', width: 12, format: 'decimal' },
      { key: 'se', header: 'SE', align: 'right', width: 10, format: 'decimal' },
      { key: 't', header: 't', align: 'right', width: 10, format: 'decimal' },
      { key: 'p', header: 'Pr > |t|', align: 'right', width: 12, format: 'pvalue' },
      { key: 'llci', header: 'LLCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'ulci', header: 'ULCI', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    footnotes: [
      'Note: Interaction term shown in bold.',
    ],
    testName: 'moderation_coefficients',
  };
}

/**
 * R² Change Due to Interaction Table
 */
function buildInteractionTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const interaction = result.interaction as {
    r_squared_change?: number;
    r2_change?: number;
    f_change?: number;
    f_change_p?: number;
    f_change_df1?: number;
    f_change_df2?: number;
  };
  const r2Change = interaction.r2_change ?? interaction.r_squared_change;

  // Header row
  rows.push({
    cells: [
      { value: 'R2-chng', isHeader: true, align: 'right' },
      { value: 'F', isHeader: true, align: 'right' },
      { value: 'df1', isHeader: true, align: 'right' },
      { value: 'df2', isHeader: true, align: 'right' },
      { value: 'Pr > F', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Values row
  rows.push({
    cells: [
      { value: r2Change !== undefined ? formatNumber(r2Change, d) : 'NA', align: 'right', attrs: { 'data-stat': 'r2_change' } },
      { value: interaction.f_change !== undefined ? formatStatValue(interaction.f_change, d) : 'NA', align: 'right', attrs: { 'data-stat': 'f_change' } },
      { value: formatDF(interaction.f_change_df1 ?? null), align: 'right', attrs: { 'data-stat': 'f_change_df1' } },
      { value: formatDF(interaction.f_change_df2 ?? null), align: 'right', attrs: { 'data-stat': 'f_change_df2' } },
      {
        value: interaction.f_change_p !== undefined
          ? formatPValue(interaction.f_change_p, options.pValueThreshold, options.minPValue)
          : 'NA',
        align: 'right',
        isSignificant: interaction.f_change_p !== undefined ? interaction.f_change_p < options.alpha : false,
        attrs: { 'data-stat': 'f_change_p' },
      },
    ],
  });

  return {
    title: 'R-square increase due to interaction',
    columns: [
      { key: 'r2_chng', header: 'R2-chng', align: 'right', width: 10, format: 'decimal' },
      { key: 'f', header: 'F', align: 'right', width: 10, format: 'decimal' },
      { key: 'df1', header: 'df1', align: 'right', width: 6 },
      { key: 'df2', header: 'df2', align: 'right', width: 8 },
      { key: 'p', header: 'Pr > F', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    footnotes: [
      'Note: Significant p indicates the interaction term improves model fit.',
    ],
    testName: 'moderation_interaction',
  };
}

/**
 * Conditional Effects of X on Y at Values of W Table
 */
function buildConditionalEffectsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const conditionalEffects = result.conditional_effects as Array<{
    moderator_value: number;
    effect: number;
    se: number;
    t: number;
    p: number;
    ci_lower: number;
    ci_upper: number;
    label: string;
    statistic_type?: string;
  }>;
  const probeInfo = (result.preprocessing as { probe_strategy?: { sd?: number } } | undefined)?.probe_strategy;

  const probeStrategy = (result.preprocessing as { probe_strategy?: { source?: string } } | undefined)
    ?.probe_strategy;
  const statLabel = conditionalEffects.length > 0
    ? (conditionalEffects[0]!.statistic_type ?? 't')
    : 't';

  // Header row
  rows.push({
    cells: [
      { value: 'W Value', isHeader: true, align: 'left' },
      { value: 'Effect', isHeader: true, align: 'right' },
      { value: 'SE', isHeader: true, align: 'right' },
      { value: statLabel, isHeader: true, align: 'right' },
      { value: `Pr > |${statLabel}|`, isHeader: true, align: 'right' },
      { value: 'LLCI', isHeader: true, align: 'right' },
      { value: 'ULCI', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Conditional effect rows
  for (let i = 0; i < conditionalEffects.length; i++) {
    const effect = conditionalEffects[i]!;
    const wLabel = effect.label
      ? `${effect.label} (${formatNumber(effect.moderator_value, 2)})`
      : formatNumber(effect.moderator_value, d);

    const labelKey = normalizeParamName(effect.label);
    let wLevel: 'low' | 'mean' | 'high' | undefined;
    if (labelKey.includes('mean')) {
      wLevel = 'mean';
    } else if (labelKey.includes('-1') || labelKey.includes('low')) {
      wLevel = 'low';
    } else if (labelKey.includes('+1') || labelKey.includes('high')) {
      wLevel = 'high';
    } else if (conditionalEffects.length === 2) {
      wLevel = i === 0 ? 'low' : 'high';
    } else if (conditionalEffects.length >= 3) {
      if (i === 0) {
        wLevel = 'low';
      } else if (i === conditionalEffects.length - 1) {
        wLevel = 'high';
      } else {
        wLevel = 'mean';
      }
    }

    const resolvedLevel = wLevel ?? 'mean';
    const prefix = resolvedLevel === 'low'
      ? 'simple_slope_low_w'
      : resolvedLevel === 'mean'
        ? 'simple_slope_mean_w'
        : 'simple_slope_high_w';

    const wStat = resolvedLevel === 'low'
      ? 'w_low'
      : resolvedLevel === 'mean'
        ? 'w_mean'
        : 'w_high';
    const wAttrs = effect.moderator_value !== undefined
      ? { 'data-stat': wStat, 'data-value': String(effect.moderator_value) }
      : undefined;

    rows.push({
      cells: [
        { value: wLabel, align: 'left', attrs: wAttrs },
        { value: formatNumber(effect.effect, d), align: 'right', attrs: { 'data-stat': prefix } },
        { value: formatNumber(effect.se, d), align: 'right', attrs: { 'data-stat': `${prefix}_se` } },
        { value: formatNumber(effect.t, d), align: 'right', attrs: { 'data-stat': `${prefix}_t` } },
        { value: formatPValue(effect.p, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: effect.p < options.alpha, attrs: { 'data-stat': `${prefix}_p` } },
        { value: formatNumber(effect.ci_lower, d), align: 'right', attrs: { 'data-stat': `${prefix}_ci_lower` } },
        { value: formatNumber(effect.ci_upper, d), align: 'right', attrs: { 'data-stat': `${prefix}_ci_upper` } },
      ],
    });
  }

  if (probeInfo?.sd !== undefined && Number.isFinite(probeInfo.sd)) {
    rows.push({
      cells: [
        { value: 'W SD', align: 'left' },
        {
          value: formatNumber(probeInfo.sd, d),
          align: 'right',
          colSpan: 6,
          attrs: { 'data-stat': 'w_sd', 'data-value': String(probeInfo.sd) },
        },
      ],
    });
  }

  // Build footnotes with probe values and CI info
  const modelSummary = result.model_summary as { confidence_level?: number };
  const probeValues = conditionalEffects.map(e => e.moderator_value);
  const footnotes: string[] = [];

  if (probeValues.length > 0) {
    const probeStr = probeValues.map(v => formatNumber(v, 2)).join(', ');
    footnotes.push(`Probe values: ${probeStr}`);
  }

  if (modelSummary?.confidence_level) {
    const ciPercent = (modelSummary.confidence_level * 100).toFixed(0);
    footnotes.push(`Confidence interval: ${ciPercent}%`);
  }

  if (probeStrategy?.source === 'custom') {
    footnotes.push('Note: Custom probe values were supplied for W.');
  } else {
    footnotes.push('Note: Values of W shown are mean and +/- 1 SD from mean.');
  }
  footnotes.push('Significant p indicates the effect of X on Y is significant at that level of W.');

  return {
    title: 'Conditional Effects of X on Y at Values of W',
    columns: [
      { key: 'w_value', header: 'W Value', align: 'left', width: 18 },
      { key: 'effect', header: 'Effect', align: 'right', width: 12, format: 'decimal' },
      { key: 'se', header: 'SE', align: 'right', width: 10, format: 'decimal' },
      { key: 't', header: 't', align: 'right', width: 10, format: 'decimal' },
      { key: 'p', header: 'Pr > |t|', align: 'right', width: 12, format: 'pvalue' },
      { key: 'llci', header: 'LLCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'ulci', header: 'ULCI', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    footnotes,
    testName: 'moderation_conditional_effects',
  };
}

