import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteSessionBanner } from './RemoteSessionBanner'
import { formatRemoteSessionRemaining } from '@/services/remoteSessionFormatting'
import { useRemoteSessionStore } from '@/store/remote-session-store'
import {
  REMOTE_HOST_CONTROLS_COMMAND_EVENT,
} from '@/services/remoteHostControlsWindow'
import {
  restoreRemoteHostControlsForSession,
  teardownRemoteHostControlsWindows,
  updateRemoteHostControlsAudioSnapshot,
} from '@/services/remoteHostControlsService'

const {
  eventHandlers,
  hostCallbacks,
  mockClose,
  mockDisableAudio,
  mockEnableAudio,
  mockRevoke,
  mockSetAudioMuted,
  mockSubscribe,
  mockSetAudioInputDevice,
  serviceListeners,
  serviceSnapshot,
  mockRestoreHostControls,
  mockTeardownHostControls,
  mockUpdateHostControlsAudioSnapshot,
} = vi.hoisted(() => ({
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  hostCallbacks: {
    current: null as null | {
      onSecurityCode?: (code: string | null) => void
      onRemoteAudioStream?: (stream: MediaStream) => void
    },
  },
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockDisableAudio: vi.fn().mockResolvedValue(undefined),
  mockEnableAudio: vi.fn().mockResolvedValue(undefined),
  mockRevoke: vi.fn().mockResolvedValue({ current_session: null }),
  mockSetAudioMuted: vi.fn().mockResolvedValue(undefined),
  mockSetAudioInputDevice: vi.fn().mockResolvedValue(undefined),
  mockSubscribe: vi.fn(callbacks => {
    hostCallbacks.current = callbacks
    return vi.fn()
  }),
  serviceListeners: new Set<() => void>(),
  serviceSnapshot: {
    current: { hostControlsUnavailable: false },
  },
  mockRestoreHostControls: vi.fn().mockResolvedValue(undefined),
  mockTeardownHostControls: vi.fn().mockResolvedValue(undefined),
  mockUpdateHostControlsAudioSnapshot: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    (name: string, handler: (event: { payload: unknown }) => void) => {
      eventHandlers.set(name, handler)
      return Promise.resolve(() => eventHandlers.delete(name))
    }
  ),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}))

const { toast } = await import('sonner')

vi.mock('@/services/remoteWebRtcHost', () => ({
  remoteWebRtcHost: {
    close: mockClose,
    disableAudio: mockDisableAudio,
    enableAudio: mockEnableAudio,
    setAudioInputDevice: mockSetAudioInputDevice,
    setAudioMuted: mockSetAudioMuted,
    subscribe: mockSubscribe,
  },
}))

vi.mock('@/services/remoteHostControlsWindow', () => ({
  REMOTE_HOST_CONTROLS_COMMAND_EVENT: 'remote-host-controls:command',
}))

vi.mock('@/services/remoteHostControlsService', () => ({
  getRemoteHostControlsServiceSnapshot: vi.fn(() => serviceSnapshot.current),
  restoreRemoteHostControlsForSession: mockRestoreHostControls,
  subscribeRemoteHostControlsServiceState: vi.fn((listener: () => void) => {
    serviceListeners.add(listener)
    return () => serviceListeners.delete(listener)
  }),
  teardownRemoteHostControlsWindows: mockTeardownHostControls,
  updateRemoteHostControlsAudioSnapshot: mockUpdateHostControlsAudioSnapshot,
}))

const setHostControlsUnavailable = (hostControlsUnavailable: boolean) => {
  serviceSnapshot.current = { hostControlsUnavailable }
  serviceListeners.forEach(listener => listener())
}

describe('RemoteSessionBanner', () => {
  beforeEach(() => {
    eventHandlers.clear()
    hostCallbacks.current = null
    mockClose.mockClear()
    mockDisableAudio.mockClear()
    mockDisableAudio.mockResolvedValue(undefined)
    mockEnableAudio.mockClear()
    mockEnableAudio.mockResolvedValue(undefined)
    mockRevoke.mockClear()
    mockSetAudioMuted.mockClear()
    mockSetAudioMuted.mockResolvedValue(undefined)
    mockSetAudioInputDevice.mockClear()
    mockSetAudioInputDevice.mockResolvedValue(undefined)
    mockSubscribe.mockClear()
    mockRestoreHostControls.mockClear()
    mockRestoreHostControls.mockResolvedValue(undefined)
    mockTeardownHostControls.mockClear()
    mockTeardownHostControls.mockResolvedValue(undefined)
    mockUpdateHostControlsAudioSnapshot.mockClear()
    serviceListeners.clear()
    serviceSnapshot.current = { hostControlsUnavailable: false }
    mockSubscribe.mockImplementation(callbacks => {
      hostCallbacks.current = callbacks
      return vi.fn()
    })
    useRemoteSessionStore.setState({
      status: {
        current_session: {
          session_id: 'session-1',
          invite_token_preview: 'abcd',
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
      sessionWarning: null,
      idleWarning: null,
      audioState: {
        localEnabled: false,
        localMuted: false,
        remotePlaybackEnabled: false,
        connecting: false,
      },
    })
    useRemoteSessionStore.setState({ revoke: mockRevoke })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
      () => undefined
    )
  })

  it('publishes host controls audio snapshot without rendering controls inline', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)

    render(<RemoteSessionBanner />)

    expect(screen.queryByTestId('remote-host-security-code')).toBeNull()
    expect(screen.queryByTestId('remote-host-audio-controls')).toBeNull()
    expect(screen.queryByTestId('remote-revoke-control')).toBeNull()
    expect(screen.getByTestId('remote-host-audio-output')).toBeInTheDocument()
    await waitFor(() =>
      expect(updateRemoteHostControlsAudioSnapshot).toHaveBeenCalledWith({
        audioInputDevices: [],
        micLevel: 0,
        playbackVolume: 1,
        selectedAudioInputDeviceId: '',
      })
    )
  })

  it('handles host controls window audio commands in the main WebRTC session', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    render(<RemoteSessionBanner />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_COMMAND_EVENT)).toBe(true)
    )

    await act(async () => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_COMMAND_EVENT)?.({
        payload: { type: 'enable-audio' },
      })
    })
    await waitFor(() => expect(mockEnableAudio).toHaveBeenCalled())

    await act(async () => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_COMMAND_EVENT)?.({
        payload: { type: 'toggle-mute' },
      })
    })
    await waitFor(() => expect(mockSetAudioMuted).toHaveBeenCalledWith(true))

    await act(async () => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_COMMAND_EVENT)?.({
        payload: { type: 'set-device', deviceId: 'mic-2' },
      })
    })
    await waitFor(() =>
      expect(mockSetAudioInputDevice).toHaveBeenCalledWith('mic-2')
    )

    mockDisableAudio.mockClear()
    await act(async () => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_COMMAND_EVENT)?.({
        payload: { type: 'stop-audio' },
      })
    })
    await waitFor(() => expect(mockDisableAudio).toHaveBeenCalledTimes(1))
  })

  it('applies host controls window speaker volume commands to remote playback', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    render(<RemoteSessionBanner />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_COMMAND_EVENT)).toBe(true)
    )

    const hostAudio = screen.getByTestId(
      'remote-host-audio-output'
    ) as HTMLAudioElement
    await act(async () => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_COMMAND_EVENT)?.({
        payload: { type: 'set-volume', volume: 0.35 },
      })
    })

    expect(hostAudio.volume).toBe(0.35)
  })

  it('shows the fallback chip when the host controls window reports it was hidden', async () => {
    render(<RemoteSessionBanner />)

    await act(async () => {
      setHostControlsUnavailable(true)
    })

    expect(
      await screen.findByTestId('remote-host-controls-fallback')
    ).toHaveTextContent('Remote session active')
  })

  it('restores hidden host controls from the fallback chip', async () => {
    render(<RemoteSessionBanner />)
    await act(async () => {
      setHostControlsUnavailable(true)
    })
    await screen.findByTestId('remote-host-controls-fallback')

    fireEvent.click(screen.getByTestId('remote-host-controls-restore'))
    await waitFor(() =>
      expect(restoreRemoteHostControlsForSession).toHaveBeenCalled()
    )
  })

  it('shows a toast when restoring host controls fails', async () => {
    mockRestoreHostControls.mockRejectedValueOnce(new Error('restore failed'))
    render(<RemoteSessionBanner />)
    await act(async () => {
      setHostControlsUnavailable(true)
    })
    await screen.findByTestId('remote-host-controls-fallback')

    fireEvent.click(screen.getByTestId('remote-host-controls-restore'))

    await waitFor(() =>
      expect(restoreRemoteHostControlsForSession).toHaveBeenCalled()
    )
    expect(toast.error).toHaveBeenCalledWith('restore failed')
  })

  it('shows autoplay listening guidance as an informational host toast', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
      new DOMException('', 'NotAllowedError')
    )

    render(<RemoteSessionBanner />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_COMMAND_EVENT)).toBe(true)
    )

    await act(async () => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_COMMAND_EVENT)?.({
        payload: { type: 'enable-audio' },
      })
    })

    await waitFor(() => expect(mockEnableAudio).toHaveBeenCalled())
    expect(toast.info).toHaveBeenCalledWith(
      'Remote audio playback was blocked. Turn audio off and on to retry.'
    )
    expect(toast.error).not.toHaveBeenCalledWith(
      'Remote audio playback was blocked. Turn audio off and on to retry.'
    )
  })

  it('revokes the active host session from the host controls window command', async () => {
    render(<RemoteSessionBanner />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_COMMAND_EVENT)).toBe(true)
    )

    await act(async () => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_COMMAND_EVENT)?.({
        payload: { type: 'revoke' },
      })
    })

    await waitFor(() => expect(mockClose).toHaveBeenCalledWith(false))
    expect(mockRevoke).toHaveBeenCalledWith('ended')
    expect(teardownRemoteHostControlsWindows).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('Remote session ended')
  })

  it('stores warning countdown from remote-session-warning events', async () => {
    render(<RemoteSessionBanner />)
    await waitFor(() =>
      expect(eventHandlers.has('remote-session-warning')).toBe(true)
    )

    await act(async () => {
      eventHandlers.get('remote-session-warning')?.({
        payload: { session_id: 'session-1', seconds_remaining: 301 },
      })
    })

    await waitFor(() =>
      expect(useRemoteSessionStore.getState().sessionWarning).toEqual(
        expect.objectContaining({
          session_id: 'session-1',
          seconds_remaining: 301,
        })
      )
    )
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringMatching(/^Remote session expires in /)
    )
  })

  it('expires LAN sessions through the existing close and revoke path', async () => {
    render(<RemoteSessionBanner />)
    await waitFor(() =>
      expect(eventHandlers.has('remote-session-expired')).toBe(true)
    )

    await act(async () => {
      eventHandlers.get('remote-session-expired')?.({
        payload: { session_id: 'session-1', seconds_remaining: 0 },
      })
    })

    await waitFor(() => expect(mockClose).toHaveBeenCalledWith(false))
    expect(mockRevoke).toHaveBeenCalledWith('ended')
  })

  it('expires cloud sessions through the cloud notification close path', async () => {
    useRemoteSessionStore.setState(state => ({
      status: state.status
        ? {
            ...state.status,
            current_session: state.status.current_session
              ? { ...state.status.current_session, mode: 'cloud' }
              : null,
          }
        : null,
    }))

    render(<RemoteSessionBanner />)
    await waitFor(() =>
      expect(eventHandlers.has('remote-session-expired')).toBe(true)
    )

    await act(async () => {
      eventHandlers.get('remote-session-expired')?.({
        payload: { session_id: 'session-1', seconds_remaining: 0 },
      })
    })

    await waitFor(() => expect(mockClose).toHaveBeenCalledWith(true, 'ended'))
    expect(mockRevoke).toHaveBeenCalledWith('ended')
  })

  it('uses the local countdown as an expiry fallback', async () => {
    useRemoteSessionStore.getState().setSessionWarning({
      session_id: 'session-1',
      seconds_remaining: 0,
      expires_at_unix_ms: Date.now() - 1000,
    })

    render(<RemoteSessionBanner />)

    await waitFor(() => expect(mockClose).toHaveBeenCalledWith(false))
    expect(mockRevoke).toHaveBeenCalledWith('ended')
  })

  it('shows the sooner idle warning label instead of the session cap label', async () => {
    useRemoteSessionStore.getState().setSessionWarning({
      session_id: 'session-1',
      seconds_remaining: 300,
      expires_at_unix_ms: Date.now() + 300_000,
    })
    useRemoteSessionStore.getState().setIdleWarning({
      session_id: 'session-1',
      seconds_remaining: 60,
      expires_at_unix_ms: Date.now() + 60_000,
    })

    render(<RemoteSessionBanner />)

    expect(useRemoteSessionStore.getState().idleWarning).toEqual(
      expect.objectContaining({
        session_id: 'session-1',
        seconds_remaining: 60,
      })
    )
    expect(screen.queryByText(/Expires in 5:00/)).toBeNull()
  })

  it('uses the idle warning countdown as an expiry fallback with idle copy', async () => {
    useRemoteSessionStore.getState().setIdleWarning({
      session_id: 'session-1',
      seconds_remaining: 0,
      expires_at_unix_ms: Date.now() - 1000,
    })

    render(<RemoteSessionBanner />)

    await waitFor(() => expect(mockClose).toHaveBeenCalledWith(false))
    expect(mockRevoke).toHaveBeenCalledWith('ended')
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Remote session ended after 10 minutes of inactivity.'
      )
    )
  })

  it('clears countdown and keeps expiry dedupe latched after revoke failure', async () => {
    mockRevoke.mockRejectedValueOnce(new Error('revoke failed'))

    render(<RemoteSessionBanner />)
    await waitFor(() =>
      expect(eventHandlers.has('remote-session-expired')).toBe(true)
    )

    await act(async () => {
      eventHandlers.get('remote-session-expired')?.({
        payload: { session_id: 'session-1', seconds_remaining: 0 },
      })
    })

    await waitFor(() =>
      expect(useRemoteSessionStore.getState().sessionWarning).toBeNull()
    )
    expect(toast.error).toHaveBeenCalledWith('revoke failed')

    await act(async () => {
      eventHandlers.get('remote-session-expired')?.({
        payload: { session_id: 'session-1', seconds_remaining: 0 },
      })
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(mockRevoke).toHaveBeenCalledTimes(1)
    expect(useRemoteSessionStore.getState().sessionWarning).toBeNull()
  })

  it('formats countdown boundaries defensively', () => {
    expect(formatRemoteSessionRemaining(60)).toBe('1:00')
    expect(formatRemoteSessionRemaining(59)).toBe('0:59')
    expect(formatRemoteSessionRemaining(0)).toBe('0:00')
    expect(formatRemoteSessionRemaining(-5)).toBe('0:00')
  })
})
