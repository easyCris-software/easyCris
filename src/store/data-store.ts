/**
 * Data Store - Zustand store for dataset management
 *
 * Manages:
 * - Imported datasets (CSV, TSV, Excel)
 * - Column metadata and types
 * - Data grid state and selection
 * - Apache Arrow integration for large datasets
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import cacheService from '@/services/cacheService'

/**
 * Column metadata for the data grid
 */
export interface ColumnMetadata {
  id: string
  name: string
  type: 'numeric' | 'categorical' | 'text' | 'datetime'
  width?: number // Optional column width for grid display (resizable columns)
  displayType?: string // User-friendly type label
  statistics?: {
    min?: number
    max?: number
    mean?: number
    median?: number
    stdDev?: number
    missing?: number
    unique?: number
  }
}

/**
 * Dataset metadata
 */
export interface Dataset {
  id: string
  name: string
  rowCount: number
  /** Actual populated rows (before UI padding) */
  dataRowCount?: number
  columnCount: number
  columns: ColumnMetadata[]
  /** Monotonic allocator for auto-generated column names (e.g. Column 101, 102, ...) */
  nextAutoColumnNumber?: number
  filePath?: string
  /** DuckDB file path (for large datasets >= 1M rows) - Phase 1 */
  duckdbPath?: string
  importedAt: Date
  modifiedAt: Date
  /**
   * Owner family ID (Phase C - Family/Child Isolation)
   * Single-owner model: each dataset belongs to exactly one family.
   * Optional for migration - existing datasets will have this populated on load.
   */
  familyId?: string
  /**
   * Cell highlights (Excel-style fill color)
   * Key: "row:columnId" (e.g., "5:col-2")
   * Value: color hex (e.g., "#FFEB3B")
   */
  highlights?: Record<string, string>
}

const AUTO_COLUMN_NAME_PATTERN = /^Column\s+(\d+)$/i

function parseAutoColumnNumber(name: string): number | null {
  const match = AUTO_COLUMN_NAME_PATTERN.exec(name.trim())
  if (!match || !match[1]) return null
  const parsed = Number.parseInt(match[1], 10)
  if (!Number.isFinite(parsed) || parsed < 1) return null
  return parsed
}

export function deriveNextAutoColumnNumber(columns: Pick<ColumnMetadata, 'name'>[]): number {
  let maxAutoNumber = 0
  for (const column of columns) {
    const parsed = parseAutoColumnNumber(column.name)
    if (parsed !== null && parsed > maxAutoNumber) {
      maxAutoNumber = parsed
    }
  }
  return maxAutoNumber + 1
}

function sanitizeAutoColumnCounter(counter: number | undefined, columns: ColumnMetadata[]): number {
  const derived = deriveNextAutoColumnNumber(columns)
  if (typeof counter !== 'number' || !Number.isFinite(counter)) {
    return derived
  }
  return Math.max(1, Math.floor(counter), derived)
}

function ensureDatasetAutoColumnCounter(dataset: Dataset): Dataset {
  const nextAutoColumnNumber = sanitizeAutoColumnCounter(dataset.nextAutoColumnNumber, dataset.columns)
  if (dataset.nextAutoColumnNumber === nextAutoColumnNumber) {
    return dataset
  }
  return { ...dataset, nextAutoColumnNumber }
}

function getNextAutoColumnCounterAfterInsert(dataset: Dataset, insertedColumnName: string): number {
  const baseCounter = sanitizeAutoColumnCounter(dataset.nextAutoColumnNumber, dataset.columns)
  const insertedNumber = parseAutoColumnNumber(insertedColumnName)
  if (insertedNumber === null) return baseCounter
  return Math.max(baseCounter, insertedNumber + 1)
}

/**
 * Data grid selection state
 */
export interface GridSelection {
  selectedRows: number[]
  selectedColumns: string[]
  selectedCells?: { row: number; col: string }[]
  /** Flag indicating all rows are selected (avoids allocating huge arrays for large datasets) */
  allRowsSelected?: boolean
  /** Flag indicating all columns are selected */
  allColumnsSelected?: boolean
}

export interface SelectionStats {
  sum: number
  avg: number
  count: number
  min: number
  max: number
  expectedCellCount: number
  consideredCellCount: number
  partial: boolean
}

/**
 * Cached column classification
 */
export interface CachedClassification {
  classification: unknown // ColumnClassification from analysis modules
}

export type ColumnTypeOverride =
  | 'numeric'
  | 'categorical'
  | 'binary'
  | 'ordinal'
  | 'mixed'
  | 'empty'

/**
 * Loading operation details for user-visible progress indicators
 */
export interface LoadingOperation {
  /** Operation type for categorization */
  type: 'import' | 'sort' | 'groupby' | 'query' | 'save' | 'export' | 'analysis'
  /** User-visible message (e.g., "Importing large CSV...") */
  message: string
  /** Estimated total for progress (optional) */
  total?: number
  /** Current progress (optional) */
  current?: number
  /** True if indeterminate (no progress %) */
  indeterminate?: boolean
  /** Optional cancellation handler for long operations */
  onCancel?: () => void
}

/**
 * Transform snapshot for revert capability
 */
export interface TransformSnapshot {
  datasetId: string
  timestamp: number
  /** Original column metadata before transform */
  columns: ColumnMetadata[]
  /** Original row count */
  rowCount: number
  /** Original data row count */
  dataRowCount?: number
  /** Original row data (keys are column IDs) */
  rows: Record<string, unknown>[]
  /** Transform type for display */
  transformType: 'pivot_wider' | 'pivot_longer' | 'filter' | 'group_aggregate'
}

/**
 * Data Store State
 */
interface DataState {
  // Dataset state
  currentDataset: Dataset | null
  datasets: Dataset[] // For multi-dataset support in future
  isLoading: boolean
  /** Enhanced loading state with operation details */
  loadingOperation: LoadingOperation | null
  error: string | null

  // Grid state
  gridSelection: GridSelection
  selectionStats: SelectionStats | null
  gridViewport: {
    scrollTop: number
    scrollLeft: number
    visibleRows: [number, number] // [startRow, endRow]
    visibleColumns: [number, number] // [startCol, endCol]
  }

  // Data cache (for large datasets using Apache Arrow)
  // NOTE: Map doesn't serialize well in Redux DevTools - consider plain object if persistence needed
  dataCache: Map<string, unknown> // Key: row range, Value: Arrow data

  // Formula persistence mirror (Phase 7 - Formula Engine)
  // NOTE: This is NOT a source of truth - FormulaService owns formulas.
  // This is a passive mirror for project save/load serialization only.
  // SpreadsheetView keeps this in sync with FormulaService.
  datasetFormulas: Map<string, Map<string, string>> // datasetId -> cellKey -> formula

  // Edit tracking for analysis invalidation (Phase 1 - Grid Enhancement)
  /** Columns that have been edited and need re-classification */
  invalidatedColumnIds: Set<string>
  /** Cached column classifications */
  columnClassificationCache: Map<string, CachedClassification>
  /** User overrides for inferred column types. Key: `${datasetId}:${columnId}` */
  columnTypeOverrides: Map<string, ColumnTypeOverride>

  // Transform snapshots for revert capability (one per dataset)
  transformSnapshots: Map<string, TransformSnapshot> // datasetId -> snapshot

  // Actions - Dataset management
  setCurrentDataset: (dataset: Dataset | null) => void
  addDataset: (dataset: Dataset) => void
  removeDataset: (datasetId: string) => void
  updateDataset: (datasetId: string, updates: Partial<Dataset>) => void
  clearAllDatasets: () => void
  initializeBlankDataset: (name?: string) => Promise<Dataset>
  /** Atomically allocate the next unique auto column name (e.g. Column 101) */
  allocateNextAutoColumnName: (datasetId: string) => string | null
  /** Roll back a reserved auto column name if insert fails before commit */
  rollbackAutoColumnNameAllocation: (datasetId: string, reservedName: string) => void
  /** Add a new column to the current dataset (appends to the right) */
  addColumnToDataset: (datasetId: string, column: ColumnMetadata) => void
  /** Insert a new column at a specific index */
  insertColumnAtDataset: (datasetId: string, index: number, column: ColumnMetadata) => void
  /** Insert an empty row at a specific model-row index */
  insertRowAtDataset: (datasetId: string, index: number) => void
  /** Remove a column at a specific index */
  removeColumnAtDataset: (datasetId: string, index: number) => void
  /** Remove a row at a specific model-row index */
  removeRowAtDataset: (datasetId: string, index: number) => void

  // Actions - Loading state
  setLoading: (loading: boolean) => void
  /** Set enhanced loading operation with details for progress display */
  setLoadingOperation: (operation: LoadingOperation | null) => void
  setError: (error: string | null) => void

  // Actions - Grid selection
  setSelectedRows: (rows: number[]) => void
  setSelectedColumns: (columns: string[]) => void
  setSelectionStats: (stats: SelectionStats | null) => void
  clearSelection: () => void
  selectAll: () => void
  getSelectionSummary: () => {
    type: 'none' | 'single-cell' | 'range' | 'all'
    rowCount: number
    columnCount: number
    description: string
  } | null

  // Actions - Grid viewport
  updateViewport: (viewport: Partial<DataState['gridViewport']>) => void

  // Actions - Column metadata
  updateColumnType: (columnId: string, type: ColumnMetadata['type']) => void
  updateColumnStatistics: (
    columnId: string,
    statistics: ColumnMetadata['statistics']
  ) => void

  // Actions - Data cache (for Apache Arrow integration)
  setCacheData: (key: string, data: unknown) => void
  clearCache: () => void

  // Actions - Cell editing
  updateCellValue: (
    datasetId: string,
    rowIdx: number,
    columnId: string,
    value: unknown
  ) => void

  // Actions - Edit tracking / Invalidation (Phase 1 - Grid Enhancement)
  /** Mark columns as needing re-classification */
  invalidateColumns: (columnIds: string[]) => void
  /** Clear invalidation for a column after re-classification */
  clearInvalidation: (columnId: string) => void
  /** Check if a column needs re-classification */
  isColumnInvalidated: (columnId: string) => boolean
  /** Cache a column classification result */
  setColumnClassification: (columnId: string, data: CachedClassification) => void
  /** Get cached classification for a column */
  getColumnClassification: (columnId: string) => CachedClassification | undefined
  /** Set or clear a manual type override for a column in a dataset */
  setColumnTypeOverride: (
    datasetId: string,
    columnId: string,
    overrideType: ColumnTypeOverride | null
  ) => void
  /** Get manual type override for a column in a dataset */
  getColumnTypeOverride: (datasetId: string, columnId: string) => ColumnTypeOverride | undefined
  /** Check if column needs reclassification (invalidated OR stale OR missing) */
  shouldReclassifyColumn: (columnId: string) => boolean
  /** Clear all invalidation state (e.g., on dataset switch) */
  clearAllInvalidation: () => void

  // Actions - Formula persistence mirror (Phase 7)
  // NOTE: These are passive setters for save/load only. FormulaService is the source of truth.
  getDatasetFormulas: (datasetId: string) => Map<string, string>
  setDatasetFormulas: (datasetId: string, formulas: Map<string, string>) => void

  // Actions - Transform snapshots (for revert capability)
  saveTransformSnapshot: (snapshot: TransformSnapshot) => void
  getTransformSnapshot: (datasetId: string) => TransformSnapshot | undefined
  clearTransformSnapshot: (datasetId: string) => void
  hasTransformSnapshot: (datasetId: string) => boolean

  // Actions - Cell highlights (Excel-style fill color)
  setHighlight: (datasetId: string, row: number, columnId: string, color: string) => void
  removeHighlight: (datasetId: string, row: number, columnId: string) => void
  setHighlightsBatch: (datasetId: string, cellKeys: string[], color: string) => void
  removeHighlightsBatch: (datasetId: string, cellKeys: string[]) => void
  clearHighlights: (datasetId: string) => void
  getHighlight: (datasetId: string, row: number, columnId: string) => string | undefined

  // Actions - Family-aware selectors (Phase C - Family/Child Isolation)
  /** Get all datasets belonging to a specific family */
  getDatasetsByFamily: (familyId: string) => Dataset[]
  /** Set the owner family for a dataset */
  setDatasetFamily: (datasetId: string, familyId: string) => void
  /** Clear all datasets belonging to a specific family */
  clearDatasetsByFamily: (familyId: string) => void
}

export const useDataStore = create<DataState>()(
  devtools(
    (set, get) => ({
      // Initial state
      currentDataset: null,
      datasets: [],
      isLoading: false,
      loadingOperation: null,
      error: null,

      gridSelection: {
        selectedRows: [],
        selectedColumns: [],
        selectedCells: undefined,
        allRowsSelected: false,
        allColumnsSelected: false,
      },
      selectionStats: null,

      gridViewport: {
        scrollTop: 0,
        scrollLeft: 0,
        visibleRows: [0, 100], // Default viewport
        visibleColumns: [0, 20],
      },

      dataCache: new Map(),

      // Formula persistence mirror (Phase 7 - Formula Engine)
      datasetFormulas: new Map<string, Map<string, string>>(),

      // Edit tracking state (Phase 1 - Grid Enhancement)
      invalidatedColumnIds: new Set<string>(),
      columnClassificationCache: new Map<string, CachedClassification>(),
      columnTypeOverrides: new Map<string, ColumnTypeOverride>(),

      // Transform snapshots (one per dataset for revert capability)
      transformSnapshots: new Map<string, TransformSnapshot>(),

      // Dataset management actions
      // NOTE: Invalidation state is cleared on dataset switch because cache keys
      // are columnId-only (not datasetId:columnId). This is a known limitation.
      // Future improvement: scope cache by datasetId for multi-dataset workflows.
      setCurrentDataset: dataset =>
        set(
          {
            currentDataset: dataset ? ensureDatasetAutoColumnCounter(dataset) : null,
            // Clear invalidation state when switching datasets
            invalidatedColumnIds: new Set<string>(),
            columnClassificationCache: new Map<string, CachedClassification>(),
            selectionStats: null,
          },
          undefined,
          'setCurrentDataset'
        ),

      addDataset: dataset =>
        set(
          state => ({
            datasets: [...state.datasets, ensureDatasetAutoColumnCounter(dataset)],
            currentDataset: ensureDatasetAutoColumnCounter(dataset), // Auto-select new dataset
            // Clear invalidation state when switching to new dataset
            invalidatedColumnIds: new Set<string>(),
            columnClassificationCache: new Map<string, CachedClassification>(),
            selectionStats: null,
          }),
          undefined,
          'addDataset'
        ),

      removeDataset: datasetId =>
        set(
          state => {
            const isRemovingActive = state.currentDataset?.id === datasetId

            // Clean up formula mirror for removed dataset (Phase 7 - prevent memory leak)
            const newFormulas = new Map(state.datasetFormulas)
            newFormulas.delete(datasetId)
            const newTransformSnapshots = new Map(state.transformSnapshots)
            newTransformSnapshots.delete(datasetId)
            const newTypeOverrides = new Map(state.columnTypeOverrides)
            for (const key of Array.from(newTypeOverrides.keys())) {
              if (key.startsWith(`${datasetId}:`)) {
                newTypeOverrides.delete(key)
              }
            }

            return {
              datasets: state.datasets.filter(d => d.id !== datasetId),
              currentDataset: isRemovingActive ? null : state.currentDataset,
              datasetFormulas: newFormulas,
              transformSnapshots: newTransformSnapshots,
              columnTypeOverrides: newTypeOverrides,
              // Clear invalidation state when removing the active dataset
              ...(isRemovingActive
                ? {
                    invalidatedColumnIds: new Set<string>(),
                    columnClassificationCache: new Map<string, CachedClassification>(),
                    selectionStats: null,
                  }
                : {}),
            }
          },
          undefined,
          'removeDataset'
        ),

      updateDataset: (datasetId, updates) =>
        set(
          state => ({
            datasets: state.datasets.map(d =>
              d.id === datasetId
                ? ensureDatasetAutoColumnCounter({ ...d, ...updates, modifiedAt: new Date() })
                : d
            ),
            currentDataset:
              state.currentDataset?.id === datasetId
                ? ensureDatasetAutoColumnCounter({
                    ...state.currentDataset,
                    ...updates,
                    modifiedAt: new Date(),
                  })
                : state.currentDataset,
          }),
          undefined,
          'updateDataset'
        ),

      clearAllDatasets: () =>
        set(
          {
            datasets: [],
            currentDataset: null,
            gridSelection: {
              selectedRows: [],
              selectedColumns: [],
              selectedCells: undefined,
              allRowsSelected: false,
              allColumnsSelected: false,
            },
            // Clear formula mirror when clearing all datasets (Phase 7 - prevent memory leak)
            datasetFormulas: new Map<string, Map<string, string>>(),
            // Clear transform snapshots when clearing all datasets
            transformSnapshots: new Map<string, TransformSnapshot>(),
            // Clear invalidation state when clearing all datasets
            invalidatedColumnIds: new Set<string>(),
            columnClassificationCache: new Map<string, CachedClassification>(),
            columnTypeOverrides: new Map<string, ColumnTypeOverride>(),
            selectionStats: null,
          },
          undefined,
          'clearAllDatasets'
        ),

      allocateNextAutoColumnName: (datasetId: string) => {
        let allocatedName: string | null = null
        set(
          state => {
            const allocateFromDataset = (dataset: Dataset): Dataset => {
              const baseCounter = sanitizeAutoColumnCounter(
                dataset.nextAutoColumnNumber,
                dataset.columns
              )
              const usedNames = new Set(dataset.columns.map(col => col.name.trim().toLowerCase()))

              let nextNumber = baseCounter
              let candidate = `Column ${nextNumber}`
              while (usedNames.has(candidate.toLowerCase())) {
                nextNumber += 1
                candidate = `Column ${nextNumber}`
              }

              allocatedName = candidate
              return {
                ...dataset,
                nextAutoColumnNumber: nextNumber + 1,
              }
            }

            return {
              datasets: state.datasets.map(d =>
                d.id === datasetId ? allocateFromDataset(d) : d
              ),
              currentDataset:
                state.currentDataset?.id === datasetId
                  ? allocateFromDataset(state.currentDataset)
                  : state.currentDataset,
            }
          },
          undefined,
          'allocateNextAutoColumnName'
        )

        return allocatedName
      },

      rollbackAutoColumnNameAllocation: (datasetId, reservedName) =>
        set(
          state => {
            const reservedNumber = parseAutoColumnNumber(reservedName)
            if (reservedNumber === null) return state

            const rollbackDataset = (dataset: Dataset): Dataset => {
              const currentCounter = sanitizeAutoColumnCounter(
                dataset.nextAutoColumnNumber,
                dataset.columns
              )
              const hasReservedNameAlready = dataset.columns.some(
                column => column.name.trim().toLowerCase() === reservedName.trim().toLowerCase()
              )
              // Only rollback if reservation appears to be the most recent allocation
              // and no column with that reserved name has been committed.
              if (hasReservedNameAlready || currentCounter !== reservedNumber + 1) {
                return dataset
              }

              const minimumAllowed = deriveNextAutoColumnNumber(dataset.columns)
              const rolledBackCounter = Math.max(minimumAllowed, reservedNumber)
              if (rolledBackCounter === dataset.nextAutoColumnNumber) {
                return dataset
              }
              return {
                ...dataset,
                nextAutoColumnNumber: rolledBackCounter,
              }
            }

            return {
              datasets: state.datasets.map(d =>
                d.id === datasetId ? rollbackDataset(d) : d
              ),
              currentDataset:
                state.currentDataset?.id === datasetId
                  ? rollbackDataset(state.currentDataset)
                  : state.currentDataset,
            }
          },
          undefined,
          'rollbackAutoColumnNameAllocation'
        ),

      addColumnToDataset: (datasetId, column) =>
        set(
          state => ({
            datasets: state.datasets.map(d =>
              d.id === datasetId
                ? {
                    ...d,
                    columns: [...d.columns, column],
                    columnCount: d.columnCount + 1,
                    nextAutoColumnNumber: getNextAutoColumnCounterAfterInsert(d, column.name),
                    modifiedAt: new Date(),
                  }
                : d
            ),
            currentDataset:
              state.currentDataset?.id === datasetId
                ? {
                    ...state.currentDataset,
                    columns: [...state.currentDataset.columns, column],
                    columnCount: state.currentDataset.columnCount + 1,
                    nextAutoColumnNumber: getNextAutoColumnCounterAfterInsert(
                      state.currentDataset,
                      column.name
                    ),
                    modifiedAt: new Date(),
                  }
                : state.currentDataset,
          }),
          undefined,
          'addColumnToDataset'
        ),

      insertColumnAtDataset: (datasetId, index, column) =>
        set(
          state => {
            const clampIndex = (len: number) => Math.max(0, Math.min(index, len))
            return {
              datasets: state.datasets.map(d => {
                if (d.id !== datasetId) return d
                const at = clampIndex(d.columns.length)
                const nextColumns = [...d.columns]
                nextColumns.splice(at, 0, column)
                return {
                  ...d,
                  columns: nextColumns,
                  columnCount: d.columnCount + 1,
                  nextAutoColumnNumber: getNextAutoColumnCounterAfterInsert(d, column.name),
                  modifiedAt: new Date(),
                }
              }),
              currentDataset:
                state.currentDataset?.id === datasetId
                  ? (() => {
                      const at = clampIndex(state.currentDataset.columns.length)
                      const nextColumns = [...state.currentDataset.columns]
                      nextColumns.splice(at, 0, column)
                      return {
                        ...state.currentDataset,
                        columns: nextColumns,
                        columnCount: state.currentDataset.columnCount + 1,
                        nextAutoColumnNumber: getNextAutoColumnCounterAfterInsert(
                          state.currentDataset,
                          column.name
                        ),
                        modifiedAt: new Date(),
                      }
                    })()
                  : state.currentDataset,
            }
          },
          undefined,
          'insertColumnAtDataset'
        ),

      insertRowAtDataset: (datasetId, index) =>
        set(
          state => {
            const apply = (d: Dataset): Dataset => {
              const dataRows = typeof d.dataRowCount === 'number' ? d.dataRowCount : d.rowCount
              const at = Math.max(0, Math.min(index, dataRows))
              return {
                ...d,
                rowCount: d.rowCount + 1,
                dataRowCount: Math.max(dataRows + 1, at + 1),
                modifiedAt: new Date(),
              }
            }
            return {
              datasets: state.datasets.map(d => (d.id === datasetId ? apply(d) : d)),
              currentDataset:
                state.currentDataset?.id === datasetId
                  ? apply(state.currentDataset)
                  : state.currentDataset,
            }
          },
          undefined,
          'insertRowAtDataset'
        ),

      removeColumnAtDataset: (datasetId, index) =>
        set(
          state => {
            const apply = (d: Dataset): Dataset => {
              if (d.columns.length === 0) return d
              const at = Math.max(0, Math.min(index, d.columns.length - 1))
              const nextColumns = [...d.columns]
              nextColumns.splice(at, 1)
              return {
                ...d,
                columns: nextColumns,
                columnCount: Math.max(0, d.columnCount - 1),
                modifiedAt: new Date(),
              }
            }

            return {
              datasets: state.datasets.map(d => (d.id === datasetId ? apply(d) : d)),
              currentDataset:
                state.currentDataset?.id === datasetId
                  ? apply(state.currentDataset)
                  : state.currentDataset,
            }
          },
          undefined,
          'removeColumnAtDataset'
        ),

      removeRowAtDataset: (datasetId, index) =>
        set(
          state => {
            const apply = (d: Dataset): Dataset => {
              if (d.rowCount <= 0) return d
              const dataRows = typeof d.dataRowCount === 'number' ? d.dataRowCount : d.rowCount
              const removeAt = Math.max(0, Math.min(index, d.rowCount - 1))
              const nextDataRows = removeAt < dataRows ? Math.max(0, dataRows - 1) : dataRows
              return {
                ...d,
                rowCount: Math.max(0, d.rowCount - 1),
                dataRowCount: nextDataRows,
                modifiedAt: new Date(),
              }
            }

            return {
              datasets: state.datasets.map(d => (d.id === datasetId ? apply(d) : d)),
              currentDataset:
                state.currentDataset?.id === datasetId
                  ? apply(state.currentDataset)
                  : state.currentDataset,
            }
          },
          undefined,
          'removeRowAtDataset'
        ),

      initializeBlankDataset: async (name?: string) => {
        // Create a 100×100 blank dataset like Avalonia's SpreadsheetRow100
        const rowCount = 100
        const colCount = 100

        // Generate column definitions (A, B, C, ... AA, AB, ...)
        const columns: ColumnMetadata[] = Array.from({ length: colCount }, (_, i) => ({
          id: `col-${i}`,
          name: `Column ${i + 1}`,
          type: 'text',
          width: 88,
        }))

        const now = new Date()

        const baseId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        const dataset: Dataset = {
          id: `blank-${baseId}`,
          name: name || 'Blank Dataset',
          rowCount,
          dataRowCount: 0,
          columnCount: colCount, // FIX: Add column count (required by Dataset interface)
          columns,
          nextAutoColumnNumber: colCount + 1,
          importedAt: now, // FIX: Use importedAt instead of createdAt (required by Dataset interface)
          modifiedAt: now,
        }

        try {
          const { ensureProjectId } = await import('./app-store')
          await ensureProjectId()

          const columnPayload = columns.map(col => ({
            id: col.id,
            name: col.name,
            dtype: col.type,
          }))
          await cacheService.createEmptyDuckDB(dataset.id, columnPayload)
        } catch (error) {
          if (import.meta.env.DEV) {
            console.error('Failed to initialize blank dataset backend state:', error)
          }
          throw error
        }

        // Add to store (clear invalidation state for new dataset)
        set(
          state => ({
            datasets: [...state.datasets, dataset],
            currentDataset: dataset,
            // Clear invalidation state when switching to new dataset
            invalidatedColumnIds: new Set<string>(),
            columnClassificationCache: new Map<string, CachedClassification>(),
            selectionStats: null,
          }),
          undefined,
          'initializeBlankDataset'
        )

        // Initialize blank data in cache (100 rows of empty strings)
        const blankRows: Record<string, unknown>[] = Array.from({ length: rowCount }, () => {
          const row: Record<string, unknown> = {}
          columns.forEach(col => {
            row[col.id] = ''
          })
          return row
        })
        get().setCacheData(`dataset:${dataset.id}`, blankRows)

        return dataset
      },

      // Loading state actions
      setLoading: (loading: boolean) =>
        set({ isLoading: loading }, undefined, 'setLoading'),

      setLoadingOperation: (operation: LoadingOperation | null) =>
        set(
          {
            loadingOperation: operation,
            isLoading: operation !== null,
          },
          undefined,
          'setLoadingOperation'
        ),

      setError: (error: string | null) =>
        set({ error }, undefined, 'setError'),

      // Grid selection actions
      setSelectedRows: (rows: number[]) =>
        set(
          state => ({
            gridSelection: { ...state.gridSelection, selectedRows: rows },
          }),
          undefined,
          'setSelectedRows'
        ),

      setSelectedColumns: (columns: string[]) =>
        set(
          state => ({
            gridSelection: { ...state.gridSelection, selectedColumns: columns },
          }),
          undefined,
          'setSelectedColumns'
        ),

      setSelectionStats: (stats: SelectionStats | null) =>
        set({ selectionStats: stats }, undefined, 'setSelectionStats'),

      clearSelection: () =>
        set(
          {
            gridSelection: {
              selectedRows: [],
              selectedColumns: [],
              selectedCells: undefined,
              allRowsSelected: false,
              allColumnsSelected: false,
            },
            selectionStats: null,
          },
          undefined,
          'clearSelection'
        ),

      selectAll: () =>
        set(
          state => ({
            gridSelection: {
              // Use flags instead of allocating huge arrays for large datasets
              selectedRows: [],
              selectedColumns: state.currentDataset
                ? state.currentDataset.columns.map(c => c.id)
                : [],
              selectedCells: undefined,
              allRowsSelected: !!state.currentDataset,
              allColumnsSelected: !!state.currentDataset,
            },
            selectionStats: null,
          }),
          undefined,
          'selectAll'
        ),

      getSelectionSummary: () => {
        const state = get()
        const { currentDataset, gridSelection } = state

        if (!currentDataset || !gridSelection) {
          return null
        }

        const { selectedRows, selectedColumns, allRowsSelected, allColumnsSelected } = gridSelection

        // All cells selected
        if (allRowsSelected && allColumnsSelected) {
          return {
            type: 'all',
            rowCount: currentDataset.rowCount,
            columnCount: currentDataset.columns.length,
            description: `All cells selected (${currentDataset.rowCount.toLocaleString()} rows × ${currentDataset.columns.length} columns)`,
          }
        }

        // All rows in selected columns
        if (allRowsSelected && selectedColumns.length > 0) {
          return {
            type: 'range',
            rowCount: currentDataset.rowCount,
            columnCount: selectedColumns.length,
            description: `All rows selected in ${selectedColumns.length} column(s)`,
          }
        }

        // All columns in selected rows
        if (allColumnsSelected && selectedRows.length > 0) {
          return {
            type: 'range',
            rowCount: selectedRows.length,
            columnCount: currentDataset.columns.length,
            description: `All columns selected in ${selectedRows.length} row(s)`,
          }
        }

        // Specific selection
        if (selectedRows.length > 0 && selectedColumns.length > 0) {
          // Single cell
          if (selectedRows.length === 1 && selectedColumns.length === 1) {
            const row = selectedRows[0] ?? 0
            const col = selectedColumns[0] ?? ''
            const colName = currentDataset.columns.find(c => c.id === col)?.name || col
            return {
              type: 'single-cell',
              rowCount: 1,
              columnCount: 1,
              description: `Row ${row + 1}, Column ${colName}`,
            }
          }

          // Range
          return {
            type: 'range',
            rowCount: selectedRows.length,
            columnCount: selectedColumns.length,
            description: `${selectedRows.length} row(s) × ${selectedColumns.length} column(s) selected`,
          }
        }

        // No selection
        return null
      },

      // Grid viewport actions
      updateViewport: (viewport: Partial<DataState['gridViewport']>) =>
        set(
          state => ({
            gridViewport: { ...state.gridViewport, ...viewport },
          }),
          undefined,
          'updateViewport'
        ),

      // Column metadata actions
      updateColumnType: (columnId: string, type: ColumnMetadata['type']) =>
        set(
          state => {
            if (!state.currentDataset) {
              // Silent no-op when no dataset loaded
              if (import.meta.env.DEV) {
                console.warn('updateColumnType called with no dataset loaded')
              }
              return state
            }
            return {
              currentDataset: {
                ...state.currentDataset,
                columns: state.currentDataset.columns.map(col =>
                  col.id === columnId ? { ...col, type } : col
                ),
                modifiedAt: new Date(),
              },
            }
          },
          undefined,
          'updateColumnType'
        ),

      updateColumnStatistics: (
        columnId: string,
        statistics: ColumnMetadata['statistics']
      ) =>
        set(
          state => {
            if (!state.currentDataset) {
              // Silent no-op when no dataset loaded
              if (import.meta.env.DEV) {
                console.warn('updateColumnStatistics called with no dataset loaded')
              }
              return state
            }
            return {
              currentDataset: {
                ...state.currentDataset,
                columns: state.currentDataset.columns.map(col =>
                  col.id === columnId
                    ? { ...col, statistics: { ...col.statistics, ...statistics } }
                    : col
                ),
              },
            }
          },
          undefined,
          'updateColumnStatistics'
        ),

      // Data cache actions (for Apache Arrow integration)
      setCacheData: (key: string, data: unknown) =>
        set(
          state => {
            const newCache = new Map(state.dataCache)
            newCache.set(key, data)
            return { dataCache: newCache }
          },
          undefined,
          'setCacheData'
        ),

      clearCache: () => set({ dataCache: new Map() }, undefined, 'clearCache'),

      // Cell editing actions
      updateCellValue: (
        datasetId: string,
        rowIdx: number,
        columnId: string,
        value: unknown
      ) =>
        set(
          state => {
            const currentDataset = state.currentDataset
            const datasetExists =
              state.datasets.some(d => d.id === datasetId) ||
              currentDataset?.id === datasetId
            if (!datasetExists) {
              return state
            }

            const now = new Date()
            const updatedDatasets = state.datasets.map(d =>
              d.id === datasetId ? { ...d, modifiedAt: now } : d
            )
            const updatedCurrentDataset =
              currentDataset?.id === datasetId
                ? {
                    ...currentDataset,
                    modifiedAt: now,
                  }
                : currentDataset

            const cacheKey = `dataset:${datasetId}`
            const cachedData = state.dataCache.get(cacheKey)

            if (Array.isArray(cachedData)) {
              const updatedCache = [...cachedData]

              if (!updatedCache[rowIdx]) {
                updatedCache[rowIdx] = {}
              }

              updatedCache[rowIdx]![columnId] = value

              const newCache = new Map(state.dataCache)
              newCache.set(cacheKey, updatedCache)

              return {
                dataCache: newCache,
                datasets: updatedDatasets,
                currentDataset: updatedCurrentDataset ?? null,
              }
            }

            return {
              datasets: updatedDatasets,
              currentDataset: updatedCurrentDataset ?? null,
            }
          },
          undefined,
          'updateCellValue'
        ),

      // Edit tracking / Invalidation actions (Phase 1 - Grid Enhancement)
      invalidateColumns: (columnIds: string[]) =>
        set(
          state => {
            const newInvalidated = new Set(state.invalidatedColumnIds)
            columnIds.forEach(id => newInvalidated.add(id))
            return { invalidatedColumnIds: newInvalidated }
          },
          undefined,
          'invalidateColumns'
        ),

      clearInvalidation: (columnId: string) => {
        const state = get()
        if (!state.invalidatedColumnIds.has(columnId)) return

        set(
          currentState => {
            const newInvalidated = new Set(currentState.invalidatedColumnIds)
            newInvalidated.delete(columnId)
            return { invalidatedColumnIds: newInvalidated }
          },
          undefined,
          'clearInvalidation'
        )
      },

      isColumnInvalidated: (columnId: string) => {
        return get().invalidatedColumnIds.has(columnId)
      },

      setColumnClassification: (columnId: string, data: CachedClassification) =>
        set(
          state => {
            const newCache = new Map(state.columnClassificationCache)
            newCache.set(columnId, data)
            return { columnClassificationCache: newCache }
          },
          undefined,
          'setColumnClassification'
        ),

      getColumnClassification: (columnId: string) => {
        return get().columnClassificationCache.get(columnId)
      },

      setColumnTypeOverride: (datasetId, columnId, overrideType) =>
        set(
          state => {
            const key = `${datasetId}:${columnId}`
            const nextOverrides = new Map(state.columnTypeOverrides)
            if (overrideType === null) {
              nextOverrides.delete(key)
            } else {
              nextOverrides.set(key, overrideType)
            }
            return { columnTypeOverrides: nextOverrides }
          },
          undefined,
          'setColumnTypeOverride'
        ),

      getColumnTypeOverride: (datasetId, columnId) => {
        const key = `${datasetId}:${columnId}`
        return get().columnTypeOverrides.get(key)
      },

      shouldReclassifyColumn: (columnId: string) => {
        const state = get()
        const cached = state.columnClassificationCache.get(columnId)

        // Re-classify if:
        // 1. Column is in invalidatedColumnIds, OR
        // 2. No cached classification exists
        return (
          state.invalidatedColumnIds.has(columnId) ||
          !cached
        )
      },

      clearAllInvalidation: () =>
        set(
          {
            invalidatedColumnIds: new Set<string>(),
            columnClassificationCache: new Map<string, CachedClassification>(),
          },
          undefined,
          'clearAllInvalidation'
        ),

      // Formula persistence mirror actions (Phase 7 - Formula Engine)
      // NOTE: Passive getters/setters for save/load only. FormulaService is the source of truth.
      getDatasetFormulas: (datasetId: string) => {
        return get().datasetFormulas.get(datasetId) ?? new Map<string, string>()
      },

      setDatasetFormulas: (datasetId: string, formulas: Map<string, string>) =>
        set(
          state => {
            const newMap = new Map(state.datasetFormulas)
            newMap.set(datasetId, formulas)
            return { datasetFormulas: newMap }
          },
          undefined,
          'setDatasetFormulas'
        ),

      // Transform snapshot actions (for revert capability)
      saveTransformSnapshot: (snapshot: TransformSnapshot) =>
        set(
          state => {
            const newSnapshots = new Map(state.transformSnapshots)
            newSnapshots.set(snapshot.datasetId, snapshot)
            return { transformSnapshots: newSnapshots }
          },
          undefined,
          'saveTransformSnapshot'
        ),

      getTransformSnapshot: (datasetId: string) => {
        return get().transformSnapshots.get(datasetId)
      },

      clearTransformSnapshot: (datasetId: string) =>
        set(
          state => {
            const newSnapshots = new Map(state.transformSnapshots)
            newSnapshots.delete(datasetId)
            return { transformSnapshots: newSnapshots }
          },
          undefined,
          'clearTransformSnapshot'
        ),

      hasTransformSnapshot: (datasetId: string) => {
        return get().transformSnapshots.has(datasetId)
      },

      // Cell highlights (Excel-style fill color)
      setHighlight: (datasetId: string, row: number, columnId: string, color: string) =>
        set(
          state => {
            const targetDataset = state.datasets.find(d => d.id === datasetId)
            if (!targetDataset) return state

            const cellKey = `${row}:${columnId}`
            const updatedHighlights = { ...(targetDataset.highlights || {}) }
            updatedHighlights[cellKey] = color

            const updatedDatasets = state.datasets.map(d =>
              d.id === datasetId
                ? { ...d, highlights: updatedHighlights, modifiedAt: new Date() }
                : d
            )

            return {
              datasets: updatedDatasets,
              currentDataset:
                state.currentDataset?.id === datasetId
                  ? { ...state.currentDataset, highlights: updatedHighlights, modifiedAt: new Date() }
                  : state.currentDataset,
            }
          },
          undefined,
          'setHighlight'
        ),

      removeHighlight: (datasetId: string, row: number, columnId: string) =>
        set(
          state => {
            const targetDataset = state.datasets.find(d => d.id === datasetId)
            if (!targetDataset || !targetDataset.highlights) return state

            const cellKey = `${row}:${columnId}`
            const updatedHighlights = { ...targetDataset.highlights }
            delete updatedHighlights[cellKey]

            const updatedDatasets = state.datasets.map(d =>
              d.id === datasetId
                ? { ...d, highlights: updatedHighlights, modifiedAt: new Date() }
                : d
            )

            return {
              datasets: updatedDatasets,
              currentDataset:
                state.currentDataset?.id === datasetId
                  ? { ...state.currentDataset, highlights: updatedHighlights, modifiedAt: new Date() }
                  : state.currentDataset,
            }
          },
          undefined,
          'removeHighlight'
        ),

      setHighlightsBatch: (datasetId: string, cellKeys: string[], color: string) =>
        set(
          state => {
            if (cellKeys.length === 0) return state
            const targetDataset = state.datasets.find(d => d.id === datasetId)
            if (!targetDataset) return state

            const updatedHighlights = { ...(targetDataset.highlights || {}) }
            for (const cellKey of cellKeys) {
              updatedHighlights[cellKey] = color
            }

            const updatedDatasets = state.datasets.map(d =>
              d.id === datasetId
                ? { ...d, highlights: updatedHighlights, modifiedAt: new Date() }
                : d
            )

            return {
              datasets: updatedDatasets,
              currentDataset:
                state.currentDataset?.id === datasetId
                  ? { ...state.currentDataset, highlights: updatedHighlights, modifiedAt: new Date() }
                  : state.currentDataset,
            }
          },
          undefined,
          'setHighlightsBatch'
        ),

      removeHighlightsBatch: (datasetId: string, cellKeys: string[]) =>
        set(
          state => {
            if (cellKeys.length === 0) return state
            const targetDataset = state.datasets.find(d => d.id === datasetId)
            if (!targetDataset || !targetDataset.highlights) return state

            const updatedHighlights = { ...targetDataset.highlights }
            for (const cellKey of cellKeys) {
              delete updatedHighlights[cellKey]
            }

            const hasHighlights = Object.keys(updatedHighlights).length > 0
            const nextHighlights = hasHighlights ? updatedHighlights : undefined

            const updatedDatasets = state.datasets.map(d =>
              d.id === datasetId
                ? { ...d, highlights: nextHighlights, modifiedAt: new Date() }
                : d
            )

            return {
              datasets: updatedDatasets,
              currentDataset:
                state.currentDataset?.id === datasetId
                  ? { ...state.currentDataset, highlights: nextHighlights, modifiedAt: new Date() }
                  : state.currentDataset,
            }
          },
          undefined,
          'removeHighlightsBatch'
        ),

      clearHighlights: (datasetId: string) =>
        set(
          state => {
            const targetDataset = state.datasets.find(d => d.id === datasetId)
            if (!targetDataset) return state

            const updatedDatasets = state.datasets.map(d =>
              d.id === datasetId
                ? { ...d, highlights: undefined, modifiedAt: new Date() }
                : d
            )

            return {
              datasets: updatedDatasets,
              currentDataset:
                state.currentDataset?.id === datasetId
                  ? { ...state.currentDataset, highlights: undefined, modifiedAt: new Date() }
                  : state.currentDataset,
            }
          },
          undefined,
          'clearHighlights'
        ),

      getHighlight: (datasetId: string, row: number, columnId: string) => {
        const dataset = get().datasets.find(d => d.id === datasetId)
        if (!dataset?.highlights) return undefined
        const cellKey = `${row}:${columnId}`
        return dataset.highlights[cellKey]
      },

      // Family-aware selectors (Phase C - Family/Child Isolation)
      getDatasetsByFamily: (familyId: string) => {
        return get().datasets.filter(d => d.familyId === familyId)
      },

      setDatasetFamily: (datasetId: string, familyId: string) =>
        set(
          state => {
            const target = state.datasets.find(d => d.id === datasetId)
            if (target?.familyId && target.familyId !== familyId) {
              console.warn(
                `Refusing to reassign dataset '${datasetId}' from family '${target.familyId}' to '${familyId}'.`
              )
              return {}
            }
            return {
              datasets: state.datasets.map(d =>
                d.id === datasetId ? { ...d, familyId, modifiedAt: new Date() } : d
              ),
              currentDataset:
                state.currentDataset?.id === datasetId
                  ? { ...state.currentDataset, familyId, modifiedAt: new Date() }
                  : state.currentDataset,
            }
          },
          undefined,
          'setDatasetFamily'
        ),

      clearDatasetsByFamily: (familyId: string) =>
        set(
          state => {
            const datasetsToRemove = state.datasets.filter(d => d.familyId === familyId)
            const datasetIdsToRemove = new Set(datasetsToRemove.map(d => d.id))

            // Clean up formula mirrors and transform snapshots for removed datasets
            const newFormulas = new Map(state.datasetFormulas)
            const newTransformSnapshots = new Map(state.transformSnapshots)
            const newTypeOverrides = new Map(state.columnTypeOverrides)
            datasetIdsToRemove.forEach(id => {
              newFormulas.delete(id)
              newTransformSnapshots.delete(id)
              for (const key of Array.from(newTypeOverrides.keys())) {
                if (key.startsWith(`${id}:`)) {
                  newTypeOverrides.delete(key)
                }
              }
            })

            const isRemovingActive = state.currentDataset
              ? datasetIdsToRemove.has(state.currentDataset.id)
              : false

            return {
              datasets: state.datasets.filter(d => d.familyId !== familyId),
              currentDataset: isRemovingActive ? null : state.currentDataset,
              datasetFormulas: newFormulas,
              transformSnapshots: newTransformSnapshots,
              columnTypeOverrides: newTypeOverrides,
              // Clear invalidation state if removing the active dataset
              ...(isRemovingActive
                ? {
                    invalidatedColumnIds: new Set<string>(),
                    columnClassificationCache: new Map<string, CachedClassification>(),
                  }
                : {}),
            }
          },
          undefined,
          'clearDatasetsByFamily'
        ),
    }),
    {
      name: 'data-store',
    }
  )
)
