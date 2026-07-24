// Error Handling Module
//
// Structured error envelope for Tauri command boundaries.
// All errors returned to frontend use this standardized format.
//
// Policy:
// - Local diagnostics only (no telemetry)
// - User-safe messages in toast
// - Technical details in local logs only
// - No raw dataset values or PII in any field

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

/// Structured error envelope returned by all Tauri commands
///
/// This envelope provides:
/// - Stable error codes for deterministic UI handling
/// - User-safe messages for toasts
/// - Technical details for local diagnostics
/// - Correlation via traceId
/// - Sanitized context (no PII/dataset values)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppErrorEnvelope {
    /// Stable error code (e.g., STATS_PY_325, RNASEQ_401)
    pub code: String,

    /// User-safe short message (shown in toast)
    pub message: String,

    /// Technical detail for local logs only (not shown to user)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,

    /// Correlation ID for this error instance
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,

    /// Whether user can retry this operation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,

    /// Additional context (sanitized - no PII/dataset values)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<HashMap<String, serde_json::Value>>,
}

impl AppErrorEnvelope {
    /// Create a new error envelope with required fields
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: None,
            trace_id: Some(generate_trace_id()),
            retryable: None,
            context: None,
        }
    }

    /// Set technical detail (for local logs only)
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// Set retryable flag
    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = Some(retryable);
        self
    }

    /// Add sanitized context field
    pub fn with_context(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        if self.context.is_none() {
            self.context = Some(HashMap::new());
        }
        if let Some(context) = &mut self.context {
            context.insert(key.into(), value);
        }
        self
    }

    /// Create from anyhow::Error with code mapping
    pub fn from_anyhow(
        code: impl Into<String>,
        message: impl Into<String>,
        err: &anyhow::Error,
    ) -> Self {
        Self::new(code, message).with_detail(format!("{:#}", err))
    }

    /// Map common error patterns to stable codes
    pub fn from_io_error(err: std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => {
                Self::new("IO_501", "Invalid or inaccessible file path")
                    .with_detail(format!("IO error: {}", err))
                    .with_retryable(true)
            }
            std::io::ErrorKind::PermissionDenied => Self::new("IO_502", "Permission denied")
                .with_detail(format!("IO error: {}", err))
                .with_retryable(false),
            _ => Self::new("IO_504", "Data import failed")
                .with_detail(format!("IO error: {}", err))
                .with_retryable(true),
        }
    }
}

/// Display implementation for AppErrorEnvelope
///
/// Formats as: "<message> (Code: <code>)"
/// This matches the frontend toast format for consistency
impl fmt::Display for AppErrorEnvelope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (Code: {})", self.message, self.code)
    }
}

/// Generate unique trace ID for error correlation
///
/// Format: timestamp(hex)-random(hex)
/// Example: "17d8f5f6b2a-4c7a91de"
fn generate_trace_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let random: u64 = rand::random();

    format!(
        "{:x}-{:x}",
        timestamp,
        random & 0xFFFFFFFF // 32-bit random suffix
    )
}

/// Helper to convert Result<T, AppErrorEnvelope> to Tauri command result
pub type CommandResult<T> = Result<T, AppErrorEnvelope>;

/// Macro for quickly creating error envelopes
#[macro_export]
macro_rules! app_error {
    ($code:expr, $message:expr) => {
        AppErrorEnvelope::new($code, $message)
    };
    ($code:expr, $message:expr, $detail:expr) => {
        AppErrorEnvelope::new($code, $message).with_detail($detail)
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_envelope_creation() {
        let err = AppErrorEnvelope::new("STATS_PY_327", "Analysis backend execution failed");
        assert_eq!(err.code, "STATS_PY_327");
        assert_eq!(err.message, "Analysis backend execution failed");
        assert!(err.trace_id.is_some());
    }

    #[test]
    fn test_error_with_detail() {
        let err = AppErrorEnvelope::new("STATS_PY_327", "Analysis backend execution failed")
            .with_detail("Non-zero exit code: 1");
        assert_eq!(err.detail.as_deref(), Some("Non-zero exit code: 1"));
    }

    #[test]
    fn test_error_with_context() {
        let err = AppErrorEnvelope::new("STATS_PY_327", "Analysis backend execution failed")
            .with_context("test_name", serde_json::json!("t_test"))
            .with_context("exit_code", serde_json::json!(1));

        assert!(err.context.is_some());
        let context = err.context.unwrap();
        assert_eq!(
            context.get("test_name").unwrap(),
            &serde_json::json!("t_test")
        );
        assert_eq!(context.get("exit_code").unwrap(), &serde_json::json!(1));
    }

    #[test]
    fn test_io_error_mapping() {
        let not_found = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let err = AppErrorEnvelope::from_io_error(not_found);
        assert_eq!(err.code, "IO_501");
        assert_eq!(err.retryable, Some(true));

        let permission = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied");
        let err = AppErrorEnvelope::from_io_error(permission);
        assert_eq!(err.code, "IO_502");
        assert_eq!(err.retryable, Some(false));
    }

    #[test]
    fn test_trace_id_format() {
        let id = generate_trace_id();
        assert!(id.contains('-'));
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 2);
    }
}
