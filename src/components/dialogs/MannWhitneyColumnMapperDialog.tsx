/**
 * Mann-Whitney U Test Column Mapper Dialog
 *
 * Lets users explicitly map columns to:
 * - Group (categorical variable with exactly 2 groups)
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AlertCircle, Users, BarChart3 } from 'lucide-react'
import { ColumnDataType } from '@/lib/modules/core/types'

/**
 * Column info for the mapper
 */
export interface MannWhitneyColumnInfo {
  columnName: string
  columnId: string
  dataType: ColumnDataType
  uniqueValueCount?: number
}

/**
 * Result of the column mapping
 */
export interface MannWhitneyColumnMapping {
  group: string // columnId for group/categorical variable
  outcome: string // columnId for outcome/numeric variable
}

interface MannWhitneyColumnMapperDialogProps {
  open: boolean
  columns: MannWhitneyColumnInfo[]
  testName: string
  onConfirm: (mapping: MannWhitneyColumnMapping) => void
  onCancel: () => void
}

interface FieldDefinition {
  key: keyof MannWhitneyColumnMapping
  label: string
  description: string
  icon: typeof Users
  filterFn: (col: MannWhitneyColumnInfo) => boolean
}

export function MannWhitneyColumnMapperDialog({
  open,
  columns,
  testName,
  onConfirm,
  onCancel,
}: MannWhitneyColumnMapperDialogProps) {
  const [mapping, setMapping] = useState<Partial<MannWhitneyColumnMapping>>({})

  // Filter columns by type
  const categoricalColumns = useMemo(
    () =>
      columns.filter(
        (col) =>
          col.dataType === ColumnDataType.Categorical || col.dataType === ColumnDataType.Binary
      ),
    [columns]
  )

  const numericColumns = useMemo(
    () =>
      columns.filter(
        (col) =>
          col.dataType === ColumnDataType.Numeric || col.dataType === ColumnDataType.Ordinal
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
          description: 'First independent group (numeric column)',
          icon: BarChart3,
          filterFn: (col: MannWhitneyColumnInfo) =>
            col.dataType === ColumnDataType.Numeric || col.dataType === ColumnDataType.Ordinal,
        },
        {
          key: 'outcome' as const,
          label: 'Column B',
          description: 'Second independent group (numeric column)',
          icon: BarChart3,
          filterFn: (col: MannWhitneyColumnInfo) =>
            col.dataType === ColumnDataType.Numeric || col.dataType === ColumnDataType.Ordinal,
        },
      ]
    }

    return [
      {
        key: 'group' as const,
        label: 'Group Variable',
        description: 'The categorical variable defining the two groups (e.g., Control/Drug)',
        icon: Users,
        filterFn: (col: MannWhitneyColumnInfo) =>
          col.dataType === ColumnDataType.Categorical || col.dataType === ColumnDataType.Binary,
      },
      {
        key: 'outcome' as const,
        label: 'Outcome Variable',
        description: 'The numeric variable you are measuring (dependent variable)',
        icon: BarChart3,
        filterFn: (col: MannWhitneyColumnInfo) =>
          col.dataType === ColumnDataType.Numeric || col.dataType === ColumnDataType.Ordinal,
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
      setMapping({
        group: categoricalColumns[0]!.columnId,
        outcome: numericColumns[0]!.columnId,
      })
      return
    }

    if (categoricalColumns.length >= 1 && numericColumns.length >= 1) {
      // Auto-select first of each type
      setMapping({
        group: categoricalColumns[0]!.columnId,
        outcome: numericColumns[0]!.columnId,
      })
      return
    }

    setMapping({})
  }, [open, categoricalColumns, numericColumns, isWideFormat])

  // Get available columns for a field based on its filter
  const getAvailableColumns = useCallback(
    (fieldKey: keyof MannWhitneyColumnMapping) => {
      const field = FIELD_DEFINITIONS.find((f) => f.key === fieldKey)
      if (!field) return []
      return columns.filter(field.filterFn)
    },
    [columns, FIELD_DEFINITIONS]
  )

  // Check if mapping is complete
  const isComplete = useMemo(() => {
    return !!mapping.group && !!mapping.outcome && mapping.group !== mapping.outcome
  }, [mapping])

  // Check for duplicates
  const hasDuplicates = useMemo(() => {
    return Boolean(mapping.group && mapping.outcome && mapping.group === mapping.outcome)
  }, [mapping])

  // Get group column info for validation
  const groupColumn = useMemo(() => {
    if (!mapping.group) return null
    return columns.find((col) => col.columnId === mapping.group) ?? null
  }, [mapping.group, columns])

  // Validate group has exactly 2 categories
  const groupValidationError = useMemo(() => {
    if (isWideFormat) return null
    if (!groupColumn) return null
    if (groupColumn.uniqueValueCount !== undefined && groupColumn.uniqueValueCount !== 2) {
      return `Group variable must have exactly 2 categories. "${groupColumn.columnName}" has ${groupColumn.uniqueValueCount} categories.`
    }
    return null
  }, [groupColumn, isWideFormat])

  // Validation message
  const validationMessage = useMemo(() => {
    if (hasDuplicates) {
      return isWideFormat
        ? 'Column A and Column B must be different.'
        : 'Group and Outcome must be different columns.'
    }
    if (!mapping.group) {
      return isWideFormat
        ? 'Select a column for Column A.'
        : 'Select a column for the Group variable.'
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
    (fieldKey: keyof MannWhitneyColumnMapping, value: string) => {
      setMapping((prev) => ({ ...prev, [fieldKey]: value }))
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
          <DialogDescription className="text-sm text-gray-600">
            {isWideFormat
              ? 'Mann-Whitney U Test in wide format: choose the two numeric columns representing the groups.'
              : 'Map your selected columns to the Mann-Whitney U inputs. Specify which column is the grouping variable and which is the outcome (numeric) variable.'}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
          <p>
            <strong>Note:</strong>{' '}
            {isWideFormat
              ? 'Each numeric column represents an independent group. Rows are not paired.'
              : 'Mann-Whitney U compares two independent groups. The group variable must have exactly 2 categories (e.g., Control vs Treatment).'}
          </p>
        </div>

        <div className="space-y-4">
          {FIELD_DEFINITIONS.map((field) => (
            <FieldSelector
              key={field.key}
              field={field}
              value={mapping[field.key]}
              columns={getAvailableColumns(field.key)}
              onChange={(value) => handleFieldChange(field.key, value)}
            />
          ))}
        </div>

        {validationMessage && (
          <div className="flex items-center gap-2 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
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
            disabled={!isComplete || Boolean(groupValidationError) || hasDuplicates}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface FieldSelectorProps {
  field: FieldDefinition
  value?: string
  columns: MannWhitneyColumnInfo[]
  onChange: (value: string) => void
}

function FieldSelector({ field, value, columns, onChange }: FieldSelectorProps) {
  const Icon = field.icon
  const hasOptions = columns.length > 0

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {field.label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue
            placeholder={hasOptions ? `Select ${field.label.toLowerCase()}` : 'No columns available'}
          />
        </SelectTrigger>
        <SelectContent>
          {columns.map((col) => (
            <SelectItem key={col.columnId} value={col.columnId}>
              {col.columnName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{field.description}</p>
    </div>
  )
}
