/**
 * Pharmacology ECP-Style Table Builder
 *
 * Maps validated Python JSON output to ECP-Style tables:
 * - Dose-Response (3PL, 4PL, 5PL, Compare) from dose_response module
 * - Synergy Analysis (Bliss, HSA, Loewe, ZIP, All) from drug_combo module
 */

import type {
  ECPTable,
  ECPTableCollection,
  ECPRow,
  TableBuilderOptions,
} from '../../types/ecpStyleTables';
import { formatNumber } from './index';

// =============================================================================
// DATA-STAT KEY HELPERS (for E2E validation)
// =============================================================================

/**
 * Generate a data-stat key with optional model prefix
 * @param key - The base key (e.g., 'ic50', 'r_squared')
 * @param prefix - Optional model prefix (e.g., '3pl', '4pl', 'hsa', 'bliss')
 * @returns Prefixed key if prefix provided, otherwise just the key
 */
function dataStatKey(key: string, prefix?: string): string {
  if (!prefix) return key;
  return `${prefix.toLowerCase()}_${key}`;
}

function normalizeDoseResponseModelType(value: string): string {
  const upper = value.toUpperCase();
  if (upper.startsWith('3PL')) return '3PL';
  if (upper.startsWith('4PL')) return '4PL';
  if (upper.startsWith('5PL')) return '5PL';
  if (upper.includes('DOSE_RESPONSE_3PL')) return '3PL';
  if (upper.includes('DOSE_RESPONSE_4PL')) return '4PL';
  if (upper.includes('DOSE_RESPONSE_5PL')) return '5PL';
  return value.replace(/_DRC.*$/i, '').replace(/_SCALED$/i, '');
}

// =============================================================================
// DOSE-RESPONSE
// =============================================================================

/**
 * Build ECP-Style tables for Dose-Response results
 */
export function buildDoseResponseTables(
  result: Record<string, unknown>,
  testType: string,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Check if this is a model comparison result
  if (testType === 'dose_response_compare' && result.comparison) {
    // Model Comparison tables
    tables.push(buildModelComparisonTable(result, options));

    // Add unprefixed metadata table for n_observations (baseline expects it unprefixed)
    const compareMetadataTable = buildDoseResponseMetadataTable(result, options);
    if (compareMetadataTable) {
      tables.push(compareMetadataTable);
    }

    // Individual model parameter tables (with model prefix for data-stat)
    const models = result.models as Record<string, unknown> | undefined;
    if (models) {
      for (const [modelName, modelResult] of Object.entries(models)) {
        if (!modelResult || typeof modelResult !== 'object') continue;

        const modelObj = modelResult as Record<string, unknown>;
        const title = modelName.toUpperCase();
        // Model prefix for data-stat keys (e.g., "3PL" -> "3pl")
        const modelPrefix = modelName.toLowerCase().replace('-', '');

        if (modelObj.success !== true || !modelObj.parameters) {
          const reason =
            (modelObj.reason as string | undefined) ||
            (modelObj.error as string | undefined) ||
            'Model was not fitted.';
          tables.push(buildModelNotFittedTable(title, reason));
          continue;
        }

        tables.push(buildDoseResponseParametersTable(modelObj, title, options, modelPrefix));
        if (modelObj.goodness_of_fit) {
          tables.push(buildGoodnessOfFitTable(modelObj, options, modelPrefix));
        }
        const ciBandTable = buildConfidenceBandTable(modelObj, options, modelPrefix);
        if (ciBandTable) {
          tables.push(ciBandTable);
        }
        const metadataTable = buildDoseResponseMetadataTable(modelObj, options, modelPrefix);
        if (metadataTable) {
          tables.push(metadataTable);
        }
        const fitSeriesTable = buildDoseResponseFitSeriesTable(modelObj, options);
        if (fitSeriesTable) {
          tables.push(fitSeriesTable);
        }
      }
    }
  } else {
    // Single model tables (no prefix)
    // Table 1: Model Parameters
    tables.push(buildDoseResponseParametersTable(result, testType, options));

    // Table 2: Goodness of Fit
    if (result.goodness_of_fit) {
      tables.push(buildGoodnessOfFitTable(result, options));
    }
    const ciBandTable = buildConfidenceBandTable(result, options);
    if (ciBandTable) {
      tables.push(ciBandTable);
    }
    const metadataTable = buildDoseResponseMetadataTable(result, options);
    if (metadataTable) {
      tables.push(metadataTable);
    }
    const fitSeriesTable = buildDoseResponseFitSeriesTable(result, options);
    if (fitSeriesTable) {
      tables.push(fitSeriesTable);
    }
  }

  // Table: Warnings (if any)
  const warnings = result.warnings as string[] | undefined;
  if (warnings && warnings.length > 0) {
    tables.push(buildWarningsTable(warnings, 'Dose-Response'));
  }

  return {
    testType,
    testFamily: 'pharmacology',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
    },
  };
}

/**
 * Build Model Comparison table for dose_response_compare
 */
function buildModelComparisonTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  const comparison = result.comparison as {
    aic_ranking?: Array<{ model: string; aic: number; delta_aic: number }>;
    bic_ranking?: Array<{ model: string; bic: number; delta_bic: number }>;
    recommended_model?: string;
    recommendation_reason?: string;
    // Legacy fallback (older format)
    models?: Array<{
      model: string;
      aic: number;
      bic: number;
      delta_aic?: number;
      delta_bic?: number;
      recommended?: boolean;
    }>;
    best_model?: string;
  };

  // Header row
  rows.push({
    cells: [
      { value: 'Model', isHeader: true, align: 'left' },
      { value: 'AIC', isHeader: true, align: 'right' },
      { value: 'ΔAIC', isHeader: true, align: 'right' },
      { value: 'BIC', isHeader: true, align: 'right' },
      { value: 'ΔBIC', isHeader: true, align: 'right' },
      { value: 'Recommendation', isHeader: true, align: 'center' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  const recommendedModel = comparison.recommended_model ?? comparison.best_model;

  const byModel: Record<
    string,
    { aic?: number; deltaAic?: number; bic?: number; deltaBic?: number }
  > = {};

  if (comparison.aic_ranking && Array.isArray(comparison.aic_ranking)) {
    for (const item of comparison.aic_ranking) {
      byModel[item.model] = {
        ...(byModel[item.model] ?? {}),
        aic: item.aic,
        deltaAic: item.delta_aic,
      };
    }
  }

  if (comparison.bic_ranking && Array.isArray(comparison.bic_ranking)) {
    for (const item of comparison.bic_ranking) {
      byModel[item.model] = {
        ...(byModel[item.model] ?? {}),
        bic: item.bic,
        deltaBic: item.delta_bic,
      };
    }
  }

  // Legacy: flatten comparison.models into the map when present
  if (comparison.models && Array.isArray(comparison.models)) {
    const aicValues = comparison.models.map(m => m.aic);
    const bicValues = comparison.models.map(m => m.bic);
    const minAIC = Math.min(...aicValues);
    const minBIC = Math.min(...bicValues);

    for (const model of comparison.models) {
      byModel[model.model] = {
        ...(byModel[model.model] ?? {}),
        aic: model.aic,
        deltaAic: model.delta_aic ?? (model.aic - minAIC),
        bic: model.bic,
        deltaBic: model.delta_bic ?? (model.bic - minBIC),
      };
    }
  }

  for (const modelName of Object.keys(byModel)) {
    const m = byModel[modelName] ?? {};
    // Model prefix for data-stat keys (e.g., "3PL" -> "3pl")
    const modelKey = modelName.toLowerCase().replace('-', '');
    rows.push({
      cells: [
        { value: modelName, align: 'left' },
        { value: m.aic !== undefined ? formatNumber(m.aic, d) : '.', align: 'right', attrs: m.aic !== undefined ? { 'data-stat': `${modelKey}_aic` } : undefined },
        { value: m.deltaAic !== undefined ? formatNumber(m.deltaAic, d) : '.', align: 'right', attrs: m.deltaAic !== undefined ? { 'data-stat': `${modelKey}_delta_aic` } : undefined },
        { value: m.bic !== undefined ? formatNumber(m.bic, d) : '.', align: 'right', attrs: m.bic !== undefined ? { 'data-stat': `${modelKey}_bic` } : undefined },
        { value: m.deltaBic !== undefined ? formatNumber(m.deltaBic, d) : '.', align: 'right', attrs: m.deltaBic !== undefined ? { 'data-stat': `${modelKey}_delta_bic` } : undefined },
        { value: recommendedModel && modelName === recommendedModel ? '← Best' : '', align: 'center', attrs: recommendedModel && modelName === recommendedModel ? { 'data-stat': 'recommended_model' } : undefined },
      ],
    });
  }

  // Add recommendation note if available
  const footnotes: string[] = [];
  if (comparison.recommendation_reason) {
    footnotes.push(comparison.recommendation_reason);
  }
  footnotes.push('Lower AIC/BIC indicates better model fit. ΔAIC/ΔBIC shows difference from best model.');

  return {
    title: 'Model Comparison',
    procedure: 'Dose-Response Model Selection',
    columns: [
      { key: 'model', header: 'Model', align: 'left', width: 10 },
      { key: 'aic', header: 'AIC', align: 'right', width: 12, format: 'decimal' },
      { key: 'delta_aic', header: 'ΔAIC', align: 'right', width: 10, format: 'decimal' },
      { key: 'bic', header: 'BIC', align: 'right', width: 12, format: 'decimal' },
      { key: 'delta_bic', header: 'ΔBIC', align: 'right', width: 10, format: 'decimal' },
      { key: 'recommendation', header: 'Recommendation', align: 'center', width: 14 },
    ],
    rows,
    footnotes,
    testName: 'model_comparison',
  };
}

function buildModelNotFittedTable(modelName: string, reason: string): ECPTable {
  const rows: ECPRow[] = [];

  rows.push({
    cells: [
      { value: 'Field', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'left' },
    ],
    isHeader: true,
  });
  rows.push({ cells: [], isSeparator: true });
  rows.push({
    cells: [
      { value: 'Status', align: 'left' },
      { value: 'Not fitted', align: 'left' },
    ],
  });
  rows.push({
    cells: [
      { value: 'Reason', align: 'left' },
      { value: reason || 'Model was not fitted.', align: 'left' },
    ],
  });

  return {
    title: `${modelName} Model Status`,
    procedure: 'Dose-Response Analysis',
    columns: [
      { key: 'field', header: 'Field', align: 'left', width: 16 },
      { key: 'value', header: 'Value', align: 'left', width: 60 },
    ],
    rows,
    testName: 'dose_response_not_fitted',
  };
}

function buildDoseResponseParametersTable(
  result: Record<string, unknown>,
  testType: string,
  options: Required<TableBuilderOptions>,
  modelPrefix?: string
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const modelTypeRaw = result.model_type as string | undefined;
  const modelType = normalizeDoseResponseModelType(modelTypeRaw ?? testType);

  const parameters = result.parameters as {
    ic50?: { value: number; stderr: number | null; ci_lower?: number; ci_upper?: number };
    hill?: { value: number; stderr: number | null; ci_lower?: number; ci_upper?: number };
    top?: { value: number; stderr: number | null; ci_lower?: number; ci_upper?: number };
    bottom?: { value: number; stderr: number | null; ci_lower?: number; ci_upper?: number };
    asymmetry?: { value: number; stderr: number | null; ci_lower?: number; ci_upper?: number };
    neg_log10_ic50?: { value: number; stderr: number | null; ci_lower?: number; ci_upper?: number };
  };

  // Header row
  rows.push({
    cells: [
      { value: 'Parameter', isHeader: true, align: 'left' },
      { value: 'Estimate', isHeader: true, align: 'right' },
      { value: 'Std Error', isHeader: true, align: 'right' },
      { value: '95% CL Lower', isHeader: true, align: 'right' },
      { value: '95% CL Upper', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Parameter rows - order matters for readability
  const paramOrder = ['bottom', 'top', 'ic50', 'neg_log10_ic50', 'hill', 'asymmetry'];
  const paramLabels: Record<string, string> = {
    bottom: 'Bottom',
    top: 'Top',
    ic50: 'IC50 / EC50',
    neg_log10_ic50: 'pIC50 (-log₁₀IC50)',
    hill: 'Hill Slope',
    asymmetry: 'Asymmetry (S)',
  };

  // Map Python param names to baseline names (for data-stat)
  const paramStatNames: Record<string, string> = {
    bottom: 'bottom',
    top: 'top',
    ic50: 'ic50',
    neg_log10_ic50: 'neg_log10_ic50',
    hill: 'hill_slope',
    asymmetry: 'asymmetry',
  };

  for (const paramName of paramOrder) {
    const param = parameters[paramName as keyof typeof parameters];
    if (param) {
      // Check if parameter is fixed (stderr is null)
      const isFixed = param.stderr === null;
      const stderrDisplay = isFixed ? 'Fixed' : formatNumber(param.stderr, d);
      const statName = paramStatNames[paramName] || paramName;

      rows.push({
        cells: [
          { value: paramLabels[paramName] || paramName, align: 'left' },
          { value: formatNumber(param.value, d), align: 'right', attrs: { 'data-stat': dataStatKey(statName, modelPrefix) } },
          { value: stderrDisplay, align: 'right', attrs: isFixed ? undefined : { 'data-stat': dataStatKey(`${statName}_se`, modelPrefix) } },
          { value: param.ci_lower !== undefined && !isFixed ? formatNumber(param.ci_lower, d) : '.', align: 'right', attrs: param.ci_lower !== undefined && !isFixed ? { 'data-stat': dataStatKey(`${statName}_ci_lower`, modelPrefix) } : undefined },
          { value: param.ci_upper !== undefined && !isFixed ? formatNumber(param.ci_upper, d) : '.', align: 'right', attrs: param.ci_upper !== undefined && !isFixed ? { 'data-stat': dataStatKey(`${statName}_ci_upper`, modelPrefix) } : undefined },
        ],
      });
    }
  }

  return {
    title: `${modelType} Model Parameters`,
    procedure: 'Dose-Response Analysis',
    columns: [
      { key: 'parameter', header: 'Parameter', align: 'left', width: 20 },
      { key: 'estimate', header: 'Estimate', align: 'right', width: 14, format: 'decimal' },
      { key: 'stderr', header: 'Std Error', align: 'right', width: 12, format: 'decimal' },
      { key: 'ci_lower', header: '95% CL Lower', align: 'right', width: 14, format: 'decimal' },
      { key: 'ci_upper', header: '95% CL Upper', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'dose_response_parameters',
  };
}

function buildDoseResponseMetadataTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>,
  modelPrefix?: string
): ECPTable | null {
  const d = options.decimalPlaces;
  const metadata = result.metadata as Record<string, unknown> | undefined;
  const nObservations = result.n_observations as number | undefined;
  const residualSS = (result.goodness_of_fit as { residual_ss?: number } | undefined)?.residual_ss ??
    (result.residual_ss as number | undefined);

  if (!metadata && nObservations === undefined && residualSS === undefined) {
    return null;
  }

  const rows: ECPRow[] = [];
  rows.push({
    cells: [
      { value: 'Field', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });
  rows.push({ cells: [], isSeparator: true });

  if (nObservations !== undefined) {
    rows.push({
      cells: [
        { value: 'Observations (N)', align: 'left' },
        { value: nObservations.toString(), align: 'right', attrs: { 'data-stat': dataStatKey('n_observations', modelPrefix) } },
      ],
    });
  }

  if (residualSS !== undefined) {
    rows.push({
      cells: [
        { value: 'Residual SS', align: 'left' },
        { value: formatNumber(residualSS, d), align: 'right', attrs: { 'data-stat': dataStatKey('ss_residual', modelPrefix) } },
      ],
    });
  }

  // Optional control metadata (Python/UI only - NOT in baseline)
  if (metadata) {
    const doseZeroHandling = metadata.dose_zero_handling as string | undefined;
    const nControls = metadata.n_controls as number | undefined;
    const nPositive = metadata.n_positive_doses as number | undefined;
    const controlMean = metadata.control_mean as number | undefined;
    const controlSd = metadata.control_sd as number | undefined;

    if (doseZeroHandling) {
      rows.push({
        cells: [
          { value: 'Dose=0 Handling', align: 'left' },
          { value: doseZeroHandling, align: 'right', attrs: { 'data-stat': dataStatKey('dose_zero_handling', modelPrefix) } },
        ],
      });
    }
    if (nControls !== undefined) {
      rows.push({
        cells: [
          { value: 'Control Count', align: 'left' },
          { value: nControls.toString(), align: 'right', attrs: { 'data-stat': dataStatKey('n_controls', modelPrefix) } },
        ],
      });
    }
    if (nPositive !== undefined) {
      rows.push({
        cells: [
          { value: 'Positive Dose Count', align: 'left' },
          { value: nPositive.toString(), align: 'right', attrs: { 'data-stat': dataStatKey('n_positive_doses', modelPrefix) } },
        ],
      });
    }
    if (controlMean !== undefined) {
      rows.push({
        cells: [
          { value: 'Control Mean', align: 'left' },
          { value: formatNumber(controlMean, d), align: 'right', attrs: { 'data-stat': dataStatKey('control_mean', modelPrefix) } },
        ],
      });
    }
    if (controlSd !== undefined) {
      rows.push({
        cells: [
          { value: 'Control SD', align: 'left' },
          { value: formatNumber(controlSd, d), align: 'right', attrs: { 'data-stat': dataStatKey('control_sd', modelPrefix) } },
        ],
      });
    }
  }

  return {
    title: 'Fit Metadata',
    procedure: 'Dose-Response Analysis',
    columns: [
      { key: 'field', header: 'Field', align: 'left', width: 24 },
      { key: 'value', header: 'Value', align: 'right', width: 20 },
    ],
    rows,
    testName: 'dose_response_metadata',
  };
}

function buildDoseResponseFitSeriesTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable | null {
  const d = options.decimalPlaces;
  const fittedValues = result.fitted_values as number[] | undefined;
  const residuals = result.residuals as number[] | undefined;

  const length = Math.max(fittedValues?.length ?? 0, residuals?.length ?? 0);
  if (length === 0) {
    return null;
  }

  const rows: ECPRow[] = [];
  rows.push({
    cells: [
      { value: '#', isHeader: true, align: 'right' },
      { value: 'Fitted', isHeader: true, align: 'right' },
      { value: 'Residual', isHeader: true, align: 'right' },
      { value: 'Observed', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });
  rows.push({ cells: [], isSeparator: true });

  for (let i = 0; i < length; i++) {
    const fitted = fittedValues?.[i];
    const residual = residuals?.[i];
    const observed =
      typeof fitted === 'number' && typeof residual === 'number'
        ? fitted + residual
        : undefined;
    rows.push({
      cells: [
        { value: (i + 1).toString(), align: 'right' },
        { value: formatNumber(fitted, d), align: 'right' },
        { value: formatNumber(residual, d), align: 'right' },
        { value: formatNumber(observed, d), align: 'right' },
      ],
    });
  }

  return {
    title: 'Fitted Values and Residuals',
    procedure: 'Dose-Response Analysis',
    columns: [
      { key: 'index', header: '#', align: 'right', width: 6 },
      { key: 'fitted', header: 'Fitted', align: 'right', width: 12, format: 'decimal' },
      { key: 'residual', header: 'Residual', align: 'right', width: 12, format: 'decimal' },
      { key: 'observed', header: 'Observed', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    footnotes: ['Observed values are reconstructed as fitted + residual.'],
    testName: 'dose_response_fit_series',
  };
}

function buildGoodnessOfFitTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>,
  modelPrefix?: string
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const gof = result.goodness_of_fit as {
    r_squared: number;
    adj_r_squared: number;
    rmse: number;
    aic: number;
    bic: number;
  };

  // Header row
  rows.push({
    cells: [
      { value: 'Measure', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // R-squared
  rows.push({
    cells: [
      { value: 'R-squared', align: 'left' },
      { value: formatNumber(gof.r_squared, d), align: 'right', attrs: { 'data-stat': dataStatKey('r_squared', modelPrefix) } },
    ],
  });

  // Adjusted R-squared (not in baseline, optional)
  rows.push({
    cells: [
      { value: 'Adjusted R²', align: 'left' },
      { value: formatNumber(gof.adj_r_squared, d), align: 'right', attrs: { 'data-stat': dataStatKey('adj_r_squared', modelPrefix) } },
    ],
  });

  // RMSE
  rows.push({
    cells: [
      { value: 'RMSE', align: 'left' },
      { value: formatNumber(gof.rmse, d), align: 'right', attrs: { 'data-stat': dataStatKey('rmse', modelPrefix) } },
    ],
  });

  // AIC
  rows.push({
    cells: [
      { value: 'AIC', align: 'left' },
      { value: formatNumber(gof.aic, d), align: 'right', attrs: { 'data-stat': dataStatKey('aic', modelPrefix) } },
    ],
  });

  // BIC
  rows.push({
    cells: [
      { value: 'BIC', align: 'left' },
      { value: formatNumber(gof.bic, d), align: 'right', attrs: { 'data-stat': dataStatKey('bic', modelPrefix) } },
    ],
  });

  return {
    title: 'Goodness of Fit Statistics',
    columns: [
      { key: 'measure', header: 'Measure', align: 'left', width: 18 },
      { key: 'value', header: 'Value', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'dose_response_gof',
  };
}

function buildConfidenceBandTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>,
  modelPrefix?: string
): ECPTable | null {
  const d = options.decimalPlaces;
  const points = result.ci_band_points as number | undefined;
  const tcrit = result.ci_band_tcrit as number | undefined;
  const lowerMin = result.ci_band_lower_min as number | undefined;
  const lowerMax = result.ci_band_lower_max as number | undefined;
  const upperMin = result.ci_band_upper_min as number | undefined;
  const upperMax = result.ci_band_upper_max as number | undefined;
  const widthMean = result.ci_band_width_mean as number | undefined;
  const widthMax = result.ci_band_width_max as number | undefined;

  const hasBandStats =
    points !== undefined ||
    tcrit !== undefined ||
    lowerMin !== undefined ||
    lowerMax !== undefined ||
    upperMin !== undefined ||
    upperMax !== undefined ||
    widthMean !== undefined ||
    widthMax !== undefined;

  if (!hasBandStats) {
    return null;
  }

  const rows: ECPRow[] = [];
  rows.push({
    cells: [
      { value: 'Measure', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  if (points !== undefined) {
    rows.push({
      cells: [
        { value: 'Band Points', align: 'left' },
        { value: points.toString(), align: 'right', attrs: { 'data-stat': dataStatKey('ci_band_points', modelPrefix) } },
      ],
    });
  }

  if (tcrit !== undefined) {
    rows.push({
      cells: [
        { value: 't-Critical', align: 'left' },
        { value: formatNumber(tcrit, d), align: 'right', attrs: { 'data-stat': dataStatKey('ci_band_tcrit', modelPrefix) } },
      ],
    });
  }

  if (lowerMin !== undefined) {
    rows.push({
      cells: [
        { value: 'Lower Band Min', align: 'left' },
        { value: formatNumber(lowerMin, d), align: 'right', attrs: { 'data-stat': dataStatKey('ci_band_lower_min', modelPrefix) } },
      ],
    });
  }

  if (lowerMax !== undefined) {
    rows.push({
      cells: [
        { value: 'Lower Band Max', align: 'left' },
        { value: formatNumber(lowerMax, d), align: 'right', attrs: { 'data-stat': dataStatKey('ci_band_lower_max', modelPrefix) } },
      ],
    });
  }

  if (upperMin !== undefined) {
    rows.push({
      cells: [
        { value: 'Upper Band Min', align: 'left' },
        { value: formatNumber(upperMin, d), align: 'right', attrs: { 'data-stat': dataStatKey('ci_band_upper_min', modelPrefix) } },
      ],
    });
  }

  if (upperMax !== undefined) {
    rows.push({
      cells: [
        { value: 'Upper Band Max', align: 'left' },
        { value: formatNumber(upperMax, d), align: 'right', attrs: { 'data-stat': dataStatKey('ci_band_upper_max', modelPrefix) } },
      ],
    });
  }

  if (widthMean !== undefined) {
    rows.push({
      cells: [
        { value: 'Band Width Mean', align: 'left' },
        { value: formatNumber(widthMean, d), align: 'right', attrs: { 'data-stat': dataStatKey('ci_band_width_mean', modelPrefix) } },
      ],
    });
  }

  if (widthMax !== undefined) {
    rows.push({
      cells: [
        { value: 'Band Width Max', align: 'left' },
        { value: formatNumber(widthMax, d), align: 'right', attrs: { 'data-stat': dataStatKey('ci_band_width_max', modelPrefix) } },
      ],
    });
  }

  return {
    title: 'Confidence Band Summary',
    columns: [
      { key: 'measure', header: 'Measure', align: 'left', width: 22 },
      { key: 'value', header: 'Value', align: 'right', width: 16, format: 'decimal' },
    ],
    rows,
    testName: 'dose_response_ci_band',
  };
}

/**
 * Build Warnings table
 */
function buildWarningsTable(warnings: string[], context: string): ECPTable {
  const rows: ECPRow[] = [];

  // Header row
  rows.push({
    cells: [
      { value: 'Warning', isHeader: true, align: 'left' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Warning rows
  for (const warning of warnings) {
    rows.push({
      cells: [
        { value: warning, align: 'left' },
      ],
    });
  }

  return {
    title: `${context} Warnings`,
    columns: [
      { key: 'warning', header: 'Warning', align: 'left', width: 60 },
    ],
    rows,
    testName: 'warnings',
  };
}

// =============================================================================
// SYNERGY ANALYSIS
// =============================================================================

/**
 * Build ECP-Style tables for Synergy Analysis results
 */
export function buildSynergyTables(
  result: Record<string, unknown>,
  testType: string,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Special handling: synergy_all returns nested per-model outputs.
  if (testType === 'synergy_all' && result.models && typeof result.models === 'object') {
    tables.push(buildSynergyAllComparisonTable(result, options));

    // Add unprefixed n_combinations, n_drug_a_doses, n_drug_b_doses (baseline expects them at top level)
    const nCombinations = result.n_combinations as number | undefined;
    const nDrugADoses = result.n_drug_a_doses as number | undefined;
    const nDrugBDoses = result.n_drug_b_doses as number | undefined;
    if (nCombinations !== undefined || nDrugADoses !== undefined || nDrugBDoses !== undefined) {
      tables.push(buildSynergyAllMetadataTable(nCombinations, nDrugADoses, nDrugBDoses, options));
    }

    const models = result.models as Record<string, unknown>;
    const modelOrder: Array<[string, string]> = [
      ['Bliss', 'synergy_bliss'],
      ['HSA', 'synergy_hsa'],
      ['Loewe', 'synergy_loewe'],
      ['ZIP', 'synergy_zip'],
    ];

    for (const [modelKey, modelTestType] of modelOrder) {
      const modelResult = models[modelKey];
      if (!modelResult || typeof modelResult !== 'object') continue;

      const modelObj = normalizeSynergyResult(modelResult as Record<string, unknown>);
      if (modelObj.success !== true) continue;

      // Model prefix for data-stat keys (e.g., "Bliss" -> "bliss", "HSA" -> "hsa")
      const synergyModelPrefix = modelKey.toLowerCase();

      // Summary stats (with model prefix for synergy_all)
      tables.push(buildSynergySummaryTable(modelObj, modelTestType, options, synergyModelPrefix));

      // Max synergy location (will compute from synergy_matrix if max_synergy_at not provided)
      if (modelObj.synergy_matrix || (modelObj.summary && (modelObj.summary as any).max_synergy_at)) {
        tables.push(buildMaxSynergyLocationTable(modelObj, options));
      }

      // Metadata (will derive counts from doses_a.length/doses_b.length)
      if (modelObj.doses_a || modelObj.doses_b) {
        tables.push(buildSynergyMetadataTable(modelObj, options));
      }

      // Synergy matrix
      if (modelObj.synergy_matrix) {
        tables.push(buildSynergyMatrixTable(modelObj, modelTestType, options));
      }

      // Expected matrix
      if (modelObj.expected_matrix) {
        tables.push(buildExpectedMatrixTable(modelObj, options));
      }

      // CI matrix (Loewe only)
      if (modelTestType === 'synergy_loewe' && modelObj.combination_indices) {
        tables.push(buildCombinationIndexMatrixTable(modelObj, options));
      }

      // Drug fit parameters (Loewe/ZIP only)
      if (
        (modelTestType === 'synergy_loewe' || modelTestType === 'synergy_zip') &&
        (modelObj.drug_a_fit || modelObj.drug_b_fit)
      ) {
        tables.push(buildDrugFitTable(modelObj, options));
      }
    }

    const warnings = result.warnings as string[] | undefined;
    if (warnings && warnings.length > 0) {
      tables.push(buildWarningsTable(warnings, 'Synergy Analysis'));
    }
  } else {
    const normalized = normalizeSynergyResult(result);

    // Table 1: Synergy Summary
    tables.push(buildSynergySummaryTable(normalized, testType, options));

    // Table 2: Max Synergy Location (shows where max synergy occurred)
    // Will compute from synergy_matrix if max_synergy_at not provided
    if (normalized.synergy_matrix || (normalized.summary && (normalized.summary as any).max_synergy_at)) {
      tables.push(buildMaxSynergyLocationTable(normalized, options));
    }

    // Table 3: Analysis Metadata (grid dimensions, dose ranges)
    // Will derive counts from doses_a.length/doses_b.length if n_drug_a_doses not provided
    if (normalized.doses_a || normalized.doses_b) {
      tables.push(buildSynergyMetadataTable(normalized, options));
    }

    // Table 4: Synergy Matrix (main heatmap)
    if (normalized.synergy_matrix) {
      tables.push(buildSynergyMatrixTable(normalized, testType, options));
    }

    // Table 5: Expected Matrix (additive baseline for comparison)
    if (normalized.expected_matrix) {
      tables.push(buildExpectedMatrixTable(normalized, options));
    }

    // Table 6: Combination Index Matrix (Loewe only - alternative representation)
    if (testType === 'synergy_loewe' && normalized.combination_indices) {
      tables.push(buildCombinationIndexMatrixTable(normalized, options));
    }

    // Table 7: Drug Fit Parameters (Loewe/ZIP only - single-agent curves)
    if (
      (testType === 'synergy_loewe' || testType === 'synergy_zip') &&
      (normalized.drug_a_fit || normalized.drug_b_fit)
    ) {
      tables.push(buildDrugFitTable(normalized, options));
    }

    // Warnings table (if any)
    const warnings = normalized.warnings as string[] | undefined;
    if (warnings && warnings.length > 0) {
      tables.push(buildWarningsTable(warnings, 'Synergy Analysis'));
    }
  }

  return {
    testType,
    testFamily: 'pharmacology',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
    },
  };
}

/**
 * Build Synergy Summary table
 */
function buildSynergySummaryTable(
  result: Record<string, unknown>,
  testType: string,
  options: Required<TableBuilderOptions>,
  modelPrefix?: string
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  const methodNames: Record<string, string> = {
    synergy_bliss: 'Bliss Independence',
    synergy_hsa: 'Highest Single Agent (HSA)',
    synergy_loewe: 'Loewe Additivity',
    synergy_zip: 'Zero Interaction Potency (ZIP)',
    synergy_all: 'Comprehensive (All Methods)',
  };

  const method = result.model as string || result.method as string || methodNames[testType] || testType;

  // Get summary statistics
  const summary = result.summary as {
    mean_synergy?: number;
    max_synergy?: number;
    min_synergy?: number;
    synergistic_fraction?: number;
  } | undefined;

  // Header row
  rows.push({
    cells: [
      { value: 'Metric', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Method
  rows.push({
    cells: [
      { value: 'Method', align: 'left' },
      { value: method, align: 'right' },
    ],
  });

  // Summary statistics
  if (summary) {
    if (summary.mean_synergy !== undefined) {
      rows.push({
        cells: [
          { value: 'Mean Synergy Score', align: 'left' },
          { value: formatNumber(summary.mean_synergy, d), align: 'right', attrs: { 'data-stat': dataStatKey('mean_synergy_score', modelPrefix) } },
        ],
      });
    }

    if (summary.max_synergy !== undefined) {
      rows.push({
        cells: [
          { value: 'Max Synergy Score', align: 'left' },
          { value: formatNumber(summary.max_synergy, d), align: 'right', attrs: { 'data-stat': dataStatKey('max_synergy_score', modelPrefix) } },
        ],
      });
    }

    if (summary.min_synergy !== undefined) {
      rows.push({
        cells: [
          { value: 'Min Synergy Score', align: 'left' },
          { value: formatNumber(summary.min_synergy, d), align: 'right', attrs: { 'data-stat': dataStatKey('min_synergy_score', modelPrefix) } },
        ],
      });
    }

    if (summary.synergistic_fraction !== undefined) {
      const percentage = summary.synergistic_fraction.toFixed(1) + '%';
      rows.push({
        cells: [
          { value: 'Synergistic Fraction', align: 'left' },
          { value: percentage, align: 'right', attrs: { 'data-stat': dataStatKey('synergistic_fraction', modelPrefix) } },
        ],
      });
    }
  }

  // Legacy single score support
  if (result.synergy_score !== undefined && !summary) {
    rows.push({
      cells: [
        { value: 'Synergy Score', align: 'left' },
        { value: formatNumber(result.synergy_score as number, d), align: 'right', attrs: { 'data-stat': dataStatKey('synergy_score', modelPrefix) } },
      ],
    });
  }

  // Combination Index (if available)
  if (result.combination_index !== undefined) {
    rows.push({
      cells: [
        { value: 'Combination Index (CI)', align: 'left' },
        { value: formatNumber(result.combination_index as number, d), align: 'right', attrs: { 'data-stat': dataStatKey('combination_index', modelPrefix) } },
      ],
    });
  }

  // Number of combinations (from result or derived from doses)
  const nCombinations = result.n_combinations as number | undefined;
  if (nCombinations !== undefined) {
    rows.push({
      cells: [
        { value: 'Number of Combinations', align: 'left' },
        { value: nCombinations.toString(), align: 'right', attrs: { 'data-stat': dataStatKey('n_combinations', modelPrefix) } },
      ],
    });
  }

  // Separator before interpretation
  rows.push({ cells: [], isSeparator: true });

  // Interpretation
  const interpretation = result.interpretation as string ||
    interpretSynergy(summary?.mean_synergy ?? result.synergy_score as number);
  rows.push({
    cells: [
      { value: 'Interpretation', align: 'left' },
      { value: interpretation, align: 'right', attrs: { 'data-stat': dataStatKey('interpretation', modelPrefix) } },
    ],
  });

  return {
    title: 'Synergy Summary',
    procedure: 'Drug Combination Synergy Analysis',
    columns: [
      { key: 'metric', header: 'Metric', align: 'left', width: 24 },
      { key: 'value', header: 'Value', align: 'right', width: 24 },
    ],
    rows,
    footnotes: getSynergyFootnotes(testType),
    testName: 'synergy_summary',
  };
}

/**
 * Build Synergy Matrix table (dose grid values)
 */
function buildSynergyMatrixTable(
  result: Record<string, unknown>,
  _testType: string,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  const synergyMatrix = result.synergy_matrix as number[][];
  const dosesA = result.doses_a as number[] | undefined;
  const dosesB = result.doses_b as number[] | undefined;

  if (!synergyMatrix || synergyMatrix.length === 0) {
    return {
      title: 'Synergy Matrix',
      columns: [],
      rows: [],
      testName: 'synergy_matrix',
    };
  }

  // Build column headers (Drug B doses)
  const numColsB = synergyMatrix[0]?.length || 0;

  rows.push({
    cells: [
      { value: 'Drug A \\ Drug B', isHeader: true, align: 'left' },
      ...Array.from({ length: numColsB }, (_, j) => ({
        value: dosesB ? formatNumber(dosesB[j]!, d) : `D${j + 1}`,
        isHeader: true,
        align: 'right' as const,
      })),
    ],
    isHeader: true,
  });
  rows.push({ cells: [], isSeparator: true });

  // Build data rows (Drug A doses as row headers)
  for (let i = 0; i < synergyMatrix.length; i++) {
    const row = synergyMatrix[i]!;
    const rowLabel = dosesA ? formatNumber(dosesA[i]!, d) : `D${i + 1}`;

    rows.push({
      cells: [
        { value: rowLabel, align: 'left', isHeader: true },
        ...row.map(val => ({
          value: formatNumber(val, d),
          align: 'right' as const,
        })),
      ],
    });
  }

  // Build column definitions
  const columns = [
    { key: 'drug_a', header: 'Drug A \\ Drug B', align: 'left' as const, width: 14 },
    ...Array.from({ length: numColsB }, (_, j) => ({
      key: `dose_b_${j}`,
      header: dosesB ? formatNumber(dosesB[j]!, d) : `D${j + 1}`,
      align: 'right' as const,
      width: 10,
      format: 'decimal' as const,
    })),
  ];

  return {
    title: 'Synergy Score Matrix',
    procedure: 'Dose Grid Values',
    columns,
    rows,
    footnotes: [
      'Row headers = Drug A doses, Column headers = Drug B doses',
      'Positive values indicate synergy, negative values indicate antagonism',
    ],
    testName: 'synergy_matrix',
  };
}

/**
 * Build Drug Fit Parameters table (for Loewe/ZIP)
 */
function buildDrugFitTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  const drugFits = {
    drug_a: result.drug_a_fit as { ic50?: number; hill?: number; bottom?: number; top?: number; r_squared?: number } | undefined,
    drug_b: result.drug_b_fit as { ic50?: number; hill?: number; bottom?: number; top?: number; r_squared?: number } | undefined,
  };

  // Header row
  rows.push({
    cells: [
      { value: 'Parameter', isHeader: true, align: 'left' },
      { value: 'Drug A', isHeader: true, align: 'right' },
      { value: 'Drug B', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Bottom (Loewe only)
  if (drugFits.drug_a?.bottom !== undefined || drugFits.drug_b?.bottom !== undefined) {
    rows.push({
      cells: [
        { value: 'Bottom', align: 'left' },
        {
          value: drugFits.drug_a?.bottom !== undefined ? formatNumber(drugFits.drug_a.bottom, d) : '.',
          align: 'right',
          attrs: drugFits.drug_a?.bottom !== undefined ? { 'data-stat': 'drug_a_bottom' } : undefined,
        },
        {
          value: drugFits.drug_b?.bottom !== undefined ? formatNumber(drugFits.drug_b.bottom, d) : '.',
          align: 'right',
          attrs: drugFits.drug_b?.bottom !== undefined ? { 'data-stat': 'drug_b_bottom' } : undefined,
        },
      ],
    });
  }

  // Top (Loewe only)
  if (drugFits.drug_a?.top !== undefined || drugFits.drug_b?.top !== undefined) {
    rows.push({
      cells: [
        { value: 'Top', align: 'left' },
        {
          value: drugFits.drug_a?.top !== undefined ? formatNumber(drugFits.drug_a.top, d) : '.',
          align: 'right',
          attrs: drugFits.drug_a?.top !== undefined ? { 'data-stat': 'drug_a_top' } : undefined,
        },
        {
          value: drugFits.drug_b?.top !== undefined ? formatNumber(drugFits.drug_b.top, d) : '.',
          align: 'right',
          attrs: drugFits.drug_b?.top !== undefined ? { 'data-stat': 'drug_b_top' } : undefined,
        },
      ],
    });
  }

  // IC50
  rows.push({
    cells: [
      { value: 'IC50', align: 'left' },
      {
        value: drugFits.drug_a?.ic50 !== undefined ? formatNumber(drugFits.drug_a.ic50, d) : '.',
        align: 'right',
        attrs: drugFits.drug_a?.ic50 !== undefined ? { 'data-stat': 'drug_a_ic50' } : undefined,
      },
      {
        value: drugFits.drug_b?.ic50 !== undefined ? formatNumber(drugFits.drug_b.ic50, d) : '.',
        align: 'right',
        attrs: drugFits.drug_b?.ic50 !== undefined ? { 'data-stat': 'drug_b_ic50' } : undefined,
      },
    ],
  });

  // Hill slope
  rows.push({
    cells: [
      { value: 'Hill Slope', align: 'left' },
      {
        value: drugFits.drug_a?.hill !== undefined ? formatNumber(drugFits.drug_a.hill, d) : '.',
        align: 'right',
        attrs: drugFits.drug_a?.hill !== undefined ? { 'data-stat': 'drug_a_hill' } : undefined,
      },
      {
        value: drugFits.drug_b?.hill !== undefined ? formatNumber(drugFits.drug_b.hill, d) : '.',
        align: 'right',
        attrs: drugFits.drug_b?.hill !== undefined ? { 'data-stat': 'drug_b_hill' } : undefined,
      },
    ],
  });

  // R-squared (optional - not all backends return this)
  if (drugFits.drug_a?.r_squared !== undefined || drugFits.drug_b?.r_squared !== undefined) {
    rows.push({
      cells: [
        { value: 'R²', align: 'left' },
        {
          value: drugFits.drug_a?.r_squared !== undefined ? formatNumber(drugFits.drug_a.r_squared, d) : '.',
          align: 'right',
          attrs: drugFits.drug_a?.r_squared !== undefined ? { 'data-stat': 'drug_a_r_squared' } : undefined,
        },
        {
          value: drugFits.drug_b?.r_squared !== undefined ? formatNumber(drugFits.drug_b.r_squared, d) : '.',
          align: 'right',
          attrs: drugFits.drug_b?.r_squared !== undefined ? { 'data-stat': 'drug_b_r_squared' } : undefined,
        },
      ],
    });
  }

  return {
    title: 'Single-Agent Dose-Response Fit',
    procedure: 'Individual Drug Curve Fitting',
    columns: [
      { key: 'parameter', header: 'Parameter', align: 'left', width: 14 },
      { key: 'drug_a', header: 'Drug A', align: 'right', width: 14, format: 'decimal' },
      { key: 'drug_b', header: 'Drug B', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    footnotes: [
      'Parameters from 4PL curve fits to single-agent dose-response data',
    ],
    testName: 'drug_fit_parameters',
  };
}

/**
 * Build Max Synergy Location table
 * Shows where maximum synergy occurred in the dose grid
 * Computes location from synergy_matrix if max_synergy_at not provided by backend
 */
function buildMaxSynergyLocationTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  const summary = result.summary as {
    max_synergy?: number;
    max_synergy_at?: { dose_a?: number; dose_b?: number; index_a?: number; index_b?: number };
  } | undefined;

  const synergyMatrix = result.synergy_matrix as number[][] | undefined;
  const dosesA = result.doses_a as number[] | undefined;
  const dosesB = result.doses_b as number[] | undefined;

  let maxSynergy = summary?.max_synergy;
  let maxAt = summary?.max_synergy_at;

  // Compute max location from synergy_matrix if not provided by backend
  if (!maxAt && synergyMatrix && synergyMatrix.length > 0) {
    let maxValue = -Infinity;
    let maxRowIdx = 0;
    let maxColIdx = 0;

    for (let i = 0; i < synergyMatrix.length; i++) {
      const row = synergyMatrix[i];
      if (!row) continue;
      for (let j = 0; j < row.length; j++) {
        const value = row[j];
        if (value !== null && value !== undefined && value > maxValue) {
          maxValue = value;
          maxRowIdx = i;
          maxColIdx = j;
        }
      }
    }

    if (maxValue > -Infinity) {
      maxSynergy = maxValue;
      maxAt = {
        index_a: maxRowIdx,
        index_b: maxColIdx,
        dose_a: dosesA ? dosesA[maxRowIdx] : undefined,
        dose_b: dosesB ? dosesB[maxColIdx] : undefined,
      };
    }
  }

  // Header row
  rows.push({
    cells: [
      { value: 'Field', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Max synergy value
  if (maxSynergy !== undefined) {
    rows.push({
      cells: [
        { value: 'Max Synergy Score', align: 'left' },
        { value: formatNumber(maxSynergy, d), align: 'right' },
      ],
    });
  }

  // Drug A dose
  if (maxAt?.dose_a !== undefined) {
    rows.push({
      cells: [
        { value: 'Drug A Dose', align: 'left' },
        { value: formatNumber(maxAt.dose_a, d), align: 'right' },
      ],
    });
  }

  // Drug B dose
  if (maxAt?.dose_b !== undefined) {
    rows.push({
      cells: [
        { value: 'Drug B Dose', align: 'left' },
        { value: formatNumber(maxAt.dose_b, d), align: 'right' },
      ],
    });
  }

  // Grid indices (for reference)
  if (maxAt?.index_a !== undefined && maxAt?.index_b !== undefined) {
    rows.push({
      cells: [
        { value: 'Grid Location', align: 'left' },
        { value: `Row ${maxAt.index_a}, Column ${maxAt.index_b}`, align: 'right' },
      ],
    });
  }

  return {
    title: 'Maximum Synergy Location',
    procedure: 'Dose Combination with Strongest Synergy',
    columns: [
      { key: 'field', header: 'Field', align: 'left', width: 20 },
      { key: 'value', header: 'Value', align: 'right', width: 20 },
    ],
    rows,
    footnotes: ['Location of strongest synergistic effect in dose combination grid'],
    testName: 'max_synergy_location',
  };
}

/**
 * Build Synergy Metadata table
 * Shows grid dimensions and dose ranges
 * Derives counts from doses_a.length/doses_b.length if n_drug_a_doses not provided
 */
function buildSynergyMetadataTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  const dosesA = result.doses_a as number[] | undefined;
  const dosesB = result.doses_b as number[] | undefined;

  // Derive counts from array length if explicit fields not provided
  const nDosesA = (result.n_drug_a_doses as number | undefined) ?? dosesA?.length;
  const nDosesB = (result.n_drug_b_doses as number | undefined) ?? dosesB?.length;

  // Header row
  rows.push({
    cells: [
      { value: 'Metadata', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Number of dose levels
  if (nDosesA !== undefined) {
    rows.push({
      cells: [
        { value: 'Drug A Dose Levels', align: 'left' },
        { value: nDosesA.toString(), align: 'right', attrs: { 'data-stat': 'n_drug_a_doses' } },
      ],
    });
  }

  if (nDosesB !== undefined) {
    rows.push({
      cells: [
        { value: 'Drug B Dose Levels', align: 'left' },
        { value: nDosesB.toString(), align: 'right', attrs: { 'data-stat': 'n_drug_b_doses' } },
      ],
    });
  }

  // Total combinations (n_combinations is emitted in buildSynergySummaryTable, not here)
  if (nDosesA !== undefined && nDosesB !== undefined) {
    rows.push({
      cells: [
        { value: 'Total Combinations', align: 'left' },
        { value: (nDosesA * nDosesB).toString(), align: 'right' },
      ],
    });
  }

  // Dose ranges
  if (dosesA && dosesA.length > 0) {
    const minDoseA = Math.min(...dosesA);
    const maxDoseA = Math.max(...dosesA);
    rows.push({
      cells: [
        { value: 'Drug A Dose Range', align: 'left' },
        { value: `${formatNumber(minDoseA, d)} – ${formatNumber(maxDoseA, d)}`, align: 'right' },
      ],
    });
  }

  if (dosesB && dosesB.length > 0) {
    const minDoseB = Math.min(...dosesB);
    const maxDoseB = Math.max(...dosesB);
    rows.push({
      cells: [
        { value: 'Drug B Dose Range', align: 'left' },
        { value: `${formatNumber(minDoseB, d)} – ${formatNumber(maxDoseB, d)}`, align: 'right' },
      ],
    });
  }

  return {
    title: 'Analysis Metadata',
    procedure: 'Dose Grid Information',
    columns: [
      { key: 'metadata', header: 'Metadata', align: 'left', width: 22 },
      { key: 'value', header: 'Value', align: 'right', width: 20 },
    ],
    rows,
    footnotes: ['Information about the dose combination grid tested'],
    testName: 'synergy_metadata',
  };
}

/**
 * Build Expected Matrix table
 * Shows expected additive effect for comparison with observed synergy
 */
function buildExpectedMatrixTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  const expectedMatrix = result.expected_matrix as number[][];
  const dosesA = result.doses_a as number[] | undefined;
  const dosesB = result.doses_b as number[] | undefined;

  if (!expectedMatrix || expectedMatrix.length === 0) {
    return {
      title: 'Expected Effect Matrix (Additive Baseline)',
      columns: [],
      rows: [],
      testName: 'expected_matrix',
    };
  }

  // Build column headers (Drug B doses)
  const numColsB = expectedMatrix[0]?.length || 0;

  rows.push({
    cells: [
      { value: 'Drug A \\ Drug B', isHeader: true, align: 'left' },
      ...Array.from({ length: numColsB }, (_, j) => ({
        value: dosesB ? formatNumber(dosesB[j]!, d) : `D${j + 1}`,
        isHeader: true,
        align: 'right' as const,
      })),
    ],
    isHeader: true,
  });
  rows.push({ cells: [], isSeparator: true });

  // Build data rows (Drug A doses as row headers)
  for (let i = 0; i < expectedMatrix.length; i++) {
    const row = expectedMatrix[i]!;
    const rowLabel = dosesA ? formatNumber(dosesA[i]!, d) : `D${i + 1}`;

    rows.push({
      cells: [
        { value: rowLabel, align: 'left', isHeader: true },
        ...row.map(val => ({
          value: formatNumber(val, d),
          align: 'right' as const,
        })),
      ],
    });
  }

  // Build column definitions
  const columns = [
    { key: 'drug_a', header: 'Drug A \\ Drug B', align: 'left' as const, width: 14 },
    ...Array.from({ length: numColsB }, (_, j) => ({
      key: `dose_b_${j}`,
      header: dosesB ? formatNumber(dosesB[j]!, d) : `D${j + 1}`,
      align: 'right' as const,
      width: 10,
      format: 'decimal' as const,
    })),
  ];

  return {
    title: 'Expected Effect Matrix (Additive Baseline)',
    procedure: 'Predicted Additive Response',
    columns,
    rows,
    footnotes: [
      'Expected additive effect under null hypothesis of no interaction',
      'Compare with synergy matrix to identify regions of synergy (positive) or antagonism (negative)',
    ],
    testName: 'expected_matrix',
  };
}

/**
 * Build Combination Index Matrix table (Loewe only)
 * CI < 1 = synergy, CI = 1 = additive, CI > 1 = antagonism
 */
function buildCombinationIndexMatrixTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  const ciMatrix = result.combination_indices as number[][];
  const dosesA = result.doses_a as number[] | undefined;
  const dosesB = result.doses_b as number[] | undefined;

  if (!ciMatrix || ciMatrix.length === 0) {
    return {
      title: 'Combination Index Matrix (Loewe)',
      columns: [],
      rows: [],
      testName: 'combination_index_matrix',
    };
  }

  // Build column headers (Drug B doses)
  const numColsB = ciMatrix[0]?.length || 0;

  rows.push({
    cells: [
      { value: 'Drug A \\ Drug B', isHeader: true, align: 'left' },
      ...Array.from({ length: numColsB }, (_, j) => ({
        value: dosesB ? formatNumber(dosesB[j]!, d) : `D${j + 1}`,
        isHeader: true,
        align: 'right' as const,
      })),
    ],
    isHeader: true,
  });
  rows.push({ cells: [], isSeparator: true });

  // Build data rows (Drug A doses as row headers)
  for (let i = 0; i < ciMatrix.length; i++) {
    const row = ciMatrix[i]!;
    const rowLabel = dosesA ? formatNumber(dosesA[i]!, d) : `D${i + 1}`;

    rows.push({
      cells: [
        { value: rowLabel, align: 'left', isHeader: true },
        ...row.map(val => ({
          value: val !== null && val !== undefined ? formatNumber(val, d) : '.',
          align: 'right' as const,
        })),
      ],
    });
  }

  // Build column definitions
  const columns = [
    { key: 'drug_a', header: 'Drug A \\ Drug B', align: 'left' as const, width: 14 },
    ...Array.from({ length: numColsB }, (_, j) => ({
      key: `dose_b_${j}`,
      header: dosesB ? formatNumber(dosesB[j]!, d) : `D${j + 1}`,
      align: 'right' as const,
      width: 10,
      format: 'decimal' as const,
    })),
  ];

  return {
    title: 'Combination Index Matrix (Loewe)',
    procedure: 'Loewe Additivity Analysis',
    columns,
    rows,
    footnotes: [
      'CI < 1: Synergy (combination more effective than expected)',
      'CI = 1: Additive (combination effect equals sum of individual effects)',
      'CI > 1: Antagonism (combination less effective than expected)',
    ],
    testName: 'combination_index_matrix',
  };
}

function normalizeSynergyResult(result: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...result };

  // ZIP uses zip_scores instead of synergy_matrix.
  if (!normalized.synergy_matrix && normalized.zip_scores) {
    normalized.synergy_matrix = normalized.zip_scores;
  }

  return normalized;
}

function buildSynergyAllComparisonTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  const summary = result.comparison_summary as
    | Record<string, { mean_score?: number; interpretation?: string }>
    | undefined;

  rows.push({
    cells: [
      { value: 'Model', isHeader: true, align: 'left' },
      { value: 'Mean Score', isHeader: true, align: 'right' },
      { value: 'Interpretation', isHeader: true, align: 'left' },
    ],
    isHeader: true,
  });
  rows.push({ cells: [], isSeparator: true });

  // Map model names to lowercase prefixes for data-stat keys
  const modelPrefixes: Record<string, string> = {
    Bliss: 'bliss',
    HSA: 'hsa',
    Loewe: 'loewe',
    ZIP: 'zip',
  };

  const order = ['Bliss', 'HSA', 'Loewe', 'ZIP'];
  if (summary) {
    for (const modelName of order) {
      const entry = summary[modelName];
      if (!entry) continue;
      const prefix = modelPrefixes[modelName];
      rows.push({
        cells: [
          { value: modelName, align: 'left' },
          {
            value: entry.mean_score !== undefined ? formatNumber(entry.mean_score, d) : '.',
            align: 'right',
            attrs: entry.mean_score !== undefined ? { 'data-stat': `${prefix}_mean_synergy_score` } : undefined,
          },
          {
            value: entry.interpretation ?? '.',
            align: 'left',
            attrs: entry.interpretation ? { 'data-stat': `${prefix}_interpretation` } : undefined,
          },
        ],
      });
    }
  } else {
    rows.push({
      cells: [
        { value: 'All', align: 'left' },
        { value: '.', align: 'right' },
        { value: 'No comparison summary returned', align: 'left' },
      ],
    });
  }

  return {
    title: 'Synergy Model Comparison',
    procedure: 'Synergy Analysis (All Methods)',
    columns: [
      { key: 'model', header: 'Model', align: 'left', width: 12 },
      { key: 'mean', header: 'Mean Score', align: 'right', width: 14, format: 'decimal' },
      { key: 'interpretation', header: 'Interpretation', align: 'left', width: 28 },
    ],
    rows,
    testName: 'synergy_all_comparison',
  };
}

/**
 * Build Synergy All Metadata table (for unprefixed n_combinations, n_drug_a_doses, n_drug_b_doses)
 */
function buildSynergyAllMetadataTable(
  nCombinations: number | undefined,
  nDrugADoses: number | undefined,
  nDrugBDoses: number | undefined,
  _options: Required<TableBuilderOptions>
): ECPTable {
  const rows: ECPRow[] = [];

  rows.push({
    cells: [
      { value: 'Metadata', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });
  rows.push({ cells: [], isSeparator: true });

  if (nCombinations !== undefined) {
    rows.push({
      cells: [
        { value: 'Number of Combinations', align: 'left' },
        { value: nCombinations.toString(), align: 'right', attrs: { 'data-stat': 'n_combinations' } },
      ],
    });
  }

  if (nDrugADoses !== undefined) {
    rows.push({
      cells: [
        { value: 'Drug A Doses', align: 'left' },
        { value: nDrugADoses.toString(), align: 'right', attrs: { 'data-stat': 'n_drug_a_doses' } },
      ],
    });
  }

  if (nDrugBDoses !== undefined) {
    rows.push({
      cells: [
        { value: 'Drug B Doses', align: 'left' },
        { value: nDrugBDoses.toString(), align: 'right', attrs: { 'data-stat': 'n_drug_b_doses' } },
      ],
    });
  }

  return {
    title: 'Analysis Summary',
    procedure: 'Synergy Analysis (All Methods)',
    columns: [
      { key: 'metadata', header: 'Metadata', align: 'left', width: 22 },
      { key: 'value', header: 'Value', align: 'right', width: 12 },
    ],
    rows,
    testName: 'synergy_all_metadata',
  };
}

/**
 * Interpret synergy score
 */
function interpretSynergy(score: number | undefined): string {
  if (score === undefined || isNaN(score)) return '.';
  if (score > 10) return 'Strong Synergy';
  if (score > 0) return 'Weak Synergy';
  if (score > -10) return 'Additive';
  return 'Antagonism';
}

/**
 * Get method-specific footnotes
 */
function getSynergyFootnotes(testType: string): string[] {
  const footnotes: Record<string, string[]> = {
    synergy_bliss: [
      'Bliss Independence: Expected effect = E(A) + E(B) - E(A)*E(B)',
      'Score > 0: Synergy, Score = 0: Additive, Score < 0: Antagonism',
    ],
    synergy_hsa: [
      'HSA: Expected effect = max(E(A), E(B))',
      'Score > 0: Synergy, Score = 0: HSA, Score < 0: Antagonism',
    ],
    synergy_loewe: [
      'Loewe Additivity: Based on isobologram analysis',
      'CI < 1: Synergy, CI = 1: Additive, CI > 1: Antagonism',
    ],
    synergy_zip: [
      'ZIP: Zero Interaction Potency model',
      'Score > 10: Strong synergy, 0-10: Weak synergy, < 0: Antagonism',
    ],
    synergy_all: [
      'Comprehensive analysis using Bliss, HSA, Loewe, and ZIP models',
      'Different models may yield different interpretations based on assumptions',
    ],
  };

  return footnotes[testType] || [];
}

