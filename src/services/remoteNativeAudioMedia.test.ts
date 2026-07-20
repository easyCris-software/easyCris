import { afterEach, describe, expect, it, vi } from 'vitest'

const tauriCoreMock = vi.hoisted(() => {
  class MockChannel<T = unknown> {
    static instances: Array<{
      onmessage: ((message: unknown) => void) | null
    }> = []
    onmessage: ((message: T) => void) | null = null

    constructor() {
      MockChannel.instances.push(
        this as {
          onmessage: ((message: unknown) => void) | null
        }
      )
    }
  }

  return {
    Channel: MockChannel,
    invoke: vi.fn(),
  }
})

vi.mock('@tauri-apps/api/core', () => tauriCoreMock)

import {
  createE2ENativeRemoteAudioStream,
  createNativeMicrophoneAudioStream,
} from '@/services/remoteNativeAudioMedia'

const nativeAudioPacket = (
  samples: number[],
  sampleRate = 48_000,
  channelCount = 2
) => {
  const frameCount = samples.length / channelCount
  const bytes = new Uint8Array(
    16 + samples.length * Float32Array.BYTES_PER_ELEMENT
  )
  const view = new DataView(bytes.buffer)
  view.setUint32(0, sampleRate, true)
  view.setUint32(4, channelCount, true)
  view.setUint32(8, frameCount, true)
  view.setUint32(12, 1, true)
  samples.forEach((sample, index) => {
    view.setFloat32(16 + index * Float32Array.BYTES_PER_ELEMENT, sample, true)
  })
  return bytes
}

const waitForTask = () => new Promise(resolve => window.setTimeout(resolve, 0))

const successfulStartResult = () => ({
  capture_id: 'audio-capture-1',
  channel_count: 2,
  sample_rate: 48_000,
  source_kind: 'e2e-native-tone',
})

describe('remoteNativeAudioMedia', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    tauriCoreMock.Channel.instances = []
  })

  it('bridges native PCM packets into an audio MediaStreamTrackGenerator', async () => {
    const trackStop = vi.fn()
    const eventListeners = new Map<string, EventListener>()
    const generatedTrack = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        eventListeners.set(type, listener)
      }),
      kind: 'audio',
      stop: trackStop,
    } as unknown as MediaStreamTrack
    const write = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const writer = { close, write }
    const audioDataClose = vi.fn()
    const audioDataConstructors: unknown[] = []

    class MockAudioData {
      close = audioDataClose

      constructor(init: unknown) {
        audioDataConstructors.push(init)
      }
    }

    class MockMediaStream {
      constructor(readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getAudioTracks() {
        return this.tracks
      }
    }

    class MockMediaStreamTrackGenerator {
      track = generatedTrack
      writable = { getWriter: () => writer }

      constructor(readonly init: { kind: string }) {}
    }

    vi.stubGlobal('AudioData', MockAudioData)
    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockMediaStreamTrackGenerator)
    tauriCoreMock.invoke.mockImplementation(command => {
      if (command === 'start_e2e_native_audio_capture') {
        return Promise.resolve(successfulStartResult())
      }
      if (command === 'stop_e2e_native_audio_capture') {
        return Promise.resolve()
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    const stream = await createE2ENativeRemoteAudioStream(660)
    tauriCoreMock.Channel.instances[0]?.onmessage?.(
      nativeAudioPacket([0.1, 0.2, 0.3, 0.4])
    )
    tauriCoreMock.Channel.instances[0]?.onmessage?.(
      nativeAudioPacket([0.5, 0.6, 0.7, 0.8])
    )
    await waitForTask()
    await waitForTask()

    expect(stream.getAudioTracks()).toEqual([generatedTrack])
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'start_e2e_native_audio_capture',
      expect.objectContaining({ frequencyHz: 660 })
    )
    expect(audioDataConstructors).toEqual([
      expect.objectContaining({
        format: 'f32',
        numberOfChannels: 2,
        numberOfFrames: 2,
        sampleRate: 48_000,
        timestamp: 0,
      }),
      expect.objectContaining({
        format: 'f32',
        numberOfChannels: 2,
        numberOfFrames: 2,
        sampleRate: 48_000,
        timestamp: 42,
      }),
    ])
    expect(write).toHaveBeenCalledTimes(2)
    expect(audioDataClose).toHaveBeenCalledTimes(2)
    expect(generatedTrack.addEventListener).toHaveBeenCalledWith(
      'ended',
      expect.any(Function),
      { once: true }
    )

    eventListeners.get('ended')?.(new Event('ended'))
    await waitForTask()

    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'stop_e2e_native_audio_capture',
      { captureId: 'audio-capture-1' }
    )
    expect(close).toHaveBeenCalledOnce()
    expect(trackStop).not.toHaveBeenCalled()
  })

  it('uses the production native microphone capture commands', async () => {
    const generatedTrack = {
      addEventListener: vi.fn(),
      kind: 'audio',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
    }

    class MockAudioData {
      close = vi.fn()
      constructor(_init: unknown) {}
    }

    class MockMediaStream {
      constructor(readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getAudioTracks() {
        return this.tracks
      }
    }

    class MockMediaStreamTrackGenerator {
      track = generatedTrack
      writable = { getWriter: () => writer }
    }

    vi.stubGlobal('AudioData', MockAudioData)
    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockMediaStreamTrackGenerator)
    tauriCoreMock.invoke.mockImplementation(command => {
      if (command === 'start_native_mic_capture') {
        return Promise.resolve({
          capture_id: 'native-mic-1',
          channel_count: 1,
          sample_rate: 48_000,
          source_kind: 'wasapi-mic-only',
        })
      }
      if (command === 'stop_native_mic_capture') {
        return Promise.resolve()
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    const stream = await createNativeMicrophoneAudioStream()
    const [track] = stream.getAudioTracks()
    track?.stop()
    await waitForTask()

    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'start_native_mic_capture',
      expect.objectContaining({ onAudio: expect.any(Object) })
    )
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'stop_native_mic_capture',
      { captureId: 'native-mic-1' }
    )
  })

  it('closes the generator writer when native microphone startup fails', async () => {
    const generatedTrack = {
      addEventListener: vi.fn(),
      kind: 'audio',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
    }

    class MockAudioData {
      close = vi.fn()
      constructor(_init: unknown) {}
    }

    class MockMediaStream {
      constructor(readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getAudioTracks() {
        return this.tracks
      }
    }

    class MockMediaStreamTrackGenerator {
      track = generatedTrack
      writable = { getWriter: () => writer }
    }

    vi.stubGlobal('AudioData', MockAudioData)
    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockMediaStreamTrackGenerator)
    tauriCoreMock.invoke.mockRejectedValue(new Error('native unavailable'))

    await expect(createNativeMicrophoneAudioStream()).rejects.toThrow(
      'native unavailable'
    )
    await waitForTask()

    expect(writer.close).toHaveBeenCalledOnce()
  })

  it('stops native capture when generator writes fail', async () => {
    const generatedTrack = {
      addEventListener: vi.fn(),
      kind: 'audio',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockRejectedValue(new Error('writer closed')),
    }

    class MockAudioData {
      close = vi.fn()
      constructor(_init: unknown) {}
    }

    class MockMediaStream {
      constructor(readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getAudioTracks() {
        return this.tracks
      }
    }

    class MockMediaStreamTrackGenerator {
      track = generatedTrack
      writable = { getWriter: () => writer }
    }

    vi.stubGlobal('AudioData', MockAudioData)
    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockMediaStreamTrackGenerator)
    tauriCoreMock.invoke.mockImplementation(command => {
      if (command === 'start_e2e_native_audio_capture') {
        return Promise.resolve(successfulStartResult())
      }
      if (command === 'stop_e2e_native_audio_capture') {
        return Promise.resolve()
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    await createE2ENativeRemoteAudioStream()
    tauriCoreMock.Channel.instances[0]?.onmessage?.(
      nativeAudioPacket([0.1, 0.2])
    )
    await waitForTask()

    expect(writer.write).toHaveBeenCalledOnce()
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'stop_e2e_native_audio_capture',
      { captureId: 'audio-capture-1' }
    )
    expect(writer.close).toHaveBeenCalledOnce()
  })

  it('stops production native microphone capture when generator writes fail', async () => {
    const generatedTrack = {
      addEventListener: vi.fn(),
      kind: 'audio',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockRejectedValue(new Error('writer closed')),
    }

    class MockAudioData {
      close = vi.fn()
      constructor(_init: unknown) {}
    }

    class MockMediaStream {
      constructor(readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getAudioTracks() {
        return this.tracks
      }
    }

    class MockMediaStreamTrackGenerator {
      track = generatedTrack
      writable = { getWriter: () => writer }
    }

    vi.stubGlobal('AudioData', MockAudioData)
    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockMediaStreamTrackGenerator)
    tauriCoreMock.invoke.mockImplementation(command => {
      if (command === 'start_native_mic_capture') {
        return Promise.resolve({
          capture_id: 'native-mic-1',
          channel_count: 1,
          sample_rate: 48_000,
          source_kind: 'wasapi-mic-only',
        })
      }
      if (command === 'stop_native_mic_capture') {
        return Promise.resolve()
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    await createNativeMicrophoneAudioStream()
    tauriCoreMock.Channel.instances[0]?.onmessage?.(nativeAudioPacket([0.1], 48_000, 1))
    await waitForTask()

    expect(writer.write).toHaveBeenCalledOnce()
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'stop_native_mic_capture',
      { captureId: 'native-mic-1' }
    )
    expect(writer.close).toHaveBeenCalledOnce()
  })

  it('stops a native capture that starts after the generated track already ended', async () => {
    let resolveStart:
      | ((result: ReturnType<typeof successfulStartResult>) => void)
      | null = null
    let endedListener: EventListener | null = null
    const generatedTrack = {
      addEventListener: vi.fn((_type: string, listener: EventListener) => {
        endedListener = listener
      }),
      kind: 'audio',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack

    class MockAudioData {
      close = vi.fn()
      constructor(_init: unknown) {}
    }

    class MockMediaStream {
      constructor(readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getAudioTracks() {
        return this.tracks
      }
    }

    class MockMediaStreamTrackGenerator {
      track = generatedTrack
      writable = {
        getWriter: () => ({
          close: vi.fn().mockResolvedValue(undefined),
          write: vi.fn().mockResolvedValue(undefined),
        }),
      }
    }

    vi.stubGlobal('AudioData', MockAudioData)
    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockMediaStreamTrackGenerator)
    tauriCoreMock.invoke.mockImplementation(command => {
      if (command === 'start_e2e_native_audio_capture') {
        return new Promise(resolve => {
          resolveStart = resolve
        })
      }
      if (command === 'stop_e2e_native_audio_capture') {
        return Promise.resolve()
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    const streamPromise = createE2ENativeRemoteAudioStream()
    const currentEndedListener = endedListener as EventListener | null
    const currentResolveStart = resolveStart as
      | ((result: ReturnType<typeof successfulStartResult>) => void)
      | null
    currentEndedListener?.(new Event('ended'))
    currentResolveStart?.(successfulStartResult())

    await streamPromise
    await waitForTask()

    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'stop_e2e_native_audio_capture',
      { captureId: 'audio-capture-1' }
    )
  })

  it('ignores malformed native audio packets', async () => {
    const generatedTrack = {
      addEventListener: vi.fn(),
      kind: 'audio',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
    }

    class MockAudioData {
      close = vi.fn()
      constructor(_init: unknown) {}
    }

    class MockMediaStream {
      constructor(readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks
      }
      getAudioTracks() {
        return this.tracks
      }
    }

    class MockMediaStreamTrackGenerator {
      track = generatedTrack
      writable = { getWriter: () => writer }
    }

    vi.stubGlobal('AudioData', MockAudioData)
    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaStreamTrackGenerator', MockMediaStreamTrackGenerator)
    tauriCoreMock.invoke.mockResolvedValue(successfulStartResult())

    await createE2ENativeRemoteAudioStream()
    tauriCoreMock.Channel.instances[0]?.onmessage?.(new Uint8Array([1, 2, 3]))
    await waitForTask()

    expect(writer.write).not.toHaveBeenCalled()
  })

  it('falls back to the AudioContext bridge when audio generators are unavailable', async () => {
    const stopTrack = vi.fn()
    const track = {
      kind: 'audio',
      stop: stopTrack,
    } as unknown as MediaStreamTrack
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream
    const processor = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    }
    const gain = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      gain: { value: 1 },
    }
    const close = vi.fn().mockResolvedValue(undefined)

    class MockAudioContext {
      destination = {}
      close = close
      createMediaStreamDestination = vi.fn(() => ({ stream }))
      createScriptProcessor = vi.fn(() => processor)
      createGain = vi.fn(() => gain)
    }

    vi.stubGlobal('AudioData', undefined)
    vi.stubGlobal('AudioContext', MockAudioContext)
    vi.stubGlobal('MediaStreamTrackGenerator', undefined)
    tauriCoreMock.invoke.mockImplementation(command => {
      if (command === 'start_e2e_native_audio_capture') {
        return Promise.resolve(successfulStartResult())
      }
      if (command === 'stop_e2e_native_audio_capture') {
        return Promise.resolve()
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    const result = await createE2ENativeRemoteAudioStream()
    expect(result).toBe(stream)

    track.stop()
    await waitForTask()

    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'stop_e2e_native_audio_capture',
      { captureId: 'audio-capture-1' }
    )
    expect(processor.disconnect).toHaveBeenCalledOnce()
    expect(gain.disconnect).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(stopTrack).toHaveBeenCalledOnce()
  })
})
