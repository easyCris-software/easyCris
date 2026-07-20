import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'

const remoteSessionServiceMock = vi.hoisted(() => ({
  noteRemoteSessionGuestPending: vi.fn(),
  sendRemoteKeyInput: vi.fn(),
  sendRemoteMouseInput: vi.fn(),
}))

const tauriCoreMock = vi.hoisted(() => {
  class MockChannel<T = unknown> {
    static latest: { onmessage: ((message: unknown) => void) | null } | null =
      null
    onmessage: ((message: T) => void) | null = null

    constructor() {
      MockChannel.latest = this as {
        onmessage: ((message: unknown) => void) | null
      }
    }
  }

  return {
    Channel: MockChannel,
    invoke: vi.fn(),
  }
})

const tauriWindowMock = vi.hoisted(() => ({
  getCurrentWindow: vi.fn(),
}))

vi.mock('./remoteSessionService', () => remoteSessionServiceMock)

vi.mock('@tauri-apps/api/core', () => tauriCoreMock)

vi.mock('@tauri-apps/api/window', () => tauriWindowMock)

import {
  REMOTE_VIDEO_CLOUD_BITRATE_BPS,
  REMOTE_VIDEO_LAN_BITRATE_BPS,
  REMOTE_VIDEO_MAX_FRAMERATE,
  REMOTE_VIDEO_RELAY_BITRATE_BPS,
  applyRemoteCaptureResolutionLimit,
  applyRemoteCodecPreferences,
  applyRemoteSenderBitratePolicy,
  applyRemoteVideoTrackHint,
  createRemoteMediaDiagnostics,
  getRemoteCaptureStream,
  getRemoteCaptureConstraints,
  isE2ERemoteCaptureMockEnabled,
  remoteWebRtcHost,
  selectedRemoteCandidateTypeFromStats,
} from './remoteWebRtcHost'

const setViewportSize = (width: number, height: number, devicePixelRatio = 1) => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  })
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: height,
  })
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: devicePixelRatio,
  })
}

beforeEach(() => {
  setViewportSize(1024, 768)
  tauriWindowMock.getCurrentWindow.mockReturnValue({
    innerSize: vi.fn().mockResolvedValue({ height: 768, width: 1024 }),
    onResized: vi.fn().mockResolvedValue(() => undefined),
    setSize: vi.fn().mockResolvedValue(undefined),
  })
})

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static latest: FakeWebSocket | null = null

  readyState = FakeWebSocket.OPEN
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  url: string

  constructor(url: string) {
    this.url = url
    FakeWebSocket.latest = this
    queueMicrotask(() => this.onopen?.())
  }

  send(raw: string) {
    this.sent.push(raw)
  }

  close() {
    queueMicrotask(() => this.onclose?.())
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
}

const nativeCaptureStartResult = () => ({
  capture_id: 'capture-1',
  frame_height: 720,
  frame_width: 1280,
  surface_kind: 'easycris-window' as const,
})

const stubNativeRemoteCapture = (
  trackOverrides: Partial<MediaStreamTrack> = {}
) => {
  const videoTrack = {
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    contentHint: '',
    getSettings: () => ({ height: 720, width: 1280 }),
    kind: 'video',
    stop: vi.fn(),
    ...trackOverrides,
  } as unknown as MediaStreamTrack
  const writer = {
    close: vi.fn().mockResolvedValue(undefined),
    desiredSize: 1,
    write: vi.fn().mockResolvedValue(undefined),
  }

  class MockMediaStream {
    constructor(private readonly tracks: MediaStreamTrack[]) {}
    getTracks() {
      return this.tracks
    }
    getVideoTracks() {
      return this.tracks.filter(track => track.kind === 'video')
    }
  }

  class MockGenerator {
    writable = { getWriter: () => writer }
    track = videoTrack
  }

  class MockVideoFrame {
    close = vi.fn()
  }

  vi.stubGlobal('MediaStream', MockMediaStream)
  vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
  vi.stubGlobal('VideoFrame', MockVideoFrame)
  tauriCoreMock.invoke.mockImplementation(command => {
    if (command === 'start_native_screen_capture') {
      return Promise.resolve(nativeCaptureStartResult())
    }
    if (command === 'stop_native_screen_capture') {
      return Promise.resolve()
    }
    return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
  })

  return { videoTrack, writer }
}

describe('remoteWebRtcHost E2E capture gate', () => {
  afterEach(async () => {
    await remoteWebRtcHost.close(false)
  })

  it('enables mock capture only in e2e mode with explicit flag', () => {
    expect(isE2ERemoteCaptureMockEnabled('e2e', undefined, true)).toBe(true)
    expect(isE2ERemoteCaptureMockEnabled('test', 'true', true)).toBe(true)
    expect(isE2ERemoteCaptureMockEnabled('e2e', undefined, false)).toBe(false)
    expect(isE2ERemoteCaptureMockEnabled('development', undefined, true)).toBe(
      false
    )
  })

  it('seeds the host capture rect before returning the E2E mock stream', async () => {
    const videoTrack = {
      kind: 'video',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const stream = {
      getTracks: () => [videoTrack],
      getVideoTracks: () => [videoTrack],
    } as unknown as MediaStream
    const context = {
      fillRect: vi.fn(),
      fillText: vi.fn(),
      fillStyle: '',
      font: '',
    }
    const canvas = {
      captureStream: vi.fn(() => stream),
      getContext: vi.fn(() => context),
      height: 0,
      width: 0,
    } as unknown as HTMLCanvasElement
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockReturnValue(canvas)
    vi.stubEnv('VITE_E2E_ENABLED', 'true')
    window.__E2E_REMOTE_CAPTURE_MOCK__ = true
    tauriCoreMock.invoke.mockResolvedValue(undefined)

    try {
      await expect(getRemoteCaptureStream()).resolves.toBe(stream)
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'set_e2e_remote_capture_rect'
      )
      expect(canvas.captureStream).toHaveBeenCalledWith(10)
    } finally {
      window.__E2E_REMOTE_CAPTURE_MOCK__ = false
      createElement.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('exposes a data-channel wait gate for E2E harnesses', async () => {
    await expect(remoteWebRtcHost.waitForDataChannelOpen(1)).rejects.toThrow(
      'Remote-session data channel is not active'
    )
  })

  it('rejects pending data-channel waiters when the local peer closes', async () => {
    const host = remoteWebRtcHost as unknown as {
      peerConnection: { close: () => void } | null
      dataChannel: { readyState: string; close: () => void } | null
      close: (notify?: boolean) => Promise<void>
      waitForDataChannelOpen: (timeoutMs?: number) => Promise<void>
    }

    host.peerConnection = { close: () => undefined }
    host.dataChannel = { readyState: 'connecting', close: () => undefined }

    const waiter = host.waitForDataChannelOpen(1000)
    await host.close(false)

    await expect(waiter).rejects.toThrow(
      'Remote-session data channel closed before opening'
    )
  })

  it('rejects pending data-channel waiters when the channel closes abruptly', async () => {
    const stop = vi.fn()
    const close = vi.fn()
    const host = remoteWebRtcHost as unknown as {
      peerConnection: { close: () => void } | null
      dataChannel: { readyState: string; close: () => void } | null
      stream: { getTracks: () => { stop: () => void }[] } | null
      mediaSenders: unknown[]
      mediaDiagnostics: ReturnType<typeof createRemoteMediaDiagnostics>
      dataChannelCloseHandled: boolean
      getMediaDiagnostics: () => ReturnType<typeof createRemoteMediaDiagnostics>
      handleDataChannelClose: () => void
      waitForDataChannelOpen: (timeoutMs?: number) => Promise<void>
    }

    host.peerConnection = { close }
    host.dataChannel = { readyState: 'connecting', close: () => undefined }
    host.stream = { getTracks: () => [{ stop }] }
    host.mediaSenders = [{}]
    host.mediaDiagnostics = createRemoteMediaDiagnostics()
    host.dataChannelCloseHandled = false

    const waiter = host.waitForDataChannelOpen(1000)
    host.handleDataChannelClose()

    await expect(waiter).rejects.toThrow('Remote-session data channel closed')
    expect(close).toHaveBeenCalled()
    expect(host.peerConnection).toBeNull()
    expect(host.dataChannel).toBeNull()
    expect(host.mediaSenders).toEqual([])
    expect(stop).toHaveBeenCalled()
    expect(host.stream).toBeNull()
    expect(host.getMediaDiagnostics()).toMatchObject({
      captureTrackStopped: true,
      peerConnectionClosedAfterDataChannelClose: true,
    })
  })

  it('replays the remote audio stream when host callbacks reconnect to an active session', async () => {
    const stream = {} as MediaStream
    const onRemoteAudioStream = vi.fn()
    const host = remoteWebRtcHost as unknown as {
      remoteAudioStream: MediaStream | null
      sessionId: string | null
      transport: { close: () => void } | null
      transportConnected: boolean
    }
    host.transport = { close: vi.fn() }
    host.transportConnected = true
    host.sessionId = 'session-1'
    host.remoteAudioStream = stream

    await remoteWebRtcHost.connect({
      mode: 'lan',
      sessionId: 'session-1',
      signalingPort: 49152,
      token: 'invite-token',
      callbacks: { onRemoteAudioStream },
    })

    expect(onRemoteAudioStream).toHaveBeenCalledWith(stream)
  })

  it('keeps subscribed host controls active after preferences callbacks are replaced', async () => {
    const session = remoteWebRtcHost as unknown as {
      callbacks: Record<string, unknown>
      remoteAudioStream: MediaStream | null
      securityCode: string | null
      subscribe: (callbacks: {
        onSecurityCode?: (code: string | null) => void
        onRemoteAudioStream?: (stream: MediaStream) => void
      }) => () => void
    }
    const stream = {} as MediaStream
    const onSecurityCode = vi.fn()
    const onRemoteAudioStream = vi.fn()

    session.remoteAudioStream = stream
    session.securityCode = '1234-ABCD-EF90'
    const unsubscribe = session.subscribe({
      onSecurityCode,
      onRemoteAudioStream,
    })

    session.callbacks = {}

    expect(onSecurityCode).toHaveBeenCalledWith('1234-ABCD-EF90')
    expect(onRemoteAudioStream).toHaveBeenCalledWith(stream)

    unsubscribe()
  })
})

describe('remoteWebRtcHost media policy', () => {
  beforeEach(() => {
    setViewportSize(1024, 768)
    tauriWindowMock.getCurrentWindow.mockReturnValue({
      innerSize: vi.fn().mockResolvedValue({ height: 768, width: 1024 }),
      onResized: vi.fn().mockResolvedValue(() => undefined),
      setSize: vi.fn().mockResolvedValue(undefined),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    tauriCoreMock.invoke.mockReset()
    tauriWindowMock.getCurrentWindow.mockReset()
  })

  it('requests window capture without audio at capped frame rate', () => {
    expect(getRemoteCaptureConstraints()).toEqual({
      video: {
        displaySurface: 'window',
        frameRate: { ideal: 15, max: REMOTE_VIDEO_MAX_FRAMERATE },
        height: { ideal: 1080, max: 1080 },
        width: { ideal: 1920, max: 1920 },
      },
      audio: false,
    })
  })

  it('uses native capture when frame generators are available', async () => {
    const track = {
      kind: 'video',
      stop: vi.fn(),
      contentHint: '',
    } as unknown as MediaStreamTrack
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    class MockMediaStream {
      tracks: MediaStreamTrack[]
      constructor(tracks: MediaStreamTrack[]) {
        this.tracks = tracks
      }
      getTracks() {
        return this.tracks
      }
      getVideoTracks() {
        return this.tracks
      }
    }
    class MockGenerator {
      writable = { getWriter: () => writer }
      track = track
    }
    class MockVideoFrame {
      close = vi.fn()
      constructor(
        public readonly data: Uint8Array,
        public readonly init: Record<string, unknown>
      ) {}
    }

    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal('VideoFrame', MockVideoFrame)
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn() } })
    tauriCoreMock.invoke.mockResolvedValue(nativeCaptureStartResult())

    const stream = await getRemoteCaptureStream()
    const channel = tauriCoreMock.Channel.latest
    const payload = new Uint8Array(16 + 6)
    new DataView(payload.buffer).setUint32(0, 2, true)
    new DataView(payload.buffer).setUint32(4, 2, true)
    new DataView(payload.buffer).setUint32(8, 1, true)
    payload.set([16, 235, 82, 144, 100, 133], 16)

    channel?.onmessage?.(payload)
    await Promise.resolve()

    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'start_native_screen_capture',
      expect.objectContaining({
        maxFps: 15,
        maxHeight: 1080,
        maxWidth: 1920,
        onFrame: channel,
      })
    )
    expect(stream.getVideoTracks()).toEqual([track])
    const writtenFrame = writer.write.mock.calls[0]?.[0] as MockVideoFrame
    expect(Array.from(writtenFrame.data)).toEqual([
      16, 235, 82, 144, 100, 133,
    ])
    expect(writtenFrame.init).toMatchObject({
      codedHeight: 2,
      codedWidth: 2,
      format: 'NV12',
      layout: [
        { offset: 0, stride: 2 },
        { offset: 4, stride: 2 },
      ],
    })
  })

  it('accepts legacy BGRA native frame packets', async () => {
    const track = {
      kind: 'video',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    class MockMediaStream {
      constructor(private readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getVideoTracks() {
        return this.tracks
      }
    }
    class MockGenerator {
      writable = { getWriter: () => writer }
      track = track
    }
    class MockVideoFrame {
      close = vi.fn()
      constructor(
        public readonly data: Uint8Array,
        public readonly init: Record<string, unknown>
      ) {}
    }

    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal('VideoFrame', MockVideoFrame)
    tauriCoreMock.invoke.mockResolvedValue(nativeCaptureStartResult())

    await getRemoteCaptureStream()
    const channel = tauriCoreMock.Channel.latest
    const payload = new Uint8Array(16 + 8)
    new DataView(payload.buffer).setUint32(0, 2, true)
    new DataView(payload.buffer).setUint32(4, 1, true)
    payload.set([1, 2, 3, 4, 5, 6, 7, 8], 16)

    channel?.onmessage?.(payload)
    await Promise.resolve()

    const writtenFrame = writer.write.mock.calls[0]?.[0] as MockVideoFrame
    expect(Array.from(writtenFrame.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(writtenFrame.init).toMatchObject({
      codedHeight: 1,
      codedWidth: 2,
      format: 'BGRA',
    })
  })

  it('reports unsupported native frame pixel formats', async () => {
    const onNativeFrameError = vi.fn()
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    class MockMediaStream {
      constructor(private readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getVideoTracks() {
        return this.tracks
      }
    }
    class MockGenerator {
      writable = { getWriter: () => writer }
      track = {
        kind: 'video',
        stop: vi.fn(),
      } as unknown as MediaStreamTrack
    }
    const MockVideoFrame = vi.fn()

    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal('VideoFrame', MockVideoFrame)
    tauriCoreMock.invoke.mockResolvedValue(nativeCaptureStartResult())

    await getRemoteCaptureStream({ onNativeFrameError })
    const channel = tauriCoreMock.Channel.latest
    const payload = new Uint8Array(16 + 6)
    new DataView(payload.buffer).setUint32(0, 2, true)
    new DataView(payload.buffer).setUint32(4, 2, true)
    new DataView(payload.buffer).setUint32(8, 99, true)
    payload.set([16, 235, 82, 144, 100, 133], 16)

    channel?.onmessage?.(payload)

    expect(onNativeFrameError).toHaveBeenCalledWith(
      expect.objectContaining({
        byteLength: 6,
        height: 2,
        message: 'Unsupported native frame pixel format 99',
        pixelFormat: null,
        width: 2,
      })
    )
    expect(MockVideoFrame).not.toHaveBeenCalled()
    expect(writer.write).not.toHaveBeenCalled()
  })

  it('repairs a transient native viewport mismatch before starting capture', async () => {
    const track = {
      kind: 'video',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    const appWindow = {
      innerSize: vi
        .fn()
        .mockResolvedValueOnce({ height: 768, width: 1024 })
        .mockResolvedValueOnce({ height: 768, width: 1024 }),
      onResized: vi.fn().mockResolvedValue(() => undefined),
      setSize: vi.fn().mockImplementation(async () => {
        setViewportSize(1024, 768)
        window.dispatchEvent(new Event('resize'))
      }),
    }
    class MockMediaStream {
      constructor(private readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getVideoTracks() {
        return this.tracks
      }
    }
    class MockGenerator {
      writable = { getWriter: () => writer }
      track = track
    }

    setViewportSize(900, 768)
    tauriWindowMock.getCurrentWindow.mockReturnValue(appWindow)
    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal(
      'VideoFrame',
      class {
        close = vi.fn()
      }
    )
    tauriCoreMock.invoke.mockResolvedValue(nativeCaptureStartResult())

    await expect(getRemoteCaptureStream()).resolves.toBeInstanceOf(
      MockMediaStream
    )

    expect(appWindow.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ height: 768, width: 1024 })
    )
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'start_native_screen_capture',
      expect.any(Object)
    )
  })

  it('accepts a one-pixel native viewport rounding difference', async () => {
    const track = {
      kind: 'video',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    const appWindow = {
      innerSize: vi.fn().mockResolvedValue({ height: 2054, width: 3840 }),
      onResized: vi.fn().mockResolvedValue(() => undefined),
      setSize: vi.fn().mockResolvedValue(undefined),
    }
    class MockMediaStream {
      constructor(private readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getVideoTracks() {
        return this.tracks
      }
    }
    class MockGenerator {
      writable = { getWriter: () => writer }
      track = track
    }

    setViewportSize(2560, 1370, 1.5)
    tauriWindowMock.getCurrentWindow.mockReturnValue(appWindow)
    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal(
      'VideoFrame',
      class {
        close = vi.fn()
      }
    )
    tauriCoreMock.invoke.mockResolvedValue(nativeCaptureStartResult())

    await expect(getRemoteCaptureStream()).resolves.toBeInstanceOf(
      MockMediaStream
    )

    expect(appWindow.setSize).not.toHaveBeenCalled()
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'start_native_screen_capture',
      expect.any(Object)
    )
  })

  it('rejects native capture before invoking Rust when viewport mismatch persists', async () => {
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    const appWindow = {
      innerSize: vi.fn().mockResolvedValue({ height: 768, width: 1024 }),
      onResized: vi.fn().mockResolvedValue(() => undefined),
      setSize: vi.fn().mockResolvedValue(undefined),
    }
    class MockGenerator {
      writable = { getWriter: () => writer }
      track = {
        kind: 'video',
        stop: vi.fn(),
      } as unknown as MediaStreamTrack
    }

    vi.useFakeTimers()
    try {
      setViewportSize(900, 768)
      tauriWindowMock.getCurrentWindow.mockReturnValue(appWindow)
      vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
      vi.stubGlobal(
        'VideoFrame',
        class {
          close = vi.fn()
        }
      )

      const capturePromise = getRemoteCaptureStream()
      void capturePromise.catch(() => undefined) // suppress unhandled-rejection before assertion
      await vi.advanceTimersByTimeAsync(600)
      await expect(capturePromise).rejects.toThrow(
        "Native capture cannot start: the EasyCris window's display surface (900x768 px) does not match its window area (1024x768 px). Restore or maximize the EasyCris window and try again."
      )

      expect(appWindow.setSize).toHaveBeenCalledWith(
        expect.objectContaining({ height: 768, width: 1024 })
      )
      expect(tauriCoreMock.invoke).not.toHaveBeenCalled()
      expect(writer.close).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses MediaStreamTrackGenerator itself as the generated video track', async () => {
    const originalStop = vi.fn()
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    class MockMediaStream {
      constructor(private readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getVideoTracks() {
        return this.tracks.filter(track => track.kind === 'video')
      }
    }
    class MockGenerator {
      static latest: MockGenerator | null = null
      contentHint = ''
      kind = 'video'
      stop = originalStop
      writable = { getWriter: () => writer }

      constructor() {
        MockGenerator.latest = this
      }
    }

    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal('VideoTrackGenerator', undefined)
    vi.stubGlobal('VideoFrame', class {})
    tauriCoreMock.invoke.mockImplementation(command => {
      if (command === 'start_native_screen_capture') {
        return Promise.resolve(nativeCaptureStartResult())
      }
      if (command === 'stop_native_screen_capture') {
        return Promise.resolve()
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    const stream = await getRemoteCaptureStream()

    expect(stream.getVideoTracks()[0]).toBe(MockGenerator.latest)
    stream.getTracks()[0]?.stop()
    expect(originalStop).toHaveBeenCalled()
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'stop_native_screen_capture',
      { captureId: 'capture-1' }
    )
  })

  it('cleans up the native writer when the generated track shape is invalid', async () => {
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    class MockGenerator {
      writable = { getWriter: () => writer }
    }

    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal('VideoTrackGenerator', undefined)
    vi.stubGlobal('VideoFrame', class {})

    await expect(getRemoteCaptureStream()).rejects.toThrow(
      'Native capture frame generator did not expose a video track'
    )
    expect(writer.close).toHaveBeenCalled()
    expect(tauriCoreMock.invoke).not.toHaveBeenCalled()
  })

  it('stops native capture when the generated track dispatches ended', async () => {
    const listeners = new Map<string, EventListenerOrEventListenerObject>()
    const originalStop = vi.fn()
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    class MockMediaStream {
      constructor(private readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getVideoTracks() {
        return this.tracks.filter(track => track.kind === 'video')
      }
    }
    class MockGenerator {
      addEventListener = vi.fn(
        (type: string, listener: EventListenerOrEventListenerObject) => {
          listeners.set(type, listener)
        }
      )
      contentHint = ''
      kind = 'video'
      stop = originalStop
      writable = { getWriter: () => writer }
    }

    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal('VideoTrackGenerator', undefined)
    vi.stubGlobal('VideoFrame', class {})
    tauriCoreMock.invoke.mockImplementation(command => {
      if (command === 'start_native_screen_capture') {
        return Promise.resolve(nativeCaptureStartResult())
      }
      if (command === 'stop_native_screen_capture') {
        return Promise.resolve()
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    await getRemoteCaptureStream()
    const ended = listeners.get('ended')
    if (typeof ended === 'function') {
      ended(new Event('ended'))
    } else {
      ended?.handleEvent(new Event('ended'))
    }

    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'stop_native_screen_capture',
      { captureId: 'capture-1' }
    )
  })

  it('reports native frame construction failures without escaping the frame callback', async () => {
    const originalStop = vi.fn()
    const onNativeFrameError = vi.fn()
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    class MockMediaStream {
      constructor(private readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getVideoTracks() {
        return this.tracks
      }
    }
    class MockGenerator {
      writable = { getWriter: () => writer }
      track = {
        addEventListener: vi.fn(),
        kind: 'video',
        stop: originalStop,
      }
    }
    class ThrowingVideoFrame {
      constructor() {
        throw new TypeError('data is not large enough')
      }
    }

    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal('VideoTrackGenerator', undefined)
    vi.stubGlobal('VideoFrame', ThrowingVideoFrame)
    tauriCoreMock.invoke.mockResolvedValue(nativeCaptureStartResult())

    await getRemoteCaptureStream({ onNativeFrameError })
    const channel = tauriCoreMock.Channel.latest
    const payload = new Uint8Array(16 + 8)
    new DataView(payload.buffer).setUint32(0, 2, true)
    new DataView(payload.buffer).setUint32(4, 1, true)
    payload.set([1, 2, 3, 4, 5, 6, 7, 8], 16)

    expect(() => channel?.onmessage?.(payload)).not.toThrow()
    expect(onNativeFrameError).toHaveBeenCalledWith(
      expect.objectContaining({
        byteLength: 8,
        height: 1,
        message: 'data is not large enough',
        width: 2,
      })
    )
    expect(writer.write).not.toHaveBeenCalled()
  })

  it('rejects malformed native frame byte lengths before creating a VideoFrame', async () => {
    const originalStop = vi.fn()
    const onNativeFrameError = vi.fn()
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    class MockMediaStream {
      constructor(private readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getVideoTracks() {
        return this.tracks
      }
    }
    class MockGenerator {
      writable = { getWriter: () => writer }
      track = {
        addEventListener: vi.fn(),
        kind: 'video',
        stop: originalStop,
      }
    }
    const MockVideoFrame = vi.fn()

    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal('VideoTrackGenerator', undefined)
    vi.stubGlobal('VideoFrame', MockVideoFrame)
    tauriCoreMock.invoke.mockResolvedValue(nativeCaptureStartResult())

    await getRemoteCaptureStream({ onNativeFrameError })
    const channel = tauriCoreMock.Channel.latest
    const payload = new Uint8Array(16 + 7)
    new DataView(payload.buffer).setUint32(0, 2, true)
    new DataView(payload.buffer).setUint32(4, 1, true)
    payload.set([1, 2, 3, 4, 5, 6, 7], 16)

    channel?.onmessage?.(payload)

    expect(onNativeFrameError).toHaveBeenCalledWith(
      expect.objectContaining({
        byteLength: 7,
        height: 1,
        message: 'Native frame byte length 7 does not match 2x1 BGRA payload length 8',
        width: 2,
      })
    )
    expect(MockVideoFrame).not.toHaveBeenCalled()
    expect(writer.write).not.toHaveBeenCalled()
  })

  it('rejects instead of falling back to browser capture if native capture startup fails', async () => {
    const getDisplayMedia = vi.fn()
    const originalStop = vi.fn()
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    class MockGenerator {
      writable = { getWriter: () => writer }
      track = {
        kind: 'video',
        stop: originalStop,
      } as unknown as MediaStreamTrack
    }

    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal('VideoFrame', class {})
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } })
    tauriCoreMock.invoke.mockRejectedValue(new Error('native unavailable'))

    await expect(getRemoteCaptureStream()).rejects.toThrow(
      'native unavailable'
    )

    expect(getDisplayMedia).not.toHaveBeenCalled()
    expect(writer.close).toHaveBeenCalled()
    expect(originalStop).toHaveBeenCalled()
  })

  it('rejects visibly when native frame generation is unavailable', async () => {
    vi.stubGlobal('MediaStreamTrackGenerator', undefined)
    vi.stubGlobal('VideoTrackGenerator', undefined)
    vi.stubGlobal('VideoFrame', undefined)

    await expect(getRemoteCaptureStream()).rejects.toThrow(
      'Remote control is not available because this Windows/WebView2 runtime is too old. Update Windows or install the latest Microsoft Edge WebView2 Runtime, then try again.'
    )
    expect(tauriCoreMock.invoke).not.toHaveBeenCalled()
  })

  it('rejects if native capture stops before startup completes', async () => {
    const getDisplayMedia = vi.fn()
    const originalStop = vi.fn()
    const track = {
      kind: 'video',
      stop: originalStop,
    } as unknown as MediaStreamTrack
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    let resolveStart!: (value: { capture_id: string }) => void
    const startPromise = new Promise<{ capture_id: string }>(resolve => {
      resolveStart = resolve
    })
    class MockGenerator {
      static latest: MockGenerator | null = null
      writable = { getWriter: () => writer }
      track = track

      constructor() {
        MockGenerator.latest = this
      }
    }

    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal('VideoFrame', class {})
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } })
    tauriCoreMock.invoke.mockImplementation(command => {
      if (command === 'start_native_screen_capture') return startPromise
      if (command === 'stop_native_screen_capture') return Promise.resolve()
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    const streamPromise = getRemoteCaptureStream()
    await vi.waitFor(() => expect(MockGenerator.latest).not.toBeNull())
    MockGenerator.latest?.track.stop()
    resolveStart(nativeCaptureStartResult())

    await expect(streamPromise).rejects.toThrow(
      'Native capture stopped before startup completed'
    )
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'stop_native_screen_capture',
      { captureId: 'capture-1' }
    )
    expect(getDisplayMedia).not.toHaveBeenCalled()
    expect(originalStop).toHaveBeenCalled()
  })

  it('drops native frames when the generated writer is errored', async () => {
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: null,
      write: vi.fn().mockResolvedValue(undefined),
    }
    class MockGenerator {
      writable = { getWriter: () => writer }
      track = { kind: 'video', stop: vi.fn() } as unknown as MediaStreamTrack
    }
    class MockMediaStream {
      constructor(private readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
    }
    class MockVideoFrame {
      close = vi.fn()
    }

    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal('VideoFrame', MockVideoFrame)
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn() } })
    tauriCoreMock.invoke.mockResolvedValue(nativeCaptureStartResult())

    await getRemoteCaptureStream()
    const channel = tauriCoreMock.Channel.latest
    const payload = new Uint8Array(16 + 4)
    new DataView(payload.buffer).setUint32(0, 1, true)
    new DataView(payload.buffer).setUint32(4, 1, true)

    channel?.onmessage?.(payload)

    expect(writer.write).not.toHaveBeenCalled()
  })

  it('stops native capture when the generated video track is stopped', async () => {
    const originalStop = vi.fn()
    const track = {
      kind: 'video',
      stop: originalStop,
      contentHint: '',
    } as unknown as MediaStreamTrack
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      desiredSize: 1,
      write: vi.fn().mockResolvedValue(undefined),
    }
    class MockMediaStream {
      constructor(private readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
    }
    class MockGenerator {
      writable = { getWriter: () => writer }
      track = track
    }

    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockGenerator)
    vi.stubGlobal('VideoFrame', class {})
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn() } })
    tauriCoreMock.invoke.mockResolvedValue(nativeCaptureStartResult())

    const stream = await getRemoteCaptureStream()
    stream.getTracks()[0]?.stop()

    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'stop_native_screen_capture',
      { captureId: 'capture-1' }
    )
    expect(originalStop).toHaveBeenCalled()
  })

  it('applies a best-effort 1080p constraint to captured video tracks', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined)
    const videoTrack = {
      applyConstraints,
      kind: 'video',
    } as unknown as MediaStreamTrack
    const audioTrack = {
      applyConstraints: vi.fn(),
      kind: 'audio',
    } as unknown as MediaStreamTrack
    const stream = {
      getTracks: () => [videoTrack, audioTrack],
    } as unknown as MediaStream

    await applyRemoteCaptureResolutionLimit(stream)

    expect(applyConstraints).toHaveBeenCalledWith({
      height: { ideal: 1080, max: 1080 },
      width: { ideal: 1920, max: 1920 },
    })
    expect(audioTrack.applyConstraints).not.toHaveBeenCalled()
  })

  it('reports capture resolution constraint failures without rejecting', async () => {
    const onWarning = vi.fn()
    const videoTrack = {
      applyConstraints: vi.fn().mockRejectedValue(new Error('Overconstrained')),
      kind: 'video',
    } as unknown as MediaStreamTrack
    const stream = {
      getTracks: () => [videoTrack],
    } as unknown as MediaStream

    await expect(
      applyRemoteCaptureResolutionLimit(stream, onWarning)
    ).resolves.toBeUndefined()

    expect(onWarning).toHaveBeenCalledWith(
        'Remote-session capture resolution cap could not be applied; continuing with native capture defaults.'
    )
  })

  it('skips resolution constraints for native generated capture streams', async () => {
    const onWarning = vi.fn()
    const { videoTrack } = stubNativeRemoteCapture()

    const stream = await getRemoteCaptureStream()
    await applyRemoteCaptureResolutionLimit(stream, onWarning)

    expect(videoTrack.applyConstraints).not.toHaveBeenCalled()
    expect(onWarning).not.toHaveBeenCalled()
  })

  it('marks video tracks as detail content', () => {
    const videoTrack = { kind: 'video', contentHint: '' } as MediaStreamTrack
    const audioTrack = { kind: 'audio', contentHint: '' } as MediaStreamTrack

    applyRemoteVideoTrackHint(videoTrack)
    applyRemoteVideoTrackHint(audioTrack)

    expect(videoTrack.contentHint).toBe('detail')
    expect(audioTrack.contentHint).toBe('')
  })

  it('applies the bitrate policy through sender parameters', async () => {
    const setParameters = vi.fn()
    const sender = {
      getParameters: () => ({ encodings: [] }),
      setParameters,
      track: {
        getSettings: () => ({ height: 720, width: 1280 }),
        kind: 'video',
      },
    } as unknown as RTCRtpSender

    await applyRemoteSenderBitratePolicy([sender])

    expect(setParameters).toHaveBeenCalledWith({
      encodings: [
        {
          maxBitrate: REMOTE_VIDEO_LAN_BITRATE_BPS,
          maxFramerate: REMOTE_VIDEO_MAX_FRAMERATE,
        },
      ],
    })
  })

  it('uses the cloud bitrate cap for cloud peer connections', async () => {
    const setParameters = vi.fn()
    const sender = {
      getParameters: () => ({ encodings: [] }),
      setParameters,
      track: {
        getSettings: () => ({ height: 1080, width: 1920 }),
        kind: 'video',
      },
    } as unknown as RTCRtpSender

    await applyRemoteSenderBitratePolicy([sender], undefined, {
      mode: 'cloud',
    })

    expect(setParameters).toHaveBeenCalledWith({
      encodings: [
        {
          maxBitrate: REMOTE_VIDEO_CLOUD_BITRATE_BPS,
          maxFramerate: REMOTE_VIDEO_MAX_FRAMERATE,
        },
      ],
    })
  })

  it('uses the relay bitrate cap for cloud relay peer connections', async () => {
    const setParameters = vi.fn()
    const sender = {
      getParameters: () => ({ encodings: [] }),
      setParameters,
      track: {
        getSettings: () => ({ height: 1080, width: 1920 }),
        kind: 'video',
      },
    } as unknown as RTCRtpSender

    const policy = await applyRemoteSenderBitratePolicy([sender], undefined, {
      forceRelay: true,
      mode: 'cloud',
      selectedCandidateType: 'host',
    })

    expect(policy?.candidateType).toBe('relay')
    expect(setParameters).toHaveBeenCalledWith({
      encodings: [
        {
          maxBitrate: REMOTE_VIDEO_RELAY_BITRATE_BPS,
          maxFramerate: REMOTE_VIDEO_MAX_FRAMERATE,
        },
      ],
    })
  })

  it('uses the relay bitrate cap when cloud ICE stats select relay', async () => {
    const setParameters = vi.fn()
    const sender = {
      getParameters: () => ({ encodings: [] }),
      setParameters,
      track: {
        getSettings: () => ({ height: 1080, width: 1920 }),
        kind: 'video',
      },
    } as unknown as RTCRtpSender

    await applyRemoteSenderBitratePolicy([sender], undefined, {
      mode: 'cloud',
      selectedCandidateType: 'relay',
    })

    expect(setParameters).toHaveBeenCalledWith({
      encodings: [
        {
          maxBitrate: REMOTE_VIDEO_RELAY_BITRATE_BPS,
          maxFramerate: REMOTE_VIDEO_MAX_FRAMERATE,
        },
      ],
    })
  })

  it('detects a selected relay candidate pair from WebRTC stats', () => {
    expect(
      selectedRemoteCandidateTypeFromStats([
        {
          id: 'transport-1',
          selectedCandidatePairId: 'pair-1',
          timestamp: 1,
          type: 'transport',
        } as unknown as RTCStats,
        {
          id: 'pair-1',
          localCandidateId: 'local-1',
          remoteCandidateId: 'remote-1',
          timestamp: 1,
          type: 'candidate-pair',
        } as unknown as RTCStats,
        {
          candidateType: 'relay',
          id: 'local-1',
          timestamp: 1,
          type: 'local-candidate',
        } as unknown as RTCStats,
        {
          candidateType: 'srflx',
          id: 'remote-1',
          timestamp: 1,
          type: 'remote-candidate',
        } as unknown as RTCStats,
      ])
    ).toBe('relay')
  })

  it('detects selected relay candidates from RTCStatsReport maps', () => {
    const report = new Map<string, RTCStats>([
      [
        'transport-1',
        {
          id: 'transport-1',
          selectedCandidatePairId: 'pair-1',
          timestamp: 1,
          type: 'transport',
        } as unknown as RTCStats,
      ],
      [
        'pair-1',
        {
          id: 'pair-1',
          localCandidateId: 'local-1',
          remoteCandidateId: 'remote-1',
          timestamp: 1,
          type: 'candidate-pair',
        } as unknown as RTCStats,
      ],
      [
        'local-1',
        {
          candidateType: 'relay',
          id: 'local-1',
          timestamp: 1,
          type: 'local-candidate',
        } as unknown as RTCStats,
      ],
    ])

    expect(
      selectedRemoteCandidateTypeFromStats(report as unknown as RTCStatsReport)
    ).toBe('relay')
  })

  it('prefers nominated candidate pairs over succeeded fallback pairs', () => {
    expect(
      selectedRemoteCandidateTypeFromStats([
        {
          id: 'pair-relay',
          localCandidateId: 'local-relay',
          state: 'succeeded',
          timestamp: 1,
          type: 'candidate-pair',
        } as unknown as RTCStats,
        {
          id: 'pair-host',
          localCandidateId: 'local-host',
          nominated: true,
          timestamp: 1,
          type: 'candidate-pair',
        } as unknown as RTCStats,
        {
          candidateType: 'relay',
          id: 'local-relay',
          timestamp: 1,
          type: 'local-candidate',
        } as unknown as RTCStats,
        {
          candidateType: 'host',
          id: 'local-host',
          timestamp: 1,
          type: 'local-candidate',
        } as unknown as RTCStats,
      ])
    ).toBe('host')
  })

  it('prefers nominated candidate pairs when they appear before succeeded fallback pairs', () => {
    expect(
      selectedRemoteCandidateTypeFromStats([
        {
          id: 'pair-host',
          localCandidateId: 'local-host',
          nominated: true,
          timestamp: 1,
          type: 'candidate-pair',
        } as unknown as RTCStats,
        {
          id: 'pair-relay',
          localCandidateId: 'local-relay',
          state: 'succeeded',
          timestamp: 1,
          type: 'candidate-pair',
        } as unknown as RTCStats,
        {
          candidateType: 'host',
          id: 'local-host',
          timestamp: 1,
          type: 'local-candidate',
        } as unknown as RTCStats,
        {
          candidateType: 'relay',
          id: 'local-relay',
          timestamp: 1,
          type: 'local-candidate',
        } as unknown as RTCStats,
      ])
    ).toBe('host')
  })

  it('detects a selected direct candidate pair from WebRTC stats', () => {
    expect(
      selectedRemoteCandidateTypeFromStats([
        {
          id: 'pair-1',
          localCandidateId: 'local-1',
          nominated: true,
          remoteCandidateId: 'remote-1',
          timestamp: 1,
          type: 'candidate-pair',
        } as unknown as RTCStats,
        {
          candidateType: 'host',
          id: 'local-1',
          timestamp: 1,
          type: 'local-candidate',
        } as unknown as RTCStats,
      ])
    ).toBe('host')
  })

  it('downscales oversized video tracks through sender parameters', async () => {
    const setParameters = vi.fn()
    const sender = {
      getParameters: () => ({ encodings: [{}] }),
      setParameters,
      track: {
        getSettings: () => ({ height: 2160, width: 3840 }),
        kind: 'video',
      },
    } as unknown as RTCRtpSender

    await applyRemoteSenderBitratePolicy([sender])

    expect(setParameters).toHaveBeenCalledWith({
      encodings: [
        {
          maxBitrate: REMOTE_VIDEO_LAN_BITRATE_BPS,
          maxFramerate: REMOTE_VIDEO_MAX_FRAMERATE,
          scaleResolutionDownBy: 2,
        },
      ],
    })
  })

  it('skips sender media policy for non-video tracks', async () => {
    const setParameters = vi.fn()
    const sender = {
      getParameters: () => ({ encodings: [{}] }),
      setParameters,
      track: {
        kind: 'audio',
      },
    } as unknown as RTCRtpSender

    await expect(applyRemoteSenderBitratePolicy([sender])).resolves.toBeNull()

    expect(setParameters).not.toHaveBeenCalled()
  })

  it('skips sender media policy for null-track audio transceiver senders', async () => {
    const setParameters = vi.fn()
    const sender = {
      getParameters: () => ({ encodings: [{}] }),
      setParameters,
      track: null,
    } as unknown as RTCRtpSender

    await expect(applyRemoteSenderBitratePolicy([sender])).resolves.toBeNull()

    expect(setParameters).not.toHaveBeenCalled()
  })

  it('exposes deterministic media diagnostics for E2E assertions', async () => {
    const setParameters = vi.fn()
    const sender = {
      getParameters: () => ({ encodings: [{}] }),
      setParameters,
      track: {
        getSettings: () => ({ height: 2160, width: 3840 }),
        kind: 'video',
      },
    } as unknown as RTCRtpSender
    const host = remoteWebRtcHost as unknown as {
      mediaSenders: RTCRtpSender[]
      applyNegotiatedMediaPolicy: () => Promise<void>
      getMediaDiagnostics: () => {
        appliedMaxBitrate: number | null
        appliedMaxFramerate: number | null
        appliedScaleResolutionDownBy: number | null
        codecPreferenceAttempted: boolean
        codecPreferenceFirstMimeType: string | null
        nativeValidatedFrameHeight: number | null
        nativeValidatedFrameWidth: number | null
        nativeValidatedSurfaceKind: 'easycris-window' | null
        nativeValidationError: string | null
        requestedMaxFramerate: number
        requestedMaxHeight: number
        requestedMaxWidth: number
      }
      mediaDiagnostics: ReturnType<typeof createRemoteMediaDiagnostics>
    }

    host.mediaDiagnostics = createRemoteMediaDiagnostics()
    host.mediaSenders = [sender]
    await host.applyNegotiatedMediaPolicy()

    expect(host.getMediaDiagnostics()).toMatchObject({
      appliedMaxBitrate: REMOTE_VIDEO_LAN_BITRATE_BPS,
      appliedMaxFramerate: REMOTE_VIDEO_MAX_FRAMERATE,
      appliedScaleResolutionDownBy: 2,
      codecPreferenceAttempted: false,
      codecPreferenceFirstMimeType: null,
      nativeValidatedFrameHeight: null,
      nativeValidatedFrameWidth: null,
      nativeValidatedSurfaceKind: null,
      nativeValidationError: null,
      requestedMaxFramerate: REMOTE_VIDEO_MAX_FRAMERATE,
      requestedMaxHeight: 1080,
      requestedMaxWidth: 1920,
    })
  })

  it('prefers H.264 video codecs when available', () => {
    const vp8 = { mimeType: 'video/VP8' }
    const h264 = { mimeType: 'video/H264' }
    const opus = { mimeType: 'audio/opus' }
    const rtx = { mimeType: 'video/rtx' }
    const setCodecPreferences = vi.fn()
    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: vi.fn(() => ({ codecs: [vp8, h264, opus, rtx] })),
    })

    applyRemoteCodecPreferences({
      getTransceivers: () => [
        {
          sender: { track: { kind: 'video' } },
          setCodecPreferences,
        },
      ],
    } as unknown as RTCPeerConnection)

    expect(setCodecPreferences).toHaveBeenCalledWith([h264, vp8, opus, rtx])
  })

  it('prefers H.264 packetization-mode=1 codecs before other H.264 codecs', () => {
    const vp8 = { mimeType: 'video/VP8' }
    const h264Mode0 = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=42e01f;packetization-mode=0',
    }
    const h264Mode1 = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=42e01f;packetization-mode=1',
    }
    const setCodecPreferences = vi.fn()
    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: vi.fn(() => ({
        codecs: [vp8, h264Mode0, h264Mode1],
      })),
    })

    applyRemoteCodecPreferences({
      getTransceivers: () => [
        {
          sender: { track: { kind: 'video' } },
          setCodecPreferences,
        },
      ],
    } as unknown as RTCPeerConnection)

    expect(setCodecPreferences).toHaveBeenCalledWith([
      h264Mode1,
      h264Mode0,
      vp8,
    ])
  })

  it('prefers receiver codec capabilities before sender capabilities', () => {
    const receiverH264 = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=640028;packetization-mode=1',
    }
    const senderH264 = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=42e028;packetization-mode=1',
    }
    const setCodecPreferences = vi.fn()
    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: vi.fn(() => ({ codecs: [receiverH264] })),
    })
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: vi.fn(() => ({ codecs: [senderH264] })),
    })

    applyRemoteCodecPreferences({
      getTransceivers: () => [
        {
          sender: { track: { kind: 'video' } },
          setCodecPreferences,
        },
      ],
    } as unknown as RTCPeerConnection)

    expect(setCodecPreferences).toHaveBeenCalledWith([receiverH264])
  })

  it('prefers high-profile packetized H.264 over constrained baseline', () => {
    const vp8 = { mimeType: 'video/VP8' }
    const constrainedBaseline = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=42e028;packetization-mode=1',
    }
    const main = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=4d0028;packetization-mode=1',
    }
    const high = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=640028;packetization-mode=1',
    }
    const setCodecPreferences = vi.fn()
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: vi.fn(() => ({
        codecs: [vp8, constrainedBaseline, main, high],
      })),
    })

    applyRemoteCodecPreferences({
      getTransceivers: () => [
        {
          sender: { track: { kind: 'video' } },
          setCodecPreferences,
        },
      ],
    } as unknown as RTCPeerConnection)

    expect(setCodecPreferences).toHaveBeenCalledWith([
      high,
      main,
      constrainedBaseline,
      vp8,
    ])
  })

  it('prefers 1080p-capable H.264 levels over level 3.1', () => {
    const level31 = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=64001f;packetization-mode=1',
    }
    const level40 = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=640028;packetization-mode=1',
    }
    const setCodecPreferences = vi.fn()
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: vi.fn(() => ({ codecs: [level31, level40] })),
    })

    applyRemoteCodecPreferences({
      getTransceivers: () => [
        {
          sender: { track: { kind: 'video' } },
          setCodecPreferences,
        },
      ],
    } as unknown as RTCPeerConnection)

    expect(setCodecPreferences).toHaveBeenCalledWith([level40, level31])
  })

  it('prefers plain baseline over constrained baseline when no higher H.264 profile is available', () => {
    const constrainedBaseline = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=42e028;packetization-mode=1',
    }
    const baseline = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=420028;packetization-mode=1',
    }
    const setCodecPreferences = vi.fn()
    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: vi.fn(() => ({
        codecs: [constrainedBaseline, baseline],
      })),
    })

    applyRemoteCodecPreferences({
      getTransceivers: () => [
        {
          sender: { track: { kind: 'video' } },
          setCodecPreferences,
        },
      ],
    } as unknown as RTCPeerConnection)

    expect(setCodecPreferences).toHaveBeenCalledWith([
      baseline,
      constrainedBaseline,
    ])
  })

  it('falls back to sender codec capabilities when receiver capabilities are unavailable', () => {
    const vp8 = { mimeType: 'video/VP8' }
    const h264 = { mimeType: 'video/H264' }
    const setCodecPreferences = vi.fn()
    vi.stubGlobal('RTCRtpReceiver', {})
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: vi.fn(() => ({ codecs: [vp8, h264] })),
    })

    applyRemoteCodecPreferences({
      getTransceivers: () => [
        {
          sender: { track: { kind: 'video' } },
          setCodecPreferences,
        },
      ],
    } as unknown as RTCPeerConnection)

    expect(setCodecPreferences).toHaveBeenCalledWith([h264, vp8])
  })

  it('falls back to receiver codec capabilities when sender capabilities are unavailable', () => {
    const vp8 = { mimeType: 'video/VP8' }
    const h264 = { mimeType: 'video/H264' }
    const setCodecPreferences = vi.fn()
    vi.stubGlobal('RTCRtpSender', undefined)
    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: vi.fn(() => ({ codecs: [vp8, h264] })),
    })

    applyRemoteCodecPreferences({
      getTransceivers: () => [
        {
          sender: { track: { kind: 'video' } },
          setCodecPreferences,
        },
      ],
    } as unknown as RTCPeerConnection)

    expect(setCodecPreferences).toHaveBeenCalledWith([h264, vp8])
  })

  it('keeps packetized H.264 codecs with unknown profile-level-id behind known profiles', () => {
    const vp8 = { mimeType: 'video/VP8' }
    const unknownProfile = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'packetization-mode=01',
    }
    const high = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=640028;packetization-mode=1',
    }
    const mode0 = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=640028;packetization-mode=0',
    }
    const setCodecPreferences = vi.fn()
    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: vi.fn(() => ({
        codecs: [vp8, unknownProfile, mode0, high],
      })),
    })

    applyRemoteCodecPreferences({
      getTransceivers: () => [
        {
          sender: { track: { kind: 'video' } },
          setCodecPreferences,
        },
      ],
    } as unknown as RTCPeerConnection)

    expect(setCodecPreferences).toHaveBeenCalledWith([
      high,
      unknownProfile,
      mode0,
      vp8,
    ])
  })

  it('does not set codec preferences when H.264 is unavailable', () => {
    const vp8 = { mimeType: 'video/VP8' }
    const opus = { mimeType: 'audio/opus' }
    const setCodecPreferences = vi.fn()
    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: vi.fn(() => ({ codecs: [vp8, opus] })),
    })

    applyRemoteCodecPreferences({
      getTransceivers: () => [
        {
          sender: { track: { kind: 'video' } },
          setCodecPreferences,
        },
      ],
    } as unknown as RTCPeerConnection)

    expect(setCodecPreferences).not.toHaveBeenCalled()
  })

  it('reports bitrate policy failures without rejecting', async () => {
    const onWarning = vi.fn()
    const sender = {
      getParameters: () => ({ encodings: [] }),
      setParameters: vi.fn().mockRejectedValue(new Error('InvalidStateError')),
      track: {
        getSettings: () => ({ height: 720, width: 1280 }),
        kind: 'video',
      },
    } as unknown as RTCRtpSender

    await expect(
      applyRemoteSenderBitratePolicy([sender], onWarning)
    ).resolves.toBeNull()

    expect(onWarning).toHaveBeenCalledWith(
      'Remote-session bitrate cap could not be applied; continuing with default WebRTC bitrate.'
    )
  })
})

describe('remoteWebRtcHost intercom audio', () => {
  afterEach(async () => {
    await remoteWebRtcHost.close(false)
    FakeWebSocket.latest = null
    vi.unstubAllGlobals()
  })

  it('pre-negotiates one audio transceiver without adding it to video media senders', async () => {
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const videoTrack = {
      applyConstraints: vi.fn().mockResolvedValue(undefined),
      contentHint: '',
      getSettings: () => ({ height: 720, width: 1280 }),
      kind: 'video',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    stubNativeRemoteCapture(videoTrack)

    const audioSender = {
      getParameters: vi.fn(() => ({ encodings: [{}] })),
      replaceTrack: vi.fn(),
      setParameters: vi.fn(),
      track: null,
    }
    const addTransceiver = vi.fn(() => ({
      direction: 'sendrecv',
      receiver: { track: { kind: 'audio', readyState: 'live' } },
      sender: audioSender,
    }))
    class FakePeerConnection {
      localDescription: RTCSessionDescriptionInit | null = null
      onconnectionstatechange: (() => void) | null = null
      onicecandidate: ((event: unknown) => void) | null = null
      ontrack: ((event: unknown) => void) | null = null
      addTrack = vi.fn((track: MediaStreamTrack) => ({
        getParameters: () => ({ encodings: [] }),
        setParameters: vi.fn(),
        track,
      }))
      addTransceiver = addTransceiver
      close = vi.fn()
      createDataChannel = vi.fn(() => ({
        close: vi.fn(),
        onclose: null,
        onmessage: null,
        onopen: null,
      }))
      createOffer = vi
        .fn()
        .mockResolvedValue({ sdp: 'offer-sdp', type: 'offer' })
      getTransceivers = vi.fn(() => [])
      setLocalDescription = vi.fn(
        async (description: RTCSessionDescriptionInit) => {
          this.localDescription = description
        }
      )
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)

    await remoteWebRtcHost.connect({
      sessionId: 'session-1',
      signalingPort: 49152,
      token: 'invite-token',
    })
    await remoteWebRtcHost.startViewOnlyOffer('guest-device')

    const host = remoteWebRtcHost as unknown as {
      audioSender: unknown
      getMediaDiagnostics: () => ReturnType<typeof createRemoteMediaDiagnostics>
      mediaSenders: unknown[]
    }
    expect(addTransceiver).toHaveBeenCalledWith('audio', {
      direction: 'sendrecv',
    })
    expect(host.audioSender).toBe(audioSender)
    expect(host.mediaSenders).toHaveLength(1)
    expect(host.mediaSenders).not.toContain(audioSender)
    expect(host.getMediaDiagnostics()).toMatchObject({
      nativeValidatedFrameHeight: 720,
      nativeValidatedFrameWidth: 1280,
      nativeValidatedSurfaceKind: 'easycris-window',
      nativeValidationError: null,
    })
  })

  it('does not create a WebRTC offer when native EasyCris share validation fails', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onWarning = vi.fn()
    stubNativeRemoteCapture()
    tauriCoreMock.invoke.mockImplementation(command => {
      if (command === 'start_native_screen_capture') {
        return Promise.reject(
          new Error(
            'Could not verify the selected EasyCris window for remote sharing. Remote session was not started.'
          )
        )
      }
      if (command === 'stop_native_screen_capture') {
        return Promise.resolve()
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    const createOffer = vi.fn()
    const peerConnectionConstructor = vi.fn()
    class FakePeerConnection {
      constructor() {
        peerConnectionConstructor()
      }
      createOffer = createOffer
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)

    await remoteWebRtcHost.connect({
      sessionId: 'session-1',
      signalingPort: 49152,
      token: 'invite-token',
      callbacks: { onWarning },
    })

    await expect(
      remoteWebRtcHost.startViewOnlyOffer('guest-device')
    ).rejects.toThrow(
      'Could not verify the selected EasyCris window for remote sharing. Remote session was not started.'
    )

    expect(peerConnectionConstructor).not.toHaveBeenCalled()
    expect(createOffer).not.toHaveBeenCalled()
    expect(onWarning).not.toHaveBeenCalledWith(
      expect.stringContaining('capture resolution cap')
    )
    expect(remoteWebRtcHost.getMediaDiagnostics()).toMatchObject({
      nativeValidationError:
        'Could not verify the selected EasyCris window for remote sharing. Remote session was not started.',
    })
  })

  it('attaches and detaches host microphone tracks in sender-safe order', async () => {
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(audioStream),
      },
    })
    const host = remoteWebRtcHost as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      enableAudio: () => Promise<void>
      disableAudio: () => Promise<void>
      setAudioMuted: (muted: boolean) => void
    }
    host.audioSender = { replaceTrack }

    await host.enableAudio()
    host.setAudioMuted(true)
    await host.disableAudio()

    expect(replaceTrack).toHaveBeenNthCalledWith(1, audioTrack)
    expect(audioTrack.enabled).toBe(false)
    expect(replaceTrack).toHaveBeenNthCalledWith(2, null)
    const replaceNullCallOrder =
      replaceTrack.mock.invocationCallOrder.at(1) ?? Number.NaN
    const stopCallOrder = stop.mock.invocationCallOrder.at(0) ?? Number.NaN
    expect(Number.isNaN(replaceNullCallOrder)).toBe(false)
    expect(Number.isNaN(stopCallOrder)).toBe(false)
    expect(replaceNullCallOrder).toBeLessThan(stopCallOrder)
  })

  it('stops host microphone tracks even when detach rejects', async () => {
    const replaceTrack = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DOMException('', 'InvalidStateError'))
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(audioStream),
      },
    })
    const host = remoteWebRtcHost as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      audioMuted: boolean
      localAudioUnmuted: boolean
      localAudioStream: MediaStream | null
      enableAudio: () => Promise<void>
      disableAudio: () => Promise<void>
    }
    host.audioSender = { replaceTrack }

    await host.enableAudio()
    await expect(host.disableAudio()).resolves.toBeUndefined()

    expect(replaceTrack).toHaveBeenNthCalledWith(2, null)
    expect(stop).toHaveBeenCalledOnce()
    expect(host.localAudioStream).toBeNull()
    expect(host.audioMuted).toBe(true)
    expect(host.localAudioUnmuted).toBe(false)
  })

  it('warns but still cleans up host microphone tracks when detach fails unexpectedly', async () => {
    const replaceTrack = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DOMException('', 'OperationError'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(audioStream),
      },
    })
    const host = remoteWebRtcHost as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      enableAudio: () => Promise<void>
      disableAudio: () => Promise<void>
      localAudioStream: MediaStream | null
    }
    host.audioSender = { replaceTrack }

    await host.enableAudio()
    await expect(host.disableAudio()).resolves.toBeUndefined()

    expect(stop).toHaveBeenCalledOnce()
    expect(host.localAudioStream).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      '[remote] Failed to detach host audio sender',
      expect.any(DOMException)
    )
  })

  it('stops a host microphone stream if audio is disabled while enable is pending', async () => {
    let resolveGetUserMedia:
      | ((stream: MediaStream | PromiseLike<MediaStream>) => void)
      | undefined
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>(resolve => {
              resolveGetUserMedia = resolve
            })
        ),
      },
    })
    const host = remoteWebRtcHost as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      localAudioStream: MediaStream | null
      enableAudio: () => Promise<void>
      disableAudio: () => Promise<void>
    }
    host.audioSender = { replaceTrack }

    const enableTask = host.enableAudio()
    await host.disableAudio()
    resolveGetUserMedia?.(audioStream)

    await expect(enableTask).rejects.toThrow(
      'Remote-session audio sender is not active'
    )
    expect(replaceTrack).toHaveBeenCalledOnce()
    expect(replaceTrack).toHaveBeenCalledWith(null)
    expect(stop).toHaveBeenCalledOnce()
    expect(host.localAudioStream).toBeNull()
  })

  it('preserves a host mute requested while microphone enable is pending', async () => {
    let resolveGetUserMedia:
      | ((stream: MediaStream | PromiseLike<MediaStream>) => void)
      | undefined
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>(resolve => {
              resolveGetUserMedia = resolve
            })
        ),
      },
    })
    const host = remoteWebRtcHost as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      audioMuted: boolean
      localAudioUnmuted: boolean
      enableAudio: () => Promise<void>
      setAudioMuted: (muted: boolean) => void
    }
    host.audioSender = { replaceTrack }

    const enableTask = host.enableAudio()
    host.setAudioMuted(true)
    resolveGetUserMedia?.(audioStream)
    await enableTask

    expect(host.audioMuted).toBe(true)
    expect(audioTrack.enabled).toBe(false)
    expect(host.localAudioUnmuted).toBe(false)
  })

  it('stops a new host microphone stream if attaching it to the sender fails', async () => {
    const replaceTrack = vi.fn().mockRejectedValue(new Error('replace failed'))
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(audioStream),
      },
    })
    const host = remoteWebRtcHost as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      enableAudio: () => Promise<void>
      localAudioStream: MediaStream | null
    }
    host.audioSender = { replaceTrack }

    await expect(host.enableAudio()).rejects.toThrow('replace failed')

    expect(stop).toHaveBeenCalledOnce()
    expect(host.localAudioStream).toBeNull()
  })

  it('stops a new host microphone stream if the sender is cleared after permission', async () => {
    let resolveGetUserMedia:
      | ((stream: MediaStream | PromiseLike<MediaStream>) => void)
      | undefined
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>(resolve => {
              resolveGetUserMedia = resolve
            })
        ),
      },
    })
    const host = remoteWebRtcHost as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      clearPeerMediaState: () => void
      enableAudio: () => Promise<void>
      localAudioStream: MediaStream | null
    }
    host.audioSender = { replaceTrack }

    const enableTask = host.enableAudio()
    await Promise.resolve()
    host.clearPeerMediaState()
    resolveGetUserMedia?.(audioStream)

    await expect(enableTask).rejects.toThrow(
      'Remote-session audio sender is not active'
    )
    expect(replaceTrack).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
    expect(host.localAudioStream).toBeNull()
  })

  it('stops a new host microphone stream if the sender is cleared while attaching', async () => {
    let resolveReplace: (() => void) | undefined
    const replaceTrack = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveReplace = resolve
        })
    )
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(audioStream),
      },
    })
    const host = remoteWebRtcHost as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      clearPeerMediaState: () => void
      enableAudio: () => Promise<void>
      localAudioStream: MediaStream | null
    }
    host.audioSender = { replaceTrack }

    const enableTask = host.enableAudio()
    await vi.waitFor(() =>
      expect(replaceTrack).toHaveBeenCalledWith(audioTrack)
    )
    host.clearPeerMediaState()
    resolveReplace?.()

    await expect(enableTask).rejects.toThrow(
      'Remote-session audio sender is not active'
    )
    expect(replaceTrack).toHaveBeenNthCalledWith(2, null)
    expect(stop).toHaveBeenCalledOnce()
    expect(host.localAudioStream).toBeNull()
  })

  it('deduplicates concurrent host microphone enable requests', async () => {
    const replaceTrack = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      stop,
    } as unknown as MediaStreamTrack
    const audioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(audioStream)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
      },
    })
    const host = remoteWebRtcHost as unknown as {
      audioSender: { replaceTrack: typeof replaceTrack } | null
      enableAudio: () => Promise<void>
      localAudioStream: MediaStream | null
    }
    host.audioSender = { replaceTrack }

    await Promise.all([host.enableAudio(), host.enableAudio()])

    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(replaceTrack).toHaveBeenCalledOnce()
    expect(host.localAudioStream).toBe(audioStream)
  })

  it('exposes host audio diagnostics for sender, tracks, and remote state', () => {
    const audioTrack = {
      enabled: true,
      kind: 'audio',
      readyState: 'live',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const remoteTrack = {
      kind: 'audio',
      readyState: 'live',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const host = remoteWebRtcHost as unknown as {
      audioSender: { track: MediaStreamTrack | null } | null
      getAudioDiagnostics: () => Record<string, unknown>
      lastRemoteAudioStateSeq: number | null
      localAudioUnmuted: boolean
      localAudioStream: MediaStream | null
      remoteAudioSending: boolean
      remoteAudioStream: MediaStream | null
    }
    host.audioSender = { track: audioTrack }
    host.localAudioUnmuted = true
    host.remoteAudioSending = true
    host.lastRemoteAudioStateSeq = 7
    host.localAudioStream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream
    host.remoteAudioStream = {
      getAudioTracks: () => [remoteTrack],
      getTracks: () => [remoteTrack],
    } as unknown as MediaStream

    expect(host.getAudioDiagnostics()).toMatchObject({
      audioSenderTrackAttached: true,
      isIntercomAudioActive: true,
      lastRemoteAudioStateSeq: 7,
      localAudioSending: true,
      localAudioTrackEnabled: true,
      localAudioTrackReadyState: 'live',
      remoteAudioSending: true,
      remoteAudioTrackReadyState: 'live',
    })
  })

  it('stops host microphone tracks when the data channel closes abruptly', async () => {
    const stopAudio = vi.fn()
    const close = vi.fn()
    const host = remoteWebRtcHost as unknown as {
      audioSender: { replaceTrack: () => Promise<void> } | null
      dataChannel: { readyState: string; close: () => void } | null
      dataChannelCloseHandled: boolean
      handleDataChannelClose: () => void
      localAudioStream: { getTracks: () => { stop: () => void }[] } | null
      peerConnection: { close: () => void } | null
    }
    host.audioSender = { replaceTrack: vi.fn().mockResolvedValue(undefined) }
    host.dataChannel = { readyState: 'open', close: () => undefined }
    host.dataChannelCloseHandled = false
    host.localAudioStream = { getTracks: () => [{ stop: stopAudio }] }
    host.peerConnection = { close }

    host.handleDataChannelClose()
    await Promise.resolve()

    expect(close).toHaveBeenCalled()
    expect(stopAudio).toHaveBeenCalled()
    expect(host.localAudioStream).toBeNull()
  })

  it('stops host microphone tracks when signaling closes unexpectedly', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const stopAudio = vi.fn()

    await remoteWebRtcHost.connect({
      mode: 'cloud',
      sessionId: 'rmt_abc123',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      hostSecret: 'host-secret',
    })

    const host = remoteWebRtcHost as unknown as {
      localAudioUnmuted: boolean
      localAudioStream: { getTracks: () => { stop: () => void }[] } | null
    }
    host.localAudioStream = { getTracks: () => [{ stop: stopAudio }] }
    host.localAudioUnmuted = true

    FakeWebSocket.latest?.close()
    await Promise.resolve()

    expect(stopAudio).toHaveBeenCalledOnce()
    expect(host.localAudioStream).toBeNull()
    expect(host.localAudioUnmuted).toBe(false)
  })

  it('restarts idle timers when signaling closes while remote audio is active', async () => {
    vi.useFakeTimers()
    const onIdleWarning = vi.fn()
    const onIdleExpired = vi.fn()
    try {
      vi.stubGlobal('WebSocket', FakeWebSocket)

      await remoteWebRtcHost.connect({
        mode: 'cloud',
        sessionId: 'rmt_abc123',
        inviteId: 'rmt_abc123',
        relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
        hostSecret: 'host-secret',
        callbacks: {
          onIdleExpired,
          onIdleWarning,
        },
      })

      const host = remoteWebRtcHost as unknown as {
        remoteAudioSending: boolean
        resetIdleTimers: () => void
      }
      host.remoteAudioSending = true
      host.resetIdleTimers()

      FakeWebSocket.latest?.close()
      await Promise.resolve()

      vi.advanceTimersByTime(9 * 60_000)
      expect(onIdleWarning).toHaveBeenCalledWith(60)

      vi.advanceTimersByTime(60_000)
      expect(onIdleExpired).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('remoteWebRtcHost cloud signaling', () => {
  afterEach(async () => {
    await remoteWebRtcHost.close(false)
    await Promise.resolve()
    FakeWebSocket.latest = null
    remoteSessionServiceMock.noteRemoteSessionGuestPending.mockReset()
    remoteSessionServiceMock.sendRemoteKeyInput.mockReset()
    remoteSessionServiceMock.sendRemoteMouseInput.mockReset()
    vi.unstubAllGlobals()
  })

  it('registers cloud hosts through the cloud signaling transport', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)

    await remoteWebRtcHost.connect({
      mode: 'cloud',
      sessionId: 'rmt_abc123',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      hostSecret: 'host-secret',
    })

    expect(FakeWebSocket.latest?.url).toBe(
      'wss://remote.easycris.com/v1/remote/signaling?invite=rmt_abc123'
    )
    expect(
      FakeWebSocket.latest?.sent.map(value => JSON.parse(value))
    ).toContainEqual({
      type: 'host_register',
      invite_id: 'rmt_abc123',
      host_secret: 'host-secret',
    })
  })

  it('sends cloud join rejections through the cloud signaling transport', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)

    await remoteWebRtcHost.connect({
      mode: 'cloud',
      sessionId: 'rmt_abc123',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      hostSecret: 'host-secret',
    })
    remoteWebRtcHost.rejectGuest('guest-device', 'Host rejected')

    await vi.waitFor(() => {
      expect(
        FakeWebSocket.latest?.sent.map(value => JSON.parse(value))
      ).toContainEqual({
        type: 'join_rejected',
        invite_id: 'rmt_abc123',
        guest_device_id: 'guest-device',
        reason: 'Host rejected',
      })
    })
  })

  it('rejects duplicate cloud join requests when local pending state rejects them', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    remoteSessionServiceMock.noteRemoteSessionGuestPending.mockRejectedValue(
      new Error('A remote-session guest is already pending or approved')
    )

    await remoteWebRtcHost.connect({
      mode: 'cloud',
      sessionId: 'rmt_abc123',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      hostSecret: 'host-secret',
    })

    FakeWebSocket.latest?.receive({
      type: 'join_request',
      invite_id: 'rmt_abc123',
      guest_display_name: 'Second Guest',
      guest_device_id: 'guest-device-2',
    })
    await Promise.resolve()
    await Promise.resolve()

    await vi.waitFor(() => {
      expect(
        FakeWebSocket.latest?.sent.map(value => JSON.parse(value))
      ).toContainEqual({
        type: 'join_rejected',
        invite_id: 'rmt_abc123',
        guest_device_id: 'guest-device-2',
        reason: 'A remote-session guest is already pending or approved',
      })
    })
  })

  it('reports asynchronous signaling message failures to the host', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onError = vi.fn()

    await remoteWebRtcHost.connect({
      mode: 'cloud',
      sessionId: 'rmt_abc123',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      hostSecret: 'host-secret',
      callbacks: { onError },
    })
    ;(
      remoteWebRtcHost as unknown as {
        peerConnection: {
          close: () => void
          setRemoteDescription: () => Promise<void>
        } | null
      }
    ).peerConnection = {
      close: vi.fn(),
      setRemoteDescription: vi
        .fn()
        .mockRejectedValue(new Error('Invalid answer')),
    }

    FakeWebSocket.latest?.receive({
      type: 'video_answer',
      invite_id: 'rmt_abc123',
      guest_device_id: 'guest-device',
      payload: { type: 'answer', sdp: 'bad' },
    })
    await Promise.resolve()
    await Promise.resolve()

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Invalid answer')
    )
  })

  it('closes the local peer when the approved guest disconnects', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const close = vi.fn()
    const onStatus = vi.fn()

    await remoteWebRtcHost.connect({
      mode: 'cloud',
      sessionId: 'rmt_abc123',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      hostSecret: 'host-secret',
      callbacks: { onStatus },
    })
    ;(
      remoteWebRtcHost as unknown as {
        peerConnection: { close: () => void } | null
      }
    ).peerConnection = { close }

    FakeWebSocket.latest?.receive({
      type: 'guest_disconnected',
      invite_id: 'rmt_abc123',
      guest_device_id: 'guest-device',
    })

    await vi.waitFor(() =>
      expect(close).toHaveBeenCalled()
    )
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(
        'Remote-session guest disconnected'
      )
    )
  })

  it('forces relay ICE policy when a cloud host starts a view-only offer with forceRelay', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          iceServers: [
            {
              credential: 'turn-password',
              urls: 'turn:turn.easycris.com:3478',
              username: 'turn-user',
            },
          ],
        }),
        ok: true,
      })
    )

    const capturedConfigs: RTCConfiguration[] = []
    const videoTrack = {
      contentHint: '',
      kind: 'video',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    stubNativeRemoteCapture(videoTrack)

    class FakePeerConnection {
      connectionState = 'new'
      onconnectionstatechange: (() => void) | null = null
      onicecandidate: ((event: unknown) => void) | null = null

      constructor(config: RTCConfiguration) {
        capturedConfigs.push(config)
      }

      addTrack = vi.fn(() => ({
        getParameters: () => ({ encodings: [] }),
        setParameters: vi.fn(),
      }))
      addTransceiver = vi.fn(() => ({
        direction: 'sendrecv',
        receiver: { track: { kind: 'audio' } },
        sender: { replaceTrack: vi.fn(), track: null },
      }))
      close = vi.fn()
      createDataChannel = vi.fn(() => ({
        close: vi.fn(),
        onclose: null,
        onmessage: null,
        onopen: null,
      }))
      createOffer = vi
        .fn()
        .mockResolvedValue({ sdp: 'offer-sdp', type: 'offer' })
      getTransceivers = vi.fn(() => [])
      setLocalDescription = vi.fn().mockResolvedValue(undefined)
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)

    await remoteWebRtcHost.connect({
      mode: 'cloud',
      sessionId: 'rmt_abc123',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      hostSecret: 'host-secret',
      forceRelay: true,
    })
    await remoteWebRtcHost.startViewOnlyOffer('guest-device')

    expect(capturedConfigs).toHaveLength(1)
    expect(capturedConfigs).toEqual([
      {
        iceServers: [
          {
            credential: 'turn-password',
            urls: 'turn:turn.easycris.com:3478',
            username: 'turn-user',
          },
        ],
        iceTransportPolicy: 'relay',
      },
    ])
  })

  it('downgrades cloud video bitrate when connected ICE stats select relay', async () => {
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ iceServers: [] }),
        ok: true,
      })
    )
    const videoTrack = {
      applyConstraints: vi.fn().mockResolvedValue(undefined),
      contentHint: '',
      getSettings: () => ({ height: 1080, width: 1920 }),
      kind: 'video',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    stubNativeRemoteCapture(videoTrack)
    const setParameters = vi.fn().mockResolvedValue(undefined)
    const relayStats = new Map<string, RTCStats>([
      [
        'transport-1',
        {
          id: 'transport-1',
          selectedCandidatePairId: 'pair-1',
          timestamp: 1,
          type: 'transport',
        } as unknown as RTCStats,
      ],
      [
        'pair-1',
        {
          id: 'pair-1',
          localCandidateId: 'local-1',
          timestamp: 1,
          type: 'candidate-pair',
        } as unknown as RTCStats,
      ],
      [
        'local-1',
        {
          candidateType: 'relay',
          id: 'local-1',
          timestamp: 1,
          type: 'local-candidate',
        } as unknown as RTCStats,
      ],
    ])
    let triggerConnectionState:
      | ((state: RTCPeerConnectionState) => void)
      | null = null

    class FakePeerConnection {
      connectionState: RTCPeerConnectionState = 'new'
      onconnectionstatechange: (() => void) | null = null
      onicecandidate: ((event: unknown) => void) | null = null

      constructor() {
        triggerConnectionState = state => {
          this.connectionState = state
          this.onconnectionstatechange?.()
        }
      }

      addTrack = vi.fn(() => ({
        getParameters: () => ({ encodings: [] }),
        setParameters,
        track: videoTrack,
      }))
      addTransceiver = vi.fn(() => ({
        direction: 'sendrecv',
        receiver: { track: { kind: 'audio' } },
        sender: { replaceTrack: vi.fn(), track: null },
      }))
      close = vi.fn()
      createDataChannel = vi.fn(() => ({
        close: vi.fn(),
        onclose: null,
        onmessage: null,
        onopen: null,
      }))
      createOffer = vi
        .fn()
        .mockResolvedValue({ sdp: 'offer-sdp', type: 'offer' })
      getStats = vi
        .fn()
        .mockResolvedValueOnce(new Map<string, RTCStats>())
        .mockResolvedValue(relayStats)
      getTransceivers = vi.fn(() => [])
      setLocalDescription = vi.fn().mockResolvedValue(undefined)
      setRemoteDescription = vi.fn().mockResolvedValue(undefined)
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)

    await remoteWebRtcHost.connect({
      mode: 'cloud',
      sessionId: 'rmt_abc123',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      hostSecret: 'host-secret',
    })
    await remoteWebRtcHost.startViewOnlyOffer('guest-device')
    FakeWebSocket.latest?.receive({
      type: 'video_answer',
      invite_id: 'rmt_abc123',
      guest_device_id: 'guest-device',
      payload: { sdp: 'answer-sdp', type: 'answer' },
    })

    await vi.waitFor(() =>
      expect(setParameters).toHaveBeenCalledWith({
        encodings: [
          {
            maxBitrate: REMOTE_VIDEO_CLOUD_BITRATE_BPS,
            maxFramerate: REMOTE_VIDEO_MAX_FRAMERATE,
          },
        ],
      })
    )

    const triggerConnected = triggerConnectionState as
      | ((state: RTCPeerConnectionState) => void)
      | null
    expect(triggerConnected).not.toBeNull()
    triggerConnected?.('connected')

    await vi.waitFor(() =>
      expect(setParameters).toHaveBeenLastCalledWith({
        encodings: [
          {
            maxBitrate: REMOTE_VIDEO_RELAY_BITRATE_BPS,
            maxFramerate: REMOTE_VIDEO_MAX_FRAMERATE,
          },
        ],
      })
    )
    expect(remoteWebRtcHost.getMediaDiagnostics()).toMatchObject({
      appliedCandidateType: 'relay',
      appliedMaxBitrate: REMOTE_VIDEO_RELAY_BITRATE_BPS,
      requestedMaxBitrate: REMOTE_VIDEO_CLOUD_BITRATE_BPS,
    })
  })

  it('serializes negotiated media policy updates', async () => {
    const resolvers: { firstSetParameters?: () => void } = {}
    const firstSetParameters = new Promise<void>(resolve => {
      resolvers.firstSetParameters = resolve
    })
    const setParameters = vi
      .fn()
      .mockReturnValueOnce(firstSetParameters)
      .mockResolvedValue(undefined)
    const sender = {
      getParameters: () => ({ encodings: [] }),
      setParameters,
      track: {
        getSettings: () => ({ height: 1080, width: 1920 }),
        kind: 'video',
      },
    } as unknown as RTCRtpSender
    const host = remoteWebRtcHost as unknown as {
      applyNegotiatedMediaPolicy: () => Promise<void>
      mediaDiagnostics: ReturnType<typeof createRemoteMediaDiagnostics>
      mediaPolicyQueue: Promise<void>
      mediaSenders: RTCRtpSender[]
    }
    host.mediaDiagnostics = createRemoteMediaDiagnostics()
    host.mediaPolicyQueue = Promise.resolve()
    host.mediaSenders = [sender]

    const firstApply = host.applyNegotiatedMediaPolicy()
    await vi.waitFor(() => expect(setParameters).toHaveBeenCalledTimes(1))

    const secondApply = host.applyNegotiatedMediaPolicy()
    await Promise.resolve()
    await Promise.resolve()
    expect(setParameters).toHaveBeenCalledTimes(1)

    if (!resolvers.firstSetParameters) {
      throw new Error('setParameters resolver was not initialized')
    }
    resolvers.firstSetParameters()
    await Promise.all([firstApply, secondApply])

    expect(setParameters).toHaveBeenCalledTimes(2)
  })

  it('resets queued media policy work when peer media state is cleared', async () => {
    const queued = Promise.resolve()
    const host = remoteWebRtcHost as unknown as {
      clearPeerMediaState: () => void
      mediaPolicyQueue: Promise<void>
    }
    host.mediaPolicyQueue = queued

    host.clearPeerMediaState()

    expect(host.mediaPolicyQueue).not.toBe(queued)
    await expect(host.mediaPolicyQueue).resolves.toBeUndefined()
  })

  it('reports the host DTLS security code after creating an offer', async () => {
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onSecurityCode = vi.fn()
    const videoTrack = {
      applyConstraints: vi.fn().mockResolvedValue(undefined),
      contentHint: '',
      getSettings: () => ({ height: 720, width: 1280 }),
      kind: 'video',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    stubNativeRemoteCapture(videoTrack)

    class FakePeerConnection {
      localDescription: RTCSessionDescriptionInit | null = null
      onconnectionstatechange: (() => void) | null = null
      onicecandidate: ((event: unknown) => void) | null = null
      addTrack = vi.fn(() => ({
        getParameters: () => ({ encodings: [] }),
        setParameters: vi.fn(),
        track: videoTrack,
      }))
      addTransceiver = vi.fn(() => ({
        direction: 'sendrecv',
        receiver: { track: { kind: 'audio' } },
        sender: { replaceTrack: vi.fn(), track: null },
      }))
      close = vi.fn()
      createDataChannel = vi.fn(() => ({
        close: vi.fn(),
        onclose: null,
        onmessage: null,
        onopen: null,
      }))
      createOffer = vi.fn().mockResolvedValue({
        sdp: 'v=0\r\na=fingerprint:sha-256 12:34:AB:CD:EF:90:00:11\r\n',
        type: 'offer',
      })
      setLocalDescription = vi.fn(
        async (description: RTCSessionDescriptionInit) => {
          this.localDescription = description
        }
      )
      getTransceivers = vi.fn(() => [])
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)

    await remoteWebRtcHost.connect({
      sessionId: 'session-1',
      signalingPort: 49152,
      token: 'invite-token',
      callbacks: { onSecurityCode },
    })
    await remoteWebRtcHost.startViewOnlyOffer('guest-device')

    expect(onSecurityCode).toHaveBeenCalledWith('1234-ABCD-EF90')
    const videoOffer = FakeWebSocket.latest?.sent
      .map(value => JSON.parse(value))
      .find(message => message.type === 'video_offer')
    expect(videoOffer?.payload).toMatchObject({
      encrypted: true,
      version: 'easycris-lan-signaling-v1',
    })
    expect(JSON.stringify(videoOffer?.payload)).not.toContain('a=fingerprint')
  })

  it('cleans up host state when session revoke notification cannot be sent', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)

    await remoteWebRtcHost.connect({
      mode: 'cloud',
      sessionId: 'rmt_abc123',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      hostSecret: 'host-secret',
    })
    const latestSocket = FakeWebSocket.latest
    expect(latestSocket).toBeDefined()
    if (!latestSocket) {
      throw new Error('missing fake websocket')
    }
    const send = vi.spyOn(latestSocket, 'send').mockImplementation(() => {
      throw new Error('socket closing')
    })

    await expect(remoteWebRtcHost.close(true)).resolves.toBeUndefined()

    expect(JSON.parse(send.mock.calls[0]?.[0] ?? '{}')).toEqual({
      type: 'session_revoked',
      invite_id: 'rmt_abc123',
    })
    await expect(remoteWebRtcHost.waitForDataChannelOpen(1)).rejects.toThrow(
      'Remote-session data channel is not active'
    )
  })

  it('reports revoke delivery failures during host cleanup', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onError = vi.fn()

    await remoteWebRtcHost.connect({
      mode: 'cloud',
      sessionId: 'rmt_abc123',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      hostSecret: 'host-secret',
      callbacks: { onError },
    })
    const latestSocket = FakeWebSocket.latest
    expect(latestSocket).toBeDefined()
    if (!latestSocket) {
      throw new Error('missing fake websocket')
    }
    vi.spyOn(latestSocket, 'send').mockImplementation(() => {
      throw new Error('socket closing')
    })

    await remoteWebRtcHost.close(true)

    expect(onError).toHaveBeenCalledWith('socket closing')
  })

  it('reports join rejection send failures even if host cleanup clears callbacks', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onError = vi.fn()

    await remoteWebRtcHost.connect({
      mode: 'cloud',
      sessionId: 'rmt_abc123',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      hostSecret: 'host-secret',
      callbacks: { onError },
    })
    const latestSocket = FakeWebSocket.latest
    expect(latestSocket).toBeDefined()
    if (!latestSocket) {
      throw new Error('missing fake websocket')
    }
    vi.spyOn(latestSocket, 'send').mockImplementation(() => {
      throw new Error('socket closing')
    })

    remoteWebRtcHost.rejectGuest('guest-device', 'Host rejected')
    await Promise.resolve()
    await remoteWebRtcHost.close(false)

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('socket closing')
    )
  })

  it('closes the local peer when the relay reports a signaling error', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onError = vi.fn()
    const close = vi.fn()
    const closeDataChannel = vi.fn()
    const stop = vi.fn()

    await remoteWebRtcHost.connect({
      mode: 'cloud',
      sessionId: 'rmt_abc123',
      inviteId: 'rmt_abc123',
      relayUrl: 'wss://remote.easycris.com/v1/remote/signaling',
      hostSecret: 'host-secret',
      callbacks: { onError },
    })
    ;(
      remoteWebRtcHost as unknown as {
        peerConnection: { close: () => void } | null
        dataChannel: { close: () => void } | null
        stream: { getTracks: () => { stop: () => void }[] } | null
      }
    ).peerConnection = { close }
    ;(
      remoteWebRtcHost as unknown as {
        dataChannel: { close: () => void } | null
      }
    ).dataChannel = { close: closeDataChannel }
    ;(
      remoteWebRtcHost as unknown as {
        stream: { getTracks: () => { stop: () => void }[] } | null
      }
    ).stream = { getTracks: () => [{ stop }] }

    FakeWebSocket.latest?.receive({
      type: 'error',
      reason: 'guest is not connected',
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('guest is not connected')
    )
    await vi.waitFor(() => expect(close).toHaveBeenCalled())
    expect(closeDataChannel).toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
  })
})

describe('remoteWebRtcHost idle timeout', () => {
  let triggerConnectionFailure: (() => void) | null = null
  let triggerConnectionState:
    | ((state: RTCPeerConnectionState) => void)
    | null = null

  afterEach(async () => {
    vi.useRealTimers()
    await remoteWebRtcHost.close(false)
    FakeWebSocket.latest = null
    triggerConnectionFailure = null
    triggerConnectionState = null
    vi.unstubAllGlobals()
    remoteSessionServiceMock.sendRemoteKeyInput.mockReset()
    remoteSessionServiceMock.sendRemoteMouseInput.mockReset()
  })

  const startLanHostWithDataChannel = async (
    callbacks: Record<string, unknown>
  ) => {
    vi.useFakeTimers()
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    stubNativeRemoteCapture()

    const dataChannel = {
      close: vi.fn(),
      onclose: null as (() => void) | null,
      onmessage: null as ((event: MessageEvent) => void) | null,
      onopen: null as (() => void) | null,
      readyState: 'open',
      send: vi.fn(),
    }

    class FakePeerConnection {
      connectionState: RTCPeerConnectionState = 'new'
      onconnectionstatechange: (() => void) | null = null
      onicecandidate: ((event: unknown) => void) | null = null

      constructor() {
        triggerConnectionState = state => {
          this.connectionState = state
          this.onconnectionstatechange?.()
        }
        triggerConnectionFailure = () => {
          triggerConnectionState?.('failed')
        }
      }

      addTrack = vi.fn(() => ({
        getParameters: () => ({ encodings: [] }),
        setParameters: vi.fn(),
      }))
      addTransceiver = vi.fn(() => ({
        direction: 'sendrecv',
        receiver: { track: { kind: 'audio' } },
        sender: { replaceTrack: vi.fn(), track: null },
      }))
      close = vi.fn()
      createDataChannel = vi.fn(() => dataChannel)
      createOffer = vi
        .fn()
        .mockResolvedValue({ sdp: 'offer-sdp', type: 'offer' })
      getTransceivers = vi.fn(() => [])
      setLocalDescription = vi.fn().mockResolvedValue(undefined)
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)

    await remoteWebRtcHost.connect({
      mode: 'lan',
      sessionId: 'session-1',
      signalingPort: 49152,
      token: 'invite-token',
      callbacks: callbacks as never,
    })
    await remoteWebRtcHost.startViewOnlyOffer('guest-device')
    dataChannel.onopen?.()
    return dataChannel
  }

  const nextAcceptedMouseInput = () =>
    new Promise<void>(resolve => {
      remoteSessionServiceMock.sendRemoteMouseInput.mockImplementation(
        async () => {
          resolve()
          return { physical_x: 1, physical_y: 2 }
        }
      )
    })

  const sendMouseClick = (dataChannel: {
    onmessage: ((event: MessageEvent) => void) | null
  }) => {
    dataChannel.onmessage?.({
      data: JSON.stringify({
        type: 'mouse',
        event: {
          action: 'click',
          button: 'left',
          guest_device_id: 'guest-device',
          modifiers: {
            alt: false,
            ctrl: false,
            meta: false,
            shift: false,
          },
          normalized_x: 0.5,
          normalized_y: 0.5,
          session_id: 'session-1',
          source_height: 100,
          source_width: 100,
        },
      }),
    } as MessageEvent)
  }

  const sendMouseMove = (dataChannel: {
    onmessage: ((event: MessageEvent) => void) | null
  }) => {
    dataChannel.onmessage?.({
      data: JSON.stringify({
        type: 'mouse',
        event: {
          action: 'move',
          button: null,
          guest_device_id: 'guest-device',
          modifiers: {
            alt: false,
            ctrl: false,
            meta: false,
            shift: false,
          },
          normalized_x: 0.25,
          normalized_y: 0.75,
          session_id: 'session-1',
          source_height: 100,
          source_width: 100,
        },
      }),
    } as MessageEvent)
  }

  const sendMouseDown = (dataChannel: {
    onmessage: ((event: MessageEvent) => void) | null
  }) => {
    dataChannel.onmessage?.({
      data: JSON.stringify({
        type: 'mouse',
        event: {
          action: 'down',
          button: 'left',
          guest_device_id: 'guest-device',
          modifiers: {
            alt: false,
            ctrl: false,
            meta: false,
            shift: false,
          },
          normalized_x: 0.5,
          normalized_y: 0.5,
          session_id: 'session-1',
          source_height: 100,
          source_width: 100,
        },
      }),
    } as MessageEvent)
  }

  const sendMouseUp = (dataChannel: {
    onmessage: ((event: MessageEvent) => void) | null
  }) => {
    dataChannel.onmessage?.({
      data: JSON.stringify({
        type: 'mouse',
        event: {
          action: 'up',
          button: 'left',
          guest_device_id: 'guest-device',
          modifiers: {
            alt: false,
            ctrl: false,
            meta: false,
            shift: false,
          },
          normalized_x: 0.5,
          normalized_y: 0.5,
          session_id: 'session-1',
          source_height: 100,
          source_width: 100,
        },
      }),
    } as MessageEvent)
  }

  const sendKeyClick = (dataChannel: {
    onmessage: ((event: MessageEvent) => void) | null
  }) => {
    dataChannel.onmessage?.({
      data: JSON.stringify({
        type: 'key',
        event: {
          action: 'click',
          guest_device_id: 'guest-device',
          key: { kind: 'named', value: 'enter' },
          modifiers: {
            alt: false,
            ctrl: false,
            meta: false,
            shift: false,
          },
          session_id: 'session-1',
        },
      }),
    } as MessageEvent)
  }

  const sendAudioState = (
    dataChannel: { onmessage: ((event: MessageEvent) => void) | null },
    state: { muted: boolean; receiving: boolean; sending: boolean; seq?: number }
  ) => {
    dataChannel.onmessage?.({
      data: JSON.stringify({
        type: 'audio_state',
        ...state,
      }),
    } as MessageEvent)
  }

  const flushInputQueue = async () => {
    await (remoteWebRtcHost as unknown as { inputQueue: Promise<void> })
      .inputQueue
  }

  const flushMouseMoveQueue = async () => {
    await (remoteWebRtcHost as unknown as { mouseMoveQueue: Promise<void> })
      .mouseMoveQueue
  }

  it('warns after nine idle minutes and expires after ten', async () => {
    const onIdleWarning = vi.fn()
    const onIdleExpired = vi.fn()

    await startLanHostWithDataChannel({ onIdleWarning, onIdleExpired })

    vi.advanceTimersByTime(9 * 60_000 - 1)
    expect(onIdleWarning).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onIdleWarning).toHaveBeenCalledWith(60)
    expect(onIdleExpired).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)
    expect(onIdleExpired).toHaveBeenCalledTimes(1)
  })

  it('resets the idle warning and expiry after accepted remote input', async () => {
    const onIdleWarning = vi.fn()
    const onIdleExpired = vi.fn()
    const inputAccepted = nextAcceptedMouseInput()
    const dataChannel = await startLanHostWithDataChannel({
      onIdleWarning,
      onIdleExpired,
    })

    vi.advanceTimersByTime(8 * 60_000)
    sendMouseClick(dataChannel)
    await inputAccepted
    await Promise.resolve()

    vi.advanceTimersByTime(60_000)
    expect(onIdleWarning).not.toHaveBeenCalled()

    vi.advanceTimersByTime(8 * 60_000)
    expect(onIdleWarning).toHaveBeenCalledWith(60)
    vi.advanceTimersByTime(60_000)
    expect(onIdleExpired).toHaveBeenCalledTimes(1)
  })

  it('does not queue mouse moves behind a slow click injection', async () => {
    const releaseClick: { current?: () => void } = {}
    remoteSessionServiceMock.sendRemoteMouseInput.mockImplementation(
      async event => {
        if (event.action === 'click') {
          await new Promise<void>(resolve => {
            releaseClick.current = resolve
          })
        }
        return { physical_x: 1, physical_y: 2 }
      }
    )
    const dataChannel = await startLanHostWithDataChannel({})

    sendMouseClick(dataChannel)
    sendMouseMove(dataChannel)
    await Promise.resolve()
    await flushMouseMoveQueue()

    try {
      expect(remoteSessionServiceMock.sendRemoteMouseInput).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'move' })
      )
    } finally {
      releaseClick.current?.()
      await flushInputQueue()
    }
  })

  it('forwards mouse input without host window geometry fields', async () => {
    const screenPoint = {
      rect_height: 400,
      rect_left: 10,
      rect_top: 20,
      rect_width: 600,
      screen_x: 300,
      screen_y: 200,
    }
    remoteSessionServiceMock.sendRemoteMouseInput.mockResolvedValue(screenPoint)
    const dataChannel = await startLanHostWithDataChannel({})

    sendMouseClick(dataChannel)
    await flushInputQueue()

    expect(remoteSessionServiceMock.sendRemoteMouseInput).toHaveBeenCalled()
    const event = remoteSessionServiceMock.sendRemoteMouseInput.mock.calls[0]?.[0]
    expect(event).toBeDefined()
    if (!event) throw new Error('sendRemoteMouseInput was not called')
    expect(Object.hasOwn(event, 'target_height')).toBe(false)
    expect(Object.hasOwn(event, 'target_left')).toBe(false)
    expect(Object.hasOwn(event, 'target_top')).toBe(false)
    expect(Object.hasOwn(event, 'target_width')).toBe(false)
    const diagnostics = remoteWebRtcHost.getInputDiagnostics()
    expect(diagnostics).toMatchObject({
      lastAcceptedInputScreenPoint: screenPoint,
    })
    expect(diagnostics.recentAcceptedInputScreenPoints).toContainEqual(
      screenPoint
    )
  })

  it('counts rejected mouse input diagnostics when host injection fails', async () => {
    remoteSessionServiceMock.sendRemoteMouseInput.mockRejectedValue(
      new Error('Remote input is outside the easyCris capture surface')
    )
    const dataChannel = await startLanHostWithDataChannel({})
    const before = remoteWebRtcHost.getInputDiagnostics()

    sendMouseClick(dataChannel)
    await flushInputQueue()

    const after = remoteWebRtcHost.getInputDiagnostics()
    expect(after.acceptedInputCount).toBe(before.acceptedInputCount)
    expect(after.rejectedMouseInputCount).toBe(
      before.rejectedMouseInputCount + 1
    )
  })

  it('tracks repeated remote input geometry errors without notifying the UI', async () => {
    const onError = vi.fn()
    remoteSessionServiceMock.sendRemoteMouseInput.mockRejectedValue(
      new Error(
        'Remote input surface moved or resized; restart remote sharing to continue control'
      )
    )
    const dataChannel = await startLanHostWithDataChannel({ onError })
    const before = remoteWebRtcHost.getInputDiagnostics()

    sendMouseMove(dataChannel)
    sendMouseMove(dataChannel)
    sendMouseMove(dataChannel)
    await flushMouseMoveQueue()

    const after = remoteWebRtcHost.getInputDiagnostics()
    expect(after.acceptedInputCount).toBe(before.acceptedInputCount)
    expect(after.rejectedMouseInputCount).toBe(
      before.rejectedMouseInputCount + 3
    )
    expect(after.lastRejectedMouseInputError).toBe(
      'Remote input surface moved or resized; restart remote sharing to continue control'
    )
    expect(onError).not.toHaveBeenCalled()
  })

  it('tracks remote input window changes without notifying the UI', async () => {
    const onError = vi.fn()
    remoteSessionServiceMock.sendRemoteMouseInput.mockRejectedValue(
      new Error(
        'Remote input window changed; restart remote sharing to continue control'
      )
    )
    const dataChannel = await startLanHostWithDataChannel({ onError })
    const before = remoteWebRtcHost.getInputDiagnostics()

    sendMouseMove(dataChannel)
    await flushMouseMoveQueue()

    const after = remoteWebRtcHost.getInputDiagnostics()
    expect(after.acceptedInputCount).toBe(before.acceptedInputCount)
    expect(after.rejectedMouseInputCount).toBe(
      before.rejectedMouseInputCount + 1
    )
    expect(after.lastRejectedMouseInputError).toBe(
      'Remote input window changed; restart remote sharing to continue control'
    )
    expect(onError).not.toHaveBeenCalled()
  })

  it('tracks foreground confirmation failures without notifying the UI', async () => {
    const onError = vi.fn()
    const errorMessage =
      'Timed out confirming easyCris foreground for remote input. target_hwnd=0x1'
    remoteSessionServiceMock.sendRemoteMouseInput.mockRejectedValue(
      new Error(errorMessage)
    )
    const dataChannel = await startLanHostWithDataChannel({ onError })
    const before = remoteWebRtcHost.getInputDiagnostics()

    sendMouseClick(dataChannel)
    await flushInputQueue()

    const after = remoteWebRtcHost.getInputDiagnostics()
    expect(after.acceptedInputCount).toBe(before.acceptedInputCount)
    expect(after.rejectedMouseInputCount).toBe(
      before.rejectedMouseInputCount + 1
    )
    expect(after.lastRejectedMouseInputError).toBe(errorMessage)
    expect(onError).not.toHaveBeenCalled()
  })

  it('records accepted mouse input forwarding timing diagnostics', async () => {
    const dataChannel = await startLanHostWithDataChannel({})

    sendMouseClick(dataChannel)
    await flushInputQueue()

    const diagnostics = remoteWebRtcHost.getInputDiagnostics()
    expect(diagnostics.lastMouseInputForwardElapsedMs).toEqual(
      expect.any(Number)
    )
    expect(diagnostics.lastMouseInputForwardElapsedMs).toBeGreaterThanOrEqual(0)
    expect(diagnostics.recentMouseInputForwardElapsedMs.length).toBeGreaterThan(
      0
    )
    expect(diagnostics.recentMouseInputForwardElapsedMs.at(-1)).toBe(
      diagnostics.lastMouseInputForwardElapsedMs
    )
  })

  it('tracks non-fatal key input geometry errors without notifying the UI', async () => {
    const onError = vi.fn()
    remoteSessionServiceMock.sendRemoteKeyInput.mockRejectedValue(
      new Error(
        'Remote input surface moved or resized; restart remote sharing to continue control'
      )
    )
    const dataChannel = await startLanHostWithDataChannel({ onError })
    const before = remoteWebRtcHost.getInputDiagnostics()

    sendKeyClick(dataChannel)
    await flushInputQueue()

    const after = remoteWebRtcHost.getInputDiagnostics()
    expect(remoteSessionServiceMock.sendRemoteKeyInput).toHaveBeenCalledTimes(1)
    expect(remoteSessionServiceMock.sendRemoteKeyInput).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'click',
        key: { kind: 'named', value: 'enter' },
      })
    )
    expect(after.acceptedInputCount).toBe(before.acceptedInputCount)
    expect(onError).not.toHaveBeenCalled()
  })

  it('tracks outside capture surface input without notifying the UI', async () => {
    const onError = vi.fn()
    remoteSessionServiceMock.sendRemoteMouseInput.mockRejectedValue(
      new Error('Remote input is outside the easyCris capture surface')
    )
    const dataChannel = await startLanHostWithDataChannel({ onError })
    const before = remoteWebRtcHost.getInputDiagnostics()

    sendMouseClick(dataChannel)
    await flushInputQueue()

    const after = remoteWebRtcHost.getInputDiagnostics()
    expect(after.acceptedInputCount).toBe(before.acceptedInputCount)
    expect(after.rejectedMouseInputCount).toBe(
      before.rejectedMouseInputCount + 1
    )
    expect(after.lastRejectedMouseInputError).toBe(
      'Remote input is outside the easyCris capture surface'
    )
    expect(onError).not.toHaveBeenCalled()
  })

  it('coalesces release failures while clearing pressed inputs', async () => {
    const onError = vi.fn()
    await startLanHostWithDataChannel({ onError })
    const host = remoteWebRtcHost as unknown as {
      pressedButtons: Map<string, unknown>
      releasePressedInputs: () => Promise<void>
    }
    const releaseError = new Error('release failed')
    host.pressedButtons.set('left', {
      action: 'down',
      button: 'left',
      guest_device_id: 'guest-device',
      modifiers: {
        alt: false,
        ctrl: false,
        meta: false,
        shift: false,
      },
      normalized_x: 0.5,
      normalized_y: 0.5,
      session_id: 'session-1',
      source_height: 100,
      source_width: 100,
    })
    host.pressedButtons.set('right', {
      action: 'down',
      button: 'right',
      guest_device_id: 'guest-device',
      modifiers: {
        alt: false,
        ctrl: false,
        meta: false,
        shift: false,
      },
      normalized_x: 0.6,
      normalized_y: 0.6,
      session_id: 'session-1',
      source_height: 100,
      source_width: 100,
    })
    remoteSessionServiceMock.sendRemoteMouseInput.mockRejectedValue(
      releaseError
    )

    await host.releasePressedInputs()

    expect(remoteSessionServiceMock.sendRemoteMouseInput).toHaveBeenCalledTimes(
      2
    )
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('release failed')
  })

  it('reports host peer connection diagnostics', () => {
    const host = remoteWebRtcHost as unknown as {
      dataChannel: { close: () => void; readyState: RTCDataChannelState } | null
      peerConnection: {
        close: () => void
        connectionState: RTCPeerConnectionState
        iceConnectionState: RTCIceConnectionState
      } | null
    }
    host.peerConnection = {
      close: vi.fn(),
      connectionState: 'connecting',
      iceConnectionState: 'checking',
    }
    host.dataChannel = { close: vi.fn(), readyState: 'open' }

    expect(remoteWebRtcHost.getPeerConnectionDiagnostics()).toEqual({
      dataChannelState: 'open',
      iceConnectionState: 'checking',
      peerConnectionState: 'connecting',
    })
  })

  it('keeps drag mouse moves behind a pending button transition', async () => {
    const releaseDown: { current?: () => void } = {}
    const downStartedSignal: { current?: () => void } = {}
    const downStarted = new Promise<void>(resolve => {
      downStartedSignal.current = resolve
    })
    remoteSessionServiceMock.sendRemoteMouseInput.mockImplementation(
      async event => {
        if (event.action === 'down') {
          downStartedSignal.current?.()
          await new Promise<void>(resolve => {
            releaseDown.current = resolve
          })
        }
        return { physical_x: 1, physical_y: 2 }
      }
    )
    const dataChannel = await startLanHostWithDataChannel({})

    sendMouseDown(dataChannel)
    await downStarted
    sendMouseMove(dataChannel)
    await Promise.resolve()

    try {
      expect(
        remoteSessionServiceMock.sendRemoteMouseInput
      ).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'move' }))
    } finally {
      releaseDown.current?.()
      await flushInputQueue()
    }

    expect(remoteSessionServiceMock.sendRemoteMouseInput).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'move' })
    )
  })

  it('releases a stale pressed button before accepting a duplicate down', async () => {
    remoteSessionServiceMock.sendRemoteMouseInput.mockResolvedValue({
      physical_x: 1,
      physical_y: 2,
    })
    const dataChannel = await startLanHostWithDataChannel({})

    sendMouseDown(dataChannel)
    await flushInputQueue()
    sendMouseDown(dataChannel)
    await flushInputQueue()

    expect(
      remoteSessionServiceMock.sendRemoteMouseInput.mock.calls.map(
        ([event]) => event.action
      )
    ).toEqual(['down', 'up', 'down'])
    expect(
      remoteSessionServiceMock.sendRemoteMouseInput.mock.calls[1]?.[0]
    ).toMatchObject({
      action: 'up',
      button: 'left',
      normalized_x: 0.5,
      normalized_y: 0.5,
    })
  })

  it('does not forward a duplicate down when releasing the stale press fails', async () => {
    remoteSessionServiceMock.sendRemoteMouseInput.mockImplementation(
      async event => {
        if (event.action === 'up') {
          throw new Error('release failed')
        }
        return { physical_x: 1, physical_y: 2 }
      }
    )
    const dataChannel = await startLanHostWithDataChannel({})

    sendMouseDown(dataChannel)
    await flushInputQueue()
    sendMouseDown(dataChannel)
    await flushInputQueue()

    expect(
      remoteSessionServiceMock.sendRemoteMouseInput.mock.calls.map(
        ([event]) => event.action
      )
    ).toEqual(['down', 'up'])
  })

  it('does not keep suppressing same-button downs after a stale release failure', async () => {
    remoteSessionServiceMock.sendRemoteMouseInput.mockImplementation(
      async event => {
        if (event.action === 'up') {
          throw new Error('release failed')
        }
        return { physical_x: 1, physical_y: 2 }
      }
    )
    const dataChannel = await startLanHostWithDataChannel({})

    sendMouseDown(dataChannel)
    await flushInputQueue()
    sendMouseDown(dataChannel)
    await flushInputQueue()
    sendMouseDown(dataChannel)
    await flushInputQueue()

    expect(
      remoteSessionServiceMock.sendRemoteMouseInput.mock.calls.map(
        ([event]) => event.action
      )
    ).toEqual(['down', 'up', 'down'])
  })

  it('exposes pending pressed-button state for remote input diagnostics', async () => {
    remoteSessionServiceMock.sendRemoteMouseInput.mockResolvedValue({
      physical_x: 1,
      physical_y: 2,
    })
    const dataChannel = await startLanHostWithDataChannel({})

    sendMouseDown(dataChannel)
    await flushInputQueue()

    expect(remoteWebRtcHost.getInputDiagnostics()).toMatchObject({
      pendingMouseButtonTransitionCount: 0,
      pressedMouseButtonCount: 1,
      pressedMouseButtons: ['left'],
    })

    sendMouseUp(dataChannel)
    await flushInputQueue()

    expect(remoteWebRtcHost.getInputDiagnostics()).toMatchObject({
      pendingMouseButtonTransitionCount: 0,
      pressedMouseButtonCount: 0,
      pressedMouseButtons: [],
    })
  })

  it('keeps mouse moves behind a pending button release', async () => {
    const releaseUp: { current?: () => void } = {}
    const upStartedSignal: { current?: () => void } = {}
    const upStarted = new Promise<void>(resolve => {
      upStartedSignal.current = resolve
    })
    remoteSessionServiceMock.sendRemoteMouseInput.mockImplementation(
      async event => {
        if (event.action === 'up') {
          upStartedSignal.current?.()
          await new Promise<void>(resolve => {
            releaseUp.current = resolve
          })
        }
        return { physical_x: 1, physical_y: 2 }
      }
    )
    const dataChannel = await startLanHostWithDataChannel({})

    sendMouseUp(dataChannel)
    await upStarted
    sendMouseMove(dataChannel)
    await flushMouseMoveQueue()

    try {
      expect(
        remoteSessionServiceMock.sendRemoteMouseInput
      ).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'move' }))
    } finally {
      releaseUp.current?.()
      await flushInputQueue()
    }

    expect(remoteSessionServiceMock.sendRemoteMouseInput).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'move' })
    )
  })

  it('keeps mouse moves ordered while a button remains pressed', async () => {
    const releaseClick: { current?: () => void } = {}
    const clickStartedSignal: { current?: () => void } = {}
    const clickStarted = new Promise<void>(resolve => {
      clickStartedSignal.current = resolve
    })
    remoteSessionServiceMock.sendRemoteMouseInput.mockImplementation(
      async event => {
        if (event.action === 'click') {
          clickStartedSignal.current?.()
          await new Promise<void>(resolve => {
            releaseClick.current = resolve
          })
        }
        return { physical_x: 1, physical_y: 2 }
      }
    )
    const dataChannel = await startLanHostWithDataChannel({})

    sendMouseDown(dataChannel)
    await flushInputQueue()
    sendMouseClick(dataChannel)
    await clickStarted
    sendMouseMove(dataChannel)
    await flushMouseMoveQueue()

    try {
      expect(
        remoteSessionServiceMock.sendRemoteMouseInput
      ).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'move' }))
    } finally {
      releaseClick.current?.()
      await flushInputQueue()
    }

    expect(remoteSessionServiceMock.sendRemoteMouseInput).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'move' })
    )
  })

  it('resets stale input queues when peer media state is cleared', async () => {
    const host = remoteWebRtcHost as unknown as {
      clearPeerMediaState: () => void
      inputQueue: Promise<void>
      mouseMoveQueue: Promise<void>
    }
    host.inputQueue = new Promise(() => undefined)
    host.mouseMoveQueue = new Promise(() => undefined)

    host.clearPeerMediaState()

    await host.inputQueue
    await host.mouseMoveQueue
  })

  it('clears a visible idle warning after accepted remote input', async () => {
    const onIdleWarning = vi.fn()
    const onIdleReset = vi.fn()
    const inputAccepted = nextAcceptedMouseInput()
    const dataChannel = await startLanHostWithDataChannel({
      onIdleWarning,
      onIdleReset,
    })

    vi.advanceTimersByTime(9 * 60_000)
    expect(onIdleWarning).toHaveBeenCalledWith(60)
    expect(onIdleReset).not.toHaveBeenCalled()

    sendMouseClick(dataChannel)
    await inputAccepted
    await Promise.resolve()

    expect(onIdleReset).toHaveBeenCalledTimes(1)
  })

  it('does not fire idle callbacks after close while timers are running', async () => {
    const onIdleWarning = vi.fn()
    const onIdleExpired = vi.fn()
    await startLanHostWithDataChannel({ onIdleWarning, onIdleExpired })

    vi.advanceTimersByTime(5 * 60_000)
    await remoteWebRtcHost.close(false)
    vi.advanceTimersByTime(10 * 60_000)

    expect(onIdleWarning).not.toHaveBeenCalled()
    expect(onIdleExpired).not.toHaveBeenCalled()
  })

  it('reports a failed peer connection only once per failed state', async () => {
    const onError = vi.fn()
    await startLanHostWithDataChannel({ onError })

    triggerConnectionFailure?.()
    triggerConnectionFailure?.()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(
      'WebRTC connection failed. Ask the guest to reconnect on the same Wi-Fi and approve the session again.'
    )

    triggerConnectionState?.('connected')
    triggerConnectionFailure?.()

    expect(onError).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenLastCalledWith(
      'WebRTC connection failed. Ask the guest to reconnect on the same Wi-Fi and approve the session again.'
    )
  })

  it('does not expire for input idleness while remote intercom audio is active', async () => {
    const onIdleWarning = vi.fn()
    const onIdleExpired = vi.fn()
    const dataChannel = await startLanHostWithDataChannel({
      onIdleWarning,
      onIdleExpired,
    })

    sendAudioState(dataChannel, {
      muted: false,
      receiving: true,
      sending: true,
    })
    await flushInputQueue()

    vi.advanceTimersByTime(10 * 60_000)

    expect(onIdleWarning).not.toHaveBeenCalled()
    expect(onIdleExpired).not.toHaveBeenCalled()
  })

  it('restarts the idle timer when remote intercom audio stops', async () => {
    const onIdleWarning = vi.fn()
    const onIdleExpired = vi.fn()
    const dataChannel = await startLanHostWithDataChannel({
      onIdleWarning,
      onIdleExpired,
    })

    sendAudioState(dataChannel, {
      muted: false,
      receiving: true,
      sending: true,
    })
    await flushInputQueue()
    vi.advanceTimersByTime(10 * 60_000)
    expect(onIdleExpired).not.toHaveBeenCalled()

    sendAudioState(dataChannel, {
      muted: true,
      receiving: true,
      sending: false,
    })
    await flushInputQueue()

    vi.advanceTimersByTime(9 * 60_000)
    expect(onIdleWarning).toHaveBeenCalledWith(60)

    vi.advanceTimersByTime(60_000)
    expect(onIdleExpired).toHaveBeenCalledTimes(1)
  })

  it('clears remote intercom activity when the data channel closes', async () => {
    const dataChannel = await startLanHostWithDataChannel({})

    sendAudioState(dataChannel, {
      muted: false,
      receiving: true,
      sending: true,
    })
    await flushInputQueue()
    expect(
      (
        remoteWebRtcHost as unknown as {
          remoteAudioSending: boolean
        }
      ).remoteAudioSending
    ).toBe(true)

    dataChannel.onclose?.()

    expect(
      (
        remoteWebRtcHost as unknown as {
          remoteAudioSending: boolean
        }
      ).remoteAudioSending
    ).toBe(false)
  })

  it('clears remote intercom activity when ICE fails', async () => {
    const dataChannel = await startLanHostWithDataChannel({})

    sendAudioState(dataChannel, {
      muted: false,
      receiving: true,
      sending: true,
    })
    await flushInputQueue()
    expect(
      (
        remoteWebRtcHost as unknown as {
          remoteAudioSending: boolean
        }
      ).remoteAudioSending
    ).toBe(true)

    expect(triggerConnectionFailure).not.toBeNull()
    if (!triggerConnectionFailure) {
      throw new Error('expected fake connection failure trigger')
    }
    triggerConnectionFailure()

    expect(
      (
        remoteWebRtcHost as unknown as {
          remoteAudioSending: boolean
        }
      ).remoteAudioSending
    ).toBe(false)
  })

  it('accepts legacy remote intercom audio state without a sequence number', async () => {
    const dataChannel = await startLanHostWithDataChannel({})

    sendAudioState(dataChannel, {
      muted: false,
      receiving: true,
      sending: true,
    })
    await flushInputQueue()

    expect(
      (
        remoteWebRtcHost as unknown as {
          remoteAudioSending: boolean
        }
      ).remoteAudioSending
    ).toBe(true)
  })

  it('ignores stale sequenced remote intercom audio state', async () => {
    const dataChannel = await startLanHostWithDataChannel({})

    sendAudioState(dataChannel, {
      muted: false,
      receiving: true,
      sending: true,
      seq: 1,
    })
    await flushInputQueue()
    sendAudioState(dataChannel, {
      muted: true,
      receiving: true,
      sending: false,
      seq: 2,
    })
    await flushInputQueue()
    expect(
      (
        remoteWebRtcHost as unknown as {
          remoteAudioSending: boolean
        }
      ).remoteAudioSending
    ).toBe(false)

    sendAudioState(dataChannel, {
      muted: false,
      receiving: true,
      sending: true,
      seq: 1,
    })
    await flushInputQueue()

    expect(
      (
        remoteWebRtcHost as unknown as {
          remoteAudioSending: boolean
        }
      ).remoteAudioSending
    ).toBe(false)

    sendAudioState(dataChannel, {
      muted: false,
      receiving: true,
      sending: true,
      seq: 2,
    })
    await flushInputQueue()

    expect(
      (
        remoteWebRtcHost as unknown as {
          remoteAudioSending: boolean
        }
      ).remoteAudioSending
    ).toBe(false)
  })

  it('accepts legacy remote intercom audio state after a sequenced update', async () => {
    const dataChannel = await startLanHostWithDataChannel({})

    sendAudioState(dataChannel, {
      muted: true,
      receiving: true,
      sending: false,
      seq: 1,
    })
    await flushInputQueue()
    sendAudioState(dataChannel, {
      muted: false,
      receiving: true,
      sending: true,
    })
    await flushInputQueue()

    expect(
      (
        remoteWebRtcHost as unknown as {
          remoteAudioSending: boolean
        }
      ).remoteAudioSending
    ).toBe(true)
  })
})
