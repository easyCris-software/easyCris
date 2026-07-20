/**
 * Mediation Analysis Configuration Dialog (Model 4)
 *
 * Simple Mediation: X -> M -> Y
 * Tests whether the effect of X on Y is mediated through M.
 *
 * Features:
 * - Select independent variable (X)
 * - Select mediator (M)
 * - Select dependent variable (Y)
 * - Optional covariates
 * - Bootstrap configuration
 * - Auto-detect binary DV (logistic mediation disabled; OLS used for baseline parity)
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
import { mediationModule } from '@/lib/modules/mediation/mediationModule'
import { BinaryEncoding, needsManualEncoding, isNumericBinary, autoSuggestEncoding } from './binaryEncodingHelpers'

// ============================================================================
// Types
// ============================================================================

export interface MediationAnalysisConfig {
  independentVariable: string
  mediator: string
  dependentVariable: string
  covariates: string[]
  nBootstrap: number
  confidenceLevel: number
  seed: number
  ivEncoding?: BinaryEncoding
  mediatorEncoding?: BinaryEncoding
  dvEncoding?: BinaryEncoding
  covariateEncodings?: Record<string, BinaryEncoding>
  cancelled: boolean
}

interface MediationAnalysisDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (config: MediationAnalysisConfig) => void
  columns: ColumnClassification[]
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if column is suitable for mediation variables (X, M, Y)
 * Allows numeric, binary, ordinal, and categorical (with warning for multi-level)
 */
function isSuitableForMediation(col: ColumnClassification): boolean {
  return (
    col.dataType === ColumnDataType.Numeric ||
    col.dataType === ColumnDataType.Binary ||
    col.dataType === ColumnDataType.Categorical ||
    col.dataType === ColumnDataType.Ordinal
  )
}

/**
 * Check if DV is binary (logistic mediation disabled; used for encoding + warning)
 */
function isBinaryDV(col: ColumnClassification | undefined): boolean {
  if (!col) return false
  return col.isBinary && col.uniqueValueCount === 2
}

// ============================================================================
// Dialog Component
// ============================================================================

export function MediationAnalysisDialog({
  isOpen,
  onClose,
  onConfirm,
  columns,
}: MediationAnalysisDialogProps) {
  // ============================================================================
  // State
  // ============================================================================

  const [independentVariable, setIndependentVariable] = useState<string | null>(null)
  const [mediator, setMediator] = useState<string | null>(null)
  const [dependentVariable, setDependentVariable] = useState<string | null>(null)
  const [selectedCovariates, setSelectedCovariates] = useState<Set<string>>(new Set())
  const [nBootstrap, setNBootstrap] = useState<number>(5000)
  const [confidenceLevel, setConfidenceLevel] = useState<number>(95)
  const [seed, setSeed] = useState<number>(12345)

  // Binary encoding state
  const [ivEncoding, setIvEncoding] = useState<BinaryEncoding | undefined>(undefined)
  const [mediatorEncoding, setMediatorEncoding] = useState<BinaryEncoding | undefined>(undefined)
  const [dvEncoding, setDvEncoding] = useState<BinaryEncoding | undefined>(undefined)
  const [covariateEncodings, setCovariateEncodings] = useState<Record<string, BinaryEncoding>>({})

  // ============================================================================
  // Reset state on open
  // ============================================================================

  useEffect(() => {
    if (!isOpen) return
    setIndependentVariable(null)
    setMediator(null)
    setDependentVariable(null)
    setSelectedCovariates(new Set())
    setNBootstrap(5000)
    setConfidenceLevel(95)
    setSeed(12345)
    setIvEncoding(undefined)
    setMediatorEncoding(undefined)
    setDvEncoding(undefined)
    setCovariateEncodings({})
  }, [isOpen])

  useEffect(() => {
    setSelectedCovariates((prev) => {
      if (prev.size === 0) return prev
      const reserved = new Set(
        [independentVariable, mediator, dependentVariable].filter(
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
  }, [independentVariable, mediator, dependentVariable])

  // ============================================================================
  // Binary Encoding Auto-Detection
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

    // If numeric binary (0/1, true/false), no encoding needed
    if (isNumericBinary(col)) {
      setIvEncoding(undefined)
      return
    }

    // Non-numeric binary - needs encoding
    if (needsManualEncoding(col)) {
      setIvEncoding(autoSuggestEncoding(col))
    } else {
      setIvEncoding(undefined)
    }
  }, [independentVariable, columns])

  // Auto-detect Mediator encoding
  useEffect(() => {
    if (!mediator) {
      setMediatorEncoding(undefined)
      return
    }

    const col = columns.find(c => c.columnName === mediator)
    if (!col) {
      setMediatorEncoding(undefined)
      return
    }

    if (isNumericBinary(col)) {
      setMediatorEncoding(undefined)
      return
    }

    if (needsManualEncoding(col)) {
      setMediatorEncoding(autoSuggestEncoding(col))
    } else {
      setMediatorEncoding(undefined)
    }
  }, [mediator, columns])

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

        // Skip if already has encoding
        if (next[covName]) continue

        // Skip if numeric binary
        if (isNumericBinary(col)) continue

        // Add encoding if needs it
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
    () => columns.filter(isSuitableForMediation),
    [columns]
  )

  // ============================================================================
  // Available Columns (exclude already selected)
  // ============================================================================

  const availableForIV = useMemo(
    () => suitableColumns.filter(c =>
      c.columnName !== mediator && c.columnName !== dependentVariable
    ),
    [suitableColumns, mediator, dependentVariable]
  )

  const availableForMediator = useMemo(
    () => suitableColumns.filter(c =>
      c.columnName !== independentVariable && c.columnName !== dependentVariable
    ),
    [suitableColumns, independentVariable, dependentVariable]
  )

  const availableForDV = useMemo(
    () => suitableColumns.filter(c =>
      c.columnName !== independentVariable && c.columnName !== mediator
    ),
    [suitableColumns, independentVariable, mediator]
  )

  const availableForCovariates = useMemo(
    () => suitableColumns.filter(c =>
      c.columnName !== independentVariable &&
      c.columnName !== mediator &&
      c.columnName !== dependentVariable
    ),
    [suitableColumns, independentVariable, mediator, dependentVariable]
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
    if (!independentVariable || !mediator || !dependentVariable) {
      return { isValid: false, errors: [], warnings: [], suggestions: [] }
    }

    const selectedColumns = [
      columns.find((col) => col.columnName === independentVariable),
      columns.find((col) => col.columnName === mediator),
      columns.find((col) => col.columnName === dependentVariable),
      ...selectedCovariateColumns,
    ].filter(Boolean) as ColumnClassification[]

    return mediationModule.validateSelection(selectedColumns)
  }, [independentVariable, mediator, dependentVariable, columns, selectedCovariateColumns])

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
    validateEncoding('Mediator', mediatorEncoding)
    validateEncoding('Dependent variable', dvEncoding)
    for (const [covName, encoding] of Object.entries(covariateEncodings)) {
      validateEncoding(`Covariate '${covName}'`, encoding)
    }

    return errors
  }, [ivEncoding, mediatorEncoding, dvEncoding, covariateEncodings])

  const combinedErrors = useMemo(
    () => [...validationResult.errors, ...encodingErrors],
    [validationResult.errors, encodingErrors]
  )

  const isBinaryDVDetected = useMemo(() => {
    const dvCol = columns.find(c => c.columnName === dependentVariable)
    return isBinaryDV(dvCol)
  }, [dependentVariable, columns])

  const isValid = useMemo(() => {
    return (
      independentVariable !== null &&
      mediator !== null &&
      dependentVariable !== null &&
      validationResult.isValid &&
      encodingErrors.length === 0 &&
      nBootstrap > 0 &&
      confidenceLevel > 0 &&
      confidenceLevel < 100
    )
  }, [
    independentVariable,
    mediator,
    dependentVariable,
    validationResult,
    encodingErrors,
    nBootstrap,
    confidenceLevel,
  ])

  // ============================================================================
  // Event Handlers
  // ============================================================================

  const handleConfirm = () => {
    if (!isValid || !independentVariable || !mediator || !dependentVariable) return

    const config: MediationAnalysisConfig = {
      independentVariable,
      mediator,
      dependentVariable,
      covariates: selectedCovariateColumns.map((col) => col.columnName),
      nBootstrap,
      confidenceLevel: confidenceLevel / 100, // Convert to decimal
      seed,
      ivEncoding,
      mediatorEncoding,
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
          <DialogTitle>Mediation Analysis (Model 4)</DialogTitle>
          <DialogDescription>
            Configure variables for mediation analysis. Tests whether the effect of X on Y is
            mediated through M.
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
          </div>

          {/* ================================================================ */}
          {/* Mediator (M) */}
          {/* ================================================================ */}
          <div className="space-y-2">
            <Label htmlFor="mediator" className="flex items-center gap-2 flex-wrap">
              2. Mediator (M) <span className="text-destructive">*</span>
              <span className="text-sm text-muted-foreground font-normal min-w-0">
                (mechanism variable: numeric/ordinal or binary categorical)
              </span>
            </Label>
            <Select value={mediator ?? ''} onValueChange={setMediator}>
              <SelectTrigger id="mediator">
                <SelectValue placeholder="Select mediator..." />
              </SelectTrigger>
              <SelectContent>
                {availableForMediator.map(col => (
                  <SelectItem key={col.columnName} value={col.columnName}>
                    {col.columnName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Mediator Binary Encoding UI */}
            {mediatorEncoding && (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  <div className="space-y-2">
                    <p className="font-medium">Binary categorical encoding:</p>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <Label>0 (Reference):</Label>
                        <Select
                          value={mediatorEncoding.censoredValue}
                          onValueChange={(val) =>
                            setMediatorEncoding({ ...mediatorEncoding, censoredValue: val })
                          }
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {columns
                              .find(c => c.columnName === mediator)
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
                          value={mediatorEncoding.eventValue}
                          onValueChange={(val) =>
                            setMediatorEncoding({ ...mediatorEncoding, eventValue: val })
                          }
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {columns
                              .find(c => c.columnName === mediator)
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
          </div>

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

          {/* Binary DV Info */}
          {isBinaryDVDetected && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                Binary DV detected; OLS mediation will be used for baseline parity (logistic mediation disabled)
              </AlertDescription>
            </Alert>
          )}

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
              {selectedCovariates.size > 0 && (
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <Info className="h-4 w-4" />
                  Control variables will be included in both models (X to M and X+M to Y)
                </p>
              )}
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
