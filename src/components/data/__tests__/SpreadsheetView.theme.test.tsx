import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import SpreadsheetView from '../SpreadsheetView'

const harness = vi.hoisted(() => ({
  latestDataEditorProps: null as any,
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

  return { useAppStore }
})

const useThemeMock = vi.fn(() => ({
  theme: 'light',
  resolvedTheme: 'light',
  setTheme: vi.fn(),
}))

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => useThemeMock(),
}))

vi.mock('@glideapps/glide-data-grid', async () => {
  const actual = await vi.importActual<typeof import('@glideapps/glide-data-grid')>(
    '@glideapps/glide-data-grid'
  )

  const MockDataEditor = React.forwardRef((props: any, _ref: React.ForwardedRef<any>) => {
    harness.latestDataEditorProps = props
    return <div data-testid="mock-data-editor" />
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
    execute: vi.fn().mockResolvedValue(undefined),
    executeSingle: vi.fn(),
    applyDataStoreUpdate: vi.fn(),
  })),
}))

vi.mock('@/store/data-store', () => ({
  useDataStore: dataStoreHarness.useDataStore,
}))

vi.mock('@/store/app-store', () => ({
  useAppStore: appStoreHarness.useAppStore,
  ensureProjectId: vi.fn().mockResolvedValue('project-1'),
}))

describe('SpreadsheetView theme wiring', () => {
  beforeEach(() => {
    harness.latestDataEditorProps = null
    useThemeMock.mockReturnValue({
      theme: 'light',
      resolvedTheme: 'light',
      setTheme: vi.fn(),
    })
  })

  it('passes a dark Glide theme to DataEditor when the resolved theme is dark', () => {
    useThemeMock.mockReturnValue({
      theme: 'dark',
      resolvedTheme: 'dark',
      setTheme: vi.fn(),
    })

    render(<SpreadsheetView />)

    expect(harness.latestDataEditorProps?.theme?.bgCell).not.toBe('#FFFFFF')
    expect(harness.latestDataEditorProps?.theme?.textDark).not.toBe('#1E293B')
  })

  it('uses dark-aware formula bar chrome in dark mode', () => {
    useThemeMock.mockReturnValue({
      theme: 'dark',
      resolvedTheme: 'dark',
      setTheme: vi.fn(),
    })

    render(<SpreadsheetView />)

    const input = screen.getByPlaceholderText(/type a value or formula/i)
    const formulaBar = input.closest('div')?.parentElement

    expect(formulaBar).toHaveStyle({ backgroundColor: '#0f172a' })
    expect(formulaBar).not.toHaveStyle({ backgroundColor: '#FFFFFF' })
    expect((input as HTMLInputElement).style.caretColor.toLowerCase()).toBe('#f8fafc')
  })
})
