import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { FrameCorners } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { logRuntimeDebug } from '@/lib/debug/runtimeDebug'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RemoteAudioControlsUI } from '@/components/remote/RemoteAudioControlsUI'
import { RemoteControlsPanel } from '@/components/remote/RemoteControlsPanel'
import { RemoteIdentityLabel } from '@/components/remote/RemoteIdentityLabel'
import { useRemoteAudioInputDevices } from '@/components/remote/useRemoteAudioInputDevices'
import { useRemoteAudioControls } from '@/components/remote/useRemoteAudioControls'
import { useMicLevel } from '@/components/remote/useMicLevel'
import { remoteAudioErrorMessage } from '@/services/remoteAudioMedia'
import {
  modifiersFromEvent,
  normalizeVideoPointer,
  remoteKeyFromEvent,
  remoteMouseButtonFromEvent,
  type RemoteInputMouseEventPayload,
  type RemoteMouseAction,
} from '@/services/remoteInputEvents'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  isMediaVisibleState,
  remoteWebRtcClient,
  type RemoteGuestConnectionState,
} from '@/services/remoteWebRtcClient'
import { useRemoteSessionStore } from '@/store/remote-session-store'
import { useUIStore } from '@/store/ui-store'

export function RemoteGuestViewerOverlay() {
  const suppressGuestViewer = useRemoteSessionStore(
    state => state.isHost || state.isBusy
  )
  const hostIdentity = useRemoteSessionStore(state => {
    const session = state.status?.current_session
    const hostDeviceId =
      session?.host_device_id?.trim() || state.guestHostDeviceId?.trim()
    return hostDeviceId ? `host ${hostDeviceId}` : 'host'
  })
  const [connectionState, setConnectionState] =
    useState<RemoteGuestConnectionState>('idle')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [localAudioStream, setLocalAudioStream] = useState<MediaStream | null>(
    null
  )
  const [audioState, setAudioState] = useState({
    localEnabled: false,
    localMuted: false,
    remotePlaybackEnabled: false,
    connecting: false,
  })
  const [audioOptionsOpen, setAudioOptionsOpen] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const pendingMouseMoveRef = useRef<RemoteInputMouseEventPayload | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const activePointerButtonRef = useRef<number | null>(null)
  const [panelPos, setPanelPos] = useState<{ x: number; y: number } | null>(
    null
  )
  const [labelPos, setLabelPos] = useState<{ x: number; y: number } | null>(
    null
  )
  const [identityLabelVisible, setIdentityLabelVisible] = useState(true)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const labelRef = useRef<HTMLDivElement | null>(null)
  const dragOriginRef = useRef<{
    target: 'controls' | 'label'
    startX: number
    startY: number
    elementX: number
    elementY: number
  } | null>(null)
  const lastPointerPointRef = useRef<RemoteInputMouseEventPayload | null>(null)
  // subscribe() replays idle on mount; only clear viewer/audio state after a session has streamed.
  const streamedOnceRef = useRef(false)

  const {
    audioInputDevices,
    refreshAudioInputDevices,
    selectedAudioInputDeviceId,
    setSelectedAudioInputDeviceId,
  } = useRemoteAudioInputDevices()

  const {
    attachRemoteAudioStream,
    audioLabel,
    clearRemoteAudioStream,
    handleEnableAudio,
    handleStopAudio,
    handleToggleAudioMute,
    remoteAudioRef,
    remotePlaybackVolume,
    setRemotePlaybackVolume,
  } = useRemoteAudioControls({
    audioState,
    disableAudio: () => remoteWebRtcClient.disableAudio(),
    enableAudio: async () => {
      await remoteWebRtcClient.enableAudio()
      await refreshAudioInputDevices()
    },
    setAudioMuted: muted => remoteWebRtcClient.setAudioMuted(muted),
    setAudioState: patch =>
      setAudioState(state => ({
        ...state,
        ...patch,
      })),
    setAutoplayMessage: message => toast.info(message),
    setMessage: setStatusMessage,
  })
  const micLevel = useMicLevel(
    localAudioStream,
    audioState.localEnabled && !audioState.localMuted
  )
  const audioOptionsVisible = audioOptionsOpen && audioState.localEnabled

  useEffect(() => {
    if (typeof remoteWebRtcClient.getAudioDiagnostics !== 'function') return
    const diagnostics = remoteWebRtcClient.getAudioDiagnostics()
    if (!diagnostics.audioSenderCreated) return
    setAudioState(state => ({
      ...state,
      connecting: false,
      localEnabled: diagnostics.localAudioTrackLive,
      localMuted: diagnostics.audioMuted,
    }))
    if (typeof diagnostics.audioInputDeviceId === 'string') {
      setSelectedAudioInputDeviceId(diagnostics.audioInputDeviceId)
    }
  }, [setSelectedAudioInputDeviceId])

  useEffect(() => {
    const unsubscribe = remoteWebRtcClient.subscribe({
      onStream: stream => {
        setRemoteStream(stream)
      },
      onLocalAudioStreamChange: setLocalAudioStream,
      onRemoteAudioStream: attachRemoteAudioStream,
      onState: (state, message) => {
        setConnectionState(state)
        setStatusMessage(message ?? null)
        if (isMediaVisibleState(state)) {
          streamedOnceRef.current = true
          useUIStore.getState().setPreferencesOpen(false)
          return
        }
        if (videoRef.current) {
          videoRef.current.srcObject = null
        }
        setRemoteStream(null)
        if (
          state === 'approved' ||
          (state === 'idle' && streamedOnceRef.current) ||
          state === 'rejected' ||
          state === 'revoked' ||
          state === 'error'
        ) {
          streamedOnceRef.current = false
          setLocalAudioStream(null)
          setAudioState({
            localEnabled: false,
            localMuted: false,
            remotePlaybackEnabled: false,
            connecting: false,
          })
          setAudioOptionsOpen(false)
          clearRemoteAudioStream()
        }
      },
      onError: message => {
        setStatusMessage(message)
        toast.error(message)
      },
      onErrorStatus: setStatusMessage,
    })
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
      unsubscribe()
    }
  }, [attachRemoteAudioStream, clearRemoteAudioStream])

  useEffect(() => {
    if (!videoRef.current) return
    videoRef.current.srcObject = remoteStream
  }, [connectionState, remoteStream])

  const handleDisconnect = () => {
    remoteWebRtcClient.close()
  }

  const fitGuestWindowToStreamAspect = useCallback(
    async (videoWidth: number, videoHeight: number) => {
      const aspectRatio = videoWidth / videoHeight
      if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return
      try {
        const appWindow = getCurrentWindow()
        const cssWidth = Math.round(window.innerWidth)
        const cssHeight = Math.round(window.innerHeight)
        let width = cssWidth
        let height = Math.round(width / aspectRatio)
        if (height > cssHeight) {
          height = cssHeight
          width = Math.round(height * aspectRatio)
        }
        if (
          width <= 0 ||
          height <= 0 ||
          (Math.abs(width - cssWidth) <= 1 && Math.abs(height - cssHeight) <= 1)
        ) {
          return
        }
        await appWindow.setSize(new LogicalSize(width, height))
      } catch {
        // Keep the in-window aspect fit even when the OS window cannot be resized.
      }
    },
    []
  )

  const applyVideoMetadata = useCallback(() => {
    const video = videoRef.current
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return false
    }
    void fitGuestWindowToStreamAspect(video.videoWidth, video.videoHeight)
    return true
  }, [fitGuestWindowToStreamAspect])

  useEffect(() => {
    if (!remoteStream) return
    let cancelled = false
    let frameId: number | null = null
    let attempts = 0
    const syncMetadata = () => {
      if (cancelled || applyVideoMetadata()) return
      attempts += 1
      if (attempts < 60) {
        frameId = window.requestAnimationFrame(syncMetadata)
        return
      }
      console.warn('Timed out waiting for remote stream metadata.')
    }
    frameId = window.requestAnimationFrame(syncMetadata)
    return () => {
      cancelled = true
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
      }
    }
  }, [applyVideoMetadata, remoteStream])

  const handleAudioInputChange = async (deviceId: string) => {
    setSelectedAudioInputDeviceId(deviceId)
    try {
      await remoteWebRtcClient.setAudioInputDevice(deviceId || null)
    } catch (error) {
      setStatusMessage(remoteAudioErrorMessage(error, 'microphone'))
    }
  }

  const videoPointFromPointer = useCallback(
    (event: ReactPointerEvent<HTMLVideoElement>) => {
      const video = videoRef.current
      if (!video) return null
      return normalizeVideoPointer({
        clientX: event.clientX,
        clientY: event.clientY,
        rect: video.getBoundingClientRect(),
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        objectFit: 'cover',
      })
    },
    []
  )

  const sendMousePayload = useCallback(
    (event: RemoteInputMouseEventPayload) => {
      if (connectionState !== 'control_ready' && event.action !== 'up') {
        logRuntimeDebug('remote-input', 'guest_mouse_send_skipped', {
          action: event.action,
          button: event.button,
          connectionState,
          reason: 'not_control_ready',
        })
        return
      }
      if (event.action !== 'move') {
        logRuntimeDebug('remote-input', 'guest_mouse_send', {
          action: event.action,
          button: event.button,
          connectionState,
          normalizedX: event.normalized_x,
          normalizedY: event.normalized_y,
        })
      }
      remoteWebRtcClient.sendInputMessage({ type: 'mouse', event })
    },
    [connectionState]
  )

  const mousePayloadFromPointer = useCallback(
    (
      event: ReactPointerEvent<HTMLVideoElement>,
      action: RemoteMouseAction
    ): RemoteInputMouseEventPayload | null => {
      const context = remoteWebRtcClient.getInputContext()
      const point = videoPointFromPointer(event)
      if (!context || !point) {
        if (action !== 'move') {
          logRuntimeDebug('remote-input', 'guest_mouse_payload_missing', {
            action,
            activeButton: activePointerButtonRef.current,
            hasContext: Boolean(context),
            hasPoint: Boolean(point),
            rawButton: event.button,
          })
        }
        return null
      }
      const eventButton =
        action === 'up' && event.button < 0
          ? activePointerButtonRef.current
          : event.button
      const button =
        eventButton === null ? null : remoteMouseButtonFromEvent(eventButton)
      if (
        (action === 'down' || action === 'up' || action === 'click') &&
        !button
      ) {
        logRuntimeDebug('remote-input', 'guest_mouse_button_missing', {
          action,
          activeButton: activePointerButtonRef.current,
          rawButton: event.button,
          resolvedButton: eventButton,
        })
        return null
      }
      if (action !== 'move') {
        logRuntimeDebug('remote-input', 'guest_mouse_payload', {
          action,
          activeButton: activePointerButtonRef.current,
          button,
          rawButton: event.button,
          resolvedButton: eventButton,
          normalizedX: point.normalized_x,
          normalizedY: point.normalized_y,
        })
      }
      return {
        session_id: context.sessionId,
        guest_device_id: context.guestDeviceId,
        ...point,
        action,
        button: action === 'move' ? null : button,
        modifiers: modifiersFromEvent(event.nativeEvent),
      }
    },
    [videoPointFromPointer]
  )

  const releaseActivePointer = useCallback(() => {
    const button = activePointerButtonRef.current
    const point = lastPointerPointRef.current
    if (button === null || !point) {
      logRuntimeDebug('remote-input', 'guest_release_skipped', {
        activeButton: button,
        hasLastPoint: Boolean(point),
      })
      return
    }
    const remoteButton = remoteMouseButtonFromEvent(button)
    if (!remoteButton) {
      logRuntimeDebug('remote-input', 'guest_release_button_missing', {
        activeButton: button,
      })
      return
    }
    try {
      logRuntimeDebug('remote-input', 'guest_release_synthetic_up', {
        activeButton: button,
        button: remoteButton,
        normalizedX: point.normalized_x,
        normalizedY: point.normalized_y,
      })
      sendMousePayload({
        ...point,
        action: 'up',
        button: remoteButton,
      })
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error))
    } finally {
      activePointerButtonRef.current = null
    }
  }, [sendMousePayload])

  useEffect(() => {
    if (connectionState !== 'control_ready') {
      releaseActivePointer()
    }
  }, [connectionState, releaseActivePointer])

  const sendMouseInput = useCallback(
    (event: ReactPointerEvent<HTMLVideoElement>, action: RemoteMouseAction) => {
      if (connectionState !== 'control_ready') {
        if (action !== 'move') {
          logRuntimeDebug('remote-input', 'guest_mouse_input_blocked', {
            action,
            connectionState,
            rawButton: event.button,
          })
        }
        return false
      }
      const payload = mousePayloadFromPointer(event, action)
      if (!payload) {
        if (action !== 'move') {
          logRuntimeDebug('remote-input', 'guest_mouse_input_no_payload', {
            action,
            rawButton: event.button,
          })
        }
        return false
      }
      lastPointerPointRef.current = payload
      try {
        sendMousePayload(payload)
        return true
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error))
        return false
      }
    },
    [connectionState, mousePayloadFromPointer, sendMousePayload]
  )

  const queueMouseMove = useCallback(
    (event: ReactPointerEvent<HTMLVideoElement>) => {
      if (connectionState !== 'control_ready') return
      const payload = mousePayloadFromPointer(event, 'move')
      if (!payload) return
      lastPointerPointRef.current = payload
      pendingMouseMoveRef.current = payload
      if (animationFrameRef.current !== null) return
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = null
        const nextPayload = pendingMouseMoveRef.current
        pendingMouseMoveRef.current = null
        if (!nextPayload) return
        if (remoteWebRtcClient.getConnectionState() !== 'control_ready') return
        try {
          sendMousePayload(nextPayload)
        } catch (error) {
          setStatusMessage(
            error instanceof Error ? error.message : String(error)
          )
        }
      })
    },
    [connectionState, mousePayloadFromPointer, sendMousePayload]
  )

  const sendWheelInput = useCallback(
    (event: ReactWheelEvent<HTMLVideoElement>) => {
      if (connectionState !== 'control_ready') return
      const context = remoteWebRtcClient.getInputContext()
      const video = videoRef.current
      if (!context || !video) return
      const point = normalizeVideoPointer({
        clientX: event.clientX,
        clientY: event.clientY,
        rect: video.getBoundingClientRect(),
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        objectFit: 'cover',
      })
      if (!point) return
      event.preventDefault()
      try {
        remoteWebRtcClient.sendInputMessage({
          type: 'mouse',
          event: {
            session_id: context.sessionId,
            guest_device_id: context.guestDeviceId,
            ...point,
            action: 'wheel',
            button: null,
            modifiers: modifiersFromEvent(event.nativeEvent),
            wheel_delta_x: event.deltaX,
            wheel_delta_y: event.deltaY,
          },
        })
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error))
      }
    },
    [connectionState]
  )

  const sendKeyInput = useCallback(
    (event: ReactKeyboardEvent<HTMLVideoElement>) => {
      if (connectionState !== 'control_ready' || event.repeat) return
      if (audioOptionsVisible && event.key === 'Escape') {
        event.preventDefault()
        return
      }
      const context = remoteWebRtcClient.getInputContext()
      const key = remoteKeyFromEvent(event.nativeEvent)
      if (!context || !key) return
      event.preventDefault()
      try {
        remoteWebRtcClient.sendInputMessage({
          type: 'key',
          event: {
            session_id: context.sessionId,
            guest_device_id: context.guestDeviceId,
            key,
            action: 'click',
            modifiers: modifiersFromEvent(event.nativeEvent),
          },
        })
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error))
      }
    },
    [audioOptionsVisible, connectionState]
  )

  const handleFloatingDragStart = useCallback(
    (event: ReactPointerEvent<HTMLElement>, target: 'controls' | 'label') => {
      if (event.button !== 0) return
      event.preventDefault()
      const element =
        target === 'controls' ? panelRef.current : labelRef.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      dragOriginRef.current = {
        target,
        startX: event.clientX,
        startY: event.clientY,
        elementX: rect.left,
        elementY: rect.top,
      }
    },
    []
  )
  const handlePanelDragStart = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      handleFloatingDragStart(event, 'controls')
    },
    [handleFloatingDragStart]
  )
  const handleLabelDragStart = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      handleFloatingDragStart(event, 'label')
    },
    [handleFloatingDragStart]
  )

  const handleWindowPointerMove = useCallback((event: PointerEvent) => {
    const origin = dragOriginRef.current
    const element =
      origin?.target === 'controls' ? panelRef.current : labelRef.current
    if (!origin || !element) return
    const dx = event.clientX - origin.startX
    const dy = event.clientY - origin.startY
    const rawX = origin.elementX + dx
    const rawY = origin.elementY + dy
    const maxX = Math.max(0, window.innerWidth - element.offsetWidth)
    const maxY = Math.max(0, window.innerHeight - element.offsetHeight)
    const x = Math.min(Math.max(rawX, 0), maxX)
    const y = Math.min(Math.max(rawY, 0), maxY)
    if (origin.target === 'controls') {
      setPanelPos({ x, y })
    } else {
      setLabelPos({ x, y })
    }
  }, [])

  const handleWindowPointerUp = useCallback(() => {
    dragOriginRef.current = null
  }, [])

  useEffect(() => {
    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', handleWindowPointerUp)
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerUp)
    }
  }, [handleWindowPointerMove, handleWindowPointerUp])

  const showStatusOnNarrowViewports = connectionState === 'control_unavailable'
  // When control is live, the crosshair distinguishes the pointer we're driving
  // on the remote machine from the host's own cursor baked into the stream.
  const controlActive = connectionState === 'control_ready'

  if (suppressGuestViewer || !isMediaVisibleState(connectionState)) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-background"
      data-testid="remote-guest-viewer-overlay"
    >
      <div
        ref={panelRef}
        className="pointer-events-none absolute z-10"
        style={
          panelPos
            ? { left: panelPos.x, top: panelPos.y }
            : { left: '50%', top: '0.75rem', transform: 'translateX(-50%)' }
        }
        data-testid="remote-guest-controls-wrapper"
      >
        <RemoteControlsPanel
          actions={
            <>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-9 w-9 shrink-0"
                aria-label={
                  identityLabelVisible
                    ? 'Hide remote identity label'
                    : 'Show remote identity label'
                }
                title={
                  identityLabelVisible
                    ? 'Hide remote identity label'
                    : 'Show remote identity label'
                }
                onClick={() => setIdentityLabelVisible(visible => !visible)}
                data-testid="remote-guest-identity-toggle"
              >
                <FrameCorners size={16} weight="bold" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="h-9 shrink-0 px-3"
                onClick={handleDisconnect}
                data-testid="remote-guest-disconnect"
              >
                End
              </Button>
            </>
          }
          audioControls={
            <RemoteAudioControlsUI
              audioInputDevices={audioInputDevices}
              audioLabel={audioLabel}
              audioState={audioState}
              microphoneLabel="Guest microphone"
              onDeviceChange={deviceId => void handleAudioInputChange(deviceId)}
              onEnable={() => void handleEnableAudio()}
              onMute={() => void handleToggleAudioMute()}
              onOptionsOpenChange={setAudioOptionsOpen}
              onPlaybackVolumeChange={setRemotePlaybackVolume}
              onStop={() => void handleStopAudio()}
              optionsOpen={audioOptionsVisible}
              playbackVolume={remotePlaybackVolume}
              micLevel={micLevel}
              selectedDeviceId={selectedAudioInputDeviceId}
              testIdPrefix="remote-guest"
            />
          }
          alwaysShowStatus={showStatusOnNarrowViewports}
          className="pointer-events-auto w-full max-w-5xl rounded-lg"
          dragLabel="Drag to reposition controls"
          onDragStart={handlePanelDragStart}
          showLiveBadge
          statusText={statusMessage}
          testIdPrefix="remote-guest"
          testId="remote-guest-controls-panel"
          title="Remote control bar"
        />
      </div>

      {identityLabelVisible ? (
        <div
          ref={labelRef}
          className={cn(
            'pointer-events-none absolute z-10',
            labelPos ? null : 'bottom-4 left-1/2 -translate-x-1/2'
          )}
          style={labelPos ? { left: labelPos.x, top: labelPos.y } : undefined}
          data-testid="remote-guest-identity-label-wrapper"
        >
          <RemoteIdentityLabel
            className="pointer-events-none max-w-md select-none"
            description={`You are controlling ${hostIdentity} easyCris`}
            dragHandleProps={{
              className: 'pointer-events-auto cursor-move',
              'data-testid': 'remote-guest-identity-label-drag',
              onPointerDown: handleLabelDragStart,
              title: 'Drag identity label',
            }}
            testId="remote-guest-identity-label"
          />
        </div>
      ) : null}

      <div
        className="absolute inset-0 min-h-0 overflow-hidden bg-background"
        data-testid="remote-viewer-shell"
      >
        <div data-testid="remote-stream-frame" className="h-full w-full">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            tabIndex={0}
            onPointerMove={queueMouseMove}
            onPointerDown={event => {
              event.currentTarget.focus()
              event.currentTarget.setPointerCapture(event.pointerId)
              activePointerButtonRef.current = sendMouseInput(event, 'down')
                ? event.button
                : null
            }}
            onPointerUp={event => {
              if (
                activePointerButtonRef.current !== null &&
                !sendMouseInput(event, 'up')
              ) {
                releaseActivePointer()
              }
              activePointerButtonRef.current = null
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
            }}
            // Release is idempotent; browsers report lost presses through
            // different terminal events, and the host must never keep a button down.
            onPointerCancel={event => {
              releaseActivePointer()
              activePointerButtonRef.current = null
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
            }}
            onLostPointerCapture={releaseActivePointer}
            onPointerLeave={releaseActivePointer}
            onBlur={releaseActivePointer}
            onContextMenu={event => event.preventDefault()}
            onLoadedMetadata={applyVideoMetadata}
            onWheel={sendWheelInput}
            onKeyDown={sendKeyInput}
            data-testid="remote-stream-video"
            className={cn(
              'h-full w-full bg-background object-cover outline-none focus-visible:ring-2 focus-visible:ring-primary',
              controlActive && 'cursor-crosshair'
            )}
          />
          <audio
            ref={remoteAudioRef}
            autoPlay
            data-testid="remote-guest-audio-output"
            className="sr-only"
          />
        </div>
      </div>
    </div>
  )
}

export default RemoteGuestViewerOverlay
