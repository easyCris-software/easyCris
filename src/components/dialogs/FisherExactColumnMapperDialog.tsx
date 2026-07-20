/**
 * Fisher's Exact Test Column Mapper Dialog
 *
 * Lets users explicitly map two categorical columns to:
 * - Group (row variable)
 * - Outcome (column variable)
 *
 * This prevents ambiguity about which column is group vs outcome.
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
import { AlertCircle, Users, Target } from 'lucide-react'
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
export interface FisherExactColumnInfo {
  columnName: string
  columnId: string
  dataType: ColumnDataType
}

/**
 * Result of the column mapping
 */
export interface FisherExactColumnMapping {
  group: string // columnId for group/row variable
  outcome: string // columnId for outcome/column variable
}

interface FisherExactColumnMapperDialogProps {
  open: boolean
  columns: FisherExactColumnInfo[]
  testName: string
  onConfirm: (mapping: FisherExactColumnMapping) => void
  onCancel: () => void
}

interface FieldDefinition {
  key: keyof FisherExactColumnMapping
  label: string
  description: string
  icon: typeof Users
}

const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    key: 'group',
    label: 'Group Variable',
    description:
      'The categorical variable defining the groups (rows in contingency table)',
    icon: Users,
  },
  {
    key: 'outcome',
    label: 'Outcome Variable',
    description:
      'The categorical variable defining the outcome (columns in contingency table)',
    icon: Target,
  },
]

export function FisherExactColumnMapperDialog({
  open,
  columns,
  testName,
  onConfirm,
  onCancel,
}: FisherExactColumnMapperDialogProps) {
  const [mapping, setMapping] = useState<Partial<FisherExactColumnMapping>>({})

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
        group: categoricalColumns[0]!.columnId,
        outcome: categoricalColumns[1]!.columnId,
      })
    } else {
      setMapping({})
    }
  }, [open, categoricalColumns])

  // Get available columns for a field (exclude already selected)
  const getAvailableColumns = useCallback(
    (fieldKey: keyof FisherExactColumnMapping) => {
      const otherKey = fieldKey === 'group' ? 'outcome' : 'group'
      const otherValue = mapping[otherKey]
      return categoricalColumns.filter(col => col.columnId !== otherValue)
    },
    [categoricalColumns, mapping]
  )

  // Check if mapping is complete
  const isComplete = useMemo(() => {
    return (
      !!mapping.group && !!mapping.outcome && mapping.group !== mapping.outcome
    )
  }, [mapping])

  // Check for duplicates
  const hasDuplicates = useMemo(() => {
    return Boolean(
      mapping.group && mapping.outcome && mapping.group === mapping.outcome
    )
  }, [mapping])

  // Validation message
  const validationMessage = useMemo(() => {
    if (hasDuplicates) {
      return 'Group and Outcome must be different columns.'
    }
    if (!mapping.group) {
      return 'Select a column for the Group variable.'
    }
    if (!mapping.outcome) {
      return 'Select a column for the Outcome variable.'
    }
    return null
  }, [hasDuplicates, mapping])

  const handleFieldChange = useCallback(
    (fieldKey: keyof FisherExactColumnMapping, value: string) => {
      setMapping(prev => ({ ...prev, [fieldKey]: value }))
    },
    []
  )

  const handleConfirm = useCallback(() => {
    if (!isComplete || hasDuplicates) {
      return
    }

    onConfirm({
      group: mapping.group as string,
      outcome: mapping.outcome as string,
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
            <Users className="h-5 w-5" />
            Configure {testName}
          </DialogTitle>
          <DialogDescription className={dialogDescriptionClass}>
            Map your selected columns to the Fisher's Exact Test inputs. Specify
            which column represents the group (rows) and which represents the
            outcome (columns).
          </DialogDescription>
        </DialogHeader>

        <div className={dialogInfoPanelClass}>
          <p>
            <strong>Note:</strong> Fisher's Exact Test requires a 2×2
            contingency table. Each column must have exactly 2 categories.
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
  columns: FisherExactColumnInfo[]
  allColumns: FisherExactColumnInfo[]
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
