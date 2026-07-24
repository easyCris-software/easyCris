/**
 * Multi-Factorial Encoding Dialog
 *
 * Allows users to configure 3+ factor ANOVA analysis options.
 * Used for: Multi-Factorial ANOVA, Scheirer-Ray-Hare
 *
 * Reference: easyCris.Avalonia/Views/StatisticalAnalysis/MultiFactorialEncodingDialog.axaml.cs
 * Lines: 285 lines
 *
 * Features:
 * - Compact factor display (name + level count) - no baselines for ANOVA
 * - Interaction depth selector:
 *   - Main effects only (1-way)
 *   - Up to 2-way interactions
 *   - Up to 3-way interactions
 *   - Full model (all interactions)
 * - Smart default depth: 1-3 factors = full model, 4+ factors = 3-way max
 * - Term count calculator: Shows number of model terms
 * - Simple effects grid: Checkboxes for all "A within B" combinations
 * - Factor removal: Uncheck factors to reduce model complexity
 *
 * 🔒 LOCKED - DO NOT MODIFY WITHOUT USER PERMISSION
 * This dialog is validated and production-ready:
 * - Smart depth selection prevents term explosion for 4+ factors
 * - User can override via dropdown selector
 * - Changes require user permission and testing
 */

import { useState, useCallback, useMemo } from 'react'
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
import { Checkbox } from '@/components/ui/checkbox'
import type { SimpleEffectConfig } from '@/lib/analysis/StatisticalAnalysisController'

/**
 * Factor metadata
 */
export interface MultiFactorialFactorMetadata {
  columnName: string
  levels: string[]
}

interface MultiFactorialEncodingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  factors: MultiFactorialFactorMetadata[]
  onConfirm: (result: {
    maxInteractionDepth: number
    simpleEffects: SimpleEffectConfig[]
    selectedFactors: string[]
  }) => void
  onCancel: () => void
}

/**
 * Calculate number of model terms for given factors and interaction depth
 * Combinatorics: C(n, k) for all k from 1 to maxDepth
 */
function calculateTermCount(
  factorCount: number,
  maxInteractionDepth: number
): number {
  if (factorCount === 0) return 0
  if (maxInteractionDepth === 0) maxInteractionDepth = factorCount // Full model

  let termCount = 1 // Intercept

  // Add terms for each interaction level
  for (let k = 1; k <= Math.min(maxInteractionDepth, factorCount); k++) {
    // C(n, k) = n! / (k! * (n-k)!)
    termCount += binomialCoefficient(factorCount, k)
  }

  return termCount
}

/**
 * Calculate binomial coefficient C(n, k)
 */
function binomialCoefficient(n: number, k: number): number {
  if (k > n) return 0
  if (k === 0 || k === n) return 1

  let result = 1
  for (let i = 1; i <= k; i++) {
    result = (result * (n - i + 1)) / i
  }
  return Math.floor(result)
}

/**
 * Get interaction depth description
 */
function getInteractionDepthDescription(
  depth: number,
  factorCount: number
): string {
  if (depth === 0 || depth >= factorCount) {
    return `Full factorial model with all ${factorCount}-way interactions`
  } else if (depth === 1) {
    return 'Main effects only (no interactions)'
  } else {
    return `Main effects plus up to ${depth}-way interactions`
  }
}

/**
 * Multi-Factorial Encoding Dialog Component
 */
export function MultiFactorialEncodingDialog({
  open,
  onOpenChange,
  factors,
  onConfirm,
  onCancel,
}: MultiFactorialEncodingDialogProps) {
  // Smart default interaction depth:
  // - For 1-3 factors: 0 (full model, all interactions)
  // - For 4+ factors: 3 (limit to 3-way interactions)
  // Rationale: 4-way+ interactions rarely interpretable, preserves degrees of freedom
  const smartDefaultDepth = factors.length <= 3 ? 0 : 3
  const [maxInteractionDepth, setMaxInteractionDepth] =
    useState<number>(smartDefaultDepth)

  // Selected factors (user can uncheck to exclude)
  const [selectedFactors, setSelectedFactors] = useState<Set<string>>(() => {
    return new Set(factors.map(f => f.columnName))
  })

  // Simple effects selections (mainFactor within withinFactor)
  const [simpleEffectsMap, setSimpleEffectsMap] = useState<
    Map<string, Set<string>>
  >(() => {
    // Map: mainFactor -> Set of withinFactors
    return new Map()
  })

  const selectedFactorsList = useMemo(() => {
    return factors.filter(f => selectedFactors.has(f.columnName))
  }, [factors, selectedFactors])

  const termCount = useMemo(() => {
    return calculateTermCount(selectedFactorsList.length, maxInteractionDepth)
  }, [selectedFactorsList.length, maxInteractionDepth])

  const interactionDepthDescription = useMemo(() => {
    return getInteractionDepthDescription(
      maxInteractionDepth,
      selectedFactorsList.length
    )
  }, [maxInteractionDepth, selectedFactorsList.length])

  const handleFactorToggle = useCallback(
    (factorName: string, checked: boolean) => {
      setSelectedFactors(prev => {
        const newSet = new Set(prev)
        if (checked) {
          newSet.add(factorName)
        } else {
          newSet.delete(factorName)
        }
        return newSet
      })
    },
    []
  )

  const handleSimpleEffectToggle = useCallback(
    (mainFactor: string, withinFactor: string, checked: boolean) => {
      setSimpleEffectsMap(prev => {
        const newMap = new Map(prev)
        const withinSet = newMap.get(mainFactor) || new Set<string>()

        if (checked) {
          withinSet.add(withinFactor)
        } else {
          withinSet.delete(withinFactor)
        }

        if (withinSet.size > 0) {
          newMap.set(mainFactor, withinSet)
        } else {
          newMap.delete(mainFactor)
        }

        return newMap
      })
    },
    []
  )

  const buildSimpleEffects = useCallback((): SimpleEffectConfig[] => {
    const simpleEffects: SimpleEffectConfig[] = []

    simpleEffectsMap.forEach((withinFactors, mainFactor) => {
      withinFactors.forEach(withinFactor => {
        simpleEffects.push({
          factor: mainFactor,
          within: withinFactor,
        })
      })
    })

    return simpleEffects
  }, [simpleEffectsMap])

  const handleConfirm = useCallback(() => {
    const simpleEffects = buildSimpleEffects()

    onConfirm({
      maxInteractionDepth,
      simpleEffects,
      selectedFactors: Array.from(selectedFactors),
    })
    onOpenChange(false)
  }, [
    maxInteractionDepth,
    selectedFactors,
    buildSimpleEffects,
    onConfirm,
    onOpenChange,
  ])

  const handleCancel = useCallback(() => {
    onCancel()
    onOpenChange(false)
  }, [onCancel, onOpenChange])

  // Generate all simple effects combinations
  const simpleEffectsCombinations = useMemo(() => {
    const combinations: Array<{ main: string; within: string }> = []

    selectedFactorsList.forEach(mainFactor => {
      selectedFactorsList.forEach(withinFactor => {
        if (mainFactor.columnName !== withinFactor.columnName) {
          combinations.push({
            main: mainFactor.columnName,
            within: withinFactor.columnName,
          })
        }
      })
    })

    return combinations
  }, [selectedFactorsList])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90dvh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">
            Configure Multi-Factorial ANOVA
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Configure interaction depth and simple effects for {factors.length}
            -factor ANOVA
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain space-y-6">
          {/* Factor selection */}
          <div className="space-y-3">
            <div className="text-sm font-medium text-foreground">
              Factors (uncheck to exclude):
            </div>
            <div className="space-y-2">
              {factors.map(factor => (
                <div
                  key={factor.columnName}
                  className="flex items-center space-x-3 rounded-md border border-border bg-muted/40 p-3"
                >
                  <Checkbox
                    id={`factor-${factor.columnName}`}
                    checked={selectedFactors.has(factor.columnName)}
                    onCheckedChange={checked =>
                      handleFactorToggle(factor.columnName, checked === true)
                    }
                  />
                  <label
                    htmlFor={`factor-${factor.columnName}`}
                    className="flex-1 cursor-pointer"
                  >
                    <span className="font-semibold text-sm text-blue-900 dark:text-blue-200">
                      {factor.columnName}:
                    </span>{' '}
                    <span className="text-xs text-muted-foreground">
                      {factor.levels.length} levels ({factor.levels.join(', ')})
                    </span>
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* Interaction depth selector */}
          <div className="rounded-lg border-2 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 p-4 space-y-3">
            <div className="font-semibold text-base text-green-900 dark:text-green-200">
              Interaction Depth
            </div>

            <div className="space-y-2">
              <Label htmlFor="interaction-depth" className="text-sm">
                Maximum interaction depth:
              </Label>
              <Select
                value={maxInteractionDepth.toString()}
                onValueChange={value => setMaxInteractionDepth(parseInt(value))}
              >
                <SelectTrigger id="interaction-depth">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Main effects only (1-way)</SelectItem>
                  <SelectItem value="2">Up to 2-way interactions</SelectItem>
                  <SelectItem value="3">Up to 3-way interactions</SelectItem>
                  {selectedFactorsList.length >= 4 && (
                    <SelectItem value="4">Up to 4-way interactions</SelectItem>
                  )}
                  <SelectItem value="0">
                    Full model (all interactions)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Model info */}
            <div className="space-y-1 text-sm">
              <div className="text-green-800 dark:text-green-200">
                {interactionDepthDescription}
              </div>
              <div className="font-mono text-xs text-green-700 dark:text-green-300">
                Model terms: {termCount} (including intercept)
              </div>
            </div>
          </div>

          {/* Simple effects grid */}
          {selectedFactorsList.length >= 2 && (
            <div className="rounded-lg border-2 border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-950/30 p-4 space-y-3">
              <div>
                <div className="font-semibold text-base text-purple-900 dark:text-purple-200">
                  Simple Effects
                </div>
                <div className="text-xs text-purple-700 dark:text-purple-300">
                  Examine when significant interactions are found
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                {simpleEffectsCombinations.map(({ main, within }) => {
                  const isChecked =
                    simpleEffectsMap.get(main)?.has(within) ?? false

                  return (
                    <div
                      key={`${main}-within-${within}`}
                      className="flex items-start space-x-2"
                    >
                      <Checkbox
                        id={`se-${main}-${within}`}
                        checked={isChecked}
                        onCheckedChange={checked =>
                          handleSimpleEffectToggle(
                            main,
                            within,
                            checked === true
                          )
                        }
                      />
                      <label
                        htmlFor={`se-${main}-${within}`}
                        className="text-xs cursor-pointer leading-tight"
                      >
                        <span className="font-medium">{main}</span> within each
                        level of <span className="font-medium">{within}</span>
                      </label>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Explanation */}
          <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 text-sm text-blue-900 dark:text-blue-200">
            <p className="font-medium mb-1">Multi-Factorial ANOVA:</p>
            <p className="text-xs">
              ANOVA uses effect coding (no explicit baseline selection). The
              interaction depth controls model complexity: main effects only is
              simplest, full model tests all possible interactions. Simple
              effects help interpret significant interactions by testing one
              factor at each level of another.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={selectedFactorsList.length < 2}
          >
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
