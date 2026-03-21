use image::GenericImageView;
use keyring::{Entry, Error as KeyringError};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(feature = "obfuscate")]
use litcrypt::use_litcrypt;

#[cfg(feature = "obfuscate")]
use_litcrypt!();

// Import our modular backend
pub mod modules;
use modules::commands::*;

// Validation functions
fn validate_filename(filename: &str) -> Result<(), String> {
    // Regex pattern: only alphanumeric, dash, underscore, dot
    let filename_pattern = Regex::new(r"^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9]+)?$")
        .map_err(|e| format!("Regex compilation error: {e}"))?;

    if filename.is_empty() {
        return Err("Filename cannot be empty".to_string());
    }

    if filename.len() > 100 {
        return Err("Filename too long (max 100 characters)".to_string());
    }

    if !filename_pattern.is_match(filename) {
        return Err(
            "Invalid filename: only alphanumeric characters, dashes, underscores, and dots allowed"
                .to_string(),
        );
    }

    Ok(())
}

fn validate_string_input(input: &str, max_len: usize, field_name: &str) -> Result<(), String> {
    if input.len() > max_len {
        return Err(format!("{field_name} too long (max {max_len} characters)"));
    }
    Ok(())
}

fn validate_theme(theme: &str) -> Result<(), String> {
    match theme {
        "light" | "dark" | "system" => Ok(()),
        _ => Err("Invalid theme: must be 'light', 'dark', or 'system'".to_string()),
    }
}

static ALLOW_APP_CLOSE: AtomicBool = AtomicBool::new(false);
static PENDING_OPEN_PROJECT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
const DESKTOP_AUTH_DEFAULT_WEB_BASE_URL: &str = "https://easycris.com";
const DESKTOP_AUTH_KEYRING_SERVICE: &str = "easycris.desktop_auth";
const DESKTOP_AUTH_KEYRING_ACCOUNT: &str = "session_token";

fn resolve_preferred_release_exe() -> Option<std::path::PathBuf> {
    let candidates = [
        "ole-server\\target\\release\\ole-server.exe",
        "src-tauri\\target\\release\\easyCris.exe",
        "src-tauri\\target\\release\\tauri-app.exe",
    ];
    if let Ok(cwd) = std::env::current_dir() {
        for rel in candidates {
            let candidate = cwd.join(rel);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_ole_server_exe() -> Option<std::path::PathBuf> {
    let candidates = [
        "ole-server\\target\\release\\ole-server.exe",
        "ole-server\\target\\debug\\ole-server.exe",
    ];
    if let Ok(cwd) = std::env::current_dir() {
        for rel in candidates {
            let candidate = cwd.join(rel);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn parse_truthy_flag(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn is_experimental_ole_enabled() -> bool {
    #[cfg(debug_assertions)]
    {
        true
    }
    #[cfg(not(debug_assertions))]
    {
        std::env::var("EASYCRIS_EXPERIMENTAL_OLE")
            .map(|value| parse_truthy_flag(&value))
            .unwrap_or(false)
    }
}

fn ensure_experimental_ole_enabled() -> Result<(), String> {
    if is_experimental_ole_enabled() {
        Ok(())
    } else {
        Err(
            "OLE integration is disabled by default. Set EASYCRIS_EXPERIMENTAL_OLE=1 to enable this experimental feature.".to_string(),
        )
    }
}

#[tauri::command]
fn allow_app_close() {
    ALLOW_APP_CLOSE.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn is_auto_update_disabled() -> bool {
    ["EASYCRIS_DISABLE_AUTO_UPDATE", "VITE_DISABLE_AUTO_UPDATE"]
        .iter()
        .any(|key| {
            std::env::var(key)
                .map(|value| parse_truthy_flag(&value))
                .unwrap_or(false)
        })
}

#[tauri::command]
fn take_pending_open_project() -> Option<String> {
    PENDING_OPEN_PROJECT
        .lock()
        .ok()
        .and_then(|mut pending| pending.take())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAuthStartResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct DesktopAuthStartWebResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAuthPollResponse {
    status: String,
    session_token: Option<String>,
    retry_after_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct DesktopAuthPollWebResponse {
    status: String,
    session_token: Option<String>,
    retry_after_secs: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAuthSessionResponse {
    valid: bool,
    reason: Option<String>,
    device_id: Option<String>,
    tier: Option<String>,
    expires_at: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DesktopAuthSessionWebResponse {
    valid: bool,
    reason: Option<String>,
    device_id: Option<String>,
    tier: Option<String>,
    expires_at: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAuthRefreshResponse {
    valid: bool,
    reason: Option<String>,
    session_token: Option<String>,
    device_id: Option<String>,
    tier: Option<String>,
    expires_at: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DesktopAuthRefreshWebResponse {
    valid: bool,
    reason: Option<String>,
    session_token: Option<String>,
    device_id: Option<String>,
    tier: Option<String>,
    expires_at: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAuthRevokeResponse {
    success: bool,
    already_revoked: bool,
}

#[derive(Debug, Deserialize)]
struct DesktopAuthRevokeWebResponse {
    success: bool,
    already_revoked: bool,
}

fn get_easycris_web_base_url() -> String {
    std::env::var("EASYCRIS_WEB_URL")
        .or_else(|_| std::env::var("VITE_EASYCRIS_WEB_URL"))
        .or_else(|_| {
            option_env!("EASYCRIS_WEB_URL")
                .or(option_env!("VITE_EASYCRIS_WEB_URL"))
                .map(str::to_string)
                .ok_or(std::env::VarError::NotPresent)
        })
        .unwrap_or_else(|_| DESKTOP_AUTH_DEFAULT_WEB_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn desktop_auth_endpoint(path: &str) -> String {
    format!(
        "{}/{}",
        get_easycris_web_base_url(),
        path.trim_start_matches('/')
    )
}

fn desktop_auth_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Failed to initialize desktop auth client: {error}"))
}

async fn parse_web_error(response: reqwest::Response) -> String {
    let status = response.status();
    match response.json::<Value>().await {
        Ok(Value::Object(payload)) => payload
            .get("error")
            .or_else(|| payload.get("message"))
            .or_else(|| payload.get("msg"))
            .and_then(|value| value.as_str())
            .map(|message| message.to_string())
            .unwrap_or_else(|| format!("Request failed with status {status}")),
        _ => format!("Request failed with status {status}"),
    }
}

fn desktop_auth_keyring_entry() -> Result<Entry, String> {
    Entry::new(DESKTOP_AUTH_KEYRING_SERVICE, DESKTOP_AUTH_KEYRING_ACCOUNT)
        .map_err(|error| format!("Failed to initialize secure storage: {error}"))
}

#[cfg(test)]
mod desktop_auth_command_tests {
    use super::{desktop_auth_client, desktop_auth_endpoint, DesktopAuthStartWebResponse};
    use serde_json::json;
    use tokio::time::{timeout, Duration};

    #[tokio::test]
    #[ignore = "Requires live desktop auth backend connectivity"]
    async fn desktop_auth_start_http_path_returns_within_timeout() {
        let client_version = "0.1.24".to_string();
        let device_fingerprint = "rust-http-path-probe".to_string();

        let response = timeout(Duration::from_secs(12), async {
            let client = desktop_auth_client().expect("desktop auth client should build");
            let response = client
                .post(desktop_auth_endpoint("/api/desktop-auth/start"))
                .json(&json!({
                    "client_version": client_version,
                    "device_fingerprint": device_fingerprint,
                }))
                .send()
                .await
                .expect("desktop auth request should complete");

            assert!(
                response.status().is_success(),
                "desktop auth start returned non-success status {}",
                response.status()
            );

            response
                .json::<DesktopAuthStartWebResponse>()
                .await
                .expect("desktop auth start should return valid JSON")
        })
        .await;

        let body = response.expect("desktop auth HTTP path timed out");
        assert!(!body.device_code.is_empty());
        assert!(!body.user_code.is_empty());
        assert!(body.verification_uri.contains("auth/device"));
    }
}

#[tauri::command]
async fn desktop_auth_start(
    client_version: String,
    device_fingerprint: String,
) -> Result<DesktopAuthStartResponse, String> {
    validate_string_input(&client_version, 64, "Client version")?;
    validate_string_input(&device_fingerprint, 128, "Device fingerprint")?;

    let endpoint = desktop_auth_endpoint("/api/desktop-auth/start");
    log::info!(
        "desktop_auth_start: requesting device link start (client_version={}, fingerprint={}, endpoint={})",
        client_version,
        device_fingerprint,
        endpoint
    );

    let client = desktop_auth_client()?;
    let response = client
        .post(&endpoint)
        .json(&serde_json::json!({
            "client_version": client_version,
            "device_fingerprint": device_fingerprint,
        }))
        .send()
        .await
        .map_err(|error| {
            let message = format!("Failed to start device linking: {error}");
            log::error!("desktop_auth_start: request failed: {}", message);
            message
        })?;

    if !response.status().is_success() {
        let message = parse_web_error(response).await;
        log::error!("desktop_auth_start: non-success response: {}", message);
        return Err(message);
    }

    let body = response
        .json::<DesktopAuthStartWebResponse>()
        .await
        .map_err(|error| {
            let message = format!("Invalid desktop auth response: {error}");
            log::error!("desktop_auth_start: response parse failed: {}", message);
            message
        })?;

    log::info!(
        "desktop_auth_start: received device_code and user_code={}, interval={}s, expires_in={}s",
        body.user_code,
        body.interval,
        body.expires_in
    );

    Ok(DesktopAuthStartResponse {
        device_code: body.device_code,
        user_code: body.user_code,
        verification_uri: body.verification_uri,
        expires_in: body.expires_in,
        interval: body.interval,
    })
}

#[tauri::command]
async fn desktop_auth_poll(
    device_code: String,
) -> Result<DesktopAuthPollResponse, String> {
    validate_string_input(&device_code, 128, "Device code")?;

    let client = desktop_auth_client()?;
    let response = client
        .post(desktop_auth_endpoint("/api/desktop-auth/poll"))
        .json(&serde_json::json!({
            "device_code": device_code,
        }))
        .send()
        .await
        .map_err(|error| format!("Failed to poll device approval: {error}"))?;

    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after_secs = response
            .headers()
            .get("Retry-After")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0);

        return Ok(DesktopAuthPollResponse {
            status: "rate_limited".to_string(),
            session_token: None,
            retry_after_secs,
        });
    }

    if !response.status().is_success() {
        return Err(parse_web_error(response).await);
    }

    let body = response
        .json::<DesktopAuthPollWebResponse>()
        .await
        .map_err(|error| format!("Invalid device poll response: {error}"))?;

    Ok(DesktopAuthPollResponse {
        status: body.status,
        session_token: body.session_token,
        retry_after_secs: body.retry_after_secs,
    })
}

#[tauri::command]
async fn desktop_auth_validate_session(
    session_token: String,
) -> Result<DesktopAuthSessionResponse, String> {
    validate_string_input(&session_token, 512, "Session token")?;

    let client = desktop_auth_client()?;
    let response = client
        .post(desktop_auth_endpoint("/api/device-session/validate"))
        .json(&serde_json::json!({
            "session_token": session_token,
        }))
        .send()
        .await
        .map_err(|error| format!("Failed to validate device session: {error}"))?;

    if !response.status().is_success() {
        return Err(parse_web_error(response).await);
    }

    let body = response
        .json::<DesktopAuthSessionWebResponse>()
        .await
        .map_err(|error| format!("Invalid device validation response: {error}"))?;

    Ok(DesktopAuthSessionResponse {
        valid: body.valid,
        reason: body.reason,
        device_id: body.device_id,
        tier: body.tier,
        expires_at: body.expires_at,
        email: body.email,
    })
}

#[tauri::command]
async fn desktop_auth_refresh_session(
    session_token: String,
) -> Result<DesktopAuthRefreshResponse, String> {
    validate_string_input(&session_token, 512, "Session token")?;

    let client = desktop_auth_client()?;
    let response = client
        .post(desktop_auth_endpoint("/api/device-session/refresh"))
        .json(&serde_json::json!({
            "session_token": session_token,
        }))
        .send()
        .await
        .map_err(|error| format!("Failed to refresh device session: {error}"))?;

    if !response.status().is_success() {
        return Err(parse_web_error(response).await);
    }

    let body = response
        .json::<DesktopAuthRefreshWebResponse>()
        .await
        .map_err(|error| format!("Invalid device refresh response: {error}"))?;

    Ok(DesktopAuthRefreshResponse {
        valid: body.valid,
        reason: body.reason,
        session_token: body.session_token,
        device_id: body.device_id,
        tier: body.tier,
        expires_at: body.expires_at,
        email: body.email,
    })
}

#[tauri::command]
async fn desktop_auth_revoke_session(
    session_token: String,
) -> Result<DesktopAuthRevokeResponse, String> {
    validate_string_input(&session_token, 512, "Session token")?;

    let client = desktop_auth_client()?;
    let response = client
        .post(desktop_auth_endpoint("/api/device-session/revoke"))
        .json(&serde_json::json!({
            "session_token": session_token,
        }))
        .send()
        .await
        .map_err(|error| format!("Failed to sign out this device: {error}"))?;

    if !response.status().is_success() {
        return Err(parse_web_error(response).await);
    }

    let body = response
        .json::<DesktopAuthRevokeWebResponse>()
        .await
        .map_err(|error| format!("Invalid device revoke response: {error}"))?;

    Ok(DesktopAuthRevokeResponse {
        success: body.success,
        already_revoked: body.already_revoked,
    })
}

#[tauri::command]
fn desktop_auth_store_session_token(token: String) -> Result<(), String> {
    validate_string_input(&token, 512, "Session token")?;
    let entry = desktop_auth_keyring_entry()?;
    entry
        .set_password(&token)
        .map_err(|error| format!("Failed to store device session token: {error}"))
}

#[tauri::command]
fn desktop_auth_load_session_token() -> Result<Option<String>, String> {
    let entry = desktop_auth_keyring_entry()?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!("Failed to load device session token: {error}")),
    }
}

#[tauri::command]
fn desktop_auth_clear_session_token() -> Result<(), String> {
    let entry = desktop_auth_keyring_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!("Failed to clear device session token: {error}")),
    }
}

#[derive(Serialize)]
struct OfficeBitnessInfo {
    office_bitness: Option<String>,
    office_source: Option<String>,
    easycris_bitness: String,
}

// OLE Registration Commands (Windows only)
#[cfg(windows)]
#[tauri::command]
fn check_ole_registration() -> Result<bool, String> {
    use std::process::Command;

    ensure_experimental_ole_enabled()?;

    let clsid = "{7E8A4C2D-1F3B-4E5D-9A8F-2B6C7D8E9F0A}";
    let registry_path = format!("HKCR\\CLSID\\{}", clsid);

    log::debug!("Checking OLE registration for CLSID: {}", clsid);

    // Use reg query to check if CLSID exists
    let output = Command::new("reg")
        .args(&["query", &registry_path])
        .output()
        .map_err(|e| format!("Failed to query registry: {}", e))?;

    let is_registered = output.status.success();

    if is_registered {
        log::info!("OLE integration is registered");
    } else {
        log::info!("OLE integration is NOT registered");
    }

    Ok(is_registered)
}

#[cfg(not(windows))]
#[tauri::command]
fn check_ole_registration() -> Result<bool, String> {
    Ok(false) // OLE is Windows-only
}

#[cfg(windows)]
#[tauri::command]
fn get_office_bitness() -> Result<OfficeBitnessInfo, String> {
    use std::process::Command;

    fn read_reg_value(path: &str, value: &str) -> Option<String> {
        let output = Command::new("reg")
            .args(&["query", path, "/v", value])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if line.contains(value) {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if let Some(last) = parts.last() {
                    return Some(last.to_string());
                }
            }
        }
        None
    }

    let candidates = [
        (
            "HKLM\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration",
            "Platform",
        ),
        (
            "HKLM\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration",
            "OfficeClientEdition",
        ),
        (
            "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Office\\ClickToRun\\Configuration",
            "Platform",
        ),
        (
            "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Office\\ClickToRun\\Configuration",
            "OfficeClientEdition",
        ),
    ];

    let mut office_bitness = None;
    let mut office_source = None;
    for (path, value) in candidates {
        if let Some(raw) = read_reg_value(path, value) {
            let normalized = raw.to_lowercase();
            let bitness = if normalized.contains("x64") || normalized.contains("64") {
                Some("64-bit".to_string())
            } else if normalized.contains("x86") || normalized.contains("32") {
                Some("32-bit".to_string())
            } else {
                Some(raw)
            };
            office_bitness = bitness;
            office_source = Some(format!("{} {}", path, value));
            break;
        }
    }

    let easycris_bitness = if cfg!(target_pointer_width = "64") {
        "64-bit"
    } else {
        "32-bit"
    }
    .to_string();

    Ok(OfficeBitnessInfo {
        office_bitness,
        office_source,
        easycris_bitness,
    })
}

#[cfg(not(windows))]
#[tauri::command]
fn get_office_bitness() -> Result<OfficeBitnessInfo, String> {
    Ok(OfficeBitnessInfo {
        office_bitness: None,
        office_source: None,
        easycris_bitness: "unknown".to_string(),
    })
}

#[cfg(windows)]
#[tauri::command]
async fn enable_ole_registration(app: AppHandle) -> Result<String, String> {
    use std::process::Command;

    ensure_experimental_ole_enabled()?;

    log::info!("Attempting to enable OLE registration...");

    // Resolve ole-server executable path (embedded-only COM server)
    let ole_server_path = resolve_ole_server_exe()
        .or_else(|| {
            if let Ok(base_dir) = app.path().resource_dir() {
                let candidates = [
                    base_dir
                        .join("ole-server")
                        .join("target")
                        .join("release")
                        .join("ole-server.exe"),
                    base_dir
                        .join("ole-server")
                        .join("target")
                        .join("debug")
                        .join("ole-server.exe"),
                    base_dir.join("ole-server.exe"),
                ];
                for candidate in candidates {
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
            None
        })
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|dir| dir.join("ole-server.exe")))
                .filter(|path| path.exists())
        })
        .ok_or_else(|| "Failed to resolve ole-server executable path".to_string())?;

    let ole_server_path_str = ole_server_path.to_string_lossy().to_string();
    log::info!("Using ole-server executable: {}", ole_server_path_str);

    // Find script path (resource dir in production, fallback to dev repo paths)
    let mut script_path = None;
    if let Ok(base_dir) = app.path().resource_dir() {
        let candidate = base_dir.join("scripts").join("register_ole_server.ps1");
        if candidate.exists() {
            script_path = Some(candidate);
        }
    }
    if script_path.is_none() {
        if let Ok(base_dir) = app.path().resource_dir() {
            let candidate = base_dir
                .join("_up_")
                .join("scripts")
                .join("register_ole_server.ps1");
            if candidate.exists() {
                script_path = Some(candidate);
            }
        }
    }
    if script_path.is_none() {
        if let Some(exe_dir) = ole_server_path.parent() {
            let candidate = exe_dir.join("scripts").join("register_ole_server.ps1");
            if candidate.exists() {
                script_path = Some(candidate);
            }
        }
    }
    if script_path.is_none() {
        if let Some(exe_dir) = ole_server_path.parent() {
            if let Some(parent) = exe_dir.parent() {
                let candidate = parent.join("scripts").join("register_ole_server.ps1");
                if candidate.exists() {
                    script_path = Some(candidate);
                }
            }
        }
    }
    if script_path.is_none() {
        if let Some(exe_dir) = ole_server_path.parent() {
            if let Some(parent) = exe_dir.parent().and_then(|p| p.parent()) {
                let candidate = parent.join("scripts").join("register_ole_server.ps1");
                if candidate.exists() {
                    script_path = Some(candidate);
                }
            }
        }
    }
    if script_path.is_none() {
        if let Some(exe_dir) = ole_server_path.parent() {
            if let Some(parent) = exe_dir
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
            {
                let candidate = parent.join("scripts").join("register_ole_server.ps1");
                if candidate.exists() {
                    script_path = Some(candidate);
                }
            }
        }
    }
    if script_path.is_none() {
        if let Ok(cwd) = std::env::current_dir() {
            let candidate = cwd.join("scripts").join("register_ole_server.ps1");
            if candidate.exists() {
                script_path = Some(candidate);
            }
        }
    }
    if script_path.is_none() {
        if let Ok(cwd) = std::env::current_dir() {
            if let Some(parent) = cwd.parent() {
                let candidate = parent.join("scripts").join("register_ole_server.ps1");
                if candidate.exists() {
                    script_path = Some(candidate);
                }
            }
        }
    }
    if script_path.is_none() {
        if let Ok(cwd) = std::env::current_dir() {
            if let Some(parent) = cwd.parent().and_then(|p| p.parent()) {
                let candidate = parent.join("scripts").join("register_ole_server.ps1");
                if candidate.exists() {
                    script_path = Some(candidate);
                }
            }
        }
    }

    let script_path = script_path.ok_or_else(|| {
        "Registration script not found (checked resource_dir, exe_dir, cwd, and parent dirs)"
            .to_string()
    })?;

    log::info!("Running registration script: {:?}", script_path);

    let script_path_str = script_path.to_string_lossy().to_string();
    let escaped_script_path = script_path_str.replace('\'', "''");
    let escaped_ole_server_path = ole_server_path_str.replace('\'', "''");
    // Keep elevation prompt (RunAs), but avoid interpolating unescaped arguments
    // into a raw command line.
    let ps_command = format!(
        "Start-Process -FilePath PowerShell -Verb RunAs -ArgumentList @('-ExecutionPolicy','Bypass','-File','{}','-ExePathOverride','{}') -Wait",
        escaped_script_path, escaped_ole_server_path
    );

    log::debug!("PowerShell command: {}", ps_command);

    let output = Command::new("powershell")
        .args(&["-Command", &ps_command])
        .output()
        .map_err(|e| format!("Failed to run registration script: {}", e))?;

    if output.status.success() {
        log::info!("OLE registration completed successfully");
        Ok("OLE registration enabled successfully".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!("OLE registration failed: {}", stderr);
        Err(format!("Registration failed: {}", stderr))
    }
}

#[cfg(not(windows))]
#[tauri::command]
async fn enable_ole_registration(_app: AppHandle) -> Result<String, String> {
    Err("OLE integration is only available on Windows".to_string())
}

#[cfg(windows)]
#[tauri::command]
async fn enable_ecp_file_association(app: AppHandle) -> Result<String, String> {
    use std::process::Command;

    ensure_experimental_ole_enabled()?;

    log::info!("Attempting to enable .ecp file association...");

    // Get preferred dev executable path
    let exe_path = resolve_preferred_release_exe()
        .or_else(|| std::env::current_exe().ok())
        .ok_or_else(|| "Failed to resolve executable path".to_string())?;

    let exe_path_str = exe_path.to_string_lossy().to_string();
    log::info!("Current executable: {}", exe_path_str);

    // Find script path (resource dir in production, fallback to dev repo paths)
    let mut script_path = None;
    if let Ok(base_dir) = app.path().resource_dir() {
        let candidate = base_dir
            .join("python_embedded")
            .join("register_ecp_file_association.ps1");
        if candidate.exists() {
            script_path = Some(candidate);
        }
    }
    if script_path.is_none() {
        if let Ok(base_dir) = app.path().resource_dir() {
            let candidate = base_dir
                .join("_up_")
                .join("python_embedded")
                .join("register_ecp_file_association.ps1");
            if candidate.exists() {
                script_path = Some(candidate);
            }
        }
    }
    if script_path.is_none() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidate = exe_dir
                .join("python_embedded")
                .join("register_ecp_file_association.ps1");
            if candidate.exists() {
                script_path = Some(candidate);
            }
        }
    }
    if script_path.is_none() {
        if let Some(exe_dir) = exe_path.parent() {
            if let Some(parent) = exe_dir.parent() {
                let candidate = parent
                    .join("python_embedded")
                    .join("register_ecp_file_association.ps1");
                if candidate.exists() {
                    script_path = Some(candidate);
                }
            }
        }
    }
    if script_path.is_none() {
        if let Some(exe_dir) = exe_path.parent() {
            if let Some(parent) = exe_dir.parent().and_then(|p| p.parent()) {
                let candidate = parent
                    .join("python_embedded")
                    .join("register_ecp_file_association.ps1");
                if candidate.exists() {
                    script_path = Some(candidate);
                }
            }
        }
    }
    if script_path.is_none() {
        if let Some(exe_dir) = exe_path.parent() {
            if let Some(parent) = exe_dir
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
            {
                let candidate = parent
                    .join("python_embedded")
                    .join("register_ecp_file_association.ps1");
                if candidate.exists() {
                    script_path = Some(candidate);
                }
            }
        }
    }
    if script_path.is_none() {
        if let Ok(cwd) = std::env::current_dir() {
            let candidate = cwd
                .join("python_embedded")
                .join("register_ecp_file_association.ps1");
            if candidate.exists() {
                script_path = Some(candidate);
            }
        }
    }
    if script_path.is_none() {
        if let Ok(cwd) = std::env::current_dir() {
            if let Some(parent) = cwd.parent() {
                let candidate = parent
                    .join("python_embedded")
                    .join("register_ecp_file_association.ps1");
                if candidate.exists() {
                    script_path = Some(candidate);
                }
            }
        }
    }
    if script_path.is_none() {
        if let Ok(cwd) = std::env::current_dir() {
            if let Some(parent) = cwd.parent().and_then(|p| p.parent()) {
                let candidate = parent
                    .join("python_embedded")
                    .join("register_ecp_file_association.ps1");
                if candidate.exists() {
                    script_path = Some(candidate);
                }
            }
        }
    }

    let script_path = script_path.ok_or_else(|| {
        "File association script not found (checked resource_dir, exe_dir, cwd, and parent dirs)".to_string()
    })?;

    log::info!("Running file association script: {:?}", script_path);

    let script_path_str = script_path.to_string_lossy().to_string();
    let output = Command::new("powershell")
        .args(&[
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path_str,
            "-ExePathOverride",
            &exe_path_str,
            "-Silent",
        ])
        .output()
        .map_err(|e| format!("Failed to run file association script: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!(".ecp file association failed: {}", stderr);
        return Err(format!("File association failed: {}", stderr));
    }

    // Verify registry values (HKCU)
    let ext_output = Command::new("reg")
        .args(&["query", "HKCU\\Software\\Classes\\.ecp", "/ve"])
        .output()
        .map_err(|e| format!("Failed to query .ecp association: {}", e))?;

    let cmd_output = Command::new("reg")
        .args(&[
            "query",
            "HKCU\\Software\\Classes\\easyCris.Project\\shell\\open\\command",
            "/ve",
        ])
        .output()
        .map_err(|e| format!("Failed to query open command: {}", e))?;

    let ext_stdout = String::from_utf8_lossy(&ext_output.stdout);
    let cmd_stdout = String::from_utf8_lossy(&cmd_output.stdout);
    let ext_ok = ext_output.status.success() && ext_stdout.contains("easyCris.Project");
    let cmd_ok = cmd_output.status.success()
        && cmd_stdout.contains(&exe_path_str)
        && cmd_stdout.contains("%1");

    if !ext_ok || !cmd_ok {
        log::error!(
            ".ecp association verification failed. ext_ok={}, cmd_ok={}",
            ext_ok,
            cmd_ok
        );
        return Err("File association verification failed".to_string());
    }

    log::info!(".ecp file association completed successfully");
    Ok("File association enabled successfully".to_string())
}

#[cfg(not(windows))]
#[tauri::command]
async fn enable_ecp_file_association(_app: AppHandle) -> Result<String, String> {
    Err(".ecp file association is only available on Windows".to_string())
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    // Input validation
    if let Err(e) = validate_string_input(name, 100, "Name") {
        log::warn!("Invalid greet input: {e}");
        return format!("Error: {e}");
    }

    log::info!("Greeting user: {name}");
    format!("Hello, {name}! You've been greeted from Rust!")
}

// Preferences data structure
// Only contains settings that should be persisted to disk
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppPreferences {
    pub theme: String,
    // OLE integration settings (Windows only)
    #[serde(default)]
    pub ole_integration_prompted: bool,
    #[serde(default)]
    pub ole_integration_enabled: bool,
    // Add new persistent preferences here, e.g.:
    // pub auto_save: bool,
    // pub language: String,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            ole_integration_prompted: false,
            ole_integration_enabled: false,
            // Add defaults for new preferences here
        }
    }
}

fn get_preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    // Ensure the directory exists
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {e}"))?;

    Ok(app_data_dir.join("preferences.json"))
}

#[tauri::command]
async fn load_preferences(app: AppHandle) -> Result<AppPreferences, String> {
    log::debug!("Loading preferences from disk");
    let prefs_path = get_preferences_path(&app)?;

    if !prefs_path.exists() {
        log::info!("Preferences file not found, using defaults");
        return Ok(AppPreferences::default());
    }

    let contents = std::fs::read_to_string(&prefs_path).map_err(|e| {
        log::error!("Failed to read preferences file: {e}");
        format!("Failed to read preferences file: {e}")
    })?;

    let preferences: AppPreferences = serde_json::from_str(&contents).map_err(|e| {
        log::error!("Failed to parse preferences JSON: {e}");
        format!("Failed to parse preferences: {e}")
    })?;

    log::info!("Successfully loaded preferences");
    Ok(preferences)
}

#[tauri::command]
async fn save_preferences(app: AppHandle, preferences: AppPreferences) -> Result<(), String> {
    // Validate theme value
    validate_theme(&preferences.theme)?;

    log::debug!("Saving preferences to disk: {preferences:?}");
    let prefs_path = get_preferences_path(&app)?;

    let json_content = serde_json::to_string_pretty(&preferences).map_err(|e| {
        log::error!("Failed to serialize preferences: {e}");
        format!("Failed to serialize preferences: {e}")
    })?;

    // Write to a temporary file first, then rename (atomic operation)
    let temp_path = prefs_path.with_extension("tmp");

    std::fs::write(&temp_path, json_content).map_err(|e| {
        log::error!("Failed to write preferences file: {e}");
        format!("Failed to write preferences file: {e}")
    })?;

    std::fs::rename(&temp_path, &prefs_path).map_err(|e| {
        log::error!("Failed to finalize preferences file: {e}");
        format!("Failed to finalize preferences file: {e}")
    })?;

    log::info!("Successfully saved preferences to {prefs_path:?}");
    Ok(())
}

#[tauri::command]
async fn send_native_notification(
    app: AppHandle,
    title: String,
    body: Option<String>,
) -> Result<(), String> {
    log::info!("Sending native notification: {title}");

    #[cfg(not(mobile))]
    {
        use tauri_plugin_notification::NotificationExt;

        let mut notification = app.notification().builder().title(title);

        if let Some(body_text) = body {
            notification = notification.body(body_text);
        }

        match notification.show() {
            Ok(_) => {
                log::info!("Native notification sent successfully");
                Ok(())
            }
            Err(e) => {
                log::error!("Failed to send native notification: {e}");
                Err(format!("Failed to send notification: {e}"))
            }
        }
    }

    #[cfg(mobile)]
    {
        log::warn!("Native notifications not supported on mobile");
        Err("Native notifications not supported on mobile".to_string())
    }
}

// Recovery functions - simple pattern for saving JSON data to disk
fn get_recovery_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let recovery_dir = app_data_dir.join("recovery");

    // Ensure the recovery directory exists
    std::fs::create_dir_all(&recovery_dir)
        .map_err(|e| format!("Failed to create recovery directory: {e}"))?;

    Ok(recovery_dir)
}

#[tauri::command]
async fn save_emergency_data(app: AppHandle, filename: String, data: Value) -> Result<(), String> {
    log::info!("Saving emergency data to file: {filename}");

    // Validate filename with proper security checks
    validate_filename(&filename)?;

    // Validate data size (10MB limit)
    let data_str = serde_json::to_string(&data)
        .map_err(|e| format!("Failed to serialize data for size check: {e}"))?;
    if data_str.len() > 10_485_760 {
        return Err("Data too large (max 10MB)".to_string());
    }

    let recovery_dir = get_recovery_dir(&app)?;
    let file_path = recovery_dir.join(format!("{filename}.json"));

    let json_content = serde_json::to_string_pretty(&data).map_err(|e| {
        log::error!("Failed to serialize emergency data: {e}");
        format!("Failed to serialize data: {e}")
    })?;

    // Write to a temporary file first, then rename (atomic operation)
    let temp_path = file_path.with_extension("tmp");

    std::fs::write(&temp_path, json_content).map_err(|e| {
        log::error!("Failed to write emergency data file: {e}");
        format!("Failed to write data file: {e}")
    })?;

    std::fs::rename(&temp_path, &file_path).map_err(|e| {
        log::error!("Failed to finalize emergency data file: {e}");
        format!("Failed to finalize data file: {e}")
    })?;

    log::info!("Successfully saved emergency data to {file_path:?}");
    Ok(())
}

#[tauri::command]
async fn load_emergency_data(app: AppHandle, filename: String) -> Result<Value, String> {
    log::info!("Loading emergency data from file: {filename}");

    // Validate filename with proper security checks
    validate_filename(&filename)?;

    let recovery_dir = get_recovery_dir(&app)?;
    let file_path = recovery_dir.join(format!("{filename}.json"));

    if !file_path.exists() {
        log::info!("Recovery file not found: {file_path:?}");
        return Err("File not found".to_string());
    }

    let contents = std::fs::read_to_string(&file_path).map_err(|e| {
        log::error!("Failed to read recovery file: {e}");
        format!("Failed to read file: {e}")
    })?;

    let data: Value = serde_json::from_str(&contents).map_err(|e| {
        log::error!("Failed to parse recovery JSON: {e}");
        format!("Failed to parse data: {e}")
    })?;

    log::info!("Successfully loaded emergency data");
    Ok(data)
}

#[tauri::command]
async fn cleanup_old_recovery_files(app: AppHandle) -> Result<u32, String> {
    log::info!("Cleaning up old recovery files");

    let recovery_dir = get_recovery_dir(&app)?;
    let mut removed_count = 0;

    // Calculate cutoff time (7 days ago)
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get current time: {e}"))?
        .as_secs();
    let seven_days_ago = now - (7 * 24 * 60 * 60);

    // Read directory and check each file
    let entries = std::fs::read_dir(&recovery_dir).map_err(|e| {
        log::error!("Failed to read recovery directory: {e}");
        format!("Failed to read directory: {e}")
    })?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!("Failed to read directory entry: {e}");
                continue;
            }
        };

        let path = entry.path();

        // Only process JSON files
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }

        // Check file modification time
        let metadata = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("Failed to get file metadata: {e}");
                continue;
            }
        };

        let modified = match metadata.modified() {
            Ok(m) => m,
            Err(e) => {
                log::warn!("Failed to get file modification time: {e}");
                continue;
            }
        };

        let modified_secs = match modified.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs(),
            Err(e) => {
                log::warn!("Failed to convert modification time: {e}");
                continue;
            }
        };

        // Remove if older than 7 days
        if modified_secs < seven_days_ago {
            match std::fs::remove_file(&path) {
                Ok(_) => {
                    log::info!("Removed old recovery file: {path:?}");
                    removed_count += 1;
                }
                Err(e) => {
                    log::warn!("Failed to remove old recovery file: {e}");
                }
            }
        }
    }

    log::info!("Cleanup complete. Removed {removed_count} old recovery files");
    Ok(removed_count)
}

// Create the native menu system
#[allow(dead_code)]
fn create_app_menu(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    log::info!("Setting up native menu system");

    // Build the main application submenu
    let app_submenu = SubmenuBuilder::new(app, "Tauri Template")
        .item(&MenuItemBuilder::with_id("about", "About Tauri Template").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("check-updates", "Check for Updates...").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("preferences", "Preferences...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("Hide Tauri Template"))?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit Tauri Template"))?)
        .build()?;

    // Build the View submenu
    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("toggle-left-sidebar", "Toggle Left Sidebar")
                .accelerator("CmdOrCtrl+1")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle-right-sidebar", "Toggle Right Sidebar")
                .accelerator("CmdOrCtrl+2")
                .build(app)?,
        )
        .build()?;

    // Build the main menu with submenus
    let menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&view_submenu)
        .build()?;

    // Set the menu for the app
    app.set_menu(menu)?;

    log::info!("Native menu system initialized successfully");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Make Rust panics more diagnosable in dev builds.
    // (No effect in release builds where panic=abort, but still useful for local debugging.)
    std::env::set_var("RUST_BACKTRACE", "1");

    tauri::Builder::default()
        // Part 3: Close confirmation - intercept close request and delegate to frontend
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // If frontend confirmed close, allow this request to proceed once.
                if ALLOW_APP_CLOSE.swap(false, Ordering::SeqCst) {
                    return;
                }
                // Prevent immediate close so frontend can show confirmation dialog
                api.prevent_close();
                // Emit event to frontend to handle unsaved changes prompt
                let _ = window.emit("app-before-close", ());
            }
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = argv.iter().find(|arg| arg.to_lowercase().ends_with(".ecp")) {
                if let Ok(mut pending) = PENDING_OPEN_PROJECT.lock() {
                    *pending = Some(path.to_string());
                }
                let _ = app.emit("open-project-file", path.clone());
            }
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                // Use Debug level in development, Info in production
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .targets([
                    // Always log to stdout for development
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    // Log to webview console for development
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                    // Persist logs to a file on disk (useful when the app exits/crashes and the webview console misses it).
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("easycris.log".to_string()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        // Note: notification plugin already registered above (line 405)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            log::info!("🚀 Application starting up");
            log::debug!(
                "App handle initialized for package: {}",
                app.package_info().name
            );

            // Initialize Formualizer built-in functions (Phase 6 - Backend Formulas)
            // This must be called once at startup so SUM, AVERAGE, VLOOKUP, etc. are registered.
            formualizer_eval::builtins::load_builtins();
            log::debug!("Formualizer built-in functions loaded");

            // Write panics to the log directory so we can diagnose hard shutdowns that don't surface in the webview.
            if let Ok(mut log_dir) = app.path().app_log_dir() {
                let _ = std::fs::create_dir_all(&log_dir);
                log_dir.push("easycris-panic.log");
                std::panic::set_hook(Box::new(move |panic_info| {
                    let payload = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
                        *s
                    } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
                        s.as_str()
                    } else {
                        "unknown panic payload"
                    };
                    let location = panic_info
                        .location()
                        .map(|l| format!("{}:{}", l.file(), l.line()))
                        .unwrap_or_else(|| "unknown location".to_string());

                    let message = format!(
                        "[PANIC] {location}\n{payload}\n\n{:#?}\n\n",
                        std::backtrace::Backtrace::capture()
                    );

                    log::error!("{message}");
                    let _ = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&log_dir)
                        .and_then(|mut f| std::io::Write::write_all(&mut f, message.as_bytes()));
                }));
            } else {
                log::warn!("Unable to resolve app_log_dir for panic logging");
            }

            // Explicitly set the main window icon at runtime. This helps avoid
            // cases where Windows may temporarily fall back to a generic icon
            // after long-running sessions or heavy resource usage.
            // Using 256x256 (128x128@2x.png) for proper Windows 11 taskbar support.
            if let Some(main_window) = app.get_webview_window("main") {
                // Decode PNG icon using the image crate, then convert to raw RGBA for Tauri
                let icon_bytes = include_bytes!("../icons/128x128@2x.png");
                match image::load_from_memory(icon_bytes) {
                    Ok(img) => {
                        let (width, height) = img.dimensions();
                        let rgba = img.into_rgba8().into_raw();
                        let icon = Image::new_owned(rgba, width, height);
                        if let Err(e) = main_window.set_icon(icon) {
                            log::warn!("Failed to set main window icon: {e}");
                        } else {
                            log::debug!("Main window icon set successfully ({}x{})", width, height);
                        }
                    }
                    Err(e) => {
                        log::warn!("Failed to decode icon image: {e}");
                    }
                }
            } else {
                log::warn!("Main window not found when attempting to set icon");
            }

            // Handle command-line arguments
            let args: Vec<String> = std::env::args().collect();

            // Helper to normalize/validate .ecp arguments
            let normalize_ecp = |raw: &str| {
                let cleaned = raw.trim_matches('"');
                if cleaned.to_lowercase().ends_with(".ecp") {
                    Some(cleaned.to_string())
                } else {
                    None
                }
            };

            // Support both `/ole <path>` and `/ole=<path>` (or `-ole`)
            let ole_arg = args
                .iter()
                .enumerate()
                .find_map(|(idx, arg)| {
                    let lower = arg.to_lowercase();
                    if lower == "/ole" || lower == "-ole" {
                        args.get(idx + 1).map(|next| next.as_str())
                    } else if lower.starts_with("/ole=") {
                        Some(&arg[5..arg.len()])
                    } else if lower.starts_with("-ole=") {
                        Some(&arg[5..arg.len()])
                    } else {
                        None
                    }
                })
                .and_then(|raw| normalize_ecp(raw));

            // Fallback: any .ecp argument on the command line
            let cli_ecp = args.iter().find_map(|arg| normalize_ecp(arg));

            if let Some(ecp_path) = ole_arg.or(cli_ecp) {
                log::info!("Opening project via CLI/OLE activation: {}", ecp_path);
                if std::path::Path::new(&ecp_path).exists() {
                    if let Ok(mut pending) = PENDING_OPEN_PROJECT.lock() {
                        *pending = Some(ecp_path.clone());
                    }
                    let _ = app.emit("open-project-file", ecp_path.clone());
                } else {
                    log::error!("Project file not found: {}", ecp_path);
                    // TODO: show an error dialog
                }
            }

            // Native menu disabled for a cleaner UI (custom title bar handles actions).

            // Example of different log levels
            log::trace!("This is a trace message (most verbose)");
            log::debug!("This is a debug message (development only)");
            log::info!("This is an info message (production)");
            log::warn!("This is a warning message");
            // log::error!("This is an error message");

            // Phase 5: Start auto-flush background task for DuckDB overlay
            // Flushes overlay every 5 minutes if non-empty (prevents data loss on crash)
            modules::hybrid_cache_manager::spawn_auto_flush_task();
            // Run cache reconcile/eviction asynchronously to avoid blocking startup.
            modules::hybrid_cache_manager::spawn_startup_cache_maintenance_task();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            desktop_auth_start,
            desktop_auth_poll,
            desktop_auth_validate_session,
            desktop_auth_refresh_session,
            desktop_auth_revoke_session,
            desktop_auth_store_session_token,
            desktop_auth_load_session_token,
            desktop_auth_clear_session_token,
            check_ole_registration,
            get_office_bitness,
            enable_ole_registration,
            enable_ecp_file_association,
            take_pending_open_project,
            allow_app_close,
            is_auto_update_disabled,
            load_preferences,
            save_preferences,
            send_native_notification,
            save_emergency_data,
            load_emergency_data,
            cleanup_old_recovery_files,
            // Generic statistical test dispatcher (Phase 4 Fix - all 26 tests)
            run_statistical_test,
            prewarm_statistics_backend,
            run_rnaseq_analysis,
            get_available_tests,
            is_valid_test,
            // Plot backend commands (trendlines, etc.)
            run_plot_backend,
            copy_plot_ole, // OLE clipboard (Windows-only embedded plot objects)
            // Legacy parametric commands (kept for backwards compatibility)
            run_independent_ttest,
            run_paired_ttest,
            run_one_way_anova,
            run_descriptive_stats,
            // Data import commands (Phase 3C)
            import_csv,
            import_tsv,
            import_excel,
            import_parquet,
            update_dataset_metadata,
            // Data export commands (Phase 4 Milestone 2 & 6)
            export_results_excel,
            export_results_csv,
            export_results_html,
            export_results_json,
            export_data_csv,
            export_data_excel,
            export_data_excel_multi,
            // Arrow IPC commands (Phase 4 Milestone 2B)
            write_arrow_dataset,
            read_arrow_file,
            delete_arrow_file,
            get_arrow_metadata,
            // Cache sync commands (Phase 4 Milestone 3)
            set_dataset_cache,
            update_cell,
            update_cells_batch,
            add_column,
            insert_row_at,
            remove_row_at,
            remove_column,
            create_empty_duckdb,
            get_column_data,
            get_columns_data,
            get_columns_sampled_data,
            get_columns_aggregated_data,
            search_columns_values,
            flush_dataset_to_arrow,
            has_cached_dataset,
            get_cached_row_count,
            get_rows, // Streaming row provider (Phase 5)
            remove_dataset_cache,
            remove_dataset_cache_with_project,
            clear_all_cache,
            clear_current_project_cache,
            clear_unsaved_app_cache,
            clear_all_app_cache,
            get_cache_health_summary,
            // Hybrid cache commands (Phase 5 - DuckDB for large datasets)
            is_large_dataset,
            get_dataset_storage_info,
            get_aggregates_for_test,
            ensure_duckdb_dataset,
            flush_overlay,
            get_sorted_row_indices,
            get_grouped_row_order,
            get_lazy_group_metadata,
            get_group_rows,
            import_large_csv,
            import_large_parquet,
            // Phase 4: Project-scoped imports (collision prevention)
            import_large_csv_with_project,
            import_large_parquet_with_project,
            set_project_data_dir,
            // Phase B: Project namespacing for dataset isolation
            set_active_project_id,
            get_active_project_id,
            clear_active_project_id,
            bundle_dataset_data_file,
            path_exists,
            path_exists_file,
            path_exists_dir,
            finalize_bundled_dataset_file,
            set_dataset_hybrid,
            get_rows_hybrid,
            get_column_data_hybrid,
            update_cell_hybrid,
            flush_to_arrow_hybrid,
            export_columns_to_arrow_hybrid,
            remove_dataset_hybrid,
            get_row_count_hybrid,
            // Async aggregate formula support (Phase 5.2)
            get_column_aggregate,
            get_column_aggregate_range,
            get_column_aggregate_rows,
            get_overlay_size,
            get_all_column_stats,
            get_column_duplicate_summary,
            // Project persistence fix (Phase 1)
            register_existing_duckdb,
            // Backend formula evaluation (Phase 6)
            evaluate_formula_backend,
            // Utility: execute custom python scripts (PPTX export, etc.)
            #[cfg(debug_assertions)]
            execute_python_script,
            // Sample datasets (bundled CSVs)
            get_sample_datasets,
            read_sample_dataset_preview,
            resolve_sample_dataset_path,
            // Project management commands (Phase 4 Milestone 4)
            save_project,
            load_project,
            get_recent_projects,
            add_recent_project,
            remove_recent_project,
            check_project_file_exists,
            create_new_project,
            has_unsaved_changes,
            get_autosave_path,
            clear_autosave,
            check_recovery_file,
            // Undo/Redo commands (Phase 4 Milestone 5)
            push_cell_edit,
            push_batch_cell_edit,
            push_column_rename,
            push_row_insert,
            push_column_insert,
            perform_undo,
            perform_redo,
            get_undo_redo_state,
            clear_undo_history,
            clear_all_undo_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
