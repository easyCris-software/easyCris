use serde::Serialize;
#[cfg(all(windows, feature = "native-capture-window"))]
use std::time::Duration;

pub const NATIVE_CAPTURE_SURFACE_KIND_EASYCRIS_WINDOW: &str = "easycris-window";
pub const NATIVE_SHARE_SURFACE_VALIDATION_ERROR: &str =
    "Could not verify the selected EasyCris window for remote sharing. Remote session was not started.";

#[cfg(all(windows, feature = "native-capture-window"))]
const MIN_NATIVE_SHARE_FRAME_WIDTH: u32 = 320;
#[cfg(all(windows, feature = "native-capture-window"))]
const MIN_NATIVE_SHARE_FRAME_HEIGHT: u32 = 200;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NativeCaptureStartResult {
    pub capture_id: String,
    pub frame_width: u32,
    pub frame_height: u32,
    pub surface_kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NativeWindowScreenshotResult {
    pub output_path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct NativeCaptureOptions {
    pub max_width: u32,
    pub max_height: u32,
    pub max_fps: u32,
    pub window_hwnd: Option<isize>,
}

pub struct NativeCaptureHandle {
    start_result: NativeCaptureStartResult,
    stop: Option<Box<dyn FnOnce() + Send + 'static>>,
}

impl std::fmt::Debug for NativeCaptureHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeCaptureHandle")
            .field("start_result", &self.start_result)
            .field("stop", &self.stop.as_ref().map(|_| "<stop>"))
            .finish()
    }
}

impl NativeCaptureHandle {
    pub fn capture_id(&self) -> &str {
        &self.start_result.capture_id
    }

    pub fn start_result(&self) -> NativeCaptureStartResult {
        self.start_result.clone()
    }

    pub fn stop(mut self) {
        if let Some(stop) = self.stop.take() {
            stop();
        }
    }
}

#[cfg(all(windows, feature = "native-capture-window"))]
pub fn start_native_capture(
    options: NativeCaptureOptions,
    on_frame: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<NativeCaptureHandle, String> {
    use std::ffi::c_void;
    use std::sync::mpsc;
    use std::time::Duration;
    use uuid::Uuid;
    use windows_capture2::{
        capture::{Context, GraphicsCaptureApiHandler},
        frame::Frame,
        graphics_capture_api::InternalCaptureControl,
        settings::{
            ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
            MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
        },
        window::Window,
    };

    if options.max_width == 0 || options.max_height == 0 {
        return Err("Native capture dimensions must be greater than zero".to_string());
    }
    let hwnd = options
        .window_hwnd
        .ok_or_else(|| "Native window capture requires the easyCris window handle".to_string())?;
    if hwnd == 0 {
        return Err("Native window capture requires a valid easyCris window handle".to_string());
    }
    let (first_frame_tx, first_frame_rx) =
        mpsc::sync_channel::<Result<NativeFirstFrameMetadata, String>>(1);

    struct EasyCrisWindowCaptureHandler {
        on_frame: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
        max_width: u32,
        max_height: u32,
        hwnd: isize,
        scratch: Vec<u8>,
        logged_first_crop: bool,
        first_frame_tx: Option<mpsc::SyncSender<Result<NativeFirstFrameMetadata, String>>>,
    }

    impl GraphicsCaptureApiHandler for EasyCrisWindowCaptureHandler {
        type Flags = (
            tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
            u32,
            u32,
            isize,
            mpsc::SyncSender<Result<NativeFirstFrameMetadata, String>>,
        );
        type Error = String;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            let (on_frame, max_width, max_height, hwnd, first_frame_tx) = ctx.flags;
            Ok(Self {
                on_frame,
                max_width,
                max_height,
                hwnd,
                scratch: Vec::new(),
                logged_first_crop: false,
                first_frame_tx: Some(first_frame_tx),
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            capture_control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            let width = frame.width();
            let height = frame.height();
            if width == 0 || height == 0 {
                return Ok(());
            }
            let crop = match native_client_capture_box_from_hwnd(self.hwnd, width, height) {
                Ok(crop) => crop,
                Err(error) => {
                    log::warn!("Native window capture client frame skipped: {error}");
                    return Ok(());
                }
            };
            if !self.logged_first_crop {
                self.logged_first_crop = true;
                log::info!(
                    "Native window capture client crop: texture={}x{}, frame={}x{}, client={}x{}, crop=({}, {})-({}, {})[{}x{}], right_margin={}",
                    width,
                    height,
                    crop.frame_width,
                    crop.frame_height,
                    crop.client_width,
                    crop.client_height,
                    crop.start_x,
                    crop.start_y,
                    crop.end_x,
                    crop.end_y,
                    crop.end_x.saturating_sub(crop.start_x),
                    crop.end_y.saturating_sub(crop.start_y),
                    width.saturating_sub(crop.end_x),
                );
            }
            let buffer = match frame.buffer_crop(crop.start_x, crop.start_y, crop.end_x, crop.end_y)
            {
                Ok(buffer) => buffer,
                Err(error) => {
                    log::warn!("Native window capture client crop skipped: {error}");
                    return Ok(());
                }
            };
            let width = buffer.width();
            let height = buffer.height();
            if width == 0 || height == 0 {
                return Ok(());
            }
            let data = buffer.as_nopadding_buffer(&mut self.scratch);
            let Some(packet) =
                encode_native_frame(width, height, data, self.max_width, self.max_height)
            else {
                if let Some(tx) = self.first_frame_tx.take() {
                    let _ = tx.send(Err(
                        "Native window capture produced a malformed first frame".to_string(),
                    ));
                    capture_control.stop();
                }
                return Ok(());
            };
            let first_frame = validate_native_first_frame_packet(&packet);
            if let Some(tx) = self.first_frame_tx.take() {
                let should_stop = first_frame.is_err();
                let _ = tx.send(first_frame);
                if should_stop {
                    capture_control.stop();
                    return Ok(());
                }
            }
            if self
                .on_frame
                .send(tauri::ipc::InvokeResponseBody::Raw(packet))
                .is_err()
            {
                capture_control.stop();
            }
            Ok(())
        }

        fn on_closed(&mut self) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    let capture_id = Uuid::new_v4().to_string();
    let capture_window = Window::from_raw_hwnd(hwnd as *mut c_void);
    let settings = Settings::new(
        capture_window,
        CursorCaptureSettings::WithCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Exclude,
        MinimumUpdateIntervalSettings::Custom(Duration::from_millis(
            1_000_u64 / u64::from(options.max_fps.clamp(1, 24)),
        )),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        (
            on_frame,
            options.max_width,
            options.max_height,
            hwnd,
            first_frame_tx,
        ),
    );
    let control = EasyCrisWindowCaptureHandler::start_free_threaded(settings)
        .map_err(|error| format!("Native window capture failed to start: {error}"))?;
    let first_frame = match first_frame_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(first_frame)) => first_frame,
        Ok(Err(error)) => {
            let _ = control.stop();
            return Err(format!("{NATIVE_SHARE_SURFACE_VALIDATION_ERROR} {error}"));
        }
        Err(_) => {
            let _ = control.stop();
            return Err(format!(
                "{NATIVE_SHARE_SURFACE_VALIDATION_ERROR} Native window capture did not produce a valid first frame."
            ));
        }
    };
    let thread_capture_id = capture_id.clone();
    let stop = Box::new(move || {
        let _ = std::thread::Builder::new()
            .name("easycris-native-window-capture-stop".to_string())
            .spawn(move || {
                let _ = control.stop();
                log::debug!("Native window remote capture stopped: {thread_capture_id}");
            });
    });

    Ok(NativeCaptureHandle {
        start_result: NativeCaptureStartResult {
            capture_id,
            frame_width: first_frame.frame_width,
            frame_height: first_frame.frame_height,
            surface_kind: NATIVE_CAPTURE_SURFACE_KIND_EASYCRIS_WINDOW.to_string(),
        },
        stop: Some(stop),
    })
}

#[cfg(not(all(windows, feature = "native-capture-window")))]
pub fn start_native_capture(
    _options: NativeCaptureOptions,
    _on_frame: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<NativeCaptureHandle, String> {
    Err("Native remote capture is not enabled in this build".to_string())
}

#[cfg(all(windows, feature = "native-capture-window"))]
pub fn capture_native_window_png(
    window_hwnd: isize,
    output_path: &std::path::Path,
) -> Result<NativeWindowScreenshotResult, String> {
    start_native_window_png_capture(window_hwnd, output_path)?.wait()
}

#[cfg(all(windows, feature = "native-capture-window"))]
pub struct NativeWindowPngCapture {
    frame_rx: std::sync::mpsc::Receiver<Result<NativeWindowScreenshotResult, String>>,
    control: windows_capture2::capture::CaptureControl<OneShotWindowScreenshotHandler, String>,
}

#[cfg(all(windows, feature = "native-capture-window"))]
impl NativeWindowPngCapture {
    pub fn wait(self) -> Result<NativeWindowScreenshotResult, String> {
        let result = match self
            .frame_rx
            .recv_timeout(std::time::Duration::from_secs(5))
        {
            Ok(result) => result,
            Err(_) => Err("Native window screenshot capture did not produce a frame".to_string()),
        };
        let _ = self.control.stop();
        result
    }
}

#[cfg(all(windows, feature = "native-capture-window"))]
struct OneShotWindowScreenshotHandler {
    hwnd: isize,
    output_path: std::path::PathBuf,
    scratch: Vec<u8>,
    frame_tx: Option<std::sync::mpsc::SyncSender<Result<NativeWindowScreenshotResult, String>>>,
}

#[cfg(all(windows, feature = "native-capture-window"))]
impl OneShotWindowScreenshotHandler {
    fn capture_frame(
        &mut self,
        frame: &mut windows_capture2::frame::Frame,
    ) -> Result<NativeWindowScreenshotResult, String> {
        let texture_width = frame.width();
        let texture_height = frame.height();
        if texture_width == 0 || texture_height == 0 {
            return Err("Native window screenshot frame was empty".to_string());
        }

        let crop = native_client_capture_box_from_hwnd(self.hwnd, texture_width, texture_height)?;
        let buffer = frame
            .buffer_crop(crop.start_x, crop.start_y, crop.end_x, crop.end_y)
            .map_err(|error| format!("Native window screenshot crop failed: {error}"))?;
        let width = buffer.width();
        let height = buffer.height();
        if width == 0 || height == 0 {
            return Err("Native window screenshot crop was empty".to_string());
        }
        let data = buffer.as_nopadding_buffer(&mut self.scratch);
        let pixel_count = usize::try_from(width)
            .ok()
            .and_then(|w| usize::try_from(height).ok().and_then(|h| w.checked_mul(h)))
            .ok_or_else(|| "Native window screenshot dimensions overflowed".to_string())?;
        let expected_len = pixel_count
            .checked_mul(4)
            .ok_or_else(|| "Native window screenshot byte length overflowed".to_string())?;
        if data.len() != expected_len {
            return Err(format!(
                "Native window screenshot buffer length {} does not match {}x{} BGRA length {}",
                data.len(),
                width,
                height,
                expected_len
            ));
        }

        if let Some(parent) = self.output_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Could not create native screenshot directory {}: {error}",
                    parent.display()
                )
            })?;
        }

        let mut rgba = Vec::with_capacity(expected_len);
        for pixel in data.chunks_exact(4) {
            rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
        image::save_buffer_with_format(
            &self.output_path,
            &rgba,
            width,
            height,
            image::ColorType::Rgba8,
            image::ImageFormat::Png,
        )
        .map_err(|error| {
            format!(
                "Could not write native window screenshot {}: {error}",
                self.output_path.display()
            )
        })?;

        Ok(NativeWindowScreenshotResult {
            output_path: self.output_path.to_string_lossy().to_string(),
            width,
            height,
        })
    }
}

#[cfg(all(windows, feature = "native-capture-window"))]
impl windows_capture2::capture::GraphicsCaptureApiHandler for OneShotWindowScreenshotHandler {
    type Flags = (
        isize,
        std::path::PathBuf,
        std::sync::mpsc::SyncSender<Result<NativeWindowScreenshotResult, String>>,
    );
    type Error = String;

    fn new(ctx: windows_capture2::capture::Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (hwnd, output_path, frame_tx) = ctx.flags;
        Ok(Self {
            hwnd,
            output_path,
            scratch: Vec::new(),
            frame_tx: Some(frame_tx),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut windows_capture2::frame::Frame,
        _capture_control: windows_capture2::graphics_capture_api::InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let result = self.capture_frame(frame);
        if let Some(tx) = self.frame_tx.take() {
            let _ = tx.send(result);
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

#[cfg(all(windows, feature = "native-capture-window"))]
pub fn start_native_window_png_capture(
    window_hwnd: isize,
    output_path: &std::path::Path,
) -> Result<NativeWindowPngCapture, String> {
    use std::ffi::c_void;
    use std::sync::mpsc;
    use windows_capture2::{
        capture::GraphicsCaptureApiHandler,
        settings::{
            ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
            MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
        },
        window::Window,
    };

    if window_hwnd == 0 {
        return Err("Native window screenshot requires a valid easyCris window handle".to_string());
    }

    let (frame_tx, frame_rx) =
        mpsc::sync_channel::<Result<NativeWindowScreenshotResult, String>>(1);

    let capture_window = Window::from_raw_hwnd(window_hwnd as *mut c_void);
    let settings = Settings::new(
        capture_window,
        CursorCaptureSettings::WithCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Exclude,
        MinimumUpdateIntervalSettings::Custom(Duration::from_millis(16)),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        (window_hwnd, output_path.to_path_buf(), frame_tx),
    );
    let control = OneShotWindowScreenshotHandler::start_free_threaded(settings)
        .map_err(|error| format!("Native window screenshot capture failed to start: {error}"))?;
    Ok(NativeWindowPngCapture { frame_rx, control })
}

#[cfg(not(all(windows, feature = "native-capture-window")))]
pub fn capture_native_window_png(
    _window_hwnd: isize,
    _output_path: &std::path::Path,
) -> Result<NativeWindowScreenshotResult, String> {
    Err("Native window screenshot capture is not enabled in this build".to_string())
}

#[cfg(not(all(windows, feature = "native-capture-window")))]
pub struct NativeWindowPngCapture;

#[cfg(not(all(windows, feature = "native-capture-window")))]
impl NativeWindowPngCapture {
    pub fn wait(self) -> Result<NativeWindowScreenshotResult, String> {
        Err("Native window screenshot capture is not enabled in this build".to_string())
    }
}

#[cfg(not(all(windows, feature = "native-capture-window")))]
pub fn start_native_window_png_capture(
    _window_hwnd: isize,
    _output_path: &std::path::Path,
) -> Result<NativeWindowPngCapture, String> {
    Err("Native window screenshot capture is not enabled in this build".to_string())
}

#[cfg(all(windows, feature = "native-capture-window"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NativeClientCaptureBox {
    start_x: u32,
    start_y: u32,
    end_x: u32,
    end_y: u32,
    frame_width: u32,
    frame_height: u32,
    client_width: u32,
    client_height: u32,
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn native_client_capture_box_from_hwnd(
    raw: isize,
    texture_width: u32,
    texture_height: u32,
) -> Result<NativeClientCaptureBox, String> {
    use std::ffi::c_void;
    use windows::Win32::{
        Foundation::{HWND, RECT},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
        UI::WindowsAndMessaging::IsIconic,
    };

    if texture_width == 0 || texture_height == 0 {
        return Err("Native window capture frame is empty".to_string());
    }

    let hwnd = HWND(raw as *mut c_void);
    unsafe {
        if IsIconic(hwnd).as_bool() {
            return Err("Native window capture skipped while easyCris is minimized".to_string());
        }
    }

    let mut frame_rect = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut frame_rect as *mut RECT as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    }
    .map_err(|error| format!("Could not read easyCris extended frame bounds: {error}"))?;
    let client_rect = super::input::client_screen_rect_from_hwnd(raw)?;

    native_client_capture_box_from_rects(texture_width, texture_height, frame_rect, client_rect)
        .ok_or_else(|| "Native window capture client box is outside the frame".to_string())
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn native_client_capture_box_from_rects(
    texture_width: u32,
    texture_height: u32,
    frame_rect: windows::Win32::Foundation::RECT,
    client_rect: super::input::ScreenRect,
) -> Option<NativeClientCaptureBox> {
    let frame_width = u32::try_from((frame_rect.right - frame_rect.left).max(0)).ok()?;
    let frame_height = u32::try_from((frame_rect.bottom - frame_rect.top).max(0)).ok()?;
    let start_x = u32::try_from((client_rect.left - frame_rect.left).max(0)).ok()?;
    let start_y = u32::try_from((client_rect.top - frame_rect.top).max(0)).ok()?;
    if start_x >= texture_width || start_y >= texture_height {
        return None;
    }

    let client_width = u32::try_from(client_rect.width).ok()?;
    let client_height = u32::try_from(client_rect.height).ok()?;
    let crop_width = texture_width.checked_sub(start_x)?.min(client_width);
    let crop_height = texture_height.checked_sub(start_y)?.min(client_height);
    if crop_width == 0 || crop_height == 0 {
        return None;
    }

    Some(NativeClientCaptureBox {
        start_x,
        start_y,
        end_x: start_x.checked_add(crop_width)?,
        end_y: start_y.checked_add(crop_height)?,
        frame_width,
        frame_height,
        client_width,
        client_height,
    })
}

#[cfg(all(windows, feature = "native-capture-window"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NativeFirstFrameMetadata {
    frame_width: u32,
    frame_height: u32,
    pixel_format: u32,
}

#[cfg(all(windows, feature = "native-capture-window"))]
const NATIVE_FRAME_FORMAT_BGRA: u32 = 0;

#[cfg(all(windows, feature = "native-capture-window"))]
const NATIVE_FRAME_FORMAT_NV12: u32 = 1;

#[cfg(all(windows, feature = "native-capture-window"))]
fn validate_native_first_frame_packet(packet: &[u8]) -> Result<NativeFirstFrameMetadata, String> {
    if packet.len() <= 16 {
        return Err("Native window capture first frame was empty".to_string());
    }
    let width = u32::from_le_bytes(
        packet[0..4]
            .try_into()
            .map_err(|_| "Native window capture first frame width was invalid".to_string())?,
    );
    let height = u32::from_le_bytes(
        packet[4..8]
            .try_into()
            .map_err(|_| "Native window capture first frame height was invalid".to_string())?,
    );
    let pixel_format = u32::from_le_bytes(
        packet[8..12]
            .try_into()
            .map_err(|_| "Native window capture first frame format was invalid".to_string())?,
    );
    validate_native_first_frame_payload(width, height, pixel_format, packet.len() - 16)
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn validate_native_first_frame_payload(
    frame_width: u32,
    frame_height: u32,
    pixel_format: u32,
    payload_len: usize,
) -> Result<NativeFirstFrameMetadata, String> {
    if frame_width < MIN_NATIVE_SHARE_FRAME_WIDTH || frame_height < MIN_NATIVE_SHARE_FRAME_HEIGHT {
        return Err(format!(
            "Native window capture first frame is too small: {frame_width}x{frame_height}."
        ));
    }
    let pixels = usize::try_from(frame_width)
        .ok()
        .and_then(|width| {
            usize::try_from(frame_height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or_else(|| {
            "Native window capture first frame dimensions overflowed payload validation".to_string()
        })?;
    let expected_len = match pixel_format {
        NATIVE_FRAME_FORMAT_BGRA => pixels.checked_mul(4),
        NATIVE_FRAME_FORMAT_NV12 => {
            if frame_width % 2 != 0 || frame_height % 2 != 0 {
                return Err(format!(
                    "Native window capture first frame used odd NV12 dimensions: {frame_width}x{frame_height}."
                ));
            }
            pixels.checked_mul(3).and_then(|bytes| bytes.checked_div(2))
        }
        _ => {
            return Err(format!(
                "Native window capture first frame used unsupported pixel format {pixel_format}."
            ))
        }
    }
    .ok_or_else(|| {
        "Native window capture first frame dimensions overflowed payload validation".to_string()
    })?;
    if payload_len != expected_len {
        let format_name = native_frame_format_name(pixel_format);
        return Err(format!(
            "Native window capture first frame payload length {payload_len} does not match {frame_width}x{frame_height} {format_name} payload length {expected_len}."
        ));
    }
    Ok(NativeFirstFrameMetadata {
        frame_width,
        frame_height,
        pixel_format,
    })
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn native_frame_format_name(pixel_format: u32) -> &'static str {
    match pixel_format {
        NATIVE_FRAME_FORMAT_BGRA => "BGRA",
        NATIVE_FRAME_FORMAT_NV12 => "NV12",
        _ => "unknown",
    }
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn encode_native_frame(
    width: u32,
    height: u32,
    data: &[u8],
    max_width: u32,
    max_height: u32,
) -> Option<Vec<u8>> {
    let (packet_width, packet_height, frame_data) =
        compact_bgra_frame(width, height, data, max_width, max_height)?;
    let packet_data = bgra_to_nv12(packet_width, packet_height, &frame_data)?;

    let mut packet = Vec::with_capacity(16 + packet_data.len());
    packet.extend_from_slice(&packet_width.to_le_bytes());
    packet.extend_from_slice(&packet_height.to_le_bytes());
    packet.extend_from_slice(&NATIVE_FRAME_FORMAT_NV12.to_le_bytes());
    packet.extend_from_slice(&0_u32.to_le_bytes());
    packet.extend_from_slice(&packet_data);
    Some(packet)
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn compact_bgra_frame(
    width: u32,
    height: u32,
    data: &[u8],
    max_width: u32,
    max_height: u32,
) -> Option<(u32, u32, Vec<u8>)> {
    let source_width = encoder_dimension(width)?;
    let source_height = encoder_dimension(height)?;
    let input_row_bytes = usize::try_from(width).ok()?.checked_mul(4)?;
    let output_row_bytes = usize::try_from(source_width).ok()?.checked_mul(4)?;
    let source_height_usize = usize::try_from(source_height).ok()?;
    let expected_input_bytes = input_row_bytes.checked_mul(usize::try_from(height).ok()?)?;
    if input_row_bytes == 0
        || output_row_bytes == 0
        || source_height_usize == 0
        || data.len() < expected_input_bytes
    {
        return None;
    }

    let frame_data =
        if width == source_width && height == source_height && data.len() == expected_input_bytes {
            data.to_vec()
        } else {
            let stride = if data.len() % usize::try_from(height).ok()? == 0 {
                data.len().checked_div(usize::try_from(height).ok()?)?
            } else {
                input_row_bytes
            };
            if stride < output_row_bytes {
                return None;
            }
            let mut compact =
                Vec::with_capacity(output_row_bytes.checked_mul(source_height_usize)?);
            for row in 0..source_height_usize {
                let start = row.checked_mul(stride)?;
                let end = start.checked_add(output_row_bytes)?;
                compact.extend_from_slice(data.get(start..end)?);
            }
            compact
        };

    scale_bgra_frame(
        source_width,
        source_height,
        frame_data,
        max_width,
        max_height,
    )
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn bgra_to_nv12(width: u32, height: u32, data: &[u8]) -> Option<Vec<u8>> {
    debug_assert_eq!(width % 2, 0);
    debug_assert_eq!(height % 2, 0);

    let width = usize::try_from(width).ok()?;
    let height = usize::try_from(height).ok()?;
    if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
        return None;
    }

    let pixel_count = width.checked_mul(height)?;
    let expected_bgra_len = pixel_count.checked_mul(4)?;
    if data.len() != expected_bgra_len {
        return None;
    }

    let y_len = pixel_count;
    let uv_len = pixel_count.checked_div(2)?;
    let mut output = vec![0_u8; y_len.checked_add(uv_len)?];

    for y in 0..height {
        for x in 0..width {
            let source = (y * width + x) * 4;
            let b = i32::from(data[source]);
            let g = i32::from(data[source + 1]);
            let r = i32::from(data[source + 2]);
            output[y * width + x] = rgb_to_y(r, g, b);
        }
    }

    for y in (0..height).step_by(2) {
        for x in (0..width).step_by(2) {
            let mut r_sum = 0_i32;
            let mut g_sum = 0_i32;
            let mut b_sum = 0_i32;
            for block_y in 0..2 {
                for block_x in 0..2 {
                    let source = ((y + block_y) * width + x + block_x) * 4;
                    b_sum += i32::from(data[source]);
                    g_sum += i32::from(data[source + 1]);
                    r_sum += i32::from(data[source + 2]);
                }
            }
            let r = r_sum / 4;
            let g = g_sum / 4;
            let b = b_sum / 4;
            let uv = y_len + (y / 2) * width + x;
            output[uv] = rgb_to_u(r, g, b);
            output[uv + 1] = rgb_to_v(r, g, b);
        }
    }

    Some(output)
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn clamp_u8(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn rgb_to_y(r: i32, g: i32, b: i32) -> u8 {
    clamp_u8(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16)
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn rgb_to_u(r: i32, g: i32, b: i32) -> u8 {
    clamp_u8(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128)
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn rgb_to_v(r: i32, g: i32, b: i32) -> u8 {
    clamp_u8(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128)
}

#[cfg(all(windows, feature = "native-capture-window"))]
pub(crate) fn native_surface_frame_dimensions(
    surface_width: u32,
    surface_height: u32,
    max_width: u32,
    max_height: u32,
) -> Option<(u32, u32)> {
    let surface_width = encoder_dimension(surface_width)?;
    let surface_height = encoder_dimension(surface_height)?;
    bounded_dimensions(surface_width, surface_height, max_width, max_height)
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn even_dimension(value: u32) -> Option<u32> {
    let even = value - (value % 2);
    (even >= 2).then_some(even)
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn encoder_dimension(value: u32) -> Option<u32> {
    if value >= 8 {
        let aligned = value - (value % 8);
        (aligned >= 8).then_some(aligned)
    } else {
        even_dimension(value)
    }
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn scale_bgra_frame(
    width: u32,
    height: u32,
    data: Vec<u8>,
    max_width: u32,
    max_height: u32,
) -> Option<(u32, u32, Vec<u8>)> {
    let (target_width, target_height) = bounded_dimensions(width, height, max_width, max_height)?;
    if target_width == width && target_height == height {
        return Some((width, height, data));
    }

    let source_width = usize::try_from(width).ok()?;
    let target_width_usize = usize::try_from(target_width).ok()?;
    let target_height_usize = usize::try_from(target_height).ok()?;
    let width_u64 = u64::from(width);
    let height_u64 = u64::from(height);
    let target_width_u64 = u64::from(target_width);
    let target_height_u64 = u64::from(target_height);
    let mut scaled = Vec::with_capacity(
        target_width_usize
            .checked_mul(target_height_usize)?
            .checked_mul(4)?,
    );

    for y in 0..target_height_u64 {
        let source_y = usize::try_from(y.checked_mul(height_u64)? / target_height_u64).ok()?;
        for x in 0..target_width_u64 {
            let source_x = usize::try_from(x.checked_mul(width_u64)? / target_width_u64).ok()?;
            let start = source_y
                .checked_mul(source_width)?
                .checked_add(source_x)?
                .checked_mul(4)?;
            let end = start.checked_add(4)?;
            scaled.extend_from_slice(data.get(start..end)?);
        }
    }

    Some((target_width, target_height, scaled))
}

#[cfg(all(windows, feature = "native-capture-window"))]
fn bounded_dimensions(
    width: u32,
    height: u32,
    max_width: u32,
    max_height: u32,
) -> Option<(u32, u32)> {
    if width == 0 || height == 0 || max_width == 0 || max_height == 0 {
        return None;
    }
    if width <= max_width && height <= max_height {
        return Some((width, height));
    }

    let width_limited_num = u64::from(max_width);
    let width_limited_den = u64::from(width);
    let height_limited_num = u64::from(max_height);
    let height_limited_den = u64::from(height);
    let (scale_num, scale_den) = if width_limited_num.checked_mul(height_limited_den)?
        <= height_limited_num.checked_mul(width_limited_den)?
    {
        (width_limited_num, width_limited_den)
    } else {
        (height_limited_num, height_limited_den)
    };

    let target_width = encoder_dimension(
        u32::try_from((u64::from(width).checked_mul(scale_num)? / scale_den).max(1)).ok()?,
    )?;
    let target_height = encoder_dimension(
        u32::try_from((u64::from(height).checked_mul(scale_num)? / scale_den).max(1)).ok()?,
    )?;
    Some((target_width, target_height))
}

#[cfg(all(test, windows, feature = "native-capture-window"))]
mod tests {
    use super::{
        bgra_to_nv12, compact_bgra_frame, encode_native_frame, NATIVE_FRAME_FORMAT_BGRA,
        NATIVE_FRAME_FORMAT_NV12,
    };
    use super::{
        native_client_capture_box_from_rects, validate_native_first_frame_packet,
        validate_native_first_frame_payload, NativeClientCaptureBox, NativeFirstFrameMetadata,
    };
    use crate::modules::remote_session::input::ScreenRect;
    use windows::Win32::Foundation::RECT;

    #[test]
    fn native_capture_packet_starts_with_little_endian_dimensions() {
        let packet = encode_native_frame(
            2,
            2,
            &[1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17],
            1920,
            1080,
        )
        .unwrap();

        assert_eq!(&packet[0..4], &2_u32.to_le_bytes());
        assert_eq!(&packet[4..8], &2_u32.to_le_bytes());
        assert_eq!(&packet[8..12], &NATIVE_FRAME_FORMAT_NV12.to_le_bytes());
        assert_eq!(packet.len(), 16 + 2 * 2 * 3 / 2);
    }

    #[test]
    fn native_capture_packet_strips_row_padding() {
        let padded = compact_bgra_frame(
            2,
            2,
            &[
                1, 2, 3, 4, 5, 6, 7, 8, 99, 99, 99, 99, 10, 11, 12, 13, 14, 15, 16, 17, 88, 88, 88,
                88,
            ],
            1920,
            1080,
        )
        .unwrap();

        assert_eq!(
            padded,
            (
                2,
                2,
                vec![1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17]
            )
        );
    }

    #[test]
    fn native_capture_packet_rejects_undersized_data() {
        assert!(encode_native_frame(2, 2, &[1, 2, 3], 1920, 1080).is_none());
    }

    #[test]
    fn native_capture_packet_crops_odd_dimensions_to_even_bounds() {
        let packet = encode_native_frame(
            3,
            3,
            &[
                1, 2, 3, 4, 5, 6, 7, 8, 90, 90, 90, 90, 10, 11, 12, 13, 14, 15, 16, 17, 91, 91, 91,
                91, 80, 80, 80, 80, 81, 81, 81, 81, 82, 82, 82, 82,
            ],
            1920,
            1080,
        )
        .unwrap();

        assert_eq!(&packet[0..4], &2_u32.to_le_bytes());
        assert_eq!(&packet[4..8], &2_u32.to_le_bytes());
        assert_eq!(packet.len(), 16 + 2 * 2 * 3 / 2);
    }

    #[test]
    fn native_capture_packet_crops_large_width_to_encoder_boundary() {
        let mut data = Vec::new();
        for value in 0..(10 * 8) {
            data.extend_from_slice(&[value as u8, 1, 2, 3]);
        }

        let packet = encode_native_frame(10, 8, &data, 1920, 1080).unwrap();

        assert_eq!(&packet[0..4], &8_u32.to_le_bytes());
        assert_eq!(&packet[4..8], &8_u32.to_le_bytes());
        assert_eq!(packet.len(), 16 + 8 * 8 * 3 / 2);
    }

    #[test]
    fn native_capture_packet_strips_final_padding() {
        let padded = compact_bgra_frame(
            2,
            2,
            &[1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 99],
            1920,
            1080,
        )
        .unwrap();

        assert_eq!(
            padded,
            (
                2,
                2,
                vec![1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17]
            )
        );
    }

    #[test]
    fn native_capture_packet_downscales_to_requested_bounds() {
        let mut data = Vec::new();
        for value in 0..(16 * 8) {
            data.extend_from_slice(&[value as u8, 0, 0, 255]);
        }

        let packet = encode_native_frame(16, 8, &data, 8, 8).unwrap();

        assert_eq!(&packet[0..4], &8_u32.to_le_bytes());
        assert_eq!(&packet[4..8], &4_u32.to_le_bytes());
        assert_eq!(packet.len(), 16 + 8 * 4 * 3 / 2);
    }

    #[test]
    fn native_capture_compact_bgra_frame_downscales_to_requested_bounds() {
        let mut data = Vec::new();
        for value in 0..(16 * 8) {
            data.extend_from_slice(&[value as u8, 1, 2, 255]);
        }

        let (width, height, frame_data) = compact_bgra_frame(16, 8, &data, 8, 8).unwrap();

        assert_eq!((width, height), (8, 4));
        assert_eq!(frame_data.len(), 8 * 4 * 4);
    }

    #[test]
    fn native_capture_bgra_to_nv12_converts_known_colors() {
        let nv12 = bgra_to_nv12(
            2,
            2,
            &[
                0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 255, 255, 0, 255, 0, 255,
            ],
        )
        .unwrap();

        assert_eq!(&nv12[0..4], &[16, 235, 82, 144]);
        assert_eq!(&nv12[4..6], &[100, 133]);
    }

    #[test]
    fn native_client_capture_box_crops_to_client_area() {
        let crop = native_client_capture_box_from_rects(
            1024,
            768,
            RECT {
                left: 90,
                top: 180,
                right: 1114,
                bottom: 948,
            },
            ScreenRect {
                left: 100,
                top: 220,
                width: 800,
                height: 600,
            },
        )
        .unwrap();

        assert_eq!(
            crop,
            NativeClientCaptureBox {
                start_x: 10,
                start_y: 40,
                end_x: 810,
                end_y: 640,
                frame_width: 1024,
                frame_height: 768,
                client_width: 800,
                client_height: 600,
            }
        );
    }

    #[test]
    fn native_client_capture_box_clamps_to_texture_bounds() {
        let crop = native_client_capture_box_from_rects(
            640,
            480,
            RECT {
                left: 90,
                top: 180,
                right: 730,
                bottom: 660,
            },
            ScreenRect {
                left: 100,
                top: 220,
                width: 800,
                height: 600,
            },
        )
        .unwrap();

        assert_eq!(
            crop,
            NativeClientCaptureBox {
                start_x: 10,
                start_y: 40,
                end_x: 640,
                end_y: 480,
                frame_width: 640,
                frame_height: 480,
                client_width: 800,
                client_height: 600,
            }
        );
    }

    #[test]
    fn native_first_frame_validation_accepts_valid_metadata() {
        assert_eq!(
            validate_native_first_frame_payload(
                640,
                360,
                NATIVE_FRAME_FORMAT_NV12,
                640 * 360 * 3 / 2,
            )
            .unwrap(),
            NativeFirstFrameMetadata {
                frame_width: 640,
                frame_height: 360,
                pixel_format: NATIVE_FRAME_FORMAT_NV12,
            }
        );
    }

    #[test]
    fn native_first_frame_validation_accepts_legacy_bgra_metadata() {
        assert_eq!(
            validate_native_first_frame_payload(640, 360, NATIVE_FRAME_FORMAT_BGRA, 640 * 360 * 4,)
                .unwrap(),
            NativeFirstFrameMetadata {
                frame_width: 640,
                frame_height: 360,
                pixel_format: NATIVE_FRAME_FORMAT_BGRA,
            }
        );
    }

    #[test]
    fn native_first_frame_validation_rejects_zero_or_too_small_frame() {
        assert!(validate_native_first_frame_payload(0, 360, NATIVE_FRAME_FORMAT_NV12, 0).is_err());
        assert!(validate_native_first_frame_payload(
            319,
            360,
            NATIVE_FRAME_FORMAT_NV12,
            319 * 360 * 3 / 2
        )
        .is_err());
        assert!(validate_native_first_frame_payload(
            640,
            199,
            NATIVE_FRAME_FORMAT_NV12,
            640 * 199 * 3 / 2
        )
        .is_err());
    }

    #[test]
    fn native_first_frame_validation_rejects_malformed_payload_length() {
        assert!(validate_native_first_frame_payload(
            640,
            360,
            NATIVE_FRAME_FORMAT_NV12,
            640 * 360 * 3 / 2 - 1
        )
        .is_err());
        assert!(validate_native_first_frame_payload(
            640,
            360,
            NATIVE_FRAME_FORMAT_BGRA,
            640 * 360 * 4 - 1
        )
        .is_err());
    }

    #[test]
    fn native_first_frame_validation_rejects_odd_nv12_dimensions() {
        assert!(validate_native_first_frame_payload(
            641,
            360,
            NATIVE_FRAME_FORMAT_NV12,
            641 * 360 * 3 / 2
        )
        .is_err());
        assert!(validate_native_first_frame_payload(
            640,
            361,
            NATIVE_FRAME_FORMAT_NV12,
            640 * 361 * 3 / 2
        )
        .is_err());
    }

    #[test]
    fn native_first_frame_validation_reads_packet_dimensions() {
        let mut packet = Vec::new();
        packet.extend_from_slice(&640_u32.to_le_bytes());
        packet.extend_from_slice(&360_u32.to_le_bytes());
        packet.extend_from_slice(&NATIVE_FRAME_FORMAT_NV12.to_le_bytes());
        packet.extend_from_slice(&0_u32.to_le_bytes());
        packet.resize(16 + 640 * 360 * 3 / 2, 7);

        assert_eq!(
            validate_native_first_frame_packet(&packet).unwrap(),
            NativeFirstFrameMetadata {
                frame_width: 640,
                frame_height: 360,
                pixel_format: NATIVE_FRAME_FORMAT_NV12,
            }
        );
    }
}
