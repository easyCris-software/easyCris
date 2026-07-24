use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::Emitter;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use uuid::Uuid;

use super::audio_capture::{self, NativeAudioCaptureHandle, NativeAudioCaptureStartResult};
use super::capture::{self, NativeCaptureHandle, NativeCaptureOptions, NativeCaptureStartResult};
use super::input::{RemoteInputHandle, ScreenRect};
use super::mic_capture;
use super::signaling::{
    local_ip_candidates, start_signaling_server, SignalingClientMessage, SignalingPeerContext,
    SignalingPeerRole, SignalingPeerSender, SignalingServerHandle, SignalingServerMessage,
};
use super::types::{
    RemoteControlPermission, RemoteGuestRejection, RemoteInputKeyEvent, RemoteInputMouseEvent,
    RemoteKey, RemoteKeyAction, RemoteMouseAction, RemoteSessionGuestSummary,
    RemoteSessionIdentity, RemoteSessionInfo, RemoteSessionInvite, RemoteSessionJoinRequest,
    RemoteSessionLimitEvent, RemoteSessionMode, RemoteSessionPhase, RemoteSessionStartResult,
    RemoteSessionStatus,
};

const INVITE_TOKEN_TTL: Duration = Duration::from_secs(15 * 60);
const REMOTE_SESSION_LIMIT: Duration = Duration::from_secs(30 * 60);
const REMOTE_SESSION_WARNING_BEFORE: Duration = Duration::from_secs(5 * 60);
const REMOTE_INPUT_RATE_WINDOW: Duration = Duration::from_secs(1);
const REMOTE_INPUT_RATE_LIMIT: u32 = 240;

#[derive(Debug, Clone, Default)]
pub struct RemoteSessionState {
    inner: Arc<Mutex<RemoteSessionStateInner>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedCaptureSurface {
    pub surface_kind: String,
    pub frame_width: u32,
    pub frame_height: u32,
    pub screen_rect: ScreenRect,
    pub window_hwnd: Option<isize>,
    pub validated_at_unix_ms: u64,
}

#[derive(Debug, Default)]
struct RemoteSessionStateInner {
    current_session: Option<InternalRemoteSession>,
    pending_guest: Option<RemoteSessionJoinRequest>,
    approved_guest: Option<RemoteSessionJoinRequest>,
    last_approved_guest: Option<RemoteSessionJoinRequest>,
    approved_control: bool,
    control_ever_granted: bool,
    signaling_server_handle: Option<SignalingServerHandle>,
    host_sender: Option<SignalingPeerSender>,
    host_connection_id: Option<String>,
    guest_sender: Option<SignalingPeerSender>,
    guest_connection_id: Option<String>,
    revoke_requested: bool,
    session_limit_task: Option<SessionLimitTask>,
    input_rate_window_started_at: Option<Instant>,
    input_rate_count: u32,
    remote_input_handle: Option<RemoteInputHandle>,
    native_capture_handle: Option<NativeCaptureHandle>,
    e2e_native_audio_capture_handle: Option<NativeAudioCaptureHandle>,
    native_mic_capture_handle: Option<NativeAudioCaptureHandle>,
    capture_rect: Option<ScreenRect>,
    validated_capture_surface: Option<ValidatedCaptureSurface>,
    native_capture_starting: bool,
    native_capture_start_cancelled: bool,
    e2e_native_audio_capture_starting: bool,
    e2e_native_audio_capture_start_cancelled: bool,
    native_mic_capture_starting: bool,
    native_mic_capture_start_cancelled: bool,
}

struct SessionLimitTask(JoinHandle<()>);

impl std::fmt::Debug for SessionLimitTask {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("SessionLimitTask").field(&"<task>").finish()
    }
}

#[derive(Clone)]
struct InternalRemoteSession {
    session_id: String,
    invite_token: String,
    signaling_port: Option<u16>,
    host_candidates: Vec<String>,
    mode: RemoteSessionMode,
    token_expires_at: SystemTime,
    host_identity: RemoteSessionIdentity,
    phase: RemoteSessionPhase,
}

impl std::fmt::Debug for InternalRemoteSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InternalRemoteSession")
            .field("session_id", &self.session_id)
            .field("invite_token", &"<redacted>")
            .field("signaling_port", &self.signaling_port)
            .field("host_candidates", &self.host_candidates)
            .field("mode", &self.mode)
            .field("token_expires_at", &self.token_expires_at)
            .field("host_identity", &self.host_identity)
            .field("phase", &self.phase)
            .finish()
    }
}

impl RemoteSessionState {
    pub async fn start(
        &self,
        host_identity: RemoteSessionIdentity,
    ) -> Result<RemoteSessionStartResult, String> {
        if self.status().await.current_session.is_some() {
            return Err("Remote session is already active".to_string());
        }
        let signaling_handle = start_signaling_server(self.clone()).await?;
        let signaling_port = signaling_handle.port();
        let host_candidates = local_ip_candidates(signaling_port);
        let mut inner = self.inner.lock().await;
        if inner.current_session.is_some() {
            signaling_handle.shutdown();
            return Err("Remote session is already active".to_string());
        }
        // LAN starts the signaling server before input setup, so failures after
        // this point must explicitly shut that server down before returning.
        let remote_input_handle = match RemoteInputHandle::new() {
            Ok(handle) => handle,
            Err(error) => {
                signaling_handle.shutdown();
                return Err(error);
            }
        };
        let session_id = Uuid::new_v4().to_string();
        let invite_token = Uuid::new_v4().to_string();
        let token_expires_at = SystemTime::now() + INVITE_TOKEN_TTL;
        let host_for_url = host_candidates
            .first()
            .cloned()
            .unwrap_or_else(|| format!("127.0.0.1:{signaling_port}"));
        let share_url = format!(
            "easycris-remote://join?host={host_for_url}&session={session_id}&token={invite_token}"
        );

        inner.current_session = Some(InternalRemoteSession {
            session_id: session_id.clone(),
            invite_token: invite_token.clone(),
            signaling_port: Some(signaling_port),
            host_candidates: host_candidates.clone(),
            mode: RemoteSessionMode::Lan,
            token_expires_at,
            host_identity,
            phase: RemoteSessionPhase::Listening,
        });
        inner.pending_guest = None;
        inner.approved_guest = None;
        inner.last_approved_guest = None;
        inner.approved_control = false;
        inner.control_ever_granted = false;
        inner.capture_rect = None;
        inner.validated_capture_surface = None;
        inner.signaling_server_handle = Some(signaling_handle);
        inner.host_sender = None;
        inner.host_connection_id = None;
        inner.guest_sender = None;
        inner.guest_connection_id = None;
        inner.revoke_requested = false;
        inner.remote_input_handle = Some(remote_input_handle);
        Self::reset_input_rate_limit(&mut inner);
        Self::abort_session_limit_task(&mut inner);

        let status = Self::status_from_inner(&inner);
        Ok(RemoteSessionStartResult {
            status,
            invite: RemoteSessionInvite {
                session_id,
                invite_token,
                share_url,
                signaling_port: Some(signaling_port),
                host_candidates,
                mode: RemoteSessionMode::Lan,
                relay_url: None,
                invite_id: None,
                host_secret: None,
                expires_at_unix_ms: unix_ms(token_expires_at),
            },
        })
    }

    pub async fn start_cloud(
        &self,
        host_identity: RemoteSessionIdentity,
        invite: RemoteSessionInvite,
    ) -> Result<RemoteSessionStartResult, String> {
        if invite.mode != RemoteSessionMode::Cloud {
            return Err("Cloud remote session requires a cloud invite".to_string());
        }
        if invite.invite_id.is_none() || invite.relay_url.is_none() || invite.host_secret.is_none()
        {
            return Err("Cloud remote invite is missing relay details".to_string());
        }
        if self.status().await.current_session.is_some() {
            return Err("Remote session is already active".to_string());
        }
        let token_expires_at = UNIX_EPOCH + Duration::from_millis(invite.expires_at_unix_ms);
        let mut inner = self.inner.lock().await;
        if inner.current_session.is_some() {
            return Err("Remote session is already active".to_string());
        }
        let remote_input_handle = RemoteInputHandle::new()?;

        inner.current_session = Some(InternalRemoteSession {
            session_id: invite.session_id.clone(),
            invite_token: invite.invite_token.clone(),
            signaling_port: None,
            host_candidates: Vec::new(),
            mode: RemoteSessionMode::Cloud,
            token_expires_at,
            host_identity,
            phase: RemoteSessionPhase::Listening,
        });
        inner.pending_guest = None;
        inner.approved_guest = None;
        inner.last_approved_guest = None;
        inner.approved_control = false;
        inner.control_ever_granted = false;
        inner.capture_rect = None;
        inner.validated_capture_surface = None;
        inner.signaling_server_handle = None;
        inner.host_sender = None;
        inner.host_connection_id = None;
        inner.guest_sender = None;
        inner.guest_connection_id = None;
        inner.revoke_requested = false;
        inner.remote_input_handle = Some(remote_input_handle);
        Self::reset_input_rate_limit(&mut inner);
        Self::abort_session_limit_task(&mut inner);

        let status = Self::status_from_inner(&inner);
        Ok(RemoteSessionStartResult {
            status,
            invite: RemoteSessionInvite {
                host_secret: None,
                ..invite
            },
        })
    }

    pub async fn set_pending_guest(
        &self,
        guest: RemoteSessionJoinRequest,
    ) -> Result<RemoteSessionStatus, String> {
        let mut inner = self.inner.lock().await;
        Self::ensure_current_session(&inner, &guest.session_id)?;
        if inner.pending_guest.is_some() || inner.approved_guest.is_some() {
            return Err("A remote-session guest is already pending or approved".to_string());
        }
        inner.pending_guest = Some(guest);
        if let Some(session) = inner.current_session.as_mut() {
            session.phase = RemoteSessionPhase::PendingApproval;
        }
        Ok(Self::status_from_inner(&inner))
    }

    pub async fn stop(&self) -> RemoteSessionStatus {
        let (
            handle,
            native_capture_handle,
            native_audio_capture_handle,
            native_mic_capture_handle,
            remote_input_handle,
            status,
        ) = {
            let mut inner = self.inner.lock().await;
            let handle = inner.signaling_server_handle.take();
            let native_capture_handle = inner.native_capture_handle.take();
            let native_audio_capture_handle = inner.e2e_native_audio_capture_handle.take();
            let native_mic_capture_handle = inner.native_mic_capture_handle.take();
            let remote_input_handle = inner.remote_input_handle.take();
            inner.current_session = None;
            inner.pending_guest = None;
            inner.approved_guest = None;
            inner.last_approved_guest = None;
            inner.approved_control = false;
            inner.control_ever_granted = false;
            inner.capture_rect = None;
            inner.validated_capture_surface = None;
            inner.host_sender = None;
            inner.host_connection_id = None;
            inner.guest_sender = None;
            inner.guest_connection_id = None;
            inner.revoke_requested = false;
            if inner.native_capture_starting {
                inner.native_capture_start_cancelled = true;
            }
            if inner.e2e_native_audio_capture_starting {
                inner.e2e_native_audio_capture_start_cancelled = true;
            }
            if inner.native_mic_capture_starting {
                inner.native_mic_capture_start_cancelled = true;
            }
            Self::reset_input_rate_limit(&mut inner);
            Self::abort_session_limit_task(&mut inner);
            (
                handle,
                native_capture_handle,
                native_audio_capture_handle,
                native_mic_capture_handle,
                remote_input_handle,
                Self::status_from_inner(&inner),
            )
        };
        if let Some(remote_input_handle) = remote_input_handle {
            remote_input_handle.deactivate();
            let _ = tokio::task::spawn_blocking(move || drop(remote_input_handle));
        }
        if let Some(handle) = native_capture_handle {
            handle.stop();
        }
        if let Some(handle) = native_audio_capture_handle {
            Self::stop_native_audio_handle(handle).await;
        }
        if let Some(handle) = native_mic_capture_handle {
            Self::stop_native_audio_handle(handle).await;
        }
        if let Some(handle) = handle {
            handle.shutdown();
        }
        status
    }

    pub async fn start_native_capture(
        &self,
        options: NativeCaptureOptions,
        on_frame: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    ) -> Result<NativeCaptureStartResult, String> {
        {
            let mut inner = self.inner.lock().await;
            if inner.native_capture_handle.is_some() || inner.native_capture_starting {
                return Err("Native capture is already active".to_string());
            }
            inner.native_capture_starting = true;
            inner.native_capture_start_cancelled = false;
        }

        let handle = match tokio::task::spawn_blocking(move || {
            capture::start_native_capture(options, on_frame)
        })
        .await
        {
            Ok(result) => result,
            Err(error) => Err(format!("Native capture task failed: {error}")),
        };

        let mut inner = self.inner.lock().await;
        inner.native_capture_starting = false;
        let handle = handle?;
        if inner.native_capture_start_cancelled {
            inner.native_capture_start_cancelled = false;
            handle.stop();
            return Err("Native capture was stopped before startup completed".to_string());
        }
        if inner.native_capture_handle.is_some() {
            handle.stop();
            return Err("Native capture is already active".to_string());
        }
        let result = handle.start_result();
        inner.native_capture_handle = Some(handle);
        Ok(result)
    }

    pub async fn stop_native_capture(&self, capture_id: String) -> Result<(), String> {
        let handle = {
            let mut inner = self.inner.lock().await;
            let Some(active) = inner.native_capture_handle.as_ref() else {
                inner.capture_rect = None;
                inner.validated_capture_surface = None;
                return Ok(());
            };
            if active.capture_id() != capture_id {
                return Err("Native capture id does not match the active capture".to_string());
            }
            inner.capture_rect = None;
            inner.validated_capture_surface = None;
            inner.native_capture_handle.take()
        };
        if let Some(handle) = handle {
            handle.stop();
        }
        Ok(())
    }

    pub async fn start_e2e_native_audio_capture(
        &self,
        frequency_hz: f32,
        on_audio: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    ) -> Result<NativeAudioCaptureStartResult, String> {
        {
            let mut inner = self.inner.lock().await;
            if inner.e2e_native_audio_capture_handle.is_some()
                || inner.e2e_native_audio_capture_starting
            {
                return Err("E2E native audio capture is already active".to_string());
            }
            inner.e2e_native_audio_capture_starting = true;
            inner.e2e_native_audio_capture_start_cancelled = false;
        }

        let handle = match tokio::task::spawn_blocking(move || {
            audio_capture::start_e2e_native_audio_tone_capture(frequency_hz, on_audio)
        })
        .await
        {
            Ok(handle) => handle,
            Err(error) => {
                let mut inner = self.inner.lock().await;
                inner.e2e_native_audio_capture_starting = false;
                return Err(format!("E2E native audio task failed: {error}"));
            }
        };

        let handle = match handle {
            Ok(handle) => handle,
            Err(error) => {
                let mut inner = self.inner.lock().await;
                inner.e2e_native_audio_capture_starting = false;
                return Err(error);
            }
        };
        let result = handle.start_result();
        let stop_handle = {
            let mut inner = self.inner.lock().await;
            inner.e2e_native_audio_capture_starting = false;
            if inner.e2e_native_audio_capture_start_cancelled {
                inner.e2e_native_audio_capture_start_cancelled = false;
                Some(handle)
            } else if inner.e2e_native_audio_capture_handle.is_some() {
                Some(handle)
            } else {
                inner.e2e_native_audio_capture_handle = Some(handle);
                None
            }
        };
        if let Some(handle) = stop_handle {
            Self::stop_native_audio_handle(handle).await;
            return Err(
                "E2E native audio capture was stopped before startup completed".to_string(),
            );
        }
        Ok(result)
    }

    pub async fn stop_e2e_native_audio_capture(&self, capture_id: String) -> Result<(), String> {
        let handle = {
            let mut inner = self.inner.lock().await;
            let Some(active) = inner.e2e_native_audio_capture_handle.as_ref() else {
                if inner.e2e_native_audio_capture_starting {
                    inner.e2e_native_audio_capture_start_cancelled = true;
                }
                return Ok(());
            };
            if active.capture_id() != capture_id {
                return Err(
                    "E2E native audio capture id does not match the active capture".to_string(),
                );
            }
            inner.e2e_native_audio_capture_handle.take()
        };
        if let Some(handle) = handle {
            Self::stop_native_audio_handle(handle).await;
        }
        Ok(())
    }

    async fn stop_native_audio_handle(handle: NativeAudioCaptureHandle) {
        let _ = tokio::task::spawn_blocking(move || handle.stop()).await;
    }

    pub async fn start_native_mic_capture(
        &self,
        on_audio: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    ) -> Result<NativeAudioCaptureStartResult, String> {
        {
            let mut inner = self.inner.lock().await;
            if inner.native_mic_capture_handle.is_some() || inner.native_mic_capture_starting {
                return Err("Native microphone capture is already active".to_string());
            }
            inner.native_mic_capture_starting = true;
            inner.native_mic_capture_start_cancelled = false;
        }

        let handle = match tokio::task::spawn_blocking(move || {
            mic_capture::start_native_mic_capture(on_audio)
        })
        .await
        {
            Ok(handle) => handle,
            Err(error) => {
                let mut inner = self.inner.lock().await;
                inner.native_mic_capture_starting = false;
                return Err(format!("Native microphone capture task failed: {error}"));
            }
        };

        let handle = match handle {
            Ok(handle) => handle,
            Err(error) => {
                let mut inner = self.inner.lock().await;
                inner.native_mic_capture_starting = false;
                return Err(error);
            }
        };
        let result = handle.start_result();
        let stop_handle = {
            let mut inner = self.inner.lock().await;
            inner.native_mic_capture_starting = false;
            if inner.native_mic_capture_start_cancelled {
                inner.native_mic_capture_start_cancelled = false;
                Some(handle)
            } else if inner.native_mic_capture_handle.is_some() {
                Some(handle)
            } else {
                inner.native_mic_capture_handle = Some(handle);
                None
            }
        };
        if let Some(handle) = stop_handle {
            Self::stop_native_audio_handle(handle).await;
            return Err(
                "Native microphone capture was stopped before startup completed".to_string(),
            );
        }
        Ok(result)
    }

    pub async fn stop_native_mic_capture(&self, capture_id: String) -> Result<(), String> {
        let handle = {
            let mut inner = self.inner.lock().await;
            let Some(active) = inner.native_mic_capture_handle.as_ref() else {
                if inner.native_mic_capture_starting {
                    inner.native_mic_capture_start_cancelled = true;
                }
                return Ok(());
            };
            if active.capture_id() != capture_id {
                return Err(
                    "Native microphone capture id does not match the active capture".to_string(),
                );
            }
            inner.native_mic_capture_handle.take()
        };
        if let Some(handle) = handle {
            Self::stop_native_audio_handle(handle).await;
        }
        Ok(())
    }

    pub async fn status(&self) -> RemoteSessionStatus {
        let inner = self.inner.lock().await;
        Self::status_from_inner(&inner)
    }

    pub async fn remote_input_handle(&self) -> Result<RemoteInputHandle, String> {
        let inner = self.inner.lock().await;
        inner
            .remote_input_handle
            .clone()
            .ok_or_else(|| "Remote session is not active".to_string())
    }

    pub async fn set_capture_rect(&self, capture_rect: ScreenRect) {
        let mut inner = self.inner.lock().await;
        inner.capture_rect = Some(capture_rect);
        inner.validated_capture_surface = None;
    }

    pub async fn set_validated_capture_surface(&self, surface: ValidatedCaptureSurface) {
        let mut inner = self.inner.lock().await;
        inner.capture_rect = Some(surface.screen_rect);
        inner.validated_capture_surface = Some(surface);
    }

    pub async fn capture_rect(&self) -> Result<ScreenRect, String> {
        let inner = self.inner.lock().await;
        inner
            .capture_rect
            .ok_or_else(|| "Remote capture surface is not active".to_string())
    }

    pub async fn validated_capture_surface(&self) -> Result<ValidatedCaptureSurface, String> {
        let inner = self.inner.lock().await;
        inner
            .validated_capture_surface
            .clone()
            .ok_or_else(|| "Remote validated capture surface is not active".to_string())
    }

    pub async fn approve_guest(
        &self,
        permission: RemoteControlPermission,
    ) -> Result<RemoteSessionStatus, String> {
        self.approve_guest_with_app(None, permission).await
    }

    pub async fn approve_guest_with_app(
        &self,
        app: Option<tauri::AppHandle>,
        permission: RemoteControlPermission,
    ) -> Result<RemoteSessionStatus, String> {
        let (guest_sender, host_device_id, status) = {
            let mut inner = self.inner.lock().await;
            Self::ensure_current_session(&inner, &permission.session_id)?;

            let pending = inner
                .pending_guest
                .clone()
                .ok_or_else(|| "No pending remote-session guest to approve".to_string())?;

            if pending.guest_device_id != permission.guest_device_id {
                return Err("Pending guest does not match approval request".to_string());
            }

            inner.last_approved_guest = Some(pending.clone());
            inner.approved_guest = Some(pending);
            inner.pending_guest = None;
            inner.approved_control = permission.can_control;
            inner.control_ever_granted = permission.can_control;
            Self::reset_input_rate_limit(&mut inner);
            if let Some(session) = inner.current_session.as_mut() {
                session.phase = RemoteSessionPhase::Connected;
            }
            if let Some(app) = app {
                Self::replace_session_limit_task(
                    &mut inner,
                    self.inner.clone(),
                    app,
                    permission.session_id.clone(),
                );
            }

            let host_device_id = inner
                .current_session
                .as_ref()
                .map(|session| session.host_identity.device_id.clone())
                .unwrap_or_default();
            (
                inner.guest_sender.clone(),
                host_device_id,
                Self::status_from_inner(&inner),
            )
        };

        if let Some(guest_sender) = guest_sender {
            let _ = guest_sender
                .send(&SignalingServerMessage::JoinApproved {
                    session_id: permission.session_id,
                    guest_device_id: permission.guest_device_id,
                    host_device_id,
                })
                .await;
        }

        Ok(status)
    }

    pub async fn reject_guest(
        &self,
        rejection: RemoteGuestRejection,
    ) -> Result<RemoteSessionStatus, String> {
        let (guest_sender, guest_device_id, status) = {
            let mut inner = self.inner.lock().await;
            Self::ensure_current_session(&inner, &rejection.session_id)?;
            let pending = inner
                .pending_guest
                .as_ref()
                .ok_or_else(|| "No pending remote-session guest to reject".to_string())?;
            if pending.guest_device_id != rejection.guest_device_id {
                return Err("Pending guest does not match rejection request".to_string());
            }
            let guest_device_id = Some(pending.guest_device_id.clone());
            let guest_sender = inner.guest_sender.clone();
            inner.pending_guest = None;
            inner.guest_sender = None;
            inner.guest_connection_id = None;
            if let Some(session) = inner.current_session.as_mut() {
                session.phase = RemoteSessionPhase::Listening;
            }
            (
                guest_sender,
                guest_device_id,
                Self::status_from_inner(&inner),
            )
        };

        if let (Some(guest_sender), Some(_guest_device_id)) = (guest_sender, guest_device_id) {
            let _ = guest_sender
                .send(&SignalingServerMessage::JoinRejected {
                    session_id: rejection.session_id,
                    reason: "Host rejected the remote-session request".to_string(),
                })
                .await;
        }

        Ok(status)
    }

    pub async fn revoke_control(
        &self,
        session_id: String,
        reason: Option<String>,
    ) -> Result<RemoteSessionStatus, String> {
        let (handle, guest_sender, status) = {
            let mut inner = self.inner.lock().await;
            Self::ensure_current_session(&inner, &session_id)?;
            let handle = inner.signaling_server_handle.take();
            let guest_sender = inner.guest_sender.clone();
            // Preserve the approved identity so in-flight release events can drain after revoke.
            if inner.last_approved_guest.is_none() {
                inner.last_approved_guest = inner.approved_guest.clone();
            }
            inner.pending_guest = None;
            inner.approved_guest = None;
            inner.approved_control = false;
            inner.host_sender = None;
            inner.host_connection_id = None;
            inner.guest_sender = None;
            inner.guest_connection_id = None;
            inner.revoke_requested = true;
            Self::reset_input_rate_limit(&mut inner);
            Self::abort_session_limit_task(&mut inner);
            if let Some(session) = inner.current_session.as_mut() {
                session.phase = RemoteSessionPhase::Revoked;
            }
            (handle, guest_sender, Self::status_from_inner(&inner))
        };
        if let Some(guest_sender) = guest_sender {
            let _ = guest_sender
                .send(&SignalingServerMessage::SessionRevoked {
                    session_id: session_id.clone(),
                    reason,
                })
                .await;
        }
        if let Some(handle) = handle {
            handle.shutdown();
        }
        Ok(status)
    }

    pub async fn handle_signaling_message(
        &self,
        peer_ip: IpAddr,
        message: SignalingClientMessage,
        connection_id: String,
        peer_context: Option<SignalingPeerContext>,
        sender: SignalingPeerSender,
    ) -> SignalingServerMessage {
        match self
            .try_handle_signaling_message(peer_ip, message, connection_id, peer_context, sender)
            .await
        {
            Ok(response) => response,
            Err((session_id, reason)) => {
                SignalingServerMessage::JoinRejected { session_id, reason }
            }
        }
    }

    pub async fn unregister_signaling_peer(&self, context: &SignalingPeerContext) {
        let outbound = {
            let mut inner = self.inner.lock().await;
            match context.role {
                SignalingPeerRole::Host => {
                    if inner.host_connection_id.as_deref() == Some(&context.connection_id) {
                        inner.host_sender = None;
                        inner.host_connection_id = None;
                        inner.guest_sender.clone().map(|guest_sender| {
                            (
                                guest_sender,
                                SignalingServerMessage::HostDisconnected {
                                    session_id: context.session_id.clone(),
                                },
                            )
                        })
                    } else {
                        None
                    }
                }
                SignalingPeerRole::Guest => {
                    if inner.guest_connection_id.as_deref() == Some(&context.connection_id) {
                        inner.guest_sender = None;
                        inner.guest_connection_id = None;
                        let guest_device_id = context
                            .guest_device_id
                            .clone()
                            .or_else(|| {
                                inner
                                    .pending_guest
                                    .as_ref()
                                    .map(|guest| guest.guest_device_id.clone())
                            })
                            .or_else(|| {
                                inner
                                    .approved_guest
                                    .as_ref()
                                    .map(|guest| guest.guest_device_id.clone())
                            });
                        if let Some(guest_device_id) = guest_device_id {
                            let mut cleared_guest = false;
                            if inner
                                .pending_guest
                                .as_ref()
                                .is_some_and(|guest| guest.guest_device_id == guest_device_id)
                            {
                                inner.pending_guest = None;
                                cleared_guest = true;
                            }
                            if inner
                                .approved_guest
                                .as_ref()
                                .is_some_and(|guest| guest.guest_device_id == guest_device_id)
                            {
                                if inner.last_approved_guest.is_none() {
                                    inner.last_approved_guest = inner.approved_guest.clone();
                                }
                                inner.approved_guest = None;
                                inner.approved_control = false;
                                Self::reset_input_rate_limit(&mut inner);
                                Self::abort_session_limit_task(&mut inner);
                                cleared_guest = true;
                            }
                            if cleared_guest {
                                if let Some(session) = inner.current_session.as_mut() {
                                    if session.phase == RemoteSessionPhase::PendingApproval
                                        || session.phase == RemoteSessionPhase::Connected
                                    {
                                        session.phase = RemoteSessionPhase::Listening;
                                    }
                                }
                                inner.host_sender.clone().map(|host_sender| {
                                    (
                                        host_sender,
                                        SignalingServerMessage::GuestDisconnected {
                                            session_id: context.session_id.clone(),
                                            guest_device_id,
                                        },
                                    )
                                })
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
            }
        };
        if let Some((sender, message)) = outbound {
            let _ = sender.send(&message).await;
        }
    }

    pub async fn ensure_mouse_allowed(&self, event: &RemoteInputMouseEvent) -> Result<(), String> {
        self.ensure_input_allowed(
            &event.session_id,
            &event.guest_device_id,
            event.action == RemoteMouseAction::Up,
        )
        .await
    }

    pub async fn ensure_key_allowed(&self, event: &RemoteInputKeyEvent) -> Result<(), String> {
        self.ensure_input_allowed(
            &event.session_id,
            &event.guest_device_id,
            event.action == RemoteKeyAction::Up,
        )
        .await
    }

    async fn ensure_input_allowed(
        &self,
        session_id: &str,
        guest_device_id: &str,
        is_release_event: bool,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        let session = inner
            .current_session
            .as_ref()
            .ok_or_else(|| "No active remote session".to_string())?;

        if session.session_id != session_id {
            return Err("Remote session id does not match active session".to_string());
        }

        // Error is the only terminal phase that also blocks release drain.
        if session.phase == RemoteSessionPhase::Error {
            return Err("Remote session is not active".to_string());
        }

        if is_release_event && inner.control_ever_granted {
            Self::ensure_input_guest_matches(&inner, guest_device_id)?;
            return Ok(());
        }

        // Revoked sessions reject new input, but the release-drain branch above remains open.
        if inner.revoke_requested || session.phase == RemoteSessionPhase::Revoked {
            return Err("Remote control has been revoked".to_string());
        }

        if !inner.approved_control {
            return Err("Remote control is not approved".to_string());
        }

        Self::ensure_input_guest_matches(&inner, guest_device_id)?;

        if !is_release_event {
            Self::consume_input_rate_limit(&mut inner)?;
        }

        Ok(())
    }

    fn ensure_input_guest_matches(
        inner: &RemoteSessionStateInner,
        guest_device_id: &str,
    ) -> Result<(), String> {
        let approved = inner
            .approved_guest
            .as_ref()
            .or(inner.last_approved_guest.as_ref())
            .ok_or_else(|| "No approved remote-session guest".to_string())?;

        if approved.guest_device_id != guest_device_id {
            return Err("Remote input guest does not match approved guest".to_string());
        }

        Ok(())
    }

    fn consume_input_rate_limit(inner: &mut RemoteSessionStateInner) -> Result<(), String> {
        let now = Instant::now();
        let window_started = inner.input_rate_window_started_at.get_or_insert(now);
        if now.duration_since(*window_started) >= REMOTE_INPUT_RATE_WINDOW {
            inner.input_rate_window_started_at = Some(now);
            inner.input_rate_count = 1;
            return Ok(());
        }

        if inner.input_rate_count >= REMOTE_INPUT_RATE_LIMIT {
            return Err("Remote input rate limit exceeded".to_string());
        }
        inner.input_rate_count += 1;
        Ok(())
    }

    fn reset_input_rate_limit(inner: &mut RemoteSessionStateInner) {
        inner.input_rate_window_started_at = None;
        inner.input_rate_count = 0;
    }

    async fn try_handle_signaling_message(
        &self,
        peer_ip: IpAddr,
        message: SignalingClientMessage,
        connection_id: String,
        peer_context: Option<SignalingPeerContext>,
        sender: SignalingPeerSender,
    ) -> Result<SignalingServerMessage, (String, String)> {
        let mut outbound: Option<(SignalingPeerSender, SignalingServerMessage)> = None;
        let mut shutdown_handle: Option<SignalingServerHandle> = None;
        let response = {
            let mut inner = self.inner.lock().await;
            if inner.revoke_requested {
                return Err((
                    message.session_id().to_string(),
                    "Remote session has been revoked".to_string(),
                ));
            }

            match message {
                SignalingClientMessage::HostRegister { session_id } => {
                    if !peer_ip.is_loopback() {
                        return Err((
                            session_id,
                            "Host signaling registration must originate from this device"
                                .to_string(),
                        ));
                    }
                    Self::ensure_current_session(&inner, &session_id)
                        .map_err(|reason| (session_id.clone(), reason))?;
                    if inner
                        .host_connection_id
                        .as_deref()
                        .is_some_and(|existing| existing != connection_id)
                    {
                        return Err((
                            session_id,
                            "Remote-session host is already registered".to_string(),
                        ));
                    }
                    inner.host_sender = Some(sender);
                    inner.host_connection_id = Some(connection_id);
                    SignalingServerMessage::HostRegistered { session_id }
                }
                SignalingClientMessage::JoinRequest {
                    session_id,
                    token,
                    guest_display_name,
                    guest_device_id,
                } => {
                    if inner.pending_guest.is_some() || inner.approved_guest.is_some() {
                        return Err((
                            session_id,
                            "A remote-session guest is already pending or approved".to_string(),
                        ));
                    }
                    let session = Self::active_session_mut(&mut inner, &session_id)?;
                    if !constant_time_str_eq(&session.invite_token, &token) {
                        return Err((session_id, "Invalid remote-session token".to_string()));
                    }
                    if SystemTime::now() > session.token_expires_at {
                        return Err((session_id, "Remote-session token has expired".to_string()));
                    }
                    if inner.host_sender.is_none() {
                        return Err((
                            session_id,
                            "Remote-session host is not connected".to_string(),
                        ));
                    }

                    inner.pending_guest = Some(RemoteSessionJoinRequest {
                        session_id: session_id.clone(),
                        guest_display_name,
                        guest_device_id: guest_device_id.clone(),
                        guest_ip: Some(peer_ip.to_string()),
                    });
                    inner.guest_sender = Some(sender);
                    inner.guest_connection_id = Some(connection_id);
                    if let Some(session) = inner.current_session.as_mut() {
                        session.phase = RemoteSessionPhase::PendingApproval;
                    }
                    if let Some(host_sender) = inner.host_sender.clone() {
                        outbound = Some((
                            host_sender,
                            SignalingServerMessage::JoinPending {
                                session_id: session_id.clone(),
                                guest_device_id: guest_device_id.clone(),
                            },
                        ));
                    }
                    SignalingServerMessage::JoinPending {
                        session_id,
                        guest_device_id,
                    }
                }
                SignalingClientMessage::VideoOffer {
                    session_id,
                    guest_device_id,
                    payload,
                } => {
                    Self::ensure_host_context(&inner, &peer_context, &session_id)?;
                    Self::ensure_approved_guest(&inner, &session_id, &guest_device_id)?;
                    let guest_sender = inner.guest_sender.clone().ok_or_else(|| {
                        (
                            session_id.clone(),
                            "Approved guest signaling connection is not available".to_string(),
                        )
                    })?;
                    outbound = Some((
                        guest_sender,
                        SignalingServerMessage::VideoOffer {
                            session_id: session_id.clone(),
                            guest_device_id,
                            payload,
                        },
                    ));
                    SignalingServerMessage::SignalAccepted { session_id }
                }
                SignalingClientMessage::VideoAnswer {
                    session_id,
                    guest_device_id,
                    payload,
                } => {
                    Self::ensure_guest_context(
                        &inner,
                        &peer_context,
                        &session_id,
                        &guest_device_id,
                    )?;
                    Self::ensure_approved_guest(&inner, &session_id, &guest_device_id)?;
                    let host_sender = inner.host_sender.clone().ok_or_else(|| {
                        (
                            session_id.clone(),
                            "Host signaling connection is not available".to_string(),
                        )
                    })?;
                    outbound = Some((
                        host_sender,
                        SignalingServerMessage::VideoAnswer {
                            session_id: session_id.clone(),
                            guest_device_id,
                            payload,
                        },
                    ));
                    SignalingServerMessage::SignalAccepted { session_id }
                }
                SignalingClientMessage::IceCandidate {
                    session_id,
                    guest_device_id,
                    payload,
                } => {
                    Self::ensure_current_session(&inner, &session_id)
                        .map_err(|reason| (session_id.clone(), reason))?;
                    Self::ensure_approved_guest(&inner, &session_id, &guest_device_id)?;
                    match peer_context.as_ref().map(|context| context.role) {
                        Some(SignalingPeerRole::Host) => {
                            Self::ensure_host_context(&inner, &peer_context, &session_id)?;
                            if let Some(guest_sender) = inner.guest_sender.clone() {
                                outbound = Some((
                                    guest_sender,
                                    SignalingServerMessage::IceCandidate {
                                        session_id: session_id.clone(),
                                        guest_device_id,
                                        payload,
                                    },
                                ));
                            }
                        }
                        Some(SignalingPeerRole::Guest) => {
                            Self::ensure_guest_context(
                                &inner,
                                &peer_context,
                                &session_id,
                                &guest_device_id,
                            )?;
                            if let Some(host_sender) = inner.host_sender.clone() {
                                outbound = Some((
                                    host_sender,
                                    SignalingServerMessage::IceCandidate {
                                        session_id: session_id.clone(),
                                        guest_device_id,
                                        payload,
                                    },
                                ));
                            }
                        }
                        None => {
                            return Err((
                                session_id,
                                "Unregistered signaling peer cannot send candidates".to_string(),
                            ));
                        }
                    }
                    SignalingServerMessage::SignalAccepted { session_id }
                }
                SignalingClientMessage::SessionRevoked { session_id, reason } => {
                    Self::ensure_host_context(&inner, &peer_context, &session_id)?;
                    Self::ensure_current_session(&inner, &session_id)
                        .map_err(|reason| (session_id.clone(), reason))?;
                    let guest_sender = inner.guest_sender.clone();
                    shutdown_handle = inner.signaling_server_handle.take();
                    // Preserve the approved identity so in-flight release events can drain after revoke.
                    if inner.last_approved_guest.is_none() {
                        inner.last_approved_guest = inner.approved_guest.clone();
                    }
                    inner.pending_guest = None;
                    inner.approved_guest = None;
                    inner.approved_control = false;
                    inner.host_sender = None;
                    inner.host_connection_id = None;
                    inner.guest_sender = None;
                    inner.guest_connection_id = None;
                    inner.revoke_requested = true;
                    Self::reset_input_rate_limit(&mut inner);
                    Self::abort_session_limit_task(&mut inner);
                    if let Some(session) = inner.current_session.as_mut() {
                        session.phase = RemoteSessionPhase::Revoked;
                    }
                    if let Some(guest_sender) = guest_sender {
                        outbound = Some((
                            guest_sender,
                            SignalingServerMessage::SessionRevoked {
                                session_id: session_id.clone(),
                                reason: reason.clone(),
                            },
                        ));
                    }
                    SignalingServerMessage::SessionRevoked { session_id, reason }
                }
                SignalingClientMessage::Heartbeat { session_id } => {
                    Self::ensure_current_session(&inner, &session_id)
                        .map_err(|reason| (session_id.clone(), reason))?;
                    match peer_context.as_ref().map(|context| context.role) {
                        Some(SignalingPeerRole::Host) => {
                            Self::ensure_host_context(&inner, &peer_context, &session_id)?;
                        }
                        Some(SignalingPeerRole::Guest) => {
                            let guest_device_id = peer_context
                                .as_ref()
                                .and_then(|context| context.guest_device_id.as_deref())
                                .ok_or_else(|| {
                                    (
                                        session_id.clone(),
                                        "Guest signaling identity does not match this connection"
                                            .to_string(),
                                    )
                                })?;
                            Self::ensure_guest_context(
                                &inner,
                                &peer_context,
                                &session_id,
                                guest_device_id,
                            )?;
                        }
                        None => {
                            return Err((
                                session_id,
                                "Unregistered signaling peer cannot send heartbeat".to_string(),
                            ));
                        }
                    }
                    SignalingServerMessage::HeartbeatAck { session_id }
                }
            }
        };

        if let Some((sender, message)) = outbound {
            let _ = sender.send(&message).await;
        }
        if let Some(handle) = shutdown_handle {
            handle.shutdown();
        }

        Ok(response)
    }

    fn ensure_host_context(
        inner: &RemoteSessionStateInner,
        peer_context: &Option<SignalingPeerContext>,
        session_id: &str,
    ) -> Result<(), (String, String)> {
        match peer_context {
            Some(context)
                if context.session_id == session_id
                    && context.role == SignalingPeerRole::Host
                    && inner.host_connection_id.as_deref() == Some(&context.connection_id) =>
            {
                Ok(())
            }
            _ => Err((
                session_id.to_string(),
                "Only the registered host can send this signaling message".to_string(),
            )),
        }
    }

    fn ensure_guest_context(
        inner: &RemoteSessionStateInner,
        peer_context: &Option<SignalingPeerContext>,
        session_id: &str,
        guest_device_id: &str,
    ) -> Result<(), (String, String)> {
        match peer_context {
            Some(context)
                if context.session_id == session_id
                    && context.role == SignalingPeerRole::Guest
                    && context.guest_device_id.as_deref() == Some(guest_device_id)
                    && inner.guest_connection_id.as_deref() == Some(&context.connection_id) =>
            {
                Ok(())
            }
            _ => Err((
                session_id.to_string(),
                "Guest signaling identity does not match this connection".to_string(),
            )),
        }
    }

    fn ensure_approved_guest(
        inner: &RemoteSessionStateInner,
        session_id: &str,
        guest_device_id: &str,
    ) -> Result<(), (String, String)> {
        let approved = inner.approved_guest.as_ref().ok_or_else(|| {
            (
                session_id.to_string(),
                "No approved remote-session guest".to_string(),
            )
        })?;
        if approved.guest_device_id != guest_device_id {
            return Err((
                session_id.to_string(),
                "Signaling guest does not match approved guest".to_string(),
            ));
        }
        Ok(())
    }

    fn active_session_mut<'a>(
        inner: &'a mut RemoteSessionStateInner,
        session_id: &str,
    ) -> Result<&'a mut InternalRemoteSession, (String, String)> {
        let session = inner.current_session.as_mut().ok_or_else(|| {
            (
                session_id.to_string(),
                "No active remote session".to_string(),
            )
        })?;
        if session.session_id != session_id {
            return Err((
                session_id.to_string(),
                "Remote session id does not match active session".to_string(),
            ));
        }
        if matches!(
            session.phase,
            RemoteSessionPhase::Revoked | RemoteSessionPhase::Error
        ) {
            return Err((
                session_id.to_string(),
                "Remote session is not active".to_string(),
            ));
        }
        Ok(session)
    }

    fn ensure_current_session(
        inner: &RemoteSessionStateInner,
        session_id: &str,
    ) -> Result<(), String> {
        let session = inner
            .current_session
            .as_ref()
            .ok_or_else(|| "No active remote session".to_string())?;

        if session.session_id != session_id {
            return Err("Remote session id does not match active session".to_string());
        }

        if matches!(
            session.phase,
            RemoteSessionPhase::Revoked | RemoteSessionPhase::Error
        ) {
            return Err("Remote session is not active".to_string());
        }

        Ok(())
    }

    fn abort_session_limit_task(inner: &mut RemoteSessionStateInner) {
        if let Some(task) = inner.session_limit_task.take() {
            task.0.abort();
        }
    }

    fn replace_session_limit_task(
        inner: &mut RemoteSessionStateInner,
        state: Arc<Mutex<RemoteSessionStateInner>>,
        app: tauri::AppHandle,
        session_id: String,
    ) {
        Self::abort_session_limit_task(inner);
        inner.session_limit_task = Some(SessionLimitTask(tokio::spawn(async move {
            let warning_delay = REMOTE_SESSION_LIMIT
                .checked_sub(REMOTE_SESSION_WARNING_BEFORE)
                .unwrap_or_default();

            tokio::time::sleep(warning_delay).await;
            Self::emit_session_limit_event_if_connected(
                &state,
                &app,
                "remote-session-warning",
                &session_id,
                REMOTE_SESSION_WARNING_BEFORE.as_secs() as u32,
            )
            .await;

            tokio::time::sleep(REMOTE_SESSION_WARNING_BEFORE).await;
            Self::emit_session_limit_event_if_connected(
                &state,
                &app,
                "remote-session-expired",
                &session_id,
                0,
            )
            .await;
        })));
    }

    async fn emit_session_limit_event_if_connected(
        state: &Arc<Mutex<RemoteSessionStateInner>>,
        app: &tauri::AppHandle,
        event: &'static str,
        session_id: &str,
        seconds_remaining: u32,
    ) {
        let should_emit = {
            let inner = state.lock().await;
            inner.current_session.as_ref().is_some_and(|session| {
                session.session_id == session_id && session.phase == RemoteSessionPhase::Connected
            })
        };
        if should_emit {
            let _ = app.emit(
                event,
                RemoteSessionLimitEvent {
                    session_id: session_id.to_string(),
                    seconds_remaining,
                },
            );
        }
    }

    fn status_from_inner(inner: &RemoteSessionStateInner) -> RemoteSessionStatus {
        RemoteSessionStatus {
            current_session: inner.current_session.as_ref().map(|session| {
                let guest = inner
                    .approved_guest
                    .as_ref()
                    .or(inner.pending_guest.as_ref());

                RemoteSessionInfo {
                    session_id: session.session_id.clone(),
                    invite_token_preview: preview_token(&session.invite_token),
                    signaling_port: session.signaling_port,
                    host_candidates: session.host_candidates.clone(),
                    mode: session.mode.clone(),
                    host_display_name: session.host_identity.display_name.clone(),
                    host_device_id: session.host_identity.device_id.clone(),
                    guest_display_name: guest.map(|g| g.guest_display_name.clone()),
                    guest_device_id: guest.map(|g| g.guest_device_id.clone()),
                    status: session.phase.clone(),
                    can_control: inner.approved_control,
                }
            }),
            pending_guest: inner
                .pending_guest
                .as_ref()
                .map(remote_session_guest_summary),
            approved_guest: inner
                .approved_guest
                .as_ref()
                .map(remote_session_guest_summary),
            approved_control: inner.approved_control,
        }
    }
}

pub fn validate_mouse_event(event: &RemoteInputMouseEvent) -> Result<(), String> {
    if !event.normalized_x.is_finite() || !event.normalized_y.is_finite() {
        return Err("Remote mouse coordinates must be finite".to_string());
    }

    if event.source_width == 0 || event.source_height == 0 {
        return Err("Remote input source dimensions must be positive".to_string());
    }

    if event.wheel_delta_x.is_some_and(|value| !value.is_finite())
        || event.wheel_delta_y.is_some_and(|value| !value.is_finite())
    {
        return Err("Remote mouse wheel deltas must be finite".to_string());
    }

    Ok(())
}

pub fn validate_key_event(event: &RemoteInputKeyEvent) -> Result<(), String> {
    if let RemoteKey::Character(value) = &event.key {
        if value.chars().count() != 1 {
            return Err("Remote character key must contain exactly one character".to_string());
        }
    }

    Ok(())
}

fn remote_session_guest_summary(guest: &RemoteSessionJoinRequest) -> RemoteSessionGuestSummary {
    RemoteSessionGuestSummary {
        guest_display_name: guest.guest_display_name.clone(),
        guest_device_id: guest.guest_device_id.clone(),
    }
}

fn preview_token(token: &str) -> String {
    token.chars().take(4).collect()
}

// Intended for fixed-format invite tokens only; do not reuse for arbitrary variable-length secrets.
fn constant_time_str_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let max_len = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();

    for index in 0..max_len {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        diff |= usize::from(left_byte ^ right_byte);
    }

    diff == 0
}

fn unix_ms(time: SystemTime) -> u64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
        Err(error) => {
            log::warn!("Remote-session invite timestamp is before UNIX epoch: {error}");
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST_CONNECTION_ID: &str = "host-connection";
    const GUEST_CONNECTION_ID: &str = "guest-connection";

    fn host_identity() -> RemoteSessionIdentity {
        RemoteSessionIdentity {
            display_name: "Host".to_string(),
            device_id: "host-device".to_string(),
            account_email: Some("host@example.com".to_string()),
            is_guest: false,
        }
    }

    fn test_sender() -> SignalingPeerSender {
        SignalingPeerSender::memory().0
    }

    fn host_context(session_id: &str) -> SignalingPeerContext {
        SignalingPeerContext {
            session_id: session_id.to_string(),
            connection_id: HOST_CONNECTION_ID.to_string(),
            role: SignalingPeerRole::Host,
            guest_device_id: None,
        }
    }

    fn guest_context(session_id: &str, guest_device_id: &str) -> SignalingPeerContext {
        SignalingPeerContext {
            session_id: session_id.to_string(),
            connection_id: GUEST_CONNECTION_ID.to_string(),
            role: SignalingPeerRole::Guest,
            guest_device_id: Some(guest_device_id.to_string()),
        }
    }

    fn cloud_invite() -> RemoteSessionInvite {
        RemoteSessionInvite {
            session_id: "rmt_test".to_string(),
            invite_token: "guest-token".to_string(),
            share_url: "https://remote.easycris.com/join/rmt_test#token=guest-token".to_string(),
            signaling_port: None,
            host_candidates: Vec::new(),
            mode: RemoteSessionMode::Cloud,
            relay_url: Some("wss://remote.easycris.com/v1/remote/signaling".to_string()),
            invite_id: Some("rmt_test".to_string()),
            host_secret: Some("host-secret".to_string()),
            expires_at_unix_ms: unix_ms(SystemTime::now() + INVITE_TOKEN_TTL),
        }
    }

    #[tokio::test]
    async fn start_exposes_only_token_preview() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let status = result.status;
        let session = status.current_session.unwrap();

        assert_eq!(session.status, RemoteSessionPhase::Listening);
        assert_eq!(session.mode, RemoteSessionMode::Lan);
        assert!(session.signaling_port.is_some());
        assert_eq!(session.host_device_id, "host-device");
        assert_eq!(session.invite_token_preview.len(), 4);
        assert_ne!(session.invite_token_preview, result.invite.invite_token);
        assert_eq!(result.invite.mode, RemoteSessionMode::Lan);
        assert!(result.invite.signaling_port.is_some());
        assert!(result.invite.relay_url.is_none());
        assert!(result.invite.invite_id.is_none());
        assert!(result.invite.host_secret.is_none());
        let invite_json = serde_json::to_value(&result.invite).unwrap();
        assert!(invite_json.get("relay_url").is_none());
        assert!(invite_json.get("invite_id").is_none());
        assert!(invite_json.get("host_secret").is_none());
        assert!(result
            .invite
            .share_url
            .contains(&result.invite.invite_token));
        assert!(result.invite.share_url.contains("host="));
        state.stop().await;
    }

    #[tokio::test]
    async fn start_cloud_stores_cloud_session_without_lan_port() {
        let state = RemoteSessionState::default();
        let result = state
            .start_cloud(host_identity(), cloud_invite())
            .await
            .unwrap();
        let session = result.status.current_session.unwrap();

        assert_eq!(session.session_id, "rmt_test");
        assert_eq!(session.mode, RemoteSessionMode::Cloud);
        assert_eq!(session.status, RemoteSessionPhase::Listening);
        assert!(session.signaling_port.is_none());
        assert!(session.host_candidates.is_empty());
        assert_eq!(result.invite.mode, RemoteSessionMode::Cloud);
        assert!(result.invite.host_secret.is_none());
        let invite_json = serde_json::to_value(&result.invite).unwrap();
        assert!(invite_json.get("host_secret").is_none());
        state.stop().await;
    }

    #[tokio::test]
    async fn start_cloud_and_stop_manage_remote_input_handle() {
        let state = RemoteSessionState::default();

        assert!(state.remote_input_handle().await.is_err());

        state
            .start_cloud(host_identity(), cloud_invite())
            .await
            .unwrap();

        let first = state.remote_input_handle().await.unwrap();
        let second = state.remote_input_handle().await.unwrap();
        assert!(first.ptr_eq(&second));

        state.stop().await;

        assert!(state.remote_input_handle().await.is_err());
        assert!(first.can_lock_for_test().is_err());
    }

    #[tokio::test]
    async fn capture_rect_is_set_and_cleared_with_session_lifecycle() {
        let state = RemoteSessionState::default();
        let rect = ScreenRect {
            left: 10,
            top: 20,
            width: 300,
            height: 200,
        };

        assert!(state.capture_rect().await.is_err());

        state.start(host_identity()).await.unwrap();
        state.set_capture_rect(rect).await;

        assert_eq!(state.capture_rect().await.unwrap(), rect);

        state.stop().await;

        assert!(state.capture_rect().await.is_err());
    }

    #[tokio::test]
    async fn validated_capture_surface_is_set_and_cleared_with_session_lifecycle() {
        let state = RemoteSessionState::default();
        let surface = ValidatedCaptureSurface {
            surface_kind: capture::NATIVE_CAPTURE_SURFACE_KIND_EASYCRIS_WINDOW.to_string(),
            frame_width: 1280,
            frame_height: 720,
            screen_rect: ScreenRect {
                left: 10,
                top: 20,
                width: 1280,
                height: 720,
            },
            window_hwnd: Some(44),
            validated_at_unix_ms: 1234,
        };

        assert!(state.validated_capture_surface().await.is_err());

        state.start(host_identity()).await.unwrap();
        state.set_validated_capture_surface(surface.clone()).await;

        assert_eq!(state.capture_rect().await.unwrap(), surface.screen_rect);
        assert_eq!(state.validated_capture_surface().await.unwrap(), surface);

        state.stop().await;

        assert!(state.capture_rect().await.is_err());
        assert!(state.validated_capture_surface().await.is_err());
    }

    #[tokio::test]
    async fn plain_capture_rect_clears_validated_capture_surface() {
        let state = RemoteSessionState::default();
        let surface = ValidatedCaptureSurface {
            surface_kind: capture::NATIVE_CAPTURE_SURFACE_KIND_EASYCRIS_WINDOW.to_string(),
            frame_width: 1280,
            frame_height: 720,
            screen_rect: ScreenRect {
                left: 10,
                top: 20,
                width: 1280,
                height: 720,
            },
            window_hwnd: Some(44),
            validated_at_unix_ms: 1234,
        };
        let fallback_rect = ScreenRect {
            left: 30,
            top: 40,
            width: 640,
            height: 480,
        };

        state.start(host_identity()).await.unwrap();
        state.set_validated_capture_surface(surface).await;
        state.set_capture_rect(fallback_rect).await;

        assert_eq!(state.capture_rect().await.unwrap(), fallback_rect);
        assert!(state.validated_capture_surface().await.is_err());
    }

    #[tokio::test]
    async fn stop_native_capture_without_active_handle_clears_validated_capture_surface() {
        let state = RemoteSessionState::default();
        let surface = ValidatedCaptureSurface {
            surface_kind: capture::NATIVE_CAPTURE_SURFACE_KIND_EASYCRIS_WINDOW.to_string(),
            frame_width: 1280,
            frame_height: 720,
            screen_rect: ScreenRect {
                left: 10,
                top: 20,
                width: 1280,
                height: 720,
            },
            window_hwnd: Some(44),
            validated_at_unix_ms: 1234,
        };

        state.start(host_identity()).await.unwrap();
        state.set_validated_capture_surface(surface).await;

        state
            .stop_native_capture("missing-capture".to_string())
            .await
            .unwrap();

        assert!(state.capture_rect().await.is_err());
        assert!(state.validated_capture_surface().await.is_err());
    }

    #[tokio::test]
    async fn lan_restart_uses_fresh_remote_input_handle() {
        let state = RemoteSessionState::default();

        state.start(host_identity()).await.unwrap();
        let first = state.remote_input_handle().await.unwrap();
        state.stop().await;
        assert!(first.can_lock_for_test().is_err());

        state.start(host_identity()).await.unwrap();
        let second = state.remote_input_handle().await.unwrap();

        assert!(!first.ptr_eq(&second));
        state.stop().await;
    }

    #[test]
    fn cloud_invite_debug_redacts_host_secret() {
        let debug = format!("{:?}", cloud_invite());

        assert!(!debug.contains("host-secret"));
        assert!(debug.contains("<redacted>"));
    }

    #[tokio::test]
    async fn cloud_pending_guest_can_be_approved_for_input() {
        let state = RemoteSessionState::default();
        state
            .start_cloud(host_identity(), cloud_invite())
            .await
            .unwrap();
        state
            .set_pending_guest(RemoteSessionJoinRequest {
                session_id: "rmt_test".to_string(),
                guest_display_name: "Guest".to_string(),
                guest_device_id: "guest-device".to_string(),
                guest_ip: None,
            })
            .await
            .unwrap();
        let status = state
            .approve_guest(RemoteControlPermission {
                session_id: "rmt_test".to_string(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        assert!(status.approved_control);
        assert_eq!(
            status.approved_guest.unwrap().guest_device_id,
            "guest-device"
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn input_is_rejected_without_approval() {
        let state = RemoteSessionState::default();
        let status = state.start(host_identity()).await.unwrap().status;
        let session_id = status.current_session.unwrap().session_id;

        let event = RemoteInputKeyEvent {
            session_id,
            guest_device_id: "guest-device".to_string(),
            key: RemoteKey::Character("a".to_string()),
            action: super::super::types::RemoteKeyAction::Click,
            modifiers: super::super::types::RemoteInputModifiers::default(),
        };

        let result = state.ensure_key_allowed(&event).await;
        assert_eq!(result.unwrap_err(), "Remote control is not approved");
        state.stop().await;
    }

    #[tokio::test]
    async fn wrong_session_is_rejected() {
        let state = RemoteSessionState::default();
        state.start(host_identity()).await.unwrap();

        let event = RemoteInputKeyEvent {
            session_id: "wrong-session".to_string(),
            guest_device_id: "guest-device".to_string(),
            key: RemoteKey::Character("a".to_string()),
            action: super::super::types::RemoteKeyAction::Click,
            modifiers: super::super::types::RemoteInputModifiers::default(),
        };

        let result = state.ensure_key_allowed(&event).await;
        assert_eq!(
            result.unwrap_err(),
            "Remote session id does not match active session"
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn revoked_session_is_rejected_first() {
        let state = RemoteSessionState::default();
        let status = state.start(host_identity()).await.unwrap().status;
        let session_id = status.current_session.unwrap().session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let press = RemoteInputKeyEvent {
            session_id: session_id.clone(),
            guest_device_id: "guest-device".to_string(),
            key: RemoteKey::Character("a".to_string()),
            action: super::super::types::RemoteKeyAction::Down,
            modifiers: super::super::types::RemoteInputModifiers::default(),
        };
        state.ensure_key_allowed(&press).await.unwrap();

        state
            .revoke_control(session_id.clone(), None)
            .await
            .unwrap();

        let result = state.ensure_key_allowed(&press).await;
        assert_eq!(result.unwrap_err(), "Remote control has been revoked");

        let release = RemoteInputKeyEvent {
            action: super::super::types::RemoteKeyAction::Up,
            ..press
        };
        state.ensure_key_allowed(&release).await.unwrap();
    }

    #[tokio::test]
    async fn approved_guest_input_is_allowed() {
        let state = RemoteSessionState::default();
        let status = state.start(host_identity()).await.unwrap().status;
        let session_id = status.current_session.unwrap().session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let event = RemoteInputKeyEvent {
            session_id,
            guest_device_id: "guest-device".to_string(),
            key: RemoteKey::Character("a".to_string()),
            action: super::super::types::RemoteKeyAction::Click,
            modifiers: super::super::types::RemoteInputModifiers::default(),
        };

        state.ensure_key_allowed(&event).await.unwrap();
        state.stop().await;
    }

    #[tokio::test]
    async fn view_only_guest_release_input_is_rejected() {
        let state = RemoteSessionState::default();
        let status = state.start(host_identity()).await.unwrap().status;
        let session_id = status.current_session.unwrap().session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: false,
            })
            .await
            .unwrap();

        let release = RemoteInputKeyEvent {
            session_id,
            guest_device_id: "guest-device".to_string(),
            key: RemoteKey::Character("a".to_string()),
            action: super::super::types::RemoteKeyAction::Up,
            modifiers: super::super::types::RemoteInputModifiers::default(),
        };

        let result = state.ensure_key_allowed(&release).await;
        assert_eq!(result.unwrap_err(), "Remote control is not approved");
        state.stop().await;
    }

    #[tokio::test]
    async fn view_only_current_approval_does_not_inherit_release_drain() {
        let state = RemoteSessionState::default();
        let status = state.start(host_identity()).await.unwrap().status;
        let session_id = status.current_session.unwrap().session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: false,
            })
            .await
            .unwrap();

        let release = RemoteInputKeyEvent {
            session_id,
            guest_device_id: "guest-device".to_string(),
            key: RemoteKey::Character("a".to_string()),
            action: super::super::types::RemoteKeyAction::Up,
            modifiers: super::super::types::RemoteInputModifiers::default(),
        };

        let result = state.ensure_key_allowed(&release).await;
        assert_eq!(result.unwrap_err(), "Remote control is not approved");
        state.stop().await;
    }

    #[tokio::test]
    async fn revoked_release_input_requires_same_approved_guest() {
        let state = RemoteSessionState::default();
        let status = state.start(host_identity()).await.unwrap().status;
        let session_id = status.current_session.unwrap().session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();
        state
            .revoke_control(session_id.clone(), None)
            .await
            .unwrap();

        let release = RemoteInputKeyEvent {
            session_id,
            guest_device_id: "other-guest".to_string(),
            key: RemoteKey::Character("a".to_string()),
            action: super::super::types::RemoteKeyAction::Up,
            modifiers: super::super::types::RemoteInputModifiers::default(),
        };

        let result = state.ensure_key_allowed(&release).await;
        assert_eq!(
            result.unwrap_err(),
            "Remote input guest does not match approved guest"
        );
    }

    #[tokio::test]
    async fn remote_input_rate_limit_rejects_excess_non_release_events() {
        let state = RemoteSessionState::default();
        let status = state.start(host_identity()).await.unwrap().status;
        let session_id = status.current_session.unwrap().session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let event = RemoteInputKeyEvent {
            session_id: session_id.clone(),
            guest_device_id: "guest-device".to_string(),
            key: RemoteKey::Character("a".to_string()),
            action: super::super::types::RemoteKeyAction::Click,
            modifiers: super::super::types::RemoteInputModifiers::default(),
        };

        {
            let mut inner = state.inner.lock().await;
            inner.input_rate_window_started_at = Some(Instant::now());
            inner.input_rate_count = REMOTE_INPUT_RATE_LIMIT;
        }

        let result = state.ensure_key_allowed(&event).await;
        assert_eq!(result.unwrap_err(), "Remote input rate limit exceeded");

        let release = RemoteInputKeyEvent {
            action: super::super::types::RemoteKeyAction::Up,
            ..event
        };
        state.ensure_key_allowed(&release).await.unwrap();
        state.stop().await;
    }

    #[tokio::test]
    async fn remote_input_rate_limit_anchors_window_on_first_event() {
        let state = RemoteSessionState::default();
        let status = state.start(host_identity()).await.unwrap().status;
        let session_id = status.current_session.unwrap().session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let event = RemoteInputKeyEvent {
            session_id,
            guest_device_id: "guest-device".to_string(),
            key: RemoteKey::Character("a".to_string()),
            action: super::super::types::RemoteKeyAction::Click,
            modifiers: super::super::types::RemoteInputModifiers::default(),
        };

        state.ensure_key_allowed(&event).await.unwrap();

        let inner = state.inner.lock().await;
        assert!(inner.input_rate_window_started_at.is_some());
    }

    #[tokio::test]
    async fn remote_input_rate_limit_resets_after_window_expires() {
        let state = RemoteSessionState::default();
        let status = state.start(host_identity()).await.unwrap().status;
        let session_id = status.current_session.unwrap().session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        {
            let mut inner = state.inner.lock().await;
            inner.input_rate_window_started_at =
                Some(Instant::now() - REMOTE_INPUT_RATE_WINDOW - Duration::from_millis(1));
            inner.input_rate_count = REMOTE_INPUT_RATE_LIMIT;
        }

        let event = RemoteInputKeyEvent {
            session_id,
            guest_device_id: "guest-device".to_string(),
            key: RemoteKey::Character("a".to_string()),
            action: super::super::types::RemoteKeyAction::Click,
            modifiers: super::super::types::RemoteInputModifiers::default(),
        };

        state.ensure_key_allowed(&event).await.unwrap();
    }

    #[tokio::test]
    async fn wrong_guest_is_rejected() {
        let state = RemoteSessionState::default();
        let status = state.start(host_identity()).await.unwrap().status;
        let session_id = status.current_session.unwrap().session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let event = RemoteInputKeyEvent {
            session_id,
            guest_device_id: "other-guest".to_string(),
            key: RemoteKey::Character("a".to_string()),
            action: super::super::types::RemoteKeyAction::Click,
            modifiers: super::super::types::RemoteInputModifiers::default(),
        };

        let result = state.ensure_key_allowed(&event).await;
        assert_eq!(
            result.unwrap_err(),
            "Remote input guest does not match approved guest"
        );
        state.stop().await;
    }

    #[test]
    fn malformed_mouse_coordinates_are_rejected() {
        let event = RemoteInputMouseEvent {
            session_id: "session".to_string(),
            guest_device_id: "guest-device".to_string(),
            normalized_x: f64::NAN,
            normalized_y: 0.5,
            source_width: 1280,
            source_height: 720,
            target_left: None,
            target_top: None,
            target_width: None,
            target_height: None,
            action: super::super::types::RemoteMouseAction::Move,
            button: None,
            modifiers: super::super::types::RemoteInputModifiers::default(),
            wheel_delta_x: None,
            wheel_delta_y: None,
        };

        let result = validate_mouse_event(&event);
        assert_eq!(
            result.unwrap_err(),
            "Remote mouse coordinates must be finite"
        );
    }

    #[test]
    fn mouse_event_does_not_require_guest_supplied_target_geometry() {
        let event = RemoteInputMouseEvent {
            session_id: "session".to_string(),
            guest_device_id: "guest-device".to_string(),
            normalized_x: 0.5,
            normalized_y: 0.25,
            source_width: 320,
            source_height: 180,
            target_left: None,
            target_top: None,
            target_width: None,
            target_height: None,
            action: super::super::types::RemoteMouseAction::Move,
            button: None,
            modifiers: super::super::types::RemoteInputModifiers::default(),
            wheel_delta_x: None,
            wheel_delta_y: None,
        };

        assert!(validate_mouse_event(&event).is_ok());
    }

    async fn add_pending_guest(
        state: &RemoteSessionState,
        session_id: &str,
        guest_device_id: &str,
    ) {
        let mut inner = state.inner.lock().await;
        inner.pending_guest = Some(RemoteSessionJoinRequest {
            session_id: session_id.to_string(),
            guest_display_name: "Guest".to_string(),
            guest_device_id: guest_device_id.to_string(),
            guest_ip: Some("192.168.1.2".to_string()),
        });
        inner.guest_sender = Some(test_sender());
        inner.guest_connection_id = Some(GUEST_CONNECTION_ID.to_string());
        if let Some(session) = inner.current_session.as_mut() {
            session.phase = RemoteSessionPhase::PendingApproval;
        }
    }

    #[tokio::test]
    async fn second_start_is_rejected() {
        let state = RemoteSessionState::default();
        state.start(host_identity()).await.unwrap();

        let result = state.start(host_identity()).await;

        assert_eq!(
            result.unwrap_err(),
            "Remote session is already active".to_string()
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn join_request_is_forwarded_to_registered_host() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;
        let (host_sender, host_messages) = SignalingPeerSender::memory();

        let host_response = state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                host_sender,
            )
            .await;
        assert_eq!(
            host_response,
            SignalingServerMessage::HostRegistered {
                session_id: session_id.clone()
            }
        );

        let response = state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest".to_string(),
                    guest_device_id: "guest-device".to_string(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;

        let expected = SignalingServerMessage::JoinPending {
            session_id,
            guest_device_id: "guest-device".to_string(),
        };
        assert_eq!(response, expected);
        assert_eq!(host_messages.lock().await.as_slice(), &[expected]);
        state.stop().await;
    }

    #[tokio::test]
    async fn join_request_before_host_register_is_rejected() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;

        let response = state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest".to_string(),
                    guest_device_id: "guest-device".to_string(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;
        let status = state.status().await;

        assert_eq!(
            response,
            SignalingServerMessage::JoinRejected {
                session_id,
                reason: "Remote-session host is not connected".to_string(),
            }
        );
        assert!(status.pending_guest.is_none());
        state.stop().await;
    }

    #[tokio::test]
    async fn host_register_must_be_loopback() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;

        let response = state
            .handle_signaling_message(
                "192.168.1.10".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::JoinRejected {
                session_id,
                reason: "Host signaling registration must originate from this device".to_string()
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn duplicate_host_register_is_rejected() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;

        state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;
        let response = state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                "second-host-connection".to_string(),
                None,
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::JoinRejected {
                session_id,
                reason: "Remote-session host is already registered".to_string()
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn stale_host_unregister_does_not_clear_active_host_sender() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;
        let (host_sender, host_messages) = SignalingPeerSender::memory();

        state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                host_sender,
            )
            .await;
        state
            .unregister_signaling_peer(&SignalingPeerContext {
                session_id: session_id.clone(),
                connection_id: "stale-host-connection".to_string(),
                role: SignalingPeerRole::Host,
                guest_device_id: None,
            })
            .await;

        state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest".to_string(),
                    guest_device_id: "guest-device".to_string(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;

        assert_eq!(
            host_messages.lock().await.as_slice(),
            &[SignalingServerMessage::JoinPending {
                session_id,
                guest_device_id: "guest-device".to_string()
            }]
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn pending_guest_unregister_clears_state_and_notifies_host() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;
        let (host_sender, host_messages) = SignalingPeerSender::memory();
        let (guest_sender, _guest_messages) = SignalingPeerSender::memory();

        state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                host_sender,
            )
            .await;
        state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token.clone(),
                    guest_display_name: "Guest".to_string(),
                    guest_device_id: "guest-device".to_string(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                guest_sender,
            )
            .await;

        state
            .unregister_signaling_peer(&SignalingPeerContext {
                session_id: session_id.clone(),
                connection_id: GUEST_CONNECTION_ID.to_string(),
                role: SignalingPeerRole::Guest,
                guest_device_id: Some("guest-device".to_string()),
            })
            .await;

        let status = state.status().await;
        assert!(status.pending_guest.is_none());
        assert!(status.approved_guest.is_none());
        assert_eq!(
            status.current_session.as_ref().unwrap().status,
            RemoteSessionPhase::Listening
        );
        assert_eq!(
            host_messages.lock().await.as_slice(),
            &[
                SignalingServerMessage::JoinPending {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string()
                },
                SignalingServerMessage::GuestDisconnected {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string()
                }
            ]
        );

        let response = state
            .handle_signaling_message(
                "192.168.1.3".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest 2".to_string(),
                    guest_device_id: "guest-two".to_string(),
                },
                "guest-two-connection".to_string(),
                None,
                test_sender(),
            )
            .await;
        assert_eq!(
            response,
            SignalingServerMessage::JoinPending {
                session_id,
                guest_device_id: "guest-two".to_string()
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn approved_guest_unregister_clears_control_and_notifies_host() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;
        let (host_sender, host_messages) = SignalingPeerSender::memory();
        let (guest_sender, _guest_messages) = SignalingPeerSender::memory();

        state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                host_sender,
            )
            .await;
        state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest".to_string(),
                    guest_device_id: "guest-device".to_string(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                guest_sender,
            )
            .await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        state
            .unregister_signaling_peer(&SignalingPeerContext {
                session_id: session_id.clone(),
                connection_id: GUEST_CONNECTION_ID.to_string(),
                role: SignalingPeerRole::Guest,
                guest_device_id: Some("guest-device".to_string()),
            })
            .await;

        let status = state.status().await;
        assert!(status.pending_guest.is_none());
        assert!(status.approved_guest.is_none());
        assert!(!status.approved_control);
        assert_eq!(
            status.current_session.as_ref().unwrap().status,
            RemoteSessionPhase::Listening
        );
        state
            .ensure_key_allowed(&RemoteInputKeyEvent {
                action: RemoteKeyAction::Up,
                guest_device_id: "guest-device".to_string(),
                key: RemoteKey::Character("a".to_string()),
                modifiers: Default::default(),
                session_id: session_id.clone(),
            })
            .await
            .expect("release input should drain after guest disconnect");
        assert_eq!(
            host_messages.lock().await.as_slice(),
            &[
                SignalingServerMessage::JoinPending {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string()
                },
                SignalingServerMessage::GuestDisconnected {
                    session_id,
                    guest_device_id: "guest-device".to_string()
                }
            ]
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn stale_guest_unregister_does_not_reset_phase_or_notify_host() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;
        let (host_sender, host_messages) = SignalingPeerSender::memory();
        let (guest_sender, _guest_messages) = SignalingPeerSender::memory();

        state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                host_sender,
            )
            .await;
        state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest".to_string(),
                    guest_device_id: "guest-device".to_string(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                guest_sender,
            )
            .await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        state
            .unregister_signaling_peer(&SignalingPeerContext {
                session_id: session_id.clone(),
                connection_id: GUEST_CONNECTION_ID.to_string(),
                role: SignalingPeerRole::Guest,
                guest_device_id: Some("stale-guest".to_string()),
            })
            .await;

        let status = state.status().await;
        assert!(status.pending_guest.is_none());
        assert_eq!(
            status.approved_guest.as_ref().unwrap().guest_device_id,
            "guest-device"
        );
        assert!(status.approved_control);
        assert_eq!(
            status.current_session.as_ref().unwrap().status,
            RemoteSessionPhase::Connected
        );
        assert_eq!(
            host_messages.lock().await.as_slice(),
            &[SignalingServerMessage::JoinPending {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string()
            }]
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn host_video_offer_is_forwarded_to_approved_guest() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;
        let (guest_sender, guest_messages) = SignalingPeerSender::memory();

        state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;
        state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest".to_string(),
                    guest_device_id: "guest-device".to_string(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                guest_sender,
            )
            .await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let response = state
            .handle_signaling_message(
                "192.168.1.1".parse().unwrap(),
                SignalingClientMessage::VideoOffer {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string(),
                    payload: serde_json::json!({ "sdp": "offer" }),
                },
                HOST_CONNECTION_ID.to_string(),
                Some(host_context(&session_id)),
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::SignalAccepted {
                session_id: session_id.clone()
            }
        );
        assert_eq!(
            guest_messages.lock().await.as_slice(),
            &[
                SignalingServerMessage::JoinApproved {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string(),
                    host_device_id: "host-device".to_string()
                },
                SignalingServerMessage::VideoOffer {
                    session_id,
                    guest_device_id: "guest-device".to_string(),
                    payload: serde_json::json!({ "sdp": "offer" }),
                }
            ]
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn video_offer_errors_when_approved_guest_sender_is_missing() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;

        state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();
        state.inner.lock().await.guest_sender = None;

        let response = state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::VideoOffer {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string(),
                    payload: serde_json::json!({ "sdp": "offer" }),
                },
                HOST_CONNECTION_ID.to_string(),
                Some(host_context(&session_id)),
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::JoinRejected {
                session_id,
                reason: "Approved guest signaling connection is not available".to_string(),
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn guest_video_answer_is_forwarded_to_registered_host() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;
        let (host_sender, host_messages) = SignalingPeerSender::memory();

        state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                host_sender,
            )
            .await;
        state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest".to_string(),
                    guest_device_id: "guest-device".to_string(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let response = state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::VideoAnswer {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string(),
                    payload: serde_json::json!({ "sdp": "answer" }),
                },
                GUEST_CONNECTION_ID.to_string(),
                Some(guest_context(&session_id, "guest-device")),
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::SignalAccepted {
                session_id: session_id.clone()
            }
        );
        assert_eq!(
            host_messages.lock().await.as_slice(),
            &[
                SignalingServerMessage::JoinPending {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string()
                },
                SignalingServerMessage::VideoAnswer {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string(),
                    payload: serde_json::json!({ "sdp": "answer" }),
                }
            ]
        );

        state.stop().await;
    }

    #[tokio::test]
    async fn video_answer_errors_when_host_sender_is_missing() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let response = state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::VideoAnswer {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string(),
                    payload: serde_json::json!({ "sdp": "answer" }),
                },
                GUEST_CONNECTION_ID.to_string(),
                Some(guest_context(&session_id, "guest-device")),
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::JoinRejected {
                session_id,
                reason: "Host signaling connection is not available".to_string(),
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn host_ice_candidate_is_forwarded_to_guest() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;
        let (guest_sender, guest_messages) = SignalingPeerSender::memory();

        state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;
        state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest".to_string(),
                    guest_device_id: "guest-device".to_string(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                guest_sender,
            )
            .await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let response = state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::IceCandidate {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string(),
                    payload: serde_json::json!({ "candidate": "candidate" }),
                },
                HOST_CONNECTION_ID.to_string(),
                Some(host_context(&session_id)),
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::SignalAccepted {
                session_id: session_id.clone()
            }
        );
        assert_eq!(
            guest_messages.lock().await.as_slice(),
            &[
                SignalingServerMessage::JoinApproved {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string(),
                    host_device_id: "host-device".to_string()
                },
                SignalingServerMessage::IceCandidate {
                    session_id,
                    guest_device_id: "guest-device".to_string(),
                    payload: serde_json::json!({ "candidate": "candidate" }),
                }
            ]
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn host_ice_candidate_is_accepted_when_approved_guest_sender_is_missing() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;

        state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();
        state.inner.lock().await.guest_sender = None;

        let response = state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::IceCandidate {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string(),
                    payload: serde_json::json!({ "candidate": "candidate" }),
                },
                HOST_CONNECTION_ID.to_string(),
                Some(host_context(&session_id)),
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::SignalAccepted {
                session_id: session_id.clone()
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn guest_ice_candidate_is_accepted_when_host_sender_is_missing() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let response = state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::IceCandidate {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string(),
                    payload: serde_json::json!({ "candidate": "candidate" }),
                },
                GUEST_CONNECTION_ID.to_string(),
                Some(guest_context(&session_id, "guest-device")),
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::SignalAccepted {
                session_id: session_id.clone()
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn unregistered_ice_candidate_is_rejected() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let response = state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::IceCandidate {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string(),
                    payload: serde_json::json!({ "candidate": "candidate" }),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::JoinRejected {
                session_id,
                reason: "Unregistered signaling peer cannot send candidates".to_string(),
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn guest_signaling_must_match_approved_guest() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let response = state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::VideoAnswer {
                    session_id: session_id.clone(),
                    guest_device_id: "other-guest".to_string(),
                    payload: serde_json::json!({ "sdp": "answer" }),
                },
                GUEST_CONNECTION_ID.to_string(),
                Some(guest_context(&session_id, "other-guest")),
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::JoinRejected {
                session_id,
                reason: "Signaling guest does not match approved guest".to_string(),
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn only_host_can_revoke_over_signaling() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;

        let response = state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::SessionRevoked {
                    session_id: session_id.clone(),
                    reason: Some("ended".to_string()),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::JoinRejected {
                session_id,
                reason: "Only the registered host can send this signaling message".to_string(),
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn unauthenticated_heartbeat_is_rejected() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;

        let response = state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::Heartbeat {
                    session_id: session_id.clone(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::JoinRejected {
                session_id,
                reason: "Unregistered signaling peer cannot send heartbeat".to_string(),
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn authenticated_host_heartbeat_is_allowed() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;

        state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;
        let response = state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::Heartbeat {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                Some(host_context(&session_id)),
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::HeartbeatAck { session_id }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn host_revoke_is_forwarded_to_guest_and_clears_state() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;
        let (guest_sender, guest_messages) = SignalingPeerSender::memory();

        state
            .handle_signaling_message(
                "127.0.0.1".parse().unwrap(),
                SignalingClientMessage::HostRegister {
                    session_id: session_id.clone(),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;
        state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest".to_string(),
                    guest_device_id: "guest-device".to_string(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                guest_sender,
            )
            .await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();
        state.inner.lock().await.session_limit_task = Some(SessionLimitTask(tokio::spawn(async {
            std::future::pending::<()>().await;
        })));

        let response = state
            .handle_signaling_message(
                "192.168.1.1".parse().unwrap(),
                SignalingClientMessage::SessionRevoked {
                    session_id: session_id.clone(),
                    reason: Some("ended".to_string()),
                },
                HOST_CONNECTION_ID.to_string(),
                Some(host_context(&session_id)),
                test_sender(),
            )
            .await;
        let status = state.status().await;

        assert_eq!(
            response,
            SignalingServerMessage::SessionRevoked {
                session_id: session_id.clone(),
                reason: Some("ended".to_string()),
            }
        );
        assert_eq!(
            guest_messages.lock().await.as_slice(),
            &[
                SignalingServerMessage::JoinApproved {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string(),
                    host_device_id: "host-device".to_string()
                },
                SignalingServerMessage::SessionRevoked {
                    session_id: session_id.clone(),
                    reason: Some("ended".to_string()),
                }
            ]
        );
        assert!(status.approved_guest.is_none());
        assert!(status.pending_guest.is_none());
        assert!(!status.approved_control);
        assert!(state.inner.lock().await.signaling_server_handle.is_none());
        assert!(state.inner.lock().await.session_limit_task.is_none());
        assert_eq!(
            state
                .inner
                .lock()
                .await
                .current_session
                .as_ref()
                .map(|session| session.phase.clone()),
            Some(RemoteSessionPhase::Revoked)
        );
    }

    #[tokio::test]
    async fn reject_guest_requires_matching_pending_guest() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;

        let result = state
            .reject_guest(RemoteGuestRejection {
                session_id,
                guest_device_id: "other-guest".to_string(),
            })
            .await;

        assert_eq!(
            result.unwrap_err(),
            "Pending guest does not match rejection request"
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn join_with_wrong_token_is_rejected() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;

        let response = state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: "wrong-token".to_string(),
                    guest_display_name: "Guest".to_string(),
                    guest_device_id: "guest-device".to_string(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::JoinRejected {
                session_id,
                reason: "Invalid remote-session token".to_string()
            }
        );
        state.stop().await;
    }

    #[test]
    fn constant_time_token_compare_preserves_equality_semantics() {
        assert!(constant_time_str_eq("invite-token", "invite-token"));
        assert!(!constant_time_str_eq("invite-token", "wrong-token"));
        assert!(!constant_time_str_eq("invite-token", "invite-token\n"));
    }

    #[tokio::test]
    async fn expired_token_is_rejected() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;
        {
            let mut inner = state.inner.lock().await;
            let session = inner.current_session.as_mut().unwrap();
            session.token_expires_at = SystemTime::now() - Duration::from_secs(1);
        }

        let response = state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest".to_string(),
                    guest_device_id: "guest-device".to_string(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::JoinRejected {
                session_id,
                reason: "Remote-session token has expired".to_string()
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn second_guest_is_rejected_while_pending() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;
        add_pending_guest(&state, &session_id, "guest-one").await;

        let response = state
            .handle_signaling_message(
                "192.168.1.3".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest 2".to_string(),
                    guest_device_id: "guest-two".to_string(),
                },
                "guest-two-connection".to_string(),
                None,
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::JoinRejected {
                session_id,
                reason: "A remote-session guest is already pending or approved".to_string()
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn second_guest_is_rejected_while_approved() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;
        add_pending_guest(&state, &session_id, "guest-one").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-one".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let response = state
            .handle_signaling_message(
                "192.168.1.3".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest 2".to_string(),
                    guest_device_id: "guest-two".to_string(),
                },
                "guest-two-connection".to_string(),
                None,
                test_sender(),
            )
            .await;

        assert_eq!(
            response,
            SignalingServerMessage::JoinRejected {
                session_id,
                reason: "A remote-session guest is already pending or approved".to_string()
            }
        );
        state.stop().await;
    }

    #[tokio::test]
    async fn revoked_session_rejects_join_and_signaling() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        let invite_token = result.invite.invite_token;
        state
            .revoke_control(session_id.clone(), None)
            .await
            .unwrap();

        let join_response = state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::JoinRequest {
                    session_id: session_id.clone(),
                    token: invite_token,
                    guest_display_name: "Guest".to_string(),
                    guest_device_id: "guest-device".to_string(),
                },
                GUEST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;
        let signal_response = state
            .handle_signaling_message(
                "192.168.1.2".parse().unwrap(),
                SignalingClientMessage::VideoOffer {
                    session_id: session_id.clone(),
                    guest_device_id: "guest-device".to_string(),
                    payload: serde_json::json!({ "sdp": "test" }),
                },
                HOST_CONNECTION_ID.to_string(),
                None,
                test_sender(),
            )
            .await;

        let expected = SignalingServerMessage::JoinRejected {
            session_id,
            reason: "Remote session has been revoked".to_string(),
        };
        assert_eq!(join_response, expected);
        assert_eq!(signal_response, expected);
    }

    #[tokio::test]
    async fn revoke_clears_approved_guest() {
        let state = RemoteSessionState::default();
        let result = state.start(host_identity()).await.unwrap();
        let session_id = result.invite.session_id;
        add_pending_guest(&state, &session_id, "guest-device").await;
        state
            .approve_guest(RemoteControlPermission {
                session_id: session_id.clone(),
                guest_device_id: "guest-device".to_string(),
                can_control: true,
            })
            .await
            .unwrap();

        let status = state.revoke_control(session_id, None).await.unwrap();

        assert!(status.approved_guest.is_none());
        assert!(status.pending_guest.is_none());
        assert!(!status.approved_control);
    }
}
