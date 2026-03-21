// Formula Backend - Phase 6 (Backend Formula Evaluation with Formualizer)
//
// Implements DuckDB-backed EvaluationContext for evaluating formulas on large datasets.
// Uses formualizer-eval with custom resolver to stream data from DuckDB.
//
// Key features:
// - View->Model row mapping via rowOrder slice
// - Streaming range resolution (no full materialization)
// - Column letter -> column ID mapping
// - 1-based coordinate handling (Formualizer uses Excel-style 1-based coords)

use duckdb::Connection;
use formualizer_common::DateSystem;
use formualizer_eval::engine::range_view::RangeView;
use formualizer_eval::interpreter::Interpreter;
use formualizer_eval::reference::CellRef;
use formualizer_eval::traits::{
    BackendCaps, EvaluationContext, FunctionProvider, NamedRangeResolver, Range, RangeResolver,
    ReferenceResolver, Resolver, SourceResolver, TableResolver,
};
use formualizer_parse::parser::{ReferenceType, TableReference};
use formualizer_parse::{parse, ExcelError, ExcelErrorKind, LiteralValue};
use serde_json::Value;
use std::any::Any;
use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::{Arc, Mutex};

// ============================================================================
// DuckDB Range Implementation
// ============================================================================

/// A range backed by DuckDB query results.
/// Note: This currently materializes data rather than streaming.
#[derive(Debug)]
pub struct DuckDbRange {
    /// Cached data: Vec of rows, each row is Vec of columns
    data: Vec<Vec<LiteralValue>>,
    /// Dimensions: (rows, cols)
    dims: (usize, usize),
}

impl DuckDbRange {
    pub fn new(data: Vec<Vec<LiteralValue>>) -> Self {
        let dims = if data.is_empty() {
            (0, 0)
        } else {
            (data.len(), data[0].len())
        };
        Self { data, dims }
    }

    pub fn single_value(value: LiteralValue) -> Self {
        Self {
            data: vec![vec![value]],
            dims: (1, 1),
        }
    }

    pub fn empty() -> Self {
        Self {
            data: vec![],
            dims: (0, 0),
        }
    }
}

impl Range for DuckDbRange {
    fn get(&self, row: usize, col: usize) -> Result<LiteralValue, ExcelError> {
        if row >= self.dims.0 || col >= self.dims.1 {
            return Err(ExcelError::new(ExcelErrorKind::Ref));
        }
        Ok(self.data[row][col].clone())
    }

    fn dimensions(&self) -> (usize, usize) {
        self.dims
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

// ============================================================================
// Row Order Mapper
// ============================================================================

/// Maps view row indices to model (storage) row indices.
/// Handles both identity mapping (unsorted) and explicit row order (sorted/grouped).
///
/// IMPORTANT: View rows are 0-based internally. The conversion from 1-based
/// (Formualizer) to 0-based happens before calling these methods.
#[derive(Debug, Clone)]
pub struct RowOrderMapper {
    /// Starting row offset in the view (for slice-based mapping)
    start_offset: usize,
    /// Row order slice: view position -> model _row_index
    /// None means identity mapping (model row = view row)
    row_order: Option<Vec<usize>>,
    /// Total rows in dataset (for validation in identity mode)
    total_rows: usize,
}

impl RowOrderMapper {
    /// Create identity mapper (model row = view row)
    pub fn identity(total_rows: usize) -> Self {
        Self {
            start_offset: 0,
            row_order: None,
            total_rows,
        }
    }

    /// Create mapper from row order slice
    /// `start_offset`: Starting view row for this slice (0-based)
    /// `row_order`: Vec of model row indices
    /// `total_rows`: Total rows in dataset
    pub fn from_slice(start_offset: usize, row_order: Vec<usize>, total_rows: usize) -> Self {
        Self {
            start_offset,
            row_order: Some(row_order),
            total_rows,
        }
    }

    /// Map view row (0-based) to model row
    /// Returns Err if the view row is outside the mapped range
    pub fn view_to_model(&self, view_row: usize) -> Result<usize, ExcelError> {
        match &self.row_order {
            None => {
                // Identity mapping - validate bounds
                if view_row < self.total_rows {
                    Ok(view_row)
                } else {
                    Err(ExcelError::new(ExcelErrorKind::Ref))
                }
            }
            Some(order) => {
                // Slice mapping - must be within slice bounds
                let local_idx = view_row
                    .checked_sub(self.start_offset)
                    .ok_or_else(|| ExcelError::new(ExcelErrorKind::Ref))?;
                order
                    .get(local_idx)
                    .copied()
                    .ok_or_else(|| ExcelError::new(ExcelErrorKind::Ref))
            }
        }
    }

    /// Map a range of view rows (0-based) to model rows
    /// Returns Err if any row in the range is outside the mapped range
    /// This prevents silent data loss from partial range resolution
    pub fn view_range_to_model(
        &self,
        start_row: usize,
        end_row: usize,
    ) -> Result<Vec<usize>, ExcelError> {
        let mut result = Vec::with_capacity((end_row - start_row + 1) as usize);
        for r in start_row..=end_row {
            result.push(self.view_to_model(r)?);
        }
        Ok(result)
    }

    /// Check if this is identity mapping (no row reordering)
    pub fn is_identity(&self) -> bool {
        self.row_order.is_none()
    }

    /// Get slice bounds if using slice mapping
    pub fn slice_bounds(&self) -> Option<(usize, usize)> {
        self.row_order.as_ref().map(|order| {
            (
                self.start_offset,
                self.start_offset + order.len().saturating_sub(1),
            )
        })
    }
}

// ============================================================================
// Column Mapper
// ============================================================================

/// Maps column letters (A, B, C) to column IDs (col-0, col-1).
/// Also handles 1-based to 0-based column conversion.
#[derive(Debug, Clone)]
pub struct ColumnMapper {
    /// Letter -> column ID mapping (e.g., "A" -> "col-0")
    letter_to_id: HashMap<String, String>,
    /// Column count for bounds checking
    column_count: usize,
}

impl ColumnMapper {
    pub fn new(letter_to_id: HashMap<String, String>) -> Self {
        let column_count = letter_to_id.len();
        Self {
            letter_to_id,
            column_count,
        }
    }

    /// Convert 0-based column index to column ID
    pub fn col_index_to_id(&self, col: u32) -> Option<String> {
        let letter = Self::col_index_to_letter(col);
        self.letter_to_id.get(&letter).cloned()
    }

    /// Convert column index to letter (0 -> "A", 25 -> "Z", 26 -> "AA")
    pub fn col_index_to_letter(col: u32) -> String {
        let mut result = String::new();
        let mut n = col as i32;
        loop {
            result.insert(0, (b'A' + (n % 26) as u8) as char);
            n = n / 26 - 1;
            if n < 0 {
                break;
            }
        }
        result
    }

    pub fn column_count(&self) -> usize {
        self.column_count
    }
}

// ============================================================================
// DuckDB Evaluation Context
// ============================================================================

/// Hard cap on backend range materialization (cells).
/// Prevents excessive memory/time when formulas reference huge ranges.
const MAX_BACKEND_RANGE_CELLS: usize = 250_000;

/// EvaluationContext implementation backed by DuckDB.
/// Resolves cell and range references by querying the database.
///
/// COORDINATE CONVENTION:
/// - Formualizer uses 1-based row/col (Excel style: A1 = row 1, col 1)
/// - DuckDB uses 0-based _row_index
/// - This context handles the conversion: subtract 1 from incoming coords
pub struct DuckDbEvaluationContext {
    /// DuckDB connection (pooled)
    conn: Arc<Mutex<Connection>>,
    /// Dataset ID
    #[allow(dead_code)]
    dataset_id: String,
    /// Row order mapper for view->model translation
    row_mapper: RowOrderMapper,
    /// Column mapper for letter->ID translation
    col_mapper: ColumnMapper,
    /// Total row count in dataset
    row_count: usize,
}

impl Debug for DuckDbEvaluationContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DuckDbEvaluationContext")
            .field("dataset_id", &self.dataset_id)
            .field("row_count", &self.row_count)
            .finish()
    }
}

impl DuckDbEvaluationContext {
    pub fn new(
        conn: Arc<Mutex<Connection>>,
        dataset_id: String,
        row_mapper: RowOrderMapper,
        col_mapper: ColumnMapper,
        row_count: usize,
    ) -> Self {
        Self {
            conn,
            dataset_id,
            row_mapper,
            col_mapper,
            row_count,
        }
    }

    /// Fetch a single cell value from DuckDB
    /// model_row is 0-based
    fn fetch_cell(&self, model_row: usize, col_id: &str) -> Result<LiteralValue, ExcelError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| ExcelError::new(ExcelErrorKind::Value))?;

        let sql = format!(
            "SELECT \"{}\" FROM data WHERE _row_index = ? LIMIT 1",
            col_id.replace('"', "\"\"")
        );

        let mut stmt = conn.prepare(&sql).map_err(|e| {
            log::error!("DuckDB prepare error: {:?}", e);
            ExcelError::new(ExcelErrorKind::Value)
        })?;

        // Query and propagate errors properly
        match stmt.query_row([model_row as i64], |row| {
            let value: duckdb::types::Value = row.get(0)?;
            Ok(duckdb_value_to_literal(value))
        }) {
            Ok(Ok(lit)) => Ok(lit),
            Ok(Err(e)) => Err(e),
            Err(duckdb::Error::QueryReturnedNoRows) => Ok(LiteralValue::Empty),
            Err(e) => {
                log::error!("DuckDB query error: {:?}", e);
                Err(ExcelError::new(ExcelErrorKind::Value))
            }
        }
    }

    /// Fetch a range of cells from DuckDB using contiguous range optimization
    /// model_rows are 0-based
    fn fetch_range(
        &self,
        model_rows: &[usize],
        col_ids: &[String],
    ) -> Result<Vec<Vec<LiteralValue>>, ExcelError> {
        if model_rows.is_empty() || col_ids.is_empty() {
            return Ok(vec![]);
        }

        let conn = self
            .conn
            .lock()
            .map_err(|_| ExcelError::new(ExcelErrorKind::Value))?;

        // Build column list
        let cols_sql = col_ids
            .iter()
            .map(|c| format!("\"{}\"", c.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");

        // Optimize: check if rows are contiguous for simpler SQL
        let is_contiguous = model_rows.windows(2).all(|w| w[1] == w[0] + 1);

        let sql = if is_contiguous && model_rows.len() > 10 {
            // Use BETWEEN for contiguous ranges (more efficient)
            let min_row = model_rows[0];
            let max_row = model_rows[model_rows.len() - 1];
            format!(
                "SELECT _row_index, {} FROM data WHERE _row_index BETWEEN {} AND {} ORDER BY _row_index",
                cols_sql, min_row, max_row
            )
        } else if model_rows.len() > 1000 {
            // For very large non-contiguous ranges, use temp table approach
            // This prevents SQL string explosion
            // Safe: len() > 1000 guarantees non-empty
            let min_row = *model_rows
                .iter()
                .min()
                .expect("model_rows non-empty after len check");
            let max_row = *model_rows
                .iter()
                .max()
                .expect("model_rows non-empty after len check");
            format!(
                "SELECT _row_index, {} FROM data WHERE _row_index BETWEEN {} AND {} ORDER BY _row_index",
                cols_sql, min_row, max_row
            )
            // Note: This may fetch extra rows; filtered below
        } else {
            // Use IN clause for small/medium non-contiguous ranges
            let rows_sql = model_rows
                .iter()
                .map(|r| r.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "SELECT _row_index, {} FROM data WHERE _row_index IN ({}) ORDER BY _row_index",
                cols_sql, rows_sql
            )
        };

        let mut stmt = conn.prepare(&sql).map_err(|e| {
            log::error!("DuckDB prepare error for range: {:?}", e);
            ExcelError::new(ExcelErrorKind::Value)
        })?;

        // Create a map from model_row -> position in result
        let row_to_pos: HashMap<usize, usize> = model_rows
            .iter()
            .enumerate()
            .map(|(i, &r)| (r, i))
            .collect();

        // Initialize result with empty cells
        let mut result: Vec<Vec<LiteralValue>> =
            vec![vec![LiteralValue::Empty; col_ids.len()]; model_rows.len()];

        let mut rows = stmt.query([]).map_err(|e| {
            log::error!("DuckDB query error: {:?}", e);
            ExcelError::new(ExcelErrorKind::Value)
        })?;

        while let Some(row) = rows
            .next()
            .map_err(|_| ExcelError::new(ExcelErrorKind::Value))?
        {
            let model_row: i64 = row.get(0).unwrap_or(-1);
            if model_row < 0 {
                continue;
            }

            // Only include rows that were actually requested (handles BETWEEN over-fetch)
            if let Some(&pos) = row_to_pos.get(&(model_row as usize)) {
                for (col_idx, _) in col_ids.iter().enumerate() {
                    let value: duckdb::types::Value =
                        row.get(col_idx + 1).unwrap_or(duckdb::types::Value::Null);
                    result[pos][col_idx] =
                        duckdb_value_to_literal(value).unwrap_or(LiteralValue::Empty);
                }
            }
        }

        Ok(result)
    }

    fn resolve_range_data(
        &self,
        sr: Option<u32>,
        sc: Option<u32>,
        er: Option<u32>,
        ec: Option<u32>,
    ) -> Result<Vec<Vec<LiteralValue>>, ExcelError> {
        // CRITICAL: Formualizer uses 1-based coords
        // Convert to 0-based, handling None as full-extent

        // For rows: None means entire column (all rows)
        let start_row_0 = sr.map(|r| r.saturating_sub(1)).unwrap_or(0);
        let end_row_0 = er
            .map(|r| r.saturating_sub(1))
            .unwrap_or((self.row_count.saturating_sub(1)) as u32);

        // For cols: None means entire row (all columns)
        let start_col_0 = sc.map(|c| c.saturating_sub(1)).unwrap_or(0);
        let end_col_0 = ec
            .map(|c| c.saturating_sub(1))
            .unwrap_or((self.col_mapper.column_count().saturating_sub(1)) as u32);

        // Full-column or open-ended row refs require full rowOrder coverage.
        // If only a slice is provided, returning partial data would be incorrect.
        if sr.is_none() || er.is_none() {
            if self.row_count == 0 {
                return Ok(vec![]);
            }
            if let Some((slice_start, slice_end)) = self.row_mapper.slice_bounds() {
                let full_end = self.row_count.saturating_sub(1);
                if slice_start != 0 || slice_end != full_end {
                    return Err(ExcelError::new(ExcelErrorKind::Ref));
                }
            }
        }

        let (actual_start, actual_end) = (start_row_0, end_row_0);

        // Validate range is non-empty after conversion
        if actual_start > actual_end {
            return Ok(vec![]);
        }

        // Guard: prevent enormous range materialization (avoids hangs on huge datasets)
        let row_count = (actual_end - actual_start + 1) as usize;
        let col_count = (end_col_0.saturating_sub(start_col_0) + 1) as usize;
        let cell_count = row_count.saturating_mul(col_count);
        if cell_count > MAX_BACKEND_RANGE_CELLS {
            log::warn!(
                "[formula_backend] Range too large ({} cells) - refusing to materialize",
                cell_count
            );
            return Err(ExcelError::new(ExcelErrorKind::Value));
        }

        // Map view rows to model rows - this now returns Err if rows are outside slice
        let model_rows = match self
            .row_mapper
            .view_range_to_model(actual_start as usize, actual_end as usize)
        {
            Ok(rows) => rows,
            Err(e) => {
                if self.row_mapper.is_identity() {
                    // Allow ranges beyond current row_count; treat missing rows as empty.
                    (actual_start as usize..=actual_end as usize).collect()
                } else {
                    return Err(e);
                }
            }
        };

        if model_rows.is_empty() {
            return Ok(vec![]);
        }

        // Get column IDs
        let col_ids: Vec<String> = (start_col_0..=end_col_0)
            .filter_map(|c| self.col_mapper.col_index_to_id(c))
            .collect();

        if col_ids.is_empty() {
            return Ok(vec![]);
        }

        // Fetch data
        self.fetch_range(&model_rows, &col_ids)
    }

    fn cache_range_view(
        &self,
        data: Vec<Vec<LiteralValue>>,
    ) -> Result<RangeView<'static>, ExcelError> {
        Ok(RangeView::from_owned_rows(data, DateSystem::Excel1900))
    }
}

/// Convert DuckDB Value to Formualizer LiteralValue
fn duckdb_value_to_literal(value: duckdb::types::Value) -> Result<LiteralValue, ExcelError> {
    match value {
        duckdb::types::Value::Null => Ok(LiteralValue::Empty),
        duckdb::types::Value::Boolean(b) => Ok(LiteralValue::Boolean(b)),
        duckdb::types::Value::TinyInt(n) => Ok(LiteralValue::Number(n as f64)),
        duckdb::types::Value::SmallInt(n) => Ok(LiteralValue::Number(n as f64)),
        duckdb::types::Value::Int(n) => Ok(LiteralValue::Number(n as f64)),
        duckdb::types::Value::BigInt(n) => Ok(LiteralValue::Number(n as f64)),
        duckdb::types::Value::Float(n) => Ok(LiteralValue::Number(n as f64)),
        duckdb::types::Value::Double(n) => Ok(LiteralValue::Number(n)),
        duckdb::types::Value::Text(s) => {
            let trimmed = s.trim();
            let lower = trimmed.to_ascii_lowercase();
            if lower == "true" {
                Ok(LiteralValue::Boolean(true))
            } else if lower == "false" {
                Ok(LiteralValue::Boolean(false))
            } else if let Ok(n) = trimmed.parse::<f64>() {
                Ok(LiteralValue::Number(n))
            } else {
                Ok(LiteralValue::Text(s))
            }
        }
        // DuckDB date/time types - convert to appropriate LiteralValue
        duckdb::types::Value::Date32(days) => {
            // Days since Unix epoch (1970-01-01)
            use chrono::NaiveDate;
            // Safe: 1970-01-01 is always a valid date
            let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).expect("1970-01-01 is valid");
            let date = epoch + chrono::Duration::days(days as i64);
            Ok(LiteralValue::Date(date))
        }
        duckdb::types::Value::Time64(_, micros) => {
            // Microseconds since midnight
            use chrono::NaiveTime;
            let secs = (micros / 1_000_000) as u32;
            let nanos = ((micros % 1_000_000) * 1000) as u32;
            if let Some(time) = NaiveTime::from_num_seconds_from_midnight_opt(secs, nanos) {
                Ok(LiteralValue::Time(time))
            } else {
                Ok(LiteralValue::Text(format!("{} microseconds", micros)))
            }
        }
        duckdb::types::Value::Timestamp(_, micros) => {
            // Microseconds since Unix epoch
            use chrono::{DateTime, Utc};
            let secs = micros / 1_000_000;
            let nsecs = ((micros % 1_000_000) * 1000) as u32;
            if let Some(dt) = DateTime::<Utc>::from_timestamp(secs, nsecs) {
                Ok(LiteralValue::DateTime(dt.naive_utc()))
            } else {
                Ok(LiteralValue::Text(format!("{} microseconds", micros)))
            }
        }
        duckdb::types::Value::Interval {
            months,
            days,
            nanos,
        } => {
            // Convert to duration (approximate for months)
            let total_days = months * 30 + days;
            let total_secs = (total_days as i64) * 86400 + (nanos / 1_000_000_000) as i64;
            Ok(LiteralValue::Duration(chrono::Duration::seconds(
                total_secs,
            )))
        }
        // Handle other types as text
        _ => Ok(LiteralValue::Text(format!("{:?}", value))),
    }
}

// ============================================================================
// Trait Implementations
// ============================================================================

impl ReferenceResolver for DuckDbEvaluationContext {
    fn resolve_cell_reference(
        &self,
        _sheet: Option<&str>,
        row: u32,
        col: u32,
    ) -> Result<LiteralValue, ExcelError> {
        // CRITICAL: Formualizer uses 1-based coords (Excel style)
        // Convert to 0-based for internal use
        let view_row = row
            .checked_sub(1)
            .ok_or_else(|| ExcelError::new(ExcelErrorKind::Ref))?;
        let col_idx = col
            .checked_sub(1)
            .ok_or_else(|| ExcelError::new(ExcelErrorKind::Ref))?;

        // Map view row to model row
        let model_row = match self.row_mapper.view_to_model(view_row as usize) {
            Ok(row) => row,
            Err(e) => {
                if self.row_mapper.is_identity() {
                    // Allow references beyond current row_count; treat missing rows as empty.
                    view_row as usize
                } else {
                    return Err(e);
                }
            }
        };

        // Map column index to column ID
        let col_id = self
            .col_mapper
            .col_index_to_id(col_idx)
            .ok_or_else(|| ExcelError::new(ExcelErrorKind::Ref))?;

        self.fetch_cell(model_row, &col_id)
    }
}

impl RangeResolver for DuckDbEvaluationContext {
    fn resolve_range_reference(
        &self,
        _sheet: Option<&str>,
        sr: Option<u32>,
        sc: Option<u32>,
        er: Option<u32>,
        ec: Option<u32>,
    ) -> Result<Box<dyn Range>, ExcelError> {
        let data = self.resolve_range_data(sr, sc, er, ec)?;
        Ok(Box::new(DuckDbRange::new(data)))
    }
}

impl NamedRangeResolver for DuckDbEvaluationContext {
    fn resolve_named_range_reference(
        &self,
        _name: &str,
    ) -> Result<Vec<Vec<LiteralValue>>, ExcelError> {
        // Named ranges not supported in v1 - return #NAME? error
        Err(ExcelError::new(ExcelErrorKind::Name))
    }
}

impl TableResolver for DuckDbEvaluationContext {
    fn resolve_table_reference(
        &self,
        _tref: &TableReference,
    ) -> Result<Box<dyn formualizer_eval::traits::Table>, ExcelError> {
        // Table references not supported in v1 - return #REF! error
        Err(ExcelError::new(ExcelErrorKind::Ref))
    }
}

impl FunctionProvider for DuckDbEvaluationContext {
    fn get_function(
        &self,
        ns: &str,
        name: &str,
    ) -> Option<Arc<dyn formualizer_eval::function::Function>> {
        // Use global function registry from builtins
        formualizer_eval::function_registry::get(ns, name)
    }
}

impl SourceResolver for DuckDbEvaluationContext {}

// Blanket implementation of Resolver
impl Resolver for DuckDbEvaluationContext {}

impl EvaluationContext for DuckDbEvaluationContext {
    fn resolve_range_view<'c>(
        &'c self,
        reference: &ReferenceType,
        _current_sheet: &str,
    ) -> Result<RangeView<'c>, ExcelError> {
        match reference {
            ReferenceType::Cell {
                sheet, row, col, ..
            } => {
                let value = self.resolve_cell_reference(sheet.as_deref(), *row, *col)?;
                self.cache_range_view(vec![vec![value]])
            }
            ReferenceType::Range {
                sheet: _,
                start_row,
                start_col,
                end_row,
                end_col,
                ..
            } => {
                let data = self.resolve_range_data(*start_row, *start_col, *end_row, *end_col)?;
                self.cache_range_view(data)
            }
            ReferenceType::NamedRange(_) => Err(ExcelError::new(ExcelErrorKind::Name)),
            ReferenceType::Table(_) => Err(ExcelError::new(ExcelErrorKind::Ref)),
            ReferenceType::External(_) => Err(ExcelError::new(ExcelErrorKind::Ref)),
        }
    }

    fn backend_caps(&self) -> BackendCaps {
        BackendCaps {
            // FIXED: Set streaming=false since we materialize ranges into memory
            streaming: false,
            used_region: false,  // We don't compute used-region hints
            write: false,        // Read-only formula evaluation
            tables: false,       // No table structure support in v1
            async_stream: false, // Synchronous evaluation
        }
    }
}

// ============================================================================
// Public API
// ============================================================================

/// Evaluate a formula using DuckDB backend.
///
/// # Arguments
/// * `conn` - Pooled DuckDB connection
/// * `dataset_id` - Dataset identifier
/// * `formula` - Formula string (WITH leading =)
/// * `view_position` - Cell position in VIEW coords (0-based row, 0-based col)
///                     This is where the formula is entered, used for relative refs
/// * `col_letter_to_id` - Column letter -> column ID mapping
/// * `row_order_slice` - Optional (start_offset, row_order) for view->model mapping
///                       start_offset is 0-based
/// * `row_count` - Total row count in dataset
///
/// # Returns
/// JSON Value representation of the result
pub fn evaluate_formula(
    conn: Arc<Mutex<Connection>>,
    dataset_id: &str,
    formula: &str,
    view_position: (usize, usize), // Changed name to clarify: VIEW coords, 0-based
    col_letter_to_id: HashMap<String, String>,
    row_order_slice: Option<(usize, Vec<usize>)>,
    row_count: usize,
) -> Result<Value, String> {
    // Formualizer expects Excel-style formulas with leading "=".
    // Accept either input and normalize to include "=" for consistency.
    let trimmed = formula.trim_start();
    let formula_text = if trimmed.starts_with('=') {
        trimmed.to_string()
    } else {
        format!("={}", trimmed)
    };

    let sanitized_formula = strip_a1_annotations(&formula_text);

    // Parse the formula
    let ast = parse(sanitized_formula).map_err(|e| format!("Parse error: {:?}", e))?;

    // Create row order mapper
    let row_mapper = match row_order_slice {
        Some((start, order)) => RowOrderMapper::from_slice(start, order, row_count),
        None => RowOrderMapper::identity(row_count),
    };

    // Create column mapper
    let col_mapper = ColumnMapper::new(col_letter_to_id);

    // Create evaluation context
    let context = DuckDbEvaluationContext::new(
        conn,
        dataset_id.to_string(),
        row_mapper,
        col_mapper,
        row_count,
    );

    // CRITICAL: Create cell reference for the VIEW position where formula is entered
    // CellRef/Coord use 0-based indices internally.
    let cell = CellRef::new_absolute(
        0, // sheet 0 = default sheet
        view_position.0 as u32,
        view_position.1 as u32,
    );

    // Create interpreter and evaluate
    let interpreter = Interpreter::new_with_cell(&context, "Sheet1", cell);
    let result = interpreter
        .evaluate_ast(&ast)
        .map_err(|e| format!("Evaluation error: {:?}", e))?;
    let literal = result.into_literal();

    // Check for array results - these should return #SPILL! in single-cell context
    if let LiteralValue::Array(rows) = &literal {
        if rows.len() > 1 || (rows.len() == 1 && rows[0].len() > 1) {
            // Multi-cell array result in single-cell context = #SPILL!
            return Ok(Value::String("#SPILL!".to_string()));
        }
        // 1x1 array - extract the single value
        if rows.len() == 1 && rows[0].len() == 1 {
            return Ok(literal_to_json(&rows[0][0]));
        }
    }

    // Convert result to JSON
    Ok(literal_to_json(&literal))
}

/// Convert LiteralValue to JSON Value
fn literal_to_json(lit: &LiteralValue) -> Value {
    match lit {
        LiteralValue::Empty => Value::Null,
        LiteralValue::Pending => Value::Null, // Pending evaluations treated as null
        LiteralValue::Boolean(b) => Value::Bool(*b),
        LiteralValue::Int(n) => Value::Number(serde_json::Number::from(*n)),
        LiteralValue::Number(n) => {
            if n.is_nan() || n.is_infinite() {
                Value::String(format!("{}", n))
            } else {
                serde_json::Number::from_f64(*n)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            }
        }
        LiteralValue::Text(s) => Value::String(s.clone()),
        LiteralValue::Error(e) => Value::String(format!("{}", e)),
        LiteralValue::Date(d) => Value::String(d.format("%Y-%m-%d").to_string()),
        LiteralValue::DateTime(dt) => Value::String(dt.format("%Y-%m-%dT%H:%M:%S").to_string()),
        LiteralValue::Time(t) => Value::String(t.format("%H:%M:%S").to_string()),
        LiteralValue::Duration(dur) => Value::Number(serde_json::Number::from(dur.num_seconds())),
        LiteralValue::Array(rows) => {
            // Note: Arrays reaching here means we're in a context that accepts arrays
            let arr: Vec<Value> = rows
                .iter()
                .map(|row| Value::Array(row.iter().map(literal_to_json).collect()))
                .collect();
            Value::Array(arr)
        }
    }
}

/// Strip UI-only annotations like "A1 (Column Name)" from formulas.
/// These annotations are for display only and are not valid Excel syntax.
///
/// IMPORTANT: This logic is duplicated in TypeScript frontend
/// (src/lib/grid/formulas/formulaService.ts normalizeA1ReferenceWhitespace).
/// Any changes here MUST be mirrored there to avoid parsing divergence.
fn strip_a1_annotations(formula: &str) -> String {
    let chars: Vec<char> = formula.chars().collect();
    let mut out = String::with_capacity(chars.len());
    let mut i = 0;
    let mut in_string = false;

    while i < chars.len() {
        let ch = chars[i];

        if ch == '"' {
            out.push(ch);
            if in_string && i + 1 < chars.len() && chars[i + 1] == '"' {
                // Escaped quote inside string literal.
                out.push('"');
                i += 2;
                continue;
            }
            in_string = !in_string;
            i += 1;
            continue;
        }

        if !in_string {
            if let Some(end) = parse_a1_cell_ref(&chars, i) {
                for c in &chars[i..end] {
                    out.push(*c);
                }

                let mut j = end;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }

                if j > end && j < chars.len() && chars[j] == '(' {
                    let mut depth = 0;
                    let mut k = j;
                    while k < chars.len() {
                        if chars[k] == '(' {
                            depth += 1;
                        } else if chars[k] == ')' {
                            depth -= 1;
                            if depth == 0 {
                                k += 1;
                                break;
                            }
                        }
                        k += 1;
                    }

                    if depth == 0 {
                        i = k;
                        continue;
                    }
                }

                for c in &chars[end..j] {
                    out.push(*c);
                }

                i = j;
                continue;
            }
        }

        out.push(ch);
        i += 1;
    }

    out
}

fn parse_a1_cell_ref(chars: &[char], start: usize) -> Option<usize> {
    let mut i = start;

    if i >= chars.len() {
        return None;
    }

    if chars[i] == '$' {
        i += 1;
        if i >= chars.len() {
            return None;
        }
    }

    let col_start = i;
    while i < chars.len() && chars[i].is_ascii_alphabetic() {
        i += 1;
    }

    let col_len = i.saturating_sub(col_start);
    if col_len == 0 || col_len > 3 {
        return None;
    }

    if i < chars.len() && chars[i] == '$' {
        i += 1;
    }

    let row_start = i;
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }

    if i == row_start {
        return None;
    }

    Some(i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_col_index_to_letter() {
        assert_eq!(ColumnMapper::col_index_to_letter(0), "A");
        assert_eq!(ColumnMapper::col_index_to_letter(25), "Z");
        assert_eq!(ColumnMapper::col_index_to_letter(26), "AA");
        assert_eq!(ColumnMapper::col_index_to_letter(27), "AB");
        assert_eq!(ColumnMapper::col_index_to_letter(701), "ZZ");
        assert_eq!(ColumnMapper::col_index_to_letter(702), "AAA");
    }

    #[test]
    fn test_row_order_mapper_identity() {
        let mapper = RowOrderMapper::identity(100);
        assert_eq!(mapper.view_to_model(0), Ok(0));
        assert_eq!(mapper.view_to_model(99), Ok(99));
        // Out of bounds
        assert!(mapper.view_to_model(100).is_err());
    }

    #[test]
    fn test_row_order_mapper_slice() {
        // Row order slice for rows 10-14: [5, 3, 8, 1, 9]
        // Meaning: view row 10 -> model row 5, view row 11 -> model row 3, etc.
        let mapper = RowOrderMapper::from_slice(10, vec![5, 3, 8, 1, 9], 100);
        assert_eq!(mapper.view_to_model(10), Ok(5));
        assert_eq!(mapper.view_to_model(11), Ok(3));
        assert_eq!(mapper.view_to_model(12), Ok(8));
        assert_eq!(mapper.view_to_model(13), Ok(1));
        assert_eq!(mapper.view_to_model(14), Ok(9));
        // Out of range - should error, not silently return None
        assert!(mapper.view_to_model(9).is_err());
        assert!(mapper.view_to_model(15).is_err());
    }

    #[test]
    fn test_row_order_mapper_range() {
        let mapper = RowOrderMapper::from_slice(10, vec![5, 3, 8, 1, 9], 100);
        // Full range within slice
        assert_eq!(mapper.view_range_to_model(10, 14), Ok(vec![5, 3, 8, 1, 9]));
        // Partial range
        assert_eq!(mapper.view_range_to_model(11, 13), Ok(vec![3, 8, 1]));
        // Range extending outside slice should error
        assert!(mapper.view_range_to_model(9, 14).is_err());
        assert!(mapper.view_range_to_model(10, 15).is_err());
    }

    #[test]
    fn test_1_based_to_0_based_conversion() {
        // This test documents the coordinate convention:
        // - Excel/Formualizer: A1 = row 1, col 1 (1-based)
        // - Internal: row 0, col 0 (0-based)
        // The resolve_cell_reference trait receives 1-based and we convert

        // A1 in Excel = row 1, col 1 in Formualizer = row 0, col 0 internal
        let row_1based = 1u32;
        let col_1based = 1u32;
        let row_0based = row_1based.checked_sub(1).unwrap();
        let col_0based = col_1based.checked_sub(1).unwrap();
        assert_eq!(row_0based, 0);
        assert_eq!(col_0based, 0);

        // B5 in Excel = row 5, col 2 in Formualizer = row 4, col 1 internal
        let row_1based = 5u32;
        let col_1based = 2u32;
        let row_0based = row_1based.checked_sub(1).unwrap();
        let col_0based = col_1based.checked_sub(1).unwrap();
        assert_eq!(row_0based, 4);
        assert_eq!(col_0based, 1);
    }
}
