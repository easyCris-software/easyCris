import { buildSignalingUrl } from '@/services/remoteInvite'
import {
  createLanSignalingEncryption,
  type LanSignalingEncryption,
  parseSignalingMessage,
  sendSignalingMessage,
  type SignalingClientMessage,
  type SignalingServerMessage,
} from '@/services/remoteSignalingProtocol'

export interface RemoteSignalingTransport {
  connect(): Promise<void>
  send(message: SignalingClientMessage): Promise<void>
  close(): void
  getDiagnostics(): RemoteSignalingDiagnostics
  onOpen(callback: () => void): void
  onMessage(callback: (message: SignalingServerMessage) => void): void
  onError(callback: (error: Error) => void): void
  onClose(callback: () => void): void
}

export interface RemoteSignalingDiagnostics {
  webSocketState: 'CONNECTING' | 'OPEN' | 'CLOSING' | 'CLOSED' | null
  sentMessageCount: number
  receivedMessageCount: number
  lastSignalingError: string | null
  lastHeartbeatAckAtUnixMs: number | null
}

interface WebSocketSignalingTransportOptions {
  connectionErrorMessage: string
  encryption?: () => Promise<LanSignalingEncryption>
  heartbeatAckTimeoutMs?: number
  heartbeatIntervalMs?: number
  heartbeatMessage?: () => SignalingClientMessage
  url: string
}

interface SignalingTransportRuntimeOptions {
  heartbeatAckTimeoutMs?: number
  heartbeatIntervalMs?: number
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000
const DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS = 75_000

const createLazyLanSignalingEncryption = (sessionId: string, token: string) => {
  let encryption: Promise<LanSignalingEncryption> | null = null
  return () => {
    encryption ??= createLanSignalingEncryption({ sessionId, token }).catch(
      error => {
        encryption = null
        throw error
      }
    )
    return encryption
  }
}

class WebSocketSignalingTransport implements RemoteSignalingTransport {
  private socket: WebSocket | null = null
  private intentionallyClosed = false
  private openCallback: (() => void) | null = null
  private messageCallback: ((message: SignalingServerMessage) => void) | null =
    null
  private errorCallback: ((error: Error) => void) | null = null
  private closeCallback: (() => void) | null = null
  private sentMessageCount = 0
  private receivedMessageCount = 0
  private lastSignalingError: string | null = null
  private lastHeartbeatAckAtUnixMs: number | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private pendingHeartbeatSentAtUnixMs: number | null = null

  constructor(private readonly options: WebSocketSignalingTransportOptions) {}

  connect() {
    const socket = new WebSocket(this.options.url)
    this.socket = socket
    this.intentionallyClosed = false

    return new Promise<void>((resolve, reject) => {
      let settled = false
      socket.onopen = () => {
        this.openCallback?.()
        settled = true
        this.startHeartbeat()
        resolve()
      }
      socket.onerror = () => {
        const error = new Error(this.options.connectionErrorMessage)
        this.lastSignalingError = error.message
        this.errorCallback?.(error)
        if (!settled) {
          settled = true
          reject(error)
        }
      }
      socket.onmessage = event => {
        void parseSignalingMessage(event, this.options.encryption)
          .then(message => {
            this.receivedMessageCount += 1
            if (message.type === 'heartbeat_ack') {
              this.lastHeartbeatAckAtUnixMs = Date.now()
              this.pendingHeartbeatSentAtUnixMs = null
            }
            this.messageCallback?.(message)
          })
          .catch(error => {
            const normalized =
              error instanceof Error ? error : new Error(String(error))
            this.lastSignalingError = normalized.message
            this.errorCallback?.(normalized)
          })
      }
      socket.onclose = () => {
        this.stopHeartbeat()
        if (this.intentionallyClosed) return
        if (!settled) {
          const error = new Error(this.options.connectionErrorMessage)
          this.lastSignalingError = error.message
          settled = true
          reject(error)
        }
        this.closeCallback?.()
      }
      if (socket.readyState === WebSocket.OPEN) {
        queueMicrotask(() => {
          if (!settled) socket.onopen?.(new Event('open'))
        })
      }
    })
  }

  async send(message: SignalingClientMessage) {
    if (!this.socket) {
      throw new Error('Remote-session signaling socket is not open')
    }
    try {
      await sendSignalingMessage(this.socket, message, this.options.encryption)
      this.sentMessageCount += 1
    } catch (error) {
      this.lastSignalingError =
        error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  close() {
    this.stopHeartbeat()
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      this.intentionallyClosed = true
      this.socket.close()
    }
    this.socket = null
  }

  getDiagnostics(): RemoteSignalingDiagnostics {
    return {
      webSocketState: this.socketState(),
      sentMessageCount: this.sentMessageCount,
      receivedMessageCount: this.receivedMessageCount,
      lastSignalingError: this.lastSignalingError,
      lastHeartbeatAckAtUnixMs: this.lastHeartbeatAckAtUnixMs,
    }
  }

  private socketState(): RemoteSignalingDiagnostics['webSocketState'] {
    if (!this.socket) return null
    switch (this.socket.readyState) {
      case WebSocket.CONNECTING:
        return 'CONNECTING'
      case WebSocket.OPEN:
        return 'OPEN'
      case WebSocket.CLOSING:
        return 'CLOSING'
      case WebSocket.CLOSED:
        return 'CLOSED'
      default:
        return null
    }
  }

  private startHeartbeat() {
    if (!this.options.heartbeatMessage || this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      void this.tickHeartbeat()
    }, this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.pendingHeartbeatSentAtUnixMs = null
  }

  private async tickHeartbeat() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (
      this.pendingHeartbeatSentAtUnixMs !== null &&
      now - this.pendingHeartbeatSentAtUnixMs >=
        (this.options.heartbeatAckTimeoutMs ??
          DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS)
    ) {
      this.handleHeartbeatTimeout()
      return
    }
    try {
      await this.send(this.options.heartbeatMessage!())
      if (
        this.heartbeatTimer !== null &&
        this.pendingHeartbeatSentAtUnixMs === null
      ) {
        this.pendingHeartbeatSentAtUnixMs = now
      }
    } catch (error) {
      if (!this.heartbeatTimer) return
      if (this.pendingHeartbeatSentAtUnixMs === null) {
        this.pendingHeartbeatSentAtUnixMs = now
      }
      this.lastSignalingError =
        error instanceof Error ? error.message : String(error)
      this.errorCallback?.(
        error instanceof Error ? error : new Error(String(error))
      )
    }
  }

  private handleHeartbeatTimeout() {
    const error = new Error('Remote-session signaling heartbeat timed out')
    this.lastSignalingError = error.message
    this.errorCallback?.(error)
    this.stopHeartbeat()
    if (this.socket) {
      this.intentionallyClosed = true
      this.socket.close()
      this.socket = null
    }
  }

  onOpen(callback: () => void) {
    this.openCallback = callback
  }

  onMessage(callback: (message: SignalingServerMessage) => void) {
    this.messageCallback = callback
  }

  onError(callback: (error: Error) => void) {
    this.errorCallback = callback
  }

  onClose(callback: () => void) {
    this.closeCallback = callback
  }
}

export const createLanHostSignalingTransport = (
  signalingPort: number,
  sessionId: string,
  token: string,
  options: SignalingTransportRuntimeOptions = {}
) => {
  return new WebSocketSignalingTransport({
    connectionErrorMessage:
      'Could not connect to the local remote-session listener. Stop and start the remote session again.',
    encryption: createLazyLanSignalingEncryption(sessionId, token),
    heartbeatAckTimeoutMs: options.heartbeatAckTimeoutMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatMessage: () => ({ type: 'heartbeat', session_id: sessionId }),
    url: `ws://127.0.0.1:${signalingPort}/remote-session/${encodeURIComponent(sessionId)}`,
  })
}

export const createLanGuestSignalingTransport = (
  host: string,
  port: string,
  sessionId: string,
  connectionErrorMessage: string,
  token: string,
  options: SignalingTransportRuntimeOptions = {}
) => {
  return new WebSocketSignalingTransport({
    connectionErrorMessage,
    encryption: createLazyLanSignalingEncryption(sessionId, token),
    heartbeatAckTimeoutMs: options.heartbeatAckTimeoutMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatMessage: () => ({ type: 'heartbeat', session_id: sessionId }),
    url: buildSignalingUrl(host, port, sessionId),
  })
}

export const createCloudSignalingTransport = (
  relayUrl: string,
  inviteId: string,
  connectionErrorMessage: string,
  options: SignalingTransportRuntimeOptions = {}
) => {
  const url = new URL(relayUrl)
  url.searchParams.set('invite', inviteId)
  return new WebSocketSignalingTransport({
    connectionErrorMessage,
    heartbeatAckTimeoutMs: options.heartbeatAckTimeoutMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatMessage: () => ({ type: 'heartbeat', invite_id: inviteId }),
    url: url.toString(),
  })
}
