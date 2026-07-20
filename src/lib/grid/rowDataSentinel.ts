const ROW_DATA_SENTINEL = Symbol('easycris.rowDataSentinel')

export type RowDataRecord = Record<string, unknown>

export function createRowDataSentinel(): RowDataRecord {
  const row: RowDataRecord = {}

  // Keep the marker non-enumerable: plain object spreads still promote a row
  // into materialized data, while passive row clones must use
  // cloneRowDataPreservingSentinel to keep unloaded placeholders loadable.
  Object.defineProperty(row, ROW_DATA_SENTINEL, {
    value: true,
    enumerable: false,
  })

  return row
}

export function isRowDataSentinel(row: unknown): boolean {
  return Boolean(row && typeof row === 'object' && (row as Record<symbol, unknown>)[ROW_DATA_SENTINEL] === true)
}

export function cloneRowDataPreservingSentinel(row: RowDataRecord | undefined): RowDataRecord {
  const clone = isRowDataSentinel(row) ? createRowDataSentinel() : {}
  if (row) {
    Object.assign(clone, row)
  }
  return clone
}
