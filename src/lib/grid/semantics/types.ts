/**
 * Shared value contract for one column type.
 *
 * parse     — raw string input  → typed value.
 *             Returns original string if unparseable (never throws).
 *             Returns null for empty / whitespace-only input.
 * format    — typed value       → display string (never throws).
 * sortKey   — typed value       → number | string used by comparator.
 *             Missing values MUST map to a sentinel that sorts LAST:
 *               numbers  → Infinity
 *               strings  → '\uFFFF'
 * isMissing — true when value should be treated as absent.
 *             Covers: null, undefined, '', NaN, sentinel strings (na, nan, etc.)
 * isValid   — true when value is an acceptable member of this type.
 *             false = warn or coerce. Not the same as isMissing.
 * empty     — canonical missing value for this type (always null in Phase 1).
 */
export interface GridValueSemantics {
  parse(raw: string): unknown
  format(value: unknown): string
  sortKey(value: unknown): number | string
  isMissing(value: unknown): boolean
  isValid(value: unknown): boolean
  readonly empty: unknown
}
