import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { useDeviceAuthStore } from '@/store/deviceAuthStore'
import {
  clearDeviceAuthState,
  getDeviceAuthSnapshot,
  setFirstLaunchState,
} from '@/utils/e2eAuthHooks'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

describe('e2eAuthHooks', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.mocked(invoke).mockReset()
    useDeviceAuthStore.getState().resetToGuest()
    useDeviceAuthStore.getState().setLinkDialogOpen(false)
  })

  it('clears auth state, resets onboarding, and returns to guest mode', async () => {
    window.localStorage.setItem('easycris.device_auth.fingerprint', 'fingerprint-1')
    window.localStorage.setItem(
      'easycris.device_auth.session_metadata',
      JSON.stringify({
        tier: 'pro',
        deviceId: 'device-1',
        expiresAt: '2026-03-09T00:00:00.000Z',
        lastValidatedAt: '2026-03-08T00:00:00.000Z',
      })
    )
    window.localStorage.setItem('hasSeenWelcome', 'true')

    useDeviceAuthStore.getState().restoreLinkedSession({
      sessionToken: 'session-token',
      linkedEmail: 'user@example.com',
      tier: 'pro',
      deviceId: 'device-1',
      expiresAt: '2026-03-09T00:00:00.000Z',
      lastValidatedAt: '2026-03-08T00:00:00.000Z',
    })
    useDeviceAuthStore.getState().setLinkDialogOpen(true)

    await clearDeviceAuthState()

    expect(invoke).toHaveBeenCalledWith('desktop_auth_clear_session_token')
    expect(window.localStorage.getItem('easycris.device_auth.fingerprint')).toBeNull()
    expect(window.localStorage.getItem('easycris.device_auth.session_metadata')).toBeNull()
    expect(window.localStorage.getItem('hasSeenWelcome')).toBeNull()

    expect(getDeviceAuthSnapshot()).toMatchObject({
      mode: 'guest',
      linkDialogOpen: false,
      sessionTokenPresent: false,
      hasSeenWelcome: false,
      deviceFingerprint: null,
    })
  })

  it('can preserve the fingerprint while still clearing session state', async () => {
    window.localStorage.setItem('easycris.device_auth.fingerprint', 'fingerprint-2')
    window.localStorage.setItem('hasSeenWelcome', 'true')
    window.localStorage.setItem('easycris.e2e.force_first_launch', 'true')

    await clearDeviceAuthState({ clearFingerprint: false, showWelcome: false })

    expect(window.localStorage.getItem('easycris.device_auth.fingerprint')).toBe('fingerprint-2')
    expect(window.localStorage.getItem('hasSeenWelcome')).toBe('true')
    expect(window.localStorage.getItem('easycris.e2e.force_first_launch')).toBeNull()
  })

  it('reports the current auth snapshot from store and local storage', () => {
    window.localStorage.setItem('easycris.device_auth.fingerprint', 'fingerprint-3')
    window.localStorage.setItem('hasSeenWelcome', 'true')

    useDeviceAuthStore.getState().restoreLinkedSession({
      sessionToken: 'session-token',
      linkedEmail: 'linked@example.com',
      tier: 'enterprise',
      deviceId: 'device-3',
      expiresAt: '2026-03-10T00:00:00.000Z',
      lastValidatedAt: '2026-03-08T12:00:00.000Z',
    })

    expect(getDeviceAuthSnapshot()).toMatchObject({
      mode: 'linked',
      deviceFingerprint: 'fingerprint-3',
      linkedEmail: 'linked@example.com',
      tier: 'enterprise',
      deviceId: 'device-3',
      sessionTokenPresent: true,
      hasSeenWelcome: true,
    })
  })

  it('toggles the first-launch flag explicitly', () => {
    setFirstLaunchState(false)
    expect(window.localStorage.getItem('hasSeenWelcome')).toBe('true')
    expect(window.localStorage.getItem('easycris.e2e.force_first_launch')).toBeNull()

    setFirstLaunchState(true)
    expect(window.localStorage.getItem('hasSeenWelcome')).toBeNull()
    expect(window.localStorage.getItem('easycris.e2e.force_first_launch')).toBe('true')
  })
})
