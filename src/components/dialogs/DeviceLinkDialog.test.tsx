import { act } from 'react'
import { render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceLinkDialog } from './DeviceLinkDialog'
import { useDeviceAuthStore } from '@/store/deviceAuthStore'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

vi.mock('@/services/deviceAuthService', () => ({
  startLinking: vi.fn(),
  pollLinking: vi.fn(),
  validateDeviceSession: vi.fn(),
  getDeviceManagementUrl: vi.fn(() => 'https://easycris.com/account/devices'),
}))

vi.mock('@/services/deviceAuthStorage', () => ({
  getOrCreateDeviceFingerprint: vi.fn(() => 'test-uuid-0'),
  saveDeviceAuthSession: vi.fn(() => Promise.resolve()),
  clearDeviceAuthSession: vi.fn(() => Promise.resolve()),
}))

import {
  pollLinking,
  startLinking,
  validateDeviceSession,
} from '@/services/deviceAuthService'

describe('DeviceLinkDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDeviceAuthStore.getState().resetToGuest()
    useDeviceAuthStore.getState().setLinkDialogOpen(true)
  })

  it('starts a pairing request when opened', async () => {
    vi.mocked(startLinking).mockResolvedValueOnce({
      deviceCode: 'device-code',
      userCode: 'BKDF-NRQV',
      verificationUri: 'https://easycris.com/auth/device',
      expiresIn: 600,
      interval: 5,
    })
    vi.mocked(pollLinking).mockResolvedValue({ status: 'pending' })

    render(<DeviceLinkDialog />)

    await screen.findByText('BKDF-NRQV')
    expect(startLinking).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /open browser/i })).toBeInTheDocument()
  })

  it('continues pairing when fingerprint bootstrap updates the store mid-request', async () => {
    type StartResponse = {
      deviceCode: string
      userCode: string
      verificationUri: string
      expiresIn: number
      interval: number
    }

    let resolveStart: ((value: StartResponse) => void) | undefined

    vi.mocked(startLinking).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve
        })
    )
    vi.mocked(pollLinking).mockResolvedValue({ status: 'pending' })

    render(<DeviceLinkDialog />)

    await waitFor(() => {
      expect(startLinking).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      useDeviceAuthStore.getState().setDeviceFingerprint('bootstrapped-fingerprint')
      resolveStart?.({
        deviceCode: 'device-code',
        userCode: 'BKDF-NRQV',
        verificationUri: 'https://easycris.com/auth/device',
        expiresIn: 600,
        interval: 5,
      })
    })

    await screen.findByText('BKDF-NRQV')
    expect(useDeviceAuthStore.getState().mode).toBe('pairing')
  })

  it('shows success after approval is validated', async () => {
    vi.mocked(startLinking).mockResolvedValueOnce({
      deviceCode: 'device-code',
      userCode: 'BKDF-NRQV',
      verificationUri: 'https://easycris.com/auth/device',
      expiresIn: 600,
      interval: 0.001,
    })
    vi.mocked(pollLinking).mockResolvedValueOnce({
      status: 'approved',
      sessionToken: 'session-token',
    })
    vi.mocked(validateDeviceSession).mockResolvedValueOnce({
      valid: true,
      deviceId: 'device-1',
      tier: 'pro',
      email: null,
      expiresAt: '2026-03-08T00:00:00.000Z',
    })

    render(<DeviceLinkDialog />)

    await screen.findByText('BKDF-NRQV')
    await screen.findByText(/this device is now linked to your easycris account/i)

    expect(startLinking).toHaveBeenCalledTimes(1)
  })

  it('polls immediately once pairing starts', async () => {
    vi.mocked(startLinking).mockResolvedValueOnce({
      deviceCode: 'device-code',
      userCode: 'BKDF-NRQV',
      verificationUri: 'https://easycris.com/auth/device',
      expiresIn: 600,
      interval: 5,
    })
    vi.mocked(pollLinking).mockResolvedValue({ status: 'pending' })

    render(<DeviceLinkDialog />)

    await screen.findByText('BKDF-NRQV')

    await waitFor(() => {
      expect(pollLinking).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps polling after a rate limit response instead of failing permanently', async () => {
    vi.mocked(startLinking).mockResolvedValueOnce({
      deviceCode: 'device-code',
      userCode: 'BKDF-NRQV',
      verificationUri: 'https://easycris.com/auth/device',
      expiresIn: 600,
      interval: 5,
    })
    vi.mocked(pollLinking)
      .mockResolvedValueOnce({ status: 'rate_limited', retryAfterSecs: 1 })
      .mockResolvedValue({ status: 'pending' })

    render(<DeviceLinkDialog />)

    await screen.findByText('BKDF-NRQV')

    await waitFor(() => {
      expect(pollLinking).toHaveBeenCalledTimes(1)
    })

    await waitFor(() => {
      expect(pollLinking).toHaveBeenCalledTimes(2)
    }, { timeout: 2000 })

    await waitFor(() => {
      expect(screen.queryByText(/linking failed/i)).not.toBeInTheDocument()
    })
  })

  it('stops polling after the dialog unmounts', async () => {
    vi.mocked(startLinking).mockResolvedValueOnce({
      deviceCode: 'device-code',
      userCode: 'BKDF-NRQV',
      verificationUri: 'https://easycris.com/auth/device',
      expiresIn: 600,
      interval: 1,
    })
    vi.mocked(pollLinking).mockResolvedValue({ status: 'pending' })

    const { unmount } = render(<DeviceLinkDialog />)

    await screen.findByText('BKDF-NRQV')
    await waitFor(() => {
      expect(pollLinking).toHaveBeenCalledTimes(1)
    })

    unmount()

    await new Promise((resolve) => window.setTimeout(resolve, 1100))

    expect(pollLinking).toHaveBeenCalledTimes(1)
  })
})
