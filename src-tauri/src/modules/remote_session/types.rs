use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteSessionPhase {
    Idle,
    Listening,
    PendingApproval,
    Connected,
    Revoked,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteSessionMode {
    Lan,
    Cloud,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteSessionIdentity {
    pub display_name: String,
    pub device_id: String,
    pub account_email: Option<String>,
    pub is_guest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteSessionInfo {
    pub session_id: String,
    pub invite_token_preview: String,
    pub signaling_port: Option<u16>,
    pub host_candidates: Vec<String>,
    pub mode: RemoteSessionMode,
    pub host_display_name: String,
    pub host_device_id: String,
    pub guest_display_name: Option<String>,
    pub guest_device_id: Option<String>,
    pub status: RemoteSessionPhase,
    pub can_control: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteSessionJoinRequest {
    pub session_id: String,
    pub guest_display_name: String,
    pub guest_device_id: String,
    pub guest_ip: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteSessionGuestSummary {
    pub guest_display_name: String,
    pub guest_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteControlPermission {
    pub session_id: String,
    pub guest_device_id: String,
    pub can_control: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteGuestRejection {
    pub session_id: String,
    pub guest_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteSessionStatus {
    pub current_session: Option<RemoteSessionInfo>,
    pub pending_guest: Option<RemoteSessionGuestSummary>,
    pub approved_guest: Option<RemoteSessionGuestSummary>,
    pub approved_control: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RemoteSessionLimitEvent {
    pub session_id: String,
    pub seconds_remaining: u32,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteSessionInvite {
    pub session_id: String,
    pub invite_token: String,
    pub share_url: String,
    pub signaling_port: Option<u16>,
    pub host_candidates: Vec<String>,
    pub mode: RemoteSessionMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_secret: Option<String>,
    pub expires_at_unix_ms: u64,
}

impl std::fmt::Debug for RemoteSessionInvite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteSessionInvite")
            .field("session_id", &self.session_id)
            .field("invite_token", &"<redacted>")
            .field("share_url", &self.share_url)
            .field("signaling_port", &self.signaling_port)
            .field("host_candidates", &self.host_candidates)
            .field("mode", &self.mode)
            .field("relay_url", &self.relay_url)
            .field("invite_id", &self.invite_id)
            .field(
                "host_secret",
                &self.host_secret.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_at_unix_ms", &self.expires_at_unix_ms)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteSessionStartResult {
    pub status: RemoteSessionStatus,
    pub invite: RemoteSessionInvite,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteMouseAction {
    Move,
    Down,
    Up,
    Click,
    Wheel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteMouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteInputModifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RemoteInputMouseEvent {
    pub session_id: String,
    pub guest_device_id: String,
    pub normalized_x: f64,
    pub normalized_y: f64,
    pub source_width: u32,
    pub source_height: u32,
    #[serde(default)]
    pub target_left: Option<i32>,
    #[serde(default)]
    pub target_top: Option<i32>,
    #[serde(default)]
    pub target_width: Option<u32>,
    #[serde(default)]
    pub target_height: Option<u32>,
    pub action: RemoteMouseAction,
    pub button: Option<RemoteMouseButton>,
    pub modifiers: RemoteInputModifiers,
    #[serde(default)]
    pub wheel_delta_x: Option<f64>,
    #[serde(default)]
    pub wheel_delta_y: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteInputMouseResult {
    pub screen_x: i32,
    pub screen_y: i32,
    pub rect_left: i32,
    pub rect_top: i32,
    pub rect_width: i32,
    pub rect_height: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteKeyAction {
    Down,
    Up,
    Click,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteNamedKey {
    Enter,
    Escape,
    Tab,
    Backspace,
    Delete,
    Space,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum RemoteKey {
    Character(String),
    Named(RemoteNamedKey),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteInputKeyEvent {
    pub session_id: String,
    pub guest_device_id: String,
    pub key: RemoteKey,
    pub action: RemoteKeyAction,
    pub modifiers: RemoteInputModifiers,
}
