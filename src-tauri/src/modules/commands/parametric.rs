// Parametric test commands
//
// Handles: T-tests, ANOVA, and other parametric statistical tests

use crate::modules::errors::CommandResult;
use crate::modules::python_backend::{detect_backend_mode, spawn_python_backend};
use serde_json::{json, Value};
use tauri::command;

/// Run independent t-test
///
/// # Frontend Example:
/// ```typescript
/// import { invoke } from '@tauri-apps/api/tauri';
///
/// const result = await invoke('run_independent_ttest', {
///   group1: [1.2, 2.3, 3.1],
///   group2: [4.1, 5.2, 4.8],
///   alpha: 0.05,
///   equalVar: true
/// });
/// ```
#[command]
pub async fn run_independent_ttest(
    group1: Vec<f64>,
    group2: Vec<f64>,
    alpha: f64,
    equal_var: bool,
) -> CommandResult<Value> {
    let payload = json!({
        "test": "independent_ttest",
        "data": {
            "group1": group1,
            "group2": group2
        },
        "parameters": {
            "alpha": alpha,
            "equal_var": equal_var
        }
    });

    let mode = detect_backend_mode();
    spawn_python_backend(payload, mode, None).await
}

/// Run paired t-test
#[command]
pub async fn run_paired_ttest(
    group1: Vec<f64>,
    group2: Vec<f64>,
    alpha: f64,
) -> CommandResult<Value> {
    let payload = json!({
        "test": "paired_ttest",
        "data": {
            "group1": group1,
            "group2": group2
        },
        "parameters": {
            "alpha": alpha
        }
    });

    let mode = detect_backend_mode();
    spawn_python_backend(payload, mode, None).await
}

/// Run one-way ANOVA
#[command]
pub async fn run_one_way_anova(groups: Vec<Vec<f64>>, alpha: f64) -> CommandResult<Value> {
    let payload = json!({
        "test": "one_way_anova",
        "data": {
            "groups": groups
        },
        "parameters": {
            "alpha": alpha
        }
    });

    let mode = detect_backend_mode();
    spawn_python_backend(payload, mode, None).await
}

/// Run descriptive statistics (for testing)
#[command]
pub async fn run_descriptive_stats(values: Vec<f64>) -> CommandResult<Value> {
    let payload = json!({
        "test": "descriptive_stats",
        "data": {
            "values": values
        },
        "parameters": {}
    });

    let mode = detect_backend_mode();
    spawn_python_backend(payload, mode, None).await
}
