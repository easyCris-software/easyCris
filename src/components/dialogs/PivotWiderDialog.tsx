/**
 * Pivot Wider Dialog
 *
 * Spreads a key-value pair across columns
 */

import { useState, useMemo, useEffect } from 'react'
import {
  ResizableDialog,
  ResizableDialogContent,
  ResizableDialogHeader,
  ResizableDialogTitle,
  ResizableDialogFooter,
  ResizableDialogDescription,
} from '@/components/ui/resizable-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertCircle } from 'lucide-react'
import { DataTransformService } from '@/services/dataTransformService'
import type { PivotWiderConfig } from '@/services/dataTransformService'
import type { ColumnMetadata } from '@/store/data-store'
import { computePivotIdColumns } from '@/utils/transformSchema'

interface PivotWiderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  columnMetadata: ColumnMetadata[]
  sampleData: Record<string, any>[]
  onApply: (config: PivotWiderConfig) => void
  initialConfig?: PivotWiderConfig | null
}

export function PivotWiderDialog({
  open,
  onOpenChange,
  columnMetadata,
  sampleData,
  onApply,
  initialConfig,
}: PivotWiderDialogProps) {
  const [namesFromId, setNamesFromId] = useState<string>('')
  const [valuesFromIds, setValuesFromIds] = useState<string[]>([])
  const [aggregation, setAggregation] = useState<string>('none')
  const [keepOriginalColumns, setKeepOriginalColumns] = useState<boolean>(false)
  const [useRowIndex, setUseRowIndex] = useState<boolean>(true)

  useEffect(() => {
    const availableIds = new Set(columnMetadata.map((col) => col.id))
    setNamesFromId((prev) => (prev && availableIds.has(prev) ? prev : ''))
    setValuesFromIds((prev) => prev.filter((id) => availableIds.has(id)))
  }, [columnMetadata])

  useEffect(() => {
    if (!open) return

    if (initialConfig) {
      setNamesFromId(initialConfig.namesFrom ?? '')
      setValuesFromIds(Array.isArray(initialConfig.valuesFrom) ? initialConfig.valuesFrom : [])
      setAggregation(initialConfig.aggregation ?? 'none')
      setKeepOriginalColumns(Boolean(initialConfig.keepOriginalColumns))
      setUseRowIndex(initialConfig.useRowIndex ?? true)
      return
    }

    setNamesFromId('')
    setValuesFromIds([])
    setAggregation('none')
    setKeepOriginalColumns(false)
    setUseRowIndex(true)
  }, [open, initialConfig])

  // When namesFrom changes, remove it from valuesFrom if it was selected
  const handleNamesFromChange = (columnId: string) => {
    setNamesFromId(columnId)
    if (valuesFromIds.includes(columnId)) {
      setValuesFromIds((prev) => prev.filter((id) => id !== columnId))
    }
  }

  const hasIdColumns = useMemo(() => {
    if (!namesFromId) return true
    if (sampleData.length === 0) return true
    return computePivotIdColumns(sampleData, {
      namesFrom: namesFromId,
      valuesFrom: valuesFromIds,
    }).length > 0
  }, [namesFromId, valuesFromIds, sampleData])

  // Preview unique values that will become new columns
  const previewColumns = useMemo(() => {
    if (!namesFromId || sampleData.length === 0) return []
    return DataTransformService.getUniqueValues(sampleData, namesFromId).slice(0, 10)
  }, [namesFromId, sampleData])

  const nameById = useMemo(
    () => new Map(columnMetadata.map((col) => [col.id, col.name])),
    [columnMetadata]
  )

  const collisionColumns = useMemo(() => {
    const effectiveValuesFrom = valuesFromIds.filter((id) => id !== namesFromId)
    if (!namesFromId || effectiveValuesFrom.length === 0 || sampleData.length === 0) return []
    return DataTransformService.getPivotWiderCollisionKeys(sampleData, {
      namesFrom: namesFromId,
      valuesFrom: effectiveValuesFrom,
      aggregation: aggregation === 'none' ? undefined : (aggregation as PivotWiderConfig['aggregation']),
    })
  }, [namesFromId, valuesFromIds, aggregation, sampleData])

  const handleApply = () => {
    const effectiveValuesFrom = valuesFromIds.filter((id) => id !== namesFromId)
    if (!namesFromId || effectiveValuesFrom.length === 0) return

    const normalizedAggregation = aggregation === 'none' ? undefined : aggregation
    const config: PivotWiderConfig = {
      namesFrom: namesFromId,
      valuesFrom: effectiveValuesFrom,
      aggregation: normalizedAggregation as PivotWiderConfig['aggregation'],
      keepOriginalColumns,
      useRowIndex: !hasIdColumns && useRowIndex,
    }

    onApply(config)
    onOpenChange(false)
  }

  const handleReset = () => {
    setNamesFromId('')
    setValuesFromIds([])
    setAggregation('none')
    setKeepOriginalColumns(false)
    setUseRowIndex(true)
  }

  const toggleValueColumn = (columnId: string) => {
    if (columnId === namesFromId) return
    setValuesFromIds((prev) =>
      prev.includes(columnId) ? prev.filter((id) => id !== columnId) : [...prev, columnId]
    )
  }

  return (
    <ResizableDialog
      open={open}
      onOpenChange={onOpenChange}
      defaultWidth={700}
      defaultHeight={600}
      minWidth={500}
      minHeight={400}
      persistKey="pivot-wider"
    >
      <ResizableDialogContent>
        <ResizableDialogHeader>
          <ResizableDialogTitle>Pivot Wider</ResizableDialogTitle>
          <ResizableDialogDescription>
            Spread a key-value pair across columns
          </ResizableDialogDescription>
        </ResizableDialogHeader>

        <div className="flex-1 space-y-6 p-6 overflow-y-auto">
          {/* Names from */}
          <div className="space-y-2">
            <Label htmlFor="names-from">Column to spread into new columns</Label>
            <Select value={namesFromId} onValueChange={handleNamesFromChange}>
              <SelectTrigger id="names-from">
                <SelectValue placeholder="Select column with unique values" />
              </SelectTrigger>
              <SelectContent>
                {columnMetadata.map((col) => (
                  <SelectItem key={col.id} value={col.id}>
                    {col.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Example: "Group" column with values like "A", "B", "C", etc.
            </p>
          </div>

          {/* Values from (multi-select with checkboxes) */}
          <div className="space-y-2">
            <Label>Columns containing values to fill</Label>
            <div className="rounded-md border p-3 max-h-48 overflow-y-auto space-y-2">
              {columnMetadata.map((col) => (
                <div key={col.id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`value-${col.id}`}
                    checked={valuesFromIds.includes(col.id)}
                    disabled={col.id === namesFromId}
                    onCheckedChange={() => toggleValueColumn(col.id)}
                  />
                  <label
                    htmlFor={`value-${col.id}`}
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                  >
                    {col.name}
                  </label>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Select one or more columns with numeric measurements
            </p>
          </div>

          {/* Aggregation */}
          <div className="space-y-2">
            <Label htmlFor="aggregation">If multiple values per cell</Label>
            <Select value={aggregation} onValueChange={setAggregation}>
              <SelectTrigger id="aggregation">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (unique only)</SelectItem>
                <SelectItem value="list">List (keep all values)</SelectItem>
                <SelectItem value="mean">Mean (average)</SelectItem>
                <SelectItem value="sum">Sum</SelectItem>
                <SelectItem value="count">Count</SelectItem>
                <SelectItem value="first">First value</SelectItem>
                <SelectItem value="last">Last value</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Choose None to keep actual values when cells are unique
            </p>
          </div>

          {/* Keep originals */}
          <div className="space-y-2">
            <Label>Keep original columns</Label>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="keep-originals"
                checked={keepOriginalColumns}
                onCheckedChange={(checked) => setKeepOriginalColumns(Boolean(checked))}
              />
              <label
                htmlFor="keep-originals"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
              >
                Preserve names/value columns as list cells
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              Keeps the source columns for reference after pivoting
            </p>
          </div>

          {/* Row index alignment */}
          {!hasIdColumns && (
            <div className="space-y-2">
              <Label>Row alignment</Label>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="use-row-index"
                  checked={useRowIndex}
                  onCheckedChange={(checked) => setUseRowIndex(Boolean(checked))}
                />
                <label
                  htmlFor="use-row-index"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                >
                  Align rows by order within {namesFromId ? columnMetadata.find((col) => col.id === namesFromId)?.name ?? 'group' : 'group'}
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                When no ID columns exist, this uses row order to keep values in separate rows.
              </p>
            </div>
          )}

          {/* Preview */}
          {previewColumns.length > 0 && (
            <div className="space-y-2">
              <Label>Preview: New columns will be created</Label>
              <div className="rounded-md border p-3 bg-muted/50">
                <p className="text-sm font-mono">
                  {previewColumns.join(', ')}
                  {previewColumns.length >= 10 && '...'}
                </p>
              </div>
            </div>
          )}

          {collisionColumns.length > 0 && (
            <Alert className="border-amber-500 text-amber-700">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {keepOriginalColumns
                  ? 'Some new columns will overwrite existing columns in the full dataset; source columns will be preserved with a "__original" suffix when they collide.'
                  : 'Some new columns will overwrite existing columns in the full dataset.'}
                <div className="mt-1 text-xs text-amber-700/90">
                  Sample collisions: {collisionColumns.slice(0, 6).map((key) => nameById.get(key) ?? key).join(', ')}
                  {collisionColumns.length > 6 ? '…' : ''}
                </div>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <ResizableDialogFooter>
          <Button variant="outline" onClick={handleReset}>
            Reset
          </Button>
          <Button
            onClick={handleApply}
            disabled={!namesFromId || valuesFromIds.filter((id) => id !== namesFromId).length === 0}
          >
            Apply Pivot
          </Button>
        </ResizableDialogFooter>
      </ResizableDialogContent>
    </ResizableDialog>
  )
}
