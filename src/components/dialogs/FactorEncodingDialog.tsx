/**
 * Factor Encoding Dialog
 *
 * Regression-only baseline selector for categorical predictors.
 * Applies to: Linear Regression, Multiple Regression, Logistic Regression (binary + multinomial).
 *
 * ANOVA paths NEVER use this dialog because effect coding is automatic.
 *
 * Features:
 * - Per-factor baseline selection (dropdown for each categorical predictor)
 * - Binary variables: Choose reference = 0 (other = 1)
 * - Multi-categorical: Show alphabetical encoding (0, 1, 2...)
 * - Live encoding preview updates on change
 * - Dummy variable creation for regression models
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
// REMOVED: Checkbox import - no longer needed (simple effects removed)
// REMOVED: SimpleEffectConfig - This dialog is for REGRESSION ONLY (baseline selection for dummy variables)

/**
 * Factor metadata
 */
export interface FactorMetadata {
  columnName: string
  levels: string[]
}

interface FactorEncodingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  factors: FactorMetadata[]
  // REMOVED: showSimpleEffects - Dialog is for regression only, not ANOVA
  onConfirm: (result: {
    encodingMappings: Map<string, Map<string, number>>
    // REMOVED: simpleEffects - Not needed for regression
  }) => void
  onCancel: () => void
}

/**
 * Factor card component with baseline selection
 */
function FactorCard({
  factor,
  baselineLevel,
  onBaselineChange,
}: {
  factor: FactorMetadata
  baselineLevel: string
  onBaselineChange: (level: string) => void
}) {
  const isBinary = factor.levels.length === 2

  // Generate encoding preview (always shown)
  const getEncodingPreview = (): string => {
    if (isBinary) {
      const baseline = baselineLevel
      const other = factor.levels.find(l => l !== baseline)
      if (!other) return ''
      return `${baseline} = 0 (baseline/reference), ${other} = 1`
    } else {
      // Multi-categorical: alphabetical encoding
      const sortedLevels = [...factor.levels].sort()
      const baseline = baselineLevel

      // Move baseline to front
      const orderedLevels = [
        baseline,
        ...sortedLevels.filter(l => l !== baseline),
      ]

      return orderedLevels.map((level, idx) => `${level} = ${idx}`).join(', ')
    }
  }

  const encodingPreview = getEncodingPreview()

  return (
    <div className="rounded-lg border-2 border-border bg-muted/40 p-4 space-y-3">
      {/* Factor name and level count */}
      <div>
        <div className="font-semibold text-base">{factor.columnName}</div>
        <div className="text-xs text-muted-foreground">
          {factor.levels.length} levels: {factor.levels.join(', ')}
        </div>
      </div>

      {/* Baseline selection (for binary variables) */}
      {isBinary && (
        <div className="space-y-2">
          <Label
            htmlFor={`${factor.columnName}-baseline`}
            className="text-sm font-medium"
          >
            Select baseline (reference = 0):
          </Label>
          <Select value={baselineLevel} onValueChange={onBaselineChange}>
            <SelectTrigger id={`${factor.columnName}-baseline`}>
              <SelectValue placeholder="Select baseline..." />
            </SelectTrigger>
            <SelectContent>
              {factor.levels.map(level => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Multi-categorical info */}
      {!isBinary && (
        <div className="text-xs text-muted-foreground">
          Multi-categorical factors use alphabetical encoding (baseline always =
          0)
        </div>
      )}

      {/* Encoding preview */}
      {encodingPreview && (
        <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-2 text-xs text-blue-800 dark:text-blue-200 font-mono">
          {encodingPreview}
        </div>
      )}
    </div>
  )
}

/**
 * Factor Encoding Dialog Component
 */
export function FactorEncodingDialog({
  open,
  onOpenChange,
  factors,
  // REMOVED: showSimpleEffects - Dialog is for regression only
  onConfirm,
  onCancel,
}: FactorEncodingDialogProps) {
  // Baseline selections (factor name -> baseline level)
  const [baselineSelections, setBaselineSelections] = useState<
    Map<string, string>
  >(() => {
    const map = new Map<string, string>()
    factors.forEach(f => {
      // Default to first level alphabetically
      const sortedLevels = [...f.levels].sort()
      map.set(f.columnName, sortedLevels[0] ?? f.levels[0] ?? '')
    })
    return map
  })

  // REMOVED: Simple effects state - Dialog is for regression only (dummy variables), not ANOVA

  const handleBaselineChange = useCallback(
    (factorName: string, baseline: string) => {
      setBaselineSelections(prev => {
        const newMap = new Map(prev)
        newMap.set(factorName, baseline)
        return newMap
      })
    },
    []
  )

  /**
   * Build encoding mappings
   * Replicates Avalonia OkButton_Click
   * Always builds mappings for all factors (baseline controls always shown)
   */
  const buildEncodingMappings = useCallback((): Map<
    string,
    Map<string, number>
  > => {
    const mappings = new Map<string, Map<string, number>>()

    factors.forEach(factor => {
      const factorMapping = new Map<string, number>()
      const baseline =
        baselineSelections.get(factor.columnName) ?? factor.levels[0] ?? ''

      if (baseline) {
        if (factor.levels.length === 2) {
          // Binary: baseline=0, other=1
          factorMapping.set(baseline, 0)
          const other = factor.levels.find(l => l !== baseline)
          if (other) factorMapping.set(other, 1)
        } else {
          // Multi-categorical: alphabetical encoding with baseline=0
          const sortedLevels = [...factor.levels].sort()
          factorMapping.set(baseline, 0)

          let code = 1
          for (const level of sortedLevels) {
            if (level !== baseline) {
              factorMapping.set(level, code)
              code++
            }
          }
        }
      }

      mappings.set(factor.columnName, factorMapping)
    })

    return mappings
  }, [factors, baselineSelections])

  // REMOVED: buildSimpleEffects - Dialog is for regression only (dummy variables), not ANOVA

  const handleConfirm = useCallback(() => {
    const encodingMappings = buildEncodingMappings()
    // REMOVED: simpleEffects - Not needed for regression

    onConfirm({ encodingMappings })
    onOpenChange(false)
  }, [buildEncodingMappings, onConfirm, onOpenChange])

  const handleCancel = useCallback(() => {
    onCancel()
    onOpenChange(false)
  }, [onCancel, onOpenChange])

  // REMOVED: factorAName, factorBName - No longer needed without simple effects

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85dvh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">
            Configure Regression Categorical Predictors
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Choose reference (baseline) levels for categorical predictors used
            in linear or logistic regression. Baseline = 0, all other levels
            become dummy variables that compare outcomes to the baseline group.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain space-y-6">
          {/* Factor cards */}
          <div className="space-y-4">
            <div className="text-sm font-medium text-foreground">
              Categorical Factors:
            </div>
            {factors.map(factor => (
              <FactorCard
                key={factor.columnName}
                factor={factor}
                baselineLevel={
                  baselineSelections.get(factor.columnName) ??
                  factor.levels[0] ??
                  ''
                }
                onBaselineChange={level =>
                  handleBaselineChange(factor.columnName, level)
                }
              />
            ))}
          </div>

          {/* REMOVED: Simple effects section - Dialog is for regression only, not ANOVA */}

          {/* Explanation */}
          <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 text-sm text-blue-900 dark:text-blue-200">
            <p className="font-medium mb-1">
              Dummy Variable Encoding (Regression Only)
            </p>
            <p className="text-xs">
              The selected baseline level is coded as 0 for each predictor.
              Every other level produces a dummy column (1 when the level is
              present, 0 otherwise). In linear regression, coefficients
              represent mean differences versus baseline; in logistic
              regression, coefficients represent log-odds differences versus
              baseline.
            </p>
            <p className="text-xs mt-2">
              ANOVA workflows apply effect coding automatically, so no manual
              baseline selection is needed in that path.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
