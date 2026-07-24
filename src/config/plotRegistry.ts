/**
 * Plot Registry - Phase 1 Plots Feature
 *
 * Single source of truth for all plot type definitions.
 * Mirrors the pattern from testRegistry.ts.
 *
 * Key design decisions:
 * - All fields required (no optional fields, use null/[] for empty)
 * - PlotType is a discriminated union of all supported chart types
 * - Templates define primary tests (auto-generated) and alternatives (user choice)
 * - Hard caps enforce performance limits per plot type
 */

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * All supported plot types
 * Note: 'heatmap' retained for legacy compatibility (see results-store.ts)
 */
export type PlotType =
  | 'scatter'
  | 'scattergl'      // WebGL-accelerated scatter for large datasets
  | 'line'
  | 'bar'
  | 'faceted_grouped_bar'
  | 'grouped_bar'
  | 'stacked_bar'
  | 'box'
  | 'violin'
  | 'histogram'
  | 'pie'
  | 'column_scatter'  // Strip plot: individual points + mean line + error bars
  | 'survival'
  | 'doseresponse'
  | 'qq'
  | 'residual'
  | 'forest'
  | 'mosaic'
  | 'synergy_matrix'
  | 'synergy_contour'  // 2D filled contour plot for drug synergy
  | 'synergy_heatmap'  // Discrete heatmap for drug synergy (paper/manuscript style)
  | 'interaction'
  | 'heatmap'        // Legacy only - do not create new heatmap plots

/**
 * Plot categories for organization
 */
export type PlotCategory =
  | 'comparison'     // Box, violin, bar comparisons
  | 'distribution'   // Histogram, density
  | 'relationship'   // Scatter, correlation
  | 'diagnostic'     // Q-Q, residual
  | 'survival'       // Kaplan-Meier, forest
  | 'pharmacology'   // Dose-response, synergy

/**
 * Column roles for plot encoding
 */
export type PlotRole =
  | 'x'
  | 'y'
  | 'group'
  | 'color'
  | 'size'
  | 'time'
  | 'event'
  | 'dose'
  | 'response'
  | 'theta'          // For pie charts
  | 'drug1_conc'     // For synergy matrix
  | 'drug2_conc'
  | 'synergy_score'
  // Aggregated summary roles (internal use; not exposed in UI templates)
  | 'error'
  | 'q1'
  | 'median'
  | 'q3'
  | 'min'
  | 'max'
  | 'count'
  | 'sum'
  | 'std'

/**
 * Data type constraints for plot fields
 */
export type PlotDataType =
  | 'numeric'
  | 'categorical'
  | 'datetime'
  | 'any'

/**
 * Statistical family for plot-result binding (matches CLAUDE.md)
 */
export type StatisticalFamily =
  | 'hypothesis'      // Group 1: T-tests, ANOVA, non-parametric
  | 'pharmacology'    // Group 2: Dose-response, synergy
  | 'regression'      // Group 3: Linear, logistic, correlation
  | 'categorical'     // Group 4: Chi-square, Fisher's
  | 'descriptive'     // Group 5: Distribution, normality
  | 'survival'        // Group 6: Kaplan-Meier, Cox
  | 'mediation'       // Group 7: Mediation, moderation
  | 'user_derived'    // Not linked to any test

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Field requirement for a plot template
 */
export interface PlotFieldRequirement {
  role: PlotRole
  dataType: PlotDataType
  label: string
  description: string   // Default '' if none
  required: boolean     // true for requiredFields array entries
}

/**
 * Plot template definition
 * All arrays are always present (use [] for none)
 */
export interface PlotTemplate {
  id: PlotType
  displayName: string
  icon: string                        // Lucide icon name
  description: string
  category: PlotCategory
  requiredFields: PlotFieldRequirement[]
  optionalFields: PlotFieldRequirement[]  // Always [] if none
  statisticalTests: string[]          // Tests that auto-generate this plot ([] if none)
  alternativeFor: string[]            // Tests this is an alternative for ([] if none)
  builder: string                     // Builder function name
  userDerivable: boolean              // Available in user-derived plot creation
}

/**
 * Hard caps for plot performance
 * All fields required per plot type
 */
export interface PlotCap {
  maxPoints: number           // Total data points allowed
  maxGroups: number           // Max categorical groups (for grouped plots)
  maxPointsPerGroup: number   // Max points within each group
  defaultPolicy: 'raw' | 'sampled' | 'aggregated'
}

// =============================================================================
// HARD CAPS - Performance limits per plot type
// =============================================================================

export const PLOT_HARD_CAPS: Record<PlotType, PlotCap> = {
  // WebGL-enabled (can handle more points)
  scattergl:      { maxPoints: 100_000, maxGroups: 1,   maxPointsPerGroup: 100_000, defaultPolicy: 'sampled' },

  // Standard SVG plots
  scatter:        { maxPoints: 10_000,  maxGroups: 1,   maxPointsPerGroup: 10_000,  defaultPolicy: 'sampled' },
  line:           { maxPoints: 50_000,  maxGroups: 10,  maxPointsPerGroup: 5_000,   defaultPolicy: 'sampled' },
  bar:            { maxPoints: 10_000,  maxGroups: 100, maxPointsPerGroup: 100,     defaultPolicy: 'aggregated' },
  faceted_grouped_bar: { maxPoints: 20_000, maxGroups: 200, maxPointsPerGroup: 200, defaultPolicy: 'aggregated' },
  grouped_bar:    { maxPoints: 10_000,  maxGroups: 50,  maxPointsPerGroup: 200,     defaultPolicy: 'aggregated' },
  stacked_bar:    { maxPoints: 10_000,  maxGroups: 50,  maxPointsPerGroup: 200,     defaultPolicy: 'aggregated' },
  box:            { maxPoints: 500_000, maxGroups: 50,  maxPointsPerGroup: 10_000,  defaultPolicy: 'aggregated' },
  violin:         { maxPoints: 100_000, maxGroups: 20,  maxPointsPerGroup: 5_000,   defaultPolicy: 'aggregated' },
  histogram:      { maxPoints: 100_000, maxGroups: 1,   maxPointsPerGroup: 100_000, defaultPolicy: 'raw' },
  pie:            { maxPoints: 1_000,   maxGroups: 20,  maxPointsPerGroup: 50,      defaultPolicy: 'aggregated' },
  column_scatter: { maxPoints: 10_000,  maxGroups: 20,  maxPointsPerGroup: 500,     defaultPolicy: 'raw' },

  // Statistical plots
  survival:       { maxPoints: 10_000,  maxGroups: 10,  maxPointsPerGroup: 1_000,   defaultPolicy: 'aggregated' },
  forest:         { maxPoints: 500,     maxGroups: 50,  maxPointsPerGroup: 10,      defaultPolicy: 'raw' },
  qq:             { maxPoints: 5_000,   maxGroups: 1,   maxPointsPerGroup: 5_000,   defaultPolicy: 'sampled' },
  doseresponse:   { maxPoints: 1_000,   maxGroups: 10,  maxPointsPerGroup: 100,     defaultPolicy: 'raw' },
  interaction:    { maxPoints: 10_000,  maxGroups: 20,  maxPointsPerGroup: 500,     defaultPolicy: 'aggregated' },
  residual:       { maxPoints: 10_000,  maxGroups: 1,   maxPointsPerGroup: 10_000,  defaultPolicy: 'sampled' },
  mosaic:         { maxPoints: 10_000,  maxGroups: 100, maxPointsPerGroup: 100,     defaultPolicy: 'aggregated' },
  synergy_matrix: { maxPoints: 10_000,  maxGroups: 100, maxPointsPerGroup: 100,     defaultPolicy: 'raw' },
  synergy_contour: { maxPoints: 10_000, maxGroups: 100, maxPointsPerGroup: 100,     defaultPolicy: 'raw' },
  synergy_heatmap: { maxPoints: 10_000, maxGroups: 100, maxPointsPerGroup: 100,     defaultPolicy: 'raw' },

  // Legacy - do not create new heatmaps
  heatmap:        { maxPoints: 10_000,  maxGroups: 100, maxPointsPerGroup: 100,     defaultPolicy: 'aggregated' },
}

/**
 * Evaluate whether data exceeds plot caps
 * Returns the first cap that is exceeded, or null if all pass
 */
export function evaluateCap(
  plotType: PlotType,
  rowCount: number,
  groupCount: number,
  maxGroupSize: number
): { exceeded: 'maxPoints' | 'maxGroups' | 'maxPointsPerGroup'; limit: number } | null {
  const cap = PLOT_HARD_CAPS[plotType]

  if (rowCount > cap.maxPoints) {
    return { exceeded: 'maxPoints', limit: cap.maxPoints }
  }
  if (groupCount > cap.maxGroups) {
    return { exceeded: 'maxGroups', limit: cap.maxGroups }
  }
  if (maxGroupSize > cap.maxPointsPerGroup) {
    return { exceeded: 'maxPointsPerGroup', limit: cap.maxPointsPerGroup }
  }

  return null
}

// =============================================================================
// PLOT TEMPLATES - All supported plot configurations
// =============================================================================

export const PLOT_TEMPLATES: PlotTemplate[] = [
  // ─────────────────────────────────────────────────────────────
  // COMPARISON
  // ─────────────────────────────────────────────────────────────
  {
    id: 'box',
    displayName: 'Box Plot',
    icon: 'BoxPlotIcon',
    description: 'Compare distributions across groups',
    category: 'comparison',
    requiredFields: [
      { role: 'y', dataType: 'numeric', label: 'Value', description: 'Numeric values to compare', required: true },
    ],
    optionalFields: [
      { role: 'group', dataType: 'categorical', label: 'Group', description: 'Grouping variable', required: false },
      { role: 'color', dataType: 'categorical', label: 'Color By', description: 'Color grouping', required: false },
    ],
    statisticalTests: [
      'mann_whitney_u',
      'wilcoxon_signed_rank',
      'descriptive_stats',
      'outlier_detection',
    ],
    alternativeFor: [
      't_test_two_sample',
      't_test_paired',
      't_test_one_sample',
      'anova_one_way',
      'kruskal_wallis',
    ],
    builder: 'boxPlotBuilder',
    userDerivable: true,
  },
  {
    id: 'violin',
    displayName: 'Violin Plot',
    icon: 'ViolinPlotIcon',
    description: 'Distribution shape with density',
    category: 'comparison',
    requiredFields: [
      { role: 'y', dataType: 'numeric', label: 'Value', description: 'Numeric values to visualize', required: true },
    ],
    optionalFields: [
      { role: 'group', dataType: 'categorical', label: 'Group', description: 'Grouping variable', required: false },
    ],
    statisticalTests: ['descriptive_stats'],
    alternativeFor: [
      't_test_two_sample',
      't_test_paired',
      'anova_one_way',
      'mann_whitney_u',
      'wilcoxon_signed_rank',
      'kruskal_wallis',
    ],
    builder: 'violinPlotBuilder',
    userDerivable: true,
  },
  {
    id: 'column_scatter',
    displayName: 'Column Scatter',
    icon: 'ScatterChart',
    description: 'Individual points with mean line and error bars',
    category: 'comparison',
    requiredFields: [
      { role: 'y', dataType: 'numeric', label: 'Value', description: 'Numeric values to plot', required: true },
    ],
    optionalFields: [
      { role: 'group', dataType: 'categorical', label: 'Group', description: 'Grouping variable', required: false },
    ],
    statisticalTests: ['t_test_one_sample', 'outlier_detection'],
    alternativeFor: [
      'wilcoxon_signed_rank',
    ],
    builder: 'columnScatterBuilder',
    userDerivable: true,
  },
  {
    id: 'interaction',
    displayName: 'Interaction Plot',
    icon: 'GitBranchPlus',
    description: 'Factor interaction effects',
    category: 'comparison',
    requiredFields: [
      { role: 'x', dataType: 'categorical', label: 'Factor A', description: 'First factor', required: true },
      { role: 'y', dataType: 'numeric', label: 'Response', description: 'Response variable', required: true },
      { role: 'group', dataType: 'categorical', label: 'Factor B', description: 'Second factor', required: true },
    ],
    optionalFields: [],
    statisticalTests: [],
    alternativeFor: ['anova_two_way', 'multifactorial_anova'],
    builder: 'interactionPlotBuilder',
    userDerivable: false,
  },

  // ─────────────────────────────────────────────────────────────
  // RELATIONSHIP
  // ─────────────────────────────────────────────────────────────
  {
    id: 'scatter',
    displayName: 'Scatter Plot',
    icon: 'ScatterChart',
    description: 'Relationship between two variables',
    category: 'relationship',
    requiredFields: [
      { role: 'x', dataType: 'numeric', label: 'X Variable', description: 'Independent variable', required: true },
      { role: 'y', dataType: 'numeric', label: 'Y Variable', description: 'Dependent variable', required: true },
    ],
    optionalFields: [
      { role: 'color', dataType: 'categorical', label: 'Color By', description: 'Color by category', required: false },
      { role: 'size', dataType: 'numeric', label: 'Size By', description: 'Size by value', required: false },
    ],
    statisticalTests: [
      'correlation_pearson',
      'correlation_spearman',
      'correlation_kendall',
      'linear_regression',
      'logistic_binary',
      'logistic_multinomial',
    ],
    alternativeFor: [],
    builder: 'scatterBuilder',
    userDerivable: true,
  },
  {
    id: 'scattergl',
    displayName: 'Scatter Plot (Large Dataset)',
    icon: 'ScatterChart',
    description: 'High-performance scatter for large datasets',
    category: 'relationship',
    requiredFields: [
      { role: 'x', dataType: 'numeric', label: 'X Variable', description: 'Independent variable', required: true },
      { role: 'y', dataType: 'numeric', label: 'Y Variable', description: 'Dependent variable', required: true },
    ],
    optionalFields: [
      { role: 'color', dataType: 'categorical', label: 'Color By', description: 'Color by category', required: false },
    ],
    statisticalTests: [],
    alternativeFor: ['correlation_pearson', 'linear_regression'],
    builder: 'scatterBuilder',
    userDerivable: true,
  },
  {
    id: 'line',
    displayName: 'Line Chart',
    icon: 'LinePlotIcon',
    description: 'Trends over continuous variable',
    category: 'relationship',
    requiredFields: [
      { role: 'x', dataType: 'numeric', label: 'X Variable', description: 'X-axis values', required: true },
      { role: 'y', dataType: 'numeric', label: 'Y Variable', description: 'Y-axis values', required: true },
    ],
    optionalFields: [
      { role: 'group', dataType: 'categorical', label: 'Color By (Category)', description: 'Split data into multiple colored lines by category', required: false },
    ],
    statisticalTests: ['chi_square_gof', 'nelson_aalen'],
    alternativeFor: [],
    builder: 'linePlotBuilder',
    userDerivable: true,
  },

  // ─────────────────────────────────────────────────────────────
  // DISTRIBUTION
  // ─────────────────────────────────────────────────────────────
  {
    id: 'histogram',
    displayName: 'Histogram',
    icon: 'BarChart3',
    description: 'Distribution of a single variable',
    category: 'distribution',
    requiredFields: [
      { role: 'x', dataType: 'numeric', label: 'Variable', description: 'Variable to bin', required: true },
    ],
    optionalFields: [
      { role: 'group', dataType: 'categorical', label: 'Split By', description: 'Overlay histograms', required: false },
    ],
    statisticalTests: ['descriptive_stats', 'normality_shapiro', 'normality_all'],
    alternativeFor: ['t_test_one_sample'],
    builder: 'histogramBuilder',
    userDerivable: true,
  },
  {
    id: 'bar',
    displayName: 'Bar Chart',
    icon: 'BarChart2',
    description: 'Counts or values by category',
    category: 'distribution',
    requiredFields: [
      { role: 'x', dataType: 'categorical', label: 'Category', description: 'X-axis categories', required: true },
    ],
    optionalFields: [
      { role: 'y', dataType: 'numeric', label: 'Value', description: 'Y values (default: count)', required: false },
      { role: 'color', dataType: 'categorical', label: 'Color By', description: 'Color grouping variable', required: false },
    ],
    statisticalTests: [
      't_test_two_sample',
      't_test_paired',
      't_test_one_sample',
      'anova_one_way',
      'kruskal_wallis',
    ],
    alternativeFor: ['chi_squared', 'fisher_exact', 'mcnemar'],
    builder: 'barPlotBuilder',
    userDerivable: true,
  },
  {
    id: 'grouped_bar',
    displayName: 'Grouped Bar Chart',
    icon: 'GroupedBarIcon',
    description: 'Side-by-side bars by category',
    category: 'distribution',
    requiredFields: [
      { role: 'x', dataType: 'categorical', label: 'Category', description: 'X-axis categories', required: true },
      { role: 'y', dataType: 'numeric', label: 'Value', description: 'Bar heights', required: true },
      { role: 'group', dataType: 'categorical', label: 'Group', description: 'Grouping variable', required: true },
    ],
    optionalFields: [],
    statisticalTests: [
      'anova_two_way',
      'multifactorial_anova',
      'scheirer_ray_hare',
      'chi_squared',
      'chi_square_gof',
      'fisher_exact',
      'mcnemar',
    ],
    alternativeFor: [],
    builder: 'groupedBarBuilder',
    userDerivable: true,
  },
  {
    id: 'faceted_grouped_bar',
    displayName: 'Faceted Grouped Bar',
    icon: 'PanelsTopLeft',
    description: 'Grouped bars split into facets for 3+ factors',
    category: 'comparison',
    requiredFields: [
      { role: 'x', dataType: 'categorical', label: 'Category', description: 'X-axis categories', required: true },
      { role: 'y', dataType: 'numeric', label: 'Value', description: 'Bar heights', required: true },
      { role: 'group', dataType: 'categorical', label: 'Group', description: 'Grouping variable', required: true },
    ],
    optionalFields: [],
    statisticalTests: ['multifactorial_anova'],
    alternativeFor: ['anova_two_way'],
    builder: 'facetedGroupedBarBuilder',
    userDerivable: false,
  },
  {
    id: 'stacked_bar',
    displayName: 'Stacked Bar Chart',
    icon: 'StackedBarPlotIcon',
    description: 'Show proportional composition',
    category: 'distribution',
    requiredFields: [
      { role: 'x', dataType: 'categorical', label: 'Category', description: 'X-axis categories', required: true },
      { role: 'y', dataType: 'numeric', label: 'Value', description: 'Stack values', required: true },
    ],
    optionalFields: [
      { role: 'color', dataType: 'categorical', label: 'Stack By', description: 'Stacking variable', required: false },
    ],
    statisticalTests: ['chi_squared'],
    alternativeFor: ['chi_squared'],
    builder: 'stackedBarBuilder',
    userDerivable: true,
  },
  {
    id: 'pie',
    displayName: 'Pie Chart',
    icon: 'PieChart',
    description: 'Show proportions of a whole',
    category: 'distribution',
    requiredFields: [
      { role: 'theta', dataType: 'numeric', label: 'Value', description: 'Slice sizes', required: true },
      { role: 'color', dataType: 'categorical', label: 'Category', description: 'Slice labels', required: true },
    ],
    optionalFields: [],
    statisticalTests: [],
    alternativeFor: [],
    builder: 'pieChartBuilder',
    userDerivable: true,
  },
  {
    id: 'mosaic',
    displayName: 'Mosaic Plot',
    icon: 'LayoutGrid',
    description: 'Proportional area for contingency tables',
    category: 'distribution',
    requiredFields: [
      { role: 'x', dataType: 'categorical', label: 'Variable 1', description: 'First categorical variable', required: true },
      { role: 'y', dataType: 'categorical', label: 'Variable 2', description: 'Second categorical variable', required: true },
    ],
    optionalFields: [],
    statisticalTests: ['chi_squared'],
    alternativeFor: ['fisher_exact'],
    builder: 'mosaicBuilder',
    userDerivable: false,
  },

  // ─────────────────────────────────────────────────────────────
  // DIAGNOSTIC
  // ─────────────────────────────────────────────────────────────
  {
    id: 'qq',
    displayName: 'Q-Q Plot',
    icon: 'TrendingUp',
    description: 'Check normality of distribution',
    category: 'diagnostic',
    requiredFields: [
      { role: 'y', dataType: 'numeric', label: 'Variable', description: 'Values to check', required: true },
    ],
    optionalFields: [],
    statisticalTests: [
      'normality_shapiro',
      'normality_ks',
      'normality_ad',
      'normality_cvm',
      'normality_jb',
      'normality_all',
    ],
    alternativeFor: [],
    builder: 'qqPlotBuilder',
    userDerivable: false,
  },
  {
    id: 'residual',
    displayName: 'Residual Plot',
    icon: 'GitCommitHorizontal',
    description: 'Check regression assumptions',
    category: 'diagnostic',
    requiredFields: [
      { role: 'x', dataType: 'numeric', label: 'Fitted Values', description: 'Predicted values', required: true },
      { role: 'y', dataType: 'numeric', label: 'Residuals', description: 'Residual values', required: true },
    ],
    optionalFields: [],
    statisticalTests: ['linear_regression', 'multiple_linear_regression'],
    alternativeFor: [],
    builder: 'residualBuilder',
    userDerivable: false,
  },

  // ─────────────────────────────────────────────────────────────
  // SURVIVAL
  // ─────────────────────────────────────────────────────────────
  {
    id: 'survival',
    displayName: 'Survival Curve',
    icon: 'Activity',
    description: 'Kaplan-Meier survival analysis',
    category: 'survival',
    requiredFields: [
      { role: 'time', dataType: 'numeric', label: 'Time', description: 'Survival time', required: true },
      { role: 'event', dataType: 'numeric', label: 'Event (0/1)', description: 'Event indicator', required: true },
    ],
    optionalFields: [
      { role: 'group', dataType: 'categorical', label: 'Strata', description: 'Stratification variable', required: false },
    ],
    statisticalTests: ['kaplan_meier', 'nelson_aalen', 'cox_proportional_hazards'],
    alternativeFor: [],
    builder: 'survivalBuilder',
    userDerivable: false,
  },
  {
    id: 'forest',
    displayName: 'Forest Plot',
    icon: 'GitMerge',
    description: 'Effect sizes with confidence intervals',
    category: 'survival',
    requiredFields: [
      { role: 'y', dataType: 'categorical', label: 'Variable', description: 'Variable names', required: true },
      { role: 'x', dataType: 'numeric', label: 'Effect Size', description: 'Point estimates', required: true },
    ],
    optionalFields: [],
    statisticalTests: [
      'cox_proportional_hazards',
      'multiple_linear_regression',
      'logistic_binary',
      'logistic_multinomial',
      'fisher_exact',
    ],
    alternativeFor: [],
    builder: 'forestPlotBuilder',
    userDerivable: false,
  },

  // ─────────────────────────────────────────────────────────────
  // PHARMACOLOGY
  // ─────────────────────────────────────────────────────────────
  {
    id: 'doseresponse',
    displayName: 'Dose-Response Curve',
    icon: 'GitBranch',
    description: '4PL curve with IC50/EC50',
    category: 'pharmacology',
    requiredFields: [
      { role: 'dose', dataType: 'numeric', label: 'Dose/Concentration', description: 'Dose values', required: true },
      { role: 'response', dataType: 'numeric', label: 'Response', description: 'Response values', required: true },
    ],
    optionalFields: [],
    statisticalTests: ['dose_response_3pl', 'dose_response_4pl', 'dose_response_5pl'],
    alternativeFor: [],
    builder: 'doseResponseBuilder',
    userDerivable: false,
  },
  {
    id: 'synergy_matrix',
    displayName: 'Synergy Matrix',
    icon: 'Grid3X3',
    description: 'Drug synergy score visualization',
    category: 'pharmacology',
    requiredFields: [
      { role: 'drug1_conc', dataType: 'numeric', label: 'Drug 1 Concentration', description: 'First drug concentrations', required: true },
      { role: 'drug2_conc', dataType: 'numeric', label: 'Drug 2 Concentration', description: 'Second drug concentrations', required: true },
      { role: 'synergy_score', dataType: 'numeric', label: 'Synergy Score', description: 'Synergy values', required: true },
    ],
    optionalFields: [],
    statisticalTests: ['synergy_bliss', 'synergy_loewe', 'synergy_hsa', 'synergy_zip'],
    alternativeFor: [],
    builder: 'synergyMatrixBuilder',
    userDerivable: false,
  },
  {
    id: 'synergy_contour',
    displayName: 'Synergy Contour',
    icon: 'Activity',
    description: '2D filled contour plot for drug synergy (Red-White-Blue diverging)',
    category: 'pharmacology',
    requiredFields: [],  // Built from test result structure, not column roles
    optionalFields: [],
    statisticalTests: ['synergy_bliss', 'synergy_loewe', 'synergy_hsa', 'synergy_zip'],
    alternativeFor: [],
    builder: 'synergyContourBuilder',  // Placeholder builder (actual plots use custom recipes in plotResultService)
    userDerivable: false,
  },
  {
    id: 'synergy_heatmap',
    displayName: 'Synergy Heatmap (Discrete)',
    icon: 'Grid3X3',
    description: 'Discrete heatmap for drug synergy with cell values (paper/manuscript style)',
    category: 'pharmacology',
    requiredFields: [],  // Built from test result structure, not column roles
    optionalFields: [],
    statisticalTests: ['synergy_bliss', 'synergy_loewe', 'synergy_hsa', 'synergy_zip'],
    alternativeFor: [],
    builder: 'synergyHeatmapBuilder',  // Placeholder builder (actual plots use custom recipes in plotResultService)
    userDerivable: false,
  },

  // ─────────────────────────────────────────────────────────────
  // LEGACY (do not create new)
  // ─────────────────────────────────────────────────────────────
  {
    id: 'heatmap',
    displayName: 'Heatmap (Legacy)',
    icon: 'Grid2X2',
    description: 'Legacy heatmap - use Synergy Matrix instead',
    category: 'pharmacology',
    requiredFields: [
      { role: 'x', dataType: 'categorical', label: 'X', description: 'X categories', required: true },
      { role: 'y', dataType: 'categorical', label: 'Y', description: 'Y categories', required: true },
    ],
    optionalFields: [],
    statisticalTests: [
      'chi_squared',
    ],
    alternativeFor: [],
    builder: 'heatmapBuilder',
    userDerivable: false,
  },
]

// =============================================================================
// LOOKUP FUNCTIONS
// =============================================================================

/**
 * Get template by plot type
 */
export function getPlotTemplate(plotType: PlotType): PlotTemplate | undefined {
  return PLOT_TEMPLATES.find(t => t.id === plotType)
}

/**
 * Get all compatible plots for a test (primary + alternatives)
 */
export function getCompatiblePlots(testType: string): PlotTemplate[] {
  return PLOT_TEMPLATES.filter(t =>
    t.statisticalTests.includes(testType) ||
    t.alternativeFor.includes(testType)
  )
}

/**
 * Get primary plot (default auto-generated)
 */
export function getPrimaryPlot(testType: string): PlotTemplate | undefined {
  return PLOT_TEMPLATES.find(t => t.statisticalTests.includes(testType))
}

/**
 * Get alternative plots only
 */
export function getAlternativePlots(testType: string): PlotTemplate[] {
  return PLOT_TEMPLATES.filter(t => t.alternativeFor.includes(testType))
}

/**
 * Check if a plot type is compatible with a test
 */
export function isPlotCompatible(plotType: PlotType, testType: string): boolean {
  const template = getPlotTemplate(plotType)
  if (!template) return false
  return (
    template.statisticalTests.includes(testType) ||
    template.alternativeFor.includes(testType)
  )
}

/**
 * Get plots that auto-generate for a test
 */
export function getPlotsForTest(testType: string): PlotTemplate[] {
  return PLOT_TEMPLATES.filter(t =>
    t.statisticalTests.includes(testType)
  )
}

/**
 * Get user-derivable plots filtered by available column types
 */
export function getAvailableUserPlots(columnTypes: PlotDataType[]): PlotTemplate[] {
  return PLOT_TEMPLATES.filter(template => {
    if (!template.userDerivable) return false
    // All required fields must be satisfiable
    return template.requiredFields.every(field =>
      field.dataType === 'any' || columnTypes.includes(field.dataType)
    )
  })
}

/**
 * Get all user-derivable plot types
 */
export function getUserDerivablePlots(): PlotTemplate[] {
  return PLOT_TEMPLATES.filter(t => t.userDerivable)
}

/**
 * Get plot categories with their templates
 */
export function getPlotsByCategory(): Record<PlotCategory, PlotTemplate[]> {
  const result: Record<PlotCategory, PlotTemplate[]> = {
    comparison: [],
    distribution: [],
    relationship: [],
    diagnostic: [],
    survival: [],
    pharmacology: [],
  }

  for (const template of PLOT_TEMPLATES) {
    result[template.category].push(template)
  }

  return result
}

/**
 * Get incompatibility reason for a plot type with a test
 */
export function getIncompatibilityReason(plotType: PlotType, testType: string): string {
  const reasons: Partial<Record<PlotType, string>> = {
    survival: 'Requires Kaplan-Meier, Nelson-Aalen, or Cox test',
    doseresponse: 'Requires 3PL or 4PL dose-response analysis',
    forest: 'Requires Cox proportional hazards or logistic regression',
    qq: 'Requires normality test or regression residuals',
    interaction: 'Requires two-way or multifactorial ANOVA',
    synergy_matrix: 'Requires synergy analysis (Bliss/Loewe/HSA/ZIP)',
    synergy_contour: 'Requires synergy analysis (Bliss/Loewe/HSA/ZIP)',
    synergy_heatmap: 'Requires synergy analysis (Bliss/Loewe/HSA/ZIP)',
    residual: 'Requires linear or multiple regression',
  }

  const template = getPlotTemplate(plotType)
  if (!template) return 'Unknown plot type'

  // Check if it's a specialized plot with specific requirements
  if (reasons[plotType]) {
    return reasons[plotType]!
  }

  // Generic message for plots that just don't fit the test
  const compatible = getCompatiblePlots(testType)
  if (compatible.length > 0) {
    return `This test supports: ${compatible.map(p => p.displayName).join(', ')}`
  }

  return 'No compatible plots available for this test'
}
