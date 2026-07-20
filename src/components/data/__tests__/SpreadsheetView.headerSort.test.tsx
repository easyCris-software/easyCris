/**
 * SpreadsheetView header sort UX — mounted regression tests (Phase 2).
 *
 * Verifies:
 * 1. Single click → column selection only; sort is explicit through toolbar/menu
 * 2. Double-click on header body → rename dialog opened; sort NOT mutated
 * 3. Sort indicator (↑/↓) appears on sorted column; absent after clear
 * 4. Double-click on column edge triggers auto-fit, NOT rename
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@/test/test-utils'
import SpreadsheetView from '../SpreadsheetView'
import * as viewStateCacheModule from '@/lib/grid/viewStateCache'
import { computeSchemaKey } from '@/lib/grid/viewStateSchema'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const harness = vi.hoisted(() => ({
  latestDataEditorProps: null as any,
  executeEdits: vi.fn().mockResolvedValue(undefined),
  executeSingleEdit: vi.fn().mockResolvedValue(undefined),
}))

const dataStoreHarness = vi.hoisted(() => {
  const dataset = {
    id: 'dataset-1',
    name: 'dataset-1',
    rowCount: 2,
    dataRowCount: 2,
    columns: [
      { id: 'col-0', name: 'Column 1', type: 'numeric' },
      { id: 'col-1', name: 'Column 2', type: 'categorical' },
    ],
  } as any

  const dataStoreState = {
    currentDataset: dataset,
    datasets: [dataset],
    loadingOperation: null,
    setLoadingOperation: vi.fn(),
    setSelectedRows: vi.fn(),
    setSelectedColumns: vi.fn(),
    setSelectionStats: vi.fn(),
    updateViewport: vi.fn(),
    updateCellValue: vi.fn(),
    updateDataset: vi.fn(),
    invalidateColumns: vi.fn(),
    allocateNextAutoColumnName: vi.fn(),
    rollbackAutoColumnNameAllocation: vi.fn(),
    insertColumnAtDataset: vi.fn(),
    insertRowAtDataset: vi.fn(),
    removeColumnAtDataset: vi.fn(),
    removeRowAtDataset: vi.fn(),
    setHighlightsBatch: vi.fn(),
    removeHighlightsBatch: vi.fn(),
  }

  const dataStoreGetState = {
    datasets: [dataset],
    currentDataset: dataset,
    getDatasetFormulas: vi.fn(() => new Map()),
    setDatasetFormulas: vi.fn(),
    updateDataset: vi.fn(),
  }

  const useDataStore = vi.fn(() => dataStoreState)
  ;(useDataStore as any).getState = () => dataStoreGetState
  return { dataset, dataStoreState, dataStoreGetState, useDataStore }
})

const appStoreHarness = vi.hoisted(() => {
  const appStoreState = {
    activeFamilyId: 'statistics-1',
    projectId: 'project-1',
    setProjectDirty: vi.fn(),
    updateActiveFamilyData: vi.fn(),
  }
  const useAppStore = vi.fn((selector?: any) =>
    typeof selector === 'function' ? selector(appStoreState) : appStoreState
  )
  ;(useAppStore as any).getState = () => appStoreState
  return { appStoreState, useAppStore }
})

// ---------------------------------------------------------------------------
// Glide DataGrid mock — renders col-title spans for indicator assertions
// ---------------------------------------------------------------------------

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )
  const MockDataEditor = React.forwardRef((props: any, _ref: React.ForwardedRef<any>) => {
    harness.latestDataEditorProps = props
    return (
      <div>
        {(props.columns ?? []).map((col: any, i: number) => (
          <span key={col.id ?? i} data-testid={`col-title-${i}`}>
            {col.title}
          </span>
        ))}
      </div>
    )
  })
  MockDataEditor.displayName = 'MockDataEditor'
  return { ...actual, DataEditor: MockDataEditor }
})

// ---------------------------------------------------------------------------
// viewStateCache mock — prevents sort state from leaking between tests.
// The module-level Map in the real implementation persists across renders in
// the same Vitest worker, causing later tests to restore the sort state that
// earlier tests wrote. Mocking it makes every test start with a clean slate.
// ---------------------------------------------------------------------------

vi.mock('@/lib/grid/viewStateCache', () => ({
  getViewStateCache: vi.fn(() => undefined),
  setViewStateCache: vi.fn(),
  clearViewStateCacheForKey: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))
vi.mock('@/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn().mockResolvedValue(true) }))
vi.mock('@/services/tauriApi', () => ({
  tauriApi: { loadDataRows: vi.fn().mockResolvedValue([]), evaluateFormulaRange: vi.fn() },
}))
vi.mock('@/services/cacheService', () => ({
  default: {
    getDatasetStorageInfo: vi.fn().mockResolvedValue(null),
    getRowsHybrid: vi.fn().mockResolvedValue([]),
    ensureLatestCache: vi.fn().mockResolvedValue(undefined),
    getAllColumnStats: vi.fn().mockResolvedValue([]),
    getPersistedColumnIds: vi.fn().mockResolvedValue(['col-0', 'col-1']),
    getGridMutationQueueState: vi.fn().mockReturnValue({
      status: 'idle',
      failedQueueId: null,
      error: null,
    }),
    subscribeGridMutationQueue: vi.fn((_datasetId: string, listener: (state: any) => void) => {
      listener({ status: 'idle', failedQueueId: null, error: null })
      return () => undefined
    }),
    getColumnData: vi.fn().mockResolvedValue([1, 2]),
  },
}))
vi.mock('@/lib/grid/editExecutor', () => ({
  createEditExecutor: vi.fn(() => ({
    execute: harness.executeEdits,
    executeSingle: harness.executeSingleEdit,
  })),
}))
vi.mock('@/store/data-store', () => ({ useDataStore: dataStoreHarness.useDataStore }))
vi.mock('@/store/app-store', () => ({
  useAppStore: appStoreHarness.useAppStore,
  ensureProjectId: vi.fn().mockResolvedValue('project-1'),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mount and wait for DataEditor to receive its first props.
 * Called with REAL timers so waitFor polling works.
 */
async function mountAndWait() {
  render(<SpreadsheetView />)
  await waitFor(() => expect(harness.latestDataEditorProps).not.toBeNull())
}

/**
 * Call onHeaderClicked via the latest harness props, wrapped in act() so
 * any synchronous React state updates (e.g. setRenameDialog) are flushed
 * before the caller proceeds.
 */
async function triggerHeaderClick(
  colIndex = 0,
  isDoubleClick = false,
  isEdge = false,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}
) {
  await act(async () => {
    harness.latestDataEditorProps?.onHeaderClicked?.(colIndex, {
      kind: 'header',
      isDoubleClick,
      isEdge,
      ...modifiers,
      preventDefault: vi.fn(),
    })
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpreadsheetView header sort UX (Phase 2)', () => {
  beforeEach(() => {
    harness.latestDataEditorProps = null
    harness.executeEdits.mockClear()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('single-click header is selection-only and does not sort', async () => {
    await mountAndWait()

    await triggerHeaderClick(0)

    const title = screen.getByTestId('col-title-0').textContent ?? ''
    expect(title).not.toContain('↑')
    expect(title).not.toContain('↓')
  })

  it('passes multi-column header selection mode to Glide', async () => {
    await mountAndWait()

    expect(harness.latestDataEditorProps?.columnSelect).toBe('multi')
  })

  it('modifier header click is selection-only and does not schedule sort', async () => {
    await mountAndWait()
    vi.useFakeTimers()

    await act(async () => {
      harness.latestDataEditorProps?.onHeaderClicked?.(1, {
        kind: 'header',
        shiftKey: true,
        preventDefault: vi.fn(),
      })
    })
    await act(async () => {
      await vi.runAllTimersAsync()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })

    const title = screen.getByTestId('col-title-1').textContent ?? ''
    expect(title).not.toContain('↑')
    expect(title).not.toContain('↓')
  })

  it('repeated single-click headers never cycle sort state', async () => {
    await mountAndWait()

    await triggerHeaderClick(0)
    await triggerHeaderClick(0)
    await triggerHeaderClick(0)

    const title = screen.getByTestId('col-title-0').textContent ?? ''
    expect(title).not.toContain('↑')
    expect(title).not.toContain('↓')
  })

  it('double-click on header body opens rename dialog without sorting', async () => {
    await mountAndWait()
    vi.useFakeTimers()

    await triggerHeaderClick(0, true, false)

    // Rename dialog must appear
    expect(screen.getByDisplayValue('Column 1')).toBeInTheDocument()

    // Sort indicator must NOT appear
    const title = screen.getByTestId('col-title-0').textContent ?? ''
    expect(title).not.toContain('↑')
    expect(title).not.toContain('↓')
  })

  it('modifier double-click on header is selection-only and does not open rename dialog', async () => {
    await mountAndWait()

    await triggerHeaderClick(1, true, false, { ctrlKey: true })

    expect(screen.queryByText('Rename Column')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('Column 2')).not.toBeInTheDocument()
    const title = screen.getByTestId('col-title-1').textContent ?? ''
    expect(title).not.toContain('↑')
    expect(title).not.toContain('↓')
  })

  it('double-click on column edge does NOT open rename dialog and does NOT mutate sort state', async () => {
    await mountAndWait()

    // Edge double-click: should auto-fit width only
    await triggerHeaderClick(0, true, true)
    await act(async () => { await Promise.resolve() })

    // Rename input must NOT appear
    expect(screen.queryByDisplayValue('Column 1')).not.toBeInTheDocument()

    const title = screen.getByTestId('col-title-0').textContent ?? ''
    expect(title).not.toContain('↑')
    expect(title).not.toContain('↓')
  })
})

// ---------------------------------------------------------------------------
// ViewState migration tests
// ---------------------------------------------------------------------------

// Build schema key via the shared util — same function used by SpreadsheetView.
const computeTestSchemaKey = (columns: Array<{ id: string }>) =>
  computeSchemaKey(columns.map((c) => c.id))

describe('SpreadsheetView ViewState migration (legacy sortColumn/sortDirection)', () => {
  const testColumns = [
    { id: 'col-0', name: 'Column 1', type: 'numeric' },
    { id: 'col-1', name: 'Column 2', type: 'categorical' },
  ]

  beforeEach(() => {
    harness.latestDataEditorProps = null
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    // Reset clears call history and queued mockReturnValueOnce values,
    // then restores the default vi.fn() behaviour (returns undefined).
    vi.mocked(viewStateCacheModule.getViewStateCache).mockReset()
  })

  it('restores sort from legacy sortColumn/sortDirection when sortModel is absent', async () => {
    const schemaKey = computeTestSchemaKey(testColumns)
    // mockImplementation overrides the vi.fn factory and returns the legacy state for any key.
    vi.mocked(viewStateCacheModule.getViewStateCache).mockImplementation(() => ({
      datasetId: 'dataset-1',
      schemaKey,
      // Legacy fields — no sortModel
      sortColumn: 'col-0',
      sortDirection: 'asc',
      groupByColumnId: null,
      collapsedGroupKeys: [],
      gridSelection: null,
      activeCell: null,
      scroll: null,
    } as any))

    render(<SpreadsheetView />)

    // Wait for component to mount and the pendingRestoreSortRef effect to fire
    await waitFor(() => expect(harness.latestDataEditorProps).not.toBeNull())

    // Give performSort time to complete (real timers, no delay on sort restore)
    await waitFor(
      () => {
        const title = screen.getByTestId('col-title-0').textContent ?? ''
        expect(title).toMatch(/Column 1\s*↑/)
      },
      { timeout: 3000 }
    )
  })

  it('prefers sortModel over legacy sortColumn when both present', async () => {
    const schemaKey = computeTestSchemaKey(testColumns)
    vi.mocked(viewStateCacheModule.getViewStateCache).mockImplementation(() => ({
      datasetId: 'dataset-1',
      schemaKey,
      // New field (desc) takes precedence over legacy field (asc)
      sortModel: [{ colId: 'col-0', dir: 'desc' }],
      sortColumn: 'col-0',
      sortDirection: 'asc',
      groupByColumnId: null,
      collapsedGroupKeys: [],
      gridSelection: null,
      activeCell: null,
      scroll: null,
    } as any))

    render(<SpreadsheetView />)
    await waitFor(() => expect(harness.latestDataEditorProps).not.toBeNull())

    await waitFor(
      () => {
        const title = screen.getByTestId('col-title-0').textContent ?? ''
        expect(title).toMatch(/Column 1\s*↓/)
      },
      { timeout: 3000 }
    )
  })

  it('ignores legacy sortColumn when column no longer exists in dataset', async () => {
    const schemaKey = computeTestSchemaKey(testColumns)
    vi.mocked(viewStateCacheModule.getViewStateCache).mockImplementation(() => ({
      datasetId: 'dataset-1',
      schemaKey,
      sortColumn: 'col-deleted',  // not in current columns
      sortDirection: 'asc',
      groupByColumnId: null,
      collapsedGroupKeys: [],
      gridSelection: null,
      activeCell: null,
      scroll: null,
    } as any))

    render(<SpreadsheetView />)
    await waitFor(() => expect(harness.latestDataEditorProps).not.toBeNull())

    // Flush all timers (including any 200ms sort delay) — sort must NOT appear
    vi.useFakeTimers()
    await act(async () => {
      await vi.runAllTimersAsync()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })

    const title = screen.getByTestId('col-title-0').textContent ?? ''
    expect(title).not.toContain('↑')
    expect(title).not.toContain('↓')
  })
})
