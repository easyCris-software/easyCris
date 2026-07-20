import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Clipboard,
  MonitorUp,
  RefreshCw,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { buildRemoteIdentity } from '@/components/remote/remoteIdentity'
import {
  RemoteConnectionModeDialog,
} from '@/components/remote/RemoteConnectionModeDialog'
import { remoteConnectionModeLabel } from '@/components/remote/remoteConnectionMode'
import { RemoteSessionJoinView } from '@/components/remote/RemoteSessionJoinView'
import { remoteWebRtcClient } from '@/services/remoteWebRtcClient'
import { remoteWebRtcHost } from '@/services/remoteWebRtcHost'
import {
  getActiveCloudHostSecret,
  remoteForceRelayEnabled,
  type RemoteSessionMode,
} from '@/services/remoteSessionService'
import { useDeviceAuthStore } from '@/store/deviceAuthStore'
import { useRemoteJoinUrlStore } from '@/store/remote-join-url-store'
import { useRemoteSessionStore } from '@/store/remote-session-store'
import { useUIStore } from '@/store/ui-store'

const SettingsSection = ({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) => (
  <div className="space-y-4">
    <div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-medium text-foreground">{title}</h3>
        {action ? <div className="flex-shrink-0">{action}</div> : null}
      </div>
      <Separator className="mt-2" />
    </div>
    <div className="space-y-4">{children}</div>
  </div>
)

const sessionLabel = (status: string | undefined) => {
  switch (status) {
    case 'listening':
      return 'Listening'
    case 'pending_approval':
      return 'Pending approval'
    case 'connected':
      return 'Connected'
    case 'revoked':
      return 'Revoked'
    case 'error':
      return 'Error'
    default:
      return 'Idle'
  }
}

const captureFailureMessage = (error: unknown) => {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return 'Remote control was cancelled or denied. Approve again to retry.'
  }
  if (name === 'NotReadableError') {
    return 'Remote control could not start. Another app may be blocking capture, or the easyCris window is unavailable. Close conflicting apps and try again.'
  }
  if (name === 'NotFoundError') {
    return 'No display was available for remote control. Open easyCris and try again.'
  }
  return error instanceof Error ? error.message : String(error)
}

const hostStatusMessage = (message: string) => {
  if (message === 'Remote-session signaling socket closed') {
    return 'Remote connection closed.'
  }
  if (message.startsWith('Remote-session stream:')) {
    const state = message.slice('Remote-session stream:'.length).trim()
    return state ? `Remote display connection is ${state}.` : null
  }
  return message.replaceAll('Remote-session', 'Remote session')
}

const hostModeDescription =
  'Start a session for a trusted guest. They can control your easyCris only after you approve their request.'

const idleWarningToast =
  'Remote session will end in 1 minute due to inactivity.'

const formatInviteExpiry = (expiresAtUnixMs: number) => {
  const seconds = Math.max(0, Math.ceil((expiresAtUnixMs - Date.now()) / 1000))
  if (seconds <= 0) return 'Expired'
  if (seconds < 60) return 'Expires in <1 min'
  return `Expires in ${Math.ceil(seconds / 60)} min`
}

const formatInvitePasswordPreview = (token: string) =>
  token.length <= 4 ? '••••' : `${token.slice(0, 4)}••••`

export function RemoteSessionPanel() {
  const {
    status,
    invite,
    pendingGuest,
    approvedGuest,
    error,
    isBusy,
    startHosting,
    stopHosting,
    refreshStatus,
    approveGuest,
    rejectGuest,
    revoke,
    setAudioState,
    setIdleWarning,
    clearError,
  } = useRemoteSessionStore()
  const pendingRemoteJoinUrl = useRemoteJoinUrlStore(state => state.pendingUrl)
  const { linkedEmail, deviceId, deviceFingerprint } = useDeviceAuthStore()
  const [hostMessage, setHostMessage] = useState<string | null>(null)
  const [hostSecurityCode, setHostSecurityCode] = useState<string | null>(null)
  const [hostModeDialogOpen, setHostModeDialogOpen] = useState(false)
  const [guestActionInProgress, setGuestActionInProgress] = useState(false)
  const [stopInProgress, setStopInProgress] = useState(false)
  const [showJoinSetupFromInvite, setShowJoinSetupFromInvite] = useState(false)
  const guestActionInFlightRef = useRef(false)
  const stopActionInFlightRef = useRef(false)
  const previousSessionIdRef = useRef<string | null | undefined>(undefined)

  const identity = useMemo(
    () => buildRemoteIdentity({ linkedEmail, deviceId, deviceFingerprint }),
    [deviceFingerprint, deviceId, linkedEmail]
  )
  const currentSession = status?.current_session ?? null
  const showJoinSetup = !currentSession || showJoinSetupFromInvite

  useEffect(() => {
    if (pendingRemoteJoinUrl) {
      setShowJoinSetupFromInvite(true)
    }
  }, [pendingRemoteJoinUrl])

  useEffect(() => {
    if (!currentSession?.session_id) return
    if (typeof remoteWebRtcHost.getAudioDiagnostics !== 'function') return
    const diagnostics = remoteWebRtcHost.getAudioDiagnostics()
    if (!diagnostics.audioTransceiverCreated) return
    setAudioState({
      connecting: false,
      localEnabled: diagnostics.localAudioTrackLive,
      localMuted: diagnostics.audioMuted,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount sync only; session changes must not copy stale backend audio state.
  }, [])

  useEffect(() => {
    void refreshStatus().catch(() => undefined)
    const id = window.setInterval(() => {
      void refreshStatus().catch(() => undefined)
    }, 2500)
    return () => window.clearInterval(id)
  }, [refreshStatus])

  useEffect(() => {
    const sessionId = currentSession?.session_id ?? null
    const previousSessionId = previousSessionIdRef.current
    previousSessionIdRef.current = sessionId
    if (previousSessionId === undefined || previousSessionId === sessionId) {
      return
    }
    setHostSecurityCode(null)
    setAudioState({
      connecting: false,
      localEnabled: false,
      localMuted: false,
      remotePlaybackEnabled: false,
    })
  }, [currentSession?.session_id, setAudioState])

  useEffect(() => {
    if (!currentSession?.session_id) return
    if (currentSession.mode === 'lan' && !currentSession.signaling_port) {
      return
    }
    if (currentSession.mode === 'lan' && !invite?.invite_token) {
      setHostMessage('Remote invite is missing signaling encryption details.')
      return
    }
    const cloudHostSecret =
      currentSession.mode === 'cloud' ? getActiveCloudHostSecret() : null
    if (currentSession.mode === 'cloud') {
      if (!invite?.relay_url || !invite.invite_id || !cloudHostSecret) {
        setHostMessage(
          'Cloud remote invite is missing relay connection details.'
        )
        return
      }
    }
    const callbacks = {
      onJoinPending: () => void refreshStatus(),
      onStatus: (message: string) => {
        const displayMessage = hostStatusMessage(message)
        if (displayMessage) setHostMessage(displayMessage)
      },
      onWarning: (message: string) => {
        setHostMessage(message)
        toast.warning(message)
      },
      onIdleWarning: (secondsRemaining: number) => {
        const session = useRemoteSessionStore.getState().status?.current_session
        if (!session?.session_id) return
        setIdleWarning({
          session_id: session.session_id,
          seconds_remaining: secondsRemaining,
          expires_at_unix_ms: Date.now() + secondsRemaining * 1000,
        })
        toast.warning(idleWarningToast)
      },
      onIdleExpired: () => {
        const session = useRemoteSessionStore.getState().status?.current_session
        if (!session?.session_id) return
        setIdleWarning({
          session_id: session.session_id,
          seconds_remaining: 0,
          expires_at_unix_ms: Date.now(),
        })
      },
      onIdleReset: () => {
        setIdleWarning(null)
      },
      onSecurityCode: setHostSecurityCode,
      onError: (message: string) => {
        setHostMessage(message)
        toast.error(message)
      },
      onRevoked: () => void refreshStatus(),
    }
    const connectOptions =
      currentSession.mode === 'cloud'
        ? {
            mode: 'cloud' as const,
            sessionId: currentSession.session_id,
            inviteId: invite?.invite_id ?? '',
            relayUrl: invite?.relay_url ?? '',
            hostSecret: cloudHostSecret ?? '',
            forceRelay: remoteForceRelayEnabled,
            callbacks,
          }
        : {
            mode: 'lan' as const,
            sessionId: currentSession.session_id,
            signalingPort: currentSession.signaling_port ?? 0,
            token: invite?.invite_token ?? '',
            callbacks,
          }

    void remoteWebRtcHost.connect(connectOptions).catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      setHostMessage(message)
    })
  }, [
    currentSession?.mode,
    currentSession?.session_id,
    currentSession?.signaling_port,
    invite?.invite_id,
    invite?.invite_token,
    invite?.relay_url,
    refreshStatus,
    setIdleWarning,
  ])

  const handleStart = async (mode: RemoteSessionMode) => {
    try {
      remoteWebRtcClient.close()
      const nextInvite = await startHosting(identity, mode)
      setHostMessage('You are the host. Waiting for a guest to join.')
      await navigator.clipboard?.writeText(nextInvite.share_url)
      toast.success('Remote invite copied')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setHostMessage(message)
      toast.error(message)
    }
  }

  const handleStop = async () => {
    if (stopActionInFlightRef.current) return
    stopActionInFlightRef.current = true
    setStopInProgress(true)
    try {
      await remoteWebRtcHost.close(currentSession?.mode === 'cloud')
      await stopHosting()
      setHostMessage(null)
      setHostSecurityCode(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setHostMessage(message)
      toast.error(message)
    } finally {
      stopActionInFlightRef.current = false
      setStopInProgress(false)
    }
  }

  const handleApprove = async (guestDeviceId: string) => {
    if (guestActionInFlightRef.current) return
    guestActionInFlightRef.current = true
    setGuestActionInProgress(true)
    const guestDisplayName = pendingGuest?.guest_display_name ?? 'The guest'
    let approved = false
    try {
      await approveGuest(guestDeviceId)
      approved = true
      setHostMessage('Starting remote control for the approved guest.')
      await remoteWebRtcHost.startViewOnlyOffer(guestDeviceId)
      useUIStore.getState().setPreferencesOpen(false)
      setHostMessage(
        `You are the host. ${guestDisplayName} can now see and control this easyCris.`
      )
    } catch (error) {
      const message = captureFailureMessage(error)
      if (approved) {
        await remoteWebRtcHost
          .close(currentSession?.mode === 'cloud')
          .catch(() => undefined)
        await revoke().catch(() => undefined)
        clearError()
        setHostSecurityCode(null)
        setHostMessage(`${message} Remote session was revoked.`)
      } else {
        setHostMessage(message)
      }
      toast.error(message)
    } finally {
      guestActionInFlightRef.current = false
      setGuestActionInProgress(false)
    }
  }

  const handleReject = async (guestDeviceId: string) => {
    if (guestActionInFlightRef.current) return
    guestActionInFlightRef.current = true
    setGuestActionInProgress(true)
    try {
      await rejectGuest(guestDeviceId)
      remoteWebRtcHost.rejectGuest(
        guestDeviceId,
        'Host rejected the remote-session request'
      )
      setHostMessage('Remote viewer rejected.')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setHostMessage(message)
      toast.error(message)
    } finally {
      guestActionInFlightRef.current = false
      setGuestActionInProgress(false)
    }
  }

  const handleRevoke = async () => {
    try {
      if (currentSession?.mode === 'cloud') {
        await remoteWebRtcHost.close(true).catch(() => undefined)
        await revoke()
      } else {
        await revoke()
        await remoteWebRtcHost.close(false).catch(() => undefined)
      }
      setHostMessage('Remote control revoked.')
      setHostSecurityCode(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setHostMessage(message)
      toast.error(message)
    }
  }

  const handleCopyInvite = async () => {
    if (!invite?.share_url) return
    await navigator.clipboard?.writeText(invite.share_url)
    toast.success('Remote invite copied')
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Remote Session"
        action={<Badge variant="secondary">Experimental</Badge>}
      >
        <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-foreground">
                  Host
                </p>
                <Badge variant="outline">
                  {sessionLabel(currentSession?.status)}
                </Badge>
                {currentSession && (
                  <Badge variant="secondary" data-testid="remote-active-mode">
                    {remoteConnectionModeLabel(currentSession.mode)}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {hostModeDescription}
              </p>
            </div>
            <div className="inline-flex items-center gap-2 rounded-full border border-border/70 px-3 py-1 text-xs font-medium text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>{identity.display_name}</span>
            </div>
          </div>

          {hostSecurityCode && (
            <div
              className="mt-3 flex w-fit flex-wrap items-center gap-2 rounded-md border border-border/70 bg-background px-3 py-2 text-xs"
              data-testid="remote-host-security-code"
            >
              <ShieldCheck className="h-3.5 w-3.5 text-primary" />
              <span className="font-medium text-foreground">Security code</span>
              <span className="font-mono font-semibold tracking-normal text-primary">
                {hostSecurityCode}
              </span>
              <span className="text-muted-foreground">Compare with guest</span>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-3">
            {!currentSession ? (
              <Button
                onClick={() => setHostModeDialogOpen(true)}
                disabled={isBusy}
                data-testid="remote-start-session"
              >
                <MonitorUp className="h-4 w-4" />
                Start Remote Session
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => void handleCopyInvite()}
                  disabled={!invite?.share_url}
                  data-testid="remote-copy-invite"
                >
                  <Clipboard className="h-4 w-4" />
                  Copy Invite
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void refreshStatus()}
                  data-testid="remote-refresh-status"
                >
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void handleStop()}
                  disabled={stopInProgress}
                  data-testid="remote-stop-session"
                >
                  <Square className="h-4 w-4" />
                  Stop
                </Button>
              </>
            )}
          </div>

          {pendingGuest && (
            <div className="mt-4 rounded-xl border border-border/70 bg-background p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {pendingGuest.guest_display_name} wants to control this
                    easyCris
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {pendingGuest.guest_device_id}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      void handleApprove(pendingGuest.guest_device_id)
                    }
                    disabled={guestActionInProgress}
                    data-testid="remote-approve-guest"
                  >
                    <Check className="h-4 w-4" />
                    Approve guest
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void handleReject(pendingGuest.guest_device_id)
                    }
                    disabled={guestActionInProgress}
                    data-testid="remote-reject-guest"
                  >
                    <X className="h-4 w-4" />
                    Reject
                  </Button>
                </div>
              </div>
            </div>
          )}

          {invite?.share_url && (
            <div className="mt-4 space-y-3 rounded-lg border bg-background px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    Invite
                  </p>
                  <p className="mt-1 text-sm text-foreground">
                    Use Copy Invite and send it only to a trusted guest.
                  </p>
                </div>
                <Badge variant="outline" data-testid="remote-invite-expiry">
                  {formatInviteExpiry(invite.expires_at_unix_ms)}
                </Badge>
              </div>
              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="font-medium text-muted-foreground">
                    Invite link
                  </dt>
                  <dd
                    className="mt-1 break-all font-mono text-foreground"
                    data-testid="remote-invite-link"
                  >
                    {invite.share_url}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-muted-foreground">
                    Session ID
                  </dt>
                  <dd
                    className="mt-1 break-all font-mono text-foreground"
                    data-testid="remote-invite-session-id"
                  >
                    {invite.invite_id ?? invite.session_id}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-muted-foreground">
                    Password preview
                  </dt>
                  <dd
                    className="mt-1 break-all font-mono text-foreground"
                    data-testid="remote-invite-password"
                  >
                    {formatInvitePasswordPreview(invite.invite_token)}
                  </dd>
                </div>
                {invite.mode === 'lan' && (
                  <div>
                    <dt className="font-medium text-muted-foreground">Host</dt>
                    <dd
                      className="mt-1 break-all font-mono text-foreground"
                      data-testid="remote-invite-host"
                    >
                      {invite.host_candidates[0] ??
                        (invite.signaling_port
                          ? `127.0.0.1:${invite.signaling_port}`
                          : 'Same Wi-Fi host')}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}

          {(hostMessage || error) && (
            <Alert className="mt-4" variant={error ? 'destructive' : 'default'}>
              <AlertTitle>Remote session</AlertTitle>
              <AlertDescription>{error ?? hostMessage}</AlertDescription>
            </Alert>
          )}
        </div>

        <RemoteConnectionModeDialog
          open={hostModeDialogOpen}
          onOpenChange={setHostModeDialogOpen}
          onSelect={mode => {
            setHostModeDialogOpen(false)
            void handleStart(mode)
          }}
        />

        {approvedGuest && (
          <div className="rounded-xl border border-primary/40 bg-primary/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  You are the host: {approvedGuest.guest_display_name} is
                  controlling this easyCris.
                </p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {approvedGuest.guest_device_id}
                </p>
              </div>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void handleRevoke()}
                data-testid="remote-revoke-control"
              >
                Revoke
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>

      {showJoinSetup && (
        <SettingsSection title="Join">
          <RemoteSessionJoinView
            onJoinSuccess={() => setShowJoinSetupFromInvite(false)}
          />
        </SettingsSection>
      )}
    </div>
  )
}

export default RemoteSessionPanel
