/**
 * Canonical missing-value sentinels shared across column types.
 * Matches ColumnDataExtractor.MISSING_VALUE_INDICATORS.
 *
 * BASE_MISSING_SENTINELS — used by text semantics (looser: '-' and '.' are
 * valid free-form text and are NOT treated as missing).
 *
 * MISSING_SENTINELS — used by numeric, categorical, datetime (stricter:
 * '-' and '.' are structural placeholders meaning "no data").
 */
export const BASE_MISSING_SENTINELS = new Set([
  'na', 'n/a', 'missing', 'null', 'nan', '#n/a', '#na',
])

export const MISSING_SENTINELS = new Set([
  ...BASE_MISSING_SENTINELS,
  '.', '-',
])
