import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRemoteJoinUrlStore } from '@/store/remote-join-url-store'
import { getCloudRemoteInviteMetadata } from '@/services/remoteSessionService'
import { toast } from 'sonner'
import { RemoteSessionJoinView } from './RemoteSessionJoinView'

const {
  attachCallbacks,
  mockAttach,
  mockClose,
  mockDisableAudio,
  mockEnableAudio,
  mockGetAudioDiagnostics,
  mockHostClose,
  mockJoin,
  mockSetAudioInputDevice,
  mockSetAudioMuted,
} = vi.hoisted(() => ({
  attachCallbacks: {
    current: null as null | {
      onState?: (state: string, message?: string) => void
      onSecurityCode?: (code: string | null) => void
      onRemoteAudioStream?: (stream: MediaStream) => void
    },
  },
  mockAttach: vi.fn(callbacks => {
    attachCallbacks.current = callbacks
  }),
  mockClose: vi.fn(),
  mockDisableAudio: vi.fn().mockResolvedValue(undefined),
  mockEnableAudio: vi.fn().mockResolvedValue(undefined),
  mockGetAudioDiagnostics: vi.fn<() => Record<string, unknown>>(() => ({
    audioSenderCreated: false,
  })),
  mockHostClose: vi.fn().mockResolvedValue(undefined),
  mockJoin: vi.fn().mockResolvedValue(undefined),
  mockSetAudioInputDevice: vi.fn().mockResolvedValue(undefined),
  mockSetAudioMuted: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('@/services/remoteWebRtcClient', () => ({
  remoteWebRtcClient: {
    attach: mockAttach,
    close: mockClose,
    detach: vi.fn(),
    disableAudio: mockDisableAudio,
    enableAudio: mockEnableAudio,
    getAudioDiagnostics: mockGetAudioDiagnostics,
    join: mockJoin,
    sendInputMessage: vi.fn(),
    setAudioInputDevice: mockSetAudioInputDevice,
    setAudioMuted: mockSetAudioMuted,
  },
}))

vi.mock('@/services/remoteWebRtcHost', () => ({
  remoteWebRtcHost: {
    close: mockHostClose,
  },
}))

vi.mock('@/services/remoteSessionService', () => ({
  getCloudRemoteInviteMetadata: vi.fn(),
  remoteForceRelayEnabled: false,
  setRemoteWindowCaptureExclusion: vi.fn(),
}))

vi.mock('@/store/deviceAuthStore', () => ({
  useDeviceAuthStore: () => ({
    linkedEmail: null,
    deviceId: 'guest-device',
    deviceFingerprint: 'guest-fingerprint',
  }),
}))

describe('RemoteSessionJoinView', () => {
  beforeEach(() => {
    attachCallbacks.current = null
    mockAttach.mockClear()
    mockClose.mockClear()
    mockDisableAudio.mockClear()
    mockDisableAudio.mockResolvedValue(undefined)
    mockEnableAudio.mockClear()
    mockEnableAudio.mockResolvedValue(undefined)
    mockGetAudioDiagnostics.mockClear()
    mockGetAudioDiagnostics.mockReturnValue({ audioSenderCreated: false })
    mockHostClose.mockClear()
    mockHostClose.mockResolvedValue(undefined)
    mockJoin.mockClear()
    mockJoin.mockResolvedValue(undefined)
    mockSetAudioInputDevice.mockClear()
    mockSetAudioInputDevice.mockResolvedValue(undefined)
    mockSetAudioMuted.mockClear()
    mockSetAudioMuted.mockResolvedValue(undefined)
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.success).mockClear()
    vi.mocked(getCloudRemoteInviteMetadata).mockReset()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
      () => undefined
    )
    useRemoteJoinUrlStore.setState({ dialogOpen: false, pendingUrl: null })
  })

  it('keeps session status and security code out of the Preferences setup pane', () => {
    render(<RemoteSessionJoinView />)

    act(() => {
      attachCallbacks.current?.onState?.('pending_approval')
      attachCallbacks.current?.onSecurityCode?.('1234-ABCD-EF90')
    })

    expect(screen.queryByTestId('remote-guest-status-badge')).toBeNull()
    expect(
      screen.queryByTestId('remote-guest-security-code')
    ).not.toBeInTheDocument()
  })

  it('keeps guest media controls out of the Preferences setup pane', () => {
    render(<RemoteSessionJoinView />)

    expect(screen.queryByTestId('remote-guest-audio-controls')).toBeNull()

    expect(attachCallbacks.current?.onState).toBeDefined()
    act(() => {
      attachCallbacks.current?.onState?.('streaming')
    })

    expect(screen.queryByTestId('remote-guest-audio-controls')).toBeNull()
    expect(screen.queryByTestId('remote-guest-audio-output')).toBeNull()
  })

  it('does not expose technical LAN or Internet mode toggles', () => {
    render(<RemoteSessionJoinView />)

    expect(screen.queryByTestId('remote-guest-mode-lan')).toBeNull()
    expect(screen.queryByTestId('remote-guest-mode-internet')).toBeNull()
    expect(screen.getByText(/paste an invite from a trusted host/i)).toBeInTheDocument()
    expect(screen.getByTestId('remote-join-invite')).toBeInTheDocument()
    expect(screen.getByTestId('remote-parse-invite')).toBeInTheDocument()
    expect(screen.getByTestId('remote-clear-join-fields')).toBeInTheDocument()
  })

  it('does not render the remote desktop viewer before streaming starts', () => {
    render(<RemoteSessionJoinView />)

    expect(screen.queryByTestId('remote-viewer-shell')).toBeNull()
    expect(
      screen.queryByText(/you are the guest\. this is the host display/i)
    ).not.toBeInTheDocument()

    act(() => {
      attachCallbacks.current?.onState?.('pending_approval')
    })

    expect(screen.queryByTestId('remote-viewer-shell')).toBeNull()
  })

  it('keeps the active remote desktop viewer out of the Preferences setup pane', () => {
    render(<RemoteSessionJoinView />)

    act(() => {
      attachCallbacks.current?.onState?.('streaming')
    })

    expect(screen.queryByTestId('remote-viewer-shell')).toBeNull()
    expect(screen.queryByTestId('remote-stream-video')).toBeNull()
  })

  it('does not render enlarge controls in the Preferences setup pane', () => {
    render(<RemoteSessionJoinView />)

    expect(screen.queryByTestId('remote-viewer-enlarge')).toBeNull()

    act(() => {
      attachCallbacks.current?.onState?.('pending_approval')
    })
    expect(screen.queryByTestId('remote-viewer-enlarge')).toBeNull()

    act(() => {
      attachCallbacks.current?.onState?.('streaming')
    })
    expect(screen.queryByTestId('remote-viewer-enlarge')).toBeNull()

    act(() => {
      attachCallbacks.current?.onState?.('revoked')
    })
    expect(screen.queryByTestId('remote-viewer-shell')).toBeNull()
  })

  it('disconnects from the Preferences setup pane without owning the viewer', () => {
    render(<RemoteSessionJoinView />)

    act(() => {
      attachCallbacks.current?.onState?.('streaming')
    })

    fireEvent.click(screen.getByTestId('remote-disconnect'))

    expect(mockClose).toHaveBeenCalled()
    expect(screen.queryByTestId('remote-viewer-shell')).toBeNull()
  })

  it('consumes a pending LAN deep link and populates the join fields', async () => {
    useRemoteJoinUrlStore
      .getState()
      .setPendingUrl(
        'easycris-remote://join?host=127.0.0.1:49152&session=session-1&token=invite-token'
      )
    useRemoteJoinUrlStore.getState().hideDialog()

    render(<RemoteSessionJoinView />)

    await waitFor(() =>
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'session-1'
      )
    )
    expect(screen.getByTestId('remote-join-invite')).toHaveValue(
      'easycris-remote://join?host=127.0.0.1:49152&session=session-1&token=invite-token'
    )
    expect(screen.getByTestId('remote-join-host')).toHaveValue('127.0.0.1')
    expect(screen.getByTestId('remote-join-port')).toHaveValue('49152')
    expect(screen.getByTestId('remote-join-token')).toHaveValue(
      'invite-token'
    )
    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBeNull()
  })

  it('waits for the invite dialog to hand off before populating pending fields', async () => {
    const pendingUrl =
      'easycris-remote://join?host=127.0.0.1:49152&session=session-1&token=invite-token'
    act(() => {
      useRemoteJoinUrlStore.setState({
        dialogOpen: true,
        pendingUrl,
      })
    })

    render(<RemoteSessionJoinView />)

    expect(screen.getByTestId('remote-join-session-id')).toHaveValue('')
    expect(useRemoteJoinUrlStore.getState()).toMatchObject({
      dialogOpen: true,
      pendingUrl,
    })

    act(() => {
      useRemoteJoinUrlStore.getState().hideDialog()
    })

    await waitFor(() =>
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'session-1'
      )
    )
    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBeNull()
  })

  it('consumes a pending deep link delivered after the setup form mounts', async () => {
    const pendingUrl =
      'easycris-remote://join?host=127.0.0.1:49152&session=session-2&token=invite-token-2'

    render(<RemoteSessionJoinView />)

    act(() => {
      useRemoteJoinUrlStore.getState().setPendingUrl(pendingUrl)
      useRemoteJoinUrlStore.getState().hideDialog()
    })

    await waitFor(() =>
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'session-2'
      )
    )
    expect(screen.getByTestId('remote-join-token')).toHaveValue(
      'invite-token-2'
    )
    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBeNull()
  })

  it('notifies the parent after a successful LAN join', async () => {
    const onJoinSuccess = vi.fn()
    render(<RemoteSessionJoinView onJoinSuccess={onJoinSuccess} />)

    fireEvent.change(screen.getByTestId('remote-join-host'), {
      target: { value: '127.0.0.1' },
    })
    fireEvent.change(screen.getByTestId('remote-join-port'), {
      target: { value: '49152' },
    })
    fireEvent.change(screen.getByTestId('remote-join-session-id'), {
      target: { value: 'session-1' },
    })
    fireEvent.change(screen.getByTestId('remote-join-token'), {
      target: { value: 'invite-token' },
    })

    fireEvent.click(screen.getByTestId('remote-join-session'))

    await waitFor(() => expect(mockJoin).toHaveBeenCalledTimes(1))
    expect(
      screen.getByText('Join request sent. Waiting for host approval.')
    ).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith(
      'Join request sent. Waiting for host approval.'
    )
    expect(onJoinSuccess).toHaveBeenCalledTimes(1)
  })

  it('closes any stale host session before joining as guest', async () => {
    render(<RemoteSessionJoinView />)

    fireEvent.change(screen.getByTestId('remote-join-host'), {
      target: { value: '127.0.0.1' },
    })
    fireEvent.change(screen.getByTestId('remote-join-port'), {
      target: { value: '49152' },
    })
    fireEvent.change(screen.getByTestId('remote-join-session-id'), {
      target: { value: 'session-1' },
    })
    fireEvent.change(screen.getByTestId('remote-join-token'), {
      target: { value: 'invite-token' },
    })

    fireEvent.click(screen.getByTestId('remote-join-session'))

    await waitFor(() => expect(mockJoin).toHaveBeenCalledTimes(1))
    expect(mockHostClose).toHaveBeenCalledWith(false)
    const [hostCloseCallOrder] = mockHostClose.mock.invocationCallOrder
    const [joinCallOrder] = mockJoin.mock.invocationCallOrder
    expect(hostCloseCallOrder).toBeDefined()
    expect(joinCallOrder).toBeDefined()
    expect(hostCloseCallOrder!).toBeLessThan(joinCallOrder!)
  })

  it('consumes a pending cloud deep link and resolves relay metadata', async () => {
    vi.mocked(getCloudRemoteInviteMetadata).mockResolvedValueOnce({
      invite_id: 'rmt_cloud',
      relay_url: 'wss://relay.easycris.test/ws',
      expires_at_unix_ms: 9_999_999_999_999,
      status: 'listening',
    })
    useRemoteJoinUrlStore
      .getState()
      .setPendingUrl(
        'easycris-remote://join?mode=cloud&invite=rmt_cloud&token=guest-token'
      )
    useRemoteJoinUrlStore.getState().hideDialog()

    render(<RemoteSessionJoinView />)

    await waitFor(() => {
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'rmt_cloud'
      )
      expect(screen.getByTestId('remote-join-session')).toBeEnabled()
      expect(screen.getByTestId('remote-join-token')).toHaveValue(
        'guest-token'
      )
      expect(screen.getByTestId('remote-join-host')).toHaveValue('')
      expect(screen.getByTestId('remote-join-port')).toHaveValue('')
    })
    expect(getCloudRemoteInviteMetadata).toHaveBeenCalledWith('rmt_cloud')
    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBeNull()
  })

  it('clears a parsed cloud invite and restores manual same-wifi fields', async () => {
    vi.mocked(getCloudRemoteInviteMetadata).mockResolvedValueOnce({
      invite_id: 'rmt_cloud',
      relay_url: 'wss://relay.easycris.test/ws',
      expires_at_unix_ms: 9_999_999_999_999,
      status: 'listening',
    })

    render(<RemoteSessionJoinView />)

    fireEvent.change(screen.getByTestId('remote-join-invite'), {
      target: {
        value:
          'easycris-remote://join?mode=cloud&invite=rmt_cloud&token=guest-token',
      },
    })
    fireEvent.click(screen.getByTestId('remote-parse-invite'))

    await waitFor(() => {
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'rmt_cloud'
      )
      expect(screen.getByTestId('remote-join-host')).toBeDisabled()
      expect(screen.getByTestId('remote-join-port')).toBeDisabled()
      expect(screen.getByTestId('remote-join-token')).toBeDisabled()
    })

    fireEvent.click(screen.getByTestId('remote-clear-join-fields'))

    expect(screen.getByTestId('remote-join-host')).toBeEnabled()
    expect(screen.getByTestId('remote-join-port')).toBeEnabled()
    expect(screen.getByTestId('remote-join-session-id')).toBeEnabled()
    expect(screen.getByTestId('remote-join-token')).toBeEnabled()
    expect(screen.getByTestId('remote-join-session')).toBeDisabled()
  })

  it('clears a handed-off pending invite so it does not reapply on remount', async () => {
    vi.mocked(getCloudRemoteInviteMetadata).mockResolvedValue({
      invite_id: 'rmt_cloud',
      relay_url: 'wss://relay.easycris.test/ws',
      expires_at_unix_ms: 9_999_999_999_999,
      status: 'listening',
    })
    const pendingUrl =
      'easycris-remote://join?mode=cloud&invite=rmt_cloud&token=guest-token'
    useRemoteJoinUrlStore.setState({
      dialogOpen: false,
      pendingUrl,
    })

    const { unmount } = render(<RemoteSessionJoinView />)

    await waitFor(() =>
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'rmt_cloud'
      )
    )
    fireEvent.click(screen.getByTestId('remote-clear-join-fields'))

    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBeNull()
    unmount()
    render(<RemoteSessionJoinView />)

    // The successful hand-off parse already consumed the store URL; Clear is a
    // no-op for that identity, so remount has no pending URL to reapply.
    expect(screen.getByTestId('remote-join-session-id')).toHaveValue('')
    expect(screen.getByTestId('remote-join-token')).toHaveValue('')
  })

  it('does not clear a newer pending invite when clearing the current form', async () => {
    vi.mocked(getCloudRemoteInviteMetadata)
      .mockResolvedValueOnce({
        invite_id: 'rmt_first',
        relay_url: 'wss://relay.easycris.test/first',
        expires_at_unix_ms: 9_999_999_999_999,
        status: 'listening',
      })
      .mockResolvedValue({
        invite_id: 'rmt_second',
        relay_url: 'wss://relay.easycris.test/second',
        expires_at_unix_ms: 9_999_999_999_999,
        status: 'listening',
      })
    const firstUrl =
      'easycris-remote://join?mode=cloud&invite=rmt_first&token=first-token'
    const secondUrl =
      'easycris-remote://join?mode=cloud&invite=rmt_second&token=second-token'
    useRemoteJoinUrlStore.setState({
      dialogOpen: false,
      pendingUrl: firstUrl,
    })

    render(<RemoteSessionJoinView />)

    await waitFor(() =>
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'rmt_first'
      )
    )
    act(() => {
      useRemoteJoinUrlStore.getState().setPendingUrl(secondUrl)
    })
    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBe(secondUrl)

    fireEvent.click(screen.getByTestId('remote-clear-join-fields'))

    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBe(secondUrl)
    expect(screen.getByTestId('remote-join-session-id')).toHaveValue('')
    expect(screen.getByTestId('remote-join-token')).toHaveValue('')
  })

  it('clears a failed handed-off pending invite from the store', async () => {
    vi.mocked(getCloudRemoteInviteMetadata).mockRejectedValueOnce(
      new Error('Relay unavailable')
    )
    const pendingUrl =
      'easycris-remote://join?mode=cloud&invite=rmt_cloud&token=guest-token'
    useRemoteJoinUrlStore.setState({
      dialogOpen: false,
      pendingUrl,
    })

    render(<RemoteSessionJoinView />)

    await waitFor(() =>
      expect(screen.getByText(/relay unavailable/i)).toBeInTheDocument()
    )
    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBe(pendingUrl)

    fireEvent.click(screen.getByTestId('remote-clear-join-fields'))

    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBeNull()
  })

  it('keeps a pending cloud deep link when relay metadata lookup fails', async () => {
    vi.mocked(getCloudRemoteInviteMetadata).mockRejectedValueOnce(
      new Error('Relay lookup failed')
    )
    const pendingUrl =
      'easycris-remote://join?mode=cloud&invite=rmt_cloud&token=guest-token'
    act(() => {
      useRemoteJoinUrlStore.getState().setPendingUrl(pendingUrl)
      useRemoteJoinUrlStore.getState().hideDialog()
    })

    render(<RemoteSessionJoinView />)

    await waitFor(() =>
      expect(screen.getByText('Relay lookup failed')).toBeInTheDocument()
    )
    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBe(pendingUrl)
  })

  it('applies the same pending LAN deep link again after it was cleared', async () => {
    const pendingUrl =
      'easycris-remote://join?host=127.0.0.1:49152&session=session-1&token=invite-token'
    act(() => {
      useRemoteJoinUrlStore.getState().setPendingUrl(pendingUrl)
      useRemoteJoinUrlStore.getState().hideDialog()
    })

    render(<RemoteSessionJoinView />)

    await waitFor(() =>
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'session-1'
      )
    )
    fireEvent.change(screen.getByTestId('remote-join-session-id'), {
      target: { value: 'manual-change' },
    })

    act(() => {
      useRemoteJoinUrlStore.getState().setPendingUrl(pendingUrl)
      useRemoteJoinUrlStore.getState().hideDialog()
    })

    await waitFor(() =>
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'session-1'
      )
    )
  })
})
