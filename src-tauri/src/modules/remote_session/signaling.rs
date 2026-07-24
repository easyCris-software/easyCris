use std::net::{IpAddr, SocketAddr, UdpSocket};

use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};

use super::state::RemoteSessionState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SignalingClientMessage {
    HostRegister {
        session_id: String,
    },
    JoinRequest {
        session_id: String,
        token: String,
        guest_display_name: String,
        guest_device_id: String,
    },
    VideoOffer {
        session_id: String,
        guest_device_id: String,
        payload: serde_json::Value,
    },
    VideoAnswer {
        session_id: String,
        guest_device_id: String,
        payload: serde_json::Value,
    },
    IceCandidate {
        session_id: String,
        guest_device_id: String,
        payload: serde_json::Value,
    },
    SessionRevoked {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Heartbeat {
        session_id: String,
    },
}

impl SignalingClientMessage {
    pub fn session_id(&self) -> &str {
        match self {
            SignalingClientMessage::HostRegister { session_id }
            | SignalingClientMessage::JoinRequest { session_id, .. }
            | SignalingClientMessage::VideoOffer { session_id, .. }
            | SignalingClientMessage::VideoAnswer { session_id, .. }
            | SignalingClientMessage::IceCandidate { session_id, .. }
            | SignalingClientMessage::SessionRevoked { session_id, .. }
            | SignalingClientMessage::Heartbeat { session_id } => session_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SignalingServerMessage {
    HostRegistered {
        session_id: String,
    },
    JoinPending {
        session_id: String,
        guest_device_id: String,
    },
    JoinApproved {
        session_id: String,
        guest_device_id: String,
        host_device_id: String,
    },
    JoinRejected {
        session_id: String,
        reason: String,
    },
    SignalAccepted {
        session_id: String,
    },
    VideoOffer {
        session_id: String,
        guest_device_id: String,
        payload: serde_json::Value,
    },
    VideoAnswer {
        session_id: String,
        guest_device_id: String,
        payload: serde_json::Value,
    },
    IceCandidate {
        session_id: String,
        guest_device_id: String,
        payload: serde_json::Value,
    },
    SessionRevoked {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    GuestDisconnected {
        session_id: String,
        guest_device_id: String,
    },
    HostDisconnected {
        session_id: String,
    },
    HeartbeatAck {
        session_id: String,
    },
    Error {
        reason: String,
    },
}

pub struct SignalingServerHandle {
    port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl std::fmt::Debug for SignalingServerHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignalingServerHandle")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

impl SignalingServerHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn shutdown(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.task.abort();
    }
}

impl Drop for SignalingServerHandle {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.task.abort();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignalingPeerRole {
    Host,
    Guest,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignalingPeerContext {
    pub session_id: String,
    pub connection_id: String,
    pub role: SignalingPeerRole,
    pub guest_device_id: Option<String>,
}

#[derive(Clone)]
pub struct SignalingPeerSender {
    inner: SignalingPeerSenderInner,
}

#[derive(Clone)]
enum SignalingPeerSenderInner {
    WebSocket(std::sync::Arc<Mutex<SplitSink<WebSocketStream<TcpStream>, Message>>>),
    #[cfg(test)]
    Memory(std::sync::Arc<Mutex<Vec<SignalingServerMessage>>>),
}

impl std::fmt::Debug for SignalingPeerSender {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignalingPeerSender")
            .finish_non_exhaustive()
    }
}

impl SignalingPeerSender {
    fn websocket(write: SplitSink<WebSocketStream<TcpStream>, Message>) -> Self {
        Self {
            inner: SignalingPeerSenderInner::WebSocket(std::sync::Arc::new(Mutex::new(write))),
        }
    }

    #[cfg(test)]
    pub fn memory() -> (Self, std::sync::Arc<Mutex<Vec<SignalingServerMessage>>>) {
        let messages = std::sync::Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                inner: SignalingPeerSenderInner::Memory(messages.clone()),
            },
            messages,
        )
    }

    pub async fn send(&self, message: &SignalingServerMessage) -> Result<(), String> {
        let payload = serde_json::to_string(message)
            .map_err(|error| format!("Failed to serialize signaling response: {error}"))?;
        match &self.inner {
            SignalingPeerSenderInner::WebSocket(write) => write
                .lock()
                .await
                .send(Message::Text(payload.into()))
                .await
                .map_err(|error| format!("Failed to send signaling response: {error}")),
            #[cfg(test)]
            SignalingPeerSenderInner::Memory(messages) => {
                messages.lock().await.push(message.clone());
                Ok(())
            }
        }
    }
}

pub async fn start_signaling_server(
    state: RemoteSessionState,
) -> Result<SignalingServerHandle, String> {
    let listener = TcpListener::bind(("0.0.0.0", 0))
        .await
        .map_err(|error| format!("Failed to bind remote-session signaling server: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Failed to read signaling listener address: {error}"))?
        .port();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    break;
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, peer_addr)) => {
                            let state = state.clone();
                            tokio::spawn(async move {
                                handle_connection(state, stream, peer_addr).await;
                            });
                        }
                        Err(error) => {
                            log::warn!("Remote-session signaling accept failed: {error}");
                            tokio::select! {
                                _ = &mut shutdown_rx => break,
                                _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
                            }
                        }
                    }
                }
            }
        }
    });

    Ok(SignalingServerHandle {
        port,
        shutdown: Some(shutdown_tx),
        task,
    })
}

pub fn local_ip_candidates(port: u16) -> Vec<String> {
    ordered_invite_candidates(port, local_lan_ip())
}

fn ordered_invite_candidates(port: u16, lan_ip: Option<IpAddr>) -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(ip) = lan_ip {
        candidates.push(format_invite_endpoint(ip, port));
    }
    candidates.push(format!("127.0.0.1:{port}"));
    candidates
}

fn format_invite_endpoint(ip: IpAddr, port: u16) -> String {
    match ip {
        IpAddr::V4(ip) => format!("{ip}:{port}"),
        IpAddr::V6(ip) => format!("[{ip}]:{port}"),
    }
}

async fn handle_connection(state: RemoteSessionState, stream: TcpStream, peer_addr: SocketAddr) {
    let socket = match tokio_tungstenite::accept_async(stream).await {
        Ok(socket) => socket,
        Err(error) => {
            log::warn!("Remote-session WebSocket handshake failed: {error}");
            return;
        }
    };
    let (write, mut read) = socket.split();
    let sender = SignalingPeerSender::websocket(write);
    let connection_id = uuid::Uuid::new_v4().to_string();
    let mut peer_context: Option<SignalingPeerContext> = None;

    while let Some(message) = read.next().await {
        let message = match message {
            Ok(message) => message,
            Err(error) => {
                log::warn!("Remote-session WebSocket read failed: {error}");
                break;
            }
        };

        if !message.is_text() {
            continue;
        }

        let response = match message.to_text() {
            Ok(text) => match serde_json::from_str::<SignalingClientMessage>(text) {
                Ok(client_message) => {
                    state
                        .handle_signaling_message(
                            peer_addr.ip(),
                            client_message,
                            connection_id.clone(),
                            peer_context.clone(),
                            sender.clone(),
                        )
                        .await
                }
                Err(error) => SignalingServerMessage::Error {
                    reason: format!("Invalid signaling message JSON: {error}"),
                },
            },
            Err(error) => SignalingServerMessage::Error {
                reason: format!("Invalid signaling text frame: {error}"),
            },
        };

        if matches!(response, SignalingServerMessage::SessionRevoked { .. }) {
            peer_context = None;
        } else if let Some(context) = response.peer_context(&connection_id) {
            peer_context = Some(context);
        }

        if sender.send(&response).await.is_err() {
            break;
        }
    }

    if let Some(context) = peer_context {
        state.unregister_signaling_peer(&context).await;
    }
}

fn local_lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    socket.connect(("8.8.8.8", 80)).ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() {
        None
    } else {
        Some(ip)
    }
}

impl SignalingServerMessage {
    pub fn peer_context(&self, connection_id: &str) -> Option<SignalingPeerContext> {
        match self {
            SignalingServerMessage::HostRegistered { session_id } => Some(SignalingPeerContext {
                session_id: session_id.clone(),
                connection_id: connection_id.to_string(),
                role: SignalingPeerRole::Host,
                guest_device_id: None,
            }),
            SignalingServerMessage::JoinPending {
                session_id,
                guest_device_id,
            } => Some(SignalingPeerContext {
                session_id: session_id.clone(),
                connection_id: connection_id.to_string(),
                role: SignalingPeerRole::Guest,
                guest_device_id: Some(guest_device_id.clone()),
            }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use super::{format_invite_endpoint, ordered_invite_candidates};

    #[test]
    fn invite_endpoint_formats_ipv4_with_embedded_port() {
        assert_eq!(
            format_invite_endpoint(Ipv4Addr::new(192, 168, 1, 5).into(), 49152),
            "192.168.1.5:49152"
        );
    }

    #[test]
    fn invite_endpoint_brackets_ipv6_with_embedded_port() {
        assert_eq!(
            format_invite_endpoint(Ipv6Addr::LOCALHOST.into(), 49152),
            "[::1]:49152"
        );
    }

    #[test]
    fn local_ip_candidates_keep_lan_endpoint_before_loopback() {
        assert_eq!(
            ordered_invite_candidates(49152, Some(Ipv4Addr::new(192, 168, 1, 5).into())),
            vec!["192.168.1.5:49152", "127.0.0.1:49152"]
        );
    }

    #[test]
    fn local_ip_candidates_fall_back_to_loopback_when_no_lan_ip() {
        assert_eq!(
            ordered_invite_candidates(49152, None),
            vec!["127.0.0.1:49152"]
        );
    }
}
