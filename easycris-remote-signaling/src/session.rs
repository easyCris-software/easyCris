use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha1::Sha1;
use sha2::Sha256;
use subtle::ConstantTimeEq;
use thiserror::Error;

use crate::protocol::{
    IceConfigRequest, IceConfigResponse, IceServer, InviteResponse, PublicInviteMetadata,
};

type HmacSha256 = Hmac<Sha256>;
type HmacSha1 = Hmac<Sha1>;

const INVITE_PREFIX: &str = "rmt_";
const INVITE_RATE_LIMIT_WINDOW: Duration = Duration::from_secs(3600);

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub invite_ttl: Duration,
    pub relay_url: String,
    pub public_base_url: String,
    pub hmac_key: Vec<u8>,
    pub stun_urls: Vec<String>,
    pub turn_urls: Vec<String>,
    pub turn_static_auth_secret: Option<String>,
    pub turn_credential_ttl: Duration,
    pub invite_rate_limit_per_hour: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SessionMetricsSnapshot {
    pub active_invites: usize,
    pub approved_sessions: usize,
    pub expired_invites: usize,
    pub pending_guests: usize,
    pub revoked_invites: usize,
    pub total_invites: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestIdentity {
    pub display_name: String,
    pub device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostIdentity {
    pub device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundRole {
    Host,
    Guest { device_id: String },
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum ForwardTarget {
    Host,
    Guest,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SessionError {
    #[error("invalid invite id")]
    InvalidInviteId,
    #[error("invite not found")]
    InviteNotFound,
    #[error("invite expired")]
    InviteExpired,
    #[error("invite revoked")]
    InviteRevoked,
    #[error("invalid token")]
    InvalidToken,
    #[error("host is not registered")]
    HostNotRegistered,
    #[error("guest is not connected")]
    GuestNotConnected,
    #[error("host is already registered")]
    DuplicateHost,
    #[error("guest already pending or approved")]
    DuplicateGuest,
    #[error("unknown guest")]
    UnknownGuest,
    #[error("guest is not approved")]
    GuestNotApproved,
    #[error("role is not allowed for this message")]
    RoleForbidden,
    #[error("invite rate limit exceeded")]
    RateLimited,
    #[error("clock error")]
    ClockError,
}

impl SessionError {
    pub fn is_fatal_for_socket(&self) -> bool {
        match self {
            // Non-fatal host absence: this can be an early guest timing race, a
            // failed hub pre-check, or a dead host channel. Report it on the
            // guest socket when possible instead of forcing another reconnect.
            SessionError::HostNotRegistered => false,
            // Non-fatal approval state mismatch: the guest may have sent signaling
            // before approval, or after rejection before its socket closed.
            SessionError::GuestNotApproved => false,
            // Non-fatal peer absence or input mismatch: report it without reconnecting.
            SessionError::GuestNotConnected | SessionError::UnknownGuest => false,
            // Non-fatal throttling: closing would amplify reconnect traffic.
            SessionError::RateLimited => false,
            // Fatal: the socket identity, invite lifetime, role binding, or
            // process clock is invalid, so later messages cannot recover safely.
            SessionError::InvalidInviteId
            | SessionError::InviteNotFound
            | SessionError::InviteExpired
            | SessionError::InviteRevoked
            | SessionError::InvalidToken
            | SessionError::DuplicateHost
            | SessionError::DuplicateGuest
            | SessionError::RoleForbidden
            | SessionError::ClockError => true,
        }
    }
}

#[derive(Debug, Clone)]
struct InviteRecord {
    invite_id: String,
    guest_token_digest: Vec<u8>,
    host_secret_digest: Vec<u8>,
    host_identity: HostIdentity,
    expires_at: SystemTime,
    host_registered: bool,
    pending_guest: Option<GuestIdentity>,
    approved_guest: Option<GuestIdentity>,
    revoked: bool,
}

impl InviteRecord {
    fn status_label(&self, now: SystemTime) -> &'static str {
        if self.revoked {
            "revoked"
        } else if self.expires_at <= now {
            "expired"
        } else if !self.host_registered {
            "created"
        } else if self.approved_guest.is_some() {
            "connected"
        } else if self.pending_guest.is_some() {
            "pending_approval"
        } else {
            "listening"
        }
    }
}

#[derive(Debug, Default)]
struct StoreInner {
    invites: HashMap<String, InviteRecord>,
    invite_creates_by_ip: HashMap<String, VecDeque<Instant>>,
}

#[derive(Debug)]
pub struct SessionStore {
    inner: std::sync::RwLock<StoreInner>,
    config: ServiceConfig,
}

impl SessionStore {
    pub fn new(config: ServiceConfig) -> Self {
        Self {
            inner: std::sync::RwLock::new(StoreInner::default()),
            config,
        }
    }

    #[cfg(test)]
    pub fn create_invite(&self, ip_key: &str) -> Result<InviteResponse, SessionError> {
        self.create_invite_for_host(
            ip_key,
            HostIdentity {
                device_id: String::new(),
            },
        )
    }

    pub fn create_invite_for_host(
        &self,
        ip_key: &str,
        host_identity: HostIdentity,
    ) -> Result<InviteResponse, SessionError> {
        let mut inner = self.inner.write().expect("session store poisoned");
        prune_stale_records(&mut inner);
        enforce_rate_limit(
            &mut inner.invite_creates_by_ip,
            ip_key,
            self.config.invite_rate_limit_per_hour,
        )?;

        let expires_at = SystemTime::now() + self.config.invite_ttl;
        let expires_at_unix_ms = unix_ms(expires_at)?;
        let guest_token = random_secret();
        let host_secret = random_secret();

        let invite_id = loop {
            let candidate = format!("{INVITE_PREFIX}{}", random_id());
            if !inner.invites.contains_key(&candidate) {
                break candidate;
            }
        };

        let share_url = format!(
            "{}/join/{}#token={}",
            self.config.public_base_url.trim_end_matches('/'),
            invite_id,
            guest_token
        );

        inner.invites.insert(
            invite_id.clone(),
            InviteRecord {
                invite_id: invite_id.clone(),
                guest_token_digest: digest_secret(&self.config.hmac_key, &guest_token),
                host_secret_digest: digest_secret(&self.config.hmac_key, &host_secret),
                host_identity,
                expires_at,
                host_registered: false,
                pending_guest: None,
                approved_guest: None,
                revoked: false,
            },
        );

        Ok(InviteResponse {
            invite_id,
            guest_token,
            host_secret,
            share_url,
            relay_url: self.config.relay_url.clone(),
            expires_at_unix_ms,
        })
    }

    pub fn host_device_id(&self, invite_id: &str) -> Result<String, SessionError> {
        validate_invite_id(invite_id)?;
        let inner = self.inner.read().expect("session store poisoned");
        let record = get_record(&inner, invite_id)?;
        Ok(record.host_identity.device_id.clone())
    }

    pub fn public_metadata(&self, invite_id: &str) -> Result<PublicInviteMetadata, SessionError> {
        validate_invite_id(invite_id)?;
        let inner = self.inner.read().expect("session store poisoned");
        let record = inner
            .invites
            .get(invite_id)
            .ok_or(SessionError::InviteNotFound)?;
        let now = SystemTime::now();
        Ok(PublicInviteMetadata {
            invite_id: record.invite_id.clone(),
            relay_url: self.config.relay_url.clone(),
            expires_at_unix_ms: unix_ms(record.expires_at)?,
            status: record.status_label(now).to_string(),
        })
    }

    pub fn metrics_snapshot(&self) -> SessionMetricsSnapshot {
        let inner = self.inner.read().expect("session store poisoned");
        let now = SystemTime::now();
        let mut snapshot = SessionMetricsSnapshot {
            active_invites: 0,
            approved_sessions: 0,
            expired_invites: 0,
            pending_guests: 0,
            revoked_invites: 0,
            total_invites: inner.invites.len(),
        };

        for record in inner.invites.values() {
            if record.revoked {
                snapshot.revoked_invites += 1;
            } else if record.expires_at <= now {
                snapshot.expired_invites += 1;
            } else {
                snapshot.active_invites += 1;
                if record.pending_guest.is_some() {
                    snapshot.pending_guests += 1;
                }
                if record.approved_guest.is_some() {
                    snapshot.approved_sessions += 1;
                }
            }
        }

        snapshot
    }

    pub fn prune_now(&self) {
        let mut inner = self.inner.write().expect("session store poisoned");
        prune_stale_records(&mut inner);
    }

    pub fn validate_signaling_upgrade(&self, invite_id: &str) -> Result<(), SessionError> {
        validate_invite_id(invite_id)?;
        let inner = self.inner.read().expect("session store poisoned");
        let record = inner
            .invites
            .get(invite_id)
            .ok_or(SessionError::InviteNotFound)?;
        ensure_active(record)?;
        Ok(())
    }

    pub fn register_host(&self, invite_id: &str, host_secret: &str) -> Result<(), SessionError> {
        validate_invite_id(invite_id)?;
        let mut inner = self.inner.write().expect("session store poisoned");
        let record = get_record_mut(&mut inner, invite_id)?;
        ensure_active(record)?;
        if !verify_secret(
            &self.config.hmac_key,
            host_secret,
            &record.host_secret_digest,
        ) {
            return Err(SessionError::InvalidToken);
        }
        record.host_registered = true;
        record.pending_guest = None;
        record.approved_guest = None;
        Ok(())
    }

    pub fn join_request(
        &self,
        invite_id: &str,
        guest_token: &str,
        guest: GuestIdentity,
    ) -> Result<(), SessionError> {
        validate_invite_id(invite_id)?;
        let mut inner = self.inner.write().expect("session store poisoned");
        let record = get_record_mut(&mut inner, invite_id)?;
        ensure_active(record)?;
        if !record.host_registered {
            return Err(SessionError::HostNotRegistered);
        }
        if !verify_secret(
            &self.config.hmac_key,
            guest_token,
            &record.guest_token_digest,
        ) {
            return Err(SessionError::InvalidToken);
        }
        if record.pending_guest.is_some() || record.approved_guest.is_some() {
            return Err(SessionError::DuplicateGuest);
        }
        record.pending_guest = Some(guest);
        Ok(())
    }

    pub fn approve_guest(
        &self,
        invite_id: &str,
        role: &BoundRole,
        guest_device_id: &str,
    ) -> Result<(), SessionError> {
        require_host(role)?;
        let mut inner = self.inner.write().expect("session store poisoned");
        let record = get_active_record_mut(&mut inner, invite_id)?;
        let pending = record
            .pending_guest
            .take()
            .ok_or(SessionError::UnknownGuest)?;
        if pending.device_id != guest_device_id {
            record.pending_guest = Some(pending);
            return Err(SessionError::UnknownGuest);
        }
        record.approved_guest = Some(pending);
        Ok(())
    }

    pub fn reject_guest(
        &self,
        invite_id: &str,
        role: &BoundRole,
        guest_device_id: &str,
    ) -> Result<(), SessionError> {
        require_host(role)?;
        let mut inner = self.inner.write().expect("session store poisoned");
        let record = get_active_record_mut(&mut inner, invite_id)?;
        match record.pending_guest.as_ref() {
            Some(guest) if guest.device_id == guest_device_id => {
                record.pending_guest = None;
                Ok(())
            }
            _ => Err(SessionError::UnknownGuest),
        }
    }

    pub fn disconnect_guest(
        &self,
        invite_id: &str,
        guest_device_id: &str,
    ) -> Result<bool, SessionError> {
        validate_invite_id(invite_id)?;
        let mut inner = self.inner.write().expect("session store poisoned");
        let record = get_record_mut(&mut inner, invite_id)?;
        let mut changed = false;
        if record
            .pending_guest
            .as_ref()
            .is_some_and(|guest| guest.device_id == guest_device_id)
        {
            record.pending_guest = None;
            changed = true;
        }
        if record
            .approved_guest
            .as_ref()
            .is_some_and(|guest| guest.device_id == guest_device_id)
        {
            record.approved_guest = None;
            changed = true;
        }
        Ok(changed)
    }

    pub fn disconnect_host(&self, invite_id: &str) -> Result<(), SessionError> {
        validate_invite_id(invite_id)?;
        let mut inner = self.inner.write().expect("session store poisoned");
        let record = get_record_mut(&mut inner, invite_id)?;
        record.host_registered = false;
        Ok(())
    }

    pub fn revoke(&self, invite_id: &str, role: &BoundRole) -> Result<(), SessionError> {
        require_host(role)?;
        let mut inner = self.inner.write().expect("session store poisoned");
        let record = get_record_mut(&mut inner, invite_id)?;
        record.revoked = true;
        record.pending_guest = None;
        record.approved_guest = None;
        Ok(())
    }

    pub fn authorize_offer(
        &self,
        invite_id: &str,
        role: &BoundRole,
        guest_device_id: &str,
    ) -> Result<(), SessionError> {
        require_host(role)?;
        self.ensure_approved_guest(invite_id, guest_device_id)
    }

    pub fn authorize_answer(
        &self,
        invite_id: &str,
        role: &BoundRole,
        guest_device_id: &str,
    ) -> Result<(), SessionError> {
        require_guest(role, guest_device_id)?;
        self.ensure_approved_guest(invite_id, guest_device_id)
    }

    pub fn authorize_ice(
        &self,
        invite_id: &str,
        role: &BoundRole,
        guest_device_id: &str,
    ) -> Result<(), SessionError> {
        match role {
            BoundRole::Host => self.ensure_approved_guest(invite_id, guest_device_id),
            BoundRole::Guest { .. } => self.authorize_answer(invite_id, role, guest_device_id),
        }
    }

    pub fn authorize_heartbeat(
        &self,
        invite_id: &str,
        role: Option<&BoundRole>,
    ) -> Result<(), SessionError> {
        let Some(role) = role else {
            return Err(SessionError::RoleForbidden);
        };
        let inner = self.inner.read().expect("session store poisoned");
        let record = get_record(&inner, invite_id)?;
        ensure_active(record)?;
        match role {
            BoundRole::Host => Ok(()),
            BoundRole::Guest { device_id } => {
                if record
                    .pending_guest
                    .as_ref()
                    .is_some_and(|guest| guest.device_id == *device_id)
                    || record
                        .approved_guest
                        .as_ref()
                        .is_some_and(|guest| guest.device_id == *device_id)
                {
                    Ok(())
                } else {
                    Err(SessionError::GuestNotApproved)
                }
            }
        }
    }

    pub fn ice_config(&self, request: IceConfigRequest) -> Result<IceConfigResponse, SessionError> {
        match request {
            IceConfigRequest::Host {
                invite_id,
                host_secret,
            } => self.authorize_host_ice(&invite_id, &host_secret)?,
            IceConfigRequest::Guest {
                invite_id,
                guest_token,
                guest_device_id,
            } => self.authorize_guest_ice(&invite_id, &guest_token, guest_device_id.as_deref())?,
        }
        Ok(self.build_ice_config())
    }

    fn authorize_host_ice(&self, invite_id: &str, host_secret: &str) -> Result<(), SessionError> {
        validate_invite_id(invite_id)?;
        let inner = self.inner.read().expect("session store poisoned");
        let record = get_record(&inner, invite_id)?;
        ensure_active(record)?;
        if verify_secret(
            &self.config.hmac_key,
            host_secret,
            &record.host_secret_digest,
        ) {
            Ok(())
        } else {
            Err(SessionError::InvalidToken)
        }
    }

    fn authorize_guest_ice(
        &self,
        invite_id: &str,
        guest_token: &str,
        guest_device_id: Option<&str>,
    ) -> Result<(), SessionError> {
        validate_invite_id(invite_id)?;
        let inner = self.inner.read().expect("session store poisoned");
        let record = get_record(&inner, invite_id)?;
        ensure_active(record)?;
        if !verify_secret(
            &self.config.hmac_key,
            guest_token,
            &record.guest_token_digest,
        ) {
            return Err(SessionError::InvalidToken);
        }
        let Some(device_id) = guest_device_id else {
            return Err(SessionError::UnknownGuest);
        };
        let known = record
            .pending_guest
            .as_ref()
            .is_some_and(|guest| guest.device_id == device_id)
            || record
                .approved_guest
                .as_ref()
                .is_some_and(|guest| guest.device_id == device_id);
        if !known {
            return Err(SessionError::UnknownGuest);
        }
        Ok(())
    }

    fn ensure_approved_guest(
        &self,
        invite_id: &str,
        guest_device_id: &str,
    ) -> Result<(), SessionError> {
        let inner = self.inner.read().expect("session store poisoned");
        let record = get_record(&inner, invite_id)?;
        ensure_active(record)?;
        if !record.host_registered {
            return Err(SessionError::HostNotRegistered);
        }
        match record.approved_guest.as_ref() {
            Some(guest) if guest.device_id == guest_device_id => Ok(()),
            Some(_) => Err(SessionError::UnknownGuest),
            None => Err(SessionError::GuestNotApproved),
        }
    }

    fn build_ice_config(&self) -> IceConfigResponse {
        let mut ice_servers = Vec::new();
        if !self.config.stun_urls.is_empty() {
            ice_servers.push(IceServer {
                urls: self.config.stun_urls.clone(),
                username: None,
                credential: None,
            });
        }

        if !self.config.turn_urls.is_empty() {
            if let Some(secret) = self.config.turn_static_auth_secret.as_deref() {
                let expiry = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
                    + self.config.turn_credential_ttl.as_secs();
                let username = format!("{expiry}:{}", random_id());
                let credential = turn_credential(secret, &username);
                ice_servers.push(IceServer {
                    urls: self.config.turn_urls.clone(),
                    username: Some(username),
                    credential: Some(credential),
                });
            }
        }

        IceConfigResponse {
            ice_servers,
            lifetime_duration: format!("{}.000s", self.config.turn_credential_ttl.as_secs()),
        }
    }
}

pub fn validate_invite_id(invite_id: &str) -> Result<(), SessionError> {
    if !invite_id.starts_with(INVITE_PREFIX) {
        return Err(SessionError::InvalidInviteId);
    }
    let suffix = &invite_id[INVITE_PREFIX.len()..];
    if suffix.len() < 22
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(SessionError::InvalidInviteId);
    }
    Ok(())
}

fn enforce_rate_limit(
    creates_by_ip: &mut HashMap<String, VecDeque<Instant>>,
    ip_key: &str,
    limit: usize,
) -> Result<(), SessionError> {
    if limit == 0 {
        return Err(SessionError::RateLimited);
    }
    let now = Instant::now();
    let window_start = now.checked_sub(INVITE_RATE_LIMIT_WINDOW).unwrap_or(now);
    let creates = creates_by_ip.entry(ip_key.to_string()).or_default();
    while creates
        .front()
        .is_some_and(|created_at| *created_at < window_start)
    {
        creates.pop_front();
    }
    if creates.len() >= limit {
        return Err(SessionError::RateLimited);
    }
    creates.push_back(now);
    Ok(())
}

fn prune_stale_records(inner: &mut StoreInner) {
    let now = SystemTime::now();
    inner
        .invites
        .retain(|_, record| !record.revoked && record.expires_at > now);
    prune_rate_limit_buckets(&mut inner.invite_creates_by_ip, Instant::now());
}

fn prune_rate_limit_buckets(creates_by_ip: &mut HashMap<String, VecDeque<Instant>>, now: Instant) {
    let window_start = now.checked_sub(INVITE_RATE_LIMIT_WINDOW).unwrap_or(now);
    creates_by_ip.retain(|_, creates| {
        while creates
            .front()
            .is_some_and(|created_at| *created_at < window_start)
        {
            creates.pop_front();
        }
        !creates.is_empty()
    });
}

fn get_record<'a>(
    inner: &'a StoreInner,
    invite_id: &str,
) -> Result<&'a InviteRecord, SessionError> {
    validate_invite_id(invite_id)?;
    inner
        .invites
        .get(invite_id)
        .ok_or(SessionError::InviteNotFound)
}

fn get_record_mut<'a>(
    inner: &'a mut StoreInner,
    invite_id: &str,
) -> Result<&'a mut InviteRecord, SessionError> {
    validate_invite_id(invite_id)?;
    inner
        .invites
        .get_mut(invite_id)
        .ok_or(SessionError::InviteNotFound)
}

fn get_active_record_mut<'a>(
    inner: &'a mut StoreInner,
    invite_id: &str,
) -> Result<&'a mut InviteRecord, SessionError> {
    let record = get_record_mut(inner, invite_id)?;
    ensure_active(record)?;
    Ok(record)
}

fn ensure_active(record: &InviteRecord) -> Result<(), SessionError> {
    if record.revoked {
        return Err(SessionError::InviteRevoked);
    }
    if record.expires_at <= SystemTime::now() {
        return Err(SessionError::InviteExpired);
    }
    Ok(())
}

fn require_host(role: &BoundRole) -> Result<(), SessionError> {
    match role {
        BoundRole::Host => Ok(()),
        BoundRole::Guest { .. } => Err(SessionError::RoleForbidden),
    }
}

fn require_guest(role: &BoundRole, guest_device_id: &str) -> Result<(), SessionError> {
    match role {
        BoundRole::Guest { device_id } if device_id == guest_device_id => Ok(()),
        BoundRole::Guest { .. } => Err(SessionError::UnknownGuest),
        BoundRole::Host => Err(SessionError::RoleForbidden),
    }
}

fn digest_secret(key: &[u8], secret: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(secret.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn verify_secret(key: &[u8], provided: &str, expected_digest: &[u8]) -> bool {
    let digest = digest_secret(key, provided);
    digest.ct_eq(expected_digest).into()
}

fn random_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn turn_credential(secret: &str, username: &str) -> String {
    let mut mac = HmacSha1::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any static auth secret length");
    mac.update(username.as_bytes());
    STANDARD.encode(mac.finalize().into_bytes())
}

fn unix_ms(time: SystemTime) -> Result<u64, SessionError> {
    let duration = time
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SessionError::ClockError)?;
    Ok(duration.as_millis().min(u128::from(u64::MAX)) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::IceConfigRequest;

    fn store() -> SessionStore {
        SessionStore::new(ServiceConfig {
            invite_ttl: Duration::from_secs(900),
            relay_url: "ws://localhost:8080/v1/remote/signaling".to_string(),
            public_base_url: "http://localhost:8080".to_string(),
            hmac_key: b"test-hmac-key".to_vec(),
            stun_urls: vec!["stun:stun.l.google.com:19302".to_string()],
            turn_urls: vec!["turn:turn.easycris.com:3478".to_string()],
            turn_static_auth_secret: Some("turn-secret".to_string()),
            turn_credential_ttl: Duration::from_secs(3600),
            invite_rate_limit_per_hour: 20,
        })
    }

    fn expiring_store() -> SessionStore {
        SessionStore::new(ServiceConfig {
            invite_ttl: Duration::from_secs(0),
            relay_url: "ws://localhost:8080/v1/remote/signaling".to_string(),
            public_base_url: "http://localhost:8080".to_string(),
            hmac_key: b"test-hmac-key".to_vec(),
            stun_urls: vec![],
            turn_urls: vec![],
            turn_static_auth_secret: None,
            turn_credential_ttl: Duration::from_secs(3600),
            invite_rate_limit_per_hour: 20,
        })
    }

    fn expire_invite_for_test(store: &SessionStore, invite_id: &str) {
        let mut inner = store.inner.write().expect("session store poisoned");
        inner
            .invites
            .get_mut(invite_id)
            .expect("invite exists")
            .expires_at = SystemTime::now() - Duration::from_secs(1);
    }

    #[test]
    fn invite_creation_returns_secrets_once_and_public_metadata_excludes_them() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();

        assert!(invite.invite_id.starts_with("rmt_"));
        assert!(invite.share_url.contains("#token="));
        assert!(!invite.host_secret.is_empty());

        let metadata = store.public_metadata(&invite.invite_id).unwrap();
        assert_eq!(metadata.invite_id, invite.invite_id);
        assert_eq!(metadata.status, "created");
    }

    #[test]
    fn invite_creation_stores_host_device_id_for_approval_messages() {
        let store = store();
        let invite = store
            .create_invite_for_host(
                "127.0.0.1",
                HostIdentity {
                    device_id: "host-device".to_string(),
                },
            )
            .unwrap();

        assert_eq!(
            store.host_device_id(&invite.invite_id).unwrap(),
            "host-device"
        );
    }

    #[test]
    fn metrics_snapshot_counts_invite_states_without_secrets() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();
        store
            .register_host(&invite.invite_id, &invite.host_secret)
            .unwrap();
        store
            .join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest".to_string(),
                    device_id: "guest-device".to_string(),
                },
            )
            .unwrap();

        let pending = store.metrics_snapshot();
        assert_eq!(pending.active_invites, 1);
        assert_eq!(pending.pending_guests, 1);
        assert_eq!(pending.approved_sessions, 0);

        store
            .approve_guest(&invite.invite_id, &BoundRole::Host, "guest-device")
            .unwrap();
        let approved = store.metrics_snapshot();
        assert_eq!(approved.active_invites, 1);
        assert_eq!(approved.pending_guests, 0);
        assert_eq!(approved.approved_sessions, 1);
        assert_eq!(approved.total_invites, 1);
    }

    #[test]
    fn metrics_snapshot_counts_expired_and_revoked_outside_active_session_counts() {
        let store = store();
        let expired = store.create_invite("127.0.0.1").unwrap();
        store
            .register_host(&expired.invite_id, &expired.host_secret)
            .unwrap();
        store
            .join_request(
                &expired.invite_id,
                &expired.guest_token,
                GuestIdentity {
                    display_name: "Guest".to_string(),
                    device_id: "expired-guest".to_string(),
                },
            )
            .unwrap();
        store
            .approve_guest(&expired.invite_id, &BoundRole::Host, "expired-guest")
            .unwrap();

        let revoked = store.create_invite("127.0.0.2").unwrap();
        store.revoke(&revoked.invite_id, &BoundRole::Host).unwrap();
        expire_invite_for_test(&store, &expired.invite_id);

        let snapshot = store.metrics_snapshot();
        assert_eq!(snapshot.active_invites, 0);
        assert_eq!(snapshot.expired_invites, 1);
        assert_eq!(snapshot.revoked_invites, 1);
        assert_eq!(snapshot.pending_guests, 0);
        assert_eq!(snapshot.approved_sessions, 0);
        assert_eq!(snapshot.total_invites, 2);
    }

    #[test]
    fn create_invite_prunes_expired_and_revoked_invites() {
        let store = store();
        let expired = store.create_invite("127.0.0.1").unwrap();
        expire_invite_for_test(&store, &expired.invite_id);

        let revoked = store.create_invite("127.0.0.2").unwrap();
        store.revoke(&revoked.invite_id, &BoundRole::Host).unwrap();

        let active = store.create_invite("127.0.0.3").unwrap();

        let snapshot = store.metrics_snapshot();
        assert_eq!(snapshot.active_invites, 1);
        assert_eq!(snapshot.expired_invites, 0);
        assert_eq!(snapshot.revoked_invites, 0);
        assert_eq!(snapshot.total_invites, 1);
        assert!(store.public_metadata(&active.invite_id).is_ok());
        assert!(matches!(
            store.public_metadata(&expired.invite_id),
            Err(SessionError::InviteNotFound)
        ));
        assert!(matches!(
            store.public_metadata(&revoked.invite_id),
            Err(SessionError::InviteNotFound)
        ));
    }

    #[test]
    fn prune_now_removes_expired_revoked_and_old_rate_limit_buckets() {
        let store = store();
        let expired = store.create_invite("127.0.0.1").unwrap();
        expire_invite_for_test(&store, &expired.invite_id);
        let revoked = store.create_invite("127.0.0.2").unwrap();
        store.revoke(&revoked.invite_id, &BoundRole::Host).unwrap();
        let active = store.create_invite("127.0.0.3").unwrap();
        {
            let mut inner = store.inner.write().expect("session store poisoned");
            inner.invite_creates_by_ip.insert(
                "old-ip".to_string(),
                VecDeque::from([Instant::now() - Duration::from_secs(7200)]),
            );
        }

        store.prune_now();

        let inner = store.inner.read().expect("session store poisoned");
        assert!(inner.invites.contains_key(&active.invite_id));
        assert!(!inner.invites.contains_key(&expired.invite_id));
        assert!(!inner.invites.contains_key(&revoked.invite_id));
        assert!(!inner.invite_creates_by_ip.contains_key("old-ip"));
    }

    #[test]
    fn create_invite_prunes_old_rate_limit_ip_buckets() {
        let store = store();
        {
            let mut inner = store.inner.write().expect("session store poisoned");
            inner.invite_creates_by_ip.insert(
                "old-ip".to_string(),
                VecDeque::from([Instant::now() - Duration::from_secs(7200)]),
            );
            inner
                .invite_creates_by_ip
                .insert("recent-ip".to_string(), VecDeque::from([Instant::now()]));
        }

        store.create_invite("new-ip").unwrap();

        let inner = store.inner.read().expect("session store poisoned");
        assert!(!inner.invite_creates_by_ip.contains_key("old-ip"));
        assert!(inner.invite_creates_by_ip.contains_key("recent-ip"));
        assert!(inner.invite_creates_by_ip.contains_key("new-ip"));
    }

    #[test]
    fn rejects_malformed_invite_before_lookup() {
        let store = store();
        assert_eq!(
            store.validate_signaling_upgrade("../bad"),
            Err(SessionError::InvalidInviteId)
        );
    }

    #[test]
    fn enforces_role_and_guest_state() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();
        let guest = GuestIdentity {
            display_name: "Guest".to_string(),
            device_id: "guest-device".to_string(),
        };

        store
            .register_host(&invite.invite_id, &invite.host_secret)
            .unwrap();
        store
            .join_request(&invite.invite_id, &invite.guest_token, guest)
            .unwrap();

        assert_eq!(
            store.approve_guest(
                &invite.invite_id,
                &BoundRole::Guest {
                    device_id: "guest-device".to_string()
                },
                "guest-device"
            ),
            Err(SessionError::RoleForbidden)
        );

        store
            .approve_guest(&invite.invite_id, &BoundRole::Host, "guest-device")
            .unwrap();
        store
            .authorize_answer(
                &invite.invite_id,
                &BoundRole::Guest {
                    device_id: "guest-device".to_string(),
                },
                "guest-device",
            )
            .unwrap();
        assert_eq!(
            store.revoke(
                &invite.invite_id,
                &BoundRole::Guest {
                    device_id: "guest-device".to_string()
                }
            ),
            Err(SessionError::RoleForbidden)
        );
    }

    #[test]
    fn wrong_guest_token_and_expired_invite_are_rejected() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();
        store
            .register_host(&invite.invite_id, &invite.host_secret)
            .unwrap();

        assert_eq!(
            store.join_request(
                &invite.invite_id,
                "wrong-token",
                GuestIdentity {
                    display_name: "Guest".to_string(),
                    device_id: "guest-device".to_string(),
                },
            ),
            Err(SessionError::InvalidToken)
        );

        let expiring = expiring_store();
        let expired = expiring.create_invite("127.0.0.1").unwrap();
        assert_eq!(
            expiring.validate_signaling_upgrade(&expired.invite_id),
            Err(SessionError::InviteExpired)
        );
    }

    #[test]
    fn unapproved_guest_cannot_send_answer_or_ice() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();
        store
            .register_host(&invite.invite_id, &invite.host_secret)
            .unwrap();
        store
            .join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest".to_string(),
                    device_id: "guest-device".to_string(),
                },
            )
            .unwrap();

        let role = BoundRole::Guest {
            device_id: "guest-device".to_string(),
        };
        assert_eq!(
            store.authorize_answer(&invite.invite_id, &role, "guest-device"),
            Err(SessionError::GuestNotApproved)
        );
        assert_eq!(
            store.authorize_ice(&invite.invite_id, &role, "guest-device"),
            Err(SessionError::GuestNotApproved)
        );
    }

    #[test]
    fn host_cannot_approve_unknown_guest_and_revoked_invite_rejects_later_signaling() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();
        store
            .register_host(&invite.invite_id, &invite.host_secret)
            .unwrap();
        store
            .join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest".to_string(),
                    device_id: "guest-device".to_string(),
                },
            )
            .unwrap();

        assert_eq!(
            store.approve_guest(&invite.invite_id, &BoundRole::Host, "other-guest"),
            Err(SessionError::UnknownGuest)
        );
        store.revoke(&invite.invite_id, &BoundRole::Host).unwrap();
        assert_eq!(
            store.authorize_heartbeat(&invite.invite_id, Some(&BoundRole::Host)),
            Err(SessionError::InviteRevoked)
        );
        assert_eq!(
            store.ice_config(IceConfigRequest::Host {
                invite_id: invite.invite_id,
                host_secret: invite.host_secret,
            }),
            Err(SessionError::InviteRevoked)
        );
    }

    #[test]
    fn rejects_duplicate_guest() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();
        store
            .register_host(&invite.invite_id, &invite.host_secret)
            .unwrap();
        store
            .join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest 1".to_string(),
                    device_id: "guest-1".to_string(),
                },
            )
            .unwrap();

        assert_eq!(
            store.join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest 2".to_string(),
                    device_id: "guest-2".to_string(),
                },
            ),
            Err(SessionError::DuplicateGuest)
        );
    }

    #[test]
    fn disconnect_guest_clears_pending_guest() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();
        store
            .register_host(&invite.invite_id, &invite.host_secret)
            .unwrap();
        store
            .join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest 1".to_string(),
                    device_id: "guest-1".to_string(),
                },
            )
            .unwrap();

        assert!(store
            .disconnect_guest(&invite.invite_id, "guest-1")
            .unwrap());
        assert_eq!(
            store.public_metadata(&invite.invite_id).unwrap().status,
            "listening"
        );
        store
            .join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest 2".to_string(),
                    device_id: "guest-2".to_string(),
                },
            )
            .unwrap();
    }

    #[test]
    fn disconnect_guest_clears_approved_guest() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();
        store
            .register_host(&invite.invite_id, &invite.host_secret)
            .unwrap();
        store
            .join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest 1".to_string(),
                    device_id: "guest-1".to_string(),
                },
            )
            .unwrap();
        store
            .approve_guest(&invite.invite_id, &BoundRole::Host, "guest-1")
            .unwrap();

        assert!(store
            .disconnect_guest(&invite.invite_id, "guest-1")
            .unwrap());
        assert_eq!(
            store.public_metadata(&invite.invite_id).unwrap().status,
            "listening"
        );
        store
            .join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest 2".to_string(),
                    device_id: "guest-2".to_string(),
                },
            )
            .unwrap();
    }

    #[test]
    fn disconnect_host_marks_host_unregistered() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();
        store
            .register_host(&invite.invite_id, &invite.host_secret)
            .unwrap();
        store
            .join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest".to_string(),
                    device_id: "guest-device".to_string(),
                },
            )
            .unwrap();
        store
            .approve_guest(&invite.invite_id, &BoundRole::Host, "guest-device")
            .unwrap();

        store.disconnect_host(&invite.invite_id).unwrap();

        {
            let inner = store.inner.read().expect("session store poisoned");
            let record = inner.invites.get(&invite.invite_id).unwrap();
            assert!(record.approved_guest.is_some());
            assert!(!record.host_registered);
        }
        assert_eq!(
            store.public_metadata(&invite.invite_id).unwrap().status,
            "created"
        );
        assert_eq!(
            store.join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest 2".to_string(),
                    device_id: "guest-2".to_string(),
                },
            ),
            Err(SessionError::HostNotRegistered)
        );
        assert_eq!(
            store.authorize_offer(&invite.invite_id, &BoundRole::Host, "guest-device"),
            Err(SessionError::HostNotRegistered)
        );
    }

    #[test]
    fn host_reregistration_clears_stale_guest_records() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();
        store
            .register_host(&invite.invite_id, &invite.host_secret)
            .unwrap();
        store
            .join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest".to_string(),
                    device_id: "guest-device".to_string(),
                },
            )
            .unwrap();
        store
            .approve_guest(&invite.invite_id, &BoundRole::Host, "guest-device")
            .unwrap();
        store.disconnect_host(&invite.invite_id).unwrap();

        {
            let inner = store.inner.read().expect("session store poisoned");
            let record = inner.invites.get(&invite.invite_id).unwrap();
            assert!(record.approved_guest.is_some());
        }
        store
            .register_host(&invite.invite_id, &invite.host_secret)
            .unwrap();

        let inner = store.inner.read().expect("session store poisoned");
        let record = inner.invites.get(&invite.invite_id).unwrap();
        assert!(record.host_registered);
        assert!(record.pending_guest.is_none());
        assert!(record.approved_guest.is_none());
    }

    #[test]
    fn disconnect_cleanup_updates_expired_records() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();
        store
            .register_host(&invite.invite_id, &invite.host_secret)
            .unwrap();
        store
            .join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest".to_string(),
                    device_id: "guest-device".to_string(),
                },
            )
            .unwrap();
        store
            .approve_guest(&invite.invite_id, &BoundRole::Host, "guest-device")
            .unwrap();
        expire_invite_for_test(&store, &invite.invite_id);

        assert_eq!(
            store
                .disconnect_guest(&invite.invite_id, "guest-device")
                .unwrap(),
            true
        );
        store.disconnect_host(&invite.invite_id).unwrap();

        let inner = store.inner.read().expect("session store poisoned");
        let record = inner.invites.get(&invite.invite_id).unwrap();
        assert!(!record.host_registered);
        assert!(record.pending_guest.is_none());
        assert!(record.approved_guest.is_none());
    }

    #[test]
    fn ice_config_requires_participant_proof() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();

        assert_eq!(
            store.ice_config(IceConfigRequest::Host {
                invite_id: invite.invite_id.clone(),
                host_secret: "wrong".to_string(),
            }),
            Err(SessionError::InvalidToken)
        );

        let ice = store
            .ice_config(IceConfigRequest::Host {
                invite_id: invite.invite_id,
                host_secret: invite.host_secret,
            })
            .unwrap();
        assert!(ice
            .ice_servers
            .iter()
            .any(|server| server.urls.iter().any(|url| url.starts_with("turn:"))));
    }

    #[test]
    fn guest_ice_config_requires_known_guest_device_id() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();
        store
            .register_host(&invite.invite_id, &invite.host_secret)
            .unwrap();

        assert_eq!(
            store.ice_config(IceConfigRequest::Guest {
                invite_id: invite.invite_id.clone(),
                guest_token: invite.guest_token.clone(),
                guest_device_id: None,
            }),
            Err(SessionError::UnknownGuest)
        );
        assert_eq!(
            store.ice_config(IceConfigRequest::Guest {
                invite_id: invite.invite_id.clone(),
                guest_token: invite.guest_token.clone(),
                guest_device_id: Some("unknown-guest".to_string()),
            }),
            Err(SessionError::UnknownGuest)
        );

        store
            .join_request(
                &invite.invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest".to_string(),
                    device_id: "guest-device".to_string(),
                },
            )
            .unwrap();

        let ice = store
            .ice_config(IceConfigRequest::Guest {
                invite_id: invite.invite_id.clone(),
                guest_token: invite.guest_token.clone(),
                guest_device_id: Some("guest-device".to_string()),
            })
            .unwrap();
        assert!(ice
            .ice_servers
            .iter()
            .any(|server| server.urls.iter().any(|url| url.starts_with("turn:"))));

        store
            .approve_guest(&invite.invite_id, &BoundRole::Host, "guest-device")
            .unwrap();

        let ice = store
            .ice_config(IceConfigRequest::Guest {
                invite_id: invite.invite_id,
                guest_token: invite.guest_token,
                guest_device_id: Some("guest-device".to_string()),
            })
            .unwrap();
        assert!(ice
            .ice_servers
            .iter()
            .any(|server| server.urls.iter().any(|url| url.starts_with("turn:"))));
    }

    #[test]
    fn turn_credential_uses_coturn_rest_hmac_sha1() {
        assert_eq!(
            turn_credential("turn-secret", "1700000000:test-user"),
            "KLvgmowA+ed9EpZJiYRC4kIMZPE="
        );
    }

    #[test]
    fn unbound_heartbeat_is_rejected() {
        let store = store();
        let invite = store.create_invite("127.0.0.1").unwrap();
        assert_eq!(
            store.authorize_heartbeat(&invite.invite_id, None),
            Err(SessionError::RoleForbidden)
        );
    }
}
