// Data Export Commands - Phase 4 Milestone 2 & 6
//
// Handles export of statistical results to multiple formats:
// - Excel (.xlsx) - Milestone 2
// - CSV (.csv) - Milestone 6
// - HTML (.html) - Milestone 6
// - JSON (.json) - Milestone 6

use rust_xlsxwriter::{Color, Format, FormatAlign, Workbook, Worksheet};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use tauri::command;

/// Export container with versioning for backward compatibility
/// Accepts generic JSON values to support all current and future test types
#[derive(Deserialize, Debug)]
pub struct ExportContainer {
    pub version: String,
    pub results: Vec<Value>, // Generic JSON - accepts entire TestResult objects
}

/// Legacy structs (kept for backward compatibility with old export format)
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatisticBlock {
    pub statistic: Option<f64>,
    pub p_value: Option<f64>,
    pub degrees_of_freedom: Option<f64>,
    pub effect_size: Option<f64>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestResultExport {
    pub id: String,
    pub test_name: String,
    pub family: String,
    pub statistics: Option<StatisticBlock>,
    pub summary: Option<HashMap<String, serde_json::Value>>,
    pub executed_at: String,
}

#[derive(Deserialize, Debug)]
pub struct ExportPayload {
    pub results: Vec<TestResultExport>,
}

#[derive(Deserialize, Debug)]
pub struct MultiSheetExportPayload {
    pub sheets: Vec<SheetExport>,
}

#[derive(Deserialize, Debug)]
pub struct SheetExport {
    pub name: String,
    pub columns: Vec<String>,
    pub rows: Vec<HashMap<String, serde_json::Value>>,
}

/// Export statistical results to Excel file (Container-based)
///
/// # Arguments
/// * `container` - JSON string containing ExportContainer with full TestResult objects
/// * `file_path` - Destination path for the .xlsx file
///
/// # Returns
/// * `Ok(())` on success
/// * `Err(String)` with error message on failure
///
/// # Format
/// - Sheet 1: Summary (overview of all results)
/// - Sheet 2+: Detailed result per test (metadata + ECP tables + assumptions + post-hoc + coefficients)
#[command]
pub async fn export_results_excel(container: String, file_path: String) -> Result<(), String> {
    log::info!("Exporting results to Excel: {}", file_path);

    let export: ExportContainer =
        serde_json::from_str(&container).map_err(|e| format!("Invalid export container: {}", e))?;

    if export.results.is_empty() {
        return Err("No results to export".to_string());
    }

    // Validate version (future-proofing)
    if export.version != "1.0" {
        log::warn!("Unknown export version: {}", export.version);
    }

    let mut workbook = Workbook::new();

    // Sheet 1: Summary (overview of all results)
    create_summary_sheet(&mut workbook, &export.results)?;

    // Sheets 2+: Detailed results (one per test)
    for (idx, result) in export.results.iter().enumerate() {
        create_detail_sheet(&mut workbook, result, idx)?;
    }

    workbook.save(&file_path).map_err(|e| e.to_string())?;

    log::info!(
        "Successfully exported {} results to {}",
        export.results.len(),
        file_path
    );
    Ok(())
}

// ==================== Helper Functions for Excel Export ====================

/// Create summary sheet (overview of all results)
fn create_summary_sheet(workbook: &mut Workbook, results: &[Value]) -> Result<(), String> {
    let sheet = workbook.add_worksheet();
    sheet.set_name("Summary").map_err(|e| e.to_string())?;

    // Format definitions
    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0x4472C4))
        .set_font_color(Color::White);

    let significant_format = Format::new()
        .set_background_color(Color::RGB(0xC6EFCE))
        .set_font_color(Color::RGB(0x006100));

    // Write headers
    let headers = [
        "Test Name",
        "Family",
        "Statistic",
        "p-value",
        "Effect Size",
        "Executed At",
    ];
    for (col, header) in headers.iter().enumerate() {
        sheet
            .write_string_with_format(0, col as u16, *header, &header_format)
            .map_err(|e| e.to_string())?;
    }

    // Write data rows (safe field extraction)
    for (idx, result) in results.iter().enumerate() {
        let row = (idx + 1) as u32;

        // Test name
        let test_name = result["testName"].as_str().unwrap_or("Unknown");
        sheet
            .write_string(row, 0, test_name)
            .map_err(|e| e.to_string())?;

        // Family
        let family = result["family"].as_str().unwrap_or("Unknown");
        sheet
            .write_string(row, 1, family)
            .map_err(|e| e.to_string())?;

        // Statistics (safely navigate nested JSON)
        if let Some(stats) = result.get("statistics") {
            if let Some(stat) = stats.get("statistic").and_then(|v| v.as_f64()) {
                sheet
                    .write_number(row, 2, stat)
                    .map_err(|e| e.to_string())?;
            }

            if let Some(p) = stats.get("pValue").and_then(|v| v.as_f64()) {
                if p < 0.05 {
                    sheet
                        .write_number_with_format(row, 3, p, &significant_format)
                        .map_err(|e| e.to_string())?;
                } else {
                    sheet.write_number(row, 3, p).map_err(|e| e.to_string())?;
                }
            }

            if let Some(es) = stats.get("effectSize").and_then(|v| v.as_f64()) {
                sheet.write_number(row, 4, es).map_err(|e| e.to_string())?;
            }
        }

        // Executed at
        if let Some(exec) = result["executedAt"].as_str() {
            sheet
                .write_string(row, 5, exec)
                .map_err(|e| e.to_string())?;
        }
    }

    // Set column widths
    sheet.set_column_width(0, 25).map_err(|e| e.to_string())?; // Test name
    sheet.set_column_width(1, 15).map_err(|e| e.to_string())?; // Family
    sheet.set_column_width(2, 12).map_err(|e| e.to_string())?; // Statistic
    sheet.set_column_width(3, 12).map_err(|e| e.to_string())?; // p-value
    sheet.set_column_width(4, 12).map_err(|e| e.to_string())?; // Effect size
    sheet.set_column_width(5, 22).map_err(|e| e.to_string())?; // Executed at

    Ok(())
}

/// Create detail sheet for a single result
fn create_detail_sheet(
    workbook: &mut Workbook,
    result: &Value,
    index: usize,
) -> Result<(), String> {
    let test_name = result["testName"].as_str().unwrap_or("Result");
    let sheet_name = truncate_sheet_name(&format!("{} ({})", test_name, index + 1));

    let sheet = workbook.add_worksheet();
    sheet.set_name(&sheet_name).map_err(|e| e.to_string())?;

    let mut current_row = 0u32;

    // Section 1: Metadata
    current_row = write_metadata_section(sheet, result, current_row)?;

    // Section 2: Core Statistics (summary cards)
    if result.get("statistics").is_some() {
        current_row = write_statistics_section(sheet, result, current_row)?;
    }

    // Section 3: ECP Tables (if present) - PRIMARY CONTENT
    if let Some(ecp_collection) = result.get("ecpTableCollection") {
        current_row = write_ecp_tables_section(sheet, ecp_collection, current_row)?;
    }

    // Section 4: Assumptions (if present)
    if let Some(assumptions) = result.get("assumptions") {
        if let Some(arr) = assumptions.as_array() {
            if !arr.is_empty() {
                current_row = write_assumptions_section(sheet, assumptions, current_row)?;
            }
        }
    }

    // Section 5: Post-hoc (if present)
    if let Some(post_hoc) = result.get("postHoc") {
        if let Some(arr) = post_hoc.as_array() {
            if !arr.is_empty() {
                current_row = write_post_hoc_section(sheet, post_hoc, current_row)?;
            }
        }
    }

    // Section 6: Coefficients (if present)
    if let Some(coefficients) = result.get("coefficients") {
        if let Some(arr) = coefficients.as_array() {
            if !arr.is_empty() {
                current_row = write_coefficients_section(sheet, coefficients, current_row)?;
            }
        }
    }

    // Section 7: Model Fit (if present)
    if let Some(model_fit) = result.get("modelFit") {
        let _ = write_model_fit_section(sheet, model_fit, current_row)?;
    }

    Ok(())
}

/// Write metadata section (test name, family, executed at)
fn write_metadata_section(
    sheet: &mut Worksheet,
    result: &Value,
    start_row: u32,
) -> Result<u32, String> {
    let mut current_row = start_row;

    let title_format = Format::new().set_bold().set_font_size(14);
    let label_format = Format::new().set_bold();

    // Title
    let test_name = result["testName"].as_str().unwrap_or("Unknown Test");
    sheet
        .write_string_with_format(current_row, 0, test_name, &title_format)
        .map_err(|e| e.to_string())?;
    current_row += 2;

    // Metadata rows
    if let Some(family) = result["family"].as_str() {
        sheet
            .write_string_with_format(current_row, 0, "Family:", &label_format)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(current_row, 1, family)
            .map_err(|e| e.to_string())?;
        current_row += 1;
    }

    if let Some(exec) = result["executedAt"].as_str() {
        sheet
            .write_string_with_format(current_row, 0, "Executed:", &label_format)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(current_row, 1, exec)
            .map_err(|e| e.to_string())?;
        current_row += 1;
    }

    current_row += 1; // Blank row
    Ok(current_row)
}

/// Write statistics section (core stats like F-value, p-value, effect size)
fn write_statistics_section(
    sheet: &mut Worksheet,
    result: &Value,
    start_row: u32,
) -> Result<u32, String> {
    let mut current_row = start_row;

    let section_header = Format::new().set_bold().set_font_size(12);
    let label_format = Format::new().set_bold();

    sheet
        .write_string_with_format(current_row, 0, "Core Statistics", &section_header)
        .map_err(|e| e.to_string())?;
    current_row += 1;

    if let Some(stats) = result.get("statistics") {
        if let Some(stat) = stats.get("statistic").and_then(|v| v.as_f64()) {
            sheet
                .write_string_with_format(current_row, 0, "Test Statistic:", &label_format)
                .map_err(|e| e.to_string())?;
            sheet
                .write_number(current_row, 1, stat)
                .map_err(|e| e.to_string())?;
            current_row += 1;
        }

        if let Some(p) = stats.get("pValue").and_then(|v| v.as_f64()) {
            sheet
                .write_string_with_format(current_row, 0, "p-value:", &label_format)
                .map_err(|e| e.to_string())?;
            sheet
                .write_number(current_row, 1, p)
                .map_err(|e| e.to_string())?;
            current_row += 1;
        }

        if let Some(df) = stats.get("degreesOfFreedom").and_then(|v| v.as_f64()) {
            sheet
                .write_string_with_format(current_row, 0, "Degrees of Freedom:", &label_format)
                .map_err(|e| e.to_string())?;
            sheet
                .write_number(current_row, 1, df)
                .map_err(|e| e.to_string())?;
            current_row += 1;
        }

        if let Some(es) = stats.get("effectSize").and_then(|v| v.as_f64()) {
            sheet
                .write_string_with_format(current_row, 0, "Effect Size:", &label_format)
                .map_err(|e| e.to_string())?;
            sheet
                .write_number(current_row, 1, es)
                .map_err(|e| e.to_string())?;
            current_row += 1;
        }
    }

    current_row += 1; // Blank row
    Ok(current_row)
}

/// Write ECP tables section (publication-ready tables)
fn write_ecp_tables_section(
    sheet: &mut Worksheet,
    ecp_collection: &Value,
    start_row: u32,
) -> Result<u32, String> {
    let mut current_row = start_row;

    if let Some(tables) = ecp_collection["tables"].as_array() {
        for table in tables {
            current_row = write_single_ecp_table(sheet, table, current_row)?;
            current_row += 2; // Spacing between tables
        }
    }

    Ok(current_row)
}

/// Write a single ECP table with proper formatting
fn write_single_ecp_table(
    sheet: &mut Worksheet,
    table: &Value,
    start_row: u32,
) -> Result<u32, String> {
    let mut current_row = start_row;

    let title_format = Format::new().set_bold().set_font_size(12);
    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0x4472C4))
        .set_font_color(Color::White)
        .set_align(FormatAlign::Center);
    let right_align = Format::new().set_align(FormatAlign::Right);
    let left_align = Format::new().set_align(FormatAlign::Left);

    // Table title
    if let Some(title) = table["title"].as_str() {
        sheet
            .write_string_with_format(current_row, 0, title, &title_format)
            .map_err(|e| e.to_string())?;
        current_row += 1;
    }

    // Procedure label
    if let Some(proc) = table["procedure"].as_str() {
        sheet
            .write_string(current_row, 0, proc)
            .map_err(|e| e.to_string())?;
        current_row += 1;
    }

    current_row += 1; // Blank row

    // Column headers
    if let Some(columns) = table["columns"].as_array() {
        for (col_idx, column) in columns.iter().enumerate() {
            if let Some(header) = column["header"].as_str() {
                sheet
                    .write_string_with_format(current_row, col_idx as u16, header, &header_format)
                    .map_err(|e| e.to_string())?;
            }
        }
        current_row += 1;

        // Data rows
        if let Some(rows) = table["rows"].as_array() {
            for row in rows {
                if let Some(cells) = row["cells"].as_array() {
                    for (col_idx, cell) in cells.iter().enumerate() {
                        // Determine alignment
                        let align_str = cell
                            .get("align")
                            .and_then(|v| v.as_str())
                            .or_else(|| columns.get(col_idx).and_then(|c| c["align"].as_str()));

                        let format = match align_str {
                            Some("right") => &right_align,
                            Some("center") => &header_format,
                            _ => &left_align,
                        };

                        // Write cell value
                        if let Some(value) = cell.get("value") {
                            match value {
                                Value::Number(n) => {
                                    if let Some(f) = n.as_f64() {
                                        sheet
                                            .write_number_with_format(
                                                current_row,
                                                col_idx as u16,
                                                f,
                                                format,
                                            )
                                            .map_err(|e| e.to_string())?;
                                    }
                                }
                                Value::String(s) => {
                                    sheet
                                        .write_string_with_format(
                                            current_row,
                                            col_idx as u16,
                                            s,
                                            format,
                                        )
                                        .map_err(|e| e.to_string())?;
                                }
                                _ => {}
                            }
                        }
                    }
                    current_row += 1;
                }
            }
        }
    }

    // Footnotes
    if let Some(footnotes) = table["footnotes"].as_array() {
        if !footnotes.is_empty() {
            current_row += 1;
            for footnote in footnotes {
                if let Some(note) = footnote.as_str() {
                    sheet
                        .write_string(current_row, 0, note)
                        .map_err(|e| e.to_string())?;
                    current_row += 1;
                }
            }
        }
    }

    Ok(current_row)
}

/// Write assumptions section
fn write_assumptions_section(
    sheet: &mut Worksheet,
    assumptions: &Value,
    start_row: u32,
) -> Result<u32, String> {
    let mut current_row = start_row;

    let section_header = Format::new().set_bold().set_font_size(12);
    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0x4472C4))
        .set_font_color(Color::White);

    sheet
        .write_string_with_format(current_row, 0, "Assumptions Tests", &section_header)
        .map_err(|e| e.to_string())?;
    current_row += 2;

    // Table headers
    let headers = ["Test", "Statistic", "p-value", "Result"];
    for (col, header) in headers.iter().enumerate() {
        sheet
            .write_string_with_format(current_row, col as u16, *header, &header_format)
            .map_err(|e| e.to_string())?;
    }
    current_row += 1;

    // Data rows
    if let Some(arr) = assumptions.as_array() {
        for assumption in arr {
            let name = assumption["name"].as_str().unwrap_or("");
            let stat = assumption["statistic"].as_f64().unwrap_or(0.0);
            let p = assumption["pValue"].as_f64().unwrap_or(0.0);
            let passed = assumption["passed"].as_bool().unwrap_or(false);

            sheet
                .write_string(current_row, 0, name)
                .map_err(|e| e.to_string())?;
            sheet
                .write_number(current_row, 1, stat)
                .map_err(|e| e.to_string())?;
            sheet
                .write_number(current_row, 2, p)
                .map_err(|e| e.to_string())?;
            sheet
                .write_string(current_row, 3, if passed { "✓ Passed" } else { "✗ Failed" })
                .map_err(|e| e.to_string())?;
            current_row += 1;
        }
    }

    current_row += 1;
    Ok(current_row)
}

/// Write post-hoc section
fn write_post_hoc_section(
    sheet: &mut Worksheet,
    post_hoc: &Value,
    start_row: u32,
) -> Result<u32, String> {
    let mut current_row = start_row;

    let section_header = Format::new().set_bold().set_font_size(12);
    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0x4472C4))
        .set_font_color(Color::White);

    sheet
        .write_string_with_format(current_row, 0, "Post-Hoc Comparisons", &section_header)
        .map_err(|e| e.to_string())?;
    current_row += 2;

    // Table headers
    let headers = [
        "Comparison",
        "Statistic",
        "p-value",
        "Adj. p-value",
        "Significant",
    ];
    for (col, header) in headers.iter().enumerate() {
        sheet
            .write_string_with_format(current_row, col as u16, *header, &header_format)
            .map_err(|e| e.to_string())?;
    }
    current_row += 1;

    // Data rows
    if let Some(arr) = post_hoc.as_array() {
        for ph in arr {
            let comparison = ph["comparison"].as_str().unwrap_or("");
            let stat = ph["statistic"].as_f64().unwrap_or(0.0);
            let p = ph["pValue"].as_f64().unwrap_or(0.0);
            let p_adj = ph["pValueAdjusted"].as_f64();
            let sig = ph["significant"].as_bool().unwrap_or(false);

            sheet
                .write_string(current_row, 0, comparison)
                .map_err(|e| e.to_string())?;
            sheet
                .write_number(current_row, 1, stat)
                .map_err(|e| e.to_string())?;
            sheet
                .write_number(current_row, 2, p)
                .map_err(|e| e.to_string())?;

            if let Some(p_adj_val) = p_adj {
                sheet
                    .write_number(current_row, 3, p_adj_val)
                    .map_err(|e| e.to_string())?;
            } else {
                sheet
                    .write_string(current_row, 3, "-")
                    .map_err(|e| e.to_string())?;
            }

            sheet
                .write_string(current_row, 4, if sig { "✓" } else { "-" })
                .map_err(|e| e.to_string())?;
            current_row += 1;
        }
    }

    current_row += 1;
    Ok(current_row)
}

/// Write coefficients section (for regression)
fn write_coefficients_section(
    sheet: &mut Worksheet,
    coefficients: &Value,
    start_row: u32,
) -> Result<u32, String> {
    let mut current_row = start_row;

    let section_header = Format::new().set_bold().set_font_size(12);
    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0x4472C4))
        .set_font_color(Color::White);

    sheet
        .write_string_with_format(current_row, 0, "Regression Coefficients", &section_header)
        .map_err(|e| e.to_string())?;
    current_row += 2;

    // Table headers
    let headers = [
        "Variable",
        "Estimate",
        "Std. Error",
        "t-Statistic",
        "p-value",
    ];
    for (col, header) in headers.iter().enumerate() {
        sheet
            .write_string_with_format(current_row, col as u16, *header, &header_format)
            .map_err(|e| e.to_string())?;
    }
    current_row += 1;

    // Data rows
    if let Some(arr) = coefficients.as_array() {
        for coef in arr {
            let name = coef["name"].as_str().unwrap_or("");
            let estimate = coef["estimate"].as_f64().unwrap_or(0.0);
            let std_error = coef["stdError"].as_f64().unwrap_or(0.0);
            let t_stat = coef["tStatistic"].as_f64();
            let p = coef["pValue"].as_f64().unwrap_or(0.0);

            sheet
                .write_string(current_row, 0, name)
                .map_err(|e| e.to_string())?;
            sheet
                .write_number(current_row, 1, estimate)
                .map_err(|e| e.to_string())?;
            sheet
                .write_number(current_row, 2, std_error)
                .map_err(|e| e.to_string())?;

            if let Some(t) = t_stat {
                sheet
                    .write_number(current_row, 3, t)
                    .map_err(|e| e.to_string())?;
            } else {
                sheet
                    .write_string(current_row, 3, "-")
                    .map_err(|e| e.to_string())?;
            }

            sheet
                .write_number(current_row, 4, p)
                .map_err(|e| e.to_string())?;
            current_row += 1;
        }
    }

    current_row += 1;
    Ok(current_row)
}

/// Write model fit section
fn write_model_fit_section(
    sheet: &mut Worksheet,
    model_fit: &Value,
    start_row: u32,
) -> Result<u32, String> {
    let mut current_row = start_row;

    let section_header = Format::new().set_bold().set_font_size(12);
    let label_format = Format::new().set_bold();

    sheet
        .write_string_with_format(current_row, 0, "Model Fit Statistics", &section_header)
        .map_err(|e| e.to_string())?;
    current_row += 1;

    if let Some(r2) = model_fit.get("r2").and_then(|v| v.as_f64()) {
        sheet
            .write_string_with_format(current_row, 0, "R²:", &label_format)
            .map_err(|e| e.to_string())?;
        sheet
            .write_number(current_row, 1, r2)
            .map_err(|e| e.to_string())?;
        current_row += 1;
    }

    if let Some(adj_r2) = model_fit.get("adjustedR2").and_then(|v| v.as_f64()) {
        sheet
            .write_string_with_format(current_row, 0, "Adjusted R²:", &label_format)
            .map_err(|e| e.to_string())?;
        sheet
            .write_number(current_row, 1, adj_r2)
            .map_err(|e| e.to_string())?;
        current_row += 1;
    }

    if let Some(rmse) = model_fit.get("rmse").and_then(|v| v.as_f64()) {
        sheet
            .write_string_with_format(current_row, 0, "RMSE:", &label_format)
            .map_err(|e| e.to_string())?;
        sheet
            .write_number(current_row, 1, rmse)
            .map_err(|e| e.to_string())?;
        current_row += 1;
    }

    if let Some(aic) = model_fit.get("aic").and_then(|v| v.as_f64()) {
        sheet
            .write_string_with_format(current_row, 0, "AIC:", &label_format)
            .map_err(|e| e.to_string())?;
        sheet
            .write_number(current_row, 1, aic)
            .map_err(|e| e.to_string())?;
        current_row += 1;
    }

    if let Some(bic) = model_fit.get("bic").and_then(|v| v.as_f64()) {
        sheet
            .write_string_with_format(current_row, 0, "BIC:", &label_format)
            .map_err(|e| e.to_string())?;
        sheet
            .write_number(current_row, 1, bic)
            .map_err(|e| e.to_string())?;
        current_row += 1;
    }

    current_row += 1;
    Ok(current_row)
}

/// Truncate sheet name to Excel's 31-character limit
fn truncate_sheet_name(name: &str) -> String {
    if name.len() <= 31 {
        name.to_string()
    } else {
        format!("{}...", &name[..28])
    }
}

fn is_valid_xml_char(ch: char) -> bool {
    matches!(
        ch,
        '\u{9}'
            | '\u{A}'
            | '\u{D}'
            | '\u{20}'..='\u{D7FF}'
            | '\u{E000}'..='\u{FFFD}'
            | '\u{10000}'..='\u{10FFFF}'
    )
}

fn sanitize_excel_string(value: &str) -> String {
    value.chars().filter(|ch| is_valid_xml_char(*ch)).collect()
}

fn sanitize_sheet_name(name: &str) -> String {
    let mut cleaned = String::with_capacity(name.len());
    for ch in name.chars() {
        if !is_valid_xml_char(ch) {
            continue;
        }
        let next = match ch {
            ':' | '\\' | '/' | '?' | '*' | '[' | ']' => '-',
            _ => ch,
        };
        cleaned.push(next);
    }
    let cleaned = cleaned.trim().trim_matches('\'');
    let fallback = if cleaned.is_empty() { "Sheet" } else { cleaned };
    truncate_sheet_name(fallback)
}

fn make_unique_sheet_name(name: &str, index: usize, used: &mut HashMap<String, u32>) -> String {
    let base = sanitize_sheet_name(name);
    let base_key = if base.is_empty() {
        "Sheet".to_string()
    } else {
        base
    };
    let count = used.entry(base_key.clone()).or_insert(0);
    if *count == 0 {
        *count = 1;
        return base_key;
    }
    *count += 1;
    let suffix = format!(" ({})", count);
    let max_base_len = 31usize.saturating_sub(suffix.len());
    let mut trimmed = base_key.clone();
    if trimmed.len() > max_base_len {
        trimmed.truncate(max_base_len);
    }
    if trimmed.is_empty() {
        let mut fallback = format!("Sheet{}", index);
        if fallback.len() > 31 {
            fallback.truncate(31);
        }
        return fallback;
    }
    format!("{}{}", trimmed, suffix)
}

/// Export statistical results to CSV file
///
/// # Arguments
/// * `results` - JSON string containing ExportPayload with results array
/// * `file_path` - Destination path for the .csv file
#[command]
pub async fn export_results_csv(results: String, file_path: String) -> Result<(), String> {
    log::info!("Exporting results to CSV: {}", file_path);

    let payload: ExportPayload =
        serde_json::from_str(&results).map_err(|e| format!("Invalid results JSON: {}", e))?;

    if payload.results.is_empty() {
        return Err("No results to export".to_string());
    }

    let mut csv_content = String::new();

    // Write headers
    csv_content.push_str("Test Name,Family,Statistic,p-value,Effect Size,Executed At\n");

    // Write data rows
    for result in &payload.results {
        let statistic = result
            .statistics
            .as_ref()
            .and_then(|s| s.statistic)
            .map(|v| v.to_string())
            .unwrap_or_default();

        let p_value = result
            .statistics
            .as_ref()
            .and_then(|s| s.p_value)
            .map(|v| v.to_string())
            .unwrap_or_default();

        let effect_size = result
            .statistics
            .as_ref()
            .and_then(|s| s.effect_size)
            .map(|v| v.to_string())
            .unwrap_or_default();

        // Escape commas and quotes in strings
        let test_name = escape_csv(&result.test_name);
        let family = escape_csv(&result.family);
        let executed_at = escape_csv(&result.executed_at);

        csv_content.push_str(&format!(
            "{},{},{},{},{},{}\n",
            test_name, family, statistic, p_value, effect_size, executed_at
        ));
    }

    fs::write(&file_path, csv_content).map_err(|e| format!("Failed to write CSV file: {}", e))?;

    log::info!(
        "Successfully exported {} results to CSV",
        payload.results.len()
    );
    Ok(())
}

/// Export statistical results to HTML file
///
/// # Arguments
/// * `results` - JSON string containing ExportPayload with results array
/// * `file_path` - Destination path for the .html file
#[command]
pub async fn export_results_html(results: String, file_path: String) -> Result<(), String> {
    log::info!("Exporting results to HTML: {}", file_path);

    let payload: ExportPayload =
        serde_json::from_str(&results).map_err(|e| format!("Invalid results JSON: {}", e))?;

    if payload.results.is_empty() {
        return Err("No results to export".to_string());
    }

    let mut html = String::from(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Statistical Analysis Results - easyCris</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 40px;
            background: #f5f5f5;
        }
        h1 {
            color: #1a365d;
            border-bottom: 2px solid #3182ce;
            padding-bottom: 10px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            background: white;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            margin-top: 20px;
        }
        th {
            background: #3182ce;
            color: white;
            padding: 12px 15px;
            text-align: left;
            font-weight: 600;
        }
        td {
            padding: 10px 15px;
            border-bottom: 1px solid #e2e8f0;
        }
        tr:hover {
            background: #f7fafc;
        }
        .significant {
            background: #c6f6d5;
            color: #22543d;
            font-weight: 600;
        }
        .footer {
            margin-top: 30px;
            color: #718096;
            font-size: 0.875rem;
        }
    </style>
</head>
<body>
    <h1>Statistical Analysis Results</h1>
    <table>
        <thead>
            <tr>
                <th>Test Name</th>
                <th>Family</th>
                <th>Statistic</th>
                <th>p-value</th>
                <th>Effect Size</th>
                <th>Executed At</th>
            </tr>
        </thead>
        <tbody>
"#,
    );

    // Write data rows
    for result in &payload.results {
        let statistic = result
            .statistics
            .as_ref()
            .and_then(|s| s.statistic)
            .map(|v| format!("{:.4}", v))
            .unwrap_or_else(|| "-".to_string());

        let p_value = result.statistics.as_ref().and_then(|s| s.p_value);

        let p_value_str = p_value
            .map(|v| format!("{:.4}", v))
            .unwrap_or_else(|| "-".to_string());

        let p_class = if p_value.map(|p| p < 0.05).unwrap_or(false) {
            " class=\"significant\""
        } else {
            ""
        };

        let effect_size = result
            .statistics
            .as_ref()
            .and_then(|s| s.effect_size)
            .map(|v| format!("{:.4}", v))
            .unwrap_or_else(|| "-".to_string());

        html.push_str(&format!(
            r#"            <tr>
                <td>{}</td>
                <td>{}</td>
                <td>{}</td>
                <td{}>{}</td>
                <td>{}</td>
                <td>{}</td>
            </tr>
"#,
            escape_html(&result.test_name),
            escape_html(&result.family),
            statistic,
            p_class,
            p_value_str,
            effect_size,
            escape_html(&result.executed_at)
        ));
    }

    html.push_str(
        r#"        </tbody>
    </table>
    <div class="footer">
        Generated by easyCris Statistical Analysis Software
    </div>
</body>
</html>"#,
    );

    fs::write(&file_path, html).map_err(|e| format!("Failed to write HTML file: {}", e))?;

    log::info!(
        "Successfully exported {} results to HTML",
        payload.results.len()
    );
    Ok(())
}

/// Export statistical results to JSON file
///
/// # Arguments
/// * `results` - JSON string containing ExportPayload with results array
/// * `file_path` - Destination path for the .json file
#[command]
pub async fn export_results_json(results: String, file_path: String) -> Result<(), String> {
    log::info!("Exporting results to JSON: {}", file_path);

    // Validate JSON
    let _payload: ExportPayload =
        serde_json::from_str(&results).map_err(|e| format!("Invalid results JSON: {}", e))?;

    // Pretty-print the JSON
    let json_value: serde_json::Value =
        serde_json::from_str(&results).map_err(|e| format!("Invalid JSON: {}", e))?;

    let pretty_json = serde_json::to_string_pretty(&json_value)
        .map_err(|e| format!("Failed to format JSON: {}", e))?;

    fs::write(&file_path, pretty_json).map_err(|e| format!("Failed to write JSON file: {}", e))?;

    log::info!("Successfully exported results to JSON");
    Ok(())
}

/// Export dataset data to CSV file
///
/// # Arguments
/// * `data` - JSON string containing array of row objects
/// * `columns` - Column names in order
/// * `file_path` - Destination path for the .csv file
#[command]
pub async fn export_data_csv(
    data: String,
    columns: Vec<String>,
    file_path: String,
) -> Result<(), String> {
    log::info!("Exporting dataset to CSV: {}", file_path);

    let rows: Vec<HashMap<String, serde_json::Value>> =
        serde_json::from_str(&data).map_err(|e| format!("Invalid data JSON: {}", e))?;

    if rows.is_empty() {
        return Err("No data to export".to_string());
    }

    let mut csv_content = String::new();

    // Write headers
    csv_content.push_str(
        &columns
            .iter()
            .map(|c| escape_csv(c))
            .collect::<Vec<_>>()
            .join(","),
    );
    csv_content.push('\n');

    // Write data rows
    for row in &rows {
        let values: Vec<String> = columns
            .iter()
            .map(|col| {
                row.get(col)
                    .map(|v| match v {
                        serde_json::Value::String(s) => escape_csv(s),
                        serde_json::Value::Number(n) => n.to_string(),
                        serde_json::Value::Bool(b) => b.to_string(),
                        serde_json::Value::Null => String::new(),
                        _ => escape_csv(&v.to_string()),
                    })
                    .unwrap_or_default()
            })
            .collect();

        csv_content.push_str(&values.join(","));
        csv_content.push('\n');
    }

    fs::write(&file_path, csv_content).map_err(|e| format!("Failed to write CSV file: {}", e))?;

    log::info!("Successfully exported {} rows to CSV", rows.len());
    Ok(())
}

/// Export dataset data to Excel file
///
/// # Arguments
/// * `data` - JSON string containing array of row objects
/// * `columns` - Column names in order
/// * `file_path` - Destination path for the .xlsx file
/// * `sheet_name` - Optional custom sheet name (defaults to "Data")
#[command]
pub async fn export_data_excel(
    data: String,
    columns: Vec<String>,
    file_path: String,
    sheet_name: Option<String>,
) -> Result<(), String> {
    log::info!("Exporting dataset to Excel: {}", file_path);

    let rows: Vec<HashMap<String, serde_json::Value>> =
        serde_json::from_str(&data).map_err(|e| format!("Invalid data JSON: {}", e))?;

    if rows.is_empty() {
        return Err("No data to export".to_string());
    }

    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    let name = sheet_name.unwrap_or_else(|| "Data".to_string());
    // Sanitize sheet name: remove invalid chars and truncate to 31 chars (Excel limit)
    let sanitized_name: String = name
        .chars()
        .filter(|c| ![':', '\\', '/', '?', '*', '[', ']'].contains(c))
        .take(31)
        .collect();
    let final_name = if sanitized_name.is_empty() {
        "Data".to_string()
    } else {
        sanitized_name
    };
    sheet.set_name(&final_name).map_err(|e| e.to_string())?;

    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0x4472C4))
        .set_font_color(Color::White);

    for (col_idx, header) in columns.iter().enumerate() {
        let safe_header = sanitize_excel_string(header);
        sheet
            .write_string_with_format(0, col_idx as u16, &safe_header, &header_format)
            .map_err(|e| e.to_string())?;
    }

    for (row_idx, row) in rows.iter().enumerate() {
        let excel_row = (row_idx + 1) as u32;
        for (col_idx, col) in columns.iter().enumerate() {
            let value = row.get(col).unwrap_or(&serde_json::Value::Null);
            match value {
                serde_json::Value::Number(n) => {
                    if let Some(f) = n.as_f64() {
                        // Write empty string for non-finite numbers (NaN, Infinity, -Infinity)
                        // CRITICAL: Never skip writing to a cell position - it corrupts the Excel file
                        if !f.is_finite() {
                            sheet
                                .write_string(excel_row, col_idx as u16, "")
                                .map_err(|e| e.to_string())?;
                        } else {
                            sheet
                                .write_number(excel_row, col_idx as u16, f)
                                .map_err(|e| e.to_string())?;
                        }
                    } else {
                        // Number couldn't be converted to f64 (overflow) - write as string
                        sheet
                            .write_string(excel_row, col_idx as u16, &n.to_string())
                            .map_err(|e| e.to_string())?;
                    }
                }
                serde_json::Value::Bool(b) => {
                    let text = if *b { "true" } else { "false" };
                    let safe_text = sanitize_excel_string(text);
                    sheet
                        .write_string(excel_row, col_idx as u16, &safe_text)
                        .map_err(|e| e.to_string())?;
                }
                serde_json::Value::String(s) => {
                    let safe_value = sanitize_excel_string(s);
                    sheet
                        .write_string(excel_row, col_idx as u16, &safe_value)
                        .map_err(|e| e.to_string())?;
                }
                // CRITICAL: Write empty string for null values - never skip cell positions
                serde_json::Value::Null => {
                    sheet
                        .write_string(excel_row, col_idx as u16, "")
                        .map_err(|e| e.to_string())?;
                }
                _ => {
                    let safe_value = sanitize_excel_string(&value.to_string());
                    sheet
                        .write_string(excel_row, col_idx as u16, &safe_value)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }

    for (col_idx, _) in columns.iter().enumerate() {
        sheet
            .set_column_width(col_idx as u16, 20)
            .map_err(|e| e.to_string())?;
    }

    workbook.save(&file_path).map_err(|e| e.to_string())?;

    log::info!("Successfully exported {} rows to Excel", rows.len());
    Ok(())
}

/// Export multiple datasets to Excel with one sheet per dataset
///
/// # Arguments
/// * `sheets` - JSON string containing MultiSheetExportPayload with sheet data
/// * `file_path` - Destination path for the .xlsx file
#[command]
pub async fn export_data_excel_multi(sheets: String, file_path: String) -> Result<(), String> {
    log::info!("Exporting multi-sheet Excel: {}", file_path);

    let payload: MultiSheetExportPayload =
        serde_json::from_str(&sheets).map_err(|e| format!("Invalid sheets JSON: {}", e))?;

    if payload.sheets.is_empty() {
        return Err("No sheets to export".to_string());
    }

    let mut workbook = Workbook::new();
    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0x4472C4))
        .set_font_color(Color::White);

    let mut used_names: HashMap<String, u32> = HashMap::new();

    for (index, sheet_data) in payload.sheets.iter().enumerate() {
        let sheet = workbook.add_worksheet();
        let sheet_name = make_unique_sheet_name(&sheet_data.name, index + 1, &mut used_names);
        sheet.set_name(&sheet_name).map_err(|e| e.to_string())?;

        for (col_idx, header) in sheet_data.columns.iter().enumerate() {
            let safe_header = sanitize_excel_string(header);
            sheet
                .write_string_with_format(0, col_idx as u16, &safe_header, &header_format)
                .map_err(|e| e.to_string())?;
        }

        for (row_idx, row) in sheet_data.rows.iter().enumerate() {
            let excel_row = (row_idx + 1) as u32;
            for (col_idx, col) in sheet_data.columns.iter().enumerate() {
                let value = row.get(col).unwrap_or(&serde_json::Value::Null);
                match value {
                    serde_json::Value::Number(n) => {
                        if let Some(f) = n.as_f64() {
                            // Write empty string for non-finite numbers (NaN, Infinity, -Infinity)
                            // CRITICAL: Never skip writing to a cell position - it corrupts the Excel file
                            if !f.is_finite() {
                                sheet
                                    .write_string(excel_row, col_idx as u16, "")
                                    .map_err(|e| e.to_string())?;
                            } else {
                                sheet
                                    .write_number(excel_row, col_idx as u16, f)
                                    .map_err(|e| e.to_string())?;
                            }
                        } else {
                            // Number couldn't be converted to f64 (overflow) - write as string
                            sheet
                                .write_string(excel_row, col_idx as u16, &n.to_string())
                                .map_err(|e| e.to_string())?;
                        }
                    }
                    serde_json::Value::Bool(b) => {
                        let text = if *b { "true" } else { "false" };
                        let safe_text = sanitize_excel_string(text);
                        sheet
                            .write_string(excel_row, col_idx as u16, &safe_text)
                            .map_err(|e| e.to_string())?;
                    }
                    serde_json::Value::String(s) => {
                        let safe_value = sanitize_excel_string(s);
                        sheet
                            .write_string(excel_row, col_idx as u16, &safe_value)
                            .map_err(|e| e.to_string())?;
                    }
                    // CRITICAL: Write empty string for null values - never skip cell positions
                    serde_json::Value::Null => {
                        sheet
                            .write_string(excel_row, col_idx as u16, "")
                            .map_err(|e| e.to_string())?;
                    }
                    _ => {
                        let safe_value = sanitize_excel_string(&value.to_string());
                        sheet
                            .write_string(excel_row, col_idx as u16, &safe_value)
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
        }

        for (col_idx, _) in sheet_data.columns.iter().enumerate() {
            sheet
                .set_column_width(col_idx as u16, 20)
                .map_err(|e| e.to_string())?;
        }
    }

    workbook.save(&file_path).map_err(|e| e.to_string())?;

    log::info!(
        "Successfully exported {} sheets to Excel",
        payload.sheets.len()
    );
    Ok(())
}

// ==================== Helper Functions ====================

/// Escape a string for CSV (handle commas, quotes, newlines)
fn escape_csv(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Escape a string for HTML
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_export_with_empty_results() {
        // Container format (v1.0) is required for Excel export.
        let container = r#"{"version":"1.0","results":[]}"#;
        let result = export_results_excel(container.to_string(), "test.xlsx".to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No results"));
    }

    #[tokio::test]
    async fn test_export_with_invalid_json() {
        let container = "not valid json";
        let result = export_results_excel(container.to_string(), "test.xlsx".to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid export container"));
    }
}
