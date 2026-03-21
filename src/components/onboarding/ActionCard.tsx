/**
 * ActionCard Component
 *
 * Reusable card with icon, title, and description.
 * Used for the three action options in the welcome screen.
 */

import { ReactNode } from 'react'

interface ActionCardProps {
  icon: ReactNode
  title: string
  description: string
  onClick: () => void
  className?: string
}

export function ActionCard({
  icon,
  title,
  description,
  onClick,
  className,
}: ActionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full rounded-xl border border-border/70 bg-card p-6',
        'transition-all hover:border-primary/60 hover:shadow-md hover:bg-accent/5',
        'flex flex-col items-center justify-center gap-3 text-center',
        className ?? '',
      ].join(' ')}
    >
      <div
        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl"
        style={{ backgroundColor: '#3949ab', color: 'white' }}
      >
        {icon}
      </div>
      <div className="w-full space-y-1 text-center">
        <h3 className="font-semibold text-base">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </button>
  )
}
