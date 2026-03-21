// Plot Backend Commands - Trendlines and Plot Computations
//
// Provides Tauri commands for plot-related computations:
// - Trendline computation (linear, polynomial)
// - OLE clipboard (Windows-only embedded plot objects)
// - Future: confidence bands, smoothing, etc.

use crate::modules::errors::AppErrorEnvelope;
use crate::modules::python_backend::{detect_plot_backend_mode, spawn_plot_backend};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::command;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

/// Run plot backend with arbitrary JSON input
///
/// Generic command that passes input directly to plot_backend.py
/// Input should include "action" field to route to appropriate handler
///
/// # Arguments
/// * `input` - JSON string to pass to plot_backend.py
///
/// # Returns
/// * JSON string result from plot_backend.py
#[command]
pub async fn run_plot_backend(input: String) -> Result<String, AppErrorEnvelope> {
    // Parse input JSON
    let payload: Value = serde_json::from_str(&input).map_err(|e| {
        AppErrorEnvelope::new("PLOT_602", "Plot data is invalid")
            .with_detail(format!("Invalid JSON input: {}", e))
            .with_retryable(false)
    })?;

    // Spawn plot backend
    let mode = detect_plot_backend_mode();
    let result = spawn_plot_backend(payload, mode).await?;

    // Return as JSON string
    serde_json::to_string(&result).map_err(|e| {
        AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
            .with_detail(format!("Failed to serialize result: {}", e))
            .with_retryable(false)
    })
}

/// Helper function to get Python base directory
fn get_python_base_dir() -> PathBuf {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let resources_dir = exe_dir.join("resources");
            let python_dir = resources_dir.join("python_embedded");
            if python_dir.exists() {
                return resources_dir;
            }

            let python_dir = exe_dir.join("python_embedded");
            if python_dir.exists() {
                return exe_dir.to_path_buf();
            }

            let mut current = exe_dir.to_path_buf();
            for _ in 0..5 {
                let python_dir = current.join("python_embedded");
                if python_dir.exists() {
                    return current;
                }
                if let Some(parent) = current.parent() {
                    current = parent.to_path_buf();
                } else {
                    break;
                }
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let python_dir = cwd.join("python_embedded");
        if python_dir.exists() {
            return cwd;
        }

        if let Some(parent) = cwd.parent() {
            let python_dir = parent.join("python_embedded");
            if python_dir.exists() {
                return parent.to_path_buf();
            }
        }
    }

    PathBuf::from(".")
}

/// Copy plot to Windows OLE clipboard as embedded object
///
/// Creates an embedded OLE object that:
/// - Displays as high-DPI PNG image when pasted in PowerPoint
/// - Double-click opens the embedded .ecp project file (launches easyCris)
/// - Embeds the .ecp bytes (works when PPT is moved/shared)
///
/// Windows-only command using pywin32 for OLE/COM clipboard operations.
///
/// # Arguments
/// * `ecp_path` - Absolute path to .ecp project file (must exist)
/// * `png_bytes` - PNG image data as base64-encoded string
///
/// # Returns
/// * Success message or error
#[command]
pub async fn copy_plot_ole(ecp_path: String, png_bytes: Vec<u8>) -> Result<String, String> {
    // Validate inputs
    let ecp_path_buf = PathBuf::from(&ecp_path);
    if !ecp_path_buf.exists() {
        return Err(format!("Project file not found: {}", ecp_path));
    }

    if !ecp_path_buf.is_absolute() {
        return Err(format!("Project path must be absolute: {}", ecp_path));
    }

    // Find Python executable
    let base_dir = get_python_base_dir();
    let python_exe = base_dir.join("python_embedded").join("python.exe");

    if !python_exe.exists() {
        return Err(format!("Python executable not found at: {:?}", python_exe));
    }

    // Write PNG to temp file (ole_clipboard.py expects file path)
    let temp_dir = std::env::temp_dir();
    let temp_png = temp_dir.join(format!("easycris_plot_{}.png", uuid::Uuid::new_v4()));

    tokio::fs::write(&temp_png, &png_bytes)
        .await
        .map_err(|e| format!("Failed to write temp PNG: {}", e))?;

    // Invoke Python: python.exe ole_clipboard.py <ecp_path> <png_path>
    let ole_script = base_dir.join("python_embedded").join("ole_clipboard.py");

    let mut child = Command::new(&python_exe)
        // Deferred for later: force image-only clipboard to avoid COM LocalServer startup.
        .env("EASYCRIS_OLE_MODE", "image")
        .arg(ole_script)
        .arg(&ecp_path)
        .arg(&temp_png)
        .current_dir(&base_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Python OLE script: {}", e))?;

    // Capture output
    let stdout_task = {
        let stdout = child.stdout.take();
        tokio::spawn(async move {
            let mut buf = Vec::new();
            if let Some(mut out) = stdout {
                out.read_to_end(&mut buf).await?;
            }
            Ok::<Vec<u8>, std::io::Error>(buf)
        })
    };

    let stderr_task = {
        let stderr = child.stderr.take();
        tokio::spawn(async move {
            let mut buf = Vec::new();
            if let Some(mut err) = stderr {
                err.read_to_end(&mut buf).await?;
            }
            Ok::<Vec<u8>, std::io::Error>(buf)
        })
    };

    // Wait for completion (30 second timeout)
    let status = match timeout(Duration::from_secs(30), child.wait()).await {
        Ok(result) => result.map_err(|e| format!("Python OLE script failed: {}", e))?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_file(&temp_png).await;
            return Err("OLE clipboard operation timed out".to_string());
        }
    };

    let stdout = stdout_task
        .await
        .map_err(|e| format!("Failed to read stdout: {}", e))?
        .map_err(|e| format!("Failed to read stdout: {}", e))?;
    let stderr = stderr_task
        .await
        .map_err(|e| format!("Failed to read stderr: {}", e))?
        .map_err(|e| format!("Failed to read stderr: {}", e))?;

    // Clean up temp file
    let _ = tokio::fs::remove_file(&temp_png).await;

    if status.success() {
        Ok("Plot copied to clipboard (embedded OLE)".to_string())
    } else {
        let error = if !stderr.is_empty() {
            String::from_utf8_lossy(&stderr).to_string()
        } else {
            String::from_utf8_lossy(&stdout).to_string()
        };
        Err(format!("OLE clipboard operation failed: {}", error))
    }
}
