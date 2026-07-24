import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dataset } from '@/store/data-store'

const { mockCreateEmptyDuckDB, mockSetActiveProjectId } = vi.hoisted(() => ({
  mockCreateEmptyDuckDB: vi.fn(),
  mockSetActiveProjectId: vi.fn().mockResolvedValue('project-1'),
}))

vi.mock('@/services/cacheService', () => ({
  default: {
    createEmptyDuckDB: mockCreateEmptyDuckDB,
    setActiveProjectId: mockSetActiveProjectId,
  },
}))

import { useAppStore } from '@/store/app-store'
import { useDataStore } from '@/store/data-store'

const datasetA: Dataset = {
  id: 'dataset-a',
  name: 'Dataset A',
  rowCount: 10,
  dataRowCount: 10,
  columnCount: 1,
  columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
  nextAutoColumnNumber: 2,
  importedAt: new Date('2026-04-24T00:00:00.000Z'),
  modifiedAt: new Date('2026-04-24T00:00:00.000Z'),
}

describe('app-store createFamily sequencing', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useAppStore.setState({
      families: [
        {
          id: 'statistics-1',
          name: 'Statistics',
          datasetId: datasetA.id,
          hasData: true,
          hasResults: false,
          createdAt: new Date('2026-04-24T00:00:00.000Z'),
        },
      ],
      activeFamilyId: 'statistics-1',
      projectId: 'project-1',
      projectDirty: false,
      projectDirtyRevision: 0,
    })

    useDataStore.setState({
      datasets: [datasetA],
      currentDataset: datasetA,
      invalidatedColumnIds: new Set<string>(),
      columnClassificationCache: new Map(),
      selectionStats: null,
    } as Partial<ReturnType<typeof useDataStore.getState>>)
  })

  it('does not activate the new family or replace currentDataset until blank dataset bootstrap completes', async () => {
    let resolveCreateEmptyDuckDB: (() => void) | null = null
    mockCreateEmptyDuckDB.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCreateEmptyDuckDB = resolve
        })
    )

    const createFamilyPromise = useAppStore.getState().createFamily('Statistics #2')

    expect(useAppStore.getState().activeFamilyId).toBe('statistics-1')
    expect(useAppStore.getState().families).toHaveLength(1)
    expect(useDataStore.getState().currentDataset?.id).toBe(datasetA.id)

    await vi.waitFor(() => {
      expect(mockCreateEmptyDuckDB).toHaveBeenCalledTimes(1)
      expect(resolveCreateEmptyDuckDB).not.toBeNull()
    })

    resolveCreateEmptyDuckDB!()
    const newFamily = await createFamilyPromise

    expect(newFamily).not.toBeNull()
    if (!newFamily) throw new Error('Expected createFamily to return the new family')
    expect(newFamily.id).toBe('statistics-2')
    expect(useAppStore.getState().activeFamilyId).toBe(newFamily.id)

    const storedNewFamily = useAppStore
      .getState()
      .families.find((family) => family.id === newFamily.id)
    expect(storedNewFamily?.datasetId).toMatch(/^blank-/)
    expect(newFamily.datasetId).toBe(storedNewFamily?.datasetId)
    expect(useDataStore.getState().currentDataset?.id).toBe(datasetA.id)
  })

  it('does not return a phantom family when blank dataset bootstrap fails', async () => {
    mockCreateEmptyDuckDB.mockRejectedValueOnce(new Error('duckdb busy'))

    const newFamily = await useAppStore.getState().createFamily('Statistics #2')

    expect(newFamily).toBeNull()
    expect(useAppStore.getState().activeFamilyId).toBe('statistics-1')
    expect(useAppStore.getState().families).toHaveLength(1)
    expect(useDataStore.getState().datasets).toHaveLength(1)
    expect(useDataStore.getState().currentDataset?.id).toBe(datasetA.id)
    expect(useAppStore.getState().projectDirty).toBe(false)
  })
})
