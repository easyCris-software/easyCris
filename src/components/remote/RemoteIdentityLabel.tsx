import type { HTMLAttributes, PointerEvent as ReactPointerEvent } from 'react'
import { MonitorUp } from 'lucide-react'
import { cn } from '@/lib/utils'

interface RemoteIdentityLabelProps {
  className?: string
  description: string
  dragHandleProps?: HTMLAttributes<HTMLSpanElement> & {
    'data-testid'?: string
  }
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void
  testId: string
}

/**
 * Slim single-line status pill. Identity lives here (not on the control strip):
 * host shows "Guest X is controlling your easyCris", guest shows
 * "You are controlling host X easyCris".
 */
export function RemoteIdentityLabel({
  className,
  description,
  dragHandleProps,
  onPointerDown,
  testId,
}: RemoteIdentityLabelProps) {
  const { className: dragHandleClassName, ...dragHandleRest } =
    dragHandleProps ?? {}

  return (
    <section
      className={cn(
        'flex max-w-full items-center gap-2.5 rounded-lg border bg-background/95 px-3 py-2 text-foreground shadow-lg backdrop-blur',
        className
      )}
      data-testid={testId}
      onPointerDown={onPointerDown}
    >
      <span
        className={cn(
          'grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/10',
          dragHandleClassName
        )}
        {...dragHandleRest}
      >
        <MonitorUp className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
      </span>
      <p className="min-w-0 truncate text-sm">{description}</p>
    </section>
  )
}

export default RemoteIdentityLabel
