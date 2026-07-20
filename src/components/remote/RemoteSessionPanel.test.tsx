import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRemoteJoinUrlStore } from '@/store/remote-join-url-store'
import { getCloudRemoteInviteMetadata } from '@/services/remoteSessionService'
import { toast } from 'sonner'
import { RemoteSessionPanel } from './RemoteSessionPanel'

const {
  mockGetActiveCloudHostSecret,
  mockApproveGuest,
  mockRemoteClose,
  mockRemoteConnect,
  mockRemoteDisableAudio,
  mockRemoteEnableAudio,
  mockRemoteGetAudioDiagnostics,
  mockRemoteSetAudioInputDevice,
  mockRemoteSetAudioMuted,
  mockRemoteStartViewOnlyOffer,
  mockGuestAttach,
  mockGuestClose,
  mockGuestJoin,
  mockRejectGuest,
  mockRevoke,
  mockSetAudioState,
  mockSetPreferencesOpen,
  mockStartHosting,
  mockStopHosting,
  refreshStatus,
  remoteStoreState,
} = vi.hoisted(() => ({
  mockGetActiveCloudHostSecret: vi.fn(() => 'host-secret'),
  mockApproveGuest: vi.fn().mockResolvedValue(undefined),
  mockRemoteClose: vi.fn().mockResolvedValue(undefined),
  mockRemoteConnect: vi.fn().mockResolvedValue(undefined),
  mockRemoteDisableAudio: vi.fn().mockResolvedValue(undefined),
  mockRemoteEnableAudio: vi.fn().mockResolvedValue(undefined),
  mockRemoteGetAudioDiagnostics: vi.fn<() => Record<string, unknown>>(() => ({
    audioTransceiverCreated: false,
  })),
  mockRemoteSetAudioInputDevice: vi.fn().mockResolvedValue(undefined),
  mockRemoteSetAudioMuted: vi.fn().mockResolvedValue(undefined),
  mockRemoteStartViewOnlyOffer: vi.fn().mockResolvedValue(undefined),
  mockGuestAttach: vi.fn(),
  mockGuestClose: vi.fn(),
  mockGuestJoin: vi.fn().mockResolvedValue(undefined),
  mockRejectGuest: vi.fn().mockResolvedValue(undefined),
  mockRevoke: vi.fn().mockResolvedValue(undefined),
  mockSetAudioState: vi.fn((patch: Record<string, unknown>) => {
    Object.assign(remoteStoreState.audioState, patch)
  }),
  mockSetPreferencesOpen: vi.fn(),
  mockStartHosting: vi.fn((_identity: unknown, mode = 'lan') =>
    Promise.resolve({
      share_url:
        mode === 'cloud'
          ? 'https://remote.easycris.test/join/rmt_cloud#token=guest-token'
          : 'easycris-remote://join?host=127.0.0.1:1',
    })
  ),
  mockStopHosting: vi.fn().mockResolvedValue(undefined),
  refreshStatus: vi.fn().mockResolvedValue(undefined),
  remoteStoreState: {
    status: null,
    invite: null,
    pendingGuest: null,
    approvedGuest: null,
    error: null,
    audioState: {
      localEnabled: false,
      localMuted: false,
      remotePlaybackEnabled: false,
      connecting: false,
    },
    isBusy: false,
  },
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock('@/services/remoteWebRtcHost', () => ({
  remoteWebRtcHost: {
    close: mockRemoteClose,
    connect: mockRemoteConnect,
    disableAudio: mockRemoteDisableAudio,
    enableAudio: mockRemoteEnableAudio,
    getAudioDiagnostics: mockRemoteGetAudioDiagnostics,
    rejectGuest: vi.fn(),
    setAudioInputDevice: mockRemoteSetAudioInputDevice,
    setAudioMuted: mockRemoteSetAudioMuted,
    startViewOnlyOffer: mockRemoteStartViewOnlyOffer,
  },
}))

vi.mock('@/services/remoteWebRtcClient', () => ({
  remoteWebRtcClient: {
    attach: mockGuestAttach,
    close: mockGuestClose,
    detach: vi.fn(),
    join: mockGuestJoin,
  },
}))

vi.mock('@/services/remoteSessionService', () => ({
  getActiveCloudHostSecret: mockGetActiveCloudHostSecret,
  getCloudRemoteInviteMetadata: vi.fn(),
  remoteForceRelayEnabled: false,
}))

vi.mock('@/store/deviceAuthStore', () => ({
  useDeviceAuthStore: () => ({
    linkedEmail: null,
    deviceId: 'host-device',
    deviceFingerprint: 'host-fingerprint',
  }),
}))

vi.mock('@/store/remote-session-store', () => ({
  useRemoteSessionStore: () => ({
    ...remoteStoreState,
    startHosting: mockStartHosting,
    stopHosting: mockStopHosting,
    refreshStatus,
    approveGuest: mockApproveGuest,
    rejectGuest: mockRejectGuest,
    revoke: mockRevoke,
    clearError: vi.fn(),
    setAudioState: mockSetAudioState,
    setIdleWarning: vi.fn(),
  }),
}))

vi.mock('@/store/ui-store', () => ({
  useUIStore: {
    getState: () => ({
      setPreferencesOpen: mockSetPreferencesOpen,
    }),
  },
}))

const lanInvite = {
  session_id: 'session-1',
  invite_token: 'invite-token',
  share_url:
    'easycris-remote://join?host=127.0.0.1:49152&session=session-1&token=invite-token',
  signaling_port: 49152,
  host_candidates: [],
  mode: 'lan',
  expires_at_unix_ms: 1,
}

describe('RemoteSessionPanel', () => {
  beforeEach(() => {
    mockGetActiveCloudHostSecret.mockClear()
    mockGetActiveCloudHostSecret.mockReturnValue('host-secret')
    vi.mocked(getCloudRemoteInviteMetadata).mockReset()
    mockApproveGuest.mockClear()
    mockApproveGuest.mockResolvedValue(undefined)
    mockRemoteClose.mockClear()
    mockRemoteConnect.mockClear()
    mockRemoteDisableAudio.mockClear()
    mockRemoteDisableAudio.mockResolvedValue(undefined)
    mockRemoteEnableAudio.mockClear()
    mockRemoteEnableAudio.mockResolvedValue(undefined)
    mockRemoteGetAudioDiagnostics.mockClear()
    mockRemoteGetAudioDiagnostics.mockReturnValue({
      audioTransceiverCreated: false,
    })
    mockRemoteSetAudioInputDevice.mockClear()
    mockRemoteSetAudioInputDevice.mockResolvedValue(undefined)
    mockRemoteSetAudioMuted.mockClear()
    mockRemoteSetAudioMuted.mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
      () => undefined
    )
    mockRemoteStartViewOnlyOffer.mockClear()
    mockRemoteStartViewOnlyOffer.mockResolvedValue(undefined)
    mockGuestAttach.mockClear()
    mockGuestClose.mockClear()
    mockGuestJoin.mockClear()
    mockGuestJoin.mockResolvedValue(undefined)
    mockRejectGuest.mockClear()
    mockRejectGuest.mockResolvedValue(undefined)
    mockRevoke.mockClear()
    mockStartHosting.mockClear()
    mockStopHosting.mockClear()
    refreshStatus.mockClear()
    Object.assign(remoteStoreState, {
      status: null,
      invite: null,
      pendingGuest: null,
      approvedGuest: null,
      error: null,
      audioState: {
        localEnabled: false,
        localMuted: false,
        remotePlaybackEnabled: false,
        connecting: false,
      },
      isBusy: false,
    })
    mockSetAudioState.mockClear()
    mockSetPreferencesOpen.mockClear()
    useRemoteJoinUrlStore.setState({ dialogOpen: false, pendingUrl: null })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    })
  })

  it('keeps the join setup available for an invite being edited while hosting', async () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'host-session',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: ['192.168.1.10:49152'],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          status: 'connected',
          can_control: true,
        },
        pending_guest: null,
        approved_guest: null,
        approved_control: false,
      },
      invite: lanInvite,
    })
    useRemoteJoinUrlStore
      .getState()
      .setPendingUrl(
        'easycris-remote://join?host=127.0.0.1:7743&session=session-1&token=secret-token'
      )
    useRemoteJoinUrlStore.getState().hideDialog()

    render(<RemoteSessionPanel />)

    await waitFor(() =>
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'session-1'
      )
    )
    expect(screen.getByTestId('remote-join-host')).toHaveValue('127.0.0.1')
    expect(screen.getByTestId('remote-join-port')).toHaveValue('7743')
    expect(screen.getByTestId('remote-join-token')).toHaveValue('secret-token')
  })

  it('keeps invite-unlocked join setup visible while the user edits through a host session refresh', async () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'host-session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: ['192.168.1.10:49152'],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          status: 'connected',
          can_control: true,
        },
        pending_guest: null,
        approved_guest: null,
        approved_control: false,
      },
      invite: lanInvite,
    })
    useRemoteJoinUrlStore
      .getState()
      .setPendingUrl(
        'easycris-remote://join?host=127.0.0.1:7743&session=session-guest&token=secret-token'
      )
    useRemoteJoinUrlStore.getState().hideDialog()

    const { rerender } = render(<RemoteSessionPanel />)

    await waitFor(() =>
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'session-guest'
      )
    )
    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBeNull()

    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'host-session-2',
          invite_token_preview: 'efgh',
          signaling_port: 49153,
          host_candidates: ['192.168.1.10:49153'],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          status: 'connected',
          can_control: true,
        },
        pending_guest: null,
        approved_guest: null,
        approved_control: false,
      },
      invite: {
        ...lanInvite,
        session_id: 'host-session-2',
        signaling_port: 49153,
      },
    })

    rerender(<RemoteSessionPanel />)

    await waitFor(() =>
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'session-guest'
      )
    )
  })

  it('hides invite-unlocked join setup after the guest join starts successfully', async () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'host-session',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: ['192.168.1.10:49152'],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          status: 'connected',
          can_control: true,
        },
        pending_guest: null,
        approved_guest: null,
        approved_control: false,
      },
      invite: lanInvite,
    })
    useRemoteJoinUrlStore
      .getState()
      .setPendingUrl(
        'easycris-remote://join?host=127.0.0.1:7743&session=session-guest&token=secret-token'
      )
    useRemoteJoinUrlStore.getState().hideDialog()

    render(<RemoteSessionPanel />)

    await waitFor(() =>
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'session-guest'
      )
    )

    fireEvent.click(screen.getByTestId('remote-join-session'))

    await waitFor(() => expect(mockGuestJoin).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.queryByTestId('remote-join-session-id')).toBeNull()
    )
  })

  it('closes Preferences after the host successfully approves a guest and starts sharing', async () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: ['192.168.1.10:49152'],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'pending_approval',
          can_control: true,
        },
        pending_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_guest: null,
        approved_control: false,
      },
      invite: lanInvite,
      pendingGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
    })

    render(<RemoteSessionPanel />)
    fireEvent.click(screen.getByTestId('remote-approve-guest'))

    await waitFor(() =>
      expect(mockRemoteStartViewOnlyOffer).toHaveBeenCalledWith('guest-device')
    )
    expect(mockSetPreferencesOpen).toHaveBeenCalledWith(false)
  })

  it('does not show a browser sharing-prompt instruction during native approval startup', async () => {
    let resolveOffer: (() => void) | null = null
    mockRemoteStartViewOnlyOffer.mockReturnValueOnce(
      new Promise<void>(resolve => {
        resolveOffer = resolve
      })
    )
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: ['192.168.1.10:49152'],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'pending_approval',
          can_control: true,
        },
        pending_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_guest: null,
        approved_control: false,
      },
      invite: lanInvite,
      pendingGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
    })

    render(<RemoteSessionPanel />)
    fireEvent.click(screen.getByTestId('remote-approve-guest'))

    await waitFor(() => expect(mockApproveGuest).toHaveBeenCalled())
    expect(screen.queryByText(/sharing prompt/i)).not.toBeInTheDocument()
    await act(async () => {
      resolveOffer?.()
      await Promise.resolve()
    })
  })

  it('prevents duplicate approve and reject actions while approval is starting', async () => {
    let resolveApprove: (() => void) | null = null
    mockApproveGuest.mockReturnValueOnce(
      new Promise<void>(resolve => {
        resolveApprove = resolve
      })
    )
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: ['192.168.1.10:49152'],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'pending_approval',
          can_control: true,
        },
        pending_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_guest: null,
        approved_control: false,
      },
      invite: lanInvite,
      pendingGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
    })

    render(<RemoteSessionPanel />)
    const approveButton = screen.getByTestId('remote-approve-guest')
    const rejectButton = screen.getByTestId('remote-reject-guest')
    fireEvent.click(approveButton)
    fireEvent.click(approveButton)

    await waitFor(() => expect(mockApproveGuest).toHaveBeenCalledTimes(1))
    expect(approveButton).toBeDisabled()
    expect(rejectButton).toBeDisabled()
    await act(async () => {
      resolveApprove?.()
      await Promise.resolve()
    })
  })

  it('shows pending guest approval before the invite details', () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: ['192.168.1.10:49152'],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'pending_approval',
          can_control: true,
        },
        pending_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_guest: null,
        approved_control: false,
      },
      invite: lanInvite,
      pendingGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
    })

    render(<RemoteSessionPanel />)

    const approveButton = screen.getByTestId('remote-approve-guest')
    expect(approveButton).toHaveTextContent('Approve guest')
    const inviteLink = screen.getByTestId('remote-invite-link')
    expect(
      approveButton.compareDocumentPosition(inviteLink) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('asks how the host will share before starting a remote session', async () => {
    render(<RemoteSessionPanel />)

    expect(screen.queryByTestId('remote-host-mode-lan')).toBeNull()
    expect(screen.queryByTestId('remote-host-mode-internet')).toBeNull()
    expect(screen.queryByTestId('remote-guest-mode-lan')).toBeNull()
    expect(screen.queryByTestId('remote-guest-mode-internet')).toBeNull()
    expect(
      screen.getByText(/start a session for a trusted guest/i)
    ).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('remote-start-session'))

    expect(screen.getByTestId('remote-host-mode-dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('remote-host-mode-different-network'))

    await waitFor(() =>
      expect(mockStartHosting).toHaveBeenCalledWith(
        expect.objectContaining({ device_id: 'host-device' }),
        'cloud'
      )
    )
  })

  it('closes any stale guest connection before starting a host session', async () => {
    render(<RemoteSessionPanel />)

    fireEvent.click(screen.getByTestId('remote-start-session'))
    fireEvent.click(screen.getByTestId('remote-host-mode-different-network'))

    await waitFor(() => expect(mockStartHosting).toHaveBeenCalled())
    expect(mockGuestClose).toHaveBeenCalledTimes(1)
    const [guestCloseCallOrder] = mockGuestClose.mock.invocationCallOrder
    const [startHostingCallOrder] = mockStartHosting.mock.invocationCallOrder
    expect(guestCloseCallOrder).toBeDefined()
    expect(startHostingCallOrder).toBeDefined()
    expect(guestCloseCallOrder!).toBeLessThan(startHostingCallOrder!)
  })

  it('dismisses the host connection dialog without starting a session', async () => {
    render(<RemoteSessionPanel />)

    fireEvent.click(screen.getByTestId('remote-start-session'))
    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByTestId('remote-host-mode-dialog')).toBeNull()
    )
    expect(mockStartHosting).not.toHaveBeenCalled()
    expect(screen.getByTestId('remote-start-session')).toBeEnabled()
  })

  it('disables host start while the remote store is busy', () => {
    Object.assign(remoteStoreState, { isBusy: true })

    render(<RemoteSessionPanel />)

    expect(screen.getByTestId('remote-start-session')).toBeDisabled()
  })

  it('starts same-wifi hosting from the connection dialog', async () => {
    render(<RemoteSessionPanel />)

    fireEvent.click(screen.getByTestId('remote-start-session'))
    fireEvent.click(screen.getByTestId('remote-host-mode-same-wifi'))

    await waitFor(() =>
      expect(mockStartHosting).toHaveBeenCalledWith(
        expect.objectContaining({ device_id: 'host-device' }),
        'lan'
      )
    )
  })

  it('notifies a cloud guest if approval fails for an active cloud session', async () => {
    mockRemoteStartViewOnlyOffer.mockRejectedValueOnce(
      new DOMException('blocked', 'NotAllowedError')
    )
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'rmt_cloud',
          invite_token_preview: 'gues',
          signaling_port: null,
          host_candidates: [],
          mode: 'cloud',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'pending_approval',
          can_control: true,
        },
        pending_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_guest: null,
        approved_control: false,
      },
      pendingGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      invite: null,
    })

    render(<RemoteSessionPanel />)
    fireEvent.click(screen.getByTestId('remote-approve-guest'))

    await waitFor(() => expect(mockRevoke).toHaveBeenCalled())
    await waitFor(() => expect(mockRemoteClose).toHaveBeenCalledWith(true))
  })

  it('closes the cloud peer before revoking after an approved offer fails', async () => {
    const order: string[] = []
    mockRemoteStartViewOnlyOffer.mockRejectedValueOnce(
      new Error('native capture failed')
    )
    mockRemoteClose.mockImplementation(async () => {
      order.push('close')
    })
    mockRevoke.mockImplementation(async () => {
      order.push('revoke')
    })
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'rmt_cloud',
          invite_token_preview: 'gues',
          signaling_port: null,
          host_candidates: [],
          mode: 'cloud',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'pending_approval',
          can_control: true,
        },
        pending_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_guest: null,
        approved_control: false,
      },
      pendingGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      invite: null,
    })

    render(<RemoteSessionPanel />)
    fireEvent.click(screen.getByTestId('remote-approve-guest'))

    await waitFor(() => expect(mockRevoke).toHaveBeenCalled())
    expect(mockRevoke).toHaveBeenCalledWith()
    expect(mockRemoteClose).toHaveBeenCalledWith(true)
    expect(order).toEqual(['close', 'revoke'])
  })

  it('shows the active connection mode for a running host session', () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'rmt_cloud',
          invite_token_preview: 'gues',
          signaling_port: null,
          host_candidates: [],
          mode: 'cloud',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: null,
          guest_device_id: null,
          status: 'connected',
          can_control: true,
        },
        pending_guest: null,
        approved_guest: null,
        approved_control: false,
      },
      invite: null,
    })

    render(<RemoteSessionPanel />)

    expect(screen.getByTestId('remote-active-mode')).toHaveTextContent(
      'Different network'
    )
  })

  it('infers guest same-wifi mode from the pasted invite link', async () => {
    render(<RemoteSessionPanel />)

    fireEvent.change(screen.getByTestId('remote-join-invite'), {
      target: {
        value:
          'easycris-remote://join?host=127.0.0.1:49152&session=session-1&token=invite-token',
      },
    })
    fireEvent.click(screen.getByTestId('remote-parse-invite'))

    await waitFor(() => {
      expect(screen.getByTestId('remote-join-host')).toHaveValue('127.0.0.1')
      expect(screen.getByTestId('remote-join-port')).toHaveValue('49152')
      expect(screen.getByTestId('remote-join-session-id')).toHaveValue(
        'session-1'
      )
      expect(screen.getByTestId('remote-join-token')).toHaveValue(
        'invite-token'
      )
      expect(screen.getByTestId('remote-join-session')).toBeEnabled()
    })
  })

  it('infers guest cloud mode from the pasted invite link', async () => {
    vi.mocked(getCloudRemoteInviteMetadata).mockResolvedValueOnce({
      invite_id: 'rmt_cloud',
      relay_url: 'wss://relay.easycris.test/ws',
      expires_at_unix_ms: 9_999_999_999_999,
      status: 'listening',
    })

    render(<RemoteSessionPanel />)

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
      expect(screen.getByTestId('remote-join-token')).toHaveValue(
        'guest-token'
      )
      expect(screen.getByTestId('remote-join-session')).toBeEnabled()
    })
    expect(getCloudRemoteInviteMetadata).toHaveBeenCalledWith('rmt_cloud')
  })

  it('can clear manual join fields without a visible mode toggle', async () => {
    render(<RemoteSessionPanel />)

    expect(screen.queryByTestId('remote-guest-mode-internet')).toBeNull()
    fireEvent.change(screen.getByTestId('remote-join-invite'), {
      target: { value: 'easycris-remote://join?host=127.0.0.1:1' },
    })
    fireEvent.change(screen.getByTestId('remote-join-host'), {
      target: { value: '127.0.0.1' },
    })
    fireEvent.change(screen.getByTestId('remote-join-port'), {
      target: { value: '49152' },
    })
    fireEvent.change(screen.getByTestId('remote-join-session-id'), {
      target: { value: 'session-id' },
    })
    fireEvent.change(screen.getByTestId('remote-join-token'), {
      target: { value: 'token' },
    })

    fireEvent.click(screen.getByTestId('remote-clear-join-fields'))

    expect(screen.getByTestId('remote-join-invite')).toHaveValue('')
    expect(screen.getByTestId('remote-join-host')).toHaveValue('')
    expect(screen.getByTestId('remote-join-port')).toHaveValue('')
    expect(screen.getByTestId('remote-join-session-id')).toHaveValue('')
    expect(screen.getByTestId('remote-join-token')).toHaveValue('')
    expect(screen.getByTestId('remote-join-session')).toBeDisabled()

    await waitFor(() => expect(refreshStatus).toHaveBeenCalled())
  })

  it('shows copy-first invite details with manual fallback credentials', () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'invi',
          signaling_port: 49152,
          host_candidates: ['127.0.0.1:49152'],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: null,
          guest_device_id: null,
          status: 'listening',
          can_control: false,
        },
        pending_guest: null,
        approved_guest: null,
        approved_control: false,
      },
      invite: {
        ...lanInvite,
        expires_at_unix_ms: Date.now() + 180_000,
      },
    })

    render(<RemoteSessionPanel />)

    expect(screen.getByTestId('remote-copy-invite')).toBeInTheDocument()
    expect(screen.getByTestId('remote-invite-link')).toHaveTextContent(
      lanInvite.share_url
    )
    expect(screen.getByTestId('remote-invite-session-id')).toHaveTextContent(
      'session-1'
    )
    expect(screen.getByTestId('remote-invite-password')).toHaveTextContent(
      'invi••••'
    )
    expect(screen.getByTestId('remote-invite-host')).toHaveTextContent(
      '127.0.0.1:49152'
    )
    expect(screen.getByTestId('remote-invite-expiry')).toHaveTextContent(
      /expires in/i
    )
  })

  it('notifies the cloud relay when stopping a cloud session before approval', async () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'rmt_cloud',
          invite_token_preview: 'gues',
          signaling_port: null,
          host_candidates: [],
          mode: 'cloud',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: null,
          guest_device_id: null,
          status: 'listening',
          can_control: false,
        },
        pending_guest: null,
        approved_guest: null,
        approved_control: false,
      },
      approvedGuest: null,
      invite: {
        session_id: 'rmt_cloud',
        invite_token: 'guest-token',
        share_url: 'https://remote.easycris.com/join/rmt_cloud#token=guest-token',
        signaling_port: null,
        host_candidates: [],
        mode: 'cloud',
        relay_url: 'wss://remote.easycris.com/v1/remote/signaling',
        invite_id: 'rmt_cloud',
        expires_at_unix_ms: 1,
      },
    })

    render(<RemoteSessionPanel />)
    fireEvent.click(screen.getByTestId('remote-stop-session'))

    await waitFor(() => expect(mockRemoteClose).toHaveBeenCalledWith(true))
    expect(mockStopHosting).toHaveBeenCalled()
  })

  it('surfaces stop-session failures to the host', async () => {
    mockRemoteClose.mockRejectedValueOnce(new Error('stop failed'))
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: ['127.0.0.1:49152'],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: null,
          guest_device_id: null,
          status: 'listening',
          can_control: false,
        },
        pending_guest: null,
        approved_guest: null,
        approved_control: false,
      },
      invite: { ...lanInvite },
    })

    render(<RemoteSessionPanel />)
    fireEvent.click(screen.getByTestId('remote-stop-session'))

    expect(await screen.findByText('stop failed')).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith('stop failed')
  })

  it('does not show the guest join/viewer surface while this app is hosting an active session', () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'invi',
          signaling_port: 49152,
          host_candidates: ['127.0.0.1:49152'],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'connected',
          can_control: true,
        },
        pending_guest: null,
        approved_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_control: true,
      },
      approvedGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
    })

    render(<RemoteSessionPanel />)

    expect(screen.queryByTestId('remote-join-session')).toBeNull()
    expect(screen.queryByTestId('remote-viewer-shell')).toBeNull()
    expect(
      screen.queryByText(/you are the guest\. this is the host display/i)
    ).not.toBeInTheDocument()
  })

  it('notifies the cloud guest before clearing local revoke state', async () => {
    const order: string[] = []
    mockRemoteClose.mockImplementation(async () => {
      order.push('close')
    })
    mockRevoke.mockImplementation(async () => {
      order.push('revoke')
    })
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'rmt_abc',
          invite_token_preview: 'abcd',
          signaling_port: null,
          host_candidates: [],
          mode: 'cloud',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'connected',
          can_control: true,
        },
        pending_guest: null,
        approved_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_control: true,
      },
      invite: {
        session_id: 'rmt_abc',
        invite_token: 'guest-token',
        share_url: 'https://remote.easycris.com/join/rmt_abc#token=guest-token',
        signaling_port: null,
        host_candidates: [],
        mode: 'cloud',
        relay_url: 'wss://remote.easycris.com/v1/remote/signaling',
        invite_id: 'rmt_abc',
        expires_at_unix_ms: 1,
      },
      approvedGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
    })

    render(<RemoteSessionPanel />)

    fireEvent.click(screen.getByTestId('remote-revoke-control'))

    await waitFor(() => expect(mockRevoke).toHaveBeenCalled())
    expect(mockRemoteClose).toHaveBeenCalledWith(true)
    expect(order).toEqual(['close', 'revoke'])
  })

  it('shows the host security code reported by the WebRTC session', async () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: [],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'connected',
          can_control: true,
        },
        pending_guest: null,
        approved_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_control: true,
      },
      approvedGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      invite: { ...lanInvite },
    })

    render(<RemoteSessionPanel />)

    await waitFor(() => expect(mockRemoteConnect).toHaveBeenCalled())
    expect(mockRemoteConnect).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'invite-token' })
    )
    const callbacks = mockRemoteConnect.mock.calls[0]?.[0]?.callbacks
    expect(callbacks).toBeDefined()
    act(() => {
      callbacks.onSecurityCode('1234-ABCD-EF90')
    })

    expect(screen.getByTestId('remote-host-security-code')).toHaveTextContent(
      '1234-ABCD-EF90'
    )
    expect(screen.getByText(/compare with guest/i)).toBeInTheDocument()
  })

  it('clears the host security code when the WebRTC session reports no code', async () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: [],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'connected',
          can_control: true,
        },
        pending_guest: null,
        approved_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_control: true,
      },
      approvedGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      invite: { ...lanInvite },
    })

    render(<RemoteSessionPanel />)

    await waitFor(() => expect(mockRemoteConnect).toHaveBeenCalled())
    const callbacks = mockRemoteConnect.mock.calls[0]?.[0]?.callbacks
    expect(callbacks).toBeDefined()
    act(() => {
      callbacks.onSecurityCode('1234-ABCD-EF90')
    })
    expect(screen.getByTestId('remote-host-security-code')).toBeInTheDocument()

    act(() => {
      callbacks.onSecurityCode(null)
    })

    expect(
      screen.queryByTestId('remote-host-security-code')
    ).not.toBeInTheDocument()
  })

  it('clears the host security code when the active session ends', async () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: [],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'connected',
          can_control: true,
        },
        pending_guest: null,
        approved_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_control: true,
      },
      approvedGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      invite: { ...lanInvite },
    })

    const { rerender } = render(<RemoteSessionPanel />)

    await waitFor(() => expect(mockRemoteConnect).toHaveBeenCalled())
    const callbacks = mockRemoteConnect.mock.calls[0]?.[0]?.callbacks
    expect(callbacks).toBeDefined()
    act(() => {
      callbacks.onSecurityCode('1234-ABCD-EF90')
    })
    expect(screen.getByTestId('remote-host-security-code')).toBeInTheDocument()

    Object.assign(remoteStoreState, {
      status: {
        current_session: null,
        pending_guest: null,
        approved_guest: null,
        approved_control: false,
      },
      approvedGuest: null,
    })
    rerender(<RemoteSessionPanel />)

    await waitFor(() =>
      expect(
        screen.queryByTestId('remote-host-security-code')
      ).not.toBeInTheDocument()
    )
  })

  it('shows user-facing host status messages', async () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: [],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'connected',
          can_control: true,
        },
        pending_guest: null,
        approved_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_control: true,
      },
      approvedGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      invite: { ...lanInvite },
    })

    render(<RemoteSessionPanel />)

    await waitFor(() => expect(mockRemoteConnect).toHaveBeenCalled())
    const callbacks = mockRemoteConnect.mock.calls[0]?.[0]?.callbacks
    expect(callbacks).toBeDefined()

    act(() => {
      callbacks.onStatus('Remote-session stream: connected: relay')
    })
    expect(
      screen.getByText('Remote display connection is connected: relay.')
    ).toBeInTheDocument()

    act(() => {
      callbacks.onStatus('Remote-session signaling socket closed')
    })
    expect(
      screen.queryByText('Remote display connection is connected: relay.')
    ).not.toBeInTheDocument()
    expect(screen.getByText('Remote connection closed.')).toBeInTheDocument()

    act(() => {
      callbacks.onStatus('Remote-session data channel open')
    })
    expect(screen.queryByText('Remote connection closed.')).not.toBeInTheDocument()
    expect(
      screen.getByText('Remote session data channel open')
    ).toBeInTheDocument()
  })

  it('clears the host security code when offer creation fails after approval', async () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: [],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: null,
          guest_device_id: null,
          status: 'pending_approval',
          can_control: false,
        },
        pending_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_guest: null,
        approved_control: false,
      },
      pendingGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      invite: { ...lanInvite },
    })

    render(<RemoteSessionPanel />)

    await waitFor(() => expect(mockRemoteConnect).toHaveBeenCalled())
    const callbacks = mockRemoteConnect.mock.calls[0]?.[0]?.callbacks
    expect(callbacks).toBeDefined()
    mockRemoteStartViewOnlyOffer.mockImplementation(async () => {
      callbacks.onSecurityCode('1234-ABCD-EF90')
      throw new Error('offer failed')
    })
    mockRemoteClose.mockRejectedValueOnce(new Error('close failed'))

    fireEvent.click(screen.getByTestId('remote-approve-guest'))

    await waitFor(() => expect(mockRevoke).toHaveBeenCalled())
    expect(
      screen.queryByTestId('remote-host-security-code')
    ).not.toBeInTheDocument()
  })

  it('keeps active host media controls out of the Preferences setup pane', async () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: [],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'connected',
          can_control: true,
        },
        pending_guest: null,
        approved_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_control: true,
      },
      approvedGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      invite: { ...lanInvite },
    })

    render(<RemoteSessionPanel />)

    expect(screen.queryByTestId('remote-host-audio-controls')).toBeNull()
    expect(screen.queryByTestId('remote-host-audio-output')).toBeNull()
  })

  it('does not expose a separate host voice-call request prompt after approval', async () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: [],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
          status: 'connected',
          can_control: true,
        },
        pending_guest: null,
        approved_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_control: true,
      },
      approvedGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      invite: { ...lanInvite },
    })

    render(<RemoteSessionPanel />)

    await waitFor(() => expect(mockRemoteConnect).toHaveBeenCalled())
    expect(
      screen.queryByTestId('remote-host-voice-call-request')
    ).not.toBeInTheDocument()
  })

  it('shows practical screen-sharing guidance when capture is unreadable', async () => {
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: [],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: null,
          guest_device_id: null,
          status: 'pending_approval',
          can_control: false,
        },
        pending_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_guest: null,
        approved_control: false,
      },
      pendingGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      invite: { ...lanInvite },
    })
    mockRemoteStartViewOnlyOffer.mockRejectedValueOnce(
      new DOMException('capture busy', 'NotReadableError')
    )

    render(<RemoteSessionPanel />)
    fireEvent.click(screen.getByTestId('remote-approve-guest'))

    expect(
      await screen.findByText(
        /Remote control could not start\. Another app may be blocking capture, or the easyCris window is unavailable\. Close conflicting apps and try again\./
      )
    ).toBeInTheDocument()
  })

  it('tells the host to update Windows or WebView2 when native capture is unsupported', async () => {
    const message =
      'Remote control is not available because this Windows/WebView2 runtime is too old. Update Windows or install the latest Microsoft Edge WebView2 Runtime, then try again.'
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: [],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: null,
          guest_device_id: null,
          status: 'pending_approval',
          can_control: false,
        },
        pending_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_guest: null,
        approved_control: false,
      },
      pendingGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      invite: { ...lanInvite },
    })
    mockApproveGuest.mockRejectedValueOnce(new Error(message))

    render(<RemoteSessionPanel />)
    fireEvent.click(screen.getByTestId('remote-approve-guest'))

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith(message)
  })

  it('surfaces reject failures to the host', async () => {
    mockRejectGuest.mockRejectedValueOnce(new Error('reject failed'))
    Object.assign(remoteStoreState, {
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
          signaling_port: 49152,
          host_candidates: [],
          mode: 'lan',
          host_display_name: 'Host',
          host_device_id: 'host-device',
          guest_display_name: null,
          guest_device_id: null,
          status: 'pending_approval',
          can_control: false,
        },
        pending_guest: {
          guest_display_name: 'Guest',
          guest_device_id: 'guest-device',
        },
        approved_guest: null,
        approved_control: false,
      },
      pendingGuest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      invite: { ...lanInvite },
    })

    render(<RemoteSessionPanel />)
    fireEvent.click(screen.getByTestId('remote-reject-guest'))

    expect(await screen.findByText('reject failed')).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith('reject failed')
  })

})
