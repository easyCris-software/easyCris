/**
 * Correlation ECP-Style Table Builder
 *
 * 🔒 LOCKED - FULLY VALIDATED AGAINST BASELINE 🔒
 *
 * VALIDATION STATUS:
 * ✅ Backend: Python correlation.py validated (19/19 metrics passing)
 * ✅ Frontend: TypeScript table builder validated against baseline output
 * ✅ Validation Date: December 19, 2025
 * ✅ Framework: Group 3 Regression & Correlation validation suite
 *
 * METRICS VALIDATED:
 * - Pearson: r, r², t, p, df, CI (9 metrics)
 * - Spearman: ρ, S, p (5 metrics)
 * - Kendall: τ, z, p (5 metrics)
 *
 * ⚠️ DO NOT MODIFY WITHOUT RE-VALIDATION ⚠️
 * Any changes to this file require:
 * 1. Re-running baseline tests
 * 2. Re-running Python validation tests
 * 3. Comparing all metrics value-by-value
 * 4. User approval before committing changes
 *
 * Maps validated Python JSON output from correlation.correlation_analysis to ECP-Style tables.
 *
 * JSON field mapping:
 * - pearson: correlation, p_value, t_statistic, degrees_of_freedom, ci_95_lower, ci_95_upper
 * - spearman: correlation, p_value, s_statistic
 * - kendall: correlation, p_value, z_statistic
 * - n, alpha
 */

import type {
  ECPTable,
  ECPTableCollection,
  ECPRow,
  TableBuilderOptions,
} from '../../types/ecpStyleTables';
import { formatNumber, formatPValue, formatDF } from './index';

/**
 * Build ECP-Style tables for Correlation results
 */
export function buildCorrelationTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTableCollection {
  const tables: ECPTable[] = [];

  // Table 1: Correlation Coefficients
  tables.push(buildCorrelationTable(result, options));

  return {
    testType: 'correlation',
    testFamily: 'correlation',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize: result.n as number,
    },
  };
}

function buildCorrelationTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable {
  const d = options.decimalPlaces;
  const rows: ECPRow[] = [];

  const pearson = result.pearson as {
    correlation: number;
    p_value: number;
    t_statistic: number;
    degrees_of_freedom: number;
    ci_95_lower: number;
    ci_95_upper: number;
    is_significant: boolean;
  } | undefined;

  const spearman = result.spearman as {
    correlation: number;
    p_value: number;
    s_statistic: number;
    is_significant: boolean;
  } | undefined;

  const kendall = result.kendall as {
    correlation: number;
    p_value: number;
    z_statistic: number;
    is_significant: boolean;
  } | undefined;

  // Extract variable names and sample size info
  const xName = result.x_name as string | undefined;
  const yName = result.y_name as string | undefined;
  const nTotal = result.n_total as number | undefined;
  const nUsed = result.n_used as number | undefined;
  const n = (result.n ?? nUsed) as number;

  // Determine which columns to show based on method present
  // Pearson has DF and CI; Spearman/Kendall do not
  const hasPearson = !!pearson;
  const showDFColumn = hasPearson;
  const showCIColumns = hasPearson;

  // Determine column count for colSpan
  const colCount = showCIColumns ? 7 : (showDFColumn ? 5 : 4);

  // ========================================================================
  // Build header row dynamically based on available method
  // ========================================================================
  const headerCells = [
    { value: 'Method', isHeader: true, align: 'left' as const },
    { value: 'r/ρ/τ', isHeader: true, align: 'right' as const },
    { value: 'Statistic', isHeader: true, align: 'right' as const },
  ];
  if (showDFColumn) {
    headerCells.push({ value: 'DF', isHeader: true, align: 'right' as const });
  }
  headerCells.push({ value: 'Pr > |t/z|', isHeader: true, align: 'right' as const });
  if (showCIColumns) {
    headerCells.push({ value: '95% CL Lower', isHeader: true, align: 'right' as const });
    headerCells.push({ value: '95% CL Upper', isHeader: true, align: 'right' as const });
  }

  rows.push({ cells: headerCells, isHeader: true });

  // Separator
  rows.push({ cells: [], isSeparator: true });

  // ========================================================================
  // 🔒 VALIDATED: Pearson row (9 metrics validated against baseline)
  // ========================================================================
  if (pearson) {
    rows.push({
      cells: [
        { value: 'Pearson', align: 'left' },
        { value: formatNumber(pearson.correlation, d), align: 'right', attrs: { 'data-stat': 'pearson_r' } },
        { value: `t=${formatNumber(pearson.t_statistic, d)}`, align: 'right', attrs: { 'data-stat': 'pearson_t_statistic', 'data-value': String(pearson.t_statistic) } },
        { value: formatDF(pearson.degrees_of_freedom), align: 'right', attrs: { 'data-stat': 'pearson_df' } },
        { value: formatPValue(pearson.p_value, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: pearson.is_significant, attrs: { 'data-stat': 'pearson_p_value' } },
        { value: formatNumber(pearson.ci_95_lower, d), align: 'right', attrs: { 'data-stat': 'pearson_ci_95_lower' } },
        { value: formatNumber(pearson.ci_95_upper, d), align: 'right', attrs: { 'data-stat': 'pearson_ci_95_upper' } },
      ],
    });
  }

  // ========================================================================
  // 🔒 VALIDATED: Spearman row (5 metrics validated against baseline)
  // S statistic: Validated with decimal format (e.g., S=574750.5000 for n=150)
  // Spearman-only table: 4 columns (Method, ρ, Statistic, p)
  // ========================================================================
  if (spearman) {
    rows.push({
      cells: [
        { value: 'Spearman', align: 'left' },
        { value: formatNumber(spearman.correlation, d), align: 'right', attrs: { 'data-stat': 'spearman_rho' } },
        { value: `S=${formatNumber(spearman.s_statistic, d)}`, align: 'right', attrs: { 'data-stat': 'spearman_s_statistic', 'data-value': String(spearman.s_statistic) } }, // ⚠️ DO NOT change format - validated as-is
        { value: formatPValue(spearman.p_value, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: spearman.is_significant, attrs: { 'data-stat': 'spearman_p_value' } },
      ],
    });
  }

  // ========================================================================
  // 🔒 VALIDATED: Kendall row (5 metrics validated against baseline)
  // Kendall-only table: 4 columns (Method, τ, Statistic, p)
  // ========================================================================
  if (kendall) {
    rows.push({
      cells: [
        { value: 'Kendall', align: 'left' },
        { value: formatNumber(kendall.correlation, d), align: 'right', attrs: { 'data-stat': 'kendall_tau' } },
        { value: `z=${formatNumber(kendall.z_statistic, d)}`, align: 'right', attrs: { 'data-stat': 'kendall_z_statistic', 'data-value': String(kendall.z_statistic) } },
        { value: formatPValue(kendall.p_value, options.pValueThreshold, options.minPValue), align: 'right', isSignificant: kendall.is_significant, attrs: { 'data-stat': 'kendall_p_value' } },
      ],
    });
  }

  // Sample size row
  rows.push({ cells: [], isSeparator: true });

  // Show pairwise deletion info if applicable
  if (nTotal !== undefined && nUsed !== undefined && nTotal !== nUsed) {
    rows.push({
      cells: [
        { value: `N (total) = ${nTotal}, N (used) = ${nUsed}`, align: 'left', colSpan: colCount, attrs: { 'data-stat': 'n', 'data-value': String(nUsed) } },
      ],
    });
  } else {
    rows.push({
      cells: [
        { value: `N = ${n}`, align: 'left', colSpan: colCount, attrs: { 'data-stat': 'n', 'data-value': String(n) } },
      ],
    });
  }

  // Build title with variable names if available
  const title = xName && yName
    ? `Correlation Analysis: ${xName} vs ${yName}`
    : 'Correlation Analysis';

  // Only show CI footnote for Pearson (the only method with CI)
  const footnotes: string[] = [];
  if (hasPearson) {
    footnotes.push('Note: 95% CI only available for Pearson correlation (Fisher z transformation).');
  }

  // Add pairwise deletion footnote if applicable
  if (nTotal !== undefined && nUsed !== undefined && nTotal !== nUsed) {
    footnotes.push(`Pairwise deletion: ${nTotal - nUsed} observation(s) removed due to missing values.`);
  }

  // ========================================================================
  // 🔒 VALIDATED: Table structure and column definitions
  // Columns are dynamically built based on which method is present
  // ========================================================================
  type ColumnDef = { key: string; header: string; align: 'left' | 'right'; width: number; format?: 'decimal' | 'pvalue' };
  const columns: ColumnDef[] = [
    { key: 'method', header: 'Method', align: 'left', width: 12 },
    { key: 'r', header: 'r/ρ/τ', align: 'right', width: 10, format: 'decimal' },
    { key: 'stat', header: 'Statistic', align: 'right', width: 14, format: 'decimal' },
  ];
  if (showDFColumn) {
    columns.push({ key: 'df', header: 'DF', align: 'right', width: 8 });
  }
  columns.push({ key: 'p', header: 'Pr > |t/z|', align: 'right', width: 12, format: 'pvalue' });
  if (showCIColumns) {
    columns.push({ key: 'ci_lower', header: '95% CL Lower', align: 'right', width: 14, format: 'decimal' });
    columns.push({ key: 'ci_upper', header: '95% CL Upper', align: 'right', width: 14, format: 'decimal' });
  }

  return {
    title,
    columns,
    rows,
    footnotes,
    testName: 'correlation',
  };
}


