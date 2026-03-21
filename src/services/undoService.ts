/**
 * Undo Service - Phase 4 Milestone 5
 *
 * Frontend service for undo/redo operations.
 * Integrates with Rust backend for persistent undo stack.
 */

import { invoke } from '@tauri-apps/api/core'

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
    return await invoke<UndoRedoState>('get_undo_redo_state', { datasetId })
  },

  /**
   * Clear undo history for a dataset
   */
  async clearHistory(datasetId: string): Promise<void> {
    await invoke('clear_undo_history', { datasetId })
  },

  /**
   * Clear all undo history
   */
  async clearAllHistory(): Promise<void> {
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
