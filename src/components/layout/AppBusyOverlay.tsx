import { Loader2 } from 'lucide-react'
import type { AppOperationLock } from '@/store/app-store'

interface AppBusyOverlayProps {
  lock: AppOperationLock
}

export function AppBusyOverlay({ lock }: AppBusyOverlayProps) {
  if (!lock.active) return null

  const progress = Math.max(0, Math.min(100, Math.round(lock.progress)))
  const stage = lock.stage || 'Running operation...'

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-background/60 backdrop-blur-sm pointer-events-auto"
      aria-live="polite"
      aria-busy="true"
      data-testid="app-busy-overlay"
    >
      <div className="w-[min(460px,92vw)] rounded-lg border bg-card p-5 shadow-xl">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Please wait for results</p>
            <p className="text-xs text-muted-foreground truncate">{stage}</p>
          </div>
        </div>
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{progress}% complete</p>
      </div>
    </div>
  )
}

export default AppBusyOverlay
