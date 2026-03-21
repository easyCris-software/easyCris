// Generic Statistical Test Dispatcher - Phase 4 Fix Module 1
//
// Provides a single generic command that routes to all 46 Python statistical tests.
// This avoids creating 46 separate Rust commands while maintaining security
// through test name validation.
//
// Phase 4 Fix: Complete test coverage aligned with _test_validation folders
//
// Supported tests (from python_embedded/stats_backend.py):
// GROUP 1 - Hypothesis Testing (12):
//   Parametric: independent_ttest, paired_ttest, one_sample_ttest, one_way_anova,
//               two_way_anova, multifactorial_anova, lmm_anova
//   Nonparametric: mann_whitney, wilcoxon, kruskal_wallis, friedman, scheirer_ray_hare
//
// GROUP 2 - Pharmacology (9):
//   dose_response_3pl, dose_response_4pl, dose_response_5pl, dose_response_compare,
//   synergy_bliss, synergy_hsa, synergy_loewe, synergy_zip, synergy_all
//
// GROUP 3 - Regression & Correlation (7):
//   linear_regression, multiple_linear_regression, logistic_regression, logistic_multinomial,
//   correlation_pearson, correlation_spearman, correlation_kendall
//
// GROUP 4 - Categorical (4): chi_square, chi_square_gof, fishers_exact, mcnemar
// GROUP 5 - Distribution & Descriptive (8): normality_shapiro, normality_ks, normality_ad, normality_cvm,
//   normality_jb, normality_all, descriptive_stats, outlier_detection
// GROUP 6 - Survival (3): kaplan_meier, cox_regression, nelson_aalen
// GROUP 7 - Mediation & Moderation (3): mediation_model4, moderation_model1, moderated_mediation_model7
//
// NOTE: RNA-seq routes through dedicated `run_rnaseq_analysis` command/backend.

use crate::modules::errors::{AppErrorEnvelope, CommandResult};
use crate::modules::python_backend::{detect_backend_mode, spawn_python_backend};
use crate::modules::security::validate_statistical_data_path;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::command;

/// List of valid test names that Python backend accepts.
/// This serves as a security whitelist - only these tests can be executed.
const VALID_TESTS: &[&str] = &[
    // GROUP 1: Hypothesis Testing (12)
    // Parametric tests (7)
    "independent_ttest",
    "paired_ttest",
    "one_sample_ttest",
    "one_way_anova",
    "two_way_anova",
    "multifactorial_anova",
    "lmm_anova",
    // Nonparametric tests (5)
    "mann_whitney",
    "wilcoxon",
    "kruskal_wallis",
    "friedman",
    "scheirer_ray_hare",
    // GROUP 2: Pharmacology (9)
    "dose_response_3pl",
    "dose_response_4pl",
    "dose_response_5pl",
    "dose_response_compare",
    "synergy_bliss",
    "synergy_hsa",
    "synergy_loewe",
    "synergy_zip",
    "synergy_all",
    // GROUP 3: Regression & Correlation (7)
    "linear_regression",
    "multiple_linear_regression",
    "logistic_regression",
    "logistic_multinomial",
    "correlation_pearson",
    "correlation_spearman",
    "correlation_kendall",
    // GROUP 4: Categorical (4)
    "chi_square",
    "chi_square_gof",
    "fishers_exact",
    "mcnemar",
    // GROUP 5: Distribution & Descriptive (8)
    "normality_shapiro",
    "normality_ks",
    "normality_ad",
    "normality_cvm",
    "normality_jb",
    "normality_all",
    "descriptive_stats",
    "outlier_detection",
    // GROUP 6: Survival Analysis (3)
    "kaplan_meier",
    "cox_regression",
    "nelson_aalen",
    // GROUP 7: Mediation & Moderation (3)
    "mediation_model4",
    "moderation_model1",
    "moderated_mediation_model7",
];

/// Response structure for test information
#[derive(Serialize)]
pub struct TestInfo {
    pub name: &'static str,
    pub family: &'static str,
}

/// Get family for a test name
fn get_test_family(test_name: &str) -> &'static str {
    match test_name {
        // Parametric tests
        "independent_ttest"
        | "paired_ttest"
        | "one_sample_ttest"
        | "one_way_anova"
        | "two_way_anova"
        | "multifactorial_anova"
        | "lmm_anova" => "parametric",

        // Nonparametric tests
        "mann_whitney" | "wilcoxon" | "kruskal_wallis" | "friedman" | "scheirer_ray_hare" => {
            "nonparametric"
        }

        // Regression
        "linear_regression"
        | "multiple_linear_regression"
        | "logistic_regression"
        | "logistic_multinomial" => "regression",

        // Correlation
        "correlation_pearson" | "correlation_spearman" | "correlation_kendall" => "correlation",

        // Categorical
        "chi_square" | "chi_square_gof" | "fishers_exact" | "mcnemar" => "categorical",

        // Distribution
        "normality_shapiro" | "normality_ks" | "normality_ad" | "normality_cvm"
        | "normality_jb" | "normality_all" => "distribution",

        // Descriptive
        "descriptive_stats" | "outlier_detection" => "descriptive",

        // Pharmacology / Drug Combination
        "dose_response_3pl"
        | "dose_response_4pl"
        | "dose_response_5pl"
        | "dose_response_compare"
        | "synergy_bliss"
        | "synergy_hsa"
        | "synergy_loewe"
        | "synergy_zip"
        | "synergy_all" => "pharmacology",

        // Survival Analysis
        "kaplan_meier" | "cox_regression" | "nelson_aalen" => "survival",

        // Mediation & Moderation
        "mediation_model4" | "moderation_model1" | "moderated_mediation_model7" => "mediation",

        _ => "unknown",
    }
}

/// Generic statistical test dispatcher
///
/// Routes test execution to Python backend based on test_name.
/// Validates test_name against whitelist for security.
///
/// # Arguments
/// * `test_name` - Name of the statistical test (must be in VALID_TESTS)
/// * `data` - Data payload (structure depends on test type)
/// * `parameters` - Test parameters (alpha, method, etc.)
/// * `arrow_data_path` - Optional path to Arrow IPC file for large datasets
///
/// # Returns
/// * `Ok(Value)` - JSON result from Python backend
/// * `Err(AppErrorEnvelope)` - Structured error with stable code
///
/// # Error Codes
/// * `STATS_113` - Unsupported test type
/// * `IO_501` - Invalid arrow_data_path
/// * `STATS_PY_325..330`, `STATS_PY_340` - Python backend errors (see python_backend module)
///
/// # Example (frontend)
/// ```typescript
/// const result = await invoke('run_statistical_test', {
///   testName: 'independent_ttest',
///   data: { group1: [1.2, 2.3, 3.1], group2: [4.1, 5.2, 4.8] },
///   parameters: { alpha: 0.05, equal_var: true },
///   arrowDataPath: null
/// });
/// ```
async fn run_statistical_test_impl(
    test_name: String,
    data: Value,
    parameters: Value,
    arrow_data_path: Option<String>,
    app: Option<&tauri::AppHandle>,
) -> CommandResult<Value> {
    // Validate test name against whitelist
    if !VALID_TESTS.contains(&test_name.as_str()) {
        return Err(AppErrorEnvelope::new("STATS_113", "Unsupported test type")
            .with_detail(format!(
                "Unknown or unsupported test: '{}'. Valid tests are: {}",
                test_name,
                VALID_TESTS.join(", ")
            ))
            .with_retryable(false)
            .with_context("test_name", serde_json::json!(test_name)));
    }

    log::info!(
        "Executing statistical test: {} (family: {})",
        test_name,
        get_test_family(&test_name)
    );

    if let Some(path) = arrow_data_path.as_deref() {
        validate_statistical_data_path(path).map_err(|e| {
            AppErrorEnvelope::new("IO_501", "Invalid or inaccessible file path")
                .with_detail(format!("Invalid arrow_data_path: {}", e))
                .with_retryable(true)
        })?;
    }

    // Build payload matching Python stats_backend.py expected format
    let payload = json!({
        "test": test_name,
        "data": data,
        "parameters": parameters,
        "arrow_data_path": arrow_data_path
    });

    // Detect backend mode and execute
    let mode = detect_backend_mode();

    let result = spawn_python_backend(payload, mode, app).await?;

    log::info!("Test {} completed successfully", test_name);
    Ok(result)
}

#[command]
pub async fn run_statistical_test(
    test_name: String,
    data: Value,
    parameters: Value,
    arrow_data_path: Option<String>,
    app: tauri::AppHandle,
) -> CommandResult<Value> {
    run_statistical_test_impl(test_name, data, parameters, arrow_data_path, Some(&app)).await
}

/// Prewarm statistics backend to reduce first-run latency.
///
/// This command is intentionally best-effort and non-blocking on frontend usage.
/// It sends a lightweight warmup payload that can optionally preload selected
/// statistics families (e.g., `["survival"]`).
#[command]
pub async fn prewarm_statistics_backend(families: Option<Vec<String>>) -> CommandResult<Value> {
    let payload = json!({
        "test": "__warmup__",
        "data": {},
        "parameters": {
            "warmup_families": families.unwrap_or_default()
        }
    });
    let mode = detect_backend_mode();
    spawn_python_backend(payload, mode, None).await
}

/// Get list of available statistical tests
///
/// Returns all valid test names with their families.
/// Useful for frontend to know what tests are available.
#[command]
pub async fn get_available_tests() -> Vec<TestInfo> {
    VALID_TESTS
        .iter()
        .map(|&name| TestInfo {
            name,
            family: get_test_family(name),
        })
        .collect()
}

/// Validate if a test name is supported
///
/// # Arguments
/// * `test_name` - Name of the test to validate
///
/// # Returns
/// * `true` if test is valid, `false` otherwise
#[command]
pub async fn is_valid_test(test_name: String) -> bool {
    VALID_TESTS.contains(&test_name.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_tests_contains_expected() {
        assert!(VALID_TESTS.contains(&"independent_ttest"));
        assert!(VALID_TESTS.contains(&"mann_whitney"));
        assert!(VALID_TESTS.contains(&"correlation_pearson"));
        assert!(VALID_TESTS.contains(&"correlation_spearman"));
        assert!(VALID_TESTS.contains(&"correlation_kendall"));
        assert!(VALID_TESTS.contains(&"kaplan_meier"));
        assert!(VALID_TESTS.contains(&"dose_response_4pl"));
        assert!(VALID_TESTS.contains(&"synergy_bliss"));
        assert!(VALID_TESTS.contains(&"moderated_mediation_model7"));
    }

    #[test]
    fn test_invalid_test_rejected() {
        assert!(!VALID_TESTS.contains(&"invalid_test"));
        assert!(!VALID_TESTS.contains(&"sql_injection"));
        assert!(!VALID_TESTS.contains(&""));
    }

    #[test]
    fn test_get_test_family() {
        assert_eq!(get_test_family("independent_ttest"), "parametric");
        assert_eq!(get_test_family("mann_whitney"), "nonparametric");
        assert_eq!(get_test_family("linear_regression"), "regression");
        assert_eq!(get_test_family("correlation_pearson"), "correlation");
        assert_eq!(get_test_family("correlation_spearman"), "correlation");
        assert_eq!(get_test_family("correlation_kendall"), "correlation");
        assert_eq!(get_test_family("chi_square"), "categorical");
        assert_eq!(get_test_family("normality_shapiro"), "distribution");
        assert_eq!(get_test_family("dose_response_4pl"), "pharmacology");
        assert_eq!(get_test_family("synergy_bliss"), "pharmacology");
        assert_eq!(get_test_family("kaplan_meier"), "survival");
        assert_eq!(get_test_family("mediation_model4"), "mediation");
        assert_eq!(get_test_family("moderated_mediation_model7"), "mediation");
        assert_eq!(get_test_family("lmm_anova"), "parametric");
        assert_eq!(get_test_family("unknown_test"), "unknown");
    }

    #[tokio::test]
    async fn test_is_valid_test() {
        assert!(is_valid_test("independent_ttest".to_string()).await);
        assert!(is_valid_test("correlation_pearson".to_string()).await);
        assert!(is_valid_test("synergy_zip".to_string()).await);
        assert!(is_valid_test("lmm_anova".to_string()).await);
        assert!(!is_valid_test("invalid".to_string()).await);
        assert!(!is_valid_test("correlation".to_string()).await); // Old name no longer valid
    }

    #[tokio::test]
    async fn test_get_available_tests_count() {
        let tests = get_available_tests().await;
        // Current validated tests across 7 groups:
        // Hypothesis Testing: 12 (7 parametric + 5 nonparametric)
        // Pharmacology: 9 (4 dose-response + 5 synergy)
        // Regression & Correlation: 7 (4 regression + 3 correlation)
        // Categorical: 4
        // Distribution & Descriptive: 8
        // Survival: 3
        // Mediation & Moderation: 3
        assert_eq!(tests.len(), 46);
    }

    #[tokio::test]
    async fn test_run_statistical_test_invalid_name() {
        let result =
            run_statistical_test_impl("invalid_test".to_string(), json!({}), json!({}), None, None)
                .await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code, "STATS_113");
        assert_eq!(err.message, "Unsupported test type");
        assert!(err
            .detail
            .as_deref()
            .unwrap_or_default()
            .contains("Unknown or unsupported test"));
    }
}
