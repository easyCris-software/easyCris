/**
 * One-Way ANOVA Column Mapper Dialog
 *
 * Lets users explicitly map columns to:
 * - Group (categorical variable with 2+ groups)
 * - Outcome (numeric variable - what you're measuring)
 *
 * This prevents ambiguity about which column is the grouping variable vs the outcome.
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
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
import { AlertCircle, Users, BarChart3, Settings2 } from 'lucide-react'
import { ColumnDataType } from '@/lib/modules/core/types'
import {
  dialogDescriptionClass,
  dialogInfoPanelClass,
  dialogMutedIconClass,
  dialogMutedTextClass,
  dialogNeutralPanelClass,
  dialogSecondaryInlineTextClass,
  dialogWarningPanelClass,
} from '@/components/dialogs/dialogThemeStyles'

/**
 * Column info for the mapper
 */
export interface OneWayAnovaColumnInfo {
  columnName: string
  columnId: string
  dataType: ColumnDataType
  uniqueValueCount?: number
  uniqueValues?: string[]
}

/**
 * Post-hoc adjustment methods
 */
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

/**
 * Result of the column mapping
 */
export interface OneWayAnovaColumnMapping {
  group?: string // columnId for grouping variable (categorical, long format)
  outcome?: string // columnId for outcome/numeric variable (long format)
  posthoc_adjustment?: PostHocAdjustmentMethod // Post-hoc adjustment method
  control_level?: string // Control level for Dunnett (required when posthoc_adjustment='dunnett')
  posthoc_q?: number // FDR q-value (only used when posthoc_adjustment='fdr_bh')
}

interface OneWayAnovaColumnMapperDialogProps {
  open: boolean
  columns: OneWayAnovaColumnInfo[]
  testName: string
  /** Group levels extracted from the data (for Dunnett control selection) */
  groupLevels?: string[]
  onConfirm: (mapping: OneWayAnovaColumnMapping) => void
  onCancel: () => void
}

type OneWayFieldKey = 'group' | 'outcome'

interface FieldDefinition {
  key: OneWayFieldKey
  label: string
  description: string
  icon: typeof Users
  filterFn: (col: OneWayAnovaColumnInfo) => boolean
}

export function OneWayAnovaColumnMapperDialog({
  open,
  columns,
  testName,
  groupLevels = [],
  onConfirm,
  onCancel,
}: OneWayAnovaColumnMapperDialogProps) {
  const [mapping, setMapping] = useState<Partial<OneWayAnovaColumnMapping>>({})
  const [posthocMethod, setPosthocMethod] =
    useState<PostHocAdjustmentMethod>('tukey')
  const [controlLevel, setControlLevel] = useState<string>('')
  const [posthocQInput, setPosthocQInput] = useState<string>('0.05')

  // Filter columns by type
  const categoricalColumns = useMemo(
    () =>
      columns.filter(
        col =>
          col.dataType === ColumnDataType.Categorical ||
          col.dataType === ColumnDataType.Binary
      ),
    [columns]
  )

  const numericColumns = useMemo(
    () =>
      columns.filter(
        col =>
          col.dataType === ColumnDataType.Numeric ||
          col.dataType === ColumnDataType.Ordinal
      ),
    [columns]
  )

  const isWideFormat = useMemo(() => {
    return categoricalColumns.length === 0 && numericColumns.length >= 2
  }, [categoricalColumns.length, numericColumns.length])

  // Field definitions with appropriate filters
  const FIELD_DEFINITIONS: FieldDefinition[] = useMemo(() => {
    if (isWideFormat) {
      return []
    }
    return [
      {
        key: 'group' as const,
        label: 'Grouping Variable',
        description:
          'The categorical variable defining the groups to compare (e.g., Treatment: Control/Drug A/Drug B)',
        icon: Users,
        filterFn: (col: OneWayAnovaColumnInfo) =>
          col.dataType === ColumnDataType.Categorical ||
          col.dataType === ColumnDataType.Binary,
      },
      {
        key: 'outcome' as const,
        label: 'Outcome Variable',
        description:
          'The numeric variable you are measuring (dependent variable)',
        icon: BarChart3,
        filterFn: (col: OneWayAnovaColumnInfo) =>
          col.dataType === ColumnDataType.Numeric ||
          col.dataType === ColumnDataType.Ordinal,
      },
    ]
  }, [isWideFormat])

  // Reset mapping when dialog opens
  useEffect(() => {
    if (!open) {
      return
    }
    if (isWideFormat) {
      setMapping({})
    } else if (categoricalColumns.length === 1 && numericColumns.length === 1) {
      // Auto-select if exactly 1 categorical and 1 numeric column
      setMapping({
        group: categoricalColumns[0]!.columnId,
        outcome: numericColumns[0]!.columnId,
      })
    } else if (categoricalColumns.length >= 1 && numericColumns.length >= 1) {
      // Auto-select first of each type
      setMapping({
        group: categoricalColumns[0]!.columnId,
        outcome: numericColumns[0]!.columnId,
      })
    } else {
      setMapping({})
    }
    // Reset post-hoc settings
    setPosthocMethod('tukey')
    setControlLevel('')
    setPosthocQInput('0.05')
  }, [open, categoricalColumns, numericColumns, isWideFormat])

  // Resolve group levels (prefer explicit prop, else infer from selected group column)
  const resolvedGroupLevels = useMemo(() => {
    if (groupLevels.length > 0) return groupLevels
    if (isWideFormat) {
      return numericColumns.map(col => col.columnName)
    }
    const selectedGroup = mapping.group
    if (!selectedGroup) return []
    const col = columns.find(
      candidate =>
        candidate.columnId === selectedGroup ||
        candidate.columnName === selectedGroup
    )
    return col?.uniqueValues ?? []
  }, [groupLevels, mapping.group, columns, isWideFormat, numericColumns])

  // Check if Dunnett is selected (requires control level)
  const isDunnett = posthocMethod === 'dunnett'
  const isFdr = posthocMethod === 'fdr_bh'

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

  // Validation for Dunnett control level
  const dunnettValidationError = useMemo(() => {
    if (isDunnett && resolvedGroupLevels.length > 0 && !controlLevel) {
      return 'Select a control level for Dunnett comparison.'
    }
    if (isDunnett && resolvedGroupLevels.length < 3) {
      return 'Dunnett requires at least 3 groups (1 control + 2 treatments).'
    }
    return null
  }, [isDunnett, resolvedGroupLevels, controlLevel])

  // Get available columns for a field based on its filter
  const getAvailableColumns = useCallback(
    (fieldKey: OneWayFieldKey) => {
      const field = FIELD_DEFINITIONS.find(f => f.key === fieldKey)
      if (!field) return []
      return columns.filter(field.filterFn)
    },
    [columns, FIELD_DEFINITIONS]
  )

  // Check if mapping is complete
  const isComplete = useMemo(() => {
    if (isWideFormat) return true
    return (
      !!mapping.group && !!mapping.outcome && mapping.group !== mapping.outcome
    )
  }, [mapping, isWideFormat])

  // Check for duplicates
  const hasDuplicates = useMemo(() => {
    if (isWideFormat) return false
    return Boolean(
      mapping.group && mapping.outcome && mapping.group === mapping.outcome
    )
  }, [mapping, isWideFormat])

  // Get group column info for validation
  const groupColumn = useMemo(() => {
    if (!mapping.group) return null
    return columns.find(col => col.columnId === mapping.group) ?? null
  }, [mapping.group, columns])

  // Validate group has at least 2 categories
  const groupValidationError = useMemo(() => {
    if (isWideFormat) return null
    if (!groupColumn) return null
    if (
      groupColumn.uniqueValueCount !== undefined &&
      groupColumn.uniqueValueCount < 2
    ) {
      return `Grouping variable must have at least 2 values. "${groupColumn.columnName}" has ${groupColumn.uniqueValueCount} value(s).`
    }
    return null
  }, [groupColumn, isWideFormat])

  // Validation message
  const validationMessage = useMemo(() => {
    if (!isWideFormat) {
      if (hasDuplicates) {
        return 'Grouping and Outcome must be different columns.'
      }
      if (!mapping.group) {
        return 'Select a column for the Grouping variable.'
      }
      if (!mapping.outcome) {
        return 'Select a column for the Outcome variable.'
      }
      if (groupValidationError) {
        return groupValidationError
      }
    }
    if (dunnettValidationError) {
      return dunnettValidationError
    }
    if (posthocQError) {
      return posthocQError
    }
    return null
  }, [
    hasDuplicates,
    mapping,
    groupValidationError,
    dunnettValidationError,
    posthocQError,
    isWideFormat,
  ])

  const handleFieldChange = useCallback(
    (fieldKey: OneWayFieldKey, value: string) => {
      setMapping(prev => ({ ...prev, [fieldKey]: value }))
      if (fieldKey === 'group') {
        setControlLevel('')
      }
    },
    []
  )

  const handleConfirm = useCallback(() => {
    if (
      !isComplete ||
      hasDuplicates ||
      groupValidationError ||
      dunnettValidationError ||
      posthocQError
    ) {
      return
    }

    onConfirm({
      group: mapping.group as string | undefined,
      outcome: mapping.outcome as string | undefined,
      posthoc_adjustment: posthocMethod,
      control_level: isDunnett ? controlLevel : undefined,
      posthoc_q: isFdr ? (posthocQValue ?? undefined) : undefined,
    })
  }, [
    hasDuplicates,
    isComplete,
    mapping,
    onConfirm,
    groupValidationError,
    dunnettValidationError,
    posthocMethod,
    controlLevel,
    isDunnett,
    isFdr,
    posthocQError,
    posthocQValue,
  ])

  const handleCancel = useCallback(() => {
    setMapping({})
    onCancel()
  }, [onCancel])

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="max-w-lg" data-testid="one-way-anova-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-semibold">
            <BarChart3 className="h-5 w-5" />
            Configure {testName}
          </DialogTitle>
          <DialogDescription className={dialogDescriptionClass}>
            {isWideFormat
              ? 'One-Way ANOVA in wide format: selected numeric columns are treated as groups.'
              : 'Map your selected columns to the One-Way ANOVA inputs. Specify which column is the grouping variable and which is the outcome (numeric) variable.'}
          </DialogDescription>
        </DialogHeader>

        <div className={dialogInfoPanelClass}>
          <p>
            <strong>Note:</strong>{' '}
            {isWideFormat
              ? 'Each numeric column represents an independent group. Rows are not paired.'
              : 'One-Way ANOVA compares means across 2 or more independent groups. The grouping variable must have at least 2 unique values (e.g., Control, Drug A, Drug B).'}
          </p>
        </div>

        <div className="space-y-4">
          {FIELD_DEFINITIONS.map(field => (
            <FieldSelector
              key={field.key}
              field={field}
              value={mapping[field.key]}
              columns={getAvailableColumns(field.key)}
              onChange={value => handleFieldChange(field.key, value)}
            />
          ))}

          {isWideFormat && (
            <div className={dialogNeutralPanelClass}>
              <strong>Groups:</strong>{' '}
              {numericColumns.length > 0
                ? numericColumns.map(col => col.columnName).join(', ')
                : 'No numeric columns selected.'}
            </div>
          )}

          {/* Post-Hoc Adjustment Method */}
          <div className="space-y-1.5 border-t pt-4">
            <Label className="text-sm font-medium flex items-center gap-1.5">
              <Settings2 className={`h-3.5 w-3.5 ${dialogMutedIconClass}`} />
              Post-Hoc Adjustment Method
            </Label>
            <Select
              value={posthocMethod}
              onValueChange={v =>
                setPosthocMethod(v as PostHocAdjustmentMethod)
              }
            >
              <SelectTrigger
                className="w-full"
                data-testid="one-way-adjustment-select"
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
            <p className={dialogMutedTextClass}>
              Controls Type I error rate when comparing multiple groups.
            </p>
          </div>

          {isFdr && (
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">FDR q-value</Label>
              <Input
                value={posthocQInput}
                onChange={e => setPosthocQInput(e.target.value)}
                placeholder="0.05"
                inputMode="decimal"
              />
              <p className={dialogMutedTextClass}>
                False discovery rate threshold (e.g., 0.05 or 0.1).
              </p>
              {posthocQError && (
                <p className="text-xs text-red-600">{posthocQError}</p>
              )}
            </div>
          )}

          {/* Control Level for Dunnett */}
          {isDunnett && resolvedGroupLevels.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-sm font-medium flex items-center gap-1.5">
                <Users className={`h-3.5 w-3.5 ${dialogMutedIconClass}`} />
                Control Group
              </Label>
              <Select value={controlLevel} onValueChange={setControlLevel}>
                <SelectTrigger
                  className="w-full"
                  data-testid="one-way-control-select"
                >
                  <SelectValue placeholder="Select control group" />
                </SelectTrigger>
                <SelectContent>
                  {resolvedGroupLevels.map(level => (
                    <SelectItem key={level} value={level} data-value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className={dialogMutedTextClass}>
                Dunnett compares all treatment groups to this control group.
              </p>
            </div>
          )}
        </div>

        {validationMessage && (
          <div className={dialogWarningPanelClass}>
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{validationMessage}</span>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={
              !isComplete ||
              hasDuplicates ||
              !!groupValidationError ||
              !!dunnettValidationError ||
              !!posthocQError
            }
            data-testid="one-way-anova-run"
          >
            Run Analysis
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface FieldSelectorProps {
  field: FieldDefinition
  value: string | undefined
  columns: OneWayAnovaColumnInfo[]
  onChange: (value: string) => void
}

function FieldSelector({
  field,
  value,
  columns,
  onChange,
}: FieldSelectorProps) {
  const Icon = field.icon
  const selectTestId =
    field.key === 'group'
      ? 'one-way-group-select'
      : field.key === 'outcome'
        ? 'one-way-outcome-select'
        : undefined

  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium flex items-center gap-1.5">
        <Icon className={`h-3.5 w-3.5 ${dialogMutedIconClass}`} />
        {field.label}
      </Label>
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger className="w-full" data-testid={selectTestId}>
          <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent>
          {columns.map(col => (
            <SelectItem
              key={col.columnId}
              value={col.columnId}
              data-value={col.columnId}
              data-label={col.columnName}
            >
              {col.columnName}
              {col.uniqueValueCount !== undefined && (
                <span className={dialogSecondaryInlineTextClass}>
                  ({col.uniqueValueCount} values)
                </span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className={dialogMutedTextClass}>{field.description}</p>
    </div>
  )
}
