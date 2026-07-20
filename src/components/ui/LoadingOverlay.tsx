/**
 * LoadingOverlay - Progress indicator for long operations
 *
 * Phase 4: User-Visible Reliability
 * Shows a loading overlay during long DuckDB operations (import, sort, groupby)
 */

import { LoadingOperation } from '@/store/data-store'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface LoadingOverlayProps {
  operation: LoadingOperation
}

export function LoadingOverlay({ operation }: LoadingOverlayProps) {
  const showProgress =
    !operation.indeterminate &&
    operation.total !== undefined &&
    operation.current !== undefined

  const progressPercent = showProgress
    ? Math.round((operation.current! / operation.total!) * 100)
    : 0

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 rounded-lg border bg-card p-6 shadow-lg">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <div className="text-center">
          <p className="text-lg font-medium">{operation.message}</p>
          {showProgress && (
            <div className="mt-3 w-64">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {progressPercent}% complete
              </p>
            </div>
          )}
          {operation.indeterminate && (
            <p className="mt-2 text-sm text-muted-foreground">
              This may take a moment for large datasets...
            </p>
          )}
          {operation.onCancel && (
            <div className="mt-4 flex justify-center">
              <Button type="button" variant="outline" size="sm" onClick={operation.onCancel}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
