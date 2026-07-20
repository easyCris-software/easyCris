import {
  REMOTE_INPUT_CHANNEL_LABEL,
  type RemoteSessionRevokedReason,
  type SignalingServerMessage,
} from '@/services/remoteSignalingProtocol'
import { Channel, invoke } from '@tauri-apps/api/core'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { logRuntimeDebug } from '@/lib/debug/runtimeDebug'
import {
  RemoteAudioSenderInactiveError,
  detachRemoteAudioSenderTrack,
  getRemoteAudioCaptureSource,
  getRemoteMicrophoneStream,
  remoteAudioProcessingDiagnostics,
  stopRemoteAudioStream,
} from '@/services/remoteAudioMedia'
import {
  createCloudSignalingTransport,
  createLanHostSignalingTransport,
  type RemoteSignalingDiagnostics,
  type RemoteSignalingTransport,
} from '@/services/remoteSignalingTransport'
import { getRemotePeerConnectionConfig } from '@/services/remoteIcePolicy'
import { deriveRemoteSecurityCode } from '@/services/remoteSecurityCode'
import {
  parseRemoteInputChannelMessage,
  type RemoteInputChannelMessage,
  type RemoteInputKeyEventPayload,
  type RemoteInputMouseEventPayload,
} from '@/services/remoteInputEvents'
import {
  noteRemoteSessionGuestPending,
  sendRemoteKeyInput,
  sendRemoteMouseInput,
  type RemoteInputMouseResult,
} from '@/services/remoteSessionService'

interface HostCallbacks {
  onJoinPending?: () => void
  onStatus?: (message: string) => void
  onWarning?: (message: string) => void
  onError?: (message: string) => void
  onRevoked?: () => void
  onIdleWarning?: (secondsRemaining: number) => void
  onIdleExpired?: () => void
  onIdleReset?: () => void
  onSecurityCode?: (code: string | null) => void
  onLocalAudioStreamChange?: (stream: MediaStream | null) => void
  onRemoteAudioStream?: (stream: MediaStream) => void
}

interface LanHostConnectOptions {
  mode?: 'lan'
  sessionId: string
  signalingPort: number
  token: string
  callbacks?: HostCallbacks
}

interface CloudHostConnectOptions {
  mode: 'cloud'
  sessionId: string
  inviteId: string
  relayUrl: string
  hostSecret: string
  iceConfigEndpointUrl?: string
  forceRelay?: boolean
  callbacks?: HostCallbacks
}

type HostConnectOptions = LanHostConnectOptions | CloudHostConnectOptions

interface DataChannelWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timeout: number
}

interface HostStopLocalAudioOptions {
  preserveAudioState?: boolean
}

export const REMOTE_VIDEO_LAN_BITRATE_BPS = 10_000_000
export const REMOTE_VIDEO_CLOUD_BITRATE_BPS = 6_000_000
export const REMOTE_VIDEO_RELAY_BITRATE_BPS = 4_000_000
const REMOTE_CAPTURE_MAX_WIDTH = 1920
const REMOTE_CAPTURE_MAX_HEIGHT = 1080
export const REMOTE_VIDEO_MAX_FRAMERATE = 15
const REMOTE_IDLE_TIMEOUT_MS = 10 * 60_000
const REMOTE_IDLE_WARNING_BEFORE_MS = 60_000
const REMOTE_ERROR_DEDUPE_WINDOW_MS = 2_000
const NON_FATAL_REMOTE_INPUT_ERRORS = new Set([
  'Remote input is outside the easyCris capture surface',
  'Remote input window changed; restart remote sharing to continue control',
  'Remote input surface moved or resized; restart remote sharing to continue control',
])
const NON_FATAL_REMOTE_INPUT_ERROR_PREFIXES = [
  'Timed out confirming easyCris foreground for remote input.',
]

export interface RemoteMediaDiagnostics {
  requestedMaxWidth: number
  requestedMaxHeight: number
  requestedMaxFramerate: number
  requestedMaxBitrate: number
  nativeFrameByteLength: number | null
  nativeFrameErrors: number
  nativeFrameHeight: number | null
  nativeFramePixelFormat: 'BGRA' | 'NV12' | null
  nativeFramesDropped: number
  nativeFramesReceived: number
  nativeFramesWritten: number
  nativeFrameWidth: number | null
  nativeLastFrameError: string | null
  nativeValidatedFrameHeight: number | null
  nativeValidatedFrameWidth: number | null
  nativeValidatedSurfaceKind: 'easycris-window' | null
  nativeValidationError: string | null
  codecPreferenceEvaluated: boolean
  codecPreferenceAttempted: boolean
  codecPreferenceFirstMimeType: string | null
  appliedMaxBitrate: number | null
  appliedMaxFramerate: number | null
  appliedScaleResolutionDownBy: number | null
  appliedCandidateType: string | null
  captureTrackStopped: boolean
  peerConnectionClosedAfterDataChannelClose: boolean
}

export interface RemotePeerConnectionDiagnostics {
  dataChannelState: RTCDataChannelState | null
  iceConnectionState: RTCIceConnectionState | null
  peerConnectionState: RTCPeerConnectionState | null
}

interface RemoteSenderMediaPolicy {
  maxBitrate: number
  maxFramerate: number
  scaleResolutionDownBy: number | null
  candidateType: string | null
}

interface RemoteSenderMediaPolicyOptions {
  forceRelay?: boolean
  mode?: 'cloud' | 'lan'
  selectedCandidateType?: string | null
}

type RemoteIceCandidateStats = RTCStats & {
  candidateType?: string
}

interface RemoteCodecPreferenceResult {
  evaluated: boolean
  attempted: boolean
  firstMimeType: string | null
}

interface NativeCaptureStartResult {
  capture_id: string
  frame_height: number
  frame_width: number
  surface_kind: 'easycris-window'
}

type NativeFramePayload = ArrayBuffer | Uint8Array
type NativeFramePixelFormat = 'BGRA' | 'NV12'

interface NativeFrameDiagnosticsEvent {
  byteLength: number
  height: number
  message?: string
  pixelFormat: NativeFramePixelFormat | null
  width: number
}

type NativeWritableFrameDiagnosticsEvent = NativeFrameDiagnosticsEvent & {
  pixelFormat: NativeFramePixelFormat
}

interface NativeCaptureViewportContract {
  displayHeight: number
  displayWidth: number
  matches: boolean
  windowHeight: number
  windowWidth: number
}

interface RemoteCaptureStreamOptions {
  onNativeCaptureStarted?: (result: NativeCaptureStartResult) => void
  onNativeFrameDropped?: (event: NativeFrameDiagnosticsEvent) => void
  onNativeFrameError?: (event: NativeFrameDiagnosticsEvent) => void
  onNativeFrameReceived?: (event: NativeFrameDiagnosticsEvent) => void
  onNativeFrameWritten?: (event: NativeFrameDiagnosticsEvent) => void
}

interface NativeVideoFrameGenerator {
  track?: MediaStreamTrack
  writable: WritableStream<VideoFrame>
}

type NativeVideoFrameGeneratorConstructor = new (init: {
  kind: 'video'
}) => NativeVideoFrameGenerator

const nativeVideoFrameGeneratorConstructor = () =>
  (
    globalThis as typeof globalThis & {
      MediaStreamTrackGenerator?: NativeVideoFrameGeneratorConstructor
      VideoTrackGenerator?: NativeVideoFrameGeneratorConstructor
    }
  ).VideoTrackGenerator ??
  // Some WebView2 runtimes expose the generator as the MediaStreamTrack itself.
  // Keep this alias so native scap capture can feed those runtimes too.
  (
    globalThis as typeof globalThis & {
      MediaStreamTrackGenerator?: NativeVideoFrameGeneratorConstructor
    }
  ).MediaStreamTrackGenerator

export const isNativeRemoteCaptureSupported = () =>
  Boolean(nativeVideoFrameGeneratorConstructor() && globalThis.VideoFrame)

const nativeGeneratedVideoTrack = (
  generator: NativeVideoFrameGenerator
): MediaStreamTrack => {
  const track = generator.track ?? (generator as unknown as MediaStreamTrack)
  if (typeof track.stop !== 'function') {
    throw new Error(
      'Native capture frame generator did not expose a video track'
    )
  }
  return track
}

export const createRemoteMediaDiagnostics = (): RemoteMediaDiagnostics => ({
  requestedMaxWidth: REMOTE_CAPTURE_MAX_WIDTH,
  requestedMaxHeight: REMOTE_CAPTURE_MAX_HEIGHT,
  requestedMaxFramerate: REMOTE_VIDEO_MAX_FRAMERATE,
  requestedMaxBitrate: REMOTE_VIDEO_LAN_BITRATE_BPS,
  nativeFrameByteLength: null,
  nativeFrameErrors: 0,
  nativeFrameHeight: null,
  nativeFramePixelFormat: null,
  nativeFramesDropped: 0,
  nativeFramesReceived: 0,
  nativeFramesWritten: 0,
  nativeFrameWidth: null,
  nativeLastFrameError: null,
  nativeValidatedFrameHeight: null,
  nativeValidatedFrameWidth: null,
  nativeValidatedSurfaceKind: null,
  nativeValidationError: null,
  codecPreferenceEvaluated: false,
  codecPreferenceAttempted: false,
  codecPreferenceFirstMimeType: null,
  appliedMaxBitrate: null,
  appliedMaxFramerate: null,
  appliedScaleResolutionDownBy: null,
  appliedCandidateType: null,
  captureTrackStopped: false,
  peerConnectionClosedAfterDataChannelClose: false,
})

export const getRemoteCaptureConstraints = (): DisplayMediaStreamOptions => ({
  video: {
    displaySurface: 'window',
    frameRate: { ideal: 15, max: REMOTE_VIDEO_MAX_FRAMERATE },
    height: {
      ideal: REMOTE_CAPTURE_MAX_HEIGHT,
      max: REMOTE_CAPTURE_MAX_HEIGHT,
    },
    width: { ideal: REMOTE_CAPTURE_MAX_WIDTH, max: REMOTE_CAPTURE_MAX_WIDTH },
  } as MediaTrackConstraints,
  audio: false,
})

export const applyRemoteCaptureResolutionLimit = async (
  stream: MediaStream,
  onWarning?: (message: string) => void
) => {
  if (isNativeRemoteCaptureStream(stream)) return

  await Promise.all(
    stream.getTracks().map(async track => {
      if (track.kind !== 'video') return
      try {
        await track.applyConstraints({
          height: {
            ideal: REMOTE_CAPTURE_MAX_HEIGHT,
            max: REMOTE_CAPTURE_MAX_HEIGHT,
          },
          width: {
            ideal: REMOTE_CAPTURE_MAX_WIDTH,
            max: REMOTE_CAPTURE_MAX_WIDTH,
          },
        })
      } catch {
        onWarning?.(
          'Remote-session capture resolution cap could not be applied; continuing with native capture defaults.'
        )
      }
    })
  )
}

export const applyRemoteVideoTrackHint = (track: MediaStreamTrack) => {
  if (track.kind === 'video') {
    track.contentHint = 'detail'
  }
}

const remoteVideoScaleResolutionDownBy = (track: MediaStreamTrack) => {
  if (track.kind !== 'video') return undefined
  const settings = track.getSettings()
  const widthScale =
    typeof settings.width === 'number'
      ? settings.width / REMOTE_CAPTURE_MAX_WIDTH
      : 1
  const heightScale =
    typeof settings.height === 'number'
      ? settings.height / REMOTE_CAPTURE_MAX_HEIGHT
      : 1
  const scale = Math.max(widthScale, heightScale, 1)
  return scale > 1 ? scale : 1
}

export const applyRemoteSenderBitratePolicy = async (
  senders: RTCRtpSender[],
  onWarning?: (message: string) => void,
  options: RemoteSenderMediaPolicyOptions = {}
): Promise<RemoteSenderMediaPolicy | null> => {
  let appliedPolicy: RemoteSenderMediaPolicy | null = null
  const maxBitrate = remoteVideoMaxBitrate(options)
  for (const sender of senders) {
    if (!sender.track || sender.track.kind !== 'video') continue
    const params = sender.getParameters()
    params.encodings = params.encodings?.length ? params.encodings : [{}]
    const encoding = params.encodings[0]
    if (!encoding) continue
    encoding.maxBitrate = maxBitrate
    encoding.maxFramerate = REMOTE_VIDEO_MAX_FRAMERATE
    const scaleResolutionDownBy = sender.track
      ? remoteVideoScaleResolutionDownBy(sender.track)
      : undefined
    if (scaleResolutionDownBy !== undefined && scaleResolutionDownBy > 1) {
      encoding.scaleResolutionDownBy = scaleResolutionDownBy
    }
    try {
      await sender.setParameters(params)
      appliedPolicy = {
        candidateType: options.forceRelay
          ? 'relay'
          : (options.selectedCandidateType ?? null),
        maxBitrate,
        maxFramerate: REMOTE_VIDEO_MAX_FRAMERATE,
        scaleResolutionDownBy: scaleResolutionDownBy ?? null,
      }
    } catch {
      onWarning?.(
        'Remote-session bitrate cap could not be applied; continuing with default WebRTC bitrate.'
      )
    }
  }
  return appliedPolicy
}

const remoteVideoMaxBitrate = (options: RemoteSenderMediaPolicyOptions) => {
  if (options.mode === 'cloud') {
    if (options.forceRelay || options.selectedCandidateType === 'relay') {
      return REMOTE_VIDEO_RELAY_BITRATE_BPS
    }
    return REMOTE_VIDEO_CLOUD_BITRATE_BPS
  }
  return REMOTE_VIDEO_LAN_BITRATE_BPS
}

export const selectedRemoteCandidateTypeFromStats = (
  stats: RTCStats[] | RTCStatsReport
) => {
  const entries = Array.isArray(stats) ? stats : [...stats.values()]
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const transport = entries.find(
    entry =>
      entry.type === 'transport' &&
      typeof (entry as RTCTransportStats).selectedCandidatePairId === 'string'
  ) as RTCTransportStats | undefined
  const selectedPairFromTransport =
    transport?.selectedCandidatePairId != null
      ? byId.get(transport.selectedCandidatePairId)
      : null
  const selectedPair =
    selectedPairFromTransport ??
    entries.find(entry => {
      const pair = entry as RTCStats & {
        nominated?: boolean
        selected?: boolean
      }
      return (
        pair.type === 'candidate-pair' &&
        (pair.selected === true || pair.nominated === true)
      )
    }) ??
    entries.find(entry => {
      const pair = entry as RTCStats & { state?: string }
      return (
        pair.type === 'candidate-pair' && pair.state === 'succeeded'
      )
    })
  if (!selectedPair || selectedPair.type !== 'candidate-pair') return null
  const pair = selectedPair as RTCIceCandidatePairStats
  const local = byId.get(pair.localCandidateId) as
    | RemoteIceCandidateStats
    | undefined
  const remote = byId.get(pair.remoteCandidateId) as
    | RemoteIceCandidateStats
    | undefined
  if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') {
    return 'relay'
  }
  return local?.candidateType ?? remote?.candidateType ?? null
}

export const applyRemoteCodecPreferences = (
  peerConnection: RTCPeerConnection,
  onWarning?: (message: string) => void
): RemoteCodecPreferenceResult => {
  const capabilities =
    globalThis.RTCRtpReceiver?.getCapabilities?.('video') ??
    globalThis.RTCRtpSender?.getCapabilities?.('video')
  const codecs = capabilities?.codecs ?? []
  const h264Codecs = codecs.filter(
    codec => codec.mimeType.toLowerCase() === 'video/h264'
  )
  if (h264Codecs.length === 0) {
    return { evaluated: true, attempted: false, firstMimeType: null }
  }

  const packetizedH264Codecs = sortPreferredH264Codecs(
    h264Codecs.filter(isPacketizedH264Codec)
  )
  const otherH264Codecs = h264Codecs.filter(
    codec => !isPacketizedH264Codec(codec)
  )
  const preferredCodecs = [...packetizedH264Codecs, ...otherH264Codecs]
  const remainingCodecs = codecs.filter(
    codec => codec.mimeType.toLowerCase() !== 'video/h264'
  )
  const codecPreferences = [...preferredCodecs, ...remainingCodecs]
  let attempted = false

  for (const transceiver of peerConnection.getTransceivers?.() ?? []) {
    if (transceiver.sender.track?.kind !== 'video') continue
    try {
      transceiver.setCodecPreferences(codecPreferences)
      attempted = true
    } catch {
      onWarning?.(
        'Remote-session H.264 codec preference could not be applied; continuing with default WebRTC codec negotiation.'
      )
    }
  }
  return {
    evaluated: true,
    attempted,
    firstMimeType: codecPreferences[0]?.mimeType ?? null,
  }
}

const h264FmtpParameter = (codec: RTCRtpCodec, parameter: string) => {
  const prefix = `${parameter.toLowerCase()}=`
  return codec.sdpFmtpLine
    ?.split(';')
    .map(part => part.trim().toLowerCase())
    .find(part => part.startsWith(prefix))
    ?.slice(prefix.length)
}

const H264_PROFILE_HIGH = '64'
const H264_PROFILE_MAIN = '4d'
const H264_PROFILE_BASELINE = '42'
const H264_LEVEL_4_0 = 0x28

const isPacketizedH264Codec = (codec: RTCRtpCodec) =>
  Number.parseInt(h264FmtpParameter(codec, 'packetization-mode') ?? '', 10) ===
  1

const h264ProfileLevel = (codec: RTCRtpCodec) => {
  const value = h264FmtpParameter(codec, 'profile-level-id')
  if (!value || !/^[0-9a-f]{6}$/.test(value)) return null
  return {
    constraintFlags: value.slice(2, 4),
    level: Number.parseInt(value.slice(4, 6), 16),
    profile: value.slice(0, 2),
  }
}

type H264ProfileLevel = NonNullable<ReturnType<typeof h264ProfileLevel>>

const h264ProfileScore = (profileLevel: H264ProfileLevel | null) => {
  if (profileLevel?.profile === H264_PROFILE_HIGH) return 4
  if (profileLevel?.profile === H264_PROFILE_MAIN) return 3
  if (profileLevel?.profile === H264_PROFILE_BASELINE) {
    const baselineWithoutConstraints = '00'
    return profileLevel.constraintFlags === baselineWithoutConstraints ? 2 : 1
  }
  return 0
}

const isH264LevelCapableForTarget = (level: number) =>
  REMOTE_CAPTURE_MAX_HEIGHT <= 720 || level >= H264_LEVEL_4_0

const h264CodecSortKey = (codec: RTCRtpCodec) => {
  const profileLevel = h264ProfileLevel(codec)
  const level = profileLevel?.level ?? 0
  return {
    level,
    levelCapable: isH264LevelCapableForTarget(level) ? 1 : 0,
    profile: h264ProfileScore(profileLevel),
  }
}

const sortPreferredH264Codecs = (codecs: RTCRtpCodec[]) =>
  codecs
    .map((codec, index) => ({ codec, index, key: h264CodecSortKey(codec) }))
    .sort((left, right) => {
      const levelCapableDelta =
        right.key.levelCapable - left.key.levelCapable
      if (levelCapableDelta !== 0) return levelCapableDelta

      const profileDelta = right.key.profile - left.key.profile
      if (profileDelta !== 0) return profileDelta

      const levelDelta = right.key.level - left.key.level
      if (levelDelta !== 0) return levelDelta

      return left.index - right.index
    })
    .map(entry => entry.codec)

export const isE2ERemoteCaptureMockEnabled = (
  mode = import.meta.env.MODE,
  legacyE2E = import.meta.env.VITE_E2E_ENABLED,
  enabled = window.__E2E_REMOTE_CAPTURE_MOCK__ === true
) => (mode === 'e2e' || legacyE2E === 'true') && enabled

export const createE2ERemoteCaptureStream = () => {
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('E2E remote-session capture mock could not create canvas')
  }

  if (!canvas.captureStream) {
    throw new Error('E2E remote-session capture mock is unavailable')
  }

  const drawFrame = (frame: number) => {
    context.fillStyle = '#f8fafc'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#0f172a'
    context.font = '48px sans-serif'
    context.fillText('easyCris remote-session E2E stream', 96, 140)
    context.fillStyle = '#0ea5e9'
    context.fillRect(96, 210, 640, 64)
    context.fillStyle = '#ffffff'
    context.font = '32px sans-serif'
    context.fillText('Mock capture active', 120, 252)
    context.fillStyle = frame % 2 === 0 ? '#22c55e' : '#f97316'
    context.fillRect(760, 210, 96, 64)
  }

  const stream = canvas.captureStream(10)
  const [track] = stream.getVideoTracks()
  let frame = 0
  const pushFrame = () => {
    drawFrame(frame)
    frame += 1
    ;(track as CanvasCaptureMediaStreamTrack | undefined)?.requestFrame?.()
  }
  pushFrame()

  const interval = window.setInterval(pushFrame, 250)
  if (track) {
    const stop = track.stop.bind(track)
    track.stop = () => {
      window.clearInterval(interval)
      stop()
    }
  }

  return stream
}

const nativeCapturePayloadBytes = (payload: NativeFramePayload) =>
  payload instanceof Uint8Array ? payload : new Uint8Array(payload)

const nativeFramePixelFormat = (value: number): NativeFramePixelFormat | null => {
  if (value === 0) return 'BGRA'
  if (value === 1) return 'NV12'
  return null
}

const nativeFramePayloadByteLength = (
  width: number,
  height: number,
  pixelFormat: 'BGRA' | 'NV12'
) => {
  const pixels = width * height
  return pixelFormat === 'NV12' ? (pixels * 3) / 2 : pixels * 4
}

const validateNativeCaptureStartResult = (
  result: NativeCaptureStartResult
) => {
  if (
    result.surface_kind !== 'easycris-window' ||
    !Number.isFinite(result.frame_width) ||
    !Number.isFinite(result.frame_height) ||
    result.frame_width < 320 ||
    result.frame_height < 200
  ) {
    throw new Error(
      'Could not verify the selected EasyCris window for remote sharing. Remote session was not started.'
    )
  }
}

const nativeRemoteCaptureStreamMarker = Symbol('easycris.nativeRemoteCaptureStream')

const markNativeRemoteCaptureStream = (stream: MediaStream) => {
  ;(stream as MediaStream & { [nativeRemoteCaptureStreamMarker]?: true })[
    nativeRemoteCaptureStreamMarker
  ] = true
  return stream
}

const isNativeRemoteCaptureStream = (stream: MediaStream) =>
  (stream as MediaStream & { [nativeRemoteCaptureStreamMarker]?: true })[
    nativeRemoteCaptureStreamMarker
  ] === true

const nextAnimationFrame = () =>
  new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

const nativeCaptureViewportMismatchMessage = (
  contract: NativeCaptureViewportContract
) =>
  `Native capture cannot start: the EasyCris window's display surface (${contract.displayWidth}x${contract.displayHeight} px) does not match its window area (${contract.windowWidth}x${contract.windowHeight} px). Restore or maximize the EasyCris window and try again.`

const readNativeCaptureViewportContract = async (
  appWindow: ReturnType<typeof getCurrentWindow>
): Promise<NativeCaptureViewportContract> => {
  const devicePixelRatio = window.devicePixelRatio
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new Error(
      'Native capture cannot start because the display scale is unavailable. Restore or maximize the EasyCris window and try again.'
    )
  }
  const size = await appWindow.innerSize()
  const displayWidth = Math.round(window.innerWidth * devicePixelRatio)
  const displayHeight = Math.round(window.innerHeight * devicePixelRatio)
  const windowWidth = Math.round(size.width)
  const windowHeight = Math.round(size.height)
  return {
    displayHeight,
    displayWidth,
    matches:
      Math.abs(displayWidth - windowWidth) <= 1 &&
      Math.abs(displayHeight - windowHeight) <= 1,
    windowHeight,
    windowWidth,
  }
}

const waitForNativeViewportResize = async (
  appWindow: ReturnType<typeof getCurrentWindow>,
  timeoutMs = 500
) => {
  let unlistenTauriResize: (() => void) | null = null
  await new Promise<void>(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      window.removeEventListener('resize', finish)
      unlistenTauriResize?.()
      resolve()
    }
    const timeout = window.setTimeout(finish, timeoutMs)
    window.addEventListener('resize', finish, { once: true })
    void appWindow
      .onResized(() => finish())
      .then(unlisten => {
        if (settled) {
          unlisten()
        } else {
          unlistenTauriResize = unlisten
        }
      })
      .catch(() => undefined)
  })
  await nextAnimationFrame()
  await nextAnimationFrame()
}

const ensureNativeCaptureViewportContract = async () => {
  const appWindow = getCurrentWindow()
  const initial = await readNativeCaptureViewportContract(appWindow)
  if (initial.matches) return

  await Promise.all([
    waitForNativeViewportResize(appWindow),
    appWindow.setSize(
      new PhysicalSize(initial.windowWidth, initial.windowHeight)
    ),
  ])

  const repaired = await readNativeCaptureViewportContract(appWindow)
  if (!repaired.matches) {
    throw new Error(nativeCaptureViewportMismatchMessage(repaired))
  }
}

const createNativeRemoteCaptureStream = async (
  Generator: NativeVideoFrameGeneratorConstructor,
  options: RemoteCaptureStreamOptions = {}
) => {
  if (!globalThis.VideoFrame) {
    throw new Error('Native capture frame generation is unavailable')
  }

  await ensureNativeCaptureViewportContract()

  const generator = new Generator({ kind: 'video' })
  const writer = generator.writable.getWriter()
  const onFrame = new Channel<NativeFramePayload>()
  let writing = false
  let stopped = false
  let stopPending = false
  let captureId: string | null = null
  let lastFrame:
    | {
        bytes: Uint8Array
        event: NativeWritableFrameDiagnosticsEvent
      }
    | null = null

  const writeNativeFrame = (
    frameBytes: Uint8Array,
    diagnosticsEvent: NativeWritableFrameDiagnosticsEvent,
    onDropped?: () => void,
    onWritten?: () => void
  ) => {
    if (
      stopped ||
      writing ||
      writer.desiredSize === null ||
      writer.desiredSize <= 0
    ) {
      onDropped?.()
      return
    }

    const expectedByteLength = nativeFramePayloadByteLength(
      diagnosticsEvent.width,
      diagnosticsEvent.height,
      diagnosticsEvent.pixelFormat
    )
    if (frameBytes.byteLength !== expectedByteLength) {
      options.onNativeFrameError?.({
        ...diagnosticsEvent,
        message: `Native frame byte length ${frameBytes.byteLength} does not match ${diagnosticsEvent.width}x${diagnosticsEvent.height} ${diagnosticsEvent.pixelFormat} payload length ${expectedByteLength}`,
      })
      return
    }

    let frame: VideoFrame
    const frameInit = {
      codedHeight: diagnosticsEvent.height,
      codedWidth: diagnosticsEvent.width,
      timestamp: Math.round(performance.now() * 1000),
    }
    const init =
      diagnosticsEvent.pixelFormat === 'NV12'
        ? {
            ...frameInit,
            format: 'NV12' as const,
            layout: [
              { offset: 0, stride: diagnosticsEvent.width },
              {
                offset: diagnosticsEvent.width * diagnosticsEvent.height,
                stride: diagnosticsEvent.width,
              },
            ],
          }
        : {
            ...frameInit,
            format: 'BGRA' as const,
          }
    try {
      frame = new VideoFrame(frameBytes, init)
    } catch (error) {
      options.onNativeFrameError?.({
        ...diagnosticsEvent,
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }

    writing = true
    void writer
      .write(frame)
      .then(() => {
        options.onNativeFrameWritten?.(diagnosticsEvent)
        onWritten?.()
      })
      .catch(error =>
        options.onNativeFrameError?.({
          ...diagnosticsEvent,
          message: error instanceof Error ? error.message : String(error),
        })
      )
      .finally(() => {
        frame.close()
        writing = false
      })
  }

  const repeatFrameInterval = window.setInterval(() => {
    if (!lastFrame) return
    writeNativeFrame(lastFrame.bytes, lastFrame.event)
  }, 250)

  onFrame.onmessage = payload => {
    const bytes = nativeCapturePayloadBytes(payload)
    if (bytes.byteLength <= 16) return
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = view.getUint32(0, true)
    const height = view.getUint32(4, true)
    const rawPixelFormat = view.getUint32(8, true)
    const pixelFormat = nativeFramePixelFormat(rawPixelFormat)
    if (width === 0 || height === 0) return

    const frameBytes = bytes.subarray(16)
    if (!pixelFormat) {
      options.onNativeFrameError?.({
        byteLength: frameBytes.byteLength,
        height,
        message: `Unsupported native frame pixel format ${rawPixelFormat}`,
        pixelFormat: null,
        width,
      })
      return
    }

    const diagnosticsEvent = {
      byteLength: frameBytes.byteLength,
      height,
      pixelFormat,
      width,
    }
    lastFrame = {
      bytes: new Uint8Array(frameBytes),
      event: diagnosticsEvent,
    }
    options.onNativeFrameReceived?.(diagnosticsEvent)
    writeNativeFrame(frameBytes, diagnosticsEvent, () =>
      options.onNativeFrameDropped?.(diagnosticsEvent)
    )
  }

  const stopNativeCapture = () => {
    // Both the patched track.stop() and the native ended event can enter here.
    // Keep this idempotent so WebRTC-internal teardown and explicit close share
    // one cleanup path.
    if (stopped) return
    stopped = true
    window.clearInterval(repeatFrameInterval)
    void writer.close().catch(() => undefined)
    if (captureId) {
      void invoke('stop_native_screen_capture', { captureId }).catch(
        () => undefined
      )
    } else {
      stopPending = true
    }
  }

  let result: NativeCaptureStartResult
  let generatedTrack: MediaStreamTrack
  let originalStop: (() => void) | null = null
  try {
    generatedTrack = nativeGeneratedVideoTrack(generator)
    originalStop = generatedTrack.stop.bind(generatedTrack)
    generatedTrack.addEventListener?.('ended', stopNativeCapture, {
      once: true,
    })
    generatedTrack.stop = () => {
      stopNativeCapture()
      originalStop?.()
    }
    result = await invoke<NativeCaptureStartResult>(
      'start_native_screen_capture',
      {
        maxFps: 15,
        maxHeight: REMOTE_CAPTURE_MAX_HEIGHT,
        maxWidth: REMOTE_CAPTURE_MAX_WIDTH,
        onFrame,
      }
    )
  } catch (error) {
    stopped = true
    window.clearInterval(repeatFrameInterval)
    void writer.close().catch(() => undefined)
    originalStop?.()
    throw error
  }
  captureId = result.capture_id
  try {
    validateNativeCaptureStartResult(result)
    options.onNativeCaptureStarted?.(result)
  } catch (error) {
    stopped = true
    window.clearInterval(repeatFrameInterval)
    void writer.close().catch(() => undefined)
    await invoke('stop_native_screen_capture', { captureId }).catch(
      () => undefined
    )
    originalStop?.()
    throw error
  }
  if (stopPending) {
    await invoke('stop_native_screen_capture', { captureId }).catch(
      () => undefined
    )
    originalStop()
    throw new Error('Native capture stopped before startup completed')
  }

  return markNativeRemoteCaptureStream(new MediaStream([generatedTrack]))
}

export const getRemoteCaptureStream = async (
  options: RemoteCaptureStreamOptions = {}
) => {
  if (isE2ERemoteCaptureMockEnabled()) {
    await invoke('set_e2e_remote_capture_rect')
    return createE2ERemoteCaptureStream()
  }

  const Generator = nativeVideoFrameGeneratorConstructor()
  if (Generator && globalThis.VideoFrame) {
    return await createNativeRemoteCaptureStream(Generator, options)
  }

  throw new Error(
    'Remote control is not available because this Windows/WebView2 runtime is too old. Update Windows or install the latest Microsoft Edge WebView2 Runtime, then try again.'
  )
}

class RemoteWebRtcHostSession {
  private transport: RemoteSignalingTransport | null = null
  private transportConnected = false
  private peerConnection: RTCPeerConnection | null = null
  private stream: MediaStream | null = null
  private dataChannel: RTCDataChannel | null = null
  private sessionId: string | null = null
  private mode: 'lan' | 'cloud' = 'lan'
  private inviteId: string | null = null
  private hostSecret: string | null = null
  private iceConfigEndpointUrl: string | undefined
  private forceRelay = false
  private callbacks: HostCallbacks = {}
  private callbackSubscriptions = new Set<HostCallbacks>()
  private pendingIceCandidates: RTCIceCandidateInit[] = []
  private inputQueue: Promise<void> = Promise.resolve()
  private mouseMoveQueue: Promise<void> = Promise.resolve()
  private pressedButtons = new Map<string, RemoteInputMouseEventPayload>()
  private pressedKeys = new Map<string, RemoteInputKeyEventPayload>()
  private pendingMouseButtonTransitions = 0
  private dataChannelWaiters: DataChannelWaiter[] = []
  private mediaSenders: RTCRtpSender[] = []
  private mediaPolicyQueue: Promise<void> = Promise.resolve()
  private audioSender: RTCRtpSender | null = null
  private audioTransceiver: RTCRtpTransceiver | null = null
  private audioInputDeviceId: string | null = null
  private localAudioStream: MediaStream | null = null
  private remoteAudioStream: MediaStream | null = null
  private audioMuted = true
  private audioMuteGeneration = 0
  private audioStopGeneration = 0
  private localAudioUnmuted = false
  private remoteAudioSending = false
  private lastRemoteAudioStateSeq: number | null = null
  private audioEnableTask: Promise<void> | null = null
  private securityCode: string | null = null
  private attemptedMouseInputCount = 0
  private acceptedInputCount = 0
  private rejectedMouseInputCount = 0
  private lastRejectedMouseInputError: string | null = null
  private lastAcceptedInputType: RemoteInputChannelMessage['type'] | null = null
  private lastAcceptedInputScreenPoint: RemoteInputMouseResult | null = null
  private recentAcceptedInputScreenPoints: RemoteInputMouseResult[] = []
  private lastMouseInputForwardElapsedMs: number | null = null
  private recentMouseInputForwardElapsedMs: number[] = []
  private lastErrorMessage: string | null = null
  private lastErrorReportedAt = 0
  private peerFailureReported = false
  private idleWarningTimer: number | null = null
  private idleExpiryTimer: number | null = null
  private idleWarningActive = false
  private mediaDiagnostics = createRemoteMediaDiagnostics()
  private dataChannelCloseHandled = false

  async connect(options: HostConnectOptions) {
    if (
      this.transport &&
      this.transportConnected &&
      this.sessionId === options.sessionId
    ) {
      this.callbacks = options.callbacks ?? {}
      this.replayCallbacks(this.callbacks)
      return
    }

    await this.closeLocalPeer()
    this.closeTransport()

    this.sessionId = options.sessionId
    this.mode = options.mode ?? 'lan'
    this.inviteId = options.mode === 'cloud' ? options.inviteId : null
    this.hostSecret = options.mode === 'cloud' ? options.hostSecret : null
    this.iceConfigEndpointUrl =
      options.mode === 'cloud' ? options.iceConfigEndpointUrl : undefined
    this.forceRelay =
      options.mode === 'cloud' ? options.forceRelay === true : false
    this.callbacks = options.callbacks ?? {}
    const transport =
      options.mode === 'cloud'
        ? createCloudSignalingTransport(
            options.relayUrl,
            options.inviteId,
            'Could not connect to the cloud remote-session relay. Check your internet connection and try again.'
          )
        : createLanHostSignalingTransport(
            options.signalingPort,
            options.sessionId,
            options.token
          )
    this.transport = transport

    transport.onMessage(message => {
      void this.handleMessage(message).catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        this.callbacks.onError?.(message)
      })
    })
    transport.onError(error => {
      if (this.transport !== transport || !this.transportConnected) return
      this.callbacks.onError?.(error.message)
    })
    transport.onClose(() => {
      if (this.transport !== transport) return
      this.transportConnected = false
      const wasAudioActive = this.isIntercomAudioActive()
      this.clearRemoteAudioState()
      this.stopLocalAudioStream()
      this.updateIdleTimersAfterAudioChange(wasAudioActive)
      this.callbacks.onStatus?.('Remote-session signaling socket closed')
    })

    await transport.connect()
    this.transportConnected = true
    if (options.mode === 'cloud') {
      await transport.send({
        type: 'host_register',
        invite_id: options.inviteId,
        host_secret: options.hostSecret,
      })
      return
    }
    await transport.send({
      type: 'host_register',
      session_id: options.sessionId,
    })
  }

  async startViewOnlyOffer(guestDeviceId: string) {
    const sessionId = this.requireSessionId()
    const transport = this.requireTransport()
    await this.closeLocalPeer()
    this.mediaDiagnostics = createRemoteMediaDiagnostics()
    this.mediaDiagnostics.requestedMaxBitrate =
      this.mode === 'cloud'
        ? REMOTE_VIDEO_CLOUD_BITRATE_BPS
        : REMOTE_VIDEO_LAN_BITRATE_BPS
    this.dataChannelCloseHandled = false

    let stream: MediaStream
    try {
      stream = await getRemoteCaptureStream({
        onNativeCaptureStarted: result => {
          this.mediaDiagnostics.nativeValidatedFrameHeight = result.frame_height
          this.mediaDiagnostics.nativeValidatedFrameWidth = result.frame_width
          this.mediaDiagnostics.nativeValidatedSurfaceKind = result.surface_kind
          this.mediaDiagnostics.nativeValidationError = null
        },
        onNativeFrameError: event => {
          this.mediaDiagnostics.nativeFrameErrors += 1
          this.mediaDiagnostics.nativeFrameByteLength = event.byteLength
          this.mediaDiagnostics.nativeFrameHeight = event.height
          this.mediaDiagnostics.nativeFramePixelFormat = event.pixelFormat
          this.mediaDiagnostics.nativeFrameWidth = event.width
          this.mediaDiagnostics.nativeLastFrameError = event.message ?? null
        },
        onNativeFrameDropped: event => {
          this.mediaDiagnostics.nativeFramesDropped += 1
          this.mediaDiagnostics.nativeFrameByteLength = event.byteLength
          this.mediaDiagnostics.nativeFrameHeight = event.height
          this.mediaDiagnostics.nativeFramePixelFormat = event.pixelFormat
          this.mediaDiagnostics.nativeFrameWidth = event.width
        },
        onNativeFrameReceived: event => {
          this.mediaDiagnostics.nativeFramesReceived += 1
          this.mediaDiagnostics.nativeFrameByteLength = event.byteLength
          this.mediaDiagnostics.nativeFrameHeight = event.height
          this.mediaDiagnostics.nativeFramePixelFormat = event.pixelFormat
          this.mediaDiagnostics.nativeFrameWidth = event.width
        },
        onNativeFrameWritten: event => {
          this.mediaDiagnostics.nativeFramesWritten += 1
          this.mediaDiagnostics.nativeFrameByteLength = event.byteLength
          this.mediaDiagnostics.nativeFrameHeight = event.height
          this.mediaDiagnostics.nativeFramePixelFormat = event.pixelFormat
          this.mediaDiagnostics.nativeFrameWidth = event.width
        },
      })
    } catch (error) {
      this.mediaDiagnostics.nativeValidationError =
        error instanceof Error ? error.message : String(error)
      throw error
    }
    await applyRemoteCaptureResolutionLimit(stream, this.callbacks.onWarning)
    this.stream = stream

    const peerConnection = new RTCPeerConnection(
      await getRemotePeerConnectionConfig(this.peerConnectionConfigRequest())
    )
    this.peerConnection = peerConnection
    const dataChannel = peerConnection.createDataChannel(
      REMOTE_INPUT_CHANNEL_LABEL,
      { ordered: true }
    )
    this.dataChannel = dataChannel
    dataChannel.onmessage = event => {
      this.enqueueInputMessage(String(event.data))
    }
    dataChannel.onopen = () => {
      this.callbacks.onStatus?.('Remote-session control channel open')
      this.resetIdleTimers()
      const waiters = this.dataChannelWaiters.splice(0)
      for (const waiter of waiters) {
        window.clearTimeout(waiter.timeout)
        waiter.resolve()
      }
    }
    dataChannel.onclose = () => {
      if (this.dataChannel !== dataChannel) return
      this.handleDataChannelClose()
    }
    peerConnection.ontrack = event => {
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        if (track.kind !== 'audio') continue
        const audioStream = new MediaStream([track])
        this.remoteAudioStream = audioStream
        this.emitRemoteAudioStream(audioStream)
      }
    }

    const senders: RTCRtpSender[] = []
    for (const track of stream.getTracks()) {
      applyRemoteVideoTrackHint(track)
      senders.push(peerConnection.addTrack(track, stream))
    }
    const audioTransceiver = peerConnection.addTransceiver('audio', {
      direction: 'sendrecv',
    })
    this.audioTransceiver = audioTransceiver
    this.audioSender = audioTransceiver.sender
    this.mediaSenders = senders
    const codecPreference = applyRemoteCodecPreferences(
      peerConnection,
      this.callbacks.onWarning
    )
    this.mediaDiagnostics.codecPreferenceEvaluated = codecPreference.evaluated
    this.mediaDiagnostics.codecPreferenceAttempted = codecPreference.attempted
    this.mediaDiagnostics.codecPreferenceFirstMimeType =
      codecPreference.firstMimeType

    peerConnection.onicecandidate = event => {
      if (event.candidate) {
        void transport
          .send(
            this.mode === 'cloud'
              ? {
                  type: 'ice_candidate',
                  invite_id: this.requireInviteId(),
                  guest_device_id: guestDeviceId,
                  payload: event.candidate.toJSON(),
                }
              : {
                  type: 'ice_candidate',
                  session_id: sessionId,
                  guest_device_id: guestDeviceId,
                  payload: event.candidate.toJSON(),
                }
          )
          .catch(error =>
            // Candidate trickle is best-effort; negotiation may already have enough candidates.
            this.emitError(
              error instanceof Error ? error.message : String(error)
            )
          )
      }
    }
    peerConnection.onconnectionstatechange = () => {
      this.callbacks.onStatus?.(
        `Remote-session stream: ${peerConnection.connectionState}`
      )
      if (peerConnection.connectionState === 'connected') {
        this.peerFailureReported = false
        this.lastErrorMessage = null
        this.lastErrorReportedAt = 0
        if (
          this.mode === 'cloud' &&
          this.mediaDiagnostics.appliedCandidateType === null
        ) {
          void this.applyNegotiatedMediaPolicy().catch(error => {
            this.emitError(error instanceof Error ? error.message : String(error))
          })
        }
      }
      if (peerConnection.connectionState === 'failed') {
        if (this.peerFailureReported) {
          return
        }
        this.peerFailureReported = true
        this.emitError(
          'WebRTC connection failed. Ask the guest to reconnect on the same Wi-Fi and approve the session again.'
        )
        this.stopLocalAudioStream()
        this.clearRemoteAudioState()
        this.resetIdleTimers()
      }
    }

    const offer = await peerConnection.createOffer()
    await peerConnection.setLocalDescription(offer)
    this.securityCode = deriveRemoteSecurityCode(
      peerConnection.localDescription ?? offer
    )
    this.emitSecurityCode(this.securityCode)
    if (this.mode === 'cloud') {
      const inviteId = this.requireInviteId()
      await transport.send({
        type: 'join_approved',
        invite_id: inviteId,
        guest_device_id: guestDeviceId,
      })
      await transport.send({
        type: 'video_offer',
        invite_id: inviteId,
        guest_device_id: guestDeviceId,
        payload: offer,
      })
      return
    }
    await transport.send({
      type: 'video_offer',
      session_id: sessionId,
      guest_device_id: guestDeviceId,
      payload: offer,
    })
  }

  async close(notify = false, reason?: RemoteSessionRevokedReason) {
    await this.closeLocalPeer()
    if (notify && this.sessionId && this.transport && this.transportConnected) {
      try {
        const message =
          this.mode === 'cloud'
            ? {
                type: 'session_revoked' as const,
                invite_id: this.requireInviteId(),
                ...(reason ? { reason } : {}),
              }
            : {
                type: 'session_revoked' as const,
                session_id: this.sessionId,
                ...(reason ? { reason } : {}),
              }
        await this.transport.send(message)
      } catch (error) {
        // Teardown must complete even if the signaling socket is already closing.
        this.callbacks.onError?.(
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    this.closeTransport()
    this.sessionId = null
    this.mode = 'lan'
    this.inviteId = null
    this.hostSecret = null
    this.iceConfigEndpointUrl = undefined
    this.forceRelay = false
    this.callbacks = {}
  }

  rejectGuest(guestDeviceId: string, reason: string) {
    if (this.mode !== 'cloud' || !this.transport || !this.transportConnected) {
      return
    }
    const onError = this.callbacks.onError
    void this.transport
      .send({
        type: 'join_rejected',
        invite_id: this.requireInviteId(),
        guest_device_id: guestDeviceId,
        reason,
      })
      .catch(error =>
        onError?.(error instanceof Error ? error.message : String(error))
      )
  }

  subscribe(callbacks: HostCallbacks) {
    this.callbackSubscriptions.add(callbacks)
    this.replayCallbacks(callbacks)
    return () => {
      this.callbackSubscriptions.delete(callbacks)
    }
  }

  isDataChannelOpen() {
    return this.dataChannel?.readyState === 'open'
  }

  waitForDataChannelOpen(timeoutMs = 10000) {
    if (this.isDataChannelOpen()) return Promise.resolve()
    if (!this.peerConnection || !this.dataChannel) {
      return Promise.reject(
        new Error('Remote-session data channel is not active')
      )
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.dataChannelWaiters = this.dataChannelWaiters.filter(
          waiter => waiter.resolve !== resolve
        )
        reject(new Error('Timed out waiting for remote-session data channel'))
      }, timeoutMs)

      this.dataChannelWaiters.push({ resolve, reject, timeout })
    })
  }

  getInputDiagnostics() {
    return {
      attemptedMouseInputCount: this.attemptedMouseInputCount,
      acceptedInputCount: this.acceptedInputCount,
      lastAcceptedInputType: this.lastAcceptedInputType,
      lastAcceptedInputScreenPoint: this.lastAcceptedInputScreenPoint,
      recentAcceptedInputScreenPoints: [
        ...this.recentAcceptedInputScreenPoints,
      ],
      lastMouseInputForwardElapsedMs: this.lastMouseInputForwardElapsedMs,
      recentMouseInputForwardElapsedMs: [
        ...this.recentMouseInputForwardElapsedMs,
      ],
      pendingMouseButtonTransitionCount: this.pendingMouseButtonTransitions,
      pressedMouseButtonCount: this.pressedButtons.size,
      pressedMouseButtons: [...this.pressedButtons.keys()],
      rejectedMouseInputCount: this.rejectedMouseInputCount,
      lastRejectedMouseInputError: this.lastRejectedMouseInputError,
    }
  }

  getMediaDiagnostics() {
    return { ...this.mediaDiagnostics }
  }

  getPeerConnectionDiagnostics(): RemotePeerConnectionDiagnostics {
    return {
      dataChannelState: this.dataChannel?.readyState ?? null,
      iceConnectionState: this.peerConnection?.iceConnectionState ?? null,
      peerConnectionState: this.peerConnection?.connectionState ?? null,
    }
  }

  getSignalingDiagnostics(): RemoteSignalingDiagnostics {
    return (
      this.transport?.getDiagnostics() ?? {
        webSocketState: null,
        sentMessageCount: 0,
        receivedMessageCount: 0,
        lastSignalingError: null,
        lastHeartbeatAckAtUnixMs: null,
      }
    )
  }

  getSecurityCode() {
    return this.securityCode
  }

  getAudioDiagnostics() {
    const [localAudioTrack] = this.localAudioStream?.getAudioTracks() ?? []
    const [remoteAudioTrack] = this.remoteAudioStream?.getAudioTracks() ?? []
    return {
      audioMuted: this.audioMuted,
      audioTransceiverCreated: this.audioTransceiver !== null,
      audioSenderTrackAttached: this.audioSender?.track != null,
      audioInputDeviceId: this.audioInputDeviceId,
      ...remoteAudioProcessingDiagnostics(),
      isIntercomAudioActive: this.isIntercomAudioActive(),
      lastRemoteAudioStateSeq: this.lastRemoteAudioStateSeq,
      localAudioSending: this.localAudioUnmuted,
      localAudioCaptureSource: getRemoteAudioCaptureSource(
        this.localAudioStream
      ),
      localAudioTrackLive: localAudioTrack?.readyState === 'live',
      localAudioTrackEnabled: localAudioTrack?.enabled ?? null,
      localAudioTrackReadyState: localAudioTrack?.readyState ?? null,
      remoteAudioSending: this.remoteAudioSending,
      remoteAudioTrackLive: remoteAudioTrack?.readyState === 'live',
      remoteAudioTrackReadyState: remoteAudioTrack?.readyState ?? null,
    }
  }

  private emitSecurityCode(code: string | null) {
    this.callbacks.onSecurityCode?.(code)
    this.callbackSubscriptions.forEach(callbacks =>
      callbacks.onSecurityCode?.(code)
    )
  }

  private emitRemoteAudioStream(stream: MediaStream) {
    this.callbacks.onRemoteAudioStream?.(stream)
    this.callbackSubscriptions.forEach(callbacks =>
      callbacks.onRemoteAudioStream?.(stream)
    )
  }

  private emitLocalAudioStreamChange(stream: MediaStream | null) {
    this.callbacks.onLocalAudioStreamChange?.(stream)
    this.callbackSubscriptions.forEach(callbacks =>
      callbacks.onLocalAudioStreamChange?.(stream)
    )
  }

  private replayCallbacks(callbacks: HostCallbacks) {
    if (this.remoteAudioStream) {
      callbacks.onRemoteAudioStream?.(this.remoteAudioStream)
    }
    callbacks.onLocalAudioStreamChange?.(this.localAudioStream)
    callbacks.onSecurityCode?.(this.securityCode)
  }

  async enableAudio() {
    if (this.audioEnableTask) {
      return this.audioEnableTask
    }
    const task = this.enableAudioOnce()
    this.audioEnableTask = task
    try {
      await task
    } finally {
      if (this.audioEnableTask === task) {
        this.audioEnableTask = null
      }
    }
  }

  private async enableAudioOnce() {
    const sender = this.audioSender
    if (!sender) {
      throw new RemoteAudioSenderInactiveError()
    }
    const wasActive = this.isIntercomAudioActive()
    const muteGeneration = this.audioMuteGeneration
    const stopGeneration = this.audioStopGeneration
    const stream = await getRemoteMicrophoneStream(
      undefined,
      this.audioInputDeviceId
    )
    if (
      this.audioSender !== sender ||
      this.audioStopGeneration !== stopGeneration
    ) {
      stopRemoteAudioStream(stream)
      throw new RemoteAudioSenderInactiveError()
    }
    const [track] = stream.getAudioTracks()
    if (!track) {
      stopRemoteAudioStream(stream)
      throw new Error('No microphone audio track is available')
    }
    try {
      await sender.replaceTrack(track)
    } catch (error) {
      stopRemoteAudioStream(stream)
      throw error
    }
    if (
      this.audioSender !== sender ||
      this.audioStopGeneration !== stopGeneration
    ) {
      stopRemoteAudioStream(stream)
      void this.detachAudioSenderTrack(sender)
      throw new RemoteAudioSenderInactiveError()
    }
    this.stopLocalAudioStream({ preserveAudioState: true })
    this.localAudioStream = stream
    this.emitLocalAudioStreamChange(stream)
    if (this.audioMuteGeneration === muteGeneration) {
      this.audioMuted = false
    }
    track.enabled = !this.audioMuted
    this.localAudioUnmuted = !this.audioMuted
    this.updateIdleTimersAfterAudioChange(wasActive)
  }

  setAudioMuted(muted: boolean) {
    const wasActive = this.isIntercomAudioActive()
    this.audioMuteGeneration += 1
    this.audioMuted = muted
    for (const track of this.localAudioStream?.getAudioTracks() ?? []) {
      track.enabled = !muted
    }
    this.localAudioUnmuted = this.localAudioStream !== null && !muted
    this.updateIdleTimersAfterAudioChange(wasActive)
  }

  async disableAudio() {
    const wasActive = this.isIntercomAudioActive()
    this.audioStopGeneration += 1
    await this.detachAudioSenderTrack(this.audioSender)
    this.audioMuted = true
    this.stopLocalAudioStream()
    this.updateIdleTimersAfterAudioChange(wasActive)
  }

  async setAudioInputDevice(deviceId: string | null) {
    this.audioInputDeviceId = deviceId
    const sender = this.audioSender
    const previousStream = this.localAudioStream
    if (!previousStream || !sender) return
    const wasActive = this.isIntercomAudioActive()
    const stream = await getRemoteMicrophoneStream(undefined, deviceId)
    if (this.audioSender !== sender || this.localAudioStream !== previousStream) {
      stopRemoteAudioStream(stream)
      throw new RemoteAudioSenderInactiveError()
    }
    const [track] = stream.getAudioTracks()
    if (!track) {
      stopRemoteAudioStream(stream)
      throw new Error('No microphone audio track is available')
    }
    track.enabled = !this.audioMuted
    try {
      await sender.replaceTrack(track)
    } catch (error) {
      stopRemoteAudioStream(stream)
      throw error
    }
    this.stopLocalAudioStream({ preserveAudioState: true })
    this.localAudioStream = stream
    this.emitLocalAudioStreamChange(stream)
    this.localAudioUnmuted = !this.audioMuted
    this.updateIdleTimersAfterAudioChange(wasActive)
  }

  private async detachAudioSenderTrack(sender: RTCRtpSender | null) {
    await detachRemoteAudioSenderTrack(sender, 'host')
  }

  async getPeerConnectionStats() {
    if (!this.peerConnection) return []
    const report = await this.peerConnection.getStats()
    return [...report.values()]
  }

  private async handleMessage(message: SignalingServerMessage) {
    if (message.type === 'join_request') {
      try {
        await noteRemoteSessionGuestPending(
          message.invite_id,
          message.guest_display_name,
          message.guest_device_id
        )
        this.callbacks.onJoinPending?.()
      } catch (error) {
        this.rejectGuest(
          message.guest_device_id,
          error instanceof Error ? error.message : String(error)
        )
      }
      return
    }

    if (message.type === 'join_pending') {
      this.callbacks.onJoinPending?.()
      return
    }

    if (message.type === 'video_answer') {
      if (!this.peerConnection) return
      await this.peerConnection.setRemoteDescription(message.payload)
      await this.applyNegotiatedMediaPolicy()
      for (const candidate of this.pendingIceCandidates) {
        await this.peerConnection.addIceCandidate(candidate)
      }
      this.pendingIceCandidates = []
      return
    }

    if (message.type === 'ice_candidate') {
      if (!this.peerConnection || !message.payload.candidate) return
      if (!this.peerConnection.remoteDescription) {
        this.pendingIceCandidates.push(message.payload)
        return
      }
      await this.peerConnection.addIceCandidate(message.payload)
      return
    }

    if (message.type === 'session_revoked') {
      await this.closeLocalPeer()
      this.callbacks.onRevoked?.()
      return
    }

    if (message.type === 'guest_disconnected') {
      await this.closeLocalPeer()
      this.callbacks.onStatus?.('Remote-session guest disconnected')
      return
    }

    if (message.type === 'error') {
      this.callbacks.onError?.(
        message.reason ?? message.message ?? 'Remote session failed'
      )
      await this.closeLocalPeer()
    }
  }

  private enqueueInputMessage(raw: string) {
    let message: RemoteInputChannelMessage
    try {
      message = parseRemoteInputChannelMessage(raw)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logRuntimeDebug('remote-input', 'host_input_parse_failed', {
        errorMessage,
        rawLength: raw.length,
      })
      this.callbacks.onError?.(errorMessage)
      return
    }

    if (message.type === 'mouse' && message.event.action !== 'move') {
      logRuntimeDebug('remote-input', 'host_mouse_received', {
        action: message.event.action,
        button: message.event.button,
        pendingTransitions: this.pendingMouseButtonTransitions,
        pressedButtons: [...this.pressedButtons.keys()],
      })
    } else if (message.type === 'key') {
      logRuntimeDebug('remote-input', 'host_key_received', {
        action: message.event.action,
        key: message.event.key,
        pressedKeyCount: this.pressedKeys.size,
      })
    }

    if (
      message.type === 'mouse' &&
      message.event.action === 'move' &&
      this.pendingMouseButtonTransitions === 0 &&
      this.pressedButtons.size === 0
    ) {
      this.mouseMoveQueue = this.mouseMoveQueue
        .then(() => this.forwardInputMessage(message))
        .catch(error => {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          this.trackRejectedMouseInput(message, errorMessage)
          if (!this.isNonFatalRemoteInputRejection(errorMessage)) {
            this.emitError(errorMessage)
          }
        })
      return
    }

    const mouseButtonTransitionEvent =
      message.type === 'mouse' &&
      (message.event.action === 'down' || message.event.action === 'up')
        ? message.event
        : null
    const isMouseButtonTransition = mouseButtonTransitionEvent !== null
    if (isMouseButtonTransition) {
      this.pendingMouseButtonTransitions += 1
      logRuntimeDebug('remote-input', 'host_mouse_transition_queued', {
        action: mouseButtonTransitionEvent.action,
        button: mouseButtonTransitionEvent.button,
        pendingTransitions: this.pendingMouseButtonTransitions,
        pressedButtons: [...this.pressedButtons.keys()],
      })
    }
    this.inputQueue = this.inputQueue
      .then(() => this.forwardInputMessage(message))
      .catch(error => {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        this.trackRejectedMouseInput(message, errorMessage)
        if (!this.isNonFatalRemoteInputRejection(errorMessage)) {
          this.emitError(errorMessage)
        }
      })
      .finally(() => {
        if (isMouseButtonTransition) {
          // Teardown can reset this counter while an old transition is still
          // settling; stale finally handlers must not poison the next flow.
          this.pendingMouseButtonTransitions = Math.max(
            0,
            this.pendingMouseButtonTransitions - 1
          )
          logRuntimeDebug('remote-input', 'host_mouse_transition_settled', {
            action: mouseButtonTransitionEvent.action,
            button: mouseButtonTransitionEvent.button,
            pendingTransitions: this.pendingMouseButtonTransitions,
            pressedButtons: [...this.pressedButtons.keys()],
          })
        }
      })
  }

  private applyNegotiatedMediaPolicy() {
    const task = this.mediaPolicyQueue
      .catch(() => undefined)
      .then(() => this.applyNegotiatedMediaPolicyNow())
    this.mediaPolicyQueue = task
    return task
  }

  private async applyNegotiatedMediaPolicyNow() {
    const selectedCandidateType =
      this.peerConnection && this.mode === 'cloud'
        ? await this.selectedCandidateType().catch(() => null)
        : null
    const appliedPolicy = await applyRemoteSenderBitratePolicy(
      this.mediaSenders,
      message => this.callbacks.onWarning?.(message),
      {
        forceRelay: this.forceRelay,
        mode: this.mode,
        selectedCandidateType,
      }
    )
    if (!appliedPolicy) return
    this.mediaDiagnostics.appliedMaxBitrate = appliedPolicy.maxBitrate
    this.mediaDiagnostics.appliedMaxFramerate = appliedPolicy.maxFramerate
    this.mediaDiagnostics.appliedScaleResolutionDownBy =
      appliedPolicy.scaleResolutionDownBy
    this.mediaDiagnostics.appliedCandidateType = appliedPolicy.candidateType
  }

  private async selectedCandidateType() {
    if (!this.peerConnection) return null
    return selectedRemoteCandidateTypeFromStats(
      await this.peerConnection.getStats()
    )
  }

  private async forwardInputMessage(message: RemoteInputChannelMessage) {
    if (message.type === 'audio_state') {
      this.trackRemoteAudioState(message)
      return
    }
    if (message.type === 'mouse') {
      this.attemptedMouseInputCount += 1
      if (message.event.action !== 'move') {
        logRuntimeDebug('remote-input', 'host_mouse_forward_start', {
          action: message.event.action,
          attemptedMouseInputCount: this.attemptedMouseInputCount,
          button: message.event.button,
          pressedButtons: [...this.pressedButtons.keys()],
        })
      }
      const shouldForward = await this.releaseDuplicateMouseDown(message.event)
      if (!shouldForward) {
        logRuntimeDebug('remote-input', 'host_mouse_forward_dropped', {
          action: message.event.action,
          button: message.event.button,
          reason: 'duplicate_down_release_failed',
          pressedButtons: [...this.pressedButtons.keys()],
        })
        return
      }
      const startedAt = performance.now()
      const result = await sendRemoteMouseInput(message.event)
      this.trackMouseInputForwardTiming(performance.now() - startedAt)
      this.trackMouseInput(message.event)
      this.trackAcceptedInput(message.type, result)
      if (message.event.action !== 'move') {
        logRuntimeDebug('remote-input', 'host_mouse_forward_accepted', {
          action: message.event.action,
          acceptedInputCount: this.acceptedInputCount,
          button: message.event.button,
          pressedButtons: [...this.pressedButtons.keys()],
          screenX: result.screen_x,
          screenY: result.screen_y,
        })
      }
      return
    }
    if (message.type === 'target_geometry') {
      return
    }
    await sendRemoteKeyInput(message.event)
    this.trackKeyInput(message.event)
    this.trackAcceptedInput(message.type)
  }

  private trackAcceptedInput(
    type: RemoteInputChannelMessage['type'],
    screenPoint: RemoteInputMouseResult | null = null
  ) {
    this.acceptedInputCount += 1
    this.lastAcceptedInputType = type
    this.lastAcceptedInputScreenPoint = screenPoint
    if (screenPoint) {
      this.recentAcceptedInputScreenPoints = [
        ...this.recentAcceptedInputScreenPoints,
        screenPoint,
      ].slice(-20)
    }
    this.resetIdleTimers()
  }

  private trackMouseInputForwardTiming(elapsedMs: number) {
    const roundedElapsedMs = Math.round(elapsedMs * 100) / 100
    this.lastMouseInputForwardElapsedMs = roundedElapsedMs
    this.recentMouseInputForwardElapsedMs = [
      ...this.recentMouseInputForwardElapsedMs,
      roundedElapsedMs,
    ].slice(-40)
  }

  private trackRejectedMouseInput(
    message: RemoteInputChannelMessage,
    errorMessage: string
  ) {
    if (message.type === 'mouse') {
      this.rejectedMouseInputCount += 1
      this.lastRejectedMouseInputError = errorMessage
      if (message.event.action === 'move') {
        return
      }
      logRuntimeDebug('remote-input', 'host_mouse_rejected', {
        action: message.event.action,
        button: message.event.button,
        errorMessage,
        rejectedMouseInputCount: this.rejectedMouseInputCount,
        pressedButtons: [...this.pressedButtons.keys()],
      })
    }
  }

  private isNonFatalRemoteInputRejection(errorMessage: string) {
    return (
      NON_FATAL_REMOTE_INPUT_ERRORS.has(errorMessage) ||
      NON_FATAL_REMOTE_INPUT_ERROR_PREFIXES.some(prefix =>
        errorMessage.startsWith(prefix)
      )
    )
  }

  private emitError(message: string) {
    const now = Date.now()
    if (
      this.lastErrorMessage === message &&
      now - this.lastErrorReportedAt < REMOTE_ERROR_DEDUPE_WINDOW_MS
    ) {
      return
    }
    this.lastErrorMessage = message
    this.lastErrorReportedAt = now
    this.callbacks.onError?.(message)
  }

  private trackMouseInput(event: RemoteInputMouseEventPayload) {
    if (!event.button) return
    if (event.action === 'down') {
      this.pressedButtons.set(event.button, event)
      return
    }
    if (event.action === 'up' || event.action === 'click') {
      this.pressedButtons.delete(event.button)
    }
  }

  private async releaseDuplicateMouseDown(event: RemoteInputMouseEventPayload) {
    if (event.action !== 'down' || !event.button) return true
    const pressed = this.pressedButtons.get(event.button)
    if (!pressed) return true
    logRuntimeDebug('remote-input', 'host_duplicate_down_detected', {
      button: event.button,
      incomingNormalizedX: event.normalized_x,
      incomingNormalizedY: event.normalized_y,
      pressedNormalizedX: pressed.normalized_x,
      pressedNormalizedY: pressed.normalized_y,
    })
    try {
      await sendRemoteMouseInput({ ...pressed, action: 'up' })
      this.pressedButtons.delete(event.button)
      logRuntimeDebug('remote-input', 'host_duplicate_down_released', {
        button: event.button,
        pressedButtons: [...this.pressedButtons.keys()],
      })
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.trackRejectedMouseInput(
        { type: 'mouse', event: { ...pressed, action: 'up' } },
        errorMessage
      )
      if (!this.isNonFatalRemoteInputRejection(errorMessage)) {
        this.emitError(errorMessage)
      }
      this.pressedButtons.delete(event.button)
      logRuntimeDebug('remote-input', 'host_duplicate_down_release_failed', {
        button: event.button,
        errorMessage,
        pressedButtons: [...this.pressedButtons.keys()],
      })
      return false
    }
  }

  private trackKeyInput(event: RemoteInputKeyEventPayload) {
    const keyId = JSON.stringify(event.key)
    if (event.action === 'down') {
      this.pressedKeys.set(keyId, event)
      return
    }
    if (event.action === 'up' || event.action === 'click') {
      this.pressedKeys.delete(keyId)
    }
  }

  private async releasePressedInputs() {
    await this.inputQueue.catch(() => undefined)
    await this.mouseMoveQueue.catch(() => undefined)
    const buttons = [...this.pressedButtons.values()]
    const keys = [...this.pressedKeys.values()]
    this.pressedButtons.clear()
    this.pressedKeys.clear()

    for (const event of buttons) {
      await sendRemoteMouseInput({ ...event, action: 'up' }).catch(error =>
        this.emitError(error instanceof Error ? error.message : String(error))
      )
    }
    for (const event of keys) {
      await sendRemoteKeyInput({ ...event, action: 'up' }).catch(error =>
        this.emitError(error instanceof Error ? error.message : String(error))
      )
    }
  }

  private requireSessionId() {
    if (!this.sessionId) {
      throw new Error('Remote-session host is not connected')
    }
    return this.sessionId
  }

  private requireInviteId() {
    if (!this.inviteId) {
      throw new Error('Remote-session cloud invite is missing')
    }
    return this.inviteId
  }

  private requireHostSecret() {
    if (!this.hostSecret) {
      throw new Error('Remote-session cloud host secret is missing')
    }
    return this.hostSecret
  }

  private peerConnectionConfigRequest() {
    if (this.mode === 'lan') {
      return { mode: 'lan' as const }
    }
    return {
      mode: 'cloud' as const,
      endpointUrl: this.iceConfigEndpointUrl,
      forceRelay: this.forceRelay,
      request: {
        role: 'host' as const,
        invite_id: this.requireInviteId(),
        host_secret: this.requireHostSecret(),
      },
    }
  }

  private requireTransport() {
    if (!this.transport || !this.transportConnected) {
      throw new Error('Remote-session signaling socket is not open')
    }
    return this.transport
  }

  private async closeLocalPeer() {
    this.clearIdleTimers()
    this.clearRemoteAudioState()
    await this.releasePressedInputs()
    this.rejectDataChannelWaiters(
      new Error('Remote-session data channel closed before opening')
    )
    this.dataChannel?.close()
    this.peerConnection?.close()
    this.stopLocalAudioStream()
    this.stopCaptureStream()
    this.clearPeerMediaState()
  }

  private handleDataChannelClose() {
    // DataChannel close events can arrive after local teardown; handle only
    // the first close event for the currently active channel.
    if (this.dataChannelCloseHandled) return
    this.dataChannelCloseHandled = true
    this.clearIdleTimers()
    this.clearRemoteAudioState()
    this.rejectDataChannelWaiters(
      new Error('Remote-session data channel closed')
    )
    if (this.peerConnection) {
      this.peerConnection.close()
      this.mediaDiagnostics.peerConnectionClosedAfterDataChannelClose = true
    }
    this.stopLocalAudioStream()
    this.stopCaptureStream()
    const releaseTask = this.releasePressedInputs()
    this.clearPeerMediaState()
    void releaseTask
  }

  private clearPeerMediaState() {
    this.peerConnection = null
    this.dataChannel = null
    this.mediaSenders = []
    this.audioSender = null
    this.audioTransceiver = null
    this.audioInputDeviceId = null
    this.audioEnableTask = null
    this.remoteAudioStream = null
    this.lastRemoteAudioStateSeq = null
    if (this.securityCode !== null) {
      this.securityCode = null
      this.emitSecurityCode(null)
    }
    this.pendingIceCandidates = []
    this.inputQueue = Promise.resolve()
    this.mouseMoveQueue = Promise.resolve()
    this.mediaPolicyQueue = Promise.resolve()
    this.pendingMouseButtonTransitions = 0
    this.lastErrorMessage = null
    this.lastErrorReportedAt = 0
    this.peerFailureReported = false
  }

  private stopCaptureStream() {
    const stream = this.stream
    stream?.getTracks().forEach(track => track.stop())
    if (stream) {
      this.mediaDiagnostics.captureTrackStopped = true
    }
    this.stream = null
  }

  private stopLocalAudioStream(
    options: HostStopLocalAudioOptions = {}
  ) {
    const previousStream = this.localAudioStream
    const preserveAudioState = options.preserveAudioState ?? false
    stopRemoteAudioStream(this.localAudioStream)
    this.localAudioStream = null
    if (previousStream) {
      this.emitLocalAudioStreamChange(null)
    }
    if (!preserveAudioState) {
      this.audioMuted = true
      this.localAudioUnmuted = false
    }
  }

  private resetIdleTimers() {
    const shouldNotifyReset = this.idleWarningActive
    this.clearIdleTimers()
    if (shouldNotifyReset) {
      this.callbacks.onIdleReset?.()
    }
    if (this.isIntercomAudioActive()) return
    this.idleWarningTimer = window.setTimeout(() => {
      this.idleWarningActive = true
      this.callbacks.onIdleWarning?.(REMOTE_IDLE_WARNING_BEFORE_MS / 1000)
    }, REMOTE_IDLE_TIMEOUT_MS - REMOTE_IDLE_WARNING_BEFORE_MS)
    this.idleExpiryTimer = window.setTimeout(() => {
      this.clearIdleTimers()
      this.callbacks.onIdleExpired?.()
    }, REMOTE_IDLE_TIMEOUT_MS)
  }

  private clearIdleTimers() {
    if (this.idleWarningTimer !== null) {
      window.clearTimeout(this.idleWarningTimer)
      this.idleWarningTimer = null
    }
    if (this.idleExpiryTimer !== null) {
      window.clearTimeout(this.idleExpiryTimer)
      this.idleExpiryTimer = null
    }
    this.idleWarningActive = false
  }

  private trackRemoteAudioState(
    message: Extract<RemoteInputChannelMessage, { type: 'audio_state' }>
  ) {
    if (message.seq !== undefined) {
      if (
        this.lastRemoteAudioStateSeq !== null &&
        message.seq <= this.lastRemoteAudioStateSeq
      ) {
        return
      }
      this.lastRemoteAudioStateSeq = message.seq
    }
    const wasActive = this.isIntercomAudioActive()
    this.remoteAudioSending = message.sending && !message.muted
    this.updateIdleTimersAfterAudioChange(wasActive)
  }

  private clearRemoteAudioState() {
    this.remoteAudioSending = false
  }

  private isIntercomAudioActive() {
    return this.localAudioUnmuted || this.remoteAudioSending
  }

  private updateIdleTimersAfterAudioChange(wasActive: boolean) {
    const isActive = this.isIntercomAudioActive()
    if (wasActive === isActive) return
    this.resetIdleTimers()
  }

  private rejectDataChannelWaiters(error: Error) {
    const waiters = this.dataChannelWaiters.splice(0)
    for (const waiter of waiters) {
      window.clearTimeout(waiter.timeout)
      waiter.reject(error)
    }
  }

  private closeTransport() {
    this.transport?.close()
    this.transport = null
    this.transportConnected = false
  }
}

export const remoteWebRtcHost = new RemoteWebRtcHostSession()
