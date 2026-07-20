import type { CellEdit } from './types'

export function getEditRowBounds(edits: readonly Pick<CellEdit, 'row'>[]): { minRow: number; maxRow: number } | null {
  if (edits.length === 0) return null

  let minRow = Number.POSITIVE_INFINITY
  let maxRow = Number.NEGATIVE_INFINITY
  for (const edit of edits) {
    const row = edit.row
    if (row < minRow) minRow = row
    if (row > maxRow) maxRow = row
  }

  if (!Number.isFinite(minRow) || !Number.isFinite(maxRow)) return null
  return { minRow, maxRow }
}
