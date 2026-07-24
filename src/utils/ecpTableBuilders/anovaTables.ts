/**
 * ANOVA ECP-Style Table Builder
 *
 * 🔒 LOCKED - FULLY VALIDATED UI COMPONENT 🔒
 *
 * This file is LOCKED and should NOT be modified without user permission.
 *
 * Status: Fully validated against baseline
 * - One-Way ANOVA with Tukey HSD post-hoc tests
 * - Excel export validated and working
 *
 * Maps validated Python JSON output from parametric.anova_one_way to statistical tables.
 * Produces tables matching standard ANOVA output format.
 *
 * DO NOT MODIFY without re-validation against baseline.
 */

import type {
  ECPTable,
  ECPTableCollection,
  ECPRow,
  TableBuilderOptions,
} from '../../types/ecpStyleTables';
import { formatNumber, formatPValue, formatDF, formatEffectSize, formatStatistic } from './index';

/**
 * Build ECP-Style tables for ANOVA results
 */
export function buildANOVATables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];
  const adjustmentMethod = (result.adjustment_method as string) || 'Tukey HSD';
  const posthocQ = typeof result.posthoc_q === 'number' ? result.posthoc_q : null;
  const showQ = posthocQ !== null && /fdr/i.test(adjustmentMethod);
  const adjustmentLabel = showQ ? `${adjustmentMethod} (q = ${formatNumber(posthocQ, 2)})` : adjustmentMethod;

  // Table 1: ANOVA Summary (Sum of Squares)
  tables.push(buildANOVASummaryTable(result, options));

  // Table 2: Effect Sizes (point estimates only - no CI available)
  tables.push(buildEffectSizesTable(result, options));

  // Table 3: Group Means (Least Squares Means)
  if (result.group_summaries) {
    tables.push(buildGroupMeansTable(result, options));
  }

  // Table 4: Post-Hoc Comparisons (Tukey HSD)
  if (result.pairwise_comparisons) {
    tables.push(buildANOVAPairwiseTable(result, options));
  }

  // Table 5: Assumption Checks (Levene's test)
  if (result.levene_statistic !== undefined) {
    tables.push(buildAssumptionChecksTable(result, options));
  }

  const normalityByGroupTable = buildNormalityByGroupTable(result, options);
  if (normalityByGroupTable) {
    tables.push(normalityByGroupTable);
  }

  return {
    testType: 'one_way_anova',
    testFamily: 'parametric',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize: result.total_n as number,
      posthocAdjustment: result.pairwise_comparisons ? adjustmentLabel : undefined,
    },
  };
}

/**
 * Table 1: ANOVA Summary
 */
function buildANOVASummaryTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Calculate total df
  const dfTotal = ((result.df_between as number) || 0) + ((result.df_within as number) || 0);

  // Header row
  rows.push({
    cells: [
      { value: 'Source', isHeader: true, align: 'left' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 'Sum of Squares', isHeader: true, align: 'right' },
      { value: 'Mean Square', isHeader: true, align: 'right' },
      { value: 'F Value', isHeader: true, align: 'right' },
      { value: 'Pr > F', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Model row (between groups)
  rows.push({
    cells: [
      { value: 'Model', align: 'left' },
      { value: formatDF(result.df_between as number), align: 'right', attrs: { 'data-stat': 'df_between' } },
      { value: formatNumber(result.ss_between as number, d), align: 'right', attrs: { 'data-stat': 'ss_between' } },
      { value: formatNumber(result.ms_between as number, d), align: 'right', attrs: { 'data-stat': 'ms_between' } },
      { value: formatNumber(result.f_statistic as number, d), align: 'right', attrs: { 'data-stat': 'f_statistic' } },
      { value: formatPValue(result.p_value as number, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: (result.p_value as number) < options.alpha, attrs: { 'data-stat': 'p_value' } },
    ],
  });

  // Error row (within groups)
  rows.push({
    cells: [
      { value: 'Error', align: 'left' },
      { value: formatDF(result.df_within as number), align: 'right', attrs: { 'data-stat': 'df_within' } },
      { value: formatNumber(result.ss_within as number, d), align: 'right', attrs: { 'data-stat': 'ss_within' } },
      { value: formatNumber(result.ms_within as number, d), align: 'right', attrs: { 'data-stat': 'ms_within' } },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  });

  // Total row
  rows.push({
    cells: [
      { value: 'Corrected Total', align: 'left' },
      { value: formatDF(dfTotal), align: 'right', attrs: { 'data-stat': 'df_total' } },
      { value: formatNumber(result.ss_total as number, d), align: 'right', attrs: { 'data-stat': 'ss_total' } },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Model information row (num_groups and total_n)
  rows.push({
    cells: [
      { value: 'Model Information', align: 'left' },
      { value: String(result.num_groups || 0), align: 'right', attrs: { 'data-stat': 'num_groups' } },
      { value: String(result.total_n || 0), align: 'right', attrs: { 'data-stat': 'total_n' } },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  });

  return {
    title: 'Analysis of Variance',
    procedure: 'ANOVA Analysis',
    dependentVar: options.variableName,
    columns: [
      { key: 'source', header: 'Source', align: 'left', width: 16 },
      { key: 'df', header: 'DF', align: 'right', width: 6 },
      { key: 'ss', header: 'Sum of Squares', align: 'right', width: 16, format: 'decimal' },
      { key: 'ms', header: 'Mean Square', align: 'right', width: 14, format: 'decimal' },
      { key: 'f', header: 'F Value', align: 'right', width: 12, format: 'decimal' },
      { key: 'p', header: 'Pr > F', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    testName: 'anova_summary',
  };
}

/**
 * Table 2: Effect Sizes (point estimates only)
 */
function buildEffectSizesTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  // Header row
  rows.push({
    cells: [
      { value: 'Measure', isHeader: true, align: 'left' },
      { value: 'Estimate', isHeader: true, align: 'right' },
      { value: 'Interpretation', isHeader: true, align: 'left' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Eta-squared row
  if (result.eta_squared !== undefined) {
    rows.push({
      cells: [
        { value: 'Eta-squared (η²)', align: 'left' },
        { value: formatEffectSize(result.eta_squared as number, d), align: 'right', attrs: { 'data-stat': 'eta_squared' } },
        { value: (result.effect_size_interpretation as string) || interpretEffectSize(result.eta_squared as number, 'eta'), align: 'left' },
      ],
    });
  }

  // Omega-squared row
  if (result.omega_squared !== undefined) {
    rows.push({
      cells: [
        { value: 'Omega-squared (ω²)', align: 'left' },
        { value: formatEffectSize(result.omega_squared as number, d), align: 'right', attrs: { 'data-stat': 'omega_squared' } },
        { value: interpretEffectSize(result.omega_squared as number, 'omega'), align: 'left' },
      ],
    });
  }

  return {
    title: 'Effect Sizes',
    columns: [
      { key: 'measure', header: 'Measure', align: 'left', width: 20 },
      { key: 'estimate', header: 'Estimate', align: 'right', width: 12, format: 'decimal' },
      { key: 'interpretation', header: 'Interpretation', align: 'left', width: 20 },
    ],
    rows,
    footnotes: [
      'Note: Confidence intervals for effect sizes are not available.',
      'Effect size interpretation: Small (<0.01), Medium (0.01-0.06), Large (>0.14)',
    ],
    testName: 'anova_effect_sizes',
  };
}

/**
 * Table 3: Group Means (Least Squares Means)
 */
function buildGroupMeansTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const groupSummaries = result.group_summaries as {
    label: string;
    n: number;
    mean: number;
    std: number;
    sem: number;
    ci_lower?: number;
    ci_upper?: number;
    ci_95_lower?: number;
    ci_95_upper?: number;
  }[];

  const ciLevel = Math.round((1 - options.alpha) * 100);

  // Header row
  rows.push({
    cells: [
      { value: 'Group', isHeader: true, align: 'left' },
      { value: 'N', isHeader: true, align: 'right' },
      { value: 'Mean', isHeader: true, align: 'right' },
      { value: 'Std Dev', isHeader: true, align: 'right' },
      { value: 'Std Error', isHeader: true, align: 'right' },
      { value: `${ciLevel}% CL Lower`, isHeader: true, align: 'right' },
      { value: `${ciLevel}% CL Upper`, isHeader: true, align: 'right' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Group rows
  for (let i = 0; i < groupSummaries.length; i++) {
    const group = groupSummaries[i];
    if (!group) continue;
    // Use fallback pattern (matches two-way ANOVA table builder)
    // Backend may return ci_lower OR ci_95_lower depending on version
    const ciLower = group.ci_lower ?? group.ci_95_lower;
    const ciUpper = group.ci_upper ?? group.ci_95_upper;
    const groupNum = i + 1; // 1-indexed for data-stat names

    rows.push({
      cells: [
        { value: group.label, align: 'left', attrs: { 'data-stat': `group${groupNum}_label` } },
        { value: group.n, format: 'integer', align: 'right', attrs: { 'data-stat': `group${groupNum}_n` } },
        { value: formatNumber(group.mean, d), align: 'right', attrs: { 'data-stat': `group${groupNum}_mean` } },
        { value: formatNumber(group.std, d), align: 'right', attrs: { 'data-stat': `group${groupNum}_std` } },
        { value: formatNumber(group.sem, d), align: 'right', attrs: { 'data-stat': `group${groupNum}_sem` } },
        { value: ciLower !== undefined ? formatNumber(ciLower, d) : '.', align: 'right', attrs: { 'data-stat': `group${groupNum}_ci_95_lower` } },
        { value: ciUpper !== undefined ? formatNumber(ciUpper, d) : '.', align: 'right', attrs: { 'data-stat': `group${groupNum}_ci_95_upper` } },
      ],
    });
  }

  return {
    title: 'Least Squares Means',
    columns: [
      { key: 'group', header: 'Group', align: 'left', width: 16 },
      { key: 'n', header: 'N', align: 'right', width: 6, format: 'integer' },
      { key: 'mean', header: 'Mean', align: 'right', width: 12, format: 'decimal' },
      { key: 'std', header: 'Std Dev', align: 'right', width: 12, format: 'decimal' },
      { key: 'sem', header: 'Std Error', align: 'right', width: 12, format: 'decimal' },
      { key: 'ci_lower', header: `${ciLevel}% CL Lower`, align: 'right', width: 14, format: 'decimal' },
      { key: 'ci_upper', header: `${ciLevel}% CL Upper`, align: 'right', width: 14, format: 'decimal' },
    ],
    rows,
    testName: 'anova_lsmeans',
  };
}

/**
 * Table 4: Post-Hoc Pairwise Comparisons (Tukey HSD)
 */
function buildANOVAPairwiseTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];
  const pairwise = result.pairwise_comparisons as {
    group1?: string;
    group2?: string;
    contrast?: string;
    estimate?: number;
    mean_difference?: number;
    se?: number;
    df?: number;
    t_stat?: number;
    ci_lower?: number;
    ci_upper?: number;
    p_value?: number;
    p_adjusted?: number;
    significant?: boolean;
  }[];

  // Header row
  rows.push({
    cells: [
      { value: 'Contrast', isHeader: true, align: 'left' },
      { value: 'Estimate', isHeader: true, align: 'right' },
      { value: 'Std Error', isHeader: true, align: 'right' },
      { value: '95% CI [lower, upper]', isHeader: true, align: 'right' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 't Ratio', isHeader: true, align: 'right' },
      { value: 'p', isHeader: true, align: 'right' },
      { value: 'Adj. p-value', isHeader: true, align: 'right' },
      { value: 'Sig', isHeader: true, align: 'center' },
    ],
    isHeader: true,
  });

  rows.push({ cells: [], isSeparator: true });

  let pairIndex = 1;
  for (const pair of pairwise) {
    const label = pair.contrast || `${pair.group1 ?? ''} vs ${pair.group2 ?? ''}`.trim();
    const estimate = pair.mean_difference ?? pair.estimate;
    const ciLower = pair.ci_lower;
    const ciUpper = pair.ci_upper;
    const ciDisplay =
      ciLower !== undefined && ciUpper !== undefined
        ? `[${formatNumber(ciLower, d)}, ${formatNumber(ciUpper, d)}]`
        : '.';
    const pValue = pair.p_value as number | undefined;
    const pAdj = pair.p_adjusted as number | undefined;
    const hasSigFlag = typeof pair.significant === 'boolean';
    let sigLabel = formatSignificanceStars(pAdj ?? pValue);
    if (hasSigFlag) {
      if (!pair.significant) {
        sigLabel = '-';
      } else if (!sigLabel) {
        sigLabel = '*';
      }
    }

    rows.push({
      cells: [
        { value: label, align: 'left', attrs: { 'data-stat': `posthoc${pairIndex}_label` } },
        { value: formatNumber(estimate as number, d), align: 'right', attrs: { 'data-stat': `posthoc${pairIndex}_mean_diff` } },
        { value: pair.se !== undefined ? formatNumber(pair.se, d) : '.', align: 'right', attrs: pair.se !== undefined ? { 'data-stat': `posthoc${pairIndex}_se` } : undefined },
        {
          value: ciDisplay,
          align: 'right',
          attrs: ciLower !== undefined && ciUpper !== undefined
            ? {
                'data-ci-lower-stat': `posthoc${pairIndex}_ci_lower`,
                'data-ci-lower-value': String(ciLower),
                'data-ci-upper-stat': `posthoc${pairIndex}_ci_upper`,
                'data-ci-upper-value': String(ciUpper),
              }
            : undefined,
        },
        { value: pair.df !== undefined ? formatDF(pair.df) : '.', align: 'right', attrs: pair.df !== undefined ? { 'data-stat': `posthoc${pairIndex}_df` } : undefined },
        { value: pair.t_stat !== undefined ? formatNumber(pair.t_stat, d) : '.', align: 'right', attrs: pair.t_stat !== undefined ? { 'data-stat': `posthoc${pairIndex}_t` } : undefined },
        { value: formatPValue(pValue, options.pValueThreshold, options.minPValue), align: 'right', attrs: { 'data-stat': `posthoc${pairIndex}_p` } },
        { value: pAdj !== undefined ? formatPValue(pAdj, options.pValueThreshold, options.minPValue) : '.', align: 'right', attrs: { 'data-stat': `posthoc${pairIndex}_p_adj` } },
        { value: sigLabel || '-', align: 'center', attrs: { 'data-stat': `posthoc${pairIndex}_sig` } },
      ],
    });
    pairIndex += 1;
  }

  // Use dynamic adjustment method from Python, fallback to Tukey HSD
  const adjustmentMethod = (result.adjustment_method as string) || 'Tukey HSD';
  const posthocQ = typeof result.posthoc_q === 'number' ? result.posthoc_q : null;
  const showQ = posthocQ !== null && /fdr/i.test(adjustmentMethod);
  const adjustmentLabel = showQ ? `${adjustmentMethod} (q = ${formatNumber(posthocQ, 2)})` : adjustmentMethod;
  const controlLevel = result.control_level as string | undefined;
  const titleSuffix = controlLevel ? ` vs ${controlLevel}` : '';
  const adjustedHeader = showQ ? 'Adj. p-value (q)' : 'Adj. p-value';

  return {
    title: `Post-Hoc Comparisons (${adjustmentLabel}${titleSuffix})`,
    columns: [
      { key: 'contrast', header: 'Contrast', align: 'left', width: 24 },
      { key: 'estimate', header: 'Estimate', align: 'right', width: 12, format: 'decimal' },
      { key: 'se', header: 'Std Error', align: 'right', width: 12, format: 'decimal' },
      { key: 'ci', header: '95% CI [lower, upper]', align: 'right', width: 22, format: 'text' },
      { key: 'df', header: 'DF', align: 'right', width: 8, format: 'integer' },
      { key: 't_stat', header: 't Ratio', align: 'right', width: 12, format: 'decimal' },
      { key: 'p_value', header: 'p', align: 'right', width: 12, format: 'pvalue' },
      { key: 'p_adj', header: adjustedHeader, align: 'right', width: 12, format: 'pvalue' },
      { key: 'sig', header: 'Sig', align: 'center', width: 6 },
    ],
    rows,
    testName: 'anova_posthoc',
  };
}

function formatSignificanceStars(pValue: number | undefined): string {
  if (pValue === null || pValue === undefined) {
    return '';
  }
  if (!Number.isFinite(pValue)) {
    return '';
  }
  if (pValue <= 0.001) return '***';
  if (pValue <= 0.01) return '**';
  if (pValue <= 0.05) return '*';
  return '';
}

/**
 * Table 4: Assumption Checks
 */
function buildAssumptionChecksTable(
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
      { value: 'Pr > F', isHeader: true, align: 'right' },
      { value: 'Result', isHeader: true, align: 'left' },
    ],
    isHeader: true,
  });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // Levene's test row
  const leveneP = result.levene_p_value as number;
  const leveneResult = result.equal_variances !== undefined
    ? (result.equal_variances ? 'Equal variances' : 'Unequal variances')
    : (leveneP >= options.alpha ? 'Equal variances' : 'Unequal variances');

  rows.push({
    cells: [
      { value: "Levene's Test", align: 'left' },
      { value: formatStatistic(result.levene_statistic as number, d), align: 'right', attrs: { 'data-stat': 'levene_statistic' } },
      { value: formatPValue(leveneP, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: leveneP < options.alpha, attrs: { 'data-stat': 'levene_p_value' } },
      { value: leveneResult, align: 'left' },
    ],
  });

  return {
    title: 'Homogeneity of Variance Test',
    columns: [
      { key: 'test', header: 'Test', align: 'left', width: 20 },
      { key: 'statistic', header: 'Statistic', align: 'right', width: 12, format: 'decimal' },
      { key: 'p', header: 'Pr > F', align: 'right', width: 12, format: 'pvalue' },
      { key: 'result', header: 'Result', align: 'left', width: 20 },
    ],
    rows,
    testName: 'anova_assumptions',
  };
}

interface NormalityTestRow {
  test_name?: string;
  statistic?: number;
  p_value?: number;
  is_normal?: boolean | null;
}

interface GroupNormalityResult {
  label?: string;
  n?: number;
  warning?: string;
  tests?: NormalityTestRow[];
}

const NORMALITY_TEST_NAME_MAP: Record<string, string> = {
  shapiro_wilk: 'Shapiro-Wilk',
  kolmogorov_smirnov: 'Kolmogorov-Smirnov',
  anderson_darling: 'Anderson-Darling',
  cramer_von_mises: 'Cramer-von Mises',
  jarque_bera: 'Jarque-Bera',
};

const NORMALITY_STAT_KEY_MAP: Record<string, string> = {
  shapiro_wilk: 'shapiro_w',
  kolmogorov_smirnov: 'ks_d',
  anderson_darling: 'ad_a',
  cramer_von_mises: 'cvm_w',
  jarque_bera: 'jb_stat',
};

const NORMALITY_P_KEY_MAP: Record<string, string> = {
  shapiro_wilk: 'shapiro_p',
  kolmogorov_smirnov: 'ks_p',
  anderson_darling: 'ad_p',
  cramer_von_mises: 'cvm_p',
  jarque_bera: 'jb_p',
};

function normalityDataStatPrefix(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `normality_${slug || 'group'}`;
}

function buildNormalityByGroupTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable | null {
  const normality = (result.assumptions as Record<string, unknown> | undefined)?.normality as Record<string, unknown> | undefined;
  const groupsByLabel = normality?.groups_by_label as Record<string, GroupNormalityResult> | undefined;
  if (!groupsByLabel) {
    return null;
  }

  const d = options.decimalPlaces;
  const unstableGroupLabels: string[] = [];
  const rows: ECPRow[] = [
    {
      cells: [
        { value: 'Group', isHeader: true, align: 'left' },
        { value: 'Test', isHeader: true, align: 'left' },
        { value: 'Statistic', isHeader: true, align: 'right' },
        { value: 'N', isHeader: true, align: 'right' },
        { value: 'Pr > Statistic', isHeader: true, align: 'right' },
        { value: 'Result', isHeader: true, align: 'left' },
      ],
      isHeader: true,
    },
    { cells: [], isSeparator: true },
  ];

  for (const [fallbackLabel, group] of Object.entries(groupsByLabel)) {
    const label = group.label || fallbackLabel;
    const tests = Array.isArray(group.tests) ? group.tests : [];
    const prefix = normalityDataStatPrefix(label);
    if (group.warning || (typeof group.n === 'number' && group.n < 5)) {
      unstableGroupLabels.push(label);
    }

    for (const test of tests) {
      const testName = test.test_name || '';
      const statKey = NORMALITY_STAT_KEY_MAP[testName];
      const pKey = NORMALITY_P_KEY_MAP[testName];
      const pValue = test.p_value;
      const isNormal = test.is_normal ?? (typeof pValue === 'number' ? pValue >= options.alpha : null);

      rows.push({
        cells: [
          { value: label, align: 'left' },
          { value: NORMALITY_TEST_NAME_MAP[testName] ?? testName, align: 'left' },
          {
            value: typeof test.statistic === 'number' ? formatNumber(test.statistic, d) : '',
            align: 'right',
            attrs: statKey && typeof test.statistic === 'number'
              ? { 'data-stat': `${prefix}_${statKey}`, 'data-value': String(test.statistic) }
              : undefined,
          },
          {
            value: typeof group.n === 'number' ? group.n : '.',
            format: typeof group.n === 'number' ? 'integer' : undefined,
            align: 'right',
          },
          {
            value: typeof pValue === 'number' ? formatPValue(pValue, options.pValueThreshold, options.minPValue) : '',
            align: 'right',
            isSignificant: typeof pValue === 'number' ? pValue < options.alpha : false,
            attrs: pKey && typeof pValue === 'number'
              ? { 'data-stat': `${prefix}_${pKey}`, 'data-value': String(pValue) }
              : undefined,
          },
          {
            value: isNormal === null ? 'Not tested' : (isNormal ? 'Normal' : 'Non-normal'),
            align: 'left',
          },
        ],
      });
    }
  }

  const hasDataRows = rows.some(row => !row.isHeader && !row.isSeparator && row.cells.length > 0);
  if (!hasDataRows) {
    return null;
  }

  const footnotes = [
    `Note: p > ${options.alpha} indicates the normality assumption is met for that group.`,
  ];
  if (unstableGroupLabels.length > 0) {
    footnotes.push(`Caution: Normality tests are unstable for group sizes below 5 (${unstableGroupLabels.join(', ')}).`);
  }

  return {
    title: 'Normality Tests by Group',
    columns: [
      { key: 'group', header: 'Group', align: 'left', width: 18 },
      { key: 'test', header: 'Test', align: 'left', width: 24 },
      { key: 'statistic', header: 'Statistic', align: 'right', width: 12, format: 'decimal' },
      { key: 'n', header: 'N', align: 'right', width: 8, format: 'integer' },
      { key: 'p', header: 'Pr > Statistic', align: 'right', width: 14, format: 'pvalue' },
      { key: 'result', header: 'Result', align: 'left', width: 14 },
    ],
    rows,
    footnotes,
    testName: 'anova_normality_by_group',
  };
}

/**
 * Interpret effect size based on Cohen's guidelines
 */
function interpretEffectSize(value: number, _type: 'eta' | 'omega'): string {
  // Cohen's guidelines for eta-squared / omega-squared
  // Small: 0.01, Medium: 0.06, Large: 0.14
  if (value < 0.01) return 'Negligible';
  if (value < 0.06) return 'Small';
  if (value < 0.14) return 'Medium';
  return 'Large';
}


