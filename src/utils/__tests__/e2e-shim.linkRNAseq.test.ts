/**
 * E2E shim linkRNAseqDatasets lifecycle contract
 *
 * Verifies that linkRNAseqDatasets uses replaceCountsDataset / replaceMetadataDataset
 * (lifecycle-safe, reference-aware) instead of the low-level setCountsDataset /
 * setMetadataDataset setters which skip scaffold cleanup.
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mock instances — declared before any vi.mock calls
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => {
  const mockReplaceCountsDataset = vi.fn().mockResolvedValue(undefined)
  const mockReplaceMetadataDataset = vi.fn().mockResolvedValue(undefined)
  const mockSetCountsDataset = vi.fn()
  const mockSetMetadataDataset = vi.fn()
  const mockSetActiveProject = vi.fn()

  return {
    mockReplaceCountsDataset,
    mockReplaceMetadataDataset,
    mockSetCountsDataset,
    mockSetMetadataDataset,
    mockSetActiveProject,
  }
})

// ---------------------------------------------------------------------------
// Module mocks — only shim dependencies needed for linkRNAseqDatasets
// ---------------------------------------------------------------------------

vi.mock('@/store/rnaseq-store', () => ({
  useRNAseqStore: {
    getState: () => ({
      replaceCountsDataset: hoisted.mockReplaceCountsDataset,
      replaceMetadataDataset: hoisted.mockReplaceMetadataDataset,
      setCountsDataset: hoisted.mockSetCountsDataset,
      setMetadataDataset: hoisted.mockSetMetadataDataset,
      setActiveProject: hoisted.mockSetActiveProject,
      projects: [],
      createProjectWithBootstrap: vi.fn().mockResolvedValue({ id: 'p1' }),
      setActivePlot: vi.fn(),
      setActiveTab: vi.fn(),
    }),
  },
}))

// Stub all other shim imports so they don't throw
vi.mock('@/services/projectService', () => ({ loadProjectFromPath: vi.fn() }))
vi.mock('@/store/app-store', () => ({
  useAppStore: { getState: () => ({ families: [], setProjectFilePath: vi.fn(), setProjectDirty: vi.fn(), setProjectId: vi.fn() }) },
  ensureProjectId: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/store/analysis-store', () => ({
  useAnalysisStore: { getState: () => ({ clearHistory: vi.fn() }) },
}))
vi.mock('@/store/data-store', () => ({
  useDataStore: { getState: () => ({ clearAllDatasets: vi.fn(), datasets: [], addDataset: vi.fn() }) },
}))
vi.mock('@/store/plots-store', () => ({
  usePlotsStore: { getState: () => ({ clearPlots: vi.fn() }) },
}))
vi.mock('@/store/results-store', () => ({
  useResultsStore: { getState: () => ({ clearAllResults: vi.fn() }) },
}))
vi.mock('@/store/ui-store', () => ({
  useUIStore: { getState: () => ({}) },
}))
vi.mock('@/services/tauriApi', () => ({ default: { resolveSampleDatasetPath: vi.fn(), importCsv: vi.fn() } }))
vi.mock('@/services/exportService', () => ({ default: { exportDataToCsv: vi.fn() } }))
vi.mock('@/services/rnaseqService', () => ({ default: { runDESeq2Analysis: vi.fn() } }))
vi.mock('@/services/plotExportService', () => ({ exportPlotWithKaleido: vi.fn() }))
vi.mock('@/utils/plotExportUtils', () => ({
  applyAxisDefaultsForExport: vi.fn(x => x),
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

// ---------------------------------------------------------------------------
// Load the shim with E2E mode enabled (dynamic import after env stub)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Must stub env BEFORE dynamic import so e2eEnabled evaluates to true
  vi.stubEnv('VITE_E2E_ENABLED', 'true')
  await import('@/utils/e2e-shim')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e-shim linkRNAseqDatasets lifecycle contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.mockReplaceCountsDataset.mockResolvedValue(undefined)
    hoisted.mockReplaceMetadataDataset.mockResolvedValue(undefined)
  })

  it('T_shim_1: linkRNAseqDatasets calls replaceCountsDataset and replaceMetadataDataset', async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await window.__E2E__!.linkRNAseqDatasets({
      projectId: 'proj-1',
      countsDatasetId: 'new-counts',
      metadataDatasetId: 'new-meta',
    })

    expect(hoisted.mockReplaceCountsDataset).toHaveBeenCalledWith('proj-1', 'new-counts')
    expect(hoisted.mockReplaceMetadataDataset).toHaveBeenCalledWith('proj-1', 'new-meta')
  })

  it('T_shim_2: linkRNAseqDatasets does NOT call setCountsDataset or setMetadataDataset', async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await window.__E2E__!.linkRNAseqDatasets({
      projectId: 'proj-1',
      countsDatasetId: 'new-counts',
      metadataDatasetId: 'new-meta',
    })

    expect(hoisted.mockSetCountsDataset).not.toHaveBeenCalled()
    expect(hoisted.mockSetMetadataDataset).not.toHaveBeenCalled()
  })
})
