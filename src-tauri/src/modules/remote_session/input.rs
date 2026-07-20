use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, MutexGuard,
};
use std::time::{Duration, Instant};

use super::types::{
    RemoteInputKeyEvent, RemoteInputModifiers, RemoteInputMouseEvent, RemoteInputMouseResult,
    RemoteKey, RemoteKeyAction, RemoteMouseAction, RemoteMouseButton, RemoteNamedKey,
};

const RECENT_FOCUS_WINDOW: Duration = Duration::from_millis(750);

static LAST_REMOTE_INPUT_FOCUS: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MouseFocusRequirement {
    None,
    BestEffortIfStale,
    Required,
}

#[derive(Clone)]
pub struct RemoteInputHandle {
    enigo: Arc<Mutex<Enigo>>,
    active: Arc<AtomicBool>,
}

impl std::fmt::Debug for RemoteInputHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("RemoteInputHandle")
            .field(&"<Enigo>")
            .finish()
    }
}

impl RemoteInputHandle {
    pub fn new() -> Result<Self, String> {
        let enigo = Enigo::new(&Settings::default())
            .map_err(|error| format!("Could not initialize remote input: {error:?}"))?;
        Ok(Self {
            enigo: Arc::new(Mutex::new(enigo)),
            active: Arc::new(AtomicBool::new(true)),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Enigo>, String> {
        self.ensure_active()?;
        self.enigo
            .lock()
            .map_err(|_| "Remote input state is unavailable".to_string())
    }

    fn ensure_active(&self) -> Result<(), String> {
        if self.active.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err("Remote session is not active".to_string())
        }
    }

    pub(in crate::modules::remote_session) fn deactivate(&self) {
        self.active.store(false, Ordering::Release);
    }

    #[cfg(test)]
    pub fn ptr_eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.enigo, &other.enigo) && Arc::ptr_eq(&self.active, &other.active)
    }

    #[cfg(test)]
    pub fn can_lock_for_test(&self) -> Result<(), String> {
        drop(self.lock()?);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenRect {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

pub fn screen_rect_from_physical_rect(
    left: i32,
    top: i32,
    width: u32,
    height: u32,
) -> Result<ScreenRect, String> {
    let width = i32::try_from(width)
        .map_err(|_| "easyCris window width is too large for remote input".to_string())?;
    let height = i32::try_from(height)
        .map_err(|_| "easyCris window height is too large for remote input".to_string())?;

    if width <= 0 || height <= 0 {
        return Err("easyCris window size is not valid for remote input".to_string());
    }

    Ok(ScreenRect {
        left,
        top,
        width,
        height,
    })
}

pub fn screen_rect_from_window(window: &tauri::Window) -> Result<ScreenRect, String> {
    let position = window
        .inner_position()
        .map_err(|error| format!("Could not read easyCris window position: {error}"))?;
    let size = window
        .inner_size()
        .map_err(|error| format!("Could not read easyCris window size: {error}"))?;

    screen_rect_from_physical_rect(position.x, position.y, size.width, size.height)
}

#[cfg(all(windows, feature = "native-capture-window"))]
pub(in crate::modules::remote_session) fn client_screen_rect_from_hwnd(
    raw: isize,
) -> Result<ScreenRect, String> {
    use std::ffi::c_void;
    use windows::Win32::{
        Foundation::{HWND, POINT, RECT},
        Graphics::Gdi::ClientToScreen,
        UI::WindowsAndMessaging::GetClientRect,
    };

    if raw == 0 {
        return Err("easyCris window handle is not valid for remote input".to_string());
    }

    let hwnd = HWND(raw as *mut c_void);
    let mut client_rect = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client_rect) }
        .map_err(|error| format!("Could not read easyCris client rect: {error}"))?;
    if client_rect.right <= client_rect.left || client_rect.bottom <= client_rect.top {
        return Err("easyCris client area is not valid for remote input".to_string());
    }

    let mut upper_left = POINT {
        x: client_rect.left,
        y: client_rect.top,
    };
    let mut lower_right = POINT {
        x: client_rect.right,
        y: client_rect.bottom,
    };
    if !unsafe { ClientToScreen(hwnd, &mut upper_left) }.as_bool() {
        return Err("Could not map easyCris client origin to screen".to_string());
    }
    if !unsafe { ClientToScreen(hwnd, &mut lower_right) }.as_bool() {
        return Err("Could not map easyCris client bounds to screen".to_string());
    }

    let width = lower_right
        .x
        .checked_sub(upper_left.x)
        .ok_or_else(|| "easyCris client width is invalid for remote input".to_string())?;
    let height = lower_right
        .y
        .checked_sub(upper_left.y)
        .ok_or_else(|| "easyCris client height is invalid for remote input".to_string())?;
    if width <= 0 || height <= 0 {
        return Err("easyCris client area is not valid for remote input".to_string());
    }

    Ok(ScreenRect {
        left: upper_left.x,
        top: upper_left.y,
        width,
        height,
    })
}

pub fn map_mouse_to_screen(
    event: &RemoteInputMouseEvent,
    capture_rect: &ScreenRect,
) -> Result<(i32, i32), String> {
    let outside =
        !(0.0..=1.0).contains(&event.normalized_x) || !(0.0..=1.0).contains(&event.normalized_y);
    if outside
        && !matches!(
            event.action,
            RemoteMouseAction::Move | RemoteMouseAction::Up
        )
    {
        return Err("Remote input is outside the easyCris capture surface".to_string());
    }

    let max_x = capture_rect.left + capture_rect.width - 1;
    let max_y = capture_rect.top + capture_rect.height - 1;
    let x = capture_rect.left + (event.normalized_x * f64::from(capture_rect.width)).round() as i32;
    let y = capture_rect.top + (event.normalized_y * f64::from(capture_rect.height)).round() as i32;

    Ok((
        x.clamp(capture_rect.left, max_x),
        y.clamp(capture_rect.top, max_y),
    ))
}

pub fn inject_mouse_event(
    window: &tauri::Window,
    event: &RemoteInputMouseEvent,
    capture_rect: &ScreenRect,
    remote_input: &RemoteInputHandle,
) -> Result<RemoteInputMouseResult, String> {
    let (screen_x, screen_y) = map_mouse_to_screen(event, capture_rect)?;
    ensure_screen_point_in_bounds(screen_x, screen_y)?;

    match mouse_focus_requirement(&event.action) {
        MouseFocusRequirement::None => {}
        MouseFocusRequirement::BestEffortIfStale => {
            focus_window_for_remote_mouse_input_if_stale(window);
        }
        MouseFocusRequirement::Required => {
            focus_window_for_remote_input(window)?;
        }
    }

    let mut enigo = remote_input.lock()?;
    enigo
        .move_mouse(screen_x, screen_y, Coordinate::Abs)
        .map_err(input_error)?;

    match event.action {
        RemoteMouseAction::Move => Ok(()),
        RemoteMouseAction::Down => enigo
            .button(required_button(event)?, Direction::Press)
            .map_err(input_error),
        RemoteMouseAction::Up => enigo
            .button(required_button(event)?, Direction::Release)
            .map_err(input_error),
        RemoteMouseAction::Click => enigo
            .button(required_button(event)?, Direction::Click)
            .map_err(input_error),
        RemoteMouseAction::Wheel => {
            let vertical = wheel_steps(event.wheel_delta_y);
            let horizontal = wheel_steps(event.wheel_delta_x);
            if vertical != 0 {
                enigo
                    .scroll(vertical, Axis::Vertical)
                    .map_err(input_error)?;
            }
            if horizontal != 0 {
                enigo
                    .scroll(horizontal, Axis::Horizontal)
                    .map_err(input_error)?;
            }
            Ok(())
        }
    }?;

    Ok(RemoteInputMouseResult {
        screen_x,
        screen_y,
        rect_left: capture_rect.left,
        rect_top: capture_rect.top,
        rect_width: capture_rect.width,
        rect_height: capture_rect.height,
    })
}

fn mouse_focus_requirement(action: &RemoteMouseAction) -> MouseFocusRequirement {
    match action {
        RemoteMouseAction::Click | RemoteMouseAction::Down => MouseFocusRequirement::Required,
        RemoteMouseAction::Wheel => MouseFocusRequirement::BestEffortIfStale,
        RemoteMouseAction::Move | RemoteMouseAction::Up => MouseFocusRequirement::None,
    }
}

fn has_recent_remote_input_focus(last_focus: Option<Instant>) -> bool {
    last_focus.is_some_and(|last_focus| last_focus.elapsed() <= RECENT_FOCUS_WINDOW)
}

fn foreground_snapshot_matches_target(
    target_hwnd_addr: isize,
    foreground_hwnd_addr: isize,
    foreground_root_hwnd_addr: isize,
) -> bool {
    foreground_hwnd_addr == target_hwnd_addr || foreground_root_hwnd_addr == target_hwnd_addr
}

fn focus_window_for_remote_input_if_stale(window: &tauri::Window) -> Result<(), String> {
    if LAST_REMOTE_INPUT_FOCUS
        .lock()
        .ok()
        .and_then(|last_focus| *last_focus)
        .is_some_and(|last_focus| has_recent_remote_input_focus(Some(last_focus)))
    {
        return Ok(());
    }

    focus_window_for_remote_input(window)
}

fn focus_window_for_remote_mouse_input_if_stale(window: &tauri::Window) {
    if LAST_REMOTE_INPUT_FOCUS
        .lock()
        .ok()
        .and_then(|last_focus| *last_focus)
        .is_some_and(|last_focus| has_recent_remote_input_focus(Some(last_focus)))
    {
        return;
    }
    focus_window_for_remote_mouse_input(window);
}

fn focus_window_for_remote_mouse_input(window: &tauri::Window) {
    if let Err(error) = focus_window_for_remote_input(window) {
        log::warn!("Remote mouse input: continuing after focus failure: {error}");
    }
}

fn remember_remote_input_focus() {
    if let Ok(mut last_focus) = LAST_REMOTE_INPUT_FOCUS.lock() {
        *last_focus = Some(Instant::now());
    }
}

#[cfg(windows)]
fn focus_window_for_remote_input(window: &tauri::Window) -> Result<(), String> {
    use std::ffi::c_void;
    use std::sync::mpsc;

    const FOCUS_TIMEOUT: Duration = Duration::from_millis(500);
    const FOCUS_POLL_INTERVAL: Duration = Duration::from_millis(20);
    const FOCUS_RECV_HEADROOM: Duration = Duration::from_millis(200);
    const FOCUS_CONFIRMED_SETTLE: Duration = Duration::from_millis(20);
    const GA_ROOT: u32 = 2; // GetAncestor: root owner/top-level window.
    const INPUT_KEYBOARD: u32 = 1; // Win32 INPUT_KEYBOARD.
    const KEYEVENTF_KEYUP: u32 = 0x0002; // Win32 KEYEVENTF_KEYUP.
    const VK_MENU: u16 = 0x12; // Win32 virtual-key code for ALT.

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MouseInput {
        dx: i32,
        dy: i32,
        mouse_data: u32,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct KeyboardInput {
        vk: u16,
        scan: u16,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct HardwareInput {
        message: u32,
        param_l: u16,
        param_h: u16,
    }

    #[repr(C)]
    union InputValue {
        mouse: MouseInput,
        keyboard: KeyboardInput,
        hardware: HardwareInput,
    }

    #[repr(C)]
    struct Input {
        kind: u32,
        value: InputValue,
    }

    #[derive(Clone, Copy)]
    struct FocusAttempt {
        alt_result: u32,
        allow_result: i32,
        bring_result: i32,
        foreground_result: i32,
    }

    #[derive(Clone, Copy)]
    struct ForegroundSnapshot {
        foreground_addr: isize,
        root_addr: isize,
    }

    #[link(name = "user32")]
    extern "system" {
        fn AllowSetForegroundWindow(process_id: u32) -> i32;
        fn BringWindowToTop(hwnd: *mut c_void) -> i32;
        fn GetAncestor(hwnd: *mut c_void, ga_flags: u32) -> *mut c_void;
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(hwnd: *mut c_void, process_id: *mut u32) -> u32;
        fn SendInput(input_count: u32, inputs: *const Input, input_size: i32) -> u32;
        fn SetForegroundWindow(hwnd: *mut c_void) -> i32;
    }

    fn alt_input(flags: u32) -> Input {
        Input {
            kind: INPUT_KEYBOARD,
            value: InputValue {
                keyboard: KeyboardInput {
                    vk: VK_MENU,
                    scan: 0,
                    flags,
                    time: 0,
                    extra_info: 0,
                },
            },
        }
    }

    fn capture_foreground_snapshot(foreground: *mut c_void) -> ForegroundSnapshot {
        // GetForegroundWindow and GetAncestor are read-only Win32 query APIs;
        // keep them off the UI thread so focus messages can continue pumping.
        let root = if foreground.is_null() {
            std::ptr::null_mut()
        } else {
            unsafe { GetAncestor(foreground, GA_ROOT) }
        };
        ForegroundSnapshot {
            foreground_addr: foreground as isize,
            root_addr: root as isize,
        }
    }

    fn foreground_process_id(foreground_addr: isize) -> u32 {
        let foreground = foreground_addr as *mut c_void;
        let mut foreground_process_id = 0_u32;
        if !foreground.is_null() {
            unsafe {
                GetWindowThreadProcessId(foreground, &mut foreground_process_id);
            }
        }
        foreground_process_id
    }

    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Failed to get HWND for remote input: {error}"))?;
    let hwnd_addr = hwnd.0 as isize;
    let initial_snapshot = capture_foreground_snapshot(unsafe { GetForegroundWindow() });
    if foreground_snapshot_matches_target(
        hwnd_addr,
        initial_snapshot.foreground_addr,
        initial_snapshot.root_addr,
    ) {
        remember_remote_input_focus();
        return Ok(());
    }

    let process_id = std::process::id();
    let (sender, receiver) = mpsc::channel();

    window
        .run_on_main_thread(move || {
            let hwnd = hwnd_addr as *mut c_void;
            let alt_inputs = [alt_input(0), alt_input(KEYEVENTF_KEYUP)];
            let alt_result = unsafe {
                SendInput(
                    alt_inputs.len() as u32,
                    alt_inputs.as_ptr(),
                    std::mem::size_of::<Input>() as i32,
                )
            };
            // Windows allows SetForegroundWindow when the caller received the
            // last input event. A synthetic ALT tap is the least invasive way
            // to unlock that path before remote mouse input reaches WebView2.
            if alt_result != alt_inputs.len() as u32 {
                log::warn!(
                    "Remote input: ALT foreground unlock input inserted {} of {} events",
                    alt_result,
                    alt_inputs.len()
                );
            }

            let allow_result = unsafe { AllowSetForegroundWindow(process_id) };
            if allow_result == 0 {
                log::debug!("Remote input: AllowSetForegroundWindow failed");
            }
            let bring_result = unsafe { BringWindowToTop(hwnd) };
            if bring_result == 0 {
                log::debug!("Remote input: BringWindowToTop failed");
            }
            let foreground_result = unsafe { SetForegroundWindow(hwnd) };
            if foreground_result == 0 {
                log::debug!("Remote input: SetForegroundWindow failed");
            }

            let _ = sender.send(FocusAttempt {
                alt_result,
                allow_result,
                bring_result,
                foreground_result,
            });
        })
        .map_err(|error| format!("Could not schedule easyCris focus for remote input: {error}"))?;

    let attempt = receiver
        .recv_timeout(FOCUS_TIMEOUT + FOCUS_RECV_HEADROOM)
        .map_err(|_| "Timed out foregrounding easyCris window for remote input".to_string())?;

    let deadline = Instant::now() + FOCUS_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            let snapshot = capture_foreground_snapshot(unsafe { GetForegroundWindow() });
            if foreground_snapshot_matches_target(
                hwnd_addr,
                snapshot.foreground_addr,
                snapshot.root_addr,
            ) {
                break;
            }
            let foreground_process_id = foreground_process_id(snapshot.foreground_addr);
            return Err(format!(
                "Timed out confirming easyCris foreground for remote input. target_hwnd={:?}, foreground_hwnd={:?}, foreground_root={:?}, target_pid={}, foreground_pid={}, alt_result={}, allow_result={}, bring_result={}, foreground_result={}",
                hwnd_addr as *mut c_void,
                snapshot.foreground_addr as *mut c_void,
                snapshot.root_addr as *mut c_void,
                process_id,
                foreground_process_id,
                attempt.alt_result,
                attempt.allow_result,
                attempt.bring_result,
                attempt.foreground_result
            ));
        }

        let snapshot = capture_foreground_snapshot(unsafe { GetForegroundWindow() });
        if foreground_snapshot_matches_target(
            hwnd_addr,
            snapshot.foreground_addr,
            snapshot.root_addr,
        ) {
            break;
        }
        std::thread::sleep(FOCUS_POLL_INTERVAL);
    }
    std::thread::sleep(FOCUS_CONFIRMED_SETTLE);
    remember_remote_input_focus();

    Ok(())
}

#[cfg(not(windows))]
fn focus_window_for_remote_input(window: &tauri::Window) -> Result<(), String> {
    window
        .set_focus()
        .map_err(|error| format!("Could not focus easyCris window for remote input: {error}"))?;
    remember_remote_input_focus();
    Ok(())
}

pub fn inject_key_event(
    window: &tauri::Window,
    event: &RemoteInputKeyEvent,
    remote_input: &RemoteInputHandle,
) -> Result<(), String> {
    focus_window_for_remote_input_if_stale(window)?;
    if key_event_uses_temporary_enigo(event) {
        remote_input.ensure_active()?;
        let mut enigo = new_enigo()?;
        return with_modifiers(&mut enigo, &event.modifiers, |enigo| {
            enigo
                .key(remote_key(&event.key)?, key_direction(&event.action))
                .map_err(input_error)
        });
    }
    let mut enigo = remote_input.lock()?;
    enigo
        .key(remote_key(&event.key)?, key_direction(&event.action))
        .map_err(input_error)
}

fn new_enigo() -> Result<Enigo, String> {
    Enigo::new(&Settings::default())
        .map_err(|error| format!("Could not initialize remote input: {error:?}"))
}

fn has_modifiers(modifiers: &RemoteInputModifiers) -> bool {
    modifiers.ctrl || modifiers.shift || modifiers.alt || modifiers.meta
}

fn key_event_uses_temporary_enigo(event: &RemoteInputKeyEvent) -> bool {
    has_modifiers(&event.modifiers)
}

fn required_button(event: &RemoteInputMouseEvent) -> Result<Button, String> {
    event
        .button
        .as_ref()
        .map(mouse_button)
        .ok_or_else(|| "Remote mouse button is required for this action".to_string())
}

fn mouse_button(button: &RemoteMouseButton) -> Button {
    match button {
        RemoteMouseButton::Left => Button::Left,
        RemoteMouseButton::Right => Button::Right,
        RemoteMouseButton::Middle => Button::Middle,
    }
}

fn key_direction(action: &RemoteKeyAction) -> Direction {
    match action {
        RemoteKeyAction::Down => Direction::Press,
        RemoteKeyAction::Up => Direction::Release,
        RemoteKeyAction::Click => Direction::Click,
    }
}

fn remote_key(key: &RemoteKey) -> Result<Key, String> {
    match key {
        RemoteKey::Character(value) => value
            .chars()
            .next()
            .map(Key::Unicode)
            .ok_or_else(|| "Remote character key is empty".to_string()),
        RemoteKey::Named(named) => Ok(match named {
            RemoteNamedKey::Enter => Key::Return,
            RemoteNamedKey::Escape => Key::Escape,
            RemoteNamedKey::Tab => Key::Tab,
            RemoteNamedKey::Backspace => Key::Backspace,
            RemoteNamedKey::Delete => Key::Delete,
            RemoteNamedKey::Space => Key::Space,
            RemoteNamedKey::ArrowUp => Key::UpArrow,
            RemoteNamedKey::ArrowDown => Key::DownArrow,
            RemoteNamedKey::ArrowLeft => Key::LeftArrow,
            RemoteNamedKey::ArrowRight => Key::RightArrow,
        }),
    }
}

fn with_modifiers<F>(
    enigo: &mut Enigo,
    modifiers: &RemoteInputModifiers,
    action: F,
) -> Result<(), String>
where
    F: FnOnce(&mut Enigo) -> Result<(), String>,
{
    let pressed = press_modifiers(enigo, modifiers)?;
    let result = action(enigo);
    let release_result = release_modifiers(enigo, &pressed);
    match (result, release_result) {
        (Err(action_error), _) => Err(action_error),
        (Ok(()), Err(release_error)) => Err(release_error),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn press_modifiers(
    enigo: &mut Enigo,
    modifiers: &RemoteInputModifiers,
) -> Result<Vec<Key>, String> {
    let mut pressed = Vec::new();
    if modifiers.ctrl {
        press_modifier(enigo, Key::Control, &mut pressed)?;
    }
    if modifiers.shift {
        press_modifier(enigo, Key::Shift, &mut pressed)?;
    }
    if modifiers.alt {
        press_modifier(enigo, Key::Alt, &mut pressed)?;
    }
    if modifiers.meta {
        press_modifier(enigo, Key::Meta, &mut pressed)?;
    }
    Ok(pressed)
}

fn press_modifier(enigo: &mut Enigo, key: Key, pressed: &mut Vec<Key>) -> Result<(), String> {
    if let Err(error) = enigo.key(key, Direction::Press).map_err(input_error) {
        let _ = release_modifiers(enigo, pressed);
        return Err(error);
    }
    pressed.push(key);
    Ok(())
}

fn release_modifiers(enigo: &mut Enigo, pressed: &[Key]) -> Result<(), String> {
    let mut release_error = None;
    for key in pressed.iter().rev().copied() {
        if let Err(error) = enigo.key(key, Direction::Release).map_err(input_error) {
            release_error.get_or_insert(error);
        }
    }
    release_error.map_or(Ok(()), Err)
}

fn wheel_steps(delta: Option<f64>) -> i32 {
    let Some(delta) = delta else {
        return 0;
    };
    if delta == 0.0 || !delta.is_finite() {
        0
    } else {
        let magnitude = (delta.abs() / 100.0).round().clamp(1.0, 12.0) as i32;
        magnitude * delta.signum() as i32
    }
}

fn input_error(error: impl std::fmt::Debug) -> String {
    format!("Remote input failed: {error:?}")
}

#[cfg(windows)]
unsafe extern "system" {
    fn GetSystemMetrics(index: i32) -> i32;
}

#[cfg(windows)]
const WINDOWS_SM_XVIRTUALSCREEN: i32 = 76;
#[cfg(windows)]
const WINDOWS_SM_YVIRTUALSCREEN: i32 = 77;
#[cfg(windows)]
const WINDOWS_SM_CXVIRTUALSCREEN: i32 = 78;
#[cfg(windows)]
const WINDOWS_SM_CYVIRTUALSCREEN: i32 = 79;

#[cfg(windows)]
fn ensure_screen_point_in_bounds(screen_x: i32, screen_y: i32) -> Result<(), String> {
    let origin_x = unsafe { GetSystemMetrics(WINDOWS_SM_XVIRTUALSCREEN) };
    let origin_y = unsafe { GetSystemMetrics(WINDOWS_SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(WINDOWS_SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(WINDOWS_SM_CYVIRTUALSCREEN) };

    if width <= 0 || height <= 0 {
        return Err("Windows virtual desktop size is not valid for remote input".to_string());
    }

    let max_x = origin_x + width - 1;
    let max_y = origin_y + height - 1;
    if screen_x < origin_x || screen_x > max_x || screen_y < origin_y || screen_y > max_y {
        return Err(format!(
            "Remote input mapped outside the visible desktop: point=({screen_x},{screen_y}) bounds=({origin_x},{origin_y})..({max_x},{max_y})"
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn ensure_screen_point_in_bounds(_screen_x: i32, _screen_y: i32) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{screen_rect_from_physical_rect, ScreenRect};
    use crate::modules::remote_session::types::{
        RemoteInputKeyEvent, RemoteInputModifiers, RemoteInputMouseEvent, RemoteKey,
        RemoteKeyAction,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn physical_window_rect_preserves_150_percent_capture_pixels() {
        let rect = screen_rect_from_physical_rect(640, 351, 1350, 1275).unwrap();
        assert_eq!(
            rect,
            ScreenRect {
                left: 640,
                top: 351,
                width: 1350,
                height: 1275
            }
        );
    }

    #[test]
    fn physical_window_rect_rejects_zero_size() {
        assert!(screen_rect_from_physical_rect(0, 0, 0, 1275).is_err());
        assert!(screen_rect_from_physical_rect(0, 0, 1350, 0).is_err());
    }

    #[test]
    fn physical_window_rect_rejects_overflow() {
        assert!(screen_rect_from_physical_rect(0, 0, u32::MAX, 1275).is_err());
        assert!(screen_rect_from_physical_rect(0, 0, 1350, u32::MAX).is_err());
    }

    #[test]
    fn screen_bounds_guard_is_noop_on_valid_points() {
        assert!(super::ensure_screen_point_in_bounds(0, 0).is_ok());
    }

    #[test]
    fn normalized_mouse_coordinates_map_to_capture_rect() {
        let event = mouse_event(0.5, 0.25, super::RemoteMouseAction::Move);
        let rect = ScreenRect {
            left: 100,
            top: 200,
            width: 800,
            height: 600,
        };

        let point = super::map_mouse_to_screen(&event, &rect).unwrap();

        assert_eq!(point, (500, 350));
    }

    #[test]
    fn normalized_mouse_boundary_coordinates_map_to_capture_edges() {
        let rect = ScreenRect {
            left: 100,
            top: 200,
            width: 800,
            height: 600,
        };

        let top_left = super::map_mouse_to_screen(
            &mouse_event(0.0, 0.0, super::RemoteMouseAction::Move),
            &rect,
        )
        .unwrap();
        let bottom_right = super::map_mouse_to_screen(
            &mouse_event(1.0, 1.0, super::RemoteMouseAction::Move),
            &rect,
        )
        .unwrap();

        assert_eq!(top_left, (100, 200));
        assert_eq!(bottom_right, (899, 799));
    }

    #[test]
    fn clipped_capture_rect_maps_input_from_visible_monitor_edge() {
        let rect = ScreenRect {
            left: 1920,
            top: 100,
            width: 280,
            height: 500,
        };

        let point = super::map_mouse_to_screen(
            &mouse_event(0.0, 0.0, super::RemoteMouseAction::Move),
            &rect,
        )
        .unwrap();

        assert_eq!(point, (1920, 100));
    }

    #[test]
    fn down_outside_capture_rect_is_rejected_without_clamping() {
        let event = mouse_event(1.1, 0.5, super::RemoteMouseAction::Down);
        let rect = ScreenRect {
            left: 100,
            top: 200,
            width: 800,
            height: 600,
        };

        let result = super::map_mouse_to_screen(&event, &rect);

        assert_eq!(
            result.unwrap_err(),
            "Remote input is outside the easyCris capture surface"
        );
    }

    #[test]
    fn up_outside_capture_rect_clamps_to_release_pressed_button() {
        let event = mouse_event(1.1, 0.5, super::RemoteMouseAction::Up);
        let rect = ScreenRect {
            left: 100,
            top: 200,
            width: 800,
            height: 600,
        };

        let point = super::map_mouse_to_screen(&event, &rect).unwrap();

        assert_eq!(point, (899, 500));
    }

    #[test]
    fn move_outside_capture_rect_clamps_to_edge() {
        let event = mouse_event(-0.1, 1.1, super::RemoteMouseAction::Move);
        let rect = ScreenRect {
            left: 100,
            top: 200,
            width: 800,
            height: 600,
        };

        let point = super::map_mouse_to_screen(&event, &rect).unwrap();

        assert_eq!(point, (100, 799));
    }

    #[test]
    fn click_outside_capture_rect_is_rejected() {
        let event = mouse_event(1.1, 0.5, super::RemoteMouseAction::Click);
        let rect = ScreenRect {
            left: 100,
            top: 200,
            width: 800,
            height: 600,
        };

        let result = super::map_mouse_to_screen(&event, &rect);

        assert_eq!(
            result.unwrap_err(),
            "Remote input is outside the easyCris capture surface"
        );
    }

    #[test]
    fn wheel_outside_capture_rect_is_rejected() {
        let event = mouse_event(0.5, -0.1, super::RemoteMouseAction::Wheel);
        let rect = ScreenRect {
            left: 100,
            top: 200,
            width: 800,
            height: 600,
        };

        let result = super::map_mouse_to_screen(&event, &rect);

        assert_eq!(
            result.unwrap_err(),
            "Remote input is outside the easyCris capture surface"
        );
    }

    #[test]
    fn modified_key_events_use_temporary_enigo() {
        let mut modifiers = RemoteInputModifiers::default();
        modifiers.ctrl = true;
        let event = key_event(modifiers);

        assert!(super::key_event_uses_temporary_enigo(&event));
    }

    #[test]
    fn unmodified_key_events_use_shared_enigo() {
        let event = key_event(RemoteInputModifiers::default());

        assert!(!super::key_event_uses_temporary_enigo(&event));
    }

    #[test]
    fn mouse_focus_requirement_is_strict_for_pressing_actions() {
        assert_eq!(
            super::mouse_focus_requirement(&super::RemoteMouseAction::Click),
            super::MouseFocusRequirement::Required
        );
        assert_eq!(
            super::mouse_focus_requirement(&super::RemoteMouseAction::Down),
            super::MouseFocusRequirement::Required
        );
        assert_eq!(
            super::mouse_focus_requirement(&super::RemoteMouseAction::Wheel),
            super::MouseFocusRequirement::BestEffortIfStale
        );
        assert_eq!(
            super::mouse_focus_requirement(&super::RemoteMouseAction::Move),
            super::MouseFocusRequirement::None
        );
        assert_eq!(
            super::mouse_focus_requirement(&super::RemoteMouseAction::Up),
            super::MouseFocusRequirement::None
        );
    }

    #[test]
    fn foreground_snapshot_matches_target_or_webview_root() {
        let target_hwnd = 42;

        assert!(super::foreground_snapshot_matches_target(
            target_hwnd,
            target_hwnd,
            0
        ));
        assert!(super::foreground_snapshot_matches_target(
            target_hwnd,
            77,
            target_hwnd
        ));
        assert!(!super::foreground_snapshot_matches_target(
            target_hwnd,
            77,
            88
        ));
    }

    #[test]
    fn recent_focus_cache_only_skips_when_a_confirmed_focus_was_remembered() {
        assert!(!super::has_recent_remote_input_focus(None));
        assert!(super::has_recent_remote_input_focus(Some(Instant::now())));
        assert!(!super::has_recent_remote_input_focus(Some(
            Instant::now() - super::RECENT_FOCUS_WINDOW - Duration::from_millis(1)
        )));
    }

    fn key_event(modifiers: RemoteInputModifiers) -> RemoteInputKeyEvent {
        RemoteInputKeyEvent {
            session_id: "session".to_string(),
            guest_device_id: "guest".to_string(),
            key: RemoteKey::Character("a".to_string()),
            action: RemoteKeyAction::Click,
            modifiers,
        }
    }

    fn mouse_event(
        normalized_x: f64,
        normalized_y: f64,
        action: super::RemoteMouseAction,
    ) -> RemoteInputMouseEvent {
        RemoteInputMouseEvent {
            session_id: "session".to_string(),
            guest_device_id: "guest".to_string(),
            normalized_x,
            normalized_y,
            source_width: 1280,
            source_height: 720,
            target_left: None,
            target_top: None,
            target_width: None,
            target_height: None,
            action,
            button: None,
            modifiers: RemoteInputModifiers::default(),
            wheel_delta_x: None,
            wheel_delta_y: None,
        }
    }
}
