import { beforeEach, describe, expect, it } from 'vitest'
import { useDeviceAuthStore } from './deviceAuthStore'

describe('deviceAuthStore', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useDeviceAuthStore.getState().resetToGuest()
    useDeviceAuthStore.getState().setLinkDialogOpen(false)
  })

  it('starts in guest mode', () => {
    const state = useDeviceAuthStore.getState()
    expect(state.mode).toBe('guest')
    expect(state.sessionToken).toBeNull()
    expect(state.linkedEmail).toBeNull()
  })

  it('tracks a pairing request', () => {
    const store = useDeviceAuthStore.getState()

    store.setDeviceFingerprint('fingerprint-123')
    store.beginPairing({
      deviceCode: 'device-code',
      userCode: 'BKDF-NRQV',
      verificationUri: 'https://easycris.com/auth/device',
      pollIntervalSeconds: 5,
      expiresAt: '2026-03-07T18:00:00.000Z',
    })

    const state = useDeviceAuthStore.getState()
    expect(state.mode).toBe('pairing')
    expect(state.deviceFingerprint).toBe('fingerprint-123')
    expect(state.userCode).toBe('BKDF-NRQV')
    expect(state.pollIntervalSeconds).toBe(5)
  })

  it('stores a linked session', () => {
    const store = useDeviceAuthStore.getState()

    store.completeLinking({
      sessionToken: 'session-token',
      linkedEmail: 'user@example.com',
      tier: 'pro',
      deviceId: 'device-1',
      expiresAt: '2026-03-08T00:00:00.000Z',
      lastValidatedAt: '2026-03-07T18:01:00.000Z',
    })

    const state = useDeviceAuthStore.getState()
    expect(state.mode).toBe('linked')
    expect(state.sessionToken).toBe('session-token')
    expect(state.linkedEmail).toBe('user@example.com')
    expect(state.tier).toBe('pro')
    expect(state.deviceId).toBe('device-1')
  })

  it('marks the welcome flow as seen when linking completes', () => {
    const store = useDeviceAuthStore.getState()

    store.completeLinking({
      sessionToken: 'session-token',
      linkedEmail: 'user@example.com',
      tier: 'pro',
      deviceId: 'device-1',
      expiresAt: '2026-03-08T00:00:00.000Z',
      lastValidatedAt: '2026-03-07T18:01:00.000Z',
    })

    expect(window.localStorage.getItem('hasSeenWelcome')).toBe('true')
  })

  it('marks the device session invalid without losing fingerprint', () => {
    const store = useDeviceAuthStore.getState()
    store.setDeviceFingerprint('fingerprint-123')

    store.markInvalid('revoked')

    const state = useDeviceAuthStore.getState()
    expect(state.mode).toBe('invalid')
    expect(state.invalidReason).toBe('revoked')
    expect(state.deviceFingerprint).toBe('fingerprint-123')
  })

  it('resets to guest while preserving fingerprint', () => {
    const store = useDeviceAuthStore.getState()

    store.setDeviceFingerprint('fingerprint-123')
    store.completeLinking({
      sessionToken: 'session-token',
      linkedEmail: 'user@example.com',
      tier: 'free',
      deviceId: 'device-1',
      expiresAt: null,
      lastValidatedAt: null,
    })

    store.resetToGuest()

    const state = useDeviceAuthStore.getState()
    expect(state.mode).toBe('guest')
    expect(state.deviceFingerprint).toBe('fingerprint-123')
    expect(state.sessionToken).toBeNull()
  })
})
