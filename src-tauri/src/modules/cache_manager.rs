// Cache Manager - Phase 4 Milestone 3
//
// In-memory cache for dataset rows, enabling real-time grid edit synchronization.
// Ensures Python tests always operate on the latest user-edited data.

use crate::modules::arrow_handler::ArrowHandler;
use lazy_static::lazy_static;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

/// In-memory cache of dataset rows
pub struct CacheManager {
    datasets: Mutex<HashMap<String, Vec<HashMap<String, Value>>>>,
}

impl CacheManager {
    pub fn new() -> Self {
        Self {
            datasets: Mutex::new(HashMap::new()),
        }
    }

    /// Set entire dataset (on import)
    pub fn set_dataset(&self, dataset_id: &str, rows: Vec<HashMap<String, Value>>) {
        let mut cache = self.datasets.lock().unwrap();
        log::info!(
            "Cache: Set dataset '{}' with {} rows",
            dataset_id,
            rows.len()
        );
        cache.insert(dataset_id.to_string(), rows);
    }

    /// Update single cell
    pub fn update_cell(
        &self,
        dataset_id: &str,
        row: usize,
        col: &str,
        value: Value,
    ) -> Result<(), String> {
        let mut cache = self.datasets.lock().unwrap();

        if let Some(dataset) = cache.get_mut(dataset_id) {
            if let Some(row_data) = dataset.get_mut(row) {
                row_data.insert(col.to_string(), value);
                Ok(())
            } else {
                Err(format!("Row {} not found in dataset '{}'", row, dataset_id))
            }
        } else {
            Err(format!("Dataset '{}' not found in cache", dataset_id))
        }
    }

    /// Update multiple cells in a batch (for paste operations)
    pub fn update_cells_batch(
        &self,
        dataset_id: &str,
        updates: Vec<(usize, String, Value)>,
    ) -> Result<usize, String> {
        let mut cache = self.datasets.lock().unwrap();

        if let Some(dataset) = cache.get_mut(dataset_id) {
            let mut updated_count = 0;
            for (row, col, value) in updates {
                if let Some(row_data) = dataset.get_mut(row) {
                    row_data.insert(col, value);
                    updated_count += 1;
                }
            }
            log::debug!(
                "Cache: Batch updated {} cells in '{}'",
                updated_count,
                dataset_id
            );
            Ok(updated_count)
        } else {
            Err(format!("Dataset '{}' not found in cache", dataset_id))
        }
    }

    /// Add a new column to all rows in a dataset
    /// Used when user clicks "Add Column" in the grid
    pub fn add_column(
        &self,
        dataset_id: &str,
        column_id: &str,
        default_value: Value,
    ) -> Result<usize, String> {
        let mut cache = self.datasets.lock().unwrap();

        if let Some(dataset) = cache.get_mut(dataset_id) {
            let row_count = dataset.len();
            for row_data in dataset.iter_mut() {
                row_data.insert(column_id.to_string(), default_value.clone());
            }
            log::info!(
                "Cache: Added column '{}' to {} rows in '{}'",
                column_id,
                row_count,
                dataset_id
            );
            Ok(row_count)
        } else {
            Err(format!("Dataset '{}' not found in cache", dataset_id))
        }
    }

    /// Insert an empty row at `row_index`.
    /// Existing rows at/after the index are shifted down by one.
    pub fn insert_row_at(&self, dataset_id: &str, row_index: usize) -> Result<usize, String> {
        let mut cache = self.datasets.lock().unwrap();

        if let Some(dataset) = cache.get_mut(dataset_id) {
            let insert_at = row_index.min(dataset.len());
            dataset.insert(insert_at, HashMap::new());
            Ok(dataset.len())
        } else {
            Err(format!("Dataset '{}' not found in cache", dataset_id))
        }
    }

    /// Remove a row at `row_index`.
    pub fn remove_row_at(&self, dataset_id: &str, row_index: usize) -> Result<usize, String> {
        let mut cache = self.datasets.lock().unwrap();

        if let Some(dataset) = cache.get_mut(dataset_id) {
            if dataset.is_empty() {
                return Err(format!("Dataset '{}' has no rows to remove", dataset_id));
            }
            if row_index >= dataset.len() {
                return Err(format!(
                    "Row index {} out of bounds for dataset '{}' (len={})",
                    row_index,
                    dataset_id,
                    dataset.len()
                ));
            }
            dataset.remove(row_index);
            Ok(dataset.len())
        } else {
            Err(format!("Dataset '{}' not found in cache", dataset_id))
        }
    }

    /// Remove a column from all rows in a dataset.
    /// Returns the number of rows touched.
    pub fn remove_column(&self, dataset_id: &str, column_id: &str) -> Result<usize, String> {
        let mut cache = self.datasets.lock().unwrap();

        if let Some(dataset) = cache.get_mut(dataset_id) {
            let row_count = dataset.len();
            for row_data in dataset.iter_mut() {
                row_data.remove(column_id);
            }
            Ok(row_count)
        } else {
            Err(format!("Dataset '{}' not found in cache", dataset_id))
        }
    }

    /// Get dataset for test execution
    pub fn get_dataset(&self, dataset_id: &str) -> Option<Vec<HashMap<String, Value>>> {
        let cache = self.datasets.lock().unwrap();
        cache.get(dataset_id).cloned()
    }

    /// Get single column data as Vec<Value>
    pub fn get_column_data(&self, dataset_id: &str, column_id: &str) -> Option<Vec<Value>> {
        let cache = self.datasets.lock().unwrap();
        if let Some(dataset) = cache.get(dataset_id) {
            Some(
                dataset
                    .iter()
                    .map(|row| row.get(column_id).cloned().unwrap_or(Value::Null))
                    .collect(),
            )
        } else {
            None
        }
    }

    /// Get multiple columns data (for statistical tests)
    pub fn get_columns_data(
        &self,
        dataset_id: &str,
        column_ids: &[String],
    ) -> Option<HashMap<String, Vec<Value>>> {
        let cache = self.datasets.lock().unwrap();
        if let Some(dataset) = cache.get(dataset_id) {
            let mut result = HashMap::new();
            for col_id in column_ids {
                let col_data: Vec<Value> = dataset
                    .iter()
                    .map(|row| row.get(col_id).cloned().unwrap_or(Value::Null))
                    .collect();
                result.insert(col_id.clone(), col_data);
            }
            Some(result)
        } else {
            None
        }
    }

    /// Check if dataset exists in cache
    pub fn has_dataset(&self, dataset_id: &str) -> bool {
        let cache = self.datasets.lock().unwrap();
        cache.contains_key(dataset_id)
    }

    /// Get dataset row count
    pub fn get_row_count(&self, dataset_id: &str) -> Option<usize> {
        let cache = self.datasets.lock().unwrap();
        cache.get(dataset_id).map(|d| d.len())
    }

    /// Get rows in a range (for streaming row provider)
    /// Returns rows [start_row, end_row) - end is exclusive
    pub fn get_rows_range(
        &self,
        dataset_id: &str,
        start_row: usize,
        end_row: usize,
    ) -> Option<Vec<HashMap<String, Value>>> {
        let cache = self.datasets.lock().unwrap();
        if let Some(dataset) = cache.get(dataset_id) {
            let actual_end = end_row.min(dataset.len());
            if start_row >= actual_end {
                return Some(Vec::new());
            }
            Some(dataset[start_row..actual_end].to_vec())
        } else {
            None
        }
    }

    /// Remove dataset from cache
    pub fn remove_dataset(&self, dataset_id: &str) -> bool {
        let mut cache = self.datasets.lock().unwrap();
        log::info!("Cache: Removed dataset '{}'", dataset_id);
        cache.remove(dataset_id).is_some()
    }

    /// Clear all datasets
    pub fn clear(&self) {
        let mut cache = self.datasets.lock().unwrap();
        log::info!("Cache: Cleared all {} datasets", cache.len());
        cache.clear();
    }

    /// Flush dataset to Arrow IPC file (before test execution)
    /// Returns the path to the temporary Arrow file
    pub fn flush_to_arrow(&self, dataset_id: &str) -> Result<String, String> {
        let cache = self.datasets.lock().unwrap();
        let rows = cache
            .get(dataset_id)
            .ok_or_else(|| format!("Dataset '{}' not found in cache", dataset_id))?;

        // Get column names from first row (dynamic)
        let columns: Vec<String> = if let Some(first_row) = rows.first() {
            first_row.keys().cloned().collect()
        } else {
            return Err("Dataset is empty".to_string());
        };

        // Convert to numeric format for Arrow (row-major to columnar)
        let numeric_rows: Vec<Vec<Option<f64>>> = rows
            .iter()
            .map(|row| {
                columns
                    .iter()
                    .map(|col| {
                        row.get(col).and_then(|v| match v {
                            Value::Number(n) => n.as_f64(),
                            Value::String(s) => s.parse::<f64>().ok(),
                            _ => None,
                        })
                    })
                    .collect()
            })
            .collect();

        // Write to temp file
        let path = ArrowHandler::get_temp_path(dataset_id);
        ArrowHandler::write_to_file(&path, columns, numeric_rows)
            .map_err(|e| format!("Failed to write Arrow file: {}", e))?;

        log::info!(
            "Cache: Flushed dataset '{}' to Arrow file: {:?}",
            dataset_id,
            path
        );
        Ok(path.to_string_lossy().to_string())
    }
}

impl Default for CacheManager {
    fn default() -> Self {
        Self::new()
    }
}

// Global cache instance
lazy_static! {
    pub static ref CACHE: CacheManager = CacheManager::new();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_set_and_get_dataset() {
        let cache = CacheManager::new();

        let mut row1 = HashMap::new();
        row1.insert("col_a".to_string(), Value::from(1.5));
        row1.insert("col_b".to_string(), Value::from(2.5));

        let mut row2 = HashMap::new();
        row2.insert("col_a".to_string(), Value::from(3.5));
        row2.insert("col_b".to_string(), Value::from(4.5));

        cache.set_dataset("test_ds", vec![row1, row2]);

        let dataset = cache.get_dataset("test_ds");
        assert!(dataset.is_some());
        assert_eq!(dataset.unwrap().len(), 2);
    }

    #[test]
    fn test_update_cell() {
        let cache = CacheManager::new();

        let mut row = HashMap::new();
        row.insert("col_a".to_string(), Value::from(1.0));
        cache.set_dataset("test_ds", vec![row]);

        let result = cache.update_cell("test_ds", 0, "col_a", Value::from(99.0));
        assert!(result.is_ok());

        let dataset = cache.get_dataset("test_ds").unwrap();
        assert_eq!(dataset[0].get("col_a").unwrap(), &Value::from(99.0));
    }

    #[test]
    fn test_get_column_data() {
        let cache = CacheManager::new();

        let mut row1 = HashMap::new();
        row1.insert("x".to_string(), Value::from(1.0));
        let mut row2 = HashMap::new();
        row2.insert("x".to_string(), Value::from(2.0));

        cache.set_dataset("ds", vec![row1, row2]);

        let col_data = cache.get_column_data("ds", "x").unwrap();
        assert_eq!(col_data.len(), 2);
        assert_eq!(col_data[0], Value::from(1.0));
        assert_eq!(col_data[1], Value::from(2.0));
    }

    #[test]
    fn test_add_column() {
        let cache = CacheManager::new();

        let mut row1 = HashMap::new();
        row1.insert("col_a".to_string(), Value::from(1.0));

        let mut row2 = HashMap::new();
        row2.insert("col_a".to_string(), Value::from(2.0));

        cache.set_dataset("ds", vec![row1, row2]);

        let updated = cache
            .add_column("ds", "new_col", Value::from(""))
            .expect("add_column should succeed");
        assert_eq!(updated, 2);

        let dataset = cache.get_dataset("ds").unwrap();
        assert_eq!(dataset[0].get("new_col").unwrap(), &Value::from(""));
        assert_eq!(dataset[1].get("new_col").unwrap(), &Value::from(""));
    }
}
