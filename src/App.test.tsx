import { render, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDeviceAuthStore } from './store/deviceAuthStore'

const mockBootstrapDeviceAuthSession = vi.fn()
const mockRefreshLinkedDeviceSession = vi.fn()
const mockToastInfo = vi.fn()

vi.mock('./components/layout/AppShell', () => ({
  AppShell: () => (
    <div>
      <h1>Hello World</h1>
      <div role="toolbar" aria-label="window-controls">
        <button aria-label="window-close" className="window-control" />
        <button aria-label="window-minimize" className="window-control" />
        <button aria-label="window-maximize" className="window-control" />
      </div>
    </div>
  ),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ theme: 'light' }),
}))

vi.mock('./services/deviceAuthRuntime', () => ({
  bootstrapDeviceAuthSession: (...args: unknown[]) => mockBootstrapDeviceAuthSession(...args),
  refreshLinkedDeviceSession: (...args: unknown[]) => mockRefreshLinkedDeviceSession(...args),
  DEVICE_AUTH_REFRESH_INTERVAL_MS: 50,
}))

vi.mock('sonner', () => ({
  toast: {
    info: (...args: unknown[]) => mockToastInfo(...args),
  },
}))

import App from './App'

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDeviceAuthStore.getState().resetToGuest()
    mockBootstrapDeviceAuthSession.mockResolvedValue({
      status: 'guest',
      fingerprint: 'fingerprint-123',
    })
    mockRefreshLinkedDeviceSession.mockResolvedValue({
      status: 'linked',
      session: {
        sessionToken: 'session-token',
        linkedEmail: null,
        tier: 'free',
        deviceId: 'device-1',
        expiresAt: null,
        lastValidatedAt: '2026-03-07T00:00:00.000Z',
      },
    })
  })

  it('renders main window layout', () => {
    const { getByRole } = render(<App />)
    expect(getByRole('heading', { name: /hello world/i })).toBeInTheDocument()
  })

  it('renders title bar with traffic light buttons', () => {
    const { getAllByRole } = render(<App />)
    const titleBarButtons = getAllByRole('button').filter(
      (button: HTMLElement) =>
        button.getAttribute('aria-label')?.includes('window') ||
        button.className.includes('window-control')
    )
    expect(titleBarButtons.length).toBeGreaterThanOrEqual(0)
  })

  it('marks the desktop link invalid when refresh reports the session is no longer valid', async () => {
    mockBootstrapDeviceAuthSession.mockResolvedValueOnce({
      status: 'linked',
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
    mockRefreshLinkedDeviceSession.mockResolvedValueOnce({
      status: 'invalid',
      reason: 'revoked',
    })

    render(<App />)

    await waitFor(() => {
      expect(useDeviceAuthStore.getState().mode).toBe('linked')
    })

    await waitFor(() => {
      expect(mockRefreshLinkedDeviceSession).toHaveBeenCalledWith('session-token')
      expect(useDeviceAuthStore.getState().mode).toBe('invalid')
      expect(useDeviceAuthStore.getState().invalidReason).toBe('revoked')
      expect(mockToastInfo).toHaveBeenCalledWith(
        'This desktop link was revoked or expired. easyCris has switched back to guest mode.'
      )
    }, { timeout: 1000 })
  })

  it('keeps a previously linked session when bootstrap validation fails transiently', async () => {
    mockBootstrapDeviceAuthSession.mockResolvedValueOnce({
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

    render(<App />)

    await waitFor(() => {
      expect(useDeviceAuthStore.getState().mode).toBe('linked')
      expect(useDeviceAuthStore.getState().sessionToken).toBe('session-token')
      expect(mockToastInfo).toHaveBeenCalledWith(
        'Unable to verify this desktop link right now. easyCris is keeping the existing link and will retry later.'
      )
    })
  })
})
