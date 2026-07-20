/**
 * McNemar's Test Column Mapper Dialog
 *
 * Lets users explicitly map two categorical columns to:
 * - Before (row variable - pre-treatment/baseline)
 * - After (column variable - post-treatment/follow-up)
 *
 * This prevents ambiguity about which column is before vs after.
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
import { AlertCircle, ArrowRight, Clock } from 'lucide-react'
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
export interface McNemarColumnInfo {
  columnName: string
  columnId: string
  dataType: ColumnDataType
}

/**
 * Result of the column mapping
 */
export interface McNemarColumnMapping {
  before: string // columnId for before/pre-treatment variable
  after: string // columnId for after/post-treatment variable
}

interface McNemarColumnMapperDialogProps {
  open: boolean
  columns: McNemarColumnInfo[]
  testName: string
  onConfirm: (mapping: McNemarColumnMapping) => void
  onCancel: () => void
}

interface FieldDefinition {
  key: keyof McNemarColumnMapping
  label: string
  description: string
  icon: typeof Clock
}

const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    key: 'before',
    label: 'Before (Pre-Treatment)',
    description:
      'The categorical variable measured before the intervention (rows in contingency table)',
    icon: Clock,
  },
  {
    key: 'after',
    label: 'After (Post-Treatment)',
    description:
      'The categorical variable measured after the intervention (columns in contingency table)',
    icon: ArrowRight,
  },
]

export function McNemarColumnMapperDialog({
  open,
  columns,
  testName,
  onConfirm,
  onCancel,
}: McNemarColumnMapperDialogProps) {
  const [mapping, setMapping] = useState<Partial<McNemarColumnMapping>>({})

  // Filter to only categorical/binary columns
  const categoricalColumns = useMemo(
    () =>
      columns.filter(
        col =>
          col.dataType === ColumnDataType.Categorical ||
          col.dataType === ColumnDataType.Binary
      ),
    [columns]
  )

  // Reset mapping when dialog opens
  useEffect(() => {
    if (!open) {
      return
    }
    // Auto-select if exactly 2 categorical columns
    if (categoricalColumns.length === 2) {
      setMapping({
        before: categoricalColumns[0]!.columnId,
        after: categoricalColumns[1]!.columnId,
      })
    } else {
      setMapping({})
    }
  }, [open, categoricalColumns])

  // Get available columns for a field (exclude already selected)
  const getAvailableColumns = useCallback(
    (fieldKey: keyof McNemarColumnMapping) => {
      const otherKey = fieldKey === 'before' ? 'after' : 'before'
      const otherValue = mapping[otherKey]
      return categoricalColumns.filter(col => col.columnId !== otherValue)
    },
    [categoricalColumns, mapping]
  )

  // Check if mapping is complete
  const isComplete = useMemo(() => {
    return (
      !!mapping.before && !!mapping.after && mapping.before !== mapping.after
    )
  }, [mapping])

  // Check for duplicates
  const hasDuplicates = useMemo(() => {
    return Boolean(
      mapping.before && mapping.after && mapping.before === mapping.after
    )
  }, [mapping])

  // Validation message
  const validationMessage = useMemo(() => {
    if (hasDuplicates) {
      return 'Before and After must be different columns.'
    }
    if (!mapping.before) {
      return 'Select a column for the Before variable.'
    }
    if (!mapping.after) {
      return 'Select a column for the After variable.'
    }
    return null
  }, [hasDuplicates, mapping])

  const handleFieldChange = useCallback(
    (fieldKey: keyof McNemarColumnMapping, value: string) => {
      setMapping(prev => ({ ...prev, [fieldKey]: value }))
    },
    []
  )

  const handleConfirm = useCallback(() => {
    if (!isComplete || hasDuplicates) {
      return
    }

    onConfirm({
      before: mapping.before as string,
      after: mapping.after as string,
    })
  }, [hasDuplicates, isComplete, mapping, onConfirm])

  const handleCancel = useCallback(() => {
    setMapping({})
    onCancel()
  }, [onCancel])

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-semibold">
            <Clock className="h-5 w-5" />
            Configure {testName}
          </DialogTitle>
          <DialogDescription className={dialogDescriptionClass}>
            Map your selected columns to the McNemar's Test inputs. Specify
            which column represents the before (pre-treatment) and which
            represents the after (post-treatment) measurement.
          </DialogDescription>
        </DialogHeader>

        <div className={dialogInfoPanelClass}>
          <p>
            <strong>Note:</strong> McNemar's Test requires paired binary data.
            Each column must have exactly 2 categories with identical labels
            (e.g., Yes/No measured before and after treatment).
          </p>
        </div>

        <div className="space-y-4">
          {FIELD_DEFINITIONS.map(field => (
            <FieldSelector
              key={field.key}
              field={field}
              value={mapping[field.key]}
              columns={getAvailableColumns(field.key)}
              allColumns={categoricalColumns}
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
            disabled={!isComplete || hasDuplicates}
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
  columns: McNemarColumnInfo[]
  allColumns: McNemarColumnInfo[]
  onChange: (value: string) => void
}

function FieldSelector({
  field,
  value,
  columns,
  allColumns,
  onChange,
}: FieldSelectorProps) {
  const Icon = field.icon

  const isColumnAvailable = useCallback(
    (columnId: string) => columns.some(c => c.columnId === columnId),
    [columns]
  )

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
          {allColumns.map(col => {
            const available = isColumnAvailable(col.columnId)
            return (
              <SelectItem
                key={col.columnId}
                value={col.columnId}
                disabled={!available && col.columnId !== value}
              >
                {col.columnName}
                {!available && col.columnId !== value && (
                  <span className={dialogSecondaryInlineTextClass}>
                    (in use)
                  </span>
                )}
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
      <p className={dialogMutedTextClass}>{field.description}</p>
    </div>
  )
}
