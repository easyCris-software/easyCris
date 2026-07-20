import React, { useRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { CompactSelection } from '@glideapps/glide-data-grid'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SpreadsheetView from '../SpreadsheetView'
import type { GridMutationQueueState } from '@/lib/grid/types'

const keyboardHarness = vi.hoisted(() => ({ handlers: null as any }))
const insertMenuHarness = vi.hoisted(() => ({ open: null as null | ((x: number, y: number) => void) }))
const gridRenderHarness = vi.hoisted(() => ({
  captureCells: false,
  cellSnapshots: [] as Array<{ columnIds: string[]; firstCell: string; secondRowCell: string }>,
}))
const clipboardHarness = vi.hoisted(() => ({
  read: vi.fn<() => Promise<string>>().mockResolvedValue('A'),
  write: vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined),
}))
const toastHarness = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}))
const cacheHarness = vi.hoisted(() => ({
  getDatasetStorageInfo: vi.fn().mockResolvedValue({ isLarge: false, duckdbPath: 'test.duckdb' }),
  getAllColumnStats: vi.fn().mockResolvedValue([]),
  getPersistedColumnIds: vi.fn().mockResolvedValue(['col-1']),
  ensureLatestCache: vi.fn().mockResolvedValue(undefined),
  getLazyGroupMetadata: vi.fn().mockResolvedValue({ groups: [] }),
  getGroupRows: vi.fn().mockResolvedValue([]),
  flushPendingUpdates: vi.fn().mockResolvedValue(undefined),
  flushOverlay: vi.fn().mockResolvedValue(undefined),
  getRowsHybrid: vi.fn().mockResolvedValue([{ 'col-1': 'A' }]),
  addColumn: vi.fn().mockResolvedValue(undefined),
  appendRows: vi.fn().mockResolvedValue(0),
  insertRowAt: vi.fn().mockResolvedValue(0),
  insertRowsAt: vi.fn().mockResolvedValue(0),
  removeColumn: vi.fn().mockResolvedValue(undefined),
  removeRowAt: vi.fn().mockResolvedValue(0),
  queueStates: new Map<string, GridMutationQueueState>(),
  queueListeners: new Map<string, Set<(state: GridMutationQueueState) => void>>(),
  getGridMutationQueueState: vi.fn((datasetId: string) => {
    return cacheHarness.queueStates.get(datasetId) ?? {
      status: 'idle' as const,
      failedQueueId: null,
      error: null,
    }
  }),
  subscribeGridMutationQueue: vi.fn((datasetId: string, listener: (state: GridMutationQueueState) => void) => {
    const listeners = cacheHarness.queueListeners.get(datasetId) ?? new Set()
    listeners.add(listener)
    cacheHarness.queueListeners.set(datasetId, listeners)
    listener(cacheHarness.getGridMutationQueueState(datasetId))
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        cacheHarness.queueListeners.delete(datasetId)
      }
    }
  }),
  retryGridMutationQueue: vi.fn().mockResolvedValue(undefined),
}))
const editHarness = vi.hoisted(() => ({
  execute: vi.fn().mockResolvedValue({ backendSyncSucceeded: true }),
  executeSingle: vi.fn().mockResolvedValue({ backendSyncSucceeded: true }),
}))
const tauriHarness = vi.hoisted(() => ({
  loadDataRows: vi.fn().mockResolvedValue([]),
  evaluateFormulaRange: vi.fn(),
}))
const undoHarness = vi.hoisted(() => ({
  undo: vi.fn().mockResolvedValue(null),
  redo: vi.fn().mockResolvedValue(null),
  pushRowInsert: vi.fn().mockResolvedValue(undefined),
  pushColumnInsert: vi.fn().mockResolvedValue(undefined),
  recordGridTransaction: vi.fn().mockResolvedValue(undefined),
  hasPreparedUndoGridTransaction: vi.fn(() => false),
  hasPreparedRedoGridTransaction: vi.fn(() => false),
}))
const storeHarness = vi.hoisted(() => {
  const dataset = {
    id: 'dataset-1',
    name: 'dataset-1',
    rowCount: 10,
    dataRowCount: 1,
    columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
  } as any
  const dataset2 = {
    id: 'dataset-2',
    name: 'dataset-2',
    rowCount: 10,
    dataRowCount: 1,
    columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
  } as any

  const state = {
    currentDataset: dataset,
    datasets: [dataset, dataset2],
    loadingOperation: null,
    setLoadingOperation: vi.fn(),
    setSelectedRows: vi.fn(),
    setSelectedColumns: vi.fn(),
    setSelectionStats: vi.fn(),
    updateViewport: vi.fn(),
    updateCellValue: vi.fn(),
    updateCellsBatch: vi.fn(),
    updateDataset: vi.fn((datasetId: string, updates: Record<string, unknown>) => {
      if (state.currentDataset?.id === datasetId) Object.assign(state.currentDataset, updates)
      state.datasets = state.datasets.map((entry: any) =>
        entry.id === datasetId ? Object.assign(entry, updates) : entry
      )
    }),
    invalidateColumns: vi.fn(),
    allocateNextAutoColumnName: vi.fn(() => 'Column 2'),
    rollbackAutoColumnNameAllocation: vi.fn(),
    insertColumnAtDataset: vi.fn((datasetId: string, insertAt: number, column: any) => {
      if (state.currentDataset?.id !== datasetId) return
      const nextColumns = [...state.currentDataset.columns]
      nextColumns.splice(insertAt, 0, column)
      state.currentDataset.columns = nextColumns
      state.datasets = [state.currentDataset]
    }),
    insertRowAtDataset: vi.fn((datasetId: string) => {
      if (state.currentDataset?.id !== datasetId) return
      state.currentDataset.rowCount += 1
      state.currentDataset.dataRowCount += 1
      state.datasets = [state.currentDataset]
    }),
    insertRowsAtDataset: vi.fn(),
    removeColumnAtDataset: vi.fn(),
    removeRowAtDataset: vi.fn(),
    setHighlightsBatch: vi.fn(),
    removeHighlightsBatch: vi.fn(),
  }

  const useDataStore = vi.fn(() => state)
  ;(useDataStore as any).getState = () => ({
    ...state,
    getDatasetFormulas: vi.fn(() => new Map()),
    setDatasetFormulas: vi.fn(),
  })

  return { dataset, dataset2, state, useDataStore }
})

const appStoreHarness = vi.hoisted(() => {
  const appState = {
    activeFamilyId: 'statistics-1',
    projectId: 'project-1',
    pasteInFlight: false,
    setPasteInFlight: vi.fn(),
    setProjectDirty: vi.fn(),
    updateActiveFamilyData: vi.fn(),
  }
  const useAppStore = vi.fn((selector?: any) =>
    typeof selector === 'function' ? selector(appState) : appState
  )
  ;(useAppStore as any).getState = () => appState
  return { appState, useAppStore }
})

vi.mock('@/hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: (handlers: any) => {
    keyboardHarness.handlers = handlers
  },
}))

vi.mock('@/lib/grid/clipboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/grid/clipboard')>()
  return {
    ...actual,
    clipboard: {
      read: clipboardHarness.read,
      write: clipboardHarness.write,
    },
  }
})

vi.mock('@/services/cacheService', () => ({
  default: cacheHarness,
}))

vi.mock('@/lib/grid/editExecutor', () => ({
  createEditExecutor: vi.fn((config: any) => ({
    execute: vi.fn(async (edits: any[], source: string, options?: any) => {
      const result = await editHarness.execute(edits, source, options)
      config.setRowData((prev: Map<number, Record<string, unknown>>) => {
        const next = new Map(prev)
        for (const edit of edits) {
          const row = { ...(next.get(edit.row) ?? {}) }
          row[edit.columnId] = edit.newValue
          next.set(edit.row, row)
        }
        return next
      })
      return result ?? { backendSyncSucceeded: true }
    }),
    executeSingle: editHarness.executeSingle,
  })),
}))

vi.mock('@/services/tauriApi', () => ({
  tauriApi: {
    loadDataRows: tauriHarness.loadDataRows,
    evaluateFormulaRange: tauriHarness.evaluateFormulaRange,
  },
}))

vi.mock('@/services/undoService', () => ({
  undoService: undoHarness,
}))

vi.mock('sonner', () => ({ toast: toastHarness }))

vi.mock('@/store/data-store', () => ({ useDataStore: storeHarness.useDataStore }))

vi.mock('@/store/app-store', () => ({
  useAppStore: appStoreHarness.useAppStore,
  ensureProjectId: vi.fn().mockResolvedValue('project-1'),
}))

const makeSelection = (cell: [number, number] = [0, 0]) => ({
  current: {
    cell,
    range: { x: cell[0], y: cell[1], width: 1, height: 1 },
    rangeStack: [],
  },
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
})

const makeColumnHeaderSelection = (column = 0) => ({
  current: undefined,
  columns: CompactSelection.fromSingleSelection(column),
  rows: CompactSelection.empty(),
})

const makeRowHeaderSelection = (row = 0) => ({
  current: undefined,
  columns: CompactSelection.empty(),
  rows: CompactSelection.fromSingleSelection(row),
})

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )

  const MockDataEditor = React.forwardRef((props: any, _ref) => {
    const instanceId = useRef(`gdg-${Math.random().toString(36).slice(2)}`)
    if (gridRenderHarness.captureCells) {
      const firstCell = props.getCellContent?.([0, 0])
      const secondRowCell = props.getCellContent?.([0, 1])
      gridRenderHarness.cellSnapshots.push({
        columnIds: (props.columns ?? []).map((column: any) => column.id),
        firstCell: String(firstCell?.displayData ?? firstCell?.data ?? ''),
        secondRowCell: String(secondRowCell?.displayData ?? secondRowCell?.data ?? ''),
      })
    }

    return (
      <div>
        <div data-testid="gdg-root" data-instance-id={instanceId.current} />
        <button data-testid="select-range" onClick={() => props.onGridSelectionChange?.(makeSelection())}>
          select
        </button>
        <button data-testid="select-column-header" onClick={() => props.onGridSelectionChange?.(makeColumnHeaderSelection())}>
          select-column-header
        </button>
        <button data-testid="select-column-header-1" onClick={() => props.onGridSelectionChange?.(makeColumnHeaderSelection(1))}>
          select-column-header-1
        </button>
        <button data-testid="select-row-header" onClick={() => props.onGridSelectionChange?.(makeRowHeaderSelection())}>
          select-row-header
        </button>
        <button data-testid="select-row-header-2" onClick={() => props.onGridSelectionChange?.(makeRowHeaderSelection(2))}>
          select-row-header-2
        </button>
      </div>
    )
  })
  MockDataEditor.displayName = 'MockDataEditor'

  return { ...actual, DataEditor: MockDataEditor }
})

const readRefreshCounters = () => {
  const probe = screen.getByTestId('grid-refresh-counters')
  return {
    remount: Number(probe.getAttribute('data-remount-count') ?? '0'),
    viewport: Number(probe.getAttribute('data-viewport-count') ?? '0'),
    cells: Number(probe.getAttribute('data-cells-count') ?? '0'),
  }
}

describe('SpreadsheetView remount boundaries', () => {
  beforeEach(() => {
    keyboardHarness.handlers = null
    insertMenuHarness.open = null
    gridRenderHarness.captureCells = false
    gridRenderHarness.cellSnapshots = []
    clipboardHarness.write.mockClear()
    toastHarness.info.mockClear()
    toastHarness.error.mockClear()
    toastHarness.success.mockClear()
    toastHarness.warning.mockClear()
    cacheHarness.addColumn.mockClear()
    cacheHarness.appendRows.mockClear()
    cacheHarness.insertRowAt.mockClear()
    cacheHarness.getRowsHybrid.mockReset()
    cacheHarness.getRowsHybrid.mockImplementation(async (datasetId: string) => {
      if (datasetId === 'dataset-1') return [{ 'col-1': 'A' }]
      if (datasetId === 'dataset-2') return [{ 'col-1': 'B' }]
      return []
    })
    editHarness.execute.mockClear()
    undoHarness.pushRowInsert.mockClear()
    undoHarness.pushColumnInsert.mockClear()
    undoHarness.recordGridTransaction.mockClear()
    storeHarness.dataset.rowCount = 10
    storeHarness.dataset.dataRowCount = 1
    storeHarness.dataset.columns = [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }] as any
    storeHarness.dataset2.rowCount = 10
    storeHarness.dataset2.dataRowCount = 1
    storeHarness.dataset2.columns = [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }] as any
    storeHarness.state.currentDataset = storeHarness.dataset
    storeHarness.state.datasets = [storeHarness.dataset, storeHarness.dataset2]
  })

  it('does not remount DataEditor for cut refreshes', async () => {
    render(
      <SpreadsheetView onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    fireEvent.click(screen.getByTestId('select-range'))
    const before = screen.getByTestId('gdg-root').getAttribute('data-instance-id')

    await act(async () => {
      await keyboardHarness.handlers.onCut?.()
    })

    await waitFor(() => {
      expect(clipboardHarness.write).toHaveBeenCalledTimes(1)
    })

    const after = screen.getByTestId('gdg-root').getAttribute('data-instance-id')
    expect(after).toBe(before)
    expect(readRefreshCounters().remount).toBe(0)
  })

  it('does not remount DataEditor for row insert refreshes and records non-remount refresh scopes', async () => {
    render(
      <SpreadsheetView onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    const before = screen.getByTestId('gdg-root').getAttribute('data-instance-id')
    const baseline = readRefreshCounters()

    fireEvent.click(screen.getByTestId('select-range'))
    act(() => {
      insertMenuHarness.open?.(20, 20)
    })
    fireEvent.click(screen.getByText('Insert Row Below'))

    await waitFor(() => {
      expect(cacheHarness.appendRows).toHaveBeenCalledTimes(1)
    })
    expect(cacheHarness.insertRowAt).not.toHaveBeenCalled()

    const after = screen.getByTestId('gdg-root').getAttribute('data-instance-id')
    expect(after).toBe(before)

    const counters = readRefreshCounters()
    expect(counters.remount - baseline.remount).toBe(0)
    expect((counters.viewport - baseline.viewport) + (counters.cells - baseline.cells)).toBeGreaterThan(0)
  })

  it('uses the append row path for tail inserts without shifting backend rows', async () => {
    gridRenderHarness.captureCells = true
    storeHarness.state.currentDataset.rowCount = 1
    storeHarness.state.currentDataset.dataRowCount = 1

    render(
      <SpreadsheetView viewStateKey="tail-row-insert" onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    fireEvent.click(screen.getByTestId('select-row-header'))
    act(() => {
      insertMenuHarness.open?.(20, 20)
    })
    fireEvent.click(screen.getByText('Insert Row Below'))

    await waitFor(() => {
      expect(cacheHarness.appendRows).toHaveBeenCalledTimes(1)
    })

    expect(cacheHarness.appendRows).toHaveBeenCalledWith('dataset-1', 1)
    expect(cacheHarness.insertRowAt).not.toHaveBeenCalled()
    expect(undoHarness.pushRowInsert).toHaveBeenCalledWith('dataset-1', 1, {})
    expect(storeHarness.state.currentDataset.rowCount).toBe(2)
    expect(storeHarness.state.currentDataset.dataRowCount).toBe(2)
    expect(
      gridRenderHarness.cellSnapshots.some(snapshot => snapshot.secondRowCell === '')
    ).toBe(true)
  })

  it('does not remount DataEditor for column insert refreshes', async () => {
    gridRenderHarness.captureCells = true

    render(
      <SpreadsheetView onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    const before = screen.getByTestId('gdg-root').getAttribute('data-instance-id')
    const baseline = readRefreshCounters()

    await waitFor(() => {
      expect(gridRenderHarness.cellSnapshots.some(snapshot => snapshot.firstCell === 'A')).toBe(true)
    })
    gridRenderHarness.cellSnapshots = []
    cacheHarness.getRowsHybrid.mockClear()

    fireEvent.click(screen.getByTestId('select-range'))
    act(() => {
      insertMenuHarness.open?.(20, 20)
    })
    fireEvent.click(screen.getByText('Insert Column Right'))

    await waitFor(() => {
      expect(storeHarness.state.currentDataset.columns).toHaveLength(2)
    })

    const after = screen.getByTestId('gdg-root').getAttribute('data-instance-id')
    expect(after).toBe(before)
    const counters = readRefreshCounters()
    expect(counters.remount - baseline.remount).toBe(0)
    expect((counters.viewport - baseline.viewport) + (counters.cells - baseline.cells)).toBeGreaterThan(0)
    expect(screen.queryByTestId('grid-empty-state')).not.toBeInTheDocument()
    expect(
      gridRenderHarness.cellSnapshots.some(
        snapshot => snapshot.columnIds.length === 2 && snapshot.firstCell === ''
      )
    ).toBe(false)
    expect(cacheHarness.getRowsHybrid).not.toHaveBeenCalled()
  })

  it('shows a guidance toast instead of inserting relative to a stale column anchor when no cell is selected', async () => {
    render(
      <SpreadsheetView viewStateKey="no-anchor-column" onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    act(() => {
      insertMenuHarness.open?.(20, 20)
    })
    act(() => {
      fireEvent.click(screen.getByText('Insert Column Right'))
    })

    expect(toastHarness.info).toHaveBeenCalledWith(
      'Select a cell or column header to choose where to insert the column.'
    )
    expect(cacheHarness.addColumn).not.toHaveBeenCalled()
    expect(storeHarness.state.currentDataset.columns).toHaveLength(1)
  })

  it('shows a guidance toast instead of inserting relative to a stale row anchor when no cell is selected', async () => {
    render(
      <SpreadsheetView viewStateKey="no-anchor-row" onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    act(() => {
      insertMenuHarness.open?.(20, 20)
    })
    act(() => {
      fireEvent.click(screen.getByText('Insert Row Below'))
    })

    expect(toastHarness.info).toHaveBeenCalledWith(
      'Select a cell or row header to choose where to insert the row.'
    )
    expect(cacheHarness.insertRowAt).not.toHaveBeenCalled()
    expect(storeHarness.state.currentDataset.rowCount).toBe(10)
  })

  it('uses column header selection as the insert column anchor', async () => {
    render(
      <SpreadsheetView viewStateKey="column-header-anchor" onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    fireEvent.click(screen.getByTestId('select-column-header'))
    act(() => {
      insertMenuHarness.open?.(20, 20)
    })
    act(() => {
      fireEvent.click(screen.getByText('Insert Column Right'))
    })

    await waitFor(() => {
      expect(cacheHarness.addColumn).toHaveBeenCalledTimes(1)
    })
    expect(toastHarness.info).not.toHaveBeenCalledWith(
      'Select a cell or column header to choose where to insert the column.'
    )
  })

  it('uses an explicit column header anchor over a stale active cell', async () => {
    storeHarness.state.currentDataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Existing 2', type: 'text', width: 88 },
    ] as any

    render(
      <SpreadsheetView viewStateKey="stale-active-column-anchor" onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    fireEvent.click(screen.getByTestId('select-range'))
    fireEvent.click(screen.getByTestId('select-column-header-1'))
    act(() => {
      insertMenuHarness.open?.(20, 20)
    })
    act(() => {
      fireEvent.click(screen.getByText('Insert Column Right'))
    })

    await waitFor(() => {
      expect(storeHarness.state.currentDataset.columns).toHaveLength(3)
    })
    expect(storeHarness.state.currentDataset.columns[1].id).toBe('col-2')
  })

  it('uses row header selection as the insert row anchor', async () => {
    render(
      <SpreadsheetView viewStateKey="row-header-anchor" onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    fireEvent.click(screen.getByTestId('select-row-header'))
    act(() => {
      insertMenuHarness.open?.(20, 20)
    })
    act(() => {
      fireEvent.click(screen.getByText('Insert Row Below'))
    })

    await waitFor(() => {
      expect(cacheHarness.appendRows).toHaveBeenCalledTimes(1)
    })
    expect(cacheHarness.insertRowAt).not.toHaveBeenCalled()
    expect(toastHarness.info).not.toHaveBeenCalledWith(
      'Select a cell or row header to choose where to insert the row.'
    )
  })

  it('uses an explicit row header anchor over a stale active cell', async () => {
    storeHarness.state.currentDataset.rowCount = 10
    storeHarness.state.currentDataset.dataRowCount = 5

    render(
      <SpreadsheetView viewStateKey="stale-active-row-anchor" onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    fireEvent.click(screen.getByTestId('select-range'))
    fireEvent.click(screen.getByTestId('select-row-header-2'))
    act(() => {
      insertMenuHarness.open?.(20, 20)
    })
    act(() => {
      fireEvent.click(screen.getByText('Insert Row Below'))
    })

    await waitFor(() => {
      expect(cacheHarness.insertRowAt).toHaveBeenCalledTimes(1)
    })
    expect(cacheHarness.appendRows).not.toHaveBeenCalled()
    expect(cacheHarness.insertRowAt).toHaveBeenCalledWith('dataset-1', 3)
  })

  it('reloads rows for unmarked same-dataset schema changes', async () => {
    const view = render(
      <SpreadsheetView viewStateKey="unmarked-schema-change" onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalled()
    })
    cacheHarness.getRowsHybrid.mockClear()

    storeHarness.state.currentDataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'external-col', name: 'External Column', type: 'text', width: 88 },
    ] as any
    view.rerender(
      <SpreadsheetView viewStateKey="unmarked-schema-change" onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalled()
    })
  })

  it('does not remount DataEditor when switching between same-schema datasets', async () => {
    const view = render(
      <SpreadsheetView onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    await waitFor(() => {
      expect(screen.getByTestId('gdg-root')).toBeInTheDocument()
    })

    const before = screen.getByTestId('gdg-root').getAttribute('data-instance-id')
    const baseline = readRefreshCounters()

    storeHarness.state.currentDataset = storeHarness.dataset2
    view.rerender(
      <SpreadsheetView onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-2', expect.any(Number), expect.any(Number))
    })

    const after = screen.getByTestId('gdg-root').getAttribute('data-instance-id')
    expect(after).toBe(before)

    const counters = readRefreshCounters()
    expect(counters.remount - baseline.remount).toBe(0)
    expect((counters.viewport - baseline.viewport) + (counters.cells - baseline.cells)).toBeGreaterThan(0)
  })

  it('remounts DataEditor when switching to a different schema', async () => {
    storeHarness.dataset2.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Column 2', type: 'number', width: 88 },
    ] as any

    const view = render(
      <SpreadsheetView onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    await waitFor(() => {
      expect(screen.getByTestId('gdg-root')).toBeInTheDocument()
    })

    const before = screen.getByTestId('gdg-root').getAttribute('data-instance-id')

    storeHarness.state.currentDataset = storeHarness.dataset2
    view.rerender(
      <SpreadsheetView onInsertMenuRequest={(open) => { insertMenuHarness.open = open }} />
    )

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-2', expect.any(Number), expect.any(Number))
    })

    await waitFor(() => {
      const after = screen.getByTestId('gdg-root').getAttribute('data-instance-id')
      expect(after).not.toBe(before)
    })

    const counters = readRefreshCounters()
    expect(counters.remount).toBeGreaterThan(0)
  })
})
