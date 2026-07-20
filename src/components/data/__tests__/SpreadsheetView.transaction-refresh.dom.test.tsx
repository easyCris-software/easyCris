import React, { useImperativeHandle } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { CompactSelection, GridCellKind } from '@glideapps/glide-data-grid'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SpreadsheetView, { resetSpreadsheetViewSharedOverlayStateForTests } from '../SpreadsheetView'
import type { GridMutationQueueState } from '@/lib/grid/types'

const keyboardHarness = vi.hoisted(() => ({ handlers: null as any }))
const gridHarness = vi.hoisted(() => ({
  updateCellBatches: [] as Array<Array<readonly [number, number]>>,
  getCellContent: null as null | ((cell: [number, number]) => any),
}))
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
  applyDataStoreUpdate: vi.fn(),
}))
const tauriHarness = vi.hoisted(() => ({
  loadDataRows: vi.fn().mockResolvedValue([]),
  evaluateFormulaRange: vi.fn(),
}))
const undoHarness = vi.hoisted(() => ({
  undo: vi.fn().mockResolvedValue(null),
  redo: vi.fn().mockResolvedValue(null),
  recordGridTransaction: vi.fn().mockResolvedValue(undefined),
  hasPreparedUndoGridTransaction: vi.fn(() => false),
  hasPreparedRedoGridTransaction: vi.fn(() => false),
}))
const storeHarness = vi.hoisted(() => {
  const dataset = {
    id: 'dataset-1',
    name: 'dataset-1',
    rowCount: 1200,
    dataRowCount: 1200,
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
    updateDataset: vi.fn((datasetId: string, updates: Record<string, unknown>) => {
      if (state.currentDataset?.id === datasetId) Object.assign(state.currentDataset, updates)
      state.datasets = state.datasets.map((entry: any) =>
        entry.id === datasetId ? Object.assign(entry, updates) : entry
      )
    }),
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

const makeSelection = (row: number, width = 1, height = 1) => ({
  current: {
    cell: [0, row] as [number, number],
    range: { x: 0, y: row, width, height },
    rangeStack: [],
  },
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
})

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )

  const MockDataEditor = React.forwardRef((props: any, ref) => {
    gridHarness.getCellContent = props.getCellContent
    useImperativeHandle(ref, () => ({
      updateCells: (updates: Array<{ cell: readonly [number, number] }>) => {
        gridHarness.updateCellBatches.push(updates.map((entry) => entry.cell))
      },
      scrollTo: vi.fn(),
      getBounds: vi.fn(),
    }))

    return (
      <div>
        <button
          data-testid="select-row-0"
          onClick={() => props.onGridSelectionChange?.(makeSelection(0))}
        >
          select-row-0
        </button>
        <button
          data-testid="select-row-0-wide"
          onClick={() => props.onGridSelectionChange?.(makeSelection(0, 2))}
        >
          select-row-0-wide
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

const readRefreshReasons = () => {
  const probe = screen.getByTestId('grid-refresh-counters')
  return JSON.parse(probe.getAttribute('data-reasons') ?? '{}') as Record<string, number>
}

const flattenUpdatedCells = () => {
  const seen = new Set<string>()
  const cells: string[] = []
  for (const batch of gridHarness.updateCellBatches) {
    for (const [col, row] of batch) {
      const key = `${col}:${row}`
      if (seen.has(key)) continue
      seen.add(key)
      cells.push(key)
    }
  }
  return cells
}

const waitForAnimationFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })

const buildMockRows = (start: number, end: number) =>
  Array.from({ length: Math.max(0, end - start) }, (_, index) => {
    const rowNumber = start + index + 1
    return {
      'col-1': `A${rowNumber}`,
      'col-2': `B${rowNumber}`,
    }
  })

const settleInitialRender = async () => {
  await act(async () => {
    await waitForAnimationFrame()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const settleRefreshCounters = async () => {
  let previous = readRefreshCounters()
  let previousReasons = readRefreshReasons()
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await act(async () => {
      await waitForAnimationFrame()
      await Promise.resolve()
      await Promise.resolve()
    })
    const next = readRefreshCounters()
    const nextReasons = readRefreshReasons()
    if (
      next.remount === previous.remount &&
      next.viewport === previous.viewport &&
      next.cells === previous.cells &&
      JSON.stringify(nextReasons) === JSON.stringify(previousReasons)
    ) {
      return next
    }
    previous = next
    previousReasons = nextReasons
  }
  return previous
}

describe('SpreadsheetView transaction refresh boundaries', () => {
  beforeEach(() => {
    resetSpreadsheetViewSharedOverlayStateForTests()
    keyboardHarness.handlers = null
    gridHarness.updateCellBatches = []
    gridHarness.getCellContent = null
    clipboardHarness.read.mockReset()
    clipboardHarness.write.mockClear()
    cacheHarness.getRowsHybrid.mockReset()
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) =>
      buildMockRows(start, end)
    )
    cacheHarness.flushOverlay.mockReset()
    cacheHarness.flushOverlay.mockResolvedValue(undefined)
    editHarness.execute.mockReset()
    editHarness.execute.mockResolvedValue({ backendSyncSucceeded: true })
    storeHarness.dataset.rowCount = 1200
    storeHarness.dataset.dataRowCount = 1200
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Column 2', type: 'text', width: 88 },
    ] as any
    storeHarness.state.currentDataset = storeHarness.dataset
    storeHarness.state.datasets = [storeHarness.dataset]
    appStoreHarness.appState.pasteInFlight = false
    appStoreHarness.appState.setPasteInFlight.mockClear()
  })

  it('uses cell-scoped refresh for type mutations instead of viewport repaint', async () => {
    render(<SpreadsheetView />)
    await settleInitialRender()
    const baseline = await settleRefreshCounters()
    const baselineReasons = readRefreshReasons()

    fireEvent.click(screen.getByTestId('edit-row-0'))
    await waitFor(() => {
      expect(editHarness.execute).toHaveBeenCalled()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const counters = readRefreshCounters()
    expect(counters.cells - baseline.cells).toBeGreaterThan(0)
    expect(counters.viewport - baseline.viewport).toBe(0)
    expect(readRefreshReasons()['dataset-switch-repaint'] ?? 0).toBe(
      baselineReasons['dataset-switch-repaint'] ?? 0
    )
    expect(flattenUpdatedCells()).toContain('0:0')
  })

  it('uses cell-scoped refresh for cut and paste instead of viewport repaint', async () => {
    clipboardHarness.read.mockResolvedValueOnce('A\tB')

    render(<SpreadsheetView />)
    await settleInitialRender()
    await settleRefreshCounters()
    const initialReasons = readRefreshReasons()

    fireEvent.click(screen.getByTestId('select-row-0'))
    const cutBaseline = await settleRefreshCounters()
    await act(async () => {
      await keyboardHarness.handlers.onCut?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(readRefreshCounters().cells - cutBaseline.cells).toBeGreaterThan(0)
    })
    const cutCounters = readRefreshCounters()
    expect(cutCounters.cells - cutBaseline.cells).toBeGreaterThan(0)
    expect(cutCounters.remount - cutBaseline.remount).toBe(0)
    expect(readRefreshReasons()['dataset-switch-repaint'] ?? 0).toBe(
      initialReasons['dataset-switch-repaint'] ?? 0
    )

    gridHarness.updateCellBatches = []
    fireEvent.click(screen.getByTestId('select-row-0-wide'))
    const pasteBaseline = await settleRefreshCounters()
    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(cacheHarness.flushOverlay).toHaveBeenCalled()
    })

    await waitFor(() => {
      expect(readRefreshCounters().cells - pasteBaseline.cells).toBeGreaterThan(0)
    })
    const pasteCounters = readRefreshCounters()
    expect(pasteCounters.cells - pasteBaseline.cells).toBeGreaterThan(0)
    expect(pasteCounters.viewport - pasteBaseline.viewport).toBe(0)
    expect(readRefreshReasons()['dataset-switch-repaint'] ?? 0).toBe(
      initialReasons['dataset-switch-repaint'] ?? 0
    )
    expect(gridHarness.getCellContent?.([0, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'A',
    })
    expect(gridHarness.getCellContent?.([1, 0])).toMatchObject({
      kind: GridCellKind.Text,
      data: 'B',
    })
  })

  it('batches large multi-cell mutations into deduped updateCells chunks', async () => {
    const rows = Array.from({ length: 600 }, (_, index) => `value-${index}`).join('\n')
    clipboardHarness.read.mockResolvedValueOnce(rows)

    render(<SpreadsheetView />)
    await settleInitialRender()
    fireEvent.click(screen.getByTestId('select-row-0'))
    const baseline = await settleRefreshCounters()
    const baselineReasons = readRefreshReasons()

    await act(async () => {
      await keyboardHarness.handlers.onPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(cacheHarness.flushOverlay).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(gridHarness.updateCellBatches.length).toBeGreaterThan(1)
    })

    const counters = readRefreshCounters()
    expect(counters.cells - baseline.cells).toBeGreaterThan(0)
    expect(counters.viewport - baseline.viewport).toBe(0)
    expect(readRefreshReasons()['dataset-switch-repaint'] ?? 0).toBe(
      baselineReasons['dataset-switch-repaint'] ?? 0
    )
    expect(gridHarness.updateCellBatches.length).toBeGreaterThan(1)
    expect(gridHarness.updateCellBatches.every((batch) => batch.length <= 500)).toBe(true)
    expect(flattenUpdatedCells().length).toBeGreaterThan(500)
  })
})
