import {
  createE2ENativeRemoteAudioStream,
  createNativeMicrophoneAudioStream,
} from '@/services/remoteNativeAudioMedia'

export interface RemoteAudioInputDevice {
  deviceId: string
  label: string
}

export type RemoteAudioCaptureSource =
  | 'webview-microphone'
  | 'e2e-browser-mock'
  | 'e2e-native-mock'
  | 'native-mic'

const remoteAudioCaptureSources = new WeakMap<
  MediaStream,
  RemoteAudioCaptureSource
>()

export const markRemoteAudioCaptureSource = (
  stream: MediaStream,
  source: RemoteAudioCaptureSource
) => {
  remoteAudioCaptureSources.set(stream, source)
  return stream
}

export const getRemoteAudioCaptureSource = (stream: MediaStream | null) =>
  stream ? (remoteAudioCaptureSources.get(stream) ?? null) : null

export const getRemoteMicrophoneConstraints = (
  deviceId?: string | null
): MediaStreamConstraints => ({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  },
  video: false,
})

export const remoteAudioProcessingDiagnostics = () => ({
  browserEchoCancellationRequested: true,
  browserNoiseSuppressionRequested: true,
  browserAutoGainControlRequested: true,
  customVadEnabled: false,
})

type RemoteAudioErrorContext = 'microphone' | 'playback'

export const REMOTE_AUDIO_PLAYBACK_BLOCKED_MESSAGE =
  'Remote audio playback was blocked. Turn audio off and on to retry.'

export const REMOTE_AUDIO_SENDER_INACTIVE =
  'REMOTE_AUDIO_SENDER_INACTIVE' as const

export class RemoteAudioSenderInactiveError extends Error {
  readonly code = REMOTE_AUDIO_SENDER_INACTIVE

  constructor() {
    super('Remote-session audio sender is not active')
    this.name = 'RemoteAudioSenderInactiveError'
  }
}

export const remoteAudioErrorMessage = (
  error: unknown,
  context: RemoteAudioErrorContext
): string => {
  if (
    error instanceof RemoteAudioSenderInactiveError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === REMOTE_AUDIO_SENDER_INACTIVE)
  ) {
    return 'Audio ended because the remote session is no longer connected.'
  }

  const name = error instanceof DOMException ? error.name : null
  if (context === 'playback') {
    if (name === 'NotAllowedError') {
      return REMOTE_AUDIO_PLAYBACK_BLOCKED_MESSAGE
    }
    return error instanceof Error ? error.message : String(error)
  }

  if (name === 'NotAllowedError') {
    return 'Microphone permission was denied. Allow microphone access and try again.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found. Connect a microphone and try again.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Microphone is already in use or unavailable. Close other apps using it and try again.'
  }
  return error instanceof Error ? error.message : String(error)
}

export const isE2ERemoteAudioMockEnabled = (
  mode = import.meta.env.MODE,
  enabled = window.__E2E_REMOTE_AUDIO_MOCK__ === true
) => mode === 'e2e' && enabled

export const isE2ENativeRemoteAudioMockEnabled = (
  mode = import.meta.env.MODE,
  enabled = window.__E2E_NATIVE_REMOTE_AUDIO_MOCK__ === true
) => mode === 'e2e' && enabled

export const isNativeRemoteMicrophonePreferred = (
  mode = import.meta.env.MODE
) => mode !== 'test' && mode !== 'e2e'

const createE2ERemoteAudioStream = (): MediaStream => {
  const AudioContextCtor = globalThis.AudioContext
  if (!AudioContextCtor) {
    throw new Error('E2E remote-session audio mock is unavailable')
  }

  const audioContext = new AudioContextCtor()
  const destination = audioContext.createMediaStreamDestination()
  const source = audioContext.createOscillator()
  source.frequency.value =
    typeof window.__E2E_REMOTE_AUDIO_MOCK_FREQUENCY__ === 'number' &&
    Number.isFinite(window.__E2E_REMOTE_AUDIO_MOCK_FREQUENCY__) &&
    window.__E2E_REMOTE_AUDIO_MOCK_FREQUENCY__ > 0
      ? window.__E2E_REMOTE_AUDIO_MOCK_FREQUENCY__
      : 440
  source.connect(destination)
  source.start()

  for (const track of destination.stream.getAudioTracks()) {
    const stopTrack = track.stop.bind(track)
    track.stop = () => {
      stopTrack()
      try {
        source.stop()
      } catch {
        // The source may already be stopped if the mock stream is cleaned twice.
      }
      source.disconnect()
      void audioContext.close()
    }
  }

  return markRemoteAudioCaptureSource(destination.stream, 'e2e-browser-mock')
}

export const getRemoteMicrophoneStream = async (
  mode = import.meta.env.MODE,
  deviceId?: string | null
): Promise<MediaStream> => {
  if (isE2ENativeRemoteAudioMockEnabled(mode)) {
    const frequencyHz =
      typeof window.__E2E_REMOTE_AUDIO_MOCK_FREQUENCY__ === 'number' &&
      Number.isFinite(window.__E2E_REMOTE_AUDIO_MOCK_FREQUENCY__) &&
      window.__E2E_REMOTE_AUDIO_MOCK_FREQUENCY__ > 0
        ? window.__E2E_REMOTE_AUDIO_MOCK_FREQUENCY__
        : 440
    const factory = window.__E2E_NATIVE_REMOTE_AUDIO_STREAM_FACTORY__
    const stream = factory
      ? await factory(frequencyHz)
      : await createE2ENativeRemoteAudioStream(frequencyHz)
    return markRemoteAudioCaptureSource(stream, 'e2e-native-mock')
  }

  if (isE2ERemoteAudioMockEnabled(mode)) {
    return createE2ERemoteAudioStream()
  }

  if (!deviceId && isNativeRemoteMicrophonePreferred(mode)) {
    try {
      return markRemoteAudioCaptureSource(
        await createNativeMicrophoneAudioStream(),
        'native-mic'
      )
    } catch (error) {
      console.warn(
        '[remote] Native microphone capture unavailable; falling back to WebView microphone',
        error
      )
    }
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is not available in this WebView')
  }

  return markRemoteAudioCaptureSource(
    await navigator.mediaDevices.getUserMedia(
      getRemoteMicrophoneConstraints(deviceId)
    ),
    'webview-microphone'
  )
}

export const stopRemoteAudioStream = (stream: MediaStream | null) => {
  for (const track of stream?.getTracks() ?? []) {
    track.stop()
  }
}

export const detachRemoteAudioSenderTrack = async (
  sender: RTCRtpSender | null,
  role: 'host' | 'guest'
) => {
  try {
    await sender?.replaceTrack(null)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'InvalidStateError') {
      return
    }
    // The local mic track is still stopped by the caller; this warning records
    // that the browser sender may temporarily retain a stopped track reference.
    console.warn(`[remote] Failed to detach ${role} audio sender`, error)
  }
}

export const listRemoteAudioInputDevices = async (): Promise<
  RemoteAudioInputDevice[]
> => {
  const devices = await navigator.mediaDevices?.enumerateDevices?.()
  if (!devices) return []
  let unnamedIndex = 1
  return devices
    .filter(device => device.kind === 'audioinput' && device.deviceId)
    .map(device => ({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${unnamedIndex++}`,
    }))
}
