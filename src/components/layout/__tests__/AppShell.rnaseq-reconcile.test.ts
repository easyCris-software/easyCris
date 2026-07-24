/**
 * RNA-seq restore+reconcile pipeline integration tests
 *
 * Scope: tests the store-level pipeline that AppShell orchestrates:
 *   1. useRNAseqStore.getState().restoreFromProject(rnaseqState)
 *   2. await useRNAseqStore.getState().reconcileRestoredDatasets()
 *
 * These tests call the store directly — AppShell is NOT rendered here.
 * AppShell wiring (the if/else branch at AppShell.tsx:5519–5524 that calls
 * this pipeline) is verified manually and by the e2e smoke test in Task 7.3.
 * The store pipeline contracts tested here are the primary regression risk.
 *
 * Verified contracts:
 * - Null countsDatasetId/metadataDatasetId → new blank scaffold created and linked
 * - Dangling dataset IDs (present in serialized state, absent from data-store) → repaired
 * - Repaired datasets receive correct ownership tag: familyId = "rnaseq:<projectId>"
 * - Multiple projects with mixed damage → each repaired with its own projectId
 * - Healthy project (all IDs present in data-store) → no repair, familyId unchanged
 *
 * Coverage gap vs rnaseq-store.bootstrap.test.ts T13–T16:
 * - T_AR1–T_AR5 here exercise the full restoreFromProject→reconcile pipeline
 *   end-to-end, including ownership tagging (setDatasetFamily) which T13–T16
 *   do not assert.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted stable mock instances
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => {
  const mockInitializeBlankDataset = vi.fn()
  const mockRemoveDatasetStore = vi.fn()
  const mockSetDatasetFamily = vi.fn()
  const mockCacheRemoveDataset = vi.fn()
  const mockSetProjectDirty = vi.fn()

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
// Store import (after mocks)
// ---------------------------------------------------------------------------
import { useRNAseqStore } from '@/store/rnaseq-store'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let _dsCounter = 0

function makeMockDataset(nameHint = 'ds') {
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
  }
}

function makeSerializedProject(overrides: {
  id: string
  countsDatasetId?: string | null
  metadataDatasetId?: string | null
}) {
  return {
    id: overrides.id,
    name: `Project ${overrides.id}`,
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    countsDatasetId: overrides.countsDatasetId ?? null,
    metadataDatasetId: overrides.metadataDatasetId ?? null,
    models: [],
    resultsRef: [],
    activeTab: 'counts' as const,
    activeModelId: null,
    activeResultId: null,
    activePlotType: null,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppShell RNA-seq reconciliation pipeline', () => {
  beforeEach(() => {
    useRNAseqStore.getState().reset()
    vi.clearAllMocks()
    _dsCounter = 0
    hoisted.mockSharedState.families = []
    hoisted.mockSharedState.datasets = []
    hoisted.mockInitializeBlankDataset.mockImplementation(async (name: string) =>
      makeMockDataset(name)
    )
  })

  // -------------------------------------------------------------------------
  // T_AR1: Full pipeline — null IDs → repaired + owned correctly
  // -------------------------------------------------------------------------
  it('T_AR1: null dataset IDs repaired with correct familyId after restoreFromProject + reconcile', async () => {
    useRNAseqStore.getState().restoreFromProject({
      schemaVersion: 'rnaseq_v1',
      exportedAt: new Date().toISOString(),
      projects: [makeSerializedProject({ id: 'proj-a', countsDatasetId: null, metadataDatasetId: null })],
      activeProjectId: 'proj-a',
    })

    await useRNAseqStore.getState().reconcileRestoredDatasets()

    // Both slots were null → two blank scaffolds provisioned
    expect(hoisted.mockInitializeBlankDataset).toHaveBeenCalledTimes(2)

    // Ownership tagged with rnaseq:<projectId>
    expect(hoisted.mockSetDatasetFamily).toHaveBeenCalledWith(
      expect.any(String),
      'rnaseq:proj-a'
    )
    expect(hoisted.mockSetDatasetFamily).toHaveBeenCalledTimes(2)

    // Project links are now non-null
    const proj = useRNAseqStore.getState().projects.find(p => p.id === 'proj-a')
    expect(proj?.countsDatasetId).toBeTruthy()
    expect(proj?.metadataDatasetId).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // T_AR2: Full pipeline — dangling IDs → repaired + owned correctly
  // -------------------------------------------------------------------------
  it('T_AR2: dangling dataset IDs (not in data-store) repaired with correct familyId', async () => {
    // data-store is empty — all IDs are dangling
    hoisted.mockSharedState.datasets = []

    useRNAseqStore.getState().restoreFromProject({
      schemaVersion: 'rnaseq_v1',
      exportedAt: new Date().toISOString(),
      projects: [makeSerializedProject({
        id: 'proj-b',
        countsDatasetId: 'orphan-counts',
        metadataDatasetId: 'orphan-meta',
      })],
      activeProjectId: 'proj-b',
    })

    await useRNAseqStore.getState().reconcileRestoredDatasets()

    expect(hoisted.mockInitializeBlankDataset).toHaveBeenCalledTimes(2)
    expect(hoisted.mockSetDatasetFamily).toHaveBeenCalledTimes(2)
    expect(hoisted.mockSetDatasetFamily).toHaveBeenCalledWith(
      expect.any(String),
      'rnaseq:proj-b'
    )

    const proj = useRNAseqStore.getState().projects.find(p => p.id === 'proj-b')
    expect(proj?.countsDatasetId).not.toBe('orphan-counts')
    expect(proj?.metadataDatasetId).not.toBe('orphan-meta')
  })

  // -------------------------------------------------------------------------
  // T_AR3: Multiple projects — each repaired with its own projectId familyId
  // -------------------------------------------------------------------------
  it('T_AR3: multiple damaged projects each tagged with their own familyId', async () => {
    useRNAseqStore.getState().restoreFromProject({
      schemaVersion: 'rnaseq_v1',
      exportedAt: new Date().toISOString(),
      projects: [
        makeSerializedProject({ id: 'proj-x', countsDatasetId: null, metadataDatasetId: null }),
        makeSerializedProject({ id: 'proj-y', countsDatasetId: null, metadataDatasetId: null }),
      ],
      activeProjectId: 'proj-x',
    })

    await useRNAseqStore.getState().reconcileRestoredDatasets()

    // 4 total: 2 per project
    expect(hoisted.mockInitializeBlankDataset).toHaveBeenCalledTimes(4)

    const familyIdCalls = (hoisted.mockSetDatasetFamily.mock.calls as [string, string][]).map(
      ([, familyId]) => familyId
    )
    expect(familyIdCalls.filter(f => f === 'rnaseq:proj-x')).toHaveLength(2)
    expect(familyIdCalls.filter(f => f === 'rnaseq:proj-y')).toHaveLength(2)
  })

  // -------------------------------------------------------------------------
  // T_AR4: Healthy project — no repair calls, no spurious familyId tags
  // -------------------------------------------------------------------------
  it('T_AR4: healthy project (all IDs present in data-store) triggers no repair', async () => {
    hoisted.mockSharedState.datasets = [
      { id: 'healthy-counts' },
      { id: 'healthy-meta' },
    ]

    useRNAseqStore.getState().restoreFromProject({
      schemaVersion: 'rnaseq_v1',
      exportedAt: new Date().toISOString(),
      projects: [makeSerializedProject({
        id: 'proj-healthy',
        countsDatasetId: 'healthy-counts',
        metadataDatasetId: 'healthy-meta',
      })],
      activeProjectId: 'proj-healthy',
    })

    await useRNAseqStore.getState().reconcileRestoredDatasets()

    expect(hoisted.mockInitializeBlankDataset).not.toHaveBeenCalled()
    expect(hoisted.mockSetDatasetFamily).not.toHaveBeenCalled()

    // Links unchanged
    const proj = useRNAseqStore.getState().projects.find(p => p.id === 'proj-healthy')
    expect(proj?.countsDatasetId).toBe('healthy-counts')
    expect(proj?.metadataDatasetId).toBe('healthy-meta')
  })

  // -------------------------------------------------------------------------
  // T_AR5: Mixed state — one slot healthy, one dangling → only damaged slot repaired
  // -------------------------------------------------------------------------
  it('T_AR5: mixed state — only the damaged slot is repaired', async () => {
    hoisted.mockSharedState.datasets = [{ id: 'existing-meta' }]

    useRNAseqStore.getState().restoreFromProject({
      schemaVersion: 'rnaseq_v1',
      exportedAt: new Date().toISOString(),
      projects: [makeSerializedProject({
        id: 'proj-mixed',
        countsDatasetId: null,           // damaged
        metadataDatasetId: 'existing-meta', // healthy
      })],
      activeProjectId: 'proj-mixed',
    })

    await useRNAseqStore.getState().reconcileRestoredDatasets()

    // Only counts was null → exactly one scaffold provisioned
    expect(hoisted.mockInitializeBlankDataset).toHaveBeenCalledTimes(1)
    expect(hoisted.mockSetDatasetFamily).toHaveBeenCalledTimes(1)
    expect(hoisted.mockSetDatasetFamily).toHaveBeenCalledWith(
      expect.any(String),
      'rnaseq:proj-mixed'
    )

    const proj = useRNAseqStore.getState().projects.find(p => p.id === 'proj-mixed')
    expect(proj?.countsDatasetId).toBeTruthy()
    expect(proj?.metadataDatasetId).toBe('existing-meta')  // unchanged
  })
})
