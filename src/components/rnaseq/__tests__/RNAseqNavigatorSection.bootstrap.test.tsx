/**
 * RNAseqNavigatorSection bootstrap + lifecycle tests
 *
 * Tests behavioral contracts for:
 * - handleCreateProject uses createProjectWithBootstrap (not shell createProject)
 * - handleDeleteProject defers all cleanup to store.deleteProject (no direct removeDataset)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { RNAseqNavigatorSection } from '@/components/rnaseq/RNAseqNavigatorSection'

// ---------------------------------------------------------------------------
// Hoisted stable mock instances
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => {
  const mockCreateProject = vi.fn()
  const mockCreateProjectWithBootstrap = vi.fn()
  const mockDeleteProject = vi.fn()
  const mockSetActiveProject = vi.fn()
  const mockSetActiveTab = vi.fn()
  const mockRemoveDataset = vi.fn()
  const mockCacheRemoveDataset = vi.fn()
  const mockUseRNAseqProjects = vi.fn()

  // Mutable datasets list — controls what useDataStore returns per test
  const mockSharedState = {
    datasets: [] as Array<{ id: string; dataRowCount?: number; rowCount?: number }>,
  }

  return {
    mockCreateProject,
    mockCreateProjectWithBootstrap,
    mockDeleteProject,
    mockSetActiveProject,
    mockSetActiveTab,
    mockRemoveDataset,
    mockCacheRemoveDataset,
    mockUseRNAseqProjects,
    mockSharedState,
  }
})

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/store/rnaseq-store', () => {
  const state = {
    activeProjectId: null as string | null,
    createProject: hoisted.mockCreateProject,
    createProjectWithBootstrap: hoisted.mockCreateProjectWithBootstrap,
    deleteProject: hoisted.mockDeleteProject,
    setActiveProject: hoisted.mockSetActiveProject,
    setActiveTab: hoisted.mockSetActiveTab,
  }
  const useRNAseqStore = (selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state
  useRNAseqStore.getState = () => state
  return {
    useRNAseqStore,
    useRNAseqProjects: hoisted.mockUseRNAseqProjects,
  }
})

vi.mock('@/store/data-store', () => {
  const useDataStore = (selector?: (s: unknown) => unknown) => {
    const state = {
      removeDataset: hoisted.mockRemoveDataset,
      datasets: hoisted.mockSharedState.datasets,
    }
    return selector ? selector(state) : state
  }
  useDataStore.getState = () => ({
    removeDataset: hoisted.mockRemoveDataset,
    datasets: hoisted.mockSharedState.datasets,
  })
  return { useDataStore }
})

vi.mock('@/store/app-store', () => ({
  useAppStore: (selector?: (s: unknown) => unknown) => {
    const state = { families: [] }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/services/cacheService', () => ({
  default: { removeDataset: hoisted.mockCacheRemoveDataset },
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}))

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RNAseqNavigatorSection bootstrap lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.mockUseRNAseqProjects.mockReturnValue([])
    hoisted.mockCreateProject.mockReturnValue({ id: 'shell-project-id' })
    hoisted.mockCreateProjectWithBootstrap.mockResolvedValue({ id: 'bootstrap-project-id' })
    hoisted.mockDeleteProject.mockResolvedValue(undefined)
    hoisted.mockSharedState.datasets = []
  })

  // -------------------------------------------------------------------------
  // T1: "New Project" button must call createProjectWithBootstrap, not createProject
  // -------------------------------------------------------------------------
  it('T1: "New Project" button calls createProjectWithBootstrap, not createProject', async () => {
    const user = userEvent.setup()
    render(<RNAseqNavigatorSection />)

    const newBtn = screen.getByTitle('New RNA-seq Project')
    // userEvent.click wraps all events + async state updates in act, eliminating act() warnings
    await user.click(newBtn)

    expect(hoisted.mockCreateProjectWithBootstrap).toHaveBeenCalledTimes(1)
    expect(hoisted.mockCreateProject).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // T2: handleDeleteProject must NOT directly call removeDataset or cacheService.removeDataset
  //     All cleanup must be delegated to store.deleteProject
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // T3: Bootstrap failure must surface via toast.error — not silently swallowed
  //     (contracts that all create paths are awaited, not fire-and-forget)
  // -------------------------------------------------------------------------
  it('T3: createProjectWithBootstrap rejection surfaces toast.error — not swallowed', async () => {
    hoisted.mockCreateProjectWithBootstrap.mockRejectedValueOnce(new Error('DuckDB unavailable'))

    const user = userEvent.setup()
    render(<RNAseqNavigatorSection />)

    const newBtn = screen.getByTitle('New RNA-seq Project')
    // userEvent.click wraps all async state updates in act — no act() warning
    await user.click(newBtn)

    // Error must be surfaced via toast.error
    const { toast } = await import('sonner')
    expect(toast.error).toHaveBeenCalledWith('Failed to create RNA-seq project')
    // createProject (shell) must never be called as a fallback
    expect(hoisted.mockCreateProject).not.toHaveBeenCalled()
  })

  it('T2: handleDeleteProject does NOT call removeDataset directly — delegates to store only', async () => {
    const project = {
      id: 'proj-1',
      name: 'Test Project',
      countsDatasetId: 'counts-ds',
      metadataDatasetId: 'meta-ds',
      results: [],
      models: [],
      activeTab: 'counts' as const,
      activeModelId: null,
      activeResultId: null,
      activePlotType: null,
      createdAt: new Date(),
      modifiedAt: new Date(),
    }
    hoisted.mockUseRNAseqProjects.mockReturnValue([project])

    render(<RNAseqNavigatorSection />)

    // The delete X span is the LAST span[role=button] in the project row
    // (expand/collapse toggle comes first, delete button is last)
    const allRoleButtons = document.querySelectorAll('span[role="button"]')
    const deleteSpan = allRoleButtons[allRoleButtons.length - 1]
    expect(deleteSpan).toBeTruthy()

    fireEvent.click(deleteSpan as HTMLElement)

    await vi.waitFor(() => {
      expect(hoisted.mockDeleteProject).toHaveBeenCalledWith('proj-1')
    })

    // Critical: store.deleteProject handles cleanup internally — no direct calls in UI
    expect(hoisted.mockRemoveDataset).not.toHaveBeenCalled()
    expect(hoisted.mockCacheRemoveDataset).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 6.2 + 6.3: usable-row gating for status dots and delete confirmation
// ---------------------------------------------------------------------------

const makeProject = (overrides: Partial<{
  countsDatasetId: string | null
  metadataDatasetId: string | null
}> = {}) => ({
  id: 'proj-gate',
  name: 'Gate Project',
  countsDatasetId: 'counts-ds' as string | null,
  metadataDatasetId: 'meta-ds' as string | null,
  results: [],
  models: [],
  activeTab: 'counts' as const,
  activeModelId: null,
  activeResultId: null,
  activePlotType: null,
  createdAt: new Date(),
  modifiedAt: new Date(),
  ...overrides,
})

describe('RNAseqNavigatorSection usable-row gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.mockCreateProjectWithBootstrap.mockResolvedValue({ id: 'p' })
    hoisted.mockDeleteProject.mockResolvedValue(undefined)
    hoisted.mockSharedState.datasets = []
  })

  // -------------------------------------------------------------------------
  // T4: Status dot hidden when counts dataset is scaffold-only (dataRowCount=0)
  // -------------------------------------------------------------------------
  it('T4: counts status dot hidden when linked dataset has dataRowCount=0 (scaffold)', () => {
    hoisted.mockSharedState.datasets = [
      { id: 'counts-ds', dataRowCount: 0, rowCount: 100 },
      { id: 'meta-ds',   dataRowCount: 0, rowCount: 100 },
    ]
    hoisted.mockUseRNAseqProjects.mockReturnValue([makeProject()])

    render(<RNAseqNavigatorSection />)

    // The counts tab row dot has data-testid="counts-data-dot"
    expect(document.querySelector('[data-testid="counts-data-dot"]')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // T5: Status dot shown when counts dataset has real imported data (dataRowCount > 0)
  // -------------------------------------------------------------------------
  it('T5: counts status dot shown when linked dataset has dataRowCount > 0 (real data)', () => {
    hoisted.mockSharedState.datasets = [
      { id: 'counts-ds', dataRowCount: 50, rowCount: 150 },
      { id: 'meta-ds',   dataRowCount: 0,  rowCount: 100 },
    ]
    hoisted.mockUseRNAseqProjects.mockReturnValue([makeProject()])

    render(<RNAseqNavigatorSection />)

    expect(document.querySelector('[data-testid="counts-data-dot"]')).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // T6: Delete skips confirm dialog when both datasets are scaffold-only
  // -------------------------------------------------------------------------
  it('T6: delete skips confirm dialog when both datasets are scaffold-only (dataRowCount=0)', async () => {
    hoisted.mockSharedState.datasets = [
      { id: 'counts-ds', dataRowCount: 0, rowCount: 100 },
      { id: 'meta-ds',   dataRowCount: 0, rowCount: 100 },
    ]
    hoisted.mockUseRNAseqProjects.mockReturnValue([makeProject()])

    const { confirm } = await import('@tauri-apps/plugin-dialog')
    const user = userEvent.setup()
    render(<RNAseqNavigatorSection />)

    const allRoleButtons = document.querySelectorAll('span[role="button"]')
    await user.click(allRoleButtons[allRoleButtons.length - 1] as HTMLElement)

    // No confirm dialog — scaffold-only means no user data to warn about
    expect(confirm).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(hoisted.mockDeleteProject).toHaveBeenCalledWith('proj-gate')
    })
  })

  // -------------------------------------------------------------------------
  // T7: Delete shows confirm dialog when counts has real imported data
  // -------------------------------------------------------------------------
  it('T7: delete shows confirm dialog when counts dataset has real imported data', async () => {
    hoisted.mockSharedState.datasets = [
      { id: 'counts-ds', dataRowCount: 50, rowCount: 150 },
      { id: 'meta-ds',   dataRowCount: 0,  rowCount: 100 },
    ]
    hoisted.mockUseRNAseqProjects.mockReturnValue([makeProject()])

    const { confirm } = await import('@tauri-apps/plugin-dialog')
    ;(confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true)

    const user = userEvent.setup()
    render(<RNAseqNavigatorSection />)

    const allRoleButtons = document.querySelectorAll('span[role="button"]')
    await user.click(allRoleButtons[allRoleButtons.length - 1] as HTMLElement)

    expect(confirm).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(hoisted.mockDeleteProject).toHaveBeenCalledWith('proj-gate')
    })
  })

  // -------------------------------------------------------------------------
  // T8: Delete shows confirm when dataset ID exists but record is missing from store
  //     (strict-safe: treat missing as potentially real data — false positive ok)
  // -------------------------------------------------------------------------
  it('T8: delete shows confirm when linked dataset ID exists but record is missing from store', async () => {
    // datasets list is empty — project has IDs but records are not in store
    hoisted.mockSharedState.datasets = []
    hoisted.mockUseRNAseqProjects.mockReturnValue([makeProject()])

    const { confirm } = await import('@tauri-apps/plugin-dialog')
    ;(confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true)

    const user = userEvent.setup()
    render(<RNAseqNavigatorSection />)

    const allRoleButtons = document.querySelectorAll('span[role="button"]')
    await user.click(allRoleButtons[allRoleButtons.length - 1] as HTMLElement)

    // Must show confirm — cannot silently delete when dataset record is unresolvable
    expect(confirm).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(hoisted.mockDeleteProject).toHaveBeenCalledWith('proj-gate')
    })
  })

  // -------------------------------------------------------------------------
  // T9: Delete shows confirm when project has configured models (no runs yet)
  // -------------------------------------------------------------------------
  it('T9: delete shows confirm when project has configured models even with no results', async () => {
    hoisted.mockSharedState.datasets = [
      { id: 'counts-ds', dataRowCount: 0, rowCount: 100 },
      { id: 'meta-ds',   dataRowCount: 0, rowCount: 100 },
    ]
    const projectWithModels = {
      ...makeProject(),
      models: [{ id: 'model-1', name: 'Model 1' }],
    }
    hoisted.mockUseRNAseqProjects.mockReturnValue([projectWithModels])

    const { confirm } = await import('@tauri-apps/plugin-dialog')
    ;(confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true)

    const user = userEvent.setup()
    render(<RNAseqNavigatorSection />)

    const allRoleButtons = document.querySelectorAll('span[role="button"]')
    await user.click(allRoleButtons[allRoleButtons.length - 1] as HTMLElement)

    expect(confirm).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(hoisted.mockDeleteProject).toHaveBeenCalledWith('proj-gate')
    })
  })

  // -------------------------------------------------------------------------
  // T10: Metadata dot shown when metadata dataset has real data
  // -------------------------------------------------------------------------
  it('T10: metadata status dot shown when metadata dataset has dataRowCount > 0', () => {
    hoisted.mockSharedState.datasets = [
      { id: 'counts-ds', dataRowCount: 0,  rowCount: 100 },
      { id: 'meta-ds',   dataRowCount: 30, rowCount: 130 },
    ]
    hoisted.mockUseRNAseqProjects.mockReturnValue([makeProject()])

    render(<RNAseqNavigatorSection />)

    expect(document.querySelector('[data-testid="metadata-data-dot"]')).not.toBeNull()
    // counts dot absent (still scaffold)
    expect(document.querySelector('[data-testid="counts-data-dot"]')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // T11: Project-level dot shown when at least one slot has real data
  // -------------------------------------------------------------------------
  it('T11: project-level dot shown when at least one dataset slot has real data', () => {
    hoisted.mockSharedState.datasets = [
      { id: 'counts-ds', dataRowCount: 50, rowCount: 150 },
      { id: 'meta-ds',   dataRowCount: 0,  rowCount: 100 },
    ]
    hoisted.mockUseRNAseqProjects.mockReturnValue([makeProject()])

    render(<RNAseqNavigatorSection />)

    expect(document.querySelector('[data-testid="project-data-dot"]')).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // T12: Project-level dot hidden when both slots are scaffold-only
  // -------------------------------------------------------------------------
  it('T12: project-level dot hidden when both datasets are scaffold-only', () => {
    hoisted.mockSharedState.datasets = [
      { id: 'counts-ds', dataRowCount: 0, rowCount: 100 },
      { id: 'meta-ds',   dataRowCount: 0, rowCount: 100 },
    ]
    hoisted.mockUseRNAseqProjects.mockReturnValue([makeProject()])

    render(<RNAseqNavigatorSection />)

    expect(document.querySelector('[data-testid="project-data-dot"]')).toBeNull()
  })
})
