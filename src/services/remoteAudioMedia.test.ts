import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeMicrophoneAudioStream } from '@/services/remoteNativeAudioMedia'
import {
  RemoteAudioSenderInactiveError,
  getRemoteAudioCaptureSource,
  listRemoteAudioInputDevices,
  remoteAudioProcessingDiagnostics,
  remoteAudioErrorMessage,
  getRemoteMicrophoneConstraints,
  getRemoteMicrophoneStream,
  isE2ERemoteAudioMockEnabled,
  stopRemoteAudioStream,
} from '@/services/remoteAudioMedia'

vi.mock('@/services/remoteNativeAudioMedia', async importOriginal => ({
  ...(await importOriginal<typeof import('@/services/remoteNativeAudioMedia')>()),
  createNativeMicrophoneAudioStream: vi.fn(),
}))

const mockCreateNativeMicrophoneAudioStream = vi.mocked(
  createNativeMicrophoneAudioStream
)

describe('remoteAudioMedia', () => {
  afterEach(() => {
    mockCreateNativeMicrophoneAudioStream.mockReset()
    vi.clearAllMocks()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete window.__E2E_REMOTE_AUDIO_MOCK__
    delete window.__E2E_REMOTE_AUDIO_MOCK_FREQUENCY__
    delete window.__E2E_NATIVE_REMOTE_AUDIO_MOCK__
    delete window.__E2E_NATIVE_REMOTE_AUDIO_STREAM_FACTORY__
  })

  it('requests microphone audio with browser voice processing constraints', async () => {
    const mediaStream = {
      getTracks: () => [],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(mediaStream)
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia },
    })

    await expect(getRemoteMicrophoneStream()).resolves.toBe(mediaStream)

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    })
  })

  it('requests a specific microphone device when selected', async () => {
    const mediaStream = {
      getTracks: () => [],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(mediaStream)
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia },
    })

    await expect(getRemoteMicrophoneStream(undefined, 'mic-1')).resolves.toBe(
      mediaStream
    )

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        deviceId: { exact: 'mic-1' },
      },
      video: false,
    })
  })

  it('prefers native microphone capture in normal app mode', async () => {
    const nativeStream = {
      getTracks: () => [],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockRejectedValue(new Error('should not use browser mic'))
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia },
    })
    mockCreateNativeMicrophoneAudioStream.mockResolvedValue(nativeStream)

    await expect(getRemoteMicrophoneStream('development')).resolves.toBe(
      nativeStream
    )

    expect(getRemoteAudioCaptureSource(nativeStream)).toBe('native-mic')
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('uses browser microphone capture when a specific device is selected', async () => {
    const mediaStream = {
      getTracks: () => [],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(mediaStream)
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia },
    })
    mockCreateNativeMicrophoneAudioStream.mockRejectedValue(
      new Error('should not use native mic')
    )

    await expect(
      getRemoteMicrophoneStream('production', 'mic-1')
    ).resolves.toBe(mediaStream)

    expect(mockCreateNativeMicrophoneAudioStream).not.toHaveBeenCalled()
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        deviceId: { exact: 'mic-1' },
      },
      video: false,
    })
  })

  it('falls back to browser microphone capture when native capture is unavailable', async () => {
    const mediaStream = {
      getTracks: () => [],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(mediaStream)
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockCreateNativeMicrophoneAudioStream.mockRejectedValue(
      new Error('native unavailable')
    )

    await expect(getRemoteMicrophoneStream('production')).resolves.toBe(
      mediaStream
    )

    expect(getRemoteAudioCaptureSource(mediaStream)).toBe('webview-microphone')
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('lists microphone input devices', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'audioinput', deviceId: 'mic-1', label: 'Headset' },
          { kind: 'videoinput', deviceId: 'camera-1', label: 'Camera' },
          { kind: 'audioinput', deviceId: 'mic-2', label: '' },
        ]),
      },
    })

    await expect(listRemoteAudioInputDevices()).resolves.toEqual([
      { deviceId: 'mic-1', label: 'Headset' },
      { deviceId: 'mic-2', label: 'Microphone 1' },
    ])
  })

  it('numbers multiple unnamed microphone input devices', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'audioinput', deviceId: 'mic-1', label: '' },
          { kind: 'audioinput', deviceId: 'mic-2', label: '' },
        ]),
      },
    })

    await expect(listRemoteAudioInputDevices()).resolves.toEqual([
      { deviceId: 'mic-1', label: 'Microphone 1' },
      { deviceId: 'mic-2', label: 'Microphone 2' },
    ])
  })

  it('exposes microphone constraints without touching browser APIs', () => {
    expect(getRemoteMicrophoneConstraints()).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    })
  })

  it('documents browser audio processing and leaves custom VAD disabled', () => {
    expect(remoteAudioProcessingDiagnostics()).toEqual({
      browserEchoCancellationRequested: true,
      browserNoiseSuppressionRequested: true,
      browserAutoGainControlRequested: true,
      customVadEnabled: false,
    })
  })

  it('enables E2E audio mock only in e2e mode with the runtime flag', () => {
    window.__E2E_REMOTE_AUDIO_MOCK__ = true

    expect(isE2ERemoteAudioMockEnabled('e2e', true)).toBe(true)
    expect(isE2ERemoteAudioMockEnabled('development', true)).toBe(false)
    expect(isE2ERemoteAudioMockEnabled('e2e', false)).toBe(false)
  })

  it('prefers the native E2E audio source over browser getUserMedia when enabled', async () => {
    window.__E2E_NATIVE_REMOTE_AUDIO_MOCK__ = true
    window.__E2E_REMOTE_AUDIO_MOCK_FREQUENCY__ = 660
    const mediaStream = {
      getTracks: () => [],
      getAudioTracks: () => [],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockRejectedValue(new Error('should not use browser mic'))
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia },
    })
    window.__E2E_NATIVE_REMOTE_AUDIO_STREAM_FACTORY__ = vi
      .fn()
      .mockResolvedValue(mediaStream)

    await expect(getRemoteMicrophoneStream('e2e')).resolves.toBe(mediaStream)

    expect(getRemoteAudioCaptureSource(mediaStream)).toBe('e2e-native-mock')
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(window.__E2E_NATIVE_REMOTE_AUDIO_STREAM_FACTORY__).toHaveBeenCalledWith(
      660
    )
  })

  it('creates an E2E mock audio stream and closes audio resources when the track stops', async () => {
    window.__E2E_REMOTE_AUDIO_MOCK__ = true
    const close = vi.fn(async function closeContext(this: { state: string }) {
      this.state = 'closed'
    })
    const stopSource = vi.fn()
    const disconnectSource = vi.fn()
    const connectSource = vi.fn()
    const startSource = vi.fn()
    const stopTrack = vi.fn()
    const track = {
      kind: 'audio',
      readyState: 'live',
      stop: stopTrack,
    } as unknown as MediaStreamTrack
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream

    class FakeAudioContext {
      state = 'running'
      close = close
      createMediaStreamDestination = vi.fn(() => ({ stream }))
      createOscillator = vi.fn(() => ({
        connect: connectSource,
        disconnect: disconnectSource,
        start: startSource,
        stop: stopSource,
        frequency: { value: 0 },
      }))
    }

    vi.stubGlobal('AudioContext', FakeAudioContext)

    const result = await getRemoteMicrophoneStream('e2e')
    const [resultTrack] = result.getAudioTracks()
    expect(resultTrack).toBeDefined()
    if (!resultTrack) {
      throw new Error('missing audio track')
    }

    resultTrack.stop()
    await Promise.resolve()

    expect(result).toBe(stream)
    expect(startSource).toHaveBeenCalledOnce()
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(stopSource).toHaveBeenCalledOnce()
    expect(disconnectSource).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect((close.mock.instances[0] as { state: string }).state).toBe('closed')
  })

  it('uses the configured E2E mock audio frequency when creating the stream', async () => {
    window.__E2E_REMOTE_AUDIO_MOCK__ = true
    window.__E2E_REMOTE_AUDIO_MOCK_FREQUENCY__ = 660
    const stopTrack = vi.fn()
    const track = {
      kind: 'audio',
      readyState: 'live',
      stop: stopTrack,
    } as unknown as MediaStreamTrack
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream
    const frequency = { value: 0 }
    const startSource = vi.fn()

    class FakeAudioContext {
      close = vi.fn()
      createMediaStreamDestination = vi.fn(() => ({ stream }))
      createOscillator = vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: startSource,
        stop: vi.fn(),
        frequency,
      }))
    }

    vi.stubGlobal('AudioContext', FakeAudioContext)

    await getRemoteMicrophoneStream('e2e')

    expect(frequency.value).toBe(660)
    expect(startSource).toHaveBeenCalledOnce()
  })

  it('stops every track in a remote audio stream', () => {
    const first = { stop: vi.fn() }
    const second = { stop: vi.fn() }

    stopRemoteAudioStream({
      getTracks: () => [first, second],
    } as unknown as MediaStream)
    stopRemoteAudioStream(null)

    expect(first.stop).toHaveBeenCalledOnce()
    expect(second.stop).toHaveBeenCalledOnce()
  })

  it('describes common microphone and playback failures with user-facing copy', () => {
    expect(
      remoteAudioErrorMessage(new DOMException('', 'NotAllowedError'), 'microphone')
    ).toBe(
      'Microphone permission was denied. Allow microphone access and try again.'
    )
    expect(
      remoteAudioErrorMessage(new DOMException('', 'NotFoundError'), 'microphone')
    ).toBe('No microphone was found. Connect a microphone and try again.')
    expect(
      remoteAudioErrorMessage(
        new DOMException('', 'NotReadableError'),
        'microphone'
      )
    ).toBe(
      'Microphone is already in use or unavailable. Close other apps using it and try again.'
    )
    expect(
      remoteAudioErrorMessage(new DOMException('', 'NotAllowedError'), 'playback')
    ).toBe('Remote audio playback was blocked. Turn audio off and on to retry.')
    expect(remoteAudioErrorMessage(new Error('NotAllowedError'), 'microphone')).toBe(
      'NotAllowedError'
    )
    expect(
      remoteAudioErrorMessage(new RemoteAudioSenderInactiveError(), 'microphone')
    ).toBe('Audio ended because the remote session is no longer connected.')
    expect(
      remoteAudioErrorMessage(new RemoteAudioSenderInactiveError(), 'playback')
    ).toBe('Audio ended because the remote session is no longer connected.')
  })
})
