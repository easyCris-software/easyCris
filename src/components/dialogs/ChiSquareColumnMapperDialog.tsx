/**
 * Chi-Square Independence Column Mapper Dialog
 *
 * Lets users map selected categorical columns to:
 * - Group (row variable)
 * - Outcome (column variable)
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
import { AlertCircle, Rows, Columns } from 'lucide-react'
import { ColumnDataType } from '@/lib/modules/core/types'

export interface ChiSquareColumnInfo {
  columnName: string
  columnId: string
  dataType: ColumnDataType
}

export interface ChiSquareColumnMapping {
  group: string // columnId for row variable
  outcome: string // columnId for column variable
}

interface ChiSquareColumnMapperDialogProps {
  open: boolean
  columns: ChiSquareColumnInfo[]
  testName: string
  onConfirm: (mapping: ChiSquareColumnMapping) => void
  onCancel: () => void
}

interface FieldDefinition {
  key: keyof ChiSquareColumnMapping
  label: string
  description: string
  icon: typeof Rows
}

const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    key: 'group',
    label: 'Group (Row Variable)',
    description: 'Categorical grouping variable (rows in the contingency table)',
    icon: Rows,
  },
  {
    key: 'outcome',
    label: 'Outcome (Column Variable)',
    description: 'Categorical outcome variable (columns in the contingency table)',
    icon: Columns,
  },
]

export function ChiSquareColumnMapperDialog({
  open,
  columns,
  testName,
  onConfirm,
  onCancel,
}: ChiSquareColumnMapperDialogProps) {
  const [mapping, setMapping] = useState<Partial<ChiSquareColumnMapping>>({})

  const categoricalColumns = useMemo(
    () =>
      columns.filter(
        (col) =>
          col.dataType === ColumnDataType.Categorical || col.dataType === ColumnDataType.Binary
      ),
    [columns]
  )

  useEffect(() => {
    if (open) {
      setMapping({})
    }
  }, [open])

  const getAvailableColumns = useCallback(
    (fieldKey: keyof ChiSquareColumnMapping) => {
      const selectedValues = Object.entries(mapping)
        .filter(([key, value]) => key !== fieldKey && value)
        .map(([, value]) => value)

      return categoricalColumns.filter((col) => !selectedValues.includes(col.columnId))
    },
    [categoricalColumns, mapping]
  )

  const isComplete = useMemo(() => {
    return FIELD_DEFINITIONS.every((field) => mapping[field.key])
  }, [mapping])

  const hasDuplicates = useMemo(() => {
    const values = Object.values(mapping).filter(Boolean)
    return new Set(values).size !== values.length
  }, [mapping])

  const validationMessage = useMemo(() => {
    if (hasDuplicates) {
      return 'Each column can only be assigned to one field.'
    }
    if (!isComplete) {
      const missing = FIELD_DEFINITIONS.filter((f) => !mapping[f.key]).map((f) => f.label)
      return `Please select columns for: ${missing.join(', ')}`
    }
    return null
  }, [isComplete, hasDuplicates, mapping])

  const handleFieldChange = useCallback((fieldKey: keyof ChiSquareColumnMapping, value: string) => {
    setMapping((prev) => ({ ...prev, [fieldKey]: value }))
  }, [])

  const handleConfirm = useCallback(() => {
    if (isComplete && !hasDuplicates) {
      onConfirm(mapping as ChiSquareColumnMapping)
    }
  }, [mapping, isComplete, hasDuplicates, onConfirm])

  const handleCancel = useCallback(() => {
    setMapping({})
    onCancel()
  }, [onCancel])

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-semibold">
            <Rows className="h-5 w-5" />
            Configure {testName}
          </DialogTitle>
          <DialogDescription className="text-sm text-gray-600">
            Map your selected categorical columns to the row and column variables used to build the
            contingency table.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
          <p>
            <strong>Tip:</strong> Group determines the table rows, and Outcome determines the
            table columns. Swap them if you want a different orientation.
          </p>
        </div>

        <div className="space-y-4">
          {FIELD_DEFINITIONS.map((field) => (
            <FieldSelector
              key={field.key}
              field={field}
              value={mapping[field.key]}
              columns={getAvailableColumns(field.key)}
              allColumns={categoricalColumns}
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
          <Button onClick={handleConfirm} disabled={!isComplete || hasDuplicates}>
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
  columns: ChiSquareColumnInfo[]
  allColumns: ChiSquareColumnInfo[]
  onChange: (value: string) => void
}

function FieldSelector({ field, value, columns, allColumns, onChange }: FieldSelectorProps) {
  const Icon = field.icon

  const isColumnAvailable = useCallback(
    (columnId: string) => columns.some((c) => c.columnId === columnId),
    [columns]
  )

  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-gray-500" />
        {field.label}
      </Label>
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent>
          {allColumns.map((col) => {
            const available = isColumnAvailable(col.columnId)
            return (
              <SelectItem
                key={col.columnId}
                value={col.columnId}
                disabled={!available && col.columnId !== value}
              >
                {col.columnName}
                {!available && col.columnId !== value && (
                  <span className="text-gray-400 ml-2">(in use)</span>
                )}
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
      <p className="text-xs text-gray-500">{field.description}</p>
    </div>
  )
}
