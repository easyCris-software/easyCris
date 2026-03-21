import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import SpreadsheetView from '../SpreadsheetView'
import { CompactSelection } from '@glideapps/glide-data-grid'

const harness = vi.hoisted(() => ({
  latestDataEditorProps: null as any,
  fillPreventDefault: vi.fn(),
  executeEdits: vi.fn().mockResolvedValue(undefined),
  executeSingleEdit: vi.fn(),
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

vi.mock('@/services/cacheService', () => ({
  default: {
    getDatasetStorageInfo: vi.fn().mockResolvedValue(null),
    getRowsHybrid: vi.fn().mockResolvedValue([]),
  },
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

describe('SpreadsheetView formula interaction flow (mounted)', () => {
  beforeEach(() => {
    harness.latestDataEditorProps = null
    harness.fillPreventDefault.mockClear()
    harness.executeEdits.mockClear()
    harness.executeSingleEdit.mockClear()
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
