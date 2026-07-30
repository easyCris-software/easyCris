import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { CompactSelection } from '@glideapps/glide-data-grid'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SpreadsheetView, { resetSpreadsheetViewSharedOverlayStateForTests } from '../SpreadsheetView'

const gridHarness = vi.hoisted(() => ({
  getCellContent: null as null | ((cell: [number, number]) => any),
}))

const sourceRows = [
  { 'col-1': 10, 'col-2': '' },
  { 'col-1': 20, 'col-2': '' },
  { 'col-1': '', 'col-2': '' },
]

const tauriHarness = vi.hoisted(() => ({
  loadDataRows: vi.fn().mockImplementation(async (_datasetId: string, start: number, end: number) => {
    return sourceRows.slice(start, end)
  }),
  evaluateFormulaRange: vi.fn(),
}))

const clipboardHarness = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
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
  getRowsHybrid: vi.fn().mockImplementation(async (_datasetId: string, start: number, end: number) => {
    return sourceRows.slice(start, end)
  }),
  queueCellUpdate: vi.fn(),
  updateCellsBatch: vi.fn().mockResolvedValue(0),
  enqueueGridMutationBatch: vi.fn().mockResolvedValue({ accepted: true, queueId: 'q-1' }),
  flushGridMutationQueue: vi.fn().mockResolvedValue(undefined),
  scheduleOverlayFlush: vi.fn(),
  insertRowAt: vi.fn().mockResolvedValue(0),
  insertRowsAt: vi.fn().mockResolvedValue(0),
  removeRowAt: vi.fn().mockResolvedValue(0),
  getGridMutationQueueState: vi.fn(() => ({ status: 'idle', failedQueueId: null, error: null })),
  subscribeGridMutationQueue: vi.fn((_datasetId: string, listener: (state: any) => void) => {
    listener({ status: 'idle', failedQueueId: null, error: null })
    return () => {}
  }),
  retryGridMutationQueue: vi.fn().mockResolvedValue(undefined),
}))

const undoHarness = vi.hoisted(() => ({
  pushCellEdit: vi.fn().mockResolvedValue({ can_undo: true, can_redo: false, undo_count: 1, redo_count: 0 }),
  pushBatchCellEdit: vi.fn().mockResolvedValue({ can_undo: true, can_redo: false, undo_count: 1, redo_count: 0 }),
  enqueueBatchCellEdit: vi.fn().mockResolvedValue({ can_undo: true, can_redo: false, undo_count: 1, redo_count: 0 }),
  trackPendingBatchRegistration: vi.fn(),
  recordGridTransaction: vi.fn().mockResolvedValue(undefined),
  undo: vi.fn().mockResolvedValue(null),
  redo: vi.fn().mockResolvedValue(null),
}))

const storeHarness = vi.hoisted(() => {
  const dataset = {
    id: 'dataset-1',
    name: 'dataset-1',
    rowCount: 100,
    dataRowCount: 3,
    columns: [
      { id: 'col-1', name: 'A', type: 'text', width: 88 },
      { id: 'col-2', name: 'B', type: 'text', width: 88 },
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
    updateDataset: vi.fn(),
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
  useKeyboardShortcuts: () => undefined,
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

vi.mock('@/services/tauriApi', () => ({
  tauriApi: {
    loadDataRows: tauriHarness.loadDataRows,
    evaluateFormulaRange: tauriHarness.evaluateFormulaRange,
  },
}))

vi.mock('@/services/cacheService', () => ({
  default: cacheHarness,
  cacheService: cacheHarness,
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

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )

  const makeSelection = (x: number, y: number) => ({
    current: {
      cell: [x, y] as [number, number],
      range: { x, y, width: 1, height: 1 },
      rangeStack: [],
    },
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  })

  const makeSelectionRect = (x: number, y: number, width: number, height: number) => ({
    current: {
      cell: [x, y] as [number, number],
      range: { x, y, width, height },
      rangeStack: [],
    },
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  })

  const MockDataEditor = React.forwardRef((props: any, _ref) => {
    gridHarness.getCellContent = props.getCellContent
    return (
      <div>
        <button data-testid="show-rows" onClick={() => props.onVisibleRegionChanged?.({ x: 0, y: 0, width: 2, height: 3 })}>
          show-rows
        </button>
        <button data-testid="select-formula-cell" onClick={() => props.onGridSelectionChange?.(makeSelection(1, 2))}>
          select-formula-cell
        </button>
        <button data-testid="select-source-cell" onClick={() => props.onGridSelectionChange?.(makeSelection(0, 0))}>
          select-source-cell
        </button>
        <button data-testid="select-paste-target-cell" onClick={() => props.onGridSelectionChange?.(makeSelection(1, 1))}>
          select-paste-target-cell
        </button>
        <button data-testid="select-second-paste-target-cell" onClick={() => props.onGridSelectionChange?.(makeSelection(1, 2))}>
          select-second-paste-target-cell
        </button>
        <button data-testid="select-row-1-two-cols" onClick={() => props.onGridSelectionChange?.(makeSelectionRect(0, 1, 2, 1))}>
          select-row-1-two-cols
        </button>
      </div>
    )
  })
  MockDataEditor.displayName = 'MockDataEditor'

  return { ...actual, DataEditor: MockDataEditor }
})

vi.mock('@/lib/grid/editExecutor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/grid/editExecutor')>()
  return {
    ...actual,
    createEditExecutor: vi.fn((config: any) =>
      actual.createEditExecutor(config, {
        cacheService: cacheHarness as any,
        undoService: undoHarness as any,
      })
    ),
  }
})

describe('SpreadsheetView formula display commit', () => {
  beforeEach(() => {
    resetSpreadsheetViewSharedOverlayStateForTests()
    gridHarness.getCellContent = null
    tauriHarness.loadDataRows.mockClear()
    tauriHarness.evaluateFormulaRange.mockClear()
    clipboardHarness.read.mockReset()
    clipboardHarness.write.mockClear()
    cacheHarness.queueCellUpdate.mockClear()
    cacheHarness.flushOverlay.mockReset().mockResolvedValue(undefined)
  })

  it('renders computed formula result instead of raw formula text after commit', async () => {
    render(<SpreadsheetView />)

    fireEvent.click(screen.getByTestId('show-rows'))

    await waitFor(() => {
      expect(gridHarness.getCellContent).toBeTypeOf('function')
      expect(gridHarness.getCellContent?.([0, 0])?.displayData).toBe('10')
      expect(gridHarness.getCellContent?.([0, 1])?.displayData).toBe('20')
    })

    fireEvent.click(screen.getByTestId('select-formula-cell'))

    const formulaBar = screen.getByPlaceholderText(/type a value or formula/i)
    fireEvent.focus(formulaBar)
    fireEvent.change(formulaBar, { target: { value: '=SUM(A1:A2)' } })

    await act(async () => {
      fireEvent.keyDown(formulaBar, { key: 'Enter' })
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([1, 2])?.displayData).toBe('30')
    })
    expect(tauriHarness.evaluateFormulaRange).not.toHaveBeenCalled()
  })

  it('repaints dependent formula cells after a source cell edit', async () => {
    render(<SpreadsheetView />)

    fireEvent.click(screen.getByTestId('show-rows'))

    await waitFor(() => {
      expect(gridHarness.getCellContent).toBeTypeOf('function')
      expect(gridHarness.getCellContent?.([0, 0])?.displayData).toBe('10')
      expect(gridHarness.getCellContent?.([0, 1])?.displayData).toBe('20')
    })

    fireEvent.click(screen.getByTestId('select-formula-cell'))

    const formulaBar = screen.getByPlaceholderText(/type a value or formula/i)
    fireEvent.focus(formulaBar)
    fireEvent.change(formulaBar, { target: { value: '=SUM(A1:A2)' } })

    await act(async () => {
      fireEvent.keyDown(formulaBar, { key: 'Enter' })
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([1, 2])?.displayData).toBe('30')
    })

    fireEvent.click(screen.getByTestId('select-source-cell'))
    fireEvent.focus(formulaBar)
    fireEvent.change(formulaBar, { target: { value: '15' } })

    await act(async () => {
      fireEvent.keyDown(formulaBar, { key: 'Enter' })
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])?.displayData).toBe('15')
      expect(gridHarness.getCellContent?.([1, 2])?.displayData).toBe('35')
    })
    expect(tauriHarness.evaluateFormulaRange).not.toHaveBeenCalled()
  })

  it('repaints dependent formula cells after paste updates the source cell', async () => {
    let capturedPaste: (() => void | Promise<void>) | null = null
    render(<SpreadsheetView onPasteRequest={fn => { capturedPaste = fn }} />)

    fireEvent.click(screen.getByTestId('show-rows'))

    await waitFor(() => {
      expect(gridHarness.getCellContent).toBeTypeOf('function')
      expect(gridHarness.getCellContent?.([0, 0])?.displayData).toBe('10')
      expect(gridHarness.getCellContent?.([0, 1])?.displayData).toBe('20')
    })

    fireEvent.click(screen.getByTestId('select-formula-cell'))

    const formulaBar = screen.getByPlaceholderText(/type a value or formula/i)
    fireEvent.focus(formulaBar)
    fireEvent.change(formulaBar, { target: { value: '=SUM(A1:A2)' } })

    await act(async () => {
      fireEvent.keyDown(formulaBar, { key: 'Enter' })
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([1, 2])?.displayData).toBe('30')
    })

    clipboardHarness.read.mockResolvedValue('15')
    fireEvent.click(screen.getByTestId('select-source-cell'))

    await act(async () => {
      await capturedPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])?.displayData).toBe('15')
      expect(gridHarness.getCellContent?.([1, 2])?.displayData).toBe('35')
    })
    expect(tauriHarness.evaluateFormulaRange).not.toHaveBeenCalled()
  })

  it('keeps cut and paste cells visible while persistence is pending', async () => {
    let capturedCut: (() => void | Promise<void>) | null = null
    let capturedPaste: (() => void | Promise<void>) | null = null
    cacheHarness.flushOverlay.mockImplementation(() => new Promise<void>(() => {}))
    render(
      <SpreadsheetView
        onCutRequest={fn => { capturedCut = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )

    fireEvent.click(screen.getByTestId('show-rows'))

    await waitFor(() => {
      expect(gridHarness.getCellContent).toBeTypeOf('function')
      expect(gridHarness.getCellContent?.([0, 0])?.displayData).toBe('10')
      expect(gridHarness.getCellContent?.([1, 1])?.displayData).toBe('')
    })

    fireEvent.click(screen.getByTestId('select-source-cell'))

    await act(async () => {
      await capturedCut?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    const cutClipboardValue = clipboardHarness.write.mock.calls.at(-1)?.[0]
    expect(cutClipboardValue).toBe('10')

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])?.displayData).toBe('')
    })

    clipboardHarness.read.mockResolvedValue(String(cutClipboardValue))
    fireEvent.click(screen.getByTestId('select-paste-target-cell'))

    await act(async () => {
      await capturedPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([0, 0])?.displayData).toBe('')
      expect(gridHarness.getCellContent?.([1, 1])?.displayData).toBe('10')
    })
  })

  it('copies and cuts overlay-authoritative pasted cells', async () => {
    let capturedCopy: (() => void | Promise<void>) | null = null
    let capturedCut: (() => void | Promise<void>) | null = null
    let capturedPaste: (() => void | Promise<void>) | null = null
    cacheHarness.flushOverlay.mockImplementation(() => new Promise<void>(() => {}))
    const { unmount } = render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
        onCutRequest={fn => { capturedCut = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )

    fireEvent.click(screen.getByTestId('show-rows'))

    await waitFor(() => {
      expect(gridHarness.getCellContent).toBeTypeOf('function')
      expect(gridHarness.getCellContent?.([0, 0])?.displayData).toBe('10')
      expect(gridHarness.getCellContent?.([1, 1])?.displayData).toBe('')
    })

    clipboardHarness.read.mockResolvedValue('10')
    fireEvent.click(screen.getByTestId('select-paste-target-cell'))

    await act(async () => {
      await capturedPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([1, 1])?.displayData).toBe('10')
    })

    // Stale range read keeps the visible cell overlay-authoritative while base data is blank.
    const getRowsCallCountBeforeStaleReload = cacheHarness.getRowsHybrid.mock.calls.length
    cacheHarness.getRowsHybrid.mockResolvedValueOnce(sourceRows)
    unmount()
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
        onCutRequest={fn => { capturedCut = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )
    fireEvent.click(screen.getByTestId('show-rows'))

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid.mock.calls.length).toBeGreaterThan(getRowsCallCountBeforeStaleReload)
    })

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([1, 1])?.displayData).toBe('10')
    })

    clipboardHarness.write.mockClear()
    await act(async () => {
      await capturedCopy?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(clipboardHarness.write).toHaveBeenLastCalledWith('10')

    clipboardHarness.write.mockClear()
    await act(async () => {
      await capturedCut?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(clipboardHarness.write).toHaveBeenLastCalledWith('10')
    await waitFor(() => {
      expect(gridHarness.getCellContent?.([1, 1])?.displayData).toBe('')
    })

    clipboardHarness.read.mockResolvedValue('10')
    fireEvent.click(screen.getByTestId('select-second-paste-target-cell'))

    await act(async () => {
      await capturedPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([1, 2])?.displayData).toBe('10')
    })
  })

  it('merges partial overlay values with backend rows when copying multiple columns', async () => {
    let capturedCopy: (() => void | Promise<void>) | null = null
    let capturedCut: (() => void | Promise<void>) | null = null
    let capturedPaste: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
        onCutRequest={fn => { capturedCut = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )

    clipboardHarness.read.mockResolvedValue('10')
    fireEvent.click(screen.getByTestId('select-paste-target-cell'))

    await act(async () => {
      await capturedPaste?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(gridHarness.getCellContent?.([1, 1])?.displayData).toBe('10')
    })

    fireEvent.click(screen.getByTestId('select-row-1-two-cols'))
    clipboardHarness.write.mockClear()

    await act(async () => {
      await capturedCopy?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(clipboardHarness.write).toHaveBeenLastCalledWith('20\t10')

    clipboardHarness.write.mockClear()
    await act(async () => {
      await capturedCut?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(clipboardHarness.write).toHaveBeenLastCalledWith('20\t10')
  })
})
