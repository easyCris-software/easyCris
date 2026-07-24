/**
 * Regression ECP-Style Table Builder
 *
 * Maps validated Python JSON output to ECP-Style tables:
 * - Linear regression from regression.linear_regression
 * - Logistic regression from regression.logistic_regression_binary_statsmodels
 *
 * Includes Odds Ratio tables for logistic regression.
 */

import type {
  ECPTable,
  ECPTableCollection,
  ECPRow,
  ECPColumn,
  TableBuilderOptions,
} from '../../types/ecpStyleTables';
import { formatNumber, formatPValue, formatDF } from './index';

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Sanitize coefficient term name for data-stat attribute
 *
 * CRITICAL: Preserve case to match baseline keys (factor1Low, not factor1low)
 *
 * Examples:
 * - "Intercept" -> "intercept"  (special case - always lowercase)
 * - "x1" -> "x1"  (preserve case)
 * - "factor1[T.Low]" -> "factor1Low"  (Python statsmodels format, preserve "Low")
 * - "factor1Low" -> "factor1Low"  (easyCris format, preserve case)
 *
 * Normalization rules:
 * 1. "Intercept" is special-cased to "intercept" (lowercase)
 * 2. All other terms preserve original case
 * 3. Remove statsmodels brackets: "[T.Low]" -> "Low"
 * 4. Replace spaces with underscores
 */
function sanitizeTerm(term: string): string {
  // Special case: Intercept always lowercase
  if (term.toLowerCase() === 'intercept') {
    return 'intercept';
  }

  // For all other terms, preserve case
  return term
    .replace(/\[T\./g, '')    // Remove "[T." (preserve case of "Low", "High", etc.)
    .replace(/\]/g, '')       // Remove "]"
    .replace(/\s+/g, '_');    // Replace spaces with underscores
}

/**
 * Sanitize class labels for multinomial data-stat prefixes.
 * Keeps alphanumerics and underscores so keys match baseline keys.
 */
function sanitizeClassLabel(label: string): string {
  return label.trim().replace(/\s+/g, '_').replace(/[^\w]/g, '');
}

// =============================================================================
// LINEAR REGRESSION
// =============================================================================

/**
 * Build ECP-Style tables for Linear Regression results
 *
 * Python JSON mapping:
 * - r_squared, adj_r_squared, f_statistic, f_pvalue
 * - model_fit_metrics.rmse
 * - coeff_table[]: term, coef, se, t, p, ci_lower, ci_upper
 * - regression_coefficients[]: term_display, beta, std_error, statistic, p_value, ci_lower, ci_upper
 */
export function buildLinearRegressionTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Table 1: Model Summary
  tables.push(buildLinearModelSummaryTable(result, options));

  // Table 2: Parameter Estimates (use coeff_table or regression_coefficients)
  if (result.coeff_table || result.regression_coefficients) {
    tables.push(buildLinearParameterEstimatesTable(result, options));
  }

  // Table 3: Fitted/Residual diagnostics summary (min/max/mean/sd)
  const diagnosticsTable = buildLinearFitDiagnosticsTable(result, options);
  if (diagnosticsTable) {
    tables.push(diagnosticsTable);
  }

  return {
    testType: 'linear_regression',
    testFamily: 'regression',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize: result.n_observations as number,
    },
  };
}

/**
 * Linear Regression - Model Summary Table
 *
 * Python keys: r_squared, adj_r_squared, f_statistic, f_pvalue, model_fit_metrics.rmse
 */
function buildLinearModelSummaryTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Extract RMSE from model_fit_metrics if present, otherwise try root level
  const modelFitMetrics = result.model_fit_metrics as Record<string, unknown> | undefined;
  const rmse = modelFitMetrics?.rmse ?? result.rmse;

  // Extract f_pvalue (Python uses f_pvalue, not f_p_value)
  const fPValue = (result.f_pvalue ?? result.f_p_value) as number;

  // Header row
  rows.push({
    cells: [
      { value: 'Statistic', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // R-squared
  rows.push({
    cells: [
      { value: 'R-Square', align: 'left' },
      { value: formatNumber(result.r_squared as number, d), align: 'right', attrs: { 'data-stat': 'r_squared' } },
    ],
  });

  // Adjusted R-squared (Python uses adj_r_squared)
  rows.push({
    cells: [
      { value: 'Adj R-Sq', align: 'left' },
      { value: formatNumber((result.adj_r_squared ?? result.adjusted_r_squared) as number, d), align: 'right', attrs: { 'data-stat': 'adj_r_squared' } },
    ],
  });

  // Root MSE (RMSE)
  rows.push({
    cells: [
      { value: 'Root MSE', align: 'left' },
      { value: formatNumber(rmse as number, d), align: 'right', attrs: { 'data-stat': 'residual_se' } },
    ],
  });

  // F-statistic
  rows.push({
    cells: [
      { value: 'F Value', align: 'left' },
      { value: formatNumber(result.f_statistic as number, d), align: 'right', attrs: { 'data-stat': 'f_statistic' } },
    ],
  });

  // p-value for F
  rows.push({
    cells: [
      { value: 'Pr > F', align: 'left' },
      { value: formatPValue(fPValue, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: fPValue < options.alpha, attrs: { 'data-stat': 'f_pvalue' } },
    ],
  });

  // Sample size
  rows.push({
    cells: [
      { value: 'Observations', align: 'left' },
      { value: String(result.n_observations), align: 'right', attrs: { 'data-stat': 'n_observations' } },
    ],
  });

  return {
    title: 'Model Summary',
    procedure: 'Linear Regression Analysis',
    dependentVar: options.variableName,
    columns: [
      { key: 'statistic', header: 'Statistic', align: 'left', width: 20 },
      { key: 'value', header: 'Value', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'linear_model_summary',
  };
}

/**
 * Linear Regression - Parameter Estimates Table
 *
 * Python coeff_table keys: term, coef, se, t, p, ci_lower, ci_upper
 * Python regression_coefficients keys: term_display, beta, std_error, statistic, p_value, ci_lower, ci_upper
 */
function buildLinearParameterEstimatesTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Try coeff_table first (compact format), then regression_coefficients (detailed format)
  const coeffTable = result.coeff_table as Array<{
    term: string;
    coef: number;
    se: number;
    t: number;
    p: number;
    ci_lower?: number;
    ci_upper?: number;
    vif?: number;
  }> | undefined;

  const regressionCoeffs = result.regression_coefficients as Array<{
    term_display: string;
    term: string;
    beta: number;
    std_error: number;
    statistic: number;
    p_value: number;
    ci_lower?: number;
    ci_upper?: number;
    vif?: number;
  }> | undefined;

  // Normalize to common format
  interface NormalizedCoeff {
    variable: string;
    estimate: number;
    std_error: number;
    t_value: number;
    p_value: number;
    ci_lower?: number;
    ci_upper?: number;
    vif?: number;
  }

  let coefficients: NormalizedCoeff[] = [];

  if (coeffTable && coeffTable.length > 0) {
    // Use coeff_table (Python's compact format)
    coefficients = coeffTable.map(c => ({
      variable: c.term === 'const' ? 'Intercept' : c.term,
      estimate: c.coef,
      std_error: c.se,
      t_value: c.t,
      p_value: c.p,
      ci_lower: c.ci_lower,
      ci_upper: c.ci_upper,
      vif: c.vif,
    }));
  } else if (regressionCoeffs && regressionCoeffs.length > 0) {
    // Use regression_coefficients (Python's detailed format)
    coefficients = regressionCoeffs.map(c => ({
      variable: c.term_display || (c.term === 'const' ? 'Intercept' : c.term),
      estimate: c.beta,
      std_error: c.std_error,
      t_value: c.statistic,
      p_value: c.p_value,
      ci_lower: c.ci_lower,
      ci_upper: c.ci_upper,
      vif: c.vif,
    }));
  }

  if (coefficients.length === 0) {
    // Fallback: return empty table
    return {
      title: 'Parameter Estimates',
      columns: [],
      rows: [],
      testName: 'linear_parameters',
    };
  }

  const ciLevel = Math.round((1 - options.alpha) * 100);
  const hasCIs = coefficients.some(c => c.ci_lower !== undefined);
  const hasVIF = coefficients.some(c => c.vif !== undefined);

  // Header row
  const headerCells = [
    { value: 'Variable', isHeader: true, align: 'left' as const },
    { value: 'Estimate', isHeader: true, align: 'right' as const },
    { value: 'Std Error', isHeader: true, align: 'right' as const },
    { value: 't Value', isHeader: true, align: 'right' as const },
    { value: 'Pr > |t|', isHeader: true, align: 'right' as const },
  ];

  if (hasCIs) {
    headerCells.push(
      { value: `${ciLevel}% CL Lower`, isHeader: true, align: 'right' as const },
      { value: `${ciLevel}% CL Upper`, isHeader: true, align: 'right' as const }
    );
  }

  if (hasVIF) {
    headerCells.push(
      { value: 'VIF', isHeader: true, align: 'right' as const }
    );
  }

  rows.push({ cells: headerCells, isHeader: true });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Coefficient rows
  for (const coef of coefficients) {
    const normalizedTerm = sanitizeTerm(coef.variable);

    const rowCells = [
      { value: coef.variable, align: 'left' as const },
      { value: formatNumber(coef.estimate, d), align: 'right' as const, attrs: { 'data-stat': `${normalizedTerm}_coef` } },
      { value: formatNumber(coef.std_error, d), align: 'right' as const, attrs: { 'data-stat': `${normalizedTerm}_se` } },
      { value: formatNumber(coef.t_value, d), align: 'right' as const, attrs: { 'data-stat': `${normalizedTerm}_t` } },
      { value: formatPValue(coef.p_value, options.pValueThreshold, options.minPValue), align: 'right' as const, isSignificant: coef.p_value < options.alpha, attrs: { 'data-stat': `${normalizedTerm}_p` } },
    ];

    if (hasCIs) {
      rowCells.push(
        { value: formatNumber(coef.ci_lower, d), align: 'right' as const, attrs: { 'data-stat': `${normalizedTerm}_ci_lower` } },
        { value: formatNumber(coef.ci_upper, d), align: 'right' as const, attrs: { 'data-stat': `${normalizedTerm}_ci_upper` } }
      );
    }

    if (hasVIF) {
      rowCells.push(
        coef.vif
          ? { value: formatNumber(coef.vif, d), align: 'right' as const, attrs: { 'data-stat': `${normalizedTerm}_vif` } }
          : { value: '.', align: 'left' as const }
      );
    }

    rows.push({ cells: rowCells });
  }

  const columns = [
    { key: 'variable', header: 'Variable', align: 'left' as const, width: 20 },
    { key: 'estimate', header: 'Estimate', align: 'right' as const, width: 14, format: 'decimal' as const },
    { key: 'std_error', header: 'Std Error', align: 'right' as const, width: 12, format: 'decimal' as const },
    { key: 't_value', header: 't Value', align: 'right' as const, width: 12, format: 'decimal' as const },
    { key: 'p_value', header: 'Pr > |t|', align: 'right' as const, width: 12, format: 'pvalue' as const },
  ];

  if (hasCIs) {
    columns.push(
      { key: 'ci_lower', header: `${ciLevel}% CL Lower`, align: 'right' as const, width: 14, format: 'decimal' as const },
      { key: 'ci_upper', header: `${ciLevel}% CL Upper`, align: 'right' as const, width: 14, format: 'decimal' as const }
    );
  }

  if (hasVIF) {
    columns.push(
      { key: 'vif', header: 'VIF', align: 'right' as const, width: 10, format: 'decimal' as const }
    );
  }

  return {
    title: 'Parameter Estimates',
    columns,
    rows,
    testName: 'linear_parameters',
  };
}

/**
 * Linear Regression - Fitted Values & Residuals Summary
 *
 * Provides summary stats required by E2E baseline:
 * fitted_min, fitted_max, fitted_mean, residual_min, residual_max, residual_mean, residual_sd
 */
function buildLinearFitDiagnosticsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable | null {
  const d = options.decimalPlaces;
  const fittedValues = result.fitted_values as number[] | undefined;
  const residuals = result.residuals as number[] | undefined;

  const fittedFiltered = Array.isArray(fittedValues)
    ? fittedValues.filter((v) => Number.isFinite(v))
    : [];
  const residualsFiltered = Array.isArray(residuals)
    ? residuals.filter((v) => Number.isFinite(v))
    : [];

  if (fittedFiltered.length === 0 && residualsFiltered.length === 0) {
    return null;
  }

  const fittedMean =
    fittedFiltered.length > 0
      ? fittedFiltered.reduce((sum, v) => sum + v, 0) / fittedFiltered.length
      : 0;
  const residualMean =
    residualsFiltered.length > 0
      ? residualsFiltered.reduce((sum, v) => sum + v, 0) / residualsFiltered.length
      : 0;
  const residualSd =
    residualsFiltered.length > 1
      ? Math.sqrt(
          residualsFiltered.reduce((sum, v) => {
            return sum + Math.pow(v - residualMean, 2);
          }, 0) / (residualsFiltered.length - 1)
        )
      : 0;

  const rows: ECPRow[] = [];

  rows.push({
    cells: [
      { value: 'Statistic', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });
  rows.push({ cells: [], isSeparator: true });

  rows.push({
    cells: [
      { value: 'Fitted Mean', align: 'left' },
      {
        value: formatNumber(fittedMean, d),
        align: 'right',
        attrs: { 'data-stat': 'fitted_mean', 'data-value': String(fittedMean) },
      },
    ],
  });
  rows.push({
    cells: [
      { value: 'Fitted Min', align: 'left' },
      {
        value: formatNumber(fittedFiltered.length > 0 ? Math.min(...fittedFiltered) : 0, d),
        align: 'right',
        attrs: {
          'data-stat': 'fitted_min',
          'data-value': String(fittedFiltered.length > 0 ? Math.min(...fittedFiltered) : 0),
        },
      },
    ],
  });
  rows.push({
    cells: [
      { value: 'Fitted Max', align: 'left' },
      {
        value: formatNumber(fittedFiltered.length > 0 ? Math.max(...fittedFiltered) : 0, d),
        align: 'right',
        attrs: {
          'data-stat': 'fitted_max',
          'data-value': String(fittedFiltered.length > 0 ? Math.max(...fittedFiltered) : 0),
        },
      },
    ],
  });

  rows.push({
    cells: [
      { value: 'Residual Mean', align: 'left' },
      {
        value: formatNumber(residualMean, d),
        align: 'right',
        attrs: { 'data-stat': 'residual_mean', 'data-value': String(residualMean) },
      },
    ],
  });
  rows.push({
    cells: [
      { value: 'Residual SD', align: 'left' },
      {
        value: formatNumber(residualSd, d),
        align: 'right',
        attrs: { 'data-stat': 'residual_sd', 'data-value': String(residualSd) },
      },
    ],
  });
  rows.push({
    cells: [
      { value: 'Residual Min', align: 'left' },
      {
        value: formatNumber(residualsFiltered.length > 0 ? Math.min(...residualsFiltered) : 0, d),
        align: 'right',
        attrs: {
          'data-stat': 'residual_min',
          'data-value': String(residualsFiltered.length > 0 ? Math.min(...residualsFiltered) : 0),
        },
      },
    ],
  });
  rows.push({
    cells: [
      { value: 'Residual Max', align: 'left' },
      {
        value: formatNumber(residualsFiltered.length > 0 ? Math.max(...residualsFiltered) : 0, d),
        align: 'right',
        attrs: {
          'data-stat': 'residual_max',
          'data-value': String(residualsFiltered.length > 0 ? Math.max(...residualsFiltered) : 0),
        },
      },
    ],
  });

  return {
    title: 'Fitted Values and Residuals',
    procedure: 'Linear Regression Analysis',
    columns: [
      { key: 'statistic', header: 'Statistic', align: 'left', width: 18 },
      { key: 'value', header: 'Value', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'linear_fit_diagnostics',
  };
}

// =============================================================================
// LOGISTIC REGRESSION
// =============================================================================

/**
 * Build ECP-Style tables for Logistic Regression results
 * Includes Odds Ratio estimates
 *
 * Supports both binary and multinomial logistic regression:
 * - Binary: Single set of parameter/OR tables
 * - Multinomial: Separate tables for each comparison class (grouped by class_label)
 *
 * Python JSON mapping:
 * - model_fit: minus2logL, minus2logL_null, aic, bic, lr_chi2, lr_df, lr_p, wald_chi2, wald_df, wald_p
 * - pseudo_r2: mcfadden, cox_snell, nagelkerke
 * - coefficients_table[]: feature, coef, std_err, z_value, p_value, odds_ratio, or_ci_lower, or_ci_upper
 * - regression_coefficients[]: term_display, beta, std_error, statistic, p_value, wald_chi2, odds_ratio, or_ci_lower, or_ci_upper
 *   - Multinomial: includes class_label field
 * - goodness_of_fit: hosmer_lemeshow, classification, roc_auc
 */
export function buildLogisticRegressionTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // DEBUG: Log what's in the result (guard against non-array payloads)
  console.log('[DEBUG] buildLogisticRegressionTables - result keys:', Object.keys(result));
  const coeffTableRaw = (result as Record<string, unknown>).coefficients_table;
  const regressionCoeffsRaw = (result as Record<string, unknown>).regression_coefficients;
  const hasCoeffTable = Array.isArray(coeffTableRaw) && coeffTableRaw.length > 0;
  const hasRegressionCoeffs = Array.isArray(regressionCoeffsRaw) && regressionCoeffsRaw.length > 0;
  console.log('[DEBUG] coefficients_table:', hasCoeffTable ? 'PRESENT' : 'MISSING');
  console.log('[DEBUG] regression_coefficients:', hasRegressionCoeffs ? 'PRESENT' : 'MISSING');
  if (hasCoeffTable) {
    console.log('[DEBUG] coefficients_table sample:', JSON.stringify(coeffTableRaw.slice(0, 1)));
  }
  if (hasRegressionCoeffs) {
    console.log('[DEBUG] regression_coefficients sample:', JSON.stringify(regressionCoeffsRaw.slice(0, 1)));
  }

  const normalizedResult: Record<string, unknown> = { ...result };
  if (hasCoeffTable) {
    normalizedResult.coefficients_table = coeffTableRaw;
  } else {
    delete (normalizedResult as { coefficients_table?: unknown }).coefficients_table;
  }
  if (hasRegressionCoeffs) {
    normalizedResult.regression_coefficients = regressionCoeffsRaw;
  } else {
    delete (normalizedResult as { regression_coefficients?: unknown }).regression_coefficients;
  }

  // Extract goodness_of_fit container (Python nests HL and classification here)
  const goodnessOfFit = normalizedResult.goodness_of_fit as Record<string, unknown> | undefined;

  // Detect if this is multinomial (prefer explicit model metadata over class_label)
  const modelType = String(normalizedResult.model ?? '');
  const nClasses = typeof normalizedResult.n_classes === 'number' ? normalizedResult.n_classes : undefined;
  const isMultinomial =
    modelType.includes('multinomial') ||
    (typeof nClasses === 'number' && nClasses > 2);

  // Table 1: Model Fit Statistics
  if (normalizedResult.model_fit) {
    tables.push(buildLogisticModelFitTable(normalizedResult, options));
  }

  // Table 2: Global Tests
  if (normalizedResult.model_fit) {
    tables.push(buildLogisticGlobalTestsTable(normalizedResult, options));
  }

  // Table 3: Pseudo R-Square
  if (normalizedResult.pseudo_r2) {
    tables.push(buildPseudoRSquareTable(normalizedResult, options));
  }

  // Table 4 & 5: Parameter Estimates and Odds Ratios
  if (hasCoeffTable || hasRegressionCoeffs) {
    if (isMultinomial) {
      // Multinomial: Create separate tables for each comparison class
      const parameterTables = buildMultinomialParameterEstimatesTables(normalizedResult, options);
      tables.push(...parameterTables);

      const oddsRatioTables = buildMultinomialOddsRatioTables(normalizedResult, options);
      tables.push(...oddsRatioTables);
    } else {
      // Binary: Single set of tables
      tables.push(buildLogisticParameterEstimatesTable(normalizedResult, options));
      tables.push(buildOddsRatioTable(normalizedResult, options));
    }
  }

  // Table 6: Hosmer-Lemeshow Test (check both root and goodness_of_fit)
  // Note: Only applicable for binary logistic regression
  if (!isMultinomial) {
    const hosmerLemeshow = normalizedResult.hosmer_lemeshow ?? goodnessOfFit?.hosmer_lemeshow;
    if (hosmerLemeshow) {
      tables.push(buildHosmerLemeshowTable({ hosmer_lemeshow: hosmerLemeshow }, options));
    }
  }

  // Table 7: Classification Table (check both root and goodness_of_fit)
  const classification = normalizedResult.classification ?? goodnessOfFit?.classification;
  if (classification) {
    const hasBeyondAccuracy =
      (classification as any).sensitivity !== undefined ||
      (classification as any).specificity !== undefined ||
      (classification as any).precision !== undefined ||
      (classification as any).f1_score !== undefined;
    if (hasBeyondAccuracy) {
      tables.push(buildClassificationTable({ classification }, options));
    }
  }

  return {
    testType: isMultinomial ? 'logistic_multinomial' : 'logistic_regression',
    testFamily: 'regression',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize: (result.n_samples ?? result.n_observations) as number,
    },
  };
}

/**
 * Logistic Regression - Model Fit Statistics Table
 */
function buildLogisticModelFitTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const modelFit = result.model_fit as {
    minus2logL: number;
    minus2logL_null: number;
    aic: number;
    bic: number;
  };

  // Extract regression_summary for n, df_null, df_residual
  const regSummary = result.regression_summary as {
    n_observations?: number;
    df_null?: number;
    df_residual?: number;
  } | undefined;

  // Header row
  rows.push({
    cells: [
      { value: 'Criterion', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // N (sample size)
  if (regSummary?.n_observations !== undefined) {
    rows.push({
      cells: [
        { value: 'N (Observations)', align: 'left' },
        { value: String(regSummary.n_observations), align: 'right', attrs: { 'data-stat': 'n' } },
      ],
    });
  }

  // -2 Log L (Intercept Only) with df_null
  rows.push({
    cells: [
      { value: '-2 Log L (Intercept Only)', align: 'left' },
      { value: formatNumber(modelFit.minus2logL_null, d), align: 'right', attrs: { 'data-stat': 'null_deviance' } },
    ],
  });

  // df_null (degrees of freedom for null model)
  if (regSummary?.df_null !== undefined) {
    rows.push({
      cells: [
        { value: 'DF (Intercept Only)', align: 'left' },
        { value: String(regSummary.df_null), align: 'right', attrs: { 'data-stat': 'df_null' } },
      ],
    });
  }

  // -2 Log L (Full Model)
  rows.push({
    cells: [
      { value: '-2 Log L (Full Model)', align: 'left' },
      { value: formatNumber(modelFit.minus2logL, d), align: 'right', attrs: { 'data-stat': 'residual_deviance' } },
    ],
  });

  // df_residual (degrees of freedom for residual/full model)
  if (regSummary?.df_residual !== undefined) {
    rows.push({
      cells: [
        { value: 'DF (Full Model)', align: 'left' },
        { value: String(regSummary.df_residual), align: 'right', attrs: { 'data-stat': 'df_residual' } },
      ],
    });
  }

  // AIC
  rows.push({
    cells: [
      { value: 'AIC', align: 'left' },
      { value: formatNumber(modelFit.aic, d), align: 'right', attrs: { 'data-stat': 'aic' } },
    ],
  });

  // BIC
  rows.push({
    cells: [
      { value: 'BIC', align: 'left' },
      { value: formatNumber(modelFit.bic, d), align: 'right', attrs: { 'data-stat': 'bic' } },
    ],
  });

  // Accuracy (if available). For multinomial logistic, sensitivity/specificity are not well-defined,
  // so we display accuracy here and omit the separate classification table unless additional metrics exist.
  const classification = (result.classification ??
    (result.goodness_of_fit as { classification?: { accuracy?: number } } | undefined)?.classification) as
    | { accuracy?: number }
    | undefined;
  if (classification?.accuracy !== undefined) {
    rows.push({
      cells: [
        { value: 'Accuracy', align: 'left' },
        { value: `${formatNumber(classification.accuracy * 100, 2)}%`, align: 'right' },
      ],
    });
  }

  return {
    title: 'Model Fit Statistics',
    procedure: 'Logistic Regression Analysis',
    columns: [
      { key: 'criterion', header: 'Criterion', align: 'left', width: 30 },
      { key: 'value', header: 'Value', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'logistic_model_fit',
  };
}

/**
 * Logistic Regression - Global Tests Table
 */
function buildLogisticGlobalTestsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const modelFit = result.model_fit as {
    lr_chi2: number;
    lr_df: number;
    lr_p: number;
    wald_chi2: number;
    wald_df: number;
    wald_p: number;
    score_chi2?: number;
    score_p?: number;
  };
  const scoreDf = modelFit.lr_df ?? modelFit.wald_df;

  // Header row
  rows.push({
    cells: [
      { value: 'Test', isHeader: true, align: 'left' },
      { value: 'Chi-Square', isHeader: true, align: 'right' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 'Pr > ChiSq', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Likelihood Ratio
  rows.push({
    cells: [
      { value: 'Likelihood Ratio', align: 'left' },
      { value: formatNumber(modelFit.lr_chi2, d), align: 'right', attrs: { 'data-stat': 'lr_chi2', 'data-value': String(modelFit.lr_chi2) } },
      { value: formatDF(modelFit.lr_df), align: 'right', attrs: { 'data-stat': 'lr_df', 'data-value': String(modelFit.lr_df) } },
      { value: formatPValue(modelFit.lr_p, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: modelFit.lr_p < options.alpha, attrs: { 'data-stat': 'lr_p', 'data-value': String(modelFit.lr_p) } },
    ],
  });

  // Wald
  rows.push({
    cells: [
      { value: 'Wald', align: 'left' },
      { value: formatNumber(modelFit.wald_chi2, d), align: 'right', attrs: { 'data-stat': 'wald_chi2', 'data-value': String(modelFit.wald_chi2) } },
      { value: formatDF(modelFit.wald_df), align: 'right', attrs: { 'data-stat': 'wald_df', 'data-value': String(modelFit.wald_df) } },
      { value: formatPValue(modelFit.wald_p, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: modelFit.wald_p < options.alpha, attrs: { 'data-stat': 'wald_p', 'data-value': String(modelFit.wald_p) } },
    ],
  });

  // Score (if available)
  const hasScore =
    modelFit.score_chi2 !== undefined &&
    modelFit.score_chi2 !== null &&
    Number.isFinite(modelFit.score_chi2) &&
    modelFit.score_p !== undefined &&
    modelFit.score_p !== null &&
    Number.isFinite(modelFit.score_p);
  if (hasScore) {
    rows.push({
      cells: [
        { value: 'Score', align: 'left' },
        { value: formatNumber(modelFit.score_chi2, d), align: 'right', attrs: { 'data-stat': 'score_chi2', 'data-value': String(modelFit.score_chi2) } },
        { value: '.', align: 'right', attrs: { 'data-stat': 'score_df', 'data-value': String(scoreDf) } },
        { value: formatPValue(modelFit.score_p, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (modelFit.score_p || 1) < options.alpha, attrs: { 'data-stat': 'score_p', 'data-value': String(modelFit.score_p) } },
      ],
    });
  }

  return {
    title: 'Testing Global Null Hypothesis: BETA=0',
    columns: [
      { key: 'test', header: 'Test', align: 'left', width: 20 },
      { key: 'chi2', header: 'Chi-Square', align: 'right', width: 12, format: 'decimal' },
      { key: 'df', header: 'DF', align: 'right', width: 6 },
      { key: 'p', header: 'Pr > ChiSq', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    testName: 'logistic_global_tests',
  };
}

/**
 * Logistic Regression - Pseudo R-Square Table
 */
function buildPseudoRSquareTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const pseudoR2 = result.pseudo_r2 as {
    mcfadden: number;
    cox_snell: number;
    nagelkerke: number;
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

  // McFadden
  rows.push({
    cells: [
      { value: 'McFadden', align: 'left' },
      { value: formatNumber(pseudoR2.mcfadden, d), align: 'right', attrs: { 'data-stat': 'pseudo_r2' } },
    ],
  });

  // Cox & Snell
  rows.push({
    cells: [
      { value: 'Cox & Snell', align: 'left' },
      { value: formatNumber(pseudoR2.cox_snell, d), align: 'right', attrs: { 'data-stat': 'cox_snell_r2' } },
    ],
  });

  // Nagelkerke
  rows.push({
    cells: [
      { value: 'Nagelkerke', align: 'left' },
      { value: formatNumber(pseudoR2.nagelkerke, d), align: 'right', attrs: { 'data-stat': 'nagelkerke_r2' } },
    ],
  });

  return {
    title: 'Pseudo R-Square',
    columns: [
      { key: 'measure', header: 'Measure', align: 'left', width: 20 },
      { key: 'value', header: 'Value', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    testName: 'logistic_pseudo_r2',
  };
}

/**
 * Logistic Regression - Parameter Estimates Table
 *
 * Python coefficients_table keys: feature, coef, std_err, z_value, p_value, ci_lower, ci_upper
 * Python regression_coefficients keys: term_display, beta, std_error, statistic, p_value, wald_chi2, ci_lower, ci_upper
 */
function buildLogisticParameterEstimatesTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Try coefficients_table first, then regression_coefficients
  const coeffTable = result.coefficients_table as Array<{
    feature: string;
    coef: number;
    std_err: number;
    z_value: number;
    p_value: number;
    ci_lower?: number;
    ci_upper?: number;
  }> | undefined;

  const regressionCoeffs = result.regression_coefficients as Array<{
    term_display: string;
    term: string;
    beta: number;
    std_error: number;
    statistic: number;
    p_value: number;
    wald_chi2?: number;
    ci_lower?: number;
    ci_upper?: number;
  }> | undefined;

  // Normalize to common format
  interface NormalizedCoeff {
    parameter: string;
    estimate: number;
    std_error: number;
    z_value: number;       // Raw z-value for data-stat extraction
    wald_chi2: number;     // z² for ECP-Style display
    p_value: number;
    ci_lower?: number;
    ci_upper?: number;
  }

  let coefficients: NormalizedCoeff[] = [];

  // PRIORITY: Use regression_coefficients first - it includes Intercept
  // coefficients_table only has predictors (excludes intercept)
  if (regressionCoeffs && regressionCoeffs.length > 0) {
    coefficients = regressionCoeffs.map(c => ({
      // Normalize term display, convert "const" to "Intercept"
      parameter: (c.term_display || c.term) === 'const' ? 'Intercept' : (c.term_display || c.term),
      estimate: c.beta,
      std_error: c.std_error,
      z_value: c.statistic,                                     // Raw z for data-stat
      wald_chi2: c.wald_chi2 ?? (c.statistic * c.statistic),    // Use pre-computed or calculate
      p_value: c.p_value,
      ci_lower: c.ci_lower,
      ci_upper: c.ci_upper,
    }));
  } else if (coeffTable && coeffTable.length > 0) {
    coefficients = coeffTable.map(c => ({
      // Normalize "const" to "Intercept" for consistent data-stat naming
      parameter: c.feature === 'const' ? 'Intercept' : c.feature,
      estimate: c.coef,
      std_error: c.std_err,
      z_value: c.z_value,                    // Keep raw z for data-stat
      wald_chi2: c.z_value * c.z_value,      // Wald chi-sq = z^2 for display
      p_value: c.p_value,
      ci_lower: c.ci_lower,
      ci_upper: c.ci_upper,
    }));
  }

  if (coefficients.length === 0) {
    return {
      title: 'Analysis of Maximum Likelihood Estimates',
      columns: [],
      rows: [],
      testName: 'logistic_parameters',
    };
  }

  const ciLevel = Math.round((1 - options.alpha) * 100);
  const hasCIs = coefficients.some(c => c.ci_lower !== undefined);

  // Header row
  const headerCells = [
    { value: 'Parameter', isHeader: true, align: 'left' as const },
    { value: 'Estimate', isHeader: true, align: 'right' as const },
    { value: 'Std Error', isHeader: true, align: 'right' as const },
    { value: 'Wald Chi-Sq', isHeader: true, align: 'right' as const },
    { value: 'Pr > ChiSq', isHeader: true, align: 'right' as const },
  ];

  if (hasCIs) {
    headerCells.push(
      { value: `${ciLevel}% CL Lower`, isHeader: true, align: 'right' as const },
      { value: `${ciLevel}% CL Upper`, isHeader: true, align: 'right' as const }
    );
  }

  rows.push({ cells: headerCells, isHeader: true });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Coefficient rows
  for (const coef of coefficients) {
    const normalizedTerm = sanitizeTerm(coef.parameter);

    const rowCells = [
      { value: coef.parameter, align: 'left' as const },
      { value: formatNumber(coef.estimate, d), align: 'right' as const, attrs: { 'data-stat': `${normalizedTerm}_coef` } },
      { value: formatNumber(coef.std_error, d), align: 'right' as const, attrs: { 'data-stat': `${normalizedTerm}_se` } },
      // Display Wald Chi-Sq (z²) - baseline now outputs Wald Chi-Sq for comparison
      { value: formatNumber(coef.wald_chi2, d), align: 'right' as const, attrs: { 'data-stat': `${normalizedTerm}_z` } },
      { value: formatPValue(coef.p_value, options.pValueThreshold, options.minPValue), align: 'right' as const, isSignificant: coef.p_value < options.alpha, attrs: { 'data-stat': `${normalizedTerm}_p` } },
    ];

    if (hasCIs) {
      rowCells.push(
        { value: formatNumber(coef.ci_lower, d), align: 'right' as const, attrs: { 'data-stat': `${normalizedTerm}_ci_lower` } },
        { value: formatNumber(coef.ci_upper, d), align: 'right' as const, attrs: { 'data-stat': `${normalizedTerm}_ci_upper` } }
      );
    }

    rows.push({ cells: rowCells });
  }

  const columns = [
    { key: 'parameter', header: 'Parameter', align: 'left' as const, width: 20 },
    { key: 'estimate', header: 'Estimate', align: 'right' as const, width: 12, format: 'decimal' as const },
    { key: 'std_err', header: 'Std Error', align: 'right' as const, width: 12, format: 'decimal' as const },
    { key: 'wald', header: 'Wald Chi-Sq', align: 'right' as const, width: 12, format: 'decimal' as const },
    { key: 'p', header: 'Pr > ChiSq', align: 'right' as const, width: 12, format: 'pvalue' as const },
  ];

  if (hasCIs) {
    columns.push(
      { key: 'ci_lower', header: `${ciLevel}% CL Lower`, align: 'right' as const, width: 14, format: 'decimal' as const },
      { key: 'ci_upper', header: `${ciLevel}% CL Upper`, align: 'right' as const, width: 14, format: 'decimal' as const }
    );
  }

  return {
    title: 'Analysis of Maximum Likelihood Estimates',
    columns,
    rows,
    testName: 'logistic_parameters',
  };
}

/**
 * Logistic Regression - Odds Ratio Estimates Table
 *
 * Python coefficients_table keys: feature, odds_ratio, or_ci_lower, or_ci_upper
 * Python regression_coefficients keys: term_display, odds_ratio, or_ci_lower, or_ci_upper
 */
function buildOddsRatioTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Try coefficients_table first, then regression_coefficients
  const coeffTable = result.coefficients_table as Array<{
    feature: string;
    odds_ratio: number;
    or_ci_lower: number;
    or_ci_upper: number;
  }> | undefined;

  const regressionCoeffs = result.regression_coefficients as Array<{
    term_display: string;
    term: string;
    term_type?: string;
    odds_ratio: number;
    or_ci_lower: number;
    or_ci_upper: number;
  }> | undefined;

  // Normalize to common format
  interface NormalizedOR {
    effect: string;
    odds_ratio: number;
    or_ci_lower: number;
    or_ci_upper: number;
    isIntercept: boolean;
  }

  let coefficients: NormalizedOR[] = [];

  if (coeffTable && coeffTable.length > 0) {
    coefficients = coeffTable.map(c => ({
      effect: c.feature,
      odds_ratio: c.odds_ratio,
      or_ci_lower: c.or_ci_lower,
      or_ci_upper: c.or_ci_upper,
      isIntercept: c.feature.toLowerCase() === 'intercept' || c.feature.toLowerCase() === 'const',
    }));
  } else if (regressionCoeffs && regressionCoeffs.length > 0) {
    coefficients = regressionCoeffs.map(c => ({
      effect: c.term_display || c.term,
      odds_ratio: c.odds_ratio,
      or_ci_lower: c.or_ci_lower,
      or_ci_upper: c.or_ci_upper,
      isIntercept: c.term_type === 'intercept' || c.term?.toLowerCase() === 'const',
    }));
  }

  const ciLevel = Math.round((1 - options.alpha) * 100);

  // Header row
  rows.push({
    cells: [
      { value: 'Effect', isHeader: true, align: 'left' },
      { value: 'Point Estimate', isHeader: true, align: 'right' },
      { value: `${ciLevel}% Wald CL Lower`, isHeader: true, align: 'right' },
      { value: `${ciLevel}% Wald CL Upper`, isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Odds ratio rows (skip intercept)
  for (const coef of coefficients) {
    if (coef.isIntercept) {
      continue;
    }

    const normalizedTerm = sanitizeTerm(coef.effect);

    rows.push({
      cells: [
        { value: coef.effect, align: 'left' },
        { value: formatNumber(coef.odds_ratio, d), align: 'right', attrs: { 'data-stat': `${normalizedTerm}_or` } },
        { value: formatNumber(coef.or_ci_lower, d), align: 'right', attrs: { 'data-stat': `${normalizedTerm}_or_ci_lower` } },
        { value: formatNumber(coef.or_ci_upper, d), align: 'right', attrs: { 'data-stat': `${normalizedTerm}_or_ci_upper` } },
      ],
    });
  }

  return {
    title: 'Odds Ratio Estimates',
    columns: [
      { key: 'effect', header: 'Effect', align: 'left', width: 20 },
      { key: 'or', header: 'Point Estimate', align: 'right', width: 14, format: 'decimal' },
      { key: 'or_ci_lower', header: `${ciLevel}% Wald CL Lower`, align: 'right', width: 18, format: 'decimal' },
      { key: 'or_ci_upper', header: `${ciLevel}% Wald CL Upper`, align: 'right', width: 18, format: 'decimal' },
    ],
    rows,
    footnotes: [
      'Note: OR > 1 indicates increased odds; OR < 1 indicates decreased odds.',
    ],
    testName: 'logistic_odds_ratios',
  };
}

// =============================================================================
// MULTINOMIAL LOGISTIC REGRESSION (3+ outcome classes)
// =============================================================================

/**
 * Multinomial Logistic Regression - Parameter Estimates Tables
 *
 * Creates separate parameter tables for each comparison class vs baseline.
 * Python includes class_label field in regression_coefficients.
 */
function buildMultinomialParameterEstimatesTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable[] {
  const d = options.decimalPlaces;
  const tables: ECPTable[] = [];

  const regressionCoeffs = result.regression_coefficients as Array<{
    class_label: string;
    term_display: string;
    term: string;
    term_type?: string;
    beta: number;
    std_error: number;
    statistic: number;
    p_value: number;
    wald_chi2?: number;
    ci_lower?: number;
    ci_upper?: number;
  }> | undefined;

  if (!regressionCoeffs || regressionCoeffs.length === 0) {
    return [];
  }

  const baselineLabel = String(result.baseline_label ?? result.reference_category ?? 'Baseline')

  // Group coefficients by class_label
  const coeffsByClass = new Map<string, typeof regressionCoeffs>();
  for (const coef of regressionCoeffs) {
    const classLabel = String(coef.class_label ?? 'Unknown')
    if (!coeffsByClass.has(classLabel)) {
      coeffsByClass.set(classLabel, []);
    }
    coeffsByClass.get(classLabel)!.push(coef);
  }

  const ciLevel = Math.round((1 - options.alpha) * 100);
  const hasCIs = regressionCoeffs.some(c => c.ci_lower !== undefined);

  // Create a table for each comparison class
  for (const [classLabel, coeffs] of coeffsByClass.entries()) {
    const rows: ECPRow[] = [];
    const classKey = sanitizeClassLabel(classLabel);

    // Header row
    const headerCells = [
      { value: 'Parameter', isHeader: true, align: 'left' as const },
      { value: 'Estimate', isHeader: true, align: 'right' as const },
      { value: 'Std Error', isHeader: true, align: 'right' as const },
      { value: 'Wald Chi-Sq', isHeader: true, align: 'right' as const },
      { value: 'Pr > ChiSq', isHeader: true, align: 'right' as const },
    ];

    if (hasCIs) {
      headerCells.push(
        { value: `${ciLevel}% CL Lower`, isHeader: true, align: 'right' as const },
        { value: `${ciLevel}% CL Upper`, isHeader: true, align: 'right' as const }
      );
    }

    rows.push({ cells: headerCells, isHeader: true });

    // Separator
    rows.push({ cells: [], isSeparator: true });

    // Coefficient rows
    for (const coef of coeffs) {
      const waldChi2 = coef.wald_chi2 ?? (coef.statistic * coef.statistic);
      const termKey = sanitizeTerm(coef.term_display || coef.term);

      const rowCells = [
        { value: coef.term_display, align: 'left' as const },
        { value: formatNumber(coef.beta, d), align: 'right' as const, attrs: { 'data-stat': `${classKey}_${termKey}_coef` } },
        { value: formatNumber(coef.std_error, d), align: 'right' as const, attrs: { 'data-stat': `${classKey}_${termKey}_se` } },
        { value: formatNumber(waldChi2, d), align: 'right' as const, attrs: { 'data-stat': `${classKey}_${termKey}_z` } },
        { value: formatPValue(coef.p_value, options.pValueThreshold, options.minPValue), align: 'right' as const, isSignificant: coef.p_value < options.alpha, attrs: { 'data-stat': `${classKey}_${termKey}_p` } },
      ];

      if (hasCIs) {
        rowCells.push(
          { value: formatNumber(coef.ci_lower, d), align: 'right' as const, attrs: { 'data-stat': `${classKey}_${termKey}_ci_lower` } },
          { value: formatNumber(coef.ci_upper, d), align: 'right' as const, attrs: { 'data-stat': `${classKey}_${termKey}_ci_upper` } }
        );
      }

      rows.push({ cells: rowCells });
    }

    const columns: ECPColumn[] = [
      { key: 'parameter', header: 'Parameter', align: 'left' as const, width: 20 },
      { key: 'estimate', header: 'Estimate', align: 'right' as const, width: 12, format: 'decimal' },
      { key: 'std_err', header: 'Std Error', align: 'right' as const, width: 12, format: 'decimal' },
      { key: 'wald', header: 'Wald Chi-Sq', align: 'right' as const, width: 12, format: 'decimal' },
      { key: 'p', header: 'Pr > ChiSq', align: 'right' as const, width: 12, format: 'pvalue' },
    ];

    if (hasCIs) {
      columns.push(
        { key: 'ci_lower', header: `${ciLevel}% CL Lower`, align: 'right' as const, width: 14, format: 'decimal' },
        { key: 'ci_upper', header: `${ciLevel}% CL Upper`, align: 'right' as const, width: 14, format: 'decimal' }
      );
    }

    tables.push({
      title: `Parameter Estimates - ${classLabel} vs ${baselineLabel}`,
      columns,
      rows,
      testName: `logistic_multinomial_parameters_${classLabel.toLowerCase().replace(/\s+/g, '_')}`,
    });
  }

  return tables;
}

/**
 * Multinomial Logistic Regression - Odds Ratio Tables
 *
 * Creates separate odds ratio tables for each comparison class vs baseline.
 * Python includes class_label field in regression_coefficients.
 */
function buildMultinomialOddsRatioTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable[] {
  const d = options.decimalPlaces;
  const tables: ECPTable[] = [];

  const regressionCoeffs = result.regression_coefficients as Array<{
    class_label: string;
    term_display: string;
    term: string;
    term_type?: string;
    odds_ratio: number;
    or_ci_lower: number;
    or_ci_upper: number;
  }> | undefined;

  if (!regressionCoeffs || regressionCoeffs.length === 0) {
    return [];
  }

  const baselineLabel = String(result.baseline_label ?? result.reference_category ?? 'Baseline')

  // Group coefficients by class_label
  const coeffsByClass = new Map<string, typeof regressionCoeffs>();
  for (const coef of regressionCoeffs) {
    const classLabel = String(coef.class_label ?? 'Unknown')
    if (!coeffsByClass.has(classLabel)) {
      coeffsByClass.set(classLabel, []);
    }
    coeffsByClass.get(classLabel)!.push(coef);
  }

  const ciLevel = Math.round((1 - options.alpha) * 100);

  // Create a table for each comparison class
  for (const [classLabel, coeffs] of coeffsByClass.entries()) {
    const rows: ECPRow[] = [];
    const classKey = sanitizeClassLabel(classLabel);

    // Header row
    rows.push({
      cells: [
        { value: 'Effect', isHeader: true, align: 'left' },
        { value: 'Point Estimate', isHeader: true, align: 'right' },
        { value: `${ciLevel}% Wald CL Lower`, isHeader: true, align: 'right' },
        { value: `${ciLevel}% Wald CL Upper`, isHeader: true, align: 'right' },
      ],
      isHeader: true,
    });

    // Separator
    rows.push({ cells: [], isSeparator: true });

    // Odds ratio rows (skip intercept)
    for (const coef of coeffs) {
      const isIntercept = coef.term_type === 'intercept' || coef.term?.toLowerCase() === 'const';
      if (isIntercept) {
        continue;
      }
      const termKey = sanitizeTerm(coef.term_display || coef.term);

      rows.push({
        cells: [
          { value: coef.term_display, align: 'left' },
          { value: formatNumber(coef.odds_ratio, d), align: 'right', attrs: { 'data-stat': `${classKey}_${termKey}_or` } },
          { value: formatNumber(coef.or_ci_lower, d), align: 'right', attrs: { 'data-stat': `${classKey}_${termKey}_or_ci_lower` } },
          { value: formatNumber(coef.or_ci_upper, d), align: 'right', attrs: { 'data-stat': `${classKey}_${termKey}_or_ci_upper` } },
        ],
      });
    }

    tables.push({
      title: `Odds Ratio Estimates - ${classLabel} vs ${baselineLabel}`,
      columns: [
        { key: 'effect', header: 'Effect', align: 'left', width: 20 },
        { key: 'or', header: 'Point Estimate', align: 'right', width: 14, format: 'decimal' },
        { key: 'or_ci_lower', header: `${ciLevel}% Wald CL Lower`, align: 'right', width: 18, format: 'decimal' },
        { key: 'or_ci_upper', header: `${ciLevel}% Wald CL Upper`, align: 'right', width: 18, format: 'decimal' },
      ],
      rows,
      footnotes: [
        `Note: Odds ratios compare ${classLabel} to ${baselineLabel}.`,
        'OR > 1 indicates increased odds; OR < 1 indicates decreased odds.',
      ],
      testName: `logistic_multinomial_odds_ratios_${classLabel.toLowerCase().replace(/\s+/g, '_')}`,
    });
  }

  return tables;
}

/**
 * Logistic Regression - Hosmer-Lemeshow Test Table
 */
function buildHosmerLemeshowTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const hl = result.hosmer_lemeshow as {
    chi2: number;
    df: number;
    p_value: number;
    p?: number;
  };
  const pValue = (hl.p_value ?? hl.p) as number | undefined;
  const isSignificant = typeof pValue === 'number' && pValue < options.alpha;

  // Header row
  rows.push({
    cells: [
      { value: 'Chi-Square', isHeader: true, align: 'right' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 'Pr > ChiSq', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Test result row
  rows.push({
    cells: [
      { value: formatNumber(hl.chi2, d), align: 'right', attrs: { 'data-stat': 'hosmer_lemeshow_chi2', 'data-value': String(hl.chi2) } },
      { value: formatDF(hl.df), align: 'right', attrs: { 'data-stat': 'hosmer_lemeshow_df', 'data-value': String(hl.df) } },
      { value: formatPValue(pValue, options.pValueThreshold, options.minPValue), align: 'right', isSignificant, attrs: { 'data-stat': 'hosmer_lemeshow_p', 'data-value': String(pValue) } },
    ],
  });

  return {
    title: 'Hosmer and Lemeshow Goodness-of-Fit Test',
    columns: [
      { key: 'chi2', header: 'Chi-Square', align: 'right', width: 12, format: 'decimal' },
      { key: 'df', header: 'DF', align: 'right', width: 6 },
      { key: 'p', header: 'Pr > ChiSq', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    footnotes: [
      'Note: p > 0.05 indicates adequate fit (non-significant = good).',
    ],
    testName: 'logistic_hosmer_lemeshow',
  };
}

/**
 * Logistic Regression - Classification Table
 */
function buildClassificationTable(
  result: Record<string, unknown>,
  _options: Required<TableBuilderOptions>
): ECPTable {
  const d = 2; // Percentage values with 2 decimal places
  // Note: _options reserved for future customization
  const rows: ECPRow[] = [];
  const classification = result.classification as {
    accuracy?: number;
    sensitivity?: number;
    specificity?: number;
    precision?: number;
    f1_score?: number;
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

  // Accuracy
  if (classification.accuracy !== undefined) {
    rows.push({
      cells: [
        { value: 'Accuracy', align: 'left' },
        { value: `${formatNumber(classification.accuracy * 100, d)}%`, align: 'right', attrs: { 'data-stat': 'accuracy', 'data-value': String(classification.accuracy) } },
      ],
    });
  }

  // Sensitivity
  if (classification.sensitivity !== undefined) {
    rows.push({
      cells: [
        { value: 'Sensitivity', align: 'left' },
        { value: `${formatNumber(classification.sensitivity * 100, d)}%`, align: 'right', attrs: { 'data-stat': 'sensitivity', 'data-value': String(classification.sensitivity) } },
      ],
    });
  }

  // Specificity
  if (classification.specificity !== undefined) {
    rows.push({
      cells: [
        { value: 'Specificity', align: 'left' },
        { value: `${formatNumber(classification.specificity * 100, d)}%`, align: 'right', attrs: { 'data-stat': 'specificity', 'data-value': String(classification.specificity) } },
      ],
    });
  }

  // Precision (if available)
  if (classification.precision !== undefined) {
    rows.push({
      cells: [
        { value: 'Precision', align: 'left' },
        { value: `${formatNumber(classification.precision * 100, d)}%`, align: 'right', attrs: { 'data-stat': 'precision', 'data-value': String(classification.precision) } },
      ],
    });
  }

  // F1 Score (if available)
  if (classification.f1_score !== undefined) {
    rows.push({
      cells: [
        { value: 'F1 Score', align: 'left' },
        { value: formatNumber(classification.f1_score, 4), align: 'right', attrs: { 'data-stat': 'f1_score', 'data-value': String(classification.f1_score) } },
      ],
    });
  }

  return {
    title: 'Classification Table',
    columns: [
      { key: 'measure', header: 'Measure', align: 'left', width: 16 },
      { key: 'value', header: 'Value', align: 'right', width: 12, format: 'percent' },
    ],
    rows,
    testName: 'logistic_classification',
  };
}


