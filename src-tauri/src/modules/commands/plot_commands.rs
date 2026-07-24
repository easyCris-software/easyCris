// Plot Backend Commands - Trendlines and Plot Computations

use crate::modules::errors::AppErrorEnvelope;
use crate::modules::python_backend::{detect_plot_mode, spawn_plot};
use serde_json::Value;
use tauri::command;

/// Run plot backend with arbitrary JSON input.
#[command]
pub async fn run_plot(input: String) -> Result<String, AppErrorEnvelope> {
    let payload: Value = serde_json::from_str(&input).map_err(|e| {
        AppErrorEnvelope::new("PLOT_602", "Plot data is invalid")
            .with_detail(format!("Invalid JSON input: {}", e))
            .with_retryable(false)
    })?;

    let mode = detect_plot_mode();
    let result = spawn_plot(payload, mode).await?;

    serde_json::to_string(&result).map_err(|e| {
        AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
            .with_detail(format!("Failed to serialize result: {}", e))
            .with_retryable(false)
    })
}
