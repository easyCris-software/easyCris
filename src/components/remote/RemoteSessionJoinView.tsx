import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link2, MonitorPlay, PlugZap, X } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { buildRemoteIdentity } from '@/components/remote/remoteIdentity'
import {
  inviteModeFromLink,
  parseCloudRemoteInvite,
  parseRemoteInvite,
} from '@/services/remoteInvite'
import {
  remoteWebRtcClient,
  type RemoteGuestConnectionState,
} from '@/services/remoteWebRtcClient'
import { remoteWebRtcHost } from '@/services/remoteWebRtcHost'
import {
  getCloudRemoteInviteMetadata,
  remoteForceRelayEnabled,
  type RemoteSessionMode,
} from '@/services/remoteSessionService'
import { useDeviceAuthStore } from '@/store/deviceAuthStore'
import { useRemoteJoinUrlStore } from '@/store/remote-join-url-store'

const guestModeDescription =
  'Paste an invite from a trusted host. You will see their easyCris window and control it after they approve.'
const joinRequestSentMessage =
  'Join request sent. Waiting for host approval.'

interface RemoteSessionJoinViewProps {
  onJoinSuccess?: () => void
}

export function RemoteSessionJoinView({
  onJoinSuccess,
}: RemoteSessionJoinViewProps = {}) {
  const [inviteText, setInviteText] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [token, setToken] = useState('')
  const [relayUrl, setRelayUrl] = useState('')
  const [connectionState, setConnectionState] =
    useState<RemoteGuestConnectionState>('idle')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [joinMode, setJoinMode] = useState<RemoteSessionMode>('lan')
  const appliedPendingUrlRef = useRef<string | null>(null)

  const { linkedEmail, deviceId, deviceFingerprint } = useDeviceAuthStore()
  const identity = useMemo(
    () => buildRemoteIdentity({ linkedEmail, deviceId, deviceFingerprint }),
    [deviceFingerprint, deviceId, linkedEmail]
  )

  useEffect(() => {
    remoteWebRtcClient.attach({
      onStream: () => undefined,
      onState: (state, message) => {
        setConnectionState(state)
        setStatusMessage(message ?? null)
      },
      onError: message => {
        setStatusMessage(message)
        toast.error(message)
      },
    })
    return () => {
      remoteWebRtcClient.detach()
    }
  }, [])

  const parseInviteValue = useCallback(async (
    value: string,
    mode: RemoteSessionMode
  ): Promise<boolean> => {
    if (mode === 'cloud') {
      try {
        const parsed = parseCloudRemoteInvite(value)
        const metadata = await getCloudRemoteInviteMetadata(parsed.inviteId)
        setHost('')
        setPort('')
        setSessionId(parsed.inviteId)
        setToken(parsed.token)
        setRelayUrl(metadata.relay_url)
        setStatusMessage(null)
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setStatusMessage(message)
        toast.error(message)
        return false
      }
    }

    try {
      const parsed = parseRemoteInvite(value)
      setHost(parsed.host)
      setPort(parsed.port)
      setSessionId(parsed.sessionId)
      setToken(parsed.token)
      setRelayUrl('')
      setStatusMessage(null)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatusMessage(message)
      toast.error(message)
      return false
    }
  }, [])

  const applyInviteUrl = useCallback(async (pendingUrl: string) => {
    const mode = inviteModeFromLink(pendingUrl)
    appliedPendingUrlRef.current = pendingUrl
    setJoinMode(mode)
    setInviteText(pendingUrl)
    const parsed = await parseInviteValue(pendingUrl, mode)
    if (parsed) {
      useRemoteJoinUrlStore.getState().clearPendingUrl(pendingUrl)
    }
  }, [parseInviteValue])

  useEffect(() => {
    const applyPendingUrl = (pendingUrl: string | null, dialogOpen: boolean) => {
      // The invite dialog owns the confirmation step. The setup form only
      // consumes the URL after "Edit in Remote Settings" hides the dialog
      // while intentionally preserving pendingUrl.
      if (!pendingUrl || dialogOpen) return
      void applyInviteUrl(pendingUrl)
    }

    const initialState = useRemoteJoinUrlStore.getState()
    applyPendingUrl(initialState.pendingUrl, initialState.dialogOpen)
    return useRemoteJoinUrlStore.subscribe((state, previousState) => {
      if (
        state.pendingUrl &&
        (state.pendingUrl !== previousState.pendingUrl ||
          state.dialogOpen !== previousState.dialogOpen)
      ) {
        applyPendingUrl(state.pendingUrl, state.dialogOpen)
      }
    })
  }, [applyInviteUrl])
  const handleParseInvite = async () => {
    appliedPendingUrlRef.current = null
    const mode = inviteModeFromLink(inviteText)
    setJoinMode(mode)
    await parseInviteValue(inviteText, mode)
  }

  const clearInviteFields = () => {
    const appliedPendingUrl = appliedPendingUrlRef.current
    if (appliedPendingUrl) {
      useRemoteJoinUrlStore.getState().clearPendingUrl(appliedPendingUrl)
      appliedPendingUrlRef.current = null
    }
    setInviteText('')
    setHost('')
    setPort('')
    setSessionId('')
    setToken('')
    setRelayUrl('')
    setJoinMode('lan')
    setStatusMessage(null)
  }

  const handleJoin = async () => {
    if (joinMode === 'cloud') {
      try {
        await remoteWebRtcHost.close(false)
        await remoteWebRtcClient.join({
          mode: 'cloud',
          inviteId: sessionId,
          relayUrl,
          token,
          forceRelay: remoteForceRelayEnabled,
          identity: {
            displayName: identity.display_name,
            deviceId: identity.device_id,
          },
        })
        setStatusMessage(joinRequestSentMessage)
        toast.success(joinRequestSentMessage)
        onJoinSuccess?.()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setStatusMessage(message)
        toast.error(message)
      }
      return
    }

    try {
      await remoteWebRtcHost.close(false)
      await remoteWebRtcClient.join({
        host,
        port,
        sessionId,
        token,
        identity: {
          displayName: identity.display_name,
          deviceId: identity.device_id,
        },
      })
      setStatusMessage(joinRequestSentMessage)
      toast.success(joinRequestSentMessage)
      onJoinSuccess?.()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatusMessage(message)
      toast.error(message)
    }
  }

  const handleDisconnect = () => {
    remoteWebRtcClient.close()
  }

  const canJoin =
    joinMode === 'cloud'
      ? sessionId.trim() && token.trim() && relayUrl.trim()
      : host.trim() && port.trim() && sessionId.trim() && token.trim()

  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <MonitorPlay className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">Join as guest</p>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {guestModeDescription}
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <Input
          value={inviteText}
          onChange={event => setInviteText(event.target.value)}
          placeholder="Paste easyCris remote invite"
          aria-label="Remote session invite"
          data-testid="remote-join-invite"
        />
        <Button
          type="button"
          variant="outline"
          onClick={handleParseInvite}
          data-testid="remote-parse-invite"
        >
          <Link2 className="h-4 w-4" />
          Parse
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={clearInviteFields}
          data-testid="remote-clear-join-fields"
        >
          <X className="h-4 w-4" />
          Clear
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          value={host}
          onChange={event => setHost(event.target.value)}
          placeholder="Host"
          aria-label="Remote host"
          disabled={joinMode === 'cloud'}
          data-testid="remote-join-host"
        />
        <Input
          value={port}
          onChange={event => setPort(event.target.value)}
          placeholder="Port"
          aria-label="Remote port"
          disabled={joinMode === 'cloud'}
          data-testid="remote-join-port"
        />
        <Input
          value={sessionId}
          onChange={event => setSessionId(event.target.value)}
          placeholder="Session ID"
          aria-label="Remote session ID"
          disabled={joinMode === 'cloud'}
          data-testid="remote-join-session-id"
        />
        <Input
          value={token}
          onChange={event => setToken(event.target.value)}
          placeholder="Invite token"
          aria-label="Remote invite token"
          type="password"
          disabled={joinMode === 'cloud'}
          data-testid="remote-join-token"
        />
      </div>

      {statusMessage && (
        <Alert
          variant={connectionState === 'error' ? 'destructive' : 'default'}
        >
          <AlertTitle>Remote session</AlertTitle>
          <AlertDescription>{statusMessage}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          onClick={() => void handleJoin()}
          disabled={!canJoin || connectionState === 'joining'}
          data-testid="remote-join-session"
        >
          <PlugZap className="h-4 w-4" />
          Join session
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleDisconnect}
          data-testid="remote-disconnect"
        >
          <X className="h-4 w-4" />
          Disconnect
        </Button>
      </div>
    </div>
  )
}

export default RemoteSessionJoinView
