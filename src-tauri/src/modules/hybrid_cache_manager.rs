// Hybrid Cache Manager - Phase 5 (DuckDB Large Dataset Support)
//
// Provides seamless storage for both small and large datasets:
// - < 1M rows: In-memory HashMap (current behavior, unchanged)
// - >= 1M rows: File-backed DuckDB with lazy queries
//
// All statistical tests work identically on both paths via Python DataProvider.
//
// Phase 5.1 Improvements:
// - Connection pooling to avoid 50ms overhead per operation
// - Fixed race conditions in overlay flush
// - Proper SQL identifier quoting throughout

use duckdb::{params, Connection};
use lazy_static::lazy_static;
use moka::sync::Cache;
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::modules::arrow_handler::ArrowHandler;

// ============================================================================
// CONSTANTS
// ============================================================================

/// Datasets with >= this many rows use DuckDB storage
pub const LARGE_DATASET_THRESHOLD: usize = 1_000_000;

/// Flush overlay to DuckDB when this many edits accumulate.
/// Keep this high so large paste batches return quickly instead of blocking on
/// synchronous flush during update_cells_batch.
const OVERLAY_FLUSH_THRESHOLD: usize = 50_000;

/// Time-based flush interval (5 minutes)
/// Phase 5: Auto-flush every 5 minutes if overlay has entries
const OVERLAY_FLUSH_INTERVAL_SECS: u64 = 300;

/// Database file extension (user-facing)
/// Uses .ecpdb (easyCris Project Database) instead of .duckdb to hide implementation
const DATA_FILE_EXT: &str = ".ecpdb";

/// Feature flag to disable DuckDB for rollback (set to false to use memory-only)
pub const USE_DUCKDB_FOR_LARGE: bool = true;

/// Missing value indicators (case-insensitive, trimmed)
const MISSING_VALUE_INDICATORS: [&str; 9] = [
    "na", "n/a", "missing", "null", ".", "-", "nan", "#n/a", "#na",
];
/// Formula placeholder sentinel (frontend-only, must never persist)
const CALC_PENDING_SENTINEL: &str = "__CALCULATING__";
const RESERVED_VIRTUAL_COLUMN_ID: &str = "__add_column__";
const CSV_HEADER_REPAIR_SAMPLE_ROWS: usize = 51;
const HIDDEN_COLUMNS_TABLE: &str = "__easycris_hidden_columns";
const ROW_ORDER_GAP: i64 = 1_000_000;
const ROW_ORDER_TABLE: &str = "main.row_order";

fn effective_build_profile() -> &'static str {
    option_env!("EASYCRIS_BUILD_PROFILE").unwrap_or(if cfg!(debug_assertions) {
        "dev"
    } else {
        "release"
    })
}

fn duckdb_cache_app_dir_name(profile: &str) -> &'static str {
    match profile.to_ascii_lowercase().as_str() {
        "dev" => "easyCris-dev",
        "e2e" => "easyCris-e2e",
        "release" => "easyCris",
        other => panic!("unknown EASYCRIS_BUILD_PROFILE value: {other}"),
    }
}

fn duckdb_cache_dir_for_profile(base_dir: PathBuf, profile: &str) -> PathBuf {
    base_dir
        .join(duckdb_cache_app_dir_name(profile))
        .join("duckdb_cache")
}

fn is_calc_pending(value: &Value) -> bool {
    matches!(value, Value::String(s) if s == CALC_PENDING_SENTINEL)
}

fn reserved_virtual_column_error(column_id: &str) -> String {
    format!("Reserved virtual column id '{}' is not writable", column_id)
}

fn validate_user_column_id(column_id: &str) -> Result<(), String> {
    if column_id == RESERVED_VIRTUAL_COLUMN_ID || column_id == "_row_index" {
        return Err(reserved_virtual_column_error(column_id));
    }
    Ok(())
}

fn is_nullish_overlay_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        _ => false,
    }
}

fn to_duckdb_sql_literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else if let Some(f) = n.as_f64() {
                if f.is_finite() {
                    f.to_string()
                } else {
                    "NULL".to_string()
                }
            } else {
                "NULL".to_string()
            }
        }
        Value::String(s) => {
            if s.trim().is_empty() {
                "NULL".to_string()
            } else {
                format!("'{}'", s.replace('\'', "''"))
            }
        }
        Value::Array(_) | Value::Object(_) => "NULL".to_string(),
    }
}

fn parse_col_index(key: &str) -> Option<usize> {
    key.strip_prefix("col-")?.parse::<usize>().ok()
}

fn collect_column_keys(rows: &[HashMap<String, Value>]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut keys: Vec<String> = Vec::new();
    for row in rows {
        for key in row.keys() {
            if seen.insert(key.clone()) {
                keys.push(key.clone());
            }
        }
    }

    keys.sort_by(|a, b| match (parse_col_index(a), parse_col_index(b)) {
        (Some(ai), Some(bi)) => ai.cmp(&bi),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.cmp(b),
    });

    keys
}

// ============================================================================
// PHASE 3: ROW-RANGE CACHE CONSTANTS (Scroll Performance)
// ============================================================================

/// Maximum number of cached row ranges (LRU eviction when exceeded)
const ROW_RANGE_CACHE_MAX_CAPACITY: u64 = 100;

/// Time-to-live for cached row ranges (5 minutes)
/// Balances memory usage with scroll-back performance
const ROW_RANGE_CACHE_TTL_SECS: u64 = 300;

/// Persistent disk cache index filename (stored under AppData duckdb_cache)
const DISK_CACHE_INDEX_FILE: &str = "cache_index.json";

/// Index schema version
const DISK_CACHE_INDEX_VERSION: u32 = 1;

/// Unsaved/AppData cache soft limit (evict down to this once hard limit is exceeded)
const APP_CACHE_SOFT_LIMIT_BYTES: u64 = 8 * 1024 * 1024 * 1024; // 8 GB

/// Unsaved/AppData cache hard limit (trigger eviction when exceeded)
const APP_CACHE_HARD_LIMIT_BYTES: u64 = 12 * 1024 * 1024 * 1024; // 12 GB

/// Age-based eviction window for unsaved/AppData cache (30 days)
const APP_CACHE_TTL_SECS: u64 = 30 * 24 * 60 * 60;

/// Retries for connection open races.
const CONNECTION_OPEN_RETRY_DELAYS_MS: [u64; 5] = [0, 50, 100, 200, 400];

/// Maximum wait for another thread opening the same dataset connection.
const CONNECTION_OPEN_SINGLE_FLIGHT_WAIT_TIMEOUT_SECS: u64 = 30;

/// Delay background prewarm slightly to avoid immediate post-import open races.
const PREWARM_COLUMN_STATS_DELAY_MS: u64 = 750;

/// Disable automatic prewarm for very large datasets; stats stay on-demand.
const PREWARM_SKIP_ROW_THRESHOLD: usize = LARGE_DATASET_THRESHOLD;

/// Disable prewarm for a dataset for this app session after repeated open failures.
const PREWARM_DISABLE_AFTER_OPEN_FAILURES: u32 = 3;

// ============================================================================
// TYPES
// ============================================================================

#[derive(Debug, Clone)]
pub struct ColumnInfo {
    pub name: String,         // Column ID used in DuckDB (e.g., "col-0", "col-1")
    pub display_name: String, // Original column name for UI display (e.g., "Dose", "Response")
    pub dtype: String,        // DuckDB type: INTEGER, DOUBLE, VARCHAR, BOOLEAN, etc.
}

struct BulkCellWrite<'a> {
    logical_row: i64,
    column_id: &'a str,
    value: &'a Value,
}

#[derive(Debug)]
struct BulkWriteSummary {
    edit_count: usize,
    added_columns: Vec<ColumnInfo>,
    max_logical_row: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteBlockPayload {
    pub rows: Vec<i64>,
    pub column_ids: Vec<String>,
    pub values: Vec<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteBlockResult {
    /// Empty no-op range is reported as 0..0 with edited_cells = 0.
    /// Callers must gate hydration/reload work on edited_cells > 0.
    pub row_start: i64,
    pub row_end_exclusive: i64,
    pub edited_cells: usize,
    pub old_values: Vec<Vec<Value>>,
}

/// Column classification statistics from DuckDB
#[derive(Debug, Clone, serde::Serialize)]
pub struct ColumnClassificationStats {
    /// Column ID (e.g., "col-0")
    #[serde(rename = "columnId")]
    pub column_id: String,
    /// Total row count
    #[serde(rename = "totalRows")]
    pub total_rows: usize,
    /// Count of non-NULL values
    #[serde(rename = "nonNullCount")]
    pub non_null_count: usize,
    /// Count of distinct values
    #[serde(rename = "distinctCount")]
    pub distinct_count: usize,
    /// Count of distinct values using case-folded normalization (trim + lowercase)
    #[serde(rename = "distinctCountCaseFolded")]
    pub distinct_count_case_folded: usize,
    /// Sample of distinct values (trimmed, missing filtered)
    #[serde(rename = "distinctValues")]
    pub distinct_values: Vec<String>,
    /// Count of values that are numeric (can be cast to DOUBLE)
    #[serde(rename = "numericCount")]
    pub numeric_count: usize,
    /// Count of numeric values that are integer-valued
    #[serde(rename = "integerCount")]
    pub integer_count: usize,
    /// First row index (0-based) containing a non-missing value for this column
    #[serde(rename = "firstNonMissingRow")]
    pub first_non_missing_row: Option<usize>,
    /// Last row index (0-based) containing a non-missing value for this column
    #[serde(rename = "lastNonMissingRow")]
    pub last_non_missing_row: Option<usize>,
    /// Minimum numeric value (if any)
    #[serde(rename = "minValue")]
    pub min_value: Option<f64>,
    /// Maximum numeric value (if any)
    #[serde(rename = "maxValue")]
    pub max_value: Option<f64>,
}

fn normalize_csv_header_token(token: &str) -> String {
    token.trim_matches('\u{feff}').trim().to_string()
}

fn infer_csv_data_width(widths: &[usize]) -> Option<usize> {
    if widths.is_empty() {
        return None;
    }

    let mut frequency: HashMap<usize, usize> = HashMap::new();
    for width in widths.iter().copied().filter(|width| *width > 0) {
        *frequency.entry(width).or_insert(0) += 1;
    }

    frequency
        .into_iter()
        .max_by(|(width_a, count_a), (width_b, count_b)| {
            count_a.cmp(count_b).then_with(|| width_a.cmp(width_b))
        })
        .map(|(width, _)| width)
}

fn build_repaired_csv_header(
    header_record: &csv::StringRecord,
    expected_data_cols: usize,
) -> Option<(Vec<String>, String)> {
    let header_cols = header_record.len();
    if expected_data_cols == 0 || header_cols == expected_data_cols {
        return None;
    }

    let mut repaired: Vec<String> = header_record
        .iter()
        .enumerate()
        .map(|(idx, value)| {
            let normalized = normalize_csv_header_token(value);
            if normalized.is_empty() {
                format!("Column {}", idx + 1)
            } else {
                normalized
            }
        })
        .collect();

    let first_header_raw = header_record.get(0).unwrap_or_default();
    let first_without_bom = first_header_raw.trim_start_matches('\u{feff}');
    let first_starts_with_tab = first_without_bom.starts_with('\t');
    let first_token_empty = first_without_bom.is_empty();

    if header_cols + 1 == expected_data_cols && (first_starts_with_tab || first_token_empty) {
        repaired.insert(0, "gene_id".to_string());
        return Some((
            repaired,
            "added missing first header column 'gene_id'".to_string(),
        ));
    }

    if header_cols < expected_data_cols {
        for idx in header_cols..expected_data_cols {
            repaired.push(format!("Column {}", idx + 1));
        }
        return Some((repaired, "padded missing header column names".to_string()));
    }

    repaired.truncate(expected_data_cols);
    Some((repaired, "truncated extra header column names".to_string()))
}

#[derive(Debug, Clone)]
struct PreparedCsvImportSource {
    source_path: PathBuf,
    cleanup_path: Option<PathBuf>,
    warning: Option<String>,
}

#[derive(Debug)]
struct TempCsvGuard {
    cleanup_path: Option<PathBuf>,
}

impl TempCsvGuard {
    fn new(cleanup_path: Option<PathBuf>) -> Self {
        Self { cleanup_path }
    }
}

impl Drop for TempCsvGuard {
    fn drop(&mut self) {
        if let Some(path) = self.cleanup_path.take() {
            if let Err(error) = std::fs::remove_file(&path) {
                log::warn!(
                    "Failed to remove temporary CSV repair file '{}': {}",
                    path.display(),
                    error
                );
            }
        }
    }
}

/// Duplicate summary for a single column (trimmed, empty values ignored)
#[derive(Debug, Clone, serde::Serialize)]
pub struct ColumnDuplicateSummary {
    #[serde(rename = "duplicateIdCount")]
    pub duplicate_id_count: usize,
    #[serde(rename = "duplicateRowCount")]
    pub duplicate_row_count: usize,
    #[serde(rename = "duplicateExamples")]
    pub duplicate_examples: Vec<String>,
    #[serde(rename = "nonEmptyCount")]
    pub non_empty_count: usize,
}

#[derive(Debug, Clone)]
struct CachedColumnStats {
    stats: Vec<ColumnClassificationStats>,
    computed_at: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnSearchMatch {
    #[serde(rename = "modelRow")]
    pub model_row: usize,
    #[serde(rename = "columnId")]
    pub column_id: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnAggregationRequest {
    #[serde(rename = "columnId")]
    pub column_id: Option<String>,
    pub func: String,
    pub alias: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GroupMeta {
    #[serde(rename = "startViewRow")]
    pub start_view_row: usize,
    pub key: String,
    pub size: usize,
    pub collapsed: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GroupedRowOrder {
    #[serde(rename = "rowOrder")]
    pub row_order: Vec<i64>,
    #[serde(rename = "groupMeta")]
    pub group_meta: Vec<GroupMeta>,
}

/// Lazy group metadata for large datasets (no row indices - computed on demand)
/// Phase 3: Scroll performance - O(groups) not O(rows)
#[derive(Debug, Clone, serde::Serialize)]
pub struct LazyGroupMeta {
    /// Group key (display value)
    pub key: String,
    /// Number of rows in this group
    pub size: usize,
    /// First model row index in this group (for header display)
    #[serde(rename = "firstRowIndex")]
    pub first_row_index: i64,
}

/// Result of lazy group metadata query
#[derive(Debug, Clone, serde::Serialize)]
pub struct LazyGroupedResult {
    /// Group metadata in display order
    pub groups: Vec<LazyGroupMeta>,
    /// Total row count across all groups
    #[serde(rename = "totalRows")]
    pub total_rows: usize,
}

/// Internal storage variant - not exposed to callers
enum DatasetStorage {
    /// Small datasets: exact current behavior
    InMemory { rows: Vec<HashMap<String, Value>> },

    /// Large datasets: file-backed DuckDB with metadata
    DuckDB {
        db_path: PathBuf,         // File path for this dataset's DuckDB
        _table_name: String,      // Always "data" within the DB
        columns: Vec<ColumnInfo>, // Column metadata
        row_count: usize,         // Cached row count
    },
}

/// RAII bundling state guard: guarantees end_bundling() on scope exit.
struct BundlingGuard<'a> {
    manager: &'a HybridCacheManager,
    dataset_key: String,
}

impl<'a> BundlingGuard<'a> {
    fn new(manager: &'a HybridCacheManager, dataset_key: String) -> Self {
        manager.begin_bundling(&dataset_key);
        Self {
            manager,
            dataset_key,
        }
    }
}

impl Drop for BundlingGuard<'_> {
    fn drop(&mut self) {
        self.manager.end_bundling(&self.dataset_key);
    }
}

/// Key for overlay edits: (dataset_id, row_index, column_name)
/// row_index is 0-based to match grid
type OverlayKey = (String, i64, String);

/// Key for row-range cache: (dataset_id, start_row, end_row)
/// Phase 3: Scroll performance optimization
type RowRangeCacheKey = (String, usize, usize);

/// Value for row-range cache: vector of row data
type RowRangeCacheValue = Vec<HashMap<String, Value>>;

struct ConnectionOpenGuard<'a> {
    manager: &'a HybridCacheManager,
    key: String,
}

impl<'a> ConnectionOpenGuard<'a> {
    fn new(manager: &'a HybridCacheManager, key: String) -> Self {
        Self { manager, key }
    }
}

impl Drop for ConnectionOpenGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut opening) = self.manager.opening_connections.lock() {
            opening.remove(&self.key);
            self.manager.opening_connections_cv.notify_all();
        }
    }
}

struct PrewarmGuard<'a> {
    manager: &'a HybridCacheManager,
    key: String,
}

impl<'a> PrewarmGuard<'a> {
    fn new(manager: &'a HybridCacheManager, key: String) -> Self {
        Self { manager, key }
    }
}

impl Drop for PrewarmGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut inflight) = self.manager.prewarm_inflight.lock() {
            inflight.remove(&self.key);
        }
    }
}

// ============================================================================
// HYBRID CACHE MANAGER
// ============================================================================

pub struct HybridCacheManager {
    /// Dataset storage registry
    /// Key: namespaced as "projectId:datasetId" for isolation
    datasets: RwLock<HashMap<String, DatasetStorage>>,

    /// Write-back overlay for pending edits (DuckDB datasets only)
    /// Edits stored here first, merged on read, batch flushed periodically
    /// Key: (namespaced_dataset_id, row_index, column_name)
    overlay: RwLock<HashMap<OverlayKey, Value>>,

    /// Connection pool for DuckDB datasets - avoids 50ms overhead per operation
    /// Key: namespaced_dataset_id, Value: pooled connection wrapped in Arc<Mutex>
    connections: RwLock<HashMap<String, Arc<Mutex<Connection>>>>,

    /// Dataset IDs currently being bundled (prevents new connections during copy)
    /// Uses namespaced IDs
    bundling_datasets: RwLock<HashSet<String>>,

    /// Dataset IDs currently opening a DuckDB pooled connection.
    /// Prevents concurrent `Connection::open` races for the same dataset.
    opening_connections: Mutex<HashSet<String>>,
    opening_connections_cv: Condvar,

    /// Dataset IDs currently running async prewarm.
    /// Dedupes fire-and-forget prewarm thread fan-out.
    prewarm_inflight: Mutex<HashSet<String>>,

    /// Consecutive connection-open failures per dataset key.
    connection_open_failures: Mutex<HashMap<String, u32>>,

    /// Session-level circuit breaker for background prewarm.
    prewarm_disabled_datasets: Mutex<HashSet<String>>,

    /// App data directory for DuckDB files (fallback for unsaved projects)
    data_dir: PathBuf,

    /// Project-specific data directories (maps projectId -> data folder path)
    /// When set, overrides data_dir for that project (uses user's chosen save location)
    project_data_dirs: RwLock<HashMap<String, PathBuf>>,

    /// Phase 3: Row-range cache for scroll performance
    /// Caches DuckDB query results to avoid repeated queries when scrolling back
    /// Key: (namespaced_dataset_id, start_row, end_row), Value: row data
    /// Invalidated on: flush_overlay (edits committed to DuckDB)
    row_range_cache: Cache<RowRangeCacheKey, RowRangeCacheValue>,

    /// Cached column classification stats (DuckDB-heavy, reused by column selection)
    /// Key: namespaced_dataset_id
    /// Invalidated on: overlay edits, dataset replacement, schema changes
    column_stats_cache: RwLock<HashMap<String, CachedColumnStats>>,

    /// Persistent index for disk cache files under AppData duckdb_cache.
    /// Key: normalized absolute file path.
    disk_cache_index: RwLock<HashMap<String, DiskCacheIndexEntry>>,

    /// Incremented whenever destructive cache cleanup runs.
    /// Long-running imports/register operations snapshot this value and abort
    /// registration if a cleanup happened mid-flight.
    purge_generation: AtomicU64,

    /// Phase B: Active project ID for dataset namespacing
    /// All operations without explicit projectId use this for key generation
    /// MUST be set before any dataset operations; errors if None
    active_project_id: RwLock<Option<String>>,

    #[cfg(test)]
    flush_overlay_after_snapshot: RwLock<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl HybridCacheManager {
    pub fn new() -> Self {
        // Use app data directory for DuckDB files
        let data_dir = duckdb_cache_dir_for_profile(
            dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")),
            effective_build_profile(),
        );

        // Create directory if it doesn't exist
        let _ = std::fs::create_dir_all(&data_dir);

        // Phase 3: Initialize row-range cache for scroll performance
        let row_range_cache = Cache::builder()
            .max_capacity(ROW_RANGE_CACHE_MAX_CAPACITY)
            .time_to_live(Duration::from_secs(ROW_RANGE_CACHE_TTL_SECS))
            .build();

        let manager = Self {
            datasets: RwLock::new(HashMap::new()),
            overlay: RwLock::new(HashMap::new()),
            connections: RwLock::new(HashMap::new()),
            bundling_datasets: RwLock::new(HashSet::new()),
            opening_connections: Mutex::new(HashSet::new()),
            opening_connections_cv: Condvar::new(),
            prewarm_inflight: Mutex::new(HashSet::new()),
            connection_open_failures: Mutex::new(HashMap::new()),
            prewarm_disabled_datasets: Mutex::new(HashSet::new()),
            data_dir,
            project_data_dirs: RwLock::new(HashMap::new()),
            row_range_cache,
            column_stats_cache: RwLock::new(HashMap::new()),
            disk_cache_index: RwLock::new(HashMap::new()),
            purge_generation: AtomicU64::new(0),
            active_project_id: RwLock::new(None),
            #[cfg(test)]
            flush_overlay_after_snapshot: RwLock::new(None),
        };

        manager.load_disk_cache_index();

        manager
    }

    fn now_unix_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    fn disk_cache_index_path(&self) -> PathBuf {
        self.data_dir.join(DISK_CACHE_INDEX_FILE)
    }

    fn normalize_index_path(path: &Path) -> String {
        match path.canonicalize() {
            Ok(canon) => canon.to_string_lossy().to_string(),
            Err(_) => path.to_string_lossy().to_string(),
        }
    }

    fn normalize_same_file_key(path: &Path) -> String {
        let raw = fs::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string();

        #[cfg(windows)]
        {
            let stripped = if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
                format!(r"\\{}", rest)
            } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
                rest.to_string()
            } else {
                raw
            };
            stripped.replace('/', "\\").to_ascii_lowercase()
        }

        #[cfg(not(windows))]
        {
            raw
        }
    }

    fn ensure_row_order_table(conn: &Connection) -> Result<(), String> {
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM information_schema.tables \
                 WHERE table_schema = 'main' AND table_name = 'row_order' AND table_type = 'BASE TABLE'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if exists {
            return Ok(());
        }

        conn.execute("DROP TABLE IF EXISTS temp.row_order", [])
            .map_err(|e| format!("Failed to clear temporary row_order shadow: {}", e))?;
        conn.execute_batch(&format!(
            "CREATE TABLE {row_order} AS \
             SELECT _row_index AS physical_row, (_row_index * {gap})::BIGINT AS sort_key \
             FROM data ORDER BY _row_index; \
             CREATE UNIQUE INDEX idx_row_order_sort_key ON {row_order}(sort_key); \
             CREATE UNIQUE INDEX idx_row_order_physical_row ON {row_order}(physical_row);",
            row_order = ROW_ORDER_TABLE,
            gap = ROW_ORDER_GAP
        ))
        .map_err(|e| format!("Failed to initialize logical row order: {}", e))
    }

    fn row_order_count(conn: &Connection) -> Result<usize, String> {
        Self::ensure_row_order_table(conn)?;
        let count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {}", ROW_ORDER_TABLE),
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to count logical row order: {}", e))?;
        Ok(count.max(0) as usize)
    }

    fn format_i64_list(values: &[i64]) -> String {
        values
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn next_physical_row(conn: &Connection) -> Result<i64, String> {
        let next: Option<i64> = conn
            .query_row("SELECT MAX(_row_index) + 1 FROM data", [], |row| row.get(0))
            .map_err(|e| format!("Failed to read next physical row: {}", e))?;
        Ok(next.unwrap_or(0))
    }

    fn sort_key_bounds(
        conn: &Connection,
        logical_index: usize,
    ) -> Result<(Option<i64>, Option<i64>), String> {
        Self::ensure_row_order_table(conn)?;
        let (offset, limit) = if logical_index == 0 {
            (0_i64, 1_i64)
        } else {
            ((logical_index - 1) as i64, 2_i64)
        };
        let mut stmt = conn
            .prepare(&format!(
                "SELECT sort_key FROM {} ORDER BY sort_key LIMIT ? OFFSET ?",
                ROW_ORDER_TABLE
            ))
            .map_err(|e| format!("Failed to prepare logical row bounds: {}", e))?;
        let rows = stmt
            .query_map(params![limit, offset], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("Failed to query logical row bounds: {}", e))?;
        let mut keys = Vec::new();
        for row in rows {
            keys.push(row.map_err(|e| format!("Failed to decode logical row bounds: {}", e))?);
        }
        if logical_index > 0 && keys.is_empty() {
            return Err(format!(
                "Cannot allocate logical row order keys at index {} for an empty row_order",
                logical_index
            ));
        }
        if logical_index == 0 {
            Ok((None, keys.first().copied()))
        } else {
            Ok((keys.first().copied(), keys.get(1).copied()))
        }
    }

    fn rebalance_row_order(conn: &Connection) -> Result<(), String> {
        Self::ensure_row_order_table(conn)?;
        let temp_name = format!(
            "temp._easycris_row_order_rebalanced_{}",
            Uuid::new_v4().simple()
        );
        conn.execute_batch(&format!(
            "CREATE TEMP TABLE {temp_name} AS \
             SELECT physical_row, ((row_number() OVER (ORDER BY sort_key) - 1) * {gap})::BIGINT AS sort_key \
             FROM {row_order}; \
             DELETE FROM {row_order}; \
             INSERT INTO {row_order} (physical_row, sort_key) \
             SELECT physical_row, sort_key FROM {temp_name}; \
             DROP TABLE {temp_name};",
            temp_name = temp_name,
            row_order = ROW_ORDER_TABLE,
            gap = ROW_ORDER_GAP
        ))
        .map_err(|e| format!("Failed to rebalance logical row order: {}", e))
    }

    fn allocate_sort_keys(
        conn: &Connection,
        logical_index: usize,
        count: usize,
    ) -> Result<Vec<i64>, String> {
        if count == 0 {
            return Ok(Vec::new());
        }

        for attempt in 0..2 {
            let (previous_key, next_key) = Self::sort_key_bounds(conn, logical_index)?;
            let count_i64 =
                i64::try_from(count).map_err(|_| format!("Row count {} is too large", count))?;

            let lower = match (previous_key, next_key) {
                (Some(prev), _) => prev,
                (None, Some(next)) => next
                    .checked_sub(
                        ROW_ORDER_GAP
                            .checked_mul(count_i64 + 1)
                            .ok_or_else(|| "Logical row order gap overflow".to_string())?,
                    )
                    .ok_or_else(|| "Logical row order lower-bound overflow".to_string())?,
                (None, None) => -ROW_ORDER_GAP,
            };
            let upper = match next_key {
                Some(next) => next,
                None => lower
                    .checked_add(
                        ROW_ORDER_GAP
                            .checked_mul(count_i64 + 1)
                            .ok_or_else(|| "Logical row order gap overflow".to_string())?,
                    )
                    .ok_or_else(|| "Logical row order upper-bound overflow".to_string())?,
            };
            let gap = upper
                .checked_sub(lower)
                .ok_or_else(|| "Logical row order gap underflow".to_string())?;
            if gap > count_i64 {
                let step = gap / (count_i64 + 1);
                if step > 0 {
                    return (1..=count_i64)
                        .map(|offset| {
                            lower
                                .checked_add(step * offset)
                                .ok_or_else(|| "Logical row order key overflow".to_string())
                        })
                        .collect();
                }
            }

            if attempt == 0 {
                Self::rebalance_row_order(conn)?;
            }
        }

        Err("Unable to allocate logical row order keys".to_string())
    }

    fn append_physical_rows_with_order(
        conn: &Connection,
        count: usize,
    ) -> Result<(i64, usize), String> {
        Self::ensure_row_order_table(conn)?;
        if count == 0 {
            return Ok((Self::next_physical_row(conn)?, Self::row_order_count(conn)?));
        }

        let start_physical = Self::next_physical_row(conn)?;
        let count_i64 =
            i64::try_from(count).map_err(|_| format!("Row count {} is too large", count))?;
        let end_physical = start_physical
            .checked_add(count_i64)
            .ok_or_else(|| "Physical row index overflow while appending rows".to_string())?;
        let max_sort_key: Option<i64> = conn
            .query_row(
                &format!("SELECT MAX(sort_key) FROM {}", ROW_ORDER_TABLE),
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to read logical row order tail: {}", e))?;
        let base_sort_key = max_sort_key.unwrap_or(-ROW_ORDER_GAP);

        conn.execute(
            "INSERT INTO data (_row_index) SELECT i FROM range(?, ?) AS t(i)",
            params![start_physical, end_physical],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            &format!(
                "INSERT INTO {row_order} (physical_row, sort_key) \
                 SELECT ? + i, ? + ((i + 1) * {gap}) FROM range(0, ?) AS t(i)",
                row_order = ROW_ORDER_TABLE,
                gap = ROW_ORDER_GAP
            ),
            params![start_physical, base_sort_key, count_i64],
        )
        .map_err(|e| e.to_string())?;

        Ok((start_physical, Self::row_order_count(conn)?))
    }

    fn insert_physical_rows_with_order(
        conn: &Connection,
        logical_index: usize,
        count: usize,
    ) -> Result<usize, String> {
        Self::ensure_row_order_table(conn)?;
        if count == 0 {
            return Self::row_order_count(conn);
        }

        let start_physical = Self::next_physical_row(conn)?;
        let count_i64 =
            i64::try_from(count).map_err(|_| format!("Row count {} is too large", count))?;
        let end_physical = start_physical
            .checked_add(count_i64)
            .ok_or_else(|| "Physical row index overflow while inserting rows".to_string())?;
        let sort_keys = Self::allocate_sort_keys(conn, logical_index, count)?;

        conn.execute(
            "INSERT INTO data (_row_index) SELECT i FROM range(?, ?) AS t(i)",
            params![start_physical, end_physical],
        )
        .map_err(|e| e.to_string())?;

        let values_sql = sort_keys
            .iter()
            .enumerate()
            .map(|(offset, sort_key)| {
                let physical = start_physical + offset as i64;
                format!("({}, {})", physical, sort_key)
            })
            .collect::<Vec<_>>()
            .join(", ");
        conn.execute(
            &format!(
                "INSERT INTO {} (physical_row, sort_key) VALUES {}",
                ROW_ORDER_TABLE, values_sql
            ),
            [],
        )
        .map_err(|e| e.to_string())?;

        Self::row_order_count(conn)
    }

    fn logical_span_to_physical(
        conn: &Connection,
        start: i64,
        end: i64,
    ) -> Result<HashMap<i64, i64>, String> {
        let len = end
            .checked_sub(start)
            .and_then(|span| span.checked_add(1))
            .ok_or_else(|| "Logical row span overflow".to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT physical_row FROM {} ORDER BY sort_key LIMIT ? OFFSET ?",
                ROW_ORDER_TABLE
            ))
            .map_err(|e| format!("Failed to prepare logical row mapping: {}", e))?;
        let rows = stmt
            .query_map(params![len, start], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("Failed to query logical row mapping: {}", e))?;
        let mut result = HashMap::new();
        for (offset, row) in rows.enumerate() {
            let physical =
                row.map_err(|e| format!("Failed to decode logical row mapping: {}", e))?;
            result.insert(start + offset as i64, physical);
        }
        Ok(result)
    }

    fn logical_rows_to_physical(
        conn: &Connection,
        logical_rows: &[i64],
    ) -> Result<HashMap<i64, i64>, String> {
        Self::ensure_row_order_table(conn)?;
        if logical_rows.is_empty() {
            return Ok(HashMap::new());
        }

        let mut sorted_rows: Vec<i64> = logical_rows
            .iter()
            .copied()
            .filter(|row| *row >= 0)
            .collect();
        sorted_rows.sort_unstable();
        sorted_rows.dedup();

        let mut result = HashMap::new();
        let mut span_start: Option<i64> = None;
        let mut previous_row: Option<i64> = None;

        for logical_row in sorted_rows {
            match (span_start, previous_row) {
                (None, _) => {
                    span_start = Some(logical_row);
                    previous_row = Some(logical_row);
                }
                (Some(_), Some(previous)) if logical_row == previous + 1 => {
                    previous_row = Some(logical_row);
                }
                (Some(start), Some(previous)) => {
                    result.extend(Self::logical_span_to_physical(conn, start, previous)?);
                    span_start = Some(logical_row);
                    previous_row = Some(logical_row);
                }
                _ => unreachable!("logical row span state must be initialized together"),
            }
        }

        if let (Some(start), Some(previous)) = (span_start, previous_row) {
            result.extend(Self::logical_span_to_physical(conn, start, previous)?);
        }
        Ok(result)
    }

    fn ensure_logical_rows_exist(conn: &Connection, logical_rows: &[i64]) -> Result<(), String> {
        let max_row = logical_rows.iter().copied().filter(|row| *row >= 0).max();
        let Some(max_row) = max_row else {
            return Ok(());
        };
        let current_count = Self::row_order_count(conn)?;
        let required_count = (max_row as usize) + 1;
        if required_count > current_count {
            Self::append_physical_rows_with_order(conn, required_count - current_count)?;
        }
        Ok(())
    }

    fn paths_refer_to_same_file(left: &Path, right: &Path) -> bool {
        Self::normalize_same_file_key(left) == Self::normalize_same_file_key(right)
    }

    fn split_namespaced_key(namespaced_key: &str) -> (Option<String>, Option<String>) {
        if let Some((project_id, dataset_id)) = namespaced_key.split_once(':') {
            (Some(project_id.to_string()), Some(dataset_id.to_string()))
        } else {
            (None, Some(namespaced_key.to_string()))
        }
    }

    fn is_safe_project_id(project_id: &str) -> bool {
        let trimmed = project_id.trim();
        !trimmed.is_empty()
            && trimmed.len() <= 128
            && !trimmed.contains("..")
            && !trimmed.chars().any(|ch| {
                ch.is_control()
                    || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            })
    }

    fn is_path_in_app_cache(&self, path: &Path) -> bool {
        path.starts_with(&self.data_dir)
    }

    fn current_purge_generation(&self) -> u64 {
        self.purge_generation.load(AtomicOrdering::SeqCst)
    }

    fn bump_purge_generation(&self) -> u64 {
        self.purge_generation.fetch_add(1, AtomicOrdering::SeqCst) + 1
    }

    fn ensure_guard_current(&self, guard: u64, context: &str) -> Result<(), String> {
        let current = self.current_purge_generation();
        if current != guard {
            return Err(format!(
                "Aborted stale cache operation '{}' (guard={}, current={})",
                context, guard, current
            ));
        }
        Ok(())
    }

    fn ensure_guard_or_cleanup(
        &self,
        guard: u64,
        context: &str,
        db_path: &Path,
    ) -> Result<(), String> {
        match self.ensure_guard_current(guard, context) {
            Ok(()) => Ok(()),
            Err(error) => {
                if let Err(remove_error) = fs::remove_file(db_path) {
                    log::warn!(
                        "Cache: failed to remove stale db file '{}' after guard abort: {}",
                        db_path.display(),
                        remove_error
                    );
                }
                Err(error)
            }
        }
    }

    fn load_disk_cache_index(&self) {
        let index_path = self.disk_cache_index_path();
        let content = match fs::read_to_string(&index_path) {
            Ok(content) => content,
            Err(_) => return,
        };
        let parsed = match serde_json::from_str::<DiskCacheIndexSnapshot>(&content) {
            Ok(parsed) => parsed,
            Err(error) => {
                log::warn!(
                    "Cache: Failed to parse disk cache index '{}': {}",
                    index_path.display(),
                    error
                );
                return;
            }
        };

        if parsed.version != DISK_CACHE_INDEX_VERSION {
            log::warn!(
                "Cache: Disk cache index version mismatch (found {}, expected {})",
                parsed.version,
                DISK_CACHE_INDEX_VERSION
            );
        }

        let mut index = self.disk_cache_index.write().unwrap();
        index.clear();
        for entry in parsed.entries {
            index.insert(entry.path.clone(), entry);
        }
    }

    fn persist_disk_cache_index(&self) {
        let index_path = self.disk_cache_index_path();
        let tmp_path = index_path.with_extension("json.tmp");
        let snapshot = {
            let index = self.disk_cache_index.read().unwrap();
            DiskCacheIndexSnapshot {
                version: DISK_CACHE_INDEX_VERSION,
                entries: index.values().cloned().collect(),
            }
        };

        match serde_json::to_string_pretty(&snapshot) {
            Ok(serialized) => {
                if let Err(error) = fs::write(&tmp_path, serialized) {
                    log::warn!(
                        "Cache: Failed to write disk cache index temp '{}': {}",
                        tmp_path.display(),
                        error
                    );
                    return;
                }
                if let Err(error) = fs::rename(&tmp_path, &index_path) {
                    #[cfg(windows)]
                    {
                        // Windows can't rename over an existing destination path.
                        // Fall back to remove+rename to avoid sticky stale index updates.
                        if index_path.exists() {
                            if let Err(remove_error) = fs::remove_file(&index_path) {
                                log::warn!(
                                    "Cache: Failed to replace disk cache index '{}' (remove existing failed): {}",
                                    index_path.display(),
                                    remove_error
                                );
                                let _ = fs::remove_file(&tmp_path);
                                return;
                            }
                            if let Err(retry_error) = fs::rename(&tmp_path, &index_path) {
                                log::warn!(
                                    "Cache: Failed to replace disk cache index '{}' after remove fallback: {}",
                                    index_path.display(),
                                    retry_error
                                );
                                let _ = fs::remove_file(&tmp_path);
                                return;
                            }
                            return;
                        }
                    }
                    log::warn!(
                        "Cache: Failed to replace disk cache index '{}': {}",
                        index_path.display(),
                        error
                    );
                    let _ = fs::remove_file(&tmp_path);
                }
            }
            Err(error) => {
                log::warn!("Cache: Failed to serialize disk cache index: {}", error);
            }
        }
    }

    fn collect_disk_cache_files_recursive_inner(
        base: &Path,
        out: &mut Vec<DiskCacheFileMeta>,
        visited_dirs: &mut HashSet<String>,
    ) {
        let canonical_dir = fs::canonicalize(base).unwrap_or_else(|_| base.to_path_buf());
        let dir_key = Self::normalize_index_path(&canonical_dir);
        if !visited_dirs.insert(dir_key) {
            return;
        }

        let read_dir = match fs::read_dir(base) {
            Ok(read_dir) => read_dir,
            Err(_) => return,
        };

        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.is_dir() {
                Self::collect_disk_cache_files_recursive_inner(&path, out, visited_dirs);
                continue;
            }

            let is_data_file = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("ecpdb"))
                == Some(true);
            if !is_data_file {
                continue;
            }

            if let Ok(metadata) = entry.metadata() {
                let modified_unix_secs = metadata
                    .modified()
                    .ok()
                    .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                out.push(DiskCacheFileMeta {
                    path,
                    size_bytes: metadata.len(),
                    modified_unix_secs,
                });
            }
        }
    }

    fn collect_disk_cache_files_recursive(base: &Path, out: &mut Vec<DiskCacheFileMeta>) {
        let mut visited_dirs = HashSet::new();
        Self::collect_disk_cache_files_recursive_inner(base, out, &mut visited_dirs);
    }

    fn read_disk_cache_files(&self) -> Vec<DiskCacheFileMeta> {
        let mut files = Vec::new();
        Self::collect_disk_cache_files_recursive(&self.data_dir, &mut files);
        files
    }

    fn get_storage_scan_roots(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = vec![self.data_dir.clone()];
        let project_dirs = self.project_data_dirs.read().unwrap();
        roots.extend(project_dirs.values().cloned());

        let mut seen = HashSet::new();
        roots
            .into_iter()
            .filter(|root| root.exists())
            .filter(|root| seen.insert(Self::normalize_index_path(root)))
            .collect()
    }

    fn read_disk_cache_files_for_roots(&self, roots: &[PathBuf]) -> Vec<DiskCacheFileMeta> {
        let mut files = Vec::new();
        let mut seen_paths = HashSet::new();

        for root in roots {
            let mut root_files = Vec::new();
            Self::collect_disk_cache_files_recursive(root, &mut root_files);
            for file in root_files {
                let key = Self::normalize_index_path(&file.path);
                if seen_paths.insert(key) {
                    files.push(file);
                }
            }
        }

        files
    }

    #[cfg(windows)]
    fn storage_volume_key(path: &Path) -> String {
        let normalized = Self::normalize_index_path(path);
        let stripped = if let Some(rest) = normalized.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{}", rest)
        } else if let Some(rest) = normalized.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            normalized
        };

        let bytes = stripped.as_bytes();
        if stripped.len() >= 2 && bytes[1] == b':' {
            return stripped[..2].to_ascii_uppercase();
        }
        if stripped.starts_with("\\\\") {
            let mut parts = stripped.trim_start_matches('\\').split('\\');
            if let (Some(server), Some(share)) = (parts.next(), parts.next()) {
                return format!("\\\\{}\\{}", server, share).to_lowercase();
            }
        }
        stripped.to_lowercase()
    }

    #[cfg(not(windows))]
    fn storage_volume_key(path: &Path) -> String {
        fs::canonicalize(path)
            .ok()
            .map(|canonical| Self::normalize_index_path(&canonical))
            .unwrap_or_else(|| Self::normalize_index_path(path))
    }

    fn min_available_space_for_roots(roots: &[PathBuf]) -> Option<u64> {
        let mut representative_roots: HashMap<String, PathBuf> = HashMap::new();
        for root in roots {
            let key = Self::storage_volume_key(root);
            representative_roots
                .entry(key)
                .or_insert_with(|| root.clone());
        }

        let mut min_space: Option<u64> = None;
        for root in representative_roots.values() {
            if let Ok(space) = fs2::available_space(root) {
                min_space = Some(match min_space {
                    Some(existing) => existing.min(space),
                    None => space,
                });
            }
        }
        min_space
    }

    fn infer_cache_entry_class(&self, path: &Path) -> CacheEntryClass {
        if self.is_project_data_path(path) {
            CacheEntryClass::ProjectOwned
        } else {
            CacheEntryClass::AppCache
        }
    }

    fn build_index_entry_from_file(
        &self,
        namespaced_key: String,
        file: &DiskCacheFileMeta,
    ) -> DiskCacheIndexEntry {
        let (project_id, dataset_id) = Self::split_namespaced_key(&namespaced_key);
        DiskCacheIndexEntry {
            namespaced_key,
            project_id,
            dataset_id,
            path: Self::normalize_index_path(&file.path),
            size_bytes: file.size_bytes,
            last_accessed_unix_secs: Self::now_unix_secs(),
            class: self.infer_cache_entry_class(&file.path),
        }
    }

    fn reconcile_disk_cache_index(&self) {
        let files = self.read_disk_cache_files();
        let files_by_path: HashMap<String, DiskCacheFileMeta> = files
            .into_iter()
            .map(|file| (Self::normalize_index_path(&file.path), file))
            .collect();

        let mut index = self.disk_cache_index.write().unwrap();

        // Drop missing file entries
        index.retain(|path, _| files_by_path.contains_key(path));

        // Add unknown files and refresh size/class for known files
        for (path_key, file) in &files_by_path {
            if let Some(existing) = index.get_mut(path_key) {
                existing.size_bytes = file.size_bytes;
                existing.class = self.infer_cache_entry_class(&file.path);
                continue;
            }

            let dataset_id = file
                .path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "unknown".to_string());
            let project_id = file
                .path
                .parent()
                .and_then(|parent| parent.strip_prefix(&self.data_dir).ok())
                .and_then(|relative| relative.components().next())
                .and_then(|component| component.as_os_str().to_str())
                .map(|s| s.to_string());
            let namespaced_key = match &project_id {
                Some(pid) => format!("{}:{}", pid, dataset_id),
                None => dataset_id.clone(),
            };

            index.insert(
                path_key.clone(),
                DiskCacheIndexEntry {
                    namespaced_key,
                    project_id,
                    dataset_id: Some(dataset_id),
                    path: path_key.clone(),
                    size_bytes: file.size_bytes,
                    last_accessed_unix_secs: Self::now_unix_secs(),
                    class: self.infer_cache_entry_class(&file.path),
                },
            );
        }

        drop(index);
        self.persist_disk_cache_index();
    }

    fn touch_disk_cache_entry_for_path(&self, path: &Path) {
        let key = Self::normalize_index_path(path);
        let mut index = self.disk_cache_index.write().unwrap();
        if let Some(entry) = index.get_mut(&key) {
            entry.last_accessed_unix_secs = Self::now_unix_secs();
            if let Ok(metadata) = fs::metadata(path) {
                entry.size_bytes = metadata.len();
            }
        }
    }

    fn register_disk_cache_entry(&self, namespaced_key: &str, path: &Path) {
        if !self.is_path_in_app_cache(path) {
            return;
        }
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(_) => return,
        };
        let file = DiskCacheFileMeta {
            path: path.to_path_buf(),
            size_bytes: metadata.len(),
            modified_unix_secs: metadata
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
        };
        let entry = self.build_index_entry_from_file(namespaced_key.to_string(), &file);
        let key = entry.path.clone();
        let mut index = self.disk_cache_index.write().unwrap();
        index.insert(key, entry);
        drop(index);
        self.persist_disk_cache_index();
    }

    fn remove_disk_cache_entry_for_path(&self, path: &Path) {
        self.remove_disk_cache_entry_for_path_internal(path, true);
    }

    fn remove_disk_cache_entry_for_path_internal(&self, path: &Path, persist: bool) {
        let key = Self::normalize_index_path(path);
        let mut index = self.disk_cache_index.write().unwrap();
        let removed = index.remove(&key).is_some();
        drop(index);
        if removed && persist {
            self.persist_disk_cache_index();
        }
    }

    fn remove_disk_cache_entries_for_project_prefix(&self, project_id: &str) {
        let prefix = format!("{}:", project_id);
        let mut index = self.disk_cache_index.write().unwrap();
        let before = index.len();
        index.retain(|_, entry| !entry.namespaced_key.starts_with(&prefix));
        let changed = before != index.len();
        drop(index);
        if changed {
            self.persist_disk_cache_index();
        }
    }

    fn active_duckdb_paths(&self) -> HashSet<String> {
        let datasets = self.datasets.read().unwrap();
        datasets
            .values()
            .filter_map(|storage| match storage {
                DatasetStorage::DuckDB { db_path, .. } => Some(Self::normalize_index_path(db_path)),
                _ => None,
            })
            .collect()
    }

    fn get_duckdb_path_for_namespaced_key(&self, namespaced_key: &str) -> Option<PathBuf> {
        let datasets = self.datasets.read().unwrap();
        match datasets.get(namespaced_key) {
            Some(DatasetStorage::DuckDB { db_path, .. }) => Some(db_path.clone()),
            _ => None,
        }
    }

    fn remove_file_if_not_active(
        &self,
        file: &DiskCacheFileMeta,
        active_paths: &HashSet<String>,
        summary: &mut CacheCleanupSummary,
    ) {
        let normalized = Self::normalize_index_path(&file.path);
        if active_paths.contains(&normalized) {
            summary.skipped_active_files += 1;
            return;
        }

        match fs::remove_file(&file.path) {
            Ok(_) => {
                summary.removed_files += 1;
                summary.removed_bytes += file.size_bytes;
                self.remove_disk_cache_entry_for_path_internal(&file.path, false);
            }
            Err(error) => {
                log::warn!(
                    "Cache cleanup: failed to remove '{}': {}",
                    file.path.display(),
                    error
                );
            }
        }
    }

    fn cleanup_empty_app_cache_dirs(&self) {
        fn cleanup_dir(path: &Path) {
            let read_dir = match fs::read_dir(path) {
                Ok(read_dir) => read_dir,
                Err(_) => return,
            };
            for entry in read_dir.flatten() {
                let entry_path = entry.path();
                if entry_path.is_dir() {
                    cleanup_dir(&entry_path);
                    if fs::read_dir(&entry_path)
                        .map(|mut it| it.next().is_none())
                        .unwrap_or(false)
                    {
                        let _ = fs::remove_dir(&entry_path);
                    }
                }
            }
        }

        cleanup_dir(&self.data_dir);
    }

    fn cleanup_unsaved_app_cache_internal(
        &self,
        project_filter: Option<&str>,
        remove_all_candidates: bool,
    ) -> CacheCleanupSummary {
        let mut summary = CacheCleanupSummary {
            removed_files: 0,
            removed_bytes: 0,
            skipped_active_files: 0,
        };
        let active_paths = self.active_duckdb_paths();
        let files = self.read_disk_cache_files();
        let now = Self::now_unix_secs();
        let index_snapshot = self.disk_cache_index.read().unwrap().clone();
        let project_dataset_ids: Option<HashSet<String>> = project_filter.map(|project_id| {
            let prefix = format!("{}:", project_id);

            let mut ids = HashSet::new();

            let datasets = self.datasets.read().unwrap();
            for key in datasets.keys() {
                if let Some((pid, dataset_id)) = key.split_once(':') {
                    if pid == project_id {
                        ids.insert(dataset_id.to_string());
                    }
                }
            }
            drop(datasets);

            for entry in index_snapshot.values() {
                if entry.namespaced_key.starts_with(&prefix) {
                    if let Some(dataset_id) = entry.dataset_id.as_ref() {
                        ids.insert(dataset_id.clone());
                    } else if let Some((_, dataset_id)) = entry.namespaced_key.split_once(':') {
                        ids.insert(dataset_id.to_string());
                    }
                }
            }

            ids
        });

        let is_candidate = |file: &DiskCacheFileMeta| {
            if !self.is_path_in_app_cache(&file.path) {
                return false;
            }
            let path_key = Self::normalize_index_path(&file.path);
            if let Some(entry) = index_snapshot.get(&path_key) {
                if !matches!(entry.class, CacheEntryClass::AppCache) {
                    return false;
                }
                if let Some(project_id) = project_filter {
                    let project_prefix = format!("{}:", project_id);
                    if entry.namespaced_key.starts_with(&project_prefix)
                        || entry.project_id.as_deref() == Some(project_id)
                    {
                        return true;
                    }
                    if let (Some(dataset_id), Some(ids)) =
                        (entry.dataset_id.as_ref(), project_dataset_ids.as_ref())
                    {
                        if ids.contains(dataset_id) {
                            return true;
                        }
                    }
                    let relative = match file.path.strip_prefix(&self.data_dir) {
                        Ok(relative) => relative,
                        Err(_) => return false,
                    };
                    let first = relative
                        .components()
                        .next()
                        .and_then(|c| c.as_os_str().to_str());
                    return first == Some(project_id);
                }
                return true;
            }

            if let Some(project_id) = project_filter {
                let relative = match file.path.strip_prefix(&self.data_dir) {
                    Ok(relative) => relative,
                    Err(_) => return false,
                };
                let first = relative
                    .components()
                    .next()
                    .and_then(|c| c.as_os_str().to_str());
                if first == Some(project_id) {
                    return true;
                }
                if let Some(ids) = project_dataset_ids.as_ref() {
                    let dataset_id = file
                        .path
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .unwrap_or_default();
                    return ids.contains(dataset_id);
                }
                return false;
            }
            true
        };

        let mut candidates: Vec<DiskCacheFileMeta> = files
            .into_iter()
            .filter(|file| is_candidate(file))
            .collect();

        if remove_all_candidates {
            for file in &candidates {
                self.remove_file_if_not_active(file, &active_paths, &mut summary);
            }
            if summary.removed_files > 0 {
                self.persist_disk_cache_index();
            }
            return summary;
        }

        // Phase 1: remove stale-by-age files first.
        for file in &candidates {
            let file_age = now.saturating_sub(file.modified_unix_secs);
            if file_age >= APP_CACHE_TTL_SECS {
                self.remove_file_if_not_active(file, &active_paths, &mut summary);
            }
        }

        candidates = self
            .read_disk_cache_files()
            .into_iter()
            .filter(|file| is_candidate(file))
            .collect();
        let mut total_size: u64 = candidates.iter().map(|f| f.size_bytes).sum();
        if total_size <= APP_CACHE_HARD_LIMIT_BYTES {
            return summary;
        }

        // Phase 2: LRU eviction by index last_accessed.
        let index_snapshot = self.disk_cache_index.read().unwrap().clone();
        candidates.sort_by_key(|file| {
            let key = Self::normalize_index_path(&file.path);
            index_snapshot
                .get(&key)
                .map(|entry| entry.last_accessed_unix_secs)
                .unwrap_or(file.modified_unix_secs)
        });

        for file in &candidates {
            if total_size <= APP_CACHE_SOFT_LIMIT_BYTES {
                break;
            }
            let before_removed = summary.removed_files;
            self.remove_file_if_not_active(file, &active_paths, &mut summary);
            if summary.removed_files != before_removed {
                total_size = total_size.saturating_sub(file.size_bytes);
            }
        }

        if summary.removed_files > 0 {
            self.persist_disk_cache_index();
        }

        summary
    }

    fn enforce_unsaved_cache_budget(&self) {
        let summary = self.cleanup_unsaved_app_cache_internal(None, false);
        if summary.removed_files > 0 {
            log::info!(
                "Cache: Startup budget cleanup removed {} files ({} bytes), skipped {} active files",
                summary.removed_files,
                summary.removed_bytes,
                summary.skipped_active_files
            );
        }
        self.reconcile_disk_cache_index();
    }

    pub fn run_startup_maintenance(&self) {
        self.reconcile_disk_cache_index();
        self.enforce_unsaved_cache_budget();
        self.cleanup_empty_app_cache_dirs();
    }

    // ============================================================================
    // PHASE B: PROJECT NAMESPACING
    // ============================================================================

    /// Set the active project ID for dataset namespacing
    /// Call this in COMMIT phase (after preflight succeeds)
    /// Returns the previous active project ID for rollback on failure
    pub fn set_active_project_id(&self, project_id: &str) -> Option<String> {
        if !Self::is_safe_project_id(project_id) {
            log::warn!("Rejected unsafe project ID: '{}'", project_id);
            return self.get_active_project_id();
        }
        let mut active = self.active_project_id.write().unwrap();
        let previous = active.take();
        *active = Some(project_id.to_string());
        log::info!(
            "Set active project ID: {} (previous: {:?})",
            project_id,
            previous
        );
        previous
    }

    /// Get the current active project ID
    pub fn get_active_project_id(&self) -> Option<String> {
        self.active_project_id.read().unwrap().clone()
    }

    /// Clear the active project ID (used on app close or reset)
    pub fn clear_active_project_id(&self) -> Option<String> {
        let mut active = self.active_project_id.write().unwrap();
        let previous = active.take();
        log::info!("Cleared active project ID (was: {:?})", previous);
        previous
    }

    /// Generate namespaced key for dataset storage
    /// Uses active project ID if no explicit project_id provided
    /// ERRORS if no active project and no explicit project_id
    pub fn get_namespaced_key(&self, dataset_id: &str) -> Result<String, String> {
        let active = self.active_project_id.read().unwrap();
        match active.as_ref() {
            Some(pid) => Ok(format!("{}:{}", pid, dataset_id)),
            None => Err(format!(
                "No active project set. Cannot access dataset '{}' without project context.",
                dataset_id
            )),
        }
    }

    /// Generate namespaced key with explicit project ID
    /// Use this for long-running operations that might outlive a project switch
    pub fn get_namespaced_key_explicit(&self, project_id: &str, dataset_id: &str) -> String {
        format!("{}:{}", project_id, dataset_id)
    }

    /// Resolve dataset key to namespaced form (accepts already-namespaced input).
    fn resolve_namespaced_key(&self, dataset_id: &str) -> Result<String, String> {
        if dataset_id.contains(':') {
            Ok(dataset_id.to_string())
        } else {
            self.get_namespaced_key(dataset_id)
        }
    }

    /// Resolve dataset key or return None when no active project is set.
    fn resolve_namespaced_key_optional(&self, dataset_id: &str) -> Option<String> {
        if dataset_id.contains(':') {
            return Some(dataset_id.to_string());
        }
        match self.get_namespaced_key(dataset_id) {
            Ok(key) => Some(key),
            Err(e) => {
                log::warn!("Failed to resolve dataset key '{}': {}", dataset_id, e);
                None
            }
        }
    }

    // ============================================================================
    // PHASE 4: PROJECT-SCOPED CACHE DIRECTORIES
    // ============================================================================

    /// Get per-project cache directory (Phase 4: Collision Prevention)
    ///
    /// Checks project_data_dirs first (user's chosen save location),
    /// then falls back to AppData for unsaved projects.
    ///
    /// Example (when project data dir is set):
    /// ```
    /// C:/Users/username/Documents/my-project_data/
    /// └── dataset-123.ecpdb
    /// ```
    ///
    /// Fallback (when project data dir not set):
    /// ```
    /// AppData/easyCris/duckdb_cache/project-abc/
    /// └── dataset-123.ecpdb
    /// ```
    fn get_project_cache_dir(&self, project_id: &str) -> PathBuf {
        // Check if project has a custom data directory (project-adjacent storage)
        let project_dirs = self.project_data_dirs.read().unwrap();
        if let Some(custom_dir) = project_dirs.get(project_id) {
            return custom_dir.clone();
        }
        drop(project_dirs);

        // Fallback to AppData for unsaved projects
        self.data_dir.join(project_id)
    }

    /// Set custom data directory for a project (project-adjacent storage)
    ///
    /// When set, all database files for this project will be stored in the
    /// specified directory (typically {project}_data/ next to the .ecp file).
    /// This avoids AppData permission issues and keeps everything together.
    ///
    /// Call this when:
    /// - Opening a project (use {projectDir}/{projectName}_data/)
    /// - Saving a project (use {projectDir}/{projectName}_data/)
    pub fn set_project_data_dir(&self, project_id: &str, data_dir: PathBuf) {
        // Create directory if it doesn't exist
        let _ = std::fs::create_dir_all(&data_dir);
        let canonical_dir = fs::canonicalize(&data_dir).unwrap_or(data_dir);

        let mut project_dirs = self.project_data_dirs.write().unwrap();
        project_dirs.insert(project_id.to_string(), canonical_dir.clone());

        log::info!(
            "Set project data directory for '{}': {}",
            project_id,
            canonical_dir.display()
        );
    }

    /// Returns true if a dataset file lives inside any project data directory.
    fn is_project_data_path(&self, path: &Path) -> bool {
        let canonical_path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let project_dirs = self.project_data_dirs.read().unwrap();
        project_dirs.values().any(|dir| {
            let canonical_dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.clone());
            canonical_path.starts_with(&canonical_dir)
        })
    }

    /// Returns true when a DuckDB path belongs to app-managed storage.
    ///
    /// In release builds, we only allow loading data files from:
    /// - AppData-backed cache directory
    /// - Registered project data directories (project-adjacent storage)
    ///
    /// Debug builds remain permissive for developer workflows.
    pub fn is_allowed_duckdb_path(&self, path: &Path) -> bool {
        if cfg!(debug_assertions) {
            return true;
        }

        let canonical = match path.canonicalize() {
            Ok(path) => path,
            Err(_) => return false,
        };

        if canonical.starts_with(&self.data_dir) {
            return true;
        }

        self.is_project_data_path(&canonical)
    }

    /// PHASE 1: Copy a dataset's DuckDB file to project data directory (non-destructive).
    /// Does NOT delete the old file or update internal paths yet.
    /// Call finalize_bundled_dataset_file() after .ecp save succeeds.
    /// This avoids frontend fs scope restrictions by doing the copy in the backend.
    pub fn bundle_dataset_data_file(
        &self,
        project_id: &str,
        dataset_id: &str,
    ) -> Result<PathBuf, String> {
        let namespaced_key = self.get_namespaced_key_explicit(project_id, dataset_id);
        self.flush_overlay(&namespaced_key)?;

        let dest_path = self.get_duckdb_path_with_project(project_id, dataset_id);
        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create data dir: {}", e))?;
        }

        let current_path = {
            let datasets = self.datasets.read().unwrap();
            match datasets.get(&namespaced_key) {
                Some(DatasetStorage::DuckDB { db_path, .. }) => db_path.clone(),
                _ => return Err(format!("Dataset '{}' is not stored in DuckDB", dataset_id)),
            }
        };

        // Guard against empty or missing source file (BEFORE copy)
        if !current_path.exists() {
            return Err(format!(
                "Source DuckDB file does not exist: '{}'",
                current_path.display()
            ));
        }

        let source_metadata = std::fs::metadata(&current_path).map_err(|e| {
            format!(
                "Failed to read source file metadata '{}': {}",
                current_path.display(),
                e
            )
        })?;

        let source_size = source_metadata.len();
        if source_size == 0 {
            return Err(format!(
                "Source DuckDB file is empty (0 bytes): '{}'",
                current_path.display()
            ));
        }

        log::info!(
            "[bundle] Copying dataset '{}': {} bytes from '{}'",
            dataset_id,
            source_size,
            current_path.display()
        );

        // Prevent new connections while bundling, and close any existing connection.
        let _bundling_guard = BundlingGuard::new(self, namespaced_key.clone());
        self.remove_connection(&namespaced_key);

        let copy_result = (|| -> Result<(), String> {
            // Perform copy if paths differ
            if !Self::paths_refer_to_same_file(&current_path, &dest_path) {
                let mut last_err: Option<std::io::Error> = None;
                for attempt in 0..5 {
                    match std::fs::copy(&current_path, &dest_path) {
                        Ok(_) => {
                            last_err = None;
                            break;
                        }
                        Err(e) => {
                            last_err = Some(e);
                            if attempt < 4 {
                                std::thread::sleep(Duration::from_millis(200));
                                continue;
                            }
                        }
                    }
                }

                if let Some(err) = last_err {
                    return Err(format!(
                        "Failed to copy data file from '{}' to '{}': {}",
                        current_path.display(),
                        dest_path.display(),
                        err
                    ));
                }

                // Verify destination file was created and is non-empty
                if !dest_path.exists() {
                    return Err(format!(
                        "Bundled file not found after copy: '{}'",
                        dest_path.display()
                    ));
                }

                let dest_metadata = std::fs::metadata(&dest_path).map_err(|e| {
                    format!(
                        "Failed to read destination file metadata '{}': {}",
                        dest_path.display(),
                        e
                    )
                })?;

                let dest_size = dest_metadata.len();
                if dest_size == 0 {
                    return Err(format!(
                        "Bundled file is empty after copy: '{}'",
                        dest_path.display()
                    ));
                }

                if dest_size != source_size {
                    log::warn!(
                        "[bundle] WARN size mismatch: source {} bytes, dest {} bytes",
                        source_size,
                        dest_size
                    );
                }

                log::info!(
                    "[bundle] OK copied to '{}' ({} bytes)",
                    dest_path.display(),
                    dest_size
                );
            } else {
                log::info!(
                    "[bundle] OK already at destination: '{}' ({} bytes)",
                    dest_path.display(),
                    source_size
                );
            }
            Ok(())
        })();

        copy_result?;

        // NOTE: Do NOT update internal path or delete old file yet
        // That happens in finalize_bundled_dataset_file() after .ecp save succeeds

        Ok(dest_path)
    }

    /// Flush and close DuckDB handles while an external copy reads project data files.
    pub fn with_datasets_released_for_external_read<T, F>(
        &self,
        project_id: &str,
        dataset_ids: &[String],
        operation: F,
    ) -> Result<T, String>
    where
        F: FnOnce() -> Result<T, String>,
    {
        let mut guards = Vec::new();

        for dataset_id in dataset_ids {
            let namespaced_key = self.get_namespaced_key_explicit(project_id, dataset_id);
            let has_dataset = {
                let datasets = self.datasets.read().unwrap();
                datasets.contains_key(&namespaced_key)
            };

            if !has_dataset {
                continue;
            }

            self.flush_overlay(&namespaced_key)?;
            guards.push(BundlingGuard::new(self, namespaced_key.clone()));
            self.remove_connection(&namespaced_key);
        }

        operation()
    }

    /// PHASE 2: Finalize bundled dataset (destructive, call after .ecp save succeeds).
    /// Updates internal dataset path to project location and deletes the old file.
    pub fn finalize_bundled_dataset_file(
        &self,
        project_id: &str,
        dataset_id: &str,
    ) -> Result<(), String> {
        let dest_path = self.get_duckdb_path_with_project(project_id, dataset_id);
        let namespaced_key = self.get_namespaced_key_explicit(project_id, dataset_id);

        if !dest_path.exists() {
            return Err(format!(
                "Bundled file not found for dataset '{}': '{}'",
                dataset_id,
                dest_path.display()
            ));
        }

        let dest_metadata = std::fs::metadata(&dest_path).map_err(|e| {
            format!(
                "Failed to read bundled file metadata '{}': {}",
                dest_path.display(),
                e
            )
        })?;

        if dest_metadata.len() == 0 {
            return Err(format!("Bundled file is empty: '{}'", dest_path.display()));
        }

        let old_path = {
            let datasets = self.datasets.read().unwrap();
            match datasets.get(&namespaced_key) {
                Some(DatasetStorage::DuckDB { db_path, .. }) => db_path.clone(),
                _ => return Err(format!("Dataset '{}' is not stored in DuckDB", dataset_id)),
            }
        };

        // Prevent new connections while finalizing, and close any existing connection.
        let _bundling_guard = BundlingGuard::new(self, namespaced_key.clone());
        self.remove_connection(&namespaced_key);

        // Update internal dataset storage path to project location
        {
            let mut datasets = self.datasets.write().unwrap();
            if let Some(DatasetStorage::DuckDB { db_path, .. }) = datasets.get_mut(&namespaced_key)
            {
                *db_path = dest_path.clone();
            }
        }

        log::info!(
            "[bundle] Finalized dataset '{}' path: '{}'",
            dataset_id,
            dest_path.display()
        );

        // Delete old file if it was at a different location
        if !Self::paths_refer_to_same_file(&old_path, &dest_path) {
            if let Err(err) = std::fs::remove_file(&old_path) {
                log::warn!(
                    "[bundle] WARN failed to remove old file '{}': {}",
                    old_path.display(),
                    err
                );
            } else {
                log::info!("[bundle] Removed old file: '{}'", old_path.display());
            }
        }

        Ok(())
    }

    /// Create DuckDB file path for dataset within a project (Phase 4)
    ///
    /// Returns the path where a dataset's DuckDB file should be stored,
    /// scoped to the given project ID to prevent cross-project collisions.
    pub fn get_duckdb_path_with_project(&self, project_id: &str, dataset_id: &str) -> PathBuf {
        let project_dir = self.get_project_cache_dir(project_id);
        project_dir.join(format!("{}{}", dataset_id, DATA_FILE_EXT))
    }

    fn resolve_duckdb_path_for_dataset(&self, dataset_id: &str) -> PathBuf {
        if let Some(project_id) = self.get_active_project_id() {
            if Self::is_safe_project_id(&project_id) {
                return self.get_duckdb_path_with_project(&project_id, dataset_id);
            }
            log::warn!(
                "Cache: active project ID '{}' is invalid; using shared AppData path for dataset '{}'",
                project_id,
                dataset_id
            );
        }
        self.data_dir
            .join(format!("{}{}", dataset_id, DATA_FILE_EXT))
    }

    fn ensure_duckdb_parent_dir(&self, db_path: &Path) -> Result<(), String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Failed to create cache directory '{}': {}",
                    parent.display(),
                    e
                )
            })?;
        }
        Ok(())
    }

    fn open_duckdb_for_create(&self, db_path: &Path) -> Result<Connection, String> {
        for (attempt_idx, delay_ms) in CONNECTION_OPEN_RETRY_DELAYS_MS.iter().enumerate() {
            if *delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(*delay_ms));
            }

            self.ensure_duckdb_parent_dir(db_path)?;

            match Connection::open(db_path) {
                Ok(conn) => return Ok(conn),
                Err(err) => {
                    let is_last_attempt = attempt_idx + 1 == CONNECTION_OPEN_RETRY_DELAYS_MS.len();
                    if is_last_attempt {
                        return Err(format!("Failed to create database: {}", err));
                    }

                    log::warn!(
                        "Cache: failed to create DuckDB database at '{}' on attempt {}: {}",
                        db_path.display(),
                        attempt_idx + 1,
                        err
                    );
                }
            }
        }

        Err("Failed to create database: exhausted retry attempts".to_string())
    }

    /// Quote SQL identifier to prevent injection
    fn quote_identifier(name: &str) -> String {
        format!("\"{}\"", name.replace('"', "\"\""))
    }

    fn ensure_hidden_columns_table(conn: &Connection) -> Result<(), String> {
        let sql = format!(
            "CREATE TABLE IF NOT EXISTS {} (column_id VARCHAR PRIMARY KEY)",
            Self::quote_identifier(HIDDEN_COLUMNS_TABLE)
        );
        conn.execute(&sql, []).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn get_hidden_columns(conn: &Connection) -> Result<HashSet<String>, String> {
        Self::ensure_hidden_columns_table(conn)?;
        let sql = format!(
            "SELECT column_id FROM {}",
            Self::quote_identifier(HIDDEN_COLUMNS_TABLE)
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut hidden = HashSet::new();
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let column_id = row.map_err(|e| e.to_string())?;
            hidden.insert(column_id);
        }
        Ok(hidden)
    }

    fn set_column_hidden(conn: &Connection, column_id: &str, hidden: bool) -> Result<(), String> {
        Self::ensure_hidden_columns_table(conn)?;
        if hidden {
            let sql = format!(
                "INSERT OR IGNORE INTO {} (column_id) VALUES (?)",
                Self::quote_identifier(HIDDEN_COLUMNS_TABLE)
            );
            conn.execute(&sql, params![column_id])
                .map_err(|e| e.to_string())?;
        } else {
            let sql = format!(
                "DELETE FROM {} WHERE column_id = ?",
                Self::quote_identifier(HIDDEN_COLUMNS_TABLE)
            );
            conn.execute(&sql, params![column_id])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Build a numeric sort expression for a column.
    /// Uses TRY_CAST so non-numeric values become NULL (sorted last).
    fn numeric_sort_expr(column: &str) -> String {
        let col_ident = Self::quote_identifier(column);
        format!("TRY_CAST(TRIM(CAST({} AS VARCHAR)) AS DOUBLE)", col_ident)
    }

    /// Build a numeric expression for aggregation (NULL for non-numeric values).
    fn numeric_expr(column: &str) -> String {
        let col_ident = Self::quote_identifier(column);
        format!("TRY_CAST(TRIM(CAST({} AS VARCHAR)) AS DOUBLE)", col_ident)
    }

    /// Infer DuckDB column type and default SQL from a JSON value.
    fn infer_column_type(value: &Value) -> (&'static str, &'static str) {
        match value {
            Value::Null => ("VARCHAR", "NULL"),
            Value::Bool(_) => ("BOOLEAN", "NULL"),
            Value::Number(n) if n.is_f64() => ("DOUBLE", "NULL"),
            Value::Number(_) => ("BIGINT", "NULL"),
            Value::String(_) => ("VARCHAR", "''"),
            _ => ("VARCHAR", "NULL"),
        }
    }

    fn is_missing_string(value: &str) -> bool {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return true;
        }
        let lower = trimmed.to_ascii_lowercase();
        MISSING_VALUE_INDICATORS.contains(&lower.as_str())
    }

    fn acquire_connection_open_slot(
        &self,
        namespaced_key: &str,
        dataset_id: &str,
        timeout: Duration,
    ) -> Result<ConnectionOpenGuard<'_>, String> {
        let started = Instant::now();
        loop {
            let mut opening = self.opening_connections.lock().unwrap();
            if !opening.contains(namespaced_key) {
                opening.insert(namespaced_key.to_string());
                return Ok(ConnectionOpenGuard::new(self, namespaced_key.to_string()));
            }

            let elapsed = started.elapsed();
            if elapsed >= timeout {
                return Err(format!(
                    "Timed out waiting for connection open for dataset '{}' (key: '{}')",
                    dataset_id, namespaced_key
                ));
            }

            let remaining = timeout
                .checked_sub(elapsed)
                .unwrap_or_else(|| Duration::from_secs(0));
            let (guard, wait_result) = self
                .opening_connections_cv
                .wait_timeout(opening, remaining)
                .unwrap();

            if wait_result.timed_out() && guard.contains(namespaced_key) {
                return Err(format!(
                    "Timed out waiting for connection open for dataset '{}' (key: '{}')",
                    dataset_id, namespaced_key
                ));
            }
        }
    }

    fn record_connection_open_success(&self, namespaced_key: &str) {
        let mut failures = self.connection_open_failures.lock().unwrap();
        failures.remove(namespaced_key);
        drop(failures);
        let mut disabled = self.prewarm_disabled_datasets.lock().unwrap();
        disabled.remove(namespaced_key);
    }

    fn record_connection_open_failure(&self, namespaced_key: &str) {
        let mut failures = self.connection_open_failures.lock().unwrap();
        let count = failures.entry(namespaced_key.to_string()).or_insert(0);
        *count += 1;
        if *count >= PREWARM_DISABLE_AFTER_OPEN_FAILURES {
            drop(failures);
            let mut disabled = self.prewarm_disabled_datasets.lock().unwrap();
            disabled.insert(namespaced_key.to_string());
        }
    }

    /// Warm per-dataset DuckDB infrastructure used by first structural edits.
    /// This is intentionally non-mutating for logical data: it opens the pooled
    /// connection, creates metadata tables if missing, and performs tiny reads.
    pub fn prewarm_dataset_infrastructure(&self, dataset_id: &str) -> Result<(), String> {
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        {
            let datasets = self.datasets.read().unwrap();
            match datasets.get(&namespaced_key) {
                Some(DatasetStorage::DuckDB { .. }) => {}
                Some(DatasetStorage::InMemory { .. }) => return Ok(()),
                None => return Err(format!("Dataset '{}' not found", dataset_id)),
            }
        }

        let conn_arc = self.get_connection(dataset_id)?;
        let conn = conn_arc.lock().unwrap();
        Self::ensure_row_order_table(&conn)?;
        Self::ensure_hidden_columns_table(&conn)?;

        let _: i64 = conn
            .query_row("SELECT COUNT(*) FROM main.row_order", [], |row| row.get(0))
            .map_err(|e| format!("Failed to prewarm row_order for '{}': {}", dataset_id, e))?;
        let hidden_sql = format!(
            "SELECT COUNT(*) FROM {}",
            Self::quote_identifier(HIDDEN_COLUMNS_TABLE)
        );
        let _: i64 = conn
            .query_row(&hidden_sql, [], |row| row.get(0))
            .map_err(|e| {
                format!(
                    "Failed to prewarm hidden-column metadata for '{}': {}",
                    dataset_id, e
                )
            })?;
        Ok(())
    }

    /// Get or create a pooled connection for a dataset
    fn get_connection(&self, dataset_id: &str) -> Result<Arc<Mutex<Connection>>, String> {
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        self.wait_for_bundling(&namespaced_key)?;

        // Check if connection already exists
        {
            let conns = self.connections.read().unwrap();
            if let Some(conn) = conns.get(&namespaced_key) {
                if let Some(db_path) = self.get_duckdb_path_for_namespaced_key(&namespaced_key) {
                    self.touch_disk_cache_entry_for_path(&db_path);
                }
                log::debug!(
                    "[duckdb][pool] Reusing connection for dataset '{}' (key: '{}')",
                    dataset_id,
                    namespaced_key
                );
                return Ok(Arc::clone(conn));
            }
        }

        // Need to create a new connection
        let datasets = self.datasets.read().unwrap();
        let db_path = match datasets.get(&namespaced_key) {
            Some(DatasetStorage::DuckDB { db_path, .. }) => db_path.clone(),
            Some(DatasetStorage::InMemory { .. }) => {
                return Err("In-memory datasets don't use connections".to_string());
            }
            None => return Err(format!("Dataset '{}' not found", dataset_id)),
        };
        drop(datasets);

        if !db_path.exists() {
            return Err(format!(
                "Failed to open database: file missing at '{}'",
                db_path.display()
            ));
        }
        let metadata = match fs::metadata(&db_path) {
            Ok(meta) => meta,
            Err(err) => {
                return Err(format!(
                    "Failed to open database '{}': metadata read failed: {}",
                    db_path.display(),
                    err
                ));
            }
        };
        if metadata.len() == 0 {
            return Err(format!(
                "Failed to open database '{}': file is empty",
                db_path.display()
            ));
        }

        // Open connection and add to pool
        if db_path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("ecpdb"))
            != Some(true)
        {
            log::warn!(
                "[duckdb][path] Non-standard extension for dataset '{}' (key: '{}'): '{}'",
                dataset_id,
                namespaced_key,
                db_path.display()
            );
        }

        log::info!(
            "[duckdb][pool] Opening connection for dataset '{}' (key: '{}') at '{}'",
            dataset_id,
            namespaced_key,
            db_path.display()
        );
        for (attempt_idx, delay_ms) in CONNECTION_OPEN_RETRY_DELAYS_MS.iter().enumerate() {
            if *delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(*delay_ms));
            }

            // Single-flight open: only one opener per dataset key.
            // Gate is held only for this attempt and released before next retry sleep.
            let _open_guard = self.acquire_connection_open_slot(
                &namespaced_key,
                dataset_id,
                Duration::from_secs(CONNECTION_OPEN_SINGLE_FLIGHT_WAIT_TIMEOUT_SECS),
            )?;

            // Re-check the pool while holding the opening gate to avoid open races.
            if let Some(existing) = self
                .connections
                .read()
                .unwrap()
                .get(&namespaced_key)
                .cloned()
            {
                if let Some(db_path) = self.get_duckdb_path_for_namespaced_key(&namespaced_key) {
                    self.touch_disk_cache_entry_for_path(&db_path);
                }
                log::debug!(
                    "[duckdb][pool] Reusing connection for dataset '{}' (key: '{}') after single-flight wait",
                    dataset_id,
                    namespaced_key
                );
                return Ok(existing);
            }

            match Connection::open(&db_path) {
                Ok(conn) => {
                    if attempt_idx > 0 {
                        log::warn!(
                            "[duckdb][pool] Recovered connection open for dataset '{}' (key: '{}') at '{}' after {} retries",
                            dataset_id,
                            namespaced_key,
                            db_path.display(),
                            attempt_idx
                        );
                    }
                    let conn_arc = Arc::new(Mutex::new(conn));
                    self.record_connection_open_success(&namespaced_key);
                    let mut conns = self.connections.write().unwrap();
                    conns.insert(namespaced_key.clone(), Arc::clone(&conn_arc));
                    self.touch_disk_cache_entry_for_path(&db_path);
                    return Ok(conn_arc);
                }
                Err(err) => {
                    let err_string = err.to_string();
                    let is_last_attempt = attempt_idx + 1 == CONNECTION_OPEN_RETRY_DELAYS_MS.len();

                    if is_last_attempt {
                        log::warn!(
                            "[duckdb][pool] Failed to open connection for dataset '{}' (key: '{}') at '{}': {}",
                            dataset_id,
                            namespaced_key,
                            db_path.display(),
                            err_string
                        );
                        self.record_connection_open_failure(&namespaced_key);
                        return Err(format!("Failed to open database: {}", err_string));
                    }

                    log::warn!(
                        "[duckdb][pool] Open failure for dataset '{}' (key: '{}') at '{}': {} (retrying)",
                        dataset_id,
                        namespaced_key,
                        db_path.display(),
                        err_string
                    );
                }
            }
        }

        Err(format!(
            "Failed to open database '{}': unknown open error",
            db_path.display()
        ))
    }

    /// Remove connection from pool (called when dataset is removed)
    fn remove_connection(&self, dataset_id: &str) {
        let Some(namespaced_key) = self.resolve_namespaced_key_optional(dataset_id) else {
            return;
        };
        let mut conns = self.connections.write().unwrap();
        if conns.remove(&namespaced_key).is_some() {
            log::info!(
                "[duckdb][pool] Removed connection for dataset '{}' (key: '{}')",
                dataset_id,
                namespaced_key
            );
        }
    }

    fn begin_bundling(&self, dataset_id: &str) {
        let Some(namespaced_key) = self.resolve_namespaced_key_optional(dataset_id) else {
            return;
        };
        let mut bundling = self.bundling_datasets.write().unwrap();
        bundling.insert(namespaced_key);
    }

    fn end_bundling(&self, dataset_id: &str) {
        let Some(namespaced_key) = self.resolve_namespaced_key_optional(dataset_id) else {
            return;
        };
        let mut bundling = self.bundling_datasets.write().unwrap();
        bundling.remove(&namespaced_key);
    }

    fn wait_for_bundling(&self, dataset_id: &str) -> Result<(), String> {
        let Some(namespaced_key) = self.resolve_namespaced_key_optional(dataset_id) else {
            return Ok(());
        };
        let started = Instant::now();
        let max_wait = Duration::from_secs(30);
        loop {
            {
                let bundling = self.bundling_datasets.read().unwrap();
                if !bundling.contains(&namespaced_key) {
                    return Ok(());
                }
            }
            if started.elapsed() >= max_wait {
                log::warn!(
                    "Cache: wait_for_bundling timed out for dataset '{}' (key '{}') after {:?}",
                    dataset_id,
                    namespaced_key,
                    max_wait
                );
                return Err(format!(
                    "Timed out waiting for dataset '{}' to finish bundling",
                    dataset_id
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Check if dataset is large (row-count threshold)
    /// Phase B: Uses namespaced key; returns false if no active project
    pub fn is_large_dataset(&self, dataset_id: &str) -> bool {
        let namespaced_key = match self.get_namespaced_key(dataset_id) {
            Ok(key) => key,
            Err(e) => {
                log::warn!("is_large_dataset failed: {}", e);
                return false;
            }
        };
        let datasets = self.datasets.read().unwrap();
        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { rows }) => rows.len() >= LARGE_DATASET_THRESHOLD,
            Some(DatasetStorage::DuckDB { row_count, .. }) => *row_count >= LARGE_DATASET_THRESHOLD,
            None => false,
        }
    }

    /// Get dataset storage info for frontend routing
    /// Phase B: Uses namespaced key; returns None if no active project
    pub fn get_dataset_storage_info(&self, dataset_id: &str) -> Option<(bool, Option<String>)> {
        let namespaced_key = match self.get_namespaced_key(dataset_id) {
            Ok(key) => key,
            Err(e) => {
                log::warn!("get_dataset_storage_info failed: {}", e);
                return None;
            }
        };
        let datasets = self.datasets.read().unwrap();
        match datasets.get(&namespaced_key)? {
            DatasetStorage::InMemory { rows } => {
                Some((rows.len() >= LARGE_DATASET_THRESHOLD, None))
            }
            DatasetStorage::DuckDB {
                db_path, row_count, ..
            } => {
                let is_large = *row_count >= LARGE_DATASET_THRESHOLD;
                Some((is_large, Some(db_path.to_string_lossy().to_string())))
            }
        }
    }

    /// Ensure a dataset is stored in DuckDB (converts in-memory datasets on demand).
    /// Phase B: Uses namespaced key for storage operations
    pub fn ensure_duckdb_dataset(
        &self,
        dataset_id: &str,
        columns: Vec<ColumnInfo>,
    ) -> Result<(bool, Option<String>), String> {
        let namespaced_key = self.get_namespaced_key(dataset_id)?;

        let rows_opt = {
            let datasets = self.datasets.read().unwrap();
            match datasets.get(&namespaced_key) {
                Some(DatasetStorage::DuckDB { .. }) => {
                    return self
                        .get_dataset_storage_info(dataset_id)
                        .ok_or_else(|| format!("Dataset '{}' not found", dataset_id));
                }
                Some(DatasetStorage::InMemory { rows }) => Some(rows.clone()),
                None => return Err(format!("Dataset '{}' not found", dataset_id)),
            }
        };

        let rows = rows_opt.unwrap_or_default();
        if rows.is_empty() {
            self.create_empty_table(dataset_id, columns)?;
        } else {
            self.import_from_rows(dataset_id, columns, rows)?;
        }

        self.get_dataset_storage_info(dataset_id)
            .ok_or_else(|| format!("Dataset '{}' not found", dataset_id))
    }

    // ========================================================================
    // DATASET LIFECYCLE
    // ========================================================================

    /// Set dataset - automatically chooses storage based on row count
    ///
    /// PRESERVES CURRENT BEHAVIOR for small datasets.
    /// Routes to DuckDB for large datasets (if USE_DUCKDB_FOR_LARGE is true).
    /// Phase B: Uses namespaced key; panics if no active project (must be set first)
    pub fn set_dataset(&self, dataset_id: &str, rows: Vec<HashMap<String, Value>>) {
        let operation_guard = self.current_purge_generation();
        let namespaced_key = match self.get_namespaced_key(dataset_id) {
            Ok(key) => key,
            Err(e) => {
                log::error!(
                    "set_dataset failed: {} - active project must be set first",
                    e
                );
                return;
            }
        };

        let row_count = rows.len();

        // Phase 3: Clear any cached row ranges for this dataset ID
        // (ensures stale cached rows don't survive dataset replacement)
        // Phase B: Use namespaced key
        self.invalidate_row_range_cache(&namespaced_key);
        self.invalidate_column_stats_cache(&namespaced_key);

        // Check feature flag and threshold
        let use_duckdb = USE_DUCKDB_FOR_LARGE && row_count >= LARGE_DATASET_THRESHOLD;

        if !use_duckdb {
            // Small dataset (or feature flag disabled): current behavior exactly
            log::info!(
                "Cache: Set dataset '{}' (key: {}) with {} rows (in-memory)",
                dataset_id,
                namespaced_key,
                row_count
            );

            let mut datasets = self.datasets.write().unwrap();
            if let Err(error) = self.ensure_guard_current(operation_guard, "set_dataset_in_memory")
            {
                log::warn!("{}", error);
                return;
            }
            datasets.insert(namespaced_key, DatasetStorage::InMemory { rows });
        } else {
            // Large dataset: store in file-backed DuckDB
            log::info!(
                "Cache: Set dataset '{}' (key: {}) with {} rows (DuckDB file-backed)",
                dataset_id,
                namespaced_key,
                row_count
            );

            if let Err(e) = self.store_in_duckdb(dataset_id, rows) {
                log::error!(
                    "Failed to store in database: {}. Falling back to in-memory.",
                    e
                );
                // Fallback would cause OOM for truly large datasets
                // Just log the error - caller should handle
            }
        }
    }

    fn prepare_csv_import_source(
        &self,
        file_path: &str,
    ) -> Result<PreparedCsvImportSource, String> {
        let source_path = PathBuf::from(file_path);
        let repair_plan = self.detect_csv_header_repair_plan(&source_path)?;

        let Some((repaired_header, repair_reason)) = repair_plan else {
            return Ok(PreparedCsvImportSource {
                source_path,
                cleanup_path: None,
                warning: None,
            });
        };

        let repaired_path =
            std::env::temp_dir().join(format!("easycris_csv_header_repair_{}.csv", Uuid::new_v4()));
        let mut csv_reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_path(&source_path)
            .map_err(|e| {
                format!(
                    "Failed to open CSV for header repair '{}': {}",
                    source_path.display(),
                    e
                )
            })?;
        let mut csv_writer = csv::WriterBuilder::new()
            .has_headers(false)
            .from_path(&repaired_path)
            .map_err(|e| {
                format!(
                    "Failed to create temporary repaired CSV '{}': {}",
                    repaired_path.display(),
                    e
                )
            })?;

        csv_writer
            .write_record(&repaired_header)
            .map_err(|e| format!("Failed to write repaired CSV header record: {}", e))?;
        for (record_index, record_result) in csv_reader.records().enumerate() {
            let record = record_result.map_err(|e| {
                format!(
                    "Failed to read CSV record {} for header repair '{}': {}",
                    record_index + 1,
                    source_path.display(),
                    e
                )
            })?;
            if record_index == 0 {
                continue;
            }
            csv_writer.write_record(&record).map_err(|e| {
                format!(
                    "Failed to write repaired CSV record {}: {}",
                    record_index + 1,
                    e
                )
            })?;
        }
        csv_writer
            .flush()
            .map_err(|e| format!("Failed to flush repaired CSV file: {}", e))?;

        let warning = format!(
            "CSV header repaired for '{}': {}. Using temporary normalized header for import.",
            source_path.display(),
            repair_reason
        );

        Ok(PreparedCsvImportSource {
            source_path: repaired_path.clone(),
            cleanup_path: Some(repaired_path),
            warning: Some(warning),
        })
    }

    fn detect_csv_header_repair_plan(
        &self,
        source_path: &Path,
    ) -> Result<Option<(Vec<String>, String)>, String> {
        let file = File::open(source_path)
            .map_err(|e| format!("Failed to open CSV '{}': {}", source_path.display(), e))?;
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_reader(file);

        let mut records: Vec<csv::StringRecord> = Vec::new();
        for record in reader.records().take(CSV_HEADER_REPAIR_SAMPLE_ROWS) {
            let record = record.map_err(|e| {
                format!(
                    "Failed to inspect CSV header for '{}': {}",
                    source_path.display(),
                    e
                )
            })?;
            records.push(record);
        }

        if records.len() < 2 {
            return Ok(None);
        }

        let header_record = &records[0];
        let data_widths: Vec<usize> = records.iter().skip(1).map(|row| row.len()).collect();
        let Some(expected_data_cols) = infer_csv_data_width(&data_widths) else {
            return Ok(None);
        };

        Ok(build_repaired_csv_header(header_record, expected_data_cols))
    }

    /// Import large CSV directly into DuckDB (streaming, never fully in memory)
    ///
    /// Called from data_import.rs for files with >= 500MB
    ///
    /// CRITICAL FIX: Renames columns to col-{idx} format to match frontend expectations.
    /// Original column names are preserved in ColumnInfo.display_name for UI display.
    pub fn import_large_csv(&self, dataset_id: &str, file_path: &str) -> Result<usize, String> {
        self.import_large_csv_internal(dataset_id, file_path, None)
    }

    pub fn import_large_csv_with_progress(
        &self,
        dataset_id: &str,
        file_path: &str,
        emit_fn: Box<dyn Fn(u32, &str) + Send + Sync>,
    ) -> Result<usize, String> {
        self.import_large_csv_internal(dataset_id, file_path, Some(emit_fn))
    }

    fn import_large_csv_internal(
        &self,
        dataset_id: &str,
        file_path: &str,
        emit_fn: Option<Box<dyn Fn(u32, &str) + Send + Sync>>,
    ) -> Result<usize, String> {
        let operation_guard = self.current_purge_generation();
        let prepared_csv = self.prepare_csv_import_source(file_path)?;
        let _temp_csv_guard = TempCsvGuard::new(prepared_csv.cleanup_path.clone());
        if let Some(warning) = prepared_csv.warning.as_ref() {
            log::warn!("{}", warning);
        }

        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        // Stage 1: Initializing (0%)
        if let Some(ref emit) = emit_fn {
            emit(0, "Initializing database...");
        }

        let db_path = self.resolve_duckdb_path_for_dataset(dataset_id);
        self.ensure_duckdb_parent_dir(&db_path)?;

        // Remove old DB file if exists
        let _ = std::fs::remove_file(&db_path);

        // Stage 2: Opening database (10%)
        if let Some(ref emit) = emit_fn {
            emit(10, "Opening database...");
        }

        let conn = self.open_duckdb_for_create(&db_path)?;

        // Configure DuckDB for large datasets
        let num_threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        conn.execute_batch(&format!(
            r#"
            SET memory_limit = '4GB';
            SET threads = {};
            SET preserve_insertion_order = true;
        "#,
            num_threads
        ))
        .map_err(|e| format!("Database configuration failed: {}", e))?;

        // Stage 3: Reading file schema (15%)
        if let Some(ref emit) = emit_fn {
            emit(15, "Reading file schema...");
        }

        let import_path = prepared_csv.source_path.to_string_lossy().to_string();
        let file_path_escaped = import_path.replace('\'', "''");
        let mut read_expr = format!(
            "read_csv_auto('{}', parallel = true, sample_size = 100000, ignore_errors = true, all_varchar = true)",
            file_path_escaped
        );
        let mut schema_query = format!("DESCRIBE SELECT * FROM {read_expr}");
        let mut stmt = match conn.prepare(&schema_query) {
            Ok(stmt) => stmt,
            Err(primary_err) => {
                // Fallback: force common CSV settings when auto-sniffing fails.
                read_expr = format!(
                    "read_csv_auto('{}', delim = ',', quote = '\"', escape = '\"', strict_mode = false, parallel = true, sample_size = 100000, ignore_errors = true, all_varchar = true)",
                    file_path_escaped
                );
                schema_query = format!("DESCRIBE SELECT * FROM {read_expr}");
                conn.prepare(&schema_query).map_err(|fallback_err| {
                    format!(
                        "Failed to read CSV schema: {} (fallback failed: {})",
                        primary_err, fallback_err
                    )
                })?
            }
        };
        let original_columns: Vec<ColumnInfo> = stmt
            .query_map([], |row| {
                Ok(ColumnInfo {
                    name: row.get::<_, String>(0)?,
                    display_name: row.get::<_, String>(0)?,
                    dtype: row.get::<_, String>(1)?,
                })
            })
            .map_err(|e| format!("Schema query failed: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect schema: {}", e))?;

        // Stage 4: Processing columns (75%)
        if let Some(ref emit) = emit_fn {
            emit(75, "Processing columns...");
        }

        // Step 3: Build column mapping (original name -> col-{idx})
        // and create the final table with renamed columns
        let mut columns: Vec<ColumnInfo> = Vec::new();
        let mut select_parts: Vec<String> =
            vec!["(row_number() OVER () - 1)::BIGINT as _row_index".to_string()];

        for (idx, orig_col) in original_columns.iter().enumerate() {
            let col_id = format!("col-{}", idx);
            let source_col = Self::quote_identifier(&orig_col.name);
            select_parts.push(format!(
                "{} AS {}",
                source_col,
                Self::quote_identifier(&col_id)
            ));
            columns.push(ColumnInfo {
                name: col_id,
                display_name: orig_col.name.clone(),
                dtype: orig_col.dtype.clone(),
            });
        }

        // Stage 5: Building table and indexes (90%)
        if let Some(ref emit) = emit_fn {
            emit(90, "Building table and indexes...");
        }

        // Step 4: Create final data table with col-{idx} column names
        let select_sql = select_parts.join(", ");
        conn.execute_batch(&format!(
            "CREATE TABLE data AS SELECT {} FROM {read_expr}; \
             CREATE INDEX idx_row_index ON data(_row_index);",
            select_sql,
            read_expr = read_expr
        ))
        .map_err(|e| format!("Database table creation failed: {}", e))?;

        // Get row count
        let row_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM data", [], |row| row.get(0))
            .map_err(|e| format!("Count failed: {}", e))?;
        drop(conn);

        // Register in datasets map
        let mut datasets = self.datasets.write().unwrap();
        self.ensure_guard_or_cleanup(operation_guard, "import_large_csv", &db_path)?;
        datasets.insert(
            namespaced_key.clone(),
            DatasetStorage::DuckDB {
                db_path: db_path.clone(),
                _table_name: "data".to_string(),
                columns,
                row_count: row_count as usize,
            },
        );
        drop(datasets);
        self.register_disk_cache_entry(&namespaced_key, &db_path);
        self.invalidate_column_stats_cache(dataset_id);

        log::info!(
            "Cache: Imported large CSV '{}' with {} rows into DuckDB (columns renamed to col-{{idx}})",
            dataset_id,
            row_count
        );
        self.schedule_column_stats_prewarm(&namespaced_key, row_count as usize);

        // Stage 6: Complete (100%)
        if let Some(ref emit) = emit_fn {
            emit(100, "Complete");
        }

        Ok(row_count as usize)
    }

    /// Import TSV file directly into DuckDB (streaming, never fully in memory)
    ///
    /// All-DuckDB Migration: Routes TSV files (and .txt files) to DuckDB.
    /// Uses DuckDB's read_csv_auto with delimiter='\t'.
    ///
    /// CRITICAL FIX: Renames columns to col-{idx} format to match frontend expectations.
    /// Original column names are preserved in ColumnInfo.display_name for UI display.
    pub fn import_large_tsv(&self, dataset_id: &str, file_path: &str) -> Result<usize, String> {
        self.import_large_tsv_internal(dataset_id, file_path, None)
    }

    pub fn import_large_tsv_with_progress(
        &self,
        dataset_id: &str,
        file_path: &str,
        emit_fn: Box<dyn Fn(u32, &str) + Send + Sync>,
    ) -> Result<usize, String> {
        self.import_large_tsv_internal(dataset_id, file_path, Some(emit_fn))
    }

    fn import_large_tsv_internal(
        &self,
        dataset_id: &str,
        file_path: &str,
        emit_fn: Option<Box<dyn Fn(u32, &str) + Send + Sync>>,
    ) -> Result<usize, String> {
        let operation_guard = self.current_purge_generation();
        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        // Stage 1: Initializing (0%)
        if let Some(ref emit) = emit_fn {
            emit(0, "Initializing database...");
        }

        let db_path = self.resolve_duckdb_path_for_dataset(dataset_id);
        self.ensure_duckdb_parent_dir(&db_path)?;

        // Remove old DB file if exists
        let _ = std::fs::remove_file(&db_path);

        // Stage 2: Opening database (10%)
        if let Some(ref emit) = emit_fn {
            emit(10, "Opening database...");
        }

        let conn = self.open_duckdb_for_create(&db_path)?;

        // Configure DuckDB for large datasets
        let num_threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        conn.execute_batch(&format!(
            r#"
            SET memory_limit = '4GB';
            SET threads = {};
            SET preserve_insertion_order = true;
        "#,
            num_threads
        ))
        .map_err(|e| format!("Database configuration failed: {}", e))?;

        // Stage 3: Reading file schema (15%)
        if let Some(ref emit) = emit_fn {
            emit(15, "Reading file schema...");
        }

        let file_path_escaped = file_path.replace('\'', "''");
        let read_expr = format!(
            "read_csv_auto('{}', delim = '\\t', parallel = true, sample_size = 100000, ignore_errors = true, all_varchar = true)",
            file_path_escaped
        );
        let schema_query = format!("DESCRIBE SELECT * FROM {read_expr}");
        let mut stmt = conn
            .prepare(&schema_query)
            .map_err(|e| format!("Failed to read TSV schema: {}", e))?;
        let original_columns: Vec<ColumnInfo> = stmt
            .query_map([], |row| {
                Ok(ColumnInfo {
                    name: row.get::<_, String>(0)?,
                    display_name: row.get::<_, String>(0)?,
                    dtype: row.get::<_, String>(1)?,
                })
            })
            .map_err(|e| format!("Schema query failed: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect schema: {}", e))?;

        // Stage 4: Processing columns (75%)
        if let Some(ref emit) = emit_fn {
            emit(75, "Processing columns...");
        }

        // Step 3: Build column mapping (original name -> col-{idx})
        // and create the final table with renamed columns
        let mut columns: Vec<ColumnInfo> = Vec::new();
        let mut select_parts: Vec<String> =
            vec!["(row_number() OVER () - 1)::BIGINT as _row_index".to_string()];

        for (idx, orig_col) in original_columns.iter().enumerate() {
            let col_id = format!("col-{}", idx);
            let source_col = Self::quote_identifier(&orig_col.name);
            select_parts.push(format!(
                "{} AS {}",
                source_col,
                Self::quote_identifier(&col_id)
            ));
            columns.push(ColumnInfo {
                name: col_id,
                display_name: orig_col.name.clone(),
                dtype: orig_col.dtype.clone(),
            });
        }

        let select_clause = select_parts.join(", ");
        conn.execute_batch(&format!(
            r#"
            CREATE TABLE data AS
            SELECT {} FROM {};
            CREATE INDEX idx_row_index ON data(_row_index);
        "#,
            select_clause, read_expr
        ))
        .map_err(|e| format!("Failed to rename columns: {}", e))?;

        // Stage 5: Finalizing (90%)
        if let Some(ref emit) = emit_fn {
            emit(90, "Finalizing...");
        }

        // Get row count
        let row_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM data", [], |row| row.get(0))
            .map_err(|e| format!("Failed to count rows: {}", e))?;
        drop(conn);

        // Stage 6: Complete (100%)
        if let Some(ref emit) = emit_fn {
            emit(100, "Complete");
        }

        // Store dataset entry with column metadata
        let mut datasets = self.datasets.write().unwrap();
        self.ensure_guard_or_cleanup(operation_guard, "import_large_tsv", &db_path)?;
        datasets.insert(
            namespaced_key.clone(),
            DatasetStorage::DuckDB {
                db_path: db_path.to_path_buf(),
                _table_name: "data".to_string(),
                columns,
                row_count: row_count as usize,
            },
        );
        drop(datasets);
        self.register_disk_cache_entry(&namespaced_key, &db_path);
        self.invalidate_column_stats_cache(dataset_id);

        log::info!(
            "Cache: Imported TSV '{}' with {} rows into DuckDB",
            dataset_id,
            row_count
        );
        self.schedule_column_stats_prewarm(&namespaced_key, row_count as usize);

        Ok(row_count as usize)
    }

    /// Import parsed rows directly into DuckDB
    ///
    /// All-DuckDB Migration: Used for Excel/Parquet imports where data is already parsed.
    /// Creates DuckDB table from in-memory rows, then clears memory.
    ///
    /// CRITICAL: Column IDs must already be in col-{idx} format.
    /// Display names are preserved in ColumnInfo.display_name.
    pub fn import_from_rows(
        &self,
        dataset_id: &str,
        columns: Vec<ColumnInfo>,
        rows: Vec<std::collections::HashMap<String, serde_json::Value>>,
    ) -> Result<usize, String> {
        let operation_guard = self.current_purge_generation();
        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        let db_path = self.resolve_duckdb_path_for_dataset(dataset_id);
        self.ensure_duckdb_parent_dir(&db_path)?;

        // Remove old DB file if exists
        let _ = std::fs::remove_file(&db_path);

        let conn =
            Connection::open(&db_path).map_err(|e| format!("Failed to create database: {}", e))?;

        // Configure DuckDB
        conn.execute_batch(
            r#"
            SET memory_limit = '4GB';
            SET threads = 4;
            SET preserve_insertion_order = true;
        "#,
        )
        .map_err(|e| format!("Database configuration failed: {}", e))?;

        // Step 1: Create table schema
        let mut column_defs: Vec<String> = vec!["_row_index BIGINT".to_string()];
        for col in &columns {
            // Use VARCHAR for all columns (Excel data is parsed)
            column_defs.push(format!("{} VARCHAR", Self::quote_identifier(&col.name)));
        }

        conn.execute_batch(&format!("CREATE TABLE data ({});", column_defs.join(", ")))
            .map_err(|e| format!("Failed to create table: {}", e))?;

        // Step 2: Bulk insert rows
        // Use direct SQL with escaped values instead of parameters
        // (DuckDB params! macro doesn't support dynamic arrays)
        if !rows.is_empty() {
            let column_names: Vec<String> = std::iter::once("_row_index".to_string())
                .chain(columns.iter().map(|c| Self::quote_identifier(&c.name)))
                .collect();

            for (row_idx, row) in rows.iter().enumerate() {
                // Build VALUES clause with escaped string literals
                let mut values: Vec<String> = vec![row_idx.to_string()];

                for col in &columns {
                    let val_str = match row.get(&col.name) {
                        Some(v) => match v {
                            serde_json::Value::String(s) => format!("'{}'", s.replace("'", "''")),
                            serde_json::Value::Number(n) => format!("'{}'", n),
                            serde_json::Value::Bool(b) => format!("'{}'", b),
                            serde_json::Value::Null => "''".to_string(),
                            _ => format!("'{}'", v.to_string().replace("'", "''")),
                        },
                        None => "''".to_string(),
                    };
                    values.push(val_str);
                }

                let insert_sql = format!(
                    "INSERT INTO data ({}) VALUES ({})",
                    column_names.join(", "),
                    values.join(", ")
                );

                conn.execute_batch(&insert_sql)
                    .map_err(|e| format!("Failed to insert row {}: {}", row_idx, e))?;
            }
        }

        let row_count = rows.len();

        conn.execute("CREATE INDEX idx_row_index ON data(_row_index)", [])
            .map_err(|e| format!("Failed to create row index: {}", e))?;

        // Store dataset entry with column metadata
        drop(conn);
        let mut datasets = self.datasets.write().unwrap();
        self.ensure_guard_or_cleanup(operation_guard, "import_from_rows", &db_path)?;
        datasets.insert(
            namespaced_key.clone(),
            DatasetStorage::DuckDB {
                db_path: db_path.to_path_buf(),
                _table_name: "data".to_string(),
                columns,
                row_count,
            },
        );
        drop(datasets);
        self.register_disk_cache_entry(&namespaced_key, &db_path);
        self.invalidate_column_stats_cache(dataset_id);

        log::info!(
            "Cache: Imported {} rows from parsed data into DuckDB for '{}'",
            row_count,
            dataset_id
        );
        self.schedule_column_stats_prewarm(&namespaced_key, row_count);

        Ok(row_count)
    }

    /// Create empty DuckDB table for manual data entry
    ///
    /// All-DuckDB Migration: Used when user creates a new blank dataset.
    /// Creates an empty table with the specified schema, ready for cell edits.
    pub fn create_empty_table(
        &self,
        dataset_id: &str,
        columns: Vec<ColumnInfo>,
    ) -> Result<(), String> {
        for col in &columns {
            validate_user_column_id(&col.name)?;
        }

        let operation_guard = self.current_purge_generation();
        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        let db_path = self.resolve_duckdb_path_for_dataset(dataset_id);
        self.ensure_duckdb_parent_dir(&db_path)?;

        // Remove old DB file if exists
        let _ = std::fs::remove_file(&db_path);

        let conn = self.open_duckdb_for_create(&db_path)?;

        // Configure DuckDB
        conn.execute_batch(
            r#"
            SET memory_limit = '4GB';
            SET threads = 4;
            SET preserve_insertion_order = true;
        "#,
        )
        .map_err(|e| format!("Database configuration failed: {}", e))?;

        // Create table schema
        let mut column_defs: Vec<String> = vec!["_row_index BIGINT".to_string()];
        for col in &columns {
            // Use VARCHAR for all columns (user-entered data)
            column_defs.push(format!("{} VARCHAR", Self::quote_identifier(&col.name)));
        }

        conn.execute_batch(&format!("CREATE TABLE data ({});", column_defs.join(", ")))
            .map_err(|e| format!("Failed to create table: {}", e))?;

        // Store dataset entry with column metadata
        drop(conn);
        let mut datasets = self.datasets.write().unwrap();
        self.ensure_guard_or_cleanup(operation_guard, "create_empty_table", &db_path)?;
        datasets.insert(
            namespaced_key.clone(),
            DatasetStorage::DuckDB {
                db_path: db_path.to_path_buf(),
                _table_name: "data".to_string(),
                columns,
                row_count: 0, // Empty table
            },
        );
        drop(datasets);
        self.register_disk_cache_entry(&namespaced_key, &db_path);
        self.invalidate_column_stats_cache(dataset_id);

        log::info!("Cache: Created empty DuckDB table for '{}'", dataset_id);

        Ok(())
    }

    /// Import Parquet file directly into DuckDB (streaming, never fully in memory)
    ///
    /// Parquet is ideal for large datasets:
    /// - Columnar format (DuckDB reads with near-zero overhead)
    /// - Compressed (10-50x smaller than CSV)
    /// - Schema embedded (no type inference needed)
    /// - Column pruning (only reads needed columns)
    ///
    /// CRITICAL FIX: Renames columns to col-{idx} format to match frontend expectations.
    /// Original column names are preserved in ColumnInfo.display_name for UI display.
    pub fn import_large_parquet(&self, dataset_id: &str, file_path: &str) -> Result<usize, String> {
        self.import_large_parquet_internal(dataset_id, file_path, None)
    }

    pub fn import_large_parquet_with_progress(
        &self,
        dataset_id: &str,
        file_path: &str,
        emit_fn: Box<dyn Fn(u32, &str) + Send + Sync>,
    ) -> Result<usize, String> {
        self.import_large_parquet_internal(dataset_id, file_path, Some(emit_fn))
    }

    fn import_large_parquet_internal(
        &self,
        dataset_id: &str,
        file_path: &str,
        emit_fn: Option<Box<dyn Fn(u32, &str) + Send + Sync>>,
    ) -> Result<usize, String> {
        let operation_guard = self.current_purge_generation();
        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        // Stage 1: Initializing (0%)
        if let Some(ref emit) = emit_fn {
            emit(0, "Initializing database...");
        }

        let db_path = self.resolve_duckdb_path_for_dataset(dataset_id);
        self.ensure_duckdb_parent_dir(&db_path)?;

        // Remove old DB file if exists
        let _ = std::fs::remove_file(&db_path);

        // Stage 2: Opening database (10%)
        if let Some(ref emit) = emit_fn {
            emit(10, "Opening database...");
        }

        let conn =
            Connection::open(&db_path).map_err(|e| format!("Failed to create database: {}", e))?;

        // Configure DuckDB for large datasets
        let num_threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        conn.execute_batch(&format!(
            r#"
            SET memory_limit = '4GB';
            SET threads = {};
            SET preserve_insertion_order = true;
        "#,
            num_threads
        ))
        .map_err(|e| format!("Database configuration failed: {}", e))?;

        // Stage 3: Reading file (15% - this is the longest operation)
        if let Some(ref emit) = emit_fn {
            emit(15, "Reading file...");
        }

        // Step 1: Create temporary table with original column names
        conn.execute_batch(&format!(
            "CREATE TEMP TABLE _import_temp AS SELECT * FROM read_parquet('{}');",
            file_path.replace('\'', "''")
        ))
        .map_err(|e| format!("Failed to read Parquet file: {}", e))?;

        // Stage 4: Processing columns (75%)
        if let Some(ref emit) = emit_fn {
            emit(75, "Processing columns...");
        }

        // Step 2: Get original column names and types
        let original_columns = self.get_table_columns_raw(&conn, "_import_temp")?;

        // Step 3: Build column mapping (original name -> col-{idx})
        // and create the final table with renamed columns
        let mut columns: Vec<ColumnInfo> = Vec::new();
        let mut select_parts: Vec<String> =
            vec!["(row_number() OVER () - 1)::BIGINT as _row_index".to_string()];

        for (idx, orig_col) in original_columns.iter().enumerate() {
            let col_id = format!("col-{}", idx);
            let source_col = Self::quote_identifier(&orig_col.name);
            select_parts.push(format!(
                "{} AS {}",
                source_col,
                Self::quote_identifier(&col_id)
            ));
            columns.push(ColumnInfo {
                name: col_id,
                display_name: orig_col.name.clone(),
                dtype: orig_col.dtype.clone(),
            });
        }

        // Stage 5: Building table and indexes (90%)
        if let Some(ref emit) = emit_fn {
            emit(90, "Building table and indexes...");
        }

        // Step 4: Create final data table with col-{idx} column names
        let select_sql = select_parts.join(", ");
        conn.execute_batch(&format!(
            "CREATE TABLE data AS SELECT {} FROM _import_temp; \
             CREATE INDEX idx_row_index ON data(_row_index); \
             DROP TABLE _import_temp;",
            select_sql
        ))
        .map_err(|e| format!("Database table creation failed: {}", e))?;

        // Get row count
        let row_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM data", [], |row| row.get(0))
            .map_err(|e| format!("Count failed: {}", e))?;
        drop(conn);

        // Register in datasets map
        let mut datasets = self.datasets.write().unwrap();
        self.ensure_guard_or_cleanup(operation_guard, "import_large_parquet", &db_path)?;
        datasets.insert(
            namespaced_key.clone(),
            DatasetStorage::DuckDB {
                db_path: db_path.clone(),
                _table_name: "data".to_string(),
                columns,
                row_count: row_count as usize,
            },
        );
        drop(datasets);
        self.register_disk_cache_entry(&namespaced_key, &db_path);
        self.invalidate_column_stats_cache(dataset_id);

        log::info!(
            "Cache: Imported Parquet '{}' with {} rows into DuckDB (columns renamed to col-{{idx}})",
            dataset_id,
            row_count
        );
        self.schedule_column_stats_prewarm(&namespaced_key, row_count as usize);

        // Stage 6: Complete (100%)
        if let Some(ref emit) = emit_fn {
            emit(100, "Complete");
        }

        Ok(row_count as usize)
    }

    // ============================================================================
    // PHASE 4: PROJECT-AWARE IMPORT METHODS
    // ============================================================================

    /// Import large CSV with project-scoped path (Phase 4: Collision Prevention)
    ///
    /// Creates DuckDB file in project-specific cache directory to prevent
    /// collisions when multiple projects have datasets with the same ID.
    ///
    /// # Arguments
    /// * `project_id` - Stable project UUID (from ProjectFile.projectId)
    /// * `dataset_id` - Dataset identifier
    /// * `file_path` - Path to CSV file
    pub fn import_large_csv_with_project(
        &self,
        project_id: &str,
        dataset_id: &str,
        file_path: &str,
    ) -> Result<usize, String> {
        self.import_large_csv_with_project_internal(project_id, dataset_id, file_path, None)
    }

    pub fn import_large_csv_with_project_with_progress(
        &self,
        project_id: &str,
        dataset_id: &str,
        file_path: &str,
        emit_fn: Box<dyn Fn(u32, &str) + Send + Sync>,
    ) -> Result<usize, String> {
        self.import_large_csv_with_project_internal(
            project_id,
            dataset_id,
            file_path,
            Some(emit_fn),
        )
    }

    fn import_large_csv_with_project_internal(
        &self,
        project_id: &str,
        dataset_id: &str,
        file_path: &str,
        emit_fn: Option<Box<dyn Fn(u32, &str) + Send + Sync>>,
    ) -> Result<usize, String> {
        let operation_guard = self.current_purge_generation();
        let prepared_csv = self.prepare_csv_import_source(file_path)?;
        let _temp_csv_guard = TempCsvGuard::new(prepared_csv.cleanup_path.clone());
        if let Some(warning) = prepared_csv.warning.as_ref() {
            log::warn!("{}", warning);
        }

        let namespaced_key = self.get_namespaced_key_explicit(project_id, dataset_id);
        // Stage 1: Initializing (0%)
        if let Some(ref emit) = emit_fn {
            emit(0, "Initializing database...");
        }

        // Create project cache directory
        let project_dir = self.get_project_cache_dir(project_id);
        std::fs::create_dir_all(&project_dir)
            .map_err(|e| format!("Failed to create project cache dir: {}", e))?;

        let db_path = self.get_duckdb_path_with_project(project_id, dataset_id);

        // Remove old DB file if exists
        let _ = std::fs::remove_file(&db_path);

        // Stage 2: Opening database (10%)
        if let Some(ref emit) = emit_fn {
            emit(10, "Opening database...");
        }

        let conn =
            Connection::open(&db_path).map_err(|e| format!("Failed to create database: {}", e))?;

        // Configure DuckDB for large datasets
        conn.execute_batch(
            r#"
            SET memory_limit = '4GB';
            SET threads = 4;
            SET preserve_insertion_order = true;
        "#,
        )
        .map_err(|e| format!("Database configuration failed: {}", e))?;

        // Stage 3: Reading file schema (15%)
        if let Some(ref emit) = emit_fn {
            emit(15, "Reading file schema...");
        }

        let import_path = prepared_csv.source_path.to_string_lossy().to_string();
        let file_path_escaped = import_path.replace('\'', "''");
        let mut read_expr = format!(
            "read_csv_auto('{}', parallel = true, sample_size = 100000, ignore_errors = true, all_varchar = true)",
            file_path_escaped
        );
        let mut schema_query = format!("DESCRIBE SELECT * FROM {read_expr}");
        let mut stmt = match conn.prepare(&schema_query) {
            Ok(stmt) => stmt,
            Err(primary_err) => {
                // Fallback: force common CSV settings when auto-sniffing fails.
                read_expr = format!(
                    "read_csv_auto('{}', delim = ',', quote = '\"', escape = '\"', strict_mode = false, parallel = true, sample_size = 100000, ignore_errors = true, all_varchar = true)",
                    file_path_escaped
                );
                schema_query = format!("DESCRIBE SELECT * FROM {read_expr}");
                conn.prepare(&schema_query).map_err(|fallback_err| {
                    format!(
                        "Failed to read CSV schema: {} (fallback failed: {})",
                        primary_err, fallback_err
                    )
                })?
            }
        };
        let original_columns: Vec<ColumnInfo> = stmt
            .query_map([], |row| {
                Ok(ColumnInfo {
                    name: row.get::<_, String>(0)?,
                    display_name: row.get::<_, String>(0)?,
                    dtype: row.get::<_, String>(1)?,
                })
            })
            .map_err(|e| format!("Schema query failed: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect schema: {}", e))?;

        // Stage 4: Processing columns (75%)
        if let Some(ref emit) = emit_fn {
            emit(75, "Processing columns...");
        }

        // Step 3: Build column mapping (original name -> col-{idx})
        let mut columns: Vec<ColumnInfo> = Vec::new();
        let mut select_parts: Vec<String> =
            vec!["(row_number() OVER () - 1)::BIGINT as _row_index".to_string()];

        for (idx, orig_col) in original_columns.iter().enumerate() {
            let col_id = format!("col-{}", idx);
            let source_col = Self::quote_identifier(&orig_col.name);
            select_parts.push(format!(
                "{} AS {}",
                source_col,
                Self::quote_identifier(&col_id)
            ));
            columns.push(ColumnInfo {
                name: col_id,
                display_name: orig_col.name.clone(),
                dtype: orig_col.dtype.clone(),
            });
        }

        // Stage 5: Building table and indexes (90%)
        if let Some(ref emit) = emit_fn {
            emit(90, "Building table and indexes...");
        }

        // Step 4: Create final data table with col-{idx} column names
        let select_sql = select_parts.join(", ");
        conn.execute_batch(&format!(
            "CREATE TABLE data AS SELECT {} FROM {read_expr}; \
             CREATE INDEX idx_row_index ON data(_row_index);",
            select_sql,
            read_expr = read_expr
        ))
        .map_err(|e| format!("Database table creation failed: {}", e))?;

        // Get row count
        let row_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM data", [], |row| row.get(0))
            .map_err(|e| format!("Count failed: {}", e))?;
        drop(conn);

        // Register in datasets map
        let mut datasets = self.datasets.write().unwrap();
        self.ensure_guard_or_cleanup(operation_guard, "import_large_csv_with_project", &db_path)?;
        datasets.insert(
            namespaced_key.clone(),
            DatasetStorage::DuckDB {
                db_path: db_path.clone(),
                _table_name: "data".to_string(),
                columns,
                row_count: row_count as usize,
            },
        );
        drop(datasets);
        self.register_disk_cache_entry(&namespaced_key, &db_path);
        self.invalidate_column_stats_cache(&namespaced_key);

        log::info!(
            "Cache: Imported large CSV '{}' (project: {}) with {} rows into DuckDB",
            dataset_id,
            project_id,
            row_count
        );
        self.schedule_column_stats_prewarm(&namespaced_key, row_count as usize);

        // Stage 6: Complete (100%)
        if let Some(ref emit) = emit_fn {
            emit(100, "Complete");
        }

        Ok(row_count as usize)
    }

    /// Import Parquet file with project-scoped path (Phase 4: Collision Prevention)
    ///
    /// Creates DuckDB file in project-specific cache directory.
    ///
    /// # Arguments
    /// * `project_id` - Stable project UUID (from ProjectFile.projectId)
    /// * `dataset_id` - Dataset identifier
    /// * `file_path` - Path to Parquet file
    pub fn import_large_parquet_with_project(
        &self,
        project_id: &str,
        dataset_id: &str,
        file_path: &str,
    ) -> Result<usize, String> {
        self.import_large_parquet_with_project_internal(project_id, dataset_id, file_path, None)
    }

    pub fn import_large_parquet_with_project_with_progress(
        &self,
        project_id: &str,
        dataset_id: &str,
        file_path: &str,
        emit_fn: Box<dyn Fn(u32, &str) + Send + Sync>,
    ) -> Result<usize, String> {
        self.import_large_parquet_with_project_internal(
            project_id,
            dataset_id,
            file_path,
            Some(emit_fn),
        )
    }

    fn import_large_parquet_with_project_internal(
        &self,
        project_id: &str,
        dataset_id: &str,
        file_path: &str,
        emit_fn: Option<Box<dyn Fn(u32, &str) + Send + Sync>>,
    ) -> Result<usize, String> {
        let operation_guard = self.current_purge_generation();
        let namespaced_key = self.get_namespaced_key_explicit(project_id, dataset_id);
        // Stage 1: Initializing (0%)
        if let Some(ref emit) = emit_fn {
            emit(0, "Initializing database...");
        }

        // Create project cache directory
        let project_dir = self.get_project_cache_dir(project_id);
        std::fs::create_dir_all(&project_dir)
            .map_err(|e| format!("Failed to create project cache dir: {}", e))?;

        let db_path = self.get_duckdb_path_with_project(project_id, dataset_id);

        // Remove old DB file if exists
        let _ = std::fs::remove_file(&db_path);

        // Stage 2: Opening database (10%)
        if let Some(ref emit) = emit_fn {
            emit(10, "Opening database...");
        }

        let conn =
            Connection::open(&db_path).map_err(|e| format!("Failed to create database: {}", e))?;

        // Configure DuckDB for large datasets
        conn.execute_batch(
            r#"
            SET memory_limit = '4GB';
            SET threads = 4;
            SET preserve_insertion_order = true;
        "#,
        )
        .map_err(|e| format!("Database configuration failed: {}", e))?;

        // Stage 3: Reading file (15% - this is the longest operation)
        if let Some(ref emit) = emit_fn {
            emit(15, "Reading file...");
        }

        // Step 1: Create temporary table with original column names
        conn.execute_batch(&format!(
            "CREATE TEMP TABLE _import_temp AS SELECT * FROM read_parquet('{}');",
            file_path.replace('\'', "''")
        ))
        .map_err(|e| format!("Failed to read Parquet file: {}", e))?;

        // Stage 4: Processing columns (75%)
        if let Some(ref emit) = emit_fn {
            emit(75, "Processing columns...");
        }

        // Step 2: Get original column names and types
        let original_columns = self.get_table_columns_raw(&conn, "_import_temp")?;

        // Step 3: Build column mapping (original name -> col-{idx})
        let mut columns: Vec<ColumnInfo> = Vec::new();
        let mut select_parts: Vec<String> =
            vec!["(row_number() OVER () - 1)::BIGINT as _row_index".to_string()];

        for (idx, orig_col) in original_columns.iter().enumerate() {
            let col_id = format!("col-{}", idx);
            let source_col = Self::quote_identifier(&orig_col.name);
            // Cast all columns to VARCHAR to preserve original values (no type coercion)
            let select_expr = format!("CAST({} AS VARCHAR)", source_col);
            select_parts.push(format!(
                "{} AS {}",
                select_expr,
                Self::quote_identifier(&col_id)
            ));
            columns.push(ColumnInfo {
                name: col_id,
                display_name: orig_col.name.clone(),
                dtype: "VARCHAR".to_string(), // Force VARCHAR for all columns
            });
        }

        // Stage 5: Building table and indexes (90%)
        if let Some(ref emit) = emit_fn {
            emit(90, "Building table and indexes...");
        }

        // Step 4: Create final data table with col-{idx} column names
        let select_sql = select_parts.join(", ");
        conn.execute_batch(&format!(
            "CREATE TABLE data AS SELECT {} FROM _import_temp; \
             CREATE INDEX idx_row_index ON data(_row_index); \
             DROP TABLE _import_temp;",
            select_sql
        ))
        .map_err(|e| format!("Database table creation failed: {}", e))?;

        // Get row count
        let row_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM data", [], |row| row.get(0))
            .map_err(|e| format!("Count failed: {}", e))?;
        drop(conn);

        // Register in datasets map
        let mut datasets = self.datasets.write().unwrap();
        self.ensure_guard_or_cleanup(
            operation_guard,
            "import_large_parquet_with_project",
            &db_path,
        )?;
        datasets.insert(
            namespaced_key.clone(),
            DatasetStorage::DuckDB {
                db_path: db_path.clone(),
                _table_name: "data".to_string(),
                columns,
                row_count: row_count as usize,
            },
        );
        drop(datasets);
        self.register_disk_cache_entry(&namespaced_key, &db_path);
        self.invalidate_column_stats_cache(&namespaced_key);

        log::info!(
            "Cache: Imported Parquet '{}' (project: {}) with {} rows into DuckDB",
            dataset_id,
            project_id,
            row_count
        );
        self.schedule_column_stats_prewarm(&namespaced_key, row_count as usize);

        // Stage 6: Complete (100%)
        if let Some(ref emit) = emit_fn {
            emit(100, "Complete");
        }

        Ok(row_count as usize)
    }

    /// Register an existing DuckDB file without re-import
    /// Used when loading projects with saved duckdbPath
    /// DEPRECATED: Use register_existing_duckdb_with_project for project isolation
    ///
    /// # Arguments
    /// * `dataset_id` - Unique identifier for the dataset
    /// * `duckdb_path` - Path to existing DuckDB file
    /// * `columns_override` - Optional map of column_id -> display_name overrides
    ///
    /// # Returns
    /// RegisterDuckdbResult with dataset info
    pub fn register_existing_duckdb(
        &self,
        dataset_id: &str,
        duckdb_path: &str,
        columns_override: Option<std::collections::HashMap<String, String>>,
    ) -> Result<crate::modules::commands::cache_commands::RegisterDuckdbResult, String> {
        // Use active project for namespacing
        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        self.register_existing_duckdb_internal(
            &namespaced_key,
            dataset_id,
            duckdb_path,
            columns_override,
        )
    }

    /// Register existing DuckDB with explicit project ID (Phase B: Project Isolation)
    /// Use this for project load operations to ensure proper namespacing
    pub fn register_existing_duckdb_with_project(
        &self,
        project_id: &str,
        dataset_id: &str,
        duckdb_path: &str,
        columns_override: Option<std::collections::HashMap<String, String>>,
    ) -> Result<crate::modules::commands::cache_commands::RegisterDuckdbResult, String> {
        let namespaced_key = self.get_namespaced_key_explicit(project_id, dataset_id);
        self.register_existing_duckdb_internal(
            &namespaced_key,
            dataset_id,
            duckdb_path,
            columns_override,
        )
    }

    /// Internal implementation for register_existing_duckdb
    fn register_existing_duckdb_internal(
        &self,
        namespaced_key: &str,
        dataset_id: &str,
        duckdb_path: &str,
        columns_override: Option<std::collections::HashMap<String, String>>,
    ) -> Result<crate::modules::commands::cache_commands::RegisterDuckdbResult, String> {
        let operation_guard = self.current_purge_generation();
        use std::path::Path;

        let db_path = Path::new(duckdb_path);
        if !db_path.exists() {
            return Err(format!("Data file not found: {}", duckdb_path));
        }
        let db_meta = fs::metadata(db_path)
            .map_err(|e| format!("Failed to read data file metadata '{}': {}", duckdb_path, e))?;
        if db_meta.len() == 0 {
            return Err(format!("Data file is empty: {}", duckdb_path));
        }
        let mut conn: Option<Connection> = None;
        for (attempt_idx, delay_ms) in CONNECTION_OPEN_RETRY_DELAYS_MS.iter().enumerate() {
            if *delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(*delay_ms));
            }

            let _open_guard = self.acquire_connection_open_slot(
                namespaced_key,
                dataset_id,
                Duration::from_secs(CONNECTION_OPEN_SINGLE_FLIGHT_WAIT_TIMEOUT_SECS),
            )?;

            match Connection::open(db_path) {
                Ok(opened) => {
                    if attempt_idx > 0 {
                        log::warn!(
                            "[duckdb][register] Recovered open for dataset '{}' (key: '{}') at '{}' after {} retries",
                            dataset_id,
                            namespaced_key,
                            duckdb_path,
                            attempt_idx
                        );
                    }
                    conn = Some(opened);
                    break;
                }
                Err(err) => {
                    let err_string = err.to_string();
                    let is_last_attempt = attempt_idx + 1 == CONNECTION_OPEN_RETRY_DELAYS_MS.len();
                    if is_last_attempt {
                        self.record_connection_open_failure(namespaced_key);
                        return Err(format!("Failed to open data file: {}", err_string));
                    }
                    log::warn!(
                        "[duckdb][register] Open failure for dataset '{}' (key: '{}') at '{}': {} (retrying)",
                        dataset_id,
                        namespaced_key,
                        duckdb_path,
                        err_string
                    );
                }
            }
        }
        let conn = conn.ok_or_else(|| {
            format!(
                "Failed to open data file '{}': unknown open error",
                duckdb_path
            )
        })?;

        // Verify schema exists
        let table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM information_schema.tables WHERE table_name = 'data'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to verify schema: {}", e))?;
        if !table_exists {
            return Err("Data file missing 'data' table".to_string());
        }

        let row_index_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM information_schema.columns WHERE table_name = 'data' AND column_name = '_row_index'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to verify _row_index column: {}", e))?;
        if !row_index_exists {
            return Err("Data file missing '_row_index' column".to_string());
        }

        let hidden_columns = Self::get_hidden_columns(&conn)?;
        let mut columns = self.get_table_columns_raw(&conn, "data")?;
        columns.retain(|col| !hidden_columns.contains(&col.name));
        if let Some(map) = columns_override {
            for col in columns.iter_mut() {
                if let Some(display_name) = map.get(&col.name) {
                    col.display_name = display_name.clone();
                }
            }
        }

        let row_count: usize = conn
            .query_row("SELECT COUNT(*) FROM data", [], |row| row.get(0))
            .map_err(|e| format!("Failed to count rows: {}", e))?;
        self.record_connection_open_success(namespaced_key);

        drop(conn);

        let mut datasets = self.datasets.write().unwrap();
        self.ensure_guard_current(operation_guard, "register_existing_duckdb")?;
        if let Some(existing_storage) = datasets.get(namespaced_key) {
            if let DatasetStorage::DuckDB {
                db_path: existing_path,
                ..
            } = existing_storage
            {
                let existing_norm = Self::normalize_index_path(existing_path);
                let incoming_norm = Self::normalize_index_path(db_path);
                if existing_norm == incoming_norm {
                    return Ok(
                        crate::modules::commands::cache_commands::RegisterDuckdbResult {
                            id: dataset_id.to_string(),
                            row_count,
                            columns: columns
                                .into_iter()
                                .filter(|c| c.name != "_row_index")
                                .map(|c| {
                                    crate::modules::commands::cache_commands::RegisterDuckdbColumn {
                                        id: c.name,
                                        name: c.display_name,
                                        dtype: Some(c.dtype),
                                    }
                                })
                                .collect(),
                        },
                    );
                }
            }
            return Err(format!(
                "Dataset '{}' already registered (key: {})",
                dataset_id, namespaced_key
            ));
        }

        datasets.insert(
            namespaced_key.to_string(),
            DatasetStorage::DuckDB {
                db_path: db_path.to_path_buf(),
                _table_name: "data".to_string(),
                columns: columns.clone(),
                row_count,
            },
        );
        drop(datasets);
        self.register_disk_cache_entry(namespaced_key, db_path);
        self.invalidate_column_stats_cache(namespaced_key);

        // Connection will be created lazily by get_connection() when needed

        log::info!(
            "Cache: Registered existing DuckDB '{}' (key: {}) with {} rows from {}",
            dataset_id,
            namespaced_key,
            row_count,
            duckdb_path
        );

        Ok(
            crate::modules::commands::cache_commands::RegisterDuckdbResult {
                id: dataset_id.to_string(),
                row_count,
                columns: columns
                    .into_iter()
                    .filter(|c| c.name != "_row_index")
                    .map(
                        |c| crate::modules::commands::cache_commands::RegisterDuckdbColumn {
                            id: c.name,
                            name: c.display_name,
                            dtype: Some(c.dtype),
                        },
                    )
                    .collect(),
            },
        )
    }

    /// Remove dataset from cache (uses active project for namespacing)
    /// Phase B: Uses namespaced key; returns false if no active project
    pub fn remove_dataset(&self, dataset_id: &str) -> bool {
        match self.get_namespaced_key(dataset_id) {
            Ok(namespaced_key) => self.remove_dataset_internal(&namespaced_key, dataset_id),
            Err(e) => {
                log::warn!("remove_dataset failed: {}", e);
                false
            }
        }
    }

    /// Remove dataset with explicit project ID (Phase B: Project Isolation)
    /// Use this during project load/cleanup operations
    pub fn remove_dataset_with_project(&self, project_id: &str, dataset_id: &str) -> bool {
        let namespaced_key = self.get_namespaced_key_explicit(project_id, dataset_id);
        self.remove_dataset_internal(&namespaced_key, dataset_id)
    }

    /// Clear cache artifacts associated with the provided project under AppData cache.
    /// Safety rule: never auto-delete project-adjacent data files.
    pub fn clear_current_project_cache(&self, project_id: &str) -> CacheCleanupSummary {
        if !Self::is_safe_project_id(project_id) {
            log::warn!("Cache cleanup: rejected unsafe project ID '{}'", project_id);
            return CacheCleanupSummary {
                removed_files: 0,
                removed_bytes: 0,
                skipped_active_files: 0,
            };
        }
        self.bump_purge_generation();

        let summary = self.cleanup_unsaved_app_cache_internal(Some(project_id), true);
        self.remove_disk_cache_entries_for_project_prefix(project_id);
        self.cleanup_empty_app_cache_dirs();
        self.reconcile_disk_cache_index();
        summary
    }

    /// Clear unsaved/appdata cache files while preserving active in-use datasets.
    pub fn clear_unsaved_app_cache(&self) -> CacheCleanupSummary {
        self.bump_purge_generation();
        // User-invoked clear should respect explicit intent and remove all eligible
        // AppData cache files immediately (active/in-use files are still protected).
        let summary = self.cleanup_unsaved_app_cache_internal(None, true);
        self.cleanup_empty_app_cache_dirs();
        self.reconcile_disk_cache_index();
        summary
    }

    /// Aggressively clear all unsaved/appdata cache files while preserving active in-use datasets.
    pub fn clear_all_app_cache(&self) -> CacheCleanupSummary {
        self.bump_purge_generation();
        let summary = self.cleanup_unsaved_app_cache_internal(None, true);
        self.cleanup_empty_app_cache_dirs();
        self.reconcile_disk_cache_index();
        summary
    }

    /// Return local cache health metrics for UI disk-pressure prompts.
    pub fn get_cache_health_summary(&self) -> CacheHealthSummary {
        let roots = self.get_storage_scan_roots();
        let files = self.read_disk_cache_files_for_roots(&roots);

        let mut app_cache_bytes: u64 = 0;
        let mut project_data_bytes: u64 = 0;
        for file in files {
            if self.is_project_data_path(&file.path) {
                project_data_bytes += file.size_bytes;
            } else {
                app_cache_bytes += file.size_bytes;
            }
        }
        let cache_bytes = app_cache_bytes + project_data_bytes;

        let available_disk_bytes = Self::min_available_space_for_roots(&roots);

        CacheHealthSummary {
            app_cache_bytes,
            project_data_bytes,
            cache_bytes,
            available_disk_bytes,
        }
    }

    /// Internal remove implementation using namespaced key
    fn remove_dataset_internal(&self, namespaced_key: &str, dataset_id: &str) -> bool {
        // First, remove connection from pool (must be done before removing dataset)
        self.remove_connection(namespaced_key);

        let storage = {
            let mut datasets = self.datasets.write().unwrap();
            datasets.remove(namespaced_key)
        };

        if let Some(storage) = storage {
            // Clean up DuckDB file if applicable (outside dataset lock)
            if let DatasetStorage::DuckDB { db_path, .. } = storage {
                if self.is_project_data_path(&db_path) {
                    log::info!(
                        "Cache: Retaining project data file for removed dataset '{}' (key: {}): {}",
                        dataset_id,
                        namespaced_key,
                        db_path.display()
                    );
                } else {
                    let _ = std::fs::remove_file(&db_path);
                    self.remove_disk_cache_entry_for_path(&db_path);
                }
            }

            // Clear any pending overlay edits (use namespaced key)
            let mut overlay = self.overlay.write().unwrap();
            overlay.retain(|(ds_id, _, _), _| ds_id != namespaced_key);

            // Phase 3: Invalidate row-range cache for this dataset
            drop(overlay); // Release lock before invalidation
            self.invalidate_row_range_cache(namespaced_key);
            self.invalidate_column_stats_cache(namespaced_key);

            log::info!(
                "Cache: Removed dataset '{}' (key: {})",
                dataset_id,
                namespaced_key
            );
            true
        } else {
            false
        }
    }

    /// Clear all datasets
    pub fn clear(&self) {
        self.bump_purge_generation();
        // Clear connection pool first
        {
            let mut conns = self.connections.write().unwrap();
            conns.clear();
        }

        let mut datasets = self.datasets.write().unwrap();

        // Delete DuckDB files for unsaved datasets only; keep project data files intact.
        for storage in datasets.values() {
            if let DatasetStorage::DuckDB { db_path, .. } = storage {
                if self.is_project_data_path(db_path) {
                    continue;
                }
                let _ = std::fs::remove_file(db_path);
                self.remove_disk_cache_entry_for_path(db_path);
            }
        }

        datasets.clear();

        // Clear overlay
        let mut overlay = self.overlay.write().unwrap();
        overlay.clear();

        // Phase 3: Clear row-range cache
        drop(overlay); // Release lock before invalidation
        self.row_range_cache.invalidate_all();
        self.column_stats_cache.write().unwrap().clear();
        self.cleanup_empty_app_cache_dirs();
        self.reconcile_disk_cache_index();

        log::info!("Cache: Cleared all datasets");
    }

    /// Check if dataset exists (uses active project for namespacing)
    /// Phase B: Uses namespaced key; returns false if no active project
    pub fn has_dataset(&self, dataset_id: &str) -> bool {
        match self.get_namespaced_key(dataset_id) {
            Ok(namespaced_key) => {
                let datasets = self.datasets.read().unwrap();
                datasets.contains_key(&namespaced_key)
            }
            Err(e) => {
                log::warn!("has_dataset failed: {}", e);
                false
            }
        }
    }

    /// Check if dataset exists with explicit project ID (Phase B: Project Isolation)
    pub fn has_dataset_with_project(&self, project_id: &str, dataset_id: &str) -> bool {
        let namespaced_key = self.get_namespaced_key_explicit(project_id, dataset_id);
        let datasets = self.datasets.read().unwrap();
        datasets.contains_key(&namespaced_key)
    }

    /// Get row count (uses active project for namespacing)
    /// Phase B: Uses namespaced key; returns None if no active project
    pub fn get_row_count(&self, dataset_id: &str) -> Option<usize> {
        let namespaced_key = match self.get_namespaced_key(dataset_id) {
            Ok(key) => key,
            Err(e) => {
                log::warn!("get_row_count failed: {}", e);
                return None;
            }
        };
        let datasets = self.datasets.read().unwrap();
        match datasets.get(&namespaced_key)? {
            DatasetStorage::InMemory { rows } => Some(rows.len()),
            DatasetStorage::DuckDB { row_count, .. } => Some(*row_count),
        }
    }

    /// Get column names (IDs) for a dataset (uses active project for namespacing)
    /// Returns col-{idx} format IDs for DuckDB datasets
    /// Phase B: Uses namespaced key; returns None if no active project
    pub fn get_column_names(&self, dataset_id: &str) -> Option<Vec<String>> {
        let namespaced_key = match self.get_namespaced_key(dataset_id) {
            Ok(key) => key,
            Err(e) => {
                log::warn!("get_column_names failed: {}", e);
                return None;
            }
        };
        let datasets = self.datasets.read().unwrap();
        match datasets.get(&namespaced_key)? {
            DatasetStorage::InMemory { rows } => rows.first().map(|r| r.keys().cloned().collect()),
            DatasetStorage::DuckDB { columns, .. } => {
                Some(
                    columns
                        .iter()
                        .filter(|c| c.name != "_row_index")
                        .map(|c| c.name.clone()) // Returns col-{idx} IDs
                        .collect(),
                )
            }
        }
    }

    /// Get full column metadata (ID + display name) for a dataset (uses active project for namespacing)
    /// Returns tuples of (column_id, display_name) for DuckDB datasets
    /// For in-memory datasets, ID and display_name are the same
    /// Phase B: Uses namespaced key; returns None if no active project
    pub fn get_column_metadata(&self, dataset_id: &str) -> Option<Vec<(String, String)>> {
        let namespaced_key = match self.get_namespaced_key(dataset_id) {
            Ok(key) => key,
            Err(e) => {
                log::warn!("get_column_metadata failed: {}", e);
                return None;
            }
        };
        let datasets = self.datasets.read().unwrap();
        match datasets.get(&namespaced_key)? {
            DatasetStorage::InMemory { rows } => {
                // In-memory: column name is both ID and display name
                rows.first()
                    .map(|r| r.keys().map(|k| (k.clone(), k.clone())).collect())
            }
            DatasetStorage::DuckDB { columns, .. } => Some(
                columns
                    .iter()
                    .filter(|c| c.name != "_row_index")
                    .map(|c| (c.name.clone(), c.display_name.clone()))
                    .collect(),
            ),
        }
    }

    /// Get persisted/authoritative column IDs for a dataset.
    /// In-memory datasets return a union of keys across all rows.
    /// DuckDB datasets query physical schema from pragma_table_info('data').
    pub fn get_persisted_column_ids(&self, dataset_id: &str) -> Option<Vec<String>> {
        let namespaced_key = match self.get_namespaced_key(dataset_id) {
            Ok(key) => key,
            Err(e) => {
                log::warn!("get_persisted_column_ids failed: {}", e);
                return None;
            }
        };

        let maybe_in_memory_rows = {
            let datasets = self.datasets.read().unwrap();
            match datasets.get(&namespaced_key)? {
                DatasetStorage::InMemory { rows } => Some(rows.clone()),
                DatasetStorage::DuckDB { .. } => None,
            }
        };

        if let Some(rows) = maybe_in_memory_rows {
            let mut ids = BTreeSet::new();
            for row in rows {
                for key in row.keys() {
                    ids.insert(key.clone());
                }
            }
            return Some(ids.into_iter().collect());
        }

        let conn_arc = match self.get_connection(&namespaced_key) {
            Ok(connection) => connection,
            Err(error) => {
                log::warn!(
                    "get_persisted_column_ids failed to open connection for '{}': {}",
                    namespaced_key,
                    error
                );
                return None;
            }
        };
        let conn = conn_arc.lock().unwrap();

        let mut stmt = match conn.prepare(
            "SELECT name FROM pragma_table_info('data') WHERE name <> '_row_index' ORDER BY cid",
        ) {
            Ok(stmt) => stmt,
            Err(error) => {
                log::warn!("get_persisted_column_ids prepare failed: {}", error);
                return None;
            }
        };

        let rows = match stmt.query_map([], |row| row.get::<_, String>(0)) {
            Ok(rows) => rows,
            Err(error) => {
                log::warn!("get_persisted_column_ids query failed: {}", error);
                return None;
            }
        };

        let mut ids = Vec::new();
        for row in rows {
            match row {
                Ok(name) => ids.push(name),
                Err(error) => {
                    log::warn!("get_persisted_column_ids row decode failed: {}", error);
                    return None;
                }
            }
        }
        Some(ids)
    }

    // ========================================================================
    // ROW ACCESS (Grid Pagination)
    // ========================================================================

    /// Get rows in range [start, end) for grid display (uses active project for namespacing)
    /// Uses 0-based indexing to match grid row numbers
    ///
    /// SAME SIGNATURE as current CacheManager.
    /// Internally routes to HashMap slice or DuckDB query.
    /// Phase B: Uses namespaced key; returns None if no active project
    pub fn get_rows_range(
        &self,
        dataset_id: &str,
        start_row: usize,
        end_row: usize,
    ) -> Option<Vec<HashMap<String, Value>>> {
        let namespaced_key = match self.resolve_namespaced_key(dataset_id) {
            Ok(key) => key,
            Err(e) => {
                log::warn!("get_rows_range failed: {}", e);
                return None;
            }
        };

        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key)? {
            DatasetStorage::InMemory { rows } => {
                // Current behavior exactly
                let actual_end = end_row.min(rows.len());
                if start_row >= actual_end {
                    return Some(Vec::new());
                }
                Some(rows[start_row..actual_end].to_vec())
            }

            DatasetStorage::DuckDB { columns, .. } => {
                // Build column list (exclude internal _row_index from output)
                let col_names: Vec<String> = columns
                    .iter()
                    .map(|c| c.name.clone())
                    .filter(|n| n != "_row_index")
                    .collect();

                // Use quoted identifiers for column names
                let col_sql: String = col_names
                    .iter()
                    .map(|n| Self::quote_identifier(n))
                    .collect::<Vec<_>>()
                    .join(", ");

                drop(datasets); // Release read lock before getting connection

                // Phase 3: Check if overlay has pending edits in this range
                // If overlay is clean for this range, we can use/populate cache
                // Phase B: Use namespaced key for overlay lookup
                let overlay = self.overlay.read().unwrap();
                let has_overlay_in_range = overlay.keys().any(|(ds_id, row_idx, _)| {
                    ds_id == &namespaced_key
                        && *row_idx >= start_row as i64
                        && *row_idx < end_row as i64
                });

                // Phase 3: Check row-range cache first (only if no overlay edits in range)
                // Phase B: Use namespaced key for cache lookup
                let cache_key = (namespaced_key.clone(), start_row, end_row);
                if !has_overlay_in_range {
                    if let Some(cached_rows) = self.row_range_cache.get(&cache_key) {
                        return Some(cached_rows);
                    }
                }

                drop(overlay); // Release overlay lock before DuckDB query

                // Use pooled connection (Phase B: Use namespaced key)
                let conn_arc = self.get_connection(&namespaced_key).ok()?;
                let conn = conn_arc.lock().unwrap();
                if Self::ensure_row_order_table(&conn).is_err() {
                    return None;
                }

                let sql = format!(
                    "SELECT ro.physical_row, {} \
                     FROM {row_order} ro \
                     JOIN data ON data._row_index = ro.physical_row \
                     ORDER BY ro.sort_key \
                     LIMIT ? OFFSET ?",
                    col_sql,
                    row_order = ROW_ORDER_TABLE
                );

                let mut stmt = conn.prepare(&sql).ok()?;
                let overlay = self.overlay.read().unwrap();
                let mut overlay_by_row: HashMap<i64, Vec<(String, Value)>> = HashMap::new();
                for ((ds_id, row_idx, col_name), value) in overlay.iter() {
                    if ds_id != &namespaced_key {
                        continue;
                    }
                    if *row_idx < start_row as i64 || *row_idx >= end_row as i64 {
                        continue;
                    }
                    overlay_by_row
                        .entry(*row_idx)
                        .or_default()
                        .push((col_name.clone(), value.clone()));
                }
                drop(overlay);

                let mut rows_by_index: HashMap<i64, HashMap<String, Value>> = stmt
                    .query_map(
                        params![end_row.saturating_sub(start_row) as i64, start_row as i64],
                        |row| {
                            let physical_row: i64 = row.get(0)?;
                            let mut map = HashMap::new();

                            for (i, col_name) in col_names.iter().enumerate() {
                                // Get from DuckDB schema columns first.
                                let value = Self::duckdb_value_to_json_static(row, i + 1);
                                map.insert(col_name.clone(), value);
                            }

                            // Apply overlay edits for this row after schema values:
                            // - Overrides schema-backed columns with pending edits.
                            // - Adds non-schema columns (e.g., buffer columns edited before flush).
                            Ok((physical_row, map))
                        },
                    )
                    .ok()?
                    .enumerate()
                    .filter_map(|(offset, result)| {
                        let (_, mut map) = result.ok()?;
                        let logical_row = (start_row + offset) as i64;
                        if let Some(entries) = overlay_by_row.get(&logical_row) {
                            for (col_name, value) in entries {
                                map.insert(col_name.clone(), value.clone());
                            }
                        }

                        Some((logical_row, map))
                    })
                    .collect();

                let mut synthesized_overlay_only_rows = false;
                for (row_idx, entries) in overlay_by_row.iter() {
                    if rows_by_index.contains_key(row_idx) {
                        continue;
                    }

                    synthesized_overlay_only_rows = true;
                    let mut map = HashMap::new();
                    for col_name in col_names.iter() {
                        map.insert(col_name.clone(), Value::Null);
                    }
                    for (col_name, value) in entries {
                        map.insert(col_name.clone(), value.clone());
                    }
                    rows_by_index.insert(*row_idx, map);
                }

                let rows: Vec<HashMap<String, Value>> = if synthesized_overlay_only_rows {
                    // Preserve dense row-offset mapping (start_row + i) expected by grid consumers.
                    // When an overlay-only row exists in the range, fill gaps with empty rows so
                    // synthesized tail rows don't shift upward.
                    let mut dense_rows: Vec<HashMap<String, Value>> =
                        Vec::with_capacity(end_row.saturating_sub(start_row));
                    for row_idx in start_row as i64..end_row as i64 {
                        dense_rows.push(rows_by_index.remove(&row_idx).unwrap_or_default());
                    }
                    dense_rows
                } else {
                    let mut ordered_rows: Vec<(i64, HashMap<String, Value>)> =
                        rows_by_index.into_iter().collect();
                    ordered_rows.sort_by_key(|(row_idx, _)| *row_idx);
                    ordered_rows.into_iter().map(|(_, row)| row).collect()
                };

                // Phase 3: Cache the result if no overlay edits affected the range
                // Re-check overlay in case edits happened during query.
                // Phase B: Use namespaced key for overlay check
                let overlay = self.overlay.read().unwrap();
                let has_overlay_now = overlay.keys().any(|(ds_id, row_idx, _)| {
                    ds_id == &namespaced_key
                        && *row_idx >= start_row as i64
                        && *row_idx < end_row as i64
                });
                if !has_overlay_now {
                    self.row_range_cache.insert(cache_key, rows.clone());
                }

                Some(rows)
            }
        }
    }

    pub fn get_rows_range_columns(
        &self,
        dataset_id: &str,
        start_row: usize,
        end_row: usize,
        column_ids: &[String],
    ) -> Result<Vec<HashMap<String, Value>>, String> {
        if column_ids.is_empty() {
            return Err("Column-subset row read requires at least one column".to_string());
        }
        for column_id in column_ids {
            validate_user_column_id(column_id)?;
        }

        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        let datasets = self.datasets.read().unwrap();

        match datasets
            .get(&namespaced_key)
            .ok_or_else(|| format!("Dataset '{}' not found", dataset_id))?
        {
            DatasetStorage::InMemory { rows } => {
                let actual_end = end_row.min(rows.len());
                if start_row >= actual_end {
                    return Ok(Vec::new());
                }
                Ok(rows[start_row..actual_end]
                    .iter()
                    .map(|row| {
                        column_ids
                            .iter()
                            .map(|column_id| {
                                (
                                    column_id.clone(),
                                    row.get(column_id).cloned().unwrap_or(Value::Null),
                                )
                            })
                            .collect()
                    })
                    .collect())
            }
            DatasetStorage::DuckDB { columns, .. } => {
                let existing_columns: HashSet<String> = columns
                    .iter()
                    .map(|column| column.name.clone())
                    .filter(|name| name != "_row_index")
                    .collect();
                for column_id in column_ids {
                    if !existing_columns.contains(column_id) {
                        return Err(format!("Column '{}' not found", column_id));
                    }
                }

                let col_sql = column_ids
                    .iter()
                    .map(|column_id| Self::quote_identifier(column_id))
                    .collect::<Vec<_>>()
                    .join(", ");

                drop(datasets);

                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();
                Self::ensure_row_order_table(&conn)?;

                let sql = format!(
                    "SELECT ro.physical_row, {} \
                     FROM {row_order} ro \
                     JOIN data ON data._row_index = ro.physical_row \
                     ORDER BY ro.sort_key \
                     LIMIT ? OFFSET ?",
                    col_sql,
                    row_order = ROW_ORDER_TABLE
                );
                let mut stmt = conn
                    .prepare(&sql)
                    .map_err(|e| format!("Failed to prepare column-subset row query: {}", e))?;

                let mut rows_by_index: HashMap<i64, HashMap<String, Value>> = stmt
                    .query_map(
                        params![end_row.saturating_sub(start_row) as i64, start_row as i64],
                        |row| {
                            let physical_row: i64 = row.get(0)?;
                            let mut map = HashMap::new();
                            for (index, column_id) in column_ids.iter().enumerate() {
                                let value = Self::duckdb_value_to_json_static(row, index + 1);
                                map.insert(column_id.clone(), value);
                            }
                            Ok((physical_row, map))
                        },
                    )
                    .map_err(|e| format!("Failed to query column-subset rows: {}", e))?
                    .enumerate()
                    .filter_map(|(offset, result)| {
                        let (_, map) = result.ok()?;
                        Some(((start_row + offset) as i64, map))
                    })
                    .collect();

                let overlay = self.overlay.read().unwrap();
                let mut overlay_by_row: HashMap<i64, Vec<(String, Value)>> = HashMap::new();
                let requested_columns: HashSet<&String> = column_ids.iter().collect();
                for ((ds_id, row_idx, col_name), value) in overlay.iter() {
                    if ds_id != &namespaced_key {
                        continue;
                    }
                    if *row_idx < start_row as i64 || *row_idx >= end_row as i64 {
                        continue;
                    }
                    if !requested_columns.contains(col_name) {
                        continue;
                    }
                    overlay_by_row
                        .entry(*row_idx)
                        .or_default()
                        .push((col_name.clone(), value.clone()));
                }
                drop(overlay);

                let mut synthesized_overlay_only_rows = false;
                for (row_idx, entries) in overlay_by_row {
                    let row = rows_by_index.entry(row_idx).or_insert_with(|| {
                        synthesized_overlay_only_rows = true;
                        column_ids
                            .iter()
                            .map(|column_id| (column_id.clone(), Value::Null))
                            .collect()
                    });
                    for (column_id, value) in entries {
                        row.insert(column_id, value);
                    }
                }

                if synthesized_overlay_only_rows {
                    let mut dense_rows = Vec::with_capacity(end_row.saturating_sub(start_row));
                    for row_idx in start_row as i64..end_row as i64 {
                        dense_rows.push(rows_by_index.remove(&row_idx).unwrap_or_default());
                    }
                    Ok(dense_rows)
                } else {
                    let mut ordered_rows: Vec<(i64, HashMap<String, Value>)> =
                        rows_by_index.into_iter().collect();
                    ordered_rows.sort_by_key(|(row_idx, _)| *row_idx);
                    Ok(ordered_rows.into_iter().map(|(_, row)| row).collect())
                }
            }
        }
    }

    /// Get entire dataset (for compatibility)
    /// WARNING: For large datasets, use get_rows_range() or flush_to_arrow() instead
    pub fn get_dataset(&self, dataset_id: &str) -> Option<Vec<HashMap<String, Value>>> {
        let namespaced_key = self.resolve_namespaced_key_optional(dataset_id)?;
        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key)? {
            DatasetStorage::InMemory { rows } => {
                // Current behavior
                Some(rows.clone())
            }
            DatasetStorage::DuckDB { row_count, .. } => {
                // WARNING: This is slow for large datasets
                log::warn!(
                    "get_dataset() called on large DuckDB dataset '{}' ({} rows). Use get_rows_range() or flush_to_arrow() instead.",
                    dataset_id, row_count
                );
                let count = *row_count;
                drop(datasets);
                self.get_rows_range(&namespaced_key, 0, count)
            }
        }
    }

    // ========================================================================
    // COLUMN ACCESS (Statistical Tests)
    // ========================================================================

    /// Get single column data
    ///
    /// For SMALL datasets: returns full vector (current behavior)
    /// For LARGE datasets: Returns None - use Python DataProvider (DuckDB/Polars)
    pub fn get_column_data(&self, dataset_id: &str, column_id: &str) -> Option<Vec<Value>> {
        let namespaced_key = self.resolve_namespaced_key_optional(dataset_id)?;
        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key)? {
            DatasetStorage::InMemory { rows } => {
                // Current behavior for small datasets
                Some(
                    rows.iter()
                        .map(|row| row.get(column_id).cloned().unwrap_or(Value::Null))
                        .collect(),
                )
            }

            DatasetStorage::DuckDB { row_count, .. } => {
                if *row_count >= LARGE_DATASET_THRESHOLD {
                    // CRITICAL: Do NOT return 50M values - will OOM
                    log::error!(
                        "get_column_data() called on large dataset '{}' ({} rows). Use Python DataProvider for analysis.",
                        dataset_id,
                        row_count
                    );
                    // Return None to force caller to use DataProvider path
                    return None;
                }

                let count = *row_count;
                drop(datasets);

                let rows = self.get_rows_range(&namespaced_key, 0, count)?;
                Some(
                    rows.iter()
                        .map(|row| row.get(column_id).cloned().unwrap_or(Value::Null))
                        .collect(),
                )
            }
        }
    }

    /// Get multiple columns data (for statistical tests)
    ///
    /// For SMALL datasets: returns full vectors (current behavior)
    /// For LARGE datasets: Returns None - use Python DataProvider (DuckDB/Polars)
    pub fn get_columns_data(
        &self,
        dataset_id: &str,
        column_ids: &[String],
    ) -> Option<HashMap<String, Vec<Value>>> {
        let namespaced_key = self.resolve_namespaced_key_optional(dataset_id)?;
        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key)? {
            DatasetStorage::InMemory { rows } => {
                // Current behavior for small datasets
                let mut result = HashMap::new();
                for col_id in column_ids {
                    let col_data: Vec<Value> = rows
                        .iter()
                        .map(|row| row.get(col_id).cloned().unwrap_or(Value::Null))
                        .collect();
                    result.insert(col_id.clone(), col_data);
                }
                Some(result)
            }

            DatasetStorage::DuckDB { row_count, .. } => {
                if *row_count >= LARGE_DATASET_THRESHOLD {
                    // CRITICAL: Do NOT return 50M values - will OOM
                    log::error!(
                        "get_columns_data() called on large dataset '{}' ({} rows). Use Python DataProvider for analysis.",
                        dataset_id,
                        row_count
                    );
                    // Return None to force caller to use DataProvider path
                    return None;
                }

                let count = *row_count;
                let columns: Vec<String> = column_ids.to_vec();
                drop(datasets);

                let rows = self.get_rows_range(&namespaced_key, 0, count)?;
                let mut result: HashMap<String, Vec<Value>> = HashMap::new();

                for col_id in &columns {
                    result.insert(col_id.clone(), Vec::with_capacity(rows.len()));
                }

                for row in rows {
                    for col_id in &columns {
                        let value = row.get(col_id).cloned().unwrap_or(Value::Null);
                        if let Some(col_vec) = result.get_mut(col_id) {
                            col_vec.push(value);
                        }
                    }
                }

                Some(result)
            }
        }
    }

    /// Compute aggregates for supported tests using DuckDB (Rust-owned, no Python file access).
    pub fn get_aggregates_for_test(
        &self,
        dataset_id: &str,
        test_name: &str,
        numeric_column: Option<&str>,
        group_column: Option<&str>,
    ) -> Result<Value, String> {
        // Ensure overlay edits are flushed before aggregation.
        self.flush_overlay(dataset_id)?;

        let normalized = test_name.trim().to_ascii_lowercase();
        log::info!(
            "[duckdb][aggregates] test='{}' dataset='{}' numeric={:?} group={:?}",
            normalized,
            dataset_id,
            numeric_column,
            group_column
        );
        let conn_arc = self.get_connection(dataset_id)?;
        let conn = conn_arc.lock().unwrap();

        match normalized.as_str() {
            "descriptive_stats" => {
                let numeric_column =
                    numeric_column.ok_or("Missing numeric column for descriptive stats")?;
                let col_expr = Self::numeric_expr(numeric_column);

                let stats_sql = format!(
                    "SELECT COUNT({col}) AS n, \
                            AVG({col}) AS mean, \
                            STDDEV_SAMP({col}) AS std, \
                            MIN({col}) AS min_val, \
                            MAX({col}) AS max_val, \
                            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {col}) AS median, \
                            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY {col}) AS q1, \
                            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY {col}) AS q3, \
                            SKEWNESS({col}) AS skewness, \
                            KURTOSIS({col}) AS kurtosis \
                     FROM data \
                     WHERE {col} IS NOT NULL",
                    col = col_expr
                );

                let (n, mean, std, min_val, max_val, median, q1, q3, skewness, kurtosis): (
                    i64,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                ) = conn
                    .query_row(&stats_sql, [], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                            row.get(8)?,
                            row.get(9)?,
                        ))
                    })
                    .map_err(|e| format!("Aggregate query failed: {}", e))?;

                let counts_sql = format!(
                    "WITH counts AS ( \
                        SELECT {col} AS val, COUNT(*) AS cnt \
                        FROM data \
                        WHERE {col} IS NOT NULL \
                        GROUP BY {col} \
                    ) \
                    SELECT MIN(cnt) AS min_cnt, MAX(cnt) AS max_cnt FROM counts",
                    col = col_expr
                );

                let (min_cnt, max_cnt): (Option<i64>, Option<i64>) = conn
                    .query_row(&counts_sql, [], |row| Ok((row.get(0)?, row.get(1)?)))
                    .map_err(|e| format!("Mode stats query failed: {}", e))?;

                let mut mode_stats = json!({
                    "has_mode": false,
                    "mode": Value::Null,
                    "mode_count": 0,
                    "is_multimodal": false,
                    "all_modes": Vec::<f64>::new()
                });

                if let (Some(min_cnt), Some(max_cnt)) = (min_cnt, max_cnt) {
                    if max_cnt > 0 && max_cnt != min_cnt {
                        let mode_sql = format!(
                            "WITH counts AS ( \
                                SELECT {col} AS val, COUNT(*) AS cnt \
                                FROM data \
                                WHERE {col} IS NOT NULL \
                                GROUP BY {col} \
                            ) \
                            SELECT val FROM counts WHERE cnt = {max_cnt} ORDER BY val",
                            col = col_expr,
                            max_cnt = max_cnt
                        );
                        let mut stmt = conn.prepare(&mode_sql).map_err(|e| e.to_string())?;
                        let rows = stmt
                            .query_map([], |row| {
                                let val: Option<f64> = row.get(0)?;
                                Ok(val)
                            })
                            .map_err(|e| e.to_string())?;

                        let mut modes: Vec<f64> = Vec::new();
                        for row in rows {
                            if let Ok(Some(val)) = row {
                                modes.push(val);
                            }
                        }

                        let mode_value = modes.first().cloned();
                        mode_stats = json!({
                            "has_mode": !modes.is_empty(),
                            "mode": mode_value,
                            "mode_count": max_cnt,
                            "is_multimodal": modes.len() > 1,
                            "all_modes": modes
                        });
                    } else {
                        mode_stats = json!({
                            "has_mode": false,
                            "mode": Value::Null,
                            "mode_count": max_cnt,
                            "is_multimodal": false,
                            "all_modes": Vec::<f64>::new()
                        });
                    }
                }

                Ok(json!({
                    "type": "descriptive_stats",
                    "numeric_column": numeric_column,
                    "stats": {
                        "n": n,
                        "mean": mean,
                        "std": std,
                        "min": min_val,
                        "max": max_val,
                        "median": median,
                        "q1": q1,
                        "q3": q3,
                        "skewness": skewness,
                        "kurtosis": kurtosis
                    },
                    "mode": mode_stats
                }))
            }
            "one_sample_ttest" => {
                let numeric_column =
                    numeric_column.ok_or("Missing numeric column for one-sample t-test")?;
                let col_expr = Self::numeric_expr(numeric_column);
                let sql = format!(
                    "SELECT COUNT({col}) AS n, \
                            AVG({col}) AS mean, \
                            STDDEV_SAMP({col}) AS std, \
                            MIN({col}) AS min_val, \
                            MAX({col}) AS max_val \
                     FROM data \
                     WHERE {col} IS NOT NULL",
                    col = col_expr
                );

                let (n, mean, std, min_val, max_val): (
                    i64,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                ) = conn
                    .query_row(&sql, [], |row| {
                        let n: i64 = row.get(0)?;
                        let mean: Option<f64> = row.get(1)?;
                        let std: Option<f64> = row.get(2)?;
                        let min_val: Option<f64> = row.get(3)?;
                        let max_val: Option<f64> = row.get(4)?;
                        Ok((n, mean, std, min_val, max_val))
                    })
                    .map_err(|e| format!("Aggregate query failed: {}", e))?;

                Ok(json!({
                    "type": "one_sample_ttest",
                    "numeric_column": numeric_column,
                    "stats": {
                        "n": n,
                        "mean": mean,
                        "std": std,
                        "min": min_val,
                        "max": max_val
                    }
                }))
            }
            "paired_ttest" | "t_test_paired" => {
                let numeric_column =
                    numeric_column.ok_or("Missing first numeric column for paired t-test")?;
                let other_column =
                    group_column.ok_or("Missing second numeric column for paired t-test")?;
                let col_a = Self::numeric_expr(numeric_column);
                let col_b = Self::numeric_expr(other_column);

                let sql = format!(
                    "SELECT COUNT(*) AS n, \
                            AVG(diff) AS mean, \
                            STDDEV_SAMP(diff) AS std, \
                            SUM(diff) AS sum_val, \
                            SUM(diff * diff) AS sum_sq, \
                            MIN(diff) AS min_val, \
                            MAX(diff) AS max_val \
                     FROM ( \
                        SELECT ({a} - {b}) AS diff \
                        FROM data \
                        WHERE {a} IS NOT NULL AND {b} IS NOT NULL \
                     ) t",
                    a = col_a,
                    b = col_b
                );

                let (n, mean, std, sum_val, sum_sq, min_val, max_val): (
                    i64,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                ) = conn
                    .query_row(&sql, [], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                        ))
                    })
                    .map_err(|e| format!("Aggregate query failed: {}", e))?;

                Ok(json!({
                    "type": "paired_ttest",
                    "numeric_column": numeric_column,
                    "other_column": other_column,
                    "stats": {
                        "n": n,
                        "mean": mean,
                        "std": std,
                        "sum": sum_val,
                        "sum_sq": sum_sq,
                        "min": min_val,
                        "max": max_val
                    }
                }))
            }
            "independent_ttest" | "t_test_two_sample" => {
                let numeric_column =
                    numeric_column.ok_or("Missing numeric column for independent t-test")?;
                let group_column =
                    group_column.ok_or("Missing group column for independent t-test")?;
                let value_expr = Self::numeric_expr(numeric_column);
                let group_expr = Self::quote_identifier(group_column);

                let sql = format!(
                    "SELECT {group} AS group_val, \
                            MIN(_row_index) AS first_row, \
                            COUNT({value}) AS n, \
                            AVG({value}) AS mean, \
                            STDDEV_SAMP({value}) AS std, \
                            VAR_SAMP({value}) AS var, \
                            SUM({value}) AS sum_val, \
                            SUM({value} * {value}) AS sum_sq, \
                            MIN({value}) AS min_val, \
                            MAX({value}) AS max_val \
                     FROM data \
                     WHERE {value} IS NOT NULL \
                     GROUP BY {group} \
                     ORDER BY first_row",
                    group = group_expr,
                    value = value_expr
                );

                let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |row| {
                        let group_val = Self::duckdb_value_to_json_static(row, 0);
                        let group_key = match group_val {
                            Value::String(s) => s,
                            Value::Number(n) => n.to_string(),
                            Value::Bool(b) => b.to_string(),
                            Value::Null => "null".to_string(),
                            other => other.to_string(),
                        };

                        let n: i64 = row.get(2)?;
                        let mean: Option<f64> = row.get(3)?;
                        let std: Option<f64> = row.get(4)?;
                        let var: Option<f64> = row.get(5)?;
                        let sum_val: Option<f64> = row.get(6)?;
                        let sum_sq: Option<f64> = row.get(7)?;
                        let min_val: Option<f64> = row.get(8)?;
                        let max_val: Option<f64> = row.get(9)?;

                        Ok((
                            group_key,
                            json!({
                                "n": n,
                                "mean": mean,
                                "std": std,
                                "var": var,
                                "sum": sum_val,
                                "sum_sq": sum_sq,
                                "min": min_val,
                                "max": max_val
                            }),
                        ))
                    })
                    .map_err(|e| e.to_string())?;

                let mut groups: HashMap<String, Value> = HashMap::new();
                let mut group_order: Vec<String> = Vec::new();
                for row in rows {
                    let (group_key, stats) = row.map_err(|e| e.to_string())?;
                    group_order.push(group_key.clone());
                    groups.insert(group_key, stats);
                }

                if groups.len() < 2 {
                    return Err("Insufficient groups for independent t-test".to_string());
                }

                Ok(json!({
                    "type": "independent_ttest",
                    "numeric_column": numeric_column,
                    "group_column": group_column,
                    "group_order": group_order,
                    "groups": groups
                }))
            }
            "correlation_pearson" => {
                let x_column = numeric_column.ok_or("Missing x column for correlation")?;
                let y_column = group_column.ok_or("Missing y column for correlation")?;
                let x_expr = Self::numeric_expr(x_column);
                let y_expr = Self::numeric_expr(y_column);

                let sql = format!(
                    "SELECT COUNT(*) AS n, \
                            SUM({x}) AS sum_x, \
                            SUM({y}) AS sum_y, \
                            SUM({x} * {y}) AS sum_xy, \
                            SUM({x} * {x}) AS sum_x2, \
                            SUM({y} * {y}) AS sum_y2 \
                     FROM data \
                     WHERE {x} IS NOT NULL AND {y} IS NOT NULL",
                    x = x_expr,
                    y = y_expr
                );

                let (n, sum_x, sum_y, sum_xy, sum_x2, sum_y2): (
                    i64,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                ) = conn
                    .query_row(&sql, [], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    })
                    .map_err(|e| format!("Aggregate query failed: {}", e))?;

                Ok(json!({
                    "type": "correlation_pearson",
                    "x_column": x_column,
                    "y_column": y_column,
                    "stats": {
                        "n": n,
                        "sum_x": sum_x,
                        "sum_y": sum_y,
                        "sum_xy": sum_xy,
                        "sum_x2": sum_x2,
                        "sum_y2": sum_y2
                    }
                }))
            }
            "correlation_spearman" => {
                let x_column = numeric_column.ok_or("Missing x column for correlation")?;
                let y_column = group_column.ok_or("Missing y column for correlation")?;
                let x_expr = Self::numeric_expr(x_column);
                let y_expr = Self::numeric_expr(y_column);

                let sql = format!(
                    "WITH base AS ( \
                        SELECT {x} AS x_val, {y} AS y_val \
                        FROM data \
                        WHERE {x} IS NOT NULL AND {y} IS NOT NULL \
                    ), ranks AS ( \
                        SELECT \
                            x_val, y_val, \
                            RANK() OVER (ORDER BY x_val) AS rx_min, \
                            COUNT(*) OVER (PARTITION BY x_val) AS rx_cnt, \
                            RANK() OVER (ORDER BY y_val) AS ry_min, \
                            COUNT(*) OVER (PARTITION BY y_val) AS ry_cnt \
                        FROM base \
                    ), final AS ( \
                        SELECT \
                            (rx_min + (rx_cnt - 1) / 2.0) AS rx, \
                            (ry_min + (ry_cnt - 1) / 2.0) AS ry \
                        FROM ranks \
                    ) \
                    SELECT COUNT(*) AS n, \
                           SUM(rx) AS sum_x, \
                           SUM(ry) AS sum_y, \
                           SUM(rx * ry) AS sum_xy, \
                           SUM(rx * rx) AS sum_x2, \
                           SUM(ry * ry) AS sum_y2 \
                    FROM final",
                    x = x_expr,
                    y = y_expr
                );

                let (n, sum_x, sum_y, sum_xy, sum_x2, sum_y2): (
                    i64,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                    Option<f64>,
                ) = conn
                    .query_row(&sql, [], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    })
                    .map_err(|e| format!("Aggregate query failed: {}", e))?;

                Ok(json!({
                    "type": "correlation_spearman",
                    "x_column": x_column,
                    "y_column": y_column,
                    "stats": {
                        "n": n,
                        "sum_x": sum_x,
                        "sum_y": sum_y,
                        "sum_xy": sum_xy,
                        "sum_x2": sum_x2,
                        "sum_y2": sum_y2
                    }
                }))
            }
            "one_way_anova" => {
                let numeric_column =
                    numeric_column.ok_or("Missing numeric column for one-way ANOVA")?;
                let group_column = group_column.ok_or("Missing group column for one-way ANOVA")?;
                let value_col = Self::numeric_expr(numeric_column);
                let factor_col = Self::quote_identifier(group_column);

                let grand_sql = format!(
                    "SELECT COUNT({value}) AS n, \
                            AVG({value}) AS mean, \
                            SUM(({value} - (SELECT AVG({value}) FROM data WHERE {value} IS NOT NULL)) * \
                                ({value} - (SELECT AVG({value}) FROM data WHERE {value} IS NOT NULL))) AS ss \
                     FROM data \
                     WHERE {value} IS NOT NULL",
                    value = value_col
                );
                let (grand_n, grand_mean, grand_ss): (i64, Option<f64>, Option<f64>) = conn
                    .query_row(&grand_sql, [], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })
                    .map_err(|e| format!("Aggregate query failed: {}", e))?;

                let group_stats_sql = format!(
                    "SELECT {factor} AS group_val, \
                            COUNT({value}) AS n, \
                            AVG({value}) AS mean \
                     FROM data \
                     WHERE {value} IS NOT NULL \
                     GROUP BY {factor}",
                    factor = factor_col,
                    value = value_col
                );
                let mut stmt = conn.prepare(&group_stats_sql).map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |row| {
                        let raw_group: duckdb::types::Value = row.get(0)?;
                        let group_key = match &raw_group {
                            duckdb::types::Value::Text(s) => s.clone(),
                            duckdb::types::Value::BigInt(n) => n.to_string(),
                            duckdb::types::Value::SmallInt(n) => n.to_string(),
                            duckdb::types::Value::TinyInt(n) => n.to_string(),
                            duckdb::types::Value::UBigInt(n) => n.to_string(),
                            duckdb::types::Value::USmallInt(n) => n.to_string(),
                            duckdb::types::Value::UTinyInt(n) => n.to_string(),
                            duckdb::types::Value::Float(n) => n.to_string(),
                            duckdb::types::Value::Double(n) => n.to_string(),
                            duckdb::types::Value::Boolean(b) => b.to_string(),
                            duckdb::types::Value::Null => "null".to_string(),
                            other => format!("{:?}", other),
                        };
                        let n: i64 = row.get(1)?;
                        let mean: Option<f64> = row.get(2)?;
                        Ok((raw_group, group_key, n, mean))
                    })
                    .map_err(|e| e.to_string())?;

                let mut groups: HashMap<String, Value> = HashMap::new();
                for row in rows {
                    let (raw_group, group_key, n, mean) = row.map_err(|e| e.to_string())?;
                    let mean_value = mean.unwrap_or(f64::NAN);
                    let ss_sql = if matches!(raw_group, duckdb::types::Value::Null) {
                        format!(
                            "SELECT SUM(({value} - ?) * ({value} - ?)) \
                             FROM data \
                             WHERE {value} IS NOT NULL AND {factor} IS NULL",
                            value = value_col,
                            factor = factor_col
                        )
                    } else {
                        format!(
                            "SELECT SUM(({value} - ?) * ({value} - ?)) \
                             FROM data \
                             WHERE {value} IS NOT NULL AND {factor} = ?",
                            value = value_col,
                            factor = factor_col
                        )
                    };

                    let ss_row: Option<f64> = if matches!(raw_group, duckdb::types::Value::Null) {
                        conn.query_row(&ss_sql, params![mean_value, mean_value], |row| row.get(0))
                            .map_err(|e| e.to_string())?
                    } else {
                        conn.query_row(
                            &ss_sql,
                            params![mean_value, mean_value, raw_group.clone()],
                            |row| row.get(0),
                        )
                        .map_err(|e| e.to_string())?
                    };

                    groups.insert(
                        group_key,
                        json!({
                            "n": n,
                            "mean": mean_value,
                            "ss": ss_row
                        }),
                    );
                }

                Ok(json!({
                    "type": "one_way_anova",
                    "numeric_column": numeric_column,
                    "group_column": group_column,
                    "grand_n": grand_n,
                    "grand_mean": grand_mean,
                    "grand_ss": grand_ss,
                    "groups": groups
                }))
            }
            _ => Err(format!("Unsupported aggregate test: {}", test_name)),
        }
    }

    /// Get sampled data for multiple columns.
    ///
    /// Returns up to `sample_size` rows using a deterministic systematic sample
    /// based on _row_index, with an optional seed offset for variation.
    /// This is used by plot data access to avoid OOM on large datasets.
    pub fn get_columns_sampled_data(
        &self,
        dataset_id: &str,
        column_ids: &[String],
        sample_size: usize,
        seed: Option<u64>,
    ) -> Result<HashMap<String, Vec<Value>>, String> {
        if column_ids.is_empty() || sample_size == 0 {
            return Ok(HashMap::new());
        }

        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { rows }) => {
                let total = rows.len();
                if total == 0 {
                    return Ok(HashMap::new());
                }

                let step = std::cmp::max(1, total / sample_size);
                let offset = seed.map(|s| (s as usize) % step).unwrap_or(0);

                let mut result: HashMap<String, Vec<Value>> = HashMap::new();
                for col_id in column_ids {
                    result.insert(col_id.clone(), Vec::with_capacity(sample_size.min(total)));
                }

                let mut taken = 0usize;
                for (idx, row) in rows.iter().enumerate() {
                    if step == 1 || ((idx + offset) % step == 0) {
                        for col_id in column_ids {
                            let value = row.get(col_id).cloned().unwrap_or(Value::Null);
                            if let Some(col_vec) = result.get_mut(col_id) {
                                col_vec.push(value);
                            }
                        }
                        taken += 1;
                        if taken >= sample_size {
                            break;
                        }
                    }
                }

                Ok(result)
            }

            Some(DatasetStorage::DuckDB { row_count, .. }) => {
                let total = *row_count as usize;
                if total == 0 {
                    return Ok(HashMap::new());
                }

                let step = std::cmp::max(1, total / sample_size);
                let offset = seed.map(|s| (s as usize) % step).unwrap_or(0);
                let columns: Vec<String> = column_ids.to_vec();
                let dataset_id_owned = namespaced_key.clone();
                drop(datasets);

                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let col_sql = columns
                    .iter()
                    .map(|c| Self::quote_identifier(c))
                    .collect::<Vec<_>>()
                    .join(", ");

                let sql = format!(
                    "SELECT _row_index, {} FROM data WHERE ((_row_index + ?) % ?) = 0 ORDER BY _row_index LIMIT ?",
                    col_sql
                );

                let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                let mut rows_iter = stmt
                    .query(params![offset as i64, step as i64, sample_size as i64])
                    .map_err(|e| e.to_string())?;

                let mut result: HashMap<String, Vec<Value>> = HashMap::new();
                for col_id in &columns {
                    result.insert(col_id.clone(), Vec::with_capacity(sample_size.min(total)));
                }

                let overlay = self.overlay.read().unwrap();

                while let Some(row) = rows_iter.next().map_err(|e| e.to_string())? {
                    let row_idx: i64 = row.get(0).map_err(|e| e.to_string())?;
                    for (i, col_id) in columns.iter().enumerate() {
                        let key = (dataset_id_owned.clone(), row_idx, col_id.clone());
                        let value = if let Some(overlay_val) = overlay.get(&key) {
                            overlay_val.clone()
                        } else {
                            Self::duckdb_value_to_json_static(row, i + 1)
                        };
                        if let Some(col_vec) = result.get_mut(col_id) {
                            col_vec.push(value);
                        }
                    }
                }

                Ok(result)
            }

            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    /// Get aggregated column data (group-by summaries).
    ///
    /// Aggregations are executed in DuckDB for large datasets, and computed
    /// in-memory for small datasets. All values are treated as strings with
    /// missing-value normalization, then TRY_CAST to DOUBLE for numeric ops.
    pub fn get_columns_aggregated_data(
        &self,
        dataset_id: &str,
        group_by: &[String],
        aggregations: &[ColumnAggregationRequest],
    ) -> Result<HashMap<String, Vec<Value>>, String> {
        if aggregations.is_empty() {
            return Ok(HashMap::new());
        }

        // Ensure overlay edits are flushed before aggregation.
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        self.flush_overlay(&namespaced_key)?;

        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { rows }) => {
                let total = rows.len();
                if total == 0 {
                    return Ok(HashMap::new());
                }

                let group_cols: Vec<String> = group_by.to_vec();
                let numeric_cols: HashSet<String> = aggregations
                    .iter()
                    .filter_map(|agg| agg.column_id.clone())
                    .collect();

                #[derive(Default)]
                struct Bucket {
                    group_vals: Vec<String>,
                    row_count: usize,
                    numeric_values: HashMap<String, Vec<f64>>,
                }

                let mut buckets: HashMap<String, Bucket> = HashMap::new();

                for row in rows {
                    let group_vals: Vec<String> = group_cols
                        .iter()
                        .map(|col_id| {
                            row.get(col_id)
                                .map(|val| match val {
                                    Value::Null => "(blank)".to_string(),
                                    Value::String(s) => {
                                        if Self::is_missing_string(s) {
                                            "(blank)".to_string()
                                        } else {
                                            let trimmed = s.trim();
                                            if trimmed.is_empty() {
                                                "(blank)".to_string()
                                            } else {
                                                trimmed.to_string()
                                            }
                                        }
                                    }
                                    _ => val.to_string(),
                                })
                                .unwrap_or_else(|| "(blank)".to_string())
                        })
                        .collect();

                    let key = group_vals.join("\u{1F}");
                    let bucket = buckets.entry(key).or_insert_with(|| Bucket {
                        group_vals: group_vals.clone(),
                        row_count: 0,
                        numeric_values: HashMap::new(),
                    });
                    bucket.row_count += 1;

                    for col_id in &numeric_cols {
                        if let Some(val) = row.get(col_id) {
                            let numeric = match val {
                                Value::Number(n) => n.as_f64(),
                                Value::String(s) => {
                                    if Self::is_missing_string(s) {
                                        None
                                    } else {
                                        s.trim().parse::<f64>().ok()
                                    }
                                }
                                _ => None,
                            };
                            if let Some(num) = numeric {
                                bucket
                                    .numeric_values
                                    .entry(col_id.clone())
                                    .or_insert_with(Vec::new)
                                    .push(num);
                            }
                        }
                    }
                }

                let mut rows_out: Vec<HashMap<String, Value>> = Vec::new();

                let mut sorted_keys: Vec<String> = buckets.keys().cloned().collect();
                sorted_keys.sort();

                for key in sorted_keys {
                    let bucket = match buckets.remove(&key) {
                        Some(bucket) => bucket,
                        None => continue,
                    };
                    let mut row_out: HashMap<String, Value> = HashMap::new();

                    for (idx, col_id) in group_cols.iter().enumerate() {
                        let value = bucket.group_vals.get(idx).cloned().unwrap_or_default();
                        row_out.insert(col_id.clone(), Value::String(value));
                    }

                    for agg in aggregations {
                        let func = agg.func.to_lowercase();
                        let alias = agg.alias.clone();
                        let value = if func == "count" && agg.column_id.is_none() {
                            Value::Number((bucket.row_count as i64).into())
                        } else if let Some(col_id) = agg.column_id.as_ref() {
                            let values = bucket
                                .numeric_values
                                .get(col_id)
                                .cloned()
                                .unwrap_or_default();
                            let result = match func.as_str() {
                                "count" => Some(values.len() as f64),
                                "sum" => Some(values.iter().sum::<f64>()),
                                "mean" => {
                                    if values.is_empty() {
                                        None
                                    } else {
                                        Some(values.iter().sum::<f64>() / values.len() as f64)
                                    }
                                }
                                "min" => values
                                    .iter()
                                    .cloned()
                                    .fold(None::<f64>, |acc, v| Some(acc.map_or(v, |m| m.min(v)))),
                                "max" => values
                                    .iter()
                                    .cloned()
                                    .fold(None::<f64>, |acc, v| Some(acc.map_or(v, |m| m.max(v)))),
                                "std" => {
                                    if values.len() < 2 {
                                        Some(0.0)
                                    } else {
                                        let mean = values.iter().sum::<f64>() / values.len() as f64;
                                        let var =
                                            values.iter().map(|v| (v - mean).powi(2)).sum::<f64>()
                                                / (values.len() as f64 - 1.0);
                                        Some(var.sqrt())
                                    }
                                }
                                "median" | "q1" | "q3" => {
                                    if values.is_empty() {
                                        None
                                    } else {
                                        let mut sorted = values.clone();
                                        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
                                        let percentile = match func.as_str() {
                                            "q1" => 0.25,
                                            "q3" => 0.75,
                                            _ => 0.5,
                                        };
                                        Some(Self::percentile(&sorted, percentile))
                                    }
                                }
                                _ => None,
                            };
                            if let Some(num) = result {
                                if let Some(n) = serde_json::Number::from_f64(num) {
                                    Value::Number(n)
                                } else {
                                    Value::Null
                                }
                            } else {
                                Value::Null
                            }
                        } else {
                            Value::Null
                        };

                        row_out.insert(alias, value);
                    }

                    rows_out.push(row_out);
                }

                return Ok(Self::rows_to_columns(&rows_out));
            }

            Some(DatasetStorage::DuckDB { .. }) => {
                let group_cols: Vec<String> = group_by.to_vec();
                let group_exprs: Vec<String> = group_cols
                    .iter()
                    .map(|col_id| {
                        let ident = Self::quote_identifier(col_id);
                        let trimmed = format!("TRIM(CAST({} AS VARCHAR))", ident);
                        let expr = format!(
                            "COALESCE(NULLIF({trimmed}, ''), '(blank)')",
                            trimmed = trimmed
                        );
                        format!("{expr} AS {ident}", expr = expr, ident = ident)
                    })
                    .collect();

                let group_by_exprs: Vec<String> = group_cols
                    .iter()
                    .map(|col_id| {
                        let ident = Self::quote_identifier(col_id);
                        format!(
                            "COALESCE(NULLIF(TRIM(CAST({} AS VARCHAR)), ''), '(blank)')",
                            ident
                        )
                    })
                    .collect();

                let mut agg_exprs: Vec<String> = Vec::new();
                for agg in aggregations {
                    let func = agg.func.to_lowercase();
                    let alias = Self::quote_identifier(&agg.alias);
                    let expr = if func == "count" && agg.column_id.is_none() {
                        format!("COUNT(*) AS {}", alias)
                    } else if let Some(col_id) = agg.column_id.as_ref() {
                        let ident = Self::quote_identifier(col_id);
                        let trimmed = format!("TRIM(CAST({} AS VARCHAR))", ident);
                        let missing_list = MISSING_VALUE_INDICATORS
                            .iter()
                            .map(|v| format!("'{}'", v.replace('\'', "''")))
                            .collect::<Vec<_>>()
                            .join(", ");
                        let missing_predicate = format!(
                            "{col} IS NULL OR {trim} = '' OR LOWER({trim}) IN ({missing_list})",
                            col = ident,
                            trim = trimmed,
                            missing_list = missing_list
                        );
                        let value_expr = format!(
                            "CASE WHEN {missing_predicate} THEN NULL ELSE {col} END",
                            missing_predicate = missing_predicate,
                            col = ident
                        );
                        let numeric_expr = format!("TRY_CAST({} AS DOUBLE)", value_expr);

                        match func.as_str() {
                            "count" => format!("COUNT({}) AS {}", numeric_expr, alias),
                            "sum" => format!("SUM({}) AS {}", numeric_expr, alias),
                            "mean" => format!("AVG({}) AS {}", numeric_expr, alias),
                            "min" => format!("MIN({}) AS {}", numeric_expr, alias),
                            "max" => format!("MAX({}) AS {}", numeric_expr, alias),
                            "std" => format!("STDDEV_SAMP({}) AS {}", numeric_expr, alias),
                            "median" => {
                                format!("quantile_cont({}, 0.5) AS {}", numeric_expr, alias)
                            }
                            "q1" => format!("quantile_cont({}, 0.25) AS {}", numeric_expr, alias),
                            "q3" => format!("quantile_cont({}, 0.75) AS {}", numeric_expr, alias),
                            _ => return Err(format!("Unsupported aggregate function: {}", func)),
                        }
                    } else {
                        return Err("Aggregation request missing column_id".to_string());
                    };

                    agg_exprs.push(expr);
                }

                let select_parts = if group_exprs.is_empty() {
                    agg_exprs.join(", ")
                } else {
                    format!("{}, {}", group_exprs.join(", "), agg_exprs.join(", "))
                };

                let mut sql = format!("SELECT {} FROM data", select_parts);
                if !group_by_exprs.is_empty() {
                    sql.push_str(&format!(" GROUP BY {}", group_by_exprs.join(", ")));
                    sql.push_str(&format!(" ORDER BY {}", group_by_exprs.join(", ")));
                }

                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();
                let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

                let output_cols: Vec<String> = group_cols
                    .iter()
                    .cloned()
                    .chain(aggregations.iter().map(|a| a.alias.clone()))
                    .collect();

                let mut result: HashMap<String, Vec<Value>> = HashMap::new();
                for col in &output_cols {
                    result.insert(col.clone(), Vec::new());
                }

                let mut rows_iter = stmt.query([]).map_err(|e| e.to_string())?;
                while let Some(row) = rows_iter.next().map_err(|e| e.to_string())? {
                    for (idx, col_name) in output_cols.iter().enumerate() {
                        let value = Self::duckdb_value_to_json_static(row, idx);
                        if let Some(col_vec) = result.get_mut(col_name) {
                            col_vec.push(value);
                        }
                    }
                }

                Ok(result)
            }

            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    /// Search column values (used by find/replace for large datasets)
    pub fn search_columns_values(
        &self,
        dataset_id: &str,
        column_ids: &[String],
        search_text: &str,
        case_sensitive: bool,
        whole_word: bool,
    ) -> Result<Vec<ColumnSearchMatch>, String> {
        if search_text.is_empty() || column_ids.is_empty() {
            return Ok(Vec::new());
        }

        // Ensure DuckDB reads include any pending overlay edits
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        self.flush_overlay(&namespaced_key)?;

        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { rows }) => {
                let mut matches: Vec<ColumnSearchMatch> = Vec::new();
                let search_lower = search_text.to_lowercase();
                let word_regex = if whole_word {
                    let pattern = format!(r"\b{}\b", regex::escape(search_text));
                    Some(
                        RegexBuilder::new(&pattern)
                            .case_insensitive(!case_sensitive)
                            .build()
                            .map_err(|e| e.to_string())?,
                    )
                } else {
                    None
                };

                for (row_idx, row) in rows.iter().enumerate() {
                    for col_id in column_ids {
                        let value = row
                            .get(col_id)
                            .map(|val| match val {
                                Value::Null => String::new(),
                                Value::String(s) => s.clone(),
                                _ => val.to_string(),
                            })
                            .unwrap_or_default();

                        let is_match = if let Some(re) = &word_regex {
                            re.is_match(&value)
                        } else if case_sensitive {
                            value.contains(search_text)
                        } else {
                            value.to_lowercase().contains(&search_lower)
                        };

                        if is_match {
                            matches.push(ColumnSearchMatch {
                                model_row: row_idx,
                                column_id: col_id.clone(),
                                value,
                            });
                        }
                    }
                }

                Ok(matches)
            }

            Some(DatasetStorage::DuckDB { .. }) => {
                drop(datasets); // Release lock before getting connection

                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let mut matches: Vec<ColumnSearchMatch> = Vec::new();
                let search_lower = search_text.to_lowercase();

                let regex_pattern = if whole_word {
                    let base = format!(r"\b{}\b", regex::escape(search_text));
                    if case_sensitive {
                        base
                    } else {
                        format!("(?i){base}")
                    }
                } else {
                    String::new()
                };

                for col_id in column_ids {
                    let quoted_col = Self::quote_identifier(col_id);
                    let value_expr = format!("COALESCE(CAST({} AS VARCHAR), '')", quoted_col);

                    let (sql, param): (String, String) = if whole_word {
                        (
                            format!(
                                "SELECT _row_index, {value_expr} AS value FROM data WHERE regexp_matches({value_expr}, ?) ORDER BY _row_index ASC",
                                value_expr = value_expr
                            ),
                            regex_pattern.clone(),
                        )
                    } else if case_sensitive {
                        (
                            format!(
                                "SELECT _row_index, {value_expr} AS value FROM data WHERE POSITION(? IN {value_expr}) > 0 ORDER BY _row_index ASC",
                                value_expr = value_expr
                            ),
                            search_text.to_string(),
                        )
                    } else {
                        (
                            format!(
                                "SELECT _row_index, {value_expr} AS value FROM data WHERE POSITION(? IN LOWER({value_expr})) > 0 ORDER BY _row_index ASC",
                                value_expr = value_expr
                            ),
                            search_lower.clone(),
                        )
                    };

                    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                    let mut rows = stmt.query(params![param]).map_err(|e| e.to_string())?;

                    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                        let row_index: i64 = row.get(0).map_err(|e| e.to_string())?;
                        if row_index < 0 {
                            continue;
                        }
                        let value: String = row.get(1).map_err(|e| e.to_string())?;

                        matches.push(ColumnSearchMatch {
                            model_row: row_index as usize,
                            column_id: col_id.clone(),
                            value,
                        });
                    }
                }

                Ok(matches)
            }

            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    // ========================================================================
    // CELL EDITING
    // ========================================================================

    /// Update single cell (uses active project for namespacing)
    /// Phase B: Uses namespaced key; errors if no active project
    pub fn update_cell(
        &self,
        dataset_id: &str,
        row: usize,
        col: &str,
        value: Value,
    ) -> Result<(), String> {
        validate_user_column_id(col)?;
        if is_calc_pending(&value) {
            return Ok(());
        }
        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { .. }) => {
                // Need write lock for in-memory
                drop(datasets);
                let mut datasets = self.datasets.write().unwrap();

                if let Some(DatasetStorage::InMemory { rows }) = datasets.get_mut(&namespaced_key) {
                    if let Some(row_data) = rows.get_mut(row) {
                        row_data.insert(col.to_string(), value);
                        self.invalidate_column_stats_cache(&namespaced_key);
                        return Ok(());
                    }
                    return Err(format!("Row {} not found", row));
                }
                Err(format!("Dataset '{}' not found", dataset_id))
            }

            Some(DatasetStorage::DuckDB { .. }) => {
                // Store in overlay (fast) - don't hit DuckDB for every keystroke.
                // Row keys are 0-based logical model rows; DuckDB writes map them
                // to stable physical rows through main.row_order during flush.
                // Phase B: Use namespaced key for overlay
                let mut overlay = self.overlay.write().unwrap();
                let key = (namespaced_key.clone(), row as i64, col.to_string());
                overlay.insert(key, value);
                self.invalidate_column_stats_cache(&namespaced_key);

                // Check if overlay should be flushed
                if overlay.len() >= OVERLAY_FLUSH_THRESHOLD {
                    drop(overlay);
                    self.flush_overlay(&namespaced_key)?;
                }

                Ok(())
            }

            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    /// Batch update cells (for paste operations)
    /// Phase B: Uses namespaced key; errors if no active project
    pub fn update_cells_batch(
        &self,
        dataset_id: &str,
        updates: Vec<(usize, String, Value)>,
    ) -> Result<usize, String> {
        for (_, col, _) in &updates {
            validate_user_column_id(col)?;
        }

        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        enum BatchStorageKind {
            InMemory,
            DuckDB,
        }
        let storage_kind = {
            let datasets = self.datasets.read().unwrap();
            match datasets.get(&namespaced_key) {
                Some(DatasetStorage::InMemory { .. }) => BatchStorageKind::InMemory,
                Some(DatasetStorage::DuckDB { .. }) => BatchStorageKind::DuckDB,
                None => return Err(format!("Dataset '{}' not found", dataset_id)),
            }
        };

        match storage_kind {
            BatchStorageKind::InMemory => {
                let mut datasets = self.datasets.write().unwrap();

                if let Some(DatasetStorage::InMemory { rows }) = datasets.get_mut(&namespaced_key) {
                    let mut count = 0;
                    for (row, col, value) in updates {
                        if is_calc_pending(&value) {
                            continue;
                        }
                        if let Some(row_data) = rows.get_mut(row) {
                            row_data.insert(col, value);
                            count += 1;
                        }
                    }
                    if count > 0 {
                        self.invalidate_row_range_cache(&namespaced_key);
                        self.invalidate_column_stats_cache(&namespaced_key);
                    }
                    return Ok(count);
                }
                Err(format!("Dataset '{}' not found", dataset_id))
            }

            BatchStorageKind::DuckDB => {
                // Batch add to overlay (Phase B: Use namespaced key)
                let mut overlay = self.overlay.write().unwrap();
                let mut count = 0;

                for (row, col, value) in updates {
                    if is_calc_pending(&value) {
                        continue;
                    }
                    let key = (namespaced_key.clone(), row as i64, col);
                    overlay.insert(key, value);
                    count += 1;
                }
                if count > 0 {
                    self.invalidate_row_range_cache(&namespaced_key);
                    self.invalidate_column_stats_cache(&namespaced_key);
                }

                // Check flush threshold
                if overlay.len() >= OVERLAY_FLUSH_THRESHOLD {
                    drop(overlay);
                    self.flush_overlay(&namespaced_key)?;
                }

                Ok(count)
            }
        }
    }

    pub fn apply_paste_block(
        &self,
        dataset_id: &str,
        payload: PasteBlockPayload,
    ) -> Result<PasteBlockResult, String> {
        if payload.rows.is_empty() {
            return Err("Paste block rows cannot be empty".to_string());
        }
        if payload.column_ids.is_empty() {
            return Err("Paste block columnIds cannot be empty".to_string());
        }
        if payload.values.len() != payload.rows.len() {
            return Err(format!(
                "Paste block values row count {} does not match rows count {}",
                payload.values.len(),
                payload.rows.len()
            ));
        }
        for (row_index, row_values) in payload.values.iter().enumerate() {
            if row_values.len() != payload.column_ids.len() {
                return Err(format!(
                    "Paste block values row {} has {} columns; expected {}",
                    row_index,
                    row_values.len(),
                    payload.column_ids.len()
                ));
            }
            for (column_index, value) in row_values.iter().enumerate() {
                if is_calc_pending(value) {
                    return Err(format!(
                        "Paste block contains calc-pending value at row {}, column {}; backend paste requires concrete values",
                        row_index, column_index
                    ));
                }
            }
        }
        for row in &payload.rows {
            if *row < 0 {
                return Err(format!("Paste block row {} is negative", row));
            }
        }
        for column_id in &payload.column_ids {
            validate_user_column_id(column_id)?;
        }

        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        {
            let datasets = self.datasets.read().unwrap();
            match datasets.get(&namespaced_key) {
                Some(DatasetStorage::DuckDB { .. }) => {}
                Some(DatasetStorage::InMemory { .. }) => {
                    return Err("apply_paste_block is for DuckDB datasets only".to_string())
                }
                None => return Err(format!("Dataset '{}' not found", dataset_id)),
            }
        }

        let mut writes: Vec<BulkCellWrite<'_>> =
            Vec::with_capacity(payload.rows.len() * payload.column_ids.len());
        for (row_index, logical_row) in payload.rows.iter().enumerate() {
            for (column_index, column_id) in payload.column_ids.iter().enumerate() {
                let value = &payload.values[row_index][column_index];
                writes.push(BulkCellWrite {
                    logical_row: *logical_row,
                    column_id: column_id.as_str(),
                    value,
                });
            }
        }

        if writes.is_empty() {
            return Ok(PasteBlockResult {
                row_start: 0,
                row_end_exclusive: 0,
                edited_cells: 0,
                old_values: Vec::new(),
            });
        }

        let row_start = writes
            .iter()
            .map(|write| write.logical_row)
            .min()
            .ok_or_else(|| "Paste block has no writable cells".to_string())?;
        let row_end_exclusive = writes
            .iter()
            .map(|write| write.logical_row)
            .max()
            .map(|row| row + 1)
            .ok_or_else(|| "Paste block has no writable cells".to_string())?;
        let overlay_keys_to_remove: Vec<(i64, String)> = writes
            .iter()
            .map(|write| (write.logical_row, write.column_id.to_string()))
            .collect();
        let written_rows: Vec<i64> = {
            let written_row_set: HashSet<i64> =
                writes.iter().map(|write| write.logical_row).collect();
            let mut seen = HashSet::new();
            payload
                .rows
                .iter()
                .filter(|logical_row| written_row_set.contains(logical_row))
                .filter(|logical_row| seen.insert(**logical_row))
                .copied()
                .collect()
        };
        let overlay_old_values: HashMap<(i64, String), Value> = {
            let overlay = self.overlay.read().unwrap();
            written_rows
                .iter()
                .flat_map(|logical_row| {
                    payload.column_ids.iter().filter_map(|column_id| {
                        overlay
                            .get(&(namespaced_key.clone(), *logical_row, column_id.clone()))
                            .filter(|value| !is_calc_pending(value))
                            .map(|value| ((*logical_row, column_id.clone()), value.clone()))
                    })
                })
                .collect()
        };

        let old_values: Vec<Vec<Value>>;
        let BulkWriteSummary {
            edit_count,
            added_columns,
            max_logical_row,
        } = {
            let conn_arc = self.get_connection(&namespaced_key)?;
            let conn = conn_arc.lock().unwrap();
            old_values = Self::read_old_values_for_paste_block(
                &conn,
                &overlay_old_values,
                &written_rows,
                &payload.column_ids,
            )?;
            Self::apply_duckdb_cell_writes(&conn, &namespaced_key, &writes)?
        };

        if !added_columns.is_empty() {
            let mut datasets = self.datasets.write().unwrap();
            if let Some(DatasetStorage::DuckDB { columns, .. }) = datasets.get_mut(&namespaced_key)
            {
                for col in added_columns {
                    if !columns.iter().any(|existing| existing.name == col.name) {
                        columns.push(col);
                    }
                }
            }
        }

        if let Some(max_row_idx) = max_logical_row {
            let required_count = (max_row_idx as usize) + 1;
            let mut datasets = self.datasets.write().unwrap();
            if let Some(DatasetStorage::DuckDB { row_count, .. }) =
                datasets.get_mut(&namespaced_key)
            {
                if required_count > *row_count {
                    *row_count = required_count;
                }
            }
        }

        {
            let mut overlay = self.overlay.write().unwrap();
            for (logical_row, column_id) in overlay_keys_to_remove {
                overlay.remove(&(namespaced_key.clone(), logical_row, column_id));
            }
        }

        self.invalidate_row_range_cache_for_range(&namespaced_key, row_start, row_end_exclusive);
        self.invalidate_column_stats_cache(&namespaced_key);

        Ok(PasteBlockResult {
            row_start,
            row_end_exclusive,
            edited_cells: edit_count,
            old_values,
        })
    }

    fn read_old_values_for_paste_block(
        conn: &Connection,
        overlay_old_values: &HashMap<(i64, String), Value>,
        rows: &[i64],
        column_ids: &[String],
    ) -> Result<Vec<Vec<Value>>, String> {
        let mut old_values_by_cell = overlay_old_values.clone();

        let existing_columns: HashSet<String> = Self::get_table_columns(conn)?
            .into_iter()
            .map(|column| column.name)
            .collect();
        let readable_column_ids: Vec<String> = column_ids
            .iter()
            .filter(|column_id| existing_columns.contains(column_id.as_str()))
            .cloned()
            .collect();

        if !rows.is_empty() && !readable_column_ids.is_empty() {
            let logical_to_physical = Self::logical_rows_to_physical(conn, rows)?;
            let mut physical_to_logical: HashMap<i64, i64> = HashMap::new();
            for (logical_row, physical_row) in logical_to_physical {
                physical_to_logical.insert(physical_row, logical_row);
            }

            let mut physical_rows: Vec<i64> = physical_to_logical.keys().copied().collect();
            physical_rows.sort_unstable();
            physical_rows.dedup();

            const OLD_VALUE_READ_CHUNK_SIZE: usize = 1000;
            for chunk in physical_rows.chunks(OLD_VALUE_READ_CHUNK_SIZE) {
                if chunk.is_empty() {
                    continue;
                }

                let row_ids_sql = chunk
                    .iter()
                    .map(|row_idx| row_idx.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                let select_columns = readable_column_ids
                    .iter()
                    .map(|column_id| Self::quote_identifier(column_id))
                    .collect::<Vec<_>>()
                    .join(", ");
                let sql = format!(
                    "SELECT _row_index, {columns} FROM data WHERE _row_index IN ({rows})",
                    columns = select_columns,
                    rows = row_ids_sql
                );
                let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                let mut db_rows = stmt.query([]).map_err(|e| e.to_string())?;

                while let Some(row) = db_rows.next().map_err(|e| e.to_string())? {
                    let physical_row: i64 = row.get(0).map_err(|e| e.to_string())?;
                    let Some(logical_row) = physical_to_logical.get(&physical_row).copied() else {
                        continue;
                    };
                    for (index, column_id) in readable_column_ids.iter().enumerate() {
                        old_values_by_cell
                            .entry((logical_row, column_id.clone()))
                            .or_insert_with(|| Self::duckdb_value_to_json_static(row, index + 1));
                    }
                }
            }
        }

        Ok(rows
            .iter()
            .map(|logical_row| {
                column_ids
                    .iter()
                    .map(|column_id| {
                        old_values_by_cell
                            .get(&(*logical_row, column_id.clone()))
                            .cloned()
                            .unwrap_or(Value::Null)
                    })
                    .collect()
            })
            .collect())
    }

    /// Add column to all rows (uses active project for namespacing)
    /// Phase B: Uses namespaced key; errors if no active project
    pub fn add_column(
        &self,
        dataset_id: &str,
        column_id: &str,
        default_value: Value,
    ) -> Result<usize, String> {
        validate_user_column_id(column_id)?;
        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { .. }) => {
                drop(datasets);
                let mut datasets = self.datasets.write().unwrap();

                if let Some(DatasetStorage::InMemory { rows }) = datasets.get_mut(&namespaced_key) {
                    let count = rows.len();
                    for row in rows.iter_mut() {
                        if !row.contains_key(column_id) {
                            row.insert(column_id.to_string(), default_value.clone());
                        }
                    }
                    self.invalidate_column_stats_cache(&namespaced_key);
                    return Ok(count);
                }
                Err(format!("Dataset '{}' not found", dataset_id))
            }

            Some(DatasetStorage::DuckDB { row_count, .. }) => {
                let count = *row_count;
                drop(datasets); // Release lock before getting connection

                // Use pooled connection (Phase B: Use namespaced key)
                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();
                Self::set_column_hidden(&conn, column_id, false)?;

                // Determine SQL type and default from Value
                let (sql_type, default_sql) = Self::infer_column_type(&default_value);
                let mut detected_existing_type: Option<String> = None;

                // Detect whether this physical column already exists in DuckDB.
                // This supports logical-delete undo/redo without relying on DROP COLUMN.
                let column_exists = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('data') WHERE name = ?",
                        params![column_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map(|n| n > 0)
                    .map_err(|e| e.to_string())?;

                if column_exists {
                    detected_existing_type = conn
                        .query_row(
                            "SELECT type FROM pragma_table_info('data') WHERE name = ? LIMIT 1",
                            params![column_id],
                            |row| row.get::<_, String>(0),
                        )
                        .ok();
                }

                // Use proper SQL identifier quoting
                if !column_exists {
                    let quoted_col = Self::quote_identifier(column_id);
                    conn.execute(
                        &format!(
                            "ALTER TABLE data ADD COLUMN {} {} DEFAULT {}",
                            quoted_col, sql_type, default_sql
                        ),
                        [],
                    )
                    .map_err(|e| e.to_string())?;
                }

                // Keep DuckDB column metadata in sync (Phase B: Use namespaced key)
                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::DuckDB { columns, .. }) =
                    datasets.get_mut(&namespaced_key)
                {
                    if !columns.iter().any(|c| c.name == column_id) {
                        columns.push(ColumnInfo {
                            name: column_id.to_string(),
                            display_name: column_id.to_string(),
                            dtype: detected_existing_type.unwrap_or_else(|| sql_type.to_string()),
                        });
                    }
                }

                // Phase 3: Invalidate row-range cache so new column appears in cached rows
                // Phase B: Use namespaced key
                self.invalidate_row_range_cache(&namespaced_key);
                self.invalidate_column_stats_cache(&namespaced_key);

                Ok(count)
            }

            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    /// Insert an empty row at model index `row_index`.
    /// Existing rows at/after this index are shifted down by one.
    pub fn insert_row_at(&self, dataset_id: &str, row_index: usize) -> Result<usize, String> {
        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { .. }) => {
                drop(datasets);
                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::InMemory { rows }) = datasets.get_mut(&namespaced_key) {
                    let insert_at = row_index.min(rows.len());
                    rows.insert(insert_at, HashMap::new());
                    self.invalidate_column_stats_cache(&namespaced_key);
                    return Ok(rows.len());
                }
                Err(format!("Dataset '{}' not found", dataset_id))
            }
            Some(DatasetStorage::DuckDB { row_count, .. }) => {
                let clamped_row_index = row_index.min(*row_count);
                drop(datasets);

                // Ensure pending overlay edits are materialized before reindexing rows.
                self.flush_overlay(&namespaced_key)?;

                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let transaction_result: Result<(), String> = (|| {
                    conn.execute("BEGIN TRANSACTION", [])
                        .map_err(|e| e.to_string())?;

                    Self::insert_physical_rows_with_order(&conn, clamped_row_index, 1)?;

                    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
                    Ok(())
                })();

                if let Err(err) = transaction_result {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(err);
                }

                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::DuckDB { row_count, .. }) =
                    datasets.get_mut(&namespaced_key)
                {
                    *row_count += 1;
                    self.invalidate_row_range_cache(&namespaced_key);
                    self.invalidate_column_stats_cache(&namespaced_key);
                    return Ok(*row_count);
                }

                Err(format!("Dataset '{}' not found", dataset_id))
            }
            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    /// Insert `count` empty rows at model index `row_index`.
    /// Existing rows at/after this index are shifted down by `count`.
    pub fn insert_rows_at(
        &self,
        dataset_id: &str,
        row_index: usize,
        count: usize,
    ) -> Result<usize, String> {
        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { .. }) => {
                drop(datasets);
                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::InMemory { rows }) = datasets.get_mut(&namespaced_key) {
                    if count == 0 {
                        return Ok(rows.len());
                    }
                    let insert_at = row_index.min(rows.len());
                    for offset in 0..count {
                        rows.insert(insert_at + offset, HashMap::new());
                    }
                    self.invalidate_column_stats_cache(&namespaced_key);
                    return Ok(rows.len());
                }
                Err(format!("Dataset '{}' not found", dataset_id))
            }
            Some(DatasetStorage::DuckDB { row_count, .. }) => {
                let current_row_count = *row_count;
                let clamped_row_index = row_index.min(current_row_count);
                drop(datasets);

                if count == 0 {
                    return Ok(current_row_count);
                }

                // Ensure pending overlay edits are materialized before reindexing rows.
                self.flush_overlay(&namespaced_key)?;

                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let transaction_result: Result<(), String> = (|| {
                    conn.execute("BEGIN TRANSACTION", [])
                        .map_err(|e| e.to_string())?;

                    Self::insert_physical_rows_with_order(&conn, clamped_row_index, count)?;

                    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
                    Ok(())
                })();

                if let Err(err) = transaction_result {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(err);
                }

                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::DuckDB { row_count, .. }) =
                    datasets.get_mut(&namespaced_key)
                {
                    *row_count += count;
                    self.invalidate_row_range_cache(&namespaced_key);
                    self.invalidate_column_stats_cache(&namespaced_key);
                    return Ok(*row_count);
                }

                Err(format!("Dataset '{}' not found", dataset_id))
            }
            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    /// Append `count` empty rows without reindexing existing rows.
    pub fn append_rows(&self, dataset_id: &str, count: usize) -> Result<usize, String> {
        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { .. }) => {
                drop(datasets);
                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::InMemory { rows }) = datasets.get_mut(&namespaced_key) {
                    if count == 0 {
                        return Ok(rows.len());
                    }
                    rows.reserve(count);
                    for _ in 0..count {
                        rows.push(HashMap::new());
                    }
                    self.invalidate_column_stats_cache(&namespaced_key);
                    return Ok(rows.len());
                }
                Err(format!("Dataset '{}' not found", dataset_id))
            }
            Some(DatasetStorage::DuckDB { row_count, .. }) => {
                let current_row_count = *row_count;
                drop(datasets);

                if count == 0 {
                    return Ok(current_row_count);
                }

                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let transaction_result: Result<(), String> = (|| {
                    conn.execute("BEGIN TRANSACTION", [])
                        .map_err(|e| e.to_string())?;

                    Self::append_physical_rows_with_order(&conn, count)?;

                    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
                    Ok(())
                })();

                if let Err(err) = transaction_result {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(err);
                }

                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::DuckDB { row_count, .. }) =
                    datasets.get_mut(&namespaced_key)
                {
                    *row_count += count;
                    self.invalidate_row_range_cache(&namespaced_key);
                    self.invalidate_column_stats_cache(&namespaced_key);
                    return Ok(*row_count);
                }

                Err(format!("Dataset '{}' not found", dataset_id))
            }
            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    /// Remove `count` rows from the end without shifting existing rows.
    pub fn remove_rows_from_end(&self, dataset_id: &str, count: usize) -> Result<usize, String> {
        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { .. }) => {
                drop(datasets);
                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::InMemory { rows }) = datasets.get_mut(&namespaced_key) {
                    if count == 0 {
                        return Ok(rows.len());
                    }
                    if count > rows.len() {
                        return Err(format!(
                            "Cannot remove {} rows from dataset '{}' with len={}",
                            count,
                            dataset_id,
                            rows.len()
                        ));
                    }

                    rows.truncate(rows.len() - count);
                    self.invalidate_column_stats_cache(&namespaced_key);
                    return Ok(rows.len());
                }
                Err(format!("Dataset '{}' not found", dataset_id))
            }
            Some(DatasetStorage::DuckDB { row_count, .. }) => {
                let current_row_count = *row_count;
                drop(datasets);

                if count == 0 {
                    return Ok(current_row_count);
                }
                if count > current_row_count {
                    return Err(format!(
                        "Cannot remove {} rows from dataset '{}' with row_count={}",
                        count, dataset_id, current_row_count
                    ));
                }

                let target_row_count = current_row_count - count;
                let target_idx = i64::try_from(target_row_count)
                    .map_err(|_| format!("Row count {} is too large", target_row_count))?;

                self.flush_overlay(&namespaced_key)?;

                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let transaction_result: Result<(), String> = (|| {
                    conn.execute("BEGIN TRANSACTION", [])
                        .map_err(|e| e.to_string())?;

                    Self::ensure_row_order_table(&conn)?;
                    let physical_rows = {
                        let mut stmt = conn
                            .prepare(&format!(
                                "SELECT physical_row FROM {} ORDER BY sort_key DESC LIMIT ?",
                                ROW_ORDER_TABLE
                            ))
                            .map_err(|e| e.to_string())?;
                        let rows = stmt
                            .query_map(params![count as i64], |row| row.get::<_, i64>(0))
                            .map_err(|e| e.to_string())?;
                        let mut physical_rows = Vec::new();
                        for row in rows {
                            physical_rows.push(row.map_err(|e| e.to_string())?);
                        }
                        physical_rows
                    };
                    if physical_rows.is_empty() {
                        return Err("No logical tail rows found to remove".to_string());
                    }
                    for physical_rows_chunk in physical_rows.chunks(1024) {
                        let physical_rows_sql = Self::format_i64_list(physical_rows_chunk);
                        conn.execute(
                            &format!(
                                "DELETE FROM data WHERE _row_index IN ({})",
                                physical_rows_sql
                            ),
                            [],
                        )
                        .map_err(|e| e.to_string())?;
                        conn.execute(
                            &format!(
                                "DELETE FROM {} WHERE physical_row IN ({})",
                                ROW_ORDER_TABLE, physical_rows_sql
                            ),
                            [],
                        )
                        .map_err(|e| e.to_string())?;
                    }

                    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
                    Ok(())
                })();

                if let Err(err) = transaction_result {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(err);
                }

                {
                    let mut overlay = self.overlay.write().unwrap();
                    overlay.retain(|(dataset_key, row_idx, _), _| {
                        dataset_key != &namespaced_key || *row_idx < target_idx
                    });
                }

                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::DuckDB { row_count, .. }) =
                    datasets.get_mut(&namespaced_key)
                {
                    *row_count = target_row_count;
                    self.invalidate_row_range_cache(&namespaced_key);
                    self.invalidate_column_stats_cache(&namespaced_key);
                    return Ok(*row_count);
                }

                Err(format!("Dataset '{}' not found", dataset_id))
            }
            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    /// Remove a row at model index `row_index`.
    /// Existing rows after the index are shifted up by one.
    pub fn remove_row_at(&self, dataset_id: &str, row_index: usize) -> Result<usize, String> {
        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { .. }) => {
                drop(datasets);
                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::InMemory { rows }) = datasets.get_mut(&namespaced_key) {
                    if rows.is_empty() {
                        return Err(format!("Dataset '{}' has no rows to remove", dataset_id));
                    }
                    if row_index >= rows.len() {
                        return Err(format!(
                            "Row index {} out of bounds for dataset '{}' (len={})",
                            row_index,
                            dataset_id,
                            rows.len()
                        ));
                    }
                    rows.remove(row_index);
                    self.invalidate_column_stats_cache(&namespaced_key);
                    return Ok(rows.len());
                }
                Err(format!("Dataset '{}' not found", dataset_id))
            }
            Some(DatasetStorage::DuckDB { row_count, .. }) => {
                if *row_count == 0 {
                    return Err(format!("Dataset '{}' has no rows to remove", dataset_id));
                }

                if row_index >= *row_count {
                    return Err(format!(
                        "Row index {} out of bounds for dataset '{}' (len={})",
                        row_index, dataset_id, row_count
                    ));
                }
                drop(datasets);

                self.flush_overlay(&namespaced_key)?;

                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let transaction_result: Result<(), String> = (|| {
                    conn.execute("BEGIN TRANSACTION", [])
                        .map_err(|e| e.to_string())?;

                    Self::ensure_row_order_table(&conn)?;
                    let physical_row: i64 = conn
                        .query_row(
                            &format!(
                                "SELECT physical_row FROM {} ORDER BY sort_key LIMIT 1 OFFSET ?",
                                ROW_ORDER_TABLE
                            ),
                            params![row_index as i64],
                            |row| row.get(0),
                        )
                        .map_err(|e| e.to_string())?;
                    conn.execute(
                        "DELETE FROM data WHERE _row_index = ?",
                        params![physical_row],
                    )
                    .map_err(|e| e.to_string())?;
                    conn.execute(
                        &format!("DELETE FROM {} WHERE physical_row = ?", ROW_ORDER_TABLE),
                        params![physical_row],
                    )
                    .map_err(|e| e.to_string())?;

                    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
                    Ok(())
                })();

                if let Err(err) = transaction_result {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(err);
                }

                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::DuckDB { row_count, .. }) =
                    datasets.get_mut(&namespaced_key)
                {
                    *row_count -= 1;
                    self.invalidate_row_range_cache(&namespaced_key);
                    self.invalidate_column_stats_cache(&namespaced_key);
                    return Ok(*row_count);
                }

                Err(format!("Dataset '{}' not found", dataset_id))
            }
            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    /// Remove a column from all rows.
    pub fn remove_column(&self, dataset_id: &str, column_id: &str) -> Result<usize, String> {
        if column_id == "_row_index" {
            return Err("Cannot remove internal _row_index column".to_string());
        }

        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { .. }) => {
                drop(datasets);
                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::InMemory { rows }) = datasets.get_mut(&namespaced_key) {
                    let count = rows.len();
                    // Keep values in-memory so ColumnInsert undo/redo semantics
                    // match DuckDB logical-hide behavior (value restoration without
                    // lossy delete on remove).
                    self.invalidate_column_stats_cache(&namespaced_key);
                    return Ok(count);
                }
                Err(format!("Dataset '{}' not found", dataset_id))
            }
            Some(DatasetStorage::DuckDB { row_count, .. }) => {
                let count = *row_count;
                drop(datasets);

                self.flush_overlay(&namespaced_key)?;
                // Logical-delete for DuckDB: remove from active metadata only.
                // Physical compaction can be done later without risking dependency
                // errors from DROP COLUMN during hot undo/redo paths.
                {
                    let mut overlay = self.overlay.write().unwrap();
                    overlay.retain(|(dataset_key, _, col_name), _| {
                        dataset_key != &namespaced_key || col_name != column_id
                    });
                }

                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();
                Self::set_column_hidden(&conn, column_id, true)?;
                drop(conn);

                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::DuckDB { columns, .. }) =
                    datasets.get_mut(&namespaced_key)
                {
                    columns.retain(|c| c.name != column_id);
                }
                self.invalidate_row_range_cache(&namespaced_key);
                self.invalidate_column_stats_cache(&namespaced_key);

                Ok(count)
            }
            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    // ========================================================================
    // EXPORT (Arrow IPC for Python)
    // ========================================================================

    /// Flush dataset to Arrow IPC file for Python consumption
    ///
    /// CRITICAL: Always flushes overlay first
    /// CRITICAL: Excludes _row_index from exported schema
    pub fn flush_to_arrow(&self, dataset_id: &str) -> Result<String, String> {
        // ALWAYS flush any pending overlay edits first
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        self.flush_overlay(&namespaced_key)?;

        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { rows }) => {
                // Current behavior - use existing ArrowHandler
                let columns: Vec<String> = if let Some(first_row) = rows.first() {
                    first_row.keys().cloned().collect()
                } else {
                    return Err("Dataset is empty".to_string());
                };

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

                let path = ArrowHandler::get_temp_path(dataset_id);
                ArrowHandler::write_to_file(&path, columns, numeric_rows)
                    .map_err(|e| format!("Arrow write failed: {}", e))?;

                Ok(path.to_string_lossy().to_string())
            }

            Some(DatasetStorage::DuckDB { columns, .. }) => {
                // Build column list excluding _row_index with proper quoting
                let export_cols: Vec<String> = columns
                    .iter()
                    .map(|c| c.name.clone())
                    .filter(|n| n != "_row_index")
                    .collect();
                let col_sql: String = export_cols
                    .iter()
                    .map(|n| Self::quote_identifier(n))
                    .collect::<Vec<_>>()
                    .join(", ");

                drop(datasets); // Release lock before getting connection

                // Use pooled connection
                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let temp_dir = std::env::temp_dir();
                let arrow_path = temp_dir.join(format!("{}_duckdb.arrow", dataset_id));
                let arrow_path_str = arrow_path.to_string_lossy().to_string();
                let arrow_sql = format!(
                    "COPY (SELECT {} FROM data) TO '{}' (FORMAT 'arrow')",
                    col_sql,
                    arrow_path_str.replace('\'', "''")
                );

                // DuckDB Arrow export may be unavailable in some builds; fall back to Parquet.
                if let Err(err) = conn.execute(&arrow_sql, []) {
                    let err_msg = err.to_string();
                    log::warn!(
                        "Cache: Arrow export failed for '{}': {}. Falling back to Parquet.",
                        dataset_id,
                        err_msg
                    );

                    let parquet_path = temp_dir.join(format!("{}_duckdb.parquet", dataset_id));
                    let parquet_path_str = parquet_path.to_string_lossy().to_string();
                    let parquet_sql = format!(
                        "COPY (SELECT {} FROM data) TO '{}' (FORMAT 'parquet')",
                        col_sql,
                        parquet_path_str.replace('\'', "''")
                    );

                    conn.execute(&parquet_sql, []).map_err(|e| {
                        format!(
                            "Arrow export failed: {}; Parquet export failed: {}",
                            err_msg, e
                        )
                    })?;

                    log::info!(
                        "Cache: Exported DuckDB table '{}' to Parquet: {}",
                        dataset_id,
                        parquet_path_str
                    );

                    return Ok(parquet_path_str);
                }

                log::info!(
                    "Cache: Exported DuckDB table '{}' to Arrow: {}",
                    dataset_id,
                    arrow_path_str
                );

                Ok(arrow_path_str)
            }

            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    /// Export selected columns to Arrow IPC file for Python consumption
    ///
    /// CRITICAL: Always flushes overlay first
    /// CRITICAL: Excludes _row_index from exported schema
    pub fn export_columns_to_arrow(
        &self,
        dataset_id: &str,
        columns: &[String],
    ) -> Result<String, String> {
        if columns.is_empty() {
            return Err("No columns specified for Arrow export".to_string());
        }

        // ALWAYS flush any pending overlay edits first
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        self.flush_overlay(&namespaced_key)?;

        let datasets = self.datasets.read().unwrap();

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let temp_dir = std::env::temp_dir();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { rows }) => {
                let available: HashSet<String> = rows
                    .first()
                    .map(|row| row.keys().cloned().collect())
                    .unwrap_or_default();

                let export_cols: Vec<String> = columns
                    .iter()
                    .filter(|name| *name != "_row_index" && available.contains(*name))
                    .cloned()
                    .collect();

                if export_cols.is_empty() {
                    return Err("No matching columns found for Arrow export".to_string());
                }

                let numeric_rows: Vec<Vec<Option<f64>>> = rows
                    .iter()
                    .map(|row| {
                        export_cols
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

                let arrow_path =
                    temp_dir.join(format!("easycris_{}_cols_{}.arrow", dataset_id, timestamp));
                ArrowHandler::write_to_file(&arrow_path, export_cols, numeric_rows)
                    .map_err(|e| format!("Arrow write failed: {}", e))?;

                Ok(arrow_path.to_string_lossy().to_string())
            }

            Some(DatasetStorage::DuckDB {
                columns: dataset_columns,
                ..
            }) => {
                let available: HashSet<String> =
                    dataset_columns.iter().map(|c| c.name.clone()).collect();
                let export_cols: Vec<String> = columns
                    .iter()
                    .filter(|name| *name != "_row_index" && available.contains(*name))
                    .cloned()
                    .collect();

                if export_cols.is_empty() {
                    return Err("No matching columns found for Arrow export".to_string());
                }

                let col_sql: String = export_cols
                    .iter()
                    .map(|n| Self::quote_identifier(n))
                    .collect::<Vec<_>>()
                    .join(", ");

                drop(datasets); // Release lock before getting connection

                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let arrow_path =
                    temp_dir.join(format!("easycris_{}_cols_{}.arrow", dataset_id, timestamp));
                let arrow_path_str = arrow_path.to_string_lossy().to_string();
                let arrow_sql = format!(
                    "COPY (SELECT {} FROM data) TO '{}' (FORMAT 'arrow')",
                    col_sql,
                    arrow_path_str.replace('\'', "''")
                );

                if let Err(err) = conn.execute(&arrow_sql, []) {
                    let err_msg = err.to_string();
                    log::warn!(
                        "Cache: Arrow export failed for '{}': {}. Falling back to Parquet.",
                        dataset_id,
                        err_msg
                    );

                    let parquet_path = temp_dir.join(format!(
                        "easycris_{}_cols_{}.parquet",
                        dataset_id, timestamp
                    ));
                    let parquet_path_str = parquet_path.to_string_lossy().to_string();
                    let parquet_sql = format!(
                        "COPY (SELECT {} FROM data) TO '{}' (FORMAT 'parquet')",
                        col_sql,
                        parquet_path_str.replace('\'', "''")
                    );

                    conn.execute(&parquet_sql, []).map_err(|e| {
                        format!(
                            "Arrow export failed: {}; Parquet export failed: {}",
                            err_msg, e
                        )
                    })?;

                    log::info!(
                        "Cache: Exported DuckDB table '{}' to Parquet: {}",
                        dataset_id,
                        parquet_path_str
                    );

                    return Ok(parquet_path_str);
                }

                log::info!(
                    "Cache: Exported DuckDB table '{}' to Arrow: {}",
                    dataset_id,
                    arrow_path_str
                );

                Ok(arrow_path_str)
            }

            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    // ========================================================================
    // SERVER-SIDE SORTING (MANDATORY for large datasets)
    // ========================================================================

    /// Get sorted row indices for a column (DuckDB does the sorting)
    /// Returns row indices in sorted order - grid uses this for display
    ///
    /// MANDATORY for DuckDB datasets - do NOT pull 50M values for client sort
    pub fn get_sorted_row_indices(
        &self,
        dataset_id: &str,
        sort_column: &str,
        descending: bool,
    ) -> Result<Vec<i64>, String> {
        // MANDATORY: Flush overlay before sort
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        self.flush_overlay(&namespaced_key)?;

        let datasets = self.datasets.read().unwrap();

        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { rows }) => {
                // For small datasets, return simple range (sorting done in frontend)
                Ok((0..rows.len() as i64).collect())
            }

            Some(DatasetStorage::DuckDB { .. }) => {
                drop(datasets); // Release lock before getting connection

                // Use pooled connection
                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let order = if descending { "DESC" } else { "ASC" };
                let col_ident = Self::quote_identifier(sort_column);
                let numeric_expr = Self::numeric_sort_expr(sort_column);

                let sql = format!(
                    "SELECT _row_index FROM data ORDER BY {} {} NULLS LAST, {} {} NULLS LAST, _row_index ASC",
                    numeric_expr, order, col_ident, order
                );

                let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                let indices: Vec<i64> = stmt
                    .query_map([], |row| row.get(0))
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect();

                Ok(indices)
            }

            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    // ========================================================================
    // SERVER-SIDE GROUPING (DuckDB datasets)
    // ========================================================================

    /// Get lazy group metadata using DuckDB GROUP BY aggregation.
    /// O(groups) complexity - does NOT fetch all rows.
    /// For 18M rows with 100 groups: returns 100 entries, not 18M.
    pub fn get_lazy_group_metadata(
        &self,
        dataset_id: &str,
        group_column: &str,
        sort_column: Option<&str>,
        descending: bool,
    ) -> Result<LazyGroupedResult, String> {
        // Ensure latest edits are visible
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        self.flush_overlay(&namespaced_key)?;

        let datasets = self.datasets.read().unwrap();
        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::DuckDB { .. }) => {
                drop(datasets); // Release lock before getting connection

                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let group_ident = Self::quote_identifier(group_column);
                let order = if descending { "DESC" } else { "ASC" };

                // Use GROUP BY aggregation - O(groups) not O(rows)
                // Gets: group key, count, first row index (for header)
                let order_by = if let Some(sort_col) = sort_column {
                    // When sorting, order groups by the sort column's aggregate
                    let sort_ident = Self::quote_identifier(sort_col);
                    format!(
                        "MIN({sort_ident}) {order} NULLS LAST, {group_ident} ASC",
                        sort_ident = sort_ident,
                        order = order,
                        group_ident = group_ident
                    )
                } else {
                    // Default: order by first occurrence
                    "MIN(_row_index) ASC".to_string()
                };

                let sql = format!(
                    "SELECT
                        COALESCE(NULLIF(TRIM(CAST({group_ident} AS VARCHAR)), ''), '(blank)') as grp_key,
                        COUNT(*) as grp_count,
                        MIN(_row_index) as first_row
                     FROM data
                     GROUP BY grp_key
                     ORDER BY {order_by}",
                    group_ident = group_ident,
                    order_by = order_by
                );

                let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                let mut rows = stmt.query([]).map_err(|e| e.to_string())?;

                let mut groups: Vec<LazyGroupMeta> = Vec::new();
                let mut total_rows: usize = 0;

                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let key: String = row.get(0).map_err(|e| e.to_string())?;
                    let count: i64 = row.get(1).map_err(|e| e.to_string())?;
                    let first_row: i64 = row.get(2).map_err(|e| e.to_string())?;

                    total_rows += count as usize;
                    groups.push(LazyGroupMeta {
                        key,
                        size: count as usize,
                        first_row_index: first_row,
                    });
                }

                Ok(LazyGroupedResult { groups, total_rows })
            }
            Some(DatasetStorage::InMemory { .. }) => {
                Err("get_lazy_group_metadata is for DuckDB datasets only".to_string())
            }
            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    /// Get rows for a specific group with pagination.
    /// Used to fetch visible rows within a group on scroll.
    pub fn get_group_rows(
        &self,
        dataset_id: &str,
        group_column: &str,
        group_key: &str,
        sort_column: Option<&str>,
        descending: bool,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<i64>, String> {
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        let datasets = self.datasets.read().unwrap();
        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::DuckDB { .. }) => {
                drop(datasets);

                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let group_ident = Self::quote_identifier(group_column);
                let order = if descending { "DESC" } else { "ASC" };

                let order_clause = if let Some(sort_col) = sort_column {
                    let sort_ident = Self::quote_identifier(sort_col);
                    let numeric_expr = Self::numeric_sort_expr(sort_col);
                    format!(
                        "{numeric_expr} {order} NULLS LAST, {sort_ident} {order} NULLS LAST, _row_index ASC"
                    )
                } else {
                    "_row_index ASC".to_string()
                };

                // Handle (blank) group key
                let where_clause = if group_key == "(blank)" {
                    format!("({group_ident} IS NULL OR TRIM(CAST({group_ident} AS VARCHAR)) = '')")
                } else {
                    format!(
                        "COALESCE(NULLIF(TRIM(CAST({group_ident} AS VARCHAR)), ''), '(blank)') = ?"
                    )
                };

                let sql = format!(
                    "SELECT _row_index FROM data WHERE {where_clause} ORDER BY {order_clause} LIMIT ? OFFSET ?",
                    where_clause = where_clause,
                    order_clause = order_clause
                );

                let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

                let rows: Vec<i64> = if group_key == "(blank)" {
                    stmt.query_map(params![limit as i64, offset as i64], |row| row.get(0))
                        .map_err(|e| e.to_string())?
                        .filter_map(|r| r.ok())
                        .collect()
                } else {
                    stmt.query_map(params![group_key, limit as i64, offset as i64], |row| {
                        row.get(0)
                    })
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect()
                };

                Ok(rows)
            }
            Some(DatasetStorage::InMemory { .. }) => {
                Err("get_group_rows is for DuckDB datasets only".to_string())
            }
            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    /// Build grouped row order and metadata for large datasets.
    /// Returns view row order (model indices) and group metadata for UI headers.
    /// DEPRECATED: Use get_lazy_group_metadata + get_group_rows for large datasets.
    pub fn get_grouped_row_order(
        &self,
        dataset_id: &str,
        group_column: &str,
        sort_column: Option<&str>,
        descending: bool,
        collapsed_groups: &[String],
    ) -> Result<GroupedRowOrder, String> {
        // Ensure latest edits are visible
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        self.flush_overlay(&namespaced_key)?;

        let datasets = self.datasets.read().unwrap();
        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::DuckDB { .. }) => {
                drop(datasets); // Release lock before getting connection

                // Use pooled connection
                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let group_ident = Self::quote_identifier(group_column);
                let order = if descending { "DESC" } else { "ASC" };
                let sort_ident = sort_column.map(Self::quote_identifier);

                let order_clause = if let Some(sort_col) = sort_ident {
                    let numeric_expr = Self::numeric_sort_expr(sort_column.unwrap());
                    format!(
                        "{numeric_expr} {order} NULLS LAST, {sort_col} {order} NULLS LAST, _row_index ASC",
                        numeric_expr = numeric_expr,
                        sort_col = sort_col,
                        order = order
                    )
                } else {
                    "_row_index ASC".to_string()
                };

                let sql = format!(
                    "SELECT _row_index, {} FROM data ORDER BY {}",
                    group_ident, order_clause
                );

                let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                let mut rows = stmt.query([]).map_err(|e| e.to_string())?;

                let collapsed: std::collections::HashSet<String> =
                    collapsed_groups.iter().cloned().collect();

                let mut group_order: Vec<String> = Vec::new();
                let mut groups: HashMap<String, Vec<i64>> = HashMap::new();

                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let row_index: i64 = row.get(0).map_err(|e| e.to_string())?;
                    let raw_key: Option<String> = row.get(1).ok();
                    let key = match raw_key {
                        Some(k) if !k.trim().is_empty() => k,
                        _ => "(blank)".to_string(),
                    };

                    if !groups.contains_key(&key) {
                        group_order.push(key.clone());
                        groups.insert(key.clone(), Vec::new());
                    }

                    if let Some(list) = groups.get_mut(&key) {
                        list.push(row_index);
                    }
                }

                let mut row_order: Vec<i64> = Vec::new();
                let mut group_meta: Vec<GroupMeta> = Vec::new();

                for key in group_order {
                    let rows = groups.get(&key).cloned().unwrap_or_default();
                    if rows.is_empty() {
                        continue;
                    }

                    let collapsed_flag = collapsed.contains(&key);
                    let start_view_row = row_order.len();
                    let size = rows.len();

                    // Always include first row as header
                    row_order.push(rows[0]);

                    if !collapsed_flag {
                        row_order.extend(rows.iter().skip(1));
                    }

                    group_meta.push(GroupMeta {
                        start_view_row,
                        key,
                        size,
                        collapsed: collapsed_flag,
                    });
                }

                Ok(GroupedRowOrder {
                    row_order,
                    group_meta,
                })
            }
            Some(DatasetStorage::InMemory { .. }) => {
                Err("get_grouped_row_order is for DuckDB datasets only".to_string())
            }
            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    fn apply_duckdb_cell_writes(
        conn: &Connection,
        dataset_key: &str,
        writes: &[BulkCellWrite<'_>],
    ) -> Result<BulkWriteSummary, String> {
        if writes.is_empty() {
            return Ok(BulkWriteSummary {
                edit_count: 0,
                added_columns: Vec::new(),
                max_logical_row: None,
            });
        }

        Self::ensure_row_order_table(conn)?;

        let mut table_columns: HashSet<String> = HashSet::new();
        let existing_columns = Self::get_table_columns(conn)?;
        for col in existing_columns {
            table_columns.insert(col.name);
        }

        let mut unique_rows: Vec<i64> = writes.iter().map(|write| write.logical_row).collect();
        unique_rows.sort_unstable();
        unique_rows.dedup();

        let mut missing_columns: Vec<(String, String, String)> = Vec::new();
        let mut missing_column_samples: HashMap<String, Value> = HashMap::new();
        for write in writes.iter() {
            validate_user_column_id(write.column_id)?;
            if write.column_id != "_row_index" && !table_columns.contains(write.column_id) {
                let entry = missing_column_samples
                    .entry(write.column_id.to_string())
                    .or_insert(Value::Null);
                if matches!(entry, Value::Null) && !matches!(write.value, Value::Null) {
                    *entry = write.value.clone();
                }
            }
        }
        for (col, sample) in missing_column_samples {
            if !table_columns.contains(col.as_str()) {
                let (sql_type, default_sql) = Self::infer_column_type(&sample);
                missing_columns.push((col.clone(), sql_type.to_string(), default_sql.to_string()));
                table_columns.insert(col);
            }
        }

        if let Err(err) = conn.execute("ROLLBACK", []) {
            log::trace!(
                "Cache: Initial ROLLBACK skipped/failed before bulk cell write for '{}': {}",
                dataset_key,
                err
            );
        }

        let transaction_result: Result<(), String> = (|| {
            conn.execute("BEGIN TRANSACTION", [])
                .map_err(|e| e.to_string())?;

            for (col_name, sql_type, default_sql) in missing_columns.iter() {
                let quoted_col = Self::quote_identifier(col_name);
                conn.execute(
                    &format!(
                        "ALTER TABLE data ADD COLUMN {} {} DEFAULT {}",
                        quoted_col, sql_type, default_sql
                    ),
                    [],
                )
                .map_err(|e| e.to_string())?;
            }

            Self::ensure_logical_rows_exist(conn, &unique_rows)?;
            let logical_to_physical = Self::logical_rows_to_physical(conn, &unique_rows)?;

            let mut by_column: HashMap<String, Vec<(i64, &Value)>> = HashMap::new();
            for write in writes.iter() {
                let physical_row = logical_to_physical
                    .get(&write.logical_row)
                    .copied()
                    .ok_or_else(|| {
                        format!("Logical row {} has no physical row", write.logical_row)
                    })?;
                by_column
                    .entry(write.column_id.to_string())
                    .or_default()
                    .push((physical_row, write.value));
            }

            const COLUMN_UPDATE_CHUNK_SIZE: usize = 512;
            for (col, updates) in by_column {
                let quoted_col = Self::quote_identifier(&col);
                for update_chunk in updates.chunks(COLUMN_UPDATE_CHUNK_SIZE) {
                    if update_chunk.is_empty() {
                        continue;
                    }

                    if update_chunk
                        .iter()
                        .all(|(_, value)| is_nullish_overlay_value(value))
                    {
                        let row_ids_sql = update_chunk
                            .iter()
                            .map(|(row_idx, _)| row_idx.to_string())
                            .collect::<Vec<_>>()
                            .join(", ");
                        let sql = format!(
                            "UPDATE data SET {} = NULL WHERE _row_index IN ({})",
                            quoted_col, row_ids_sql
                        );
                        conn.execute(&sql, []).map_err(|e| e.to_string())?;
                        continue;
                    }

                    let values_sql = update_chunk
                        .iter()
                        .map(|(row_idx, value)| {
                            format!("({}, {})", row_idx, to_duckdb_sql_literal(value))
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    let sql = format!(
                        "UPDATE data \
                         SET {col} = vals.value \
                         FROM (VALUES {values}) AS vals(row_idx, value) \
                         WHERE data._row_index = vals.row_idx",
                        col = quoted_col,
                        values = values_sql
                    );
                    conn.execute(&sql, []).map_err(|e| e.to_string())?;
                }
            }

            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(())
        })();

        if let Err(err) = transaction_result {
            let _ = conn.execute("ROLLBACK", []);
            return Err(err);
        }

        let added_columns = missing_columns
            .iter()
            .map(|(col_name, sql_type, _)| ColumnInfo {
                name: col_name.clone(),
                display_name: col_name.clone(),
                dtype: sql_type.clone(),
            })
            .collect();
        let max_logical_row = writes.iter().map(|write| write.logical_row).max();

        Ok(BulkWriteSummary {
            edit_count: writes.len(),
            added_columns,
            max_logical_row,
        })
    }

    // ========================================================================
    // OVERLAY MANAGEMENT
    // ========================================================================

    /// Flush pending overlay edits to DuckDB
    /// Uses prepared statements with parameters for safety
    /// Fixed: Uses pooled connection and proper identifier quoting
    pub fn flush_overlay(&self, dataset_id: &str) -> Result<(), String> {
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        // Check if dataset is DuckDB (quick read lock)
        {
            let datasets = self.datasets.read().unwrap();
            match datasets.get(&namespaced_key) {
                Some(DatasetStorage::DuckDB { .. }) => {} // Continue
                _ => return Ok(()),                       // No-op for in-memory or non-existent
            }
        }

        // Collect snapshot entries while holding overlay lock.
        // Keep keys + values so we can remove only the exact flushed entries later
        // without dropping concurrent writes that land during flush.
        let flushed_entries: Vec<((String, i64, String), Value)>;
        {
            let overlay = self.overlay.read().unwrap();
            flushed_entries = overlay
                .iter()
                .filter(|((ds_id, _, _), val)| ds_id == &namespaced_key && !is_calc_pending(val))
                .map(|((ds_id, row, col), val)| ((ds_id.clone(), *row, col.clone()), val.clone()))
                .collect();
        }
        #[cfg(test)]
        if let Some(hook) = self.flush_overlay_after_snapshot.read().unwrap().clone() {
            hook();
        }

        let writes: Vec<BulkCellWrite<'_>> = flushed_entries
            .iter()
            .map(|((_, row, col), val)| BulkCellWrite {
                logical_row: *row,
                column_id: col.as_str(),
                value: val,
            })
            .collect();

        if writes.is_empty() {
            return Ok(());
        }

        let BulkWriteSummary {
            edit_count,
            added_columns,
            max_logical_row,
        } = {
            let conn_arc = self.get_connection(&namespaced_key)?;
            let conn = conn_arc.lock().unwrap();
            Self::apply_duckdb_cell_writes(&conn, &namespaced_key, &writes)?
        };

        if !added_columns.is_empty() {
            let mut datasets = self.datasets.write().unwrap();
            if let Some(DatasetStorage::DuckDB { columns, .. }) = datasets.get_mut(&namespaced_key)
            {
                for col in added_columns {
                    if !columns.iter().any(|c| c.name == col.name) {
                        columns.push(col);
                    }
                }
            }
        }

        // Phase 3: Invalidate row-range cache as soon as DuckDB commit succeeds.
        // This prevents a narrow window where stale cached rows could be served
        // after overlay entries are removed.
        self.invalidate_row_range_cache(&namespaced_key);
        self.invalidate_column_stats_cache(&namespaced_key);

        // Clear flushed edits from overlay (take write lock only after DB update)
        {
            let mut overlay = self.overlay.write().unwrap();
            for (key, snapshot_value) in flushed_entries.iter() {
                if overlay.get(key) == Some(snapshot_value) {
                    overlay.remove(key);
                }
            }
        }

        log::info!(
            "Cache: Flushed {} overlay edits to DuckDB for '{}'",
            edit_count,
            dataset_id
        );

        // Update cached row count if edits extended beyond current size
        if let Some(max_row_idx) = max_logical_row {
            if max_row_idx >= 0 {
                let required_count = (max_row_idx as usize) + 1;
                let mut datasets = self.datasets.write().unwrap();
                if let Some(DatasetStorage::DuckDB { row_count, .. }) =
                    datasets.get_mut(&namespaced_key)
                {
                    if required_count > *row_count {
                        *row_count = required_count;
                    }
                }
            }
        }

        Ok(())
    }

    // ========================================================================
    // COLUMN STATS CACHE
    // ========================================================================

    fn get_cached_column_stats(&self, dataset_id: &str) -> Option<Vec<ColumnClassificationStats>> {
        let namespaced_key = self.resolve_namespaced_key_optional(dataset_id)?;
        let cache = self.column_stats_cache.read().unwrap();
        if let Some(entry) = cache.get(&namespaced_key) {
            log::debug!(
                "Cache: Using column-stats cache for '{}' (age: {:?})",
                namespaced_key,
                entry.computed_at.elapsed()
            );
            return Some(entry.stats.clone());
        }
        None
    }

    fn set_cached_column_stats(&self, dataset_id: &str, stats: Vec<ColumnClassificationStats>) {
        let Some(namespaced_key) = self.resolve_namespaced_key_optional(dataset_id) else {
            return;
        };
        let mut cache = self.column_stats_cache.write().unwrap();
        cache.insert(
            namespaced_key,
            CachedColumnStats {
                stats,
                computed_at: Instant::now(),
            },
        );
    }

    /// Invalidate cached column stats for a dataset
    fn invalidate_column_stats_cache(&self, dataset_id: &str) {
        let Some(namespaced_key) = self.resolve_namespaced_key_optional(dataset_id) else {
            return;
        };
        let mut cache = self.column_stats_cache.write().unwrap();
        if cache.remove(&namespaced_key).is_some() {
            log::debug!(
                "Cache: Invalidated column-stats cache entry for '{}'",
                namespaced_key
            );
        }
    }

    // ========================================================================
    // PHASE 3: ROW-RANGE CACHE MANAGEMENT
    // ========================================================================

    /// Invalidate all cached row ranges for a dataset
    /// Called after flush_overlay when DuckDB data has changed
    fn invalidate_row_range_cache(&self, dataset_id: &str) {
        let Some(namespaced_key) = self.resolve_namespaced_key_optional(dataset_id) else {
            return;
        };
        // moka doesn't have a prefix-based invalidation, so we iterate and remove
        // This is O(cache_size) but cache is bounded to 100 entries
        // Note: moka's iter() returns Arc-wrapped keys, so we need to deref
        let keys_to_remove: Vec<RowRangeCacheKey> = self
            .row_range_cache
            .iter()
            .filter(|(key, _)| key.0 == namespaced_key)
            .map(|(key, _)| (*key).clone())
            .collect();

        let removed_count = keys_to_remove.len();
        for key in keys_to_remove {
            self.row_range_cache.invalidate(&key);
        }

        if removed_count > 0 {
            log::debug!(
                "Cache: Invalidated {} row-range cache entries for '{}'",
                removed_count,
                namespaced_key
            );
        }
    }

    /// Invalidate cached row ranges that overlap a changed logical row interval.
    fn invalidate_row_range_cache_for_range(&self, dataset_id: &str, start_row: i64, end_row: i64) {
        if start_row >= end_row {
            return;
        }
        let Some(namespaced_key) = self.resolve_namespaced_key_optional(dataset_id) else {
            return;
        };
        let keys_to_remove: Vec<RowRangeCacheKey> = self
            .row_range_cache
            .iter()
            .filter(|(key, _)| {
                key.0 == namespaced_key && (key.1 as i64) < end_row && start_row < (key.2 as i64)
            })
            .map(|(key, _)| (*key).clone())
            .collect();

        let removed_count = keys_to_remove.len();
        for key in keys_to_remove {
            self.row_range_cache.invalidate(&key);
        }

        if removed_count > 0 {
            log::debug!(
                "Cache: Invalidated {} overlapping row-range cache entries for '{}' ({}..{})",
                removed_count,
                namespaced_key,
                start_row,
                end_row
            );
        }
    }

    /// Get row-range cache statistics (for monitoring)
    pub fn get_row_range_cache_stats(&self) -> (u64, u64) {
        // Returns (entry_count, weighted_size)
        (
            self.row_range_cache.entry_count(),
            self.row_range_cache.weighted_size(),
        )
    }

    // ========================================================================

    /// Get overlay edit count (for monitoring)
    pub fn get_overlay_size(&self) -> usize {
        self.overlay.read().unwrap().len()
    }

    /// Get number of pending edits in overlay for a specific dataset
    /// Used by async aggregate formula support to check for pending edits
    pub fn get_overlay_size_for_dataset(&self, dataset_id: &str) -> usize {
        let Some(namespaced_key) = self.resolve_namespaced_key_optional(dataset_id) else {
            return 0;
        };
        let overlay = self.overlay.read().unwrap();
        overlay
            .keys()
            .filter(|(ds_id, _, _)| ds_id == &namespaced_key)
            .count()
    }

    /// Flush all datasets with pending overlay edits
    /// Phase 5: Used by time-based auto-flush background task
    pub fn flush_all_overlays(&self) -> Result<(), String> {
        use std::collections::HashSet;

        // Collect unique dataset IDs that have pending edits
        let dataset_ids: Vec<String> = {
            let overlay = self.overlay.read().unwrap();
            overlay
                .keys()
                .map(|(ds_id, _, _)| ds_id.clone())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect()
        };

        // Flush each dataset
        for dataset_id in dataset_ids {
            if let Err(e) = self.flush_overlay(&dataset_id) {
                log::error!("Auto-flush failed for '{}': {}", dataset_id, e);
                // Continue flushing other datasets even if one fails
            }
        }

        Ok(())
    }

    // ========================================================================
    // ASYNC AGGREGATE FORMULA SUPPORT
    // ========================================================================

    /// Compute aggregate over a full column using DuckDB SQL
    ///
    /// CRITICAL: Flushes overlay before query to ensure consistency.
    /// Only supports full-column aggregates (no row ranges) to avoid view-order issues.
    ///
    /// # Arguments
    /// * `dataset_id` - Dataset identifier
    /// * `column_id` - Column ID (e.g., "col-0")
    /// * `func` - Aggregate function: "SUM", "AVG", "COUNT", "COUNTA", "STDEV", "STDEV_P", "VAR", "VAR_P"
    pub fn get_column_aggregate(
        &self,
        dataset_id: &str,
        column_id: &str,
        func: &str,
    ) -> Result<f64, String> {
        // CRITICAL: Flush overlay first to ensure pending edits are in DuckDB
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        self.flush_overlay(&namespaced_key)?;

        // Check if dataset exists and is DuckDB type
        {
            let datasets = self.datasets.read().unwrap();
            match datasets.get(&namespaced_key) {
                Some(DatasetStorage::DuckDB { .. }) => {} // Continue
                Some(DatasetStorage::InMemory { .. }) => {
                    return Err("Async aggregate not supported for in-memory datasets".to_string());
                }
                None => return Err(format!("Dataset '{}' not found", dataset_id)),
            }
        } // Release datasets lock before getting connection

        // Use get_connection() pool pattern
        let conn_arc = self.get_connection(&namespaced_key)?;
        let conn = conn_arc.lock().unwrap();

        // Use proper SQL identifier quoting
        let quoted_col = Self::quote_identifier(column_id);

        // Map function to SQL with correct semantics
        // Use TRY_CAST for numeric conversion, correct POP/SAMP variants
        let sql = match func.to_uppercase().as_str() {
            "SUM" => format!(
                "SELECT SUM(TRY_CAST({} AS DOUBLE)) FROM data",
                quoted_col
            ),
            "AVG" | "AVERAGE" => format!(
                "SELECT AVG(TRY_CAST({} AS DOUBLE)) FROM data",
                quoted_col
            ),
            "COUNT" => format!(
                // COUNT = count of values that can be cast to numeric
                "SELECT COUNT(TRY_CAST({} AS DOUBLE)) FROM data WHERE TRY_CAST({} AS DOUBLE) IS NOT NULL",
                quoted_col, quoted_col
            ),
            "COUNTA" => format!(
                // COUNTA = count of non-NULL values (any type)
                "SELECT COUNT({}) FROM data WHERE {} IS NOT NULL",
                quoted_col, quoted_col
            ),
            "STDEV" | "STDEV_S" => format!(
                "SELECT STDDEV_SAMP(TRY_CAST({} AS DOUBLE)) FROM data",
                quoted_col
            ),
            "STDEV_P" => format!(
                // Use STDDEV_POP for population
                "SELECT STDDEV_POP(TRY_CAST({} AS DOUBLE)) FROM data",
                quoted_col
            ),
            "VAR" | "VAR_S" => format!(
                "SELECT VAR_SAMP(TRY_CAST({} AS DOUBLE)) FROM data",
                quoted_col
            ),
            "VAR_P" => format!(
                // Use VAR_POP for population
                "SELECT VAR_POP(TRY_CAST({} AS DOUBLE)) FROM data",
                quoted_col
            ),
            "MIN" => format!(
                "SELECT MIN(TRY_CAST({} AS DOUBLE)) FROM data",
                quoted_col
            ),
            "MAX" => format!(
                "SELECT MAX(TRY_CAST({} AS DOUBLE)) FROM data",
                quoted_col
            ),
            _ => return Err(format!("Unsupported aggregate function: {}", func)),
        };

        let result: Option<f64> = conn
            .query_row(&sql, [], |row| row.get(0))
            .map_err(|e| format!("Aggregate query failed: {}", e))?;

        // Return 0.0 for NULL result (empty column or all non-numeric)
        Ok(result.unwrap_or(0.0))
    }

    /// Compute aggregate over a row range using DuckDB SQL (row bounds inclusive).
    ///
    /// This avoids materializing large ranges into memory for simple aggregates like SUM/AVG.
    /// The row range is interpreted in MODEL coordinates (0-based _row_index).
    ///
    /// # Arguments
    /// * `dataset_id` - Dataset identifier
    /// * `column_id` - Column ID (e.g., "col-0")
    /// * `func` - Aggregate function
    /// * `start_row` - 0-based start row (inclusive)
    /// * `end_row` - 0-based end row (inclusive)
    pub fn get_column_aggregate_range(
        &self,
        dataset_id: &str,
        column_id: &str,
        func: &str,
        start_row: usize,
        end_row: usize,
    ) -> Result<f64, String> {
        // CRITICAL: Flush overlay first to ensure pending edits are in DuckDB
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        self.flush_overlay(&namespaced_key)?;

        // Check if dataset exists and is DuckDB type
        {
            let datasets = self.datasets.read().unwrap();
            match datasets.get(&namespaced_key) {
                Some(DatasetStorage::DuckDB { .. }) => {} // Continue
                Some(DatasetStorage::InMemory { .. }) => {
                    return Err("Async aggregate not supported for in-memory datasets".to_string());
                }
                None => return Err(format!("Dataset '{}' not found", dataset_id)),
            }
        } // Release datasets lock before getting connection

        let (start_row, end_row) = if start_row <= end_row {
            (start_row, end_row)
        } else {
            (end_row, start_row)
        };

        // Use get_connection() pool pattern
        let conn_arc = self.get_connection(&namespaced_key)?;
        let conn = conn_arc.lock().unwrap();

        // Use proper SQL identifier quoting
        let quoted_col = Self::quote_identifier(column_id);

        let sql = match func.to_uppercase().as_str() {
            "SUM" => format!(
                "SELECT SUM(TRY_CAST({} AS DOUBLE)) FROM data WHERE _row_index BETWEEN ? AND ?",
                quoted_col
            ),
            "AVG" | "AVERAGE" => format!(
                "SELECT AVG(TRY_CAST({} AS DOUBLE)) FROM data WHERE _row_index BETWEEN ? AND ?",
                quoted_col
            ),
            "COUNT" => format!(
                "SELECT COUNT(TRY_CAST({} AS DOUBLE)) FROM data WHERE _row_index BETWEEN ? AND ? AND TRY_CAST({} AS DOUBLE) IS NOT NULL",
                quoted_col, quoted_col
            ),
            "COUNTA" => format!(
                "SELECT COUNT({}) FROM data WHERE _row_index BETWEEN ? AND ? AND {} IS NOT NULL",
                quoted_col, quoted_col
            ),
            "STDEV" | "STDEV_S" => format!(
                "SELECT STDDEV_SAMP(TRY_CAST({} AS DOUBLE)) FROM data WHERE _row_index BETWEEN ? AND ?",
                quoted_col
            ),
            "STDEV_P" => format!(
                "SELECT STDDEV_POP(TRY_CAST({} AS DOUBLE)) FROM data WHERE _row_index BETWEEN ? AND ?",
                quoted_col
            ),
            "VAR" | "VAR_S" => format!(
                "SELECT VAR_SAMP(TRY_CAST({} AS DOUBLE)) FROM data WHERE _row_index BETWEEN ? AND ?",
                quoted_col
            ),
            "VAR_P" => format!(
                "SELECT VAR_POP(TRY_CAST({} AS DOUBLE)) FROM data WHERE _row_index BETWEEN ? AND ?",
                quoted_col
            ),
            "MIN" => format!(
                "SELECT MIN(TRY_CAST({} AS DOUBLE)) FROM data WHERE _row_index BETWEEN ? AND ?",
                quoted_col
            ),
            "MAX" => format!(
                "SELECT MAX(TRY_CAST({} AS DOUBLE)) FROM data WHERE _row_index BETWEEN ? AND ?",
                quoted_col
            ),
            _ => return Err(format!("Unsupported aggregate function: {}", func)),
        };

        let result: Option<f64> = conn
            .query_row(&sql, [start_row as i64, end_row as i64], |row| row.get(0))
            .map_err(|e| format!("Aggregate range query failed: {}", e))?;

        Ok(result.unwrap_or(0.0))
    }

    /// Compute aggregate over an explicit list of model row indices.
    ///
    /// This is used for sorted/grouped view ranges where rows are not contiguous.
    pub fn get_column_aggregate_rows(
        &self,
        dataset_id: &str,
        column_id: &str,
        func: &str,
        row_indices: Vec<usize>,
    ) -> Result<f64, String> {
        if row_indices.is_empty() {
            return Ok(0.0);
        }

        // CRITICAL: Flush overlay first to ensure pending edits are in DuckDB
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        self.flush_overlay(&namespaced_key)?;

        // Check if dataset exists and is DuckDB type
        {
            let datasets = self.datasets.read().unwrap();
            match datasets.get(&namespaced_key) {
                Some(DatasetStorage::DuckDB { .. }) => {} // Continue
                Some(DatasetStorage::InMemory { .. }) => {
                    return Err("Async aggregate not supported for in-memory datasets".to_string());
                }
                None => return Err(format!("Dataset '{}' not found", dataset_id)),
            }
        } // Release datasets lock before getting connection

        let conn_arc = self.get_connection(&namespaced_key)?;
        let conn = conn_arc.lock().unwrap();

        let quoted_col = Self::quote_identifier(column_id);

        let chunk_size = 10_000usize;
        let mut total_count_numeric: i64 = 0;
        let mut total_count_any: i64 = 0;
        let mut total_sum: f64 = 0.0;
        let mut total_sum_sq: f64 = 0.0;
        let mut total_min: Option<f64> = None;
        let mut total_max: Option<f64> = None;

        for chunk in row_indices.chunks(chunk_size) {
            let rows_sql = chunk
                .iter()
                .map(|r| r.to_string())
                .collect::<Vec<_>>()
                .join(", ");

            let sql = format!(
                "SELECT \
                    COUNT(TRY_CAST({col} AS DOUBLE)) AS cnt, \
                    SUM(TRY_CAST({col} AS DOUBLE)) AS sum, \
                    SUM(TRY_CAST({col} AS DOUBLE) * TRY_CAST({col} AS DOUBLE)) AS sumsq, \
                    COUNT({col}) AS counta, \
                    MIN(TRY_CAST({col} AS DOUBLE)) AS min_val, \
                    MAX(TRY_CAST({col} AS DOUBLE)) AS max_val \
                 FROM data \
                 WHERE _row_index IN ({rows})",
                col = quoted_col,
                rows = rows_sql
            );

            let (cnt, sum, sumsq, counta, min_val, max_val): (
                i64,
                Option<f64>,
                Option<f64>,
                i64,
                Option<f64>,
                Option<f64>,
            ) = conn
                .query_row(&sql, [], |row| {
                    let cnt: i64 = row.get(0)?;
                    let sum: Option<f64> = row.get(1)?;
                    let sumsq: Option<f64> = row.get(2)?;
                    let counta: i64 = row.get(3)?;
                    let min_val: Option<f64> = row.get(4)?;
                    let max_val: Option<f64> = row.get(5)?;
                    Ok((cnt, sum, sumsq, counta, min_val, max_val))
                })
                .map_err(|e| format!("Aggregate rows query failed: {}", e))?;

            total_count_numeric += cnt;
            total_count_any += counta;
            total_sum += sum.unwrap_or(0.0);
            total_sum_sq += sumsq.unwrap_or(0.0);
            if let Some(v) = min_val {
                total_min = Some(total_min.map_or(v, |m| m.min(v)));
            }
            if let Some(v) = max_val {
                total_max = Some(total_max.map_or(v, |m| m.max(v)));
            }
        }

        let func_upper = func.to_uppercase();
        let n = total_count_numeric as f64;

        let result = match func_upper.as_str() {
            "SUM" => total_sum,
            "AVG" | "AVERAGE" => {
                if total_count_numeric == 0 {
                    0.0
                } else {
                    total_sum / n
                }
            }
            "COUNT" => total_count_numeric as f64,
            "COUNTA" => total_count_any as f64,
            "STDEV" | "STDEV_S" => {
                if total_count_numeric <= 1 {
                    0.0
                } else {
                    let var = (total_sum_sq - (total_sum * total_sum) / n) / (n - 1.0);
                    var.max(0.0).sqrt()
                }
            }
            "STDEV_P" => {
                if total_count_numeric == 0 {
                    0.0
                } else {
                    let var = (total_sum_sq - (total_sum * total_sum) / n) / n;
                    var.max(0.0).sqrt()
                }
            }
            "VAR" | "VAR_S" => {
                if total_count_numeric <= 1 {
                    0.0
                } else {
                    (total_sum_sq - (total_sum * total_sum) / n) / (n - 1.0)
                }
            }
            "VAR_P" => {
                if total_count_numeric == 0 {
                    0.0
                } else {
                    (total_sum_sq - (total_sum * total_sum) / n) / n
                }
            }
            "MIN" => total_min.unwrap_or(0.0),
            "MAX" => total_max.unwrap_or(0.0),
            _ => return Err(format!("Unsupported aggregate function: {}", func)),
        };

        Ok(result)
    }

    /// Get classification statistics for all columns in a dataset
    ///
    /// Uses DuckDB to efficiently compute:
    /// - Total row count
    /// - Non-NULL count per column
    /// - Distinct value count per column
    /// - Numeric value count (values that can be cast to DOUBLE)
    /// - Min/max numeric values
    ///
    /// CRITICAL: Flushes overlay before query to ensure consistency.
    pub fn get_all_column_stats(
        &self,
        dataset_id: &str,
    ) -> Result<Vec<ColumnClassificationStats>, String> {
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;

        // If no pending overlay edits, reuse cached stats
        if self.get_overlay_size_for_dataset(&namespaced_key) == 0 {
            if let Some(cached) = self.get_cached_column_stats(&namespaced_key) {
                return Ok(cached);
            }
        }

        // CRITICAL: Flush overlay first to ensure pending edits are in DuckDB
        self.flush_overlay(&namespaced_key)?;

        let datasets = self.datasets.read().unwrap();
        let columns = match datasets.get(&namespaced_key) {
            Some(DatasetStorage::DuckDB {
                columns, row_count, ..
            }) => {
                let cols: Vec<String> = columns
                    .iter()
                    .filter(|c| c.name != "_row_index")
                    .map(|c| c.name.clone())
                    .collect();
                let total = *row_count;
                (cols, total)
            }
            Some(DatasetStorage::InMemory { rows }) => {
                // For in-memory datasets, compute stats directly
                let total = rows.len();
                if total == 0 {
                    return Ok(Vec::new());
                }

                let cols: Vec<String> = collect_column_keys(rows);

                let mut results = Vec::new();
                for col_id in &cols {
                    let mut non_null = 0usize;
                    let mut numeric = 0usize;
                    let mut integer_count = 0usize;
                    let mut distinct_set = std::collections::HashSet::new();
                    let mut distinct_casefold_set = std::collections::HashSet::new();
                    let mut first_non_missing_row: Option<usize> = None;
                    let mut last_non_missing_row: Option<usize> = None;
                    let mut min_val: Option<f64> = None;
                    let mut max_val: Option<f64> = None;

                    for (row_idx, row) in rows.iter().enumerate() {
                        if let Some(val) = row.get(col_id) {
                            match val {
                                Value::Null => {}
                                Value::Number(n) => {
                                    non_null += 1;
                                    if first_non_missing_row.is_none() {
                                        first_non_missing_row = Some(row_idx);
                                    }
                                    last_non_missing_row = Some(row_idx);
                                    numeric += 1;
                                    let display = val.to_string();
                                    distinct_set.insert(display.clone());
                                    distinct_casefold_set.insert(display.to_lowercase());
                                    if let Some(f) = n.as_f64() {
                                        if f.fract().abs() < f64::EPSILON {
                                            integer_count += 1;
                                        }
                                        min_val = Some(min_val.map_or(f, |m: f64| m.min(f)));
                                        max_val = Some(max_val.map_or(f, |m: f64| m.max(f)));
                                    }
                                }
                                Value::String(s) => {
                                    if Self::is_missing_string(s) {
                                        continue;
                                    }
                                    let trimmed = s.trim();
                                    non_null += 1;
                                    if first_non_missing_row.is_none() {
                                        first_non_missing_row = Some(row_idx);
                                    }
                                    last_non_missing_row = Some(row_idx);
                                    distinct_set.insert(trimmed.to_string());
                                    distinct_casefold_set.insert(trimmed.to_lowercase());
                                    if let Ok(f) = trimmed.parse::<f64>() {
                                        numeric += 1;
                                        if f.fract().abs() < f64::EPSILON {
                                            integer_count += 1;
                                        }
                                        min_val = Some(min_val.map_or(f, |m: f64| m.min(f)));
                                        max_val = Some(max_val.map_or(f, |m: f64| m.max(f)));
                                    }
                                }
                                Value::Bool(b) => {
                                    non_null += 1;
                                    if first_non_missing_row.is_none() {
                                        first_non_missing_row = Some(row_idx);
                                    }
                                    last_non_missing_row = Some(row_idx);
                                    let display = b.to_string();
                                    distinct_set.insert(display.clone());
                                    distinct_casefold_set.insert(display.to_lowercase());
                                }
                                _ => {
                                    non_null += 1;
                                    if first_non_missing_row.is_none() {
                                        first_non_missing_row = Some(row_idx);
                                    }
                                    last_non_missing_row = Some(row_idx);
                                    let display = val.to_string();
                                    distinct_set.insert(display.clone());
                                    distinct_casefold_set.insert(display.to_lowercase());
                                }
                            }
                        }
                    }

                    let distinct_count = distinct_set.len();
                    let distinct_count_case_folded = distinct_casefold_set.len();
                    let mut distinct_values: Vec<String> = distinct_set.into_iter().collect();
                    distinct_values.sort();
                    if distinct_values.len() > 50 {
                        distinct_values.truncate(50);
                    }

                    results.push(ColumnClassificationStats {
                        column_id: col_id.clone(),
                        total_rows: total,
                        non_null_count: non_null,
                        distinct_count,
                        distinct_count_case_folded,
                        distinct_values,
                        numeric_count: numeric,
                        integer_count,
                        first_non_missing_row,
                        last_non_missing_row,
                        min_value: min_val,
                        max_value: max_val,
                    });
                }
                self.set_cached_column_stats(&namespaced_key, results.clone());
                return Ok(results);
            }
            None => return Err(format!("Dataset '{}' not found", dataset_id)),
        };

        let (col_ids, total_rows) = columns;
        drop(datasets); // Release lock before getting connection

        if col_ids.is_empty() {
            return Ok(Vec::new());
        }

        // Use pooled connection for DuckDB
        let conn_arc = self.get_connection(&namespaced_key)?;
        let conn = conn_arc.lock().unwrap();

        let mut results = Vec::new();

        // Query each column's stats (DuckDB is fast enough for this)
        for col_id in &col_ids {
            let quoted_col = Self::quote_identifier(col_id);
            let trimmed_expr = format!("TRIM(CAST({} AS VARCHAR))", quoted_col);
            let missing_list = MISSING_VALUE_INDICATORS
                .iter()
                .map(|v| format!("'{}'", v.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(", ");
            let missing_predicate = format!(
                "{col} IS NULL OR {trim} = '' OR LOWER({trim}) IN ({missing_list})",
                col = quoted_col,
                trim = trimmed_expr,
                missing_list = missing_list
            );
            let value_expr = format!(
                "CASE WHEN {missing_predicate} THEN NULL ELSE {trim} END",
                missing_predicate = missing_predicate,
                trim = trimmed_expr
            );

            // Single query to get all stats for this column
            let sql = format!(
                r#"SELECT
                    COUNT({val}) as non_null_count,
                    COUNT(DISTINCT {val}) as distinct_count,
                    COUNT(DISTINCT LOWER({val})) as distinct_count_case_folded,
                    COUNT(TRY_CAST({val} AS DOUBLE)) as numeric_count,
                    COUNT(CASE
                      WHEN TRY_CAST({val} AS DOUBLE) IS NOT NULL
                       AND TRY_CAST({val} AS DOUBLE) = FLOOR(TRY_CAST({val} AS DOUBLE))
                      THEN 1
                    END) as integer_count,
                    MIN(CASE WHEN {val} IS NOT NULL THEN _row_index END) as first_non_missing_row,
                    MAX(CASE WHEN {val} IS NOT NULL THEN _row_index END) as last_non_missing_row,
                    MIN(TRY_CAST({val} AS DOUBLE)) as min_val,
                    MAX(TRY_CAST({val} AS DOUBLE)) as max_val
                FROM data"#,
                val = value_expr
            );

            let stats = conn
                .query_row(&sql, [], |row| {
                    let non_null: i64 = row.get(0)?;
                    let distinct: i64 = row.get(1)?;
                    let distinct_case_folded: i64 = row.get(2)?;
                    let numeric: i64 = row.get(3)?;
                    let integer_count: i64 = row.get(4)?;
                    let first_non_missing_row: Option<i64> = row.get(5).ok();
                    let last_non_missing_row: Option<i64> = row.get(6).ok();
                    let min_v: Option<f64> = row.get(7).ok();
                    let max_v: Option<f64> = row.get(8).ok();
                    Ok((
                        non_null,
                        distinct,
                        distinct_case_folded,
                        numeric,
                        integer_count,
                        first_non_missing_row,
                        last_non_missing_row,
                        min_v,
                        max_v,
                    ))
                })
                .map_err(|e| format!("Stats query failed for {}: {}", col_id, e))?;

            let distinct_sql = format!(
                r#"SELECT DISTINCT {val} as v
                FROM data
                WHERE {val} IS NOT NULL
                ORDER BY v
                LIMIT 50"#,
                val = value_expr
            );

            let mut distinct_values: Vec<String> = Vec::new();
            let mut stmt = conn
                .prepare(&distinct_sql)
                .map_err(|e| format!("Distinct values query failed for {}: {}", col_id, e))?;
            let distinct_iter = stmt
                .query_map([], |row| {
                    let value: String = row.get(0)?;
                    Ok(value)
                })
                .map_err(|e| format!("Distinct values query failed for {}: {}", col_id, e))?;
            for value in distinct_iter {
                if let Ok(value) = value {
                    if !value.is_empty() {
                        distinct_values.push(value);
                    }
                }
            }

            results.push(ColumnClassificationStats {
                column_id: col_id.clone(),
                total_rows,
                non_null_count: stats.0 as usize,
                distinct_count: stats.1 as usize,
                distinct_count_case_folded: stats.2 as usize,
                distinct_values,
                numeric_count: stats.3 as usize,
                integer_count: stats.4 as usize,
                first_non_missing_row: stats.5.and_then(|v| usize::try_from(v).ok()),
                last_non_missing_row: stats.6.and_then(|v| usize::try_from(v).ok()),
                min_value: stats.7,
                max_value: stats.8,
            });
        }

        self.set_cached_column_stats(&namespaced_key, results.clone());
        Ok(results)
    }

    /// Get duplicate summary for a single column.
    ///
    /// - Trims string values
    /// - Ignores NULL/empty values
    /// - Returns number of duplicate IDs and duplicate rows
    /// - Returns top duplicate examples by frequency
    pub fn get_column_duplicate_summary(
        &self,
        dataset_id: &str,
        column_id: &str,
        max_examples: usize,
    ) -> Result<ColumnDuplicateSummary, String> {
        let namespaced_key = self.resolve_namespaced_key(dataset_id)?;
        let capped_examples = max_examples.clamp(1, 20);

        // Include pending edits for DuckDB-backed datasets.
        self.flush_overlay(&namespaced_key)?;

        let datasets = self.datasets.read().unwrap();
        match datasets.get(&namespaced_key) {
            Some(DatasetStorage::InMemory { rows }) => {
                let mut counts: HashMap<String, usize> = HashMap::new();
                for row in rows {
                    let Some(value) = row.get(column_id) else {
                        continue;
                    };
                    let normalized = match value {
                        Value::Null => String::new(),
                        Value::String(s) => s.trim().to_string(),
                        _ => value.to_string().trim().to_string(),
                    };
                    if normalized.is_empty() {
                        continue;
                    }
                    *counts.entry(normalized).or_insert(0) += 1;
                }

                let non_empty_count = counts.values().sum();
                let mut duplicates: Vec<(String, usize)> =
                    counts.into_iter().filter(|(_, c)| *c > 1).collect();
                duplicates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

                let duplicate_id_count = duplicates.len();
                let duplicate_row_count = duplicates
                    .iter()
                    .map(|(_, count)| count.saturating_sub(1))
                    .sum();
                let duplicate_examples = duplicates
                    .into_iter()
                    .take(capped_examples)
                    .map(|(label, _)| label)
                    .collect();

                Ok(ColumnDuplicateSummary {
                    duplicate_id_count,
                    duplicate_row_count,
                    duplicate_examples,
                    non_empty_count,
                })
            }
            Some(DatasetStorage::DuckDB { .. }) => {
                drop(datasets);
                let conn_arc = self.get_connection(&namespaced_key)?;
                let conn = conn_arc.lock().unwrap();

                let quoted_col = Self::quote_identifier(column_id);
                let value_expr = format!("TRIM(CAST({} AS VARCHAR))", quoted_col);
                let where_clause = format!("{v} IS NOT NULL AND {v} <> ''", v = value_expr);

                let summary_sql = format!(
                    r#"WITH normalized AS (
                        SELECT {value_expr} AS label
                        FROM data
                        WHERE {where_clause}
                    ),
                    dup_counts AS (
                        SELECT label, COUNT(*) AS cnt
                        FROM normalized
                        GROUP BY label
                        HAVING COUNT(*) > 1
                    )
                    SELECT
                        (SELECT COUNT(*) FROM normalized) AS non_empty_count,
                        (SELECT COUNT(*) FROM dup_counts) AS duplicate_id_count,
                        (SELECT COALESCE(SUM(cnt - 1), 0) FROM dup_counts) AS duplicate_row_count"#,
                    value_expr = value_expr,
                    where_clause = where_clause
                );

                let (non_empty_count, duplicate_id_count, duplicate_row_count): (i64, i64, i64) =
                    conn.query_row(&summary_sql, [], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })
                    .map_err(|e| {
                        format!("Duplicate summary query failed for {}: {}", column_id, e)
                    })?;

                let examples_sql = format!(
                    r#"SELECT label
                    FROM (
                        SELECT {value_expr} AS label, COUNT(*) AS cnt
                        FROM data
                        WHERE {where_clause}
                        GROUP BY label
                        HAVING COUNT(*) > 1
                    )
                    ORDER BY cnt DESC, label ASC
                    LIMIT {limit}"#,
                    value_expr = value_expr,
                    where_clause = where_clause,
                    limit = capped_examples
                );

                let mut stmt = conn.prepare(&examples_sql).map_err(|e| {
                    format!("Duplicate examples query failed for {}: {}", column_id, e)
                })?;
                let rows = stmt
                    .query_map([], |row| {
                        let value: String = row.get(0)?;
                        Ok(value)
                    })
                    .map_err(|e| {
                        format!("Duplicate examples query failed for {}: {}", column_id, e)
                    })?;

                let mut duplicate_examples = Vec::new();
                for value in rows {
                    if let Ok(value) = value {
                        if !value.is_empty() {
                            duplicate_examples.push(value);
                        }
                    }
                }

                Ok(ColumnDuplicateSummary {
                    duplicate_id_count: duplicate_id_count.max(0) as usize,
                    duplicate_row_count: duplicate_row_count.max(0) as usize,
                    duplicate_examples,
                    non_empty_count: non_empty_count.max(0) as usize,
                })
            }
            None => Err(format!("Dataset '{}' not found", dataset_id)),
        }
    }

    fn schedule_column_stats_prewarm(&self, dataset_id: &str, row_count: usize) {
        if self
            .prewarm_disabled_datasets
            .lock()
            .unwrap()
            .contains(dataset_id)
        {
            log::debug!(
                "Skipping column stats prewarm for '{}' (session circuit breaker)",
                dataset_id
            );
            return;
        }
        if row_count >= PREWARM_SKIP_ROW_THRESHOLD {
            log::info!(
                "Skipping column stats prewarm for '{}' (rows: {})",
                dataset_id,
                row_count
            );
            return;
        }
        self.prewarm_column_stats_async(dataset_id);
    }

    /// Prewarm column classification stats in the background (optional).
    /// Uses the global cache instance to avoid lifetime issues in spawned threads.
    pub fn prewarm_column_stats_async(&self, dataset_id: &str) {
        let Some(namespaced_key) = self.resolve_namespaced_key_optional(dataset_id) else {
            return;
        };
        {
            let mut inflight = self.prewarm_inflight.lock().unwrap();
            if inflight.contains(&namespaced_key) {
                return;
            }
            inflight.insert(namespaced_key.clone());
        }
        let dataset_key = namespaced_key.clone();
        std::thread::spawn(move || {
            let _guard = PrewarmGuard::new(&HYBRID_CACHE, dataset_key.clone());
            std::thread::sleep(Duration::from_millis(PREWARM_COLUMN_STATS_DELAY_MS));
            let datasets = HYBRID_CACHE.datasets.read().unwrap();
            if !datasets.contains_key(&dataset_key) {
                return;
            }
            drop(datasets);
            if let Err(err) = HYBRID_CACHE.get_all_column_stats(&dataset_key) {
                log::warn!("Column stats prewarm failed for '{}': {}", dataset_key, err);
            }
        });
    }

    // ========================================================================
    // INTERNAL HELPERS
    // ========================================================================

    /// Convert row-oriented data to column-oriented data.
    fn rows_to_columns(rows: &[HashMap<String, Value>]) -> HashMap<String, Vec<Value>> {
        let mut keys: Vec<String> = Vec::new();
        for row in rows {
            for key in row.keys() {
                if !keys.contains(key) {
                    keys.push(key.clone());
                }
            }
        }

        let mut result: HashMap<String, Vec<Value>> = HashMap::new();
        for key in &keys {
            result.insert(key.clone(), Vec::with_capacity(rows.len()));
        }

        for row in rows {
            for key in &keys {
                let value = row.get(key).cloned().unwrap_or(Value::Null);
                if let Some(col) = result.get_mut(key) {
                    col.push(value);
                }
            }
        }

        result
    }

    /// Compute percentile (0-1) with linear interpolation.
    fn percentile(sorted: &[f64], p: f64) -> f64 {
        if sorted.is_empty() {
            return f64::NAN;
        }
        if sorted.len() == 1 {
            return sorted[0];
        }
        let clamped = p.max(0.0).min(1.0);
        let rank = clamped * (sorted.len() as f64 - 1.0);
        let lower = rank.floor() as usize;
        let upper = rank.ceil() as usize;
        if lower == upper {
            return sorted[lower];
        }
        let weight = rank - lower as f64;
        sorted[lower] + (sorted[upper] - sorted[lower]) * weight
    }

    /// Store rows in file-backed DuckDB (called for large datasets)
    ///
    /// CRITICAL: Assumes rows already use col-{idx} format as keys (from standard import path).
    /// Uses proper quoting instead of sanitization to preserve col-{idx} format.
    fn store_in_duckdb(
        &self,
        dataset_id: &str,
        rows: Vec<HashMap<String, Value>>,
    ) -> Result<(), String> {
        let operation_guard = self.current_purge_generation();
        let namespaced_key = self.get_namespaced_key(dataset_id)?;
        if rows.is_empty() {
            return Err("Dataset is empty".to_string());
        }

        let db_path = self.resolve_duckdb_path_for_dataset(dataset_id);
        self.ensure_duckdb_parent_dir(&db_path)?;

        // Remove old DB file if exists
        let _ = std::fs::remove_file(&db_path);

        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

        // Configure DuckDB
        conn.execute_batch(
            r#"
            SET memory_limit = '4GB';
            SET threads = 4;
        "#,
        )
        .map_err(|e| e.to_string())?;

        // Get columns from all rows (union of keys) to avoid dropping sparse columns
        let columns: Vec<String> = collect_column_keys(&rows);

        // Infer types from sample of rows
        let column_types = self.infer_column_types(&rows, &columns);

        // Create table with proper types and 0-based _row_index
        // CRITICAL: Use quote_identifier to preserve col-{idx} format (no sanitization)
        let col_defs: Vec<String> = columns
            .iter()
            .zip(column_types.iter())
            .map(|(name, dtype)| format!("{} {}", Self::quote_identifier(name), dtype))
            .collect();

        let create_sql = format!(
            "CREATE TABLE data (_row_index BIGINT PRIMARY KEY, {})",
            col_defs.join(", ")
        );

        conn.execute(&create_sql, []).map_err(|e| e.to_string())?;

        // Insert rows in batches
        conn.execute("BEGIN TRANSACTION", [])
            .map_err(|e| e.to_string())?;

        for (idx, row) in rows.iter().enumerate() {
            let mut col_names = vec!["_row_index".to_string()];
            let mut values: Vec<String> = vec![idx.to_string()];

            for col in &columns {
                // Use quote_identifier to preserve col-{idx} format
                col_names.push(Self::quote_identifier(col));

                let val = row.get(col).cloned().unwrap_or(Value::Null);
                let val_str = match val {
                    Value::Null => "NULL".to_string(),
                    Value::Bool(b) => b.to_string(),
                    Value::Number(n) => n.to_string(),
                    Value::String(s) => format!("'{}'", s.replace('\'', "''")),
                    _ => format!("'{}'", val.to_string().replace('\'', "''")),
                };
                values.push(val_str);
            }

            // Use direct SQL for simplicity (values are escaped)
            let insert_sql = format!(
                "INSERT INTO data ({}) VALUES ({})",
                col_names.join(", "),
                values.join(", ")
            );

            conn.execute(&insert_sql, []).map_err(|e| e.to_string())?;
        }

        conn.execute("COMMIT", []).map_err(|e| e.to_string())?;

        // Create index for fast range queries
        conn.execute("CREATE INDEX idx_row_index ON data(_row_index)", [])
            .map_err(|e| e.to_string())?;

        // Update registry
        // For in-memory datasets converted to DuckDB, column names are already col-{idx} format
        // So display_name = name (both are col-{idx})
        let mut datasets = self.datasets.write().unwrap();
        self.ensure_guard_or_cleanup(operation_guard, "store_in_duckdb", &db_path)?;
        datasets.insert(
            namespaced_key.clone(),
            DatasetStorage::DuckDB {
                db_path: db_path.clone(),
                _table_name: "data".to_string(),
                columns: columns
                    .iter()
                    .zip(column_types.iter())
                    .map(|(name, dtype)| ColumnInfo {
                        name: name.clone(),
                        display_name: name.clone(), // For in-memory conversion, they're the same
                        dtype: dtype.clone(),
                    })
                    .collect(),
                row_count: rows.len(),
            },
        );
        drop(datasets);
        self.register_disk_cache_entry(&namespaced_key, &db_path);
        self.invalidate_column_stats_cache(dataset_id);

        Ok(())
    }

    /// Infer column types from sample of rows
    fn infer_column_types(
        &self,
        rows: &[HashMap<String, Value>],
        columns: &[String],
    ) -> Vec<String> {
        columns
            .iter()
            .map(|col| {
                // Sample first 100 rows
                let mut has_int = false;
                let mut has_float = false;
                let mut has_bool = false;
                let mut has_string = false;

                for row in rows.iter().take(100) {
                    match row.get(col) {
                        Some(Value::Number(n)) => {
                            if n.is_f64() && n.as_f64().map(|f| f.fract() != 0.0).unwrap_or(false) {
                                has_float = true;
                            } else {
                                has_int = true;
                            }
                        }
                        Some(Value::Bool(_)) => has_bool = true,
                        Some(Value::String(s)) => {
                            // Check if string is actually a number
                            if s.parse::<i64>().is_ok() {
                                has_int = true;
                            } else if s.parse::<f64>().is_ok() {
                                has_float = true;
                            } else {
                                has_string = true;
                            }
                        }
                        _ => {}
                    }
                }

                // Determine type (prefer numeric for proper sorting)
                if has_string {
                    "VARCHAR".to_string()
                } else if has_float {
                    "DOUBLE".to_string()
                } else if has_int {
                    "BIGINT".to_string()
                } else if has_bool {
                    "BOOLEAN".to_string()
                } else {
                    "VARCHAR".to_string()
                }
            })
            .collect()
    }

    /// Get column info from DuckDB "data" table (after column renaming)
    /// Used for compatibility - columns already renamed to col-{idx}
    fn get_table_columns(conn: &Connection) -> Result<Vec<ColumnInfo>, String> {
        let mut stmt = conn.prepare("DESCRIBE data").map_err(|e| e.to_string())?;

        let columns: Vec<ColumnInfo> = stmt
            .query_map([], |row| {
                let name: String = row.get(0)?;
                let dtype: String = row.get(1)?;
                Ok(ColumnInfo {
                    display_name: name.clone(), // For already-renamed columns, display_name = name
                    name,
                    dtype,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(columns)
    }

    /// Get raw column info from any DuckDB table (before renaming)
    /// Returns basic column info with name and dtype only
    fn get_table_columns_raw(
        &self,
        conn: &Connection,
        table_name: &str,
    ) -> Result<Vec<ColumnInfo>, String> {
        let sql = format!("DESCRIBE {}", Self::quote_identifier(table_name));
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

        let columns: Vec<ColumnInfo> = stmt
            .query_map([], |row| {
                let name: String = row.get(0)?;
                let dtype: String = row.get(1)?;
                Ok(ColumnInfo {
                    display_name: name.clone(),
                    name,
                    dtype,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(columns)
    }

    /// Convert DuckDB row value to serde_json::Value with proper typing
    #[allow(dead_code)]
    fn duckdb_value_to_json(&self, row: &duckdb::Row, idx: usize) -> Value {
        Self::duckdb_value_to_json_static(row, idx)
    }

    /// Static version of duckdb_value_to_json (doesn't require &self)
    /// Used in closures where capturing &self would create lifetime issues
    fn duckdb_value_to_json_static(row: &duckdb::Row, idx: usize) -> Value {
        // IMPORTANT: Use DuckDB's typed Value to avoid implicit casts.
        // This preserves VARCHAR values (e.g., "dead"/"alive") as text and
        // keeps BOOLEAN/NUMERIC columns typed without coercing strings.
        let value: duckdb::types::Value = row.get(idx).unwrap_or(duckdb::types::Value::Null);

        match value {
            duckdb::types::Value::Null => Value::Null,
            duckdb::types::Value::Boolean(b) => Value::Bool(b),

            duckdb::types::Value::TinyInt(n) => Value::Number((n as i64).into()),
            duckdb::types::Value::SmallInt(n) => Value::Number((n as i64).into()),
            duckdb::types::Value::Int(n) => Value::Number((n as i64).into()),
            duckdb::types::Value::BigInt(n) => Value::Number(n.into()),
            duckdb::types::Value::UTinyInt(n) => Value::Number((n as u64).into()),
            duckdb::types::Value::USmallInt(n) => Value::Number((n as u64).into()),
            duckdb::types::Value::UInt(n) => Value::Number((n as u64).into()),
            duckdb::types::Value::UBigInt(n) => Value::Number(n.into()),
            duckdb::types::Value::Float(n) => serde_json::Number::from_f64(n as f64)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            duckdb::types::Value::Double(n) => serde_json::Number::from_f64(n)
                .map(Value::Number)
                .unwrap_or(Value::Null),

            duckdb::types::Value::Text(s) => Value::String(s),

            duckdb::types::Value::Date32(days) => {
                use chrono::NaiveDate;
                let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).expect("1970-01-01 is valid");
                let date = epoch + chrono::Duration::days(days as i64);
                Value::String(date.format("%Y-%m-%d").to_string())
            }
            duckdb::types::Value::Time64(_, micros) => {
                use chrono::NaiveTime;
                let secs = (micros / 1_000_000) as u32;
                let nanos = ((micros % 1_000_000) * 1000) as u32;
                let text = NaiveTime::from_num_seconds_from_midnight_opt(secs, nanos)
                    .map(|t| t.format("%H:%M:%S%.f").to_string())
                    .unwrap_or_else(|| format!("{} microseconds", micros));
                Value::String(text)
            }
            duckdb::types::Value::Timestamp(_, micros) => {
                use chrono::{DateTime, Utc};
                let secs = micros / 1_000_000;
                let nsecs = ((micros % 1_000_000) * 1000) as u32;
                let text = DateTime::<Utc>::from_timestamp(secs, nsecs)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_else(|| format!("{} microseconds", micros));
                Value::String(text)
            }
            duckdb::types::Value::Interval {
                months,
                days,
                nanos,
            } => Value::String(format!("{months} months {days} days {nanos} nanos")),

            other => Value::String(format!("{other:?}")),
        }
    }

    // ========================================================================
    // PHASE 6: BACKEND FORMULA EVALUATION
    // ========================================================================

    /// Evaluate formula on backend using Formualizer engine
    ///
    /// Uses DuckDB-backed EvaluationContext with view->model row mapping.
    /// Data is materialized from DuckDB for range resolution.
    ///
    /// # Arguments
    /// * `dataset_id` - Dataset identifier
    /// * `formula` - Formula string (WITH leading =)
    /// * `view_position` - Cell position in VIEW coords (0-based row, 0-based col)
    ///                     This is where the formula is entered, used for relative refs
    /// * `column_letter_to_id_map` - Column letter -> column ID mapping
    /// * `row_order_slice` - Row order slice for view->model mapping (start_offset is 0-based)
    pub async fn evaluate_formula_backend(
        &self,
        dataset_id: &str,
        formula: &str,
        view_position: crate::modules::commands::cache_commands::CellPosition,
        column_letter_to_id_map: std::collections::HashMap<String, String>,
        row_order_slice: Option<(usize, Vec<usize>)>,
        total_rows: Option<usize>,
    ) -> Result<Value, String> {
        // Get DuckDB connection for this dataset
        let conn = self.get_connection(dataset_id)?;
        {
            let guard = conn
                .lock()
                .map_err(|_| "DuckDB connection lock poisoned".to_string())?;
            Self::ensure_row_order_table(&guard)?;
        }

        // Get row count for bounds checking
        let actual_row_count = self
            .get_row_count(dataset_id)
            .ok_or_else(|| format!("Dataset '{}' not found", dataset_id))?;
        let row_count = total_rows
            .map(|rows| rows.max(actual_row_count))
            .unwrap_or(actual_row_count);

        // Delegate to formula_backend module
        // view_position is passed directly (0-based VIEW coords)
        crate::modules::formula_backend::evaluate_formula(
            conn,
            dataset_id,
            formula,
            (view_position.row, view_position.col),
            column_letter_to_id_map,
            row_order_slice,
            row_count,
        )
    }
}

impl Default for HybridCacheManager {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// PHASE 5: AUTO-FLUSH BACKGROUND TASK
// ============================================================================

/// Spawn background task for time-based auto-flush
/// Phase 5: Flushes overlay every 5 minutes if non-empty (prevents data loss)
pub fn spawn_auto_flush_task() {
    use std::thread;
    use std::time::Duration;

    thread::spawn(|| {
        log::info!(
            "Auto-flush task started (every {} seconds, threshold {} edits)",
            OVERLAY_FLUSH_INTERVAL_SECS,
            OVERLAY_FLUSH_THRESHOLD
        );

        loop {
            thread::sleep(Duration::from_secs(OVERLAY_FLUSH_INTERVAL_SECS));

            // Only flush if overlay has entries (avoid disk churn)
            let overlay_size = HYBRID_CACHE.get_overlay_size();
            if overlay_size > 0 {
                log::info!("Auto-flush triggered ({} pending edits)", overlay_size);
                if let Err(e) = HYBRID_CACHE.flush_all_overlays() {
                    log::error!("Auto-flush failed: {}", e);
                }
            }
        }
    });
}

/// Spawn one-time startup cache maintenance in background.
/// Keeps app startup responsive while still enforcing cache hygiene.
pub fn spawn_startup_cache_maintenance_task() {
    use std::thread;

    thread::spawn(|| {
        log::info!("Cache startup maintenance task started");
        HYBRID_CACHE.run_startup_maintenance();
        log::info!("Cache startup maintenance task completed");
    });
}

// ============================================================================
// GLOBAL INSTANCE
// ============================================================================

lazy_static! {
    pub static ref HYBRID_CACHE: HybridCacheManager = HybridCacheManager::new();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    #[test]
    fn duckdb_cache_dir_keeps_release_path_compatible() {
        let base = PathBuf::from("local-data");

        assert_eq!(
            duckdb_cache_dir_for_profile(base, "release"),
            PathBuf::from("local-data")
                .join("easyCris")
                .join("duckdb_cache")
        );
    }

    #[test]
    fn duckdb_cache_dir_isolates_dev_and_e2e_profiles() {
        let base = PathBuf::from("local-data");

        assert_eq!(
            duckdb_cache_dir_for_profile(base.clone(), "dev"),
            PathBuf::from("local-data")
                .join("easyCris-dev")
                .join("duckdb_cache")
        );
        assert_eq!(
            duckdb_cache_dir_for_profile(base, "e2e"),
            PathBuf::from("local-data")
                .join("easyCris-e2e")
                .join("duckdb_cache")
        );
    }

    #[test]
    #[should_panic(expected = "unknown EASYCRIS_BUILD_PROFILE value")]
    fn duckdb_cache_dir_rejects_unknown_profiles() {
        let _ = duckdb_cache_dir_for_profile(PathBuf::from("local-data"), "staging");
    }

    #[test]
    fn test_small_dataset_uses_memory() {
        let cache = HybridCacheManager::new();
        let mut row = HashMap::new();
        row.insert("col_a".to_string(), Value::from(1.5));

        cache.set_dataset("test", vec![row]);
        assert!(!cache.is_large_dataset("test"));
    }

    #[test]
    fn test_has_dataset() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("test-project-has-dataset");
        assert!(!cache.has_dataset("nonexistent"));

        let mut row = HashMap::new();
        row.insert("x".to_string(), Value::from(1.0));
        cache.set_dataset("test", vec![row]);

        assert!(cache.has_dataset("test"));
    }

    #[test]
    fn test_get_row_count() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("test-project-get-row-count");
        let mut row = HashMap::new();
        row.insert("x".to_string(), Value::from(1.0));

        cache.set_dataset("test", vec![row.clone(), row]);
        assert_eq!(cache.get_row_count("test"), Some(2));
    }

    #[test]
    fn test_append_rows_in_memory_does_not_shift_existing_data() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("test-project-append-rows");

        let mut row1 = HashMap::new();
        row1.insert("col_a".to_string(), Value::from("r1"));
        let mut row2 = HashMap::new();
        row2.insert("col_a".to_string(), Value::from("r2"));
        cache.set_dataset("test", vec![row1, row2]);

        let new_count = cache
            .append_rows("test", 2)
            .expect("append_rows should succeed");
        assert_eq!(new_count, 4);

        let dataset = cache.get_dataset("test").unwrap();
        assert_eq!(dataset[0].get("col_a"), Some(&Value::from("r1")));
        assert_eq!(dataset[1].get("col_a"), Some(&Value::from("r2")));
        assert!(dataset[2].is_empty());
        assert!(dataset[3].is_empty());
    }

    #[test]
    fn test_append_rows_in_memory_zero_count_is_noop() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("test-project-append-rows-noop");

        let mut row = HashMap::new();
        row.insert("col_a".to_string(), Value::from("r1"));
        cache.set_dataset("test", vec![row]);

        let new_count = cache
            .append_rows("test", 0)
            .expect("append_rows should succeed");
        assert_eq!(new_count, 1);

        let dataset = cache.get_dataset("test").unwrap();
        assert_eq!(dataset.len(), 1);
        assert_eq!(dataset[0].get("col_a"), Some(&Value::from("r1")));
    }

    #[test]
    fn test_append_rows_duckdb_appends_rows_and_updates_count() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-append-rows-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-append-rows-{}", Uuid::new_v4());
        cache.set_active_project_id(&project_id);

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 2)
            .expect("initial append_rows should succeed");
        cache
            .update_cell(&dataset_id, 0, "col-0", Value::from("r0"))
            .expect("update row 0 should succeed");
        cache
            .update_cell(&dataset_id, 1, "col-0", Value::from("r1"))
            .expect("update row 1 should succeed");

        let new_count = cache
            .append_rows(&dataset_id, 2)
            .expect("append_rows should succeed");
        assert_eq!(new_count, 4);
        assert_eq!(cache.get_row_count(&dataset_id), Some(4));

        let rows = cache
            .get_rows_range(&dataset_id, 0, 4)
            .expect("rows should be available");
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("r0")));
        assert_eq!(rows[1].get("col-0"), Some(&Value::from("r1")));
        assert_eq!(rows[2].get("col-0"), Some(&Value::Null));
        assert_eq!(rows[3].get("col-0"), Some(&Value::Null));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
    }

    #[test]
    fn test_append_rows_duckdb_zero_count_is_noop() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-append-rows-noop-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-append-rows-noop-{}", Uuid::new_v4());
        cache.set_active_project_id(&project_id);

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 1)
            .expect("initial append_rows should succeed");

        let new_count = cache
            .append_rows(&dataset_id, 0)
            .expect("append_rows should succeed");
        assert_eq!(new_count, 1);
        assert_eq!(cache.get_row_count(&dataset_id), Some(1));

        let rows = cache
            .get_rows_range(&dataset_id, 0, 2)
            .expect("rows should be available");
        assert_eq!(rows.len(), 1);

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
    }

    #[test]
    fn test_remove_rows_from_end_in_memory_removes_only_tail_rows() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("test-project-remove-tail-rows");

        let mut row1 = HashMap::new();
        row1.insert("col_a".to_string(), Value::from("r1"));
        let mut row2 = HashMap::new();
        row2.insert("col_a".to_string(), Value::from("r2"));
        let mut row3 = HashMap::new();
        row3.insert("col_a".to_string(), Value::from("r3"));
        cache.set_dataset("test", vec![row1, row2, row3]);

        let new_count = cache
            .remove_rows_from_end("test", 2)
            .expect("remove_rows_from_end should succeed");
        assert_eq!(new_count, 1);

        let dataset = cache.get_dataset("test").unwrap();
        assert_eq!(dataset.len(), 1);
        assert_eq!(dataset[0].get("col_a"), Some(&Value::from("r1")));
    }

    #[test]
    fn test_remove_rows_from_end_duckdb_removes_tail_and_updates_count() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-remove-tail-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-remove-tail-{}", Uuid::new_v4());
        let project_data_dir =
            std::env::temp_dir().join(format!("easycris-duckdb-remove-tail-{}", Uuid::new_v4()));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 4)
            .expect("append_rows should succeed");
        cache
            .update_cell(&dataset_id, 0, "col-0", Value::from("r0"))
            .expect("update row 0 should succeed");
        cache
            .update_cell(&dataset_id, 1, "col-0", Value::from("r1"))
            .expect("update row 1 should succeed");

        let new_count = cache
            .remove_rows_from_end(&dataset_id, 2)
            .expect("remove_rows_from_end should succeed");
        assert_eq!(new_count, 2);
        assert_eq!(cache.get_row_count(&dataset_id), Some(2));

        let rows = cache
            .get_rows_range(&dataset_id, 0, 4)
            .expect("rows should be available");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("r0")));
        assert_eq!(rows[1].get("col-0"), Some(&Value::from("r1")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_remove_rows_from_end_duckdb_zero_count_is_noop() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-remove-tail-noop-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-remove-tail-noop-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-duckdb-remove-tail-noop-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 1)
            .expect("append_rows should succeed");

        let new_count = cache
            .remove_rows_from_end(&dataset_id, 0)
            .expect("remove_rows_from_end should succeed");
        assert_eq!(new_count, 1);
        assert_eq!(cache.get_row_count(&dataset_id), Some(1));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_remove_rows_from_end_duckdb_flushes_overlay_before_delete() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-remove-tail-flush-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-remove-tail-flush-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-duckdb-remove-tail-flush-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 3)
            .expect("append_rows should succeed");
        cache
            .update_cell(&dataset_id, 1, "col-0", Value::from("kept-overlay"))
            .expect("overlay edit should succeed");

        let new_count = cache
            .remove_rows_from_end(&dataset_id, 1)
            .expect("remove_rows_from_end should succeed");
        assert_eq!(new_count, 2);

        let rows = cache
            .get_rows_range(&dataset_id, 0, 3)
            .expect("rows should be available");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].get("col-0"), Some(&Value::from("kept-overlay")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_update_cell() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("test-project-update-cell");
        let mut row = HashMap::new();
        row.insert("col_a".to_string(), Value::from(1.0));
        cache.set_dataset("test", vec![row]);

        let result = cache.update_cell("test", 0, "col_a", Value::from(99.0));
        assert!(result.is_ok());

        let dataset = cache.get_dataset("test").unwrap();
        assert_eq!(dataset[0].get("col_a").unwrap(), &Value::from(99.0));
    }

    #[test]
    fn test_get_column_data() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("test-project-get-column-data");
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
    fn test_insert_rows_at_in_memory_inserts_count_rows_and_shifts_data() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("test-project-insert-rows-at");
        let mut row1 = HashMap::new();
        row1.insert("col_a".to_string(), Value::from("r1"));
        let mut row2 = HashMap::new();
        row2.insert("col_a".to_string(), Value::from("r2"));
        cache.set_dataset("test-insert-rows-at", vec![row1, row2]);

        let new_count = cache
            .insert_rows_at("test-insert-rows-at", 1, 2)
            .expect("insert_rows_at should succeed");
        assert_eq!(new_count, 4);

        let dataset = cache.get_dataset("test-insert-rows-at").unwrap();
        assert_eq!(dataset.len(), 4);
        assert_eq!(dataset[0].get("col_a"), Some(&Value::from("r1")));
        assert!(dataset[1].is_empty());
        assert!(dataset[2].is_empty());
        assert_eq!(dataset[3].get("col_a"), Some(&Value::from("r2")));
    }

    #[test]
    fn test_insert_rows_at_zero_count_is_noop() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("test-project-insert-rows-at-noop");
        let mut row = HashMap::new();
        row.insert("col_a".to_string(), Value::from("r1"));
        cache.set_dataset("test-insert-rows-at-noop", vec![row]);

        let new_count = cache
            .insert_rows_at("test-insert-rows-at-noop", 0, 0)
            .expect("insert_rows_at should succeed");
        assert_eq!(new_count, 1);

        let dataset = cache.get_dataset("test-insert-rows-at-noop").unwrap();
        assert_eq!(dataset.len(), 1);
        assert_eq!(dataset[0].get("col_a"), Some(&Value::from("r1")));
    }

    #[test]
    fn test_insert_rows_at_in_memory_clamps_index_beyond_length() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("test-project-insert-rows-at-clamp");
        let mut row1 = HashMap::new();
        row1.insert("col_a".to_string(), Value::from("r1"));
        let mut row2 = HashMap::new();
        row2.insert("col_a".to_string(), Value::from("r2"));
        cache.set_dataset("test-insert-rows-at-clamp", vec![row1, row2]);

        let new_count = cache
            .insert_rows_at("test-insert-rows-at-clamp", 999, 1)
            .expect("insert_rows_at should succeed");
        assert_eq!(new_count, 3);

        let dataset = cache.get_dataset("test-insert-rows-at-clamp").unwrap();
        assert_eq!(dataset.len(), 3);
        assert_eq!(dataset[0].get("col_a"), Some(&Value::from("r1")));
        assert_eq!(dataset[1].get("col_a"), Some(&Value::from("r2")));
        assert!(dataset[2].is_empty());
    }

    #[test]
    fn test_insert_rows_at_duckdb_shifts_rows_and_updates_count() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-insert-rows-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-insert-rows-{}", Uuid::new_v4());
        cache.set_active_project_id(&project_id);

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");

        cache
            .insert_rows_at(&dataset_id, 0, 2)
            .expect("initial insert_rows_at should succeed");
        cache
            .update_cell(&dataset_id, 0, "col-0", Value::from("r0"))
            .expect("update row 0 should succeed");
        cache
            .update_cell(&dataset_id, 1, "col-0", Value::from("r1"))
            .expect("update row 1 should succeed");

        let new_count = cache
            .insert_rows_at(&dataset_id, 1, 2)
            .expect("batch insert_rows_at should succeed");
        assert_eq!(new_count, 4);
        assert_eq!(cache.get_row_count(&dataset_id), Some(4));

        let rows = cache
            .get_rows_range(&dataset_id, 0, 4)
            .expect("rows should be available");
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("r0")));
        assert_eq!(rows[1].get("col-0"), Some(&Value::Null));
        assert_eq!(rows[2].get("col-0"), Some(&Value::Null));
        assert_eq!(rows[3].get("col-0"), Some(&Value::from("r1")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
    }

    #[test]
    fn test_insert_rows_at_duckdb_inserts_at_head_of_non_empty_table() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-insert-head-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-insert-head-{}", Uuid::new_v4());
        cache.set_active_project_id(&project_id);

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 2)
            .expect("append_rows should succeed");
        cache
            .update_cell(&dataset_id, 0, "col-0", Value::from("r0"))
            .expect("update row 0 should succeed");
        cache
            .update_cell(&dataset_id, 1, "col-0", Value::from("r1"))
            .expect("update row 1 should succeed");
        cache
            .flush_overlay(&dataset_id)
            .expect("flush_overlay should succeed");

        let new_count = cache
            .insert_rows_at(&dataset_id, 0, 1)
            .expect("head insert should succeed");
        assert_eq!(new_count, 3);

        let rows = cache
            .get_rows_range(&dataset_id, 0, 3)
            .expect("rows should be available");
        assert_eq!(rows[0].get("col-0"), Some(&Value::Null));
        assert_eq!(rows[1].get("col-0"), Some(&Value::from("r0")));
        assert_eq!(rows[2].get("col-0"), Some(&Value::from("r1")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
    }

    #[test]
    fn test_insert_rows_at_duckdb_preserves_physical_rows_after_middle_insert() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-logical-insert-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-logical-insert-{}", Uuid::new_v4());
        cache.set_active_project_id(&project_id);

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 3)
            .expect("append_rows should succeed");
        for row in 0..3 {
            cache
                .update_cell(&dataset_id, row, "col-0", Value::from(format!("r{}", row)))
                .expect("update_cell should succeed");
        }
        cache
            .flush_overlay(&dataset_id)
            .expect("flush_overlay should succeed");

        cache
            .insert_rows_at(&dataset_id, 1, 1)
            .expect("middle insert should succeed");

        let rows = cache
            .get_rows_range(&dataset_id, 0, 4)
            .expect("rows should be available");
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("r0")));
        assert_eq!(rows[1].get("col-0"), Some(&Value::Null));
        assert_eq!(rows[2].get("col-0"), Some(&Value::from("r1")));
        assert_eq!(rows[3].get("col-0"), Some(&Value::from("r2")));

        let namespaced_key = cache.get_namespaced_key(&dataset_id).unwrap();
        let conn_arc = cache.get_connection(&namespaced_key).unwrap();
        let conn = conn_arc.lock().unwrap();
        let physical_rows: Vec<(i64, Option<String>)> = conn
            .prepare("SELECT _row_index, \"col-0\" FROM data ORDER BY _row_index")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            physical_rows,
            vec![
                (0, Some("r0".to_string())),
                (1, Some("r1".to_string())),
                (2, Some("r2".to_string())),
                (3, None),
            ]
        );

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
    }

    #[test]
    fn test_remove_row_at_duckdb_preserves_physical_rows_after_middle_delete() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-logical-delete-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-logical-delete-{}", Uuid::new_v4());
        let project_data_dir =
            std::env::temp_dir().join(format!("easycris-duckdb-logical-delete-{}", Uuid::new_v4()));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 3)
            .expect("append_rows should succeed");
        for row in 0..3 {
            cache
                .update_cell(&dataset_id, row, "col-0", Value::from(format!("r{}", row)))
                .expect("update_cell should succeed");
        }
        cache
            .flush_overlay(&dataset_id)
            .expect("flush_overlay should succeed");

        cache
            .remove_row_at(&dataset_id, 1)
            .expect("middle delete should succeed");

        let rows = cache
            .get_rows_range(&dataset_id, 0, 3)
            .expect("rows should be available");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("r0")));
        assert_eq!(rows[1].get("col-0"), Some(&Value::from("r2")));

        let namespaced_key = cache.get_namespaced_key(&dataset_id).unwrap();
        let conn_arc = cache.get_connection(&namespaced_key).unwrap();
        let conn = conn_arc.lock().unwrap();
        let physical_rows: Vec<(i64, Option<String>)> = conn
            .prepare("SELECT _row_index, \"col-0\" FROM data ORDER BY _row_index")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            physical_rows,
            vec![(0, Some("r0".to_string())), (2, Some("r2".to_string()))]
        );

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_update_after_duckdb_middle_insert_flushes_to_logical_row() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-logical-update-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-logical-update-{}", Uuid::new_v4());
        cache.set_active_project_id(&project_id);

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 3)
            .expect("append_rows should succeed");
        for row in 0..3 {
            cache
                .update_cell(&dataset_id, row, "col-0", Value::from(format!("r{}", row)))
                .expect("update_cell should succeed");
        }
        cache
            .flush_overlay(&dataset_id)
            .expect("flush_overlay should succeed");
        cache
            .insert_rows_at(&dataset_id, 1, 1)
            .expect("middle insert should succeed");

        cache
            .update_cell(&dataset_id, 2, "col-0", Value::from("r1-updated"))
            .expect("logical row update should succeed");
        cache
            .flush_overlay(&dataset_id)
            .expect("flush_overlay should succeed");

        let rows = cache
            .get_rows_range(&dataset_id, 0, 4)
            .expect("rows should be available");
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("r0")));
        assert_eq!(rows[1].get("col-0"), Some(&Value::Null));
        assert_eq!(rows[2].get("col-0"), Some(&Value::from("r1-updated")));
        assert_eq!(rows[3].get("col-0"), Some(&Value::from("r2")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
    }

    #[test]
    fn test_remove_inserted_duckdb_row_after_edit_undo_restores_neighbors() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-logical-remove-edited-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-logical-remove-edited-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-duckdb-logical-remove-edited-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 3)
            .expect("append_rows should succeed");
        for row in 0..3 {
            cache
                .update_cell(&dataset_id, row, "col-0", Value::from(format!("r{}", row)))
                .expect("update_cell should succeed");
        }
        cache
            .flush_overlay(&dataset_id)
            .expect("flush_overlay should succeed");
        cache
            .insert_rows_at(&dataset_id, 1, 1)
            .expect("middle insert should succeed");
        cache
            .update_cell(&dataset_id, 1, "col-0", Value::from("inserted"))
            .expect("inserted row edit should succeed");
        cache
            .flush_overlay(&dataset_id)
            .expect("inserted row flush should succeed");
        cache
            .update_cell(&dataset_id, 1, "col-0", Value::Null)
            .expect("inserted row edit undo should succeed");
        cache
            .flush_overlay(&dataset_id)
            .expect("inserted row undo flush should succeed");
        cache
            .remove_row_at(&dataset_id, 1)
            .expect("remove inserted row should succeed");

        let rows = cache
            .get_rows_range(&dataset_id, 0, 3)
            .expect("rows should be available");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("r0")));
        assert_eq!(rows[1].get("col-0"), Some(&Value::from("r1")));
        assert_eq!(rows[2].get("col-0"), Some(&Value::from("r2")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_ensure_row_order_table_ignores_temp_shadow_table() {
        let conn = Connection::open_in_memory().expect("in-memory DuckDB open failed");
        conn.execute_batch(
            "CREATE TABLE data (_row_index BIGINT); \
             INSERT INTO data VALUES (0), (1); \
             CREATE TEMP TABLE row_order(physical_row BIGINT, sort_key BIGINT);",
        )
        .expect("shadow row_order setup should succeed");

        let temp_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM row_order", [], |row| row.get(0))
            .expect("unqualified row_order should resolve to temp shadow before repair");
        assert_eq!(temp_count, 0);

        HybridCacheManager::ensure_row_order_table(&conn)
            .expect("main row_order should be created despite temp shadow");

        let main_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM main.row_order", [], |row| row.get(0))
            .expect("main row_order should be queryable");

        assert_eq!(main_count, 2);
        let unqualified_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM row_order", [], |row| row.get(0))
            .expect("unqualified row_order should resolve to main row_order after repair");
        assert_eq!(unqualified_count, 2);
    }

    #[test]
    fn test_duckdb_allows_schema_qualified_temp_table_creation() {
        let conn = Connection::open_in_memory().expect("in-memory DuckDB open failed");
        conn.execute_batch(
            "CREATE TEMP TABLE temp._easycris_temp_schema_probe(i INTEGER); \
             INSERT INTO temp._easycris_temp_schema_probe VALUES (42);",
        )
        .expect("DuckDB should allow CREATE TEMP TABLE temp.<name>");

        let value: i64 = conn
            .query_row(
                "SELECT i FROM temp._easycris_temp_schema_probe",
                [],
                |row| row.get(0),
            )
            .expect("qualified temp table should be queryable");
        assert_eq!(value, 42);
    }

    #[test]
    fn test_sort_key_bounds_rejects_nonzero_insert_into_empty_order() {
        let conn = Connection::open_in_memory().expect("in-memory DuckDB open failed");
        conn.execute_batch(
            "CREATE TABLE data (_row_index BIGINT); \
             CREATE TABLE main.row_order(physical_row BIGINT, sort_key BIGINT); \
             CREATE UNIQUE INDEX idx_row_order_sort_key ON main.row_order(sort_key); \
             CREATE UNIQUE INDEX idx_row_order_physical_row ON main.row_order(physical_row);",
        )
        .expect("empty row_order setup should succeed");

        let err = HybridCacheManager::sort_key_bounds(&conn, 1)
            .expect_err("non-zero insert into empty row_order should fail");
        assert!(err.contains("empty row_order"));
    }

    #[test]
    fn test_remove_rows_from_end_duckdb_errors_when_row_order_is_empty() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-remove-tail-empty-order-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-remove-tail-empty-order-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-duckdb-remove-tail-empty-order-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 1)
            .expect("append_rows should succeed");

        let namespaced_key = cache.get_namespaced_key(&dataset_id).unwrap();
        let conn_arc = cache.get_connection(&namespaced_key).unwrap();
        {
            let conn = conn_arc.lock().unwrap();
            conn.execute("DELETE FROM main.row_order", [])
                .expect("test should empty row_order");
        }

        let err = cache
            .remove_rows_from_end(&dataset_id, 1)
            .expect_err("empty row_order should fail tail removal");
        assert!(err.contains("No logical tail rows found"));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_logical_rows_to_physical_maps_sparse_spans() {
        let conn = Connection::open_in_memory().expect("in-memory DuckDB open failed");
        conn.execute_batch(
            "CREATE TABLE data (_row_index BIGINT); \
             INSERT INTO data VALUES (0), (1), (2), (3), (4), (5); \
             CREATE TABLE main.row_order AS \
               SELECT _row_index AS physical_row, (_row_index * 1000000)::BIGINT AS sort_key \
               FROM data ORDER BY _row_index;",
        )
        .expect("logical row mapping setup should succeed");

        let mapping = HybridCacheManager::logical_rows_to_physical(&conn, &[0, 2, 5])
            .expect("logical row mapping should succeed");
        assert_eq!(mapping.get(&0), Some(&0));
        assert_eq!(mapping.get(&2), Some(&2));
        assert_eq!(mapping.get(&5), Some(&5));
        assert_eq!(mapping.len(), 3);
    }

    #[test]
    fn test_insert_rows_at_duckdb_flushes_overlay_before_logical_insert() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-logical-overlay-insert-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-logical-overlay-insert-{}", Uuid::new_v4());
        cache.set_active_project_id(&project_id);

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 3)
            .expect("append_rows should succeed");
        for row in 0..3 {
            cache
                .update_cell(&dataset_id, row, "col-0", Value::from(format!("r{}", row)))
                .expect("update_cell should succeed");
        }
        cache
            .flush_overlay(&dataset_id)
            .expect("initial flush should succeed");

        cache
            .update_cell(&dataset_id, 1, "col-0", Value::from("r1-overlay"))
            .expect("overlay edit should succeed");
        cache
            .insert_rows_at(&dataset_id, 1, 1)
            .expect("middle insert should flush overlay before logical insert");

        let rows = cache
            .get_rows_range(&dataset_id, 0, 4)
            .expect("rows should be available");
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("r0")));
        assert_eq!(rows[1].get("col-0"), Some(&Value::Null));
        assert_eq!(rows[2].get("col-0"), Some(&Value::from("r1-overlay")));
        assert_eq!(rows[3].get("col-0"), Some(&Value::from("r2")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
    }

    #[test]
    fn test_get_rows_range_synthesizes_overlay_only_rows_for_duckdb() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-overlay-range-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-overlay-range-{}", Uuid::new_v4());
        let project_data_dir =
            std::env::temp_dir().join(format!("easycris-duckdb-overlay-range-{}", Uuid::new_v4()));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .insert_rows_at(&dataset_id, 0, 1)
            .expect("insert_rows_at should succeed");

        // Row 0 update overlays existing DuckDB row.
        cache
            .update_cell(&dataset_id, 0, "col-0", Value::from("r0"))
            .expect("update_cell row 0 should succeed");
        // Row 3 update exists only in overlay until flush.
        cache
            .update_cell(&dataset_id, 3, "col-0", Value::from("overlay-r3"))
            .expect("update_cell row 3 should succeed");

        let rows = cache
            .get_rows_range(&dataset_id, 0, 4)
            .expect("rows should be available");

        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("r0")));
        assert_eq!(rows[3].get("col-0"), Some(&Value::from("overlay-r3")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_flush_overlay_preserves_quoted_strings_and_nullifies_blank_text() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-flush-quoted-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-flush-quoted-{}", Uuid::new_v4());
        let project_data_dir =
            std::env::temp_dir().join(format!("easycris-duckdb-flush-quoted-{}", Uuid::new_v4()));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "TEXT".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .insert_rows_at(&dataset_id, 0, 2)
            .expect("insert_rows_at should succeed");
        cache
            .update_cell(&dataset_id, 0, "col-0", Value::from("O'Reilly"))
            .expect("update_cell row 0 should succeed");
        cache
            .update_cell(&dataset_id, 1, "col-0", Value::from("   "))
            .expect("update_cell row 1 should succeed");

        cache
            .flush_overlay(&dataset_id)
            .expect("flush_overlay should succeed");

        let rows = cache
            .get_rows_range(&dataset_id, 0, 2)
            .expect("rows should be available");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("O'Reilly")));
        assert_eq!(rows[1].get("col-0"), Some(&Value::Null));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_flush_overlay_coerces_structured_values_to_null_for_typed_column() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-flush-structured-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-flush-structured-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-duckdb-flush-structured-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "BIGINT".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .insert_rows_at(&dataset_id, 0, 2)
            .expect("insert_rows_at should succeed");
        cache
            .update_cell(&dataset_id, 0, "col-0", json!({"k": "v"}))
            .expect("update_cell row 0 should succeed");
        cache
            .update_cell(&dataset_id, 1, "col-0", json!([1, 2, 3]))
            .expect("update_cell row 1 should succeed");

        cache
            .flush_overlay(&dataset_id)
            .expect("flush_overlay should succeed");

        let rows = cache
            .get_rows_range(&dataset_id, 0, 2)
            .expect("rows should be available");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get("col-0"), Some(&Value::Null));
        assert_eq!(rows[1].get("col-0"), Some(&Value::Null));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_flush_overlay_preserves_concurrent_write_for_same_cell() {
        let cache = std::sync::Arc::new(HybridCacheManager::new());
        let project_id = format!("project-duckdb-flush-concurrent-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-flush-concurrent-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-duckdb-flush-concurrent-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "TEXT".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .insert_rows_at(&dataset_id, 0, 1)
            .expect("insert_rows_at should succeed");
        cache
            .update_cell(&dataset_id, 0, "col-0", Value::from("snapshot"))
            .expect("snapshot overlay edit should succeed");

        let namespaced_key = cache
            .get_namespaced_key(&dataset_id)
            .expect("namespaced key should resolve");
        let conn_arc = cache
            .get_connection(&namespaced_key)
            .expect("connection should be available");
        let snapshot_pair = std::sync::Arc::new((std::sync::Mutex::new(false), Condvar::new()));
        let continue_pair = std::sync::Arc::new((std::sync::Mutex::new(false), Condvar::new()));
        {
            let snapshot_pair = std::sync::Arc::clone(&snapshot_pair);
            let continue_pair = std::sync::Arc::clone(&continue_pair);
            *cache.flush_overlay_after_snapshot.write().unwrap() =
                Some(std::sync::Arc::new(move || {
                    let (snapshot_lock, snapshot_cv) = &*snapshot_pair;
                    *snapshot_lock.lock().unwrap() = true;
                    snapshot_cv.notify_one();

                    let (continue_lock, continue_cv) = &*continue_pair;
                    let mut should_continue = continue_lock.lock().unwrap();
                    while !*should_continue {
                        should_continue = continue_cv.wait(should_continue).unwrap();
                    }
                }));
        }

        let flush_cache = std::sync::Arc::clone(&cache);
        let flush_dataset_id = dataset_id.clone();
        let flush_thread = std::thread::spawn(move || {
            flush_cache
                .flush_overlay(&flush_dataset_id)
                .expect("flush_overlay should succeed")
        });

        let (snapshot_lock, snapshot_cv) = &*snapshot_pair;
        let mut snapshot_taken = snapshot_lock.lock().unwrap();
        while !*snapshot_taken {
            snapshot_taken = snapshot_cv.wait(snapshot_taken).unwrap();
        }
        drop(snapshot_taken);

        cache
            .update_cell(&dataset_id, 0, "col-0", Value::from("newer"))
            .expect("newer overlay edit should succeed");
        let (continue_lock, continue_cv) = &*continue_pair;
        *continue_lock.lock().unwrap() = true;
        continue_cv.notify_one();
        flush_thread.join().expect("flush thread should finish");
        *cache.flush_overlay_after_snapshot.write().unwrap() = None;

        let db_value: Option<String> = {
            let conn = conn_arc.lock().unwrap();
            conn.query_row(
                "SELECT \"col-0\" FROM data WHERE _row_index = 0",
                [],
                |row| row.get(0),
            )
            .expect("persisted value should be readable")
        };
        assert_eq!(db_value, Some("snapshot".to_string()));

        let overlay_key = (namespaced_key.clone(), 0_i64, "col-0".to_string());
        let overlay = cache.overlay.read().unwrap();
        assert_eq!(overlay.get(&overlay_key), Some(&Value::from("newer")));

        drop(overlay);
        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_apply_duckdb_cell_writes_rejects_internal_row_index() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-write-row-index-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-write-row-index-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-duckdb-write-row-index-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "TEXT".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .insert_rows_at(&dataset_id, 0, 1)
            .expect("insert_rows_at should succeed");

        let namespaced_key = cache
            .get_namespaced_key(&dataset_id)
            .expect("namespaced key should resolve");
        let conn_arc = cache
            .get_connection(&namespaced_key)
            .expect("connection should be available");
        let conn = conn_arc.lock().unwrap();
        let corrupting_value = Value::from(99);
        let writes = vec![BulkCellWrite {
            logical_row: 0,
            column_id: "_row_index",
            value: &corrupting_value,
        }];

        let err = HybridCacheManager::apply_duckdb_cell_writes(&conn, &namespaced_key, &writes)
            .expect_err("internal row index writes must be rejected");
        assert_eq!(
            err,
            "Reserved virtual column id '_row_index' is not writable"
        );

        let physical_rows: Vec<i64> = conn
            .prepare("SELECT _row_index FROM data ORDER BY _row_index")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(physical_rows, vec![0]);

        drop(conn);
        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_apply_paste_block_writes_contiguous_rows_without_overlay_staging() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-paste-block-contiguous-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-paste-block-contiguous-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-paste-block-contiguous-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![
            ColumnInfo {
                name: "col-0".to_string(),
                display_name: "Column 1".to_string(),
                dtype: "TEXT".to_string(),
            },
            ColumnInfo {
                name: "col-1".to_string(),
                display_name: "Column 2".to_string(),
                dtype: "TEXT".to_string(),
            },
        ];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 1030)
            .expect("append_rows should succeed");
        cache
            .update_cell(&dataset_id, 1024, "col-1", Value::from("neighbor-1024"))
            .expect("neighbor update should succeed");
        cache
            .update_cell(&dataset_id, 1025, "col-1", Value::from("neighbor-1025"))
            .expect("neighbor update should succeed");
        cache
            .flush_overlay(&dataset_id)
            .expect("seed overlay flush should succeed");

        let result = cache
            .apply_paste_block(
                &dataset_id,
                PasteBlockPayload {
                    rows: vec![1024, 1025],
                    column_ids: vec!["col-0".to_string()],
                    values: vec![
                        vec![Value::from("paste-1024")],
                        vec![Value::from("paste-1025")],
                    ],
                },
            )
            .expect("apply_paste_block should succeed");

        assert_eq!(result.row_start, 1024);
        assert_eq!(result.row_end_exclusive, 1026);
        assert_eq!(result.edited_cells, 2);
        assert_eq!(
            result.old_values,
            vec![vec![Value::Null], vec![Value::Null]]
        );

        let rows = cache
            .get_rows_range(&dataset_id, 1024, 1026)
            .expect("rows should be available");
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("paste-1024")));
        assert_eq!(rows[0].get("col-1"), Some(&Value::from("neighbor-1024")));
        assert_eq!(rows[1].get("col-0"), Some(&Value::from("paste-1025")));
        assert_eq!(rows[1].get("col-1"), Some(&Value::from("neighbor-1025")));

        let namespaced_key = cache.get_namespaced_key(&dataset_id).unwrap();
        let overlay = cache.overlay.read().unwrap();
        assert!(
            !overlay.keys().any(|(ds_id, _, _)| ds_id == &namespaced_key),
            "apply_paste_block should not stage overlay edits"
        );
        drop(overlay);

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_apply_paste_block_writes_scattered_logical_rows() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-paste-block-scattered-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-paste-block-scattered-{}", Uuid::new_v4());
        let project_data_dir =
            std::env::temp_dir().join(format!("easycris-paste-block-scattered-{}", Uuid::new_v4()));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "TEXT".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 10)
            .expect("append_rows should succeed");
        cache
            .update_cell(&dataset_id, 3, "col-0", Value::from("unchanged"))
            .expect("seed update should succeed");
        cache
            .flush_overlay(&dataset_id)
            .expect("seed overlay flush should succeed");

        let result = cache
            .apply_paste_block(
                &dataset_id,
                PasteBlockPayload {
                    rows: vec![5, 2, 9],
                    column_ids: vec!["col-0".to_string()],
                    values: vec![
                        vec![Value::from("row-5")],
                        vec![Value::from("row-2")],
                        vec![Value::from("row-9")],
                    ],
                },
            )
            .expect("apply_paste_block should succeed");

        assert_eq!(result.row_start, 2);
        assert_eq!(result.row_end_exclusive, 10);
        assert_eq!(result.edited_cells, 3);
        assert_eq!(
            result.old_values,
            vec![vec![Value::Null], vec![Value::Null], vec![Value::Null]]
        );

        let rows = cache
            .get_rows_range(&dataset_id, 0, 10)
            .expect("rows should be available");
        assert_eq!(rows[2].get("col-0"), Some(&Value::from("row-2")));
        assert_eq!(rows[3].get("col-0"), Some(&Value::from("unchanged")));
        assert_eq!(rows[5].get("col-0"), Some(&Value::from("row-5")));
        assert_eq!(rows[9].get("col-0"), Some(&Value::from("row-9")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_apply_paste_block_returns_committed_duckdb_old_values() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-paste-block-old-values-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-paste-block-old-values-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-paste-block-old-values-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "TEXT".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 3)
            .expect("append_rows should succeed");
        cache
            .update_cell(&dataset_id, 1, "col-0", Value::from("committed-old"))
            .expect("seed update should succeed");
        cache
            .flush_overlay(&dataset_id)
            .expect("seed overlay flush should succeed");

        let result = cache
            .apply_paste_block(
                &dataset_id,
                PasteBlockPayload {
                    rows: vec![1],
                    column_ids: vec!["col-0".to_string()],
                    values: vec![vec![Value::from("new-value")]],
                },
            )
            .expect("apply_paste_block should succeed");

        assert_eq!(result.old_values, vec![vec![Value::from("committed-old")]]);

        let rows = cache
            .get_rows_range(&dataset_id, 1, 2)
            .expect("rows should be available");
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("new-value")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_apply_paste_block_extends_row_count_for_new_logical_rows() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-paste-block-extend-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-paste-block-extend-{}", Uuid::new_v4());
        let project_data_dir =
            std::env::temp_dir().join(format!("easycris-paste-block-extend-{}", Uuid::new_v4()));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "TEXT".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 2)
            .expect("append_rows should succeed");

        let result = cache
            .apply_paste_block(
                &dataset_id,
                PasteBlockPayload {
                    rows: vec![4, 5],
                    column_ids: vec!["col-0".to_string()],
                    values: vec![vec![Value::from("row-4")], vec![Value::from("row-5")]],
                },
            )
            .expect("apply_paste_block should succeed");

        assert_eq!(result.row_start, 4);
        assert_eq!(result.row_end_exclusive, 6);
        assert_eq!(result.edited_cells, 2);
        assert_eq!(
            result.old_values,
            vec![vec![Value::Null], vec![Value::Null]]
        );
        assert_eq!(cache.get_row_count(&dataset_id), Some(6));

        let rows = cache
            .get_rows_range(&dataset_id, 0, 6)
            .expect("rows should be available");
        assert_eq!(rows.len(), 6);
        assert_eq!(rows[4].get("col-0"), Some(&Value::from("row-4")));
        assert_eq!(rows[5].get("col-0"), Some(&Value::from("row-5")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_apply_paste_block_clears_conflicting_overlay_cells_after_commit() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-paste-block-overlay-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-paste-block-overlay-{}", Uuid::new_v4());
        let project_data_dir =
            std::env::temp_dir().join(format!("easycris-paste-block-overlay-{}", Uuid::new_v4()));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "TEXT".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 2)
            .expect("append_rows should succeed");
        cache
            .update_cell(&dataset_id, 1, "col-0", Value::from("stale-overlay"))
            .expect("overlay update should succeed");

        let result = cache
            .apply_paste_block(
                &dataset_id,
                PasteBlockPayload {
                    rows: vec![1],
                    column_ids: vec!["col-0".to_string()],
                    values: vec![vec![Value::from("committed")]],
                },
            )
            .expect("apply_paste_block should succeed");
        assert_eq!(result.old_values, vec![vec![Value::from("stale-overlay")]]);

        let rows = cache
            .get_rows_range(&dataset_id, 1, 2)
            .expect("rows should be available");
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("committed")));

        let namespaced_key = cache.get_namespaced_key(&dataset_id).unwrap();
        let overlay_key = (namespaced_key, 1_i64, "col-0".to_string());
        let overlay = cache.overlay.read().unwrap();
        assert!(!overlay.contains_key(&overlay_key));
        drop(overlay);

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_apply_paste_block_rejects_calc_pending_without_clearing_overlay() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-paste-block-calc-pending-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-paste-block-calc-pending-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-paste-block-calc-pending-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "TEXT".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 2)
            .expect("append_rows should succeed");
        cache
            .update_cell(&dataset_id, 10, "col-0", Value::from("pending-overlay"))
            .expect("overlay update should succeed");

        let err = cache
            .apply_paste_block(
                &dataset_id,
                PasteBlockPayload {
                    rows: vec![1, 10],
                    column_ids: vec!["col-0".to_string()],
                    values: vec![
                        vec![Value::from("committed")],
                        vec![Value::from(CALC_PENDING_SENTINEL)],
                    ],
                },
            )
            .expect_err("apply_paste_block should reject calc-pending values");

        assert!(err.contains("calc-pending"));
        assert_eq!(cache.get_row_count(&dataset_id), Some(2));

        let namespaced_key = cache.get_namespaced_key(&dataset_id).unwrap();
        let overlay_key = (namespaced_key, 10_i64, "col-0".to_string());
        let overlay = cache.overlay.read().unwrap();
        assert_eq!(
            overlay.get(&overlay_key),
            Some(&Value::from("pending-overlay"))
        );
        drop(overlay);

        let rows = cache
            .get_rows_range(&dataset_id, 1, 2)
            .expect("rows should be available");
        assert_eq!(rows[0].get("col-0"), Some(&Value::Null));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_apply_paste_block_rejects_all_calc_pending_and_preserves_overlay() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-paste-block-all-calc-pending-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-paste-block-all-calc-pending-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-paste-block-all-calc-pending-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "TEXT".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 1)
            .expect("append_rows should succeed");
        cache
            .update_cell(&dataset_id, 0, "col-0", Value::from("pending-overlay"))
            .expect("overlay update should succeed");

        let err = cache
            .apply_paste_block(
                &dataset_id,
                PasteBlockPayload {
                    rows: vec![0],
                    column_ids: vec!["col-0".to_string()],
                    values: vec![vec![Value::from(CALC_PENDING_SENTINEL)]],
                },
            )
            .expect_err("apply_paste_block should reject calc-pending values");

        assert!(err.contains("calc-pending"));
        assert_eq!(cache.get_row_count(&dataset_id), Some(1));

        let namespaced_key = cache.get_namespaced_key(&dataset_id).unwrap();
        let overlay_key = (namespaced_key, 0_i64, "col-0".to_string());
        let overlay = cache.overlay.read().unwrap();
        assert_eq!(
            overlay.get(&overlay_key),
            Some(&Value::from("pending-overlay"))
        );
        drop(overlay);

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_apply_paste_block_rejects_invalid_payload_shape() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-paste-block-invalid-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-paste-block-invalid-{}", Uuid::new_v4());
        let project_data_dir =
            std::env::temp_dir().join(format!("easycris-paste-block-invalid-{}", Uuid::new_v4()));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "TEXT".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");

        let err = cache
            .apply_paste_block(
                &dataset_id,
                PasteBlockPayload {
                    rows: vec![0],
                    column_ids: vec!["col-0".to_string(), "_row_index".to_string()],
                    values: vec![vec![Value::from("x")]],
                },
            )
            .expect_err("invalid payload should be rejected");
        assert!(err.contains("values row 0 has 1 columns; expected 2"));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_apply_paste_block_rejects_internal_row_index() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-paste-block-row-index-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-paste-block-row-index-{}", Uuid::new_v4());
        let project_data_dir =
            std::env::temp_dir().join(format!("easycris-paste-block-row-index-{}", Uuid::new_v4()));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "TEXT".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");

        let err = cache
            .apply_paste_block(
                &dataset_id,
                PasteBlockPayload {
                    rows: vec![0],
                    column_ids: vec!["_row_index".to_string()],
                    values: vec![vec![Value::from(99)]],
                },
            )
            .expect_err("internal row index writes must be rejected");
        assert_eq!(
            err,
            "Reserved virtual column id '_row_index' is not writable"
        );

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_insert_rows_at_duckdb_large_batch_is_correct() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-large-batch-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-large-batch-{}", Uuid::new_v4());
        let project_data_dir =
            std::env::temp_dir().join(format!("easycris-duckdb-large-batch-{}", Uuid::new_v4()));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");

        cache
            .insert_rows_at(&dataset_id, 0, 2)
            .expect("initial insert_rows_at should succeed");
        cache
            .update_cell(&dataset_id, 0, "col-0", Value::from("r0"))
            .expect("update row 0 should succeed");
        cache
            .update_cell(&dataset_id, 1, "col-0", Value::from("r1"))
            .expect("update row 1 should succeed");

        let new_count = cache
            .insert_rows_at(&dataset_id, 1, 300)
            .expect("large batch insert_rows_at should succeed");

        assert_eq!(new_count, 302);
        assert_eq!(cache.get_row_count(&dataset_id), Some(302));

        let rows = cache
            .get_rows_range(&dataset_id, 0, 302)
            .expect("rows should be available");
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("r0")));
        assert_eq!(rows[1].get("col-0"), Some(&Value::Null));
        assert_eq!(rows[300].get("col-0"), Some(&Value::Null));
        assert_eq!(rows[301].get("col-0"), Some(&Value::from("r1")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    #[ignore = "perf gate: run with cargo test -- --ignored"]
    fn test_insert_rows_at_duckdb_large_batch_perf_gate() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-duckdb-large-batch-perf-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-duckdb-large-batch-perf-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-duckdb-large-batch-perf-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");

        cache
            .insert_rows_at(&dataset_id, 0, 2)
            .expect("initial insert_rows_at should succeed");

        let start = Instant::now();
        cache
            .insert_rows_at(&dataset_id, 1, 300)
            .expect("large batch insert_rows_at should succeed");
        let elapsed = start.elapsed();
        assert!(
            elapsed <= Duration::from_millis(1500),
            "large batch insert took {:?}, expected <= 1500ms",
            elapsed
        );

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_update_cells_batch_rejects_reserved_virtual_column_id_for_in_memory() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("test-project-reserved-in-memory");
        cache.set_dataset("test-reserved-in-memory", vec![HashMap::new()]);

        let err = cache
            .update_cells_batch(
                "test-reserved-in-memory",
                vec![(0, "__add_column__".to_string(), Value::from("x"))],
            )
            .expect_err("reserved virtual column id should be rejected");
        assert_eq!(
            err,
            "Reserved virtual column id '__add_column__' is not writable"
        );
    }

    #[test]
    fn test_update_cells_batch_rejects_reserved_virtual_column_id_atomically_for_in_memory() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("test-project-reserved-atomic-in-memory");
        let mut row = HashMap::new();
        row.insert("col-0".to_string(), Value::from("original"));
        cache.set_dataset("test-reserved-atomic-in-memory", vec![row]);

        let err = cache
            .update_cells_batch(
                "test-reserved-atomic-in-memory",
                vec![
                    (0, "col-0".to_string(), Value::from("updated")),
                    (0, "__add_column__".to_string(), Value::from("x")),
                ],
            )
            .expect_err("reserved virtual column id should reject whole batch");
        assert_eq!(
            err,
            "Reserved virtual column id '__add_column__' is not writable"
        );

        let dataset = cache
            .get_dataset("test-reserved-atomic-in-memory")
            .expect("dataset should exist");
        assert_eq!(dataset[0].get("col-0"), Some(&Value::from("original")));
    }

    #[test]
    fn test_update_cells_batch_rejects_reserved_virtual_column_id_for_duckdb() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-reserved-duckdb-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-reserved-duckdb-{}", Uuid::new_v4());
        let project_data_dir =
            std::env::temp_dir().join(format!("easycris-reserved-duckdb-{}", Uuid::new_v4()));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .insert_rows_at(&dataset_id, 0, 1)
            .expect("insert_rows_at should succeed");

        let err = cache
            .update_cells_batch(
                &dataset_id,
                vec![(0, "__add_column__".to_string(), Value::from("x"))],
            )
            .expect_err("reserved virtual column id should be rejected");
        assert_eq!(
            err,
            "Reserved virtual column id '__add_column__' is not writable"
        );

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_update_cells_batch_invalidates_row_range_cache_for_duckdb() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-update-cells-cache-invalidate-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-update-cells-cache-invalidate-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-update-cells-cache-invalidate-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .insert_rows_at(&dataset_id, 0, 1)
            .expect("insert_rows_at should succeed");

        // Prime row-range cache explicitly for this dataset/range.
        let namespaced_key = cache
            .get_namespaced_key(&dataset_id)
            .expect("namespaced key should resolve");
        let cache_key = (namespaced_key, 0usize, 1usize);
        let mut seeded = HashMap::new();
        seeded.insert("col-0".to_string(), Value::Null);
        cache
            .row_range_cache
            .insert(cache_key.clone(), vec![seeded]);
        assert!(
            cache.row_range_cache.get(&cache_key).is_some(),
            "expected cached row range before update"
        );

        cache
            .update_cells_batch(
                &dataset_id,
                vec![(0, "col-0".to_string(), Value::from("updated"))],
            )
            .expect("update_cells_batch should succeed");

        assert!(
            cache.row_range_cache.get(&cache_key).is_none(),
            "row-range cache should be invalidated after batch update"
        );

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_apply_paste_block_invalidates_only_overlapping_row_range_cache_entries() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-paste-range-cache-invalidate-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-paste-range-cache-invalidate-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-paste-range-cache-invalidate-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 6000)
            .expect("append_rows should succeed");

        let namespaced_key = cache
            .get_namespaced_key(&dataset_id)
            .expect("namespaced key should resolve");
        let near_key = (namespaced_key.clone(), 0usize, 512usize);
        let far_key = (namespaced_key, 5000usize, 5512usize);
        let mut near_row = HashMap::new();
        near_row.insert("col-0".to_string(), Value::from("near"));
        let mut far_row = HashMap::new();
        far_row.insert("col-0".to_string(), Value::from("far"));
        cache
            .row_range_cache
            .insert(near_key.clone(), vec![near_row]);
        cache.row_range_cache.insert(far_key.clone(), vec![far_row]);

        cache
            .apply_paste_block(
                &dataset_id,
                PasteBlockPayload {
                    rows: vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
                    column_ids: vec!["col-0".to_string()],
                    values: (0..10)
                        .map(|index| vec![Value::from(format!("paste-{}", index))])
                        .collect(),
                },
            )
            .expect("apply_paste_block should succeed");

        assert!(
            cache.row_range_cache.get(&near_key).is_none(),
            "overlapping row-range cache entry should be invalidated"
        );
        assert!(
            cache.row_range_cache.get(&far_key).is_some(),
            "non-overlapping row-range cache entry should survive paste invalidation"
        );

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_get_rows_range_columns_returns_only_requested_columns_for_duckdb() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-row-columns-read-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-row-columns-read-{}", Uuid::new_v4());
        let project_data_dir =
            std::env::temp_dir().join(format!("easycris-row-columns-read-{}", Uuid::new_v4()));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![
            ColumnInfo {
                name: "col-0".to_string(),
                display_name: "Column 1".to_string(),
                dtype: "text".to_string(),
            },
            ColumnInfo {
                name: "col-1".to_string(),
                display_name: "Column 2".to_string(),
                dtype: "text".to_string(),
            },
            ColumnInfo {
                name: "col-2".to_string(),
                display_name: "Column 3".to_string(),
                dtype: "text".to_string(),
            },
        ];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 3)
            .expect("append_rows should succeed");
        cache
            .apply_paste_block(
                &dataset_id,
                PasteBlockPayload {
                    rows: vec![0, 1, 2],
                    column_ids: vec![
                        "col-0".to_string(),
                        "col-1".to_string(),
                        "col-2".to_string(),
                    ],
                    values: vec![
                        vec![Value::from("a0"), Value::from("b0"), Value::from("c0")],
                        vec![Value::from("a1"), Value::from("b1"), Value::from("c1")],
                        vec![Value::from("a2"), Value::from("b2"), Value::from("c2")],
                    ],
                },
            )
            .expect("apply_paste_block should succeed");

        let rows = cache
            .get_rows_range_columns(&dataset_id, 0, 3, &["col-1".to_string()])
            .expect("get_rows_range_columns should return rows");

        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].get("col-1"), Some(&Value::from("b0")));
        assert_eq!(rows[1].get("col-1"), Some(&Value::from("b1")));
        assert_eq!(rows[2].get("col-1"), Some(&Value::from("b2")));
        assert!(
            rows.iter().all(|row| row.len() == 1
                && !row.contains_key("col-0")
                && !row.contains_key("col-2")),
            "column-subset read should not return unrequested data columns"
        );

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_get_rows_range_columns_returns_dense_rows_for_overlay_only_gaps() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-row-columns-overlay-gap-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-row-columns-overlay-gap-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-row-columns-overlay-gap-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![
            ColumnInfo {
                name: "col-0".to_string(),
                display_name: "Column 1".to_string(),
                dtype: "text".to_string(),
            },
            ColumnInfo {
                name: "col-1".to_string(),
                display_name: "Column 2".to_string(),
                dtype: "text".to_string(),
            },
        ];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 1)
            .expect("append_rows should succeed");
        cache
            .update_cell(&dataset_id, 0, "col-1", Value::from("row-0"))
            .expect("update_cell should succeed");
        cache
            .flush_overlay(&dataset_id)
            .expect("flush_overlay should succeed");

        let namespaced_key = cache
            .get_namespaced_key(&dataset_id)
            .expect("namespaced key should resolve");
        cache.overlay.write().unwrap().insert(
            (namespaced_key, 2, "col-1".to_string()),
            Value::from("overlay-row-2"),
        );

        let rows = cache
            .get_rows_range_columns(&dataset_id, 0, 3, &["col-1".to_string()])
            .expect("get_rows_range_columns should return rows");

        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].get("col-1"), Some(&Value::from("row-0")));
        assert_eq!(rows[1].get("col-1"), None);
        assert_eq!(rows[2].get("col-1"), Some(&Value::from("overlay-row-2")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_update_cells_batch_rejects_reserved_virtual_column_id_atomically_for_duckdb() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-reserved-atomic-duckdb-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-reserved-atomic-duckdb-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-reserved-atomic-duckdb-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .insert_rows_at(&dataset_id, 0, 1)
            .expect("insert_rows_at should succeed");
        cache
            .update_cell(&dataset_id, 0, "col-0", Value::from("original"))
            .expect("update_cell should succeed");

        let err = cache
            .update_cells_batch(
                &dataset_id,
                vec![
                    (0, "col-0".to_string(), Value::from("updated")),
                    (0, "__add_column__".to_string(), Value::from("x")),
                ],
            )
            .expect_err("reserved virtual column id should reject whole batch");
        assert_eq!(
            err,
            "Reserved virtual column id '__add_column__' is not writable"
        );

        let rows = cache
            .get_rows_range(&dataset_id, 0, 1)
            .expect("rows should be available");
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("original")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_update_cell_rejects_reserved_virtual_column_id_for_in_memory() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("test-project-update-cell-reserved-in-memory");
        cache.set_dataset("test-update-cell-reserved-in-memory", vec![HashMap::new()]);

        let err = cache
            .update_cell(
                "test-update-cell-reserved-in-memory",
                0,
                "__add_column__",
                Value::from("x"),
            )
            .expect_err("reserved virtual column id should be rejected");
        assert_eq!(
            err,
            "Reserved virtual column id '__add_column__' is not writable"
        );
    }

    #[test]
    fn test_update_cell_rejects_reserved_virtual_column_id_for_duckdb() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-update-cell-reserved-duckdb-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-update-cell-reserved-duckdb-{}", Uuid::new_v4());
        let project_data_dir = std::env::temp_dir().join(format!(
            "easycris-update-cell-reserved-duckdb-{}",
            Uuid::new_v4()
        ));
        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .insert_rows_at(&dataset_id, 0, 1)
            .expect("insert_rows_at should succeed");

        let err = cache
            .update_cell(&dataset_id, 0, "__add_column__", Value::from("x"))
            .expect_err("reserved virtual column id should be rejected");
        assert_eq!(
            err,
            "Reserved virtual column id '__add_column__' is not writable"
        );

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    fn test_create_empty_table_rejects_reserved_virtual_column_id() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-create-empty-reserved-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-create-empty-reserved-{}", Uuid::new_v4());
        cache.set_active_project_id(&project_id);

        let columns = vec![
            ColumnInfo {
                name: "col-0".to_string(),
                display_name: "Column 1".to_string(),
                dtype: "text".to_string(),
            },
            ColumnInfo {
                name: "__add_column__".to_string(),
                display_name: "Add Column".to_string(),
                dtype: "text".to_string(),
            },
        ];

        let err = cache
            .create_empty_table(&dataset_id, columns)
            .expect_err("reserved virtual column id should be rejected");
        assert_eq!(
            err,
            "Reserved virtual column id '__add_column__' is not writable"
        );
    }

    #[test]
    fn test_resolve_duckdb_path_uses_active_project_namespace() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("project-abc");
        let resolved = cache.resolve_duckdb_path_for_dataset("dataset-1");
        let expected = cache.get_duckdb_path_with_project("project-abc", "dataset-1");
        assert_eq!(
            HybridCacheManager::normalize_index_path(&resolved),
            HybridCacheManager::normalize_index_path(&expected)
        );
    }

    #[test]
    #[cfg(windows)]
    fn test_bundle_path_equivalence_treats_verbatim_prefix_as_same_file() {
        let dir = std::env::temp_dir().join(format!("easycris-same-file-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        let regular = dir.join(format!("dataset-{}{}", Uuid::new_v4(), DATA_FILE_EXT));
        fs::write(&regular, b"db").expect("failed to create test db file");

        let canonical = fs::canonicalize(&regular).expect("failed to canonicalize test file");

        assert!(
            HybridCacheManager::paths_refer_to_same_file(&regular, &canonical),
            "regular '{}' and canonical '{}' should refer to same file",
            regular.display(),
            canonical.display()
        );

        let _ = fs::remove_file(&regular);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(windows)]
    fn test_bundle_dataset_skips_copy_for_reopened_project_path_shape() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-resave-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-resave-{}", Uuid::new_v4());
        let project_data_dir =
            std::env::temp_dir().join(format!("easycris-resave-{}", Uuid::new_v4()));

        cache.set_active_project_id(&project_id);
        cache.set_project_data_dir(&project_id, project_data_dir.clone());

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create table");
        cache.insert_rows_at(&dataset_id, 0, 1).expect("insert row");
        cache
            .update_cell(&dataset_id, 0, "col-0", Value::from("saved"))
            .expect("edit cell");
        cache
            .flush_overlay(&dataset_id)
            .expect("flush before path mutation");

        let namespaced_key = format!("{}:{}", project_id, dataset_id);
        let dest_path = cache.get_duckdb_path_with_project(&project_id, &dataset_id);
        assert!(
            dest_path.exists(),
            "test setup must create project-owned database before path equivalence check: '{}'",
            dest_path.display()
        );
        let dest_string = dest_path.to_string_lossy().to_string();

        // Guarantee a different string representation on Windows regardless of
        // whether canonicalize returned a verbatim path for this temp directory.
        let alternate_same_file_path = if let Some(rest) = dest_string.strip_prefix(r"\\?\") {
            PathBuf::from(rest.to_string())
        } else {
            PathBuf::from(format!(r"\\?\{}", dest_string))
        };

        assert_ne!(
            alternate_same_file_path.to_string_lossy(),
            dest_path.to_string_lossy(),
            "test setup must force a syntactic path mismatch"
        );
        assert!(
            alternate_same_file_path.exists(),
            "alternate path representation must resolve to an existing database: '{}'",
            alternate_same_file_path.display()
        );
        assert!(
            HybridCacheManager::paths_refer_to_same_file(&alternate_same_file_path, &dest_path),
            "test setup must still point both paths at the same physical file"
        );

        {
            let mut datasets = cache.datasets.write().unwrap();
            if let Some(DatasetStorage::DuckDB { db_path, .. }) = datasets.get_mut(&namespaced_key)
            {
                *db_path = alternate_same_file_path.clone();
            } else {
                panic!("expected DuckDB dataset");
            }
        }

        let bundled_path = cache
            .bundle_dataset_data_file(&project_id, &dataset_id)
            .expect("bundle should be a no-op success when source is already project-owned");

        assert!(HybridCacheManager::paths_refer_to_same_file(
            &bundled_path,
            &alternate_same_file_path
        ));

        cache
            .finalize_bundled_dataset_file(&project_id, &dataset_id)
            .expect("finalize should not delete same physical project-owned file");
        assert!(
            dest_path.exists(),
            "finalize must not delete same physical file '{}'",
            dest_path.display()
        );

        // This relies on the active project id set during setup. If this test is
        // refactored to clear active project state, use an explicit namespaced lookup.
        let rows = cache
            .get_rows_range(&dataset_id, 0, 1)
            .expect("rows should remain readable");
        assert_eq!(rows[0].get("col-0"), Some(&Value::from("saved")));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
        let _ = std::fs::remove_dir_all(project_data_dir);
    }

    #[test]
    #[cfg(windows)]
    fn test_project_data_path_allows_canonical_windows_prefix_mismatch() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-path-{}", Uuid::new_v4());
        let project_dir =
            std::env::temp_dir().join(format!("easycris-project-data-{}", Uuid::new_v4()));
        fs::create_dir_all(&project_dir).expect("failed to create project data dir");
        let db_path = project_dir.join(format!("dataset-{}{}", Uuid::new_v4(), DATA_FILE_EXT));
        fs::write(&db_path, b"x").expect("failed to create test db file");

        let canonical_dir =
            fs::canonicalize(&project_dir).expect("failed to canonicalize project dir");
        let canonical_dir_string = canonical_dir.to_string_lossy().to_string();
        let stored_dir = if let Some(stripped) = canonical_dir_string.strip_prefix(r"\\?\") {
            PathBuf::from(stripped)
        } else {
            project_dir.clone()
        };

        {
            let mut dirs = cache.project_data_dirs.write().unwrap();
            dirs.insert(project_id, stored_dir);
        }

        let canonical_db_path = fs::canonicalize(&db_path).expect("failed to canonicalize db path");
        assert!(
            cache.is_project_data_path(&canonical_db_path),
            "expected canonical path '{}' to match registered project dir",
            canonical_db_path.display()
        );

        let _ = fs::remove_file(&db_path);
        let _ = fs::remove_dir_all(&project_dir);
    }

    #[test]
    fn test_invalid_active_project_id_is_rejected() {
        let cache = HybridCacheManager::new();
        cache.set_active_project_id("project-safe");
        let previous = cache.get_active_project_id();
        let after_invalid = cache.set_active_project_id("../unsafe");
        assert_eq!(after_invalid, previous);
        assert_eq!(cache.get_active_project_id(), previous);
    }

    #[test]
    fn test_create_empty_table_creates_project_cache_dir() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-dir-{}", Uuid::new_v4());
        let dataset_id = format!("blank-{}", Uuid::new_v4());
        cache.set_active_project_id(&project_id);

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];

        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");

        let db_path = cache.get_duckdb_path_with_project(&project_id, &dataset_id);
        assert!(
            db_path.exists(),
            "expected db file to exist at {}",
            db_path.display()
        );

        let _ = fs::remove_file(&db_path);
        if let Some(parent) = db_path.parent() {
            let _ = fs::remove_dir(parent);
        }
    }

    #[test]
    fn test_clear_current_project_cache_does_not_delete_active_project_file() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-active-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-{}", Uuid::new_v4());
        let namespaced_key = format!("{}:{}", project_id, dataset_id);
        let db_path = cache.get_duckdb_path_with_project(&project_id, &dataset_id);

        if let Some(parent) = db_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&db_path, b"active").expect("failed to create active project cache file");

        let mut datasets = cache.datasets.write().unwrap();
        datasets.insert(
            namespaced_key,
            DatasetStorage::DuckDB {
                db_path: db_path.clone(),
                _table_name: "data".to_string(),
                columns: vec![],
                row_count: 0,
            },
        );
        drop(datasets);

        let summary = cache.clear_current_project_cache(&project_id);
        assert_eq!(summary.removed_files, 0);
        assert_eq!(summary.skipped_active_files, 1);
        assert!(db_path.exists(), "active cache file should not be deleted");

        let _ = fs::remove_file(&db_path);
        if let Some(parent) = db_path.parent() {
            let _ = fs::remove_dir(parent);
        }
    }

    #[test]
    fn test_clear_current_project_cache_removes_legacy_root_file_for_project_dataset() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-legacy-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-{}", Uuid::new_v4());
        let namespaced_key = format!("{}:{}", project_id, dataset_id);
        let db_path = cache
            .data_dir
            .join(format!("{}{}", dataset_id, DATA_FILE_EXT));
        fs::write(&db_path, b"legacy").expect("failed to create legacy root-level cache file");

        let mut datasets = cache.datasets.write().unwrap();
        datasets.insert(
            namespaced_key,
            DatasetStorage::InMemory {
                rows: vec![HashMap::new()],
            },
        );
        drop(datasets);

        let path_key = HybridCacheManager::normalize_index_path(&db_path);
        let mut index = cache.disk_cache_index.write().unwrap();
        index.insert(
            path_key.clone(),
            DiskCacheIndexEntry {
                namespaced_key: dataset_id.clone(),
                project_id: None,
                dataset_id: Some(dataset_id.clone()),
                path: path_key,
                size_bytes: 6,
                last_accessed_unix_secs: HybridCacheManager::now_unix_secs(),
                class: CacheEntryClass::AppCache,
            },
        );
        drop(index);

        let summary = cache.clear_current_project_cache(&project_id);
        assert_eq!(summary.removed_files, 1);
        assert!(
            !db_path.exists(),
            "legacy root-level cache file should be removed"
        );
    }

    #[test]
    fn test_infer_csv_data_width_mode_prefers_majority() {
        let widths = vec![9, 9, 8, 9, 8];
        assert_eq!(infer_csv_data_width(&widths), Some(9));
    }

    #[test]
    fn test_build_repaired_csv_header_adds_gene_id_for_r_artifact() {
        let header = csv::StringRecord::from(vec!["\tKO1", "KO2", "KO3", "KO4"]);
        let repaired = build_repaired_csv_header(&header, 5).expect("expected repair plan");

        assert_eq!(
            repaired.0,
            vec![
                "gene_id".to_string(),
                "KO1".to_string(),
                "KO2".to_string(),
                "KO3".to_string(),
                "KO4".to_string(),
            ]
        );
    }

    #[test]
    fn test_build_repaired_csv_header_pads_missing_columns() {
        let header = csv::StringRecord::from(vec!["gene", "KO1"]);
        let repaired = build_repaired_csv_header(&header, 4).expect("expected repair plan");

        assert_eq!(
            repaired.0,
            vec![
                "gene".to_string(),
                "KO1".to_string(),
                "Column 3".to_string(),
                "Column 4".to_string(),
            ]
        );
    }

    #[test]
    fn test_build_repaired_csv_header_does_not_prepend_for_leading_spaces() {
        let header = csv::StringRecord::from(vec![" KO1", "KO2", "KO3"]);
        let repaired = build_repaired_csv_header(&header, 4).expect("expected repair plan");

        assert_eq!(repaired.0[0], "KO1".to_string());
        assert_ne!(repaired.0[0], "gene_id".to_string());
    }

    #[test]
    fn test_build_repaired_csv_header_skips_when_width_matches() {
        let header = csv::StringRecord::from(vec!["gene_id", "KO1", "KO2"]);
        assert!(build_repaired_csv_header(&header, 3).is_none());
    }

    #[test]
    fn test_hidden_columns_persist_across_register_existing_duckdb() {
        let temp_name = format!(
            "easycris-hidden-col-{}-{}.ecpdb",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_millis()
        );
        let db_path = std::env::temp_dir().join(temp_name);
        let db_path_str = db_path.to_string_lossy().to_string();

        let conn = Connection::open(&db_path).expect("failed to create temp duckdb");
        conn.execute(
            "CREATE TABLE data (_row_index BIGINT PRIMARY KEY, \"col-0\" VARCHAR, \"col-1\" VARCHAR)",
            [],
        )
        .expect("failed to create data table");
        conn.execute(
            "INSERT INTO data (_row_index, \"col-0\", \"col-1\") VALUES (0, 'a', 'b')",
            [],
        )
        .expect("failed to insert row");
        HybridCacheManager::set_column_hidden(&conn, "col-1", true)
            .expect("failed to set hidden column");
        drop(conn);

        let cache = HybridCacheManager::new();
        let registered = cache
            .register_existing_duckdb_with_project(
                "proj-hidden",
                "dataset-hidden",
                &db_path_str,
                None,
            )
            .expect("register_existing_duckdb_with_project failed");

        assert!(registered.columns.iter().any(|c| c.id == "col-0"));
        assert!(!registered.columns.iter().any(|c| c.id == "col-1"));

        let _ = cache.remove_dataset_with_project("proj-hidden", "dataset-hidden");
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn test_single_flight_open_slot_times_out() {
        let cache = HybridCacheManager::new();
        let namespaced_key = format!("project-timeout:dataset-{}", Uuid::new_v4());
        {
            let mut opening = cache.opening_connections.lock().unwrap();
            opening.insert(namespaced_key.clone());
        }

        let result = cache.acquire_connection_open_slot(
            &namespaced_key,
            &namespaced_key,
            Duration::from_millis(20),
        );
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("Timed out waiting for connection open"));

        let mut opening = cache.opening_connections.lock().unwrap();
        opening.remove(&namespaced_key);
        cache.opening_connections_cv.notify_all();
    }

    #[test]
    fn test_prewarm_dedupe_skips_when_dataset_already_inflight() {
        let cache = HybridCacheManager::new();
        let namespaced_key = format!("project-prewarm:dataset-{}", Uuid::new_v4());
        {
            let mut inflight = cache.prewarm_inflight.lock().unwrap();
            inflight.insert(namespaced_key.clone());
        }

        cache.prewarm_column_stats_async(&namespaced_key);

        let inflight = cache.prewarm_inflight.lock().unwrap();
        assert!(inflight.contains(&namespaced_key));
        assert_eq!(inflight.len(), 1);
    }

    #[test]
    fn test_prewarm_dataset_infrastructure_creates_row_order_and_hidden_columns() {
        let cache = HybridCacheManager::new();
        let project_id = format!("project-infra-prewarm-{}", Uuid::new_v4());
        let dataset_id = format!("dataset-infra-prewarm-{}", Uuid::new_v4());
        cache.set_active_project_id(&project_id);

        let columns = vec![ColumnInfo {
            name: "col-0".to_string(),
            display_name: "Column 1".to_string(),
            dtype: "text".to_string(),
        }];
        cache
            .create_empty_table(&dataset_id, columns)
            .expect("create_empty_table should succeed");
        cache
            .append_rows(&dataset_id, 1)
            .expect("append_rows should succeed");

        let conn_arc = cache
            .get_connection(&dataset_id)
            .expect("connection should open");
        {
            let conn = conn_arc.lock().unwrap();
            conn.execute("DROP TABLE IF EXISTS main.row_order", [])
                .expect("drop row_order should succeed");
            conn.execute(
                &format!(
                    "DROP TABLE IF EXISTS {}",
                    HybridCacheManager::quote_identifier(HIDDEN_COLUMNS_TABLE)
                ),
                [],
            )
            .expect("drop hidden columns should succeed");
        }

        cache
            .prewarm_dataset_infrastructure(&dataset_id)
            .expect("infrastructure prewarm should succeed");

        let conn = conn_arc.lock().unwrap();
        let row_order_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM main.row_order", [], |row| row.get(0))
            .expect("row_order should exist");
        assert_eq!(row_order_count, 1);

        let hidden_count: i64 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM {}",
                    HybridCacheManager::quote_identifier(HIDDEN_COLUMNS_TABLE)
                ),
                [],
                |row| row.get(0),
            )
            .expect("hidden columns table should exist");
        assert_eq!(hidden_count, 0);
        assert_eq!(cache.get_row_count(&dataset_id), Some(1));

        let _ = cache.remove_dataset_with_project(&project_id, &dataset_id);
    }

    #[test]
    fn test_schedule_prewarm_skips_large_dataset_threshold() {
        let cache = HybridCacheManager::new();
        let namespaced_key = format!("project-large:dataset-{}", Uuid::new_v4());
        cache.schedule_column_stats_prewarm(&namespaced_key, PREWARM_SKIP_ROW_THRESHOLD);
        let inflight = cache.prewarm_inflight.lock().unwrap();
        assert!(!inflight.contains(&namespaced_key));
    }

    #[test]
    fn test_get_connection_fast_fails_on_missing_file_without_retry_delay() {
        let cache = HybridCacheManager::new();
        let namespaced_key = format!("project-missing:dataset-{}", Uuid::new_v4());
        let missing_path =
            std::env::temp_dir().join(format!("easycris-missing-{}.ecpdb", Uuid::new_v4()));

        let mut datasets = cache.datasets.write().unwrap();
        datasets.insert(
            namespaced_key.clone(),
            DatasetStorage::DuckDB {
                db_path: missing_path.clone(),
                _table_name: "data".to_string(),
                columns: vec![],
                row_count: 0,
            },
        );
        drop(datasets);

        let started = Instant::now();
        let result = cache.get_connection(&namespaced_key);
        let elapsed = started.elapsed();

        assert!(result.is_err());
        assert!(
            result.err().unwrap_or_default().contains("file missing"),
            "expected missing-file fast-fail error"
        );
        assert!(
            elapsed < Duration::from_millis(100),
            "missing-file fast-fail should not spend retry backoff; elapsed={:?}",
            elapsed
        );
        let failures = cache.connection_open_failures.lock().unwrap();
        assert!(
            !failures.contains_key(&namespaced_key),
            "fast-fail precheck should not increment circuit-breaker failures"
        );
    }

    #[test]
    fn test_open_failure_circuit_breaker_disables_prewarm_for_session() {
        let cache = HybridCacheManager::new();
        let namespaced_key = format!("project-breaker:dataset-{}", Uuid::new_v4());
        for _ in 0..PREWARM_DISABLE_AFTER_OPEN_FAILURES {
            cache.record_connection_open_failure(&namespaced_key);
        }
        let disabled = cache.prewarm_disabled_datasets.lock().unwrap();
        assert!(disabled.contains(&namespaced_key));
    }

    #[test]
    fn test_open_success_clears_prewarm_circuit_breaker() {
        let cache = HybridCacheManager::new();
        let namespaced_key = format!("project-breaker-clear:dataset-{}", Uuid::new_v4());
        for _ in 0..PREWARM_DISABLE_AFTER_OPEN_FAILURES {
            cache.record_connection_open_failure(&namespaced_key);
        }
        cache.record_connection_open_success(&namespaced_key);

        let disabled = cache.prewarm_disabled_datasets.lock().unwrap();
        assert!(
            !disabled.contains(&namespaced_key),
            "open success should clear prewarm-disabled circuit breaker"
        );
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CacheEntryClass {
    AppCache,
    ProjectOwned,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DiskCacheIndexEntry {
    namespaced_key: String,
    project_id: Option<String>,
    dataset_id: Option<String>,
    path: String,
    size_bytes: u64,
    last_accessed_unix_secs: u64,
    class: CacheEntryClass,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DiskCacheIndexSnapshot {
    version: u32,
    entries: Vec<DiskCacheIndexEntry>,
}

#[derive(Debug, Clone)]
struct DiskCacheFileMeta {
    path: PathBuf,
    size_bytes: u64,
    modified_unix_secs: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CacheCleanupSummary {
    #[serde(rename = "removedFiles")]
    pub removed_files: usize,
    #[serde(rename = "removedBytes")]
    pub removed_bytes: u64,
    #[serde(rename = "skippedActiveFiles")]
    pub skipped_active_files: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CacheHealthSummary {
    #[serde(rename = "appCacheBytes")]
    pub app_cache_bytes: u64,
    #[serde(rename = "projectDataBytes")]
    pub project_data_bytes: u64,
    #[serde(rename = "cacheBytes")]
    pub cache_bytes: u64,
    #[serde(rename = "availableDiskBytes")]
    pub available_disk_bytes: Option<u64>,
}
