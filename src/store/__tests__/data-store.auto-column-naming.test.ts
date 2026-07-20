import { beforeEach, describe, expect, it } from 'vitest'
import type { Dataset, ColumnMetadata } from '@/store/data-store'
import { deriveNextAutoColumnNumber, useDataStore } from '@/store/data-store'

function makeColumns(names: string[]): ColumnMetadata[] {
  return names.map((name, index) => ({
    id: `col-${index + 1}`,
    name,
    type: 'text',
    width: 88,
  }))
}

function makeDataset(id: string, columnNames: string[], nextAutoColumnNumber?: number): Dataset {
  const columns = makeColumns(columnNames)
  const now = new Date()
  return {
    id,
    name: `Dataset ${id}`,
    rowCount: 10,
    dataRowCount: 10,
    columnCount: columns.length,
    columns,
    nextAutoColumnNumber,
    importedAt: now,
    modifiedAt: now,
  }
}

describe('data-store auto column naming', () => {
  beforeEach(() => {
    useDataStore.getState().clearAllDatasets()
  })

  it('derives next auto number from mixed names', () => {
    const next = deriveNextAutoColumnNumber(
      makeColumns(['group', ' Column 3 ', 'column 11', 'value', 'Column 7'])
    )
    expect(next).toBe(12)
  })

  it('allocates unique names atomically and advances counter', () => {
    const dataset = makeDataset('ds-1', ['Column 100', 'column 101', 'group'], 101)
    useDataStore.getState().addDataset(dataset)

    const first = useDataStore.getState().allocateNextAutoColumnName(dataset.id)
    const second = useDataStore.getState().allocateNextAutoColumnName(dataset.id)

    expect(first).toBe('Column 102')
    expect(second).toBe('Column 103')
    expect(useDataStore.getState().currentDataset?.nextAutoColumnNumber).toBe(104)
  })

  it('preserves monotonic allocator across insert-at-left/right/end', () => {
    const dataset = makeDataset('ds-2', ['Column 99', 'value'], 100)
    useDataStore.getState().addDataset(dataset)

    const nameLeft = useDataStore.getState().allocateNextAutoColumnName(dataset.id)
    expect(nameLeft).toBe('Column 100')
    useDataStore.getState().insertColumnAtDataset(dataset.id, 0, {
      id: 'col-left',
      name: nameLeft!,
      type: 'text',
      width: 88,
    })

    const nameRight = useDataStore.getState().allocateNextAutoColumnName(dataset.id)
    expect(nameRight).toBe('Column 101')
    useDataStore.getState().insertColumnAtDataset(dataset.id, 2, {
      id: 'col-right',
      name: nameRight!,
      type: 'text',
      width: 88,
    })

    const nameEnd = useDataStore.getState().allocateNextAutoColumnName(dataset.id)
    expect(nameEnd).toBe('Column 102')
    expect(useDataStore.getState().currentDataset?.nextAutoColumnNumber).toBe(103)
  })

  it('rolls back reserved name when insert fails before commit', () => {
    const dataset = makeDataset('ds-3', ['Column 100', 'value'], 101)
    useDataStore.getState().addDataset(dataset)

    const reserved = useDataStore.getState().allocateNextAutoColumnName(dataset.id)
    expect(reserved).toBe('Column 101')
    expect(useDataStore.getState().currentDataset?.nextAutoColumnNumber).toBe(102)

    useDataStore.getState().rollbackAutoColumnNameAllocation(dataset.id, reserved!)
    expect(useDataStore.getState().currentDataset?.nextAutoColumnNumber).toBe(101)

    const next = useDataStore.getState().allocateNextAutoColumnName(dataset.id)
    expect(next).toBe('Column 101')
  })

  it('clears selection stats when removing the active dataset', () => {
    const dataset = makeDataset('ds-4', ['Column 1'])
    useDataStore.getState().addDataset(dataset)
    useDataStore.getState().setSelectionStats({
      sum: 10,
      avg: 10,
      count: 1,
      min: 10,
      max: 10,
      expectedCellCount: 1,
      consideredCellCount: 1,
      partial: false,
    })

    useDataStore.getState().removeDataset(dataset.id)

    expect(useDataStore.getState().currentDataset).toBeNull()
    expect(useDataStore.getState().selectionStats).toBeNull()
  })
})
