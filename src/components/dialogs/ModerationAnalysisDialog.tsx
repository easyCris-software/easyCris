/**
 * Moderation Analysis Configuration Dialog (Model 1)
 *
 * Simple Moderation: X x W -> Y
 * Tests whether the effect of X on Y varies as a function of W (moderator).
 *
 * Features:
 * - Select independent variable (X)
 * - Select moderator (W)
 * - Select dependent variable (Y)
 * - Optional covariates
 * - Mean centering options
 * - Simple slopes probe configuration (default)
 */

import { useState, useEffect, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ColumnClassification, ColumnDataType } from '@/lib/modules/core/types'
import { AlertCircle, Info } from 'lucide-react'
import { moderationModule } from '@/lib/modules/moderation/moderationModule'
import { BinaryEncoding, needsManualEncoding, isNumericBinary, autoSuggestEncoding } from './binaryEncodingHelpers'

// ============================================================================
// Types
// ============================================================================

export interface ModerationAnalysisConfig {
  independentVariable: string
  moderator: string
  dependentVariable: string
  covariates: string[]
  centerPredictor: boolean
  centerModerator: boolean
  probeMode: 'default' | 'custom'
  customProbeValues: number[] | null
  confidenceLevel: number
  seed: number
  ivEncoding?: BinaryEncoding
  moderatorEncoding?: BinaryEncoding
  dvEncoding?: BinaryEncoding
  covariateEncodings?: Record<string, BinaryEncoding>
  cancelled: boolean
}

interface ModerationAnalysisDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (config: ModerationAnalysisConfig) => void
  columns: ColumnClassification[]
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if column is suitable for moderation variables
 */
function isSuitableForModeration(col: ColumnClassification): boolean {
  return (
    col.dataType === ColumnDataType.Numeric ||
    col.dataType === ColumnDataType.Binary ||
    col.dataType === ColumnDataType.Categorical ||
    col.dataType === ColumnDataType.Ordinal
  )
}

// ============================================================================
// Dialog Component
// ============================================================================

export function ModerationAnalysisDialog({
  isOpen,
  onClose,
  onConfirm,
  columns,
}: ModerationAnalysisDialogProps) {
  // ============================================================================
  // State
  // ============================================================================

  const [independentVariable, setIndependentVariable] = useState<string | null>(null)
  const [moderator, setModerator] = useState<string | null>(null)
  const [dependentVariable, setDependentVariable] = useState<string | null>(null)
  const [selectedCovariates, setSelectedCovariates] = useState<Set<string>>(new Set())
  const [centerPredictor, setCenterPredictor] = useState<boolean>(false)
  const [centerModerator, setCenterModerator] = useState<boolean>(false)
  const probeMode: 'default' = 'default'
  const [confidenceLevel, setConfidenceLevel] = useState<number>(95)
  const [seed, setSeed] = useState<number>(12345)

  // Binary categorical encoding state
  const [ivEncoding, setIvEncoding] = useState<BinaryEncoding | undefined>(undefined)
  const [moderatorEncoding, setModeratorEncoding] = useState<BinaryEncoding | undefined>(undefined)
  const [dvEncoding, setDvEncoding] = useState<BinaryEncoding | undefined>(undefined)
  const [covariateEncodings, setCovariateEncodings] = useState<Record<string, BinaryEncoding>>({})

  // ============================================================================
  // Reset state on open
  // ============================================================================

  useEffect(() => {
    if (!isOpen) return
    setIndependentVariable(null)
    setModerator(null)
    setDependentVariable(null)
    setSelectedCovariates(new Set())
    setCenterPredictor(false)
    setCenterModerator(false)
    setConfidenceLevel(95)
    setSeed(12345)
    setIvEncoding(undefined)
    setModeratorEncoding(undefined)
    setDvEncoding(undefined)
    setCovariateEncodings({})
  }, [isOpen])

  useEffect(() => {
    setSelectedCovariates((prev) => {
      if (prev.size === 0) return prev
      const reserved = new Set(
        [independentVariable, moderator, dependentVariable].filter(
          (value): value is string => value !== null
        )
      )
      let changed = false
      const next = new Set<string>()
      for (const name of prev) {
        if (reserved.has(name)) {
          changed = true
          continue
        }
        next.add(name)
      }
      return changed ? next : prev
    })
  }, [independentVariable, moderator, dependentVariable])

  // ============================================================================
  // Auto-detect binary categorical encodings
  // ============================================================================

  // Auto-detect IV encoding
  useEffect(() => {
    if (!independentVariable) {
      setIvEncoding(undefined)
      return
    }
    const col = columns.find(c => c.columnName === independentVariable)
    if (!col) {
      setIvEncoding(undefined)
      return
    }
    if (isNumericBinary(col)) {
      setIvEncoding(undefined)
      return
    }
    if (needsManualEncoding(col)) {
      setIvEncoding(autoSuggestEncoding(col))
    } else {
      setIvEncoding(undefined)
    }
  }, [independentVariable, columns])

  // Auto-detect Moderator encoding
  useEffect(() => {
    if (!moderator) {
      setModeratorEncoding(undefined)
      return
    }
    const col = columns.find(c => c.columnName === moderator)
    if (!col) {
      setModeratorEncoding(undefined)
      return
    }
    if (isNumericBinary(col)) {
      setModeratorEncoding(undefined)
      return
    }
    if (needsManualEncoding(col)) {
      setModeratorEncoding(autoSuggestEncoding(col))
    } else {
      setModeratorEncoding(undefined)
    }
  }, [moderator, columns])

  // Auto-detect DV encoding
  useEffect(() => {
    if (!dependentVariable) {
      setDvEncoding(undefined)
      return
    }
    const col = columns.find(c => c.columnName === dependentVariable)
    if (!col) {
      setDvEncoding(undefined)
      return
    }
    if (isNumericBinary(col)) {
      setDvEncoding(undefined)
      return
    }
    if (needsManualEncoding(col)) {
      setDvEncoding(autoSuggestEncoding(col))
    } else {
      setDvEncoding(undefined)
    }
  }, [dependentVariable, columns])

  // Auto-detect covariate encodings
  useEffect(() => {
    setCovariateEncodings(prev => {
      const next: Record<string, BinaryEncoding> = { ...prev }
      const selected = new Set(selectedCovariates)
      let changed = false

      // Remove encodings for unselected covariates
      for (const key of Object.keys(next)) {
        if (!selected.has(key)) {
          delete next[key]
          changed = true
        }
      }

      // Add encodings for new binary categorical covariates
      for (const covName of selectedCovariates) {
        const col = columns.find(c => c.columnName === covName)
        if (!col) continue
        if (next[covName]) continue
        if (isNumericBinary(col)) continue
        if (needsManualEncoding(col)) {
          const encoding = autoSuggestEncoding(col)
          if (encoding) {
            next[covName] = encoding
            changed = true
          }
        }
      }
      return changed ? next : prev
    })
  }, [selectedCovariates, columns])

  // ============================================================================
  // Column Filtering
  // ============================================================================

  const suitableColumns = useMemo(
    () => columns.filter(isSuitableForModeration),
    [columns]
  )

  // ============================================================================
  // Available Columns (exclude already selected)
  // ============================================================================

  const availableForIV = useMemo(
    () => suitableColumns.filter(c =>
      c.columnName !== moderator && c.columnName !== dependentVariable
    ),
    [suitableColumns, moderator, dependentVariable]
  )

  const availableForModerator = useMemo(
    () => suitableColumns.filter(c =>
      c.columnName !== independentVariable && c.columnName !== dependentVariable
    ),
    [suitableColumns, independentVariable, dependentVariable]
  )

  const availableForDV = useMemo(
    () => suitableColumns.filter(c =>
      c.columnName !== independentVariable && c.columnName !== moderator
    ),
    [suitableColumns, independentVariable, moderator]
  )

  const availableForCovariates = useMemo(
    () => suitableColumns.filter(c =>
      c.columnName !== independentVariable &&
      c.columnName !== moderator &&
      c.columnName !== dependentVariable
    ),
    [suitableColumns, independentVariable, moderator, dependentVariable]
  )

  const selectedCovariateColumns = useMemo(() => {
    if (selectedCovariates.size === 0) return []
    return columns
      .filter((col) => selectedCovariates.has(col.columnName))
      .sort((a, b) => a.columnIndex - b.columnIndex)
  }, [columns, selectedCovariates])

  // ============================================================================
  // Validation
  // ============================================================================

  const validationResult = useMemo(() => {
    if (!independentVariable || !moderator || !dependentVariable) {
      return { isValid: false, errors: [], warnings: [], suggestions: [] }
    }

    const selectedColumns = [
      columns.find((col) => col.columnName === independentVariable),
      columns.find((col) => col.columnName === moderator),
      columns.find((col) => col.columnName === dependentVariable),
      ...selectedCovariateColumns,
    ].filter(Boolean) as ColumnClassification[]

    return moderationModule.validateSelection(selectedColumns)
  }, [independentVariable, moderator, dependentVariable, columns, selectedCovariateColumns])

  const encodingErrors = useMemo(() => {
    const errors: string[] = []
    const validateEncoding = (label: string, encoding?: BinaryEncoding) => {
      if (!encoding) return
      if (!encoding.censoredValue || !encoding.eventValue) {
        errors.push(`${label} encoding requires two distinct values for 0 and 1.`)
        return
      }
      if (encoding.censoredValue === encoding.eventValue) {
        errors.push(`${label} encoding must use different values for 0 and 1.`)
      }
    }

    validateEncoding('Independent variable', ivEncoding)
    validateEncoding('Moderator', moderatorEncoding)
    validateEncoding('Dependent variable', dvEncoding)
    for (const [covName, encoding] of Object.entries(covariateEncodings)) {
      validateEncoding(`Covariate '${covName}'`, encoding)
    }

    return errors
  }, [ivEncoding, moderatorEncoding, dvEncoding, covariateEncodings])

  const combinedErrors = useMemo(
    () => [...validationResult.errors, ...encodingErrors],
    [validationResult.errors, encodingErrors]
  )

  const isValid = useMemo(() => {
    const baseValid = (
      independentVariable !== null &&
      moderator !== null &&
      dependentVariable !== null &&
      validationResult.isValid &&
      encodingErrors.length === 0 &&
      confidenceLevel > 0 &&
      confidenceLevel < 100
    )

    return baseValid
  }, [
    independentVariable,
    moderator,
    dependentVariable,
    validationResult,
    encodingErrors,
    confidenceLevel,
  ])

  // ============================================================================
  // Event Handlers
  // ============================================================================

  const handleConfirm = () => {
    if (!isValid || !independentVariable || !moderator || !dependentVariable) return

    const config: ModerationAnalysisConfig = {
      independentVariable,
      moderator,
      dependentVariable,
      covariates: selectedCovariateColumns.map((col) => col.columnName),
      centerPredictor,
      centerModerator,
      probeMode,
      customProbeValues: null,
      confidenceLevel: confidenceLevel / 100, // Convert to decimal
      seed,
      ivEncoding,
      moderatorEncoding,
      dvEncoding,
      covariateEncodings: Object.keys(covariateEncodings).length > 0 ? covariateEncodings : undefined,
      cancelled: false,
    }

    onConfirm(config)
  }

  const handleCancel = () => {
    onClose()
  }

  const toggleCovariate = (columnName: string) => {
    setSelectedCovariates(prev => {
      const next = new Set(prev)
      if (next.has(columnName)) {
        next.delete(columnName)
      } else {
        next.add(columnName)
      }
      return next
    })
  }

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85dvh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Moderation Analysis (Model 1)</DialogTitle>
          <DialogDescription>
            Configure variables for moderation analysis. Tests whether the effect of X on Y varies
            as a function of W.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain space-y-6 py-4">
          {/* ================================================================ */}
          {/* Independent Variable (X) */}
          {/* ================================================================ */}
          <div className="space-y-2">
            <Label htmlFor="iv" className="flex items-center gap-2 flex-wrap">
              1. Independent Variable (X) <span className="text-destructive">*</span>
              <span className="text-sm text-muted-foreground font-normal min-w-0">
                (predictor: numeric/ordinal or binary categorical)
              </span>
            </Label>
            <Select value={independentVariable ?? ''} onValueChange={setIndependentVariable}>
              <SelectTrigger id="iv">
                <SelectValue placeholder="Select independent variable..." />
              </SelectTrigger>
              <SelectContent>
                {availableForIV.map(col => (
                  <SelectItem key={col.columnName} value={col.columnName}>
                    {col.columnName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* IV Binary Encoding UI */}
          {ivEncoding && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                <div className="space-y-2">
                  <p className="font-medium">Binary categorical encoding:</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <Label>0 (Reference):</Label>
                      <Select
                        value={ivEncoding.censoredValue}
                        onValueChange={(val) =>
                          setIvEncoding({ ...ivEncoding, censoredValue: val })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {columns
                            .find(c => c.columnName === independentVariable)
                            ?.uniqueValues.map(v => (
                              <SelectItem key={String(v)} value={String(v)}>
                                {String(v)}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>1 (Treatment):</Label>
                      <Select
                        value={ivEncoding.eventValue}
                        onValueChange={(val) =>
                          setIvEncoding({ ...ivEncoding, eventValue: val })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {columns
                            .find(c => c.columnName === independentVariable)
                            ?.uniqueValues.map(v => (
                              <SelectItem key={String(v)} value={String(v)}>
                                {String(v)}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* ================================================================ */}
          {/* Moderator (W) */}
          {/* ================================================================ */}
          <div className="space-y-2">
            <Label htmlFor="moderator" className="flex items-center gap-2 flex-wrap">
              2. Moderator (W) <span className="text-destructive">*</span>
              <span className="text-sm text-muted-foreground font-normal min-w-0">
                (interaction variable: numeric/ordinal or binary categorical)
              </span>
            </Label>
            <Select value={moderator ?? ''} onValueChange={setModerator}>
              <SelectTrigger id="moderator">
                <SelectValue placeholder="Select moderator..." />
              </SelectTrigger>
              <SelectContent>
                {availableForModerator.map(col => (
                  <SelectItem key={col.columnName} value={col.columnName}>
                    {col.columnName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Moderator Binary Encoding UI */}
          {moderatorEncoding && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                <div className="space-y-2">
                  <p className="font-medium">Binary categorical encoding:</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <Label>0 (Reference):</Label>
                      <Select
                        value={moderatorEncoding.censoredValue}
                        onValueChange={(val) =>
                          setModeratorEncoding({ ...moderatorEncoding, censoredValue: val })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {columns
                            .find(c => c.columnName === moderator)
                            ?.uniqueValues.map(v => (
                              <SelectItem key={String(v)} value={String(v)}>
                                {String(v)}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>1 (Treatment):</Label>
                      <Select
                        value={moderatorEncoding.eventValue}
                        onValueChange={(val) =>
                          setModeratorEncoding({ ...moderatorEncoding, eventValue: val })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {columns
                            .find(c => c.columnName === moderator)
                            ?.uniqueValues.map(v => (
                              <SelectItem key={String(v)} value={String(v)}>
                                {String(v)}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* ================================================================ */}
          {/* Dependent Variable (Y) */}
          {/* ================================================================ */}
          <div className="space-y-2">
            <Label htmlFor="dv" className="flex items-center gap-2 flex-wrap">
              3. Dependent Variable (Y) <span className="text-destructive">*</span>
              <span className="text-sm text-muted-foreground font-normal min-w-0">
                (outcome: numeric/ordinal or binary categorical)
              </span>
            </Label>
            <Select value={dependentVariable ?? ''} onValueChange={setDependentVariable}>
              <SelectTrigger id="dv">
                <SelectValue placeholder="Select dependent variable..." />
              </SelectTrigger>
              <SelectContent>
                {availableForDV.map(col => (
                  <SelectItem key={col.columnName} value={col.columnName}>
                    {col.columnName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* DV Binary Encoding UI */}
          {dvEncoding && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                <div className="space-y-2">
                  <p className="font-medium">Binary categorical encoding:</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <Label>0 (Reference):</Label>
                      <Select
                        value={dvEncoding.censoredValue}
                        onValueChange={(val) =>
                          setDvEncoding({ ...dvEncoding, censoredValue: val })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {columns
                            .find(c => c.columnName === dependentVariable)
                            ?.uniqueValues.map(v => (
                              <SelectItem key={String(v)} value={String(v)}>
                                {String(v)}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>1 (Treatment):</Label>
                      <Select
                        value={dvEncoding.eventValue}
                        onValueChange={(val) =>
                          setDvEncoding({ ...dvEncoding, eventValue: val })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {columns
                            .find(c => c.columnName === dependentVariable)
                            ?.uniqueValues.map(v => (
                              <SelectItem key={String(v)} value={String(v)}>
                                {String(v)}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* ================================================================ */}
          {/* Covariates (Optional) */}
          {/* ================================================================ */}
          {availableForCovariates.length > 0 && (
            <div className="space-y-2">
              <Label className="flex items-center gap-2 flex-wrap">
                4. Covariates (optional)
                <span className="text-sm text-muted-foreground font-normal min-w-0">
                  (control variables: numeric/ordinal or categorical)
                </span>
              </Label>
              <div className="space-y-2 p-4 border rounded-lg max-h-48 overflow-y-auto">
                {availableForCovariates.map(col => (
                  <div key={col.columnName} className="flex items-center space-x-2">
                    <Checkbox
                      id={`cov-${col.columnName}`}
                      checked={selectedCovariates.has(col.columnName)}
                      onCheckedChange={() => toggleCovariate(col.columnName)}
                    />
                    <Label
                      htmlFor={`cov-${col.columnName}`}
                      className="font-normal cursor-pointer flex-1"
                    >
                      {col.columnName}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Covariate Binary Encoding UI */}
          {Object.entries(covariateEncodings).map(([covName, encoding]) => (
            <Alert key={covName}>
              <Info className="h-4 w-4" />
              <AlertDescription>
                <div className="space-y-2">
                  <p className="font-medium">Binary categorical encoding for {covName}:</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <Label>0 (Reference):</Label>
                      <Select
                        value={encoding.censoredValue}
                        onValueChange={(val) =>
                          setCovariateEncodings(prev => ({
                            ...prev,
                            [covName]: { ...prev[covName]!, censoredValue: val }
                          }))
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {columns
                            .find(c => c.columnName === covName)
                            ?.uniqueValues.map(v => (
                              <SelectItem key={String(v)} value={String(v)}>
                                {String(v)}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>1 (Treatment):</Label>
                      <Select
                        value={encoding.eventValue}
                        onValueChange={(val) =>
                          setCovariateEncodings(prev => ({
                            ...prev,
                            [covName]: { ...prev[covName]!, eventValue: val }
                          }))
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {columns
                            .find(c => c.columnName === covName)
                            ?.uniqueValues.map(v => (
                              <SelectItem key={String(v)} value={String(v)}>
                                {String(v)}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </AlertDescription>
            </Alert>
          ))}

          {/* ================================================================ */}
          {/* Settings */}
          {/* ================================================================ */}
          <div className="space-y-4 pt-4 border-t">
            <h3 className="font-medium">Analysis Settings</h3>

            {/* Mean Centering */}
            <div className="space-y-3">
              <Label>Mean Centering</Label>
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="center-predictor"
                    checked={centerPredictor}
                    onCheckedChange={(checked) => setCenterPredictor(checked as boolean)}
                  />
                  <Label htmlFor="center-predictor" className="font-normal cursor-pointer">
                    Center predictor (X)
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="center-moderator"
                    checked={centerModerator}
                    onCheckedChange={(checked) => setCenterModerator(checked as boolean)}
                  />
                  <Label htmlFor="center-moderator" className="font-normal cursor-pointer">
                    Center moderator (W)
                  </Label>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Centering reduces multicollinearity in the interaction term
              </p>
            </div>

            {/* Simple Slopes Probe Values */}
            <div className="space-y-2">
              <Label>Simple Slopes at W values</Label>
              <p className="text-sm text-muted-foreground">
                Default probes are used: mean and +/- 1 SD of W.
              </p>
            </div>
          </div>

          {/* ================================================================ */}
          {/* Validation Messages */}
          {/* ================================================================ */}
          {combinedErrors.length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {combinedErrors.map((error, i) => (
                  <div key={i}>{error}</div>
                ))}
              </AlertDescription>
            </Alert>
          )}

          {validationResult.warnings.length > 0 && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {validationResult.warnings.map((warning, i) => (
                  <div key={i}>{warning}</div>
                ))}
              </AlertDescription>
            </Alert>
          )}

          {validationResult.suggestions.length > 0 && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                {validationResult.suggestions.map((suggestion, i) => (
                  <div key={i}>{suggestion}</div>
                ))}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!isValid}>
            Run Analysis
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
