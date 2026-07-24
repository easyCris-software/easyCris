import { useEffect, useMemo, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  LaptopMinimalCheck,
  LoaderCircle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useDeviceAuthStore } from '@/store/deviceAuthStore'
import {
  getDeviceManagementUrl,
  pollLinking,
  startLinking,
  validateDeviceSession,
} from '@/services/deviceAuthService'
import {
  clearDeviceAuthSession,
  getOrCreateDeviceFingerprint,
  saveDeviceAuthSession,
} from '@/services/deviceAuthStorage'

const formatCountdown = (expiresAt: string | null, nowMs: number): string | null => {
  if (!expiresAt) return null
  const remainingMs = new Date(expiresAt).getTime() - nowMs
  if (remainingMs <= 0) return 'Expired'

  const totalSeconds = Math.floor(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function DeviceLinkDialog() {
  const {
    mode,
    linkDialogOpen,
    userCode,
    deviceCode,
    verificationUri,
    pollIntervalSeconds,
    pairingExpiresAt,
    pairingError,
    linkedEmail,
    tier,
    setLinkDialogOpen,
    cancelPairing,
    completeLinking,
    markInvalid,
  } = useDeviceAuthStore()
  const [starting, setStarting] = useState(false)
  const [polling, setPolling] = useState(false)
  const [countdownNow, setCountdownNow] = useState(Date.now())
  const [copied, setCopied] = useState(false)
  const startedThisOpenRef = useRef(false)

  const countdownLabel = useMemo(
    () => formatCountdown(pairingExpiresAt, countdownNow),
    [pairingExpiresAt, countdownNow]
  )

  useEffect(() => {
    if (!linkDialogOpen || pairingExpiresAt === null) return

    const timer = window.setInterval(() => {
      setCountdownNow(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(timer)
    }
  }, [linkDialogOpen, pairingExpiresAt])

  useEffect(() => {
    if (!linkDialogOpen) {
      startedThisOpenRef.current = false
    }
  }, [linkDialogOpen])

  useEffect(() => {
    if (!linkDialogOpen) return
    if (startedThisOpenRef.current) return
    const currentAuth = useDeviceAuthStore.getState()
    if (
      currentAuth.mode === 'pairing' &&
      currentAuth.deviceCode &&
      currentAuth.userCode &&
      currentAuth.verificationUri
    ) {
      return
    }

    let disposed = false

    const run = async () => {
      try {
        startedThisOpenRef.current = true
        setStarting(true)
        useDeviceAuthStore.getState().setPairingError(null)
        const latestFingerprint = useDeviceAuthStore.getState().deviceFingerprint
        const fingerprint = latestFingerprint ?? getOrCreateDeviceFingerprint()

        // Persist the fingerprint before the async boundary so startup bootstrap
        // cannot tear down this effect mid-request and strand the dialog in
        // Loading… while the native start command has already succeeded.
        if (!latestFingerprint) {
          useDeviceAuthStore.getState().setDeviceFingerprint(fingerprint)
        }

        const response = await startLinking({
          clientVersion: import.meta.env.PACKAGE_VERSION ?? 'desktop',
          deviceFingerprint: fingerprint,
        })

        if (disposed) return

        useDeviceAuthStore.getState().beginPairing({
          deviceCode: response.deviceCode,
          userCode: response.userCode,
          verificationUri: response.verificationUri,
          pollIntervalSeconds: response.interval,
          expiresAt: new Date(Date.now() + response.expiresIn * 1000).toISOString(),
        })
      } catch (error) {
        if (disposed) return
        useDeviceAuthStore.getState().setPairingError(
          error instanceof Error ? error.message : 'Failed to start device linking'
        )
      } finally {
        if (!disposed) {
          setStarting(false)
        }
      }
    }

    void run()

    return () => {
      disposed = true
    }
  }, [linkDialogOpen])

  useEffect(() => {
    if (!linkDialogOpen || mode !== 'pairing' || !deviceCode || !pollIntervalSeconds) {
      return
    }

    let disposed = false
    let timer: number | null = null

    const runPoll = async () => {
      try {
        setPolling(true)
        const result = await pollLinking({ deviceCode })

        if (disposed) return

        if (result.status === 'approved' && result.sessionToken) {
          const validation = await validateDeviceSession(result.sessionToken)

          if (disposed) return

          if (!validation.valid) {
            await clearDeviceAuthSession()
            markInvalid(validation.reason ?? 'unknown_token')
            return
          }

          const session = {
            sessionToken: result.sessionToken,
            linkedEmail: validation.email ?? null,
            tier: validation.tier ?? null,
            deviceId: validation.deviceId ?? null,
            expiresAt: validation.expiresAt ?? null,
            lastValidatedAt: new Date().toISOString(),
          }

          await saveDeviceAuthSession(session)
          completeLinking(session)
          return
        }

        if (result.status === 'pending') {
          timer = window.setTimeout(runPoll, pollIntervalSeconds * 1000)
          return
        }

        if (result.status === 'rate_limited') {
          timer = window.setTimeout(
            runPoll,
            Math.max(1, result.retryAfterSecs ?? pollIntervalSeconds) * 1000
          )
          return
        }

        const messageByStatus: Record<string, string> = {
          denied: 'Device approval was denied in the browser.',
          expired: 'This pairing code expired. Start again to link the device.',
          consumed: 'This pairing code has already been used.',
        }
        useDeviceAuthStore
          .getState()
          .setPairingError(messageByStatus[result.status] ?? 'Device linking did not complete.')
      } catch (error) {
        if (disposed) return
        useDeviceAuthStore.getState().setPairingError(
          error instanceof Error ? error.message : 'Failed while waiting for approval'
        )
      } finally {
        if (!disposed) {
          setPolling(false)
        }
      }
    }

    void runPoll()

    return () => {
      disposed = true
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [
    completeLinking,
    deviceCode,
    linkDialogOpen,
    markInvalid,
    mode,
    pollIntervalSeconds,
  ])

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setLinkDialogOpen(true)
      return
    }

    startedThisOpenRef.current = false

    if (mode === 'pairing') {
      cancelPairing()
      return
    }

    setLinkDialogOpen(false)
  }

  const handleCopyCode = async () => {
    if (!userCode || !navigator.clipboard) return
    await navigator.clipboard.writeText(userCode)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  const handleOpenBrowser = async () => {
    if (!verificationUri) return
    await openUrl(verificationUri)
  }

  const handleOpenDevicesPage = async () => {
    await openUrl(getDeviceManagementUrl())
  }

  const successState = mode === 'linked' && linkDialogOpen

  return (
    <Dialog open={linkDialogOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <LaptopMinimalCheck className="h-5 w-5 text-primary" />
            <span>Link this device</span>
          </DialogTitle>
          <DialogDescription>
            Sign in on easyCris web to link this desktop to your account.
          </DialogDescription>
        </DialogHeader>

        {pairingError && !successState && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Linking failed</AlertTitle>
            <AlertDescription>{pairingError}</AlertDescription>
          </Alert>
        )}

        {successState ? (
          <div className="space-y-4">
            <Alert>
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <AlertTitle>Device linked</AlertTitle>
              <AlertDescription>
                {linkedEmail
                  ? `This device is now linked to ${linkedEmail}.`
                  : 'This device is now linked to your easyCris account.'}
              </AlertDescription>
            </Alert>

            <div className="rounded-xl border border-border/70 bg-muted/20 p-4 text-sm">
              <p className="font-medium text-foreground">Current access</p>
              <p className="mt-1 text-muted-foreground">
                Tier: {tier ?? 'free'}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border border-border/70 bg-muted/20 p-4 text-sm">
              <p className="font-medium text-foreground">1. Open the approval page</p>
              <p className="mt-1 text-muted-foreground">
                Go to easyCris in your browser and approve this device while signed in.
              </p>
            </div>

            <div className="rounded-xl border border-border/70 bg-card p-5 text-center">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Pairing code
              </p>
              <div className="mt-3 text-3xl font-semibold tracking-[0.32em]">
                {starting ? 'Loading…' : userCode ?? '--------'}
              </div>
              {countdownLabel && (
                <p className="mt-3 text-sm text-muted-foreground">
                  Expires in {countdownLabel}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-3">
              <Button onClick={() => void handleOpenBrowser()} disabled={!verificationUri}>
                <ExternalLink className="h-4 w-4" />
                Open browser
              </Button>
              <Button variant="outline" onClick={() => void handleCopyCode()} disabled={!userCode}>
                <Copy className="h-4 w-4" />
                {copied ? 'Copied' : 'Copy code'}
              </Button>
            </div>

            <div className="flex items-center gap-2 rounded-xl border border-dashed border-border/70 bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
              <LoaderCircle className={`h-4 w-4 ${polling ? 'animate-spin' : ''}`} />
              <span>Waiting for approval in the browser…</span>
            </div>
          </div>
        )}

        <DialogFooter>
          {successState ? (
            <>
              <Button variant="outline" onClick={() => void handleOpenDevicesPage()}>
                Open web device management
              </Button>
              <Button onClick={() => setLinkDialogOpen(false)}>Continue</Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default DeviceLinkDialog
