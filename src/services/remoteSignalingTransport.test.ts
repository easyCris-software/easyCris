import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCloudSignalingTransport,
  createLanHostSignalingTransport,
} from './remoteSignalingTransport'

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static latest: FakeWebSocket | null = null

  readyState = FakeWebSocket.OPEN
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []

  constructor(readonly url: string) {
    FakeWebSocket.latest = this
    queueMicrotask(() => this.onopen?.())
  }

  send(raw: string) {
    this.sent.push(raw)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    queueMicrotask(() => this.onclose?.())
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
}

class FakeCloseBeforeOpenWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static latest: FakeCloseBeforeOpenWebSocket | null = null

  readyState = FakeCloseBeforeOpenWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []

  constructor(readonly url: string) {
    FakeCloseBeforeOpenWebSocket.latest = this
    queueMicrotask(() => {
      this.readyState = FakeCloseBeforeOpenWebSocket.CLOSED
      this.onclose?.()
    })
  }

  send(raw: string) {
    this.sent.push(raw)
  }

  close() {
    this.readyState = FakeCloseBeforeOpenWebSocket.CLOSED
    queueMicrotask(() => this.onclose?.())
  }
}

describe('remote signaling transport encryption', () => {
  afterEach(() => {
    FakeWebSocket.latest = null
    FakeCloseBeforeOpenWebSocket.latest = null
    vi.unstubAllGlobals()
  })

  it('rejects connect when the socket closes before opening', async () => {
    vi.stubGlobal('WebSocket', FakeCloseBeforeOpenWebSocket)
    const transport = createCloudSignalingTransport(
      'wss://relay.easycris.test/v1/remote/signaling',
      'rmt_invite',
      'Could not reach relay'
    )

    const result = await Promise.race([
      transport.connect().then(
        () => 'resolved',
        error => (error instanceof Error ? error.message : String(error))
      ),
      new Promise(resolve => setTimeout(() => resolve('pending'), 25)),
    ])

    expect(result).toBe('Could not reach relay')
  })

  it('reports signaling diagnostics for socket state and message counts', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const transport = createCloudSignalingTransport(
      'wss://relay.easycris.test/v1/remote/signaling',
      'rmt_invite',
      'Could not reach relay'
    )

    await transport.connect()
    await transport.send({ type: 'heartbeat', invite_id: 'rmt_invite' })
    FakeWebSocket.latest?.onmessage?.({
      data: JSON.stringify({
        type: 'heartbeat_ack',
        invite_id: 'rmt_invite',
      }),
    } as MessageEvent)
    await vi.waitFor(() =>
      expect(transport.getDiagnostics().receivedMessageCount).toBe(1)
    )

    expect(transport.getDiagnostics()).toMatchObject({
      lastSignalingError: null,
      receivedMessageCount: 1,
      sentMessageCount: 1,
      webSocketState: 'OPEN',
    })
    expect(
      typeof transport.getDiagnostics().lastHeartbeatAckAtUnixMs
    ).toBe('number')
  })

  it('sends heartbeat messages periodically and stops after close', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const transport = createCloudSignalingTransport(
      'wss://relay.easycris.test/v1/remote/signaling',
      'rmt_invite',
      'Could not reach relay',
      { heartbeatAckTimeoutMs: 1000, heartbeatIntervalMs: 1000 }
    )

    await transport.connect()
    await vi.advanceTimersByTimeAsync(1000)

    expect(FakeWebSocket.latest?.sent.map(raw => JSON.parse(raw))).toContainEqual(
      { type: 'heartbeat', invite_id: 'rmt_invite' }
    )

    transport.close()
    const sentAfterClose = FakeWebSocket.latest?.sent.length
    await vi.advanceTimersByTimeAsync(3000)

    expect(FakeWebSocket.latest?.sent).toHaveLength(sentAfterClose ?? 0)
    vi.useRealTimers()
  })

  it('reports an error and closes when heartbeat acks are missed', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onError = vi.fn()
    const onClose = vi.fn()
    const transport = createCloudSignalingTransport(
      'wss://relay.easycris.test/v1/remote/signaling',
      'rmt_invite',
      'Could not reach relay',
      { heartbeatAckTimeoutMs: 1000, heartbeatIntervalMs: 1000 }
    )
    transport.onError(onError)
    transport.onClose(onClose)

    await transport.connect()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Remote-session signaling heartbeat timed out',
      })
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(transport.getDiagnostics()).toMatchObject({
      lastSignalingError: 'Remote-session signaling heartbeat timed out',
      webSocketState: null,
    })
    vi.useRealTimers()
  })

  it('does not reset heartbeat timeout while unanswered heartbeats keep sending', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onError = vi.fn()
    const transport = createCloudSignalingTransport(
      'wss://relay.easycris.test/v1/remote/signaling',
      'rmt_invite',
      'Could not reach relay',
      { heartbeatAckTimeoutMs: 3000, heartbeatIntervalMs: 1000 }
    )
    transport.onError(onError)

    await transport.connect()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Remote-session signaling heartbeat timed out',
      })
    )
    expect(transport.getDiagnostics()).toMatchObject({
      lastSignalingError: 'Remote-session signaling heartbeat timed out',
      webSocketState: null,
    })
    vi.useRealTimers()
  })

  it('does not extend heartbeat timeout when heartbeat send fails', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onError = vi.fn()
    const transport = createCloudSignalingTransport(
      'wss://relay.easycris.test/v1/remote/signaling',
      'rmt_invite',
      'Could not reach relay',
      { heartbeatAckTimeoutMs: 2000, heartbeatIntervalMs: 1000 }
    )
    transport.onError(onError)

    await transport.connect()
    const socket = FakeWebSocket.latest
    expect(socket).not.toBeNull()
    const send = vi.spyOn(socket as FakeWebSocket, 'send')
    await vi.advanceTimersByTimeAsync(1000)
    send.mockImplementation(() => {
      throw new Error('socket buffer exhausted')
    })
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'socket buffer exhausted' })
    )
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Remote-session signaling heartbeat timed out',
      })
    )
    expect(transport.getDiagnostics()).toMatchObject({
      lastSignalingError: 'Remote-session signaling heartbeat timed out',
      webSocketState: null,
    })
    vi.useRealTimers()
  })

  it('retries lazy LAN encryption setup after an initialization failure', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('crypto', {})
    const transport = createLanHostSignalingTransport(
      49152,
      'session-1',
      'invite-token'
    )

    await transport.connect()
    await expect(
      transport.send({
        type: 'video_offer',
        session_id: 'session-1',
        guest_device_id: 'guest-device',
        payload: { sdp: 'offer-sdp', type: 'offer' },
      })
    ).rejects.toThrow('WebCrypto is unavailable')

    vi.stubGlobal('crypto', webcrypto)

    await expect(
      transport.send({
        type: 'video_offer',
        session_id: 'session-1',
        guest_device_id: 'guest-device',
        payload: { sdp: 'offer-sdp', type: 'offer' },
      })
    ).resolves.toBeUndefined()

    const sentOffer = FakeWebSocket.latest?.sent
      .map(raw => JSON.parse(raw))
      .find(message => message.type === 'video_offer')
    expect(sentOffer?.payload).toMatchObject({
      encrypted: true,
      version: 'easycris-lan-signaling-v1',
    })
  })
})
