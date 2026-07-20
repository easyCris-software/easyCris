/**
 * SimpleEffectsSelectionBase — internal shared body for simple-effects dialogs.
 *
 * Consumed by MultiFactorialSimpleEffectsDialog (ANOVA) and LmmSimpleEffectsDialog (LMM).
 * The differentiating copy (title, description, explanation box) is passed as props.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
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
import type { SimpleEffectConfig } from '@/lib/analysis/StatisticalAnalysisController'

export type PostHocAdjustmentMethod =
  | 'tukey'
  | 'bonferroni'
  | 'holm'
  | 'holm-sidak'
  | 'sidak'
  | 'dunnett'
  | 'fdr_bh'

export const POST_HOC_METHODS: {
  value: PostHocAdjustmentMethod
  label: string
}[] = [
  { value: 'tukey', label: 'Tukey HSD (default)' },
  { value: 'bonferroni', label: 'Bonferroni' },
  { value: 'holm', label: 'Holm' },
  { value: 'holm-sidak', label: 'Holm-Sidak' },
  { value: 'sidak', label: 'Sidak' },
  { value: 'dunnett', label: 'Dunnett (vs Control)' },
  { value: 'fdr_bh', label: 'FDR (Benjamini-Hochberg)' },
]

export interface SimpleEffectsConfirmResult {
  simpleEffects: SimpleEffectConfig[]
  adjustmentMethod?: PostHocAdjustmentMethod
  controlLevels?: Record<string, string>
  posthocQ?: number
}

export interface SimpleEffectsSelectionBaseProps {
  // Dialog identity (caller-supplied copy)
  title: string
  description: ReactNode
  explanationNode: ReactNode
  showExampleInterpretation?: boolean
  adjustmentHelpText?: string

  // Data
  open: boolean
  onOpenChange: (open: boolean) => void
  factorNames: string[]
  factorLevels: Record<string, string[]>
  testIdPrefix?: string
  showAdjustmentControls?: boolean
  onConfirm: (result: SimpleEffectsConfirmResult) => void
  onCancel: () => void
}

function getPairKey(factor: string, within: string): string {
  return `${factor}|${within}`
}

export function SimpleEffectsSelectionBase({
  title,
  description,
  explanationNode,
  showExampleInterpretation = true,
  adjustmentHelpText = 'Tukey HSD is the default. Dunnett requires control levels for each factor.',
  open,
  onOpenChange,
  factorNames,
  factorLevels,
  testIdPrefix = 'multi',
  showAdjustmentControls = true,
  onConfirm,
  onCancel,
}: SimpleEffectsSelectionBaseProps) {
  const simpleEffectPairs = useMemo(() => {
    const pairs: { factor: string; within: string }[] = []
    for (const factor of factorNames) {
      for (const within of factorNames) {
        if (factor !== within) {
          pairs.push({ factor, within })
        }
      }
    }
    return pairs
  }, [factorNames])

  const [enabledPairs, setEnabledPairs] = useState<Set<string>>(new Set())

  const togglePair = useCallback((factor: string, within: string) => {
    const key = getPairKey(factor, within)
    setEnabledPairs(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const resetSelection = useCallback(() => {
    setEnabledPairs(new Set())
  }, [])

  const selectedCount = enabledPairs.size

  const sharedProps = {
    title,
    description,
    explanationNode,
    showExampleInterpretation,
    open,
    onOpenChange,
    factorNames,
    factorLevels,
    testIdPrefix,
    onCancel,
    simpleEffectPairs,
    enabledPairs,
    togglePair,
    resetSelection,
    selectedCount,
  }

  if (!showAdjustmentControls) {
    return (
      <SimpleEffectsSelectionNoAdjustments
        {...sharedProps}
        onConfirm={onConfirm}
      />
    )
  }

  return (
    <SimpleEffectsSelectionWithAdjustments
      {...sharedProps}
      adjustmentHelpText={adjustmentHelpText}
      onConfirm={onConfirm}
    />
  )
}

interface SharedSelectionProps {
  title: string
  description: ReactNode
  explanationNode: ReactNode
  showExampleInterpretation: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  factorNames: string[]
  factorLevels: Record<string, string[]>
  testIdPrefix: string
  onCancel: () => void
  simpleEffectPairs: { factor: string; within: string }[]
  enabledPairs: Set<string>
  togglePair: (factor: string, within: string) => void
  selectedCount: number
}

interface SharedDialogScaffoldProps extends SharedSelectionProps {
  confirmDisabled?: boolean
  onConfirmClick: () => void
  adjustmentSection?: ReactNode
}

function SharedDialogScaffold({
  title,
  description,
  explanationNode,
  showExampleInterpretation,
  open,
  onOpenChange,
  factorNames,
  factorLevels: _factorLevels,
  testIdPrefix,
  onCancel,
  simpleEffectPairs,
  enabledPairs,
  togglePair,
  selectedCount,
  confirmDisabled = false,
  onConfirmClick,
  adjustmentSection,
}: SharedDialogScaffoldProps) {
  const handleCancel = useCallback(() => {
    onCancel()
    onOpenChange(false)
  }, [onCancel, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl w-[95vw] max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6 pb-3 border-b border-border shrink-0">
          <DialogTitle className="text-xl font-semibold">{title}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-6 py-4">
          <div className="space-y-6">
            <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-4 text-sm text-blue-900 dark:text-blue-200">
              {explanationNode}
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-foreground">
                  Select simple effects to analyze:
                </div>
                <div className="text-xs text-muted-foreground">
                  {selectedCount} {selectedCount === 1 ? 'effect' : 'effects'}{' '}
                  selected
                </div>
              </div>

              <div className="rounded-lg border border-border overflow-hidden">
                <div className="grid grid-cols-3 bg-muted border-b border-border text-xs font-semibold text-foreground">
                  <div className="p-3">Main Factor</div>
                  <div className="p-3">Within Factor</div>
                  <div className="p-3 text-center">Enable</div>
                </div>

                <div className="divide-y divide-border">
                  {simpleEffectPairs.map(({ factor, within }, idx) => {
                    const key = getPairKey(factor, within)
                    const isEnabled = enabledPairs.has(key)
                    return (
                      <div
                        key={key}
                        className={`grid grid-cols-3 items-center hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors ${
                          isEnabled ? 'bg-blue-50 dark:bg-blue-950/30' : ''
                        }`}
                      >
                        <div className="p-3 text-sm font-medium text-blue-700 dark:text-blue-300">
                          {factor}
                        </div>
                        <div className="p-3 text-sm text-purple-700 dark:text-purple-300">
                          {within}
                        </div>
                        <div className="p-3 flex justify-center">
                          <Checkbox
                            id={`pair-${idx}`}
                            checked={isEnabled}
                            onCheckedChange={() => togglePair(factor, within)}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            {adjustmentSection}

            <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3 text-sm text-amber-900 dark:text-amber-200">
              <p className="font-medium mb-1">Recommendation</p>
              <p className="text-xs leading-relaxed">
                Focus on interactions that are statistically significant or of
                high scientific interest. Requesting too many simple effects can
                dilute interpretability, so target the comparisons that support
                your hypotheses. You can always skip this step when no
                noteworthy interactions are present.
              </p>
            </div>

            {showExampleInterpretation && factorNames.length >= 2 && (
              <div className="rounded-md bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 p-3 text-sm text-green-900 dark:text-green-200">
                <p className="font-medium mb-1">Example interpretation</p>
                <p className="text-xs leading-relaxed">
                  &ldquo;{factorNames[0]} within {factorNames[1]}&rdquo; means:
                  Test whether {factorNames[0]} has a significant effect at each
                  level of {factorNames[1]}. For instance, if {factorNames[1]}{' '}
                  has levels Low/High, this tests {factorNames[0]} separately
                  for Low and High groups.
                </p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t border-border shrink-0">
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            onClick={onConfirmClick}
            disabled={confirmDisabled}
            data-testid={`${testIdPrefix}-run-button`}
          >
            {selectedCount > 0
              ? `Continue with ${selectedCount} Simple ${selectedCount === 1 ? 'Effect' : 'Effects'}`
              : 'Skip Simple Effects'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface SimpleEffectsSelectionNoAdjustmentsProps
  extends SharedSelectionProps {
  resetSelection: () => void
  onConfirm: (result: SimpleEffectsConfirmResult) => void
}

function SimpleEffectsSelectionNoAdjustments({
  onConfirm,
  onOpenChange,
  resetSelection,
  simpleEffectPairs,
  enabledPairs,
  ...sharedProps
}: SimpleEffectsSelectionNoAdjustmentsProps) {
  const handleConfirm = useCallback(() => {
    const simpleEffects: SimpleEffectConfig[] = simpleEffectPairs
      .filter(({ factor, within }) =>
        enabledPairs.has(getPairKey(factor, within))
      )
      .map(({ factor, within }) => ({ factor, within }))

    onConfirm({ simpleEffects })
    onOpenChange(false)
    resetSelection()
  }, [simpleEffectPairs, enabledPairs, onConfirm, onOpenChange, resetSelection])

  return (
    <SharedDialogScaffold
      {...sharedProps}
      simpleEffectPairs={simpleEffectPairs}
      enabledPairs={enabledPairs}
      onOpenChange={onOpenChange}
      onConfirmClick={handleConfirm}
    />
  )
}

interface SimpleEffectsSelectionWithAdjustmentsProps
  extends SharedSelectionProps {
  resetSelection: () => void
  adjustmentHelpText: string
  onConfirm: (result: SimpleEffectsConfirmResult) => void
}

function SimpleEffectsSelectionWithAdjustments({
  adjustmentHelpText,
  factorNames,
  factorLevels,
  testIdPrefix,
  onConfirm,
  onOpenChange,
  resetSelection,
  simpleEffectPairs,
  enabledPairs,
  ...sharedProps
}: SimpleEffectsSelectionWithAdjustmentsProps) {
  const getControlTestId = useCallback(
    (factor: string) =>
      `${testIdPrefix}-control-select-${factor.toLowerCase().replace(/\s+/g, '-')}`,
    [testIdPrefix]
  )
  const [adjustmentMethod, setAdjustmentMethod] =
    useState<PostHocAdjustmentMethod>('tukey')
  const [controlLevels, setControlLevels] = useState<Record<string, string>>({})
  const [posthocQInput, setPosthocQInput] = useState<string>('0.05')
  const adjustmentMethodRef = useRef<PostHocAdjustmentMethod>('tukey')

  const isDunnett = adjustmentMethod === 'dunnett'
  const isFdr = adjustmentMethod === 'fdr_bh'

  const posthocQValue = useMemo(() => {
    const parsed = Number.parseFloat(posthocQInput)
    return Number.isFinite(parsed) ? parsed : null
  }, [posthocQInput])

  const posthocQError = useMemo(() => {
    if (!isFdr) return null
    if (posthocQValue === null) return 'Enter a valid q value (e.g., 0.05).'
    if (posthocQValue <= 0 || posthocQValue > 1)
      return 'q must be between 0 and 1.'
    return null
  }, [isFdr, posthocQValue])

  useEffect(() => {
    adjustmentMethodRef.current = adjustmentMethod
  }, [adjustmentMethod])

  useEffect(() => {
    if (!isDunnett) {
      setControlLevels({})
      return
    }
    setControlLevels(prev => {
      const next = { ...prev }
      for (const key of Object.keys(next)) {
        if (!factorNames.includes(key)) {
          delete next[key]
        }
      }
      return next
    })
  }, [isDunnett, factorNames])

  const dunnettValidationError = useMemo(() => {
    if (!isDunnett) return null
    for (const factor of factorNames) {
      const levels = factorLevels[factor] ?? []
      if (levels.length < 3)
        return `${factor} must have at least 3 levels for Dunnett.`
      if (!controlLevels[factor]) return `Select a control level for ${factor}.`
    }
    return null
  }, [isDunnett, factorNames, factorLevels, controlLevels])

  const reset = useCallback(() => {
    resetSelection()
    setAdjustmentMethod('tukey')
    setControlLevels({})
    setPosthocQInput('0.05')
    adjustmentMethodRef.current = 'tukey'
  }, [resetSelection])

  const handleConfirm = useCallback(() => {
    if (dunnettValidationError || posthocQError) return

    const simpleEffects: SimpleEffectConfig[] = simpleEffectPairs
      .filter(({ factor, within }) =>
        enabledPairs.has(getPairKey(factor, within))
      )
      .map(({ factor, within }) => ({ factor, within }))

    const selectedMethod = adjustmentMethodRef.current
    onConfirm({
      simpleEffects,
      adjustmentMethod: selectedMethod,
      controlLevels: selectedMethod === 'dunnett' ? controlLevels : undefined,
      posthocQ: isFdr ? (posthocQValue ?? undefined) : undefined,
    })
    onOpenChange(false)
    reset()
  }, [
    simpleEffectPairs,
    enabledPairs,
    controlLevels,
    onConfirm,
    onOpenChange,
    dunnettValidationError,
    posthocQError,
    isFdr,
    posthocQValue,
    reset,
  ])

  const adjustmentSection = (
    <div className="space-y-2 rounded-md border border-border p-4">
      <Label className="text-sm font-medium">Post-Hoc Adjustment Method</Label>
      <Select
        value={adjustmentMethod}
        onValueChange={value => {
          const next = value as PostHocAdjustmentMethod
          adjustmentMethodRef.current = next
          setAdjustmentMethod(next)
        }}
      >
        <SelectTrigger
          className="w-full"
          data-testid={`${testIdPrefix}-adjustment-select`}
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
      <p className="text-xs text-muted-foreground">{adjustmentHelpText}</p>

      {isFdr && (
        <div className="space-y-1.5 pt-2">
          <Label className="text-xs font-medium">FDR q-value</Label>
          <Input
            value={posthocQInput}
            onChange={e => setPosthocQInput(e.target.value)}
            placeholder="0.05"
            inputMode="decimal"
            data-testid={`${testIdPrefix}-posthoc-q`}
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

      {isDunnett && factorNames.length > 0 && (
        <div className="space-y-3 pt-2">
          {factorNames.map(factor => {
            const levels = factorLevels[factor] ?? []
            return (
              <div key={factor} className="space-y-1.5">
                <Label className="text-xs font-medium">
                  Control level for {factor}
                </Label>
                <Select
                  value={controlLevels[factor] ?? ''}
                  onValueChange={value =>
                    setControlLevels(prev => ({ ...prev, [factor]: value }))
                  }
                >
                  <SelectTrigger
                    className="w-full"
                    data-testid={getControlTestId(factor)}
                    data-factor={factor}
                  >
                    <SelectValue placeholder={`Select control for ${factor}`} />
                  </SelectTrigger>
                  <SelectContent>
                    {levels.map(level => (
                      <SelectItem key={level} value={level} data-value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )
          })}
        </div>
      )}

      {dunnettValidationError && (
        <p className="text-xs text-red-600 dark:text-red-400">
          {dunnettValidationError}
        </p>
      )}
    </div>
  )

  return (
    <SharedDialogScaffold
      {...sharedProps}
      factorNames={factorNames}
      factorLevels={factorLevels}
      testIdPrefix={testIdPrefix}
      simpleEffectPairs={simpleEffectPairs}
      enabledPairs={enabledPairs}
      onOpenChange={onOpenChange}
      confirmDisabled={Boolean(dunnettValidationError || posthocQError)}
      onConfirmClick={handleConfirm}
      adjustmentSection={adjustmentSection}
    />
  )
}
