/**
 * Categorical Tests ECP-Style Table Builder
 *
 * Maps validated Python JSON output to ECP-Style tables:
 * - Chi-Square Independence from contingency.chi_squared_test
 * - Fisher's Exact from contingency.fisher_exact_test
 * - McNemar's Test from contingency.mcnemar_test
 * - Chi-Square Goodness of Fit from contingency.chi_squared_goodness_of_fit
 *
 * ⚠️ IMPORTANT: Python Backend Field Structure (FROZEN - DO NOT MODIFY PYTHON)
 * - chi_square (NOT chi_squared)
 * - effect_sizes.cramers_v (NESTED, not flat)
 * - effect_sizes.phi_coefficient (NESTED, not flat)
 * - odds_ratio_ci_lower/upper (NOT ci_95_lower/upper)
 * - discordant_pairs.b/c (NESTED, not flat)
 */

import type {
  ECPTable,
  ECPTableCollection,
  ECPRow,
  TableBuilderOptions,
} from '../../types/ecpStyleTables';
import { formatNumber, formatPValue, formatDF } from './index';

// =============================================================================
// CHI-SQUARE INDEPENDENCE
// =============================================================================

/**
 * Build ECP-Style tables for Chi-Square results
 */
export function buildChiSquareTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Table 1: Chi-Square Tests
  tables.push(buildChiSquareTestTable(result, options));

  // Table 2: Effect Sizes
  tables.push(buildChiSquareEffectSizeTable(result, options));

  // Table 3: Odds Ratio (for 2x2 tables)
  if (result.odds_ratio !== undefined) {
    tables.push(buildChiSquareOddsRatioTable(result, options));
  }

  return {
    testType: 'chi_square',
    testFamily: 'categorical',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
    },
  };
}

function buildChiSquareTestTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Header row
  rows.push({
    cells: [
      { value: 'Statistic', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 'Pr > ChiSq', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Pearson Chi-Square (Python returns 'chi_square')
  rows.push({
    cells: [
      { value: 'Pearson Chi-Square', align: 'left' },
      { value: formatNumber(((result.chi_square as number) ?? (result.chi_squared as number)), d), align: 'right', attrs: { 'data-stat': 'chi_square.test.chi_square' } },
      { value: formatDF(result.degrees_of_freedom as number), align: 'right', attrs: { 'data-stat': 'chi_square.test.df' } },
      { value: formatPValue(result.p_value as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.p_value as number) < options.alpha, attrs: { 'data-stat': 'chi_square.test.p_value' } },
    ],
  });

  // Likelihood Ratio
  if (result.likelihood_ratio_chi2 !== undefined) {
    rows.push({
      cells: [
        { value: 'Likelihood Ratio', align: 'left' },
        { value: formatNumber(result.likelihood_ratio_chi2 as number, d), align: 'right', attrs: { 'data-stat': 'chi_square.test.likelihood_ratio_chi2' } },
        { value: formatDF(result.degrees_of_freedom as number), align: 'right', attrs: { 'data-stat': 'chi_square.test.likelihood_ratio_df' } },
        { value: formatPValue(result.likelihood_ratio_p as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.likelihood_ratio_p as number) < options.alpha, attrs: { 'data-stat': 'chi_square.test.likelihood_ratio_p' } },
      ],
    });
  }

  return {
    title: 'Chi-Square Tests',
    columns: [
      { key: 'statistic', header: 'Statistic', align: 'left', width: 22 },
      { key: 'value', header: 'Value', align: 'right', width: 14, format: 'decimal' },
      { key: 'df', header: 'DF', align: 'right', width: 6 },
      { key: 'p', header: 'Pr > ChiSq', align: 'right', width: 14, format: 'pvalue' },
    ],
    rows,
    testName: 'chi_square_tests',
  };
}

function buildChiSquareEffectSizeTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

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

  // Phi Coefficient (for 2x2 only) - Python nests in effect_sizes
  // Python returns null for non-2x2 tables, so check for both undefined AND null
  const effectSizes = result.effect_sizes as Record<string, unknown> | undefined;
  const phi =
    (result.phi_coefficient as number | undefined | null) ??
    (effectSizes?.phi_coefficient as number | undefined | null);
  if (phi !== undefined && phi !== null) {
    rows.push({
      cells: [
        { value: 'Phi Coefficient', align: 'left' },
        { value: formatNumber(phi, d), align: 'right', attrs: { 'data-stat': 'chi_square.effect_sizes.phi_coefficient' } },
      ],
    });
  }

  // Cramer's V - Python nests in effect_sizes
  if (effectSizes?.cramers_v !== undefined) {
    rows.push({
      cells: [
        { value: "Cramér's V", align: 'left' },
        { value: formatNumber(effectSizes.cramers_v as number, d), align: 'right', attrs: { 'data-stat': 'chi_square.effect_sizes.cramers_v' } },
      ],
    });
  }

  return {
    title: 'Symmetric Measures',
    columns: [
      { key: 'measure', header: 'Measure', align: 'left', width: 18 },
      { key: 'value', header: 'Value', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    testName: 'chi_square_effect_sizes',
  };
}

function buildChiSquareOddsRatioTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Header row
  rows.push({
    cells: [
      { value: 'Measure', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
      { value: '95% CL Lower', isHeader: true, align: 'right' },
      { value: '95% CL Upper', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Odds Ratio (Python returns odds_ratio_ci_lower/upper)
  rows.push({
    cells: [
      { value: 'Odds Ratio', align: 'left' },
      { value: formatNumber(result.odds_ratio as number, d), align: 'right', attrs: { 'data-stat': 'chi_square.odds_ratio.value' } },
      { value: formatNumber(((result.ci_95_lower as number | undefined) ?? (result.odds_ratio_ci_lower as number | undefined)), d), align: 'right', attrs: { 'data-stat': 'chi_square.odds_ratio.ci_95_lower' } },
      { value: formatNumber(((result.ci_95_upper as number | undefined) ?? (result.odds_ratio_ci_upper as number | undefined)), d), align: 'right', attrs: { 'data-stat': 'chi_square.odds_ratio.ci_95_upper' } },
    ],
  });

  return {
    title: 'Risk Estimate',
    columns: [
      { key: 'measure', header: 'Measure', align: 'left', width: 16 },
      { key: 'value', header: 'Value', align: 'right', width: 12, format: 'decimal' },
      { key: 'ci_lower', header: '95% CL Lower', align: 'right', width: 14, format: 'decimal' },
      { key: 'ci_upper', header: '95% CL Upper', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    footnotes: [
      'Note: Odds Ratio only calculated for 2x2 contingency tables.',
    ],
    testName: 'chi_square_odds_ratio',
  };
}

// =============================================================================
// FISHER'S EXACT
// =============================================================================

/**
 * Build ECP-Style tables for Fisher's Exact results
 */
export function buildFishersExactTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Table 1: Fisher's Exact Test
  tables.push(buildFishersExactTable(result, options));

  return {
    testType: 'fishers_exact',
    testFamily: 'categorical',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
    },
  };
}

function buildFishersExactTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Test Results Section - use 4 columns to match Risk Estimate section below
  rows.push({
    cells: [
      { value: 'Test Results', isHeader: true, colSpan: 4, align: 'left', isBold: true },
    ],
    isSubheader: true,
  });

  rows.push({
    cells: [
      { value: 'Statistic', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
      { value: '', isHeader: true, align: 'right' },
      { value: '', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // P-value (two-tailed)
  rows.push({
    cells: [
      { value: "Fisher's Exact Test (Two-Sided)", align: 'left' },
      { value: formatPValue(result.p_value as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.p_value as number) < options.alpha, attrs: { 'data-stat': 'fishers_exact.test.p_value' } },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  });

  rows.push({ cells: [], isSeparator: true });

  // Odds Ratio Section
  rows.push({
    cells: [
      { value: 'Risk Estimate', isHeader: true, colSpan: 4, align: 'left', isBold: true },
    ],
    isSubheader: true,
  });

  rows.push({
    cells: [
      { value: 'Measure', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
      { value: '95% CL Lower', isHeader: true, align: 'right' },
      { value: '95% CL Upper', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Odds Ratio (Python returns odds_ratio_ci_lower/upper)
  rows.push({
    cells: [
      { value: 'Odds Ratio', align: 'left' },
      { value: formatNumber(result.odds_ratio as number, d), align: 'right', attrs: { 'data-stat': 'fishers_exact.odds_ratio.value' } },
      { value: formatNumber(((result.ci_95_lower as number | undefined) ?? (result.odds_ratio_ci_lower as number | undefined)), d), align: 'right', attrs: { 'data-stat': 'fishers_exact.odds_ratio.ci_95_lower' } },
      { value: formatNumber(((result.ci_95_upper as number | undefined) ?? (result.odds_ratio_ci_upper as number | undefined)), d), align: 'right', attrs: { 'data-stat': 'fishers_exact.odds_ratio.ci_95_upper' } },
    ],
  });

  return {
    title: "Fisher's Exact Test",
    columns: [
      { key: 'measure', header: 'Measure', align: 'left', width: 32 },
      { key: 'value', header: 'Value', align: 'right', width: 12, format: 'decimal' },
      { key: 'ci_lower', header: '95% CL Lower', align: 'right', width: 14, format: 'decimal' },
      { key: 'ci_upper', header: '95% CL Upper', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'fishers_exact',
  };
}

// =============================================================================
// MCNEMAR'S TEST
// =============================================================================

/**
 * Build ECP-Style tables for McNemar's Test results
 *
 * ⚠️ Python Returns (actual structure):
 * - chi_squared: number (primary) with fallback to chi_square
 * - p_value: number
 * - discordant_pairs.b: number (NESTED, not flat)
 * - discordant_pairs.c: number (NESTED, not flat)
 * - discordant_pairs.total: number
 *
 * Note: Validation CSVs show flattened discordant_b/c (for baseline comparison only)
 */
export function buildMcNemarTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Table 1: McNemar's Test Results
  tables.push(buildMcNemarTestTable(result, options));

  return {
    testType: 'mcnemar',
    testFamily: 'categorical',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
    },
  };
}

function buildMcNemarTestTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Header row
  rows.push({
    cells: [
      { value: 'Statistic', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
      { value: 'Pr > ChiSq', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // McNemar's Chi-Square (Python returns 'chi_square')
  rows.push({
    cells: [
      { value: "McNemar's Chi-Square", align: 'left' },
      { value: formatNumber(((result.chi_square as number) ?? (result.chi_squared as number)), d), align: 'right', attrs: { 'data-stat': 'mcnemar.test.chi_square' } },
      { value: formatPValue(result.p_value as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.p_value as number) < options.alpha, attrs: { 'data-stat': 'mcnemar.test.p_value' } },
    ],
  });

  // Exact p-value
  if (result.exact_p_value !== undefined) {
    rows.push({
      cells: [
        { value: "McNemar's Exact Test", align: 'left' },
        { value: '', align: 'right' },
        { value: formatPValue(result.exact_p_value as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.exact_p_value as number) < options.alpha, attrs: { 'data-stat': 'mcnemar.test.exact_p_value' } },
      ],
    });
  }

  rows.push({ cells: [], isSeparator: true });

  // Discordant pairs
  rows.push({
    cells: [
      { value: 'Discordant Pairs (b, c)', colSpan: 3, align: 'left', isBold: true },
    ],
    isSubheader: true,
  });

  // Python nests discordant pairs
  const discordantPairs = (result.discordant_pairs as Record<string, unknown> | undefined) ?? {};

  rows.push({
    cells: [
      { value: 'b (Row 2 -> Col 1)', align: 'left' },
      { value: formatNumber(((result.discordant_b as number) ?? (discordantPairs.b as number)), 0), align: 'right', attrs: { 'data-stat': 'mcnemar.discordant_pairs.b' } },
      { value: '', align: 'right' },
    ],
  });

  rows.push({
    cells: [
      { value: 'c (Row 1 -> Col 2)', align: 'left' },
      { value: formatNumber(((result.discordant_c as number) ?? (discordantPairs.c as number)), 0), align: 'right', attrs: { 'data-stat': 'mcnemar.discordant_pairs.c' } },
      { value: '', align: 'right' },
    ],
  });

  return {
    title: "McNemar's Test for Paired Data",
    columns: [
      { key: 'statistic', header: 'Statistic', align: 'left', width: 28 },
      { key: 'value', header: 'Value', align: 'right', width: 14, format: 'decimal' },
      { key: 'p', header: 'Pr > ChiSq', align: 'right', width: 14, format: 'pvalue' },
    ],
    rows,
    footnotes: [
      "Note: McNemar's Test analyzes changes in paired binary outcomes.",
      'Discordant pairs (b, c) represent observations that changed category.',
    ],
    testName: 'mcnemar',
  };
}

// =============================================================================
// CHI-SQUARE GOODNESS OF FIT
// =============================================================================

/**
 * Build ECP-Style tables for Chi-Square Goodness of Fit results
 *
 * ⚠️ Python Returns (actual structure):
 * - chi_squared: number (primary) with fallback to chi_square
 * - degrees_of_freedom: number
 * - p_value: number
 * - effect_sizes.phi_coefficient: number (NESTED, not used in tables)
 *
 * Note: Validation CSVs show chi_squared (renamed for baseline comparison only)
 */
export function buildChiSquareGofTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Table 1: Goodness of Fit Test
  tables.push(buildChiSquareGofTestTable(result, options));

  return {
    testType: 'chi_square_gof',
    testFamily: 'categorical',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
    },
  };
}

function buildChiSquareGofTestTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Header row
  rows.push({
    cells: [
      { value: 'Statistic', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 'Pr > ChiSq', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Chi-Square Goodness of Fit (Python returns 'chi_square')
  rows.push({
    cells: [
      { value: 'Chi-Square', align: 'left' },
      { value: formatNumber(((result.chi_square as number) ?? (result.chi_squared as number)), d), align: 'right', attrs: { 'data-stat': 'chi_square_gof.test.chi_square' } },
      { value: formatDF(result.degrees_of_freedom as number), align: 'right', attrs: { 'data-stat': 'chi_square_gof.test.df' } },
      { value: formatPValue(result.p_value as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.p_value as number) < options.alpha, attrs: { 'data-stat': 'chi_square_gof.test.p_value' } },
    ],
  });

  rows.push({ cells: [], isSeparator: true });

  // Sample size and categories - calculate from observed_frequencies array
  // Python returns observed_frequencies as array, not n/categories fields
  const observedFreqs = result.observed_frequencies as number[] | undefined;
  const n = observedFreqs?.reduce((sum, freq) => sum + (typeof freq === 'number' ? freq : 0), 0) ?? 0;
  const categories = observedFreqs?.length ?? 0;

  rows.push({
    cells: [
      { value: `N = ${n}, Categories = ${categories}`, align: 'left', colSpan: 4 },
    ],
  });

  return {
    title: 'Chi-Square Goodness of Fit Test',
    columns: [
      { key: 'statistic', header: 'Statistic', align: 'left', width: 22 },
      { key: 'value', header: 'Value', align: 'right', width: 14, format: 'decimal' },
      { key: 'df', header: 'DF', align: 'right', width: 6 },
      { key: 'p', header: 'Pr > ChiSq', align: 'right', width: 14, format: 'pvalue' },
    ],
    rows,
    footnotes: [
      'Note: Tests if observed frequencies match expected distribution (uniform by default).',
    ],
    testName: 'chi_square_gof',
  };
}





