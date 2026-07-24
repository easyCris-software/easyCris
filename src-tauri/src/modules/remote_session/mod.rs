pub mod audio_capture;
pub mod capture;
pub mod input;
pub mod mic_capture;
pub mod signaling;
pub mod state;
pub mod types;

use tauri::{AppHandle, State};

use audio_capture::NativeAudioCaptureStartResult;
use capture::{NativeCaptureOptions, NativeCaptureStartResult};
pub use state::{validate_key_event, validate_mouse_event, RemoteSessionState};
pub use types::{
    RemoteControlPermission, RemoteGuestRejection, RemoteInputKeyEvent, RemoteInputMouseEvent,
    RemoteInputMouseResult, RemoteKeyAction, RemoteMouseAction, RemoteSessionIdentity,
    RemoteSessionInvite, RemoteSessionJoinRequest, RemoteSessionMode, RemoteSessionStartResult,
    RemoteSessionStatus,
};

#[tauri::command]
pub async fn start_remote_session(
    state: State<'_, RemoteSessionState>,
    host_identity: RemoteSessionIdentity,
) -> Result<RemoteSessionStartResult, String> {
    state.start(host_identity).await
}

#[tauri::command]
pub async fn start_cloud_remote_session(
    state: State<'_, RemoteSessionState>,
    host_identity: RemoteSessionIdentity,
    invite: RemoteSessionInvite,
) -> Result<RemoteSessionStartResult, String> {
    state.start_cloud(host_identity, invite).await
}

#[tauri::command]
pub async fn stop_remote_session(
    state: State<'_, RemoteSessionState>,
) -> Result<RemoteSessionStatus, String> {
    Ok(state.stop().await)
}

#[tauri::command]
pub async fn start_native_screen_capture(
    window: tauri::Window,
    state: State<'_, RemoteSessionState>,
    max_width: u32,
    max_height: u32,
    max_fps: u32,
    on_frame: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<NativeCaptureStartResult, String> {
    let geometry = native_capture_geometry(&window)?;
    let result = state
        .start_native_capture(
            NativeCaptureOptions {
                max_width,
                max_height,
                max_fps,
                window_hwnd: geometry.window_hwnd,
            },
            on_frame,
        )
        .await?;
    #[cfg(all(windows, feature = "native-capture-window"))]
    {
        let surface = match validated_native_share_surface(
            geometry.window_hwnd,
            geometry.capture_rect,
            &result,
            max_width,
            max_height,
        ) {
            Ok(surface) => surface,
            Err(error) => {
                let _ = state.stop_native_capture(result.capture_id.clone()).await;
                return Err(error);
            }
        };
        state.set_validated_capture_surface(surface).await;
    };
    #[cfg(not(all(windows, feature = "native-capture-window")))]
    {
        state.set_capture_rect(geometry.capture_rect).await;
    }
    Ok(result)
}

#[tauri::command]
pub async fn stop_native_screen_capture(
    state: State<'_, RemoteSessionState>,
    capture_id: String,
) -> Result<(), String> {
    state.stop_native_capture(capture_id).await
}

#[tauri::command]
pub async fn start_e2e_native_audio_capture(
    state: State<'_, RemoteSessionState>,
    frequency_hz: f32,
    on_audio: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<NativeAudioCaptureStartResult, String> {
    state
        .start_e2e_native_audio_capture(frequency_hz, on_audio)
        .await
}

#[tauri::command]
pub async fn stop_e2e_native_audio_capture(
    state: State<'_, RemoteSessionState>,
    capture_id: String,
) -> Result<(), String> {
    state.stop_e2e_native_audio_capture(capture_id).await
}

#[tauri::command]
pub async fn start_native_mic_capture(
    state: State<'_, RemoteSessionState>,
    on_audio: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<NativeAudioCaptureStartResult, String> {
    state.start_native_mic_capture(on_audio).await
}

#[tauri::command]
pub async fn stop_native_mic_capture(
    state: State<'_, RemoteSessionState>,
    capture_id: String,
) -> Result<(), String> {
    state.stop_native_mic_capture(capture_id).await
}

#[tauri::command]
pub async fn capture_native_window_screenshot(
    window: tauri::Window,
    output_path: String,
) -> Result<capture::NativeWindowScreenshotResult, String> {
    let geometry = native_capture_geometry(&window)?;
    let hwnd = geometry.window_hwnd.ok_or_else(|| {
        "Native window screenshot requires the easyCris window handle".to_string()
    })?;
    let capture =
        capture::start_native_window_png_capture(hwnd, std::path::Path::new(&output_path))?;
    tokio::task::spawn_blocking(move || capture.wait())
        .await
        .map_err(|error| format!("Native window screenshot task failed: {error}"))?
}

#[tauri::command]
pub async fn set_e2e_remote_capture_rect(
    window: tauri::Window,
    state: State<'_, RemoteSessionState>,
) -> Result<(), String> {
    let capture_rect = input::screen_rect_from_window(&window)?;
    state.set_capture_rect(capture_rect).await;
    Ok(())
}

async fn remote_input_surface_rect(
    window: &tauri::Window,
    state: &RemoteSessionState,
    allow_stale_validated_surface: bool,
) -> Result<input::ScreenRect, String> {
    match state.validated_capture_surface().await {
        Ok(surface) if allow_stale_validated_surface => validated_input_rect(&surface),
        Ok(surface) => validated_current_input_surface_rect(window, state, &surface).await,
        Err(_) => state.capture_rect().await,
    }
}

fn validated_input_rect(
    surface: &state::ValidatedCaptureSurface,
) -> Result<input::ScreenRect, String> {
    Ok(surface.screen_rect)
}

fn mouse_input_allows_stale_surface(event: &RemoteInputMouseEvent) -> bool {
    event.action == RemoteMouseAction::Up
}

fn key_input_requires_fresh_surface(event: &RemoteInputKeyEvent) -> bool {
    event.action != RemoteKeyAction::Up
}

async fn validated_current_input_surface_rect(
    window: &tauri::Window,
    state: &RemoteSessionState,
    surface: &state::ValidatedCaptureSurface,
) -> Result<input::ScreenRect, String> {
    #[cfg(all(windows, feature = "native-capture-window"))]
    {
        let hwnd = window
            .hwnd()
            .map_err(|error| format!("Failed to get HWND for remote input: {error}"))?;
        let raw = hwnd.0 as isize;
        validate_easycris_window_hwnd(raw)?;
        let current_rect = even_align_capture_rect(native_client_screen_rect_from_hwnd(raw)?)?;
        let refreshed = refresh_native_input_surface_current(surface, Some(raw), current_rect)?;
        if refreshed.screen_rect != surface.screen_rect
            || refreshed.validated_at_unix_ms != surface.validated_at_unix_ms
        {
            state.set_validated_capture_surface(refreshed.clone()).await;
        }
        return validated_input_rect(&refreshed);
    }

    #[cfg(not(all(windows, feature = "native-capture-window")))]
    {
        let _ = window;
        let _ = state;
        Ok(surface.screen_rect)
    }
}

#[derive(Debug, Clone, Copy)]
struct NativeCaptureGeometry {
    window_hwnd: Option<isize>,
    capture_rect: input::ScreenRect,
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn validated_native_share_surface(
    window_hwnd: Option<isize>,
    screen_rect: input::ScreenRect,
    start_result: &NativeCaptureStartResult,
    max_width: u32,
    max_height: u32,
) -> Result<state::ValidatedCaptureSurface, String> {
    let hwnd = window_hwnd
        .filter(|hwnd| *hwnd != 0)
        .ok_or_else(|| capture::NATIVE_SHARE_SURFACE_VALIDATION_ERROR.to_string())?;
    if start_result.surface_kind != capture::NATIVE_CAPTURE_SURFACE_KIND_EASYCRIS_WINDOW {
        return Err(capture::NATIVE_SHARE_SURFACE_VALIDATION_ERROR.to_string());
    }
    if start_result.frame_width < 320 || start_result.frame_height < 200 {
        return Err(capture::NATIVE_SHARE_SURFACE_VALIDATION_ERROR.to_string());
    }
    let expected_dimensions = u32::try_from(screen_rect.width)
        .ok()
        .and_then(|width| {
            u32::try_from(screen_rect.height).ok().and_then(|height| {
                capture::native_surface_frame_dimensions(width, height, max_width, max_height)
            })
        })
        .ok_or_else(|| capture::NATIVE_SHARE_SURFACE_VALIDATION_ERROR.to_string())?;
    if (start_result.frame_width, start_result.frame_height) != expected_dimensions {
        return Err(capture::NATIVE_SHARE_SURFACE_VALIDATION_ERROR.to_string());
    }
    Ok(state::ValidatedCaptureSurface {
        surface_kind: start_result.surface_kind.clone(),
        frame_width: start_result.frame_width,
        frame_height: start_result.frame_height,
        screen_rect,
        window_hwnd: Some(hwnd),
        validated_at_unix_ms: current_unix_ms(),
    })
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn refresh_native_input_surface_current(
    surface: &state::ValidatedCaptureSurface,
    current_hwnd: Option<isize>,
    current_screen_rect: input::ScreenRect,
) -> Result<state::ValidatedCaptureSurface, String> {
    if surface.surface_kind != capture::NATIVE_CAPTURE_SURFACE_KIND_EASYCRIS_WINDOW {
        return Err("Remote input surface is not a validated easyCris window".to_string());
    }
    if surface.window_hwnd != current_hwnd {
        return Err(
            "Remote input window changed; restart remote sharing to continue control".to_string(),
        );
    }
    if surface.screen_rect == current_screen_rect {
        return Ok(surface.clone());
    }
    let mut refreshed = surface.clone();
    refreshed.screen_rect = current_screen_rect;
    refreshed.validated_at_unix_ms = current_unix_ms();
    Ok(refreshed)
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn current_unix_ms() -> u64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
        Err(error) => {
            log::warn!("Native capture validation timestamp is before UNIX epoch: {error}");
            0
        }
    }
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn native_capture_geometry(window: &tauri::Window) -> Result<NativeCaptureGeometry, String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Failed to get easyCris window handle: {error}"))?;
    let raw = hwnd.0 as isize;
    validate_easycris_window_hwnd(raw)?;

    Ok(NativeCaptureGeometry {
        window_hwnd: Some(raw),
        capture_rect: even_align_capture_rect(native_client_screen_rect_from_hwnd(raw)?)?,
    })
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn native_client_screen_rect_from_hwnd(raw: isize) -> Result<input::ScreenRect, String> {
    input::client_screen_rect_from_hwnd(raw)
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn validate_easycris_window_hwnd(raw: isize) -> Result<(), String> {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible},
    };

    if raw == 0 {
        return Err("Native capture requires a valid easyCris window handle".to_string());
    }
    let hwnd = HWND(raw as *mut std::ffi::c_void);
    unsafe {
        if !IsWindow(hwnd).as_bool() {
            return Err("Native capture requires an existing easyCris window".to_string());
        }
        if !IsWindowVisible(hwnd).as_bool() {
            return Err("Native capture requires the easyCris window to be visible".to_string());
        }
        if IsIconic(hwnd).as_bool() {
            return Err("Native capture requires the easyCris window to be restored".to_string());
        }
        let mut process_id = 0_u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id != std::process::id() {
            return Err(
                "Native capture requires a window owned by this easyCris process".to_string(),
            );
        }
    }
    Ok(())
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn even_align_capture_rect(rect: input::ScreenRect) -> Result<input::ScreenRect, String> {
    let width = encoder_align_down(rect.width);
    let height = encoder_align_down(rect.height);
    if width <= 0 || height <= 0 {
        return Err("easyCris window capture area is too small for native capture".to_string());
    }
    Ok(input::ScreenRect {
        left: rect.left,
        top: rect.top,
        width,
        height,
    })
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn encoder_align_down(value: i32) -> i32 {
    if value >= 8 {
        value - value.rem_euclid(8)
    } else {
        even_align_down(value)
    }
}

#[cfg(not(all(windows, feature = "native-capture-window")))]
fn native_capture_geometry(_window: &tauri::Window) -> Result<NativeCaptureGeometry, String> {
    Ok(NativeCaptureGeometry {
        window_hwnd: None,
        capture_rect: input::ScreenRect {
            left: 0,
            top: 0,
            width: 1,
            height: 1,
        },
    })
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn even_align_down(value: i32) -> i32 {
    value - value.rem_euclid(2)
}

#[cfg(all(test, windows))]
mod tests {
    use super::input::ScreenRect;
    #[cfg(feature = "native-capture-window")]
    use super::{capture, state::ValidatedCaptureSurface, NativeCaptureStartResult};

    #[cfg(feature = "native-capture-window")]
    fn valid_native_start_result() -> NativeCaptureStartResult {
        NativeCaptureStartResult {
            capture_id: "capture-1".to_string(),
            frame_width: 1280,
            frame_height: 720,
            surface_kind: capture::NATIVE_CAPTURE_SURFACE_KIND_EASYCRIS_WINDOW.to_string(),
        }
    }

    #[cfg(feature = "native-capture-window")]
    #[test]
    fn validated_native_share_surface_accepts_easycris_window_contract() {
        let screen_rect = ScreenRect {
            left: 100,
            top: 120,
            width: 1280,
            height: 720,
        };

        let surface = super::validated_native_share_surface(
            Some(44),
            screen_rect,
            &valid_native_start_result(),
            1920,
            1080,
        )
        .unwrap();

        assert_eq!(
            surface,
            ValidatedCaptureSurface {
                surface_kind: capture::NATIVE_CAPTURE_SURFACE_KIND_EASYCRIS_WINDOW.to_string(),
                frame_width: 1280,
                frame_height: 720,
                screen_rect,
                window_hwnd: Some(44),
                validated_at_unix_ms: surface.validated_at_unix_ms,
            }
        );
        assert!(surface.validated_at_unix_ms > 0);
    }

    #[cfg(feature = "native-capture-window")]
    #[test]
    fn validated_native_share_surface_rejects_missing_or_invalid_contract() {
        let screen_rect = ScreenRect {
            left: 100,
            top: 120,
            width: 1280,
            height: 720,
        };

        assert!(super::validated_native_share_surface(
            None,
            screen_rect,
            &valid_native_start_result(),
            1920,
            1080
        )
        .is_err());

        let mut wrong_kind = valid_native_start_result();
        wrong_kind.surface_kind = "display".to_string();
        assert!(super::validated_native_share_surface(
            Some(44),
            screen_rect,
            &wrong_kind,
            1920,
            1080
        )
        .is_err());

        let mut too_small = valid_native_start_result();
        too_small.frame_width = 319;
        assert!(super::validated_native_share_surface(
            Some(44),
            screen_rect,
            &too_small,
            1920,
            1080
        )
        .is_err());
    }

    #[cfg(feature = "native-capture-window")]
    #[test]
    fn validated_native_share_surface_rejects_frame_dimensions_that_do_not_match_surface() {
        let screen_rect = ScreenRect {
            left: 100,
            top: 120,
            width: 1280,
            height: 720,
        };
        let mut mismatched = valid_native_start_result();
        mismatched.frame_width = 1248;

        assert!(super::validated_native_share_surface(
            Some(44),
            screen_rect,
            &mismatched,
            1920,
            1080
        )
        .is_err());

        let mut height_mismatched = valid_native_start_result();
        height_mismatched.frame_height = 704;

        assert!(super::validated_native_share_surface(
            Some(44),
            screen_rect,
            &height_mismatched,
            1920,
            1080
        )
        .is_err());
    }

    #[cfg(feature = "native-capture-window")]
    #[test]
    fn native_input_surface_refreshes_moved_window_but_rejects_replaced_window() {
        let surface = ValidatedCaptureSurface {
            surface_kind: capture::NATIVE_CAPTURE_SURFACE_KIND_EASYCRIS_WINDOW.to_string(),
            frame_width: 1280,
            frame_height: 720,
            screen_rect: ScreenRect {
                left: 100,
                top: 120,
                width: 1280,
                height: 720,
            },
            window_hwnd: Some(44),
            validated_at_unix_ms: 1234,
        };

        assert_eq!(
            super::refresh_native_input_surface_current(&surface, Some(44), surface.screen_rect)
                .unwrap(),
            surface
        );
        assert!(super::refresh_native_input_surface_current(
            &surface,
            Some(45),
            surface.screen_rect
        )
        .is_err());
        let moved = super::refresh_native_input_surface_current(
            &surface,
            Some(44),
            ScreenRect {
                left: 101,
                ..surface.screen_rect
            },
        )
        .unwrap();
        assert_eq!(
            moved.screen_rect,
            ScreenRect {
                left: 101,
                ..surface.screen_rect
            }
        );
        assert_eq!(moved.window_hwnd, surface.window_hwnd);
        assert_eq!(moved.frame_width, surface.frame_width);
        assert_eq!(moved.frame_height, surface.frame_height);
    }

    #[test]
    fn release_input_does_not_require_fresh_surface_validation() {
        assert!(super::mouse_input_allows_stale_surface(
            &super::RemoteInputMouseEvent {
                session_id: "session-1".to_string(),
                guest_device_id: "guest-1".to_string(),
                normalized_x: 0.5,
                normalized_y: 0.5,
                source_width: 100,
                source_height: 100,
                target_left: None,
                target_top: None,
                target_width: None,
                target_height: None,
                action: super::RemoteMouseAction::Up,
                button: Some(super::types::RemoteMouseButton::Left),
                modifiers: super::types::RemoteInputModifiers::default(),
                wheel_delta_x: None,
                wheel_delta_y: None,
            }
        ));
        assert!(!super::mouse_input_allows_stale_surface(
            &super::RemoteInputMouseEvent {
                session_id: "session-1".to_string(),
                guest_device_id: "guest-1".to_string(),
                normalized_x: 0.5,
                normalized_y: 0.5,
                source_width: 100,
                source_height: 100,
                target_left: None,
                target_top: None,
                target_width: None,
                target_height: None,
                action: super::RemoteMouseAction::Down,
                button: Some(super::types::RemoteMouseButton::Left),
                modifiers: super::types::RemoteInputModifiers::default(),
                wheel_delta_x: None,
                wheel_delta_y: None,
            }
        ));
        assert!(!super::key_input_requires_fresh_surface(
            &super::RemoteInputKeyEvent {
                session_id: "session-1".to_string(),
                guest_device_id: "guest-1".to_string(),
                key: super::types::RemoteKey::Named(super::types::RemoteNamedKey::Enter),
                action: super::RemoteKeyAction::Up,
                modifiers: super::types::RemoteInputModifiers::default(),
            }
        ));
        assert!(super::key_input_requires_fresh_surface(
            &super::RemoteInputKeyEvent {
                session_id: "session-1".to_string(),
                guest_device_id: "guest-1".to_string(),
                key: super::types::RemoteKey::Named(super::types::RemoteNamedKey::Enter),
                action: super::RemoteKeyAction::Down,
                modifiers: super::types::RemoteInputModifiers::default(),
            }
        ));
    }
}

#[tauri::command]
pub async fn get_remote_session_status(
    state: State<'_, RemoteSessionState>,
) -> Result<RemoteSessionStatus, String> {
    Ok(state.status().await)
}

#[tauri::command]
pub async fn set_remote_session_pending_guest(
    state: State<'_, RemoteSessionState>,
    guest: RemoteSessionJoinRequest,
) -> Result<RemoteSessionStatus, String> {
    state.set_pending_guest(guest).await
}

#[tauri::command]
pub async fn approve_remote_session_guest(
    app: AppHandle,
    state: State<'_, RemoteSessionState>,
    permission: RemoteControlPermission,
) -> Result<RemoteSessionStatus, String> {
    state.approve_guest_with_app(Some(app), permission).await
}

#[tauri::command]
pub async fn reject_remote_session_guest(
    state: State<'_, RemoteSessionState>,
    rejection: RemoteGuestRejection,
) -> Result<RemoteSessionStatus, String> {
    state.reject_guest(rejection).await
}

#[tauri::command]
pub async fn revoke_remote_control(
    state: State<'_, RemoteSessionState>,
    session_id: String,
    reason: Option<String>,
) -> Result<RemoteSessionStatus, String> {
    state.revoke_control(session_id, reason).await
}

#[tauri::command]
pub async fn remote_input_mouse_event(
    window: tauri::Window,
    state: State<'_, RemoteSessionState>,
    event: RemoteInputMouseEvent,
) -> Result<RemoteInputMouseResult, String> {
    validate_mouse_event(&event)?;
    state.ensure_mouse_allowed(&event).await?;
    let capture_rect =
        remote_input_surface_rect(&window, &state, mouse_input_allows_stale_surface(&event))
            .await?;
    let remote_input = state.remote_input_handle().await?;
    // Non-move input may spend up to roughly 500ms foregrounding WebView2 on Windows.
    tokio::task::spawn_blocking(move || {
        input::inject_mouse_event(&window, &event, &capture_rect, &remote_input)
    })
    .await
    .map_err(|error| format!("Remote mouse input worker failed: {error}"))?
}

#[tauri::command]
pub async fn remote_input_key_event(
    window: tauri::Window,
    state: State<'_, RemoteSessionState>,
    event: RemoteInputKeyEvent,
) -> Result<(), String> {
    validate_key_event(&event)?;
    state.ensure_key_allowed(&event).await?;
    if key_input_requires_fresh_surface(&event) {
        let _ = remote_input_surface_rect(&window, &state, false).await?;
    }
    let remote_input = state.remote_input_handle().await?;
    // Keyboard input shares the same bounded foregrounding path as mouse input.
    tokio::task::spawn_blocking(move || input::inject_key_event(&window, &event, &remote_input))
        .await
        .map_err(|error| format!("Remote key input worker failed: {error}"))?
}

#[tauri::command]
pub async fn set_remote_window_capture_exclusion(
    window: tauri::Window,
    excluded: bool,
) -> Result<(), String> {
    set_window_capture_exclusion(&window, excluded)
}

#[cfg(windows)]
fn set_window_capture_exclusion(window: &tauri::Window, excluded: bool) -> Result<(), String> {
    use std::ffi::c_void;

    const WDA_NONE: u32 = 0x0;
    const WDA_EXCLUDEFROMCAPTURE: u32 = 0x11;

    #[link(name = "user32")]
    extern "system" {
        fn SetWindowDisplayAffinity(hwnd: *mut c_void, affinity: u32) -> i32;
    }

    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Failed to get window handle: {error}"))?;
    let affinity = if excluded {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };
    let ok = unsafe { SetWindowDisplayAffinity(hwnd.0, affinity) };
    if ok == 0 {
        return Err("Failed to update remote-session capture exclusion".to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_window_capture_exclusion(_window: &tauri::Window, _excluded: bool) -> Result<(), String> {
    Ok(())
}
