import React from 'react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import SpreadsheetView from '../SpreadsheetView'
import { CompactSelection } from '@glideapps/glide-data-grid'

const harness = vi.hoisted(() => ({
  latestDataEditorProps: null as any,
  fillPreventDefault: vi.fn(),
  executeEdits: vi.fn().mockResolvedValue(undefined),
  executeSingleEdit: vi.fn(),
}))

// Captures the most recently created FormulaService instance so tests can
// call evaluate() directly to trigger enqueueBackendEval from outside the component.
// Also captures enqueueBackendEval from the most recent setBackendEvalContext call,
// so tests can trigger a backend request without needing formula routing to be live.
const formulaServiceHarness = vi.hoisted(() => ({
  latestService: null as any,
  capturedEnqueueFn: null as any,  // set each time setBackendEvalContext receives a context
}))

const dataStoreHarness = vi.hoisted(() => {
  const dataset = {
    id: 'dataset-1',
    name: 'dataset-1',
    rowCount: 2,
    dataRowCount: 2,
    columns: [{ id: 'col-0', name: 'Column 1', type: 'numeric' }],
  } as any

  const dataStoreState = {
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
    allocateNextAutoColumnName: vi.fn(),
    rollbackAutoColumnNameAllocation: vi.fn(),
    insertColumnAtDataset: vi.fn(),
    insertRowAtDataset: vi.fn(),
    removeColumnAtDataset: vi.fn(),
    removeRowAtDataset: vi.fn(),
    setHighlightsBatch: vi.fn(),
    removeHighlightsBatch: vi.fn(),
  }

  const dataStoreGetState = {
    datasets: [dataset],
    currentDataset: dataset,
    getDatasetFormulas: vi.fn(() => new Map()),
    setDatasetFormulas: vi.fn(),
    updateDataset: vi.fn(),
  }

  const useDataStore = vi.fn(() => dataStoreState)
  ;(useDataStore as any).getState = () => dataStoreGetState

  return {
    dataset,
    dataStoreState,
    dataStoreGetState,
    useDataStore,
  }
})

const appStoreHarness = vi.hoisted(() => {
  const appStoreState = {
    activeFamilyId: 'statistics-1',
    projectId: 'project-1',
    setProjectDirty: vi.fn(),
    updateActiveFamilyData: vi.fn(),
  }

  const useAppStore = vi.fn((selector?: any) =>
    typeof selector === 'function' ? selector(appStoreState) : appStoreState
  )
  ;(useAppStore as any).getState = () => appStoreState

  return {
    appStoreState,
    useAppStore,
  }
})

const makeSelection = (range: { x: number; y: number; width: number; height: number }) => ({
  current: {
    cell: [range.x, range.y] as [number, number],
    range,
    rangeStack: [],
  },
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
})

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )

  const MockDataEditor = React.forwardRef((props: any, _ref: React.ForwardedRef<any>) => {
    harness.latestDataEditorProps = props

    return (
      <div>
        <button
          data-testid="trigger-fill-pattern"
          onClick={() => {
            harness.fillPreventDefault.mockClear()
            void props.onFillPattern?.({
              patternSource: { x: 0, y: 0, width: 1, height: 1 },
              fillDestination: { x: 0, y: 0, width: 1, height: 2 },
              preventDefault: harness.fillPreventDefault,
            })
          }}
        >
          fill
        </button>
        <button
          data-testid="trigger-selection-change"
          onClick={() => {
            props.onGridSelectionChange?.(makeSelection({ x: 0, y: 0, width: 1, height: 2 }))
          }}
        >
          select
        </button>
        <button
          data-testid="trigger-header-autofit"
          onClick={() => {
            props.onHeaderClicked?.(0, {
              kind: 'header',
              isDoubleClick: true,
              isEdge: true,
              preventDefault: vi.fn(),
            })
          }}
        >
          autofit
        </button>
      </div>
    )
  })
  MockDataEditor.displayName = 'MockDataEditor'

  return {
    ...actual,
    DataEditor: MockDataEditor,
  }
})

vi.mock('@/hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: () => undefined,
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/services/tauriApi', () => ({
  tauriApi: {
    loadDataRows: vi.fn().mockResolvedValue([]),
    evaluateFormulaRange: vi.fn(),
  },
}))

const cacheHarness = vi.hoisted(() => ({
  getDatasetStorageInfo: vi.fn().mockResolvedValue(null),
  getAllColumnStats: vi.fn().mockResolvedValue([]),
  getPersistedColumnIds: vi.fn().mockResolvedValue(['col-0']),
  getRowsHybrid: vi.fn().mockResolvedValue([]),
  evaluateFormulaBackend: vi.fn().mockResolvedValue(null),
  ensureDuckDbDataset: vi.fn().mockResolvedValue(null),
  getGridMutationQueueState: vi.fn(() => ({ status: 'idle', failedQueueId: null, error: null })),
  subscribeGridMutationQueue: vi.fn((_datasetId: string, listener: (state: any) => void) => {
    listener({ status: 'idle', failedQueueId: null, error: null })
    return () => {}
  }),
  queueCellUpdate: vi.fn(),
}))

vi.mock('@/services/cacheService', () => ({
  default: cacheHarness,
}))

vi.mock('@/lib/grid/editExecutor', () => ({
  createEditExecutor: vi.fn(() => ({
    execute: harness.executeEdits,
    executeSingle: harness.executeSingleEdit,
  })),
}))

vi.mock('@/store/data-store', () => ({
  useDataStore: dataStoreHarness.useDataStore,
}))

vi.mock('@/store/app-store', () => ({
  useAppStore: appStoreHarness.useAppStore,
  ensureProjectId: vi.fn().mockResolvedValue('project-1'),
}))

// Transparent wrapper around createFormulaService that captures the instance.
// Lets tests call evaluate() directly to trigger enqueueBackendEval without
// needing to stub internal component state.
vi.mock('@/lib/grid/formulas/formulaService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/grid/formulas/formulaService')>()
  return {
    ...actual,
    createFormulaService: (...args: Parameters<typeof actual.createFormulaService>) => {
      const svc = actual.createFormulaService(...args)
      formulaServiceHarness.latestService = svc

      // Intercept setBackendEvalContext to capture enqueueBackendEval as soon as
      // the component sets up its backend context. Allows tests to trigger a backend
      // request directly without needing formula routing to be live.
      const origSetCtx = svc.setBackendEvalContext.bind(svc)
      svc.setBackendEvalContext = (ctx: any) => {
        origSetCtx(ctx)
        if (ctx?.enqueueBackendEval) {
          formulaServiceHarness.capturedEnqueueFn = ctx.enqueueBackendEval
        }
      }

      return svc
    },
  }
})

describe('SpreadsheetView formula interaction flow (mounted)', () => {
  beforeEach(() => {
    harness.latestDataEditorProps = null
    harness.fillPreventDefault.mockClear()
    harness.executeEdits.mockClear()
    harness.executeSingleEdit.mockClear()
    cacheHarness.getAllColumnStats.mockClear()
    cacheHarness.getPersistedColumnIds.mockClear()
    cacheHarness.getGridMutationQueueState.mockClear()
    cacheHarness.subscribeGridMutationQueue.mockClear()
    dataStoreHarness.dataStoreState.updateViewport.mockClear()
    dataStoreHarness.dataStoreState.updateDataset.mockClear()
    dataStoreHarness.dataStoreGetState.getDatasetFormulas.mockClear()
  })

  it('blocks fill during active formula range-pick from formula bar', async () => {
    render(<SpreadsheetView />)

    const formulaBarInput = screen.getByPlaceholderText(/type a value or formula/i)
    fireEvent.focus(formulaBarInput)
    fireEvent.change(formulaBarInput, { target: { value: '=SUM(' } })

    await waitFor(() => {
      expect(harness.latestDataEditorProps?.fillHandle).toBe(false)
    })

    fireEvent.click(screen.getByTestId('trigger-fill-pattern'))

    await waitFor(() => {
      expect(harness.fillPreventDefault).toHaveBeenCalled()
      expect(harness.executeEdits).not.toHaveBeenCalled()
    })
  })

  it('defers selection apply while pointer is down and finalizes on pointer up', async () => {
    render(<SpreadsheetView />)

    const formulaBarInput = screen.getByPlaceholderText(/type a value or formula/i) as HTMLInputElement
    fireEvent.focus(formulaBarInput)
    fireEvent.change(formulaBarInput, { target: { value: '=SUM(' } })

    fireEvent.mouseDown(window)
    fireEvent.click(screen.getByTestId('trigger-selection-change'))

    expect((screen.getByPlaceholderText(/type a value or formula/i) as HTMLInputElement).value).toBe(
      '=SUM('
    )

    fireEvent.mouseUp(window)

    await waitFor(() => {
      expect((screen.getByPlaceholderText(/type a value or formula/i) as HTMLInputElement).value).toContain(
        'A1:A2'
      )
    })
  })

  it('finalizes deferred range-pick on pointercancel', async () => {
    render(<SpreadsheetView />)

    const formulaBarInput = screen.getByPlaceholderText(/type a value or formula/i) as HTMLInputElement
    fireEvent.focus(formulaBarInput)
    fireEvent.change(formulaBarInput, { target: { value: '=SUM(' } })

    fireEvent.mouseDown(window)
    fireEvent.click(screen.getByTestId('trigger-selection-change'))

    await act(async () => {
      window.dispatchEvent(new Event('pointercancel'))
    })

    await waitFor(() => {
      expect((screen.getByPlaceholderText(/type a value or formula/i) as HTMLInputElement).value).toContain(
        'A1:A2'
      )
    })
  })

  it('finalizes deferred range-pick on window blur fallback', async () => {
    render(<SpreadsheetView />)

    const formulaBarInput = screen.getByPlaceholderText(/type a value or formula/i) as HTMLInputElement
    fireEvent.focus(formulaBarInput)
    fireEvent.change(formulaBarInput, { target: { value: '=SUM(' } })

    fireEvent.mouseDown(window)
    fireEvent.click(screen.getByTestId('trigger-selection-change'))

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
    })

    await waitFor(() => {
      expect((screen.getByPlaceholderText(/type a value or formula/i) as HTMLInputElement).value).toContain(
        'A1:A2'
      )
    })
  })

  it('clears formula-bar range session on true outside blur', async () => {
    render(<SpreadsheetView />)

    const formulaBarInput = screen.getByPlaceholderText(/type a value or formula/i) as HTMLInputElement
    fireEvent.focus(formulaBarInput)
    fireEvent.change(formulaBarInput, { target: { value: '=SUM(' } })

    await waitFor(() => {
      expect(harness.latestDataEditorProps?.fillHandle).toBe(false)
    })

    fireEvent.blur(formulaBarInput)

    await waitFor(() => {
      expect(harness.latestDataEditorProps?.fillHandle).toBe(true)
    })
  })

  it('auto-fits column width on header edge double-click', async () => {
    render(<SpreadsheetView />)

    fireEvent.click(screen.getByTestId('trigger-header-autofit'))

    await waitFor(() => {
      expect(dataStoreHarness.dataStoreState.updateDataset).toHaveBeenCalled()
    })

    const [datasetId, updates] = dataStoreHarness.dataStoreState.updateDataset.mock.calls.at(-1) ?? []
    expect(datasetId).toBe(dataStoreHarness.dataset.id)
    expect(Array.isArray(updates?.columns)).toBe(true)
    expect(typeof updates?.columns?.[0]?.width).toBe('number')
  })

  it('mirrors active formula draft in target cell without mutating dataset before commit', async () => {
    render(<SpreadsheetView />)

    fireEvent.click(screen.getByTestId('trigger-selection-change'))

    const formulaBarInput = screen.getByPlaceholderText(/type a value or formula/i) as HTMLInputElement
    fireEvent.focus(formulaBarInput)
    fireEvent.change(formulaBarInput, { target: { value: '=SUM(' } })

    await waitFor(() => {
      expect(formulaBarInput.value).toBe('=SUM(')
    })

    const getCellContent = harness.latestDataEditorProps?.getCellContent as
      | ((cell: readonly [number, number]) => any)
      | undefined
    expect(getCellContent).toBeTypeOf('function')

    const draftCellBeforeRange = getCellContent?.([0, 0])
    expect(draftCellBeforeRange?.displayData).toBe('=SUM(')

    fireEvent.mouseDown(window)
    fireEvent.click(screen.getByTestId('trigger-selection-change'))
    fireEvent.mouseUp(window)

    await waitFor(() => {
      expect(formulaBarInput.value).toContain('A2')
    })

    const getCellContentAfterRange = harness.latestDataEditorProps?.getCellContent as
      | ((cell: readonly [number, number]) => any)
      | undefined
    const draftCellAfterRange = getCellContentAfterRange?.([0, 0])
    expect(draftCellAfterRange?.displayData).toContain('A2')

    expect(dataStoreHarness.dataStoreState.updateCellValue).not.toHaveBeenCalled()
    expect(harness.executeSingleEdit).not.toHaveBeenCalled()
    expect(harness.executeEdits).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// StrictMode mount/unmount regression guard
// ---------------------------------------------------------------------------
// Verifies that pending backend eval AbortControllers are aborted when the
// component unmounts, preventing orphaned IPC requests from settling cells
// that no longer exist.
//
// Uses StrictMode to expose double-invoke bugs: React 18 StrictMode mounts,
// unmounts (cleanup), then remounts each component in dev mode. Any effect
// that leaks state across the unmount/remount boundary will produce observable
// failures here.

describe('SpreadsheetView backend eval abort on unmount', () => {
  let abortSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Return a storageInfo so getStorageInfo resolves and backend context is established.
    cacheHarness.getDatasetStorageInfo.mockResolvedValue({
      isLarge: true,
      duckdbPath: '/fake/dataset.db',
    } as any)
    cacheHarness.ensureDuckDbDataset.mockResolvedValue({
      isLarge: true,
      duckdbPath: '/fake/dataset.db',
    } as any)

    // Never-resolving backend eval — simulates a long-running IPC call.
    cacheHarness.evaluateFormulaBackend.mockImplementation(() => new Promise(() => {}))

    abortSpy = vi.spyOn(AbortController.prototype, 'abort')
  })

  afterEach(() => {
    abortSpy.mockRestore()
    cacheHarness.getDatasetStorageInfo.mockResolvedValue(null)
    cacheHarness.evaluateFormulaBackend.mockResolvedValue(null)
    cacheHarness.ensureDuckDbDataset.mockResolvedValue(null)
  })

  it('STRICTMODE_ABORT: pending backend requests are aborted when component unmounts', async () => {
    /**
     * Dataset-scope effect cleanup must abort all in-flight AbortControllers on unmount.
     * This prevents orphaned IPC responses from settling cells after remount.
     *
     * Approach:
     *   1. Wrap in StrictMode (mount → StrictMode cleanup → remount cycle).
     *   2. Wait for enqueueBackendEval to be captured from setBackendEvalContext — this
     *      confirms the backend context is live on the current component instance.
     *   3. Call capturedEnqueueFn directly with a minimal request — this creates an
     *      AbortController in pendingBackendEvalRequestsRef and calls evaluateFormulaBackend.
     *   4. Unmount — dataset-scope cleanup calls controller.abort() on all pending entries.
     */
    formulaServiceHarness.latestService = null
    formulaServiceHarness.capturedEnqueueFn = null

    const { unmount } = render(
      <React.StrictMode>
        <SpreadsheetView />
      </React.StrictMode>
    )

    // Wait for the component to establish backend context (async effect chain resolves).
    // capturedEnqueueFn is set by the setBackendEvalContext interceptor once context is live.
    await waitFor(() => {
      expect(
        formulaServiceHarness.capturedEnqueueFn,
        'enqueueBackendEval must have been captured from setBackendEvalContext'
      ).not.toBeNull()
    }, { timeout: 3000 })

    // Call enqueueBackendEval directly with a minimal request.
    // This creates an AbortController stored in pendingBackendEvalRequestsRef and starts
    // the never-resolving evaluateFormulaBackend call (simulating an in-flight IPC).
    const testRequest = {
      cellKey: '0:col-0',
      requestId: 'test-req-abort-001',
      formula: '=MAXIFS(A1:A3,B1:B3,">1")',
      position: { row: 0, col: 0 },
      columnLetterToIdMap: { A: 'col-0' },
    }
    void formulaServiceHarness.capturedEnqueueFn(testRequest)

    // Wait for enqueueBackendEval to have reached the evaluateFormulaBackend call.
    await waitFor(() => {
      expect(
        cacheHarness.evaluateFormulaBackend,
        'evaluateFormulaBackend must be called — controller is now in-flight'
      ).toHaveBeenCalled()
    })

    abortSpy.mockClear()

    // Wrap in act so React flushes the useEffect cleanup synchronously before the assertion.
    await act(async () => { unmount() })

    // Dataset-scope cleanup aborts all pending AbortControllers on unmount.
    expect(
      abortSpy,
      'pending backend eval controllers must be aborted on unmount'
    ).toHaveBeenCalled()
  })
})
