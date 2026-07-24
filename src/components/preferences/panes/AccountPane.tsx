import { type ReactNode, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { LaptopMinimalCheck, Link2, LogOut, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useDeviceAuthStore } from '@/store/deviceAuthStore'
import {
  getDeviceManagementUrl,
  revokeCurrentDeviceSession,
} from '@/services/deviceAuthService'
import { clearDeviceAuthSession } from '@/services/deviceAuthStorage'

const SettingsSection = ({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      <Separator className="mt-2" />
    </div>
    <div className="space-y-4">{children}</div>
  </div>
)

const formatTimestamp = (value: string | null): string => {
  if (!value) return 'Not yet validated'
  return new Date(value).toLocaleString()
}

export function AccountPane() {
  const {
    mode,
    linkedEmail,
    tier,
    deviceId,
    lastValidatedAt,
    invalidReason,
    sessionToken,
    setLinkDialogOpen,
    resetToGuest,
  } = useDeviceAuthStore()
  const [submitting, setSubmitting] = useState(false)

  const isLinked = mode === 'linked'
  const isInvalid = mode === 'invalid'

  const handleLinkDevice = () => {
    setLinkDialogOpen(true)
  }

  const handleOpenWebDevices = async () => {
    await openUrl(getDeviceManagementUrl())
  }

  const handleSignOutDevice = async () => {
    setSubmitting(true)
    try {
      if (sessionToken) {
        await revokeCurrentDeviceSession(sessionToken)
      }
      await clearDeviceAuthSession()
      resetToGuest()
      toast.success('This desktop is no longer linked to your account.')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to sign out this device. Please try again.'
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="Account">
        <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                {isLinked
                  ? linkedEmail
                    ? `Linked to ${linkedEmail}`
                    : 'Linked to your easyCris account'
                  : isInvalid
                    ? 'Link expired or revoked'
                    : 'Guest mode'}
              </p>
              <p className="text-sm text-muted-foreground">
                {isLinked
                  ? 'This desktop can be managed from your easyCris account.'
                  : isInvalid
                    ? 'The previous device session is no longer valid. You can relink this desktop at any time.'
                    : 'Use easyCris locally without linking an account, or link this device for account-based management.'}
              </p>
            </div>
            <div className="inline-flex items-center gap-2 rounded-full border border-border/70 px-3 py-1 text-xs font-medium text-muted-foreground">
              <LaptopMinimalCheck className="h-3.5 w-3.5" />
              <span>{isLinked ? `Tier: ${tier ?? 'free'}` : 'Guest'}</span>
            </div>
          </div>

          {(isLinked || isInvalid) && (
            <div className="mt-4 grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
              <div>
                <p className="font-medium text-foreground">Device status</p>
                <p>{isLinked ? 'Linked' : 'Needs relink'}</p>
              </div>
              <div>
                <p className="font-medium text-foreground">Last validation</p>
                <p>{formatTimestamp(lastValidatedAt)}</p>
              </div>
              {deviceId && (
                <div className="sm:col-span-2">
                  <p className="font-medium text-foreground">Device ID</p>
                  <p className="font-mono text-xs">{deviceId}</p>
                </div>
              )}
              {isInvalid && invalidReason && (
                <div className="sm:col-span-2 flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
                  <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <div>
                    <p className="font-medium">Account link needs attention</p>
                    <p className="text-xs">Reason: {invalidReason}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-3">
          <Button onClick={handleLinkDevice}>
            <Link2 className="h-4 w-4" />
            {isLinked ? 'Relink this device' : 'Link this device'}
          </Button>

          <Button variant="outline" onClick={() => void handleOpenWebDevices()}>
            Open web device management
          </Button>

          {isLinked && (
            <Button
              variant="destructive"
              onClick={() => void handleSignOutDevice()}
              disabled={submitting}
            >
              <LogOut className="h-4 w-4" />
              {submitting ? 'Signing out…' : 'Sign out this device'}
            </Button>
          )}
        </div>
      </SettingsSection>
    </div>
  )
}

export default AccountPane
