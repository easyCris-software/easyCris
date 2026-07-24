use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct InviteResponse {
    pub invite_id: String,
    pub guest_token: String,
    pub host_secret: String,
    pub share_url: String,
    pub relay_url: String,
    pub expires_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicInviteMetadata {
    pub invite_id: String,
    pub relay_url: String,
    pub expires_at_unix_ms: u64,
    pub status: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct CreateInviteRequest {
    pub host_device_id: Option<String>,
    pub host_display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    HostRegister {
        invite_id: String,
        host_secret: String,
    },
    JoinRequest {
        invite_id: String,
        token: String,
        guest_display_name: String,
        guest_device_id: String,
    },
    JoinApproved {
        invite_id: String,
        guest_device_id: String,
    },
    JoinRejected {
        invite_id: String,
        guest_device_id: String,
        reason: String,
    },
    VideoOffer {
        invite_id: String,
        guest_device_id: String,
        payload: Value,
    },
    VideoAnswer {
        invite_id: String,
        guest_device_id: String,
        payload: Value,
    },
    IceCandidate {
        invite_id: String,
        guest_device_id: String,
        payload: Value,
    },
    SessionRevoked {
        invite_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Heartbeat {
        invite_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    HostRegistered {
        invite_id: String,
    },
    JoinRequest {
        invite_id: String,
        guest_display_name: String,
        guest_device_id: String,
    },
    JoinApproved {
        invite_id: String,
        guest_device_id: String,
        host_device_id: Option<String>,
    },
    JoinRejected {
        invite_id: String,
        guest_device_id: String,
        reason: String,
    },
    VideoOffer {
        invite_id: String,
        guest_device_id: String,
        payload: Value,
    },
    VideoAnswer {
        invite_id: String,
        guest_device_id: String,
        payload: Value,
    },
    IceCandidate {
        invite_id: String,
        guest_device_id: String,
        payload: Value,
    },
    SessionRevoked {
        invite_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    GuestDisconnected {
        invite_id: String,
        guest_device_id: String,
    },
    HostDisconnected {
        invite_id: String,
    },
    HeartbeatAck {
        invite_id: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum IceConfigRequest {
    Host {
        invite_id: String,
        host_secret: String,
    },
    Guest {
        invite_id: String,
        guest_token: String,
        guest_device_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IceConfigResponse {
    #[serde(rename = "iceServers")]
    pub ice_servers: Vec<IceServer>,
    #[serde(rename = "lifetimeDuration")]
    pub lifetime_duration: String,
}
