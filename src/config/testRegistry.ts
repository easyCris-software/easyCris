/**
 * Test Registry - Phase 4 Fix Module 1
 *
 * Single source of truth for all statistical test definitions.
 * Matches Python stats.py exactly.
 *
 * This replaces:
 * - TEST_COMMAND_MAP in AppShell.tsx
 * - TEST_METADATA in StatisticalTestsNav.tsx
 * - getRequiredColumnCount() scattered logic
 */

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Parameter value type - narrowed for type-safe handling
 * Matches results-store.ts ParameterValue
 */
export type ParameterDefaultValue = string | number | boolean | null | undefined

/**
 * Parameter definition for test configuration
 */
export interface ParameterDef {
  /** Parameter name - must match Python exactly (snake_case) */
  name: string
  /** Parameter type */
  type: 'number' | 'boolean' | 'string' | 'select'
  /** Default value */
  default: ParameterDefaultValue
  /** UI display label */
  label: string
  /** Options for select type */
  options?: string[]
  /** Whether parameter is required (default: true) */
  required?: boolean
  /** Minimum value for number type */
  min?: number
  /** Maximum value for number type */
  max?: number
  /** Step for number input */
  step?: number
}

/**
 * Data field definition for column selection
 */
export interface DataFieldDef {
  /** Field name - must match Python data payload key exactly */
  name: string
  /** Expected data type */
  type: 'numeric' | 'categorical' | 'any'
  /** UI label for column picker */
  label: string
  /** Help text / description */
  description?: string
  /** Whether field is required (default: true) */
  required?: boolean
  /** Whether field accepts multiple columns */
  multiple?: boolean
  /** Minimum number of columns required when multiple is true (default: 2) */
  minColumns?: number
}

/**
 * Complete test definition
 */
export interface TestDefinition {
  /** Canonical ID - same as Python test name */
  id: string
  /** Display name for UI */
  displayName: string
  /** Test family for grouping */
  family: TestFamily
  /** Python test name (same as id, kept for explicitness) */
  pythonTestName: string
  /** Data fields required by this test */
  requiredDataFields: DataFieldDef[]
  /** Test parameters */
  parameters: ParameterDef[]
  /** Description for help text */
  description?: string
  /** Whether this is a paired test (affects column picker UI) */
  isPaired?: boolean
  /**
   * Optional module ID for modular validation/payload building
   * Links to ITestModule in src/lib/modules/
   * Phase 0: Only independent_ttest has this field
   */
  moduleId?: string
}

/**
 * Test family categories
 */
export type TestFamily =
  | 'parametric'
  | 'nonparametric'
  | 'regression'
  | 'correlation'
  | 'categorical'
  | 'distribution'
  | 'descriptive'
  | 'pharmacology'
  | 'survival'
  | 'mediation'
  | 'moderation'

/**
 * Family metadata for UI
 */
export interface FamilyInfo {
  id: TestFamily
  displayName: string
  description: string
  icon?: string
}

/**
 * Validation/test selection grouping aligned with _test_validation folders
 */
export type TestGroupId =
  | 'hypothesis_testing'
  | 'pharmacology'
  | 'regression_correlation'
  | 'categorical'
  | 'distribution_descriptive'
  | 'survival'
  | 'mediation_moderation'

export interface TestGroup {
  id: TestGroupId
  displayName: string
  description: string
  testIds: string[]
}

// =============================================================================
// FAMILY DEFINITIONS
// =============================================================================

export const TEST_FAMILIES: Record<TestFamily, FamilyInfo> = {
  parametric: {
    id: 'parametric',
    displayName: 'Parametric Tests',
    description: 'Tests assuming normal distribution (t-tests, ANOVA)',
  },
  nonparametric: {
    id: 'nonparametric',
    displayName: 'Nonparametric Tests',
    description: 'Distribution-free tests (Mann-Whitney, Wilcoxon, Kruskal-Wallis)',
  },
  regression: {
    id: 'regression',
    displayName: 'Regression Analysis',
    description: 'Linear, logistic, and polynomial regression',
  },
  correlation: {
    id: 'correlation',
    displayName: 'Correlation Analysis',
    description: 'Pearson, Spearman, and Kendall correlations',
  },
  categorical: {
    id: 'categorical',
    displayName: 'Categorical Tests',
    description: 'Chi-square and Fisher\'s exact tests',
  },
  distribution: {
    id: 'distribution',
    displayName: 'Distribution Tests',
    description: 'Normality tests (Shapiro-Wilk, Kolmogorov-Smirnov)',
  },
  descriptive: {
    id: 'descriptive',
    displayName: 'Descriptive Statistics',
    description: 'Summary statistics (mean, median, SD, etc.)',
  },
  pharmacology: {
    id: 'pharmacology',
    displayName: 'Dose-Response Analysis',
    description: '3PL and 4PL curve fitting',
  },
  survival: {
    id: 'survival',
    displayName: 'Survival Analysis',
    description: 'Kaplan-Meier, Cox regression, Nelson-Aalen',
  },
  mediation: {
    id: 'mediation',
    displayName: 'Mediation Analysis',
    description: 'Simple mediation models (Model 4)',
  },
  moderation: {
    id: 'moderation',
    displayName: 'Moderation Analysis',
    description: 'Moderation models (Models 1, 2)',
  },
}

// =============================================================================
// VALIDATION / TEST SELECTION GROUPS
// =============================================================================

export const TEST_GROUPS: TestGroup[] = [
  {
    id: 'hypothesis_testing',
    displayName: 'Hypothesis Testing',
    description: 't-tests, ANOVAs, and nonparametric rank tests',
    testIds: [
      // Parametric t-tests
      'independent_ttest',
      'paired_ttest',
      'one_sample_ttest',
      // Non-parametric t-tests
      'mann_whitney',
      'wilcoxon',
      // Parametric ANOVAs
      'one_way_anova',
      'two_way_anova',
      'multifactorial_anova',
      'lmm_anova',
      // Non-parametric ANOVAs
      'kruskal_wallis',
      'scheirer_ray_hare',
    ],
  },
  {
    id: 'pharmacology',
    displayName: 'Pharmacology & Dose Response',
    description: 'Dose-response curves and drug synergy analysis',
    testIds: [
      'dose_response_3pl',
      'dose_response_4pl',
    ],
  },
  {
    id: 'regression_correlation',
    displayName: 'Regression & Correlation',
    description: 'Linear, logistic, polynomial regression and correlations',
    testIds: [
      'linear_regression',
      'multiple_linear_regression',
      'logistic_regression',
      'logistic_multinomial',
      'correlation_pearson',
      'correlation_spearman',
      'correlation_kendall',
    ],
  },
  {
    id: 'categorical',
    displayName: 'Categorical Analysis',
    description: 'Chi-square, Fisher exact, and McNemar tests',
    testIds: ['chi_square', 'chi_square_gof', 'fishers_exact', 'mcnemar'],
  },
  {
    id: 'distribution_descriptive',
    displayName: 'Distribution & Descriptive',
    description: 'Normality tests, descriptive statistics, and outlier detection',
    testIds: ['normality_all', 'descriptive_stats', 'outlier_detection'],
  },
  {
    id: 'survival',
    displayName: 'Survival Analysis',
    description: 'Kaplan-Meier, Cox regression, Nelson-Aalen',
    testIds: ['kaplan_meier', 'cox_regression', 'nelson_aalen'],
  },
  {
    id: 'mediation_moderation',
    displayName: 'Mediation & Moderation',
    description: 'Mediation and moderation statistical models',
    testIds: ['mediation_model4', 'moderation_model1', 'moderated_mediation_model7'],
  },
]

// =============================================================================
// TEST REGISTRY - All 45 Tests (Aligned with _test_validation)
// =============================================================================

export const TEST_REGISTRY: Record<string, TestDefinition> = {
  // =========================================================================
  // PARAMETRIC TESTS (6)
  // =========================================================================

  independent_ttest: {
    id: 'independent_ttest',
    displayName: 'Independent Samples T-Test',
    family: 'parametric',
    pythonTestName: 'independent_ttest',
    description: 'Compare means of two independent groups',
    moduleId: 'independent_ttest', // Phase 0: links to src/lib/modules/parametric/tTestModule.ts
    requiredDataFields: [
      { name: 'group1', type: 'numeric', label: 'Group 1', description: 'First group values' },
      { name: 'group2', type: 'numeric', label: 'Group 2', description: 'Second group values' },
    ],
    parameters: [
      { name: 'equal_var', type: 'boolean', default: false, label: 'Assume Equal Variance' },
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  paired_ttest: {
    id: 'paired_ttest',
    displayName: 'Paired Samples T-Test',
    family: 'parametric',
    pythonTestName: 'paired_ttest',
    moduleId: 'paired_ttest',
    description: 'Compare means of paired/matched samples',
    isPaired: true,
    requiredDataFields: [
      { name: 'group1', type: 'numeric', label: 'Before / Group 1', description: 'Pre-treatment or first measurement' },
      { name: 'group2', type: 'numeric', label: 'After / Group 2', description: 'Post-treatment or second measurement' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  one_sample_ttest: {
    id: 'one_sample_ttest',
    displayName: 'One Sample T-Test',
    family: 'parametric',
    pythonTestName: 'one_sample_ttest',
    moduleId: 'one_sample_ttest',
    description: 'Compare sample mean to a known population mean',
    requiredDataFields: [
      { name: 'values', type: 'numeric', label: 'Values', description: 'Sample values to test' },
    ],
    parameters: [
      { name: 'population_mean', type: 'number', default: 0, label: 'Population Mean (μ₀)' },
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  one_way_anova: {
    id: 'one_way_anova',
    displayName: 'One-Way ANOVA',
    family: 'parametric',
    pythonTestName: 'one_way_anova',
    moduleId: 'one_way_anova',
    description: 'Compare means across multiple groups',
    requiredDataFields: [
      { name: 'groups', type: 'numeric', label: 'Values', description: 'Values grouped by factor', multiple: true, minColumns: 2 },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  two_way_anova: {
    id: 'two_way_anova',
    displayName: 'Two-Way ANOVA',
    family: 'parametric',
    pythonTestName: 'two_way_anova',
    moduleId: 'two_way_anova',
    description: 'Analyze effects of two factors and their interaction',
    requiredDataFields: [
      { name: 'dependent', type: 'numeric', label: 'Dependent Variable', description: 'Outcome variable' },
      { name: 'factor1', type: 'categorical', label: 'Factor 1', description: 'First grouping factor' },
      { name: 'factor2', type: 'categorical', label: 'Factor 2', description: 'Second grouping factor' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  multifactorial_anova: {
    id: 'multifactorial_anova',
    moduleId: 'multifactorial_anova',
    displayName: 'Multifactorial ANOVA',
    family: 'parametric',
    pythonTestName: 'multifactorial_anova',
    description: 'Analyze effects of 3+ factors and their interactions',
    requiredDataFields: [
      { name: 'dependent', type: 'numeric', label: 'Dependent Variable', description: 'Outcome variable' },
      { name: 'factors', type: 'categorical', label: 'Factors', description: 'Grouping factors (3+)', multiple: true, minColumns: 3 },
    ],
    parameters: [
      { name: 'max_depth', type: 'number', default: 3, label: 'Max Interaction Depth', min: 2, max: 5, step: 1 },
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  lmm_anova: {
    id: 'lmm_anova',
    displayName: 'Linear Mixed Model',
    family: 'parametric',
    pythonTestName: 'lmm_anova',
    moduleId: 'lmm_anova',
    description: 'Analyze repeated-measures and grouped data with fixed and random effects',
    requiredDataFields: [
      {
        name: 'variables',
        type: 'any',
        label: 'Candidate Variables',
        description: 'Select outcome, sample ID, and predictor columns for LMM configuration',
        multiple: true,
        minColumns: 3,
      },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
      { name: 'reml', type: 'boolean', default: false, label: 'Use REML' },
    ],
  },

  // =========================================================================
  // NONPARAMETRIC TESTS (6)
  // =========================================================================

  mann_whitney: {
    id: 'mann_whitney',
    displayName: 'Mann-Whitney U Test',
    family: 'nonparametric',
    pythonTestName: 'mann_whitney',
    moduleId: 'mann_whitney',
    description: 'Non-parametric test for two independent groups',
    requiredDataFields: [
      { name: 'group1', type: 'numeric', label: 'Group 1', description: 'First group values' },
      { name: 'group2', type: 'numeric', label: 'Group 2', description: 'Second group values' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
      { name: 'alternative', type: 'select', default: 'two-sided', label: 'Alternative Hypothesis', options: ['two-sided', 'less', 'greater'] },
    ],
  },

  wilcoxon: {
    id: 'wilcoxon',
    displayName: 'Wilcoxon Signed-Rank Test',
    family: 'nonparametric',
    pythonTestName: 'wilcoxon',
    moduleId: 'wilcoxon',
    description: 'Non-parametric test for paired samples',
    isPaired: true,
    requiredDataFields: [
      { name: 'group1', type: 'numeric', label: 'Before / Group 1', description: 'First measurement' },
      { name: 'group2', type: 'numeric', label: 'After / Group 2', description: 'Second measurement' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  kruskal_wallis: {
    id: 'kruskal_wallis',
    displayName: 'Kruskal-Wallis H Test',
    family: 'nonparametric',
    pythonTestName: 'kruskal_wallis',
    moduleId: 'kruskal_wallis',
    description: 'Non-parametric test for multiple independent groups',
    requiredDataFields: [
      { name: 'groups', type: 'numeric', label: 'Values', description: 'Values grouped by factor', multiple: true, minColumns: 2 },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  scheirer_ray_hare: {
    id: 'scheirer_ray_hare',
    displayName: 'Scheirer-Ray-Hare Test',
    family: 'nonparametric',
    pythonTestName: 'scheirer_ray_hare',
    moduleId: 'scheirer_ray_hare',
    description: 'Non-parametric two-way ANOVA alternative (uses ranks)',
    requiredDataFields: [
      { name: 'values', type: 'numeric', label: 'Values', description: 'Response variable (numeric or ordinal)' },
      { name: 'factor1', type: 'categorical', label: 'Factor 1', description: 'First grouping factor' },
      { name: 'factor2', type: 'categorical', label: 'Factor 2', description: 'Second grouping factor' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  // =========================================================================
  // REGRESSION (5)
  // =========================================================================

  linear_regression: {
    id: 'linear_regression',
    displayName: 'Simple Linear Regression',
    family: 'regression',
    pythonTestName: 'linear_regression',
    moduleId: 'regression', // Phase 4: Unified regression module with dynamic type detection
    description: 'Model linear relationship between single predictor and outcome',
    requiredDataFields: [], // Module validates: 2+ columns (1 DV + 1+ predictors)
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  multiple_linear_regression: {
    id: 'multiple_linear_regression',
    displayName: 'Multiple Linear Regression',
    family: 'regression',
    pythonTestName: 'multiple_linear_regression',
    moduleId: 'regression', // Phase 4: Unified regression module with dynamic type detection
    description: 'Model outcome from multiple predictors',
    requiredDataFields: [], // Module validates: 2+ columns (1 DV + 1+ predictors)
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  logistic_regression: {
    id: 'logistic_regression',
    displayName: 'Binary Logistic Regression',
    family: 'regression',
    pythonTestName: 'logistic_regression',
    moduleId: 'regression', // Phase 4: Unified regression module with dynamic type detection
    description: 'Model binary outcome from one or more predictors',
    requiredDataFields: [], // Module validates: 2+ columns (1 DV + 1+ predictors)
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  logistic_multinomial: {
    id: 'logistic_multinomial',
    displayName: 'Multinomial Logistic Regression',
    family: 'regression',
    pythonTestName: 'logistic_multinomial',
    moduleId: 'regression', // Phase 4: Unified regression module with dynamic type detection
    description: 'Model multi-class outcome from predictors',
    requiredDataFields: [], // Module validates: 2+ columns (1 DV + 1+ predictors)
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  // =========================================================================
  // CORRELATION (3)
  // =========================================================================

  correlation_pearson: {
    id: 'correlation_pearson',
    displayName: 'Pearson Correlation',
    family: 'correlation',
    pythonTestName: 'correlation_pearson',
    moduleId: 'correlation_pearson',
    description: 'Measure linear relationship strength (parametric)',
    requiredDataFields: [
      {
        name: 'variables',
        type: 'numeric',
        label: 'Variables',
        description: 'Select 2+ numeric variables',
        multiple: true,
        minColumns: 2,
      },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  correlation_spearman: {
    id: 'correlation_spearman',
    displayName: 'Spearman Correlation',
    family: 'correlation',
    pythonTestName: 'correlation_spearman',
    moduleId: 'correlation_spearman',
    description: 'Measure monotonic relationship strength (non-parametric)',
    requiredDataFields: [
      {
        name: 'variables',
        type: 'numeric',
        label: 'Variables',
        description: 'Select 2+ numeric variables',
        multiple: true,
        minColumns: 2,
      },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  correlation_kendall: {
    id: 'correlation_kendall',
    displayName: 'Kendall Tau Correlation',
    family: 'correlation',
    pythonTestName: 'correlation_kendall',
    moduleId: 'correlation_kendall',
    description: 'Measure ordinal association (robust to ties)',
    requiredDataFields: [
      {
        name: 'variables',
        type: 'numeric',
        label: 'Variables',
        description: 'Select 2+ numeric variables',
        multiple: true,
        minColumns: 2,
      },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  // =========================================================================
  // CATEGORICAL (4)
  // =========================================================================

  chi_square: {
    id: 'chi_square',
    displayName: 'Chi-Square Independence Test',
    family: 'categorical',
    pythonTestName: 'chi_square',
    moduleId: 'chi_square',
    description: 'Test independence in contingency table',
    requiredDataFields: [
      { name: 'variable1', type: 'categorical', label: 'Variable 1', description: 'First categorical variable' },
      { name: 'variable2', type: 'categorical', label: 'Variable 2', description: 'Second categorical variable' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  chi_square_gof: {
    id: 'chi_square_gof',
    displayName: 'Chi-Square Goodness of Fit',
    family: 'categorical',
    pythonTestName: 'chi_square_gof',
    moduleId: 'chi_square_gof',
    description: 'Test if observed frequencies match expected distribution (uniform by default)',
    requiredDataFields: [
      { name: 'category', type: 'categorical', label: 'Categorical Variable', description: 'Column with categories to test (2+ categories required)' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  fishers_exact: {
    id: 'fishers_exact',
    displayName: "Fisher's Exact Test",
    family: 'categorical',
    pythonTestName: 'fishers_exact',
    moduleId: 'fishers_exact',
    description: 'Exact test for 2x2 contingency tables',
    requiredDataFields: [
      { name: 'variable1', type: 'categorical', label: 'Variable 1', description: 'First categorical variable (2 categories)' },
      { name: 'variable2', type: 'categorical', label: 'Variable 2', description: 'Second categorical variable (2 categories)' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  mcnemar: {
    id: 'mcnemar',
    displayName: "McNemar's Test",
    family: 'categorical',
    pythonTestName: 'mcnemar',
    moduleId: 'mcnemar',
    description: 'Test for paired nominal data (before/after)',
    isPaired: true,
    requiredDataFields: [
      { name: 'before', type: 'categorical', label: 'Before Measurement', description: 'First measurement (2 categories)' },
      { name: 'after', type: 'categorical', label: 'After Measurement', description: 'Second measurement (2 categories, same as before)' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  // =========================================================================
  // DISTRIBUTION / NORMALITY (2)
  // =========================================================================

  normality_shapiro: {
    id: 'normality_shapiro',
    displayName: 'Shapiro-Wilk Test',
    family: 'distribution',
    pythonTestName: 'normality_shapiro',
    moduleId: 'normality_shapiro',
    description: 'Test if data follows normal distribution',
    requiredDataFields: [
      { name: 'values', type: 'numeric', label: 'Values', description: 'Data to test for normality' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  normality_ks: {
    id: 'normality_ks',
    displayName: 'Kolmogorov-Smirnov Test',
    family: 'distribution',
    pythonTestName: 'normality_ks',
    moduleId: 'normality_ks',
    description: 'Test if data follows specified distribution',
    requiredDataFields: [
      { name: 'values', type: 'numeric', label: 'Values', description: 'Data to test' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  normality_ad: {
    id: 'normality_ad',
    displayName: 'Anderson-Darling Test',
    family: 'distribution',
    pythonTestName: 'normality_ad',
    moduleId: 'normality_ad',
    description: 'Test if data follows normal distribution using Anderson-Darling method',
    requiredDataFields: [
      { name: 'values', type: 'numeric', label: 'Values', description: 'Data to test for normality' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  normality_cvm: {
    id: 'normality_cvm',
    displayName: 'Cramer-von Mises Test',
    family: 'distribution',
    pythonTestName: 'normality_cvm',
    moduleId: 'normality_cvm',
    description: 'Test if data follows normal distribution using Cramer-von Mises method',
    requiredDataFields: [
      { name: 'values', type: 'numeric', label: 'Values', description: 'Data to test for normality' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  normality_jb: {
    id: 'normality_jb',
    displayName: 'Jarque-Bera Test',
    family: 'distribution',
    pythonTestName: 'normality_jb',
    moduleId: 'normality_jb',
    description: 'Test if data follows normal distribution using Jarque-Bera method (skewness + kurtosis)',
    requiredDataFields: [
      { name: 'values', type: 'numeric', label: 'Values', description: 'Data to test for normality' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  normality_all: {
    id: 'normality_all',
    displayName: 'Normality (All Tests)',
    family: 'distribution',
    pythonTestName: 'normality_all',
    moduleId: 'normality_all',
    description: 'Run all normality tests at once (Shapiro-Wilk, K-S, Anderson-Darling, Cramer-von Mises, Jarque-Bera)',
    requiredDataFields: [
      { name: 'values', type: 'numeric', label: 'Values', description: 'Data to test for normality' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  // =========================================================================
  // DESCRIPTIVE (1)
  // =========================================================================

  descriptive_stats: {
    id: 'descriptive_stats',
    displayName: 'Descriptive Statistics',
    family: 'descriptive',
    pythonTestName: 'descriptive_stats',
    moduleId: 'descriptive_stats',
    description: 'Calculate summary statistics (mean, median, SD, etc.)',
    requiredDataFields: [
      { name: 'values', type: 'numeric', label: 'Values', description: 'Data to summarize' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Confidence Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  outlier_detection: {
    id: 'outlier_detection',
    displayName: 'Outlier Detection',
    family: 'descriptive',
    pythonTestName: 'outlier_detection',
    moduleId: 'outlier_detection',
    description: 'Identify outliers using IQR, Z-score, and modified Z-score',
    requiredDataFields: [
      { name: 'values', type: 'numeric', label: 'Values', description: 'Data to analyze for outliers' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  // =========================================================================
  // PHARMACOLOGY / DOSE-RESPONSE (9)
  // =========================================================================

  dose_response_3pl: {
    id: 'dose_response_3pl',
    displayName: '3-Parameter Logistic (3PL)',
    family: 'pharmacology',
    pythonTestName: 'dose_response_3pl',
    moduleId: 'dose_response_3pl',
    description: 'Fit 3-parameter logistic curve (fixed bottom at 0)',
    requiredDataFields: [
      { name: 'dose', type: 'numeric', label: 'Dose / Concentration', description: 'X-axis values (must be > 0)' },
      { name: 'response', type: 'numeric', label: 'Response', description: 'Y-axis values (measured response)' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  dose_response_4pl: {
    id: 'dose_response_4pl',
    displayName: '4-Parameter Logistic (4PL)',
    family: 'pharmacology',
    pythonTestName: 'dose_response_4pl',
    moduleId: 'dose_response_4pl',
    description: 'Fit 4-parameter logistic curve (EC50/IC50)',
    requiredDataFields: [
      { name: 'dose', type: 'numeric', label: 'Dose / Concentration', description: 'X-axis values (must be > 0)' },
      { name: 'response', type: 'numeric', label: 'Response', description: 'Y-axis values (measured response)' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  dose_response_5pl: {
    id: 'dose_response_5pl',
    displayName: '5-Parameter Logistic (5PL)',
    family: 'pharmacology',
    pythonTestName: 'dose_response_5pl',
    moduleId: 'dose_response_5pl',
    description: 'Fit 5-parameter logistic curve (asymmetric, requires 8+ data points)',
    requiredDataFields: [
      { name: 'dose', type: 'numeric', label: 'Dose / Concentration', description: 'X-axis values (must be > 0)' },
      { name: 'response', type: 'numeric', label: 'Response', description: 'Y-axis values (measured response)' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  dose_response_compare: {
    id: 'dose_response_compare',
    displayName: 'Compare Dose-Response Models',
    family: 'pharmacology',
    pythonTestName: 'dose_response_compare',
    moduleId: 'dose_response_compare',
    description: 'Compare 3PL, 4PL, 5PL model fits and select best (AIC/BIC)',
    requiredDataFields: [
      { name: 'dose', type: 'numeric', label: 'Dose / Concentration', description: 'X-axis values (must be > 0)' },
      { name: 'response', type: 'numeric', label: 'Response', description: 'Y-axis values (measured response)' },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  synergy_bliss: {
    id: 'synergy_bliss',
    displayName: 'Bliss Independence Synergy',
    family: 'pharmacology',
    pythonTestName: 'synergy_bliss',
    moduleId: 'synergy_bliss',
    description: 'Calculate drug synergy using Bliss independence model',
    requiredDataFields: [
      { name: 'dose_a', type: 'numeric', label: 'Drug A Dose', description: 'Concentration of Drug A (include 0 for Drug B single-agent rows)' },
      { name: 'dose_b', type: 'numeric', label: 'Drug B Dose', description: 'Concentration of Drug B (include 0 for Drug A single-agent rows)' },
      { name: 'response', type: 'numeric', label: 'Response', description: 'Measured response (% inhibition or % viability)' },
      { name: 'response_a', type: 'numeric', label: 'Drug A Single-Agent Response', description: 'Optional: single-agent response for Drug A at dose_a (sparse format; no dose_b=0 rows required)', required: false },
      { name: 'response_b', type: 'numeric', label: 'Drug B Single-Agent Response', description: 'Optional: single-agent response for Drug B at dose_b (sparse format; no dose_a=0 rows required)', required: false },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  synergy_hsa: {
    id: 'synergy_hsa',
    displayName: 'HSA (Highest Single Agent) Synergy',
    family: 'pharmacology',
    pythonTestName: 'synergy_hsa',
    moduleId: 'synergy_hsa',
    description: 'Calculate drug synergy using Highest Single Agent model',
    requiredDataFields: [
      { name: 'dose_a', type: 'numeric', label: 'Drug A Dose', description: 'Concentration of Drug A (include 0 for Drug B single-agent rows)' },
      { name: 'dose_b', type: 'numeric', label: 'Drug B Dose', description: 'Concentration of Drug B (include 0 for Drug A single-agent rows)' },
      { name: 'response', type: 'numeric', label: 'Response', description: 'Measured response (% inhibition or % viability)' },
      { name: 'response_a', type: 'numeric', label: 'Drug A Single-Agent Response', description: 'Optional: single-agent response for Drug A at dose_a (sparse format; no dose_b=0 rows required)', required: false },
      { name: 'response_b', type: 'numeric', label: 'Drug B Single-Agent Response', description: 'Optional: single-agent response for Drug B at dose_b (sparse format; no dose_a=0 rows required)', required: false },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  synergy_loewe: {
    id: 'synergy_loewe',
    displayName: 'Loewe Additivity Synergy',
    family: 'pharmacology',
    pythonTestName: 'synergy_loewe',
    moduleId: 'synergy_loewe',
    description: 'Calculate drug synergy using Loewe additivity model (isoboles)',
    requiredDataFields: [
      { name: 'dose_a', type: 'numeric', label: 'Drug A Dose', description: 'Concentration of Drug A (include 0 for Drug B single-agent rows)' },
      { name: 'dose_b', type: 'numeric', label: 'Drug B Dose', description: 'Concentration of Drug B (include 0 for Drug A single-agent rows)' },
      { name: 'response', type: 'numeric', label: 'Response', description: 'Measured response (% inhibition or % viability)' },
      { name: 'response_a', type: 'numeric', label: 'Drug A Single-Agent Response', description: 'Optional: single-agent response for Drug A at dose_a (sparse format; no dose_b=0 rows required)', required: false },
      { name: 'response_b', type: 'numeric', label: 'Drug B Single-Agent Response', description: 'Optional: single-agent response for Drug B at dose_b (sparse format; no dose_a=0 rows required)', required: false },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  synergy_zip: {
    id: 'synergy_zip',
    displayName: 'ZIP (Zero Interaction Potency) Synergy',
    family: 'pharmacology',
    pythonTestName: 'synergy_zip',
    moduleId: 'synergy_zip',
    description: 'Calculate drug synergy using Zero Interaction Potency model',
    requiredDataFields: [
      { name: 'dose_a', type: 'numeric', label: 'Drug A Dose', description: 'Concentration of Drug A (include 0 for Drug B single-agent rows)' },
      { name: 'dose_b', type: 'numeric', label: 'Drug B Dose', description: 'Concentration of Drug B (include 0 for Drug A single-agent rows)' },
      { name: 'response', type: 'numeric', label: 'Response', description: 'Measured response (% inhibition or % viability)' },
      { name: 'response_a', type: 'numeric', label: 'Drug A Single-Agent Response', description: 'Optional: single-agent response for Drug A at dose_a (sparse format; no dose_b=0 rows required)', required: false },
      { name: 'response_b', type: 'numeric', label: 'Drug B Single-Agent Response', description: 'Optional: single-agent response for Drug B at dose_b (sparse format; no dose_a=0 rows required)', required: false },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  synergy_all: {
    id: 'synergy_all',
    displayName: 'Comprehensive Synergy Analysis',
    family: 'pharmacology',
    pythonTestName: 'synergy_all',
    moduleId: 'synergy_all',
    description: 'Calculate synergy using all models (Bliss, HSA, Loewe, ZIP)',
    requiredDataFields: [
      { name: 'dose_a', type: 'numeric', label: 'Drug A Dose', description: 'Concentration of Drug A (include 0 for Drug B single-agent rows)' },
      { name: 'dose_b', type: 'numeric', label: 'Drug B Dose', description: 'Concentration of Drug B (include 0 for Drug A single-agent rows)' },
      { name: 'response', type: 'numeric', label: 'Response', description: 'Measured response (% inhibition or % viability)' },
      { name: 'response_a', type: 'numeric', label: 'Drug A Single-Agent Response', description: 'Optional: single-agent response for Drug A at dose_a (sparse format; no dose_b=0 rows required)', required: false },
      { name: 'response_b', type: 'numeric', label: 'Drug B Single-Agent Response', description: 'Optional: single-agent response for Drug B at dose_b (sparse format; no dose_a=0 rows required)', required: false },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  // =========================================================================
  // SURVIVAL ANALYSIS (3)
  // =========================================================================

  kaplan_meier: {
    id: 'kaplan_meier',
    displayName: 'Kaplan-Meier Analysis',
    family: 'survival',
    pythonTestName: 'kaplan_meier',
    moduleId: 'kaplan_meier', // Phase 4: links to src/lib/modules/survival/kaplanMeierModule.ts
    description: 'Estimate survival function from time-to-event data',
    requiredDataFields: [
      { name: 'times', type: 'numeric', label: 'Time to Event', description: 'Survival/follow-up times' },
      { name: 'events', type: 'categorical', label: 'Event Indicator (0/1)', description: '1=event occurred, 0=censored' },
      { name: 'groups', type: 'categorical', label: 'Group', description: 'Optional grouping variable', required: false },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  cox_regression: {
    id: 'cox_regression',
    displayName: 'Cox Proportional Hazards',
    family: 'survival',
    pythonTestName: 'cox_regression',
    moduleId: 'cox_regression', // Phase 4: links to src/lib/modules/survival/coxRegressionModule.ts
    description: 'Model hazard ratios from covariates',
    requiredDataFields: [
      { name: 'times', type: 'numeric', label: 'Time to Event', description: 'Survival times' },
      { name: 'events', type: 'categorical', label: 'Event Indicator (0/1)', description: '1=event, 0=censored' },
      { name: 'covariates', type: 'any', label: 'Covariates', description: 'Predictor variables', multiple: true, minColumns: 1 },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  nelson_aalen: {
    id: 'nelson_aalen',
    displayName: 'Nelson-Aalen Estimator',
    family: 'survival',
    pythonTestName: 'nelson_aalen',
    moduleId: 'nelson_aalen', // Phase 4: links to src/lib/modules/survival/nelsonAalenModule.ts
    description: 'Estimate cumulative hazard function',
    requiredDataFields: [
      { name: 'times', type: 'numeric', label: 'Time to Event', description: 'Survival times' },
      { name: 'events', type: 'categorical', label: 'Event Indicator (0/1)', description: '1=event, 0=censored' },
    ],
    parameters: [],
  },

  // =========================================================================
  // MEDIATION (1)
  // =========================================================================

  mediation_model4: {
    id: 'mediation_model4',
    displayName: 'Mediation Analysis (Model 4)',
    family: 'mediation',
    pythonTestName: 'mediation_model4',
    moduleId: 'mediation_model4', // Links to src/lib/modules/mediation/mediationModule.ts
    description: 'Test indirect effect through mediator (Model 4: X → M → Y)',
    requiredDataFields: [
      { name: 'x', type: 'any', label: 'Independent Variable (X)', description: 'Predictor' },
      { name: 'm', type: 'any', label: 'Mediator (M)', description: 'Mediating variable' },
      { name: 'y', type: 'any', label: 'Dependent Variable (Y)', description: 'Outcome' },
      {
        name: 'covariates',
        type: 'any',
        label: 'Covariates (optional)',
        description: 'Optional control variables',
        multiple: true,
        required: false,
      },
    ],
    parameters: [
      { name: 'bootstrap', type: 'number', default: 5000, label: 'Bootstrap Samples', min: 1000, max: 10000, step: 1000 },
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  // =========================================================================
  // MODERATION (2)
  // =========================================================================

  moderation_model1: {
    id: 'moderation_model1',
    displayName: 'Simple Moderation (Model 1)',
    family: 'moderation',
    pythonTestName: 'moderation_model1',
    moduleId: 'moderation_model1', // Links to src/lib/modules/moderation/moderationModule.ts
    description: 'Test if moderator affects X-Y relationship (Model 1: X × W → Y)',
    requiredDataFields: [
      { name: 'x', type: 'any', label: 'Independent Variable (X)', description: 'Predictor' },
      { name: 'w', type: 'any', label: 'Moderator (W)', description: 'Moderating variable' },
      { name: 'y', type: 'any', label: 'Dependent Variable (Y)', description: 'Outcome' },
      {
        name: 'covariates',
        type: 'any',
        label: 'Covariates (optional)',
        description: 'Optional control variables',
        multiple: true,
        required: false,
      },
    ],
    parameters: [
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },

  moderated_mediation_model7: {
    id: 'moderated_mediation_model7',
    displayName: 'Moderated Mediation (Model 7)',
    family: 'moderation',
    pythonTestName: 'moderated_mediation_model7',
    moduleId: 'moderated_mediation_model7', // Links to src/lib/modules/moderation/moderatedMediationModule.ts
    description: 'Test moderated mediation where moderator affects X→M path (Model 7: X × W → M → Y)',
    requiredDataFields: [
      { name: 'x', type: 'any', label: 'Independent Variable (X)', description: 'Predictor' },
      { name: 'w', type: 'any', label: 'Moderator (W)', description: 'Moderating variable' },
      { name: 'm', type: 'any', label: 'Mediator (M)', description: 'Mediating variable' },
      { name: 'y', type: 'any', label: 'Dependent Variable (Y)', description: 'Outcome' },
      {
        name: 'covariates',
        type: 'any',
        label: 'Covariates (optional)',
        description: 'Optional control variables',
        multiple: true,
        required: false,
      },
    ],
    parameters: [
      { name: 'bootstrap', type: 'number', default: 5000, label: 'Bootstrap Samples', min: 1000, max: 10000, step: 1000 },
      { name: 'alpha', type: 'number', default: 0.05, label: 'Significance Level', min: 0.001, max: 0.5, step: 0.01 },
    ],
  },
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get test definition by ID
 */
export function getTestDefinition(id: string): TestDefinition | undefined {
  return TEST_REGISTRY[id]
}

/**
 * Get all tests for a specific family
 */
export const TEST_GROUP_ORDER: TestGroupId[] = [
  'distribution_descriptive',
  'hypothesis_testing',
  'pharmacology',
  'regression_correlation',
  'categorical',
  'survival',
  'mediation_moderation',
]

/**
 * Get tests that belong to a validation group
 */
export function getTestsByGroup(groupId: TestGroupId): TestDefinition[] {
  const group = TEST_GROUPS.find(g => g.id === groupId)
  if (!group) return []
  return group.testIds
    .map(testId => TEST_REGISTRY[testId])
    .filter((test): test is TestDefinition => Boolean(test))
}

/**
 * Get required column count for a test
 */
function getMinimumColumnsForField(field: DataFieldDef): number {
  if (field.required === false) {
    return 0
  }

  if (field.multiple) {
    return field.minColumns ?? 2
  }

  return 1
}

export function getRequiredColumnCount(testId: string): number {
  const test = TEST_REGISTRY[testId]
  if (!test) return 0
  return test.requiredDataFields.reduce((count, field) => {
    return count + getMinimumColumnsForField(field)
  }, 0)
}

/**
 * Check if test exists and is valid
 */
export function isValidTest(testId: string): boolean {
  return testId in TEST_REGISTRY
}

/**
 * Get all test IDs
 */
export function getAllTestIds(): string[] {
  return Object.keys(TEST_REGISTRY)
}

/**
 * Get test count
 */
export function getTestCount(): number {
  return Object.keys(TEST_REGISTRY).length
}

/**
 * Build default parameters object for a test
 */
export function getDefaultParameters(testId: string): Record<string, unknown> {
  const test = TEST_REGISTRY[testId]
  if (!test) return {}

  const params: Record<string, unknown> = {}
  for (const param of test.parameters) {
    params[param.name] = param.default
  }
  return params
}

/**
 * Validate that selected columns match test requirements
 */
export function validateColumnSelection(
  testId: string,
  selectedColumns: Record<string, string | string[]>
): { valid: boolean; errors: string[] } {
  const test = TEST_REGISTRY[testId]
  if (!test) {
    return { valid: false, errors: [`Unknown test: ${testId}`] }
  }

  const errors: string[] = []

  for (const field of test.requiredDataFields) {
    if (field.required === false) continue

    const selected = selectedColumns[field.name]
    if (!selected || (Array.isArray(selected) && selected.length === 0)) {
      errors.push(`Missing required field: ${field.label}`)
    }
  }

  return { valid: errors.length === 0, errors }
}

export default TEST_REGISTRY
