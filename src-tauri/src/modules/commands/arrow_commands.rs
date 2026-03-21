// Arrow Commands - Phase 4 Milestone 2B
//
// Tauri commands for Arrow IPC file operations.
// These commands enable zero-copy data transfer between frontend and backend.

use crate::modules::arrow_handler::ArrowHandler;
use crate::modules::security::validate_arrow_path;
use serde::Serialize;
use tauri::command;

/// Response from Arrow write operation
#[derive(Serialize)]
pub struct ArrowWriteResult {
    pub path: String,
    pub row_count: usize,
    pub column_count: usize,
}

/// Write dataset to Arrow IPC file
///
/// # Arguments
/// * `dataset_id` - Unique identifier for the dataset (used for temp file naming)
/// * `columns` - Column names
/// * `rows` - Row data as nested arrays of optional numbers
///
/// # Returns
/// * Arrow file path and metadata on success
#[command]
pub async fn write_arrow_dataset(
    dataset_id: String,
    columns: Vec<String>,
    rows: Vec<Vec<Option<f64>>>,
) -> Result<ArrowWriteResult, String> {
    ArrowHandler::validate_dataset_id(&dataset_id)
        .map_err(|e| format!("Invalid dataset ID: {}", e))?;

    let path = ArrowHandler::get_temp_path(&dataset_id);

    ArrowHandler::write_to_file(&path, columns.clone(), rows.clone())
        .map_err(|e| format!("Failed to write Arrow file: {}", e))?;

    Ok(ArrowWriteResult {
        path: path.to_string_lossy().to_string(),
        row_count: rows.len(),
        column_count: columns.len(),
    })
}

/// Read Arrow IPC file as bytes
///
/// # Arguments
/// * `arrow_path` - Path to the Arrow IPC file
///
/// # Returns
/// * Raw bytes of the Arrow file (for frontend parsing)
#[command]
pub async fn read_arrow_file(arrow_path: String) -> Result<Vec<u8>, String> {
    // Validate path for security (shared validator + Arrow-specific checks).
    validate_arrow_path(&arrow_path).map_err(|e| format!("Invalid Arrow path: {}", e))?;
    ArrowHandler::validate_path(&arrow_path).map_err(|e| format!("Invalid Arrow path: {}", e))?;

    let path = std::path::Path::new(&arrow_path);

    if !path.exists() {
        return Err(format!("Arrow file not found: {}", arrow_path));
    }

    ArrowHandler::read_from_file(path).map_err(|e| format!("Failed to read Arrow file: {}", e))
}

/// Delete temporary Arrow file
///
/// # Arguments
/// * `dataset_id` - Dataset ID used when writing the file
#[command]
pub async fn delete_arrow_file(dataset_id: String) -> Result<(), String> {
    ArrowHandler::validate_dataset_id(&dataset_id)
        .map_err(|e| format!("Invalid dataset ID: {}", e))?;

    ArrowHandler::delete_temp_file(&dataset_id)
        .map_err(|e| format!("Failed to delete Arrow file: {}", e))
}

/// Get Arrow file metadata (columns and row count)
#[command]
pub async fn get_arrow_metadata(arrow_path: String) -> Result<(Vec<String>, usize), String> {
    validate_arrow_path(&arrow_path).map_err(|e| format!("Invalid Arrow path: {}", e))?;
    ArrowHandler::validate_path(&arrow_path).map_err(|e| format!("Invalid Arrow path: {}", e))?;

    let path = std::path::Path::new(&arrow_path);
    ArrowHandler::read_metadata(path).map_err(|e| format!("Failed to read Arrow metadata: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_write_and_read_arrow() {
        let dataset_id = "test_dataset_123".to_string();
        let columns = vec!["col_a".to_string(), "col_b".to_string()];
        let rows = vec![vec![Some(1.5), Some(2.5)], vec![Some(3.5), None]];

        // Write
        let result = write_arrow_dataset(dataset_id.clone(), columns, rows).await;
        assert!(result.is_ok());

        let write_result = result.unwrap();
        assert_eq!(write_result.row_count, 2);
        assert_eq!(write_result.column_count, 2);

        // Read
        let bytes = read_arrow_file(write_result.path.clone()).await;
        assert!(bytes.is_ok());
        assert!(!bytes.unwrap().is_empty());

        // Cleanup
        let _ = delete_arrow_file(dataset_id).await;
    }
}
