/**
 * RNAseqDataImportDialog scaffold-gating tests
 *
 * Locks the behavior contract:
 * - Import-time cross-dataset sample validation MUST NOT fire when the opposite
 *   slot is a blank scaffold (dataRowCount = 0).
 * - Import-time validation MUST fire when the opposite slot has real data.
 *
 * These tests cover the false-positive scenarios introduced by bootstrap:
 *   T_SG1: counts-first import with scaffold metadata → no mismatch prompt
 *   T_SG2: metadata-first import with scaffold counts → no mismatch prompt
 *   T_SG3: both loaded with real data + mismatch → confirm prompt appears + finalization completes
 *   T_SG4: legacy linked dataset (dataRowCount absent, rowCount>0) → validation fires (fallback gate)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@/test/test-utils'
import { RNAseqDataImportDialog } from '@/components/rnaseq/RNAseqDataImportDialog'

// ---------------------------------------------------------------------------
// Hoisted stable mock instances
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => {
  const mockOpenDialog = vi.fn()
  const mockImportCsv = vi.fn()
  const mockGetColumnsSampledData = vi.fn()
  const mockGetAllColumnStats = vi.fn()
  const mockGetColumnData = vi.fn()
  const mockValidateSampleMatch = vi.fn()
  const mockEnsureProjectId = vi.fn()
  const mockGetProject = vi.fn()
  const mockAddDataset = vi.fn()
  const mockReplaceCountsDataset = vi.fn()
  const mockReplaceMetadataDataset = vi.fn()

  // Mutable: controls what datasets the store exposes per test
  const state = {
    datasets: [] as Array<{
      id: string
      rowCount: number
      dataRowCount?: number
      columns: Array<{ id: string; name: string; type: string }>
    }>,
  }

  return {
    mockOpenDialog,
    mockImportCsv,
    mockGetColumnsSampledData,
    mockGetAllColumnStats,
    mockGetColumnData,
    mockValidateSampleMatch,
    mockEnsureProjectId,
    mockGetProject,
    mockAddDataset,
    mockReplaceCountsDataset,
    mockReplaceMetadataDataset,
    state,
  }
})

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: hoisted.mockOpenDialog,
}))

vi.mock('@/services/tauriApi', () => ({
  default: {
    importCsv: hoisted.mockImportCsv,
    importTsv: vi.fn(),
    importExcel: vi.fn(),
  },
}))

vi.mock('@/services/cacheService', () => ({
  default: {
    getColumnsSampledData: hoisted.mockGetColumnsSampledData,
    getAllColumnStats: hoisted.mockGetAllColumnStats,
    getColumnData: hoisted.mockGetColumnData,
    getColumnDuplicateSummary: vi.fn().mockResolvedValue({
      duplicateIdCount: 0, duplicateRowCount: 0, duplicateExamples: [], scanMode: 'backend_full',
    }),
    getColumnsSampledDataSafe: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@/services/rnaseqService', () => ({
  default: {
    validateSampleMatch: hoisted.mockValidateSampleMatch,
  },
}))

vi.mock('@/store/app-store', () => ({
  ensureProjectId: hoisted.mockEnsureProjectId,
}))

vi.mock('@/store/rnaseq-store', () => {
  const state = {
    replaceCountsDataset: hoisted.mockReplaceCountsDataset,
    replaceMetadataDataset: hoisted.mockReplaceMetadataDataset,
    getProject: hoisted.mockGetProject,
  }
  const useRNAseqStore = (sel?: (s: unknown) => unknown) =>
    sel ? sel(state) : state
  useRNAseqStore.getState = () => state
  return { useRNAseqStore }
})

vi.mock('@/store/data-store', () => ({
  useDataStore: (sel?: (s: unknown) => unknown) => {
    const state = {
      addDataset: hoisted.mockAddDataset,
      datasets: hoisted.state.datasets,
    }
    return sel ? sel(state) : state
  },
}))

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}))

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const makeCountImportResult = () => ({
  dataset: {
    id: 'counts-preview',
    name: 'counts.csv',
    rowCount: 120,
    columnCount: 4,
    dataRowCount: 100,
    columns: [
      { id: 'gene', name: 'Gene', type: 'text' },
      { id: 's1', name: 'S1', type: 'numeric' },
      { id: 's2', name: 'S2', type: 'numeric' },
      { id: 's3', name: 'S3', type: 'numeric' },
    ],
    importedAt: '2026-02-10T00:00:00.000Z',
    modifiedAt: '2026-02-10T00:00:00.000Z',
  },
  rows: [],
  sourcePath: 'C:\\data\\counts.csv',
})

const makeMetaImportResult = () => ({
  dataset: {
    id: 'meta-preview',
    name: 'metadata.csv',
    rowCount: 50,
    columnCount: 3,
    dataRowCount: 3,
    columns: [
      { id: 'sid', name: 'sample_id', type: 'text' },
      { id: 'cond', name: 'condition', type: 'categorical' },
    ],
    importedAt: '2026-02-10T00:00:00.000Z',
    modifiedAt: '2026-02-10T00:00:00.000Z',
  },
  rows: [],
  sourcePath: 'C:\\data\\metadata.csv',
})

// Scaffold dataset — has rowCount (for the 100x100 grid) but dataRowCount=0
const scaffoldMetaDataset = {
  id: 'meta-scaffold',
  rowCount: 100,
  dataRowCount: 0,
  columns: [] as Array<{ id: string; name: string; type: string }>,
}

const scaffoldCountsDataset = {
  id: 'counts-scaffold',
  rowCount: 100,
  dataRowCount: 0,
  columns: [] as Array<{ id: string; name: string; type: string }>,
}

const realMetaDataset = {
  id: 'meta-real',
  rowCount: 53,
  dataRowCount: 3,
  columns: [
    { id: 'sid', name: 'sample_id', type: 'text' },
    { id: 'cond', name: 'condition', type: 'categorical' },
  ],
}

const errorSampleMatch = {
  status: 'error' as const,
  message: 'Samples in counts but not in metadata: S3',
  matchedSamples: ['S1', 'S2'],
  onlyInCounts: ['S3'],
  onlyInMetadata: [],
  matchCount: 2,
  totalCountSamples: 3,
  totalMetaSamples: 2,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RNAseqDataImportDialog scaffold-gating (import-time cross-validation)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.mockOpenDialog.mockResolvedValue('C:\\data\\counts.csv')
    hoisted.mockImportCsv.mockResolvedValue(makeCountImportResult())
    hoisted.mockEnsureProjectId.mockResolvedValue('project-1')
    hoisted.mockGetColumnsSampledData.mockResolvedValue({ s1: [10], s2: [20], s3: [30] })
    hoisted.mockGetAllColumnStats.mockResolvedValue([])
    hoisted.mockGetColumnData.mockResolvedValue(['S1', 'S2', 'S3'])
    hoisted.mockReplaceCountsDataset.mockResolvedValue(undefined)
    hoisted.mockReplaceMetadataDataset.mockResolvedValue(undefined)
    hoisted.mockValidateSampleMatch.mockResolvedValue({
      sampleMatch: errorSampleMatch,
      metadataSampleValidation: undefined,
    })
    // window.confirm should never be called in T_SG1/T_SG2
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  // -------------------------------------------------------------------------
  // T_SG1: Counts imported first — metadata slot is scaffold (dataRowCount=0)
  //        No mismatch prompt should fire
  // -------------------------------------------------------------------------
  it('T_SG1: counts-first import with scaffold metadata does not trigger mismatch prompt', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')

    // Project has a scaffold metadata slot linked
    hoisted.mockGetProject.mockReturnValue({
      id: 'project-1',
      countsDatasetId: null,
      metadataDatasetId: scaffoldMetaDataset.id,
    })
    // The scaffold dataset is in the store
    hoisted.state.datasets = [scaffoldMetaDataset]

    render(
      <RNAseqDataImportDialog
        open
        projectId="project-1"
        mode="counts"
        onOpenChange={vi.fn()}
        onImportComplete={vi.fn()}
      />
    )

    // Wait for auto-import flow to complete (mocked validateSampleMatch was configured)
    await waitFor(() => expect(hoisted.mockImportCsv).toHaveBeenCalled())
    // Give async validation time to run
    await waitFor(() => expect(hoisted.mockReplaceCountsDataset).toHaveBeenCalled(), { timeout: 3000 })

    // Critical: confirm (mismatch dialog) must NOT have been called
    expect(confirmSpy).not.toHaveBeenCalled()
    // validateSampleMatch must NOT have been called against a scaffold
    expect(hoisted.mockValidateSampleMatch).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // T_SG2: Metadata imported first — counts slot is scaffold (dataRowCount=0)
  //        No mismatch prompt should fire
  // -------------------------------------------------------------------------
  it('T_SG2: metadata-first import with scaffold counts does not trigger mismatch prompt', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')

    hoisted.mockOpenDialog.mockResolvedValue('C:\\data\\metadata.csv')
    hoisted.mockImportCsv.mockResolvedValue(makeMetaImportResult())

    hoisted.mockGetProject.mockReturnValue({
      id: 'project-1',
      countsDatasetId: scaffoldCountsDataset.id,
      metadataDatasetId: null,
    })
    hoisted.state.datasets = [scaffoldCountsDataset]

    render(
      <RNAseqDataImportDialog
        open
        projectId="project-1"
        mode="metadata"
        onOpenChange={vi.fn()}
        onImportComplete={vi.fn()}
      />
    )

    await waitFor(() => expect(hoisted.mockImportCsv).toHaveBeenCalled())
    await waitFor(() => expect(hoisted.mockReplaceMetadataDataset).toHaveBeenCalled(), { timeout: 3000 })

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(hoisted.mockValidateSampleMatch).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // T_SG3: Both slots have real data + mismatch → confirm prompt MUST appear
  //        AND finalization (replaceCountsDataset) must complete when user confirms.
  //        Ensures we did not over-suppress validation and that finalization
  //        is not accidentally blocked after the user accepts the mismatch.
  // -------------------------------------------------------------------------
  it('T_SG3: both slots have real data and mismatch → confirm prompt fires and finalization completes', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    hoisted.mockGetProject.mockReturnValue({
      id: 'project-1',
      countsDatasetId: null,
      metadataDatasetId: realMetaDataset.id,
    })
    hoisted.state.datasets = [realMetaDataset]

    render(
      <RNAseqDataImportDialog
        open
        projectId="project-1"
        mode="counts"
        onOpenChange={vi.fn()}
        onImportComplete={vi.fn()}
      />
    )

    await waitFor(() => expect(hoisted.mockImportCsv).toHaveBeenCalled())
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1), { timeout: 3000 })

    expect(hoisted.mockValidateSampleMatch).toHaveBeenCalledTimes(1)

    // After the user confirms, finalization MUST complete
    await waitFor(() => expect(hoisted.mockReplaceCountsDataset).toHaveBeenCalled(), { timeout: 3000 })
  })

  // -------------------------------------------------------------------------
  // T_SG4: Legacy linked dataset (dataRowCount absent, rowCount > 0) — the
  //        hasMatchableSamples fallback (dataset.rowCount) must treat it as
  //        having real data so validation fires.
  //        Locks the `?? dataset.rowCount` branch in hasMatchableSamples.
  // -------------------------------------------------------------------------
  it('T_SG4: legacy linked dataset (dataRowCount absent, rowCount>0) triggers mismatch validation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    const legacyMetaDataset = {
      id: 'meta-legacy',
      rowCount: 50,
      // dataRowCount intentionally absent — simulates a pre-bootstrap dataset
      columns: [
        { id: 'sid', name: 'sample_id', type: 'text' },
        { id: 'cond', name: 'condition', type: 'categorical' },
      ],
    }

    hoisted.mockGetProject.mockReturnValue({
      id: 'project-1',
      countsDatasetId: null,
      metadataDatasetId: legacyMetaDataset.id,
    })
    hoisted.state.datasets = [legacyMetaDataset as typeof realMetaDataset]

    render(
      <RNAseqDataImportDialog
        open
        projectId="project-1"
        mode="counts"
        onOpenChange={vi.fn()}
        onImportComplete={vi.fn()}
      />
    )

    await waitFor(() => expect(hoisted.mockImportCsv).toHaveBeenCalled())
    await waitFor(() => expect(hoisted.mockValidateSampleMatch).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
  })
})
