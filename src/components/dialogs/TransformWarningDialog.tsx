/**
 * TransformWarningDialog Component
 *
 * Warning dialog for data transforms (pivot wider/longer, filter, group & aggregate).
 * Offers two modes:
 * - Transform in-place (destructive, with undo)
 * - Create new family (non-destructive, preserves original)
 *
 * Usage:
 * ```tsx
 * <TransformWarningDialog
 *   open={showDialog}
 *   transformType="pivot_wider"
 *   onConfirm={(mode) => handleTransform(mode)}
 *   onCancel={() => console.log('Cancelled')}
 * />
 * ```
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
import { AlertTriangle, FolderPlus, RefreshCw } from 'lucide-react'
import { getTransformLabel } from '@/lib/grid/getTransformLabel'

export type TransformMode = 'in-place' | 'new-family'

interface TransformWarningDialogProps {
  /** Whether the dialog is open */
  open: boolean

  /** Type of transform being applied */
  transformType: 'pivot_wider' | 'pivot_longer' | 'filter' | 'group_aggregate'

  /** Callback when user confirms - receives the chosen mode */
  onConfirm: (mode: TransformMode) => void

  /** Callback when user cancels */
  onCancel: () => void

  /** Disable creating a new family (e.g., RNA-seq datasets) */
  disableNewFamily?: boolean
  /** Optional reason shown when new-family is disabled */
  disableNewFamilyReason?: string
}

export function TransformWarningDialog({
  open,
  transformType,
  onConfirm,
  onCancel,
  disableNewFamily = false,
  disableNewFamilyReason,
}: TransformWarningDialogProps) {
  const transformLabel = getTransformLabel(transformType)

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <DialogContent className="max-w-2xl w-full">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <AlertTriangle className="h-5 w-5 text-orange-500" />
            <span>Apply {transformLabel}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Choose how to apply the data transform.
          </DialogDescription>
        </DialogHeader>

        <div className="pt-4 space-y-4 text-sm">
          <div className="text-muted-foreground">
            Choose how to apply <strong>{transformLabel}</strong> to your data:
          </div>

          {/* Option 1: New Family (Recommended) */}
          <div
            className={[
              'border rounded-lg p-4 space-y-2 bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800',
              disableNewFamily ? 'opacity-60' : '',
            ].join(' ')}
          >
            <div className="flex items-center gap-2 font-medium text-green-800 dark:text-green-200">
              <FolderPlus className="h-4 w-4" />
              <span>Create New Family (Recommended)</span>
            </div>
            <ul className="list-disc list-inside text-xs text-green-700 dark:text-green-300 space-y-1 ml-6">
              <li>Creates a new Statistics family with the transformed data</li>
              <li>Original data remains untouched in current family</li>
              <li>Safe for exploratory analysis</li>
            </ul>
            {disableNewFamilyReason && (
              <p className="text-xs text-green-700 dark:text-green-300 ml-6">
                {disableNewFamilyReason}
              </p>
            )}
          </div>

          {/* Option 2: In-Place */}
          <div className="border rounded-lg p-4 space-y-2 bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800">
            <div className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-200">
              <RefreshCw className="h-4 w-4" />
              <span>Transform In-Place</span>
            </div>
            <ul className="list-disc list-inside text-xs text-amber-700 dark:text-amber-300 space-y-1 ml-6">
              <li>Replaces data in current family</li>
              <li>Can undo via "Data → Undo Transform" (one level only)</li>
              <li>Clears any existing analysis results</li>
            </ul>
          </div>
        </div>

        <DialogFooter className="gap-2 w-full flex-col sm:flex-row sm:justify-end pt-2">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => onConfirm('in-place')}
            className="border-amber-300 dark:border-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Transform In-Place
          </Button>
          <Button
            onClick={() => onConfirm('new-family')}
            className="bg-green-600 hover:bg-green-700 text-white"
            disabled={disableNewFamily}
          >
            <FolderPlus className="h-4 w-4 mr-2" />
            Create New Family
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
