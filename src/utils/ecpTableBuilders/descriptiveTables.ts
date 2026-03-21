/**
 * Descriptive Statistics ECP-Style Table Builder
 *
 * Maps validated Python JSON output to ECP-Style tables:
 * - Descriptive Statistics from descriptive.descriptive_statistics
 * - Normality Tests from distributions.normality_test
 */

import type {
  ECPTable,
  ECPTableCollection,
  ECPRow,
  TableBuilderOptions,
} from '../../types/ecpStyleTables';
import { formatNumber, formatPValue } from './index';

/**
 * Build ECP-Style tables for Descriptive Statistics results
 */
export function buildDescriptiveTables(
  result: Record<string, unknown>,
  testType: string,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  if (testType === 'descriptive_stats') {
    tables.push(buildDescriptiveStatsTable(result, options));
  } else if (testType === 'normality_all') {
    tables.push(buildNormalityAllTestsTable(result, options));
  } else if (testType === 'normality_shapiro' || testType === 'normality_ks' || testType === 'normality_ad' || testType === 'normality_cvm' || testType === 'normality_jb') {
    tables.push(buildNormalityTestTable(result, testType, options));
  } else if (testType === 'outlier_detection') {
    tables.push(buildOutlierDetectionTable(result, options));
  }

  return {
    testType,
    testFamily: 'descriptive',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize: (result.n ?? result.count ?? result.n_valid) as number,
    },
  };
}

/**
 * Descriptive Statistics Table
 *
 * E2E Validated Metrics (16): n, mean, std, sem, variance, median, min, max, range,
 *                             q1, q3, iqr, skewness, kurtosis, ci_lower, ci_upper
 */
function buildDescriptiveStatsTable(
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

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Sample Size
  const nVal = (result.n ?? result.count) as number;
  rows.push({
    cells: [
      { value: 'N', align: 'left' },
      {
        value: nVal,
        format: 'integer',
        align: 'right',
        attrs: { 'data-stat': 'n', 'data-value': String(nVal) },
      },
    ],
  });

  // Location measures
  const meanVal = result.mean as number;
  rows.push({
    cells: [
      { value: 'Mean', align: 'left' },
      {
        value: formatNumber(meanVal, d),
        align: 'right',
        attrs: { 'data-stat': 'mean', 'data-value': String(meanVal) },
      },
    ],
  });

  const medianVal = result.median as number;
  rows.push({
    cells: [
      { value: 'Median', align: 'left' },
      {
        value: formatNumber(medianVal, d),
        align: 'right',
        attrs: { 'data-stat': 'median', 'data-value': String(medianVal) },
      },
    ],
  });

  // Separator for variability
  rows.push({ cells: [], isSeparator: true });

  // Variability measures
  const stdVal = result.std as number;
  rows.push({
    cells: [
      { value: 'Std Deviation', align: 'left' },
      {
        value: formatNumber(stdVal, d),
        align: 'right',
        attrs: { 'data-stat': 'std', 'data-value': String(stdVal) },
      },
    ],
  });

  const semVal = result.sem as number;
  rows.push({
    cells: [
      { value: 'Std Error Mean', align: 'left' },
      {
        value: formatNumber(semVal, d),
        align: 'right',
        attrs: { 'data-stat': 'sem', 'data-value': String(semVal) },
      },
    ],
  });

  const varianceVal = result.variance as number;
  rows.push({
    cells: [
      { value: 'Variance', align: 'left' },
      {
        value: formatNumber(varianceVal, d),
        align: 'right',
        attrs: { 'data-stat': 'variance', 'data-value': String(varianceVal) },
      },
    ],
  });

  // Separator for range
  rows.push({ cells: [], isSeparator: true });

  // Range measures
  const minVal = result.min as number;
  rows.push({
    cells: [
      { value: 'Minimum', align: 'left' },
      {
        value: formatNumber(minVal, d),
        align: 'right',
        attrs: { 'data-stat': 'min', 'data-value': String(minVal) },
      },
    ],
  });

  const maxVal = result.max as number;
  rows.push({
    cells: [
      { value: 'Maximum', align: 'left' },
      {
        value: formatNumber(maxVal, d),
        align: 'right',
        attrs: { 'data-stat': 'max', 'data-value': String(maxVal) },
      },
    ],
  });

  const rangeVal = result.range as number;
  rows.push({
    cells: [
      { value: 'Range', align: 'left' },
      {
        value: formatNumber(rangeVal, d),
        align: 'right',
        attrs: { 'data-stat': 'range', 'data-value': String(rangeVal) },
      },
    ],
  });

  // Separator for percentiles
  rows.push({ cells: [], isSeparator: true });

  // Percentiles
  const q1Val = (result.q1 ?? result.q25) as number;
  rows.push({
    cells: [
      { value: '25th Percentile (Q1)', align: 'left' },
      {
        value: formatNumber(q1Val, d),
        align: 'right',
        attrs: { 'data-stat': 'q1', 'data-value': String(q1Val) },
      },
    ],
  });

  const q3Val = (result.q3 ?? result.q75) as number;
  rows.push({
    cells: [
      { value: '75th Percentile (Q3)', align: 'left' },
      {
        value: formatNumber(q3Val, d),
        align: 'right',
        attrs: { 'data-stat': 'q3', 'data-value': String(q3Val) },
      },
    ],
  });

  const iqrVal = result.iqr as number;
  rows.push({
    cells: [
      { value: 'IQR', align: 'left' },
      {
        value: formatNumber(iqrVal, d),
        align: 'right',
        attrs: { 'data-stat': 'iqr', 'data-value': String(iqrVal) },
      },
    ],
  });

  // Separator for shape
  rows.push({ cells: [], isSeparator: true });

  // Shape measures
  const skewnessVal = result.skewness as number;
  rows.push({
    cells: [
      { value: 'Skewness', align: 'left' },
      {
        value: formatNumber(skewnessVal, d),
        align: 'right',
        attrs: { 'data-stat': 'skewness', 'data-value': String(skewnessVal) },
      },
    ],
  });

  const kurtosisVal = result.kurtosis as number;
  rows.push({
    cells: [
      { value: 'Kurtosis', align: 'left' },
      {
        value: formatNumber(kurtosisVal, d),
        align: 'right',
        attrs: { 'data-stat': 'kurtosis', 'data-value': String(kurtosisVal) },
      },
    ],
  });

  // Coefficient of variation (not validated in E2E)
  if (result.cv !== undefined) {
    rows.push({
      cells: [
        { value: 'CV (%)', align: 'left' },
        { value: formatNumber(result.cv as number, 2), align: 'right' },
      ],
    });
  }

  // 95% Confidence Interval for mean (if available from Python backend)
  const ciLower = (result.ci_lower ?? result.ci_95_lower) as number | undefined;
  const ciUpper = (result.ci_upper ?? result.ci_95_upper) as number | undefined;
  if (ciLower !== undefined && ciUpper !== undefined) {
    rows.push({ cells: [], isSeparator: true });

    rows.push({
      cells: [
        { value: '95% CI Lower', align: 'left' },
        {
          value: formatNumber(ciLower, d),
          align: 'right',
          attrs: { 'data-stat': 'ci_lower', 'data-value': String(ciLower) },
        },
      ],
    });

    rows.push({
      cells: [
        { value: '95% CI Upper', align: 'left' },
        {
          value: formatNumber(ciUpper, d),
          align: 'right',
          attrs: { 'data-stat': 'ci_upper', 'data-value': String(ciUpper) },
        },
      ],
    });
  }

  return {
    title: 'Descriptive Statistics',
    columns: [
      { key: 'statistic', header: 'Statistic', align: 'left', width: 22 },
      { key: 'value', header: 'Value', align: 'right', width: 16, format: 'decimal' },
    ],
    rows,
    testName: 'descriptive_stats',
  };
}

/**
 * Normality Test Table (Shapiro-Wilk or Kolmogorov-Smirnov)
 *
 * Shapiro-Wilk JSON fields: shapiro_statistic, p_value, is_normal, is_significant, decision, n
 * K-S JSON fields: ks_statistic, p_value, is_normal, is_significant, method (Lilliefors), decision, n
 */
function buildNormalityTestTable(
  result: Record<string, unknown>,
  testType: string,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Map test type to test name and statistic field
  let testName: string;
  let statValue: number;

  if (testType === 'normality_shapiro') {
    testName = 'Shapiro-Wilk';
    statValue = (result.shapiro_statistic ?? result.statistic ?? result.w) as number;
  } else if (testType === 'normality_ks') {
    testName = 'Kolmogorov-Smirnov';
    statValue = (result.ks_statistic ?? result.statistic ?? result.d) as number;
  } else if (testType === 'normality_ad') {
    testName = 'Anderson-Darling';
    statValue = (result.ad_statistic ?? result.statistic ?? result.a2) as number;
  } else if (testType === 'normality_cvm') {
    testName = 'Cramer-von Mises';
    statValue = (result.cvm_statistic ?? result.statistic ?? result.w2) as number;
  } else if (testType === 'normality_jb') {
    testName = 'Jarque-Bera';
    statValue = (result.jb_statistic ?? result.statistic ?? result.jb) as number;
  } else {
    testName = 'Unknown';
    statValue = (result.statistic) as number;
  }

  // Header row
  rows.push({
    cells: [
      { value: 'Test', isHeader: true, align: 'left' },
      { value: 'Statistic', isHeader: true, align: 'right' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 'Pr > Statistic', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Test result row
  const pValue = result.p_value as number;
  const isNormal = (result.is_normal ?? pValue >= options.alpha) as boolean;
  const isSignificant = (result.is_significant ?? pValue < options.alpha) as boolean;
  const n = result.n as number | undefined;

  // For K-S test, may include Lilliefors correction
  const method = result.method as string | undefined;
  const displayName = method === 'Lilliefors'
    ? `${testName} (Lilliefors)`
    : testName;

  rows.push({
    cells: [
      { value: displayName, align: 'left' },
      { value: formatNumber(statValue, d), align: 'right' },
      { value: n !== undefined ? n : '.', format: n !== undefined ? 'integer' : undefined, align: 'right' },
      { value: formatPValue(pValue, options.pValueThreshold, options.minPValue), align: 'right', isSignificant },
    ],
  });

  // Decision row
  rows.push({ cells: [], isSeparator: true });

  const decision = result.decision as string | undefined;
  rows.push({
    cells: [
      { value: 'Decision:', align: 'left', isBold: true },
      { value: decision || (isNormal ? 'Distribution appears normal' : 'Distribution appears non-normal'), align: 'left', colSpan: 3 },
    ],
  });

  return {
    title: 'Tests for Normality',
    columns: [
      { key: 'test', header: 'Test', align: 'left', width: 24 },
      { key: 'statistic', header: 'Statistic', align: 'right', width: 12, format: 'decimal' },
      { key: 'df', header: 'DF', align: 'right', width: 8, format: 'integer' },
      { key: 'p', header: 'Pr > Statistic', align: 'right', width: 14, format: 'pvalue' },
    ],
    rows,
    footnotes: [
      `Note: p > ${options.alpha} indicates normality assumption is met.`,
      testType === 'normality_shapiro'
        ? 'Shapiro-Wilk test is recommended for sample sizes < 2000.'
        : testType === 'normality_ks'
        ? 'Lilliefors correction applied for testing against unknown parameters.'
        : testType === 'normality_ad'
        ? 'Anderson-Darling test is more sensitive to deviations in the tails.'
        : testType === 'normality_cvm'
        ? 'Cramer-von Mises test measures distribution discrepancy.'
        : testType === 'normality_jb'
        ? 'Jarque-Bera test uses skewness and kurtosis to detect non-normality.'
        : 'Normality test result interpretation based on p-value.',
    ],
    testName: testType,
  };
}

/**
 * Normality All Tests Table
 *
 * Handles results from normality_all which runs all 5 normality tests.
 * JSON fields: tests (array of test results), overall_decision, n
 *
 * E2E Validated Metrics (11):
 * - n
 * - shapiro_w, shapiro_p (Shapiro-Wilk)
 * - ks_d, ks_p (Kolmogorov-Smirnov)
 * - ad_a, ad_p (Anderson-Darling)
 * - cvm_w, cvm_p (Cramer-von Mises)
 * - jb_stat, jb_p (Jarque-Bera)
 */
function buildNormalityAllTestsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Header row
  rows.push({
    cells: [
      { value: 'Test', isHeader: true, align: 'left' },
      { value: 'Statistic', isHeader: true, align: 'right' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 'Pr > Statistic', isHeader: true, align: 'right' },
      { value: 'Decision', isHeader: true, align: 'left' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Get all test results
  const tests = (result.tests as Array<Record<string, unknown>>) ?? [];
  const n = result.n as number | undefined;

  // Map of test names for display
  const testNameMap: Record<string, string> = {
    'shapiro_wilk': 'Shapiro-Wilk',
    'kolmogorov_smirnov': 'Kolmogorov-Smirnov',
    'anderson_darling': 'Anderson-Darling',
    'cramer_von_mises': 'Cramer-von Mises',
    'jarque_bera': 'Jarque-Bera',
  };

  // E2E data-stat mappings for all 5 normality tests
  const statKeyMap: Record<string, string> = {
    'shapiro_wilk': 'shapiro_w',
    'kolmogorov_smirnov': 'ks_d',
    'anderson_darling': 'ad_a',
    'cramer_von_mises': 'cvm_w',
    'jarque_bera': 'jb_stat',
  };
  const pKeyMap: Record<string, string> = {
    'shapiro_wilk': 'shapiro_p',
    'kolmogorov_smirnov': 'ks_p',
    'anderson_darling': 'ad_p',
    'cramer_von_mises': 'cvm_p',
    'jarque_bera': 'jb_p',
  };

  // Track if we've added n data-stat (only add once)
  let nAdded = false;

  // Add a row for each test
  for (const test of tests) {
    const testName = test.test_name as string;
    const displayName = testNameMap[testName] ?? testName;
    const statistic = test.statistic as number;
    const pValue = test.p_value as number;
    const isSignificant = pValue < options.alpha;
    const decision = isSignificant ? 'Non-normal' : 'Normal';

    // Get data-stat keys for E2E validation (only for validated tests)
    const statKey = statKeyMap[testName];
    const pKey = pKeyMap[testName];

    rows.push({
      cells: [
        { value: displayName, align: 'left' },
        {
          value: formatNumber(statistic, d),
          align: 'right',
          attrs: statKey ? { 'data-stat': statKey, 'data-value': String(statistic) } : undefined,
        },
        {
          value: n !== undefined ? n : '.',
          format: n !== undefined ? 'integer' : undefined,
          align: 'right',
          // Only add n data-stat on first row to avoid duplicates
          attrs: !nAdded && n !== undefined ? { 'data-stat': 'n', 'data-value': String(n) } : undefined,
        },
        {
          value: formatPValue(pValue, options.pValueThreshold, options.minPValue),
          align: 'right',
          isSignificant,
          attrs: pKey ? { 'data-stat': pKey, 'data-value': String(pValue) } : undefined,
        },
        { value: decision, align: 'left' },
      ],
    });

    nAdded = true;
  }

  // Overall decision
  rows.push({ cells: [], isSeparator: true });

  const overallDecision = result.overall_decision as string | undefined;
  const passCount = tests.filter(t => (t.p_value as number) >= options.alpha).length;
  const totalTests = tests.length;
  const defaultDecision = passCount === totalTests
    ? 'All tests suggest normal distribution'
    : `${passCount} of ${totalTests} tests suggest normality`;

  rows.push({
    cells: [
      { value: 'Overall Decision:', align: 'left', isBold: true },
      { value: overallDecision || defaultDecision, align: 'left', colSpan: 4 },
    ],
  });

  return {
    title: 'Combined Normality Tests',
    columns: [
      { key: 'test', header: 'Test', align: 'left', width: 24 },
      { key: 'statistic', header: 'Statistic', align: 'right', width: 12, format: 'decimal' },
      { key: 'df', header: 'DF', align: 'right', width: 8, format: 'integer' },
      { key: 'p', header: 'Pr > Statistic', align: 'right', width: 14, format: 'pvalue' },
      { key: 'decision', header: 'Decision', align: 'left', width: 14 },
    ],
    rows,
    footnotes: [
      `Note: p > ${options.alpha} indicates normality assumption is met.`,
      'Running all tests provides comprehensive normality assessment.',
      'Consensus among multiple tests increases confidence in normality conclusion.',
    ],
    testName: 'normality_all',
  };
}

/**
 * Outlier Detection Table
 *
 * JSON fields from descriptive.outlier_detection:
 * - outliers.iqr: indices, values, count, lower_bound, upper_bound
 * - outliers.zscore: indices, values, count, threshold
 * - outliers.modified_zscore: indices, values, count, threshold
 * - grubbs_test: grubbs_g, grubbs_p, critical_value, is_outlier, suspect_value, suspect_index
 * - summary_stats: q1, q3, iqr, mad, median
 * - n
 *
 * E2E Validated Metrics (12): n, q1, q3, iqr, lower_fence, upper_fence,
 *                             iqr_outlier_count, z_outlier_count, mad, mad_outlier_count,
 *                             grubbs_g, grubbs_p
 */
function buildOutlierDetectionTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  const outliers = result.outliers as {
    iqr?: { indices: number[]; values: number[]; count: number; lower_bound: number; upper_bound: number };
    zscore?: { indices: number[]; values: number[]; count: number; threshold: number };
    modified_zscore?: { indices: number[]; values: number[]; count: number; threshold: number };
  } | undefined;

  // Python returns grubbs_g/grubbs_p at top level (not in grubbs_test object)
  // Build grubbsTest object from flat structure if available
  const grubbsTest = result.grubbs_test as {
    grubbs_g: number;
    grubbs_p: number;
    critical_value?: number | null;
    is_outlier: boolean;
    suspect_value?: number | null;
    suspect_index?: number | null;
  } | undefined ?? (
    result.grubbs_g !== undefined && result.grubbs_p !== undefined
      ? {
          grubbs_g: result.grubbs_g as number,
          grubbs_p: result.grubbs_p as number,
          critical_value: (result.grubbs_critical as number | undefined) ?? null,
          is_outlier: (result.grubbs_p as number) < 0.05,
          suspect_value: (result.grubbs_suspect_value as number | undefined) ?? null,
          suspect_index: (result.grubbs_suspect_index as number | undefined) ?? null,
        }
      : undefined
  );

  // Python returns q1, q3, iqr, mad at top level (not in summary_stats)
  const summaryStats = {
    q1: result.q1 as number,
    q3: result.q3 as number,
    iqr: result.iqr as number,
    mad: result.mad as number,
  };

  // Table 1: Detection Methods Summary
  const columnName = options.variableName || 'Variable';

  rows.push({
    cells: [
      { value: `Outlier Detection Methods - ${columnName}`, isHeader: true, colSpan: 5, align: 'left', isBold: true },
    ],
    isSubheader: true,
  });

  rows.push({
    cells: [
      { value: 'Method', isHeader: true, align: 'left' },
      { value: 'Threshold/Bounds', isHeader: true, align: 'left' },
      { value: 'Count', isHeader: true, align: 'right' },
      { value: 'Row Number', isHeader: true, align: 'left' },
      { value: 'Outlier Values', isHeader: true, align: 'left' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  // IQR Method - with data-stat for lower_fence, upper_fence, iqr_outlier_count
  if (outliers?.iqr) {
    const iqr = outliers.iqr;
    const indicesDisplay = iqr.count === 0 ? 'None' : (iqr.indices.length > 5
      ? `Row ${iqr.indices.slice(0, 5).join(', Row ')}...`
      : `Row ${iqr.indices.join(', Row ')}`);
    const valuesDisplay = iqr.count === 0 ? 'None' : (iqr.values.length > 5
      ? `${iqr.values.slice(0, 5).map(v => formatNumber(v, d)).join(', ')}...`
      : iqr.values.map(v => formatNumber(v, d)).join(', '));

    rows.push({
      cells: [
        { value: 'IQR (1.5xIQR)', align: 'left' },
        {
          value: `[${formatNumber(iqr.lower_bound, d)}, ${formatNumber(iqr.upper_bound, d)}]`,
          align: 'left',
          attrs: { 'data-stat': 'lower_fence', 'data-value': String(iqr.lower_bound) },
        },
        {
          value: iqr.count,
          format: 'integer',
          align: 'right',
          attrs: { 'data-stat': 'iqr_outlier_count', 'data-value': String(iqr.count) },
        },
        { value: indicesDisplay, align: 'left' },
        {
          value: valuesDisplay,
          align: 'left',
          attrs: { 'data-stat': 'upper_fence', 'data-value': String(iqr.upper_bound) },
        },
      ],
    });
  }
  // Z-Score Method - with data-stat for z_outlier_count
  if (outliers?.zscore) {
    const zscore = outliers.zscore;
    const indicesDisplay = zscore.count === 0 ? 'None' : (zscore.indices.length > 5
      ? `Row ${zscore.indices.slice(0, 5).join(', Row ')}...`
      : `Row ${zscore.indices.join(', Row ')}`);
    const valuesDisplay = zscore.count === 0 ? 'None' : (zscore.values.length > 5
      ? `${zscore.values.slice(0, 5).map(v => formatNumber(v, d)).join(', ')}...`
      : zscore.values.map(v => formatNumber(v, d)).join(', '));

    rows.push({
      cells: [
        { value: 'Z-Score', align: 'left' },
        { value: `|z| > ${formatNumber(zscore.threshold, 1)}`, align: 'left' },
        {
          value: zscore.count,
          format: 'integer',
          align: 'right',
          attrs: { 'data-stat': 'z_outlier_count', 'data-value': String(zscore.count) },
        },
        { value: indicesDisplay, align: 'left' },
        { value: valuesDisplay, align: 'left' },
      ],
    });
  }

  // Modified Z-Score (MAD) Method - with data-stat for mad_outlier_count
  if (outliers?.modified_zscore) {
    const modZ = outliers.modified_zscore;
    const indicesDisplay = modZ.count === 0 ? 'None' : (modZ.indices.length > 5
      ? `Row ${modZ.indices.slice(0, 5).join(', Row ')}...`
      : `Row ${modZ.indices.join(', Row ')}`);
    const valuesDisplay = modZ.count === 0 ? 'None' : (modZ.values.length > 5
      ? `${modZ.values.slice(0, 5).map(v => formatNumber(v, d)).join(', ')}...`
      : modZ.values.map(v => formatNumber(v, d)).join(', '));

    rows.push({
      cells: [
        { value: 'Modified Z (MAD)', align: 'left' },
        { value: `|Mz| > ${formatNumber(modZ.threshold, 1)}`, align: 'left' },
        {
          value: modZ.count,
          format: 'integer',
          align: 'right',
          attrs: { 'data-stat': 'mad_outlier_count', 'data-value': String(modZ.count) },
        },
        { value: indicesDisplay, align: 'left' },
        { value: valuesDisplay, align: 'left' },
      ],
    });
  }

  // Grubbs' Test Section - with data-stat for grubbs_g, grubbs_p
  if (grubbsTest) {
    rows.push({ cells: [], isSeparator: true });

    rows.push({
      cells: [
        { value: 'Grubbs\' Test for Outliers', isHeader: true, colSpan: 5, align: 'left', isBold: true },
      ],
      isSubheader: true,
    });

    rows.push({
      cells: [
        { value: 'Method', isHeader: true, align: 'left' },
        { value: 'Statistic (G)', isHeader: true, align: 'right' },
        { value: 'Critical Value', isHeader: true, align: 'right' },
        { value: 'Pr > |G|', isHeader: true, align: 'right' },
        { value: 'Outlier Value', isHeader: true, align: 'right' },
      ],
      isHeader: true,
    });

    rows.push({ cells: [], isSeparator: true });

    const hasCriticalValue = grubbsTest.critical_value !== undefined && grubbsTest.critical_value !== null;
    const criticalValueDisplay = hasCriticalValue
      ? formatNumber(grubbsTest.critical_value, d)
      : 'N/A';
    const criticalValueAttrs = hasCriticalValue
      ? { 'data-stat': 'grubbs_critical', 'data-value': String(grubbsTest.critical_value) }
      : undefined;
    const hasSuspect = grubbsTest.suspect_value !== undefined && grubbsTest.suspect_value !== null
      && grubbsTest.suspect_index !== undefined && grubbsTest.suspect_index !== null;
    const suspectDisplay = hasSuspect
      ? `${formatNumber(grubbsTest.suspect_value as number, d)} [Row ${grubbsTest.suspect_index}]`
      : 'N/A';

    rows.push({
      cells: [
        { value: 'Grubbs\' Test', align: 'left' },
        {
          value: formatNumber(grubbsTest.grubbs_g, d),
          align: 'right',
          attrs: { 'data-stat': 'grubbs_g', 'data-value': String(grubbsTest.grubbs_g) },
        },
        { value: criticalValueDisplay, align: 'right', attrs: criticalValueAttrs },
        {
          value: formatPValue(grubbsTest.grubbs_p, options.pValueThreshold, options.minPValue),
          align: 'right',
          isSignificant: grubbsTest.is_outlier,
          attrs: { 'data-stat': 'grubbs_p', 'data-value': String(grubbsTest.grubbs_p) },
        },
        { value: suspectDisplay, align: 'right' },
      ],
    });

    rows.push({
      cells: [
        { value: grubbsTest.is_outlier ? 'Result: Outlier detected' : 'Result: No outlier detected', align: 'left', colSpan: 5, isBold: grubbsTest.is_outlier },
      ],
    });
  }

  // Distribution Summary Section - with data-stat for q1, q3, iqr, mad
  // Python returns q1, q3, iqr, mad (median is NOT returned)
  if (
    summaryStats &&
    (summaryStats.q1 !== undefined ||
      summaryStats.q3 !== undefined ||
      summaryStats.iqr !== undefined ||
      summaryStats.mad !== undefined)
  ) {
    rows.push({ cells: [], isSeparator: true });

    rows.push({
      cells: [
        { value: 'Distribution Summary', isHeader: true, colSpan: 5, align: 'left', isBold: true },
      ],
      isSubheader: true,
    });

    rows.push({
      cells: [
        { value: 'Statistic', isHeader: true, align: 'left' },
        { value: 'Value', isHeader: true, align: 'right', colSpan: 4 },
      ],
      isHeader: true,
    });

    rows.push({ cells: [], isSeparator: true });

    rows.push({
      cells: [
        { value: 'Q1 (25th Percentile)', align: 'left' },
        {
          value: formatNumber(summaryStats.q1, d),
          align: 'right',
          colSpan: 4,
          attrs: { 'data-stat': 'q1', 'data-value': String(summaryStats.q1) },
        },
      ],
    });

    rows.push({
      cells: [
        { value: 'Q3 (75th Percentile)', align: 'left' },
        {
          value: formatNumber(summaryStats.q3, d),
          align: 'right',
          colSpan: 4,
          attrs: { 'data-stat': 'q3', 'data-value': String(summaryStats.q3) },
        },
      ],
    });

    rows.push({
      cells: [
        { value: 'IQR', align: 'left' },
        {
          value: formatNumber(summaryStats.iqr, d),
          align: 'right',
          colSpan: 4,
          attrs: { 'data-stat': 'iqr', 'data-value': String(summaryStats.iqr) },
        },
      ],
    });

    rows.push({
      cells: [
        { value: 'MAD (Median Abs Dev)', align: 'left' },
        {
          value: formatNumber(summaryStats.mad, d),
          align: 'right',
          colSpan: 4,
          attrs: { 'data-stat': 'mad', 'data-value': String(summaryStats.mad) },
        },
      ],
    });
  }

  // Sample size - with data-stat for n
  const nValue = (result.n ?? result.n_valid ?? result.count) as number | undefined;
  rows.push({ cells: [], isSeparator: true });
  rows.push({
    cells: [
      {
        value: `N = ${nValue ?? 'unknown'}`,
        align: 'left',
        colSpan: 5,
        attrs: nValue !== undefined ? { 'data-stat': 'n', 'data-value': String(nValue) } : undefined,
      },
    ],
  });

  return {
    title: 'Outlier Detection Analysis',
    columns: [
      { key: 'method', header: 'Method', align: 'left', width: 18 },
      { key: 'threshold', header: 'Threshold/Bounds', align: 'left', width: 24 },
      { key: 'count', header: 'Count', align: 'right', width: 8, format: 'integer' },
      { key: 'row_number', header: 'Row Number', align: 'left', width: 20 },
      { key: 'outlier_values', header: 'Outlier Values', align: 'left', width: 24 },
    ],
    rows,
    footnotes: [
      'IQR: Values outside [Q1-1.5*IQR, Q3+1.5*IQR] are outliers.',
      'Z-Score: Values with |z| > threshold are outliers.',
      'Modified Z (MAD): Uses Median Absolute Deviation, more robust to outliers.',
    ],
    testName: 'outlier_detection',
  };
}


