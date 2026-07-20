import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => {
  const oldDataset = {
    id: 'seeded-old',
    rowCount: 10,
    dataRowCount: 5,
    columnCount: 1,
    columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
  }

  const newDataset = {
    id: 'blank-new',
    rowCount: 100,
    dataRowCount: 0,
    columnCount: 1,
    columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
  }

  return {
    oldDataset,
    newDataset,
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
      datasets: [hoisted.oldDataset, hoisted.newDataset],
      currentDataset: hoisted.newDataset,
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

describe('e2e-shim rendered surface truth contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as Window & { __E2E_DISPLAY_DATASET_ID__?: string | null }).__E2E_DISPLAY_DATASET_ID__ =
      'seeded-old'
    ;(window as Window & { __E2E_GRID_BRIDGE__?: Record<string, unknown> }).__E2E_GRID_BRIDGE__ = {
      'seeded-old': {
        copyRangeAsTsv: vi.fn(),
        executePasteAt: vi.fn(),
        selectCell: vi.fn(),
        scrollToCell: vi.fn(),
        focusSurface: vi.fn(),
        getActiveCell: vi.fn(),
        getEditSession: vi.fn().mockResolvedValue({
          active: true,
          columnIndex: 0,
          rowIndex: 0,
          source: 'cell',
        }),
        getCopyContext: vi.fn(),
        seedCopyContext: vi.fn(),
        selectAll: vi.fn(),
        undo: vi.fn(),
        redo: vi.fn(),
        getVisibleCell: vi.fn().mockResolvedValue({
          datasetId: 'seeded-old',
          rowIndex: 0,
          columnId: 'col-1',
          columnIndex: 0,
          value: 'hello',
          hasRow: true,
        }),
      },
      'blank-new': {
        copyRangeAsTsv: vi.fn(),
        executePasteAt: vi.fn(),
        selectCell: vi.fn(),
        scrollToCell: vi.fn(),
        focusSurface: vi.fn(),
        getActiveCell: vi.fn(),
        getEditSession: vi.fn().mockResolvedValue(null),
        getCopyContext: vi.fn(),
        seedCopyContext: vi.fn(),
        selectAll: vi.fn(),
        undo: vi.fn(),
        redo: vi.fn(),
        getVisibleCell: vi.fn().mockResolvedValue({
          datasetId: 'blank-new',
          rowIndex: 0,
          columnId: 'col-1',
          columnIndex: 0,
          value: '',
          hasRow: true,
        }),
      },
    }
  })

  it('prefers the displayed dataset over logical currentDataset when resolving grid shape and visible cells', async () => {
    const shape = window.__E2E__!.getGridShape()
    expect(shape).toEqual({
      datasetId: 'seeded-old',
      rowCount: 10,
      dataRowCount: 5,
      columnCount: 1,
      columns: [
        {
          id: 'col-1',
          name: 'Column 1',
          type: 'text',
          width: 88,
        },
      ],
    })

    const visible = await window.__E2E__!.getGridVisibleCell({
      rowIndex: 0,
      columnIndex: 0,
    })

    expect(visible).toEqual({
      datasetId: 'seeded-old',
      rowIndex: 0,
      columnId: 'col-1',
      columnIndex: 0,
      value: 'hello',
      hasRow: true,
    })
    expect(hoisted.mockFlushPendingUpdates).not.toHaveBeenCalled()
    expect(hoisted.mockGetRowsHybrid).not.toHaveBeenCalled()
    })
  })

  it('reads the edit session from the rendered grid bridge', async () => {
    const editSession = await (window.__E2E__ as any).getGridEditSession()

    expect(editSession).toEqual({
      active: true,
      columnIndex: 0,
      rowIndex: 0,
      source: 'cell',
    })
  })
