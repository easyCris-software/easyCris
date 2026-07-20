/**
 * RNAseqWorkspace configure-button preflight tests
 *
 * Locks the behavior contract for the Configure button sample-match preflight:
 *
 *   T_CP1: Configure click with sample mismatch → confirm prompt fires (non-hard-fail)
 *   T_CP2: Configure click, user cancels mismatch → DESeq2 config dialog does NOT open
 *   T_CP3: Configure click with no mismatch → config dialog opens without prompt
 *   T_CP4: Configure click, user confirms mismatch → config dialog opens
 *   T_CP5: Configure preflight passes countSampleIds (from filtered columns) to validateSampleMatch
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { RNAseqWorkspace } from '@/components/rnaseq/RNAseqWorkspace'

// ---------------------------------------------------------------------------
// Hoisted stable mock instances
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => {
  const mockValidateSampleMatch = vi.fn()
  const mockResetCountsDatasetToBlank = vi.fn()
  const mockResetMetadataDatasetToBlank = vi.fn()
  const mockGetColumnsSampledData = vi.fn()
  const mockGetCountSampleIdsWithData = vi.fn()

  return {
    mockValidateSampleMatch,
    mockResetCountsDatasetToBlank,
    mockResetMetadataDatasetToBlank,
    mockGetColumnsSampledData,
    mockGetCountSampleIdsWithData,
  }
})

// ---------------------------------------------------------------------------
// Shared project fixture — both slots have real data (Configure is enabled)
// ---------------------------------------------------------------------------
const mockProject = {
  id: 'project-1',
  name: 'Test RNA-seq',
  countsDatasetId: 'real-counts',
  metadataDatasetId: 'real-meta',
  models: [],
  results: [],
  activeTab: 'counts' as const,
  activeModelId: null,
  activeResultId: null,
  activePlotType: null,
  createdAt: new Date(),
  modifiedAt: new Date(),
}

const realCountsDataset = {
  id: 'real-counts',
  name: 'Counts',
  rowCount: 150,
  columnCount: 4,
  dataRowCount: 100,
  columns: [
    { id: 'gene', name: 'Gene', type: 'text' },
    { id: 's1', name: 'S1', type: 'numeric' },
    { id: 's2', name: 'S2', type: 'numeric' },
    { id: 's3', name: 'S3', type: 'numeric' },
  ],
  importedAt: new Date(),
  modifiedAt: new Date(),
}

const realMetaDataset = {
  id: 'real-meta',
  name: 'Metadata',
  rowCount: 53,
  columnCount: 2,
  dataRowCount: 3,
  columns: [
    { id: 'sid', name: 'sample_id', type: 'text' },
    { id: 'cond', name: 'condition', type: 'categorical' },
  ],
  importedAt: new Date(),
  modifiedAt: new Date(),
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

const okSampleMatch = {
  status: 'ok' as const,
  message: '',
  matchedSamples: ['S1', 'S2', 'S3'],
  onlyInCounts: [],
  onlyInMetadata: [],
  matchCount: 3,
  totalCountSamples: 3,
  totalMetaSamples: 3,
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/store/rnaseq-store', () => ({
  useActiveRNAseqProject: () => mockProject,
  useRNAseqAnalysisStatus: () => ({ isRunning: false, progress: 0, stage: '' }),
  useRNAseqStore: Object.assign(
    (sel?: (s: unknown) => unknown) => {
      const state = {
        setActiveTab: vi.fn(),
        setActivePlot: vi.fn(),
        setActiveModel: vi.fn(),
        setActiveResult: vi.fn(),
        setAnalysisRunning: vi.fn(),
        setAnalysisProgress: vi.fn(),
        setResult: vi.fn(),
        clearResult: vi.fn(),
        getResult: vi.fn(),
        setCountsDataset: vi.fn(),
        setMetadataDataset: vi.fn(),
        resetCountsDatasetToBlank: hoisted.mockResetCountsDatasetToBlank,
        resetMetadataDatasetToBlank: hoisted.mockResetMetadataDatasetToBlank,
        projects: [mockProject],
      }
      return sel ? sel(state) : state
    },
    { getState: vi.fn().mockReturnValue({ setActiveProject: vi.fn() }) }
  ),
}))

vi.mock('@/store/data-store', () => ({
  useDataStore: (sel?: (s: unknown) => unknown) => {
    const state = {
      datasets: [realCountsDataset, realMetaDataset],
      currentDataset: null,
      setCurrentDataset: vi.fn(),
      removeDataset: vi.fn(),
    }
    return sel ? sel(state) : state
  },
}))

vi.mock('@/store/app-store', () => {
  const appState = {
    families: [],
    appOperationLock: { active: false, token: null, operation: null, stage: null },
    acquireAppOperationLock: vi.fn(),
    updateAppOperationLock: vi.fn(),
    releaseAppOperationLock: vi.fn(),
  }
  const useAppStore = (sel?: (s: unknown) => unknown) =>
    sel ? sel(appState) : appState
  useAppStore.getState = () => appState
  return { useAppStore }
})

vi.mock('@/services/rnaseqService', () => ({
  default: {
    runAnalysis: vi.fn(),
    validateSampleMatch: hoisted.mockValidateSampleMatch,
  },
}))

vi.mock('@/services/exportService', () => ({ default: {} }))
vi.mock('@/services/tauriApi', () => ({ default: {} }))
vi.mock('@/services/cacheService', () => ({
  default: {
    removeDataset: vi.fn(),
    getColumnDuplicateSummary: vi.fn().mockResolvedValue({
      duplicateIdCount: 0, duplicateRowCount: 0, duplicateExamples: [], scanMode: 'backend_full',
    }),
    getColumnsSampledData: hoisted.mockGetColumnsSampledData,
    getAllColumnStats: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('@/lib/rnaseq/sampleMatchUtils', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/rnaseq/sampleMatchUtils')>()
  return {
    ...actual,
    getCountSampleIdsWithData: hoisted.mockGetCountSampleIdsWithData,
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockReturnValue(Promise.resolve(() => {})),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}))

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn(), message: vi.fn() },
}))

vi.mock('@/components/rnaseq/RNAseqTabBar', () => ({
  RNAseqTabBar: ({ activeTab }: { activeTab: string; onTabChange: (t: string) => void; hasCountsData: boolean; hasMetadataData: boolean; hasResults: boolean; isLocked: boolean }) => (
    <div data-testid="tab-bar" data-active-tab={activeTab} />
  ),
}))

vi.mock('@/components/rnaseq/RNAseqDataImportDialog', () => ({
  RNAseqDataImportDialog: () => null,
}))

vi.mock('@/components/rnaseq/DESeq2ConfigDialog', () => ({
  DESeq2ConfigDialog: ({ open }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string; onSaveBatch: (m: unknown[]) => void }) => (
    open ? <div data-testid="deseq2-config-dialog" /> : null
  ),
}))

vi.mock('@/components/rnaseq/DESeq2ResultsTable', () => ({
  DESeq2ResultsTable: () => null,
}))

vi.mock('@/components/rnaseq/RNAseqPlotPanel', () => ({
  RNAseqPlotPanel: () => null,
}))

vi.mock('@/components/data/SpreadsheetView', () => ({
  SpreadsheetView: () => <div data-testid="spreadsheet-view" />,
}))

vi.mock('@/components/rnaseq/runAnalysisBatchWithLock', () => ({
  runAnalysisBatchWithLock: vi.fn(),
}))

vi.mock('@/lib/errors/errorToast', () => ({ showAppErrorToast: vi.fn() }))
vi.mock('@/lib/errors/tauriErrorAdapter', () => ({
  extractAppError: vi.fn(),
  extractErrorMessage: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RNAseqWorkspace configure-button preflight (sample match)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.mockResetCountsDatasetToBlank.mockResolvedValue(undefined)
    hoisted.mockResetMetadataDatasetToBlank.mockResolvedValue(undefined)
    // Default: return S1/S2/S3 from the helper (real extraction is tested in sampleMatchUtils.test.ts)
    hoisted.mockGetCountSampleIdsWithData.mockResolvedValue(['S1', 'S2', 'S3'])
    // Keep cacheService mock for other paths that still need it
    hoisted.mockGetColumnsSampledData.mockResolvedValue({
      s1: [10, 20, 30],
      s2: [5, 15, 25],
      s3: [1, 2, 3],
    })
  })

  // -------------------------------------------------------------------------
  // T_CP1: Mismatch exists → confirm prompt fires (non-hard-fail)
  // -------------------------------------------------------------------------
  it('T_CP1: Configure click with sample mismatch triggers confirm prompt', async () => {
    hoisted.mockValidateSampleMatch.mockResolvedValue({ sampleMatch: errorSampleMatch })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()

    render(<RNAseqWorkspace />)

    const configureBtn = screen.getByRole('button', { name: /configure/i })
    await user.click(configureBtn)

    await waitFor(() => expect(hoisted.mockValidateSampleMatch).toHaveBeenCalledTimes(1))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // T_CP2: Mismatch + user cancels → config dialog does NOT open
  // -------------------------------------------------------------------------
  it('T_CP2: Configure click, user cancels mismatch confirm → dialog does not open', async () => {
    hoisted.mockValidateSampleMatch.mockResolvedValue({ sampleMatch: errorSampleMatch })
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()

    render(<RNAseqWorkspace />)

    const configureBtn = screen.getByRole('button', { name: /configure/i })
    await user.click(configureBtn)

    await waitFor(() => expect(hoisted.mockValidateSampleMatch).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('deseq2-config-dialog')).not.toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // T_CP3: No mismatch → config dialog opens without any confirm prompt
  // -------------------------------------------------------------------------
  it('T_CP3: Configure click with matching samples opens config dialog without prompt', async () => {
    hoisted.mockValidateSampleMatch.mockResolvedValue({ sampleMatch: okSampleMatch })
    const confirmSpy = vi.spyOn(window, 'confirm')
    const user = userEvent.setup()

    render(<RNAseqWorkspace />)

    const configureBtn = screen.getByRole('button', { name: /configure/i })
    await user.click(configureBtn)

    await waitFor(() =>
      expect(screen.getByTestId('deseq2-config-dialog')).toBeInTheDocument()
    )
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // T_CP4: Mismatch + user confirms → config dialog opens
  // -------------------------------------------------------------------------
  it('T_CP4: Configure click, user confirms mismatch → config dialog opens', async () => {
    hoisted.mockValidateSampleMatch.mockResolvedValue({ sampleMatch: errorSampleMatch })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()

    render(<RNAseqWorkspace />)

    const configureBtn = screen.getByRole('button', { name: /configure/i })
    await user.click(configureBtn)

    await waitFor(() =>
      expect(screen.getByTestId('deseq2-config-dialog')).toBeInTheDocument()
    )
  })

  // -------------------------------------------------------------------------
  // T_CP5: Preflight passes countSampleIds (filtered from counts columns) to
  //        validateSampleMatch, so the backend never falls back to all column
  //        headers (which would include padded placeholder columns).
  // -------------------------------------------------------------------------
  it('T_CP5: Configure preflight passes exact filtered countSampleIds to validateSampleMatch', async () => {
    hoisted.mockValidateSampleMatch.mockResolvedValue({ sampleMatch: okSampleMatch })
    hoisted.mockGetCountSampleIdsWithData.mockResolvedValue(['S1', 'S2', 'S3'])
    const user = userEvent.setup()

    render(<RNAseqWorkspace />)

    const configureBtn = screen.getByRole('button', { name: /configure/i })
    await user.click(configureBtn)

    await waitFor(() => expect(hoisted.mockValidateSampleMatch).toHaveBeenCalledTimes(1))

    // Third argument must include the exact filtered sample IDs — not raw column headers
    const call = hoisted.mockValidateSampleMatch.mock.calls[0]!
    expect(call).toHaveLength(3)
    const options = call[2] as { countSampleIds?: string[] }
    expect(options.countSampleIds).toEqual(['S1', 'S2', 'S3'])
    expect(options.countSampleIds).not.toContain('Column 4')
    expect(options.countSampleIds).not.toContain('Gene')
  })

  // -------------------------------------------------------------------------
  // T_CP6: getCountSampleIdsWithData throws → config dialog still opens
  //        Locks non-blocking preflight: extraction errors must not silently
  //        swallow Configure — they must be caught and logged.
  // -------------------------------------------------------------------------
  it('T_CP6: getCountSampleIdsWithData throws → config dialog still opens and console.warn fired', async () => {
    hoisted.mockGetCountSampleIdsWithData.mockRejectedValue(new Error('cache unavailable'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const user = userEvent.setup()

    render(<RNAseqWorkspace />)

    const configureBtn = screen.getByRole('button', { name: /configure/i })
    await user.click(configureBtn)

    await waitFor(() => expect(screen.getByTestId('deseq2-config-dialog')).toBeInTheDocument())
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })
})
