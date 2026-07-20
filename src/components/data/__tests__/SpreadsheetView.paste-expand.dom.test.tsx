import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { CompactSelection } from '@glideapps/glide-data-grid'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SpreadsheetView, {
  ADD_COLUMN_ID,
  resetSpreadsheetViewSharedOverlayStateForTests,
} from '../SpreadsheetView'

const keyboardHarness = vi.hoisted(() => ({ handlers: null as any }))
const debugHarness = vi.hoisted(() => ({
  logRuntimeDebug: vi.fn(),
}))
const clipboardHarness = vi.hoisted(() => ({
  read: vi.fn<() => Promise<string>>(),
  write: vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined),
}))
const cacheHarness = vi.hoisted(() => ({
  getDatasetStorageInfo: vi.fn().mockResolvedValue(null),
  getAllColumnStats: vi.fn().mockResolvedValue([]),
  getPersistedColumnIds: vi.fn().mockResolvedValue(['col-1']),
  addColumn: vi.fn().mockResolvedValue(undefined),
  removeColumn: vi.fn().mockResolvedValue(undefined),
  flushPendingUpdates: vi.fn().mockResolvedValue(undefined),
  flushOverlay: vi.fn().mockResolvedValue(undefined),
  getRowsHybrid: vi.fn().mockResolvedValue([]),
  insertRowAt: vi.fn().mockResolvedValue(0),
  insertRowsAt: vi.fn().mockResolvedValue(0),
  appendRows: vi.fn().mockResolvedValue(0),
  removeRowsFromEnd: vi.fn().mockResolvedValue(0),
  removeRowAt: vi.fn().mockResolvedValue(0),
  queueStates: new Map<string, { status: 'idle' | 'failed'; failedQueueId: string | null; error: string | null }>(),
  queueListeners: new Map<string, Set<(state: { status: 'idle' | 'failed'; failedQueueId: string | null; error: string | null }) => void>>(),
  getGridMutationQueueState: vi.fn((datasetId: string) => {
    return cacheHarness.queueStates.get(datasetId) ?? {
      status: 'idle' as const,
      failedQueueId: null,
      error: null,
    }
  }),
  subscribeGridMutationQueue: vi.fn((datasetId: string, listener: (state: { status: 'idle' | 'failed'; failedQueueId: string | null; error: string | null }) => void) => {
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
const storeHarness = vi.hoisted(() => {
  const dataset = {
    id: 'dataset-1',
    name: 'dataset-1',
    rowCount: 100,
    dataRowCount: 2,
    columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
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
    allocateNextAutoColumnName: vi.fn(() => 'Column 2'),
    rollbackAutoColumnNameAllocation: vi.fn(),
    insertColumnAtDataset: vi.fn(),
    insertRowAtDataset: vi.fn(),
    insertRowsAtDataset: vi.fn((datasetId: string, _insertAt: number, count: number) => {
      if (state.currentDataset?.id !== datasetId) return
      state.currentDataset.rowCount += count
      state.currentDataset.dataRowCount += count
      state.datasets = state.datasets.map((entry: any) =>
        entry.id === datasetId ? state.currentDataset : entry
      )
    }),
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
    pasteInFlight: false,
    setPasteInFlight: vi.fn((inFlight: boolean) => {
      appState.pasteInFlight = inFlight
    }),
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

vi.mock('@/lib/debug/runtimeDebug', () => ({
  logRuntimeDebug: debugHarness.logRuntimeDebug,
}))

vi.mock('@/lib/grid/editExecutor', () => ({
  createEditExecutor: vi.fn(() => ({
    execute: editHarness.execute,
    executeSingle: editHarness.executeSingle,
    applyDataStoreUpdate: vi.fn(),
  })),
}))

vi.mock('@/services/tauriApi', () => ({
  tauriApi: {
    loadDataRows: tauriHarness.loadDataRows,
    evaluateFormulaRange: tauriHarness.evaluateFormulaRange,
  },
}))

vi.mock('@/store/data-store', () => ({ useDataStore: storeHarness.useDataStore }))

vi.mock('@/store/app-store', () => ({
  useAppStore: appStoreHarness.useAppStore,
  ensureProjectId: vi.fn().mockResolvedValue('project-1'),
}))

const makeSelection = (row: number) => ({
  current: {
    cell: [0, row] as [number, number],
    range: { x: 0, y: row, width: 1, height: 1 },
    rangeStack: [],
  },
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
})

const makeSelectionRange = (row: number, height: number) => ({
  current: {
    cell: [0, row] as [number, number],
    range: { x: 0, y: row, width: 1, height },
    rangeStack: [],
  },
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
})

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const makeDataset = (id: string, dataRowCount: number) => ({
  id,
  name: id,
  rowCount: 100,
  dataRowCount,
  columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
} as any)

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )

  const MockDataEditor = React.forwardRef((props: any, _ref) => {
    return (
      <div>
        <button
          data-testid="select-row-0"
          onClick={() => props.onGridSelectionChange?.(makeSelection(0))}
        >
          row0
        </button>
        <button
          data-testid="select-row-1"
          onClick={() => props.onGridSelectionChange?.(makeSelection(1))}
        >
          row1
        </button>
        <button
          data-testid="select-range-0-3"
          onClick={() => props.onGridSelectionChange?.(makeSelectionRange(0, 3))}
        >
          row0-3
        </button>
      </div>
    )
  })
  MockDataEditor.displayName = 'MockDataEditor'

  return { ...actual, DataEditor: MockDataEditor }
})

describe('SpreadsheetView paste expand DOM contract', () => {
  beforeEach(() => {
    resetSpreadsheetViewSharedOverlayStateForTests()
    keyboardHarness.handlers = null
    clipboardHarness.read.mockReset()
    clipboardHarness.write.mockClear()
    cacheHarness.insertRowAt.mockClear()
    cacheHarness.insertRowsAt.mockClear()
    cacheHarness.appendRows.mockClear()
    cacheHarness.removeRowsFromEnd.mockClear()
    cacheHarness.removeRowAt.mockClear()
    cacheHarness.getAllColumnStats.mockReset()
    cacheHarness.getAllColumnStats.mockResolvedValue([{ columnId: 'col-1', nonNullCount: 10 }])
    cacheHarness.getPersistedColumnIds.mockReset()
    cacheHarness.getPersistedColumnIds.mockResolvedValue(['col-1'])
    cacheHarness.addColumn.mockClear()
    cacheHarness.removeColumn.mockClear()
    cacheHarness.flushPendingUpdates.mockClear()
    cacheHarness.flushOverlay.mockClear()
    cacheHarness.getRowsHybrid.mockClear()
    editHarness.execute.mockClear()
    editHarness.execute.mockResolvedValue({ backendSyncSucceeded: true })
    editHarness.executeSingle.mockClear()
    editHarness.executeSingle.mockResolvedValue({ backendSyncSucceeded: true })
    storeHarness.state.insertRowAtDataset.mockClear()
    storeHarness.state.insertRowsAtDataset.mockClear()
    storeHarness.state.removeRowAtDataset.mockClear()

    storeHarness.dataset.rowCount = 100
    storeHarness.dataset.dataRowCount = 2
    storeHarness.dataset.columns = [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }] as any
    storeHarness.state.currentDataset = storeHarness.dataset
    storeHarness.state.datasets = [storeHarness.dataset]
    cacheHarness.appendRows.mockResolvedValue(4)
    clipboardHarness.read.mockResolvedValue('a\nb\nc')
    debugHarness.logRuntimeDebug.mockClear()
    tauriHarness.loadDataRows.mockClear()
    tauriHarness.evaluateFormulaRange.mockClear()
    appStoreHarness.appState.pasteInFlight = false
    appStoreHarness.appState.setPasteInFlight.mockClear()
  })

  it('uses one append-only row expansion call when paste overflows data rows', async () => {
    storeHarness.dataset.rowCount = 2
    storeHarness.dataset.dataRowCount = 2
    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
    })

    await waitFor(() => {
      expect(cacheHarness.appendRows).toHaveBeenCalledTimes(1)
    })

    expect(cacheHarness.appendRows).toHaveBeenCalledWith('dataset-1', 2)
    expect(cacheHarness.insertRowsAt).not.toHaveBeenCalled()
    expect(cacheHarness.insertRowAt).not.toHaveBeenCalled()
    expect(storeHarness.state.insertRowsAtDataset).toHaveBeenCalledWith('dataset-1', 2, 2)
    expect(storeHarness.dataset.rowCount).toBe(4)
    expect(storeHarness.dataset.dataRowCount).toBe(4)
  })

  it('rolls back failed paste append with one tail-only backend call', async () => {
    storeHarness.dataset.rowCount = 2
    storeHarness.dataset.dataRowCount = 2
    storeHarness.state.insertRowsAtDataset.mockImplementationOnce(() => {
      throw new Error('store insert failed')
    })
    clipboardHarness.read.mockResolvedValue('a\nb\nc')

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-0'))

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
    })

    await waitFor(() => {
      expect(cacheHarness.removeRowsFromEnd).toHaveBeenCalledTimes(1)
    })

    expect(cacheHarness.removeRowsFromEnd).toHaveBeenCalledWith('dataset-1', 1)
    expect(cacheHarness.removeRowAt).not.toHaveBeenCalled()
  })

  it('requests backend overlay flush after successful paste execute', async () => {
    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
    })

    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalled()
    })

    expect(cacheHarness.flushOverlay).toHaveBeenCalledWith('dataset-1')
  })

  it('skips expansion calls when paste fits existing data rows', async () => {
    storeHarness.dataset.dataRowCount = 10
    storeHarness.dataset.rowCount = 100
    clipboardHarness.read.mockResolvedValue('x\ny')

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
    })

    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalled()
    })

    expect(cacheHarness.insertRowsAt).not.toHaveBeenCalled()
    expect(cacheHarness.appendRows).not.toHaveBeenCalled()
    expect(cacheHarness.insertRowAt).not.toHaveBeenCalled()
    expect(storeHarness.state.insertRowsAtDataset).not.toHaveBeenCalled()
  })

  it('immediately reloads touched paste range after block sync', async () => {
    const deferredFlush = createDeferred<void>()
    cacheHarness.flushOverlay.mockReturnValueOnce(deferredFlush.promise)
    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    cacheHarness.getRowsHybrid.mockClear()

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalled()
    })

    expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith(
      'grid',
      'mutation_load_invalidation',
      expect.objectContaining({
        datasetId: 'dataset-1',
        minModelRow: 1,
        maxModelRow: 3,
      })
    )
    expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith(
      'paste',
      'post_paste_block_sync',
      expect.objectContaining({
        datasetId: 'dataset-1',
        minModelRow: 1,
        maxModelRow: 3,
      })
    )
    const hasImmediatePasteRangeReload = cacheHarness.getRowsHybrid.mock.calls.some(
      (call) => call[0] === 'dataset-1' && call[1] === 1 && call[2] === 4
    )
    expect(hasImmediatePasteRangeReload).toBe(false)

    deferredFlush.resolve()
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('records backend sync failure without forcing an immediate touched-range reload', async () => {
    editHarness.execute.mockResolvedValueOnce({ backendSyncSucceeded: false })
    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    cacheHarness.getRowsHybrid.mockClear()

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalled()
    })

    expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith(
      'grid',
      'mutation_backend_sync_failed',
      expect.objectContaining({
        datasetId: 'dataset-1',
        kind: 'paste',
        transactionId: 'paste-test-uuid-1',
      })
    )
    const hasImmediatePasteRangeReload = cacheHarness.getRowsHybrid.mock.calls.some(
      (call) => call[0] === 'dataset-1' && call[1] === 1 && call[2] === 4
    )
    expect(hasImmediatePasteRangeReload).toBe(false)
  })

  it('skips virtual add-column targets in standard paste edits', async () => {
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: ADD_COLUMN_ID, name: '+', type: 'text', width: 64 },
    ] as any
    clipboardHarness.read.mockResolvedValue('left\tright')

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-0'))

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
    })

    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalled()
    })

    const edits = editHarness.execute.mock.calls[0]?.[0] as Array<{ columnId: string }>
    expect(edits).toHaveLength(2)
    expect(edits[0]?.columnId).toBe('col-1')
    expect(edits[1]?.columnId).not.toBe(ADD_COLUMN_ID)
    expect(edits.some((edit) => edit.columnId === ADD_COLUMN_ID)).toBe(false)
  })

  it('aborts stale internal paste operation when copy context changes mid-flight', async () => {
    storeHarness.dataset.dataRowCount = 2
    cacheHarness.getRowsHybrid
      .mockResolvedValueOnce([{ 'col-1': 'seed' }, { 'col-1': 'seed' }, { 'col-1': 'seed' }])
      .mockResolvedValueOnce([{ 'col-1': 'new-seed' }])
    clipboardHarness.read.mockResolvedValue('seed\nseed\nseed')
    const deferredInsert = createDeferred<number>()
    cacheHarness.appendRows.mockReturnValueOnce(deferredInsert.promise)

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-range-0-3'))

    await act(async () => {
      await keyboardHarness.handlers.onCopy?.()
    })
    expect(clipboardHarness.write).toHaveBeenLastCalledWith('seed\nseed\nseed')

    const inFlightPaste = keyboardHarness.handlers.onPaste?.()

    fireEvent.click(screen.getByTestId('select-row-1'))
    cacheHarness.getRowsHybrid.mockResolvedValue([{ 'col-1': 'new-seed' }])
    await act(async () => {
      await keyboardHarness.handlers.onCopy?.()
    })
    expect(clipboardHarness.write).toHaveBeenLastCalledWith('new-seed')

    deferredInsert.resolve(3)
    await act(async () => {
      await inFlightPaste
    })

    expect(editHarness.execute).not.toHaveBeenCalled()
  })

  it('allows external clipboard paste when internal copy metadata is absent/mismatched', async () => {
    cacheHarness.getRowsHybrid.mockResolvedValue([{ 'col-1': 'seed' }])

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-0'))

    await act(async () => {
      await keyboardHarness.handlers.onCopy?.()
    })
    expect(clipboardHarness.write).toHaveBeenLastCalledWith('seed')

    clipboardHarness.read.mockResolvedValue('external')
    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
    })

    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalled()
    })
    const edits = editHarness.execute.mock.calls[0]?.[0] as Array<{ newValue: unknown }>
    expect(edits[0]?.newValue).toBe('external')
  })

  it('aborts external paste operation when selection changes mid-flight', async () => {
    storeHarness.dataset.dataRowCount = 2
    clipboardHarness.read.mockResolvedValue('external\nexternal\nexternal')
    const deferredInsert = createDeferred<number>()
    cacheHarness.appendRows.mockReturnValueOnce(deferredInsert.promise)

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-0'))

    const inFlightPaste = keyboardHarness.handlers.onPaste?.()

    fireEvent.click(screen.getByTestId('select-row-1'))
    deferredInsert.resolve(3)
    await act(async () => {
      await inFlightPaste
    })

    expect(editHarness.execute).not.toHaveBeenCalled()
  })

  it('aborts paste when active dataset switches before clipboard read resolves', async () => {
    const dataset2 = makeDataset('dataset-2', 2)
    storeHarness.state.datasets = [storeHarness.dataset, dataset2]
    storeHarness.state.currentDataset = storeHarness.dataset
    const deferredRead = createDeferred<string>()
    clipboardHarness.read.mockReturnValueOnce(deferredRead.promise)

    const { rerender } = render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-0'))

    const inFlightPaste = keyboardHarness.handlers.onPaste?.()

    storeHarness.state.currentDataset = dataset2
    await act(async () => {
      rerender(<SpreadsheetView />)
      await Promise.resolve()
    })

    deferredRead.resolve('late')
    await act(async () => {
      await inFlightPaste
    })

    expect(editHarness.execute).not.toHaveBeenCalled()
  })

  it('blocks paste before clipboard read when paste is already in flight', async () => {
    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-0'))

    const previousGetState = (appStoreHarness.useAppStore as any).getState
    ;(appStoreHarness.useAppStore as any).getState = () => ({
      ...previousGetState(),
      pasteInFlight: true,
    })
    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
    })
    ;(appStoreHarness.useAppStore as any).getState = previousGetState

    expect(clipboardHarness.read).not.toHaveBeenCalled()
    expect(editHarness.execute).not.toHaveBeenCalled()
  })

  it('prevents concurrent clipboard reads across rapid paste triggers', async () => {
    const deferredRead = createDeferred<string>()
    clipboardHarness.read.mockImplementationOnce(() => deferredRead.promise)

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-0'))

    const firstPaste = keyboardHarness.handlers.onPaste?.()
    const secondPaste = keyboardHarness.handlers.onPaste?.()
    expect(clipboardHarness.read).toHaveBeenCalledTimes(1)

    deferredRead.resolve('x')
    await act(async () => {
      await Promise.all([firstPaste, secondPaste])
    })
  })
})
