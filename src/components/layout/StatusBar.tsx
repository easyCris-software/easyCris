/**
 * StatusBar Component
 *
 * Bottom status bar showing real-time application state:
 * - Current dataset info (rows, columns)
 * - Selected cell/range info
 * - Current statistical test
 * - Python backend health
 * - General status messages
 *
 * Phase 3B Step 5 implementation.
 * Binds to app-store, data-store, and analysis-store for live updates.
 */

import { Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'
import { useDataStore } from '@/store/data-store'
import { useAnalysisStore } from '@/store/analysis-store'

interface StatusBarProps {
  className?: string
}

export function StatusBar({ className }: StatusBarProps) {
  const { statusMessage, pythonStatus } = useAppStore()
  const { currentDataset, getSelectionSummary, selectionStats } = useDataStore()
  const { selectedTest, execution } = useAnalysisStore()

  // Get selection summary using the flag-aware helper
  const selectionSummary = getSelectionSummary()
  const selectionInfo = selectionSummary?.description || null

  const selectionStatsInfo = selectionStats
    ? `Σ ${formatMetric(selectionStats.sum)}  Avg ${formatMetric(selectionStats.avg)}  Count ${selectionStats.count}  Min ${formatMetric(selectionStats.min)}  Max ${formatMetric(selectionStats.max)}${selectionStats.partial ? ' (partial)' : ''}`
    : null

  // Format test execution status
  const getTestStatus = () => {
    if (!selectedTest) return null

    if (execution.status === 'running') {
      return `Running: ${selectedTest.name} (${execution.progress}%)`
    }
    if (execution.status === 'validating') {
      return `Validating: ${selectedTest.name}`
    }
    if (execution.status === 'completed') {
      return `Completed: ${selectedTest.name}`
    }
    if (execution.status === 'failed') {
      return `Failed: ${selectedTest.name}`
    }

    return `Selected: ${selectedTest.name}`
  }

  const testStatus = getTestStatus()

  return (
    <div
      className={cn(
        'flex h-6 items-center justify-between bg-background border-t border-border px-3 text-xs',
        className
      )}
    >
      {/* Left Section: Status Message */}
      <div className="flex items-center gap-4 flex-1 min-w-0">
        {/* General Status Message */}
        <div className="text-foreground truncate">
          {statusMessage || 'Ready'}
        </div>

        {/* Dataset Info */}
        {currentDataset && (
          <div className="text-muted-foreground">
            {currentDataset.name} - {currentDataset.rowCount.toLocaleString()} rows x{' '}
            {currentDataset.columns.length} columns
          </div>
        )}

        {/* Selection Info */}
        {selectionInfo && (
          <div className="text-muted-foreground truncate">
            {selectionInfo}
          </div>
        )}
        {selectionStatsInfo && (
          <div className="text-muted-foreground truncate">
            {selectionStatsInfo}
          </div>
        )}
      </div>

      {/* Right Section: Test Status & Python Health */}
      <div className="flex items-center gap-4 shrink-0">
        {/* Current Test Status */}
        {testStatus && (
          <div
            className={cn(
              'text-muted-foreground',
              execution.status === 'running' && 'text-[#F18F01] font-medium',
              execution.status === 'completed' && 'text-[#06A77D]',
              execution.status === 'failed' && 'text-destructive'
            )}
          >
            {testStatus}
          </div>
        )}

        {/* Python Health Status */}
        {pythonStatus && (
          <div className="flex items-center gap-1.5">
            <Circle
              className={cn(
                'h-2 w-2 fill-current',
                pythonStatus.available
                  ? 'text-[#06A77D]'
                  : 'text-destructive'
              )}
            />
            <span
              className={cn(
                'text-muted-foreground',
                !pythonStatus.available && 'text-destructive'
              )}
            >
              Python {pythonStatus.version || 'N/A'}
              {!pythonStatus.available && ' (Unavailable)'}
            </span>
          </div>
        )}

        {/* Memory/Performance (Future Enhancement) */}
        {/* <div className="text-muted-foreground">
          Memory: 245 MB
        </div> */}
      </div>
    </div>
  )
}

export default StatusBar

function formatMetric(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? value.toString() : Number(value.toFixed(6)).toString()
}
