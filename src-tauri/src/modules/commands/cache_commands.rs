// Cache Commands - Phase 4 Milestone 3 + Phase 5 (Hybrid Cache) + Phase 6 (Backend Formulas)
//
// Tauri commands for dataset cache operations.
// Enables real-time grid edit synchronization between frontend and backend.
// Phase 5: Adds DuckDB-backed storage for large datasets (>= 1M rows).
// Phase 6: Adds backend formula evaluation using Formualizer engine.

use crate::modules::cache_manager::CACHE;
use crate::modules::hybrid_cache_manager::{
    ColumnAggregationRequest, ColumnClassificationStats, ColumnDuplicateSummary, ColumnSearchMatch,
    HYBRID_CACHE,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Component;
use std::path::{Path, PathBuf};
use tauri::command;
use tauri::Emitter;

fn validate_project_id_input(project_id: &str) -> Result<String, String> {
    let trimmed = project_id.trim();
    if trimmed.is_empty() {
        return Err("Project ID is required".to_string());
    }
    if trimmed.len() > 128 {
        return Err("Project ID is too long".to_string());
    }
    if trimmed.contains("..") {
        return Err("Invalid project ID path segments".to_string());
    }
    // Keep compatibility with legacy IDs (including spaces), while blocking
    // unsafe/invalid filesystem characters and control bytes.
    if trimmed.chars().any(|ch| {
        ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }) {
        return Err("Invalid project ID characters".to_string());
    }
    Ok(trimmed.to_string())
}

/// Cell position for backend formula evaluation
/// Uses VIEW coordinates (display position, 0-based)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellPosition {
    /// Row index in VIEW coordinates (0-indexed, display row)
    pub row: usize,
    /// Column index (0-indexed, display column)
    pub col: usize,
}

/// Set entire dataset in cache (called after import)
///
/// # Arguments
/// * `dataset_id` - Unique identifier for the dataset
/// * `rows` - Row data as Vec<HashMap<String, Value>>
#[command]
pub async fn set_dataset_cache(
    dataset_id: String,
    rows: Vec<HashMap<String, Value>>,
) -> Result<(), String> {
    // Keep HYBRID_CACHE as the primary store so reads reflect latest edits
    HYBRID_CACHE.set_dataset(&dataset_id, rows.clone());
    CACHE.set_dataset(&dataset_id, rows);
    Ok(())
}

/// Update single cell in cache
///
/// CRITICAL FIX: Routes to HYBRID_CACHE first (handles large DuckDB datasets),
/// then falls back to legacy CACHE for small datasets.
///
/// # Arguments
/// * `dataset_id` - Dataset identifier
/// * `row` - Row index (0-based)
/// * `column` - Column ID
/// * `value` - New cell value
#[command]
pub async fn update_cell(
    dataset_id: String,
    row: usize,
    column: String,
    value: Value,
) -> Result<(), String> {
    // Try HYBRID_CACHE first (handles large DuckDB datasets + in-memory via HYBRID_CACHE)
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE.update_cell(&dataset_id, row, &column, value);
    }
    // Fall back to legacy CACHE for small datasets that haven't been migrated
    CACHE.update_cell(&dataset_id, row, &column, value)
}

/// Update multiple cells in batch (for paste operations)
///
/// CRITICAL FIX: Routes to HYBRID_CACHE first (handles large DuckDB datasets),
/// then falls back to legacy CACHE for small datasets.
///
/// # Arguments
/// * `dataset_id` - Dataset identifier
/// * `updates` - Vec of (row, column, value) tuples
#[command]
pub async fn update_cells_batch(
    dataset_id: String,
    updates: Vec<(usize, String, Value)>,
) -> Result<usize, String> {
    // Try HYBRID_CACHE first (handles large DuckDB datasets + in-memory via HYBRID_CACHE)
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE.update_cells_batch(&dataset_id, updates);
    }
    // Fall back to legacy CACHE for small datasets that haven't been migrated
    CACHE.update_cells_batch(&dataset_id, updates)
}

/// Get single column data
///
/// # Arguments
/// * `dataset_id` - Dataset identifier
/// * `column_id` - Column ID to retrieve
#[command]
pub async fn get_column_data(dataset_id: String, column_id: String) -> Result<Vec<Value>, String> {
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE
            .get_column_data(&dataset_id, &column_id)
            .ok_or_else(|| {
                format!(
                    "Column '{}' not available for dataset '{}' (large datasets require DataProvider)",
                    column_id, dataset_id
                )
            });
    }

    CACHE
        .get_column_data(&dataset_id, &column_id)
        .ok_or_else(|| {
            format!(
                "Column '{}' not found in dataset '{}'",
                column_id, dataset_id
            )
        })
}

/// Get multiple columns data (for statistical tests and find/replace)
///
/// CRITICAL FIX: Routes to HYBRID_CACHE first (handles large DuckDB datasets),
/// then falls back to legacy CACHE for small datasets.
///
/// # Arguments
/// * `dataset_id` - Dataset identifier
/// * `column_ids` - Column IDs to retrieve
#[command]
pub async fn get_columns_data(
    dataset_id: String,
    column_ids: Vec<String>,
) -> Result<HashMap<String, Vec<Value>>, String> {
    // Try HYBRID_CACHE first (handles large DuckDB datasets + in-memory)
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        if let Some(data) = HYBRID_CACHE.get_columns_data(&dataset_id, &column_ids) {
            return Ok(data);
        }
        // For large DuckDB datasets, HYBRID_CACHE intentionally returns None to avoid OOM.
        // Do NOT fall back to legacy CACHE in that case.
        return Err(format!(
            "Columns not available for dataset '{}' (large datasets require DataProvider)",
            dataset_id
        ));
    }

    // Fall back to legacy CACHE for small datasets that haven't been migrated
    CACHE
        .get_columns_data(&dataset_id, &column_ids)
        .ok_or_else(|| format!("Dataset '{}' not found", dataset_id))
}

/// Get sampled column data (for plots on large datasets)
///
/// # Arguments
/// * `dataset_id` - Dataset identifier
/// * `column_ids` - Column IDs to retrieve
/// * `sample_size` - Max number of rows to return
/// * `seed` - Optional seed for deterministic sampling offset
#[command]
pub async fn get_columns_sampled_data(
    dataset_id: String,
    column_ids: Vec<String>,
    sample_size: usize,
    seed: Option<u64>,
) -> Result<HashMap<String, Vec<Value>>, String> {
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE.get_columns_sampled_data(&dataset_id, &column_ids, sample_size, seed);
    }

    // Fall back to legacy CACHE for small datasets that haven't been migrated
    CACHE
        .get_columns_data(&dataset_id, &column_ids)
        .ok_or_else(|| format!("Dataset '{}' not found", dataset_id))
}

/// Get aggregated column data (group-by summaries)
///
/// # Arguments
/// * `dataset_id` - Dataset identifier
/// * `group_by` - Column IDs to group by
/// * `aggregations` - Aggregation requests (column_id, func, alias)
#[command]
pub async fn get_columns_aggregated_data(
    dataset_id: String,
    group_by: Vec<String>,
    aggregations: Vec<ColumnAggregationRequest>,
) -> Result<HashMap<String, Vec<Value>>, String> {
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE.get_columns_aggregated_data(&dataset_id, &group_by, &aggregations);
    }

    Err(format!("Dataset '{}' not found", dataset_id))
}

/// Search column values (for find/replace on large datasets)
///
/// # Arguments
/// * `dataset_id` - Dataset identifier
/// * `column_ids` - Column IDs to search
/// * `search_text` - Text to search for
/// * `case_sensitive` - Case sensitivity flag
/// * `whole_word` - Whole word match flag
#[command]
pub async fn search_columns_values(
    dataset_id: String,
    column_ids: Vec<String>,
    search_text: String,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<Vec<ColumnSearchMatch>, String> {
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE.search_columns_values(
            &dataset_id,
            &column_ids,
            &search_text,
            case_sensitive,
            whole_word,
        );
    }

    Err(format!("Dataset '{}' not found", dataset_id))
}

/// Flush dataset to Arrow file (before test execution)
/// Returns the path to the temporary Arrow file
///
/// # Arguments
/// * `dataset_id` - Dataset identifier
#[command]
pub async fn flush_dataset_to_arrow(dataset_id: String) -> Result<String, String> {
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE.flush_to_arrow(&dataset_id);
    }
    CACHE.flush_to_arrow(&dataset_id)
}

/// Check if dataset exists in cache
#[command]
pub async fn has_cached_dataset(dataset_id: String) -> bool {
    HYBRID_CACHE.has_dataset(&dataset_id) || CACHE.has_dataset(&dataset_id)
}

/// Get dataset row count
#[command]
pub async fn get_cached_row_count(dataset_id: String) -> Result<usize, String> {
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE
            .get_row_count(&dataset_id)
            .ok_or_else(|| format!("Dataset '{}' not found", dataset_id));
    }
    CACHE
        .get_row_count(&dataset_id)
        .ok_or_else(|| format!("Dataset '{}' not found", dataset_id))
}

/// Get rows in a range (for streaming row provider)
/// Returns rows [start_row, end_row) - end is exclusive
///
/// # Arguments
/// * `dataset_id` - Dataset identifier
/// * `start_row` - Start row index (inclusive, 0-based)
/// * `end_row` - End row index (exclusive)
#[command]
pub async fn get_rows(
    dataset_id: String,
    start_row: usize,
    end_row: usize,
) -> Result<Vec<HashMap<String, Value>>, String> {
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE
            .get_rows_range(&dataset_id, start_row, end_row)
            .ok_or_else(|| format!("Dataset '{}' not found", dataset_id));
    }
    CACHE
        .get_rows_range(&dataset_id, start_row, end_row)
        .ok_or_else(|| format!("Dataset '{}' not found", dataset_id))
}

/// Add a new column to all rows in a dataset
/// Returns the number of rows updated
///
/// # Arguments
/// * `dataset_id` - Dataset identifier
/// * `column_id` - New column ID
/// * `default_value` - Default value for all cells in the new column
#[command]
pub async fn add_column(
    dataset_id: String,
    column_id: String,
    default_value: Value,
) -> Result<usize, String> {
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE.add_column(&dataset_id, &column_id, default_value);
    }
    CACHE.add_column(&dataset_id, &column_id, default_value)
}

/// Insert an empty row at the given model-row index.
/// Existing rows at/after the index are shifted down by one.
#[command]
pub async fn insert_row_at(dataset_id: String, row_index: usize) -> Result<usize, String> {
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE.insert_row_at(&dataset_id, row_index);
    }
    CACHE.insert_row_at(&dataset_id, row_index)
}

/// Remove a row at the given model-row index.
#[command]
pub async fn remove_row_at(dataset_id: String, row_index: usize) -> Result<usize, String> {
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE.remove_row_at(&dataset_id, row_index);
    }
    CACHE.remove_row_at(&dataset_id, row_index)
}

/// Remove a column from all rows in a dataset.
#[command]
pub async fn remove_column(dataset_id: String, column_id: String) -> Result<usize, String> {
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE.remove_column(&dataset_id, &column_id);
    }
    CACHE.remove_column(&dataset_id, &column_id)
}

/// Create empty DuckDB table for manual data entry
///
/// All-DuckDB Migration: Used when user creates a new blank dataset.
/// Creates an empty table with the specified schema, ready for cell edits.
///
/// # Arguments
/// * `dataset_id` - Dataset identifier
/// * `columns` - Column definitions (id, name, dtype)
#[command]
pub async fn create_empty_duckdb(
    dataset_id: String,
    columns: Vec<serde_json::Value>,
) -> Result<(), String> {
    use crate::modules::hybrid_cache_manager::ColumnInfo;

    // Parse column definitions from JSON
    let column_info: Vec<ColumnInfo> = columns
        .iter()
        .filter_map(|v| {
            if let Some(obj) = v.as_object() {
                Some(ColumnInfo {
                    name: obj.get("id")?.as_str()?.to_string(),
                    display_name: obj.get("name")?.as_str()?.to_string(),
                    dtype: obj
                        .get("dtype")
                        .and_then(|d| d.as_str())
                        .unwrap_or("VARCHAR")
                        .to_string(),
                })
            } else {
                None
            }
        })
        .collect();

    HYBRID_CACHE.create_empty_table(&dataset_id, column_info)
}

/// Remove dataset from cache
#[command]
pub async fn remove_dataset_cache(dataset_id: String) -> bool {
    if HYBRID_CACHE.has_dataset(&dataset_id) {
        return HYBRID_CACHE.remove_dataset(&dataset_id);
    }
    CACHE.remove_dataset(&dataset_id)
}

/// Remove dataset from cache with explicit project ID (project isolation cleanup)
#[command]
pub async fn remove_dataset_cache_with_project(project_id: String, dataset_id: String) -> bool {
    let validated = match validate_project_id_input(&project_id) {
        Ok(value) => value,
        Err(error) => {
            log::warn!(
                "remove_dataset_cache_with_project rejected project_id: {}",
                error
            );
            return false;
        }
    };
    HYBRID_CACHE.remove_dataset_with_project(&validated, &dataset_id)
}

/// Clear all cached datasets
#[command]
pub async fn clear_all_cache() {
    HYBRID_CACHE.clear();
    CACHE.clear();
}

/// Clear cache files under AppData for the current project only.
/// Preserves active in-use datasets and never auto-deletes project-adjacent files.
#[command]
pub async fn clear_current_project_cache(
    project_id: String,
) -> Result<crate::modules::hybrid_cache_manager::CacheCleanupSummary, String> {
    let validated = validate_project_id_input(&project_id)?;
    Ok(HYBRID_CACHE.clear_current_project_cache(&validated))
}

/// Clear all eligible unsaved/AppData cache files immediately.
/// Active in-use files are preserved.
#[command]
pub async fn clear_unsaved_app_cache() -> crate::modules::hybrid_cache_manager::CacheCleanupSummary
{
    HYBRID_CACHE.clear_unsaved_app_cache()
}

/// Compatibility alias for full unsaved/AppData clear.
/// Uses the same behavior as clear_unsaved_app_cache and preserves active in-use files.
#[command]
pub async fn clear_all_app_cache() -> crate::modules::hybrid_cache_manager::CacheCleanupSummary {
    HYBRID_CACHE.clear_all_app_cache()
}

/// Return local cache/disk health summary for storage-pressure prompts.
#[command]
pub async fn get_cache_health_summary() -> crate::modules::hybrid_cache_manager::CacheHealthSummary
{
    HYBRID_CACHE.get_cache_health_summary()
}

// ============================================================================
// PHASE 5: HYBRID CACHE COMMANDS (DuckDB for large datasets)
// ============================================================================

/// Storage info response for frontend routing
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetStorageInfo {
    pub is_large: bool,
    pub duckdb_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestAggregatesResult {
    pub test_name: String,
    pub aggregates: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMeta {
    pub start_view_row: usize,
    pub key: String,
    pub size: usize,
    pub collapsed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedRowOrder {
    pub row_order: Vec<i64>,
    pub group_meta: Vec<GroupMeta>,
}

/// Lazy group metadata for large datasets (O(groups) not O(rows))
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LazyGroupMeta {
    pub key: String,
    pub size: usize,
    pub first_row_index: i64,
}

/// Result of lazy group metadata query
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LazyGroupedResult {
    pub groups: Vec<LazyGroupMeta>,
    pub total_rows: usize,
}

/// Check if dataset is stored in DuckDB (large dataset path)
#[command]
pub async fn is_large_dataset(dataset_id: String) -> bool {
    HYBRID_CACHE.is_large_dataset(&dataset_id)
}

/// Get storage info needed for analysis routing
/// Large datasets return duckdb_path for Python DataProvider
#[command]
pub async fn get_dataset_storage_info(dataset_id: String) -> Result<DatasetStorageInfo, String> {
    match HYBRID_CACHE.get_dataset_storage_info(&dataset_id) {
        Some((is_large, duckdb_path)) => Ok(DatasetStorageInfo {
            is_large,
            duckdb_path,
        }),
        None => Err(format!("Dataset '{}' not found", dataset_id)),
    }
}

/// Compute aggregates for supported tests using DuckDB (Rust-owned, no Python file access).
#[command]
pub async fn get_aggregates_for_test(
    dataset_id: String,
    test_name: String,
    numeric_column: Option<String>,
    group_column: Option<String>,
) -> Result<TestAggregatesResult, String> {
    let aggregates = HYBRID_CACHE.get_aggregates_for_test(
        &dataset_id,
        &test_name,
        numeric_column.as_deref(),
        group_column.as_deref(),
    )?;

    Ok(TestAggregatesResult {
        test_name,
        aggregates,
    })
}

/// Ensure dataset is stored in DuckDB (converts in-memory datasets on demand).
#[command]
pub async fn ensure_duckdb_dataset(
    dataset_id: String,
    columns: Vec<serde_json::Value>,
) -> Result<DatasetStorageInfo, String> {
    use crate::modules::hybrid_cache_manager::ColumnInfo;

    let column_info: Vec<ColumnInfo> = columns
        .iter()
        .filter_map(|v| {
            if let Some(obj) = v.as_object() {
                Some(ColumnInfo {
                    name: obj.get("id")?.as_str()?.to_string(),
                    display_name: obj.get("name")?.as_str()?.to_string(),
                    dtype: obj
                        .get("dtype")
                        .and_then(|d| d.as_str())
                        .unwrap_or("VARCHAR")
                        .to_string(),
                })
            } else {
                None
            }
        })
        .collect();

    let (is_large, duckdb_path) = HYBRID_CACHE.ensure_duckdb_dataset(&dataset_id, column_info)?;

    Ok(DatasetStorageInfo {
        is_large,
        duckdb_path,
    })
}

/// Flush overlay edits to DuckDB (required before sort/export/analysis)
#[command]
pub async fn flush_overlay(dataset_id: String) -> Result<(), String> {
    HYBRID_CACHE.flush_overlay(&dataset_id)
}

/// Get sorted row indices for server-side sorting (DuckDB datasets)
/// Returns row indices in sorted order - grid displays rows in this order
#[command]
pub async fn get_sorted_row_indices(
    dataset_id: String,
    sort_column: String,
    descending: bool,
) -> Result<Vec<i64>, String> {
    HYBRID_CACHE.get_sorted_row_indices(&dataset_id, &sort_column, descending)
}

/// Get grouped row order and metadata for large datasets (DuckDB)
#[command]
pub async fn get_grouped_row_order(
    dataset_id: String,
    group_column: String,
    sort_column: Option<String>,
    descending: bool,
    collapsed_groups: Vec<String>,
) -> Result<GroupedRowOrder, String> {
    let result = HYBRID_CACHE.get_grouped_row_order(
        &dataset_id,
        &group_column,
        sort_column.as_deref(),
        descending,
        &collapsed_groups,
    )?;

    let group_meta = result
        .group_meta
        .into_iter()
        .map(|g| GroupMeta {
            start_view_row: g.start_view_row,
            key: g.key,
            size: g.size,
            collapsed: g.collapsed,
        })
        .collect();

    Ok(GroupedRowOrder {
        row_order: result.row_order,
        group_meta,
    })
}

/// Get lazy group metadata using DuckDB GROUP BY aggregation.
/// O(groups) complexity - does NOT fetch all rows.
/// For 18M rows with 100 groups: returns 100 entries, not 18M.
#[command]
pub async fn get_lazy_group_metadata(
    dataset_id: String,
    group_column: String,
    sort_column: Option<String>,
    descending: bool,
) -> Result<LazyGroupedResult, String> {
    let result = HYBRID_CACHE.get_lazy_group_metadata(
        &dataset_id,
        &group_column,
        sort_column.as_deref(),
        descending,
    )?;

    let groups = result
        .groups
        .into_iter()
        .map(|g| LazyGroupMeta {
            key: g.key,
            size: g.size,
            first_row_index: g.first_row_index,
        })
        .collect();

    Ok(LazyGroupedResult {
        groups,
        total_rows: result.total_rows,
    })
}

/// Get rows for a specific group with pagination.
/// Used to fetch visible rows within a group on scroll.
#[command]
pub async fn get_group_rows(
    dataset_id: String,
    group_column: String,
    group_key: String,
    sort_column: Option<String>,
    descending: bool,
    offset: usize,
    limit: usize,
) -> Result<Vec<i64>, String> {
    HYBRID_CACHE.get_group_rows(
        &dataset_id,
        &group_column,
        &group_key,
        sort_column.as_deref(),
        descending,
        offset,
        limit,
    )
}

/// Import large CSV directly into DuckDB (streaming, never fully in memory)
/// Called from data_import for files >= 500MB
/// Emits 'import-progress' events with percentage and status message
#[command]
pub async fn import_large_csv(
    app: tauri::AppHandle,
    dataset_id: String,
    file_path: String,
) -> Result<usize, String> {
    let dataset_id_clone = dataset_id.clone();

    // Create progress emit closure
    let emit_fn = Box::new(move |percentage: u32, message: &str| {
        let payload = serde_json::json!({
            "datasetId": dataset_id_clone,
            "percentage": percentage,
            "message": message
        });
        let _ = app.emit("import-progress", payload);
    });

    HYBRID_CACHE.import_large_csv_with_progress(&dataset_id, &file_path, emit_fn)
}

/// Import large Parquet directly into DuckDB (streaming, never fully in memory)
/// Parquet is optimal for 50M+ row datasets (columnar, compressed, schema-embedded)
/// Emits 'import-progress' events with percentage and status message
#[command]
pub async fn import_large_parquet(
    app: tauri::AppHandle,
    dataset_id: String,
    file_path: String,
) -> Result<usize, String> {
    let dataset_id_clone = dataset_id.clone();

    // Create progress emit closure
    let emit_fn = Box::new(move |percentage: u32, message: &str| {
        let payload = serde_json::json!({
            "datasetId": dataset_id_clone,
            "percentage": percentage,
            "message": message
        });
        let _ = app.emit("import-progress", payload);
    });

    HYBRID_CACHE.import_large_parquet_with_progress(&dataset_id, &file_path, emit_fn)
}

// ============================================================================
// PHASE 4: PROJECT-AWARE IMPORT COMMANDS
// ============================================================================

/// Import large CSV with project-scoped path (Phase 4: Collision Prevention)
///
/// Creates DuckDB file in project-specific cache directory to prevent
/// collisions when multiple projects have datasets with the same ID.
///
/// Emits 'import-progress' events with percentage and status message.
#[command]
pub async fn import_large_csv_with_project(
    app: tauri::AppHandle,
    project_id: String,
    dataset_id: String,
    file_path: String,
) -> Result<usize, String> {
    let validated_project_id = validate_project_id_input(&project_id)?;
    let dataset_id_clone = dataset_id.clone();

    // Create progress emit closure
    let emit_fn = Box::new(move |percentage: u32, message: &str| {
        let payload = serde_json::json!({
            "datasetId": dataset_id_clone,
            "percentage": percentage,
            "message": message
        });
        let _ = app.emit("import-progress", payload);
    });

    HYBRID_CACHE.import_large_csv_with_project_with_progress(
        &validated_project_id,
        &dataset_id,
        &file_path,
        emit_fn,
    )
}

/// Import large Parquet with project-scoped path (Phase 4: Collision Prevention)
///
/// Creates DuckDB file in project-specific cache directory to prevent
/// collisions when multiple projects have datasets with the same ID.
///
/// Emits 'import-progress' events with percentage and status message.
#[command]
pub async fn import_large_parquet_with_project(
    app: tauri::AppHandle,
    project_id: String,
    dataset_id: String,
    file_path: String,
) -> Result<usize, String> {
    let validated_project_id = validate_project_id_input(&project_id)?;
    let dataset_id_clone = dataset_id.clone();

    // Create progress emit closure
    let emit_fn = Box::new(move |percentage: u32, message: &str| {
        let payload = serde_json::json!({
            "datasetId": dataset_id_clone,
            "percentage": percentage,
            "message": message
        });
        let _ = app.emit("import-progress", payload);
    });

    HYBRID_CACHE.import_large_parquet_with_project_with_progress(
        &validated_project_id,
        &dataset_id,
        &file_path,
        emit_fn,
    )
}

/// Set project data directory (project-adjacent storage)
///
/// When set, all database files for this project will be stored in the
/// specified directory instead of AppData. This avoids permission issues
/// and keeps everything together with the .ecp file.
///
/// Call this before importing datasets to ensure they're stored in the
/// correct location (next to the .ecp file, not in AppData).
#[command]
pub async fn set_project_data_dir(project_id: String, data_dir: String) -> Result<(), String> {
    let validated_project_id = validate_project_id_input(&project_id)?;
    let path = PathBuf::from(&data_dir);
    if !is_directory_path_allowed(&path) {
        return Err("Invalid project data directory path".to_string());
    }

    HYBRID_CACHE.set_project_data_dir(&validated_project_id, path);
    Ok(())
}

/// Phase B: Set active project ID for dataset namespacing
///
/// Call this in COMMIT phase (after preflight succeeds) when opening a project,
/// or immediately after generating projectId for new projects.
/// Returns the previous active project ID for rollback on failure.
#[command]
pub async fn set_active_project_id(project_id: String) -> Option<String> {
    let validated = match validate_project_id_input(&project_id) {
        Ok(value) => value,
        Err(error) => {
            log::warn!("set_active_project_id rejected project_id: {}", error);
            return HYBRID_CACHE.get_active_project_id();
        }
    };
    HYBRID_CACHE.set_active_project_id(&validated)
}

/// Phase B: Get current active project ID
#[command]
pub async fn get_active_project_id() -> Option<String> {
    HYBRID_CACHE.get_active_project_id()
}

/// Phase B: Clear active project ID (returns previous for rollback)
#[command]
pub async fn clear_active_project_id() -> Option<String> {
    HYBRID_CACHE.clear_active_project_id()
}

/// PHASE 1: Copy a dataset's data file to project directory (non-destructive).
/// Call finalize_bundled_dataset_file after .ecp save succeeds.
#[command]
pub async fn bundle_dataset_data_file(
    project_id: String,
    dataset_id: String,
) -> Result<String, String> {
    let validated_project_id = validate_project_id_input(&project_id)?;
    let dest_path = HYBRID_CACHE.bundle_dataset_data_file(&validated_project_id, &dataset_id)?;
    Ok(dest_path.to_string_lossy().to_string())
}

/// PHASE 2: Finalize bundled dataset (destructive, call after .ecp save succeeds).
/// Updates internal path and deletes old file.
#[command]
pub async fn finalize_bundled_dataset_file(
    project_id: String,
    dataset_id: String,
) -> Result<(), String> {
    let validated_project_id = validate_project_id_input(&project_id)?;
    HYBRID_CACHE.finalize_bundled_dataset_file(&validated_project_id, &dataset_id)
}

/// Check if a path exists (backend-side, avoids frontend fs scope limits).
fn normalize_candidate_path(path: &Path) -> Option<PathBuf> {
    if path.exists() {
        return path.canonicalize().ok();
    }

    // Allow non-existent final segment (e.g., new project data dir) by canonicalizing parent.
    let parent = path.parent()?;
    let parent_canonical = parent.canonicalize().ok()?;
    let name = path.file_name()?;
    Some(parent_canonical.join(name))
}

fn has_disallowed_segments(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn has_allowed_probe_extension(path: &Path) -> bool {
    let ext = match path.extension().and_then(|value| value.to_str()) {
        Some(value) => value.to_ascii_lowercase(),
        None => return false,
    };

    matches!(
        ext.as_str(),
        "ecp"
            | "ecpdb"
            | "duckdb"
            | "csv"
            | "tsv"
            | "txt"
            | "xlsx"
            | "xls"
            | "xlsm"
            | "xlsb"
            | "ods"
            | "parquet"
            | "arrow"
            | "ipc"
            | "feather"
    )
}

#[cfg(windows)]
fn is_blocked_network_path(path: &Path) -> bool {
    use std::path::{Component, Prefix};

    match path.components().next() {
        Some(Component::Prefix(prefix_component)) => {
            matches!(
                prefix_component.kind(),
                Prefix::UNC(_, _) | Prefix::VerbatimUNC(_, _)
            )
        }
        _ => path.to_string_lossy().starts_with(r"\\"),
    }
}

#[cfg(not(windows))]
fn is_blocked_network_path(path: &Path) -> bool {
    path.to_string_lossy().starts_with(r"\\")
}

fn is_base_path_allowed_no_debug(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }

    if has_disallowed_segments(path) {
        return false;
    }

    let candidate = match normalize_candidate_path(path) {
        Some(path) => path,
        None => return false,
    };

    // Block UNC/network paths in production, but allow Windows local verbatim paths (\\?\C:\...).
    if is_blocked_network_path(&candidate) {
        return false;
    }

    true
}

fn is_file_path_allowed_no_debug(path: &Path) -> bool {
    if !is_base_path_allowed_no_debug(path) {
        return false;
    }

    has_allowed_probe_extension(path)
}

fn is_directory_path_allowed_no_debug(path: &Path) -> bool {
    is_base_path_allowed_no_debug(path)
}

fn is_path_allowed(path: &Path) -> bool {
    if cfg!(debug_assertions) {
        return true;
    }
    is_file_path_allowed_no_debug(path)
}

fn is_directory_path_allowed(path: &Path) -> bool {
    if cfg!(debug_assertions) {
        return true;
    }
    is_directory_path_allowed_no_debug(path)
}

#[command]
pub async fn path_exists(path: String) -> bool {
    path_exists_file(path).await
}

#[command]
pub async fn path_exists_file(path: String) -> bool {
    let path_obj = Path::new(&path);
    if !is_path_allowed(path_obj) {
        return false;
    }
    let candidate = match normalize_candidate_path(path_obj) {
        Some(path) => path,
        None => return false,
    };
    candidate.exists() && candidate.is_file()
}

#[command]
pub async fn path_exists_dir(path: String) -> bool {
    let path_obj = Path::new(&path);
    if !is_directory_path_allowed(path_obj) {
        return false;
    }
    let candidate = match normalize_candidate_path(path_obj) {
        Some(path) => path,
        None => return false,
    };
    candidate.exists() && candidate.is_dir()
}

/// Set dataset using hybrid cache (auto-routes to memory or DuckDB)
#[command]
pub async fn set_dataset_hybrid(
    dataset_id: String,
    rows: Vec<HashMap<String, Value>>,
) -> Result<(), String> {
    HYBRID_CACHE.set_dataset(&dataset_id, rows);
    Ok(())
}

/// Get rows from hybrid cache (works for both in-memory and DuckDB)
#[command]
pub async fn get_rows_hybrid(
    dataset_id: String,
    start_row: usize,
    end_row: usize,
) -> Result<Vec<HashMap<String, Value>>, String> {
    HYBRID_CACHE
        .get_rows_range(&dataset_id, start_row, end_row)
        .ok_or_else(|| format!("Dataset '{}' not found", dataset_id))
}

/// Get column data from hybrid cache
/// Returns None for large datasets - use Python DataProvider instead
#[command]
pub async fn get_column_data_hybrid(
    dataset_id: String,
    column_id: String,
) -> Result<Option<Vec<Value>>, String> {
    Ok(HYBRID_CACHE.get_column_data(&dataset_id, &column_id))
}

/// Update cell in hybrid cache
#[command]
pub async fn update_cell_hybrid(
    dataset_id: String,
    row: usize,
    column: String,
    value: Value,
) -> Result<(), String> {
    HYBRID_CACHE.update_cell(&dataset_id, row, &column, value)
}

/// Flush dataset to Arrow from hybrid cache
#[command]
pub async fn flush_to_arrow_hybrid(dataset_id: String) -> Result<String, String> {
    HYBRID_CACHE.flush_to_arrow(&dataset_id)
}

/// Export selected columns to Arrow from hybrid cache
#[command]
pub async fn export_columns_to_arrow_hybrid(
    dataset_id: String,
    columns: Vec<String>,
) -> Result<String, String> {
    HYBRID_CACHE.export_columns_to_arrow(&dataset_id, &columns)
}

/// Remove dataset from hybrid cache
#[command]
pub async fn remove_dataset_hybrid(dataset_id: String) -> bool {
    HYBRID_CACHE.remove_dataset(&dataset_id)
}

/// Get row count from hybrid cache
#[command]
pub async fn get_row_count_hybrid(dataset_id: String) -> Result<usize, String> {
    HYBRID_CACHE
        .get_row_count(&dataset_id)
        .ok_or_else(|| format!("Dataset '{}' not found", dataset_id))
}

// ============================================================================
// ASYNC AGGREGATE FORMULA SUPPORT
// ============================================================================

/// Get column aggregate for large datasets (async formula support)
///
/// IMPORTANT: This command flushes overlay before computing.
/// Only use for unsorted/ungrouped large datasets.
///
/// # Arguments
/// * `dataset_id` - Dataset identifier
/// * `column_id` - Column ID (e.g., "col-0")
/// * `func` - Aggregate function: "SUM", "AVG", "COUNT", "COUNTA", "STDEV", "STDEV_P", "VAR", "VAR_P"
#[command]
pub async fn get_column_aggregate(
    dataset_id: String,
    column_id: String,
    func: String,
) -> Result<f64, String> {
    let result = HYBRID_CACHE.get_column_aggregate(&dataset_id, &column_id, &func);
    if let Err(error) = &result {
        log::error!(
            "cache aggregate failed: dataset_id='{}', column_id='{}', func='{}', error={}",
            dataset_id,
            column_id,
            func,
            error
        );
    }
    result
}

/// Compute aggregate over a row range using DuckDB SQL.
///
/// Row bounds are 0-based and inclusive (MODEL coordinates).
#[command]
pub async fn get_column_aggregate_range(
    dataset_id: String,
    column_id: String,
    func: String,
    start_row: usize,
    end_row: usize,
) -> Result<f64, String> {
    let result =
        HYBRID_CACHE.get_column_aggregate_range(&dataset_id, &column_id, &func, start_row, end_row);
    if let Err(error) = &result {
        log::error!(
            "cache aggregate range failed: dataset_id='{}', column_id='{}', func='{}', start_row={}, end_row={}, error={}",
            dataset_id,
            column_id,
            func,
            start_row,
            end_row,
            error
        );
    }
    result
}

/// Compute aggregate over an explicit list of model row indices.
#[command]
pub async fn get_column_aggregate_rows(
    dataset_id: String,
    column_id: String,
    func: String,
    row_indices: Vec<usize>,
) -> Result<f64, String> {
    let row_count = row_indices.len();
    let result =
        HYBRID_CACHE.get_column_aggregate_rows(&dataset_id, &column_id, &func, row_indices);
    if let Err(error) = &result {
        log::error!(
            "cache aggregate rows failed: dataset_id='{}', column_id='{}', func='{}', row_count={}, error={}",
            dataset_id,
            column_id,
            func,
            row_count,
            error
        );
    }
    result
}

/// Check if dataset has pending overlay edits (dataset-scoped)
/// Used by frontend to check overlay state before async aggregates
#[command]
pub async fn get_overlay_size(dataset_id: String) -> Result<usize, String> {
    Ok(HYBRID_CACHE.get_overlay_size_for_dataset(&dataset_id))
}

// ============================================================================
// COLUMN CLASSIFICATION STATS (DuckDB-based)
// ============================================================================

/// Get classification statistics for all columns in a dataset
///
/// Uses DuckDB (for large datasets) or in-memory computation (for small datasets)
/// to efficiently compute column stats needed for the column selection dialog.
///
/// Returns stats for each column:
/// - totalRows: Total row count
/// - nonNullCount: Count of non-NULL values
/// - distinctCount: Count of distinct values
/// - numericCount: Count of values that can be cast to DOUBLE
/// - minValue: Minimum numeric value (if any)
/// - maxValue: Maximum numeric value (if any)
#[command]
pub async fn get_all_column_stats(
    dataset_id: String,
) -> Result<Vec<ColumnClassificationStats>, String> {
    HYBRID_CACHE.get_all_column_stats(&dataset_id)
}

/// Get duplicate summary for a specific column.
///
/// Used by RNA-seq user-provided label mode to avoid loading full column values in the renderer.
#[command]
pub async fn get_column_duplicate_summary(
    dataset_id: String,
    column_id: String,
    max_examples: Option<usize>,
) -> Result<ColumnDuplicateSummary, String> {
    HYBRID_CACHE.get_column_duplicate_summary(&dataset_id, &column_id, max_examples.unwrap_or(5))
}

// ============================================================================
// PHASE 1: REGISTER EXISTING DUCKDB (Project Persistence Fix)
// ============================================================================

/// Column info for registering existing DuckDB
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterDuckdbColumn {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dtype: Option<String>,
}

/// Result from registering existing DuckDB
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDuckdbResult {
    pub id: String,
    pub row_count: usize,
    pub columns: Vec<RegisterDuckdbColumn>,
}

/// Register an existing DuckDB file without re-import
/// Used when loading projects with saved duckdbPath
///
/// # Arguments
/// * `dataset_id` - Unique identifier for the dataset
/// * `duckdb_path` - Path to existing DuckDB file
/// * `columns` - Optional column name overrides (for display names)
#[command]
pub async fn register_existing_duckdb(
    dataset_id: String,
    duckdb_path: String,
    columns: Option<Vec<RegisterDuckdbColumn>>,
) -> Result<RegisterDuckdbResult, String> {
    let duckdb_path_buf = PathBuf::from(&duckdb_path);
    if !is_path_allowed(&duckdb_path_buf) {
        return Err("Invalid DuckDB path".to_string());
    }

    if duckdb_path_buf
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("ecpdb"))
        != Some(true)
    {
        return Err("Invalid data file extension. Expected .ecpdb".to_string());
    }

    if !HYBRID_CACHE.is_allowed_duckdb_path(&duckdb_path_buf) {
        return Err("DuckDB path is outside allowed project/app data directories".to_string());
    }

    let columns_override =
        columns.map(|cols| cols.into_iter().map(|col| (col.id, col.name)).collect());

    HYBRID_CACHE.register_existing_duckdb(&dataset_id, &duckdb_path, columns_override)
}

/// Evaluate formula on backend using Formualizer engine - Phase 6
///
/// IMPORTANT: Works on large datasets even when sorted/grouped.
/// Uses view->model row mapping to ensure correctness.
///
/// # Arguments
/// * `dataset_id` - Dataset identifier
/// * `formula` - Formula string (WITH leading = - Formualizer expects it)
/// * `position` - Cell position in VIEW coords (0-indexed). This is the DISPLAY position,
///                used for relative references. Backend maps view->model via row_order_slice.
/// * `column_letter_to_id_map` - Map from A, B, C... to column IDs (col-0, col-1, etc.)
/// * `row_order_slice` - OPTIMIZED: Only referenced range slice (start, [model_indices]), null if unsorted
///
/// # Returns
/// JSON-serialized formula result (number, string, boolean, error)
///
/// # v1.2 Optimization
/// Instead of sending full 50M rowOrder array (400MB), frontend extracts only the
/// referenced range slice. For =SUM(A1:A100), sends (0, [model_row_0..model_row_99])
/// which is ~800 bytes instead of 400MB.
#[command]
pub async fn evaluate_formula_backend(
    dataset_id: String,
    formula: String,
    position: CellPosition, // Typed struct: { row: usize, col: usize } - VIEW coords
    column_letter_to_id_map: HashMap<String, String>,
    row_order_slice: Option<(usize, Vec<usize>)>, // v1.2: Only referenced range slice
    total_rows: Option<usize>,
) -> Result<Value, String> {
    let view_row = position.row;
    let view_col = position.col;
    let formula_len = formula.len();
    let has_row_order_slice = row_order_slice.is_some();
    let result = HYBRID_CACHE
        .evaluate_formula_backend(
            &dataset_id,
            &formula,
            position,
            column_letter_to_id_map,
            row_order_slice,
            total_rows,
        )
        .await;

    if let Err(error) = &result {
        log::error!(
            "formula backend evaluation failed: dataset_id='{}', view_row={}, view_col={}, formula_len={}, has_row_order_slice={}, total_rows={:?}, error={}",
            dataset_id,
            view_row,
            view_col,
            formula_len,
            has_row_order_slice,
            total_rows,
            error
        );
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_release_like_directory_validation_allows_absolute_dir_without_extension() {
        let base = std::env::current_dir().expect("cwd should resolve");
        let dir_path = base.join("target").join("easycris_project_data_dir");
        assert!(
            dir_path.is_absolute(),
            "expected absolute path, got {}",
            dir_path.display()
        );
        assert!(
            !has_disallowed_segments(&dir_path),
            "unexpected parent segment in {}",
            dir_path.display()
        );
        let candidate = normalize_candidate_path(&dir_path);
        assert!(
            candidate.is_some(),
            "candidate path could not be normalized for {}",
            dir_path.display()
        );
        let candidate = candidate.unwrap();
        assert!(
            !is_blocked_network_path(&candidate),
            "candidate considered network path: {}",
            candidate.display()
        );
        assert!(
            is_directory_path_allowed_no_debug(&dir_path),
            "directory path should be allowed: {}",
            dir_path.display()
        );
    }

    #[test]
    fn test_release_like_file_validation_requires_allowed_extension() {
        let allowed = std::env::temp_dir().join("fixture.ecpdb");
        let disallowed = std::env::temp_dir().join("fixture");

        assert!(is_file_path_allowed_no_debug(&allowed));
        assert!(!is_file_path_allowed_no_debug(&disallowed));
    }

    #[test]
    fn test_release_like_validation_rejects_parent_dir_segments() {
        let path_with_parent = std::env::temp_dir().join("a").join("..").join("b.ecpdb");
        let dir_with_parent = std::env::temp_dir()
            .join("a")
            .join("..")
            .join("project_data");

        assert!(!is_file_path_allowed_no_debug(&path_with_parent));
        assert!(!is_directory_path_allowed_no_debug(&dir_with_parent));
    }

    #[test]
    fn test_validate_project_id_accepts_safe_uuid_like_values() {
        let value = validate_project_id_input("project-123e4567-e89b-12d3-a456-426614174000")
            .expect("expected valid project id");
        assert_eq!(value, "project-123e4567-e89b-12d3-a456-426614174000");
    }

    #[test]
    fn test_validate_project_id_rejects_path_traversal_values() {
        assert!(validate_project_id_input("../evil").is_err());
        assert!(validate_project_id_input("proj/evil").is_err());
        assert!(validate_project_id_input("proj\\evil").is_err());
    }

    #[test]
    fn test_validate_project_id_accepts_legacy_spaces() {
        let value = validate_project_id_input("dataset_01 Project")
            .expect("expected legacy project id with spaces to be valid");
        assert_eq!(value, "dataset_01 Project");
    }

    #[tokio::test]
    async fn test_set_and_get_cache() {
        let dataset_id = "test_cache_cmd".to_string();

        let mut row = HashMap::new();
        row.insert("col1".to_string(), Value::from(42.0));

        let result = set_dataset_cache(dataset_id.clone(), vec![row]).await;
        assert!(result.is_ok());

        let col_data = get_column_data(dataset_id.clone(), "col1".to_string()).await;
        assert!(col_data.is_ok());
        assert_eq!(col_data.unwrap().len(), 1);

        // Cleanup
        remove_dataset_cache(dataset_id).await;
    }

    #[tokio::test]
    async fn test_update_cell_cmd() {
        let dataset_id = "test_update_cmd".to_string();

        let mut row = HashMap::new();
        row.insert("x".to_string(), Value::from(1.0));
        set_dataset_cache(dataset_id.clone(), vec![row])
            .await
            .unwrap();

        let result = update_cell(dataset_id.clone(), 0, "x".to_string(), Value::from(100.0)).await;
        assert!(result.is_ok());

        let col_data = get_column_data(dataset_id.clone(), "x".to_string())
            .await
            .unwrap();
        assert_eq!(col_data[0], Value::from(100.0));

        // Cleanup
        remove_dataset_cache(dataset_id).await;
    }
}
