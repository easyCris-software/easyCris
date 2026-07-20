/**
 * Undo Service - Phase 4 Milestone 5
 *
 * Frontend service for undo/redo operations.
 * Integrates with Rust backend for persistent undo stack.
 */

import { invoke } from '@tauri-apps/api/core'
import {
  createRedoGridTransaction,
  createUndoGridTransaction,
} from '@/lib/grid/gridMutationCoordinator'
import type { GridTransactionRecord } from '@/lib/grid/types'

const pendingBatchRegistrations = new Map<string, Promise<unknown>>()
const pendingBatchRegistrationQueue = new Map<string, Promise<unknown>>()
const gridMutationUndoStacks = new Map<string, GridTransactionRecord[]>()
const gridMutationRedoStacks = new Map<string, GridTransactionRecord[]>()
const gridMutationRedoInvalidationGenerations = new Map<string, number>()
const pendingPreparedUndoTransactions = new Map<
  string,
  { original: GridTransactionRecord; restoreIndex: number }
>()
const pendingPreparedRedoTransactions = new Map<
  string,
  { original: GridTransactionRecord; restoreIndex: number; redoGeneration: number }
>()

function getRedoInvalidationGeneration(datasetId: string): number {
  return gridMutationRedoInvalidationGenerations.get(datasetId) ?? 0
}

function bumpRedoInvalidationGeneration(datasetId: string): void {
  gridMutationRedoInvalidationGenerations.set(datasetId, getRedoInvalidationGeneration(datasetId) + 1)
}

function clearAllGridTransactionHistory(): void {
  gridMutationUndoStacks.clear()
  gridMutationRedoStacks.clear()
  gridMutationRedoInvalidationGenerations.clear()
  pendingPreparedUndoTransactions.clear()
  pendingPreparedRedoTransactions.clear()
}

function cloneBackendPasteBlock(
  block: GridTransactionRecord['backendPasteBlock']
): GridTransactionRecord['backendPasteBlock'] {
  if (!block) return undefined
  return {
    kind: block.kind,
    rows: [...block.rows],
    columnIds: [...block.columnIds],
    values: block.values.map((rowValues) => [...rowValues]),
    undoValues: block.undoValues?.map((rowValues) => [...rowValues]),
  }
}

/**
 * Undo/Redo state from backend
 */
export interface UndoRedoState {
  can_undo: boolean
  can_redo: boolean
  undo_count: number
  redo_count: number
}

/**
 * Cell edit for batch operations
 */
export interface CellEditInfo {
  row: number
  column: string
  oldValue: unknown
  newValue: unknown
}

/**
 * Undo operation types (matches Rust UndoOperation)
 */
export type UndoOperation =
  | {
      type: 'CellEdit'
      dataset_id: string
      row: number
      column: string
      old_value: unknown
      new_value: unknown
    }
  | {
      type: 'BatchCellEdit'
      dataset_id: string
      edits: Array<{
        row: number
        column: string
        old_value: unknown
        new_value: unknown
      }>
    }
  | {
      type: 'ColumnRename'
      dataset_id: string
      column_id: string
      old_name: string
      new_name: string
    }
  | {
      type: 'RowInsert'
      dataset_id: string
      row_index: number
      row_data: Record<string, unknown>
    }
  | {
      type: 'ColumnInsert'
      dataset_id: string
      column_index: number
      column_id: string
      column_name: string
    }
  | {
      type: 'RowDelete'
      dataset_id: string
      row_index: number
      row_data: Record<string, unknown>
    }
  | {
      type: 'ColumnDelete'
      dataset_id: string
      column_index: number
      column_id: string
      column_name: string
      column_data: unknown[]
    }

/**
 * Undo service for managing edit history
 */
export const undoService = {
  async recordGridTransaction(
    datasetId: string,
    transaction: GridTransactionRecord
  ): Promise<void> {
    const undoStack = gridMutationUndoStacks.get(datasetId) ?? []
    undoStack.push({
      ...transaction,
      edits: transaction.edits?.map((edit) => ({ ...edit, computedValue: undefined })),
      backendPasteBlock: cloneBackendPasteBlock(transaction.backendPasteBlock),
      columnRenames: transaction.columnRenames?.map((rename) => ({ ...rename })),
      structural: transaction.structural
        ? {
            insertedRows: transaction.structural.insertedRows?.map((segment) => ({ ...segment })),
            removedRows: transaction.structural.removedRows?.map((segment) => ({ ...segment })),
          }
        : undefined,
    })
    gridMutationUndoStacks.set(datasetId, undoStack)
    gridMutationRedoStacks.delete(datasetId)
    bumpRedoInvalidationGeneration(datasetId)
  },

  async undoGridTransaction(datasetId: string): Promise<GridTransactionRecord | null> {
    const undoStack = gridMutationUndoStacks.get(datasetId)
    if (!undoStack || undoStack.length === 0) {
      return null
    }
    const original = undoStack.pop()!
    const redoStack = gridMutationRedoStacks.get(datasetId) ?? []
    redoStack.push(original)
    gridMutationRedoStacks.set(datasetId, redoStack)
    if (undoStack.length === 0) {
      gridMutationUndoStacks.delete(datasetId)
    }
    return createUndoGridTransaction(original)
  },

  async prepareUndoGridTransaction(datasetId: string): Promise<GridTransactionRecord | null> {
    if (pendingPreparedUndoTransactions.has(datasetId)) {
      return null
    }
    const undoStack = gridMutationUndoStacks.get(datasetId)
    if (!undoStack || undoStack.length === 0) {
      return null
    }
    const original = undoStack.pop()!
    if (undoStack.length === 0) {
      gridMutationUndoStacks.delete(datasetId)
    }
    pendingPreparedUndoTransactions.set(datasetId, {
      original,
      restoreIndex: undoStack.length,
    })
    return createUndoGridTransaction(original)
  },

  hasPreparedUndoGridTransaction(datasetId: string): boolean {
    return pendingPreparedUndoTransactions.has(datasetId)
  },

  async commitUndoGridTransaction(datasetId: string): Promise<void> {
    const pending = pendingPreparedUndoTransactions.get(datasetId)
    if (!pending) {
      return
    }
    const redoStack = gridMutationRedoStacks.get(datasetId) ?? []
    redoStack.push(pending.original)
    gridMutationRedoStacks.set(datasetId, redoStack)
    pendingPreparedUndoTransactions.delete(datasetId)
  },

  async rollbackUndoGridTransaction(datasetId: string): Promise<void> {
    const pending = pendingPreparedUndoTransactions.get(datasetId)
    if (!pending) {
      return
    }

    const undoStack = gridMutationUndoStacks.get(datasetId) ?? []
    undoStack.splice(pending.restoreIndex, 0, pending.original)
    gridMutationUndoStacks.set(datasetId, undoStack)
    pendingPreparedUndoTransactions.delete(datasetId)
  },

  async redoGridTransaction(datasetId: string): Promise<GridTransactionRecord | null> {
    const redoStack = gridMutationRedoStacks.get(datasetId)
    if (!redoStack || redoStack.length === 0) {
      return null
    }
    const original = redoStack.pop()!
    const undoStack = gridMutationUndoStacks.get(datasetId) ?? []
    undoStack.push(original)
    gridMutationUndoStacks.set(datasetId, undoStack)
    if (redoStack.length === 0) {
      gridMutationRedoStacks.delete(datasetId)
    }
    return createRedoGridTransaction(original)
  },

  async prepareRedoGridTransaction(datasetId: string): Promise<GridTransactionRecord | null> {
    if (pendingPreparedRedoTransactions.has(datasetId)) {
      return null
    }
    const redoStack = gridMutationRedoStacks.get(datasetId)
    if (!redoStack || redoStack.length === 0) {
      return null
    }
    const original = redoStack.pop()!
    if (redoStack.length === 0) {
      gridMutationRedoStacks.delete(datasetId)
    }
    pendingPreparedRedoTransactions.set(datasetId, {
      original,
      restoreIndex: redoStack.length,
      redoGeneration: getRedoInvalidationGeneration(datasetId),
    })
    return createRedoGridTransaction(original)
  },

  hasPreparedRedoGridTransaction(datasetId: string): boolean {
    return pendingPreparedRedoTransactions.has(datasetId)
  },

  async commitRedoGridTransaction(datasetId: string): Promise<void> {
    const pending = pendingPreparedRedoTransactions.get(datasetId)
    if (!pending) {
      return
    }
    const undoStack = gridMutationUndoStacks.get(datasetId) ?? []
    undoStack.push(pending.original)
    gridMutationUndoStacks.set(datasetId, undoStack)
    pendingPreparedRedoTransactions.delete(datasetId)
  },

  async rollbackRedoGridTransaction(datasetId: string): Promise<void> {
    const pending = pendingPreparedRedoTransactions.get(datasetId)
    if (!pending) {
      return
    }

    if (getRedoInvalidationGeneration(datasetId) !== pending.redoGeneration) {
      pendingPreparedRedoTransactions.delete(datasetId)
      return
    }

    const redoStack = gridMutationRedoStacks.get(datasetId) ?? []
    redoStack.splice(pending.restoreIndex, 0, pending.original)
    gridMutationRedoStacks.set(datasetId, redoStack)
    pendingPreparedRedoTransactions.delete(datasetId)
  },

  clearGridTransactionHistory(datasetId: string): void {
    gridMutationUndoStacks.delete(datasetId)
    gridMutationRedoStacks.delete(datasetId)
    gridMutationRedoInvalidationGenerations.delete(datasetId)
    pendingPreparedUndoTransactions.delete(datasetId)
    pendingPreparedRedoTransactions.delete(datasetId)
  },

  async enqueueBatchCellEdit(
    datasetId: string,
    edits: CellEditInfo[]
  ): Promise<UndoRedoState> {
    const previous = pendingBatchRegistrationQueue.get(datasetId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => this.pushBatchCellEdit(datasetId, edits))
    pendingBatchRegistrationQueue.set(datasetId, next)
    void next.then(() => {
      if (pendingBatchRegistrationQueue.get(datasetId) === next) {
        pendingBatchRegistrationQueue.delete(datasetId)
      }
    }, () => {
      if (pendingBatchRegistrationQueue.get(datasetId) === next) {
        pendingBatchRegistrationQueue.delete(datasetId)
      }
    })
    return await next
  },

  trackPendingBatchRegistration(datasetId: string, pending: Promise<unknown>): void {
    const previous = pendingBatchRegistrations.get(datasetId)
    const combined = previous
      ? Promise.allSettled([previous, pending]).then((results) => {
          const rejected = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
          )
          if (rejected) {
            throw rejected.reason
          }
        })
      : pending
    pendingBatchRegistrations.set(datasetId, combined)
    void combined.then(() => {
      if (pendingBatchRegistrations.get(datasetId) === combined) {
        pendingBatchRegistrations.delete(datasetId)
      }
    }, () => {
      if (pendingBatchRegistrations.get(datasetId) === combined) {
        pendingBatchRegistrations.delete(datasetId)
      }
    })
  },
  /**
   * Push a single cell edit to undo stack
   */
  async pushCellEdit(
    datasetId: string,
    row: number,
    column: string,
    oldValue: unknown,
    newValue: unknown
  ): Promise<UndoRedoState> {
    return await invoke<UndoRedoState>('push_cell_edit', {
      datasetId,
      row,
      column,
      oldValue,
      newValue,
    })
  },

  /**
   * Push a batch of cell edits to undo stack (e.g., paste operation)
   */
  async pushBatchCellEdit(
    datasetId: string,
    edits: CellEditInfo[]
  ): Promise<UndoRedoState> {
    const formattedEdits = edits.map(e => [
      e.row,
      e.column,
      e.oldValue,
      e.newValue,
    ])
    return await invoke<UndoRedoState>('push_batch_cell_edit', {
      datasetId,
      edits: formattedEdits,
    })
  },

  /**
   * Push a column rename operation to undo stack
   */
  async pushColumnRename(
    datasetId: string,
    columnId: string,
    oldName: string,
    newName: string
  ): Promise<UndoRedoState> {
    return await invoke<UndoRedoState>('push_column_rename', {
      datasetId,
      columnId,
      oldName,
      newName,
    })
  },

  /**
   * Push a row insert operation to undo stack
   */
  async pushRowInsert(
    datasetId: string,
    rowIndex: number,
    rowData: Record<string, unknown> = {}
  ): Promise<UndoRedoState> {
    return await invoke<UndoRedoState>('push_row_insert', {
      datasetId,
      rowIndex,
      rowData,
    })
  },

  /**
   * Push a column insert operation to undo stack
   */
  async pushColumnInsert(
    datasetId: string,
    columnIndex: number,
    columnId: string,
    columnName: string
  ): Promise<UndoRedoState> {
    return await invoke<UndoRedoState>('push_column_insert', {
      datasetId,
      columnIndex,
      columnId,
      columnName,
    })
  },

  /**
   * Perform undo operation
   * Returns the operation that was undone (for UI updates)
   */
  async undo(datasetId: string): Promise<UndoOperation | null> {
    const pendingQueue = pendingBatchRegistrationQueue.get(datasetId)
    if (pendingQueue) {
      try {
        await pendingQueue
      } catch (error) {
        console.error('[UndoService] Pending batch undo queue failed before undo:', error)
        return null
      }
    }
    const pendingRegistration = pendingBatchRegistrations.get(datasetId)
    if (pendingRegistration) {
      try {
        await pendingRegistration
      } catch (error) {
        console.error('[UndoService] Pending batch undo registration failed before undo:', error)
        return null
      }
    }
    return await invoke<UndoOperation | null>('perform_undo', { datasetId })
  },

  /**
   * Perform redo operation
   * Returns the operation that was redone (for UI updates)
   */
  async redo(datasetId: string): Promise<UndoOperation | null> {
    return await invoke<UndoOperation | null>('perform_redo', { datasetId })
  },

  /**
   * Get current undo/redo state
   */
  async getState(datasetId: string): Promise<UndoRedoState> {
    const backendState = await invoke<UndoRedoState>('get_undo_redo_state', { datasetId })
    const frontendUndoCount = gridMutationUndoStacks.get(datasetId)?.length ?? 0
    const frontendRedoCount = gridMutationRedoStacks.get(datasetId)?.length ?? 0

    return {
      can_undo: backendState.can_undo || frontendUndoCount > 0,
      can_redo: backendState.can_redo || frontendRedoCount > 0,
      undo_count: backendState.undo_count + frontendUndoCount,
      redo_count: backendState.redo_count + frontendRedoCount,
    }
  },

  /**
   * Clear undo history for a dataset
   */
  async clearHistory(datasetId: string): Promise<void> {
    this.clearGridTransactionHistory(datasetId)
    await invoke('clear_undo_history', { datasetId })
  },

  /**
   * Clear all undo history
   */
  async clearAllHistory(): Promise<void> {
    clearAllGridTransactionHistory()
    await invoke('clear_all_undo_history')
  },
}

/**
 * Keyboard shortcut handler for undo/redo
 * Call this in your component's useEffect
 */
export function setupUndoKeyboardShortcuts(
  getDatasetId: () => string | null,
  onUndo: (operation: UndoOperation | null) => void,
  onRedo: (operation: UndoOperation | null) => void
): () => void {
  const handleKeyDown = async (event: KeyboardEvent) => {
    const datasetId = getDatasetId()
    console.log('[UndoService] Keyboard event:', event.key, 'datasetId:', datasetId)
    if (!datasetId) {
      console.warn('[UndoService] No dataset ID, skipping undo/redo')
      return
    }

    // Check for Ctrl+Z (undo) or Ctrl+Shift+Z (redo)
    if (event.ctrlKey || event.metaKey) {
      if (event.key === 'z' || event.key === 'Z') {
        event.preventDefault()
        console.log('[UndoService] Undo/Redo keyboard shortcut triggered, shiftKey:', event.shiftKey)

        if (event.shiftKey) {
          // Redo: Ctrl+Shift+Z
          try {
            console.log('[UndoService] Calling redo for dataset:', datasetId)
            const operation = await undoService.redo(datasetId)
            console.log('[UndoService] Redo operation returned:', operation)
            onRedo(operation)
          } catch (error) {
            console.error('Redo failed:', error)
          }
        } else {
          // Undo: Ctrl+Z
          try {
            console.log('[UndoService] Calling undo for dataset:', datasetId)
            const operation = await undoService.undo(datasetId)
            console.log('[UndoService] Undo operation returned:', operation)
            onUndo(operation)
          } catch (error) {
            console.error('Undo failed:', error)
          }
        }
      } else if (event.key === 'y' || event.key === 'Y') {
        // Alternative redo: Ctrl+Y
        event.preventDefault()
        console.log('[UndoService] Redo keyboard shortcut (Ctrl+Y) triggered')
        try {
          console.log('[UndoService] Calling redo for dataset:', datasetId)
          const operation = await undoService.redo(datasetId)
          console.log('[UndoService] Redo operation returned:', operation)
          onRedo(operation)
        } catch (error) {
          console.error('Redo failed:', error)
        }
      }
    }
  }

  console.log('[UndoService] Setting up undo/redo keyboard shortcuts')
  window.addEventListener('keydown', handleKeyDown)

  // Return cleanup function
  return () => {
    console.log('[UndoService] Cleaning up undo/redo keyboard shortcuts')
    window.removeEventListener('keydown', handleKeyDown)
  }
}

export default undoService
