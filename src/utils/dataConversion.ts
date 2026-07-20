/**
 * Data Conversion Utilities
 *
 * Convert between column-based storage and row-based objects for Arquero transforms.
 */

import type { ColumnMetadata } from '@/store/data-store'

const createColumnId = () => `col-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export interface ColumnData {
  id: string
  values: Array<string | number | boolean | null>
  dataType: 'number' | 'text' | 'mixed'
}

/**
 * Convert columnar data to row objects (for Arquero input)
 * Uses column IDs as object keys
 */
export function convertColumnsToRowObjects(
  columns: ColumnData[],
  metadata: ColumnMetadata[]
): Record<string, any>[] {
  if (columns.length === 0) return []

  const metadataById = new Map(metadata.map((m) => [m.id, m]))
  const rowCount = Math.max(...columns.map((c) => c.values.length), 0)
  const rows: Record<string, any>[] = []

  for (let i = 0; i < rowCount; i++) {
    const row: Record<string, any> = {}
    for (const col of columns) {
      // Use column ID as key (matches ColumnMetadata.id)
      if (!metadataById.has(col.id)) continue
      row[col.id] = col.values[i] ?? null
    }
    rows.push(row)
  }

  return rows
}

/**
 * Convert row objects back to columnar data (after Arquero transform)
 * Generates new column IDs for new columns, preserves existing IDs
 */
export function convertRowObjectsToColumns(
  rows: Record<string, any>[],
  originalMetadata: ColumnMetadata[]
): { columns: ColumnData[]; metadata: ColumnMetadata[]; rows: Record<string, any>[] } {
  if (rows.length === 0) {
    return { columns: [], metadata: [], rows: [] }
  }

  const existingMetaById = new Map(originalMetadata.map((m) => [m.id, m]))
  const availableKeys = new Set<string>()
  const discoveredKeys: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row ?? {})) {
      if (availableKeys.has(key)) continue
      availableKeys.add(key)
      discoveredKeys.push(key)
    }
  }

  const orderedKeys = [
    ...originalMetadata.map((m) => m.id).filter((id) => availableKeys.has(id)),
    ...discoveredKeys.filter((key) => !existingMetaById.has(key)),
  ]
  const newIdByKey = new Map<string, string>()
  const columns: ColumnData[] = []
  const metadata: ColumnMetadata[] = []
  const normalizedRows = rows.map((row) => {
    const next: Record<string, any> = {}
    for (const [key, value] of Object.entries(row)) {
      const mappedId = existingMetaById.has(key)
        ? key
        : (newIdByKey.get(key) ?? (() => {
            const created = createColumnId()
            newIdByKey.set(key, created)
            return created
          })())
      next[mappedId] = value ?? null
    }
    return next
  })

  for (const columnKey of orderedKeys) {
    const isExisting = existingMetaById.has(columnKey)
    const columnId = isExisting
      ? columnKey
      : (newIdByKey.get(columnKey) ?? createColumnId())
    const values = normalizedRows.map((r) => r[columnId] ?? null)

    // Check if this column existed before (preserve ID)
    const existingMeta = existingMetaById.get(columnKey)

    if (existingMeta) {
      // Existing column - preserve ID
      columns.push({
        id: existingMeta.id,
        values,
        dataType: inferDataType(values),
      })

      metadata.push({
        ...existingMeta,
      })
    } else {
      // New column created by transform (e.g., pivot)
      columns.push({
        id: columnId,
        values,
        dataType: inferDataType(values),
      })

      metadata.push({
        id: columnId,
        name: columnKey, // Pivot label becomes column name
        type: inferMetadataType(values),
        width: 88,
      })
    }
  }

  return { columns, metadata, rows: normalizedRows }
}

/**
 * Infer data type from values
 */
function inferDataType(values: any[]): 'number' | 'text' | 'mixed' {
  const nonNullValues = values.filter((v) => v !== null && v !== undefined && v !== '')

  if (nonNullValues.length === 0) return 'text'

  const allNumbers = nonNullValues.every((v) => typeof v === 'number' || !isNaN(Number(v)))

  return allNumbers ? 'number' : 'text'
}

function inferMetadataType(values: any[]): ColumnMetadata['type'] {
  const nonNullValues = values.filter((v) => v !== null && v !== undefined && v !== '')
  if (nonNullValues.length === 0) return 'text'
  const allNumbers = nonNullValues.every((v) => typeof v === 'number' || !isNaN(Number(v)))
  return allNumbers ? 'numeric' : 'text'
}

/**
 * Extend columns to minimum count (padding)
 * Follows same pattern as import logic
 */
export function extendColumnsToMinimum(
  columns: ColumnData[],
  minColumns: number = 100
): ColumnData[] {
  const extended = [...columns]

  while (extended.length < minColumns) {
    extended.push({
      id: createColumnId(),
      values: [],
      dataType: 'text',
    })
  }

  return extended
}

/**
 * Pad rows to minimum count
 * Follows same pattern as import logic
 */
export function padRowsToMinimum(
  columns: ColumnData[],
  minRows: number = 100,
  rowBuffer: number = 50
): ColumnData[] {
  const currentRowCount = Math.max(...columns.map((c) => c.values.length), 0)
  const targetRowCount = Math.max(currentRowCount + rowBuffer, minRows)

  return columns.map((col) => {
    const paddedValues = [...col.values]
    while (paddedValues.length < targetRowCount) {
      paddedValues.push(null)
    }
    return {
      ...col,
      values: paddedValues,
    }
  })
}
