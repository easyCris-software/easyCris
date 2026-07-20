import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRemoteSessionStore } from '@/store/remote-session-store'
import { RemoteGuestViewerOverlay } from './RemoteGuestViewerOverlay'

const {
  callbacksRef,
  mockClose,
  mockDisableAudio,
  mockEnableAudio,
  mockGuestSetSize,
  mockGetAudioDiagnostics,
  mockGetConnectionState,
  mockGetInputContext,
  mockSendInputMessage,
  mockSetAudioInputDevice,
  mockSetAudioMuted,
  mockSubscribe,
} = vi.hoisted(() => ({
  callbacksRef: {
    current: null as null | {
      onStream?: (stream: MediaStream) => void
      onState?: (state: string, message?: string) => void
      onError?: (message: string) => void
      onRemoteAudioStream?: (stream: MediaStream) => void
      onLocalAudioStreamChange?: (stream: MediaStream | null) => void
    },
  },
  mockClose: vi.fn(),
  mockDisableAudio: vi.fn().mockResolvedValue(undefined),
  mockEnableAudio: vi.fn().mockResolvedValue(undefined),
  mockGuestSetSize: vi.fn(),
  mockGetAudioDiagnostics: vi.fn(() => ({
    audioMuted: true,
    audioSenderCreated: false,
    localAudioTrackLive: false,
  })),
  mockGetConnectionState: vi.fn(() => 'idle'),
  mockGetInputContext: vi.fn(() => ({
    sessionId: 'session-1',
    guestDeviceId: 'guest-device',
  })),
  mockSendInputMessage: vi.fn(),
  mockSetAudioInputDevice: vi.fn().mockResolvedValue(undefined),
  mockSetAudioMuted: vi.fn().mockResolvedValue(undefined),
  mockSubscribe: vi.fn(callbacks => {
    callbacksRef.current = callbacks
    callbacks.onState('idle')
    return vi.fn()
  }),
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

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    setSize: mockGuestSetSize,
  })),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
  },
}))

const { toast } = await import('sonner')

vi.mock('@/services/remoteWebRtcClient', () => ({
  isMediaVisibleState: (state: string) =>
    state === 'streaming' ||
    state === 'control_ready' ||
    state === 'control_unavailable',
  remoteWebRtcClient: {
    close: mockClose,
    disableAudio: mockDisableAudio,
    enableAudio: mockEnableAudio,
    getAudioDiagnostics: mockGetAudioDiagnostics,
    getConnectionState: mockGetConnectionState,
    getInputContext: mockGetInputContext,
    sendInputMessage: mockSendInputMessage,
    setAudioInputDevice: mockSetAudioInputDevice,
    setAudioMuted: mockSetAudioMuted,
    subscribe: mockSubscribe,
  },
}))

const installVideoGeometry = (video: HTMLElement) => {
  Object.defineProperties(video, {
    videoHeight: { configurable: true, value: 720 },
    videoWidth: { configurable: true, value: 1280 },
  })
  vi.spyOn(video, 'getBoundingClientRect').mockReturnValue({
    bottom: 720,
    height: 720,
    left: 0,
    right: 1280,
    top: 0,
    width: 1280,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
}

describe('RemoteGuestViewerOverlay', () => {
  beforeEach(() => {
    useRemoteSessionStore.setState({
      guestHostDeviceId: null,
      isBusy: false,
      isHost: false,
      isGuest: false,
      status: null,
    })
    callbacksRef.current = null
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
    mockClose.mockClear()
    mockDisableAudio.mockClear()
    mockDisableAudio.mockResolvedValue(undefined)
    mockEnableAudio.mockClear()
    mockEnableAudio.mockResolvedValue(undefined)
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1180,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 850,
    })
    mockGuestSetSize.mockClear()
    mockGuestSetSize.mockResolvedValue(undefined)
    mockGetAudioDiagnostics.mockClear()
    mockGetAudioDiagnostics.mockReturnValue({
      audioMuted: true,
      audioSenderCreated: false,
      localAudioTrackLive: false,
    })
    mockGetConnectionState.mockClear()
    mockGetConnectionState.mockReturnValue('idle')
    mockGetInputContext.mockClear()
    mockGetInputContext.mockReturnValue({
      sessionId: 'session-1',
      guestDeviceId: 'guest-device',
    })
    mockSendInputMessage.mockClear()
    mockSetAudioInputDevice.mockClear()
    mockSetAudioInputDevice.mockResolvedValue(undefined)
    mockSetAudioMuted.mockClear()
    mockSetAudioMuted.mockResolvedValue(undefined)
    mockSubscribe.mockClear()
    mockSubscribe.mockImplementation(callbacks => {
      callbacksRef.current = callbacks
      callbacks.onState('idle')
      return vi.fn()
    })
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

  it('renders the guest remote display only after the WebRTC session streams', () => {
    const stream = {} as MediaStream
    render(<RemoteGuestViewerOverlay />)

    expect(screen.queryByTestId('remote-guest-viewer-overlay')).toBeNull()

    act(() => {
      callbacksRef.current?.onState?.('streaming')
      callbacksRef.current?.onStream?.(stream)
    })

    expect(
      screen.getByTestId('remote-guest-viewer-overlay')
    ).toBeInTheDocument()
    expect(screen.getByTestId('remote-stream-video')).toHaveProperty(
      'srcObject',
      stream
    )
  })

  it('does not render the guest remote display while this app is hosting', () => {
    const stream = {} as MediaStream
    useRemoteSessionStore.setState({ isHost: true, isGuest: false })

    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('control_ready')
      callbacksRef.current?.onStream?.(stream)
    })

    expect(screen.queryByTestId('remote-guest-viewer-overlay')).toBeNull()
  })

  it('does not render the guest remote display while host startup is pending', () => {
    const stream = {} as MediaStream
    useRemoteSessionStore.setState({
      isBusy: true,
      isHost: false,
      isGuest: false,
    })

    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('control_ready')
      callbacksRef.current?.onStream?.(stream)
    })

    expect(screen.queryByTestId('remote-guest-viewer-overlay')).toBeNull()
  })

  it('keeps guest audio controls outside Preferences and disconnects from the overlay', async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined)
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('streaming')
    })

    fireEvent.click(screen.getByTestId('remote-guest-audio-enable'))
    await waitFor(() => expect(mockEnableAudio).toHaveBeenCalled())
    expect(play).toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('remote-guest-disconnect'))
    expect(mockClose).toHaveBeenCalled()
  })

  it('documents the guest overlay class contract that keeps video full-frame', () => {
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('streaming')
    })

    expect(
      screen.getByTestId('remote-guest-controls-panel')
    ).toBeInTheDocument()
    // jsdom does not evaluate Tailwind layout; these assertions intentionally
    // lock the class contract that the native E2E geometry lane verifies in-app.
    expect(screen.getByTestId('remote-viewer-shell').className).toContain(
      'absolute'
    )
    expect(screen.getByTestId('remote-viewer-shell').className).toContain(
      'inset-0'
    )
    expect(screen.getByTestId('remote-viewer-shell').className).toContain(
      'overflow-hidden'
    )
    expect(screen.getByTestId('remote-stream-frame').className).toContain(
      'h-full'
    )
    expect(screen.getByTestId('remote-stream-frame').className).toContain(
      'w-full'
    )
    expect(screen.getByTestId('remote-stream-video').className).toContain(
      'h-full'
    )
    expect(screen.getByTestId('remote-stream-video').className).toContain(
      'w-full'
    )
    expect(screen.getByTestId('remote-stream-video').className).toContain(
      'object-cover'
    )
    expect(screen.getByTestId('remote-stream-video').className).not.toContain(
      'object-contain'
    )
  })

  it('sizes the guest video surface from decoded stream metadata', async () => {
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('streaming')
    })

    const video = screen.getByTestId('remote-stream-video')
    Object.defineProperties(video, {
      videoHeight: { configurable: true, value: 1080 },
      videoWidth: { configurable: true, value: 1728 },
    })
    act(() => {
      fireEvent.loadedMetadata(video)
    })

    expect(screen.getByTestId('remote-stream-frame').className).toContain(
      'h-full'
    )
    expect(video.className).toContain('object-cover')
    await waitFor(() =>
      expect(mockGuestSetSize).toHaveBeenCalledWith(
        expect.objectContaining({ height: 738, kind: 'logical', width: 1180 })
      )
    )
  })

  it('keeps the stream frame full-size while a replacement stream loads metadata', () => {
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('streaming')
    })

    const video = screen.getByTestId('remote-stream-video')
    Object.defineProperties(video, {
      videoHeight: { configurable: true, value: 1080 },
      videoWidth: { configurable: true, value: 1728 },
    })
    act(() => {
      fireEvent.loadedMetadata(video)
    })
    expect(screen.getByTestId('remote-stream-frame').className).toContain(
      'h-full'
    )

    act(() => {
      callbacksRef.current?.onStream?.({} as MediaStream)
    })

    expect(screen.getByTestId('remote-stream-frame').className).toContain(
      'h-full'
    )
  })

  it('uses cover rendering for portrait streams without showing bars', async () => {
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('streaming')
    })

    const video = screen.getByTestId('remote-stream-video')
    Object.defineProperties(video, {
      videoHeight: { configurable: true, value: 1920 },
      videoWidth: { configurable: true, value: 1080 },
    })
    act(() => {
      fireEvent.loadedMetadata(video)
    })

    expect(screen.getByTestId('remote-stream-frame').className).toContain(
      'h-full'
    )
    expect(video.className).toContain('h-full')
    expect(video.className).toContain('w-full')
    expect(video.className).toContain('object-cover')
    await waitFor(() =>
      expect(mockGuestSetSize).toHaveBeenCalledWith(
        expect.objectContaining({ height: 850, kind: 'logical', width: 478 })
      )
    )
  })

  it('applies stream metadata from the RAF sync path after a stream arrives', () => {
    vi.useFakeTimers()
    try {
      render(<RemoteGuestViewerOverlay />)

      act(() => {
        callbacksRef.current?.onState?.('streaming')
        callbacksRef.current?.onStream?.({} as MediaStream)
      })

      const video = screen.getByTestId('remote-stream-video')
      Object.defineProperties(video, {
        videoHeight: { configurable: true, value: 1080 },
        videoWidth: { configurable: true, value: 1728 },
      })
      act(() => {
        vi.advanceTimersToNextFrame()
      })

      expect(screen.getByTestId('remote-stream-frame').className).toContain(
        'h-full'
      )
      expect(mockGuestSetSize).toHaveBeenCalledWith(
        expect.objectContaining({ height: 738, kind: 'logical', width: 1180 })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('warns when stream metadata is not decoded before the RAF sync limit', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      render(<RemoteGuestViewerOverlay />)

      act(() => {
        callbacksRef.current?.onState?.('streaming')
        callbacksRef.current?.onStream?.({} as MediaStream)
      })

      act(() => {
        for (let index = 0; index < 60; index += 1) {
          vi.advanceTimersToNextFrame()
        }
      })

      expect(warn).toHaveBeenCalledWith(
        'Timed out waiting for remote stream metadata.'
      )
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('documents the pointer-events contract for pass-through viewer gaps', () => {
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('streaming')
    })

    const controls = screen.getByTestId('remote-guest-controls-panel')
    // The behavioral proof is in E2E; jsdom can only lock the class contract.
    expect(controls.className).toContain('pointer-events-auto')
    expect(controls.parentElement?.className).toContain('pointer-events-none')
  })

  it('uses the shared controls panel for guest status without exposing the security code', () => {
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('control_unavailable', 'Control closed')
    })

    // Identity now lives on the floating label, not the strip; the strip shows
    // the shared LIVE badge instead of a title.
    expect(screen.getByTestId('remote-guest-controls-panel')).toHaveTextContent(
      'LIVE'
    )
    expect(
      screen.getByTestId('remote-guest-controls-panel')
    ).not.toHaveTextContent('Remote easyCris')
    expect(screen.queryByTestId('remote-guest-security-code')).toBeNull()
    expect(screen.queryByText('ABCD-1234-EFGH')).toBeNull()
    expect(screen.getByText('Control closed')).toBeInTheDocument()
  })

  it('shows the shared LIVE badge and an "End" button on the guest strip', () => {
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('streaming')
    })

    expect(screen.getByTestId('remote-guest-controls-panel')).toHaveTextContent(
      'LIVE'
    )
    const endButton = screen.getByTestId('remote-guest-disconnect')
    expect(endButton).toHaveTextContent('End')
    expect(endButton).not.toHaveTextContent('Disconnect')
    expect(
      screen.getByRole('toolbar', { name: 'Remote control bar' })
    ).toBeInTheDocument()
  })

  it('shows a crosshair cursor over the video only while control is ready', () => {
    const stream = {} as MediaStream
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onStream?.(stream)
      callbacksRef.current?.onState?.('streaming')
    })
    expect(screen.getByTestId('remote-stream-video').className).not.toContain(
      'cursor-crosshair'
    )
    expect(screen.queryByTestId('remote-guest-cursor')).toBeNull()

    act(() => {
      callbacksRef.current?.onState?.('control_ready')
    })
    expect(screen.getByTestId('remote-stream-video').className).toContain(
      'cursor-crosshair'
    )
    expect(screen.queryByTestId('remote-guest-cursor')).toBeNull()

    // ...and is removed again when control is no longer ready.
    act(() => {
      callbacksRef.current?.onState?.('control_unavailable')
    })
    expect(screen.getByTestId('remote-stream-video').className).not.toContain(
      'cursor-crosshair'
    )
    expect(screen.queryByTestId('remote-guest-cursor')).toBeNull()
  })

  it('keeps guest audio compact until the audio options panel opens', () => {
    mockGetAudioDiagnostics.mockReturnValue({
      audioMuted: false,
      audioSenderCreated: true,
      localAudioTrackLive: true,
    })
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('streaming')
    })

    expect(screen.getByTestId('remote-guest-audio-mute')).toHaveAccessibleName(
      'Mute mic'
    )
    expect(screen.queryByTestId('remote-guest-mic-level')).toBeNull()
    expect(screen.queryByTestId('remote-guest-speaker-volume')).toBeNull()

    fireEvent.click(screen.getByTestId('remote-guest-audio-more'))

    expect(screen.getByTestId('remote-guest-audio-options')).toBeInTheDocument()
    expect(
      screen.getByTestId('remote-guest-speaker-volume')
    ).toBeInTheDocument()
  })

  it('does not forward Escape to the host while the guest audio options panel is open', () => {
    const stream = {} as MediaStream
    mockGetAudioDiagnostics.mockReturnValue({
      audioMuted: false,
      audioSenderCreated: true,
      localAudioTrackLive: true,
    })
    mockGetConnectionState.mockReturnValue('control_ready')
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('control_ready')
      callbacksRef.current?.onStream?.(stream)
    })

    fireEvent.click(screen.getByTestId('remote-guest-audio-more'))
    expect(screen.getByTestId('remote-guest-audio-options')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('remote-stream-video'), {
      key: 'Escape',
      code: 'Escape',
    })

    expect(mockSendInputMessage).not.toHaveBeenCalled()
  })

  it('clears stale audio options state after audio is disabled externally', () => {
    const stream = {} as MediaStream
    mockGetAudioDiagnostics.mockReturnValue({
      audioMuted: false,
      audioSenderCreated: true,
      localAudioTrackLive: true,
    })
    mockGetConnectionState.mockReturnValue('control_ready')
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('control_ready')
      callbacksRef.current?.onStream?.(stream)
    })

    fireEvent.click(screen.getByTestId('remote-guest-audio-more'))
    expect(screen.getByTestId('remote-guest-audio-options')).toBeInTheDocument()

    act(() => {
      callbacksRef.current?.onState?.('error')
      callbacksRef.current?.onState?.('control_ready')
      callbacksRef.current?.onStream?.(stream)
    })

    expect(
      screen.queryByTestId('remote-guest-audio-options')
    ).not.toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('remote-stream-video'), {
      key: 'Escape',
      code: 'Escape',
    })

    expect(mockSendInputMessage).toHaveBeenCalledWith({
      type: 'key',
      event: expect.objectContaining({
        action: 'click',
        key: { kind: 'named', value: 'escape' },
      }),
    })
  })

  it('shows informational guidance when guest playback is blocked', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
      new DOMException('', 'NotAllowedError')
    )
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('streaming')
    })
    fireEvent.click(screen.getByTestId('remote-guest-audio-enable'))

    await waitFor(() => expect(mockEnableAudio).toHaveBeenCalled())
    expect(toast.info).toHaveBeenCalledWith(
      'Remote audio playback was blocked. Turn audio off and on to retry.'
    )
  })

  it('unmounts when disconnect emits idle state', async () => {
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('streaming')
    })
    expect(
      screen.getByTestId('remote-guest-viewer-overlay')
    ).toBeInTheDocument()

    mockClose.mockImplementationOnce(() => {
      callbacksRef.current?.onState?.('idle')
    })
    fireEvent.click(screen.getByTestId('remote-guest-disconnect'))

    await waitFor(() =>
      expect(
        screen.queryByTestId('remote-guest-viewer-overlay')
      ).not.toBeInTheDocument()
    )
  })

  it('drops queued pointer movement after the session stops streaming', () => {
    vi.useFakeTimers()
    try {
      const stream = {} as MediaStream
      mockGetConnectionState.mockReturnValue('control_ready')
      render(<RemoteGuestViewerOverlay />)

      act(() => {
        callbacksRef.current?.onState?.('control_ready')
        callbacksRef.current?.onStream?.(stream)
      })
      const video = screen.getByTestId('remote-stream-video')
      installVideoGeometry(video)

      fireEvent.pointerMove(video, { clientX: 640, clientY: 360 })
      act(() => {
        vi.advanceTimersToNextFrame()
      })

      expect(mockSendInputMessage).toHaveBeenCalled()
      mockSendInputMessage.mockClear()

      fireEvent.pointerMove(video, { clientX: 640, clientY: 360 })
      mockGetConnectionState.mockReturnValue('idle')
      act(() => {
        callbacksRef.current?.onState?.('idle')
        vi.advanceTimersToNextFrame()
      })

      expect(mockSendInputMessage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends a mouse release from the last valid point when pointerup lands outside the video', () => {
    const stream = {} as MediaStream
    mockGetConnectionState.mockReturnValue('control_ready')
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('control_ready')
      callbacksRef.current?.onStream?.(stream)
    })
    const video = screen.getByTestId('remote-stream-video')
    installVideoGeometry(video)
    Object.defineProperties(video, {
      hasPointerCapture: {
        configurable: true,
        value: vi.fn(() => true),
      },
      releasePointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
      setPointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
    })

    fireEvent.pointerDown(video, {
      button: 0,
      clientX: 640,
      clientY: 360,
      pointerId: 1,
    })
    fireEvent.pointerUp(video, {
      button: 0,
      clientX: 1400,
      clientY: 360,
      pointerId: 1,
    })

    expect(mockSendInputMessage).toHaveBeenLastCalledWith({
      type: 'mouse',
      event: expect.objectContaining({
        action: 'up',
        button: 'left',
        normalized_x: 0.5,
        normalized_y: 0.5,
      }),
    })
  })

  it('keeps the active button for rapid pointerup events that report button -1', () => {
    const stream = {} as MediaStream
    mockGetConnectionState.mockReturnValue('control_ready')
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('control_ready')
      callbacksRef.current?.onStream?.(stream)
    })
    const video = screen.getByTestId('remote-stream-video')
    installVideoGeometry(video)
    Object.defineProperties(video, {
      hasPointerCapture: {
        configurable: true,
        value: vi.fn(() => true),
      },
      releasePointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
      setPointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
    })

    fireEvent.pointerDown(video, {
      button: 0,
      clientX: 640,
      clientY: 360,
      pointerId: 1,
    })
    fireEvent.pointerUp(video, {
      button: 0,
      clientX: 640,
      clientY: 360,
      pointerId: 1,
    })
    fireEvent.pointerDown(video, {
      button: 0,
      clientX: 650,
      clientY: 370,
      pointerId: 1,
    })
    mockSendInputMessage.mockClear()

    fireEvent.pointerUp(video, {
      button: -1,
      clientX: 650,
      clientY: 370,
      pointerId: 1,
    })

    expect(mockSendInputMessage).toHaveBeenCalledWith({
      type: 'mouse',
      event: expect.objectContaining({
        action: 'up',
        button: 'left',
        normalized_x: 0.507813,
        normalized_y: 0.513889,
      }),
    })
  })

  it('sends a best-effort release after control state drops mid-press', () => {
    const stream = {} as MediaStream
    mockGetConnectionState.mockReturnValue('control_ready')
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('control_ready')
      callbacksRef.current?.onStream?.(stream)
    })
    const video = screen.getByTestId('remote-stream-video')
    installVideoGeometry(video)
    Object.defineProperties(video, {
      hasPointerCapture: {
        configurable: true,
        value: vi.fn(() => false),
      },
      setPointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
    })

    fireEvent.pointerDown(video, {
      button: 0,
      clientX: 640,
      clientY: 360,
      pointerId: 1,
    })
    mockSendInputMessage.mockClear()

    mockGetConnectionState.mockReturnValue('idle')
    act(() => {
      callbacksRef.current?.onState?.('idle')
    })
    fireEvent.lostPointerCapture(video, { pointerId: 1 })

    expect(mockSendInputMessage).toHaveBeenCalledWith({
      type: 'mouse',
      event: expect.objectContaining({
        action: 'up',
        button: 'left',
      }),
    })
  })

  it('sends a best-effort release when pointer capture is lost mid-press', () => {
    const stream = {} as MediaStream
    mockGetConnectionState.mockReturnValue('control_ready')
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('control_ready')
      callbacksRef.current?.onStream?.(stream)
    })
    const video = screen.getByTestId('remote-stream-video')
    installVideoGeometry(video)
    Object.defineProperties(video, {
      hasPointerCapture: {
        configurable: true,
        value: vi.fn(() => false),
      },
      setPointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
    })

    fireEvent.pointerDown(video, {
      button: 0,
      clientX: 640,
      clientY: 360,
      pointerId: 1,
    })
    mockSendInputMessage.mockClear()

    fireEvent.lostPointerCapture(video, { pointerId: 1 })

    expect(mockSendInputMessage).toHaveBeenCalledTimes(1)
    expect(mockSendInputMessage).toHaveBeenCalledWith({
      type: 'mouse',
      event: expect.objectContaining({
        action: 'up',
        button: 'left',
      }),
    })
  })

  it('sends a best-effort release when the video blurs mid-press', () => {
    const stream = {} as MediaStream
    mockGetConnectionState.mockReturnValue('control_ready')
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('control_ready')
      callbacksRef.current?.onStream?.(stream)
    })
    const video = screen.getByTestId('remote-stream-video')
    installVideoGeometry(video)
    Object.defineProperties(video, {
      hasPointerCapture: {
        configurable: true,
        value: vi.fn(() => false),
      },
      setPointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
    })

    fireEvent.pointerDown(video, {
      button: 0,
      clientX: 640,
      clientY: 360,
      pointerId: 1,
    })
    mockSendInputMessage.mockClear()

    fireEvent.blur(video)

    expect(mockSendInputMessage).toHaveBeenCalledTimes(1)
    expect(mockSendInputMessage).toHaveBeenCalledWith({
      type: 'mouse',
      event: expect.objectContaining({
        action: 'up',
        button: 'left',
      }),
    })
  })

  it('sends a best-effort release when the pointer leaves the video mid-press', () => {
    const stream = {} as MediaStream
    mockGetConnectionState.mockReturnValue('control_ready')
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('control_ready')
      callbacksRef.current?.onStream?.(stream)
    })
    const video = screen.getByTestId('remote-stream-video')
    installVideoGeometry(video)
    Object.defineProperties(video, {
      hasPointerCapture: {
        configurable: true,
        value: vi.fn(() => false),
      },
      setPointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
    })

    fireEvent.pointerDown(video, {
      button: 0,
      clientX: 640,
      clientY: 360,
      pointerId: 1,
    })
    mockSendInputMessage.mockClear()

    fireEvent.pointerLeave(video)

    expect(mockSendInputMessage).toHaveBeenCalledTimes(1)
    expect(mockSendInputMessage).toHaveBeenCalledWith({
      type: 'mouse',
      event: expect.objectContaining({
        action: 'up',
        button: 'left',
      }),
    })
  })

  it('keeps video visible but does not send input before control is ready', () => {
    vi.useFakeTimers()
    try {
      const stream = {} as MediaStream
      render(<RemoteGuestViewerOverlay />)

      act(() => {
        callbacksRef.current?.onState?.(
          'streaming',
          'Remote video is connected. Waiting for remote control channel.'
        )
        callbacksRef.current?.onStream?.(stream)
      })

      const video = screen.getByTestId('remote-stream-video')
      installVideoGeometry(video)
      fireEvent.pointerMove(video, { clientX: 640, clientY: 360 })
      act(() => {
        vi.advanceTimersToNextFrame()
      })

      expect(
        screen.getByTestId('remote-guest-viewer-overlay')
      ).toBeInTheDocument()
      expect(
        screen.getByText(/Waiting for remote control channel/i)
      ).toBeInTheDocument()
      expect(mockSendInputMessage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps video visible and disables input after the control channel closes', () => {
    vi.useFakeTimers()
    try {
      const stream = {} as MediaStream
      render(<RemoteGuestViewerOverlay />)

      act(() => {
        callbacksRef.current?.onState?.(
          'control_unavailable',
          'Remote control channel closed. Video may remain visible.'
        )
        callbacksRef.current?.onStream?.(stream)
      })

      const video = screen.getByTestId('remote-stream-video')
      installVideoGeometry(video)
      fireEvent.pointerMove(video, { clientX: 640, clientY: 360 })
      act(() => {
        vi.advanceTimersToNextFrame()
      })

      expect(
        screen.getByTestId('remote-guest-viewer-overlay')
      ).toBeInTheDocument()
      const status = screen.getByText(/control channel closed/i)
      expect(status.className).toContain('max-w-[18rem]')
      expect(status.className.split(/\s+/)).not.toContain('hidden')
      expect(mockSendInputMessage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears stale audio state when a new approval arrives before streaming', async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined)
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('streaming')
    })
    fireEvent.click(screen.getByTestId('remote-guest-audio-enable'))
    await waitFor(() => expect(mockEnableAudio).toHaveBeenCalled())
    expect(play).toHaveBeenCalled()
    // Audio on → split control (mute toggle) is shown, enable button is gone.
    expect(screen.getByTestId('remote-guest-audio-mute')).toBeInTheDocument()
    expect(
      screen.queryByTestId('remote-guest-audio-enable')
    ).not.toBeInTheDocument()

    act(() => {
      callbacksRef.current?.onState?.('approved')
      callbacksRef.current?.onState?.('streaming')
    })

    // Reset back to audio-off → enable button returns, split control is gone.
    expect(screen.getByTestId('remote-guest-audio-enable')).toBeInTheDocument()
    expect(
      screen.queryByTestId('remote-guest-audio-mute')
    ).not.toBeInTheDocument()
  })

  it('shows errors reported by the subscribed session', () => {
    render(<RemoteGuestViewerOverlay />)

    act(() => {
      callbacksRef.current?.onState?.('streaming')
      callbacksRef.current?.onError?.('Remote failed')
    })

    expect(screen.getByText('Remote failed')).toBeInTheDocument()
  })

  describe('draggable guest controls panel', () => {
    const getWrapper = () => screen.getByTestId('remote-guest-controls-wrapper')

    const startStreaming = () => {
      act(() => {
        callbacksRef.current?.onState?.('streaming')
      })
    }

    it('renders controls in a wrapper with a stable testid', () => {
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      expect(getWrapper()).toBeInTheDocument()
      expect(
        getWrapper().querySelector(
          '[data-testid="remote-guest-controls-panel"]'
        )
      ).toBeInTheDocument()
    })

    it('shows a separate bottom identity label by default', () => {
      useRemoteSessionStore.setState({
        status: {
          current_session: {
            host_device_id: 'host-device-id',
            host_display_name: 'Work laptop',
          },
        },
      } as never)
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      // Slim single-line label: no "Remote easyCris" title, just the sentence.
      expect(
        screen.getByTestId('remote-guest-identity-label')
      ).not.toHaveTextContent('Remote easyCris')
      expect(
        screen.getByTestId('remote-guest-identity-label')
      ).toHaveTextContent('You are controlling host host-device-id easyCris')
      expect(screen.getByTestId('remote-guest-identity-label')).not.toHaveClass(
        'w-full'
      )
      expect(
        screen.getByTestId('remote-guest-identity-label')
      ).not.toHaveTextContent('Security code')
    })

    it('uses a clean host fallback instead of "this host"', () => {
      useRemoteSessionStore.setState({
        status: {
          current_session: {
            host_device_id: '',
            host_display_name: '',
          },
        },
      } as never)
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      expect(
        screen.getByTestId('remote-guest-identity-label')
      ).toHaveTextContent('You are controlling host easyCris')
      expect(
        screen.getByTestId('remote-guest-identity-label')
      ).not.toHaveTextContent('this host')
    })

    it('falls back to the approved host device id when current session id is empty', () => {
      useRemoteSessionStore.setState({
        guestHostDeviceId: 'host-from-approval',
        status: {
          current_session: {
            host_device_id: '',
            host_display_name: '',
          },
        },
      } as never)
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      expect(
        screen.getByTestId('remote-guest-identity-label')
      ).toHaveTextContent(
        'You are controlling host host-from-approval easyCris'
      )
    })

    it('uses the approved host device id when guest status has no current session', () => {
      useRemoteSessionStore.setState({
        guestHostDeviceId: 'host-from-approval',
        status: null,
      } as never)
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      expect(
        screen.getByTestId('remote-guest-identity-label')
      ).toHaveTextContent(
        'You are controlling host host-from-approval easyCris'
      )
    })

    it('hides and restores the separate bottom identity label from the controls', () => {
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      fireEvent.click(screen.getByTestId('remote-guest-identity-toggle'))
      expect(
        screen.queryByTestId('remote-guest-identity-label')
      ).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId('remote-guest-identity-toggle'))
      expect(
        screen.getByTestId('remote-guest-identity-label')
      ).toBeInTheDocument()
    })

    it('starts with default top-center positioning (no inline left/top style)', () => {
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      const wrapper = getWrapper()
      expect(wrapper.style.left).not.toMatch(/^\d+px$/)
      expect(wrapper.style.top).not.toMatch(/^\d+px$/)
    })

    it('moves the controls wrapper when dragged from the drag handle', () => {
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      const wrapper = getWrapper()
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
        left: 400,
        top: 12,
        right: 880,
        bottom: 80,
        width: 480,
        height: 68,
        x: 400,
        y: 12,
        toJSON: () => ({}),
      } as DOMRect)
      Object.defineProperty(wrapper, 'offsetWidth', {
        configurable: true,
        value: 480,
      })
      Object.defineProperty(wrapper, 'offsetHeight', {
        configurable: true,
        value: 68,
      })

      const handle = screen.getByTestId('remote-controls-drag-handle')
      fireEvent.pointerDown(handle, { button: 0, clientX: 640, clientY: 40 })

      act(() => {
        fireEvent.pointerMove(window, { clientX: 700, clientY: 80 })
      })

      // wrapper should now have inline pixel positioning
      expect(getWrapper().style.left).toMatch(/^\d+(\.\d+)?px$/)
      expect(getWrapper().style.top).toMatch(/^\d+(\.\d+)?px$/)
    })

    it('keeps the guest identity label click-through except for its drag handle', () => {
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      const wrapper = screen.getByTestId('remote-guest-identity-label-wrapper')
      const label = screen.getByTestId('remote-guest-identity-label')
      const handle = screen.getByTestId('remote-guest-identity-label-drag')

      expect(wrapper.className).toContain('pointer-events-none')
      expect(label.className).toContain('pointer-events-none')
      expect(handle.className).toContain('pointer-events-auto')
    })

    it('moves the identity label when dragged from its handle', () => {
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      const wrapper = screen.getByTestId('remote-guest-identity-label-wrapper')
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
        left: 380,
        top: 760,
        right: 780,
        bottom: 808,
        width: 400,
        height: 48,
        x: 380,
        y: 760,
        toJSON: () => ({}),
      } as DOMRect)
      Object.defineProperty(wrapper, 'offsetWidth', {
        configurable: true,
        value: 400,
      })
      Object.defineProperty(wrapper, 'offsetHeight', {
        configurable: true,
        value: 48,
      })

      fireEvent.pointerDown(
        screen.getByTestId('remote-guest-identity-label-drag'),
        {
          button: 0,
          clientX: 480,
          clientY: 780,
        }
      )

      act(() => {
        fireEvent.pointerMove(window, { clientX: 520, clientY: 740 })
      })

      expect(wrapper.style.left).toMatch(/^\d+(\.\d+)?px$/)
      expect(wrapper.style.top).toMatch(/^\d+(\.\d+)?px$/)
    })

    it('constrains the panel within the viewport on drag', () => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 1280,
      })
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 720,
      })

      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      const wrapper = getWrapper()
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
        left: 10,
        top: 10,
        right: 490,
        bottom: 78,
        width: 480,
        height: 68,
        x: 10,
        y: 10,
        toJSON: () => ({}),
      } as DOMRect)
      Object.defineProperty(wrapper, 'offsetWidth', {
        configurable: true,
        value: 480,
      })
      Object.defineProperty(wrapper, 'offsetHeight', {
        configurable: true,
        value: 68,
      })

      const handle = screen.getByTestId('remote-controls-drag-handle')
      fireEvent.pointerDown(handle, { button: 0, clientX: 250, clientY: 44 })

      act(() => {
        // drag far off-screen to the right and down
        fireEvent.pointerMove(window, { clientX: 9999, clientY: 9999 })
      })

      const left = parseFloat(getWrapper().style.left)
      const top = parseFloat(getWrapper().style.top)
      expect(left).toBeLessThanOrEqual(1280 - 480) // right edge within viewport
      expect(top).toBeLessThanOrEqual(720 - 68) // bottom edge within viewport
      expect(left).toBeGreaterThanOrEqual(0)
      expect(top).toBeGreaterThanOrEqual(0)
    })

    it('keeps an oversized controls wrapper clamped at the viewport origin', () => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 320,
      })
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 180,
      })

      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      const wrapper = getWrapper()
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
        left: 10,
        top: 10,
        right: 490,
        bottom: 230,
        width: 480,
        height: 220,
        x: 10,
        y: 10,
        toJSON: () => ({}),
      } as DOMRect)
      Object.defineProperty(wrapper, 'offsetWidth', {
        configurable: true,
        value: 480,
      })
      Object.defineProperty(wrapper, 'offsetHeight', {
        configurable: true,
        value: 220,
      })

      const handle = screen.getByTestId('remote-controls-drag-handle')
      fireEvent.pointerDown(handle, { button: 0, clientX: 250, clientY: 44 })

      act(() => {
        fireEvent.pointerMove(window, { clientX: 9999, clientY: 9999 })
      })

      expect(parseFloat(getWrapper().style.left)).toBe(0)
      expect(parseFloat(getWrapper().style.top)).toBe(0)
    })

    it('does not render the Fit/Fill resize button', () => {
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      expect(screen.queryByTestId('remote-viewer-fit')).not.toBeInTheDocument()
      expect(screen.queryByTestId('remote-viewer-fill')).not.toBeInTheDocument()
    })

    it('moves the controls wrapper when dragged from a non-handle bar element, not only the handle', () => {
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      const wrapper = getWrapper()
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
        left: 400,
        top: 12,
        right: 880,
        bottom: 80,
        width: 480,
        height: 68,
        x: 400,
        y: 12,
        toJSON: () => ({}),
      } as DOMRect)
      Object.defineProperty(wrapper, 'offsetWidth', {
        configurable: true,
        value: 480,
      })
      Object.defineProperty(wrapper, 'offsetHeight', {
        configurable: true,
        value: 68,
      })

      // Grab the bar by its root container (the element that actually owns the
      // pointerdown drag handler), proving the whole bar is a drag surface and
      // not just the icon handle.
      const panel = screen.getByTestId('remote-guest-controls-panel')
      fireEvent.pointerDown(panel, { button: 0, clientX: 640, clientY: 40 })
      act(() => {
        fireEvent.pointerMove(window, { clientX: 700, clientY: 80 })
      })

      expect(getWrapper().style.left).toMatch(/^\d+(\.\d+)?px$/)
      expect(getWrapper().style.top).toMatch(/^\d+(\.\d+)?px$/)

      // A non-interactive bar element (the LIVE badge) is also a valid grab
      // point — pointer-down bubbles to the bar's drag handler.
      const liveBadge = within(panel).getByText('LIVE')
      fireEvent.pointerDown(liveBadge, { button: 0, clientX: 640, clientY: 40 })
      act(() => {
        fireEvent.pointerMove(window, { clientX: 710, clientY: 90 })
      })
      expect(getWrapper().style.left).toMatch(/^\d+(\.\d+)?px$/)
    })

    it('does not start a drag when the gesture begins on the disconnect button', () => {
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      const wrapper = getWrapper()
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
        left: 400,
        top: 12,
        right: 880,
        bottom: 80,
        width: 480,
        height: 68,
        x: 400,
        y: 12,
        toJSON: () => ({}),
      } as DOMRect)
      Object.defineProperty(wrapper, 'offsetWidth', {
        configurable: true,
        value: 480,
      })
      Object.defineProperty(wrapper, 'offsetHeight', {
        configurable: true,
        value: 68,
      })

      const disconnect = screen.getByTestId('remote-guest-disconnect')
      fireEvent.pointerDown(disconnect, {
        button: 0,
        clientX: 640,
        clientY: 40,
      })
      act(() => {
        fireEvent.pointerMove(window, { clientX: 700, clientY: 80 })
      })

      // No drag origin captured → wrapper stays at default top-center positioning.
      expect(getWrapper().style.left).toBe('50%')
      expect(getWrapper().style.top).toBe('0.75rem')
    })

    it('does not start a drag when the gesture begins on the audio menu caret', async () => {
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)

      render(<RemoteGuestViewerOverlay />)
      startStreaming()
      fireEvent.click(screen.getByTestId('remote-guest-audio-enable'))

      const wrapper = getWrapper()
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
        left: 400,
        top: 12,
        right: 880,
        bottom: 80,
        width: 480,
        height: 68,
        x: 400,
        y: 12,
        toJSON: () => ({}),
      } as DOMRect)
      Object.defineProperty(wrapper, 'offsetWidth', {
        configurable: true,
        value: 480,
      })
      Object.defineProperty(wrapper, 'offsetHeight', {
        configurable: true,
        value: 68,
      })

      const moreButton = await screen.findByTestId('remote-guest-audio-more')
      fireEvent.pointerDown(moreButton, {
        button: 0,
        clientX: 640,
        clientY: 40,
      })
      act(() => {
        fireEvent.pointerMove(window, { clientX: 700, clientY: 80 })
      })

      expect(getWrapper().style.left).toBe('50%')
      expect(getWrapper().style.top).toBe('0.75rem')
    })

    it('stops moving the panel after pointerup on window', () => {
      render(<RemoteGuestViewerOverlay />)
      startStreaming()

      const wrapper = getWrapper()
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
        left: 400,
        top: 12,
        right: 880,
        bottom: 80,
        width: 480,
        height: 68,
        x: 400,
        y: 12,
        toJSON: () => ({}),
      } as DOMRect)
      Object.defineProperty(wrapper, 'offsetWidth', {
        configurable: true,
        value: 480,
      })
      Object.defineProperty(wrapper, 'offsetHeight', {
        configurable: true,
        value: 68,
      })

      const handle = screen.getByTestId('remote-controls-drag-handle')
      fireEvent.pointerDown(handle, { button: 0, clientX: 640, clientY: 40 })
      act(() => {
        fireEvent.pointerMove(window, { clientX: 700, clientY: 80 })
      })
      const posAfterDrag = getWrapper().style.left

      act(() => {
        fireEvent.pointerUp(window)
      })
      act(() => {
        // subsequent moves should not change position
        fireEvent.pointerMove(window, { clientX: 900, clientY: 200 })
      })

      expect(getWrapper().style.left).toBe(posAfterDrag)
    })
  })
})
