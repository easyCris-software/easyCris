/**
 * Survival Analysis ECP-Style Table Builder
 *
 * Maps validated Python JSON output to ECP-Style tables:
 * - Kaplan-Meier from survival.kaplan_meier_analysis
 * - Cox Proportional Hazards from survival.cox_proportional_hazards
 * - Nelson-Aalen from survival.nelson_aalen_cumulative_hazard
 *
 * Includes Hazard Ratio tables for Cox regression.
 */

import type {
  ECPTable,
  ECPTableCollection,
  ECPRow,
  TableBuilderOptions,
} from '../../types/ecpStyleTables';
import { formatNumber, formatPValue, formatDF } from './index';

// =============================================================================
// HELPER FUNCTIONS FOR E2E VALIDATION
// =============================================================================

/**
 * Normalize stratum name for data-stat attribute
 * Examples:
 * - "Treatment" -> "treatment"
 * - "Control Group" -> "control_group"
 */
function normalizeStratumName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_');
}

/**
 * Normalize covariate/parameter name for data-stat attribute
 * Examples:
 * - "age" -> "age"
 * - "patient age" -> "patient_age"
 */
function normalizeCovariateTermSurvival(term: string): string {
  return term.toLowerCase().replace(/\s+/g, '_');
}

/**
 * Normalize time value for data-stat key (replaces . with _)
 * Examples:
 * - 10 -> "10"
 * - 10.5 -> "10_5"
 */
function normalizeTimeKey(time: number): string {
  return String(time).replace('.', '_');
}

// =============================================================================
// KAPLAN-MEIER
// =============================================================================

/**
 * Build ECP-Style tables for Kaplan-Meier results
 */
export function buildKaplanMeierTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Table 1: Summary Statistics
  tables.push(buildKMSummaryTable(result, options));

  // Table 2: Quartile Estimates (if strata available)
  if (result.strata) {
    tables.push(buildKMQuartileTable(result, options));
  }

  // Table 3: Homogeneity Test / Log-Rank Test (if comparing groups)
  // Note: Python backend uses 'homogeneity_test', not 'log_rank_test'
  if (result.homogeneity_test) {
    tables.push(buildHomogeneityTestTable(result, options));
  }

  // Extract sample size from either overall (stratified) or summary_of_subjects (single-group)
  const summaryOfSubjects = result.summary_of_subjects as { total?: number } | undefined;
  const sampleSize = (result.overall as Record<string, number>)?.n_total ?? summaryOfSubjects?.total;

  return {
    testType: 'kaplan_meier',
    testFamily: 'survival',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize,
    },
  };
}

/**
 * Kaplan-Meier - Summary Statistics Table
 */
function buildKMSummaryTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Extract event encoding info for footnote
  const eventLabels = result.event_labels as { event?: string; censored?: string; was_encoded?: boolean } | undefined;

  // Python returns different structure for single-group vs stratified:
  // - Single group (2 cols): summary_of_subjects + direct median fields
  // - Stratified (3 cols): overall + strata array
  const summaryOfSubjects = result.summary_of_subjects as { total?: number; event?: number; censored?: number } | undefined;
  const strata = result.strata as Array<{
    stratum: string;
    n_total: number;
    n_events: number;
    n_censored: number;
    median_survival?: number;
    median_ci_lower_95?: number;
    median_ci_upper_95?: number;
  }> | undefined;

  // Header row
  rows.push({
    cells: [
      { value: 'Stratum', isHeader: true, align: 'left' },
      { value: 'N', isHeader: true, align: 'right' },
      { value: 'N Events', isHeader: true, align: 'right' },
      { value: 'N Censored', isHeader: true, align: 'right' },
      { value: 'Median', isHeader: true, align: 'right' },
      { value: '95% CL Lower', isHeader: true, align: 'right' },
      { value: '95% CL Upper', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Strata rows (if available)
  if (strata && strata.length > 0) {
    // Add overall totals row for stratified output (ECP-Style summary)
    if (summaryOfSubjects) {
      rows.push({
        cells: [
          { value: 'Overall', align: 'left' },
          { value: summaryOfSubjects.total ?? '.', format: 'integer', align: 'right', attrs: { 'data-stat': 'n_total' } },
          { value: summaryOfSubjects.event ?? '.', format: 'integer', align: 'right', attrs: { 'data-stat': 'n_events' } },
          { value: summaryOfSubjects.censored ?? '.', format: 'integer', align: 'right', attrs: { 'data-stat': 'n_censored' } },
          { value: '.', align: 'right' },
          { value: '.', align: 'right' },
          { value: '.', align: 'right' },
        ],
      });
    }

    for (const s of strata) {
      const stratumKey = normalizeStratumName(s.stratum);
      rows.push({
        cells: [
          { value: s.stratum, align: 'left' },
          { value: s.n_total, format: 'integer', align: 'right', attrs: { 'data-stat': `n_${stratumKey}` } },
          { value: s.n_events, format: 'integer', align: 'right', attrs: { 'data-stat': `n_events_${stratumKey}` } },
          { value: s.n_censored, format: 'integer', align: 'right', attrs: { 'data-stat': `n_censored_${stratumKey}` } },
          { value: s.median_survival !== undefined ? formatNumber(s.median_survival, d) : '.', align: 'right', attrs: { 'data-stat': `median_${stratumKey}` } },
          { value: s.median_ci_lower_95 !== undefined ? formatNumber(s.median_ci_lower_95, d) : '.', align: 'right', attrs: { 'data-stat': `median_ci_lower_${stratumKey}` } },
          { value: s.median_ci_upper_95 !== undefined ? formatNumber(s.median_ci_upper_95, d) : '.', align: 'right', attrs: { 'data-stat': `median_ci_upper_${stratumKey}` } },
        ],
      });
    }
  } else {
    // Single-group case: extract from summary_of_subjects + direct fields
    const nTotal = summaryOfSubjects?.total ?? 0;
    const nEvents = summaryOfSubjects?.event ?? 0;
    const nCensored = summaryOfSubjects?.censored ?? 0;
    const medianSurvival = result.median_survival as number | undefined;
    const medianCiLower = result.median_ci_lower_95 as number | undefined;
    const medianCiUpper = result.median_ci_upper_95 as number | undefined;

    rows.push({
      cells: [
        { value: 'Overall', align: 'left' },
        { value: nTotal, format: 'integer', align: 'right', attrs: { 'data-stat': 'n_total' } },
        { value: nEvents, format: 'integer', align: 'right', attrs: { 'data-stat': 'n_events' } },
        { value: nCensored, format: 'integer', align: 'right', attrs: { 'data-stat': 'n_censored' } },
        { value: medianSurvival !== undefined ? formatNumber(medianSurvival, d) : '.', align: 'right', attrs: { 'data-stat': 'median_survival' } },
        { value: medianCiLower !== undefined ? formatNumber(medianCiLower, d) : '.', align: 'right', attrs: { 'data-stat': 'median_ci_lower' } },
        { value: medianCiUpper !== undefined ? formatNumber(medianCiUpper, d) : '.', align: 'right', attrs: { 'data-stat': 'median_ci_upper' } },
      ],
    });
  }

  // Build footnotes array
  const footnotes: string[] = [];

  // Always show time unit independence footnote
  footnotes.push('Time is unit independent and based on your data');

  if (eventLabels?.was_encoded && eventLabels.event && eventLabels.censored) {
    footnotes.push(`Event Encoding: "${eventLabels.event}" = event occurred, "${eventLabels.censored}" = censored`);
  }

  return {
    title: 'Summary Statistics for Time Variable',
    procedure: 'Survival Analysis',
    columns: [
      { key: 'stratum', header: 'Stratum', align: 'left', width: 16 },
      { key: 'n', header: 'N', align: 'right', width: 8, format: 'integer' },
      { key: 'events', header: 'N Events', align: 'right', width: 10, format: 'integer' },
      { key: 'censored', header: 'N Censored', align: 'right', width: 12, format: 'integer' },
      { key: 'median', header: 'Median', align: 'right', width: 10, format: 'decimal' },
      { key: 'ci_lower', header: '95% CL Lower', align: 'right', width: 14, format: 'decimal' },
      { key: 'ci_upper', header: '95% CL Upper', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'km_summary',
    ...(footnotes.length > 0 && { footnotes }),
  };
}

/**
 * Kaplan-Meier - Quartile Estimates Table
 */
function buildKMQuartileTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const strata = result.strata as Array<{
    stratum: string;
    quartile_estimates?: Array<{
      percent: number;
      estimate: number;
      ci_lower_95?: number;
      ci_upper_95?: number;
    }>;
  }>;

  // Header row
  rows.push({
    cells: [
      { value: 'Stratum', isHeader: true, align: 'left' },
      { value: 'Percent', isHeader: true, align: 'right' },
      { value: 'Estimate', isHeader: true, align: 'right' },
      { value: '95% CL Lower', isHeader: true, align: 'right' },
      { value: '95% CL Upper', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Quartile rows for each stratum
  for (const s of strata) {
    if (s.quartile_estimates) {
      for (const q of s.quartile_estimates) {
        rows.push({
          cells: [
            { value: s.stratum, align: 'left' },
            { value: q.percent, format: 'integer', align: 'right' },
            { value: formatNumber(q.estimate, d), align: 'right' },
            { value: q.ci_lower_95 !== undefined ? formatNumber(q.ci_lower_95, d) : '.', align: 'right' },
            { value: q.ci_upper_95 !== undefined ? formatNumber(q.ci_upper_95, d) : '.', align: 'right' },
          ],
        });
      }
    }
  }

  return {
    title: 'Quartile Estimates',
    columns: [
      { key: 'stratum', header: 'Stratum', align: 'left', width: 16 },
      { key: 'percent', header: 'Percent', align: 'right', width: 10, format: 'integer' },
      { key: 'estimate', header: 'Estimate', align: 'right', width: 12, format: 'decimal' },
      { key: 'ci_lower', header: '95% CL Lower', align: 'right', width: 14, format: 'decimal' },
      { key: 'ci_upper', header: '95% CL Upper', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'km_quartiles',
  };
}

/**
 * Kaplan-Meier - Homogeneity Test Table (Log-Rank)
 *
 * Maps from homogeneity_test JSON structure:
 * - test_name: "Log-Rank"
 * - chi_square, df, p_value, significant
 * - stratum_details[]: stratum, display_label, is_reference, observed_events
 */
function buildHomogeneityTestTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const homogeneityTest = result.homogeneity_test as {
    test_name: string;
    chi_square: number;
    df: number;
    p_value: number;
    significant: boolean;
    stratum_details?: Array<{
      stratum: string;
      display_label: string;
      is_reference: boolean;
      observed_events: number;
    }>;
  };

  // Main test header row
  rows.push({
    cells: [
      { value: 'Test', isHeader: true, align: 'left' },
      { value: 'Chi-Square', isHeader: true, align: 'right' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 'Pr > Chi-Square', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Test result row (use test_name from JSON, defaults to "Log-Rank")
  // Map Python keys to baseline keys for E2E validation
  rows.push({
    cells: [
      { value: homogeneityTest.test_name || 'Log-Rank', align: 'left' },
      { value: formatNumber(homogeneityTest.chi_square, d), align: 'right', attrs: { 'data-stat': 'logrank_chi2' } },
      { value: formatDF(homogeneityTest.df), align: 'right', attrs: { 'data-stat': 'logrank_df' } },
      { value: formatPValue(homogeneityTest.p_value, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: homogeneityTest.p_value < options.alpha, attrs: { 'data-stat': 'logrank_p' } },
    ],
  });

  // Stratum details section (if available)
  if (homogeneityTest.stratum_details && homogeneityTest.stratum_details.length > 0) {
    rows.push({ cells: [], isSeparator: true });

    // Stratum details header
    rows.push({
      cells: [
        { value: 'Stratum Details', isHeader: true, colSpan: 4, align: 'left', isBold: true },
      ],
      isSubheader: true,
    });

    rows.push({
      cells: [
        { value: 'Stratum', isHeader: true, align: 'left' },
        { value: 'Display Label', isHeader: true, align: 'left' },
        { value: 'Reference', isHeader: true, align: 'center' },
        { value: 'Observed Events', isHeader: true, align: 'right' },
      ],
      isHeader: true,
    });

    rows.push({ cells: [], isSeparator: true });

    for (const stratum of homogeneityTest.stratum_details) {
      rows.push({
        cells: [
          { value: stratum.stratum, align: 'left' },
          { value: stratum.display_label, align: 'left' },
          { value: stratum.is_reference ? 'Yes' : 'No', align: 'center' },
          { value: stratum.observed_events, format: 'integer', align: 'right' },
        ],
      });
    }
  }

  return {
    title: 'Test of Equality over Strata',
    columns: [
      { key: 'test', header: 'Test', align: 'left', width: 12 },
      { key: 'chi2', header: 'Chi-Square', align: 'right', width: 12, format: 'decimal' },
      { key: 'df', header: 'DF', align: 'right', width: 6 },
      { key: 'p', header: 'Pr > Chi-Square', align: 'right', width: 16, format: 'pvalue' },
    ],
    rows,
    testName: 'km_homogeneity',
  };
}

// =============================================================================
// COX PROPORTIONAL HAZARDS
// =============================================================================

/**
 * Build ECP-Style tables for Cox Regression results
 * Includes Hazard Ratio estimates
 */
export function buildCoxRegressionTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Table 0: Model Information (sample size, events, censoring, ties)
  if (result.model_information) {
    tables.push(buildCoxModelInformationTable(result, options));
  }

  // Table 1: Model Fit Statistics
  if (result.model_fit_statistics) {
    tables.push(buildCoxModelFitTable(result, options));
  }

  // Table 2: Global Tests
  if (result.testing_global_null) {
    tables.push(buildCoxGlobalTestsTable(result, options));
  }

  // Table 3: Parameter Estimates with Hazard Ratios
  if (result.parameter_estimates) {
    tables.push(buildCoxParameterEstimatesTable(result, options));
  }

  // Table 4: Concordance Statistics
  if (result.association_statistics) {
    tables.push(buildConcordanceTable(result, options));
  }

  return {
    testType: 'cox_regression',
    testFamily: 'survival',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
    },
  };
}

/**
 * Cox Regression - Model Information Table
 */
function buildCoxModelInformationTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const modelInfo = result.model_information as {
    dependent_variable?: string;
    n_observations_read?: number;
    n_observations_used?: number;
    n_events?: number;
    n_censored?: number;
    percent_censored?: number;
    ties_handling?: string;
    time_unit?: string;
  };

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
      { value: 'Dependent Variable', align: 'left' },
      { value: modelInfo.dependent_variable ?? '.', align: 'right' },
    ],
  });
  rows.push({
    cells: [
      { value: 'Observations Read', align: 'left' },
      { value: modelInfo.n_observations_read ?? '.', align: 'right', attrs: { 'data-stat': 'n_observations_read' } },
    ],
  });
  rows.push({
    cells: [
      { value: 'Observations Used', align: 'left' },
      { value: modelInfo.n_observations_used ?? '.', align: 'right', attrs: { 'data-stat': 'n_observations_used' } },
    ],
  });
  rows.push({
    cells: [
      { value: 'Events', align: 'left' },
      { value: modelInfo.n_events ?? '.', align: 'right', attrs: { 'data-stat': 'n_events' } },
    ],
  });
  rows.push({
    cells: [
      { value: 'Censored', align: 'left' },
      { value: modelInfo.n_censored ?? '.', align: 'right', attrs: { 'data-stat': 'n_censored' } },
    ],
  });
  rows.push({
    cells: [
      { value: 'Percent Censored', align: 'left' },
      { value: formatNumber(modelInfo.percent_censored as number, d), align: 'right', attrs: { 'data-stat': 'percent_censored' } },
    ],
  });
  rows.push({
    cells: [
      { value: 'Ties Handling', align: 'left' },
      { value: modelInfo.ties_handling ?? '.', align: 'right' },
    ],
  });
  rows.push({
    cells: [
      { value: 'Time Unit', align: 'left' },
      { value: modelInfo.time_unit ?? '.', align: 'right' },
    ],
  });

  return {
    title: 'Model Information',
    procedure: 'Cox Regression Analysis',
    columns: [
      { key: 'statistic', header: 'Statistic', align: 'left', width: 24 },
      { key: 'value', header: 'Value', align: 'right', width: 16, format: 'decimal' },
    ],
    rows,
    testName: 'cox_model_information',
  };
}

/**
 * Cox Regression - Model Fit Statistics Table
 */
function buildCoxModelFitTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const modelFitStats = result.model_fit_statistics as {
    criterion: {
      minus2logL_without_covariates: number;
      minus2logL_with_covariates: number;
      aic_without_covariates?: number;
      aic_with_covariates?: number;
      sbc_without_covariates?: number;
      sbc_with_covariates?: number;
      aic?: number;
      sbc?: number;
      criteria_basis?: string;
    };
  };
  const criterion = modelFitStats.criterion;

  // Header row
  rows.push({
    cells: [
      { value: 'Criterion', isHeader: true, align: 'left' },
      { value: 'Without Covariates', isHeader: true, align: 'right' },
      { value: 'With Covariates', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // -2 LOG L
  rows.push({
    cells: [
      { value: '-2 LOG L', align: 'left' },
      { value: formatNumber(criterion.minus2logL_without_covariates, d), align: 'right', attrs: { 'data-stat': 'minus2logl_null' } },
      { value: formatNumber(criterion.minus2logL_with_covariates, d), align: 'right', attrs: { 'data-stat': 'minus2logl_model' } },
    ],
  });

  // AIC
  rows.push({
    cells: [
      { value: 'AIC', align: 'left' },
      {
        value: criterion.aic_without_covariates == null
          ? 'N/A'
          : formatNumber(criterion.aic_without_covariates, d),
        align: 'right',
        attrs: { 'data-stat': 'aic_null' },
      },
      {
        value: formatNumber(criterion.aic_with_covariates ?? criterion.aic, d),
        align: 'right',
        attrs: { 'data-stat': 'aic' },
      },
    ],
  });

  // BIC (Python returns "sbc")
  rows.push({
    cells: [
      { value: 'BIC', align: 'left' },
      {
        value: criterion.sbc_without_covariates == null
          ? 'N/A'
          : formatNumber(criterion.sbc_without_covariates, d),
        align: 'right',
        attrs: { 'data-stat': 'bic_null' },
      },
      {
        value: formatNumber(criterion.sbc_with_covariates ?? criterion.sbc, d),
        align: 'right',
        attrs: { 'data-stat': 'bic' },
      },
    ],
  });

  return {
    title: 'Model Fit Statistics',
    procedure: 'Cox Regression Analysis',
    columns: [
      { key: 'criterion', header: 'Criterion', align: 'left', width: 16 },
      { key: 'without', header: 'Without Covariates', align: 'right', width: 20, format: 'decimal' },
      { key: 'with', header: 'With Covariates', align: 'right', width: 18, format: 'decimal' },
    ],
    rows,
    footnotes: [
      criterion.criteria_basis === 'partial_likelihood'
        ? 'AIC/BIC and -2 Log L are based on Cox partial likelihood. Null model has no covariate parameters (k=0), so AIC and BIC equal -2 Log L.'
        : 'Model fit criteria are reported from Cox regression output.',
    ],
    testName: 'cox_model_fit',
  };
}

/**
 * Cox Regression - Global Tests Table
 */
function buildCoxGlobalTestsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const testingGlobalNull = result.testing_global_null as {
    likelihood_ratio?: {
      chi_square: number;
      df: number;
      p_value: number;
    };
    wald?: {
      chi_square: number;
      df: number;
      p_value: number;
    };
    score?: {
      chi_square: number;
      df: number;
      p_value: number;
    };
  };

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
  if (testingGlobalNull.likelihood_ratio) {
    const lr = testingGlobalNull.likelihood_ratio;
    rows.push({
      cells: [
        { value: 'Likelihood Ratio', align: 'left' },
        { value: formatNumber(lr.chi_square, d), align: 'right', attrs: { 'data-stat': 'lr_chi2' } },
        { value: formatDF(lr.df), align: 'right', attrs: { 'data-stat': 'lr_df' } },
        { value: formatPValue(lr.p_value, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: lr.p_value < options.alpha, attrs: { 'data-stat': 'lr_p' } },
      ],
    });
  }

  // Score (may not always be present)
  if (testingGlobalNull.score) {
    const score = testingGlobalNull.score;
    rows.push({
      cells: [
        { value: 'Score', align: 'left' },
        { value: formatNumber(score.chi_square, d), align: 'right', attrs: { 'data-stat': 'score_chi2' } },
        { value: formatDF(score.df), align: 'right', attrs: { 'data-stat': 'score_df' } },
        { value: formatPValue(score.p_value, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: score.p_value < options.alpha, attrs: { 'data-stat': 'score_p' } },
      ],
    });
  }

  // Wald
  if (testingGlobalNull.wald) {
    const wald = testingGlobalNull.wald;
    rows.push({
      cells: [
        { value: 'Wald', align: 'left' },
        { value: formatNumber(wald.chi_square, d), align: 'right', attrs: { 'data-stat': 'wald_chi2' } },
        { value: formatDF(wald.df), align: 'right', attrs: { 'data-stat': 'wald_df' } },
        { value: formatPValue(wald.p_value, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: wald.p_value < options.alpha, attrs: { 'data-stat': 'wald_p' } },
      ],
    });
  }

  return {
    title: 'Testing Global Null Hypothesis: BETA=0',
    columns: [
      { key: 'test', header: 'Test', align: 'left', width: 18 },
      { key: 'chi2', header: 'Chi-Square', align: 'right', width: 12, format: 'decimal' },
      { key: 'df', header: 'DF', align: 'right', width: 6 },
      { key: 'p', header: 'Pr > ChiSq', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    testName: 'cox_global_tests',
  };
}

/**
 * Cox Regression - Parameter Estimates with Hazard Ratios Table
 */
function buildCoxParameterEstimatesTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Extract event encoding info for footnote
  const eventLabels = result.event_labels as { event?: string; censored?: string; was_encoded?: boolean } | undefined;

  const parameterEstimates = result.parameter_estimates as Array<{
    parameter: string;
    df: number;
    estimate: number;
    std_error: number;
    chi_square: number;
    p_value: number;
    hazard_ratio: number;
    hr_ci_lower_95: number;
    hr_ci_upper_95: number;
  }>;

  const ciLevel = Math.round((1 - options.alpha) * 100);

  // Header row
  rows.push({
    cells: [
      { value: 'Parameter', isHeader: true, align: 'left' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 'Estimate', isHeader: true, align: 'right' },
      { value: 'Std Error', isHeader: true, align: 'right' },
      { value: 'Chi-Sq', isHeader: true, align: 'right' },
      { value: 'Pr > ChiSq', isHeader: true, align: 'right' },
      { value: 'Hazard Ratio', isHeader: true, align: 'right' },
      { value: `${ciLevel}% HR CL Lower`, isHeader: true, align: 'right' },
      { value: `${ciLevel}% HR CL Upper`, isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Coefficient rows with hazard ratios
  // Each row gets data-stat attributes with normalized covariate name prefix
  for (const param of parameterEstimates) {
    const paramKey = normalizeCovariateTermSurvival(param.parameter);
    rows.push({
      cells: [
        { value: param.parameter, align: 'left' },
        { value: formatDF(param.df), align: 'right', attrs: { 'data-stat': `${paramKey}_df` } },
        { value: formatNumber(param.estimate, d), align: 'right', attrs: { 'data-stat': `${paramKey}_coef` } },
        { value: formatNumber(param.std_error, d), align: 'right', attrs: { 'data-stat': `${paramKey}_se` } },
        { value: formatNumber(param.chi_square, d), align: 'right', attrs: { 'data-stat': `${paramKey}_chi2` } },
        { value: formatPValue(param.p_value, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: param.p_value < options.alpha, attrs: { 'data-stat': `${paramKey}_p` } },
        { value: formatNumber(param.hazard_ratio, d), align: 'right', isBold: true, attrs: { 'data-stat': `${paramKey}_hr` } },
        { value: formatNumber(param.hr_ci_lower_95, d), align: 'right', attrs: { 'data-stat': `${paramKey}_hr_ci_lower` } },
        { value: formatNumber(param.hr_ci_upper_95, d), align: 'right', attrs: { 'data-stat': `${paramKey}_hr_ci_upper` } },
      ],
    });
  }

  // Build footnotes array
  const footnotes: string[] = [
    'Time is unit independent and based on your data',
    'Note: HR > 1 indicates increased hazard (higher risk); HR < 1 indicates decreased hazard (protective).',
  ];
  if (eventLabels?.was_encoded && eventLabels.event && eventLabels.censored) {
    footnotes.push(`Event Encoding: "${eventLabels.event}" = event occurred, "${eventLabels.censored}" = censored`);
  }

  return {
    title: 'Analysis of Maximum Likelihood Estimates',
    columns: [
      { key: 'parameter', header: 'Parameter', align: 'left', width: 16 },
      { key: 'df', header: 'DF', align: 'right', width: 6 },
      { key: 'estimate', header: 'Estimate', align: 'right', width: 12, format: 'decimal' },
      { key: 'std_err', header: 'Std Error', align: 'right', width: 12, format: 'decimal' },
      { key: 'chi2', header: 'Chi-Sq', align: 'right', width: 10, format: 'decimal' },
      { key: 'p', header: 'Pr > ChiSq', align: 'right', width: 12, format: 'pvalue' },
      { key: 'hr', header: 'Hazard Ratio', align: 'right', width: 14, format: 'decimal' },
      { key: 'hr_ci_lower', header: `${ciLevel}% HR CL Lower`, align: 'right', width: 16, format: 'decimal' },
      { key: 'hr_ci_upper', header: `${ciLevel}% HR CL Upper`, align: 'right', width: 16, format: 'decimal' },
    ],
    rows,
    footnotes,
    testName: 'cox_parameters',
  };
}

/**
 * Cox Regression - Concordance Statistics Table
 */
function buildConcordanceTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const associationStats = result.association_statistics as {
    concordance_index: number;
    concordance_se: number;
    n_bootstrap?: number;
    bootstrap_seed?: number;
    somers_d?: number;
    gamma?: number;
    tau_a?: number;
  };

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

  // C-index
  rows.push({
    cells: [
      { value: 'Concordance Index (c)', align: 'left' },
      { value: formatNumber(associationStats.concordance_index, d), align: 'right', attrs: { 'data-stat': 'concordance' } },
    ],
  });

  // Standard Error
  rows.push({
    cells: [
      { value: 'Standard Error', align: 'left' },
      { value: formatNumber(associationStats.concordance_se, d), align: 'right', attrs: { 'data-stat': 'concordance_se' } },
    ],
  });

  // Somers' D (if available)
  if (associationStats.somers_d !== undefined && associationStats.somers_d !== null) {
    rows.push({
      cells: [
        { value: "Somers' D", align: 'left' },
        { value: formatNumber(associationStats.somers_d, d), align: 'right', attrs: { 'data-stat': 'somers_d' } },
      ],
    });
  }

  // Gamma (if available)
  if (associationStats.gamma !== undefined && associationStats.gamma !== null) {
    rows.push({
      cells: [
        { value: 'Gamma', align: 'left' },
        { value: formatNumber(associationStats.gamma, d), align: 'right', attrs: { 'data-stat': 'gamma' } },
      ],
    });
  }

  // Tau-a (if available)
  if (associationStats.tau_a !== undefined && associationStats.tau_a !== null) {
    rows.push({
      cells: [
        { value: 'Tau-a', align: 'left' },
        { value: formatNumber(associationStats.tau_a, d), align: 'right', attrs: { 'data-stat': 'tau_a' } },
      ],
    });
  }

  const footnotes: string[] = [
    'Note: c = 0.5 indicates random prediction; c = 1.0 indicates perfect discrimination.',
  ];
  if (typeof associationStats.n_bootstrap === 'number' && Number.isFinite(associationStats.n_bootstrap) && associationStats.n_bootstrap > 0) {
    const bootstrapFootnote = typeof associationStats.bootstrap_seed === 'number' && Number.isFinite(associationStats.bootstrap_seed)
      ? `Concordance SE estimated via bootstrap (n=${associationStats.n_bootstrap}, seed=${associationStats.bootstrap_seed}).`
      : `Concordance SE estimated via bootstrap (n=${associationStats.n_bootstrap}).`;
    footnotes.push(bootstrapFootnote);
  }

  return {
    title: 'Concordance Statistics',
    columns: [
      { key: 'statistic', header: 'Statistic', align: 'left', width: 24 },
      { key: 'value', header: 'Value', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    footnotes,
    testName: 'cox_concordance',
  };
}

// =============================================================================
// NELSON-AALEN
// =============================================================================

/**
 * Build ECP-Style tables for Nelson-Aalen results
 */
export function buildNelsonAalenTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];
  const strata = result.strata as Array<Record<string, unknown>> | undefined;
  const eventLabels = result.event_labels as { event?: string; censored?: string; was_encoded?: boolean } | undefined;
  const customTimePoints = result.custom_time_points as number[] | undefined;

  // Summary table (overall or per-stratum)
  tables.push(buildNelsonAalenSummaryTable(result, options));

  if (strata && strata.length > 0) {
    for (const stratum of strata) {
      const label = (stratum.display_label as string) ?? (stratum.stratum as string) ?? 'Group';
      tables.push(
        buildNelsonAalenTable(stratum, options, {
          titleSuffix: label,
          eventLabels,
          customTimePoints,
        })
      );
    }

    if (result.homogeneity_test) {
      tables.push(buildHomogeneityTestTable(result, options));
    }
  } else {
    tables.push(buildNelsonAalenTable(result, options, { eventLabels, customTimePoints }));
  }

  return {
    testType: 'nelson_aalen',
    testFamily: 'survival',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
    },
  };
}

/**
 * Nelson-Aalen - Summary Statistics Table
 */
function buildNelsonAalenSummaryTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const strata = result.strata as Array<{
    stratum?: string;
    display_label?: string;
    n_total?: number;
    n_events?: number;
    n_censored?: number;
    summary?: {
      final_cumulative_hazard?: number;
      max_time?: number;
      mean_hazard_rate?: number;
      n_distinct_times?: number;
      variance_method?: string;
    };
  }> | undefined;
  const summaryOfSubjects = result.summary_of_subjects as {
    total?: number;
    event?: number;
    censored?: number;
    percent_censored?: number;
  } | undefined;
  const summary = result.summary as {
    final_cumulative_hazard?: number;
    max_time?: number;
    mean_hazard_rate?: number;
    n_distinct_times?: number;
    variance_method?: string;
  } | undefined;

  rows.push({
    cells: [
      { value: 'Stratum', isHeader: true, align: 'left' },
      { value: 'N', isHeader: true, align: 'right' },
      { value: 'Events', isHeader: true, align: 'right' },
      { value: 'Censored', isHeader: true, align: 'right' },
      { value: 'Final H(t)', isHeader: true, align: 'right' },
      { value: 'Max Time', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  if (strata && strata.length > 0) {
    for (const s of strata) {
      const sSummary = s.summary ?? {};
      rows.push({
        cells: [
          { value: s.display_label ?? s.stratum ?? 'Group', align: 'left' },
          { value: s.n_total ?? '.', align: 'right', format: 'integer' },
          { value: s.n_events ?? '.', align: 'right', format: 'integer' },
          { value: s.n_censored ?? '.', align: 'right', format: 'integer' },
          { value: formatNumber(sSummary.final_cumulative_hazard as number, d), align: 'right' },
          { value: formatNumber(sSummary.max_time as number, d), align: 'right' },
        ],
      });
    }
  } else {
    rows.push({
      cells: [
        { value: 'Overall', align: 'left' },
        { value: summaryOfSubjects?.total ?? '.', align: 'right', format: 'integer', attrs: { 'data-stat': 'n_total' } },
        { value: summaryOfSubjects?.event ?? '.', align: 'right', format: 'integer', attrs: { 'data-stat': 'n_events' } },
        { value: summaryOfSubjects?.censored ?? '.', align: 'right', format: 'integer', attrs: { 'data-stat': 'n_censored' } },
        { value: formatNumber(summary?.final_cumulative_hazard as number, d), align: 'right', attrs: { 'data-stat': 'final_cumulative_hazard' } },
        { value: formatNumber(summary?.max_time as number, d), align: 'right', attrs: { 'data-stat': 'max_time' } },
      ],
    });
  }

  return {
    title: 'Summary Statistics for Cumulative Hazard',
    procedure: 'Survival Analysis',
    columns: [
      { key: 'stratum', header: 'Stratum', align: 'left', width: 16 },
      { key: 'n', header: 'N', align: 'right', width: 8, format: 'integer' },
      { key: 'events', header: 'Events', align: 'right', width: 8, format: 'integer' },
      { key: 'censored', header: 'Censored', align: 'right', width: 10, format: 'integer' },
      { key: 'final_h', header: 'Final H(t)', align: 'right', width: 12, format: 'decimal' },
      { key: 'max_time', header: 'Max Time', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    testName: 'nelson_aalen_summary',
  };
}

/**
 * Nelson-Aalen - Cumulative Hazard Estimates Table
 */
function buildNelsonAalenTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>,
  context?: {
    titleSuffix?: string;
    eventLabels?: { event?: string; censored?: string; was_encoded?: boolean };
    customTimePoints?: number[];
  }
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Extract event encoding and custom time points for footnotes
  const eventLabels = context?.eventLabels ?? (result.event_labels as { event?: string; censored?: string; was_encoded?: boolean } | undefined);
  const customTimePoints = context?.customTimePoints ?? (result.custom_time_points as number[] | undefined);

  const hazardTable = (result.hazard_table ?? result.cumulative_hazard_table) as Array<{
    time: number;
    cumulative_hazard: number;
    ci_lower?: number;
    ci_upper?: number;
    ci_lower_95?: number;
    ci_upper_95?: number;
    n_at_risk?: number;
    at_risk?: number;
  }>;
  const fixedEstimates = result.fixed_time_estimates as
    | Array<{
        time: number;
        cumulative_hazard: number;
        ci_lower?: number;
        ci_upper?: number;
        ci_lower_95?: number;
        ci_upper_95?: number;
        at_risk?: number;
        n_at_risk?: number;
      }>
    | undefined;

  // Merge custom time points with all event times (not either/or)
  // Track which times are custom time points for E2E data-stat attributes
  const customTimeSet = new Set<number>();
  let tableRows = hazardTable ?? [];
  if (fixedEstimates && fixedEstimates.length > 0) {
    // Combine all times, removing duplicates by time value
    const timeMap = new Map<number, typeof tableRows[0]>();

    // Add all hazard table rows
    for (const row of tableRows) {
      timeMap.set(row.time, row);
    }

    // Add/override with fixed time estimates and track custom times
    for (const row of fixedEstimates) {
      timeMap.set(row.time, row);
      customTimeSet.add(row.time);
    }

    // Sort by time
    tableRows = Array.from(timeMap.values()).sort((a, b) => a.time - b.time);
  }

  // Header row
  rows.push({
    cells: [
      { value: 'Time', isHeader: true, align: 'right' },
      { value: 'Cumulative Hazard', isHeader: true, align: 'right' },
      { value: 'N at Risk', isHeader: true, align: 'right' },
      { value: '95% CL Lower', isHeader: true, align: 'right' },
      { value: '95% CL Upper', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Data rows - add data-stat for all event times
  for (const row of tableRows ?? []) {
    const atRisk = row.n_at_risk ?? row.at_risk ?? null;
    const ciLower = row.ci_lower_95 ?? row.ci_lower ?? null;
    const ciUpper = row.ci_upper_95 ?? row.ci_upper ?? null;
    const timeKey = `time_${normalizeTimeKey(row.time)}`;

    rows.push({
      cells: [
        { value: formatNumber(row.time, d), align: 'right' },
        {
          value: formatNumber(row.cumulative_hazard, d),
          align: 'right',
          attrs: { 'data-stat': `${timeKey}_cumhaz` },
        },
        {
          value: atRisk,
          format: 'integer',
          align: 'right',
          attrs: { 'data-stat': `${timeKey}_at_risk` },
        },
        {
          value: formatNumber(ciLower, d),
          align: 'right',
          attrs: { 'data-stat': `${timeKey}_ci_lower` },
        },
        {
          value: formatNumber(ciUpper, d),
          align: 'right',
          attrs: { 'data-stat': `${timeKey}_ci_upper` },
        },
      ],
    });
  }

  // Build footnotes array
  const footnotes: string[] = [];

  // Always show time unit independence footnote
  footnotes.push('Time is unit independent and based on your data');

  if (eventLabels?.was_encoded && eventLabels.event && eventLabels.censored) {
    footnotes.push(`Event Encoding: "${eventLabels.event}" = event occurred, "${eventLabels.censored}" = censored`);
  }
  if (customTimePoints && customTimePoints.length > 0) {
    footnotes.push(`Custom Time Points: ${customTimePoints.join(', ')}`);
  }

  const titleSuffix = context?.titleSuffix ? ` - ${context.titleSuffix}` : '';

  return {
    title: `Nelson-Aalen Cumulative Hazard Estimates${titleSuffix}`,
    procedure: 'Survival Analysis',
    columns: [
      { key: 'time', header: 'Time', align: 'right', width: 10, format: 'decimal' },
      { key: 'cum_haz', header: 'Cumulative Hazard', align: 'right', width: 18, format: 'decimal' },
      { key: 'n_risk', header: 'N at Risk', align: 'right', width: 12, format: 'integer' },
      { key: 'ci_lower', header: '95% CL Lower', align: 'right', width: 14, format: 'decimal' },
      { key: 'ci_upper', header: '95% CL Upper', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'nelson_aalen_cumhaz',
    ...(footnotes.length > 0 && { footnotes }),
  };
}


