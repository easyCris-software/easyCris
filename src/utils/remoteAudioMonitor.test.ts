import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isRemoteAudioMonitoring,
  startRemoteAudioMonitor,
  stopRemoteAudioMonitor,
} from './remoteAudioMonitor'

const { hostDiagnostics, guestDiagnostics, hostStats, guestStats } = vi.hoisted(
  () => ({
    guestDiagnostics: {
      audioInputDeviceId: null,
      audioMuted: true,
      audioSenderTrackAttached: false,
      browserAutoGainControlRequested: true,
      browserEchoCancellationRequested: true,
      browserNoiseSuppressionRequested: true,
      customVadEnabled: false,
      localAudioTrackReadyState: null,
      remoteAudioTrackReadyState: null,
    },
    guestStats: [
      {
        type: 'inbound-rtp',
        kind: 'audio',
        bytesReceived: 17,
        packetsReceived: 2,
      },
    ],
    hostDiagnostics: {
      audioInputDeviceId: 'mic-1',
      audioMuted: false,
      audioSenderTrackAttached: true,
      browserAutoGainControlRequested: true,
      browserEchoCancellationRequested: true,
      browserNoiseSuppressionRequested: true,
      customVadEnabled: false,
      isIntercomAudioActive: true,
      localAudioTrackReadyState: 'live',
      remoteAudioTrackReadyState: 'live',
    },
    hostStats: [
      {
        type: 'outbound-rtp',
        kind: 'audio',
        bytesSent: 42,
        packetsSent: 3,
      },
      {
        type: 'media-source',
        kind: 'audio',
        audioLevel: 0.4,
      },
    ],
  })
)

vi.mock('@/services/remoteWebRtcHost', () => ({
  remoteWebRtcHost: {
    getAudioDiagnostics: vi.fn(() => hostDiagnostics),
    getPeerConnectionStats: vi.fn().mockResolvedValue(hostStats),
  },
}))

vi.mock('@/services/remoteWebRtcClient', () => ({
  remoteWebRtcClient: {
    getAudioDiagnostics: vi.fn(() => guestDiagnostics),
    getPeerConnectionStats: vi.fn().mockResolvedValue(guestStats),
  },
}))

describe('remoteAudioMonitor', () => {
  afterEach(() => {
    if (isRemoteAudioMonitoring()) stopRemoteAudioMonitor()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('logs sanitized host and guest audio diagnostics when enabled', async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    startRemoteAudioMonitor()
    await vi.waitFor(() =>
      expect(
        log.mock.calls.some(
          call =>
            call[0] === '%c[Remote Audio Monitor]' &&
            typeof call[2] === 'object'
        )
      ).toBe(true)
    )

    expect(isRemoteAudioMonitoring()).toBe(true)
    const snapshotCall = log.mock.calls.find(
      call =>
        call[0] === '%c[Remote Audio Monitor]' && typeof call[2] === 'object'
    )
    expect(snapshotCall?.[2]).toMatchObject({
      host: {
        diagnostics: {
          audioInputDeviceSelected: true,
          browserEchoCancellationRequested: true,
          browserNoiseSuppressionRequested: true,
          browserAutoGainControlRequested: true,
          customVadEnabled: false,
        },
        stats: {
          outboundAudioBytes: 42,
          outboundAudioPackets: 3,
          sourceAudioLevel: 0.4,
        },
      },
      guest: {
        diagnostics: {
          audioInputDeviceSelected: false,
          customVadEnabled: false,
        },
        stats: {
          inboundAudioBytes: 17,
          inboundAudioPackets: 2,
        },
      },
    })
    expect(JSON.stringify(snapshotCall?.[2])).not.toContain('mic-1')
  })

  it('stops polling when disabled', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    startRemoteAudioMonitor()
    stopRemoteAudioMonitor()
    await vi.advanceTimersByTimeAsync(2500)

    expect(isRemoteAudioMonitoring()).toBe(false)
  })
})
