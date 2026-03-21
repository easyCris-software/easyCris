/**
 * Grid Types
 *
 * Shared types for the unified edit pipeline.
 * Used by EditExecutor, clipboard operations, and undo/redo.
 */

/**
 * Represents a single cell edit operation
 */
export interface CellEdit {
  /** Row index (0-based) */
  row: number
  /** Column identifier (stable ID, not index) */
  columnId: string
  /** Value before edit (for undo) */
  oldValue: unknown
  /** Value after edit (raw input, may be formula) */
  newValue: unknown
  /** If formula, the evaluated result (stored in dataCache) */
  computedValue?: unknown
}

/**
 * Source of the edit operation
 * Determines which side effects run (e.g., undo push)
 */
export type EditSource =
  | 'type' // User typing in cell
  | 'paste' // Paste from clipboard
  | 'paste-transpose' // Paste transpose (Ctrl+T)
  | 'cut' // Cut (clears cells)
  | 'delete' // Delete key
  | 'fill' // Fill handle drag
  | 'formula' // Formula recalculation (automatic)
  | 'undo' // Undo operation
  | 'redo' // Redo operation
  | 'replace' // Find & Replace single
  | 'replace-all' // Find & Replace all
  | 'highlight' // Cell highlight (fill color)

/**
 * A batch of edits to apply atomically
 */
export interface EditBatch {
  /** Edits to apply */
  edits: CellEdit[]
  /** Source of the edit operation */
  source: EditSource
  /** Timestamp of the operation */
  timestamp: number
  /** Selection context for multi-cell operations (optional) */
  selection?: {
    startRow: number
    startCol: number
    endRow: number
    endCol: number
  }
}

/**
 * Cell update for cache service
 */
export interface CellUpdate {
  row: number
  column: string
  value: unknown
}

/**
 * Formula service interface for formula evaluation (optional dependency)
 */
export interface FormulaServiceInterface {
  isFormula(value: unknown): value is string
  hasFormula(cellKey: string): boolean
  getFormula(cellKey: string): string | undefined
  evaluate(formula: string, position: { row: number; col: number; sheet?: string }): {
    value: unknown
    error?: { type: string; message: string }
  }
  registerFormula(
    cellKey: string,
    formula: string,
    position: { row: number; col: number; sheet?: string }
  ): void
  unregisterFormula(cellKey: string): void
  recalculateDependents(cellKey: string): Array<{
    row: number
    columnId: string
    computedValue: unknown
    error?: { type: string; message: string }
  }>
  // Column-level dependency invalidation (Phase 7)
  getDependentsForColumns(columnIds: string[]): string[]
  recalculateFormulaCells(cellKeys: string[]): Array<{
    row: number
    columnId: string
    computedValue: unknown
    error?: { type: string; message: string }
  }>
  recalculateVolatileCells(excludeCellKeys?: Iterable<string>): Array<{
    row: number
    columnId: string
    computedValue: unknown
    error?: { type: string; message: string }
  }>
  // Fill-handle with relative references (Phase 7)
  getFilledFormula(
    baseFormula: string,
    fromPos: { row: number; col: number },
    toPos: { row: number; col: number }
  ): string
}

/**
 * Configuration for EditExecutor
 * All external dependencies are injected via this config (dependency injection)
 */
export interface EditExecutorConfig {
  /** Dataset ID being edited */
  datasetId: string

  /** Local UI state updater (React setState for rowData) */
  setRowData: (
    updater: (prev: Map<number, Record<string, unknown>>) => Map<number, Record<string, unknown>>
  ) => void

  /** Data store updater (updates dataCache) */
  updateCellValue: (datasetId: string, row: number, col: string, value: unknown) => void

  /** Mark columns as needing reclassification */
  invalidateColumns: (columnIds: string[]) => void

  /** Update "green dot" indicator (optional) */
  updateActiveFamilyData?: (datasetId: string) => void

  /** Formula service for formula evaluation (optional - Phase 7) */
  formulaService?: FormulaServiceInterface

  /** Column lookup for formula A1 notation (required if formulaService provided) */
  columns?: Array<{ id: string }>

  /** Callback to bump dataRowCount when editing beyond current row count (Part 2: Paste Recognition) */
  bumpDataRowCount?: (maxRowIndex: number) => void

  /** Callback to mark project as dirty after edits (Part 1: Smart Save) */
  markProjectDirty?: () => void
}

/**
 * External service dependencies (injected for testability)
 * Return types use unknown to allow both real services and mocks
 */
export interface EditExecutorDependencies {
  /** Cache service for backend sync */
  cacheService: {
    queueCellUpdate: (datasetId: string, row: number, col: string, value: unknown) => void
    updateCellsBatch: (datasetId: string, edits: CellUpdate[]) => Promise<number>
  }

  /** Undo service for operation history */
  undoService: {
    pushCellEdit: (
      datasetId: string,
      row: number,
      column: string,
      oldValue: unknown,
      newValue: unknown
    ) => Promise<unknown>
    pushBatchCellEdit: (
      datasetId: string,
      edits: Array<{
        row: number
        column: string
        oldValue: unknown
        newValue: unknown
      }>
    ) => Promise<unknown>
  }
}

/**
 * Sources that should NOT push to undo stack
 * - undo/redo: Would create infinite loop
 * - formula: Derived changes, not user actions
 */
export const SKIP_UNDO_SOURCES: EditSource[] = ['undo', 'redo', 'formula']

/**
 * Check if a source should push to undo stack
 */
export function shouldPushToUndo(source: EditSource): boolean {
  return !SKIP_UNDO_SOURCES.includes(source)
}
