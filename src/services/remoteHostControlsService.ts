import { listen } from '@tauri-apps/api/event'
import { logger } from '@/lib/logger'
import type { RemoteAudioInputDevice } from '@/services/remoteAudioMedia'
import {
  REMOTE_HOST_CONTROLS_COMMAND_EVENT,
  destroyRemoteHostIdentityLabelWindow,
  destroyRemoteHostControlsWindow,
  hideRemoteHostIdentityLabelWindow,
  hideRemoteHostControlsWindow,
  openRemoteHostIdentityLabelWindow,
  openRemoteHostControlsWindow,
  syncRemoteHostIdentityLabelState,
  syncRemoteHostControlsState,
  type RemoteHostControlsCommand,
  type RemoteHostControlsState,
} from '@/services/remoteHostControlsWindow'
import { remoteWebRtcHost } from '@/services/remoteWebRtcHost'
import { formatRemoteSessionRemaining } from '@/services/remoteSessionFormatting'
import {
  type RemoteSessionAudioState,
  type RemoteSessionLimitWarning,
  useRemoteSessionStore,
} from '@/store/remote-session-store'

export interface RemoteHostControlsAudioSnapshot {
  audioInputDevices: RemoteAudioInputDevice[]
  micLevel: number
  playbackVolume: number
  selectedAudioInputDeviceId: string
}

export interface RemoteHostControlsServiceSnapshot {
  hostControlsUnavailable: boolean
}

const defaultAudioSnapshot: RemoteHostControlsAudioSnapshot = {
  audioInputDevices: [],
  micLevel: 0,
  playbackVolume: 1,
  selectedAudioInputDeviceId: '',
}

const inactiveHostControlsState: RemoteHostControlsState = {
  active: false,
  audioInputDevices: [],
  audioLabel: 'Audio off',
  audioState: {
    connecting: false,
    localEnabled: false,
    localMuted: false,
    remotePlaybackEnabled: false,
  },
  guestDeviceId: '',
  guestDisplayName: '',
  identityLabelVisible: false,
  micLevel: 0,
  playbackVolume: 1,
  securityCode: null,
  selectedAudioInputDeviceId: '',
  warningText: null,
}

let latestAudioSnapshot = defaultAudioSnapshot
let hostSecurityCode: string | null = null
let activeSessionId: string | null = null
let hiddenSessionId: string | null = null
let identityLabelVisible = true
let hostControlsWindowOpened = false
let warningTimer: number | null = null
let lifecycleRunning = false
let lifecycleRerunRequested = false
let initializedCleanup: (() => void) | null = null
let serviceSnapshot: RemoteHostControlsServiceSnapshot = {
  hostControlsUnavailable: false,
}
const serviceListeners = new Set<() => void>()

const audioLabelFromState = (audioState: RemoteSessionAudioState) =>
  audioState.connecting
    ? 'Connecting audio'
    : audioState.localEnabled
      ? audioState.localMuted
        ? 'Muted'
        : 'Audio on'
      : 'Audio off'

const matchingWarning = (
  warning: RemoteSessionLimitWarning | null,
  sessionId: string | null | undefined
) => (warning?.session_id === sessionId ? warning : null)

const warningTextFromStore = () => {
  const state = useRemoteSessionStore.getState()
  const sessionId = state.status?.current_session?.session_id
  const sessionWarning = matchingWarning(state.sessionWarning, sessionId)
  const idleWarning = matchingWarning(state.idleWarning, sessionId)
  const activeWarning =
    sessionWarning && idleWarning
      ? idleWarning.expires_at_unix_ms < sessionWarning.expires_at_unix_ms
        ? { kind: 'idle' as const, warning: idleWarning }
        : { kind: 'timeout' as const, warning: sessionWarning }
      : idleWarning
        ? { kind: 'idle' as const, warning: idleWarning }
        : sessionWarning
          ? { kind: 'timeout' as const, warning: sessionWarning }
          : null

  if (!activeWarning) return null
  const secondsRemaining =
    (activeWarning.warning.expires_at_unix_ms - Date.now()) / 1000
  return `${activeWarning.kind === 'idle' ? 'Idle timeout in' : 'Expires in'} ${formatRemoteSessionRemaining(
    secondsRemaining
  )}`
}

const hostControlsSuppressed = () =>
  import.meta.env.MODE === 'e2e' &&
  window.__E2E_REMOTE_HOST_CONTROLS_SUPPRESSED__ === true

const setServiceSnapshot = (
  next: Partial<RemoteHostControlsServiceSnapshot>
) => {
  const updated = { ...serviceSnapshot, ...next }
  if (
    updated.hostControlsUnavailable === serviceSnapshot.hostControlsUnavailable
  ) {
    return
  }
  serviceSnapshot = updated
  serviceListeners.forEach(listener => listener())
}

const buildActiveHostControlsState = (): RemoteHostControlsState | null => {
  const state = useRemoteSessionStore.getState()
  const currentSession = state.status?.current_session
  const approvedGuest = state.approvedGuest
  if (
    !currentSession ||
    !approvedGuest ||
    !hostSecurityCode ||
    hostControlsSuppressed()
  ) {
    return null
  }

  return {
    active: true,
    audioInputDevices: latestAudioSnapshot.audioInputDevices,
    audioLabel: audioLabelFromState(state.audioState),
    audioState: state.audioState,
    guestDeviceId: approvedGuest.guest_device_id,
    guestDisplayName: approvedGuest.guest_display_name,
    identityLabelVisible,
    micLevel: latestAudioSnapshot.micLevel,
    playbackVolume: latestAudioSnapshot.playbackVolume,
    securityCode: hostSecurityCode,
    selectedAudioInputDeviceId: latestAudioSnapshot.selectedAudioInputDeviceId,
    warningText: warningTextFromStore(),
  }
}

const stopWarningTimer = () => {
  if (warningTimer === null) return
  window.clearInterval(warningTimer)
  warningTimer = null
}

const syncActiveHostControlsState = async () => {
  const state = buildActiveHostControlsState()
  if (!state) return
  await syncRemoteHostControlsState(state)
  if (!state.identityLabelVisible) {
    await hideRemoteHostIdentityLabelWindow()
    return
  }
  await openRemoteHostIdentityLabelWindow()
  await syncRemoteHostIdentityLabelState(state)
}

const ensureWarningTimer = () => {
  const state = useRemoteSessionStore.getState()
  const sessionId = state.status?.current_session?.session_id
  const hasWarning = Boolean(
    matchingWarning(state.sessionWarning, sessionId) ||
      matchingWarning(state.idleWarning, sessionId)
  )
  if (!hasWarning || !activeSessionId) {
    stopWarningTimer()
    return
  }
  if (warningTimer !== null) return
  warningTimer = window.setInterval(() => {
    void syncActiveHostControlsState().catch(error => {
      logger.warn('Failed to sync remote host controls warning state', {
        error,
      })
    })
  }, 1000)
}

export const teardownRemoteHostControlsWindows = async () => {
  activeSessionId = null
  hiddenSessionId = null
  setServiceSnapshot({ hostControlsUnavailable: false })
  stopWarningTimer()
  try {
    await syncRemoteHostControlsState(inactiveHostControlsState)
  } catch (error) {
    logger.warn('Failed to sync inactive remote host controls state', {
      error,
    })
  }
  try {
    await destroyRemoteHostControlsWindow()
    hostControlsWindowOpened = false
  } catch (error) {
    logger.warn('Failed to destroy remote host controls window', { error })
  }
  try {
    await destroyRemoteHostIdentityLabelWindow()
  } catch (error) {
    logger.warn('Failed to destroy remote host identity label window', {
      error,
    })
  }
}

const evaluateHostControlsLifecycle = async () => {
  const state = buildActiveHostControlsState()
  if (!state) {
    if (
      activeSessionId !== null ||
      hiddenSessionId !== null ||
      hostControlsWindowOpened
    ) {
      await teardownRemoteHostControlsWindows()
    }
    return
  }

  const sessionId =
    useRemoteSessionStore.getState().status?.current_session?.session_id ?? null
  if (!sessionId) return

  if (activeSessionId !== sessionId) {
    activeSessionId = sessionId
    hiddenSessionId = null
    identityLabelVisible = true
    setServiceSnapshot({ hostControlsUnavailable: false })
  }

  ensureWarningTimer()
  if (hiddenSessionId === sessionId) {
    await hideRemoteHostIdentityLabelWindow()
    return
  }
  await openRemoteHostControlsWindow()
  hostControlsWindowOpened = true
  const latestSessionId =
    useRemoteSessionStore.getState().status?.current_session?.session_id ?? null
  if (
    latestSessionId !== sessionId ||
    activeSessionId !== sessionId ||
    hiddenSessionId === sessionId
  ) {
    return
  }
  const latestState = buildActiveHostControlsState()
  if (!latestState) return
  await syncRemoteHostControlsState(latestState)
  if (latestState.identityLabelVisible) {
    await openRemoteHostIdentityLabelWindow()
    await syncRemoteHostIdentityLabelState(latestState)
  } else {
    await hideRemoteHostIdentityLabelWindow()
  }
}

const requestHostControlsLifecycleEvaluation = () => {
  if (lifecycleRunning) {
    lifecycleRerunRequested = true
    return
  }

  lifecycleRunning = true
  void (async () => {
    try {
      do {
        lifecycleRerunRequested = false
        try {
          await evaluateHostControlsLifecycle()
        } catch (error) {
          logger.warn('Failed to evaluate remote host controls lifecycle', {
            error,
          })
        }
      } while (lifecycleRerunRequested)
    } finally {
      lifecycleRunning = false
      if (lifecycleRerunRequested) {
        requestHostControlsLifecycleEvaluation()
      }
    }
  })()
}

const handleHostControlsServiceCommand = async (
  command: RemoteHostControlsCommand
) => {
  if (command.type === 'request-state') {
    await syncActiveHostControlsState()
    return
  }
  if (command.type === 'toggle-identity-label') {
    identityLabelVisible = !identityLabelVisible
    const state = buildActiveHostControlsState()
    if (!state) return
    await syncRemoteHostControlsState(state)
    if (state.identityLabelVisible) {
      await openRemoteHostIdentityLabelWindow()
      await syncRemoteHostIdentityLabelState(state)
    } else {
      await hideRemoteHostIdentityLabelWindow()
    }
    return
  }
  if (command.type !== 'hidden') return

  const sessionId = activeSessionId
  if (!sessionId) return
  if (hiddenSessionId === sessionId) return
  hiddenSessionId = sessionId
  setServiceSnapshot({ hostControlsUnavailable: true })
  await hideRemoteHostIdentityLabelWindow().catch(error => {
    logger.warn('Failed to hide remote host identity label window', { error })
  })
  await hideRemoteHostControlsWindow().catch(error => {
    logger.warn('Failed to hide remote host controls window', { error })
    if (hiddenSessionId === sessionId) {
      hiddenSessionId = null
      setServiceSnapshot({ hostControlsUnavailable: false })
    }
  })
}

export const initRemoteHostControlsService = () => {
  if (initializedCleanup) return initializedCleanup

  let disposed = false
  let commandUnlisten: (() => void) | null = null
  const unsubscribeStore = useRemoteSessionStore.subscribe(() => {
    requestHostControlsLifecycleEvaluation()
  })
  const unsubscribeHost = remoteWebRtcHost.subscribe({
    onSecurityCode: code => {
      hostSecurityCode = code
      requestHostControlsLifecycleEvaluation()
    },
  })

  void listen<RemoteHostControlsCommand>(
    REMOTE_HOST_CONTROLS_COMMAND_EVENT,
    event => {
      void handleHostControlsServiceCommand(event.payload).catch(
        () => undefined
      )
    }
  ).then(unlisten => {
    if (disposed) {
      unlisten()
      return
    }
    commandUnlisten = unlisten
  })

  requestHostControlsLifecycleEvaluation()

  initializedCleanup = () => {
    disposed = true
    unsubscribeStore()
    unsubscribeHost()
    commandUnlisten?.()
    stopWarningTimer()
    lifecycleRunning = false
    lifecycleRerunRequested = false
    initializedCleanup = null
  }
  return initializedCleanup
}

export const updateRemoteHostControlsAudioSnapshot = (
  snapshot: RemoteHostControlsAudioSnapshot
) => {
  latestAudioSnapshot = snapshot
  void syncActiveHostControlsState().catch(error => {
    logger.warn('Failed to sync remote host controls audio state', { error })
  })
}

export const restoreRemoteHostControlsForSession = async () => {
  hiddenSessionId = null
  setServiceSnapshot({ hostControlsUnavailable: false })
  await openRemoteHostControlsWindow()
  hostControlsWindowOpened = true
  await syncActiveHostControlsState()
}

export const getRemoteHostControlsServiceSnapshot = () => serviceSnapshot

export const subscribeRemoteHostControlsServiceState = (
  listener: () => void
) => {
  serviceListeners.add(listener)
  return () => serviceListeners.delete(listener)
}

export const resetRemoteHostControlsServiceForTests = () => {
  initializedCleanup?.()
  latestAudioSnapshot = defaultAudioSnapshot
  hostSecurityCode = null
  activeSessionId = null
  hiddenSessionId = null
  identityLabelVisible = true
  hostControlsWindowOpened = false
  lifecycleRunning = false
  lifecycleRerunRequested = false
  serviceSnapshot = { hostControlsUnavailable: false }
  serviceListeners.clear()
  stopWarningTimer()
}
