import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import { useRemoteAudioInputDevices } from '@/components/remote/useRemoteAudioInputDevices'
import { useRemoteAudioControls } from '@/components/remote/useRemoteAudioControls'
import { useMicLevel } from '@/components/remote/useMicLevel'
import { remoteAudioErrorMessage } from '@/services/remoteAudioMedia'
import {
  REMOTE_HOST_CONTROLS_COMMAND_EVENT,
  type RemoteHostControlsCommand,
} from '@/services/remoteHostControlsWindow'
import {
  getRemoteHostControlsServiceSnapshot,
  restoreRemoteHostControlsForSession,
  subscribeRemoteHostControlsServiceState,
  teardownRemoteHostControlsWindows,
  updateRemoteHostControlsAudioSnapshot,
} from '@/services/remoteHostControlsService'
import { remoteWebRtcHost } from '@/services/remoteWebRtcHost'
import { formatRemoteSessionRemaining } from '@/services/remoteSessionFormatting'
import type { RemoteSessionLimitEvent } from '@/services/remoteSessionService'
import { useRemoteSessionStore } from '@/store/remote-session-store'

export function RemoteSessionBanner() {
  const status = useRemoteSessionStore(state => state.status)
  const approvedGuest = useRemoteSessionStore(state => state.approvedGuest)
  const sessionWarning = useRemoteSessionStore(state => state.sessionWarning)
  const idleWarning = useRemoteSessionStore(state => state.idleWarning)
  const audioState = useRemoteSessionStore(state => state.audioState)
  const setAudioState = useRemoteSessionStore(state => state.setAudioState)
  const revoke = useRemoteSessionStore(state => state.revoke)
  const [now, setNow] = useState(() => Date.now())
  const [localAudioStream, setLocalAudioStream] = useState<MediaStream | null>(
    null
  )
  const expiringSessions = useRef(new Set<string>())

  const currentSession = status?.current_session

  const {
    audioInputDevices,
    refreshAudioInputDevices,
    selectedAudioInputDeviceId,
    setSelectedAudioInputDeviceId,
  } = useRemoteAudioInputDevices()

  const {
    attachRemoteAudioStream,
    handleEnableAudio: handleEnableHostAudio,
    handleStopAudio: handleStopHostAudio,
    handleToggleAudioMute: handleToggleHostAudioMute,
    remoteAudioRef: hostRemoteAudioRef,
    remotePlaybackVolume,
    setRemotePlaybackVolume,
  } = useRemoteAudioControls({
    audioState,
    disableAudio: () => remoteWebRtcHost.disableAudio(),
    enableAudio: async () => {
      await remoteWebRtcHost.enableAudio()
      await refreshAudioInputDevices()
    },
    setAudioMuted: muted => remoteWebRtcHost.setAudioMuted(muted),
    setAudioState,
    setAutoplayMessage: message => toast.info(message),
    setMessage: message => toast.error(message),
  })
  const micLevel = useMicLevel(
    localAudioStream,
    audioState.localEnabled && !audioState.localMuted
  )
  // The host controls live in a separate Tauri window. Sync only the visible
  // meter buckets so analyser ticks do not flood the IPC channel.
  const hostControlsMicLevel = useMemo(() => {
    if (!audioState.localEnabled || audioState.localMuted || micLevel <= 0) {
      return 0
    }
    if (micLevel >= 0.9) return 0.9
    if (micLevel >= 0.65) return 0.65
    return 0.35
  }, [audioState.localEnabled, audioState.localMuted, micLevel])

  const handleHostAudioInputChange = useCallback(
    async (deviceId: string) => {
      setSelectedAudioInputDeviceId(deviceId)
      try {
        await remoteWebRtcHost.setAudioInputDevice(deviceId || null)
      } catch (error) {
        toast.error(remoteAudioErrorMessage(error, 'microphone'))
      }
    },
    [setSelectedAudioInputDeviceId]
  )

  useEffect(() => {
    const unsubscribe = remoteWebRtcHost.subscribe({
      onLocalAudioStreamChange: setLocalAudioStream,
      onRemoteAudioStream: attachRemoteAudioStream,
    })
    return unsubscribe
  }, [attachRemoteAudioStream])

  const expireSession = useCallback(
    (sessionId: string, reason: 'timeout' | 'idle') => {
      if (expiringSessions.current.has(sessionId)) return
      const state = useRemoteSessionStore.getState()
      const current = state.status?.current_session
      if (current?.session_id !== sessionId) return
      expiringSessions.current.add(sessionId)
      void (async () => {
        if (current.mode === 'cloud') {
          await remoteWebRtcHost.close(true, 'ended').catch(() => undefined)
          await useRemoteSessionStore.getState().revoke('ended')
        } else {
          await useRemoteSessionStore.getState().revoke('ended')
          await remoteWebRtcHost.close(false).catch(() => undefined)
        }
      })()
        .then(() => {
          const latest = useRemoteSessionStore.getState()
          latest.setSessionWarning(null)
          latest.setIdleWarning(null)
          toast.warning(
            reason === 'idle'
              ? 'Remote session ended after 10 minutes of inactivity.'
              : 'Remote session expired.'
          )
        })
        .catch(error => {
          const latest = useRemoteSessionStore.getState()
          latest.setSessionWarning(null)
          latest.setIdleWarning(null)
          toast.error(error instanceof Error ? error.message : String(error))
        })
    },
    []
  )

  useEffect(() => {
    let disposed = false
    const unlisteners: (() => void)[] = []
    const register = async () => {
      const warningUnlisten = await listen<RemoteSessionLimitEvent>(
        'remote-session-warning',
        event => {
          const current =
            useRemoteSessionStore.getState().status?.current_session
          if (current?.session_id !== event.payload.session_id) return
          const expiresAt = Date.now() + event.payload.seconds_remaining * 1000
          useRemoteSessionStore.getState().setSessionWarning({
            ...event.payload,
            expires_at_unix_ms: expiresAt,
          })
          toast.warning(
            `Remote session expires in ${formatRemoteSessionRemaining(
              event.payload.seconds_remaining
            )}.`
          )
        }
      )
      if (disposed) {
        warningUnlisten()
      } else {
        unlisteners.push(warningUnlisten)
      }

      const expiredUnlisten = await listen<RemoteSessionLimitEvent>(
        'remote-session-expired',
        event => {
          expireSession(event.payload.session_id, 'timeout')
        }
      )
      if (disposed) {
        expiredUnlisten()
      } else {
        unlisteners.push(expiredUnlisten)
      }
    }
    void register()
    return () => {
      disposed = true
      unlisteners.forEach(unlisten => unlisten())
    }
  }, [expireSession])

  const sessionWarningMatches =
    sessionWarning && currentSession?.session_id === sessionWarning.session_id
      ? sessionWarning
      : null
  const idleWarningMatches =
    idleWarning && currentSession?.session_id === idleWarning.session_id
      ? idleWarning
      : null
  const activeWarning = useMemo(() => {
    if (sessionWarningMatches && idleWarningMatches) {
      return idleWarningMatches.expires_at_unix_ms <
        sessionWarningMatches.expires_at_unix_ms
        ? { kind: 'idle' as const, warning: idleWarningMatches }
        : { kind: 'timeout' as const, warning: sessionWarningMatches }
    }
    if (idleWarningMatches) {
      return { kind: 'idle' as const, warning: idleWarningMatches }
    }
    if (sessionWarningMatches) {
      return { kind: 'timeout' as const, warning: sessionWarningMatches }
    }
    return null
  }, [idleWarningMatches, sessionWarningMatches])
  const secondsRemaining = activeWarning
    ? (activeWarning.warning.expires_at_unix_ms - now) / 1000
    : null
  useEffect(() => {
    if (!activeWarning) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [activeWarning])

  useEffect(() => {
    if (!activeWarning || secondsRemaining === null || secondsRemaining > 0) {
      return
    }
    expireSession(activeWarning.warning.session_id, activeWarning.kind)
  }, [activeWarning, expireSession, secondsRemaining])

  const handleRevoke = useCallback(async () => {
    const latestSession =
      useRemoteSessionStore.getState().status?.current_session
    if (!latestSession) return
    try {
      if (latestSession.mode === 'cloud') {
        await remoteWebRtcHost.close(true, 'ended').catch(() => undefined)
        await revoke('ended')
      } else {
        await revoke('ended')
        await remoteWebRtcHost.close(false).catch(() => undefined)
      }
      await teardownRemoteHostControlsWindows()
      toast.success('Remote session ended')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }, [revoke])

  const hostControlsServiceSnapshot = useSyncExternalStore(
    subscribeRemoteHostControlsServiceState,
    getRemoteHostControlsServiceSnapshot,
    getRemoteHostControlsServiceSnapshot
  )
  const hostControlsUnavailable =
    hostControlsServiceSnapshot.hostControlsUnavailable

  useEffect(() => {
    updateRemoteHostControlsAudioSnapshot({
      audioInputDevices,
      micLevel: hostControlsMicLevel,
      playbackVolume: remotePlaybackVolume,
      selectedAudioInputDeviceId,
    })
  }, [
    audioInputDevices,
    hostControlsMicLevel,
    remotePlaybackVolume,
    selectedAudioInputDeviceId,
  ])

  const handleHostControlsCommand = useCallback(
    async (command: RemoteHostControlsCommand) => {
      if (command.type === 'request-state') {
        // request-state is handled by the Tauri event listener below; this
        // branch keeps direct callers from treating it as an action command.
        return
      }
      switch (command.type) {
        case 'enable-audio':
          await handleEnableHostAudio()
          break
        case 'hidden':
          break
        case 'revoke':
          await handleRevoke()
          break
        case 'set-device':
          await handleHostAudioInputChange(command.deviceId)
          break
        case 'set-volume':
          setRemotePlaybackVolume(command.volume)
          break
        case 'stop-audio':
          await handleStopHostAudio()
          break
        case 'toggle-mute':
          await handleToggleHostAudioMute()
          break
        default:
          break
      }
    },
    [
      handleEnableHostAudio,
      handleHostAudioInputChange,
      handleRevoke,
      handleStopHostAudio,
      handleToggleHostAudioMute,
      setRemotePlaybackVolume,
    ]
  )

  const hostControlsSuppressed =
    import.meta.env.MODE === 'e2e' &&
    window.__E2E_REMOTE_HOST_CONTROLS_SUPPRESSED__ === true
  const hostControlsCommandRef = useRef<
    ((command: RemoteHostControlsCommand) => Promise<void>) | null
  >(null)

  useEffect(() => {
    hostControlsCommandRef.current = handleHostControlsCommand
  }, [handleHostControlsCommand])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    const register = async () => {
      unlisten = await listen<RemoteHostControlsCommand>(
        REMOTE_HOST_CONTROLS_COMMAND_EVENT,
        event => {
          if (event.payload.type === 'request-state') {
            return
          }
          void hostControlsCommandRef.current?.(event.payload)
        }
      )
      if (disposed) {
        unlisten()
      }
    }
    void register()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  if (!currentSession || !approvedGuest) {
    return null
  }

  return (
    <div data-testid="remote-host-banner-controller">
      <audio
        className="sr-only"
        ref={hostRemoteAudioRef}
        autoPlay
        data-testid="remote-host-audio-output"
      />
      {hostControlsUnavailable && !hostControlsSuppressed ? (
        <div
          className="fixed right-4 top-4 z-50 flex max-w-[min(520px,calc(100vw-2rem))] items-center gap-3 rounded-md border border-border bg-background px-3 py-2 text-sm shadow-lg"
          data-testid="remote-host-controls-fallback"
        >
          <span className="min-w-0 flex-1 truncate font-medium">
            Remote session active · {approvedGuest.guest_display_name}
          </span>
          <button
            type="button"
            className="rounded-md border border-input px-3 py-1.5 text-xs font-semibold hover:bg-accent"
            onClick={() => {
              void restoreRemoteHostControlsForSession().catch(error => {
                toast.error(
                  error instanceof Error ? error.message : String(error)
                )
              })
            }}
            data-testid="remote-host-controls-restore"
          >
            Restore controls
          </button>
          <button
            type="button"
            className="rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90"
            onClick={() => void handleRevoke()}
            data-testid="remote-host-controls-fallback-end"
          >
            End
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default RemoteSessionBanner
