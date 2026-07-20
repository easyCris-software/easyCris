/**
 * Pivot Longer Dialog
 *
 * Gathers multiple columns into key-value pairs
 */

import { useState, useEffect } from 'react'
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
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import type { PivotLongerConfig } from '@/services/dataTransformService'
import type { ColumnMetadata } from '@/store/data-store'

interface PivotLongerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  columnMetadata: ColumnMetadata[]
  onApply: (config: PivotLongerConfig) => void
  initialConfig?: PivotLongerConfig | null
}

export function PivotLongerDialog({
  open,
  onOpenChange,
  columnMetadata,
  onApply,
  initialConfig,
}: PivotLongerDialogProps) {
  const [selectedColumnIds, setSelectedColumnIds] = useState<string[]>([])
  const [namesTo, setNamesTo] = useState<string>('variable')
  const [valuesTo, setValuesTo] = useState<string>('value')
  const trimmedNamesTo = namesTo.trim()
  const trimmedValuesTo = valuesTo.trim()
  const hasOutputNameCollision = trimmedNamesTo.length > 0 && trimmedNamesTo === trimmedValuesTo

  useEffect(() => {
    const availableIds = new Set(columnMetadata.map((col) => col.id))
    setSelectedColumnIds((prev) => prev.filter((id) => availableIds.has(id)))
  }, [columnMetadata])

  useEffect(() => {
    if (!open) return

    if (initialConfig) {
      setSelectedColumnIds(Array.isArray(initialConfig.cols) ? initialConfig.cols : [])
      setNamesTo(initialConfig.namesTo ?? 'variable')
      setValuesTo(initialConfig.valuesTo ?? 'value')
      return
    }

    setSelectedColumnIds([])
    setNamesTo('variable')
    setValuesTo('value')
  }, [open, initialConfig])

  const handleApply = () => {
    if (selectedColumnIds.length === 0 || !trimmedNamesTo || !trimmedValuesTo || hasOutputNameCollision) return

    const config: PivotLongerConfig = {
      cols: selectedColumnIds,
      namesTo: trimmedNamesTo,
      valuesTo: trimmedValuesTo,
    }

    onApply(config)
    onOpenChange(false)
  }

  const handleReset = () => {
    setSelectedColumnIds([])
    setNamesTo('variable')
    setValuesTo('value')
  }

  const toggleColumn = (columnId: string) => {
    setSelectedColumnIds((prev) =>
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
      persistKey="pivot-longer"
    >
      <ResizableDialogContent>
        <ResizableDialogHeader>
          <ResizableDialogTitle>Pivot Longer</ResizableDialogTitle>
          <ResizableDialogDescription>
            Gather multiple columns into key-value pairs
          </ResizableDialogDescription>
        </ResizableDialogHeader>

        <div className="flex-1 space-y-6 p-6 overflow-y-auto">
          {/* Columns to gather */}
          <div className="space-y-2">
            <Label>Columns to gather</Label>
            <div className="rounded-md border p-3 max-h-64 overflow-y-auto space-y-2">
              {columnMetadata.map((col) => (
                <div key={col.id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`col-${col.id}`}
                    checked={selectedColumnIds.includes(col.id)}
                    onCheckedChange={() => toggleColumn(col.id)}
                  />
                  <label
                    htmlFor={`col-${col.id}`}
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                  >
                    {col.name}
                  </label>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Example: Select "1 uM", "10 uM", "100 uM" to gather into a single column
            </p>
            <p className="text-xs text-muted-foreground">
              Selected: {selectedColumnIds.length} column(s)
            </p>
          </div>

          {/* Names to */}
          <div className="space-y-2">
            <Label htmlFor="names-to">Name for new column containing former column names</Label>
            <Input
              id="names-to"
              value={namesTo}
              onChange={(e) => setNamesTo(e.target.value)}
              placeholder="variable"
            />
            <p className="text-xs text-muted-foreground">
              This column will contain the names of the columns you selected above
            </p>
          </div>

          {/* Values to */}
          <div className="space-y-2">
            <Label htmlFor="values-to">Name for new column containing values</Label>
            <Input
              id="values-to"
              value={valuesTo}
              onChange={(e) => setValuesTo(e.target.value)}
              placeholder="value"
            />
            <p className="text-xs text-muted-foreground">
              This column will contain the values from the columns you selected
            </p>
          </div>

          {hasOutputNameCollision && (
            <p className="text-xs text-red-600">
              "Names to" and "Values to" must be different.
            </p>
          )}

          {/* Preview */}
          {selectedColumnIds.length > 0 && (
            <div className="space-y-2">
              <Label>Preview transformation</Label>
              <div className="rounded-md border p-3 bg-muted/50 text-sm">
                <p className="font-mono">
                  Before: {selectedColumnIds.length} columns (
                  {columnMetadata
                    .filter((c) => selectedColumnIds.includes(c.id))
                    .map((c) => c.name)
                    .join(', ')}
                  )
                </p>
                <p className="font-mono mt-2">
                  After: 2 columns ("{namesTo}", "{valuesTo}")
                </p>
              </div>
            </div>
          )}
        </div>

        <ResizableDialogFooter>
          <Button variant="outline" onClick={handleReset}>
            Reset
          </Button>
          <Button
            onClick={handleApply}
            disabled={selectedColumnIds.length === 0 || !trimmedNamesTo || !trimmedValuesTo || hasOutputNameCollision}
          >
            Apply Pivot
          </Button>
        </ResizableDialogFooter>
      </ResizableDialogContent>
    </ResizableDialog>
  )
}
