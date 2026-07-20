import type {
  RemoteInputChannelMessage,
  RemoteInputTargetGeometry,
} from '@/services/remoteInputEvents'
import { parseRemoteInputChannelMessage } from '@/services/remoteInputEvents'
import {
  REMOTE_INPUT_CHANNEL_LABEL,
  type SignalingServerMessage,
} from '@/services/remoteSignalingProtocol'
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
  createLanGuestSignalingTransport,
  type RemoteSignalingDiagnostics,
  type RemoteSignalingTransport,
} from '@/services/remoteSignalingTransport'
import { getRemotePeerConnectionConfig } from '@/services/remoteIcePolicy'
import { deriveRemoteSecurityCode } from '@/services/remoteSecurityCode'
import { setRemoteWindowCaptureExclusion } from '@/services/remoteSessionService'
import { useRemoteSessionStore } from '@/store/remote-session-store'

export type RemoteGuestConnectionState =
  | 'idle'
  | 'joining'
  | 'pending_approval'
  | 'approved'
  | 'streaming'
  | 'control_ready'
  | 'control_unavailable'
  | 'rejected'
  | 'revoked'
  | 'error'

export interface RemoteGuestIdentity {
  displayName: string
  deviceId: string
}

export interface RemoteGuestLanJoinOptions {
  mode?: 'lan'
  host: string
  port: string
  sessionId: string
  token: string
  identity: RemoteGuestIdentity
}

export interface RemoteGuestCloudJoinOptions {
  mode: 'cloud'
  inviteId: string
  relayUrl: string
  token: string
  identity: RemoteGuestIdentity
  iceConfigEndpointUrl?: string
  forceRelay?: boolean
}

export type RemoteGuestJoinOptions =
  | RemoteGuestLanJoinOptions
  | RemoteGuestCloudJoinOptions

export interface RemoteGuestCallbacks {
  onStream: (stream: MediaStream) => void
  onState: (state: RemoteGuestConnectionState, message?: string) => void
  onError: (message: string) => void
  onErrorStatus?: (message: string) => void
  onSecurityCode?: (code: string | null) => void
  onLocalAudioStreamChange?: (stream: MediaStream | null) => void
  onRemoteAudioStream?: (stream: MediaStream) => void
}

interface GuestStopLocalAudioOptions {
  preserveMuted?: boolean
}

export const sameWifiUnavailableMessage =
  'Could not reach the host. Confirm both devices are on the same Wi-Fi, easyCris is open on the host, and Windows Firewall allows the connection.'

const updateWindowCaptureExclusion = (excluded: boolean) => {
  void Promise.resolve(setRemoteWindowCaptureExclusion(excluded)).catch(
    () => undefined
  )
}

export const remoteJoinRejectionMessage = (reason: string) => {
  if (
    reason.includes('Invalid remote-session token') ||
    reason.includes('Remote-session token has expired')
  ) {
    return 'Invite token is invalid or expired. Ask the host to copy a new invite.'
  }
  if (reason.includes('guest is already pending or approved')) {
    return 'Another guest is already pending or connected. Ask the host to reject or revoke that session first.'
  }
  return `Join rejected: ${reason}`
}

const REMOTE_APPROVAL_TIMEOUT_MS = 60_000
const REMOTE_VIDEO_OFFER_TIMEOUT_MS = 30_000

const remoteApprovalTimeoutMessage =
  'The host did not approve the remote session in time. Ask the host to try again.'
const remoteVideoOfferTimeoutMessage =
  'The host did not start the remote video in time. Ask the host to try again.'
const remoteControlPendingMessage =
  'Remote video is connected. Waiting for remote control channel.'
const remoteControlUnavailableMessage =
  'Remote control channel closed. Video may remain visible.'

const isActiveGuestState = (state: RemoteGuestConnectionState) =>
  state === 'joining' ||
  state === 'pending_approval' ||
  state === 'approved' ||
  state === 'streaming' ||
  state === 'control_ready' ||
  state === 'control_unavailable'

export const isMediaVisibleState = (state: RemoteGuestConnectionState) =>
  state === 'streaming' ||
  state === 'control_ready' ||
  state === 'control_unavailable'

export class RemoteWebRtcClientSession {
  private transport: RemoteSignalingTransport | null = null
  private transportConnected = false
  private peerConnection: RTCPeerConnection | null = null
  private dataChannel: RTCDataChannel | null = null
  private remoteStream: MediaStream | null = null
  private mediaStreaming = false
  private controlChannelOpen = false
  private localAudioStream: MediaStream | null = null
  private remoteAudioStream: MediaStream | null = null
  private audioSender: RTCRtpSender | null = null
  private audioInputDeviceId: string | null = null
  private audioEnableTask: Promise<void> | null = null
  private audioMuted = true
  private audioMuteGeneration = 0
  private audioStopGeneration = 0
  private pendingAudioState: Extract<
    RemoteInputChannelMessage,
    { type: 'audio_state' }
  > | null = null
  private audioStateSeq = 0
  private pendingAudioStateRetryTimer: number | null = null
  private sessionId: string | null = null
  private mode: 'lan' | 'cloud' = 'lan'
  private inviteId: string | null = null
  private guestToken: string | null = null
  private iceConfigEndpointUrl: string | undefined
  private forceRelay = false
  private guestDeviceId: string | null = null
  private callbacks: RemoteGuestCallbacks | null = null
  private callbackSubscriptions = new Set<RemoteGuestCallbacks>()
  private pendingIceCandidates: RTCIceCandidateInit[] = []
  private currentState: RemoteGuestConnectionState = 'idle'
  private currentMessage: string | null = null
  private targetGeometry: RemoteInputTargetGeometry | null = null
  private securityCode: string | null = null
  private sessionProgressTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalPeerTeardown = false
  private peerFailureReported = false

  attach(callbacks: RemoteGuestCallbacks) {
    this.callbacks = callbacks
    this.replayCallbacks(callbacks)
  }

  detach() {
    this.callbacks = null
  }

  subscribe(callbacks: RemoteGuestCallbacks) {
    this.callbackSubscriptions.add(callbacks)
    this.replayCallbacks(callbacks)
    return () => {
      this.callbackSubscriptions.delete(callbacks)
    }
  }

  async join(options: RemoteGuestJoinOptions) {
    this.close(false)
    this.intentionalPeerTeardown = false
    this.mode = options.mode ?? 'lan'
    this.sessionId =
      options.mode === 'cloud' ? options.inviteId : options.sessionId
    this.inviteId = options.mode === 'cloud' ? options.inviteId : null
    this.guestToken = options.token
    this.iceConfigEndpointUrl =
      options.mode === 'cloud' ? options.iceConfigEndpointUrl : undefined
    this.forceRelay =
      options.mode === 'cloud' ? options.forceRelay === true : false
    this.guestDeviceId = options.identity.deviceId
    this.emitState('joining')

    const transport =
      options.mode === 'cloud'
        ? createCloudSignalingTransport(
            options.relayUrl,
            options.inviteId,
            'Could not reach the cloud remote-session relay. Check your internet connection and ask the host for a new invite.'
          )
        : createLanGuestSignalingTransport(
            options.host,
            options.port,
            options.sessionId,
            sameWifiUnavailableMessage,
            options.token
          )
    this.transport = transport

    transport.onMessage(message => {
      void this.handleMessage(message).catch(error => {
        if (this.transport !== transport || this.isTerminalState()) return
        const reason = error instanceof Error ? error.message : String(error)
        this.emitState('error', reason)
        this.emitError(reason)
        this.close(false)
      })
    })
    transport.onError(error => {
      if (this.transport !== transport || !this.transportConnected) {
        return
      }
      if (isMediaVisibleState(this.currentState)) {
        console.warn(
          '[remote] signaling transport error after remote media became visible; keeping the WebRTC session alive',
          error
        )
        return
      }
      this.transportConnected = false
      if (this.isTerminalState()) return
      this.emitState('error', error.message)
      this.emitError(error.message)
    })
    transport.onClose(() => {
      if (this.transport !== transport) return
      if (isMediaVisibleState(this.currentState)) {
        console.warn(
          '[remote] signaling transport closed after remote media became visible; keeping the WebRTC session alive'
        )
        return
      }
      this.transportConnected = false
      if (this.isTerminalState()) return
      const message =
        this.mode === 'cloud'
          ? 'Lost connection to the cloud relay. Check your internet connection and ask the host for a new invite.'
          : sameWifiUnavailableMessage
      this.emitState('error', message)
    })

    await transport.connect().catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      this.emitState('error', message)
      this.close(false)
      throw error
    })

    this.transportConnected = true
    await transport.send(
      options.mode === 'cloud'
        ? {
            type: 'join_request',
            invite_id: options.inviteId,
            token: options.token,
            guest_display_name: options.identity.displayName,
            guest_device_id: options.identity.deviceId,
          }
        : {
            type: 'join_request',
            session_id: options.sessionId,
            token: options.token,
            guest_display_name: options.identity.displayName,
            guest_device_id: options.identity.deviceId,
          }
    )
    this.emitState('pending_approval')
    this.armSessionProgressTimeout(
      'pending_approval',
      REMOTE_APPROVAL_TIMEOUT_MS,
      remoteApprovalTimeoutMessage
    )
  }

  close(emitIdle = true) {
    this.clearSessionProgressTimer()
    this.dataChannel?.close()
    this.dataChannel = null
    this.controlChannelOpen = false
    this.peerConnection?.close()
    this.peerConnection = null
    this.audioSender = null
    this.audioInputDeviceId = null
    this.audioEnableTask = null
    this.audioMuted = true
    this.clearPendingAudioStateRetryTimer()
    stopRemoteAudioStream(this.localAudioStream)
    this.localAudioStream = null
    stopRemoteAudioStream(this.remoteAudioStream)
    this.remoteAudioStream = null
    this.remoteStream?.getTracks().forEach(track => track.stop())
    this.remoteStream = null
    this.mediaStreaming = false
    this.transport?.close()
    this.transport = null
    this.transportConnected = false
    this.sessionId = null
    this.mode = 'lan'
    this.inviteId = null
    this.guestToken = null
    this.iceConfigEndpointUrl = undefined
    this.forceRelay = false
    this.guestDeviceId = null
    this.pendingIceCandidates = []
    this.targetGeometry = null
    this.pendingAudioState = null
    this.audioStateSeq = 0
    this.securityCode = null
    this.intentionalPeerTeardown = false
    this.peerFailureReported = false
    updateWindowCaptureExclusion(false)
    if (emitIdle) {
      this.emitState('idle')
    }
  }

  sendInputMessage(message: RemoteInputChannelMessage) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Remote-session control channel is not open')
    }
    this.dataChannel.send(JSON.stringify(message))
  }

  getTargetGeometry() {
    return this.targetGeometry
  }

  getConnectionState() {
    return this.currentState
  }

  getConnectionMessage() {
    return this.currentMessage
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

  async getPeerConnectionStats() {
    if (!this.peerConnection) return []
    const report = await this.peerConnection.getStats()
    return [...report.values()]
  }

  getSecurityCode() {
    return this.securityCode
  }

  getAudioDiagnostics() {
    const [localAudioTrack] = this.localAudioStream?.getAudioTracks() ?? []
    const [remoteAudioTrack] = this.remoteAudioStream?.getAudioTracks() ?? []
    return {
      audioMuted: this.audioMuted,
      audioSenderCreated: this.audioSender !== null,
      audioSenderTrackAttached: this.audioSender?.track != null,
      audioInputDeviceId: this.audioInputDeviceId,
      ...remoteAudioProcessingDiagnostics(),
      localAudioCaptureSource: getRemoteAudioCaptureSource(
        this.localAudioStream
      ),
      localAudioTrackLive: localAudioTrack?.readyState === 'live',
      localAudioTrackEnabled: localAudioTrack?.enabled ?? null,
      localAudioTrackReadyState: localAudioTrack?.readyState ?? null,
      nextAudioStateSeq: this.audioStateSeq + 1,
      pendingAudioStateRetryScheduled:
        this.pendingAudioStateRetryTimer !== null,
      pendingAudioStateSeq: this.pendingAudioState?.seq ?? null,
      remoteAudioTrackLive: remoteAudioTrack?.readyState === 'live',
      remoteAudioTrackReadyState: remoteAudioTrack?.readyState ?? null,
    }
  }

  getInputContext() {
    if (!this.sessionId || !this.guestDeviceId) return null
    return {
      sessionId: this.sessionId,
      guestDeviceId: this.guestDeviceId,
    }
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
    this.stopLocalAudioStream({
      preserveMuted: true,
    })
    this.localAudioStream = stream
    this.emitLocalAudioStreamChange(stream)
    if (this.audioMuteGeneration === muteGeneration) {
      this.audioMuted = false
    }
    track.enabled = !this.audioMuted
    this.queueAudioStateUpdate()
  }

  setAudioMuted(muted: boolean) {
    this.audioMuteGeneration += 1
    this.audioMuted = muted
    for (const track of this.localAudioStream?.getAudioTracks() ?? []) {
      track.enabled = !muted
    }
    this.queueAudioStateUpdate()
  }

  async disableAudio() {
    this.audioStopGeneration += 1
    await this.detachAudioSenderTrack(this.audioSender)
    this.audioMuted = true
    this.stopLocalAudioStream({
      preserveMuted: true,
    })
    this.queueAudioStateUpdate()
  }

  async setAudioInputDevice(deviceId: string | null) {
    this.audioInputDeviceId = deviceId
    const sender = this.audioSender
    const previousStream = this.localAudioStream
    if (!previousStream || !sender) return
    const stream = await getRemoteMicrophoneStream(undefined, deviceId)
    if (
      this.audioSender !== sender ||
      this.localAudioStream !== previousStream
    ) {
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
    this.stopLocalAudioStream({
      preserveMuted: true,
    })
    this.localAudioStream = stream
    this.emitLocalAudioStreamChange(stream)
    this.queueAudioStateUpdate()
  }

  private async detachAudioSenderTrack(sender: RTCRtpSender | null) {
    await detachRemoteAudioSenderTrack(sender, 'guest')
  }

  private async handleMessage(message: SignalingServerMessage) {
    if (!this.transport) return

    if (message.type === 'join_approved') {
      useRemoteSessionStore
        .getState()
        .setGuestHostDeviceId(message.host_device_id ?? null)
      this.emitState('approved')
      this.armSessionProgressTimeout(
        'approved',
        REMOTE_VIDEO_OFFER_TIMEOUT_MS,
        remoteVideoOfferTimeoutMessage
      )
      return
    }

    if (message.type === 'join_rejected') {
      const reason = remoteJoinRejectionMessage(message.reason)
      this.emitState('rejected', reason)
      this.emitError(reason)
      this.close(false)
      return
    }

    if (message.type === 'video_offer') {
      this.clearSessionProgressTimer()
      await this.acceptOffer(message)
      return
    }

    if (message.type === 'ice_candidate') {
      await this.acceptIceCandidate(message.payload)
      return
    }

    if (message.type === 'session_revoked') {
      this.intentionalPeerTeardown = true
      this.emitState(
        'revoked',
        message.reason === 'ended'
          ? 'Host ended the remote session.'
          : 'Host revoked the remote session.'
      )
      this.close(false)
      return
    }

    if (message.type === 'host_disconnected') {
      const reason = 'Host disconnected from the remote session.'
      this.emitState('error', reason)
      this.emitError(reason)
      this.close(false)
      return
    }

    if (message.type === 'error') {
      const reason =
        message.reason ?? message.message ?? 'Remote session failed'
      this.emitState('error', reason)
      this.emitError(reason)
      this.close(false)
    }
  }

  private async acceptOffer(
    message: Extract<SignalingServerMessage, { type: 'video_offer' }>
  ) {
    const sessionId = this.requireSessionId()
    const guestDeviceId = this.requireGuestDeviceId()
    const transport = this.requireTransport()

    const peerConnectionConfig = await getRemotePeerConnectionConfig(
      this.peerConnectionConfigRequest()
    )
    if (this.transport !== transport || this.isTerminalState()) return

    const peerConnection = new RTCPeerConnection(peerConnectionConfig)
    this.peerConnection = peerConnection
    const remoteStream = new MediaStream()
    this.remoteStream = remoteStream
    const closeIfStale = () => {
      if (
        this.peerConnection === peerConnection &&
        this.transport === transport
      ) {
        return false
      }
      if (peerConnection.connectionState !== 'closed') {
        peerConnection.close()
      }
      return true
    }

    peerConnection.ontrack = event => {
      let addedVideoTrack = false
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        if (track.kind === 'audio') {
          const audioStream = new MediaStream([track])
          this.remoteAudioStream = audioStream
          this.emitRemoteAudioStream(audioStream)
          this.queueAudioStateUpdate()
          continue
        }
        remoteStream.addTrack(track)
        addedVideoTrack = true
      }
      if (addedVideoTrack) {
        this.mediaStreaming = true
        this.emitStream(remoteStream)
        this.emitState(
          this.controlChannelOpen ? 'control_ready' : 'streaming',
          this.controlChannelOpen ? undefined : remoteControlPendingMessage
        )
      }
    }

    peerConnection.ondatachannel = event => {
      if (event.channel.label !== REMOTE_INPUT_CHANNEL_LABEL) {
        event.channel.close()
        return
      }
      this.dataChannel = event.channel
      event.channel.onmessage = dataEvent => {
        this.handleDataChannelMessage(String(dataEvent.data))
      }
      const markControlChannelOpen = () => {
        if (this.dataChannel !== event.channel || this.controlChannelOpen) {
          return
        }
        this.controlChannelOpen = true
        this.flushPendingAudioState()
        if (this.mediaStreaming) {
          this.emitState('control_ready')
        }
      }
      event.channel.onopen = markControlChannelOpen
      event.channel.onclose = () => {
        if (this.dataChannel !== event.channel) return
        this.dataChannel = null
        this.controlChannelOpen = false
        if (isMediaVisibleState(this.currentState)) {
          this.emitState('control_unavailable', remoteControlUnavailableMessage)
        }
      }
      if (event.channel.readyState === 'open') {
        event.channel.onopen = null
        markControlChannelOpen()
      }
    }

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
      if (this.peerConnection !== peerConnection) {
        return
      }
      if (peerConnection.connectionState === 'connected') {
        this.peerFailureReported = false
      }
      if (peerConnection.connectionState === 'failed') {
        if (this.intentionalPeerTeardown && this.currentState === 'revoked') {
          return
        }
        if (this.peerFailureReported) {
          return
        }
        this.peerFailureReported = true
        const message =
          'WebRTC connection failed. Stay on the same Wi-Fi and ask the host to approve the session again.'
        this.emitState('error', message)
        this.emitError(message)
        this.stopLocalAudioStream()
        this.queueAudioStateUpdate()
      }
    }

    this.securityCode = deriveRemoteSecurityCode(message.payload)
    this.emitSecurityCode(this.securityCode)
    await peerConnection.setRemoteDescription(message.payload)
    if (closeIfStale()) return
    const transceivers = peerConnection.getTransceivers()
    const audioTransceiver =
      transceivers.find(
        transceiver => transceiver.receiver.track?.kind === 'audio'
      ) ??
      transceivers.find(
        transceiver =>
          transceiver.sender.track == null &&
          (transceiver.direction === 'sendrecv' ||
            transceiver.direction === 'recvonly')
      )
    if (audioTransceiver) {
      audioTransceiver.direction = 'sendrecv'
    }
    this.audioSender = audioTransceiver?.sender ?? null
    for (const candidate of this.pendingIceCandidates) {
      await peerConnection.addIceCandidate(candidate)
      if (closeIfStale()) return
    }
    this.pendingIceCandidates = []

    const answer = await peerConnection.createAnswer()
    if (closeIfStale()) return
    await peerConnection.setLocalDescription(answer)
    if (closeIfStale()) return
    await transport.send(
      this.mode === 'cloud'
        ? {
            type: 'video_answer',
            invite_id: this.requireInviteId(),
            guest_device_id: guestDeviceId,
            payload: answer,
          }
        : {
            type: 'video_answer',
            session_id: sessionId,
            guest_device_id: guestDeviceId,
            payload: answer,
          }
    )
  }

  private async acceptIceCandidate(candidate: RTCIceCandidateInit) {
    if (!candidate.candidate) return
    if (!this.peerConnection?.remoteDescription) {
      this.pendingIceCandidates.push(candidate)
      return
    }
    await this.peerConnection.addIceCandidate(candidate)
  }

  private handleDataChannelMessage(raw: string) {
    const message = parseRemoteInputChannelMessage(raw)
    if (message.type === 'target_geometry') {
      this.targetGeometry = message.rect
      return
    }
  }

  private requireSessionId() {
    if (!this.sessionId) {
      throw new Error('Remote-session guest is not connected')
    }
    return this.sessionId
  }

  private requireGuestDeviceId() {
    if (!this.guestDeviceId) {
      throw new Error('Remote-session guest identity is missing')
    }
    return this.guestDeviceId
  }

  private requireInviteId() {
    if (!this.inviteId) {
      throw new Error('Remote-session cloud invite is missing')
    }
    return this.inviteId
  }

  private requireGuestToken() {
    if (!this.guestToken) {
      throw new Error('Remote-session cloud token is missing')
    }
    return this.guestToken
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
        role: 'guest' as const,
        invite_id: this.requireInviteId(),
        guest_token: this.requireGuestToken(),
        guest_device_id: this.requireGuestDeviceId(),
      },
    }
  }

  private requireTransport() {
    if (!this.transport || !this.transportConnected) {
      throw new Error('Remote-session signaling socket is not open')
    }
    return this.transport
  }

  private emitStream(stream: MediaStream) {
    this.callbacks?.onStream(stream)
    this.callbackSubscriptions.forEach(callbacks => callbacks.onStream(stream))
  }

  private emitState(state: RemoteGuestConnectionState, message?: string) {
    if (state !== 'pending_approval' && state !== 'approved') {
      this.clearSessionProgressTimer()
    }
    this.currentState = state
    this.currentMessage = message ?? null
    updateWindowCaptureExclusion(isMediaVisibleState(state))
    useRemoteSessionStore.getState().setGuestMode(isActiveGuestState(state))
    this.callbacks?.onState(state, message)
    this.callbackSubscriptions.forEach(callbacks =>
      callbacks.onState(state, message)
    )
  }

  private armSessionProgressTimeout(
    state: Extract<RemoteGuestConnectionState, 'pending_approval' | 'approved'>,
    timeoutMs: number,
    message: string
  ) {
    this.clearSessionProgressTimer()
    this.sessionProgressTimer = setTimeout(() => {
      if (this.currentState !== state) return
      this.emitState('error', message)
      this.emitError(message)
      this.close(false)
    }, timeoutMs)
  }

  private clearSessionProgressTimer() {
    if (this.sessionProgressTimer === null) return
    clearTimeout(this.sessionProgressTimer)
    this.sessionProgressTimer = null
  }

  private emitError(message: string) {
    if (this.callbacks?.onError) {
      this.callbacks.onError(message)
      this.callbackSubscriptions.forEach(callbacks =>
        callbacks.onErrorStatus?.(message)
      )
      return
    }
    this.callbackSubscriptions.forEach(callbacks => callbacks.onError(message))
  }

  private emitSecurityCode(code: string | null) {
    this.callbacks?.onSecurityCode?.(code)
    this.callbackSubscriptions.forEach(callbacks =>
      callbacks.onSecurityCode?.(code)
    )
  }

  private emitRemoteAudioStream(stream: MediaStream) {
    this.callbacks?.onRemoteAudioStream?.(stream)
    this.callbackSubscriptions.forEach(callbacks =>
      callbacks.onRemoteAudioStream?.(stream)
    )
  }

  private emitLocalAudioStreamChange(stream: MediaStream | null) {
    this.callbacks?.onLocalAudioStreamChange?.(stream)
    this.callbackSubscriptions.forEach(callbacks =>
      callbacks.onLocalAudioStreamChange?.(stream)
    )
  }

  private replayCallbacks(callbacks: RemoteGuestCallbacks) {
    callbacks.onState(this.currentState, this.currentMessage ?? undefined)
    callbacks.onSecurityCode?.(this.securityCode)
    callbacks.onLocalAudioStreamChange?.(this.localAudioStream)
    if (this.remoteStream) {
      callbacks.onStream(this.remoteStream)
    }
    if (this.remoteAudioStream) {
      callbacks.onRemoteAudioStream?.(this.remoteAudioStream)
    }
  }

  private stopLocalAudioStream(options: GuestStopLocalAudioOptions = {}) {
    const previousStream = this.localAudioStream
    stopRemoteAudioStream(this.localAudioStream)
    this.localAudioStream = null
    if (previousStream) {
      this.emitLocalAudioStreamChange(null)
    }
    if (!options.preserveMuted) {
      this.audioMuted = true
    }
  }

  private queueAudioStateUpdate() {
    this.pendingAudioState = {
      type: 'audio_state',
      seq: ++this.audioStateSeq,
      sending: this.localAudioStream !== null && !this.audioMuted,
      receiving:
        this.remoteAudioStream
          ?.getAudioTracks()
          .some(track => track.readyState === 'live') ?? false,
      muted: this.audioMuted,
    }
    this.flushPendingAudioState()
  }

  private flushPendingAudioState() {
    if (!this.pendingAudioState) return
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') return
    const message = this.pendingAudioState
    this.pendingAudioState = null
    try {
      this.dataChannel.send(JSON.stringify(message))
      this.clearPendingAudioStateRetryTimer()
    } catch (error) {
      console.warn('[remote] audio_state send failed; will retry', error)
      this.pendingAudioState = message
      this.schedulePendingAudioStateRetry()
    }
  }

  private schedulePendingAudioStateRetry() {
    if (this.pendingAudioStateRetryTimer !== null) return
    this.pendingAudioStateRetryTimer = window.setTimeout(() => {
      this.pendingAudioStateRetryTimer = null
      this.flushPendingAudioState()
    }, 250)
  }

  private clearPendingAudioStateRetryTimer() {
    if (this.pendingAudioStateRetryTimer === null) return
    window.clearTimeout(this.pendingAudioStateRetryTimer)
    this.pendingAudioStateRetryTimer = null
  }

  private isTerminalState() {
    return (
      this.currentState === 'revoked' ||
      this.currentState === 'rejected' ||
      this.currentState === 'error'
    )
  }
}

export const remoteWebRtcClient = new RemoteWebRtcClientSession()
