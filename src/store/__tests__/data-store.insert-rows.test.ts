import { beforeEach, describe, expect, it } from 'vitest'
import type { Dataset } from '@/store/data-store'
import { useDataStore } from '@/store/data-store'

function makeDataset(id: string, rowCount: number, dataRowCount?: number): Dataset {
  const now = new Date()
  return {
    id,
    name: `Dataset ${id}`,
    rowCount,
    dataRowCount,
    columnCount: 1,
    columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
    importedAt: now,
    modifiedAt: now,
  }
}

describe('data-store insertRowsAtDataset', () => {
  beforeEach(() => {
    useDataStore.getState().clearAllDatasets()
  })

  it('increments rowCount and dataRowCount in one state update', () => {
    const dataset = makeDataset('ds-1', 100, 50)
    useDataStore.getState().addDataset(dataset)

    useDataStore.getState().insertRowsAtDataset(dataset.id, 10, 5)

    const updated = useDataStore.getState().datasets.find(d => d.id === dataset.id)
    expect(updated?.rowCount).toBe(105)
    expect(updated?.dataRowCount).toBe(55)
    expect(useDataStore.getState().currentDataset?.rowCount).toBe(105)
    expect(useDataStore.getState().currentDataset?.dataRowCount).toBe(55)
  })

  it('clamps index beyond data rows and still grows data row count by count', () => {
    const dataset = makeDataset('ds-2', 100, 50)
    useDataStore.getState().addDataset(dataset)

    useDataStore.getState().insertRowsAtDataset(dataset.id, 999, 3)

    const updated = useDataStore.getState().datasets.find(d => d.id === dataset.id)
    expect(updated?.rowCount).toBe(103)
    expect(updated?.dataRowCount).toBe(53)
  })

  it('treats non-positive count as no-op', () => {
    const dataset = makeDataset('ds-3', 10, 4)
    useDataStore.getState().addDataset(dataset)

    useDataStore.getState().insertRowsAtDataset(dataset.id, 2, 0)
    useDataStore.getState().insertRowsAtDataset(dataset.id, 2, -5)

    const updated = useDataStore.getState().datasets.find(d => d.id === dataset.id)
    expect(updated?.rowCount).toBe(10)
    expect(updated?.dataRowCount).toBe(4)
  })

  it('falls back to rowCount when dataRowCount is undefined', () => {
    const dataset = makeDataset('ds-4', 100)
    useDataStore.getState().addDataset(dataset)

    useDataStore.getState().insertRowsAtDataset(dataset.id, 5, 3)

    const updated = useDataStore.getState().datasets.find(d => d.id === dataset.id)
    expect(updated?.rowCount).toBe(103)
    expect(updated?.dataRowCount).toBe(103)
  })
})
