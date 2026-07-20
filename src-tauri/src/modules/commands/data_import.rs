// Data import commands (CSV/TSV/Excel)
//
// Handles file parsing and returns dataset metadata + row data
// Phase 3C implementation - fixes blank grid issue
// All-DuckDB: Always imports via DuckDB (no size threshold)

use crate::modules::hybrid_cache_manager::HYBRID_CACHE;
use serde::{Deserialize, Serialize};
use serde_json::Value;
// All-DuckDB: std::fs removed - no longer needed
use std::path::{Component, Path};
use tauri::{command, Emitter};

// All-DuckDB: File size thresholds removed

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMetadata {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub column_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dataset {
    pub id: String,
    pub name: String,
    pub columns: Vec<ColumnMetadata>,
    #[serde(rename = "columnCount")]
    pub column_count: usize,
    #[serde(rename = "rowCount")]
    pub row_count: usize,
    pub source: String,
    #[serde(rename = "importedAt")]
    pub imported_at: String,
    #[serde(rename = "modifiedAt")]
    pub modified_at: String,
}

#[derive(Debug, Serialize)]
pub struct DataImportResult {
    pub dataset: Dataset,
    pub rows: Vec<Value>, // CRITICAL: Actual row data (empty for large datasets)
    #[serde(rename = "arrowData", skip_serializing_if = "Option::is_none")]
    pub arrow_data: Option<Vec<u8>>,
    /// Phase 5: True if dataset is stored in DuckDB (>= 1M rows or >= 500MB file)
    #[serde(rename = "isLargeDataset")]
    pub is_large_dataset: bool,
    /// Phase 5: Source file path for large datasets (for re-import)
    #[serde(rename = "sourcePath", skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
}

fn validate_import_path(file_path: &str, allowed_extensions: &[&str]) -> Result<(), String> {
    if file_path.trim().is_empty() {
        return Err("Invalid file path: path cannot be empty".to_string());
    }

    let path = Path::new(file_path);

    if !path.is_absolute() {
        return Err("Invalid file path: absolute path required".to_string());
    }

    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Invalid file path: directory traversal not allowed".to_string());
    }

    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    if !path.is_file() {
        return Err(format!("Path is not a file: {}", file_path));
    }

    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "Invalid file path: missing file extension".to_string())?;

    if !allowed_extensions
        .iter()
        .any(|allowed| ext == allowed.to_ascii_lowercase())
    {
        return Err(format!(
            "Invalid file extension '.{}' (allowed: {})",
            ext,
            allowed_extensions.join(", ")
        ));
    }

    Ok(())
}

/// Import CSV file
/// All-DuckDB: Always streams to DuckDB regardless of file size
#[command]
pub async fn import_csv(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<DataImportResult, String> {
    validate_import_path(&file_path, &["csv"])?;

    let dataset_id = format!("dataset-{}", chrono::Utc::now().timestamp_millis());
    let dataset_name = std::path::Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported CSV")
        .to_string();

    log::info!("Importing CSV to DuckDB: {}", file_path);

    // All-DuckDB: Import directly to DuckDB (never fully in memory)
    // CRITICAL: DuckDB columns are renamed to col-{idx} format during import
    let dataset_id_clone = dataset_id.clone();
    let emit_fn = Box::new(move |percentage: u32, message: &str| {
        let payload = serde_json::json!({
            "datasetId": dataset_id_clone,
            "percentage": percentage,
            "message": message
        });
        let _ = app.emit("import-progress", payload);
    });
    let row_count =
        HYBRID_CACHE.import_large_csv_with_progress(&dataset_id, &file_path, emit_fn)?;

    // Get column metadata from DuckDB (ID + display name pairs)
    let column_metadata = HYBRID_CACHE
        .get_column_metadata(&dataset_id)
        .ok_or_else(|| "Failed to get column metadata from DuckDB".to_string())?;

    // Build ColumnMetadata using col-{idx} IDs that match DuckDB column names
    let columns: Vec<ColumnMetadata> = column_metadata
        .into_iter()
        .map(|(col_id, display_name)| ColumnMetadata {
            id: col_id,         // col-{idx} - matches DuckDB column name
            name: display_name, // Original column name for UI display
            column_type: "text".to_string(),
        })
        .collect();

    let dataset = Dataset {
        id: dataset_id,
        name: dataset_name,
        columns: columns.clone(),
        column_count: columns.len(),
        row_count,
        source: "csv".to_string(),
        imported_at: chrono::Utc::now().to_rfc3339(),
        modified_at: chrono::Utc::now().to_rfc3339(),
    };

    Ok(DataImportResult {
        dataset,
        rows: Vec::new(), // Empty - grid will fetch via streaming row provider
        arrow_data: None,
        is_large_dataset: true, // All-DuckDB: always true
        source_path: Some(file_path),
    })
}

/// Import TSV file
/// All-DuckDB: Always streams to DuckDB regardless of file size
/// Also handles .txt files (treated as tab-delimited)
#[command]
pub async fn import_tsv(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<DataImportResult, String> {
    validate_import_path(&file_path, &["tsv", "txt"])?;

    let dataset_id = format!("dataset-{}", chrono::Utc::now().timestamp_millis());
    let dataset_name = std::path::Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported TSV")
        .to_string();

    log::info!("Importing TSV to DuckDB: {}", file_path);

    // All-DuckDB: Import directly to DuckDB (never fully in memory)
    // CRITICAL: DuckDB columns are renamed to col-{idx} format during import
    let dataset_id_clone = dataset_id.clone();
    let emit_fn = Box::new(move |percentage: u32, message: &str| {
        let payload = serde_json::json!({
            "datasetId": dataset_id_clone,
            "percentage": percentage,
            "message": message
        });
        let _ = app.emit("import-progress", payload);
    });
    let row_count =
        HYBRID_CACHE.import_large_tsv_with_progress(&dataset_id, &file_path, emit_fn)?;

    // Get column metadata from DuckDB (ID + display name pairs)
    let column_metadata = HYBRID_CACHE
        .get_column_metadata(&dataset_id)
        .ok_or_else(|| "Failed to get column metadata from DuckDB".to_string())?;

    // Build ColumnMetadata using col-{idx} IDs that match DuckDB column names
    let columns: Vec<ColumnMetadata> = column_metadata
        .into_iter()
        .map(|(col_id, display_name)| ColumnMetadata {
            id: col_id,         // col-{idx} - matches DuckDB column name
            name: display_name, // Original column name for UI display
            column_type: "text".to_string(),
        })
        .collect();

    let dataset = Dataset {
        id: dataset_id,
        name: dataset_name,
        columns: columns.clone(),
        column_count: columns.len(),
        row_count,
        source: "tsv".to_string(),
        imported_at: chrono::Utc::now().to_rfc3339(),
        modified_at: chrono::Utc::now().to_rfc3339(),
    };

    Ok(DataImportResult {
        dataset,
        rows: Vec::new(), // Empty - grid will fetch via streaming row provider
        arrow_data: None,
        is_large_dataset: true, // All-DuckDB: always true
        source_path: Some(file_path),
    })
}

/// Import Excel file (.xlsx, .xls, .xlsm, .xlsb, .ods)
/// All-DuckDB: Parses Excel then streams to DuckDB
#[command]
pub async fn import_excel(
    file_path: String,
    sheet_name: Option<String>,
) -> Result<DataImportResult, String> {
    use calamine::{open_workbook_auto, Data, Reader};

    validate_import_path(&file_path, &["xlsx", "xls", "xlsm", "xlsb", "ods"])?;

    // Open workbook (auto-detects format)
    let mut workbook = open_workbook_auto(&file_path).map_err(|e| {
        let err_msg = format!("{}", e);

        // Check if this is a .xls file issue
        if file_path.to_lowercase().ends_with(".xls") && !file_path.to_lowercase().ends_with(".xlsx") {
            if err_msg.contains("Cfb error") || err_msg.contains("Invalid OLE signature") {
                return format!(
                    "Failed to open .xls file: {}. Legacy .xls files (Excel 97-2003) may not be fully supported. \
                    Please try: (1) Opening the file in Excel and saving as .xlsx, or (2) Using a .xlsx file instead.",
                    err_msg
                );
            }
        }

        format!("Failed to open Excel file: {}", err_msg)
    })?;

    // Get sheet names
    let sheet_names = workbook.sheet_names().to_owned();
    if sheet_names.is_empty() {
        return Err("Excel file contains no sheets".to_string());
    }

    // Select sheet (use provided name or first sheet)
    let target_sheet = sheet_name.unwrap_or_else(|| sheet_names[0].clone());

    // Get worksheet range
    let range = workbook
        .worksheet_range(&target_sheet)
        .map_err(|e| format!("Failed to read sheet '{}': {}", target_sheet, e))?;

    // Get dimensions
    let (row_count, col_count) = range.get_size();
    if row_count == 0 || col_count == 0 {
        return Err("Excel sheet is empty".to_string());
    }

    // First row is headers
    let mut columns: Vec<ColumnMetadata> = Vec::new();
    if let Some(first_row) = range.rows().next() {
        for (idx, cell) in first_row.iter().enumerate() {
            let name = match cell {
                Data::String(s) => s.clone(),
                Data::Float(f) => f.to_string(),
                Data::Int(i) => i.to_string(),
                Data::Bool(b) => b.to_string(),
                Data::DateTime(dt) => format!("DateTime_{}", dt),
                Data::DateTimeIso(s) => s.clone(),
                Data::DurationIso(s) => s.clone(),
                Data::Error(_) | Data::Empty => format!("Column {}", idx + 1),
            };

            columns.push(ColumnMetadata {
                id: format!("col-{}", idx),
                name,
                column_type: "text".to_string(),
            });
        }
    }

    // Parse data rows (skip header row)
    let mut rows: Vec<Value> = Vec::new();
    for row in range.rows().skip(1) {
        let mut row_map = serde_json::Map::new();

        for (idx, cell) in row.iter().enumerate() {
            let col_id = format!("col-{}", idx);
            let value = match cell {
                Data::String(s) => Value::String(s.clone()),
                Data::Float(f) => {
                    // Check if it's actually an integer
                    if f.fract() == 0.0 && *f >= i64::MIN as f64 && *f <= i64::MAX as f64 {
                        Value::Number(serde_json::Number::from(*f as i64))
                    } else {
                        serde_json::Number::from_f64(*f)
                            .map(Value::Number)
                            .unwrap_or(Value::String(f.to_string()))
                    }
                }
                Data::Int(i) => Value::Number(serde_json::Number::from(*i)),
                Data::Bool(b) => Value::String(b.to_string()),
                Data::DateTime(dt) => {
                    // Convert Excel datetime serial to string
                    Value::String(format!("{:.6}", dt))
                }
                Data::DateTimeIso(s) => Value::String(s.clone()),
                Data::DurationIso(s) => Value::String(s.clone()),
                Data::Error(e) => Value::String(format!("#ERR:{:?}", e)),
                Data::Empty => Value::String(String::new()),
            };

            row_map.insert(col_id, value);
        }

        rows.push(Value::Object(row_map));
    }

    let dataset_id = format!("dataset-{}", chrono::Utc::now().timestamp_millis());
    let dataset_name = std::path::Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported Excel")
        .to_string();

    log::info!(
        "Excel parsed: {} rows x {} columns from sheet '{}'. Importing to DuckDB...",
        rows.len(),
        columns.len(),
        target_sheet
    );

    // All-DuckDB: Convert parsed rows and import to DuckDB
    use crate::modules::hybrid_cache_manager::{ColumnInfo, HYBRID_CACHE};

    let column_info: Vec<ColumnInfo> = columns
        .iter()
        .map(|c| ColumnInfo {
            name: c.id.clone(),           // col-{idx}
            display_name: c.name.clone(), // Original Excel column name
            dtype: "VARCHAR".to_string(),
        })
        .collect();

    // Convert Vec<Value> to Vec<HashMap<String, Value>>
    let rows_for_import: Vec<std::collections::HashMap<String, Value>> = rows
        .iter()
        .filter_map(|v| {
            if let Value::Object(map) = v {
                Some(map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            } else {
                None
            }
        })
        .collect();

    let row_count = HYBRID_CACHE.import_from_rows(&dataset_id, column_info, rows_for_import)?;

    let dataset = Dataset {
        id: dataset_id,
        name: dataset_name,
        columns: columns.clone(),
        column_count: columns.len(),
        row_count,
        source: "excel".to_string(),
        imported_at: chrono::Utc::now().to_rfc3339(),
        modified_at: chrono::Utc::now().to_rfc3339(),
    };

    log::info!("Excel import to DuckDB complete: {} rows", row_count);

    Ok(DataImportResult {
        dataset,
        rows: Vec::new(), // Empty - grid will fetch via streaming row provider
        arrow_data: None,
        is_large_dataset: true, // All-DuckDB: always true
        source_path: Some(file_path),
    })
}

/// Import Parquet file
///
/// Parquet is the optimal format for large datasets (50M+ rows):
/// - Columnar format (DuckDB reads with near-zero overhead)
/// - Compressed (10-50x smaller than CSV)
/// - Schema embedded (no type inference needed)
/// - Column pruning (only reads needed columns)
///
/// All Parquet imports go directly to DuckDB for optimal performance.
#[command]
pub async fn import_parquet(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<DataImportResult, String> {
    validate_import_path(&file_path, &["parquet"])?;

    let dataset_id = format!("dataset-{}", chrono::Utc::now().timestamp_millis());
    let dataset_name = std::path::Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported Parquet")
        .to_string();

    log::info!("Importing Parquet file: {}", file_path);

    // All Parquet files use DuckDB path for optimal performance
    // CRITICAL: DuckDB columns are renamed to col-{idx} format during import
    let dataset_id_clone = dataset_id.clone();
    let emit_fn = Box::new(move |percentage: u32, message: &str| {
        let payload = serde_json::json!({
            "datasetId": dataset_id_clone,
            "percentage": percentage,
            "message": message
        });
        let _ = app.emit("import-progress", payload);
    });
    let row_count =
        HYBRID_CACHE.import_large_parquet_with_progress(&dataset_id, &file_path, emit_fn)?;

    // Get column metadata from DuckDB (ID + display name pairs)
    let column_metadata = HYBRID_CACHE
        .get_column_metadata(&dataset_id)
        .ok_or_else(|| "Failed to get column metadata from DuckDB".to_string())?;

    // Build ColumnMetadata using col-{idx} IDs that match DuckDB column names
    let columns: Vec<ColumnMetadata> = column_metadata
        .into_iter()
        .map(|(col_id, display_name)| ColumnMetadata {
            id: col_id,                      // col-{idx} - matches DuckDB column name
            name: display_name,              // Original column name for UI display
            column_type: "text".to_string(), // DuckDB handles types internally
        })
        .collect();

    let dataset = Dataset {
        id: dataset_id,
        name: dataset_name,
        columns: columns.clone(),
        column_count: columns.len(),
        row_count,
        source: "parquet".to_string(),
        imported_at: chrono::Utc::now().to_rfc3339(),
        modified_at: chrono::Utc::now().to_rfc3339(),
    };

    log::info!(
        "Parquet import complete: {} rows x {} columns",
        row_count,
        columns.len()
    );

    Ok(DataImportResult {
        dataset,
        rows: Vec::new(), // Empty - grid will fetch via streaming row provider
        arrow_data: None,
        is_large_dataset: true, // Always treat as large for DuckDB benefits
        source_path: Some(file_path),
    })
}

/// Update dataset metadata (column names, types, etc.)
/// Called when user renames columns in the grid
#[command]
pub async fn update_dataset_metadata(
    dataset_id: String,
    columns: Vec<ColumnMetadata>,
) -> Result<(), String> {
    // TODO Phase 4: Persist to backend cache/database
    // For now, this is a no-op that validates the structure

    if columns.is_empty() {
        return Err("Cannot update dataset with empty columns".to_string());
    }

    // Log the update for debugging
    println!(
        "Dataset {} metadata updated: {} columns",
        dataset_id,
        columns.len()
    );
    for col in &columns {
        println!(
            "  - Column '{}' (id: {}, type: {})",
            col.name, col.id, col.column_type
        );
    }

    // TODO: Store in persistent backend cache (Redis/SQLite/in-memory map)
    // For now, frontend data-store is the source of truth

    Ok(())
}
