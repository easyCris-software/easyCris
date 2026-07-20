/**
 * ValidationErrorDialog Component
 *
 * Displays validation errors, warnings, and suggestions when a test cannot run
 * or has potential issues with the selected columns/data.
 *
 * Phase -1 (Foundation Prerequisites) implementation
 * Part of the modular test validation system
 *
 * Usage:
 * ```tsx
 * const [validation, setValidation] = useState<TestValidationResult | null>(null)
 *
 * <ValidationErrorDialog
 *   open={!!validation}
 *   validation={validation}
 *   testName="Independent T-Test"
 *   onClose={() => setValidation(null)}
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertCircle, AlertTriangle, Info, XCircle } from 'lucide-react'
import type { TestValidationResult } from '@/lib/modules/core/types'

interface ValidationErrorDialogProps {
  /** Whether the dialog is open */
  open: boolean

  /** Validation result to display */
  validation: TestValidationResult | null

  /** Name of the test that failed validation */
  testName: string

  /** Callback when dialog is closed */
  onClose: () => void
}

export function ValidationErrorDialog({
  open,
  validation,
  testName,
  onClose,
}: ValidationErrorDialogProps) {
  if (!validation) {
    return null
  }

  const hasErrors = validation.errors.length > 0
  const hasWarnings = validation.warnings.length > 0
  const hasSuggestions = validation.suggestions.length > 0

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80dvh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            {hasErrors ? (
              <XCircle className="h-5 w-5 text-destructive" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
            )}
            <span>Cannot Run {testName}</span>
          </DialogTitle>
          <DialogDescription>
            The selected columns or data do not meet the requirements for this test.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain space-y-4">
          {/* Errors */}
          {hasErrors && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle className="font-semibold">
                {validation.errors.length === 1 ? 'Error' : 'Errors'}
              </AlertTitle>
              <AlertDescription>
                <ul className="list-disc list-inside space-y-1 mt-2">
                  {validation.errors.map((error, index) => (
                    <li key={index} className="text-sm">
                      {error}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {/* Warnings */}
          {hasWarnings && (
            <Alert className="border-yellow-600 text-yellow-600">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle className="font-semibold">
                {validation.warnings.length === 1 ? 'Warning' : 'Warnings'}
              </AlertTitle>
              <AlertDescription className="text-yellow-700">
                <ul className="list-disc list-inside space-y-1 mt-2">
                  {validation.warnings.map((warning, index) => (
                    <li key={index} className="text-sm">
                      {warning}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {/* Suggestions */}
          {hasSuggestions && (
            <Alert className="border-blue-600 text-blue-600">
              <Info className="h-4 w-4" />
              <AlertTitle className="font-semibold">
                {validation.suggestions.length === 1 ? 'Suggestion' : 'Suggestions'}
              </AlertTitle>
              <AlertDescription className="text-blue-700">
                <ul className="list-disc list-inside space-y-1 mt-2">
                  {validation.suggestions.map((suggestion, index) => (
                    <li key={index} className="text-sm">
                      {suggestion}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button onClick={onClose} variant="default">
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Hook for managing validation error dialog state
 *
 * Usage:
 * ```tsx
 * const { showValidation, ValidationDialog } = useValidationErrorDialog('T-Test')
 *
 * // Show dialog with validation result
 * showValidation(validationResult)
 *
 * // Render dialog
 * <ValidationDialog />
 * ```
 */
export function useValidationErrorDialog(testName: string) {
  const [validation, setValidation] = React.useState<TestValidationResult | null>(null)

  const showValidation = (result: TestValidationResult) => {
    setValidation(result)
  }

  const closeValidation = () => {
    setValidation(null)
  }

  const ValidationDialog = () => (
    <ValidationErrorDialog
      open={!!validation}
      validation={validation}
      testName={testName}
      onClose={closeValidation}
    />
  )

  return {
    showValidation,
    closeValidation,
    ValidationDialog,
    isOpen: !!validation,
  }
}

// Import React for hook
import React from 'react'
