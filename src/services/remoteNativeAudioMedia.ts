import { Channel, invoke } from '@tauri-apps/api/core'

type NativeAudioPayload = ArrayBuffer | Uint8Array

interface NativeAudioCaptureStartResult {
  capture_id: string
  capture_sample_rate?: number
  channel_count: number
  output_frames_per_chunk?: number
  rubato_resampler_active?: boolean
  sample_rate: number
  source_kind: string
}

interface NativeAudioChunk {
  offsetFrames: number
  samples: Float32Array
}

interface NativeAudioTrackGenerator {
  track?: MediaStreamTrack
  writable: WritableStream<AudioData>
}

type NativeAudioTrackGeneratorConstructor = new (init: {
  kind: 'audio'
}) => NativeAudioTrackGenerator

const NATIVE_AUDIO_HEADER_BYTES = 16
const NATIVE_AUDIO_FORMAT_F32 = 1
const DEFAULT_E2E_NATIVE_AUDIO_FREQUENCY_HZ = 440

interface NativeAudioCommandOptions {
  startCommand: string
  stopCommand: string
  startArgs?: Record<string, unknown>
}

const payloadBytes = (payload: NativeAudioPayload) =>
  payload instanceof Uint8Array ? payload : new Uint8Array(payload)

const parseNativeAudioPayload = (payload: NativeAudioPayload) => {
  const bytes = payloadBytes(payload)
  if (bytes.byteLength < NATIVE_AUDIO_HEADER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sampleRate = view.getUint32(0, true)
  const channelCount = view.getUint32(4, true)
  const frameCount = view.getUint32(8, true)
  const format = view.getUint32(12, true)
  if (
    sampleRate <= 0 ||
    channelCount <= 0 ||
    frameCount <= 0 ||
    format !== NATIVE_AUDIO_FORMAT_F32
  ) {
    return null
  }
  const expectedBytes =
    NATIVE_AUDIO_HEADER_BYTES +
    frameCount * channelCount * Float32Array.BYTES_PER_ELEMENT
  if (bytes.byteLength !== expectedBytes) return null

  const samples = new Float32Array(frameCount * channelCount)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getFloat32(
      NATIVE_AUDIO_HEADER_BYTES + index * Float32Array.BYTES_PER_ELEMENT,
      true
    )
  }
  return { channelCount, frameCount, sampleRate, samples }
}

const nativeAudioTrackGeneratorConstructor = () =>
  (
    globalThis as typeof globalThis & {
      MediaStreamTrackGenerator?: NativeAudioTrackGeneratorConstructor
    }
  ).MediaStreamTrackGenerator

const nativeGeneratedAudioTrack = (
  generator: NativeAudioTrackGenerator
): MediaStreamTrack => {
  const track = generator.track ?? (generator as unknown as MediaStreamTrack)
  if (typeof track.stop !== 'function') {
    throw new Error('Native audio generator did not expose an audio track')
  }
  return track
}

const enqueueNativeAudioChunk = (
  queue: NativeAudioChunk[],
  payload: NativeAudioPayload
) => {
  const parsed = parseNativeAudioPayload(payload)
  if (!parsed) return null
  queue.push({ offsetFrames: 0, samples: parsed.samples })
  if (queue.length > 200) queue.splice(0, queue.length - 200)
  return parsed
}

export const createE2ENativeRemoteAudioStream = async (
  frequencyHz = DEFAULT_E2E_NATIVE_AUDIO_FREQUENCY_HZ
): Promise<MediaStream> => {
  const Generator = nativeAudioTrackGeneratorConstructor()
  if (Generator && globalThis.AudioData) {
    return createGeneratorNativeAudioStream(
      {
        startCommand: 'start_e2e_native_audio_capture',
        stopCommand: 'stop_e2e_native_audio_capture',
        startArgs: { frequencyHz },
      },
      Generator,
      globalThis.AudioData
    )
  }

  return createAudioContextNativeAudioStream(frequencyHz)
}

export const createNativeMicrophoneAudioStream =
  async (): Promise<MediaStream> => {
    const Generator = nativeAudioTrackGeneratorConstructor()
    if (!Generator || !globalThis.AudioData) {
      throw new Error('Native microphone capture requires WebCodecs audio support')
    }

    return createGeneratorNativeAudioStream(
      {
        startCommand: 'start_native_mic_capture',
        stopCommand: 'stop_native_mic_capture',
      },
      Generator,
      globalThis.AudioData
    )
  }

const createGeneratorNativeAudioStream = async (
  options: NativeAudioCommandOptions,
  Generator: NativeAudioTrackGeneratorConstructor,
  AudioDataCtor: typeof AudioData
): Promise<MediaStream> => {
  const generator = new Generator({ kind: 'audio' })
  const writer = generator.writable.getWriter()
  const track = nativeGeneratedAudioTrack(generator)
  const stream = new MediaStream([track])
  const onAudio = new Channel<NativeAudioPayload>()
  let captureId: string | null = null
  let stopped = false
  let writerClosed = false
  let timestampUs = 0
  let writeQueue = Promise.resolve()

  const closeWriter = () => {
    if (writerClosed) return
    writerClosed = true
    void writeQueue.finally(() => writer.close()).catch(() => undefined)
  }

  const stopNativeCapture = (activeCaptureId: string) => {
    void invoke(options.stopCommand, {
      captureId: activeCaptureId,
    }).catch(() => undefined)
  }

  const stopNativeAudio = () => {
    if (stopped) return
    stopped = true
    if (captureId) {
      stopNativeCapture(captureId)
    }
    closeWriter()
  }

  onAudio.onmessage = payload => {
    if (stopped) return
    const parsed = parseNativeAudioPayload(payload)
    if (!parsed) return
    const audioData = new AudioDataCtor({
      data: parsed.samples,
      format: 'f32',
      numberOfChannels: parsed.channelCount,
      numberOfFrames: parsed.frameCount,
      sampleRate: parsed.sampleRate,
      timestamp: timestampUs,
    })
    timestampUs += Math.round(
      (parsed.frameCount * 1_000_000) / parsed.sampleRate
    )
    writeQueue = writeQueue
      .then(async () => {
        try {
          await writer.write(audioData)
        } finally {
          audioData.close()
        }
      })
      .catch(() => {
        stopNativeAudio()
      })
  }

  track.addEventListener?.('ended', stopNativeAudio, { once: true })

  try {
    const result = await invoke<NativeAudioCaptureStartResult>(
      options.startCommand,
      {
        ...(options.startArgs ?? {}),
        onAudio,
      }
    )
    captureId = result.capture_id
    if (stopped) {
      stopNativeCapture(captureId)
      closeWriter()
    }
  } catch (error) {
    stopped = true
    closeWriter()
    throw error
  }

  const stopTrack = track.stop.bind(track)
  track.stop = () => {
    stopNativeAudio()
    stopTrack()
  }

  return stream
}

const createAudioContextNativeAudioStream = async (
  frequencyHz: number
): Promise<MediaStream> => {
  const AudioContextCtor = globalThis.AudioContext
  if (!AudioContextCtor) {
    throw new Error('Native remote audio playback is unavailable')
  }

  const audioContext = new AudioContextCtor({ sampleRate: 48_000 })
  const destination = audioContext.createMediaStreamDestination()
  const channelCount = 2
  const processor = audioContext.createScriptProcessor(1024, 0, channelCount)
  const silentGain = audioContext.createGain()
  const queue: NativeAudioChunk[] = []
  let captureId: string | null = null
  let stopped = false

  processor.onaudioprocess = event => {
    const frameLength = event.outputBuffer.length
    for (let channel = 0; channel < channelCount; channel += 1) {
      event.outputBuffer.getChannelData(channel).fill(0)
    }
    for (let frame = 0; frame < frameLength; frame += 1) {
      const chunk = queue[0]
      if (!chunk) continue
      for (let channel = 0; channel < channelCount; channel += 1) {
        const output = event.outputBuffer.getChannelData(channel)
        output[frame] =
          chunk.samples[chunk.offsetFrames * channelCount + channel] ?? 0
      }
      chunk.offsetFrames += 1
      if (chunk.offsetFrames * channelCount >= chunk.samples.length) {
        queue.shift()
      }
    }
  }

  processor.connect(destination)
  silentGain.gain.value = 0
  processor.connect(silentGain)
  silentGain.connect(audioContext.destination)

  const onAudio = new Channel<NativeAudioPayload>()
  onAudio.onmessage = payload => {
    enqueueNativeAudioChunk(queue, payload)
  }

  const result = await invoke<NativeAudioCaptureStartResult>(
    'start_e2e_native_audio_capture',
    {
      frequencyHz,
      onAudio,
    }
  )
  captureId = result.capture_id

  const stopNativeAudio = () => {
    if (stopped) return
    stopped = true
    if (captureId) {
      void invoke('stop_e2e_native_audio_capture', { captureId }).catch(
        () => undefined
      )
    }
    processor.disconnect()
    silentGain.disconnect()
    void audioContext.close().catch(() => undefined)
  }

  for (const track of destination.stream.getAudioTracks()) {
    const stopTrack = track.stop.bind(track)
    track.stop = () => {
      stopNativeAudio()
      stopTrack()
    }
  }

  return destination.stream
}
