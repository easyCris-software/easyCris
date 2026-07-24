import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { MonitorUp, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

interface RemoteControlsPanelProps {
  actions: ReactNode
  alwaysShowStatus?: boolean
  audioControls: ReactNode
  className?: string
  dragLabel?: string
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void
  securityCode?: string | null
  showLiveBadge?: boolean
  statusText?: string | null
  testIdPrefix: string
  testId: string
  // Used as the bar's accessible name only — identity is shown on the
  // floating identity label, not on the control strip.
  title: string
  warningText?: string | null
}

export function RemoteControlsPanel({
  actions,
  alwaysShowStatus = false,
  audioControls,
  className,
  dragLabel,
  onDragStart,
  securityCode,
  showLiveBadge = false,
  statusText,
  testIdPrefix,
  testId,
  title,
  warningText,
}: RemoteControlsPanelProps) {
  // The entire bar is a drag surface. Interactive controls (buttons, the
  // microphone selector, links) must keep their normal behavior, so a gesture
  // that begins on one of them never starts a window/panel drag.
  const handleBarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onDragStart) return
    // Only the primary (left) button starts a drag; the panel owns this
    // invariant so consumers don't each have to re-check it.
    if (event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    if (
      target?.closest(
        'button, select, input, textarea, a, [role="button"], [role="combobox"], [role="slider"]'
      )
    ) {
      return
    }
    onDragStart(event)
  }

  return (
    <div
      className={cn(
        'flex min-h-14 max-w-full items-center gap-2 border bg-background/95 px-3 py-2 text-foreground shadow-lg backdrop-blur',
        onDragStart && 'cursor-move select-none',
        className
      )}
      data-testid={testId}
      role="toolbar"
      aria-label={title}
      onPointerDown={onDragStart ? handleBarPointerDown : undefined}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10"
          data-testid={onDragStart ? 'remote-controls-drag-handle' : undefined}
          title={dragLabel}
        >
          <MonitorUp className="h-4 w-4 text-primary" aria-hidden="true" />
        </span>
        {showLiveBadge ? (
          <span className="inline-flex shrink-0 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-bold text-emerald-500">
            LIVE
          </span>
        ) : null}
        {securityCode ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-xs font-semibold text-primary"
            aria-label={`Security code: ${securityCode}`}
            data-testid={`${testIdPrefix}-security-code`}
          >
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="font-mono tracking-normal">{securityCode}</span>
          </span>
        ) : null}
        {statusText ? (
          <p
            className={cn(
              'truncate text-xs text-muted-foreground',
              alwaysShowStatus ? 'block max-w-[18rem]' : 'hidden md:block'
            )}
          >
            {statusText}
          </p>
        ) : null}
      </div>

      {warningText ? (
        <div
          className="hidden max-w-[9rem] shrink-0 truncate rounded-md border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-xs font-semibold text-amber-200 sm:block"
          data-testid="remote-session-warning-chip"
        >
          {warningText}
        </div>
      ) : null}

      <div
        className="flex shrink-0 items-center justify-end gap-2"
        data-testid={`${testIdPrefix}-audio-controls`}
      >
        {audioControls}
        {actions}
      </div>
    </div>
  )
}

export default RemoteControlsPanel
