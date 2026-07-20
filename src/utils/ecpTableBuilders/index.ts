/**
 * ECP-Style Table Builders - Factory and Registry
 *
 * Central factory for building ECP-Style tables from validated Python JSON output.
 * Maps test types to appropriate table builders.
 */

import type {
  ECPTableCollection,
  TableBuilderOptions,
} from '../../types/ecpStyleTables';

import { buildTTestTables, buildPairedTTestTables, buildOneSampleTTestTables } from './tTestTables';
import { buildANOVATables } from './anovaTables';
import { buildFactorialAnovaTables } from './factorialAnovaTables';
import { buildLmmAnovaTables } from './lmmAnovaTables';
import { buildLinearRegressionTables, buildLogisticRegressionTables } from './regressionTables';
import { buildKaplanMeierTables, buildCoxRegressionTables, buildNelsonAalenTables } from './survivalTables';
import { buildMediationTables } from './mediationTables';
import { buildModerationTables, buildModeratedMediationTables } from './moderationTables';
import { buildCorrelationTables } from './correlationTables';
import { buildMannWhitneyTables, buildWilcoxonTables, buildKruskalWallisTables, buildScheirerRayHareTables } from './nonparametricTables';
import {
  buildChiSquareTables,
  buildFishersExactTables,
  buildMcNemarTables,
  buildChiSquareGofTables,
} from './categoricalTables';
import { buildDescriptiveTables } from './descriptiveTables';
import { buildDoseResponseTables, buildSynergyTables } from './pharmacologyTables';

/**
 * Default options for table builders
 */
export const DEFAULT_TABLE_OPTIONS: Required<TableBuilderOptions> = {
  alpha: 0.05,
  decimalPlaces: 4,
  pValueThreshold: 0.0001,
  minPValue: 1e-300,
  includeFootnotes: true,
  variableName: 'response',
};

/**
 * Format a number to specified decimal places
 */
export function formatNumber(value: unknown, decimals: number = 4): string {
  if (value === null || value === undefined) {
    return '.';
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return '.';
  }
  return numeric.toFixed(decimals);
}

/**
 * Format effect sizes with scientific notation for very small values.
 */
export function formatEffectSize(value: unknown, decimals: number = 4): string {
  if (value === null || value === undefined) {
    return '.';
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return '.';
  }
  if (numeric !== 0 && Math.abs(numeric) < Math.pow(10, -decimals)) {
    return numeric.toExponential(decimals);
  }
  return numeric.toFixed(decimals);
}

/**
 * Format test statistics with scientific notation for very small/large values.
 */
export function formatStatistic(value: unknown, decimals: number = 4): string {
  if (value === null || value === undefined) {
    return '.';
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return '.';
  }
  const abs = Math.abs(numeric);
  if (abs !== 0 && (abs < 0.0001 || abs >= 10000)) {
    return numeric.toExponential(decimals);
  }
  return numeric.toFixed(decimals);
}

/**
 * Format a p-value with scientific notation for very small values
 */
export function formatPValue(
  pValue: unknown,
  threshold: number = 0.0001,
  minPValue: number = 1e-300
): string {
  if (pValue === null || pValue === undefined) {
    return '.';
  }
  const numeric = typeof pValue === 'number' ? pValue : Number(pValue);
  if (!Number.isFinite(numeric)) {
    return '.';
  }
  const minDisplay = Number.isFinite(minPValue) ? minPValue : 1e-300;
  if (numeric <= 0 || numeric < minDisplay) {
    return `< ${minDisplay.toExponential(0)}`;
  }
  // Use scientific notation for very small p-values
  if (numeric < threshold) {
    return numeric.toExponential(3); // e.g., 1.053e-07
  }
  return numeric.toFixed(4);
}

/**
 * Format degrees of freedom (can be integer or decimal for Welch's t)
 */
export function formatDF(df: number | null | undefined): string {
  if (df === null || df === undefined || isNaN(df)) {
    return '.';
  }
  // Check if it's a whole number
  if (Number.isInteger(df)) {
    return df.toString();
  }
  // Welch's df is typically shown with 2 decimal places
  return df.toFixed(2);
}

/**
 * Test type to builder mapping
 */
type TestType =
  // Parametric
  | 'independent_ttest'
  | 'paired_ttest'
  | 'one_sample_ttest'
  | 'one_way_anova'
  | 'two_way_anova'
  | 'multifactorial_anova'
  | 'lmm_anova'
  // Nonparametric
  | 'mann_whitney'
  | 'wilcoxon'
  | 'kruskal_wallis'
  // Regression
  | 'linear_regression'
  | 'multiple_linear_regression'
  | 'logistic_regression'
  | 'logistic_multinomial'
  // Correlation
  | 'correlation_pearson'
  | 'correlation_spearman'
  | 'correlation_kendall'
  // Categorical
  | 'chi_square'
  | 'chi_square_gof'
  | 'fishers_exact'
  | 'mcnemar'
  // Distribution & Descriptive
  | 'normality_shapiro'
  | 'normality_ks'
  | 'normality_ad'
  | 'normality_cvm'
  | 'normality_jb'
  | 'normality_all'
  | 'descriptive_stats'
  | 'outlier_detection'
  // Survival
  | 'kaplan_meier'
  | 'cox_regression'
  | 'nelson_aalen'
  // Pharmacology
  | 'dose_response_3pl'
  | 'dose_response_4pl'
  | 'dose_response_5pl'
  | 'dose_response_compare'
  | 'synergy_bliss'
  | 'synergy_hsa'
  | 'synergy_loewe'
  | 'synergy_zip'
  | 'synergy_all'
  // Mediation & Moderation
  | 'mediation_model4'
  | 'moderation_model1'
  | 'moderated_mediation_model7';

/**
 * Build ECP-Style tables from JSON result
 *
 * @param testType - The type of statistical test
 * @param result - The JSON result from Python backend
 * @param options - Optional table building options
 * @returns Collection of ECP-Style tables
 */
export function buildECPTables(
  testType: TestType | string,
  result: Record<string, unknown>,
  options?: TableBuilderOptions
): ECPTableCollection {
  const opts = { ...DEFAULT_TABLE_OPTIONS, ...options };

  // DEBUG: Trace ECP table building
  console.log('[ECP] buildECPTables called with testType:', testType);
  console.log('[ECP] result keys:', Object.keys(result || {}));

  // DEBUG: Model 7 preprocessing structure
  if (testType === 'moderated_mediation_model7') {
    console.log('[ECP] Model 7 preprocessing:', result.preprocessing);
    console.log('[ECP] Model 7 probe_strategy:', (result.preprocessing as any)?.probe_strategy);
  }

  switch (testType) {
    // =========================================================================
    // GROUP 1: Parametric Tests
    // =========================================================================
    case 'independent_ttest':
      return buildTTestTables(result, testType, opts);

    case 'paired_ttest':
      return buildPairedTTestTables(result, testType, opts);

    case 'one_sample_ttest':
      return buildOneSampleTTestTables(result, testType, opts);

    case 'one_way_anova':
      return buildANOVATables(result, opts);

    case 'two_way_anova':
    case 'multifactorial_anova':
      return buildFactorialAnovaTables(result, opts, testType);

    case 'lmm_anova':
      return buildLmmAnovaTables(result, opts);

    // =========================================================================
    // GROUP 2: Nonparametric Tests
    // =========================================================================
    case 'mann_whitney':
      return buildMannWhitneyTables(result, opts);

    case 'wilcoxon':
      return buildWilcoxonTables(result, opts);

    case 'kruskal_wallis':
      return buildKruskalWallisTables(result, opts);

    case 'scheirer_ray_hare':
      return buildScheirerRayHareTables(result, opts);

    // =========================================================================
    // GROUP 3: Regression & Correlation
    // =========================================================================
    case 'linear_regression':
    case 'multiple_linear_regression':
      return buildLinearRegressionTables(result, opts);

    case 'logistic_regression':
    case 'logistic_multinomial':
      return buildLogisticRegressionTables(result, opts);

    case 'correlation_pearson':
    case 'correlation_spearman':
    case 'correlation_kendall':
      return buildCorrelationTables(result, opts);

    // =========================================================================
    // GROUP 4: Categorical Tests
    // =========================================================================
    case 'chi_square':
      return buildChiSquareTables(result, opts);

    case 'chi_square_gof':
      return buildChiSquareGofTables(result, opts);

    case 'fishers_exact':
      return buildFishersExactTables(result, opts);

    case 'mcnemar':
      return buildMcNemarTables(result, opts);

    // =========================================================================
    // GROUP 5: Distribution & Descriptive
    // =========================================================================
    case 'descriptive_stats':
    case 'normality_shapiro':
    case 'normality_ks':
    case 'normality_ad':
    case 'normality_cvm':
    case 'normality_jb':
    case 'normality_all':
    case 'outlier_detection':
      return buildDescriptiveTables(result, testType, opts);

    // =========================================================================
    // GROUP 6: Survival Analysis
    // =========================================================================
    case 'kaplan_meier':
      return buildKaplanMeierTables(result, opts);

    case 'cox_regression':
      return buildCoxRegressionTables(result, opts);

    case 'nelson_aalen':
      return buildNelsonAalenTables(result, opts);

    // =========================================================================
    // GROUP 7: Pharmacology
    // =========================================================================
    case 'dose_response_3pl':
    case 'dose_response_4pl':
    case 'dose_response_5pl':
    case 'dose_response_compare':
      return buildDoseResponseTables(result, testType, opts);

    case 'synergy_bliss':
    case 'synergy_hsa':
    case 'synergy_loewe':
    case 'synergy_zip':
    case 'synergy_all':
      return buildSynergyTables(result, testType, opts);

    // =========================================================================
    // GROUP 8: Mediation & Moderation
    // =========================================================================
    case 'mediation_model4':
      return buildMediationTables(result, opts);
    case 'moderated_mediation_model7':
      return buildModeratedMediationTables(result, opts);

    case 'moderation_model1':
      console.log('[ECP] Model 1 result keys:', Object.keys(result || {}));
      console.log('[ECP] Model 1 model_info:', result.model_info);
      console.log('[ECP] Model 1 model_summary:', result.model_summary);
      return buildModerationTables(result, opts);

    // =========================================================================
    // Default fallback
    // =========================================================================
    default:
      console.warn(`[ECP] No specific table builder for test type: ${testType}`);
      return {
        testType,
        testFamily: 'unknown',
        tables: [],
        metadata: {
          timestamp: new Date().toISOString(),
        },
      };
  }
}


/**
 * Get test family from test type
 */
export function getTestFamily(testType: string): string {
  const families: Record<string, string[]> = {
    parametric: ['independent_ttest', 'paired_ttest', 'one_sample_ttest', 'one_way_anova', 'two_way_anova', 'multifactorial_anova', 'lmm_anova'],
    nonparametric: ['mann_whitney', 'wilcoxon', 'kruskal_wallis', 'scheirer_ray_hare'],
    regression: ['linear_regression', 'multiple_linear_regression', 'logistic_regression', 'logistic_multinomial'],
    correlation: ['correlation_pearson', 'correlation_spearman', 'correlation_kendall'],
    categorical: ['chi_square', 'chi_square_gof', 'fishers_exact', 'mcnemar'],
    descriptive: ['descriptive_stats', 'normality_shapiro', 'normality_ks', 'normality_ad', 'normality_cvm', 'normality_jb', 'normality_all', 'outlier_detection'],
    survival: ['kaplan_meier', 'cox_regression', 'nelson_aalen'],
    pharmacology: ['dose_response_3pl', 'dose_response_4pl', 'dose_response_5pl', 'dose_response_compare', 'synergy_bliss', 'synergy_hsa', 'synergy_loewe', 'synergy_zip', 'synergy_all'],
    mediation: ['mediation_model4'],
    moderation: ['moderation_model1', 'moderated_mediation_model7'],
  };

  for (const [family, tests] of Object.entries(families)) {
    if (tests.includes(testType)) {
      return family;
    }
  }

  return 'unknown';
}

// Re-export types
export type { ECPTableCollection, ECPTable, ECPRow, ECPCell, ECPColumn, TableBuilderOptions } from '../../types/ecpStyleTables';

