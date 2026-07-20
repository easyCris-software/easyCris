/**
 * SpreadsheetView.filter.dom.test.tsx
 *
 * DOM integration tests for the Excel-style view filter (Phase 1).
 * Written RED-first — all tests fail until SpreadsheetView wiring is complete.
 *
 * Tests:
 *   TITLE_COMPOSE     - deriveColumnTitles: sort + filter indicators compose
 *   FILTER_INDICATOR  - deriveColumnTitles: ▾ on filtered column only
 *   FILTER_NO_IND     - deriveColumnTitles: no indicator when config is null
 *   FILTER_DIALOG_OPEN  - onFilterDialogRequest exposes open(); calling it shows dialog
 *   FILTER_DIALOG_APPLY - dialog onApply closes dialog and activates filter state
 *   FILTER_HIDES_ROWS   - active filter reduces DataEditor row count
 *   FILTER_CLEAR        - clearing filter restores full row count
 *   FILTER_GATE_OFF     - enableExcelViewFilter=false: filter never applied
 */

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@/test/test-utils'
import SpreadsheetView from '../SpreadsheetView'
import type { FilterConfig } from '@/services/dataTransformService'

// ---------------------------------------------------------------------------
// Harness — captures DataEditor props rendered by SpreadsheetView
// ---------------------------------------------------------------------------

const gridHarness = vi.hoisted(() => ({
  latestProps: null as any,
}))

// ---------------------------------------------------------------------------
// filterColumnsSnapshot mock — returns controlled row data synchronously
// ---------------------------------------------------------------------------

const snapshotHarness = vi.hoisted(() => ({
  buildFullRowsByIndex: vi.fn().mockResolvedValue(new Map<number, Record<string, unknown>>([
    [0, { name: 'Alice' }],
    [1, { name: 'Bob' }],
    [2, { name: 'Alice' }],
  ])),
}))

vi.mock('@/lib/grid/filterColumnsSnapshot', () => ({
  buildFullRowsByIndex: snapshotHarness.buildFullRowsByIndex,
  ViewFilterError: class ViewFilterError extends Error {
    constructor(msg: string, opts?: ErrorOptions) { super(msg, opts); this.name = 'ViewFilterError' }
  },
}))

// ---------------------------------------------------------------------------
// AdvancedFilterDialog mock — renders a simple apply/cancel UI for tests
// ---------------------------------------------------------------------------

const dialogHarness = vi.hoisted(() => ({
  lastOnApply: null as ((config: FilterConfig | null) => void) | null,
  lastOnOpenChange: null as ((open: boolean) => void) | null,
  lastInitialConfig: undefined as FilterConfig | null | undefined,
  lastData: undefined as Record<string, any>[] | undefined,
  lastColumns: undefined as any[] | undefined,
  openCalls: 0,
}))

vi.mock('@/components/dialogs/AdvancedFilterDialog', () => ({
  AdvancedFilterDialog: (props: any) => {
    dialogHarness.lastOnApply = props.onApply
    dialogHarness.lastOnOpenChange = props.onOpenChange
    dialogHarness.lastInitialConfig = props.initialConfig
    dialogHarness.lastData = props.data
    dialogHarness.lastColumns = props.columnMetadata
    if (props.open) dialogHarness.openCalls++
    if (!props.open) return null
    return (
      <div role="dialog" aria-label="Filter dialog">
        <button
          data-testid="mock-dialog-apply"
          onClick={() =>
            props.onApply?.({
              groups: [{ op: 'AND', conditions: [{ columnId: 'name', operator: 'eq', value: 'Alice' }] }],
            })
          }
        >
          Apply
        </button>
        <button data-testid="mock-dialog-cancel" onClick={() => props.onOpenChange?.(false)}>
          Cancel
        </button>
      </div>
    )
  },
}))

// ---------------------------------------------------------------------------
// DataEditor mock — captures props so tests can inspect row count
// ---------------------------------------------------------------------------

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )
  const MockDataEditor = React.forwardRef((props: any, _ref: React.ForwardedRef<any>) => {
    gridHarness.latestProps = props
    return <div data-testid="mock-data-editor" data-rows={props.rows} />
  })
  MockDataEditor.displayName = 'MockDataEditor'
  return { ...actual, DataEditor: MockDataEditor }
})

// ---------------------------------------------------------------------------
// Store mocks
// ---------------------------------------------------------------------------

const dataStoreHarness = vi.hoisted(() => {
  const dataset = {
    id: 'filter-test-dataset',
    name: 'filter-test',
    rowCount: 3,
    dataRowCount: 3,
    columns: [{ id: 'name', name: 'Name', type: 'text' }],
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
    allocateNextAutoColumnName: vi.fn(),
    rollbackAutoColumnNameAllocation: vi.fn(),
    insertColumnAtDataset: vi.fn(),
    insertRowAtDataset: vi.fn(),
    removeColumnAtDataset: vi.fn(),
    removeRowAtDataset: vi.fn(),
    setHighlightsBatch: vi.fn(),
    removeHighlightsBatch: vi.fn(),
  }

  const stateGet = {
    datasets: [dataset],
    currentDataset: dataset,
    getDatasetFormulas: vi.fn(() => new Map()),
    setDatasetFormulas: vi.fn(),
    updateDataset: vi.fn(),
  }

  const useDataStore = vi.fn(() => state)
  ;(useDataStore as any).getState = () => stateGet

  return { dataset, state, stateGet, useDataStore }
})

const appStoreHarness = vi.hoisted(() => {
  const s = {
    activeFamilyId: 'statistics-1',
    projectId: 'project-1',
    setProjectDirty: vi.fn(),
    updateActiveFamilyData: vi.fn(),
  }
  const useAppStore = vi.fn((sel?: any) => (typeof sel === 'function' ? sel(s) : s))
  ;(useAppStore as any).getState = () => s
  return { s, useAppStore }
})

vi.mock('@/store/data-store', () => ({ useDataStore: dataStoreHarness.useDataStore }))
vi.mock('@/store/app-store', () => ({
  useAppStore: appStoreHarness.useAppStore,
  ensureProjectId: vi.fn().mockResolvedValue('project-1'),
}))

const cacheHarness = vi.hoisted(() => ({
  getDatasetStorageInfo: vi.fn().mockResolvedValue(null),
  getRowsHybrid: vi.fn().mockResolvedValue([]),
  evaluateFormulaBackend: vi.fn().mockResolvedValue(null),
  ensureDuckDbDataset: vi.fn().mockResolvedValue(null),
  ensureLatestCache: vi.fn().mockResolvedValue(undefined),
  getColumnsData: vi.fn().mockResolvedValue({ name: ['Alice', 'Bob', 'Alice'] }),
  getAllColumnStats: vi.fn().mockResolvedValue([]),
  getPersistedColumnIds: vi.fn().mockResolvedValue([]),
  getGridMutationQueueState: vi.fn().mockReturnValue({ status: 'idle', failedQueueId: null, error: null }),
  subscribeGridMutationQueue: vi.fn((_datasetId: string, listener: (state: any) => void) => {
    listener({ status: 'idle', failedQueueId: null, error: null })
    return vi.fn()
  }),
  queueCellUpdate: vi.fn(),
  filterColumnsWithData: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/services/cacheService', () => ({
  cacheService: cacheHarness,
  default: cacheHarness,
}))

vi.mock('@/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: () => undefined }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn().mockResolvedValue(true) }))
vi.mock('@/services/tauriApi', () => ({
  tauriApi: { loadDataRows: vi.fn().mockResolvedValue([]), evaluateFormulaRange: vi.fn() },
}))
vi.mock('@/lib/grid/editExecutor', () => ({
  createEditExecutor: vi.fn(() => ({ execute: vi.fn(), executeSingle: vi.fn() })),
}))

// ---------------------------------------------------------------------------
// deriveColumnTitles — unit tests (tests the extracted pure helper)
// ---------------------------------------------------------------------------

// Import once the helper is exported from SpreadsheetView
import { deriveColumnTitles } from '../SpreadsheetView'

describe('deriveColumnTitles — unit', () => {
  it('FILTER_NO_IND: no filter indicator when filterConfig is null', () => {
    const titles = deriveColumnTitles(
      [{ id: 'col-a', name: 'Name' }],
      [],
      null
    )
    expect(titles[0]!.title).toBe('Name')
  })

  it('FILTER_INDICATOR: ▾ appended to filtered column only', () => {
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'col-a', operator: 'eq', value: 'Alice' }] }],
    }
    const titles = deriveColumnTitles(
      [{ id: 'col-a', name: 'Name' }, { id: 'col-b', name: 'Score' }],
      [],
      config
    )
    expect(titles.find(t => t.id === 'col-a')!.title).toBe('Name ▾')
    expect(titles.find(t => t.id === 'col-b')!.title).toBe('Score')
  })

  it('TITLE_COMPOSE: sort arrow and filter indicator both appear when both active', () => {
    const config: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'col-a', operator: 'eq', value: 'x' }] }],
    }
    const titles = deriveColumnTitles(
      [{ id: 'col-a', name: 'Name' }],
      [{ colId: 'col-a', dir: 'asc' }],
      config
    )
    expect(titles[0]!.title).toBe('Name ↑▾')
  })
})

// ---------------------------------------------------------------------------
// DOM integration — dialog open/apply/gate
// ---------------------------------------------------------------------------

describe('SpreadsheetView — filter dialog flow', () => {
  let capturedOpen: (() => void) | null = null

  beforeEach(() => {
    capturedOpen = null
    dialogHarness.openCalls = 0
    dialogHarness.lastOnApply = null
    dialogHarness.lastOnOpenChange = null
    snapshotHarness.buildFullRowsByIndex.mockResolvedValue(
      new Map<number, Record<string, unknown>>([
        [0, { name: 'Alice' }],
        [1, { name: 'Bob' }],
        [2, { name: 'Alice' }],
      ])
    )
  })

  it('FILTER_DIALOG_OPEN: onFilterDialogRequest exposes open(); calling it mounts dialog', async () => {
    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
      />
    )

    // Dialog should not be in DOM before open is called
    expect(screen.queryByRole('dialog', { name: /filter/i })).not.toBeInTheDocument()

    await act(async () => { capturedOpen?.() })

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /filter/i })).toBeInTheDocument()
    })
  })

  it('FILTER_DIALOG_APPLY: clicking Apply in dialog closes dialog', async () => {
    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
      />
    )

    await act(async () => { capturedOpen?.() })
    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))

    await act(async () => {
      screen.getByTestId('mock-dialog-apply').click()
    })

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /filter/i })).not.toBeInTheDocument()
    })
  })

  it('FILTER_GATE_OFF: when enableExcelViewFilter is false, onFilterDialogRequest is not exposed', async () => {
    let gatedOpen: (() => void) | null = null
    render(
      <SpreadsheetView
        enableExcelViewFilter={false}
        onFilterDialogRequest={(open) => { gatedOpen = open }}
      />
    )
    // Flush effects before asserting — gate check must survive mount lifecycle
    await act(async () => {})
    expect(gatedOpen).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// DOM integration — snapshot rebuilds after data mutation (rowCount change)
// ---------------------------------------------------------------------------

describe('SpreadsheetView — filter snapshot staleness', () => {
  let capturedOpen: (() => void) | null = null

  beforeEach(() => {
    capturedOpen = null
    gridHarness.latestProps = null
    // Reset dataset rowCount to 3 before each test
    dataStoreHarness.dataset.rowCount = 3
    dataStoreHarness.dataset.dataRowCount = 3
  })

  it('FILTER_SNAPSHOT_REFRESHES_AFTER_MUTATION: snapshot rebuilds when dataset rowCount changes', async () => {
    const { rerender } = render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
      />
    )

    // Apply filter — snapshot built once
    await act(async () => { capturedOpen?.() })
    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))
    await act(async () => { screen.getByTestId('mock-dialog-apply').click() })
    await waitFor(() => expect(gridHarness.latestProps.rows).toBeLessThan(3))

    const callsAfterFilter = snapshotHarness.buildFullRowsByIndex.mock.calls.length

    // Simulate a row insert: rowCount increases from 3 to 4
    dataStoreHarness.dataset.rowCount = 4
    dataStoreHarness.dataset.dataRowCount = 4

    // Re-render with updated store state
    await act(async () => {
      rerender(
        <SpreadsheetView
          enableExcelViewFilter
          onFilterDialogRequest={(open) => { capturedOpen = open }}
        />
      )
    })

    // With fix: snapshot effect re-runs because rowCount is a dep → buildFullRowsByIndex called again
    await waitFor(() => {
      expect(snapshotHarness.buildFullRowsByIndex.mock.calls.length).toBeGreaterThan(callsAfterFilter)
    })
  })
})

// ---------------------------------------------------------------------------
// DOM integration — column header indicators update after filter applied
// ---------------------------------------------------------------------------

describe('SpreadsheetView — column header filter indicators', () => {
  let capturedOpen: (() => void) | null = null

  beforeEach(() => {
    capturedOpen = null
    gridHarness.latestProps = null
    dataStoreHarness.dataset.rowCount = 3
    dataStoreHarness.dataset.dataRowCount = 3
  })

  it('FILTER_COLUMN_INDICATOR_IN_GRID: DataEditor receives ▾ in column title after filter applied', async () => {
    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())

    // Apply filter: name eq Alice
    await act(async () => { capturedOpen?.() })
    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))
    await act(async () => { screen.getByTestId('mock-dialog-apply').click() })

    await waitFor(() => {
      const cols: Array<{ title?: string }> = gridHarness.latestProps?.columns ?? []
      expect(cols.some(c => c.title?.includes('▾'))).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// DOM integration — row count changes when filter applied / cleared
// ---------------------------------------------------------------------------

describe('SpreadsheetView — filter row count', () => {
  let capturedOpen: (() => void) | null = null

  beforeEach(() => {
    capturedOpen = null
    gridHarness.latestProps = null
    dataStoreHarness.dataset.rowCount = 3
    dataStoreHarness.dataset.dataRowCount = 3
  })

  it('FILTER_HIDES_ROWS: applying filter reduces DataEditor row count', async () => {
    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
      />
    )

    // Wait for initial render — should show 3 data rows (matching dataset.rowCount)
    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    const initialRows = gridHarness.latestProps.rows

    // Apply filter: name eq Alice → should keep rows 0 and 2, hide row 1 (Bob)
    await act(async () => { capturedOpen?.() })
    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))
    await act(async () => { screen.getByTestId('mock-dialog-apply').click() })

    await waitFor(() => {
      expect(gridHarness.latestProps.rows).toBeLessThan(initialRows)
    })
  })

  it('FILTER_CLEAR: clearing filter after apply restores original row count', async () => {
    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    const initialRows = gridHarness.latestProps.rows

    // Apply filter
    await act(async () => { capturedOpen?.() })
    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))
    await act(async () => { screen.getByTestId('mock-dialog-apply').click() })
    await waitFor(() => expect(gridHarness.latestProps.rows).toBeLessThan(initialRows))

    // Clear filter — open dialog and cancel (leaves filter null) OR expose clearFilter
    // For now test via the dialog prop: onApply with null clears
    await act(async () => {
      dialogHarness.lastOnApply?.(null)
    })

    await waitFor(() => {
      expect(gridHarness.latestProps.rows).toBe(initialRows)
    })
  })

  it('VIEW_SCOPE: emits job-safe data model rows without buffer rows', async () => {
    const onViewScopeChange = vi.fn()

    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
        onViewScopeChange={onViewScopeChange}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())

    await act(async () => { capturedOpen?.() })
    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))
    await act(async () => { screen.getByTestId('mock-dialog-apply').click() })

    await waitFor(() => {
      expect(onViewScopeChange).toHaveBeenCalledWith(
        expect.objectContaining({
          datasetId: 'filter-test-dataset',
          source: 'view-filter',
          dataModelRows: [0, 2],
          dataRowCount: 2,
          totalDataRowCount: 3,
        })
      )
    })

    const filteredScope = onViewScopeChange.mock.calls
      .map(([scope]) => scope)
      .find((scope) => scope.source === 'view-filter')

    expect(filteredScope.displayRowOrder).toEqual(
      expect.arrayContaining([0, 2])
    )
    expect(filteredScope.displayRowOrder.length).toBeGreaterThanOrEqual(filteredScope.dataModelRows.length)
  })
})

// ---------------------------------------------------------------------------
// DOM integration — column header menu: race protection
// ---------------------------------------------------------------------------

describe('SpreadsheetView — column header menu race protection', () => {
  beforeEach(() => {
    gridHarness.latestProps = null
    // Reset to default mock
    cacheHarness.getColumnsData.mockResolvedValue({ name: ['Alice', 'Bob'] })
  })

  it('RACE_DATASET_SWITCH: in-flight fetch result discarded when dataset changes before resolution', async () => {
    const datasetB = {
      id: 'filter-test-dataset-B',
      name: 'filter-test-B',
      rowCount: 2,
      dataRowCount: 2,
      columns: [{ id: 'name', name: 'Name', type: 'text' }],
    }

    let resolveA!: (v: Record<string, unknown[]>) => void
    const deferredA = new Promise<Record<string, unknown[]>>((resolve) => { resolveA = resolve })
    cacheHarness.getColumnsData.mockReturnValueOnce(deferredA)

    const { rerender } = render(<SpreadsheetView enableExcelViewFilter />)
    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())

    // Click column 0 in dataset A → deferred fetch starts (no second click)
    act(() => {
      gridHarness.latestProps.onHeaderMenuClick?.(0, { x: 0, y: 0, width: 100, height: 32 })
    })

    // Switch to dataset B (no second click — requestId unchanged at 1)
    dataStoreHarness.state.currentDataset = datasetB
    dataStoreHarness.useDataStore.mockReturnValue({ ...dataStoreHarness.state })
    await act(async () => {
      rerender(<SpreadsheetView enableExcelViewFilter />)
    })

    // Resolve dataset A's deferred fetch with stale sentinel
    await act(async () => { resolveA({ name: ['STALE_FROM_A'] }) })
    await act(async () => {})

    // Stale result must NOT appear — dataset switch must have invalidated the fetch
    expect(screen.queryByRole('checkbox', { name: 'STALE_FROM_A' })).not.toBeInTheDocument()

    // Restore dataset A for cleanup
    dataStoreHarness.state.currentDataset = dataStoreHarness.dataset
    dataStoreHarness.useDataStore.mockReturnValue({ ...dataStoreHarness.state })
  })

  it('RACE_STALE_REQUEST: second header menu click supersedes first; stale async result discarded', async () => {
    let resolveFirst!: (v: Record<string, unknown[]>) => void
    const deferredFirst = new Promise<Record<string, unknown[]>>((resolve) => { resolveFirst = resolve })
    cacheHarness.getColumnsData
      .mockReturnValueOnce(deferredFirst)          // first click — deferred
      .mockResolvedValueOnce({ name: ['Current'] }) // second click — immediate

    render(<SpreadsheetView enableExcelViewFilter />)
    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())

    // First click — deferred fetch starts
    act(() => {
      gridHarness.latestProps.onHeaderMenuClick?.(0, { x: 0, y: 0, width: 100, height: 32 })
    })

    // Second click for same column — new request supersedes
    act(() => {
      gridHarness.latestProps.onHeaderMenuClick?.(0, { x: 0, y: 0, width: 100, height: 32 })
    })

    // Wait for second request to resolve
    await act(async () => {})
    await waitFor(() => screen.queryByRole('list', { name: /filter values/i }) !== null)

    // Resolve the stale first fetch with a sentinel value
    await act(async () => { resolveFirst({ name: ['STALE_VALUE'] }) })
    await act(async () => {})

    // Stale result must NOT appear in the popover
    expect(screen.queryByRole('checkbox', { name: 'STALE_VALUE' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// DOM integration — column header menu: blank values sentinel
// ---------------------------------------------------------------------------

describe('SpreadsheetView — column header menu blank values', () => {
  beforeEach(() => {
    gridHarness.latestProps = null
  })

  it('HEADER_MENU_BLANK_VALUES: null and empty column values show (Blank) in popover checklist', async () => {
    cacheHarness.getColumnsData.mockResolvedValueOnce({ name: ['Alice', null, '', 'Bob'] })

    render(<SpreadsheetView enableExcelViewFilter />)
    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())

    await act(async () => {
      gridHarness.latestProps.onHeaderMenuClick?.(0, { x: 0, y: 0, width: 100, height: 32 })
    })

    await waitFor(() => screen.getByRole('list', { name: /filter values/i }))

    expect(screen.getByRole('checkbox', { name: '(Blank)' })).toBeInTheDocument()
    // Raw empty string / null must not appear as a separate item
    expect(screen.queryByRole('checkbox', { name: '' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// DOM integration — column header menu: scroll / resize closes popover
// ---------------------------------------------------------------------------

describe('SpreadsheetView — column header menu scroll close', () => {
  beforeEach(() => {
    gridHarness.latestProps = null
    cacheHarness.getColumnsData.mockResolvedValue({ name: ['Alice', 'Bob'] })
  })

  it('HEADER_MENU_SCROLL_CLOSE: window scroll event closes the column filter popover', async () => {
    render(<SpreadsheetView enableExcelViewFilter />)
    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())

    // Open popover
    await act(async () => {
      gridHarness.latestProps.onHeaderMenuClick?.(0, { x: 0, y: 0, width: 100, height: 32 })
    })
    await waitFor(() =>
      screen.queryByRole('list', { name: /filter values/i }) !== null ||
      screen.queryByText(/loading/i) !== null
    )

    // Fire window scroll
    await act(async () => {
      window.dispatchEvent(new Event('scroll'))
    })

    // Popover must be closed
    await waitFor(() => {
      expect(screen.queryByRole('list', { name: /filter values/i })).not.toBeInTheDocument()
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — Picker-origin column filter open
// ---------------------------------------------------------------------------

describe('SpreadsheetView — picker-origin column filter', () => {
  let capturedOpenColumnFilter: ((colId: string, bounds: { x: number; y: number; width: number; height: number }) => void) | null = null

  beforeEach(() => {
    capturedOpenColumnFilter = null
    gridHarness.latestProps = null
    cacheHarness.getColumnsData.mockResolvedValue({ name: ['Alice', 'Bob'] })
  })

  it('COLUMN_FILTER_FROM_PICKER: programmatic column filter open via onColumnFilterRequest shows ColumnFilterPopoverContent', async () => {
    render(
      <SpreadsheetView
        enableExcelViewFilter
        onColumnFilterRequest={(openFn) => { capturedOpenColumnFilter = openFn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())

    // Programmatically open column filter for 'name' column from picker
    await act(async () => {
      capturedOpenColumnFilter?.('name', { x: 100, y: 50, width: 120, height: 32 })
    })

    // Should show the filter popover with values loaded
    await waitFor(() => screen.getByRole('list', { name: /filter values/i }))
    expect(screen.getByRole('checkbox', { name: 'Alice' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Bob' })).toBeInTheDocument()
  })

  it('PICKER_RACE_DATASET_SWITCH: picker-origin open + dataset switch discards stale async values', async () => {
    const datasetB = {
      id: 'filter-test-dataset-B',
      name: 'filter-test-B',
      rowCount: 2,
      dataRowCount: 2,
      columns: [{ id: 'name', name: 'Name', type: 'text' }],
    }

    let resolveA!: (v: Record<string, unknown[]>) => void
    const deferredA = new Promise<Record<string, unknown[]>>((resolve) => { resolveA = resolve })
    cacheHarness.getColumnsData.mockReturnValueOnce(deferredA)

    const { rerender } = render(
      <SpreadsheetView
        enableExcelViewFilter
        onColumnFilterRequest={(openFn) => { capturedOpenColumnFilter = openFn }}
      />
    )
    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())

    // The callback must have been captured — prop must exist on SpreadsheetView
    expect(capturedOpenColumnFilter).not.toBeNull()

    // Open column filter from picker — deferred fetch starts
    act(() => {
      capturedOpenColumnFilter!('name', { x: 100, y: 50, width: 120, height: 32 })
    })

    // Switch to dataset B
    dataStoreHarness.state.currentDataset = datasetB
    dataStoreHarness.useDataStore.mockReturnValue({ ...dataStoreHarness.state })
    await act(async () => {
      rerender(
        <SpreadsheetView
          enableExcelViewFilter
          onColumnFilterRequest={(openFn) => { capturedOpenColumnFilter = openFn }}
        />
      )
    })

    // Resolve dataset A's deferred fetch
    await act(async () => { resolveA({ name: ['STALE_FROM_PICKER'] }) })
    await act(async () => {})

    // Stale result must NOT appear
    expect(screen.queryByRole('checkbox', { name: 'STALE_FROM_PICKER' })).not.toBeInTheDocument()

    // Restore dataset A for cleanup
    dataStoreHarness.state.currentDataset = dataStoreHarness.dataset
    dataStoreHarness.useDataStore.mockReturnValue({ ...dataStoreHarness.state })
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — Advanced Filter dialog pre-scoped to column
// ---------------------------------------------------------------------------

describe('SpreadsheetView — advanced filter dialog pre-scope', () => {
  beforeEach(() => {
    gridHarness.latestProps = null
    dialogHarness.openCalls = 0
    dialogHarness.lastOnApply = null
    dialogHarness.lastInitialConfig = undefined
    cacheHarness.getColumnsData.mockResolvedValue({ name: ['Alice', 'Bob'] })
    snapshotHarness.buildFullRowsByIndex.mockResolvedValue(
      new Map<number, Record<string, unknown>>([
        [0, { name: 'Alice' }],
        [1, { name: 'Bob' }],
      ])
    )
  })

  it('ADVANCED_DIALOG_PRESCOPED_NULL: "Open Advanced Filter…" with no active filter passes null initialConfig', async () => {
    // No viewFilterConfig active
    render(<SpreadsheetView enableExcelViewFilter />)
    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())

    await act(async () => {
      gridHarness.latestProps.onHeaderMenuClick?.(0, { x: 0, y: 0, width: 100, height: 32 })
    })
    await waitFor(() => screen.getByRole('list', { name: /filter values/i }))

    await act(async () => {
      screen.getByRole('button', { name: /open advanced filter/i }).click()
    })

    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))

    // No active filter → scoped config should be null
    expect(dialogHarness.lastInitialConfig).toBeNull()
  })

  it('ADVANCED_DIALOG_PRESCOPED: "Open Advanced Filter…" passes initialConfig scoped to active column only', async () => {
    let capturedOpen: (() => void) | null = null
    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
      />
    )
    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())

    // First apply a filter for 'name' AND another column that the dataset has
    // We only have 'name' column in the test dataset — apply it via dialog
    await act(async () => { capturedOpen?.() })
    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))
    // Dialog apply sets filter: name eq Alice
    await act(async () => { screen.getByTestId('mock-dialog-apply').click() })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /filter/i })).not.toBeInTheDocument())

    // Now open header popover for 'name' column
    await act(async () => {
      gridHarness.latestProps.onHeaderMenuClick?.(0, { x: 0, y: 0, width: 100, height: 32 })
    })
    await waitFor(() => screen.getByRole('list', { name: /filter values/i }))

    dialogHarness.lastInitialConfig = undefined  // reset to detect change
    // Click "Open Advanced Filter…" — should pass scoped config (only 'name' conditions)
    await act(async () => {
      screen.getByRole('button', { name: /open advanced filter/i }).click()
    })

    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))

    // initialConfig must contain ONLY conditions for the 'name' column
    expect(dialogHarness.lastInitialConfig).not.toBeUndefined()
    expect(dialogHarness.lastInitialConfig).not.toBeNull()
    const allConditions = dialogHarness.lastInitialConfig!.groups.flatMap((g: any) => g.conditions)
    expect(allConditions.length).toBeGreaterThan(0)
    // Every condition must reference the 'name' column
    expect(allConditions.every((c: any) => c.columnId === 'name')).toBe(true)
  })

  it('ADVANCED_DIALOG_PRESCOPED_MERGE: applying scoped dialog does not wipe other columns\' conditions', async () => {
    // This test requires at least 2 columns. We only have 'name' in the test dataset,
    // so we test the merge contract via the captured onApply callback directly.
    // The key invariant: when filterDialogScopeColId is set and the dialog returns a config,
    // the parent viewFilterConfig must be MERGED (not replaced) for the scoped column only.

    let capturedOpen: (() => void) | null = null
    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
      />
    )
    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())

    // Apply a filter via toolbar dialog to establish initial viewFilterConfig
    await act(async () => { capturedOpen?.() })
    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))
    // Dialog mock applies: name eq Alice
    await act(async () => { screen.getByTestId('mock-dialog-apply').click() })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /filter/i })).not.toBeInTheDocument())

    // Now open the header popover for 'name' column and escalate to Advanced Filter
    await act(async () => {
      gridHarness.latestProps.onHeaderMenuClick?.(0, { x: 0, y: 0, width: 100, height: 32 })
    })
    await waitFor(() => screen.getByRole('list', { name: /filter values/i }))

    dialogHarness.lastOnApply = null
    await act(async () => {
      screen.getByRole('button', { name: /open advanced filter/i }).click()
    })
    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))
    expect(dialogHarness.lastOnApply).not.toBeNull()

    // Simulate the dialog returning a new scoped config (only 'name' column)
    const scopedResult: FilterConfig = {
      groups: [{ op: 'AND', conditions: [{ columnId: 'name', operator: 'ne', value: 'Bob' }] }],
      groupOperator: 'AND',
    }
    await act(async () => {
      dialogHarness.lastOnApply!(scopedResult)
    })

    // Dialog must close
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /filter/i })).not.toBeInTheDocument())

    // Column indicator must still be present (filter was applied, not wiped)
    await waitFor(() => {
      const cols: Array<{ title?: string }> = gridHarness.latestProps?.columns ?? []
      expect(cols.some((c: { title?: string }) => c.title?.includes('▾'))).toBe(true)
    })
  })

  it('GUARD_INVALID_COLID: openColumnFilter with unknown colId does not open popover', async () => {
    let capturedOpenColumnFilter: ((colId: string, bounds: { x: number; y: number; width: number; height: number }) => void) | null = null
    render(
      <SpreadsheetView
        enableExcelViewFilter
        onColumnFilterRequest={(openFn) => { capturedOpenColumnFilter = openFn }}
      />
    )
    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    expect(capturedOpenColumnFilter).not.toBeNull()

    // Call with an unknown colId not present in the dataset
    act(() => {
      capturedOpenColumnFilter!('col-does-not-exist', { x: 0, y: 0, width: 100, height: 32 })
    })

    // Give time for any async side effects
    await act(async () => {})

    // Popover must NOT open — no filter values list, no loading indicator
    expect(screen.queryByRole('list', { name: /filter values/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — Cross-flow guardrail tests
// ---------------------------------------------------------------------------

describe('SpreadsheetView — cross-flow guardrails', () => {
  let capturedOpen: (() => void) | null = null

  beforeEach(() => {
    capturedOpen = null
    gridHarness.latestProps = null
    dialogHarness.openCalls = 0
    dialogHarness.lastOnApply = null
    snapshotHarness.buildFullRowsByIndex.mockResolvedValue(
      new Map<number, Record<string, unknown>>([
        [0, { name: 'Alice' }],
        [1, { name: 'Bob' }],
        [2, { name: 'Alice' }],
      ])
    )
  })

  it('GUARD_VIEW_NO_MUTATE: view filter dialog apply updates column header indicator (view path) and leaves dataset row count unchanged', async () => {
    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    const initialRows = gridHarness.latestProps.rows

    // Apply via view dialog — NOT through transform pipeline
    await act(async () => { capturedOpen?.() })
    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))
    await act(async () => { screen.getByTestId('mock-dialog-apply').click() })

    // Column title indicator proves viewFilterConfig was set (view path)
    await waitFor(() => {
      const cols: Array<{ title?: string }> = gridHarness.latestProps?.columns ?? []
      expect(cols.some((c: { title?: string }) => c.title?.includes('▾'))).toBe(true)
    })

    // Dataset.rowCount must be unchanged — view filter does not mutate the dataset
    expect(dataStoreHarness.dataset.rowCount).toBe(initialRows === 3 ? 3 : initialRows)
    expect(dataStoreHarness.state.updateDataset).not.toHaveBeenCalled()
  })

  it('GUARD_WIRING_ISOLATED: AdvancedFilterDialog in view mode closes dialog after apply (view path, not transform)', async () => {
    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
      />
    )

    await act(async () => { capturedOpen?.() })
    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))

    // Apply — the mock dialog fires onApply with a FilterConfig
    await act(async () => { screen.getByTestId('mock-dialog-apply').click() })

    // Dialog should close — proving the view-mode onApply wiring works
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /filter/i })).not.toBeInTheDocument()
    })

    // Column indicator should show ▾ — proving viewFilterConfig was set (not transform pipeline)
    await waitFor(() => {
      const cols: Array<{ title?: string }> = gridHarness.latestProps?.columns ?? []
      expect(cols.some((c: { title?: string }) => c.title?.includes('▾'))).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// View-filter dialog data parity (Phase 5)
// onBeforeViewFilterDialogOpen — prepared columnMetadata + data reach the dialog
// ---------------------------------------------------------------------------

describe('SpreadsheetView — view filter dialog data parity', () => {
  let capturedOpen: (() => void) | null = null

  beforeEach(() => {
    capturedOpen = null
    dialogHarness.lastData = undefined
    dialogHarness.lastColumns = undefined
    dialogHarness.openCalls = 0
  })

  const PREPARED_COLS = [{ id: 'col-a', name: 'Treatment', type: 'text' as const }]
  const PREPARED_DATA = [{ 'col-a': 'THC' }, { 'col-a': 'vehicle' }]

  it('BEFORE_OPEN_CALLBACK_AWAITED: onBeforeViewFilterDialogOpen is called before dialog mounts', async () => {
    const onBefore = vi.fn().mockResolvedValue({ kind: 'ready' as const, columns: PREPARED_COLS, data: PREPARED_DATA })

    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
        onBeforeViewFilterDialogOpen={onBefore}
      />
    )

    await act(async () => { capturedOpen?.() })

    await waitFor(() => expect(screen.getByRole('dialog', { name: /filter/i })).toBeInTheDocument())
    expect(onBefore).toHaveBeenCalledOnce()
  })

  it('BEFORE_OPEN_DATA_PASSED: prepared data from callback is passed as data prop to dialog', async () => {
    const onBefore = vi.fn().mockResolvedValue({ kind: 'ready' as const, columns: PREPARED_COLS, data: PREPARED_DATA })

    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
        onBeforeViewFilterDialogOpen={onBefore}
      />
    )

    await act(async () => { capturedOpen?.() })
    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))

    expect(dialogHarness.lastData).toEqual(PREPARED_DATA)
  })

  it('BEFORE_OPEN_COLUMNS_PASSED: filtered columns from callback replace raw dataset columns in dialog', async () => {
    const onBefore = vi.fn().mockResolvedValue({ kind: 'ready' as const, columns: PREPARED_COLS, data: [] })

    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
        onBeforeViewFilterDialogOpen={onBefore}
      />
    )

    await act(async () => { capturedOpen?.() })
    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))

    expect(dialogHarness.lastColumns).toEqual(PREPARED_COLS)
  })

  it('BEFORE_OPEN_DOUBLE_CLICK_IGNORED: second openViewFilterDialog call while first is in-flight is a no-op', async () => {
    let resolveFirst!: (v: { kind: 'ready'; columns: typeof PREPARED_COLS; data: typeof PREPARED_DATA }) => void
    const onBefore = vi.fn().mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = res })
    )

    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
        onBeforeViewFilterDialogOpen={onBefore}
      />
    )

    // First click — starts in-flight preload
    act(() => { capturedOpen?.() })
    // Second click immediately — must be ignored (callback not called twice)
    act(() => { capturedOpen?.() })

    // Resolve the first
    await act(async () => { resolveFirst({ kind: 'ready', columns: PREPARED_COLS, data: PREPARED_DATA }) })

    await waitFor(() => screen.getByRole('dialog', { name: /filter/i }))
    // Callback fired exactly once despite two clicks
    expect(onBefore).toHaveBeenCalledTimes(1)
  })

  it('BEFORE_OPEN_DATASET_SWITCH_ABORTS: dialog does not open if dataset changes while callback is in-flight', async () => {
    let resolvePrep!: (v: { kind: 'ready'; columns: typeof PREPARED_COLS; data: typeof PREPARED_DATA }) => void
    const onBefore = vi.fn().mockImplementation(
      () => new Promise((res) => { resolvePrep = res })
    )

    const { rerender } = render(
      <SpreadsheetView
        datasetId="filter-test-dataset"
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
        onBeforeViewFilterDialogOpen={onBefore}
      />
    )

    // Start preload
    act(() => { capturedOpen?.() })

    // Switch dataset before preload resolves
    dataStoreHarness.dataset.id = 'filter-test-dataset-SWITCHED'
    await act(async () => {
      rerender(
        <SpreadsheetView
          datasetId="filter-test-dataset-SWITCHED"
          enableExcelViewFilter
          onFilterDialogRequest={(open) => { capturedOpen = open }}
          onBeforeViewFilterDialogOpen={onBefore}
        />
      )
    })

    // Resolve the stale preload
    await act(async () => { resolvePrep({ kind: 'ready', columns: PREPARED_COLS, data: PREPARED_DATA }) })

    // Dialog must NOT open — stale data discarded
    expect(screen.queryByRole('dialog', { name: /filter/i })).not.toBeInTheDocument()

    // Restore dataset id
    dataStoreHarness.dataset.id = 'filter-test-dataset'
  })

  it('BEFORE_OPEN_FALLBACK_KIND: kind:fallback opens dialog with raw dataset columns and no data', async () => {
    const onBefore = vi.fn().mockResolvedValue({ kind: 'fallback' as const })

    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
        onBeforeViewFilterDialogOpen={onBefore}
      />
    )

    await act(async () => { capturedOpen?.() })

    await waitFor(() => expect(screen.getByRole('dialog', { name: /filter/i })).toBeInTheDocument())
    // Dialog must open with raw dataset columns (fallback, not prepared)
    expect(dialogHarness.lastColumns).toEqual(dataStoreHarness.dataset.columns)
    expect(dialogHarness.lastData).toEqual([])
  })

  it('BEFORE_OPEN_ABORT_KIND: kind:abort prevents dialog from opening', async () => {
    const onBefore = vi.fn().mockResolvedValue({ kind: 'abort' as const })

    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
        onBeforeViewFilterDialogOpen={onBefore}
      />
    )

    await act(async () => { capturedOpen?.() })
    await act(async () => {})

    expect(screen.queryByRole('dialog', { name: /filter/i })).not.toBeInTheDocument()
  })

  it('BEFORE_OPEN_THROW_FALLBACK: callback that throws still opens dialog with raw defaults (no unhandled rejection)', async () => {
    const onBefore = vi.fn().mockRejectedValue(new Error('network failure'))

    render(
      <SpreadsheetView
        enableExcelViewFilter
        onFilterDialogRequest={(open) => { capturedOpen = open }}
        onBeforeViewFilterDialogOpen={onBefore}
      />
    )

    await act(async () => { capturedOpen?.() })

    // Must not crash — fallback to dataset defaults
    await waitFor(() => expect(screen.getByRole('dialog', { name: /filter/i })).toBeInTheDocument())
    expect(dialogHarness.lastColumns).toEqual(dataStoreHarness.dataset.columns)
    expect(dialogHarness.lastData).toEqual([])
  })
})
