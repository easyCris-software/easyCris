import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RemoteSessionInvite,
  RemoteSessionStatus,
} from '@/services/remoteSessionService'
import { useRemoteSessionStore } from './remote-session-store'
import {
  approveRemoteSessionGuest,
  getRemoteSessionStatus,
  rejectRemoteSessionGuest,
  revokeRemoteControl,
  startCloudRemoteSession,
  startRemoteSession,
  stopRemoteSession,
} from '@/services/remoteSessionService'

vi.mock('@/services/remoteSessionService', () => ({
  startRemoteSession: vi.fn(),
  stopRemoteSession: vi.fn(),
  getRemoteSessionStatus: vi.fn(),
  approveRemoteSessionGuest: vi.fn(),
  rejectRemoteSessionGuest: vi.fn(),
  revokeRemoteControl: vi.fn(),
  startCloudRemoteSession: vi.fn(),
  clearActiveCloudHostSecret: vi.fn(),
}))

const idleStatus: RemoteSessionStatus = {
  current_session: null,
  pending_guest: null,
  approved_guest: null,
  approved_control: false,
}

const listeningStatus: RemoteSessionStatus = {
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
}

const listeningSession = listeningStatus.current_session as NonNullable<
  RemoteSessionStatus['current_session']
>

const invite: RemoteSessionInvite = {
  session_id: 'session-1',
  invite_token: 'token',
  share_url:
    'easycris-remote://join?host=127.0.0.1&port=49152&session=session-1&token=token',
  signaling_port: 49152,
  host_candidates: ['127.0.0.1:49152'],
  mode: 'lan',
  expires_at_unix_ms: 1,
}

const cloudStatus: RemoteSessionStatus = {
  current_session: {
    ...listeningSession,
    signaling_port: null,
    host_candidates: [],
    mode: 'cloud',
  },
  pending_guest: null,
  approved_guest: null,
  approved_control: false,
}

const cloudInvite: RemoteSessionInvite = {
  session_id: 'session-cloud',
  invite_token: 'guest-token',
  share_url: 'https://remote.easycris.com/join/rmt_abc#token=guest-token',
  signaling_port: null,
  host_candidates: [],
  mode: 'cloud',
  relay_url: 'wss://remote.easycris.com/v1/remote/signaling',
  invite_id: 'rmt_abc',
  host_secret: 'host-secret',
  expires_at_unix_ms: 1,
}

describe('useRemoteSessionStore', () => {
  beforeEach(() => {
    vi.mocked(startRemoteSession).mockReset()
    vi.mocked(stopRemoteSession).mockReset()
    vi.mocked(getRemoteSessionStatus).mockReset()
    vi.mocked(approveRemoteSessionGuest).mockReset()
    vi.mocked(rejectRemoteSessionGuest).mockReset()
    vi.mocked(revokeRemoteControl).mockReset()
    vi.mocked(startCloudRemoteSession).mockReset()
    useRemoteSessionStore.setState({
      status: null,
      invite: null,
      pendingGuest: null,
      approvedGuest: null,
      error: null,
      sessionWarning: null,
      idleWarning: null,
      audioState: {
        localEnabled: false,
        localMuted: false,
        remotePlaybackEnabled: false,
        connecting: false,
      },
      isHost: false,
      isGuest: false,
      isBusy: false,
    })
  })

  it('stores invite and status after hosting starts', async () => {
    vi.mocked(startRemoteSession).mockResolvedValue({
      status: listeningStatus,
      invite,
    })

    await useRemoteSessionStore.getState().startHosting({
      display_name: 'Host',
      device_id: 'host-device',
      account_email: null,
      is_guest: true,
    })

    const state = useRemoteSessionStore.getState()
    expect(state.isHost).toBe(true)
    expect(state.invite?.share_url).toBe(invite.share_url)
    expect(state.invite?.mode).toBe('lan')
    expect(state.status?.current_session?.mode).toBe('lan')
    expect(state.status?.current_session?.session_id).toBe('session-1')
  })

  it('clears stale idle warning when hosting starts', async () => {
    vi.mocked(startRemoteSession).mockResolvedValue({
      status: listeningStatus,
      invite,
    })
    useRemoteSessionStore.getState().setIdleWarning({
      session_id: 'old-session',
      seconds_remaining: 60,
      expires_at_unix_ms: 456,
    })

    await useRemoteSessionStore.getState().startHosting({
      display_name: 'Host',
      device_id: 'host-device',
      account_email: null,
      is_guest: true,
    })

    expect(useRemoteSessionStore.getState().idleWarning).toBeNull()
  })

  it('clears stale audio state when hosting starts', async () => {
    vi.mocked(startRemoteSession).mockResolvedValue({
      status: listeningStatus,
      invite,
    })
    useRemoteSessionStore.getState().setAudioState({
      localEnabled: true,
      localMuted: true,
      remotePlaybackEnabled: true,
      connecting: true,
    })

    await useRemoteSessionStore.getState().startHosting({
      display_name: 'Host',
      device_id: 'host-device',
      account_email: null,
      is_guest: true,
    })

    expect(useRemoteSessionStore.getState().audioState).toEqual({
      localEnabled: false,
      localMuted: false,
      remotePlaybackEnabled: false,
      connecting: false,
    })
  })

  it('stores cloud invite skeleton fields when hosting starts in cloud mode', async () => {
    vi.mocked(startCloudRemoteSession).mockResolvedValue({
      status: cloudStatus,
      invite: { ...cloudInvite, host_secret: undefined },
    })

    await useRemoteSessionStore.getState().startHosting(
      {
        display_name: 'Host',
        device_id: 'host-device',
        account_email: null,
        is_guest: true,
      },
      'cloud'
    )

    const state = useRemoteSessionStore.getState()
    expect(state.invite?.mode).toBe('cloud')
    expect(state.invite?.signaling_port).toBeNull()
    expect(state.invite?.relay_url).toBe(
      'wss://remote.easycris.com/v1/remote/signaling'
    )
    expect(state.invite?.invite_id).toBe('rmt_abc')
    expect(state.invite?.host_secret).toBeUndefined()
    expect(state.status?.current_session?.mode).toBe('cloud')
  })

  it('stops the host session after revoke so a new session can start', async () => {
    const revokedStatus: RemoteSessionStatus = {
      ...listeningStatus,
      current_session: {
        ...listeningSession,
        status: 'revoked',
      },
    }
    vi.mocked(revokeRemoteControl).mockResolvedValue(revokedStatus)
    vi.mocked(stopRemoteSession).mockResolvedValue(idleStatus)
    useRemoteSessionStore.setState({
      status: listeningStatus,
      invite,
      isHost: true,
      audioState: {
        localEnabled: true,
        localMuted: true,
        remotePlaybackEnabled: true,
        connecting: false,
      },
    })

    await useRemoteSessionStore.getState().revoke()

    expect(revokeRemoteControl).toHaveBeenCalledWith('session-1')
    expect(stopRemoteSession).toHaveBeenCalled()
    expect(useRemoteSessionStore.getState().status?.current_session).toBeNull()
    expect(useRemoteSessionStore.getState().invite).toBeNull()
    expect(useRemoteSessionStore.getState().audioState).toEqual({
      localEnabled: false,
      localMuted: false,
      remotePlaybackEnabled: false,
      connecting: false,
    })
  })

  it('still stops the host session when revoke is already cleaned up', async () => {
    vi.mocked(revokeRemoteControl).mockRejectedValue(
      new Error('No active remote session')
    )
    vi.mocked(stopRemoteSession).mockResolvedValue(idleStatus)
    useRemoteSessionStore.setState({
      status: listeningStatus,
      invite,
      isHost: true,
    })

    await useRemoteSessionStore.getState().revoke()

    expect(revokeRemoteControl).toHaveBeenCalledWith('session-1')
    expect(stopRemoteSession).toHaveBeenCalled()
    expect(useRemoteSessionStore.getState().status?.current_session).toBeNull()
    expect(useRemoteSessionStore.getState().invite).toBeNull()
    expect(useRemoteSessionStore.getState().error).toBeNull()
  })

  it('shows an actionable listener error when hosting cannot start', async () => {
    vi.mocked(startRemoteSession).mockRejectedValue(
      new Error(
        'Failed to bind remote-session signaling server: address already in use'
      )
    )

    await expect(
      useRemoteSessionStore.getState().startHosting({
        display_name: 'Host',
        device_id: 'host-device',
        account_email: null,
        is_guest: true,
      })
    ).rejects.toThrow('Failed to bind remote-session signaling server')

    expect(useRemoteSessionStore.getState().error).toBe(
      'Could not start remote session. The local listening port is blocked or unavailable; check firewall/network settings and try again.'
    )
  })

  it('sends approval for the active pending guest', async () => {
    const connectedStatus: RemoteSessionStatus = {
      ...listeningStatus,
      approved_guest: {
        guest_display_name: 'Guest',
        guest_device_id: 'guest-device',
      },
      approved_control: true,
    }
    vi.mocked(approveRemoteSessionGuest).mockResolvedValue(connectedStatus)
    useRemoteSessionStore.setState({ status: listeningStatus })

    await useRemoteSessionStore.getState().approveGuest('guest-device')

    expect(approveRemoteSessionGuest).toHaveBeenCalledWith({
      session_id: 'session-1',
      guest_device_id: 'guest-device',
      can_control: true,
    })
    expect(
      useRemoteSessionStore.getState().approvedGuest?.guest_device_id
    ).toBe('guest-device')
  })

  it('clears host state when hosting stops', async () => {
    vi.mocked(stopRemoteSession).mockResolvedValue(idleStatus)
    useRemoteSessionStore.setState({
      status: listeningStatus,
      invite,
      isHost: true,
      sessionWarning: {
        session_id: 'session-1',
        seconds_remaining: 300,
        expires_at_unix_ms: Date.now() + 300_000,
      },
      idleWarning: {
        session_id: 'session-1',
        seconds_remaining: 60,
        expires_at_unix_ms: Date.now() + 60_000,
      },
      audioState: {
        localEnabled: true,
        localMuted: true,
        remotePlaybackEnabled: true,
        connecting: false,
      },
    })

    await useRemoteSessionStore.getState().stopHosting()

    const state = useRemoteSessionStore.getState()
    expect(state.isHost).toBe(false)
    expect(state.invite).toBeNull()
    expect(state.status?.current_session).toBeNull()
    expect(state.sessionWarning).toBeNull()
    expect(state.idleWarning).toBeNull()
    expect(state.audioState).toEqual({
      localEnabled: false,
      localMuted: false,
      remotePlaybackEnabled: false,
      connecting: false,
    })
  })

  it('preserves warning while refreshing the same active session', async () => {
    vi.mocked(getRemoteSessionStatus).mockResolvedValue(listeningStatus)
    useRemoteSessionStore.setState({
      status: listeningStatus,
      sessionWarning: {
        session_id: 'session-1',
        seconds_remaining: 300,
        expires_at_unix_ms: 123,
      },
      idleWarning: {
        session_id: 'session-1',
        seconds_remaining: 60,
        expires_at_unix_ms: 456,
      },
      audioState: {
        localEnabled: true,
        localMuted: false,
        remotePlaybackEnabled: true,
        connecting: false,
      },
    })

    await useRemoteSessionStore.getState().refreshStatus()

    expect(useRemoteSessionStore.getState().sessionWarning).toEqual({
      session_id: 'session-1',
      seconds_remaining: 300,
      expires_at_unix_ms: 123,
    })
    expect(useRemoteSessionStore.getState().idleWarning).toEqual({
      session_id: 'session-1',
      seconds_remaining: 60,
      expires_at_unix_ms: 456,
    })
  })

  it('clears warning when refreshed session changes', async () => {
    vi.mocked(getRemoteSessionStatus).mockResolvedValue(idleStatus)
    useRemoteSessionStore.setState({
      status: listeningStatus,
      sessionWarning: {
        session_id: 'session-1',
        seconds_remaining: 300,
        expires_at_unix_ms: 123,
      },
      idleWarning: {
        session_id: 'session-1',
        seconds_remaining: 60,
        expires_at_unix_ms: 456,
      },
    })

    await useRemoteSessionStore.getState().refreshStatus()

    expect(useRemoteSessionStore.getState().sessionWarning).toBeNull()
    expect(useRemoteSessionStore.getState().idleWarning).toBeNull()
    expect(useRemoteSessionStore.getState().audioState).toEqual({
      localEnabled: false,
      localMuted: false,
      remotePlaybackEnabled: false,
      connecting: false,
    })
  })

  it('clears remote audio state when refreshed session id changes', async () => {
    vi.mocked(getRemoteSessionStatus).mockResolvedValue({
      ...listeningStatus,
      current_session: {
        ...listeningSession,
        session_id: 'session-2',
      },
    })
    useRemoteSessionStore.setState({
      status: listeningStatus,
      audioState: {
        localEnabled: true,
        localMuted: false,
        remotePlaybackEnabled: true,
        connecting: false,
      },
    })

    await useRemoteSessionStore.getState().refreshStatus()

    expect(useRemoteSessionStore.getState().audioState).toEqual({
      localEnabled: false,
      localMuted: false,
      remotePlaybackEnabled: false,
      connecting: false,
    })
  })

  it('stores and clears idle warnings independently from session warnings', () => {
    useRemoteSessionStore.getState().setSessionWarning({
      session_id: 'session-1',
      seconds_remaining: 300,
      expires_at_unix_ms: 123,
    })
    useRemoteSessionStore.getState().setIdleWarning({
      session_id: 'session-1',
      seconds_remaining: 60,
      expires_at_unix_ms: 456,
    })

    expect(useRemoteSessionStore.getState().sessionWarning).toEqual({
      session_id: 'session-1',
      seconds_remaining: 300,
      expires_at_unix_ms: 123,
    })
    expect(useRemoteSessionStore.getState().idleWarning).toEqual({
      session_id: 'session-1',
      seconds_remaining: 60,
      expires_at_unix_ms: 456,
    })

    useRemoteSessionStore.getState().setIdleWarning(null)

    expect(useRemoteSessionStore.getState().sessionWarning).toEqual({
      session_id: 'session-1',
      seconds_remaining: 300,
      expires_at_unix_ms: 123,
    })
    expect(useRemoteSessionStore.getState().idleWarning).toBeNull()
  })

  it('stores and clears remote audio state', () => {
    useRemoteSessionStore.getState().setAudioState({
      localEnabled: true,
      localMuted: true,
      remotePlaybackEnabled: true,
      connecting: false,
    })

    expect(useRemoteSessionStore.getState().audioState).toEqual({
      localEnabled: true,
      localMuted: true,
      remotePlaybackEnabled: true,
      connecting: false,
    })

    useRemoteSessionStore.getState().resetAudioState()

    expect(useRemoteSessionStore.getState().audioState).toEqual({
      localEnabled: false,
      localMuted: false,
      remotePlaybackEnabled: false,
      connecting: false,
    })
  })

  it('clears remote audio state when guest mode is cleared', () => {
    useRemoteSessionStore.getState().setAudioState({
      localEnabled: true,
      localMuted: false,
      remotePlaybackEnabled: true,
      connecting: false,
    })

    useRemoteSessionStore.getState().setGuestMode(false)

    expect(useRemoteSessionStore.getState().audioState).toEqual({
      localEnabled: false,
      localMuted: false,
      remotePlaybackEnabled: false,
      connecting: false,
    })
  })

  it('clears the guest-visible host device id when guest mode is cleared', () => {
    useRemoteSessionStore.getState().setGuestHostDeviceId('host-device')

    useRemoteSessionStore.getState().setGuestMode(false)

    expect(useRemoteSessionStore.getState().guestHostDeviceId).toBeNull()
  })
})
