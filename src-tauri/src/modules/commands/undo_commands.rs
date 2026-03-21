// Undo Commands - Phase 4 Milestone 5
//
// Tauri commands for undo/redo operations.
// Integrates with cache_manager to apply undo/redo changes.
// Phase 5: Routes through HYBRID_CACHE for large dataset support.

use crate::modules::cache_manager::CACHE;
use crate::modules::hybrid_cache_manager::HYBRID_CACHE;
use crate::modules::undo_manager::{CellEdit, UndoOperation, UNDO_MANAGER};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use tauri::command;

/// Response with undo/redo state
#[derive(Debug, Serialize)]
pub struct UndoRedoState {
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_count: usize,
    pub redo_count: usize,
}

/// Push a cell edit operation to undo stack
#[command]
pub async fn push_cell_edit(
    dataset_id: String,
    row: usize,
    column: String,
    old_value: Value,
    new_value: Value,
) -> Result<UndoRedoState, String> {
    let op = UndoOperation::CellEdit {
        dataset_id: dataset_id.clone(),
        row,
        column,
        old_value,
        new_value,
    };

    UNDO_MANAGER.push(op);

    Ok(get_undo_redo_state_internal(&dataset_id))
}

/// Push a batch cell edit operation to undo stack (e.g., paste)
#[command]
pub async fn push_batch_cell_edit(
    dataset_id: String,
    edits: Vec<(usize, String, Value, Value)>, // (row, column, old_value, new_value)
) -> Result<UndoRedoState, String> {
    let cell_edits: Vec<CellEdit> = edits
        .into_iter()
        .map(|(row, column, old_value, new_value)| CellEdit {
            row,
            column,
            old_value,
            new_value,
        })
        .collect();

    let op = UndoOperation::BatchCellEdit {
        dataset_id: dataset_id.clone(),
        edits: cell_edits,
    };

    UNDO_MANAGER.push(op);

    Ok(get_undo_redo_state_internal(&dataset_id))
}

/// Push a column rename operation to undo stack
#[command]
pub async fn push_column_rename(
    dataset_id: String,
    column_id: String,
    old_name: String,
    new_name: String,
) -> Result<UndoRedoState, String> {
    let op = UndoOperation::ColumnRename {
        dataset_id: dataset_id.clone(),
        column_id,
        old_name,
        new_name,
    };

    UNDO_MANAGER.push(op);

    Ok(get_undo_redo_state_internal(&dataset_id))
}

/// Push a row insert operation to undo stack
#[command]
pub async fn push_row_insert(
    dataset_id: String,
    row_index: usize,
    row_data: Option<HashMap<String, Value>>,
) -> Result<UndoRedoState, String> {
    let op = UndoOperation::RowInsert {
        dataset_id: dataset_id.clone(),
        row_index,
        row_data: row_data.unwrap_or_default(),
    };
    UNDO_MANAGER.push(op);
    Ok(get_undo_redo_state_internal(&dataset_id))
}

/// Push a column insert operation to undo stack
#[command]
pub async fn push_column_insert(
    dataset_id: String,
    column_index: usize,
    column_id: String,
    column_name: String,
) -> Result<UndoRedoState, String> {
    let op = UndoOperation::ColumnInsert {
        dataset_id: dataset_id.clone(),
        column_index,
        column_id,
        column_name,
    };
    UNDO_MANAGER.push(op);
    Ok(get_undo_redo_state_internal(&dataset_id))
}

/// Perform undo operation
/// Returns the operation that was undone (so frontend can update UI)
#[command]
pub async fn perform_undo(dataset_id: String) -> Result<Option<UndoOperation>, String> {
    let operation = UNDO_MANAGER.pop_undo(&dataset_id);

    if let Some(ref op) = operation {
        // Apply inverse operation to cache
        if let Err(error) = apply_undo_to_cache(op) {
            UNDO_MANAGER.rollback_failed_undo(&dataset_id, op.clone());
            return Err(error);
        }
    }

    Ok(operation)
}

/// Perform redo operation
/// Returns the operation that was redone (so frontend can update UI)
#[command]
pub async fn perform_redo(dataset_id: String) -> Result<Option<UndoOperation>, String> {
    let operation = UNDO_MANAGER.pop_redo(&dataset_id);

    if let Some(ref op) = operation {
        // Apply operation to cache
        if let Err(error) = apply_redo_to_cache(op) {
            UNDO_MANAGER.rollback_failed_redo(&dataset_id, op.clone());
            return Err(error);
        }
    }

    Ok(operation)
}

/// Get current undo/redo state
#[command]
pub async fn get_undo_redo_state(dataset_id: String) -> UndoRedoState {
    get_undo_redo_state_internal(&dataset_id)
}

/// Clear undo/redo history for a dataset
#[command]
pub async fn clear_undo_history(dataset_id: String) {
    UNDO_MANAGER.clear(&dataset_id);
}

/// Clear all undo/redo history
#[command]
pub async fn clear_all_undo_history() {
    UNDO_MANAGER.clear_all();
}

// ==================== Helper Functions ====================

fn get_undo_redo_state_internal(dataset_id: &str) -> UndoRedoState {
    UndoRedoState {
        can_undo: UNDO_MANAGER.can_undo(dataset_id),
        can_redo: UNDO_MANAGER.can_redo(dataset_id),
        undo_count: UNDO_MANAGER.undo_stack_size(dataset_id),
        redo_count: UNDO_MANAGER.redo_stack_size(dataset_id),
    }
}

/// Apply undo operation to cache (uses inverse values)
///
/// CRITICAL FIX: Routes to HYBRID_CACHE first (handles large DuckDB datasets),
/// then falls back to legacy CACHE for small datasets.
fn apply_undo_to_cache(operation: &UndoOperation) -> Result<(), String> {
    match operation {
        UndoOperation::CellEdit {
            dataset_id,
            row,
            column,
            old_value,
            ..
        } => {
            // Restore old value - route through HYBRID_CACHE first for large datasets
            if HYBRID_CACHE.has_dataset(dataset_id) {
                HYBRID_CACHE.update_cell(dataset_id, *row, column, old_value.clone())?;
            } else {
                CACHE.update_cell(dataset_id, *row, column, old_value.clone())?;
            }
        }
        UndoOperation::BatchCellEdit { dataset_id, edits } => {
            // Restore all old values - route through HYBRID_CACHE first for large datasets
            if HYBRID_CACHE.has_dataset(dataset_id) {
                for edit in edits {
                    HYBRID_CACHE.update_cell(
                        dataset_id,
                        edit.row,
                        &edit.column,
                        edit.old_value.clone(),
                    )?;
                }
            } else {
                for edit in edits {
                    CACHE.update_cell(
                        dataset_id,
                        edit.row,
                        &edit.column,
                        edit.old_value.clone(),
                    )?;
                }
            }
        }
        UndoOperation::ColumnRename { .. } => {
            // Column rename is handled by frontend (metadata change)
            // No cache update needed
        }
        UndoOperation::RowInsert { .. } => {
            if let UndoOperation::RowInsert {
                dataset_id,
                row_index,
                ..
            } = operation
            {
                if HYBRID_CACHE.has_dataset(dataset_id) {
                    HYBRID_CACHE.remove_row_at(dataset_id, *row_index)?;
                } else {
                    CACHE.remove_row_at(dataset_id, *row_index)?;
                }
            }
        }
        UndoOperation::RowDelete { .. } => {
            if let UndoOperation::RowDelete {
                dataset_id,
                row_index,
                row_data,
            } = operation
            {
                if HYBRID_CACHE.has_dataset(dataset_id) {
                    HYBRID_CACHE.insert_row_at(dataset_id, *row_index)?;
                    for (column, value) in row_data {
                        HYBRID_CACHE.update_cell(dataset_id, *row_index, column, value.clone())?;
                    }
                } else {
                    CACHE.insert_row_at(dataset_id, *row_index)?;
                    for (column, value) in row_data {
                        CACHE.update_cell(dataset_id, *row_index, column, value.clone())?;
                    }
                }
            }
        }
        UndoOperation::ColumnInsert { .. } => {
            if let UndoOperation::ColumnInsert {
                dataset_id,
                column_id,
                ..
            } = operation
            {
                if HYBRID_CACHE.has_dataset(dataset_id) {
                    HYBRID_CACHE.remove_column(dataset_id, column_id)?;
                } else {
                    CACHE.remove_column(dataset_id, column_id)?;
                }
            }
        }
        UndoOperation::ColumnDelete { .. } => {
            if let UndoOperation::ColumnDelete {
                dataset_id,
                column_id,
                column_data,
                ..
            } = operation
            {
                if HYBRID_CACHE.has_dataset(dataset_id) {
                    HYBRID_CACHE.add_column(dataset_id, column_id, Value::Null)?;
                    for (row_index, value) in column_data.iter().enumerate() {
                        HYBRID_CACHE.update_cell(
                            dataset_id,
                            row_index,
                            column_id,
                            value.clone(),
                        )?;
                    }
                } else {
                    CACHE.add_column(dataset_id, column_id, Value::Null)?;
                    for (row_index, value) in column_data.iter().enumerate() {
                        CACHE.update_cell(dataset_id, row_index, column_id, value.clone())?;
                    }
                }
            }
        }
    }

    Ok(())
}

/// Apply redo operation to cache (uses new values)
///
/// CRITICAL FIX: Routes to HYBRID_CACHE first (handles large DuckDB datasets),
/// then falls back to legacy CACHE for small datasets.
fn apply_redo_to_cache(operation: &UndoOperation) -> Result<(), String> {
    match operation {
        UndoOperation::CellEdit {
            dataset_id,
            row,
            column,
            new_value,
            ..
        } => {
            // Apply new value - route through HYBRID_CACHE first for large datasets
            if HYBRID_CACHE.has_dataset(dataset_id) {
                HYBRID_CACHE.update_cell(dataset_id, *row, column, new_value.clone())?;
            } else {
                CACHE.update_cell(dataset_id, *row, column, new_value.clone())?;
            }
        }
        UndoOperation::BatchCellEdit { dataset_id, edits } => {
            // Apply all new values - route through HYBRID_CACHE first for large datasets
            if HYBRID_CACHE.has_dataset(dataset_id) {
                for edit in edits {
                    HYBRID_CACHE.update_cell(
                        dataset_id,
                        edit.row,
                        &edit.column,
                        edit.new_value.clone(),
                    )?;
                }
            } else {
                for edit in edits {
                    CACHE.update_cell(
                        dataset_id,
                        edit.row,
                        &edit.column,
                        edit.new_value.clone(),
                    )?;
                }
            }
        }
        UndoOperation::ColumnRename { .. } => {
            // Column rename is handled by frontend
        }
        UndoOperation::RowInsert { .. } => {
            if let UndoOperation::RowInsert {
                dataset_id,
                row_index,
                row_data,
            } = operation
            {
                if HYBRID_CACHE.has_dataset(dataset_id) {
                    HYBRID_CACHE.insert_row_at(dataset_id, *row_index)?;
                    for (column, value) in row_data {
                        HYBRID_CACHE.update_cell(dataset_id, *row_index, column, value.clone())?;
                    }
                } else {
                    CACHE.insert_row_at(dataset_id, *row_index)?;
                    for (column, value) in row_data {
                        CACHE.update_cell(dataset_id, *row_index, column, value.clone())?;
                    }
                }
            }
        }
        UndoOperation::RowDelete { .. } => {
            if let UndoOperation::RowDelete {
                dataset_id,
                row_index,
                ..
            } = operation
            {
                if HYBRID_CACHE.has_dataset(dataset_id) {
                    HYBRID_CACHE.remove_row_at(dataset_id, *row_index)?;
                } else {
                    CACHE.remove_row_at(dataset_id, *row_index)?;
                }
            }
        }
        UndoOperation::ColumnInsert { .. } => {
            if let UndoOperation::ColumnInsert {
                dataset_id,
                column_id,
                ..
            } = operation
            {
                if HYBRID_CACHE.has_dataset(dataset_id) {
                    HYBRID_CACHE.add_column(dataset_id, column_id, Value::String(String::new()))?;
                } else {
                    CACHE.add_column(dataset_id, column_id, Value::String(String::new()))?;
                }
            }
        }
        UndoOperation::ColumnDelete { .. } => {
            if let UndoOperation::ColumnDelete {
                dataset_id,
                column_id,
                ..
            } = operation
            {
                if HYBRID_CACHE.has_dataset(dataset_id) {
                    HYBRID_CACHE.remove_column(dataset_id, column_id)?;
                } else {
                    CACHE.remove_column(dataset_id, column_id)?;
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use serde_json::Value;
    use std::collections::HashMap;

    #[tokio::test]
    async fn test_push_and_undo_cell_edit() {
        let dataset_id = "test_undo_cmd".to_string();

        // Setup cache with initial data
        let mut row = HashMap::new();
        row.insert("col1".to_string(), json!(1.0));
        CACHE.set_dataset(&dataset_id, vec![row]);

        // Push edit
        let state = push_cell_edit(
            dataset_id.clone(),
            0,
            "col1".to_string(),
            json!(1.0),
            json!(2.0),
        )
        .await
        .unwrap();

        assert!(state.can_undo);
        assert!(!state.can_redo);

        // Update cache to new value
        CACHE
            .update_cell(&dataset_id, 0, "col1", json!(2.0))
            .unwrap();

        // Perform undo
        let undone = perform_undo(dataset_id.clone()).await.unwrap();
        assert!(undone.is_some());

        // Verify cache restored
        let data = CACHE.get_column_data(&dataset_id, "col1").unwrap();
        assert_eq!(data[0], json!(1.0));

        // Cleanup
        CACHE.remove_dataset(&dataset_id);
        UNDO_MANAGER.clear(&dataset_id);
    }

    #[tokio::test]
    async fn test_undo_redo_state() {
        let dataset_id = "test_state_cmd".to_string();

        let state = get_undo_redo_state(dataset_id.clone()).await;
        assert!(!state.can_undo);
        assert!(!state.can_redo);

        // Push operation
        push_cell_edit(
            dataset_id.clone(),
            0,
            "col1".to_string(),
            json!(1.0),
            json!(2.0),
        )
        .await
        .unwrap();

        let state = get_undo_redo_state(dataset_id.clone()).await;
        assert!(state.can_undo);
        assert_eq!(state.undo_count, 1);

        // Cleanup
        UNDO_MANAGER.clear(&dataset_id);
    }

    #[tokio::test]
    async fn test_row_insert_undo_redo_roundtrip() {
        let dataset_id = "test_row_insert_cmd".to_string();
        UNDO_MANAGER.clear(&dataset_id);

        let mut row = HashMap::new();
        row.insert("col1".to_string(), json!(1));
        CACHE.set_dataset(&dataset_id, vec![row]);

        CACHE.insert_row_at(&dataset_id, 1).unwrap();
        assert_eq!(CACHE.get_row_count(&dataset_id), Some(2));

        push_row_insert(dataset_id.clone(), 1, Some(HashMap::<String, Value>::new()))
            .await
            .unwrap();

        let undone = perform_undo(dataset_id.clone()).await.unwrap();
        assert!(matches!(undone, Some(UndoOperation::RowInsert { .. })));
        assert_eq!(CACHE.get_row_count(&dataset_id), Some(1));

        let redone = perform_redo(dataset_id.clone()).await.unwrap();
        assert!(matches!(redone, Some(UndoOperation::RowInsert { .. })));
        assert_eq!(CACHE.get_row_count(&dataset_id), Some(2));

        CACHE.remove_dataset(&dataset_id);
        UNDO_MANAGER.clear(&dataset_id);
    }

    #[tokio::test]
    async fn test_column_insert_undo_redo_roundtrip() {
        let dataset_id = "test_column_insert_cmd".to_string();
        UNDO_MANAGER.clear(&dataset_id);

        let mut row = HashMap::new();
        row.insert("base_col".to_string(), json!("x"));
        CACHE.set_dataset(&dataset_id, vec![row]);

        CACHE.add_column(&dataset_id, "new_col", json!("")).unwrap();

        push_column_insert(
            dataset_id.clone(),
            1,
            "new_col".to_string(),
            "New Column".to_string(),
        )
        .await
        .unwrap();

        let undone = perform_undo(dataset_id.clone()).await.unwrap();
        assert!(matches!(undone, Some(UndoOperation::ColumnInsert { .. })));
        let after_undo = CACHE.get_dataset(&dataset_id).unwrap();
        assert!(!after_undo[0].contains_key("new_col"));

        let redone = perform_redo(dataset_id.clone()).await.unwrap();
        assert!(matches!(redone, Some(UndoOperation::ColumnInsert { .. })));
        let after_redo = CACHE.get_dataset(&dataset_id).unwrap();
        assert!(after_redo[0].contains_key("new_col"));

        CACHE.remove_dataset(&dataset_id);
        UNDO_MANAGER.clear(&dataset_id);
    }
}
