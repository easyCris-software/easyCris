/**
 * Dependent Variable Encoding Dialog
 *
 * Allows users to configure encoding for categorical dependent variables
 * in logistic regression. Handles both binary (2 levels) and multinomial (3+ levels).
 *
 * Reference: C:\Users\RajLord_new\Desktop\Bmad_project\easyCris.Avalonia\Views\StatisticalAnalysis\DependentVariableEncodingDialog.axaml.cs
 * Lines: 220 lines
 *
 * Features:
 * - Binary mode: Select "success" category (encoded as 1, other as 0)
 * - Multinomial mode: Select baseline category (encoded as 0, others as 1,2,3...)
 * - Live encoding preview: "Control = 0 (baseline), Treatment = 1"
 * - Test type description (binary vs multinomial logistic)
 */

import { useState, useCallback, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'

interface DependentVariableEncodingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  columnName: string
  categories: string[]
  testType: 'binary' | 'multinomial'
  onConfirm: (encodingMapping: Map<string, number>) => void
  onCancel: () => void
}

/**
 * Dependent Variable Encoding Dialog Component
 */
export function DependentVariableEncodingDialog({
  open,
  onOpenChange,
  columnName,
  categories,
  testType,
  onConfirm,
  onCancel,
}: DependentVariableEncodingDialogProps) {
  const isBinary = testType === 'binary' || categories.length === 2

  // For binary: selected category = 1 (success)
  // For multinomial: selected category = 0 (baseline)
  const [selectedCategory, setSelectedCategory] = useState<string>(() => categories[0] ?? '')

  // Update selection if categories change
  useEffect(() => {
    if (categories.length > 0 && !categories.includes(selectedCategory)) {
      setSelectedCategory(categories[0] ?? '')
    }
  }, [categories, selectedCategory])

  /**
   * Generate encoding preview text
   * Replicates Avalonia UpdateEncodingPreview() (lines 121-162)
   */
  const getEncodingPreview = useCallback((): string => {
    if (!selectedCategory) return ''

    if (isBinary) {
      // Binary: success=1, failure=0
      const success = selectedCategory
      const failure = categories.find((c) => c !== success)
      if (!failure) return ''
      return `${success} = 1 (success/event), ${failure} = 0 (baseline/non-event)`
    } else {
      // Multinomial: baseline=0, others=1,2,3...
      const baseline = selectedCategory
      const encoding: string[] = []

      encoding.push(`${baseline} = 0 (baseline/reference)`)

      let code = 1
      for (const category of categories) {
        if (category !== baseline) {
          encoding.push(`${category} = ${code}`)
          code++
        }
      }

      return encoding.join(', ')
    }
  }, [selectedCategory, categories, isBinary])

  /**
   * Build encoding mapping
   * Replicates Avalonia OkButton_Click (lines 164-212)
   */
  const buildEncodingMapping = useCallback((): Map<string, number> => {
    const mapping = new Map<string, number>()

    if (isBinary) {
      // Binary logistic: success=1, failure=0
      const success = selectedCategory || categories[0] || ''
      const failure = categories.find((c) => c !== success)

      if (success) mapping.set(success, 1)
      if (failure) mapping.set(failure, 0)
    } else {
      // Multinomial logistic: baseline=0, others=1,2,3...
      const baseline = selectedCategory || categories[0] || ''

      if (baseline) {
        mapping.set(baseline, 0)

        let code = 1
        for (const category of categories) {
          if (category !== baseline) {
            mapping.set(category, code)
            code++
          }
        }
      }
    }

    return mapping
  }, [selectedCategory, categories, isBinary])

  const handleConfirm = useCallback(() => {
    const encoding = buildEncodingMapping()
    onConfirm(encoding)
    onOpenChange(false)
  }, [buildEncodingMapping, onConfirm, onOpenChange])

  const handleCancel = useCallback(() => {
    onCancel()
    onOpenChange(false)
  }, [onCancel, onOpenChange])

  const testTypeDescription = isBinary
    ? 'Binary logistic regression predicts the probability of a binary outcome (success/failure, yes/no, 0/1).'
    : `Multinomial logistic regression predicts the probability of ${categories.length} different outcomes, with one serving as the baseline.`

  const headerText = isBinary
    ? 'Encode Dependent Variable - Binary Logistic Regression'
    : 'Encode Dependent Variable - Multinomial Logistic Regression'

  const selectionLabel = isBinary
    ? 'Select Success Category (coded as 1):'
    : 'Select Baseline Category (coded as 0):'

  const selectionDescription = isBinary
    ? 'The selected category will be coded as 1 (success/event). The other category will be coded as 0 (baseline/non-event).'
    : 'The selected category will be coded as 0 and used as the reference/baseline. All other categories will be compared against it.'

  const encodingPreview = getEncodingPreview()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl w-[95vw] max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6 pb-3 border-b border-gray-200 shrink-0">
          <DialogTitle className="text-xl font-semibold">{headerText}</DialogTitle>
          <DialogDescription className="text-sm text-gray-600">
            {testTypeDescription}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-6 py-4">
        <div className="space-y-6">
          {/* Column info */}
          <div className="rounded-md bg-gray-50 border border-gray-200 p-3">
            <div className="text-sm font-medium text-gray-700">Column: {columnName}</div>
            <div className="text-xs text-gray-500 mt-1">
              Detected {categories.length} categories: {categories.join(', ')}
            </div>
          </div>

          {/* Selection panel */}
          <div className="space-y-3">
            <div>
              <Label htmlFor="category-select" className="text-sm font-medium">
                {selectionLabel}
              </Label>
              <p className="text-xs text-gray-500 mt-1">{selectionDescription}</p>
            </div>

            <Select value={selectedCategory} onValueChange={setSelectedCategory}>
              <SelectTrigger id="category-select" className="w-full">
                <SelectValue placeholder="Select category..." />
              </SelectTrigger>
              <SelectContent>
                {categories.map((category) => (
                  <SelectItem key={category} value={category}>
                    {category}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Encoding preview */}
          {encodingPreview && (
            <div className="rounded-md bg-blue-50 border border-blue-200 p-4">
              <div className="text-sm font-medium text-blue-900 mb-2">Encoding Preview:</div>
              <div className="text-sm text-blue-800 font-mono">{encodingPreview}</div>
            </div>
          )}

          {/* Explanation */}
          <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
            <p className="font-medium mb-1">
              {isBinary ? 'Binary Encoding:' : 'Multinomial Encoding:'}
            </p>
            <p className="text-xs">
              {isBinary
                ? 'The success category (1) will be predicted relative to the baseline (0). Positive coefficients indicate increased odds of success.'
                : 'All categories will be compared to the baseline (0). Coefficients represent the log-odds of each category relative to the baseline.'}
            </p>
          </div>
        </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t border-gray-200 shrink-0">
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!selectedCategory}>
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
