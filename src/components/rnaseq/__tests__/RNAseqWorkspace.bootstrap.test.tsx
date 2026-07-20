/**
 * RNAseqWorkspace clear path tests
 *
 * Tests that the Clear button uses the store's rebootstrap actions
 * (resetCountsDatasetToBlank / resetMetadataDatasetToBlank) instead of
 * directly nulling the slot and manually deleting the dataset.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { RNAseqWorkspace } from '@/components/rnaseq/RNAseqWorkspace'

// ---------------------------------------------------------------------------
// Hoisted stable mock instances
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => {
  const mockResetCountsDatasetToBlank = vi.fn()
  const mockResetMetadataDatasetToBlank = vi.fn()
  const mockSetCountsDataset = vi.fn()
  const mockSetMetadataDataset = vi.fn()
  const mockRemoveDataset = vi.fn()
  const mockCacheRemoveDataset = vi.fn()

  // Mutable state for per-test control
  const state = {
    activeTab: 'counts' as 'counts' | 'metadata' | 'results' | 'plots',
    countsDatasetId: 'counts-ds-1',
    metadataDatasetId: null as string | null,
  }

  return {
    mockResetCountsDatasetToBlank,
    mockResetMetadataDatasetToBlank,
    mockSetCountsDataset,
    mockSetMetadataDataset,
    mockRemoveDataset,
    mockCacheRemoveDataset,
    state,
  }
})

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockProject = {
  id: 'project-1',
  name: 'Test RNA-seq',
  countsDatasetId: 'counts-ds-1' as string | null,
  metadataDatasetId: null as string | null,
  models: [],
  results: [],
  activeTab: 'counts' as 'counts' | 'metadata' | 'results' | 'plots',
  activeModelId: null,
  activeResultId: null,
  activePlotType: null,
  createdAt: new Date(),
  modifiedAt: new Date(),
}

vi.mock('@/store/rnaseq-store', () => ({
  useActiveRNAseqProject: () => ({ ...mockProject, activeTab: hoisted.state.activeTab }),
  useRNAseqAnalysisStatus: () => ({ isRunning: false, progress: 0, stage: '' }),
  useRNAseqStore: (selector?: (s: unknown) => unknown) => {
    const storeState = {
      setActiveTab: vi.fn(),
      setActivePlot: vi.fn(),
      setActiveModel: vi.fn(),
      setActiveResult: vi.fn(),
      setAnalysisRunning: vi.fn(),
      setAnalysisProgress: vi.fn(),
      setResult: vi.fn(),
      clearResult: vi.fn(),
      getResult: vi.fn(),
      setCountsDataset: hoisted.mockSetCountsDataset,
      setMetadataDataset: hoisted.mockSetMetadataDataset,
      resetCountsDatasetToBlank: hoisted.mockResetCountsDatasetToBlank,
      resetMetadataDatasetToBlank: hoisted.mockResetMetadataDatasetToBlank,
      projects: [mockProject],
    }
    return selector ? selector(storeState) : storeState
  },
}))

vi.mock('@/store/data-store', () => ({
  useDataStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      datasets: [
        {
          id: 'counts-ds-1',
          name: 'Counts',
          rowCount: 100,
          columnCount: 100,
          dataRowCount: 0,        // blank scaffold
          columns: [],
          importedAt: new Date(),
          modifiedAt: new Date(),
        },
        {
          id: 'meta-ds-1',
          name: 'Metadata',
          rowCount: 100,
          columnCount: 100,
          dataRowCount: 0,        // blank scaffold
          columns: [],
          importedAt: new Date(),
          modifiedAt: new Date(),
        },
        {
          id: 'real-counts-ds',
          name: 'Real Counts',
          rowCount: 150,
          columnCount: 20,
          dataRowCount: 100,      // real imported data
          columns: [],
          importedAt: new Date(),
          modifiedAt: new Date(),
        },
        {
          id: 'real-meta-ds',
          name: 'Real Metadata',
          rowCount: 50,
          columnCount: 5,
          dataRowCount: 40,       // real imported data
          columns: [],
          importedAt: new Date(),
          modifiedAt: new Date(),
        },
      ],
      currentDataset: null,
      setCurrentDataset: vi.fn(),
      removeDataset: hoisted.mockRemoveDataset,
    }
    return selector ? selector(state) : state
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
  const useAppStore = (selector?: (s: unknown) => unknown) =>
    selector ? selector(appState) : appState
  useAppStore.getState = () => appState
  return { useAppStore }
})

vi.mock('@/services/cacheService', () => ({
  default: {
    removeDataset: hoisted.mockCacheRemoveDataset,
    getColumnDuplicateSummary: vi.fn().mockResolvedValue({ duplicateIdCount: 0, duplicateRowCount: 0, duplicateExamples: [], scanMode: 'backend_full' }),
    getColumnsSampledData: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@/services/rnaseqService', () => ({
  default: { runAnalysis: vi.fn() },
}))

vi.mock('@/services/exportService', () => ({
  default: {},
}))

vi.mock('@/services/tauriApi', () => ({
  default: {},
}))

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
  RNAseqTabBar: ({ activeTab, hasCountsData, hasMetadataData }: {
    activeTab: string
    onTabChange: (t: string) => void
    hasCountsData: boolean
    hasMetadataData: boolean
  }) => (
    <div
      data-testid="tab-bar"
      data-active-tab={activeTab}
      data-has-counts-data={String(hasCountsData)}
      data-has-metadata-data={String(hasMetadataData)}
    />
  ),
}))

vi.mock('@/components/rnaseq/RNAseqDataImportDialog', () => ({
  RNAseqDataImportDialog: () => null,
}))

vi.mock('@/components/rnaseq/DESeq2ConfigDialog', () => ({
  DESeq2ConfigDialog: () => null,
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

vi.mock('@/lib/errors/errorToast', () => ({
  showAppErrorToast: vi.fn(),
}))

vi.mock('@/lib/errors/tauriErrorAdapter', () => ({
  extractAppError: vi.fn(),
  extractErrorMessage: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RNAseqWorkspace clear path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.mockResetCountsDatasetToBlank.mockResolvedValue(undefined)
    hoisted.mockResetMetadataDatasetToBlank.mockResolvedValue(undefined)
    hoisted.state.activeTab = 'counts'
    mockProject.countsDatasetId = 'counts-ds-1'
    mockProject.metadataDatasetId = null
    mockProject.activeTab = 'counts'
  })

  it('T1: Clear button on counts tab calls resetCountsDatasetToBlank, not setCountsDataset(null)', async () => {
    render(<RNAseqWorkspace />)

    // Find the Clear button — it's rendered only when countsDataset exists and activeTab is counts/metadata
    const clearBtn = screen.getByRole('button', { name: /clear/i })
    fireEvent.click(clearBtn)

    await waitFor(() => {
      expect(hoisted.mockResetCountsDatasetToBlank).toHaveBeenCalledWith('project-1')
    })
    // Must NOT null the slot directly
    expect(hoisted.mockSetCountsDataset).not.toHaveBeenCalledWith('project-1', null)
    // Must NOT directly delete from data-store
    expect(hoisted.mockRemoveDataset).not.toHaveBeenCalled()
    expect(hoisted.mockCacheRemoveDataset).not.toHaveBeenCalled()
  })
})

describe('RNAseqWorkspace readiness gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.state.activeTab = 'counts'
  })

  it('T2: Configure disabled when both datasets are scaffold-only (dataRowCount=0)', () => {
    // Both counts and metadata datasets exist but have dataRowCount=0 (blank scaffolds)
    mockProject.countsDatasetId = 'counts-ds-1'   // exists in mock store with dataRowCount=0
    mockProject.metadataDatasetId = 'meta-ds-1'
    mockProject.activeTab = 'counts'

    render(<RNAseqWorkspace />)

    const configureBtn = screen.getByRole('button', { name: /configure/i })
    // Must be disabled — scaffold-only datasets do not constitute "ready" data
    expect(configureBtn).toBeDisabled()
  })

  it('T3: TabBar receives hasCountsData=false when countsDataset has dataRowCount=0', () => {
    mockProject.countsDatasetId = 'counts-ds-1'  // dataRowCount=0
    mockProject.metadataDatasetId = null
    mockProject.activeTab = 'counts'

    render(<RNAseqWorkspace />)

    // TabBar is mocked — check it received hasCountsData=false (scaffold → no real data)
    const tabBar = screen.getByTestId('tab-bar')
    // hasCountsData should be false since usableRows = dataRowCount ?? rowCount ?? 0 = 0
    expect(tabBar).toHaveAttribute('data-has-counts-data', 'false')
  })

  it('T4: Configure button enabled and TabBar hasCountsData=true when datasets have real imported data', () => {
    // Simulate a project after sample import or e2e linkRNAseqDatasets:
    // both dataset slots point to real datasets with dataRowCount > 0.
    // This is the expected state after createProjectWithBootstrap + replace*Dataset.
    mockProject.countsDatasetId = 'real-counts-ds'   // dataRowCount=100
    mockProject.metadataDatasetId = 'real-meta-ds'   // dataRowCount=40
    mockProject.activeTab = 'counts'

    render(<RNAseqWorkspace />)

    // Configure must be enabled — both slots have real data
    const configureBtn = screen.getByRole('button', { name: /configure/i })
    expect(configureBtn).not.toBeDisabled()

    // TabBar reflects real counts data
    const tabBar = screen.getByTestId('tab-bar')
    expect(tabBar).toHaveAttribute('data-has-counts-data', 'true')
    expect(tabBar).toHaveAttribute('data-has-metadata-data', 'true')
  })
})

// ---------------------------------------------------------------------------
// 6.7: Empty scaffold tabs — import prompt instead of blank grid
// ---------------------------------------------------------------------------

describe('RNAseqWorkspace empty scaffold state (6.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // T5: Counts scaffold shows import empty state when counts dataset exists but dataRowCount=0
  // -------------------------------------------------------------------------
  it('T5: counts scaffold shows import empty state and hides the grid', () => {
    mockProject.countsDatasetId = 'counts-ds-1'   // dataRowCount=0 (scaffold)
    mockProject.metadataDatasetId = null
    mockProject.activeTab = 'counts'
    hoisted.state.activeTab = 'counts'

    render(<RNAseqWorkspace />)

    expect(screen.getByText('No count matrix loaded')).toBeInTheDocument()
    expect(screen.getByText('Import a count matrix (CSV/TSV) with genes as rows and samples as columns.')).toBeInTheDocument()
    expect(screen.queryByTestId('spreadsheet-view')).not.toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // T6: Counts grid shown when counts dataset has real imported data
  // -------------------------------------------------------------------------
  it('T6: counts grid shown when counts dataset has real data', () => {
    mockProject.countsDatasetId = 'real-counts-ds'  // dataRowCount=100
    mockProject.metadataDatasetId = null
    mockProject.activeTab = 'counts'
    hoisted.state.activeTab = 'counts'

    render(<RNAseqWorkspace />)

    expect(screen.getByTestId('spreadsheet-view')).toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // T6b: Counts empty state shown when countsDatasetId is null (no dataset linked)
  // -------------------------------------------------------------------------
  it('T6b: counts empty state shown when countsDatasetId is null (no dataset linked)', () => {
    mockProject.countsDatasetId = null
    mockProject.metadataDatasetId = null
    mockProject.activeTab = 'counts'
    hoisted.state.activeTab = 'counts'

    render(<RNAseqWorkspace />)

    expect(screen.getByText('No count matrix loaded')).toBeInTheDocument()
    expect(screen.queryByTestId('spreadsheet-view')).not.toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // T7: Metadata scaffold shows import empty state on metadata tab
  // -------------------------------------------------------------------------
  it('T7: metadata scaffold shows import empty state and hides the grid', () => {
    mockProject.countsDatasetId = 'counts-ds-1'
    mockProject.metadataDatasetId = 'meta-ds-1'   // dataRowCount=0 (scaffold)
    mockProject.activeTab = 'metadata' as const
    hoisted.state.activeTab = 'metadata'

    render(<RNAseqWorkspace />)

    expect(screen.getByText('No metadata loaded')).toBeInTheDocument()
    expect(screen.getByText('Import sample metadata (CSV/TSV) with sample IDs and experimental factors.')).toBeInTheDocument()
    expect(screen.queryByTestId('spreadsheet-view')).not.toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // T8: Metadata grid shown when metadata has real imported data
  // -------------------------------------------------------------------------
  it('T8: metadata grid shown when metadata dataset has real data', () => {
    mockProject.countsDatasetId = 'counts-ds-1'
    mockProject.metadataDatasetId = 'real-meta-ds'  // dataRowCount=40
    mockProject.activeTab = 'metadata' as const
    hoisted.state.activeTab = 'metadata'

    render(<RNAseqWorkspace />)

    expect(screen.getByTestId('spreadsheet-view')).toBeInTheDocument()
  })

  it('T9: Sort and Outline are disabled for an empty active RNA-seq tab', () => {
    mockProject.countsDatasetId = 'counts-ds-1'
    mockProject.metadataDatasetId = 'meta-ds-1'
    mockProject.activeTab = 'counts'
    hoisted.state.activeTab = 'counts'

    render(<RNAseqWorkspace />)

    expect(screen.getByRole('button', { name: /outline/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^sort$/i })).toBeDisabled()
  })

  it('T10: Sort and Outline are enabled when the active RNA-seq tab has rows', () => {
    mockProject.countsDatasetId = 'real-counts-ds'
    mockProject.metadataDatasetId = 'real-meta-ds'
    mockProject.activeTab = 'counts'
    hoisted.state.activeTab = 'counts'

    render(<RNAseqWorkspace />)

    expect(screen.getByRole('button', { name: /outline/i })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /^sort$/i })).not.toBeDisabled()
  })
})
