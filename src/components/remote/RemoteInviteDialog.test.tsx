import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useRemoteJoinUrlStore } from '@/store/remote-join-url-store'
import { useUIStore } from '@/store/ui-store'
import { getCloudRemoteInviteMetadata } from '@/services/remoteSessionService'
import { RemoteInviteDialog } from './RemoteInviteDialog'

const { mockHostClose, mockJoin } = vi.hoisted(() => ({
  mockHostClose: vi.fn().mockResolvedValue(undefined),
  mockJoin: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

vi.mock('@/services/remoteWebRtcClient', () => ({
  remoteWebRtcClient: {
    join: mockJoin,
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
}))

vi.mock('@/store/deviceAuthStore', () => ({
  useDeviceAuthStore: () => ({
    linkedEmail: null,
    deviceId: 'guest-device',
    deviceFingerprint: 'guest-fingerprint',
  }),
}))

describe('RemoteInviteDialog', () => {
  beforeEach(() => {
    mockHostClose.mockClear()
    mockHostClose.mockResolvedValue(undefined)
    mockJoin.mockClear()
    mockJoin.mockResolvedValue(undefined)
    vi.mocked(getCloudRemoteInviteMetadata).mockReset()
    useRemoteJoinUrlStore.setState({ dialogOpen: false, pendingUrl: null })
    useUIStore.setState({
      activePreferencesPane: 'account',
      preferencesOpen: false,
    })
  })

  it('shows LAN invite details from a pending protocol URL', () => {
    useRemoteJoinUrlStore
      .getState()
      .setPendingUrl(
        'easycris-remote://join?host=127.0.0.1:7743&session=session-1&token=secret-token'
      )

    render(<RemoteInviteDialog />)

    expect(screen.getByTestId('remote-invite-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('remote-invite-dialog-host')).toHaveTextContent(
      '127.0.0.1:7743'
    )
    expect(
      screen.getByTestId('remote-invite-dialog-session-id')
    ).toHaveTextContent('session-1')
    expect(screen.getByTestId('remote-invite-dialog-token')).toHaveValue(
      'secret-token'
    )
  })

  it('opens Remote settings without clearing the pending invite', () => {
    useRemoteJoinUrlStore
      .getState()
      .setPendingUrl(
        'easycris-remote://join?host=127.0.0.1:7743&session=session-1&token=secret-token'
      )

    render(<RemoteInviteDialog />)

    fireEvent.click(screen.getByTestId('remote-invite-edit-settings'))

    expect(useUIStore.getState()).toMatchObject({
      activePreferencesPane: 'remote',
      preferencesOpen: true,
    })
    expect(useRemoteJoinUrlStore.getState()).toMatchObject({
      dialogOpen: false,
      pendingUrl:
        'easycris-remote://join?host=127.0.0.1:7743&session=session-1&token=secret-token',
    })
  })

  it('joins a LAN invite and clears it after a successful join', async () => {
    useRemoteJoinUrlStore
      .getState()
      .setPendingUrl(
        'easycris-remote://join?host=127.0.0.1:7743&session=session-1&token=secret-token'
      )

    render(<RemoteInviteDialog />)

    fireEvent.click(screen.getByTestId('remote-invite-join'))

    await waitFor(() => expect(mockJoin).toHaveBeenCalledTimes(1))
    expect(mockJoin).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: '7743',
      sessionId: 'session-1',
      token: 'secret-token',
      identity: expect.objectContaining({
        deviceId: 'guest-device',
        displayName: 'Device finger',
      }),
    })
    await waitFor(() =>
      expect(useRemoteJoinUrlStore.getState()).toMatchObject({
        dialogOpen: false,
        pendingUrl: null,
      })
    )
  })

  it('closes any stale host session before joining from the invite dialog', async () => {
    useRemoteJoinUrlStore
      .getState()
      .setPendingUrl(
        'easycris-remote://join?host=127.0.0.1:7743&session=session-1&token=secret-token'
      )

    render(<RemoteInviteDialog />)

    fireEvent.click(screen.getByTestId('remote-invite-join'))

    await waitFor(() => expect(mockJoin).toHaveBeenCalledTimes(1))
    expect(mockHostClose).toHaveBeenCalledWith(false)
    const [hostCloseCallOrder] = mockHostClose.mock.invocationCallOrder
    const [joinCallOrder] = mockJoin.mock.invocationCallOrder
    expect(hostCloseCallOrder).toBeDefined()
    expect(joinCallOrder).toBeDefined()
    expect(hostCloseCallOrder!).toBeLessThan(joinCallOrder!)
  })

  it('shows cloud invite details from a pending protocol URL', () => {
    useRemoteJoinUrlStore
      .getState()
      .setPendingUrl(
        'easycris-remote://join?mode=cloud&invite=rmt_cloud&token=guest-token'
      )

    render(<RemoteInviteDialog />)

    expect(screen.getByTestId('remote-invite-dialog-host')).toHaveTextContent(
      'Different network'
    )
    expect(
      screen.getByTestId('remote-invite-dialog-session-id')
    ).toHaveTextContent('rmt_cloud')
    expect(screen.getByTestId('remote-invite-dialog-token')).toHaveValue(
      'guest-token'
    )
  })

  it('joins a cloud invite using relay metadata', async () => {
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

    render(<RemoteInviteDialog />)

    fireEvent.click(screen.getByTestId('remote-invite-join'))

    await waitFor(() => expect(mockJoin).toHaveBeenCalledTimes(1))
    expect(getCloudRemoteInviteMetadata).toHaveBeenCalledWith('rmt_cloud')
    expect(mockJoin).toHaveBeenCalledWith({
      mode: 'cloud',
      inviteId: 'rmt_cloud',
      relayUrl: 'wss://relay.easycris.test/ws',
      token: 'guest-token',
      forceRelay: false,
      identity: expect.objectContaining({
        deviceId: 'guest-device',
        displayName: 'Device finger',
      }),
    })
  })

  it('keeps the invite open when joining fails', async () => {
    mockJoin.mockRejectedValueOnce(new Error('Session unavailable'))
    useRemoteJoinUrlStore
      .getState()
      .setPendingUrl(
        'easycris-remote://join?host=127.0.0.1:7743&session=session-1&token=secret-token'
      )

    render(<RemoteInviteDialog />)

    fireEvent.click(screen.getByTestId('remote-invite-join'))

    await waitFor(() => expect(mockJoin).toHaveBeenCalledTimes(1))
    expect(toast.error).toHaveBeenCalledWith('Session unavailable')
    await waitFor(() =>
      expect(screen.getByTestId('remote-invite-dialog-error')).toHaveTextContent(
        'Session unavailable'
      )
    )
    expect(useRemoteJoinUrlStore.getState()).toMatchObject({
      dialogOpen: true,
      pendingUrl:
        'easycris-remote://join?host=127.0.0.1:7743&session=session-1&token=secret-token',
    })
  })

  it('shows malformed invite errors and disables join', () => {
    useRemoteJoinUrlStore
      .getState()
      .setPendingUrl('easycris-remote://join?host=127.0.0.1:7743')

    render(<RemoteInviteDialog />)

    expect(screen.getByTestId('remote-invite-dialog-error')).toHaveTextContent(
      /missing host, port, session, or token/i
    )
    expect(screen.getByTestId('remote-invite-join')).toBeDisabled()
  })
})
