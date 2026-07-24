import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapDeviceAuthSession,
  refreshLinkedDeviceSession,
} from '@/services/deviceAuthRuntime'

vi.mock('@/services/deviceAuthService', () => ({
  validateDeviceSession: vi.fn(),
  refreshDeviceSession: vi.fn(),
}))

vi.mock('@/services/deviceAuthStorage', () => ({
  getOrCreateDeviceFingerprint: vi.fn(() => 'fingerprint-123'),
  loadDeviceAuthSession: vi.fn(),
  saveDeviceAuthSession: vi.fn(() => Promise.resolve()),
  clearDeviceAuthSession: vi.fn(() => Promise.resolve()),
}))

import {
  refreshDeviceSession,
  validateDeviceSession,
} from '@/services/deviceAuthService'
import {
  clearDeviceAuthSession,
  loadDeviceAuthSession,
  saveDeviceAuthSession,
} from '@/services/deviceAuthStorage'

describe('deviceAuthRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('boots into guest mode when no stored session exists', async () => {
    vi.mocked(loadDeviceAuthSession).mockResolvedValueOnce(null)

    await expect(bootstrapDeviceAuthSession()).resolves.toEqual({
      status: 'guest',
      fingerprint: 'fingerprint-123',
    })
  })

  it('validates and restores a stored linked session on startup', async () => {
    vi.mocked(loadDeviceAuthSession).mockResolvedValueOnce({
      sessionToken: 'session-token',
      linkedEmail: null,
      tier: null,
      deviceId: null,
      expiresAt: null,
      lastValidatedAt: null,
    })
    vi.mocked(validateDeviceSession).mockResolvedValueOnce({
      valid: true,
      email: 'user@example.com',
      tier: 'pro',
      deviceId: 'device-1',
      expiresAt: '2026-03-09T00:00:00.000Z',
    })

    const result = await bootstrapDeviceAuthSession()

    expect(result.status).toBe('linked')
    if (result.status === 'linked') {
      expect(result.session.sessionToken).toBe('session-token')
      expect(result.session.linkedEmail).toBe('user@example.com')
      expect(result.session.tier).toBe('pro')
      expect(result.session.deviceId).toBe('device-1')
    }
    expect(saveDeviceAuthSession).toHaveBeenCalledTimes(1)
  })

  it('clears the stored session when startup validation reports revocation', async () => {
    vi.mocked(loadDeviceAuthSession).mockResolvedValueOnce({
      sessionToken: 'session-token',
      linkedEmail: 'user@example.com',
      tier: 'free',
      deviceId: 'device-1',
      expiresAt: null,
      lastValidatedAt: null,
    })
    vi.mocked(validateDeviceSession).mockResolvedValueOnce({
      valid: false,
      reason: 'revoked',
    })

    await expect(bootstrapDeviceAuthSession()).resolves.toEqual({
      status: 'invalid',
      fingerprint: 'fingerprint-123',
      reason: 'revoked',
    })

    expect(clearDeviceAuthSession).toHaveBeenCalledTimes(1)
  })

  it('keeps the stored linked session when startup validation fails transiently', async () => {
    vi.mocked(loadDeviceAuthSession).mockResolvedValueOnce({
      sessionToken: 'session-token',
      linkedEmail: null,
      tier: 'free',
      deviceId: 'device-1',
      expiresAt: null,
      lastValidatedAt: '2026-03-07T00:00:00.000Z',
    })
    vi.mocked(validateDeviceSession).mockRejectedValueOnce(new Error('network down'))

    await expect(bootstrapDeviceAuthSession()).resolves.toEqual({
      status: 'linked_stale',
      fingerprint: 'fingerprint-123',
      session: {
        sessionToken: 'session-token',
        linkedEmail: null,
        tier: 'free',
        deviceId: 'device-1',
        expiresAt: null,
        lastValidatedAt: '2026-03-07T00:00:00.000Z',
      },
    })

    expect(clearDeviceAuthSession).not.toHaveBeenCalled()
    expect(saveDeviceAuthSession).not.toHaveBeenCalled()
  })

  it('refreshes a linked session and persists the rotated token', async () => {
    vi.mocked(refreshDeviceSession).mockResolvedValueOnce({
      valid: true,
      sessionToken: 'new-token',
      email: 'user@example.com',
      tier: 'enterprise',
      deviceId: 'device-1',
      expiresAt: '2026-03-10T00:00:00.000Z',
    })

    const result = await refreshLinkedDeviceSession('old-token')

    expect(result.status).toBe('linked')
    if (result.status === 'linked') {
      expect(result.session.sessionToken).toBe('new-token')
      expect(result.session.tier).toBe('enterprise')
    }
    expect(saveDeviceAuthSession).toHaveBeenCalledTimes(1)
  })

  it('keeps the current token when refresh is valid but no replacement token is returned', async () => {
    vi.mocked(refreshDeviceSession).mockResolvedValueOnce({
      valid: true,
      email: 'user@example.com',
      tier: 'pro',
      deviceId: 'device-1',
      expiresAt: '2026-03-10T00:00:00.000Z',
    })

    const result = await refreshLinkedDeviceSession('current-token')

    expect(result.status).toBe('linked')
    if (result.status === 'linked') {
      expect(result.session.sessionToken).toBe('current-token')
      expect(result.session.linkedEmail).toBe('user@example.com')
    }
    expect(clearDeviceAuthSession).not.toHaveBeenCalled()
    expect(saveDeviceAuthSession).toHaveBeenCalledTimes(1)
  })

  it('clears the stored session when refresh reports an invalid token', async () => {
    vi.mocked(refreshDeviceSession).mockResolvedValueOnce({
      valid: false,
      reason: 'unknown_token',
      sessionToken: 'stale-token',
    })

    await expect(refreshLinkedDeviceSession('stale-token')).resolves.toEqual({
      status: 'invalid',
      reason: 'unknown_token',
    })

    expect(clearDeviceAuthSession).toHaveBeenCalledTimes(1)
  })

  it('clears the stored session when refresh reports invalid without a replacement token', async () => {
    vi.mocked(refreshDeviceSession).mockResolvedValueOnce({
      valid: false,
      reason: 'revoked',
    })

    await expect(refreshLinkedDeviceSession('stale-token')).resolves.toEqual({
      status: 'invalid',
      reason: 'revoked',
    })

    expect(clearDeviceAuthSession).toHaveBeenCalledTimes(1)
  })
})
