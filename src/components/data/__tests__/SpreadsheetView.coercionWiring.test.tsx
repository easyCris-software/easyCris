/**
 * Coercion wiring tests for SpreadsheetView write paths.
 *
 * These tests mount SpreadsheetView with a mocked coerceEditValue and assert
 * that each write path (onCellEdited, formula-bar commit, fill, paste,
 * paste-values-only, paste-transpose) actually calls coerceEditValue.
 *
 * A handler that stops calling coerceEditValue will cause a test here to fail.
 * This is the layer that SpreadsheetView.coercionContract.test.ts cannot cover.
 */
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import SpreadsheetView from '../SpreadsheetView'
import { CompactSelection, GridCellKind } from '@glideapps/glide-data-grid'
import { createEditExecutor } from '@/lib/grid/editExecutor'

// ---------------------------------------------------------------------------
// coerceEditValue spy — must be hoisted so vi.mock can reference it
// ---------------------------------------------------------------------------

const mockCoerceEditValue = vi.hoisted(() => vi.fn((v: unknown) => v))

vi.mock('@/lib/grid/coerceEditValue', () => ({
  coerceEditValue: mockCoerceEditValue,
}))

// ---------------------------------------------------------------------------
// Clipboard mock
// ---------------------------------------------------------------------------

const mockClipboardRead = vi.hoisted(() => {
  const fn = vi.fn<() => Promise<string>>()
  fn.mockResolvedValue('42')
  return fn
})

vi.mock('@/lib/grid/clipboard', () => ({
  clipboard: { read: mockClipboardRead, write: vi.fn() },
  // Minimal real-equivalent: split by newline then tab
  parseClipboardText: (text: string): string[][] =>
    text
      .split('\n')
      .filter(Boolean)
      .map((row) => row.split('\t')),
}))

// ---------------------------------------------------------------------------
// Keyboard shortcut handler capture (replaces no-op mock)
// ---------------------------------------------------------------------------

const capturedKb = vi.hoisted(() => ({ current: null as any }))

vi.mock('@/hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: (handlers: any) => {
    capturedKb.current = handlers
  },
}))

// ---------------------------------------------------------------------------
// Standard harness — same shape as formulaFlow.dom.test.tsx
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
// Glide DataGrid mock with write-path triggers
// ---------------------------------------------------------------------------

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
          data-testid="trigger-selection"
          onClick={() =>
            props.onGridSelectionChange?.(makeSelection({ x: 0, y: 0, width: 1, height: 1 }))
          }
        >
          select
        </button>
        <button
          data-testid="trigger-fill-pattern"
          onClick={() => {
            void props.onFillPattern?.({
              patternSource: { x: 0, y: 0, width: 1, height: 1 },
              fillDestination: { x: 0, y: 0, width: 1, height: 2 },
              preventDefault: vi.fn(),
            })
          }}
        >
          fill
        </button>
      </div>
    )
  })
  MockDataEditor.displayName = 'MockDataEditor'

  return { ...actual, DataEditor: MockDataEditor }
})

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn().mockResolvedValue(true) }))

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
    flushOverlay: vi.fn().mockResolvedValue(undefined),
    getAllColumnStats: vi.fn().mockResolvedValue([]),
    getPersistedColumnIds: vi.fn().mockResolvedValue([]),
    getGridMutationQueueState: vi.fn().mockReturnValue({
      status: 'idle',
      failedQueueId: null,
      error: null,
    }),
    subscribeGridMutationQueue: vi.fn((_datasetId: string, listener: (state: any) => void) => {
      listener({ status: 'idle', failedQueueId: null, error: null })
      return () => undefined
    }),
  },
}))

vi.mock('@/lib/grid/editExecutor', () => ({
  createEditExecutor: vi.fn(() => ({
    execute: harness.executeEdits,
    executeSingle: harness.executeSingleEdit,
    applyDataStoreUpdate: vi.fn(),
  })),
}))

vi.mock('@/store/data-store', () => ({ useDataStore: dataStoreHarness.useDataStore }))

vi.mock('@/store/app-store', () => ({
  useAppStore: appStoreHarness.useAppStore,
  ensureProjectId: vi.fn().mockResolvedValue('project-1'),
}))

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SpreadsheetView coercion wiring (mounted)', () => {
  beforeEach(() => {
    harness.latestDataEditorProps = null
    harness.executeEdits.mockClear()
    harness.executeSingleEdit.mockClear()
    mockCoerceEditValue.mockClear()
    mockClipboardRead.mockResolvedValue('42')
    capturedKb.current = null
  })

  it('passes getActiveFamilyId into createEditExecutor for non-paste family binding', async () => {
    render(<SpreadsheetView />)

    await waitFor(() => {
      expect(createEditExecutor).toHaveBeenCalled()
    })

    const latestConfig = vi.mocked(createEditExecutor).mock.calls.at(-1)?.[0]
    expect(latestConfig).toBeDefined()
    expect(typeof latestConfig?.getActiveFamilyId).toBe('function')
    expect(latestConfig?.getActiveFamilyId?.()).toBe('statistics-1')
  })

  it('onCellEdited calls coerceEditValue with the column type', async () => {
    render(<SpreadsheetView />)
    await waitFor(() => expect(harness.latestDataEditorProps).not.toBeNull())

    await act(async () => {
      harness.latestDataEditorProps.onCellEdited([0, 0], {
        kind: GridCellKind.Text,
        data: '42',
        displayData: '42',
        allowOverlay: true,
        readonly: false,
      })
    })

    expect(mockCoerceEditValue).toHaveBeenCalledWith('42', 'numeric', expect.any(Function))
  })

  it('formula-bar Enter commit calls coerceEditValue with the column type', async () => {
    render(<SpreadsheetView />)
    await waitFor(() => expect(harness.latestDataEditorProps).not.toBeNull())

    // Select cell [0, 0] so activeCell is set
    fireEvent.click(screen.getByTestId('trigger-selection'))

    const formulaBar = screen.getByPlaceholderText(/type a value or formula/i)
    fireEvent.focus(formulaBar)
    fireEvent.change(formulaBar, { target: { value: '99' } })

    await act(async () => {
      fireEvent.keyDown(formulaBar, { key: 'Enter' })
      // Give the async commitFormulaBarEdit a tick to execute
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockCoerceEditValue).toHaveBeenCalledWith('99', 'numeric', expect.any(Function))
    })
  })

  it('fill pattern calls coerceEditValue with the column type', async () => {
    render(<SpreadsheetView />)
    await waitFor(() => expect(harness.latestDataEditorProps).not.toBeNull())

    await act(async () => {
      fireEvent.click(screen.getByTestId('trigger-fill-pattern'))
      // Allow async fill handler to complete
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockCoerceEditValue).toHaveBeenCalledWith(
        // computeFilledValue returns null when row data is empty (no loaded rows in test harness)
        null,
        'numeric',
        expect.any(Function)
      )
    })
  })

  it('paste calls coerceEditValue with the column type', async () => {
    render(<SpreadsheetView />)
    await waitFor(() => expect(harness.latestDataEditorProps).not.toBeNull())

    // Set up grid selection so paste can resolve paste start
    fireEvent.click(screen.getByTestId('trigger-selection'))

    await act(async () => {
      capturedKb.current?.onPaste()
      // Allow clipboard.read() promise to resolve
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => {
      expect(mockCoerceEditValue).toHaveBeenCalledWith('42', 'numeric', expect.any(Function))
    })
  })

  it('paste-values-only calls coerceEditValue (formula stripped before coerce)', async () => {
    // Clipboard contains a formula cell — values-only strips '=' before coercing
    mockClipboardRead.mockResolvedValue('=SUM(A1)')

    render(<SpreadsheetView />)
    await waitFor(() => expect(harness.latestDataEditorProps).not.toBeNull())

    fireEvent.click(screen.getByTestId('trigger-selection'))

    await act(async () => {
      capturedKb.current?.onPasteValues()
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => {
      // '=SUM(A1)' → trimStart().slice(1) → 'SUM(A1)' → coerceEditValue
      expect(mockCoerceEditValue).toHaveBeenCalledWith('SUM(A1)', 'numeric', expect.any(Function))
    })
  })

  it('paste-transpose calls coerceEditValue with the column type', async () => {
    // paste-transpose requires __TAURI__ in the keyboard-shortcut guard
    ;(window as any).__TAURI__ = {}
    try {
      render(<SpreadsheetView />)
      await waitFor(() => expect(harness.latestDataEditorProps).not.toBeNull())

      fireEvent.click(screen.getByTestId('trigger-selection'))

      await act(async () => {
        capturedKb.current?.onTranspose()
        await new Promise((r) => setTimeout(r, 0))
      })

      await waitFor(() => {
        expect(mockCoerceEditValue).toHaveBeenCalledWith('42', 'numeric', expect.any(Function))
      })
    } finally {
      delete (window as any).__TAURI__
    }
  })
})
