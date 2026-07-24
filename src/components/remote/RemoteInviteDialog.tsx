import { useEffect, useMemo, useState } from 'react'
import { MonitorPlay, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { buildRemoteIdentity } from '@/components/remote/remoteIdentity'
import {
  inviteModeFromLink,
  parseCloudRemoteInvite,
  parseRemoteInvite,
} from '@/services/remoteInvite'
import { remoteWebRtcClient } from '@/services/remoteWebRtcClient'
import { remoteWebRtcHost } from '@/services/remoteWebRtcHost'
import {
  getCloudRemoteInviteMetadata,
  remoteForceRelayEnabled,
} from '@/services/remoteSessionService'
import { useDeviceAuthStore } from '@/store/deviceAuthStore'
import { useRemoteJoinUrlStore } from '@/store/remote-join-url-store'
import { useUIStore } from '@/store/ui-store'

type ParsedPendingInvite =
  | {
      mode: 'lan'
      host: string
      port: string
      sessionId: string
      token: string
    }
  | {
      mode: 'cloud'
      inviteId: string
      token: string
    }

const parsePendingInvite = (url: string): ParsedPendingInvite => {
  const mode = inviteModeFromLink(url)
  if (mode === 'cloud') {
    return { mode, ...parseCloudRemoteInvite(url) }
  }
  return { mode, ...parseRemoteInvite(url) }
}

export function RemoteInviteDialog() {
  const { dialogOpen, pendingUrl, clearPendingUrl, hideDialog } =
    useRemoteJoinUrlStore()
  const { setActivePreferencesPane, setPreferencesOpen } = useUIStore()
  const { linkedEmail, deviceId, deviceFingerprint } = useDeviceAuthStore()
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)

  const identity = useMemo(
    () => buildRemoteIdentity({ linkedEmail, deviceId, deviceFingerprint }),
    [deviceFingerprint, deviceId, linkedEmail]
  )

  const parsed = useMemo(() => {
    if (!pendingUrl) return null
    try {
      return parsePendingInvite(pendingUrl)
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, [pendingUrl])
  const parsedInvite = parsed && !('error' in parsed) ? parsed : null
  const parsedError = parsed && 'error' in parsed ? parsed.error : null
  const displayError = parsedError ?? joinError

  useEffect(() => {
    setJoinError(null)
  }, [pendingUrl])

  const openSettings = () => {
    hideDialog()
    setActivePreferencesPane('remote')
    setPreferencesOpen(true)
  }

  const handleJoin = async () => {
    if (!pendingUrl || !parsedInvite) return
    setJoining(true)
    setJoinError(null)
    try {
      const guestIdentity = {
        displayName: identity.display_name,
        deviceId: identity.device_id,
      }
      await remoteWebRtcHost.close(false)
      if (parsedInvite.mode === 'cloud') {
        const metadata = await getCloudRemoteInviteMetadata(parsedInvite.inviteId)
        await remoteWebRtcClient.join({
          mode: 'cloud',
          inviteId: parsedInvite.inviteId,
          relayUrl: metadata.relay_url,
          token: parsedInvite.token,
          forceRelay: remoteForceRelayEnabled,
          identity: guestIdentity,
        })
      } else {
        await remoteWebRtcClient.join({
          host: parsedInvite.host,
          port: parsedInvite.port,
          sessionId: parsedInvite.sessionId,
          token: parsedInvite.token,
          identity: guestIdentity,
        })
      }
      clearPendingUrl(pendingUrl)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setJoinError(message)
      toast.error(message)
    } finally {
      setJoining(false)
    }
  }

  const open = Boolean(dialogOpen && pendingUrl)

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen && pendingUrl) clearPendingUrl(pendingUrl)
      }}
    >
      <DialogContent
        className="max-w-md"
        data-testid="remote-invite-dialog"
      >
        <DialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <MonitorPlay className="h-5 w-5" />
          </div>
          <DialogTitle>Remote invite received</DialogTitle>
          <DialogDescription>
            Review the session details before joining this EasyCris remote
            session.
          </DialogDescription>
        </DialogHeader>

        {displayError ? (
          <p
            className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
            data-testid="remote-invite-dialog-error"
          >
            {displayError}
          </p>
        ) : null}

        {parsedInvite ? (
          <dl className="grid gap-3 text-sm">
            <div className="grid gap-1">
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                Connection
              </dt>
              <dd
                className="rounded-md border bg-muted/30 px-3 py-2 font-mono text-sm"
                data-testid="remote-invite-dialog-host"
              >
                {parsedInvite.mode === 'cloud'
                  ? 'Different network'
                  : `${parsedInvite.host}:${parsedInvite.port}`}
              </dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                Session ID
              </dt>
              <dd
                className="rounded-md border bg-muted/30 px-3 py-2 font-mono text-sm"
                data-testid="remote-invite-dialog-session-id"
              >
                {parsedInvite.mode === 'cloud'
                  ? parsedInvite.inviteId
                  : parsedInvite.sessionId}
              </dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                Password
              </dt>
              <dd>
                <input
                  readOnly
                  type="password"
                  value={parsedInvite.token}
                  className="w-full rounded-md border bg-muted/30 px-3 py-2 font-mono text-sm outline-none"
                  data-testid="remote-invite-dialog-token"
                />
              </dd>
            </div>
          </dl>
        ) : null}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={openSettings}
            disabled={!pendingUrl}
            data-testid="remote-invite-edit-settings"
          >
            <Settings className="h-4 w-4" />
            Edit in Remote Settings
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                if (pendingUrl) clearPendingUrl(pendingUrl)
              }}
              data-testid="remote-invite-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleJoin()}
              disabled={!parsedInvite || joining}
              data-testid="remote-invite-join"
            >
              {joining ? 'Joining...' : 'Join'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default RemoteInviteDialog
