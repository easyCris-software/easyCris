/**
 * Dose-Response Column Mapper Dialog
 *
 * Allows users to map their selected columns to the required dose-response fields:
 * - Dose (concentration/amount)
 * - Response (measured effect)
 *
 * This dialog appears after users select columns and before dose-response analysis runs.
 * It ensures clear, explicit mapping of data to the dose-response model requirements.
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
import { AlertCircle, Beaker, Activity } from 'lucide-react'

/**
 * Column info for the mapper
 */
export interface DoseResponseColumnInfo {
  columnName: string
  columnId: string
}

/**
 * Result of the column mapping
 */
export interface DoseResponseColumnMapping {
  dose: string // columnId for dose/concentration
  response: string // columnId for response/effect
}

interface DoseResponseColumnMapperDialogProps {
  open: boolean
  columns: DoseResponseColumnInfo[]
  testName: string // e.g., "3PL Dose-Response", "4PL Dose-Response"
  onConfirm: (mapping: DoseResponseColumnMapping) => void
  onCancel: () => void
}

/**
 * Field definition for the mapper
 */
interface FieldDefinition {
  key: keyof DoseResponseColumnMapping
  label: string
  description: string
  icon: typeof Beaker
}

const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    key: 'dose',
    label: 'Dose/Concentration',
    description: 'Independent variable: dose, concentration, or treatment level',
    icon: Beaker,
  },
  {
    key: 'response',
    label: 'Response/Effect',
    description: 'Dependent variable: measured biological response or effect',
    icon: Activity,
  },
]

/**
 * Dose-Response Column Mapper Dialog Component
 */
export function DoseResponseColumnMapperDialog({
  open,
  columns,
  testName,
  onConfirm,
  onCancel,
}: DoseResponseColumnMapperDialogProps) {
  // State for each field mapping
  const [mapping, setMapping] = useState<Partial<DoseResponseColumnMapping>>({})

  useEffect(() => {
    if (open) {
      setMapping({})
    }
  }, [open])

  // Get available columns for a field (exclude already selected columns)
  const getAvailableColumns = useCallback(
    (fieldKey: keyof DoseResponseColumnMapping) => {
      const selectedValues = Object.entries(mapping)
        .filter(([key, value]) => key !== fieldKey && value)
        .map(([, value]) => value)

      return columns.filter((col) => !selectedValues.includes(col.columnId))
    },
    [columns, mapping]
  )

  // Check if all fields are mapped
  const isComplete = useMemo(() => {
    return FIELD_DEFINITIONS.every((field) => mapping[field.key])
  }, [mapping])

  // Check for duplicate selections
  const hasDuplicates = useMemo(() => {
    const values = Object.values(mapping).filter(Boolean)
    return new Set(values).size !== values.length
  }, [mapping])

  // Validation message
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

  const handleFieldChange = useCallback((fieldKey: keyof DoseResponseColumnMapping, value: string) => {
    setMapping((prev) => ({ ...prev, [fieldKey]: value }))
  }, [])

  const handleConfirm = useCallback(() => {
    if (isComplete && !hasDuplicates) {
      onConfirm(mapping as DoseResponseColumnMapping)
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
            <Activity className="h-5 w-5" />
            Configure {testName}
          </DialogTitle>
          <DialogDescription className="text-sm text-gray-600">
            Map your data columns to the dose-response analysis fields. Each row should contain a
            dose/concentration value and its corresponding measured response.
          </DialogDescription>
        </DialogHeader>

        {/* Info banner */}
        <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
          <p>
            <strong>Tip:</strong> The dose column contains your treatment concentrations (e.g.,
            drug amounts, time points). The response column contains the measured biological
            effect (e.g., % inhibition, cell viability, enzyme activity).
          </p>
        </div>

        {/* Field mappings */}
        <div className="space-y-4">
          {FIELD_DEFINITIONS.map((field) => (
            <FieldSelector
              key={field.key}
              field={field}
              value={mapping[field.key]}
              columns={getAvailableColumns(field.key)}
              allColumns={columns}
              onChange={(value) => handleFieldChange(field.key, value)}
            />
          ))}
        </div>

        {/* Validation message */}
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

/**
 * Individual field selector component
 */
interface FieldSelectorProps {
  field: FieldDefinition
  value: string | undefined
  columns: DoseResponseColumnInfo[]
  allColumns: DoseResponseColumnInfo[]
  onChange: (value: string) => void
}

function FieldSelector({ field, value, columns, allColumns, onChange }: FieldSelectorProps) {
  const Icon = field.icon

  // Show all columns but mark unavailable ones
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
