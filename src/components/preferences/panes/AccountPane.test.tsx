import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDeviceAuthStore } from '@/store/deviceAuthStore'
import { AccountPane } from './AccountPane'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

vi.mock('@/services/deviceAuthService', () => ({
  getDeviceManagementUrl: vi.fn(() => 'https://easycris.com/account/devices'),
  revokeCurrentDeviceSession: vi.fn(() =>
    Promise.resolve({ success: true, alreadyRevoked: false })
  ),
}))

vi.mock('@/services/deviceAuthStorage', () => ({
  clearDeviceAuthSession: vi.fn(() => Promise.resolve()),
}))

describe('AccountPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDeviceAuthStore.getState().resetToGuest()
  })

  it('shows guest state and a link action', () => {
    render(<AccountPane />)

    expect(screen.getByText(/guest mode/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /link this device/i })).toBeInTheDocument()
  })

  it('shows linked state and signs out the current device', async () => {
    useDeviceAuthStore.getState().completeLinking({
      sessionToken: 'session-token',
      linkedEmail: 'user@example.com',
      tier: 'pro',
      deviceId: 'device-1',
      expiresAt: '2026-03-09T00:00:00.000Z',
      lastValidatedAt: '2026-03-08T00:00:00.000Z',
    })

    render(<AccountPane />)

    expect(screen.getByText(/user@example.com/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /sign out this device/i }))

    await waitFor(() =>
      expect(useDeviceAuthStore.getState().mode).toBe('guest')
    )
  })
})
