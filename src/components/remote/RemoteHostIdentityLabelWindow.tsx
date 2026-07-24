import { useCallback, useEffect, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { RemoteIdentityLabel } from '@/components/remote/RemoteIdentityLabel'
import { remoteIdentityName } from '@/components/remote/remoteIdentityName'
import {
  REMOTE_HOST_CONTROLS_COMMAND_EVENT,
  REMOTE_HOST_CONTROLS_STATE_EVENT,
  type RemoteHostControlsState,
} from '@/services/remoteHostControlsWindow'
import { setRemoteWindowCaptureExclusion } from '@/services/remoteSessionService'

export function RemoteHostIdentityLabelWindow() {
  const [state, setState] = useState<RemoteHostControlsState | null>(null)
  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      void getCurrentWebviewWindow()
        .startDragging()
        .catch(() => undefined)
    },
    []
  )

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null

    void setRemoteWindowCaptureExclusion(true).catch(() => undefined)
    void listen<RemoteHostControlsState>(
      REMOTE_HOST_CONTROLS_STATE_EVENT,
      event => {
        if (disposed) return
        setState(event.payload)
      }
    ).then(listener => {
      if (disposed) {
        listener()
        return
      }
      unlisten = listener
    })
    void emit(REMOTE_HOST_CONTROLS_COMMAND_EVENT, {
      type: 'request-state',
    })

    return () => {
      disposed = true
      unlisten?.()
      void setRemoteWindowCaptureExclusion(false).catch(() => undefined)
    }
  }, [])

  if (!state?.active || !state.identityLabelVisible) {
    return (
      <div className="hidden" data-testid="remote-host-identity-label-window" />
    )
  }

  const guestIdentity = remoteIdentityName({
    deviceId: state.guestDeviceId,
    displayName: state.guestDisplayName,
    fallback: 'guest device',
  })

  return (
    <main
      className="h-screen overflow-hidden bg-background text-foreground"
      data-testid="remote-host-identity-label-window"
    >
      <RemoteIdentityLabel
        className="h-full cursor-move select-none items-center rounded-none border-0 shadow-none"
        description={`Guest ${guestIdentity} is controlling your easyCris`}
        onPointerDown={handleDragStart}
        testId="remote-host-identity-label"
      />
    </main>
  )
}

export default RemoteHostIdentityLabelWindow
