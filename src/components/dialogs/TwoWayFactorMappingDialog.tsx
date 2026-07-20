/**
 * Two-Way ANOVA Factor Mapping Dialog
 *
 * Allows users to explicitly assign factor roles for Two-Way ANOVA:
 * - Factor A (primary/x-axis)
 * - Factor B (secondary/grouping)
 *
 * This dialog appears after DV selection and before analysis runs.
 * It ensures clear, explicit factor role assignment independent of column order.
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
import { AlertCircle, Grid3x3, Layers } from 'lucide-react'

/**
 * Column info for the mapper
 */
export interface TwoWayFactorColumnInfo {
  columnName: string
  columnId: string
}

/**
 * Result of the factor role mapping
 */
export interface TwoWayFactorMapping {
  factorA: string // columnId for primary factor (x-axis)
  factorB: string // columnId for secondary factor (grouping)
}

interface TwoWayFactorMappingDialogProps {
  open: boolean
  columns: TwoWayFactorColumnInfo[] // Categorical factors only (DV already selected)
  onConfirm: (mapping: TwoWayFactorMapping) => void
  onCancel: () => void
}

/**
 * Field definition for the mapper
 */
interface FieldDefinition {
  key: keyof TwoWayFactorMapping
  label: string
  description: string
  icon: typeof Grid3x3
}

const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    key: 'factorA',
    label: 'Factor A (Primary)',
    description: 'X-axis factor for plots and primary grouping',
    icon: Grid3x3,
  },
  {
    key: 'factorB',
    label: 'Factor B (Secondary)',
    description: 'Grouping/color factor for interaction plots',
    icon: Layers,
  },
]

/**
 * Two-Way Factor Mapping Dialog Component
 */
export function TwoWayFactorMappingDialog({
  open,
  columns,
  onConfirm,
  onCancel,
}: TwoWayFactorMappingDialogProps) {
  // State for each field mapping
  const [mapping, setMapping] = useState<Partial<TwoWayFactorMapping>>({})

  // Reset mapping when dialog opens
  useEffect(() => {
    if (open) {
      // Auto-assign if exactly 2 factors (user can still change)
      if (columns.length === 2) {
        setMapping({
          factorA: columns[0]?.columnId,
          factorB: columns[1]?.columnId,
        })
      } else {
        setMapping({})
      }
    }
  }, [open, columns])

  // Get available columns for a field (exclude already selected columns)
  const getAvailableColumns = useCallback(() => columns, [columns])

  // Check if all fields are mapped
  const isComplete = useMemo(() => {
    return FIELD_DEFINITIONS.every(field => mapping[field.key])
  }, [mapping])

  // Check for duplicate selections
  const hasDuplicates = useMemo(() => {
    const values = Object.values(mapping).filter(Boolean)
    return new Set(values).size !== values.length
  }, [mapping])

  // Validation message
  const validationMessage = useMemo(() => {
    if (hasDuplicates) {
      return 'Each factor can only be assigned to one role.'
    }
    if (!isComplete) {
      const missing = FIELD_DEFINITIONS.filter(f => !mapping[f.key]).map(
        f => f.label
      )
      return `Please assign roles for: ${missing.join(', ')}`
    }
    return null
  }, [isComplete, hasDuplicates, mapping])

  const handleFieldChange = useCallback(
    (fieldKey: keyof TwoWayFactorMapping, value: string) => {
      setMapping(prev => ({ ...prev, [fieldKey]: value }))
    },
    []
  )

  const handleConfirm = useCallback(() => {
    if (isComplete && !hasDuplicates) {
      onConfirm(mapping as TwoWayFactorMapping)
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
            <Grid3x3 className="h-5 w-5" />
            Assign Factor Roles
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Choose which factor should be the primary (x-axis) and which should
            be the secondary (grouping) for Two-Way ANOVA analysis and plots.
          </DialogDescription>
        </DialogHeader>

        {/* Info banner */}
        <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 text-sm text-blue-900 dark:text-blue-200">
          <p>
            <strong>Tip:</strong> Factor A typically represents the primary
            treatment or condition (x-axis), while Factor B represents the
            secondary grouping variable (colors/legend). This assignment affects
            plot layout and interaction interpretation.
          </p>
        </div>

        {/* Field mappings */}
        <div className="space-y-4">
          {FIELD_DEFINITIONS.map(field => {
            const Icon = field.icon
            const availableColumns = getAvailableColumns()
            const currentValue = mapping[field.key]

            return (
              <div key={field.key} className="space-y-2">
                <Label
                  htmlFor={`field-${field.key}`}
                  className="flex items-center gap-2 font-medium"
                >
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  {field.label}
                </Label>
                <p className="text-xs text-muted-foreground -mt-1">
                  {field.description}
                </p>
                <Select
                  value={currentValue || ''}
                  onValueChange={value => handleFieldChange(field.key, value)}
                >
                  <SelectTrigger id={`field-${field.key}`} className="w-full">
                    <SelectValue
                      placeholder={`Select ${field.label.toLowerCase()}...`}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {availableColumns.length === 0 && (
                      <div className="p-2 text-xs text-muted-foreground text-center">
                        No available columns
                      </div>
                    )}
                    {availableColumns.map(col => (
                      <SelectItem key={col.columnId} value={col.columnId}>
                        {col.columnName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )
          })}
        </div>

        {/* Validation message */}
        {validationMessage && (
          <div className="flex items-center gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3 text-sm text-amber-800 dark:text-amber-200">
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
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default TwoWayFactorMappingDialog
