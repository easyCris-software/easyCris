import { remoteWebRtcClient } from '@/services/remoteWebRtcClient'
import { remoteWebRtcHost } from '@/services/remoteWebRtcHost'

type AudioDiagnostics = Record<string, unknown>
type RtcStatsLike = Record<string, unknown>

let isMonitoring = false
let intervalId: number | null = null

const audioStatKind = (stat: RtcStatsLike) =>
  stat.kind === 'audio' || stat.mediaType === 'audio'

const numberValue = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const summarizeStats = (stats: RtcStatsLike[]) => {
  const outbound = stats.filter(
    stat => stat.type === 'outbound-rtp' && audioStatKind(stat)
  )
  const inbound = stats.filter(
    stat => stat.type === 'inbound-rtp' && audioStatKind(stat)
  )
  const mediaSource = stats.find(
    stat => stat.type === 'media-source' && audioStatKind(stat)
  )
  return {
    inboundAudioStreams: inbound.length,
    inboundAudioBytes: inbound.reduce(
      (sum, stat) => sum + numberValue(stat.bytesReceived),
      0
    ),
    inboundAudioPackets: inbound.reduce(
      (sum, stat) => sum + numberValue(stat.packetsReceived),
      0
    ),
    outboundAudioStreams: outbound.length,
    outboundAudioBytes: outbound.reduce(
      (sum, stat) => sum + numberValue(stat.bytesSent),
      0
    ),
    outboundAudioPackets: outbound.reduce(
      (sum, stat) => sum + numberValue(stat.packetsSent),
      0
    ),
    sourceAudioLevel:
      typeof mediaSource?.audioLevel === 'number'
        ? mediaSource.audioLevel
        : null,
  }
}

const summarizeDiagnostics = (diagnostics: AudioDiagnostics) => ({
  audioInputDeviceSelected: Boolean(diagnostics.audioInputDeviceId),
  audioMuted: diagnostics.audioMuted ?? null,
  audioSenderTrackAttached: diagnostics.audioSenderTrackAttached ?? null,
  browserAutoGainControlRequested:
    diagnostics.browserAutoGainControlRequested ?? null,
  browserEchoCancellationRequested:
    diagnostics.browserEchoCancellationRequested ?? null,
  browserNoiseSuppressionRequested:
    diagnostics.browserNoiseSuppressionRequested ?? null,
  customVadEnabled: diagnostics.customVadEnabled ?? null,
  isIntercomAudioActive: diagnostics.isIntercomAudioActive ?? null,
  lastRemoteAudioStateSeq: diagnostics.lastRemoteAudioStateSeq ?? null,
  localAudioSending: diagnostics.localAudioSending ?? null,
  localAudioTrackEnabled: diagnostics.localAudioTrackEnabled ?? null,
  localAudioTrackReadyState: diagnostics.localAudioTrackReadyState ?? null,
  pendingAudioStateSeq: diagnostics.pendingAudioStateSeq ?? null,
  remoteAudioSending: diagnostics.remoteAudioSending ?? null,
  remoteAudioTrackReadyState: diagnostics.remoteAudioTrackReadyState ?? null,
})

const collectRoleSnapshot = async (
  role: 'host' | 'guest',
  service: typeof remoteWebRtcHost | typeof remoteWebRtcClient
) => {
  const [stats] = await Promise.all([service.getPeerConnectionStats()])
  return {
    role,
    diagnostics: summarizeDiagnostics(service.getAudioDiagnostics()),
    stats: summarizeStats(stats as RtcStatsLike[]),
  }
}

const logAudioSnapshot = async () => {
  try {
    const [host, guest] = await Promise.all([
      collectRoleSnapshot('host', remoteWebRtcHost),
      collectRoleSnapshot('guest', remoteWebRtcClient),
    ])
    console.log(
      '%c[Remote Audio Monitor]',
      'color: #0ea5e9; font-weight: bold;',
      { host, guest }
    )
  } catch (error) {
    console.warn('[Remote Audio Monitor] Failed to read diagnostics', error)
  }
}

export const startRemoteAudioMonitor = () => {
  if (isMonitoring) {
    console.warn('[Remote Audio Monitor] Already monitoring')
    return
  }

  console.log(
    '%c[Remote Audio Monitor] Started',
    'color: #0ea5e9; font-weight: bold;'
  )
  isMonitoring = true
  void logAudioSnapshot()
  intervalId = window.setInterval(() => {
    void logAudioSnapshot()
  }, 2000)
}

export const stopRemoteAudioMonitor = () => {
  if (!isMonitoring) {
    console.warn('[Remote Audio Monitor] Not monitoring')
    return
  }

  console.log(
    '%c[Remote Audio Monitor] Stopped',
    'color: #0ea5e9; font-weight: bold;'
  )
  isMonitoring = false
  if (intervalId !== null) {
    window.clearInterval(intervalId)
    intervalId = null
  }
}

export const isRemoteAudioMonitoring = () => isMonitoring
