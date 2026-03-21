/**
 * OleIntegrationDialog - First-Launch PowerPoint Integration Prompt
 *
 * Displayed on first launch (Windows only) to offer one-click registration
 * of easyCris as an OLE LocalServer, enabling double-click activation of
 * plots pasted into PowerPoint/Word.
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
import { FileSpreadsheet, Shield, X } from 'lucide-react'
import { useState } from 'react'

export type OleIntegrationChoice = 'enable' | 'later' | 'never'

interface OleIntegrationDialogProps {
  /** Whether the dialog is open */
  open: boolean

  /** Callback when user makes a choice */
  onChoice: (choice: OleIntegrationChoice) => void
}

export function OleIntegrationDialog({
  open,
  onChoice,
}: OleIntegrationDialogProps) {
  const [isEnabling, setIsEnabling] = useState(false)

  const handleEnableNow = async () => {
    setIsEnabling(true)
    try {
      // Call the Tauri command to enable OLE registration
      // The actual enablement is handled by the parent component
      onChoice('enable')
    } finally {
      setIsEnabling(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onChoice('later')}>
      <DialogContent className="max-w-lg w-full">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <FileSpreadsheet className="h-5 w-5 text-blue-500" />
            <span>Enable PowerPoint Integration?</span>
          </DialogTitle>
          <DialogDescription className="pt-2">
            easyCris can integrate with Microsoft Office applications to enable
            double-clicking plots pasted into PowerPoint or Word.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-4">
          {/* What This Does */}
          <div className="p-4 rounded-lg bg-accent/30 border border-border">
            <div className="font-medium mb-2">What this enables:</div>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>Copy plots from easyCris</li>
              <li>Paste into PowerPoint or Word</li>
              <li>Double-click the pasted plot to reopen easyCris with the data</li>
            </ul>
          </div>

          {/* Permission Notice */}
          <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <Shield className="h-5 w-5 mt-0.5 text-amber-600 flex-shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-medium text-amber-900 dark:text-amber-100">
                Administrator Permission Required
              </div>
              <div className="text-sm text-amber-800 dark:text-amber-200 mt-1">
                Windows will prompt for administrator approval to register
                easyCris as an OLE server. This is a one-time setup.
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            variant="outline"
            onClick={() => onChoice('never')}
            className="flex items-center gap-2"
          >
            <X className="h-4 w-4" />
            Never
          </Button>
          <Button
            variant="secondary"
            onClick={() => onChoice('later')}
          >
            Maybe Later
          </Button>
          <Button
            onClick={handleEnableNow}
            disabled={isEnabling}
            className="flex items-center gap-2"
          >
            <Shield className="h-4 w-4" />
            {isEnabling ? 'Enabling...' : 'Enable Now'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default OleIntegrationDialog
