/**
 * Kruskal-Wallis Test Column Mapper Dialog
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

/**
 * Column info for the mapper
 */
export interface KruskalWallisColumnInfo {
  columnName: string
  columnId: string
  dataType: ColumnDataType
  uniqueValueCount?: number
}

/**
 * Result of the column mapping
 */
export interface KruskalWallisColumnMapping {
  group?: string // columnId for grouping variable (categorical)
  outcome?: string // columnId for outcome/numeric variable
  posthoc_adjustment?: KruskalPostHocAdjustmentMethod // Post-hoc adjustment method
  posthoc_q?: number // FDR q-value (only used when posthoc_adjustment='fdr_bh')
}

type KruskalPostHocAdjustmentMethod = 'bonferroni' | 'fdr_bh'

const KRUSKAL_POST_HOC_METHODS: { value: KruskalPostHocAdjustmentMethod; label: string }[] = [
  { value: 'bonferroni', label: 'Bonferroni (default)' },
  { value: 'fdr_bh', label: 'FDR (Benjamini-Hochberg)' },
]

interface KruskalWallisColumnMapperDialogProps {
  open: boolean
  columns: KruskalWallisColumnInfo[]
  testName: string
  onConfirm: (mapping: KruskalWallisColumnMapping) => void
  onCancel: () => void
}

type KruskalFieldKey = 'group' | 'outcome'

interface FieldDefinition {
  key: KruskalFieldKey
  label: string
  description: string
  icon: typeof Users
  filterFn: (col: KruskalWallisColumnInfo) => boolean
}

export function KruskalWallisColumnMapperDialog({
  open,
  columns,
  testName,
  onConfirm,
  onCancel,
}: KruskalWallisColumnMapperDialogProps) {
  const [mapping, setMapping] = useState<Partial<KruskalWallisColumnMapping>>({})
  const [posthocMethod, setPosthocMethod] = useState<KruskalPostHocAdjustmentMethod>('bonferroni')
  const [posthocQInput, setPosthocQInput] = useState<string>('0.05')

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
      return []
    }
    return [
      {
        key: 'group' as const,
        label: 'Grouping Variable',
        description:
          'The categorical variable defining the groups to compare (e.g., Treatment: Control/Drug A/Drug B)',
        icon: Users,
        filterFn: (col: KruskalWallisColumnInfo) =>
          col.dataType === ColumnDataType.Categorical || col.dataType === ColumnDataType.Binary,
      },
      {
        key: 'outcome' as const,
        label: 'Outcome Variable',
        description: 'The numeric variable you are measuring (dependent variable)',
        icon: BarChart3,
        filterFn: (col: KruskalWallisColumnInfo) =>
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
    setPosthocMethod('bonferroni')
    setPosthocQInput('0.05')
  }, [open, categoricalColumns, numericColumns, isWideFormat])

  // Get available columns for a field based on its filter
  const getAvailableColumns = useCallback(
    (fieldKey: KruskalFieldKey) => {
      const field = FIELD_DEFINITIONS.find((f) => f.key === fieldKey)
      if (!field) return []
      return columns.filter(field.filterFn)
    },
    [columns, FIELD_DEFINITIONS]
  )

  // Check if mapping is complete
  const isComplete = useMemo(() => {
    if (isWideFormat) return true
    return !!mapping.group && !!mapping.outcome && mapping.group !== mapping.outcome
  }, [mapping, isWideFormat])

  // Check for duplicates
  const hasDuplicates = useMemo(() => {
    if (isWideFormat) return false
    return Boolean(mapping.group && mapping.outcome && mapping.group === mapping.outcome)
  }, [mapping, isWideFormat])

  // Get group column info for validation
  const groupColumn = useMemo(() => {
    if (!mapping.group || isWideFormat) return null
    return columns.find((col) => col.columnId === mapping.group) ?? null
  }, [mapping.group, columns, isWideFormat])

  // Validate group has at least 2 categories
  const groupValidationError = useMemo(() => {
    if (!groupColumn || isWideFormat) return null
    if (groupColumn.uniqueValueCount !== undefined && groupColumn.uniqueValueCount < 2) {
      return `Grouping variable must have at least 2 values. "${groupColumn.columnName}" has ${groupColumn.uniqueValueCount} value(s).`
    }
    return null
  }, [groupColumn, isWideFormat])

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

  // Validation message
  const validationMessage = useMemo(() => {
    if (hasDuplicates) {
      return 'Grouping and Outcome must be different columns.'
    }
    if (isWideFormat) {
      return posthocQError ?? null
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
    if (posthocQError) {
      return posthocQError
    }
    return null
  }, [hasDuplicates, mapping, groupValidationError, posthocQError, isWideFormat])

  const handleFieldChange = useCallback(
    (fieldKey: KruskalFieldKey, value: string) => {
      setMapping((prev) => ({ ...prev, [fieldKey]: value }))
    },
    []
  )

  const handleConfirm = useCallback(() => {
    if (!isComplete || hasDuplicates || groupValidationError || posthocQError) {
      return
    }

    onConfirm({
      group: mapping.group as string | undefined,
      outcome: mapping.outcome as string | undefined,
      posthoc_adjustment: posthocMethod,
      posthoc_q: isFdr ? posthocQValue ?? undefined : undefined,
    })
  }, [
    hasDuplicates,
    isComplete,
    mapping,
    onConfirm,
    groupValidationError,
    posthocQError,
    posthocMethod,
    isFdr,
    posthocQValue,
    isWideFormat,
  ])

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
              ? 'Kruskal-Wallis in wide format: selected numeric columns are treated as groups.'
              : 'Map your selected columns to the Kruskal-Wallis Test inputs. Specify which column is the grouping variable and which is the outcome (numeric) variable.'}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
          <p>
            <strong>Note:</strong>{' '}
            {isWideFormat
              ? 'Each numeric column is treated as a group. Select at least 2 numeric columns.'
              : 'Kruskal-Wallis Test compares medians across 2 or more independent groups. The grouping variable must have at least 2 unique values (e.g., Control, Drug A, Drug B).'}
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

          <div className="space-y-1.5 border-t pt-4">
            <Label className="text-sm font-medium flex items-center gap-1.5">
              <Settings2 className="h-3.5 w-3.5 text-gray-500" />
              Post-Hoc Adjustment (Dunn)
            </Label>
            <Select value={posthocMethod} onValueChange={(v) => setPosthocMethod(v as KruskalPostHocAdjustmentMethod)}>
              <SelectTrigger className="w-full" data-testid="kruskal-adjustment-select">
                <SelectValue placeholder="Select adjustment method" />
              </SelectTrigger>
              <SelectContent>
                {KRUSKAL_POST_HOC_METHODS.map((method) => (
                  <SelectItem key={method.value} value={method.value} data-value={method.value}>
                    {method.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500">
              Adjusts p-values for multiple comparisons in Dunn's test.
            </p>
          </div>

          {isFdr && (
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">FDR q-value</Label>
              <Input
                value={posthocQInput}
                onChange={(e) => setPosthocQInput(e.target.value)}
                placeholder="0.05"
                inputMode="decimal"
              />
              <p className="text-xs text-gray-500">
                False discovery rate threshold (e.g., 0.05 or 0.1).
              </p>
              {posthocQError && (
                <p className="text-xs text-red-600">{posthocQError}</p>
              )}
            </div>
          )}
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
            disabled={!isComplete || hasDuplicates || !!groupValidationError || !!posthocQError}
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
  columns: KruskalWallisColumnInfo[]
  onChange: (value: string) => void
}

function FieldSelector({ field, value, columns, onChange }: FieldSelectorProps) {
  const Icon = field.icon

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
          {columns.map((col) => (
            <SelectItem key={col.columnId} value={col.columnId}>
              {col.columnName}
              {col.uniqueValueCount !== undefined && (
                <span className="text-gray-400 ml-2">({col.uniqueValueCount} values)</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-gray-500">{field.description}</p>
    </div>
  )
}
