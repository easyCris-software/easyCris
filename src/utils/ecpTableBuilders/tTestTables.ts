/**
 * T-Test ECP-Style Table Builder
 *
 * 🔒 LOCKED - FULLY VALIDATED UI COMPONENT 🔒
 *
 * This file is LOCKED and should NOT be modified without user permission.
 *
 * Status: Fully validated (Backend + Frontend + UI + Export)
 * - Independent Samples T-Test (long format: 1 numeric + 1 categorical)
 * - Paired Samples T-Test (long format: 1 numeric + 1 categorical, equal n)
 * - One Sample T-Test
 * - Excel export validated and working
 *
 * Maps validated Python JSON output from parametric.t_test_two_sample to statistical tables.
 * Produces tables matching standard t-test output format.
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

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

/**
 * Build ECP-Style tables for T-test results
 */
export function buildTTestTables(
  result: Record<string, unknown>,
  testType: string,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  console.log('[ECP-TTest] Building t-test tables for:', testType);
  console.log('[ECP-TTest] Result has n1:', result.n1, 'n2:', result.n2);

  const tables: ECPTable[] = [];

  // Table 1: Group Statistics
  tables.push(buildGroupStatisticsTable(result, options));
  console.log('[ECP-TTest] After Group Statistics, tables.length:', tables.length);

  // Table 2: T-Test Results
  tables.push(buildTTestResultsTable(result, options));

  // Table 3: Equality of Variances (only for independent t-test)
  if (testType === 'independent_ttest' && result.f_statistic !== undefined) {
    tables.push(buildEqualityOfVariancesTable(result, options));
  }

  // Table 4: Confidence Limits for Mean Difference
  tables.push(buildConfidenceLimitsTable(result, options));

  console.log('[ECP-TTest] Final tables.length:', tables.length);
  console.log('[ECP-TTest] Table titles:', tables.map(t => t.title));

  return {
    testType,
    testFamily: 'parametric',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize: ((result.n1 as number) || 0) + ((result.n2 as number) || 0),
    },
  };
}

/**
 * Table 1: Group Statistics
 */
function buildGroupStatisticsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;

  const rows: ECPRow[] = [];

  // Header row
  rows.push({
    cells: [
      { value: 'Variable', isHeader: true, align: 'left' },
      { value: 'Group', isHeader: true, align: 'left' },
      { value: 'N', isHeader: true, align: 'right' },
      { value: 'Mean', isHeader: true, align: 'right' },
      { value: 'Std Dev', isHeader: true, align: 'right' },
      { value: 'Std Error', isHeader: true, align: 'right' },
      { value: 'Minimum', isHeader: true, align: 'right' },
      { value: 'Maximum', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Group 1 row
  rows.push({
    cells: [
      { value: options.variableName, align: 'left' },
      { value: (result.group1_name as string) || 'Group 1', align: 'left' },
      { value: result.n1 as number, format: 'integer', align: 'right', attrs: { 'data-stat': 'n1' } },
      { value: formatNumber(result.mean1 as number, d), align: 'right', attrs: { 'data-stat': 'mean1' } },
      { value: formatNumber(result.std1 as number, d), align: 'right', attrs: { 'data-stat': 'std1' } },
      { value: formatNumber(result.sem1 as number, d), align: 'right', attrs: { 'data-stat': 'sem1' } },
      { value: formatNumber(result.min1 as number, d), align: 'right', attrs: { 'data-stat': 'min1' } },
      { value: formatNumber(result.max1 as number, d), align: 'right', attrs: { 'data-stat': 'max1' } },
    ],
  });

  // Group 2 row
  rows.push({
    cells: [
      { value: options.variableName, align: 'left' },
      { value: (result.group2_name as string) || 'Group 2', align: 'left' },
      { value: result.n2 as number, format: 'integer', align: 'right', attrs: { 'data-stat': 'n2' } },
      { value: formatNumber(result.mean2 as number, d), align: 'right', attrs: { 'data-stat': 'mean2' } },
      { value: formatNumber(result.std2 as number, d), align: 'right', attrs: { 'data-stat': 'std2' } },
      { value: formatNumber(result.sem2 as number, d), align: 'right', attrs: { 'data-stat': 'sem2' } },
      { value: formatNumber(result.min2 as number, d), align: 'right', attrs: { 'data-stat': 'min2' } },
      { value: formatNumber(result.max2 as number, d), align: 'right', attrs: { 'data-stat': 'max2' } },
    ],
  });

  // Difference row
  rows.push({
    cells: [
      { value: options.variableName, align: 'left' },
      { value: 'Diff (1-2)', align: 'left' },
      { value: '', align: 'right' },
      { value: formatNumber(result.mean_difference as number, d), align: 'right', attrs: { 'data-stat': 'mean_difference' } },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  });

  return {
    title: 'Statistics',
    procedure: 'T-Test Analysis',
    columns: [
      { key: 'variable', header: 'Variable', align: 'left', width: 12 },
      { key: 'group', header: 'Group', align: 'left', width: 12 },
      { key: 'n', header: 'N', align: 'right', width: 6, format: 'integer' },
      { key: 'mean', header: 'Mean', align: 'right', width: 12, format: 'decimal' },
      { key: 'std', header: 'Std Dev', align: 'right', width: 12, format: 'decimal' },
      { key: 'sem', header: 'Std Error', align: 'right', width: 12, format: 'decimal' },
      { key: 'min', header: 'Minimum', align: 'right', width: 12, format: 'decimal' },
      { key: 'max', header: 'Maximum', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    testName: 'ttest_statistics',
  };
}

/**
 * Table 2: T-Test Results
 */
function buildTTestResultsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Header row
  rows.push({
    cells: [
      { value: 'Variable', isHeader: true, align: 'left' },
      { value: 'Method', isHeader: true, align: 'left' },
      { value: 'Variances', isHeader: true, align: 'left' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 't Value', isHeader: true, align: 'right' },
      { value: `t Crit (α=${options.alpha})`, isHeader: true, align: 'right' },
      { value: 'Pr > |t|', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Pooled (equal variances) row
  const pooledTCrit = result.pooled_upper_t_critical !== undefined
    ? `±${formatNumber(result.pooled_upper_t_critical as number, d)}`
    : result.pooled_t_critical !== undefined
    ? `±${formatNumber(result.pooled_t_critical as number, d)}`
    : '';

  rows.push({
    cells: [
      { value: options.variableName, align: 'left' },
      { value: 'Pooled', align: 'left' },
      { value: 'Equal', align: 'left' },
      { value: formatDF(result.pooled_df as number), align: 'right', attrs: { 'data-stat': 'pooled_df' } },
      { value: formatNumber(result.pooled_t as number, d), align: 'right', attrs: { 'data-stat': 'pooled_t' } },
      {
        value: pooledTCrit,
        align: 'right',
        attrs: {
          'data-stat': 'pooled_upper_t_critical',
          'data-pooled-t-critical': formatNumber(result.pooled_t_critical ?? result.pooled_upper_t_critical as number, d),
          'data-pooled-lower-t-critical': formatNumber(result.pooled_lower_t_critical as number, d)
        }
      },
      { value: formatPValue(result.pooled_p as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.pooled_p as number) < options.alpha, attrs: { 'data-stat': 'pooled_p' } },
    ],
  });

  // Satterthwaite (unequal variances / Welch's) row
  const welchTCrit = result.welch_upper_t_critical !== undefined
    ? `±${formatNumber(result.welch_upper_t_critical as number, d)}`
    : result.welch_t_critical !== undefined
    ? `±${formatNumber(result.welch_t_critical as number, d)}`
    : '';

  rows.push({
    cells: [
      { value: options.variableName, align: 'left' },
      { value: 'Satterthwaite', align: 'left' },
      { value: 'Unequal', align: 'left' },
      {
        value: formatDF(result.welch_df as number),
        align: 'right',
        attrs: { 'data-stat': 'welch_df', 'data-value': String(result.welch_df ?? '') }
      },
      { value: formatNumber(result.welch_t as number, d), align: 'right', attrs: { 'data-stat': 'welch_t' } },
      {
        value: welchTCrit,
        align: 'right',
        attrs: {
          'data-stat': 'welch_upper_t_critical',
          'data-welch-t-critical': formatNumber(result.welch_t_critical ?? result.welch_upper_t_critical as number, d),
          'data-welch-lower-t-critical': formatNumber(result.welch_lower_t_critical as number, d)
        }
      },
      { value: formatPValue(result.welch_p as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.welch_p as number) < options.alpha, attrs: { 'data-stat': 'welch_p' } },
    ],
  });

  return {
    title: 'T-Tests',
    columns: [
      { key: 'variable', header: 'Variable', align: 'left', width: 12 },
      { key: 'method', header: 'Method', align: 'left', width: 14 },
      { key: 'variances', header: 'Variances', align: 'left', width: 10 },
      { key: 'df', header: 'DF', align: 'right', width: 10 },
      { key: 't', header: 't Value', align: 'right', width: 12, format: 'decimal' },
      { key: 't_crit', header: `t Crit (α=${options.alpha})`, align: 'right', width: 12, format: 'decimal' },
      { key: 'p', header: 'Pr > |t|', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    testName: 'ttest_results',
  };
}

/**
 * Table 3: Equality of Variances
 */
function buildEqualityOfVariancesTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Header row
  rows.push({
    cells: [
      { value: 'Variable', isHeader: true, align: 'left' },
      { value: 'Method', isHeader: true, align: 'left' },
      { value: 'Num DF', isHeader: true, align: 'right' },
      { value: 'Den DF', isHeader: true, align: 'right' },
      { value: 'F Value', isHeader: true, align: 'right' },
      { value: 'Pr > F', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Folded F row
  rows.push({
    cells: [
      { value: options.variableName, align: 'left' },
      { value: 'Folded F', align: 'left' },
      { value: formatDF(result.f_df1 as number), align: 'right', attrs: { 'data-stat': 'f_df1' } },
      { value: formatDF(result.f_df2 as number), align: 'right', attrs: { 'data-stat': 'f_df2' } },
      { value: formatNumber(result.f_statistic as number, d), align: 'right', attrs: { 'data-stat': 'f_statistic' } },
      { value: formatPValue(result.f_p_value as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.f_p_value as number) < options.alpha, attrs: { 'data-stat': 'f_p_value' } },
    ],
  });

  const footnotes = [];
  if (result.equal_variances !== undefined) {
    footnotes.push(
      result.equal_variances
        ? 'Variances are equal (use Pooled method)'
        : 'Variances are unequal (use Satterthwaite method)'
    );
  }

  return {
    title: 'Equality of Variances',
    columns: [
      { key: 'variable', header: 'Variable', align: 'left', width: 12 },
      { key: 'method', header: 'Method', align: 'left', width: 10 },
      { key: 'numdf', header: 'Num DF', align: 'right', width: 8 },
      { key: 'dendf', header: 'Den DF', align: 'right', width: 8 },
      { key: 'f', header: 'F Value', align: 'right', width: 12, format: 'decimal' },
      { key: 'p', header: 'Pr > F', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    footnotes,
    testName: 'ttest_variances',
  };
}

/**
 * Table 4: Confidence Limits for Mean Difference
 */
function buildConfidenceLimitsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const ciLevel = Math.round((1 - options.alpha) * 100);

  // Header row
  rows.push({
    cells: [
      { value: 'Variable', isHeader: true, align: 'left' },
      { value: 'Method', isHeader: true, align: 'left' },
      { value: 'Mean Diff', isHeader: true, align: 'right' },
      { value: `${ciLevel}% CL Lower`, isHeader: true, align: 'right' },
      { value: `${ciLevel}% CL Upper`, isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Pooled CI row
  rows.push({
    cells: [
      { value: options.variableName, align: 'left' },
      { value: 'Pooled', align: 'left' },
      { value: formatNumber(result.mean_difference as number, d), align: 'right', attrs: { 'data-stat': 'mean_difference' } },
      { value: formatNumber(result.pooled_ci_lower as number, d), align: 'right', attrs: { 'data-stat': 'pooled_ci_lower' } },
      { value: formatNumber(result.pooled_ci_upper as number, d), align: 'right', attrs: { 'data-stat': 'pooled_ci_upper' } },
    ],
  });

  // Welch CI row
  rows.push({
    cells: [
      { value: options.variableName, align: 'left' },
      { value: 'Satterthwaite', align: 'left' },
      { value: formatNumber(result.mean_difference as number, d), align: 'right', attrs: { 'data-stat': 'mean_difference' } },
      { value: formatNumber(result.welch_ci_lower as number, d), align: 'right', attrs: { 'data-stat': 'welch_ci_lower' } },
      { value: formatNumber(result.welch_ci_upper as number, d), align: 'right', attrs: { 'data-stat': 'welch_ci_upper' } },
    ],
  });

  return {
    title: 'Confidence Limits for Mean Difference',
    columns: [
      { key: 'variable', header: 'Variable', align: 'left', width: 12 },
      { key: 'method', header: 'Method', align: 'left', width: 14 },
      { key: 'diff', header: 'Mean Diff', align: 'right', width: 12, format: 'decimal' },
      { key: 'ci_lower', header: `${ciLevel}% CL Lower`, align: 'right', width: 14, format: 'decimal' },
      { key: 'ci_upper', header: `${ciLevel}% CL Upper`, align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'ttest_ci',
  };
}

// ============================================================================
// PAIRED T-TEST TABLES
// ============================================================================

/**
 * Build ECP-Style tables for Paired T-test results
 */
export function buildPairedTTestTables(
  result: Record<string, unknown>,
  testType: string,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  console.log('[ECP-TTest] Building paired t-test tables');

  const tables: ECPTable[] = [];

  // Table 1: Difference Statistics
  tables.push(buildPairedDifferenceStatisticsTable(result, options));

  // Table 2: Paired T-Test Results
  tables.push(buildPairedTTestResultsTable(result, options));

  // Table 3: Confidence Limits for Mean Difference
  tables.push(buildPairedConfidenceLimitsTable(result, options));

  return {
    testType,
    testFamily: 'parametric',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize: (result.n as number) || 0,
    },
  };
}

/**
 * Table 1: Difference Statistics (Paired)
 */
function buildPairedDifferenceStatisticsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  const nValue = asNumber(result.n)
  const diffValue = asNumber(result.mean_difference)
  const stdDiff = asNumber(result.std_difference)
  const semDiff = asNumber(result.sem_difference)
  const minDiff = asNumber(result.min_difference)
  const maxDiff = asNumber(result.max_difference)

  // Header row
  rows.push({
    cells: [
      { value: 'Variable', isHeader: true, align: 'left' },
      { value: 'N', isHeader: true, align: 'right' },
      { value: 'Mean', isHeader: true, align: 'right' },
      { value: 'Std Dev', isHeader: true, align: 'right' },
      { value: 'Std Error', isHeader: true, align: 'right' },
      { value: 'Minimum', isHeader: true, align: 'right' },
      { value: 'Maximum', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Difference row
  rows.push({
    cells: [
      { value: `${options.variableName} (Diff)`, align: 'left' },
      { value: nValue ?? '', format: nValue !== undefined ? 'integer' : undefined, align: 'right', attrs: { 'data-stat': 'n' } },
      { value: diffValue !== undefined ? formatNumber(diffValue, d) : '', align: 'right', attrs: { 'data-stat': 'mean_difference' } },
      { value: stdDiff !== undefined ? formatNumber(stdDiff, d) : '', align: 'right', attrs: { 'data-stat': 'std_difference' } },
      { value: semDiff !== undefined ? formatNumber(semDiff, d) : '', align: 'right', attrs: { 'data-stat': 'sem_difference' } },
      { value: minDiff !== undefined ? formatNumber(minDiff, d) : '', align: 'right', attrs: { 'data-stat': 'min_difference' } },
      { value: maxDiff !== undefined ? formatNumber(maxDiff, d) : '', align: 'right', attrs: { 'data-stat': 'max_difference' } },
    ],
  });

  return {
    title: 'Statistics for Paired Differences',
    procedure: 'Paired T-Test Analysis',
    columns: [
      { key: 'variable', header: 'Variable', align: 'left', width: 16 },
      { key: 'n', header: 'N', align: 'right', width: 6, format: 'integer' },
      { key: 'mean', header: 'Mean', align: 'right', width: 12, format: 'decimal' },
      { key: 'std', header: 'Std Dev', align: 'right', width: 12, format: 'decimal' },
      { key: 'sem', header: 'Std Error', align: 'right', width: 12, format: 'decimal' },
      { key: 'min', header: 'Minimum', align: 'right', width: 12, format: 'decimal' },
      { key: 'max', header: 'Maximum', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    testName: 'paired_ttest_statistics',
  };
}

/**
 * Table 2: Paired T-Test Results
 */
function buildPairedTTestResultsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Header row
  rows.push({
    cells: [
      { value: 'Variable', isHeader: true, align: 'left' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 't Value', isHeader: true, align: 'right' },
      { value: `t Crit (α=${options.alpha})`, isHeader: true, align: 'right' },
      { value: 'Pr > |t|', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Results row
  const df = asNumber(result.degrees_of_freedom)
  const tValue = asNumber(result.t_statistic)
  const upperTCrit = asNumber(result.upper_t_critical)
  const defaultTCrit = asNumber(result.t_critical)
  const pValue = asNumber(result.p_value)

  const tCrit = upperTCrit !== undefined
    ? `±${formatNumber(upperTCrit, d)}`
    : defaultTCrit !== undefined
    ? `±${formatNumber(defaultTCrit, d)}`
    : ''

  rows.push({
    cells: [
      { value: `${options.variableName} (Diff)`, align: 'left' },
      { value: df !== undefined ? formatDF(df) : '', align: 'right', attrs: { 'data-stat': 'degrees_of_freedom' } },
      { value: tValue !== undefined ? formatNumber(tValue, d) : '', align: 'right', attrs: { 'data-stat': 't_statistic' } },
      {
        value: tCrit,
        align: 'right',
        attrs: {
          'data-stat': 't_critical',
          'data-lower-t-critical': formatNumber(asNumber(result.lower_t_critical) as number, d),
          'data-upper-t-critical': formatNumber(upperTCrit as number, d)
        }
      },
      {
        value: pValue !== undefined ? formatPValue(pValue, options.pValueThreshold, options.minPValue) : '',
        align: 'right',
        isSignificant: pValue !== undefined ? pValue < options.alpha : false,
        attrs: { 'data-stat': 'p_value' }
      },
    ],
  })

  return {
    title: 'Paired T-Test',
    columns: [
      { key: 'variable', header: 'Variable', align: 'left', width: 16 },
      { key: 'df', header: 'DF', align: 'right', width: 10 },
      { key: 't', header: 't Value', align: 'right', width: 12, format: 'decimal' },
      { key: 't_crit', header: `t Crit (α=${options.alpha})`, align: 'right', width: 12, format: 'decimal' },
      { key: 'p', header: 'Pr > |t|', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    testName: 'paired_ttest_results',
  };
}

/**
 * Table 3: Confidence Limits for Mean Difference (Paired)
 */
function buildPairedConfidenceLimitsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const ciLevel = Math.round((1 - options.alpha) * 100);

  const diffValue = asNumber(result.mean_difference)
  const ciLower = asNumber(result.ci_95_lower)
  const ciUpper = asNumber(result.ci_95_upper)

  // Header row
  rows.push({
    cells: [
      { value: 'Variable', isHeader: true, align: 'left' },
      { value: 'Mean Diff', isHeader: true, align: 'right' },
      { value: `${ciLevel}% CL Lower`, isHeader: true, align: 'right' },
      { value: `${ciLevel}% CL Upper`, isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // CI row
  rows.push({
    cells: [
      { value: `${options.variableName} (Diff)`, align: 'left' },
      { value: diffValue !== undefined ? formatNumber(diffValue, d) : '', align: 'right', attrs: { 'data-stat': 'mean_difference' } },
      { value: ciLower !== undefined ? formatNumber(ciLower, d) : '', align: 'right', attrs: { 'data-stat': 'ci_95_lower' } },
      { value: ciUpper !== undefined ? formatNumber(ciUpper, d) : '', align: 'right', attrs: { 'data-stat': 'ci_95_upper' } },
    ],
  });

  return {
    title: `${ciLevel}% Confidence Limits for Mean Difference`,
    columns: [
      { key: 'variable', header: 'Variable', align: 'left', width: 16 },
      { key: 'diff', header: 'Mean Diff', align: 'right', width: 12, format: 'decimal' },
      { key: 'ci_lower', header: `${ciLevel}% CL Lower`, align: 'right', width: 14, format: 'decimal' },
      { key: 'ci_upper', header: `${ciLevel}% CL Upper`, align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'paired_ttest_ci',
  };
}

// ============================================================================
// ONE-SAMPLE T-TEST TABLES
// ============================================================================

/**
 * Build ECP-Style tables for One-Sample T-test results
 */
export function buildOneSampleTTestTables(
  result: Record<string, unknown>,
  testType: string,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  console.log('[ECP-TTest] Building one-sample t-test tables');

  const tables: ECPTable[] = [];

  // Table 1: Sample Statistics
  tables.push(buildOneSampleStatisticsTable(result, options));

  // Table 2: One-Sample T-Test Results
  tables.push(buildOneSampleTTestResultsTable(result, options));

  // Table 3: Confidence Limits for Mean
  tables.push(buildOneSampleConfidenceLimitsTable(result, options));

  return {
    testType,
    testFamily: 'parametric',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize: (result.n as number) || 0,
    },
  };
}

/**
 * Table 1: Sample Statistics (One-Sample)
 */
function buildOneSampleStatisticsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Header row
  rows.push({
    cells: [
      { value: 'Variable', isHeader: true, align: 'left' },
      { value: 'N', isHeader: true, align: 'right' },
      { value: 'Mean', isHeader: true, align: 'right' },
      { value: 'Std Dev', isHeader: true, align: 'right' },
      { value: 'Std Error', isHeader: true, align: 'right' },
      { value: 'Minimum', isHeader: true, align: 'right' },
      { value: 'Maximum', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Sample row
  rows.push({
    cells: [
      { value: options.variableName, align: 'left' },
      { value: result.n as number, format: 'integer', align: 'right', attrs: { 'data-stat': 'n' } },
      { value: formatNumber(result.sample_mean as number, d), align: 'right', attrs: { 'data-stat': 'sample_mean' } },
      { value: formatNumber(result.sample_std as number, d), align: 'right', attrs: { 'data-stat': 'sample_std' } },
      { value: formatNumber(result.sample_sem as number, d), align: 'right', attrs: { 'data-stat': 'sample_sem' } },
      { value: formatNumber(result.sample_min as number, d), align: 'right', attrs: { 'data-stat': 'sample_min' } },
      { value: formatNumber(result.sample_max as number, d), align: 'right', attrs: { 'data-stat': 'sample_max' } },
    ],
  });

  return {
    title: 'Sample Statistics',
    procedure: 'One-Sample T-Test Analysis',
    columns: [
      { key: 'variable', header: 'Variable', align: 'left', width: 12 },
      { key: 'n', header: 'N', align: 'right', width: 6, format: 'integer' },
      { key: 'mean', header: 'Mean', align: 'right', width: 12, format: 'decimal' },
      { key: 'std', header: 'Std Dev', align: 'right', width: 12, format: 'decimal' },
      { key: 'sem', header: 'Std Error', align: 'right', width: 12, format: 'decimal' },
      { key: 'min', header: 'Minimum', align: 'right', width: 12, format: 'decimal' },
      { key: 'max', header: 'Maximum', align: 'right', width: 12, format: 'decimal' },
    ],
    rows,
    testName: 'one_sample_ttest_statistics',
  };
}

/**
 * Table 2: One-Sample T-Test Results
 */
function buildOneSampleTTestResultsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Header row
  rows.push({
    cells: [
      { value: 'Variable', isHeader: true, align: 'left' },
      { value: 'Pop. Mean', isHeader: true, align: 'right' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 't Value', isHeader: true, align: 'right' },
      { value: `t Crit (α=${options.alpha})`, isHeader: true, align: 'right' },
      { value: 'Pr > |t|', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Results row
  const tCrit = result.upper_t_critical !== undefined
    ? `±${formatNumber(result.upper_t_critical as number, d)}`
    : result.t_critical !== undefined
    ? `±${formatNumber(result.t_critical as number, d)}`
    : '';

  rows.push({
    cells: [
      { value: options.variableName, align: 'left' },
      { value: formatNumber(result.population_mean as number, d), align: 'right', attrs: { 'data-stat': 'population_mean' } },
      { value: formatDF(result.degrees_of_freedom as number), align: 'right', attrs: { 'data-stat': 'degrees_of_freedom' } },
      { value: formatNumber(result.t_statistic as number, d), align: 'right', attrs: { 'data-stat': 't_statistic' } },
      {
        value: tCrit,
        align: 'right',
        attrs: {
          'data-stat': 't_critical',
          'data-lower-t-critical': formatNumber(result.lower_t_critical as number, d),
          'data-upper-t-critical': formatNumber(result.upper_t_critical as number, d)
        }
      },
      { value: formatPValue(result.p_value as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.p_value as number) < options.alpha, attrs: { 'data-stat': 'p_value' } },
    ],
  });

  return {
    title: 'One-Sample T-Test',
    columns: [
      { key: 'variable', header: 'Variable', align: 'left', width: 12 },
      { key: 'pop_mean', header: 'Pop. Mean', align: 'right', width: 10, format: 'decimal' },
      { key: 'df', header: 'DF', align: 'right', width: 10 },
      { key: 't', header: 't Value', align: 'right', width: 12, format: 'decimal' },
      { key: 't_crit', header: `t Crit (α=${options.alpha})`, align: 'right', width: 12, format: 'decimal' },
      { key: 'p', header: 'Pr > |t|', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    testName: 'one_sample_ttest_results',
  };
}

/**
 * Table 3: Confidence Limits for Mean (One-Sample)
 */
function buildOneSampleConfidenceLimitsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const ciLevel = Math.round((1 - options.alpha) * 100);

  // Header row
  rows.push({
    cells: [
      { value: 'Variable', isHeader: true, align: 'left' },
      { value: 'Mean', isHeader: true, align: 'right' },
      { value: `${ciLevel}% CL Lower`, isHeader: true, align: 'right' },
      { value: `${ciLevel}% CL Upper`, isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // CI row
  rows.push({
    cells: [
      { value: options.variableName, align: 'left' },
      { value: formatNumber(result.sample_mean as number, d), align: 'right', attrs: { 'data-stat': 'sample_mean' } },
      { value: formatNumber(result.ci_95_lower as number, d), align: 'right', attrs: { 'data-stat': 'ci_95_lower' } },
      { value: formatNumber(result.ci_95_upper as number, d), align: 'right', attrs: { 'data-stat': 'ci_95_upper' } },
    ],
  });

  return {
    title: `${ciLevel}% Confidence Limits for Mean`,
    columns: [
      { key: 'variable', header: 'Variable', align: 'left', width: 12 },
      { key: 'mean', header: 'Mean', align: 'right', width: 12, format: 'decimal' },
      { key: 'ci_lower', header: `${ciLevel}% CL Lower`, align: 'right', width: 14, format: 'decimal' },
      { key: 'ci_upper', header: `${ciLevel}% CL Upper`, align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'one_sample_ttest_ci',
  };
}


