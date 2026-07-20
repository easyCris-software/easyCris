import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { CompactSelection } from '@glideapps/glide-data-grid'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SpreadsheetView, { ADD_COLUMN_ID } from '../SpreadsheetView'
import type { GridMutationQueueState } from '@/lib/grid/types'

const keyboardHarness = vi.hoisted(() => ({ handlers: null as any }))
const selectionHarness = vi.hoisted(() => ({ selection: null as any }))
const clipboardHarness = vi.hoisted(() => ({
  read: vi.fn<() => Promise<string>>(),
  write: vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined),
}))
const cacheHarness = vi.hoisted(() => ({
  getDatasetStorageInfo: vi.fn().mockResolvedValue(null),
  getRowsHybrid: vi.fn().mockResolvedValue([]),
  getAllColumnStats: vi.fn().mockResolvedValue([]),
  getPersistedColumnIds: vi.fn().mockResolvedValue(['col-1', 'col-2']),
  flushPendingUpdates: vi.fn().mockResolvedValue(undefined),
  insertRowAt: vi.fn().mockResolvedValue(0),
  insertRowsAt: vi.fn().mockResolvedValue(0),
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
  execute: vi.fn().mockResolvedValue(undefined),
  executeSingle: vi.fn().mockResolvedValue(undefined),
}))
const storeHarness = vi.hoisted(() => {
  const dataset = {
    id: 'dataset-1',
    name: 'dataset-1',
    rowCount: 100,
    dataRowCount: 1,
    columns: [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
    ],
  } as any

  const state = {
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
    allocateNextAutoColumnName: vi.fn(() => 'Column 3'),
    rollbackAutoColumnNameAllocation: vi.fn(),
    insertColumnAtDataset: vi.fn(),
    insertRowAtDataset: vi.fn(),
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

  return { dataset, state, useDataStore }
})

const appStoreHarness = vi.hoisted(() => {
  const appState = {
    activeFamilyId: 'statistics-1',
    projectId: 'project-1',
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
    execute: vi.fn(async (edits: Array<{ row: number; columnId: string; newValue: unknown }>, source: string, options?: unknown) => {
      editHarness.execute(edits, source, options)
      config.setRowData((prev: Map<number, Record<string, unknown>>) => {
        const next = new Map(prev)
        for (const edit of edits) {
          const row = { ...(next.get(edit.row) ?? {}) }
          row[edit.columnId] = edit.newValue
          next.set(edit.row, row)
        }
        return next
      })
      return { backendSyncSucceeded: true }
    }),
    executeSingle: editHarness.executeSingle,
  })),
}))

vi.mock('@/services/tauriApi', () => ({
  tauriApi: {
    loadDataRows: vi.fn().mockResolvedValue([]),
    evaluateFormulaRange: vi.fn(),
  },
}))

vi.mock('@/store/data-store', () => ({ useDataStore: storeHarness.useDataStore }))

vi.mock('@/store/app-store', () => ({
  useAppStore: appStoreHarness.useAppStore,
  ensureProjectId: vi.fn().mockResolvedValue('project-1'),
}))

const makeSelection = () => ({
  current: {
    cell: [0, 0] as [number, number],
    range: { x: 0, y: 0, width: 2, height: 1 },
    rangeStack: [],
  },
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
})

const makeDisjointSelection = () => ({
  current: {
    cell: [0, 1] as [number, number],
    range: { x: 0, y: 1, width: 1, height: 2 },
    rangeStack: [{ x: 2, y: 4, width: 1, height: 2 }],
  },
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
})

const makeColumnOnlySelection = () => ({
  current: undefined,
  columns: CompactSelection.fromSingleSelection([0, 2]),
  rows: CompactSelection.empty(),
})

const makeMixedRangeAndColumnSelection = () => ({
  current: {
    cell: [0, 0] as [number, number],
    range: { x: 0, y: 0, width: 1, height: 2 },
    rangeStack: [],
  },
  columns: CompactSelection.fromSingleSelection(1),
  rows: CompactSelection.empty(),
})

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )

  const MockDataEditor = React.forwardRef((props: any, _ref) => {
    return (
      <button
        data-testid="select-range"
        onClick={() => props.onGridSelectionChange?.(selectionHarness.selection ?? makeSelection())}
      >
        select
      </button>
    )
  })
  MockDataEditor.displayName = 'MockDataEditor'

  return { ...actual, DataEditor: MockDataEditor }
})

describe('SpreadsheetView copy/cut column-domain contract', () => {
  beforeEach(() => {
    keyboardHarness.handlers = null
    selectionHarness.selection = null
    clipboardHarness.read.mockReset()
    clipboardHarness.write.mockClear()
    editHarness.execute.mockClear()
    cacheHarness.flushPendingUpdates.mockClear()
    cacheHarness.getRowsHybrid.mockReset()
    cacheHarness.getPersistedColumnIds.mockReset()
    cacheHarness.getPersistedColumnIds.mockResolvedValue(['col-1', 'col-2'])
    cacheHarness.getGridMutationQueueState.mockClear()
    cacheHarness.subscribeGridMutationQueue.mockClear()
    cacheHarness.retryGridMutationQueue.mockClear()
    cacheHarness.queueStates.clear()
    cacheHarness.queueListeners.clear()

    storeHarness.dataset.rowCount = 100
    storeHarness.dataset.dataRowCount = 1
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: ADD_COLUMN_ID, name: '+', type: 'text', width: 64 },
    ] as any
    storeHarness.state.currentDataset = storeHarness.dataset
    storeHarness.state.datasets = [storeHarness.dataset]

    cacheHarness.getRowsHybrid.mockResolvedValue([
      { 'col-1': 'A', [ADD_COLUMN_ID]: 'B' },
    ])
  })

  it('copy reads deterministic backend rows and excludes virtual add column', async () => {
    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-range'))

    await act(async () => {
      await keyboardHarness.handlers.onCopy?.()
    })

    await waitFor(() => {
      expect(clipboardHarness.write).toHaveBeenCalledTimes(1)
    })

    expect(cacheHarness.flushPendingUpdates).toHaveBeenCalledTimes(1)
    expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-1', 0, 1)
    expect(clipboardHarness.write).toHaveBeenCalledWith('A')
  })

  it('copy expands column-only header selections across data rows and prepends headers', async () => {
    storeHarness.dataset.dataRowCount = 3
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Column 2', type: 'text', width: 88 },
      { id: ADD_COLUMN_ID, name: '+', type: 'text', width: 64 },
    ] as any
    selectionHarness.selection = makeColumnOnlySelection()
    const backendRows = [
      { 'col-1': 'A1', 'col-2': 'B1' },
      { 'col-1': 'A2', 'col-2': 'B2' },
      { 'col-1': 'A3', 'col-2': 'B3' },
    ]
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) =>
      backendRows.slice(start, end)
    )

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-range'))
    cacheHarness.getRowsHybrid.mockClear()

    await act(async () => {
      await keyboardHarness.handlers.onCopy?.()
    })

    await waitFor(() => {
      expect(clipboardHarness.write).toHaveBeenCalledTimes(1)
    })

    expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-1', 0, 3)
    expect(clipboardHarness.write).toHaveBeenCalledWith('Column 1\tColumn 2\nA1\tB1\nA2\tB2\nA3\tB3')
  })

  it('copy expands column-only selections across all data rows when rendered row count is smaller', async () => {
    storeHarness.dataset.rowCount = 2
    storeHarness.dataset.dataRowCount = 3
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: ADD_COLUMN_ID, name: '+', type: 'text', width: 64 },
    ] as any
    selectionHarness.selection = makeColumnOnlySelection()
    const backendRows = [
      { 'col-1': 'A1' },
      { 'col-1': 'A2' },
      { 'col-1': 'A3' },
    ]
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) =>
      backendRows.slice(start, end)
    )

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-range'))
    cacheHarness.getRowsHybrid.mockClear()

    await act(async () => {
      await keyboardHarness.handlers.onCopy?.()
    })

    await waitFor(() => {
      expect(clipboardHarness.write).toHaveBeenCalledTimes(1)
    })

    expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-1', 0, 3)
    expect(clipboardHarness.write).toHaveBeenCalledWith('Column 1\nA1\nA2\nA3')
  })

  it('copy does not prepend headers for mixed range and column selections', async () => {
    storeHarness.dataset.dataRowCount = 2
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Column 2', type: 'text', width: 88 },
    ] as any
    selectionHarness.selection = makeMixedRangeAndColumnSelection()
    const backendRows = [
      { 'col-1': 'A1', 'col-2': 'B1' },
      { 'col-1': 'A2', 'col-2': 'B2' },
    ]
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) =>
      backendRows.slice(start, end)
    )

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-range'))
    cacheHarness.getRowsHybrid.mockClear()

    await act(async () => {
      await keyboardHarness.handlers.onCopy?.()
    })

    await waitFor(() => {
      expect(clipboardHarness.write).toHaveBeenCalledTimes(1)
    })

    expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-1', 0, 2)
    expect(clipboardHarness.write).toHaveBeenCalledWith('B1\nB2')
  })

  it('cut clears only real columns and excludes virtual add column edits', async () => {
    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-range'))

    await act(async () => {
      await keyboardHarness.handlers.onCut?.()
    })

    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalledTimes(1)
    })

    expect(cacheHarness.flushPendingUpdates).toHaveBeenCalledTimes(1)
    expect(clipboardHarness.write).toHaveBeenCalledWith('A')

    const edits = editHarness.execute.mock.calls[0]?.[0] as Array<{ columnId: string }>
    expect(edits).toHaveLength(1)
    expect(edits[0]?.columnId).toBe('col-1')
    expect(edits.some((edit) => edit.columnId === ADD_COLUMN_ID)).toBe(false)
  })

  it('copy preserves disjoint range boundaries instead of copying row-column cross product', async () => {
    storeHarness.dataset.dataRowCount = 6
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Column 2', type: 'text', width: 88 },
      { id: 'col-3', name: 'Column 3', type: 'text', width: 88 },
    ] as any
    selectionHarness.selection = makeDisjointSelection()
    const backendRows = [
      { 'col-1': 'A1', 'col-2': 'B1', 'col-3': 'C1' },
      { 'col-1': 'A2', 'col-2': 'B2', 'col-3': 'C2' },
      { 'col-1': 'A3', 'col-2': 'B3', 'col-3': 'C3' },
      { 'col-1': 'A4', 'col-2': 'B4', 'col-3': 'C4' },
      { 'col-1': 'A5', 'col-2': 'B5', 'col-3': 'C5' },
      { 'col-1': 'A6', 'col-2': 'B6', 'col-3': 'C6' },
    ]
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) =>
      backendRows.slice(start, end)
    )

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-range'))

    await act(async () => {
      await keyboardHarness.handlers.onCopy?.()
    })

    await waitFor(() => {
      expect(clipboardHarness.write).toHaveBeenCalledTimes(1)
    })

    expect(clipboardHarness.write).toHaveBeenCalledWith('A2\nA3\nC5\nC6')
  })

  it('cut clears only cells inside disjoint ranges', async () => {
    storeHarness.dataset.dataRowCount = 6
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Column 2', type: 'text', width: 88 },
      { id: 'col-3', name: 'Column 3', type: 'text', width: 88 },
    ] as any
    selectionHarness.selection = makeDisjointSelection()
    const backendRows = [
      { 'col-1': 'A1', 'col-2': 'B1', 'col-3': 'C1' },
      { 'col-1': 'A2', 'col-2': 'B2', 'col-3': 'C2' },
      { 'col-1': 'A3', 'col-2': 'B3', 'col-3': 'C3' },
      { 'col-1': 'A4', 'col-2': 'B4', 'col-3': 'C4' },
      { 'col-1': 'A5', 'col-2': 'B5', 'col-3': 'C5' },
      { 'col-1': 'A6', 'col-2': 'B6', 'col-3': 'C6' },
    ]
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) =>
      backendRows.slice(start, end)
    )

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-range'))

    await act(async () => {
      await keyboardHarness.handlers.onCut?.()
    })

    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalledTimes(1)
    })

    const edits = editHarness.execute.mock.calls[0]?.[0] as Array<{ row: number; columnId: string }>
    expect(edits.map(edit => `${edit.row}:${edit.columnId}`)).toEqual([
      '1:col-1',
      '2:col-1',
      '4:col-3',
      '5:col-3',
    ])
  })

  it('delete clears only cells inside disjoint ranges', async () => {
    storeHarness.dataset.dataRowCount = 6
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Column 2', type: 'text', width: 88 },
      { id: 'col-3', name: 'Column 3', type: 'text', width: 88 },
    ] as any
    selectionHarness.selection = makeDisjointSelection()

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-range'))

    await act(async () => {
      keyboardHarness.handlers.onDelete?.()
    })

    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalledTimes(1)
    })

    const edits = editHarness.execute.mock.calls[0]?.[0] as Array<{ row: number; columnId: string }>
    expect(edits.map(edit => `${edit.row}:${edit.columnId}`)).toEqual([
      '1:col-1',
      '2:col-1',
      '4:col-3',
      '5:col-3',
    ])
  })

  it('delete treats scaffold sentinels as unloaded and fetches real row data before clearing', async () => {
    storeHarness.dataset.dataRowCount = 1
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: ADD_COLUMN_ID, name: '+', type: 'text', width: 64 },
    ] as any
    cacheHarness.getRowsHybrid
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ 'col-1': 'loaded value' }])

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-range'))

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalled()
    })
    cacheHarness.getRowsHybrid.mockClear()

    await act(async () => {
      keyboardHarness.handlers.onDelete?.()
    })

    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalledTimes(1)
    })

    expect(cacheHarness.flushPendingUpdates).toHaveBeenCalledTimes(1)
    expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-1', 0, 1)
    expect(editHarness.execute.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        row: 0,
        columnId: 'col-1',
        oldValue: 'loaded value',
        newValue: '',
      }),
    ])
  })

  it('lowers dataRowCount when delete clears the only data cell', async () => {
    storeHarness.dataset.dataRowCount = 1
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: ADD_COLUMN_ID, name: '+', type: 'text', width: 64 },
    ] as any
    cacheHarness.getRowsHybrid.mockResolvedValue([{ 'col-1': 'x' }])

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-range'))

    await act(async () => {
      keyboardHarness.handlers.onDelete?.()
    })

    await waitFor(() => {
      expect(storeHarness.state.updateDataset).toHaveBeenCalledWith('dataset-1', {
        dataRowCount: 0,
      })
    })
  })
})
