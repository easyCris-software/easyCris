import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  clearDeviceAuthSession,
  getOrCreateDeviceFingerprint,
  loadDeviceAuthSession,
  loadDeviceFingerprint,
  saveDeviceAuthSession,
} from '@/services/deviceAuthStorage'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

describe('deviceAuthStorage', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.mocked(invoke).mockReset()
  })

  it('creates and reuses a stable device fingerprint', () => {
    const first = getOrCreateDeviceFingerprint()
    const second = getOrCreateDeviceFingerprint()

    expect(first).toBe('test-uuid-0')
    expect(second).toBe(first)
    expect(loadDeviceFingerprint()).toBe(first)
  })

  it('persists only non-PII metadata locally and stores the session token in native secure storage', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('session-token')
      .mockResolvedValueOnce(undefined)

    await saveDeviceAuthSession({
      sessionToken: 'session-token',
      linkedEmail: 'user@example.com',
      tier: 'pro',
      deviceId: 'device-1',
      expiresAt: '2026-03-08T00:00:00.000Z',
      lastValidatedAt: '2026-03-07T18:00:00.000Z',
    })

    await expect(loadDeviceAuthSession()).resolves.toEqual({
      sessionToken: 'session-token',
      linkedEmail: null,
      tier: 'pro',
      deviceId: 'device-1',
      expiresAt: '2026-03-08T00:00:00.000Z',
      lastValidatedAt: '2026-03-07T18:00:00.000Z',
    })

    expect(window.localStorage.getItem('easycris.device_auth.session_metadata')).not.toContain(
      'user@example.com'
    )

    expect(invoke).toHaveBeenNthCalledWith(1, 'desktop_auth_store_session_token', {
      token: 'session-token',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'desktop_auth_load_session_token')

    await clearDeviceAuthSession()
    expect(invoke).toHaveBeenNthCalledWith(3, 'desktop_auth_clear_session_token')
  })
})
