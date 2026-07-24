import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => {
  const currentDataset = {
    id: 'dataset-1',
    rowCount: 10,
    dataRowCount: 4,
    columnCount: 2,
    columns: [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Column 2', type: 'text', width: 88 },
    ],
  }

  return {
    currentDataset,
    mockFlushPendingUpdates: vi.fn().mockResolvedValue(undefined),
    mockGetRowsHybrid: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('@/services/projectService', () => ({ loadProjectFromPath: vi.fn() }))
vi.mock('@/store/app-store', () => ({
  useAppStore: {
    getState: () => ({
      families: [],
      setProjectFilePath: vi.fn(),
      setProjectDirty: vi.fn(),
      setProjectId: vi.fn(),
      setWorkspaceViewMode: vi.fn(),
      restoreFamilies: vi.fn(),
    }),
  },
  ensureProjectId: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/store/analysis-store', () => ({
  useAnalysisStore: { getState: () => ({ clearHistory: vi.fn() }) },
}))
vi.mock('@/store/data-store', () => ({
  useDataStore: {
    getState: () => ({
      clearAllDatasets: vi.fn(),
      datasets: [hoisted.currentDataset],
      currentDataset: hoisted.currentDataset,
      addDataset: vi.fn(),
      gridSelection: {
        selectedRows: [],
        selectedColumns: [],
        allRowsSelected: false,
        allColumnsSelected: false,
      },
    }),
  },
}))
vi.mock('@/store/plots-store', () => ({
  usePlotsStore: { getState: () => ({ clearPlots: vi.fn() }) },
}))
vi.mock('@/store/results-store', () => ({
  useResultsStore: { getState: () => ({ clearAllResults: vi.fn() }) },
}))
vi.mock('@/store/rnaseq-store', () => ({
  useRNAseqStore: {
    getState: () => ({
      clearAllProjects: vi.fn().mockResolvedValue(undefined),
      projects: [],
      createProjectWithBootstrap: vi.fn().mockResolvedValue({ id: 'p1' }),
      setActivePlot: vi.fn(),
      setActiveTab: vi.fn(),
      replaceCountsDataset: vi.fn().mockResolvedValue(undefined),
      replaceMetadataDataset: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))
vi.mock('@/store/ui-store', () => ({
  useUIStore: { getState: () => ({ setPreferencesOpen: vi.fn() }) },
}))
vi.mock('@/services/tauriApi', () => ({ default: { resolveSampleDatasetPath: vi.fn(), importCsv: vi.fn() } }))
vi.mock('@/services/exportService', () => ({ default: { exportDataToCsv: vi.fn() } }))
vi.mock('@/services/rnaseqService', () => ({ default: { runDESeq2Analysis: vi.fn() } }))
vi.mock('@/services/cacheService', () => ({
  default: {
    flushPendingUpdates: hoisted.mockFlushPendingUpdates,
    getRowsHybrid: hoisted.mockGetRowsHybrid,
    getPersistedColumnIds: vi.fn().mockResolvedValue([]),
  },
}))
vi.mock('@/services/undoService', () => ({
  default: {
    undo: vi.fn().mockResolvedValue(null),
    redo: vi.fn().mockResolvedValue(null),
  },
}))
vi.mock('@/services/plotExportService', () => ({ exportPlotWithKaleido: vi.fn() }))
vi.mock('@/utils/plotExportUtils', () => ({
  applyAxisDefaultsForExport: vi.fn((x) => x),
  shouldIncludeAxisOverlay: vi.fn(() => false),
}))
vi.mock('@/utils/e2eAuthHooks', () => ({
  clearDeviceAuthState: vi.fn(),
  getDeviceAuthSnapshot: vi.fn(() => ({})),
  setFirstLaunchState: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(false),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@tauri-apps/api/path', () => ({ dirname: vi.fn().mockResolvedValue('/') }))

beforeAll(async () => {
  vi.stubEnv('VITE_E2E_ENABLED', 'true')
  await import('@/utils/e2e-shim')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('e2e-shim grid visible cell contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as Window & { __E2E_GRID_BRIDGE__?: Record<string, unknown> }).__E2E_GRID_BRIDGE__ = {
      'dataset-1': {
        copyRangeAsTsv: vi.fn(),
        executePasteAt: vi.fn(),
        selectCell: vi.fn(),
        scrollToCell: vi.fn(),
        focusSurface: vi.fn(),
        getActiveCell: vi.fn(),
        getEditSession: vi.fn(),
        getCopyContext: vi.fn(),
        seedCopyContext: vi.fn(),
        selectAll: vi.fn(),
        undo: vi.fn(),
        redo: vi.fn(),
        getVisibleCell: vi.fn().mockResolvedValue({
          datasetId: 'dataset-1',
          rowIndex: 2,
          columnId: 'col-2',
          columnIndex: 1,
          value: 'live-value',
          hasRow: true,
        }),
      },
    }
  })

  it('delegates getGridVisibleCell to the live grid bridge without backend reads', async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const snapshot = await window.__E2E__!.getGridVisibleCell({
      datasetId: 'dataset-1',
      rowIndex: 2,
      columnIndex: 1,
    })

    expect(snapshot).toEqual({
      datasetId: 'dataset-1',
      rowIndex: 2,
      columnId: 'col-2',
      columnIndex: 1,
      value: 'live-value',
      hasRow: true,
    })
    expect(hoisted.mockFlushPendingUpdates).not.toHaveBeenCalled()
    expect(hoisted.mockGetRowsHybrid).not.toHaveBeenCalled()
  })
})
