/**
 * ECP-Style Statistical Output Table Types
 *
 * Maps validated Python JSON output to publication-ready tables.
 * Based on COEFFICIENT_TABLES_PLAN.md specifications.
 */

// =============================================================================
// CORE TABLE TYPES
// =============================================================================

/**
 * Alignment options for table cells
 */
export type CellAlignment = 'left' | 'right' | 'center';

/**
 * Cell format types for proper display and export
 */
export type CellFormat =
  | 'text'           // Plain text
  | 'integer'        // Whole numbers (N, DF)
  | 'decimal'        // Fixed decimal places (estimates, statistics)
  | 'pvalue'         // P-values with special formatting (< 0.001)
  | 'percent'        // Percentage values
  | 'scientific';    // Scientific notation

/**
 * A single cell in a ECP-Style table
 */
export interface ECPCell {
  value: string | number | null;
  format?: CellFormat;
  align?: CellAlignment;
  colSpan?: number;
  rowSpan?: number;
  isHeader?: boolean;
  isBold?: boolean;
  isSignificant?: boolean;  // Highlight significant p-values
  dataStat?: string;  // Shorthand for data-stat attribute (for E2E validation)
  attrs?: Record<string, string>;  // HTML attributes (e.g., data-stat for E2E testing)
}

/**
 * A row in a ECP-Style table
 */
export interface ECPRow {
  cells: ECPCell[];
  isHeader?: boolean;
  isSeparator?: boolean;    // Horizontal rule
  isSubheader?: boolean;    // Indented/styled subheader
  indent?: number;          // Indentation level for nested rows
}

/**
 * Column definition for table structure
 */
export interface ECPColumn {
  key: string;
  header: string;
  width?: number;           // Character width for monospace
  align?: CellAlignment;
  format?: CellFormat;
}

/**
 * A complete ECP-Style table
 */
export interface ECPTable {
  title: string;
  subtitle?: string;
  procedure?: string;       // e.g., "T-Test Analysis"
  dependentVar?: string;
  columns: ECPColumn[];
  rows: ECPRow[];
  footnotes?: string[];
  testName?: string;        // For identification
}

/**
 * Collection of tables for a complete test output
 */
export interface ECPTableCollection {
  testType: string;
  testFamily: string;
  tables: ECPTable[];
  metadata?: {
    timestamp?: string;
    alpha?: number;
    sampleSize?: number;
    counts?: Array<{
      label: string;
      value: number;
    }>;
    posthocAdjustment?: string;
  };
}

// =============================================================================
// TEST-SPECIFIC RESULT TYPES (matching validated Python JSON)
// =============================================================================

/**
 * T-test JSON result structure (from parametric.t_test_two_sample)
 */
export interface TTestResult {
  success: boolean;
  test_type: string;
  // Group statistics
  group1_name: string;
  group2_name: string;
  n1: number;
  n2: number;
  mean1: number;
  mean2: number;
  std1: number;
  std2: number;
  sem1: number;
  sem2: number;
  min1?: number;
  max1?: number;
  min2?: number;
  max2?: number;
  // Test results
  mean_difference: number;
  pooled_t: number;
  pooled_p: number;
  pooled_df: number;
  pooled_ci_lower: number;
  pooled_ci_upper: number;
  welch_t: number;
  welch_p: number;
  welch_df: number;
  welch_ci_lower: number;
  welch_ci_upper: number;
  // Equality of variances
  f_statistic: number;
  f_df1: number;
  f_df2: number;
  f_p_value: number;
  equal_variances: boolean;
  // Primary results
  t_statistic: number;
  p_value: number;
  degrees_of_freedom: number;
  is_significant: boolean;
  alpha: number;
  test_method: string;
  equal_variance_assumed: boolean;
}

/**
 * One-way ANOVA JSON result structure (from parametric.anova_one_way)
 */
export interface ANOVAResult {
  success: boolean;
  test_type: string;
  // ANOVA summary
  f_statistic: number;
  p_value: number;
  df_between: number;
  df_within: number;
  is_significant: boolean;
  alpha: number;
  // Sum of squares
  ss_between: number;
  ss_within: number;
  ss_total: number;
  ms_between: number;
  ms_within: number;
  // Effect sizes (point estimates only)
  eta_squared: number;
  omega_squared: number;
  effect_size_interpretation: string;
  // Sample info
  num_groups: number;
  total_n: number;
  // Assumption checks
  levene_statistic: number;
  levene_p_value: number;
  equal_variances: boolean;
  all_groups_normal: boolean;
  // Group summaries
  group_summaries: Array<{
    label: string;
    n: number;
    mean: number;
    std: number;
    sem: number;
    ci_lower: number;
    ci_upper: number;
  }>;
}

/**
 * Logistic regression coefficient structure
 */
export interface LogisticCoefficient {
  feature: string;
  coef: number;
  std_err: number;
  z_value: number;
  p_value: number;
  ci_lower: number;
  ci_upper: number;
  odds_ratio: number;
  or_ci_lower: number;
  or_ci_upper: number;
  significant: boolean;
}

/**
 * Logistic regression JSON result (from regression.logistic_regression_binary_statsmodels)
 */
export interface LogisticRegressionResult {
  success: boolean;
  test_type: string;
  model_fit: {
    minus2logL: number;
    minus2logL_null: number;
    aic: number;
    bic: number;
    lr_chi2: number;
    lr_df: number;
    lr_p: number;
    wald_chi2: number;
    wald_df: number;
    wald_p: number;
    score_chi2: number;
    score_p: number;
  };
  pseudo_r2: {
    mcfadden: number;
    cox_snell: number;
    nagelkerke: number;
  };
  coefficients_table: LogisticCoefficient[];
  hosmer_lemeshow: {
    chi2: number;
    df: number;
    p_value: number;
  };
  classification: {
    accuracy: number;
    sensitivity: number;
    specificity: number;
    precision?: number;
    f1_score?: number;
  };
}

/**
 * Linear regression coefficient structure
 */
export interface LinearCoefficient {
  variable: string;
  estimate: number;
  std_error: number;
  t_value: number;
  p_value: number;
  ci_lower: number;
  ci_upper: number;
}

/**
 * Linear regression JSON result (from regression.linear_regression)
 */
export interface LinearRegressionResult {
  success: boolean;
  test_type: string;
  r_squared: number;
  adjusted_r_squared: number;
  f_statistic: number;
  f_p_value: number;
  rmse: number;
  coefficients: LinearCoefficient[];
  n: number;
  df_model: number;
  df_residual: number;
}

/**
 * Cox regression coefficient structure
 */
export interface CoxCoefficient {
  variable: string;
  coef: number;
  std_err: number;
  z: number;
  p_value: number;
  hazard_ratio: number;
  hr_ci_lower: number;
  hr_ci_upper: number;
}

/**
 * Cox regression JSON result (from survival.cox_proportional_hazards)
 */
export interface CoxRegressionResult {
  success: boolean;
  test_type: string;
  model_fit: {
    minus2logL: number;
    minus2logL_null: number;
    aic: number;
    bic: number;
  };
  global_tests: {
    lr_chi2: number;
    lr_p: number;
    wald_chi2: number;
    wald_p: number;
    score_chi2: number;
    score_p: number;
  };
  coefficients: CoxCoefficient[];
  concordance: {
    c_index: number;
    se: number;
  };
  adjusted_survival_curves?: Array<{
    label: string;
    time: number[];
    survival: number[];
    covariates?: Record<string, number | string>;
  }>;
  adjusted_survival_note?: string;
}

/**
 * Kaplan-Meier stratum structure
 */
export interface KMStratum {
  stratum: string;
  n_total: number;
  n_events: number;
  n_censored: number;
  median_survival?: number;
  median_ci_lower_95?: number;
  median_ci_upper_95?: number;
  quartile_estimates?: Array<{
    percent: number;
    estimate: number;
    ci_lower_95?: number;
    ci_upper_95?: number;
  }>;
  life_table?: Array<{
    time: number;
    n_at_risk: number;
    n_events: number;
    survival: number;
    ci_lower: number;
    ci_upper: number;
  }>;
}

/**
 * Kaplan-Meier JSON result (from survival.kaplan_meier_analysis)
 */
export interface KaplanMeierResult {
  success: boolean;
  test_type: string;
  overall: {
    n_total: number;
    n_events: number;
    n_censored: number;
    median_survival?: number;
    median_ci_lower_95?: number;
    median_ci_upper_95?: number;
  };
  strata?: KMStratum[];
  homogeneity_test?: {  // Note: Python uses 'homogeneity_test', not 'log_rank_test'
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
}

/**
 * Nelson-Aalen JSON result (from survival.nelson_aalen_cumulative_hazard)
 */
export interface NelsonAalenResult {
  success: boolean;
  test_type: string;
  hazard_table?: Array<{
    time: number;
    cumulative_hazard: number;
    ci_lower_95?: number;
    ci_upper_95?: number;
    at_risk?: number;
    n_at_risk?: number;
  }>;
  fixed_time_estimates?: Array<{
    time: number;
    cumulative_hazard: number;
    ci_lower_95?: number;
    ci_upper_95?: number;
    at_risk?: number;
    n_at_risk?: number;
  }>;
  smoothed_hazard?: {
    bandwidth: number;
    time: number[];
    hazard: number[];
    ci_lower_95?: number[];
    ci_upper_95?: number[];
  };
  strata?: Array<{
    stratum: string;
    hazard_table?: Array<{
      time: number;
      cumulative_hazard: number;
      ci_lower_95?: number;
      ci_upper_95?: number;
      at_risk?: number;
      n_at_risk?: number;
    }>;
    fixed_time_estimates?: Array<{
      time: number;
      cumulative_hazard: number;
      ci_lower_95?: number;
      ci_upper_95?: number;
      at_risk?: number;
      n_at_risk?: number;
    }>;
    smoothed_hazard?: {
      bandwidth: number;
      time: number[];
      hazard: number[];
      ci_lower_95?: number[];
      ci_upper_95?: number[];
    };
  }>;
}

/**
 * Mediation indirect effect structure
 */
export interface MediationIndirectEffect {
  mediator: string;
  effect: number;
  boot_se: number;
  boot_ci_lower: number;
  boot_ci_upper: number;
  significant: boolean;
}

/**
 * Mediation model coefficient structure
 */
export interface MediationCoefficient {
  parameter: string;
  estimate: number;
  std_error: number;
  t_value: number;
  p_value: number;
  ci_lower: number;
  ci_upper: number;
}

/**
 * Mediation JSON result (from mediation.mediation_model4)
 */
export interface MediationResult {
  success: boolean;
  test_type: string;
  model_info: {
    outcome: string;
    predictor: string;
    mediators: string[];
    sample_size: number;
    n_bootstrap: number;
    confidence_level?: number;
    seed?: number | null;
    mediator_link?: string;
    outcome_link?: string;
  };
  outcome_models: {
    [key: string]: {
      model_type?: string;
      r_squared?: number | null;
      adj_r_squared?: number | null;
      f_statistic?: number | null;
      f_p_value?: number | null;
      mse?: number | null;
      df1?: number | null;
      df2?: number | null;
      coefficients: MediationCoefficient[];
    };
  };
  effects: {
    direct: {
      effect: number;
      se: number;
      t: number;
      p: number;
      ci_lower: number;
      ci_upper: number;
      boot_ci_lower?: number;
      boot_ci_upper?: number;
    };
    indirect: MediationIndirectEffect[];
    total: {
      effect: number;
      se: number;
      t: number;
      p: number;
      ci_lower: number;
      ci_upper: number;
    };
  };
  proportions: {
    indirect_over_total: number;
    percent_mediated: number;
    boot_ci_lower?: number;
    boot_ci_upper?: number;
  };
  sobel_test: {
    effect: number;
    se: number;
    z: number;
    p: number;
  };
}

/**
 * Moderation coefficient structure
 */
export interface ModerationCoefficient {
  parameter: string;
  estimate: number;
  se: number;
  t: number;
  p: number;
  ci_lower: number;
  ci_upper: number;
}

/**
 * Moderation conditional effect structure
 */
export interface ModerationConditionalEffect {
  moderator_value: number;
  effect: number;
  se: number;
  t: number;
  p: number;
  ci_lower: number;
  ci_upper: number;
  label: string;
}

/**
 * Moderation JSON result (from moderation.simple_moderation)
 */
export interface ModerationResult {
  success: boolean;
  test_type: string;
  model_summary: {
    r_squared: number;
    adj_r_squared: number;
    f_statistic: number;
    f_p_value: number;
    mse: number;
    df1: number;
    df2: number;
  };
  coefficients: ModerationCoefficient[];
  interaction: {
    r_squared_change: number;
    f_change: number;
    f_change_p: number;
    f_change_df1: number;
    f_change_df2: number;
  };
  conditional_effects: ModerationConditionalEffect[];
}

/**
 * Correlation JSON result (from correlation.correlation_analysis)
 */
export interface CorrelationResult {
  success: boolean;
  test_type?: string;
  pearson: {
    correlation: number;
    p_value: number;
    t_statistic: number;
    degrees_of_freedom: number;
    ci_95_lower: number;
    ci_95_upper: number;
    is_significant: boolean;
  };
  spearman: {
    correlation: number;
    p_value: number;
    s_statistic: number;
    is_significant: boolean;
  };
  kendall: {
    correlation: number;
    p_value: number;
    z_statistic: number;
    is_significant: boolean;
  };
  n: number;
  alpha: number;
}

/**
 * Mann-Whitney U JSON result
 */
export interface MannWhitneyResult {
  success: boolean;
  test_type: string;
  U_statistic: number;
  p_value: number;
  z_statistic: number;
  n1: number;
  n2: number;
  median1: number;
  median2: number;
  rank_biserial_correlation: number;
  effect_size_interpretation: string;
  is_significant: boolean;
  alpha: number;
}

/**
 * Wilcoxon signed-rank JSON result
 */
export interface WilcoxonResult {
  success: boolean;
  test_type: string;
  W_statistic: number;
  p_value: number;
  n_pairs: number;
  n_nonzero_differences: number;
  median_difference: number;
  rank_biserial_correlation: number;
  sum_positive_ranks: number;
  sum_negative_ranks: number;
  is_significant: boolean;
  alpha: number;
}

/**
 * Kruskal-Wallis JSON result
 */
export interface KruskalWallisResult {
  success: boolean;
  test_type: string;
  H_statistic: number;
  p_value: number;
  df: number;
  eta_squared: number;
  group_medians: Array<{
    group: string;
    median: number;
    n: number;
  }>;
  is_significant: boolean;
  alpha: number;
}

/**
 * Chi-square JSON result
 */
export interface ChiSquareResult {
  success: boolean;
  test_type: string;
  chi_square: number;
  p_value: number;
  degrees_of_freedom: number;
  likelihood_ratio_chi2: number;
  likelihood_ratio_p: number;
  cramers_v: number;
  phi_coefficient?: number;
  odds_ratio?: number;
  odds_ratio_ci_lower?: number;
  odds_ratio_ci_upper?: number;
  observed_frequencies: number[][];
  expected_frequencies: number[][];
  is_significant: boolean;
  alpha: number;
}

/**
 * Fisher's exact JSON result
 */
export interface FishersExactResult {
  success: boolean;
  test_type: string;
  p_value: number;
  odds_ratio: number;
  odds_ratio_ci_lower: number;
  odds_ratio_ci_upper: number;
  is_significant: boolean;
  alpha: number;
}

/**
 * Descriptive statistics JSON result
 */
export interface DescriptiveResult {
  success: boolean;
  test_type: string;
  n: number;
  mean: number;
  std: number;
  sem: number;
  variance: number;
  min: number;
  max: number;
  range: number;
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  skewness: number;
  kurtosis: number;
  cv: number;
}

/**
 * Dose-response parameter structure
 */
export interface DoseResponseParameter {
  value: number;
  stderr: number;
  ci_lower?: number;
  ci_upper?: number;
}

/**
 * Dose-response JSON result
 */
export interface DoseResponseResult {
  success: boolean;
  test_type: string;
  model_type: string;
  parameters: {
    ic50?: DoseResponseParameter;
    hill?: DoseResponseParameter;
    top?: DoseResponseParameter;
    bottom?: DoseResponseParameter;
  };
  goodness_of_fit: {
    r_squared: number;
    adj_r_squared: number;
    rmse: number;
    aic: number;
    bic: number;
  };
}

/**
 * Synergy analysis JSON result
 */
export interface SynergyResult {
  success: boolean;
  test_type: string;
  method: string;
  synergy_score: number;
  interpretation: string;
  combination_index?: number;
}

// =============================================================================
// FACTORY & BUILDER TYPES
// =============================================================================

/**
 * Builder function signature for creating ECP tables from JSON results
 */
export type ECPTableBuilder<T> = (result: T, options?: TableBuilderOptions) => ECPTableCollection;

/**
 * Options for table builders
 */
export interface TableBuilderOptions {
  alpha?: number;           // Significance level (default 0.05)
  decimalPlaces?: number;   // Number of decimal places (default 4)
  pValueThreshold?: number; // Threshold for "< 0.001" display
  minPValue?: number;       // Minimum p-value floor for display
  includeFootnotes?: boolean;
  variableName?: string;    // Name of dependent variable
}

/**
 * Registry entry for a table builder
 */
export interface TableBuilderRegistry {
  [testType: string]: ECPTableBuilder<unknown>;
}

// =============================================================================
// EXPORT TYPES
// =============================================================================

/**
 * Export format options
 */
export type ExportFormat = 'excel' | 'csv' | 'rtf' | 'html' | 'text';

/**
 * Excel export options
 */
export interface ExcelExportOptions {
  sheetName?: string;
  includeHeader?: boolean;
  autoFitColumns?: boolean;
  headerStyle?: {
    bold?: boolean;
    backgroundColor?: string;
  };
}

