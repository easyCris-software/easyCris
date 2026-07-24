type DatasetRowShape = {
  rowCount?: number | null
  dataRowCount?: number | null
} | null | undefined

export function getUsableRowCount(dataset: DatasetRowShape): number {
  return dataset?.dataRowCount ?? dataset?.rowCount ?? 0
}

export function hasUsableRows(dataset: DatasetRowShape): boolean {
  return getUsableRowCount(dataset) > 0
}

export function computeLoweredDataRowCount(
  currentDataRowCount: number,
  rows: ReadonlyMap<number, Record<string, unknown>>,
  columnIds: readonly string[]
): number {
  const current = Math.max(0, Math.floor(currentDataRowCount))
  for (let rowIndex = current - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = rows.get(rowIndex)
    if (!row) continue
    const hasValue = columnIds.some((columnId) => {
      const value = row[columnId]
      return value !== null && value !== undefined && String(value) !== ''
    })
    if (hasValue) {
      return rowIndex + 1
    }
  }
  return 0
}
