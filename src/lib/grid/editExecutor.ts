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

/**
 * Default dependencies using real services
 */
const defaultDependencies: EditExecutorDependencies = {
  cacheService: {
    queueCellUpdate: cacheService.queueCellUpdate.bind(cacheService),
    updateCellsBatch: cacheService.updateCellsBatch.bind(cacheService),
  },
  undoService: {
    pushCellEdit: undoService.pushCellEdit.bind(undoService),
    pushBatchCellEdit: undoService.pushBatchCellEdit.bind(undoService),
  },
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
): Promise<void> {
  const { edits, source } = batch

  if (edits.length === 0) {
    return
  }

  // Step 0 (Phase 7): Formula evaluation - happens BEFORE applying to stores
  // Only run for non-formula sources to avoid infinite loop
  if (source !== 'formula' && config.formulaService && config.columns) {
    const formulaService = config.formulaService

    // Evaluate each formula and set computedValue
    for (const edit of edits) {
      const value = edit.newValue

      // Check if this is a formula
      if (formulaService.isFormula(value)) {
        // Find column index for position
        const colIndex = config.columns.findIndex((c) => c.id === edit.columnId)
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
      const row = { ...(updated.get(edit.row) || {}) }
      // Store COMPUTED value for display (not raw formula)
      row[edit.columnId] = edit.computedValue ?? edit.newValue
      updated.set(edit.row, row)
    }
    return updated
  })

  // Step 2: Apply to data-store (dataCache) - SYNC, ALWAYS RUNS
  for (const edit of edits) {
    config.updateCellValue(
      config.datasetId,
      edit.row,
      edit.columnId,
      edit.computedValue ?? edit.newValue // COMPUTED, not raw
    )
  }

  // Steps 3-4 are BEST-EFFORT: failures are logged but don't block invalidation
  // This ensures analysis triggers correctly even if backend is down

  // Step 3: Queue backend sync (cacheService) - BEST EFFORT
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
        await deps.cacheService.updateCellsBatch(config.datasetId, updates)
      }
    }
  } catch (error) {
    // Log but don't throw - UI is already updated, version bump must happen
    if (import.meta.env.DEV) {
      console.error('[EditExecutor] Backend sync failed (UI still updated):', error)
    }
  }

  // Step 4: Push to undo stack (skip for undo/redo/formula source) - BEST EFFORT
  if (shouldPushToUndo(source)) {
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
        await deps.undoService.pushBatchCellEdit(config.datasetId, cellEdits)
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

  // Step 6: Update "green dot" if any non-empty values - ALWAYS RUNS
  if (config.updateActiveFamilyData) {
    const hasNonEmpty = edits.some((e) => {
      const v = e.computedValue ?? e.newValue
      return v !== null && v !== undefined && String(v).trim() !== ''
    })
    if (hasNonEmpty) {
      config.updateActiveFamilyData(config.datasetId)
    }
  }

  // Step 6.5: Bump dataRowCount for paste recognition (Part 2 - SAVE_AND_PASTE_FIX_PLAN)
  // This ensures ColumnSelectionDialog can read pasted/typed data
  const maxRowIndex = Math.max(...edits.map((e) => e.row))
  if (Number.isFinite(maxRowIndex) && config.bumpDataRowCount) {
    config.bumpDataRowCount(maxRowIndex)
  }

  // Step 6.6: Mark project as dirty (Part 1 - Smart Save)
  // Only mark dirty for user-initiated edits (not formula recalc)
  if (source !== 'formula' && config.markProjectDirty) {
    config.markProjectDirty()
  }

  // Step 7 (Phase 7): Register formulas and recalculate dependents with column-level invalidation
  // Only run for non-formula sources to avoid infinite loop
  if (source !== 'formula' && config.formulaService && config.columns) {
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
        const colIndex = config.columns.findIndex((c) => c.id === edit.columnId)
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

      await executeEdits(
        config,
        {
          edits: dependentEdits,
          source: 'formula',
          timestamp: Date.now(),
        },
        deps
      )
    }
  }
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
    execute: async (edits: CellEdit[], source: EditSource): Promise<void> => {
      await executeEdits(
        config,
        {
          edits,
          source,
          timestamp: Date.now(),
        },
        deps
      )
    },

    /**
     * Execute a single edit (convenience method)
     */
    executeSingle: async (edit: CellEdit, source: EditSource): Promise<void> => {
      await executeEdits(
        config,
        {
          edits: [edit],
          source,
          timestamp: Date.now(),
        },
        deps
      )
    },
  }
}

/**
 * Type for the edit executor instance
 */
export type EditExecutor = ReturnType<typeof createEditExecutor>
