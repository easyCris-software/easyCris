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
  /** Skip backend undo registration when frontend transaction stack owns undo */
  skipUndoRegistration?: boolean
  /** Skip backend persistence when replaying a local-only rollback */
  skipBackendSync?: boolean
  /** Skip frontend data-store/dataCache writes so a caller can coalesce them later */
  skipDataStoreUpdate?: boolean
  /** Split backend persistence into chunks to avoid one oversized IPC payload */
  backendSyncChunkSize?: number
  /** Await the backend mutation queue after each backend sync chunk */
  flushBackendChunks?: boolean
  /** Skip dirty-marking for local rollback replays */
  skipProjectDirty?: boolean
  /** Skip local rowData writes for rows that should remain backend-loaded */
  shouldSkipLocalRowDataWrite?: (row: number, edit: CellEdit) => boolean
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

export type GridMutationKind =
  | 'type'
  | 'fill'
  | 'paste'
  | 'paste-values'
  | 'paste-transpose'
  | 'cut'
  | 'delete'
  | 'rename'
  | 'undo'
  | 'redo'

export type GridBlockState = 'loaded' | 'dirty' | 'reloading'

export type GridMutationQueueStatus = 'idle' | 'draining' | 'failed'

export interface GridMutationQueueState {
  status: GridMutationQueueStatus
  failedQueueId: string | null
  error: string | null
}

export interface GridTransactionRecord {
  id: string
  datasetId: string
  kind: GridMutationKind
  edits?: CellEdit[]
  columnRenames?: Array<{
    columnId: string
    oldName: string
    newName: string
  }>
  structural?: {
    insertedRows?: Array<{ start: number; count: number }>
    removedRows?: Array<{ start: number; count: number }>
  }
  mutationRevision?: number
  selectionRevision?: number
  largePasteUndoPolicy?: {
    kind: 'clear-range' | 'backend-clear-range'
    editCount: number
  }
  backendPasteBlock?: {
    kind: 'backend-paste-block'
    rows: number[]
    columnIds: string[]
    values: unknown[][]
    undoValues?: unknown[][]
  }
  persistAccepted?: boolean
  rejectionReason?: 'stale_paste_context' | 'mutation_rejected'
  persistSource?: 'paste' | 'paste-values' | 'paste-transpose' | 'e2e-paste'
  clipboardContext?: {
    source: 'copy' | 'cut'
    copyOpId?: string
    sourceDatasetId?: string
    sourceFamilyId?: string
  }
}

export interface ApplyGridMutationInput {
  id: string
  datasetId: string
  kind: GridMutationKind
  transaction?: GridTransactionRecord
}

export interface GridMutationResult {
  transaction: GridTransactionRecord
}

export type GridMutationLifecycleStage =
  | 'start'
  | 'plan'
  | 'applyLocal'
  | 'enqueuePersist'
  | 'finalizeUI'
  | 'persisted'

export interface GridMutationLifecycleEvent {
  stage: GridMutationLifecycleStage
  transaction: GridTransactionRecord
}

export interface GridMutationCoordinatorDeps {
  onLifecycle?: (event: GridMutationLifecycleEvent) => void
  plan: (input: ApplyGridMutationInput) => Promise<GridTransactionRecord> | GridTransactionRecord
  applyLocal: (transaction: GridTransactionRecord) => Promise<void> | void
  enqueuePersist: (transaction: GridTransactionRecord) => Promise<void> | void
  finalizeUI: (transaction: GridTransactionRecord) => Promise<void> | void
}

export interface GridMutationCoordinator {
  applyGridMutation(input: ApplyGridMutationInput): Promise<GridMutationResult>
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
  /** Batch data store updater (single-store-write fast path for multi-cell edits) */
  updateCellsBatch?: (
    datasetId: string,
    updates: Array<{ row: number; columnId: string; value: unknown }>
  ) => void

  /** Mark columns as needing reclassification */
  invalidateColumns: (columnIds: string[]) => void

  /**
   * Update family binding/"green dot" indicator (optional).
   * Caller may pass a captured familyId to avoid async completion races.
   */
  updateActiveFamilyData?: (datasetId: string, familyId?: string | null) => void

  /**
   * Returns active family at operation start.
   * Used by executeEdits to capture family context before async work.
   */
  getActiveFamilyId?: () => string | null

  /** Formula service for formula evaluation (optional - Phase 7) */
  formulaService?: FormulaServiceInterface

  /** Column lookup for formula A1 notation (required if formulaService provided) */
  columns?: Array<{ id: string }>

  /**
   * Dynamic column lookup — called at execution time instead of using the frozen
   * `columns` snapshot. When provided, takes precedence over `columns`.
   *
   * Use this when columns may have been added between executor construction and
   * the edit call (e.g. paste with column overflow expansion).
   */
  getColumns?: () => Array<{ id: string }>

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
    enqueueGridMutationBatch?: (
      datasetId: string,
      edits: CellUpdate[]
    ) => Promise<{ accepted: true; queueId: string }>
    flushGridMutationQueue?: (datasetId: string) => Promise<void>
    scheduleOverlayFlush?: (datasetId: string) => void
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
    enqueueBatchCellEdit?: (
      datasetId: string,
      edits: Array<{
        row: number
        column: string
        oldValue: unknown
        newValue: unknown
      }>
    ) => Promise<unknown>
    trackPendingBatchRegistration?: (datasetId: string, pending: Promise<unknown>) => void
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
