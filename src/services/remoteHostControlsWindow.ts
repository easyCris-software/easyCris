import { emitTo } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { currentMonitor, primaryMonitor } from '@tauri-apps/api/window'
import { logger } from '@/lib/logger'
import type { RemoteAudioInputDevice } from '@/services/remoteAudioMedia'
import type { RemoteSessionAudioState } from '@/store/remote-session-store'

export const REMOTE_HOST_CONTROLS_WINDOW_LABEL = 'remote-host-controls'
export const REMOTE_HOST_IDENTITY_LABEL_WINDOW_LABEL =
  'remote-host-identity-label'
// The route segment must match the window label so App.tsx can render the
// host-controls UI when this WebviewWindow opens its URL.
export const REMOTE_HOST_CONTROLS_WINDOW_PATH = `/${REMOTE_HOST_CONTROLS_WINDOW_LABEL}`
export const REMOTE_HOST_IDENTITY_LABEL_WINDOW_PATH = `/${REMOTE_HOST_IDENTITY_LABEL_WINDOW_LABEL}`
export const REMOTE_HOST_CONTROLS_STATE_EVENT = 'remote-host-controls:state'
export const REMOTE_HOST_CONTROLS_COMMAND_EVENT = 'remote-host-controls:command'
export const REMOTE_HOST_CONTROLS_WINDOW_WIDTH = 420
export const REMOTE_HOST_CONTROLS_COLLAPSED_HEIGHT = 58
export const REMOTE_HOST_CONTROLS_EXPANDED_HEIGHT = 360

const REMOTE_HOST_CONTROLS_TOP_MARGIN = 12
const REMOTE_HOST_IDENTITY_LABEL_WIDTH = 400
const REMOTE_HOST_IDENTITY_LABEL_HEIGHT = 48
const REMOTE_HOST_IDENTITY_LABEL_BOTTOM_MARGIN = 24
const REMOTE_HOST_WINDOW_CREATED_TIMEOUT_MS = 1500

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max))

export interface RemoteHostControlsState {
  active: boolean
  audioInputDevices: RemoteAudioInputDevice[]
  audioLabel: string
  audioState: RemoteSessionAudioState
  guestDeviceId: string
  guestDisplayName: string
  identityLabelVisible: boolean
  micLevel: number
  playbackVolume: number
  securityCode: string | null
  selectedAudioInputDeviceId: string
  warningText: string | null
}

export type RemoteHostControlsCommand =
  | { type: 'enable-audio' }
  | { type: 'hidden' }
  | { type: 'revoke' }
  | { type: 'request-state' }
  | { type: 'set-device'; deviceId: string }
  | { type: 'set-volume'; volume: number }
  | { type: 'stop-audio' }
  | { type: 'toggle-identity-label' }
  | { type: 'toggle-mute' }

const getPlacementWorkArea = async () => {
  const monitor = (await currentMonitor()) ?? (await primaryMonitor())
  if (!monitor) return null
  const workArea = monitor.workArea ?? {
    position: monitor.position,
    size: monitor.size,
  }
  const scaleFactor = monitor.scaleFactor || 1
  return { scaleFactor, workArea }
}

const positionRemoteHostControlsWindow = async (window: WebviewWindow) => {
  const placement = await getPlacementWorkArea()
  if (!placement) return
  const { scaleFactor, workArea } = placement
  const controlsWidth = REMOTE_HOST_CONTROLS_WINDOW_WIDTH * scaleFactor
  const controlsHeight = REMOTE_HOST_CONTROLS_COLLAPSED_HEIGHT * scaleFactor
  const minX = workArea.position.x
  const maxX = workArea.position.x + workArea.size.width - controlsWidth
  const minY = workArea.position.y
  const maxY = workArea.position.y + workArea.size.height - controlsHeight
  const x = Math.round(
    workArea.position.x + (workArea.size.width - controlsWidth) / 2
  )
  const y = Math.round(
    workArea.position.y + REMOTE_HOST_CONTROLS_TOP_MARGIN * scaleFactor
  )
  await window.setPosition(
    new PhysicalPosition(clamp(x, minX, maxX), clamp(y, minY, maxY))
  )
}

const positionRemoteHostIdentityLabelWindow = async (window: WebviewWindow) => {
  const placement = await getPlacementWorkArea()
  if (!placement) return
  const { scaleFactor, workArea } = placement
  const labelWidth = REMOTE_HOST_IDENTITY_LABEL_WIDTH * scaleFactor
  const labelHeight = REMOTE_HOST_IDENTITY_LABEL_HEIGHT * scaleFactor
  const minX = workArea.position.x
  const maxX = workArea.position.x + workArea.size.width - labelWidth
  const minY = workArea.position.y
  const maxY = workArea.position.y + workArea.size.height - labelHeight
  const x = Math.round(
    workArea.position.x + (workArea.size.width - labelWidth) / 2
  )
  const y = Math.round(
    workArea.position.y +
      workArea.size.height -
      labelHeight -
      REMOTE_HOST_IDENTITY_LABEL_BOTTOM_MARGIN * scaleFactor
  )
  await window.setPosition(
    new PhysicalPosition(clamp(x, minX, maxX), clamp(y, minY, maxY))
  )
}

const waitForWebviewWindowCreated = async (window: WebviewWindow) =>
  new Promise<void>((resolve, reject) => {
    let settled = false
    let unlistenCreated: (() => void) | null = null
    let unlistenError: (() => void) | null = null
    const timeoutId = globalThis.setTimeout(
      () => settle(resolve),
      REMOTE_HOST_WINDOW_CREATED_TIMEOUT_MS
    )

    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      globalThis.clearTimeout(timeoutId)
      unlistenCreated?.()
      unlistenError?.()
      callback()
    }

    void window
      .once('tauri://created', () => settle(resolve))
      .then(unlisten => {
        if (settled) {
          unlisten()
          return
        }
        unlistenCreated = unlisten
      })
      .catch(error => settle(() => reject(error)))

    void window
      .once('tauri://error', event =>
        settle(() => reject(new Error(String(event.payload))))
      )
      .then(unlisten => {
        if (settled) {
          unlisten()
          return
        }
        unlistenError = unlisten
      })
      .catch(error => settle(() => reject(error)))
  })

const applyWebviewChromePolicy = async (label: string) => {
  try {
    await invoke('apply_webview_chrome_policy', { label })
  } catch (error) {
    logger.warn(`Failed to apply webview chrome policy for ${label}`, {
      error,
    })
  }
}

const tryPositionWebviewWindow = async (
  label: string,
  position: () => Promise<void>
) => {
  try {
    await position()
  } catch (error) {
    logger.warn(`Failed to position ${label}`, { error })
  }
}

export const openRemoteHostControlsWindow = async () => {
  const existing = await WebviewWindow.getByLabel(
    REMOTE_HOST_CONTROLS_WINDOW_LABEL
  )
  if (existing) {
    await existing.show()
    return existing
  }

  const window = new WebviewWindow(REMOTE_HOST_CONTROLS_WINDOW_LABEL, {
    alwaysOnTop: true,
    decorations: false,
    height: REMOTE_HOST_CONTROLS_COLLAPSED_HEIGHT,
    minHeight: REMOTE_HOST_CONTROLS_COLLAPSED_HEIGHT,
    minWidth: REMOTE_HOST_CONTROLS_WINDOW_WIDTH,
    resizable: false,
    title: 'easyCris Remote Controls',
    url: REMOTE_HOST_CONTROLS_WINDOW_PATH,
    visible: false,
    width: REMOTE_HOST_CONTROLS_WINDOW_WIDTH,
  })
  await waitForWebviewWindowCreated(window)
  await applyWebviewChromePolicy(REMOTE_HOST_CONTROLS_WINDOW_LABEL)
  await tryPositionWebviewWindow(REMOTE_HOST_CONTROLS_WINDOW_LABEL, () =>
    positionRemoteHostControlsWindow(window)
  )
  await window.show()
  return window
}

export const openRemoteHostIdentityLabelWindow = async () => {
  const existing = await WebviewWindow.getByLabel(
    REMOTE_HOST_IDENTITY_LABEL_WINDOW_LABEL
  )
  if (existing) {
    await existing.show()
    return existing
  }

  const window = new WebviewWindow(REMOTE_HOST_IDENTITY_LABEL_WINDOW_LABEL, {
    alwaysOnTop: true,
    decorations: false,
    focus: false,
    focusable: true,
    height: REMOTE_HOST_IDENTITY_LABEL_HEIGHT,
    minHeight: REMOTE_HOST_IDENTITY_LABEL_HEIGHT,
    minWidth: REMOTE_HOST_IDENTITY_LABEL_WIDTH,
    resizable: false,
    skipTaskbar: true,
    title: 'easyCris Remote Identity',
    url: REMOTE_HOST_IDENTITY_LABEL_WINDOW_PATH,
    visible: false,
    width: REMOTE_HOST_IDENTITY_LABEL_WIDTH,
  })
  await waitForWebviewWindowCreated(window)
  await applyWebviewChromePolicy(REMOTE_HOST_IDENTITY_LABEL_WINDOW_LABEL)
  await tryPositionWebviewWindow(REMOTE_HOST_IDENTITY_LABEL_WINDOW_LABEL, () =>
    positionRemoteHostIdentityLabelWindow(window)
  )
  await window.show()
  return window
}

export const closeRemoteHostControlsWindow = async () => {
  await hideRemoteHostControlsWindow()
}

export const hideRemoteHostControlsWindow = async () => {
  const existing = await WebviewWindow.getByLabel(
    REMOTE_HOST_CONTROLS_WINDOW_LABEL
  )
  await existing?.hide()
}

export const hideRemoteHostIdentityLabelWindow = async () => {
  const existing = await WebviewWindow.getByLabel(
    REMOTE_HOST_IDENTITY_LABEL_WINDOW_LABEL
  )
  await existing?.hide()
}

export const destroyRemoteHostControlsWindow = async () => {
  const existing = await WebviewWindow.getByLabel(
    REMOTE_HOST_CONTROLS_WINDOW_LABEL
  )
  await existing?.destroy()
}

export const destroyRemoteHostIdentityLabelWindow = async () => {
  const existing = await WebviewWindow.getByLabel(
    REMOTE_HOST_IDENTITY_LABEL_WINDOW_LABEL
  )
  await existing?.destroy()
}

export const syncRemoteHostControlsState = async (
  state: RemoteHostControlsState
) => {
  await emitTo(
    REMOTE_HOST_CONTROLS_WINDOW_LABEL,
    REMOTE_HOST_CONTROLS_STATE_EVENT,
    state
  )
}

export const syncRemoteHostIdentityLabelState = async (
  state: RemoteHostControlsState
) => {
  await emitTo(
    REMOTE_HOST_IDENTITY_LABEL_WINDOW_LABEL,
    REMOTE_HOST_CONTROLS_STATE_EVENT,
    state
  )
}
