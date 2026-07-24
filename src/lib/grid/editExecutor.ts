/**
 * Edit Executor - Unified Edit Pipeline
 *
 * Single entry point for ALL edit operations in the grid.
 * Ensures consistent side effects regardless of edit source.
 *
 * GUARANTEED SIDE EFFECTS (in order):
 * 1. Apply to local rowData (immediate UI feedback)
 * 2. Apply to data-store (dataCache) - COMPUTED values
 * 3. Queue backend sync (cacheService)
 * 4. Push to undo stack (skip for undo/redo/formula source)
 * 5. Mark affected columns as invalidated
 * 6. Update "green dot" if non-empty values
 * 7. Formula evaluation and dependent recalculation (Phase 7)
 *
 * @see GRID_ENHANCEMENT_PLAN.md - Phase 1, Phase 7
 */

import { cacheService } from '@/services/cacheService'
import { undoService, type CellEditInfo } from '@/services/undoService'
import { logRuntimeDebug } from '@/lib/debug/runtimeDebug'
import { FormulaService } from '@/lib/grid/formulas/formulaService'
import type {
  CellEdit,
  EditSource,
  EditBatch,
  EditExecutorConfig,
  EditExecutorDependencies,
  CellUpdate,
} from './types'
import { shouldPushToUndo } from './types'
import { getEditRowBounds } from './editBounds'
import { cloneRowDataPreservingSentinel } from './rowDataSentinel'

/**
 * Default dependencies using real services
 */
const defaultDependencies: EditExecutorDependencies = {
  cacheService: {
    queueCellUpdate: cacheService.queueCellUpdate.bind(cacheService),
    updateCellsBatch: cacheService.updateCellsBatch.bind(cacheService),
    enqueueGridMutationBatch: cacheService.enqueueGridMutationBatch.bind(cacheService),
    flushGridMutationQueue: cacheService.flushGridMutationQueue.bind(cacheService),
    scheduleOverlayFlush: cacheService.scheduleOverlayFlush.bind(cacheService),
  },
  undoService: {
    pushCellEdit: undoService.pushCellEdit.bind(undoService),
    pushBatchCellEdit: undoService.pushBatchCellEdit.bind(undoService),
    enqueueBatchCellEdit: undoService.enqueueBatchCellEdit.bind(undoService),
    trackPendingBatchRegistration: undoService.trackPendingBatchRegistration.bind(undoService),
  },
}

// Large paste undo payloads can make IPC serialization the dominant latency.
// Keep small batches synchronous, but decouple large batches from the execute critical path.
const LARGE_BATCH_UNDO_ASYNC_THRESHOLD = 1000

export interface EditExecutionResult {
  backendSyncSucceeded: boolean
}

export function applyEditsToDataStore(
  config: EditExecutorConfig,
  edits: CellEdit[]
): void {
  if (edits.length === 0) return

  if (edits.length > 1 && config.updateCellsBatch) {
    const updates = edits.map((edit) => ({
      row: edit.row,
      columnId: edit.columnId,
      value: edit.computedValue ?? edit.newValue, // COMPUTED, not raw
    }))
    config.updateCellsBatch(config.datasetId, updates)
    return
  }

  for (const edit of edits) {
    config.updateCellValue(
      config.datasetId,
      edit.row,
      edit.columnId,
      edit.computedValue ?? edit.newValue // COMPUTED, not raw
    )
  }
}

/**
 * Execute a batch of edits with all side effects
 *
 * CRITICAL: Steps 5-6 (invalidation, green dot) are GUARANTEED
 * to run even if backend sync or undo push fails. This ensures analysis
 * triggers correctly regardless of network/backend issues.
 *
 * @param config - Configuration with dataset context and callbacks
 * @param batch - The edits to apply
 * @param deps - External service dependencies (defaults to real services)
 */
export async function executeEdits(
  config: EditExecutorConfig,
  batch: EditBatch,
  deps: EditExecutorDependencies = defaultDependencies
): Promise<EditExecutionResult> {
  const { edits, source } = batch
  const isPasteLikeSource = source === 'paste' || source === 'paste-transpose'
  const executeStartedAt = isPasteLikeSource ? Date.now() : 0
  if (isPasteLikeSource) {
    logRuntimeDebug('paste', 'paste_edit_execute_start', {
      datasetId: config.datasetId,
      source,
      editCount: edits.length,
    })
  }
  // Capture family context once at operation start to avoid using activeFamilyId
  // at async completion time.
  const capturedFamilyIdForBinding = config.getActiveFamilyId?.()

  if (edits.length === 0) {
    return { backendSyncSucceeded: true }
  }

  let backendSyncSucceeded = true

  // Resolve columns at execution time so overflow columns added just before this
  // call are visible. getColumns() (if provided) takes precedence over the frozen
  // `columns` snapshot captured at executor-construction time.
  //
  // Defensive: if getColumns throws (e.g. store torn down mid-operation), fall back
  // to the static snapshot. Null/invalid entries are sanitized out before indexing
  // so a malformed array can't cause a null-dereference inside the loops below.
  //
  // Presence-based gate (hasColumnConfig) is intentional: an empty-but-provided
  // columns array still enables the volatile/dependency recalc passes in Step 7,
  // which don't require positional lookup.
  const hasColumnConfig = config.columns != null || config.getColumns != null
  let rawCols: Array<{ id: string }>
  try {
    rawCols = config.getColumns != null ? config.getColumns() : (config.columns ?? [])
  } catch {
    rawCols = config.columns ?? []
  }
  const effectiveCols = rawCols.filter(
    (c): c is { id: string } => typeof c?.id === 'string' && c.id.length > 0
  )
  // O(1) column index lookups; first occurrence wins for duplicate ids.
  const columnIndexMap = new Map<string, number>()
  for (let i = 0; i < effectiveCols.length; i++) {
    const id = effectiveCols[i]!.id
    if (!columnIndexMap.has(id)) columnIndexMap.set(id, i)
  }

  // Step 0 (Phase 7): Formula evaluation - happens BEFORE applying to stores
  // Only run for non-formula sources to avoid infinite loop
  if (source !== 'formula' && config.formulaService && hasColumnConfig) {
    const formulaService = config.formulaService

    // Evaluate each formula and set computedValue
    for (const edit of edits) {
      const value = edit.newValue

      // Check if this is a formula
      if (formulaService.isFormula(value)) {
        // Find column index for position (O(1) via pre-built map)
        const colIndex = columnIndexMap.get(edit.columnId) ?? -1
        if (colIndex >= 0) {
          // Position for parser (1-based)
          const position = {
            row: edit.row + 1,
            col: colIndex + 1,
            sheet: 'Sheet1',
          }

          // Evaluate the formula
          const result = formulaService.evaluate(value as string, position)

          // Set computed value (either result or error message)
          edit.computedValue = result.error
            ? `#ERROR: ${result.error.message}`
            : result.value
          logRuntimeDebug('grid', 'formula_sync_eval_result', {
            datasetId: config.datasetId,
            row: edit.row,
            columnId: edit.columnId,
            formula: value as string,
            resultType: result.error ? 'error' : 'value',
            computedValue: edit.computedValue,
          })
        }
      }
    }
  }

  // Collect affected columns (deduplicated)
  const affectedColumnIds = [...new Set(edits.map((e) => e.columnId))]

  // Step 1: Apply to local rowData (immediate UI feedback) - SYNC, ALWAYS RUNS
  config.setRowData((prev) => {
    const updated = new Map(prev)
    for (const edit of edits) {
      if (batch.shouldSkipLocalRowDataWrite?.(edit.row, edit)) continue
      const row = cloneRowDataPreservingSentinel(updated.get(edit.row))
      // Store COMPUTED value for display (not raw formula)
      row[edit.columnId] = edit.computedValue ?? edit.newValue
      updated.set(edit.row, row)
    }
    return updated
  })

  // Step 2: Apply to data-store (dataCache) - SYNC unless a paste job coalesces
  // chunk-local writes and calls applyEditsToDataStore once at finalize.
  if (!batch.skipDataStoreUpdate) {
    applyEditsToDataStore(config, edits)
  }

  // Steps 3-4 are BEST-EFFORT: failures are logged but don't block invalidation
  // This ensures analysis triggers correctly even if backend is down

  // Step 3: Queue backend sync (cacheService) - BEST EFFORT
  if (!batch.skipBackendSync) {
    try {
      const shouldSyncValue = (value: unknown) =>
        value !== FormulaService.CALC_PENDING_SENTINEL
      if (edits.length === 1) {
        const edit = edits[0]!
        const valueToSync = edit.computedValue ?? edit.newValue
        if (shouldSyncValue(valueToSync)) {
          deps.cacheService.queueCellUpdate(
            config.datasetId,
            edit.row,
            edit.columnId,
            valueToSync
          )
        }
      } else {
        const updates: CellUpdate[] = edits
          .map((e) => ({
            row: e.row,
            column: e.columnId,
            value: e.computedValue ?? e.newValue,
          }))
          .filter((u) => shouldSyncValue(u.value))
        if (updates.length > 0) {
          if (deps.cacheService.enqueueGridMutationBatch) {
            const chunkSize = batch.backendSyncChunkSize && batch.backendSyncChunkSize > 0
              ? Math.floor(batch.backendSyncChunkSize)
              : updates.length
            const updateChunks = chunkSize < updates.length
              ? Array.from({ length: Math.ceil(updates.length / chunkSize) }, (_, index) =>
                  updates.slice(index * chunkSize, (index + 1) * chunkSize)
                )
              : [updates]
            if (isPasteLikeSource) {
              logRuntimeDebug('paste', 'paste_enqueue_batch_start', {
                datasetId: config.datasetId,
                source,
                updateCount: updates.length,
                chunkCount: updateChunks.length,
              })
            }
            for (const updateChunk of updateChunks) {
              await deps.cacheService.enqueueGridMutationBatch(config.datasetId, updateChunk)
              if (batch.flushBackendChunks && deps.cacheService.flushGridMutationQueue) {
                await deps.cacheService.flushGridMutationQueue(config.datasetId)
              }
            }
            if (isPasteLikeSource) {
              logRuntimeDebug('paste', 'paste_enqueue_batch_done', {
                datasetId: config.datasetId,
                source,
                updateCount: updates.length,
                chunkCount: updateChunks.length,
              })
            }
            if (
              (source === 'paste' || source === 'paste-transpose') &&
              deps.cacheService.scheduleOverlayFlush
            ) {
              deps.cacheService.scheduleOverlayFlush(config.datasetId)
            }
          } else {
            await deps.cacheService.updateCellsBatch(config.datasetId, updates)
          }
        }
      }
    } catch (error) {
      backendSyncSucceeded = false
      // Log but don't throw - UI is already updated, version bump must happen
      if (import.meta.env.DEV) {
        console.error('[EditExecutor] Backend sync failed (UI still updated):', error)
      }
    }
  }

  // Step 4: Push to undo stack (skip for undo/redo/formula source) - BEST EFFORT
  if (!batch.skipUndoRegistration && shouldPushToUndo(source)) {
    try {
      if (edits.length === 1) {
        const edit = edits[0]!
        await deps.undoService.pushCellEdit(
          config.datasetId,
          edit.row,
          edit.columnId,
          edit.oldValue,
          edit.newValue // Store RAW for undo (including formula string)
        )
      } else {
        const cellEdits: CellEditInfo[] = edits.map((e) => ({
          row: e.row,
          column: e.columnId,
          oldValue: e.oldValue,
          newValue: e.newValue, // Store RAW for undo
        }))
        if (cellEdits.length > LARGE_BATCH_UNDO_ASYNC_THRESHOLD) {
          const pendingBatchRegistration = deps.undoService.enqueueBatchCellEdit
            ? deps.undoService.enqueueBatchCellEdit(config.datasetId, cellEdits)
            : deps.undoService.pushBatchCellEdit(config.datasetId, cellEdits)
          deps.undoService.trackPendingBatchRegistration?.(
            config.datasetId,
            pendingBatchRegistration
          )
          void pendingBatchRegistration.catch((error) => {
            console.error('[EditExecutor] Async batch undo push failed:', error)
          })
        } else {
          await deps.undoService.pushBatchCellEdit(config.datasetId, cellEdits)
        }
      }
    } catch (error) {
      // Log but don't throw - version bump must happen for analysis triggers
      if (import.meta.env.DEV) {
        console.error('[EditExecutor] Undo push failed:', error)
      }
    }
  }

  // Steps 5-6 are GUARANTEED to run - these are critical for analysis triggers

  // Step 5: Mark affected columns as invalidated - ALWAYS RUNS
  config.invalidateColumns(affectedColumnIds)

  // Step 6: Update family binding for non-paste sources.
  // Paste flows own their explicit captured-family binding in SpreadsheetView handlers.
  const isPasteSource = source === 'paste' || source === 'paste-transpose'
  if (config.updateActiveFamilyData && !isPasteSource) {
    const hasNonEmpty = edits.some((e) => {
      const v = e.computedValue ?? e.newValue
      return v !== null && v !== undefined && String(v).trim() !== ''
    })
    if (hasNonEmpty) {
      config.updateActiveFamilyData(config.datasetId, capturedFamilyIdForBinding)
    }
  }

  // Step 6.5: Bump dataRowCount for paste recognition (Part 2 - SAVE_AND_PASTE_FIX_PLAN)
  // This ensures ColumnSelectionDialog can read pasted/typed data
  const rowBounds = getEditRowBounds(edits)
  if (rowBounds && config.bumpDataRowCount) {
    config.bumpDataRowCount(rowBounds.maxRow)
  }

  // Step 6.6: Mark project as dirty (Part 1 - Smart Save)
  // Only mark dirty for user-initiated edits (not formula recalc)
  if (!batch.skipProjectDirty && source !== 'formula' && config.markProjectDirty) {
    config.markProjectDirty()
  }

  // Step 7 (Phase 7): Register formulas and recalculate dependents with column-level invalidation
  // Only run for non-formula sources to avoid infinite loop
  if (source !== 'formula' && config.formulaService && hasColumnConfig) {
    const formulaService = config.formulaService
    const editedColumnIds = new Set<string>()
    const editedCellKeys = new Set<string>()

    // Register/unregister formulas and collect edited columns
    for (const edit of edits) {
      const cellKey = `${edit.row}:${edit.columnId}`
      const value = edit.newValue
      editedCellKeys.add(cellKey)

      // Track which columns were edited (for column-level dependency invalidation)
      editedColumnIds.add(edit.columnId)

      // Check if this is a formula
      if (formulaService.isFormula(value)) {
        // Find column index for position
        const colIndex = columnIndexMap.get(edit.columnId) ?? -1
        if (colIndex >= 0) {
          // Position for parser (1-based)
          const position = {
            row: edit.row + 1,
            col: colIndex + 1,
            sheet: 'Sheet1',
          }

          // Register formula in service for dependency tracking
          formulaService.registerFormula(cellKey, value as string, position)
        }
      } else {
        // Not a formula - if cell previously had formula, unregister it
        formulaService.unregisterFormula(cellKey)
      }
    }

    // Column-level dependency invalidation: find all formulas that depend on edited columns
    const dependentCellKeys = formulaService.getDependentsForColumns(
      Array.from(editedColumnIds)
    )

    const recalculatedByCell = new Map<string, ReturnType<typeof formulaService.recalculateFormulaCells>[number]>()
    const formulaEdits = dependentCellKeys.length > 0
      ? formulaService.recalculateFormulaCells(dependentCellKeys)
      : []
    for (const edit of formulaEdits) {
      recalculatedByCell.set(`${edit.row}:${edit.columnId}`, edit)
    }

    const volatileEdits = formulaService.recalculateVolatileCells(editedCellKeys)
    for (const edit of volatileEdits) {
      recalculatedByCell.set(`${edit.row}:${edit.columnId}`, edit)
    }

    if (recalculatedByCell.size > 0) {
      const dependentEdits: CellEdit[] = Array.from(recalculatedByCell.values()).map((fe) => ({
        row: fe.row,
        columnId: fe.columnId,
        oldValue: null,
        newValue: fe.computedValue,
        computedValue: fe.error ? `#ERROR: ${fe.error.message}` : fe.computedValue,
      }))
      logRuntimeDebug('grid', 'formula_dependents_recalculated', {
        datasetId: config.datasetId,
        source,
        directEditCount: edits.length,
        dependentEditCount: dependentEdits.length,
        dependentCells: dependentEdits.map((edit) => `${edit.row}:${edit.columnId}`),
      })

      // Recursive call: source='formula' causes Steps 0 and 7 to be skipped in the
      // child frame (infinite-loop guard), so getColumns() is called a second time
      // but only to resolve effectiveCols for the column-index map — the map itself
      // is unused in the recursive frame. This is safe and intentional.
      await executeEdits(
        config,
        {
          edits: dependentEdits,
          source: 'formula',
          timestamp: Date.now(),
          shouldSkipLocalRowDataWrite: batch.shouldSkipLocalRowDataWrite,
        },
        deps
      )
    }
  }

  if (isPasteLikeSource) {
    logRuntimeDebug('paste', 'paste_edit_execute_done', {
      datasetId: config.datasetId,
      source,
      editCount: edits.length,
      durationMs: Date.now() - executeStartedAt,
    })
  }

  return { backendSyncSucceeded }
}

/**
 * Create a configured edit executor bound to a dataset
 *
 * @param config - Configuration with dataset context and callbacks
 * @param deps - External service dependencies (defaults to real services)
 * @returns Object with execute method
 */
export function createEditExecutor(
  config: EditExecutorConfig,
  deps: EditExecutorDependencies = defaultDependencies
) {
  return {
    /**
     * Execute a batch of edits
     */
    execute: async (
      edits: CellEdit[],
      source: EditSource,
      options?: Pick<EditBatch, 'skipUndoRegistration' | 'skipBackendSync' | 'skipDataStoreUpdate' | 'backendSyncChunkSize' | 'flushBackendChunks' | 'skipProjectDirty' | 'shouldSkipLocalRowDataWrite'>
    ): Promise<EditExecutionResult> => {
      return await executeEdits(
        config,
        {
          edits,
          source,
          timestamp: Date.now(),
          ...options,
        },
        deps
      )
    },

    /**
     * Execute a single edit (convenience method)
     */
    executeSingle: async (
      edit: CellEdit,
      source: EditSource,
      options?: Pick<EditBatch, 'skipUndoRegistration' | 'skipBackendSync' | 'skipDataStoreUpdate' | 'backendSyncChunkSize' | 'flushBackendChunks' | 'skipProjectDirty' | 'shouldSkipLocalRowDataWrite'>
    ): Promise<EditExecutionResult> => {
      return await executeEdits(
        config,
        {
          edits: [edit],
          source,
          timestamp: Date.now(),
          ...options,
        },
        deps
      )
    },

    /**
     * Apply a deferred frontend data-store update for a completed edit batch.
     */
    applyDataStoreUpdate: (edits: CellEdit[]): void => {
      applyEditsToDataStore(config, edits)
    },
  }
}

/**
 * Type for the edit executor instance
 */
export type EditExecutor = ReturnType<typeof createEditExecutor>
