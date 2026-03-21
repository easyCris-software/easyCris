import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { RNAseqDataImportDialog } from '@/components/rnaseq/RNAseqDataImportDialog'

const hoisted = vi.hoisted(() => {
  const mockOpenDialog = vi.fn()
  const mockImportCsv = vi.fn()
  const mockImportTsv = vi.fn()
  const mockImportExcel = vi.fn()
  const mockGetColumnsSampledData = vi.fn()
  const mockGetAllColumnStats = vi.fn()
  const mockGetColumnData = vi.fn()
  const mockValidateSampleMatch = vi.fn()
  const mockEnsureProjectId = vi.fn()
  const mockSetCountsDataset = vi.fn()
  const mockSetMetadataDataset = vi.fn()
  const mockGetProject = vi.fn()
  const mockAddDataset = vi.fn()
  const mockToast = {
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }
  const linkedMetadataDataset = {
    id: 'meta-ds',
    rowCount: 2,
    columns: [
      { id: 'meta-id', name: 'sample_id', type: 'text' },
      { id: 'meta-cond', name: 'condition', type: 'text' },
    ],
  }
  return {
    mockOpenDialog,
    mockImportCsv,
    mockImportTsv,
    mockImportExcel,
    mockGetColumnsSampledData,
    mockGetAllColumnStats,
    mockGetColumnData,
    mockValidateSampleMatch,
    mockEnsureProjectId,
    mockSetCountsDataset,
    mockSetMetadataDataset,
    mockGetProject,
    mockAddDataset,
    mockToast,
    linkedMetadataDataset,
  }
})

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: hoisted.mockOpenDialog,
}))

vi.mock('@/services/tauriApi', () => ({
  default: {
    importCsv: hoisted.mockImportCsv,
    importTsv: hoisted.mockImportTsv,
    importExcel: hoisted.mockImportExcel,
  },
}))

vi.mock('@/services/cacheService', () => ({
  default: {
    getColumnsSampledData: hoisted.mockGetColumnsSampledData,
    getAllColumnStats: hoisted.mockGetAllColumnStats,
    getColumnData: hoisted.mockGetColumnData,
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

vi.mock('@/store/rnaseq-store', () => ({
  useRNAseqStore: () => ({
    setCountsDataset: hoisted.mockSetCountsDataset,
    setMetadataDataset: hoisted.mockSetMetadataDataset,
    getProject: hoisted.mockGetProject,
  }),
}))

vi.mock('@/store/data-store', () => ({
  useDataStore: () => ({
    addDataset: hoisted.mockAddDataset,
    datasets: [hoisted.linkedMetadataDataset],
  }),
}))

vi.mock('sonner', () => ({
  toast: hoisted.mockToast,
}))

const makeCountImportResult = () => ({
  dataset: {
    id: 'counts-preview',
    name: 'counts.csv',
    rowCount: 120,
    columnCount: 4,
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

describe('RNAseqDataImportDialog sample mismatch confirmation', () => {
  beforeEach(() => {
    hoisted.mockOpenDialog.mockResolvedValue('C:\\data\\counts.csv')
    hoisted.mockImportCsv.mockResolvedValue(makeCountImportResult())
    hoisted.mockImportTsv.mockResolvedValue(makeCountImportResult())
    hoisted.mockImportExcel.mockResolvedValue(makeCountImportResult())
    hoisted.mockGetColumnsSampledData.mockResolvedValue({
      s1: [10],
      s2: [20],
      s3: [30],
    })
    hoisted.mockGetAllColumnStats.mockResolvedValue([])
    hoisted.mockGetColumnData.mockResolvedValue([])
    hoisted.mockValidateSampleMatch.mockResolvedValue({
      sampleMatch: errorSampleMatch,
      metadataSampleValidation: undefined,
    })
    hoisted.mockEnsureProjectId.mockResolvedValue('project-1')
    hoisted.mockGetProject.mockReturnValue({
      id: 'project-1',
      countsDatasetId: null,
      metadataDatasetId: 'meta-ds',
    })
  })

  it('auto-import does not proceed when sample match status is error and user cancels', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const onOpenChange = vi.fn()
    const onImportComplete = vi.fn()

    render(
      <RNAseqDataImportDialog
        open
        projectId="project-1"
        mode="counts"
        onOpenChange={onOpenChange}
        onImportComplete={onImportComplete}
      />
    )

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    expect(hoisted.mockAddDataset).not.toHaveBeenCalled()
    expect(hoisted.mockSetCountsDataset).not.toHaveBeenCalled()
    expect(onImportComplete).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('manual import button path does not proceed when sample match status is error and user cancels', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(
      <RNAseqDataImportDialog
        open
        projectId="project-1"
        mode="counts"
        onOpenChange={vi.fn()}
        onImportComplete={vi.fn()}
      />
    )

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    const importButton = screen.getByRole('button', { name: 'Import' })
    await waitFor(() => expect(importButton).toBeEnabled())

    fireEvent.click(importButton)

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(2))
    expect(hoisted.mockAddDataset).not.toHaveBeenCalled()
    expect(hoisted.mockSetCountsDataset).not.toHaveBeenCalled()
  })
})
