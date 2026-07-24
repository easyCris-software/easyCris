/**
 * ExecutionModeDialog - Phase 2 (No-Block Execution)
 *
 * Displayed before running statistical tests on large datasets (>=1M rows).
 * Allows user to choose between:
 * - Exact Mode: Full materialization, RAM-heavy
 * - Large Mode: Streaming/out-of-core, faster, may be approximate for some tests
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Zap, Database } from 'lucide-react'

export type ExecutionMode = 'exact' | 'large' | 'cancel'

interface ExecutionModeDialogProps {
  /** Whether the dialog is open */
  open: boolean

  /** Name of the test being run */
  testName: string

  /** Approximate row count for the dataset */
  rowCount: number

  /** Callback when user selects a mode */
  onSelect: (mode: ExecutionMode) => void
}

/**
 * Format large numbers with commas for readability
 */
function formatNumber(n: number): string {
  return n.toLocaleString()
}

/**
 * Estimate RAM usage based on row count (rough heuristic)
 * Heuristic only: assumes ~1000 bytes per row materialized in exact mode.
 * Actual usage depends on column count, data types, and intermediate allocations.
 */
function estimateRamMB(rowCount: number): number {
  const bytesPerRow = 1000
  const totalBytes = rowCount * bytesPerRow
  return Math.round(totalBytes / (1024 * 1024))
}

export function ExecutionModeDialog({
  open,
  testName,
  rowCount,
  onSelect,
}: ExecutionModeDialogProps) {
  const estimatedRam = estimateRamMB(rowCount)

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onSelect('cancel')}>
      <DialogContent className="max-w-lg w-full">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            <span>Large Dataset Detected</span>
          </DialogTitle>
          <DialogDescription className="pt-2">
            The dataset has <strong>{formatNumber(rowCount)}</strong> rows.
            Choose how to run <strong>{testName}</strong>:
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-4">
          {/* Exact Mode Option */}
          <button
            onClick={() => onSelect('exact')}
            className="flex items-start gap-3 p-4 rounded-lg border border-border hover:border-primary hover:bg-accent/50 transition-colors text-left"
          >
            <Database className="h-5 w-5 mt-0.5 text-blue-500 flex-shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Exact Mode</div>
              <div className="text-sm text-muted-foreground mt-1">
                Full dataset analysis. Estimated RAM usage:
                {' '}~{formatNumber(estimatedRam)} MB.
              </div>
            </div>
          </button>

          {/* Large Mode Option */}
          <button
            onClick={() => onSelect('large')}
            className="flex items-start gap-3 p-4 rounded-lg border border-border hover:border-primary hover:bg-accent/50 transition-colors text-left"
          >
            <Zap className="h-5 w-5 mt-0.5 text-green-500 flex-shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Large Mode (Recommended)</div>
              <div className="text-sm text-muted-foreground mt-1">
                Streaming analysis for large datasets with lower memory usage.
              </div>
            </div>
          </button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onSelect('cancel')}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ExecutionModeDialog
