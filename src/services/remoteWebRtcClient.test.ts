import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  RemoteWebRtcClientSession,
  remoteJoinRejectionMessage,
  sameWifiUnavailableMessage,
} from './remoteWebRtcClient'
import {
  createCloudSignalingTransport,
  createLanGuestSignalingTransport,
} from './remoteSignalingTransport'
import {
  createLanSignalingEncryption,
  REMOTE_INPUT_CHANNEL_LABEL,
} from './remoteSignalingProtocol'
import { useRemoteSessionStore } from '@/store/remote-session-store'

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static latest: FakeWebSocket | null = null

  readyState = FakeWebSocket.OPEN
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  url: string

  constructor(url: string) {
    this.url = url
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

  failConnect() {
    this.onopen = null
    this.onerror?.()
  }
}

describe('remoteWebRtcClient failure messages', () => {
  afterEach(() => {
    FakeWebSocket.latest = null
    useRemoteSessionStore.setState({ guestHostDeviceId: null, isGuest: false })
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('explains invalid invite tokens', () => {
    expect(remoteJoinRejectionMessage('Invalid remote-session token')).toBe(
      'Invite token is invalid or expired. Ask the host to copy a new invite.'
    )
  })

  it('explains expired invite tokens', () => {
    expect(remoteJoinRejectionMessage('Remote-session token has expired')).toBe(
      'Invite token is invalid or expired. Ask the host to copy a new invite.'
    )
  })

  it('explains second guest rejection', () => {
    expect(
      remoteJoinRejectionMessage(
        'A remote-session guest is already pending or approved'
      )
    ).toBe(
      'Another guest is already pending or connected. Ask the host to reject or revoke that session first.'
    )
  })

  it('uses same-Wi-Fi guidance for connection failures', () => {
    expect(sameWifiUnavailableMessage).toContain('same Wi-Fi')
    expect(sameWifiUnavailableMessage).toContain('Windows Firewall')
  })

  it('sends guest errors to the attached owner before subscribers', () => {
    const attachedError = vi.fn()
    const subscribedError = vi.fn()
    const subscribedStatus = vi.fn()
    const client = new RemoteWebRtcClientSession()
    client.attach({
      onStream: vi.fn(),
      onState: vi.fn(),
      onError: attachedError,
    })
    client.subscribe({
      onStream: vi.fn(),
      onState: vi.fn(),
      onError: subscribedError,
      onErrorStatus: subscribedStatus,
    })
    ;(client as unknown as { emitError: (message: string) => void }).emitError(
      'Remote failed'
    )

    expect(attachedError).toHaveBeenCalledTimes(1)
    expect(attachedError).toHaveBeenCalledWith('Remote failed')
    expect(subscribedStatus).toHaveBeenCalledTimes(1)
    expect(subscribedStatus).toHaveBeenCalledWith('Remote failed')
    expect(subscribedError).not.toHaveBeenCalled()

    client.detach()
    ;(client as unknown as { emitError: (message: string) => void }).emitError(
      'Remote failed again'
    )

    expect(subscribedStatus).toHaveBeenCalledTimes(1)
    expect(subscribedError).toHaveBeenCalledTimes(1)
    expect(subscribedError).toHaveBeenCalledWith('Remote failed again')
  })

  it('keeps revoked state when the signaling socket closes after host revoke', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: message => errors.push(message),
    })

    await client.join({
      host: '127.0.0.1',
      port: '49152',
      sessionId: 'session-1',
      token: 'invite-token',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    const socket = FakeWebSocket.latest
    expect(socket).not.toBeNull()
    socket?.receive({ type: 'session_revoked', session_id: 'session-1' })
    await Promise.resolve()
    await Promise.resolve()

    expect(states.at(-1)).toEqual([
      'revoked',
      'Host revoked the remote session.',
    ])
    expect(errors).toEqual([])

    socket?.receive({
      type: 'video_offer',
      session_id: 'session-1',
      guest_device_id: 'guest-device',
      payload: { sdp: 'stale-offer', type: 'offer' },
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(states.at(-1)).toEqual([
      'revoked',
      'Host revoked the remote session.',
    ])
    expect(errors).toEqual([])
  })

  it('reports a session-ended message when the host ends the active stream', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: vi.fn(),
    })

    await client.join({
      host: '127.0.0.1',
      port: '49152',
      sessionId: 'session-1',
      token: 'invite-token',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    FakeWebSocket.latest?.receive({
      type: 'session_revoked',
      session_id: 'session-1',
      reason: 'ended',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(states.at(-1)).toEqual(['revoked', 'Host ended the remote session.'])
  })

  it('reports guest peer connection failure only once while the state remains failed', async () => {
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const errors: string[] = []
    let latestPeer:
      | {
          fail: () => void
          onconnectionstatechange: (() => void) | null
          recover: () => void
        }
      | undefined
    class FakePeerConnection {
      connectionState: RTCPeerConnectionState = 'new'
      onconnectionstatechange: (() => void) | null = null
      ondatachannel: ((event: unknown) => void) | null = null
      onicecandidate: ((event: unknown) => void) | null = null
      ontrack: ((event: unknown) => void) | null = null

      constructor() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        latestPeer = this
      }

      addIceCandidate = vi.fn().mockResolvedValue(undefined)
      close = vi.fn()
      createAnswer = vi
        .fn()
        .mockResolvedValue({ sdp: 'answer-sdp', type: 'answer' })
      getTransceivers = vi.fn(() => [])
      setLocalDescription = vi.fn().mockResolvedValue(undefined)
      setRemoteDescription = vi.fn().mockResolvedValue(undefined)

      fail() {
        this.connectionState = 'failed'
        this.onconnectionstatechange?.()
      }

      recover() {
        this.connectionState = 'connected'
        this.onconnectionstatechange?.()
      }
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal(
      'MediaStream',
      class {
        addTrack = vi.fn()
        getTracks = vi.fn(() => [])
      }
    )

    const client = new RemoteWebRtcClientSession()
    client.attach({
      onStream: vi.fn(),
      onState: vi.fn(),
      onError: message => errors.push(message),
    })

    await client.join({
      host: '127.0.0.1',
      port: '49152',
      sessionId: 'session-1',
      token: 'invite-token',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    const encryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'invite-token',
    })
    FakeWebSocket.latest?.receive({
      type: 'video_offer',
      session_id: 'session-1',
      guest_device_id: 'guest-device',
      payload: await encryption.encryptPayload({
        sdp: 'v=0\r\na=fingerprint:sha-256 12:34:AB:CD:EF:90:00:11\r\n',
        type: 'offer',
      }),
    })
    await vi.waitFor(() => expect(latestPeer).toBeDefined())

    latestPeer?.fail()
    latestPeer?.fail()

    expect(errors).toEqual([
      'WebRTC connection failed. Stay on the same Wi-Fi and ask the host to approve the session again.',
    ])

    latestPeer?.recover()
    latestPeer?.fail()

    expect(errors).toEqual([
      'WebRTC connection failed. Stay on the same Wi-Fi and ask the host to approve the session again.',
      'WebRTC connection failed. Stay on the same Wi-Fi and ask the host to approve the session again.',
    ])
  })

  it('closes the guest session when the relay sends a terminal error', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: message => errors.push(message),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    const socket = FakeWebSocket.latest
    socket?.receive({
      type: 'error',
      invite_id: 'rmt_abc123',
      message: 'Guest not connected',
    })
    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual(['error', 'Guest not connected'])
    )

    expect(errors).toEqual(['Guest not connected'])
    expect(socket?.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('ignores an in-flight video offer after a terminal revoke', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let resolveFetch: (response: Pick<Response, 'ok' | 'json'>) => void = () =>
      undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise(resolve => {
            resolveFetch = resolve
          })
      )
    )
    const peerConnectionConstructor = vi.fn()
    function FakePeerConnection() {
      peerConnectionConstructor()
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)

    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: message => errors.push(message),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    const socket = FakeWebSocket.latest
    socket?.receive({
      type: 'video_offer',
      invite_id: 'rmt_abc123',
      guest_device_id: 'guest-device',
      payload: { sdp: 'offer', type: 'offer' },
    })
    await Promise.resolve()

    socket?.receive({
      type: 'session_revoked',
      invite_id: 'rmt_abc123',
      guest_device_id: 'guest-device',
    })
    await Promise.resolve()

    resolveFetch({
      ok: true,
      json: vi.fn().mockResolvedValue({ iceServers: [] }),
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(states.at(-1)).toEqual([
      'revoked',
      'Host revoked the remote session.',
    ])
    expect(errors).toEqual([])
    expect(peerConnectionConstructor).not.toHaveBeenCalled()
  })

  it('closes a peer connection abandoned by an in-flight video offer', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ iceServers: [] }),
      })
    )
    const offerState: {
      resolveRemoteDescription?: () => void
      latestPeer?: {
        close: ReturnType<typeof vi.fn>
        connectionState: RTCPeerConnectionState
      }
    } = {}
    class FakePeerConnection {
      connectionState: RTCPeerConnectionState = 'new'
      onconnectionstatechange: (() => void) | null = null
      ondatachannel: ((event: unknown) => void) | null = null
      onicecandidate: ((event: unknown) => void) | null = null
      ontrack: ((event: unknown) => void) | null = null
      addIceCandidate = vi.fn().mockResolvedValue(undefined)
      close = vi.fn(() => {
        this.connectionState = 'closed'
      })
      createAnswer = vi
        .fn()
        .mockResolvedValue({ sdp: 'answer-sdp', type: 'answer' })
      getTransceivers = vi.fn(() => [])
      setLocalDescription = vi.fn().mockResolvedValue(undefined)
      setRemoteDescription = vi.fn(
        () =>
          new Promise<void>(resolve => {
            offerState.resolveRemoteDescription = resolve
          })
      )

      constructor() {
        offerState.latestPeer = this
      }
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal(
      'MediaStream',
      class {
        addTrack = vi.fn()
        getTracks = vi.fn(() => [])
      }
    )

    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: vi.fn(),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    const socket = FakeWebSocket.latest
    socket?.receive({
      type: 'video_offer',
      invite_id: 'rmt_abc123',
      guest_device_id: 'guest-device',
      payload: { sdp: 'offer', type: 'offer' },
    })
    await vi.waitFor(() => expect(offerState.latestPeer).toBeDefined())

    socket?.receive({
      type: 'session_revoked',
      invite_id: 'rmt_abc123',
      guest_device_id: 'guest-device',
    })
    if (!offerState.resolveRemoteDescription || !offerState.latestPeer) {
      throw new Error('offer setup did not reach remote description')
    }
    offerState.resolveRemoteDescription()
    await Promise.resolve()
    await Promise.resolve()

    expect(offerState.latestPeer.close).toHaveBeenCalledTimes(1)
    expect(states.at(-1)).toEqual([
      'revoked',
      'Host revoked the remote session.',
    ])
  })

  it('keeps revoked state when peer teardown fires after host revoke', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ iceServers: [] }),
      })
    )
    const offerState: {
      latestPeer?: {
        close: ReturnType<typeof vi.fn>
        failAfterRevoke: () => void
      }
    } = {}
    class FakePeerConnection {
      connectionState: RTCPeerConnectionState = 'new'
      onconnectionstatechange: (() => void) | null = null
      ondatachannel: ((event: unknown) => void) | null = null
      onicecandidate: ((event: unknown) => void) | null = null
      ontrack: ((event: unknown) => void) | null = null
      remoteDescription: RTCSessionDescriptionInit | null = null
      addIceCandidate = vi.fn().mockResolvedValue(undefined)
      close = vi.fn(() => {
        this.connectionState = 'closed'
      })
      createAnswer = vi
        .fn()
        .mockResolvedValue({ sdp: 'answer-sdp', type: 'answer' })
      getTransceivers = vi.fn(() => [])
      setLocalDescription = vi.fn().mockResolvedValue(undefined)
      setRemoteDescription = vi.fn((description: RTCSessionDescriptionInit) => {
        this.remoteDescription = description
        return Promise.resolve()
      })

      constructor() {
        offerState.latestPeer = this
      }

      failAfterRevoke() {
        this.connectionState = 'failed'
        this.onconnectionstatechange?.()
      }
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal(
      'MediaStream',
      class {
        addTrack = vi.fn()
        getTracks = vi.fn(() => [])
      }
    )

    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []
    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => {
        states.push([state, message])
        if (state === 'revoked') {
          offerState.latestPeer?.failAfterRevoke()
        }
      },
      onError: message => errors.push(message),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    FakeWebSocket.latest?.receive({
      type: 'video_offer',
      invite_id: 'rmt_abc123',
      guest_device_id: 'guest-device',
      payload: { sdp: 'offer', type: 'offer' },
    })
    await vi.waitFor(() => expect(offerState.latestPeer).toBeDefined())

    FakeWebSocket.latest?.receive({
      type: 'session_revoked',
      invite_id: 'rmt_abc123',
      guest_device_id: 'guest-device',
    })
    await vi.waitFor(() => expect(states.at(-1)?.[0]).toBe('revoked'))
    await Promise.resolve()

    expect(states.at(-1)).toEqual([
      'revoked',
      'Host revoked the remote session.',
    ])
    expect(errors).toEqual([])
  })

  it('replays the remote audio stream when callbacks attach after audio arrives', () => {
    const client = new RemoteWebRtcClientSession() as unknown as {
      attach: (
        callbacks: Parameters<RemoteWebRtcClientSession['attach']>[0]
      ) => void
      remoteAudioStream: MediaStream | null
    }
    const stream = {} as MediaStream
    const onRemoteAudioStream = vi.fn()
    client.remoteAudioStream = stream

    client.attach({
      onStream: vi.fn(),
      onState: vi.fn(),
      onError: vi.fn(),
      onRemoteAudioStream,
    })

    expect(onRemoteAudioStream).toHaveBeenCalledWith(stream)
  })

  it('keeps subscribed guest viewer callbacks active after the preferences view detaches', () => {
    const client = new RemoteWebRtcClientSession() as unknown as {
      attach: (
        callbacks: Parameters<RemoteWebRtcClientSession['attach']>[0]
      ) => void
      detach: () => void
      subscribe: (
        callbacks: Parameters<RemoteWebRtcClientSession['attach']>[0]
      ) => () => void
      emitState: (state: string, message?: string) => void
      emitStream: (stream: MediaStream) => void
      securityCode: string | null
      callbacks: unknown
    }
    const setupState = vi.fn()
    const overlayState = vi.fn()
    const overlayStream = vi.fn()
    const stream = {} as MediaStream

    client.attach({
      onStream: vi.fn(),
      onState: setupState,
      onError: vi.fn(),
    })
    const unsubscribe = client.subscribe({
      onStream: overlayStream,
      onState: overlayState,
      onError: vi.fn(),
      onSecurityCode: vi.fn(),
    })

    client.detach()
    client.emitState('streaming')
    client.emitStream(stream)

    expect(setupState).not.toHaveBeenCalledWith('streaming', undefined)
    expect(overlayState).toHaveBeenCalledWith('streaming', undefined)
    expect(overlayStream).toHaveBeenCalledWith(stream)

    unsubscribe()
    overlayState.mockClear()
    client.emitState('revoked', 'done')

    expect(overlayState).not.toHaveBeenCalled()
  })

  it('ignores stale socket close after a join retry starts a new socket', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: vi.fn(),
    })

    await client.join({
      host: '127.0.0.1',
      port: '49152',
      sessionId: 'session-1',
      token: 'invite-token',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })
    const staleSocket = FakeWebSocket.latest

    await client.join({
      host: '127.0.0.1',
      port: '49152',
      sessionId: 'session-1',
      token: 'invite-token',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })
    staleSocket?.onclose?.()

    expect(states.at(-1)?.[0]).toBe('pending_approval')
  })

  it('does not report same-Wi-Fi failure after intentional disconnect', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: message => errors.push(message),
    })

    await client.join({
      host: '127.0.0.1',
      port: '49152',
      sessionId: 'session-1',
      token: 'invite-token',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    client.close()
    await Promise.resolve()

    expect(states.at(-1)?.[0]).toBe('idle')
    expect(errors).toEqual([])
  })

  it('clears guest mode when join fails during WebSocket connection', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: message => errors.push(message),
    })

    const joinPromise = client.join({
      host: '127.0.0.1',
      port: '49152',
      sessionId: 'session-1',
      token: 'invite-token',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    FakeWebSocket.latest?.failConnect()
    await expect(joinPromise).rejects.toThrow(sameWifiUnavailableMessage)
    await Promise.resolve()

    expect(states.at(-1)).toEqual(['error', sameWifiUnavailableMessage])
    expect(errors).toEqual([])
  })

  it('builds LAN and cloud signaling transport URLs', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)

    const lan = createLanGuestSignalingTransport(
      '127.0.0.1',
      '49152',
      'session-1',
      sameWifiUnavailableMessage,
      'invite-token'
    )
    await lan.connect()
    expect(FakeWebSocket.latest?.url).toBe(
      'ws://127.0.0.1:49152/remote-session/session-1'
    )
    lan.close()

    const cloud = createCloudSignalingTransport(
      'wss://remote.easycris.com/v1/remote/signaling',
      'rmt_abc',
      sameWifiUnavailableMessage
    )
    await cloud.connect()
    expect(FakeWebSocket.latest?.url).toBe(
      'wss://remote.easycris.com/v1/remote/signaling?invite=rmt_abc'
    )
  })

  it('reports WebSocket errors that happen after the transport opens', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const transport = createLanGuestSignalingTransport(
      '127.0.0.1',
      '49152',
      'session-1',
      sameWifiUnavailableMessage,
      'invite-token'
    )
    const errors: string[] = []
    transport.onError(error => errors.push(error.message))

    const connectPromise = transport.connect()
    await expect(connectPromise).resolves.toBeUndefined()
    FakeWebSocket.latest?.onerror?.()

    await expect(connectPromise).resolves.toBeUndefined()
    expect(errors).toEqual([sameWifiUnavailableMessage])
  })

  it('sends a cloud join request over the cloud signaling transport', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()

    client.attach({
      onStream: vi.fn(),
      onState: vi.fn(),
      onError: vi.fn(),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    expect(FakeWebSocket.latest?.url).toBe(
      'wss://remote.easycris.com/v1/remote/signaling?invite=rmt_abc123'
    )
    expect(
      FakeWebSocket.latest?.sent.map(value => JSON.parse(value))
    ).toContainEqual({
      type: 'join_request',
      invite_id: 'rmt_abc123',
      token: 'guest-secret',
      guest_display_name: 'Guest',
      guest_device_id: 'guest-device',
    })
  })

  it('uses cloud relay guidance when a cloud signaling socket closes unexpectedly', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: vi.fn(),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    FakeWebSocket.latest?.onclose?.()

    expect(states.at(-1)).toEqual([
      'error',
      'Lost connection to the cloud relay. Check your internet connection and ask the host for a new invite.',
    ])
  })

  it('keeps the streaming session when cloud signaling closes after video starts', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: message => errors.push(message),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })
    ;(
      client as unknown as {
        emitState: (state: string, message?: string) => void
        requireTransport: () => unknown
      }
    ).emitState('streaming')
    FakeWebSocket.latest?.onclose?.()

    expect(states.at(-1)).toEqual(['streaming', undefined])
    expect(errors).toEqual([])
    expect(
      (
        client as unknown as { requireTransport: () => unknown }
      ).requireTransport()
    ).toBeDefined()
  })

  it('keeps the control-ready session when cloud signaling closes after control starts', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: message => errors.push(message),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })
    ;(
      client as unknown as {
        emitState: (state: string, message?: string) => void
        requireTransport: () => unknown
      }
    ).emitState('control_ready')
    FakeWebSocket.latest?.onclose?.()

    expect(states.at(-1)).toEqual(['control_ready', undefined])
    expect(errors).toEqual([])
    expect(
      (
        client as unknown as { requireTransport: () => unknown }
      ).requireTransport()
    ).toBeDefined()
  })

  it('keeps signaling marked connected when cloud signaling errors after video starts', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: message => errors.push(message),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })
    ;(
      client as unknown as {
        emitState: (state: string, message?: string) => void
        requireTransport: () => unknown
      }
    ).emitState('streaming')
    FakeWebSocket.latest?.onerror?.()

    expect(states.at(-1)).toEqual(['streaming', undefined])
    expect(errors).toEqual([])
    expect(
      (
        client as unknown as { requireTransport: () => unknown }
      ).requireTransport()
    ).toBeDefined()
  })

  it('keeps visible video when cloud signaling errors after control becomes unavailable', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: message => errors.push(message),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })
    ;(
      client as unknown as {
        emitState: (state: string, message?: string) => void
        requireTransport: () => unknown
      }
    ).emitState('control_unavailable', 'Remote control channel closed.')
    FakeWebSocket.latest?.onerror?.()

    expect(states.at(-1)).toEqual([
      'control_unavailable',
      'Remote control channel closed.',
    ])
    expect(errors).toEqual([])
    expect(
      (
        client as unknown as { requireTransport: () => unknown }
      ).requireTransport()
    ).toBeDefined()
  })

  it('enters error state when the host disconnects', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: message => errors.push(message),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    FakeWebSocket.latest?.receive({
      type: 'host_disconnected',
      invite_id: 'rmt_abc123',
    })

    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual([
        'error',
        'Host disconnected from the remote session.',
      ])
    )
    await vi.waitFor(() =>
      expect(errors).toContain('Host disconnected from the remote session.')
    )
  })

  it('closes cloud signaling after join rejection', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: vi.fn(),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })
    const socket = FakeWebSocket.latest

    socket?.receive({
      type: 'join_rejected',
      invite_id: 'rmt_abc123',
      guest_device_id: 'guest-device',
      reason: 'Rejected',
    })

    await vi.waitFor(() => expect(states.at(-1)?.[0]).toBe('rejected'))
    expect(socket?.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('reports async signaling message failures instead of leaving the guest pending', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ iceServers: [] }),
      })
    )
    const close = vi.fn()
    class FakePeerConnection {
      onconnectionstatechange: (() => void) | null = null
      ondatachannel: ((event: unknown) => void) | null = null
      onicecandidate: ((event: unknown) => void) | null = null
      ontrack: ((event: unknown) => void) | null = null
      addIceCandidate = vi.fn().mockResolvedValue(undefined)
      addTransceiver = vi.fn()
      close = close
      createAnswer = vi
        .fn()
        .mockResolvedValue({ sdp: 'answer-sdp', type: 'answer' })
      setLocalDescription = vi.fn().mockResolvedValue(undefined)
      setRemoteDescription = vi
        .fn()
        .mockRejectedValue(new Error('Invalid offer'))
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal(
      'MediaStream',
      class {
        addTrack = vi.fn()
        getTracks = vi.fn(() => [])
      }
    )
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: message => errors.push(message),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    FakeWebSocket.latest?.receive({
      type: 'video_offer',
      invite_id: 'rmt_abc123',
      guest_device_id: 'guest-device',
      payload: { sdp: 'bad-offer', type: 'offer' },
    })

    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual(['error', 'Invalid offer'])
    )
    expect(errors).toContain('Invalid offer')
    expect(close).toHaveBeenCalled()
  })

  it('times out while waiting for host approval', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: message => errors.push(message),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    vi.advanceTimersByTime(60_000)
    await Promise.resolve()

    expect(states.at(-1)).toEqual([
      'error',
      'The host did not approve the remote session in time. Ask the host to try again.',
    ])
    expect(errors).toContain(
      'The host did not approve the remote session in time. Ask the host to try again.'
    )
    expect(FakeWebSocket.latest?.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('times out while waiting for the host video offer after approval', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new RemoteWebRtcClientSession()
    const states: [string, string | undefined][] = []
    const errors: string[] = []

    client.attach({
      onStream: vi.fn(),
      onState: (state, message) => states.push([state, message]),
      onError: message => errors.push(message),
    })

    await client.join({
      mode: 'cloud',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      token: 'guest-secret',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })
    FakeWebSocket.latest?.receive({
      type: 'join_approved',
      invite_id: 'rmt_abc123',
      guest_device_id: 'guest-device',
      host_device_id: 'host-device',
    })
    await vi.waitFor(() => expect(states.at(-1)?.[0]).toBe('approved'))
    expect(useRemoteSessionStore.getState().guestHostDeviceId).toBe(
      'host-device'
    )

    vi.advanceTimersByTime(30_001)
    await Promise.resolve()

    expect(states.at(-1)).toEqual([
      'error',
      'The host did not start the remote video in time. Ask the host to try again.',
    ])
    expect(errors).toContain(
      'The host did not start the remote video in time. Ask the host to try again.'
    )
    expect(FakeWebSocket.latest?.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('reports the host DTLS security code before accepting an offer', async () => {
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onSecurityCode = vi.fn()
    const audioSender = { replaceTrack: vi.fn(), track: null }
    const audioTransceiver = {
      direction: 'sendrecv',
      receiver: { track: { kind: 'audio', readyState: 'live' } },
      sender: audioSender,
    }
    const addTransceiver = vi.fn()
    const getTransceivers = vi.fn(() => [audioTransceiver])
    class FakePeerConnection {
      onconnectionstatechange: (() => void) | null = null
      ondatachannel: ((event: unknown) => void) | null = null
      onicecandidate: ((event: unknown) => void) | null = null
      ontrack: ((event: unknown) => void) | null = null
      addTransceiver = addTransceiver
      addIceCandidate = vi.fn().mockResolvedValue(undefined)
      close = vi.fn()
      createAnswer = vi
        .fn()
        .mockResolvedValue({ sdp: 'answer-sdp', type: 'answer' })
      getTransceivers = getTransceivers
      setLocalDescription = vi.fn().mockResolvedValue(undefined)
      setRemoteDescription = vi.fn().mockResolvedValue(undefined)
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal(
      'MediaStream',
      class {
        addTrack = vi.fn()
        getTracks = vi.fn(() => [])
      }
    )

    const client = new RemoteWebRtcClientSession()
    client.attach({
      onStream: vi.fn(),
      onState: vi.fn(),
      onError: vi.fn(),
      onSecurityCode,
    })

    await client.join({
      host: '127.0.0.1',
      port: '49152',
      sessionId: 'session-1',
      token: 'invite-token',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    const encryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'invite-token',
    })
    FakeWebSocket.latest?.receive({
      type: 'video_offer',
      session_id: 'session-1',
      guest_device_id: 'guest-device',
      payload: await encryption.encryptPayload({
        sdp: 'v=0\r\na=fingerprint:sha-256 12:34:AB:CD:EF:90:00:11\r\n',
        type: 'offer',
      }),
    })
    await vi.waitFor(() =>
      expect(onSecurityCode).toHaveBeenCalledWith('1234-ABCD-EF90')
    )
    expect(getTransceivers).toHaveBeenCalled()
    expect(addTransceiver).not.toHaveBeenCalled()
  })

  it('uses the offered sendrecv transceiver for guest audio when receiver track is not ready yet', async () => {
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const videoSender = { replaceTrack: vi.fn(), track: { kind: 'video' } }
    const videoTransceiver = {
      direction: 'sendonly',
      receiver: { track: { kind: 'video' } },
      sender: videoSender,
    }
    const audioSender = { replaceTrack: vi.fn(), track: null }
    const audioTransceiver = {
      direction: 'recvonly',
      receiver: { track: null },
      sender: audioSender,
    }
    const getTransceivers = vi.fn(() => [videoTransceiver, audioTransceiver])
    class FakePeerConnection {
      onconnectionstatechange: (() => void) | null = null
      ondatachannel: ((event: unknown) => void) | null = null
      onicecandidate: ((event: unknown) => void) | null = null
      ontrack: ((event: unknown) => void) | null = null
      addIceCandidate = vi.fn().mockResolvedValue(undefined)
      close = vi.fn()
      createAnswer = vi
        .fn()
        .mockResolvedValue({ sdp: 'answer-sdp', type: 'answer' })
      getTransceivers = getTransceivers
      setLocalDescription = vi.fn().mockResolvedValue(undefined)
      setRemoteDescription = vi.fn().mockResolvedValue(undefined)
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal(
      'MediaStream',
      class {
        addTrack = vi.fn()
        getTracks = vi.fn(() => [])
      }
    )

    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: unknown
      join: RemoteWebRtcClientSession['join']
    }
    await client.join({
      host: '127.0.0.1',
      port: '49152',
      sessionId: 'session-1',
      token: 'invite-token',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    const encryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'invite-token',
    })
    FakeWebSocket.latest?.receive({
      type: 'video_offer',
      session_id: 'session-1',
      guest_device_id: 'guest-device',
      payload: await encryption.encryptPayload({
        sdp: 'v=0\r\na=fingerprint:sha-256 12:34:AB:CD:EF:90:00:11\r\n',
        type: 'offer',
      }),
    })

    await vi.waitFor(() => expect(getTransceivers).toHaveBeenCalled())
    expect(client.audioSender).toBe(audioSender)
    expect(audioTransceiver.direction).toBe('sendrecv')
    expect(videoTransceiver.direction).toBe('sendonly')
  })

  it('does not enter streaming state for an audio-only track event before video arrives', async () => {
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: string[] = []
    const audioSender = { replaceTrack: vi.fn(), track: null }
    const audioTransceiver = {
      direction: 'sendrecv',
      receiver: { track: { kind: 'audio', readyState: 'live' } },
      sender: audioSender,
    }
    let dispatchTrack: ((event: RTCTrackEvent) => void) | undefined
    let dispatchDataChannel:
      | ((event: { channel: RTCDataChannel }) => void)
      | undefined
    class FakePeerConnection {
      onconnectionstatechange: (() => void) | null = null
      ondatachannel: ((event: unknown) => void) | null = null
      onicecandidate: ((event: unknown) => void) | null = null
      ontrack: ((event: RTCTrackEvent) => void) | null = null

      constructor() {
        dispatchTrack = event => this.ontrack?.(event)
        dispatchDataChannel = event => this.ondatachannel?.(event)
      }

      addIceCandidate = vi.fn().mockResolvedValue(undefined)
      close = vi.fn()
      createAnswer = vi
        .fn()
        .mockResolvedValue({ sdp: 'answer-sdp', type: 'answer' })
      getTransceivers = vi.fn(() => [audioTransceiver])
      setLocalDescription = vi.fn().mockResolvedValue(undefined)
      setRemoteDescription = vi.fn().mockResolvedValue(undefined)
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal(
      'MediaStream',
      class {
        private tracks: unknown[] = []
        constructor(tracks: unknown[] = []) {
          this.tracks = tracks
        }
        addTrack = vi.fn((track: unknown) => {
          this.tracks.push(track)
        })
        getTracks = vi.fn(() => this.tracks)
        getAudioTracks = vi.fn(() =>
          this.tracks.filter(
            track => (track as { kind?: string }).kind === 'audio'
          )
        )
        getVideoTracks = vi.fn(() =>
          this.tracks.filter(
            track => (track as { kind?: string }).kind === 'video'
          )
        )
      }
    )

    const client = new RemoteWebRtcClientSession()
    client.attach({
      onStream: vi.fn(),
      onState: state => states.push(state),
      onError: vi.fn(),
    })

    await client.join({
      host: '127.0.0.1',
      port: '49152',
      sessionId: 'session-1',
      token: 'invite-token',
      identity: {
        displayName: 'Guest',
        deviceId: 'guest-device',
      },
    })

    const encryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'invite-token',
    })
    FakeWebSocket.latest?.receive({
      type: 'video_offer',
      session_id: 'session-1',
      guest_device_id: 'guest-device',
      payload: await encryption.encryptPayload({
        sdp: 'v=0\r\na=fingerprint:sha-256 12:34:AB:CD:EF:90:00:11\r\n',
        type: 'offer',
      }),
    })
    await vi.waitFor(() => expect(dispatchTrack).toBeDefined())
    const dispatch = dispatchTrack
    if (!dispatch) {
      throw new Error('expected fake track dispatcher')
    }

    dispatch({
      streams: [],
      track: { kind: 'audio' },
    } as unknown as RTCTrackEvent)
    expect(states).not.toContain('streaming')

    dispatch({
      streams: [],
      track: { kind: 'video' },
    } as unknown as RTCTrackEvent)
    expect(states).toContain('streaming')
    expect(states.at(-1)).toBe('streaming')

    const channel = {
      label: REMOTE_INPUT_CHANNEL_LABEL,
      readyState: 'open',
      close: vi.fn(),
      send: vi.fn(),
      onclose: null,
      onmessage: null,
      onopen: null,
    } as unknown as RTCDataChannel
    const statesBeforeChannel = states.length
    dispatchDataChannel?.({ channel })
    expect(states.at(-1)).toBe('control_ready')
    expect(states.slice(statesBeforeChannel)).toEqual(['control_ready'])
    channel.onopen?.({} as Event)
    expect(states.slice(statesBeforeChannel)).toEqual(['control_ready'])
    ;(channel as unknown as { readyState: string }).readyState = 'closed'
    channel.onclose?.({} as Event)
    expect(states.at(-1)).toBe('control_unavailable')
    expect(() =>
      client.sendInputMessage({
        type: 'audio_state',
        seq: 1,
        sending: false,
        receiving: false,
        muted: true,
      })
    ).toThrow('Remote-session control channel is not open')

    const delayedChannel = {
      label: REMOTE_INPUT_CHANNEL_LABEL,
      readyState: 'connecting',
      close: vi.fn(),
      send: vi.fn(),
      onclose: null,
      onmessage: null,
      onopen: null,
    } as unknown as RTCDataChannel
    const statesBeforeDelayedChannel = states.length
    dispatchDataChannel?.({ channel: delayedChannel })
    delayedChannel.onopen?.({} as Event)
    expect(states.slice(statesBeforeDelayedChannel)).toEqual(['control_ready'])
    delayedChannel.onopen?.({} as Event)
    expect(states.slice(statesBeforeDelayedChannel)).toEqual(['control_ready'])
  })

  it('attaches and detaches guest microphone tracks in sender-safe order', async () => {
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(audioStream)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
      },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      enableAudio: () => Promise<void>
      disableAudio: () => Promise<void>
      setAudioMuted: (muted: boolean) => void
    }
    client.audioSender = { replaceTrack }

    await client.enableAudio()
    client.setAudioMuted(true)
    await client.disableAudio()

    expect(replaceTrack).toHaveBeenNthCalledWith(1, audioTrack)
    expect(audioTrack.enabled).toBe(false)
    expect(replaceTrack).toHaveBeenNthCalledWith(2, null)
    const replaceNullCallOrder =
      replaceTrack.mock.invocationCallOrder.at(1) ?? Number.NaN
    const stopCallOrder = stop.mock.invocationCallOrder.at(0) ?? Number.NaN
    expect(Number.isNaN(replaceNullCallOrder)).toBe(false)
    expect(Number.isNaN(stopCallOrder)).toBe(false)
    expect(replaceNullCallOrder).toBeLessThan(stopCallOrder)
  })

  it('stops guest microphone tracks even when detach rejects', async () => {
    const replaceTrack = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DOMException('', 'InvalidStateError'))
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(audioStream),
      },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      audioMuted: boolean
      localAudioStream: MediaStream | null
      enableAudio: () => Promise<void>
      disableAudio: () => Promise<void>
    }
    client.audioSender = { replaceTrack }

    await client.enableAudio()
    await expect(client.disableAudio()).resolves.toBeUndefined()

    expect(replaceTrack).toHaveBeenNthCalledWith(2, null)
    expect(stop).toHaveBeenCalledOnce()
    expect(client.localAudioStream).toBeNull()
    expect(client.audioMuted).toBe(true)
  })

  it('warns but still cleans up guest microphone tracks when detach fails unexpectedly', async () => {
    const replaceTrack = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DOMException('', 'OperationError'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(audioStream),
      },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      enableAudio: () => Promise<void>
      disableAudio: () => Promise<void>
      localAudioStream: MediaStream | null
    }
    client.audioSender = { replaceTrack }

    await client.enableAudio()
    await expect(client.disableAudio()).resolves.toBeUndefined()

    expect(stop).toHaveBeenCalledOnce()
    expect(client.localAudioStream).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      '[remote] Failed to detach guest audio sender',
      expect.any(DOMException)
    )
  })

  it('stops a guest microphone stream if audio is disabled while enable is pending', async () => {
    let resolveGetUserMedia:
      | ((stream: MediaStream | PromiseLike<MediaStream>) => void)
      | undefined
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>(resolve => {
              resolveGetUserMedia = resolve
            })
        ),
      },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      localAudioStream: MediaStream | null
      enableAudio: () => Promise<void>
      disableAudio: () => Promise<void>
    }
    client.audioSender = { replaceTrack }

    const enableTask = client.enableAudio()
    await client.disableAudio()
    resolveGetUserMedia?.(audioStream)

    await expect(enableTask).rejects.toThrow(
      'Remote-session audio sender is not active'
    )
    expect(replaceTrack).toHaveBeenCalledOnce()
    expect(replaceTrack).toHaveBeenCalledWith(null)
    expect(stop).toHaveBeenCalledOnce()
    expect(client.localAudioStream).toBeNull()
  })

  it('preserves a guest mute requested while microphone enable is pending', async () => {
    let resolveGetUserMedia:
      | ((stream: MediaStream | PromiseLike<MediaStream>) => void)
      | undefined
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>(resolve => {
              resolveGetUserMedia = resolve
            })
        ),
      },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      audioMuted: boolean
      enableAudio: () => Promise<void>
      setAudioMuted: (muted: boolean) => void
    }
    client.audioSender = { replaceTrack }

    const enableTask = client.enableAudio()
    client.setAudioMuted(true)
    resolveGetUserMedia?.(audioStream)
    await enableTask

    expect(client.audioMuted).toBe(true)
    expect(audioTrack.enabled).toBe(false)
  })

  it('stops a new guest microphone stream if attaching it to the sender fails', async () => {
    const replaceTrack = vi.fn().mockRejectedValue(new Error('replace failed'))
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(audioStream)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
      },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      enableAudio: () => Promise<void>
      localAudioStream: MediaStream | null
    }
    client.audioSender = { replaceTrack }

    await expect(client.enableAudio()).rejects.toThrow('replace failed')

    expect(stop).toHaveBeenCalledOnce()
    expect(client.localAudioStream).toBeNull()
  })

  it('stops a new guest microphone stream if the sender is cleared after permission', async () => {
    let resolveGetUserMedia:
      | ((stream: MediaStream | PromiseLike<MediaStream>) => void)
      | undefined
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>(resolve => {
              resolveGetUserMedia = resolve
            })
        ),
      },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      close: () => void
      enableAudio: () => Promise<void>
      localAudioStream: MediaStream | null
    }
    client.audioSender = { replaceTrack }

    const enableTask = client.enableAudio()
    await Promise.resolve()
    client.close()
    resolveGetUserMedia?.(audioStream)

    await expect(enableTask).rejects.toThrow(
      'Remote-session audio sender is not active'
    )
    expect(replaceTrack).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
    expect(client.localAudioStream).toBeNull()
  })

  it('stops a new guest microphone stream if the sender is cleared while attaching', async () => {
    let resolveReplace: (() => void) | undefined
    const replaceTrack = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveReplace = resolve
        })
    )
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(audioStream)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
      },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      close: () => void
      enableAudio: () => Promise<void>
      localAudioStream: MediaStream | null
    }
    client.audioSender = { replaceTrack }

    const enableTask = client.enableAudio()
    await vi.waitFor(() =>
      expect(replaceTrack).toHaveBeenCalledWith(audioTrack)
    )
    client.close()
    resolveReplace?.()

    await expect(enableTask).rejects.toThrow(
      'Remote-session audio sender is not active'
    )
    expect(replaceTrack).toHaveBeenNthCalledWith(2, null)
    expect(stop).toHaveBeenCalledOnce()
    expect(client.localAudioStream).toBeNull()
  })

  it('deduplicates concurrent guest microphone enable requests', async () => {
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(audioStream)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
      },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      enableAudio: () => Promise<void>
      localAudioStream: MediaStream | null
    }
    client.audioSender = { replaceTrack }

    await Promise.all([client.enableAudio(), client.enableAudio()])

    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(replaceTrack).toHaveBeenCalledOnce()
    expect(client.localAudioStream).toBe(audioStream)
  })

  it('exposes guest audio diagnostics for sender, tracks, and pending state', () => {
    const audioTrack = {
      enabled: false,
      kind: 'audio',
      readyState: 'live',
    } as unknown as MediaStreamTrack
    const remoteTrack = {
      kind: 'audio',
      readyState: 'live',
    } as unknown as MediaStreamTrack
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { track: MediaStreamTrack | null } | null
      audioStateSeq: number
      getAudioDiagnostics: () => Record<string, unknown>
      localAudioStream: MediaStream | null
      pendingAudioState: Record<string, unknown> | null
      pendingAudioStateRetryTimer: number | null
      remoteAudioStream: MediaStream | null
    }
    client.audioSender = { track: audioTrack }
    client.audioStateSeq = 4
    client.localAudioStream = {
      getAudioTracks: () => [audioTrack],
    } as unknown as MediaStream
    client.remoteAudioStream = {
      getAudioTracks: () => [remoteTrack],
    } as unknown as MediaStream
    client.pendingAudioState = {
      type: 'audio_state',
      seq: 4,
      sending: false,
      receiving: true,
      muted: true,
    }
    client.pendingAudioStateRetryTimer = 123

    expect(client.getAudioDiagnostics()).toMatchObject({
      audioSenderCreated: true,
      audioSenderTrackAttached: true,
      localAudioTrackLive: true,
      localAudioTrackEnabled: false,
      localAudioTrackReadyState: 'live',
      pendingAudioStateSeq: 4,
      pendingAudioStateRetryScheduled: true,
      remoteAudioTrackReadyState: 'live',
      nextAudioStateSeq: 5,
    })
  })

  it('sends guest audio state over the control channel when microphone state changes', async () => {
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const send = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(audioStream),
      },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      dataChannel: { readyState: string; send: typeof send } | null
      enableAudio: () => Promise<void>
      disableAudio: () => Promise<void>
      setAudioMuted: (muted: boolean) => void
    }
    client.audioSender = { replaceTrack }
    client.dataChannel = { readyState: 'open', send }

    await client.enableAudio()
    client.setAudioMuted(true)
    await client.disableAudio()

    expect(send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        type: 'audio_state',
        seq: 1,
        sending: true,
        receiving: false,
        muted: false,
      })
    )
    expect(send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        type: 'audio_state',
        seq: 2,
        sending: false,
        receiving: false,
        muted: true,
      })
    )
    expect(send).toHaveBeenNthCalledWith(
      3,
      JSON.stringify({
        type: 'audio_state',
        seq: 3,
        sending: false,
        receiving: false,
        muted: true,
      })
    )
  })

  it('retries pending guest audio state when data-channel send throws', () => {
    vi.useFakeTimers()
    const message = {
      type: 'audio_state',
      seq: 1,
      sending: false,
      receiving: false,
      muted: true,
    }
    const send = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('sctp backpressure')
      })
      .mockImplementationOnce(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const client = new RemoteWebRtcClientSession() as unknown as {
      dataChannel: { readyState: string; send: typeof send } | null
      flushPendingAudioState: () => void
      pendingAudioState: typeof message | null
    }
    client.dataChannel = { readyState: 'open', send }
    client.pendingAudioState = message

    try {
      client.flushPendingAudioState()
      expect(client.pendingAudioState).toBe(message)
      expect(warn).toHaveBeenCalledWith(
        '[remote] audio_state send failed; will retry',
        expect.any(Error)
      )

      vi.advanceTimersByTime(250)
      expect(send).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenNthCalledWith(2, JSON.stringify(message))
      expect(client.pendingAudioState).toBeNull()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('starts guest microphone audio and sends only audio state', async () => {
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const send = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(audioStream),
      },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      dataChannel: { readyState: string; send: typeof send } | null
      enableAudio: () => Promise<void>
    }
    client.audioSender = { replaceTrack }
    client.dataChannel = { readyState: 'open', send }

    await client.enableAudio()

    expect(replaceTrack).toHaveBeenCalledWith(audioTrack)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'audio_state',
        seq: 1,
        sending: true,
        receiving: false,
        muted: false,
      })
    )
  })

  it('deduplicates concurrent guest microphone enables', async () => {
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const send = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(audioStream)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
      },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      dataChannel: { readyState: string; send: typeof send } | null
      enableAudio: () => Promise<void>
    }
    client.audioSender = { replaceTrack }
    client.dataChannel = { readyState: 'open', send }

    const firstEnable = client.enableAudio()
    const secondEnable = client.enableAudio()
    await Promise.all([firstEnable, secondEnable])

    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'audio_state',
        seq: 1,
        sending: true,
        receiving: false,
        muted: false,
      })
    )
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(replaceTrack).toHaveBeenCalledTimes(1)
  })

  it('keeps guest audio unmuted when switching microphones while active', async () => {
    const firstTrack = {
      enabled: true,
      kind: 'audio',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const secondTrack = {
      enabled: true,
      kind: 'audio',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const currentStream = {
      getAudioTracks: () => [firstTrack],
      getTracks: () => [firstTrack],
    } as unknown as MediaStream
    const replacementStream = {
      getAudioTracks: () => [secondTrack],
      getTracks: () => [secondTrack],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(replacementStream)
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const send = vi.fn()
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioMuted: boolean
      audioSender: { replaceTrack: typeof replaceTrack } | null
      dataChannel: { readyState: string; send: typeof send } | null
      localAudioStream: MediaStream | null
      setAudioInputDevice: (deviceId: string | null) => Promise<void>
    }
    client.audioMuted = false
    client.audioSender = { replaceTrack }
    client.dataChannel = { readyState: 'open', send }
    client.localAudioStream = currentStream

    await client.setAudioInputDevice('mic-2')

    expect(replaceTrack).toHaveBeenCalledWith(secondTrack)
    expect(secondTrack.enabled).toBe(true)
    expect(send).toHaveBeenCalledWith(expect.stringContaining('"sending":true'))
  })

  it('can start guest microphone audio before audio state can be sent', async () => {
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(audioStream)
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
      },
    })
    const client = new RemoteWebRtcClientSession() as unknown as {
      audioSender: { replaceTrack: () => Promise<void> } | null
      enableAudio: () => Promise<void>
      pendingAudioState: Record<string, unknown> | null
    }
    client.audioSender = { replaceTrack }

    await client.enableAudio()

    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(replaceTrack).toHaveBeenCalledWith(audioTrack)
    expect(client.pendingAudioState).toMatchObject({
      type: 'audio_state',
      sending: true,
      muted: false,
    })
  })
})
