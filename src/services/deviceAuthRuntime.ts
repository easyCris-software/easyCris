import type {
  DeviceSessionRefreshResult,
  DeviceSessionValidationResult,
  StoredDeviceAuthSession,
} from '@/lib/deviceAuth'
import {
  refreshDeviceSession,
  validateDeviceSession,
} from '@/services/deviceAuthService'
import {
  clearDeviceAuthSession,
  getOrCreateDeviceFingerprint,
  loadDeviceAuthSession,
  saveDeviceAuthSession,
} from '@/services/deviceAuthStorage'

export const DEVICE_AUTH_REFRESH_INTERVAL_MS = 10 * 60 * 1000

type BootstrapResult =
  | { status: 'guest'; fingerprint: string }
  | { status: 'linked'; fingerprint: string; session: StoredDeviceAuthSession }
  | { status: 'linked_stale'; fingerprint: string; session: StoredDeviceAuthSession }
  | { status: 'invalid'; fingerprint: string; reason: string }

type RefreshResult =
  | { status: 'linked'; session: StoredDeviceAuthSession }
  | { status: 'invalid'; reason: string }

const toStoredSession = (
  sessionToken: string,
  result: DeviceSessionValidationResult | DeviceSessionRefreshResult
): StoredDeviceAuthSession => ({
  sessionToken,
  linkedEmail: result.email ?? null,
  tier: result.tier ?? null,
  deviceId: result.deviceId ?? null,
  expiresAt: result.expiresAt ?? null,
  lastValidatedAt: new Date().toISOString(),
})

export async function bootstrapDeviceAuthSession(): Promise<BootstrapResult> {
  const fingerprint = getOrCreateDeviceFingerprint()
  const storedSession = await loadDeviceAuthSession()

  if (!storedSession) {
    return { status: 'guest', fingerprint }
  }

  let validation: DeviceSessionValidationResult

  try {
    validation = await validateDeviceSession(storedSession.sessionToken)
  } catch {
    return {
      status: 'linked_stale',
      fingerprint,
      session: storedSession,
    }
  }

  if (!validation.valid) {
    await clearDeviceAuthSession()
    return {
      status: 'invalid',
      fingerprint,
      reason: validation.reason ?? 'unknown_token',
    }
  }

  const normalizedSession = toStoredSession(storedSession.sessionToken, validation)
  await saveDeviceAuthSession(normalizedSession)

  return {
    status: 'linked',
    fingerprint,
    session: normalizedSession,
  }
}

export async function refreshLinkedDeviceSession(
  sessionToken: string
): Promise<RefreshResult> {
  const refreshed = await refreshDeviceSession(sessionToken)
  if (!refreshed.valid) {
    await clearDeviceAuthSession()
    return {
      status: 'invalid',
      reason: refreshed.reason ?? 'unknown_token',
    }
  }

  const normalizedSession = toStoredSession(refreshed.sessionToken ?? sessionToken, refreshed)
  await saveDeviceAuthSession(normalizedSession)
  return {
    status: 'linked',
    session: normalizedSession,
  }
}
