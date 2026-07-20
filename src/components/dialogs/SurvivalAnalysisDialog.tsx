/**
 * Survival Analysis Configuration Dialog
 *
 * Single dialog component with conditional sections for:
 * - Kaplan-Meier survival curves
 * - Cox proportional hazards regression
 * - Nelson-Aalen cumulative hazard estimator
 *
 * Features:
 * - Generic binary encoding (works with ANY 2 values)
 * - Auto-detect 0/1, true/false, boolean
 * - Inline encoding UI for non-numeric binary labels
 * - Enforced mapping (button disabled until selected)
 * - Conditional sections based on analysis type
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
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { ColumnClassification, ColumnDataType } from '@/lib/modules/core/types'
import { AlertCircle, Info } from 'lucide-react'

// ============================================================================
// Types
// ============================================================================

export type SurvivalAnalysisType = 'kaplan_meier' | 'cox_regression' | 'nelson_aalen'

export interface EventEncoding {
  eventValue: string
  censoredValue: string
  wasEncoded: boolean
}

export interface CovariateEncoding {
  trueValue: string
  falseValue: string
  wasEncoded: boolean
}

export interface SurvivalAnalysisConfig {
  timeVariable: string
  eventVariable: string
  groupVariable: string | null       // KM, NA only
  covariates: string[]                // Cox only
  customTimePoints: number[]          // NA only (max 5)
  eventEncoding?: EventEncoding       // CRITICAL: Required for non-numeric binary
  covariateEncodings?: Record<string, CovariateEncoding> // Cox-only: binary covariate mappings
  cancelled: boolean
}

interface SurvivalAnalysisDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (config: SurvivalAnalysisConfig) => void
  columns: ColumnClassification[]
  analysisType: SurvivalAnalysisType
}

// ============================================================================
// Binary Event Detection (Generic - No Hardcoded Labels)
// ============================================================================

/**
 * Check if column is numeric binary (0/1, true/false, boolean)
 * Auto-detection: no encoding UI needed
 */
function isNumericBinary(col: ColumnClassification): boolean {
  if (!col.isBinary || col.uniqueValueCount !== 2) return false

  return col.uniqueValues.every(v => {
    const str = String(v).toLowerCase().trim()
    return (
      str === '0' ||
      str === '1' ||
      str === 'false' ||
      str === 'true'
    )
  })
}

/**
 * Check if column needs manual encoding
 * Show encoding UI when this returns true
 */
function needsManualEncoding(col: ColumnClassification): boolean {
  return col.isBinary && col.uniqueValueCount === 2 && !isNumericBinary(col)
}

/**
 * Check if column is valid for event indicator
 */
function isBinaryEventColumn(col: ColumnClassification): boolean {
  return col.isBinary && col.uniqueValueCount === 2
}

// ============================================================================
// Dialog Component
// ============================================================================

export function SurvivalAnalysisDialog({
  isOpen,
  onClose,
  onConfirm,
  columns,
  analysisType,
}: SurvivalAnalysisDialogProps) {
  // ============================================================================
  // State
  // ============================================================================

  const [timeVariable, setTimeVariable] = useState<string | null>(null)
  const [eventVariable, setEventVariable] = useState<string | null>(null)
  const [groupVariable, setGroupVariable] = useState<string | null>(null)
  const [selectedCovariates, setSelectedCovariates] = useState<Set<string>>(new Set())
  const [eventEncoding, setEventEncoding] = useState<EventEncoding | undefined>(undefined)
  const [covariateEncodings, setCovariateEncodings] = useState<Record<string, CovariateEncoding>>({})
  const [showEncodingUI, setShowEncodingUI] = useState(false)
  const [customTimePointsInput, setCustomTimePointsInput] = useState('')

  // ============================================================================
  // Conditional Sections
  // ============================================================================

  const showGroup = analysisType === 'kaplan_meier' || analysisType === 'nelson_aalen'
  const showCovariates = analysisType === 'cox_regression'

  // ============================================================================
  // Reset state on open (avoid stale selections across datasets/types)
  // ============================================================================

  useEffect(() => {
    if (!isOpen) return
    setTimeVariable(null)
    setEventVariable(null)
    setGroupVariable(null)
    setSelectedCovariates(new Set())
    setEventEncoding(undefined)
    setCovariateEncodings({})
    setShowEncodingUI(false)
    setCustomTimePointsInput('')
  }, [isOpen, analysisType])

  // ============================================================================
  // Dialog Title
  // ============================================================================

  const dialogTitle = {
    kaplan_meier: 'Configure Kaplan-Meier Survival Analysis',
    cox_regression: 'Configure Cox Proportional Hazards',
    nelson_aalen: 'Configure Nelson-Aalen Estimator',
  }[analysisType]

  // ============================================================================
  // Filter Columns by Type
  // ============================================================================

  const numericColumns = useMemo(
    () => columns.filter(c => c.dataType === ColumnDataType.Numeric),
    [columns]
  )
  const binaryEventColumns = useMemo(
    () => columns.filter(c => isBinaryEventColumn(c)),
    [columns]
  )
  const categoricalColumns = useMemo(
    () =>
      columns.filter(
        c => c.dataType === ColumnDataType.Categorical || c.dataType === ColumnDataType.Binary
      ),
    [columns]
  )
  const covariateColumns = useMemo(
    () =>
      columns.filter(
        c =>
          c.dataType === ColumnDataType.Numeric ||
          c.dataType === ColumnDataType.Categorical ||
          c.dataType === ColumnDataType.Binary ||
          c.dataType === ColumnDataType.Ordinal
      ),
    [columns]
  )

  const covariatesNeedingEncoding = useMemo(() => {
    if (analysisType !== 'cox_regression') return []
    return covariateColumns.filter(
      col => selectedCovariates.has(col.columnName) && needsManualEncoding(col)
    )
  }, [analysisType, covariateColumns, selectedCovariates])

  const parsedCustomTimePoints = useMemo(() => {
    const raw = customTimePointsInput.trim()
    if (!raw) {
      return { values: [] as number[], error: null as string | null }
    }

    const tokens = raw.split(/[\s,]+/).filter(Boolean)
    const values: number[] = []
    const seen = new Set<number>()
    const invalid: string[] = []

    for (const token of tokens) {
      const value = Number(token)
      if (!Number.isFinite(value) || value < 0) {
        invalid.push(token)
        continue
      }
      if (!seen.has(value)) {
        seen.add(value)
        values.push(value)
      }
    }

    if (invalid.length > 0) {
      return { values: [], error: `Invalid time point(s): ${invalid.join(', ')}` }
    }
    if (values.length > 5) {
      return { values: [], error: 'Provide at most 5 time points.' }
    }

    return { values, error: null }
  }, [customTimePointsInput])

  // ============================================================================
  // Event Encoding Logic (CRITICAL - Enforced Mapping)
  // ============================================================================

  useEffect(() => {
    if (!eventVariable) {
      setShowEncodingUI(false)
      setEventEncoding(undefined)
      return
    }

    const col = columns.find(c => c.columnName === eventVariable)
    if (!col) return

    // If numeric binary (0/1, true/false), no encoding needed
    if (isNumericBinary(col)) {
      setShowEncodingUI(false)
      setEventEncoding(undefined)
      return
    }

    // Non-numeric binary - needs encoding
    if (isBinaryEventColumn(col)) {
      setShowEncodingUI(true)
      // Auto-suggest: alphabetically last value = event
      const sorted = [...col.uniqueValues].map(String).sort()
      if (sorted.length < 2) {
        setEventEncoding(undefined)
        return
      }
      setEventEncoding({
        eventValue: sorted[1]!,
        censoredValue: sorted[0]!,
        wasEncoded: true,
      })
    }
  }, [eventVariable, columns])

  // ============================================================================
  // Covariate Encoding Logic (Cox only)
  // ============================================================================

  useEffect(() => {
    if (analysisType !== 'cox_regression') {
      setCovariateEncodings({})
      return
    }

    setCovariateEncodings(prev => {
      const next: Record<string, CovariateEncoding> = { ...prev }
      const selected = new Set(selectedCovariates)
      let changed = false

      for (const key of Object.keys(next)) {
        if (!selected.has(key)) {
          delete next[key]
          changed = true
        }
      }

      for (const col of covariatesNeedingEncoding) {
        if (!next[col.columnName]) {
          const sorted = [...col.uniqueValues].map(String).sort()
          if (sorted.length < 2) {
            continue
          }
          next[col.columnName] = {
            trueValue: sorted[1]!,
            falseValue: sorted[0]!,
            wasEncoded: true,
          }
          changed = true
        }
      }

      return changed ? next : prev
    })
  }, [analysisType, selectedCovariates, covariatesNeedingEncoding])

  // ============================================================================
  // Validation Logic
  // ============================================================================

  const isValid = useMemo(() => {
    if (!timeVariable || !eventVariable) return false
    if (timeVariable === eventVariable) return false

    const columnNames = new Set(columns.map(col => col.columnName))
    if (!columnNames.has(timeVariable) || !columnNames.has(eventVariable)) {
      return false
    }

    // CRITICAL: Enforce event encoding when needed
    const eventCol = columns.find(c => c.columnName === eventVariable)
    if (eventCol && needsManualEncoding(eventCol)) {
      // If manual encoding is needed, user MUST have selected a mapping
      return eventEncoding !== undefined && eventEncoding.wasEncoded === true
    }

    // Cox regression requires at least 1 covariate
    if (analysisType === 'cox_regression' && selectedCovariates.size === 0) {
      return false
    }

    if (
      analysisType === 'cox_regression' &&
      covariatesNeedingEncoding.some(
        col => !covariateEncodings[col.columnName]?.wasEncoded
      )
    ) {
      return false
    }

    if (analysisType === 'nelson_aalen' && parsedCustomTimePoints.error) {
      return false
    }

    return true
  }, [
    timeVariable,
    eventVariable,
    eventEncoding,
    analysisType,
    selectedCovariates,
    covariateEncodings,
    covariatesNeedingEncoding,
    parsedCustomTimePoints,
    columns,
  ])

  // ============================================================================
  // Event Handlers
  // ============================================================================

  const handleConfirm = () => {
    if (!isValid || !timeVariable || !eventVariable) return

    const config: SurvivalAnalysisConfig = {
      timeVariable,
      eventVariable,
      groupVariable: showGroup ? groupVariable : null,
      covariates: showCovariates ? Array.from(selectedCovariates) : [],
      customTimePoints: analysisType === 'nelson_aalen' ? parsedCustomTimePoints.values : [],
      eventEncoding,
      covariateEncodings: showCovariates ? covariateEncodings : undefined,
      cancelled: false,
    }

    onConfirm(config)
  }

  const handleCancel = () => {
    onClose()
  }

  const handleEncodingChange = (value: string) => {
    if (!eventEncoding) return
    const other =
      value === eventEncoding.eventValue ? eventEncoding.censoredValue : eventEncoding.eventValue
    setEventEncoding({
      eventValue: value,
      censoredValue: other,
      wasEncoded: true,
    })
  }

  const handleCovariateEncodingChange = (columnName: string, value: string) => {
    setCovariateEncodings(prev => {
      const current = prev[columnName]
      if (!current) return prev
      const other = value === current.trueValue ? current.falseValue : current.trueValue
      return {
        ...prev,
        [columnName]: {
          trueValue: value,
          falseValue: other,
          wasEncoded: true,
        },
      }
    })
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
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>
            Configure variables for survival analysis. Event column must be binary (exactly 2
            unique values).
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain space-y-6 py-4">
          {/* ================================================================ */}
          {/* Time Variable (Required) */}
          {/* ================================================================ */}
          <div className="space-y-2">
            <Label htmlFor="time-variable" className="flex items-center gap-2 flex-wrap">
              Time Variable <span className="text-destructive">*</span>
              <span className="text-sm text-muted-foreground font-normal min-w-0">
                (numeric, non-negative)
              </span>
            </Label>
            <Select value={timeVariable ?? ''} onValueChange={setTimeVariable}>
              <SelectTrigger id="time-variable">
                <SelectValue placeholder="Select time variable..." />
              </SelectTrigger>
              <SelectContent>
                {numericColumns.map(col => (
                  <SelectItem key={col.columnName} value={col.columnName}>
                    {col.columnName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ================================================================ */}
          {/* Event Variable (Required) */}
          {/* ================================================================ */}
          <div className="space-y-2">
            <Label htmlFor="event-variable" className="flex items-center gap-2 flex-wrap">
              Event Indicator <span className="text-destructive">*</span>
              <span className="text-sm text-muted-foreground font-normal min-w-0">
                (binary: exactly 2 unique values)
              </span>
            </Label>
            <Select value={eventVariable ?? ''} onValueChange={setEventVariable}>
              <SelectTrigger id="event-variable">
                <SelectValue placeholder="Select event variable..." />
              </SelectTrigger>
              <SelectContent>
                {binaryEventColumns.map(col => (
                  <SelectItem key={col.columnName} value={col.columnName}>
                    {col.columnName}
                    {isNumericBinary(col) && (
                      <span className="ml-2 text-xs text-muted-foreground">(auto-detected)</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {eventVariable && binaryEventColumns.find(c => c.columnName === eventVariable) && (
              <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-md text-sm">
                <Info className="h-4 w-4 mt-0.5 text-blue-500 flex-shrink-0" />
                <div>
                  {isNumericBinary(
                    binaryEventColumns.find(c => c.columnName === eventVariable)!
                  ) ? (
                    <span className="text-muted-foreground">
                      Auto-detected: 0/1 or true/false {'->'} no encoding needed
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      Non-numeric labels detected {'->'} you'll map which value = event below
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ================================================================ */}
          {/* Event Encoding UI (CRITICAL - Shown when needsManualEncoding) */}
          {/* ================================================================ */}
          {showEncodingUI && eventEncoding && (
            <div className="space-y-3 p-4 border rounded-lg bg-card">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div className="space-y-3 flex-1">
                  <div>
                    <p className="font-medium">Event Encoding Required</p>
                    <p className="text-sm text-muted-foreground">
                      Your event column has non-numeric labels. Select which value indicates the
                      event occurred:
                    </p>
                  </div>

                  <RadioGroup
                    value={eventEncoding.eventValue}
                    onValueChange={handleEncodingChange}
                  >
                    <div className="space-y-2">
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value={eventEncoding.eventValue} id="event-1" />
                        <Label htmlFor="event-1" className="font-normal cursor-pointer">
                          <span className="font-medium">{eventEncoding.eventValue}</span> = Event
                          occurred (1)
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value={eventEncoding.censoredValue} id="event-0" />
                        <Label htmlFor="event-0" className="font-normal cursor-pointer">
                          <span className="font-medium">{eventEncoding.censoredValue}</span> =
                          Censored (0)
                        </Label>
                      </div>
                    </div>
                  </RadioGroup>

                  <p className="text-xs text-muted-foreground">
                    Current mapping: {eventEncoding.eventValue} {'->'} 1 (event),{' '}
                    {eventEncoding.censoredValue} {'->'} 0 (censored)
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* Group Variable (Kaplan-Meier, Nelson-Aalen only) */}
          {/* ================================================================ */}
          {showGroup && (
            <div className="space-y-2">
              <Label htmlFor="group-variable" className="flex items-center gap-2 flex-wrap">
                Group Variable
                <span className="text-sm text-muted-foreground font-normal min-w-0">
                  (optional, for comparison)
                </span>
              </Label>
            <Select
              value={groupVariable ?? '__none__'}
              onValueChange={(value) => {
                setGroupVariable(value === '__none__' ? null : value)
              }}
            >
              <SelectTrigger id="group-variable">
                <SelectValue placeholder="(None)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">(None)</SelectItem>
                {categoricalColumns
                  .filter(c => c.columnName !== eventVariable)
                  .map(col => (
                      <SelectItem key={col.columnName} value={col.columnName}>
                        {col.columnName}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* ================================================================ */}
          {/* Covariates (Cox Regression only) */}
          {/* ================================================================ */}
          {showCovariates && (
            <div className="space-y-2">
              <Label className="flex items-center gap-2 flex-wrap">
                Covariates (Predictors) <span className="text-destructive">*</span>
                <span className="text-sm text-muted-foreground font-normal min-w-0">
                  (at least 1 required)
                </span>
              </Label>
              <div className="border rounded-md p-3 space-y-2 max-h-48 overflow-y-auto">
                {covariateColumns
                  .filter(c => c.columnName !== timeVariable && c.columnName !== eventVariable)
                  .map(col => (
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
                        <span className="ml-2 text-xs text-muted-foreground">
                          ({col.dataType})
                        </span>
                      </Label>
                    </div>
                  ))}
              </div>
              {selectedCovariates.size === 0 ? (
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <Info className="h-4 w-4" />
                  Select at least one covariate.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <Info className="h-4 w-4" />
                  Categorical covariates are auto-encoded (k-1 dummy variables).
                </p>
              )}
              {covariatesNeedingEncoding.length > 0 && (
                <div className="space-y-3 p-4 border rounded-lg bg-muted/40">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium">Binary covariate encoding</p>
                      <p className="text-sm text-muted-foreground">
                        Choose which value maps to 1 for each binary covariate.
                      </p>
                    </div>
                  </div>

                  {covariatesNeedingEncoding.map(col => {
                    const encoding = covariateEncodings[col.columnName]
                    if (!encoding) return null
                    return (
                      <div key={col.columnName} className="space-y-2">
                        <Label className="font-medium">{col.columnName}</Label>
                        <RadioGroup
                          value={encoding.trueValue}
                          onValueChange={(value) =>
                            handleCovariateEncodingChange(col.columnName, value)
                          }
                        >
                          <div className="space-y-2">
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem
                                value={encoding.trueValue}
                                id={`cov-${col.columnName}-1`}
                              />
                              <Label
                                htmlFor={`cov-${col.columnName}-1`}
                                className="font-normal cursor-pointer"
                              >
                                <span className="font-medium">{encoding.trueValue}</span> = 1
                              </Label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem
                                value={encoding.falseValue}
                                id={`cov-${col.columnName}-0`}
                              />
                              <Label
                                htmlFor={`cov-${col.columnName}-0`}
                                className="font-normal cursor-pointer"
                              >
                                <span className="font-medium">{encoding.falseValue}</span> = 0
                              </Label>
                            </div>
                          </div>
                        </RadioGroup>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* ================================================================ */}
          {/* Custom Time Points (Nelson-Aalen only) */}
          {/* ================================================================ */}
          {analysisType === 'nelson_aalen' && (
            <div className="space-y-2">
              <Label htmlFor="custom-time-points" className="flex items-center gap-2 flex-wrap">
                Custom Time Points
                <span className="text-sm text-muted-foreground font-normal min-w-0">
                  (optional, up to 5)
                </span>
              </Label>
              <Input
                id="custom-time-points"
                placeholder="e.g., 0, 5, 10, 15, 20"
                value={customTimePointsInput}
                onChange={(e) => setCustomTimePointsInput(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Enter comma- or space-separated times. The table will include estimates at those
                times even if no events occurred.
              </p>
              {parsedCustomTimePoints.error && (
                <p className="text-sm text-destructive">{parsedCustomTimePoints.error}</p>
              )}
            </div>
          )}

        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!isValid}>
            Perform Test
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


