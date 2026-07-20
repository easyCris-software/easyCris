mod landing;
mod protocol;
mod session;

use std::collections::{HashMap, VecDeque};
use std::env;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, options, post};
use axum::{Json, Router};
use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch, Mutex};
use tracing::{info, warn};

use crate::landing::invite_landing_html;
use crate::protocol::{ClientMessage, CreateInviteRequest, IceConfigRequest, ServerMessage};
use crate::session::{
    BoundRole, ForwardTarget, GuestIdentity, HostIdentity, ServiceConfig, SessionError,
    SessionStore,
};

const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(8);
const DEFAULT_SIGNALING_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const DEFAULT_SIGNALING_OUTBOUND_QUEUE_CAPACITY: usize = 64;
const DEFAULT_SIGNALING_MESSAGE_RATE_LIMIT: usize = 120;
const DEFAULT_SIGNALING_MESSAGE_RATE_WINDOW: Duration = Duration::from_secs(10);
const DEFAULT_SESSION_PRUNE_INTERVAL: Duration = Duration::from_secs(300);
const DEFAULT_CRITICAL_SIGNALING_SEND_TIMEOUT: Duration = Duration::from_millis(500);
const MIN_PRODUCTION_HMAC_KEY_BYTES: usize = 32;
const DEV_HMAC_KEY: &str = "dev-only-change-me";

type OutboundSender = mpsc::Sender<ServerMessage>;

#[derive(Clone)]
struct AppState {
    sessions: Arc<SessionStore>,
    hub: Arc<Mutex<ConnectionHub>>,
    metrics_bearer_token: Option<String>,
    metrics: Arc<AppMetrics>,
    max_signaling_message_bytes: usize,
    signaling_idle_timeout: Duration,
    signaling_outbound_queue_capacity: usize,
    signaling_message_rate_limit: usize,
    signaling_message_rate_window: Duration,
    critical_signaling_send_timeout: Duration,
    trusted_proxy_depth: usize,
}

#[derive(Default)]
struct ConnectionHub {
    invites: HashMap<String, InviteConnections>,
}

#[derive(Default)]
struct InviteConnections {
    host: Option<OutboundSender>,
    guest: Option<OutboundSender>,
}

#[derive(Default)]
struct AppMetrics {
    duplicate_guest_rejections: AtomicU64,
    guest_forward_failures: AtomicU64,
    heartbeat_messages: AtomicU64,
    ice_config_rejections: AtomicU64,
    message_size_rejections: AtomicU64,
    signaling_rate_limit_rejections: AtomicU64,
    session_revoked_messages: AtomicU64,
    signaling_dispatch_rejections: AtomicU64,
    signaling_parse_rejections: AtomicU64,
    turn_credential_grants: AtomicU64,
}

#[derive(Debug, Serialize)]
struct MetricsResponse {
    active_guest_sockets: usize,
    active_host_sockets: usize,
    active_invites: usize,
    approved_sessions: usize,
    duplicate_guest_rejections: u64,
    expired_invites: usize,
    guest_forward_failures: u64,
    heartbeat_messages: u64,
    ice_config_rejections: u64,
    message_size_rejections: u64,
    pending_guests: usize,
    revoked_invites: usize,
    session_revoked_messages: u64,
    signaling_dispatch_rejections: u64,
    signaling_parse_rejections: u64,
    signaling_rate_limit_rejections: u64,
    total_invites: usize,
    turn_credential_grants: u64,
}

#[derive(Debug, Deserialize)]
struct SignalingQuery {
    invite: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "easycris_remote_signaling=info".into()),
        )
        .init();

    let bind = env::var("EASYCRIS_REMOTE_BIND").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let state = AppState {
        sessions: Arc::new(SessionStore::new(config_from_env())),
        hub: Arc::new(Mutex::new(ConnectionHub::default())),
        metrics_bearer_token: metrics_bearer_token_from_env(),
        metrics: Arc::new(AppMetrics::default()),
        max_signaling_message_bytes: env_usize("MAX_SIGNALING_MESSAGE_BYTES", 262_144),
        signaling_idle_timeout: env_duration(
            "SIGNALING_IDLE_TIMEOUT_SECS",
            DEFAULT_SIGNALING_IDLE_TIMEOUT.as_secs(),
        ),
        signaling_outbound_queue_capacity: env_usize(
            "SIGNALING_OUTBOUND_QUEUE_CAPACITY",
            DEFAULT_SIGNALING_OUTBOUND_QUEUE_CAPACITY,
        )
        .max(1),
        signaling_message_rate_limit: env_usize(
            "SIGNALING_MESSAGE_RATE_LIMIT",
            DEFAULT_SIGNALING_MESSAGE_RATE_LIMIT,
        ),
        signaling_message_rate_window: env_duration(
            "SIGNALING_MESSAGE_RATE_WINDOW_SECS",
            DEFAULT_SIGNALING_MESSAGE_RATE_WINDOW.as_secs(),
        ),
        critical_signaling_send_timeout: env_duration_ms(
            "CRITICAL_SIGNALING_SEND_TIMEOUT_MS",
            DEFAULT_CRITICAL_SIGNALING_SEND_TIMEOUT.as_millis() as u64,
        ),
        trusted_proxy_depth: env_usize("TRUSTED_PROXY_DEPTH", 0),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/remote/metrics", get(metrics))
        .route("/join/{invite_id}", get(join_page))
        .route(
            "/v1/remote/invites",
            post(create_invite).options(cors_preflight),
        )
        .route("/v1/remote/invites/{invite_id}", get(invite_metadata))
        .route(
            "/v1/remote/ice-config",
            post(ice_config).options(cors_preflight),
        )
        .route("/v1/remote/signaling", get(signaling_ws))
        .route("/v1/remote/signaling", options(cors_preflight))
        .layer(middleware::map_response(add_cors_headers))
        .with_state(state.clone());

    let listener = TcpListener::bind(&bind)
        .await
        .unwrap_or_else(|error| panic!("failed to bind {bind}: {error}"));
    info!(%bind, "easyCris remote signaling listening");

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let server_shutdown_rx = shutdown_rx.clone();
    spawn_session_prune_task(
        state.sessions.clone(),
        shutdown_rx.clone(),
        env_duration(
            "SESSION_PRUNE_INTERVAL_SECS",
            DEFAULT_SESSION_PRUNE_INTERVAL.as_secs(),
        ),
    );
    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = shutdown_tx.send(true);
    });

    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(wait_for_shutdown(server_shutdown_rx));

    tokio::select! {
        result = server => result.expect("server failed"),
        _ = shutdown_drain_timeout(shutdown_rx) => {
            warn!(?SHUTDOWN_DRAIN_TIMEOUT, "shutdown drain timeout elapsed");
        }
    }
}

fn config_from_env() -> ServiceConfig {
    config_from_env_result()
        .unwrap_or_else(|error| panic!("invalid easyCris remote signaling configuration: {error}"))
}

fn config_from_env_result() -> Result<ServiceConfig, String> {
    let public_base_url =
        env::var("PUBLIC_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".to_string());
    let relay_url = env::var("RELAY_URL")
        .unwrap_or_else(|_| "ws://127.0.0.1:8080/v1/remote/signaling".to_string());
    let production = production_mode_from_env();
    let hmac_key = resolve_hmac_key(env::var("REMOTE_INVITE_HMAC_KEY").ok(), production)?;
    let invite_ttl = env_duration("INVITE_TTL_SECS", 900);
    let turn_credential_ttl = env_duration("TURN_CREDENTIAL_TTL_SECS", 3600);
    let invite_rate_limit_per_hour = env::var("INVITE_RATE_LIMIT_PER_HOUR")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(20);

    let stun_urls = split_urls("STUN_URLS", "stun:stun.l.google.com:19302");
    let turn_urls = split_urls("TURN_URLS", "");
    let turn_static_auth_secret = env::var("TURN_STATIC_AUTH_SECRET")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    validate_turn_config(
        &turn_urls,
        turn_static_auth_secret.as_deref(),
        &hmac_key,
        production,
    )?;

    Ok(ServiceConfig {
        invite_ttl,
        relay_url,
        public_base_url,
        hmac_key,
        stun_urls,
        turn_urls,
        turn_static_auth_secret,
        turn_credential_ttl,
        invite_rate_limit_per_hour,
    })
}

fn production_mode_from_env() -> bool {
    env::var("EASYCRIS_REMOTE_ENV")
        .ok()
        .map(|value| {
            let value = value.trim();
            value.eq_ignore_ascii_case("production") || value.eq_ignore_ascii_case("prod")
        })
        .unwrap_or(false)
}

fn resolve_hmac_key(value: Option<String>, production: bool) -> Result<Vec<u8>, String> {
    let effective = value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let key = effective.unwrap_or(DEV_HMAC_KEY);
    if production {
        if effective.is_none() {
            return Err(
                "REMOTE_INVITE_HMAC_KEY is required when EASYCRIS_REMOTE_ENV=production"
                    .to_string(),
            );
        }
        if is_known_dev_secret(key) {
            return Err(format!(
                "REMOTE_INVITE_HMAC_KEY must be hex/base64 encoded, decode to at least {MIN_PRODUCTION_HMAC_KEY_BYTES} bytes, and cannot use a development value in production"
            ));
        }
        let material = decode_config_secret(key).ok_or_else(|| {
            format!(
                "REMOTE_INVITE_HMAC_KEY must be hex/base64 encoded and decode to at least {MIN_PRODUCTION_HMAC_KEY_BYTES} bytes"
            )
        })?;
        if material.len() < MIN_PRODUCTION_HMAC_KEY_BYTES {
            return Err(format!(
                "REMOTE_INVITE_HMAC_KEY must decode to at least {MIN_PRODUCTION_HMAC_KEY_BYTES} bytes"
            ));
        }
        return Ok(material);
    }
    Ok(key.as_bytes().to_vec())
}

fn decode_config_secret(value: &str) -> Option<Vec<u8>> {
    decode_hex_secret(value)
        .or_else(|| BASE64_STANDARD.decode(value).ok())
        .or_else(|| URL_SAFE_NO_PAD.decode(value).ok())
        .filter(|bytes| !bytes.is_empty())
}

fn decode_hex_secret(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().chunks_exact(2) {
        let text = std::str::from_utf8(pair).expect("hex pre-check guarantees ASCII");
        bytes.push(u8::from_str_radix(text, 16).expect("hex pre-check guarantees valid hex pair"));
    }
    Some(bytes)
}

fn validate_turn_config(
    turn_urls: &[String],
    turn_static_auth_secret: Option<&str>,
    hmac_key: &[u8],
    production: bool,
) -> Result<(), String> {
    match (turn_urls.is_empty(), turn_static_auth_secret) {
        (true, None) => Ok(()),
        (true, Some(_)) => Err("TURN_STATIC_AUTH_SECRET is set but TURN_URLS is empty".to_string()),
        (false, None) => Err("TURN_URLS requires TURN_STATIC_AUTH_SECRET".to_string()),
        (false, Some(secret)) => {
            let turn_material =
                decode_config_secret(secret).unwrap_or_else(|| secret.as_bytes().to_vec());
            if turn_material == hmac_key || secret.as_bytes() == hmac_key {
                return Err(
                    "TURN_STATIC_AUTH_SECRET must differ from REMOTE_INVITE_HMAC_KEY".to_string(),
                );
            }
            let decoded_utf8 = std::str::from_utf8(&turn_material).ok();
            if production
                && (is_known_dev_secret(secret)
                    || decoded_utf8.is_some_and(is_known_dev_secret)
                    || turn_material.len() < MIN_PRODUCTION_HMAC_KEY_BYTES)
            {
                return Err(format!(
                    "TURN_STATIC_AUTH_SECRET must provide at least {MIN_PRODUCTION_HMAC_KEY_BYTES} bytes of key material and cannot use a development value in production"
                ));
            }
            Ok(())
        }
    }
}

fn is_known_dev_secret(value: &str) -> bool {
    matches!(
        value.trim(),
        DEV_HMAC_KEY | "change-this-local-dev-only" | "change-this-turn-secret-local-dev-only"
    )
}

fn env_duration(name: &str, default_secs: u64) -> Duration {
    Duration::from_secs(
        env::var(name)
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(default_secs),
    )
}

fn env_duration_ms(name: &str, default_ms: u64) -> Duration {
    Duration::from_millis(
        env::var(name)
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(default_ms),
    )
}

fn env_usize(name: &str, default_value: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(default_value)
}

fn metrics_bearer_token_from_env() -> Option<String> {
    match env::var("METRICS_BEARER_TOKEN") {
        Ok(value) => {
            let token = normalize_metrics_bearer_token(&value);
            if token.is_none() {
                warn!("METRICS_BEARER_TOKEN is set but blank; metrics endpoint disabled");
            }
            token
        }
        Err(_) => None,
    }
}

fn normalize_metrics_bearer_token(value: &str) -> Option<String> {
    let token = value.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

fn metrics_token_matches(header_token: &str, expected_token: &str) -> bool {
    let header_digest = Sha256::digest(header_token.trim().as_bytes());
    let expected_digest = Sha256::digest(expected_token.trim().as_bytes());
    header_digest.ct_eq(&expected_digest).unwrap_u8() == 1
}

fn split_urls(name: &str, default_value: &str) -> Vec<String> {
    env::var(name)
        .unwrap_or_else(|_| default_value.to_string())
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("shutdown signal received");
}

fn spawn_session_prune_task(
    sessions: Arc<SessionStore>,
    mut shutdown_rx: watch::Receiver<bool>,
    interval_duration: Duration,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(interval_duration.max(Duration::from_secs(1)));
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let sessions = sessions.clone();
                    if let Err(error) =
                        tokio::task::spawn_blocking(move || sessions.prune_now()).await
                    {
                        warn!(?error, "session prune task panicked");
                    }
                },
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        break;
                    }
                }
            }
        }
    });
}

async fn wait_for_shutdown(mut shutdown_rx: watch::Receiver<bool>) {
    if *shutdown_rx.borrow() {
        return;
    }
    let _ = shutdown_rx.changed().await;
}

async fn shutdown_drain_timeout(shutdown_rx: watch::Receiver<bool>) {
    wait_for_shutdown(shutdown_rx).await;
    tokio::time::sleep(SHUTDOWN_DRAIN_TIMEOUT).await;
}

async fn health() -> &'static str {
    "ok"
}

async fn cors_preflight() -> impl IntoResponse {
    StatusCode::NO_CONTENT
}

async fn add_cors_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET,POST,OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("authorization,content-type"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    response
}

async fn join_page(Path(invite_id): Path<String>) -> impl IntoResponse {
    invite_landing_html(&invite_id)
}

async fn create_invite(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CreateInviteRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let ip_key = rate_limit_ip_key(&headers, addr, state.trusted_proxy_depth);
    let invite = state.sessions.create_invite_for_host(
        &ip_key,
        HostIdentity {
            device_id: request.host_device_id.unwrap_or_default(),
        },
    )?;
    info!(invite_id = %invite.invite_id, ip = %ip_key, "remote invite created");
    Ok((StatusCode::CREATED, Json(invite)))
}

async fn invite_metadata(
    State(state): State<AppState>,
    Path(invite_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.sessions.public_metadata(&invite_id)?))
}

async fn ice_config(
    State(state): State<AppState>,
    Json(request): Json<IceConfigRequest>,
) -> Result<impl IntoResponse, ApiError> {
    match state.sessions.ice_config(request) {
        Ok(response) => {
            // TURN entries are the only ICE servers with credentials in build_ice_config.
            if response
                .ice_servers
                .iter()
                .any(|server| server.credential.is_some())
            {
                state
                    .metrics
                    .turn_credential_grants
                    .fetch_add(1, Ordering::Relaxed);
            }
            Ok(Json(response))
        }
        Err(error) => {
            state
                .metrics
                .ice_config_rejections
                .fetch_add(1, Ordering::Relaxed);
            Err(ApiError(error))
        }
    }
}

async fn metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MetricsResponse>, StatusCode> {
    let Some(expected_token) = state.metrics_bearer_token.as_ref() else {
        return Err(StatusCode::NOT_FOUND);
    };
    let Some(header_token) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(extract_bearer_token)
    else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !metrics_token_matches(header_token, expected_token) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let session = state.sessions.metrics_snapshot();
    let sockets = state.hub.lock().await.metrics_snapshot();
    Ok(Json(MetricsResponse {
        active_guest_sockets: sockets.active_guest_sockets,
        active_host_sockets: sockets.active_host_sockets,
        active_invites: session.active_invites,
        approved_sessions: session.approved_sessions,
        duplicate_guest_rejections: state
            .metrics
            .duplicate_guest_rejections
            .load(Ordering::Relaxed),
        expired_invites: session.expired_invites,
        guest_forward_failures: state.metrics.guest_forward_failures.load(Ordering::Relaxed),
        heartbeat_messages: state.metrics.heartbeat_messages.load(Ordering::Relaxed),
        ice_config_rejections: state.metrics.ice_config_rejections.load(Ordering::Relaxed),
        message_size_rejections: state
            .metrics
            .message_size_rejections
            .load(Ordering::Relaxed),
        pending_guests: session.pending_guests,
        revoked_invites: session.revoked_invites,
        session_revoked_messages: state
            .metrics
            .session_revoked_messages
            .load(Ordering::Relaxed),
        signaling_dispatch_rejections: state
            .metrics
            .signaling_dispatch_rejections
            .load(Ordering::Relaxed),
        signaling_parse_rejections: state
            .metrics
            .signaling_parse_rejections
            .load(Ordering::Relaxed),
        signaling_rate_limit_rejections: state
            .metrics
            .signaling_rate_limit_rejections
            .load(Ordering::Relaxed),
        total_invites: session.total_invites,
        turn_credential_grants: state.metrics.turn_credential_grants.load(Ordering::Relaxed),
    }))
}

fn rate_limit_ip_key(
    headers: &HeaderMap,
    remote_addr: SocketAddr,
    trusted_proxy_depth: usize,
) -> String {
    if trusted_proxy_depth == 0 {
        return remote_addr.ip().to_string();
    }
    forwarded_for_client_ip(headers, trusted_proxy_depth)
        .unwrap_or_else(|| remote_addr.ip())
        .to_string()
}

fn forwarded_for_client_ip(headers: &HeaderMap, trusted_proxy_depth: usize) -> Option<IpAddr> {
    let value = headers.get("x-forwarded-for")?.to_str().ok()?;
    let ips = value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter_map(|value| value.parse::<IpAddr>().ok())
        .collect::<Vec<_>>();
    if ips.is_empty() {
        return None;
    }
    let index = ips
        .len()
        .saturating_sub(trusted_proxy_depth.saturating_add(1));
    ips.get(index).copied()
}

async fn signaling_ws(
    State(state): State<AppState>,
    Query(query): Query<SignalingQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    state.sessions.validate_signaling_upgrade(&query.invite)?;
    Ok(ws
        .on_upgrade(move |socket| handle_socket(state, query.invite, socket))
        .into_response())
}

async fn handle_socket(state: AppState, invite_id: String, socket: WebSocket) {
    let (mut socket_sender, mut socket_receiver) = socket.split();
    let (outbound_tx, mut outbound_rx) =
        mpsc::channel::<ServerMessage>(state.signaling_outbound_queue_capacity);
    let writer = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            let Ok(text) = serde_json::to_string(&message) else {
                continue;
            };
            if socket_sender
                .send(Message::Text(text.into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let mut bound_role: Option<BoundRole> = None;
    let mut rate_limiter = MessageRateLimiter::default();

    loop {
        let next = match tokio::time::timeout(state.signaling_idle_timeout, socket_receiver.next())
            .await
        {
            Ok(Some(next)) => next,
            Ok(None) => break,
            Err(_) => {
                warn!(%invite_id, "signaling socket idle timeout elapsed");
                break;
            }
        };
        let message = match next {
            Ok(Message::Text(text)) => text,
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Binary(_)) => continue,
            Err(error) => {
                warn!(%invite_id, ?error, "signaling socket read failed");
                break;
            }
        };
        if message.len() > state.max_signaling_message_bytes {
            state
                .metrics
                .message_size_rejections
                .fetch_add(1, Ordering::Relaxed);
            let _ = try_send_server_message(
                &outbound_tx,
                ServerMessage::Error {
                    message: "Signaling message exceeds maximum size".to_string(),
                },
            );
            warn!(
                %invite_id,
                size = message.len(),
                max = state.max_signaling_message_bytes,
                "signaling message rejected for size"
            );
            // Close on oversize frames intentionally: a valid SDP/ICE message must fit
            // under this generous cap, and continuing would make DoS probing cheaper.
            break;
        }
        if !rate_limiter.record(
            Instant::now(),
            state.signaling_message_rate_limit,
            state.signaling_message_rate_window,
        ) {
            state
                .metrics
                .signaling_rate_limit_rejections
                .fetch_add(1, Ordering::Relaxed);
            let _ = try_send_server_message(
                &outbound_tx,
                ServerMessage::Error {
                    message: "Signaling message rate limit exceeded".to_string(),
                },
            );
            warn!(%invite_id, "signaling message rejected for connection rate limit");
            break;
        }

        let parsed = match serde_json::from_str::<ClientMessage>(&message) {
            Ok(parsed) => parsed,
            Err(error) => {
                state
                    .metrics
                    .signaling_parse_rejections
                    .fetch_add(1, Ordering::Relaxed);
                let _ = try_send_server_message(
                    &outbound_tx,
                    ServerMessage::Error {
                        message: format!("Invalid signaling message: {error}"),
                    },
                );
                break;
            }
        };

        if let Err(error) = handle_client_message(
            &state,
            &invite_id,
            &mut bound_role,
            outbound_tx.clone(),
            parsed,
        )
        .await
        {
            record_signaling_dispatch_error(&state.metrics, &error);
            let _ = try_send_server_message(
                &outbound_tx,
                ServerMessage::Error {
                    message: error.to_string(),
                },
            );
            warn!(%invite_id, ?error, "signaling message rejected");
            if error.is_fatal_for_socket() {
                break;
            }
        }
    }

    cleanup_connection(&state, &invite_id, bound_role).await;
    writer.abort();
}

#[derive(Default)]
struct MessageRateLimiter {
    seen: VecDeque<Instant>,
}

impl MessageRateLimiter {
    fn record(&mut self, now: Instant, limit: usize, window: Duration) -> bool {
        if limit == 0 {
            return false;
        }
        let window_start = now.checked_sub(window).unwrap_or(now);
        while self
            .seen
            .front()
            .is_some_and(|created_at| *created_at < window_start)
        {
            self.seen.pop_front();
        }
        if self.seen.len() >= limit {
            return false;
        }
        self.seen.push_back(now);
        true
    }
}

fn record_signaling_dispatch_error(metrics: &AppMetrics, error: &SessionError) {
    metrics
        .signaling_dispatch_rejections
        .fetch_add(1, Ordering::Relaxed);
    if *error == SessionError::DuplicateGuest {
        metrics
            .duplicate_guest_rejections
            .fetch_add(1, Ordering::Relaxed);
    }
    if *error == SessionError::GuestNotConnected {
        metrics
            .guest_forward_failures
            .fetch_add(1, Ordering::Relaxed);
    }
}

fn extract_bearer_token(value: &str) -> Option<&str> {
    let (scheme, token) = value.split_once(' ')?;
    if scheme.eq_ignore_ascii_case("Bearer") {
        Some(token)
    } else {
        None
    }
}

async fn handle_client_message(
    state: &AppState,
    socket_invite_id: &str,
    bound_role: &mut Option<BoundRole>,
    outbound_tx: OutboundSender,
    message: ClientMessage,
) -> Result<(), SessionError> {
    match message {
        ClientMessage::HostRegister {
            invite_id,
            host_secret,
        } => {
            ensure_socket_invite(socket_invite_id, &invite_id)?;
            state.sessions.register_host(&invite_id, &host_secret)?;
            state.hub.lock().await.bind_host(&invite_id, outbound_tx)?;
            *bound_role = Some(BoundRole::Host);
            send_to_self(
                state,
                &invite_id,
                ForwardTarget::Host,
                ServerMessage::HostRegistered {
                    invite_id: invite_id.clone(),
                },
            )
            .await;
        }
        ClientMessage::JoinRequest {
            invite_id,
            token,
            guest_display_name,
            guest_device_id,
        } => {
            ensure_socket_invite(socket_invite_id, &invite_id)?;
            let guest = GuestIdentity {
                display_name: guest_display_name,
                device_id: guest_device_id.clone(),
            };
            if !state.hub.lock().await.has_host(&invite_id) {
                return Err(SessionError::HostNotRegistered);
            }
            state
                .sessions
                .join_request(&invite_id, &token, guest.clone())?;
            state.hub.lock().await.bind_guest(&invite_id, outbound_tx)?;
            *bound_role = Some(BoundRole::Guest {
                device_id: guest_device_id.clone(),
            });
            forward(
                state,
                &invite_id,
                ForwardTarget::Host,
                ServerMessage::JoinRequest {
                    invite_id: invite_id.clone(),
                    guest_display_name: guest.display_name,
                    guest_device_id,
                },
            )
            .await?;
        }
        ClientMessage::JoinApproved {
            invite_id,
            guest_device_id,
        } => {
            ensure_socket_invite(socket_invite_id, &invite_id)?;
            let role = require_bound(bound_role)?;
            let host_device_id = state.sessions.host_device_id(&invite_id).ok();
            state
                .sessions
                .approve_guest(&invite_id, role, &guest_device_id)?;
            forward(
                state,
                &invite_id,
                ForwardTarget::Guest,
                ServerMessage::JoinApproved {
                    invite_id: invite_id.clone(),
                    guest_device_id,
                    host_device_id,
                },
            )
            .await?;
        }
        ClientMessage::JoinRejected {
            invite_id,
            guest_device_id,
            reason,
        } => {
            ensure_socket_invite(socket_invite_id, &invite_id)?;
            let role = require_bound(bound_role)?;
            state
                .sessions
                .reject_guest(&invite_id, role, &guest_device_id)?;
            let forward_result = forward(
                state,
                &invite_id,
                ForwardTarget::Guest,
                ServerMessage::JoinRejected {
                    invite_id: invite_id.clone(),
                    guest_device_id,
                    reason,
                },
            )
            .await;
            state.hub.lock().await.unbind_guest(&invite_id);
            forward_result?;
        }
        ClientMessage::VideoOffer {
            invite_id,
            guest_device_id,
            payload,
        } => {
            ensure_socket_invite(socket_invite_id, &invite_id)?;
            let role = require_bound(bound_role)?;
            state
                .sessions
                .authorize_offer(&invite_id, role, &guest_device_id)?;
            forward(
                state,
                &invite_id,
                ForwardTarget::Guest,
                ServerMessage::VideoOffer {
                    invite_id: invite_id.clone(),
                    guest_device_id,
                    payload,
                },
            )
            .await?;
        }
        ClientMessage::VideoAnswer {
            invite_id,
            guest_device_id,
            payload,
        } => {
            ensure_socket_invite(socket_invite_id, &invite_id)?;
            let role = require_bound(bound_role)?;
            state
                .sessions
                .authorize_answer(&invite_id, role, &guest_device_id)?;
            forward(
                state,
                &invite_id,
                ForwardTarget::Host,
                ServerMessage::VideoAnswer {
                    invite_id: invite_id.clone(),
                    guest_device_id,
                    payload,
                },
            )
            .await?;
        }
        ClientMessage::IceCandidate {
            invite_id,
            guest_device_id,
            payload,
        } => {
            ensure_socket_invite(socket_invite_id, &invite_id)?;
            let role = require_bound(bound_role)?;
            state
                .sessions
                .authorize_ice(&invite_id, role, &guest_device_id)?;
            let target = match role {
                BoundRole::Host => ForwardTarget::Guest,
                BoundRole::Guest { .. } => ForwardTarget::Host,
            };
            forward(
                state,
                &invite_id,
                target,
                ServerMessage::IceCandidate {
                    invite_id: invite_id.clone(),
                    guest_device_id,
                    payload,
                },
            )
            .await?;
        }
        ClientMessage::SessionRevoked { invite_id, reason } => {
            ensure_socket_invite(socket_invite_id, &invite_id)?;
            let role = require_bound(bound_role)?;
            state.sessions.revoke(&invite_id, role)?;
            state
                .metrics
                .session_revoked_messages
                .fetch_add(1, Ordering::Relaxed);
            broadcast_revoked(state, &invite_id, reason).await;
        }
        ClientMessage::Heartbeat { invite_id } => {
            ensure_socket_invite(socket_invite_id, &invite_id)?;
            state
                .sessions
                .authorize_heartbeat(&invite_id, bound_role.as_ref())?;
            state
                .metrics
                .heartbeat_messages
                .fetch_add(1, Ordering::Relaxed);
            let target = match require_bound(bound_role)? {
                BoundRole::Host => ForwardTarget::Host,
                BoundRole::Guest { .. } => ForwardTarget::Guest,
            };
            send_to_self(
                state,
                &invite_id,
                target,
                ServerMessage::HeartbeatAck {
                    invite_id: invite_id.clone(),
                },
            )
            .await;
        }
    }
    Ok(())
}

fn ensure_socket_invite(
    socket_invite_id: &str,
    message_invite_id: &str,
) -> Result<(), SessionError> {
    if socket_invite_id == message_invite_id {
        Ok(())
    } else {
        Err(SessionError::InvalidInviteId)
    }
}

fn require_bound(role: &Option<BoundRole>) -> Result<&BoundRole, SessionError> {
    role.as_ref().ok_or(SessionError::RoleForbidden)
}

async fn forward(
    state: &AppState,
    invite_id: &str,
    target: ForwardTarget,
    message: ServerMessage,
) -> Result<(), SessionError> {
    let sent = state.hub.lock().await.send(invite_id, target, message);
    if sent {
        Ok(())
    } else {
        match target {
            ForwardTarget::Host => Err(SessionError::HostNotRegistered),
            ForwardTarget::Guest => Err(SessionError::GuestNotConnected),
        }
    }
}

async fn send_to_self(
    state: &AppState,
    invite_id: &str,
    target: ForwardTarget,
    message: ServerMessage,
) {
    let _ = state.hub.lock().await.send(invite_id, target, message);
}

async fn broadcast_revoked(state: &AppState, invite_id: &str, reason: Option<String>) {
    let guest_notice = {
        let mut hub = state.hub.lock().await;
        let guest = hub
            .invites
            .get(invite_id)
            .and_then(|connections| connections.guest.clone());
        hub.invites.remove(invite_id);
        guest.map(|sender| {
            (
                sender,
                ServerMessage::SessionRevoked {
                    invite_id: invite_id.to_string(),
                    reason,
                },
            )
        })
    };
    if let Some((sender, message)) = guest_notice {
        let _ =
            send_critical_server_message(&sender, message, state.critical_signaling_send_timeout)
                .await;
    }
}

async fn send_critical_server_message(
    sender: &OutboundSender,
    message: ServerMessage,
    timeout: Duration,
) -> bool {
    match tokio::time::timeout(timeout, sender.send(message)).await {
        Ok(Ok(())) => true,
        Ok(Err(_)) => {
            warn!("dropping critical signaling message because outbound queue is closed");
            false
        }
        Err(_) => {
            warn!(
                ?timeout,
                "dropping critical signaling message because outbound queue stayed full"
            );
            false
        }
    }
}

async fn cleanup_connection(state: &AppState, invite_id: &str, role: Option<BoundRole>) {
    let Some(role) = role else {
        return;
    };
    let mut peer_notice: Option<(OutboundSender, ServerMessage)> = None;
    let was_bound = {
        let mut hub = state.hub.lock().await;
        let mut was_bound = false;
        let mut should_remove = false;
        if let Some(connections) = hub.invites.get_mut(invite_id) {
            match &role {
                BoundRole::Host => {
                    if connections.host.is_some() {
                        was_bound = true;
                        if let Some(guest) = connections.guest.as_ref() {
                            peer_notice = Some((
                                guest.clone(),
                                ServerMessage::HostDisconnected {
                                    invite_id: invite_id.to_string(),
                                },
                            ));
                        }
                    }
                    connections.host = None;
                }
                BoundRole::Guest { device_id } => {
                    if connections.guest.is_some() {
                        was_bound = true;
                        if let Some(host) = connections.host.as_ref() {
                            peer_notice = Some((
                                host.clone(),
                                ServerMessage::GuestDisconnected {
                                    invite_id: invite_id.to_string(),
                                    guest_device_id: device_id.clone(),
                                },
                            ));
                        }
                    }
                    connections.guest = None;
                }
            }
            should_remove = connections.host.is_none() && connections.guest.is_none();
        }
        if should_remove {
            hub.invites.remove(invite_id);
        }
        was_bound
    };
    if let Some((sender, message)) = peer_notice {
        let _ =
            send_critical_server_message(&sender, message, state.critical_signaling_send_timeout)
                .await;
    }
    if was_bound {
        match &role {
            BoundRole::Host => {
                let _ = state.sessions.disconnect_host(invite_id);
            }
            BoundRole::Guest { device_id } => {
                let _ = state.sessions.disconnect_guest(invite_id, device_id);
            }
        }
    }
}

impl ConnectionHub {
    fn bind_host(&mut self, invite_id: &str, sender: OutboundSender) -> Result<(), SessionError> {
        let connections = self.invites.entry(invite_id.to_string()).or_default();
        if connections.host.is_some() {
            return Err(SessionError::DuplicateHost);
        }
        connections.host = Some(sender);
        Ok(())
    }

    fn bind_guest(&mut self, invite_id: &str, sender: OutboundSender) -> Result<(), SessionError> {
        let connections = self.invites.entry(invite_id.to_string()).or_default();
        if connections.guest.is_some() {
            return Err(SessionError::DuplicateGuest);
        }
        connections.guest = Some(sender);
        Ok(())
    }

    fn unbind_guest(&mut self, invite_id: &str) {
        let mut should_remove = false;
        if let Some(connections) = self.invites.get_mut(invite_id) {
            connections.guest = None;
            should_remove = connections.host.is_none();
        }
        if should_remove {
            self.invites.remove(invite_id);
        }
    }

    fn send(&self, invite_id: &str, target: ForwardTarget, message: ServerMessage) -> bool {
        let Some(connections) = self.invites.get(invite_id) else {
            return false;
        };
        let sender = match target {
            ForwardTarget::Host => connections.host.as_ref(),
            ForwardTarget::Guest => connections.guest.as_ref(),
        };
        sender.is_some_and(|sender| try_send_server_message(sender, message))
    }

    fn has_host(&self, invite_id: &str) -> bool {
        self.invites
            .get(invite_id)
            .and_then(|connections| connections.host.as_ref())
            .is_some()
    }
}

fn try_send_server_message(sender: &OutboundSender, message: ServerMessage) -> bool {
    match sender.try_send(message) {
        Ok(()) => true,
        Err(mpsc::error::TrySendError::Full(_)) => {
            warn!("dropping signaling message because outbound queue is full");
            false
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            warn!("dropping signaling message because outbound queue is closed");
            false
        }
    }
}

#[derive(Debug)]
struct ApiError(SessionError);

impl From<SessionError> for ApiError {
    fn from(error: SessionError) -> Self {
        Self(error)
    }
}

#[derive(Debug, Default)]
struct HubMetricsSnapshot {
    active_guest_sockets: usize,
    active_host_sockets: usize,
}

impl ConnectionHub {
    fn metrics_snapshot(&self) -> HubMetricsSnapshot {
        let mut snapshot = HubMetricsSnapshot::default();
        for connections in self.invites.values() {
            if connections
                .host
                .as_ref()
                .is_some_and(|sender| !sender.is_closed())
            {
                snapshot.active_host_sockets += 1;
            }
            if connections
                .guest
                .as_ref()
                .is_some_and(|sender| !sender.is_closed())
            {
                snapshot.active_guest_sockets += 1;
            }
        }
        snapshot
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.0 {
            SessionError::InvalidInviteId => StatusCode::BAD_REQUEST,
            SessionError::InviteNotFound => StatusCode::NOT_FOUND,
            SessionError::InviteExpired | SessionError::InviteRevoked => StatusCode::NOT_FOUND,
            SessionError::InvalidToken | SessionError::RoleForbidden => StatusCode::UNAUTHORIZED,
            SessionError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            SessionError::DuplicateHost | SessionError::DuplicateGuest => StatusCode::CONFLICT,
            // GuestNotConnected is currently emitted on the WebSocket path; keep this
            // mapping explicit in case a future HTTP handler reuses the same error.
            SessionError::GuestNotConnected => StatusCode::NOT_FOUND,
            SessionError::HostNotRegistered
            | SessionError::UnknownGuest
            | SessionError::GuestNotApproved => StatusCode::BAD_REQUEST,
            SessionError::ClockError => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let body = Json(json!({ "error": self.0.to_string() }));
        (status, body).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    fn test_state() -> AppState {
        AppState {
            sessions: Arc::new(SessionStore::new(ServiceConfig {
                invite_ttl: Duration::from_secs(900),
                relay_url: "ws://127.0.0.1:8080/v1/remote/signaling".to_string(),
                public_base_url: "http://127.0.0.1:8080".to_string(),
                hmac_key: b"test-hmac-key".to_vec(),
                stun_urls: vec![],
                turn_urls: vec![],
                turn_static_auth_secret: None,
                turn_credential_ttl: Duration::from_secs(3600),
                invite_rate_limit_per_hour: 20,
            })),
            hub: Arc::new(Mutex::new(ConnectionHub::default())),
            metrics_bearer_token: Some("metrics-token".to_string()),
            metrics: Arc::new(AppMetrics::default()),
            max_signaling_message_bytes: 262_144,
            signaling_idle_timeout: DEFAULT_SIGNALING_IDLE_TIMEOUT,
            signaling_outbound_queue_capacity: DEFAULT_SIGNALING_OUTBOUND_QUEUE_CAPACITY,
            signaling_message_rate_limit: DEFAULT_SIGNALING_MESSAGE_RATE_LIMIT,
            signaling_message_rate_window: DEFAULT_SIGNALING_MESSAGE_RATE_WINDOW,
            critical_signaling_send_timeout: DEFAULT_CRITICAL_SIGNALING_SEND_TIMEOUT,
            trusted_proxy_depth: 0,
        }
    }

    fn test_channel() -> (OutboundSender, mpsc::Receiver<ServerMessage>) {
        mpsc::channel(DEFAULT_SIGNALING_OUTBOUND_QUEUE_CAPACITY)
    }

    fn host_target_message(invite_id: &str) -> ServerMessage {
        ServerMessage::JoinRequest {
            invite_id: invite_id.to_string(),
            guest_display_name: "Guest".to_string(),
            guest_device_id: "guest-device".to_string(),
        }
    }

    fn guest_target_message(invite_id: &str) -> ServerMessage {
        ServerMessage::JoinApproved {
            invite_id: invite_id.to_string(),
            guest_device_id: "guest-device".to_string(),
            host_device_id: Some(String::new()),
        }
    }

    #[test]
    fn normalizes_metrics_bearer_token_from_secret_sources() {
        assert_eq!(
            normalize_metrics_bearer_token(" metrics-token\n"),
            Some("metrics-token".to_string())
        );
        assert_eq!(normalize_metrics_bearer_token(" \t\n"), None);
    }

    #[test]
    fn metrics_token_match_uses_fixed_length_digest_comparison() {
        let expected = normalize_metrics_bearer_token("metrics-token\n").unwrap();
        assert!(metrics_token_matches("metrics-token", &expected));
        assert!(metrics_token_matches("metrics-token ", &expected));
        assert!(metrics_token_matches("metrics-token", " metrics-token\n"));
        assert!(!metrics_token_matches("wrong-token", &expected));
        assert!(!metrics_token_matches("metrics-token-extra", &expected));
    }

    #[test]
    fn production_hmac_key_rejects_missing_dev_and_short_values() {
        assert!(resolve_hmac_key(None, true).is_err());
        assert!(resolve_hmac_key(Some(DEV_HMAC_KEY.to_string()), true).is_err());
        assert!(resolve_hmac_key(Some("short-production-key".to_string()), true).is_err());
        assert_eq!(
            resolve_hmac_key(None, false).unwrap(),
            DEV_HMAC_KEY.as_bytes()
        );
        assert!(resolve_hmac_key(
            Some("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f".to_string()),
            true
        )
        .is_ok());
    }

    #[test]
    fn production_hmac_key_checks_decoded_hex_and_base64_length() {
        let hex_32_bytes = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        let hex_16_bytes = "000102030405060708090a0b0c0d0e0f";
        let base64_32_bytes = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

        assert_eq!(
            resolve_hmac_key(Some(hex_32_bytes.to_string()), true)
                .unwrap()
                .len(),
            32
        );
        assert!(resolve_hmac_key(Some(hex_16_bytes.to_string()), true).is_err());
        assert_eq!(
            resolve_hmac_key(Some(base64_32_bytes.to_string()), true)
                .unwrap()
                .len(),
            32
        );
    }

    #[test]
    fn non_production_hmac_key_keeps_raw_bytes() {
        assert_eq!(
            resolve_hmac_key(Some("deadbeef".to_string()), false).unwrap(),
            b"deadbeef"
        );
        assert_eq!(
            resolve_hmac_key(Some("dGVzdA==".to_string()), false).unwrap(),
            b"dGVzdA=="
        );
    }

    #[test]
    fn turn_config_requires_paired_distinct_secrets() {
        let hmac_key = b"0123456789abcdef0123456789abcdef";
        let turn_urls = vec!["turn:turn.easycris.com:3478".to_string()];

        assert!(validate_turn_config(&turn_urls, None, hmac_key, false).is_err());
        assert!(validate_turn_config(&[], Some("turn-secret"), hmac_key, false).is_err());
        let raw_hmac_key = b"same-raw-secret-not-encoded!!!";
        assert!(validate_turn_config(
            &turn_urls,
            Some(std::str::from_utf8(raw_hmac_key).unwrap()),
            raw_hmac_key,
            false
        )
        .is_err());
        assert!(validate_turn_config(
            &turn_urls,
            Some("change-this-turn-secret-local-dev-only"),
            hmac_key,
            true
        )
        .is_err());
        assert!(validate_turn_config(
            &turn_urls,
            Some("turn-secret-with-32-raw-bytes!!!"),
            hmac_key,
            true
        )
        .is_ok());
    }

    #[test]
    fn turn_config_rejects_same_encoded_secret_as_hmac_key() {
        let same_hex_secret = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        let hmac_key = resolve_hmac_key(Some(same_hex_secret.to_string()), true).unwrap();
        let turn_urls = vec!["turn:turn.easycris.com:3478".to_string()];

        assert!(validate_turn_config(&turn_urls, Some(same_hex_secret), &hmac_key, true).is_err());
    }

    #[test]
    fn turn_config_rejects_encoded_dev_secret_in_production() {
        let hmac_key = resolve_hmac_key(
            Some("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f".to_string()),
            true,
        )
        .unwrap();
        let turn_urls = vec!["turn:turn.easycris.com:3478".to_string()];
        let encoded_dev_secret = "Y2hhbmdlLXRoaXMtdHVybi1zZWNyZXQtbG9jYWwtZGV2LW9ubHk=";

        assert!(
            validate_turn_config(&turn_urls, Some(encoded_dev_secret), &hmac_key, true).is_err()
        );
    }

    #[test]
    fn turn_config_rejects_same_encoded_secret_in_non_production() {
        let same_secret = "dGVzdA==";
        let turn_urls = vec!["turn:turn.easycris.com:3478".to_string()];
        let hmac_key = resolve_hmac_key(Some(same_secret.to_string()), false).unwrap();

        assert!(validate_turn_config(&turn_urls, Some(same_secret), &hmac_key, false).is_err());
    }

    #[test]
    fn turn_config_rejects_cross_encoded_same_secret_material() {
        let hmac_hex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        let same_material_base64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        let hmac_key = resolve_hmac_key(Some(hmac_hex.to_string()), true).unwrap();
        let turn_urls = vec!["turn:turn.easycris.com:3478".to_string()];

        assert!(
            validate_turn_config(&turn_urls, Some(same_material_base64), &hmac_key, true).is_err()
        );
    }

    #[test]
    fn turn_config_rejects_short_decoded_secret_in_production() {
        let hmac_key = resolve_hmac_key(
            Some("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f".to_string()),
            true,
        )
        .unwrap();
        let turn_urls = vec!["turn:turn.easycris.com:3478".to_string()];

        assert!(validate_turn_config(
            &turn_urls,
            Some("0102030405060708090a0b0c0d0e0f10"),
            &hmac_key,
            true
        )
        .is_err());
    }

    #[test]
    fn trusted_proxy_depth_controls_invite_rate_limit_ip_key() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.7, 10.0.0.4"),
        );
        let remote_addr: SocketAddr = "192.0.2.10:443".parse().unwrap();

        assert_eq!(rate_limit_ip_key(&headers, remote_addr, 0), "192.0.2.10");
        assert_eq!(rate_limit_ip_key(&headers, remote_addr, 1), "203.0.113.7");
        assert_eq!(rate_limit_ip_key(&headers, remote_addr, 2), "203.0.113.7");

        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.7, 10.0.0.5, 10.0.0.4"),
        );
        assert_eq!(rate_limit_ip_key(&headers, remote_addr, 1), "10.0.0.5");
        assert_eq!(rate_limit_ip_key(&headers, remote_addr, 2), "203.0.113.7");
    }

    #[test]
    fn rate_limit_falls_back_to_remote_addr_when_xff_absent() {
        let headers = HeaderMap::new();
        let remote_addr: SocketAddr = "10.0.0.4:443".parse().unwrap();

        assert_eq!(rate_limit_ip_key(&headers, remote_addr, 1), "10.0.0.4");
    }

    #[test]
    fn signaling_message_rate_limiter_rejects_over_window_limit() {
        let mut limiter = MessageRateLimiter::default();
        let now = Instant::now();

        assert!(limiter.record(now, 2, Duration::from_secs(10)));
        assert!(limiter.record(now + Duration::from_secs(1), 2, Duration::from_secs(10)));
        assert!(!limiter.record(now + Duration::from_secs(2), 2, Duration::from_secs(10)));
        assert!(limiter.record(now + Duration::from_secs(12), 2, Duration::from_secs(10)));
    }

    #[test]
    fn signaling_message_rate_limiter_zero_limit_rejects_without_recording() {
        let mut limiter = MessageRateLimiter::default();

        assert!(!limiter.record(Instant::now(), 0, Duration::from_secs(10)));
        assert!(limiter.seen.is_empty());
    }

    #[test]
    fn bounded_outbound_queue_fails_fast_when_full() {
        let (tx, _rx) = mpsc::channel(1);

        assert!(try_send_server_message(
            &tx,
            host_target_message("rmt_test")
        ));
        assert!(!try_send_server_message(
            &tx,
            host_target_message("rmt_test")
        ));
    }

    #[test]
    fn extracts_bearer_token_case_insensitively() {
        assert_eq!(
            extract_bearer_token("Bearer metrics-token"),
            Some("metrics-token")
        );
        assert_eq!(
            extract_bearer_token("bearer metrics-token"),
            Some("metrics-token")
        );
        assert_eq!(
            extract_bearer_token("BEARER metrics-token"),
            Some("metrics-token")
        );
        assert_eq!(extract_bearer_token("Basic metrics-token"), None);
    }

    #[tokio::test]
    async fn cors_preflight_allows_browser_post_requests() {
        let response = add_cors_headers(cors_preflight().await.into_response()).await;

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("*"))
        );
        assert_eq!(
            response.headers().get(header::ACCESS_CONTROL_ALLOW_METHODS),
            Some(&HeaderValue::from_static("GET,POST,OPTIONS"))
        );
        assert_eq!(
            response.headers().get(header::ACCESS_CONTROL_ALLOW_HEADERS),
            Some(&HeaderValue::from_static("authorization,content-type"))
        );
    }

    #[tokio::test]
    async fn forward_reports_missing_host_target() {
        let state = test_state();
        let error = forward(
            &state,
            "rmt_test",
            ForwardTarget::Host,
            host_target_message("rmt_test"),
        )
        .await
        .unwrap_err();

        assert_eq!(error, SessionError::HostNotRegistered);
    }

    #[tokio::test]
    async fn forward_reports_disconnected_guest_without_dropping_host() {
        let state = test_state();
        let invite_id = "rmt_test";
        let (host_tx, _host_rx) = test_channel();
        let (guest_tx, guest_rx) = test_channel();
        drop(guest_rx);
        {
            let mut hub = state.hub.lock().await;
            hub.bind_host(invite_id, host_tx).unwrap();
            hub.bind_guest(invite_id, guest_tx).unwrap();
        }

        let error = forward(
            &state,
            invite_id,
            ForwardTarget::Guest,
            guest_target_message(invite_id),
        )
        .await
        .unwrap_err();

        assert_eq!(error, SessionError::GuestNotConnected);
        assert!(state.hub.lock().await.has_host(invite_id));
    }

    #[tokio::test]
    async fn broadcast_revoked_notifies_guest_without_echoing_host() {
        let state = test_state();
        let invite_id = "rmt_test";
        let (host_tx, mut host_rx) = test_channel();
        let (guest_tx, mut guest_rx) = test_channel();
        {
            let mut hub = state.hub.lock().await;
            hub.bind_host(invite_id, host_tx).unwrap();
            hub.bind_guest(invite_id, guest_tx).unwrap();
        }

        broadcast_revoked(&state, invite_id, Some("ended".to_string())).await;

        let guest_message = tokio::time::timeout(Duration::from_millis(100), guest_rx.recv())
            .await
            .expect("guest should receive revoke")
            .expect("guest channel should stay open for revoke");
        match guest_message {
            ServerMessage::SessionRevoked {
                invite_id: actual,
                reason,
            } => {
                assert_eq!(actual, invite_id);
                assert_eq!(reason, Some("ended".to_string()));
            }
            other => panic!("unexpected guest revoke message: {other:?}"),
        }
        if let Ok(Some(message)) =
            tokio::time::timeout(Duration::from_millis(50), host_rx.recv()).await
        {
            panic!("host should not receive its own revoke echo: {message:?}");
        }
        assert!(!state.hub.lock().await.invites.contains_key(invite_id));
    }

    #[tokio::test]
    async fn critical_send_waits_for_queue_room() {
        let invite_id = "rmt_test";
        let (tx, mut rx) = mpsc::channel(1);
        assert!(try_send_server_message(
            &tx,
            guest_target_message(invite_id)
        ));
        let send = send_critical_server_message(
            &tx,
            ServerMessage::SessionRevoked {
                invite_id: invite_id.to_string(),
                reason: None,
            },
            DEFAULT_CRITICAL_SIGNALING_SEND_TIMEOUT,
        );
        tokio::pin!(send);
        let blocked = tokio::time::timeout(Duration::ZERO, &mut send).await;
        assert!(
            blocked.is_err(),
            "critical send should wait while queue is full"
        );

        let _queued = rx.recv().await.expect("pre-filled message");
        assert!(send.await);
        let guest_message = rx.recv().await.expect("critical message");
        match guest_message {
            ServerMessage::SessionRevoked {
                invite_id: actual,
                reason,
            } => {
                assert_eq!(actual, invite_id);
                assert_eq!(reason, None);
            }
            other => panic!("unexpected guest revoke message: {other:?}"),
        }
    }

    #[tokio::test]
    async fn cleanup_connection_delivers_guest_disconnect_after_full_host_queue_drains() {
        let state = test_state();
        let invite_id = "rmt_test";
        let (host_tx, mut host_rx) = mpsc::channel(1);
        let (guest_tx, _guest_rx) = test_channel();
        assert!(try_send_server_message(
            &host_tx,
            host_target_message(invite_id)
        ));
        {
            let mut hub = state.hub.lock().await;
            hub.bind_host(invite_id, host_tx).unwrap();
            hub.bind_guest(invite_id, guest_tx).unwrap();
        }

        let cleanup = cleanup_connection(
            &state,
            invite_id,
            Some(BoundRole::Guest {
                device_id: "guest-device".to_string(),
            }),
        );
        tokio::pin!(cleanup);
        let blocked = tokio::time::timeout(Duration::ZERO, &mut cleanup).await;
        assert!(
            blocked.is_err(),
            "cleanup should wait while host queue is full"
        );
        let _queued = host_rx.recv().await.expect("pre-filled message");
        cleanup.await;

        let host_message = host_rx.recv().await.expect("disconnect notice");
        match host_message {
            ServerMessage::GuestDisconnected {
                invite_id: actual_invite_id,
                guest_device_id,
            } => {
                assert_eq!(actual_invite_id, invite_id);
                assert_eq!(guest_device_id, "guest-device");
            }
            other => panic!("unexpected host disconnect message: {other:?}"),
        }
    }

    #[tokio::test]
    async fn guest_cleanup_notifies_host_immediately() {
        let state = test_state();
        let invite_id = "rmt_test";
        let (host_tx, mut host_rx) = test_channel();
        let (guest_tx, _guest_rx) = test_channel();
        {
            let mut hub = state.hub.lock().await;
            hub.bind_host(invite_id, host_tx).unwrap();
            hub.bind_guest(invite_id, guest_tx).unwrap();
        }

        cleanup_connection(
            &state,
            invite_id,
            Some(BoundRole::Guest {
                device_id: "guest-device".to_string(),
            }),
        )
        .await;

        let host_message = tokio::time::timeout(Duration::from_millis(100), host_rx.recv())
            .await
            .expect("host should receive guest disconnect")
            .expect("host channel should stay open for disconnect notice");
        match host_message {
            ServerMessage::GuestDisconnected {
                invite_id: actual_invite_id,
                guest_device_id,
            } => {
                assert_eq!(actual_invite_id, invite_id);
                assert_eq!(guest_device_id, "guest-device");
            }
            other => panic!("unexpected host disconnect message: {other:?}"),
        }
        assert_eq!(active_guest_socket_count(&state).await, 0);
    }

    #[tokio::test]
    async fn cleanup_removes_hub_entry_after_both_peers_disconnect() {
        let state = test_state();
        let invite_id = "rmt_test";
        let (host_tx, mut host_rx) = test_channel();
        let (guest_tx, _guest_rx) = test_channel();
        {
            let mut hub = state.hub.lock().await;
            hub.bind_host(invite_id, host_tx).unwrap();
            hub.bind_guest(invite_id, guest_tx).unwrap();
        }

        cleanup_connection(
            &state,
            invite_id,
            Some(BoundRole::Guest {
                device_id: "guest-device".to_string(),
            }),
        )
        .await;
        let _ = host_rx.recv().await;
        cleanup_connection(&state, invite_id, Some(BoundRole::Host)).await;

        assert!(!state.hub.lock().await.invites.contains_key(invite_id));
    }

    #[tokio::test]
    async fn rejected_guest_is_unbound_from_hub_after_notice() {
        let state = test_state();
        let invite = state.sessions.create_invite("127.0.0.1").unwrap();
        let invite_id = invite.invite_id.as_str();
        state
            .sessions
            .register_host(invite_id, &invite.host_secret)
            .unwrap();
        state
            .sessions
            .join_request(
                invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest".to_string(),
                    device_id: "guest-device".to_string(),
                },
            )
            .unwrap();
        let (host_tx, mut host_rx) = test_channel();
        let (guest_tx, mut guest_rx) = test_channel();
        let (outbound_tx, _outbound_rx) = test_channel();
        {
            let mut hub = state.hub.lock().await;
            hub.bind_host(invite_id, host_tx).unwrap();
            hub.bind_guest(invite_id, guest_tx).unwrap();
        }
        let mut bound_role = Some(BoundRole::Host);

        handle_client_message(
            &state,
            invite_id,
            &mut bound_role,
            outbound_tx,
            ClientMessage::JoinRejected {
                invite_id: invite_id.to_string(),
                guest_device_id: "guest-device".to_string(),
                reason: "No".to_string(),
            },
        )
        .await
        .unwrap();

        let guest_message = tokio::time::timeout(Duration::from_millis(100), guest_rx.recv())
            .await
            .expect("guest should receive rejection")
            .expect("guest channel should stay open for rejection");
        match guest_message {
            ServerMessage::JoinRejected {
                invite_id: actual_invite_id,
                guest_device_id,
                reason,
            } => {
                assert_eq!(actual_invite_id, invite_id);
                assert_eq!(guest_device_id, "guest-device");
                assert_eq!(reason, "No");
            }
            other => panic!("unexpected guest rejection message: {other:?}"),
        }
        assert_eq!(active_guest_socket_count(&state).await, 0);

        cleanup_connection(
            &state,
            invite_id,
            Some(BoundRole::Guest {
                device_id: "guest-device".to_string(),
            }),
        )
        .await;
        if let Ok(Some(message)) =
            tokio::time::timeout(Duration::from_millis(50), host_rx.recv()).await
        {
            panic!("rejected guest close should not notify host: {message:?}");
        }
    }

    #[tokio::test]
    async fn rejected_guest_is_unbound_even_when_rejection_forward_fails() {
        let state = test_state();
        let invite = state.sessions.create_invite("127.0.0.1").unwrap();
        let invite_id = invite.invite_id.as_str();
        state
            .sessions
            .register_host(invite_id, &invite.host_secret)
            .unwrap();
        state
            .sessions
            .join_request(
                invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest".to_string(),
                    device_id: "guest-device".to_string(),
                },
            )
            .unwrap();
        let (host_tx, _host_rx) = test_channel();
        let (guest_tx, guest_rx) = test_channel();
        drop(guest_rx);
        let (outbound_tx, _outbound_rx) = test_channel();
        {
            let mut hub = state.hub.lock().await;
            hub.bind_host(invite_id, host_tx).unwrap();
            hub.bind_guest(invite_id, guest_tx).unwrap();
        }
        let mut bound_role = Some(BoundRole::Host);

        let error = handle_client_message(
            &state,
            invite_id,
            &mut bound_role,
            outbound_tx,
            ClientMessage::JoinRejected {
                invite_id: invite_id.to_string(),
                guest_device_id: "guest-device".to_string(),
                reason: "No".to_string(),
            },
        )
        .await
        .unwrap_err();

        assert_eq!(error, SessionError::GuestNotConnected);
        assert_eq!(active_guest_socket_count(&state).await, 0);
    }

    #[tokio::test]
    async fn record_signaling_dispatch_error_increments_both_counters_on_guest_not_connected() {
        let state = test_state();
        let invite = state.sessions.create_invite("127.0.0.1").unwrap();
        let invite_id = invite.invite_id.as_str();
        state
            .sessions
            .register_host(invite_id, &invite.host_secret)
            .unwrap();
        state
            .sessions
            .join_request(
                invite_id,
                &invite.guest_token,
                GuestIdentity {
                    display_name: "Guest".to_string(),
                    device_id: "guest-device".to_string(),
                },
            )
            .unwrap();
        state
            .sessions
            .approve_guest(invite_id, &BoundRole::Host, "guest-device")
            .unwrap();
        let (host_tx, _host_rx) = test_channel();
        let (guest_tx, guest_rx) = test_channel();
        let (outbound_tx, _outbound_rx) = test_channel();
        drop(guest_rx);
        {
            let mut hub = state.hub.lock().await;
            hub.bind_host(invite_id, host_tx).unwrap();
            hub.bind_guest(invite_id, guest_tx).unwrap();
        }
        let mut bound_role = Some(BoundRole::Host);

        let error = handle_client_message(
            &state,
            invite_id,
            &mut bound_role,
            outbound_tx,
            ClientMessage::VideoOffer {
                invite_id: invite_id.to_string(),
                guest_device_id: "guest-device".to_string(),
                payload: json!({ "sdp": "offer" }),
            },
        )
        .await
        .unwrap_err();
        record_signaling_dispatch_error(&state.metrics, &error);

        assert_eq!(error, SessionError::GuestNotConnected);
        assert_eq!(
            state
                .metrics
                .signaling_dispatch_rejections
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(
            state.metrics.guest_forward_failures.load(Ordering::Relaxed),
            1
        );
    }

    #[tokio::test]
    async fn handle_socket_rejects_offer_after_guest_disconnects() {
        let state = test_state();
        let invite = state.sessions.create_invite("127.0.0.1").unwrap();
        let invite_id = invite.invite_id.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v1/remote/signaling", get(signaling_ws))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        let mut host = open_test_websocket(addr, &invite_id).await;
        host.send_json(&ClientMessage::HostRegister {
            invite_id: invite_id.clone(),
            host_secret: invite.host_secret,
        })
        .await;
        let _ = read_text_frame_with_timeout(&mut host).await;

        let mut guest = open_test_websocket(addr, &invite_id).await;
        guest
            .send_json(&ClientMessage::JoinRequest {
                invite_id: invite_id.clone(),
                token: invite.guest_token,
                guest_display_name: "Guest".to_string(),
                guest_device_id: "guest-device".to_string(),
            })
            .await;
        let _ = read_text_frame_with_timeout(&mut host).await;

        host.send_json(&ClientMessage::JoinApproved {
            invite_id: invite_id.clone(),
            guest_device_id: "guest-device".to_string(),
        })
        .await;
        let _ = read_text_frame_with_timeout(&mut guest).await;
        assert_eq!(active_guest_socket_count(&state).await, 1);
        drop(guest);
        wait_for_guest_channel_closed(&state, &invite_id).await;
        let disconnect_notice = read_text_frame_with_timeout(&mut host).await;
        let disconnect_notice: ServerMessage =
            serde_json::from_str(&disconnect_notice).expect("typed disconnect notice");
        match disconnect_notice {
            ServerMessage::GuestDisconnected {
                invite_id: actual_invite_id,
                guest_device_id,
            } => {
                assert_eq!(actual_invite_id, invite_id);
                assert_eq!(guest_device_id, "guest-device");
            }
            other => panic!("unexpected disconnect notice: {other:?}"),
        }

        host.send_json(&ClientMessage::VideoOffer {
            invite_id: invite_id.clone(),
            guest_device_id: "guest-device".to_string(),
            payload: json!({ "sdp": "offer" }),
        })
        .await;
        let error = read_text_frame_with_timeout(&mut host).await;

        assert!(error.contains("guest is not approved"));
        assert_eq!(
            state
                .metrics
                .signaling_dispatch_rejections
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(
            state.metrics.guest_forward_failures.load(Ordering::Relaxed),
            0
        );
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn idle_socket_timeout_releases_host_slot_and_store_state() {
        let mut state = test_state();
        state.signaling_idle_timeout = Duration::from_millis(20);
        let invite = state.sessions.create_invite("127.0.0.1").unwrap();
        let invite_id = invite.invite_id.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v1/remote/signaling", get(signaling_ws))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        let mut host = open_test_websocket(addr, &invite_id).await;
        host.send_json(&ClientMessage::HostRegister {
            invite_id: invite_id.clone(),
            host_secret: invite.host_secret,
        })
        .await;
        let _ = read_text_frame_with_timeout(&mut host).await;
        assert_eq!(active_host_socket_count(&state).await, 1);

        wait_for_host_channel_closed(&state, &invite_id).await;

        assert_eq!(
            state.sessions.public_metadata(&invite_id).unwrap().status,
            "created"
        );
        server.abort();
        let _ = server.await;
    }

    async fn wait_for_guest_channel_closed(state: &AppState, invite_id: &str) {
        for _ in 0..200 {
            if active_guest_socket_count(state).await == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("guest channel did not close for {invite_id}");
    }

    async fn wait_for_host_channel_closed(state: &AppState, invite_id: &str) {
        for _ in 0..200 {
            if active_host_socket_count(state).await == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("host channel did not close for {invite_id}");
    }

    async fn active_guest_socket_count(state: &AppState) -> usize {
        state
            .hub
            .lock()
            .await
            .metrics_snapshot()
            .active_guest_sockets
    }

    async fn active_host_socket_count(state: &AppState) -> usize {
        state
            .hub
            .lock()
            .await
            .metrics_snapshot()
            .active_host_sockets
    }

    struct TestWebSocket {
        stream: TcpStream,
    }

    async fn open_test_websocket(addr: SocketAddr, invite_id: &str) -> TestWebSocket {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let request = format!(
            "GET /v1/remote/signaling?invite={invite_id} HTTP/1.1\r\n\
             Host: {addr}\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Sec-WebSocket-Version: 13\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let response = read_until_headers_end(&mut stream).await;
        assert!(
            response.starts_with("HTTP/1.1 101"),
            "unexpected websocket handshake response: {response}"
        );
        TestWebSocket { stream }
    }

    async fn read_text_frame_with_timeout(socket: &mut TestWebSocket) -> String {
        tokio::time::timeout(Duration::from_secs(5), socket.read_text_frame())
            .await
            .expect("timed out waiting for websocket text frame")
    }

    async fn read_until_headers_end(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        loop {
            let mut byte = [0_u8; 1];
            stream.read_exact(&mut byte).await.unwrap();
            bytes.push(byte[0]);
            if bytes.ends_with(b"\r\n\r\n") {
                return String::from_utf8(bytes).unwrap();
            }
        }
    }

    impl TestWebSocket {
        async fn send_json(&mut self, message: &ClientMessage) {
            let payload = serde_json::to_vec(message).unwrap();
            self.send_text_payload(&payload).await;
        }

        async fn send_text_payload(&mut self, payload: &[u8]) {
            assert!(
                payload.len() <= u16::MAX as usize,
                "test websocket helper only supports payloads up to 65535 bytes"
            );
            let mut frame = vec![0x81];
            if payload.len() < 126 {
                frame.push(0x80 | payload.len() as u8);
            } else {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
            }
            let mask = [1_u8, 2, 3, 4];
            frame.extend_from_slice(&mask);
            for (index, byte) in payload.iter().enumerate() {
                frame.push(byte ^ mask[index % mask.len()]);
            }
            self.stream.write_all(&frame).await.unwrap();
        }

        async fn read_text_frame(&mut self) -> String {
            loop {
                let mut header = [0_u8; 2];
                self.stream.read_exact(&mut header).await.unwrap();
                let opcode = header[0] & 0x0f;
                let masked = header[1] & 0x80 != 0;
                let mut len = usize::from(header[1] & 0x7f);
                if len == 126 {
                    let mut extended = [0_u8; 2];
                    self.stream.read_exact(&mut extended).await.unwrap();
                    len = u16::from_be_bytes(extended) as usize;
                } else if len == 127 {
                    let mut extended = [0_u8; 8];
                    self.stream.read_exact(&mut extended).await.unwrap();
                    len = u64::from_be_bytes(extended)
                        .try_into()
                        .expect("websocket frame length exceeds usize");
                }
                assert!(!masked, "server frames must be unmasked");
                let mut payload = vec![0_u8; len];
                self.stream.read_exact(&mut payload).await.unwrap();
                match opcode {
                    1 => return String::from_utf8(payload).unwrap(),
                    8 => panic!("expected text frame, received close frame: {payload:?}"),
                    9 | 10 => continue,
                    other => panic!("expected text frame, received opcode {other}: {payload:?}"),
                }
            }
        }
    }
}
