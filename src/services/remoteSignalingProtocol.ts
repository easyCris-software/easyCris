export const REMOTE_INPUT_CHANNEL_LABEL = 'easycris-remote-input'
const LAN_SIGNALING_ENCRYPTION_VERSION = 'easycris-lan-signaling-v1'
const AES_GCM_IV_BYTES = 12

export type RemoteSessionRevokedReason = 'revoked' | 'ended'

interface EncryptedSignalingPayload {
  ciphertext: string
  encrypted: true
  iv: string
  version: typeof LAN_SIGNALING_ENCRYPTION_VERSION
}

export interface LanSignalingEncryption {
  decryptPayload<T>(payload: unknown): Promise<T>
  encryptPayload(payload: unknown): Promise<EncryptedSignalingPayload>
}

type LanSignalingEncryptionSource =
  | LanSignalingEncryption
  | (() => Promise<LanSignalingEncryption>)
  | undefined

type LanPayloadClientMessage = Extract<
  LanSignalingClientMessage,
  { type: 'video_offer' | 'video_answer' | 'ice_candidate' }
>

type LanPayloadServerMessage = Extract<
  LanSignalingServerMessage,
  { type: 'video_offer' | 'video_answer' | 'ice_candidate' }
>

export type LanSignalingClientMessage =
  | { type: 'host_register'; session_id: string }
  | {
      type: 'join_request'
      session_id: string
      token: string
      guest_display_name: string
      guest_device_id: string
    }
  | {
      type: 'video_offer'
      session_id: string
      guest_device_id: string
      payload: RTCSessionDescriptionInit
    }
  | {
      type: 'video_answer'
      session_id: string
      guest_device_id: string
      payload: RTCSessionDescriptionInit
    }
  | {
      type: 'ice_candidate'
      session_id: string
      guest_device_id: string
      payload: RTCIceCandidateInit
    }
  | {
      type: 'session_revoked'
      session_id: string
      reason?: RemoteSessionRevokedReason
    }
  | { type: 'heartbeat'; session_id: string }

export type CloudSignalingClientMessage =
  | { type: 'host_register'; invite_id: string; host_secret: string }
  | {
      type: 'join_request'
      invite_id: string
      token: string
      guest_display_name: string
      guest_device_id: string
    }
  | {
      type: 'join_approved'
      invite_id: string
      guest_device_id: string
    }
  | {
      type: 'join_rejected'
      invite_id: string
      guest_device_id: string
      reason: string
    }
  | {
      type: 'video_offer'
      invite_id: string
      guest_device_id: string
      payload: RTCSessionDescriptionInit
    }
  | {
      type: 'video_answer'
      invite_id: string
      guest_device_id: string
      payload: RTCSessionDescriptionInit
    }
  | {
      type: 'ice_candidate'
      invite_id: string
      guest_device_id: string
      payload: RTCIceCandidateInit
    }
  | {
      type: 'session_revoked'
      invite_id: string
      reason?: RemoteSessionRevokedReason
    }
  | { type: 'heartbeat'; invite_id: string }

export type SignalingClientMessage =
  | LanSignalingClientMessage
  | CloudSignalingClientMessage

export type LanSignalingServerMessage =
  | { type: 'host_registered'; session_id: string }
  | { type: 'join_pending'; session_id: string; guest_device_id: string }
  | {
      type: 'join_approved'
      session_id: string
      guest_device_id: string
      host_device_id?: string
    }
  | { type: 'join_rejected'; session_id: string; reason: string }
  | { type: 'signal_accepted'; session_id: string }
  | {
      type: 'video_offer'
      session_id: string
      guest_device_id: string
      payload: RTCSessionDescriptionInit
    }
  | {
      type: 'video_answer'
      session_id: string
      guest_device_id: string
      payload: RTCSessionDescriptionInit
    }
  | {
      type: 'ice_candidate'
      session_id: string
      guest_device_id: string
      payload: RTCIceCandidateInit
    }
  | {
      type: 'session_revoked'
      session_id: string
      reason?: RemoteSessionRevokedReason
    }
  | {
      type: 'guest_disconnected'
      session_id: string
      guest_device_id: string
    }
  | { type: 'host_disconnected'; session_id: string }
  | { type: 'heartbeat_ack'; session_id: string }
  | { type: 'error'; reason?: string; message?: string }

export type CloudSignalingServerMessage =
  | { type: 'host_registered'; invite_id: string }
  | {
      type: 'join_request'
      invite_id: string
      guest_display_name: string
      guest_device_id: string
    }
  | { type: 'join_pending'; invite_id: string; guest_device_id: string }
  | {
      type: 'join_approved'
      invite_id: string
      guest_device_id: string
      host_device_id?: string
    }
  | {
      type: 'join_rejected'
      invite_id: string
      guest_device_id: string
      reason: string
    }
  | { type: 'signal_accepted'; invite_id: string }
  | {
      type: 'video_offer'
      invite_id: string
      guest_device_id: string
      payload: RTCSessionDescriptionInit
    }
  | {
      type: 'video_answer'
      invite_id: string
      guest_device_id: string
      payload: RTCSessionDescriptionInit
    }
  | {
      type: 'ice_candidate'
      invite_id: string
      guest_device_id: string
      payload: RTCIceCandidateInit
    }
  | {
      type: 'session_revoked'
      invite_id: string
      reason?: RemoteSessionRevokedReason
    }
  | {
      type: 'guest_disconnected'
      invite_id: string
      guest_device_id: string
    }
  | { type: 'host_disconnected'; invite_id: string }
  | { type: 'heartbeat_ack'; invite_id: string }
  | { type: 'error'; reason?: string; message?: string }

export type SignalingServerMessage =
  | LanSignalingServerMessage
  | CloudSignalingServerMessage

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

const base64ToBytes = (value: string) => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const webCrypto = () => {
  const crypto = globalThis.crypto
  if (!crypto?.subtle) {
    throw new Error('WebCrypto is unavailable for remote-session signaling')
  }
  return crypto
}

export const createLanSignalingEncryption = async ({
  sessionId,
  token,
}: {
  sessionId: string
  token: string
}): Promise<LanSignalingEncryption> => {
  const crypto = webCrypto()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(token),
    'HKDF',
    false,
    ['deriveKey']
  )
  const key = await crypto.subtle.deriveKey(
    {
      hash: 'SHA-256',
      info: textEncoder.encode(LAN_SIGNALING_ENCRYPTION_VERSION),
      name: 'HKDF',
      salt: textEncoder.encode(sessionId),
    },
    keyMaterial,
    { length: 256, name: 'AES-GCM' },
    false,
    ['decrypt', 'encrypt']
  )

  return {
    async decryptPayload<T>(payload: unknown) {
      if (!isEncryptedSignalingPayload(payload)) {
        throw new Error('Remote-session signaling payload was not encrypted')
      }
      try {
        const plaintext = await crypto.subtle.decrypt(
          { iv: base64ToBytes(payload.iv), name: 'AES-GCM' },
          key,
          base64ToBytes(payload.ciphertext)
        )
        return JSON.parse(textDecoder.decode(plaintext)) as T
      } catch {
        throw new Error('Could not decrypt remote-session signaling payload')
      }
    },
    async encryptPayload(payload: unknown) {
      const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
      const ciphertext = await crypto.subtle.encrypt(
        { iv, name: 'AES-GCM' },
        key,
        textEncoder.encode(JSON.stringify(payload))
      )
      return {
        ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
        encrypted: true,
        iv: bytesToBase64(iv),
        version: LAN_SIGNALING_ENCRYPTION_VERSION,
      }
    },
  }
}

const isEncryptedSignalingPayload = (
  payload: unknown
): payload is EncryptedSignalingPayload =>
  Boolean(
    payload &&
      typeof payload === 'object' &&
      (payload as Partial<EncryptedSignalingPayload>).encrypted === true &&
      (payload as Partial<EncryptedSignalingPayload>).version ===
        LAN_SIGNALING_ENCRYPTION_VERSION &&
      typeof (payload as Partial<EncryptedSignalingPayload>).iv === 'string' &&
      typeof (payload as Partial<EncryptedSignalingPayload>).ciphertext ===
        'string'
  )

const shouldEncryptPayload = (message: SignalingClientMessage) =>
  isLanPayloadClientMessage(message)

const shouldDecryptPayload = (message: SignalingServerMessage) =>
  isLanPayloadServerMessage(message)

const isLanPayloadMessage = (
  message: SignalingClientMessage | SignalingServerMessage
) =>
  (message.type === 'video_offer' ||
    message.type === 'video_answer' ||
    message.type === 'ice_candidate') &&
  'session_id' in message &&
  !('invite_id' in message)

const isLanPayloadClientMessage = (
  message: SignalingClientMessage
): message is LanPayloadClientMessage => isLanPayloadMessage(message)

const isLanPayloadServerMessage = (
  message: SignalingServerMessage
): message is LanPayloadServerMessage => isLanPayloadMessage(message)

const resolveLanSignalingEncryption = async (
  encryption: LanSignalingEncryptionSource
) => (typeof encryption === 'function' ? await encryption() : await encryption)

const encryptSignalingPayload = async (
  message: SignalingClientMessage,
  encryption?: LanSignalingEncryptionSource
): Promise<SignalingClientMessage> => {
  if (!encryption || !shouldEncryptPayload(message)) return message
  const resolvedEncryption = await resolveLanSignalingEncryption(encryption)
  if (!resolvedEncryption) {
    throw new Error('Remote-session signaling encryption is unavailable')
  }
  return {
    ...message,
    payload: await resolvedEncryption.encryptPayload(message.payload),
  } as SignalingClientMessage
}

const decryptSignalingPayload = async (
  message: SignalingServerMessage,
  encryption?: LanSignalingEncryptionSource
): Promise<SignalingServerMessage> => {
  if (!encryption || !shouldDecryptPayload(message)) return message
  if (!isEncryptedSignalingPayload(message.payload)) {
    throw new Error('Remote-session signaling payload was not encrypted')
  }
  const resolvedEncryption = await resolveLanSignalingEncryption(encryption)
  if (!resolvedEncryption) {
    throw new Error('Remote-session signaling encryption is unavailable')
  }
  return {
    ...message,
    payload: await resolvedEncryption.decryptPayload(message.payload),
  } as SignalingServerMessage
}

export const sendSignalingMessage = async (
  socket: WebSocket,
  message: SignalingClientMessage,
  encryption?: LanSignalingEncryptionSource
) => {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error('Remote-session signaling socket is not open')
  }
  socket.send(
    JSON.stringify(await encryptSignalingPayload(message, encryption))
  )
}

export const parseSignalingMessage = async (
  event: MessageEvent,
  encryption?: LanSignalingEncryptionSource
): Promise<SignalingServerMessage> => {
  const raw = typeof event.data === 'string' ? event.data : String(event.data)
  return await decryptSignalingPayload(
    JSON.parse(raw) as SignalingServerMessage,
    encryption
  )
}
