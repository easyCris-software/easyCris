/**
 * TestSelectionDialog Component
 *
 * Modal dialog for selecting a statistical test from the complete test hierarchy.
 * Wraps the existing StatisticalTestsNav component.
 *
 * Mirrors Avalonia's TestSelectionDialog.axaml architecture.
 * Phase 3B Step 7 implementation.
 *
 * Usage:
 * ```tsx
 * const [open, setOpen] = useState(false)
 * <TestSelectionDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   onConfirm={() => {
 *     // Proceed with selected test from analysis-store
 *   }}
 * />
 * ```
 */

import {
  ResizableDialog,
  ResizableDialogContent,
  ResizableDialogDescription,
  ResizableDialogFooter,
  ResizableDialogHeader,
  ResizableDialogTitle,
} from '@/components/ui/resizable-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { CheckCircle2, AlertCircle } from 'lucide-react'
import { StatisticalTestsNav } from '@/components/layout/StatisticalTestsNav'
import { useAnalysisStore } from '@/store/analysis-store'
import { useDataStore } from '@/store/data-store'

interface TestSelectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm?: () => void
  onCancel?: () => void
}

export function TestSelectionDialog({
  open,
  onOpenChange,
  onConfirm,
  onCancel,
}: TestSelectionDialogProps) {
  const { selectedTest } = useAnalysisStore()
  const { currentDataset } = useDataStore()

  const handleConfirm = () => {
    if (selectedTest) {
      onConfirm?.()
      onOpenChange(false)
    }
  }

  const handleCancel = () => {
    onCancel?.()
    onOpenChange(false)
  }

  // Check compatibility (basic check - can be enhanced)
  const dataset = currentDataset ?? null
  const actualRowCount = dataset?.dataRowCount ?? dataset?.rowCount ?? 0
  const columnCount = dataset?.columns.length ?? 0
  const hasData = Boolean(dataset && actualRowCount > 0)
  const hasCompatibleData = hasData && columnCount > 0

  return (
    <ResizableDialog
      open={open}
      onOpenChange={onOpenChange}
      defaultWidth={900}
      defaultHeight={800}
      minWidth={700}
      minHeight={600}
      persistKey="test-selection"
    >
      <ResizableDialogContent className="flex flex-col p-0">
        <ResizableDialogHeader className="px-6 pt-6 pb-4 border-b">
          <ResizableDialogTitle className="text-xl">Select Statistical Test</ResizableDialogTitle>
          <ResizableDialogDescription>
            Choose a test from the categories below. Tests are organized by family and
            analysis type.
          </ResizableDialogDescription>

          {/* Data Compatibility Info */}
          <div className="pt-4 space-y-2">
            {!hasData && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  No dataset loaded. Import data before selecting a test.
                </AlertDescription>
              </Alert>
            )}

            {dataset && hasData && (
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span className="text-sm text-muted-foreground">
                  Dataset loaded: {dataset.name}
                </span>
                <Badge variant="outline" className="ml-auto">
                  {actualRowCount.toLocaleString()} rows ×{' '}
                  {columnCount} columns
                </Badge>
              </div>
            )}

            {selectedTest && (
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-[#2E86AB]" />
                <span className="text-sm font-medium">
                  Selected: {selectedTest.name}
                </span>
                <Badge variant="secondary" className="ml-auto">
                  {selectedTest.family}
                </Badge>
              </div>
            )}
          </div>
        </ResizableDialogHeader>

        {/* Test Navigation (scrollable) */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <StatisticalTestsNav className="h-full" />
        </div>

        {/* Footer with actions */}
        <ResizableDialogFooter className="px-6 py-4 border-t">
          <div className="flex items-center justify-between w-full">
            {/* Left: Selection info */}
            <div className="text-sm text-muted-foreground">
              {selectedTest ? (
                <span>
                  <span className="font-medium text-foreground">
                    {selectedTest.name}
                  </span>{' '}
                  selected
                </span>
              ) : (
                <span>No test selected</span>
              )}
            </div>

            {/* Right: Action buttons */}
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleCancel}>
                Cancel
              </Button>
              <Button
                data-testid="confirm-test-selection"
                onClick={handleConfirm}
                disabled={!selectedTest || !hasCompatibleData}
              >
                Select a Test
              </Button>
            </div>
          </div>
        </ResizableDialogFooter>
      </ResizableDialogContent>
    </ResizableDialog>
  )
}

export default TestSelectionDialog
