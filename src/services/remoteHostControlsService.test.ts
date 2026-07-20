import { waitFor } from '@/test/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRemoteSessionStore } from '@/store/remote-session-store'
import {
  destroyRemoteHostIdentityLabelWindow,
  destroyRemoteHostControlsWindow,
  hideRemoteHostIdentityLabelWindow,
  hideRemoteHostControlsWindow,
  openRemoteHostIdentityLabelWindow,
  openRemoteHostControlsWindow,
  syncRemoteHostIdentityLabelState,
  syncRemoteHostControlsState,
} from '@/services/remoteHostControlsWindow'
import {
  getRemoteHostControlsServiceSnapshot,
  initRemoteHostControlsService,
  resetRemoteHostControlsServiceForTests,
  restoreRemoteHostControlsForSession,
  updateRemoteHostControlsAudioSnapshot,
} from '@/services/remoteHostControlsService'

const { eventHandlers, hostCallbacks, mockLoggerWarn, mockSubscribe } =
  vi.hoisted(() => ({
    eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
    hostCallbacks: {
      current: null as null | {
        onSecurityCode?: (code: string | null) => void
      },
    },
    mockLoggerWarn: vi.fn(),
    mockSubscribe: vi.fn(callbacks => {
      hostCallbacks.current = callbacks
      callbacks.onSecurityCode?.('1234-ABCD-EF90')
      return vi.fn()
    }),
  }))

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    (name: string, handler: (event: { payload: unknown }) => void) => {
      eventHandlers.set(name, handler)
      return Promise.resolve(() => eventHandlers.delete(name))
    }
  ),
}))

vi.mock('@/services/remoteWebRtcHost', () => ({
  remoteWebRtcHost: {
    subscribe: mockSubscribe,
  },
}))

vi.mock('@/services/remoteHostControlsWindow', () => ({
  REMOTE_HOST_CONTROLS_COMMAND_EVENT: 'remote-host-controls:command',
  destroyRemoteHostIdentityLabelWindow: vi.fn().mockResolvedValue(undefined),
  destroyRemoteHostControlsWindow: vi.fn().mockResolvedValue(undefined),
  hideRemoteHostIdentityLabelWindow: vi.fn().mockResolvedValue(undefined),
  hideRemoteHostControlsWindow: vi.fn().mockResolvedValue(undefined),
  openRemoteHostIdentityLabelWindow: vi.fn().mockResolvedValue(undefined),
  openRemoteHostControlsWindow: vi.fn().mockResolvedValue(undefined),
  syncRemoteHostIdentityLabelState: vi.fn().mockResolvedValue(undefined),
  syncRemoteHostControlsState: vi.fn().mockResolvedValue(undefined),
}))

const activeStatus = {
  current_session: {
    session_id: 'session-1',
    invite_token_preview: 'abcd',
    signaling_port: 49152,
    host_candidates: ['127.0.0.1:49152'],
    mode: 'lan' as const,
    host_display_name: 'Host',
    host_device_id: 'host-device',
    guest_display_name: 'Guest',
    guest_device_id: 'guest-device',
    status: 'connected' as const,
    can_control: true,
  },
  pending_guest: null,
  approved_guest: {
    guest_display_name: 'Guest',
    guest_device_id: 'guest-device',
  },
  approved_control: true,
}

const setActiveHostSession = () => {
  useRemoteSessionStore.setState({
    status: activeStatus,
    approvedGuest: {
      guest_display_name: 'Guest',
      guest_device_id: 'guest-device',
    },
    audioState: {
      connecting: false,
      localEnabled: false,
      localMuted: false,
      remotePlaybackEnabled: false,
    },
  })
}

const setInactiveSession = () => {
  useRemoteSessionStore.setState({
    status: {
      current_session: null,
      pending_guest: null,
      approved_guest: null,
      approved_control: false,
    },
    approvedGuest: null,
  })
}

describe('remoteHostControlsService', () => {
  let cleanup: (() => void) | null = null

  beforeEach(() => {
    resetRemoteHostControlsServiceForTests()
    eventHandlers.clear()
    hostCallbacks.current = null
    mockSubscribe.mockClear()
    mockSubscribe.mockImplementation(callbacks => {
      hostCallbacks.current = callbacks
      callbacks.onSecurityCode?.('1234-ABCD-EF90')
      return vi.fn()
    })
    mockLoggerWarn.mockClear()
    vi.mocked(destroyRemoteHostControlsWindow).mockClear()
    vi.mocked(destroyRemoteHostControlsWindow).mockResolvedValue(undefined)
    vi.mocked(destroyRemoteHostIdentityLabelWindow).mockClear()
    vi.mocked(destroyRemoteHostIdentityLabelWindow).mockResolvedValue(undefined)
    vi.mocked(hideRemoteHostControlsWindow).mockClear()
    vi.mocked(hideRemoteHostControlsWindow).mockResolvedValue(undefined)
    vi.mocked(hideRemoteHostIdentityLabelWindow).mockClear()
    vi.mocked(hideRemoteHostIdentityLabelWindow).mockResolvedValue(undefined)
    vi.mocked(openRemoteHostControlsWindow).mockClear()
    vi.mocked(openRemoteHostControlsWindow).mockResolvedValue({} as never)
    vi.mocked(openRemoteHostIdentityLabelWindow).mockClear()
    vi.mocked(openRemoteHostIdentityLabelWindow).mockResolvedValue({} as never)
    vi.mocked(syncRemoteHostControlsState).mockClear()
    vi.mocked(syncRemoteHostControlsState).mockResolvedValue(undefined)
    vi.mocked(syncRemoteHostIdentityLabelState).mockClear()
    vi.mocked(syncRemoteHostIdentityLabelState).mockResolvedValue(undefined)
    window.__E2E_REMOTE_HOST_CONTROLS_SUPPRESSED__ = false
    setInactiveSession()
  })

  afterEach(() => {
    cleanup?.()
    cleanup = null
    resetRemoteHostControlsServiceForTests()
  })

  it('opens and syncs controls for an active host session', async () => {
    setActiveHostSession()

    cleanup = initRemoteHostControlsService()

    await waitFor(() => expect(openRemoteHostControlsWindow).toHaveBeenCalled())
    expect(syncRemoteHostControlsState).toHaveBeenCalledWith(
      expect.objectContaining({
        active: true,
        guestDeviceId: 'guest-device',
        guestDisplayName: 'Guest',
        identityLabelVisible: true,
        securityCode: '1234-ABCD-EF90',
      })
    )
    expect(openRemoteHostIdentityLabelWindow).toHaveBeenCalled()
    expect(syncRemoteHostIdentityLabelState).toHaveBeenCalledWith(
      expect.objectContaining({
        active: true,
        guestDisplayName: 'Guest',
      })
    )
  })

  it('syncs updated audio-device snapshots into active controls state', async () => {
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() => expect(syncRemoteHostControlsState).toHaveBeenCalled())
    vi.mocked(syncRemoteHostControlsState).mockClear()

    updateRemoteHostControlsAudioSnapshot({
      audioInputDevices: [{ deviceId: 'mic-2', label: 'USB microphone' }],
      micLevel: 0.4,
      playbackVolume: 0.7,
      selectedAudioInputDeviceId: 'mic-2',
    })

    await waitFor(() =>
      expect(syncRemoteHostControlsState).toHaveBeenCalledWith(
        expect.objectContaining({
          audioInputDevices: [{ deviceId: 'mic-2', label: 'USB microphone' }],
          micLevel: 0.4,
          playbackVolume: 0.7,
          selectedAudioInputDeviceId: 'mic-2',
        })
      )
    )
  })

  it('hides controls and marks the fallback visible when hidden is reported', async () => {
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() =>
      expect(eventHandlers.has('remote-host-controls:command')).toBe(true)
    )

    eventHandlers.get('remote-host-controls:command')?.({
      payload: { type: 'hidden' },
    })

    await waitFor(() => expect(hideRemoteHostControlsWindow).toHaveBeenCalled())
    expect(hideRemoteHostIdentityLabelWindow).toHaveBeenCalled()
    expect(getRemoteHostControlsServiceSnapshot().hostControlsUnavailable).toBe(
      true
    )
  })

  it('toggles the separate host identity label window', async () => {
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() =>
      expect(eventHandlers.has('remote-host-controls:command')).toBe(true)
    )
    await waitFor(() =>
      expect(openRemoteHostIdentityLabelWindow).toHaveBeenCalled()
    )
    vi.mocked(openRemoteHostIdentityLabelWindow).mockClear()
    vi.mocked(syncRemoteHostControlsState).mockClear()

    eventHandlers.get('remote-host-controls:command')?.({
      payload: { type: 'toggle-identity-label' },
    })

    await waitFor(() =>
      expect(hideRemoteHostIdentityLabelWindow).toHaveBeenCalled()
    )
    expect(syncRemoteHostControlsState).toHaveBeenLastCalledWith(
      expect.objectContaining({ identityLabelVisible: false })
    )

    eventHandlers.get('remote-host-controls:command')?.({
      payload: { type: 'toggle-identity-label' },
    })

    await waitFor(() =>
      expect(openRemoteHostIdentityLabelWindow).toHaveBeenCalled()
    )
    expect(syncRemoteHostControlsState).toHaveBeenLastCalledWith(
      expect.objectContaining({ identityLabelVisible: true })
    )
  })

  it('resets identity label visibility for each new host session', async () => {
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() =>
      expect(eventHandlers.has('remote-host-controls:command')).toBe(true)
    )

    eventHandlers.get('remote-host-controls:command')?.({
      payload: { type: 'toggle-identity-label' },
    })
    await waitFor(() =>
      expect(syncRemoteHostControlsState).toHaveBeenLastCalledWith(
        expect.objectContaining({ identityLabelVisible: false })
      )
    )

    useRemoteSessionStore.setState({
      status: {
        ...activeStatus,
        current_session: {
          ...activeStatus.current_session,
          session_id: 'session-2',
        },
      },
    })

    await waitFor(() =>
      expect(syncRemoteHostControlsState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          identityLabelVisible: true,
          securityCode: '1234-ABCD-EF90',
        })
      )
    )
  })

  it('does not reopen controls when lifecycle updates while hide is pending', async () => {
    let resolveHide: () => void = () => undefined
    vi.mocked(hideRemoteHostControlsWindow).mockReturnValueOnce(
      new Promise(resolve => {
        resolveHide = () => resolve(undefined)
      })
    )
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() =>
      expect(eventHandlers.has('remote-host-controls:command')).toBe(true)
    )
    await waitFor(() => expect(openRemoteHostControlsWindow).toHaveBeenCalled())
    vi.mocked(openRemoteHostControlsWindow).mockClear()

    eventHandlers.get('remote-host-controls:command')?.({
      payload: { type: 'hidden' },
    })

    await waitFor(() => expect(hideRemoteHostControlsWindow).toHaveBeenCalled())
    expect(getRemoteHostControlsServiceSnapshot().hostControlsUnavailable).toBe(
      true
    )

    useRemoteSessionStore.setState({
      audioState: {
        connecting: false,
        localEnabled: true,
        localMuted: false,
        remotePlaybackEnabled: false,
      },
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(openRemoteHostControlsWindow).not.toHaveBeenCalled()
    resolveHide()
    await waitFor(() => expect(hideRemoteHostControlsWindow).toHaveBeenCalled())
  })

  it('rolls back hidden state when the service fallback hide fails', async () => {
    vi.mocked(hideRemoteHostControlsWindow).mockRejectedValueOnce(
      new Error('hide failed')
    )
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() =>
      expect(eventHandlers.has('remote-host-controls:command')).toBe(true)
    )

    eventHandlers.get('remote-host-controls:command')?.({
      payload: { type: 'hidden' },
    })

    await waitFor(() =>
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Failed to hide remote host controls window',
        expect.objectContaining({ error: expect.any(Error) })
      )
    )
    expect(getRemoteHostControlsServiceSnapshot().hostControlsUnavailable).toBe(
      false
    )

    eventHandlers.get('remote-host-controls:command')?.({
      payload: { type: 'hidden' },
    })

    await waitFor(() =>
      expect(hideRemoteHostControlsWindow).toHaveBeenCalledTimes(2)
    )
    expect(getRemoteHostControlsServiceSnapshot().hostControlsUnavailable).toBe(
      true
    )
  })

  it('ignores repeated hidden commands for the same active session', async () => {
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() =>
      expect(eventHandlers.has('remote-host-controls:command')).toBe(true)
    )

    eventHandlers.get('remote-host-controls:command')?.({
      payload: { type: 'hidden' },
    })
    await waitFor(() =>
      expect(hideRemoteHostControlsWindow).toHaveBeenCalledTimes(1)
    )

    eventHandlers.get('remote-host-controls:command')?.({
      payload: { type: 'hidden' },
    })

    expect(hideRemoteHostControlsWindow).toHaveBeenCalledTimes(1)
  })

  it('restores hidden controls and clears fallback after show succeeds', async () => {
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() =>
      expect(eventHandlers.has('remote-host-controls:command')).toBe(true)
    )
    eventHandlers.get('remote-host-controls:command')?.({
      payload: { type: 'hidden' },
    })
    await waitFor(() =>
      expect(
        getRemoteHostControlsServiceSnapshot().hostControlsUnavailable
      ).toBe(true)
    )
    vi.mocked(openRemoteHostControlsWindow).mockClear()

    await restoreRemoteHostControlsForSession()

    expect(openRemoteHostControlsWindow).toHaveBeenCalled()
    expect(getRemoteHostControlsServiceSnapshot().hostControlsUnavailable).toBe(
      false
    )
  })

  it('clears hidden fallback before awaiting the restored controls window', async () => {
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() =>
      expect(eventHandlers.has('remote-host-controls:command')).toBe(true)
    )
    eventHandlers.get('remote-host-controls:command')?.({
      payload: { type: 'hidden' },
    })
    await waitFor(() =>
      expect(
        getRemoteHostControlsServiceSnapshot().hostControlsUnavailable
      ).toBe(true)
    )
    let resolveOpen: () => void = () => undefined
    vi.mocked(openRemoteHostControlsWindow).mockReturnValueOnce(
      new Promise(resolve => {
        resolveOpen = () => resolve({} as never)
      })
    )

    const restorePromise = restoreRemoteHostControlsForSession()

    expect(getRemoteHostControlsServiceSnapshot().hostControlsUnavailable).toBe(
      false
    )

    resolveOpen()
    await restorePromise
  })

  it('tears down a stale controls window even when no active session is tracked', async () => {
    cleanup = initRemoteHostControlsService()

    await restoreRemoteHostControlsForSession()
    expect(openRemoteHostControlsWindow).toHaveBeenCalled()
    vi.mocked(destroyRemoteHostControlsWindow).mockClear()

    useRemoteSessionStore.setState({
      audioState: {
        connecting: false,
        localEnabled: false,
        localMuted: true,
        remotePlaybackEnabled: false,
      },
    })

    await waitFor(() =>
      expect(destroyRemoteHostControlsWindow).toHaveBeenCalled()
    )
  })

  it('syncs inactive fallback state before destroying controls on session end', async () => {
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() => expect(openRemoteHostControlsWindow).toHaveBeenCalled())
    await waitFor(() => expect(syncRemoteHostControlsState).toHaveBeenCalled())
    vi.mocked(syncRemoteHostControlsState).mockClear()

    setInactiveSession()

    await waitFor(() =>
      expect(syncRemoteHostControlsState).toHaveBeenCalledWith(
        expect.objectContaining({ active: false })
      )
    )
    await waitFor(() =>
      expect(destroyRemoteHostControlsWindow).toHaveBeenCalled()
    )
    expect(syncRemoteHostControlsState).toHaveBeenCalledTimes(1)
    const inactiveSyncCallOrder = vi.mocked(syncRemoteHostControlsState).mock
      .invocationCallOrder[0]
    const destroyCallOrder = vi.mocked(destroyRemoteHostControlsWindow).mock
      .invocationCallOrder[0]
    if (inactiveSyncCallOrder === undefined || destroyCallOrder === undefined) {
      throw new Error('Expected inactive sync and destroy calls')
    }
    expect(inactiveSyncCallOrder).toBeLessThan(destroyCallOrder)
  })

  it('logs destroy failures during session-end teardown', async () => {
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() => expect(openRemoteHostControlsWindow).toHaveBeenCalled())
    await waitFor(() => expect(syncRemoteHostControlsState).toHaveBeenCalled())
    vi.mocked(syncRemoteHostControlsState).mockClear()
    vi.mocked(destroyRemoteHostControlsWindow).mockRejectedValueOnce(
      new Error('destroy failed')
    )

    setInactiveSession()

    await waitFor(() =>
      expect(syncRemoteHostControlsState).toHaveBeenCalledWith(
        expect.objectContaining({ active: false })
      )
    )
    await waitFor(() =>
      expect(destroyRemoteHostControlsWindow).toHaveBeenCalled()
    )
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Failed to destroy remote host controls window',
      expect.objectContaining({ error: expect.any(Error) })
    )
  })

  it('still destroys controls when inactive fallback sync fails', async () => {
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() => expect(openRemoteHostControlsWindow).toHaveBeenCalled())
    await waitFor(() => expect(syncRemoteHostControlsState).toHaveBeenCalled())
    vi.mocked(syncRemoteHostControlsState).mockClear()
    vi.mocked(syncRemoteHostControlsState).mockRejectedValueOnce(
      new Error('inactive sync failed')
    )

    setInactiveSession()

    await waitFor(() =>
      expect(destroyRemoteHostControlsWindow).toHaveBeenCalled()
    )
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Failed to sync inactive remote host controls state',
      expect.objectContaining({ error: expect.any(Error) })
    )
  })

  it('resets fallback visibility when a hidden-controls session ends', async () => {
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() =>
      expect(eventHandlers.has('remote-host-controls:command')).toBe(true)
    )
    eventHandlers.get('remote-host-controls:command')?.({
      payload: { type: 'hidden' },
    })
    await waitFor(() =>
      expect(
        getRemoteHostControlsServiceSnapshot().hostControlsUnavailable
      ).toBe(true)
    )

    setInactiveSession()

    await waitFor(() =>
      expect(
        getRemoteHostControlsServiceSnapshot().hostControlsUnavailable
      ).toBe(false)
    )
  })

  it('updates warning text from the active warning timer', async () => {
    vi.useFakeTimers()
    try {
      setActiveHostSession()
      useRemoteSessionStore.getState().setSessionWarning({
        session_id: 'session-1',
        seconds_remaining: 120,
        expires_at_unix_ms: Date.now() + 120_000,
      })
      cleanup = initRemoteHostControlsService()
      await Promise.resolve()
      await Promise.resolve()
      expect(syncRemoteHostControlsState).toHaveBeenCalled()
      vi.mocked(syncRemoteHostControlsState).mockClear()

      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()

      expect(syncRemoteHostControlsState).toHaveBeenCalledWith(
        expect.objectContaining({
          warningText: expect.stringMatching(/^Expires in /),
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not sync stale active state when a session ends while open is pending', async () => {
    let resolveOpen: () => void = () => undefined
    vi.mocked(openRemoteHostControlsWindow).mockReturnValueOnce(
      new Promise(resolve => {
        resolveOpen = () => resolve({} as never)
      })
    )
    setActiveHostSession()
    cleanup = initRemoteHostControlsService()
    await waitFor(() => expect(openRemoteHostControlsWindow).toHaveBeenCalled())

    setInactiveSession()
    resolveOpen?.()
    await Promise.resolve()
    await Promise.resolve()

    await waitFor(() =>
      expect(destroyRemoteHostControlsWindow).toHaveBeenCalled()
    )
    expect(syncRemoteHostControlsState).toHaveBeenCalledWith(
      expect.objectContaining({ active: false })
    )
    expect(syncRemoteHostControlsState).not.toHaveBeenCalledWith(
      expect.objectContaining({ active: true })
    )
  })
})
