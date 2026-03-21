/**
 * Synergy Column Mapper Dialog
 *
 * Allows users to map their selected columns to the required synergy analysis fields:
 * - Drug A Dose
 * - Drug B Dose
 * - Drug A Response (single-agent)
 * - Drug B Response (single-agent)
 * - Combined Response
 *
 * This dialog appears after users select columns and before synergy analysis runs.
 * It ensures clear, explicit mapping of data to the synergy model requirements.
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
import { AlertCircle, Beaker, FlaskConical, TestTubes } from 'lucide-react'

/**
 * Column info for the mapper
 */
export interface SynergyColumnInfo {
  columnName: string
  columnId: string
}

/**
 * Result of the column mapping
 */
export interface SynergyColumnMapping {
  doseA: string // columnId for Drug A dose
  doseB: string // columnId for Drug B dose
  responseA: string // columnId for Drug A single-agent response
  responseB: string // columnId for Drug B single-agent response
  responseCombined: string // columnId for combination response
}

type SynergyInputMode = 'boundary' | 'explicit'

const BOUNDARY_ROWS_SENTINEL = '__BOUNDARY_ROWS__'

interface SynergyColumnMapperDialogProps {
  open: boolean
  columns: SynergyColumnInfo[]
  testName: string // e.g., "Bliss Independence", "Loewe Additivity"
  onConfirm: (mapping: SynergyColumnMapping) => void
  onCancel: () => void
}

/**
 * Field definition for the mapper
 */
interface FieldDefinition {
  key: keyof SynergyColumnMapping
  label: string
  description: string
  icon: typeof Beaker
  group: 'doses' | 'single-agent' | 'combination'
}

const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    key: 'doseA',
    label: 'Drug A Dose',
    description: 'Concentration/dose values for Drug A',
    icon: Beaker,
    group: 'doses',
  },
  {
    key: 'doseB',
    label: 'Drug B Dose',
    description: 'Concentration/dose values for Drug B',
    icon: Beaker,
    group: 'doses',
  },
  {
    key: 'responseA',
    label: 'Drug A Response',
    description: 'Response when only Drug A is present (Drug B = 0)',
    icon: FlaskConical,
    group: 'single-agent',
  },
  {
    key: 'responseB',
    label: 'Drug B Response',
    description: 'Response when only Drug B is present (Drug A = 0)',
    icon: FlaskConical,
    group: 'single-agent',
  },
  {
    key: 'responseCombined',
    label: 'Combined Response',
    description: 'Response when both drugs are present together',
    icon: TestTubes,
    group: 'combination',
  },
]

/**
 * Synergy Column Mapper Dialog Component
 */
export function SynergyColumnMapperDialog({
  open,
  columns,
  testName,
  onConfirm,
  onCancel,
}: SynergyColumnMapperDialogProps) {
  // State for each field mapping
  const [mapping, setMapping] = useState<Partial<SynergyColumnMapping>>({})
  const [inputMode, setInputMode] = useState<SynergyInputMode>('explicit')

  useEffect(() => {
    if (open) {
      setMapping({})
      setInputMode(columns.length >= 5 ? 'explicit' : 'boundary')
    }
  }, [open, columns.length])

  const requiredFields = useMemo(() => {
    if (inputMode === 'boundary') {
      return FIELD_DEFINITIONS.filter((f) => f.group !== 'single-agent')
    }
    return FIELD_DEFINITIONS
  }, [inputMode])

  // Get available columns for a field (exclude already selected columns)
  const getAvailableColumns = useCallback(
    (fieldKey: keyof SynergyColumnMapping) => {
      const selectedValues = Object.entries(mapping)
        .filter(([key, value]) => key !== fieldKey && value)
        .filter(([, value]) => value !== BOUNDARY_ROWS_SENTINEL)
        .map(([, value]) => value)

      return columns.filter((col) => !selectedValues.includes(col.columnId))
    },
    [columns, mapping]
  )

  // Check if all fields are mapped
  const isComplete = useMemo(() => {
    return requiredFields.every((field) => mapping[field.key])
  }, [mapping, requiredFields])

  // Check for duplicate selections
  const hasDuplicates = useMemo(() => {
    const values = Object.values(mapping)
      .filter(Boolean)
      .filter((v) => v !== BOUNDARY_ROWS_SENTINEL)
    return new Set(values).size !== values.length
  }, [mapping])

  // Validation message
  const validationMessage = useMemo(() => {
    if (hasDuplicates) {
      return 'Each column can only be assigned to one field.'
    }
    if (!isComplete) {
      const missing = requiredFields.filter((f) => !mapping[f.key]).map((f) => f.label)
      return `Please select columns for: ${missing.join(', ')}`
    }
    return null
  }, [isComplete, hasDuplicates, mapping, requiredFields])

  const handleFieldChange = useCallback((fieldKey: keyof SynergyColumnMapping, value: string) => {
    setMapping((prev) => ({ ...prev, [fieldKey]: value }))
  }, [])

  const handleConfirm = useCallback(() => {
    if (isComplete && !hasDuplicates) {
      if (inputMode === 'boundary') {
        onConfirm({
          doseA: mapping.doseA!,
          doseB: mapping.doseB!,
          responseCombined: mapping.responseCombined!,
          responseA: BOUNDARY_ROWS_SENTINEL,
          responseB: BOUNDARY_ROWS_SENTINEL,
        })
        return
      }

      onConfirm(mapping as SynergyColumnMapping)
    }
  }, [mapping, isComplete, hasDuplicates, onConfirm, inputMode])

  const handleCancel = useCallback(() => {
    setMapping({})
    onCancel()
  }, [onCancel])

  // Group fields by category
  const doseFields = FIELD_DEFINITIONS.filter((f) => f.group === 'doses')
  const singleAgentFields = FIELD_DEFINITIONS.filter((f) => f.group === 'single-agent')
  const combinationFields = FIELD_DEFINITIONS.filter((f) => f.group === 'combination')

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-semibold">
            <TestTubes className="h-5 w-5" />
            Configure {testName}
          </DialogTitle>
          <DialogDescription className="text-sm text-gray-600">
            Map your data columns to the synergy analysis fields. Each row in your data should
            contain dose values and corresponding response measurements.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between rounded-md border bg-white p-2">
          <div className="text-sm font-medium text-gray-700">Input format</div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant={inputMode === 'boundary' ? 'secondary' : 'ghost'}
              className="h-7 px-2 text-xs"
              onClick={() => {
                setInputMode('boundary')
                setMapping((prev) => ({
                  doseA: prev.doseA,
                  doseB: prev.doseB,
                  responseCombined: prev.responseCombined,
                }))
              }}
            >
              Boundary rows (3 cols)
            </Button>
            <Button
              type="button"
              size="sm"
              variant={inputMode === 'explicit' ? 'secondary' : 'ghost'}
              className="h-7 px-2 text-xs"
              onClick={() => setInputMode('explicit')}
            >
              Explicit single-agent (5 cols)
            </Button>
          </div>
        </div>

        {/* Info banner */}
        <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
          <p>
            <strong>Tip:</strong> Your data should have one row per dose combination. The
            single-agent responses are the effects observed when only one drug is present.
          </p>
        </div>

        {inputMode === 'boundary' && (
          <div className="rounded-md bg-violet-50 border border-violet-200 p-3 text-sm text-violet-900">
            <p>
              <strong>Boundary mode:</strong> Single-agent responses are derived from rows where
              <span className="font-mono"> doseA=0</span> or <span className="font-mono">doseB=0</span>.
              Include monotherapy + control rows in the same dataset.
            </p>
          </div>
        )}

        {/* Response scale banner */}
        <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
          <p>
            <strong>Response scale:</strong> Synergy analysis expects <strong>% inhibition</strong> on a
            0-100 scale. If your data is <strong>% viability</strong>, convert it first:
            <span className="font-mono"> 100 - viability</span>.
          </p>
        </div>

        {/* Field groups */}
        <div className="space-y-6">
          {/* Doses section */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <Beaker className="h-4 w-4" />
              Dose Columns
            </h3>
            <div className="grid grid-cols-2 gap-4">
              {doseFields.map((field) => (
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
          </div>

          {/* Single-agent responses section */}
          {inputMode === 'explicit' && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                <FlaskConical className="h-4 w-4" />
                Single-Agent Response Columns
              </h3>
              <p className="text-xs text-gray-500">
                Response values when only one drug is present (the other drug at concentration 0)
              </p>
              <div className="grid grid-cols-2 gap-4">
                {singleAgentFields.map((field) => (
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
            </div>
          )}

          {/* Combination response section */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <TestTubes className="h-4 w-4" />
              Combination Response Column
            </h3>
            <p className="text-xs text-gray-500">
              Response values when both drugs are present together
            </p>
            {combinationFields.map((field) => (
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
  columns: SynergyColumnInfo[]
  allColumns: SynergyColumnInfo[]
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
