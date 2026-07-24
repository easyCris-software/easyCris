import React from 'react'
import { act, render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SpreadsheetView, { ADD_COLUMN_ID } from '../SpreadsheetView'
import type { GridMutationQueueState } from '@/lib/grid/types'
import { CompactSelection } from '@glideapps/glide-data-grid'

const keyboardHarness = vi.hoisted(() => ({ handlers: null as any }))
const gridHarness = vi.hoisted(() => ({ latestProps: null as any, renderCount: 0 }))
const clipboardHarness = vi.hoisted(() => ({
  read: vi.fn<() => Promise<string>>(),
  write: vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined),
}))
const cacheHarness = vi.hoisted(() => ({
  getDatasetStorageInfo: vi.fn().mockResolvedValue(null),
  getRowsHybrid: vi.fn().mockResolvedValue([]),
  getAllColumnStats: vi.fn().mockResolvedValue([]),
  getPersistedColumnIds: vi.fn().mockResolvedValue([]),
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
    dataRowCount: 3,
    columns: [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Column 2', type: 'text', width: 88 },
      { id: 'col-3', name: 'Column 3', type: 'text', width: 88 },
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
    allocateNextAutoColumnName: vi.fn(() => 'Column 4'),
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
  createEditExecutor: vi.fn(() => ({
    execute: editHarness.execute,
    executeSingle: editHarness.executeSingle,
  })),
}))

vi.mock('@/components/dialogs/FindReplaceDialog', () => ({
  FindReplaceDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog" aria-label="Find and replace"><input placeholder="Find..." /></div> : null,
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

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )

  const MockDataEditor = React.forwardRef((_props: any, _ref) => {
    gridHarness.latestProps = _props
    gridHarness.renderCount += 1
    return <div data-testid="mock-grid" />
  })
  MockDataEditor.displayName = 'MockDataEditor'

  return { ...actual, DataEditor: MockDataEditor }
})

describe('SpreadsheetView ctrl+a selection contract', () => {
  beforeEach(() => {
    keyboardHarness.handlers = null
    gridHarness.latestProps = null
    gridHarness.renderCount = 0
    cacheHarness.queueStates.clear()
    cacheHarness.queueListeners.clear()
    storeHarness.dataset.dataRowCount = 3
    storeHarness.dataset.rowCount = 100
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: 'col-2', name: 'Column 2', type: 'text', width: 88 },
      { id: 'col-3', name: 'Column 3', type: 'text', width: 88 },
    ] as any
    storeHarness.state.currentDataset = storeHarness.dataset
    storeHarness.state.datasets = [storeHarness.dataset]

    storeHarness.state.setSelectedRows.mockClear()
    storeHarness.state.setSelectedColumns.mockClear()
    cacheHarness.getAllColumnStats.mockReset()
    cacheHarness.getPersistedColumnIds.mockReset()
    cacheHarness.getPersistedColumnIds.mockResolvedValue(['col-1', 'col-2', 'col-3'])
  })

  it('selects only data-bearing columns and committed data rows', async () => {
    cacheHarness.getAllColumnStats.mockResolvedValue([
      { columnId: 'col-1', nonNullCount: 5 },
      { columnId: 'col-2', nonNullCount: 0 },
      { columnId: 'col-3', nonNullCount: 2 },
    ])

    render(<SpreadsheetView />)
    storeHarness.state.setSelectedRows.mockClear()
    storeHarness.state.setSelectedColumns.mockClear()
    await waitFor(() => {
      expect(cacheHarness.getAllColumnStats).toHaveBeenCalledWith('dataset-1')
      expect(cacheHarness.getPersistedColumnIds).toHaveBeenCalledWith('dataset-1')
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    storeHarness.state.setSelectedRows.mockClear()
    storeHarness.state.setSelectedColumns.mockClear()

    const handled = await act(async () => {
      return await keyboardHarness.handlers.onSelectAll?.()
    })

    expect(handled).toBe(true)
    const selection = gridHarness.latestProps?.gridSelection
    expect(selection?.rows.length).toBe(0)
    expect(selection?.columns.length).toBe(0)
    expect(selection?.current?.range).toEqual({ x: 0, y: 0, width: 1, height: 3 })
    expect(selection?.current?.rangeStack).toEqual([{ x: 2, y: 0, width: 1, height: 3 }])
    expect(storeHarness.state.setSelectedColumns).toHaveBeenLastCalledWith(['col-1', 'col-3'])
    expect(storeHarness.state.setSelectedRows).toHaveBeenLastCalledWith([0, 1, 2])
  })

  it('commits mouse selection synchronously for Glide activation', async () => {
    render(<SpreadsheetView />)
    await waitFor(() => {
      expect(cacheHarness.getAllColumnStats).toHaveBeenCalledWith('dataset-1')
      expect(cacheHarness.getPersistedColumnIds).toHaveBeenCalledWith('dataset-1')
    })

    const nextSelection = {
      rows: CompactSelection.empty(),
      columns: CompactSelection.empty(),
      current: {
        cell: [1, 1],
        range: { x: 1, y: 1, width: 1, height: 1 },
        rangeStack: [],
      },
    }

    act(() => {
      const before = gridHarness.renderCount
      gridHarness.latestProps?.onGridSelectionChange(nextSelection)
      expect(gridHarness.renderCount).toBe(before + 1)
      expect(gridHarness.latestProps?.gridSelection?.current?.cell).toEqual([1, 1])
    })
  })

  it('keeps range selection batched during drag-style selection changes', async () => {
    render(<SpreadsheetView />)
    await waitFor(() => {
      expect(cacheHarness.getAllColumnStats).toHaveBeenCalledWith('dataset-1')
      expect(cacheHarness.getPersistedColumnIds).toHaveBeenCalledWith('dataset-1')
    })

    const nextSelection = {
      rows: CompactSelection.empty(),
      columns: CompactSelection.empty(),
      current: {
        cell: [0, 0],
        range: { x: 0, y: 0, width: 2, height: 2 },
        rangeStack: [],
      },
    }

    act(() => {
      const before = gridHarness.renderCount
      gridHarness.latestProps?.onGridSelectionChange(nextSelection)
      expect(gridHarness.renderCount).toBe(before)
    })
  })

  it('no-ops when stats coverage is partial', async () => {
    cacheHarness.getAllColumnStats.mockResolvedValue([
      { columnId: 'col-1', nonNullCount: 5 },
    ])

    render(<SpreadsheetView />)
    storeHarness.state.setSelectedRows.mockClear()
    storeHarness.state.setSelectedColumns.mockClear()
    await waitFor(() => {
      expect(cacheHarness.getAllColumnStats).toHaveBeenCalledWith('dataset-1')
      expect(cacheHarness.getPersistedColumnIds).toHaveBeenCalledWith('dataset-1')
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    storeHarness.state.setSelectedRows.mockClear()
    storeHarness.state.setSelectedColumns.mockClear()

    const handled = await act(async () => {
      return await keyboardHarness.handlers.onSelectAll?.()
    })

    expect(handled).toBe(false)
    expect(storeHarness.state.setSelectedColumns).not.toHaveBeenCalled()
    expect(storeHarness.state.setSelectedRows).not.toHaveBeenCalled()
  })

  it('no-ops and refreshes when ctrl+a runs before stats metadata is loaded', async () => {
    const unresolved = new Promise<never>(() => {})
    cacheHarness.getAllColumnStats.mockReturnValue(unresolved)
    cacheHarness.getPersistedColumnIds.mockReturnValue(unresolved)

    render(<SpreadsheetView />)
    storeHarness.state.setSelectedRows.mockClear()
    storeHarness.state.setSelectedColumns.mockClear()

    await waitFor(() => {
      expect(cacheHarness.getAllColumnStats).toHaveBeenCalledWith('dataset-1')
      expect(cacheHarness.getPersistedColumnIds).toHaveBeenCalledWith('dataset-1')
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    storeHarness.state.setSelectedRows.mockClear()
    storeHarness.state.setSelectedColumns.mockClear()

    const handled = await act(async () => {
      return await keyboardHarness.handlers.onSelectAll?.()
    })

    expect(handled).toBe(false)
    expect(storeHarness.state.setSelectedColumns).not.toHaveBeenCalled()
    expect(storeHarness.state.setSelectedRows).not.toHaveBeenCalled()
    expect(cacheHarness.getAllColumnStats.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(cacheHarness.getPersistedColumnIds.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('no-ops when there are no committed data rows', async () => {
    storeHarness.dataset.dataRowCount = 0
    cacheHarness.getAllColumnStats.mockResolvedValue([
      { columnId: 'col-1', nonNullCount: 5 },
      { columnId: 'col-2', nonNullCount: 1 },
      { columnId: 'col-3', nonNullCount: 2 },
    ])

    render(<SpreadsheetView />)
    await waitFor(() => {
      expect(cacheHarness.getAllColumnStats).toHaveBeenCalledWith('dataset-1')
      expect(cacheHarness.getPersistedColumnIds).toHaveBeenCalledWith('dataset-1')
    })
    await act(async () => {
      await Promise.resolve()
    })
    storeHarness.state.setSelectedRows.mockClear()
    storeHarness.state.setSelectedColumns.mockClear()

    const handled = await act(async () => {
      return await keyboardHarness.handlers.onSelectAll?.()
    })

    expect(handled).toBe(false)
    expect(storeHarness.state.setSelectedColumns).not.toHaveBeenCalled()
    expect(storeHarness.state.setSelectedRows).not.toHaveBeenCalled()
  })

  it('asks parent guard before opening find from keyboard shortcut', async () => {
    const onRequireDataRows = vi.fn(() => false)

    render(<SpreadsheetView onRequireDataRows={onRequireDataRows} />)
    await waitFor(() => {
      expect(keyboardHarness.handlers?.onFind).toBeTypeOf('function')
    })

    const handled = await act(async () => {
      return keyboardHarness.handlers.onFind()
    })

    expect(handled).toBe(true)
    expect(onRequireDataRows).toHaveBeenCalledWith('Find')
    expect(screen.queryByPlaceholderText('Find...')).not.toBeInTheDocument()
  })

  it('opens find from keyboard shortcut when parent guard allows it', async () => {
    const onRequireDataRows = vi.fn(() => true)

    render(<SpreadsheetView onRequireDataRows={onRequireDataRows} />)
    await waitFor(() => {
      expect(keyboardHarness.handlers?.onFind).toBeTypeOf('function')
    })

    const handled = await act(async () => {
      return keyboardHarness.handlers.onFind()
    })

    expect(handled).toBe(true)
    expect(onRequireDataRows).toHaveBeenCalledWith('Find')
    expect(screen.getByPlaceholderText('Find...')).toBeInTheDocument()
  })

  it('ignores virtual add-column during stats coverage checks', async () => {
    storeHarness.dataset.columns = [
      { id: 'col-1', name: 'Column 1', type: 'text', width: 88 },
      { id: ADD_COLUMN_ID, name: '+', type: 'text', width: 64 },
    ] as any
    cacheHarness.getAllColumnStats.mockResolvedValue([
      { columnId: 'col-1', nonNullCount: 3 },
    ])
    cacheHarness.getPersistedColumnIds.mockResolvedValue(['col-1'])

    render(<SpreadsheetView />)
    storeHarness.state.setSelectedRows.mockClear()
    storeHarness.state.setSelectedColumns.mockClear()
    await waitFor(() => {
      expect(cacheHarness.getAllColumnStats).toHaveBeenCalledWith('dataset-1')
      expect(cacheHarness.getPersistedColumnIds).toHaveBeenCalledWith('dataset-1')
    })

    const handled = await act(async () => {
      return await keyboardHarness.handlers.onSelectAll?.()
    })

    expect(handled).toBe(true)
    expect(storeHarness.state.setSelectedColumns).toHaveBeenLastCalledWith(['col-1'])
    expect(storeHarness.state.setSelectedRows).toHaveBeenLastCalledWith([0, 1, 2])
  })

  it('avoids materializing massive row-index arrays for very large ctrl+a selection', async () => {
    storeHarness.dataset.dataRowCount = 20_001
    cacheHarness.getAllColumnStats.mockResolvedValue([
      { columnId: 'col-1', nonNullCount: 20_001 },
      { columnId: 'col-2', nonNullCount: 20_001 },
      { columnId: 'col-3', nonNullCount: 20_001 },
    ])

    render(<SpreadsheetView />)
    storeHarness.state.setSelectedRows.mockClear()
    storeHarness.state.setSelectedColumns.mockClear()
    await waitFor(() => {
      expect(cacheHarness.getAllColumnStats).toHaveBeenCalledWith('dataset-1')
      expect(cacheHarness.getPersistedColumnIds).toHaveBeenCalledWith('dataset-1')
    })

    const handled = await act(async () => {
      return await keyboardHarness.handlers.onSelectAll?.()
    })

    expect(handled).toBe(true)
    expect(storeHarness.state.setSelectedColumns).toHaveBeenLastCalledWith([
      'col-1',
      'col-2',
      'col-3',
    ])
    expect(storeHarness.state.setSelectedRows).toHaveBeenLastCalledWith([])
  })
})
