import { getSemanticsForType } from './semantics'
import type { ColumnMetadata } from '@/store/data-store'

// Shared Intl.Collator instance — created once, not per-comparison.
// numeric: true     → "10" > "2" (Excel-compatible natural sort for strings)
// sensitivity:'base' → case-insensitive ('A' == 'a' for ordering purposes)
const excelCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Creates a comparator for sorting column values — Excel-compatible.
 *
 * Sort contract:
 * - Missing values always sort last regardless of direction.
 * - Numeric columns compare numerically.
 * - Text/categorical compare via Intl.Collator (numeric=true, sensitivity=base):
 *   "10" > "2", case-insensitive.
 * - Datetime columns use UTC timestamp sort key.
 * - Semantics instance is created once per call, safe to hoist outside Array.sort().
 */
export function makeExcelComparator(
  type: ColumnMetadata['type'] | undefined | null
): (a: unknown, b: unknown) => number {
  const sem = getSemanticsForType(type)
  return (a, b) => {
    if (sem.isMissing(a) && sem.isMissing(b)) return 0
    if (sem.isMissing(a)) return 1
    if (sem.isMissing(b)) return -1
    const ka = sem.sortKey(a)
    const kb = sem.sortKey(b)
    if (typeof ka === 'number' && typeof kb === 'number') return ka - kb
    return excelCollator.compare(String(ka), String(kb))
  }
}

/**
 * @deprecated Alias for {@link makeExcelComparator}. Kept for call-site compatibility.
 *
 * **Breaking change (Phase 2):** The legacy implementation used plain `localeCompare` with no
 * numeric collation, so `"10" < "2"` lexicographically. This alias now delegates to
 * `makeExcelComparator`, which uses `Intl.Collator({ numeric: true })`, giving `"10" > "2"`.
 * If any caller depended on the old lexicographic order it must be updated.
 */
export const makeComparator = makeExcelComparator
