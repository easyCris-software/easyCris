/**
 * Mediation ECP-Style Table Builder
 *
 * Maps validated Python JSON output from mediation.mediation_model4 to ECP-Style tables.
 * Produces tables matching the macro-style output format.
 *
 * JSON field mapping:
 * - model_info: outcome, predictor, mediators, sample_size, n_bootstrap
 * - outcome_models[M/Y]: r_squared, f_statistic, coefficients[]
 * - effects.direct: effect, se, t, p, ci_lower, ci_upper, boot_ci_*
 * - effects.indirect[]: mediator, effect, boot_se, boot_ci_lower, boot_ci_upper, significant
 * - effects.total: effect, se, t, p, ci_lower, ci_upper
 * - proportions: indirect_over_total, percent_mediated, boot_ci_*
 * - sobel_test: effect, se, z, p
 */

import type {
  ECPTable,
  ECPTableCollection,
  ECPRow,
  TableBuilderOptions,
} from '../../types/ecpStyleTables';
import { formatNumber, formatPValue } from './index';

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

/**
 * Build ECP-Style tables for Mediation (Model 4) results
 */
export function buildMediationTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];
  const modelInfo = result.model_info as {
    mediator_link?: string;
    outcome_link?: string;
    predictor?: string;
    mediators?: string[];
    outcome?: string;
  } | undefined;
  const isLogitLink = modelInfo?.mediator_link === 'logit' || modelInfo?.outcome_link === 'logit';

  // Table 1: Model Info
  if (result.model_info) {
    tables.push(buildModelInfoTable(result, options));
  }

  // Table 2: Outcome Model for M (mediator)
  if (result.outcome_models) {
    const outcomeModels = result.outcome_models as Record<string, unknown>;
    for (const [modelName, modelData] of Object.entries(outcomeModels)) {
      tables.push(buildOutcomeModelTable(modelName, modelData as Record<string, unknown>, options, modelInfo));
    }
  }

  // Table 3: Direct and Indirect Effects
  if (result.effects) {
    tables.push(buildEffectsTable(result, options));
  }

  // Table 4: Effect Proportions
  if (result.proportions && !isLogitLink) {
    tables.push(buildProportionsTable(result, options));
  }

  // Table 5: Sobel Test
  if (result.sobel_test) {
    tables.push(buildSobelTestTable(result, options));
  }

  return {
    testType: 'mediation_model4',
    testFamily: 'mediation',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize: (result.model_info as Record<string, number>)?.sample_size,
    },
  };
}

/**
 * Model Info Table
 */
function buildModelInfoTable(
  result: Record<string, unknown>,
  _options: Required<TableBuilderOptions>
): ECPTable {
  const rows: ECPRow[] = [];
  const modelInfo = result.model_info as {
    outcome: string;
    predictor: string;
    mediators: string[];
    sample_size: number;
    n_bootstrap: number;
    confidence_level?: number;
    seed?: number;
  };

  // Header row
  rows.push({
    cells: [
      { value: 'Variable', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'left' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Model info rows
  rows.push({
    cells: [
      { value: 'Outcome Variable (Y)', align: 'left' },
      { value: modelInfo.outcome || 'Y', align: 'left' },
    ],
  });

  rows.push({
    cells: [
      { value: 'Predictor Variable (X)', align: 'left' },
      { value: modelInfo.predictor || 'X', align: 'left' },
    ],
  });

  rows.push({
    cells: [
      { value: 'Mediator(s) (M)', align: 'left' },
      { value: modelInfo.mediators?.join(', ') || 'M', align: 'left' },
    ],
  });

  rows.push({
    cells: [
      { value: 'Sample Size', align: 'left' },
      { value: modelInfo.sample_size, format: 'integer', align: 'left', attrs: { 'data-stat': 'n' } },
    ],
  });

  rows.push({
    cells: [
      { value: 'Bootstrap Samples', align: 'left' },
      { value: modelInfo.n_bootstrap, format: 'integer', align: 'left', attrs: { 'data-stat': 'n_boot' } },
    ],
  });

  if (modelInfo.confidence_level !== undefined) {
    rows.push({
      cells: [
        { value: 'Confidence Interval', align: 'left' },
        { value: `${(modelInfo.confidence_level * 100).toFixed(0)}%`, align: 'left' },
      ],
    });
  }

  if (modelInfo.seed !== undefined && modelInfo.seed !== null) {
    rows.push({
      cells: [
        { value: 'Random Seed', align: 'left' },
        { value: modelInfo.seed, format: 'integer', align: 'left', attrs: { 'data-stat': 'seed' } },
      ],
    });
  }

  return {
    title: 'Model 4 (Mediation)',
    columns: [
      { key: 'variable', header: 'Variable', align: 'left', width: 24 },
      { key: 'value', header: 'Value', align: 'left', width: 30 },
    ],
    rows,
    testName: 'mediation_model_info',
  };
}

/**
 * Outcome Model Table (for M or Y)
 */
function buildOutcomeModelTable(
  modelName: string,
  modelData: Record<string, unknown>,
  options: Required<TableBuilderOptions>,
  modelInfo?: {
    predictor?: string;
    mediators?: string[];
    outcome?: string;
  }
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const modelType = (modelData.model_type as string | undefined) ?? 'ols';
  const statLabel = modelType === 'logistic' ? 'z' : 't';
  const predictorName = normalizeParamName(modelInfo?.predictor) || 'x';
  const mediatorNames = (modelInfo?.mediators ?? []).map(normalizeParamName).filter(Boolean);
  const primaryMediator = mediatorNames[0] || 'm';
  const outcomeName = normalizeParamName(modelInfo?.outcome) || 'y';
  const modelNameLower = normalizeParamName(modelName);
  const isMediatorModel = mediatorNames.includes(modelNameLower) || modelNameLower === 'm' || modelNameLower.includes('mediator');
  const isOutcomeModel = modelNameLower === outcomeName || modelNameLower === 'y' || modelNameLower.includes('outcome');

  // Model summary section
  rows.push({
    cells: [
      { value: 'Model Summary', isHeader: true, colSpan: 7, align: 'left', isBold: true },
    ],
    isSubheader: true,
  });

  // R-sq row
  const rSquared = modelData.r_squared as number;
  const fStat = modelData.f_statistic as number;
  const fP = modelData.f_p_value as number;

  rows.push({
    cells: [
      { value: `R-sq = ${formatNumber(rSquared, d)}`, align: 'left' },
      { value: `F = ${formatStatValue(fStat, d)}`, align: 'left' },
      { value: fP !== undefined ? `Pr > F = ${formatPValue(fP, options.pValueThreshold, options.minPValue)}` : '', align: 'left' },
    ],
  });

  rows.push({ cells: [], isSeparator: true });

  // Coefficients header
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

  rows.push({ cells: [], isSeparator: true });

  // Coefficient rows
  const coefficients = modelData.coefficients as Array<{
    parameter: string;
    estimate: number;
    std_error: number;
    t_value: number;
    p_value: number;
    ci_lower: number;
    ci_upper: number;
  }>;

  if (coefficients) {
    for (const coef of coefficients) {
      // Determine data-stat attribute for path coefficients
      let dataStat: string | undefined;
      const paramLower = normalizeParamName(coef.parameter);

      // For mediator model (M/m): look for predictor (X) → assign a_path
      // For outcome model (Y/y): look for mediator (M) → assign b_path, predictor (X) → assign c_prime_path
      if (isMediatorModel) {
        // Mediator model: X coefficient is a_path
        if (paramLower === predictorName) {
          dataStat = 'a_path';
        }
      } else if (isOutcomeModel) {
        // Outcome model: M coefficient is b_path, X coefficient is c_prime_path
        if (paramLower === primaryMediator) {
          dataStat = 'b_path';
        } else if (paramLower === predictorName) {
          dataStat = 'c_prime_path';
        }
      }

      rows.push({
        cells: [
          { value: coef.parameter, align: 'left' },
          { value: formatNumber(coef.estimate, d), align: 'right', ...(dataStat ? { attrs: { 'data-stat': dataStat } } : {}) },
          { value: formatNumber(coef.std_error, d), align: 'right' },
          { value: formatStatValue(coef.t_value, d), align: 'right' },
          { value: formatPValue(coef.p_value, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: coef.p_value < options.alpha },
          { value: formatNumber(coef.ci_lower, d), align: 'right' },
          { value: formatNumber(coef.ci_upper, d), align: 'right' },
        ],
      });
    }
  }

  return {
    title: `Outcome Variable: ${modelName}`,
    columns: [
      { key: 'parameter', header: 'Parameter', align: 'left', width: 16 },
      { key: 'coeff', header: 'Coeff', align: 'right', width: 12, format: 'decimal' },
      { key: 'se', header: 'SE', align: 'right', width: 10, format: 'decimal' },
      { key: 't', header: statLabel, align: 'right', width: 10, format: 'decimal' },
      { key: 'p', header: `Pr > |${statLabel}|`, align: 'right', width: 12, format: 'pvalue' },
      { key: 'llci', header: 'LLCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'ulci', header: 'ULCI', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    testName: `mediation_model_${modelName.toLowerCase()}`,
  };
}

/**
 * Direct and Indirect Effects Table
 */
function buildEffectsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const effects = result.effects as {
    direct: {
      effect: number;
      se: number;
      t: number;
      p: number;
      ci_lower: number;
      ci_upper: number;
      boot_ci_lower?: number;
      boot_ci_upper?: number;
      boot_p?: number;
    };
    indirect: Array<{
      mediator: string;
      effect: number;
      boot_se: number;
      boot_ci_lower: number;
      boot_ci_upper: number;
      significant: boolean;
      boot_p?: number;
    }>;
    total: {
      effect: number;
      se: number;
      t: number;
      p: number;
      ci_lower: number;
      ci_upper: number;
    };
  };

  // Header row
  rows.push({
    cells: [
      { value: 'Effect', isHeader: true, align: 'left' },
      { value: 'Estimate', isHeader: true, align: 'right' },
      { value: 'Boot SE', isHeader: true, align: 'right' },
      { value: 'Boot LLCI', isHeader: true, align: 'right' },
      { value: 'Boot ULCI', isHeader: true, align: 'right' },
      { value: 'p', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Total Effect
  rows.push({
    cells: [
      { value: 'Total Effect (c)', align: 'left' },
      { value: formatNumber(effects.total.effect, d), align: 'right', attrs: { 'data-stat': 'total_effect' } },
      { value: formatNumber(effects.total.se, d), align: 'right', attrs: { 'data-stat': 'total_se' } },
      { value: formatNumber(effects.total.ci_lower, d), align: 'right', attrs: { 'data-stat': 'total_ci_lower' } },
      { value: formatNumber(effects.total.ci_upper, d), align: 'right', attrs: { 'data-stat': 'total_ci_upper' } },
      { value: formatPValue(effects.total.p, options.pValueThreshold, options.minPValue), align: 'right', attrs: { 'data-stat': 'total_p' } },
    ],
  });

  // Direct Effect (ADE)
  const directCiLower = effects.direct.boot_ci_lower ?? effects.direct.ci_lower;
  const directCiUpper = effects.direct.boot_ci_upper ?? effects.direct.ci_upper;
  const directP = effects.direct.boot_p ?? effects.direct.p;

  rows.push({
    cells: [
      { value: "Average Direct Effect (ADE)", align: 'left' },
      { value: formatNumber(effects.direct.effect, d), align: 'right', attrs: { 'data-stat': 'direct_effect' } },
      { value: formatNumber(effects.direct.se, d), align: 'right', attrs: { 'data-stat': 'direct_se' } },
      { value: formatNumber(directCiLower, d), align: 'right', attrs: { 'data-stat': 'direct_ci_lower' } },
      { value: formatNumber(directCiUpper, d), align: 'right', attrs: { 'data-stat': 'direct_ci_upper' } },
      { value: formatPValue(directP, options.pValueThreshold, options.minPValue), align: 'right', attrs: { 'data-stat': 'direct_p' } },
    ],
  });

  // Indirect Effects (ACME, one per mediator)
  for (const indirect of effects.indirect) {
    const indirect_p = indirect.boot_p ?? (indirect.significant ? 0 : 1);

    rows.push({
      cells: [
        { value: `Average Causal Mediation Effect (ACME) via ${indirect.mediator}`, align: 'left' },
        { value: formatNumber(indirect.effect, d), align: 'right', isBold: indirect.significant, attrs: { 'data-stat': 'indirect_effect' } },
        { value: formatNumber(indirect.boot_se, d), align: 'right', attrs: { 'data-stat': 'indirect_boot_se' } },
        { value: formatNumber(indirect.boot_ci_lower, d), align: 'right', attrs: { 'data-stat': 'indirect_ci_lower' } },
        { value: formatNumber(indirect.boot_ci_upper, d), align: 'right', attrs: { 'data-stat': 'indirect_ci_upper' } },
        { value: formatPValue(indirect_p, options.pValueThreshold, options.minPValue), align: 'right', attrs: { 'data-stat': 'indirect_p' } },
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

  footnotes.push('Note: Bootstrap CI not containing zero indicates significant indirect effect.');
  footnotes.push('Bold indicates significant indirect effect.');

  return {
    title: 'ACME and ADE Effects of X on Y',
    columns: [
      { key: 'effect', header: 'Effect', align: 'left', width: 28 },
      { key: 'estimate', header: 'Estimate', align: 'right', width: 12, format: 'decimal' },
      { key: 'boot_se', header: 'Boot SE', align: 'right', width: 12, format: 'decimal' },
      { key: 'boot_llci', header: 'Boot LLCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'boot_ulci', header: 'Boot ULCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'p', header: 'p', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    footnotes,
    testName: 'mediation_effects',
  };
}

/**
 * Effect Proportions Table
 */
function buildProportionsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const proportions = result.proportions as {
    indirect_over_total: number;
    percent_mediated: number;
    boot_ci_lower: number;
    boot_ci_upper: number;
  };

  // Header row
  rows.push({
    cells: [
      { value: 'Proportion', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
      { value: 'Boot LLCI', isHeader: true, align: 'right' },
      { value: 'Boot ULCI', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Indirect over Total
  rows.push({
    cells: [
      { value: 'Indirect / Total (PM)', align: 'left' },
      { value: formatNumber(proportions.indirect_over_total, d), align: 'right', attrs: { 'data-stat': 'prop_mediated' } },
      { value: formatNumber(proportions.boot_ci_lower, d), align: 'right', attrs: { 'data-stat': 'prop_mediated_ci_lower' } },
      { value: formatNumber(proportions.boot_ci_upper, d), align: 'right', attrs: { 'data-stat': 'prop_mediated_ci_upper' } },
    ],
  });

  // Percent Mediated
  rows.push({
    cells: [
      { value: 'Percent Mediated', align: 'left' },
      { value: `${formatNumber(proportions.percent_mediated, 2)}%`, align: 'right', colSpan: 3 },
    ],
  });

  return {
    title: 'Proportion Mediated',
    columns: [
      { key: 'proportion', header: 'Proportion', align: 'left', width: 24 },
      { key: 'value', header: 'Value', align: 'right', width: 12, format: 'decimal' },
      { key: 'boot_llci', header: 'Boot LLCI', align: 'right', width: 12, format: 'decimal' },
      { key: 'boot_ulci', header: 'Boot ULCI', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    testName: 'mediation_proportions',
  };
}

/**
 * Sobel Test Table
 */
function buildSobelTestTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const sobel = result.sobel_test as {
    effect: number;
    se: number;
    z: number;
    p: number;
  };

  // Header row
  rows.push({
    cells: [
      { value: 'Effect', isHeader: true, align: 'right' },
      { value: 'SE', isHeader: true, align: 'right' },
      { value: 'z', isHeader: true, align: 'right' },
      { value: 'Pr > |z|', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Sobel test row
  rows.push({
    cells: [
      { value: formatNumber(sobel.effect, d), align: 'right' },
      { value: formatNumber(sobel.se, d), align: 'right' },
      { value: formatStatValue(sobel.z, d), align: 'right', attrs: { 'data-stat': 'sobel_z' } },
      { value: formatPValue(sobel.p, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: sobel.p < options.alpha, attrs: { 'data-stat': 'sobel_p' } },
    ],
  });

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

  footnotes.push('Note: Bootstrap CIs are preferred over Sobel test.');

  return {
    title: 'Normal Theory Test (Sobel)',
    columns: [
      { key: 'effect', header: 'Effect', align: 'right', width: 12, format: 'decimal' },
      { key: 'se', header: 'SE', align: 'right', width: 12, format: 'decimal' },
      { key: 'z', header: 'z', align: 'right', width: 12, format: 'decimal' },
      { key: 'p', header: 'Pr > |z|', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    footnotes,
    testName: 'mediation_sobel',
  };
}


