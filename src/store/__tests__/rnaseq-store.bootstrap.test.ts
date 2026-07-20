/**
 * RNA-seq store bootstrap + lifecycle tests
 *
 * Tests the full dataset lifecycle contract:
 * - createProjectWithBootstrap provisions two isolated blank datasets
 * - replaceCountsDataset / replaceMetadataDataset perform reference-aware cleanup
 * - deleteProject / clearAllProjects clean up owned unreferenced datasets
 * - Rollback on partial bootstrap failure (store + cache)
 * - Deduplication before cleanup loops
 * - Legacy dataset readiness formula
 *
 * Mocks are stable module-level instances reset in beforeEach.
 * All behaviors verified through public store actions (not internal helpers).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted stable mock instances — must be declared before any vi.mock calls
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => {
  const mockInitializeBlankDataset = vi.fn()
  const mockRemoveDatasetStore = vi.fn()
  const mockSetDatasetFamily = vi.fn()
  const mockCacheRemoveDataset = vi.fn()
  const mockSetProjectDirty = vi.fn()

  // Mutable state for per-test control of Statistics families reference list
  const mockSharedState = {
    families: [] as Array<{ id: string; datasetId?: string }>,
    datasets: [] as Array<{ id: string }>,
  }

  return {
    mockInitializeBlankDataset,
    mockRemoveDatasetStore,
    mockSetDatasetFamily,
    mockCacheRemoveDataset,
    mockSetProjectDirty,
    mockSharedState,
  }
})

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/store/data-store', () => ({
  useDataStore: {
    getState: () => ({
      initializeBlankDataset: hoisted.mockInitializeBlankDataset,
      removeDataset: hoisted.mockRemoveDatasetStore,
      setDatasetFamily: hoisted.mockSetDatasetFamily,
      datasets: hoisted.mockSharedState.datasets,
    }),
  },
}))

vi.mock('@/store/app-store', () => ({
  useAppStore: {
    getState: () => ({
      setProjectDirty: hoisted.mockSetProjectDirty,
      families: hoisted.mockSharedState.families,
    }),
  },
  ensureProjectId: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/services/cacheService', () => ({
  default: {
    removeDataset: hoisted.mockCacheRemoveDataset,
    createEmptyDuckDB: vi.fn().mockResolvedValue(undefined),
  },
}))

// ---------------------------------------------------------------------------
// Store import (after mocks are registered)
// ---------------------------------------------------------------------------
import { useRNAseqStore } from '@/store/rnaseq-store'

// ---------------------------------------------------------------------------
// Test dataset factory
// ---------------------------------------------------------------------------
let _dsCounter = 0

function makeMockDataset(nameHint = 'ds', overrides: Record<string, unknown> = {}) {
  _dsCounter++
  return {
    id: `mock-ds-${_dsCounter}-${nameHint.replace(/\s+/g, '-')}`,
    name: nameHint,
    dataRowCount: 0,
    rowCount: 100,
    columnCount: 100,
    columns: [],
    importedAt: new Date(),
    modifiedAt: new Date(),
    ...overrides,
  }
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RNA-seq store bootstrap + lifecycle', () => {
  beforeEach(() => {
    // Reset store state
    useRNAseqStore.getState().reset()
    // Reset all mock call history
    vi.clearAllMocks()
    // Reset counter and mutable state
    _dsCounter = 0
    hoisted.mockSharedState.families = []
    hoisted.mockSharedState.datasets = []
    // Default: initializeBlankDataset returns a fresh mock dataset each call
    hoisted.mockInitializeBlankDataset.mockImplementation(async (name: string) =>
      makeMockDataset(name)
    )
    // Default: cleanup operations resolve successfully
    hoisted.mockCacheRemoveDataset.mockResolvedValue(undefined)
    hoisted.mockRemoveDatasetStore.mockImplementation(() => undefined)
    hoisted.mockSetDatasetFamily.mockImplementation(() => undefined)
  })

  // -------------------------------------------------------------------------
  // T1: createProjectWithBootstrap creates two linked datasets with distinct IDs
  // -------------------------------------------------------------------------
  it('T1: createProjectWithBootstrap links counts and metadata with distinct dataset IDs', async () => {
    const project = await useRNAseqStore.getState().createProjectWithBootstrap('RNA-seq 1')

    expect(project.countsDatasetId).toBeTruthy()
    expect(project.metadataDatasetId).toBeTruthy()
    expect(project.countsDatasetId).not.toBe(project.metadataDatasetId)
  })

  // -------------------------------------------------------------------------
  // T2: Both datasets tagged familyId = rnaseq:<projectId>
  // -------------------------------------------------------------------------
  it('T2: bootstrap tags both datasets with familyId = rnaseq:<projectId>', async () => {
    const project = await useRNAseqStore.getState().createProjectWithBootstrap('RNA-seq 1')
    const expectedFamily = `rnaseq:${project.id}`

    expect(hoisted.mockSetDatasetFamily).toHaveBeenCalledWith(project.countsDatasetId, expectedFamily)
    expect(hoisted.mockSetDatasetFamily).toHaveBeenCalledWith(project.metadataDatasetId, expectedFamily)
  })

  // -------------------------------------------------------------------------
  // T3: Rollback removes counts from store AND cache when metadata init fails
  // -------------------------------------------------------------------------
  it('T3: rollback cleans up counts dataset (store + cache) when metadata init fails', async () => {
    const countsDs = makeMockDataset('Counts')
    hoisted.mockInitializeBlankDataset
      .mockResolvedValueOnce(countsDs)
      .mockRejectedValueOnce(new Error('DuckDB unavailable'))

    await expect(
      useRNAseqStore.getState().createProjectWithBootstrap('X')
    ).rejects.toThrow('DuckDB unavailable')

    expect(hoisted.mockRemoveDatasetStore).toHaveBeenCalledWith(countsDs.id)
    expect(hoisted.mockCacheRemoveDataset).toHaveBeenCalledWith(countsDs.id)
  })

  // -------------------------------------------------------------------------
  // T4: replaceCountsDataset deletes old scaffold when unreferenced
  // -------------------------------------------------------------------------
  it('T4: replaceCountsDataset physically deletes old dataset when unreferenced', async () => {
    const project = await useRNAseqStore.getState().createProjectWithBootstrap('Test')
    const oldCountsId = project.countsDatasetId!
    const newDs = makeMockDataset('New Counts')

    vi.clearAllMocks()
    await useRNAseqStore.getState().replaceCountsDataset(project.id, newDs.id)

    expect(hoisted.mockRemoveDatasetStore).toHaveBeenCalledWith(oldCountsId)
    expect(hoisted.mockCacheRemoveDataset).toHaveBeenCalledWith(oldCountsId)
  })

  // -------------------------------------------------------------------------
  // T5: replaceCountsDataset does NOT delete when referenced by Statistics
  // -------------------------------------------------------------------------
  it('T5: replaceCountsDataset does not delete dataset referenced by a Statistics family', async () => {
    const project = await useRNAseqStore.getState().createProjectWithBootstrap('Test')
    const oldCountsId = project.countsDatasetId!

    // Statistics family holds the same dataset ID
    hoisted.mockSharedState.families = [{ id: 'stats-fam-1', datasetId: oldCountsId }]

    const newDs = makeMockDataset('New Counts')
    vi.clearAllMocks()

    await useRNAseqStore.getState().replaceCountsDataset(project.id, newDs.id)

    expect(hoisted.mockRemoveDatasetStore).not.toHaveBeenCalledWith(oldCountsId)
    expect(hoisted.mockCacheRemoveDataset).not.toHaveBeenCalledWith(oldCountsId)
  })

  // -------------------------------------------------------------------------
  // T6: replaceCountsDataset does NOT delete when referenced by another RNA-seq project
  // -------------------------------------------------------------------------
  it('T6: replaceCountsDataset does not delete dataset referenced by another RNA-seq project', async () => {
    const p1 = await useRNAseqStore.getState().createProjectWithBootstrap('Project 1')
    const p2 = await useRNAseqStore.getState().createProjectWithBootstrap('Project 2')

    // Force p2 to also reference p1's counts dataset (shared reference edge case)
    const sharedDatasetId = p1.countsDatasetId!
    useRNAseqStore.setState(state => ({
      projects: state.projects.map(p =>
        p.id === p2.id ? { ...p, countsDatasetId: sharedDatasetId } : p
      ),
    }))

    const newDs = makeMockDataset('New Counts for P1')
    vi.clearAllMocks()

    // Replace p1's counts — p2 still references the shared ID
    await useRNAseqStore.getState().replaceCountsDataset(p1.id, newDs.id)

    expect(hoisted.mockRemoveDatasetStore).not.toHaveBeenCalledWith(sharedDatasetId)
    expect(hoisted.mockCacheRemoveDataset).not.toHaveBeenCalledWith(sharedDatasetId)
  })

  // -------------------------------------------------------------------------
  // T7: deleteProject physically deletes unreferenced linked datasets
  // -------------------------------------------------------------------------
  it('T7: deleteProject physically deletes unreferenced counts and metadata datasets', async () => {
    const project = await useRNAseqStore.getState().createProjectWithBootstrap('Test')
    const countsId = project.countsDatasetId!
    const metaId = project.metadataDatasetId!

    vi.clearAllMocks()
    await useRNAseqStore.getState().deleteProject(project.id)

    expect(hoisted.mockRemoveDatasetStore).toHaveBeenCalledWith(countsId)
    expect(hoisted.mockCacheRemoveDataset).toHaveBeenCalledWith(countsId)
    expect(hoisted.mockRemoveDatasetStore).toHaveBeenCalledWith(metaId)
    expect(hoisted.mockCacheRemoveDataset).toHaveBeenCalledWith(metaId)
  })

  // -------------------------------------------------------------------------
  // T8: clearAllProjects physically deletes all unreferenced linked datasets
  // -------------------------------------------------------------------------
  it('T8: clearAllProjects physically deletes all unreferenced linked datasets', async () => {
    const p1 = await useRNAseqStore.getState().createProjectWithBootstrap('P1')
    const p2 = await useRNAseqStore.getState().createProjectWithBootstrap('P2')
    const allIds = [
      p1.countsDatasetId!,
      p1.metadataDatasetId!,
      p2.countsDatasetId!,
      p2.metadataDatasetId!,
    ]

    vi.clearAllMocks()
    // Await directly — clearAllProjects must return Promise<void> (not fire-and-forget)
    await useRNAseqStore.getState().clearAllProjects()

    for (const id of allIds) {
      expect(hoisted.mockRemoveDatasetStore).toHaveBeenCalledWith(id)
      expect(hoisted.mockCacheRemoveDataset).toHaveBeenCalledWith(id)
    }
  })

  // -------------------------------------------------------------------------
  // T9: deleteProject does NOT clean dataset referenced by Statistics (namespace isolation)
  // -------------------------------------------------------------------------
  it('T9: deleteProject does not clean dataset also held by a Statistics family', async () => {
    const project = await useRNAseqStore.getState().createProjectWithBootstrap('Test')
    const countsId = project.countsDatasetId!

    // Statistics family claims the same dataset ID
    hoisted.mockSharedState.families = [{ id: 'stats-fam', datasetId: countsId }]

    vi.clearAllMocks()
    await useRNAseqStore.getState().deleteProject(project.id)

    expect(hoisted.mockRemoveDatasetStore).not.toHaveBeenCalledWith(countsId)
    expect(hoisted.mockCacheRemoveDataset).not.toHaveBeenCalledWith(countsId)
  })

  // -------------------------------------------------------------------------
  // T10: replaceCountsDataset is a no-op when newId === oldId (self-replace guard)
  // -------------------------------------------------------------------------
  it('T10: replaceCountsDataset is a no-op when new dataset ID equals current ID', async () => {
    const project = await useRNAseqStore.getState().createProjectWithBootstrap('Test')
    const sameId = project.countsDatasetId!

    vi.clearAllMocks()
    await useRNAseqStore.getState().replaceCountsDataset(project.id, sameId)

    expect(hoisted.mockRemoveDatasetStore).not.toHaveBeenCalled()
    expect(hoisted.mockCacheRemoveDataset).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // T11: deleteProject deduplicates IDs — no double physical delete
  // -------------------------------------------------------------------------
  it('T11: deleteProject deduplicates dataset IDs before cleanup — no double delete', async () => {
    const project = await useRNAseqStore.getState().createProjectWithBootstrap('Test')
    const countsId = project.countsDatasetId!

    // Force both slots to point to the same ID (edge case: shared slot)
    useRNAseqStore.setState(state => ({
      projects: state.projects.map(p =>
        p.id === project.id ? { ...p, metadataDatasetId: countsId } : p
      ),
    }))

    vi.clearAllMocks()
    await useRNAseqStore.getState().deleteProject(project.id)

    const storeCalls = (hoisted.mockRemoveDatasetStore.mock.calls as [string][]).filter(
      ([id]) => id === countsId
    )
    const cacheCalls = (hoisted.mockCacheRemoveDataset.mock.calls as [string][]).filter(
      ([id]) => id === countsId
    )

    expect(storeCalls).toHaveLength(1)
    expect(cacheCalls).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // T12: Readiness formula correctly handles legacy datasets
  //      (dataRowCount undefined, rowCount > 0 → treated as ready)
  // -------------------------------------------------------------------------
  it('T12: usable-row formula handles legacy datasets with no dataRowCount field', () => {
    // The formula: usableRows = dataRowCount ?? rowCount ?? 0
    // This formula will be used in the UI (getUsableRowCount helper, Task 6).
    // Verified here as a contract test to lock in expected behavior.
    const getUsableRows = (ds: { dataRowCount?: number; rowCount?: number } | null | undefined) =>
      ds?.dataRowCount ?? ds?.rowCount ?? 0

    // Legacy imported dataset: no dataRowCount field, but rowCount = 50
    expect(getUsableRows({ rowCount: 50 })).toBe(50)
    expect(getUsableRows({ dataRowCount: undefined, rowCount: 50 })).toBe(50)

    // Bootstrap scaffold: dataRowCount=0 (explicit zero overrides rowCount=100)
    expect(getUsableRows({ dataRowCount: 0, rowCount: 100 })).toBe(0)

    // Modern dataset with real data
    expect(getUsableRows({ dataRowCount: 30, rowCount: 30 })).toBe(30)

    // Null/undefined dataset: returns 0 (safe default)
    expect(getUsableRows(null)).toBe(0)
    expect(getUsableRows(undefined)).toBe(0)
  })

  // -------------------------------------------------------------------------
  // T13: reconcileRestoredDatasets provisions blank scaffolds for missing IDs
  // -------------------------------------------------------------------------
  it('T13: reconcileRestoredDatasets provisions blank scaffold for each missing dataset ID', async () => {
    // Restore a project whose countsDatasetId doesn't exist in the data store
    // (data-store mock returns datasets:[] so all IDs are "missing")
    useRNAseqStore.getState().restoreFromProject({
      schemaVersion: 'rnaseq_v1',
      exportedAt: new Date().toISOString(),
      projects: [
        {
          id: 'restored-proj',
          name: 'Restored',
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          countsDatasetId: 'dangling-counts-id',
          metadataDatasetId: 'dangling-meta-id',
          models: [],
          resultsRef: [],
          activeTab: 'counts' as const,
          activeModelId: null,
          activeResultId: null,
          activePlotType: null,
        },
      ],
      activeProjectId: 'restored-proj',
    })

    vi.clearAllMocks()
    await useRNAseqStore.getState().reconcileRestoredDatasets()

    // Both missing IDs → two blank scaffolds initialized
    expect(hoisted.mockInitializeBlankDataset).toHaveBeenCalledTimes(2)

    // Project links updated to new scaffold IDs (no longer the dangling IDs)
    const project = useRNAseqStore.getState().projects.find(p => p.id === 'restored-proj')
    expect(project?.countsDatasetId).not.toBe('dangling-counts-id')
    expect(project?.metadataDatasetId).not.toBe('dangling-meta-id')
    expect(project?.countsDatasetId).toBeTruthy()
    expect(project?.metadataDatasetId).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // T15: reconcileRestoredDatasets repairs null countsDatasetId
  // -------------------------------------------------------------------------
  it('T15: reconcileRestoredDatasets provisions blank scaffold when countsDatasetId is null', async () => {
    // Restore a project with a null countsDatasetId (legacy/corrupt save)
    useRNAseqStore.getState().restoreFromProject({
      schemaVersion: 'rnaseq_v1',
      exportedAt: new Date().toISOString(),
      projects: [
        {
          id: 'proj-null-counts',
          name: 'Null Counts',
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          countsDatasetId: null,           // ← null link to repair
          metadataDatasetId: 'present-meta-id',
          models: [],
          resultsRef: [],
          activeTab: 'counts' as const,
          activeModelId: null,
          activeResultId: null,
          activePlotType: null,
        },
      ],
      activeProjectId: 'proj-null-counts',
    })

    // Metadata ID exists in the data store — only counts needs repair
    hoisted.mockSharedState.datasets = [{ id: 'present-meta-id' }]

    vi.clearAllMocks()
    await useRNAseqStore.getState().reconcileRestoredDatasets()

    // Exactly one scaffold provisioned (counts only)
    expect(hoisted.mockInitializeBlankDataset).toHaveBeenCalledTimes(1)

    // Project now has a real counts ID, metadata unchanged
    const project = useRNAseqStore.getState().projects.find(p => p.id === 'proj-null-counts')
    expect(project?.countsDatasetId).toBeTruthy()
    expect(project?.metadataDatasetId).toBe('present-meta-id')
  })

  // -------------------------------------------------------------------------
  // T16: reconcileRestoredDatasets repairs null metadataDatasetId
  // -------------------------------------------------------------------------
  it('T16: reconcileRestoredDatasets provisions blank scaffold when metadataDatasetId is null', async () => {
    // Restore a project with a null metadataDatasetId
    useRNAseqStore.getState().restoreFromProject({
      schemaVersion: 'rnaseq_v1',
      exportedAt: new Date().toISOString(),
      projects: [
        {
          id: 'proj-null-meta',
          name: 'Null Meta',
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          countsDatasetId: 'present-counts-id',
          metadataDatasetId: null,         // ← null link to repair
          models: [],
          resultsRef: [],
          activeTab: 'counts' as const,
          activeModelId: null,
          activeResultId: null,
          activePlotType: null,
        },
      ],
      activeProjectId: 'proj-null-meta',
    })

    // Counts ID exists in the data store — only metadata needs repair
    hoisted.mockSharedState.datasets = [{ id: 'present-counts-id' }]

    vi.clearAllMocks()
    await useRNAseqStore.getState().reconcileRestoredDatasets()

    // Exactly one scaffold provisioned (metadata only)
    expect(hoisted.mockInitializeBlankDataset).toHaveBeenCalledTimes(1)

    // Project now has a real metadata ID, counts unchanged
    const project = useRNAseqStore.getState().projects.find(p => p.id === 'proj-null-meta')
    expect(project?.countsDatasetId).toBe('present-counts-id')
    expect(project?.metadataDatasetId).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // T14: reconcileRestoredDatasets is a no-op when all dataset IDs are present
  // -------------------------------------------------------------------------
  it('T14: reconcileRestoredDatasets skips repair when dataset IDs exist in data store', async () => {
    // Create a project via bootstrap — its datasets are real (tracked by mock)
    const project = await useRNAseqStore.getState().createProjectWithBootstrap('Live Project')

    // Populate the shared datasets list so getState().datasets reflects both IDs
    hoisted.mockSharedState.datasets = [
      { id: project.countsDatasetId! },
      { id: project.metadataDatasetId! },
    ]

    vi.clearAllMocks()
    await useRNAseqStore.getState().reconcileRestoredDatasets()

    // No repair needed — no new scaffolds initialized
    expect(hoisted.mockInitializeBlankDataset).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // T17: clearAllProjects rejects when cache removal fails for any dataset
  // -------------------------------------------------------------------------
  it('T17: clearAllProjects rejects when cache removal fails for any linked dataset', async () => {
    await useRNAseqStore.getState().createProjectWithBootstrap('P1')

    vi.clearAllMocks()
    hoisted.mockCacheRemoveDataset.mockRejectedValueOnce(new Error('DuckDB locked'))

    await expect(useRNAseqStore.getState().clearAllProjects()).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // T18: clearAllProjects rejection message names the failed dataset count
  // -------------------------------------------------------------------------
  it('T18: clearAllProjects error message reports failed vs total dataset count', async () => {
    await useRNAseqStore.getState().createProjectWithBootstrap('P1')

    hoisted.mockCacheRemoveDataset.mockRejectedValue(new Error('DuckDB locked'))

    vi.clearAllMocks()
    hoisted.mockCacheRemoveDataset.mockRejectedValue(new Error('DuckDB locked'))

    const err = await useRNAseqStore.getState().clearAllProjects().catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/clearAllProjects/)
    expect((err as Error).message).toMatch(/\d+\/\d+/)
  })

  // -------------------------------------------------------------------------
  // T19: deleteProject rejects when cache removal fails for a linked dataset
  // -------------------------------------------------------------------------
  it('T19: deleteProject rejects when cache removal fails for a linked dataset', async () => {
    const project = await useRNAseqStore.getState().createProjectWithBootstrap('P1')

    vi.clearAllMocks()
    hoisted.mockCacheRemoveDataset.mockRejectedValueOnce(new Error('DuckDB locked'))

    await expect(useRNAseqStore.getState().deleteProject(project.id)).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // T20: deleteProject rejection message identifies the failed dataset count
  // -------------------------------------------------------------------------
  it('T20: deleteProject error message reports failed vs total dataset count', async () => {
    const project = await useRNAseqStore.getState().createProjectWithBootstrap('P1')

    vi.clearAllMocks()
    hoisted.mockCacheRemoveDataset.mockRejectedValue(new Error('DuckDB locked'))

    const err = await useRNAseqStore.getState().deleteProject(project.id).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/deleteProject/)
    expect((err as Error).message).toMatch(/\d+\/\d+/)
  })
})
