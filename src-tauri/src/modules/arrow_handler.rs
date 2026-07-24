// Arrow Handler - Phase 4 Milestone 2B
//
// Handles Apache Arrow IPC file operations for zero-copy data transfer
// between Frontend (apache-arrow npm) ↔ Rust (arrow2) ↔ Python (PyArrow).

use anyhow::Result;
use arrow2::array::{Array, Float64Array, Utf8Array};
use arrow2::chunk::Chunk;
use arrow2::datatypes::{DataType, Field, Schema};
use arrow2::io::ipc::read::{read_file_metadata, FileReader};
use arrow2::io::ipc::write::{FileWriter, WriteOptions};
use std::fs::File;
use std::path::Path;

/// Arrow handler for IPC file operations
pub struct ArrowHandler;

impl ArrowHandler {
    /// Validate dataset ID used for temp Arrow file naming.
    /// Restricts IDs to safe filename characters to prevent path injection.
    pub fn validate_dataset_id(dataset_id: &str) -> Result<()> {
        if dataset_id.is_empty() {
            anyhow::bail!("Dataset ID cannot be empty");
        }
        if dataset_id.len() > 128 {
            anyhow::bail!("Dataset ID too long");
        }
        if !dataset_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            anyhow::bail!("Dataset ID contains invalid characters");
        }
        Ok(())
    }

    /// Write dataset to Arrow IPC file
    ///
    /// # Arguments
    /// * `path` - Destination file path
    /// * `columns` - Column names
    /// * `rows` - Row data (row-major format)
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err` with error message on failure
    pub fn write_to_file(
        path: &Path,
        columns: Vec<String>,
        rows: Vec<Vec<Option<f64>>>,
    ) -> Result<()> {
        // Create schema (assume all numeric for now)
        let fields: Vec<Field> = columns
            .iter()
            .map(|name| Field::new(name, DataType::Float64, true))
            .collect();
        let schema = Schema::from(fields);

        // Convert row-major to columnar format
        let num_cols = columns.len();
        let num_rows = rows.len();

        let mut col_arrays: Vec<Box<dyn Array>> = Vec::new();

        for col_idx in 0..num_cols {
            let mut col_data: Vec<Option<f64>> = Vec::with_capacity(num_rows);
            for row in &rows {
                col_data.push(row.get(col_idx).copied().flatten());
            }

            let array: Float64Array = col_data.into_iter().collect();
            col_arrays.push(Box::new(array));
        }

        // Write to file
        let file = File::create(path)?;
        let options = WriteOptions { compression: None };
        let mut writer = FileWriter::try_new(file, schema, None, options)?;

        let chunk = Chunk::new(col_arrays);
        writer.write(&chunk, None)?;
        writer.finish()?;

        log::info!("Wrote Arrow IPC file: {:?}", path);
        Ok(())
    }

    /// Write string dataset to Arrow IPC file (for mixed types)
    pub fn write_string_dataset(
        path: &Path,
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
    ) -> Result<()> {
        // Create schema with string columns
        let fields: Vec<Field> = columns
            .iter()
            .map(|name| Field::new(name, DataType::Utf8, true))
            .collect();
        let schema = Schema::from(fields);

        let num_cols = columns.len();
        let num_rows = rows.len();

        let mut col_arrays: Vec<Box<dyn Array>> = Vec::new();

        for col_idx in 0..num_cols {
            let mut col_data: Vec<Option<String>> = Vec::with_capacity(num_rows);
            for row in &rows {
                col_data.push(row.get(col_idx).cloned());
            }

            let array: Utf8Array<i32> = col_data.into_iter().collect();
            col_arrays.push(Box::new(array));
        }

        let file = File::create(path)?;
        let options = WriteOptions { compression: None };
        let mut writer = FileWriter::try_new(file, schema, None, options)?;

        let chunk = Chunk::new(col_arrays);
        writer.write(&chunk, None)?;
        writer.finish()?;

        log::info!("Wrote Arrow IPC file (string): {:?}", path);
        Ok(())
    }

    /// Read Arrow IPC file as raw bytes
    pub fn read_from_file(path: &Path) -> Result<Vec<u8>> {
        Ok(std::fs::read(path)?)
    }

    /// Read Arrow IPC file and return metadata
    pub fn read_metadata(path: &Path) -> Result<(Vec<String>, usize)> {
        let mut file = File::open(path)?;
        let metadata = read_file_metadata(&mut file)?;
        let reader = FileReader::new(file, metadata.clone(), None, None);

        let columns: Vec<String> = metadata
            .schema
            .fields
            .iter()
            .map(|f| f.name.clone())
            .collect();

        // Count rows by iterating chunks
        let mut row_count = 0;
        for chunk_result in reader {
            let chunk = chunk_result?;
            row_count += chunk.len();
        }

        Ok((columns, row_count))
    }

    /// Validate Arrow file path (security check)
    pub fn validate_path(path: &str) -> Result<()> {
        let path_obj = Path::new(path);

        // Prevent path traversal
        if path.contains("..") {
            anyhow::bail!("Path traversal not allowed");
        }

        if !path_obj.is_absolute() {
            anyhow::bail!("Arrow path must be absolute");
        }

        // Check extension
        if !matches!(
            path_obj.extension().and_then(|s| s.to_str()),
            Some("arrow") | Some("ipc") | Some("feather")
        ) {
            anyhow::bail!("Invalid Arrow file extension");
        }

        // Production hardening: only allow app-managed temp Arrow files.
        if !cfg!(debug_assertions) {
            let file_name = path_obj
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| anyhow::anyhow!("Invalid Arrow file name"))?;

            if !file_name.starts_with("easycris_") {
                anyhow::bail!("Arrow path must reference an app-managed temp file");
            }

            let temp_dir = std::env::temp_dir();
            if !path_obj.starts_with(&temp_dir) {
                anyhow::bail!("Arrow path must be inside the system temp directory");
            }
        }

        Ok(())
    }

    /// Get temporary Arrow file path for dataset
    pub fn get_temp_path(dataset_id: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("easycris_{}.arrow", dataset_id))
    }

    /// Delete temporary Arrow file
    pub fn delete_temp_file(dataset_id: &str) -> Result<()> {
        let path = Self::get_temp_path(dataset_id);
        if path.exists() {
            std::fs::remove_file(&path)?;
            log::info!("Deleted temp Arrow file: {:?}", path);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_write_and_read_numeric() {
        let temp_dir = std::env::temp_dir();
        let path = temp_dir.join("test_arrow_numeric.arrow");

        let columns = vec!["col1".to_string(), "col2".to_string()];
        let rows = vec![
            vec![Some(1.0), Some(2.0)],
            vec![Some(3.0), Some(4.0)],
            vec![None, Some(5.0)],
        ];

        ArrowHandler::write_to_file(&path, columns, rows).unwrap();

        let bytes = ArrowHandler::read_from_file(&path).unwrap();
        assert!(!bytes.is_empty());

        // Check it's a valid Arrow file (starts with ARROW1 magic)
        assert_eq!(&bytes[0..6], b"ARROW1");

        fs::remove_file(path).ok();
    }

    #[test]
    fn test_validate_path() {
        let temp_dir = std::env::temp_dir();
        let arrow_path = temp_dir.join("easycris_data.arrow");
        let ipc_path = temp_dir.join("easycris_data.ipc");
        let feather_path = temp_dir.join("easycris_data.feather");

        assert!(ArrowHandler::validate_path(&arrow_path.to_string_lossy()).is_ok());
        assert!(ArrowHandler::validate_path(&ipc_path.to_string_lossy()).is_ok());
        assert!(ArrowHandler::validate_path(&feather_path.to_string_lossy()).is_ok());
        assert!(ArrowHandler::validate_path("data.csv").is_err());
        assert!(ArrowHandler::validate_path("data.arrow").is_err());
        assert!(ArrowHandler::validate_path("../data.arrow").is_err());
    }
}
