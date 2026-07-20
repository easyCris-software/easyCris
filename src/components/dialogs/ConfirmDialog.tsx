/**
 * ConfirmDialog Component
 *
 * Generic confirmation dialog for user actions that require acknowledgment.
 * Displays a title, message, and confirm/cancel buttons.
 *
 * Usage:
 * ```tsx
 * <ConfirmDialog
 *   open={showDialog}
 *   title="Confirm Action"
 *   message="Are you sure you want to proceed?"
 *   confirmLabel="Yes, proceed"
 *   cancelLabel="No, cancel"
 *   onConfirm={() => console.log('Confirmed')}
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
import { AlertCircle } from 'lucide-react'

interface ConfirmDialogProps {
  /** Whether the dialog is open */
  open: boolean

  /** Dialog title */
  title: string

  /** Dialog message/description */
  message: string

  /** Label for confirm button */
  confirmLabel: string

  /** Label for cancel button */
  cancelLabel: string

  /** Callback when user confirms */
  onConfirm: () => void

  /** Callback when user cancels */
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <DialogContent className="max-w-2xl w-full">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <AlertCircle className="h-5 w-5 text-orange-500" />
            <span>{title}</span>
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line pt-4">
            {message}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-3 w-full flex-col sm:flex-row sm:flex-wrap sm:justify-end">
          <Button
            className="w-full sm:w-auto text-left whitespace-normal leading-snug"
            variant="outline"
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            className="w-full sm:w-auto text-left whitespace-normal leading-snug"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
