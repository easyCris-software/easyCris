import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { CompactSelection } from '@glideapps/glide-data-grid'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridMutationQueueState } from '@/lib/grid/types'

let SpreadsheetView: typeof import('../SpreadsheetView').default

const keyboardHarness = vi.hoisted(() => ({ handlers: null as any }))
const gridHarness = vi.hoisted(
  () =>
    ({
      getCellContent: null as null | ((cell: [number, number]) => any),
      onVisibleRegionChanged: null as null | ((range: { x: number; y: number; width: number; height: number }) => void),
    }) as {
      getCellContent: null | ((cell: [number, number]) => any)
      onVisibleRegionChanged: null | ((range: { x: number; y: number; width: number; height: number }) => void)
    }
)
const clipboardHarness = vi.hoisted(() => ({
  read: vi.fn<() => Promise<string>>(),
  write: vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined),
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
  getRowsHybrid: vi.fn().mockResolvedValue([]),
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
  recordGridTransaction: vi.fn().mockResolvedValue(undefined),
}))
const storeHarness = vi.hoisted(() => {
  const dataset = {
    id: 'dataset-1',
    name: 'dataset-1',
    rowCount: 1000,
    dataRowCount: 800,
    columns: [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Group', type: 'text', width: 88 },
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
    updateCellsBatch: vi.fn(),
    updateDataset: vi.fn(),
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

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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
    applyDataStoreUpdate: vi.fn(),
    execute: vi.fn(async (edits: any[], source: string) => {
      const result = await editHarness.execute(edits, source)
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

vi.mock('@/components/dialogs/OutlineDialog', () => ({
  OutlineDialog: ({ open, columnMetadata, onApply }: any) => {
    if (!open) return null
    return (
      <div data-testid="outline-dialog">
        {(columnMetadata ?? []).map((col: any) => (
          <button
            key={col.id}
            data-testid={`outline-apply-${col.id}`}
            onClick={() => onApply?.(col.id)}
          >
            Apply {col.name}
          </button>
        ))}
      </div>
    )
  },
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

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )

  const MockDataEditor = React.forwardRef((props: any, _ref) => {
    gridHarness.getCellContent = props.getCellContent
    gridHarness.onVisibleRegionChanged = props.onVisibleRegionChanged
    return (
      <div>
        <button data-testid="select-row-600" onClick={() => props.onGridSelectionChange?.(makeSelection(600))}>
          row600
        </button>
        <button
          data-testid="show-row-600"
          onClick={() => props.onVisibleRegionChanged?.({ x: 0, y: 600, width: 1, height: 1 })}
        >
          viewport600
        </button>
        <button
          data-testid="show-row-0"
          onClick={() => props.onVisibleRegionChanged?.({ x: 0, y: 0, width: 1, height: 1 })}
        >
          viewport0
        </button>
      </div>
    )
  })
  MockDataEditor.displayName = 'MockDataEditor'

  return { ...actual, DataEditor: MockDataEditor }
})

describe('SpreadsheetView block dirty state', () => {
  beforeEach(async () => {
    vi.resetModules()
    SpreadsheetView = (await import('../SpreadsheetView')).default
    keyboardHarness.handlers = null
    gridHarness.getCellContent = null
    gridHarness.onVisibleRegionChanged = null
    clipboardHarness.read.mockReset()
    clipboardHarness.read.mockResolvedValue('x')
    cacheHarness.getDatasetStorageInfo.mockReset()
    cacheHarness.getDatasetStorageInfo.mockResolvedValue({ isLarge: false, duckdbPath: 'test.duckdb' })
    cacheHarness.getAllColumnStats.mockReset()
    cacheHarness.getAllColumnStats.mockResolvedValue([])
    cacheHarness.getPersistedColumnIds.mockReset()
    cacheHarness.getPersistedColumnIds.mockResolvedValue(['col-1'])
    cacheHarness.ensureLatestCache.mockReset()
    cacheHarness.ensureLatestCache.mockResolvedValue(undefined)
    cacheHarness.getLazyGroupMetadata.mockReset()
    cacheHarness.getLazyGroupMetadata.mockResolvedValue({ groups: [] })
    cacheHarness.getGroupRows.mockReset()
    cacheHarness.getGroupRows.mockResolvedValue([])
    cacheHarness.flushPendingUpdates.mockClear()
    cacheHarness.flushOverlay.mockReset()
    cacheHarness.flushOverlay.mockResolvedValue(undefined)
    cacheHarness.getRowsHybrid.mockReset()
    cacheHarness.getRowsHybrid.mockResolvedValue([])
    cacheHarness.getGridMutationQueueState.mockClear()
    cacheHarness.subscribeGridMutationQueue.mockClear()
    cacheHarness.retryGridMutationQueue.mockClear()
    cacheHarness.queueStates.clear()
    cacheHarness.queueListeners.clear()
    editHarness.execute.mockReset()
    editHarness.execute.mockResolvedValue({ backendSyncSucceeded: true })
    editHarness.executeSingle.mockReset()
    editHarness.executeSingle.mockResolvedValue({ backendSyncSucceeded: true })
    storeHarness.dataset.rowCount = 1000
    storeHarness.dataset.dataRowCount = 800
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Group', type: 'text', width: 88 },
    ] as any
    storeHarness.state.currentDataset = storeHarness.dataset
    storeHarness.state.datasets = [storeHarness.dataset]
    appStoreHarness.appState.pasteInFlight = false
    appStoreHarness.appState.setPasteInFlight.mockClear()
  }, 20000)

  it('materializes empty rows when an in-range block load returns no backend rows', async () => {
    cacheHarness.getRowsHybrid.mockResolvedValue([])

    render(<SpreadsheetView />)
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('show-row-0'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalled()
    })

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: '',
        displayData: '',
        allowOverlay: true,
        readonly: false,
      })
    })
  }, 10000)

  it('materializes blank scaffold rows loaded before committed data rows exist', async () => {
    storeHarness.dataset.rowCount = 100
    storeHarness.dataset.dataRowCount = 0
    cacheHarness.getRowsHybrid.mockResolvedValue([])

    render(<SpreadsheetView />)
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('show-row-0'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalled()
    })

    storeHarness.dataset.dataRowCount = 5

    expect(gridHarness.getCellContent?.([0, 3])).toMatchObject({
      data: '',
      displayData: '',
      allowOverlay: true,
      readonly: false,
    })
  }, 10000)

  it('does not force an immediate backend reload for offscreen touched blocks, but reloads when they enter view', async () => {
    render(<SpreadsheetView />)
    await act(async () => {
      await Promise.resolve()
    })
    const readsBeforePaste = cacheHarness.getRowsHybrid.mock.calls.length

    fireEvent.click(screen.getByTestId('select-row-600'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cacheHarness.getRowsHybrid.mock.calls.length).toBe(readsBeforePaste)

    fireEvent.click(screen.getByTestId('show-row-600'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalled()
    })
  }, 10000)

  it('does not dirty and refetch a block after pasting into an already materialized row', async () => {
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) =>
      Array.from({ length: end - start }, (_, index) => ({
        'col-1': start + index === 600 ? 'loaded-before-paste' : '',
      }))
    )

    render(<SpreadsheetView />)
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('show-row-600'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 600])).toMatchObject({
        data: 'loaded-before-paste',
        displayData: 'loaded-before-paste',
      })
    })

    fireEvent.click(screen.getByTestId('select-row-600'))
    await act(async () => {
      await Promise.resolve()
    })

    clipboardHarness.read.mockResolvedValueOnce('pasted')
    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 600])).toMatchObject({
        data: 'pasted',
        displayData: 'pasted',
      })
    })

    cacheHarness.getRowsHybrid.mockClear()

    act(() => {
      gridHarness.onVisibleRegionChanged?.({ x: 0, y: 601, width: 1, height: 1 })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    expect(cacheHarness.getRowsHybrid).not.toHaveBeenCalled()
  }, 10000)

  it('drops stale offscreen block reload results after a newer local mutation revision', async () => {
    const deferredRows = (() => {
      let resolve!: (value: Array<Record<string, unknown>>) => void
      const promise = new Promise<Array<Record<string, unknown>>>((res) => {
        resolve = res
      })
      return { promise, resolve }
    })()

    let sawDeferredLoad = false
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) => {
      if (start === 512 && end === 1000 && !sawDeferredLoad) {
        sawDeferredLoad = true
        return deferredRows.promise
      }
      return []
    })

    clipboardHarness.read.mockResolvedValueOnce('first')

    render(<SpreadsheetView />)
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('select-row-600'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('show-row-600'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    await waitFor(() => {
      expect(sawDeferredLoad).toBe(true)
    })

    clipboardHarness.read.mockResolvedValueOnce('second')
    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    deferredRows.resolve(Array.from({ length: 288 }, (_, index) => ({ 'col-1': `stale-${index}` })))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 600])).toMatchObject({
      data: 'second',
      displayData: 'second',
    })
  }, 10000)

  it('drops an in-flight range load that resolves after a cut clears the same cell locally', async () => {
    const deferredRows = createDeferred<any[]>()
    let sawDeferredLoad = false
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) => {
      if (start === 512 && end === 1000 && !sawDeferredLoad) {
        sawDeferredLoad = true
        return deferredRows.promise
      }
      if (start === 600 && end === 601) {
        return [{ 'col-1': 'stale-backend' }]
      }
      return []
    })

    render(<SpreadsheetView />)
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('show-row-600'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    await waitFor(() => {
      expect(sawDeferredLoad).toBe(true)
    })

    fireEvent.click(screen.getByTestId('select-row-600'))
    await act(async () => {
      await keyboardHarness.handlers.onCut?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 600])).toMatchObject({
      data: '',
      displayData: '',
    })

    const staleRows = Array.from({ length: 488 }, () => ({} as Record<string, unknown>))
    staleRows[88] = { 'col-1': 'stale-backend' }
    deferredRows.resolve(staleRows)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 600])).toMatchObject({
      data: '',
      displayData: '',
    })
  }, 10000)

  it('does not dirty or reload an offscreen block after a rejected paste rollback', async () => {
    editHarness.execute.mockResolvedValueOnce({ backendSyncSucceeded: false })

    render(<SpreadsheetView />)
    await act(async () => {
      await Promise.resolve()
    })
    const readsBeforePaste = cacheHarness.getRowsHybrid.mock.calls.length

    fireEvent.click(screen.getByTestId('select-row-600'))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cacheHarness.getRowsHybrid.mock.calls.length).toBe(readsBeforePaste)

    fireEvent.click(screen.getByTestId('show-row-600'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    expect(cacheHarness.getRowsHybrid.mock.calls.length).toBe(readsBeforePaste)
  }, 10000)

  it('does not duplicate lazy-grouped row loads for the same group while a grouped fetch is already pending', async () => {
    let openOutline!: () => void
    const deferredGroupRows = (() => {
      let resolve!: (value: number[]) => void
      const promise = new Promise<number[]>((res) => {
        resolve = res
      })
      return { promise, resolve }
    })()
    cacheHarness.getDatasetStorageInfo.mockResolvedValue({ isLarge: true, duckdbPath: 'test.duckdb' })
    cacheHarness.getAllColumnStats.mockResolvedValue([
      { columnId: 'col-1', nonNullCount: 10 },
      { columnId: 'col-2', nonNullCount: 10 },
    ])
    cacheHarness.getLazyGroupMetadata.mockResolvedValue({
      groups: [
        { key: 'A', size: 3, firstRowIndex: 0 },
        { key: 'B', size: 3, firstRowIndex: 10 },
      ],
    })
    cacheHarness.getGroupRows.mockReturnValueOnce(deferredGroupRows.promise)

    render(
      <SpreadsheetView
        onGroupDialogRequest={(open) => {
          openOutline = open
        }}
      />
    )

    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await openOutline()
    })

    await waitFor(() => {
      expect(screen.getByTestId('outline-dialog')).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('outline-apply-col-2'))
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(cacheHarness.getGroupRows.mock.calls.length).toBeGreaterThanOrEqual(1)
    })
    const callsWhilePending = cacheHarness.getGroupRows.mock.calls.length

    fireEvent.click(screen.getByTestId('show-row-0'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    fireEvent.click(screen.getByTestId('show-row-600'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    const groupLoadKeys = cacheHarness.getGroupRows.mock.calls.map((call) =>
      JSON.stringify([call[0], call[1], call[2], call[3], call[4], call[5], call[6]])
    )
    expect(new Set(groupLoadKeys).size).toBe(groupLoadKeys.length)
    expect(cacheHarness.getGroupRows.mock.calls.length).toBeGreaterThanOrEqual(callsWhilePending)

    deferredGroupRows.resolve([0])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }, 10000)
})
