/**
 * ActionToolbar.filter.test.tsx
 *
 * TDD tests for the Filter button added to ActionToolbar in Phase 1.
 * Written RED-first — tests fail until onFilter prop and button are added.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ActionToolbar } from '../ActionToolbar'

// ---------------------------------------------------------------------------
// Store mocks — default: dataset loaded
// ---------------------------------------------------------------------------

// dataStore mock is mutable so individual tests can override currentDataset
const dataStoreMock = vi.hoisted(() => ({
  currentDataset: { id: 'ds-1', rowCount: 10, columns: [] } as object | null,
}))

// ActionToolbar reads useDataStore / useAnalysisStore / useAppStore / usePlotsStore internally.
// Mock the stores so the toolbar renders without a real provider tree.
vi.mock('@/store/data-store', () => ({
  useDataStore: () => ({ currentDataset: dataStoreMock.currentDataset }),
}))
vi.mock('@/store/analysis-store', () => ({
  useAnalysisStore: () => ({ execution: { status: 'idle' } }),
}))
vi.mock('@/store/app-store', () => ({
  useAppStore: () => ({
    setStatusMessage: vi.fn(),
    togglePlotSidebar: vi.fn(),
    showPlotSidebar: false,
    setPlotSidebarTab: vi.fn(),
    setShowPlotSidebar: vi.fn(),
    activeFamilyId: null,
    plotSettingsAttentionByFamily: {},
    projectDirty: false,
    saveProject: vi.fn(),
  }),
}))
vi.mock('@/store/results-store', () => ({
  useResultsStore: (sel: any) => sel({ results: [] }),
}))
vi.mock('@/store/plots-store', () => ({
  usePlotsStore: (sel: any) => sel({ plots: [], activePlotId: null }),
}))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActionToolbar — Filter button', () => {
  it('TOOLBAR_FILTER_BTN: renders a Filter button in data view mode', () => {
    render(<ActionToolbar workspaceViewMode="data" onFilter={vi.fn()} />)
    expect(screen.getByRole('button', { name: /filter/i })).toBeInTheDocument()
  })

  it('TOOLBAR_FILTER_CALLS: clicking Filter button calls onFilter once', async () => {
    const onFilter = vi.fn()
    render(<ActionToolbar workspaceViewMode="data" onFilter={onFilter} />)
    await userEvent.click(screen.getByRole('button', { name: /filter/i }))
    expect(onFilter).toHaveBeenCalledTimes(1)
  })

  it('TOOLBAR_FILTER_ENABLED: Filter button is enabled when dataset is loaded', () => {
    render(<ActionToolbar workspaceViewMode="data" onFilter={vi.fn()} />)
    expect(screen.getByRole('button', { name: /filter/i })).not.toBeDisabled()
  })
})

describe('ActionToolbar — Filter button absent when prop not passed', () => {
  it('TOOLBAR_FILTER_HIDDEN: Filter button is not rendered when onFilter prop is absent', () => {
    render(<ActionToolbar workspaceViewMode="data" />)
    expect(screen.queryByRole('button', { name: /filter/i })).not.toBeInTheDocument()
  })
})

describe('ActionToolbar — Sort button', () => {
  it('TOOLBAR_SORT_BTN: renders a Sort button in data view mode', () => {
    render(<ActionToolbar workspaceViewMode="data" onSort={vi.fn()} />)
    expect(screen.getByRole('button', { name: /^sort$/i })).toBeInTheDocument()
  })

  it('TOOLBAR_SORT_CALLS: clicking Sort button calls onSort once', async () => {
    const onSort = vi.fn()
    render(<ActionToolbar workspaceViewMode="data" onSort={onSort} />)
    await userEvent.click(screen.getByRole('button', { name: /^sort$/i }))
    expect(onSort).toHaveBeenCalledTimes(1)
  })

  it('TOOLBAR_OUTLINE_REPLACED: Outline button is not rendered in ActionToolbar', () => {
    render(<ActionToolbar workspaceViewMode="data" onSort={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /outline/i })).not.toBeInTheDocument()
  })
})

describe('ActionToolbar — undo and redo actions', () => {
  it('TOOLBAR_REDO_BTN: renders a Redo button in data view mode', () => {
    render(<ActionToolbar workspaceViewMode="data" onRedo={vi.fn()} />)
    expect(screen.getByTestId('toolbar-redo')).toBeInTheDocument()
  })

  it('TOOLBAR_REDO_CALLS: clicking Redo button calls onRedo once', async () => {
    const onRedo = vi.fn()
    render(<ActionToolbar workspaceViewMode="data" onRedo={onRedo} />)
    await userEvent.click(screen.getByTestId('toolbar-redo'))
    expect(onRedo).toHaveBeenCalledTimes(1)
  })
})

describe('ActionToolbar — Filter button disabled when no dataset', () => {
  beforeEach(() => {
    dataStoreMock.currentDataset = null
  })

  afterEach(() => {
    dataStoreMock.currentDataset = { id: 'ds-1', rowCount: 10, columns: [] }
  })

  it('TOOLBAR_FILTER_DISABLED: Filter button is disabled when no dataset is loaded', () => {
    render(<ActionToolbar workspaceViewMode="data" onFilter={vi.fn()} />)
    expect(screen.getByRole('button', { name: /^filter$/i })).toBeDisabled()
  })
})

describe('ActionToolbar — Filter button passes bounds on click', () => {
  it('TOOLBAR_FILTER_BOUNDS: clicking Filter calls onFilter with {x,y,width,height} shape', async () => {
    const onFilter = vi.fn()
    render(<ActionToolbar workspaceViewMode="data" onFilter={onFilter} />)
    await userEvent.click(screen.getByRole('button', { name: /filter/i }))
    expect(onFilter).toHaveBeenCalledTimes(1)
    const [bounds] = onFilter.mock.calls[0]!
    expect(bounds).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    })
  })
})

describe('ActionToolbar — blank scaffold row-data gating', () => {
  it('TOOLBAR_BLANK_SCAFFOLD_GATES_DATA_TOOLS: disables data tools but keeps Insert available', async () => {
    const onPerformTest = vi.fn()
    const onSort = vi.fn()
    const onFilter = vi.fn()
    const onInsertMenu = vi.fn()

    render(
      <ActionToolbar
        workspaceViewMode="data"
        hasDataRows={false}
        onPerformTest={onPerformTest}
        onSort={onSort}
        onFilter={onFilter}
        onInsertMenu={onInsertMenu}
      />
    )

    expect(screen.getByRole('button', { name: /perform test/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^sort$/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /filter/i })).toBeDisabled()

    const insertButton = screen.getByRole('button', { name: /insert/i })
    expect(insertButton).not.toBeDisabled()
    await userEvent.click(insertButton)
    expect(onInsertMenu).toHaveBeenCalledTimes(1)
  })
})
