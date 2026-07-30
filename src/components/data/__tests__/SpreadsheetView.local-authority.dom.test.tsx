import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { CompactSelection, GridCellKind } from '@glideapps/glide-data-grid'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridMutationQueueState } from '@/lib/grid/types'

let SpreadsheetView: typeof import('../SpreadsheetView').default
let resetSpreadsheetViewSharedOverlayStateForTests: typeof import('../SpreadsheetView').resetSpreadsheetViewSharedOverlayStateForTests
let getSpreadsheetViewOverlayRowForTests: typeof import('../SpreadsheetView').getSpreadsheetViewOverlayRowForTests
let getSpreadsheetViewMergedRowForTests: typeof import('../SpreadsheetView').getSpreadsheetViewMergedRowForTests
let seedSpreadsheetViewOverlayBaseRowForTests: typeof import('../SpreadsheetView').seedSpreadsheetViewOverlayBaseRowForTests

const keyboardHarness = vi.hoisted(() => ({ handlers: null as any }))
const gridHarness = vi.hoisted(
  () =>
    ({
      getCellContent: null as null | ((cell: [number, number]) => any),
      onCellEdited: null as null | ((cell: [number, number], value: any) => void),
      onVisibleRegionChanged: null as null | ((range: { x: number; y: number; width: number; height: number }) => void),
    }) as {
      getCellContent: null | ((cell: [number, number]) => any)
      onCellEdited: null | ((cell: [number, number], value: any) => void)
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
  getPersistedColumnIds: vi.fn().mockResolvedValue(['col-1', 'col-2']),
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
    rowCount: 100,
    dataRowCount: 10,
    columns: [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Column 2', type: 'text', width: 88 },
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
    families: [{ id: 'statistics-1', datasetId: 'dataset-1' }],
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

vi.mock('@/services/cacheService', () => ({ default: cacheHarness }))

vi.mock('@/lib/grid/editExecutor', () => ({
  createEditExecutor: vi.fn((config: any) => ({
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
  OutlineDialog: () => null,
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
    gridHarness.onCellEdited = props.onCellEdited
    gridHarness.onVisibleRegionChanged = props.onVisibleRegionChanged
    return (
      <div>
        <button
          data-testid="select-row-0"
          onClick={() => props.onGridSelectionChange?.(makeSelection(0))}
        >
          select-row-0
        </button>
        <button
          data-testid="edit-row-0"
          onClick={() =>
            props.onCellEdited?.([0, 0], {
              kind: GridCellKind.Text,
              data: 'typed-local',
              displayData: 'typed-local',
              allowOverlay: true,
              readonly: false,
            })
          }
        >
          edit-row-0
        </button>
        <button
          data-testid="show-row-0"
          onClick={() => props.onVisibleRegionChanged?.({ x: 0, y: 0, width: 2, height: 1 })}
        >
          show-row-0
        </button>
      </div>
    )
  })
  MockDataEditor.displayName = 'MockDataEditor'

  return { ...actual, DataEditor: MockDataEditor }
})

describe('SpreadsheetView local authority', () => {
  beforeEach(async () => {
    vi.resetModules()
    const spreadsheetModule = await import('../SpreadsheetView')
    SpreadsheetView = spreadsheetModule.default
    resetSpreadsheetViewSharedOverlayStateForTests =
      spreadsheetModule.resetSpreadsheetViewSharedOverlayStateForTests
    getSpreadsheetViewOverlayRowForTests = spreadsheetModule.getSpreadsheetViewOverlayRowForTests
    getSpreadsheetViewMergedRowForTests = spreadsheetModule.getSpreadsheetViewMergedRowForTests
    seedSpreadsheetViewOverlayBaseRowForTests =
      spreadsheetModule.seedSpreadsheetViewOverlayBaseRowForTests
    resetSpreadsheetViewSharedOverlayStateForTests()

    keyboardHarness.handlers = null
    gridHarness.getCellContent = null
    gridHarness.onCellEdited = null
    gridHarness.onVisibleRegionChanged = null
    clipboardHarness.read.mockReset()
    clipboardHarness.write.mockClear()
    cacheHarness.getDatasetStorageInfo.mockReset()
    cacheHarness.getDatasetStorageInfo.mockResolvedValue({ isLarge: false, duckdbPath: 'test.duckdb' })
    cacheHarness.getAllColumnStats.mockReset()
    cacheHarness.getAllColumnStats.mockResolvedValue([])
    cacheHarness.getPersistedColumnIds.mockReset()
    cacheHarness.getPersistedColumnIds.mockResolvedValue(['col-1', 'col-2'])
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
    storeHarness.dataset.rowCount = 100
    storeHarness.dataset.dataRowCount = 10
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Column 2', type: 'text', width: 88 },
    ] as any
    storeHarness.state.currentDataset = storeHarness.dataset
    storeHarness.state.datasets = [storeHarness.dataset]
    appStoreHarness.appState.pasteInFlight = false
    appStoreHarness.appState.setPasteInFlight.mockClear()
  }, 20000)

  it('keeps a locally edited cell visible while merging untouched backend columns from a stale range load', async () => {
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-1': 'backend-stale', 'col-2': 'backend-untouched' },
    ])

    render(<SpreadsheetView />)
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('edit-row-0'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'typed-local',
      displayData: 'typed-local',
    })

    fireEvent.click(screen.getByTestId('show-row-0'))
    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-1', 0, 100)
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'typed-local',
      displayData: 'typed-local',
    })
    expect(gridHarness.getCellContent?.([1, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'backend-untouched',
      displayData: 'backend-untouched',
    })
  })

  it('reads base-only rows via rowDataRef when no overlay exists for that row', async () => {
    seedSpreadsheetViewOverlayBaseRowForTests('dataset-1', 1, {
      'col-1': 'ghost-model-row-1',
      'col-2': 'ghost-model-sibling',
    })
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-1': 'backend-row-0', 'col-2': 'backend-sibling-0' },
      { 'col-1': 'backend-row-1', 'col-2': 'backend-sibling-1' },
    ])

    render(<SpreadsheetView />)
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      gridHarness.onVisibleRegionChanged?.({ x: 0, y: 0, width: 2, height: 2 })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-1', 0, 100)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('edit-row-0'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'backend-row-1',
      displayData: 'backend-row-1',
    })
  })

  it('seeds merged overlay rows with loaded sibling columns for direct model reads', async () => {
    const deferredExecute = (() => {
      let resolve!: (value: { backendSyncSucceeded: boolean }) => void
      const promise = new Promise<{ backendSyncSucceeded: boolean }>((res) => {
        resolve = res
      })
      return { promise, resolve }
    })()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-1': 'backend-original', 'col-2': 'backend-sibling' },
    ])
    editHarness.execute.mockImplementationOnce(() => deferredExecute.promise)

    render(<SpreadsheetView />)
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('show-row-0'))
    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-1', 0, 100)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('edit-row-0'))
    await waitFor(() => {
      expect(getSpreadsheetViewOverlayRowForTests('dataset-1', 0)).toMatchObject({
        'col-1': expect.objectContaining({ value: 'typed-local', status: 'pending' }),
      })
      expect(getSpreadsheetViewMergedRowForTests('dataset-1', 0)).toMatchObject({
        'col-1': 'typed-local',
        'col-2': 'backend-sibling',
      })
    })
    expect(gridHarness.getCellContent?.([1, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'backend-sibling',
      displayData: 'backend-sibling',
    })

    deferredExecute.resolve({ backendSyncSucceeded: true })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('does not merge a new overlay with stale model base when the row is currently unloaded', async () => {
    const deferredExecute = (() => {
      let resolve!: (value: { backendSyncSucceeded: boolean }) => void
      const promise = new Promise<{ backendSyncSucceeded: boolean }>((res) => {
        resolve = res
      })
      return { promise, resolve }
    })()
    editHarness.execute.mockImplementationOnce(() => deferredExecute.promise)
    seedSpreadsheetViewOverlayBaseRowForTests('dataset-1', 0, {
      'col-1': 'stale-base',
      'col-2': 'ghost-sibling',
    })

    render(<SpreadsheetView />)
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('edit-row-0'))
    await waitFor(() => {
      expect(getSpreadsheetViewOverlayRowForTests('dataset-1', 0)).toMatchObject({
        'col-1': expect.objectContaining({ value: 'typed-local', status: 'pending' }),
      })
    })
    expect(getSpreadsheetViewMergedRowForTests('dataset-1', 0)).toMatchObject({
      'col-1': 'typed-local',
    })
    expect(getSpreadsheetViewMergedRowForTests('dataset-1', 0)).not.toHaveProperty('col-2')

    deferredExecute.resolve({ backendSyncSucceeded: true })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('keeps a locally cleared cell visible after a stale backend block merge', async () => {
    const deferredRows = (() => {
      let resolve!: (value: Array<Record<string, unknown>>) => void
      const promise = new Promise<Array<Record<string, unknown>>>((res) => {
        resolve = res
      })
      return { promise, resolve }
    })()
    let startedDeferredLoad = false
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) => {
      if (start === 0 && end === 100 && !startedDeferredLoad) {
        startedDeferredLoad = true
        return deferredRows.promise
      }
      if (start === 0 && end === 1) {
        return [{ 'col-1': 'before-cut', 'col-2': 'backend-sibling' }]
      }
      return []
    })

    render(<SpreadsheetView />)
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('show-row-0'))
    await waitFor(() => {
      expect(startedDeferredLoad).toBe(true)
    })

    fireEvent.click(screen.getByTestId('select-row-0'))
    await act(async () => {
      await keyboardHarness.handlers.onCut?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: '',
      displayData: '',
    })
    deferredRows.resolve([{ 'col-1': 'before-cut', 'col-2': 'backend-sibling' }])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: '',
      displayData: '',
    })
  })

  it('clears the overlay after backend base converges to a local typed value', async () => {
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-1': 'typed-local', 'col-2': 'backend-untouched' },
    ])

    render(<SpreadsheetView />)
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('edit-row-0'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('show-row-0'))
    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('dataset-1', 0, 100)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'typed-local',
      displayData: 'typed-local',
    })
    await waitFor(() => {
      expect(getSpreadsheetViewOverlayRowForTests('dataset-1', 0)).toBeNull()
    })
  })
})
