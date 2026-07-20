/**
 * Sort cycle utility for header-click sort UX.
 *
 * Three-state cycle per column: none → asc → desc → none.
 * Each click replaces the entire sortModel (single-key Phase 2).
 * SortKey[] is forward-compatible with multi-key Phase 3.
 */
export type SortKey = { colId: string; dir: 'asc' | 'desc' }

export function nextSortModel(current: SortKey[], colId: string): SortKey[] {
  const existing = current.find((k) => k.colId === colId)
  if (!existing) return [{ colId, dir: 'asc' }]
  if (existing.dir === 'asc') return [{ colId, dir: 'desc' }]
  return []
}
