/**
 * Wilcoxon Signed-Rank Test Column Mapper Dialog
 *
 * Lets users explicitly map columns to:
 * - Group (time/condition variable with exactly 2 values like Pre/Post)
 * - Outcome (numeric variable - what you're measuring)
 *
 * This prevents ambiguity about which column is the time/condition variable vs the outcome.
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AlertCircle, Clock, BarChart3 } from 'lucide-react'
import { ColumnDataType } from '@/lib/modules/core/types'
import {
  dialogDescriptionClass,
  dialogInfoPanelClass,
  dialogMutedIconClass,
  dialogMutedTextClass,
  dialogSecondaryInlineTextClass,
  dialogWarningPanelClass,
} from '@/components/dialogs/dialogThemeStyles'

/**
 * Column info for the mapper
 */
export interface WilcoxonColumnInfo {
  columnName: string
  columnId: string
  dataType: ColumnDataType
  uniqueValueCount?: number
}

/**
 * Result of the column mapping
 */
export interface WilcoxonColumnMapping {
  group: string // columnId for group/time/condition variable
  outcome: string // columnId for outcome/numeric variable
  pair_id?: string // columnId for pair/subject identifier (optional for wide format)
}

interface WilcoxonColumnMapperDialogProps {
  open: boolean
  columns: WilcoxonColumnInfo[]
  testName: string
  onConfirm: (mapping: WilcoxonColumnMapping) => void
  onCancel: () => void
}

interface FieldDefinition {
  key: keyof WilcoxonColumnMapping
  label: string
  description: string
  icon: typeof Clock
  filterFn: (col: WilcoxonColumnInfo) => boolean
}

export function WilcoxonColumnMapperDialog({
  open,
  columns,
  testName,
  onConfirm,
  onCancel,
}: WilcoxonColumnMapperDialogProps) {
  const [mapping, setMapping] = useState<Partial<WilcoxonColumnMapping>>({})

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
      return [
        {
          key: 'group' as const,
          label: 'Column A',
          description: 'First paired measurement (e.g., Pre)',
          icon: BarChart3,
          filterFn: (col: WilcoxonColumnInfo) =>
            col.dataType === ColumnDataType.Numeric ||
            col.dataType === ColumnDataType.Ordinal,
        },
        {
          key: 'outcome' as const,
          label: 'Column B',
          description: 'Second paired measurement (e.g., Post)',
          icon: BarChart3,
          filterFn: (col: WilcoxonColumnInfo) =>
            col.dataType === ColumnDataType.Numeric ||
            col.dataType === ColumnDataType.Ordinal,
        },
      ]
    }

    return [
      {
        key: 'group' as const,
        label: 'Time/Condition Variable',
        description:
          'The categorical variable defining the two time points (e.g., Time: Pre/Post, Condition: Before/After)',
        icon: Clock,
        filterFn: (col: WilcoxonColumnInfo) =>
          col.dataType === ColumnDataType.Categorical ||
          col.dataType === ColumnDataType.Binary,
      },
      {
        key: 'outcome' as const,
        label: 'Outcome Variable',
        description:
          'The numeric variable you are measuring (dependent variable)',
        icon: BarChart3,
        filterFn: (col: WilcoxonColumnInfo) =>
          col.dataType === ColumnDataType.Numeric ||
          col.dataType === ColumnDataType.Ordinal,
      },
      {
        key: 'pair_id' as const,
        label: 'Pair/Subject ID',
        description:
          'Identifier that links the paired observations (e.g., Subject ID)',
        icon: Clock,
        filterFn: () => true,
      },
    ]
  }, [isWideFormat])

  // Reset mapping when dialog opens
  useEffect(() => {
    if (!open) {
      return
    }
    if (isWideFormat) {
      setMapping({
        group: numericColumns[0]?.columnId ?? '',
        outcome: numericColumns[1]?.columnId ?? '',
      })
      return
    }

    // Auto-select if exactly 1 categorical and 1 numeric column
    if (categoricalColumns.length === 1 && numericColumns.length === 1) {
      const fallbackPair =
        columns.find(
          col =>
            col.columnId !== categoricalColumns[0]!.columnId &&
            col.columnId !== numericColumns[0]!.columnId
        )?.columnId ?? ''
      setMapping({
        group: categoricalColumns[0]!.columnId,
        outcome: numericColumns[0]!.columnId,
        pair_id: fallbackPair,
      })
      return
    }

    if (categoricalColumns.length >= 1 && numericColumns.length >= 1) {
      const fallbackPair =
        columns.find(
          col =>
            col.columnId !== categoricalColumns[0]!.columnId &&
            col.columnId !== numericColumns[0]!.columnId
        )?.columnId ?? ''
      // Auto-select first of each type
      setMapping({
        group: categoricalColumns[0]!.columnId,
        outcome: numericColumns[0]!.columnId,
        pair_id: fallbackPair,
      })
      return
    }

    setMapping({})
  }, [open, categoricalColumns, numericColumns, columns, isWideFormat])

  // Get available columns for a field based on its filter
  const getAvailableColumns = useCallback(
    (fieldKey: keyof WilcoxonColumnMapping) => {
      const field = FIELD_DEFINITIONS.find(f => f.key === fieldKey)
      if (!field) return []
      return columns.filter(field.filterFn)
    },
    [columns, FIELD_DEFINITIONS]
  )

  // Check if mapping is complete
  const isComplete = useMemo(() => {
    return (
      !!mapping.group &&
      !!mapping.outcome &&
      mapping.group !== mapping.outcome &&
      (isWideFormat ||
        (mapping.group !== mapping.pair_id &&
          mapping.outcome !== mapping.pair_id))
    )
  }, [mapping, isWideFormat])

  // Check for duplicates
  const hasDuplicates = useMemo(() => {
    const groupOutcomeDup =
      mapping.group && mapping.outcome && mapping.group === mapping.outcome
    if (isWideFormat) {
      return Boolean(groupOutcomeDup)
    }
    const groupPairDup =
      mapping.group && mapping.pair_id && mapping.group === mapping.pair_id
    const outcomePairDup =
      mapping.outcome && mapping.pair_id && mapping.outcome === mapping.pair_id
    return Boolean(groupOutcomeDup || groupPairDup || outcomePairDup)
  }, [mapping, isWideFormat])

  // Get group column info for validation
  const groupColumn = useMemo(() => {
    if (!mapping.group) return null
    return columns.find(col => col.columnId === mapping.group) ?? null
  }, [mapping.group, columns])

  // Validate group has exactly 2 categories
  const groupValidationError = useMemo(() => {
    if (isWideFormat) return null
    if (!groupColumn) return null
    if (
      groupColumn.uniqueValueCount !== undefined &&
      groupColumn.uniqueValueCount !== 2
    ) {
      return `Time/Condition variable must have exactly 2 values (e.g., Pre/Post). "${groupColumn.columnName}" has ${groupColumn.uniqueValueCount} values.`
    }
    return null
  }, [groupColumn, isWideFormat])

  // Validation message
  const validationMessage = useMemo(() => {
    if (hasDuplicates) {
      return isWideFormat
        ? 'Column A and Column B must be different.'
        : 'Time/Condition, Outcome, and Pair/Subject ID must be different columns.'
    }
    if (!mapping.group) {
      return isWideFormat
        ? 'Select a column for Column A.'
        : 'Select a column for the Time/Condition variable.'
    }
    if (!mapping.outcome) {
      return isWideFormat
        ? 'Select a column for Column B.'
        : 'Select a column for the Outcome variable.'
    }
    if (groupValidationError) {
      return groupValidationError
    }
    return null
  }, [hasDuplicates, mapping, groupValidationError, isWideFormat])

  const handleFieldChange = useCallback(
    (fieldKey: keyof WilcoxonColumnMapping, value: string) => {
      setMapping(prev => ({ ...prev, [fieldKey]: value }))
    },
    []
  )

  const handleConfirm = useCallback(() => {
    if (!isComplete || hasDuplicates || groupValidationError) {
      return
    }

    onConfirm({
      group: mapping.group as string,
      outcome: mapping.outcome as string,
      pair_id: mapping.pair_id as string | undefined,
    })
  }, [hasDuplicates, isComplete, mapping, onConfirm, groupValidationError])

  const handleCancel = useCallback(() => {
    setMapping({})
    onCancel()
  }, [onCancel])

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-semibold">
            <BarChart3 className="h-5 w-5" />
            Configure {testName}
          </DialogTitle>
          <DialogDescription className={dialogDescriptionClass}>
            {isWideFormat
              ? 'Wilcoxon Signed-Rank Test in wide format: choose the two numeric columns that form each pair.'
              : 'Map your selected columns to the Wilcoxon Signed-Rank Test inputs. Specify which column is the time/condition variable and which is the outcome (numeric) variable.'}
          </DialogDescription>
        </DialogHeader>

        <div className={dialogInfoPanelClass}>
          <p>
            <strong>Note:</strong>{' '}
            {isWideFormat
              ? 'Each row represents a paired observation. Column A pairs with Column B by row order.'
              : 'Wilcoxon Signed-Rank Test is a non-parametric test for matched pairs (e.g., before/after measurements). The time/condition variable must have exactly 2 values, and both groups must have equal sample sizes. Pair/Subject ID is optional; if omitted, pairing uses row order within each time point.'}
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
            disabled={!isComplete || hasDuplicates || !!groupValidationError}
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
  columns: WilcoxonColumnInfo[]
  onChange: (value: string) => void
}

function FieldSelector({
  field,
  value,
  columns,
  onChange,
}: FieldSelectorProps) {
  const Icon = field.icon

  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium flex items-center gap-1.5">
        <Icon className={`h-3.5 w-3.5 ${dialogMutedIconClass}`} />
        {field.label}
      </Label>
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent>
          {columns.map(col => (
            <SelectItem key={col.columnId} value={col.columnId}>
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
