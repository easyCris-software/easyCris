use crate::modules::errors::{AppErrorEnvelope, CommandResult};
use crate::modules::python_backend::{
    detect_rnaseq_backend_mode, spawn_rnaseq_backend, BackendMode,
};
use serde_json::{json, Value};
use tauri::command;

const VALID_RNASEQ_TESTS: &[&str] = &[
    "rnaseq_deseq2",
    "rnaseq_annotate",
    "rnaseq_pca",
    "rnaseq_heatmap",
    "rnaseq_validate",
    "rnaseq_validate_samples",
];

fn is_valid_rnaseq_test(test_name: &str) -> bool {
    VALID_RNASEQ_TESTS.contains(&test_name)
}

fn rnaseq_script_fallback_enabled() -> bool {
    std::env::var("EASYCRIS_RNASEQ_SCRIPT_FALLBACK")
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}

/// Run RNA-seq analysis via dedicated backend with progress streaming.
#[command]
pub async fn run_rnaseq_analysis(
    app: tauri::AppHandle,
    test_name: String,
    data: Value,
    parameters: Value,
    arrow_data_path: Option<String>,
) -> CommandResult<Value> {
    if !is_valid_rnaseq_test(test_name.as_str()) {
        return Err(
            AppErrorEnvelope::new("RNASEQ_406", "Unsupported RNA-seq request")
                .with_detail(format!(
                    "Unknown or unsupported RNA-seq test: '{}'. Valid tests are: {}",
                    test_name,
                    VALID_RNASEQ_TESTS.join(", ")
                ))
                .with_retryable(false)
                .with_context("test_name", serde_json::json!(test_name)),
        );
    }

    let payload = json!({
        "test": test_name,
        "data": data,
        "parameters": parameters,
        "arrow_data_path": arrow_data_path
    });

    let mode = detect_rnaseq_backend_mode();
    match spawn_rnaseq_backend(payload.clone(), mode, &app).await {
        Ok(result) => Ok(result),
        Err(primary_error) => {
            let should_try_script_fallback = rnaseq_script_fallback_enabled()
                && matches!(mode, BackendMode::Compiled | BackendMode::CompiledRequired)
                && primary_error.code == "RNASEQ_402";

            if !should_try_script_fallback {
                return Err(primary_error);
            }

            log::warn!(
                "Compiled RNA-seq backend failed (code={}); attempting script fallback",
                primary_error.code
            );

            match spawn_rnaseq_backend(payload, BackendMode::Script, &app).await {
                Ok(result) => Ok(result),
                Err(fallback_error) => {
                    let primary_detail = primary_error
                        .detail
                        .clone()
                        .unwrap_or_else(|| "n/a".to_string());
                    let fallback_error_code = fallback_error.code.clone();
                    let fallback_detail = fallback_error
                        .detail
                        .clone()
                        .unwrap_or_else(|| "n/a".to_string());
                    Err(fallback_error
                    .with_context("fallback_attempted", serde_json::json!(true))
                    .with_context("primary_error_code", serde_json::json!(primary_error.code))
                    .with_context(
                        "fallback_error_code",
                        serde_json::json!(fallback_error_code),
                    )
                    .with_detail(format!(
                        "Compiled RNA-seq backend failed and script fallback failed. Fallback detail: {}. Primary detail: {}",
                        fallback_detail,
                        primary_detail
                    )))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_valid_rnaseq_test;

    #[test]
    fn accepts_supported_rnaseq_tests() {
        assert!(is_valid_rnaseq_test("rnaseq_deseq2"));
        assert!(is_valid_rnaseq_test("rnaseq_validate_samples"));
    }

    #[test]
    fn rejects_unknown_rnaseq_tests() {
        assert!(!is_valid_rnaseq_test("rnaseq_unknown"));
        assert!(!is_valid_rnaseq_test("rnaseq"));
    }
}
