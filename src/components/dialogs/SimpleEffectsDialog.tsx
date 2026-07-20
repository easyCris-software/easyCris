/**
 * Simple Effects Dialog
 *
 * Allows users to request simple effects for Two-Way ANOVA.
 *
 * Purpose: When a significant interaction is found between two factors, simple effects
 * helps interpret WHERE the interaction occurs by testing one factor at each level of the other.
 *
 * Statistical Context:
 * - Main effects test overall effect of each factor (ignoring the other)
 * - Interaction tests whether the effect of one factor depends on the other
 * - Simple effects decompose the interaction to understand specific patterns
 *
 * Example:
 *   Drug (Aspirin, Ibuprofen) × Dose (Low, High)
 *   - Simple effect: "Is Drug effect different at Low vs High dose?"
 *   - Simple effect: "Is Dose effect different for Aspirin vs Ibuprofen?"
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Dialog props
 */
interface SimpleEffectsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  factor1Name: string
  factor2Name: string
  factor1Levels: string[]
  factor2Levels: string[]
  onConfirm: (result: {
    factorAWithinB: boolean
    factorBWithinA: boolean
    adjustmentMethod: PostHocAdjustmentMethod
    controlLevels?: Record<string, string>
    posthocQ?: number
  }) => void
  onCancel: () => void
}

type PostHocAdjustmentMethod =
  | 'tukey'
  | 'bonferroni'
  | 'holm'
  | 'holm-sidak'
  | 'sidak'
  | 'dunnett'
  | 'fdr_bh'

const POST_HOC_METHODS: { value: PostHocAdjustmentMethod; label: string }[] = [
  { value: 'tukey', label: 'Tukey HSD (default)' },
  { value: 'bonferroni', label: 'Bonferroni' },
  { value: 'holm', label: 'Holm' },
  { value: 'holm-sidak', label: 'Holm-Sidak' },
  { value: 'sidak', label: 'Sidak' },
  { value: 'dunnett', label: 'Dunnett (vs Control)' },
  { value: 'fdr_bh', label: 'FDR (Benjamini-Hochberg)' },
]

/**
 * Simple Effects Dialog Component
 *
 * Shows two checkboxes allowing user to request simple effects for Two-Way ANOVA:
 * 1. Factor A within each level of Factor B
 * 2. Factor B within each level of Factor A
 *
 * Users can select 0, 1, or both options.
 */
export function SimpleEffectsDialog({
  open,
  onOpenChange,
  factor1Name,
  factor2Name,
  factor1Levels,
  factor2Levels,
  onConfirm,
  onCancel,
}: SimpleEffectsDialogProps) {
  // Checkbox states
  const [factorAWithinB, setFactorAWithinB] = useState(false)
  const [factorBWithinA, setFactorBWithinA] = useState(false)
  const [adjustmentMethod, setAdjustmentMethod] =
    useState<PostHocAdjustmentMethod>('tukey')
  const [controlFactor1, setControlFactor1] = useState<string>('')
  const [controlFactor2, setControlFactor2] = useState<string>('')
  const [posthocQInput, setPosthocQInput] = useState<string>('0.05')
  const adjustmentMethodRef = useRef<PostHocAdjustmentMethod>('tukey')

  const isDunnett = adjustmentMethod === 'dunnett'
  const isFdr = adjustmentMethod === 'fdr_bh'

  const posthocQValue = useMemo(() => {
    const parsed = Number.parseFloat(posthocQInput)
    if (!Number.isFinite(parsed)) {
      return null
    }
    return parsed
  }, [posthocQInput])

  const posthocQError = useMemo(() => {
    if (!isFdr) return null
    if (posthocQValue === null) {
      return 'Enter a valid q value (e.g., 0.05).'
    }
    if (posthocQValue <= 0 || posthocQValue > 1) {
      return 'q must be between 0 and 1.'
    }
    return null
  }, [isFdr, posthocQValue])

  useEffect(() => {
    adjustmentMethodRef.current = adjustmentMethod
  }, [adjustmentMethod])

  useEffect(() => {
    if (!isDunnett) {
      setControlFactor1('')
      setControlFactor2('')
    }
  }, [isDunnett])

  const dunnettValidationError = useMemo(() => {
    if (!isDunnett) return null

    if (factor1Levels.length < 3) {
      return `${factor1Name} must have at least 3 levels for Dunnett.`
    }
    if (factor2Levels.length < 3) {
      return `${factor2Name} must have at least 3 levels for Dunnett.`
    }
    if (!controlFactor1) {
      return `Select a control level for ${factor1Name}.`
    }
    if (!controlFactor2) {
      return `Select a control level for ${factor2Name}.`
    }

    return null
  }, [
    isDunnett,
    factor1Levels.length,
    factor2Levels.length,
    factor1Name,
    factor2Name,
    controlFactor1,
    controlFactor2,
  ])

  const handleConfirm = useCallback(() => {
    if (dunnettValidationError || posthocQError) {
      return
    }

    const selectedAdjustmentMethod = adjustmentMethodRef.current
    const controlLevels: Record<string, string> = {}
    if (selectedAdjustmentMethod === 'dunnett') {
      if (controlFactor1) {
        controlLevels[factor1Name] = controlFactor1
      }
      if (controlFactor2) {
        controlLevels[factor2Name] = controlFactor2
      }
    }

    onConfirm({
      factorAWithinB,
      factorBWithinA,
      adjustmentMethod: selectedAdjustmentMethod,
      controlLevels:
        Object.keys(controlLevels).length > 0 ? controlLevels : undefined,
      posthocQ: isFdr ? (posthocQValue ?? undefined) : undefined,
    })
    onOpenChange(false)

    // Reset checkboxes for next time
    setFactorAWithinB(false)
    setFactorBWithinA(false)
    setAdjustmentMethod('tukey')
    setControlFactor1('')
    setControlFactor2('')
    setPosthocQInput('0.05')
    adjustmentMethodRef.current = 'tukey'
  }, [
    factorAWithinB,
    factorBWithinA,
    controlFactor1,
    controlFactor2,
    factor1Name,
    factor2Name,
    onConfirm,
    onOpenChange,
    dunnettValidationError,
    posthocQError,
    isFdr,
    posthocQValue,
  ])

  const handleCancel = useCallback(() => {
    onCancel()
    onOpenChange(false)

    // Reset checkboxes
    setFactorAWithinB(false)
    setFactorBWithinA(false)
    setAdjustmentMethod('tukey')
    setControlFactor1('')
    setControlFactor2('')
    setPosthocQInput('0.05')
    adjustmentMethodRef.current = 'tukey'
  }, [onCancel, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl w-[95vw] max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6 pb-3 border-b border-border shrink-0">
          <DialogTitle className="text-xl font-semibold">
            Simple Effects (Two-Way ANOVA)
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Configure optional follow-up tests when your two-factor design shows
            a significant interaction.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-6 py-4">
          <div className="space-y-6">
            {/* Explanation */}
            <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-4 text-sm text-blue-900 dark:text-blue-200">
              <p className="font-medium mb-2">What are simple effects?</p>
              <p className="text-xs leading-relaxed">
                When a significant interaction is found, simple effects help
                interpret WHERE the interaction occurs. Instead of testing the
                overall effect of each factor, simple effects test one factor at
                each level of the other factor.
              </p>
            </div>

            {/* Checkbox options */}
            <div className="space-y-4">
              <div className="text-sm font-medium text-foreground mb-3">
                Select which simple effects to analyze:
              </div>

              {/* Option 1: Factor A within Factor B */}
              <div className="flex items-start space-x-3 p-4 rounded-lg border-2 border-border hover:border-blue-300 dark:hover:border-blue-700 transition-colors">
                <Checkbox
                  id="factorAWithinB"
                  checked={factorAWithinB}
                  onCheckedChange={checked =>
                    setFactorAWithinB(checked === true)
                  }
                />
                <div className="grid gap-1.5 leading-none flex-1">
                  <Label
                    htmlFor="factorAWithinB"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                  >
                    Analyze{' '}
                    <span className="text-blue-700 dark:text-blue-300 font-semibold">
                      {factor1Name}
                    </span>{' '}
                    within each level of{' '}
                    <span className="text-purple-700 dark:text-purple-300 font-semibold">
                      {factor2Name}
                    </span>
                  </Label>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Tests whether the effect of {factor1Name} is different at
                    each level of {factor2Name}. Uses the selected adjustment
                    method for pairwise comparisons.
                  </p>
                  <p className="text-xs text-muted-foreground italic mt-1">
                    Example: "Is {factor1Name} effect significant when{' '}
                    {factor2Name} = Level1? When {factor2Name} = Level2?"
                  </p>
                </div>
              </div>

              {/* Option 2: Factor B within Factor A */}
              <div className="flex items-start space-x-3 p-4 rounded-lg border-2 border-border hover:border-blue-300 dark:hover:border-blue-700 transition-colors">
                <Checkbox
                  id="factorBWithinA"
                  checked={factorBWithinA}
                  onCheckedChange={checked =>
                    setFactorBWithinA(checked === true)
                  }
                />
                <div className="grid gap-1.5 leading-none flex-1">
                  <Label
                    htmlFor="factorBWithinA"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                  >
                    Analyze{' '}
                    <span className="text-purple-700 dark:text-purple-300 font-semibold">
                      {factor2Name}
                    </span>{' '}
                    within each level of{' '}
                    <span className="text-blue-700 dark:text-blue-300 font-semibold">
                      {factor1Name}
                    </span>
                  </Label>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Tests whether the effect of {factor2Name} is different at
                    each level of {factor1Name}. Uses the selected adjustment
                    method for pairwise comparisons.
                  </p>
                  <p className="text-xs text-muted-foreground italic mt-1">
                    Example: "Is {factor2Name} effect significant when{' '}
                    {factor1Name} = Level1? When {factor1Name} = Level2?"
                  </p>
                </div>
              </div>
            </div>

            {/* Post-hoc adjustment method */}
            <div className="space-y-2 rounded-md border border-border p-4">
              <Label className="text-sm font-medium">
                Post-Hoc Adjustment Method
              </Label>
              <Select
                value={adjustmentMethod}
                onValueChange={value => {
                  const nextValue = value as PostHocAdjustmentMethod
                  adjustmentMethodRef.current = nextValue
                  setAdjustmentMethod(nextValue)
                }}
              >
                <SelectTrigger
                  className="w-full"
                  data-testid="two-way-adjustment-select"
                >
                  <SelectValue placeholder="Select adjustment method" />
                </SelectTrigger>
                <SelectContent>
                  {POST_HOC_METHODS.map(method => (
                    <SelectItem
                      key={method.value}
                      value={method.value}
                      data-value={method.value}
                    >
                      {method.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Tukey HSD is the default for ANOVA. Dunnett requires a control
                level for each factor.
              </p>

              {isFdr && (
                <div className="space-y-1.5 pt-2">
                  <Label className="text-xs font-medium">FDR q-value</Label>
                  <Input
                    value={posthocQInput}
                    onChange={e => setPosthocQInput(e.target.value)}
                    placeholder="0.05"
                    inputMode="decimal"
                  />
                  <p className="text-xs text-muted-foreground">
                    False discovery rate threshold (e.g., 0.05 or 0.1).
                  </p>
                  {posthocQError && (
                    <p className="text-xs text-red-600 dark:text-red-400">
                      {posthocQError}
                    </p>
                  )}
                </div>
              )}

              {isDunnett && (
                <div className="space-y-3 pt-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      Control level for {factor1Name}
                    </Label>
                    <Select
                      value={controlFactor1}
                      onValueChange={setControlFactor1}
                    >
                      <SelectTrigger
                        className="w-full"
                        data-testid="two-way-control-factor1-select"
                      >
                        <SelectValue
                          placeholder={`Select control for ${factor1Name}`}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {factor1Levels.map(level => (
                          <SelectItem
                            key={level}
                            value={level}
                            data-value={level}
                          >
                            {level}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      Control level for {factor2Name}
                    </Label>
                    <Select
                      value={controlFactor2}
                      onValueChange={setControlFactor2}
                    >
                      <SelectTrigger
                        className="w-full"
                        data-testid="two-way-control-factor2-select"
                      >
                        <SelectValue
                          placeholder={`Select control for ${factor2Name}`}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {factor2Levels.map(level => (
                          <SelectItem
                            key={level}
                            value={level}
                            data-value={level}
                          >
                            {level}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {dunnettValidationError && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  {dunnettValidationError}
                </p>
              )}
            </div>

            {/* Information note */}
            <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3 text-sm text-amber-900 dark:text-amber-200">
              <p className="font-medium mb-1">Recommendation</p>
              <p className="text-xs">
                Request simple effects when interaction terms are significant or
                when decision-makers expect detailed results. If no interaction
                is detected, most analysts skip this step and rely on main
                effects. Choose zero, one, or both options - simple effects are
                optional diagnostics.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t border-border shrink-0">
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={Boolean(dunnettValidationError || posthocQError)}
          >
            {factorAWithinB || factorBWithinA
              ? 'Continue with Simple Effects'
              : 'Skip Simple Effects'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
