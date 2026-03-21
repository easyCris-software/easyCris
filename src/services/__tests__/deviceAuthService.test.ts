import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  getDeviceManagementUrl,
  refreshDeviceSession,
  revokeCurrentDeviceSession,
  startLinking,
  validateDeviceSession,
  pollLinking,
} from '@/services/deviceAuthService'

describe('deviceAuthService', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('starts linking through the native Tauri command bridge', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      deviceCode: 'device-code',
      userCode: 'BKDF-NRQV',
      verificationUri: 'https://easycris.com/auth/device',
      expiresIn: 600,
      interval: 5,
    })

    await expect(
      startLinking({
        clientVersion: '0.1.24',
        deviceFingerprint: 'device-fingerprint',
      })
    ).resolves.toEqual({
      deviceCode: 'device-code',
      userCode: 'BKDF-NRQV',
      verificationUri: 'https://easycris.com/auth/device',
      expiresIn: 600,
      interval: 5,
    })

    expect(invoke).toHaveBeenCalledWith('desktop_auth_start', {
      clientVersion: '0.1.24',
      deviceFingerprint: 'device-fingerprint',
    })
  })

  it('polls and validates through native commands', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        status: 'approved',
        sessionToken: 'session-token',
      })
      .mockResolvedValueOnce({
        valid: true,
        deviceId: 'device-1',
        tier: 'pro',
        expiresAt: '2026-03-08T00:00:00.000Z',
        email: null,
      })

    await expect(pollLinking({ deviceCode: 'device-code' })).resolves.toEqual({
      status: 'approved',
      sessionToken: 'session-token',
    })

    await expect(validateDeviceSession('session-token')).resolves.toEqual({
      valid: true,
      deviceId: 'device-1',
      tier: 'pro',
      expiresAt: '2026-03-08T00:00:00.000Z',
      email: null,
    })

    expect(invoke).toHaveBeenNthCalledWith(1, 'desktop_auth_poll', {
      deviceCode: 'device-code',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'desktop_auth_validate_session', {
      sessionToken: 'session-token',
    })
  })

  it('refreshes and revokes the current device session through native commands', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        valid: true,
        sessionToken: 'new-session-token',
        deviceId: 'device-1',
        tier: 'enterprise',
        expiresAt: '2026-03-09T00:00:00.000Z',
        email: null,
      })
      .mockResolvedValueOnce({
        success: true,
        alreadyRevoked: false,
      })

    await expect(refreshDeviceSession('old-session-token')).resolves.toEqual({
      valid: true,
      sessionToken: 'new-session-token',
      deviceId: 'device-1',
      tier: 'enterprise',
      expiresAt: '2026-03-09T00:00:00.000Z',
      email: null,
    })

    await expect(revokeCurrentDeviceSession('new-session-token')).resolves.toEqual({
      success: true,
      alreadyRevoked: false,
    })

    expect(invoke).toHaveBeenNthCalledWith(1, 'desktop_auth_refresh_session', {
      sessionToken: 'old-session-token',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'desktop_auth_revoke_session', {
      sessionToken: 'new-session-token',
    })
  })

  it('builds the web device-management URL from the configured base url', () => {
    expect(getDeviceManagementUrl()).toBe('https://easycris.com/account/devices')
  })
})
