import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { CompactSelection, GridCellKind } from '@glideapps/glide-data-grid'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SpreadsheetView, { resetSpreadsheetViewSharedOverlayStateForTests } from '../SpreadsheetView'
import { createRedoGridTransaction, createUndoGridTransaction } from '@/lib/grid/gridMutationCoordinator'
import type { GridMutationQueueState, GridTransactionRecord } from '@/lib/grid/types'

const keyboardHarness = vi.hoisted(() => ({ handlers: null as any }))
const gridHarness = vi.hoisted(() => ({
  getCellContent: null as null | ((cell: [number, number]) => any),
  onCellEdited: null as null | ((cell: [number, number], value: any) => void),
  editCell: null as null | ((cell: [number, number], value: any) => void),
}))
const clipboardHarness = vi.hoisted(() => ({
  read: vi.fn<() => Promise<string>>(),
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
  flushPendingUpdates: vi.fn().mockResolvedValue(undefined),
  flushOverlay: vi.fn().mockResolvedValue(undefined),
  getRowsHybrid: vi.fn().mockResolvedValue([]),
  appendRows: vi.fn().mockResolvedValue(999),
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
  emitGridMutationQueueState: (datasetId: string, state: GridMutationQueueState) => {
    cacheHarness.queueStates.set(datasetId, state)
    const listeners = cacheHarness.queueListeners.get(datasetId)
    listeners?.forEach((listener) => listener(state))
  },
}))
const editHarness = vi.hoisted(() => ({
  execute: vi.fn().mockResolvedValue({ backendSyncSucceeded: true }),
  executeSingle: vi.fn().mockResolvedValue({ backendSyncSucceeded: true }),
  applyDataStoreUpdate: vi.fn(),
}))
const tauriHarness = vi.hoisted(() => ({
  loadDataRows: vi.fn().mockResolvedValue([]),
  evaluateFormulaRange: vi.fn(),
}))
const undoHarness = vi.hoisted(() => ({
  undo: vi.fn().mockResolvedValue(null),
  redo: vi.fn().mockResolvedValue(null),
  recordGridTransaction: vi.fn(async (datasetId: string, transaction: GridTransactionRecord) => {
    const undoStack = undoHarness.undoStacks.get(datasetId) ?? []
    undoStack.push(transaction)
    undoHarness.undoStacks.set(datasetId, undoStack)
    undoHarness.redoStacks.delete(datasetId)
  }),
  prepareUndoGridTransaction: vi.fn(async (datasetId: string) => {
    const undoStack = undoHarness.undoStacks.get(datasetId) ?? []
    if (undoStack.length === 0) return null
    return createUndoGridTransaction(undoStack[undoStack.length - 1]!)
  }),
  commitUndoGridTransaction: vi.fn(async (datasetId: string) => {
    const undoStack = undoHarness.undoStacks.get(datasetId) ?? []
    if (undoStack.length === 0) return
    const original = undoStack.pop()!
    undoHarness.undoStacks.set(datasetId, undoStack)
    const redoStack = undoHarness.redoStacks.get(datasetId) ?? []
    redoStack.push(original)
    undoHarness.redoStacks.set(datasetId, redoStack)
  }),
  undoGridTransaction: vi.fn(async (datasetId: string) => {
    const undoStack = undoHarness.undoStacks.get(datasetId) ?? []
    if (undoStack.length === 0) return null
    const original = undoStack.pop()!
    undoHarness.undoStacks.set(datasetId, undoStack)
    const redoStack = undoHarness.redoStacks.get(datasetId) ?? []
    redoStack.push(original)
    undoHarness.redoStacks.set(datasetId, redoStack)
    return createUndoGridTransaction(original)
  }),
  prepareRedoGridTransaction: vi.fn(async (datasetId: string) => {
    const redoStack = undoHarness.redoStacks.get(datasetId) ?? []
    if (redoStack.length === 0) return null
    return createRedoGridTransaction(redoStack[redoStack.length - 1]!)
  }),
  commitRedoGridTransaction: vi.fn(async (datasetId: string) => {
    const redoStack = undoHarness.redoStacks.get(datasetId) ?? []
    if (redoStack.length === 0) return
    const original = redoStack.pop()!
    undoHarness.redoStacks.set(datasetId, redoStack)
    const undoStack = undoHarness.undoStacks.get(datasetId) ?? []
    undoStack.push(original)
    undoHarness.undoStacks.set(datasetId, undoStack)
  }),
  redoGridTransaction: vi.fn(async (datasetId: string) => {
    const redoStack = undoHarness.redoStacks.get(datasetId) ?? []
    if (redoStack.length === 0) return null
    const original = redoStack.pop()!
    undoHarness.redoStacks.set(datasetId, redoStack)
    const undoStack = undoHarness.undoStacks.get(datasetId) ?? []
    undoStack.push(original)
    undoHarness.undoStacks.set(datasetId, undoStack)
    return createRedoGridTransaction(original)
  }),
  clearGridTransactionHistory: vi.fn((datasetId: string) => {
    undoHarness.undoStacks.delete(datasetId)
    undoHarness.redoStacks.delete(datasetId)
  }),
  rollbackUndoGridTransaction: vi.fn(async () => {}),
  rollbackRedoGridTransaction: vi.fn(async () => {}),
  hasPreparedUndoGridTransaction: vi.fn(() => false),
  hasPreparedRedoGridTransaction: vi.fn(() => false),
  undoStacks: new Map<string, GridTransactionRecord[]>(),
  redoStacks: new Map<string, GridTransactionRecord[]>(),
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
    updateCellsBatch: vi.fn(),
    updateDataset: vi.fn((datasetId: string, updates: Record<string, unknown>) => {
      if (state.currentDataset?.id === datasetId) {
        Object.assign(state.currentDataset, updates)
      }
      state.datasets = state.datasets.map((entry: any) =>
        entry.id === datasetId ? Object.assign(entry, updates) : entry
      )
    }),
    invalidateColumns: vi.fn(),
    allocateNextAutoColumnName: vi.fn(() => 'Column 2'),
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
    pasteInFlight: false,
    pasteFinalizing: false,
    projectDirty: false,
    projectDirtyRevision: 0,
    setPasteInFlight: vi.fn((inFlight: boolean) => {
      appState.pasteInFlight = inFlight
    }),
    setPasteFinalizing: vi.fn((finalizing: boolean) => {
      appState.pasteFinalizing = finalizing
    }),
    setProjectDirty: vi.fn((dirty: boolean) => {
      appState.projectDirty = dirty
      appState.projectDirtyRevision += 1
    }),
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

vi.mock('sonner', () => ({
  toast: toastHarness,
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
      const result = await editHarness.execute(edits, source)
      let maxRowIndex = Number.NEGATIVE_INFINITY
      for (const edit of edits) {
        if (edit.row > maxRowIndex) maxRowIndex = edit.row
      }
      if (Number.isFinite(maxRowIndex)) {
        config.bumpDataRowCount?.(maxRowIndex)
      }
      if (source !== 'formula' && !options?.skipProjectDirty) {
        config.markProjectDirty?.()
      }
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
    executeSingle: vi.fn(async (edit: any, source: string) => {
      const result = await editHarness.executeSingle(edit, source)
      config.setRowData((prev: Map<number, Record<string, unknown>>) => {
        const next = new Map(prev)
        const row = { ...(next.get(edit.row) ?? {}) }
        row[edit.columnId] = edit.newValue
        next.set(edit.row, row)
        return next
      })
      return result ?? { backendSyncSucceeded: true }
    }),
    applyDataStoreUpdate: editHarness.applyDataStoreUpdate,
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

vi.mock('@/store/data-store', () => ({ useDataStore: storeHarness.useDataStore }))

vi.mock('@/store/app-store', () => ({
  useAppStore: appStoreHarness.useAppStore,
  ensureProjectId: vi.fn().mockResolvedValue('project-1'),
}))

const makeSelection = (row: number, width = 1) => ({
  current: {
    cell: [0, row] as [number, number],
    range: { x: 0, y: row, width, height: 1 },
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

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )

  const MockDataEditor = React.forwardRef((props: any, _ref) => {
    gridHarness.getCellContent = props.getCellContent
    gridHarness.onCellEdited = props.onCellEdited
    gridHarness.editCell = props.onCellEdited
    return (
      <div>
        <button
          data-testid="select-row-0"
          onClick={() => props.onGridSelectionChange?.(makeSelection(0))}
        >
          row0
        </button>
        <button
          data-testid="select-row-0-wide"
          onClick={() => props.onGridSelectionChange?.(makeSelection(0, 2))}
        >
          row0-wide
        </button>
        <button
          data-testid="select-row-1"
          onClick={() => props.onGridSelectionChange?.(makeSelection(1))}
        >
          row1
        </button>
        <button
          data-testid="edit-row-0"
          onClick={() =>
            props.onCellEdited?.([0, 0], {
              kind: GridCellKind.Text,
              data: 'typed',
              displayData: 'typed',
              allowOverlay: true,
              readonly: false,
            })
          }
        >
          edit-row0
        </button>
        <button
          data-testid="edit-row-1"
          onClick={() =>
            props.onCellEdited?.([0, 1], {
              kind: GridCellKind.Text,
              data: 'typed-row1',
              displayData: 'typed-row1',
              allowOverlay: true,
              readonly: false,
            })
          }
        >
          edit-row1
        </button>
        <button
          data-testid="trigger-fill-pattern"
          onClick={() =>
            void props.onFillPattern?.({
              patternSource: { x: 0, y: 0, width: 1, height: 1 },
              fillDestination: { x: 0, y: 0, width: 1, height: 2 },
              preventDefault: vi.fn(),
            })
          }
        >
          fill
        </button>
      </div>
    )
  })
  MockDataEditor.displayName = 'MockDataEditor'

  return { ...actual, DataEditor: MockDataEditor }
})

describe('SpreadsheetView mutation visibility contract', () => {
  beforeEach(() => {
    resetSpreadsheetViewSharedOverlayStateForTests()
    keyboardHarness.handlers = null
    gridHarness.getCellContent = null
    gridHarness.onCellEdited = null
    gridHarness.editCell = null
    clipboardHarness.read.mockReset()
    clipboardHarness.write.mockClear()
    cacheHarness.insertRowsAt.mockReset()
    cacheHarness.insertRowsAt.mockResolvedValue(4)
    cacheHarness.getDatasetStorageInfo.mockReset()
    cacheHarness.getDatasetStorageInfo.mockResolvedValue({ isLarge: false, duckdbPath: 'test.duckdb' })
    cacheHarness.getAllColumnStats.mockReset()
    cacheHarness.getAllColumnStats.mockResolvedValue([{ columnId: 'col-1', nonNullCount: 10 }])
    cacheHarness.getPersistedColumnIds.mockReset()
    cacheHarness.getPersistedColumnIds.mockResolvedValue(['col-1'])
    cacheHarness.flushPendingUpdates.mockClear()
    cacheHarness.flushOverlay.mockReset()
    cacheHarness.flushOverlay.mockResolvedValue(undefined)
    cacheHarness.getRowsHybrid.mockReset()
    cacheHarness.getRowsHybrid.mockResolvedValue([])
    cacheHarness.appendRows.mockReset()
    cacheHarness.appendRows.mockResolvedValue(999)
    cacheHarness.getGridMutationQueueState.mockClear()
    cacheHarness.subscribeGridMutationQueue.mockClear()
    cacheHarness.retryGridMutationQueue.mockClear()
    cacheHarness.queueStates.clear()
    cacheHarness.queueListeners.clear()
    editHarness.execute.mockReset()
    editHarness.execute.mockResolvedValue({ backendSyncSucceeded: true })
    editHarness.executeSingle.mockReset()
    editHarness.executeSingle.mockResolvedValue({ backendSyncSucceeded: true })
    storeHarness.state.insertRowsAtDataset.mockClear()
    storeHarness.state.updateDataset.mockClear()

    storeHarness.dataset.rowCount = 100
    storeHarness.dataset.dataRowCount = 2
    storeHarness.dataset.columns = [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }] as any
    storeHarness.state.currentDataset = storeHarness.dataset
    storeHarness.state.datasets = [storeHarness.dataset]
    clipboardHarness.read.mockResolvedValue('a\nb\nc')
    tauriHarness.loadDataRows.mockClear()
    tauriHarness.evaluateFormulaRange.mockClear()
    undoHarness.undo.mockReset()
    undoHarness.undo.mockResolvedValue(null)
    undoHarness.redo.mockReset()
    undoHarness.redo.mockResolvedValue(null)
    undoHarness.recordGridTransaction.mockClear()
    undoHarness.prepareUndoGridTransaction.mockReset()
    undoHarness.commitUndoGridTransaction.mockReset()
    undoHarness.undoGridTransaction.mockReset()
    undoHarness.prepareRedoGridTransaction.mockReset()
    undoHarness.commitRedoGridTransaction.mockReset()
    undoHarness.redoGridTransaction.mockReset()
    undoHarness.rollbackUndoGridTransaction.mockReset()
    undoHarness.rollbackRedoGridTransaction.mockReset()
    undoHarness.hasPreparedUndoGridTransaction.mockReset()
    undoHarness.hasPreparedUndoGridTransaction.mockReturnValue(false)
    undoHarness.hasPreparedRedoGridTransaction.mockReset()
    undoHarness.hasPreparedRedoGridTransaction.mockReturnValue(false)
    undoHarness.clearGridTransactionHistory.mockClear()
    undoHarness.undoStacks.clear()
    undoHarness.redoStacks.clear()
    appStoreHarness.appState.pasteInFlight = false
    appStoreHarness.appState.pasteFinalizing = false
    appStoreHarness.appState.projectDirty = false
    appStoreHarness.appState.projectDirtyRevision = 0
    appStoreHarness.appState.setPasteInFlight.mockClear()
    appStoreHarness.appState.setPasteFinalizing.mockClear()
    appStoreHarness.appState.setProjectDirty.mockClear()
    toastHarness.info.mockClear()
    toastHarness.error.mockClear()
    toastHarness.success.mockClear()
    toastHarness.warning.mockClear()
  })

  it('keeps overflow paste visible without immediate backend row readback', async () => {
    storeHarness.dataset.rowCount = 2
    const deferredFlush = createDeferred<void>()
    cacheHarness.flushOverlay.mockReturnValueOnce(deferredFlush.promise)

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    await act(async () => {
      await Promise.resolve()
    })
    const readsBeforePaste = cacheHarness.getRowsHybrid.mock.calls.length

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalled()
    })

    expect(cacheHarness.appendRows).toHaveBeenCalledWith('dataset-1', 2)
    expect(storeHarness.state.insertRowsAtDataset).toHaveBeenCalledWith('dataset-1', 2, 2)
    expect(cacheHarness.getRowsHybrid.mock.calls.length).toBe(readsBeforePaste)
    expect(gridHarness.getCellContent).toBeTypeOf('function')

    const anchorCell = gridHarness.getCellContent?.([0, 1])
    const tailCell = gridHarness.getCellContent?.([0, 3])
    expect(anchorCell).toMatchObject({
      kind: GridCellKind.Text,
      data: 'a',
      displayData: 'a',
    })
    expect(tailCell).toMatchObject({
      kind: GridCellKind.Text,
      data: 'c',
      displayData: 'c',
    })

    deferredFlush.resolve()
    await act(async () => {
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'a',
      displayData: 'a',
    })
  })

  it('keeps overflow paste visible while execute is still pending', async () => {
    storeHarness.dataset.rowCount = 2
    const deferredExecute = createDeferred<{ backendSyncSucceeded: boolean }>()
    editHarness.execute.mockImplementationOnce(() => deferredExecute.promise)
    cacheHarness.flushOverlay.mockResolvedValue(undefined)

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      void keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cacheHarness.appendRows).toHaveBeenCalledWith('dataset-1', 2)
    expect(storeHarness.state.insertRowsAtDataset).toHaveBeenCalledWith('dataset-1', 2, 2)
    expect(gridHarness.getCellContent).toBeTypeOf('function')
    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'a',
      displayData: 'a',
    })
    expect(gridHarness.getCellContent?.([0, 3])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'c',
      displayData: 'c',
    })

    deferredExecute.resolve({ backendSyncSucceeded: true })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('keeps non-overflow paste visible without immediate backend row readback', async () => {
    const deferredFlush = createDeferred<void>()
    cacheHarness.flushOverlay.mockReturnValueOnce(deferredFlush.promise)
    storeHarness.dataset.dataRowCount = 10
    storeHarness.dataset.rowCount = 100
    clipboardHarness.read.mockResolvedValue('x\ny')

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    await act(async () => {
      await Promise.resolve()
    })
    const readsBeforePaste = cacheHarness.getRowsHybrid.mock.calls.length

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalled()
    })

    expect(cacheHarness.insertRowsAt).not.toHaveBeenCalled()
    expect(cacheHarness.getRowsHybrid.mock.calls.length).toBe(readsBeforePaste)
    expect(gridHarness.getCellContent).toBeTypeOf('function')

    const anchorCell = gridHarness.getCellContent?.([0, 1])
    const tailCell = gridHarness.getCellContent?.([0, 2])
    expect(anchorCell).toMatchObject({
      kind: GridCellKind.Text,
      data: 'x',
      displayData: 'x',
    })
    expect(tailCell).toMatchObject({
      kind: GridCellKind.Text,
      data: 'y',
      displayData: 'y',
    })

    deferredFlush.resolve()
    await act(async () => {
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'x',
      displayData: 'x',
    })
  })

  it('gives each staged paste mutation a flush completion path even when a prior flush is in flight', async () => {
    const firstFlush = createDeferred<void>()
    const secondFlush = createDeferred<void>()
    cacheHarness.flushOverlay
      .mockReturnValueOnce(firstFlush.promise)
      .mockReturnValueOnce(secondFlush.promise)

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(cacheHarness.flushOverlay).toHaveBeenCalledTimes(1)
    })

    clipboardHarness.read.mockResolvedValueOnce('second')
    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cacheHarness.flushOverlay).toHaveBeenCalledTimes(1)

    firstFlush.resolve()
    await waitFor(() => {
      expect(cacheHarness.flushOverlay).toHaveBeenCalledTimes(2)
    })

    secondFlush.resolve()
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('still runs the next queued paste flush when the first flush rejects', async () => {
    const firstFlush = createDeferred<void>()
    const secondFlush = createDeferred<void>()
    cacheHarness.flushOverlay
      .mockReturnValueOnce(firstFlush.promise)
      .mockReturnValueOnce(secondFlush.promise)

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(cacheHarness.flushOverlay).toHaveBeenCalledTimes(1)
    })

    clipboardHarness.read.mockResolvedValueOnce('second')
    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cacheHarness.flushOverlay).toHaveBeenCalledTimes(1)

    firstFlush.reject(new Error('flush failed'))
    await waitFor(() => {
      expect(cacheHarness.flushOverlay).toHaveBeenCalledTimes(2)
    })

    secondFlush.resolve()
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('clears all persisted inactive paste overlays on reactivation, not only the latest mutation', async () => {
    const firstFlush = createDeferred<void>()
    const secondFlush = createDeferred<void>()
    cacheHarness.flushOverlay
      .mockReturnValueOnce(firstFlush.promise)
      .mockReturnValueOnce(secondFlush.promise)

    storeHarness.dataset.dataRowCount = 10
    storeHarness.dataset.rowCount = 100

    const dataset2 = {
      id: 'dataset-2',
      name: 'dataset-2',
      rowCount: 100,
      dataRowCount: 10,
      columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
    } as any

    const view = render(<SpreadsheetView />)

    fireEvent.click(screen.getByTestId('select-row-0'))
    await act(async () => {
      await Promise.resolve()
    })

    clipboardHarness.read.mockResolvedValueOnce('first-row')
    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('select-row-1'))
    await act(async () => {
      await Promise.resolve()
    })

    clipboardHarness.read.mockResolvedValueOnce('second-row')
    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    storeHarness.state.currentDataset = dataset2
    storeHarness.state.datasets = [storeHarness.dataset, dataset2]
    view.rerender(<SpreadsheetView />)

    firstFlush.resolve()
    await waitFor(() => {
      expect(cacheHarness.flushOverlay).toHaveBeenCalledTimes(2)
    })
    secondFlush.resolve()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    cacheHarness.getRowsHybrid.mockImplementation((datasetId: string, start: number, end: number) => {
      if (datasetId !== 'dataset-1') return Promise.resolve([])
      const persistedRows = [
        { 'col-1': 'first-row' },
        { 'col-1': 'second-row' },
      ]
      return Promise.resolve(
        Array.from({ length: Math.max(0, end - start) }, (_, index) => persistedRows[start + index] ?? {})
      )
    })

    storeHarness.state.currentDataset = storeHarness.dataset
    view.rerender(<SpreadsheetView />)
    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        kind: GridCellKind.Text,
        data: 'first-row',
        displayData: 'first-row',
      })
      expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
        kind: GridCellKind.Text,
        data: 'second-row',
        displayData: 'second-row',
      })
      expect(screen.getByTestId('grid-overlay-state')).toHaveAttribute('data-overlay-row-count', '0')
      expect(screen.getByTestId('grid-overlay-state')).toHaveAttribute(
        'data-persisted-mutation-count',
        '0'
      )
    })
  })

  it('retires staged paste visibility after undo', async () => {
    storeHarness.dataset.dataRowCount = 10
    storeHarness.dataset.rowCount = 100
    clipboardHarness.read.mockResolvedValue('x')
    undoHarness.undo.mockResolvedValueOnce({
      type: 'BatchCellEdit',
      dataset_id: 'dataset-1',
      edits: [
        {
          row: 1,
          column: 'col-1',
          old_value: '',
          new_value: 'x',
        },
      ],
    })

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'x',
      displayData: 'x',
    })

    await act(async () => {
      await keyboardHarness.handlers.onUndo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: '',
      displayData: '',
    })
  })

  it('does not let stale staged rows shadow a later typed edit on the same cell', async () => {
    storeHarness.dataset.dataRowCount = 10
    storeHarness.dataset.rowCount = 100
    clipboardHarness.read.mockResolvedValue('staged-value')

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'staged-value',
      displayData: 'staged-value',
    })

    fireEvent.click(screen.getByTestId('edit-row-1'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'typed-row1',
      displayData: 'typed-row1',
    })
  })

  it('does not queue overlapping cuts while the first cut is still pending', async () => {
    const deferredFlush = createDeferred<void>()
    cacheHarness.flushPendingUpdates.mockReturnValueOnce(deferredFlush.promise)
    cacheHarness.getRowsHybrid.mockImplementation((datasetId: string, start: number, end: number) => {
      if (datasetId === 'dataset-1' && start === 1 && end === 2) {
        return Promise.resolve([{ 'col-1': 'later' }])
      }
      return Promise.resolve([])
    })

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))

    await act(async () => {
      void keyboardHarness.handlers.onCut?.()
      await Promise.resolve()
    })

    await act(async () => {
      void keyboardHarness.handlers.onCut?.()
      await Promise.resolve()
    })

    expect(cacheHarness.flushPendingUpdates).toHaveBeenCalledTimes(1)
    expect(clipboardHarness.write).not.toHaveBeenCalled()
    expect(editHarness.execute).not.toHaveBeenCalled()

    await act(async () => {
      deferredFlush.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(cacheHarness.flushPendingUpdates).toHaveBeenCalledTimes(1)
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-1', 1, 2)
      expect(toastHarness.warning).not.toHaveBeenCalled()
      expect(clipboardHarness.write).toHaveBeenCalledTimes(1)
      expect(editHarness.execute).toHaveBeenCalledTimes(1)
    })
  })

  it('does not reach cut mutation apply until flush, row read, and clipboard write complete', async () => {
    const deferredFlush = createDeferred<void>()
    const deferredRows = createDeferred<any[]>()
    const deferredWrite = createDeferred<void>()
    cacheHarness.flushPendingUpdates.mockReturnValueOnce(deferredFlush.promise)
    cacheHarness.getRowsHybrid.mockImplementation((datasetId: string, start: number, end: number) => {
      if (datasetId === 'dataset-1' && start === 1 && end === 2) {
        return deferredRows.promise
      }
      return Promise.resolve([])
    })
    clipboardHarness.write.mockReturnValueOnce(deferredWrite.promise)

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))

    await act(async () => {
      void keyboardHarness.handlers.onCut?.()
      await Promise.resolve()
    })

    expect(editHarness.execute).not.toHaveBeenCalled()

    await act(async () => {
      deferredFlush.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-1', 1, 2)
    expect(editHarness.execute).not.toHaveBeenCalled()

    await act(async () => {
      deferredRows.resolve([{ 'col-1': 'later' }])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(clipboardHarness.write).toHaveBeenCalledTimes(1)
    expect(editHarness.execute).not.toHaveBeenCalled()

    await act(async () => {
      deferredWrite.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalledTimes(1)
    })
  })

  it('uses local row data for cut payloads without backend row reads when the row is already loaded', async () => {
    const loadedRows = [{ 'col-1': 'row0' }, { 'col-1': 'typed-row1' }]
    tauriHarness.loadDataRows.mockImplementation(async (_datasetId: string, start: number, end: number) =>
      loadedRows.slice(start, end)
    )
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) =>
      loadedRows.slice(start, end)
    )

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
        kind: GridCellKind.Text,
        data: 'typed-row1',
        displayData: 'typed-row1',
      })
    })

    cacheHarness.flushPendingUpdates.mockClear()
    cacheHarness.getRowsHybrid.mockClear()
    clipboardHarness.write.mockClear()
    editHarness.execute.mockClear()

    await act(async () => {
      await keyboardHarness.handlers.onCut?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cacheHarness.getRowsHybrid).not.toHaveBeenCalled()
    expect(clipboardHarness.write).toHaveBeenCalledWith('typed-row1')
    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalledTimes(1)
    })
  })

  it('falls back to backend row reads for cut payloads when local row data is missing', async () => {
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([{ 'col-1': 'backend-row0' }])

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-0'))

    await act(async () => {
      await keyboardHarness.handlers.onCut?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cacheHarness.flushPendingUpdates).toHaveBeenCalledTimes(1)
    expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-1', 0, 1)
    expect(clipboardHarness.write).toHaveBeenCalledWith('backend-row0')
    expect(editHarness.execute).toHaveBeenCalledTimes(1)
  })

  it('abandons an in-flight cut when the active dataset changes before mutation apply', async () => {
    const deferredFlush = createDeferred<void>()
    cacheHarness.flushPendingUpdates.mockReturnValueOnce(deferredFlush.promise)
    const dataset2 = {
      id: 'dataset-2',
      name: 'dataset-2',
      rowCount: 100,
      dataRowCount: 2,
      columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
    } as any

    const view = render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))

    await act(async () => {
      void keyboardHarness.handlers.onCut?.()
      await Promise.resolve()
    })

    storeHarness.state.currentDataset = dataset2
    storeHarness.state.datasets = [storeHarness.dataset, dataset2]
    view.rerender(<SpreadsheetView />)

    deferredFlush.resolve()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(clipboardHarness.write).not.toHaveBeenCalled()
    expect(editHarness.execute).not.toHaveBeenCalled()
  })

  it('abandons an in-flight cut when the active dataset changes during backend row fetch', async () => {
    const deferredRows = createDeferred<any[]>()
    cacheHarness.getRowsHybrid.mockReturnValueOnce(deferredRows.promise)
    const dataset2 = {
      id: 'dataset-2',
      name: 'dataset-2',
      rowCount: 100,
      dataRowCount: 2,
      columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
    } as any

    const view = render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))

    await act(async () => {
      void keyboardHarness.handlers.onCut?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    storeHarness.state.currentDataset = dataset2
    storeHarness.state.datasets = [storeHarness.dataset, dataset2]
    view.rerender(<SpreadsheetView />)

    deferredRows.resolve([{ 'col-1': 'later' }])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(clipboardHarness.write).not.toHaveBeenCalled()
    expect(editHarness.execute).not.toHaveBeenCalled()
  })

  it('abandons an in-flight cut when the active dataset changes during clipboard write', async () => {
    const deferredWrite = createDeferred<void>()
    clipboardHarness.write.mockReturnValueOnce(deferredWrite.promise)
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([{ 'col-1': 'later' }])
    const dataset2 = {
      id: 'dataset-2',
      name: 'dataset-2',
      rowCount: 100,
      dataRowCount: 2,
      columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
    } as any

    const view = render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))

    await act(async () => {
      void keyboardHarness.handlers.onCut?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    storeHarness.state.currentDataset = dataset2
    storeHarness.state.datasets = [storeHarness.dataset, dataset2]
    view.rerender(<SpreadsheetView />)

    deferredWrite.resolve()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(editHarness.execute).not.toHaveBeenCalled()
  })

  it('clears the exported cut handler on unmount', async () => {
    const cutRegistration = { current: null as null | (() => void | Promise<void>) }
    const view = render(
      <SpreadsheetView
        onCutRequest={(cut) => {
          cutRegistration.current = cut
        }}
      />
    )

    expect(cutRegistration.current).toBeTypeOf('function')

    view.unmount()

    expect(cutRegistration.current).toBeNull()
  })

  it('rolls back visible optimistic paste state when backend enqueue fails', async () => {
    storeHarness.dataset.dataRowCount = 10
    storeHarness.dataset.rowCount = 100
    clipboardHarness.read.mockResolvedValue('rollback-me')
    editHarness.execute.mockResolvedValueOnce({ backendSyncSucceeded: false })
    appStoreHarness.appState.projectDirty = false

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: '',
      displayData: '',
    })
    expect(cacheHarness.flushOverlay).not.toHaveBeenCalled()
    expect(storeHarness.dataset.dataRowCount).toBe(10)
    expect(appStoreHarness.appState.projectDirty).toBe(false)
    expect(appStoreHarness.appState.setProjectDirty).toHaveBeenLastCalledWith(false)
  })

  it('replays overflow paste undo through SpreadsheetView without shifted-row corruption', async () => {
    storeHarness.dataset.dataRowCount = 2
    storeHarness.dataset.rowCount = 100
    clipboardHarness.read.mockResolvedValue('A\nB\nC')

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'A',
      displayData: 'A',
    })

    undoHarness.prepareUndoGridTransaction.mockResolvedValueOnce({
      id: 'undo-overflow-1',
      datasetId: 'dataset-1',
      kind: 'undo',
      edits: [{ row: 1, columnId: 'col-1', oldValue: 'A', newValue: '' }],
      structural: { removedRows: [{ start: 2, count: 2 }] },
    })

    await act(async () => {
      await keyboardHarness.handlers.onUndo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cacheHarness.removeRowAt.mock.calls).toEqual([
      ['dataset-1', 3],
      ['dataset-1', 2],
    ])
    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: '',
      displayData: '',
    })
    expect(editHarness.execute).toHaveBeenLastCalledWith(
      [expect.objectContaining({ row: 1, columnId: 'col-1', oldValue: 'A' })],
      'undo'
    )
    expect(undoHarness.commitUndoGridTransaction).toHaveBeenCalledWith('dataset-1')
  })

  it('keeps frontend undo/redo stacks unchanged when undo replay is rejected', async () => {
    storeHarness.dataset.dataRowCount = 10
    storeHarness.dataset.rowCount = 100
    clipboardHarness.read.mockResolvedValue('seed')

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(undoHarness.undoStacks.get('dataset-1')).toHaveLength(1)
    expect(undoHarness.redoStacks.get('dataset-1') ?? []).toHaveLength(0)

    editHarness.execute.mockResolvedValueOnce({ backendSyncSucceeded: false })

    await act(async () => {
      await keyboardHarness.handlers.onUndo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'seed',
      displayData: 'seed',
    })
    expect(undoHarness.undoStacks.get('dataset-1')).toHaveLength(1)
    expect(undoHarness.redoStacks.get('dataset-1') ?? []).toHaveLength(0)
    expect(undoHarness.commitUndoGridTransaction).not.toHaveBeenCalled()
  })

  it('blocks undo when the active dataset queue is failed', async () => {
    undoHarness.undoStacks.set('dataset-1', [
      {
        id: 'tx-undo-block',
        datasetId: 'dataset-1',
        kind: 'paste',
        edits: [{ row: 1, columnId: 'col-1', oldValue: '', newValue: 'seed' }],
      },
    ])
    cacheHarness.queueStates.set('dataset-1', {
      status: 'failed',
      failedQueueId: 'dataset-1:queue:1',
      error: 'Persist drain failed',
    })

    render(<SpreadsheetView />)

    let result = false
    await act(async () => {
      result = (await keyboardHarness.handlers.onUndo?.()) ?? false
      await Promise.resolve()
    })

    expect(result).toBe(true)
    expect(cacheHarness.getGridMutationQueueState).toHaveBeenCalledWith('dataset-1')
    expect(undoHarness.prepareUndoGridTransaction).toHaveBeenCalledWith('dataset-1')
    expect(undoHarness.rollbackUndoGridTransaction).toHaveBeenCalledWith('dataset-1')
    expect(undoHarness.undoGridTransaction).not.toHaveBeenCalled()
    expect(undoHarness.undo).not.toHaveBeenCalled()
    expect(undoHarness.undoStacks.get('dataset-1')).toHaveLength(1)
    expect(undoHarness.redoStacks.get('dataset-1') ?? []).toHaveLength(0)
  })

  it('does not fall through to legacy undo paths while a frontend undo reservation is already pending', async () => {
    undoHarness.prepareUndoGridTransaction.mockResolvedValueOnce(null)
    undoHarness.hasPreparedUndoGridTransaction.mockReturnValueOnce(true)

    render(<SpreadsheetView />)

    let result = false
    await act(async () => {
      result = (await keyboardHarness.handlers.onUndo?.()) ?? false
      await Promise.resolve()
    })

    expect(result).toBe(true)
    expect(undoHarness.prepareUndoGridTransaction).toHaveBeenCalledWith('dataset-1')
    expect(undoHarness.undoGridTransaction).not.toHaveBeenCalled()
    expect(undoHarness.undo).not.toHaveBeenCalled()
  })

  it('blocks redo when the active dataset queue is failed', async () => {
    undoHarness.redoStacks.set('dataset-1', [
      {
        id: 'tx-redo-block',
        datasetId: 'dataset-1',
        kind: 'paste',
        edits: [{ row: 1, columnId: 'col-1', oldValue: '', newValue: 'seed' }],
      },
    ])
    cacheHarness.queueStates.set('dataset-1', {
      status: 'failed',
      failedQueueId: 'dataset-1:queue:2',
      error: 'Persist drain failed',
    })

    render(<SpreadsheetView />)

    let result = false
    await act(async () => {
      result = (await keyboardHarness.handlers.onRedo?.()) ?? false
      await Promise.resolve()
    })

    expect(result).toBe(true)
    expect(cacheHarness.getGridMutationQueueState).toHaveBeenCalledWith('dataset-1')
    expect(undoHarness.prepareRedoGridTransaction).toHaveBeenCalledWith('dataset-1')
    expect(undoHarness.rollbackRedoGridTransaction).toHaveBeenCalledWith('dataset-1')
    expect(undoHarness.redoGridTransaction).not.toHaveBeenCalled()
    expect(undoHarness.redo).not.toHaveBeenCalled()
    expect(undoHarness.redoStacks.get('dataset-1')).toHaveLength(1)
    expect(undoHarness.undoStacks.get('dataset-1') ?? []).toHaveLength(0)
  })

  it('does not fall through to legacy redo paths while a frontend redo reservation is already pending', async () => {
    undoHarness.prepareRedoGridTransaction.mockResolvedValueOnce(null)
    undoHarness.hasPreparedRedoGridTransaction.mockReturnValueOnce(true)

    render(<SpreadsheetView />)

    let result = false
    await act(async () => {
      result = (await keyboardHarness.handlers.onRedo?.()) ?? false
      await Promise.resolve()
    })

    expect(result).toBe(true)
    expect(undoHarness.prepareRedoGridTransaction).toHaveBeenCalledWith('dataset-1')
    expect(undoHarness.redoGridTransaction).not.toHaveBeenCalled()
    expect(undoHarness.redo).not.toHaveBeenCalled()
  })

  it('does not consume backend undo when the dataset queue is failed on the fallback path', async () => {
    undoHarness.prepareUndoGridTransaction.mockResolvedValueOnce(null)
    cacheHarness.queueStates.set('dataset-1', {
      status: 'failed',
      failedQueueId: 'dataset-1:queue:fallback-undo',
      error: 'Persist drain failed',
    })

    render(<SpreadsheetView />)

    let result = false
    await act(async () => {
      result = (await keyboardHarness.handlers.onUndo?.()) ?? false
      await Promise.resolve()
    })

    expect(result).toBe(true)
    expect(undoHarness.undo).not.toHaveBeenCalled()
  })

  it('does not consume backend redo when the dataset queue is failed on the fallback path', async () => {
    undoHarness.prepareRedoGridTransaction.mockResolvedValueOnce(null)
    cacheHarness.queueStates.set('dataset-1', {
      status: 'failed',
      failedQueueId: 'dataset-1:queue:fallback-redo',
      error: 'Persist drain failed',
    })

    render(<SpreadsheetView />)

    let result = false
    await act(async () => {
      result = (await keyboardHarness.handlers.onRedo?.()) ?? false
      await Promise.resolve()
    })

    expect(result).toBe(true)
    expect(undoHarness.redo).not.toHaveBeenCalled()
  })

  it('re-enables undo after explicit queue retry clears the failed state', async () => {
    undoHarness.undoStacks.set('dataset-1', [
      {
        id: 'tx-undo-retry',
        datasetId: 'dataset-1',
        kind: 'paste',
        edits: [{ row: 1, columnId: 'col-1', oldValue: '', newValue: 'seed' }],
      },
    ])
    cacheHarness.queueStates.set('dataset-1', {
      status: 'failed',
      failedQueueId: 'dataset-1:queue:3',
      error: 'Persist drain failed',
    })
    cacheHarness.retryGridMutationQueue.mockImplementationOnce(async (datasetId: string) => {
      cacheHarness.emitGridMutationQueueState(datasetId, {
        status: 'idle',
        failedQueueId: null,
        error: null,
      })
    })

    render(<SpreadsheetView />)

    await act(async () => {
      await keyboardHarness.handlers.onUndo?.()
      await Promise.resolve()
    })

    expect(toastHarness.warning).toHaveBeenCalled()
    const warningOptions = toastHarness.warning.mock.calls.at(-1)?.[1]
    expect(warningOptions?.action?.label).toBe('Retry sync')

    await act(async () => {
      await warningOptions.action.onClick()
      await Promise.resolve()
    })

    expect(cacheHarness.retryGridMutationQueue).toHaveBeenCalledWith('dataset-1')

    await act(async () => {
      await keyboardHarness.handlers.onUndo?.()
      await Promise.resolve()
    })

    expect(undoHarness.prepareUndoGridTransaction).toHaveBeenCalled()
  })

  it('blocks replay using the transaction dataset queue state, not only the current dataset closure', async () => {
    undoHarness.prepareUndoGridTransaction.mockResolvedValueOnce({
      id: 'undo-other-dataset',
      datasetId: 'dataset-2',
      kind: 'undo',
      edits: [{ row: 0, columnId: 'col-1', oldValue: 'a', newValue: '' }],
    })
    cacheHarness.queueStates.set('dataset-2', {
      status: 'failed',
      failedQueueId: 'dataset-2:queue:1',
      error: 'Other dataset queue failed',
    })

    render(<SpreadsheetView />)

    await act(async () => {
      await keyboardHarness.handlers.onUndo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cacheHarness.getGridMutationQueueState).toHaveBeenCalledWith('dataset-2')
    expect(undoHarness.commitUndoGridTransaction).not.toHaveBeenCalled()
  })

  it('undoes and redoes mixed paste then type in chronological order', async () => {
    storeHarness.dataset.dataRowCount = 10
    storeHarness.dataset.rowCount = 100
    clipboardHarness.read.mockResolvedValue('paste')

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('edit-row-0'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'typed',
      displayData: 'typed',
    })
    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'paste',
      displayData: 'paste',
    })

    await act(async () => {
      await keyboardHarness.handlers.onUndo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: '',
      displayData: '',
    })
    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'paste',
      displayData: 'paste',
    })

    await act(async () => {
      await keyboardHarness.handlers.onUndo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: '',
      displayData: '',
    })

    await act(async () => {
      await keyboardHarness.handlers.onRedo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'paste',
      displayData: 'paste',
    })

    await act(async () => {
      await keyboardHarness.handlers.onRedo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'typed',
      displayData: 'typed',
    })
  })

  it('undoes and redoes mixed paste then formula-bar commit in chronological order', async () => {
    storeHarness.dataset.dataRowCount = 10
    storeHarness.dataset.rowCount = 100
    clipboardHarness.read.mockResolvedValue('paste-value')

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-1'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'paste-value',
      displayData: 'paste-value',
    })

    fireEvent.click(screen.getByTestId('select-row-0'))
    const formulaBar = screen.getByPlaceholderText(/type a value or formula/i)
    fireEvent.focus(formulaBar)
    fireEvent.change(formulaBar, { target: { value: 'formula-bar-value' } })

    await act(async () => {
      fireEvent.keyDown(formulaBar, { key: 'Enter' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'formula-bar-value',
      displayData: 'formula-bar-value',
    })

    await act(async () => {
      await keyboardHarness.handlers.onUndo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: '',
      displayData: '',
    })
    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'paste-value',
      displayData: 'paste-value',
    })

    await act(async () => {
      await keyboardHarness.handlers.onUndo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: '',
      displayData: '',
    })

    await act(async () => {
      await keyboardHarness.handlers.onRedo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'paste-value',
      displayData: 'paste-value',
    })
    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: '',
      displayData: '',
    })

    await act(async () => {
      await keyboardHarness.handlers.onRedo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'formula-bar-value',
      displayData: 'formula-bar-value',
    })
  })

  it('undoes and redoes mixed paste then fill in chronological order', async () => {
    storeHarness.dataset.dataRowCount = 10
    storeHarness.dataset.rowCount = 100
    clipboardHarness.read.mockResolvedValue('seed')

    render(<SpreadsheetView />)
    fireEvent.click(screen.getByTestId('select-row-0'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'seed',
      displayData: 'seed',
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('trigger-fill-pattern'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'seed',
      displayData: 'seed',
    })

    await act(async () => {
      await keyboardHarness.handlers.onUndo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'seed',
      displayData: 'seed',
    })
    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: '',
      displayData: '',
    })

    await act(async () => {
      await keyboardHarness.handlers.onUndo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: '',
      displayData: '',
    })

    await act(async () => {
      await keyboardHarness.handlers.onRedo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'seed',
      displayData: 'seed',
    })
    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: '',
      displayData: '',
    })

    await act(async () => {
      await keyboardHarness.handlers.onRedo?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'seed',
      displayData: 'seed',
    })
  })
})
