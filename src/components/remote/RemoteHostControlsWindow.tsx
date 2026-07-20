import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { FrameCorners } from '@phosphor-icons/react'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Button } from '@/components/ui/button'
import { RemoteAudioControlsUI } from '@/components/remote/RemoteAudioControlsUI'
import { RemoteControlsPanel } from '@/components/remote/RemoteControlsPanel'
import { logger } from '@/lib/logger'
import {
  REMOTE_HOST_CONTROLS_COLLAPSED_HEIGHT,
  REMOTE_HOST_CONTROLS_COMMAND_EVENT,
  REMOTE_HOST_CONTROLS_EXPANDED_HEIGHT,
  REMOTE_HOST_CONTROLS_STATE_EVENT,
  REMOTE_HOST_CONTROLS_WINDOW_WIDTH,
  type RemoteHostControlsCommand,
  type RemoteHostControlsState,
} from '@/services/remoteHostControlsWindow'
import { setRemoteWindowCaptureExclusion } from '@/services/remoteSessionService'

const sendCommand = (command: RemoteHostControlsCommand) =>
  emit(REMOTE_HOST_CONTROLS_COMMAND_EVENT, command)

const REMOTE_HOST_AUDIO_PANEL_RESIZE_MARGIN = 12

const hideControlsWindow = async () => {
  try {
    await sendCommand({ type: 'hidden' })
  } catch (error) {
    logger.warn('Failed to notify main window that host controls were hidden', {
      error,
    })
    return
  }
  await getCurrentWebviewWindow()
    .hide()
    .catch(error => {
      logger.warn('Failed to hide remote host controls window', { error })
    })
}

export function RemoteHostControlsWindow() {
  const [state, setState] = useState<RemoteHostControlsState | null>(null)
  const [audioOptionsOpen, setAudioOptionsOpen] = useState(false)
  const showedActiveWindowRef = useRef(false)
  const audioOptionsVisible =
    audioOptionsOpen && Boolean(state?.audioState.localEnabled)
  const audioInputDeviceCount = state?.audioInputDevices.length ?? 0

  useEffect(() => {
    void setRemoteWindowCaptureExclusion(true).catch(() => undefined)
    const controlsWindow = getCurrentWebviewWindow()
    let disposed = false
    let unlisten: (() => void) | null = null
    let unlistenCloseRequested: (() => void) | null = null
    let unlistenFocusChanged: (() => void) | null = null
    let focusCloseTimer: number | null = null
    const clearFocusCloseTimer = () => {
      if (focusCloseTimer === null) return
      window.clearTimeout(focusCloseTimer)
      focusCloseTimer = null
    }

    const register = async () => {
      unlistenCloseRequested = await controlsWindow.onCloseRequested(event => {
        event.preventDefault()
        void hideControlsWindow()
      })
      unlistenFocusChanged = await controlsWindow.onFocusChanged(event => {
        if (event.payload) {
          clearFocusCloseTimer()
          return
        }
        clearFocusCloseTimer()
        focusCloseTimer = window.setTimeout(() => {
          focusCloseTimer = null
          if (!document.hasFocus()) {
            setAudioOptionsOpen(false)
          }
        }, 150)
      })
      unlisten = await listen<RemoteHostControlsState>(
        REMOTE_HOST_CONTROLS_STATE_EVENT,
        event => {
          if (!disposed) {
            if (!event.payload.audioState.localEnabled) {
              clearFocusCloseTimer()
              setAudioOptionsOpen(false)
            }
            setState(event.payload)
          }
        }
      )
      if (!disposed) {
        void sendCommand({ type: 'request-state' })
      }
    }

    void register()
    return () => {
      disposed = true
      unlisten?.()
      unlistenCloseRequested?.()
      unlistenFocusChanged?.()
      clearFocusCloseTimer()
      void setRemoteWindowCaptureExclusion(false).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    if (!state || state.active) return
    showedActiveWindowRef.current = false
    // Defensive fallback for stale/inactive payloads; normal session teardown
    // destroys the auxiliary window before rendering an inactive state.
    void getCurrentWebviewWindow()
      .destroy()
      .catch(() => undefined)
  }, [state])

  useEffect(() => {
    if (!state?.active || showedActiveWindowRef.current) return
    showedActiveWindowRef.current = true
    void getCurrentWebviewWindow()
      .show()
      .catch(error => {
        logger.warn('Failed to show remote host controls window', { error })
      })
  }, [state?.active])

  useLayoutEffect(() => {
    if (!state?.active) return
    let height = audioOptionsVisible
      ? REMOTE_HOST_CONTROLS_EXPANDED_HEIGHT
      : REMOTE_HOST_CONTROLS_COLLAPSED_HEIGHT
    if (audioOptionsVisible) {
      const panel = document.getElementById('remote-host-audio-options')
      const measuredBottom = panel?.getBoundingClientRect().bottom
      if (measuredBottom && Number.isFinite(measuredBottom)) {
        height = Math.max(
          height,
          Math.ceil(measuredBottom + REMOTE_HOST_AUDIO_PANEL_RESIZE_MARGIN)
        )
      }
    }
    void getCurrentWebviewWindow()
      .setSize(new LogicalSize(REMOTE_HOST_CONTROLS_WINDOW_WIDTH, height))
      .catch(error => {
        logger.warn('Failed to resize remote host controls window', { error })
      })
  }, [audioInputDeviceCount, audioOptionsVisible, state?.active])

  const handleDragStart = useCallback(
    (_event: ReactPointerEvent<HTMLElement>) => {
      void getCurrentWebviewWindow()
        .startDragging()
        .catch(() => undefined)
    },
    []
  )

  if (!state?.active) {
    return <div className="hidden" data-testid="remote-host-controls-window" />
  }

  return (
    <main
      className="h-screen bg-background text-foreground"
      data-testid="remote-host-controls-window"
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
                state.identityLabelVisible
                  ? 'Hide remote identity label'
                  : 'Show remote identity label'
              }
              title={
                state.identityLabelVisible
                  ? 'Hide remote identity label'
                  : 'Show remote identity label'
              }
              onClick={() =>
                void sendCommand({ type: 'toggle-identity-label' })
              }
              data-testid="remote-host-identity-toggle"
            >
              <FrameCorners size={16} weight="bold" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="h-9 shrink-0 px-3"
              onClick={() => void sendCommand({ type: 'revoke' })}
              data-testid="remote-revoke-control"
            >
              End
            </Button>
          </>
        }
        audioControls={
          <RemoteAudioControlsUI
            audioInputDevices={state.audioInputDevices}
            audioLabel={state.audioLabel}
            audioState={state.audioState}
            microphoneLabel="Host microphone"
            micLevel={state.micLevel}
            onDeviceChange={deviceId =>
              void sendCommand({ type: 'set-device', deviceId })
            }
            onEnable={() => void sendCommand({ type: 'enable-audio' })}
            onMute={() => void sendCommand({ type: 'toggle-mute' })}
            onOptionsOpenChange={setAudioOptionsOpen}
            onPlaybackVolumeChange={volume =>
              void sendCommand({ type: 'set-volume', volume })
            }
            onStop={() => void sendCommand({ type: 'stop-audio' })}
            optionsOpen={audioOptionsVisible}
            playbackVolume={state.playbackVolume}
            selectedDeviceId={state.selectedAudioInputDeviceId}
            testIdPrefix="remote-host"
          />
        }
        className="w-full items-start rounded-none border-0 shadow-none"
        dragLabel="Drag remote controls"
        onDragStart={handleDragStart}
        showLiveBadge
        testIdPrefix="remote-host"
        testId="remote-host-controls-panel"
        title="Remote controls"
        warningText={state.warningText}
      />
    </main>
  )
}

export default RemoteHostControlsWindow
