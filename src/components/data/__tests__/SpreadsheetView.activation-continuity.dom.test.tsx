import React from 'react'
import { render, waitFor } from '@/test/test-utils'
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

const clipboardHarness = vi.hoisted(() => ({
  read: vi.fn<() => Promise<string>>().mockResolvedValue('x'),
  write: vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined),
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
}))

const viewStateCacheHarness = vi.hoisted(() => {
  const cache = new Map<string, unknown>()
  return {
    getViewStateCache: vi.fn((key: string) => cache.get(key)),
    setViewStateCache: vi.fn((key: string, value: unknown) => {
      cache.set(key, value)
    }),
    clear: () => cache.clear(),
  }
})

const storeHarness = vi.hoisted(() => {
  const dataset1 = {
    id: 'dataset-1',
    name: 'dataset-1',
    rowCount: 4,
    dataRowCount: 4,
    columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
  } as any

  const dataset2 = {
    id: 'dataset-2',
    name: 'dataset-2',
    rowCount: 4,
    dataRowCount: 4,
    columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
  } as any

  const dataset3 = {
    id: 'dataset-3',
    name: 'dataset-3',
    rowCount: 4,
    dataRowCount: 4,
    columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
  } as any

  const state = {
    currentDataset: dataset1,
    datasets: [dataset1, dataset2],
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

  return { dataset1, dataset2, dataset3, state, useDataStore }
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

vi.mock('@/lib/grid/viewStateCache', () => ({
  getViewStateCache: viewStateCacheHarness.getViewStateCache,
  setViewStateCache: viewStateCacheHarness.setViewStateCache,
}))

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )

  const MockDataEditor = React.forwardRef((props: any, _ref) => {
    gridHarness.getCellContent = props.getCellContent
    gridHarness.onVisibleRegionChanged = props.onVisibleRegionChanged
    return <div data-testid="mock-grid" />
  })
  MockDataEditor.displayName = 'MockDataEditor'

  return { ...actual, DataEditor: MockDataEditor }
})

describe('SpreadsheetView activation continuity', () => {
  beforeEach(async () => {
    vi.resetModules()
    SpreadsheetView = (await import('../SpreadsheetView')).default
    gridHarness.getCellContent = null
    gridHarness.onVisibleRegionChanged = null
    viewStateCacheHarness.clear()
    cacheHarness.getRowsHybrid.mockReset()
    cacheHarness.getRowsHybrid.mockResolvedValue([])
    cacheHarness.getDatasetStorageInfo.mockClear()
    cacheHarness.getAllColumnStats.mockClear()
    cacheHarness.getPersistedColumnIds.mockClear()
    cacheHarness.ensureLatestCache.mockClear()
    cacheHarness.getLazyGroupMetadata.mockClear()
    cacheHarness.getGroupRows.mockClear()
    cacheHarness.flushPendingUpdates.mockClear()
    cacheHarness.flushOverlay.mockClear()
    cacheHarness.queueStates.clear()
    cacheHarness.queueListeners.clear()
    storeHarness.state.currentDataset = storeHarness.dataset1
    storeHarness.state.datasets = [storeHarness.dataset1, storeHarness.dataset2, storeHarness.dataset3]
  }, 20000)

  it('keeps prior visible cell content display-only until replacement rows for the new dataset arrive', async () => {
    let resolveDataset2Rows!: (value: Array<Record<string, unknown>>) => void
    const dataset2Rows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveDataset2Rows = resolve
    })

    cacheHarness.getRowsHybrid.mockImplementation(async (datasetId: string, start: number, end: number) => {
      if (datasetId === 'dataset-1') {
        return [{ 'col-1': 'A1' }, { 'col-1': 'A2' }, { 'col-1': 'A3' }, { 'col-1': 'A4' }].slice(
          start,
          end
        )
      }
      if (datasetId === 'dataset-2' && start === 0) {
        return dataset2Rows
      }
      return []
    })

    const view = render(<SpreadsheetView />)

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'A1',
        displayData: 'A1',
      })
    })

    gridHarness.onVisibleRegionChanged?.({ x: 0, y: 0, width: 1, height: 2 })

    storeHarness.state.currentDataset = storeHarness.dataset2
    view.rerender(<SpreadsheetView />)

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      data: 'A1',
      displayData: 'A1',
      readonly: true,
      allowOverlay: false,
    })

    resolveDataset2Rows([{ 'col-1': 'B1' }, { 'col-1': 'B2' }])

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'B1',
        displayData: 'B1',
      })
    })

    expect(gridHarness.getCellContent?.([0, 2])).toMatchObject({
      data: '',
      displayData: '',
    })
  })

  it('preserves continuity across a rapid same-schema A-to-B-to-C switch before the intermediate dataset loads', async () => {
    let resolveDataset2Rows!: (value: Array<Record<string, unknown>>) => void
    const dataset2Rows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveDataset2Rows = resolve
    })

    let resolveDataset3Rows!: (value: Array<Record<string, unknown>>) => void
    const dataset3Rows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveDataset3Rows = resolve
    })

    cacheHarness.getRowsHybrid.mockImplementation(async (datasetId: string, start: number, end: number) => {
      if (datasetId === 'dataset-1') {
        return [{ 'col-1': 'A1' }, { 'col-1': 'A2' }, { 'col-1': 'A3' }, { 'col-1': 'A4' }].slice(
          start,
          end
        )
      }
      if (datasetId === 'dataset-2' && start === 0) {
        return dataset2Rows
      }
      if (datasetId === 'dataset-3' && start === 0) {
        return dataset3Rows
      }
      return []
    })

    const view = render(<SpreadsheetView />)

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'A1',
        displayData: 'A1',
      })
    })

    gridHarness.onVisibleRegionChanged?.({ x: 0, y: 0, width: 1, height: 2 })

    storeHarness.state.currentDataset = storeHarness.dataset2
    view.rerender(<SpreadsheetView />)

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      data: 'A1',
      displayData: 'A1',
      readonly: true,
      allowOverlay: false,
    })

    storeHarness.state.currentDataset = storeHarness.dataset3
    view.rerender(<SpreadsheetView />)

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      data: 'A1',
      displayData: 'A1',
      readonly: true,
      allowOverlay: false,
    })

    resolveDataset2Rows([{ 'col-1': 'B1' }, { 'col-1': 'B2' }])

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      data: 'A1',
      displayData: 'A1',
      readonly: true,
      allowOverlay: false,
    })

    resolveDataset3Rows([{ 'col-1': 'C1' }, { 'col-1': 'C2' }])

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'C1',
        displayData: 'C1',
      })
    })
  })

  it('preserves the displayed surface across A-to-B-to-C when the intermediate dataset only partially loaded', async () => {
    let resolveDataset2Rows!: (value: Array<Record<string, unknown>>) => void
    const dataset2Rows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveDataset2Rows = resolve
    })

    let resolveDataset3Rows!: (value: Array<Record<string, unknown>>) => void
    const dataset3Rows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveDataset3Rows = resolve
    })

    cacheHarness.getRowsHybrid.mockImplementation(async (datasetId: string, start: number, end: number) => {
      if (datasetId === 'dataset-1') {
        return [{ 'col-1': 'A1' }, { 'col-1': 'A2' }, { 'col-1': 'A3' }, { 'col-1': 'A4' }].slice(
          start,
          end
        )
      }
      if (datasetId === 'dataset-2' && start === 0) {
        return dataset2Rows
      }
      if (datasetId === 'dataset-3' && start === 0) {
        return dataset3Rows
      }
      return []
    })

    const view = render(<SpreadsheetView />)

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'A1',
        displayData: 'A1',
      })
    })

    gridHarness.onVisibleRegionChanged?.({ x: 0, y: 0, width: 1, height: 2 })

    storeHarness.state.currentDataset = storeHarness.dataset2
    view.rerender(<SpreadsheetView />)

    resolveDataset2Rows([{ 'col-1': 'B1' }])

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'A1',
        displayData: 'A1',
        readonly: true,
        allowOverlay: false,
      })
      expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
        data: 'A2',
        displayData: 'A2',
        readonly: true,
        allowOverlay: false,
      })
    })

    storeHarness.state.currentDataset = storeHarness.dataset3
    view.rerender(<SpreadsheetView />)

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      data: 'A1',
      displayData: 'A1',
      readonly: true,
      allowOverlay: false,
    })
    expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
      data: 'A2',
      displayData: 'A2',
      readonly: true,
      allowOverlay: false,
    })

    resolveDataset3Rows([{ 'col-1': 'C1' }, { 'col-1': 'C2' }])

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'C1',
        displayData: 'C1',
      })
      expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
        data: 'C2',
        displayData: 'C2',
      })
    })
  })

  it('does not serve continuity rows outside the new dataset row count and clears immediately for a zero-row dataset', async () => {
    cacheHarness.getRowsHybrid.mockImplementation(async (datasetId: string, start: number, end: number) => {
      if (datasetId === 'dataset-1') {
        return [{ 'col-1': 'A1' }, { 'col-1': 'A2' }, { 'col-1': 'A3' }, { 'col-1': 'A4' }].slice(
          start,
          end
        )
      }
      return []
    })

    const zeroRowDataset = {
      ...storeHarness.dataset2,
      rowCount: 0,
      dataRowCount: 0,
    }
    storeHarness.state.datasets = [storeHarness.dataset1, zeroRowDataset]

    const view = render(<SpreadsheetView />)

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'A1',
        displayData: 'A1',
      })
    })

    storeHarness.state.currentDataset = zeroRowDataset
    view.rerender(<SpreadsheetView />)

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      data: '',
      displayData: '',
    })
  })
})
