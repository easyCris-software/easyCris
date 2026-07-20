import React, { useRef } from 'react'
import { act, render, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridMutationQueueState } from '@/lib/grid/types'
import { computeSchemaKey } from '@/lib/grid/viewStateSchema'
import { CompactSelection } from '@glideapps/glide-data-grid'

let SpreadsheetView: typeof import('../SpreadsheetView').default

const keyboardHarness = vi.hoisted(() => ({ handlers: null as any }))
const gridHarness = vi.hoisted(
  () =>
    ({
      getCellContent: null as null | ((cell: [number, number]) => any),
      onVisibleRegionChanged: null as null | ((range: { x: number; y: number; width: number; height: number }) => void),
      columns: [] as any[],
      rows: 0,
      instanceId: null as string | null,
      renderSnapshots: [] as Array<{ instanceId: string; columnIds: string[] }>,
    }) as {
      getCellContent: null | ((cell: [number, number]) => any)
      onVisibleRegionChanged: null | ((range: { x: number; y: number; width: number; height: number }) => void)
      columns: any[]
      rows: number
      instanceId: string | null
      renderSnapshots: Array<{ instanceId: string; columnIds: string[] }>
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
  getColumnData: vi.fn().mockResolvedValue([]),
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
    const instanceId = useRef(`gdg-${Math.random().toString(36).slice(2)}`)
    gridHarness.getCellContent = props.getCellContent
    gridHarness.onVisibleRegionChanged = props.onVisibleRegionChanged
    gridHarness.columns = props.columns
    gridHarness.rows = props.rows
    gridHarness.instanceId = instanceId.current
    gridHarness.renderSnapshots.push({
      instanceId: instanceId.current,
      columnIds: (props.columns ?? []).map((column: any) => String(column?.id ?? '')),
    })
    return <div data-testid="mock-grid" data-instance-id={instanceId.current} />
  })
  MockDataEditor.displayName = 'MockDataEditor'

  return { ...actual, DataEditor: MockDataEditor }
})

const readActivationState = (container: HTMLElement) => {
  const probe = container.querySelector('[data-testid="grid-activation-state"]')
  if (!(probe instanceof HTMLElement)) {
    throw new Error('Expected grid-activation-state test probe to be rendered')
  }

  return {
    pendingDatasetId: probe.dataset.pendingDatasetId ? probe.dataset.pendingDatasetId : null,
    selectionCurrent: probe.dataset.selectionCurrent ? JSON.parse(probe.dataset.selectionCurrent) : null,
    activeCell: probe.dataset.activeCell ? JSON.parse(probe.dataset.activeCell) : null,
    sortModel: probe.dataset.sortModel ? JSON.parse(probe.dataset.sortModel) : [],
    scroll: probe.dataset.scroll ? JSON.parse(probe.dataset.scroll) : null,
  }
}

const readRefreshCounters = (container: HTMLElement) => {
  const probe = container.querySelector('[data-testid="grid-refresh-counters"]')
  if (!(probe instanceof HTMLElement)) {
    throw new Error('Expected grid-refresh-counters test probe to be rendered')
  }
  return {
    remount: Number(probe.dataset.remountCount ?? '0'),
    viewport: Number(probe.dataset.viewportCount ?? '0'),
    cells: Number(probe.dataset.cellsCount ?? '0'),
    reasons: JSON.parse(probe.dataset.reasons ?? '{}') as Record<string, number>,
  }
}

const buildViewStateCacheKeyForTest = (datasetId: string) => {
  const viewKey = 'project:project-1:statistics:statistics-1'
  const schemaKey = computeSchemaKey(['col-1'])
  return `${viewKey}::${datasetId}::${schemaKey}`
}

describe('SpreadsheetView activation bundle', () => {
  beforeEach(async () => {
    vi.resetModules()
    SpreadsheetView = (await import('../SpreadsheetView')).default
    gridHarness.getCellContent = null
    gridHarness.onVisibleRegionChanged = null
    gridHarness.columns = []
    gridHarness.rows = 0
    gridHarness.instanceId = null
    gridHarness.renderSnapshots = []
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

  it('keeps the prior visible surface until the next dataset visible window is ready', async () => {
    let resolveDataset2Rows!: (value: Array<Record<string, unknown>>) => void
    const dataset2Rows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveDataset2Rows = resolve
    })

    cacheHarness.getRowsHybrid.mockImplementation(async (datasetId: string, start: number, end: number) => {
      if (datasetId === 'dataset-1') {
        return [{ 'Column 1': 'A1' }, { 'Column 1': 'A2' }, { 'Column 1': 'A3' }, { 'Column 1': 'A4' }].slice(
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
    const beforeInstanceId = gridHarness.instanceId
    const baselineCounters = readRefreshCounters(view.container)

    gridHarness.onVisibleRegionChanged?.({ x: 0, y: 0, width: 1, height: 2 })

    storeHarness.state.currentDataset = storeHarness.dataset2
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
    expect(view.queryByTestId('grid-empty-state')).not.toBeInTheDocument()
    expect(view.getByTestId('grid-staging-status')).toHaveTextContent('Preparing grid...')

    resolveDataset2Rows([{ 'col-1': 'B1' }, { 'col-1': 'B2' }])

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'B1',
        displayData: 'B1',
      })
      expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
        data: 'B2',
        displayData: 'B2',
      })
      const counters = readRefreshCounters(view.container)
      expect(counters.viewport - baselineCounters.viewport).toBeGreaterThan(0)
      expect(counters.reasons['activation-bundle-promote']).toBeGreaterThan(0)
      expect(gridHarness.instanceId).toBe(beforeInstanceId)
    })
  })

  it('does not leave activation stuck when the next dataset preload returns no rows', async () => {
    cacheHarness.getRowsHybrid.mockImplementation(async (datasetId: string, start: number, end: number) => {
      if (datasetId === 'dataset-1') {
        return [{ 'Column 1': 'A1' }, { 'Column 1': 'A2' }, { 'Column 1': 'A3' }, { 'Column 1': 'A4' }].slice(
          start,
          end
        )
      }
      if (datasetId === 'dataset-2') {
        return []
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

    await waitFor(() => {
      expect(readActivationState(view.container)).toMatchObject({
        pendingDatasetId: null,
      })
    })
    expect(view.queryByTestId('grid-staging-status')).not.toBeInTheDocument()
  })

  it('promotes saved sort, selection, active cell, and scroll atomically with the next dataset', async () => {
    let resolveDataset2Rows!: (value: Array<Record<string, unknown>>) => void
    const dataset2Rows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveDataset2Rows = resolve
    })

    let resolveDataset2ScrolledRows!: (value: Array<Record<string, unknown>>) => void
    const dataset2ScrolledRows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveDataset2ScrolledRows = resolve
    })

    cacheHarness.getRowsHybrid.mockImplementation(async (datasetId: string, start: number, end: number) => {
      if (datasetId === 'dataset-1') {
        return [{ 'Column 1': 'A1' }, { 'Column 1': 'A2' }, { 'Column 1': 'A3' }, { 'Column 1': 'A4' }].slice(
          start,
          end
        )
      }
      if (datasetId === 'dataset-2' && start === 0) {
        return dataset2Rows
      }
      if (datasetId === 'dataset-2' && start === 3) {
        return dataset2ScrolledRows
      }
      return []
    })

    viewStateCacheHarness.setViewStateCache(buildViewStateCacheKeyForTest('dataset-1'), {
      datasetId: 'dataset-1',
      schemaKey: computeSchemaKey(['col-1']),
      sortModel: [{ colId: 'col-1', dir: 'asc' }],
      groupByColumnId: null,
      collapsedGroupKeys: [],
      gridSelection: { current: { cell: [0, 0], range: { x: 0, y: 0, width: 1, height: 1 } }, columns: CompactSelection.empty(), rows: CompactSelection.empty() },
      activeCell: { colIndex: 0, rowIndex: 0 },
      scroll: { x: 0, y: 0 },
    })
    viewStateCacheHarness.setViewStateCache(buildViewStateCacheKeyForTest('dataset-2'), {
      datasetId: 'dataset-2',
      schemaKey: computeSchemaKey(['col-1']),
      sortModel: [{ colId: 'col-1', dir: 'desc' }],
      groupByColumnId: null,
      collapsedGroupKeys: [],
      gridSelection: { current: { cell: [0, 1], range: { x: 0, y: 1, width: 1, height: 1 } }, columns: CompactSelection.empty(), rows: CompactSelection.empty() },
      activeCell: { colIndex: 0, rowIndex: 1 },
      scroll: { x: 0, y: 3 },
    })

    const view = render(<SpreadsheetView />)

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'A1',
        displayData: 'A1',
      })
    })

    await waitFor(() => {
      expect(readActivationState(view.container)).toMatchObject({
        pendingDatasetId: null,
        selectionCurrent: [0, 0],
        activeCell: [0, 0],
        sortModel: [{ colId: 'col-1', dir: 'asc' }],
        scroll: { x: 0, y: 0 },
      })
    })

    gridHarness.onVisibleRegionChanged?.({ x: 0, y: 0, width: 1, height: 2 })
    storeHarness.state.currentDataset = storeHarness.dataset2
    view.rerender(<SpreadsheetView />)

    await waitFor(() => {
      expect(readActivationState(view.container)).toMatchObject({
        pendingDatasetId: 'dataset-2',
        selectionCurrent: [0, 0],
        activeCell: [0, 0],
        sortModel: [{ colId: 'col-1', dir: 'asc' }],
        scroll: { x: 0, y: 0 },
      })
    })

    resolveDataset2Rows([{ 'col-1': 'B1' }, { 'col-1': 'B2' }])

    await waitFor(() => {
      expect(readActivationState(view.container)).toMatchObject({
        pendingDatasetId: 'dataset-2',
        selectionCurrent: [0, 0],
        activeCell: [0, 0],
        sortModel: [{ colId: 'col-1', dir: 'asc' }],
        scroll: { x: 0, y: 0 },
      })
    })

    resolveDataset2ScrolledRows([{ 'col-1': 'B4' }, { 'col-1': 'B5' }])

    await waitFor(() => {
      expect(readActivationState(view.container)).toMatchObject({
        pendingDatasetId: null,
        selectionCurrent: [0, 1],
        activeCell: [0, 1],
        sortModel: [{ colId: 'col-1', dir: 'desc' }],
        scroll: { x: 0, y: 3 },
      })
    })
  })

  it('clears prior dataset selection when the next same-schema dataset has no saved selection', async () => {
    let resolveDataset2Rows!: (value: Array<Record<string, unknown>>) => void
    const dataset2Rows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveDataset2Rows = resolve
    })

    cacheHarness.getRowsHybrid.mockImplementation(async (datasetId: string, start: number, end: number) => {
      if (datasetId === 'dataset-1') {
        return [{ 'Column 1': 'A1' }, { 'Column 1': 'A2' }, { 'Column 1': 'A3' }, { 'Column 1': 'A4' }].slice(
          start,
          end
        )
      }
      if (datasetId === 'dataset-2' && start === 0) {
        return dataset2Rows
      }
      return []
    })

    viewStateCacheHarness.setViewStateCache(buildViewStateCacheKeyForTest('dataset-1'), {
      datasetId: 'dataset-1',
      schemaKey: computeSchemaKey(['col-1']),
      sortModel: [],
      groupByColumnId: null,
      collapsedGroupKeys: [],
      gridSelection: { current: { cell: [0, 0], range: { x: 0, y: 0, width: 1, height: 1 } }, columns: CompactSelection.empty(), rows: CompactSelection.empty() },
      activeCell: { colIndex: 0, rowIndex: 0 },
      scroll: { x: 0, y: 0 },
    })

    const view = render(<SpreadsheetView />)

    await waitFor(() => {
      expect(readActivationState(view.container)).toMatchObject({
        selectionCurrent: [0, 0],
        activeCell: [0, 0],
      })
    })

    gridHarness.onVisibleRegionChanged?.({ x: 0, y: 0, width: 1, height: 2 })
    storeHarness.state.currentDataset = storeHarness.dataset2
    view.rerender(<SpreadsheetView />)

    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      data: 'A1',
      displayData: 'A1',
      readonly: true,
    })

    resolveDataset2Rows([{ 'col-1': 'B1' }, { 'col-1': 'B2' }])

    await waitFor(() => {
      expect(readActivationState(view.container)).toMatchObject({
        pendingDatasetId: null,
        selectionCurrent: null,
        activeCell: null,
      })
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'B1',
        displayData: 'B1',
        readonly: false,
        allowOverlay: true,
      })
    })
  })

  it('keeps activation pending until the deferred scroll target rows are loaded', async () => {
    const scrolledDataset2 = {
      ...storeHarness.dataset2,
      rowCount: 6,
      dataRowCount: 6,
    }
    storeHarness.state.datasets = [storeHarness.dataset1, scrolledDataset2]

    let resolveDataset2TopRows!: (value: Array<Record<string, unknown>>) => void
    const dataset2TopRows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveDataset2TopRows = resolve
    })

    let resolveDataset2ScrolledRows!: (value: Array<Record<string, unknown>>) => void
    const dataset2ScrolledRows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveDataset2ScrolledRows = resolve
    })

    cacheHarness.getRowsHybrid.mockImplementation(async (datasetId: string, start: number, end: number) => {
      if (datasetId === 'dataset-1') {
        return [
          { 'col-1': 'A1' },
          { 'col-1': 'A2' },
          { 'col-1': 'A3' },
          { 'col-1': 'A4' },
          { 'col-1': 'A5' },
          { 'col-1': 'A6' },
        ].slice(start, end)
      }
      if (datasetId === 'dataset-2' && start === 0) {
        return dataset2TopRows
      }
      if (datasetId === 'dataset-2' && start === 3) {
        return dataset2ScrolledRows
      }
      return []
    })

    viewStateCacheHarness.setViewStateCache(buildViewStateCacheKeyForTest('dataset-2'), {
      datasetId: 'dataset-2',
      schemaKey: computeSchemaKey(['col-1']),
      sortModel: [],
      groupByColumnId: null,
      collapsedGroupKeys: [],
      gridSelection: { current: { cell: [0, 3], range: { x: 0, y: 3, width: 1, height: 1 } }, columns: CompactSelection.empty(), rows: CompactSelection.empty() },
      activeCell: { colIndex: 0, rowIndex: 3, columnId: 'col-1' },
      scroll: { x: 0, y: 3 },
    })

    const view = render(<SpreadsheetView />)

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'A1',
        displayData: 'A1',
      })
    })

    gridHarness.onVisibleRegionChanged?.({ x: 0, y: 0, width: 1, height: 2 })
    storeHarness.state.currentDataset = scrolledDataset2
    view.rerender(<SpreadsheetView />)

    resolveDataset2TopRows([{ 'col-1': 'B1' }, { 'col-1': 'B2' }])

    await waitFor(() => {
      expect(readActivationState(view.container)).toMatchObject({
        pendingDatasetId: 'dataset-2',
        selectionCurrent: null,
        activeCell: null,
      })
    })

    resolveDataset2ScrolledRows([{ 'col-1': 'B4' }, { 'col-1': 'B5' }])

    await waitFor(() => {
      expect(readActivationState(view.container)).toMatchObject({
        pendingDatasetId: null,
        selectionCurrent: [0, 3],
        activeCell: [0, 3],
        scroll: { x: 0, y: 3 },
      })
    })
  })

  it('keeps activation pending until restored sort target rows are loaded', async () => {
    const sortedDataset2 = {
      ...storeHarness.dataset2,
      rowCount: 6,
      dataRowCount: 6,
    }
    storeHarness.state.datasets = [storeHarness.dataset1, sortedDataset2]

    let resolveDataset2TopRows!: (value: Array<Record<string, unknown>>) => void
    const dataset2TopRows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveDataset2TopRows = resolve
    })

    let resolveDataset2SortedRows!: (value: Array<Record<string, unknown>>) => void
    const dataset2SortedRows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveDataset2SortedRows = resolve
    })

    cacheHarness.getColumnData.mockResolvedValue([1, 2, 3, 4, 5, 6])
    cacheHarness.getRowsHybrid.mockImplementation(async (datasetId: string, start: number, end: number) => {
      if (datasetId === 'dataset-1') {
        return [
          { 'col-1': 'A1' },
          { 'col-1': 'A2' },
          { 'col-1': 'A3' },
          { 'col-1': 'A4' },
          { 'col-1': 'A5' },
          { 'col-1': 'A6' },
        ].slice(start, end)
      }
      if (datasetId === 'dataset-2' && start === 0) {
        return dataset2TopRows
      }
      if (datasetId === 'dataset-2' && start === 4) {
        return dataset2SortedRows
      }
      return []
    })

    viewStateCacheHarness.setViewStateCache(buildViewStateCacheKeyForTest('dataset-2'), {
      datasetId: 'dataset-2',
      schemaKey: computeSchemaKey(['col-1']),
      sortModel: [{ colId: 'col-1', dir: 'desc' }],
      groupByColumnId: null,
      collapsedGroupKeys: [],
      gridSelection: { current: { cell: [0, 0], range: { x: 0, y: 0, width: 1, height: 1 } }, columns: CompactSelection.empty(), rows: CompactSelection.empty() },
      activeCell: { colIndex: 0, rowIndex: 0, columnId: 'col-1' },
      scroll: { x: 0, y: 0 },
    })

    const view = render(<SpreadsheetView />)

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'A1',
        displayData: 'A1',
      })
    })

    gridHarness.onVisibleRegionChanged?.({ x: 0, y: 0, width: 1, height: 2 })
    storeHarness.state.currentDataset = sortedDataset2
    view.rerender(<SpreadsheetView />)

    resolveDataset2TopRows([{ 'col-1': 'B1' }, { 'col-1': 'B2' }])

    await waitFor(() => {
      expect(readActivationState(view.container)).toMatchObject({
        pendingDatasetId: 'dataset-2',
      })
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'A1',
        displayData: 'A1',
        readonly: true,
      })
    })

    resolveDataset2SortedRows([{ 'col-1': 'B5' }, { 'col-1': 'B6' }])

    await waitFor(() => {
      expect(readActivationState(view.container)).toMatchObject({
        pendingDatasetId: null,
        selectionCurrent: [0, 0],
        activeCell: [0, 0],
        sortModel: [{ colId: 'col-1', dir: 'desc' }],
        scroll: { x: 0, y: 0 },
      })
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'B6',
        displayData: 'B6',
      })
      expect(gridHarness.getCellContent?.([0, 1])).toMatchObject({
        data: 'B5',
        displayData: 'B5',
      })
    })
  })

  it('reports pending blank scaffold readiness without waiting for backend rows', async () => {
    const pendingReady = vi.fn()
    const blankDataset = {
      ...storeHarness.dataset2,
      rowCount: 100,
      dataRowCount: 0,
      columns: Array.from({ length: 100 }, (_, index) => ({
        id: `col-${index}`,
        name: `Column ${index + 1}`,
        type: 'text',
        width: 88,
      })),
    }
    storeHarness.state.datasets = [storeHarness.dataset1, blankDataset]

    render(
      <SpreadsheetView
        datasetId={storeHarness.dataset1.id}
        pendingDatasetId={blankDataset.id}
        pendingDatasetToken={7}
        onPendingSurfaceReady={pendingReady}
      />
    )

    await waitFor(() => {
      expect(pendingReady).toHaveBeenCalledWith({
        datasetId: blankDataset.id,
        token: 7,
      })
    })
  })

  it('keeps the grid shell mounted while showing the empty overlay when no dataset is active', async () => {
    const view = render(<SpreadsheetView />)

    await waitFor(() => {
      expect(view.getByTestId('mock-grid')).toBeInTheDocument()
    })

    storeHarness.state.currentDataset = null
    view.rerender(<SpreadsheetView />)

    await waitFor(() => {
      expect(view.getByTestId('mock-grid')).toBeInTheDocument()
      expect(view.getByTestId('grid-empty-state')).toBeInTheDocument()
      expect(gridHarness.columns).toHaveLength(2)
      expect(gridHarness.rows).toBe(4)
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: '',
        displayData: '',
        readonly: true,
        allowOverlay: false,
      })
    })
  })

  it('shows distinct overlay states for staging, loading, and empty transitions', async () => {
    const view = render(<SpreadsheetView />)

    await waitFor(() => {
      expect(view.getByTestId('mock-grid')).toBeInTheDocument()
    })

    storeHarness.state.currentDataset = null
    view.rerender(
      <SpreadsheetView
        pendingDatasetId={storeHarness.dataset2.id}
        pendingDatasetToken={11}
      />
    )

    await waitFor(() => {
      expect(view.queryByTestId('grid-empty-state')).not.toBeInTheDocument()
      expect(view.getByTestId('grid-staging-status')).toHaveTextContent('Preparing grid...')
    })

    storeHarness.state.loadingOperation = { type: 'project-load', message: 'Loading project...' } as any
    view.rerender(<SpreadsheetView />)

    await waitFor(() => {
      expect(view.getByTestId('grid-empty-state')).toHaveTextContent('Loading project...')
    })

    storeHarness.state.loadingOperation = null
    view.rerender(<SpreadsheetView />)

    await waitFor(() => {
      expect(view.getByTestId('grid-empty-state')).toHaveTextContent('No dataset loaded')
    })
  })

  it('uses the blocking empty-state overlay for cold staging without a committed surface', async () => {
    storeHarness.state.currentDataset = null

    const view = render(
      <SpreadsheetView
        pendingDatasetId={storeHarness.dataset2.id}
        pendingDatasetToken={12}
      />
    )

    await waitFor(() => {
      expect(view.getByTestId('mock-grid')).toBeInTheDocument()
      expect(view.getByTestId('grid-empty-state')).toHaveTextContent('Preparing grid...')
      expect(view.queryByTestId('grid-staging-status')).not.toBeInTheDocument()
    })
  })

  it('keeps the prior visible surface while a schema-changing dataset stages, then promotes once rows load', async () => {
    const schemaChangingDataset = {
      id: 'dataset-schema-change',
      name: 'dataset-schema-change',
      rowCount: 4,
      dataRowCount: 2,
      columns: [
        { id: 'col-a', name: 'Column A', type: 'text', width: 88 },
        { id: 'col-b', name: 'Column B', type: 'text', width: 88 },
      ],
    } as any
    storeHarness.state.datasets = [storeHarness.dataset1, schemaChangingDataset]

    let resolveSchemaRows!: (value: Array<Record<string, unknown>>) => void
    const schemaRows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveSchemaRows = resolve
    })

    cacheHarness.getRowsHybrid.mockImplementation(async (datasetId: string, start: number, end: number) => {
      if (datasetId === 'dataset-1') {
        return [{ 'col-1': 'A1' }, { 'col-1': 'A2' }, { 'col-1': 'A3' }, { 'col-1': 'A4' }].slice(
          start,
          end
        )
      }
      if (datasetId === 'dataset-schema-change' && start === 0) {
        return schemaRows
      }
      return []
    })

    const view = render(<SpreadsheetView />)

    await waitFor(() => {
      expect(view.getByTestId('mock-grid')).toBeInTheDocument()
      expect(gridHarness.columns).toHaveLength(2)
    })
    const beforeInstanceId = gridHarness.instanceId

    gridHarness.onVisibleRegionChanged?.({ x: 0, y: 0, width: 1, height: 2 })
    storeHarness.state.currentDataset = schemaChangingDataset
    await act(async () => {
      view.rerender(<SpreadsheetView />)
    })

    expect(view.getByTestId('mock-grid')).toBeInTheDocument()
    const afterRerenderInstanceId = gridHarness.instanceId
    expect(afterRerenderInstanceId).not.toBe(beforeInstanceId)
    expect(
      gridHarness.renderSnapshots.some(
        (snapshot) => snapshot.instanceId === afterRerenderInstanceId && snapshot.columnIds[0] === 'col-a'
      )
    ).toBe(false)

    resolveSchemaRows([{ 'col-a': 'B1', 'col-b': 'B1b' }, { 'col-a': 'B2', 'col-b': 'B2b' }])

    await waitFor(() => {
      expect(gridHarness.instanceId).not.toBe(beforeInstanceId)
      expect(gridHarness.columns).toHaveLength(3)
      expect(gridHarness.columns[0]?.id).toBe('col-a')
      const counters = readRefreshCounters(view.container)
      expect(counters.remount).toBeGreaterThan(0)
      expect(counters.reasons['schema-change-dataset-switch']).toBeGreaterThan(0)
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'B1',
        displayData: 'B1',
      })
      expect(gridHarness.getCellContent?.([1, 0])).toMatchObject({
        data: 'B1b',
        displayData: 'B1b',
      })
    })
  })

  it('keeps the committed schema scaffold during a cold schema-changing activation until rows load', async () => {
    const schemaChangingDataset = {
      id: 'dataset-schema-cold',
      name: 'dataset-schema-cold',
      rowCount: 4,
      dataRowCount: 2,
      columns: [
        { id: 'col-a', name: 'Column A', type: 'text', width: 88 },
        { id: 'col-b', name: 'Column B', type: 'text', width: 88 },
      ],
    } as any
    storeHarness.state.datasets = [storeHarness.dataset1, schemaChangingDataset]

    let resolveSchemaRows!: (value: Array<Record<string, unknown>>) => void
    const schemaRows = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveSchemaRows = resolve
    })

    cacheHarness.getRowsHybrid.mockImplementation(async (datasetId: string, start: number) => {
      if (datasetId === 'dataset-schema-cold' && start === 0) {
        return schemaRows
      }
      return []
    })

    const view = render(<SpreadsheetView />)

    await waitFor(() => {
      expect(view.getByTestId('mock-grid')).toBeInTheDocument()
      expect(gridHarness.columns).toHaveLength(2)
      expect(gridHarness.columns[0]?.id).toBe('col-1')
    })

    storeHarness.state.currentDataset = schemaChangingDataset
    view.rerender(<SpreadsheetView />)

    await waitFor(() => {
      expect(view.getByTestId('mock-grid')).toBeInTheDocument()
      expect(gridHarness.columns).toHaveLength(2)
      expect(gridHarness.columns[0]?.id).toBe('col-1')
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: '',
        displayData: '',
        readonly: true,
        allowOverlay: false,
      })
    })

    resolveSchemaRows([{ 'col-a': 'C1', 'col-b': 'C1b' }, { 'col-a': 'C2', 'col-b': 'C2b' }])

    await waitFor(() => {
      expect(gridHarness.columns).toHaveLength(3)
      expect(gridHarness.columns[0]?.id).toBe('col-a')
      expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
        data: 'C1',
        displayData: 'C1',
      })
    })
  })
})
