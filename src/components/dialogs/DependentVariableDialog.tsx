/**
 * Dependent Variable Dialog
 *
 * Allows users to select which column is the dependent variable (outcome)
 * from multiple selected columns. Replicates Avalonia's DependentVariableDialog.
 *
 * Reference: C:\Users\RajLord_new\Desktop\Bmad_project\easyCris.Avalonia\Views\StatisticalAnalysis\DependentVariableDialog.axaml.cs
 * Lines: 295 lines, 3571/12978 bytes
 *
 * Features:
 * - Radio button selection of DV
 * - Mode-specific instructions (ANOVA, Linear Regression, Logistic Regression)
 * - Visual indicators: green (ideal), yellow (usable), red (unsuitable)
 * - Shows column metadata: type, levels, sample values
 */

import { useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { CheckCircle2, AlertCircle, XCircle } from 'lucide-react'

const ANOVA_DEPENDENT_VAR_GUIDANCE =
  'Select the numeric outcome variable as the dependent variable. The remaining categorical variables (with 2-5 levels) will be used as factors.'

/**
 * Dialog modes - determines instructions and validation rules
 * Maps to Avalonia's DependentVariableDialogMode enum
 */
export enum DependentVariableDialogMode {
  AnovaOrFriedman = 'anova',
  RegressionNumericOutcome = 'linear',
  RegressionCategoricalOutcome = 'logistic',
  RegressionMixedOutcome = 'mixed',
}

/**
 * Column metadata for display
 */
export interface ColumnMetadata {
  columnName: string
  dataType: string
  uniqueValueCount: number
  levels?: string[] // For categorical columns
}

/**
 * Suitability assessment
 */
interface ColumnSuitability {
  level: 'ideal' | 'usable' | 'unsuitable'
  icon: typeof CheckCircle2
  color: string
  message: string
}

interface DependentVariableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  columns: ColumnMetadata[]
  mode: DependentVariableDialogMode
  onConfirm: (selectedVariable: string) => void
  onCancel: () => void
}

/**
 * Get column suitability for selected test type
 * Replicates Avalonia logic from lines 102-215
 */
function getColumnSuitability(
  column: ColumnMetadata,
  mode: DependentVariableDialogMode
): ColumnSuitability {
  const isNumeric = column.dataType === 'Numeric'
  const isCategorical = column.dataType === 'Categorical' || column.dataType === 'Binary'
  const levelCount = column.uniqueValueCount

  switch (mode) {
    case DependentVariableDialogMode.RegressionCategoricalOutcome:
      if (isCategorical) {
        return {
          level: 'ideal',
          icon: CheckCircle2,
          color: 'text-green-600',
          message: '✓ Categorical outcome (ideal for logistic regression)',
        }
      } else {
        return {
          level: 'unsuitable',
          icon: XCircle,
          color: 'text-red-600',
          message: '⚠ Numeric value (logistic regression expects a categorical/binary outcome)',
        }
      }

    case DependentVariableDialogMode.RegressionNumericOutcome:
      if (isNumeric) {
        return {
          level: 'ideal',
          icon: CheckCircle2,
          color: 'text-green-600',
          message: '✓ Numeric/Continuous outcome (ideal for linear regression)',
        }
      } else {
        const msg =
          levelCount <= 5
            ? `Categorical (${levelCount} levels) - linear regression expects a numeric outcome`
            : `⚠ Categorical (${levelCount} levels) - unsuitable as linear regression outcome`
        return {
          level: 'usable',
          icon: AlertCircle,
          color: 'text-orange-600',
          message: msg,
        }
      }

    case DependentVariableDialogMode.RegressionMixedOutcome:
      if (isNumeric) {
        return {
          level: 'ideal',
          icon: CheckCircle2,
          color: 'text-green-600',
          message: 'Numeric/Continuous outcome (usable for linear regression)',
        }
      } else {
        const msg =
          levelCount <= 5
            ? `Categorical (${levelCount} levels) - usable for logistic regression`
            : `⚠ Categorical (${levelCount} levels) - many levels; consider grouping for logistic regression`
        return {
          level: levelCount <= 5 ? 'ideal' : 'usable',
          icon: levelCount <= 5 ? CheckCircle2 : AlertCircle,
          color: levelCount <= 5 ? 'text-green-600' : 'text-orange-600',
          message: msg,
        }
      }

    default: // AnovaOrFriedman
      if (isNumeric) {
        return {
          level: 'ideal',
          icon: CheckCircle2,
          color: 'text-green-600',
          message: '✓ Numeric/Continuous (suitable as dependent variable)',
        }
      } else {
        if (levelCount <= 5) {
          return {
            level: 'usable',
            icon: AlertCircle,
            color: 'text-orange-600',
            message: `Categorical (${levelCount} levels) - better as factor variable`,
          }
        } else {
          return {
            level: 'unsuitable',
            icon: XCircle,
            color: 'text-red-600',
            message: `⚠ Categorical (${levelCount} levels) - too many for ANOVA factor`,
          }
        }
      }
  }
}

/**
 * Get header text based on mode
 */
function getHeaderText(mode: DependentVariableDialogMode): string {
  switch (mode) {
    case DependentVariableDialogMode.RegressionNumericOutcome:
      return 'Select Outcome Variable (Linear Regression)'
    case DependentVariableDialogMode.RegressionCategoricalOutcome:
      return 'Select Outcome Variable (Logistic Regression)'
    case DependentVariableDialogMode.RegressionMixedOutcome:
      return 'Select Outcome Variable (Regression)'
    default:
      return 'Select Dependent Variable'
  }
}

/**
 * Get primary instruction text
 */
function getPrimaryInstruction(mode: DependentVariableDialogMode): string {
  switch (mode) {
    case DependentVariableDialogMode.RegressionNumericOutcome:
      return 'Choose the numeric/continuous outcome you want to predict. Remaining selected columns become predictors.'
    case DependentVariableDialogMode.RegressionCategoricalOutcome:
      return 'Choose the categorical (binary or multi-class) outcome you want to model. Remaining columns will be treated as predictors.'
    case DependentVariableDialogMode.RegressionMixedOutcome:
      return 'Choose the column you want to predict. Linear regression tests expect a numeric outcome, logistic regression tests expect a categorical outcome.'
    default:
      return 'Choose the numeric outcome variable as dependent. The remaining categorical variables (with 2-5 levels) will be used as factors.'
  }
}

/**
 * Get secondary instruction text and color
 */
function getSecondaryInstruction(mode: DependentVariableDialogMode): {
  text: string
  color: string
} {
  switch (mode) {
    case DependentVariableDialogMode.RegressionNumericOutcome:
      return {
        text: 'Tip: Linear regression expects a continuous dependent variable. Categorical predictors will be automatically encoded using your selected baselines.',
        color: 'text-green-700 bg-green-50',
      }
    case DependentVariableDialogMode.RegressionCategoricalOutcome:
      return {
        text: 'Tip: Logistic regression requires a categorical dependent variable. Use at least two levels; baselines will be selected in the next step.',
        color: 'text-green-700 bg-green-50',
      }
    case DependentVariableDialogMode.RegressionMixedOutcome:
      return {
        text: 'Tip: If you selected both linear and logistic models, run them separately to use the most appropriate dependent variable type for each.',
        color: 'text-orange-700 bg-orange-50',
      }
    default:
      return {
        text: ANOVA_DEPENDENT_VAR_GUIDANCE,
        color: 'text-blue-700 bg-blue-50',
      }
  }
}

/**
 * Dependent Variable Dialog Component
 */
export function DependentVariableDialog({
  open,
  onOpenChange,
  columns,
  mode,
  onConfirm,
  onCancel,
}: DependentVariableDialogProps) {
  // Auto-select first ideal column (matches Avalonia UX)
  const [selectedVariable, setSelectedVariable] = useState<string>(() => {
    const sortedColumns = [...columns].sort((a, b) => {
      const suitA = getColumnSuitability(a, mode)
      const suitB = getColumnSuitability(b, mode)
      const levelOrder = { ideal: 0, usable: 1, unsuitable: 2 }
      return levelOrder[suitA.level] - levelOrder[suitB.level]
    })
    return (
      sortedColumns.find((c) => getColumnSuitability(c, mode).level === 'ideal')?.columnName ??
      sortedColumns[0]?.columnName ??
      ''
    )
  })

  const handleConfirm = useCallback(() => {
    if (selectedVariable) {
      onConfirm(selectedVariable)
      onOpenChange(false)
    }
  }, [selectedVariable, onConfirm, onOpenChange])

  const handleCancel = useCallback(() => {
    onCancel()
    onOpenChange(false)
  }, [onCancel, onOpenChange])

  const headerText = getHeaderText(mode)
  const primaryInstruction = getPrimaryInstruction(mode)
  const secondaryInstruction = getSecondaryInstruction(mode)

  // Sort columns: preferred types first
  const sortedColumns = [...columns].sort((a, b) => {
    const suitA = getColumnSuitability(a, mode)
    const suitB = getColumnSuitability(b, mode)

    // Ideal > Usable > Unsuitable
    const levelOrder = { ideal: 0, usable: 1, unsuitable: 2 }
    return levelOrder[suitA.level] - levelOrder[suitB.level]
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80dvh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">{headerText}</DialogTitle>
          <DialogDescription className="text-sm text-gray-600">
            {primaryInstruction}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain space-y-6">
          {/* Secondary instruction banner */}
          <div className={`rounded-md p-3 text-sm ${secondaryInstruction.color}`}>
            {secondaryInstruction.text}
          </div>

          {/* Column selection */}
          <TooltipProvider>
            <RadioGroup value={selectedVariable} onValueChange={setSelectedVariable}>
              <div className="space-y-3">
                {sortedColumns.map((column) => {
                  const suitability = getColumnSuitability(column, mode)
                  const Icon = suitability.icon
                  const isIdeal = suitability.level === 'ideal'
                  const isUnsuitable = suitability.level === 'unsuitable'

                  return (
                    <div
                      key={column.columnName}
                      className={`rounded-lg border-2 p-4 transition-colors ${
                        isIdeal
                          ? 'bg-green-50 border-green-200'
                          : isUnsuitable
                            ? 'bg-red-50 border-red-200 opacity-60'
                            : 'bg-gray-50 border-gray-200'
                      }`}
                    >
                      <div className="flex items-start space-x-3">
                        {isUnsuitable ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div>
                                <RadioGroupItem
                                  value={column.columnName}
                                  id={column.columnName}
                                  className="mt-1"
                                  disabled={true}
                                />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p className="text-sm">
                                This column type is unsuitable for this analysis type.
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <RadioGroupItem
                            value={column.columnName}
                            id={column.columnName}
                            className="mt-1"
                          />
                        )}
                        <div className="flex-1 space-y-2">
                          <Label
                            htmlFor={column.columnName}
                            className={`font-semibold text-base ${isUnsuitable ? 'cursor-not-allowed text-gray-500' : 'cursor-pointer'}`}
                          >
                            {column.columnName}
                          </Label>

                          {/* Type info with icon */}
                          <div className={`flex items-center space-x-2 text-sm ${suitability.color}`}>
                            <Icon className="h-4 w-4" />
                            <span>{suitability.message}</span>
                          </div>

                          {/* Show levels for categorical columns */}
                          {column.levels && column.levels.length > 0 && column.levels.length <= 10 && (
                            <div className="text-xs text-gray-500">
                              Levels: {column.levels.join(', ')}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </RadioGroup>
          </TooltipProvider>

          {/* Explanation footer */}
          <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
            <p className="italic">
              {mode === DependentVariableDialogMode.RegressionNumericOutcome &&
                'Linear regression: choose the continuous outcome you want to predict. All remaining selected columns become predictors.'}
              {mode === DependentVariableDialogMode.RegressionCategoricalOutcome &&
                'Logistic regression: choose the categorical/binary outcome. Remaining columns will be encoded as predictors; you will pick baselines next.'}
              {mode === DependentVariableDialogMode.RegressionMixedOutcome &&
                'You selected both linear and logistic regression tests. Pick the outcome best suited to the model you intend to run (numeric for linear, categorical for logistic).'}
              {mode === DependentVariableDialogMode.AnovaOrFriedman &&
                ANOVA_DEPENDENT_VAR_GUIDANCE}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!selectedVariable}>
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
