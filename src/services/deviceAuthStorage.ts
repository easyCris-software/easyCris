import { invoke } from '@tauri-apps/api/core'
import type { StoredDeviceAuthSession } from '@/lib/deviceAuth'

const DEVICE_AUTH_FINGERPRINT_KEY = 'easycris.device_auth.fingerprint'
const DEVICE_AUTH_SESSION_METADATA_KEY = 'easycris.device_auth.session_metadata'

type DeviceAuthSessionMetadata = Omit<StoredDeviceAuthSession, 'sessionToken' | 'linkedEmail'>

const getStorage = (): Storage | null => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return window.localStorage
}

const parseSessionMetadata = (raw: string | null): DeviceAuthSessionMetadata | null => {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<DeviceAuthSessionMetadata>
    return {
      tier: typeof parsed.tier === 'string' ? parsed.tier : null,
      deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : null,
      expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null,
      lastValidatedAt:
        typeof parsed.lastValidatedAt === 'string' ? parsed.lastValidatedAt : null,
    }
  } catch {
    return null
  }
}

function persistSessionMetadata(metadata: DeviceAuthSessionMetadata): void {
  const storage = getStorage()
  if (!storage) return

  storage.setItem(DEVICE_AUTH_SESSION_METADATA_KEY, JSON.stringify(metadata))
}

function loadSessionMetadata(): DeviceAuthSessionMetadata | null {
  return parseSessionMetadata(getStorage()?.getItem(DEVICE_AUTH_SESSION_METADATA_KEY) ?? null)
}

function clearSessionMetadata(): void {
  getStorage()?.removeItem(DEVICE_AUTH_SESSION_METADATA_KEY)
}

export function loadDeviceFingerprint(): string | null {
  return getStorage()?.getItem(DEVICE_AUTH_FINGERPRINT_KEY) ?? null
}

export function getOrCreateDeviceFingerprint(): string {
  const storage = getStorage()
  if (!storage) {
    return crypto.randomUUID()
  }

  const existing = storage.getItem(DEVICE_AUTH_FINGERPRINT_KEY)
  if (existing) {
    return existing
  }

  const next = crypto.randomUUID()
  storage.setItem(DEVICE_AUTH_FINGERPRINT_KEY, next)
  return next
}

export async function saveDeviceAuthSession(
  session: StoredDeviceAuthSession
): Promise<void> {
  await invoke('desktop_auth_store_session_token', {
    token: session.sessionToken,
  })

  persistSessionMetadata({
    tier: session.tier,
    deviceId: session.deviceId,
    expiresAt: session.expiresAt,
    lastValidatedAt: session.lastValidatedAt,
  })
}

export async function loadDeviceAuthSession(): Promise<StoredDeviceAuthSession | null> {
  const sessionToken = await invoke<string | null>('desktop_auth_load_session_token')
  if (typeof sessionToken !== 'string' || !sessionToken.trim()) {
    return null
  }

  const metadata = loadSessionMetadata()
  return {
    sessionToken,
    linkedEmail: null,
    tier: metadata?.tier ?? null,
    deviceId: metadata?.deviceId ?? null,
    expiresAt: metadata?.expiresAt ?? null,
    lastValidatedAt: metadata?.lastValidatedAt ?? null,
  }
}

export async function clearDeviceAuthSession(): Promise<void> {
  await invoke('desktop_auth_clear_session_token')
  clearSessionMetadata()
}
