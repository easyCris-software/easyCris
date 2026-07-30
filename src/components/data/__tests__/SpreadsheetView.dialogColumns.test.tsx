/**
 * SpreadsheetView — Sort + Outline dialog column filtering (mounted tests).
 *
 * Verifies:
 * 1. Sort dialog shows only columns with data (nonNullCount > 0).
 * 2. Outline dialog shows all real columns so users can outline empty columns too.
 * 3. Active sort column stays visible even when nonNullCount = 0 (force-include).
 * 4. Outline dialog keeps showing all real columns after a group is active.
 * 5. Concurrent opens are safe: dialog renders once, columns are consistent (race guard smoke).
 *    Note: a true stale-response-wins test (first open delayed, second fast) requires
 *    orchestrating microtask ordering that is not reliably possible in JSDOM. The race
 *    guard correctness (requestId + datasetId checks) is verified at the code level.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import SpreadsheetView from '../SpreadsheetView'
import * as cacheServiceModule from '@/services/cacheService'
import * as viewStateCacheModule from '@/lib/grid/viewStateCache'
import { computeSchemaKey } from '@/lib/grid/viewStateSchema'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const harness = vi.hoisted(() => ({
  latestDataEditorProps: null as any,
  executeEdits: vi.fn().mockResolvedValue(undefined),
  executeSingleEdit: vi.fn().mockResolvedValue(undefined),
}))

const dataStoreHarness = vi.hoisted(() => {
  const dataset = {
    id: 'dataset-1',
    name: 'dataset-1',
    rowCount: 3,
    dataRowCount: 3,
    columns: [
      { id: 'col-0', name: 'Column 1', type: 'numeric' },
      { id: 'col-1', name: 'Column 2', type: 'categorical' },
      { id: 'col-2', name: 'Column 3', type: 'text' },
    ],
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
    insertRowsAtDataset: vi.fn().mockResolvedValue(0),
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
  return { dataset, dataStoreState, dataStoreGetState, useDataStore }
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
  return { appStoreState, useAppStore }
})

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )
  const MockDataEditor = React.forwardRef((props: any, _ref: React.ForwardedRef<any>) => {
    harness.latestDataEditorProps = props
    return <div />
  })
  MockDataEditor.displayName = 'MockDataEditor'
  return { ...actual, DataEditor: MockDataEditor }
})

vi.mock('@/lib/grid/viewStateCache', () => ({
  getViewStateCache: vi.fn(() => undefined),
  setViewStateCache: vi.fn(),
  clearViewStateCacheForKey: vi.fn(),
}))

// OutlineDialog uses Radix Select which doesn't render options in JSDOM.
// Mock it to render a simple list + apply buttons so tests can assert which
// columns are shown and trigger the onApply callback to set groupByColumnId.
vi.mock('@/components/dialogs/OutlineDialog', () => ({
  OutlineDialog: ({ open, columnMetadata, onApply }: any) => {
    if (!open) return null
    return (
      <div data-testid="outline-dialog">
        {(columnMetadata ?? []).map((col: any) => (
          <span key={col.id} data-testid={`outline-col-${col.id}`}>{col.name}</span>
        ))}
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

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))
vi.mock('@/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn().mockResolvedValue(true) }))
vi.mock('@/services/tauriApi', () => ({
  tauriApi: { loadDataRows: vi.fn().mockResolvedValue([]), evaluateFormulaRange: vi.fn() },
}))
vi.mock('@/services/cacheService', () => ({
  default: {
    getDatasetStorageInfo: vi.fn().mockResolvedValue(null),
    getRowsHybrid: vi.fn().mockResolvedValue([]),
    ensureLatestCache: vi.fn().mockResolvedValue(undefined),
    getColumnData: vi.fn().mockResolvedValue([]),
    getAllColumnStats: vi.fn().mockResolvedValue([]),
    getPersistedColumnIds: vi.fn().mockResolvedValue(['col-0', 'col-1', 'col-2']),
    getGridMutationQueueState: vi.fn().mockReturnValue({ status: 'idle', failedQueueId: null, error: null }),
    subscribeGridMutationQueue: vi.fn((_datasetId: string, listener: (state: any) => void) => {
      listener({ status: 'idle', failedQueueId: null, error: null })
      return () => {}
    }),
    retryGridMutationQueue: vi.fn().mockResolvedValue(undefined),
  },
}))
vi.mock('@/lib/grid/editExecutor', () => ({
  createEditExecutor: vi.fn(() => ({
    execute: harness.executeEdits,
    executeSingle: harness.executeSingleEdit,
  })),
}))
vi.mock('@/store/data-store', () => ({ useDataStore: dataStoreHarness.useDataStore }))
vi.mock('@/store/app-store', () => ({
  useAppStore: appStoreHarness.useAppStore,
  ensureProjectId: vi.fn().mockResolvedValue('project-1'),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stat(columnId: string, nonNullCount: number) {
  return { columnId, nonNullCount, totalRows: 10, distinctCount: nonNullCount, numericCount: 0 }
}

/** Mount and wait for DataEditor to receive its first props. */
async function mountAndCapture(
  onSortDialogRequest: (open: () => void) => void,
  onGroupDialogRequest: (open: () => void) => void
) {
  render(
    <SpreadsheetView
      onSortDialogRequest={onSortDialogRequest}
      onGroupDialogRequest={onGroupDialogRequest}
    />
  )
  await waitFor(() => expect(harness.latestDataEditorProps).not.toBeNull())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpreadsheetView Sort/Outline dialog column filtering', () => {
  beforeEach(() => {
    harness.latestDataEditorProps = null
    vi.mocked(cacheServiceModule.default.getAllColumnStats).mockReset()
    vi.mocked(cacheServiceModule.default.ensureLatestCache).mockResolvedValue(undefined)
    vi.mocked(viewStateCacheModule.getViewStateCache).mockReset().mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('sort dialog shows only columns with data (nonNullCount > 0)', async () => {
    let openSort!: () => void
    vi.mocked(cacheServiceModule.default.getAllColumnStats).mockResolvedValue([
      stat('col-0', 5),  // has data
      stat('col-1', 0),  // empty
      stat('col-2', 3),  // has data
    ])

    await mountAndCapture(
      (open) => { openSort = open },
      () => {}
    )

    await act(async () => { await openSort() })

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Sort by column' }), {
      key: 'ArrowDown',
    })

    // col-0 and col-2 options should appear; col-1 should not
    expect(screen.getByRole('option', { name: /Column 1/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Column 2/ })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Column 3/ })).toBeInTheDocument()
  })

  it('outline dialog shows all columns', async () => {
    let openOutline!: () => void
    vi.mocked(cacheServiceModule.default.getAllColumnStats).mockResolvedValue([
      stat('col-0', 0),  // empty
      stat('col-1', 7),  // has data
      stat('col-2', 0),  // empty
    ])

    await mountAndCapture(
      () => {},
      (open) => { openOutline = open }
    )

    await act(async () => { await openOutline() })

    await waitFor(() => expect(screen.getByTestId('outline-dialog')).toBeInTheDocument())

    expect(screen.getByTestId('outline-col-col-0')).toBeInTheDocument()
    expect(screen.getByTestId('outline-col-col-1')).toBeInTheDocument()
    expect(screen.getByTestId('outline-col-col-2')).toBeInTheDocument()
  })

  it('active sort column stays visible when its nonNullCount = 0 (force-include)', async () => {
    // col-1 is the active sort column but has no data — must still appear
    vi.mocked(cacheServiceModule.default.getAllColumnStats).mockResolvedValue([
      stat('col-0', 3),
      stat('col-1', 0),  // empty but will be force-included as active sort
      stat('col-2', 0),
    ])

    const schemaKey = computeSchemaKey(dataStoreHarness.dataset.columns.map((column: { id: string }) => column.id))
    vi.mocked(viewStateCacheModule.getViewStateCache).mockReturnValue({
      datasetId: 'dataset-1',
      schemaKey,
      sortModel: [{ colId: 'col-1', dir: 'asc' }],
      groupByColumnId: null,
      collapsedGroupKeys: [],
      gridSelection: null,
      activeCell: null,
      scroll: null,
    })

    let openSort!: () => void
    await mountAndCapture(
      (open) => { openSort = open },
      () => {}
    )

    // Open sort dialog — col-1 must appear even though nonNullCount = 0
    await act(async () => { await openSort() })

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Sort by column' }), {
      key: 'ArrowDown',
    })

    expect(screen.getByRole('option', { name: /Column 2/ })).toBeInTheDocument()
  })

  it('outline dialog continues to show all columns after a group is active', async () => {
    let openOutline!: () => void
    await mountAndCapture(
      () => {},
      (open) => { openOutline = open }
    )

    // Step 1: Open outline with full stats so all columns appear
    vi.mocked(cacheServiceModule.default.getAllColumnStats).mockResolvedValue([
      stat('col-0', 4), stat('col-1', 2), stat('col-2', 3),
    ])
    await act(async () => { await openOutline() })
    await waitFor(() => expect(screen.getByTestId('outline-dialog')).toBeInTheDocument())

    // Step 2: Apply col-2 as active group — fires SpreadsheetView's setGroupByColumnId
    await act(async () => {
      fireEvent.click(screen.getByTestId('outline-apply-col-2'))
    })
    // Let groupByColumnIdRef sync via useEffect
    await act(async () => { for (let i = 0; i < 3; i++) await Promise.resolve() })

    // Step 3: Re-open with stats where col-2 is empty; outline still shows the full schema.
    vi.mocked(cacheServiceModule.default.getAllColumnStats).mockResolvedValue([
      stat('col-0', 4),
      stat('col-1', 0),
      stat('col-2', 0),
    ])
    await act(async () => { await openOutline() })

    await waitFor(() => {
      expect(screen.getByTestId('outline-col-col-2')).toBeInTheDocument()
    })
    expect(screen.getByTestId('outline-col-col-0')).toBeInTheDocument()
    expect(screen.getByTestId('outline-col-col-1')).toBeInTheDocument()
    expect(screen.getByTestId('outline-col-col-2')).toBeInTheDocument()
  })

  it('calling openSort() twice concurrently renders dialog once without errors (race guard smoke)', async () => {
    // Two concurrent opens should resolve cleanly: no duplicate dialogs, no errors,
    // columns shown correctly. The request-ID race guard ensures only one commit wins.
    vi.mocked(cacheServiceModule.default.getAllColumnStats).mockResolvedValue([
      stat('col-0', 5), stat('col-1', 0), stat('col-2', 3),
    ])

    let openSort!: () => void
    await mountAndCapture(
      (open) => { openSort = open },
      () => {}
    )

    await act(async () => {
      await Promise.all([openSort(), openSort()])
    })

    // Dialog renders exactly once
    expect(screen.getAllByRole('heading', { name: /Sort Data/ })).toHaveLength(1)
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Sort by column' }), {
      key: 'ArrowDown',
    })
    // Only data-bearing columns appear (col-0 and col-2)
    expect(screen.getByRole('option', { name: /Column 1/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Column 2/ })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Column 3/ })).toBeInTheDocument()
  })
})
