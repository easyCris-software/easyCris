// Undo Manager - Phase 4 Milestone 5
//
// Manages undo/redo stack for all editing operations.
// Supports cell edits, row/column operations, and batch operations.

use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

/// Maximum undo stack size per dataset
const MAX_UNDO_STACK_SIZE: usize = 100;

/// Types of undoable operations
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum UndoOperation {
    /// Single cell edit
    CellEdit {
        dataset_id: String,
        row: usize,
        column: String,
        old_value: Value,
        new_value: Value,
    },
    /// Batch cell edit (e.g., paste operation)
    BatchCellEdit {
        dataset_id: String,
        edits: Vec<CellEdit>,
    },
    /// Column rename
    ColumnRename {
        dataset_id: String,
        column_id: String,
        old_name: String,
        new_name: String,
    },
    /// Row insert
    RowInsert {
        dataset_id: String,
        row_index: usize,
        row_data: HashMap<String, Value>,
    },
    /// Row delete
    RowDelete {
        dataset_id: String,
        row_index: usize,
        row_data: HashMap<String, Value>,
    },
    /// Column insert
    ColumnInsert {
        dataset_id: String,
        column_index: usize,
        column_id: String,
        column_name: String,
    },
    /// Column delete
    ColumnDelete {
        dataset_id: String,
        column_index: usize,
        column_id: String,
        column_name: String,
        column_data: Vec<Value>,
    },
}

/// Single cell edit for batch operations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellEdit {
    pub row: usize,
    pub column: String,
    pub old_value: Value,
    pub new_value: Value,
}

/// Undo/Redo state for a dataset
#[derive(Debug, Default)]
struct DatasetUndoState {
    undo_stack: Vec<UndoOperation>,
    redo_stack: Vec<UndoOperation>,
}

/// Undo Manager - manages undo/redo stacks for all datasets
pub struct UndoManager {
    states: Mutex<HashMap<String, DatasetUndoState>>,
}

impl UndoManager {
    pub fn new() -> Self {
        Self {
            states: Mutex::new(HashMap::new()),
        }
    }

    /// Push an operation onto the undo stack
    pub fn push(&self, operation: UndoOperation) {
        let dataset_id = operation.dataset_id();
        let mut states = self.states.lock().unwrap();

        let state = states.entry(dataset_id).or_default();

        // Clear redo stack on new operation
        state.redo_stack.clear();

        // Add to undo stack
        state.undo_stack.push(operation);

        // Limit stack size
        if state.undo_stack.len() > MAX_UNDO_STACK_SIZE {
            state.undo_stack.remove(0);
        }

        log::debug!("Undo push: stack size = {}", state.undo_stack.len());
    }

    /// Pop and return the last operation for undo
    pub fn pop_undo(&self, dataset_id: &str) -> Option<UndoOperation> {
        let mut states = self.states.lock().unwrap();

        if let Some(state) = states.get_mut(dataset_id) {
            if let Some(op) = state.undo_stack.pop() {
                // Move to redo stack
                state.redo_stack.push(op.clone());
                log::debug!(
                    "Undo pop: undo_stack={}, redo_stack={}",
                    state.undo_stack.len(),
                    state.redo_stack.len()
                );
                return Some(op);
            }
        }
        None
    }

    /// Pop and return the last operation for redo
    pub fn pop_redo(&self, dataset_id: &str) -> Option<UndoOperation> {
        let mut states = self.states.lock().unwrap();

        if let Some(state) = states.get_mut(dataset_id) {
            if let Some(op) = state.redo_stack.pop() {
                // Move back to undo stack
                state.undo_stack.push(op.clone());
                log::debug!(
                    "Redo pop: undo_stack={}, redo_stack={}",
                    state.undo_stack.len(),
                    state.redo_stack.len()
                );
                return Some(op);
            }
        }
        None
    }

    /// Restore stacks when an undo cache-apply fails after pop_undo.
    pub fn rollback_failed_undo(&self, dataset_id: &str, operation: UndoOperation) {
        let mut states = self.states.lock().unwrap();
        if let Some(state) = states.get_mut(dataset_id) {
            let _ = state.redo_stack.pop();
            state.undo_stack.push(operation);
            if state.undo_stack.len() > MAX_UNDO_STACK_SIZE {
                state.undo_stack.remove(0);
            }
        }
    }

    /// Restore stacks when a redo cache-apply fails after pop_redo.
    pub fn rollback_failed_redo(&self, dataset_id: &str, operation: UndoOperation) {
        let mut states = self.states.lock().unwrap();
        if let Some(state) = states.get_mut(dataset_id) {
            let _ = state.undo_stack.pop();
            state.redo_stack.push(operation);
        }
    }

    /// Check if undo is available
    pub fn can_undo(&self, dataset_id: &str) -> bool {
        let states = self.states.lock().unwrap();
        states
            .get(dataset_id)
            .map(|s| !s.undo_stack.is_empty())
            .unwrap_or(false)
    }

    /// Check if redo is available
    pub fn can_redo(&self, dataset_id: &str) -> bool {
        let states = self.states.lock().unwrap();
        states
            .get(dataset_id)
            .map(|s| !s.redo_stack.is_empty())
            .unwrap_or(false)
    }

    /// Get undo stack size
    pub fn undo_stack_size(&self, dataset_id: &str) -> usize {
        let states = self.states.lock().unwrap();
        states
            .get(dataset_id)
            .map(|s| s.undo_stack.len())
            .unwrap_or(0)
    }

    /// Get redo stack size
    pub fn redo_stack_size(&self, dataset_id: &str) -> usize {
        let states = self.states.lock().unwrap();
        states
            .get(dataset_id)
            .map(|s| s.redo_stack.len())
            .unwrap_or(0)
    }

    /// Clear undo/redo history for a dataset
    pub fn clear(&self, dataset_id: &str) {
        let mut states = self.states.lock().unwrap();
        states.remove(dataset_id);
        log::info!("Cleared undo history for dataset: {}", dataset_id);
    }

    /// Clear all undo/redo history
    pub fn clear_all(&self) {
        let mut states = self.states.lock().unwrap();
        states.clear();
        log::info!("Cleared all undo history");
    }
}

impl Default for UndoManager {
    fn default() -> Self {
        Self::new()
    }
}

impl UndoOperation {
    /// Get the dataset ID for this operation
    pub fn dataset_id(&self) -> String {
        match self {
            UndoOperation::CellEdit { dataset_id, .. } => dataset_id.clone(),
            UndoOperation::BatchCellEdit { dataset_id, .. } => dataset_id.clone(),
            UndoOperation::ColumnRename { dataset_id, .. } => dataset_id.clone(),
            UndoOperation::RowInsert { dataset_id, .. } => dataset_id.clone(),
            UndoOperation::RowDelete { dataset_id, .. } => dataset_id.clone(),
            UndoOperation::ColumnInsert { dataset_id, .. } => dataset_id.clone(),
            UndoOperation::ColumnDelete { dataset_id, .. } => dataset_id.clone(),
        }
    }

    /// Get the inverse operation (for undo)
    pub fn inverse(&self) -> UndoOperation {
        match self {
            UndoOperation::CellEdit {
                dataset_id,
                row,
                column,
                old_value,
                new_value,
            } => UndoOperation::CellEdit {
                dataset_id: dataset_id.clone(),
                row: *row,
                column: column.clone(),
                old_value: new_value.clone(),
                new_value: old_value.clone(),
            },
            UndoOperation::BatchCellEdit { dataset_id, edits } => UndoOperation::BatchCellEdit {
                dataset_id: dataset_id.clone(),
                edits: edits
                    .iter()
                    .map(|e| CellEdit {
                        row: e.row,
                        column: e.column.clone(),
                        old_value: e.new_value.clone(),
                        new_value: e.old_value.clone(),
                    })
                    .collect(),
            },
            UndoOperation::ColumnRename {
                dataset_id,
                column_id,
                old_name,
                new_name,
            } => UndoOperation::ColumnRename {
                dataset_id: dataset_id.clone(),
                column_id: column_id.clone(),
                old_name: new_name.clone(),
                new_name: old_name.clone(),
            },
            UndoOperation::RowInsert {
                dataset_id,
                row_index,
                row_data,
            } => UndoOperation::RowDelete {
                dataset_id: dataset_id.clone(),
                row_index: *row_index,
                row_data: row_data.clone(),
            },
            UndoOperation::RowDelete {
                dataset_id,
                row_index,
                row_data,
            } => UndoOperation::RowInsert {
                dataset_id: dataset_id.clone(),
                row_index: *row_index,
                row_data: row_data.clone(),
            },
            UndoOperation::ColumnInsert {
                dataset_id,
                column_index,
                column_id,
                column_name,
            } => UndoOperation::ColumnDelete {
                dataset_id: dataset_id.clone(),
                column_index: *column_index,
                column_id: column_id.clone(),
                column_name: column_name.clone(),
                column_data: vec![], // Will be populated by the undo handler
            },
            UndoOperation::ColumnDelete {
                dataset_id,
                column_index,
                column_id,
                column_name,
                ..
            } => UndoOperation::ColumnInsert {
                dataset_id: dataset_id.clone(),
                column_index: *column_index,
                column_id: column_id.clone(),
                column_name: column_name.clone(),
            },
        }
    }
}

// Global undo manager instance
lazy_static! {
    pub static ref UNDO_MANAGER: UndoManager = UndoManager::new();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_push_and_undo() {
        let manager = UndoManager::new();

        let op = UndoOperation::CellEdit {
            dataset_id: "test-ds".to_string(),
            row: 0,
            column: "col1".to_string(),
            old_value: json!(1.0),
            new_value: json!(2.0),
        };

        manager.push(op.clone());
        assert!(manager.can_undo("test-ds"));
        assert!(!manager.can_redo("test-ds"));

        let undone = manager.pop_undo("test-ds");
        assert!(undone.is_some());
        assert!(!manager.can_undo("test-ds"));
        assert!(manager.can_redo("test-ds"));
    }

    #[test]
    fn test_redo() {
        let manager = UndoManager::new();

        let op = UndoOperation::CellEdit {
            dataset_id: "test-ds".to_string(),
            row: 0,
            column: "col1".to_string(),
            old_value: json!(1.0),
            new_value: json!(2.0),
        };

        manager.push(op);
        manager.pop_undo("test-ds");

        let redone = manager.pop_redo("test-ds");
        assert!(redone.is_some());
        assert!(manager.can_undo("test-ds"));
        assert!(!manager.can_redo("test-ds"));
    }

    #[test]
    fn test_new_operation_clears_redo() {
        let manager = UndoManager::new();

        let op1 = UndoOperation::CellEdit {
            dataset_id: "test-ds".to_string(),
            row: 0,
            column: "col1".to_string(),
            old_value: json!(1.0),
            new_value: json!(2.0),
        };

        let op2 = UndoOperation::CellEdit {
            dataset_id: "test-ds".to_string(),
            row: 0,
            column: "col1".to_string(),
            old_value: json!(2.0),
            new_value: json!(3.0),
        };

        manager.push(op1);
        manager.pop_undo("test-ds");
        assert!(manager.can_redo("test-ds"));

        // Push new operation
        manager.push(op2);
        assert!(!manager.can_redo("test-ds")); // Redo cleared
    }

    #[test]
    fn test_inverse_operation() {
        let op = UndoOperation::CellEdit {
            dataset_id: "test-ds".to_string(),
            row: 5,
            column: "col1".to_string(),
            old_value: json!(10.0),
            new_value: json!(20.0),
        };

        let inverse = op.inverse();

        match inverse {
            UndoOperation::CellEdit {
                old_value,
                new_value,
                ..
            } => {
                assert_eq!(old_value, json!(20.0));
                assert_eq!(new_value, json!(10.0));
            }
            _ => panic!("Expected CellEdit"),
        }
    }

    #[test]
    fn test_mixed_operation_undo_order_is_chronological() {
        let manager = UndoManager::new();
        let dataset_id = "test-ds".to_string();

        manager.push(UndoOperation::ColumnInsert {
            dataset_id: dataset_id.clone(),
            column_index: 1,
            column_id: "col-new".to_string(),
            column_name: "Column New".to_string(),
        });
        manager.push(UndoOperation::CellEdit {
            dataset_id: dataset_id.clone(),
            row: 0,
            column: "col-0".to_string(),
            old_value: json!(1),
            new_value: json!(2),
        });
        manager.push(UndoOperation::RowInsert {
            dataset_id: dataset_id.clone(),
            row_index: 3,
            row_data: std::collections::HashMap::new(),
        });

        let first = manager
            .pop_undo(&dataset_id)
            .expect("expected first undo op");
        assert!(matches!(first, UndoOperation::RowInsert { .. }));

        let second = manager
            .pop_undo(&dataset_id)
            .expect("expected second undo op");
        assert!(matches!(second, UndoOperation::CellEdit { .. }));

        let third = manager
            .pop_undo(&dataset_id)
            .expect("expected third undo op");
        assert!(matches!(third, UndoOperation::ColumnInsert { .. }));
    }
}
