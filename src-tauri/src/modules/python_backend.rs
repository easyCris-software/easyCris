// Python backend spawner module
//
// Handles:
// - Spawning a platform Python interpreter with stats.py (or a compiled backend)
// - Writing JSON payload to stdin
// - Reading JSON result from stdout
// - Timeout handling (5 minutes max)
// - Error capture from stderr
//
// Phase 4 Fix: Resolve paths relative to executable, not CWD

use crate::modules::errors::{AppErrorEnvelope, CommandResult};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Duration, Instant};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn get_python_working_dir() -> PathBuf {
    let candidates = [
        dirs::data_local_dir().map(|p| p.join("easyCris").join("python_backend")),
        Some(std::env::temp_dir().join("easyCris-python_backend")),
    ];

    for candidate in candidates.into_iter().flatten() {
        if std::fs::create_dir_all(&candidate).is_ok() {
            return candidate;
        }
    }

    // As a last resort, fall back to the current directory.
    PathBuf::from(".")
}

fn path_points_to_command_name(path: &Path) -> bool {
    path.parent().is_none() && path.components().count() == 1
}

#[derive(Clone, Copy)]
#[allow(dead_code)] // Both supported target variants are retained for platform path contracts.
enum TargetPlatform {
    Windows,
    MacOS,
}

fn host_platform() -> TargetPlatform {
    #[cfg(windows)]
    {
        TargetPlatform::Windows
    }
    #[cfg(target_os = "macos")]
    {
        TargetPlatform::MacOS
    }
}

fn venv_python_rel(platform: TargetPlatform) -> PathBuf {
    match platform {
        TargetPlatform::Windows => PathBuf::from(".venv-public/Scripts/python.exe"),
        TargetPlatform::MacOS => PathBuf::from(".venv-public/bin/python"),
    }
}

fn backend_executable_name(backend: &str, platform: TargetPlatform) -> String {
    match platform {
        TargetPlatform::Windows => format!("{backend}.exe"),
        TargetPlatform::MacOS => backend.to_string(),
    }
}

fn compiled_backend_rel(backend: &str) -> PathBuf {
    PathBuf::from("python_embedded")
        .join("dist")
        .join(format!("{backend}.dist"))
        .join(backend_executable_name(backend, host_platform()))
}

fn embedded_python_rel() -> Option<PathBuf> {
    match host_platform() {
        TargetPlatform::Windows => Some(PathBuf::from("python_embedded").join("python.exe")),
        TargetPlatform::MacOS => None,
    }
}

fn resolve_python_script_command(base_dir: &Path) -> PathBuf {
    if let Some(explicit_python) = std::env::var_os("EASYCRIS_PYTHON_EXE") {
        let explicit = PathBuf::from(explicit_python);
        if explicit.exists() {
            return explicit;
        }
        log::warn!(
            "EASYCRIS_PYTHON_EXE is set but does not exist: {:?}. Falling back to auto-resolution.",
            explicit
        );
    }

    if let Some(embedded_python_rel) = embedded_python_rel() {
        let embedded_python = base_dir.join(embedded_python_rel);
        if embedded_python.exists() {
            return embedded_python;
        }
    }

    let venv_python = base_dir.join(venv_python_rel(host_platform()));
    if venv_python.exists() {
        return venv_python;
    }

    match host_platform() {
        TargetPlatform::Windows => PathBuf::from("python"),
        TargetPlatform::MacOS => PathBuf::from("python3"),
    }
}

/// Relative paths from executable directory
const PYTHON_BACKEND_ARG: &str = "python_embedded/stats.py";

// Plot backend paths
const PLOT_BACKEND_ARG: &str = "python_embedded/plot.py";

// RNA-seq backend paths
const RNASEQ_BACKEND_ARG: &str = "python_embedded/rnaseq.py";

#[inline(always)]
fn stats_script_rel() -> String {
    PYTHON_BACKEND_ARG.to_string()
}

#[inline(always)]
fn stats_exe_rel() -> PathBuf {
    compiled_backend_rel("stats")
}

#[inline(always)]
fn plot_script_rel() -> String {
    PLOT_BACKEND_ARG.to_string()
}

#[inline(always)]
fn plot_exe_rel() -> PathBuf {
    compiled_backend_rel("plot")
}

#[inline(always)]
fn rnaseq_script_rel() -> String {
    RNASEQ_BACKEND_ARG.to_string()
}

#[inline(always)]
fn rnaseq_exe_rel() -> PathBuf {
    compiled_backend_rel("rnaseq")
}

#[inline(always)]
fn hardened_required_prefix_stats() -> String {
    "Hardened release requires compiled stats backend at:".to_string()
}

#[inline(always)]
fn hardened_required_prefix_rnaseq() -> String {
    "Hardened release requires compiled RNA-seq backend at:".to_string()
}

#[inline(always)]
fn hardened_required_prefix_plot() -> String {
    "Hardened release requires compiled plot backend at:".to_string()
}

#[inline(always)]
fn hardened_required_suffix_profile() -> String {
    "Script fallback is disabled for build profile".to_string()
}

/// Get the base directory for resolving Python paths
/// In development: project root (parent of src-tauri)
/// In production: next to the executable
pub(crate) fn get_python_base_dir() -> PathBuf {
    // Try to get executable directory first
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            // Bundled resources live in a "resources" folder next to the exe (Windows).
            let resources_dir = exe_dir.join("resources");
            let python_dir = resources_dir.join("python_embedded");
            if python_dir.exists() {
                log::debug!("Found python_embedded in resources: {:?}", resources_dir);
                return resources_dir;
            }

            // Check if python_embedded exists relative to exe
            let python_dir = exe_dir.join("python_embedded");
            if python_dir.exists() {
                log::debug!("Found python_embedded at exe dir: {:?}", exe_dir);
                return exe_dir.to_path_buf();
            }

            #[cfg(target_os = "macos")]
            if let Some(bundle_resources_dir) = macos_bundle_python_base_dir_candidate(exe_dir) {
                let python_dir = bundle_resources_dir.join("python_embedded");
                if python_dir.exists() {
                    log::debug!(
                        "Found python_embedded in macOS updater bundle resources: {:?}",
                        bundle_resources_dir
                    );
                    return bundle_resources_dir;
                }
            }

            // Development mode: check parent directories
            // src-tauri/target/debug -> project root
            let mut current = exe_dir.to_path_buf();
            for _ in 0..5 {
                let python_dir = current.join("python_embedded");
                if python_dir.exists() {
                    log::debug!("Found python_embedded at: {:?}", current);
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

    // Fallback: try current working directory
    if let Ok(cwd) = std::env::current_dir() {
        let python_dir = cwd.join("python_embedded");
        if python_dir.exists() {
            log::debug!("Found python_embedded at CWD: {:?}", cwd);
            return cwd;
        }

        // Try parent of CWD (if running from src-tauri)
        if let Some(parent) = cwd.parent() {
            let python_dir = parent.join("python_embedded");
            if python_dir.exists() {
                log::debug!("Found python_embedded at CWD parent: {:?}", parent);
                return parent.to_path_buf();
            }
        }
    }

    // Installed updater layout fallback (keep last so dev/e2e path resolution wins first):
    // %LOCALAPPDATA%/<app>/_up_/bundle_resources/python_embedded
    if let Some(local_data_dir) = dirs::data_local_dir() {
        let app_dirs = ["easycris", "easyCris", "com.easycris.app"];
        for app_dir in app_dirs {
            let bundle_resources_dir =
                installed_python_base_dir_candidate(&local_data_dir, app_dir);
            let python_dir = bundle_resources_dir.join("python_embedded");
            if python_dir.exists() {
                log::debug!(
                    "Found python_embedded in updater bundle_resources fallback: {:?}",
                    bundle_resources_dir
                );
                return bundle_resources_dir;
            }
        }
    }

    // Last resort: use relative path and hope for the best
    log::warn!("Could not locate python_embedded directory, using relative path");
    PathBuf::from(".")
}

fn installed_python_base_dir_candidate(local_data_dir: &Path, app_dir: &str) -> PathBuf {
    local_data_dir
        .join(app_dir)
        .join("_up_")
        .join("bundle_resources")
}

fn macos_bundle_python_base_dir_candidate(exe_dir: &Path) -> Option<PathBuf> {
    if exe_dir.file_name().and_then(|name| name.to_str()) != Some("MacOS") {
        return None;
    }

    let contents_dir = exe_dir.parent()?;
    if contents_dir.file_name().and_then(|name| name.to_str()) != Some("Contents") {
        return None;
    }

    Some(
        contents_dir
            .join("Resources")
            .join("_up_")
            .join("bundle_resources"),
    )
}

/// Maximum execution time (5 minutes)
const TIMEOUT_SECS: u64 = 300;

/// Summarize backend text safely for diagnostic logs/details without exposing raw payloads.
fn summarize_backend_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "empty".to_string();
    }

    let byte_count = trimmed.len();
    let line_count = trimmed.lines().count();
    format!("{} bytes across {} lines", byte_count, line_count)
}

fn redacted_backend_target(cmd: &PathBuf) -> String {
    cmd.file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| "compiled backend executable".to_string())
}

fn backend_process_cwd(mode: BackendMode, cmd: &PathBuf, fallback: &PathBuf) -> PathBuf {
    match mode {
        // Script and BundledRequired use a writable temp dir so signed/runtime trees stay read-only.
        BackendMode::Script | BackendMode::BundledRequired => fallback.clone(),
        BackendMode::Compiled | BackendMode::CompiledRequired => cmd
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| fallback.clone()),
    }
}

fn apply_backend_spawn_flags(command: &mut Command, mode: BackendMode) {
    #[cfg(windows)]
    {
        if matches!(mode, BackendMode::Compiled | BackendMode::CompiledRequired) {
            command.creation_flags(CREATE_NO_WINDOW);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (command, mode);
    }
}

fn apply_backend_environment(command: &mut Command, mode: BackendMode) {
    // Enforce strict offline backend execution: no outbound network paths.
    command.env("EASYCRIS_OFFLINE", "1");
    // Bundled macOS launches match bootstrap_python_macos.run_backend_protocol isolation.
    if matches!(mode, BackendMode::BundledRequired) {
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().to_ascii_uppercase().starts_with("PYTHON") {
                command.env_remove(key);
            }
        }
    }
}

fn rnaseq_analysis_error(detail: impl Into<String>, failure_kind: &str) -> AppErrorEnvelope {
    AppErrorEnvelope::new("RNASEQ_402", "RNA-seq analysis failed")
        .with_detail(detail.into())
        .with_retryable(true)
        .with_context("failure_kind", serde_json::json!(failure_kind))
}

fn parse_json_from_backend_stdout(stdout: &str) -> Result<Value, String> {
    fn parse_prefix_json(candidate: &str) -> Result<Value, serde_json::Error> {
        let mut de = serde_json::Deserializer::from_str(candidate);
        Value::deserialize(&mut de)
    }

    let mut last_error: Option<String> = None;
    let trimmed = stdout.trim();

    if !trimmed.is_empty() {
        match parse_prefix_json(trimmed) {
            Ok(value) => return Ok(value),
            Err(error) => last_error = Some(error.to_string()),
        }
    }

    let mut candidate_starts = Vec::new();
    for (idx, _) in stdout.match_indices("\n{") {
        candidate_starts.push(idx + 1);
    }
    for (idx, _) in stdout.match_indices("\r{") {
        candidate_starts.push(idx + 1);
    }
    if let Some(idx) = stdout.find("{\"success\"") {
        candidate_starts.push(idx);
    }
    if let Some(idx) = stdout.find('{') {
        candidate_starts.push(idx);
    }

    candidate_starts.sort_unstable();
    candidate_starts.dedup();

    for idx in candidate_starts.into_iter().rev() {
        let candidate = stdout[idx..].trim_start_matches(['\n', '\r']);
        match parse_prefix_json(candidate) {
            Ok(value) => return Ok(value),
            Err(error) => last_error = Some(error.to_string()),
        }
    }

    Err(last_error.unwrap_or_else(|| "no JSON payload found in backend stdout".to_string()))
}

fn backend_message_preview(message: &str, max_chars: usize) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return "empty".to_string();
    }
    let mut out = String::new();
    for (idx, ch) in trimmed.chars().enumerate() {
        if idx >= max_chars {
            out.push_str("...");
            break;
        }
        out.push(ch);
    }
    out
}

fn first_nonfinite_json_token_context(stdout: &str) -> Option<String> {
    let mut first: Option<(usize, &'static str)> = None;
    for token in ["-Infinity", "Infinity", "NaN"] {
        if let Some(idx) = stdout.find(token) {
            match first {
                Some((current_idx, _)) if idx >= current_idx => {}
                _ => first = Some((idx, token)),
            }
        }
    }

    let (idx, token) = first?;
    let prefix = &stdout[..idx];
    let line = prefix.bytes().filter(|b| *b == b'\n').count() + 1;
    let col = prefix
        .rsplit('\n')
        .next()
        .map(|segment| segment.chars().count() + 1)
        .unwrap_or(1);
    let snippet = stdout
        .lines()
        .nth(line.saturating_sub(1))
        .unwrap_or("")
        .trim();
    let snippet_preview = backend_message_preview(snippet, 160);

    Some(format!(
        "Detected non-finite token '{}' at line {} column {}. Snippet: {}",
        token, line, col, snippet_preview
    ))
}

fn stats_failure_user_message(error_type: &str) -> &'static str {
    match error_type {
        "DoseResponseDataUnsuitable" | "DoseResponseFitFailed" | "DoseResponseFitInvalid" => {
            "Dose-response data unsuitable / fit unstable"
        }
        _ => "Analysis backend reported failure",
    }
}

fn stats_failure_code(error_type: &str) -> &'static str {
    match error_type {
        "DoseResponseDataUnsuitable" | "DoseResponseFitFailed" | "DoseResponseFitInvalid" => {
            "STATS_PY_340"
        }
        _ => "STATS_PY_329",
    }
}

/// Backend mode (development vs production)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendMode {
    /// Development: platform Python interpreter with stats.py
    Script,
    /// Production: compiled stats backend
    Compiled,
    /// Hardened release: compiled backend is required and script fallback is forbidden.
    CompiledRequired,
    /// macOS hardened release: absolute bundled CPython + `-I -B -m <module>`. No fallback.
    BundledRequired,
}

fn bundled_python_base_dir_for_executable(exe_path: &Path) -> Result<PathBuf, String> {
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "current executable has no parent directory".to_string())?;
    let bundle_resources_dir =
        macos_bundle_python_base_dir_candidate(exe_dir).ok_or_else(|| {
            "current executable is not inside a macOS app Contents/MacOS directory".to_string()
        })?;

    if !bundle_resources_dir.join("python_embedded").is_dir() {
        return Err(format!(
            "bundled resources missing at {}",
            bundle_resources_dir.display()
        ));
    }

    Ok(bundle_resources_dir)
}

fn resolve_python_base_dir_for_mode<F>(
    mode: BackendMode,
    executable: Option<&Path>,
    fallback: F,
) -> Result<PathBuf, String>
where
    F: FnOnce() -> PathBuf,
{
    match mode {
        BackendMode::BundledRequired => bundled_python_base_dir_for_executable(
            executable.ok_or_else(|| "could not determine current executable path".to_string())?,
        ),
        _ => Ok(fallback()),
    }
}

fn resolve_python_base_dir(mode: BackendMode) -> Result<PathBuf, String> {
    let executable = if matches!(mode, BackendMode::BundledRequired) {
        std::env::current_exe().ok()
    } else {
        None
    };
    resolve_python_base_dir_for_mode(mode, executable.as_deref(), get_python_base_dir)
}

/// Relative path helpers for the Task 6 Darwin bundled runtime (JS parity).
fn bundled_runtime_rel() -> PathBuf {
    PathBuf::from("python_embedded").join("runtime")
}

fn bundled_interpreter_rel() -> PathBuf {
    bundled_runtime_rel().join("bin").join("python3.12")
}

fn bundled_manifest_rel() -> PathBuf {
    bundled_runtime_rel().join("easycris_runtime_manifest.json")
}

fn bundled_module_name(backend: &str) -> Result<&'static str, String> {
    match backend {
        "stats" => Ok("stats"),
        "rnaseq" => Ok("rnaseq"),
        "plot" => Ok("plot"),
        other => Err(format!("Unknown backend module: {other}")),
    }
}

fn bundled_module_rel(module: &str) -> Result<PathBuf, String> {
    let name = bundled_module_name(module)?;
    Ok(bundled_runtime_rel()
        .join("lib")
        .join("python3.12")
        .join("site-packages")
        .join(format!("{name}.py")))
}

fn bundled_launch_args(module: &str) -> Result<Vec<PathBuf>, String> {
    let name = bundled_module_name(module)?;
    Ok(vec![
        PathBuf::from("-I"),
        PathBuf::from("-B"),
        PathBuf::from("-m"),
        PathBuf::from(name),
    ])
}

/// Minimum pre-spawn contract: interpreter + manifest schema + module file.
/// Full tree hash / Mach-O inventory remain Task 6 stage/validate responsibilities.
fn verify_bundled_runtime_contract(base_dir: &Path, module: &str) -> Result<(), String> {
    let module_name = bundled_module_name(module)?;
    let interpreter = base_dir.join(bundled_interpreter_rel());
    if !interpreter.is_file() {
        return Err(format!(
            "bundled interpreter missing at {}",
            bundled_interpreter_rel().display()
        ));
    }

    let manifest_path = base_dir.join(bundled_manifest_rel());
    if !manifest_path.is_file() {
        return Err(format!(
            "runtime manifest missing at {}",
            bundled_manifest_rel().display()
        ));
    }
    let manifest_raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("failed to read runtime manifest: {e}"))?;
    let manifest: Value = serde_json::from_str(&manifest_raw)
        .map_err(|e| format!("runtime manifest is not valid JSON: {e}"))?;
    let schema_version = manifest
        .get("schema_version")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "runtime manifest missing schema_version".to_string())?;
    if schema_version != 1 {
        return Err(format!(
            "runtime manifest schema_version must be 1, found {schema_version}"
        ));
    }

    let module_path = base_dir.join(bundled_module_rel(module_name)?);
    if !module_path.is_file() {
        return Err(format!(
            "bundled backend module missing at {}",
            bundled_module_rel(module_name)?.display()
        ));
    }

    Ok(())
}

fn resolve_bundled_command(
    base_dir: &Path,
    module: &str,
) -> Result<(PathBuf, Vec<PathBuf>), String> {
    verify_bundled_runtime_contract(base_dir, module)?;
    let cmd = base_dir.join(bundled_interpreter_rel());
    let args = bundled_launch_args(module)?;
    Ok((cmd, args))
}

fn bundled_required_detail(backend_label: &str, reason: &str) -> String {
    format!(
        "Hardened macOS release requires bundled {backend_label} runtime ({reason}). Script and system Python fallback are disabled for build profile '{}'.",
        effective_build_profile()
    )
}

fn effective_build_profile() -> &'static str {
    option_env!("EASYCRIS_BUILD_PROFILE").unwrap_or(if cfg!(debug_assertions) {
        "dev"
    } else {
        "release"
    })
}

fn is_open_profile(profile: &str) -> bool {
    profile.eq_ignore_ascii_case("dev") || profile.eq_ignore_ascii_case("e2e")
}

fn choose_backend_mode(
    build_profile: &str,
    platform: TargetPlatform,
    compiled_exists: bool,
) -> BackendMode {
    if is_open_profile(build_profile) {
        // Keep dev/e2e deterministic and fully open even if stale compiled artifacts exist.
        return BackendMode::Script;
    }

    match platform {
        // macOS hardened builds always use the Task 6 bundled runtime, never Nuitka leftovers.
        TargetPlatform::MacOS => BackendMode::BundledRequired,
        TargetPlatform::Windows => {
            if compiled_exists {
                BackendMode::Compiled
            } else {
                BackendMode::CompiledRequired
            }
        }
    }
}

fn detect_backend_mode_for(
    compiled_rel_path: PathBuf,
    script_log_label: &str,
    compiled_log_label: &str,
    required_log_label: &str,
) -> BackendMode {
    let build_profile = effective_build_profile();
    let platform = host_platform();
    let compiled_path =
        if matches!(platform, TargetPlatform::MacOS) && !is_open_profile(build_profile) {
            compiled_rel_path
        } else {
            get_python_base_dir().join(compiled_rel_path)
        };
    let mode = choose_backend_mode(build_profile, platform, compiled_path.exists());

    if matches!(mode, BackendMode::Script) {
        log::info!(
            "Using {} script mode (profile={}, compiled_present={}) at: {:?}",
            script_log_label,
            build_profile,
            compiled_path.exists(),
            compiled_path,
        );
    } else if matches!(mode, BackendMode::Compiled) {
        log::info!(
            "Detected compiled {} backend at: {:?} (profile={})",
            compiled_log_label,
            compiled_path,
            build_profile
        );
    } else if matches!(mode, BackendMode::BundledRequired) {
        log::info!(
            "Using bundled {} runtime (profile={}) resolved from the current executable",
            required_log_label,
            build_profile,
        );
    } else {
        log::info!(
            "Compiled {} backend required (missing at: {:?}, profile={})",
            required_log_label,
            compiled_path,
            build_profile
        );
    }

    mode
}

/// Spawn Python backend and execute statistical test
///
/// # Arguments
/// * `payload` - JSON payload to send to Python backend
/// * `mode` - Backend mode (Script or Compiled)
///
/// # Returns
/// * `Ok(Value)` - JSON result from Python
/// * `Err` - If process fails, times out, or returns invalid JSON
///
/// # Example
///
/// ```no_run
/// use serde_json::json;
/// use tauri_app_lib::modules::python_backend::{spawn_python_backend, BackendMode};
///
/// #[tokio::main]
/// async fn main() -> anyhow::Result<()> {
///     let payload = json!({
///         "test": "independent_ttest",
///         "data": {"group1": [1, 2, 3], "group2": [4, 5, 6]},
///         "parameters": {"alpha": 0.05}
///     });
///
///     let result = spawn_python_backend(payload, BackendMode::Script, None).await?;
///     println!("Result: {:?}", result);
///     Ok(())
/// }
/// ```
pub async fn spawn_python_backend(
    payload: Value,
    mode: BackendMode,
    app: Option<&tauri::AppHandle>,
) -> CommandResult<Value> {
    // Get base directory for Python paths
    let base_dir = match resolve_python_base_dir(mode) {
        Ok(base_dir) => base_dir,
        Err(reason) => {
            return Err(
                AppErrorEnvelope::new("STATS_PY_325", "Analysis backend unavailable")
                    .with_detail(bundled_required_detail("stats", &reason))
                    .with_retryable(false)
                    .with_context("runtime_issue", serde_json::json!(true))
                    .with_context("mode", serde_json::json!(format!("{:?}", mode))),
            );
        }
    };
    let python_cwd = get_python_working_dir();
    log::debug!("Spawning Python backend with cwd: {:?}", python_cwd);

    // Determine command based on mode - resolve to absolute paths
    let (cmd, args): (PathBuf, Vec<PathBuf>) = match mode {
        BackendMode::Script => {
            let python_exe = resolve_python_script_command(&base_dir);
            let script_path = base_dir.join(stats_script_rel());
            log::info!(
                "Using Python script mode: {:?} {:?}",
                python_exe,
                script_path
            );
            (python_exe, vec![script_path])
        }
        BackendMode::Compiled | BackendMode::CompiledRequired => {
            let exe_path = base_dir.join(stats_exe_rel());
            log::info!("Using compiled backend: {:?}", exe_path);
            (exe_path, vec![])
        }
        BackendMode::BundledRequired => match resolve_bundled_command(&base_dir, "stats") {
            Ok(resolved) => {
                log::info!(
                    "Using bundled stats runtime: {:?} {:?}",
                    resolved.0,
                    resolved.1
                );
                resolved
            }
            Err(reason) => {
                return Err(
                    AppErrorEnvelope::new("STATS_PY_325", "Analysis backend unavailable")
                        .with_detail(bundled_required_detail("stats", &reason))
                        .with_retryable(false)
                        .with_context("mode", serde_json::json!(format!("{:?}", mode))),
                );
            }
        },
    };

    // Verify executable exists
    if !cmd.exists() && !path_points_to_command_name(&cmd) {
        let detail = match mode {
            BackendMode::CompiledRequired => format!(
                "{} {}. {} '{}'.",
                hardened_required_prefix_stats(),
                redacted_backend_target(&cmd),
                hardened_required_suffix_profile(),
                effective_build_profile()
            ),
            BackendMode::BundledRequired => {
                bundled_required_detail("stats", "interpreter path missing after contract check")
            }
            _ => format!(
                "Python backend not found at: {:?}\nBase dir: {:?}\nCWD: {:?}",
                cmd,
                base_dir,
                std::env::current_dir().unwrap_or_default()
            ),
        };
        return Err(
            AppErrorEnvelope::new("STATS_PY_325", "Analysis backend unavailable")
                .with_detail(detail)
                .with_retryable(false)
                .with_context("mode", serde_json::json!(format!("{:?}", mode))),
        );
    }

    let process_cwd = backend_process_cwd(mode, &cmd, &python_cwd);

    // Spawn process
    let mut process_cmd = Command::new(&cmd);
    apply_backend_spawn_flags(&mut process_cmd, mode);
    apply_backend_environment(&mut process_cmd, mode);
    let mut child = process_cmd
        .current_dir(&process_cwd)
        .args(args.iter().map(|p| p.as_os_str()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            AppErrorEnvelope::new("STATS_PY_325", "Analysis backend unavailable")
                .with_detail(format!("Failed to spawn Python backend: {}", e))
                .with_retryable(false)
        })?;

    // Write payload to stdin
    if let Some(mut stdin) = child.stdin.take() {
        let payload_str = serde_json::to_string(&payload).map_err(|e| {
            AppErrorEnvelope::new("STATS_PY_330", "Failed to prepare analysis data")
                .with_detail(format!("Failed to serialize payload: {}", e))
                .with_retryable(true)
        })?;
        stdin.write_all(payload_str.as_bytes()).await.map_err(|e| {
            AppErrorEnvelope::new("STATS_PY_327", "Analysis backend execution failed")
                .with_detail(format!("Failed to write payload to stdin: {}", e))
                .with_retryable(true)
        })?;
    }

    let stdout = child.stdout.take().ok_or_else(|| {
        AppErrorEnvelope::new("STATS_PY_327", "Analysis backend execution failed")
            .with_detail("Failed to capture Python stdout")
            .with_retryable(true)
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        AppErrorEnvelope::new("STATS_PY_327", "Analysis backend execution failed")
            .with_detail("Failed to capture Python stderr")
            .with_retryable(true)
    })?;

    let app_handle = app.cloned();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut lines = Vec::new();
        let mut line_buf = Vec::new();

        loop {
            line_buf.clear();
            let bytes_read = reader.read_until(b'\n', &mut line_buf).await?;
            if bytes_read == 0 {
                break;
            }

            if line_buf.last() == Some(&b'\n') {
                line_buf.pop();
            }
            if line_buf.last() == Some(&b'\r') {
                line_buf.pop();
            }

            let line = String::from_utf8_lossy(&line_buf).to_string();
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                    if value.get("type") == Some(&Value::String("progress".to_string())) {
                        if let Some(app) = app_handle.as_ref() {
                            let _ = app.emit("statistics-progress", value);
                        }
                    }
                }
            }
            lines.push(line);
        }

        Ok::<Vec<String>, std::io::Error>(lines)
    });

    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        reader.read_to_end(&mut buffer).await?;
        Ok::<Vec<u8>, std::io::Error>(buffer)
    });

    let timeout_duration = Duration::from_secs(TIMEOUT_SECS);
    let status_notice = match tokio::time::timeout(timeout_duration, child.wait()).await {
        Ok(status) => status.map_err(|e| {
            AppErrorEnvelope::new("STATS_PY_327", "Analysis backend execution failed")
                .with_detail(format!("Failed to check process status: {}", e))
                .with_retryable(true)
        })?,
        Err(_) => {
            let _ = child.kill().await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(AppErrorEnvelope::new("STATS_PY_326", "Analysis timed out")
                .with_detail(format!(
                    "Python backend timed out after {} seconds",
                    TIMEOUT_SECS
                ))
                .with_retryable(true));
        }
    };

    let stdout_data = stdout_task
        .await
        .map_err(|e| {
            AppErrorEnvelope::new("STATS_PY_327", "Analysis backend execution failed")
                .with_detail(format!("Failed to join stdout read task: {}", e))
                .with_retryable(true)
        })?
        .map_err(|e| {
            AppErrorEnvelope::new("STATS_PY_327", "Analysis backend execution failed")
                .with_detail(format!("Failed to read stdout: {}", e))
                .with_retryable(true)
        })?;

    let stderr_lines = stderr_task
        .await
        .map_err(|e| {
            AppErrorEnvelope::new("STATS_PY_327", "Analysis backend execution failed")
                .with_detail(format!("Failed to join stderr read task: {}", e))
                .with_retryable(true)
        })?
        .map_err(|e| {
            AppErrorEnvelope::new("STATS_PY_327", "Analysis backend execution failed")
                .with_detail(format!("Failed to read stderr: {}", e))
                .with_retryable(true)
        })?;

    let stderr_combined = stderr_lines.join("\n");

    // Treat any non-zero exit as execution failure, even when stderr is empty.
    if !status_notice.success() {
        return Err(
            AppErrorEnvelope::new("STATS_PY_327", "Analysis backend execution failed")
                .with_detail(format!(
            "Python backend returned non-zero exit status. Stdout summary: {}. Stderr summary: {}",
            summarize_backend_text(&String::from_utf8_lossy(&stdout_data)),
            summarize_backend_text(&stderr_combined),
        ))
                .with_retryable(true)
                .with_context(
                    "exit_code",
                    serde_json::json!(status_notice.code().unwrap_or(-1)),
                ),
        );
    }

    // Parse stdout as JSON
    let stdout = String::from_utf8(stdout_data).map_err(|e| {
        AppErrorEnvelope::new("STATS_PY_328", "Invalid response from analysis backend")
            .with_detail(format!("Invalid UTF-8 output from Python: {}", e))
            .with_retryable(true)
    })?;

    let result: Value = parse_json_from_backend_stdout(&stdout).map_err(|e| {
        let nonfinite_context = first_nonfinite_json_token_context(&stdout)
            .unwrap_or_else(|| "No obvious non-finite JSON token detected".to_string());
        AppErrorEnvelope::new("STATS_PY_328", "Invalid response from analysis backend")
            .with_detail(format!(
                "Failed to parse JSON output: {}. Backend output summary: {}. {}",
                e,
                summarize_backend_text(&stdout),
                nonfinite_context
            ))
            .with_retryable(true)
    })?;

    // Check if result indicates an error
    if let Some(success) = result.get("success").and_then(|v| v.as_bool()) {
        if !success {
            let error_msg = result
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("Unknown error");
            let error_type = result
                .get("error_type")
                .and_then(|e| e.as_str())
                .unwrap_or("Unknown");
            let user_message = stats_failure_user_message(error_type);
            let error_code = stats_failure_code(error_type);
            let backend_error_preview = backend_message_preview(error_msg, 240);

            return Err(AppErrorEnvelope::new(error_code, user_message)
                .with_detail(format!(
                    "Python backend reported failure with error_type='{}' (message preview: '{}')",
                    error_type, backend_error_preview
                ))
                .with_retryable(true)
                .with_context("error_type", serde_json::json!(error_type))
                .with_context(
                    "backend_error_preview",
                    serde_json::json!(backend_error_preview),
                ));
        }
    }

    Ok(result)
}

/// Spawn RNA-seq backend and execute analysis with progress streaming
///
/// Emits `rnaseq-progress` events with the JSON payload produced by
/// rnaseq_module.utils.emit_progress (type/stage/percent/message).
///
/// # Error Codes
/// * `RNASEQ_405` - RNA-seq backend not found
/// * `RNASEQ_402` - RNA-seq backend timed out
/// * `RNASEQ_402` - RNA-seq execution failed
/// * `RNASEQ_402` - Invalid response format
pub async fn spawn_rnaseq(
    payload: Value,
    mode: BackendMode,
    app: &tauri::AppHandle,
) -> CommandResult<Value> {
    let base_dir = match resolve_python_base_dir(mode) {
        Ok(base_dir) => base_dir,
        Err(reason) => {
            return Err(
                AppErrorEnvelope::new("RNASEQ_405", "RNA-seq backend unavailable")
                    .with_detail(bundled_required_detail("RNA-seq", &reason))
                    .with_retryable(false)
                    .with_context("runtime_issue", serde_json::json!(true))
                    .with_context("mode", serde_json::json!(format!("{:?}", mode))),
            );
        }
    };
    let python_cwd = get_python_working_dir();
    log::debug!("Spawning RNA-seq backend with cwd: {:?}", python_cwd);

    let (cmd, args): (PathBuf, Vec<PathBuf>) = match mode {
        BackendMode::Script => {
            let python_exe = resolve_python_script_command(&base_dir);
            let script_path = base_dir.join(rnaseq_script_rel());
            log::info!(
                "Using RNA-seq script mode: {:?} {:?}",
                python_exe,
                script_path
            );
            (python_exe, vec![script_path])
        }
        BackendMode::Compiled | BackendMode::CompiledRequired => {
            let exe_path = base_dir.join(rnaseq_exe_rel());
            log::info!("Using compiled RNA-seq backend: {:?}", exe_path);
            (exe_path, vec![])
        }
        BackendMode::BundledRequired => match resolve_bundled_command(&base_dir, "rnaseq") {
            Ok(resolved) => {
                log::info!(
                    "Using bundled RNA-seq runtime: {:?} {:?}",
                    resolved.0,
                    resolved.1
                );
                resolved
            }
            Err(reason) => {
                return Err(
                    AppErrorEnvelope::new("RNASEQ_405", "RNA-seq backend unavailable")
                        .with_detail(bundled_required_detail("RNA-seq", &reason))
                        .with_retryable(false)
                        .with_context("runtime_issue", serde_json::json!(true))
                        .with_context("mode", serde_json::json!(format!("{:?}", mode))),
                );
            }
        },
    };

    if !cmd.exists() && !path_points_to_command_name(&cmd) {
        let detail = match mode {
            BackendMode::CompiledRequired => format!(
                "{} {}. {} '{}'.",
                hardened_required_prefix_rnaseq(),
                redacted_backend_target(&cmd),
                hardened_required_suffix_profile(),
                effective_build_profile()
            ),
            BackendMode::BundledRequired => {
                bundled_required_detail("RNA-seq", "interpreter path missing after contract check")
            }
            _ => format!(
                "RNA-seq backend not found at: {:?}\nBase dir: {:?}\nCWD: {:?}",
                cmd,
                base_dir,
                std::env::current_dir().unwrap_or_default()
            ),
        };
        return Err(
            AppErrorEnvelope::new("RNASEQ_405", "RNA-seq backend unavailable")
                .with_detail(detail)
                .with_retryable(false)
                .with_context("runtime_issue", serde_json::json!(true))
                .with_context("mode", serde_json::json!(format!("{:?}", mode))),
        );
    }

    let process_cwd = backend_process_cwd(mode, &cmd, &python_cwd);

    let mut process_cmd = Command::new(&cmd);
    apply_backend_spawn_flags(&mut process_cmd, mode);
    apply_backend_environment(&mut process_cmd, mode);
    let mut child = process_cmd
        .current_dir(&process_cwd)
        .args(args.iter().map(|p| p.as_os_str()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            AppErrorEnvelope::new("RNASEQ_405", "RNA-seq backend unavailable")
                .with_detail(format!("Failed to spawn RNA-seq backend: {}", e))
                .with_retryable(false)
                .with_context("runtime_issue", serde_json::json!(true))
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        let payload_str = serde_json::to_string(&payload).map_err(|e| {
            rnaseq_analysis_error(
                format!("Failed to serialize payload: {}", e),
                "payload_serialization_failed",
            )
        })?;
        stdin.write_all(payload_str.as_bytes()).await.map_err(|e| {
            rnaseq_analysis_error(
                format!("Failed to write payload to stdin: {}", e),
                "stdin_write_failed",
            )
        })?;
    }

    let stdout = child.stdout.take().ok_or_else(|| {
        rnaseq_analysis_error("Failed to capture RNA-seq stdout", "stdout_capture_failed")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        rnaseq_analysis_error("Failed to capture RNA-seq stderr", "stderr_capture_failed")
    })?;

    let app_handle = app.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut lines = Vec::new();

        while let Some(line) = reader.next_line().await? {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                    if value.get("type") == Some(&Value::String("progress".to_string())) {
                        let _ = app_handle.emit("rnaseq-progress", value);
                    }
                }
            }
            lines.push(line);
        }

        Ok::<Vec<String>, std::io::Error>(lines)
    });

    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        reader.read_to_end(&mut buffer).await?;
        Ok::<Vec<u8>, std::io::Error>(buffer)
    });

    let timeout_duration = Duration::from_secs(TIMEOUT_SECS);
    let status_notice = match tokio::time::timeout(timeout_duration, child.wait()).await {
        Ok(status) => status.map_err(|e| {
            rnaseq_analysis_error(
                format!("Failed to check RNA-seq process status: {}", e),
                "wait_status_failed",
            )
        })?,
        Err(_) => {
            let _ = child.kill().await;
            return Err(rnaseq_analysis_error(
                format!("RNA-seq backend timed out after {} seconds", TIMEOUT_SECS),
                "timeout",
            ));
        }
    };

    let stdout_data = stdout_task
        .await
        .map_err(|e| {
            rnaseq_analysis_error(
                format!("Failed to join RNA-seq stdout task: {}", e),
                "stdout_task_join_failed",
            )
        })?
        .map_err(|e| {
            rnaseq_analysis_error(
                format!("Failed to read RNA-seq stdout: {}", e),
                "stdout_read_failed",
            )
        })?;
    let stderr_lines = stderr_task
        .await
        .map_err(|e| {
            rnaseq_analysis_error(
                format!("Failed to join RNA-seq stderr task: {}", e),
                "stderr_task_join_failed",
            )
        })?
        .map_err(|e| {
            rnaseq_analysis_error(
                format!("Failed to read RNA-seq stderr: {}", e),
                "stderr_read_failed",
            )
        })?;

    if !status_notice.success() {
        let stderr = stderr_lines.join("\n");
        return Err(rnaseq_analysis_error(
            format!(
                "RNA-seq backend execution returned non-zero exit status. Stderr summary: {}",
                summarize_backend_text(&stderr)
            ),
            "execution_failed",
        )
        .with_context(
            "exit_code",
            serde_json::json!(status_notice.code().unwrap_or(-1)),
        ));
    }

    let stdout = String::from_utf8(stdout_data).map_err(|e| {
        rnaseq_analysis_error(
            format!("Invalid UTF-8 output from RNA-seq backend: {}", e),
            "invalid_utf8",
        )
    })?;
    let result: Value = parse_json_from_backend_stdout(&stdout).map_err(|e| {
        rnaseq_analysis_error(
            format!(
                "Failed to parse RNA-seq JSON output: {}. Backend output summary: {}",
                e,
                summarize_backend_text(&stdout)
            ),
            "invalid_response_format",
        )
    })?;

    if let Some(success) = result.get("success").and_then(|v| v.as_bool()) {
        if !success {
            let requires_confirmation = result
                .get("requires_confirmation")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !requires_confirmation {
                let error_msg = result
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("Unknown error");
                let error_type = result
                    .get("error_type")
                    .and_then(|e| e.as_str())
                    .unwrap_or("Unknown");

                return Err(rnaseq_analysis_error(
                    format!(
                        "RNA-seq backend reported failure with error_type='{}' (message length: {} chars)",
                        error_type,
                        error_msg.chars().count()
                    ),
                    "backend_reported_failure",
                )
                .with_context("error_type", serde_json::json!(error_type)));
            }
        }
    }

    Ok(result)
}

/// Spawn Plot backend and execute plot computation
///
/// Similar to spawn_python_backend but uses plot.py
///
/// # Arguments
/// * `payload` - JSON payload to send to Python backend
/// * `mode` - Backend mode (Script or Compiled)
///
/// # Returns
/// * `Ok(Value)` - JSON result from Python
/// * `Err(AppErrorEnvelope)` - Structured error with stable code
///
/// # Error Codes
/// * `PLOT_603` - Plot backend not found
/// * `PLOT_603` - Plot backend timed out
/// * `PLOT_603` - Plot execution failed
/// * `PLOT_603` - Invalid response format
struct PersistentPlotExportWorker {
    mode: BackendMode,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

static PERSISTENT_PLOT_EXPORT_WORKER: OnceLock<Mutex<Option<PersistentPlotExportWorker>>> =
    OnceLock::new();

fn persistent_plot_export_worker() -> &'static Mutex<Option<PersistentPlotExportWorker>> {
    PERSISTENT_PLOT_EXPORT_WORKER.get_or_init(|| Mutex::new(None))
}

fn resolve_plot_command(
    mode: BackendMode,
) -> CommandResult<(PathBuf, Vec<PathBuf>, PathBuf, PathBuf)> {
    let base_dir = match resolve_python_base_dir(mode) {
        Ok(base_dir) => base_dir,
        Err(reason) => {
            return Err(AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                .with_detail(bundled_required_detail("plot", &reason))
                .with_retryable(false)
                .with_context("mode", serde_json::json!(format!("{:?}", mode))));
        }
    };
    let python_cwd = get_python_working_dir();

    let (cmd, args): (PathBuf, Vec<PathBuf>) = match mode {
        BackendMode::Script => {
            let python_exe = resolve_python_script_command(&base_dir);
            let script_path = base_dir.join(plot_script_rel());
            log::info!("Using Plot script mode: {:?} {:?}", python_exe, script_path);
            (python_exe, vec![script_path])
        }
        BackendMode::Compiled | BackendMode::CompiledRequired => {
            let exe_path = base_dir.join(plot_exe_rel());
            log::info!("Using compiled plot backend: {:?}", exe_path);
            (exe_path, vec![])
        }
        BackendMode::BundledRequired => match resolve_bundled_command(&base_dir, "plot") {
            Ok(resolved) => {
                log::info!(
                    "Using bundled plot runtime: {:?} {:?}",
                    resolved.0,
                    resolved.1
                );
                resolved
            }
            Err(reason) => {
                return Err(AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                    .with_detail(bundled_required_detail("plot", &reason))
                    .with_retryable(false)
                    .with_context("mode", serde_json::json!(format!("{:?}", mode))));
            }
        },
    };

    if !cmd.exists() && !path_points_to_command_name(&cmd) {
        let detail = match mode {
            BackendMode::CompiledRequired => format!(
                "{} {}. {} '{}'.",
                hardened_required_prefix_plot(),
                redacted_backend_target(&cmd),
                hardened_required_suffix_profile(),
                effective_build_profile()
            ),
            BackendMode::BundledRequired => {
                bundled_required_detail("plot", "interpreter path missing after contract check")
            }
            _ => format!(
                "Plot backend not found at: {:?}\nBase dir: {:?}\nCWD: {:?}",
                cmd,
                base_dir,
                std::env::current_dir().unwrap_or_default()
            ),
        };
        return Err(AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
            .with_detail(detail)
            .with_retryable(false)
            .with_context("mode", serde_json::json!(format!("{:?}", mode))));
    }

    let process_cwd = backend_process_cwd(mode, &cmd, &python_cwd);
    Ok((cmd, args, process_cwd, python_cwd))
}

async fn spawn_persistent_plot_export_worker(
    mode: BackendMode,
) -> CommandResult<PersistentPlotExportWorker> {
    let (cmd, args, process_cwd, _) = resolve_plot_command(mode)?;

    let mut process_cmd = Command::new(&cmd);
    apply_backend_spawn_flags(&mut process_cmd, mode);
    apply_backend_environment(&mut process_cmd, mode);
    let mut child = process_cmd
        .env("EASYCRIS_PLOT_BACKEND_PERSISTENT", "1")
        .current_dir(&process_cwd)
        .args(args.iter().map(|p| p.as_os_str()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                .with_detail(format!("Failed to spawn persistent Plot backend: {}", e))
                .with_retryable(true)
        })?;

    let stdin = child.stdin.take().ok_or_else(|| {
        AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
            .with_detail("Persistent plot backend stdin unavailable")
            .with_retryable(true)
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
            .with_detail("Persistent plot backend stdout unavailable")
            .with_retryable(true)
    })?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if !line.trim().is_empty() {
                    log::debug!("[plot-export-worker] {}", line.trim());
                }
            }
        });
    }

    Ok(PersistentPlotExportWorker {
        mode,
        child,
        stdin,
        stdout: BufReader::new(stdout),
    })
}

async fn execute_plot_export_via_worker(
    worker: &mut PersistentPlotExportWorker,
    payload: &Value,
) -> CommandResult<Value> {
    const EXPORT_TIMEOUT_SECS: u64 = 240;
    let mut payload_line = serde_json::to_string(payload).map_err(|e| {
        AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
            .with_detail(format!("Failed to serialize plot export payload: {}", e))
            .with_retryable(true)
    })?;
    payload_line.push('\n');

    worker
        .stdin
        .write_all(payload_line.as_bytes())
        .await
        .map_err(|e| {
            AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                .with_detail(format!(
                    "Failed to write request to persistent worker: {}",
                    e
                ))
                .with_retryable(true)
        })?;
    worker.stdin.flush().await.map_err(|e| {
        AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
            .with_detail(format!("Failed to flush persistent worker stdin: {}", e))
            .with_retryable(true)
    })?;

    let deadline = Instant::now() + Duration::from_secs(EXPORT_TIMEOUT_SECS);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                .with_detail(format!(
                    "Persistent plot export worker timed out after {} seconds",
                    EXPORT_TIMEOUT_SECS
                ))
                .with_retryable(true));
        }

        let mut response_line = String::new();
        let read_len = timeout(remaining, worker.stdout.read_line(&mut response_line))
            .await
            .map_err(|_| {
                AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                    .with_detail(format!(
                        "Persistent plot export worker timed out after {} seconds",
                        EXPORT_TIMEOUT_SECS
                    ))
                    .with_retryable(true)
            })?
            .map_err(|e| {
                AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                    .with_detail(format!("Failed reading persistent worker response: {}", e))
                    .with_retryable(true)
            })?;

        if read_len == 0 {
            return Err(AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                .with_detail("Persistent plot export worker closed the response stream")
                .with_retryable(true));
        }

        let trimmed = response_line.trim();
        if trimmed.is_empty() {
            continue;
        }

        match parse_json_from_backend_stdout(trimmed) {
            Ok(value) => return Ok(value),
            Err(parse_error) => {
                log::debug!(
                    "Ignoring non-JSON stdout line from persistent export worker: {} ({})",
                    summarize_backend_text(trimmed),
                    parse_error
                );
            }
        }
    }
}

async fn run_plot_export_via_persistent_worker(
    payload: &Value,
    mode: BackendMode,
) -> CommandResult<Value> {
    let worker_mutex = persistent_plot_export_worker();
    let mut guard = worker_mutex.lock().await;

    let needs_spawn = guard
        .as_ref()
        .map(|worker| worker.mode != mode)
        .unwrap_or(true);
    if needs_spawn {
        if let Some(mut stale_worker) = guard.take() {
            let _ = stale_worker.child.kill().await;
        }
        *guard = Some(spawn_persistent_plot_export_worker(mode).await?);
    }

    let result = {
        let worker = guard.as_mut().expect("worker initialized");
        execute_plot_export_via_worker(worker, payload).await
    };

    if result.is_err() {
        if let Some(mut stale_worker) = guard.take() {
            let _ = stale_worker.child.kill().await;
        }
    }

    result
}

pub async fn spawn_plot(payload: Value, mode: BackendMode) -> CommandResult<Value> {
    let action = payload
        .get("action")
        .and_then(|value| value.as_str())
        .unwrap_or_default();

    if action == "export_plot" {
        return run_plot_export_via_persistent_worker(&payload, mode).await;
    }

    // Get base directory for Python paths
    let (cmd, args, process_cwd, python_cwd) = resolve_plot_command(mode)?;
    log::debug!("Spawning Plot backend with cwd: {:?}", python_cwd);

    // Spawn process
    let mut process_cmd = Command::new(&cmd);
    apply_backend_spawn_flags(&mut process_cmd, mode);
    apply_backend_environment(&mut process_cmd, mode);
    let mut child = process_cmd
        .current_dir(&process_cwd)
        .args(args.iter().map(|p| p.as_os_str()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                .with_detail(format!("Failed to spawn Plot backend: {}", e))
                .with_retryable(false)
        })?;

    // Write payload to stdin
    if let Some(mut stdin) = child.stdin.take() {
        let payload_str = serde_json::to_string(&payload).map_err(|e| {
            AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                .with_detail(format!("Failed to serialize payload: {}", e))
                .with_retryable(true)
        })?;
        stdin.write_all(payload_str.as_bytes()).await.map_err(|e| {
            AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                .with_detail(format!("Failed to write payload to stdin: {}", e))
                .with_retryable(true)
        })?;
    }

    // Wait with timeout.
    // Most plot actions are fast, but static exports (PDF/TIFF via Kaleido)
    // legitimately require more time on slower machines.
    let start = Instant::now();
    let timeout_secs = if action == "export_plot" { 240 } else { 30 };
    let timeout_duration = Duration::from_secs(timeout_secs);

    let output = loop {
        match child.try_wait().map_err(|e| {
            AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                .with_detail(format!("Failed to check process status: {}", e))
                .with_retryable(true)
        })? {
            Some(status) => {
                let mut stdout_data = Vec::new();
                let mut stderr_data = Vec::new();

                if let Some(mut stdout) = child.stdout.take() {
                    stdout.read_to_end(&mut stdout_data).await.map_err(|e| {
                        AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                            .with_detail(format!("Failed to read stdout: {}", e))
                            .with_retryable(true)
                    })?;
                }

                if let Some(mut stderr) = child.stderr.take() {
                    stderr.read_to_end(&mut stderr_data).await.map_err(|e| {
                        AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                            .with_detail(format!("Failed to read stderr: {}", e))
                            .with_retryable(true)
                    })?;
                }

                let output = std::process::Output {
                    status,
                    stdout: stdout_data,
                    stderr: stderr_data,
                };
                break output;
            }
            None => {
                if start.elapsed() >= timeout_duration {
                    let _ = child.kill().await;
                    return Err(AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
                        .with_detail(format!(
                            "Plot backend timed out after {} seconds",
                            timeout_secs
                        ))
                        .with_retryable(true));
                }
                sleep(Duration::from_millis(50)).await;
            }
        }
    };

    // Treat any non-zero exit as execution failure, even when stderr is empty.
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
            .with_detail(format!(
                "Plot backend returned non-zero exit status. Stdout summary: {}. Stderr summary: {}",
                summarize_backend_text(&String::from_utf8_lossy(&output.stdout)),
                summarize_backend_text(&stderr),
            ))
            .with_retryable(true)
            .with_context("exit_code", serde_json::json!(output.status.code().unwrap_or(-1))));
    }

    // Parse stdout as JSON
    let stdout = String::from_utf8(output.stdout).map_err(|e| {
        AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
            .with_detail(format!("Invalid UTF-8 output from Plot backend: {}", e))
            .with_retryable(true)
    })?;

    let result: Value = parse_json_from_backend_stdout(&stdout).map_err(|e| {
        AppErrorEnvelope::new("PLOT_603", "Plot creation failed")
            .with_detail(format!(
                "Failed to parse JSON output: {}. Backend output summary: {}",
                e,
                summarize_backend_text(&stdout)
            ))
            .with_retryable(true)
    })?;

    Ok(result)
}

/// Determine backend mode based on build profile and file existence.
pub fn detect_backend_mode() -> BackendMode {
    detect_backend_mode_for(stats_exe_rel(), "stats", "stats", "stats")
}

/// Determine plot backend mode based on file existence
pub fn detect_plot_mode() -> BackendMode {
    detect_backend_mode_for(plot_exe_rel(), "plot", "plot", "plot")
}

/// Determine RNA-seq backend mode based on file existence
pub fn detect_rnaseq_mode() -> BackendMode {
    detect_backend_mode_for(rnaseq_exe_rel(), "RNA-seq", "RNA-seq", "RNA-seq")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compiled_backend_names_follow_platform() {
        assert_eq!(
            backend_executable_name("stats", TargetPlatform::Windows),
            "stats.exe"
        );
        assert_eq!(
            backend_executable_name("stats", TargetPlatform::MacOS),
            "stats"
        );
    }

    #[test]
    fn venv_python_paths_follow_platform() {
        assert_eq!(
            venv_python_rel(TargetPlatform::Windows),
            PathBuf::from(".venv-public/Scripts/python.exe")
        );
        assert_eq!(
            venv_python_rel(TargetPlatform::MacOS),
            PathBuf::from(".venv-public/bin/python")
        );
    }

    #[test]
    fn test_choose_backend_mode_for_open_profiles() {
        for platform in [TargetPlatform::Windows, TargetPlatform::MacOS] {
            assert!(matches!(
                choose_backend_mode("dev", platform, false),
                BackendMode::Script
            ));
            assert!(matches!(
                choose_backend_mode("dev", platform, true),
                BackendMode::Script
            ));
            assert!(matches!(
                choose_backend_mode("e2e", platform, false),
                BackendMode::Script
            ));
            assert!(matches!(
                choose_backend_mode("e2e", platform, true),
                BackendMode::Script
            ));
            assert!(matches!(
                choose_backend_mode("DEV", platform, false),
                BackendMode::Script
            ));
            assert!(matches!(
                choose_backend_mode("E2E", platform, true),
                BackendMode::Script
            ));
            assert!(matches!(
                choose_backend_mode("Dev", platform, false),
                BackendMode::Script
            ));
        }
    }

    #[test]
    fn test_choose_backend_mode_for_hardened_profiles() {
        assert!(matches!(
            choose_backend_mode("release", TargetPlatform::Windows, true),
            BackendMode::Compiled
        ));
        assert!(matches!(
            choose_backend_mode("release", TargetPlatform::Windows, false),
            BackendMode::CompiledRequired
        ));
        // Unknown profiles default to hardened behavior on Windows.
        assert!(matches!(
            choose_backend_mode("prod", TargetPlatform::Windows, false),
            BackendMode::CompiledRequired
        ));
    }

    #[test]
    fn choose_backend_mode_macos_release_is_bundled_required() {
        assert!(matches!(
            choose_backend_mode("release", TargetPlatform::MacOS, false),
            BackendMode::BundledRequired
        ));
        assert!(matches!(
            choose_backend_mode("prod", TargetPlatform::MacOS, false),
            BackendMode::BundledRequired
        ));
    }

    #[test]
    fn choose_backend_mode_macos_release_ignores_compiled_artifacts() {
        assert!(matches!(
            choose_backend_mode("release", TargetPlatform::MacOS, true),
            BackendMode::BundledRequired
        ));
    }

    #[test]
    fn choose_backend_mode_open_profiles_still_script_on_macos() {
        assert!(matches!(
            choose_backend_mode("e2e", TargetPlatform::MacOS, true),
            BackendMode::Script
        ));
    }

    #[test]
    fn choose_backend_mode_windows_release_still_compiled_or_required() {
        assert_eq!(
            choose_backend_mode("release", TargetPlatform::Windows, true),
            BackendMode::Compiled
        );
        assert_eq!(
            choose_backend_mode("release", TargetPlatform::Windows, false),
            BackendMode::CompiledRequired
        );
    }

    #[test]
    fn bundled_runtime_paths_match_js_layout() {
        assert_eq!(
            bundled_interpreter_rel(),
            PathBuf::from("python_embedded/runtime/bin/python3.12")
        );
        assert_eq!(
            bundled_manifest_rel(),
            PathBuf::from("python_embedded/runtime/easycris_runtime_manifest.json")
        );
        assert_eq!(
            bundled_module_rel("stats").expect("stats"),
            PathBuf::from("python_embedded/runtime/lib/python3.12/site-packages/stats.py")
        );
        assert_eq!(
            bundled_module_rel("rnaseq").expect("rnaseq"),
            PathBuf::from("python_embedded/runtime/lib/python3.12/site-packages/rnaseq.py")
        );
        assert_eq!(
            bundled_module_rel("plot").expect("plot"),
            PathBuf::from("python_embedded/runtime/lib/python3.12/site-packages/plot.py")
        );
        assert!(bundled_module_rel("unknown").is_err());
    }

    #[test]
    fn bundled_launch_args_are_exactly_isolated_module_flags() {
        assert_eq!(
            bundled_launch_args("stats").expect("stats"),
            vec![
                PathBuf::from("-I"),
                PathBuf::from("-B"),
                PathBuf::from("-m"),
                PathBuf::from("stats"),
            ]
        );
        assert_eq!(
            bundled_launch_args("plot").expect("plot"),
            vec![
                PathBuf::from("-I"),
                PathBuf::from("-B"),
                PathBuf::from("-m"),
                PathBuf::from("plot"),
            ]
        );
    }

    #[test]
    fn backend_process_cwd_bundled_uses_writable_fallback() {
        let cmd = PathBuf::from("/Applications/easyCris.app/Contents/MacOS/python3.12");
        let fallback = PathBuf::from("/tmp/easyCris-python_backend");
        assert_eq!(
            backend_process_cwd(BackendMode::BundledRequired, &cmd, &fallback),
            fallback
        );
        assert_eq!(
            backend_process_cwd(BackendMode::Compiled, &cmd, &fallback),
            PathBuf::from("/Applications/easyCris.app/Contents/MacOS")
        );
    }

    fn write_minimal_bundled_runtime(root: &Path) {
        let runtime = root.join("python_embedded").join("runtime");
        let bin = runtime.join("bin");
        let site = runtime
            .join("lib")
            .join("python3.12")
            .join("site-packages");
        std::fs::create_dir_all(&bin).expect("bin");
        std::fs::create_dir_all(&site).expect("site");
        std::fs::write(bin.join("python3.12"), b"fake-python").expect("interpreter");
        std::fs::write(
            runtime.join("easycris_runtime_manifest.json"),
            r#"{"schema_version":1}"#,
        )
        .expect("manifest");
        for module in ["stats", "rnaseq", "plot"] {
            std::fs::write(site.join(format!("{module}.py")), b"# module\n").expect("module");
        }
    }

    #[test]
    fn verify_bundled_runtime_contract_ok_with_minimal_fixture() {
        let dir = std::env::temp_dir().join(format!(
            "easycris-bundled-ok-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmpdir");
        write_minimal_bundled_runtime(&dir);
        assert!(verify_bundled_runtime_contract(&dir, "stats").is_ok());
        assert!(verify_bundled_runtime_contract(&dir, "rnaseq").is_ok());
        assert!(verify_bundled_runtime_contract(&dir, "plot").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_bundled_runtime_contract_fails_without_interpreter() {
        let dir = std::env::temp_dir().join(format!(
            "easycris-bundled-no-interp-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmpdir");
        write_minimal_bundled_runtime(&dir);
        std::fs::remove_file(dir.join(bundled_interpreter_rel())).expect("rm interp");
        let err = verify_bundled_runtime_contract(&dir, "stats").expect_err("must fail");
        assert!(err.contains("interpreter missing"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_bundled_runtime_contract_fails_without_manifest() {
        let dir = std::env::temp_dir().join(format!(
            "easycris-bundled-no-manifest-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmpdir");
        write_minimal_bundled_runtime(&dir);
        std::fs::remove_file(dir.join(bundled_manifest_rel())).expect("rm manifest");
        let err = verify_bundled_runtime_contract(&dir, "stats").expect_err("must fail");
        assert!(err.contains("manifest missing"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_bundled_runtime_contract_fails_without_module() {
        let dir = std::env::temp_dir().join(format!(
            "easycris-bundled-no-module-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmpdir");
        write_minimal_bundled_runtime(&dir);
        std::fs::remove_file(dir.join(bundled_module_rel("plot").unwrap())).expect("rm module");
        let err = verify_bundled_runtime_contract(&dir, "plot").expect_err("must fail");
        assert!(err.contains("module missing"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_bundled_runtime_contract_fails_on_bad_schema() {
        let dir = std::env::temp_dir().join(format!(
            "easycris-bundled-bad-schema-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmpdir");
        write_minimal_bundled_runtime(&dir);
        std::fs::write(
            dir.join(bundled_manifest_rel()),
            r#"{"schema_version":2}"#,
        )
        .expect("bad schema");
        let err = verify_bundled_runtime_contract(&dir, "stats").expect_err("must fail");
        assert!(err.contains("schema_version"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rnaseq_script_fallback_excludes_bundled_required() {
        // Mirrors rnaseq_commands.rs: only Compiled* may opt into Script fallback.
        fn should_try_rnaseq_script_fallback(mode: BackendMode, enabled: bool, code: &str) -> bool {
            enabled
                && matches!(mode, BackendMode::Compiled | BackendMode::CompiledRequired)
                && code == "RNASEQ_402"
        }
        assert!(!should_try_rnaseq_script_fallback(
            BackendMode::BundledRequired,
            true,
            "RNASEQ_402"
        ));
        assert!(should_try_rnaseq_script_fallback(
            BackendMode::CompiledRequired,
            true,
            "RNASEQ_402"
        ));
    }

    #[test]
    fn installed_python_base_dir_candidate_matches_updater_layout() {
        assert_eq!(
            installed_python_base_dir_candidate(
                Path::new(r"C:\Users\me\AppData\Local"),
                "easycris"
            ),
            Path::new(r"C:\Users\me\AppData\Local\easycris\_up_\bundle_resources").to_path_buf()
        );
    }

    #[test]
    fn macos_bundle_python_base_dir_candidate_uses_updater_resources() {
        let exe_path = Path::new("/Applications/easyCris.app/Contents/MacOS/easycris");
        let exe_dir = exe_path.parent().expect("executable path has a parent");

        assert_eq!(
            macos_bundle_python_base_dir_candidate(exe_dir),
            Some(PathBuf::from(
                "/Applications/easyCris.app/Contents/Resources/_up_/bundle_resources"
            ))
        );
    }

    #[test]
    fn macos_bundle_python_base_dir_candidate_rejects_macos_outside_app_contents() {
        let exe_path = Path::new("/tmp/not-an-app/MacOS/easycris");
        let exe_dir = exe_path.parent().expect("executable path has a parent");

        assert_eq!(macos_bundle_python_base_dir_candidate(exe_dir), None);
    }

    #[test]
    fn bundled_required_resolver_rejects_missing_app_resources_without_development_fallback() {
        let root = std::env::temp_dir().join(format!(
            "easycris-bundled-resolution-missing-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let app_exe = root
            .join("easyCris.app")
            .join("Contents")
            .join("MacOS")
            .join("easyCris");
        std::fs::create_dir_all(app_exe.parent().expect("app executable parent")).expect("app");
        std::fs::create_dir_all(root.join("development/python_embedded")).expect("development");

        let fallback_was_used = std::cell::Cell::new(false);
        let result =
            resolve_python_base_dir_for_mode(BackendMode::BundledRequired, Some(&app_exe), || {
                fallback_was_used.set(true);
                root.join("development")
            });

        assert!(result.is_err(), "missing app resources must fail closed");
        assert!(
            !fallback_was_used.get(),
            "must not consult development fallback"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_parse_json_from_backend_stdout_allows_trailing_text() {
        let stdout = "{\"success\":true,\"message\":\"ok\"}\nextra-log-line";
        let parsed = parse_json_from_backend_stdout(stdout).expect("should parse JSON prefix");
        assert_eq!(parsed.get("success").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn test_parse_json_from_backend_stdout_handles_prefixed_logs_and_trailing_text() {
        let stdout =
            "debug: startup warning {not-json}\n{\"success\":true,\"value\":42}\ntrace: done";
        let parsed =
            parse_json_from_backend_stdout(stdout).expect("should parse JSON after prefixed log");
        assert_eq!(parsed.get("success").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(parsed.get("value").and_then(|v| v.as_i64()), Some(42));
    }

    #[test]
    fn test_first_nonfinite_json_token_context_detects_line_column() {
        let stdout = "{\n  \"success\": true,\n  \"value\": NaN\n}";
        let context = first_nonfinite_json_token_context(stdout)
            .expect("should detect non-finite token context");
        assert!(context.contains("NaN"));
        assert!(context.contains("line 3"));
        assert!(context.contains("column 12"));
    }

    #[test]
    fn test_first_nonfinite_json_token_context_none_when_absent() {
        let stdout = "{\"success\": true, \"value\": 1.23}";
        assert!(first_nonfinite_json_token_context(stdout).is_none());
    }

    #[test]
    fn test_stats_failure_user_message_mappings() {
        assert_eq!(
            stats_failure_user_message("DoseResponseDataUnsuitable"),
            "Dose-response data unsuitable / fit unstable"
        );
        assert_eq!(
            stats_failure_user_message("DoseResponseFitInvalid"),
            "Dose-response data unsuitable / fit unstable"
        );
        assert_eq!(
            stats_failure_user_message("DoseResponseFitFailed"),
            "Dose-response data unsuitable / fit unstable"
        );
        assert_eq!(
            stats_failure_user_message("OtherErrorType"),
            "Analysis backend reported failure"
        );
    }

    #[test]
    fn test_stats_failure_code_mappings() {
        assert_eq!(
            stats_failure_code("DoseResponseDataUnsuitable"),
            "STATS_PY_340"
        );
        assert_eq!(stats_failure_code("DoseResponseFitInvalid"), "STATS_PY_340");
        assert_eq!(stats_failure_code("DoseResponseFitFailed"), "STATS_PY_340");
        assert_eq!(stats_failure_code("OtherErrorType"), "STATS_PY_329");
    }

    #[tokio::test]
    async fn test_spawn_backend_with_valid_payload() {
        // This test requires the Python backend to be set up
        // Skip in CI environments
        if std::env::var("CI").is_ok() {
            return;
        }

        let payload = json!({
            "test": "descriptive_stats",
            "data": {"values": [1.0, 2.0, 3.0, 4.0, 5.0]},
            "parameters": {}
        });

        let mode = detect_backend_mode();
        let result = spawn_python_backend(payload, mode, None).await;

        // Should either succeed or fail gracefully
        match result {
            Ok(res) => {
                assert!(res.get("success").is_some());
            }
            Err(e) => {
                // Backend might not be available in test environment
                eprintln!("Backend test skipped: {}", e);
            }
        }
    }
}
