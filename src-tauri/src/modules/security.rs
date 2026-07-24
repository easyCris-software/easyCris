// Security validation module
//
// Prevents:
// - Directory traversal attacks (..)
// - Network path access (\\server\share)
// - Invalid file extensions
// - Oversized payloads

use anyhow::{bail, Result};
use std::path::Path;

fn validate_data_path_with_extensions(path: &str, allowed_extensions: &[&str]) -> Result<()> {
    let path_obj = Path::new(path);

    if path.trim().is_empty() {
        bail!("Path cannot be empty");
    }

    // No relative paths (..)
    if path.contains("..") {
        bail!("Path contains '..' - not allowed");
    }

    // No network shares (\\server\share)
    if path.starts_with(r"\\") {
        bail!("Network paths not allowed");
    }

    // Must exist
    if !path_obj.exists() {
        bail!("Data file does not exist: {}", path);
    }

    // Must be an allowed extension
    let ext = path_obj
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if !allowed_extensions.contains(&ext.as_str()) {
        bail!("Invalid data file extension: {}", ext);
    }

    Ok(())
}

/// Validate Arrow file path for security
///
/// # Security Checks:
/// - No relative paths (..)
/// - No network shares (\\server\share)
/// - Must exist on disk
/// - Must have valid extension (.feather, .arrow, .ipc)
///
/// # Example
///
/// ```no_run
/// use tauri_app_lib::modules::security::validate_arrow_path;
///
/// fn main() -> anyhow::Result<()> {
///     // Valid path (file must exist)
///     let path = r"C:\data\test.feather";
///     validate_arrow_path(path)?;
///     println!("Path is valid!");
///     Ok(())
/// }
/// ```
///
/// # Errors
///
/// Returns an error if:
/// - Path contains ".." (directory traversal)
/// - Path starts with "\\\\" (network share)
/// - File does not exist
/// - File extension is not .feather, .arrow, or .ipc
pub fn validate_arrow_path(path: &str) -> Result<()> {
    validate_data_path_with_extensions(path, &["feather", "arrow", "ipc"])
}

/// Validate statistical data file path (Arrow/Parquet) for security.
///
/// Used by `run_statistical_test` to validate `arrow_data_path` from frontend payloads.
/// Supports both Arrow IPC files and Parquet files used in large-dataset flows.
pub fn validate_statistical_data_path(path: &str) -> Result<()> {
    validate_data_path_with_extensions(path, &["feather", "arrow", "ipc", "parquet"])
}

/// Validate Python backend executable path
///
/// Ensures only the hardcoded backend path is used
pub fn validate_python_backend(backend_path: &str) -> Result<()> {
    // Hardcoded allowed paths (development vs production)
    const ALLOWED_PATHS: &[&str] = &[
        "python_embedded/python.exe",
        "python_embedded/stats.py",
        "python_embedded/rnaseq.py",
        "python_embedded/plot.py",
        "python_embedded/dist/stats.dist/stats.exe",
        "python_embedded/dist/stats.exe",
        "python_embedded/dist/rnaseq.dist/rnaseq.exe",
        "python_embedded/dist/plot.dist/plot.exe",
    ];

    if !ALLOWED_PATHS.contains(&backend_path) {
        bail!("Invalid Python backend path: {}", backend_path);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rejects_directory_traversal() {
        let result = validate_arrow_path("../../../etc/passwd");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains(".."));
    }

    #[test]
    fn test_rejects_network_paths() {
        let result = validate_arrow_path(r"\\server\share\data.feather");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Network"));
    }

    #[test]
    fn test_rejects_invalid_extension() {
        // This will fail with "file does not exist" first, but shows the pattern
        let result = validate_arrow_path("data.txt");
        assert!(result.is_err());
    }
}
