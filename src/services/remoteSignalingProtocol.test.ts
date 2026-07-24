import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  createLanSignalingEncryption,
  parseSignalingMessage,
  sendSignalingMessage,
  type SignalingClientMessage,
} from './remoteSignalingProtocol'

const createSocket = () => {
  const sent: string[] = []
  const socket = {
    readyState: 1,
    send: vi.fn((raw: string) => sent.push(raw)),
  } as unknown as WebSocket
  return { sent, socket }
}

describe('remote signaling protocol encryption', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const stubWebCrypto = () => {
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('WebSocket', { OPEN: 1 })
  }

  it('encrypts and decrypts LAN SDP payloads with a token-derived key', async () => {
    stubWebCrypto()
    const encryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'invite-token',
    })
    const { sent, socket } = createSocket()
    const message = {
      type: 'video_offer',
      session_id: 'session-1',
      guest_device_id: 'guest-device',
      payload: {
        sdp: 'secret-offer-sdp',
        type: 'offer',
      },
    } satisfies SignalingClientMessage

    await sendSignalingMessage(socket, message, encryption)

    const rawMessage = sent[0]
    expect(rawMessage).toBeDefined()
    const wireMessage = JSON.parse(rawMessage!)
    expect(wireMessage.payload).toMatchObject({
      encrypted: true,
      version: 'easycris-lan-signaling-v1',
    })
    expect(JSON.stringify(wireMessage.payload)).not.toContain(
      'secret-offer-sdp'
    )

    await expect(
      parseSignalingMessage({ data: rawMessage! } as MessageEvent, encryption)
    ).resolves.toEqual(message)
  })

  it('decrypts payloads from an independent encryption instance with the same token and session', async () => {
    stubWebCrypto()
    const senderEncryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'invite-token',
    })
    const receiverEncryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'invite-token',
    })
    const { sent, socket } = createSocket()
    const message = {
      type: 'video_answer',
      session_id: 'session-1',
      guest_device_id: 'guest-device',
      payload: {
        sdp: 'secret-answer-sdp',
        type: 'answer',
      },
    } satisfies SignalingClientMessage

    await sendSignalingMessage(socket, message, senderEncryption)

    await expect(
      parseSignalingMessage(
        { data: sent[0]! } as MessageEvent,
        receiverEncryption
      )
    ).resolves.toEqual(message)
  })

  it('keeps the LAN join request plaintext for bootstrap', async () => {
    stubWebCrypto()
    const encryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'invite-token',
    })
    const { sent, socket } = createSocket()

    await sendSignalingMessage(
      socket,
      {
        type: 'join_request',
        session_id: 'session-1',
        token: 'invite-token',
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      encryption
    )

    const rawMessage = sent[0]
    expect(rawMessage).toBeDefined()
    expect(JSON.parse(rawMessage!)).toMatchObject({
      type: 'join_request',
      token: 'invite-token',
    })
  })

  it('keeps cloud SDP payloads plaintext when no LAN encryption is configured', async () => {
    stubWebCrypto()
    const { sent, socket } = createSocket()

    await sendSignalingMessage(socket, {
      type: 'video_offer',
      invite_id: 'invite-1',
      guest_device_id: 'guest-device',
      payload: {
        sdp: 'cloud-offer-sdp',
        type: 'offer',
      },
    })

    expect(JSON.parse(sent[0]!)).toMatchObject({
      type: 'video_offer',
      invite_id: 'invite-1',
      payload: {
        sdp: 'cloud-offer-sdp',
        type: 'offer',
      },
    })
  })

  it('rejects plaintext LAN SDP payloads when encryption is configured', async () => {
    stubWebCrypto()
    const encryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'invite-token',
    })

    await expect(
      parseSignalingMessage(
        {
          data: JSON.stringify({
            type: 'video_offer',
            session_id: 'session-1',
            guest_device_id: 'guest-device',
            payload: {
              sdp: 'downgraded-offer-sdp',
              type: 'offer',
            },
          }),
        } as MessageEvent,
        encryption
      )
    ).rejects.toThrow('Remote-session signaling payload was not encrypted')
  })

  it('rejects plaintext payloads when decryptPayload is called directly', async () => {
    stubWebCrypto()
    const encryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'invite-token',
    })

    await expect(
      encryption.decryptPayload({
        sdp: 'downgraded-offer-sdp',
        type: 'offer',
      })
    ).rejects.toThrow('Remote-session signaling payload was not encrypted')
  })

  it('allows cloud SDP payloads through when a LAN encryption object is present', async () => {
    stubWebCrypto()
    const encryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'invite-token',
    })
    const message = {
      type: 'video_offer',
      invite_id: 'invite-1',
      guest_device_id: 'guest-device',
      payload: {
        sdp: 'cloud-offer-sdp',
        type: 'offer',
      },
    }

    await expect(
      parseSignalingMessage(
        { data: JSON.stringify(message) } as MessageEvent,
        encryption
      )
    ).resolves.toEqual(message)
  })

  it('rejects encrypted payloads when the invite token does not match', async () => {
    stubWebCrypto()
    const senderEncryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'invite-token',
    })
    const receiverEncryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'wrong-token',
    })
    const { sent, socket } = createSocket()

    await sendSignalingMessage(
      socket,
      {
        type: 'ice_candidate',
        session_id: 'session-1',
        guest_device_id: 'guest-device',
        payload: { candidate: 'candidate 1 1 udp 1 192.168.1.2 5000 typ host' },
      },
      senderEncryption
    )

    await expect(
      parseSignalingMessage(
        { data: sent[0]! } as MessageEvent,
        receiverEncryption
      )
    ).rejects.toThrow('Could not decrypt remote-session signaling payload')
  })

  it('rejects encrypted payloads when encryption cannot be resolved', async () => {
    stubWebCrypto()
    const senderEncryption = await createLanSignalingEncryption({
      sessionId: 'session-1',
      token: 'invite-token',
    })
    const { sent, socket } = createSocket()

    await sendSignalingMessage(
      socket,
      {
        type: 'video_offer',
        session_id: 'session-1',
        guest_device_id: 'guest-device',
        payload: { sdp: 'offer-sdp', type: 'offer' },
      },
      senderEncryption
    )

    await expect(
      parseSignalingMessage(
        { data: sent[0]! } as MessageEvent,
        async () => null as never
      )
    ).rejects.toThrow('Remote-session signaling encryption is unavailable')
  })

  it('rejects sends when the signaling socket is not open', async () => {
    stubWebCrypto()
    const socket = {
      readyState: 2,
      send: vi.fn(),
    } as unknown as WebSocket

    await expect(
      sendSignalingMessage(socket, {
        type: 'heartbeat',
        session_id: 'session-1',
      })
    ).rejects.toThrow('Remote-session signaling socket is not open')
  })
})
