/**
 * Chi-Square Goodness of Fit Column Mapper Dialog
 *
 * Lets users map selected columns to GOF inputs:
 * - Category labels (optional)
 * - Observed counts (numeric or derived from category counts)
 * - Expected proportions (optional)
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
import { AlertCircle, ListChecks, Hash } from 'lucide-react'
import { ColumnDataType } from '@/lib/modules/core/types'

export const GOF_CATEGORY_COUNTS_SENTINEL = '__CATEGORY_COUNTS__'
const GOF_UNIFORM_EXPECTED_SENTINEL = '__UNIFORM_EXPECTED__'
const GOF_NO_CATEGORY_SENTINEL = '__NO_CATEGORY__'
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
export interface ChiSquareGofColumnInfo {
  columnName: string
  columnId: string
  dataType: ColumnDataType
}

/**
 * Result of the column mapping
 */
export interface ChiSquareGofColumnMapping {
  category: string | null // columnId for category labels (optional)
  observed: string // columnId for observed counts or GOF_CATEGORY_COUNTS_SENTINEL
  expected: string | null // columnId for expected proportions (optional)
}

interface ChiSquareGofColumnMapperDialogProps {
  open: boolean
  columns: ChiSquareGofColumnInfo[]
  testName: string
  onConfirm: (mapping: ChiSquareGofColumnMapping) => void
  onCancel: () => void
}

interface FieldDefinition {
  key: keyof ChiSquareGofColumnMapping
  label: string
  description: string
  icon: typeof ListChecks
  optional?: boolean
}

const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    key: 'category',
    label: 'Category Labels',
    description: 'Optional: category names for each row of counts',
    icon: ListChecks,
    optional: true,
  },
  {
    key: 'observed',
    label: 'Observed Counts',
    description: 'Observed counts per category (numeric)',
    icon: Hash,
  },
  {
    key: 'expected',
    label: 'Expected Proportions',
    description: 'Optional: expected proportions per category (numeric)',
    icon: Hash,
    optional: true,
  },
]

export function ChiSquareGofColumnMapperDialog({
  open,
  columns,
  testName,
  onConfirm,
  onCancel,
}: ChiSquareGofColumnMapperDialogProps) {
  const [mapping, setMapping] = useState<Partial<ChiSquareGofColumnMapping>>({})

  const categoryColumns = useMemo(
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

  useEffect(() => {
    if (!open) {
      return
    }

    if (numericColumns.length > 0) {
      setMapping({
        category: categoryColumns[0]?.columnId ?? GOF_NO_CATEGORY_SENTINEL,
        observed: numericColumns[0]?.columnId,
        expected: numericColumns[1]?.columnId ?? GOF_UNIFORM_EXPECTED_SENTINEL,
      })
    } else if (categoryColumns.length > 0) {
      setMapping({
        category: categoryColumns[0]?.columnId,
        observed: GOF_CATEGORY_COUNTS_SENTINEL,
      })
    } else {
      setMapping({})
    }
  }, [open, numericColumns.length, categoryColumns.length])

  const hasCategoryCountsOption = categoryColumns.length > 0

  const getAvailableColumns = useCallback(
    (fieldKey: keyof ChiSquareGofColumnMapping) => {
      const selectedValues = Object.entries(mapping)
        .filter(([key, value]) => key !== fieldKey && value)
        .map(([, value]) => value)
        .filter(
          (value): value is string =>
            typeof value === 'string' &&
            value !== GOF_CATEGORY_COUNTS_SENTINEL &&
            value !== GOF_UNIFORM_EXPECTED_SENTINEL &&
            value !== GOF_NO_CATEGORY_SENTINEL
        )

      return columns.filter(col => !selectedValues.includes(col.columnId))
    },
    [columns, mapping]
  )

  const isComplete = useMemo(() => {
    const observed = mapping.observed
    if (!observed) {
      return false
    }
    const categoryMissing =
      !mapping.category || mapping.category === GOF_NO_CATEGORY_SENTINEL
    if (observed === GOF_CATEGORY_COUNTS_SENTINEL && categoryMissing) {
      return false
    }
    return true
  }, [mapping])

  const hasDuplicates = useMemo(() => {
    const values = Object.values(mapping)
      .filter(Boolean)
      .filter(
        (value): value is string =>
          typeof value === 'string' &&
          value !== GOF_CATEGORY_COUNTS_SENTINEL &&
          value !== GOF_UNIFORM_EXPECTED_SENTINEL &&
          value !== GOF_NO_CATEGORY_SENTINEL
      )
    return new Set(values).size !== values.length
  }, [mapping])

  const validationMessage = useMemo(() => {
    if (hasDuplicates) {
      return 'Each column can only be assigned to one field.'
    }
    if (!mapping.observed) {
      return 'Select a column for Observed Counts.'
    }
    if (
      mapping.observed === GOF_CATEGORY_COUNTS_SENTINEL &&
      (!mapping.category || mapping.category === GOF_NO_CATEGORY_SENTINEL)
    ) {
      return 'Select a Category Labels column to derive counts.'
    }
    return null
  }, [hasDuplicates, mapping])

  const handleFieldChange = useCallback(
    (fieldKey: keyof ChiSquareGofColumnMapping, value: string) => {
      setMapping(prev => ({ ...prev, [fieldKey]: value }))
    },
    []
  )

  const handleConfirm = useCallback(() => {
    if (!isComplete || hasDuplicates) {
      return
    }

    const resolvedCategory =
      mapping.category === GOF_NO_CATEGORY_SENTINEL
        ? null
        : (mapping.category ?? null)
    const resolvedExpected =
      mapping.observed === GOF_CATEGORY_COUNTS_SENTINEL
        ? null
        : mapping.expected === GOF_UNIFORM_EXPECTED_SENTINEL
          ? null
          : (mapping.expected ?? null)

    onConfirm({
      category: resolvedCategory,
      observed: mapping.observed as string,
      expected: resolvedExpected,
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
            <ListChecks className="h-5 w-5" />
            Configure {testName}
          </DialogTitle>
          <DialogDescription className={dialogDescriptionClass}>
            Map your selected columns to the chi-square goodness of fit inputs.
            Observed counts can come from a numeric column or be derived from
            category counts.
          </DialogDescription>
        </DialogHeader>

        <div className={dialogInfoPanelClass}>
          <p>
            <strong>Tip:</strong> Use observed counts + expected proportions if
            you already have summary data. Otherwise, choose a category column
            and derive counts from raw data.
          </p>
        </div>

        <div className="space-y-4">
          {FIELD_DEFINITIONS.map(field => (
            <FieldSelector
              key={field.key}
              field={field}
              value={mapping[field.key]}
              columns={getAvailableColumns(field.key)}
              categoryColumns={categoryColumns}
              numericColumns={numericColumns}
              onChange={value => handleFieldChange(field.key, value)}
              hasCategoryCountsOption={hasCategoryCountsOption}
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
  value: string | null | undefined
  columns: ChiSquareGofColumnInfo[]
  categoryColumns: ChiSquareGofColumnInfo[]
  numericColumns: ChiSquareGofColumnInfo[]
  hasCategoryCountsOption: boolean
  onChange: (value: string) => void
}

function FieldSelector({
  field,
  value,
  columns,
  categoryColumns,
  numericColumns,
  hasCategoryCountsOption,
  onChange,
}: FieldSelectorProps) {
  const Icon = field.icon

  const allColumns =
    field.key === 'category'
      ? categoryColumns
      : field.key === 'observed' || field.key === 'expected'
        ? numericColumns
        : columns

  const isColumnAvailable = useCallback(
    (columnId: string) => columns.some(c => c.columnId === columnId),
    [columns]
  )

  const showOptionalNone = field.optional && field.key !== 'observed'

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
          {field.key === 'observed' && hasCategoryCountsOption && (
            <SelectItem value={GOF_CATEGORY_COUNTS_SENTINEL}>
              Derive from category counts
            </SelectItem>
          )}
          {field.key === 'expected' && (
            <SelectItem value={GOF_UNIFORM_EXPECTED_SENTINEL}>
              Use uniform distribution
            </SelectItem>
          )}
          {field.key === 'category' && showOptionalNone && (
            <SelectItem value={GOF_NO_CATEGORY_SENTINEL}>
              No category labels
            </SelectItem>
          )}
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
