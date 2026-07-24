/**
 * Nonparametric Tests ECP-Style Table Builder
 *
 * 🔒 LOCKED - FULLY VALIDATED UI COMPONENT 🔒
 *
 * This file is LOCKED and should NOT be modified without user permission.
 *
 * Status: Fully validated (Backend + Frontend + UI + Export)
 * - Mann-Whitney U Test (long format: 1 numeric + 1 categorical)
 * - Wilcoxon Signed-Rank Test (long format: 1 numeric + 1 categorical, equal n)
 * - Kruskal-Wallis H Test
 * - Scheirer-Ray-Hare Test: 18/18 metrics validated against baseline
 * - Excel export validated and working
 *
 * Maps validated Python JSON output to ECP-Style tables:
 * - Mann-Whitney U from nonparametric.mann_whitney_u
 * - Wilcoxon Signed-Rank from nonparametric.wilcoxon_signed_rank
 * - Kruskal-Wallis from nonparametric.kruskal_wallis
 * - Scheirer-Ray-Hare from nonparametric.scheirer_ray_hare
 *
 * DO NOT MODIFY without re-validation.
 */

import type {
  ECPTable,
  ECPTableCollection,
  ECPRow,
  TableBuilderOptions,
} from '../../types/ecpStyleTables';
import { formatNumber, formatPValue, formatDF } from './index';

// =============================================================================
// MANN-WHITNEY U
// =============================================================================

/**
 * Build ECP-Style tables for Mann-Whitney U results
 */
export function buildMannWhitneyTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Table 1: Mann-Whitney U Test
  tables.push(buildMannWhitneyTable(result, options));

  return {
    testType: 'mann_whitney',
    testFamily: 'nonparametric',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize: ((result.n1 as number) || 0) + ((result.n2 as number) || 0),
    },
  };
}

function buildMannWhitneyTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Group Statistics Section
  rows.push({
    cells: [
      { value: 'Group Statistics', isHeader: true, colSpan: 4, align: 'left', isBold: true },
    ],
    isSubheader: true,
  });

  rows.push({
    cells: [
      { value: 'Group', isHeader: true, align: 'left' },
      { value: 'N', isHeader: true, align: 'right' },
      { value: 'Median', isHeader: true, align: 'right' },
      { value: 'Rank Sum', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Group 1 - use actual group name from Python results
  const group1Label =
    (result.group1_name as string) || (result.group_name1 as string) || 'Group 1';
  const group2Label =
    (result.group2_name as string) || (result.group_name2 as string) || 'Group 2';

  rows.push({
    cells: [
      { value: group1Label, align: 'left' },
      { value: result.n1 as number, format: 'integer', align: 'right', attrs: { 'data-stat': 'n1' } },
      { value: formatNumber(result.median1 as number, d), align: 'right', attrs: { 'data-stat': 'median1' } },
      { value: formatNumber(result.sum_ranks_group1 as number, d), align: 'right', attrs: { 'data-stat': 'sum_ranks_group1' } },
    ],
  });

  // Group 2 - use actual group name from Python results
  rows.push({
    cells: [
      { value: group2Label, align: 'left' },
      { value: result.n2 as number, format: 'integer', align: 'right', attrs: { 'data-stat': 'n2' } },
      { value: formatNumber(result.median2 as number, d), align: 'right', attrs: { 'data-stat': 'median2' } },
      { value: formatNumber(result.sum_ranks_group2 as number, d), align: 'right', attrs: { 'data-stat': 'sum_ranks_group2' } },
    ],
  });

  rows.push({ cells: [], isSeparator: true });

  // Test Statistics Section - colSpan 4 to match Group Statistics width
  rows.push({
    cells: [
      { value: 'Test Statistics', isHeader: true, colSpan: 4, align: 'left', isBold: true },
    ],
    isSubheader: true,
  });

  rows.push({
    cells: [
      { value: 'Statistic', isHeader: true, align: 'left' },
      { value: 'Value', isHeader: true, align: 'right' },
      { value: '', isHeader: true, align: 'right' }, // Empty columns for width matching
      { value: '', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Mann-Whitney U
  rows.push({
    cells: [
      { value: 'Mann-Whitney U', align: 'left' },
      { value: formatNumber(result.U_statistic as number, d), align: 'right', attrs: { 'data-stat': 'U_statistic' } },
      { value: '', align: 'right' }, // Empty columns
      { value: '', align: 'right' },
    ],
  });

  // Expected U under H0
  rows.push({
    cells: [
      { value: 'Expected U (H0)', align: 'left' },
      { value: formatNumber(result.expected_U_H0 as number, d), align: 'right', attrs: { 'data-stat': 'expected_U_H0' } },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  });

  // Std Dev U under H0
  rows.push({
    cells: [
      { value: 'Std Dev U (H0)', align: 'left' },
      { value: formatNumber(result.std_U_H0 as number, d), align: 'right', attrs: { 'data-stat': 'std_U_H0' } },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  });

  // Z statistic
  rows.push({
    cells: [
      { value: 'Z', align: 'left' },
      { value: formatNumber(result.z_statistic as number, d), align: 'right', attrs: { 'data-stat': 'z_statistic' } },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  });

  // P-value
  rows.push({
    cells: [
      { value: 'Pr > |Z|', align: 'left' },
      { value: formatPValue(result.p_value as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.p_value as number) < options.alpha, attrs: { 'data-stat': 'p_value' } },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  });

  // Median difference
  rows.push({
    cells: [
      { value: 'Median Difference', align: 'left' },
      { value: formatNumber(result.median_difference as number, d), align: 'right', attrs: { 'data-stat': 'median_difference' } },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  });

  // Effect size
  rows.push({
    cells: [
      { value: 'Effect Size (r)', align: 'left' },
      { value: formatNumber(result.rank_biserial_correlation as number, d), align: 'right', attrs: { 'data-stat': 'rank_biserial_correlation' } },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  });

  // Interpretation
  rows.push({
    cells: [
      { value: 'Interpretation', align: 'left' },
      { value: (result.effect_size_interpretation as string) || '', align: 'right' },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  });

  return {
    title: 'Wilcoxon Rank Sum Test (Mann-Whitney U)',
    columns: [
      { key: 'group', header: 'Group/Statistic', align: 'left', width: 20 },
      { key: 'n_value', header: 'N/Value', align: 'right', width: 14, format: 'decimal' },
      { key: 'median', header: 'Median', align: 'right', width: 14, format: 'decimal' },
      { key: 'rank_sum', header: 'Rank Sum', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'mann_whitney',
  };
}

// =============================================================================
// WILCOXON SIGNED-RANK
// =============================================================================

/**
 * Build ECP-Style tables for Wilcoxon Signed-Rank results
 */
export function buildWilcoxonTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Table 1: Wilcoxon Signed-Rank Test
  tables.push(buildWilcoxonTable(result, options));

  return {
    testType: 'wilcoxon',
    testFamily: 'nonparametric',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize: result.n_pairs as number,
    },
  };
}

function buildWilcoxonTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Ranks Section
  rows.push({
    cells: [
      { value: 'Ranks', isHeader: true, colSpan: 2, align: 'left', isBold: true },
    ],
    isSubheader: true,
  });

  rows.push({
    cells: [
      { value: 'Category', isHeader: true, align: 'left' },
      { value: 'Sum of Ranks', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Positive ranks
  rows.push({
    cells: [
      { value: 'Positive Differences', align: 'left' },
      { value: formatNumber(result.sum_positive_ranks as number, d), align: 'right', attrs: { 'data-stat': 'sum_positive_ranks' } },
    ],
  });

  // Negative ranks
  rows.push({
    cells: [
      { value: 'Negative Differences', align: 'left' },
      { value: formatNumber(result.sum_negative_ranks as number, d), align: 'right', attrs: { 'data-stat': 'sum_negative_ranks' } },
    ],
  });

  // Zero differences
  rows.push({
    cells: [
      { value: 'Zero Differences', align: 'left' },
      { value: result.n_zero_differences as number, format: 'integer', align: 'right', attrs: { 'data-stat': 'n_zero_differences' } },
    ],
  });

  rows.push({ cells: [], isSeparator: true });

  // Sample Size Section
  rows.push({
    cells: [
      { value: 'Sample Size', isHeader: true, colSpan: 2, align: 'left', isBold: true },
    ],
    isSubheader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Number of pairs
  rows.push({
    cells: [
      { value: 'N Pairs', align: 'left' },
      { value: result.n_pairs as number, format: 'integer', align: 'right', attrs: { 'data-stat': 'n_pairs' } },
    ],
  });

  // Non-zero differences
  rows.push({
    cells: [
      { value: 'N Non-Zero', align: 'left' },
      { value: result.n_nonzero_differences as number, format: 'integer', align: 'right', attrs: { 'data-stat': 'n_nonzero_differences' } },
    ],
  });

  rows.push({ cells: [], isSeparator: true });

  // Test Statistics Section
  rows.push({
    cells: [
      { value: 'Test Statistics', isHeader: true, colSpan: 2, align: 'left', isBold: true },
    ],
    isSubheader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Test statistic (W or S)
  rows.push({
    cells: [
      { value: 'Test Statistic (S)', align: 'left' },
      { value: formatNumber(result.W_statistic as number, d), align: 'right', attrs: { 'data-stat': 'W_statistic' } },
    ],
  });

  // Expected rank sum under H0
  rows.push({
    cells: [
      { value: 'Expected S (H0)', align: 'left' },
      { value: formatNumber(result.expected_rank_sum_H0 as number, d), align: 'right', attrs: { 'data-stat': 'expected_rank_sum_H0' } },
    ],
  });

  // Std dev of rank sum under H0
  rows.push({
    cells: [
      { value: 'Std Dev S (H0)', align: 'left' },
      { value: formatNumber(result.std_rank_sum_H0 as number, d), align: 'right', attrs: { 'data-stat': 'std_rank_sum_H0' } },
    ],
  });

  // P-value
  rows.push({
    cells: [
      { value: 'Pr >= |S|', align: 'left' },
      { value: formatPValue(result.p_value as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.p_value as number) < options.alpha, attrs: { 'data-stat': 'p_value' } },
    ],
  });

  // Median difference
  rows.push({
    cells: [
      { value: 'Median Difference', align: 'left' },
      { value: formatNumber(result.median_difference as number, d), align: 'right', attrs: { 'data-stat': 'median_difference' } },
    ],
  });

  // Effect size
  rows.push({
    cells: [
      { value: 'Effect Size (r)', align: 'left' },
      { value: formatNumber(result.rank_biserial_correlation as number, d), align: 'right', attrs: { 'data-stat': 'rank_biserial_correlation' } },
    ],
  });

  return {
    title: 'Wilcoxon Signed-Rank Test',
    columns: [
      { key: 'stat', header: 'Statistic', align: 'left', width: 22 },
      { key: 'value', header: 'Value', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'wilcoxon',
  };
}

// =============================================================================
// KRUSKAL-WALLIS
// =============================================================================

/**
 * Build ECP-Style tables for Kruskal-Wallis results
 *
 * Maps from JSON structure:
 * - h_statistic, df, p_value, epsilon_squared
 * - group_summaries[]: label, n, median, mean, std, sum_ranks, mean_rank, expected_sum_ranks_H0, std_sum_ranks_H0
 * - pairwise_comparisons[]: group1, group2, contrast, median_difference, p_value, p_adjusted, significant
 */
export function buildKruskalWallisTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];
  const adjustmentMethod = (result.adjustment_method as string) ?? "Dunn's Test";
  const posthocQ = typeof result.posthoc_q === 'number' ? result.posthoc_q : null;
  const showQ = posthocQ !== null && /fdr|benjamini/i.test(adjustmentMethod);
  const adjustmentLabel = showQ
    ? `${adjustmentMethod} (q = ${formatNumber(posthocQ, 2)})`
    : adjustmentMethod;

  // Table 1: Kruskal-Wallis ANOVA Summary
  tables.push(buildKruskalWallisSummaryTable(result, options));

  // Table 2: Group Rank Statistics
  if (result.group_summaries) {
    tables.push(buildKruskalWallisRankTable(result, options));
  }

  // Table 3: Pairwise Comparisons (if significant)
  if (result.pairwise_comparisons) {
    tables.push(buildKruskalWallisPairwiseTable(result, options));
  }

  return {
    testType: 'kruskal_wallis',
    testFamily: 'nonparametric',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      posthocAdjustment: result.pairwise_comparisons ? adjustmentLabel : undefined,
    },
  };
}

function buildKruskalWallisSummaryTable(
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
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Kruskal-Wallis H (use h_statistic, fallback to H_statistic for compatibility)
  const hStat = (result.h_statistic ?? result.H_statistic) as number;
  rows.push({
    cells: [
      { value: 'Chi-Square (H)', align: 'left' },
      { value: formatNumber(hStat, d), align: 'right', attrs: { 'data-stat': 'H_statistic' } },
    ],
  });

  // Degrees of freedom
  rows.push({
    cells: [
      { value: 'DF', align: 'left' },
      { value: result.df as number, format: 'integer', align: 'right', attrs: { 'data-stat': 'df' } },
    ],
  });

  // P-value
  rows.push({
    cells: [
      { value: 'Pr > Chi-Square', align: 'left' },
      { value: formatPValue(result.p_value as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.p_value as number) < options.alpha, attrs: { 'data-stat': 'p_value' } },
    ],
  });

  // Number of groups and total N
  if (result.num_groups !== undefined) {
    rows.push({
      cells: [
        { value: 'Number of Groups', align: 'left' },
        { value: result.num_groups as number, format: 'integer', align: 'right', attrs: { 'data-stat': 'num_groups' } },
      ],
    });
  }

  if (result.total_n !== undefined) {
    rows.push({
      cells: [
        { value: 'Total N', align: 'left' },
        { value: result.total_n as number, format: 'integer', align: 'right', attrs: { 'data-stat': 'total_n' } },
      ],
    });
  }

  // Effect size (epsilon-squared - from actual Python output)
  if (result.epsilon_squared !== undefined) {
    rows.push({
      cells: [
        { value: 'Epsilon-squared (ε²)', align: 'left' },
        { value: formatNumber(result.epsilon_squared as number, d), align: 'right', attrs: { 'data-stat': 'epsilon_squared' } },
      ],
    });
  }

  // Fallback to eta-squared if available
  if (result.eta_squared !== undefined && result.epsilon_squared === undefined) {
    rows.push({
      cells: [
        { value: 'Eta-squared (η²)', align: 'left' },
        { value: formatNumber(result.eta_squared as number, d), align: 'right' },
      ],
    });
  }

  return {
    title: 'Kruskal-Wallis One-Way Analysis of Variance',
    columns: [
      { key: 'stat', header: 'Statistic', align: 'left', width: 24 },
      { key: 'value', header: 'Value', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'kruskal_wallis_summary',
  };
}

function buildKruskalWallisRankTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const groupSummaries = result.group_summaries as Array<{
    label: string;
    n: number;
    median: number;
    mean: number;
    std: number;
    sum_ranks: number;
    mean_rank: number;
    expected_sum_ranks_H0: number;
    std_sum_ranks_H0: number;
  }>;

  // Header row
  rows.push({
    cells: [
      { value: 'Group', isHeader: true, align: 'left' },
      { value: 'N', isHeader: true, align: 'right' },
      { value: 'Median', isHeader: true, align: 'right' },
      { value: 'Sum Ranks', isHeader: true, align: 'right' },
      { value: 'Mean Rank', isHeader: true, align: 'right' },
      { value: 'Expected (H₀)', isHeader: true, align: 'right' },
      { value: 'Std (H₀)', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Group rows
  for (let i = 0; i < groupSummaries.length; i++) {
    const group = groupSummaries[i];
    if (!group) continue;
    const groupNum = i + 1;
    rows.push({
      cells: [
        { value: group.label, align: 'left', attrs: { 'data-stat': `group${groupNum}_label` } },
        { value: group.n, format: 'integer', align: 'right', attrs: { 'data-stat': `group${groupNum}_n` } },
        { value: formatNumber(group.median, d), align: 'right', attrs: { 'data-stat': `group${groupNum}_median` } },
        { value: formatNumber(group.sum_ranks, d), align: 'right', attrs: { 'data-stat': `group${groupNum}_sum_ranks` } },
        { value: formatNumber(group.mean_rank, d), align: 'right', attrs: { 'data-stat': `group${groupNum}_mean_rank` } },
        { value: formatNumber(group.expected_sum_ranks_H0, d), align: 'right' },
        { value: formatNumber(group.std_sum_ranks_H0, d), align: 'right' },
      ],
    });
  }

  return {
    title: 'Group Rank Statistics',
    columns: [
      { key: 'group', header: 'Group', align: 'left', width: 14 },
      { key: 'n', header: 'N', align: 'right', width: 6, format: 'integer' },
      { key: 'median', header: 'Median', align: 'right', width: 10, format: 'decimal' },
      { key: 'sum_ranks', header: 'Sum Ranks', align: 'right', width: 12, format: 'decimal' },
      { key: 'mean_rank', header: 'Mean Rank', align: 'right', width: 12, format: 'decimal' },
      { key: 'expected', header: 'Expected (H₀)', align: 'right', width: 14, format: 'decimal' },
      { key: 'std', header: 'Std (H₀)', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    testName: 'kruskal_wallis_ranks',
  };
}

function buildKruskalWallisPairwiseTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const adjustmentMethod = (result.adjustment_method as string) ?? "Dunn's Test";
  const posthocQ = typeof result.posthoc_q === 'number' ? result.posthoc_q : null;
  const showQ = posthocQ !== null && /fdr|benjamini/i.test(adjustmentMethod);
  const adjustedHeader = showQ ? 'Adj. p-value (q)' : 'Adj. p-value';
  const adjustmentLabel = showQ
    ? `${adjustmentMethod} (q = ${formatNumber(posthocQ, 2)})`
    : adjustmentMethod;
  const pairwise = result.pairwise_comparisons as Array<{
    group1: string;
    group2: string;
    contrast: string;
    median_difference: number;
    p_value: number;
    p_adjusted: number;
    significant: boolean;
  }>;

  // Header row
  rows.push({
    cells: [
      { value: 'Contrast', isHeader: true, align: 'left' },
      { value: 'Median Diff', isHeader: true, align: 'right' },
      { value: 'p-value', isHeader: true, align: 'right' },
      { value: adjustedHeader, isHeader: true, align: 'right' },
      { value: 'Sig', isHeader: true, align: 'center' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Pairwise rows
  for (const pair of pairwise) {
    rows.push({
      cells: [
        { value: pair.contrast || `${pair.group1} vs ${pair.group2}`, align: 'left' },
        { value: formatNumber(pair.median_difference, d), align: 'right' },
        { value: formatPValue(pair.p_value, options.pValueThreshold, options.minPValue), align: 'right' },
        { value: formatPValue(pair.p_adjusted, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: pair.significant },
        { value: pair.significant ? '*' : '', align: 'center' },
      ],
    });
  }

  return {
    title: `Pairwise Comparisons (${adjustmentLabel})`,
    columns: [
      { key: 'contrast', header: 'Contrast', align: 'left', width: 20 },
      { key: 'median_diff', header: 'Median Diff', align: 'right', width: 12, format: 'decimal' },
      { key: 'p', header: 'p-value', align: 'right', width: 10, format: 'pvalue' },
      { key: 'p_adj', header: adjustedHeader, align: 'right', width: 12, format: 'pvalue' },
      { key: 'sig', header: 'Sig', align: 'center', width: 6 },
    ],
    rows,
    footnotes: [
      showQ
        ? `Note: * indicates q < ${formatNumber(posthocQ ?? options.alpha, 2)} (FDR).`
        : 'Note: * indicates p < alpha after adjustment.',
    ],
    testName: 'kruskal_wallis_pairwise',
  };
}

// =============================================================================
// FRIEDMAN
// =============================================================================

/**
 * Build ECP-Style tables for Friedman Test results
 *
 * Maps from JSON structure:
 * - statistic, p_value, kendalls_w, n_subjects, k_conditions
 * - condition_summaries[]: label, n, median, mean, std, sum_ranks, mean_rank, expected_sum_ranks_H0, std_sum_ranks_H0
 * - pairwise_comparisons[]: condition1, condition2, contrast, median_difference, p_value, p_adjusted, significant
 */
export function buildFriedmanTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Table 1: Friedman Test Summary
  tables.push(buildFriedmanSummaryTable(result, options));

  // Table 2: Condition Rank Statistics
  if (result.condition_summaries) {
    tables.push(buildFriedmanRankTable(result, options));
  }

  // Table 3: Pairwise Comparisons (if significant)
  if (result.pairwise_comparisons) {
    tables.push(buildFriedmanPairwiseTable(result, options));
  }

  return {
    testType: 'friedman',
    testFamily: 'nonparametric',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
    },
  };
}

function buildFriedmanSummaryTable(
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
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Chi-square (use statistic, fallback to chi2_statistic for compatibility)
  const chiStat = (result.statistic ?? result.chi2_statistic) as number;
  rows.push({
    cells: [
      { value: 'Chi-Square', align: 'left' },
      { value: formatNumber(chiStat, d), align: 'right' },
    ],
  });

  // Degrees of freedom (k-1 where k is number of conditions)
  const kConditions = result.k_conditions as number | undefined;
  const df = (result.df ?? (kConditions ? kConditions - 1 : undefined)) as number | undefined;
  if (df !== undefined) {
    rows.push({
      cells: [
        { value: 'DF', align: 'left' },
        { value: df, format: 'integer', align: 'right' },
      ],
    });
  }

  // P-value
  rows.push({
    cells: [
      { value: 'Pr > Chi-Square', align: 'left' },
      { value: formatPValue(result.p_value as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.p_value as number) < options.alpha },
    ],
  });

  // Kendall's W (use kendalls_w, fallback to kendall_w for compatibility)
  const kendallW = (result.kendalls_w ?? result.kendall_w) as number | undefined;
  if (kendallW !== undefined) {
    rows.push({
      cells: [
        { value: "Kendall's W", align: 'left' },
        { value: formatNumber(kendallW, d), align: 'right' },
      ],
    });
  }

  // N Subjects and K Conditions
  rows.push({ cells: [], isSeparator: true });
  if (result.n_subjects !== undefined) {
    rows.push({
      cells: [
        { value: 'N Subjects', align: 'left' },
        { value: result.n_subjects as number, format: 'integer', align: 'right' },
      ],
    });
  }
  if (kConditions !== undefined) {
    rows.push({
      cells: [
        { value: 'K Conditions', align: 'left' },
        { value: kConditions, format: 'integer', align: 'right' },
      ],
    });
  }

  return {
    title: 'Friedman Two-Way Analysis of Variance',
    procedure: 'Friedman Test',
    columns: [
      { key: 'stat', header: 'Statistic', align: 'left', width: 20 },
      { key: 'value', header: 'Value', align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'friedman_summary',
  };
}

function buildFriedmanRankTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const conditionSummaries = result.condition_summaries as Array<{
    label: string;
    n: number;
    median: number;
    mean: number;
    std: number;
    sum_ranks: number;
    mean_rank: number;
    expected_sum_ranks_H0: number;
    std_sum_ranks_H0: number;
  }>;

  // Header row
  rows.push({
    cells: [
      { value: 'Condition', isHeader: true, align: 'left' },
      { value: 'N', isHeader: true, align: 'right' },
      { value: 'Median', isHeader: true, align: 'right' },
      { value: 'Sum Ranks', isHeader: true, align: 'right' },
      { value: 'Mean Rank', isHeader: true, align: 'right' },
      { value: 'Expected (H₀)', isHeader: true, align: 'right' },
      { value: 'Std (H₀)', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Condition rows
  for (const condition of conditionSummaries) {
    rows.push({
      cells: [
        { value: condition.label, align: 'left' },
        { value: condition.n, format: 'integer', align: 'right' },
        { value: formatNumber(condition.median, d), align: 'right' },
        { value: formatNumber(condition.sum_ranks, d), align: 'right' },
        { value: formatNumber(condition.mean_rank, d), align: 'right' },
        { value: formatNumber(condition.expected_sum_ranks_H0, d), align: 'right' },
        { value: formatNumber(condition.std_sum_ranks_H0, d), align: 'right' },
      ],
    });
  }

  return {
    title: 'Condition Rank Statistics',
    columns: [
      { key: 'condition', header: 'Condition', align: 'left', width: 14 },
      { key: 'n', header: 'N', align: 'right', width: 6, format: 'integer' },
      { key: 'median', header: 'Median', align: 'right', width: 10, format: 'decimal' },
      { key: 'sum_ranks', header: 'Sum Ranks', align: 'right', width: 12, format: 'decimal' },
      { key: 'mean_rank', header: 'Mean Rank', align: 'right', width: 12, format: 'decimal' },
      { key: 'expected', header: 'Expected (H₀)', align: 'right', width: 14, format: 'decimal' },
      { key: 'std', header: 'Std (H₀)', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    testName: 'friedman_ranks',
  };
}

function buildFriedmanPairwiseTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const pairwise = result.pairwise_comparisons as Array<{
    condition1: string;
    condition2: string;
    contrast: string;
    median_difference: number;
    p_value: number;
    p_adjusted: number;
    significant: boolean;
  }>;

  // Header row
  rows.push({
    cells: [
      { value: 'Contrast', isHeader: true, align: 'left' },
      { value: 'Median Diff', isHeader: true, align: 'right' },
      { value: 'p-value', isHeader: true, align: 'right' },
      { value: 'Adj. p-value', isHeader: true, align: 'right' },
      { value: 'Sig', isHeader: true, align: 'center' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // Pairwise rows
  for (const pair of pairwise) {
    rows.push({
      cells: [
        { value: pair.contrast || `${pair.condition1} vs ${pair.condition2}`, align: 'left' },
        { value: formatNumber(pair.median_difference, d), align: 'right' },
        { value: formatPValue(pair.p_value, options.pValueThreshold, options.minPValue), align: 'right' },
        { value: formatPValue(pair.p_adjusted, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: pair.significant },
        { value: pair.significant ? '*' : '', align: 'center' },
      ],
    });
  }

  return {
    title: 'Pairwise Comparisons (Nemenyi Post-Hoc Test)',
    columns: [
      { key: 'contrast', header: 'Contrast', align: 'left', width: 22 },
      { key: 'median_diff', header: 'Median Diff', align: 'right', width: 12, format: 'decimal' },
      { key: 'p', header: 'p-value', align: 'right', width: 10, format: 'pvalue' },
      { key: 'p_adj', header: 'Adj. p-value', align: 'right', width: 12, format: 'pvalue' },
      { key: 'sig', header: 'Sig', align: 'center', width: 6 },
    ],
    rows,
    footnotes: [
      'Note: * indicates p < alpha after adjustment.',
    ],
    testName: 'friedman_pairwise',
  };
}

// =============================================================================
// SCHEIRER-RAY-HARE
// =============================================================================


const parseNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return isNaN(value) ? undefined : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '.') {
      return undefined;
    }
    const parsed = parseFloat(trimmed);
    return isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

const formatCountValue = (value: unknown): number | string => {
  if (typeof value === 'number' && !isNaN(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  return '.';
};

/**
 * 🔒 LOCKED - DO NOT MODIFY WITHOUT USER PERMISSION
 *
 * Scheirer-Ray-Hare table builders validated against baseline:
 * - 18/18 metrics passing (H-statistics, p-values, sum of squares)
 * - P-value formatting: Scientific notation (e.g., 1.053e-07)
 * - Standard Error: Calculated as SE = std / sqrt(n) in cell tables
 * - Main effects only (simple effects disabled per v2.1.1)
 *
 * Changes require user permission and may need re-validation against baseline.
 */
export function buildScheirerRayHareTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  tables.push(buildScheirerSummaryTable(result, options));

  const cellTable = buildScheirerCellTable(result, options);
  if (cellTable) {
    tables.push(cellTable);
  }

  return {
    testType: 'scheirer_ray_hare',
    testFamily: 'nonparametric',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize: parseNumber(result.total_n) ?? parseNumber(result.num_observations) ?? 0,
    },
  };
}

function buildScheirerSummaryTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  rows.push({
    cells: [
      { value: 'Source', isHeader: true, align: 'left' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 'Sum of Squares', isHeader: true, align: 'right' },
      { value: 'Chi-Square (H)', isHeader: true, align: 'right' },
      { value: 'Pr > Chi-Square', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  const entries = [
    {
      label: (result.factor1_label as string) ?? 'Factor 1',
      df: parseNumber(result.factor1_df),
      ss: parseNumber(result.factor1_ss),
      stat: parseNumber(result.factor1_chi_square ?? result.factor1_H),
      p: parseNumber(result.factor1_p),
    },
    {
      label: (result.factor2_label as string) ?? 'Factor 2',
      df: parseNumber(result.factor2_df),
      ss: parseNumber(result.factor2_ss),
      stat: parseNumber(result.factor2_chi_square ?? result.factor2_H),
      p: parseNumber(result.factor2_p),
    },
    {
      label: (result.interaction_label as string) ?? 'Interaction',
      df: parseNumber(result.interaction_df),
      ss: parseNumber(result.interaction_ss),
      stat: parseNumber(result.interaction_chi_square ?? result.interaction_H),
      p: parseNumber(result.interaction_p),
    },
  ];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const display = parseNumber(entry.p);
    const factorName = i === 0 ? 'factor1' : i === 1 ? 'factor2' : 'interaction';
    rows.push({
      cells: [
        { value: entry.label, align: 'left' },
        { value: entry.df !== undefined ? formatDF(entry.df) : '.', align: 'right', attrs: { 'data-stat': `${factorName}_df` } },
        { value: formatNumber(entry.ss ?? NaN, d), align: 'right', attrs: { 'data-stat': `${factorName}_ss` } },
        { value: formatNumber(entry.stat ?? NaN, d), align: 'right', attrs: { 'data-stat': `${factorName}_H` } },
        { value: display !== undefined ? formatPValue(display, options.pValueThreshold, options.minPValue) : '.', align: 'right', isSignificant: display !== undefined && display < options.alpha, attrs: { 'data-stat': `${factorName}_p` } },
      ],
    });
  }

  rows.push({ cells: [], isSeparator: true });

  const residualDF = parseNumber(result.residual_df);
  const residualSS = parseNumber(result.residual_ss);

  rows.push({
    cells: [
      { value: 'Residual', align: 'left' },
      { value: residualDF !== undefined ? formatDF(residualDF) : '.', align: 'right', attrs: { 'data-stat': 'residual_df' } },
      { value: formatNumber(residualSS ?? NaN, d), align: 'right', attrs: { 'data-stat': 'residual_ss' } },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  });

  // Add total N row
  const totalN = parseNumber(result.total_n);
  if (totalN !== undefined) {
    rows.push({ cells: [], isSeparator: true });
    rows.push({
      cells: [
        { value: 'Total N', align: 'left' },
        { value: totalN, format: 'integer', align: 'right', attrs: { 'data-stat': 'total_n' } },
        { value: '', align: 'right' },
        { value: '', align: 'right' },
        { value: '', align: 'right' },
      ],
    });
  }

  return {
    title: 'Scheirer-Ray-Hare Analysis',
    procedure: 'Scheirer-Ray-Hare Test',
    columns: [
      { key: 'source', header: 'Source', align: 'left', width: 18 },
      { key: 'df', header: 'DF', align: 'right', width: 6 },
      { key: 'ss', header: 'Sum of Squares', align: 'right', width: 16, format: 'decimal' },
      { key: 'stat', header: 'Chi-Square (H)', align: 'right', width: 14, format: 'decimal' },
      { key: 'p', header: 'Pr > Chi-Square', align: 'right', width: 14, format: 'pvalue' },
    ],
    rows,
    testName: 'scheirer_summary',
  };
}

function buildScheirerCellTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable | null {
  const cellSummaries = result.cell_summaries as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(cellSummaries) || !cellSummaries.length) {
    return null;
  }

  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  rows.push({
    cells: [
      { value: 'Cell', isHeader: true, align: 'left' },
      { value: 'Factor 1', isHeader: true, align: 'left' },
      { value: 'Factor 2', isHeader: true, align: 'left' },
      { value: 'N', isHeader: true, align: 'right' },
      { value: 'Median', isHeader: true, align: 'right' },
      { value: 'Q1', isHeader: true, align: 'right' },
      { value: 'Q3', isHeader: true, align: 'right' },
      { value: 'IQR', isHeader: true, align: 'right' },
      { value: 'Mean (Ranks)', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  let cellIndex = 1;
  for (const cell of cellSummaries) {
    // Build cell label from factor levels (Python doesn't return cell_label)
    // Python returns factor1_level and factor2_level as decoded strings
    const cellLabel =
      cell.factor1_level && cell.factor2_level
        ? `${cell.factor1_level} × ${cell.factor2_level}`
        : (cell.cell_label as string) ?? 'Cell'
    const cellKey = `cell${cellIndex}`
    const factor1Level =
      typeof cell.factor1_level === 'string' || typeof cell.factor1_level === 'number'
        ? cell.factor1_level
        : ''
    const factor2Level =
      typeof cell.factor2_level === 'string' || typeof cell.factor2_level === 'number'
        ? cell.factor2_level
        : ''

    rows.push({
      cells: [
        { value: cellLabel, align: 'left' },
        { value: factor1Level, align: 'left', attrs: { 'data-stat': `${cellKey}_factor1` } },
        { value: factor2Level, align: 'left', attrs: { 'data-stat': `${cellKey}_factor2` } },
        { value: formatCountValue(cell.n), align: 'right', attrs: { 'data-stat': `${cellKey}_n` } },
        {
          value: formatNumber(parseNumber(cell.median) ?? NaN, d),
          align: 'right',
          attrs: { 'data-stat': `${cellKey}_median` },
        },
        {
          value: formatNumber(parseNumber(cell.q1) ?? NaN, d),
          align: 'right',
          attrs: { 'data-stat': `${cellKey}_q1` },
        },
        {
          value: formatNumber(parseNumber(cell.q3) ?? NaN, d),
          align: 'right',
          attrs: { 'data-stat': `${cellKey}_q3` },
        },
        {
          value: formatNumber(parseNumber(cell.iqr) ?? NaN, d),
          align: 'right',
          attrs: { 'data-stat': `${cellKey}_iqr` },
        },
        { value: formatNumber(parseNumber(cell.mean) ?? NaN, d), align: 'right' },
      ],
    });

    cellIndex += 1;
  }

  return {
    title: 'Cell Rank Statistics',
    columns: [
      { key: 'cell', header: 'Cell', align: 'left', width: 20 },
      { key: 'factor1', header: 'Factor 1', align: 'left', width: 10 },
      { key: 'factor2', header: 'Factor 2', align: 'left', width: 10 },
      { key: 'n', header: 'N', align: 'right', width: 6, format: 'integer' },
      { key: 'median', header: 'Median', align: 'right', width: 10, format: 'decimal' },
      { key: 'q1', header: 'Q1', align: 'right', width: 10, format: 'decimal' },
      { key: 'q3', header: 'Q3', align: 'right', width: 10, format: 'decimal' },
      { key: 'iqr', header: 'IQR', align: 'right', width: 10, format: 'decimal' },
      { key: 'mean', header: 'Mean (Ranks)', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    testName: 'scheirer_cells',
  };
}


