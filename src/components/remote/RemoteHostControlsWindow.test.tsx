import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteHostControlsWindow } from './RemoteHostControlsWindow'
import {
  REMOTE_HOST_CONTROLS_COLLAPSED_HEIGHT,
  REMOTE_HOST_CONTROLS_EXPANDED_HEIGHT,
  REMOTE_HOST_CONTROLS_STATE_EVENT,
  REMOTE_HOST_CONTROLS_WINDOW_WIDTH,
  type RemoteHostControlsState,
} from '@/services/remoteHostControlsWindow'

const {
  closeRequestedHandler,
  eventHandlers,
  mockDestroy,
  mockEmit,
  mockHide,
  mockLoggerWarn,
  mockOnFocusChanged,
  mockOnCloseRequested,
  mockSetRemoteWindowCaptureExclusion,
  mockSetSize,
  mockShow,
  mockStartDragging,
} = vi.hoisted(() => ({
  closeRequestedHandler: {
    current: null as
      | null
      | ((event: {
          isPreventDefault: () => boolean
          preventDefault: () => void
        }) => void),
  },
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  mockDestroy: vi.fn().mockResolvedValue(undefined),
  mockEmit: vi.fn().mockResolvedValue(undefined),
  mockHide: vi.fn().mockResolvedValue(undefined),
  mockLoggerWarn: vi.fn(),
  mockOnFocusChanged: vi.fn().mockResolvedValue(vi.fn()),
  mockOnCloseRequested: vi.fn(handler => {
    closeRequestedHandler.current = handler
    return Promise.resolve(vi.fn())
  }),
  mockSetRemoteWindowCaptureExclusion: vi.fn().mockResolvedValue(undefined),
  mockSetSize: vi.fn().mockResolvedValue(undefined),
  mockShow: vi.fn().mockResolvedValue(undefined),
  mockStartDragging: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  emit: mockEmit,
  listen: vi.fn(
    (name: string, handler: (event: { payload: unknown }) => void) => {
      eventHandlers.set(name, handler)
      return Promise.resolve(() => eventHandlers.delete(name))
    }
  ),
}))

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalSize: class LogicalSize {
    readonly kind = 'logical'

    constructor(
      public width: number,
      public height: number
    ) {}
  },
  PhysicalSize: class PhysicalSize {
    readonly kind = 'physical'

    constructor(
      public width: number,
      public height: number
    ) {}
  },
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    destroy: mockDestroy,
    hide: mockHide,
    onFocusChanged: mockOnFocusChanged,
    onCloseRequested: mockOnCloseRequested,
    setSize: mockSetSize,
    show: mockShow,
    startDragging: mockStartDragging,
  }),
}))

vi.mock('@/services/remoteSessionService', () => ({
  setRemoteWindowCaptureExclusion: mockSetRemoteWindowCaptureExclusion,
}))

const activeState: RemoteHostControlsState = {
  active: true,
  audioInputDevices: [],
  audioLabel: 'Audio on',
  audioState: {
    connecting: false,
    localEnabled: true,
    localMuted: false,
    remotePlaybackEnabled: true,
  },
  guestDeviceId: 'guest-device',
  guestDisplayName: 'Device 4c-158',
  identityLabelVisible: true,
  micLevel: 0.5,
  playbackVolume: 0.8,
  securityCode: 'F863-7BBF-2E7C',
  selectedAudioInputDeviceId: '',
  warningText: null,
}

describe('RemoteHostControlsWindow', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    })
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
      configurable: true,
      value: vi.fn(),
    })
    closeRequestedHandler.current = null
    eventHandlers.clear()
    mockDestroy.mockClear()
    mockDestroy.mockResolvedValue(undefined)
    mockEmit.mockClear()
    mockHide.mockClear()
    mockHide.mockResolvedValue(undefined)
    mockLoggerWarn.mockClear()
    mockOnFocusChanged.mockClear()
    mockOnFocusChanged.mockResolvedValue(vi.fn())
    mockOnCloseRequested.mockClear()
    mockOnCloseRequested.mockImplementation(handler => {
      closeRequestedHandler.current = handler
      return Promise.resolve(vi.fn())
    })
    mockSetRemoteWindowCaptureExclusion.mockClear()
    mockSetSize.mockClear()
    mockSetSize.mockResolvedValue(undefined)
    mockShow.mockClear()
    mockShow.mockResolvedValue(undefined)
    mockStartDragging.mockClear()
    mockStartDragging.mockResolvedValue(undefined)
  })

  it('renders no visible waiting state before host state arrives', () => {
    render(<RemoteHostControlsWindow />)

    expect(screen.getByTestId('remote-host-controls-window')).toHaveClass(
      'hidden'
    )
    expect(
      screen.getByTestId('remote-host-controls-window')
    ).toBeEmptyDOMElement()
    expect(screen.queryByTestId('remote-host-security-code')).toBeNull()
    expect(screen.queryByTestId('remote-revoke-control')).toBeNull()
  })

  it('destroys itself when the synced host state is inactive', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: { ...activeState, active: false },
      })
    })

    await waitFor(() => expect(mockDestroy).toHaveBeenCalled())
    expect(screen.getByTestId('remote-host-controls-window')).toHaveClass(
      'hidden'
    )
    expect(
      screen.getByTestId('remote-host-controls-window')
    ).toBeEmptyDOMElement()
    expect(screen.queryByTestId('remote-revoke-control')).toBeNull()
  })

  it('excludes itself from capture and renders host-only controls from synced state', async () => {
    render(<RemoteHostControlsWindow />)

    await waitFor(() =>
      expect(mockSetRemoteWindowCaptureExclusion).toHaveBeenCalledWith(true)
    )
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )
    await waitFor(() =>
      expect(mockEmit).toHaveBeenCalledWith('remote-host-controls:command', {
        type: 'request-state',
      })
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: { ...activeState, warningText: 'Expires in 0:59' },
      })
    })

    expect(screen.getByTestId('remote-host-controls-window')).toHaveTextContent(
      'LIVE'
    )
    // Identity moved to the floating label; the strip no longer shows it.
    expect(
      screen.getByTestId('remote-host-controls-window')
    ).not.toHaveTextContent('Device 4c-158')
    expect(screen.queryByTestId('remote-host-security-code')).toBeNull()
    expect(screen.getByTestId('remote-host-audio-mute')).toHaveAccessibleName(
      'Mute mic'
    )
    expect(screen.queryByTestId('remote-host-mic-level')).toBeNull()
    expect(screen.queryByRole('slider', { name: 'Speaker volume' })).toBeNull()
    expect(screen.getByTestId('remote-session-warning-chip')).toHaveTextContent(
      'Expires in 0:59'
    )
    expect(screen.queryByTestId('remote-host-audio-playback')).toBeNull()
    expect(screen.queryByTestId('remote-host-audio-play')).toBeNull()
    expect(screen.getByTestId('remote-revoke-control')).toHaveTextContent('End')
    expect(screen.queryByTestId('remote-hide-control')).toBeNull()
    expect(
      screen.queryByRole('button', { name: /hide remote controls/i })
    ).toBeNull()
    // Both boundaries matter: the host WebviewWindow shell must not clip the
    // expanded audio panel, and the toolbar must stay pinned to the top rather
    // than centering inside the expanded native window.
    expect(
      screen.getByTestId('remote-host-controls-window').className
    ).not.toContain('overflow-hidden')
    expect(
      screen.getByTestId('remote-host-controls-panel').className
    ).not.toContain('h-full')
    expect(screen.getByTestId('remote-host-controls-panel')).toHaveClass(
      'items-start'
    )
  })

  it('shows the native host controls window when active state arrives', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: activeState,
      })
    })

    await waitFor(() => expect(mockShow).toHaveBeenCalled())

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: { ...activeState, micLevel: 0.35 },
      })
    })

    expect(mockShow).toHaveBeenCalledTimes(1)
  })

  it('starts dragging from the host controls drag handle', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: activeState,
      })
    })

    fireEvent.pointerDown(screen.getByTestId('remote-controls-drag-handle'), {
      button: 0,
    })

    expect(mockStartDragging).toHaveBeenCalled()
  })

  it('toggles the separate host identity label from the controls window', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: activeState,
      })
    })

    fireEvent.click(screen.getByTestId('remote-host-identity-toggle'))

    expect(mockEmit).toHaveBeenLastCalledWith('remote-host-controls:command', {
      type: 'toggle-identity-label',
    })
  })

  it('does not start dragging from non-primary pointer buttons', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: activeState,
      })
    })

    fireEvent.pointerDown(screen.getByTestId('remote-controls-drag-handle'), {
      button: 2,
    })

    expect(mockStartDragging).not.toHaveBeenCalled()
  })

  it('sends speaker volume changes to the main host window', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: activeState,
      })
    })

    const user = userEvent.setup()
    await user.click(screen.getByTestId('remote-host-audio-more'))
    const slider = screen.getByRole('slider', { name: 'Speaker volume' })
    slider.focus()
    fireEvent.keyDown(slider, { key: 'ArrowRight' })

    const setVolumeCalls = mockEmit.mock.calls.filter(
      ([eventName, payload]) =>
        eventName === 'remote-host-controls:command' &&
        (payload as { type?: string }).type === 'set-volume'
    )
    expect(setVolumeCalls).toHaveLength(1)
    expect(mockEmit).toHaveBeenCalledWith('remote-host-controls:command', {
      type: 'set-volume',
      volume: expect.closeTo(0.85, 2),
    })
  })

  it('starts dragging from the LIVE badge (whole bar is draggable)', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: activeState,
      })
    })

    fireEvent.pointerDown(screen.getByText('LIVE'), {
      button: 0,
    })

    expect(mockStartDragging).toHaveBeenCalled()
  })

  it('starts dragging from the host controls panel root', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: activeState,
      })
    })

    fireEvent.pointerDown(screen.getByTestId('remote-host-controls-panel'), {
      button: 0,
    })

    expect(mockStartDragging).toHaveBeenCalled()
  })

  it('does not start dragging when the gesture begins on an action button', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: activeState,
      })
    })

    fireEvent.pointerDown(screen.getByTestId('remote-revoke-control'), {
      button: 0,
    })

    expect(mockStartDragging).not.toHaveBeenCalled()
  })

  it('lets the host pick a microphone from the audio menu (parity with guest)', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: {
          ...activeState,
          audioInputDevices: [
            { deviceId: 'mic-1', label: 'Built-in microphone' },
            { deviceId: 'mic-2', label: 'External USB microphone' },
          ],
        },
      })
    })

    mockEmit.mockClear()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('remote-host-audio-more'))
    await user.click(
      await screen.findByRole('button', {
        name: 'External USB microphone',
      })
    )

    await waitFor(() =>
      expect(mockEmit).toHaveBeenCalledWith('remote-host-controls:command', {
        type: 'set-device',
        deviceId: 'mic-2',
      })
    )
  })

  it('expands the native controls window while the audio options panel is open', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: {
          ...activeState,
          audioInputDevices: [
            { deviceId: 'mic-1', label: 'Built-in microphone' },
          ],
        },
      })
    })

    const user = userEvent.setup()
    await user.click(screen.getByTestId('remote-host-audio-more'))

    expect(
      await screen.findByTestId('remote-host-audio-options')
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(mockSetSize).toHaveBeenLastCalledWith(
        expect.objectContaining({
          height: REMOTE_HOST_CONTROLS_EXPANDED_HEIGHT,
          kind: 'logical',
          width: REMOTE_HOST_CONTROLS_WINDOW_WIDTH,
        })
      )
    )

    await user.click(screen.getByTestId('remote-host-audio-more'))

    await waitFor(() =>
      expect(mockSetSize).toHaveBeenLastCalledWith(
        expect.objectContaining({
          height: REMOTE_HOST_CONTROLS_COLLAPSED_HEIGHT,
          kind: 'logical',
          width: REMOTE_HOST_CONTROLS_WINDOW_WIDTH,
        })
      )
    )
  })

  it('expands further when the measured audio panel needs more space', async () => {
    const originalGetBoundingClientRect =
      HTMLElement.prototype.getBoundingClientRect
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function getBoundingClientRect(this: HTMLElement) {
        if (this.id === 'remote-host-audio-options') {
          return {
            bottom: REMOTE_HOST_CONTROLS_EXPANDED_HEIGHT + 42,
            height: 320,
            left: 0,
            right: 320,
            top: 80,
            width: 320,
            x: 0,
            y: 80,
            toJSON: () => ({}),
          } as DOMRect
        }
        return originalGetBoundingClientRect.call(this)
      })

    try {
      render(<RemoteHostControlsWindow />)
      await waitFor(() =>
        expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
      )

      act(() => {
        eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
          payload: activeState,
        })
      })

      const user = userEvent.setup()
      await user.click(screen.getByTestId('remote-host-audio-more'))

      await waitFor(() =>
        expect(mockSetSize).toHaveBeenLastCalledWith(
          expect.objectContaining({
            height: REMOTE_HOST_CONTROLS_EXPANDED_HEIGHT + 54,
            kind: 'logical',
            width: REMOTE_HOST_CONTROLS_WINDOW_WIDTH,
          })
        )
      )
    } finally {
      rectSpy.mockRestore()
    }
  })

  it('remeasures the expanded audio panel when input devices load after open', async () => {
    const originalGetBoundingClientRect =
      HTMLElement.prototype.getBoundingClientRect
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function getBoundingClientRect(this: HTMLElement) {
        if (this.id === 'remote-host-audio-options') {
          return {
            bottom: REMOTE_HOST_CONTROLS_EXPANDED_HEIGHT + 36,
            height: 314,
            left: 0,
            right: 320,
            top: 82,
            width: 320,
            x: 0,
            y: 82,
            toJSON: () => ({}),
          } as DOMRect
        }
        return originalGetBoundingClientRect.call(this)
      })

    try {
      render(<RemoteHostControlsWindow />)
      await waitFor(() =>
        expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
      )

      act(() => {
        eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
          payload: activeState,
        })
      })

      const user = userEvent.setup()
      await user.click(screen.getByTestId('remote-host-audio-more'))
      await screen.findByTestId('remote-host-audio-options')
      mockSetSize.mockClear()

      act(() => {
        eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
          payload: {
            ...activeState,
            audioInputDevices: [
              { deviceId: 'mic-1', label: 'Built-in microphone' },
              { deviceId: 'mic-2', label: 'USB microphone' },
            ],
          },
        })
      })

      await waitFor(() =>
        expect(mockSetSize).toHaveBeenLastCalledWith(
          expect.objectContaining({
            height: REMOTE_HOST_CONTROLS_EXPANDED_HEIGHT + 48,
            kind: 'logical',
            width: REMOTE_HOST_CONTROLS_WINDOW_WIDTH,
          })
        )
      )
    } finally {
      rectSpy.mockRestore()
    }
  })

  it('does not start dragging from the expanded audio options panel or volume slider', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: activeState,
      })
    })

    const user = userEvent.setup()
    await user.click(screen.getByTestId('remote-host-audio-more'))

    mockStartDragging.mockClear()
    fireEvent.pointerDown(
      await screen.findByTestId('remote-host-audio-options'),
      {
        button: 0,
      }
    )
    fireEvent.pointerDown(
      screen.getByRole('slider', { name: 'Speaker volume' }),
      {
        button: 0,
      }
    )

    expect(mockStartDragging).not.toHaveBeenCalled()
    expect(screen.getByTestId('remote-host-audio-options')).toBeInTheDocument()
  })

  it('closes audio options when host audio is disabled and does not reopen on restart', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: activeState,
      })
    })

    const user = userEvent.setup()
    await user.click(screen.getByTestId('remote-host-audio-more'))
    expect(
      await screen.findByTestId('remote-host-audio-options')
    ).toBeInTheDocument()

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: {
          ...activeState,
          audioState: { ...activeState.audioState, localEnabled: false },
        },
      })
    })
    expect(
      screen.queryByTestId('remote-host-audio-options')
    ).not.toBeInTheDocument()
    await waitFor(() =>
      expect(mockSetSize).toHaveBeenLastCalledWith(
        expect.objectContaining({
          height: REMOTE_HOST_CONTROLS_COLLAPSED_HEIGHT,
          kind: 'logical',
          width: REMOTE_HOST_CONTROLS_WINDOW_WIDTH,
        })
      )
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: activeState,
      })
    })

    expect(
      screen.queryByTestId('remote-host-audio-options')
    ).not.toBeInTheDocument()
  })

  it('closes audio options on Escape and debounces focus loss before closing', async () => {
    let focusHandler: null | ((event: { payload: boolean }) => void) = null
    mockOnFocusChanged.mockImplementation(handler => {
      focusHandler = handler
      return Promise.resolve(vi.fn())
    })
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: activeState,
      })
    })

    fireEvent.click(screen.getByTestId('remote-host-audio-more'))
    expect(
      await screen.findByTestId('remote-host-audio-options')
    ).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(
      screen.queryByTestId('remote-host-audio-options')
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('remote-host-audio-more'))
    expect(
      await screen.findByTestId('remote-host-audio-options')
    ).toBeInTheDocument()

    const hasFocusSpy = vi.spyOn(document, 'hasFocus')
    vi.useFakeTimers()
    try {
      hasFocusSpy.mockReturnValue(true)
      act(() => {
        focusHandler?.({ payload: false })
        vi.advanceTimersByTime(175)
      })
      expect(
        screen.getByTestId('remote-host-audio-options')
      ).toBeInTheDocument()

      hasFocusSpy.mockReturnValue(false)
      act(() => {
        focusHandler?.({ payload: false })
        vi.advanceTimersByTime(175)
      })
      expect(
        screen.queryByTestId('remote-host-audio-options')
      ).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
      hasFocusSpy.mockRestore()
    }
  })

  it('removes capture exclusion when the host controls window unmounts', async () => {
    const { unmount } = render(<RemoteHostControlsWindow />)

    await waitFor(() =>
      expect(mockSetRemoteWindowCaptureExclusion).toHaveBeenCalledWith(true)
    )

    unmount()

    await waitFor(() =>
      expect(mockSetRemoteWindowCaptureExclusion).toHaveBeenCalledWith(false)
    )
  })

  it('hides and notifies the main window when the user closes the window', async () => {
    render(<RemoteHostControlsWindow />)

    await waitFor(() => expect(mockOnCloseRequested).toHaveBeenCalled())
    mockEmit.mockClear()
    const closeEvent = {
      isPreventDefault: () => false,
      preventDefault: vi.fn(),
    }

    closeRequestedHandler.current?.(closeEvent)

    expect(closeEvent.preventDefault).toHaveBeenCalled()
    await waitFor(() => expect(mockEmit).toHaveBeenCalledTimes(1))
    expect(mockHide).toHaveBeenCalled()
    expect(mockEmit).toHaveBeenLastCalledWith('remote-host-controls:command', {
      type: 'hidden',
    })
  })

  it('emits host control commands instead of mutating WebRTC state locally', async () => {
    render(<RemoteHostControlsWindow />)
    await waitFor(() =>
      expect(eventHandlers.has(REMOTE_HOST_CONTROLS_STATE_EVENT)).toBe(true)
    )

    act(() => {
      eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({
        payload: activeState,
      })
    })

    // Primary segment toggles mute; "turn off audio" lives in the more menu.
    const user = userEvent.setup()
    await user.click(screen.getByTestId('remote-host-audio-mute'))
    await user.click(screen.getByTestId('remote-host-audio-more'))
    await user.click(await screen.findByTestId('remote-host-audio-stop'))
    fireEvent.click(screen.getByTestId('remote-revoke-control'))

    await waitFor(() =>
      expect(mockEmit).toHaveBeenCalledWith('remote-host-controls:command', {
        type: 'toggle-mute',
      })
    )
    expect(mockEmit).toHaveBeenCalledWith('remote-host-controls:command', {
      type: 'stop-audio',
    })
    expect(mockEmit).toHaveBeenCalledWith('remote-host-controls:command', {
      type: 'revoke',
    })
  })
})
