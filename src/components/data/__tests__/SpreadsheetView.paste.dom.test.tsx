/**
 * SpreadsheetView.paste.dom.test.tsx
 *
 * Integration tests for paste-handler wiring in SpreadsheetView.
 * These complement the unit tests in pastePreflight.test.ts, which cover
 * pure logic. Tests here verify that the component correctly wires the
 * guards and pure helpers into real async paste flows.
 *
 * Tests:
 *   STALE_GUARD   - dataset switch mid-paste: execute never fires after stale check
 *   SORT_BLOCK    - transform active + row overflow: early return + warning toast (no execute)
 *   ALLOC_FAIL    - col allocation failure: rollbackAutoColumnNameAllocation called, no execute
 */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import SpreadsheetView, { resetSpreadsheetViewSharedOverlayStateForTests } from '../SpreadsheetView'
import { CompactSelection } from '@glideapps/glide-data-grid'
import type { GridSelection } from '@glideapps/glide-data-grid'
import type { GridMutationQueueState } from '@/lib/grid/types'
import type {
  BuildPasteEditsInChunksInput,
  BuildPasteEditsInChunksResult,
} from '@/lib/grid/pasteEditBuilder'
import * as viewStateCacheModule from '@/lib/grid/viewStateCache'
import { computeSchemaKey } from '@/lib/grid/viewStateSchema'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSelection(x: number, y: number): GridSelection {
  return {
    current: {
      cell: [x, y] as [number, number],
      range: { x, y, width: 1, height: 1 },
      rangeStack: [],
    },
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  }
}

function makeRangeSelection(x: number, y: number, width: number, height: number): GridSelection {
  return {
    current: {
      cell: [x, y] as [number, number],
      range: { x, y, width, height },
      rangeStack: [],
    },
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  }
}

function makeColumnHeaderSelection(start: number, endExclusive = start + 1): GridSelection {
  return {
    current: undefined,
    columns: CompactSelection.fromSingleSelection([start, endExclusive]),
    rows: CompactSelection.empty(),
  }
}

// ---------------------------------------------------------------------------
// Grid harness — captures DataEditor props and exposes trigger helpers
// ---------------------------------------------------------------------------

const gridHarness = vi.hoisted(() => ({
  latestProps: null as any,
}))

const debugHarness = vi.hoisted(() => ({
  logRuntimeDebug: vi.fn(),
}))

const pasteEditBuilderHarness = vi.hoisted(() => ({
  buildPasteEditsInChunks: null as null | ((input: any) => Promise<any>),
}))

const formulaServiceHarness = vi.hoisted(() => ({
  dependentColumns: new Set<string>(),
}))

const keyboardHarness = vi.hoisted(() => ({
  handlers: null as any,
}))

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )
  const MockDataEditor = React.forwardRef((props: any, _ref: React.ForwardedRef<any>) => {
    gridHarness.latestProps = props
    return (
      <div>
        <button
          data-testid="select-cell"
          onClick={() => props.onGridSelectionChange?.(makeSelection(0, 0))}
        />
        <button
          data-testid="click-col-header"
          onClick={() =>
            props.onHeaderClicked?.(0, {
              kind: 'header',
              isDoubleClick: false,
              isEdge: false,
              preventDefault: vi.fn(),
            })
          }
        />
      </div>
    )
  })
  MockDataEditor.displayName = 'MockDataEditor'
  return { ...actual, DataEditor: MockDataEditor }
})

vi.mock('@/lib/debug/runtimeDebug', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/debug/runtimeDebug')>()
  return {
    ...actual,
    logRuntimeDebug: debugHarness.logRuntimeDebug,
  }
})

// ---------------------------------------------------------------------------
// Clipboard mock — controlled per-test via clipboardHarness
// ---------------------------------------------------------------------------

const clipboardHarness = vi.hoisted(() => ({
  read: vi.fn<() => Promise<string>>(),
  write: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/grid/clipboard', () => ({
  clipboard: { read: clipboardHarness.read, write: clipboardHarness.write },
  parseClipboardText: (text: string): string[][] =>
    text.split('\n').map(row => row.split('\t')),
}))

vi.mock('@/lib/grid/pasteEditBuilder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/grid/pasteEditBuilder')>()
  return {
    ...actual,
    buildPasteEditsInChunks: (input: any) => {
      return pasteEditBuilderHarness.buildPasteEditsInChunks
        ? pasteEditBuilderHarness.buildPasteEditsInChunks(input)
        : actual.buildPasteEditsInChunks(input)
    },
  }
})

vi.mock('@/lib/grid/formulas/formulaService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/grid/formulas/formulaService')>()
  return {
    ...actual,
    createFormulaService: (...args: Parameters<typeof actual.createFormulaService>) => {
      const service = actual.createFormulaService(...args)
      const originalGetDependentsForColumns = service.getDependentsForColumns.bind(service)
      service.getDependentsForColumns = (columnIds: string[]) => {
        const injectedDependents = columnIds
          .filter((columnId) => formulaServiceHarness.dependentColumns.has(columnId))
          .map((columnId) => `formula-dependent:${columnId}`)
        return injectedDependents.length > 0
          ? injectedDependents
          : originalGetDependentsForColumns(columnIds)
      }
      return service
    },
  }
})

// ---------------------------------------------------------------------------
// cacheService mock
// ---------------------------------------------------------------------------

const cacheHarness = vi.hoisted(() => ({
  // Return a minimal storageInfo so SpreadsheetView sets up its backend context without warnings.
  getDatasetStorageInfo: vi.fn().mockResolvedValue({ isLarge: false }),
  getRowsHybrid: vi.fn().mockResolvedValue([]),
  getRowsHybridColumns: vi.fn().mockResolvedValue([]),
  ensureLatestCache: vi.fn().mockResolvedValue(undefined),
  ensureDuckDbDataset: vi.fn().mockResolvedValue(null),
  getAllColumnStats: vi.fn().mockResolvedValue([]),
  getPersistedColumnIds: vi.fn().mockResolvedValue([]),
  getColumnData: vi.fn().mockResolvedValue([10, 20, 30]),
  getSortedRowIndices: vi.fn().mockResolvedValue([]),
  getColumnsData: vi.fn().mockResolvedValue({}),
  queueCellUpdate: vi.fn(),
  updateCellsBatch: vi.fn().mockResolvedValue(0),
  applyPasteBlock: vi.fn().mockResolvedValue({
    rowStart: 0,
    rowEndExclusive: 0,
    editedCells: 0,
    oldValues: [],
  }),
  addColumn: vi.fn().mockResolvedValue(undefined),
  removeColumn: vi.fn().mockResolvedValue(undefined),
  removeRowAt: vi.fn().mockResolvedValue(undefined),
  flushPendingUpdates: vi.fn().mockResolvedValue(undefined),
  flushOverlay: vi.fn().mockResolvedValue(undefined),
  // Row-capacity expansion: getRowCount + insertRowAt must be called before overlay writes
  getRowCount: vi.fn().mockResolvedValue(3), // matches ds1.rowCount default
  insertRowAt: vi.fn().mockResolvedValue(1),
  insertRowsAt: vi.fn().mockResolvedValue(999),
  appendRows: vi.fn().mockResolvedValue(999),
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
  enqueueGridMutationBatch: vi.fn().mockResolvedValue({ accepted: true, queueId: 'retry-queue' }),
  flushGridMutationQueue: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/services/cacheService', () => ({
  cacheService: cacheHarness,
  default: cacheHarness,
}))

// ---------------------------------------------------------------------------
// Toast mock
// ---------------------------------------------------------------------------

const toastHarness = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: toastHarness }))

// ---------------------------------------------------------------------------
// editExecutor mock
// ---------------------------------------------------------------------------

const executorHarness = vi.hoisted(() => ({
  execute: vi.fn().mockResolvedValue(undefined),
  executeSingle: vi.fn().mockResolvedValue(undefined),
  applyDataStoreUpdate: vi.fn(),
}))

vi.mock('@/lib/grid/editExecutor', () => ({
  createEditExecutor: vi.fn(() => ({
    execute: executorHarness.execute,
    executeSingle: executorHarness.executeSingle,
    applyDataStoreUpdate: executorHarness.applyDataStoreUpdate,
  })),
}))

const undoHarness = vi.hoisted(() => ({
  pushColumnRename: vi.fn().mockResolvedValue(undefined),
  recordGridTransaction: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// viewStateCache mock — prevents sort state bleeding between tests
// ---------------------------------------------------------------------------

vi.mock('@/lib/grid/viewStateCache', () => ({
  getViewStateCache: vi.fn(() => undefined),
  setViewStateCache: vi.fn(),
  clearViewStateCacheForKey: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Store mocks
// ---------------------------------------------------------------------------

const dataStoreHarness = vi.hoisted(() => {
  const makeDataset = (id: string, rowCount: number, cols: { id: string; name: string }[]) => ({
    id,
    name: id,
    rowCount,
    dataRowCount: rowCount,
    columnCount: cols.length,
    columns: cols.map(c => ({ ...c, type: 'text' as const })),
    importedAt: new Date(),
    modifiedAt: new Date(),
    nextAutoColumnNumber: cols.length + 1,
  })

  const ds1 = makeDataset('ds-1', 3, [
    { id: 'col-0', name: 'Column 1' },
    { id: 'col-1', name: 'Column 2' },
  ])
  const ds2 = makeDataset('ds-2', 5, [
    { id: 'col-a', name: 'A' },
  ])

  const state = {
    currentDataset: ds1 as typeof ds1 | typeof ds2,
    datasets: [ds1, ds2],
    loadingOperation: null,
    setLoadingOperation: vi.fn(),
    setSelectedRows: vi.fn(),
    setSelectedColumns: vi.fn(),
    setSelectionStats: vi.fn(),
    updateViewport: vi.fn(),
    updateCellValue: vi.fn(),
    updateDataset: vi.fn(),
    invalidateColumns: vi.fn(),
    allocateNextAutoColumnName: vi.fn<() => string | null>().mockReturnValue(null),
    rollbackAutoColumnNameAllocation: vi.fn(),
    insertColumnAtDataset: vi.fn(),
    insertRowAtDataset: vi.fn(),
    insertRowsAtDataset: vi.fn(),
    removeColumnAtDataset: vi.fn(),
    removeRowAtDataset: vi.fn(),
    setHighlightsBatch: vi.fn(),
    removeHighlightsBatch: vi.fn(),
  }

  const stateGet = {
    datasets: [ds1, ds2],
    currentDataset: ds1 as typeof ds1 | typeof ds2,
    getDatasetFormulas: vi.fn(() => new Map()),
    setDatasetFormulas: vi.fn(),
    updateDataset: state.updateDataset,
  }

  const useDataStore = vi.fn(() => state)
  ;(useDataStore as any).getState = () => stateGet

  return { ds1, ds2, state, stateGet, useDataStore }
})

const appStoreHarness = vi.hoisted(() => {
  const s = {
    activeFamilyId: 'fam-1',
    projectId: 'proj-1',
    setProjectDirty: vi.fn(),
    updateActiveFamilyData: vi.fn(),
    acquireAppOperationLock: vi.fn(() => 'paste-lock-token'),
    updateAppOperationLock: vi.fn(),
    releaseAppOperationLock: vi.fn(() => true),
  }
  const useAppStore = vi.fn((sel?: any) => (typeof sel === 'function' ? sel(s) : s))
  ;(useAppStore as any).getState = () => s
  return { s, useAppStore }
})

vi.mock('@/store/data-store', () => ({ useDataStore: dataStoreHarness.useDataStore }))
vi.mock('@/store/app-store', () => ({
  useAppStore: appStoreHarness.useAppStore,
  ensureProjectId: vi.fn().mockResolvedValue('proj-1'),
}))

// ---------------------------------------------------------------------------
// Misc mocks
// ---------------------------------------------------------------------------

vi.mock('@/hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: vi.fn((handlers) => {
    keyboardHarness.handlers = handlers
  }),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn().mockResolvedValue(true) }))
const tauriHarness = vi.hoisted(() => ({
  loadDataRows: vi.fn().mockResolvedValue([]),
  evaluateFormulaRange: vi.fn(),
  updateDatasetMetadata: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/services/tauriApi', () => ({
  tauriApi: tauriHarness,
}))

vi.mock('@/services/undoService', () => ({
  undoService: undoHarness,
  default: undoHarness,
}))

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetSpreadsheetViewSharedOverlayStateForTests()
  // Reset store to ds1
  dataStoreHarness.ds1.rowCount = 3
  dataStoreHarness.ds1.dataRowCount = 3
  dataStoreHarness.ds1.columnCount = 2
  dataStoreHarness.ds2.rowCount = 5
  dataStoreHarness.ds2.dataRowCount = 5
  dataStoreHarness.ds2.columnCount = 1
  dataStoreHarness.state.currentDataset = dataStoreHarness.ds1
  dataStoreHarness.state.datasets = [dataStoreHarness.ds1, dataStoreHarness.ds2]
  dataStoreHarness.stateGet.currentDataset = dataStoreHarness.ds1
  dataStoreHarness.stateGet.datasets = [dataStoreHarness.ds1, dataStoreHarness.ds2]
  dataStoreHarness.state.updateDataset.mockReset()
  dataStoreHarness.stateGet.updateDataset.mockReset()
  dataStoreHarness.state.allocateNextAutoColumnName.mockReset().mockReturnValue(null)
  dataStoreHarness.state.rollbackAutoColumnNameAllocation.mockReset()
  dataStoreHarness.state.insertColumnAtDataset.mockReset()

  executorHarness.execute.mockClear()
  executorHarness.executeSingle.mockClear()
  executorHarness.applyDataStoreUpdate.mockClear()
  undoHarness.pushColumnRename.mockClear()
  undoHarness.recordGridTransaction.mockClear()
  delete (undoHarness as any).undoGridTransaction
  delete (undoHarness as any).redoGridTransaction
  delete (undoHarness as any).prepareUndoGridTransaction
  delete (undoHarness as any).rollbackUndoGridTransaction
  delete (undoHarness as any).hasPreparedUndoGridTransaction
  delete (undoHarness as any).prepareRedoGridTransaction
  delete (undoHarness as any).commitRedoGridTransaction
  delete (undoHarness as any).rollbackRedoGridTransaction
  delete (undoHarness as any).hasPreparedRedoGridTransaction
  keyboardHarness.handlers = null
  tauriHarness.updateDatasetMetadata.mockReset().mockResolvedValue(undefined)
  cacheHarness.addColumn.mockClear()
  cacheHarness.removeColumn.mockClear()
  cacheHarness.flushPendingUpdates.mockClear()
  cacheHarness.getDatasetStorageInfo.mockReset().mockResolvedValue({ isLarge: false })
  cacheHarness.getRowsHybrid.mockReset().mockResolvedValue([])
  cacheHarness.getRowsHybridColumns.mockReset().mockResolvedValue([])
  cacheHarness.getSortedRowIndices.mockReset().mockResolvedValue([])
  cacheHarness.getRowCount.mockReset().mockResolvedValue(3) // ds1.rowCount = 3
  cacheHarness.insertRowAt.mockReset().mockResolvedValue(1)
  cacheHarness.insertRowsAt.mockReset().mockResolvedValue(999)
  cacheHarness.appendRows.mockReset().mockResolvedValue(999)
  cacheHarness.queueStates.clear()
  cacheHarness.enqueueGridMutationBatch.mockReset().mockResolvedValue({ accepted: true, queueId: 'retry-queue' })
  cacheHarness.flushGridMutationQueue.mockReset().mockResolvedValue(undefined)
  cacheHarness.applyPasteBlock.mockReset().mockResolvedValue({
    rowStart: 0,
    rowEndExclusive: 0,
    editedCells: 0,
    oldValues: [],
  })

  clipboardHarness.read.mockReset()
  clipboardHarness.write.mockClear()

  toastHarness.info.mockClear()
  toastHarness.warning.mockClear()
  toastHarness.error.mockClear()
  toastHarness.success.mockClear()
  debugHarness.logRuntimeDebug.mockClear()
  pasteEditBuilderHarness.buildPasteEditsInChunks = null
  formulaServiceHarness.dependentColumns.clear()
  appStoreHarness.s.updateActiveFamilyData.mockClear()
  appStoreHarness.s.setProjectDirty.mockClear()
  appStoreHarness.s.acquireAppOperationLock.mockClear()
  appStoreHarness.s.updateAppOperationLock.mockClear()
  appStoreHarness.s.releaseAppOperationLock.mockClear()
  appStoreHarness.s.activeFamilyId = 'fam-1'
  vi.mocked(viewStateCacheModule.getViewStateCache).mockReset().mockReturnValue(undefined)

  gridHarness.latestProps = null
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Helper: mount, wait for DataEditor, set selection, return { rerender, paste }
// ---------------------------------------------------------------------------

async function mountAndCapturePaste(
  props: React.ComponentProps<typeof SpreadsheetView> = {}
): Promise<{
  rerender: (ui: React.ReactElement) => void
  triggerPaste: () => void
}> {
  let capturedPaste: (() => void | Promise<void>) | null = null
  const { rerender } = render(
    <SpreadsheetView
      {...props}
      onPasteRequest={fn => { capturedPaste = fn }}
    />
  )

  // Wait for DataEditor to mount and paste callback to be registered
  await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
  await waitFor(() => expect(capturedPaste).not.toBeNull())

  // Set a cell selection at (0,0) so paste guard passes
  await act(async () => {
    gridHarness.latestProps?.onGridSelectionChange?.(makeSelection(0, 0))
  })

  return {
    rerender: (ui) => rerender(ui),
    triggerPaste: () => { void capturedPaste?.() },
  }
}

// ---------------------------------------------------------------------------
// STALE_GUARD: dataset switch mid-paste
// ---------------------------------------------------------------------------

describe('SpreadsheetView paste — STALE_GUARD', () => {
  it('aborts before execute when active dataset changes while clipboard.read is in flight', async () => {
    // Controlled deferred clipboard
    let resolveClipboard!: (text: string) => void
    clipboardHarness.read.mockReturnValue(
      new Promise<string>(resolve => { resolveClipboard = resolve })
    )

    const { rerender, triggerPaste } = await mountAndCapturePaste()

    // Start paste — captures capturedDatasetId = 'ds-1' and suspends at clipboard.read
    triggerPaste()

    // Switch active dataset to ds-2 while clipboard.read is still pending.
    // Mutate the store mock return value and rerender so the useEffect that
    // writes currentDatasetIdRef.current fires with the new id.
    await act(async () => {
      dataStoreHarness.state.currentDataset = dataStoreHarness.ds2
      dataStoreHarness.stateGet.currentDataset = dataStoreHarness.ds2
      rerender(
        <SpreadsheetView
          onPasteRequest={fn => { /* captured already */ void fn }}
        />
      )
    })

    // Resolve clipboard — paste resumes, guard fires: 'ds-2' !== 'ds-1'
    await act(async () => {
      resolveClipboard('hello\tworld')
      // Flush microtasks so the async paste function runs to its guard check
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })

    expect(executorHarness.execute).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// STORE_COALESCE: paste defers data-store writes until execution completes
// ---------------------------------------------------------------------------

describe('SpreadsheetView paste — STORE_COALESCE', () => {
  it('routes large non-formula paste through compact backend paste block without old edit building', async () => {
    dataStoreHarness.ds1.rowCount = 11000
    dataStoreHarness.ds1.dataRowCount = 11000
    cacheHarness.applyPasteBlock.mockResolvedValue({
      rowStart: 0,
      rowEndExclusive: 10001,
      editedCells: 10001,
      oldValues: Array.from({ length: 10001 }, (_, row) => [`old-${row}`]),
    })
    pasteEditBuilderHarness.buildPasteEditsInChunks = vi.fn(async () => {
      throw new Error('old paste edit builder should not run')
    })
    clipboardHarness.read.mockResolvedValue(
      Array.from({ length: 10001 }, (_, index) => `row-${index}`).join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => expect(cacheHarness.applyPasteBlock).toHaveBeenCalledTimes(1))
    expect(cacheHarness.applyPasteBlock).toHaveBeenCalledWith('ds-1', {
      rows: Array.from({ length: 10001 }, (_, row) => row),
      columnIds: ['col-0'],
      values: Array.from({ length: 10001 }, (_, row) => [`row-${row}`]),
    })
    const [, backendUndoTransaction] = undoHarness.recordGridTransaction.mock.calls.at(-1) ?? []
    expect(backendUndoTransaction).toEqual(expect.objectContaining({
      backendPasteBlock: {
        kind: 'backend-paste-block',
        rows: Array.from({ length: 10001 }, (_, row) => row),
        columnIds: ['col-0'],
        values: Array.from({ length: 10001 }, (_, row) => [`row-${row}`]),
        undoValues: Array.from({ length: 10001 }, (_, row) => [`old-${row}`]),
      },
    }))
    expect(backendUndoTransaction.largePasteUndoPolicy).toBeUndefined()
    expect(backendUndoTransaction.edits).toBeUndefined()
    expect(toastHarness.info).not.toHaveBeenCalledWith(
      'Large paste undo will clear the pasted range instead of restoring previous values.'
    )
    expect(pasteEditBuilderHarness.buildPasteEditsInChunks).not.toHaveBeenCalled()
    expect(executorHarness.execute).not.toHaveBeenCalled()
    expect(appStoreHarness.s.updateAppOperationLock).toHaveBeenCalledWith(
      'paste-lock-token',
      expect.objectContaining({ stage: 'Preparing paste...', progress: 5 })
    )
    expect(appStoreHarness.s.updateAppOperationLock).toHaveBeenCalledWith(
      'paste-lock-token',
      expect.objectContaining({ stage: 'Writing paste...', indeterminate: true })
    )
    expect(appStoreHarness.s.updateAppOperationLock).toHaveBeenCalledWith(
      'paste-lock-token',
      expect.objectContaining({ stage: 'Hydrating rows...', indeterminate: true })
    )
    const backendPasteEvents = debugHarness.logRuntimeDebug.mock.calls
      .filter(([channel, name]) =>
        channel === 'paste' &&
        String(name).startsWith('backend_paste_')
      )
      .map(([, name, payload]) => ({ name, payload }))
    expect(backendPasteEvents.map((event) => event.name)).toEqual([
      'backend_paste_payload_built',
      'backend_paste_write_start',
      'backend_paste_write_done',
      'backend_paste_hydrate_start',
      'backend_paste_hydrate_done',
    ])
    for (const event of backendPasteEvents) {
      expect(event.payload).toEqual(expect.objectContaining({
        datasetId: 'ds-1',
        rowCount: 10001,
        columnCount: 1,
        editedCells: expect.any(Number),
        durationMs: expect.any(Number),
        visibleRange: expect.objectContaining({
          rowStart: expect.any(Number),
          rowEndExclusive: expect.any(Number),
        }),
      }))
    }
  })

  it('does not record direct backend paste undo when returned oldValues shape is invalid', async () => {
    dataStoreHarness.ds1.rowCount = 11000
    dataStoreHarness.ds1.dataRowCount = 11000
    cacheHarness.applyPasteBlock.mockResolvedValue({
      rowStart: 0,
      rowEndExclusive: 10001,
      editedCells: 10001,
      oldValues: [['old-only-one-row']],
    })
    clipboardHarness.read.mockResolvedValue(
      Array.from({ length: 10001 }, (_, index) => `row-${index}`).join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => expect(cacheHarness.applyPasteBlock).toHaveBeenCalledTimes(1))
    expect(undoHarness.recordGridTransaction).not.toHaveBeenCalled()
    expect(toastHarness.error).toHaveBeenCalledWith(
      expect.stringMatching(/backend paste undo/i),
      expect.anything()
    )
  })

  it('keeps formula-dependent large paste on the old recalculating path', async () => {
    dataStoreHarness.ds1.rowCount = 11000
    dataStoreHarness.ds1.dataRowCount = 11000
    formulaServiceHarness.dependentColumns.add('col-0')
    pasteEditBuilderHarness.buildPasteEditsInChunks = vi.fn(async () => ({
      edits: [
        {
          row: 0,
          columnId: 'col-0',
          oldValue: null,
          newValue: 'row-0',
        },
      ],
      aborted: false,
    }))
    clipboardHarness.read.mockResolvedValue(
      Array.from({ length: 10001 }, (_, index) => `row-${index}`).join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => expect(pasteEditBuilderHarness.buildPasteEditsInChunks).toHaveBeenCalled())
    expect(cacheHarness.applyPasteBlock).not.toHaveBeenCalled()
    expect(executorHarness.execute).toHaveBeenCalled()
    await waitFor(() => expect(undoHarness.recordGridTransaction).toHaveBeenCalled())
    const [, undoTransaction] = undoHarness.recordGridTransaction.mock.calls.at(-1) ?? []
    expect(undoTransaction).toEqual(expect.objectContaining({
      kind: 'paste',
      edits: expect.arrayContaining([
        expect.objectContaining({
          row: 0,
          columnId: 'col-0',
        }),
      ]),
    }))
  })

  it('spreads a single pasted value across the selected range before edit building', async () => {
    const buildPasteEdits = vi.fn<
      (input: BuildPasteEditsInChunksInput) => Promise<BuildPasteEditsInChunksResult>
    >(async () => ({
      edits: [],
      aborted: false,
    }))
    pasteEditBuilderHarness.buildPasteEditsInChunks = buildPasteEdits
    clipboardHarness.read.mockResolvedValue('x')

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeRangeSelection(0, 0, 2, 3))
    })
    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => expect(buildPasteEdits).toHaveBeenCalled())
    const firstBuildPasteArgs = buildPasteEdits.mock.calls[0]?.[0]
    expect(firstBuildPasteArgs?.parsedData).toEqual([
      ['x', 'x'],
      ['x', 'x'],
      ['x', 'x'],
    ])
  })

  it('patches materialized rows after backend paste without reloading their neighbor cells', async () => {
    dataStoreHarness.ds1.rowCount = 11000
    dataStoreHarness.ds1.dataRowCount = 11000
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) => {
      if (start >= 0 && end <= 1024) {
        return Array.from({ length: end - start }, (_, offset) => ({
          'col-0': `base-${start + offset}`,
          'col-1': `neighbor-${start + offset}`,
        }))
      }
      return []
    })
    cacheHarness.applyPasteBlock.mockResolvedValue({
      rowStart: 0,
      rowEndExclusive: 10001,
      editedCells: 10001,
      oldValues: Array.from({ length: 10001 }, (_, row) => [`base-${row}`]),
    })
    clipboardHarness.read.mockResolvedValue(
      Array.from({ length: 10001 }, (_, index) => `paste-${index}`).join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 0, 512)
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 512, 1024)
    })
    cacheHarness.getRowsHybrid.mockClear()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => expect(cacheHarness.applyPasteBlock).toHaveBeenCalledTimes(1))
    expect(gridHarness.latestProps?.getCellContent?.([0, 0])).toMatchObject({
      displayData: 'paste-0',
    })
    expect(gridHarness.latestProps?.getCellContent?.([1, 0])).toMatchObject({
      displayData: 'neighbor-0',
    })
    await waitFor(() => {
      expect(gridHarness.latestProps?.highlightRegions).toEqual([
        expect.objectContaining({
          range: { x: 0, y: 0, width: 1, height: 10001 },
        }),
      ])
    })
    expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith(
      'paste',
      'backend_paste_hydrate_start',
      expect.objectContaining({
        dirtyBlockCount: 18,
      })
    )
    expect(cacheHarness.getRowsHybrid).not.toHaveBeenCalledWith('ds-1', 0, 512)
  })

  it('hydrates visible cold backend-paste rows using view-space coordinates under sort', async () => {
    dataStoreHarness.ds1.rowCount = 11000
    dataStoreHarness.ds1.dataRowCount = 11000
    cacheHarness.getDatasetStorageInfo.mockResolvedValue({ isLarge: true })
    cacheHarness.getSortedRowIndices.mockResolvedValue([
      ...Array.from({ length: 10001 }, (_, index) => 8000 + index),
      ...Array.from({ length: 999 }, (_, index) => index),
    ])
    cacheHarness.getRowsHybrid.mockResolvedValue([])
    cacheHarness.applyPasteBlock.mockResolvedValue({
      rowStart: 8000,
      rowEndExclusive: 18001,
      editedCells: 10001,
      oldValues: Array.from({ length: 10001 }, () => ['old']),
    })
    clipboardHarness.read.mockResolvedValue(
      Array.from({ length: 10001 }, (_, index) => `paste-${index}`).join('\n')
    )

    const schemaKey = computeSchemaKey(dataStoreHarness.ds1.columns.map((column) => column.id))
    vi.mocked(viewStateCacheModule.getViewStateCache).mockReturnValue({
      datasetId: 'ds-1',
      schemaKey,
      sortModel: [{ colId: 'col-1', dir: 'desc' }],
      groupByColumnId: null,
      collapsedGroupKeys: [],
      gridSelection: makeSelection(0, 0),
      activeCell: { rowIndex: 0, colIndex: 0 },
      scroll: null,
    })

    const { triggerPaste } = await mountAndCapturePaste()

    await waitFor(() => expect(cacheHarness.getSortedRowIndices).toHaveBeenCalled())
    cacheHarness.getRowsHybrid.mockClear()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => expect(cacheHarness.applyPasteBlock).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(cacheHarness.getRowsHybridColumns).toHaveBeenCalledWith('ds-1', 7680, 8192, ['col-0'])
    })
    expect(cacheHarness.getRowsHybrid).not.toHaveBeenCalledWith('ds-1', 7680, 8192)
    expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith(
      'paste',
      'backend_paste_hydrate_start',
      expect.objectContaining({
        dirtyBlockCount: 21,
        hydrateBlockCount: 1,
      })
    )
  })

  it('shows an error when direct backend paste write is rejected', async () => {
    dataStoreHarness.ds1.rowCount = 11000
    dataStoreHarness.ds1.dataRowCount = 11000
    cacheHarness.applyPasteBlock.mockRejectedValue(new Error('calc-pending values are not allowed'))
    clipboardHarness.read.mockResolvedValue(
      Array.from({ length: 10001 }, (_, index) => `row-${index}`).join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => expect(cacheHarness.applyPasteBlock).toHaveBeenCalledTimes(1))
    expect(undoHarness.recordGridTransaction).not.toHaveBeenCalled()
    expect(toastHarness.error).toHaveBeenCalledWith(
      expect.stringMatching(/failed to paste data/i),
      expect.anything()
    )
  })

  it('routes large internal header-copy data paste through backend paste block while preserving header rename', async () => {
    const rowCount = 10001
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header-backend',
      rowCount,
      dataRowCount: rowCount,
      columnCount: 2,
      columns: [
        { id: 'col-0', name: 'Alpha', type: 'text' as const },
        { id: 'col-1', name: 'Target', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]
    cacheHarness.applyPasteBlock.mockResolvedValue({
      rowStart: 0,
      rowEndExclusive: rowCount,
      editedCells: rowCount,
      oldValues: Array.from({ length: rowCount }, (_, row) => [`old-target-${row}`]),
    })
    pasteEditBuilderHarness.buildPasteEditsInChunks = vi.fn(async () => {
      throw new Error('old paste edit builder should not run for large header-copy data paste')
    })

    let capturedCopy: (() => void | Promise<void>) | null = null
    let capturedPaste: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    await waitFor(() => expect(capturedPaste).not.toBeNull())

    const sourceRows = Array.from({ length: rowCount }, (_, row) => ({ 'col-0': `row-${row}` }))
    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce(sourceRows)

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(0))
    })
    await act(async () => {
      await capturedCopy?.()
    })

    const copiedText = clipboardHarness.write.mock.calls.at(-1)?.[0] ?? ''
    clipboardHarness.read.mockResolvedValue(String(copiedText))
    dataStoreHarness.state.updateDataset.mockClear()
    tauriHarness.updateDatasetMetadata.mockClear()
    executorHarness.execute.mockClear()
    undoHarness.recordGridTransaction.mockClear()

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(1))
    })
    await act(async () => {
      await capturedPaste?.()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => expect(cacheHarness.applyPasteBlock).toHaveBeenCalledTimes(1))
    expect(cacheHarness.applyPasteBlock).toHaveBeenCalledWith('ds-header-backend', {
      rows: Array.from({ length: rowCount }, (_, row) => row),
      columnIds: ['col-1'],
      values: Array.from({ length: rowCount }, (_, row) => [`row-${row}`]),
    })
    expect(dataStoreHarness.state.updateDataset).toHaveBeenCalledWith('ds-header-backend', {
      columns: [
        { id: 'col-0', name: 'Alpha', type: 'text' },
        { id: 'col-1', name: 'Alpha (2)', type: 'text' },
      ],
    })
    expect(tauriHarness.updateDatasetMetadata).toHaveBeenCalledWith('ds-header-backend', [
      { id: 'col-0', name: 'Alpha', type: 'text' },
      { id: 'col-1', name: 'Alpha (2)', type: 'text' },
    ])
    const [, backendUndoTransaction] = undoHarness.recordGridTransaction.mock.calls.at(-1) ?? []
    expect(backendUndoTransaction).toEqual(expect.objectContaining({
      columnRenames: [
        { columnId: 'col-1', oldName: 'Target', newName: 'Alpha (2)' },
      ],
      backendPasteBlock: {
        kind: 'backend-paste-block',
        rows: Array.from({ length: rowCount }, (_, row) => row),
        columnIds: ['col-1'],
        values: Array.from({ length: rowCount }, (_, row) => [`row-${row}`]),
        undoValues: Array.from({ length: rowCount }, (_, row) => [`old-target-${row}`]),
      },
    }))
    expect(backendUndoTransaction.largePasteUndoPolicy).toBeUndefined()
    expect(backendUndoTransaction.edits).toBeUndefined()
    expect(toastHarness.info).not.toHaveBeenCalledWith(
      'Large paste undo will clear the pasted range instead of restoring previous values.'
    )
    expect(appStoreHarness.s.updateActiveFamilyData).toHaveBeenCalledWith('ds-header-backend', 'fam-1')
    expect(pasteEditBuilderHarness.buildPasteEditsInChunks).not.toHaveBeenCalled()
    expect(executorHarness.execute).not.toHaveBeenCalled()
  })

  it('does not record header-copy backend paste undo when returned oldValues shape is invalid', async () => {
    const rowCount = 10001
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header-backend-invalid-undo',
      rowCount,
      dataRowCount: rowCount,
      columnCount: 2,
      columns: [
        { id: 'col-0', name: 'Alpha', type: 'text' as const },
        { id: 'col-1', name: 'Target', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]
    cacheHarness.applyPasteBlock.mockResolvedValue({
      rowStart: 0,
      rowEndExclusive: rowCount,
      editedCells: rowCount,
      oldValues: [['old-only-one-row']],
    })

    let capturedCopy: (() => void | Promise<void>) | null = null
    let capturedPaste: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    await waitFor(() => expect(capturedPaste).not.toBeNull())

    const sourceRows = Array.from({ length: rowCount }, (_, row) => ({ 'col-0': `row-${row}` }))
    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce(sourceRows)

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(0))
    })
    await act(async () => {
      await capturedCopy?.()
    })

    const copiedText = clipboardHarness.write.mock.calls.at(-1)?.[0] ?? ''
    clipboardHarness.read.mockResolvedValue(String(copiedText))
    undoHarness.recordGridTransaction.mockClear()

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(1))
    })
    await act(async () => {
      await capturedPaste?.()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => expect(cacheHarness.applyPasteBlock).toHaveBeenCalledTimes(1))
    expect(undoHarness.recordGridTransaction).not.toHaveBeenCalled()
    expect(toastHarness.error).toHaveBeenCalledWith(
      expect.stringMatching(/backend paste undo/i),
      expect.anything()
    )
  })

  it('keeps 5001-cell non-formula paste on the old path to preserve exact undo semantics', async () => {
    dataStoreHarness.ds1.rowCount = 6000
    dataStoreHarness.ds1.dataRowCount = 6000
    clipboardHarness.read.mockResolvedValue(
      Array.from({ length: 5001 }, (_, index) => `row-${index}`).join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => expect(executorHarness.execute).toHaveBeenCalledTimes(1))
    expect(cacheHarness.applyPasteBlock).not.toHaveBeenCalled()
    expect(toastHarness.info).not.toHaveBeenCalledWith(
      'Large paste undo will clear the pasted range instead of restoring previous values.'
    )
  })

  it('replays compact backend paste undo through applyPasteBlock without edit executor', async () => {
    ;(undoHarness as any).prepareUndoGridTransaction = vi.fn().mockResolvedValue({
      id: 'undo-backend-paste',
      datasetId: 'ds-1',
      kind: 'undo',
      largePasteUndoPolicy: {
        kind: 'backend-clear-range',
        editCount: 2,
      },
      backendPasteBlock: {
        kind: 'backend-paste-block',
        rows: [1024, 1025],
        columnIds: ['col-0'],
        values: [[''], ['']],
      },
    })
    ;(undoHarness as any).commitUndoGridTransaction = vi.fn().mockResolvedValue(undefined)
    ;(undoHarness as any).rollbackUndoGridTransaction = vi.fn().mockResolvedValue(undefined)
    cacheHarness.applyPasteBlock.mockResolvedValue({
      rowStart: 1024,
      rowEndExclusive: 1026,
      editedCells: 2,
      oldValues: [[''], ['']],
    })

    let capturedUndo: (() => void | Promise<void>) | null = null
    await mountAndCapturePaste({
      onUndoRequest: fn => { capturedUndo = fn },
    })

    await act(async () => {
      await capturedUndo?.()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })

    expect(cacheHarness.applyPasteBlock).toHaveBeenCalledWith('ds-1', {
      rows: [1024, 1025],
      columnIds: ['col-0'],
      values: [[''], ['']],
    })
    expect(executorHarness.execute).not.toHaveBeenCalled()
    expect((undoHarness as any).commitUndoGridTransaction).toHaveBeenCalledWith('ds-1')
    expect(appStoreHarness.s.acquireAppOperationLock).toHaveBeenCalledWith({
      owner: 'grid',
      operation: 'Undoing large paste',
      stage: 'Restoring previous values...',
      progress: 0,
      indeterminate: true,
    })
    expect(appStoreHarness.s.releaseAppOperationLock).toHaveBeenCalledWith('paste-lock-token')
  })

  it('commits backend paste undo when narrow hydration fails after DuckDB write', async () => {
    dataStoreHarness.ds1.rowCount = 11000
    dataStoreHarness.ds1.dataRowCount = 11000
    cacheHarness.getDatasetStorageInfo.mockResolvedValue({ isLarge: true })
    cacheHarness.getSortedRowIndices.mockResolvedValue([
      ...Array.from({ length: 2001 }, (_, index) => 8000 + index),
      ...Array.from({ length: 8999 }, (_, index) => index),
    ])
    const schemaKey = computeSchemaKey(dataStoreHarness.ds1.columns.map((column) => column.id))
    vi.mocked(viewStateCacheModule.getViewStateCache).mockReturnValue({
      datasetId: 'ds-1',
      schemaKey,
      sortModel: [{ colId: 'col-1', dir: 'desc' }],
      groupByColumnId: null,
      collapsedGroupKeys: [],
      gridSelection: makeSelection(0, 0),
      activeCell: { rowIndex: 0, colIndex: 0 },
      scroll: null,
    })
    ;(undoHarness as any).prepareUndoGridTransaction = vi.fn().mockResolvedValue({
      id: 'undo-backend-paste-hydration-fails',
      datasetId: 'ds-1',
      kind: 'undo',
      backendPasteBlock: {
        kind: 'backend-paste-block',
        rows: [8000, 8001],
        columnIds: ['col-0'],
        values: [['old-8000'], ['old-8001']],
      },
    })
    ;(undoHarness as any).commitUndoGridTransaction = vi.fn().mockResolvedValue(undefined)
    ;(undoHarness as any).rollbackUndoGridTransaction = vi.fn().mockResolvedValue(undefined)
    cacheHarness.applyPasteBlock.mockResolvedValue({
      rowStart: 8000,
      rowEndExclusive: 8002,
      editedCells: 2,
      oldValues: [['new-8000'], ['new-8001']],
    })
    cacheHarness.getRowsHybridColumns.mockRejectedValueOnce(new Error('narrow hydrate failed'))

    let capturedUndo: (() => void | Promise<void>) | null = null
    await mountAndCapturePaste({
      onUndoRequest: fn => { capturedUndo = fn },
    })

    await act(async () => {
      await capturedUndo?.()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    expect(cacheHarness.applyPasteBlock).toHaveBeenCalledWith('ds-1', {
      rows: [8000, 8001],
      columnIds: ['col-0'],
      values: [['old-8000'], ['old-8001']],
    })
    expect(cacheHarness.getRowsHybridColumns).toHaveBeenCalled()
    expect((undoHarness as any).commitUndoGridTransaction).toHaveBeenCalledWith('ds-1')
    expect((undoHarness as any).rollbackUndoGridTransaction).not.toHaveBeenCalled()
    expect(executorHarness.execute).not.toHaveBeenCalled()
  })

  it('restores a legacy backend undo transaction when the operation lock is unavailable', async () => {
    appStoreHarness.s.acquireAppOperationLock.mockReturnValueOnce(null as unknown as string)
    ;(undoHarness as any).undoGridTransaction = vi.fn().mockResolvedValue({
      id: 'undo-backend-paste-legacy',
      datasetId: 'ds-1',
      kind: 'undo',
      backendPasteBlock: {
        kind: 'backend-paste-block',
        rows: [1024, 1025],
        columnIds: ['col-0'],
        values: [['old-1024'], ['old-1025']],
      },
    })
    ;(undoHarness as any).redoGridTransaction = vi.fn().mockResolvedValue(null)

    let capturedUndo: (() => void | Promise<void>) | null = null
    await mountAndCapturePaste({
      onUndoRequest: fn => { capturedUndo = fn },
    })

    await act(async () => {
      await capturedUndo?.()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })

    expect(cacheHarness.applyPasteBlock).not.toHaveBeenCalled()
    expect((undoHarness as any).redoGridTransaction).toHaveBeenCalledWith('ds-1')
    expect(toastHarness.warning).toHaveBeenCalledWith(
      'Undo is unavailable while another operation is running.'
    )
  })

  it('replays compact backend paste redo through applyPasteBlock without edit executor', async () => {
    ;(undoHarness as any).prepareRedoGridTransaction = vi.fn().mockResolvedValue({
      id: 'redo-backend-paste',
      datasetId: 'ds-1',
      kind: 'redo',
      largePasteUndoPolicy: {
        kind: 'backend-clear-range',
        editCount: 2,
      },
      backendPasteBlock: {
        kind: 'backend-paste-block',
        rows: [1024, 1025],
        columnIds: ['col-0'],
        values: [['31'], ['0']],
      },
    })
    ;(undoHarness as any).commitRedoGridTransaction = vi.fn().mockResolvedValue(undefined)
    ;(undoHarness as any).rollbackRedoGridTransaction = vi.fn().mockResolvedValue(undefined)
    cacheHarness.applyPasteBlock.mockResolvedValue({
      rowStart: 1024,
      rowEndExclusive: 1026,
      editedCells: 2,
      oldValues: [['31'], ['0']],
    })

    await mountAndCapturePaste()
    await waitFor(() => expect(keyboardHarness.handlers?.onRedo).toEqual(expect.any(Function)))

    await act(async () => {
      keyboardHarness.handlers.onRedo()
    })

    await waitFor(() => {
      expect(cacheHarness.applyPasteBlock).toHaveBeenCalledWith('ds-1', {
        rows: [1024, 1025],
        columnIds: ['col-0'],
        values: [['31'], ['0']],
      })
    })
    expect(executorHarness.execute).not.toHaveBeenCalled()
    await waitFor(() => {
      expect((undoHarness as any).commitRedoGridTransaction).toHaveBeenCalledWith('ds-1')
    })
    expect(appStoreHarness.s.acquireAppOperationLock).toHaveBeenCalledWith({
      owner: 'grid',
      operation: 'Redoing large paste',
      stage: 'Reapplying pasted values...',
      progress: 0,
      indeterminate: true,
    })
    expect(appStoreHarness.s.releaseAppOperationLock).toHaveBeenCalledWith('paste-lock-token')
  })

  it('restores a legacy backend redo transaction when the operation lock is unavailable', async () => {
    appStoreHarness.s.acquireAppOperationLock.mockReturnValueOnce(null as unknown as string)
    ;(undoHarness as any).redoGridTransaction = vi.fn().mockResolvedValue({
      id: 'redo-backend-paste-legacy',
      datasetId: 'ds-1',
      kind: 'redo',
      backendPasteBlock: {
        kind: 'backend-paste-block',
        rows: [1024, 1025],
        columnIds: ['col-0'],
        values: [['31'], ['0']],
      },
    })
    ;(undoHarness as any).undoGridTransaction = vi.fn().mockResolvedValue(null)

    let capturedRedo: (() => void | Promise<void>) | null = null
    await mountAndCapturePaste({
      onRedoRequest: fn => { capturedRedo = fn },
    })

    await act(async () => {
      await capturedRedo?.()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })

    expect(cacheHarness.applyPasteBlock).not.toHaveBeenCalled()
    expect((undoHarness as any).undoGridTransaction).toHaveBeenCalledWith('ds-1')
    expect(toastHarness.warning).toHaveBeenCalledWith(
      'Redo is unavailable while another operation is running.'
    )
  })

  it('exposes compact backend paste redo through onRedoRequest for toolbar callers', async () => {
    ;(undoHarness as any).prepareRedoGridTransaction = vi.fn().mockResolvedValue({
      id: 'redo-backend-paste-toolbar',
      datasetId: 'ds-1',
      kind: 'redo',
      largePasteUndoPolicy: {
        kind: 'backend-clear-range',
        editCount: 2,
      },
      backendPasteBlock: {
        kind: 'backend-paste-block',
        rows: [1024, 1025],
        columnIds: ['col-0'],
        values: [['31'], ['0']],
      },
    })
    ;(undoHarness as any).commitRedoGridTransaction = vi.fn().mockResolvedValue(undefined)
    ;(undoHarness as any).rollbackRedoGridTransaction = vi.fn().mockResolvedValue(undefined)
    cacheHarness.applyPasteBlock.mockResolvedValue({
      rowStart: 1024,
      rowEndExclusive: 1026,
      editedCells: 2,
      oldValues: [[''], ['']],
    })

    let capturedRedo: (() => void | Promise<void>) | null = null
    await mountAndCapturePaste({
      onRedoRequest: fn => { capturedRedo = fn },
    })

    await act(async () => {
      await capturedRedo?.()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })

    expect(cacheHarness.applyPasteBlock).toHaveBeenCalledWith('ds-1', {
      rows: [1024, 1025],
      columnIds: ['col-0'],
      values: [['31'], ['0']],
    })
    expect(executorHarness.execute).not.toHaveBeenCalled()
    expect((undoHarness as any).commitRedoGridTransaction).toHaveBeenCalledWith('ds-1')
  })

  it('keeps formula-containing large paste on the old edit path', async () => {
    dataStoreHarness.ds1.rowCount = 6000
    dataStoreHarness.ds1.dataRowCount = 6000
    pasteEditBuilderHarness.buildPasteEditsInChunks = vi.fn(async () => ({
      edits: [
        {
          row: 0,
          columnId: 'col-0',
          oldValue: null,
          newValue: '=A1',
        },
      ],
      aborted: false,
    }))
    clipboardHarness.read.mockResolvedValue(
      [
        '=A1',
        ...Array.from({ length: 5000 }, (_, index) => `row-${index}`),
      ].join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => expect(pasteEditBuilderHarness.buildPasteEditsInChunks).toHaveBeenCalled())
    expect(cacheHarness.applyPasteBlock).not.toHaveBeenCalled()
    expect(executorHarness.execute).toHaveBeenCalled()
  })

  it('emits current large-paste timing buckets with old-value lookup count', async () => {
    dataStoreHarness.ds1.rowCount = 20
    dataStoreHarness.ds1.dataRowCount = 20
    const clipboardRows = Array.from(
      { length: 12 },
      (_, row) => `left-${row}\tright-${row}`
    )
    clipboardHarness.read.mockResolvedValue(clipboardRows.join('\n'))

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    await waitFor(() => expect(executorHarness.execute).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(cacheHarness.flushOverlay).toHaveBeenCalledWith('ds-1'))
    gridHarness.latestProps?.getCellContent?.([0, 0])
    await waitFor(() => {
      expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith(
        'paste',
        'paste_current_hydrate_done',
        expect.anything()
      )
    })

    const timingEvents = debugHarness.logRuntimeDebug.mock.calls
      .filter(([channel, name]) =>
        channel === 'paste' &&
        String(name).startsWith('paste_current_')
      )
      .map(([, name, payload]) => ({ name, payload }))

    expect(timingEvents.map(event => event.name)).toEqual([
      'paste_current_build_start',
      'paste_current_build_done',
      'paste_current_prepare_start',
      'paste_current_prepare_done',
      'paste_current_execute_start',
      'paste_current_execute_done',
      'paste_current_flush_start',
      'paste_current_flush_done',
      'paste_current_hydrate_start',
      'paste_current_hydrate_done',
    ])
    expect(timingEvents.find(event => event.name === 'paste_current_build_done')?.payload)
      .toEqual(expect.objectContaining({
        datasetId: 'ds-1',
        rowCount: 12,
        columnCount: 2,
        editCount: 24,
        oldValueLookupCount: 24,
        editBuildDurationMs: expect.any(Number),
      }))
  })

  it('times hydrate from cold block reload instead of flush completion', async () => {
    dataStoreHarness.ds1.rowCount = 2000
    dataStoreHarness.ds1.dataRowCount = 2000
    let resolveColdBlock!: (rows: Array<Record<string, string>>) => void
    const coldBlockPromise = new Promise<Array<Record<string, string>>>((resolve) => {
      resolveColdBlock = resolve
    })
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) => {
      if (start >= 0 && end <= 1024) {
        return Array.from({ length: end - start }, (_, offset) => ({
          'col-0': `base-${start + offset}`,
          'col-1': `neighbor-${start + offset}`,
        }))
      }
      if (start === 1024 && end === 1536) {
        return await coldBlockPromise
      }
      return []
    })
    clipboardHarness.read.mockResolvedValue(
      Array.from({ length: 1025 }, (_, index) => `paste-${index}`).join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 0, 512)
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 512, 1024)
    })

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => {
      expect(cacheHarness.flushOverlay).toHaveBeenCalledWith('ds-1')
    })
    expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith(
      'paste',
      'paste_current_hydrate_start',
      expect.objectContaining({
        datasetId: 'ds-1',
        hydrateBlockCount: 1,
      })
    )
    expect(debugHarness.logRuntimeDebug).not.toHaveBeenCalledWith(
      'paste',
      'paste_current_hydrate_done',
      expect.anything()
    )

    cacheHarness.getRowsHybrid.mockClear()
    gridHarness.latestProps?.getCellContent?.([1, 1024])
    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 1024, 1536)
    })

    resolveColdBlock(
      Array.from({ length: 512 }, (_, offset) => ({
        'col-0': `base-${1024 + offset}`,
        'col-1': `neighbor-${1024 + offset}`,
      }))
    )

    await waitFor(() => {
      expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith(
        'paste',
        'paste_current_hydrate_done',
        expect.objectContaining({
          datasetId: 'ds-1',
          hydrateCompletedBlocks: 1,
          hydrateDurationMs: expect.any(Number),
        })
      )
    })
  })

  it('skips executor data-store writes during paste and applies them once after execution', async () => {
    clipboardHarness.read.mockResolvedValue('a\tb')

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })

    await waitFor(() => expect(executorHarness.execute).toHaveBeenCalledTimes(1))
    const [edits, source, options] = executorHarness.execute.mock.calls[0] as [
      Array<{ row: number; columnId: string; newValue: string }>,
      string,
      { skipDataStoreUpdate?: boolean; skipUndoRegistration?: boolean },
    ]

    expect(source).toBe('paste')
    expect(options).toEqual(expect.objectContaining({
      skipDataStoreUpdate: true,
      skipUndoRegistration: true,
    }))
    expect(executorHarness.applyDataStoreUpdate).toHaveBeenCalledTimes(1)
    expect(executorHarness.applyDataStoreUpdate).toHaveBeenCalledWith(edits)
  })

  it('passes backend chunking options for formula paste batches above the large-paste threshold', async () => {
    dataStoreHarness.ds1.rowCount = 6000
    dataStoreHarness.ds1.dataRowCount = 6000
    clipboardHarness.read.mockResolvedValue(
      [
        '=A1',
        ...Array.from({ length: 5000 }, (_, index) => `row-${index}`),
      ].join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    await waitFor(() => expect(executorHarness.execute).toHaveBeenCalledTimes(1))
    const [, , options] = executorHarness.execute.mock.calls[0] as [
      Array<{ row: number; columnId: string; newValue: string }>,
      string,
      { backendSyncChunkSize?: number; flushBackendChunks?: boolean },
    ]

    expect(options).toEqual(expect.objectContaining({
      backendSyncChunkSize: 5000,
      flushBackendChunks: true,
    }))
    expect(appStoreHarness.s.updateAppOperationLock).toHaveBeenCalledWith(
      'paste-lock-token',
      expect.objectContaining({ stage: 'Preparing paste 1/2...' })
    )
    expect(appStoreHarness.s.updateAppOperationLock).toHaveBeenCalledWith(
      'paste-lock-token',
      expect.objectContaining({ stage: 'Preparing paste 2/2...' })
    )
  })

  it('passes a paste-scoped local rowData skip predicate for unloaded existing rows', async () => {
    dataStoreHarness.ds1.rowCount = 2000
    dataStoreHarness.ds1.dataRowCount = 2000
    clipboardHarness.read.mockResolvedValue(
      Array.from({ length: 1025 }, (_, index) => `row-${index}`).join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    await waitFor(() => expect(executorHarness.execute).toHaveBeenCalledTimes(1))
    const [edits, , options] = executorHarness.execute.mock.calls[0] as [
      Array<{ row: number; columnId: string; newValue: string }>,
      string,
      {
        shouldSkipLocalRowDataWrite?: (
          row: number,
          edit: { row: number; columnId: string; newValue: string }
        ) => boolean
      },
    ]

    expect(options.shouldSkipLocalRowDataWrite).toEqual(expect.any(Function))
    expect(options.shouldSkipLocalRowDataWrite?.(1024, edits[1024]!)).toBe(true)
    expect(options.shouldSkipLocalRowDataWrite?.(2000, {
      row: 2000,
      columnId: 'col-0',
      newValue: 'buffer-row',
    })).toBe(false)
  })

  it('keeps cold existing paste rows overlay-only after the hot row boundary', async () => {
    dataStoreHarness.ds1.rowCount = 2000
    dataStoreHarness.ds1.dataRowCount = 2000
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) => {
      if (start >= 0 && end <= 1024) {
        return Array.from({ length: end - start }, (_, offset) => ({
          'col-0': `base-${start + offset}`,
          'col-1': `neighbor-${start + offset}`,
        }))
      }
      return []
    })
    clipboardHarness.read.mockResolvedValue(
      Array.from({ length: 1025 }, (_, index) => `paste-${index}`).join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 0, 512)
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 512, 1024)
    })

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => {
      expect(executorHarness.applyDataStoreUpdate).toHaveBeenCalled()
    })

    expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith(
      'paste',
      'paste_apply_staged_rows_summary',
      expect.objectContaining({
        clonedMaterializedRows: 1024,
        sentinelSparseRows: 0,
      })
    )
  })

  it('renders a cold pasted row neighbor as visibly loading until the backend row hydrates', async () => {
    dataStoreHarness.ds1.rowCount = 2000
    dataStoreHarness.ds1.dataRowCount = 2000
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) => {
      if (start >= 0 && end <= 1024) {
        return Array.from({ length: end - start }, (_, offset) => ({
          'col-0': `base-${start + offset}`,
          'col-1': `neighbor-${start + offset}`,
        }))
      }
      if (start === 1024 && end === 1536) {
        return Array.from({ length: end - start }, (_, offset) => ({
          'col-0': `base-${start + offset}`,
          'col-1': `neighbor-${start + offset}`,
        }))
      }
      return []
    })
    clipboardHarness.read.mockResolvedValue(
      Array.from({ length: 1025 }, (_, index) => `paste-${index}`).join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 0, 512)
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 512, 1024)
    })

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => {
      expect(executorHarness.applyDataStoreUpdate).toHaveBeenCalled()
    })
    cacheHarness.getRowsHybrid.mockClear()

    const coldNeighbor = gridHarness.latestProps?.getCellContent?.([1, 1024])
    expect(coldNeighbor).toMatchObject({
      displayData: '...',
      allowOverlay: false,
      readonly: true,
    })

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 1024, 1536)
    })
    await waitFor(() => {
      expect(gridHarness.latestProps?.getCellContent?.([1, 1024])).toMatchObject({
        displayData: 'neighbor-1024',
        allowOverlay: true,
        readonly: false,
      })
    })
  })

  it('recovers a loaded-empty cold pasted block instead of leaving neighbor cells loading forever', async () => {
    dataStoreHarness.ds1.rowCount = 2000
    dataStoreHarness.ds1.dataRowCount = 2000
    let coldBlockHydrated = false
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) => {
      if (start >= 0 && end <= 1024) {
        return Array.from({ length: end - start }, (_, offset) => ({
          'col-0': `base-${start + offset}`,
          'col-1': `neighbor-${start + offset}`,
        }))
      }
      if (start === 1024 && end === 1536) {
        if (!coldBlockHydrated) {
          return []
        }
        return Array.from({ length: end - start }, (_, offset) => ({
          'col-0': `base-${start + offset}`,
          'col-1': `neighbor-${start + offset}`,
        }))
      }
      return []
    })
    clipboardHarness.read.mockResolvedValue(
      Array.from({ length: 1025 }, (_, index) => `paste-${index}`).join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 0, 512)
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 512, 1024)
    })

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => {
      expect(executorHarness.applyDataStoreUpdate).toHaveBeenCalled()
    })
    cacheHarness.getRowsHybrid.mockClear()

    expect(gridHarness.latestProps?.getCellContent?.([1, 1024])).toMatchObject({
      displayData: '...',
      allowOverlay: false,
      readonly: true,
    })
    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 1024, 1536)
    })
    await waitFor(() => {
      expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith(
        'paste',
        'grid_block_load_empty_sentinel',
        expect.objectContaining({
          datasetId: 'ds-1',
          block: 2,
        })
      )
    })

    cacheHarness.getRowsHybrid.mockClear()
    coldBlockHydrated = true

    expect(gridHarness.latestProps?.getCellContent?.([1, 1024])).toMatchObject({
      displayData: '...',
      allowOverlay: false,
      readonly: true,
    })
    gridHarness.latestProps?.getCellContent?.([2, 1024])

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledTimes(1)
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 1024, 1536)
    })
    await waitFor(() => {
      expect(gridHarness.latestProps?.getCellContent?.([1, 1024])).toMatchObject({
        displayData: 'neighbor-1024',
        allowOverlay: true,
        readonly: false,
      })
    })
  })

  it('keeps pasted buffer-row neighbors editable instead of loading forever', async () => {
    dataStoreHarness.ds1.rowCount = 2000
    dataStoreHarness.ds1.dataRowCount = 2000
    cacheHarness.getRowCount.mockResolvedValue(2000)
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, end: number) => {
      if (start >= 0 && end <= 1024) {
        return Array.from({ length: end - start }, (_, offset) => ({
          'col-0': `base-${start + offset}`,
          'col-1': `neighbor-${start + offset}`,
        }))
      }
      return []
    })
    clipboardHarness.read.mockResolvedValue('new-row')

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeSelection(0, 2000))
    })

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => {
      expect(executorHarness.applyDataStoreUpdate).toHaveBeenCalled()
    })

    expect(gridHarness.latestProps?.getCellContent?.([1, 2000])).toMatchObject({
      displayData: '',
      allowOverlay: true,
      readonly: false,
    })
  })

  it('does not enable backend chunking for paste batches exactly at the large-paste threshold', async () => {
    dataStoreHarness.ds1.rowCount = 5000
    dataStoreHarness.ds1.dataRowCount = 5000
    clipboardHarness.read.mockResolvedValue(
      Array.from({ length: 5000 }, (_, index) => `row-${index}`).join('\n')
    )

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    await waitFor(() => expect(executorHarness.execute).toHaveBeenCalledTimes(1))
    const [, , options] = executorHarness.execute.mock.calls[0] as [
      Array<{ row: number; columnId: string; newValue: string }>,
      string,
      { backendSyncChunkSize?: number; flushBackendChunks?: boolean },
    ]

    expect(options.backendSyncChunkSize).toBeUndefined()
    expect(options.flushBackendChunks).toBe(false)
  })

  it('shows a sync failure banner, retries the full paste batch, and reloads affected rows', async () => {
    clipboardHarness.read.mockResolvedValue('pasted')
    executorHarness.execute.mockResolvedValueOnce({ backendSyncSucceeded: false })

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByTestId('grid-sync-failure-banner')).toBeInTheDocument()
    })
    expect(executorHarness.applyDataStoreUpdate).not.toHaveBeenCalled()
    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([{ 'col-0': 'pasted' }])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /retry sync/i }))
    })

    await waitFor(() => {
      expect(cacheHarness.enqueueGridMutationBatch).toHaveBeenCalledWith('ds-1', [
        { row: 0, column: 'col-0', value: 'pasted' },
      ])
    })
    expect(cacheHarness.flushGridMutationQueue).toHaveBeenCalledWith('ds-1')
    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 0, 3)
    })
    await waitFor(() => {
      const cell = gridHarness.latestProps?.getCellContent?.([0, 0])
      expect(cell?.displayData).toBe('pasted')
    })
    expect(toastHarness.success).toHaveBeenCalledWith('Dataset sync retried')
    await waitFor(() => {
      expect(screen.queryByTestId('grid-sync-failure-banner')).not.toBeInTheDocument()
    })
  })

  it('uses queue-only retry when the generic retry action is for a different dataset', async () => {
    clipboardHarness.read.mockResolvedValue('pasted')
    executorHarness.execute.mockResolvedValueOnce({ backendSyncSucceeded: false })
    ;(undoHarness as any).prepareUndoGridTransaction = vi.fn().mockResolvedValue({
      id: 'undo-ds-2',
      datasetId: 'ds-2',
      kind: 'undo',
      edits: [],
    })
    ;(undoHarness as any).rollbackUndoGridTransaction = vi.fn().mockResolvedValue(undefined)

    let capturedUndo: (() => void | Promise<void>) | null = null
    const { triggerPaste } = await mountAndCapturePaste({
      onUndoRequest: fn => { capturedUndo = fn },
    })

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByTestId('grid-sync-failure-banner')).toBeInTheDocument()
    })
    cacheHarness.queueStates.set('ds-2', {
      status: 'failed',
      failedQueueId: 'queue-ds-2',
      error: 'other dataset failed',
    })
    cacheHarness.retryGridMutationQueue.mockClear()
    cacheHarness.enqueueGridMutationBatch.mockClear()

    await act(async () => {
      void capturedUndo?.()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })

    const warningCall = toastHarness.warning.mock.calls.find(
      ([message]) => String(message).includes('Undo is unavailable')
    )
    expect(warningCall?.[1]?.action?.label).toBe('Retry sync')

    await act(async () => {
      await warningCall?.[1]?.action?.onClick?.()
    })

    await waitFor(() => {
      expect(cacheHarness.retryGridMutationQueue).toHaveBeenCalledWith('ds-2')
    })
    expect(cacheHarness.enqueueGridMutationBatch).not.toHaveBeenCalled()
  })

  it('replays every failed paste chunk from the generic queue retry action', async () => {
    const edits = Array.from({ length: 10_001 }, (_, row) => ({
      row,
      columnId: 'col-0',
      oldValue: `old-${row}`,
      newValue: `new-${row}`,
    }))
    pasteEditBuilderHarness.buildPasteEditsInChunks = vi.fn(async () => ({
      edits,
      aborted: false,
    }))
    clipboardHarness.read.mockResolvedValue('seed')
    executorHarness.execute.mockResolvedValueOnce({ backendSyncSucceeded: false })

    let capturedUndo: (() => void | Promise<void>) | null = null
    const { triggerPaste } = await mountAndCapturePaste({
      onUndoRequest: fn => { capturedUndo = fn },
    })

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByTestId('grid-sync-failure-banner')).toBeInTheDocument()
    })
    cacheHarness.enqueueGridMutationBatch.mockClear()
    cacheHarness.flushGridMutationQueue.mockClear()
    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValue([])
    cacheHarness.queueStates.set('ds-1', {
      status: 'failed',
      failedQueueId: 'queue-failed',
      error: 'chunk failed',
    })

    await act(async () => {
      void capturedUndo?.()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })

    const warningCall = toastHarness.warning.mock.calls.find(
      ([message]) => String(message).includes('Undo is unavailable')
    )
    expect(warningCall?.[1]?.action?.label).toBe('Retry sync')

    await act(async () => {
      await warningCall?.[1]?.action?.onClick?.()
    })

    await waitFor(() => {
      expect(cacheHarness.enqueueGridMutationBatch).toHaveBeenCalledTimes(3)
    })
    expect(cacheHarness.enqueueGridMutationBatch.mock.calls.map(([, chunk]) => chunk.length)).toEqual([
      5000,
      5000,
      1,
    ])
    expect(cacheHarness.enqueueGridMutationBatch.mock.calls.at(-1)?.[1]).toEqual([
      { row: 10_000, column: 'col-0', value: 'new-10000' },
    ])
  })

  it('records huge paste undo as a clear-range transaction', async () => {
    clipboardHarness.read.mockResolvedValue('seed')
    const hugeEdits = Array.from({ length: 10_001 }, (_, row) => ({
      row,
      columnId: 'col-0',
      oldValue: `old-${row}`,
      newValue: `new-${row}`,
    }))
    pasteEditBuilderHarness.buildPasteEditsInChunks = vi.fn(async () => ({
      edits: hugeEdits,
      aborted: false,
    }))

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })

    await waitFor(() => {
      expect(undoHarness.recordGridTransaction).toHaveBeenCalled()
    })
    const [, transaction] = undoHarness.recordGridTransaction.mock.calls.at(-1) ?? []
    expect(transaction).toEqual(expect.objectContaining({
      largePasteUndoPolicy: {
        kind: 'clear-range',
        editCount: 10_001,
      },
    }))
    expect(transaction.edits[0]).toMatchObject({
      row: 0,
      columnId: 'col-0',
      oldValue: '',
      newValue: 'new-0',
    })
    expect(toastHarness.info).toHaveBeenCalledWith(
      'Large paste undo will clear the pasted range instead of restoring previous values.'
    )
  })
})

// ---------------------------------------------------------------------------
// SORT_BLOCK: active sort blocks row-overflow expansion
// ---------------------------------------------------------------------------

describe('SpreadsheetView paste — SORT_BLOCK', () => {
  it('returns warning toast without calling execute when sort is active and paste would overflow rows', async () => {
    // Clipboard: 5 rows × 2 cols — overflows ds1 which has only 3 rows
    clipboardHarness.read.mockResolvedValue(
      ['r0c0\tr0c1', 'r1c0\tr1c1', 'r2c0\tr2c1', 'r3c0\tr3c1', 'r4c0\tr4c1'].join('\n')
    )

    const schemaKey = computeSchemaKey(dataStoreHarness.ds1.columns.map((column) => column.id))
    vi.mocked(viewStateCacheModule.getViewStateCache).mockReturnValue({
      datasetId: 'ds-1',
      schemaKey,
      sortModel: [{ colId: 'col-1', dir: 'asc' }],
      groupByColumnId: null,
      collapsedGroupKeys: [],
      gridSelection: makeSelection(0, 0),
      activeCell: { rowIndex: 0, colIndex: 0 },
      scroll: null,
    })

    const { triggerPaste } = await mountAndCapturePaste()

    // Now trigger paste — overflow + transform active → toast.warning + early return
    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    await waitFor(() => expect(toastHarness.warning).toHaveBeenCalled())
    expect(executorHarness.execute).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ALLOC_FAIL: column-name allocation failure rolls back and aborts paste
// ---------------------------------------------------------------------------

describe('SpreadsheetView paste — ALLOC_FAIL', () => {
  it('overflow count excludes virtual + column — 4-col paste triggers 2-col overflow against 2-col dataset', async () => {
    // ds1 has 2 real columns. A 4-col paste should cause colOverflow=2 (4 - 2 = 2),
    // triggering 2 allocations: Col-3 succeeds, second returns null → rollback.
    // Regression: if columns.length (=3, includes virtual "+") is used as currentColCount,
    // colOverflow = 4 - 3 = 1 → only 1 allocation → no rollback → this test fails.
    clipboardHarness.read.mockResolvedValue('a\tb\tc\td\ne\tf\tg\th')

    dataStoreHarness.state.allocateNextAutoColumnName
      .mockReturnValueOnce('Col-3')
      .mockReturnValueOnce(null)

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    // 2 allocations attempted (col overflow = 2, not 1)
    expect(dataStoreHarness.state.allocateNextAutoColumnName).toHaveBeenCalledTimes(2)
    // First allocated name rolled back when second fails
    expect(dataStoreHarness.state.rollbackAutoColumnNameAllocation).toHaveBeenCalledWith('ds-1', 'Col-3')
    expect(executorHarness.execute).not.toHaveBeenCalled()
  })

  it('rolls back the first allocated name and skips execute when second allocation fails', async () => {
    // Clipboard: 2 rows × 5 cols — ds1 has 2 real cols, so colOverflow = 5 - 2 = 3.
    // Needs 3 allocations: Col-3 succeeds, second returns null → rollback.
    clipboardHarness.read.mockResolvedValue('a\tb\tc\td\te\ne\tf\tg\th\ti')

    // First allocation succeeds ('Col-3'), second fails (null) → buildNewColumnDrafts → null
    dataStoreHarness.state.allocateNextAutoColumnName
      .mockReturnValueOnce('Col-3')
      .mockReturnValueOnce(null)

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      // Drain microtasks: clipboard.read resolves → preflight → decidePasteOverflow (mocked
      // to resolve immediately) → buildNewColumnDrafts → rollback → toast.error → return
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    // Diagnostic: verify allocate was called (buildNewColumnDrafts ran)
    expect(dataStoreHarness.state.allocateNextAutoColumnName).toHaveBeenCalled()

    // buildNewColumnDrafts returned null → rollback the already-allocated 'Col-3'
    expect(dataStoreHarness.state.rollbackAutoColumnNameAllocation).toHaveBeenCalledWith(
      'ds-1',
      'Col-3'
    )

    // No backend calls — addColumn is inside applyColumnExpansion which was never reached
    expect(cacheHarness.addColumn).not.toHaveBeenCalled()

    // Paste aborted — execute never fired
    expect(executorHarness.execute).not.toHaveBeenCalled()

    // User sees an error toast
    expect(toastHarness.error).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// HEADER_RENAME: header-target paste renames columns from internal copy metadata
// ---------------------------------------------------------------------------

describe('SpreadsheetView paste — HEADER_RENAME', () => {
  it('renames destination headers and pastes copied data rows beneath them as one grid transaction', async () => {
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header',
      rowCount: 2,
      dataRowCount: 2,
      columnCount: 4,
      columns: [
        { id: 'col-0', name: 'Alpha', type: 'text' as const },
        { id: 'col-1', name: 'Beta', type: 'text' as const },
        { id: 'col-2', name: 'Target 1', type: 'text' as const },
        { id: 'col-3', name: 'Target 2', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]

    let capturedCopy: (() => void | Promise<void>) | null = null
    let capturedPaste: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    await waitFor(() => expect(capturedPaste).not.toBeNull())

    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-0': 'a1', 'col-1': 'b1', 'col-2': 'x1', 'col-3': 'y1' },
      { 'col-0': 'a2', 'col-1': 'b2', 'col-2': 'x2', 'col-3': 'y2' },
    ])

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(0, 2))
    })
    await act(async () => {
      await capturedCopy?.()
    })

    await waitFor(() => {
      expect(clipboardHarness.write).toHaveBeenCalledWith('Alpha\tBeta\na1\tb1\na2\tb2')
    })
    const copiedText = clipboardHarness.write.mock.calls.at(-1)?.[0] ?? ''
    clipboardHarness.read.mockResolvedValue(String(copiedText))

    dataStoreHarness.state.updateDataset.mockClear()
    tauriHarness.updateDatasetMetadata.mockClear()
    undoHarness.pushColumnRename.mockClear()
    undoHarness.recordGridTransaction.mockClear()
    executorHarness.execute.mockClear()

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(2))
    })
    await act(async () => {
      await capturedPaste?.()
    })

    const expectedColumns = [
      { id: 'col-0', name: 'Alpha', type: 'text' },
      { id: 'col-1', name: 'Beta', type: 'text' },
      { id: 'col-2', name: 'Alpha (2)', type: 'text' },
      { id: 'col-3', name: 'Beta (2)', type: 'text' },
    ]
    await waitFor(() => {
      expect(dataStoreHarness.state.updateDataset).toHaveBeenCalledWith('ds-header', {
        columns: expectedColumns,
      })
    })
    await waitFor(() => {
      expect(tauriHarness.updateDatasetMetadata).toHaveBeenCalledWith('ds-header', expectedColumns)
    })
    expect(undoHarness.pushColumnRename).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(executorHarness.execute).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(undoHarness.recordGridTransaction).toHaveBeenCalledWith(
        'ds-header',
        expect.objectContaining({
          kind: 'paste',
          columnRenames: [
            { columnId: 'col-2', oldName: 'Target 1', newName: 'Alpha (2)' },
            { columnId: 'col-3', oldName: 'Target 2', newName: 'Beta (2)' },
          ],
        })
      )
    })
    const [edits, source] = executorHarness.execute.mock.calls[0] as [
      Array<{ row: number; columnId: string; newValue: string }>,
      string,
    ]
    expect(source).toBe('paste')
    expect(edits).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 0, columnId: 'col-2', newValue: 'a1' }),
      expect.objectContaining({ row: 0, columnId: 'col-3', newValue: 'b1' }),
      expect.objectContaining({ row: 1, columnId: 'col-2', newValue: 'a2' }),
      expect.objectContaining({ row: 1, columnId: 'col-3', newValue: 'b2' }),
    ]))
  })

  it('routes Ctrl+V header-only paste through the same header paste path', async () => {
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header',
      rowCount: 1,
      dataRowCount: 1,
      columnCount: 3,
      columns: [
        { id: 'col-0', name: 'Alpha', type: 'text' as const },
        { id: 'col-1', name: 'Target 1', type: 'text' as const },
        { id: 'col-2', name: 'Target 2', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]

    let capturedCopy: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    await waitFor(() => expect(keyboardHarness.handlers?.onPaste).toEqual(expect.any(Function)))

    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-0': 'a1', 'col-1': 'x1', 'col-2': 'y1' },
    ])

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(0))
    })
    await act(async () => {
      await capturedCopy?.()
    })
    const copiedText = clipboardHarness.write.mock.calls.at(-1)?.[0] ?? ''
    clipboardHarness.read.mockResolvedValue(String(copiedText))

    dataStoreHarness.state.updateDataset.mockClear()
    executorHarness.execute.mockClear()
    undoHarness.recordGridTransaction.mockClear()

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(1))
    })

    let handled: unknown
    await act(async () => {
      handled = keyboardHarness.handlers.onPaste()
      await Promise.resolve()
    })

    expect(handled).toBe(true)
    await waitFor(() => {
      expect(dataStoreHarness.state.updateDataset).toHaveBeenCalledWith('ds-header', {
        columns: [
          { id: 'col-0', name: 'Alpha', type: 'text' },
          { id: 'col-1', name: 'Alpha (2)', type: 'text' },
          { id: 'col-2', name: 'Target 2', type: 'text' },
        ],
      })
    })
    await waitFor(() => {
      expect(undoHarness.recordGridTransaction).toHaveBeenCalledWith(
        'ds-header',
        expect.objectContaining({
          kind: 'paste',
          columnRenames: [
            { columnId: 'col-1', oldName: 'Target 1', newName: 'Alpha (2)' },
          ],
        })
      )
    })
    await waitFor(() => {
      expect(executorHarness.execute).toHaveBeenCalled()
    })
    const [edits, source] = executorHarness.execute.mock.calls[0] as [
      Array<{ row: number; columnId: string; newValue: string }>,
      string,
    ]
    expect(source).toBe('paste')
    expect(edits).toEqual([
      expect.objectContaining({ row: 0, columnId: 'col-1', newValue: 'a1' }),
    ])
  })

  it('skips copied header row when pasting a header-copy payload into data cells', async () => {
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header',
      rowCount: 2,
      dataRowCount: 2,
      columnCount: 4,
      columns: [
        { id: 'col-0', name: 'Alpha', type: 'text' as const },
        { id: 'col-1', name: 'Beta', type: 'text' as const },
        { id: 'col-2', name: 'Target 1', type: 'text' as const },
        { id: 'col-3', name: 'Target 2', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]

    let capturedCopy: (() => void | Promise<void>) | null = null
    let capturedPaste: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    await waitFor(() => expect(capturedPaste).not.toBeNull())

    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-0': 'a1', 'col-1': 'b1', 'col-2': 'x1', 'col-3': 'y1' },
      { 'col-0': 'a2', 'col-1': 'b2', 'col-2': 'x2', 'col-3': 'y2' },
    ])

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(0, 2))
    })
    await act(async () => {
      await capturedCopy?.()
    })
    const copiedText = clipboardHarness.write.mock.calls.at(-1)?.[0] ?? ''
    clipboardHarness.read.mockResolvedValue(String(copiedText))

    dataStoreHarness.state.updateDataset.mockClear()
    executorHarness.execute.mockClear()
    undoHarness.recordGridTransaction.mockClear()

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeSelection(2, 0))
    })
    await act(async () => {
      await capturedPaste?.()
    })

    expect(dataStoreHarness.state.updateDataset).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(executorHarness.execute).toHaveBeenCalled()
    })
    const [edits] = executorHarness.execute.mock.calls[0] as [
      Array<{ row: number; columnId: string; newValue: string }>,
      string,
    ]
    expect(edits).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 0, columnId: 'col-2', newValue: 'a1' }),
      expect.objectContaining({ row: 0, columnId: 'col-3', newValue: 'b1' }),
      expect.objectContaining({ row: 1, columnId: 'col-2', newValue: 'a2' }),
      expect.objectContaining({ row: 1, columnId: 'col-3', newValue: 'b2' }),
    ]))
    expect(edits.some(edit => edit.newValue === 'Alpha')).toBe(false)
    expect(edits.some(edit => edit.newValue === 'Beta')).toBe(false)
    await waitFor(() => {
      expect(undoHarness.recordGridTransaction).toHaveBeenCalledWith(
        'ds-header',
        expect.objectContaining({ kind: 'paste' })
      )
    })
    const recordedTransaction = undoHarness.recordGridTransaction.mock.calls.at(-1)?.[1]
    expect(recordedTransaction?.columnRenames).toBeUndefined()
  })

  it('skips copied header row for paste-values into data cells', async () => {
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header',
      rowCount: 2,
      dataRowCount: 2,
      columnCount: 4,
      columns: [
        { id: 'col-0', name: 'Alpha', type: 'text' as const },
        { id: 'col-1', name: 'Beta', type: 'text' as const },
        { id: 'col-2', name: 'Target 1', type: 'text' as const },
        { id: 'col-3', name: 'Target 2', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]

    let capturedCopy: (() => void | Promise<void>) | null = null
    render(<SpreadsheetView onCopyRequest={fn => { capturedCopy = fn }} />)

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    await waitFor(() => expect(keyboardHarness.handlers?.onPasteValues).toEqual(expect.any(Function)))

    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-0': 'a1', 'col-1': 'b1', 'col-2': 'x1', 'col-3': 'y1' },
      { 'col-0': 'a2', 'col-1': 'b2', 'col-2': 'x2', 'col-3': 'y2' },
    ])

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(0, 2))
    })
    await act(async () => {
      await capturedCopy?.()
    })
    const copiedText = clipboardHarness.write.mock.calls.at(-1)?.[0] ?? ''
    clipboardHarness.read.mockResolvedValue(String(copiedText))

    dataStoreHarness.state.updateDataset.mockClear()
    executorHarness.execute.mockClear()
    undoHarness.recordGridTransaction.mockClear()

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeSelection(2, 0))
    })
    let handled: unknown
    await act(async () => {
      handled = keyboardHarness.handlers.onPasteValues()
      await Promise.resolve()
    })

    expect(handled).toBe(true)
    expect(dataStoreHarness.state.updateDataset).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(executorHarness.execute).toHaveBeenCalled()
    })
    const [edits, source] = executorHarness.execute.mock.calls[0] as [
      Array<{ row: number; columnId: string; newValue: string }>,
      string,
    ]
    expect(source).toBe('paste')
    expect(edits).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 0, columnId: 'col-2', newValue: 'a1' }),
      expect.objectContaining({ row: 0, columnId: 'col-3', newValue: 'b1' }),
      expect.objectContaining({ row: 1, columnId: 'col-2', newValue: 'a2' }),
      expect.objectContaining({ row: 1, columnId: 'col-3', newValue: 'b2' }),
    ]))
    expect(edits.some(edit => edit.newValue === 'Alpha')).toBe(false)
    expect(edits.some(edit => edit.newValue === 'Beta')).toBe(false)
    await waitFor(() => {
      expect(undoHarness.recordGridTransaction).toHaveBeenCalledWith(
        'ds-header',
        expect.objectContaining({ kind: 'paste-values' })
      )
    })
    const recordedTransaction = undoHarness.recordGridTransaction.mock.calls.at(-1)?.[1]
    expect(recordedTransaction?.columnRenames).toBeUndefined()
  })

  it('does not route paste-values through header renames for header-only targets', async () => {
    render(<SpreadsheetView />)

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(keyboardHarness.handlers?.onPasteValues).toEqual(expect.any(Function)))

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(1))
    })

    let handled: unknown
    await act(async () => {
      handled = keyboardHarness.handlers.onPasteValues()
      await Promise.resolve()
    })

    expect(handled).toBe(false)
    expect(dataStoreHarness.state.updateDataset).not.toHaveBeenCalled()
    expect(executorHarness.execute).not.toHaveBeenCalled()
    expect(undoHarness.recordGridTransaction).not.toHaveBeenCalled()
  })

  it('rolls back local header names and aborts edits when metadata sync fails', async () => {
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header',
      rowCount: 1,
      dataRowCount: 1,
      columnCount: 3,
      columns: [
        { id: 'col-0', name: 'Alpha', type: 'text' as const },
        { id: 'col-1', name: 'Target 1', type: 'text' as const },
        { id: 'col-2', name: 'Target 2', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]

    let capturedCopy: (() => void | Promise<void>) | null = null
    let capturedPaste: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    await waitFor(() => expect(capturedPaste).not.toBeNull())

    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-0': 'a1', 'col-1': 'x1', 'col-2': 'y1' },
    ])

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(0))
    })
    await act(async () => {
      await capturedCopy?.()
    })
    const copiedText = clipboardHarness.write.mock.calls.at(-1)?.[0] ?? ''
    clipboardHarness.read.mockResolvedValue(String(copiedText))

    dataStoreHarness.state.updateDataset.mockClear()
    tauriHarness.updateDatasetMetadata.mockRejectedValueOnce(new Error('metadata failed'))
    executorHarness.execute.mockClear()
    undoHarness.recordGridTransaction.mockClear()

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(1))
    })
    await act(async () => {
      await capturedPaste?.()
    })

    const renamedColumns = [
      { id: 'col-0', name: 'Alpha', type: 'text' },
      { id: 'col-1', name: 'Alpha (2)', type: 'text' },
      { id: 'col-2', name: 'Target 2', type: 'text' },
    ]
    await waitFor(() => {
      expect(dataStoreHarness.state.updateDataset).toHaveBeenCalledWith('ds-header', {
        columns: renamedColumns,
      })
      expect(dataStoreHarness.state.updateDataset).toHaveBeenCalledWith('ds-header', {
        columns: headerDataset.columns,
      })
    })
    const updateCalls = dataStoreHarness.state.updateDataset.mock.calls
    const forwardCallIndex = updateCalls.findIndex(([datasetId, update]) =>
      datasetId === 'ds-header' && JSON.stringify(update?.columns) === JSON.stringify(renamedColumns)
    )
    const rollbackCallIndex = updateCalls.reduce((lastIndex, [datasetId, update], index) => (
      datasetId === 'ds-header' && JSON.stringify(update?.columns) === JSON.stringify(headerDataset.columns)
        ? index
        : lastIndex
    ), -1)
    expect(forwardCallIndex).toBeGreaterThanOrEqual(0)
    expect(rollbackCallIndex).toBeGreaterThan(forwardCallIndex)
    expect(executorHarness.execute).not.toHaveBeenCalled()
    expect(undoHarness.recordGridTransaction).not.toHaveBeenCalled()
  })

  it('shows rollback failure when backend rejects column rename rollback', async () => {
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header',
      rowCount: 1,
      dataRowCount: 1,
      columnCount: 3,
      columns: [
        { id: 'col-0', name: 'Alpha', type: 'text' as const },
        { id: 'col-1', name: 'Target 1', type: 'text' as const },
        { id: 'col-2', name: 'Target 2', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]

    let capturedCopy: (() => void | Promise<void>) | null = null
    let capturedPaste: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    await waitFor(() => expect(capturedPaste).not.toBeNull())

    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-0': 'a1', 'col-1': 'x1', 'col-2': 'y1' },
    ])

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(0))
    })
    await act(async () => {
      await capturedCopy?.()
    })
    const copiedText = clipboardHarness.write.mock.calls.at(-1)?.[0] ?? ''
    clipboardHarness.read.mockResolvedValue(String(copiedText))

    dataStoreHarness.state.updateDataset.mockImplementation((datasetId: string, update: { columns?: typeof headerDataset.columns }) => {
      if (datasetId !== 'ds-header' || !update.columns) return
      const apply = (dataset: typeof headerDataset) => (
        dataset.id === datasetId ? { ...dataset, columns: update.columns ?? dataset.columns } : dataset
      )
      dataStoreHarness.state.datasets = dataStoreHarness.state.datasets.map(apply) as any
      dataStoreHarness.stateGet.datasets = dataStoreHarness.stateGet.datasets.map(apply) as any
      dataStoreHarness.state.currentDataset = apply(dataStoreHarness.state.currentDataset as typeof headerDataset) as any
      dataStoreHarness.stateGet.currentDataset = apply(dataStoreHarness.stateGet.currentDataset as typeof headerDataset) as any
    })
    tauriHarness.updateDatasetMetadata
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('rollback metadata failed'))
    executorHarness.execute.mockResolvedValueOnce({ backendSyncSucceeded: false })
    undoHarness.recordGridTransaction.mockClear()

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(1))
    })
    await act(async () => {
      await capturedPaste?.()
    })

    await waitFor(() => expect(executorHarness.execute).toHaveBeenCalledTimes(1))
    expect(debugHarness.logRuntimeDebug).toHaveBeenCalledWith(
      'grid',
      'mutation_backend_sync_failed',
      expect.objectContaining({
        datasetId: 'ds-header',
        kind: 'paste',
      })
    )
    await waitFor(() => {
      expect(toastHarness.error).toHaveBeenCalledWith('Failed to roll back column renames')
    })
    expect(executorHarness.applyDataStoreUpdate).not.toHaveBeenCalled()
    expect(undoHarness.recordGridTransaction).not.toHaveBeenCalled()
  })

  it('does not reserve auto column names while resolving blank pasted headers', async () => {
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header',
      rowCount: 1,
      dataRowCount: 1,
      columnCount: 4,
      columns: [
        { id: 'col-0', name: '', type: 'text' as const },
        { id: 'col-1', name: 'Column 3', type: 'text' as const },
        { id: 'col-2', name: 'Target', type: 'text' as const },
        { id: 'col-3', name: 'Column 4', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.state.allocateNextAutoColumnName.mockReset().mockReturnValue('Column 99')

    let capturedCopy: (() => void | Promise<void>) | null = null
    let capturedPaste: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    await waitFor(() => expect(capturedPaste).not.toBeNull())

    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-0': 'a1', 'col-1': 'x1', 'col-2': 'y1', 'col-3': 'z1' },
    ])

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(0))
    })
    await act(async () => {
      await capturedCopy?.()
    })
    const copiedText = clipboardHarness.write.mock.calls.at(-1)?.[0] ?? ''
    clipboardHarness.read.mockResolvedValue(String(copiedText))

    dataStoreHarness.state.updateDataset.mockClear()
    executorHarness.execute.mockClear()
    undoHarness.recordGridTransaction.mockClear()

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(2))
    })
    await act(async () => {
      await capturedPaste?.()
    })

    expect(dataStoreHarness.state.allocateNextAutoColumnName).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(undoHarness.recordGridTransaction).toHaveBeenCalledWith(
        'ds-header',
        expect.objectContaining({
          columnRenames: [
            { columnId: 'col-2', oldName: 'Target', newName: 'Column 5' },
          ],
        })
      )
    })
    await waitFor(() => {
      expect(executorHarness.execute).toHaveBeenCalled()
    })
    const [edits] = executorHarness.execute.mock.calls[0] as [
      Array<{ row: number; columnId: string; newValue: string }>,
    ]
    expect(edits).toEqual([
      expect.objectContaining({ row: 0, columnId: 'col-2', newValue: 'a1' }),
    ])
  })

  it('records double-click dialog rename on the grid transaction undo stack', async () => {
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header',
      rowCount: 1,
      dataRowCount: 1,
      columnCount: 2,
      columns: [
        { id: 'col-0', name: 'Original', type: 'text' as const },
        { id: 'col-1', name: 'Other', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]

    const { container } = render(<SpreadsheetView />)

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await act(async () => {
      gridHarness.latestProps?.onHeaderClicked?.(0, {
        kind: 'header',
        isDoubleClick: true,
        isEdge: false,
        preventDefault: vi.fn(),
      })
    })

    const input = await waitFor(() => {
      const element = container.querySelector('[data-testid="column-rename-dialog"] input')
      expect(element).not.toBeNull()
      return element as HTMLInputElement
    })
    fireEvent.change(input, { target: { value: 'Renamed' } })
    await act(async () => {
      fireEvent.click(screen.getByText('OK'))
    })

    await waitFor(() => {
      expect(undoHarness.recordGridTransaction).toHaveBeenCalledWith(
        'ds-header',
        expect.objectContaining({
          kind: 'rename',
          columnRenames: [
            { columnId: 'col-0', oldName: 'Original', newName: 'Renamed' },
          ],
        })
      )
    })
    expect(undoHarness.pushColumnRename).not.toHaveBeenCalled()
  })

  it('does not record dialog rename undo when backend metadata sync fails', async () => {
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header',
      rowCount: 1,
      dataRowCount: 1,
      columnCount: 2,
      columns: [
        { id: 'col-0', name: 'Original', type: 'text' as const },
        { id: 'col-1', name: 'Other', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.state.updateDataset.mockClear()
    tauriHarness.updateDatasetMetadata.mockRejectedValueOnce(new Error('metadata failed'))

    const { container } = render(<SpreadsheetView />)

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await act(async () => {
      gridHarness.latestProps?.onHeaderClicked?.(0, {
        kind: 'header',
        isDoubleClick: true,
        isEdge: false,
        preventDefault: vi.fn(),
      })
    })

    const input = await waitFor(() => {
      const element = container.querySelector('[data-testid="column-rename-dialog"] input')
      expect(element).not.toBeNull()
      return element as HTMLInputElement
    })
    fireEvent.change(input, { target: { value: 'Renamed' } })
    await act(async () => {
      fireEvent.click(screen.getByText('OK'))
    })

    await waitFor(() => {
      expect(tauriHarness.updateDatasetMetadata).toHaveBeenCalledWith(
        'ds-header',
        [
          { id: 'col-0', name: 'Renamed', type: 'text' },
          { id: 'col-1', name: 'Other', type: 'text' },
        ]
      )
    })
    const updateDatasetCalls = dataStoreHarness.state.updateDataset.mock.calls
    const forwardIndex = updateDatasetCalls.findIndex(([datasetId, payload]) =>
      datasetId === 'ds-header' &&
      JSON.stringify(payload) === JSON.stringify({
        columns: [
          { id: 'col-0', name: 'Renamed', type: 'text' },
          { id: 'col-1', name: 'Other', type: 'text' },
        ],
      })
    )
    const rollbackIndex = updateDatasetCalls.findIndex(([datasetId, payload]) =>
      datasetId === 'ds-header' &&
      JSON.stringify(payload) === JSON.stringify({ columns: headerDataset.columns })
    )
    expect(forwardIndex).toBeGreaterThanOrEqual(0)
    expect(rollbackIndex).toBeGreaterThan(forwardIndex)
    expect(undoHarness.recordGridTransaction).not.toHaveBeenCalled()
    expect(appStoreHarness.s.setProjectDirty).not.toHaveBeenCalled()
    expect(toastHarness.error).toHaveBeenCalledWith('Failed to rename column. Please try again.')
  })

  it('renames the originally opened column when column positions shift while the dialog is open', async () => {
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header',
      rowCount: 1,
      dataRowCount: 1,
      columnCount: 2,
      columns: [
        { id: 'col-0', name: 'Original', type: 'text' as const },
        { id: 'col-1', name: 'Other', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]

    const { container, rerender } = render(<SpreadsheetView />)

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await act(async () => {
      gridHarness.latestProps?.onHeaderClicked?.(0, {
        kind: 'header',
        isDoubleClick: true,
        isEdge: false,
        preventDefault: vi.fn(),
      })
    })

    const shiftedDataset = {
      ...headerDataset,
      columnCount: 3,
      columns: [
        { id: 'col-new', name: 'Inserted', type: 'text' as const },
        { id: 'col-0', name: 'Externally renamed', type: 'text' as const },
        { id: 'col-1', name: 'Other', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = shiftedDataset as any
    dataStoreHarness.state.datasets = [shiftedDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = shiftedDataset as any
    dataStoreHarness.stateGet.datasets = [shiftedDataset as any, dataStoreHarness.ds2]
    await act(async () => {
      rerender(<SpreadsheetView />)
    })
    dataStoreHarness.state.updateDataset.mockClear()
    undoHarness.recordGridTransaction.mockClear()

    const input = await waitFor(() => {
      const element = container.querySelector('[data-testid="column-rename-dialog"] input')
      expect(element).not.toBeNull()
      return element as HTMLInputElement
    })
    fireEvent.change(input, { target: { value: 'Renamed' } })
    await act(async () => {
      fireEvent.click(screen.getByText('OK'))
    })

    await waitFor(() => {
      expect(dataStoreHarness.state.updateDataset).toHaveBeenCalledWith('ds-header', {
        columns: [
          { id: 'col-new', name: 'Inserted', type: 'text' },
          { id: 'col-0', name: 'Renamed', type: 'text' },
          { id: 'col-1', name: 'Other', type: 'text' },
        ],
      })
    })
    expect(undoHarness.recordGridTransaction).toHaveBeenCalledWith(
      'ds-header',
      expect.objectContaining({
        columnRenames: [
          { columnId: 'col-0', oldName: 'Original', newName: 'Renamed' },
        ],
      })
    )
  })

  it('keeps undo and redo shortcuts inside the rename input', async () => {
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header',
      rowCount: 1,
      dataRowCount: 1,
      columnCount: 1,
      columns: [
        { id: 'col-0', name: 'Original', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]

    const windowKeyDown = vi.fn()
    window.addEventListener('keydown', windowKeyDown)
    try {
      const { container } = render(<SpreadsheetView />)

      await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
      await act(async () => {
        gridHarness.latestProps?.onHeaderClicked?.(0, {
          kind: 'header',
          isDoubleClick: true,
          isEdge: false,
          preventDefault: vi.fn(),
        })
      })

      const input = await waitFor(() => {
        const element = container.querySelector('[data-testid="column-rename-dialog"] input')
        expect(element).not.toBeNull()
        return element as HTMLInputElement
      })

      fireEvent.keyDown(input, { key: 'z', ctrlKey: true })
      fireEvent.keyDown(input, { key: 'Z', ctrlKey: true, shiftKey: true })
      fireEvent.keyDown(input, { key: 'y', ctrlKey: true })
      fireEvent.keyDown(input, { key: 'z', metaKey: true })
      fireEvent.keyDown(input, { key: 'Z', metaKey: true, shiftKey: true })
      fireEvent.keyDown(input, { key: 'y', metaKey: true })

      expect(windowKeyDown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeyDown)
    }
  })

  it('does not rename headers when the clipboard no longer matches the copied header context', async () => {
    const headerDataset = {
      ...dataStoreHarness.ds1,
      id: 'ds-header',
      rowCount: 1,
      dataRowCount: 1,
      columnCount: 3,
      columns: [
        { id: 'col-0', name: 'Alpha', type: 'text' as const },
        { id: 'col-1', name: 'Target 1', type: 'text' as const },
        { id: 'col-2', name: 'Target 2', type: 'text' as const },
      ],
    }
    dataStoreHarness.state.currentDataset = headerDataset as any
    dataStoreHarness.state.datasets = [headerDataset as any, dataStoreHarness.ds2]
    dataStoreHarness.stateGet.currentDataset = headerDataset as any
    dataStoreHarness.stateGet.datasets = [headerDataset as any, dataStoreHarness.ds2]

    let capturedCopy: (() => void | Promise<void>) | null = null
    let capturedPaste: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    await waitFor(() => expect(capturedPaste).not.toBeNull())

    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-0': 'a1', 'col-1': 'x1', 'col-2': 'y1' },
    ])

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(0))
    })
    await act(async () => {
      await capturedCopy?.()
    })
    await waitFor(() => {
      expect(clipboardHarness.write).toHaveBeenCalledWith('Alpha\na1')
    })

    clipboardHarness.read.mockResolvedValue('external\tclipboard')
    dataStoreHarness.state.updateDataset.mockClear()
    tauriHarness.updateDatasetMetadata.mockClear()
    undoHarness.pushColumnRename.mockClear()
    executorHarness.execute.mockClear()

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeColumnHeaderSelection(1))
    })
    await act(async () => {
      await capturedPaste?.()
    })

    expect(dataStoreHarness.state.updateDataset).not.toHaveBeenCalled()
    expect(tauriHarness.updateDatasetMetadata).not.toHaveBeenCalled()
    expect(undoHarness.pushColumnRename).not.toHaveBeenCalled()
    expect(executorHarness.execute).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// PLUS_ANCHOR: paste anchor is on virtual + column
// ---------------------------------------------------------------------------

describe('SpreadsheetView paste — PLUS_ANCHOR', () => {
  it('blocks paste with a warning when anchor cell is on the virtual + column', async () => {
    // ds1 has 2 real columns (indices 0 and 1); virtual "+" is at index 2.
    // Moving selection to col 2 and pasting should produce a toast.warning with no execute.
    clipboardHarness.read.mockResolvedValue('a\tb')

    const { triggerPaste } = await mountAndCapturePaste()

    // Shift selection anchor to the virtual "+" column (col index = editableColumns.length = 2)
    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeSelection(2, 0))
    })

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    expect(toastHarness.warning).toHaveBeenCalled()
    expect(executorHarness.execute).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// INVALID_TYPED_PASTE: invalid text into numeric column is blocked pre-mutation
// ---------------------------------------------------------------------------

describe('SpreadsheetView paste — INVALID_TYPED_PASTE', () => {
  it('rejects invalid text pasted into a numeric column before execute, backend flush, or column expansion', async () => {
    const numericDataset = {
      ...dataStoreHarness.ds1,
      columns: dataStoreHarness.ds1.columns.map((column, index) => ({
        ...column,
        type: index === 0 ? ('numeric' as const) : column.type,
      })),
    } as any
    dataStoreHarness.state.currentDataset = numericDataset
    dataStoreHarness.state.datasets = [numericDataset, dataStoreHarness.ds2] as any
    dataStoreHarness.stateGet.currentDataset = numericDataset
    dataStoreHarness.stateGet.datasets = [numericDataset, dataStoreHarness.ds2] as any

    dataStoreHarness.state.allocateNextAutoColumnName
      .mockReset()
      .mockReturnValueOnce('Col-3')

    clipboardHarness.read.mockResolvedValue('Temp_6\tstill-text\tnew-column')

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    expect(toastHarness.error).toHaveBeenCalledWith('Cannot paste text into numeric column "Column 1".')
    expect(executorHarness.execute).not.toHaveBeenCalled()
    expect(cacheHarness.flushOverlay).not.toHaveBeenCalled()
    expect(cacheHarness.addColumn).not.toHaveBeenCalled()
    expect(dataStoreHarness.state.insertColumnAtDataset).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// COLUMN_EXPANSION: real column overflow branch
// ---------------------------------------------------------------------------

describe('SpreadsheetView paste — COLUMN_EXPANSION', () => {
  it('adds overflow columns and emits column expansion timing markers', async () => {
    dataStoreHarness.state.allocateNextAutoColumnName
      .mockReset()
      .mockReturnValueOnce('Col-3')
    clipboardHarness.read.mockResolvedValue('a\tb\tc')

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => {
      expect(executorHarness.execute).toHaveBeenCalled()
    })

    expect(cacheHarness.addColumn).toHaveBeenCalledTimes(1)
    expect(dataStoreHarness.state.insertColumnAtDataset).toHaveBeenCalledTimes(1)

    const events = debugHarness.logRuntimeDebug.mock.calls
      .filter(([scope]) => scope === 'paste')
      .map(([, event]) => event)

    expect(events).toContain('paste_column_expand_start')
    expect(events).toContain('paste_column_expand_done')
    expect(events.indexOf('paste_preflight_done')).toBeLessThan(events.indexOf('paste_column_expand_start'))
    expect(events.indexOf('paste_column_expand_start')).toBeLessThan(events.indexOf('paste_column_expand_done'))
    expect(events.indexOf('paste_column_expand_done')).toBeLessThan(events.indexOf('paste_transaction_build_done'))

    const columnExpandDoneCall = debugHarness.logRuntimeDebug.mock.calls.find(
      ([scope, event]) => scope === 'paste' && event === 'paste_column_expand_done'
    )
    expect(columnExpandDoneCall?.[2]).toMatchObject({
      datasetId: 'ds-1',
      columnsToInsert: 1,
    })
    expect(typeof columnExpandDoneCall?.[2]?.durationMs).toBe('number')
  })

  it('does not commit overflow columns when async paste edit building aborts', async () => {
    dataStoreHarness.state.allocateNextAutoColumnName
      .mockReset()
      .mockReturnValueOnce('Col-3')
    clipboardHarness.read.mockResolvedValue('a\tb\tc')
    pasteEditBuilderHarness.buildPasteEditsInChunks = vi.fn(async (input: any) => {
      expect(input.columns).toHaveLength(3)
      return { edits: [], aborted: true }
    })

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => {
      expect(pasteEditBuilderHarness.buildPasteEditsInChunks).toHaveBeenCalled()
    })
    expect(cacheHarness.addColumn).not.toHaveBeenCalled()
    expect(dataStoreHarness.state.insertColumnAtDataset).not.toHaveBeenCalled()
    expect(executorHarness.execute).not.toHaveBeenCalled()
  })

  it('rolls back overflow columns when paste context dies during column expansion', async () => {
    dataStoreHarness.state.allocateNextAutoColumnName
      .mockReset()
      .mockReturnValueOnce('Col-3')
    clipboardHarness.read.mockResolvedValue('a\tb\tc')
    cacheHarness.addColumn.mockImplementationOnce(async () => {
      await act(async () => {
        gridHarness.latestProps?.onGridSelectionChange?.(makeSelection(0, 1))
      })
    })

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => {
      expect(cacheHarness.addColumn).toHaveBeenCalledTimes(1)
    })
    expect(cacheHarness.removeColumn).toHaveBeenCalledTimes(1)
    expect(dataStoreHarness.state.rollbackAutoColumnNameAllocation).toHaveBeenCalledWith('ds-1', 'Col-3')
    expect(dataStoreHarness.state.insertColumnAtDataset).not.toHaveBeenCalled()
    expect(executorHarness.execute).not.toHaveBeenCalled()
  })

  it('keeps unloaded placeholder rows marked after column expansion so later copy fetches backend rows', async () => {
    dataStoreHarness.state.allocateNextAutoColumnName
      .mockReset()
      .mockReturnValueOnce('Col-3')
    clipboardHarness.read.mockResolvedValue('a\tb\tc')

    let capturedCopy: (() => void | Promise<void>) | null = null
    let capturedPaste: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    await waitFor(() => expect(capturedPaste).not.toBeNull())

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeSelection(0, 0))
    })

    await act(async () => {
      void capturedPaste?.()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => {
      expect(dataStoreHarness.state.insertColumnAtDataset).toHaveBeenCalledTimes(1)
    })

    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([{ 'col-0': 'backend value' }])

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeSelection(0, 1))
    })

    await act(async () => {
      void capturedCopy?.()
      for (let i = 0; i < 15; i++) await Promise.resolve()
    })

    expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 1, 2)
    expect(clipboardHarness.write).toHaveBeenCalledWith('backend value')
  })

  it('allows one recovery reload for an overlay-backed placeholder row and then stops while backend convergence is empty', async () => {
    clipboardHarness.read.mockResolvedValue('pasted')

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => {
      expect(executorHarness.applyDataStoreUpdate).toHaveBeenCalled()
    })

    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValue([])

    act(() => {
      gridHarness.latestProps?.getCellContent?.([1, 0])
    })

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 0, 3)
    })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
      await Promise.resolve()
    })

    await act(async () => {
      gridHarness.latestProps?.getCellContent?.([1, 0])
      await new Promise(resolve => setTimeout(resolve, 0))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(cacheHarness.getRowsHybrid).toHaveBeenCalledTimes(2)
    })

    await act(async () => {
      gridHarness.latestProps?.getCellContent?.([1, 0])
      await new Promise(resolve => setTimeout(resolve, 0))
      await Promise.resolve()
    })

    expect(cacheHarness.getRowsHybrid).toHaveBeenCalledTimes(2)
  })

  it('copies the pasted value after pasting into an unloaded placeholder row', async () => {
    clipboardHarness.read.mockResolvedValue('pasted')
    let capturedCopy: (() => void | Promise<void>) | null = null
    let capturedPaste: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
        onPasteRequest={fn => { capturedPaste = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    await waitFor(() => expect(capturedPaste).not.toBeNull())

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeSelection(0, 0))
    })

    await act(async () => {
      void capturedPaste?.()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    await waitFor(() => {
      expect(executorHarness.applyDataStoreUpdate).toHaveBeenCalled()
    })

    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValue([])

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.(makeSelection(0, 0))
    })

    await act(async () => {
      void capturedCopy?.()
      for (let i = 0; i < 15; i++) await Promise.resolve()
    })

    expect(cacheHarness.getRowsHybrid).not.toHaveBeenCalled()
    expect(toastHarness.warning).not.toHaveBeenCalled()
    expect(clipboardHarness.write).toHaveBeenCalledWith('pasted')
  })
})

// ---------------------------------------------------------------------------
// CUT_UNLOADED: cut aborts when selected rows are not in the in-memory cache
// ---------------------------------------------------------------------------

describe('SpreadsheetView cut — CUT_UNLOADED', () => {
  it('aborts cut with a warning when selected rows are not loaded in the in-memory row cache', async () => {
    // Same scenario as COPY_UNLOADED but for the cut handler:
    // rowDataRef is empty → cut should warn and NOT write to clipboard or execute edits.
    let capturedCut: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCutRequest={fn => { capturedCut = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCut).not.toBeNull())

    // Select 3 rows × 1 col — all data rows, none loaded in rowDataRef
    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.({
        current: {
          cell: [0, 0] as [number, number],
          range: { x: 0, y: 0, width: 1, height: 3 },
          rangeStack: [],
        },
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
      })
    })

    await act(async () => {
      void capturedCut?.()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    expect(toastHarness.warning).toHaveBeenCalled()
    expect(clipboardHarness.write).not.toHaveBeenCalled()
    expect(executorHarness.execute).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// CUT_BACKEND: cut with unloaded rows fetches from getRowsHybrid and clears cells
// ---------------------------------------------------------------------------

describe('SpreadsheetView cut — CUT_BACKEND', () => {
  it('fetches unloaded rows from backend, writes clipboard, and executes clear edits instead of aborting', async () => {
    // Mirrors COPY_BACKEND but for cut: unloaded rows must trigger a backend fetch,
    // clipboard.write must receive the backend data, and executor.execute must be called
    // with clear edits (newValue: '') so the cut actually deletes from the sheet.
    let capturedCut: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCutRequest={fn => { capturedCut = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCut).not.toBeNull())
    for (let i = 0; i < 20; i++) await Promise.resolve()

    // Arm backend — AFTER init so only the cut handler's fetch consumes it.
    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-0': 'alpha' },
      { 'col-0': 'beta' },
      { 'col-0': 'gamma' },
    ])

    // Select rows 0–2 × col 0 — all data rows, all unloaded in rowDataRef
    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.({
        current: {
          cell: [0, 0] as [number, number],
          range: { x: 0, y: 0, width: 1, height: 3 },
          rangeStack: [],
        },
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
      })
    })

    await act(async () => {
      void capturedCut?.()
      for (let i = 0; i < 15; i++) await Promise.resolve()
    })

    // No warning — backend path succeeds
    expect(toastHarness.warning).not.toHaveBeenCalled()
    // Backend was fetched for the correct row range
    expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 0, 3)
    // Clipboard received the correct content from backend rows
    expect(clipboardHarness.write).toHaveBeenCalledWith('alpha\nbeta\ngamma')
    // Executor was called with clear edits (cut must actually delete the cells)
    expect(executorHarness.execute).toHaveBeenCalledOnce()
    const [edits, source] = executorHarness.execute.mock.calls[0] as [{ row: number; newValue: string; oldValue: unknown }[], string]
    expect(source).toBe('cut')
    expect(edits.every(e => e.newValue === '')).toBe(true)
    // oldValue must come from backend data, not the empty rowDataRef cache.
    // Without this, undo restores null instead of the original cell value.
    const expectedOldValues = ['alpha', 'beta', 'gamma']
    expect(edits.map(e => e.oldValue)).toEqual(expectedOldValues)
  })
})

// ---------------------------------------------------------------------------
// COPY_UNLOADED: copy aborts when selected rows are not in the in-memory cache
// ---------------------------------------------------------------------------

describe('SpreadsheetView copy — COPY_UNLOADED', () => {
  it('aborts copy with a warning when selected rows are not loaded in the in-memory row cache', async () => {
    // ds1 has 3 data rows but getRowsHybrid returns [] → rowDataRef stays empty.
    // A copy selecting rows 0–2 should warn and NOT write to clipboard, because
    // those rows have never been loaded into rowDataRef and copying them would
    // silently commit 3 rows of blank strings to the clipboard (and later to DuckDB
    // if pasted). This is the "blank-overwrite" bug.
    let capturedCopy: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())

    // Select 3 rows × 1 col — all data rows, none loaded in rowDataRef
    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.({
        current: {
          cell: [0, 0] as [number, number],
          range: { x: 0, y: 0, width: 1, height: 3 },
          rangeStack: [],
        },
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
      })
    })

    await act(async () => {
      void capturedCopy?.()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    // Guard must fire a warning — not silently copy blanks
    expect(toastHarness.warning).toHaveBeenCalled()
    // clipboard.write must NOT be called — no blank data on clipboard
    expect(clipboardHarness.write).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// COPY_UNDEFINED_DATAROWCOUNT: guard fires even when dataRowCount is absent
// ---------------------------------------------------------------------------

describe('SpreadsheetView copy — COPY_UNDEFINED_DATAROWCOUNT', () => {
  it('aborts copy with a warning when dataset.dataRowCount is undefined and rows are unloaded', async () => {
    // Older/migrated datasets may have dataRowCount === undefined.
    // The guard `modelRow < currentDataset.dataRowCount` evaluates to false
    // when dataRowCount is undefined (NaN comparison), silently bypassing the
    // unloaded-row check. The fix must use resolveDataRowCount() instead.
    const dsWithoutDataRowCount = {
      ...dataStoreHarness.ds1,
      dataRowCount: undefined as unknown as number,
    }
    dataStoreHarness.state.currentDataset = dsWithoutDataRowCount as any
    dataStoreHarness.stateGet.currentDataset = dsWithoutDataRowCount as any

    let capturedCopy: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())

    // Select 3 rows × 1 col — all data rows, none loaded in rowDataRef
    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.({
        current: {
          cell: [0, 0] as [number, number],
          range: { x: 0, y: 0, width: 1, height: 3 },
          rangeStack: [],
        },
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
      })
    })

    await act(async () => {
      void capturedCopy?.()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    expect(toastHarness.warning).toHaveBeenCalled()
    expect(clipboardHarness.write).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// COPY_BACKEND: copy with unloaded rows fetches from getRowsHybrid instead of aborting
// ---------------------------------------------------------------------------

describe('SpreadsheetView copy — COPY_BACKEND', () => {
  it('fetches unloaded rows from backend and writes correct clipboard text instead of aborting', async () => {
    // Strategy: mount with getRowsHybrid returning [] (default from beforeEach) so that
    // any init pre-loading calls populate rowDataRef with nothing. Only AFTER mount
    // settles do we arm getRowsHybrid with real row data — this ensures the
    // mockResolvedValueOnce is consumed exclusively by the copy handler's backend fetch,
    // not by an init effect.
    let capturedCopy: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
      />
    )

    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    // Flush any async init effects (viewport loads, storageInfo fetch, etc.)
    // All return [] from beforeEach reset → rowDataRef stays empty.
    for (let i = 0; i < 20; i++) await Promise.resolve()

    // Arm backend response AFTER init — only the copy-triggered call sees this data.
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-0': 'alpha', 'col-1': 'x' },
      { 'col-0': 'beta',  'col-1': 'y' },
      { 'col-0': 'gamma', 'col-1': 'z' },
    ])
    // Reset call history so we can assert specifically on copy-triggered calls.
    cacheHarness.getRowsHybrid.mockClear()
    // Re-arm (mockClear wipes mockReturnValue but not mockResolvedValueOnce queue on some versions)
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-0': 'alpha', 'col-1': 'x' },
      { 'col-0': 'beta',  'col-1': 'y' },
      { 'col-0': 'gamma', 'col-1': 'z' },
    ])

    // Select rows 0–2 × col 0 — all data rows, all unloaded in rowDataRef
    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.({
        current: {
          cell: [0, 0] as [number, number],
          range: { x: 0, y: 0, width: 1, height: 3 },
          rangeStack: [],
        },
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
      })
    })

    await act(async () => {
      void capturedCopy?.()
      for (let i = 0; i < 15; i++) await Promise.resolve()
    })

    // No warning — backend path succeeds
    expect(toastHarness.warning).not.toHaveBeenCalled()
    // The copy handler called getRowsHybrid for the exact model-row range
    expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 0, 3)
    // clipboard received the correct tab-separated text from backend rows
    expect(clipboardHarness.write).toHaveBeenCalledWith('alpha\nbeta\ngamma')
  })

  it('uses correct model-row offset when selection does not start at row 0 (non-zero minRow)', async () => {
    // Regression for the modelRow - minRow index calculation.
    // If selection covers view rows 1–2 (not starting at 0), the backend fetch window
    // is getRowsHybrid(ds, 1, 3). The result array is indexed 0-based from minRow,
    // so modelRow 1 → backendRows[0] and modelRow 2 → backendRows[1].
    // A bug here would either call getRowsHybrid with wrong bounds or read the wrong
    // array slot, producing blank or wrong cell values in the clipboard.
    let capturedCopy: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
      />
    )
    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    for (let i = 0; i < 20; i++) await Promise.resolve()

    // Arm backend to return rows 1-2 (ds-1 has model rows 0,1,2)
    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-0': 'row1', 'col-1': 'x' },
      { 'col-0': 'row2', 'col-1': 'y' },
    ])

    // Select rows y=1 height=2 (view rows 1 and 2, which map to model rows 1 and 2)
    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.({
        current: {
          cell: [0, 1] as [number, number],
          range: { x: 0, y: 1, width: 1, height: 2 },
          rangeStack: [],
        },
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
      })
    })

    await act(async () => {
      void capturedCopy?.()
      for (let i = 0; i < 15; i++) await Promise.resolve()
    })

    // Backend must be called with the exact model-row window [1, 3)
    expect(cacheHarness.getRowsHybrid).toHaveBeenCalledWith('ds-1', 1, 3)
    // Clipboard must contain the two rows' data in the correct order (offset correctly applied)
    expect(clipboardHarness.write).toHaveBeenCalledWith('row1\nrow2')
    expect(toastHarness.warning).not.toHaveBeenCalled()
  })

  it('does not write clipboard when backend returns fewer rows than selected (partial response)', async () => {
    // Completeness-check regression test: if getRowsHybrid returns 2 rows for a
    // 3-row selection, the handler must warn + abort rather than writing 2 real rows
    // and 1 blank row to the clipboard.
    let capturedCopy: (() => void | Promise<void>) | null = null
    render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
      />
    )
    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    for (let i = 0; i < 20; i++) await Promise.resolve()

    // Only 2 rows returned for a 3-row range — truncated/partial response.
    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockResolvedValueOnce([
      { 'col-0': 'alpha', 'col-1': 'x' },
      { 'col-0': 'beta',  'col-1': 'y' },
      // row index 2 intentionally missing
    ])

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.({
        current: {
          cell: [0, 0] as [number, number],
          range: { x: 0, y: 0, width: 1, height: 3 },
          rangeStack: [],
        },
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
      })
    })

    await act(async () => {
      void capturedCopy?.()
      for (let i = 0; i < 15; i++) await Promise.resolve()
    })

    // Completeness check fires — partial response must not reach clipboard
    expect(toastHarness.warning).toHaveBeenCalled()
    expect(clipboardHarness.write).not.toHaveBeenCalled()
  })

  it('does not write clipboard when active dataset changes while getRowsHybrid is in flight', async () => {
    // Stale-guard regression: if the user switches datasets while the backend fetch
    // is pending, the handler must discard the fetched rows and NOT write stale data
    // from the old dataset to the clipboard.
    let capturedCopy: (() => void | Promise<void>) | null = null
    let resolveBackend!: (rows: Record<string, unknown>[]) => void
    cacheHarness.getRowsHybrid.mockReturnValueOnce(
      new Promise<Record<string, unknown>[]>(resolve => { resolveBackend = resolve })
    )

    const { rerender } = render(
      <SpreadsheetView
        onCopyRequest={fn => { capturedCopy = fn }}
      />
    )
    await waitFor(() => expect(gridHarness.latestProps).not.toBeNull())
    await waitFor(() => expect(capturedCopy).not.toBeNull())
    for (let i = 0; i < 20; i++) await Promise.resolve()

    // Re-arm with a deferred promise AFTER init settles
    cacheHarness.getRowsHybrid.mockClear()
    cacheHarness.getRowsHybrid.mockReturnValueOnce(
      new Promise<Record<string, unknown>[]>(resolve => { resolveBackend = resolve })
    )

    await act(async () => {
      gridHarness.latestProps?.onGridSelectionChange?.({
        current: {
          cell: [0, 0] as [number, number],
          range: { x: 0, y: 0, width: 1, height: 3 },
          rangeStack: [],
        },
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
      })
    })

    // Start copy — suspends at getRowsHybrid (waitFor above proved non-null)
    void capturedCopy!()
    await Promise.resolve()

    // Switch active dataset while backend fetch is in flight
    await act(async () => {
      dataStoreHarness.state.currentDataset = dataStoreHarness.ds2
      dataStoreHarness.stateGet.currentDataset = dataStoreHarness.ds2
      rerender(
        <SpreadsheetView
          onCopyRequest={fn => { void fn }}
        />
      )
    })

    // Resolve the backend fetch with ds1 data — handler must discard it
    await act(async () => {
      resolveBackend([
        { 'col-0': 'alpha', 'col-1': 'x' },
        { 'col-0': 'beta',  'col-1': 'y' },
        { 'col-0': 'gamma', 'col-1': 'z' },
      ])
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    expect(clipboardHarness.write).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// FAMILY_BIND: family binding uses captured familyId at paste start
// ---------------------------------------------------------------------------

describe('SpreadsheetView paste — FAMILY_BIND', () => {
  it('captured family survives row-expansion: binding uses start-time family even when paste triggers row growth', async () => {
    // Regression: paste that overflows rows triggers updateDataset (expansion) mid-handler.
    // If the expansion path accidentally re-reads state.activeFamilyId instead of the
    // captured value, a mid-paste family switch corrupts the binding.
    //
    // Clipboard has 4 rows; ds-1 has rowCount=3 → rowOverflow=1 → decidePasteOverflow
    // returns 'expand' (default mock) → updateDataset fires before updateActiveFamilyData.
    // Family must still be bound to the captured 'fam-1', not the switched 'fam-2'.

    let resolveClipboard!: (text: string) => void
    clipboardHarness.read.mockReturnValue(
      new Promise<string>(resolve => { resolveClipboard = resolve })
    )

    const { triggerPaste } = await mountAndCapturePaste({ trackActiveFamilyData: true })

    // Start paste — captures capturedFamilyId = 'fam-1'
    triggerPaste()
    await Promise.resolve()

    // Switch active family while clipboard.read is in flight
    appStoreHarness.s.activeFamilyId = 'fam-2'

    // Resolve with 4-row payload → overflow by 1 against ds-1's rowCount=3
    await act(async () => {
      resolveClipboard('r1c1\nr2c1\nr3c1\nr4c1')
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    // Expansion paste must have executed
    expect(executorHarness.execute).toHaveBeenCalled()

    // Family binding must use captured 'fam-1' despite mid-paste switch to 'fam-2'
    expect(appStoreHarness.s.updateActiveFamilyData).toHaveBeenCalledWith('ds-1', 'fam-1')
    expect(appStoreHarness.s.updateActiveFamilyData).not.toHaveBeenCalledWith('ds-1', 'fam-2')
  })

  it('binds the dataset to the family that was active when paste started, not when it completed', async () => {
    // Race: user starts a paste in Family A, switches to Family B while clipboard.read
    // is in flight, then the paste completes. updateActiveFamilyData must receive the
    // family that was active at paste START ('fam-1'), not at completion ('fam-2').
    //
    // Today it is never called from the paste handler directly (only via the mocked
    // executor, which does nothing). After the fix, the paste handler explicitly calls
    // useAppStore.getState().updateActiveFamilyData(capturedDatasetId, capturedFamilyId),
    // guaranteeing deterministic binding regardless of mid-paste family switches.

    let resolveClipboard!: (text: string) => void
    clipboardHarness.read.mockReturnValue(
      new Promise<string>(resolve => { resolveClipboard = resolve })
    )

    const { triggerPaste } = await mountAndCapturePaste({ trackActiveFamilyData: true })

    // Start paste — captures capturedFamilyId = 'fam-1'
    triggerPaste()
    await Promise.resolve()

    // Switch active family while clipboard.read is in flight.
    // Dataset stays the same (ds-1), so the dataset stale guard won't fire.
    appStoreHarness.s.activeFamilyId = 'fam-2'

    // Resolve clipboard — paste resumes
    await act(async () => {
      resolveClipboard('hello\tworld')
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    // Paste must have executed (dataset stale guard did not fire)
    expect(executorHarness.execute).toHaveBeenCalled()

    // Family binding must use captured 'fam-1', not current 'fam-2'
    expect(appStoreHarness.s.updateActiveFamilyData).toHaveBeenCalledWith('ds-1', 'fam-1')
  })
})

// ---------------------------------------------------------------------------
// ROW_OVERFLOW_BACKEND: backend row-capacity expansion before overlay writes
// ---------------------------------------------------------------------------

describe('SpreadsheetView paste — ROW_OVERFLOW_BACKEND', () => {
  it('does not physically insert rows when padded grid rowCount already covers the paste bounds', async () => {
    dataStoreHarness.ds1.rowCount = 100
    dataStoreHarness.ds1.dataRowCount = 3
    dataStoreHarness.ds1.columnCount = 2
    dataStoreHarness.state.currentDataset = dataStoreHarness.ds1
    dataStoreHarness.stateGet.currentDataset = dataStoreHarness.ds1

    const backendRows: Array<Record<string, unknown>> = [
      { 'col-0': 'old-r1' },
      { 'col-0': 'old-r2' },
      { 'col-0': 'old-r3' },
    ]
    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, endExclusive: number) => {
      return backendRows.slice(start, endExclusive)
    })
    cacheHarness.insertRowsAt.mockImplementation(async (_datasetId: string, rowIndex: number, count: number) => {
      for (let offset = 0; offset < count; offset += 1) {
        const target = rowIndex + offset
        if (!backendRows[target]) backendRows[target] = {}
      }
      return backendRows.length + count
    })
    clipboardHarness.read.mockResolvedValue('r1\nr2\nr3\nr4')

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    expect(cacheHarness.insertRowsAt).not.toHaveBeenCalled()
    expect(cacheHarness.appendRows).not.toHaveBeenCalled()
    expect(dataStoreHarness.state.insertRowsAtDataset).not.toHaveBeenCalled()
    expect(dataStoreHarness.stateGet.updateDataset).toHaveBeenCalledWith('ds-1', {
      dataRowCount: 4,
    })
    const decisionCall = debugHarness.logRuntimeDebug.mock.calls.find(
      ([scope, event]) => scope === 'paste' && event === 'paste_expand_decision'
    )
    expect(decisionCall?.[2]).toMatchObject({
      rowCount: 100,
      dataRowCount: 3,
      requiredRowCount: 4,
      rowOverflow: 0,
      needsDataRowExpansion: true,
      shouldPhysicallyExpandRows: false,
    })
    expect(cacheHarness.insertRowAt).not.toHaveBeenCalled()
    expect(executorHarness.execute).toHaveBeenCalled()
  })

  it('appends backend rows before executing paste edits, and supports backend read-back of overflow rows', async () => {
    // ds1 has rowCount=3 (dataRowCount=3), backend also has 3 rows.
    // Paste 4 rows → requiredRowCount=4, rowOverflow=1, decidePasteOverflow='expand'.
    // Runtime paste must append one backend row without shifting existing row indexes,
    // then executor.execute must run (paste completes).
    const backendRows: Array<Record<string, unknown>> = [
      { 'col-0': 'old-r1' },
      { 'col-0': 'old-r2' },
      { 'col-0': 'old-r3' },
    ]

    cacheHarness.getRowsHybrid.mockImplementation(async (_datasetId: string, start: number, endExclusive: number) => {
      return backendRows.slice(start, endExclusive)
    })
    cacheHarness.appendRows.mockImplementation(async (_datasetId: string, count: number) => {
      const rowIndex = backendRows.length
      for (let offset = 0; offset < count; offset += 1) {
        const target = rowIndex + offset
        if (!backendRows[target]) backendRows[target] = {}
      }
      return backendRows.length
    })
    executorHarness.execute.mockImplementationOnce(async (edits: Array<{ row: number; newValue: string }>) => {
      for (const edit of edits) {
        if (!backendRows[edit.row]) backendRows[edit.row] = {}
        backendRows[edit.row]!['col-0'] = edit.newValue
      }
    })
    clipboardHarness.read.mockResolvedValue('r1\nr2\nr3\nr4') // 4 rows → overflow by 1

    const { triggerPaste } = await mountAndCapturePaste()
    cacheHarness.getRowsHybrid.mockClear()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    // Backend row expansion must have run before paste executed, without physical row shifting.
    expect(cacheHarness.appendRows).toHaveBeenCalledTimes(1)
    expect(cacheHarness.appendRows).toHaveBeenCalledWith('ds-1', 1)
    expect(cacheHarness.insertRowsAt).not.toHaveBeenCalled()
    expect(dataStoreHarness.state.insertRowsAtDataset).toHaveBeenCalledWith('ds-1', 3, 1)
    expect(cacheHarness.insertRowAt).not.toHaveBeenCalled()
    expect(executorHarness.execute).toHaveBeenCalled()

    // Read-back: overflow row value must be retrievable from backend-range reads.
    // This prevents false confidence from write-only assertions.
    const reloaded = await cacheHarness.getRowsHybrid('ds-1', 0, 4)
    expect(reloaded).toHaveLength(4)
    expect(reloaded.map((r: Record<string, unknown>) => r['col-0'])).toEqual(['r1', 'r2', 'r3', 'r4'])
  })

  it('paste that fits within capacity does not call insertRowsAt', async () => {
    // ds1 has rowCount=3; paste only 2 rows → no overflow, no backend expansion needed.
    clipboardHarness.read.mockResolvedValue('r1\nr2') // 2 rows, fits in 3-row capacity

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    expect(cacheHarness.insertRowsAt).not.toHaveBeenCalled()
    expect(cacheHarness.appendRows).not.toHaveBeenCalled()
    expect(cacheHarness.insertRowAt).not.toHaveBeenCalled()
    expect(executorHarness.execute).toHaveBeenCalled()
  })

  it('emits the overflow paste stage markers in order for batch expansion', async () => {
    clipboardHarness.read.mockResolvedValue('r1\nr2\nr3\nr4')

    const { triggerPaste } = await mountAndCapturePaste()

    await act(async () => {
      triggerPaste()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })

    const events = debugHarness.logRuntimeDebug.mock.calls
      .filter(([scope]) => scope === 'paste')
      .map(([, event]) => event)

    expect(events).toContain('paste_clipboard_read_done')
    expect(events).toContain('paste_preflight_done')
    expect(events).toContain('paste_expand_decision')
    expect(events).toContain('paste_row_expand_start')
    expect(events).toContain('paste_row_expand_done')
    expect(events).toContain('paste_transaction_build_done')
    expect(events).toContain('paste_apply_mutation_start')
    expect(events).toContain('paste_apply_mutation_done')
    expect(events).toContain('paste_execute_done')

    const indexOf = (event: string) => events.indexOf(event)
    expect(indexOf('paste_clipboard_read_done')).toBeLessThan(indexOf('paste_preflight_done'))
    expect(indexOf('paste_preflight_done')).toBeLessThan(indexOf('paste_expand_decision'))
    expect(indexOf('paste_expand_decision')).toBeLessThan(indexOf('paste_row_expand_start'))
    expect(indexOf('paste_row_expand_start')).toBeLessThan(indexOf('paste_row_expand_done'))
    expect(indexOf('paste_row_expand_done')).toBeLessThan(indexOf('paste_transaction_build_done'))
    expect(indexOf('paste_transaction_build_done')).toBeLessThan(indexOf('paste_apply_mutation_start'))
    expect(indexOf('paste_apply_mutation_start')).toBeLessThan(indexOf('paste_apply_mutation_done'))
    expect(indexOf('paste_apply_mutation_done')).toBeLessThan(indexOf('paste_execute_done'))

    const rowExpandDoneCall = debugHarness.logRuntimeDebug.mock.calls.find(
      ([scope, event]) => scope === 'paste' && event === 'paste_row_expand_done'
    )
    expect(rowExpandDoneCall?.[2]).toMatchObject({
      datasetId: 'ds-1',
      method: 'append',
      rowsToInsert: 1,
    })
    expect(typeof rowExpandDoneCall?.[2]?.durationMs).toBe('number')

    const decisionCall = debugHarness.logRuntimeDebug.mock.calls.find(
      ([scope, event]) => scope === 'paste' && event === 'paste_expand_decision'
    )
    expect(decisionCall?.[2]).toMatchObject({
      rowCount: 3,
      dataRowCount: 3,
      requiredRowCount: 4,
      rowOverflow: 1,
      needsDataRowExpansion: true,
      shouldPhysicallyExpandRows: true,
    })
  })
})
